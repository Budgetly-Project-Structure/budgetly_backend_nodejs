/**
 * duplicates.js (SCRUM-136)
 *
 * Skips transactions that were already imported from another statement.
 *
 * Statements often overlap: a September 1-30 statement and an "October" one that
 * starts on September 25 both list the last days of September. Each import gets its
 * own document IDs, so without this check those days would be saved twice and every
 * total would be wrong.
 *
 * Two transactions count as the same when they are on the same account and have the
 * same date, amount and merchant text. Real repeat purchases still work: if the
 * database already holds 2 coffees for $4.50 on a day and the new file lists 3, only
 * the third one is new.
 *
 * Pure functions with no Firebase code, so they are easy to unit test.
 */
"use strict";

/** "YYYY-MM-DD" for a JS Date or a Firestore Timestamp. */
function isoDay(date) {
  const d = typeof date?.toDate === "function" ? date.toDate() : date;
  return d.toISOString().slice(0, 10);
}

/**
 * The text two copies of the same transaction share: account, day, amount in cents
 * and the merchant (upper case, spaces collapsed).
 */
function duplicateKey({ accountId, date, amount, merchant }) {
  const cents = Math.round(Number(amount) * 100);
  const name = String(merchant ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  return `${accountId ?? ""}|${isoDay(date)}|${cents}|${name}`;
}

/**
 * Splits new transaction documents into the ones to save and the ones already in
 * the database.
 *
 * @param {Object[]} docs                   From toTransactionDocs (date is a JS Date)
 * @param {Map<string, number>} existing    duplicateKey -> how many are already saved
 * @returns {{fresh: Object[], duplicates: Object[]}}  both keep the file's row order
 */
function removeDuplicates(docs, existing) {
  const seen = new Map(); // how many of each key we've passed so far in this file
  const fresh = [];
  const duplicates = [];
  for (const doc of docs) {
    const key = duplicateKey(doc);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    // The first `existing` copies are the ones already saved; anything past that is new
    if (n <= (existing.get(key) ?? 0)) duplicates.push(doc);
    else fresh.push(doc);
  }
  return { fresh, duplicates };
}

module.exports = { duplicateKey, removeDuplicates, isoDay };
