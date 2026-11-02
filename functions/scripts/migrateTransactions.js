/**
 * migrateTransactions.js (SCRUM-116)
 *
 * One-time script that moves transactions from the old location,
 *   users/{uid}/transactions/{oldId}
 * to the top-level collection the app uses now (SCRUM-109/111/117),
 *   transactions/{uid}_{oldId}
 * Imported transactions had IDs like {importId}_{row}, so they become
 * {uid}_{importId}_{row}, the same shape new imports get.
 *
 * Each copy keeps every field, plus:
 *   userId     the uid from the path (the folder it was in decides the owner)
 *   deletedAt  null if it wasn't set (the app only shows deletedAt == null)
 *   source     "import" if it was missing and the doc came from a statement
 *
 * Safe to run more than once: a copy that already exists is left alone, so
 * nothing the user changed since the last run is overwritten. Old documents are
 * only deleted with --delete-old, and only for a user whose copies all exist.
 *
 * Runs on your own machine with the Admin SDK (it skips the security rules):
 *   cd budgetly_backend_nodejs/functions
 *   node scripts/migrateTransactions.js --dry-run     # only counts, writes nothing
 *   node scripts/migrateTransactions.js               # copies
 *   node scripts/migrateTransactions.js --delete-old  # copies, then removes the old docs
 *
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
 * Against the real project: sign in once with `gcloud auth application-default login`
 * (or set GOOGLE_APPLICATION_CREDENTIALS to a service account key), then add
 * --project budgetly-backend-nodejs.
 */
"use strict";

// Firestore allows 500 writes per batch; stay under it
const BATCH_SIZE = 400;

/** The new document: old fields plus userId, deletedAt and source. */
function toNewDoc(uid, data) {
  const doc = { ...data, userId: uid, deletedAt: data.deletedAt ?? null };
  if (doc.source == null && doc.sourceStatementId) doc.source = "import";
  return doc;
}

/** Commits `ops` (each one adds itself to a batch) in batches of BATCH_SIZE. */
async function inBatches(db, ops) {
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_SIZE)) op(batch);
    await batch.commit();
  }
}

/**
 * Migrates every user's old transactions.
 * @param {Object} opts
 * @param {Object} opts.db                 Admin SDK Firestore
 * @param {boolean} [opts.dryRun]          Only count, write nothing
 * @param {boolean} [opts.deleteOld]       Remove old docs once all their copies exist
 * @param {Object} [opts.logger]
 * @returns {Promise<Object[]>} one row per user: { uid, old, alreadyCopied, copied, missing, deletedOld }
 */
async function migrateTransactions({ db, dryRun = false, deleteOld = false, logger = console }) {
  const report = [];
  // listDocuments() also finds users/{uid} "folders" that have no profile doc
  const userRefs = await db.collection("users").listDocuments();

  for (const userRef of userRefs) {
    const uid = userRef.id;
    const oldSnap = await userRef.collection("transactions").get();
    if (oldSnap.empty) continue;

    const newRef = (oldId) => db.collection("transactions").doc(`${uid}_${oldId}`);
    const newRefs = oldSnap.docs.map((d) => newRef(d.id));
    const existing = await db.getAll(...newRefs);
    const toCopy = oldSnap.docs.filter((d, i) => !existing[i].exists);

    const row = {
      uid,
      old: oldSnap.size,
      alreadyCopied: oldSnap.size - toCopy.length,
      copied: 0,
      missing: toCopy.length,
      deletedOld: 0,
    };

    if (!dryRun) {
      // create() fails if the copy appeared in the meantime, so it never overwrites
      await inBatches(db, toCopy.map((d) => (batch) => batch.create(newRef(d.id), toNewDoc(uid, d.data()))));
      row.copied = toCopy.length;

      // Count again: every old doc must now have its copy
      const after = await db.getAll(...newRefs);
      row.missing = after.filter((s) => !s.exists).length;

      if (deleteOld) {
        if (row.missing === 0) {
          await inBatches(db, oldSnap.docs.map((d) => (batch) => batch.delete(d.ref)));
          row.deletedOld = oldSnap.size;
        } else {
          logger.warn(`${uid}: ${row.missing} copies missing, old documents kept`);
        }
      }
    }
    report.push(row);
  }
  return report;
}

/** Prints the per-user before/after counts. */
function printReport(report, { dryRun }, log = console.log) {
  log(dryRun ? "DRY RUN: nothing was written.\n" : "");
  log("uid                           old  alreadyCopied  copied  missing  deletedOld");
  for (const r of report) {
    log(`${r.uid.padEnd(28)} ${String(r.old).padStart(4)}  ${String(r.alreadyCopied).padStart(13)}  ${String(r.copied).padStart(6)}  ${String(r.missing).padStart(7)}  ${String(r.deletedOld).padStart(10)}`);
  }
  if (report.length === 0) log("(no old transactions found)");
}

module.exports = { migrateTransactions, toNewDoc, printReport, BATCH_SIZE };

// --- Command line ------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const deleteOld = args.includes("--delete-old");
  const projectArg = args.indexOf("--project");
  const projectId = projectArg >= 0 ? args[projectArg + 1] : process.env.GCLOUD_PROJECT;

  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  initializeApp(projectId ? { projectId } : undefined);

  console.log(`Project: ${projectId ?? "(default)"}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""}`);
  migrateTransactions({ db: getFirestore(), dryRun, deleteOld })
    .then((report) => printReport(report, { dryRun }))
    .catch((err) => {
      console.error("Migration failed:", err.message);
      process.exitCode = 1;
    });
}
