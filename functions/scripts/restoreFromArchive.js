/**
 * restoreFromArchive.js (SCRUM-157, Sprint 5)
 *
 * Admin script: puts one archived record back where it came from. It reverses what the
 * daily job (lib/purgeJob.js, SCRUM-155) did, as written in budgetly_assets
 * docs/data-framework.md ("Restoring from the archive"):
 *
 *   archive_transactions/{id}              ->  transactions/{id}
 *   archive_budgets/{uid}_{categoryId}     ->  users/{uid}/budgets/{categoryId}
 *   archive_accounts/{uid}_{accountId}     ->  accounts/{accountId}
 *   archive_imports/{uid}_{importId}       ->  users/{uid}/imports/{importId}
 *        + its transactions (archive_transactions with sourceStatementId == importId)
 *        + its file (Storage archive/users/{uid}/imports/f -> users/{uid}/imports/f)
 *
 * The restored document is the original again: the fields the archive added
 * (archivedAt, originalPath, archivedFilePath, and userId on imports and budgets, which
 * didn't have one) are removed, and deletedAt, deletedBy and purgeAfter are set to null
 * so it is active, not in "Recently deleted". Writing it back and deleting the archive
 * copy happen in ONE batch, so a record is never in both places or in neither.
 *
 * Safety:
 *   - it refuses (and changes nothing) if something already exists at the original path
 *     of the record or of one of its transactions
 *   - the archived record must belong to the --user you name
 *   - a transaction that belongs to an archived statement can't be restored alone (it
 *     would point at a statement that isn't there); restore the statement with --import
 *   - --dry-run checks everything and writes nothing
 *   - after a failure part way, run the same command again: what already moved back is
 *     not touched, and the rest is moved
 *   - each restore writes an "<thing>.unarchived" audit entry with actor "admin"
 *
 * Runs on your own machine with the Admin SDK (it skips the security rules):
 *   cd budgetly_backend_nodejs/functions
 *   node scripts/restoreFromArchive.js --user <uid> --import <importId> [--dry-run]
 *   node scripts/restoreFromArchive.js --user <uid> --transaction <id> [--dry-run]
 *   node scripts/restoreFromArchive.js --user <uid> --budget <categoryId> [--dry-run]
 *   node scripts/restoreFromArchive.js --user <uid> --account <accountId> [--dry-run]
 *
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 (and
 * FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199) first.
 * Against the real project: same sign-in as migrateTransactions.js
 * (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS),
 * then add --project budgetly-backend-nodejs. Try --dry-run first.
 */
"use strict";

const { fileNameFromPath } = require("../lib/importFile");

// Moves per batch: each is 2 writes (live create + archive delete), under Firestore's 500
const MOVE_BATCH_SIZE = 200;
// Fields the archive added; they are not part of the original document
const ARCHIVE_FIELDS = ["archivedAt", "originalPath", "archivedFilePath"];
const ARCHIVE_PREFIX = "archive/";

/** An expected problem (nothing to restore, something in the way): shown without a stack. */
class RestoreError extends Error {}

/**
 * What the original document looked like: the archive's own fields are removed, `userId`
 * too when the original had none (imports and budgets get it from their path), and the
 * delete fields are cleared so the record is active.
 */
function originalData(archived, { keepUserId }) {
  const data = { ...archived };
  for (const f of ARCHIVE_FIELDS) delete data[f];
  if (!keepUserId) delete data.userId;
  return { ...data, deletedAt: null, deletedBy: null, purgeAfter: null };
}

/** A document ref from a path like "users/abc/budgets/dining". */
function refAt(db, path) {
  const parts = path.split("/");
  let ref = db.collection(parts[0]).doc(parts[1]);
  for (let i = 2; i < parts.length; i += 2) ref = ref.collection(parts[i]).doc(parts[i + 1]);
  return ref;
}

/** Reads an archived document and checks it is this user's. */
async function readArchived(db, collection, docId, userId, label) {
  const snap = await db.collection(collection).doc(docId).get();
  if (!snap.exists) throw new RestoreError(`Nothing archived for ${label} (looked in ${collection}/${docId}).`);
  const data = snap.data();
  if (data.userId !== userId) throw new RestoreError(`${label} belongs to someone else, not to ${userId}. Nothing was changed.`);
  if (typeof data.originalPath !== "string" || !data.originalPath) {
    throw new RestoreError(`${label} has no originalPath, so it can't be put back. Nothing was changed.`);
  }
  return { snap, data };
}

/** Moves records back in batches: create the live copy and delete the archive copy together. */
async function moveBack(db, moves) {
  for (let i = 0; i < moves.length; i += MOVE_BATCH_SIZE) {
    const batch = db.batch();
    for (const m of moves.slice(i, i + MOVE_BATCH_SIZE)) {
      batch.create(m.liveRef, m.data); // refused if something is already there
      batch.delete(m.archiveRef);
    }
    await batch.commit();
  }
}

/** Restores one document that stands alone: a transaction, budget or account. */
async function restoreSingle({ db, writeAudit, userId, collection, docId, label, keepUserId, action, dryRun, checkBefore }) {
  const { snap, data } = await readArchived(db, collection, docId, userId, label);
  const liveRef = refAt(db, data.originalPath);
  if ((await liveRef.get()).exists) {
    throw new RestoreError(`Something already exists at ${data.originalPath}, so ${label} was not restored.`);
  }
  if (checkBefore) await checkBefore(data);
  if (!dryRun) {
    await moveBack(db, [{ liveRef, archiveRef: snap.ref, data: originalData(data, { keepUserId }) }]);
    await writeAudit({ userId, action, targetPath: data.originalPath, actor: "admin", details: {} });
  }
  return { originalPath: data.originalPath };
}

/** Restores a statement: its file, its transactions, then its record, then the audit entry. */
async function restoreStatement({ db, files, writeAudit, userId, importId, dryRun, logger }) {
  const { snap, data } = await readArchived(db, "archive_imports", `${userId}_${importId}`, userId, `statement ${importId}`);
  const liveRef = refAt(db, data.originalPath);
  if ((await liveRef.get()).exists) {
    throw new RestoreError(`Something already exists at ${data.originalPath}, so the statement was not restored.`);
  }

  // The transactions still in the archive. Ones already moved back by an earlier,
  // interrupted run are not in the archive any more, so they can't be in the way.
  const archivedTxns = [];
  const txnQuery = () =>
    db.collection("archive_transactions").where("userId", "==", userId).where("sourceStatementId", "==", importId);
  const found = await txnQuery().get();
  for (const t of found.docs) {
    const original = t.data().originalPath ?? `transactions/${t.id}`;
    const ref = refAt(db, original);
    if ((await ref.get()).exists) {
      throw new RestoreError(`Something already exists at ${original}, so the statement was not restored. Nothing was changed.`);
    }
    archivedTxns.push({ archiveRef: t.ref, liveRef: ref, data: originalData(t.data(), { keepUserId: true }) });
  }

  // The file: archive/users/{uid}/imports/f -> users/{uid}/imports/f
  const originalFile = data.storagePath;
  const archivedFile = typeof data.archivedFilePath === "string" ? data.archivedFilePath : null;
  let fileInArchive = false;
  if (archivedFile && files) {
    // A file already at the original location is what an earlier, interrupted run left
    // (its name has the upload time and the statement id, so nothing else is called that):
    // the archived copy is simply written over it again
    fileInArchive = await files.exists(archivedFile);
  }
  const report = { transactions: archivedTxns.length, file: archivedFile ? (fileInArchive ? "moved back" : "not in the archive") : "none" };
  if (dryRun) return report;

  // 1. File back first (a copy left by an earlier attempt is simply written again)
  if (fileInArchive && originalFile) await files.copy(archivedFile, originalFile);
  // 2. Transactions, 200 at a time
  await moveBack(db, archivedTxns);
  // 3. The record last: only now does the statement show up again for its owner
  await moveBack(db, [{ liveRef, archiveRef: snap.ref, data: originalData(data, { keepUserId: false }) }]);
  // 4. The archived file copy is no longer needed
  if (fileInArchive) await files.remove(archivedFile);

  const transactionCount = (await txnQueryLive(db, userId, importId)).size;
  await writeAudit({
    userId,
    action: "import.unarchived",
    targetPath: data.originalPath,
    actor: "admin",
    details: { fileName: fileNameFromPath(originalFile), transactionCount },
  });
  logger.info?.(`Restored statement ${importId}: ${archivedTxns.length} transactions moved back`);
  return report;
}

/** How many transactions of this statement are live now (after the restore). */
function txnQueryLive(db, userId, importId) {
  return db.collection("transactions").where("userId", "==", userId).where("sourceStatementId", "==", importId).get();
}

/**
 * @param {Object} opts
 * @param {Object} opts.db            Admin SDK Firestore
 * @param {{exists, copy, remove}} [opts.files]  Storage operations (needed for --import)
 * @param {(entry: Object) => Promise<void>} opts.writeAudit  auditLog.js createAuditWriter()
 * @param {string} opts.userId        The owner (--user)
 * @param {"import"|"transaction"|"budget"|"account"} opts.kind
 * @param {string} opts.id            importId, transaction id, categoryId or accountId
 * @param {boolean} [opts.dryRun]     Check everything, write nothing
 * @param {Object} [opts.logger]
 * @returns {Promise<{kind: string, userId: string, id: string, dryRun: boolean, details: Object}>}
 * @throws {RestoreError} when there is nothing to restore or something is in the way
 */
async function restoreFromArchive({ db, files, writeAudit, userId, kind, id, dryRun = false, logger = console }) {
  if (!userId || typeof userId !== "string" || userId.includes("/")) throw new RestoreError("--user needs a user id.");
  if (!id || typeof id !== "string" || id.includes("/")) throw new RestoreError(`--${kind} needs an id (no slashes).`);

  let details;
  if (kind === "import") {
    details = await restoreStatement({ db, files, writeAudit, userId, importId: id, dryRun, logger });
  } else if (kind === "transaction") {
    details = await restoreSingle({
      db, writeAudit, userId, dryRun,
      collection: "archive_transactions", docId: id, label: `transaction ${id}`,
      keepUserId: true, action: "transaction.unarchived",
      // A transaction of an archived statement would point at nothing
      checkBefore: async (data) => {
        const importId = data.sourceStatementId;
        if (!importId) return;
        const live = await db.collection("users").doc(userId).collection("imports").doc(importId).get();
        if (!live.exists) {
          throw new RestoreError(`Transaction ${id} belongs to statement ${importId}, which is archived. Restore the statement with --import ${importId} instead.`);
        }
      },
    });
  } else if (kind === "budget") {
    details = await restoreSingle({
      db, writeAudit, userId, dryRun,
      collection: "archive_budgets", docId: `${userId}_${id}`, label: `budget ${id}`,
      keepUserId: false, action: "budget.unarchived",
    });
  } else if (kind === "account") {
    details = await restoreSingle({
      db, writeAudit, userId, dryRun,
      collection: "archive_accounts", docId: `${userId}_${id}`, label: `account ${id}`,
      keepUserId: true, action: "account.unarchived",
    });
  } else {
    throw new RestoreError("Say what to restore: --import, --transaction, --budget or --account.");
  }
  return { kind, userId, id, dryRun, details };
}

/** Reads the command line: node restoreFromArchive.js --user U --import I [--dry-run] [--project P] */
function parseArgs(args) {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const kinds = ["import", "transaction", "budget", "account"].filter((k) => args.includes(`--${k}`));
  if (kinds.length !== 1) throw new RestoreError("Give exactly one of --import, --transaction, --budget or --account.");
  return {
    userId: get("--user"),
    kind: kinds[0],
    id: get(`--${kinds[0]}`),
    dryRun: args.includes("--dry-run"),
    projectId: get("--project") ?? process.env.GCLOUD_PROJECT,
  };
}

/** What the script prints. */
function printReport(result, log = console.log) {
  log(result.dryRun ? "DRY RUN: nothing was written." : "Restored.");
  log(`  ${result.kind} ${result.id} for user ${result.userId}`);
  if (result.kind === "import") {
    log(`  transactions: ${result.details.transactions}`);
    log(`  file:         ${result.details.file}`);
  } else {
    log(`  back at:      ${result.details.originalPath}`);
  }
}

module.exports = { restoreFromArchive, parseArgs, printReport, originalData, RestoreError, MOVE_BATCH_SIZE, ARCHIVE_PREFIX };

// --- Command line ------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const { initializeApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const { getStorage } = require("firebase-admin/storage");
    const { createAuditWriter } = require("../lib/auditLog");
    initializeApp(opts.projectId ? { projectId: opts.projectId, storageBucket: `${opts.projectId}.firebasestorage.app` } : undefined);

    console.log(`Project: ${opts.projectId ?? "(default)"}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""}`);
    const db = getFirestore();
    const bucket = getStorage().bucket();
    const files = {
      exists: async (path) => (await bucket.file(path).exists())[0],
      copy: async (from, to) => { await bucket.file(from).copy(bucket.file(to)); },
      remove: async (path) => { await bucket.file(path).delete({ ignoreNotFound: true }); },
    };
    const result = await restoreFromArchive({ db, files, writeAudit: createAuditWriter({ db }), ...opts, logger: { info() {} } });
    printReport(result);
  })().catch((err) => {
    console.error(err instanceof RestoreError ? err.message : `Restore failed: ${err.message}`);
    process.exitCode = 1;
  });
}
