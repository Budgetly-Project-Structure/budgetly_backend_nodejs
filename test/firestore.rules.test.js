const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const fs = require('fs');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-budgetly',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/alice/transactions/t1'),
      { amountCents: -450, merchant: 'Starbucks', category: 'Dining', categorySource: 'ai' });
  });
});

after(() => env.cleanup());

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();

describe('Firestore security rules: transactions', () => {
  it('owner can read own transaction', () =>
    assertSucceeds(getDoc(doc(alice(), 'users/alice/transactions/t1'))));

  it('other user cannot read it', () =>
    assertFails(getDoc(doc(bob(), 'users/alice/transactions/t1'))));

  it('unauthenticated user cannot read it', () =>
    assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/alice/transactions/t1'))));

  it('owner cannot create transactions directly', () =>
    assertFails(setDoc(doc(alice(), 'users/alice/transactions/t2'), { amountCents: 100 })));

  it('owner can recategorize', () =>
    assertSucceeds(updateDoc(doc(alice(), 'users/alice/transactions/t1'),
      { category: 'Coffee', categorySource: 'user' })));

  it('owner cannot change the amount', () =>
    assertFails(updateDoc(doc(alice(), 'users/alice/transactions/t1'), { amountCents: 0 })));
});