/**
 * storage.rules.test.js (Sprint 5 #11)
 *
 * Tests that storage.rules keep the archive (archive/...) and the backups (backups/...)
 * away from every user, while a user's own statement uploads still work. Uses the
 * Storage emulator.
 *
 * Run from budgetly_backend_nodejs/ (not functions/), with both emulators:
 *   firebase emulators:exec --only firestore,storage --project demo-budgetly "npm test"
 *
 * Users: "alice" owns the files, "bob" is a different logged-in user.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { ref, uploadString, getBytes, getMetadata, deleteObject } = require('firebase/storage');
const fs = require('fs');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-budgetly',
    storage: { rules: fs.readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});

beforeEach(() => env.clearStorage());

after(() => env.cleanup());

const storageAs = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
const CSV = { contentType: 'text/csv' };

// Puts a file in place the way the server would (rules off)
const seed = (path, body = 'Date,Description,Amount\n') =>
  env.withSecurityRulesDisabled((ctx) => uploadString(ref(ctx.storage(), path), body, 'raw', CSV));

describe('Storage security rules: statement uploads (unchanged)', () => {
  it('the owner can upload a CSV to their own imports folder and read it back', async () => {
    const r = ref(storageAs('alice'), 'users/alice/imports/1700000000000_sept.csv');
    await assertSucceeds(uploadString(r, 'Date,Description,Amount\n', 'raw', CSV));
    await assertSucceeds(getMetadata(r));
  });

  it("another user can't read or upload to someone else's folder", async () => {
    await seed('users/alice/imports/1_a.csv');
    await assertFails(getMetadata(ref(storageAs('bob'), 'users/alice/imports/1_a.csv')));
    await assertFails(uploadString(ref(storageAs('bob'), 'users/alice/imports/2_b.csv'), 'x', 'raw', CSV));
  });
});

describe('Storage security rules: archive (Sprint 5 #11)', () => {
  const path = 'archive/users/alice/imports/1700000000000_sept.csv';

  it("the owner can't read, download or delete their own archived file", async () => {
    await seed(path);
    const r = ref(storageAs('alice'), path);
    await assertFails(getMetadata(r));
    await assertFails(getBytes(r));
    await assertFails(deleteObject(r));
  });

  it("nobody can upload into the archive, not even into their own uid's folder", async () => {
    await assertFails(uploadString(ref(storageAs('alice'), path), 'x', 'raw', CSV));
    await assertFails(uploadString(ref(storageAs(null), path), 'x', 'raw', CSV));
  });

  it("other users and signed-out users can't read it", async () => {
    await seed(path);
    await assertFails(getMetadata(ref(storageAs('bob'), path)));
    await assertFails(getMetadata(ref(storageAs(null), path)));
  });
});

describe('Storage security rules: backups (Sprint 5 #11/#15)', () => {
  const path = 'backups/2026-11-22/all_namespaces/all_kinds/output-0';

  it("no signed-in user can read, list or delete a backup file", async () => {
    await seed(path, 'backup bytes');
    for (const uid of ['alice', 'bob']) {
      const r = ref(storageAs(uid), path);
      await assertFails(getMetadata(r));
      await assertFails(getBytes(r));
      await assertFails(deleteObject(r));
    }
  });

  it("nobody can write a backup file from the app", async () => {
    await assertFails(uploadString(ref(storageAs('alice'), 'backups/2026-11-23/fake'), 'x', 'raw', CSV));
    await assertFails(uploadString(ref(storageAs(null), 'backups/2026-11-23/fake'), 'x', 'raw', CSV));
  });
});
