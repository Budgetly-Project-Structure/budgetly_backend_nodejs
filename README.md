# Budgetly — Backend (Node.js)

Server side for Budgetly: Firebase Cloud Functions that import bank statements, categorize transactions with AI, and serve data to the web and mobile apps.

## Budgetly Repositories

| Repo | Contents |
|---|---|
| [budgetly_web_customer](https://github.com/zsheppard78/budgetly_web_customer) | Customer-facing React web app |
| [budgetly_web_dash](https://github.com/zsheppard78/budgetly_web_dash) | Dashboard web app |
| **budgetly_backend_nodejs** (this repo) | Firebase Cloud Functions (Node.js), Firestore rules |
| [budgetly_contracts](https://github.com/zsheppard78/budgetly_contracts) | Interfaces: data schemas, API definitions, AI interface |
| [budgetly_assets](https://github.com/zsheppard78/budgetly_assets) | Docs, images, reports |

Every function here implements an interface defined in **budgetly_contracts**. Change the contract first, then the code.

## Tech Stack

- **Firebase Cloud Functions** (Node.js)
- **Cloud Firestore**
- **Firebase Auth** (tokens verified in functions)

## Structure

```
functions/          Cloud Functions source
.gitignore
README.md
```

Planned: `firebase.json`, `firestore.rules`, `firestore.indexes.json`

## Planned Functions (Sprint 2)

- **Statement import:** receive an uploaded CSV/PDF statement, parse it, write transactions to Firestore, and report partial failures and status
- **Transaction categorization:** send merchant, amount, and date to an AI model and return a category and confidence score, falling back to "Uncategorized" on failure

## Local Setup

Requires [Node.js](https://nodejs.org) (LTS) and the Firebase CLI.

```bash
npm install -g firebase-tools
firebase login
cd functions
npm install
firebase emulators:start
```

Deploy (requires project access):

```bash
firebase deploy --only functions
```

## Backups (Sprint 5 #15)

Every day at 3 AM Central the `purgeDeleted` scheduled function first starts a **Firestore export** of the whole default database to the default Storage bucket, in `backups/YYYY-MM-DD/`, and deletes backups older than 7 days (`functions/lib/backupJob.js`). If the export can't be started, that day's archiving is skipped, so nothing leaves the live data without a fresh backup. After the backup, the same job moves what users deleted more than 30 days ago into the admin-only archive (`archive_*` collections and `archive/` in Storage, `functions/lib/purgeJob.js`, Sprint 5 #12); nothing is deleted for good. The full plan, and how backups differ from the archive, is in budgetly_assets `docs/data-framework.md`.

It costs nothing: no second database, no paid managed backups or point-in-time recovery, and no new Cloud Scheduler job. An export is billed as one read per document, far under the free 50,000 reads a day at our size, and a week of exports is a few MB in the bucket. Check the billing report after the first week to confirm. Users can never reach `backups/` (`storage.rules`).

### One-time setup

The functions run as the project's default compute service account, which needs permission to start exports. Find the project number on the Firebase console's Project settings page, then (once, as a project owner):

```bash
gcloud projects add-iam-policy-binding budgetly-backend-nodejs \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.importExportAdmin"
```

That's the **Cloud Datastore Import Export Admin** role. Without it the function logs "Backup could not be started" and skips the cleanup. Granting a role is free.

### Back up by hand

Before a risky script or a migration (needs your own Google login with the same role, which project owners have):

```bash
gcloud auth application-default login
cd functions
npm run backup -- --project budgetly-backend-nodejs
```

It writes to `backups/YYYY-MM-DD-manual-HHMM/` (UTC). Pass `--bucket <name>` if the default bucket isn't `<project>.firebasestorage.app`.

### Restore (admins only, never from the app)

```bash
gcloud firestore import gs://<default bucket>/backups/2026-11-22/ --project <project>
```

An import writes every document in the backup over the matching document in the database, and doesn't delete documents created later. **Practice on a throwaway Firebase project or the emulator first, never on live**, then copy back only what's needed with an admin script.

On the local emulators there's no export API: `purgeDeleted` skips the backup there and still runs the cleanup.

## Secrets

API keys (e.g., the AI model key) are stored with Firebase Functions secrets and are never committed or placed in frontend code.

## Workflow

All changes go through a branch and pull request with at least one reviewer approval. No direct pushes to `main`.

## Team

- Zach Sheppard
- Tyler Petersen

CSCI 475 / CIS 675: Software Engineering, UW-Parkside, Fall 2026