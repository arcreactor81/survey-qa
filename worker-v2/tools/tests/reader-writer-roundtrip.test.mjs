/**
 * READER / WRITER ROUND-TRIP PROPERTY TESTS
 *
 * ROOT CAUSE: validatePassAUnitUsageCoherence required receipt-1 to carry Grok's callId
 * and provider identity (callId=call_a_N, provider=grok, model=grok-4.6). In Gemini-primary
 * (budget) mode, receipt-1 is written with callId=call_a_N:gemini-primary, provider=gemini,
 * model=gemini-2.5-flash. The coherence check rejected every Gemini-primary artifact as
 * "receipt role/call/provider is inconsistent with its settlement identity", the reader
 * returned kind:"invalid", and the reclaim path treated this as a terminal failure --
 * killing the run without re-buying the window.
 *
 * SECONDARY: parseFallbackTrigger required bound.provider === "grok", rejecting a
 * Gemini-primary trigger (provider=gemini). This would have caused an identical failure
 * for Gemini-primary artifacts that carried a fallback trigger.
 *
 * THE PINNED FIXTURE reproduces the real v31 artifact structure from production R2
 * (commit 25429ab, run v2r_01m02ps7vwajrad78vjwarx73s, window A-w1).
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const V31_RUN_ID = "v2r_01m02ps7vwajrad78vjwarx73s";

// Minimal but structurally faithful reproduction of the v31 modelOutput.
// One valid construct ("instruction") + one invalid ("ordering") -> strictPrimaryOutput throws.
const V31_MODEL_OUTPUT = {
  global_rules: [
    {
      id: "GLOB-01", construct: "instruction", scope: "survey", quantifier: "only",
      selector: "survey", exceptions: [],
      statement: "The survey must be a Quantitative MR survey.",
      doc_quote: "Block 6 content. Every question is compulsory.",
      block_ids: ["b0006"],
      evidence_quotes: [{ block_id: "b0006", quote: "Block 6 content. Every question is compulsory." }],
      browser_observable: "none", confidence: 1,
    },
    {
      id: "GLOB-04", construct: "ordering", scope: "survey", quantifier: "every",
      selector: "question and section listed in the Survey Outline", exceptions: [],
      statement: "Questions must be presented in sequential order.",
      doc_quote: "Block 15 content. Every question is compulsory.",
      block_ids: ["b0015"],
      evidence_quotes: [{ block_id: "b0015", quote: "Block 15 content. Every question is compulsory." }],
      browser_observable: "full", confidence: 1,
    },
  ],
  cross_references: [],
  ambiguities: [],
  unverifiable_from_browser: [],
};

// ---------------------------------------------------------------------------
// ENV helpers
// ---------------------------------------------------------------------------

/** Common env base. blocks=50 -> 100-block document = 2 windows (A-w1, A-w2). */
function baseProviderEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MAX_TOTAL_USD: "10",
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
    EXTRACT_PASS_A_WINDOW_CHARS: "90000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "50",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "2",
    ...overrides,
  };
}

function geminiEnv(overrides = {}) {
  return baseProviderEnv({ EXTRACT_PASS_A_PRIMARY: "gemini", ...overrides });
}
function grokEnv(overrides = {}) {
  return baseProviderEnv({ EXTRACT_PASS_A_PRIMARY: "grok", ...overrides });
}

// ---------------------------------------------------------------------------
// Block / doc / artifact helpers
// ---------------------------------------------------------------------------

function sourceBlocks100() {
  return Array.from({ length: 100 }, (_, i) => ({
    blockId: `b${String(i + 1).padStart(4, "0")}`,
    kind: "paragraph",
    text: `Block ${i + 1} content. Every question is compulsory.`,
    origin: "body", section: "Questions", coords: null, tableId: null,
  }));
}

function docFor(blocks, parserVersion) {
  return {
    blocks,
    annotatedText: blocks.map((b) => `[${b.blockId}] ${b.text}`).join("\n"),
    counts: { paragraphs: blocks.length, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
    coverage: {
      archiveParts: 1, partsRead: ["word/document.xml"], partsSkipped: [],
      images: 0, imagesWithAltText: 0, unresolvedFieldCodes: 0, symbolRuns: 0,
      autoNumberedParagraphs: 0, problems: [],
    },
    parserVersion,
  };
}

/** Seed a window artifact into memoryR2 at its canonical key. */
async function seed(m, env, runId, n, artifact) {
  const key = m.keys.k("runs", runId, "extraction", "pass-a",
    `window-${String(n).padStart(2, "0")}.json`);
  const body = typeof artifact === "string" ? artifact : JSON.stringify(artifact, null, 2);
  await env.EVIDENCE.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

function windowBlockIds(windowNumber, maxBlocks = 50) {
  const start = (windowNumber - 1) * maxBlocks + 1;
  return Array.from({ length: maxBlocks }, (_, i) => `b${String(start + i).padStart(4, "0")}`);
}

function policyId(env) {
  return `pass-a-window-policy/1.1.0|chars:${env.EXTRACT_PASS_A_WINDOW_CHARS}|blocks:${env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS}|max-issues:${Math.max(1, Number(env.EXTRACT_PASS_A_WINDOW_MAX_ISSUES))}`;
}

/** Build a failed semantic-output artifact (the v31 shape). */
function failedSemanticArtifact(m, env, { origin, windowNumber, runId = V31_RUN_ID,
    provider = "gemini", callIdSuffix = ":gemini-primary", model = "gemini-2.5-flash" } = {}) {
  return {
    windowId: origin, windowNumber,
    blockIds: windowBlockIds(windowNumber),
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    status: "failed", attempts: 1,
    usages: [{
      eventId: `core-model-call/pass-a/${runId}/${origin}/issue-1/receipt-1`,
      callId: `call_a_${windowNumber}${callIdSuffix}`,
      role: `extract-pass-a-w${windowNumber}`, provider, model,
      status: "parse-failed", inputTokens: 9975, outputTokens: 1686,
      costUsd: 0.007, latencyMs: 41571, attempts: 1,
      usageSource: "provider-reported",
      detail: "semantic output rejected: PASS_A_WINDOW_OUTPUT_INVALID: unknown construct \"ordering\"",
    }],
    fallbackTrigger: null, terminal: false,
    failureStage: "semantic-output",
    detail: "PASS_A_WINDOW_OUTPUT_INVALID: unknown construct \"ordering\"",
    modelOutput: V31_MODEL_OUTPUT,
  };
}

/** Build a successful OK artifact. */
function okArtifact(m, env, { origin, windowNumber, runId = V31_RUN_ID,
    provider = "gemini", callIdSuffix = ":gemini-primary", model = "gemini-2.5-flash",
    selected = "gemini-2.5-flash" } = {}) {
  return {
    windowId: origin, windowNumber,
    blockIds: windowBlockIds(windowNumber),
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    kind: "ok", attempts: 1,
    usages: [{
      eventId: `core-model-call/pass-a/${runId}/${origin}/issue-1/receipt-1`,
      callId: `call_a_${windowNumber}${callIdSuffix}`,
      role: `extract-pass-a-w${windowNumber}`, provider, model,
      status: "ok", inputTokens: 9975, outputTokens: 1686,
      costUsd: 0.007, latencyMs: 41571, attempts: 1,
      usageSource: "provider-reported", detail: null,
    }],
    routeReceipt: { selected, trigger: null },
    globalRules: [], crossRefs: [], ambiguities: [], unverifiable: [],
    primaryGroundingLimitations: [],
    modelOutput: {
      global_rules: [], cross_references: [], ambiguities: [], unverifiable_from_browser: [],
    },
  };
}

/** Reconstruct pass-A authority from seeded artifacts. */
async function reconstruct(m, env, runId, blocks, parserVersion) {
  return m.passA.reconstructPassACompletedAuthority(
    env, runId, docFor(blocks, parserVersion),
  );
}

// ===========================================================================
suite("Reader-writer round-trip — pinned v31 production artifact", () => {

test("REAL v31 failed Gemini-primary artifact round-trips through readWindowArtifact", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const art = failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 });

  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "reconstruction is 'invalid' because the window failed");
  assert(
    result.detail.includes("retains failed authority"),
    `expected 'retains failed authority', got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `reader must NOT reject v31 artifact as corrupt. Got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("receipt role/call/provider"),
    `coherence check must NOT reject Gemini-primary receipts. Got: ${result.detail}`,
  );
});

test("v31 artifact with CORRUPTED usages is still rejected", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const art = failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 });
  art.usages[0].callId = "call_a_99:unknown-provider";

  await seed(m, env, V31_RUN_ID, 1, art);
  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "corrupted artifact produces invalid reconstruction");
  assert(
    result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `corrupted usages must be caught. Got: ${result.detail}`,
  );
});

});

// ===========================================================================
suite("Reader-writer round-trip — every writer-producible variant", () => {

test("ok artifact (Gemini-primary) round-trips", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  // Seed BOTH windows as OK (2 windows = multiwindow, but synthesis is not seeded
  // so reconstruction will fail on "synthesis missing", which is expected).
  // We test window-level round-trip by seeding both and checking reconstruction
  // fails at synthesis, not at any window.
  await seed(m, env, V31_RUN_ID, 1, okArtifact(m, env, { origin: "A-w1", windowNumber: 1 }));
  await seed(m, env, V31_RUN_ID, 2, okArtifact(m, env, { origin: "A-w2", windowNumber: 2 }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  // Both windows read OK, reconstruction fails at synthesis (expected for multiwindow).
  assertEq(result.kind, "invalid", "multiwindow without synthesis = invalid");
  assert(
    result.detail.includes("synthesis"),
    `both windows read OK, failure is at synthesis. Got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `no window was rejected as corrupt. Got: ${result.detail}`,
  );
});

test("ok artifact (Grok-primary) round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  await seed(m, env, V31_RUN_ID, 1, okArtifact(m, env, {
    origin: "A-w1", windowNumber: 1,
    provider: "grok", callIdSuffix: "", model: "grok-4.6", selected: "grok-4.6",
  }));
  await seed(m, env, V31_RUN_ID, 2, okArtifact(m, env, {
    origin: "A-w2", windowNumber: 2,
    provider: "grok", callIdSuffix: "", model: "grok-4.6", selected: "grok-4.6",
  }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "multiwindow without synthesis = invalid");
  assert(
    result.detail.includes("synthesis"),
    `Grok windows read OK, failure at synthesis. Got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `no window was rejected as corrupt. Got: ${result.detail}`,
  );
});

test("failed-retryable semantic-output (Gemini-primary, terminal:false) round-trips as 'failed'", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  await seed(m, env, V31_RUN_ID, 1,
    failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed window -> invalid reconstruction");
  assert(result.detail.includes("retains failed authority"),
    `retryable failed artifact accepted. Got: ${result.detail}`);
});

test("failed-terminal provider failure (Gemini-primary + DeepSeek fallback) round-trips", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const r1 = `core-model-call/pass-a/${V31_RUN_ID}/A-w1/issue-1/receipt-1`;
  const r2 = `core-model-call/pass-a/${V31_RUN_ID}/A-w1/issue-1/receipt-2`;

  const art = {
    windowId: "A-w1", windowNumber: 1,
    blockIds: windowBlockIds(1),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    status: "failed", attempts: 1,
    usages: [
      { eventId: r1, callId: "call_a_1:gemini-primary", role: "extract-pass-a-w1",
        provider: "gemini", model: "gemini-2.5-flash", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 5000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "gemini-primary failed: 500" },
      { eventId: r2, callId: "call_a_1:grok-fallback", role: "extract-pass-a-w1",
        provider: "deepseek", model: "deepseek-v4-flash", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 3000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "deepseek fallback failed: 503" },
    ],
    fallbackTrigger: {
      kind: "grok-flash-fallback-trigger/1.0.0", failureKind: "timeout-or-network",
      httpStatus: 500, grokModel: "grok-4.6", grokUsageEventId: r1,
      detail: "gemini-primary failed: 500",
    },
    terminal: true, failureStage: "provider",
    detail: "deepseek fallback failed: 503", modelOutput: null,
  };
  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed terminal -> invalid");
  assert(result.detail.includes("retains failed authority"),
    `terminal failed artifact accepted. Got: ${result.detail}`);
  assert(!result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `not rejected as corrupt. Got: ${result.detail}`);
});

test("failed semantic-output (Grok-primary) round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  await seed(m, env, V31_RUN_ID, 1,
    failedSemanticArtifact(m, env, {
      origin: "A-w1", windowNumber: 1,
      provider: "grok", callIdSuffix: "", model: "grok-4.6",
    }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed window -> invalid");
  assert(result.detail.includes("retains failed authority"),
    `Grok-mode failed artifact accepted. Got: ${result.detail}`);
});

test("wire-ceiling zero-receipt artifact round-trips", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  const art = {
    windowId: "A-w1", windowNumber: 1,
    blockIds: windowBlockIds(1),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    status: "failed", attempts: 0, usages: [],
    fallbackTrigger: null, terminal: true, failureStage: "wire-ceiling",
    detail: `${m.extractionWire.EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}: wire ceiling exceeded`,
  };
  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "wire-ceiling -> invalid");
  assert(result.detail.includes("retains failed authority"),
    `wire-ceiling artifact accepted. Got: ${result.detail}`);
});

test("stale-identity artifact returns null (cache miss), not invalid", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  const art = failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 });
  art.promptVersion = "v2-extract-pass-a/0.0.0-stale";
  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "stale -> reconstruction invalid (missing window)");
  assert(result.detail.includes("missing") || result.detail.includes("stale"),
    `stale artifact treated as absent. Got: ${result.detail}`);
});

test("corrupted blockIds artifact is rejected as invalid", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  const art = failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 });
  art.blockIds = ["b9999"];
  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "corrupted blockIds -> invalid");
  assert(result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `corrupted blockIds caught. Got: ${result.detail}`);
});

});

// ===========================================================================
suite("Reader-writer round-trip — parseFallbackTrigger Gemini-primary", () => {

test("fallback trigger from Gemini-primary failure is accepted", async () => {
  const m = await mod();
  const env = geminiEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const r1 = `core-model-call/pass-a/${V31_RUN_ID}/A-w1/issue-1/receipt-1`;
  const r2 = `core-model-call/pass-a/${V31_RUN_ID}/A-w1/issue-1/receipt-2`;

  const art = {
    windowId: "A-w1", windowNumber: 1,
    blockIds: windowBlockIds(1),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    status: "failed", attempts: 1,
    usages: [
      { eventId: r1, callId: "call_a_1:gemini-primary", role: "extract-pass-a-w1",
        provider: "gemini", model: "gemini-2.5-flash", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 5000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "gemini-primary failed: rate-limited" },
      { eventId: r2, callId: "call_a_1:grok-fallback", role: "extract-pass-a-w1",
        provider: "deepseek", model: "deepseek-v4-flash", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 3000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "deepseek fallback failed: 503" },
    ],
    fallbackTrigger: {
      kind: "grok-flash-fallback-trigger/1.0.0", failureKind: "rate-limited",
      httpStatus: 429, grokModel: "grok-4.6", grokUsageEventId: r1,
      detail: "gemini-primary failed: rate-limited",
    },
    terminal: true, failureStage: "provider",
    detail: "deepseek fallback failed: 503", modelOutput: null,
  };
  await seed(m, env, V31_RUN_ID, 1, art);

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed window -> invalid");
  assert(result.detail.includes("retains failed authority"),
    `Gemini fallback trigger accepted. Got: ${result.detail}`);
  assert(!result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `must not reject as corrupt. Got: ${result.detail}`);
});

});
