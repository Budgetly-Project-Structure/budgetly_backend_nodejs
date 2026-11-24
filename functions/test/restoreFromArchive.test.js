/**
 * Tests for scripts/restoreFromArchive.js (SCRUM-157) and, with it, the round trip that
 * SCRUM-156 asks for: what the daily archive job moves away (lib/purgeJob.js, SCRUM-155)
 * comes back exactly as it was. No Firebase or network needed: everything runs on the
 * in-memory fakes below.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { runArchive } = require("../lib/purgeJob");
const { restoreFromArchive, parseArgs, originalData, RestoreError } = require("../scripts/restoreFromArchive");

const silentLogger = { info() {}, warn() {}, error() {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-15T09:00:00Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);
const expired = (extra = {}) => ({ deletedAt: daysFromNow(-31), deletedBy: "alice", purgeAfter: daysFromNow(-1), ...extra });
const active = () => ({ deletedAt: null, deletedBy: null, purgeAfter: null });
const STAMP = "ARCHIVED_AT";

/**
 * A pretend Firestore with what the archive job and the restore script use: collection()
 * and collectionGroup() queries (== and <=), doc refs with get() and collection(), and
 * batches that are all-or-nothing (create is refused if the document exists; a delete
 * carrying lastUpdateTime is refused if the document changed after it was read).
 * `failCreateAt` is a Set of live paths whose create fails (to simulate a stop part way).
 */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial).map(([path, data]) => [path, { data, version: 1 }]));
  const stats = { batches: [] };
  const failCreateAt = new Set();
  const ms = (v) => (v == null ? null : v.getTime ? v.getTime() : v);

  const refFor = (path) => {
    const parts = path.split("/");
    const ref = {
      path,
      id: parts.at(-1),
      parent: { id: parts.at(-2), parent: parts.length >= 4 ? { id: parts.at(-3) } : null },
      collection: (name) => ({ doc: (id) => refFor(`${path}/${name}/${id}`) }),
      async get() {
        return docs.has(path) ? snapOf(path) : { exists: false, id: ref.id, ref, data: () => undefined };
      },
    };
    return ref;
  };
  const snapOf = (path) => {
    const d = docs.get(path);
    const seen = d.data;
    return { exists: true, id: path.split("/").at(-1), ref: refFor(path), updateTime: d.version, data: () => seen };
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
    failCreateAt,
    collection: (name) => ({
      ...query((p) => p.split("/").length === 2 && p.startsWith(`${name}/`)),
      doc: (id) => refFor(`${name}/${id}`),
    }),
    collectionGroup: (name) => query((p) => p.split("/").at(-2) === name),
    batch() {
      const ops = [];
      return {
        set: (ref, data) => ops.push({ kind: "set", ref, data }),
        create: (ref, data) => ops.push({ kind: "create", ref, data }),
        delete: (ref, precondition) => ops.push({ kind: "delete", ref, precondition }),
        async commit() {
          assert.ok(ops.length <= 400, `batch of ${ops.length} writes`);
          // Check everything first: a batch is all or nothing
          for (const op of ops) {
            if (op.kind === "create" && (docs.has(op.ref.path) || failCreateAt.has(op.ref.path))) throw new Error(`create refused at ${op.ref.path}`);
            if (op.kind === "delete" && op.precondition) {
              const cur = docs.get(op.ref.path);
              if (!cur || cur.version !== op.precondition.lastUpdateTime) throw new Error("precondition failed");
            }
          }
          for (const op of ops) {
            if (op.kind === "set" || op.kind === "create") docs.set(op.ref.path, { data: op.data, version: (docs.get(op.ref.path)?.version ?? 0) + 1 });
            else docs.delete(op.ref.path);
          }
          stats.batches.push(ops.length);
        },
      };
    },
    paths: (prefix) => [...docs.keys()].filter((p) => p.startsWith(prefix)),
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

/** Runs the daily archive job, as the scheduler would. */
const archive = (db, files) =>
  runArchive({ db, now: NOW, files, writeAudit: async () => {}, serverTimestamp: () => STAMP, logger: silentLogger });

/** Runs the restore script's function. */
const restore = (db, opts) => {
  const audit = [];
  const files = opts.files ?? fakeFiles();
  return restoreFromArchive({ db, files, writeAudit: async (e) => audit.push(e), logger: silentLogger, ...opts }).then((result) => ({ result, audit, files }));
};
const restoreFails = async (db, opts, pattern) => {
  const audit = [];
  await assert.rejects(
    restoreFromArchive({ db, files: opts.files ?? fakeFiles(), writeAudit: async (e) => audit.push(e), logger: silentLogger, ...opts }),
    (err) => err instanceof RestoreError && pattern.test(err.message),
  );
  assert.deepEqual(audit, [], "a refused restore writes no audit entry");
};

const snapshotOf = (db) => JSON.stringify([...db.docs.entries()]);
const STORAGE = (uid, importId) => `users/${uid}/imports/1700000000000_${importId}.csv`;
const txn = (uid, importId, n, extra = {}) => ({ userId: uid, sourceStatementId: importId, source: "import", amountCents: -100 * n, merchant: `Shop ${n}`, category: "shopping", ...expired(), ...extra });
const importDoc = (uid, importId, extra = {}) => ({ status: "completed", storagePath: STORAGE(uid, importId), accountId: "acct-checking", ...expired(), ...extra });

// ---------------------------------------------------------------------------
describe("originalData", () => {
  test("removes what the archive added and makes the record active again", () => {
    const archived = { userId: "alice", merchant: "X", archivedAt: STAMP, originalPath: "transactions/t1", archivedFilePath: null, ...expired() };
    assert.deepEqual(originalData(archived, { keepUserId: true }), { userId: "alice", merchant: "X", ...active() });
    assert.deepEqual(originalData(archived, { keepUserId: false }), { merchant: "X", ...active() });
  });
});

// ---------------------------------------------------------------------------
describe("round trip: archive, then restore (SCRUM-156 and 157)", () => {
  test("a manual transaction comes back exactly as it was, active, with an audit entry", async () => {
    const original = { userId: "alice", source: "manual", merchant: "Farmers market", amountCents: -1234, category: "groceries", createdAt: "C", updatedAt: "U" };
    const db = fakeDb({ "transactions/m1": { ...original, ...expired() } });
    await archive(db, fakeFiles());
    assert.equal(db.docs.has("transactions/m1"), false);

    const { result, audit } = await restore(db, { userId: "alice", kind: "transaction", id: "m1" });
    assert.equal(result.details.originalPath, "transactions/m1");
    assert.deepEqual(db.docs.get("transactions/m1").data, { ...original, ...active() });
    assert.equal(db.docs.has("archive_transactions/m1"), false, "the archive copy is gone");
    assert.deepEqual(audit, [{ userId: "alice", action: "transaction.unarchived", targetPath: "transactions/m1", actor: "admin", details: {} }]);
  });

  test("a budget comes back at users/{uid}/budgets/{categoryId} without the userId the archive added", async () => {
    const original = { limitCents: 25000, source: "user", updatedAt: "U" };
    const db = fakeDb({ "users/alice/budgets/dining": { ...original, ...expired() } });
    await archive(db, fakeFiles());
    assert.ok(db.docs.has("archive_budgets/alice_dining"));

    const { audit } = await restore(db, { userId: "alice", kind: "budget", id: "dining" });
    assert.deepEqual(db.docs.get("users/alice/budgets/dining").data, { ...original, ...active() });
    assert.equal(db.docs.has("archive_budgets/alice_dining"), false);
    assert.equal(audit[0].action, "budget.unarchived");
    assert.equal(audit[0].targetPath, "users/alice/budgets/dining");
  });

  test("an account comes back at accounts/{id}", async () => {
    const original = { userId: "alice", type: "checking", institution: "Chase", last4: "4521", nickname: "Main" };
    const db = fakeDb({ "accounts/acc1": { ...original, ...expired() } });
    await archive(db, fakeFiles());
    assert.ok(db.docs.has("archive_accounts/alice_acc1"));

    const { audit } = await restore(db, { userId: "alice", kind: "account", id: "acc1" });
    assert.deepEqual(db.docs.get("accounts/acc1").data, { ...original, ...active() });
    assert.equal(audit[0].action, "account.unarchived");
  });

  test("a statement comes back whole: the record, every transaction and the file", async () => {
    const record = { status: "completed", storagePath: STORAGE("alice", "imp1"), accountId: "acct-checking", updatedAt: "U" };
    const db = fakeDb({
      "users/alice/imports/imp1": { ...record, ...expired() },
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
      "transactions/alice_imp1_2": txn("alice", "imp1", 2),
      "transactions/alice_imp1_3": txn("alice", "imp1", 3),
    });
    const files = fakeFiles([STORAGE("alice", "imp1")]);
    await archive(db, files);
    assert.equal(db.paths("transactions/").length, 0);
    assert.ok(files.files.has(`archive/${STORAGE("alice", "imp1")}`));

    const { result, audit } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    assert.deepEqual(result.details, { transactions: 3, file: "moved back" });
    assert.deepEqual(db.docs.get("users/alice/imports/imp1").data, { ...record, ...active() });
    assert.equal(db.paths("transactions/").length, 3);
    assert.deepEqual(db.docs.get("transactions/alice_imp1_2").data, { ...txn("alice", "imp1", 2), ...active() });
    assert.equal(db.paths("archive_").length, 0, "nothing is left in the archive");
    assert.deepEqual([...files.files], [STORAGE("alice", "imp1")], "the file is back and the archived copy is gone");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0], {
      userId: "alice",
      action: "import.unarchived",
      targetPath: "users/alice/imports/imp1",
      actor: "admin",
      details: { fileName: "1700000000000_imp1.csv", transactionCount: 3 },
    });
  });

  test("what was restored is not archived again by the next daily run", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1"),
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
      "transactions/m1": { userId: "alice", source: "manual", merchant: "M", amountCents: -500, ...expired() },
    });
    const files = fakeFiles([STORAGE("alice", "imp1")]);
    await archive(db, files);
    await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    await restore(db, { userId: "alice", kind: "transaction", id: "m1" });

    const again = await archive(db, files);
    assert.deepEqual(again, { imports: 0, transactions: 0, budgets: 0, accounts: 0, skipped: 0 });
    assert.equal(db.paths("archive_").length, 0);
  });

  test("another user's archived data is not touched by a restore", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1"),
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
      "users/bob/imports/imp1": importDoc("bob", "imp1", { deletedBy: "bob" }),
      "transactions/bob_imp1_1": txn("bob", "imp1", 1, { deletedBy: "bob" }),
    });
    const files = fakeFiles([STORAGE("alice", "imp1"), STORAGE("bob", "imp1")]);
    await archive(db, files);
    await restore(db, { userId: "alice", kind: "import", id: "imp1", files });

    assert.ok(db.docs.has("users/alice/imports/imp1"));
    assert.ok(db.docs.has("archive_imports/bob_imp1"), "bob's statement is still archived");
    assert.ok(db.docs.has("archive_transactions/bob_imp1_1"));
    assert.ok(files.files.has(`archive/${STORAGE("bob", "imp1")}`));
    assert.equal(db.docs.has("users/bob/imports/imp1"), false);
  });
});

// ---------------------------------------------------------------------------
describe("statements: edge cases", () => {
  const archivedStatement = async (extraDocs = {}, fileList = [STORAGE("alice", "imp1")]) => {
    const db = fakeDb({ "users/alice/imports/imp1": importDoc("alice", "imp1"), "transactions/alice_imp1_1": txn("alice", "imp1", 1), ...extraDocs });
    const files = fakeFiles(fileList);
    await archive(db, files);
    return { db, files };
  };

  test("a statement whose file was already gone is restored without it", async () => {
    const { db, files } = await archivedStatement({}, []);
    assert.equal(db.docs.get("archive_imports/alice_imp1").data.archivedFilePath, null);
    const { result } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    assert.deepEqual(result.details, { transactions: 1, file: "none" });
    assert.ok(db.docs.has("users/alice/imports/imp1"));
    assert.equal(files.files.size, 0);
  });

  test("a big statement comes back in batches of 400 writes or fewer", async () => {
    const many = {};
    for (let i = 2; i <= 450; i++) many[`transactions/alice_imp1_${i}`] = txn("alice", "imp1", i);
    const { db, files } = await archivedStatement(many);
    db.stats.batches.length = 0;

    const { result, audit } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    assert.equal(result.details.transactions, 450);
    assert.equal(db.paths("transactions/").length, 450);
    assert.ok(db.stats.batches.every((n) => n <= 400));
    assert.equal(audit[0].details.transactionCount, 450);
  });

  test("a run that stops before the record is put back is finished by running it again", async () => {
    const { db, files } = await archivedStatement({ "transactions/alice_imp1_2": txn("alice", "imp1", 2) });
    db.failCreateAt.add("users/alice/imports/imp1");

    const audit = [];
    await assert.rejects(restoreFromArchive({ db, files, writeAudit: async (e) => audit.push(e), userId: "alice", kind: "import", id: "imp1", logger: silentLogger }));
    assert.equal(db.paths("transactions/").length, 2, "the transactions already moved back");
    assert.ok(db.docs.has("archive_imports/alice_imp1"), "the record is still safe in the archive");
    assert.deepEqual(audit, []);

    db.failCreateAt.clear();
    const { audit: audit2 } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    assert.ok(db.docs.has("users/alice/imports/imp1"));
    assert.equal(db.paths("archive_").length, 0);
    assert.equal(audit2.length, 1);
    assert.equal(audit2[0].details.transactionCount, 2, "the count includes the ones moved by the first run");
  });

  test("a file left at the original location by an interrupted run is simply written again", async () => {
    const { db, files } = await archivedStatement();
    files.files.add(STORAGE("alice", "imp1")); // what the first, interrupted run copied back
    const { result } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files });
    assert.deepEqual(result.details, { transactions: 1, file: "moved back" });
    assert.deepEqual([...files.files], [STORAGE("alice", "imp1")]);
    assert.ok(db.docs.has("users/alice/imports/imp1"));
  });

  test("--dry-run checks everything and writes nothing", async () => {
    const { db, files } = await archivedStatement();
    const before = snapshotOf(db);
    const filesBefore = [...files.files];
    const { result, audit } = await restore(db, { userId: "alice", kind: "import", id: "imp1", files, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.details, { transactions: 1, file: "moved back" });
    assert.equal(snapshotOf(db), before);
    assert.deepEqual([...files.files], filesBefore);
    assert.deepEqual(audit, []);
  });

  test("a dry run on a single record writes nothing either", async () => {
    const db = fakeDb({ "transactions/m1": { userId: "alice", source: "manual", merchant: "M", amountCents: -500, ...expired() } });
    await archive(db, fakeFiles());
    const before = snapshotOf(db);
    const { result, audit } = await restore(db, { userId: "alice", kind: "transaction", id: "m1", dryRun: true });
    assert.equal(result.details.originalPath, "transactions/m1");
    assert.equal(snapshotOf(db), before);
    assert.deepEqual(audit, []);
  });
});

// ---------------------------------------------------------------------------
describe("refusals: nothing is changed", () => {
  test("something already at the original path is never overwritten", async () => {
    const db = fakeDb({ "transactions/m1": { userId: "alice", source: "manual", merchant: "M", amountCents: -500, ...expired() } });
    await archive(db, fakeFiles());
    db.docs.set("transactions/m1", { data: { userId: "alice", merchant: "A newer one" }, version: 1 });
    const before = snapshotOf(db);
    await restoreFails(db, { userId: "alice", kind: "transaction", id: "m1" }, /already exists at transactions\/m1/);
    assert.equal(snapshotOf(db), before);
  });

  test("a statement is refused when one of its transactions has been replaced, and nothing moves", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1"),
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
      "transactions/alice_imp1_2": txn("alice", "imp1", 2),
    });
    const files = fakeFiles([STORAGE("alice", "imp1")]);
    await archive(db, files);
    db.docs.set("transactions/alice_imp1_2", { data: { userId: "alice", merchant: "In the way" }, version: 1 });
    const before = snapshotOf(db);
    await restoreFails(db, { userId: "alice", kind: "import", id: "imp1", files }, /already exists at transactions\/alice_imp1_2/);
    assert.equal(snapshotOf(db), before);
    assert.ok(files.files.has(`archive/${STORAGE("alice", "imp1")}`));
  });

  test("the record must belong to the user you named", async () => {
    const db = fakeDb({ "transactions/m1": { userId: "alice", source: "manual", merchant: "M", amountCents: -500, ...expired() } });
    await archive(db, fakeFiles());
    const before = snapshotOf(db);
    await restoreFails(db, { userId: "bob", kind: "transaction", id: "m1" }, /belongs to someone else/);
    assert.equal(snapshotOf(db), before);
  });

  test("nothing in the archive gives a clear message", async () => {
    const db = fakeDb({});
    await restoreFails(db, { userId: "alice", kind: "budget", id: "dining" }, /Nothing archived for budget dining/);
    await restoreFails(db, { userId: "alice", kind: "import", id: "nope" }, /Nothing archived for statement nope/);
  });

  test("a transaction of an archived statement can't be restored alone", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1"),
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
    });
    await archive(db, fakeFiles([STORAGE("alice", "imp1")]));
    const before = snapshotOf(db);
    await restoreFails(db, { userId: "alice", kind: "transaction", id: "alice_imp1_1" }, /Restore the statement with --import imp1/);
    assert.equal(snapshotOf(db), before);
  });

  test("a transaction of a statement that is live again can be restored", async () => {
    const db = fakeDb({
      "users/alice/imports/imp1": importDoc("alice", "imp1", active()),
      "transactions/alice_imp1_1": txn("alice", "imp1", 1),
    });
    // Only the transaction was archived (for example a statement restored by hand first)
    await archive(db, fakeFiles());
    assert.ok(db.docs.has("archive_transactions/alice_imp1_1"));
    await restore(db, { userId: "alice", kind: "transaction", id: "alice_imp1_1" });
    assert.ok(db.docs.has("transactions/alice_imp1_1"));
  });

  test("ids that could reach another path are refused", async () => {
    const db = fakeDb({});
    await restoreFails(db, { userId: "alice", kind: "budget", id: "../bob_dining" }, /needs an id/);
    await restoreFails(db, { userId: "a/b", kind: "budget", id: "dining" }, /needs a user id/);
    await restoreFails(db, { userId: "", kind: "budget", id: "dining" }, /needs a user id/);
    await restoreFails(db, { userId: "alice", kind: "everything", id: "x" }, /Say what to restore/);
  });
});

// ---------------------------------------------------------------------------
describe("parseArgs", () => {
  test("reads the user, what to restore and --dry-run", () => {
    assert.deepEqual(parseArgs(["--user", "u1", "--import", "i1", "--dry-run"]), { userId: "u1", kind: "import", id: "i1", dryRun: true, projectId: process.env.GCLOUD_PROJECT });
    const b = parseArgs(["--user", "u1", "--budget", "dining", "--project", "p"]);
    assert.equal(b.kind, "budget");
    assert.equal(b.id, "dining");
    assert.equal(b.projectId, "p");
    assert.equal(b.dryRun, false);
    assert.equal(parseArgs(["--user", "u1", "--account", "a1"]).kind, "account");
    assert.equal(parseArgs(["--user", "u1", "--transaction", "t1"]).kind, "transaction");
  });

  test("exactly one thing to restore is required", () => {
    assert.throws(() => parseArgs(["--user", "u1"]), RestoreError);
    assert.throws(() => parseArgs(["--user", "u1", "--import", "i", "--budget", "b"]), RestoreError);
  });
});
