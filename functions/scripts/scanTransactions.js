/**
 * scanTransactions.js (SCRUM-119)
 *
 * Admin scan across ALL users' transactions, for spotting problems an admin
 * should look at. It only reads: it never writes, changes or deletes anything.
 *
 * Flags:
 *   duplicate  the same user has more than one transaction with the same date,
 *              merchant and amount (the first one is kept as the "original",
 *              every extra one is flagged)
 *   large      the amount (spent or received) is at or above --threshold
 *              (default $5,000)
 * Soft-deleted transactions are skipped.
 *
 * This is why transactions live in one top-level collection (SCRUM-109): one
 * query reads every user's transactions. The Admin SDK skips the security rules,
 * so only someone with the project's admin credentials can run it, and only from
 * their own machine. The app can't do this, because the rules only ever let a
 * user read their own transactions.
 *
 * Usage (from budgetly_backend_nodejs/functions):
 *   node scripts/scanTransactions.js --project budgetly-backend-nodejs [--threshold 5000]
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
 * Against the real project: same sign-in as migrateTransactions.js
 * (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS).
 */
"use strict";

// Documents read per page
const PAGE_SIZE = 500;
const DEFAULT_THRESHOLD = 5000;

/** The calendar day of a Firestore Timestamp, a Date or a "YYYY-MM-DD" string. */
function dayOf(date) {
  if (date == null) return "";
  if (typeof date === "string") return date.slice(0, 10);
  const d = typeof date.toDate === "function" ? date.toDate() : date;
  return d instanceof Date ? d.toISOString().slice(0, 10) : "";
}

/** Same user + same day + same merchant (ignoring case and extra spaces) + same amount. */
function duplicateKeyOf(t) {
  const merchant = String(t.merchant ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return [t.userId, dayOf(t.date), merchant, Number(t.amount)].join("|");
}

/**
 * Checks a list of transactions. Pure function, so it's easy to test.
 * @param {{id: string, userId: string, date: any, merchant: string, amount: number, deletedAt?: any}[]} txns
 * @param {{threshold?: number}} [opts]
 * @returns {{userId: string, transactionId: string, reason: string}[]}
 */
function findFlags(txns, { threshold = DEFAULT_THRESHOLD } = {}) {
  const flags = [];
  const firstSeen = new Map(); // duplicate key -> id of the first transaction with it
  for (const t of txns) {
    if (t.deletedAt != null) continue;
    const key = duplicateKeyOf(t);
    if (firstSeen.has(key)) {
      flags.push({ userId: t.userId, transactionId: t.id, reason: `duplicate of ${firstSeen.get(key)} (${dayOf(t.date)}, ${t.merchant}, ${t.amount})` });
    } else {
      firstSeen.set(key, t.id);
    }
    if (Math.abs(Number(t.amount)) >= threshold) {
      flags.push({ userId: t.userId, transactionId: t.id, reason: `large amount ${t.amount} (threshold ${threshold})` });
    }
  }
  return flags;
}

/**
 * Reads every transaction, page by page in document-ID order, then checks them.
 * Only get() is used: nothing is written.
 * @returns {Promise<{scanned: number, users: number, flags: Object[]}>}
 */
async function scanTransactions({ db, threshold = DEFAULT_THRESHOLD, pageSize = PAGE_SIZE }) {
  const txns = [];
  let last = null;
  for (;;) {
    let q = db.collection("transactions").orderBy("__name__").limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) txns.push({ id: d.id, ...d.data() });
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return {
    scanned: txns.length,
    users: new Set(txns.map((t) => t.userId)).size,
    flags: findFlags(txns, { threshold }),
  };
}

/** Prints the report as a table. */
function printReport({ scanned, users, flags }, log = console.log) {
  log(`Scanned ${scanned} transactions from ${users} users. ${flags.length} flagged.\n`);
  if (flags.length === 0) return;
  log("userId                        transactionId                             reason");
  for (const f of flags) log(`${f.userId.padEnd(29)} ${f.transactionId.padEnd(41)} ${f.reason}`);
}

module.exports = { scanTransactions, findFlags, printReport, DEFAULT_THRESHOLD };

// --- Command line ------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const projectId = arg("--project") ?? process.env.GCLOUD_PROJECT;
  const threshold = arg("--threshold") !== undefined ? Number(arg("--threshold")) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    console.error("--threshold must be a positive number");
    process.exit(1);
  }

  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  initializeApp(projectId ? { projectId } : undefined);

  console.log(`Project: ${projectId ?? "(default)"}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""} | read-only scan`);
  scanTransactions({ db: getFirestore(), threshold })
    .then((result) => printReport(result))
    .catch((err) => {
      console.error("Scan failed:", err.message);
      process.exitCode = 1;
    });
}
