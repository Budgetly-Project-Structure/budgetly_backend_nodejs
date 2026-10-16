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
 * deleteImport (callable)
 * The web app's "Delete" button on the Import page. Removes an import's
 * transactions, its file in Storage and its import record (lib/deleteImport.js).
 *
 * Categorizing imports (SCRUM-73 to 75)
 * onStatementUploaded categorizes every import (CSV and PDF) before saving it:
 * free rules, then the user's merchant cache, then the AI in chunks of 50 (lib/
 * importCategorization.js). The AI part is OFF by default so deploys stay free:
 * turn it on by setting AI_CATEGORIZATION=on and ANTHROPIC_API_KEY in functions/.env
 * (or see aiFunctions.js for the secret-based setup). Without it, imports still get
 * the rules and the cache.
 *
 * onTransactionCategoryChanged
 * When a user sets or edits a transaction's category, remember it for that merchant
 * (users/{uid}/merchantCache, lib/merchantCache.js) so the next import reuses it.
 *
 * categorizeTransactions (Claude, paid) is switched off: it lives in
 * aiFunctions.js, which this file doesn't load, so deploys stay free. See that
 * file for how to turn it on.
 *
 * Storage path:   users/{uid}/imports/{fileName}
 * Firestore docs: users/{uid}/imports/{importId}
 *                 users/{uid}/transactions/{importId}_{rowNumber}
 */

// --- Imports ---------------------------------------------------------------
const crypto = require("node:crypto");
// Trigger that fires when a Storage upload completes
const { onObjectFinalized } = require("firebase-functions/v2/storage");
// Trigger that fires when a Firestore document is created, changed or deleted
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
// Callable functions: the web app calls these directly with httpsCallable()
const { onCall, HttpsError } = require("firebase-functions/v2/https");
// Admin SDK: server-side access to Firestore and Storage (bypasses security rules)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
// Logs show up in Firebase Console → Functions → Logs
const logger = require("firebase-functions/logger");

const { createStore } = require("./lib/firestoreStore");
const { processImport } = require("./lib/importPipeline");
const { deleteImport, DeleteImportError } = require("./lib/deleteImport");
const { createImportCategorizer } = require("./lib/importCategorization");
const { createMerchantCache, cacheUpdateFor } = require("./lib/merchantCache");

// --- Setup -----------------------------------------------------------------
// Runs once when the function starts, not on every upload
initializeApp();
const db = getFirestore();

// Only these file types are accepted as statements
const ALLOWED_TYPES = ["csv", "pdf"];

// The AI step is off unless AI_CATEGORIZATION=on and a key is set (see the header)
const AI_ENABLED = process.env.AI_CATEGORIZATION === "on" && Boolean(process.env.ANTHROPIC_API_KEY);
// Built once; null when the AI is off (the SDK is only loaded when it's on)
const classify = AI_ENABLED ? require("./lib/aiClient").createClaudeClassifier({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

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
  const startedAt = Date.now();
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
  // "credit" or "checking" (anything else is treated as unknown)
  const accountType = ["credit", "checking"].includes(event.data.metadata?.accountType)
    ? event.data.metadata.accountType
    : null;

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
      accountType,                       // "credit", "checking" or null
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
  // Leave 20 s of the 120 s limit to record "failed" if parsing/saving runs out of time
  const timeoutMs = Math.max(5000, 100 * 1000 - (Date.now() - startedAt));
  // Categorize before saving: merchant rules, then this user's merchant cache, then the AI (if on)
  const categorizer = createImportCategorizer({ cache: createMerchantCache({ db, uid }), classify, logger });
  const result = await processImport({ fileBuffer, fileType: ext, uid, importId, accountId, accountType, store, logger, timeoutMs, categorizer });
  logger.info("Import finished", { uid, importId, ...result });
});

/**
 * deleteImport({ importId }) -> { deletedTransactions }
 * Only the signed-in owner can delete an import. User-facing problems (not
 * found, still importing...) come back as HttpsErrors with a readable message.
 */
exports.deleteImport = onCall(async (request) => {
  const uid = request.auth?.uid ?? null;
  try {
    return await deleteImport({
      uid,
      importId: request.data?.importId,
      openStore: (importId) => createStore({ db, uid, importId }),
      // Uploads go to the project's default bucket (web app src/lib/uploads.js)
      deleteFile: (path) => getStorage().bucket().file(path).delete({ ignoreNotFound: true }),
      logger,
    });
  } catch (err) {
    if (err instanceof DeleteImportError) throw new HttpsError(err.code, err.message);
    logger.error("Delete import failed", { uid, importId: request.data?.importId, message: err.message });
    throw new HttpsError("internal", "We couldn't delete this statement. Please try again.");
  }
});

/**
 * Remembers the user's category choices per merchant (SCRUM-75).
 * Fires on every transaction write; cacheUpdateFor() decides whether a user just
 * chose a category. Failing here only means the next import won't use that choice.
 */
exports.onTransactionCategoryChanged = onDocumentWritten("users/{uid}/transactions/{txnId}", async (event) => {
  const { uid } = event.params;
  const update = cacheUpdateFor(event.data?.before?.data() ?? null, event.data?.after?.data() ?? null);
  if (!update) return;
  try {
    await createMerchantCache({ db, uid }).save(update.merchant, update.category);
  } catch (err) {
    logger.error("Could not update merchant cache", { uid, message: err.message });
  }
});
