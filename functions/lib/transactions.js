/**
 * transactions.js (SCRUM-26)
 *
 * Turns parsed statement rows into Firestore transaction documents.
 * Pure function: no Firebase imports, so it is easy to unit test.
 *
 * Document shape follows budgetly_contracts/schemas/data-model.md and the
 * mock data the web app is built against (src/data/mockData.js):
 *
 *   transactions/{uid}_{importId}_{rowNumber}   (top-level collection, SCRUM-111)
 *     userId            owner (the contracts say every doc carries this)
 *     date              Firestore Timestamp (a JS Date here; the Admin SDK converts it)
 *     merchant          raw merchant text from the statement
 *     amountCents       integer cents, negative = spending, positive = income (Sprint 5 #6)
 *     amount            TEMPORARY: dollars (amountCents / 100), still written so the live
 *                       web app keeps working until it reads cents (Sprint 5 #5/#7).
 *                       Deprecated; the migration (#8) removes it
 *     category          "transfers" for credit card payments (transferRules.js),
 *                       otherwise "uncategorized" until the AI step runs (a later ticket)
 *     categoryConfidence  1 for a rule match, otherwise null until categorized
 *     categorySource    "rule" for a rule match, otherwise "none" until categorized;
 *                       the Firestore rules only let the owner change a category
 *                       when this is set to "user"
 *     isUserCorrected   false
 *     accountId         which account the statement belongs to, or null
 *     sourceStatementId the import doc this transaction came from (the "statementId")
 *     source            "import" (manual transactions are added by the web app)
 *     deletedAt         null; the web app sets it to soft delete (rules: SCRUM-113)
 *     deletedBy         null
 *     purgeAfter        null
 *     createdAt         added by the writer (server timestamp)
 */
"use strict";

const { categorizeByRules } = require("./transferRules");
const { centsToDollars } = require("./money");

/**
 * Dates are stored at 12:00 UTC. A bare midnight timestamp can display as the
 * previous day for users west of UTC; noon is the same calendar day everywhere
 * from UTC-12 to UTC+11.
 */
function dateToNoonUtc(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`);
}

/**
 * Deterministic document ID: uid + importId + the row's line number in the file.
 * Transactions now share one top-level collection, so the uid is part of the ID
 * (two users can never collide). If the same import is ever processed twice
 * (Cloud Functions can deliver an event more than once), the second run
 * overwrites the same documents instead of creating duplicates.
 */
function transactionId(uid, importId, rowNumber) {
  return `${uid}_${importId}_${String(rowNumber).padStart(5, "0")}`;
}

/**
 * @param {{date: string, merchant: string, amountCents: number, rowNumber: number}[]} parsed
 *        `transactions` from parseStatementCsv
 * @param {{uid: string, importId: string, accountId?: string|null, accountType?: string|null}} ctx
 *        accountType ("credit" or "checking") helps spot card payments
 * @returns {Object[]} documents; `id` is the Firestore doc ID (the writer removes it from the data)
 */
function toTransactionDocs(parsed, { uid, importId, accountId = null, accountType = null }) {
  return parsed.map((t) => ({
    id: transactionId(uid, importId, t.rowNumber),
    userId: uid,
    date: dateToNoonUtc(t.date),
    merchant: t.merchant,
    amountCents: t.amountCents,
    // TEMPORARY (Sprint 5 #6): dollars for the web app until it reads amountCents (#5/#7).
    // Nothing on the server reads it. Remove once the migration (#8) has run.
    amount: centsToDollars(t.amountCents),
    ...categorizeByRules(t.merchant, t.amountCents, accountType),
    isUserCorrected: false,
    accountId: accountId || null,
    sourceStatementId: importId,
    source: "import",
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
  }));
}

module.exports = { toTransactionDocs, transactionId };
