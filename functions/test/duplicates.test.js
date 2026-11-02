/**
 * Tests for SCRUM-136: skipping transactions that an earlier, overlapping statement
 * already saved (duplicates.js, firestoreStore.existingTransactionCounts, and how
 * importPipeline.js uses them).
 * No Firebase or network needed: the store gets a tiny in-memory fake of Firestore.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { duplicateKey, removeDuplicates } = require("../lib/duplicates");
const { createStore } = require("../lib/firestoreStore");
const { toTransactionDocs } = require("../lib/transactions");
const { processImport, ALL_DUPLICATES } = require("../lib/importPipeline");

const silentLogger = { info() {}, warn() {}, error() {} };
const stamp = () => "SERVER_TS";

const row = (date, merchant, amount, rowNumber) => ({ date, merchant, amount, rowNumber });
const docsFor = (rows, importId = "imp2", accountId = "acct-checking") =>
  toTransactionDocs(rows, { uid: "alice", importId, accountId });

// A statement CSV with the given rows (Date, Description, Amount)
const csv = (rows) => Buffer.from(["Date,Description,Amount", ...rows.map((r) => `${r[0]},${r[1]},${r[2]}`)].join("\n"));

describe("duplicateKey", () => {
  const base = { accountId: "acct-checking", date: new Date("2026-09-05T12:00:00Z"), amount: -6.45, merchant: "STARBUCKS #1187" };

  test("the same transaction gets the same key, whatever the case or spacing", () => {
    const again = { ...base, merchant: "  starbucks   #1187 " };
    assert.equal(duplicateKey(base), duplicateKey(again));
  });

  test("a different account, day, amount or merchant is a different key", () => {
    const key = duplicateKey(base);
    assert.notEqual(key, duplicateKey({ ...base, accountId: "acct-savings" }));
    assert.notEqual(key, duplicateKey({ ...base, accountId: null }));
    assert.notEqual(key, duplicateKey({ ...base, date: new Date("2026-09-06T12:00:00Z") }));
    assert.notEqual(key, duplicateKey({ ...base, amount: -6.46 }));
    assert.notEqual(key, duplicateKey({ ...base, merchant: "STARBUCKS #1188" }));
  });

  test("amounts that differ only by floating point noise match", () => {
    assert.equal(duplicateKey({ ...base, amount: -0.1 - 0.2 }), duplicateKey({ ...base, amount: -0.3 }));
  });

  test("reads a Firestore Timestamp like a Date", () => {
    const ts = { toDate: () => new Date("2026-09-05T12:00:00Z") };
    assert.equal(duplicateKey({ ...base, date: ts }), duplicateKey(base));
  });
});

describe("removeDuplicates", () => {
  const rows = [
    row("2026-09-01", "ACME PAYROLL", 1850, 2),
    row("2026-09-02", "STARBUCKS", -6.45, 3),
    row("2026-09-03", "KWIK TRIP", -42.18, 4),
  ];

  test("nothing saved yet: everything is new", () => {
    const { fresh, duplicates } = removeDuplicates(docsFor(rows), new Map());
    assert.equal(fresh.length, 3);
    assert.equal(duplicates.length, 0);
  });

  test("rows already saved are skipped and the rest are kept in order", () => {
    const existing = new Map([[duplicateKey(docsFor(rows)[1]), 1]]);
    const { fresh, duplicates } = removeDuplicates(docsFor(rows), existing);
    assert.deepEqual(fresh.map((d) => d.merchant), ["ACME PAYROLL", "KWIK TRIP"]);
    assert.deepEqual(duplicates.map((d) => d.merchant), ["STARBUCKS"]);
  });

  test("repeat purchases: only the copies beyond what is already saved are new", () => {
    const twoCoffees = [row("2026-09-02", "STARBUCKS", -4.5, 2), row("2026-09-02", "STARBUCKS", -4.5, 3), row("2026-09-02", "STARBUCKS", -4.5, 4)];
    const docs = docsFor(twoCoffees);
    const existing = new Map([[duplicateKey(docs[0]), 2]]); // 2 are already saved
    const { fresh, duplicates } = removeDuplicates(docs, existing);
    assert.equal(duplicates.length, 2);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, docs[2].id); // the third copy is the new one
  });

  test("two identical purchases in a brand new statement are both kept", () => {
    const docs = docsFor([row("2026-09-02", "STARBUCKS", -4.5, 2), row("2026-09-02", "STARBUCKS", -4.5, 3)]);
    assert.equal(removeDuplicates(docs, new Map()).fresh.length, 2);
  });

  test("a different account's identical transaction is not a duplicate", () => {
    const savings = docsFor(rows, "imp1", "acct-savings");
    const existing = new Map(savings.map((d) => [duplicateKey(d), 1]));
    assert.equal(removeDuplicates(docsFor(rows), existing).fresh.length, 3);
  });
});

/**
 * Tiny Firestore fake for the transactions collection: where() calls chain (all
 * equality), select() is ignored, get() returns { docs }.
 */
function fakeFirestore(initial = []) {
  const data = new Map(initial.map((d) => [`transactions/${d.id}`, d]));
  const db = {
    data,
    collection(name) {
      // createStore also builds the import doc reference: users/{uid}/imports/{importId}
      if (name === "users") return { doc: () => ({ collection: () => ({ doc: () => ({}) }) }) };
      if (name !== "transactions") throw new Error(`unexpected collection ${name}`);
      const filters = [];
      const q = {
        where(field, op, value) {
          assert.equal(op, "==");
          filters.push([field, value]);
          return q;
        },
        select() {
          return q;
        },
        async get() {
          const docs = [...data.values()]
            .filter((d) => filters.every(([f, v]) => (d[f] ?? null) === v))
            .map((d) => ({ data: () => ({ ...d, date: { toDate: () => d.date } }) }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        },
      };
      return q;
    },
  };
  return db;
}

describe("firestoreStore.existingTransactionCounts", () => {
  const saved = (id, over = {}) => ({
    id, userId: "alice", source: "import", accountId: "acct-checking", sourceStatementId: "imp1",
    date: new Date("2026-09-02T12:00:00Z"), merchant: "STARBUCKS", amount: -6.45, ...over,
  });

  test("counts what other imports saved for the same user and account", async () => {
    const db = fakeFirestore([saved("a"), saved("b"), saved("c", { merchant: "KWIK TRIP", amount: -42.18 })]);
    const store = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    const counts = await store.existingTransactionCounts({ accountId: "acct-checking" });
    assert.equal(counts.size, 2);
    assert.equal(counts.get(duplicateKey(saved("x"))), 2);
  });

  test("ignores this import's own documents, so a re-run is not skipped", async () => {
    const db = fakeFirestore([saved("a"), saved("b", { sourceStatementId: "imp2" })]);
    const store = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    const counts = await store.existingTransactionCounts({ accountId: "acct-checking" });
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 1);
  });

  test("ignores other users, other accounts and manual transactions", async () => {
    const db = fakeFirestore([
      saved("a", { userId: "bob" }),
      saved("b", { accountId: "acct-savings" }),
      saved("c", { source: "manual" }),
    ]);
    const store = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    assert.equal((await store.existingTransactionCounts({ accountId: "acct-checking" })).size, 0);
  });

  test("transactions from a deleted statement don't count, so the file can be imported again", async () => {
    const db = fakeFirestore([saved("a", { deletedAt: new Date() }), saved("b", { deletedAt: null })]);
    const store = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    const counts = await store.existingTransactionCounts({ accountId: "acct-checking" });
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 1);
  });

  test("an import with no account only matches other imports with no account", async () => {
    const db = fakeFirestore([saved("a", { accountId: null }), saved("b")]);
    const store = createStore({ db, uid: "alice", importId: "imp2", serverTimestamp: stamp });
    const counts = await store.existingTransactionCounts({ accountId: null });
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 1);
  });
});

/** Fake store for the pipeline, with a list of already-saved transactions. */
function fakeStore(alreadySaved = new Map(), { failLookup = false } = {}) {
  const s = {
    updates: [],
    written: [],
    async update(patch) { s.updates.push(patch); },
    async writeTransactions(docs) { s.written.push(...docs); },
    async deleteTransactions() {},
    async existingTransactionCounts() {
      if (failLookup) throw new Error("firestore down");
      return alreadySaved;
    },
  };
  return s;
}
const run = (store, rows) =>
  processImport({ fileBuffer: csv(rows), fileType: "csv", uid: "alice", importId: "imp2", accountId: "acct-checking", store, logger: silentLogger });

describe("processImport: overlapping statements (SCRUM-136)", () => {
  const rows = [
    ["2026-09-28", "KWIK TRIP #412", "-42.18"],
    ["2026-09-29", "STARBUCKS #1187", "-6.45"],
    ["2026-10-01", "ACME PAYROLL", "1850.00"],
  ];
  const keyFor = (r) => duplicateKey({ accountId: "acct-checking", date: new Date(`${r[0]}T12:00:00Z`), amount: Number(r[2]), merchant: r[1] });

  test("rows an earlier statement already saved are skipped and counted", async () => {
    const store = fakeStore(new Map([[keyFor(rows[0]), 1], [keyFor(rows[1]), 1]]));
    const result = await run(store, rows);
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 1);
    assert.equal(result.duplicateRowCount, 2);
    assert.deepEqual(store.written.map((d) => d.merchant), ["ACME PAYROLL"]);
    assert.equal(store.updates.at(-1).duplicateRowCount, 2);
    assert.equal(store.updates.at(-1).transactionCount, 1);
  });

  test("a file with no overlap imports everything and reports zero duplicates", async () => {
    const result = await run(fakeStore(), rows);
    assert.equal(result.transactionCount, 3);
    assert.equal(result.duplicateRowCount, 0);
  });

  test("a file where every row was already imported is marked failed with a clear message", async () => {
    const store = fakeStore(new Map(rows.map((r) => [keyFor(r), 1])));
    const result = await run(store, rows);
    assert.equal(result.status, "failed");
    assert.equal(result.error, ALL_DUPLICATES);
    assert.equal(store.written.length, 0);
    assert.equal(store.updates.at(-1).status, "failed");
  });

  test("if the duplicate check fails, the import still saves everything", async () => {
    const store = fakeStore(new Map(), { failLookup: true });
    const result = await run(store, rows);
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 3);
    assert.equal(result.duplicateRowCount, 0);
  });

  test("duplicates are removed before categorizing, so they never reach the AI", async () => {
    const store = fakeStore(new Map([[keyFor(rows[0]), 1]]));
    let categorized = [];
    await processImport({
      fileBuffer: csv(rows), fileType: "csv", uid: "alice", importId: "imp2", accountId: "acct-checking", store, logger: silentLogger,
      categorizer: async (docs) => { categorized = docs; return { docs, summary: {} }; },
    });
    assert.equal(categorized.length, 2);
  });
});
