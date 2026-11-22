/**
 * removeImportCopies.js (Sprint 5 #2)
 *
 * One-time cleanup: removes the fields import records used to copy from somewhere
 * else (budgetly_assets docs/data-duplication-audit.md, D1, D4, D5):
 *   transactionCount  the transactions with sourceStatementId == importId are the count
 *   accountType       the account (accountId) has the type
 *   fileName          the last part of storagePath
 *   fileType          the extension of storagePath
 * from every users/{uid}/imports/{importId}. Nothing else is touched.
 *
 * Run it only AFTER the new backend and web app are both live: the old web app still
 * reads these fields.
 *
 * Safe to run more than once: a record that has none of the fields is skipped, so a
 * second run finds 0 to change. Writes go in batches of 400 or fewer.
 *
 * Runs on your own machine with the Admin SDK (it skips the security rules):
 *   cd budgetly_backend_nodejs/functions
 *   node scripts/removeImportCopies.js --dry-run     # only counts, writes nothing
 *   node scripts/removeImportCopies.js               # removes the fields
 *
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
 * Against the real project: same sign-in as migrateTransactions.js
 * (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS),
 * then add --project budgetly-backend-nodejs.
 */
"use strict";

// Firestore allows 500 writes per batch; stay under it
const BATCH_SIZE = 400;
// Import records read per page
const PAGE_SIZE = 400;

// The copied fields this script removes
const COPIED_FIELDS = ["transactionCount", "accountType", "fileName", "fileType"];

/** Which of the copied fields this import record still has. */
function copiedFieldsIn(data) {
  return COPIED_FIELDS.filter((f) => data && Object.prototype.hasOwnProperty.call(data, f));
}

/** Loaded lazily so unit tests can run without firebase-admin. */
function defaultDeleteField() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.delete();
}

/**
 * @param {Object} opts
 * @param {Object} opts.db              Admin SDK Firestore
 * @param {boolean} [opts.dryRun]       Only count, write nothing
 * @param {() => any} [opts.deleteField]  FieldValue.delete(); override in tests
 * @param {number} [opts.pageSize]
 * @param {Object} [opts.logger]
 * @returns {Promise<{checked: number, toChange: number, changed: number, fields: Object<string, number>}>}
 *          fields = how many records had each field
 */
async function removeImportCopies({ db, dryRun = false, deleteField = defaultDeleteField, pageSize = PAGE_SIZE, logger = console }) {
  const report = { checked: 0, toChange: 0, changed: 0, fields: Object.fromEntries(COPIED_FIELDS.map((f) => [f, 0])) };

  // Every user's imports, one page at a time, in document order
  let last = null;
  for (;;) {
    let q = db.collectionGroup("imports").orderBy("__name__").limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];

    const pending = [];
    for (const d of snap.docs) {
      // Only users/{uid}/imports/{importId}, never another collection that happens to be called "imports"
      if (d.ref.parent?.parent?.parent?.id !== "users") continue;
      report.checked++;
      const fields = copiedFieldsIn(d.data());
      if (fields.length === 0) continue;
      report.toChange++;
      fields.forEach((f) => report.fields[f]++);
      pending.push({ ref: d.ref, fields });
    }

    if (!dryRun) {
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const { ref, fields } of pending.slice(i, i + BATCH_SIZE)) {
          batch.update(ref, Object.fromEntries(fields.map((f) => [f, deleteField()])));
        }
        await batch.commit();
        report.changed += Math.min(BATCH_SIZE, pending.length - i);
      }
    }
    logger.info?.(`Checked ${report.checked} import records so far`);
    if (snap.size < pageSize) break;
  }
  return report;
}

/** Prints the counts. */
function printReport(report, { dryRun }, log = console.log) {
  log(dryRun ? "DRY RUN: nothing was written." : "");
  log(`Import records checked:      ${report.checked}`);
  log(`Records with copied fields:  ${report.toChange}`);
  for (const f of COPIED_FIELDS) log(`  ${f.padEnd(18)} ${report.fields[f]}`);
  log(`Records changed:             ${report.changed}`);
}

module.exports = { removeImportCopies, copiedFieldsIn, printReport, COPIED_FIELDS, BATCH_SIZE };

// --- Command line ------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const projectArg = args.indexOf("--project");
  const projectId = projectArg >= 0 ? args[projectArg + 1] : process.env.GCLOUD_PROJECT;

  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  initializeApp(projectId ? { projectId } : undefined);

  console.log(`Project: ${projectId ?? "(default)"}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""}`);
  removeImportCopies({ db: getFirestore(), dryRun, logger: { info() {} } })
    .then((report) => printReport(report, { dryRun }))
    .catch((err) => {
      console.error("Cleanup failed:", err.message);
      process.exitCode = 1;
    });
}
