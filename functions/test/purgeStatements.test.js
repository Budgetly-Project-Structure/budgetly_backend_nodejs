/**
 * Tests for SCRUM-122: the daily purge also removes deleted statements whose
 * 30 days are up (purgeImports in purgeJob.js): the import record, any of its
 * transactions still left, the file in Storage, and an "import.purged" audit entry.
 * No Firebase or network needed: everything runs on the in-memory fake below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { purgeImports, runPurge } = require("../lib/purgeJob");

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-15T09:00:00Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);
const expired = (extra = {}) => ({ deletedAt: daysFromNow(-31), deletedBy: "alice", purgeAfter: daysFromNow(-1), ...extra });

/** A statement as the import pipeline + softDeleteImport leave it. */
function importDoc(uid, importId, extra = {}) {
  return {
    status: "completed",
    fileName: `${importId}.csv`,
    storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
    transactionCount: 2,
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
    ...extra,
  };
}

/**
 * A pretend Firestore with what purgeImports uses: a collectionGroup("imports")
 * query on purgeAfter <= now, equality queries on transactions, batched deletes,
 * and a doc delete that's refused when the doc changed after it was read.
 */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, { data, version: 1 }]));
  const ms = (v) => (v == null ? null : v.getTime());
  const ref = (path) => {
    const parts = path.split("/");
    return {
      path,
      id: parts[parts.length - 1],
      parent: { parent: { id: parts[parts.length - 3] } },
      async delete(precondition) {
        const cur = docs.get(path);
        if (!cur || (precondition && precondition.lastUpdateTime !== cur.version)) throw new Error("precondition failed");
        docs.delete(path);
      },
    };
  };
  const snapOf = (path) => {
    const d = docs.get(path);
    const seen = d.data;
    return { id: path.split("/").pop(), ref: ref(path), updateTime: d.version, data: () => seen };
  };
  const result = (paths) => ({ docs: paths.map(snapOf), size: paths.length, empty: paths.length === 0 });

  return {
    docs,
    collectionGroup(name) {
      assert.equal(name, "imports");
      let max = Infinity;
      let before = null;
      const q = {
        where(field, op, value) {
          assert.deepEqual([field, op], ["purgeAfter", "<="]);
          before = value;
          return q;
        },
        limit(n) { max = n; return q; },
        async get() {
          const paths = [...docs.keys()]
            .filter((p) => p.split("/").slice(-2)[0] === "imports")
            .filter((p) => docs.get(p).data.purgeAfter != null && ms(docs.get(p).data.purgeAfter) <= ms(before))
            .slice(0, max);
          return result(paths);
        },
      };
      return q;
    },
    collection(name) {
      assert.equal(name, "transactions");
      const filters = [];
      let max = Infinity;
      const q = {
        where(field, op, value) { assert.equal(op, "=="); filters.push([field, value]); return q; },
        limit(n) { max = n; return q; },
        async get() {
          const paths = [...docs.keys()]
            .filter((p) => p.startsWith("transactions/"))
            .filter((p) => filters.every(([f, v]) => docs.get(p).data[f] === v))
            .slice(0, max);
          return result(paths);
        },
      };
      return q;
    },
    batch() {
      const ops = [];
      return { delete: (r) => ops.push(r.path), commit: async () => ops.forEach((p) => docs.delete(p)) };
    },
    // Simulates the user restoring a statement while the job runs
    restore(path) {
      const d = docs.get(path);
      d.data = { ...d.data, deletedAt: null, deletedBy: null, purgeAfter: null };
      d.version++;
    },
  };
}

/** Runs purgeImports on `db` with a fake Storage and audit log. */
async function run(db, { files = new Set(), deleteFileError = null } = {}) {
  const audit = [];
  const deletedFiles = [];
  const result = await purgeImports({
    db,
    now: NOW,
    nowMs: NOW.getTime(),
    limit: 400,
    maxPages: 50,
    deleteFile: async (path) => {
      if (deleteFileError) throw deleteFileError;
      if (!files.has(path)) { const e = new Error("No such object"); e.code = 404; throw e; }
      files.delete(path);
      deletedFiles.push(path);
    },
    writeAudit: async (entry) => audit.push(entry),
    logger: silentLogger,
  });
  return { result, audit, deletedFiles, files };
}

const txn = (uid, importId, extra = {}) => ({ userId: uid, sourceStatementId: importId, source: "import", ...expired(), ...extra });

// ---------------------------------------------------------------------------
describe("purgeImports", () => {
  test("an expired statement: record, leftover transactions and file are removed, with an import.purged audit entry", async () => {
    const imp = importDoc("alice", "imp1", expired());
    const db = fakeDb({
      "users/alice/imports/imp1": imp,
      "transactions/alice_imp1_1": txn("alice", "imp1"),
    });
    const files = new Set([imp.storagePath]);

    const { result, audit, deletedFiles } = await run(db, { files });

    assert.deepEqual(result, { deleted: 1, skipped: 0 });
    assert.equal(db.docs.has("users/alice/imports/imp1"), false);
    assert.equal(db.docs.has("transactions/alice_imp1_1"), false);
    assert.deepEqual(deletedFiles, [imp.storagePath]);
    assert.deepEqual(audit, [{
      userId: "alice",
      action: "import.purged",
      targetPath: "users/alice/imports/imp1",
      actor: "system",
      details: { fileName: "imp1.csv", transactionCount: 2 },
    }]);
  });

  test("a statement deleted recently (purgeAfter still in the future) is kept", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", expired({ purgeAfter: daysFromNow(5) })) });
    const { result, audit } = await run(db);
    assert.deepEqual(result, { deleted: 0, skipped: 0 });
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
    assert.deepEqual(audit, []);
  });

  test("an active (or restored) statement is never touched, nor its transactions or file", async () => {
    const imp = importDoc("alice", "imp1");
    const db = fakeDb({
      "users/alice/imports/imp1": imp,
      "transactions/alice_imp1_1": txn("alice", "imp1", { deletedAt: null, deletedBy: null, purgeAfter: null }),
    });
    const files = new Set([imp.storagePath]);
    await run(db, { files });
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
    assert.equal(db.docs.has("transactions/alice_imp1_1"), true);
    assert.equal(files.has(imp.storagePath), true);
  });

  test("a purgeAfter without deletedAt is skipped (never delete on the query alone)", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", { purgeAfter: daysFromNow(-1) }) });
    const { result } = await run(db);
    assert.deepEqual(result, { deleted: 0, skipped: 1 });
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
  });

  test("a file that's already gone is fine: the record is still removed and audited", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", expired()) });
    const { result, audit } = await run(db, { files: new Set() });
    assert.equal(result.deleted, 1);
    assert.equal(db.docs.has("users/alice/imports/imp1"), false);
    assert.equal(audit.length, 1);
  });

  test("another user's data is untouched, even with the same import id", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1", expired()),
      "users/bob/imports/imp1": importDoc("bob", "imp1"),
      "transactions/bob_imp1_1": txn("bob", "imp1", { deletedAt: null, deletedBy: null, purgeAfter: null }),
    });
    const files = new Set(["users/bob/imports/1700000000000_imp1.csv"]);
    await run(db, { files });
    assert.equal(db.docs.has("users/alice/imports/imp1"), false);
    assert.equal(db.docs.has("users/bob/imports/imp1"), true);
    assert.equal(db.docs.has("transactions/bob_imp1_1"), true);
    assert.equal(files.has("users/bob/imports/1700000000000_imp1.csv"), true);
  });

  test("a file outside the owner's own folder is never deleted", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", expired({ storagePath: "users/bob/imports/1_x.csv" })) });
    const files = new Set(["users/bob/imports/1_x.csv"]);
    await run(db, { files });
    assert.equal(files.has("users/bob/imports/1_x.csv"), true);
  });

  test("a statement restored while the job runs is left alone, and so is its file", async () => {
    const imp = importDoc("alice", "imp1", expired());
    const db = fakeDb({ "users/alice/imports/imp1": imp });
    const files = new Set([imp.storagePath]);
    // The restore lands after the job read the page but before it deletes
    const realGroup = db.collectionGroup.bind(db);
    db.collectionGroup = (name) => {
      const q = realGroup(name);
      const realGet = q.get;
      const wrap = { where: (...a) => { q.where(...a); return wrap; }, limit: (n) => { q.limit(n); return wrap; }, get: async () => {
        const snap = await realGet();
        if (!snap.empty) db.restore("users/alice/imports/imp1");
        return snap;
      } };
      return wrap;
    };

    const { result, audit } = await run(db, { files });

    assert.deepEqual(result, { deleted: 0, skipped: 1 });
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
    assert.equal(files.has(imp.storagePath), true);
    assert.deepEqual(audit, []);
  });

  test("more than 400 leftover transactions are removed in several batches", async () => {
    const initial = { "users/alice/imports/imp1": importDoc("alice", "imp1", expired()) };
    for (let i = 0; i < 950; i++) initial[`transactions/alice_imp1_${i}`] = txn("alice", "imp1", { purgeAfter: daysFromNow(3) });
    const db = fakeDb(initial);
    await run(db);
    assert.equal([...db.docs.keys()].filter((k) => k.startsWith("transactions/")).length, 0);
  });

  test("running it again finds nothing left and writes no new audit entries", async () => {
    const imp = importDoc("alice", "imp1", expired());
    const db = fakeDb({ "users/alice/imports/imp1": imp });
    await run(db, { files: new Set([imp.storagePath]) });
    const again = await run(db);
    assert.deepEqual(again.result, { deleted: 0, skipped: 0 });
    assert.deepEqual(again.audit, []);
  });
});

describe("runPurge without deleteFile/writeAudit", () => {
  test("leaves statements alone and reports imports: 0 (as before SCRUM-122)", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", expired()) });
    // runPurge also queries transactions and budgets; give them empty answers
    const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, get: async () => ({ docs: [], size: 0, empty: true }) };
    db.collection = () => emptyQuery;
    const realGroup = db.collectionGroup.bind(db);
    db.collectionGroup = (name) => (name === "budgets" ? emptyQuery : realGroup(name));

    const result = await runPurge({ db, now: NOW, logger: silentLogger });

    assert.equal(result.imports, 0);
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
  });
});
