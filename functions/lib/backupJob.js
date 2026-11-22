/**
 * backupJob.js (Sprint 5 #15)
 *
 * Daily backups of the whole Firestore database, for $0 (budgetly_assets
 * docs/data-framework.md, "Backups"):
 *   1. start a Firestore export (exportDocuments) of the default database to
 *        gs://<default bucket>/backups/YYYY-MM-DD/
 *      The export runs on Google's side; we only start it and log the operation name.
 *   2. delete backups older than 7 days (only folders whose name is a date)
 *
 * The daily purgeDeleted function (index.js) runs this first and skips the rest of
 * its work that day if the export can't be started, so data never leaves the live
 * collections on a day without a fresh backup. `npm run backup` (scripts/backupNow.js)
 * starts one by hand.
 *
 * Why it's free: no second database, no paid managed backups / point-in-time recovery,
 * and no new Cloud Scheduler job (it rides on purgeDeleted). An export is billed as one
 * read per document, far below the free 50,000 reads a day at our size, and a week of
 * exports is a few MB in the default bucket.
 *
 * Needs (one-time, free): the functions' service account has the "Cloud Datastore
 * Import Export Admin" role (README, "Backups").
 *
 * The Firestore admin client and the bucket are passed in, so everything here is
 * unit tested with fakes (test/backupJob.test.js).
 */
"use strict";

const BACKUP_PREFIX = "backups/";
// How many days of backups to keep
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// backups/2026-11-22/...  or  backups/2026-11-22-manual-0930/... (npm run backup)
const FOLDER = /^backups\/(\d{4}-\d{2}-\d{2})(?:-manual-\d{4})?\//;

/** "YYYY-MM-DD" in UTC. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The folder for a backup started at `now`: "backups/2026-11-22", or
 * "backups/2026-11-22-manual-0930" for one started by hand (UTC time), so it never
 * overwrites the daily one.
 */
function backupFolder(now, { manual = false } = {}) {
  const day = isoDay(now);
  if (!manual) return `${BACKUP_PREFIX}${day}`;
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  return `${BACKUP_PREFIX}${day}-manual-${hhmm}`;
}

/**
 * Starts an export of the whole default database (all collections) to the folder.
 * Resolves once Google has accepted it; the copying carries on without us.
 *
 * @param {Object} opts
 * @param {Object} opts.adminClient   new v1.FirestoreAdminClient() from @google-cloud/firestore
 * @param {string} opts.projectId
 * @param {string} opts.bucketName    The default Storage bucket's name
 * @param {string} opts.folder        From backupFolder()
 * @returns {Promise<{operation: string, outputUriPrefix: string}>}
 */
async function startExport({ adminClient, projectId, bucketName, folder }) {
  if (!projectId) throw new Error("No project id: can't start a backup");
  if (!bucketName) throw new Error("No bucket name: can't start a backup");
  const outputUriPrefix = `gs://${bucketName}/${folder}`;
  const [operation] = await adminClient.exportDocuments({
    name: adminClient.databasePath(projectId, "(default)"),
    outputUriPrefix,
    collectionIds: [], // empty = every collection
  });
  return { operation: operation?.name ?? null, outputUriPrefix };
}

/**
 * Which backup folders are older than `keepDays` days. Files that aren't in a dated
 * backup folder are never touched.
 *
 * @param {string[]} fileNames  Storage object names under backups/
 * @param {Date} now
 * @param {number} [keepDays]
 * @returns {string[]} folder prefixes to delete, e.g. "backups/2026-11-10/"
 */
function expiredFolders(fileNames, now, keepDays = KEEP_DAYS) {
  // Keep today and the keepDays - 1 days before it: 7 daily backups in all
  const oldestKept = isoDay(new Date(now.getTime() - (keepDays - 1) * DAY_MS));
  const folders = new Set();
  for (const name of fileNames) {
    const m = name.match(FOLDER);
    if (!m) continue;
    if (m[1] < oldestKept) folders.add(name.slice(0, name.indexOf("/", BACKUP_PREFIX.length) + 1));
  }
  return [...folders].sort();
}

/**
 * Deletes backup folders older than `keepDays` days.
 *
 * @param {Object} opts
 * @param {Object} opts.bucket   getStorage().bucket()
 * @param {Date} opts.now
 * @param {number} [opts.keepDays]
 * @returns {Promise<string[]>} the folders deleted
 */
async function deleteOldBackups({ bucket, now, keepDays = KEEP_DAYS }) {
  const [files] = await bucket.getFiles({ prefix: BACKUP_PREFIX });
  const old = expiredFolders(files.map((f) => f.name), now, keepDays);
  for (const prefix of old) {
    await bucket.deleteFiles({ prefix });
  }
  return old;
}

/**
 * Today's backup: start the export, then clean up old ones.
 * Throws if the export can't be started (the caller then skips archiving). A failed
 * cleanup is only logged: old backups can wait until tomorrow.
 *
 * @param {Object} opts
 * @param {Object} opts.adminClient
 * @param {Object} opts.bucket
 * @param {string} opts.projectId
 * @param {Date} [opts.now]
 * @param {boolean} [opts.manual]   true for npm run backup
 * @param {Object} [opts.logger]
 * @returns {Promise<{folder: string, operation: string|null, deletedFolders: string[]}>}
 */
async function runBackup({ adminClient, bucket, projectId, now = new Date(), manual = false, logger = console }) {
  const folder = backupFolder(now, { manual });
  const started = await startExport({ adminClient, projectId, bucketName: bucket.name, folder });
  logger.info("Backup started", { folder, operation: started.operation, outputUriPrefix: started.outputUriPrefix });

  let deletedFolders = [];
  try {
    deletedFolders = await deleteOldBackups({ bucket, now });
    if (deletedFolders.length) logger.info("Old backups deleted", { deletedFolders });
  } catch (err) {
    logger.error("Could not delete old backups; will try again tomorrow", { message: err.message });
  }
  return { folder, operation: started.operation, deletedFolders };
}

/**
 * The daily job's order (purgeDeleted in index.js): back up first, then clean up.
 * If the backup can't be started, the cleanup is skipped for today (and tried again
 * tomorrow), so nothing leaves the live data without a fresh backup.
 * On the local emulators there's no export API, so the backup is skipped with a note
 * and the cleanup still runs.
 *
 * @param {Object} opts
 * @param {() => Promise<Object>} opts.backup   e.g. () => runBackup({...})
 * @param {() => Promise<Object>} opts.cleanup  e.g. () => runPurge({...})
 * @param {boolean} [opts.emulator]             true on the Functions emulator
 * @param {Object} [opts.logger]
 * @returns {Promise<{backup: Object|null, cleanup: Object|null, skipped: boolean}>}
 */
async function backupThenCleanup({ backup, cleanup, emulator = false, logger = console }) {
  let backupResult = null;
  if (emulator) {
    logger.info("On the emulator: no Firestore export, skipping today's backup");
  } else {
    try {
      backupResult = await backup();
    } catch (err) {
      logger.error("Backup could not be started; skipping today's cleanup so nothing leaves without a backup", {
        message: err.message,
      });
      return { backup: null, cleanup: null, skipped: true };
    }
  }
  const cleanupResult = await cleanup();
  return { backup: backupResult, cleanup: cleanupResult, skipped: false };
}

module.exports = { backupThenCleanup, runBackup, startExport, deleteOldBackups, expiredFolders, backupFolder, KEEP_DAYS, BACKUP_PREFIX };
