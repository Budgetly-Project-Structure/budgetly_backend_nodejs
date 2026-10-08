/**
 * Tests for deleteImport.js (the Import page's "Delete" button).
 * No Firebase or network needed: deleteImport gets a fake store and a fake
 * Storage delete, and the store's new methods get the in-memory fake below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { deleteImport, DeleteImportError } = require("../lib/deleteImport");
const { createStore, DELETE_BATCH_SIZE } = require("../lib/firestoreStore");

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * A pretend database holding imports for several users. openStore(uid) returns
 * the same openStore(importId) function index.js passes in, scoped to that user.
 */
function fakeDb() {
  const imports = new Map(); // "uid/importId" -> import data
  const transactions = []; // { uid, sourceStatementId }
  const batches = []; // size of every delete batch
  const deletedFiles = [];

  const openStore = (uid) => (importId) => ({
    async get() {
      return imports.get(`${uid}/${importId}`) ?? null;
    },
    async deleteTransactionBatch() {
      const mine = transactions.filter((t) => t.uid === uid && t.sourceStatementId === importId).slice(0, DELETE_BATCH_SIZE);
      for (const t of mine) transactions.splice(transactions.indexOf(t), 1);
      if (mine.length) batches.push(mine.length);
      return mine.length;
    },
    async deleteImportDoc() {
      imports.delete(`${uid}/${importId}`);
    },
  });

  const addImport = (uid, importId, txnCount, data = {}) => {
    imports.set(`${uid}/${importId}`, {
      status: "completed",
      storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
      ...data,
    });
    for (let i = 0; i < txnCount; i++) transactions.push({ uid, sourceStatementId: importId });
  };

  const deleteFile = async (path) => {
    deletedFiles.push(path);
  };

  return { imports, transactions, batches, deletedFiles, openStore, addImport, deleteFile };
}

/** Runs deleteImport as `uid` against the fake database. */
const run = (fake, uid, importId, overrides = {}) =>
  deleteImport({ uid, importId, openStore: fake.openStore(uid), deleteFile: fake.deleteFile, logger: silentLogger, ...overrides });

/** Asserts that the promise rejects with a DeleteImportError with this code. */
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof DeleteImportError && err.code === code);

// ---------------------------------------------------------------------------
describe("deleteImport", () => {
  test("deletes the transactions, the file and the import doc, and reports the count", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 36);
    fake.addImport("alice", "imp2", 5); // another import that must be left alone

    const result = await run(fake, "alice", "imp1");

    assert.deepEqual(result, { deletedTransactions: 36 });
    assert.equal(fake.transactions.length, 5);
    assert.ok(fake.transactions.every((t) => t.sourceStatementId === "imp2"));
    assert.deepEqual(fake.deletedFiles, ["users/alice/imports/1700000000000_imp1.csv"]);
    assert.equal(fake.imports.has("alice/imp1"), false);
    assert.equal(fake.imports.has("alice/imp2"), true);
  });

  test("a 900-transaction import is deleted in several batches of 400 or fewer", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "big", 900);

    const result = await run(fake, "alice", "big");

    assert.equal(result.deletedTransactions, 900);
    assert.deepEqual(fake.batches, [400, 400, 100]);
    assert.ok(fake.batches.every((n) => n <= 400));
    assert.equal(fake.transactions.length, 0);
  });

  test("someone else's import is not found, and nothing of theirs is deleted", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 10);

    await rejectsWith(run(fake, "mallory", "imp1"), "not-found");

    assert.equal(fake.transactions.length, 10);
    assert.equal(fake.imports.has("alice/imp1"), true);
    assert.deepEqual(fake.deletedFiles, []);
  });

  test("an import pointing at another user's file is rejected before anything is deleted", async () => {
    const fake = fakeDb();
    fake.addImport("mallory", "imp1", 3, { storagePath: "users/alice/imports/1700000000000_jan.csv" });

    await rejectsWith(run(fake, "mallory", "imp1"), "permission-denied");

    assert.equal(fake.transactions.length, 3);
    assert.deepEqual(fake.deletedFiles, []);
  });

  test("a missing import -> not-found", async () => {
    await rejectsWith(run(fakeDb(), "alice", "nope"), "not-found");
  });

  test("a Storage file that's already gone is not an error", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 4);
    const missingFile = async () => {
      throw Object.assign(new Error("No such object"), { code: 404 });
    };

    const result = await run(fake, "alice", "imp1", { deleteFile: missingFile });

    assert.deepEqual(result, { deletedTransactions: 4 });
    assert.equal(fake.imports.has("alice/imp1"), false);
  });

  test("any other Storage error keeps the import doc, so the delete can be retried", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 4);
    const outage = async () => {
      throw Object.assign(new Error("Service unavailable"), { code: 503 });
    };

    await assert.rejects(run(fake, "alice", "imp1", { deleteFile: outage }), /Service unavailable/);
    assert.equal(fake.imports.has("alice/imp1"), true);
  });

  test("a failed import with no transactions is still deleted", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "bad", 0, { status: "failed" });

    assert.deepEqual(await run(fake, "alice", "bad"), { deletedTransactions: 0 });
    assert.equal(fake.imports.has("alice/bad"), false);
  });

  test("an import that is still processing can't be deleted yet", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "busy", 2, { status: "processing" });

    await rejectsWith(run(fake, "alice", "busy"), "failed-precondition");
    assert.equal(fake.transactions.length, 2);
  });

  test("not signed in -> unauthenticated", async () => {
    await rejectsWith(run(fakeDb(), null, "imp1"), "unauthenticated");
  });

  test("an ID that could reach outside the user's imports is refused", async () => {
    await rejectsWith(run(fakeDb(), "alice", "../bob/imports/x"), "invalid-argument");
    await rejectsWith(run(fakeDb(), "alice", undefined), "invalid-argument");
  });
});

// ---------------------------------------------------------------------------
/** Tiny in-memory Firestore with just what the store's delete methods use. */
function fakeFirestore(docs) {
  const data = new Map(Object.entries(docs)); // path -> doc data
  const ref = (p) => ({
    path: p,
    collection: (name) => collection(`${p}/${name}`),
    get: async () => ({ exists: data.has(p), data: () => data.get(p) }),
    delete: async () => data.delete(p),
  });
  const collection = (p) => ({
    doc: (id) => ref(`${p}/${id}`),
    where: (field, op, value) => ({
      limit: (n) => ({
        get: async () => {
          const found = [...data.entries()]
            .filter(([k, v]) => k.startsWith(`${p}/`) && v[field] === value)
            .slice(0, n)
            .map(([k]) => ({ ref: ref(k) }));
          return { empty: found.length === 0, size: found.length, docs: found };
        },
      }),
    }),
  });
  const db = {
    collection,
    batch: () => {
      const ops = [];
      return { delete: (r) => ops.push(r.path), commit: async () => ops.forEach((path) => data.delete(path)) };
    },
  };
  return { db, data };
}

describe("firestoreStore: delete methods", () => {
  test("get / deleteTransactionBatch / deleteImportDoc work on users/{uid}", async () => {
    const docs = { "users/alice/imports/imp1": { status: "completed" } };
    for (let i = 0; i < 450; i++) docs[`users/alice/transactions/imp1_${i}`] = { sourceStatementId: "imp1" };
    docs["users/alice/transactions/other_1"] = { sourceStatementId: "imp2" };
    const { db, data } = fakeFirestore(docs);
    const store = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: () => "now" });

    assert.deepEqual(await store.get(), { status: "completed" });
    assert.equal(await store.deleteTransactionBatch(), 400);
    assert.equal(await store.deleteTransactionBatch(), 50);
    assert.equal(await store.deleteTransactionBatch(), 0);
    await store.deleteImportDoc();

    assert.equal(await store.get(), null);
    assert.deepEqual([...data.keys()], ["users/alice/transactions/other_1"]);
  });
});
