/**
 * purgeJob.js (SCRUM-127)
 *
 * Permanently deletes things the user deleted more than 30 days ago.
 *
 * In the app, "delete" is a soft delete: a manual transaction or a budget gets
 * deletedAt, deletedBy and purgeAfter (30 days later) and is hidden, so it can be
 * restored from Recently deleted. The Firestore rules never let the app delete
 * for real, so this job (which runs on the server and bypasses the rules) is the
 * only thing that removes them for good.
 *
 * Covers:
 *   transactions/{id}                 transactions the user deleted (manual ones, and
 *                                     the ones from a deleted statement)
 *   users/{uid}/budgets/{categoryId}  budgets the user removed
 *   users/{uid}/imports/{importId}    statements the user deleted (SCRUM-122): the
 *                                     import record, the file in Storage, and any of its
 *                                     transactions still left, plus an "import.purged"
 *                                     audit entry with actor "system"
 *
 * Safety checks, because this deletes data:
 *   - only documents with both deletedAt and purgeAfter set, and purgeAfter in the past
 *   - each delete carries the time the document was last changed when we read it, so
 *     if the user restores it while the job runs, that delete is refused and skipped
 *   - the job stops if a page makes no progress, and after a maximum number of pages
 */
"use strict";

// Documents read (and deleted) per page
const DEFAULT_LIMIT = 400;
// Firestore allows 500 writes per batch; stay under it
const TXN_BATCH_SIZE = 400;
// Pages per collection per run, so one run can't go on forever (400 x 50 = 20,000 documents)
const DEFAULT_MAX_PAGES = 50;

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

/**
 * Deletes the due documents that `makeQuery()` finds, one page at a time.
 * @returns {Promise<{deleted: number, skipped: number}>}
 */
async function purgeQuery({ db, makeQuery, nowMs, limit, maxPages, logger, label }) {
  let deleted = 0;
  let skipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const snap = await makeQuery().limit(limit).get();
    if (snap.empty) break;

    const writer = db.bulkWriter();
    let refused = 0;
    let queued = 0;
    writer.onWriteError(() => {
      refused++; // usually: the user restored it since we read it
      return false; // don't retry
    });
    for (const d of snap.docs) {
      // The query already asked for these, but never delete on the query alone
      if (!isDue(d.data(), nowMs)) {
        skipped++;
        continue;
      }
      queued++;
      writer.delete(d.ref, { lastUpdateTime: d.updateTime }).catch(() => {}); // counted in onWriteError
    }
    await writer.close();

    const removed = queued - refused;
    deleted += removed;
    skipped += refused;
    logger.info("Purged expired deletes", { collection: label, page: page + 1, removed, refused });

    // A short page means that was the last one. A page that removed nothing would
    // come back identical on the next read, so stop instead of looping.
    if (snap.size < limit || removed === 0) break;
  }
  return { deleted, skipped };
}

/**
 * Removes statements whose 30 days are up (SCRUM-122). For each one, in this order:
 *   1. the import record, with the same "unchanged since we read it" check as above,
 *      so a statement restored while the job runs is left alone (and so is its file)
 *   2. any of its transactions still left (normally the step above already removed
 *      them, since they share the statement's purgeAfter), in batches of 400 or fewer
 *   3. the file in Storage (already gone is fine)
 *   4. an "import.purged" audit entry with actor "system"
 * A file outside the owner's own folder is never deleted.
 * @returns {Promise<{deleted: number, skipped: number}>}
 */
async function purgeImports({ db, now, nowMs, limit, maxPages, deleteFile, writeAudit, logger }) {
  let deleted = 0;
  let skipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const snap = await db.collectionGroup("imports").where("purgeAfter", "<=", now).limit(limit).get();
    if (snap.empty) break;

    let removed = 0;
    for (const d of snap.docs) {
      const imp = d.data();
      if (!isDue(imp, nowMs)) {
        skipped++;
        continue;
      }
      const uid = d.ref.parent.parent.id; // users/{uid}/imports/{importId}
      const importId = d.id;

      // 1. The import record, only if nobody restored it since we read it
      try {
        await d.ref.delete({ lastUpdateTime: d.updateTime });
      } catch (err) {
        skipped++;
        logger.warn("Statement changed while purging, skipped", { uid, importId, message: err.message });
        continue;
      }

      // 2. Its transactions still left
      let leftover = 0;
      for (;;) {
        const txns = await db.collection("transactions")
          .where("userId", "==", uid)
          .where("sourceStatementId", "==", importId)
          .limit(TXN_BATCH_SIZE)
          .get();
        if (txns.empty) break;
        const batch = db.batch();
        txns.docs.forEach((t) => batch.delete(t.ref));
        await batch.commit();
        leftover += txns.size;
      }

      // 3. The file, only from the owner's own folder
      if (imp.storagePath && imp.storagePath.startsWith(`users/${uid}/imports/`)) {
        try {
          await deleteFile(imp.storagePath);
        } catch (err) {
          if (!(err?.code === 404 || err?.code === "storage/object-not-found")) {
            logger.error("Could not delete purged statement file", { uid, importId, storagePath: imp.storagePath, message: err.message });
          }
        }
      }

      // 4. The audit entry
      await writeAudit({
        userId: uid,
        action: "import.purged",
        targetPath: `users/${uid}/imports/${importId}`,
        actor: "system",
        details: { fileName: imp.fileName ?? null, transactionCount: imp.transactionCount ?? null },
      });
      removed++;
      logger.info("Purged statement", { uid, importId, leftoverTransactions: leftover });
    }
    deleted += removed;
    // Same stop rules as purgeQuery
    if (snap.size < limit || removed === 0) break;
  }
  return { deleted, skipped };
}

/**
 * @param {Object} opts
 * @param {Object} opts.db            Firestore instance
 * @param {Date}   [opts.now]         Treated as the current time (override in tests)
 * @param {number} [opts.limit]
 * @param {number} [opts.maxPages]
 * @param {(path: string) => Promise<void>} [opts.deleteFile]  Deletes a Storage file. Without
 *        it (and writeAudit), statements are left alone.
 * @param {(entry: Object) => Promise<void>} [opts.writeAudit]  auditLog.js createAuditWriter()
 * @param {Object} [opts.logger]
 * @returns {Promise<{transactions: number, budgets: number, imports: number, skipped: number}>}
 */
async function runPurge({ db, now = new Date(), limit = DEFAULT_LIMIT, maxPages = DEFAULT_MAX_PAGES, deleteFile, writeAudit, logger = console }) {
  const nowMs = now.getTime();

  // purgeAfter <= now only matches documents that have a purgeAfter, so active ones
  // (purgeAfter null) are never returned
  const txns = await purgeQuery({
    db,
    makeQuery: () => db.collection("transactions").where("purgeAfter", "<=", now),
    nowMs,
    limit,
    maxPages,
    logger,
    label: "transactions",
  });
  // Budgets live under every user, so this reads across all users' budgets collections
  const budgets = await purgeQuery({
    db,
    makeQuery: () => db.collectionGroup("budgets").where("purgeAfter", "<=", now),
    nowMs,
    limit,
    maxPages,
    logger,
    label: "budgets",
  });

  // Statements last, so their transactions are already gone by the time the record goes
  const imports = deleteFile && writeAudit
    ? await purgeImports({ db, now, nowMs, limit, maxPages, deleteFile, writeAudit, logger })
    : { deleted: 0, skipped: 0 };

  const result = {
    transactions: txns.deleted,
    budgets: budgets.deleted,
    imports: imports.deleted,
    skipped: txns.skipped + budgets.skipped + imports.skipped,
  };
  logger.info("Purge finished", result);
  return result;
}

module.exports = { runPurge, purgeImports, isDue, DEFAULT_LIMIT, DEFAULT_MAX_PAGES };
