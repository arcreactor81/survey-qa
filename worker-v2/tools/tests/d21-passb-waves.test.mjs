/**
 * D21 — THE PASS-B FAN-OUT DOES NOT FIT IN ONE WORKFLOW STEP.
 *
 * ============================ THE DEFECT ============================
 *
 * `EXTRACT_POLICY` gave `extract-pass-b-blocks` a timeout of 8 minutes (480 s), and the
 * WHOLE fan-out lived inside it: ~23 chunks at EXTRACT_CHUNK_CONCURRENCY=5 is 5 sequential
 * rounds, a round costs the SLOWEST of its five calls (measured DeepSeek median 127.5 s,
 * p90 206 s, max 285 s), and up to EXTRACT_SWEEP_MAX_CALLS more calls run SERIALLY after
 * them — inside the same step. The per-call ceiling (LLM_TIMEOUT_MS = 300 s) could never
 * fire, because no single call was slow enough; the STEP died instead. On real Workflow
 * history two runs of the same document split: one scraped through on attempt 3 of 3, the
 * other burned all three attempts and errored with three durably-recorded 480000 ms
 * timeouts on the same step. A coin flip that a larger questionnaire only loses.
 *
 * Each of those deaths ALSO re-bought work. A step timeout kills whatever calls are in
 * flight; those calls were billed and never persisted, so the retry paid for them again.
 *
 * ============================ WHAT IS ASSERTED HERE ============================
 *
 * (a) A fan-out larger than one step's budget FINISHES ACROSS STEPS, or stops with a NAMED
 *     reason. It never truncates: an unfinished pass persists no pass payload, so the
 *     consolidation that reads that key can never merge a half-read document as if it were
 *     whole.
 * (b) A retry never re-issues a chunk that already landed, and a unit that keeps FAILING is
 *     re-bought a bounded number of times across the whole run, not once per wave.
 * (c) The existing resume behaviour — reused chunks contribute their obligations and cost
 *     nothing — still holds, and now covers the ledger sweep too.
 * (d) The step timeout is DERIVED and always covers its own budget plus one whole PURCHASE —
 *     where a purchase is EXTRACT_MAX_ATTEMPTS attempts, because `llm/chat.ts` retries inside
 *     one call and bills for every attempt.
 *
 * Every property here is mutation-proved by `tools/mutate-passb.mjs`, which uses the
 * baseline-aware criterion in `tools/mutate-runner.mjs`.
 */

import { assert, assertEq, assertThrows, fakeStep, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

// ---------------------------------------------------------------------------
// A synthetic document. Blocks are paragraphs with no table coordinates, so with
// EXTRACT_CHUNK_MAX_BLOCKS=1 the chunker produces exactly one chunk per block and the
// arithmetic in every test below is exact rather than approximate.
// ---------------------------------------------------------------------------

function docFor(n) {
  const blocks = Array.from({ length: n }, (_, i) => ({
    blockId: `b${String(i + 1).padStart(4, "0")}`,
    kind: "paragraph",
    text: `Q${i + 1}. Ask the respondent question ${i + 1}. SINGLE CODE. Must be answered.`,
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
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
  "question",
  "option-list",
  "skip-rule",
  "terminate",
  "validation",
  "piping",
  "carry-forward",
  "calculation",
  "randomization",
  "loop",
  "instruction",
];

/**
 * Stand in for the provider at the TRANSPORT boundary — `globalThis.fetch` — so everything
 * between the stage and the wire (llm/chat.ts's attempt loop, truncation handling, usage
 * accounting, the coercion layer) is the real code. The testkit only stubs platform modules;
 * this is the established place to cut.
 */
function stubProvider({ failUnit = () => false, citeBlocks = true } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1] ?? "PASS-A";
    const blockIds = [...new Set([...user.matchAll(/\[(b\d{4})\]/g)].map((m) => m[1]))];
    requests.push({ url: String(url), unit, blockIds });

    if (failUnit(unit, requests.length)) {
      return new Response("upstream exploded", { status: 502 });
    }

    const obligations = citeBlocks
      ? blockIds.map((id, i) => ({
          id: `${unit}-R${i + 1}`,
          construct: "question",
          scope: "question",
          quantifier: "every",
          selector: id,
          exceptions: [],
          statement: `block ${id} must be asked and answered`,
          doc_quote: `Q text for ${id}`,
          block_ids: [id],
          browser_observable: "full",
          confidence: 0.9,
        }))
      : [];

    const payload = {
      // Pass A reads this key; pass B reads the two below. One stub answers both legs.
      global_rules: [],
      cross_references: [],
      obligations,
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
    };

    return new Response(
      JSON.stringify({
        // The transport contract now requires the provider to attest the exact
        // requested SKU; an unrelated fixture label correctly fails closed.
        model: body.model,
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    requests,
    unitsCalled: () => requests.map((r) => r.unit),
    countFor: (unit) => requests.filter((r) => r.unit === unit).length,
    reset: () => {
      requests.length = 0;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** One chunk per block, one purchase per call: exact arithmetic, no provider retries. */
function sliceEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    // D21 isolates slicing/resume for one exact pass-B Pro purchase. Provider activation
    // and the Grok -> Flash substitution are exercised by the dedicated provider suite.
    DEEPSEEK_FALLBACK_MODE: "disabled",
    // Gateway config is part of the production posture: llm/chat.ts refuses a direct,
    // unmetered provider call without it. Tests stub globalThis.fetch, so they exercise
    // the same gateway URL production builds.
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    GROK_MODEL: "grok-4.6",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-dashboard-copy",
    GROK_RATE_ATTESTED_MODEL: "grok-4.6",
    GROK_RATE_ATTESTED_AT: "2026-08-13",
    GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "10",
    EXTRACT_MAX_ATTEMPTS: "1",
    ...overrides,
  };
}

/** Drive slices until the pass reports done, or give up loudly rather than hang. */
async function driveToDone(m, env, runId, doc, budgetMs, cap = 40) {
  const waves = [];
  for (let i = 0; i < cap; i++) {
    const out = await m.passB.runPassB(env, runId, doc, "synthetic.docx", undefined, { budgetMs });
    waves.push(out);
    if (out.slice.done) return { waves, last: out };
  }
  throw new Error(`pass B never reported done after ${cap} wave(s) — the wave loop does not terminate`);
}

// ===========================================================================
suite("D21 — a fan-out bigger than one step's budget is spread across steps", () => {

test("(a) six chunks that cannot fit one wave are finished ACROSS waves, and nothing is dropped", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(6);
    const { waves, last } = await driveToDone(m, env, "run_d21_across", doc, 0);

    // THE STRUCTURAL CLAIM: one wave could not do it, several waves could.
    assert(waves.length > 1, `the fan-out must need more than one wave at a zero budget, took ${waves.length}`);
    assertEq(last.slice.done, true, "the last wave reports the pass finished");
    assertEq(last.slice.chunksRemaining, 0, "no chunk is left owing a call");
    assertEq(last.slice.chunksLanded, 6, "every chunk landed");

    // AND IT DID NOT SILENTLY TRUNCATE: every block of the document is dispositioned and
    // cited exactly once, by exactly one call each.
    assertEq(provider.requests.length, 6, `one purchase per chunk, got ${provider.unitsCalled().join(",")}`);
    assertEq(new Set(provider.unitsCalled()).size, 6, "six DISTINCT chunks were bought");
    const dispositioned = new Set(last.dispositions.map((d) => d.blockId));
    assertEq(dispositioned.size, 6, "every source block carries a disposition");
    const cited = new Set(last.requirements.flatMap((r) => r.blockIds));
    assertEq(cited.size, 6, "every source block is cited by an obligation");
  } finally {
    provider.restore();
  }
});

test("a wave with NO budget at all still issues one call — the wave loop can never stall", async () => {
  // The exemption that makes the wave count a bound on the DOCUMENT rather than on luck.
  // Without it a slice whose deadline has already passed issues nothing, reports `done:
  // false`, and the workflow burns every step it owns without moving a single chunk.
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const first = await m.passB.runPassB(env, "run_d21_progress", docFor(3), "synthetic.docx", undefined, {
      budgetMs: 0,
    });
    assert(first.slice.chunksIssued >= 1, `a wave must always buy at least one chunk, bought ${first.slice.chunksIssued}`);
    assertEq(first.slice.done, false, "three chunks cannot be done after a single-call wave");
    assert(first.slice.chunksRemaining > 0, "the wave must report the work it deferred");
    assertEq(provider.requests.length, first.slice.chunksIssued, "issued count matches the calls actually made");
  } finally {
    provider.restore();
  }
});

test("a generous budget still does the whole fan-out in ONE wave — slicing is not serialization", async () => {
  const m = await mod();
  const env = sliceEnv({ EXTRACT_CHUNK_CONCURRENCY: "5" });
  const provider = stubProvider();
  try {
    const out = await m.passB.runPassB(env, "run_d21_onewave", docFor(6), "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });
    assertEq(out.slice.done, true, "a wave with real budget finishes the document");
    assertEq(out.slice.chunksIssued, 6, "all six chunks bought inside one wave");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
// D51 — parser/prompt-versioned resume artifacts. Kept here so the existing D21
// registration exercises it without adding another test-loader seam.
// ===========================================================================

suite("D51 — pass B artifact versions", () => {

const d51ChunkKey = (m, runId) =>
  m.keys.k("runs", runId, "extraction", "pass-b", "chunk-01.json");
const d51SweepKey = (m, runId) =>
  m.keys.k("runs", runId, "extraction", "pass-b", "sweep01.json");

async function d51Put(env, key, value) {
  await env.EVIDENCE.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

async function d51Read(env, key) {
  const obj = await env.EVIDENCE.get(key);
  assert(obj !== null, `expected D51 artifact at ${key}`);
  return JSON.parse(await obj.text());
}

function d51AssertVersions(m, value, promptVersion, label) {
  assertEq(value.parserVersion, m.docxBlocks.DOCX_BLOCKS_VERSION, `${label} parser version`);
  assertEq(value.promptVersion, promptVersion, `${label} prompt version`);
}

const d51CurrentChunk = (m, env) => ({
  chunkId: "C01-b0001",
  blockIds: ["b0001"],
  parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
  promptVersion: m.passB.PASS_B_VERSION,
  // A pass-B artifact is reusable only under the exact Pro extraction leg, never under
  // the unrelated same-provider continuity plan. Keep every non-version identity current
  // here so the stale parser/prompt assertions exercise the field named by the test.
  providerPlanIdentity: m.deepseek.deepseekPassBIdentity(env),
  usages: [{
    eventId: "core-model-call/pass-b/d51/C01-b0001/issue-1/receipt-1",
    callId: "d51-current-chunk",
    role: "extract-pass-b-C01-b0001",
    provider: "deepseek",
    model: m.deepseek.deepseekContinuityPlan(env).primary.model,
    status: "ok",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.000001,
    latencyMs: 1,
    attempts: 1,
    usageSource: "provider-reported",
  }],
  obligations: [],
  dispositions: [{ blockId: "b0001", disposition: "normative", reason: "requires the ledger sweep" }],
  constructs: [],
  ambiguities: [],
  unverifiable: [],
});

test("D51-b pass B rejects stale chunk, sweep, and whole-pass artifacts and resets attempts", async () => {
  const m = await mod();
  const document = docFor(1);

  // Structurally valid stale chunk success: re-issue and replace it.
  {
    const env = sliceEnv();
    const runId = "run_d51_b_success";
    await d51Put(env, d51ChunkKey(m, runId), {
      ...d51CurrentChunk(m, env),
      parserVersion: "stale-parser/0",
      obligations: [{ id: "B-STALE" }],
    });
    const provider = stubProvider();
    try {
      const result = await m.passB.runPassB(env, runId, document, "synthetic.docx");
      assertEq(provider.countFor("C01-b0001"), 1, "stale chunk success is re-issued");
      assert(result.requirements.some((row) => row.id === "C01-b0001-R1"), "fresh chunk output replaces stale output");
      d51AssertVersions(m, await d51Read(env, d51ChunkKey(m, runId)), m.passB.PASS_B_VERSION, "fresh chunk success");
    } finally {
      provider.restore();
    }
  }

  // A stale prompt's terminal failure cannot consume the current prompt's retry budget.
  {
    const env = sliceEnv({ EXTRACT_CHUNK_MAX_ISSUES: "2" });
    const runId = "run_d51_b_failure";
    await d51Put(env, d51ChunkKey(m, runId), {
      chunkId: "C01-b0001",
      blockIds: ["b0001"],
      parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
      promptVersion: "stale-prompt/0",
      status: "failed",
      attempts: 99,
      detail: "the old prompt exhausted its budget",
    });
    const provider = stubProvider({ failUnit: (unit) => unit === "C01-b0001" });
    try {
      await m.passB.runPassB(env, runId, document, "synthetic.docx");
      const fresh = await d51Read(env, d51ChunkKey(m, runId));
      assertEq(provider.countFor("C01-b0001"), 1, "stale terminal chunk failure is re-issued");
      assertEq(fresh.attempts, 1, "the current chunk starts its retry budget at one");
      d51AssertVersions(m, fresh, m.passB.PASS_B_VERSION, "fresh chunk failure");
    } finally {
      provider.restore();
    }
  }

  // The sweep uses the SAME strict reader. Keep the chunk current and make only its
  // unaccounted-block sweep stale so a request count proves which layer was reclaimed.
  {
    const env = sliceEnv({ EXTRACT_SWEEP_MAX_CALLS: "1" });
    const runId = "run_d51_sweep_success";
    await d51Put(env, d51ChunkKey(m, runId), d51CurrentChunk(m, env));
    await d51Put(env, d51SweepKey(m, runId), {
      sweepId: "SWEEP01",
      blockIds: ["b0001"],
      parserVersion: "stale-parser/0",
      promptVersion: m.passB.PASS_B_VERSION,
      usage: null,
      obligations: [{ id: "SWEEP-STALE" }],
      dispositions: [{ blockId: "b0001", disposition: "normative", reason: "stale" }],
      ambiguities: [],
      unverifiable: [],
    });
    const provider = stubProvider();
    try {
      const result = await m.passB.runPassB(env, runId, document, "synthetic.docx");
      assertEq(provider.requests.length, 1, "only the stale sweep is re-issued");
      assertEq(provider.requests[0].unit, "SWEEP01", "the current chunk was reclaimed for free");
      assert(result.requirements.some((row) => row.id === "SWEEP01-R1"), "fresh sweep output replaces stale output");
      d51AssertVersions(m, await d51Read(env, d51SweepKey(m, runId)), m.passB.PASS_B_VERSION, "fresh sweep success");
    } finally {
      provider.restore();
    }
  }

  {
    const env = sliceEnv({ EXTRACT_CHUNK_MAX_ISSUES: "2", EXTRACT_SWEEP_MAX_CALLS: "1" });
    const runId = "run_d51_sweep_failure";
    await d51Put(env, d51ChunkKey(m, runId), d51CurrentChunk(m, env));
    await d51Put(env, d51SweepKey(m, runId), {
      sweepId: "SWEEP01",
      blockIds: ["b0001"],
      parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
      promptVersion: "stale-prompt/0",
      status: "failed",
      attempts: 99,
      detail: "the old prompt exhausted its sweep budget",
    });
    const provider = stubProvider({ failUnit: (unit) => unit === "SWEEP01" });
    try {
      await m.passB.runPassB(env, runId, document, "synthetic.docx");
      const fresh = await d51Read(env, d51SweepKey(m, runId));
      assertEq(provider.countFor("SWEEP01"), 1, "stale terminal sweep failure is re-issued");
      assertEq(fresh.attempts, 1, "the current sweep starts its retry budget at one");
      d51AssertVersions(m, fresh, m.passB.PASS_B_VERSION, "fresh sweep failure");
    } finally {
      provider.restore();
    }
  }

  // Whole-pass early reuse has its own reader. A stale prompt must fall through to the
  // current chunk walk and the replacement whole artifact must carry both versions.
  {
    const env = sliceEnv({ EXTRACT_CHUNK_MAX_BLOCKS: "999", EXTRACT_CHUNK_CHARS: "999999" });
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { REPO_ROOT } = await import("../testkit.mjs");
    const documentKey = m.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx")));
    await d51Put(env, m.keys.extractionPassKey(runId, "b"), {
      parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
      promptVersion: "stale-prompt/0",
      pass: "B",
      provider: "deepseek",
      model: "stale-model",
      requirements: [],
      ambiguities: [],
      unverifiable: [],
      dispositions: [],
      constructs: [],
      failedUnits: [],
      calls: [],
    });
    const provider = stubProvider();
    try {
      const outcome = await m.extractStage.stagePassBSlice(
        env,
        runId,
        documentKey,
        "questionnaire.docx",
        fence,
        async () => {},
        {},
      );
      assertEq(outcome.result.state, "evaluated", "the current whole pass B completes");
      assert(provider.requests.length > 0, "the stale whole-pass B payload does not suppress current model work");
      d51AssertVersions(
        m,
        await d51Read(env, m.keys.extractionPassKey(runId, "b")),
        m.passB.PASS_B_VERSION,
        "fresh whole pass B",
      );
    } finally {
      provider.restore();
    }
  }
});

test("D51-e consolidation refuses stale pass A or pass B payloads", async () => {
  const m = await mod();
  const env = sliceEnv();
  const runId = "run_d51_consolidate";
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("../testkit.mjs");
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx")));

  const pass = (name, stale) => ({
    parserVersion: stale === "parser" ? "stale-parser/0" : m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion:
      stale === "prompt" ? "stale-prompt/0" : name === "A" ? m.passA.PASS_A_VERSION : m.passB.PASS_B_VERSION,
    pass: name,
    provider: name === "A" ? "grok" : "deepseek",
    model: "seed-model",
    requirements: [],
    ambiguities: [],
    unverifiable: [],
    dispositions: [],
    constructs: [],
    failedUnits: [],
    calls: [],
    ...(name === "B" ? { providerPlanIdentity: m.deepseek.deepseekPassBIdentity(env) } : {}),
    ...(name === "A" ? {
      // This is the normal route: Grok 4.6, no fallback. The stale parser check below
      // must not pass merely because an old fixture omitted the new route receipt fields.
      providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
      providerIndependence: "independent",
      fallbackTriggers: [],
      routeReceipts: [],
      crossRefs: [],
    } : {}),
  });
  const aKey = m.keys.extractionPassKey(runId, "a");
  const bKey = m.keys.extractionPassKey(runId, "b");

  await d51Put(env, aKey, pass("A", "parser"));
  await d51Put(env, bKey, pass("B"));
  const staleA = await m.extractStage.stageConsolidate(env, runId, documentKey, "a".repeat(64), "en", ["desktop"]);
  assertEq(staleA.state, "not-evaluated", "stale pass A cannot be merged");
  assertEq(staleA.reason, "MISSING_PASS", "stale pass A is a named current-payload absence");
  assert(staleA.detail.includes("pass A left no payload"), "the refusal names pass A");
  assertEq(await env.EVIDENCE.get(m.extractStage.mergedKey(runId)), null, "stale pass A writes no merged artifact");

  await d51Put(env, aKey, pass("A"));
  await d51Put(env, bKey, pass("B", "prompt"));
  const staleB = await m.extractStage.stageConsolidate(env, runId, documentKey, "a".repeat(64), "en", ["desktop"]);
  assertEq(staleB.state, "not-evaluated", "stale pass B cannot be merged");
  assertEq(staleB.reason, "MISSING_PASS", "stale pass B is a named current-payload absence");
  assert(staleB.detail.includes("pass B left no payload"), "the refusal names pass B");
  assertEq(await env.EVIDENCE.get(m.extractStage.mergedKey(runId)), null, "stale pass B writes no merged artifact");
});

});

// ===========================================================================
suite("D21 — a retry never re-issues work that already landed", () => {

test("(b) a second wave over a finished pass buys NOTHING", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(4);
    const runId = "run_d21_resume";
    const { last: first } = await driveToDone(m, env, runId, doc, 0);
    assertEq(provider.requests.length, 4, "the first pass bought four chunks");

    provider.reset();
    const again = await m.passB.runPassB(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });

    // THE ASSERTION THIS TEST EXISTS FOR.
    assertEq(provider.requests.length, 0, `a re-entered pass must buy nothing, bought ${provider.unitsCalled().join(",")}`);
    assertEq(again.slice.chunksIssued, 0, "the slice reports zero chunks issued");
    assertEq(again.slice.done, true, "and it is done immediately");
    assertEq(again.issuedCalls.length, 0, "nothing is charged to the run's ledger");

    // (c) RESUME IS NOT JUST 'CHEAP', IT IS COMPLETE: the reused pass carries the same
    // obligations and dispositions the fresh one did.
    assertEq(again.requirements.length, first.requirements.length, "reused obligations are all there");
    assertEq(again.dispositions.length, first.dispositions.length, "reused dispositions are all there");
    assertEq(again.calls.length, 4, "the telemetry rows survive for the payload");
    assert(
      again.calls.every((c) => c.costUsd === 0),
      "a reused chunk costs nothing — charging it again would describe a run that never happened",
    );
  } finally {
    provider.restore();
  }
});

test("(b) a HALF-finished pass re-issues only the chunks that never landed", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(5);
    const runId = "run_d21_partial";
    const first = await m.passB.runPassB(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 0 });
    const boughtFirst = new Set(provider.unitsCalled());
    assertEq(first.slice.done, false, "one call cannot finish five chunks");

    provider.reset();
    const rest = await m.passB.runPassB(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });
    const boughtAgain = provider.unitsCalled();

    assertEq(rest.slice.done, true, "the second wave finishes the rest");
    for (const unit of boughtAgain) {
      assert(!boughtFirst.has(unit), `chunk ${unit} landed in wave 0 and must never be bought again`);
    }
    assertEq(boughtAgain.length, 5 - boughtFirst.size, "exactly the chunks that had not landed were bought");
  } finally {
    provider.restore();
  }
});

test("a chunk that keeps FAILING is re-bought a bounded number of times, not once per wave", async () => {
  // The gateway trace showed a single chunk id billed 21–24 times during a recovery storm.
  // The attempt count lives in the chunk's own artifact, so waves, step retries and recovery
  // instances share ONE budget instead of each starting a fresh one.
  const m = await mod();
  const env = sliceEnv({ EXTRACT_CHUNK_MAX_ISSUES: "2", EXTRACT_SWEEP_MAX_CALLS: "0" });
  const doomed = "C02-b0002";
  const provider = stubProvider({ failUnit: (unit) => unit === doomed });
  try {
    const doc = docFor(3);
    const { last } = await driveToDone(m, env, "run_d21_bounded", doc, 0);

    assertEq(provider.countFor(doomed), 2, `the failing chunk must be bought EXACTLY twice, was bought ${provider.countFor(doomed)}`);
    assertEq(last.slice.done, true, "the pass still terminates rather than looping on a chunk nobody can answer");
    assert(
      last.failedUnits.some((f) => f.unit === doomed),
      "the failure is NAMED as a failed unit, never reported as a chunk that found nothing",
    );
    const disp = last.dispositions.filter((d) => d.blockId === "b0002");
    assert(disp.length > 0 && disp.every((d) => d.disposition === "unresolved"), "its blocks stay unresolved");
  } finally {
    provider.restore();
  }
});

test("(c) the ledger sweep resumes too — its calls used to be written and never read back", async () => {
  // The sweep artifacts were persisted and then never consulted, so every step retry
  // re-bought all three sweep calls at full price on top of the chunk walk.
  const m = await mod();
  const env = sliceEnv({ EXTRACT_SWEEP_BLOCKS_PER_CALL: "40", EXTRACT_SWEEP_MAX_CALLS: "3" });
  // `citeBlocks: false` leaves every block dispositioned `normative` with no obligation
  // citing it — which is exactly the ledger hole the sweep exists to close.
  const provider = stubProvider({ citeBlocks: false });
  try {
    const doc = docFor(3);
    const runId = "run_d21_sweep";
    const { last } = await driveToDone(m, env, runId, doc, 600_000);
    const sweepCalls = provider.unitsCalled().filter((u) => u.startsWith("SWEEP"));
    assert(sweepCalls.length > 0, "the sweep must have run at all for this test to mean anything");
    assertEq(last.slice.done, true, "the pass finished including its sweep");

    provider.reset();
    const again = await m.passB.runPassB(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });
    assertEq(
      provider.requests.length,
      0,
      `a re-entered pass must re-buy no sweep call either, bought ${provider.unitsCalled().join(",")}`,
    );
    assertEq(again.slice.sweepCallsIssued, 0, "zero sweep calls issued on the second pass");
    assertEq(again.slice.done, true, "and it is immediately done");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("D21 — the step timeout is DERIVED so the axe cannot fall on a paid-for call", () => {

test("the pass-B step timeout always exceeds its own wave budget by at least one whole PURCHASE", async () => {
  // THE INVARIANT. A wave stops ISSUING at its budget but never abandons a call already in
  // flight, so the step around it must be allowed to live for the budget PLUS a whole
  // purchase. Anything less and the step axe kills work that was already billed and not yet
  // persisted — which is the duplicate spend this whole design removes.
  //
  // A PURCHASE IS NOT AN ATTEMPT, AND THIS TEST USED TO ASSUME IT WAS. `llm/chat.ts` loops up
  // to EXTRACT_MAX_ATTEMPTS times inside ONE `deepseekJson` call, gives every attempt its own
  // `AbortSignal.timeout(LLM_TIMEOUT_MS)`, and accrues token usage across all of them. The
  // step timeout budgeted a SINGLE attempt, and EXTRACT_MAX_ATTEMPTS is not declared in
  // `wrangler.jsonc` — so the LIVE default of 2 meant a slice's last-issued call could be
  // killed mid-flight after being billed twice. The invariant was false in production, which
  // is a check that cannot fail dressed as a check that passes.
  const m = await mod();
  const cases = [
    {},
    { EXTRACT_WAVE_BUDGET_MS: "0" },
    { EXTRACT_WAVE_BUDGET_MS: "60000", LLM_TIMEOUT_MS: "300000" },
    { EXTRACT_WAVE_BUDGET_MS: "1800000", LLM_TIMEOUT_MS: "600000", EXTRACT_MAX_ATTEMPTS: "3" },
    {
      EXTRACT_WAVE_BUDGET_MS: "not-a-number",
      LLM_TIMEOUT_MS: "not-a-number",
      EXTRACT_MAX_ATTEMPTS: "not-a-number",
    },
    { EXTRACT_WAVE_BUDGET_MS: "-5000", EXTRACT_MAX_ATTEMPTS: "-1" },
    { EXTRACT_MAX_ATTEMPTS: "0" },
    { LLM_TIMEOUT_MS: "0" },
    { LLM_TIMEOUT_MS: "-5000" },
  ];
  for (const env of cases) {
    const budget = m.passB.passBWaveBudgetMs(env);
    const ceiling = m.passB.passBCallCeilingMs(env);
    const timeout = m.passB.passBStepTimeoutMs(env);
    // Exactly the pass-B Pro leg's transport-attempt clamp. Flash is a substitution for
    // the Grok leg, not an additional retry inside a pass-B purchase.
    const attempts = m.deepseek.deepseekPassBAttemptCeiling(env);
    const attemptMs = Math.max(0, m.env.num(env.LLM_TIMEOUT_MS, 300_000));

    assert(budget >= 0, `the wave budget must never be negative for ${JSON.stringify(env)}, got ${budget}`);
    assertEq(
      ceiling,
      attempts * attemptMs,
      `the purchase ceiling must cover EVERY attempt chat.ts may make for ${JSON.stringify(env)}`,
    );
    assert(
      ceiling >= attemptMs,
      `the purchase ceiling ${ceiling} must cover at least one whole attempt ${attemptMs} for ${JSON.stringify(env)}`,
    );
    assert(
      timeout >= budget + ceiling,
      `step timeout ${timeout} must cover budget ${budget} + one purchase ${ceiling} for ${JSON.stringify(env)}`,
    );
    assert(timeout > budget, `step timeout ${timeout} must strictly exceed the budget ${budget}`);
  }

  // And the DEFAULT posture must clear the 480 s ceiling that killed the real runs, with a
  // whole PURCHASE of room to spare — derived, not the literal 300 s this line used to carry.
  assert(
    m.passB.passBStepTimeoutMs({}) > 480_000 + m.passB.passBCallCeilingMs({}),
    `the default step timeout (${m.passB.passBStepTimeoutMs({})} ms) must be well clear of the 480 s ceiling`,
  );
});

});

// ===========================================================================
suite("D21 — an unfinished pass persists NOTHING, so consolidation cannot merge half a read", () => {

async function stageBed(overrides = {}) {
  const m = await mod();
  const env = sliceEnv(overrides);
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  return { m, env, runId, fence };
}

test("(a) the STAGE refuses to evaluate an unfinished pass, and evaluates the finished one", async () => {
  const { m, env, runId, fence } = await stageBed({ EXTRACT_CHUNK_MAX_BLOCKS: "10", EXTRACT_CHUNK_CHARS: "2000" });
  const provider = stubProvider();
  try {
    // A real .docx, read from disk, so `loadDocument` and the real parser are in the loop.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { REPO_ROOT } = await import("../testkit.mjs");
    const bytes = readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx"));
    const documentKey = m.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, bytes, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });

    const beat = async () => {};
    const first = await m.extractStage.stagePassBSlice(env, runId, documentKey, "questionnaire.docx", fence, beat, {
      budgetMs: 0,
    });

    // THE SILENT-TRUNCATION GUARD. `stageConsolidate` reads the pass key and merges whatever
    // it finds, with no way to tell a whole read from a partial one.
    assertEq(first.slice.done, false, "a zero-budget wave over a real questionnaire cannot finish it");
    assertEq(first.result.state, "not-evaluated", "an unfinished pass is NOT an evaluated pass");
    assertEq(first.result.reason, "PASS_B_INCOMPLETE", "and it says which incompleteness");
    assertEq(
      await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "b")),
      null,
      "NOTHING is persisted under the pass key while the walk is incomplete",
    );

    // Now finish it, and the same seam evaluates and persists exactly once.
    let waves = 1;
    let out = first;
    while (!out.slice.done && waves < 60) {
      out = await m.extractStage.stagePassBSlice(env, runId, documentKey, "questionnaire.docx", fence, beat, {
        budgetMs: 0,
      });
      waves += 1;
    }
    assertEq(out.slice.done, true, `the pass finished across ${waves} wave(s)`);
    assert(waves > 1, "and it genuinely needed more than one");
    assertEq(out.result.state, "evaluated", "a finished pass IS evaluated");
    assert(
      (await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "b"))) !== null,
      "and only now is the pass payload persisted",
    );

    // THE LEDGER COUNTS PURCHASES, NOT ROWS. Reused chunks carry telemetry into the payload
    // with cost zeroed; charging those once per wave would walk a large document into
    // CAP_MODEL_CALLS on calls nobody ever made.
    const cp = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(
      cp.usage.modelCalls.used,
      provider.requests.length,
      `the run is charged for the ${provider.requests.length} call(s) it bought, not for every reuse`,
    );
  } finally {
    provider.restore();
  }
});

test("(b) a same-count replacement of merged.json is refused before sealing", async () => {
  const m = await mod();
  const env = sliceEnv();
  const runId = m.ids.mintRunId();
  const original = {
    schemaVersion: "v2-extraction-merged/1.0.0",
    documentSha256: "a".repeat(64),
    requirements: [{ requirementLineageId: "rl_1", normativeStatement: "the original approved requirement" }],
    facetInstances: [{ facetInstanceId: "fi_1", requirementLineageId: "rl_1" }],
  };
  const originalBytes = JSON.stringify(original, null, 2);
  const expectedHash = `sha256:${await m.hash.sha256Hex(originalBytes)}`;
  await env.EVIDENCE.put(m.extractStage.mergedKey(runId), originalBytes);

  const approved = await m.extractStage.loadMerged(env, runId, expectedHash);
  assertEq(approved.requirements.length, 1, "the approved bytes re-read normally");
  assertEq(approved.facetInstances.length, 1, "the approved denominator has one case");

  // Keep both headline counts unchanged. A count-only guard would accept this replacement
  // even though the requirement the ledger approved is no longer the requirement sealing reads.
  const replacement = structuredClone(original);
  replacement.requirements[0].normativeStatement = "a different, unapproved requirement";
  assertEq(replacement.requirements.length, original.requirements.length);
  assertEq(replacement.facetInstances.length, original.facetInstances.length);
  await env.EVIDENCE.put(m.extractStage.mergedKey(runId), JSON.stringify(replacement, null, 2));

  const err = await assertThrows(
    () => m.extractStage.loadMerged(env, runId, expectedHash),
    "MERGED_ARTIFACT_HASH_MISMATCH",
  );
  assertEq(err.name, "MergedArtifactIntegrityFailure");
  assert(err.message.includes(expectedHash), "the refusal names the durable step's expected hash");
  assertEq(
    m.workflow.classifyFailure(err),
    "merged-extraction-hash-mismatch",
    "the workflow publishes a named integrity ending rather than generic workflow-error",
  );
});

test("(c) WORKFLOW seal is bound to the source-ledger step's merged artifact hash", async () => {
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_CHUNK_MAX_BLOCKS: "100",
    EXTRACT_CHUNK_CHARS: "90000",
    EXTRACT_PASS_B_MAX_WAVES: "3",
  });
  const provider = stubProvider();
  try {
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { REPO_ROOT } = await import("../testkit.mjs");
    const documentBytes = readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx"));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    const documentKey = m.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, documentBytes);
    await m.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: "2026-08-09T00:00:00.000Z",
      instanceId: runId,
      input: {
        surveyUrl: "https://fixture.invalid/survey",
        documentKey,
        documentSha256,
        documentName: "questionnaire.docx",
        targetBuildId: null,
        locale: "en",
        viewports: ["desktop"],
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    });

    const inline = fakeStep();
    let replaced = false;
    const step = {
      calls: inline.calls,
      sleeps: inline.sleeps,
      async do(name, a, b) {
        if (name === "seal-contract-revision" && !replaced) {
          const object = await env.EVIDENCE.get(m.extractStage.mergedKey(runId));
          assert(object, "source-ledger must persist merged.json before the seal step starts");
          const replacement = JSON.parse(await object.text());
          assert(replacement.requirements.length > 0, "the real consolidation must produce a requirement to replace");
          const requirementCount = replacement.requirements.length;
          const caseCount = replacement.facetInstances.length;
          replacement.requirements[0].normativeStatement += " [same-count replacement]";
          assertEq(replacement.requirements.length, requirementCount);
          assertEq(replacement.facetInstances.length, caseCount);
          await env.EVIDENCE.put(m.extractStage.mergedKey(runId), JSON.stringify(replacement, null, 2));
          replaced = true;
        }
        return await inline.do(name, a, b);
      },
      async sleep(name, duration) {
        return await inline.sleep(name, duration);
      },
      async sleepUntil(name, timestamp) {
        return await inline.sleepUntil(name, timestamp);
      },
    };

    const workflow = new m.workflow.SurveyRunWorkflowV2({}, env);
    const err = await assertThrows(
      () => workflow.run({
        payload: {
          runId,
          surveyUrl: "https://fixture.invalid/survey",
          documentKey,
          documentSha256,
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      }, step),
      "MERGED_ARTIFACT_HASH_MISMATCH",
    );
    assert(replaced, "the negative control must actually replace merged.json at the seal boundary");
    assertEq(m.workflow.classifyFailure(err), "merged-extraction-hash-mismatch");
    const checkpoint = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assert(checkpoint.contract.state !== "sealed", "the substituted denominator must never seal");
    assertEq(checkpoint.completion.reasonCode, "merged-extraction-hash-mismatch");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("D21 — the workflow makes as many wave steps as the document needs, then names the stop", () => {

test("(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure", async () => {
  // The end-to-end shape. With a zero wave budget every wave buys one chunk, so a real
  // questionnaire needs far more waves than the cap allows — which is the case that used to
  // die as a bare step timeout with a generic `workflow-error` and no report.
  const m = await mod();
  const env = sliceEnv({ EXTRACT_WAVE_BUDGET_MS: "0", EXTRACT_PASS_B_MAX_WAVES: "3", EXTRACT_CHUNK_MAX_BLOCKS: "10", EXTRACT_CHUNK_CHARS: "2000" });
  const provider = stubProvider();
  try {
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { REPO_ROOT } = await import("../testkit.mjs");
    const documentKey = m.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx")));
    await m.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: "2026-08-07T00:00:00.000Z",
      instanceId: runId,
      input: {
        surveyUrl: "https://fixture.invalid/survey",
        documentKey,
        documentSha256: "b".repeat(64),
        documentName: "questionnaire.docx",
        targetBuildId: null,
        locale: "en",
        viewports: ["desktop"],
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    });

    const step = fakeStep();
    const wf = new m.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(
      {
        payload: {
          runId,
          surveyUrl: "https://fixture.invalid/survey",
          documentKey,
          documentSha256: "b".repeat(64),
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      },
      step,
    );

    // ONE STEP PER WAVE, AND THE NAMES PROVE IT. The old code had exactly one
    // `extract-pass-b-blocks` step whose single timeout had to cover the whole fan-out.
    const waveSteps = step.calls.filter((n) => n.startsWith("extract-pass-b-wave-"));
    assertEq(waveSteps.length, 3, `pass B must occupy one step per wave, got ${JSON.stringify(waveSteps)}`);
    assert(new Set(waveSteps).size === 3, "each wave is its OWN checkpointed step, not a retry of one step");
    assert(
      step.calls.includes("stop-extract-pass-b-waves-exhausted"),
      "the exhaustion checkpoint mutation must itself be a durable Workflow step",
    );

    const cp = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    // A NAMED BUDGET REASON — never a `partial-*` over a document that was never read.
    assertEq(cp.completion.reasonCode, "extraction-pass-b-waves-exhausted", "the stop names itself");
    assertEq(cp.completion.test, "failed", "nothing was tested, so this is a failure");
    assert(
      !String(cp.completion.test).startsWith("partial"),
      "a half-read document must never be reported as a partial TEST — nothing was exercised",
    );
    assertEq(cp.contract.state, "unavailable", "and no contract was sealed over half a read");
    assert(
      /chunk\(s\)/.test(String(cp.error)) && /EXTRACT_PASS_B_MAX_WAVES/.test(String(cp.error)),
      `the error must say how much work is owed and which knob governs it, got: ${cp.error}`,
    );
    // AND IT STILL REPORTS. The old failure path rethrew out of `record-failure` without
    // reaching the report at all.
    const reporting = cp.phases.find((p) => p.name === "reporting");
    assert(reporting && reporting.state !== "not-started", "a named stop still falls through to reporting");
  } finally {
    provider.restore();
  }
});

});
