/**
 * callables.js (SCRUM-112)
 *
 * Shared code for the callable functions (onCall) the web app calls with
 * httpsCallable(). The one rule: the caller's user id comes ONLY from the
 * verified login token (request.auth.uid). onCall checks the token's signature
 * before our code runs, so request.auth can't be faked. Anything in
 * request.data (the body the browser sends, e.g. { userId: "someone-else" })
 * is never used to decide who the caller is.
 *
 * The handlers live here (not in index.js) so they can be unit tested with
 * fakes, without Firebase.
 */
"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { deleteImport, DeleteImportError } = require("./deleteImport");
const { softDeleteImport } = require("./softDeleteImport");

/**
 * Returns the signed-in caller's uid from the verified token.
 * @throws {HttpsError} "unauthenticated" if there is no signed-in user
 */
function requireUid(request) {
  const uid = request?.auth?.uid;
  if (typeof uid !== "string" || uid === "") {
    throw new HttpsError("unauthenticated", "Please sign in again.");
  }
  return uid;
}

/**
 * Builds the deleteImport({ importId }) callable handler.
 * Only `importId` is read from the body. The store is always opened for the
 * token's uid, so another user's import is simply "not found".
 *
 * @param {Object} deps
 * @param {(uid: string, importId: string) => Object} deps.openStoreFor  createStore() for that user's import
 * @param {(path: string) => Promise<void>} deps.deleteFile  Deletes a file from Storage
 * @param {Object} [deps.logger]
 */
function createDeleteImportHandler({ openStoreFor, deleteFile, logger = console }) {
  return async (request) => {
    const uid = requireUid(request);
    const importId = request.data?.importId;
    try {
      return await deleteImport({
        uid,
        importId,
        openStore: (id) => openStoreFor(uid, id),
        deleteFile,
        logger,
      });
    } catch (err) {
      throw toHttpsError(err, { uid, importId, logger });
    }
  };
}

/**
 * Builds the softDeleteImport({ importId }) callable handler (SCRUM-120): the
 * statement and its transactions are marked deleted and can be restored for 30 days.
 * Same rule as deleteImport: only `importId` is read from the body.
 *
 * @param {Object} deps
 * @param {(uid: string, importId: string) => Object} deps.openStoreFor
 * @param {(entry: Object) => Promise<void>} deps.writeAudit  auditLog.js createAuditWriter()
 * @param {Object} [deps.logger]
 */
function createSoftDeleteImportHandler({ openStoreFor, writeAudit, logger = console }) {
  return async (request) => {
    const uid = requireUid(request);
    const importId = request.data?.importId;
    try {
      return await softDeleteImport({ uid, importId, openStore: (id) => openStoreFor(uid, id), writeAudit, logger });
    } catch (err) {
      throw toHttpsError(err, { uid, importId, logger });
    }
  };
}

/** A DeleteImportError keeps its code and message; anything else becomes "internal". */
function toHttpsError(err, { uid, importId, logger }) {
  if (err instanceof DeleteImportError) return new HttpsError(err.code, err.message);
  logger.error("Statement action failed", { uid, importId, message: err.message });
  return new HttpsError("internal", "We couldn't update this statement. Please try again.");
}

module.exports = { requireUid, createDeleteImportHandler, createSoftDeleteImportHandler };
