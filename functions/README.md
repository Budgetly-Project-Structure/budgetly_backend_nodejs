# Budgetly Cloud Functions

Server-side code for Budgetly, deployed to Firebase Cloud Functions (Node 24).

## Functions

### `onStatementUploaded` (SCRUM-23)
Creates an Import record in Firestore when a user uploads a bank statement.
This is the first step of the import pipeline. It records the upload but
does not read the file (parsing is SCRUM-24/25).

| | |
|---|---|
| Trigger | Storage `onObjectFinalized` (upload finished) |
| Watches | `users/{uid}/imports/{fileName}` |
| Accepts | `.csv`, `.pdf` (others are logged and skipped) |
| Writes | `users/{uid}/imports/{importId}` |

**Import document fields**

| Field | Type | Description |
|---|---|---|
| `fileName` | string | Original file name, shown in the UI |
| `storagePath` | string | Storage path the parser downloads from |
| `fileType` | `"csv"` \| `"pdf"` | Decides which parser runs |
| `sizeBytes` | number | File size |
| `status` | string | `uploaded` → `processing` → `complete` / `failed` |
| `uploadedAt` | timestamp | Server time of upload |

Users can only **read** import docs (see `firestore.rules`). Only this function writes them.

## Run locally
From the repo root (not `functions/`):
```bash
firebase emulators:start
```
Emulator UI: http://127.0.0.1:4000

**Test:** in Storage, upload a `.csv` to `users/test123/imports/` and check that
one doc appears in Firestore under `users/test123/imports`. Uploading a `.txt`
to the same folder should create nothing and log `Unsupported file type`.

## Deploy
```bash
firebase deploy --only functions,storage
```

## Known limitations
- Storage triggers can occasionally fire twice, which may create a duplicate
  Import doc. To be handled in SCRUM-27 (partial failure handling).
- Requires the Blaze plan.