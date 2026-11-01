/**
 * softDeleteImport.js (SCRUM-120)
 *
 * The Import page's "Delete" button. Instead of erasing a statement right away
 * (deleteImport.js), it is marked deleted so it can be restored for 30 days:
 *   1. every transaction from it gets deletedAt, deletedBy and purgeAfter,
 *      in batches of 400 or fewer (only ones not deleted already)
 *   2. then the import doc gets the same three fields, last, so a failure part
 *      way can simply be retried
 *   3. an "import.deleted" entry goes to the audit log
 * The raw file stays in Storage. The daily purge job removes the transactions
 * once purgeAfter has passed.
 *
 * Like deleteImport.js, all Firestore access goes through `store`
 * (firestoreStore.js), so this can be unit tested with fakes.
 */
"use strict";

const { DeleteImportError, IMPORT_ID } = require("./deleteImport");

// How long a deleted statement can be restored
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Object} opts
 * @param {string|null} opts.uid       The signed-in caller (from the login token)
 * @param {string} opts.importId       Which import to delete
 * @param {(importId: string) => Object} opts.openStore  Returns createStore() for the caller's import
 * @param {(entry: Object) => Promise<void>} opts.writeAudit  auditLog.js createAuditWriter()
 * @param {() => number} [opts.now]    Current time in ms (override in tests)
 * @param {Object} [opts.logger]
 * @returns {Promise<{deletedTransactions: number, purgeAfter: string}>}
 * @throws {DeleteImportError} not signed in, bad ID, not found, not the owner, still importing, or already deleted
 */
async function softDeleteImport({ uid, importId, openStore, writeAudit, now = Date.now, logger = console }) {
  if (!uid) throw new DeleteImportError("unauthenticated", "Please sign in again to delete this statement.");
  if (typeof importId !== "string" || !IMPORT_ID.test(importId)) {
    throw new DeleteImportError("invalid-argument", "That statement ID isn't valid.");
  }

  // The store only looks under users/{uid}, so another user's import is simply not found
  const store = openStore(importId);
  const imp = await store.get();
  if (!imp) throw new DeleteImportError("not-found", "This statement doesn't exist.");
  if (imp.storagePath && !imp.storagePath.startsWith(`users/${uid}/imports/`)) {
    throw new DeleteImportError("permission-denied", "You can only delete your own statements.");
  }
  // Deleting mid-import would race with the pipeline still writing transactions
  if (imp.status === "uploaded" || imp.status === "processing") {
    throw new DeleteImportError("failed-precondition", "This statement is still importing. Try again in a minute.");
  }
  if (imp.deletedAt != null) {
    throw new DeleteImportError("failed-precondition", "This statement is already deleted. You can restore it from Recently deleted.");
  }

  const purgeAfter = new Date(now() + RETENTION_DAYS * DAY_MS);
  const fields = { deletedBy: uid, purgeAfter };

  // 1. Transactions, one batch at a time until none are left
  let deletedTransactions = 0;
  for (;;) {
    const count = await store.softDeleteTransactionBatch(fields);
    if (count === 0) break;
    deletedTransactions += count;
  }

  // 2. The import record, last
  await store.softDeleteImportDoc(fields);

  // 3. The audit entry
  await writeAudit({
    userId: uid,
    action: "import.deleted",
    targetPath: `users/${uid}/imports/${importId}`,
    actor: uid,
    details: { fileName: imp.fileName ?? null, transactionCount: deletedTransactions },
  });

  logger.info("Import soft deleted", { uid, importId, deletedTransactions });
  return { deletedTransactions, purgeAfter: purgeAfter.toISOString() };
}

module.exports = { softDeleteImport, RETENTION_DAYS };
