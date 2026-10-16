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
const { doc, getDoc, setDoc, updateDoc, deleteDoc, Timestamp } = require('firebase/firestore');
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

  it('owner can read, change and delete their budget', async () => {
    await assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 250 }));
    await assertSucceeds(getDoc(budget(alice())));
    await assertSucceeds(setDoc(budget(alice()), { categoryId: 'dining', limit: 300 }));
    await assertSucceeds(deleteDoc(budget(alice())));
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
