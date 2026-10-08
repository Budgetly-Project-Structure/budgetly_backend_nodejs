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
 *   get()                      the import doc's data, or null if it doesn't exist
 *   deleteTransactionBatch()   delete up to DELETE_BATCH_SIZE of its transactions, returns how many
 *   deleteImportDoc()          delete the import doc itself
 */
"use strict";

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
  const txnCol = userRef.collection("transactions");

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
        const snap = await txnCol
          .where("sourceStatementId", "==", importId)
          .limit(BATCH_SIZE)
          .get();
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
      const snap = await txnCol
        .where("sourceStatementId", "==", importId)
        .limit(DELETE_BATCH_SIZE)
        .get();
      if (snap.empty) return 0;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return snap.size;
    },

    async deleteImportDoc() {
      await importRef.delete();
    },
  };
}

module.exports = { createStore, BATCH_SIZE, DELETE_BATCH_SIZE };
