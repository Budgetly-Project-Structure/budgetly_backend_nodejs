/**
 * aiFunctions.js: Claude-powered categorization (SCRUM-70/71/72), switched OFF.
 *
 * The Claude API is paid, so this callable is not deployed. index.js doesn't load
 * this file, which keeps every `firebase deploy` free and stops Firebase from
 * asking for the ANTHROPIC_API_KEY secret. Imports are categorized for free by
 * the merchant keyword rules instead (lib/merchantRules.js).
 *
 * To turn it on later:
 *   1. firebase functions:secrets:set ANTHROPIC_API_KEY   (paste a paid key)
 *   2. In index.js, add:   Object.assign(exports, require("./aiFunctions"));
 *   3. firebase deploy --only functions:categorizeTransactions
 *
 * categorizeTransactions({ importId? }) -> { checked, categorized, leftUncategorized, more }
 * Asks Claude (Haiku 5.5) for the category of up to 500 of the signed-in user's
 * uncategorized transactions (only one import's, if importId is given) and saves
 * the answers. Call again while `more` is true. Anything the AI can't place stays
 * Uncategorized (SCRUM-72).
 */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

const { createClaudeClassifier } = require("./lib/aiClient");
const { runCategorization } = require("./lib/categorizeJob");
const { requireUid } = require("./lib/callables");

// The Claude API key (SCRUM-70). Only functions that list it in `secrets` can read it.
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

exports.categorizeTransactions = onCall(
  { secrets: [anthropicApiKey], timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    // From the verified login token only, never request.data (SCRUM-112)
    const uid = requireUid(request);
    const importId = request.data?.importId ?? null;
    if (importId !== null && (typeof importId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(importId))) {
      throw new HttpsError("invalid-argument", "That statement ID isn't valid.");
    }
    try {
      return await runCategorization({
        db: getFirestore(),
        uid,
        importId,
        classify: createClaudeClassifier({ apiKey: anthropicApiKey.value() }),
        logger,
      });
    } catch (err) {
      logger.error("Categorization failed", { uid, importId, message: err.message });
      throw new HttpsError("internal", "We couldn't categorize your transactions. Please try again.");
    }
  }
);
