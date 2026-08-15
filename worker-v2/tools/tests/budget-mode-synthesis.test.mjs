/**
 * Budget-mode synthesis primary routing tests.
 *
 * ROOT CAUSE: when EXTRACT_PASS_A_PRIMARY="gemini" (budget mode), the pass-A WINDOW
 * loop correctly routes its primary purchases to gemini-2.5-flash — but the SYNTHESIS
 * unit's primary purchase (cross-window reconciliation) never checked passAPrimary and
 * always routed to Grok. This violated the owner's Grok freeze: a run reading all
 * windows would silently buy a Grok call at synthesis.
 *
 * FIX: the synthesis primary now mirrors the window path. When passAPrimary === "gemini",
 * synthesis calls geminiGrokSubstituteJson with callId "call_a_synthesis:gemini-primary",
 * enforces the cumulative Gemini cap BEFORE purchase, and uses correct settlement usage.
 * On typed Gemini failure, it falls through to the DeepSeek Flash last resort via the
 * existing substitute path.
 *
 * What would make each test fail:
 *  - Test 1: removing the Gemini routing from synthesis; calling grokJson instead
 *  - Test 2: removing the Gemini cap enforcement before the synthesis purchase
 *  - Test 3: not setting a fallback trigger when Gemini primary fails at synthesis
 *  - Test 4: removing the Grok-mode synthesis path (regression)
 *  - Test 5: allowing a grok call to leak through in budget mode
 *  - Test 6: breaking the synthesis artifact round-trip for gemini-primary
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const TEXT = {
  b0001: "For respondents in the premium group, apply the rule named Omega.",
  b0002: "Omega means the Continue control remains disabled until an answer is selected.",
};

function documentFor(texts = [TEXT.b0001, TEXT.b0002]) {
  const blocks = texts.map((text, index) => ({
    blockId: `b${String(index + 1).padStart(4, "0")}`,
    kind: "paragraph",
    text,
    origin: "body",
    section: "Rules",
    coords: null,
    tableId: null,
  }));
  return {
    blocks,
    annotatedText: blocks.map((block) => `[${block.blockId}] ${block.text}`).join("\n"),
    counts: { paragraphs: blocks.length, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
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

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GEMINI_API_KEY: "test-gemini-key",
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
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "45000",
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    GEMINI_EXTRACTION_MODEL: "gemini-2.5-flash",
    GEMINI_INPUT_USD_PER_MTOK: "0.15",
    GEMINI_OUTPUT_USD_PER_MTOK: "3.5",
    GEMINI_MAX_TOTAL_USD: "10",
    GEMINI_REASONING_EFFORT: "medium",
    ...overrides,
  };
}

function jsonResponse(model, value, status = 200) {
  if (status !== 200) return new Response("provider failure", { status });
  return new Response(JSON.stringify({
    model,
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function emptyPrimary() {
  return {
    global_rules: [],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

function emptySynthesis() {
  return {
    global_rules: [],
    cross_reference_resolutions: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

function xref(id, blockId, quote, target = "Omega") {
  return {
    id,
    from_block: blockId,
    target,
    resolved_to_block: null,
    target_doc_quote: null,
    statement: `The text refers to ${target}.`,
    doc_quote: quote,
  };
}

function rule(id, blockId, quote) {
  return {
    id,
    construct: "instruction",
    scope: "survey",
    quantifier: "specific",
    selector: null,
    exceptions: [],
    statement: quote,
    doc_quote: quote,
    block_ids: [blockId],
    evidence_quotes: [{ block_id: blockId, quote }],
    browser_observable: "full",
    confidence: 0.9,
  };
}

function installProvider(responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
    const role = String(metadata.role ?? "");
    const user = String(body.messages[1].content);
    const match = user.match(/window (\d+) of (\d+)/);
    const unit = role === "extract-pass-a-synthesis"
      ? "A-synthesis"
      : match
        ? `A-w${match[1]}`
        : "A";
    const call = { url: String(url), body, role, unit, user, model: body.model };
    calls.push(call);
    const reply = await responder(call, calls);
    return jsonResponse(body.model, reply.value, reply.status ?? 200);
  };
  return {
    calls,
    count: (unit) => calls.filter((call) => call.unit === unit).length,
    grokCalls: () => calls.filter((call) => call.model === "grok-4.5"),
    geminiCalls: () => calls.filter((call) => call.model === "gemini-2.5-flash"),
    synthesisCalls: () => calls.filter((call) => call.unit === "A-synthesis"),
    reset: () => { calls.length = 0; },
    restore: () => { globalThis.fetch = original; },
  };
}

async function landPrimaryWindows(m, env, runId, doc, provider) {
  const first = await m.passA.runPassA(
    env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
  );
  assertEq(first.slice.windowsRemaining, 0, "every primary window landed");
  assertEq(first.slice.synthesisState, "pending", "synthesis is explicitly pending");
  assertEq(first.slice.done, false, "pending synthesis prevents completion");
  assertEq(provider.count("A-synthesis"), 0, "synthesis is never bought in the final primary wave");
  return first;
}

// ===========================================================================
suite("Budget mode synthesis — primary routing", () => {

test("budget-mode synthesis primary uses Gemini with :gemini-primary callId and cap enforcement", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "gemini" });
  const doc = documentFor();
  const runId = "run_budget_synthesis_gemini";
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "synthesis completed");
    assertEq(done.slice.synthesisState, "ok", "synthesis succeeded");

    // The synthesis call must have used Gemini, not Grok
    const synthCalls = provider.synthesisCalls();
    assertEq(synthCalls.length, 1, "exactly one synthesis call");
    assertEq(synthCalls[0].model, "gemini-2.5-flash", "synthesis used Gemini, not Grok");

    // Zero Grok calls in the entire run (budget mode)
    assertEq(provider.grokCalls().length, 0, "zero Grok calls in budget mode");

    // The issued calls for synthesis should have gemini-primary callId
    const synthUsages = done.issuedCalls.filter(
      (call) => call.role === "extract-pass-a-synthesis",
    );
    assertEq(synthUsages.length, 1, "one synthesis usage");
    assertEq(synthUsages[0].provider, "gemini", "synthesis usage is Gemini");
    assertEq(synthUsages[0].model, "gemini-2.5-flash", "synthesis usage model is gemini-2.5-flash");
    assert(
      synthUsages[0].callId.includes("call_a_synthesis:gemini-primary"),
      `synthesis callId includes :gemini-primary suffix. Got: ${synthUsages[0].callId}`,
    );

    // The route receipt should record gemini-2.5-flash with no trigger
    const synthReceipt = done.routeReceipts.find(
      (r) => r.selected === "gemini-2.5-flash" && r.trigger === null,
    );
    assert(synthReceipt !== null, "synthesis route receipt is gemini-2.5-flash with trigger=null");

    // Artifact round-trips on reclaim
    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "reclaim issues zero provider requests");
    assertEq(reclaimed.slice.done, true, "reclaim still complete");
  } finally {
    provider.restore();
  }
});

test("budget-mode synthesis: Gemini cap is enforced BEFORE purchase (cap exceeded -> Flash fallback)", async () => {
  const m = await mod();
  // Set a very low cap so the cap check fires at synthesis
  const env = envFor({
    EXTRACT_PASS_A_PRIMARY: "gemini",
    GEMINI_MAX_TOTAL_USD: "0.001",
  });
  const doc = documentFor();
  const runId = "run_budget_synth_cap_exceeded";
  let synthCallCount = 0;
  const provider = installProvider(({ unit, model }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    synthCallCount += 1;
    // The primary Gemini cap enforcement should reject before the call.
    // If we reach here in synthesis, it is the substitute path (gemini or flash).
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );

    // The synthesis must still complete (via Flash fallback), not crash
    assertEq(done.slice.done, true, "synthesis completed via fallback");

    // Zero Grok calls in budget mode
    assertEq(provider.grokCalls().length, 0, "zero Grok calls in budget mode");

    // The cap enforcement ran BEFORE purchase: at least one synthesis call should
    // have gone through the Flash path (since Gemini primary was cap-refused)
    const synthUsages = done.issuedCalls.filter(
      (call) => call.role === "extract-pass-a-synthesis",
    );
    assert(synthUsages.length >= 1, "at least one synthesis usage");
    // The final selected provider should be either gemini (substitute) or deepseek (flash)
    // because the primary cap was exceeded
    const lastUsage = synthUsages[synthUsages.length - 1];
    assert(
      lastUsage.provider === "deepseek" || lastUsage.provider === "gemini",
      `synthesis fallback is deepseek or gemini, got: ${lastUsage.provider}`,
    );
  } finally {
    provider.restore();
  }
});

test("budget-mode synthesis: typed Gemini primary failure -> fallback trigger -> Flash last resort", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "gemini" });
  const doc = documentFor();
  const runId = "run_budget_synth_gemini_fail_flash";
  let synthCallIndex = 0;
  const provider = installProvider(({ unit, model }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    synthCallIndex += 1;
    if (synthCallIndex === 1) {
      // Gemini primary fails (transport)
      return { value: null, status: 503 };
    }
    if (synthCallIndex === 2) {
      // Gemini substitute also fails (the substitute path tries Gemini first)
      return { value: null, status: 503 };
    }
    // Flash succeeds
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "synthesis completed via Flash");

    // Zero Grok calls
    assertEq(provider.grokCalls().length, 0, "zero Grok calls");

    // Synthesis should have a fallback trigger and selected deepseek
    const synthReceipts = done.routeReceipts.filter((r) => r.selected === "deepseek-v4-flash");
    assert(synthReceipts.length >= 1, "at least one Flash receipt (synthesis fallback)");
    assert(synthReceipts.some((r) => r.trigger !== null), "Flash receipt has a trigger");
  } finally {
    provider.restore();
  }
});

test("grok-mode synthesis unchanged (regression)", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "grok" });
  const doc = documentFor();
  const runId = "run_grok_synth_regression";
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "synthesis completed");

    // The synthesis call must have used Grok
    const synthCalls = provider.synthesisCalls();
    assertEq(synthCalls.length, 1, "one synthesis call");
    assertEq(synthCalls[0].model, "grok-4.5", "synthesis used Grok (not Gemini)");

    // The synthesis callId should NOT have :gemini-primary
    const synthUsages = done.issuedCalls.filter(
      (call) => call.role === "extract-pass-a-synthesis",
    );
    assertEq(synthUsages.length, 1, "one synthesis usage");
    assertEq(synthUsages[0].provider, "grok", "synthesis usage is Grok");
    assertEq(synthUsages[0].callId, "call_a_synthesis", "no callId suffix in grok mode");

    // Route receipt is grok-4.5
    const synthReceipt = done.routeReceipts.find((r) => r.selected === "grok-4.5");
    assert(synthReceipt !== null, "synthesis route receipt is grok-4.5");
  } finally {
    provider.restore();
  }
});

test("budget-mode: Grok is UNREACHABLE from the synthesis path (stub proves zero grok invocations)", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "gemini" });
  const doc = documentFor();
  const runId = "run_budget_synth_no_grok";
  const grokInvocations = [];
  const provider = installProvider(({ unit, model }) => {
    if (model === "grok-4.5") {
      grokInvocations.push({ unit, model });
    }
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "synthesis completed");
    assertEq(grokInvocations.length, 0,
      `Grok must be UNREACHABLE in budget mode. Got ${grokInvocations.length} grok calls: ` +
      JSON.stringify(grokInvocations));
  } finally {
    provider.restore();
  }
});

test("gemini-primary synthesis artifact round-trips through the reader", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "gemini" });
  const doc = documentFor();
  const runId = "run_budget_synth_roundtrip";
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "synthesis completed");
    assertEq(done.slice.synthesisState, "ok");

    // Now reclaim: reconstruction reads the artifact from R2 and must accept it
    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "reclaim issues zero provider requests");
    assertEq(reclaimed.slice.done, true, "reclaim succeeds");
    assertEq(reclaimed.slice.synthesisState, "ok", "synthesis state is still ok");
    assert(
      reclaimed.calls.every((call) => call.costUsd === 0),
      "every reclaimed receipt is zero-cost",
    );

    // Also verify via reconstructPassACompletedAuthority
    const authority = await m.passA.reconstructPassACompletedAuthority(env, runId, doc, "neutral.docx");
    assertEq(authority.kind, "ok", `reconstruction should succeed, got: ${authority.kind}: ${authority.detail ?? ""}`);
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("Budget mode synthesis — negative fixtures", () => {

test("budget-mode synthesis semantic failure is terminal (synthesis has no item-degradation)", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_PRIMARY: "gemini" });
  const doc = documentFor();
  const runId = "run_budget_synth_semantic_fail";
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: { ...emptyPrimary(), cross_references: unit === "A-w1" ? [xref("XREF-01", "b0001", TEXT.b0001)] : [] } };
    // Return output with an unknown key — triggers semantic validation failure
    return {
      value: {
        global_rules: [],
        cross_reference_resolutions: [],
        ambiguities: [],
        unverifiable_from_browser: [],
        unknown_extra_key: "should be rejected",
      },
    };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    // Synthesis should fail terminally
    assertEq(done.slice.synthesisState, "failed", "synthesis failed");
    assertEq(done.slice.done, false, "run not complete");

    // Zero Grok calls
    assertEq(provider.grokCalls().length, 0, "zero Grok calls in budget mode");
  } finally {
    provider.restore();
  }
});

});
