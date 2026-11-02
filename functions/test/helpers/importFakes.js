/**
 * Shared fakes for the statement soft delete / restore tests (SCRUM-120/121):
 * a tiny in-memory Firestore with just what createStore and createAuditWriter
 * use, and a helper that seeds one user's import with its transactions.
 */
"use strict";

/** Tiny in-memory Firestore with just what createStore and createAuditWriter use. */
function fakeFirestore(docs = {}) {
  const data = new Map(Object.entries(docs)); // path -> doc data
  let nextId = 1;
  const ref = (p) => ({
    path: p,
    collection: (name) => collection(`${p}/${name}`),
    get: async () => ({ exists: data.has(p), data: () => data.get(p) }),
    update: async (fields) => {
      if (!data.has(p)) throw new Error(`no document: ${p}`);
      data.set(p, { ...data.get(p), ...fields });
    },
    delete: async () => data.delete(p),
  });
  const query = (p, filters) => ({
    where: (field, op, value) => query(p, [...filters, [field, value]]),
    limit: (n) => ({
      get: async () => {
        const found = [...data.entries()]
          .filter(([k, v]) => k.startsWith(`${p}/`) && k.split("/").length === p.split("/").length + 1)
          // Like Firestore, == null does not match a missing field
          .filter(([, v]) => filters.every(([f, val]) => f in v && v[f] === val))
          .slice(0, n)
          .map(([k]) => ({ ref: ref(k) }));
        return { empty: found.length === 0, size: found.length, docs: found };
      },
    }),
  });
  const collection = (p) => ({
    doc: (id) => ref(`${p}/${id}`),
    where: (field, op, value) => query(p, [[field, value]]),
    add: async (d) => data.set(`${p}/auto${nextId++}`, d),
  });
  const db = {
    collection,
    batch: () => {
      const ops = [];
      return {
        update: (r, fields) => ops.push(() => data.set(r.path, { ...data.get(r.path), ...fields })),
        delete: (r) => ops.push(() => data.delete(r.path)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
  return { db, data };
}

/** One user's import with `n` transactions, as the import pipeline saves them. */
function seedImport(docs, uid, importId, n, imp = {}) {
  docs[`users/${uid}/imports/${importId}`] = {
    status: "completed",
    fileName: `${importId}.csv`,
    storagePath: `users/${uid}/imports/1700000000000_${importId}.csv`,
    deletedAt: null,
    ...imp,
  };
  for (let i = 0; i < n; i++) {
    docs[`transactions/${uid}_${importId}_${i}`] = { userId: uid, sourceStatementId: importId, source: "import", deletedAt: null };
  }
  return docs;
}

module.exports = { fakeFirestore, seedImport };
