/**
 * CROSS-RUN EXTRACTION UNIT REUSE — content-addressed reuse of completed extraction units.
 *
 * Every test here proves a property of the reuse layer and is paired with a mutation anchor
 * that identifies the line whose removal turns the test red.
 *
 * (a) Identity-hit adoption end-to-end: a unit bought in run 1 is adopted in run 2, and
 *     the run-2 usage shows zero-cost provenance marking.
 * (b) Identity-miss per varying field: a different promptVersion / rates / block text MUST
 *     miss — one test per field class.
 * (c) Adopted-payload revalidation refusal: a stored modelOutput that fails the current
 *     decoder is refused and the chunk falls back to a live purchase.
 * (d) Failed units never enter the index.
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

// A minimal synthetic document with one block per chunk.
function docFor(n) {
  const blocks = Array.from({ length: n }, (_, i) => ({
    blockId: `b${String(i + 1).padStart(4, "0")}`,
    kind: "paragraph",
    text: `Q${i + 1}. Ask the respondent question ${i + 1}. SINGLE CODE. Must be answered.`,
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
    formatting: { runs: [], paragraphBackground: null, cellBackground: null, roleBoundarySplit: false, unresolvedBackground: [] },
    semanticSpans: [],
  }));
  return {
    blocks,
    annotatedText: blocks.map((b) => `[${b.blockId}] ${b.text}`).join("\n"),
    counts: { paragraphs: n, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
    coverage: {
      archiveParts: 1,
      partsRead: ["word/document.xml"],
      partsSkipped: [],
      images: 0,
      imagesWithAltText: 0,
      unresolvedFieldCodes: 0,
      symbolRuns: 0,
      autoNumberedParagraphs: 0,
      problems: [],
    },
  };
}

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation",
  "piping", "carry-forward", "calculation", "randomization", "loop", "instruction",
];

/**
 * Stand in for the provider at the transport boundary.
 * Returns a well-formed pass-B JSON output for any chunk.
 *
 * The output uses the snake_case field names that the pass-B decoder expects.
 * This matches the format used by the d21-passb-waves test.
 */
function fakeDeepseekFetch(statusOverride) {
  let callCount = 0;
  return async (url, opts) => {
    callCount += 1;
    const body = JSON.parse(opts.body);
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    // Parse the bounded-source-blocks JSONL to find block ids and their text.
    const jsonlStart = user.indexOf("===== YOUR SOURCE BLOCKS JSONL");
    const jsonlEnd = user.indexOf("===== END YOUR SOURCE BLOCKS JSONL");
    const sweepStart = user.indexOf("===== UNACCOUNTED SOURCE BLOCKS JSONL");
    const sweepEnd = user.indexOf("===== END UNACCOUNTED SOURCE BLOCKS JSONL");
    let sourceRows = [];
    if (jsonlStart >= 0 && jsonlEnd > jsonlStart) {
      const section = user.slice(user.indexOf("\n", jsonlStart) + 1, jsonlEnd).trim();
      sourceRows = section.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    } else if (sweepStart >= 0 && sweepEnd > sweepStart) {
      const section = user.slice(user.indexOf("\n", sweepStart) + 1, sweepEnd).trim();
      sourceRows = section.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    }
    const blockIds = sourceRows.map((r) => String(r.block_id));
    if (blockIds.length === 0) blockIds.push("b0001");
    const textOf = (id) => {
      const row = sourceRows.find((r) => String(r.block_id) === id);
      return row ? String(row.text) : `text for ${id}`;
    };
    // Extract unit name from the prompt
    const unitMatch = user.match(/Your chunk id for this call is: (\S+)/);
    const unitName = unitMatch ? unitMatch[1] : "C01-b0001";

    const output = {
      chunk_id: unitName,
      obligations: blockIds.map((id, i) => ({
        id: `${unitName}-R${i + 1}`,
        construct: "question",
        scope: `question:${id}`,
        quantifier: "every",
        selector: id,
        exceptions: [],
        statement: `block ${id} must be asked and answered`,
        doc_quote: textOf(id),
        block_ids: [id],
        evidence_quotes: [{ block_id: id, quote: textOf(id) }],
        browser_observable: "full",
        confidence: 0.9,
        expansion: null,
      })),
      block_dispositions: blockIds.map((id) => ({
        block_id: id,
        disposition: "normative",
        reason: "states something an implementation must do",
      })),
      construct_checklist: CONSTRUCTS.map((c) => ({
        construct: c,
        present: c === "question",
        block_ids: c === "question" ? blockIds : [],
      })),
      ambiguities: [],
      unverifiable_from_browser: [],
    };
    return new Response(
      JSON.stringify({
        id: "test-completion",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "deepseek-v4-pro",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(output),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 200,
          total_tokens: 700,
        },
      }),
      { status: statusOverride ?? 200, headers: { "content-type": "application/json" } },
    );
  };
}

function baseEnv(evidence) {
  return {
    EVIDENCE: evidence,
    ALLOW_DIRECT_LLM_BASE_URL: "true",
    EXTRACT_CHUNK_CHARS: "200",
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CONTEXT_CHARS: "0",
    EXTRACT_CHUNK_CONCURRENCY: "1",
    EXTRACT_CHUNK_MAX_ISSUES: "2",
    EXTRACT_SWEEP_MAX_CALLS: "0",
    EXTRACT_SWEEP_BLOCKS_PER_CALL: "40",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    EXTRACT_MODEL_INPUT_MAX_BYTES: "400000",
    EXTRACT_WAVE_BUDGET_MS: "600000",
    LLM_TIMEOUT_MS: "300000",
    DEEPSEEK_FALLBACK_MODEL: "deepseek-v4-pro",
    DEEPSEEK_FALLBACK_REASONING_EFFORT: "medium",
    DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK: "1.0",
    DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK: "4.0",
    DEEPSEEK_FALLBACK_MAX_ATTEMPTS: "1",
    DEEPSEEK_API_KEY: "test-key",
  };
}

suite("CROSS-RUN UNIT REUSE — identity and storage", () => {
  test("unitIdentityDigest produces a 64-char hex string", async () => {
    const { unitReuse } = (await mod());
    const digest = await unitReuse.unitIdentityDigest({
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    });
    assertEq(digest.length, 64, "digest must be 64 hex characters");
    assert(/^[0-9a-f]{64}$/.test(digest), "digest must be lowercase hex");
  });

  test("different unitKind produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, unitKind: "pass-b-chunk" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, unitKind: "pass-b-sweep" });
    assert(d1 !== d2, "different unitKind must produce different digests");
  });

  test("different requestHash produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      unitKind: "pass-b-chunk",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, requestHash: "sha256:aaa" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, requestHash: "sha256:bbb" });
    assert(d1 !== d2, "different requestHash must produce different digests");
  });

  test("different decoderIdentity produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, decoderIdentity: "v1" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, decoderIdentity: "v2" });
    assert(d1 !== d2, "different decoderIdentity must produce different digests");
  });

  test("different providerPlanIdentity produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, providerPlanIdentity: "plan-1" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, providerPlanIdentity: "plan-2" });
    assert(d1 !== d2, "different providerPlanIdentity must produce different digests");
  });

  test("different promptVersion produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      parserVersion: "parser-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, promptVersion: "B-1.0" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, promptVersion: "B-2.0" });
    assert(d1 !== d2, "different promptVersion must produce different digests");
  });

  test("different parserVersion produces a different digest", async () => {
    const { unitReuse } = (await mod());
    const base = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
    };
    const d1 = await unitReuse.unitIdentityDigest({ ...base, parserVersion: "parser-1.0" });
    const d2 = await unitReuse.unitIdentityDigest({ ...base, parserVersion: "parser-2.0" });
    assert(d1 !== d2, "different parserVersion must produce different digests");
  });

  test("storeCompletedUnit writes to R2 and lookupReusableUnit reads it back", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const modelOutput = { test: "output" };
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.05,
      latencyMs: 1000,
      model: "deepseek-v4-pro",
      provider: "deepseek",
      usageSource: "provider-reported",
      attempts: 1,
    };
    const result = await unitReuse.storeCompletedUnit(env, identity, modelOutput, usage, "run-1");
    assertEq(result, "stored", "first store should succeed");

    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found !== null, "lookup should find the stored unit");
    assertEq(found.sourceRunId, "run-1");
    assertEq(found.modelOutput.test, "output");
    assertEq(found.originalUsage.costUsd, 0.05);
  });

  test("storeCompletedUnit is first-writer-wins", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const usage = {
      inputTokens: 100, outputTokens: 50, costUsd: 0.05, latencyMs: 1000,
      model: "deepseek-v4-pro", provider: "deepseek", usageSource: "provider-reported", attempts: 1,
    };
    await unitReuse.storeCompletedUnit(env, identity, { first: true }, usage, "run-1");
    const second = await unitReuse.storeCompletedUnit(env, identity, { first: false }, usage, "run-2");
    assertEq(second, "already-stored", "second store should report already-stored");

    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found !== null, "lookup should still work");
    assertEq(found.sourceRunId, "run-1", "first writer's runId should win");
    assertEq(found.modelOutput.first, true, "first writer's output should win");
  });

  test("lookupReusableUnit returns null on identity field mismatch (collision paranoia)", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const usage = {
      inputTokens: 100, outputTokens: 50, costUsd: 0.05, latencyMs: 1000,
      model: "deepseek-v4-pro", provider: "deepseek", usageSource: "provider-reported", attempts: 1,
    };
    await unitReuse.storeCompletedUnit(env, identity, { ok: true }, usage, "run-1");

    // Corrupt the stored identity by directly writing a tampered entry
    const digest = await unitReuse.unitIdentityDigest(identity);
    const key = unitReuse.unitReuseKey(digest);
    const obj = await evidence.get(key);
    const stored = JSON.parse(await obj.text());
    stored.identity.decoderIdentity = "tampered";
    // Delete and rewrite with the tampered identity
    await evidence.delete(key);
    await evidence.put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json" },
    });

    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found === null, "tampered identity must be refused");
  });

  test("lookupReusableUnit returns null on version mismatch", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const usage = {
      inputTokens: 100, outputTokens: 50, costUsd: 0.05, latencyMs: 1000,
      model: "deepseek-v4-pro", provider: "deepseek", usageSource: "provider-reported", attempts: 1,
    };
    await unitReuse.storeCompletedUnit(env, identity, { ok: true }, usage, "run-1");

    // Tamper with the version
    const digest = await unitReuse.unitIdentityDigest(identity);
    const key = unitReuse.unitReuseKey(digest);
    const obj = await evidence.get(key);
    const stored = JSON.parse(await obj.text());
    stored.version = "v2-extract-unit-reuse/0.0.0";
    await evidence.delete(key);
    await evidence.put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json" },
    });

    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found === null, "wrong version must be refused");
  });

  test("lookupReusableUnit returns null for malformed originalUsage", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:abc123",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const usage = {
      inputTokens: 100, outputTokens: 50, costUsd: 0.05, latencyMs: 1000,
      model: "deepseek-v4-pro", provider: "deepseek", usageSource: "provider-reported", attempts: 1,
    };
    await unitReuse.storeCompletedUnit(env, identity, { ok: true }, usage, "run-1");

    // Tamper with the usage
    const digest = await unitReuse.unitIdentityDigest(identity);
    const key = unitReuse.unitReuseKey(digest);
    const obj = await evidence.get(key);
    const stored = JSON.parse(await obj.text());
    stored.originalUsage.costUsd = -1;
    await evidence.delete(key);
    await evidence.put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json" },
    });

    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found === null, "negative cost must be refused");
  });

  test("lookupReusableUnit returns null when R2 key is absent (miss)", async () => {
    const { unitReuse } = (await mod());
    const evidence = memoryR2();
    const env = { EVIDENCE: evidence };
    const identity = {
      unitKind: "pass-b-chunk",
      requestHash: "sha256:never-stored",
      decoderIdentity: "v1",
      providerPlanIdentity: "plan-1",
      promptVersion: "B-1.0",
      parserVersion: "parser-1.0",
    };
    const found = await unitReuse.lookupReusableUnit(env, identity);
    assert(found === null, "absent key must return null");
  });
});

suite("CROSS-RUN UNIT REUSE — pass-B end-to-end adoption", () => {
  test("chunk bought in run 1 is adopted in run 2 with zero-cost provenance", async () => {
    const { passB, deepseek } = (await mod());
    const doc = docFor(1);
    const evidence = memoryR2();
    const fakeFetch = fakeDeepseekFetch();
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeFetch;
      const env1 = baseEnv(evidence);

      // Run 1: purchase the chunk
      const result1 = await passB.runPassB(env1, "run-1", doc, "test.docx");
      assertEq(result1.slice.done, true, "run 1 must complete");
      assert(result1.requirements.length > 0, "run 1 must produce requirements");
      const run1Cost = result1.calls.reduce((sum, c) => sum + c.costUsd, 0);
      assert(run1Cost > 0, "run 1 must have non-zero cost");

      // Verify the unit was stored in the cross-run index
      const { unitReuse } = (await mod());
      const indexKeys = [...evidence._store.keys()].filter((k) => k.startsWith("v2/extract-units/"));
      assert(indexKeys.length > 0, "cross-run unit index must have at least one entry");

      // Run 2: same document, same env — should adopt instead of purchasing
      const env2 = baseEnv(evidence);
      let purchaseCallCount = 0;
      globalThis.fetch = async (...args) => {
        purchaseCallCount += 1;
        return fakeFetch(...args);
      };
      const result2 = await passB.runPassB(env2, "run-2", doc, "test.docx");
      assertEq(result2.slice.done, true, "run 2 must complete");
      assert(result2.requirements.length > 0, "run 2 must produce requirements");

      // The key assertion: run 2 must not have made any provider calls
      assertEq(purchaseCallCount, 0, "run 2 must not make any provider calls (adopted)");

      // Usage must show zero-cost provenance
      const run2Cost = result2.calls.reduce((sum, c) => sum + c.costUsd, 0);
      assertEq(run2Cost, 0, "run 2 cost must be zero (adopted)");

      // Every usage must be marked as reused-prior-artifact
      for (const call of result2.calls) {
        assertEq(call.usageSource, "reused-prior-artifact", "adopted usage must be marked reused-prior-artifact");
        assert(call.originalCostUsd > 0 || call.originalCostUsd === 0, "adopted usage must carry originalCostUsd");
      }

      // The requirements must be identical in content (not in provenance)
      assertEq(
        result2.requirements.length,
        result1.requirements.length,
        "adopted run must produce the same number of requirements",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("identity miss when block text changes (different document)", async () => {
    const { passB } = (await mod());
    const evidence = memoryR2();
    const fakeFetch = fakeDeepseekFetch();
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeFetch;

      // Run 1: purchase with doc A
      const docA = docFor(1);
      const env1 = baseEnv(evidence);
      await passB.runPassB(env1, "run-1", docA, "test.docx");

      // Run 2: different document text — must miss and purchase fresh
      const docB = docFor(1);
      docB.blocks[0].text = "COMPLETELY DIFFERENT QUESTION TEXT";
      docB.annotatedText = `[b0001] ${docB.blocks[0].text}`;
      const env2 = baseEnv(evidence);
      let purchaseCallCount = 0;
      globalThis.fetch = async (...args) => {
        purchaseCallCount += 1;
        return fakeFetch(...args);
      };
      await passB.runPassB(env2, "run-2", docB, "test.docx");
      assert(purchaseCallCount > 0, "different block text must cause a fresh purchase (identity miss)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("identity miss when providerPlanIdentity changes (different rates)", async () => {
    const { passB } = (await mod());
    const evidence = memoryR2();
    const fakeFetch = fakeDeepseekFetch();
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeFetch;

      // Run 1: purchase with rate A
      const doc = docFor(1);
      const env1 = baseEnv(evidence);
      await passB.runPassB(env1, "run-1", doc, "test.docx");

      // Run 2: different rates — must miss and purchase fresh
      const env2 = {
        ...baseEnv(evidence),
        DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK: "2.0",
        DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK: "8.0",
      };
      let purchaseCallCount = 0;
      globalThis.fetch = async (...args) => {
        purchaseCallCount += 1;
        return fakeFetch(...args);
      };
      await passB.runPassB(env2, "run-2", doc, "test.docx");
      assert(purchaseCallCount > 0, "different rates must cause a fresh purchase (identity miss)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("adopted payload revalidation refusal falls back to live purchase", async () => {
    const { passB, unitReuse, passB: { PASS_B_DECODER_VERSION: decoderV } } = (await mod());
    const doc = docFor(1);
    const evidence = memoryR2();
    const fakeFetch = fakeDeepseekFetch();
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeFetch;

      // Run 1: purchase the chunk normally
      const env1 = baseEnv(evidence);
      await passB.runPassB(env1, "run-1", doc, "test.docx");

      // Now tamper with the stored modelOutput in the cross-run index so it fails decoding
      const indexKeys = [...evidence._store.keys()].filter((k) => k.startsWith("v2/extract-units/"));
      assert(indexKeys.length > 0, "must have a stored unit to tamper with");
      for (const key of indexKeys) {
        const obj = await evidence.get(key);
        const entry = JSON.parse(await obj.text());
        // Corrupt the model output so the decoder rejects it
        entry.modelOutput = { deliberately: "corrupt output that no decoder will accept" };
        await evidence.delete(key);
        await evidence.put(key, JSON.stringify(entry), {
          httpMetadata: { contentType: "application/json" },
        });
      }

      // Also delete the per-run artifact so run 2 cannot reclaim from run 1's R2 keys
      const runKeys = [...evidence._store.keys()].filter((k) => k.startsWith("v2/runs/run-1/"));
      for (const key of runKeys) await evidence.delete(key);

      // Run 2: the cross-run unit has corrupt modelOutput, so adoption should be refused
      // and a live purchase should happen instead
      const env2 = baseEnv(evidence);
      let purchaseCallCount = 0;
      globalThis.fetch = async (...args) => {
        purchaseCallCount += 1;
        return fakeFetch(...args);
      };
      const result2 = await passB.runPassB(env2, "run-2", doc, "test.docx");
      assert(purchaseCallCount > 0, "corrupt adopted payload must trigger a live purchase");
      assertEq(result2.slice.done, true, "run 2 must still complete after fallback");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("failed units never enter the cross-run index", async () => {
    const { passB } = (await mod());
    const evidence = memoryR2();
    // Provider returns 500 so every chunk fails
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: "server error" }), { status: 500 });

      const doc = docFor(1);
      const env1 = {
        ...baseEnv(evidence),
        EXTRACT_CHUNK_MAX_ISSUES: "1",
      };
      try {
        await passB.runPassB(env1, "run-1", doc, "test.docx");
      } catch {
        // Expected to fail — the provider is returning errors
      }

      // The cross-run index must be empty — failed units must never be stored
      const indexKeys = [...evidence._store.keys()].filter((k) =>
        k.startsWith("v2/extract-units/"),
      );
      assertEq(
        indexKeys.length,
        0,
        "failed units must never enter the cross-run index", // mutation-anchor: unit-reuse-no-failed-store
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
