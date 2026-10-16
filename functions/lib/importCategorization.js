/**
 * importCategorization.js (SCRUM-73, SCRUM-74, SCRUM-75)
 *
 * Categorizes the transactions of an import before they are saved, so nobody has
 * to fix a whole statement by hand. importPipeline.js calls this for every CSV
 * and every PDF, between parsing and the Firestore write.
 *
 * Each transaction is settled by the first step that knows its category:
 *   1. the free rules (card payments, known merchants): already done by
 *      toTransactionDocs, these have categorySource "rule" and are left alone
 *   2. the user's merchant cache (merchantCache.js): categorySource "cache", no AI call
 *   3. the AI model (categorize.js), in chunks of 50: categorySource "ai"
 *   4. otherwise it stays Uncategorized (categorySource "none") for the user to set.
 *      A later categorizeTransactions call (aiFunctions.js) can still pick these up.
 *
 * Categorizing never breaks an import: every error is caught and logged, and the
 * transactions it couldn't place are simply saved as Uncategorized.
 *
 * The AI step is optional. With no `classify` function (the default: the AI is
 * switched off so deploys stay free) only steps 1, 2 and 4 run.
 *
 * Time (SCRUM-74): the whole import has to finish inside the function's timeout
 * (importPipeline.js). The AI gets a time budget: once it is spent, chunks that
 * haven't started are skipped and stay Uncategorized, while the chunks already
 * answered keep their AI categories.
 */
"use strict";

const { categorizeTransactions } = require("./categorize");
const { applyCache } = require("./merchantCache");

// How long the AI may keep starting new chunks. A chunk already running can take up
// to 20 s more (aiClient.js), which still leaves room before the 100 s import deadline.
const DEFAULT_AI_BUDGET_MS = 60 * 1000;

/**
 * Builds the `categorizer` function that processImport() runs on the new documents.
 *
 * @param {Object} opts
 * @param {{lookup: Function}|null} [opts.cache]  From createMerchantCache(); null to skip the cache
 * @param {Function|null} [opts.classify]         From createClaudeClassifier(); null = AI off
 * @param {Object} [opts.logger]
 * @param {number} [opts.aiBudgetMs]
 * @returns {(docs: Object[]) => Promise<{docs: Object[], summary: Object}>}
 *          Never rejects. `summary` counts how each transaction was categorized.
 */
function createImportCategorizer({ cache = null, classify = null, logger = console, aiBudgetMs = DEFAULT_AI_BUDGET_MS } = {}) {
  return async function categorizeImport(docs) {
    let current = docs;
    let cacheHits = 0;
    let aiCategorized = 0;
    let aiSkippedChunks = 0;
    let aiFailedChunks = 0;

    // Step 2: the user's own earlier choices
    if (cache) {
      try {
        const pending = current.filter((d) => d.categorySource === "none");
        if (pending.length > 0) {
          const cached = await cache.lookup(pending.map((d) => d.merchant));
          ({ docs: current, hits: cacheHits } = applyCache(current, cached));
        }
      } catch (err) {
        logger.warn("Merchant cache lookup failed; continuing without it", { message: err.message });
      }
    }

    // Step 3: the AI, only for what is still unknown
    if (classify) {
      try {
        const indexes = [];
        current.forEach((d, i) => {
          if (d.categorySource === "none") indexes.push(i);
        });
        if (indexes.length > 0) {
          const result = await categorizeTransactions(
            indexes.map((i) => current[i]),
            { classify, logger, timeBudgetMs: aiBudgetMs }
          );
          current = current.slice();
          indexes.forEach((docIndex, n) => {
            const f = result.fields[n];
            if (f.categorySource === "ai") {
              current[docIndex] = { ...current[docIndex], ...f };
              aiCategorized++;
            }
          });
          aiSkippedChunks = result.skippedBatches;
          aiFailedChunks = result.failedBatches;
        }
      } catch (err) {
        logger.warn("AI categorization failed; saving the rest as uncategorized", { message: err.message });
      }
    }

    const summary = {
      total: current.length,
      rule: current.filter((d) => d.categorySource === "rule").length,
      cache: cacheHits,
      ai: aiCategorized,
      uncategorized: current.filter((d) => d.categorySource === "none").length,
      aiFailedChunks,
      aiSkippedChunks,
    };
    return { docs: current, summary };
  };
}

module.exports = { createImportCategorizer, DEFAULT_AI_BUDGET_MS };
