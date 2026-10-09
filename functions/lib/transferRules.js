/**
 * transferRules.js
 *
 * Spots credit card payments so they can be marked as transfers instead of
 * income or spending. Paying off a card is just moving money between your own
 * accounts: the purchases on the card are the real spending.
 *
 * Two kinds of line are caught:
 *   1. The payment arriving on the card statement, as money in:
 *        "AUTOMATIC PAYMENT - THANK YOU", "PAYMENT THANK YOU", "AUTOPAY",
 *        "ONLINE PAYMENT, THANK YOU"
 *   2. The same payment leaving checking, as money out, naming the card company:
 *        "CHASE CREDIT CRD AUTOPAY", "CAPITAL ONE ONLINE PMT", "DISCOVER E-PAYMENT"
 *
 * Plain "AUTOPAY" leaving checking is NOT a transfer on its own: that's how
 * many utilities and subscriptions show up ("EVERGY AUTOPAY"). It needs a card
 * company's name next to it.
 *
 * Pure functions, no Firebase, so they're easy to unit test.
 */
"use strict";

const { TRANSFER_CATEGORY, uncategorizedFields } = require("./categories");
const { categorizeMerchant } = require("./merchantRules");

// A payment received on a card statement
const CARD_PAYMENT = /\b(payments?\s*[-,]?\s*thank\s*you|automatic\s+payment|auto\s*-?\s*pay|online\s+payment)\b/i;
// Card companies, as they appear on checking statements
const CARD_ISSUER = /\b(chase|capital\s*one|discover|amex|american\s+express|citi|citibank|credit\s+cr?d|crd\s+pmt|card\s+services)\b/i;
// Words that mean "a payment" on the checking side
const PAYMENT_WORD = /\b(pmt|payment|autopay|auto\s*pay|e-?payment|epay)\b/i;

/**
 * True if this line is a credit card payment (either side of it).
 *
 * @param {string} merchant  Description from the statement
 * @param {number} amount    Negative = money out, positive = money in
 * @param {string|null} [accountType]  "credit", "checking" or null (unknown)
 */
function isCardPayment(merchant, amount, accountType = null) {
  const text = String(merchant || "");
  // Money arriving with "payment thank you" wording is a card being paid,
  // even if the statement was imported under the wrong account
  if (amount > 0 && CARD_PAYMENT.test(text)) return true;
  // On a card statement, the payment line can't be anything else
  if (accountType === "credit" && CARD_PAYMENT.test(text)) return true;
  // Money leaving a bank account to a card company
  if (amount < 0 && accountType !== "credit" && CARD_ISSUER.test(text) && PAYMENT_WORD.test(text)) return true;
  return false;
}

/**
 * The category fields for a transaction from the free rules: a transfer for a
 * card payment, then a category from the merchant keyword list (merchantRules.js),
 * otherwise uncategorized (until the user, or a later AI step, sets one).
 *
 * @returns {{category: string, categoryConfidence: number|null, categorySource: string}}
 */
function categorizeByRules(merchant, amount, accountType = null) {
  if (isCardPayment(merchant, amount, accountType)) {
    return { category: TRANSFER_CATEGORY, categoryConfidence: 1, categorySource: "rule" };
  }
  return categorizeMerchant(merchant, amount) ?? uncategorizedFields();
}

module.exports = { isCardPayment, categorizeByRules, TRANSFER_CATEGORY };
