/**
 * Tests for callables.js (SCRUM-112): callable functions take the caller's
 * user id only from the login token (request.auth.uid), never from the body.
 * No Firebase or network needed: the deleteImport handler gets a fake store.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");

const { requireUid, createDeleteImportHandler } = require("../lib/callables");

const silentLogger = { info() {}, warn() {}, error() {} };

/** A pretend database with imports and transactions for several users. */
function fakeDb() {
  const imports = new Map(); // "uid/importId" -> import data
  const transactions = []; // { uid, sourceStatementId }
  const opened = []; // every "uid/importId" a store was opened for

  const openStoreFor = (uid, importId) => {
    opened.push(`${uid}/${importId}`);
    return {
      async get() {
        return imports.get(`${uid}/${importId}`) ?? null;
      },
      async deleteTransactionBatch() {
        const mine = transactions.filter((t) => t.uid === uid && t.sourceStatementId === importId);
        for (const t of mine) transactions.splice(transactions.indexOf(t), 1);
        return mine.length;
      },
      async deleteImportDoc() {
        imports.delete(`${uid}/${importId}`);
      },
    };
  };

  const addImport = (uid, importId, txnCount) => {
    imports.set(`${uid}/${importId}`, {
      status: "completed",
      storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
    });
    for (let i = 0; i < txnCount; i++) transactions.push({ uid, sourceStatementId: importId });
  };

  const handler = createDeleteImportHandler({ openStoreFor, deleteFile: async () => {}, logger: silentLogger });
  return { imports, transactions, opened, addImport, handler };
}

/** A callable request as onCall passes it: auth is set only for a verified token. */
const asUser = (uid, data) => ({ auth: { uid, token: {} }, data });
const signedOut = (data) => ({ auth: undefined, data });

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof HttpsError && err.code === code);

// ---------------------------------------------------------------------------
describe("requireUid", () => {
  test("returns the uid from the verified token", () => {
    assert.equal(requireUid(asUser("alice", {})), "alice");
  });

  test("no signed-in user -> unauthenticated", () => {
    assert.throws(() => requireUid(signedOut({})), (err) => err instanceof HttpsError && err.code === "unauthenticated");
    assert.throws(() => requireUid({}), (err) => err.code === "unauthenticated");
    assert.throws(() => requireUid(asUser("", {})), (err) => err.code === "unauthenticated");
  });

  test("a uid in the body does not count as signing in", () => {
    assert.throws(() => requireUid(signedOut({ uid: "alice", userId: "alice" })), (err) => err.code === "unauthenticated");
  });
});

describe("deleteImport callable", () => {
  test("not signed in -> unauthenticated, nothing is opened or deleted", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 3);

    await rejectsWith(fake.handler(signedOut({ importId: "imp1", userId: "alice" })), "unauthenticated");

    assert.deepEqual(fake.opened, []);
    assert.equal(fake.transactions.length, 3);
    assert.equal(fake.imports.has("alice/imp1"), true);
  });

  test("the owner can delete their own import", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 3);

    const result = await fake.handler(asUser("alice", { importId: "imp1" }));

    assert.deepEqual(result, { deletedTransactions: 3 });
    assert.equal(fake.imports.has("alice/imp1"), false);
  });

  test("another user's importId is not found, and nothing of theirs is deleted", async () => {
    const fake = fakeDb();
    fake.addImport("bob", "bobImp", 4);

    await rejectsWith(fake.handler(asUser("alice", { importId: "bobImp" })), "not-found");

    assert.deepEqual(fake.opened, ["alice/bobImp"]);
    assert.equal(fake.transactions.length, 4);
    assert.equal(fake.imports.has("bob/bobImp"), true);
  });

  test("a spoofed userId/uid in the body is ignored: the token's uid is used", async () => {
    const fake = fakeDb();
    fake.addImport("bob", "bobImp", 4);

    await rejectsWith(fake.handler(asUser("alice", { importId: "bobImp", userId: "bob", uid: "bob" })), "not-found");

    // The store was only ever opened for alice, the token's user
    assert.deepEqual(fake.opened, ["alice/bobImp"]);
    assert.equal(fake.imports.has("bob/bobImp"), true);
    assert.equal(fake.transactions.length, 4);
  });

  test("a spoofed userId on your own import still only deletes your own data", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "shared", 2);
    fake.addImport("bob", "shared", 5); // same importId under another user

    const result = await fake.handler(asUser("alice", { importId: "shared", userId: "bob" }));

    assert.deepEqual(result, { deletedTransactions: 2 });
    assert.equal(fake.imports.has("alice/shared"), false);
    assert.equal(fake.imports.has("bob/shared"), true);
    assert.equal(fake.transactions.filter((t) => t.uid === "bob").length, 5);
  });

  test("an import whose file is in another user's folder -> permission-denied", async () => {
    const fake = fakeDb();
    fake.addImport("alice", "imp1", 1);
    fake.imports.get("alice/imp1").storagePath = "users/bob/imports/1700000000000_x.csv";

    await rejectsWith(fake.handler(asUser("alice", { importId: "imp1" })), "permission-denied");
    assert.equal(fake.imports.has("alice/imp1"), true);
  });

  test("an unexpected error -> internal, with a readable message", async () => {
    const handler = createDeleteImportHandler({
      openStoreFor: () => ({ get: async () => { throw new Error("db down"); } }),
      deleteFile: async () => {},
      logger: silentLogger,
    });
    await rejectsWith(handler(asUser("alice", { importId: "imp1" })), "internal");
  });
});
