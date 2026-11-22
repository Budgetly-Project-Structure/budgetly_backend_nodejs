/**
 * Tests for scripts/removeImportCopies.js (Sprint 5 #2): the one-time cleanup that
 * removes transactionCount, accountType, fileName and fileType from import records.
 * No Firebase needed: it runs on the in-memory fake below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { removeImportCopies, copiedFieldsIn, BATCH_SIZE } = require("../scripts/removeImportCopies");

const silentLogger = { info() {} };
const DELETE = Symbol("delete");

/**
 * A pretend Firestore with what the script uses: a paged collectionGroup("imports")
 * query and batched updates where DELETE removes a field.
 */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial));
  const commits = [];
  const ref = (path) => {
    const parts = path.split("/");
    // users/{uid}/imports/{id} -> ref.parent (imports) .parent (users/{uid}) .parent (users)
    return {
      path,
      id: parts.at(-1),
      parent: { id: parts.at(-2), parent: { id: parts.at(-3), parent: { id: parts.at(-4) } } },
    };
  };
  return {
    docs,
    commits,
    collectionGroup(name) {
      assert.equal(name, "imports");
      let max = Infinity;
      let after = null;
      const q = {
        orderBy(field) { assert.equal(field, "__name__"); return q; },
        limit(n) { max = n; return q; },
        startAfter(snap) { after = snap.ref.path; return q; },
        async get() {
          const paths = [...docs.keys()]
            .filter((p) => p.split("/").at(-2) === "imports")
            .sort()
            .filter((p) => after == null || p > after)
            .slice(0, max);
          const list = paths.map((p) => ({ ref: ref(p), data: () => docs.get(p) }));
          return { docs: list, size: list.length, empty: list.length === 0 };
        },
      };
      return q;
    },
    batch() {
      const ops = [];
      return {
        update(r, fields) {
          ops.push(() => {
            const next = { ...docs.get(r.path) };
            for (const [k, v] of Object.entries(fields)) {
              if (v === DELETE) delete next[k];
              else next[k] = v;
            }
            docs.set(r.path, next);
          });
        },
        async commit() {
          assert.ok(ops.length <= BATCH_SIZE, `batch of ${ops.length}`);
          commits.push(ops.length);
          ops.forEach((op) => op());
        },
      };
    },
  };
}

const run = (db, opts = {}) => removeImportCopies({ db, deleteField: () => DELETE, logger: silentLogger, ...opts });

/** An import record as the old backend wrote it. */
const oldImport = (extra = {}) => ({
  fileName: "1700000000000_sept.csv",
  storagePath: "users/alice/imports/1700000000000_sept.csv",
  fileType: "csv",
  accountId: "acct-checking",
  accountType: "checking",
  detectedAccountType: "checking",
  status: "completed",
  transactionCount: 36,
  skippedRowCount: 0,
  ...extra,
});

describe("copiedFieldsIn", () => {
  test("lists only the copied fields a record has", () => {
    assert.deepEqual(copiedFieldsIn(oldImport()), ["transactionCount", "accountType", "fileName", "fileType"]);
    assert.deepEqual(copiedFieldsIn({ status: "failed", transactionCount: 0 }), ["transactionCount"]);
    assert.deepEqual(copiedFieldsIn({ status: "completed" }), []);
  });
});

describe("removeImportCopies", () => {
  test("removes the four copied fields and keeps everything else", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": oldImport() });
    const report = await run(db);
    assert.deepEqual(db.docs.get("users/alice/imports/imp1"), {
      storagePath: "users/alice/imports/1700000000000_sept.csv",
      accountId: "acct-checking",
      detectedAccountType: "checking",
      status: "completed",
      skippedRowCount: 0,
    });
    assert.equal(report.checked, 1);
    assert.equal(report.toChange, 1);
    assert.equal(report.changed, 1);
    assert.deepEqual(report.fields, { transactionCount: 1, accountType: 1, fileName: 1, fileType: 1 });
  });

  test("--dry-run counts but writes nothing", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": oldImport(), "users/bob/imports/imp2": oldImport({ accountType: null }) });
    const report = await run(db, { dryRun: true });
    assert.equal(report.toChange, 2);
    assert.equal(report.changed, 0);
    assert.deepEqual(db.commits, []);
    assert.equal(db.docs.get("users/alice/imports/imp1").transactionCount, 36);
  });

  test("a field that is null still counts as a copy and is removed", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": oldImport({ accountType: null }) });
    await run(db);
    assert.equal("accountType" in db.docs.get("users/alice/imports/imp1"), false);
  });

  test("running it twice: the second run changes nothing", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": oldImport(), "users/alice/imports/imp2": { status: "completed", storagePath: "users/alice/imports/2_x.pdf" } });
    await run(db);
    const before = JSON.stringify([...db.docs]);
    const again = await run(db);
    assert.equal(again.checked, 2);
    assert.equal(again.toChange, 0);
    assert.equal(again.changed, 0);
    assert.equal(JSON.stringify([...db.docs]), before);
  });

  test("leaves other collections and other 'imports' collections alone", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": oldImport(),
      "admin/x/imports/y": { fileName: "keep.csv", transactionCount: 1 },
      "transactions/alice_imp1_00001": { userId: "alice", sourceStatementId: "imp1" },
    });
    const report = await run(db);
    assert.equal(report.checked, 1);
    assert.deepEqual(db.docs.get("admin/x/imports/y"), { fileName: "keep.csv", transactionCount: 1 });
  });

  test("many records: every page is read and batches stay at 400 or fewer", async () => {
    const initial = {};
    for (let i = 0; i < 950; i++) initial[`users/u${String(i).padStart(4, "0")}/imports/imp`] = oldImport();
    const db = fakeDb(initial);
    const report = await run(db, { pageSize: 300 });
    assert.equal(report.checked, 950);
    assert.equal(report.changed, 950);
    assert.ok(db.commits.every((n) => n <= BATCH_SIZE));
    assert.ok([...db.docs.values()].every((d) => copiedFieldsIn(d).length === 0));
  });
});
