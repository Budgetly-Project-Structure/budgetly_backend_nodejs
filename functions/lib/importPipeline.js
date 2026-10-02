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
 * "completed" or "failed" instead of stuck on "processing".
 */
"use strict";

const { parseStatementCsv, StatementParseError } = require("./csvParser");
const { toTransactionDocs } = require("./transactions");

const PDF_NOT_READY = "PDF statements aren't supported yet. Please export this statement as a CSV and upload that instead.";
const NOTHING_READABLE = "We couldn't read any transactions from this file.";
const UNEXPECTED = "Something went wrong while importing this file. Please try again.";

/**
 * @param {Object} opts
 * @param {Buffer} opts.fileBuffer   The downloaded file
 * @param {string} opts.fileType     "csv" or "pdf"
 * @param {string} opts.uid
 * @param {string} opts.importId
 * @param {string|null} [opts.accountId]
 * @param {Object} opts.store        From createStore()
 * @param {Object} [opts.logger]     firebase-functions logger (defaults to console)
 * @returns {Promise<{status: "completed"|"failed", transactionCount: number, skippedRowCount: number, error?: string}>}
 */
async function processImport({ fileBuffer, fileType, uid, importId, accountId = null, store, logger = console }) {
  const fail = async (message) => {
    await store.update({ status: "failed", error: message, transactionCount: 0 });
    return { status: "failed", transactionCount: 0, skippedRowCount: 0, error: message };
  };

  try {
    await store.update({ status: "processing" });

    // PDF parsing is SCRUM-25; until then fail with a clear next step
    if (fileType !== "csv") return await fail(PDF_NOT_READY);

    const parsed = parseStatementCsv(fileBuffer);

    if (parsed.transactions.length === 0) {
      const first = parsed.errors[0];
      return await fail(first ? `${NOTHING_READABLE} Line ${first.row}: ${first.reason}.` : NOTHING_READABLE);
    }

    const docs = toTransactionDocs(parsed.transactions, { uid, importId, accountId });
    await store.writeTransactions(docs);

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

module.exports = { processImport, PDF_NOT_READY, NOTHING_READABLE, UNEXPECTED };
