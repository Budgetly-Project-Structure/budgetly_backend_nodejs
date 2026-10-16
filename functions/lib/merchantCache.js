/**
 * merchantCache.js (SCRUM-75)
 *
 * A per-user memory of the categories a user picked, so the same merchant never
 * needs the AI (or another correction) again.
 *
 *   users/{uid}/merchantCache/{docId}
 *     merchantKey         the cleaned-up merchant, e.g. "KWIK TRIP"
 *     category            the category the user chose for it
 *     categoryConfidence  1 (the user chose it)
 *     updatedAt           server timestamp
 *
 * How it's used:
 *   - When an import is saved, transactions that no rule categorized are looked up
 *     here first (importCategorization.js). A hit is saved with categorySource
 *     "cache" and no AI call is made for it.
 *   - When a user sets (or edits) a transaction's category, the
 *     onTransactionCategoryChanged function in index.js saves it here.
 *
 * The cache holds only what the user chose: AI guesses are never cached, so one
 * wrong guess can't spread. The browser can't read or write these docs (no
 * Firestore rule allows it); only the Cloud Functions do.
 *
 * merchantKey() and the plan/apply helpers are pure functions, and the Firestore
 * code takes `db` as a parameter, so everything here is unit tested without Firebase.
 */
"use strict";

const { isKnownCategory, UNCATEGORIZED } = require("./categories");

// Longest merchant key and number of words kept (statements add cities and store numbers)
const MAX_WORDS = 3;
const MAX_KEY_LENGTH = 60;
// getAll() reads this many cache docs per call
const LOOKUP_CHUNK = 100;

// Card processor prefixes in front of the real merchant: "SQ *BLUE BOTTLE", "TST* TACO JOHNS"
const PROCESSOR_PREFIX = /^(SQ|TST|PAYPAL|PP|SP)\s*\*\s*/;

/**
 * The part of a statement description that stays the same from visit to visit:
 * upper case, processor prefix removed, and every word containing a digit dropped
 * (store numbers, dates, phone numbers). Only the first few words are kept.
 *
 *   "KWIK TRIP #412"                 -> "KWIK TRIP"
 *   "Target T-1123"                  -> "TARGET"
 *   "SQ *BLUE BOTTLE COFFEE 0042"    -> "BLUE BOTTLE COFFEE"
 *
 * @returns {string} "" when nothing usable is left (such a merchant is never cached)
 */
function merchantKey(merchant) {
  const text = String(merchant ?? "")
    .toUpperCase()
    .replace(/'/g, "")
    .trim()
    .replace(PROCESSOR_PREFIX, "");
  const words = text
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length > 1 && !/\d/.test(w))
    .slice(0, MAX_WORDS);
  return words.join(" ").slice(0, MAX_KEY_LENGTH).trim();
}

/** Firestore document id for a key: lower case letters, digits and dashes only. */
function cacheDocId(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Applies cached categories to import documents. Only documents nothing has
 * categorized yet (categorySource "none") are touched, so a rule match or a
 * user's choice is never overwritten. Money out is never given "income".
 *
 * @param {Object[]} docs                          From toTransactionDocs
 * @param {Map<string, {category: string, categoryConfidence: number}>} cached  merchantKey -> cache entry
 * @returns {{docs: Object[], hits: number}}  new documents (the inputs aren't changed)
 */
function applyCache(docs, cached) {
  let hits = 0;
  const out = docs.map((d) => {
    if (d.categorySource !== "none") return d;
    const entry = cached.get(merchantKey(d.merchant));
    if (!entry || !isKnownCategory(entry.category) || entry.category === UNCATEGORIZED) return d;
    if (entry.category === "income" && !(d.amount > 0)) return d;
    hits++;
    return {
      ...d,
      category: entry.category,
      categoryConfidence: entry.categoryConfidence ?? 1,
      categorySource: "cache",
    };
  });
  return { docs: out, hits };
}

/**
 * Should a transaction write update the cache? True when the user has just chosen
 * a category: a new transaction that already has one (a manual entry), or a change
 * of category, or a transaction that wasn't user-categorized before.
 *
 * @param {Object|null} before  The document before the write (null when it was just created)
 * @param {Object|null} after   The document after the write (null when it was deleted)
 * @returns {{merchant: string, category: string}|null}  what to cache, or null
 */
function cacheUpdateFor(before, after) {
  if (!after || after.categorySource !== "user") return null;
  if (before && before.categorySource === "user" && before.category === after.category) return null;
  if (!isKnownCategory(after.category) || after.category === UNCATEGORIZED) return null;
  if (!merchantKey(after.merchant)) return null;
  return { merchant: after.merchant, category: after.category };
}

/** Loaded lazily so unit tests can run without firebase-admin. */
function defaultServerTimestamp() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

/**
 * The cache of one user, backed by Firestore.
 *
 * @param {Object} opts
 * @param {Object} opts.db   Firestore instance
 * @param {string} opts.uid
 * @param {() => any} [opts.serverTimestamp]  Override in tests
 * @returns {{lookup: (merchants: string[]) => Promise<Map>, save: (merchant: string, category: string) => Promise<boolean>}}
 */
function createMerchantCache({ db, uid, serverTimestamp = defaultServerTimestamp }) {
  const col = db.collection("users").doc(uid).collection("merchantCache");

  return {
    /**
     * Looks up the cache entries for some merchants (the raw descriptions).
     * @returns {Promise<Map<string, {category: string, categoryConfidence: number}>>} merchantKey -> entry
     */
    async lookup(merchants) {
      const ids = [...new Set(merchants.map(merchantKey).filter(Boolean).map(cacheDocId))];
      const found = new Map();
      for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
        const snaps = await db.getAll(...ids.slice(i, i + LOOKUP_CHUNK).map((id) => col.doc(id)));
        for (const snap of snaps) {
          if (!snap.exists) continue;
          const x = snap.data();
          if (x.merchantKey && typeof x.category === "string") {
            found.set(x.merchantKey, { category: x.category, categoryConfidence: x.categoryConfidence ?? 1 });
          }
        }
      }
      return found;
    },

    /** Remembers that this merchant is this category. Returns false if it isn't cacheable. */
    async save(merchant, category) {
      const key = merchantKey(merchant);
      if (!key || !isKnownCategory(category) || category === UNCATEGORIZED) return false;
      await col.doc(cacheDocId(key)).set({
        merchantKey: key,
        category,
        categoryConfidence: 1,
        updatedAt: serverTimestamp(),
      });
      return true;
    },
  };
}

module.exports = { merchantKey, cacheDocId, applyCache, cacheUpdateFor, createMerchantCache };
