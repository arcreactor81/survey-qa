/** Provider-neutral extraction request-wire ceiling with fail-capable I/O tripwires. */
import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;
const REASON = "extraction-model-input-wire-ceiling-exceeded";
const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation", "piping",
  "carry-forward", "calculation", "randomization", "loop", "instruction",
];

function countedSecret(value) {
  let reads = 0;
  return { binding: { async get() { reads += 1; return value; } }, reads: () => reads };
}

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(), V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account", CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key", DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_FALLBACK_MODE: "disabled", DEEPSEEK_CONTEXT_WINDOW_TOKENS: "1000000",
    GROK_MODEL: "grok-4.6", GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0", GROK_RATE_SOURCE: "owner-dashboard-copy",
    GROK_RATE_ATTESTED_MODEL: "grok-4.6", GROK_RATE_ATTESTED_AT: "2026-08-13",
    GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
    GROK_CONTEXT_WINDOW_TOKENS: "500000", GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.5", GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000", GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1", GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4", GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_MODEL_INPUT_MAX_BYTES: "450000", EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    EXTRACT_MAX_ATTEMPTS: "1", EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_CHUNK_MAX_ISSUES: "2", EXTRACT_CHUNK_CONCURRENCY: "2",
    EXTRACT_CONTEXT_CHARS: "1", EXTRACT_SWEEP_MAX_CALLS: "0",
    ...overrides,
  };
}

function block(blockId, text, overrides = {}) {
  return {
    blockId, kind: "paragraph", text, origin: "body", sourceSubrole: null,
    section: null, coords: null, tableId: null,
    formatting: { runs: [], paragraphBackground: null, cellBackground: null,
      roleBoundarySplit: false, unresolvedBackground: [] }, semanticSpans: [], ...overrides,
  };
}

function documentFor(blocks) {
  return {
    blocks, annotatedText: blocks.map((row) => `[${row.blockId}] ${row.text}`).join("\n"),
    counts: { paragraphs: blocks.filter((row) => row.kind === "paragraph").length,
      tableCells: blocks.filter((row) => row.kind === "table-cell").length, footnotes: 0,
      headings: blocks.filter((row) => row.kind === "heading").length, listItems: 0 },
    coverage: { archiveParts: 1, partsRead: ["word/document.xml"], partsSkipped: [], images: 0,
      imagesWithAltText: 0, unresolvedFieldCodes: 0, symbolRuns: 0,
      autoNumberedParagraphs: 0, problems: [] },
  };
}

const emptyPrimary = () => ({
  global_rules: [], cross_references: [], ambiguities: [], unverifiable_from_browser: [],
});

function providerResponse(body, value, status = 200) {
  if (status !== 200) return new Response("provider unavailable", { status });
  return new Response(JSON.stringify({
    model: body.model, usage: { prompt_tokens: 100, completion_tokens: 20 },
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function passBPayload(unit, sourceBlocks, cite = false) {
  const obligations = cite ? sourceBlocks.map((row, index) => ({
    id: `${unit}-R${index + 1}`, construct: "question", scope: `question:${row.blockId}`,
    quantifier: "every", selector: row.blockId, exceptions: [],
    statement: "The documented question must be asked.", doc_quote: row.text,
    block_ids: [row.blockId], evidence_quotes: [{ block_id: row.blockId, quote: row.text }],
    browser_observable: "full", confidence: 0.9, expansion: null,
  })) : [];
  return {
    chunk_id: unit, obligations,
    block_dispositions: sourceBlocks.map((row) => ({ block_id: row.blockId,
      disposition: "normative", reason: "The block states a survey behavior." })),
    construct_checklist: CONSTRUCTS.map((construct) => ({ construct,
      present: cite && construct === "question",
      block_ids: cite && construct === "question" ? sourceBlocks.map((row) => row.blockId) : [] })),
    ambiguities: [], unverifiable_from_browser: [],
  };
}

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  assert(object !== null, `expected artifact ${key}`);
  return JSON.parse(await object.text());
}

suite("MODEL INPUT WIRE CEILING - exact, zero-purchase, durable", () => {

test("policy pins the reviewed 450k + 32k envelope and exact UTF-8 boundaries", async () => {
  const m = await mod();
  const env = envFor();
  const policy = m.extractionWire.extractionWirePolicy(env);
  assertEq(policy.maxInputBytes, 450000);
  assertEq(policy.maxOutputTokens, 32000);
  assertEq(policy.deepseekContextWindowTokens, 1000000);
  assertEq(policy.smallestContextWindowTokens, 500000);
  const hostile = "ascii" + String.fromCharCode(92, 34, 0x03a9, 0xd83d, 0xde00, 0xd800, 0xdc00);
  assertEq(m.extractionWire.utf8ByteLength(hostile), new TextEncoder().encode(hostile).byteLength);
  const exact = "x".repeat(450000);
  assertEq(m.extractionWire.preflightExtractionRequestBodies(env, [{ route: "control", bodyText: exact }]).ok, true);
  const refused = m.extractionWire.preflightExtractionRequestBodies(env, [{ route: "control", bodyText: exact + "x" }]);
  assertEq(refused.ok, false);
  assertEq(refused.reasonCode, REASON);
  for (const overrides of [
    { EXTRACT_MODEL_INPUT_MAX_BYTES: "450001" },
    { EXTRACT_MAX_OUTPUT_TOKENS: "32001" },
    { DEEPSEEK_CONTEXT_WINDOW_TOKENS: "999999" },
    { GROK_CONTEXT_WINDOW_TOKENS: "482000" },
  ]) {
    let thrown = null;
    try { m.extractionWire.extractionWirePolicy(envFor(overrides)); } catch (error) { thrown = error; }
    assert(thrown instanceof Error, `unsafe policy ${JSON.stringify(overrides)} was accepted`);
  }
  const lower = m.extractionWire.extractionWirePolicy(envFor({
    EXTRACT_MODEL_INPUT_MAX_BYTES: "449999", EXTRACT_MAX_OUTPUT_TOKENS: "31999",
  }));
  assertEq(lower.maxInputBytes, 449999);
  assertEq(lower.maxOutputTokens, 31999);
  const oneTokenHeadroom = m.extractionWire.extractionWirePolicy(envFor({
    GROK_CONTEXT_WINDOW_TOKENS: "482001",
  }));
  assertEq(oneTokenHeadroom.smallestContextWindowTokens, 482001);
});

test("ordinary chat transport sends the exact admitted serialized body", async () => {
  const m = await mod();
  const env = envFor();
  const spec = {
    provider: "grok",
    model: "grok-4.6",
    gatewaySuffix: "/v1",
    directBaseUrl: "https://unused.invalid",
    apiKey: "fixture-key",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 1,
    extraBody: { reasoning_effort: "high" },
  };
  const options = {
    system: "system with " + String.fromCharCode(92, 34, 0x03a9),
    user: "user with " + String.fromCharCode(0xd83d, 0xde00),
    maxTokens: 32,
    role: "exact-ordinary-transport",
    callId: "call_exact_ordinary",
    maxAttempts: 1,
  };
  const admittedBody = m.chat.chatRequestBodyText(spec, options);
  assertEq(m.extractionWire.preflightExtractionRequestBodies(
    env, [{ route: "ordinary-control", bodyText: admittedBody }],
  ).ok, true);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assertEq(init.body, admittedBody,
      "ordinary transport changed the exact body after wire admission");
    return providerResponse(JSON.parse(init.body), { accepted: true });
  };
  try {
    const outcome = await m.chat.chatJson(spec, env, options);
    assertEq(outcome.value.accepted, true);
    assertEq(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preSerialized chat transport sends the exact admitted body", async () => {
  const m = await mod();
  const env = envFor();
  const spec = {
    provider: "deepseek",
    model: "deepseek-v4",
    gatewaySuffix: "",
    directBaseUrl: "https://unused.invalid",
    apiKey: "fixture-key",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 1,
    extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  };
  const options = {
    system: "system",
    user: "this value must not be reserialized",
    maxTokens: 32,
    role: "exact-pre-serialized-transport",
    callId: "call_exact_pre_serialized",
    maxAttempts: 1,
  };
  const admittedBody = JSON.stringify({
    model: spec.model,
    response_format: { type: "json_object" },
    max_tokens: options.maxTokens,
    ...spec.extraBody,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
    exact_pre_serialized_sentinel: String.fromCharCode(92, 34, 0x03a9),
  });
  assert(admittedBody !== m.chat.chatRequestBodyText(spec, options),
    "preSerialized control must be distinguishable from transport reserialization");
  assertEq(m.extractionWire.preflightExtractionRequestBodies(
    env, [{ route: "pre-serialized-control", bodyText: admittedBody }],
  ).ok, true);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assertEq(init.body, admittedBody,
      "preSerialized transport changed the exact body after wire admission");
    return providerResponse(JSON.parse(init.body), { accepted: true });
  };
  try {
    const outcome = await m.chat.chatJson(
      spec, env, { ...options, preSerializedBodyText: admittedBody },
    );
    assertEq(outcome.value.accepted, true);
    assertEq(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pass-A primary gates the larger Flash body when the Grok body alone fits", async () => {
  const m = await mod();
  const doc = documentFor([block("b0001", "ordinary route-differential source")]);
  const baseEnv = envFor();
  const optionsForCall = {
    system: m.prompts.SYSTEM_A,
    user: m.prompts.userMessageA(
      "neutral.docx",
      m.docxBlocks.encodeSourceBlocksJsonl(doc.blocks),
      null,
    ),
    maxTokens: 32000,
    role: "extract-pass-a",
    callId: "call_a_1",
    maxAttempts: 1,
  };
  const grokBody = m.chat.chatRequestBodyText(m.grok.grokRequestShape(baseEnv), optionsForCall);
  const flashBody = m.chat.chatRequestBodyText(
    m.deepseek.deepseekGrokFallbackRequestShape(baseEnv),
    optionsForCall,
  );
  const grokBytes = m.extractionWire.utf8ByteLength(grokBody);
  const flashBytes = m.extractionWire.utf8ByteLength(flashBody);
  assert(flashBytes > grokBytes,
    `route differential vanished: grok=${grokBytes}, flash=${flashBytes}`);
  const between = Math.floor((grokBytes + flashBytes) / 2);
  const grokSecret = countedSecret("grok-secret");
  const deepseekSecret = countedSecret("deepseek-secret");
  const env = envFor({
    XAI_API_KEY: grokSecret.binding,
    DEEPSEEK_API_KEY: deepseekSecret.binding,
    EXTRACT_MODEL_INPUT_MAX_BYTES: String(between),
  });
  assertEq(m.extractionWire.preflightExtractionRequestBodies(
    env, [{ route: "grok-4.6", bodyText: grokBody }],
  ).ok, true);
  const flashOnly = m.extractionWire.preflightExtractionRequestBodies(
    env, [{ route: "deepseek-v4-flash", bodyText: flashBody }],
  );
  assertEq(flashOnly.ok, false);
  assertEq(flashOnly.reasonCode, REASON);

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("primary larger-route omission reached provider");
  };
  try {
    const runId = "run_wire_a_primary_route_differential";
    const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assertEq(providerCalls, 0);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    const artifact = await readJson(env.EVIDENCE, m.keys.k(
      "runs", runId, "extraction", "pass-a", "window-01.json",
    ));
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);
    assert(artifact.detail.includes("deepseek-v4-flash"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("late Pass-A overflow blocks A-w1 before secrets and replay remains zero-call", async () => {
  const m = await mod();
  const grokSecret = countedSecret("grok-secret");
  const deepseekSecret = countedSecret("deepseek-secret");
  const env = envFor({
    XAI_API_KEY: grokSecret.binding,
    DEEPSEEK_API_KEY: deepseekSecret.binding,
    EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
  });
  const doc = documentFor([
    block("b0001", "ordinary control window"),
    block("b0002", "heading" + String.fromCharCode(92, 34) +
      String.fromCharCode(0x03a9).repeat(40000) + "x".repeat(80000), {
      kind: "heading", section: "repeated section " + "s".repeat(40000),
    }),
  ]);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("wire bypass reached provider");
  };
  try {
    const runId = "run_wire_a_late";
    const first = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(first.terminalReasonCode, REASON);
    assertEq(providerCalls, 0);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json"),
    ), null);
    const key = m.keys.k("runs", runId, "extraction", "pass-a", "window-02.json");
    const before = await (await env.EVIDENCE.get(key)).text();
    const artifact = JSON.parse(before);
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(artifact.failureStage, "wire-ceiling");
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);
    assertEq(JSON.stringify(artifact.blockIds), JSON.stringify(["b0002"]));
    assert(artifact.detail.startsWith(`${REASON}:`));

    const replay = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(replay.terminalReasonCode, REASON);
    assertEq(providerCalls, 0, "retained late refusal must block earlier missing A-w1");
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(key)).text(), before);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-a", "window-02-wire-ceiling.json"),
    ), null, "an attempts-zero main refusal never gains a conflicting sidecar");
    const raisedCapReplay = await m.passA.runPassA(
      { ...env, EXTRACT_MODEL_INPUT_MAX_BYTES: "450000" }, runId, doc, "neutral.docx",
    );
    assertEq(raisedCapReplay.terminalReasonCode, REASON);
    assertEq(providerCalls, 0, "retained authority survives a later cap that now admits the body");
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json"),
    ), null, "raised-cap replay still cannot buy earlier missing A-w1");

    let admittedControlCalls = 0;
    globalThis.fetch = async (_url, init) => {
      admittedControlCalls += 1;
      const body = JSON.parse(init.body);
      return providerResponse(body, emptyPrimary());
    };
    const admittedControl = await m.passA.runPassA(
      { ...envFor({ EXTRACT_MODEL_INPUT_MAX_BYTES: "450000" }), EVIDENCE: memoryR2() },
      "run_wire_a_raised_cap_control",
      documentFor([doc.blocks[1]]),
      "neutral.docx",
    );
    assertEq(admittedControlCalls, 1, "the same oversized-at-100k source is admitted under reviewed 450k");
    assertEq(admittedControl.slice.terminalFailure, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("historical Pass-A census accepts only the canonical zero-receipt wire shape", async () => {
  const m = await mod();
  const grokSecret = countedSecret("grok-secret");
  const deepseekSecret = countedSecret("deepseek-secret");
  const env = envFor({
    XAI_API_KEY: grokSecret.binding,
    DEEPSEEK_API_KEY: deepseekSecret.binding,
    EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
  });
  const doc = documentFor([block("b0001", "x".repeat(120000))]);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("historical wire-shape bypass reached provider");
  };
  try {
    const runId = "run_wire_a_historical_shape";
    const refusal = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(refusal.terminalReasonCode, REASON);
    const key = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const current = await readJson(env.EVIDENCE, key);
    const stalePrompt = current.promptVersion === "v2-extract-pass-a/0.0.1"
      ? "v2-extract-pass-a/0.0.2"
      : "v2-extract-pass-a/0.0.1";
    const canonicalHistorical = { ...current, promptVersion: stalePrompt };
    await env.EVIDENCE.put(key, JSON.stringify(canonicalHistorical));
    const accepted = await m.passA.reconstructPassAHistoricalProgressCensus(env, runId, doc);
    assertEq(accepted.kind, "ok");
    assertEq(accepted.value.failedUnit.unit, "A");
    assertEq(JSON.stringify(accepted.value.failedUnit.blockIds), JSON.stringify(["b0001"]));

    await env.EVIDENCE.put(key, JSON.stringify({ ...canonicalHistorical, modelOutput: null }));
    const impossibleOutput = await m.passA.reconstructPassAHistoricalProgressCensus(env, runId, doc);
    assertEq(impossibleOutput.kind, "invalid");
    assert(impossibleOutput.detail.includes("failure state is inconsistent"));

    await env.EVIDENCE.put(key, JSON.stringify({
      ...canonicalHistorical,
      detail: "uncanonical wire failure prose",
    }));
    const unclosedReason = await m.passA.reconstructPassAHistoricalProgressCensus(env, runId, doc);
    assertEq(unclosedReason.kind, "invalid");
    assert(unclosedReason.detail.includes("failure state is inconsistent"));
    assertEq(providerCalls, 0);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("huge owned source context is prefix-bounded on the named zero-call refusal path", async () => {
  const m = await mod();
  const hugeText = "heading " + "x".repeat(50 * 1024 * 1024);
  const doc = documentFor([block("b0001", hugeText, { kind: "heading" })]);
  const grokSecret = countedSecret("grok-secret");
  const deepseekSecret = countedSecret("deepseek-secret");
  const env = envFor({
    XAI_API_KEY: grokSecret.binding,
    DEEPSEEK_API_KEY: deepseekSecret.binding,
  });
  const originalFetch = globalThis.fetch;
  const originalReplace = String.prototype.replace;
  let providerCalls = 0;
  let largestRedactionReceiver = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("huge source-context refusal reached provider");
  };
  String.prototype.replace = function (...args) {
    largestRedactionReceiver = Math.max(largestRedactionReceiver, String(this).length);
    if (String(this).length > 2_048) {
      throw new Error(`unbounded redaction receiver: ${String(this).length}`);
    }
    return originalReplace.apply(this, args);
  };
  try {
    const runId = "run_wire_a_huge_source_context";
    const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assertEq(providerCalls, 0);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(refused.failedUnits.length, 1);
    const context = m.documentReading.sourceContextForUnit(
      doc.blocks, refused.failedUnits[0].blockIds,
    );
    assert(context !== null);
    assertEq(context.blockCount, 1);
    assertEq(context.firstBlockId, "b0001");
    assertEq(context.lastBlockId, "b0001");
    assert(context.label.length <= 160);
    assert(context.preview.length <= 240);
    assert(largestRedactionReceiver <= 2_048);

    const manyBlocks = Array.from({ length: 10_000 }, (_, index) =>
      block("m" + String(index).padStart(5, "0"), "small source " + index));
    const manyIds = [];
    for (const row of manyBlocks) manyIds.push(row.blockId);
    const originalMap = Array.prototype.map;
    let manyContext;
    Array.prototype.map = function () {
      throw new Error("source context duplicated the full block/id list with Array.map");
    };
    try {
      manyContext = m.documentReading.sourceContextForUnit(manyBlocks, manyIds);
    } finally {
      Array.prototype.map = originalMap;
    }
    assert(manyContext !== null);
    assertEq(manyContext.blockCount, manyBlocks.length);
    assertEq(manyContext.firstBlockId, "m00000");
    assertEq(manyContext.lastBlockId, "m09999");
  } finally {
    String.prototype.replace = originalReplace;
    globalThis.fetch = originalFetch;
  }
});

test("a paid retryable Pass-A receipt is retained under a zero-effect wire sidecar", async () => {
  const m = await mod();
  const env = envFor({
    DEEPSEEK_FALLBACK_MODE: "on-error",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
  });
  const doc = documentFor([block("b0001", "x".repeat(120000))]);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("provider unavailable", { status: 502 });
  };
  try {
    const runId = "run_wire_a_paid_sidecar";
    const paid = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assert(providerCalls > 0, "fixture did not create a paid retryable receipt");
    assert(paid.accountingCalls.length > 0);
    const mainKey = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const mainBefore = await (await env.EVIDENCE.get(mainKey)).text();
    assertEq(JSON.parse(mainBefore).terminal, false, "setup must leave a paid retryable main artifact");
    const grokSecret = countedSecret("grok-secret");
    const deepseekSecret = countedSecret("deepseek-secret");
    const replayEnv = {
      ...env,
      XAI_API_KEY: grokSecret.binding,
      DEEPSEEK_API_KEY: deepseekSecret.binding,
      EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
    };
    const callsBefore = providerCalls;
    const refused = await m.passA.runPassA(replayEnv, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assert(refused.accountingCalls.length > 0, "the prior paid receipt remains chargeable/visible");
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(mainKey)).text(), mainBefore);
    const sidecarKey = m.keys.k(
      "runs", runId, "extraction", "pass-a", "window-01-wire-ceiling.json",
    );
    const sidecar = await readJson(env.EVIDENCE, sidecarKey);
    assertEq(sidecar.attempts, 0);
    assertEq(sidecar.usages.length, 0);
    assertEq(sidecar.failureStage, "wire-ceiling");
    assertEq(Object.hasOwn(sidecar, "modelOutput"), false);
    const sidecarBefore = await (await env.EVIDENCE.get(sidecarKey)).text();

    const replayAgain = await m.passA.runPassA(replayEnv, runId, doc, "neutral.docx");
    assertEq(replayAgain.terminalReasonCode, REASON);
    assert(replayAgain.accountingCalls.length > 0);
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(sidecarKey)).text(), sidecarBefore);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pass-B keeps a same-row unit indivisible and retained late refusal blocks earlier work", async () => {
  const m = await mod();
  const deepseekSecret = countedSecret("deepseek-secret");
  const env = envFor({
    DEEPSEEK_API_KEY: deepseekSecret.binding,
    EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "999999",
  });
  const doc = documentFor([
    block("b0001", "small first chunk"),
    block("b0002", "x".repeat(60000), {
      kind: "table-cell", origin: "table", tableId: "t1",
      coords: { row: 0, col: 0, rowHeader: null, colHeader: null },
    }),
    block("b0003", String.fromCharCode(92).repeat(30000) +
      String.fromCharCode(0x03a9).repeat(30000), {
      kind: "table-cell", origin: "table", tableId: "t1",
      coords: { row: 0, col: 1, rowHeader: null, colHeader: null },
    }),
  ]);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("wire bypass reached provider");
  };
  try {
    const runId = "run_wire_b_late_row";
    const first = await m.passB.runPassB(env, runId, doc, "neutral.docx");
    assertEq(first.terminalReasonCode, REASON);
    assertEq(providerCalls, 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-b", "chunk-01.json"),
    ), null);
    const key = m.keys.k("runs", runId, "extraction", "pass-b", "chunk-02.json");
    const before = await (await env.EVIDENCE.get(key)).text();
    const artifact = JSON.parse(before);
    assertEq(JSON.stringify(artifact.blockIds), JSON.stringify(["b0002", "b0003"]));
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);

    const replay = await m.passB.runPassB(env, runId, doc, "neutral.docx");
    assertEq(replay.terminalReasonCode, REASON);
    assertEq(providerCalls, 0, "retained late chunk refusal blocks missing chunk 1");
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(key)).text(), before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a paid retryable Pass-B chunk is retained under a strict zero-effect sidecar", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "999999",
  });
  const doc = documentFor([block("b0001", "x".repeat(120000))]);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("provider unavailable", { status: 502 });
  };
  try {
    const runId = "run_wire_b_paid_sidecar";
    const paid = await m.passB.runPassB(env, runId, doc, "neutral.docx");
    assertEq(providerCalls, 1, "setup buys exactly one failed DeepSeek purchase");
    assert(paid.accountingCalls.length > 0);
    const mainKey = m.keys.k("runs", runId, "extraction", "pass-b", "chunk-01.json");
    const mainBefore = await (await env.EVIDENCE.get(mainKey)).text();
    const main = JSON.parse(mainBefore);
    assertEq(main.terminal, false, "setup must leave a paid retryable chunk");
    assert(main.attempts > 0 && main.usages.length > 0);

    const deepseekSecret = countedSecret("deepseek-secret");
    const replayEnv = {
      ...env,
      DEEPSEEK_API_KEY: deepseekSecret.binding,
      EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
    };
    const callsBefore = providerCalls;
    const refused = await m.passB.runPassB(replayEnv, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assert(refused.accountingCalls.length > 0, "the paid chunk receipt remains chargeable/visible");
    assertEq(providerCalls, callsBefore);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(mainKey)).text(), mainBefore);
    const sidecarKey = m.keys.k(
      "runs", runId, "extraction", "pass-b", "chunk-01-wire-ceiling.json",
    );
    const sidecarBefore = await (await env.EVIDENCE.get(sidecarKey)).text();
    const sidecar = JSON.parse(sidecarBefore);
    assertEq(sidecar.attempts, 0);
    assertEq(sidecar.usages.length, 0);
    assertEq(sidecar.failureStage, "wire-ceiling");
    assertEq(Object.hasOwn(sidecar, "modelOutput"), false);

    const replayAgain = await m.passB.runPassB(replayEnv, runId, doc, "neutral.docx");
    assertEq(replayAgain.terminalReasonCode, REASON);
    assert(replayAgain.accountingCalls.length > 0);
    assertEq(providerCalls, callsBefore);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(mainKey)).text(), mainBefore);
    assertEq(await (await env.EVIDENCE.get(sidecarKey)).text(), sidecarBefore);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all sweep slices preflight before sweep 1 and retained late sweep stays zero-call", async () => {
  const m = await mod();
  const doc = documentFor([
    block("b0001", "small normative source"),
    block("b0002", "x".repeat(120000)),
  ]);
  const env = envFor({
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "999999",
    EXTRACT_SWEEP_MAX_CALLS: "0",
  });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1];
    assert(unit && unit.startsWith("C"), "setup must land chunks only");
    const sourceBlocks = unit.includes("b0001") ? [doc.blocks[0]] : [doc.blocks[1]];
    return providerResponse(body, passBPayload(unit, sourceBlocks));
  };
  try {
    const runId = "run_wire_b_sweep_late";
    const landed = await m.passB.runPassB(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600000 },
    );
    assertEq(landed.slice.chunksRemaining, 0);
    assertEq(providerCalls, 2, "setup landed exactly two chunk artifacts");

    const deepseekSecret = countedSecret("deepseek-secret");
    const sweepEnv = {
      ...env,
      DEEPSEEK_API_KEY: deepseekSecret.binding,
      EXTRACT_MODEL_INPUT_MAX_BYTES: "100000",
      EXTRACT_SWEEP_MAX_CALLS: "2",
      EXTRACT_SWEEP_BLOCKS_PER_CALL: "1",
    };
    const callsBefore = providerCalls;
    const refused = await m.passB.runPassB(sweepEnv, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assertEq(providerCalls, callsBefore, "late SWEEP02 overflow blocks missing SWEEP01");
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-b", "sweep01.json"),
    ), null);
    const sweep2Key = m.keys.k("runs", runId, "extraction", "pass-b", "sweep02.json");
    const before = await (await env.EVIDENCE.get(sweep2Key)).text();
    const artifact = JSON.parse(before);
    assertEq(JSON.stringify(artifact.blockIds), JSON.stringify(["b0002"]));
    assertEq(artifact.attempts, 0);
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);

    const replay = await m.passB.runPassB(sweepEnv, runId, doc, "neutral.docx");
    assertEq(replay.terminalReasonCode, REASON);
    assertEq(providerCalls, callsBefore, "retained late SWEEP02 still blocks missing SWEEP01");
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(sweep2Key)).text(), before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pass-A synthesis gates the larger Flash body when the Grok body alone fits", async () => {
  const m = await mod();
  const blocks = [
    block("b0001", "first synthesis route-control block"),
    block("b0002", "second synthesis route-control block"),
  ];
  const doc = documentFor(blocks);
  const seedEnv = envFor({
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "450000",
  });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    return providerResponse(JSON.parse(init.body), emptyPrimary());
  };
  try {
    const runId = "run_wire_a_synthesis_route_differential";
    const primary = await m.passA.runPassA(
      seedEnv, runId, doc, "neutral.docx", undefined, { budgetMs: 600000 },
    );
    assertEq(primary.slice.windowsRemaining, 0);
    assertEq(primary.slice.windowsIssued, 2);
    assertEq(primary.slice.synthesisState, "pending");
    assertEq(providerCalls, 2);
    assertEq(await seedEnv.EVIDENCE.get(m.passA.passASynthesisKey(runId)), null);

    const admittedView = await m.passA.preparePassASynthesis(
      seedEnv, runId, doc, "neutral.docx",
    );
    assert(admittedView !== null);
    assert(admittedView.inputJson.length > 0);
    assert(admittedView.flashWireBytes > admittedView.grokWireBytes,
      "route differential vanished: grok=" + admittedView.grokWireBytes +
      ", flash=" + admittedView.flashWireBytes);
    const between = Math.floor(
      (admittedView.grokWireBytes + admittedView.flashWireBytes) / 2,
    );
    assert(admittedView.grokWireBytes <= between);
    assert(admittedView.flashWireBytes > between);

    const grokSecret = countedSecret("grok-secret");
    const deepseekSecret = countedSecret("deepseek-secret");
    const refusalEnv = {
      ...seedEnv,
      XAI_API_KEY: grokSecret.binding,
      DEEPSEEK_API_KEY: deepseekSecret.binding,
      EXTRACT_MODEL_INPUT_MAX_BYTES: String(between),
      EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: String(between),
    };
    const refusedView = await m.passA.preparePassASynthesis(
      refusalEnv, runId, doc, "neutral.docx",
    );
    assert(refusedView !== null);
    assertEq(refusedView.grokWireBytes, admittedView.grokWireBytes);
    assertEq(refusedView.flashWireBytes, admittedView.flashWireBytes);
    assertEq(refusedView.inputBytes, admittedView.flashWireBytes);

    const callsBefore = providerCalls;
    globalThis.fetch = async () => {
      providerCalls += 1;
      throw new Error("synthesis larger-route omission reached provider");
    };
    const refused = await m.passA.runPassASynthesis(
      refusalEnv, runId, doc, "neutral.docx", { issueAuthorized: true },
    );
    assertEq(refused.state, "failed");
    assertEq(refused.terminalReasonCode, REASON);
    assertEq(refused.attempts, 0);
    assertEq(refused.accountingCalls.length, 0);
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    const artifact = await readJson(seedEnv.EVIDENCE, m.passA.passASynthesisKey(runId));
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);
    assert(artifact.detail.includes("deepseek-v4-flash"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synthesis bounds aggregate retention, rejects unsafe cap, and counts full refused unit", async () => {
  const m = await mod();
  const blocks = Array.from({ length: 6 }, (_, index) =>
    block(`b${String(index + 1).padStart(4, "0")}`, `Exact source quote ${index + 1}.`),
  );
  const doc = documentFor(blocks);
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "45000",
  });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const match = user.match(/window (\d+) of/);
    assert(match, "the setup wave must purchase primary windows only");
    const index = Number(match[1]) - 1;
    const source = blocks[index];
    return providerResponse(body, {
      ...emptyPrimary(),
      ambiguities: [{
        id: `AMB-${index + 1}`,
        block_ids: [source.blockId],
        doc_quote: source.text,
        evidence_quotes: [{ block_id: source.blockId, quote: source.text }],
        reading_a: "a".repeat(5000),
        reading_b: "b".repeat(5000),
        why_ambiguous: "c".repeat(5000),
        affects: ["routing"],
      }],
    });
  };
  try {
    const runId = "run_wire_a_synthesis";
    const primary = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600000 },
    );
    assertEq(primary.slice.windowsRemaining, 0);
    assertEq(primary.slice.synthesisState, "failed");
    assertEq(primary.terminalReasonCode, REASON);
    assertEq(providerCalls, blocks.length);

    const secret = countedSecret("must-not-be-read");
    const badCapEnv = {
      ...env,
      XAI_API_KEY: secret.binding,
      DEEPSEEK_API_KEY: secret.binding,
      EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "100000000",
    };
    let capError = null;
    try { await m.passA.preparePassASynthesis(badCapEnv, runId, doc, "neutral.docx"); }
    catch (error) { capError = error; }
    assert(capError instanceof Error);
    assert(capError.message.includes("must not exceed EXTRACT_MODEL_INPUT_MAX_BYTES"));
    assertEq(secret.reads(), 0);

    const grokSecret = countedSecret("grok-secret");
    const deepseekSecret = countedSecret("deepseek-secret");
    const refusalEnv = {
      ...env, XAI_API_KEY: grokSecret.binding, DEEPSEEK_API_KEY: deepseekSecret.binding,
    };
    const callsBefore = providerCalls;
    globalThis.fetch = async () => {
      providerCalls += 1;
      throw new Error("synthesis wire bypass reached provider");
    };
    const view = await m.passA.preparePassASynthesis(refusalEnv, runId, doc, "neutral.docx");
    assert(view !== null);
    assertEq(view.inputJson, "", "aggregate overflow retains no partial catalogue");
    assertEq(view.catalogueBytes, 45001);
    assertEq(view.coverage.primaryWindowsIncluded, 0);
    const refused = await m.passA.runPassA(refusalEnv, runId, doc, "neutral.docx");
    assertEq(refused.terminalReasonCode, REASON);
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(JSON.stringify(refused.failedUnits[0].blockIds),
      JSON.stringify(blocks.map((row) => row.blockId)));
    const artifact = await readJson(env.EVIDENCE, m.passA.passASynthesisKey(runId));
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);
    assertEq(JSON.stringify(artifact.blockIds), JSON.stringify(blocks.map((row) => row.blockId)));
    const synthesisKey = m.passA.passASynthesisKey(runId);
    const synthesisBefore = await (await env.EVIDENCE.get(synthesisKey)).text();
    const accountingBefore = refused.accountingCalls.map((row) => row.eventId).sort();
    const replay = await m.passA.runPassA(refusalEnv, runId, doc, "neutral.docx");
    assertEq(replay.terminalReasonCode, REASON);
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(JSON.stringify(replay.accountingCalls.map((row) => row.eventId).sort()),
      JSON.stringify(accountingBefore));
    assertEq(await (await env.EVIDENCE.get(synthesisKey)).text(), synthesisBefore);
    assertEq(await env.EVIDENCE.get(
      m.keys.k("runs", runId, "extraction", "pass-a", "cross-window-synthesis-wire-ceiling.json"),
    ), null, "an attempts-zero synthesis main never gains a sidecar on replay");

    // Same counts and evidence ownership, different valid candidate content. The rolling
    // ordered primary-artifact hash must change the refusal identity; otherwise stale
    // attempts-zero authority could be adopted after candidate mutation.
    const primaryKey = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const changedPrimary = JSON.parse(await (await env.EVIDENCE.get(primaryKey)).text());
    const changedReading = "z".repeat(5000);
    changedPrimary.modelOutput.ambiguities[0].reading_a = changedReading;
    changedPrimary.ambiguities[0].readingA = changedReading;
    await env.EVIDENCE.put(primaryKey, JSON.stringify(changedPrimary), {
      httpMetadata: { contentType: "application/json" },
    });
    const changedView = await m.passA.preparePassASynthesis(refusalEnv, runId, doc, "neutral.docx");
    assert(changedView !== null);
    assert(changedView.inputHash !== view.inputHash, "same-count candidate mutation did not change refusal identity");
    const rejectedStale = await m.passA.runPassA(refusalEnv, runId, doc, "neutral.docx");
    assert(rejectedStale.terminalReasonCode !== REASON,
      "a stale wire refusal was incorrectly adopted after valid candidate mutation");
    assert(
      rejectedStale.failedUnits.some((row) =>
        row.detail.includes("PASS_A_SYNTHESIS_ARTIFACT_INVALID") &&
        row.detail.includes("envelope identity differs")),
      JSON.stringify(rejectedStale.failedUnits),
    );
    assertEq(providerCalls, callsBefore);
    assertEq(grokSecret.reads(), 0);
    assertEq(deepseekSecret.reads(), 0);
    assertEq(await (await env.EVIDENCE.get(synthesisKey)).text(), synthesisBefore,
      "identity mismatch never overwrites the retained refusal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact wire reason survives workflow normalization and status limitation projection", async () => {
  const m = await mod();
  const refusal = m.workflow.extractionPassRefusal("a", {
    state: "not-evaluated",
    reason: REASON,
    detail: "private detail must not be parsed",
  });
  assertEq(refusal.reasonCode, REASON);
  assert(!refusal.reasonCode.includes("pass-a-pass"));
  const source = [block("b0101", "first"), block("b0102", "second")];
  const sourceContext = m.documentReading.sourceContextForUnit(
    source, source.map((row) => row.blockId),
  );
  const reading = m.documentReading.readingFromPrimary({
    done: false,
    windowsTotal: 2,
    windowsLanded: 1,
    windowsRemaining: 1,
    terminalFailure: true,
    synthesisState: "waiting-for-windows",
  }, {
    state: "stopped",
    failedUnit: { unit: "A-w2", detail: "private provider-looking model prose" },
    sourceContext,
    reasonCode: refusal.reasonCode,
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  assertEq(reading.failure.reasonCode, REASON);
  assert(reading.failure.detail.includes("safe input limit"));
  assert(reading.failure.detail.includes("no new credential lookup or provider request"));
  const limitation = reading.limitations.find((row) => row.code === REASON);
  assert(limitation, "the named wire limitation was not retained");
  assertEq(limitation.count, 2);
  assert(limitation.detail.includes("No input was truncated"));
  assert(limitation.detail.includes("no coverage was awarded"));
});

});
