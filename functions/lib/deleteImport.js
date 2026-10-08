/**
 * deleteImport.js
 *
 * Deletes one imported statement completely, for the "Delete" button on the
 * web app's Import page:
 *   1. every transaction that came from it (transactions are linked to their
 *      import by sourceStatementId), in batches of 400 or fewer
 *   2. the raw file in Firebase Storage (already gone is fine)
 *   3. the import doc itself, last, so a failure part way can simply be retried
 *
 * All Firestore access goes through `store` (firestoreStore.js) and the Storage
 * delete is passed in as `deleteFile`, so this file has no Firebase code and can
 * be unit tested with fakes. index.js turns DeleteImportError into an HttpsError.
 */
"use strict";

// Import IDs are 20 hex characters (index.js importIdFor); allow a little more, but never "/"
const IMPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An error the user should see. `code` is a Cloud Functions HttpsError code. */
class DeleteImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeleteImportError";
    this.code = code;
  }
}

/** True for Storage's "no such file" error (the file was already deleted). */
function isNotFound(err) {
  return err?.code === 404 || err?.code === "storage/object-not-found";
}

/**
 * @param {Object} opts
 * @param {string|null} opts.uid       The signed-in caller (null if not signed in)
 * @param {string} opts.importId       Which import to delete
 * @param {(importId: string) => Object} opts.openStore  Returns createStore() for the caller's import
 * @param {(path: string) => Promise<void>} opts.deleteFile  Deletes a file from Storage
 * @param {Object} [opts.logger]       firebase-functions logger (defaults to console)
 * @returns {Promise<{deletedTransactions: number}>}
 * @throws {DeleteImportError} not signed in, bad ID, not found, not the owner, or still importing
 */
async function deleteImport({ uid, importId, openStore, deleteFile, logger = console }) {
  if (!uid) throw new DeleteImportError("unauthenticated", "Please sign in again to delete this statement.");
  if (typeof importId !== "string" || !IMPORT_ID.test(importId)) {
    throw new DeleteImportError("invalid-argument", "That statement ID isn't valid.");
  }

  // The store only looks under users/{uid}, so another user's import is simply not found
  const store = openStore(importId);
  const imp = await store.get();
  if (!imp) throw new DeleteImportError("not-found", "This statement was already deleted.");
  // Belt and braces: never delete a file outside the caller's own folder
  if (imp.storagePath && !imp.storagePath.startsWith(`users/${uid}/imports/`)) {
    throw new DeleteImportError("permission-denied", "You can only delete your own statements.");
  }
  // Deleting mid-import would race with the pipeline still writing transactions
  if (imp.status === "uploaded" || imp.status === "processing") {
    throw new DeleteImportError("failed-precondition", "This statement is still importing. Try again in a minute.");
  }

  // 1. Transactions, one batch at a time until none are left
  let deletedTransactions = 0;
  for (;;) {
    const count = await store.deleteTransactionBatch();
    if (count === 0) break;
    deletedTransactions += count;
  }

  // 2. The raw file
  if (imp.storagePath) {
    try {
      await deleteFile(imp.storagePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      logger.warn("Statement file was already gone", { uid, importId, storagePath: imp.storagePath });
    }
  }

  // 3. The import record, last
  await store.deleteImportDoc();
  logger.info("Import deleted", { uid, importId, deletedTransactions });
  return { deletedTransactions };
}

module.exports = { deleteImport, DeleteImportError };
