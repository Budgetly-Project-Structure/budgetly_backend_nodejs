/**
 * Tests for scripts/scanTransactions.js (SCRUM-119), the read-only admin scan.
 * No Firebase needed: the scan gets a fake database that can only be read.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { scanTransactions, findFlags } = require("../scripts/scanTransactions");

const txn = (id, userId, extra = {}) => ({ id, userId, date: "2026-10-05", merchant: "ALDI", amount: -20, deletedAt: null, ...extra });

describe("findFlags", () => {
  test("flags every extra copy of the same user's same day + merchant + amount", () => {
    const flags = findFlags([txn("a1", "alice"), txn("a2", "alice"), txn("a3", "alice")]);
    assert.deepEqual(flags.map((f) => [f.userId, f.transactionId]), [["alice", "a2"], ["alice", "a3"]]);
    assert.match(flags[0].reason, /^duplicate of a1/);
  });

  test("the same purchase by two different users is not a duplicate", () => {
    assert.deepEqual(findFlags([txn("a1", "alice"), txn("b1", "bob")]), []);
  });

  test("a different day, merchant or amount is not a duplicate", () => {
    const flags = findFlags([
      txn("a1", "alice"),
      txn("a2", "alice", { date: "2026-10-06" }),
      txn("a3", "alice", { merchant: "TARGET" }),
      txn("a4", "alice", { amount: -21 }),
    ]);
    assert.deepEqual(flags, []);
  });

  test("merchant case and extra spaces don't hide a duplicate; Timestamps and Dates work", () => {
    const ts = { toDate: () => new Date("2026-10-05T12:00:00Z") };
    const flags = findFlags([txn("a1", "alice", { date: ts }), txn("a2", "alice", { merchant: " aldi ", date: new Date("2026-10-05T12:00:00Z") })]);
    assert.deepEqual(flags.map((f) => f.transactionId), ["a2"]);
  });

  test("flags amounts at or above the threshold, spent or received", () => {
    const flags = findFlags([txn("a1", "alice", { amount: -5000 }), txn("a2", "alice", { amount: 7500, merchant: "PAYROLL" }), txn("a3", "alice", { amount: -4999.99, merchant: "X" })]);
    assert.deepEqual(flags.map((f) => f.transactionId), ["a1", "a2"]);
    assert.match(flags[0].reason, /large amount -5000 \(threshold 5000\)/);
  });

  test("the threshold can be changed", () => {
    assert.equal(findFlags([txn("a1", "alice", { amount: -600 })], { threshold: 500 }).length, 1);
  });

  test("soft-deleted transactions are skipped", () => {
    assert.deepEqual(findFlags([txn("a1", "alice"), txn("a2", "alice", { deletedAt: "yesterday", amount: -20 }), txn("a3", "alice", { deletedAt: "x", amount: -9000 })]), []);
  });
});

describe("scanTransactions", () => {
  /** A read-only fake: transactions/ with orderBy(__name__), limit and startAfter, and NO write methods. */
  function readOnlyDb(docs) {
    const sorted = Object.entries(docs).sort(([a], [b]) => a.localeCompare(b));
    let reads = 0;
    const query = (after, n) => ({
      limit: (m) => query(after, m),
      startAfter: (snap) => query(snap.id, n),
      async get() {
        reads++;
        const page = sorted.filter(([id]) => after == null || id > after).slice(0, n).map(([id, d]) => ({ id, data: () => d }));
        return { docs: page, size: page.length, empty: page.length === 0 };
      },
    });
    return {
      get reads() { return reads; },
      collection: (name) => {
        assert.equal(name, "transactions");
        return { orderBy: (field) => { assert.equal(field, "__name__"); return query(null, Infinity); } };
      },
      // Any attempt to write would throw: there is no batch(), set(), update() or delete()
    };
  }

  test("reads every user's transactions across pages and reports the flags", async () => {
    const docs = {};
    for (let i = 0; i < 7; i++) docs[`alice_${i}`] = { userId: "alice", date: `2026-10-0${i + 1}`, merchant: "SHOP", amount: -10, deletedAt: null };
    docs.alice_dup = { userId: "alice", date: "2026-10-01", merchant: "SHOP", amount: -10, deletedAt: null };
    docs.bob_big = { userId: "bob", date: "2026-10-01", merchant: "CAR", amount: -12000, deletedAt: null };
    const db = readOnlyDb(docs);

    const result = await scanTransactions({ db, pageSize: 3 });

    assert.equal(result.scanned, 9);
    assert.equal(result.users, 2);
    assert.deepEqual(result.flags.map((f) => [f.userId, f.transactionId]).sort(), [["alice", "alice_dup"], ["bob", "bob_big"]]);
    assert.ok(db.reads >= 3, "read in several pages");
  });

  test("an empty database gives an empty report", async () => {
    assert.deepEqual(await scanTransactions({ db: readOnlyDb({}) }), { scanned: 0, users: 0, flags: [] });
  });
});
