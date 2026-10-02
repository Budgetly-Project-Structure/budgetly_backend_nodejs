/**
 * Unit tests for lib/csvParser.js (SCRUM-24).
 * Run from the functions/ folder:  npm test   (uses Node's built-in test runner)
 *
 * Fixtures in test/fixtures/ are built from the app's mock transactions
 * (src/data/mockData.js) so they look like real statements.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseStatementCsv, StatementParseError, parseDate, parseMoney } = require("../lib/csvParser");

// How these tests are organized:
//   - three real-looking statement files in test/fixtures/ (signed Amount column,
//     Debit/Credit columns, and a deliberately messy file)
//   - small inline CSVs for other layouts and edge cases
//   - whole-file failures, size limits, then parseDate / parseMoney one value at a time
// Each describe() is a group; each test() is one check (63 in total).

// fixture("x.csv") reads a test file as a Buffer, like the Cloud Function will get it from Storage.
// sum() adds up amounts and rounds to cents, to compare with the known statement total.
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const sum = (txns) => Math.round(txns.reduce((s, t) => s + t.amount, 0) * 100) / 100;

describe("fixture: signed Amount column (checking_sept_2026.csv)", () => {
  const result = parseStatementCsv(fixture("checking_sept_2026.csv"));

  test("parses all 36 rows with no errors", () => {
    assert.equal(result.transactions.length, 36);
    assert.equal(result.errorCount, 0);
    assert.equal(result.totalRows, 36);
  });

  test("converts US dates to YYYY-MM-DD and keeps signs", () => {
    assert.deepEqual(result.transactions[0], {
      date: "2026-09-01",
      merchant: "ACME CORP PAYROLL",
      amount: 1850,
      rowNumber: 2,
    });
    const starbucks = result.transactions.find((t) => t.merchant === "Starbucks");
    assert.equal(starbucks.amount, -6.45);
  });

  test("totals match the source data", () => {
    assert.equal(sum(result.transactions), 2376.88);
  });

  test("reports which columns it used", () => {
    assert.deepEqual(result.meta.columns, { date: "Date", description: "Description", amount: "Amount" });
    assert.equal(result.meta.delimiter, ",");
    assert.equal(result.meta.headerLine, 1);
  });
});

describe("fixture: Debit / Credit columns (checking_aug_2026.csv)", () => {
  const result = parseStatementCsv(fixture("checking_aug_2026.csv"));

  test("parses all 21 rows", () => {
    assert.equal(result.transactions.length, 21);
    assert.equal(result.errorCount, 0);
  });

  test("debits become negative, credits positive", () => {
    const payroll = result.transactions.find((t) => t.merchant === "ACME CORP PAYROLL");
    const electric = result.transactions.find((t) => t.merchant === "Evergy Electric");
    assert.equal(payroll.amount, 1850);
    assert.equal(electric.amount, -102);
    assert.equal(sum(result.transactions), 2310.54);
  });

  test("prefers Transaction Date over Posted Date", () => {
    assert.equal(result.meta.columns.date, "Transaction Date");
  });
});

// messy.csv has: a byte-order mark, account info above the header, quoted commas
// and quotes, (24.50) and 15.49- amounts, a 2-digit year, a blank line, 4 bad rows,
// and a description split across two lines. 4 rows should parse and 4 should be reported.
describe("fixture: messy file (messy.csv)", () => {
  const result = parseStatementCsv(fixture("messy.csv"));

  test("skips the BOM and the account info above the header", () => {
    assert.equal(result.meta.headerLine, 4);
    assert.equal(result.meta.columns.date, "Posting Date");
  });

  test("keeps the good rows", () => {
    assert.equal(result.transactions.length, 4);
    assert.deepEqual(
      result.transactions.map((t) => [t.date, t.merchant, t.amount]),
      [
        ["2026-09-01", "ACME CORP, PAYROLL", 1850],
        ["2026-09-02", 'Joe\'s "Famous" Pizza', -24.5],
        ["2026-09-03", "Netflix", -15.49],
        ["2026-09-08", "Multi line memo", -9.99],
      ]
    );
  });

  test("reports each bad row with its line number and a reason", () => {
    assert.equal(result.errorCount, 4);
    assert.equal(result.totalRows, 8);
    assert.deepEqual(result.errors, [
      { row: 9, reason: 'date "13/45/2026" isn\'t a valid date' },
      { row: 10, reason: "missing description" },
      { row: 11, reason: 'amount "abc" isn\'t a valid number' },
      { row: 12, reason: "missing amount" },
    ]);
  });

  test("line numbers stay correct after a multi-line quoted field", () => {
    const withTrailingRow = Buffer.concat([fixture("messy.csv"), Buffer.from("09/09/2026,Oops,nope\r\n")]);
    const r = parseStatementCsv(withTrailingRow);
    // The multi-line row occupies lines 13-14, so the next row is on line 15
    assert.equal(r.errors.at(-1).row, 15);
  });
});

// Other bank export styles: different delimiters, encodings and ways of showing +/-
describe("other layouts", () => {
  test("semicolon-delimited", () => {
    const r = parseStatementCsv("Date;Description;Amount\n2026-09-01;Coffee;-4.50\n");
    assert.equal(r.meta.delimiter, ";");
    assert.deepEqual(r.transactions[0], { date: "2026-09-01", merchant: "Coffee", amount: -4.5, rowNumber: 2 });
  });

  test("tab-delimited", () => {
    const r = parseStatementCsv("Date\tDescription\tAmount\n2026-09-01\tCoffee\t-4.50\n");
    assert.equal(r.transactions.length, 1);
  });

  test("UTF-16 (Excel 'Unicode Text') files", () => {
    const text = "Date,Description,Amount\r\n09/01/2026,Coffee,-4.50\r\n";
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const r = parseStatementCsv(buf);
    assert.equal(r.transactions.length, 1);
    assert.equal(r.transactions[0].amount, -4.5);
  });

  test("works with a plain string and a last row with no trailing newline", () => {
    const r = parseStatementCsv("Date,Description,Amount\n2026-09-01,A,-1\n2026-09-02,B,-2");
    assert.equal(r.transactions.length, 2);
  });

  test("unsigned amounts + Type column: the type sets the sign", () => {
    const csv = [
      "Date,Description,Amount,Type",
      "09/01/2026,Payroll,1850.00,CREDIT",
      "09/02/2026,Coffee,4.50,DEBIT",
      "09/03/2026,ATM,60.00,Withdrawal",
    ].join("\n");
    const r = parseStatementCsv(csv);
    assert.deepEqual(r.transactions.map((t) => t.amount), [1850, -4.5, -60]);
  });

  test("a Type column is ignored when amounts already carry signs", () => {
    const csv = ["Date,Description,Amount,Type", "09/01/2026,Payroll,1850.00,ACH_CREDIT", "09/02/2026,Coffee,-4.50,DEBIT_CARD"].join("\n");
    const r = parseStatementCsv(csv);
    assert.deepEqual(r.transactions.map((t) => t.amount), [1850, -4.5]);
  });

  test("invertSigns flips credit-card exports where purchases are positive", () => {
    const csv = "Date,Description,Amount\n09/01/2026,Coffee,4.50\n09/02/2026,Payment,-200.00\n";
    const r = parseStatementCsv(csv, { invertSigns: true });
    assert.deepEqual(r.transactions.map((t) => t.amount), [-4.5, 200]);
  });

  test("row with both a debit and a credit is rejected", () => {
    const r = parseStatementCsv("Date,Description,Debit,Credit\n09/01/2026,Odd,5.00,5.00\n");
    assert.equal(r.transactions.length, 0);
    assert.equal(r.errors[0].reason, "row has both a debit and a credit");
  });

  test("zero-dollar rows are kept", () => {
    const r = parseStatementCsv("Date,Description,Amount\n09/01/2026,Fee waived,0.00\n");
    assert.equal(r.transactions[0].amount, 0);
  });
});

// Problems with the whole file stop the parse with a StatementParseError.
// expectCode() checks the error type, its code, and that it has a real message for the user.
describe("whole-file failures throw StatementParseError with a friendly message", () => {
  const expectCode = (input, code) =>
    assert.throws(
      () => parseStatementCsv(input),
      (err) => err instanceof StatementParseError && err.code === code && err.message.length > 10
    );

  test("empty file", () => expectCode("", "empty_file"));
  test("whitespace only", () => expectCode("  \r\n \n", "empty_file"));
  test("no recognizable header", () => expectCode("foo,bar\n1,2\n", "no_header"));
  test("header without an amount column", () => expectCode("Date,Description\n09/01/2026,Coffee\n", "no_header"));
  test("unterminated quote", () => expectCode('Date,Description,Amount\n09/01/2026,"Coffee,-4.50\n', "malformed_csv"));
  test("binary data", () => expectCode(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]), "not_text"));
});

// Safety caps so a huge or garbage file can't blow up the import record
describe("limits", () => {
  test("error list is capped at 100 but the true count is kept", () => {
    const bad = Array.from({ length: 150 }, () => "nope,Thing,-1").join("\n");
    const r = parseStatementCsv(`Date,Description,Amount\n${bad}\n`);
    assert.equal(r.errorCount, 150);
    assert.equal(r.errors.length, 100);
    assert.equal(r.transactions.length, 0);
  });

  test("too many rows is rejected", () => {
    const rows = Array.from({ length: 10001 }, () => "09/01/2026,X,-1").join("\n");
    assert.throws(() => parseStatementCsv(`Date,Description,Amount\n${rows}\n`), { code: "too_many_rows" });
  });
});

// Table-driven tests: each [input, expected] pair becomes its own test.
// null means "not a valid date".
describe("parseDate", () => {
  const cases = [
    ["2026-09-05", "2026-09-05"],
    ["2026/9/5", "2026-09-05"],
    ["09/05/2026", "2026-09-05"],
    ["9/5/26", "2026-09-05"],
    ["9-5-2026", "2026-09-05"],
    ["Sep 5, 2026", "2026-09-05"],
    ["September 5 2026", "2026-09-05"],
    ["5 Sep 2026", "2026-09-05"],
    ["2026-09-05T14:30:00Z", "2026-09-05"],
    ["02/29/2024", "2024-02-29"], // leap day
    ["02/29/2026", null], // not a leap year
    ["13/01/2026", null],
    ["09/31/2026", null],
    ["", null],
    ["yesterday", null],
    ["09/05/0206", null], // typo year
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" -> ${expected}`, () => assert.equal(parseDate(input), expected));
  }
});

// null = empty cell (missing amount); NaN = something that isn't money
describe("parseMoney", () => {
  const cases = [
    ["45.00", 45],
    ["-45.00", -45],
    ["+45", 45],
    ["$1,234.56", 1234.56],
    ["-$1,234.56", -1234.56],
    ["(45.00)", -45],
    ["45.00-", -45],
    ["\u221245.00", -45], // unicode minus
    ["45.00 DR", -45],
    ["45.00 CR", 45],
    [".5", 0.5],
    ["0.1", 0.1],
    ["19.999", 20],
    ["", null],
    ["   ", null],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" -> ${expected}`, () => assert.equal(parseMoney(input), expected));
  }
  for (const bad of ["abc", "12.34.56", "$", "1,2,x"]) {
    test(`"${bad}" -> NaN`, () => assert.ok(Number.isNaN(parseMoney(bad))));
  }
});
