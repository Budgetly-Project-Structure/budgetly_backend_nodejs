/**
 * Tests for lib/money.js (Sprint 5 #6): money as whole cents.
 * parseCents itself is tested with the CSV parser (csvParser.test.js).
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { parseCents, centsOf, centsToDollars } = require("../lib/money");

describe("why cents", () => {
  test("dollars drift, cents don't", () => {
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(parseCents("0.10") + parseCents("0.20"), parseCents("0.30"));
  });
  test("a long statement adds up exactly in cents", () => {
    const cents = Array.from({ length: 1000 }, () => parseCents("0.10"));
    assert.equal(cents.reduce((a, b) => a + b, 0), 10000);
  });
});

describe("centsOf", () => {
  test("uses amountCents when the document has it", () => {
    assert.equal(centsOf({ amountCents: -645 }), -645);
    assert.equal(centsOf({ amountCents: -645, amount: 12 }), -645);
  });
  test("TEMPORARY: a document saved before cents is rounded from dollars", () => {
    assert.equal(centsOf({ amount: -6.45 }), -645);
    assert.equal(centsOf({ amount: 0.1 + 0.2 }), 30);
  });
  test("null when there is no usable amount", () => {
    assert.equal(centsOf({}), null);
    assert.equal(centsOf({ amount: "12" }), null);
    assert.equal(centsOf({ amountCents: 1.5 }), null);
    assert.equal(centsOf(null), null);
  });
});

describe("centsToDollars", () => {
  test("is only for display and the temporary amount field", () => {
    assert.equal(centsToDollars(-645), -6.45);
    assert.equal(centsToDollars(123456), 1234.56);
    assert.equal(centsToDollars(0), 0);
  });
});
