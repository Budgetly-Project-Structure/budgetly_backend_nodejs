/**
 * Tests for purgeJob.js (SCRUM-127): the daily job that permanently removes
 * transactions and budgets the user deleted more than 30 days ago.
 * No Firebase or network needed: runPurge gets the in-memory fake database below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { runPurge, isDue } = require("../lib/purgeJob");

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-30T09:00:00Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);
// What the app writes when something is soft deleted / when it is active
const deleted = (extra = {}) => ({ deletedAt: daysFromNow(-30), deletedBy: "u1", purgeAfter: daysFromNow(-1), ...extra });
const active = (extra = {}) => ({ deletedAt: null, deletedBy: null, purgeAfter: null, ...extra });

/**
 * A pretend Firestore with just what the purge job uses: collection() and
 * collectionGroup() queries with where("purgeAfter", "<=", date) and limit(),
 * and a bulkWriter whose delete() is refused when the document changed after it was read.
 */
function fakeDb(initial) {
  // path -> { data, version }. The version stands in for Firestore's updateTime.
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, { data, version: 1 }]));
  const stats = { reads: 0 };

  const ms = (v) => (v == null ? null : v.toMillis ? v.toMillis() : v.getTime());
  const refFor = (path) => ({ path });

  function query(matchPath) {
    const filters = [];
    let max = Infinity;
    const q = {
      where(field, op, value) {
        assert.equal(op, "<=", "the purge job should only ask for purgeAfter <= now");
        filters.push({ field, value });
        return q;
      },
      limit(n) {
        max = n;
        return q;
      },
      async get() {
        stats.reads++;
        const found = [...docs.entries()]
          .filter(([path]) => matchPath(path))
          // Like Firestore, an inequality never matches a missing or null field
          .filter(([, d]) => filters.every((f) => d.data[f.field] != null && ms(d.data[f.field]) <= ms(f.value)))
          .slice(0, max)
          .map(([path, d]) => {
            // What the job sees is a snapshot from the moment of reading
            const seen = d.data;
            return { ref: refFor(path), updateTime: d.version, data: () => seen };
          });
        return { docs: found, size: found.length, empty: found.length === 0 };
      },
    };
    return q;
  }

  return {
    docs,
    stats,
    collection: (name) => query((path) => path.split("/").length === 2 && path.startsWith(`${name}/`)),
    collectionGroup: (name) => query((path) => path.split("/").slice(-2)[0] === name),
    bulkWriter() {
      let onError = () => false;
      const pending = [];
      return {
        onWriteError(fn) {
          onError = fn;
        },
        delete(ref, precondition) {
          const p = (async () => {
            const current = docs.get(ref.path);
            if (!current || (precondition && precondition.lastUpdateTime !== current.version)) {
              onError(new Error("precondition failed"));
              throw new Error("precondition failed");
            }
            docs.delete(ref.path);
          })();
          pending.push(p.catch(() => {}));
          return p;
        },
        async close() {
          await Promise.all(pending);
        },
      };
    },
    // Simulates the user restoring something while the job runs
    restore(path) {
      const d = docs.get(path);
      d.data = { ...d.data, ...active() };
      d.version++;
    },
  };
}

const run = (db, extra = {}) => runPurge({ db, now: NOW, logger: silentLogger, ...extra });

describe("isDue", () => {
  test("is true only when deletedAt is set and purgeAfter has passed", () => {
    assert.equal(isDue(deleted(), NOW.getTime()), true);
    assert.equal(isDue(deleted({ purgeAfter: NOW }), NOW.getTime()), true, "exactly now counts as due");
    assert.equal(isDue(deleted({ purgeAfter: daysFromNow(1) }), NOW.getTime()), false);
    assert.equal(isDue(active(), NOW.getTime()), false);
    assert.equal(isDue(deleted({ deletedAt: null }), NOW.getTime()), false);
    assert.equal(isDue(deleted({ purgeAfter: null }), NOW.getTime()), false);
    assert.equal(isDue(undefined, NOW.getTime()), false);
  });

  test("reads Firestore Timestamps as well as Dates", () => {
    const ts = (date) => ({ toMillis: () => date.getTime() });
    assert.equal(isDue({ deletedAt: ts(daysFromNow(-31)), purgeAfter: ts(daysFromNow(-1)) }, NOW.getTime()), true);
    assert.equal(isDue({ deletedAt: ts(daysFromNow(-1)), purgeAfter: ts(daysFromNow(29)) }, NOW.getTime()), false);
  });
});

describe("runPurge: what it removes", () => {
  test("removes expired manual transactions and expired budgets", async () => {
    const db = fakeDb({
      "transactions/t1": { userId: "u1", source: "manual", ...deleted() },
      "transactions/t2": { userId: "u2", source: "manual", ...deleted() },
      "users/u1/budgets/dining": { categoryId: "dining", limit: 200, ...deleted() },
      "users/u2/budgets/groceries": { categoryId: "groceries", limit: 400, ...deleted() },
    });
    const result = await run(db);
    assert.deepEqual(result, { transactions: 2, budgets: 2, skipped: 0 });
    assert.equal(db.docs.size, 0);
  });

  test("keeps things deleted recently (purgeAfter still in the future)", async () => {
    const db = fakeDb({
      "transactions/t1": { userId: "u1", ...deleted({ deletedAt: daysFromNow(-5), purgeAfter: daysFromNow(25) }) },
      "users/u1/budgets/dining": { ...deleted({ deletedAt: daysFromNow(-29), purgeAfter: daysFromNow(1) }) },
    });
    const result = await run(db);
    assert.deepEqual(result, { transactions: 0, budgets: 0, skipped: 0 });
    assert.equal(db.docs.size, 2);
  });

  test("never touches active transactions, budgets or imported transactions", async () => {
    const db = fakeDb({
      "transactions/manual": { userId: "u1", source: "manual", ...active() },
      "transactions/imported": { userId: "u1", source: "import", ...active() },
      // an older document written before soft delete existed has none of the fields
      "transactions/legacy": { userId: "u1", merchant: "Old" },
      "users/u1/budgets/dining": { categoryId: "dining", limit: 200, ...active() },
      "users/u1/budgets/legacy": { categoryId: "legacy", limit: 50 },
      "users/u1": { email: "a@b.com" },
      "users/u1/imports/imp1": { fileName: "a.csv", status: "completed" },
      "users/u1/merchantCache/starbucks": { merchantKey: "STARBUCKS", category: "dining" },
    });
    const result = await run(db);
    assert.deepEqual(result, { transactions: 0, budgets: 0, skipped: 0 });
    assert.equal(db.docs.size, 8);
  });

  test("removes only the expired ones from a mixed set", async () => {
    const db = fakeDb({
      "transactions/old": { userId: "u1", ...deleted() },
      "transactions/new": { userId: "u1", ...deleted({ deletedAt: daysFromNow(-2), purgeAfter: daysFromNow(28) }) },
      "transactions/live": { userId: "u1", ...active() },
    });
    await run(db);
    assert.deepEqual([...db.docs.keys()].sort(), ["transactions/live", "transactions/new"]);
  });

  test("does nothing when there is nothing to remove", async () => {
    const db = fakeDb({});
    assert.deepEqual(await run(db), { transactions: 0, budgets: 0, skipped: 0 });
  });

  test("a second run finds nothing left to remove", async () => {
    const db = fakeDb({ "transactions/t1": { userId: "u1", ...deleted() } });
    assert.equal((await run(db)).transactions, 1);
    assert.equal((await run(db)).transactions, 0);
  });
});

describe("runPurge: safety", () => {
  test("a restore while the job runs is not deleted", async () => {
    const db = fakeDb({
      "transactions/t1": { userId: "u1", ...deleted() },
      "transactions/t2": { userId: "u1", ...deleted() },
    });
    // The user restores t1 after the job read it but before it deleted it
    const realBulkWriter = db.bulkWriter;
    db.bulkWriter = function () {
      db.restore("transactions/t1");
      return realBulkWriter.call(db);
    };
    const result = await run(db);
    assert.deepEqual(result, { transactions: 1, budgets: 0, skipped: 1 });
    assert.deepEqual([...db.docs.keys()], ["transactions/t1"]);
    assert.equal(db.docs.get("transactions/t1").data.deletedAt, null, "t1 is still restored");
  });

  test("a document without deletedAt is skipped even if the query returned it", async () => {
    // purgeAfter has passed but deletedAt is missing: not something the app writes, so don't delete
    const db = fakeDb({ "transactions/odd": { userId: "u1", deletedAt: null, deletedBy: null, purgeAfter: daysFromNow(-3) } });
    const result = await run(db);
    assert.deepEqual(result, { transactions: 0, budgets: 0, skipped: 1 });
    assert.equal(db.docs.size, 1);
  });

  test("stops instead of looping when nothing in a page can be removed", async () => {
    const db = fakeDb({
      "transactions/odd1": { userId: "u1", deletedAt: null, purgeAfter: daysFromNow(-3) },
      "transactions/odd2": { userId: "u1", deletedAt: null, purgeAfter: daysFromNow(-3) },
    });
    await run(db, { limit: 2 });
    assert.ok(db.stats.reads <= 4, `read ${db.stats.reads} times`); // 1 per collection, never repeating
  });
});

describe("runPurge: paging", () => {
  test("removes more than one page of expired documents", async () => {
    const initial = {};
    for (let i = 0; i < 7; i++) initial[`transactions/t${i}`] = { userId: "u1", ...deleted() };
    initial["transactions/keep"] = { userId: "u1", ...active() };
    const db = fakeDb(initial);
    const result = await run(db, { limit: 3 });
    assert.equal(result.transactions, 7);
    assert.deepEqual([...db.docs.keys()], ["transactions/keep"]);
  });

  test("stops at maxPages", async () => {
    const initial = {};
    for (let i = 0; i < 10; i++) initial[`transactions/t${i}`] = { userId: "u1", ...deleted() };
    const db = fakeDb(initial);
    const result = await run(db, { limit: 2, maxPages: 2 });
    assert.equal(result.transactions, 4); // 2 pages of 2; the rest wait for the next run
    assert.equal(db.docs.size, 6);
  });
});
