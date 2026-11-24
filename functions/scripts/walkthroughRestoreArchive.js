/**
 * walkthroughRestoreArchive.js (SCRUM-157)
 *
 * Checks the archive and the restore script against the real Firebase code, on the local
 * emulators. It seeds a statement (with a file in Storage), two of its transactions, a
 * manual transaction, a budget and an account, all deleted more than 30 days ago, then:
 *
 *   1. runs the daily archive job (lib/purgeJob.js) and checks everything moved
 *   2. runs restoreFromArchive.js with --dry-run and checks nothing changed
 *   3. restores each record for real and checks it is back, active, with an audit entry
 *   4. checks the archive is empty and a second restore is refused
 *
 * It never touches the real project: everything runs on the "demo-budgetly" emulators,
 * which start empty and are thrown away afterwards.
 *
 * Run from budgetly_backend_nodejs/ (not functions/):
 *   firebase emulators:exec --only firestore,storage --project demo-budgetly "node functions/scripts/walkthroughRestoreArchive.js"
 */
"use strict";

const PROJECT = "demo-budgetly";
const DAY = 24 * 60 * 60 * 1000;

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  console.error("Run this under the emulators (see the top of this file). It refuses to touch a real project.");
  process.exit(1);
}

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { runArchive } = require("../lib/purgeJob");
const { createAuditWriter } = require("../lib/auditLog");
const { restoreFromArchive, RestoreError } = require("./restoreFromArchive");

initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
const db = getFirestore();
const bucket = getStorage().bucket();
const files = {
  exists: async (p) => (await bucket.file(p).exists())[0],
  copy: async (from, to) => { await bucket.file(from).copy(bucket.file(to)); },
  remove: async (p) => { await bucket.file(p).delete({ ignoreNotFound: true }); },
};
const writeAudit = createAuditWriter({ db });
const quiet = { info() {}, warn() {}, error() {} };

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const step = (title) => console.log(`\n${title}`);
const exists = async (path) => (await db.doc(path).get()).exists;
const count = async (collection) => (await db.collection(collection).get()).size;
const restore = (kind, id, extra = {}) => restoreFromArchive({ db, files, writeAudit, userId: "alice", kind, id, logger: quiet, ...extra });

const UID = "alice";
const IMPORT_ID = "imp1";
const FILE = `users/${UID}/imports/1700000000000_${IMPORT_ID}.csv`;
const gone = { deletedAt: Timestamp.fromMillis(Date.now() - 31 * DAY), deletedBy: UID, purgeAfter: Timestamp.fromMillis(Date.now() - DAY) };

(async () => {
  step("Setting up: a statement, its transactions, a manual transaction, a budget and an account, all deleted 31 days ago");
  await bucket.file(FILE).save("Date,Description,Amount\n2026-10-01,Coffee,-4.50\n");
  await db.doc(`users/${UID}/imports/${IMPORT_ID}`).set({ status: "completed", storagePath: FILE, accountId: "acct-checking", ...gone });
  await db.doc(`transactions/${UID}_${IMPORT_ID}_1`).set({ userId: UID, sourceStatementId: IMPORT_ID, source: "import", merchant: "Coffee", amountCents: -450, ...gone });
  await db.doc(`transactions/${UID}_${IMPORT_ID}_2`).set({ userId: UID, sourceStatementId: IMPORT_ID, source: "import", merchant: "Lunch", amountCents: -1250, ...gone });
  await db.doc("transactions/manual1").set({ userId: UID, source: "manual", merchant: "Farmers market", amountCents: -1234, ...gone });
  await db.doc(`users/${UID}/budgets/dining`).set({ limitCents: 25000, source: "user", ...gone });
  await db.doc("accounts/acc1").set({ userId: UID, type: "checking", institution: "Test Bank", last4: "1111", ...gone });
  const originalManual = (await db.doc("transactions/manual1").get()).data();

  step("1. The daily archive job moves everything");
  const result = await runArchive({ db, files, writeAudit, logger: quiet });
  check(result.imports === 1 && result.transactions === 1 && result.budgets === 1 && result.accounts === 1, "archived 1 statement, 1 manual transaction, 1 budget, 1 account", JSON.stringify(result));
  check(!(await exists(`users/${UID}/imports/${IMPORT_ID}`)), "the statement is gone from the live data");
  check(await exists(`archive_imports/${UID}_${IMPORT_ID}`), "the statement is in archive_imports");
  check((await count("archive_transactions")) === 3, "its 2 transactions and the manual one are in archive_transactions");
  check(await files.exists(`archive/${FILE}`), "the file is in archive/");
  check(!(await files.exists(FILE)), "the original file is gone");

  step("2. --dry-run changes nothing");
  const dry = await restore("import", IMPORT_ID, { dryRun: true });
  check(dry.dryRun === true && dry.details.transactions === 2, "reports 2 transactions to restore", JSON.stringify(dry.details));
  check(!(await exists(`users/${UID}/imports/${IMPORT_ID}`)) && (await count("archive_transactions")) === 3, "nothing was written");

  step("3. Restore each record for real");
  const r = await restore("import", IMPORT_ID);
  check(r.details.transactions === 2 && r.details.file === "moved back", "statement restored", JSON.stringify(r.details));
  const rec = (await db.doc(`users/${UID}/imports/${IMPORT_ID}`).get()).data();
  check(rec?.deletedAt === null && rec?.purgeAfter === null && rec?.archivedAt === undefined && rec?.userId === undefined, "the record is active, with no archive fields");
  check(await exists(`transactions/${UID}_${IMPORT_ID}_1`) && (await exists(`transactions/${UID}_${IMPORT_ID}_2`)), "both transactions are back");
  check((await files.exists(FILE)) && !(await files.exists(`archive/${FILE}`)), "the file is back and the archived copy is gone");

  await restore("transaction", "manual1");
  const manual = (await db.doc("transactions/manual1").get()).data();
  check(manual?.merchant === originalManual.merchant && manual?.amountCents === originalManual.amountCents && manual?.deletedAt === null, "the manual transaction is back, unchanged except it is active");
  await restore("budget", "dining");
  check((await db.doc(`users/${UID}/budgets/dining`).get()).data()?.limitCents === 25000, "the budget is back with its limit");
  await restore("account", "acc1");
  check((await db.doc("accounts/acc1").get()).data()?.last4 === "1111", "the account is back");

  step("4. The archive is empty, the audit log has the entries, and a second restore is refused");
  const left = (await count("archive_imports")) + (await count("archive_transactions")) + (await count("archive_budgets")) + (await count("archive_accounts"));
  check(left === 0, "nothing is left in the archive", `${left} left`);
  const actions = (await db.collection("auditLog").get()).docs.map((d) => d.data()).filter((e) => e.action.endsWith(".unarchived"));
  check(actions.length === 4 && actions.every((e) => e.actor === "admin"), "4 .unarchived audit entries, actor admin", actions.map((e) => e.action).join(", "));
  let refused = false;
  try { await restore("budget", "dining"); } catch (err) { refused = err instanceof RestoreError; }
  check(refused, "restoring something that isn't archived is refused");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error("Walkthrough crashed:", err);
  process.exitCode = 1;
});
