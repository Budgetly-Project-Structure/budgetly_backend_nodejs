/**
 * importPipeline.js (SCRUM-26, with the status handling of SCRUM-28
 * and the partial-failure reporting of SCRUM-27)
 *
 * Given the downloaded file, parse it, save the transactions and record the
 * outcome on the import doc. All Firestore access goes through `store`
 * (see firestoreStore.js), so this file has no Firebase code.
 *
 * Status lifecycle:  uploaded -> processing -> completed | failed
 *
 *   completed  at least one transaction was saved. Rows that couldn't be read
 *              are counted in `skippedRowCount` and listed in `rowErrors`
 *              (so the UI can show "34 of 36 imported").
 *   failed     nothing was saved. `error` holds a message written for users;
 *              the Import page shows it as-is.
 *
 * processImport never throws: whatever happens, the import ends up
 * "completed" or "failed" instead of stuck on "processing". That includes
 * running out of time: Google kills a function that hits its timeout and no
 * code runs after that, so the pipeline gives up on its own a bit earlier
 * (timeoutMs) and marks the import failed while it still can.
 */
"use strict";

const { parseStatementCsv, StatementParseError } = require("./csvParser");
const { parseStatementPdf } = require("./pdfParser");
const { toTransactionDocs } = require("./transactions");

const UNSUPPORTED_TYPE = "This file type isn't supported. Please upload a CSV or PDF statement.";
const NOTHING_READABLE = "We couldn't read any transactions from this file.";
const UNEXPECTED = "Something went wrong while importing this file. Please try again.";
const TIMED_OUT = "This file took too long to import. Please try again, or split it into smaller files.";

// The function's limit is 120 s (index.js). Stop well before it so there is time to record "failed".
const DEFAULT_TIMEOUT_MS = 100 * 1000;
const TIMEOUT = Symbol("timeout");

/**
 * @param {Object} opts
 * @param {Buffer} opts.fileBuffer   The downloaded file
 * @param {string} opts.fileType     "csv" or "pdf"
 * @param {string} opts.uid
 * @param {string} opts.importId
 * @param {string|null} [opts.accountId]
 * @param {Object} opts.store        From createStore()
 * @param {Object} [opts.logger]     firebase-functions logger (defaults to console)
 * @param {number} [opts.timeoutMs]  Give up and mark the import failed after this long
 * @returns {Promise<{status: "completed"|"failed", transactionCount: number, skippedRowCount: number, error?: string}>}
 */
async function runImport({ fileBuffer, fileType, uid, importId, accountId = null, store, logger = console }, state) {
  const fail = async (message) => {
    await store.update({ status: "failed", error: message, transactionCount: 0 });
    return { status: "failed", transactionCount: 0, skippedRowCount: 0, error: message };
  };

  try {
    await store.update({ status: "processing" });

    if (fileType !== "csv" && fileType !== "pdf") return await fail(UNSUPPORTED_TYPE);

    // Both parsers return the same shape, so everything below doesn't care which one ran
    const parsed = fileType === "pdf" ? await parseStatementPdf(fileBuffer) : parseStatementCsv(fileBuffer);

    if (parsed.transactions.length === 0) {
      const first = parsed.errors[0];
      return await fail(first ? `${NOTHING_READABLE} Line ${first.row}: ${first.reason}.` : NOTHING_READABLE);
    }

    const docs = toTransactionDocs(parsed.transactions, { uid, importId, accountId });
    if (state.timedOut) return null; // already marked failed; don't start writing
    await store.writeTransactions(docs);
    if (state.timedOut) {
      // The deadline passed while we were writing: the import is already marked
      // failed, so remove what we just saved instead of leaving it behind.
      await store.deleteTransactions();
      return null;
    }

    const result = {
      status: "completed",
      transactionCount: docs.length,
      skippedRowCount: parsed.errorCount,
    };
    await store.update({
      ...result,
      rowErrors: parsed.errors, // [{row, reason}], capped at 100 by the parser
      error: null,
    });
    return result;
  } catch (err) {
    if (state.timedOut) return null; // the deadline handler already recorded the failure
    const isBadFile = err instanceof StatementParseError;

    if (!isBadFile) {
      // Our bug or an outage: log the details, show users a generic message
      logger.error("Import failed unexpectedly", { uid, importId, message: err.message, stack: err.stack });
      try {
        await store.deleteTransactions(); // don't leave half an import behind
      } catch (cleanupErr) {
        logger.error("Cleanup after failed import also failed", { uid, importId, message: cleanupErr.message });
      }
    }

    const message = isBadFile ? err.message : UNEXPECTED;
    try {
      return await fail(message);
    } catch (statusErr) {
      logger.error("Could not mark import as failed", { uid, importId, message: statusErr.message });
      return { status: "failed", transactionCount: 0, skippedRowCount: 0, error: message };
    }
  }
}

async function processImport(opts) {
  const { store, uid, importId, logger = console, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const state = { timedOut: false };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      resolve(TIMEOUT);
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([runImport(opts, state), deadline]);
    if (outcome !== TIMEOUT && outcome !== null) return outcome;
  } finally {
    clearTimeout(timer);
  }

  // Out of time: undo any partial write and record the failure
  logger.error("Import timed out", { uid, importId, timeoutMs });
  try {
    await store.deleteTransactions();
  } catch (cleanupErr) {
    logger.error("Cleanup after timed-out import failed", { uid, importId, message: cleanupErr.message });
  }
  try {
    await store.update({ status: "failed", error: TIMED_OUT, transactionCount: 0 });
  } catch (statusErr) {
    logger.error("Could not mark timed-out import as failed", { uid, importId, message: statusErr.message });
  }
  return { status: "failed", transactionCount: 0, skippedRowCount: 0, error: TIMED_OUT };
}

module.exports = { processImport, UNSUPPORTED_TYPE, NOTHING_READABLE, UNEXPECTED, TIMED_OUT };
