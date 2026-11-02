/**
 * walkthroughDeleteLifecycle.js (SCRUM-128)
 *
 * Runs the whole life of an imported statement against the local emulators,
 * through the real Cloud Functions, and prints PASS/FAIL for every step:
 *
 *   1. upload a statement -> onStatementUploaded imports it into transactions/
 *   2. Delete (softDeleteImport) -> everything marked deleted, file kept, audit entry
 *   3. it shows in Recently deleted
 *   4. Restore (restoreImport) -> back to normal, audit entry
 *   5. another user can't see it or restore it
 *   6. Delete again, let 30 days pass, run the daily purge -> what really goes away
 *
 * It never touches the real project: everything runs on the "demo-budgetly"
 * emulators, which start empty and are thrown away afterwards.
 *
 * Run from budgetly_backend_nodejs/ (not functions/):
 *   firebase emulators:exec --only auth,firestore,storage,functions --project demo-budgetly "node functions/scripts/walkthroughDeleteLifecycle.js"
 * or, from functions/:  npm run walkthrough
 */
"use strict";

const path = require("path");
const fs = require("fs");

const PROJECT = "demo-budgetly";
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}`;
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const CSV = path.join(__dirname, "..", "test", "fixtures", "walkthrough-statement.csv");
const DAY = 24 * 60 * 60 * 1000;

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  console.error("Run this under the emulators (see the top of this file). It refuses to touch a real project.");
  process.exit(1);
}

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { runPurge } = require("../lib/purgeJob");
const { restoreImport } = require("../lib/restoreImport");
const { createStore } = require("../lib/firestoreStore");
const { createAuditWriter } = require("../lib/auditLog");

initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
const db = getFirestore();
const bucket = getStorage().bucket();

// --- Small helpers -------------------------------------------------------------
let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const step = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Creates a user in the Auth emulator; returns { uid, idToken }. */
async function signUp(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "walkthrough-only", returnSecureToken: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`signUp failed: ${JSON.stringify(body)}`);
  return { uid: body.localId, idToken: body.idToken };
}

/** Calls a callable function the way the web app's httpsCallable() does. */
async function call(name, data, idToken) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json();
  return body.error ? { error: body.error } : { result: body.result };
}

/** This user's transactions from one import, as { total, deleted, active }. */
async function txnCounts(uid, importId) {
  const snap = await db.collection("transactions").where("userId", "==", uid).where("sourceStatementId", "==", importId).get();
  const deleted = snap.docs.filter((d) => d.get("deletedAt") != null).length;
  return { total: snap.size, deleted, active: snap.size - deleted, docs: snap.docs };
}

async function auditActions(uid) {
  const snap = await db.collection("auditLog").where("userId", "==", uid).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis()).map((e) => `${e.action}(${e.details?.transactionCount})`);
}

const fileExists = async (p) => (await bucket.file(p).exists())[0];

// --- The walkthrough -------------------------------------------------------------
async function main() {
  console.log("Delete lifecycle walkthrough (SCRUM-128), on the demo-budgetly emulators");
  const alice = await signUp("alice@walkthrough.test");
  const bob = await signUp("bob@walkthrough.test");

  // 1. Upload ------------------------------------------------------------------------
  step("1. Alice uploads a statement; onStatementUploaded imports it");
  const storagePath = `users/${alice.uid}/imports/${Date.now()}_walkthrough.csv`;
  await bucket.upload(CSV, { destination: storagePath, metadata: { contentType: "text/csv", metadata: { accountId: "acct-checking", accountType: "checking" } } });

  let imp = null;
  for (let i = 0; i < 60; i++) {
    const snap = await db.collection(`users/${alice.uid}/imports`).where("storagePath", "==", storagePath).get();
    imp = snap.docs[0];
    if (imp && ["completed", "failed"].includes(imp.get("status"))) break;
    await sleep(500);
  }
  check(imp?.get("status") === "completed", "import finished", `status=${imp?.get("status")}`);
  const importId = imp.id;
  let c = await txnCounts(alice.uid, importId);
  const expected = fs.readFileSync(CSV, "utf8").trim().split("\n").length - 1;
  check(c.total === expected, `${expected} transactions saved in the top-level transactions/ collection`, `found ${c.total}`);
  check(c.docs.every((d) => d.get("userId") === alice.uid && d.get("deletedAt") === null), "each one has userId = alice and deletedAt = null");

  // 2. Delete ------------------------------------------------------------------------
  step("2. Alice deletes it (softDeleteImport)");
  const del = await call("softDeleteImport", { importId }, alice.idToken);
  check(del.result?.deletedTransactions === expected, "softDeleteImport succeeded", JSON.stringify(del.result ?? del.error));
  imp = await db.doc(`users/${alice.uid}/imports/${importId}`).get();
  check(imp.get("deletedAt") != null && imp.get("deletedBy") === alice.uid && imp.get("purgeAfter") != null, "import marked deleted (deletedAt, deletedBy = alice, purgeAfter)");
  const days = Math.round((imp.get("purgeAfter").toMillis() - imp.get("deletedAt").toMillis()) / DAY);
  check(days === 30, "purgeAfter is 30 days after deletedAt", `${days} days`);
  c = await txnCounts(alice.uid, importId);
  check(c.deleted === expected, "all its transactions marked deleted", `${c.deleted}/${c.total}`);
  check(c.total === expected, "nothing actually removed yet");
  check(await fileExists(storagePath), "the statement file is still in Storage");
  check((await auditActions(alice.uid)).join() === `import.deleted(${expected})`, "audit log has import.deleted", (await auditActions(alice.uid)).join(", "));

  // 3. Recently deleted --------------------------------------------------------------
  step("3. It shows in Recently deleted");
  const recentlyDeleted = (await db.collection(`users/${alice.uid}/imports`).get()).docs.filter((d) => d.get("deletedAt") != null);
  check(recentlyDeleted.some((d) => d.id === importId), "listed among alice's deleted statements");
  const active = (await db.collection("transactions").where("userId", "==", alice.uid).where("deletedAt", "==", null).get()).size;
  check(active === 0, "hidden from the transactions list and totals (no active transactions left)", `${active} active`);

  // 4. Restore -------------------------------------------------------------------------
  step("4. Alice restores it (restoreImport)");
  const res = await call("restoreImport", { importId }, alice.idToken);
  check(res.result?.restoredTransactions === expected, "restoreImport succeeded", JSON.stringify(res.result ?? res.error));
  imp = await db.doc(`users/${alice.uid}/imports/${importId}`).get();
  check(imp.get("deletedAt") === null && imp.get("deletedBy") === null && imp.get("purgeAfter") === null, "import's delete fields cleared");
  c = await txnCounts(alice.uid, importId);
  check(c.active === expected, "all transactions active again", `${c.active}/${c.total}`);
  check((await auditActions(alice.uid)).join() === `import.deleted(${expected}),import.restored(${expected})`, "audit log has import.restored", (await auditActions(alice.uid)).join(", "));

  // 5. Another user --------------------------------------------------------------------
  step("5. Bob can't touch it");
  const bobDel = await call("softDeleteImport", { importId, userId: alice.uid }, bob.idToken);
  check(bobDel.error?.status === "NOT_FOUND", "Bob deleting alice's statement (with userId = alice in the body) -> NOT_FOUND", bobDel.error?.status);
  await call("softDeleteImport", { importId }, alice.idToken); // alice deletes it again for the next checks
  const bobRes = await call("restoreImport", { importId, userId: alice.uid }, bob.idToken);
  check(bobRes.error?.status === "NOT_FOUND", "Bob restoring it -> NOT_FOUND", bobRes.error?.status);
  const anon = await call("restoreImport", { importId });
  check(anon.error?.status === "UNAUTHENTICATED", "no login -> UNAUTHENTICATED", anon.error?.status);
  check((await auditActions(bob.uid)).length === 0, "nothing in the audit log for bob");
  c = await txnCounts(alice.uid, importId);
  check(c.deleted === expected, "alice's statement is still deleted (Bob changed nothing)");

  // 6. 30 days later: purge ----------------------------------------------------------
  step("6. 30 days pass; the daily purge runs (purgeDeleted's runPurge, called directly)");
  const later = new Date(Date.now() + 31 * DAY);
  const tooLate = await restoreImport({
    uid: alice.uid,
    importId,
    openStore: (id) => createStore({ db, uid: alice.uid, importId: id }),
    writeAudit: createAuditWriter({ db }),
    now: () => later.getTime(),
    logger: { info() {}, warn() {}, error() {} },
  }).catch((e) => e);
  check(tooLate?.code === "failed-precondition", "restoring after 30 days is refused", tooLate?.message);
  const purged = await runPurge({ db, now: later, logger: { info() {}, warn() {}, error() {} } });
  check(purged.transactions === expected, `purge removed the ${expected} transactions`, JSON.stringify(purged));
  c = await txnCounts(alice.uid, importId);
  check(c.total === 0, "no transactions from that statement are left", `${c.total} left`);

  // What the purge does NOT do yet (reported, not checked as pass/fail)
  const impAfter = await db.doc(`users/${alice.uid}/imports/${importId}`).get();
  const fileAfter = await fileExists(storagePath);
  const auditAfter = await auditActions(alice.uid);
  console.log("\n  Known gaps after the purge (SCRUM-122, not built yet):");
  console.log(`    import record still there:     ${impAfter.exists ? "yes" : "no"}`);
  console.log(`    statement file still in Storage: ${fileAfter ? "yes" : "no"}`);
  console.log(`    audit entry for the purge:     ${auditAfter.some((a) => a.startsWith("import.purged")) ? "yes" : "no"}  (log: ${auditAfter.join(", ")})`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Walkthrough crashed:", err);
  process.exitCode = 1;
});
