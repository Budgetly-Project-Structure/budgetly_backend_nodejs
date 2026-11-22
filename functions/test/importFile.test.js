/**
 * Tests for lib/importFile.js (Sprint 5 #2): the file name and type come from the
 * import's storagePath instead of being saved on the import record.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { fileNameFromPath, fileTypeFromPath } = require("../lib/importFile");

describe("fileNameFromPath", () => {
  test("is the last part of the path", () => {
    assert.equal(fileNameFromPath("users/alice/imports/1700000000000_sept.csv"), "1700000000000_sept.csv");
  });
  test("is null without a path", () => {
    assert.equal(fileNameFromPath(null), null);
    assert.equal(fileNameFromPath(undefined), null);
    assert.equal(fileNameFromPath(""), null);
  });
});

describe("fileTypeFromPath", () => {
  test("is the extension in lower case", () => {
    assert.equal(fileTypeFromPath("users/alice/imports/1_Statement.PDF"), "pdf");
    assert.equal(fileTypeFromPath("users/alice/imports/1_my.bank.csv"), "csv");
  });
  test("is null without an extension or a path", () => {
    assert.equal(fileTypeFromPath("users/alice/imports/1_statement"), null);
    assert.equal(fileTypeFromPath(null), null);
  });
});
