/**
 * Tests for purgeJob.js (SCRUM-127, SCRUM-122, Sprint 5 #12): after 30 days the daily
 * job moves what users deleted into the admin-only archive instead of deleting it.
 * No Firebase or network needed: everything runs on the in-memory fakes below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { runArchive, runPurge, isDue, archiveFilePath, MOVE_BATCH_SIZE } = require("../lib/purgeJob");

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-15T09:00:00Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);
// What the app writes when something is soft deleted / when it is active
const expired = (extra = {}) => ({ deletedAt: daysFromNow(-31), deletedBy: "alice", purgeAfter: daysFromNow(-1), ...extra });
const recent = (extra = {}) => ({ deletedAt: daysFromNow(-2), deletedBy: "alice", purgeAfter: daysFromNow(28), ...extra });
const active = (extra = {}) => ({ deletedAt: null, deletedBy: null, purgeAfter: null, ...extra });
const STAMP = "ARCHIVED_AT";

/**
 * A pretend Firestore with what the archive job uses: collection() and collectionGroup()
 * queries (== and <=), doc refs, and batches that are all-or-nothing, where a delete
 * carrying lastUpdateTime is refused if the document changed after it was read.
 * `failSetsFor` makes writing an archive copy fail for the given live paths.
 */
function fakeDb(initial, { failSetsFor = [] } = {}) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, { data, version: 1 }]));
  const stats = { batches: [] };
  const ms = (v) => (v == null ? null : v.getTime ? v.getTime() : v);

  const refFor = (path) => {
    const parts = path.split("/");
    return {
      path,
      id: parts.at(-1),
      parent: { id: parts.at(-2), parent: parts.length >= 4 ? { id: parts.at(-3) } : null },
    };
  };
  const snapOf = (path) => {
    const d = docs.get(path);
    const seen = d.data;
    return { id: path.split("/").at(-1), ref: refFor(path), updateTime: d.version, data: () => seen };
  };
  function query(matchPath) {
    const filters = [];
    let max = Infinity;
    const q = {
      where(field, op, value) { filters.push([field, op, value]); return q; },
      limit(n) { max = n; return q; },
      async get() {
        const paths = [...docs.keys()]
          .filter(matchPath)
          .filter((p) => filters.every(([f, op, v]) => {
            const x = docs.get(p).data[f];
            if (op === "==") return x === v;
            if (op === "<=") return x != null && ms(x) <= ms(v); // like Firestore: no null/missing
            throw new Error(`unsupported op ${op}`);
          }))
          .sort()
          .slice(0, max);
        const list = paths.map(snapOf);
        return { docs: list, size: list.length, empty: list.length === 0 };
      },
    };
    return q;
  }
  const db = {
    docs,
    stats,
    collection: (name) => ({
      ...query((p) => p.split("/").length === 2 && p.startsWith(`${name}/`)),
      doc: (id) => refFor(`${name}/${id}`),
    }),
    collectionGroup: (name) => query((p) => p.split("/").at(-2) === name),
    batch() {
      const ops = [];
      return {
        set: (ref, data) => ops.push({ kind: "set", ref, data }),
        delete: (ref, precondition) => ops.push({ kind: "delete", ref, precondition }),
        async commit() {
          assert.ok(ops.length <= 2 * MOVE_BATCH_SIZE, `batch of ${ops.length} writes`);
          // Check everything first: a batch is all or nothing
          for (const op of ops) {
            if (op.kind === "set" && failSetsFor.some((p) => ops.some((o) => o.kind === "delete" && o.ref.path === p))) {
              throw new Error("write failed");
            }
            if (op.kind === "delete" && op.precondition) {
              const cur = docs.get(op.ref.path);
              if (!cur || cur.version !== op.precondition.lastUpdateTime) throw new Error("precondition failed");
            }
          }
          for (const op of ops) {
            if (op.kind === "set") docs.set(op.ref.path, { data: op.data, version: (docs.get(op.ref.path)?.version ?? 0) + 1 });
            else docs.delete(op.ref.path);
          }
          stats.batches.push(ops.length);
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
  return db;
}

/** A pretend Storage bucket: a set of file paths. */
function fakeFiles(paths = []) {
  const files = new Set(paths);
  return {
    files,
    async exists(p) { return files.has(p); },
    async copy(from, to) {
      if (!files.has(from)) throw Object.assign(new Error("No such object"), { code: 404 });
      files.add(to);
    },
    async remove(p) { files.delete(p); },
  };
}

const run = (db, extra = {}) => {
  const audit = [];
  const files = extra.files ?? fakeFiles();
  return runArchive({
    db,
    now: NOW,
    files,
    writeAudit: async (e) => audit.push(e),
    serverTimestamp: () => STAMP,
    logger: silentLogger,
    ...extra,
  }).then((result) => ({ result, audit, files }));
};

const txn = (uid, importId, extra = {}) => ({ userId: uid, sourceStatementId: importId, source: "import", amountCents: -645, amount: -6.45, merchant: "Starbucks", ...expired(), ...extra });
const importDoc = (uid, importId, extra = {}) => ({
  status: "completed",
  storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
  accountId: "acct-checking",
  ...expired(),
  ...extra,
});

// ---------------------------------------------------------------------------
describe("isDue", () => {
  test("is true only when deletedAt is set and purgeAfter has passed", () => {
    assert.equal(isDue(expired(), NOW.getTime()), true);
    assert.equal(isDue(expired({ purgeAfter: NOW }), NOW.getTime()), true, "exactly now counts as due");
    assert.equal(isDue(recent(), NOW.getTime()), false);
    assert.equal(isDue(active(), NOW.getTime()), false);
    assert.equal(isDue(expired({ deletedAt: null }), NOW.getTime()), false);
    assert.equal(isDue(undefined, NOW.getTime()), false);
  });

  test("reads Firestore Timestamps as well as Dates", () => {
    const ts = (date) => ({ toMillis: () => date.getTime() });
    assert.equal(isDue({ deletedAt: ts(daysFromNow(-31)), purgeAfter: ts(daysFromNow(-1)) }, NOW.getTime()), true);
  });
});

// ---------------------------------------------------------------------------
describe("manual transactions, budgets and accounts", () => {
  test("an expired item is moved intact to its archive collection and is gone from the live data", async () => {
    const t = { userId: "alice", source: "manual", merchant: "Farmers market", amountCents: -1200, amount: -12, category: "groceries", ...expired() };
    const b = { categoryId: "dining", limitCents: 25000, limit: 250, ...expired() };
    const a = { userId: "alice", type: "checking", institution: "Chase", last4: "4521", ...expired() };
    const db = fakeDb({ "transactions/m1": t, "users/alice/budgets/dining": b, "accounts/acc1": a });

    const { result } = await run(db);

    assert.deepEqual(result, { imports: 0, transactions: 1, budgets: 1, accounts: 1, skipped: 0 });
    assert.equal(db.docs.has("transactions/m1"), false);
    assert.equal(db.docs.has("users/alice/budgets/dining"), false);
    assert.equal(db.docs.has("accounts/acc1"), false);
    assert.deepEqual(db.docs.get("archive_transactions/m1").data, { ...t, userId: "alice", originalPath: "transactions/m1", archivedAt: STAMP });
    assert.deepEqual(db.docs.get("archive_budgets/alice_dining").data, { ...b, userId: "alice", originalPath: "users/alice/budgets/dining", archivedAt: STAMP });
    assert.deepEqual(db.docs.get("archive_accounts/alice_acc1").data, { ...a, userId: "alice", originalPath: "accounts/acc1", archivedAt: STAMP });
  });

  test("nothing moves before its purgeAfter, and active or older documents are never touched", async () => {
    const initial = {
      "transactions/new": { userId: "alice", ...recent() },
      "transactions/live": { userId: "alice", source: "manual", ...active() },
      "transactions/legacy": { userId: "alice", merchant: "Old" }, // written before soft delete existed
      "users/alice/budgets/dining": { categoryId: "dining", limitCents: 100, ...recent() },
      "users/alice/budgets/live": { categoryId: "live", limitCents: 5000, ...active() },
      "accounts/a1": { userId: "alice", type: "credit", ...recent() },
      "users/alice/imports/imp1": importDoc("alice", "imp1", recent()),
      "users/alice/merchantCache/starbucks": { merchantKey: "STARBUCKS", category: "dining" },
    };
    const db = fakeDb(initial);
    const { result } = await run(db);
    assert.deepEqual(result, { imports: 0, transactions: 0, budgets: 0, accounts: 0, skipped: 0 });
    assert.deepEqual([...db.docs.keys()].sort(), Object.keys(initial).sort());
  });

  test("a purgeAfter without deletedAt is skipped (never move on the query alone)", async () => {
    const db = fakeDb({ "transactions/odd": { userId: "alice", deletedAt: null, purgeAfter: daysFromNow(-1) } });
    const { result } = await run(db);
    assert.equal(result.transactions, 0);
    assert.equal(db.docs.has("transactions/odd"), true);
    assert.equal(db.docs.has("archive_transactions/odd"), false);
  });

  test("something restored after the job read it is left alone, and the rest of its batch still moves", async () => {
    const db = fakeDb({ "transactions/a": { userId: "alice", ...expired() }, "transactions/b": { userId: "alice", ...expired() } });
    const realCollection = db.collection;
    db.collection = (name) => {
      const c = realCollection(name);
      if (name !== "transactions") return c;
      const realWhere = c.where;
      return { ...c, where: (...w) => {
        const q = realWhere(...w);
        const realLimit = q.limit;
        q.limit = (n) => { realLimit(n); return { get: async () => { const s = await q.get(); db.restore("transactions/a"); return s; } }; };
        return q;
      } };
    };
    const { result } = await run(db);
    assert.equal(result.transactions, 1);
    assert.equal(db.docs.has("transactions/a"), true, "the restored one stays live");
    assert.equal(db.docs.has("archive_transactions/a"), false, "and is not in the archive");
    assert.equal(db.docs.has("archive_transactions/b"), true);
  });

  test("if writing the archive copy fails, the original is kept (never in neither place)", async () => {
    const db = fakeDb({ "transactions/a": { userId: "alice", ...expired() } }, { failSetsFor: ["transactions/a"] });
    const { result } = await run(db);
    assert.equal(result.transactions, 0);
    assert.equal(db.docs.has("transactions/a"), true);
    assert.equal(db.docs.has("archive_transactions/a"), false);
  });

  test("many items move in batches of 400 writes or fewer", async () => {
    const initial = {};
    for (let i = 0; i < 950; i++) initial[`transactions/t${String(i).padStart(4, "0")}`] = { userId: "alice", ...expired() };
    const db = fakeDb(initial);
    const { result } = await run(db);
    assert.equal(result.transactions, 950);
    assert.ok(db.stats.batches.every((n) => n <= 400));
    assert.equal([...db.docs.keys()].filter((k) => k.startsWith("transactions/")).length, 0);
  });

  test("running it again finds nothing more to move", async () => {
    const db = fakeDb({ "transactions/m1": { userId: "alice", ...expired() }, "users/alice/budgets/x": { categoryId: "x", ...expired() } });
    await run(db);
    const before = JSON.stringify([...db.docs]);
    const { result } = await run(db);
    assert.deepEqual(result, { imports: 0, transactions: 0, budgets: 0, accounts: 0, skipped: 0 });
    assert.equal(JSON.stringify([...db.docs]), before);
  });

  test("runPurge is the same job (old name kept for existing callers)", () => {
    assert.equal(runPurge, runArchive);
  });
});

// ---------------------------------------------------------------------------
describe("statements", () => {
  test("an expired statement: record, transactions and file move to the archive, with an import.archived entry", async () => {
    const imp = importDoc("alice", "imp1");
    const db = fakeDb({
      "users/alice/imports/imp1": imp,
      "transactions/alice_imp1_00002": txn("alice", "imp1"),
      "transactions/alice_imp1_00003": txn("alice", "imp1", { amountCents: 185000, amount: 1850 }),
    });
    const files = fakeFiles([imp.storagePath]);

    const { result, audit } = await run(db, { files });

    assert.deepEqual(result, { imports: 1, transactions: 0, budgets: 0, accounts: 0, skipped: 0 });
    // live data gone
    assert.equal(db.docs.has("users/alice/imports/imp1"), false);
    assert.equal([...db.docs.keys()].some((k) => k.startsWith("transactions/")), false);
    // archive complete and intact
    assert.deepEqual(db.docs.get("archive_imports/alice_imp1").data, {
      ...imp,
      userId: "alice",
      originalPath: "users/alice/imports/imp1",
      archivedAt: STAMP,
      archivedFilePath: "archive/users/alice/imports/1700000000000_imp1.csv",
    });
    assert.equal(db.docs.get("archive_transactions/alice_imp1_00003").data.amountCents, 185000);
    assert.equal(db.docs.get("archive_transactions/alice_imp1_00003").data.originalPath, "transactions/alice_imp1_00003");
    // file moved
    assert.deepEqual([...files.files], ["archive/users/alice/imports/1700000000000_imp1.csv"]);
    // audit
    assert.deepEqual(audit, [{
      userId: "alice",
      action: "import.archived",
      targetPath: "users/alice/imports/imp1",
      actor: "system",
      details: { fileName: "1700000000000_imp1.csv", transactionCount: 2, archivedFilePath: "archive/users/alice/imports/1700000000000_imp1.csv" },
    }]);
  });

  test("a statement still within its 30 days is not touched, nor its transactions or file", async () => {
    const imp = importDoc("alice", "imp1", recent());
    const db = fakeDb({ "users/alice/imports/imp1": imp, "transactions/alice_imp1_00002": txn("alice", "imp1", recent()) });
    const files = fakeFiles([imp.storagePath]);
    const { result, audit } = await run(db, { files });
    assert.equal(result.imports, 0);
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
    assert.equal(db.docs.has("transactions/alice_imp1_00002"), true);
    assert.deepEqual([...files.files], [imp.storagePath]);
    assert.deepEqual(audit, []);
  });

  test("a file that's already gone is fine: the rest is archived and archivedFilePath is null", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1") });
    const { result, audit } = await run(db, { files: fakeFiles() });
    assert.equal(result.imports, 1);
    assert.equal(db.docs.get("archive_imports/alice_imp1").data.archivedFilePath, null);
    assert.equal(audit[0].details.archivedFilePath, null);
  });

  test("a file outside the owner's own folder is never touched", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1", { storagePath: "users/bob/imports/1_x.csv" }) });
    const files = fakeFiles(["users/bob/imports/1_x.csv"]);
    await run(db, { files });
    assert.deepEqual([...files.files], ["users/bob/imports/1_x.csv"]);
  });

  test("another user's data is untouched, even with the same import id", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1"),
      "users/bob/imports/imp1": importDoc("bob", "imp1", active()),
      "transactions/bob_imp1_00002": txn("bob", "imp1", active()),
    });
    await run(db, { files: fakeFiles(["users/bob/imports/1700000000000_imp1.csv"]) });
    assert.equal(db.docs.has("users/bob/imports/imp1"), true);
    assert.equal(db.docs.has("transactions/bob_imp1_00002"), true);
  });

  test("statements go first, so their transactions are counted with them, not in the sweep", async () => {
    const initial = { "users/alice/imports/imp1": importDoc("alice", "imp1"), "transactions/manual": { userId: "alice", source: "manual", ...expired() } };
    for (let i = 0; i < 450; i++) initial[`transactions/alice_imp1_${String(i).padStart(5, "0")}`] = txn("alice", "imp1");
    const db = fakeDb(initial);
    const { result, audit } = await run(db);
    assert.equal(result.imports, 1);
    assert.equal(result.transactions, 1, "the sweep only found the manual one");
    assert.equal(audit[0].details.transactionCount, 450);
    assert.ok(db.stats.batches.every((n) => n <= 400));
  });

  test("a re-run after a failure part way finishes the job and counts every transaction", async () => {
    const imp = importDoc("alice", "imp1");
    const db = fakeDb({
      "users/alice/imports/imp1": imp,
      "transactions/alice_imp1_00002": txn("alice", "imp1"),
      "transactions/alice_imp1_00003": txn("alice", "imp1"),
    });
    const files = fakeFiles([imp.storagePath]);
    // First run dies after the transactions and the file were moved (the record move fails)
    const realBatch = db.batch;
    db.batch = () => {
      const b = realBatch();
      const touched = [];
      const realDelete = b.delete;
      b.delete = (ref, pre) => { touched.push(ref.path); return realDelete(ref, pre); };
      const realCommit = b.commit;
      // Any batch that moves the import record fails (also the one-at-a-time retry)
      b.commit = async () => {
        if (touched.includes("users/alice/imports/imp1")) throw new Error("outage");
        return realCommit();
      };
      return b;
    };
    const first = await run(db, { files });
    assert.equal(first.result.imports, 0);
    assert.equal(db.docs.has("users/alice/imports/imp1"), true, "record still live and due");
    assert.equal(db.docs.has("archive_transactions/alice_imp1_00002"), true);
    assert.deepEqual([...files.files], ["archive/users/alice/imports/1700000000000_imp1.csv"], "file already moved");

    db.batch = realBatch;
    const second = await run(db, { files });
    assert.equal(second.result.imports, 1);
    assert.equal(db.docs.has("users/alice/imports/imp1"), false);
    assert.equal(db.docs.get("archive_imports/alice_imp1").data.archivedFilePath, "archive/users/alice/imports/1700000000000_imp1.csv");
    assert.equal(second.audit[0].details.transactionCount, 2, "count read from the archive");
  });

  test("an error on one statement doesn't stop the others", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1"), "users/bob/imports/imp2": importDoc("bob", "imp2") });
    const files = fakeFiles(["users/alice/imports/1700000000000_imp1.csv", "users/bob/imports/1700000000000_imp2.csv"]);
    const realCopy = files.copy;
    files.copy = async (from, to) => { if (from.includes("alice")) throw new Error("storage hiccup"); return realCopy(from, to); };
    const { result } = await run(db, { files });
    assert.equal(result.imports, 1);
    assert.equal(db.docs.has("users/alice/imports/imp1"), true, "alice's stays for tomorrow");
    assert.equal(db.docs.has("users/bob/imports/imp2"), false);
  });

  test("without Storage and audit wiring, statements are left alone", async () => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1") });
    const result = await runArchive({ db, now: NOW, serverTimestamp: () => STAMP, logger: silentLogger });
    assert.equal(result.imports, 0);
    assert.equal(db.docs.has("users/alice/imports/imp1"), true);
  });

  test("running it again finds nothing left and writes no new audit entries", async () => {
    const imp = importDoc("alice", "imp1");
    const db = fakeDb({ "users/alice/imports/imp1": imp, "transactions/alice_imp1_00002": txn("alice", "imp1") });
    const files = fakeFiles([imp.storagePath]);
    await run(db, { files });
    const again = await run(db, { files });
    assert.deepEqual(again.result, { imports: 0, transactions: 0, budgets: 0, accounts: 0, skipped: 0 });
    assert.deepEqual(again.audit, []);
  });

  test("archiveFilePath puts the file under archive/", () => {
    assert.equal(archiveFilePath("users/a/imports/1_x.csv"), "archive/users/a/imports/1_x.csv");
  });
});
