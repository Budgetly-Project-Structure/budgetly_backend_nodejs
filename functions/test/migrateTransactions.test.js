/**
 * Tests for scripts/migrateTransactions.js (SCRUM-116).
 * No Firebase needed: the script gets the small in-memory fake below, which
 * supports only the Admin SDK calls the script makes.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { migrateTransactions, toNewDoc } = require("../scripts/migrateTransactions");

const silentLogger = { info() {}, warn() {}, error() {} };

/** A pretend Firestore: a Map of "path" -> data. */
function fakeDb(initial = {}) {
  const data = new Map(Object.entries(initial));
  const docRef = (path) => ({
    path,
    id: path.split("/").pop(),
    collection: (name) => colRef(`${path}/${name}`),
  });
  const snapOf = (ref) => ({ id: ref.id, ref, exists: data.has(ref.path), data: () => data.get(ref.path) });
  const colRef = (path) => ({
    doc: (id) => docRef(`${path}/${id}`),
    // Direct children only, like Firestore
    async get() {
      const depth = path.split("/").length + 1;
      const docs = [...data.keys()]
        .filter((k) => k.startsWith(`${path}/`) && k.split("/").length === depth)
        .map((k) => snapOf(docRef(k)));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
    // Every document id directly under this collection, even ones that only hold subcollections
    async listDocuments() {
      const ids = new Set([...data.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.split("/")[path.split("/").length]));
      return [...ids].map((id) => docRef(`${path}/${id}`));
    },
  });

  return {
    data,
    collection: colRef,
    async getAll(...refs) {
      return refs.map(snapOf);
    },
    batch() {
      const ops = [];
      return {
        create(ref, d) { ops.push(() => {
          if (data.has(ref.path)) throw new Error(`already exists: ${ref.path}`);
          data.set(ref.path, d);
        }); },
        delete(ref) { ops.push(() => data.delete(ref.path)); },
        async commit() { ops.forEach((op) => op()); },
      };
    },
  };
}

const imported = (extra = {}) => ({ date: "2026-10-01", merchant: "ALDI", amount: -20, sourceStatementId: "imp1", category: "groceries", ...extra });
const manual = (extra = {}) => ({ date: "2026-10-02", merchant: "Rent", amount: -900, source: "manual", sourceStatementId: null, ...extra });

describe("migrateTransactions", () => {
  test("copies each user's old transactions to transactions/{uid}_{oldId} with userId and deletedAt", async () => {
    const db = fakeDb({
      "users/alice/transactions/imp1_00002": imported(),
      "users/alice/transactions/m1": manual(),
      "users/bob/transactions/imp9_00002": imported({ sourceStatementId: "imp9" }),
    });

    const report = await migrateTransactions({ db, logger: silentLogger });

    assert.deepEqual(db.data.get("transactions/alice_imp1_00002"), { ...imported(), userId: "alice", deletedAt: null, source: "import" });
    assert.deepEqual(db.data.get("transactions/alice_m1"), { ...manual(), userId: "alice", deletedAt: null });
    assert.equal(db.data.get("transactions/bob_imp9_00002").userId, "bob");
    assert.deepEqual(report.map((r) => [r.uid, r.old, r.copied, r.missing]), [["alice", 2, 2, 0], ["bob", 1, 1, 0]]);
    // Old documents are kept unless --delete-old
    assert.equal(db.data.has("users/alice/transactions/m1"), true);
  });

  test("the owner comes from the path, even if the old doc says otherwise", async () => {
    const db = fakeDb({ "users/alice/transactions/m1": manual({ userId: "mallory" }) });
    await migrateTransactions({ db, logger: silentLogger });
    assert.equal(db.data.get("transactions/alice_m1").userId, "alice");
  });

  test("--dry-run only counts and writes nothing", async () => {
    const db = fakeDb({ "users/alice/transactions/m1": manual() });
    const before = [...db.data.keys()];

    const report = await migrateTransactions({ db, dryRun: true, deleteOld: true, logger: silentLogger });

    assert.deepEqual([...db.data.keys()], before);
    assert.deepEqual(report, [{ uid: "alice", old: 1, alreadyCopied: 0, copied: 0, missing: 1, deletedOld: 0 }]);
  });

  test("running it twice changes nothing, and never overwrites a copy the user has changed", async () => {
    const db = fakeDb({ "users/alice/transactions/m1": manual() });
    await migrateTransactions({ db, logger: silentLogger });
    db.data.get("transactions/alice_m1").category = "housing"; // changed in the app since

    const report = await migrateTransactions({ db, logger: silentLogger });

    assert.equal(db.data.get("transactions/alice_m1").category, "housing");
    assert.deepEqual(report, [{ uid: "alice", old: 1, alreadyCopied: 1, copied: 0, missing: 0, deletedOld: 0 }]);
  });

  test("--delete-old removes the old documents once every copy exists", async () => {
    const db = fakeDb({
      "users/alice": { email: "a@example.com" },
      "users/alice/transactions/m1": manual(),
      "users/alice/transactions/imp1_00002": imported(),
      "users/alice/budgets/dining": { limit: 100 },
    });

    const report = await migrateTransactions({ db, deleteOld: true, logger: silentLogger });

    assert.equal(report[0].deletedOld, 2);
    assert.equal(db.data.has("users/alice/transactions/m1"), false);
    assert.equal(db.data.has("transactions/alice_m1"), true);
    // Nothing else under the user is touched
    assert.equal(db.data.has("users/alice"), true);
    assert.equal(db.data.has("users/alice/budgets/dining"), true);
  });

  test("--delete-old keeps the old documents if a copy is missing", async () => {
    const db = fakeDb({ "users/alice/transactions/m1": manual() });
    // A copy that fails to appear (simulated by a getAll that never sees it)
    const realGetAll = db.getAll;
    db.getAll = async (...refs) => (await realGetAll(...refs)).map((s) => ({ ...s, exists: false }));
    db.batch = () => ({ create() {}, delete() { throw new Error("must not delete"); }, async commit() {} });

    const report = await migrateTransactions({ db, deleteOld: true, logger: silentLogger });

    assert.equal(report[0].missing, 1);
    assert.equal(report[0].deletedOld, 0);
    assert.equal(db.data.has("users/alice/transactions/m1"), true);
  });

  test("more than one batch of 400 is copied", async () => {
    const initial = {};
    for (let i = 0; i < 950; i++) initial[`users/alice/transactions/imp1_${String(i).padStart(5, "0")}`] = imported();
    const db = fakeDb(initial);

    const report = await migrateTransactions({ db, deleteOld: true, logger: silentLogger });

    assert.deepEqual(report, [{ uid: "alice", old: 950, alreadyCopied: 0, copied: 950, missing: 0, deletedOld: 950 }]);
  });

  test("users with no old transactions are skipped", async () => {
    const db = fakeDb({ "users/alice": { email: "a@example.com" }, "transactions/alice_x": { userId: "alice" } });
    assert.deepEqual(await migrateTransactions({ db, logger: silentLogger }), []);
  });
});

describe("toNewDoc", () => {
  test("keeps an existing deletedAt and source", () => {
    const d = toNewDoc("alice", { source: "manual", deletedAt: "yesterday", sourceStatementId: null });
    assert.equal(d.deletedAt, "yesterday");
    assert.equal(d.source, "manual");
  });
});
