/**
 * pdfParser.js (SCRUM-25)
 *
 * Turns a text-based bank-statement PDF into the same transactions the CSV
 * parser produces, so the rest of the import pipeline doesn't care which one
 * it got:
 *
 *   { transactions: [{ date, merchant, amount, rowNumber }],
 *     errors: [{ row, reason }], errorCount, totalRows, meta }
 *
 * How it works (two steps, so most of it can be tested without a real PDF):
 *   1. extractLines(buffer)  uses pdf.js to pull out every piece of text with its
 *      position on the page, and groups the pieces into lines, top to bottom.
 *   2. parseLines(lines)     turns those lines into transactions. Pure function.
 *
 * PDFs don't have columns or rows, only text placed at coordinates, and every
 * bank lays its statement out differently. So nothing here is hardcoded to
 * one bank. parseLines:
 *   - finds the table header ("Date  Description  Amount  Balance", or
 *     "Date  Description  Withdrawals  Deposits  Balance") and uses where each
 *     header word sits to decide which column an amount belongs to
 *   - treats any line that starts with a date as a transaction
 *   - reads dates with or without a year (the year comes from the statement
 *     period printed at the top)
 *   - works out income vs spending from the column (Withdrawals / Deposits),
 *     from the sign (-45.00, (45.00), 45.00 DR), or, when amounts are unsigned
 *     and there is a Balance column, from how the balance moved
 *   - skips balance lines, totals, headers and footers
 *   - never stops on one bad row: bad rows go in `errors`, good rows still parse
 *
 * Scanned / photographed statements have no text in them, so they can't be
 * read here (that would need OCR). They fail with a clear "unsupported PDF"
 * message instead of importing nothing.
 *
 * Account numbers: any run of 8+ digits (also when written in groups, like
 * "0012 4521 3788") is masked to "••••3788" in everything this returns, and
 * only the last 4 digits of the statement's own account number are reported
 * (meta.accountLast4).
 *
 * Output convention (matches the data model): amount < 0 = spending,
 * amount > 0 = income.
 *
 * Usage:
 *   const { parseStatementPdf } = require("./lib/pdfParser");
 *   const { transactions, errors, errorCount } = await parseStatementPdf(fileBuffer);
 */
"use strict";

const { StatementParseError, parseDate, parseMoney } = require("./csvParser");

// --- Limits ----------------------------------------------------------------
const MAX_PAGES = 100; // a monthly statement is a handful of pages
const MAX_DATA_ROWS = 10000;
const MAX_REPORTED_ERRORS = 100;
const LINE_TOLERANCE = 3; // text whose baselines are within this many points is one line
const MIN_TEXT_CHARS = 20; // fewer characters than this in the whole PDF = a scan

// --- User-facing messages --------------------------------------------------
const MSG_SCANNED =
  "This PDF looks like a scan or photo of a statement, so we can't read it (unsupported PDF). " +
  "Please download the statement as a PDF directly from your bank's website, or export a CSV instead.";
const MSG_NO_TRANSACTIONS =
  "We found text in this PDF but couldn't recognize any transactions in it. " +
  "This statement's layout isn't supported yet. Please export a CSV from your bank instead.";
const MSG_UNREADABLE = "We couldn't open this PDF. It may be damaged. Try downloading it again, or export a CSV instead.";
const MSG_PASSWORD = "This PDF is password-protected. Please remove the password (or download an unprotected copy) and try again.";

// ===========================================================================
// Step 1: PDF -> lines of positioned text
// ===========================================================================

let pdfjsPromise = null;
/** Loads pdf.js on first use. It is an ES module, so a CommonJS file loads it with import(). */
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

/**
 * Groups loose text pieces ({str, x, y, width}) into lines, top to bottom,
 * each line's pieces left to right.
 * @returns {{ items: {str:string, x:number, width:number}[] }[]}
 */
function groupIntoLines(pieces) {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - p.y) <= LINE_TOLERANCE) line.items.push(p);
    else lines.push({ y: p.y, items: [p] });
  }
  return lines.map((l) => ({
    items: l.items.sort((a, b) => a.x - b.x).map(({ str, x, width }) => ({ str, x, width })),
  }));
}

/**
 * Reads a PDF and returns its text as lines (all pages, in order).
 * Throws StatementParseError for PDFs we can't open or that contain no text.
 */
async function extractLines(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 0) throw new StatementParseError("empty_file", "This file is empty.");

  const pdfjs = await loadPdfjs();
  // pdf.js takes ownership of the bytes it is given, so hand it a copy
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    if (err && err.name === "PasswordException") throw new StatementParseError("pdf_password", MSG_PASSWORD);
    throw new StatementParseError("pdf_unreadable", MSG_UNREADABLE);
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new StatementParseError(
        "too_many_pages",
        `This PDF has more than ${MAX_PAGES} pages. Try importing one statement period at a time.`
      );
    }
    const lines = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pieces = [];
      for (const it of content.items) {
        if (typeof it.str !== "string" || it.str.trim() === "") continue;
        chars += it.str.replace(/\s/g, "").length;
        pieces.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width });
      }
      lines.push(...groupIntoLines(pieces));
      page.cleanup();
    }
    if (chars < MIN_TEXT_CHARS) throw new StatementParseError("scanned_pdf", MSG_SCANNED);
    return lines;
  } catch (err) {
    if (err instanceof StatementParseError) throw err;
    throw new StatementParseError("pdf_unreadable", MSG_UNREADABLE);
  } finally {
    await task.destroy().catch(() => {}); // frees the PDF's memory
  }
}

// ===========================================================================
// Step 2: lines -> transactions
// ===========================================================================

const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONEY_WORD = /^[-+−(]*\$?[-−]?\d[\d,]*\.\d{2}\)?-?(?:CR|DR)?$/i;

/** Splits a line's text pieces into words, each with an x position. */
function wordsOf(line) {
  const words = [];
  for (const item of line.items) {
    // If a PDF puts a whole line in one piece, estimate each word's position from its character offset
    const charWidth = item.str.length ? item.width / item.str.length : 0;
    for (const m of item.str.matchAll(/\S+/g)) {
      const x = item.x + m.index * charWidth;
      words.push({ text: m[0], x, xEnd: x + m[0].length * charWidth });
    }
  }
  // "45.00 CR" / "45.00 DR" printed as two words become one
  for (let i = words.length - 2; i >= 0; i--) {
    if (/^(CR|DR)$/i.test(words[i + 1].text) && MONEY_WORD.test(words[i].text)) {
      words[i] = { text: words[i].text + words[i + 1].text, x: words[i].x, xEnd: words[i + 1].xEnd };
      words.splice(i + 1, 1);
    }
  }
  return words;
}

/**
 * If the words start with a date, returns { month, day, year|null, used } where
 * `used` is how many words the date takes. Otherwise null.
 */
function leadingDate(words) {
  const w = words[0]?.text ?? "";
  let m;
  if ((m = w.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { year: +m[1], month: +m[2], day: +m[3], used: 1 };
  if ((m = w.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/))) {
    return { year: m[3].length === 2 ? 2000 + +m[3] : +m[3], month: +m[1], day: +m[2], used: 1 };
  }
  if ((m = w.match(/^(\d{1,2})\/(\d{1,2})$/))) return { year: null, month: +m[1], day: +m[2], used: 1 };
  if (MONTH_WORD.test(w) && words[1] && /^\d{1,2},?$/.test(words[1].text)) {
    const month = MONTHS[w.slice(0, 3).toLowerCase()];
    const day = parseInt(words[1].text, 10);
    if (words[2] && /^\d{4}$/.test(words[2].text)) return { year: +words[2].text, month, day, used: 3 };
    return { year: null, month, day, used: 2 };
  }
  return null;
}

/** Statement period from the header text: { start: {y,m}, end: {y,m} } or just a year, or null. */
function findPeriod(lines) {
  const head = lines.slice(0, 40).map((l) => l.items.map((i) => i.str).join(" "));
  const text = head.join("\n");
  let m;
  // 09/01/2026 - 09/30/2026   (also "through", "to", "thru")
  if ((m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|–|to|through|thru)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i))) {
    return { start: { y: +m[3], m: +m[1] }, end: { y: +m[6], m: +m[4] } };
  }
  // September 1, 2026 through September 30, 2026   (also "Sep 1 - Sep 30, 2026")
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  const re = new RegExp(`${mon}\\s+\\d{1,2},?\\s*(\\d{4})?\\s*(?:-|–|to|through|thru)\\s*${mon}\\s+\\d{1,2},?\\s*(\\d{4})`, "i");
  if ((m = text.match(re))) {
    const endY = +m[4];
    const startM = MONTHS[m[1].toLowerCase()];
    const endM = MONTHS[m[3].toLowerCase()];
    const startY = m[2] ? +m[2] : startM > endM ? endY - 1 : endY;
    return { start: { y: startY, m: startM }, end: { y: endY, m: endM } };
  }
  // Last resort: the first plausible year anywhere in the header
  if ((m = text.match(/\b(20\d{2})\b/))) return { start: { y: +m[1], m: 1 }, end: { y: +m[1], m: 12 } };
  return null;
}

/** Picks the year for a date printed without one. */
function yearFor(month, period) {
  if (!period) return null;
  if (period.start.y === period.end.y) return period.start.y;
  return month >= period.start.m ? period.start.y : period.end.y; // e.g. a Dec-Jan statement
}

/** Last 4 digits of the statement's own account number, from lines like "Account Number: 0012 4521 3788" or "ending in 7732". */
function findAccountLast4(lines) {
  for (const l of lines.slice(0, 40)) {
    const text = l.items.map((i) => i.str).join(" ");
    let m = text.match(/(?:account|acct)[^\n]{0,25}?(?:number|no\.?|#)?[:\s#]*([0-9][0-9 -]{3,}[0-9])\s*$/i);
    if (m) return m[1].replace(/\D/g, "").slice(-4);
    m = text.match(/(?:ending(?:\s+in)?|x{2,}|\*{2,}|•{2,})\s*:?\s*(\d{4})\b/i);
    if (m) return m[1];
  }
  return null;
}

/** Masks anything that looks like an account or card number: 8+ digits, possibly grouped with spaces or dashes. */
function maskAccountNumbers(text) {
  return String(text).replace(/(?<![\d/.,])\d(?:[ -]?\d){7,}(?![\d/])/g, (run) =>
    /^\d{4}-\d{2}-\d{2}$/.test(run) ? run : `••••${run.replace(/\D/g, "").slice(-4)}` // leave ISO dates alone
  );
}

// --- Table header ----------------------------------------------------------

const HEADER_WORDS = [
  ["date", /^(date|posted|post)$/i],
  ["description", /^(description|details?|transaction|memo|payee|narrative|particulars)$/i],
  ["debit", /^(withdrawals?|debits?|withdrawn)$/i],
  ["credit", /^(deposits?|credits?|deposited)$/i],
  ["amount", /^amount$/i],
  ["balance", /^balance$/i],
];

/** If this line is a table header, returns its columns { amount?, debit?, credit?, balance? } with x positions; else null. */
function matchHeader(words) {
  const cols = {};
  for (const w of words) {
    const hit = HEADER_WORDS.find(([, re]) => re.test(w.text));
    if (hit && !cols[hit[0]]) cols[hit[0]] = { x: w.x, xEnd: w.xEnd, cx: (w.x + w.xEnd) / 2 };
  }
  const hasMoney = cols.amount || cols.debit || cols.credit;
  const hasLabel = cols.date || cols.description;
  return hasMoney && hasLabel ? cols : null;
}

/** Which header column a money word sits under: the one whose left edge, right edge or middle is closest. */
function columnFor(word, cols) {
  const cx = (word.x + word.xEnd) / 2;
  let best = null;
  let bestDist = Infinity;
  for (const name of ["amount", "debit", "credit", "balance"]) {
    const c = cols[name];
    if (!c) continue;
    const dist = Math.min(Math.abs(word.xEnd - c.xEnd), Math.abs(word.x - c.x), Math.abs(cx - c.cx));
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

// --- Main ------------------------------------------------------------------

/**
 * Turns the lines of a statement into transactions.
 * @param {{ items: {str:string, x:number, width:number}[] }[]} lines
 */
function parseLines(lines) {
  const period = findPeriod(lines);
  const accountLast4 = findAccountLast4(lines);

  const transactions = [];
  const errors = [];
  let errorCount = 0;
  let totalRows = 0;
  let cols = null; // current table header, if one has been seen
  let prevBalance = null; // balance after the previous row, used to work out signs
  let layout = "unknown";

  const fail = (row, reason) => {
    errorCount++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row, reason: maskAccountNumbers(reason) });
  };

  lines.forEach((line, idx) => {
    const row = idx + 1; // "Line N" in messages; also keeps transaction IDs unique across pages
    const words = wordsOf(line);
    if (words.length === 0) return;

    const header = matchHeader(words);
    if (header) {
      cols = header;
      layout = header.debit || header.credit ? "debit-credit columns" : "amount column";
      return;
    }

    // "Beginning Balance 2,500.00": remember it so the first row's sign can be checked
    const text = words.map((w) => w.text).join(" ");
    if (/\b(beginning|opening|previous|starting)\s+balance\b/i.test(text)) {
      const money = words.filter((w) => MONEY_WORD.test(w.text)).pop();
      if (money) prevBalance = Math.abs(parseMoney(money.text));
      return;
    }

    // A transaction row starts with a date
    const d = leadingDate(words);
    if (!d) return;
    let rest = words.slice(d.used);
    // Some banks print a posting date and a transaction date side by side; ignore the second
    const second = leadingDate(rest);
    if (second) rest = rest.slice(second.used);

    // Trailing money words are the amounts; whatever is between is the description
    let firstMoney = rest.length;
    while (firstMoney > 0 && MONEY_WORD.test(rest[firstMoney - 1].text)) firstMoney--;
    const moneyWords = rest.slice(firstMoney);
    const merchantRaw = rest.slice(0, firstMoney).map((w) => w.text).join(" ").trim();

    // "09/01/2026 - 09/30/2026" and similar header lines: not transactions
    if (merchantRaw === "" && moneyWords.length === 0) return;
    if (leadingDate(rest) || /^[-–]\s*\d{1,2}\//.test(merchantRaw)) return;

    totalRows++;
    const shown = words.slice(0, d.used).map((w) => w.text).join(" ");

    // Date
    const year = d.year ?? yearFor(d.month, period);
    if (year == null) {
      fail(row, `date "${shown}" has no year and the statement period couldn't be found`);
      return;
    }
    const date = parseDate(`${d.month}/${d.day}/${year}`);
    if (!date) {
      fail(row, `date "${shown}" isn't a valid date`);
      return;
    }

    // Which money word is the amount, and which (if any) is the balance
    let amountWord = null;
    let balanceWord = null;
    let columnSign = 0; // +1 deposit column, -1 withdrawal column, 0 = decide from the number itself
    if (cols && moneyWords.length) {
      for (const w of moneyWords) {
        const name = columnFor(w, cols);
        if (name === "balance") balanceWord = w;
        else if (!amountWord) {
          amountWord = w;
          columnSign = name === "debit" ? -1 : name === "credit" ? 1 : 0;
        }
      }
    } else if (moneyWords.length === 1) {
      amountWord = moneyWords[0];
    } else if (moneyWords.length >= 2) {
      // No header seen: assume "... amount balance"
      amountWord = moneyWords[moneyWords.length - 2];
      balanceWord = moneyWords[moneyWords.length - 1];
    }

    const balance = balanceWord ? Math.abs(parseMoney(balanceWord.text)) : null;

    // A date followed only by a balance ("Sep 30  Ending balance  4,545.14") is not a transaction
    if (!amountWord) {
      if (balance != null) {
        totalRows--;
        prevBalance = balance;
      } else {
        fail(row, `couldn't find an amount for "${maskAccountNumbers(merchantRaw)}"`);
      }
      return;
    }

    const printed = parseMoney(amountWord.text);
    if (Number.isNaN(printed)) {
      fail(row, `amount "${amountWord.text}" isn't a valid amount`);
      return;
    }
    if (merchantRaw === "") {
      fail(row, "missing description");
      return;
    }

    // Income vs spending
    let amount;
    if (columnSign !== 0) {
      amount = columnSign * Math.abs(printed);
    } else if (/[-−(]|DR$/i.test(amountWord.text) || /CR$/i.test(amountWord.text)) {
      amount = printed; // the number says which way it went: -45.00, (45.00), 45.00 DR, 45.00 CR
    } else if (balance != null && prevBalance != null && Math.abs(Math.abs(balance - prevBalance) - printed) < 0.015) {
      amount = balance - prevBalance > 0 ? printed : -printed; // unsigned: the balance moved up or down
    } else {
      amount = printed;
    }
    if (balance != null) prevBalance = balance;

    transactions.push({
      date,
      merchant: maskAccountNumbers(merchantRaw.replace(/\s+/g, " ")),
      amount: Math.round(amount * 100) / 100,
      rowNumber: row,
    });
  });

  if (transactions.length + errorCount > MAX_DATA_ROWS) {
    throw new StatementParseError(
      "too_many_rows",
      `This statement has more than ${MAX_DATA_ROWS.toLocaleString("en-US")} rows. Try importing one statement period at a time.`
    );
  }

  return {
    transactions,
    errors,
    errorCount,
    totalRows,
    meta: { source: "pdf", layout, accountLast4, periodStart: period?.start ?? null, periodEnd: period?.end ?? null },
  };
}

/**
 * Parses a bank-statement PDF.
 * @param {Buffer|Uint8Array} input  The PDF file
 * @returns {Promise<{transactions, errors, errorCount, totalRows, meta}>}
 * @throws {StatementParseError} with a user-facing message when the PDF can't be used at all
 */
async function parseStatementPdf(input) {
  const lines = await extractLines(input);
  const result = parseLines(lines);
  if (result.transactions.length === 0 && result.errorCount === 0) {
    throw new StatementParseError("no_transactions", MSG_NO_TRANSACTIONS);
  }
  return result;
}

module.exports = {
  parseStatementPdf,
  // exported for unit tests
  parseLines,
  extractLines,
  maskAccountNumbers,
  MSG_SCANNED,
  MSG_NO_TRANSACTIONS,
  MSG_UNREADABLE,
};
