/**
 * Tests for scripts/convertToCents.js (SCRUM-151).
 * No Firebase needed: the script gets the small in-memory fake below, which supports
 * only the Admin SDK calls the script makes.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { convertToCents, plan } = require("../scripts/convertToCents");

const silentLogger = { info() {}, warn() {}, error() {} };
const DELETE = Symbol("delete");
const deleteField = () => DELETE;

/** A pretend Firestore: a Map of "path" -> data. */
function fakeDb(initial = {}) {
  const data = new Map(Object.entries(initial));
  const snapOf = (path) => ({ id: path.split("/").pop(), ref: { path }, data: () => data.get(path) });
  return {
    data,
    writes: 0,
    collection(name) {
      return { async get() { const docs = [...data.keys()].filter((k) => k.split("/").length === 2 && k.startsWith(`${name}/`)).map(snapOf); return { docs }; } };
    },
    collectionGroup(name) {
      return { async get() { const docs = [...data.keys()].filter((k) => k.split("/").length === 4 && k.split("/")[2] === name).map(snapOf); return { docs }; } };
    },
    batch() {
      const ops = [];
      const db = this;
      return {
        update(ref, fields) { ops.push(() => {
          const doc = { ...data.get(ref.path) };
          for (const [k, v] of Object.entries(fields)) { if (v === DELETE) delete doc[k]; else doc[k] = v; }
          data.set(ref.path, doc);
          db.writes++;
        }); },
        async commit() { ops.forEach((op) => op()); },
      };
    },
  };
}

const run = (db, opts = {}) => convertToCents({ db, deleteField, logger: silentLogger, ...opts });

describe("convertToCents", () => {
  test("gives transactions and budgets their cents and keeps the dollar fields", async () => {
    const db = fakeDb({
      "transactions/t1": { amount: -12.34, category: "dining" },
      "transactions/t2": { amount: 1850, category: "income" },
      "users/alice/budgets/dining": { limit: 250, categoryId: "dining" },
    });

    const report = await run(db);

    assert.deepEqual(db.data.get("transactions/t1"), { amount: -12.34, amountCents: -1234, category: "dining" });
    assert.equal(db.data.get("transactions/t2").amountCents, 185000);
    assert.deepEqual(db.data.get("users/alice/budgets/dining"), { limit: 250, limitCents: 25000, categoryId: "dining" });
    assert.equal(report.transactions.converted, 2);
    assert.equal(report.budgets.converted, 1);
  });

  test("rounds the dollar float to the nearest cent (19.99, 0.1 + 0.2, -4.35)", async () => {
    const db = fakeDb({
      "transactions/a": { amount: 19.99 },
      "transactions/b": { amount: 0.1 + 0.2 },
      "transactions/c": { amount: -4.35 },
    });
    await run(db);
    assert.equal(db.data.get("transactions/a").amountCents, 1999);
    assert.equal(db.data.get("transactions/b").amountCents, 30);
    assert.equal(db.data.get("transactions/c").amountCents, -435);
  });

  test("converts soft-deleted documents too and changes nothing else", async () => {
    const deleted = { amount: -5, deletedAt: "2026-10-01", purgeAfter: "2026-10-31", category: "dining", updatedAt: "x" };
    const db = fakeDb({ "transactions/t1": deleted });
    await run(db);
    assert.deepEqual(db.data.get("transactions/t1"), { ...deleted, amountCents: -500 });
  });

  test("leaves documents that already have cents alone, and a second run changes nothing", async () => {
    const db = fakeDb({
      "transactions/new": { amountCents: -645, amount: -6.45 },
      "transactions/old": { amount: -3 },
    });
    await run(db);
    const writesAfterFirst = db.writes;
    const second = await run(db);
    assert.equal(db.writes, writesAfterFirst);
    assert.equal(second.transactions.converted, 0);
    assert.equal(second.transactions.alreadyCents, 2);
  });

  test("--dry-run only counts and writes nothing", async () => {
    const db = fakeDb({ "transactions/t1": { amount: -1 }, "users/a/budgets/x": { limit: 5 } });
    const report = await run(db, { dryRun: true, removeDollars: true });
    assert.deepEqual(db.data.get("transactions/t1"), { amount: -1 });
    assert.equal(db.writes, 0);
    assert.equal(report.transactions.converted, 1);
    assert.equal(report.budgets.converted, 1);
  });

  test("--remove-dollars also removes amount and limit, from converted and already-converted documents", async () => {
    const db = fakeDb({
      "transactions/old": { amount: -3, category: "dining" },
      "transactions/new": { amountCents: -645, amount: -6.45 },
      "users/a/budgets/x": { limit: 5 },
    });
    const report = await run(db, { removeDollars: true });
    assert.deepEqual(db.data.get("transactions/old"), { amountCents: -300, category: "dining" });
    assert.deepEqual(db.data.get("transactions/new"), { amountCents: -645 });
    assert.deepEqual(db.data.get("users/a/budgets/x"), { limitCents: 500 });
    assert.equal(report.transactions.dollarsRemoved, 2);
  });

  test("reports and skips documents with no usable amount, a negative limit, or disagreeing fields", async () => {
    const db = fakeDb({
      "transactions/none": { category: "dining" },
      "transactions/text": { amount: "12.50" },
      "transactions/clash": { amountCents: -500, amount: -6 },
      "users/a/budgets/neg": { limit: -10 },
    });
    const report = await run(db, { removeDollars: true });
    assert.equal(report.transactions.problems.length, 2);
    assert.deepEqual(report.transactions.mismatched, ["transactions/clash"]);
    assert.equal(report.budgets.problems.length, 1);
    // None of them was changed, not even the dollar field of the disagreeing one
    assert.deepEqual(db.data.get("transactions/clash"), { amountCents: -500, amount: -6 });
    assert.deepEqual(db.data.get("users/a/budgets/neg"), { limit: -10 });
    assert.equal(db.writes, 0);
  });

  test("an empty database is fine", async () => {
    const report = await run(fakeDb());
    assert.equal(report.transactions.total, 0);
    assert.equal(report.budgets.total, 0);
  });
});

describe("plan", () => {
  test("a budget limit of 0 is valid", () => {
    assert.deepEqual(plan({ limit: 0 }, "limitCents", "limit").set, { limitCents: 0 });
  });
});
