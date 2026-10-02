/**
 * transactions.js (SCRUM-26)
 *
 * Turns parsed statement rows into Firestore transaction documents.
 * Pure function: no Firebase imports, so it is easy to unit test.
 *
 * Document shape follows budgetly_contracts/schemas/data-model.md and the
 * mock data the web app is built against (src/data/mockData.js):
 *
 *   users/{uid}/transactions/{id}
 *     userId            owner (the contracts say every doc carries this)
 *     date              Firestore Timestamp (a JS Date here; the Admin SDK converts it)
 *     merchant          raw merchant text from the statement
 *     amount            dollars, negative = spending, positive = income
 *     category          "uncategorized" until the AI step runs (a later ticket)
 *     categoryConfidence  null until categorized
 *     categorySource    "none" until categorized; the Firestore rules only let
 *                       the owner change a category when this is set to "user"
 *     isUserCorrected   false
 *     accountId         which account the statement belongs to, or null
 *     sourceStatementId the import doc this transaction came from (the "statementId")
 *     createdAt         added by the writer (server timestamp)
 */
"use strict";

/**
 * Dates are stored at 12:00 UTC. A bare midnight timestamp can display as the
 * previous day for users west of UTC; noon is the same calendar day everywhere
 * from UTC-12 to UTC+11.
 */
function dateToNoonUtc(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`);
}

/**
 * Deterministic document ID: importId + the row's line number in the file.
 * If the same import is ever processed twice (Cloud Functions can deliver an
 * event more than once), the second run overwrites the same documents
 * instead of creating duplicates.
 */
function transactionId(importId, rowNumber) {
  return `${importId}_${String(rowNumber).padStart(5, "0")}`;
}

/**
 * @param {{date: string, merchant: string, amount: number, rowNumber: number}[]} parsed
 *        `transactions` from parseStatementCsv
 * @param {{uid: string, importId: string, accountId?: string|null}} ctx
 * @returns {Object[]} documents; `id` is the Firestore doc ID (the writer removes it from the data)
 */
function toTransactionDocs(parsed, { uid, importId, accountId = null }) {
  return parsed.map((t) => ({
    id: transactionId(importId, t.rowNumber),
    userId: uid,
    date: dateToNoonUtc(t.date),
    merchant: t.merchant,
    amount: t.amount,
    category: "uncategorized",
    categoryConfidence: null,
    categorySource: "none",
    isUserCorrected: false,
    accountId: accountId || null,
    sourceStatementId: importId,
  }));
}

module.exports = { toTransactionDocs, transactionId };
