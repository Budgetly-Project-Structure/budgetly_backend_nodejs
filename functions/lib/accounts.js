/**
 * accounts.js (SCRUM-166)
 *
 * Decides which account an imported statement belongs to. Pure logic: the two lookups come
 * from the store (firestoreStore.js), so this is easy to unit test.
 *
 *   The user picked an account   it must be theirs and not deleted, or the import fails. The
 *                                account's own type is used (the type belongs to the account,
 *                                data-duplication-audit.md D4).
 *   Nothing picked               use what the file looked like (checking or credit). If the user
 *                                has exactly one account of that type, the statement goes there.
 *                                With two or more, we can't tell which, so it is left without
 *                                an account (null) for the user to assign, never guessed.
 *   User has no accounts yet     the two built-in ids (acct-checking, acct-credit), as before,
 *                                until the accounts ship (SCRUM-167) and the old ids are
 *                                converted.
 */
"use strict";

const { ACCOUNT_ID_FOR_TYPE } = require("./accountType");

const ACCOUNT_GONE =
  "The account you picked for this statement isn't available any more. Pick another account and upload the file again.";

const LEGACY_TYPE_FOR_ID = Object.fromEntries(Object.entries(ACCOUNT_ID_FOR_TYPE).map(([type, id]) => [id, type]));

/**
 * @param {Object} opts
 * @param {string} opts.uid
 * @param {string|null} [opts.pickedAccountId]
 * @param {"credit"|"checking"|null} [opts.pickedType]  the type sent with the upload
 * @param {"credit"|"checking"|null} [opts.detectedType] what the file looked like
 * @param {Object} opts.store  may have findAccount(id) and activeAccounts(); without them the
 *                             built-in ids are used
 * @returns {Promise<{ok: true, accountId: string|null, accountType: string|null} | {ok: false, error: string}>}
 */
async function resolveAccount({ uid, pickedAccountId = null, pickedType = null, detectedType = null, store }) {
  const hasLookups = typeof store?.findAccount === "function" && typeof store?.activeAccounts === "function";
  const legacy = (type) => ({ ok: true, accountId: type ? ACCOUNT_ID_FOR_TYPE[type] : null, accountType: type ?? null });

  if (pickedAccountId) {
    // The two built-in accounts (until the old ids are converted)
    if (LEGACY_TYPE_FOR_ID[pickedAccountId]) {
      return { ok: true, accountId: pickedAccountId, accountType: pickedType ?? LEGACY_TYPE_FOR_ID[pickedAccountId] };
    }
    if (!hasLookups) return { ok: true, accountId: pickedAccountId, accountType: pickedType ?? detectedType ?? null };
    const account = await store.findAccount(pickedAccountId);
    if (!account || account.userId !== uid || account.deletedAt != null) return { ok: false, error: ACCOUNT_GONE };
    return { ok: true, accountId: pickedAccountId, accountType: account.type ?? pickedType ?? detectedType ?? null };
  }

  const type = pickedType ?? detectedType ?? null;
  if (!hasLookups) return legacy(type);

  const accounts = await store.activeAccounts();
  if (accounts.length === 0) return legacy(type); // no accounts yet: the built-in ones
  const matches = type ? accounts.filter((a) => a.type === type) : [];
  if (matches.length === 1) return { ok: true, accountId: matches[0].id, accountType: type };
  return { ok: true, accountId: null, accountType: type };
}

module.exports = { resolveAccount, ACCOUNT_GONE };
