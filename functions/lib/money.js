/**
 * money.js (Sprint 5 #6)
 *
 * Money is stored as whole cents (budgetly_contracts schemas/data-model.md, "Money is
 * stored in whole cents"): $12.34 spent is amountCents -1234. Integers add up and compare
 * exactly; dollar numbers don't (0.1 + 0.2 !== 0.3 in JavaScript).
 *
 *   parseCents(text)   statement text -> integer cents, read digit by digit (no float)
 *   centsOf(doc)       a saved transaction's cents, also for documents written before cents
 *   centsToDollars(c)  dollars, only for display, the AI prompt and the temporary `amount` field
 *
 * Pure functions: no Firebase, easy to unit test.
 */
"use strict";

/**
 * Reads a money value from statement text into integer cents, without going
 * through a dollar number: "1,234.56" -> 123456.
 * Returns null for an empty cell and NaN for something that isn't money.
 *
 * Accepts: 45.00, -45.00, +45, $1,234.56, (45.00), 45.00-, 45.00 CR, 45.00 DR, .5, 12.5
 * CR counts as positive and DR as negative. Unicode minus signs and dashes count as "-".
 * A third decimal is rounded half away from zero (12.345 -> 1235), which statements
 * shouldn't have anyway.
 *
 * @param {*} raw
 * @returns {number|null}  integer cents, null (empty) or NaN (not money)
 */
function parseCents(raw) {
  let s = String(raw ?? "").trim();
  if (s === "") return null;

  let negative = false;
  s = s.replace(/[−–—]/g, "-"); // unicode minus / dashes -> "-"
  if (/\s*CR$/i.test(s)) s = s.replace(/\s*CR$/i, "");
  else if (/\s*DR$/i.test(s)) { negative = true; s = s.replace(/\s*DR$/i, ""); }
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  if (/^-/.test(s)) { negative = true; s = s.slice(1); }
  s = s.replace(/^\+/, "").replace(/[$€£\s]/g, "").replace(/,/g, "");

  const m = s.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (m[1] === "" && !m[2])) return NaN; // needs at least one digit
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = (m[2] ?? "").padEnd(3, "0");
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1; // round half away from zero (the sign comes after)
  if (!Number.isSafeInteger(cents)) return NaN;
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * A saved transaction's amount in cents.
 *
 * TEMPORARY fallback: documents saved before Sprint 5 #6 (and manual transactions,
 * until the web app writes cents in #5/#7) only have `amount` in dollars, so this
 * rounds that to cents. Once the migration (#8) has given every document
 * amountCents, only the first branch is needed.
 *
 * @param {{amountCents?: number, amount?: number}} doc
 * @returns {number|null}  integer cents, or null when the document has no amount
 */
function centsOf(doc) {
  if (Number.isInteger(doc?.amountCents)) return doc.amountCents;
  if (typeof doc?.amount === "number" && Number.isFinite(doc.amount)) return Math.round(doc.amount * 100);
  return null;
}

/** Dollars for display: 123456 -> 1234.56. Never add these up; add cents. */
function centsToDollars(cents) {
  return cents / 100;
}

module.exports = { parseCents, centsOf, centsToDollars };
