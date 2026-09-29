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

## Secrets

API keys (e.g., the AI model key) are stored with Firebase Functions secrets and are never committed or placed in frontend code.

## Workflow

All changes go through a branch and pull request with at least one reviewer approval. No direct pushes to `main`.

## Team

- Zach Sheppard
- Tyler Petersen

CSCI 475 / CIS 675: Software Engineering, UW-Parkside, Fall 2026