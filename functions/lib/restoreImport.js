/**
 * restoreImport.js (SCRUM-121)
 *
 * The Restore button for a deleted statement in the Import page's "Recently
 * deleted" list. Undoes softDeleteImport.js:
 *   1. every transaction from the statement that was marked deleted gets
 *      deletedAt, deletedBy and purgeAfter cleared back to null, in batches of
 *      400 or fewer
 *   2. then the import doc, last, so a failure part way can simply be retried
 *   3. an "import.restored" entry goes to the audit log
 *
 * Only a statement that is deleted and not yet purged can be restored. Like
 * softDeleteImport.js, all Firestore access goes through `store`.
 */
"use strict";

const { DeleteImportError, IMPORT_ID } = require("./deleteImport");

/** Reads a Firestore Timestamp, a Date or a number of milliseconds as milliseconds. */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : null;
}

/**
 * @param {Object} opts
 * @param {string|null} opts.uid       The signed-in caller (from the login token)
 * @param {string} opts.importId       Which import to restore
 * @param {(importId: string) => Object} opts.openStore  Returns createStore() for the caller's import
 * @param {(entry: Object) => Promise<void>} opts.writeAudit  auditLog.js createAuditWriter()
 * @param {() => number} [opts.now]    Current time in ms (override in tests)
 * @param {Object} [opts.logger]
 * @returns {Promise<{restoredTransactions: number}>}
 * @throws {DeleteImportError} not signed in, bad ID, not found (or purged), not the owner, not deleted, or too late
 */
async function restoreImport({ uid, importId, openStore, writeAudit, now = Date.now, logger = console }) {
  if (!uid) throw new DeleteImportError("unauthenticated", "Please sign in again to restore this statement.");
  if (typeof importId !== "string" || !IMPORT_ID.test(importId)) {
    throw new DeleteImportError("invalid-argument", "That statement ID isn't valid.");
  }

  // The store only looks under users/{uid}, so another user's import (or one that
  // was already purged) is simply not found
  const store = openStore(importId);
  const imp = await store.get();
  if (!imp) throw new DeleteImportError("not-found", "This statement was removed for good and can't be restored.");
  if (imp.storagePath && !imp.storagePath.startsWith(`users/${uid}/imports/`)) {
    throw new DeleteImportError("permission-denied", "You can only restore your own statements.");
  }
  if (imp.deletedAt == null) {
    throw new DeleteImportError("failed-precondition", "This statement isn't deleted.");
  }
  // Past purgeAfter the purge job may already have removed its transactions
  const purgeAfterMs = toMillis(imp.purgeAfter);
  if (purgeAfterMs != null && purgeAfterMs <= now()) {
    throw new DeleteImportError("failed-precondition", "It's been more than 30 days, so this statement can't be restored.");
  }

  // 1. Transactions, one batch at a time until none are left
  let restoredTransactions = 0;
  for (;;) {
    const count = await store.restoreTransactionBatch({ deletedBy: imp.deletedBy ?? uid });
    if (count === 0) break;
    restoredTransactions += count;
  }

  // 2. The import record, last
  await store.restoreImportDoc();

  // 3. The audit entry
  await writeAudit({
    userId: uid,
    action: "import.restored",
    targetPath: `users/${uid}/imports/${importId}`,
    actor: uid,
    details: { fileName: imp.fileName ?? null, transactionCount: restoredTransactions },
  });

  logger.info("Import restored", { uid, importId, restoredTransactions });
  return { restoredTransactions };
}

module.exports = { restoreImport };
