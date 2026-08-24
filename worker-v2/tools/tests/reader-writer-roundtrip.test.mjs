/**
 * READER / WRITER ROUND-TRIP PROPERTY TESTS
 *
 * ROOT CAUSE: validatePassAUnitUsageCoherence must accept the provider identities that the
 * writer actually produces. A coherence check that silently rejects a valid artifact shape
 * would cause the reader to return kind:"invalid", and the reclaim path would treat this as a
 * terminal failure -- killing the run without re-buying the window.
 *
 * THE PINNED FIXTURE reproduces real artifact structure (v31 R2 shape) relabelled to grok-4.5.
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
    GROK_MODEL: "grok-4.5",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-console-confirmation",
    GROK_RATE_ATTESTED_MODEL: "grok-4.5",
    GROK_RATE_ATTESTED_AT: "2026-08-15",
    GROK_RATE_RECEIPT_SHA256: "9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.3",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0.6",
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

function grokEnv(overrides = {}) {
  return baseProviderEnv(overrides);
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

/** Build a failed semantic-output artifact (relabelled to grok-4.5). */
function failedSemanticArtifact(m, env, { origin, windowNumber, runId = V31_RUN_ID,
    provider = "grok", callIdSuffix = "", model = "grok-4.5" } = {}) {
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
    provider = "grok", callIdSuffix = "", model = "grok-4.5",
    selected = "grok-4.5" } = {}) {
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

test("REAL v31 failed artifact round-trips through readWindowArtifact", async () => {
  const m = await mod();
  const env = grokEnv();
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
    `reader must NOT reject artifact as corrupt. Got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("receipt role/call/provider"),
    `coherence check must NOT reject receipts. Got: ${result.detail}`,
  );
});

test("v31 artifact with CORRUPTED usages is still rejected", async () => {
  const m = await mod();
  const env = grokEnv();
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

test("ok artifact (Grok-primary) round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  await seed(m, env, V31_RUN_ID, 1, okArtifact(m, env, { origin: "A-w1", windowNumber: 1 }));
  await seed(m, env, V31_RUN_ID, 2, okArtifact(m, env, { origin: "A-w2", windowNumber: 2 }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "multiwindow without synthesis = invalid");
  assert(
    result.detail.includes("synthesis"),
    `both windows read OK, failure at synthesis. Got: ${result.detail}`,
  );
  assert(
    !result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `no window was rejected as corrupt. Got: ${result.detail}`,
  );
});

test("failed-retryable semantic-output (terminal:false) round-trips as 'failed'", async () => {
  const m = await mod();
  const env = grokEnv();
  const blocks = sourceBlocks100();
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;

  await seed(m, env, V31_RUN_ID, 1,
    failedSemanticArtifact(m, env, { origin: "A-w1", windowNumber: 1 }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed window -> invalid reconstruction");
  assert(result.detail.includes("retains failed authority"),
    `retryable failed artifact accepted. Got: ${result.detail}`);
});

test("failed-terminal provider failure (Grok + DeepSeek fallback) round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
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
      { eventId: r1, callId: "call_a_1", role: "extract-pass-a-w1",
        provider: "grok", model: "grok-4.5", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 5000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "grok failed: 500" },
      { eventId: r2, callId: "call_a_1:grok-fallback", role: "extract-pass-a-w1",
        provider: "deepseek", model: "deepseek-v4-flash", status: "error",
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 3000,
        attempts: 1, usageSource: "conservative-ceiling",
        detail: "deepseek fallback failed: 503" },
    ],
    fallbackTrigger: {
      kind: "grok-flash-fallback-trigger/1.0.0", failureKind: "timeout-or-network",
      httpStatus: 500, grokModel: "grok-4.5", grokUsageEventId: r1,
      detail: "grok failed: 500",
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
      provider: "grok", callIdSuffix: "", model: "grok-4.5",
    }));

  const result = await reconstruct(m, env, V31_RUN_ID, blocks, pv);
  assertEq(result.kind, "invalid", "failed window -> invalid");
  assert(result.detail.includes("retains failed authority"),
    `Grok-mode failed artifact accepted. Got: ${result.detail}`);
});

test("wire-ceiling zero-receipt artifact round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
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
  const env = grokEnv();
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
  const env = grokEnv();
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
suite("Reader-writer round-trip — degraded artifact with item-level limitations", () => {

/**
 * Exercises the REAL degradation write path (degradedPrimaryOutput) and verifies the
 * persisted artifact round-trips through the strict reader (readWindowArtifact) on
 * reclaim. This is the mechanism that w5/w8 real outputs exercise: structural-validation-
 * failed rows are removed from the stored modelOutput but their limitations survive re-read.
 */

test("degraded artifact with structural-validation-failed limitations round-trips through readWindowArtifact", async () => {
  const m = await mod();
  const env = grokEnv();
  // Use a focused two-block source with one valid + one invalid-construct rule.
  // Single-window doc: origin is "A" (not "A-w1").
  const source = [
    { blockId: "b0001", kind: "paragraph", text: "Block 1 content. Every question is compulsory.",
      origin: "body", section: "Questions", coords: null, tableId: null },
    { blockId: "b0002", kind: "paragraph", text: "Block 2 content. Every question is compulsory.",
      origin: "body", section: "Questions", coords: null, tableId: null },
  ];
  const origin = "A";
  // Model output with one valid rule and one invalid construct ("ordering")
  const rawModelOutput = {
    global_rules: [
      {
        id: "GLOB-01", construct: "instruction", scope: "survey", quantifier: "every",
        selector: null, exceptions: [],
        statement: "Every question must be answered.",
        doc_quote: "Block 1 content. Every question is compulsory.",
        block_ids: ["b0001"],
        evidence_quotes: [{ block_id: "b0001", quote: "Block 1 content. Every question is compulsory." }],
        browser_observable: "full", confidence: 0.95,
      },
      {
        id: "GLOB-02", construct: "ordering", scope: "survey", quantifier: "every",
        selector: null, exceptions: [],
        statement: "Questions must follow document order.",
        doc_quote: "Block 2 content. Every question is compulsory.",
        block_ids: ["b0002"],
        evidence_quotes: [{ block_id: "b0002", quote: "Block 2 content. Every question is compulsory." }],
        browser_observable: "full", confidence: 0.9,
      },
    ],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };

  // Verify strict validation throws (precondition)
  let strictThrew = false;
  try { m.passA.__test_strictPrimaryOutput(rawModelOutput, origin); } catch { strictThrew = true; }
  assert(strictThrew, "strict validation must throw on 'ordering' construct");

  // Degrade: salvage the valid rule, exclude the invalid one
  const degraded = m.passA.degradedPrimaryOutput(rawModelOutput, source, origin);
  assert(degraded !== null, "degradation must salvage the valid rule");
  assert(degraded.limitations.length >= 1, "at least one limitation");
  assert(degraded.limitations.some(l => l.reason === "structural-validation-failed"),
    "structural-validation-failed limitation must exist");

  // Build the degraded artifact as the writer would. The artifact carries TWO usage entries
  // (one per attempt) because attempts=2 requires receipts for issue 1 and issue 2.
  // Single-window doc uses role "extract-pass-a" and callId "call_a_1".
  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const runId = "run_degraded_roundtrip_test";
  const r1 = `core-model-call/pass-a/${runId}/${origin}/issue-1/receipt-1`;
  const r2 = `core-model-call/pass-a/${runId}/${origin}/issue-2/receipt-1`;
  const artifact = {
    windowId: origin, windowNumber: 1,
    blockIds: source.map(b => b.blockId),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    kind: "ok", attempts: 2,
    modelOutput: degraded.strictPassingModelOutput,
    rawModelOutputPreDegradation: rawModelOutput,
    ...degraded.unit,
    usages: [
      {
        eventId: r1, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "parse-failed",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "semantic output rejected: PASS_A_WINDOW_OUTPUT_INVALID: unknown construct \"ordering\"",
      },
      {
        eventId: r2, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "ok",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "degraded: 1 of 2 items excluded",
      },
    ],
    routeReceipt: { selected: "grok-4.5", trigger: null },
  };

  // Seed as a single-window document (blocks = source only)
  await seed(m, env, runId, 1, artifact);
  const singleWindowBlocks = source;
  const result = await reconstruct(m, env, runId, singleWindowBlocks, pv);
  // Single window, no synthesis needed -> should be "ok" if the reader accepts the artifact
  assertEq(result.kind, "ok",
    `degraded artifact must round-trip. Got: ${result.kind}: ${result.detail ?? ""}`);
  assert(!result.detail?.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `no corruption detected. Got: ${result.detail ?? "(none)"}`);
  // The surviving limitation must be present in the reconstructed authority
  assert(result.value.primaryGroundingLimitations.length >= 1,
    "limitations must survive round-trip");
  assert(result.value.primaryGroundingLimitations.some(l => l.reason === "structural-validation-failed"),
    "structural-validation-failed must survive round-trip");
});

test("degraded artifact with root-malformed + structural-validation-failed round-trips", async () => {
  const m = await mod();
  const env = grokEnv();
  const source = [
    { blockId: "b0001", kind: "paragraph", text: "Block 1 content. Every question is compulsory.",
      origin: "body", section: "Questions", coords: null, tableId: null },
  ];
  const origin = "A";
  // Model output with one valid rule but cross_references is a STRING (root-malformed)
  const rawModelOutput = {
    global_rules: [{
      id: "GLOB-01", construct: "instruction", scope: "survey", quantifier: "every",
      selector: null, exceptions: [],
      statement: "Every question must be answered.",
      doc_quote: "Block 1 content. Every question is compulsory.",
      block_ids: ["b0001"],
      evidence_quotes: [{ block_id: "b0001", quote: "Block 1 content. Every question is compulsory." }],
      browser_observable: "full", confidence: 0.95,
    }],
    cross_references: "not-an-array",
    ambiguities: [],
    unverifiable_from_browser: [],
  };

  const degraded = m.passA.degradedPrimaryOutput(rawModelOutput, source, origin);
  assert(degraded !== null, "degradation must salvage with root-malformed");
  assert(degraded.limitations.some(l => l.reason === "root-malformed"),
    "root-malformed limitation must exist");

  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const runId = "run_root_malformed_roundtrip";
  const r1 = `core-model-call/pass-a/${runId}/${origin}/issue-1/receipt-1`;
  const r2 = `core-model-call/pass-a/${runId}/${origin}/issue-2/receipt-1`;
  const artifact = {
    windowId: origin, windowNumber: 1,
    blockIds: source.map(b => b.blockId),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    kind: "ok", attempts: 2,
    modelOutput: degraded.strictPassingModelOutput,
    rawModelOutputPreDegradation: rawModelOutput,
    ...degraded.unit,
    usages: [
      {
        eventId: r1, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "parse-failed",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "semantic output rejected",
      },
      {
        eventId: r2, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "ok",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "degraded: 1 of 2 items excluded",
      },
    ],
    routeReceipt: { selected: "grok-4.5", trigger: null },
  };

  await seed(m, env, runId, 1, artifact);
  const result = await reconstruct(m, env, runId, source, pv);
  assertEq(result.kind, "ok",
    `root-malformed degraded artifact must round-trip. Got: ${result.kind}: ${result.detail ?? ""}`);
  assert(result.value.primaryGroundingLimitations.some(l => l.reason === "root-malformed"),
    "root-malformed must survive round-trip");
});

test("TAMPERING: modifying modelOutput of degraded artifact is still rejected", async () => {
  const m = await mod();
  const env = grokEnv();
  const source = [
    { blockId: "b0001", kind: "paragraph", text: "Block 1 content. Every question is compulsory.",
      origin: "body", section: "Questions", coords: null, tableId: null },
    { blockId: "b0002", kind: "paragraph", text: "Block 2 content. Every question is compulsory.",
      origin: "body", section: "Questions", coords: null, tableId: null },
  ];
  const origin = "A";
  const rawModelOutput = {
    global_rules: [
      {
        id: "GLOB-01", construct: "instruction", scope: "survey", quantifier: "every",
        selector: null, exceptions: [],
        statement: "Every question must be answered.",
        doc_quote: "Block 1 content. Every question is compulsory.",
        block_ids: ["b0001"],
        evidence_quotes: [{ block_id: "b0001", quote: "Block 1 content. Every question is compulsory." }],
        browser_observable: "full", confidence: 0.95,
      },
      {
        id: "GLOB-02", construct: "ordering", scope: "survey", quantifier: "every",
        selector: null, exceptions: [],
        statement: "Questions must follow document order.",
        doc_quote: "Block 2 content. Every question is compulsory.",
        block_ids: ["b0002"],
        evidence_quotes: [{ block_id: "b0002", quote: "Block 2 content. Every question is compulsory." }],
        browser_observable: "full", confidence: 0.9,
      },
    ],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };

  const degraded = m.passA.degradedPrimaryOutput(rawModelOutput, source, origin);
  assert(degraded !== null, "precondition");

  const pv = m.docxBlocks.DOCX_BLOCKS_VERSION;
  const runId = "run_tampered_degraded";
  const r1 = `core-model-call/pass-a/${runId}/${origin}/issue-1/receipt-1`;
  const r2 = `core-model-call/pass-a/${runId}/${origin}/issue-2/receipt-1`;
  const artifact = {
    windowId: origin, windowNumber: 1,
    blockIds: source.map(b => b.blockId),
    parserVersion: pv, promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.passA.passAPrimaryRouteIdentity(env),
    windowPolicyIdentity: policyId(env),
    kind: "ok", attempts: 2,
    modelOutput: degraded.strictPassingModelOutput,
    rawModelOutputPreDegradation: rawModelOutput,
    ...degraded.unit,
    usages: [
      {
        eventId: r1, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "parse-failed",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "semantic output rejected",
      },
      {
        eventId: r2, callId: "call_a_1", role: "extract-pass-a",
        provider: "grok", model: "grok-4.5", status: "ok",
        inputTokens: 9000, outputTokens: 1200, costUsd: 0.006, latencyMs: 30000,
        attempts: 1, usageSource: "provider-reported",
        detail: "degraded: 1 of 2 items excluded",
      },
    ],
    routeReceipt: { selected: "grok-4.5", trigger: null },
  };

  // TAMPER: modify the surviving rule's id in globalRules to simulate content injection.
  artifact.globalRules = [{
    ...artifact.globalRules[0],
    id: "INJECTED-FAKE",
    statement: "Fabricated rule injected by tampering.",
  }];

  await seed(m, env, runId, 1, artifact);
  const result = await reconstruct(m, env, runId, source, pv);
  assertEq(result.kind, "invalid", "tampered degraded artifact must be rejected");
  assert(
    result.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID"),
    `tampering must be caught. Got: ${result.detail}`,
  );
});

});
