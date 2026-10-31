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
 *   transactions/{id}                 manual transactions the user deleted
 *   users/{uid}/budgets/{categoryId}  budgets the user removed
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
 * @param {Object} opts
 * @param {Object} opts.db            Firestore instance
 * @param {Date}   [opts.now]         Treated as the current time (override in tests)
 * @param {number} [opts.limit]
 * @param {number} [opts.maxPages]
 * @param {Object} [opts.logger]
 * @returns {Promise<{transactions: number, budgets: number, skipped: number}>}
 */
async function runPurge({ db, now = new Date(), limit = DEFAULT_LIMIT, maxPages = DEFAULT_MAX_PAGES, logger = console }) {
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

  const result = { transactions: txns.deleted, budgets: budgets.deleted, skipped: txns.skipped + budgets.skipped };
  logger.info("Purge finished", result);
  return result;
}

module.exports = { runPurge, isDue, DEFAULT_LIMIT, DEFAULT_MAX_PAGES };
