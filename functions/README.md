# Firebase Cloud Functions

Backend logic for the Financial Planner app, including:
- Bank statement (CSV/PDF) parsing
- AI-powered transaction categorization
- Spending insights generation
## Categorizing imports

Every CSV and PDF import is categorized before it is saved (`lib/importCategorization.js`):

1. **Free rules** (card payments, known merchants) — `categorySource: "rule"`
2. **The user's merchant cache** (`users/{uid}/merchantCache`) — `categorySource: "cache"`, no AI call
3. **The AI**, 50 transactions per call (`lib/categorize.js`) — `categorySource: "ai"`
4. Anything left stays **Uncategorized** (`"none"`)

A failed AI chunk only affects its own 50 transactions, and the AI stops starting new chunks after
60 s so large files finish inside the function timeout.

The AI step is **off by default** (it costs money). To turn it on, put these in `functions/.env`
and redeploy: `AI_CATEGORIZATION=on` and `ANTHROPIC_API_KEY=...` (or use the secret setup in
`aiFunctions.js`). The cache is updated by `onTransactionCategoryChanged` whenever a user picks a category.

Tests: `npm test` in this folder (no API key needed, the AI is faked).
