/**
 * Budgetly Cloud Functions
 *
 * onStatementUploaded (SCRUM-23, extended in SCRUM-24/26/27/28)
 * Runs automatically when a file finishes uploading to Firebase Storage.
 * If it's a bank statement (CSV or PDF) in a user's imports folder, it:
 *   1. creates an Import record in Firestore (status "uploaded"),
 *   2. downloads the file and parses it,
 *   3. saves the transactions to users/{uid}/transactions,
 *   4. marks the import "completed" or "failed" so the app can show the result.
 *
 * The parsing and saving logic lives in lib/ (csvParser.js, transactions.js,
 * importPipeline.js, firestoreStore.js). PDF parsing is SCRUM-25; until then
 * PDF imports end as "failed" with a message asking for a CSV.
 *
 * Storage path:   users/{uid}/imports/{fileName}
 * Firestore docs: users/{uid}/imports/{importId}
 *                 users/{uid}/transactions/{importId}_{rowNumber}
 */

// --- Imports ---------------------------------------------------------------
const crypto = require("node:crypto");
// Trigger that fires when a Storage upload completes
const { onObjectFinalized } = require("firebase-functions/v2/storage");
// Admin SDK: server-side access to Firestore and Storage (bypasses security rules)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
// Logs show up in Firebase Console → Functions → Logs
const logger = require("firebase-functions/logger");

const { createStore } = require("./lib/firestoreStore");
const { processImport } = require("./lib/importPipeline");

// --- Setup -----------------------------------------------------------------
// Runs once when the function starts, not on every upload
initializeApp();
const db = getFirestore();

// Only these file types are accepted as statements
const ALLOWED_TYPES = ["csv", "pdf"];

/**
 * Same upload -> same import ID. Cloud Functions can deliver an event more than
 * once; a fixed ID lets us notice that and avoid importing the file twice.
 * (A re-upload of the same file gets a new Storage path, so a new ID.)
 */
function importIdFor(bucket, filePath, generation) {
  return crypto
    .createHash("sha256")
    .update(`${bucket}/${filePath}#${generation}`)
    .digest("hex")
    .slice(0, 20);
}

// --- Function --------------------------------------------------------------
// Parsing and writing take longer than the 60 s default allows for big files
exports.onStatementUploaded = onObjectFinalized({ timeoutSeconds: 120 }, async (event) => {
  // Full path of the uploaded file, e.g. "users/abc123/imports/1696000000_jan.csv"
  const filePath = event.data.name;
  const parts = filePath.split("/");

  // 1. FILTER: this fires for EVERY file uploaded to the bucket,
  //    so exit unless the path is users/{uid}/imports/{fileName}
  if (parts.length !== 4 || parts[0] !== "users" || parts[2] !== "imports") {
    return;
  }

  // 2. EXTRACT info from the path (and the metadata the web app attached)
  const uid = parts[1];
  const fileName = parts[3];
  const ext = fileName.split(".").pop().toLowerCase();
  const accountId = event.data.metadata?.accountId || null;

  // 3. VALIDATE file type (Storage rules already block others; this is a backup)
  if (!ALLOWED_TYPES.includes(ext)) {
    logger.warn("Unsupported file type, skipping", { filePath });
    return;
  }

  // 4. CREATE the Import record, unless this exact upload was already handled
  const importId = importIdFor(event.data.bucket, filePath, event.data.generation);
  const importRef = db.collection("users").doc(uid).collection("imports").doc(importId);

  const existing = await importRef.get();
  if (existing.exists && ["completed", "failed"].includes(existing.data().status)) {
    logger.info("Duplicate event for a finished import, skipping", { uid, importId });
    return;
  }
  if (!existing.exists) {
    await importRef.set({
      fileName,                          // shown in the UI
      storagePath: filePath,             // where the parser downloads it from
      fileType: ext,                     // "csv" or "pdf": decides which parser runs
      accountId,                         // which account the statement is for (may be null)
      sizeBytes: Number(event.data.size),
      status: "uploaded",                // lifecycle: uploaded → processing → completed | failed
      uploadedAt: FieldValue.serverTimestamp(),
    });
    logger.info("Import created", { uid, importId, fileName });
  }

  // 5. DOWNLOAD the file from Storage
  const store = createStore({ db, uid, importId });
  let fileBuffer;
  try {
    [fileBuffer] = await getStorage().bucket(event.data.bucket).file(filePath).download();
  } catch (err) {
    logger.error("Could not download uploaded file", { uid, importId, filePath, message: err.message });
    await store.update({
      status: "failed",
      error: "We couldn't read the uploaded file. Please try uploading it again.",
      transactionCount: 0,
    });
    return;
  }

  // 6. PARSE, SAVE and record the outcome (never throws; always ends completed/failed)
  const result = await processImport({ fileBuffer, fileType: ext, uid, importId, accountId, store, logger });
  logger.info("Import finished", { uid, importId, ...result });
});
