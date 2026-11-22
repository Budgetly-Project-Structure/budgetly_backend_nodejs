/**
 * Tests for lib/backupJob.js (Sprint 5 #15): the daily Firestore export to
 * backups/YYYY-MM-DD/, keeping 7 days, and the "no backup, no cleanup" order.
 * No Firebase or network needed: the admin client and the bucket are fakes.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { runBackup, startExport, deleteOldBackups, expiredFolders, backupFolder, backupThenCleanup, KEEP_DAYS } = require("../lib/backupJob");

const silentLogger = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-11-22T09:00:00Z"); // 3 AM Central

/** A fake FirestoreAdminClient that remembers the export requests. */
function fakeAdmin({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    databasePath: (project, database) => `projects/${project}/databases/${database}`,
    async exportDocuments(request) {
      calls.push(request);
      if (fail) throw fail;
      return [{ name: `projects/p/databases/(default)/operations/op${calls.length}` }];
    },
  };
}

/** A fake bucket holding some object names. */
function fakeBucket(names, { failList = false } = {}) {
  const files = new Set(names);
  return {
    name: "budgetly-test.firebasestorage.app",
    files,
    deletedPrefixes: [],
    async getFiles({ prefix }) {
      if (failList) throw new Error("listing failed");
      return [[...files].filter((n) => n.startsWith(prefix)).map((name) => ({ name }))];
    },
    async deleteFiles({ prefix }) {
      this.deletedPrefixes.push(prefix);
      for (const n of [...files]) if (n.startsWith(prefix)) files.delete(n);
    },
  };
}

const backupFiles = (day) => [`backups/${day}/${day}.overall_export_metadata`, `backups/${day}/all_namespaces/all_kinds/output-0`];

describe("backupFolder", () => {
  test("the daily backup is named by its UTC date", () => {
    assert.equal(backupFolder(NOW), "backups/2026-11-22");
  });
  test("a backup started by hand gets the time too, so it never overwrites the daily one", () => {
    assert.equal(backupFolder(new Date("2026-11-22T15:07:00Z"), { manual: true }), "backups/2026-11-22-manual-1507");
  });
});

describe("startExport", () => {
  test("exports every collection of the default database to the bucket folder", async () => {
    const admin = fakeAdmin();
    const r = await startExport({ adminClient: admin, projectId: "p", bucketName: "b", folder: "backups/2026-11-22" });
    assert.deepEqual(admin.calls, [{
      name: "projects/p/databases/(default)",
      outputUriPrefix: "gs://b/backups/2026-11-22",
      collectionIds: [],
    }]);
    assert.equal(r.operation, "projects/p/databases/(default)/operations/op1");
  });
  test("refuses without a project or a bucket", async () => {
    await assert.rejects(startExport({ adminClient: fakeAdmin(), projectId: "", bucketName: "b", folder: "x" }), /project/);
    await assert.rejects(startExport({ adminClient: fakeAdmin(), projectId: "p", bucketName: "", folder: "x" }), /bucket/);
  });
});

describe("expiredFolders / deleteOldBackups", () => {
  test(`keeps ${KEEP_DAYS} days (today and the 6 before), deletes anything older`, () => {
    const names = ["2026-11-22", "2026-11-16", "2026-11-15", "2026-11-01"].flatMap(backupFiles);
    assert.deepEqual(expiredFolders(names, NOW), ["backups/2026-11-01/", "backups/2026-11-15/"]);
  });
  test("manual backups expire the same way", () => {
    const names = ["backups/2026-11-10-manual-1200/x", "backups/2026-11-21-manual-0800/x"];
    assert.deepEqual(expiredFolders(names, NOW), ["backups/2026-11-10-manual-1200/"]);
  });
  test("files that aren't in a dated folder are never touched", () => {
    const names = ["backups/notes.txt", "backups/old-stuff/x", "backups/2026-1-1/x", "archive/users/a/imports/1_a.csv"];
    assert.deepEqual(expiredFolders(names, NOW), []);
  });
  test("deletes only the expired folders from the bucket", async () => {
    const bucket = fakeBucket([...backupFiles("2026-11-22"), ...backupFiles("2026-11-14"), "backups/readme.txt"]);
    const deleted = await deleteOldBackups({ bucket, now: NOW });
    assert.deepEqual(deleted, ["backups/2026-11-14/"]);
    assert.deepEqual([...bucket.files].sort(), [...backupFiles("2026-11-22"), "backups/readme.txt"].sort());
  });
});

describe("runBackup", () => {
  test("starts today's export, then deletes backups older than 7 days", async () => {
    const admin = fakeAdmin();
    const bucket = fakeBucket([...backupFiles("2026-11-10"), ...backupFiles("2026-11-21")]);
    const r = await runBackup({ adminClient: admin, bucket, projectId: "p", now: NOW, logger: silentLogger });
    assert.equal(r.folder, "backups/2026-11-22");
    assert.equal(admin.calls[0].outputUriPrefix, "gs://budgetly-test.firebasestorage.app/backups/2026-11-22");
    assert.deepEqual(r.deletedFolders, ["backups/2026-11-10/"]);
  });
  test("if the export can't be started, it throws and deletes nothing", async () => {
    const bucket = fakeBucket(backupFiles("2026-11-01"));
    await assert.rejects(
      runBackup({ adminClient: fakeAdmin({ fail: new Error("PERMISSION_DENIED") }), bucket, projectId: "p", now: NOW, logger: silentLogger }),
      /PERMISSION_DENIED/
    );
    assert.deepEqual(bucket.deletedPrefixes, [], "old backups are kept when there's no new one");
  });
  test("a failed cleanup doesn't fail the backup", async () => {
    const r = await runBackup({ adminClient: fakeAdmin(), bucket: fakeBucket([], { failList: true }), projectId: "p", now: NOW, logger: silentLogger });
    assert.equal(r.folder, "backups/2026-11-22");
    assert.deepEqual(r.deletedFolders, []);
  });
});

describe("backupThenCleanup (the daily job's order)", () => {
  test("backs up first, then cleans up", async () => {
    const order = [];
    const r = await backupThenCleanup({
      backup: async () => { order.push("backup"); return { folder: "f" }; },
      cleanup: async () => { order.push("cleanup"); return { transactions: 1 }; },
      logger: silentLogger,
    });
    assert.deepEqual(order, ["backup", "cleanup"]);
    assert.deepEqual(r, { backup: { folder: "f" }, cleanup: { transactions: 1 }, skipped: false });
  });
  test("no backup today: the cleanup is skipped (nothing leaves without a backup)", async () => {
    let cleaned = false;
    const r = await backupThenCleanup({
      backup: async () => { throw new Error("export refused"); },
      cleanup: async () => { cleaned = true; },
      logger: silentLogger,
    });
    assert.equal(cleaned, false);
    assert.deepEqual(r, { backup: null, cleanup: null, skipped: true });
  });
  test("on the emulator (no export API) the backup is skipped and the cleanup still runs", async () => {
    let backedUp = false;
    const r = await backupThenCleanup({
      backup: async () => { backedUp = true; },
      cleanup: async () => "cleaned",
      emulator: true,
      logger: silentLogger,
    });
    assert.equal(backedUp, false);
    assert.deepEqual(r, { backup: null, cleanup: "cleaned", skipped: false });
  });
});
