/**
 * Tests for SCRUM-26/27/28: transactions.js, firestoreStore.js, importPipeline.js.
 * No Firebase or network needed: the pipeline gets a fake store, and the
 * store gets a tiny in-memory fake of Firestore.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { toTransactionDocs, transactionId } = require("../lib/transactions");
const { createStore, BATCH_SIZE } = require("../lib/firestoreStore");
const { processImport, UNSUPPORTED_TYPE, UNEXPECTED, TIMED_OUT } = require("../lib/importPipeline");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const silentLogger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
describe("toTransactionDocs", () => {
  const parsed = [
    { date: "2026-09-01", merchant: "ACME CORP PAYROLL", amount: 1850, rowNumber: 2 },
    { date: "2026-09-02", merchant: "Starbucks", amount: -6.45, rowNumber: 3 },
  ];
  const docs = toTransactionDocs(parsed, { uid: "alice", importId: "imp123", accountId: "acct-checking" });

  test("matches the shape in the data model", () => {
    assert.deepEqual(docs[1], {
      id: "alice_imp123_00003",
      userId: "alice",
      date: new Date("2026-09-02T12:00:00Z"),
      merchant: "Starbucks",
      amount: -6.45,
      // Starbucks is on the free merchant keyword list (merchantRules.js)
      category: "dining",
      categoryConfidence: 0.9,
      categorySource: "rule",
      isUserCorrected: false,
      accountId: "acct-checking",
      sourceStatementId: "imp123",
      source: "import",
      deletedAt: null,
      deletedBy: null,
      purgeAfter: null,
    });
  });

  test("document IDs are deterministic, so a re-run overwrites instead of duplicating", () => {
    const again = toTransactionDocs(parsed, { uid: "alice", importId: "imp123" });
    assert.deepEqual(again.map((d) => d.id), docs.map((d) => d.id));
    assert.equal(transactionId("alice", "imp123", 42), "alice_imp123_00042");
  });

  test("the user id is part of the document ID, so two users never collide in the shared collection", () => {
    const bob = toTransactionDocs(parsed, { uid: "bob", importId: "imp123" });
    assert.ok(bob.every((d, i) => d.id !== docs[i].id));
  });

  test("missing account becomes null, not undefined (Firestore rejects undefined)", () => {
    const d = toTransactionDocs(parsed, { uid: "alice", importId: "imp123" });
    assert.equal(d[0].accountId, null);
  });
});

// ---------------------------------------------------------------------------
/** Minimal in-memory stand-in for the parts of Firestore the store uses. */
function fakeFirestore() {
  const data = new Map(); // "transactions/alice_imp1_00002" -> doc data
  const commits = [];
  const ref = (p) => ({
    path: p,
    collection: (name) => collection(`${p}/${name}`),
    update: async (patch) => data.set(p, { ...(data.get(p) ?? {}), ...patch }),
  });
  const collection = (p) => ({
    doc: (id) => ref(`${p}/${id}`),
    where: (field, op, value) => query(p, [[field, value]]),
  });
  // where() can be chained (userId, then sourceStatementId), like the real Firestore
  const query = (p, filters) => ({
    where: (field, op, value) => query(p, [...filters, [field, value]]),
    limit: (n) => ({
      get: async () => {
        const docs = [...data.entries()]
          .filter(([k, v]) => k.startsWith(`${p}/`) && filters.every(([f, val]) => v[f] === val))
          .slice(0, n)
          .map(([k]) => ({ ref: ref(k) }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
  });
  return {
    data,
    commits,
    collection,
    batch: () => {
      const ops = [];
      return {
        set: (r, d) => ops.push(["set", r.path, d]),
        delete: (r) => ops.push(["delete", r.path]),
        commit: async () => {
          commits.push(ops.length);
          for (const [type, p, d] of ops) type === "set" ? data.set(p, d) : data.delete(p);
        },
      };
    },
  };
}

describe("firestoreStore", () => {
  const stamp = () => "SERVER_TS";
  const makeDocs = (n, importId = "imp1") =>
    toTransactionDocs(
      Array.from({ length: n }, (_, i) => ({ date: "2026-09-01", merchant: `M${i}`, amount: -1, rowNumber: i + 2 })),
      { uid: "alice", importId }
    );

  test("writes to the top-level transactions collection with createdAt and without the id field", async () => {
    const db = fakeFirestore();
    const store = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    await store.writeTransactions(makeDocs(2));
    const saved = db.data.get("transactions/alice_imp1_00002");
    assert.equal(saved.merchant, "M0");
    assert.equal(saved.userId, "alice");
    assert.equal(saved.source, "import");
    assert.equal(saved.deletedAt, null);
    assert.equal(saved.createdAt, "SERVER_TS");
    assert.equal("id" in saved, false);
  });

  test("splits large imports into batches under Firestore's 500-operation limit", async () => {
    const db = fakeFirestore();
    const store = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    await store.writeTransactions(makeDocs(1000));
    assert.equal(db.data.size, 1000);
    assert.deepEqual(db.commits, [BATCH_SIZE, BATCH_SIZE, 1000 - 2 * BATCH_SIZE]);
    assert.ok(Math.max(...db.commits) <= 500);
  });

  test("writing the same import twice does not create duplicates", async () => {
    const db = fakeFirestore();
    const store = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    await store.writeTransactions(makeDocs(5));
    await store.writeTransactions(makeDocs(5));
    assert.equal(db.data.size, 5);
  });

  test("deleteTransactions removes only this import's transactions", async () => {
    const db = fakeFirestore();
    const a = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    const b = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    await a.writeTransactions(makeDocs(600, "imp1"));
    await b.writeTransactions(makeDocs(3, "imp2"));
    await a.deleteTransactions();
    assert.equal(db.data.size, 3);
    assert.ok([...db.data.keys()].every((k) => k.includes("imp2_")));
  });

  test("deleteTransactions and deleteTransactionBatch never touch another user's transactions", async () => {
    const db = fakeFirestore();
    const alice = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    const bob = createStore({ db, uid: "bob", importId: "imp1", serverTimestamp: stamp }); // same importId on purpose
    await alice.writeTransactions(makeDocs(4, "imp1"));
    await bob.writeTransactions(
      toTransactionDocs([{ date: "2026-09-01", merchant: "BOBS", amount: -1, rowNumber: 2 }], { uid: "bob", importId: "imp1" })
    );
    assert.equal(db.data.size, 5);
    assert.equal(await alice.deleteTransactionBatch(), 4);
    await alice.deleteTransactions();
    assert.deepEqual([...db.data.keys()], ["transactions/bob_imp1_00002"]);
  });

  test("update() merges into users/{uid}/imports/{importId} and stamps updatedAt", async () => {
    const db = fakeFirestore();
    const store = createStore({ db, uid: "alice", importId: "imp1", serverTimestamp: stamp });
    await store.update({ status: "processing" });
    assert.deepEqual(db.data.get("users/alice/imports/imp1"), { status: "processing", updatedAt: "SERVER_TS" });
  });
});

// ---------------------------------------------------------------------------
/** Fake store that records what the pipeline does. */
function fakeStore({ failOn } = {}) {
  const s = {
    updates: [],
    written: [],
    deleted: 0,
    async update(patch) {
      if (failOn === "update:completed" && patch.status === "completed") throw new Error("firestore down");
      s.updates.push(patch);
    },
    async writeTransactions(docs) {
      if (failOn === "write") throw new Error("write failed");
      s.written.push(...docs);
    },
    async deleteTransactions() {
      s.deleted++;
    },
  };
  return s;
}
const run = (store, over = {}) =>
  processImport({ fileType: "csv", uid: "alice", importId: "imp1", accountId: "acct-checking", store, logger: silentLogger, ...over });
const last = (store) => store.updates.at(-1);

describe("processImport: happy path", () => {
  test("clean CSV: processing -> completed, all transactions saved", async () => {
    const store = fakeStore();
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv") });
    assert.equal(store.updates[0].status, "processing");
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 36);
    assert.equal(store.written.length, 36);
    assert.deepEqual(last(store), {
      status: "completed",
      transactionCount: 36,
      skippedRowCount: 0,
      rowErrors: [],
      error: null,
    });
  });

  test("every saved transaction is linked to the import and account", async () => {
    const store = fakeStore();
    await run(store, { fileBuffer: fixture("checking_aug_2026.csv") });
    assert.equal(store.written.length, 21);
    assert.ok(store.written.every((d) => d.sourceStatementId === "imp1" && d.userId === "alice" && d.accountId === "acct-checking"));
  });
});

describe("processImport: PDF statements (SCRUM-25)", () => {
  test("a text PDF is parsed and saved like a CSV", async () => {
    const store = fakeStore();
    const result = await run(store, { fileType: "pdf", fileBuffer: fixture("bank_a_checking_sept_2026.pdf") });
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 37);
    assert.equal(store.written.length, 37);
    assert.ok(store.written.every((d) => d.sourceStatementId === "imp1" && d.userId === "alice"));
    assert.equal(last(store).error, null);
  });
});

describe("processImport: partial failures (SCRUM-27)", () => {
  test("bad rows are skipped, good rows are kept, and the skips are reported", async () => {
    const store = fakeStore();
    const result = await run(store, { fileBuffer: fixture("messy.csv") });
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 4);
    assert.equal(result.skippedRowCount, 4);
    assert.equal(last(store).rowErrors.length, 4);
    assert.deepEqual(last(store).rowErrors[0], { row: 9, reason: 'date "13/45/2026" isn\'t a valid date' });
  });

  test("a file where every row is bad fails, and the message says why", async () => {
    const store = fakeStore();
    const csv = "Date,Description,Amount\nnot-a-date,Coffee,-4.50\nalso-bad,Tea,-3.00\n";
    const result = await run(store, { fileBuffer: Buffer.from(csv) });
    assert.equal(result.status, "failed");
    assert.match(result.error, /couldn't read any transactions/);
    assert.match(result.error, /Line 2: date "not-a-date" isn't a valid date/);
    assert.equal(store.written.length, 0);
  });
});

describe("processImport: failures (SCRUM-28)", () => {
  test("unusable file -> failed with the parser's user-facing message", async () => {
    const store = fakeStore();
    const result = await run(store, { fileBuffer: Buffer.from("") });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "This file is empty.");
    assert.deepEqual(last(store), { status: "failed", error: "This file is empty.", transactionCount: 0 });
    assert.equal(store.deleted, 0);
  });

  test("a file that isn't a real PDF -> failed with a readable message", async () => {
    const store = fakeStore();
    const result = await run(store, { fileType: "pdf", fileBuffer: Buffer.from("%PDF-1.7") });
    assert.equal(result.status, "failed");
    assert.match(result.error, /couldn't open this PDF/);
    assert.equal(store.written.length, 0);
  });

  test("a scanned PDF -> failed with the 'unsupported PDF' message", async () => {
    const store = fakeStore();
    const result = await run(store, { fileType: "pdf", fileBuffer: fixture("scanned_statement.pdf") });
    assert.equal(result.status, "failed");
    assert.match(result.error, /unsupported PDF/);
    assert.equal(store.written.length, 0);
  });

  test("an unknown file type -> failed", async () => {
    const store = fakeStore();
    const result = await run(store, { fileType: "xlsx", fileBuffer: Buffer.from("x") });
    assert.equal(result.error, UNSUPPORTED_TYPE);
  });

  test("unexpected error while saving -> partial writes are cleaned up, generic message shown", async () => {
    const store = fakeStore({ failOn: "write" });
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv") });
    assert.equal(result.status, "failed");
    assert.equal(result.error, UNEXPECTED);
    assert.equal(store.deleted, 1);
    assert.equal(last(store).status, "failed");
    assert.doesNotMatch(result.error, /write failed/); // internals never reach the user
  });

  test("failing to mark 'completed' also rolls back the transactions", async () => {
    const store = fakeStore({ failOn: "update:completed" });
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv") });
    assert.equal(result.status, "failed");
    assert.equal(store.deleted, 1);
  });

  test("never throws, even if Firestore is down for the status update too", async () => {
    const store = fakeStore({ failOn: "write" });
    store.update = async () => {
      throw new Error("firestore down");
    };
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv") });
    assert.equal(result.status, "failed");
  });
});

describe("processImport: timeouts (SCRUM-28)", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test("saving takes too long -> marked failed, never left on 'processing'", async () => {
    const store = fakeStore();
    store.writeTransactions = async () => sleep(200); // slower than the deadline below
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv"), timeoutMs: 50 });
    assert.equal(result.status, "failed");
    assert.equal(result.error, TIMED_OUT);
    assert.deepEqual(last(store), { status: "failed", error: TIMED_OUT, transactionCount: 0 });
    assert.ok(store.deleted >= 1);
  });

  test("a save that finishes after the deadline is rolled back and never marked completed", async () => {
    const store = fakeStore();
    store.writeTransactions = async () => sleep(100);
    await run(store, { fileBuffer: fixture("checking_sept_2026.csv"), timeoutMs: 30 });
    await sleep(250); // let the slow write finish in the background
    assert.ok(store.updates.every((u) => u.status !== "completed"));
    assert.equal(last(store).status, "failed");
    assert.ok(store.deleted >= 2); // once at the deadline, once after the late write landed
  });

  test("finishing before the deadline is unaffected", async () => {
    const store = fakeStore();
    const result = await run(store, { fileBuffer: fixture("checking_sept_2026.csv"), timeoutMs: 5000 });
    assert.equal(result.status, "completed");
  });
});
