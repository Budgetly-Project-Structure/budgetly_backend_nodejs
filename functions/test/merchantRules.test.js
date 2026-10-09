/**
 * Tests for merchantRules.js: free keyword categorization (no AI, no cost).
 * Most merchant names here come from real statement screenshots.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { categorizeMerchant, RULE_CONFIDENCE } = require("../lib/merchantRules");
const { categorizeByRules } = require("../lib/transferRules");
const { parseStatementCsv } = require("../lib/csvParser");

const cat = (merchant, amount = -10) => categorizeMerchant(merchant, amount)?.category ?? "uncategorized";

describe("categorizeMerchant", () => {
  test("real statement merchants land in the right category", () => {
    const expected = {
      "LYFT *RIDE SUN 8PM": "transportation",
      "SQ *TACO LOCO": "dining",
      "BOWLERO SPRINGFIELD": "entertainment",
      "ALDI 72031 SPRINGFIELD": "groceries",
      "PANERA BREAD #601234": "dining",
      "CHICK-FIL-A #02211": "dining",
      "STARBUCKS STORE 08812": "dining",
      "AMAZON.COM*2K4LM89Q3 AMZN.COM/BILL WA": "shopping",
      "MCDONALD'S F12345": "dining",
      "OPENAI *CHATGPT SUBSCR": "subscriptions",
      "SPEEDWAY 06421": "transportation",
      "WAL-MART SUPERCENTER #2241": "groceries",
      "SPRINGFIELD FAMILY DENTAL": "health",
      "TRADER JOE'S #528": "groceries",
      "DOMINO'S 6612": "dining",
      "UBER *EATS PENDING": "dining",
      "SQ *BLUE BOTTLE COFFEE": "dining",
      "REGAL CINEMAS": "entertainment",
      "COSTCO WHSE #0389": "groceries",
      "IKEA COLUMBUS": "shopping",
      "NETFLIX.COM": "subscriptions",
      "Evergy Electric": "utilities",
      "Google Fiber": "utilities",
      "CVS/PHARMACY #8812": "health",
      "SHELL OIL 57442": "transportation",
      "TARGET T-1123": "shopping",
    };
    for (const [merchant, category] of Object.entries(expected)) {
      assert.equal(cat(merchant), category, merchant);
    }
  });

  test("specific patterns win over general ones", () => {
    assert.equal(cat("UBER *EATS PENDING"), "dining");
    assert.equal(cat("UBER *TRIP"), "transportation");
    assert.equal(cat("AMAZON PRIME*2K4LM"), "subscriptions");
    assert.equal(cat("AMAZON.COM*2K4LM"), "shopping");
  });

  test("income only for money coming in", () => {
    assert.equal(cat("ACME CORP PAYROLL", 1850), "income");
    assert.equal(cat("DIRECT DEPOSIT EMPLOYER", 900), "income");
    assert.equal(cat("GUSTO PAYROLL", -1850), "uncategorized"); // paying someone else
  });

  test("a refund keeps the store's category", () => {
    assert.equal(cat("AMAZON.COM REFUND AMZN.COM/BILL", 31.51), "shopping");
  });

  test("unknown merchants stay uncategorized", () => {
    for (const m of ["SQ *MKT 4471", "Venmo Payment", "ZELLE TO J SMITH", "CHECK 1043", ""]) {
      assert.equal(categorizeMerchant(m, -20), null, m);
    }
  });

  test("whole words only (no matches inside other words)", () => {
    assert.equal(cat("BPXQ HOLDINGS"), "uncategorized"); // not BP
    assert.equal(cat("AMCORP LLC"), "uncategorized"); // not AMC
  });

  test("saved as a rule with 0.9 confidence (above the 0.7 review line)", () => {
    assert.deepEqual(categorizeMerchant("STARBUCKS", -5), { category: "dining", categoryConfidence: 0.9, categorySource: "rule" });
    assert.ok(RULE_CONFIDENCE >= 0.7 && RULE_CONFIDENCE < 1);
  });
});

describe("categorizeByRules order", () => {
  test("a card payment is a transfer even if it mentions a store", () => {
    assert.equal(categorizeByRules("TARGET CARD AUTOMATIC PAYMENT - THANK YOU", 500, "credit").category, "transfers");
  });

  test("most rows of the sample statements are categorized for free", () => {
    const rate = (file) => {
      const { transactions } = parseStatementCsv(fs.readFileSync(path.join(__dirname, "fixtures", file)));
      const hit = transactions.filter((t) => categorizeByRules(t.merchant, t.amount, null).category !== "uncategorized");
      return hit.length / transactions.length;
    };
    for (const file of ["checking_sept_2026.csv", "credit_card_signed_aug_2026.csv", "credit_card_no_balance_sept_2026.csv"]) {
      assert.ok(rate(file) >= 0.8, `${file}: ${Math.round(rate(file) * 100)}%`);
    }
  });
});
