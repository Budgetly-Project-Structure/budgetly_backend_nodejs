/**
 * categorizeJob.js (SCRUM-71)
 *
 * The Firestore side of the categorizeTransactions Cloud Function: finds a
 * user's transactions that nothing has categorized yet, asks the AI for their
 * categories (categorize.js) and saves the answers.
 *
 * Only transactions with categorySource "none" are touched, so rule matches
 * (card payments) and anything the user picked are never overwritten. Each save
 * also checks the transaction hasn't changed since it was read; if the user
 * re-categorized it in the meantime, that one save is skipped.
 */
"use strict";

const { categorizeTransactions } = require("./categorize");

// Transactions handled per call; the caller calls again while `more` is true
const DEFAULT_LIMIT = 500;

/** Loaded lazily so unit tests can run without firebase-admin. */
function defaultServerTimestamp() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

/**
 * @param {Object} opts
 * @param {Object} opts.db            Firestore instance
 * @param {string} opts.uid           Whose transactions
 * @param {string|null} [opts.importId]  Only this import's transactions (default: all of them)
 * @param {Function} opts.classify    From aiClient.createClaudeClassifier()
 * @param {number} [opts.limit]
 * @param {Object} [opts.logger]
 * @param {() => any} [opts.serverTimestamp]  Override in tests
 * @returns {Promise<{checked: number, categorized: number, leftUncategorized: number, more: boolean}>}
 */
async function runCategorization({
  db,
  uid,
  importId = null,
  classify,
  limit = DEFAULT_LIMIT,
  logger = console,
  serverTimestamp = defaultServerTimestamp,
}) {
  let q = db.collection("transactions").where("userId", "==", uid).where("categorySource", "==", "none");
  if (importId) q = q.where("sourceStatementId", "==", importId);
  const snap = await q.limit(limit).get();
  if (snap.empty) return { checked: 0, categorized: 0, leftUncategorized: 0, more: false };

  const docs = snap.docs;
  const transactions = docs.map((d) => {
    const x = d.data();
    return { merchant: x.merchant, amount: x.amount, date: x.date?.toDate ? x.date.toDate() : x.date };
  });
  const { fields } = await categorizeTransactions(transactions, { classify, logger });

  // Save only real answers; fallbacks are already "uncategorized" / "none"
  const writer = db.bulkWriter();
  let skipped = 0;
  writer.onWriteError(() => {
    skipped++; // usually: the user changed it since we read it
    return false; // don't retry
  });
  docs.forEach((d, i) => {
    if (fields[i].categorySource !== "ai") return;
    writer
      .update(d.ref, { ...fields[i], updatedAt: serverTimestamp() }, { lastUpdateTime: d.updateTime })
      .catch(() => {}); // counted in onWriteError
  });
  await writer.close();

  const saved = fields.filter((f) => f.categorySource === "ai").length - skipped;
  logger.info("Categorization finished", { uid, importId, checked: docs.length, saved, skipped });
  return {
    checked: docs.length,
    categorized: saved,
    leftUncategorized: docs.length - saved,
    // A full page means there may be more to do. If nothing in it could be saved
    // (the AI is down), stop: another call would just fetch the same transactions.
    more: docs.length === limit && saved > 0,
  };
}

module.exports = { runCategorization, DEFAULT_LIMIT };
