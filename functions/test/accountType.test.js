/**
 * Tests for SCRUM-135: telling checking from credit card statements by their
 * content (accountType.js), on every statement file we have, and how the import
 * uses it (importPipeline.js).
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { detectAccountType } = require("../lib/accountType");
const { parseStatementCsv } = require("../lib/csvParser");
const { parseStatementPdf } = require("../lib/pdfParser");
const { processImport } = require("../lib/importPipeline");

const silentLogger = { info() {}, warn() {}, error() {} };
const FIXTURES = path.join(__dirname, "fixtures");
// The shared test statements in the CSCI475 folder (next to the repos)
const TEST_DATA = path.join(__dirname, "..", "..", "..", "test-data");

const parse = async (file) => {
  const buf = fs.readFileSync(file);
  return file.endsWith(".pdf") ? parseStatementPdf(buf) : parseStatementCsv(buf);
};

describe("detectAccountType on every statement file", () => {
  const expected = [
    [TEST_DATA, "chase_checking_oct_2026.csv", "checking"],
    [TEST_DATA, "checking_within_budget_oct_2026.csv", "checking"],
    [TEST_DATA, "checking_statement_oct_2026.pdf", "checking"],
    [FIXTURES, "checking_aug_2026.csv", "checking"],
    [FIXTURES, "checking_sept_2026.csv", "checking"],
    [FIXTURES, "messy.csv", "checking"],
    [FIXTURES, "bank_a_checking_sept_2026.pdf", "checking"],
    [FIXTURES, "bank_b_credit_union_sept_2026.pdf", "checking"],
    [FIXTURES, "credit_card_no_balance_sept_2026.csv", "credit"],
    [FIXTURES, "credit_card_signed_aug_2026.csv", "credit"],
  ];
  for (const [dir, name, type] of expected) {
    // The test-data folder lives outside the repo; skip those files if it isn't there
    const file = path.join(dir, name);
    test(`${name} -> ${type}`, { skip: !fs.existsSync(file) && "test-data folder not found" }, async () => {
      const result = detectAccountType(await parse(file));
      assert.equal(result.type, type, `reasons: ${result.reasons.join(", ")}`);
      assert.ok(result.reasons.length > 0);
    });
  }
});

describe("detectAccountType clues", () => {
  const csv = (header, rows) => parseStatementCsv([header, ...rows].join("\n"));

  test("a Balance column means checking", () => {
    const p = csv("Date,Description,Amount,Balance", ["09/01/2026,Coffee,-4.00,96.00"]);
    assert.equal(detectAccountType(p).type, "checking");
  });

  test("a paycheck coming in means checking", () => {
    const p = csv("Date,Description,Amount", ["09/01/2026,ACME PAYROLL,1500.00", "09/02/2026,Coffee,-4.00"]);
    assert.equal(detectAccountType(p).type, "checking");
  });

  test("paying a card off means checking", () => {
    const p = csv("Date,Description,Amount", ["09/01/2026,CHASE CREDIT CRD AUTOPAY,-400.00", "09/02/2026,Coffee,-4.00"]);
    assert.equal(detectAccountType(p).type, "checking");
  });

  test("a payment - thank you coming in means credit card", () => {
    const p = csv("Date,Description,Amount", ["09/01/2026,PAYMENT - THANK YOU,400.00", "09/02/2026,Coffee,-4.00"]);
    assert.equal(detectAccountType(p).type, "credit");
  });

  test("mostly positive purchases in one Amount column means credit card", () => {
    const p = csv("Date,Description,Amount", ["09/01/2026,Coffee,4.00", "09/02/2026,Groceries,60.00", "09/03/2026,Refund,-5.00"]);
    assert.equal(detectAccountType(p).type, "credit");
  });

  test("no clues -> null (couldn't tell)", () => {
    const p = csv("Date,Description,Amount", ["09/01/2026,Coffee,-4.00", "09/02/2026,Groceries,-60.00"]);
    assert.deepEqual(detectAccountType(p), { type: null, reasons: [] });
  });

  test("mixed clues: the stronger side wins, a tie is null", () => {
    const tie = csv("Date,Description,Amount", ["09/01/2026,ACME PAYROLL,1500.00", "09/02/2026,PAYMENT - THANK YOU,200.00", "09/03/2026,Coffee,-4.00", "09/04/2026,Groceries,-60.00", "09/05/2026,Gas,-30.00"]);
    assert.equal(detectAccountType(tie).type, null);
    const bank = csv("Date,Description,Amount,Balance", ["09/01/2026,ACME PAYROLL,1500.00,1500", "09/02/2026,PAYMENT - THANK YOU,200.00,1700", "09/03/2026,Coffee,-4.00,1696", "09/04/2026,Groceries,-60.00,1636"]);
    assert.equal(detectAccountType(bank).type, "checking");
  });
});

describe("the import uses the detected type", () => {
  /** A store that remembers what the import wrote. */
  function memoryStore() {
    const s = { updates: [], saved: [] };
    s.update = async (patch) => s.updates.push(patch);
    s.writeTransactions = async (docs) => s.saved.push(...docs);
    s.deleteTransactions = async () => {};
    s.final = () => Object.assign({}, ...s.updates);
    return s;
  }
  const run = (name, picked = {}) => {
    const store = memoryStore();
    return processImport({
      fileBuffer: fs.readFileSync(path.join(FIXTURES, name)),
      fileType: name.split(".").pop(),
      uid: "alice",
      importId: "imp1",
      store,
      logger: silentLogger,
      ...picked,
    }).then(() => store);
  };

  test("nothing picked: a card CSV is detected as credit, filed under the card, and purchases saved as spending", async () => {
    const store = await run("credit_card_no_balance_sept_2026.csv");
    assert.equal(store.final().status, "completed");
    assert.equal(store.final().detectedAccountType, "credit");
    assert.equal(store.final().accountType, "credit");
    assert.equal(store.final().accountId, "acct-credit");
    // Purchases were positive in the file; read as a card statement they become spending
    const amazon = store.saved.find((t) => t.merchant.startsWith("AMAZON.COM*"));
    assert.ok(amazon.amount < 0, `amazon amount ${amazon.amount}`);
    assert.ok(store.saved.every((t) => t.accountId === "acct-credit"));
  });

  test("nothing picked: a checking CSV is detected as checking and filed under checking", async () => {
    const store = await run("checking_sept_2026.csv");
    assert.equal(store.final().detectedAccountType, "checking");
    assert.equal(store.final().accountId, "acct-checking");
  });

  test("what the user picked always wins; the detected type is still recorded", async () => {
    const store = await run("credit_card_no_balance_sept_2026.csv", { accountId: "acct-checking", accountType: "checking" });
    assert.equal(store.final().accountType, "checking");
    assert.equal(store.final().accountId, "acct-checking");
    assert.equal(store.final().detectedAccountType, "credit");
  });

  test("couldn't tell and nothing picked: no account type, read as before", async () => {
    const store = memoryStore();
    await processImport({
      fileBuffer: Buffer.from("Date,Description,Amount\n09/01/2026,Coffee,-4.00\n"),
      fileType: "csv",
      uid: "alice",
      importId: "imp1",
      store,
      logger: silentLogger,
    });
    assert.equal(store.final().status, "completed");
    assert.equal(store.final().detectedAccountType, null);
    assert.equal(store.final().accountType, null);
    assert.equal(store.final().accountId, null);
  });
});
