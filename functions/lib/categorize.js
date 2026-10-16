/**
 * categorize.js (SCRUM-71, SCRUM-72)
 *
 * Asks the AI model for each transaction's category, in batches of 50, and
 * checks every answer against budgetly_contracts/ai/categorization-interface.md.
 * Anything that fails a check falls back to Uncategorized, so categorization can
 * never break an import or leave bad data behind (SCRUM-72).
 *
 * Large imports (SCRUM-74): the transactions go to the model 50 at a time, a few
 * chunks in parallel. A chunk that fails only affects its own 50 transactions;
 * every other chunk keeps its AI categories. `timeBudgetMs` caps how long new chunks
 * may be started, so a big file can't run past the import's time limit: chunks that
 * didn't start are left Uncategorized.
 *
 * Pure logic: the model call is the `classify` function passed in (aiClient.js
 * in production, a fake in tests), so this file has no Firebase or SDK code.
 */
"use strict";

const { AI_CATEGORIES, uncategorizedFields } = require("./categories");

const BATCH_SIZE = 50;
// Batches sent to the model at the same time
const DEFAULT_CONCURRENCY = 4;

const AI_CATEGORY_IDS = new Set(AI_CATEGORIES.map((c) => c.id));

/** "YYYY-MM-DD" from a Date or an ISO string. */
function toIsoDate(date) {
  return (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10);
}

/**
 * Checks the model's reply for one batch and turns it into category fields.
 * Returns one entry per transaction, in order; a transaction without a usable
 * answer gets the Uncategorized fields.
 *
 * @param {Object} reply  What classify() returned
 * @param {{merchant: string, amount: number}[]} batch
 */
function readReply(reply, batch) {
  const fallback = batch.map(() => uncategorizedFields());
  if (!reply || !Array.isArray(reply.results)) return fallback;

  const byId = new Map();
  for (const r of reply.results) {
    // An id that appears twice: the first answer wins
    if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  }

  return batch.map((t, i) => {
    const r = byId.get(`t${i + 1}`);
    if (!r) return fallback[i];
    const ok =
      AI_CATEGORY_IDS.has(r.category) &&
      typeof r.confidence === "number" &&
      r.confidence >= 0 &&
      r.confidence <= 1 &&
      // Income can only be money coming in; a spending category on money in is a refund
      !(r.category === "income" && !(t.amount > 0));
    if (!ok) return fallback[i];
    return {
      category: r.category,
      categoryConfidence: Math.round(r.confidence * 100) / 100,
      categorySource: "ai",
    };
  });
}

/**
 * Categorizes transactions with the AI model.
 *
 * @param {{merchant: string, amount: number, date: Date|string}[]} transactions
 * @param {Object} opts
 * @param {(request: Object) => Promise<Object>} opts.classify  Sends one batch to the model
 * @param {Object} [opts.logger]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeBudgetMs]  Stop starting new chunks after this long (default: no limit)
 * @param {() => number} [opts.now]     Clock, replaced in tests
 * @returns {Promise<{fields: {category: string, categoryConfidence: number|null, categorySource: string}[],
 *                    categorized: number, fellBack: number, failedBatches: number, skippedBatches: number}>}
 *          fields lines up with `transactions`. Never rejects.
 *          failedBatches = chunks the model call failed for; skippedBatches = chunks never
 *          sent because the time budget ran out.
 */
async function categorizeTransactions(
  transactions,
  { classify, logger = console, concurrency = DEFAULT_CONCURRENCY, timeBudgetMs = Infinity, now = Date.now }
) {
  const startedAt = now();
  const batches = [];
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) batches.push(transactions.slice(i, i + BATCH_SIZE));

  let failedBatches = 0;
  let skippedBatches = 0;
  const results = new Array(batches.length);

  async function run(index) {
    const batch = batches[index];
    // Out of time: don't start another chunk, it would risk the import's deadline
    if (now() - startedAt >= timeBudgetMs) {
      skippedBatches++;
      results[index] = batch.map(() => uncategorizedFields());
      return;
    }
    const request = {
      categories: AI_CATEGORIES,
      // Short ids for this request only, so no Firestore ids leave the backend
      transactions: batch.map((t, i) => ({
        id: `t${i + 1}`,
        merchant: String(t.merchant ?? ""),
        amount: t.amount,
        date: toIsoDate(t.date),
      })),
    };
    try {
      results[index] = readReply(await classify(request), batch);
    } catch (err) {
      // Timeout, rate limit, outage, refusal, bad JSON: this batch stays Uncategorized
      failedBatches++;
      logger.warn("AI categorization batch failed; leaving it uncategorized", {
        batch: index,
        size: batch.length,
        message: err.message,
      });
      results[index] = batch.map(() => uncategorizedFields());
    }
  }

  // A small pool: `concurrency` batches in flight at once
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) await run(next++);
  });
  await Promise.all(workers);

  const fields = results.flat();
  const categorized = fields.filter((f) => f.categorySource === "ai").length;
  if (skippedBatches > 0) {
    logger.warn("AI categorization ran out of time; the rest stays uncategorized", { skippedBatches, batches: batches.length });
  }
  return { fields, categorized, fellBack: fields.length - categorized, failedBatches, skippedBatches };
}

module.exports = { categorizeTransactions, readReply, BATCH_SIZE };
