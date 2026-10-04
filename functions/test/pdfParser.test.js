/**
 * Tests for SCRUM-25: lib/pdfParser.js
 * Uses three sample PDFs in test/fixtures (made by generate_sample_pdfs.py):
 *   bank_a_checking_sept_2026.pdf       one signed Amount column + Balance, 2 pages
 *   bank_b_credit_union_sept_2026.pdf   Withdrawals / Deposits columns, dates with no year
 *   scanned_statement.pdf               a picture only, no text
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseStatementCsv, StatementParseError } = require("../lib/csvParser");
const { parseStatementPdf, parseLines, maskAccountNumbers, MSG_SCANNED } = require("../lib/pdfParser");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));

/** Builds parser input from plain strings, one text piece per line (the "whole line in one piece" case). */
const linesOf = (...strings) => strings.map((s) => ({ items: [{ str: s, x: 0, width: s.length * 5 }] }));
const parse = (...strings) => parseLines(linesOf(...strings));
const simple = (r) => r.transactions.map(({ date, merchant, amount }) => ({ date, merchant, amount }));

// ---------------------------------------------------------------------------
describe("sample PDF 1: signed Amount column with Balance (2 pages)", () => {
  test("extracts date, description and amount for every row", async () => {
    const r = await parseStatementPdf(fixture("bank_a_checking_sept_2026.pdf"));
    assert.equal(r.errorCount, 0);
    assert.equal(r.transactions.length, 37); // 36 rows from the CSV + 1 extra transfer
    assert.deepEqual(r.transactions[0], { date: "2026-09-01", merchant: "ACME CORP PAYROLL", amount: 1850, rowNumber: r.transactions[0].rowNumber });
    assert.equal(r.meta.layout, "amount column");
  });

  test("gives the same transactions as the CSV parser does for the same statement", async () => {
    const fromPdf = await parseStatementPdf(fixture("bank_a_checking_sept_2026.pdf"));
    const fromCsv = parseStatementCsv(fixture("checking_sept_2026.csv"));
    assert.deepEqual(simple(fromPdf).slice(0, 36), simple(fromCsv));
  });

  test("returns the same structure as the CSV parser", async () => {
    const fromPdf = await parseStatementPdf(fixture("bank_a_checking_sept_2026.pdf"));
    const fromCsv = parseStatementCsv(fixture("checking_sept_2026.csv"));
    for (const key of ["transactions", "errors", "errorCount", "totalRows", "meta"]) assert.ok(key in fromPdf, key);
    assert.deepEqual(Object.keys(fromPdf.transactions[0]).sort(), Object.keys(fromCsv.transactions[0]).sort());
    assert.equal(typeof fromPdf.transactions[0].rowNumber, "number");
  });

  test("rows from page 2 are read, and row numbers are unique across pages", async () => {
    const r = await parseStatementPdf(fixture("bank_a_checking_sept_2026.pdf"));
    assert.equal(r.transactions.at(-1).merchant.startsWith("Transfer to Savings"), true);
    assert.equal(new Set(r.transactions.map((t) => t.rowNumber)).size, r.transactions.length);
  });

  test("account numbers are masked", async () => {
    const r = await parseStatementPdf(fixture("bank_a_checking_sept_2026.pdf"));
    assert.equal(r.transactions.at(-1).merchant, "Transfer to Savings ••••4321");
    assert.equal(r.meta.accountLast4, "3788");
    // nothing that looks like a full account number is left anywhere in the result
    assert.doesNotMatch(JSON.stringify(r), /\d{8}/);
    assert.doesNotMatch(JSON.stringify(r), /4521 3788|000987654321/);
  });
});

describe("sample PDF 2: Withdrawals / Deposits columns, dates without a year", () => {
  test("reads the year from the statement period and income vs spending from the column", async () => {
    const r = await parseStatementPdf(fixture("bank_b_credit_union_sept_2026.pdf"));
    assert.equal(r.errorCount, 0);
    assert.equal(r.transactions.length, 11);
    assert.equal(r.meta.layout, "debit-credit columns");
    assert.deepEqual(simple(r)[0], { date: "2026-09-01", merchant: "ACME CORP PAYROLL", amount: 1850 });
    assert.deepEqual(simple(r)[1], { date: "2026-09-02", merchant: "Hy-Vee Grocery", amount: -96.42 });
    assert.deepEqual(simple(r)[3], { date: "2026-09-05", merchant: "Venmo Cashout", amount: 40 });
    assert.deepEqual(simple(r).at(-1), { date: "2026-09-28", merchant: "Interest Paid", amount: 0.84 });
  });

  test("the Balance column is not mistaken for an amount, and the totals line is skipped", async () => {
    const r = await parseStatementPdf(fixture("bank_b_credit_union_sept_2026.pdf"));
    const sum = r.transactions.reduce((s, t) => s + t.amount, 0);
    assert.equal(Math.round(sum * 100) / 100, 3345.14); // deposits 3,740.84 minus withdrawals 395.70
    assert.ok(r.transactions.every((t) => !/total/i.test(t.merchant)));
    assert.equal(r.meta.accountLast4, "7732");
  });
});

describe("PDFs that can't be read", () => {
  test("a scanned / image-only PDF fails with a clear 'unsupported PDF' message", async () => {
    await assert.rejects(
      () => parseStatementPdf(fixture("scanned_statement.pdf")),
      (err) => err instanceof StatementParseError && err.code === "scanned_pdf" && err.message === MSG_SCANNED && /unsupported PDF/.test(err.message)
    );
  });

  test("a PDF with text but no transactions says the layout isn't supported", async () => {
    await assert.rejects(
      () => parseStatementPdf(fixture("not_a_statement.pdf")),
      (err) => err.code === "no_transactions" && /layout isn't supported/.test(err.message)
    );
  });

  test("a damaged file fails with a readable message", async () => {
    await assert.rejects(
      () => parseStatementPdf(Buffer.from("this is not a pdf at all")),
      (err) => err.code === "pdf_unreadable" && /couldn't open this PDF/.test(err.message)
    );
  });

  test("an empty file fails", async () => {
    await assert.rejects(() => parseStatementPdf(Buffer.alloc(0)), (err) => err.code === "empty_file");
  });
});

// ---------------------------------------------------------------------------
describe("parseLines: layouts and formats", () => {
  test("signs can be -45.00, (45.00), 45.00 DR or 45.00 CR", () => {
    const r = parse(
      "Date Description Amount",
      "09/01/2026 Coffee -4.50",
      "09/02/2026 Groceries (52.10)",
      "09/03/2026 Gas 30.00 DR",
      "09/04/2026 Refund 12.00 CR",
      "09/05/2026 Paycheck $1,200.00"
    );
    assert.deepEqual(r.transactions.map((t) => t.amount), [-4.5, -52.1, -30, 12, 1200]);
  });

  test("unsigned amounts use how the running balance moved", () => {
    const r = parse(
      "Date Description Amount Balance",
      "Beginning Balance 1,000.00",
      "09/01/2026 Coffee 4.50 995.50",
      "09/02/2026 Paycheck 1,200.00 2,195.50",
      "09/03/2026 Rent 900.00 1,295.50"
    );
    assert.deepEqual(r.transactions.map((t) => t.amount), [-4.5, 1200, -900]);
  });

  test("dates without a year use the statement period, including across New Year", () => {
    const r = parse(
      "Statement Period: Dec 15, 2026 - Jan 14, 2027",
      "Date Description Amount",
      "12/20 Gift shop -30.00",
      "01/05 Refund 12.00"
    );
    assert.deepEqual(r.transactions.map((t) => t.date), ["2026-12-20", "2027-01-05"]);
  });

  test("'Sep 05' style dates and two-date rows (posted + transaction date) work", () => {
    const r = parse(
      "Statement period: September 1, 2026 through September 30, 2026",
      "Posted Trans Description Amount",
      "Sep 05 Sep 04 Pharmacy -18.20",
      "Sep 06, 2026 Lunch -9.00"
    );
    assert.deepEqual(r.transactions.map((t) => [t.date, t.merchant]), [
      ["2026-09-05", "Pharmacy"],
      ["2026-09-06", "Lunch"],
    ]);
  });

  test("with no header row, the last number is taken as the balance when there are two", () => {
    const r = parse("09/01/2026 Coffee shop -4.50 995.50", "09/02/2026 Bakery -3.00 992.50");
    assert.deepEqual(r.transactions.map((t) => t.amount), [-4.5, -3]);
  });

  test("headers, balances, totals and period lines are not transactions", () => {
    const r = parse(
      "Statement Period: 09/01/2026 - 09/30/2026",
      "09/01/2026 - 09/30/2026",
      "Date Description Amount Balance",
      "Beginning Balance 500.00",
      "09/02/2026 Coffee -4.50 495.50",
      "09/30/2026 Ending Balance 495.50",
      "Total fees this period 0.00"
    );
    assert.equal(r.transactions.length, 1);
    assert.equal(r.errorCount, 0);
  });
});

describe("parseLines: partial failures", () => {
  test("a bad row is reported with its reason and the good rows are kept", () => {
    const r = parse(
      "Date Description Amount",
      "09/01/2026 Coffee -4.50",
      "13/45/2026 Broken row -1.00",
      "09/03/2026 Missing amount",
      "09/04/2026 Lunch -9.00"
    );
    assert.equal(r.transactions.length, 2);
    assert.equal(r.errorCount, 2);
    assert.match(r.errors[0].reason, /isn't a valid date/);
    assert.match(r.errors[1].reason, /couldn't find an amount for "Missing amount"/);
    assert.equal(r.totalRows, 4);
  });

  test("a date with no year and no statement period is reported, not guessed", () => {
    const r = parse("Date Description Amount", "09/01 Coffee -4.50");
    assert.equal(r.transactions.length, 0);
    assert.match(r.errors[0].reason, /has no year/);
  });
});

describe("maskAccountNumbers", () => {
  test("masks 8+ digit numbers, with or without grouping, keeping the last 4", () => {
    assert.equal(maskAccountNumbers("Acct 000987654321"), "Acct ••••4321");
    assert.equal(maskAccountNumbers("Card 4111 1111 1111 1111"), "Card ••••1111");
    assert.equal(maskAccountNumbers("Acct 0012-4521-3788 done"), "Acct ••••3788 done");
  });

  test("leaves dates, amounts and short store numbers alone", () => {
    for (const s of ["09/01/2026 Shell Oil 57442", "Hy-Vee 1,850.00", "SQ *MKT 4471", "2026-09-01", "Store #1234567"]) {
      assert.equal(maskAccountNumbers(s), s);
    }
  });
});
