/**
 * Tests for AI categorization (SCRUM-70, SCRUM-71, SCRUM-72):
 * aiClient.js, categorize.js and categorizeJob.js.
 * The AI is always faked, so these run with no API key and cost nothing.
 *
 * Run from the functions/ folder:  npm test
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createClaudeClassifier, MODEL } = require("../lib/aiClient");
const { categorizeTransactions, readReply, BATCH_SIZE } = require("../lib/categorize");
const { runCategorization } = require("../lib/categorizeJob");

const silentLogger = { info() {}, warn() {}, error() {} };
const UNCATEGORIZED = { category: "uncategorized", categoryConfidence: null, categorySource: "none" };

const txn = (merchant, amount, date = "2026-09-02") => ({ merchant, amount, date });

/** A fake model: answers each transaction with `pick(transaction)` → [category, confidence]. */
const fakeClassify = (pick, calls = []) => async (request) => {
  calls.push(request);
  return {
    results: request.transactions.map((t) => {
      const [category, confidence] = pick(t);
      return { id: t.id, category, confidence };
    }),
  };
};

// ---------------------------------------------------------------------------
describe("aiClient (SCRUM-70)", () => {
  /** A stand-in for the Anthropic client that records the request. */
  const fakeClient = (response) => {
    const sent = [];
    return {
      sent,
      messages: {
        create: async (params) => {
          sent.push(params);
          return response;
        },
      },
    };
  };
  const ok = (json) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(json) }] });

  test("sends Claude Haiku 5.5 a JSON-schema request with the category ids as an enum", async () => {
    const client = fakeClient(ok({ results: [] }));
    const classify = createClaudeClassifier({ client });
    await classify({ categories: [], transactions: [{ id: "t1", merchant: "Starbucks", amount: -5, date: "2026-09-02" }] });

    const p = client.sent[0];
    assert.equal(p.model, "claude-haiku-5-5");
    assert.equal(MODEL, "claude-haiku-5-5");
    assert.equal(p.output_config.effort, "low");
    assert.equal(p.output_config.format.type, "json_schema");
    const categoryEnum = p.output_config.format.schema.properties.results.items.properties.category.enum;
    assert.ok(categoryEnum.includes("dining") && categoryEnum.includes("transfers"));
    assert.ok(!categoryEnum.includes("uncategorized"));
    // One user message holding the request JSON, no assistant prefill
    assert.equal(p.messages.length, 1);
    assert.equal(p.messages[0].role, "user");
    assert.equal(JSON.parse(p.messages[0].content).transactions[0].merchant, "Starbucks");
  });

  test("returns the parsed reply", async () => {
    const classify = createClaudeClassifier({ client: fakeClient(ok({ results: [{ id: "t1", category: "dining", confidence: 0.9 }] })) });
    assert.deepEqual(await classify({ transactions: [] }), { results: [{ id: "t1", category: "dining", confidence: 0.9 }] });
  });

  test("a refusal or a cut-off reply is an error (so the batch falls back)", async () => {
    for (const stop_reason of ["refusal", "max_tokens"]) {
      const classify = createClaudeClassifier({ client: fakeClient({ stop_reason, content: [] }) });
      await assert.rejects(classify({ transactions: [] }), /stopped early/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("readReply: checking the model's answers (SCRUM-72)", () => {
  const batch = [txn("STARBUCKS", -6.45), txn("ACME PAYROLL", 1850), txn("TARGET", -62.14)];

  test("valid answers become category fields with source 'ai'", () => {
    const fields = readReply(
      {
        results: [
          { id: "t1", category: "dining", confidence: 0.961 },
          { id: "t2", category: "income", confidence: 0.99 },
          { id: "t3", category: "shopping", confidence: 0.6 },
        ],
      },
      batch
    );
    assert.deepEqual(fields, [
      { category: "dining", categoryConfidence: 0.96, categorySource: "ai" },
      { category: "income", categoryConfidence: 0.99, categorySource: "ai" },
      { category: "shopping", categoryConfidence: 0.6, categorySource: "ai" },
    ]);
  });

  test("a reply without a results array -> the whole batch falls back", () => {
    assert.deepEqual(readReply(null, batch), [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
    assert.deepEqual(readReply({ answers: [] }, batch), [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
  });

  test("bad single answers fall back one at a time", () => {
    const fields = readReply(
      {
        results: [
          { id: "t1", category: "coffee", confidence: 0.9 }, // unknown category
          { id: "t2", category: "income", confidence: 1.4 }, // confidence out of range
          { id: "t3", category: "uncategorized", confidence: 0.9 }, // not an AI category
        ],
      },
      batch
    );
    assert.deepEqual(fields, [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
  });

  test("missing, unknown and duplicate ids", () => {
    const fields = readReply(
      {
        results: [
          { id: "t1", category: "dining", confidence: 0.9 },
          { id: "t1", category: "health", confidence: 0.9 }, // duplicate: first wins
          { id: "t9", category: "income", confidence: 0.9 }, // unknown id: ignored
        ],
      },
      batch
    );
    assert.equal(fields[0].category, "dining");
    assert.deepEqual(fields[1], UNCATEGORIZED); // no answer for t2
    assert.deepEqual(fields[2], UNCATEGORIZED); // no answer for t3
  });

  test("'income' on money going out is rejected; a refund in a spending category is fine", () => {
    const fields = readReply(
      {
        results: [
          { id: "t1", category: "income", confidence: 0.9 },
          { id: "t2", category: "shopping", confidence: 0.8 },
        ],
      },
      [txn("ODD MERCHANT", -20), txn("AMAZON.COM REFUND", 31.51)]
    );
    assert.deepEqual(fields[0], UNCATEGORIZED);
    assert.equal(fields[1].category, "shopping");
  });
});

// ---------------------------------------------------------------------------
describe("categorizeTransactions (SCRUM-71)", () => {
  test("sends batches of 50 with short ids and no Firestore ids", async () => {
    const calls = [];
    const list = Array.from({ length: 120 }, (_, i) => ({ ...txn(`MERCHANT ${i}`, -10), id: `secret_${i}` }));
    const result = await categorizeTransactions(list, { classify: fakeClassify(() => ["shopping", 0.8], calls), logger: silentLogger });

    assert.equal(BATCH_SIZE, 50);
    assert.deepEqual(calls.map((c) => c.transactions.length).sort((a, b) => b - a), [50, 50, 20]);
    assert.equal(calls[0].transactions[0].id, "t1");
    assert.ok(!JSON.stringify(calls).includes("secret_"));
    assert.deepEqual(Object.keys(calls[0].transactions[0]), ["id", "merchant", "amount", "date"]);
    assert.equal(result.categorized, 120);
    assert.equal(result.fields.length, 120);
  });

  test("results line up with the input even when batches finish out of order", async () => {
    const list = Array.from({ length: 110 }, (_, i) => txn(i < 50 ? "SLOW" : "FAST", -10));
    const classify = async (request) => {
      if (request.transactions[0].merchant === "SLOW") await new Promise((r) => setTimeout(r, 20));
      return { results: request.transactions.map((t) => ({ id: t.id, category: t.merchant === "SLOW" ? "dining" : "health", confidence: 0.9 })) };
    };
    const { fields } = await categorizeTransactions(list, { classify, logger: silentLogger });
    assert.ok(fields.slice(0, 50).every((f) => f.category === "dining"));
    assert.ok(fields.slice(50).every((f) => f.category === "health"));
  });

  test("a failed batch (timeout, outage, bad JSON) stays Uncategorized; the others still work", async () => {
    let call = 0;
    const classify = async (request) => {
      call++;
      if (call === 2) throw new Error("Request timed out");
      return { results: request.transactions.map((t) => ({ id: t.id, category: "groceries", confidence: 0.9 })) };
    };
    const list = Array.from({ length: 100 }, () => txn("ALDI", -50));
    const result = await categorizeTransactions(list, { classify, logger: silentLogger, concurrency: 1 });

    assert.equal(result.failedBatches, 1);
    assert.equal(result.categorized, 50);
    assert.equal(result.fellBack, 50);
    assert.deepEqual(result.fields[50], UNCATEGORIZED);
  });

  test("never rejects, even if every call fails", async () => {
    const result = await categorizeTransactions([txn("A", -1), txn("B", -2)], {
      classify: async () => {
        throw new Error("down");
      },
      logger: silentLogger,
    });
    assert.deepEqual(result.fields, [UNCATEGORIZED, UNCATEGORIZED]);
  });

  test("nothing to do -> no model calls", async () => {
    const calls = [];
    const result = await categorizeTransactions([], { classify: fakeClassify(() => ["dining", 1], calls), logger: silentLogger });
    assert.equal(calls.length, 0);
    assert.equal(result.fields.length, 0);
  });
});

// ---------------------------------------------------------------------------
/** Tiny Firestore fake with what categorizeJob uses: chained where()s, limit(), get(), bulkWriter(). */
function fakeFirestore(docs, { changedSinceRead = [] } = {}) {
  const data = new Map(Object.entries(docs)); // path -> doc data
  const writes = [];
  const query = (prefix, filters, max) => ({
    where: (field, op, value) => query(prefix, [...filters, [field, value]], max),
    limit: (n) => query(prefix, filters, n),
    get: async () => {
      const found = [...data.entries()]
        .filter(([path, x]) => path.startsWith(prefix) && filters.every(([f, v]) => x[f] === v))
        .slice(0, max)
        .map(([path, x]) => ({ ref: { path }, data: () => x, updateTime: `read-${path}` }));
      return { empty: found.length === 0, docs: found };
    },
  });
  const db = {
    // transactions is one top-level collection; each doc has a userId field
    collection: (c) => query(`${c}/`, [], Infinity),
    bulkWriter: () => {
      let onError = () => false;
      const pending = [];
      return {
        onWriteError: (fn) => (onError = fn),
        update: (ref, patch, precondition) => {
          const p = Promise.resolve().then(() => {
            if (changedSinceRead.includes(ref.path)) {
              onError(new Error("FAILED_PRECONDITION"));
              throw new Error("FAILED_PRECONDITION");
            }
            writes.push({ path: ref.path, patch, precondition });
            data.set(ref.path, { ...data.get(ref.path), ...patch });
          });
          pending.push(p.catch(() => {}));
          return p;
        },
        close: async () => {
          await Promise.all(pending);
        },
      };
    },
  };
  return { db, data, writes };
}

describe("runCategorization (SCRUM-71)", () => {
  const base = { merchant: "STARBUCKS", amount: -6.45, date: { toDate: () => new Date("2026-09-02T12:00:00Z") } };
  const setup = (overrides = {}) =>
    fakeFirestore(
      {
        "transactions/alice_a": { ...base, userId: "alice", categorySource: "none", category: "uncategorized", sourceStatementId: "imp1" },
        "transactions/alice_b": { ...base, userId: "alice", merchant: "PAYMENT THANK YOU", amount: 500, categorySource: "rule", category: "transfers", sourceStatementId: "imp1" },
        "transactions/alice_c": { ...base, userId: "alice", merchant: "ALDI", categorySource: "user", category: "groceries", sourceStatementId: "imp1" },
        "transactions/alice_d": { ...base, userId: "alice", merchant: "TARGET", categorySource: "none", category: "uncategorized", sourceStatementId: "imp2" },
        "transactions/bob_e": { ...base, userId: "bob", categorySource: "none", category: "uncategorized", sourceStatementId: "imp1" },
      },
      overrides
    );
  const run = (db, extra = {}) =>
    runCategorization({
      db,
      uid: "alice",
      classify: fakeClassify((t) => (t.merchant === "STARBUCKS" ? ["dining", 0.97] : ["shopping", 0.85])),
      logger: silentLogger,
      serverTimestamp: () => "now",
      ...extra,
    });

  test("only the user's uncategorized transactions are sent and saved; rule and user categories are untouched", async () => {
    const { db, data, writes } = setup();
    const result = await run(db);

    assert.deepEqual(result, { checked: 2, categorized: 2, leftUncategorized: 0, more: false });
    assert.deepEqual(writes.map((w) => w.path).sort(), ["transactions/alice_a", "transactions/alice_d"]);
    assert.deepEqual(writes.find((w) => w.path.endsWith("_a")).patch, {
      category: "dining",
      categoryConfidence: 0.97,
      categorySource: "ai",
      updatedAt: "now",
    });
    assert.equal(data.get("transactions/alice_b").category, "transfers");
    assert.equal(data.get("transactions/alice_c").category, "groceries");
    assert.equal(data.get("transactions/bob_e").category, "uncategorized");
  });

  test("each save only goes through if the transaction hasn't changed since it was read", async () => {
    const { db, writes } = setup({ changedSinceRead: ["transactions/alice_a"] });
    const result = await run(db);
    assert.equal(result.categorized, 1);
    assert.equal(result.leftUncategorized, 1);
    assert.ok(writes.every((w) => w.precondition.lastUpdateTime === `read-${w.path}`));
  });

  test("importId limits it to one statement", async () => {
    const { db, writes } = setup();
    await run(db, { importId: "imp2" });
    assert.deepEqual(writes.map((w) => w.path), ["transactions/alice_d"]);
  });

  test("answers that fall back are not written, and an outage doesn't ask for another round", async () => {
    const { db, writes } = setup();
    const result = await run(db, {
      limit: 2,
      classify: async () => {
        throw new Error("overloaded");
      },
    });
    assert.equal(writes.length, 0);
    assert.deepEqual(result, { checked: 2, categorized: 0, leftUncategorized: 2, more: false });
  });

  test("a full page that made progress reports more to do", async () => {
    const { db } = setup();
    assert.equal((await run(db, { limit: 1 })).more, true);
  });
});
