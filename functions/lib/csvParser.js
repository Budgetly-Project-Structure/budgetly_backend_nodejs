/**
 * csvParser.js (SCRUM-24)
 *
 * Turns the text of a bank-statement CSV into clean transactions.
 * Pure function: no Firebase, no network. That keeps it easy to unit test
 * and lets SCRUM-26 (write to Firestore) and SCRUM-27 (partial failures)
 * build on its output.
 *
 * Banks all export CSVs differently, so nothing here is hardcoded to one
 * layout. The parser:
 *   - finds the header row (skips "Account: ..." lines above it)
 *   - maps columns by name (Date / Posting Date / Transaction Date, ...)
 *   - handles one signed Amount column OR separate Debit / Credit columns
 *   - accepts several date and money formats ($1,234.56, (45.00), 45.00-, ...)
 *   - never stops on one bad row: bad rows go in `errors`, good rows still parse
 *
 * Output convention (matches the data model): amount < 0 = spending,
 * amount > 0 = income.
 *
 * Usage:
 *   const { parseStatementCsv } = require("./lib/csvParser");
 *   const { transactions, errors, errorCount } = parseStatementCsv(fileBuffer);
 */
"use strict";

// --- Limits ----------------------------------------------------------------
const MAX_DATA_ROWS = 10000; // sanity cap; a monthly statement is nowhere near this
const MAX_REPORTED_ERRORS = 100; // keeps the import doc small even for a garbage file
const HEADER_SEARCH_ROWS = 25; // how far down we look for the header row

/**
 * Thrown when the whole file can't be used (empty, no header, broken quoting).
 * `message` is written for end users: it can be saved straight to the import
 * doc's `error` field and shown on the Import page.
 * `code` is for logs and tests.
 */
class StatementParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StatementParseError";
    this.code = code;
  }
}

// --- Column name aliases ---------------------------------------------------
// Header text is normalized first (lowercase, letters/digits only), so
// "Posting Date", "posting_date" and "POSTING DATE" all become "postingdate".
// Order matters: earlier aliases win when a file has several matching columns
// (e.g. prefer "Transaction Date" over "Post Date").
const ALIASES = {
  date: [
    "transactiondate", "transdate", "trandate", "date", "dateposted",
    "postingdate", "posteddate", "postdate", "bookingdate", "effectivedate",
  ],
  description: [
    "description", "merchant", "payee", "transactiondescription",
    "originaldescription", "name", "narrative", "memo",
  ],
  amount: ["amount", "transactionamount", "amt"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "moneyout", "paidout"],
  credit: ["credit", "credits", "deposit", "deposits", "moneyin", "paidin"],
  // Only used when amounts are unsigned (see resolveAmount)
  type: ["transactiontype", "type", "drcr", "debitcredit", "details"],
};

/** "Posting Date" -> "postingdate" */
function normalizeHeader(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Index of the first alias (in priority order) found in the header, or -1. */
function findColumn(normalizedHeader, aliases) {
  for (const alias of aliases) {
    const i = normalizedHeader.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

/** Maps field name -> column index for a header row, or null if it isn't one. */
function matchHeader(cells) {
  const norm = cells.map(normalizeHeader);
  const cols = {};
  for (const field of Object.keys(ALIASES)) cols[field] = findColumn(norm, ALIASES[field]);
  const hasMoney = cols.amount !== -1 || cols.debit !== -1 || cols.credit !== -1;
  if (cols.date === -1 || cols.description === -1 || !hasMoney) return null;
  return cols;
}

// --- Reading the file ------------------------------------------------------

/** Accepts a Buffer or string; returns text with any byte-order mark removed. */
function decodeInput(input) {
  if (typeof input === "string") return input.replace(/^\uFEFF/, "");
  if (!Buffer.isBuffer(input)) {
    throw new StatementParseError("bad_input", "We couldn't read this file.");
  }
  // Excel's "Unicode Text" export is UTF-16 with a BOM
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return input.toString("utf16le").replace(/^\uFEFF/, "");
  }
  return input.toString("utf8").replace(/^\uFEFF/, "");
}

/** Picks the delimiter (comma, semicolon or tab) used most outside quotes. */
function detectDelimiter(text) {
  const candidates = [",", ";", "\t"];
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 15; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c in counts) counts[c]++;
    else if (!inQuotes && c === "\n") lines++;
  }
  return candidates.reduce((best, d) => (counts[d] > counts[best] ? d : best), ",");
}

/**
 * Splits CSV text into rows of cells (RFC 4180 style: quoted fields may contain
 * delimiters, newlines and doubled quotes). Each row remembers the line it
 * started on, so error messages can point at the right line of the file.
 *
 * @returns {{line: number, cells: string[]}[]}
 */
function tokenize(text, delimiter) {
  const rows = [];
  let cells = [];
  let cell = "";
  let inQuotes = false;
  let line = 1; // current line in the file
  let rowLine = 1; // line the current row started on

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // "" -> literal quote
        else inQuotes = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"' && cell.trim() === "") {
      inQuotes = true; // opening quote (ignore spaces before it)
      cell = "";
    } else if (c === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++; // CRLF counts once
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = "";
      line++;
      rowLine = line;
    } else {
      cell += c;
    }
  }

  if (inQuotes) {
    throw new StatementParseError(
      "malformed_csv",
      `This file looks damaged: a quoted value starting near line ${rowLine} never closes. Try exporting it again.`
    );
  }
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows;
}

// --- Parsing individual values ---------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Builds "YYYY-MM-DD" if y/m/d form a real calendar date, else null. */
function toIsoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null; // catches typos like 0206 or 20266
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parses a date cell to "YYYY-MM-DD", or returns null if it isn't a valid date.
 * Slash dates are read US-style (MM/DD/YYYY), the format US banks use.
 * Accepts: 2026-09-05, 2026/9/5, 09/05/2026, 9/5/26, Sep 5, 2026, 5 Sep 2026
 */
function parseDate(raw) {
  const s = String(raw ?? "").trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/))) {
    return toIsoDate(+m[1], +m[2], +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?: .*)?$/))) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return toIsoDate(year, +m[1], +m[2]);
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? toIsoDate(+m[3], mon, +m[2]) : null;
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? toIsoDate(+m[3], mon, +m[1]) : null;
  }
  return null;
}

/**
 * Parses a money cell to a number (rounded to cents).
 * Returns null for an empty cell and NaN for something that isn't money.
 * Accepts: 45.00, -45.00, +45, $1,234.56, (45.00), 45.00-, 45.00 CR, 45.00 DR
 * CR counts as positive and DR as negative.
 */
function parseMoney(raw) {
  let s = String(raw ?? "").trim();
  if (s === "") return null;

  let negative = false;
  s = s.replace(/[\u2212\u2013\u2014]/g, "-"); // unicode minus / dashes -> "-"
  if (/\s*CR$/i.test(s)) s = s.replace(/\s*CR$/i, "");
  else if (/\s*DR$/i.test(s)) { negative = true; s = s.replace(/\s*DR$/i, ""); }
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  if (/^-/.test(s)) { negative = true; s = s.slice(1); }
  s = s.replace(/^\+/, "").replace(/[$€£\s]/g, "").replace(/,/g, "");

  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Math.round(parseFloat(s) * 100) / 100;
  return negative ? -n : n;
}

/** True if the cell shows an explicit minus sign, parentheses or DR. */
function hasExplicitSign(raw) {
  return /[-\u2212\u2013\u2014(]|\bDR$/i.test(String(raw ?? "").trim());
}

// --- Per-row logic ---------------------------------------------------------

/**
 * Works out the signed amount for one row.
 * Throws an Error with a user-readable reason if the row has no usable amount.
 */
function resolveAmount(cells, cols, ctx) {
  const get = (i) => (i === -1 ? "" : cells[i] ?? "");

  // Separate Debit / Credit columns: debit = money out, credit = money in
  if (cols.debit !== -1 || cols.credit !== -1) {
    const debit = parseMoney(get(cols.debit));
    const credit = parseMoney(get(cols.credit));
    if (Number.isNaN(debit) || Number.isNaN(credit)) throw new Error("amount isn't a valid number");
    const d = debit ? Math.abs(debit) : 0;
    const c = credit ? Math.abs(credit) : 0;
    if (d && c) throw new Error("row has both a debit and a credit");
    if (!d && !c) {
      // A $0.00 row is fine; a completely blank amount is not
      if (debit === 0 || credit === 0) return 0;
      throw new Error("missing amount");
    }
    return d ? -d : c;
  }

  // Single Amount column
  const raw = get(cols.amount);
  const n = parseMoney(raw);
  if (n === null) throw new Error("missing amount");
  if (Number.isNaN(n)) throw new Error(`amount "${String(raw).trim()}" isn't a valid number`);

  // Unsigned amounts + a Debit/Credit "type" column: use the type for the sign
  if (ctx.useTypeColumn) {
    const type = String(get(cols.type)).trim();
    if (/debit|^dr$|withdraw/i.test(type)) return -Math.abs(n);
    if (/credit|^cr$|deposit/i.test(type)) return Math.abs(n);
  }

  // Some credit cards export purchases as positive numbers
  return ctx.invertSigns ? -n : n;
}

// --- Main entry point ------------------------------------------------------

/**
 * Parses a bank-statement CSV.
 *
 * @param {Buffer|string} input  Raw file contents
 * @param {Object} [options]
 * @param {boolean} [options.invertSigns=false]
 *        Flip the sign of a single Amount column. Use for credit-card exports
 *        where purchases are positive (e.g. Amex, Discover).
 * @returns {{
 *   transactions: {date: string, merchant: string, amount: number, rowNumber: number}[],
 *   errors: {row: number, reason: string}[],
 *   errorCount: number,
 *   totalRows: number,
 *   meta: {delimiter: string, headerLine: number, columns: Object}
 * }}
 *   - `transactions`: valid rows. `date` is "YYYY-MM-DD"; `rowNumber` is the
 *     line in the original file.
 *   - `errors`: skipped rows (capped at 100 entries; `errorCount` is the true total).
 *   - `totalRows`: non-blank data rows seen = transactions.length + errorCount.
 * @throws {StatementParseError} when the file as a whole can't be used.
 */
function parseStatementCsv(input, options = {}) {
  const text = decodeInput(input);
  if (text.trim() === "") {
    throw new StatementParseError("empty_file", "This file is empty.");
  }
  if (text.includes("\u0000")) {
    throw new StatementParseError("not_text", "This doesn't look like a CSV file. Try exporting it again.");
  }

  const delimiter = detectDelimiter(text);
  const rows = tokenize(text, delimiter);

  // Find the header row (banks often put account info above it)
  let headerIndex = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    cols = matchHeader(rows[i].cells);
    if (cols) { headerIndex = i; break; }
  }
  if (headerIndex === -1) {
    throw new StatementParseError(
      "no_header",
      "We couldn't find the column headers. The file needs Date, Description and Amount columns (or Debit and Credit)."
    );
  }

  const headerCells = rows[headerIndex].cells;
  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((r) => r.cells.some((c) => c.trim() !== "")); // skip blank lines

  if (dataRows.length > MAX_DATA_ROWS) {
    throw new StatementParseError(
      "too_many_rows",
      `This file has more than ${MAX_DATA_ROWS.toLocaleString("en-US")} rows. Try importing one statement period at a time.`
    );
  }

  // If every amount is unsigned and there's a Debit/Credit type column,
  // the type column tells us which way the money moved.
  const singleAmount = cols.debit === -1 && cols.credit === -1;
  const ctx = {
    invertSigns: Boolean(options.invertSigns),
    useTypeColumn:
      singleAmount &&
      cols.type !== -1 &&
      !dataRows.some((r) => hasExplicitSign(r.cells[cols.amount])),
  };

  const transactions = [];
  const errors = [];
  let errorCount = 0;
  const fail = (row, reason) => {
    errorCount++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row, reason });
  };

  for (const { line, cells } of dataRows) {
    const dateRaw = String(cells[cols.date] ?? "").trim();
    const merchant = String(cells[cols.description] ?? "").replace(/\s+/g, " ").trim();

    const date = parseDate(dateRaw);
    if (!date) {
      fail(line, dateRaw === "" ? "missing date" : `date "${dateRaw}" isn't a valid date`);
      continue;
    }
    if (merchant === "") {
      fail(line, "missing description");
      continue;
    }

    let amount;
    try {
      amount = resolveAmount(cells, cols, ctx);
    } catch (err) {
      fail(line, err.message);
      continue;
    }
    transactions.push({ date, merchant, amount, rowNumber: line });
  }

  // Map field -> original header text, handy for debugging/logging
  const columns = {};
  for (const [field, i] of Object.entries(cols)) if (i !== -1) columns[field] = headerCells[i].trim();

  return {
    transactions,
    errors,
    errorCount,
    totalRows: dataRows.length,
    meta: { delimiter, headerLine: rows[headerIndex].line, columns },
  };
}

module.exports = {
  parseStatementCsv,
  StatementParseError,
  // exported for unit tests
  parseDate,
  parseMoney,
};
