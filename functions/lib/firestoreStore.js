/**
 * firestoreStore.js (SCRUM-26)
 *
 * The only place the import pipeline touches Firestore. It exposes a few
 * small operations for one import, so importPipeline.js and deleteImport.js
 * stay free of Firebase code and can be unit tested with a fake store.
 *
 *   update(patch)              merge fields into users/{uid}/imports/{importId}
 *   writeTransactions(docs)    save transactions in batches
 *   deleteTransactions()       remove everything this import wrote (cleanup after a failure)
 *
 * Transactions live in the top-level `transactions` collection (SCRUM-111). Every
 * query here filters by userId as well as sourceStatementId, so one user's import
 * can never touch another user's transactions.
 *   get()                      the import doc's data, or null if it doesn't exist
 *   deleteTransactionBatch()   delete up to DELETE_BATCH_SIZE of its transactions, returns how many
 *   deleteImportDoc()          delete the import doc itself
 *   softDeleteTransactionBatch(fields) / softDeleteImportDoc(fields)
 *                              mark them deleted instead (SCRUM-120)
 *   restoreTransactionBatch(fields) / restoreImportDoc()
 *                              undo that (SCRUM-121)
 *   existingTransactionCounts({accountId})  what earlier imports already saved, to skip duplicates (SCRUM-136)
 */
"use strict";

const { duplicateKey } = require("./duplicates");

// Firestore allows 500 operations per batch; stay under it
const BATCH_SIZE = 450;
// Deleting a whole import (deleteImport.js) uses a smaller batch
const DELETE_BATCH_SIZE = 400;

/** Loaded lazily so unit tests can run without firebase-admin installed. */
function defaultServerTimestamp() {
  const { FieldValue } = require("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

/**
 * @param {Object} opts
 * @param {Object} opts.db        Firestore instance (from getFirestore())
 * @param {string} opts.uid       Owner of the import
 * @param {string} opts.importId  Import doc ID, also used as the transactions' sourceStatementId
 * @param {() => any} [opts.serverTimestamp]  Override in tests
 */
function createStore({ db, uid, importId, serverTimestamp = defaultServerTimestamp }) {
  const userRef = db.collection("users").doc(uid);
  const importRef = userRef.collection("imports").doc(importId);
  const txnCol = db.collection("transactions");
  // This import's transactions: always scoped to the owner
  const importTxns = () => txnCol.where("userId", "==", uid).where("sourceStatementId", "==", importId);

  return {
    async update(patch) {
      await importRef.update({ ...patch, updatedAt: serverTimestamp() });
    },

    async writeTransactions(docs) {
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const { id, ...data } of docs.slice(i, i + BATCH_SIZE)) {
          // set() with a fixed ID: running the same import twice overwrites, never duplicates
          batch.set(txnCol.doc(id), { ...data, createdAt: serverTimestamp() });
        }
        await batch.commit();
      }
    },

    async deleteTransactions() {
      for (;;) {
        const snap = await importTxns().limit(BATCH_SIZE).get();
        if (snap.empty) return;
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    },

    async get() {
      const snap = await importRef.get();
      return snap.exists ? snap.data() : null;
    },

    async deleteTransactionBatch() {
      const snap = await importTxns().limit(DELETE_BATCH_SIZE).get();
      if (snap.empty) return 0;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return snap.size;
    },

    async deleteImportDoc() {
      await importRef.delete();
    },

    /**
     * Soft delete (SCRUM-120): marks up to DELETE_BATCH_SIZE of this import's
     * not-yet-deleted transactions as deleted, returns how many. Equality filters
     * only, so no composite index is needed.
     */
    async softDeleteTransactionBatch({ deletedBy, purgeAfter }) {
      const snap = await importTxns().where("deletedAt", "==", null).limit(DELETE_BATCH_SIZE).get();
      if (snap.empty) return 0;
      const batch = db.batch();
      const fields = { deletedAt: serverTimestamp(), deletedBy, purgeAfter, updatedAt: serverTimestamp() };
      snap.docs.forEach((d) => batch.update(d.ref, fields));
      await batch.commit();
      return snap.size;
    },

    /** Marks the import doc itself as deleted (SCRUM-120). */
    async softDeleteImportDoc({ deletedBy, purgeAfter }) {
      await importRef.update({ deletedAt: serverTimestamp(), deletedBy, purgeAfter, updatedAt: serverTimestamp() });
    },

    /**
     * Restore (SCRUM-121): clears the delete fields on up to DELETE_BATCH_SIZE of
     * this import's transactions that `deletedBy` deleted, returns how many.
     * Restored ones have deletedBy null, so the loop ends. Equality filters only.
     */
    async restoreTransactionBatch({ deletedBy }) {
      const snap = await importTxns().where("deletedBy", "==", deletedBy).limit(DELETE_BATCH_SIZE).get();
      if (snap.empty) return 0;
      const batch = db.batch();
      const fields = { deletedAt: null, deletedBy: null, purgeAfter: null, updatedAt: serverTimestamp() };
      snap.docs.forEach((d) => batch.update(d.ref, fields));
      await batch.commit();
      return snap.size;
    },

    /** Clears the delete fields on the import doc (SCRUM-121). */
    async restoreImportDoc() {
      await importRef.update({ deletedAt: null, deletedBy: null, purgeAfter: null, updatedAt: serverTimestamp() });
    },

    /**
     * What this user's other imports already saved for one account, as
     * duplicateKey -> count (SCRUM-136). This import's own documents are left out, so
     * running the same import twice still overwrites instead of skipping everything.
     * Equality filters only, so no composite index is needed.
     */
    async existingTransactionCounts({ accountId = null } = {}) {
      const snap = await txnCol
        .where("userId", "==", uid)
        .where("source", "==", "import")
        .where("accountId", "==", accountId ?? null)
        .select("date", "amount", "merchant", "accountId", "sourceStatementId", "deletedAt")
        .get();
      const counts = new Map();
      for (const d of snap.docs) {
        const x = d.data();
        // A deleted statement (SCRUM-120) no longer counts, so its file can be imported again
        if (x.sourceStatementId === importId || !x.date || x.deletedAt != null) continue;
        const key = duplicateKey(x);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    },
  };
}

module.exports = { createStore, BATCH_SIZE, DELETE_BATCH_SIZE };
