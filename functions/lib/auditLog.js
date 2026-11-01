/**
 * auditLog.js (SCRUM-120)
 *
 * Writes one entry to the top-level auditLog collection for each important
 * action on a user's data (delete, restore...), so there is a record of who
 * did what and when:
 *
 *   auditLog/{autoId}
 *     userId      whose data it was (the owner can read their own entries)
 *     action      e.g. "import.deleted", "import.restored"
 *     targetPath  the document it was about, e.g. "users/abc/imports/9f2c..."
 *     actor       the uid who did it, or "system" for scheduled jobs
 *     at          server timestamp
 *     details     anything useful, e.g. { fileName, transactionCount }
 *
 * Only Cloud Functions write here (firestore.rules lets no one write from the app).
 */
"use strict";

/** Loaded lazily so unit tests can run without firebase-admin installed. */
function defaultServerTimestamp() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

/**
 * @param {Object} opts
 * @param {Object} opts.db  Firestore instance (from getFirestore())
 * @param {() => any} [opts.serverTimestamp]  Override in tests
 * @returns {(entry: {userId: string, action: string, targetPath: string, actor: string, details?: Object}) => Promise<void>}
 */
function createAuditWriter({ db, serverTimestamp = defaultServerTimestamp }) {
  return async ({ userId, action, targetPath, actor, details = {} }) => {
    await db.collection("auditLog").add({ userId, action, targetPath, actor, at: serverTimestamp(), details });
  };
}

module.exports = { createAuditWriter };
