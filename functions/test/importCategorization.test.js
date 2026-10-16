/**
 * Tests for categorizing imports (SCRUM-73 to SCRUM-76):
 * merchantCache.js, importCategorization.js, the time budget in categorize.js
 * and the categorizer hook in importPipeline.js.
 *
 * The AI is always a fake classifier and Firestore is a tiny in-memory fake, so
 * these run in CI with no API key, no network and no cost.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { merchantKey, cacheDocId, applyCache, cacheUpdateFor, createMerchantCache } = require("../lib/merchantCache");
const { createImportCategorizer } = require("../lib/importCategorization");
const { categorizeTransactions, BATCH_SIZE } = require("../lib/categorize");
const { processImport } = require("../lib/importPipeline");
const { toTransactionDocs } = require("../lib/transactions");

const silentLogger = { info() {}, warn() {}, error() {} };

/** Import documents as toTransactionDocs builds them. Names with no rule match stay uncategorized. */
const docsFor = (rows) =>
  toTransactionDocs(
    rows.map(([merchant, amount], i) => ({ date: "2026-09-02", merchant, amount, rowNumber: i + 2 })),
    { uid: "alice", importId: "imp1" }
  );

/** A fake model: answers every transaction with `pick(transaction)` -> [category, confidence]. Records each request. */
const fakeClassify = (pick, calls = []) => async (request) => {
  calls.push(request);
  return { results: request.transactions.map((t) => ({ id: t.id, ...(([category, confidence]) => ({ category, confidence }))(pick(t)) })) };
};

/** A fake merchant cache (what createMerchantCache() returns), holding { "KWIK TRIP": "transportation" }. */
const fakeCache = (entries, lookups = []) => ({
  lookup: async (merchants) => {
    lookups.push(merchants);
    return new Map(
      Object.entries(entries).map(([key, category]) => [key, { category, categoryConfidence: 1 }])
    );
  },
});

// ---------------------------------------------------------------------------
describe("merchantKey (SCRUM-75)", () => {
  test("drops store numbers, processor prefixes and punctuation", () => {
    assert.equal(merchantKey("KWIK TRIP #412"), "KWIK TRIP");
    assert.equal(merchantKey("Target T-1123"), "TARGET");
    assert.equal(merchantKey("SQ *BLUE BOTTLE COFFEE 0042"), "BLUE BOTTLE COFFEE");
    assert.equal(merchantKey("TST* Taco Johns"), "TACO JOHNS");
    assert.equal(merchantKey("McDonald's #8821"), "MCDONALDS");
  });

  test("the same merchant on different days and stores gets the same key", () => {
    assert.equal(merchantKey("KWIK TRIP #412"), merchantKey("kwik trip #977"));
  });

  test("keeps only the first three words", () => {
    assert.equal(merchantKey("THE VERY LONG MERCHANT NAME HERE SEATTLE WA"), "THE VERY LONG");
  });

  test("returns an empty key when nothing usable is left, so it is never cached", () => {
    assert.equal(merchantKey("12345"), "");
    assert.equal(merchantKey(""), "");
    assert.equal(merchantKey(null), "");
  });

  test("document ids are safe for Firestore", () => {
    assert.equal(cacheDocId("KWIK TRIP"), "kwik-trip");
    assert.match(cacheDocId(merchantKey("A/B CORNER STORE")), /^[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------
describe("applyCache (SCRUM-75)", () => {
  const cached = new Map([
    ["PIZZA RANCH", { category: "dining", categoryConfidence: 1 }],
    ["ACME", { category: "income", categoryConfidence: 1 }],
  ]);

  test("a cache hit sets the category with categorySource 'cache'", () => {
    const { docs, hits } = applyCache(docsFor([["Pizza Ranch 0042", -20]]).map((d) => ({ ...d, categorySource: "none" })), cached);
    assert.equal(hits, 1);
    assert.equal(docs[0].category, "dining");
    assert.equal(docs[0].categorySource, "cache");
    assert.equal(docs[0].categoryConfidence, 1);
  });

  test("never overwrites a rule category or a user's choice", () => {
    const base = docsFor([["Pizza Ranch", -20]])[0];
    for (const categorySource of ["rule", "user", "ai"]) {
      const d = { ...base, category: "shopping", categorySource };
      assert.equal(applyCache([d], cached).docs[0].category, "shopping");
    }
  });

  test("money going out never gets the 'income' category", () => {
    const d = { ...docsFor([["Acme", -5]])[0], category: "uncategorized", categorySource: "none" };
    assert.equal(applyCache([d], cached).docs[0].category, "uncategorized");
    const inn = { ...d, amount: 5 };
    assert.equal(applyCache([inn], cached).docs[0].category, "income");
  });

  test("does not change the documents it was given", () => {
    const d = { ...docsFor([["Pizza Ranch", -20]])[0], category: "uncategorized", categorySource: "none" };
    applyCache([d], cached);
    assert.equal(d.categorySource, "none");
  });
});

// ---------------------------------------------------------------------------
describe("cacheUpdateFor: when a transaction edit updates the cache (SCRUM-75)", () => {
  const user = { merchant: "KWIK TRIP #412", category: "transportation", categorySource: "user" };

  test("a user choosing a category on an imported transaction updates it", () => {
    const before = { ...user, category: "uncategorized", categorySource: "none" };
    assert.deepEqual(cacheUpdateFor(before, user), { merchant: "KWIK TRIP #412", category: "transportation" });
  });

  test("a user changing their earlier choice updates it", () => {
    assert.ok(cacheUpdateFor({ ...user, category: "dining" }, user));
  });

  test("a manual transaction created with a category updates it", () => {
    assert.ok(cacheUpdateFor(null, user));
  });

  test("no update when the category didn't change, or it wasn't the user's choice", () => {
    assert.equal(cacheUpdateFor(user, user), null);
    assert.equal(cacheUpdateFor(null, { ...user, categorySource: "ai" }), null);
    assert.equal(cacheUpdateFor(user, null), null); // deleted
  });

  test("uncategorized and merchants with no usable name are not cached", () => {
    assert.equal(cacheUpdateFor(null, { ...user, category: "uncategorized" }), null);
    assert.equal(cacheUpdateFor(null, { ...user, merchant: "4455" }), null);
  });
});

// ---------------------------------------------------------------------------
/** In-memory Firestore: collection().doc().set(), db.getAll(). */
function fakeDb() {
  const data = new Map();
  const doc = (path) => ({
    path,
    set: async (d) => data.set(path, d),
  });
  const collection = (p) => ({ doc: (id) => doc(`${p}/${id}`) });
  return {
    data,
    collection: (name) => ({ doc: (uid) => ({ collection: (sub) => collection(`${name}/${uid}/${sub}`) }) }),
    getAll: async (...refs) => refs.map((r) => ({ exists: data.has(r.path), data: () => data.get(r.path) })),
  };
}

describe("createMerchantCache: Firestore side (SCRUM-75)", () => {
  const stamp = () => "TS";

  test("save() then lookup() round-trips under users/{uid}/merchantCache", async () => {
    const db = fakeDb();
    const cache = createMerchantCache({ db, uid: "alice", serverTimestamp: stamp });
    assert.equal(await cache.save("KWIK TRIP #412", "transportation"), true);
    assert.deepEqual(db.data.get("users/alice/merchantCache/kwik-trip"), {
      merchantKey: "KWIK TRIP",
      category: "transportation",
      categoryConfidence: 1,
      updatedAt: "TS",
    });
    const found = await cache.lookup(["Kwik Trip #977", "Unknown Place"]);
    assert.equal(found.get("KWIK TRIP").category, "transportation");
    assert.equal(found.size, 1);
  });

  test("it is per user: another user's cache is not visible", async () => {
    const db = fakeDb();
    await createMerchantCache({ db, uid: "alice", serverTimestamp: stamp }).save("Kwik Trip", "transportation");
    const found = await createMerchantCache({ db, uid: "bob", serverTimestamp: stamp }).lookup(["Kwik Trip"]);
    assert.equal(found.size, 0);
  });

  test("save() ignores uncategorized, unknown categories and empty merchants", async () => {
    const db = fakeDb();
    const cache = createMerchantCache({ db, uid: "alice", serverTimestamp: stamp });
    assert.equal(await cache.save("Kwik Trip", "uncategorized"), false);
    assert.equal(await cache.save("Kwik Trip", "not-a-category"), false);
    assert.equal(await cache.save("12345", "dining"), false);
    assert.equal(db.data.size, 0);
  });

  test("lookup() reads in chunks of 100", async () => {
    const db = fakeDb();
    const sizes = [];
    const realGetAll = db.getAll;
    db.getAll = async (...refs) => (sizes.push(refs.length), realGetAll(...refs));
    const merchants = Array.from({ length: 250 }, (_, i) => `Shop${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} Store`);
    await createMerchantCache({ db, uid: "alice", serverTimestamp: stamp }).lookup(merchants);
    assert.ok(sizes.every((n) => n <= 100));
    assert.equal(sizes.reduce((a, b) => a + b, 0), new Set(merchants.map(merchantKey)).size);
  });
});

// ---------------------------------------------------------------------------
describe("createImportCategorizer (SCRUM-73)", () => {
  // Starbucks and Netflix match the free rules; the other three need the cache or the AI
  const rows = [
    ["Starbucks", -6.45],
    ["NETFLIX", -15.49],
    ["MAPLE ST HAIR STUDIO #412", -45.03],
    ["BARNES AND NOBLE", -22.16],
    ["ZXQ HARDWARE", -9.99],
  ];

  test("rule matches are left alone and the AI is never asked about them", async () => {
    const calls = [];
    const categorize = createImportCategorizer({ classify: fakeClassify(() => ["shopping", 0.8], calls), logger: silentLogger });
    const { docs, summary } = await categorize(docsFor(rows));
    assert.equal(docs[0].categorySource, "rule");
    assert.equal(docs[1].categorySource, "rule");
    const asked = calls.flatMap((c) => c.transactions.map((t) => t.merchant));
    assert.deepEqual(asked.sort(), ["BARNES AND NOBLE", "MAPLE ST HAIR STUDIO #412", "ZXQ HARDWARE"].sort());
    assert.equal(summary.rule, 2);
    assert.equal(summary.ai, 3);
    assert.equal(summary.uncategorized, 0);
  });

  test("AI answers are saved with categorySource 'ai' and their confidence", async () => {
    const categorize = createImportCategorizer({ classify: fakeClassify(() => ["shopping", 0.83]), logger: silentLogger });
    const { docs } = await categorize(docsFor(rows));
    assert.equal(docs[4].category, "shopping");
    assert.equal(docs[4].categorySource, "ai");
    assert.equal(docs[4].categoryConfidence, 0.83);
  });

  test("every saved transaction has a category, even with no AI and no cache", async () => {
    const { docs } = await createImportCategorizer({ logger: silentLogger })(docsFor(rows));
    for (const d of docs) assert.equal(typeof d.category, "string");
    assert.equal(docs[4].category, "uncategorized");
    assert.equal(docs[4].categorySource, "none");
  });

  test("with the AI off (no classify) it makes no AI call and still applies rules and cache", async () => {
    const categorize = createImportCategorizer({ cache: fakeCache({ "MAPLE ST HAIR": "transportation" }), logger: silentLogger });
    const { docs, summary } = await categorize(docsFor(rows));
    assert.equal(docs[2].categorySource, "cache");
    assert.equal(summary.ai, 0);
    assert.equal(summary.uncategorized, 2);
  });

  test("the input documents are not changed", async () => {
    const input = docsFor(rows);
    await createImportCategorizer({ classify: fakeClassify(() => ["shopping", 0.8]), logger: silentLogger })(input);
    assert.equal(input[4].categorySource, "none");
  });
});

// ---------------------------------------------------------------------------
describe("merchant cache in the import (SCRUM-75)", () => {
  const rows = [
    ["MAPLE ST HAIR STUDIO #412", -45.03],
    ["MAPLE ST HAIR STUDIO #977", -30.1],
    ["ZXQ HARDWARE", -9.99],
  ];

  test("cached merchants get categorySource 'cache' and are NOT sent to the AI", async () => {
    const calls = [];
    const categorize = createImportCategorizer({
      cache: fakeCache({ "MAPLE ST HAIR": "transportation" }),
      classify: fakeClassify(() => ["shopping", 0.8], calls),
      logger: silentLogger,
    });
    const { docs, summary } = await categorize(docsFor(rows));
    assert.deepEqual([docs[0].categorySource, docs[1].categorySource], ["cache", "cache"]);
    assert.equal(docs[0].category, "transportation");
    // The AI only saw the one merchant the cache didn't know
    assert.deepEqual(calls.flatMap((c) => c.transactions.map((t) => t.merchant)), ["ZXQ HARDWARE"]);
    assert.equal(summary.cache, 2);
    assert.equal(summary.ai, 1);
  });

  test("when everything is cached the AI is not called at all", async () => {
    const calls = [];
    const categorize = createImportCategorizer({
      cache: fakeCache({ "MAPLE ST HAIR": "transportation", "ZXQ HARDWARE": "shopping" }),
      classify: fakeClassify(() => ["dining", 0.9], calls),
      logger: silentLogger,
    });
    const { summary } = await categorize(docsFor(rows));
    assert.equal(calls.length, 0);
    assert.equal(summary.cache, 3);
  });

  test("only unknown transactions are looked up, and the cache is skipped when there are none", async () => {
    const lookups = [];
    const categorize = createImportCategorizer({ cache: fakeCache({}, lookups), logger: silentLogger });
    await categorize(docsFor([["Starbucks", -5], ["ZXQ HARDWARE", -9.99]]));
    assert.deepEqual(lookups, [["ZXQ HARDWARE"]]);
    await categorize(docsFor([["Starbucks", -5]]));
    assert.equal(lookups.length, 1);
  });

  test("a failing cache lookup doesn't stop the AI or the import", async () => {
    const categorize = createImportCategorizer({
      cache: { lookup: async () => { throw new Error("firestore down"); } },
      classify: fakeClassify(() => ["shopping", 0.8]),
      logger: silentLogger,
    });
    const { docs } = await categorize(docsFor(rows));
    assert.equal(docs[0].categorySource, "ai");
  });
});

// ---------------------------------------------------------------------------
describe("chunking large imports (SCRUM-74)", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ merchant: `Shop ${String.fromCharCode(65 + (i % 26))}`, amount: -(i + 1), date: "2026-09-02" }));

  test("sends the model chunks of at most 50 transactions", async () => {
    const calls = [];
    const result = await categorizeTransactions(many(120), { classify: fakeClassify(() => ["shopping", 0.9], calls), logger: silentLogger });
    assert.equal(BATCH_SIZE, 50);
    assert.deepEqual(calls.map((c) => c.transactions.length).sort((a, b) => b - a), [50, 50, 20]);
    assert.equal(result.categorized, 120);
  });

  test("a failed chunk falls back to Uncategorized while the other chunks keep their AI categories", async () => {
    let call = 0;
    const classify = async (request) => {
      call++;
      if (call === 2) throw new Error("rate limited");
      return { results: request.transactions.map((t) => ({ id: t.id, category: "shopping", confidence: 0.9 })) };
    };
    // concurrency 1 makes "the second chunk" deterministic
    const result = await categorizeTransactions(many(150), { classify, logger: silentLogger, concurrency: 1 });
    assert.equal(result.failedBatches, 1);
    assert.equal(result.categorized, 100);
    assert.equal(result.fields.slice(0, 50).every((f) => f.categorySource === "ai"), true);
    assert.equal(result.fields.slice(50, 100).every((f) => f.category === "uncategorized" && f.categorySource === "none"), true);
    assert.equal(result.fields.slice(100).every((f) => f.categorySource === "ai"), true);
  });

  test("when the time budget runs out, chunks that haven't started are skipped (stay uncategorized)", async () => {
    let clock = 0;
    const calls = [];
    // Every model call "takes" 30 s on the fake clock
    const classify = async (request) => {
      calls.push(request);
      clock += 30_000;
      return { results: request.transactions.map((t) => ({ id: t.id, category: "shopping", confidence: 0.9 })) };
    };
    const result = await categorizeTransactions(many(250), {
      classify,
      logger: silentLogger,
      concurrency: 1,
      timeBudgetMs: 60_000,
      now: () => clock,
    });
    assert.equal(calls.length, 2); // 2 chunks fit in the budget, 3 were skipped
    assert.equal(result.skippedBatches, 3);
    assert.equal(result.categorized, 100);
    assert.equal(result.fields.slice(100).every((f) => f.categorySource === "none"), true);
  });

  test("in an import, if the AI budget is already spent, every row is still saved (uncategorized)", async () => {
    const calls = [];
    const rows = Array.from({ length: 120 }, (_, i) => [`ZXQ ITEM ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, -(i + 1)]);
    const { docs, summary } = await createImportCategorizer({
      classify: fakeClassify(() => ["shopping", 0.9], calls),
      logger: silentLogger,
      aiBudgetMs: 0,
    })(docsFor(rows));
    assert.equal(calls.length, 0);
    assert.equal(summary.aiSkippedChunks, 3);
    assert.equal(docs.length, 120);
    assert.equal(summary.uncategorized, 120);
  });
});

// ---------------------------------------------------------------------------
describe("categorizing inside processImport (SCRUM-73)", () => {
  /** A fake store that remembers what was written. */
  const fakeStore = () => {
    const state = { written: [], updates: [] };
    return {
      state,
      update: async (p) => state.updates.push(p),
      writeTransactions: async (docs) => state.written.push(...docs),
      deleteTransactions: async () => {},
    };
  };
  const csv = Buffer.from("Date,Description,Amount\n2026-09-02,Starbucks,-6.45\n2026-09-03,MAPLE ST HAIR STUDIO #412,-45.03\n2026-09-04,ZXQ HARDWARE,-9.99\n");

  test("a CSV import saves rule, cache and AI categories", async () => {
    const store = fakeStore();
    const calls = [];
    const categorizer = createImportCategorizer({
      cache: fakeCache({ "MAPLE ST HAIR": "transportation" }),
      classify: fakeClassify(() => ["shopping", 0.8], calls),
      logger: silentLogger,
    });
    const result = await processImport({ fileBuffer: csv, fileType: "csv", uid: "alice", importId: "imp1", store, logger: silentLogger, categorizer });
    assert.equal(result.status, "completed");
    const bySource = Object.fromEntries(store.state.written.map((d) => [d.merchant, d.categorySource]));
    assert.deepEqual(bySource, { Starbucks: "rule", "MAPLE ST HAIR STUDIO #412": "cache", "ZXQ HARDWARE": "ai" });
    assert.equal(calls.length, 1);
  });

  test("the import still completes, with uncategorized rows, if the AI fails", async () => {
    const store = fakeStore();
    const categorizer = createImportCategorizer({ classify: async () => { throw new Error("outage"); }, logger: silentLogger });
    const result = await processImport({ fileBuffer: csv, fileType: "csv", uid: "alice", importId: "imp1", store, logger: silentLogger, categorizer });
    assert.equal(result.status, "completed");
    assert.equal(result.transactionCount, 3);
    assert.equal(store.state.written.find((d) => d.merchant === "ZXQ HARDWARE").category, "uncategorized");
  });

  test("a categorizer that throws can't fail the import (it is only a bonus step)", async () => {
    const store = fakeStore();
    const categorizer = async () => {
      throw new Error("bug");
    };
    const result = await processImport({ fileBuffer: csv, fileType: "csv", uid: "alice", importId: "imp1", store, logger: silentLogger, categorizer });
    assert.equal(result.status, "completed");
    assert.equal(store.state.written.length, 3);
  });

  test("without a categorizer, imports behave as before (rules only)", async () => {
    const store = fakeStore();
    const result = await processImport({ fileBuffer: csv, fileType: "csv", uid: "alice", importId: "imp1", store, logger: silentLogger });
    assert.equal(result.status, "completed");
    assert.equal(store.state.written.find((d) => d.merchant === "ZXQ HARDWARE").categorySource, "none");
  });
});
