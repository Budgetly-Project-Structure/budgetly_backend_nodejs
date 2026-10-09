/**
 * Tests for credit card statements: card payments marked as transfers
 * (transferRules.js) and purchases written as positive numbers (importPipeline.js).
 *
 * Fixtures:
 *   credit_card_no_balance_sept_2026.csv  purchases as POSITIVE numbers, no balance column,
 *                                         a -350.00 autopay and a -23.47 return
 *   credit_card_signed_aug_2026.csv       purchases as negative numbers (Chase style, with a
 *                                         Type column), a +2,794.75 autopay and a +31.51 refund
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isCardPayment, categorizeByRules } = require("../lib/transferRules");
const { parseStatementCsv } = require("../lib/csvParser");
const { processImport, purchasesLookPositive } = require("../lib/importPipeline");
const { toTransactionDocs } = require("../lib/transactions");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const silentLogger = { info() {}, warn() {}, error() {} };
const cents = (n) => Math.round(n * 100) / 100;

/** Money in / money out of saved docs, leaving out transfers (what the web app shows). */
function totals(docs) {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const d of docs) {
    if (d.category === "transfers") continue;
    if (d.amount > 0) moneyIn += d.amount;
    else moneyOut -= d.amount;
  }
  return { moneyIn: cents(moneyIn), moneyOut: cents(moneyOut) };
}

/** Minimal store that keeps what the pipeline writes. */
function fakeStore() {
  const s = {
    written: [],
    async update() {},
    async writeTransactions(docs) {
      s.written.push(...docs);
    },
    async deleteTransactions() {},
  };
  return s;
}

const importFile = async (name, accountType) => {
  const store = fakeStore();
  const result = await processImport({
    fileBuffer: fixture(name),
    fileType: "csv",
    uid: "alice",
    importId: "imp1",
    accountId: accountType === "credit" ? "acct-credit" : "acct-checking",
    accountType,
    store,
    logger: silentLogger,
  });
  return { result, docs: store.written };
};

// ---------------------------------------------------------------------------
describe("isCardPayment", () => {
  test("payments arriving on a card statement", () => {
    assert.equal(isCardPayment("AUTOMATIC PAYMENT - THANK YOU", 2794.75, "credit"), true);
    assert.equal(isCardPayment("PAYMENT THANK YOU", 500, null), true);
    assert.equal(isCardPayment("Online Payment, Thank You", 120, "credit"), true);
    assert.equal(isCardPayment("AUTOPAY PAYMENT - THANK YOU", -350, "credit"), true);
  });

  test("a card payment imported under the wrong account is still caught (money in + 'thank you')", () => {
    assert.equal(isCardPayment("AUTOMATIC PAYMENT - THANK YOU", 3063.76, "checking"), true);
  });

  test("payments leaving checking to a card company", () => {
    assert.equal(isCardPayment("CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224", -2794.75, "checking"), true);
    assert.equal(isCardPayment("CAPITAL ONE ONLINE PMT", -410.2, "checking"), true);
    assert.equal(isCardPayment("DISCOVER E-PAYMENT 4471", -88, null), true);
    assert.equal(isCardPayment("AMEX EPAYMENT ACH PMT", -1200, "checking"), true);
    assert.equal(isCardPayment("CITI CARD ONLINE PAYMENT", -75, "checking"), true);
  });

  test("ordinary bills, purchases, refunds and paychecks are not transfers", () => {
    assert.equal(isCardPayment("EVERGY AUTOPAY", -94.4, "checking"), false); // utility autopay
    assert.equal(isCardPayment("NETFLIX.COM", -15.49, "credit"), false);
    assert.equal(isCardPayment("AMAZON.COM REFUND AMZN.COM/BILL", 31.51, "credit"), false);
    assert.equal(isCardPayment("ACME CORP PAYROLL", 1850, "checking"), false);
    assert.equal(isCardPayment("CHASE BANK ATM WITHDRAWAL", -60, "checking"), false); // card company, but not a payment
  });

  test("categorizeByRules: transfer with source 'rule', otherwise uncategorized", () => {
    assert.deepEqual(categorizeByRules("PAYMENT THANK YOU", 100, "credit"), {
      category: "transfers",
      categoryConfidence: 1,
      categorySource: "rule",
    });
    assert.deepEqual(categorizeByRules("Starbucks", -6.45, "credit"), {
      category: "uncategorized",
      categoryConfidence: null,
      categorySource: "none",
    });
  });

  test("toTransactionDocs applies the rules", () => {
    const docs = toTransactionDocs(
      [
        { date: "2026-08-26", merchant: "AUTOMATIC PAYMENT - THANK YOU", amount: 2794.75, rowNumber: 8 },
        { date: "2026-08-26", merchant: "STARBUCKS STORE 08812", amount: -7.48, rowNumber: 7 },
      ],
      { uid: "alice", importId: "imp1", accountType: "credit" }
    );
    assert.equal(docs[0].category, "transfers");
    assert.equal(docs[0].categorySource, "rule");
    assert.equal(docs[1].category, "uncategorized");
  });
});

// ---------------------------------------------------------------------------
describe("purchasesLookPositive", () => {
  test("true for a single Amount column where most rows are positive", () => {
    assert.equal(purchasesLookPositive(parseStatementCsv(fixture("credit_card_no_balance_sept_2026.csv"))), true);
  });

  test("false when purchases are already negative", () => {
    assert.equal(purchasesLookPositive(parseStatementCsv(fixture("credit_card_signed_aug_2026.csv"))), false);
    assert.equal(purchasesLookPositive(parseStatementCsv(fixture("checking_sept_2026.csv"))), false);
  });

  test("false for separate Debit / Credit columns (the column already says which way)", () => {
    assert.equal(purchasesLookPositive(parseStatementCsv(fixture("checking_aug_2026.csv"))), false);
  });
});

// ---------------------------------------------------------------------------
describe("processImport: credit card statements", () => {
  test("positive purchases on a card account become money out; the autopay is a transfer", async () => {
    const { result, docs } = await importFile("credit_card_no_balance_sept_2026.csv", "credit");

    assert.equal(result.status, "completed");
    assert.equal(docs.length, 18);
    // 16 purchases = $669.58 out; the $23.47 return is the only real money in
    assert.deepEqual(totals(docs), { moneyIn: 23.47, moneyOut: 669.58 });
    const autopay = docs.find((d) => /AUTOPAY/.test(d.merchant));
    assert.equal(autopay.amount, 350);
    assert.equal(autopay.category, "transfers");
    assert.equal(docs.find((d) => /STARBUCKS/.test(d.merchant)).amount, -6.45);
  });

  test("a card file that already uses negative purchases is left as-is; the payment is a transfer", async () => {
    const { docs } = await importFile("credit_card_signed_aug_2026.csv", "credit");

    assert.equal(docs.length, 13);
    const payment = docs.find((d) => /AUTOMATIC PAYMENT/.test(d.merchant));
    assert.equal(payment.amount, 2794.75);
    assert.equal(payment.category, "transfers");
    assert.equal(payment.categoryConfidence, 1);
    // Without the payment, money in is just the $31.51 refund
    assert.deepEqual(totals(docs), { moneyIn: 31.51, moneyOut: 569.39 });
  });

  test("the same signed card file imported as checking still treats the payment as a transfer", async () => {
    const { docs } = await importFile("credit_card_signed_aug_2026.csv", "checking");
    assert.equal(docs.find((d) => /AUTOMATIC PAYMENT/.test(d.merchant)).category, "transfers");
  });

  test("signs are never flipped for a checking account", async () => {
    const { docs } = await importFile("credit_card_no_balance_sept_2026.csv", "checking");
    assert.equal(docs.find((d) => /STARBUCKS/.test(d.merchant)).amount, 6.45);
  });

  test("checking statements are unchanged: no transfers among ordinary bills and paychecks", async () => {
    const { docs } = await importFile("checking_sept_2026.csv", "checking");
    assert.equal(docs.length, 36);
    assert.ok(docs.every((d) => d.category === "uncategorized"));
  });
});
