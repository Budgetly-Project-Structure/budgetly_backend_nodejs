/**
 * firestore.rules.test.js
 *
 * Tests that firestore.rules really block what they should, using the
 * Firestore emulator. Each test acts as a specific user and expects the
 * read/write to succeed or fail.
 *
 * Run from budgetly_backend_nodejs/ (not functions/):
 *   1. firebase emulators:start --only firestore   (in one terminal)
 *   2. npm test                                   (in another; runs mocha)
 *
 * Users: "alice" owns the test transaction, "bob" is a different logged-in user,
 * and unauthenticatedContext() is someone not logged in.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, Timestamp, serverTimestamp } = require('firebase/firestore');
const fs = require('fs');

// The test environment: an emulator connection that loads our real rules file
let env;

// Runs once before all tests: point at the local emulator and load firestore.rules
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-budgetly',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

// Runs before every test: wipe the database, then add one transaction for alice.
// withSecurityRulesDisabled acts like the server (Admin SDK), since users can't create transactions.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/alice/transactions/t1'),
      { amountCents: -450, merchant: 'Starbucks', category: 'Dining', categorySource: 'ai' });
  });
});

// Close the emulator connection when all tests are done
after(() => env.cleanup());

// Helpers: a Firestore client logged in as alice, or as bob
const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();

describe('Firestore security rules: transactions', () => {
  // Reading: only the owner can see their transactions
  it('owner can read own transaction', () =>
    assertSucceeds(getDoc(doc(alice(), 'users/alice/transactions/t1'))));

  it('other user cannot read it', () =>
    assertFails(getDoc(doc(bob(), 'users/alice/transactions/t1'))));

  it('unauthenticated user cannot read it', () =>
    assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/alice/transactions/t1'))));

  // Writing: transactions come from the import Cloud Function, never straight from the app
  it('owner cannot create transactions directly', () =>
    assertFails(setDoc(doc(alice(), 'users/alice/transactions/t2'), { amountCents: 100 })));

  // The only change a user can make is the category (and it must be marked categorySource: 'user')
  it('owner can recategorize', () =>
    assertSucceeds(updateDoc(doc(alice(), 'users/alice/transactions/t1'),
      { category: 'Coffee', categorySource: 'user' })));

  it('owner cannot change the amount', () =>
    assertFails(updateDoc(doc(alice(), 'users/alice/transactions/t1'), { amountCents: 0 })));
});

describe('Firestore security rules: budgets', () => {
  const budget = (db, user = 'alice', cat = 'dining') => doc(db, `users/${user}/budgets/${cat}`);

  it('owner can create a budget', () =>
    assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 250 })));

  it('owner can read and change their budget, but not hard delete it', async () => {
    await assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 250 }));
    await assertSucceeds(getDoc(budget(alice())));
    await assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 300 }));
    await assertFails(deleteDoc(budget(alice()))); // soft delete only (see below)
  });

  it('other user cannot read or write it', async () => {
    await assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 250 }));
    await assertFails(getDoc(budget(bob())));
    await assertFails(setDoc(budget(bob(), 'alice'), { categoryId: 'dining', limit: 1 }));
  });

  it('unauthenticated user cannot write one', () =>
    assertFails(setDoc(budget(env.unauthenticatedContext().firestore()), { categoryId: 'dining', limit: 1 })));

  it('limit must be a non-negative number', async () => {
    await assertFails(setDoc(budget(alice()), { categoryId: 'dining', limit: -5 }));
    await assertFails(setDoc(budget(alice()), { categoryId: 'dining', limit: '250' }));
  });

  it('categoryId must match the document id and no extra fields are allowed', async () => {
    await assertFails(setDoc(budget(alice()), { categoryId: 'groceries', limit: 250 }));
    await assertFails(setDoc(budget(alice()), { categoryId: 'dining', limit: 250, note: 'x' }));
  });
});

describe('Firestore security rules: profile and settings (SCRUM-88)', () => {
  const profile = (db, user = 'alice') => doc(db, `users/${user}`);
  // A profile like the one signup creates
  const createProfile = () =>
    env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'users/alice'), { email: 'alice@example.com', displayName: 'Alice', createdAt: Timestamp.now() }));

  it('owner can set and change their monthly income', async () => {
    await createProfile();
    await assertSucceeds(updateDoc(profile(alice()), { monthlyIncome: 3200 }));
    await assertSucceeds(updateDoc(profile(alice()), { monthlyIncome: 3450.5 }));
  });

  it('owner can clear their monthly income (null) or set it to 0', async () => {
    await createProfile();
    await assertSucceeds(updateDoc(profile(alice()), { monthlyIncome: null }));
    await assertSucceeds(updateDoc(profile(alice()), { monthlyIncome: 0 }));
  });

  it('monthly income must be a dollar amount from 0 to 10 million', async () => {
    await createProfile();
    await assertFails(updateDoc(profile(alice()), { monthlyIncome: -100 }));
    await assertFails(updateDoc(profile(alice()), { monthlyIncome: '3200' }));
    await assertFails(updateDoc(profile(alice()), { monthlyIncome: 20000000 }));
  });

  it('owner can change their name and income together; the name must be 1-60 characters', async () => {
    await createProfile();
    await assertSucceeds(updateDoc(profile(alice()), { displayName: 'Alice P', monthlyIncome: 2000 }));
    await assertFails(updateDoc(profile(alice()), { displayName: '' }));
    await assertFails(updateDoc(profile(alice()), { displayName: 'x'.repeat(61) }));
  });

  it('other fields still cannot be changed', async () => {
    await createProfile();
    await assertFails(updateDoc(profile(alice()), { email: 'someone@else.com' }));
    await assertFails(updateDoc(profile(alice()), { monthlyIncome: 3000, isAdmin: true }));
  });

  it('other users cannot read or change it', async () => {
    await createProfile();
    await assertFails(getDoc(profile(bob(), 'alice')));
    await assertFails(updateDoc(profile(bob(), 'alice'), { monthlyIncome: 1 }));
  });

  it('a missing profile can be created with the allowed fields, including monthly income', async () => {
    await assertSucceeds(setDoc(profile(alice()), { displayName: 'Alice', monthlyIncome: 1500 }, { merge: true }));
    await assertFails(setDoc(profile(bob(), 'bob'), { displayName: 'Bob', monthlyIncome: -1 }));
  });
});

describe('Firestore security rules: manual transactions', () => {
  const txn = (db, id = 'm1', user = 'alice') => doc(db, `users/${user}/transactions/${id}`);
  // A valid manual transaction owned by alice
  const manual = (extra = {}) => ({
    userId: 'alice',
    date: Timestamp.fromDate(new Date('2026-10-15T12:00:00Z')),
    merchant: 'Farmers market',
    amount: -23.5,
    category: 'groceries',
    categorySource: 'user',
    categoryConfidence: 1,
    isUserCorrected: true,
    accountId: null,
    sourceStatementId: null,
    source: 'manual',
    ...extra,
  });
  // Puts a manual transaction in the database as alice, bypassing the rules
  const seed = () =>
    env.withSecurityRulesDisabled((ctx) => setDoc(txn(ctx.firestore()), manual()));

  it('owner can add a manual transaction', () =>
    assertSucceeds(setDoc(txn(alice()), manual())));

  it('cannot add one for someone else, or marked as imported', async () => {
    await assertFails(setDoc(txn(alice()), manual({ userId: 'bob' })));
    await assertFails(setDoc(txn(bob(), 'm1', 'alice'), manual()));
    await assertFails(setDoc(txn(alice()), manual({ source: 'import' })));
  });

  it('rejects a bad amount, merchant, date or extra field', async () => {
    await assertFails(setDoc(txn(alice()), manual({ amount: 0 })));
    await assertFails(setDoc(txn(alice()), manual({ amount: '10' })));
    await assertFails(setDoc(txn(alice()), manual({ merchant: '' })));
    await assertFails(setDoc(txn(alice()), manual({ merchant: 'x'.repeat(101) })));
    await assertFails(setDoc(txn(alice()), manual({ date: '2026-10-15' })));
    await assertFails(setDoc(txn(alice()), manual({ note: 'extra' })));
  });

  it('owner can edit a manual transaction', async () => {
    await seed();
    await assertSucceeds(updateDoc(txn(alice()), { merchant: 'Aldi', amount: -30, category: 'groceries' }));
  });

  it('other user cannot edit or delete it', async () => {
    await seed();
    await assertFails(updateDoc(txn(bob(), 'm1', 'alice'), { merchant: 'Hacked' }));
    await assertFails(deleteDoc(txn(bob(), 'm1', 'alice')));
  });

  it('owner can delete a manual transaction', async () => {
    await seed();
    await assertSucceeds(deleteDoc(txn(alice())));
  });

  it('imported transactions still cannot be edited (except category) or deleted', async () => {
    await assertFails(updateDoc(txn(alice(), 't1'), { merchant: 'Changed' }));
    await assertFails(deleteDoc(txn(alice(), 't1')));
  });
});

// Soft delete (data-framework.md): the app never removes a manual transaction or a
// budget. It sets deletedAt (now), deletedBy (the caller) and purgeAfter together,
// and restoring clears all three. The server removes it for good after purgeAfter.
describe('Firestore security rules: soft delete', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // The three fields a soft delete sets, as the app sends them
  const softDelete = (by = 'alice') => ({
    deletedAt: serverTimestamp(),
    deletedBy: by,
    purgeAfter: Timestamp.fromMillis(Date.now() + 30 * DAY),
  });
  const restore = { deletedAt: null, deletedBy: null, purgeAfter: null };
  // Already soft deleted (seeded past the rules)
  const deletedFields = () => ({
    deletedAt: Timestamp.fromMillis(Date.now() - DAY),
    deletedBy: 'alice',
    purgeAfter: Timestamp.fromMillis(Date.now() + 29 * DAY),
  });

  const txn = (db, id = 'm1') => doc(db, `transactions/${id}`);
  const manualTxn = (extra = {}) => ({
    userId: 'alice',
    date: Timestamp.fromDate(new Date('2026-10-15T12:00:00Z')),
    merchant: 'Farmers market',
    amount: -23.5,
    category: 'groceries',
    categorySource: 'user',
    source: 'manual',
    deletedAt: null,
    ...extra,
  });
  const budget = (db, user = 'alice') => doc(db, `users/${user}/budgets/dining`);
  const seed = (path, data) =>
    env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));

  describe('manual transactions (transactions/)', () => {
    it('hard delete is denied', async () => {
      await seed('transactions/m1', manualTxn());
      await assertFails(deleteDoc(txn(alice())));
    });

    it('owner can soft delete', async () => {
      await seed('transactions/m1', manualTxn());
      await assertSucceeds(updateDoc(txn(alice()), softDelete()));
    });

    it('deletedBy set to someone else is denied', async () => {
      await seed('transactions/m1', manualTxn());
      await assertFails(updateDoc(txn(alice()), softDelete('bob')));
    });

    it("cannot soft delete another user's transaction", async () => {
      await seed('transactions/m1', manualTxn());
      await assertFails(updateDoc(txn(bob()), softDelete('bob')));
    });

    it('changing other fields in the same write is denied', async () => {
      await seed('transactions/m1', manualTxn());
      await assertFails(updateDoc(txn(alice()), { ...softDelete(), amount: -1 }));
    });

    it('a soft delete must set all three fields, with a later purgeAfter', async () => {
      await seed('transactions/m1', manualTxn());
      await assertFails(updateDoc(txn(alice()), { deletedAt: serverTimestamp(), deletedBy: 'alice' }));
      await assertFails(updateDoc(txn(alice()), { ...softDelete(), purgeAfter: Timestamp.fromMillis(Date.now() - DAY) }));
    });

    it('imported transactions cannot be soft deleted from the app', async () => {
      await seed('transactions/i1', manualTxn({ source: 'import' }));
      await assertFails(updateDoc(txn(alice(), 'i1'), softDelete()));
    });

    it('owner can restore a deleted one (all three cleared)', async () => {
      await seed('transactions/m1', manualTxn(deletedFields()));
      await assertSucceeds(updateDoc(txn(alice()), restore));
    });

    it('restore must clear all three fields', async () => {
      await seed('transactions/m1', manualTxn(deletedFields()));
      await assertFails(updateDoc(txn(alice()), { deletedAt: null }));
    });
  });

  describe('budgets', () => {
    it('hard delete is denied', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250 });
      await assertFails(deleteDoc(budget(alice())));
    });

    it('owner can soft delete', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250 });
      await assertSucceeds(updateDoc(budget(alice()), softDelete()));
    });

    it('deletedBy set to someone else is denied', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250 });
      await assertFails(updateDoc(budget(alice()), softDelete('bob')));
    });

    it("cannot soft delete another user's budget", async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250 });
      await assertFails(updateDoc(doc(bob(), 'users/alice/budgets/dining'), softDelete('bob')));
    });

    it('changing other fields in the same write is denied', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250 });
      await assertFails(updateDoc(budget(alice()), { ...softDelete(), limit: 0 }));
    });

    it('owner can restore a deleted one', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250, ...deletedFields() });
      await assertSucceeds(updateDoc(budget(alice()), restore));
    });

    it('saving a limit cannot undo a delete; restore first', async () => {
      await seed('users/alice/budgets/dining', { categoryId: 'dining', limit: 250, ...deletedFields() });
      await assertFails(setDoc(budget(alice()), { categoryId: 'dining', limit: 300 }));
    });
  });
});

// SCRUM-114: ownership and impersonation on the top-level transactions collection.
// The owner is the userId field, not the path, so these tests try the attacks that
// matter: reading or querying someone else's data, creating or taking over a document
// with someone else's userId, and reassigning a document to another user.
// request.auth.uid comes from the verified login token, which the browser (or a tool
// like Postman) cannot forge, so a request can only ever act as the user who signed in.
describe('Firestore security rules: ownership and impersonation (SCRUM-114)', () => {
  const unauth = () => env.unauthenticatedContext().firestore();
  const txn = (db, id) => doc(db, `transactions/${id}`);
  const manual = (extra = {}) => ({
    userId: 'alice',
    date: Timestamp.fromDate(new Date('2026-10-15T12:00:00Z')),
    merchant: 'Farmers market',
    amount: -23.5,
    category: 'groceries',
    categorySource: 'user',
    categoryConfidence: 1,
    isUserCorrected: true,
    accountId: null,
    sourceStatementId: null,
    source: 'manual',
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
    ...extra,
  });
  // An imported transaction, as the import Cloud Function writes it
  const imported = (extra = {}) => ({
    userId: 'alice',
    date: Timestamp.fromDate(new Date('2026-09-05T12:00:00Z')),
    merchant: 'Venmo Cashout',
    amount: 40,
    category: 'uncategorized',
    categorySource: 'none',
    categoryConfidence: null,
    isUserCorrected: false,
    accountId: null,
    sourceStatementId: 'imp1',
    source: 'import',
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
    ...extra,
  });

  // Alice has one manual and one imported transaction; bob has one manual (all seeded past the rules)
  beforeEach(() =>
    env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(txn(db, 'a-manual'), manual());
      await setDoc(txn(db, 'a-import'), imported());
      await setDoc(txn(db, 'b-manual'), manual({ userId: 'bob', merchant: 'Bobs lunch' }));
    }));

  describe('reading', () => {
    it('owner can read their own transaction', () =>
      assertSucceeds(getDoc(txn(alice(), 'a-manual'))));

    it("another user cannot read it, even by guessing the document ID", () =>
      assertFails(getDoc(txn(bob(), 'a-manual'))));

    it('an unauthenticated user cannot read it', () =>
      assertFails(getDoc(txn(unauth(), 'a-manual'))));

    it('a query limited to your own userId works, and returns only your documents', async () => {
      const snap = await assertSucceeds(getDocs(query(collection(alice(), 'transactions'), where('userId', '==', 'alice'))));
      if (snap.size !== 2) throw new Error(`expected alice's 2 transactions, got ${snap.size}`);
    });

    it('the app query (own userId and not deleted) works', () =>
      assertSucceeds(getDocs(query(collection(alice(), 'transactions'),
        where('userId', '==', 'alice'), where('deletedAt', '==', null)))));

    it("a query for someone else's userId is rejected", () =>
      assertFails(getDocs(query(collection(bob(), 'transactions'), where('userId', '==', 'alice')))));

    it('a query with no userId filter is rejected (rules are not filters)', () =>
      assertFails(getDocs(collection(alice(), 'transactions'))));

    it('an unauthenticated query is rejected', () =>
      assertFails(getDocs(query(collection(unauth(), 'transactions'), where('userId', '==', 'alice')))));
  });

  describe('creating (impersonation)', () => {
    it('owner can create a manual transaction with their own userId', () =>
      assertSucceeds(setDoc(txn(alice(), 'new1'), manual())));

    it("cannot create one with someone else's userId", async () => {
      await assertFails(setDoc(txn(bob(), 'new1'), manual({ userId: 'alice' })));
      await assertFails(setDoc(txn(alice(), 'new2'), manual({ userId: 'bob' })));
    });

    it('cannot create one without a userId', () => {
      const { userId, ...noUser } = manual();
      return assertFails(setDoc(txn(alice(), 'new1'), noUser));
    });

    it('an unauthenticated user cannot create one', () =>
      assertFails(setDoc(txn(unauth(), 'new1'), manual())));

    it("cannot overwrite someone else's transaction by reusing its ID", async () => {
      await assertFails(setDoc(txn(bob(), 'a-manual'), manual({ userId: 'bob' })));
      await assertFails(setDoc(txn(bob(), 'a-import'), manual({ userId: 'bob' })));
    });

    it('cannot create an imported transaction from the app (only the server can)', () =>
      assertFails(setDoc(txn(alice(), 'new1'), imported())));
  });

  describe('changing and taking over', () => {
    it("the owner cannot reassign their own transaction to another user", async () => {
      await assertFails(updateDoc(txn(alice(), 'a-manual'), { userId: 'bob' }));
      await assertFails(updateDoc(txn(alice(), 'a-import'), { userId: 'bob' }));
    });

    it("another user cannot take over a transaction by setting userId to themselves", async () => {
      await assertFails(updateDoc(txn(bob(), 'a-manual'), { userId: 'bob' }));
      await assertFails(updateDoc(txn(bob(), 'a-import'), { userId: 'bob' }));
    });

    it("another user cannot edit or recategorize someone else's transaction", async () => {
      await assertFails(updateDoc(txn(bob(), 'a-manual'), { merchant: 'Hacked', updatedAt: serverTimestamp() }));
      await assertFails(updateDoc(txn(bob(), 'a-import'),
        { category: 'dining', categorySource: 'user', updatedAt: serverTimestamp() }));
    });

    it('the owner can still recategorize their own imported transaction', () =>
      assertSucceeds(updateDoc(txn(alice(), 'a-import'),
        { category: 'income', categorySource: 'user', updatedAt: serverTimestamp() })));

    it('an unauthenticated user cannot change or delete anything', async () => {
      await assertFails(updateDoc(txn(unauth(), 'a-manual'), { merchant: 'Hacked' }));
      await assertFails(updateDoc(txn(unauth(), 'a-import'), { category: 'dining', categorySource: 'user' }));
      await assertFails(deleteDoc(txn(unauth(), 'a-manual')));
    });

    it('source and sourceStatementId can never be changed, so a transaction cannot change type', async () => {
      await assertFails(updateDoc(txn(alice(), 'a-import'), { source: 'manual' }));
      await assertFails(updateDoc(txn(alice(), 'a-manual'), { source: 'import' }));
      await assertFails(updateDoc(txn(alice(), 'a-import'), { sourceStatementId: 'imp2' }));
    });

    it("no one can hard delete a transaction, their own or someone else's", async () => {
      await assertFails(deleteDoc(txn(alice(), 'a-manual')));
      await assertFails(deleteDoc(txn(bob(), 'a-manual')));
      await assertFails(deleteDoc(txn(alice(), 'a-import')));
    });
  });

  describe('other collections', () => {
    const importDoc = (db, user = 'alice') => doc(db, `users/${user}/imports/imp1`);
    const cacheDoc = (db, user = 'alice') => doc(db, `users/${user}/merchantCache/venmo-cashout`);
    beforeEach(() =>
      env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(importDoc(ctx.firestore()), { status: 'completed', fileType: 'csv' });
        await setDoc(cacheDoc(ctx.firestore()), { merchantKey: 'VENMO CASHOUT', category: 'income', categoryConfidence: 1 });
      }));

    it('only the owner can read an import record, and no one can write one', async () => {
      await assertSucceeds(getDoc(importDoc(alice())));
      await assertFails(getDoc(importDoc(bob(), 'alice')));
      await assertFails(getDoc(importDoc(unauth(), 'alice')));
      await assertFails(setDoc(importDoc(alice()), { status: 'completed' }));
      await assertFails(updateDoc(importDoc(alice()), { status: 'failed' }));
    });

    it('the merchant cache is server only: no one can read or write it from the app', async () => {
      await assertFails(getDoc(cacheDoc(alice())));
      await assertFails(setDoc(cacheDoc(alice()), { merchantKey: 'VENMO CASHOUT', category: 'dining', categoryConfidence: 1 }));
      await assertFails(setDoc(cacheDoc(bob(), 'alice'), { merchantKey: 'VENMO CASHOUT', category: 'dining', categoryConfidence: 1 }));
      await assertFails(getDoc(cacheDoc(unauth(), 'alice')));
    });

    it("another user cannot read or change someone else's profile", async () => {
      await env.withSecurityRulesDisabled((ctx) =>
        setDoc(doc(ctx.firestore(), 'users/alice'), { email: 'alice@example.com', displayName: 'Alice', createdAt: Timestamp.now() }));
      await assertFails(getDoc(doc(bob(), 'users/alice')));
      await assertFails(updateDoc(doc(bob(), 'users/alice'), { displayName: 'Hacked' }));
      await assertFails(updateDoc(doc(bob(), 'users/alice'), { monthlyIncome: 1 }));
    });
  });
});
