/**
 * Budgetly Cloud Functions
 *
 * onStatementUploaded (SCRUM-23)
 * Runs automatically when a file finishes uploading to Firebase Storage.
 * If it's a bank statement (CSV or PDF) in a user's imports folder, it creates
 * an Import record in Firestore so the app can show the upload's status.
 *
 * Parsing the file happens in later tickets (SCRUM-24 CSV, SCRUM-25 PDF),
 * and writing transactions in SCRUM-26. This function only records the upload.
 *
 * Storage path:   users/{uid}/imports/{fileName}
 * Firestore doc:  users/{uid}/imports/{importId}
 */

// --- Imports ---------------------------------------------------------------
// Trigger that fires when a Storage upload completes
const { onObjectFinalized } = require("firebase-functions/v2/storage");
// Admin SDK: server-side access to Firestore (bypasses security rules)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
// Logs show up in Firebase Console → Functions → Logs
const logger = require("firebase-functions/logger");

// --- Setup -----------------------------------------------------------------
// Runs once when the function starts, not on every upload
initializeApp();
const db = getFirestore();

// Only these file types are accepted as statements
const ALLOWED_TYPES = ["csv", "pdf"];

// --- Function --------------------------------------------------------------
exports.onStatementUploaded = onObjectFinalized(async (event) => {
  // Full path of the uploaded file, e.g. "users/abc123/imports/1696000000_jan.csv"
  const filePath = event.data.name;
  const parts = filePath.split("/");

  // 1. FILTER: this fires for EVERY file uploaded to the bucket,
  //    so exit unless the path is users/{uid}/imports/{fileName}
  //    Note: creating a folder in the emulator's Storage UI uploads an empty
  //    placeholder like "users/abc/imports/" (fileName = ""). It passes this
  //    check and then gets skipped by the file-type check in step 3.
  if (parts.length !== 4 || parts[0] !== "users" || parts[2] !== "imports") {
    return;
  }

  // 2. EXTRACT info from the path
  const uid = parts[1];
  const fileName = parts[3];
  const ext = fileName.split(".").pop().toLowerCase();

  // 3. VALIDATE file type (Storage rules already block others; this is a backup)
  if (!ALLOWED_TYPES.includes(ext)) {
    logger.warn("Unsupported file type, skipping", { filePath });
    return;
  }

  // 4. CREATE the Import record at users/{uid}/imports/{auto-id}
  const importRef = db
    .collection("users").doc(uid)
    .collection("imports").doc();

  await importRef.set({
    fileName,                          // shown in the UI
    storagePath: filePath,             // where the parser will download it from
    fileType: ext,                     // "csv" or "pdf": decides which parser runs
    sizeBytes: Number(event.data.size),
    status: "uploaded",                // lifecycle: uploaded → processing → complete | failed
    uploadedAt: FieldValue.serverTimestamp(),
  });

  // 5. LOG success for debugging in the Firebase console
  logger.info("Import created", { uid, importId: importRef.id, fileName });
});