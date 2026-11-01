/**
 * Tests for SCRUM-121: restoreImport.js and its callable handler. Each test first
 * deletes a statement with the real softDeleteImport (SCRUM-120), then restores
 * it, all on the in-memory Firestore from helpers/importFakes.js.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");

const { restoreImport } = require("../lib/restoreImport");
const { softDeleteImport } = require("../lib/softDeleteImport");
const { DeleteImportError } = require("../lib/deleteImport");
const { createRestoreImportHandler } = require("../lib/callables");
const { createStore, DELETE_BATCH_SIZE } = require("../lib/firestoreStore");
const { createAuditWriter } = require("../lib/auditLog");
const { fakeFirestore, seedImport } = require("./helpers/importFakes");

const silentLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Everything wired together on one fake database, as index.js does with the real one. */
function setup(docs) {
  const { db, data } = fakeFirestore(docs);
  const openStoreFor = (uid, importId) => createStore({ db, uid, importId, serverTimestamp: () => "SERVER_TIME" });
  const writeAudit = createAuditWriter({ db, serverTimestamp: () => "SERVER_TIME" });
  const common = (uid) => ({ uid, openStore: (id) => openStoreFor(uid, id), writeAudit, logger: silentLogger });
  const del = (uid, importId) => softDeleteImport({ ...common(uid), importId, now: () => NOW });
  const restore = (uid, importId, at = NOW + DAY) => restoreImport({ ...common(uid), importId, now: () => at });
  const handler = createRestoreImportHandler({ openStoreFor, writeAudit, logger: silentLogger });
  const txns = (uid, importId) =>
    [...data.entries()].filter(([k, v]) => k.startsWith("transactions/") && v.userId === uid && v.sourceStatementId === importId).map(([, v]) => v);
  const audit = () => [...data.entries()].filter(([k]) => k.startsWith("auditLog/")).map(([, v]) => v);
  return { db, data, del, restore, handler, txns, audit };
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => (err instanceof DeleteImportError || err instanceof HttpsError) && err.code === code);

const isActive = (d) => d.deletedAt === null && d.deletedBy === null && d.purgeAfter === null;

// ---------------------------------------------------------------------------
describe("restoreImport", () => {
  test("clears the delete fields on the import and all its transactions", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 3));
    await s.del("alice", "imp1");

    const result = await s.restore("alice", "imp1");

    assert.deepEqual(result, { restoredTransactions: 3 });
    assert.ok(s.txns("alice", "imp1").every(isActive));
    assert.ok(isActive(s.data.get("users/alice/imports/imp1")));
  });

  test("writes an import.restored audit entry (after the import.deleted one)", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 2));
    await s.del("alice", "imp1");
    await s.restore("alice", "imp1");

    assert.deepEqual(s.audit().map((e) => e.action), ["import.deleted", "import.restored"]);
    assert.deepEqual(s.audit()[1], {
      userId: "alice",
      action: "import.restored",
      targetPath: "users/alice/imports/imp1",
      actor: "alice",
      at: "SERVER_TIME",
      details: { fileName: "imp1.csv", transactionCount: 2 },
    });
  });

  test("a 900-transaction statement is restored in batches of 400 or fewer", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 900));
    await s.del("alice", "imp1");
    const batches = [];
    const realBatch = s.db.batch;
    s.db.batch = () => {
      const b = realBatch();
      let n = 0;
      return { ...b, update: (...a) => { n++; b.update(...a); }, commit: async () => { batches.push(n); await b.commit(); } };
    };

    assert.equal((await s.restore("alice", "imp1")).restoredTransactions, 900);
    assert.deepEqual(batches, [DELETE_BATCH_SIZE, DELETE_BATCH_SIZE, 100]);
  });

  test("only this statement's transactions come back, not another deleted one", async () => {
    const docs = seedImport({}, "alice", "imp1", 2);
    seedImport(docs, "alice", "imp2", 2);
    const s = setup(docs);
    await s.del("alice", "imp1");
    await s.del("alice", "imp2");

    await s.restore("alice", "imp1");

    assert.ok(s.txns("alice", "imp1").every(isActive));
    assert.ok(s.txns("alice", "imp2").every((t) => t.deletedAt !== null));
    assert.notEqual(s.data.get("users/alice/imports/imp2").deletedAt, null);
  });

  test("restoring another user's statement fails, and theirs stays deleted", async () => {
    const s = setup(seedImport({}, "bob", "bobImp", 2));
    await s.del("bob", "bobImp");

    await rejectsWith(s.restore("alice", "bobImp"), "not-found");

    assert.ok(s.txns("bob", "bobImp").every((t) => t.deletedAt !== null));
  });

  test("restoring a statement that isn't deleted fails", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await assert.rejects(s.restore("alice", "imp1"), (err) => err.code === "failed-precondition" && /isn't deleted/.test(err.message));
  });

  test("restoring after the 30 days are up fails, and nothing changes", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await s.del("alice", "imp1");

    await assert.rejects(s.restore("alice", "imp1", NOW + 31 * DAY), (err) => err.code === "failed-precondition" && /30 days/.test(err.message));

    assert.notEqual(s.data.get("users/alice/imports/imp1").deletedAt, null);
    assert.deepEqual(s.audit().map((e) => e.action), ["import.deleted"]);
  });

  test("restoring a statement that was purged (removed for good) fails with not-found", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await s.del("alice", "imp1");
    s.data.delete("users/alice/imports/imp1"); // what a purge does

    await assert.rejects(s.restore("alice", "imp1"), (err) => err.code === "not-found" && /removed for good/.test(err.message));
  });

  test("an import pointing at another user's file -> permission-denied", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1, { storagePath: "users/bob/imports/1_x.csv", deletedAt: "earlier" }));
    await rejectsWith(s.restore("alice", "imp1"), "permission-denied");
  });

  test("not signed in, or a bad ID -> refused", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await rejectsWith(s.restore(null, "imp1"), "unauthenticated");
    await rejectsWith(s.restore("alice", "../x"), "invalid-argument");
  });

  test("delete -> restore -> delete -> restore works every time", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 2));
    for (let i = 0; i < 2; i++) {
      await s.del("alice", "imp1");
      assert.equal((await s.restore("alice", "imp1")).restoredTransactions, 2);
    }
    assert.ok(s.txns("alice", "imp1").every(isActive));
  });
});

describe("restoreImport callable", () => {
  const asUser = (uid, data) => ({ auth: { uid, token: {} }, data });

  test("not signed in -> unauthenticated", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await s.del("alice", "imp1");
    await rejectsWith(s.handler({ data: { importId: "imp1", userId: "alice" } }), "unauthenticated");
    assert.notEqual(s.data.get("users/alice/imports/imp1").deletedAt, null);
  });

  test("the owner can restore their statement", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 2));
    await s.del("alice", "imp1");
    assert.deepEqual(await s.handler(asUser("alice", { importId: "imp1" })), { restoredTransactions: 2 });
  });

  test("a spoofed userId in the body is ignored: bob's statement stays deleted", async () => {
    const s = setup(seedImport({}, "bob", "bobImp", 1));
    await s.del("bob", "bobImp");
    await rejectsWith(s.handler(asUser("alice", { importId: "bobImp", userId: "bob" })), "not-found");
    assert.notEqual(s.data.get("users/bob/imports/bobImp").deletedAt, null);
  });
});
