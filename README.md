# Financial Planner — Backend

Backend for the CSCI 475 Team 3 Financial Planner app: a budgeting app that imports bank statements, auto-categorizes transactions with AI, and answers natural-language questions about spending.

This repo holds the server side only. The web app and project docs live in the frontend repo.

## Related Repositories

| Repo | Contents |
|---|---|
| [Frontend](https://github.com/zsheppard78/csci475---Team-3---Financial-App) | React + Tailwind web app, project docs (`assets/docs`), sprint reports |
| **Backend** (this repo) | Firebase Cloud Functions (Node.js), Firestore rules, API contract |

## Tech Stack

- **Firebase Cloud Functions** (Node.js): server logic
- **Cloud Firestore**: database
- **Firebase Auth**: user accounts (handled client-side, verified in functions)

## Structure

```
functions/          Cloud Functions source (Node.js)
.gitignore
README.md
```

Planned additions:
- `api-contract.md`: the single contract file defining every function's inputs, outputs, and error codes, plus Firestore document shapes. The web and mobile apps build against this file.
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`: Firebase configuration

## Planned Functions (Sprint 2)

- **Statement import:** receive an uploaded CSV/PDF bank statement, parse it, and write transactions to Firestore, reporting partial failures and upload status
- **Transaction categorization:** send merchant, amount, and date to an AI model and return a category label with a confidence score, falling back to "Uncategorized" on failure

## Local Setup

Requires [Node.js](https://nodejs.org) (LTS) and the Firebase CLI.

```bash
npm install -g firebase-tools
firebase login
cd functions
npm install
```

Run locally with the Firebase emulators:

```bash
firebase emulators:start
```

Deploy (requires project access):

```bash
firebase deploy --only functions
```

## Secrets

API keys (e.g., the AI model key) are stored with Firebase Functions secrets and are never committed to this repo or placed in frontend code.

## Workflow

All changes go through a branch and pull request with at least one reviewer approval. No direct pushes to `main`.

## Team

- Zach Sheppard
- Tyler Petersen

CSCI 475 / CIS 675: Software Engineering, UW-Parkside, Fall 2026
