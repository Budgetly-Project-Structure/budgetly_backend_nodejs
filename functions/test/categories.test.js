/**
 * Tests for categories.js (SCRUM-68): the backend's copy of the category contract.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  CATEGORIES,
  AI_CATEGORIES,
  CATEGORY_SOURCES,
  isKnownCategory,
  uncategorizedFields,
} = require("../lib/categories");
const { categorizeByRules } = require("../lib/transferRules");

describe("categories", () => {
  test("matches the contract's list (budgetly_contracts/schemas/categories.md)", () => {
    assert.deepEqual(
      CATEGORIES.map((c) => c.id),
      ["dining", "groceries", "transportation", "subscriptions", "shopping", "utilities", "entertainment", "health", "income", "transfers", "uncategorized"]
    );
  });

  test("ids are unique and lowercase", () => {
    const ids = CATEGORIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^[a-z]+$/.test(id)));
  });

  test("the AI may choose everything except Uncategorized, and gets only id + label", () => {
    assert.equal(AI_CATEGORIES.length, CATEGORIES.length - 1);
    assert.ok(!AI_CATEGORIES.some((c) => c.id === "uncategorized"));
    assert.deepEqual(Object.keys(AI_CATEGORIES[0]), ["id", "label"]);
  });

  test("isKnownCategory accepts built-in and custom ids only", () => {
    assert.equal(isKnownCategory("dining"), true);
    assert.equal(isKnownCategory("custom-pet-care"), true);
    assert.equal(isKnownCategory("Dining"), false);
    assert.equal(isKnownCategory("custom-"), false);
    assert.equal(isKnownCategory("food"), false);
    assert.equal(isKnownCategory(undefined), false);
  });

  test("category sources listed in the contract", () => {
    assert.deepEqual(CATEGORY_SOURCES, ["none", "ai", "cache", "rule", "user"]);
  });

  test("the transfer rules use ids from this list", () => {
    assert.deepEqual(categorizeByRules("SQ *MKT 4471", -5, "credit"), uncategorizedFields());
    assert.ok(isKnownCategory(categorizeByRules("Starbucks", -5, "credit").category));
    assert.ok(isKnownCategory(categorizeByRules("PAYMENT THANK YOU", 100, "credit").category));
  });
});
