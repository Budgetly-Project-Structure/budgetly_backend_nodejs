/**
 * convertToCents.js (SCRUM-151, Sprint 5 #8)
 *
 * One-time script that gives every existing document its amount in whole cents
 * (budgetly_contracts schemas/data-model.md, "Money is stored in whole cents"):
 *
 *   transactions/{id}                  amountCents = Math.round(amount * 100)
 *   users/{uid}/budgets/{categoryId}   limitCents  = Math.round(limit * 100)
 *
 * Documents that already have cents are left alone. Soft-deleted documents are
 * converted too, so a restore doesn't bring back a document without cents.
 *
 * The old dollar fields (amount, limit) are KEPT unless you pass --remove-dollars. Only
 * remove them after the web app that reads cents (SCRUM-148 and SCRUM-150) is live, so
 * the live app never sees a document without its dollar field.
 *
 * Safe to run more than once. It never changes any other field (not updatedAt, not the
 * category), so it doesn't touch what users did or trigger the merchant memory. A
 * transaction that has both fields but disagrees (amountCents is not amount * 100) is
 * reported and left alone, because we can't know which one is right.
 *
 * Take a backup first (npm run backup), then run, from budgetly_backend_nodejs/functions:
 *   node scripts/convertToCents.js --dry-run            # only counts, writes nothing
 *   node scripts/convertToCents.js                      # adds the cents fields
 *   node scripts/convertToCents.js --remove-dollars     # also removes amount and limit
 *
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 first.
 * Against the real project: sign in once with `gcloud auth application-default login`
 * and add --project budgetly-backend-nodejs.
 */
"use strict";

const { centsOf } = require("../lib/money");

// Firestore allows 500 writes per batch; stay under it
const BATCH_SIZE = 400;

/** A number we can safely turn into cents. */
function isMoney(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Works out what to write for one document, or why it can't be converted.
 * @param {Object} data       the document's data
 * @param {string} centsField "amountCents" or "limitCents"
 * @param {string} dollarField "amount" or "limit"
 * @returns {{set?: Object, removeDollars: boolean, mismatch?: boolean, problem?: string}}
 */
function plan(data, centsField, dollarField) {
  const hasDollars = dollarField in data;
  if (Number.isInteger(data[centsField])) {
    // Already in cents. If dollars are still there, check that they agree.
    const mismatch = isMoney(data[dollarField]) && Math.round(data[dollarField] * 100) !== data[centsField];
    return { removeDollars: hasDollars && !mismatch, mismatch };
  }
  if (!isMoney(data[dollarField])) {
    return { removeDollars: false, problem: `no usable ${dollarField} (${JSON.stringify(data[dollarField])})` };
  }
  const cents = centsOf({ amount: data[dollarField] });
  if (centsField === "limitCents" && cents < 0) {
    return { removeDollars: false, problem: `negative ${dollarField} (${data[dollarField]})` };
  }
  return { set: { [centsField]: cents }, removeDollars: hasDollars };
}

/** Converts one set of documents and returns its counts. */
async function convertDocs({ db, docs, centsField, dollarField, dryRun, removeDollars, deleteField, logger }) {
  const stats = { total: docs.length, converted: 0, alreadyCents: 0, dollarsRemoved: 0, mismatched: [], problems: [] };
  const ops = [];

  for (const d of docs) {
    const p = plan(d.data(), centsField, dollarField);
    if (p.problem) {
      stats.problems.push({ path: d.ref.path, reason: p.problem });
      continue;
    }
    if (p.mismatch) {
      stats.mismatched.push(d.ref.path);
      continue;
    }
    const fields = { ...(p.set ?? {}) };
    if (p.set) stats.converted++;
    else stats.alreadyCents++;
    if (removeDollars && p.removeDollars) {
      fields[dollarField] = deleteField();
      stats.dollarsRemoved++;
    }
    if (Object.keys(fields).length > 0) ops.push((batch) => batch.update(d.ref, fields));
  }

  if (!dryRun) {
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + BATCH_SIZE)) op(batch);
      await batch.commit();
    }
  }
  for (const m of stats.mismatched) logger.warn(`${m}: ${centsField} and ${dollarField} disagree, left alone`);
  for (const p of stats.problems) logger.warn(`${p.path}: ${p.reason}, skipped`);
  return stats;
}

/**
 * @param {Object} opts
 * @param {Object} opts.db               Admin SDK Firestore
 * @param {boolean} [opts.dryRun]        Only count, write nothing
 * @param {boolean} [opts.removeDollars] Also remove amount / limit from converted documents
 * @param {() => *} [opts.deleteField]   FieldValue.delete() (tests pass their own)
 * @param {Object} [opts.logger]
 * @returns {Promise<{transactions: Object, budgets: Object}>}
 */
async function convertToCents({ db, dryRun = false, removeDollars = false, deleteField, logger = console }) {
  const del = deleteField ?? (() => require("firebase-admin/firestore").FieldValue.delete());
  // Our data is small (a class project), so each collection is read in one go
  const txns = await db.collection("transactions").get();
  const budgets = await db.collectionGroup("budgets").get();
  return {
    transactions: await convertDocs({ db, docs: txns.docs, centsField: "amountCents", dollarField: "amount", dryRun, removeDollars, deleteField: del, logger }),
    budgets: await convertDocs({ db, docs: budgets.docs, centsField: "limitCents", dollarField: "limit", dryRun, removeDollars, deleteField: del, logger }),
  };
}

/** Prints the counts. */
function printReport(report, { dryRun }, log = console.log) {
  log(dryRun ? "DRY RUN: nothing was written.\n" : "");
  log("what          total  converted  alreadyCents  dollarsRemoved  mismatched  problems");
  for (const [name, r] of Object.entries(report)) {
    log(`${name.padEnd(13)} ${String(r.total).padStart(5)}  ${String(r.converted).padStart(9)}  ${String(r.alreadyCents).padStart(12)}  ${String(r.dollarsRemoved).padStart(14)}  ${String(r.mismatched.length).padStart(10)}  ${String(r.problems.length).padStart(8)}`);
  }
}

module.exports = { convertToCents, plan, printReport, BATCH_SIZE };

// --- Command line ------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const removeDollars = args.includes("--remove-dollars");
  const projectArg = args.indexOf("--project");
  const projectId = projectArg >= 0 ? args[projectArg + 1] : process.env.GCLOUD_PROJECT;

  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  initializeApp(projectId ? { projectId } : undefined);

  console.log(`Project: ${projectId ?? "(default)"}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""}`);
  convertToCents({ db: getFirestore(), dryRun, removeDollars })
    .then((report) => {
      printReport(report, { dryRun });
      if (Object.values(report).some((r) => r.problems.length || r.mismatched.length)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("Conversion failed:", err.message);
      process.exitCode = 1;
    });
}
