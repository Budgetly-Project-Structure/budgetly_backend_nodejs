/**
 * backupNow.js (Sprint 5 #15)
 *
 * Starts a backup by hand, e.g. before running a risky script or a migration:
 * a Firestore export of the whole default database to
 *   gs://<bucket>/backups/YYYY-MM-DD-manual-HHMM/
 * (UTC time, so it never overwrites the daily one), then deletes backups older than
 * 7 days, the same as the daily job (lib/backupJob.js).
 *
 * Runs on an admin's own machine with their Google login:
 *   gcloud auth application-default login          (once)
 *   cd budgetly_backend_nodejs/functions
 *   npm run backup -- --project budgetly-backend-nodejs [--bucket <bucket name>]
 *
 * --bucket defaults to <project>.firebasestorage.app (the default bucket of projects
 * made since late 2024); older projects use <project>.appspot.com. Check the name at
 * the top of the Storage page in the Firebase console.
 *
 * The export runs on Google's side: this script only starts it and prints the
 * operation name. Check it with:
 *   gcloud firestore operations describe <operation name>
 * Restoring is never done from here; see README "Backups".
 */
"use strict";

const { runBackup } = require("../lib/backupJob");

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args = process.argv.slice(2)) {
  const projectId = arg(args, "--project") ?? process.env.GCLOUD_PROJECT;
  if (!projectId) throw new Error("Pass --project <project id>");
  const bucketName = arg(args, "--bucket") ?? `${projectId}.firebasestorage.app`;

  const { initializeApp } = require("firebase-admin/app");
  const { getStorage } = require("firebase-admin/storage");
  const { v1 } = require("@google-cloud/firestore");
  initializeApp({ projectId, storageBucket: bucketName });

  const result = await runBackup({
    adminClient: new v1.FirestoreAdminClient({ projectId }),
    bucket: getStorage().bucket(),
    projectId,
    manual: true,
    logger: { info() {}, error: (msg, x) => console.error(msg, x ?? "") },
  });
  console.log(`Backup started: gs://${bucketName}/${result.folder}/`);
  console.log(`Operation: ${result.operation}`);
  console.log(result.deletedFolders.length ? `Deleted old backups: ${result.deletedFolders.join(", ")}` : "No backups older than 7 days.");
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Backup failed:", err.message);
    process.exitCode = 1;
  });
}
