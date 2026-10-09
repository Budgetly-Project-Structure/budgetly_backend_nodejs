/**
 * aiClient.js (SCRUM-70)
 *
 * The one place that talks to the AI model. It sends a categorization request
 * (budgetly_contracts/ai/categorization-interface.md) to Claude Haiku 5.5 and
 * returns the parsed reply. Checking the reply and falling back to
 * Uncategorized is categorize.js's job (SCRUM-72), so a fake classifier can be
 * swapped in for tests.
 *
 * The API key is a Firebase secret (ANTHROPIC_API_KEY), set once with
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 * and handed to createClaudeClassifier() by index.js. It is never in code or logs.
 */
"use strict";

const { AI_CATEGORIES } = require("./categories");

const MODEL = "claude-haiku-5-5";
// The contract allows 20 s per batch. No SDK retries: a slow or failed batch
// just falls back to Uncategorized instead of blowing the time budget.
const TIMEOUT_MS = 20 * 1000;
// 50 results x ~30 tokens each, plus room for the model's (low effort) thinking
const MAX_TOKENS = 8000;

const SYSTEM_PROMPT = `You categorize bank and credit card transactions for a personal budgeting app.

You get JSON with a list of categories and a list of transactions. For every transaction, pick the one category that fits best and say how sure you are, from 0 to 1.

How to read a transaction:
- "merchant" is the raw text from the bank statement. It is often abbreviated or has store numbers, card processor prefixes (SQ *, TST*, PAYPAL *) or locations in it.
- "amount" is negative for money going out and positive for money coming in. A positive amount from a store is usually a refund: put it in the store's normal category.
- Paychecks, direct deposits and interest are "income". Moving money between the person's own accounts (credit card payments, transfers to savings, Zelle or Venmo to themselves) is "transfers".

Confidence:
- 0.9 or more when the merchant clearly identifies what it is (a well-known chain, an obvious utility).
- 0.5 to 0.8 when it's a reasonable guess.
- Below 0.5 when you can't tell (for example a person's name or a bare payment processor code). The app asks the user to check anything under 0.7, so be honest rather than confident.

Return exactly one result per transaction, using the transaction's "id" and a category "id" from the list.`;

/** JSON schema for the reply. Category ids are an enum, so the model can't invent one. */
function responseSchema(categoryIds) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: categoryIds },
            confidence: { type: "number" },
          },
          required: ["id", "category", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

/**
 * Builds the classify() function categorize.js calls.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey   From the ANTHROPIC_API_KEY secret
 * @param {Object} [opts.client] An Anthropic client to use instead (tests)
 * @returns {(request: {categories: Object[], transactions: Object[]}) => Promise<Object>}
 *          resolves to the parsed reply ({ results: [...] }); rejects on any API
 *          error, timeout, refusal, or a reply that isn't JSON
 */
function createClaudeClassifier({ apiKey, client } = {}) {
  if (!client) {
    // Loaded here so the rest of the backend (and its tests) never needs the SDK
    const { Anthropic } = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  const schema = responseSchema(AI_CATEGORIES.map((c) => c.id));

  return async function classify(request) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Picking from a short list is easy work: keep thinking short and cheap
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(request) }],
    });

    // A refusal or a cut-off reply may not match the schema
    if (response.stop_reason !== "end_turn") {
      throw new Error(`AI reply stopped early (${response.stop_reason})`);
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(text);
  };
}

module.exports = { createClaudeClassifier, responseSchema, MODEL, TIMEOUT_MS, SYSTEM_PROMPT };
