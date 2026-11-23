/**
 * purgeJob.js (SCRUM-127, SCRUM-122; Sprint 5 #12: archive instead of delete)
 *
 * After 30 days, moves what users deleted out of the app and into the archive
 * (budgetly_assets docs/data-framework.md, "After 30 days: the archive"). Nothing a
 * user deleted is destroyed any more; it leaves the live data and goes where only
 * admins can see it (firestore.rules / storage.rules deny every client, Sprint 5 #11).
 *
 * In the app, "delete" is a soft delete: deletedAt, deletedBy and purgeAfter (30 days
 * later) are set and the item is hidden, so it can be restored from Recently deleted.
 * Once purgeAfter has passed, this job (run daily by purgeDeleted in index.js, after
 * the backup) moves it:
 *
 *   live                                archive
 *   users/{uid}/imports/{importId}  ->  archive_imports/{uid}_{importId}
 *   transactions/{id}               ->  archive_transactions/{id}
 *   users/{uid}/budgets/{catId}     ->  archive_budgets/{uid}_{catId}
 *   accounts/{accountId}            ->  archive_accounts/{uid}_{accountId}   (SCRUM-167)
 *   Storage users/{uid}/imports/f   ->  Storage archive/users/{uid}/imports/f
 *
 * Every archived document keeps all its fields, plus userId, originalPath and
 * archivedAt (and archivedFilePath for imports). Writing the archive copy and deleting
 * the live document happen in ONE batched write, so a document is never in both places
 * and never in neither. Statements get an "import.archived" audit entry (actor "system")
 * with the number of transactions archived with them; it replaces "import.purged".
 *
 * Safety:
 *   - only documents with both deletedAt and purgeAfter set, and purgeAfter in the past
 *   - each live delete carries the time the document was last changed when we read it,
 *     so something restored while the job runs is not moved (that move is skipped)
 *   - batches stay at 400 writes or fewer (200 moves = 200 creates + 200 deletes)
 *   - running it again after a partial failure is safe: whatever is still due is moved
 *     the next time, and nothing is moved twice (see archiveImport for the order)
 *   - the job stops if a page makes no progress, and after a maximum number of pages
 */
"use strict";

const { fileNameFromPath } = require("./importFile");

// Documents read per page
const DEFAULT_LIMIT = 400;
// Moves per batch: each is 2 writes (archive copy + live delete), under Firestore's 500
const MOVE_BATCH_SIZE = 200;
// Pages per collection per run, so one run can't go on forever (400 x 50 = 20,000 documents)
const DEFAULT_MAX_PAGES = 50;
// Where archived statement files go
const ARCHIVE_PREFIX = "archive/";

/** Reads a Firestore Timestamp, a Date or a number of milliseconds as milliseconds. */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : null;
}

/** True only for a document that was soft deleted and whose purge date has passed. */
function isDue(data, nowMs) {
  const deletedAt = data?.deletedAt;
  const purgeAfterMs = toMillis(data?.purgeAfter);
  return deletedAt != null && purgeAfterMs != null && purgeAfterMs <= nowMs;
}

/** Loaded lazily so unit tests can run without firebase-admin installed. */
function defaultServerTimestamp() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

/** Where a statement file goes in the archive: users/a/imports/f.csv -> archive/users/a/imports/f.csv */
function archiveFilePath(storagePath) {
  return `${ARCHIVE_PREFIX}${storagePath}`;
}

/**
 * Moves documents to the archive in batches: for each one, the archive copy and the
 * live delete go in the same batch. If a batch is refused (usually because one of its
 * documents was restored since we read it), its documents are moved one at a time, so
 * only the changed one is skipped.
 *
 * @param {Object} db
 * @param {{snap: Object, archiveRef: Object, data: Object, precondition?: boolean}[]} moves
 * @returns {Promise<{moved: number, skipped: number}>}
 */
async function moveAll(db, moves) {
  let moved = 0;
  let skipped = 0;
  const commit = async (list) => {
    const batch = db.batch();
    for (const m of list) {
      batch.set(m.archiveRef, m.data);
      if (m.precondition === false) batch.delete(m.snap.ref);
      else batch.delete(m.snap.ref, { lastUpdateTime: m.snap.updateTime });
    }
    await batch.commit();
  };
  for (let i = 0; i < moves.length; i += MOVE_BATCH_SIZE) {
    const chunk = moves.slice(i, i + MOVE_BATCH_SIZE);
    try {
      await commit(chunk);
      moved += chunk.length;
    } catch {
      for (const m of chunk) {
        try {
          await commit([m]);
          moved++;
        } catch {
          skipped++; // changed (restored) since we read it, or already gone
        }
      }
    }
  }
  return { moved, skipped };
}

/** The archive copy: every original field, plus where it came from and when it moved. */
function archivedData(snap, userId, archivedAt, extra = {}) {
  return { ...snap.data(), userId, originalPath: snap.ref.path, archivedAt, ...extra };
}

/**
 * Archives the due documents that `makeQuery()` finds, one page at a time.
 * `target(snap)` returns { archiveRef, userId } for a document, or null to leave it.
 * @returns {Promise<{archived: number, skipped: number}>}
 */
async function archiveQuery({ db, makeQuery, target, nowMs, limit, maxPages, serverTimestamp, logger, label }) {
  let archived = 0;
  let skipped = 0;
  for (let page = 0; page < maxPages; page++) {
    const snap = await makeQuery().limit(limit).get();
    if (snap.empty) break;

    const moves = [];
    for (const d of snap.docs) {
      // The query already asked for these, but never move on the query alone
      const t = isDue(d.data(), nowMs) ? target(d) : null;
      if (!t) {
        skipped++;
        continue;
      }
      moves.push({ snap: d, archiveRef: t.archiveRef, data: archivedData(d, t.userId, serverTimestamp()) });
    }
    const r = await moveAll(db, moves);
    archived += r.moved;
    skipped += r.skipped;
    logger.info("Archived expired deletes", { collection: label, page: page + 1, archived: r.moved, skipped: r.skipped });

    // A short page means that was the last one. A page that moved nothing would come
    // back identical on the next read, so stop instead of looping.
    if (snap.size < limit || r.moved === 0) break;
  }
  return { archived, skipped };
}

/**
 * Archives one expired statement. The order makes a re-run after a failure part way
 * safe and complete:
 *   1. copy the file to archive/users/{uid}/imports/... (a copy left from an earlier
 *      attempt is simply written again; a file already gone is fine)
 *   2. move its transactions to archive_transactions, 200 at a time
 *   3. delete the original file
 *   4. move the import record to archive_imports (with archivedFilePath), conditioned on
 *      it being unchanged since we read it; if it changed, the record is left for the
 *      next run (a user can't restore a statement once purgeAfter has passed, so this
 *      only guards against two runs at once)
 *   5. write the "import.archived" audit entry, with the number of its transactions now
 *      in the archive
 * If the job stops after step 2 or 3, the record is still live and due, so the next run
 * repeats the steps: the file is found in the archive (step 1), and the transaction
 * count is read from the archive, so it's still right.
 * A file outside the owner's own folder is never touched.
 *
 * @returns {Promise<"archived"|"skipped">}
 */
async function archiveImport({ db, snap, uid, files, writeAudit, serverTimestamp, logger }) {
  const importId = snap.id;
  const imp = snap.data();
  const ownFile = typeof imp.storagePath === "string" && imp.storagePath.startsWith(`users/${uid}/imports/`);
  const archivedFilePath = ownFile ? archiveFilePath(imp.storagePath) : null;

  // 1. Copy the file
  let fileArchived = false;
  if (ownFile) {
    if (await files.exists(imp.storagePath)) {
      await files.copy(imp.storagePath, archivedFilePath);
      fileArchived = true;
    } else {
      fileArchived = await files.exists(archivedFilePath); // copied by an earlier run
    }
  }

  // 2. Its transactions (they can't be restored without the statement, so no precondition)
  const txnQuery = () =>
    db.collection("transactions").where("userId", "==", uid).where("sourceStatementId", "==", importId).limit(DEFAULT_LIMIT);
  for (;;) {
    const txns = await txnQuery().get();
    if (txns.empty) break;
    const r = await moveAll(
      db,
      txns.docs.map((t) => ({
        snap: t,
        archiveRef: db.collection("archive_transactions").doc(t.id),
        data: archivedData(t, uid, serverTimestamp()),
        precondition: false,
      }))
    );
    if (r.moved === 0) break; // nothing could be moved; don't loop
  }
  const transactionCount = (
    await db.collection("archive_transactions").where("userId", "==", uid).where("sourceStatementId", "==", importId).get()
  ).size;

  // 3. Remove the original file
  if (ownFile && fileArchived) await files.remove(imp.storagePath);

  // 4. The import record, only if nobody changed it since we read it
  const r = await moveAll(db, [{
    snap,
    archiveRef: db.collection("archive_imports").doc(`${uid}_${importId}`),
    data: archivedData(snap, uid, serverTimestamp(), { archivedFilePath: fileArchived ? archivedFilePath : null }),
  }]);
  if (r.moved === 0) {
    logger.warn("Statement changed while archiving, skipped", { uid, importId });
    return "skipped";
  }

  // 5. Audit
  await writeAudit({
    userId: uid,
    action: "import.archived",
    targetPath: `users/${uid}/imports/${importId}`,
    actor: "system",
    details: { fileName: fileNameFromPath(imp.storagePath), transactionCount, archivedFilePath: fileArchived ? archivedFilePath : null },
  });
  logger.info("Archived statement", { uid, importId, transactionCount });
  return "archived";
}

/**
 * Archives every statement whose 30 days are up.
 * @returns {Promise<{archived: number, skipped: number}>}
 */
async function archiveImports({ db, now, nowMs, limit, maxPages, files, writeAudit, serverTimestamp, logger }) {
  let archived = 0;
  let skipped = 0;
  for (let page = 0; page < maxPages; page++) {
    const snap = await db.collectionGroup("imports").where("purgeAfter", "<=", now).limit(limit).get();
    if (snap.empty) break;

    let moved = 0;
    for (const d of snap.docs) {
      const uid = d.ref.parent?.parent?.id; // users/{uid}/imports/{importId}
      if (!uid || !isDue(d.data(), nowMs)) {
        skipped++;
        continue;
      }
      try {
        const outcome = await archiveImport({ db, snap: d, uid, files, writeAudit, serverTimestamp, logger });
        if (outcome === "archived") moved++;
        else skipped++;
      } catch (err) {
        // Left as it is: still due, so the next run tries again
        skipped++;
        logger.error("Could not archive statement; will try again tomorrow", { uid, importId: d.id, message: err.message });
      }
    }
    archived += moved;
    if (snap.size < limit || moved === 0) break;
  }
  return { archived, skipped };
}

/**
 * @param {Object} opts
 * @param {Object} opts.db            Firestore instance
 * @param {Date}   [opts.now]         Treated as the current time (override in tests)
 * @param {number} [opts.limit]
 * @param {number} [opts.maxPages]
 * @param {{exists: (p: string) => Promise<boolean>, copy: (from: string, to: string) => Promise<void>,
 *          remove: (p: string) => Promise<void>}} [opts.files]
 *        Storage operations. Without them (and writeAudit), statements are left alone.
 * @param {(entry: Object) => Promise<void>} [opts.writeAudit]  auditLog.js createAuditWriter()
 * @param {() => any} [opts.serverTimestamp]  Override in tests
 * @param {Object} [opts.logger]
 * @returns {Promise<{imports: number, transactions: number, budgets: number, accounts: number, skipped: number}>}
 *          how many of each were archived
 */
async function runArchive({
  db,
  now = new Date(),
  limit = DEFAULT_LIMIT,
  maxPages = DEFAULT_MAX_PAGES,
  files,
  writeAudit,
  serverTimestamp = defaultServerTimestamp,
  logger = console,
}) {
  const nowMs = now.getTime();
  const common = { db, nowMs, limit, maxPages, serverTimestamp, logger };

  // Statements first, so they take their transactions with them. The sweep below then
  // only finds manual transactions, plus any a statement left behind.
  const imports = files && writeAudit
    ? await archiveImports({ ...common, now, files, writeAudit })
    : { archived: 0, skipped: 0 };

  // purgeAfter <= now only matches documents that have a purgeAfter, so active ones
  // (purgeAfter null) are never returned
  const txns = await archiveQuery({
    ...common,
    label: "transactions",
    makeQuery: () => db.collection("transactions").where("purgeAfter", "<=", now),
    target: (d) => {
      const userId = d.data().userId;
      return userId ? { userId, archiveRef: db.collection("archive_transactions").doc(d.id) } : null;
    },
  });
  // Budgets live under every user, so this reads across all users' budgets collections
  const budgets = await archiveQuery({
    ...common,
    label: "budgets",
    makeQuery: () => db.collectionGroup("budgets").where("purgeAfter", "<=", now),
    target: (d) => {
      const userId = d.ref.parent?.parent?.id; // users/{uid}/budgets/{categoryId}
      return userId ? { userId, archiveRef: db.collection("archive_budgets").doc(`${userId}_${d.id}`) } : null;
    },
  });
  // Accounts (SCRUM-167) are top level, with the owner in userId
  const accounts = await archiveQuery({
    ...common,
    label: "accounts",
    makeQuery: () => db.collection("accounts").where("purgeAfter", "<=", now),
    target: (d) => {
      const userId = d.data().userId;
      return userId ? { userId, archiveRef: db.collection("archive_accounts").doc(`${userId}_${d.id}`) } : null;
    },
  });

  const result = {
    imports: imports.archived,
    transactions: txns.archived,
    budgets: budgets.archived,
    accounts: accounts.archived,
    skipped: imports.skipped + txns.skipped + budgets.skipped + accounts.skipped,
  };
  logger.info("Archive finished", result);
  return result;
}

module.exports = {
  runArchive,
  // The old name, kept so existing callers keep working
  runPurge: runArchive,
  archiveImports,
  archiveFilePath,
  isDue,
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
  MOVE_BATCH_SIZE,
};
