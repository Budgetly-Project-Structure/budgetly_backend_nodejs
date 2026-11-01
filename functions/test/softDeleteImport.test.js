/**
 * Tests for SCRUM-120: softDeleteImport.js, its callable handler (callables.js),
 * the store's soft-delete methods (firestoreStore.js) and the audit log writer
 * (auditLog.js). No Firebase or network needed: everything runs on the small
 * in-memory Firestore below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");

const { softDeleteImport, RETENTION_DAYS } = require("../lib/softDeleteImport");
const { DeleteImportError } = require("../lib/deleteImport");
const { createSoftDeleteImportHandler } = require("../lib/callables");
const { createStore, DELETE_BATCH_SIZE } = require("../lib/firestoreStore");
const { createAuditWriter } = require("../lib/auditLog");

const silentLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Tiny in-memory Firestore with just what createStore and createAuditWriter use. */
function fakeFirestore(docs = {}) {
  const data = new Map(Object.entries(docs)); // path -> doc data
  let nextId = 1;
  const ref = (p) => ({
    path: p,
    collection: (name) => collection(`${p}/${name}`),
    get: async () => ({ exists: data.has(p), data: () => data.get(p) }),
    update: async (fields) => {
      if (!data.has(p)) throw new Error(`no document: ${p}`);
      data.set(p, { ...data.get(p), ...fields });
    },
    delete: async () => data.delete(p),
  });
  const query = (p, filters) => ({
    where: (field, op, value) => query(p, [...filters, [field, value]]),
    limit: (n) => ({
      get: async () => {
        const found = [...data.entries()]
          .filter(([k, v]) => k.startsWith(`${p}/`) && k.split("/").length === p.split("/").length + 1)
          // Like Firestore, == null does not match a missing field
          .filter(([, v]) => filters.every(([f, val]) => f in v && v[f] === val))
          .slice(0, n)
          .map(([k]) => ({ ref: ref(k) }));
        return { empty: found.length === 0, size: found.length, docs: found };
      },
    }),
  });
  const collection = (p) => ({
    doc: (id) => ref(`${p}/${id}`),
    where: (field, op, value) => query(p, [[field, value]]),
    add: async (d) => data.set(`${p}/auto${nextId++}`, d),
  });
  const db = {
    collection,
    batch: () => {
      const ops = [];
      return {
        update: (r, fields) => ops.push(() => data.set(r.path, { ...data.get(r.path), ...fields })),
        delete: (r) => ops.push(() => data.delete(r.path)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
  return { db, data };
}

/** One user's import with `n` transactions, as the import pipeline saves them. */
function seedImport(docs, uid, importId, n, imp = {}) {
  docs[`users/${uid}/imports/${importId}`] = {
    status: "completed",
    fileName: `${importId}.csv`,
    storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
    deletedAt: null,
    ...imp,
  };
  for (let i = 0; i < n; i++) {
    docs[`transactions/${uid}_${importId}_${i}`] = { userId: uid, sourceStatementId: importId, source: "import", deletedAt: null };
  }
  return docs;
}

/** Everything wired together on one fake database, as index.js does with the real one. */
function setup(docs) {
  const { db, data } = fakeFirestore(docs);
  const openStoreFor = (uid, importId) => createStore({ db, uid, importId, serverTimestamp: () => "SERVER_TIME" });
  const writeAudit = createAuditWriter({ db, serverTimestamp: () => "SERVER_TIME" });
  const run = (uid, importId) =>
    softDeleteImport({ uid, importId, openStore: (id) => openStoreFor(uid, id), writeAudit, now: () => NOW, logger: silentLogger });
  const handler = createSoftDeleteImportHandler({ openStoreFor, writeAudit, logger: silentLogger });
  const txns = (uid, importId) =>
    [...data.entries()].filter(([k, v]) => k.startsWith("transactions/") && v.userId === uid && v.sourceStatementId === importId).map(([, v]) => v);
  const audit = () => [...data.entries()].filter(([k]) => k.startsWith("auditLog/")).map(([, v]) => v);
  return { db, data, run, handler, txns, audit };
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => (err instanceof DeleteImportError || err instanceof HttpsError) && err.code === code);

// ---------------------------------------------------------------------------
describe("softDeleteImport", () => {
  test("marks the import and all its transactions deleted, keeps everything, and reports the count", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 3));

    const result = await s.run("alice", "imp1");

    const purgeAfter = new Date(NOW + RETENTION_DAYS * DAY);
    assert.deepEqual(result, { deletedTransactions: 3, purgeAfter: purgeAfter.toISOString() });
    for (const t of s.txns("alice", "imp1")) {
      assert.equal(t.deletedAt, "SERVER_TIME");
      assert.equal(t.deletedBy, "alice");
      assert.deepEqual(t.purgeAfter, purgeAfter);
    }
    const imp = s.data.get("users/alice/imports/imp1");
    assert.equal(imp.deletedAt, "SERVER_TIME");
    assert.equal(imp.deletedBy, "alice");
    // Nothing is removed: 3 transactions and the import doc are all still there
    assert.equal(s.txns("alice", "imp1").length, 3);
    assert.equal(imp.storagePath, "users/alice/imports/1700000000000_imp1.csv");
  });

  test("writes one import.deleted audit entry with the transaction count", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 2));
    await s.run("alice", "imp1");
    assert.deepEqual(s.audit(), [{
      userId: "alice",
      action: "import.deleted",
      targetPath: "users/alice/imports/imp1",
      actor: "alice",
      at: "SERVER_TIME",
      details: { fileName: "imp1.csv", transactionCount: 2 },
    }]);
  });

  test("a 900-transaction statement is marked in batches of 400 or fewer", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 900));
    const batches = [];
    const realBatch = s.db.batch;
    s.db.batch = () => {
      const b = realBatch();
      let n = 0;
      return { ...b, update: (...a) => { n++; b.update(...a); }, commit: async () => { batches.push(n); await b.commit(); } };
    };

    const { deletedTransactions } = await s.run("alice", "imp1");

    assert.equal(deletedTransactions, 900);
    assert.deepEqual(batches, [DELETE_BATCH_SIZE, DELETE_BATCH_SIZE, 100]);
  });

  test("only this user's transactions from this import are touched", async () => {
    const docs = seedImport({}, "alice", "imp1", 2);
    seedImport(docs, "alice", "imp2", 2); // alice's other statement
    seedImport(docs, "bob", "imp1", 2); // bob, same import id
    const s = setup(docs);

    await s.run("alice", "imp1");

    assert.ok(s.txns("alice", "imp2").every((t) => t.deletedAt === null));
    assert.ok(s.txns("bob", "imp1").every((t) => t.deletedAt === null));
    assert.equal(s.data.get("users/bob/imports/imp1").deletedAt, null);
  });

  test("someone else's import is not found, and nothing of theirs changes", async () => {
    const s = setup(seedImport({}, "bob", "bobImp", 2));
    await rejectsWith(s.run("alice", "bobImp"), "not-found");
    assert.ok(s.txns("bob", "bobImp").every((t) => t.deletedAt === null));
    assert.deepEqual(s.audit(), []);
  });

  test("an import pointing at another user's file -> permission-denied", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1, { storagePath: "users/bob/imports/1_x.csv" }));
    await rejectsWith(s.run("alice", "imp1"), "permission-denied");
    assert.equal(s.data.get("users/alice/imports/imp1").deletedAt, null);
  });

  test("an import that is still uploading or processing can't be deleted yet", async () => {
    for (const status of ["uploaded", "processing"]) {
      const s = setup(seedImport({}, "alice", "imp1", 1, { status }));
      await rejectsWith(s.run("alice", "imp1"), "failed-precondition");
      assert.equal(s.data.get("users/alice/imports/imp1").deletedAt, null);
    }
  });

  test("a failed import can be deleted", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 0, { status: "failed" }));
    assert.equal((await s.run("alice", "imp1")).deletedTransactions, 0);
  });

  test("an import that is already deleted -> failed-precondition, nothing changes", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1, { deletedAt: "earlier", deletedBy: "alice" }));
    await rejectsWith(s.run("alice", "imp1"), "failed-precondition");
    assert.deepEqual(s.audit(), []);
  });

  test("not signed in, or a bad ID -> refused before anything is read", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await rejectsWith(s.run(null, "imp1"), "unauthenticated");
    await rejectsWith(s.run("alice", "../bob/imports/x"), "invalid-argument");
    await rejectsWith(s.run("alice", 42), "invalid-argument");
  });

  test("a retry after a failure part way finishes the job", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 3));
    // Pretend one transaction was already marked by a run that then failed
    s.data.get("transactions/alice_imp1_0").deletedAt = "earlier";

    const { deletedTransactions } = await s.run("alice", "imp1");

    assert.equal(deletedTransactions, 2);
    assert.ok(s.txns("alice", "imp1").every((t) => t.deletedAt !== null));
  });
});

describe("softDeleteImport callable", () => {
  const asUser = (uid, data) => ({ auth: { uid, token: {} }, data });

  test("not signed in -> unauthenticated, nothing changes", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1));
    await rejectsWith(s.handler({ data: { importId: "imp1", userId: "alice" } }), "unauthenticated");
    assert.equal(s.data.get("users/alice/imports/imp1").deletedAt, null);
  });

  test("the owner can delete their statement", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 2));
    const result = await s.handler(asUser("alice", { importId: "imp1" }));
    assert.equal(result.deletedTransactions, 2);
  });

  test("a spoofed userId in the body is ignored: bob's statement can't be deleted", async () => {
    const s = setup(seedImport({}, "bob", "bobImp", 2));
    await rejectsWith(s.handler(asUser("alice", { importId: "bobImp", userId: "bob", uid: "bob" })), "not-found");
    assert.equal(s.data.get("users/bob/imports/bobImp").deletedAt, null);
  });

  test("user-facing problems keep their code and message", async () => {
    const s = setup(seedImport({}, "alice", "imp1", 1, { status: "processing" }));
    await assert.rejects(s.handler(asUser("alice", { importId: "imp1" })),
      (err) => err instanceof HttpsError && err.code === "failed-precondition" && /still importing/.test(err.message));
  });

  test("an unexpected error -> internal", async () => {
    const handler = createSoftDeleteImportHandler({
      openStoreFor: () => ({ get: async () => { throw new Error("db down"); } }),
      writeAudit: async () => {},
      logger: silentLogger,
    });
    await rejectsWith(handler(asUser("alice", { importId: "imp1" })), "internal");
  });
});
