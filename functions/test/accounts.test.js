// SCRUM-166: which account an import is filed under
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { resolveAccount, ACCOUNT_GONE } = require("../lib/accounts");

const acct = (id, type, extra = {}) => ({ id, userId: "alice", type, deletedAt: null, ...extra });
/** A store with these accounts: "alice"'s active ones, plus any by id */
const storeWith = (accounts) => ({
  findAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
  activeAccounts: async () => accounts.filter((a) => a.userId === "alice" && a.deletedAt == null),
});
const run = (over) => resolveAccount({ uid: "alice", ...over });

describe("a picked account", () => {
  test("is used, with its own type", async () => {
    const store = storeWith([acct("a1", "credit")]);
    const r = await run({ store, pickedAccountId: "a1", pickedType: "checking", detectedType: "checking" });
    assert.deepEqual(r, { ok: true, accountId: "a1", accountType: "credit" });
  });
  test("someone else's account is refused", async () => {
    const store = storeWith([acct("a1", "credit", { userId: "bob" })]);
    const r = await run({ store, pickedAccountId: "a1" });
    assert.deepEqual(r, { ok: false, error: ACCOUNT_GONE });
  });
  test("a deleted account is refused", async () => {
    const store = storeWith([acct("a1", "credit", { deletedAt: new Date() })]);
    assert.equal((await run({ store, pickedAccountId: "a1" })).ok, false);
  });
  test("an account that doesn't exist is refused", async () => {
    assert.equal((await run({ store: storeWith([]), pickedAccountId: "nope" })).ok, false);
  });
  test("the built-in ids still work until they are converted", async () => {
    const r = await run({ store: storeWith([]), pickedAccountId: "acct-credit" });
    assert.deepEqual(r, { ok: true, accountId: "acct-credit", accountType: "credit" });
  });
});

describe("nothing picked", () => {
  test("the only account of the detected type is used", async () => {
    const store = storeWith([acct("c1", "checking"), acct("k1", "credit")]);
    const r = await run({ store, detectedType: "credit" });
    assert.deepEqual(r, { ok: true, accountId: "k1", accountType: "credit" });
  });
  test("two accounts of that type: left unassigned, not guessed", async () => {
    const store = storeWith([acct("c1", "checking"), acct("c2", "checking")]);
    const r = await run({ store, detectedType: "checking" });
    assert.deepEqual(r, { ok: true, accountId: null, accountType: "checking" });
  });
  test("accounts exist but none of that type: unassigned", async () => {
    const r = await run({ store: storeWith([acct("c1", "checking")]), detectedType: "credit" });
    assert.deepEqual(r, { ok: true, accountId: null, accountType: "credit" });
  });
  test("a deleted account is never picked automatically", async () => {
    const store = storeWith([acct("c1", "checking", { deletedAt: new Date() }), acct("c2", "checking")]);
    assert.equal((await run({ store, detectedType: "checking" })).accountId, "c2");
  });
  test("a type that couldn't be detected: unassigned", async () => {
    const r = await run({ store: storeWith([acct("c1", "checking")]) });
    assert.deepEqual(r, { ok: true, accountId: null, accountType: null });
  });
  test("the type sent with the upload beats the detected one", async () => {
    const store = storeWith([acct("c1", "checking"), acct("k1", "credit")]);
    assert.equal((await run({ store, pickedType: "checking", detectedType: "credit" })).accountId, "c1");
  });
});

describe("a user with no accounts yet", () => {
  test("gets the built-in account for the type, as before", async () => {
    const r = await run({ store: storeWith([]), detectedType: "checking" });
    assert.deepEqual(r, { ok: true, accountId: "acct-checking", accountType: "checking" });
  });
  test("a store without account lookups behaves the same", async () => {
    const r = await run({ store: {}, detectedType: "credit" });
    assert.deepEqual(r, { ok: true, accountId: "acct-credit", accountType: "credit" });
  });
  test("an unknown type has no account", async () => {
    assert.deepEqual(await run({ store: storeWith([]) }), { ok: true, accountId: null, accountType: null });
  });
});
