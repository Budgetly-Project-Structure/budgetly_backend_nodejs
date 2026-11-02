/**
 * accountType.js (SCRUM-135)
 *
 * Works out from a parsed statement whether it's from a checking account or a
 * credit card, so the user doesn't have to pick the account before uploading.
 * Pure function: no Firebase, easy to unit test.
 *
 * Each clue adds points to one side; the side with more points wins, as long
 * as it has at least MIN_SCORE. With no clear winner the answer is null
 * ("couldn't tell"), and the import reads the file as before.
 *
 *   checking  a running Balance column (card exports don't have one)
 *             a paycheck / direct deposit coming in
 *             a payment going OUT to a card company (paying the card from checking)
 *   credit    a card payment coming IN ("PAYMENT - THANK YOU", "AUTOPAY")
 *             purchases listed as positive numbers (most rows positive, one Amount column)
 */
"use strict";

const MIN_SCORE = 2;

// The account an import is filed under when the user let us detect the type. These are
// the web app's two accounts (budgetly_web_customer src/data/mockData.js ACCOUNTS).
const ACCOUNT_ID_FOR_TYPE = { checking: "acct-checking", credit: "acct-credit" };

// A paycheck or direct deposit: money in that only lands in a bank account
const PAYCHECK = /\b(payroll|direct dep(osit)?|dir dep|salary)\b/i;
// The card company thanking you for a payment: a credit card statement
const CARD_PAYMENT_IN = /payment\s*-?\s*thank\s*you|\bautopay\b|automatic payment|payment received|online payment/i;
// Paying a card off from checking: money out to a card issuer
const CARD_PAYMENT_OUT = /\b(credit\s*crd|credit card|card)\b.*\b(payment|pymt|pmt|autopay|epay)\b|\b(capital one|discover|amex|american express|citi card)\b.*\b(payment|pymt|pmt|autopay|epay)\b/i;

/**
 * @param {{transactions: {merchant: string, amount: number}[], meta?: Object}} parsed
 *        what parseStatementCsv / parseStatementPdf return
 * @returns {{type: "checking"|"credit"|null, reasons: string[]}}
 */
function detectAccountType(parsed) {
  const txns = parsed?.transactions ?? [];
  const meta = parsed?.meta ?? {};
  let checking = 0;
  let credit = 0;
  const reasons = [];

  if (meta.columns?.balance || meta.hasBalance) {
    checking += 3;
    reasons.push("has a running balance");
  }
  if (txns.some((t) => t.amount > 0 && PAYCHECK.test(t.merchant))) {
    checking += 3;
    reasons.push("a paycheck comes in");
  }
  if (txns.some((t) => t.amount < 0 && CARD_PAYMENT_OUT.test(t.merchant))) {
    checking += 2;
    reasons.push("pays a credit card");
  }
  if (txns.some((t) => t.amount > 0 && CARD_PAYMENT_IN.test(t.merchant))) {
    credit += 3;
    reasons.push("receives a card payment");
  }
  // Card exports often list purchases as positive numbers in a single Amount column
  const cols = meta.columns ?? {};
  const singleAmountColumn = cols.amount && !cols.debit && !cols.credit;
  if (singleAmountColumn && txns.length > 0 && txns.filter((t) => t.amount > 0).length > txns.length / 2) {
    credit += 3;
    reasons.push("purchases are listed as positive amounts");
  }

  let type = null;
  if (checking >= MIN_SCORE && checking > credit) type = "checking";
  else if (credit >= MIN_SCORE && credit > checking) type = "credit";
  return { type, reasons };
}

module.exports = { detectAccountType, ACCOUNT_ID_FOR_TYPE };
