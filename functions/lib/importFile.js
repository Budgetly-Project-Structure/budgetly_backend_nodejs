/**
 * importFile.js (Sprint 5 #2)
 *
 * The statement's file name and type come from its Storage path,
 *   users/{uid}/imports/{timestamp}_{name}.{ext}
 * instead of being saved again on the import record (data-duplication-audit.md, D5).
 * Pure functions: no Firebase, easy to unit test.
 */
"use strict";

/**
 * The last part of the Storage path, e.g. "1700000000000_checking.csv".
 * @param {string|null|undefined} storagePath
 * @returns {string|null} null when there's no path
 */
function fileNameFromPath(storagePath) {
  if (typeof storagePath !== "string" || storagePath === "") return null;
  return storagePath.split("/").pop() || null;
}

/**
 * The file's extension in lower case, e.g. "csv" or "pdf".
 * @param {string|null|undefined} storagePath
 * @returns {string|null} null when the name has no extension
 */
function fileTypeFromPath(storagePath) {
  const name = fileNameFromPath(storagePath);
  if (!name || !name.includes(".")) return null;
  return name.split(".").pop().toLowerCase();
}

module.exports = { fileNameFromPath, fileTypeFromPath };
