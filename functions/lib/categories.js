/**
 * categories.js (SCRUM-68)
 *
 * The fixed category list and the category values a transaction can carry.
 * Copied from budgetly_contracts/schemas/categories.md; the web app has the same
 * list in src/data/mockData.js. Change the contract first, then both copies.
 */
"use strict";

// kind: "spending" counts as money out, "income" as money in, "transfer" as neither,
// "none" = not decided yet. ai: whether the AI model may choose it.
const CATEGORIES = [
  { id: "dining", label: "Dining Out", kind: "spending", ai: true },
  { id: "groceries", label: "Groceries", kind: "spending", ai: true },
  { id: "transportation", label: "Transportation", kind: "spending", ai: true },
  { id: "subscriptions", label: "Subscriptions", kind: "spending", ai: true },
  { id: "shopping", label: "Shopping", kind: "spending", ai: true },
  { id: "utilities", label: "Utilities", kind: "spending", ai: true },
  { id: "entertainment", label: "Entertainment", kind: "spending", ai: true },
  { id: "health", label: "Health", kind: "spending", ai: true },
  { id: "income", label: "Income", kind: "income", ai: true },
  { id: "transfers", label: "Transfer", kind: "transfer", ai: true },
  { id: "uncategorized", label: "Uncategorized", kind: "none", ai: false },
];

const UNCATEGORIZED = "uncategorized";
const TRANSFER_CATEGORY = "transfers";

// Who set a transaction's category, from least to most trusted (see the contract)
const CATEGORY_SOURCES = ["none", "ai", "cache", "rule", "user"];

// Below this confidence the web app flags a transaction for review
const LOW_CONFIDENCE = 0.7;

/** The categories the AI may choose from, as { id, label } for the request. */
const AI_CATEGORIES = CATEGORIES.filter((c) => c.ai).map(({ id, label }) => ({ id, label }));

/** True for a built-in category id or a user's own ("custom-..."). */
function isKnownCategory(id) {
  return CATEGORIES.some((c) => c.id === id) || /^custom-[a-z0-9-]+$/.test(String(id));
}

/** Category fields for a transaction nothing has categorized yet. */
function uncategorizedFields() {
  return { category: UNCATEGORIZED, categoryConfidence: null, categorySource: "none" };
}

module.exports = {
  CATEGORIES,
  AI_CATEGORIES,
  CATEGORY_SOURCES,
  LOW_CONFIDENCE,
  UNCATEGORIZED,
  TRANSFER_CATEGORY,
  isKnownCategory,
  uncategorizedFields,
};
