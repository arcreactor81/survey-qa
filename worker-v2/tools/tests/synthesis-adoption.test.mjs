/**
 * CROSS-RUN PASS-A SYNTHESIS ADOPTION — end-to-end proof that the synthesis
 * unit-reuse path works correctly.
 *
 * This is the missing fixture cited in the PASS_A_SYNTHESIS_ADOPTION_ENABLED
 * comment. It proves the four properties that justify flipping the constant:
 *
 *   (a) Identity-hit adoption: a synthesis bought in run 1 is adopted in run 2
 *       with zero-cost provenance and reusedFromRunId.
 *   (b) Identity-miss: different window outputs (different block text in the
 *       document) produce a different synthesis input hash, so run 2 MISSES
 *       and buys live — this is the load-bearing safety property.
 *   (c) Revalidation refusal: a stored synthesis whose modelOutput fails the
 *       current decoder is refused and falls back to a live purchase.
 *   (d) Failed synthesis: a synthesis that fails (provider error) never enters
 *       the cross-run index.
 *
 * Multi-window layout: EXTRACT_PASS_A_WINDOW_MAX_BLOCKS=1, so each of 2 blocks
 * goes to its own pass-A window. After both windows land, synthesis runs. The
 * document is deliberately small — the split is forced by block-count, not by
 * character count.
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

function envFor(evidence, overrides = {}) {
  return {
    EVIDENCE: evidence,
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
    // Force 1 block per window => 2 blocks = 2 windows = synthesis required.
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "120000",
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    ...overrides,
  };
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

function rule(id, blockId, quote, statement = quote) {
  return {
    id,
    construct: "instruction",
    scope: "survey",
    quantifier: "specific",
    selector: null,
    exceptions: [],
    statement,
    doc_quote: quote,
    block_ids: [blockId],
    evidence_quotes: [{ block_id: blockId, quote }],
    browser_observable: "full",
    confidence: 0.9,
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

function jsonResponse(model, value, status = 200) {
  if (status !== 200) return new Response("provider failure", { status });
  return new Response(JSON.stringify({
    model,
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
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
    const call = { url: String(url), body, role, unit, user };
    calls.push(call);
    const reply = await responder(call, calls);
    return jsonResponse(body.model, reply.value, reply.status ?? 200);
  };
  return {
    calls,
    count: (unit) => calls.filter((call) => call.unit === unit).length,
    reset: () => { calls.length = 0; },
    restore: () => { globalThis.fetch = original; },
  };
}

function nominatedPrimary(unit, texts = TEXT) {
  if (unit === "A-w1") {
    return { ...emptyPrimary(), cross_references: [xref("XREF-01", "b0001", texts.b0001)] };
  }
  if (unit === "A-w2") {
    return { ...emptyPrimary(), global_rules: [rule("GLOB-02", "b0002", texts.b0002)] };
  }
  throw new Error(`unexpected primary unit ${unit}`);
}

function synthesisOutput(texts = TEXT) {
  return {
    global_rules: [{
      id: "SYN-GLOB-01",
      construct: "skip-rule",
      scope: "survey",
      quantifier: "specific",
      selector: null,
      exceptions: [],
      statement: "Premium respondents are subject to Omega's answer-before-continue rule.",
      doc_quote: texts.b0001,
      block_ids: ["b0001", "b0002"],
      evidence_quotes: [
        { block_id: "b0001", quote: texts.b0001 },
        { block_id: "b0002", quote: texts.b0002 },
      ],
      browser_observable: "full",
      confidence: 0.95,
    }],
    cross_reference_resolutions: [{
      source_xref_handle: "A-w1:x:001",
      resolved_to_block: "b0002",
      statement: "Omega requires an answer before Continue becomes enabled.",
      evidence_quotes: [
        { block_id: "b0001", quote: texts.b0001 },
        { block_id: "b0002", quote: texts.b0002 },
      ],
    }],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

/**
 * Run pass A through windows and synthesis, producing a complete pass.
 *
 * When windows are FRESHLY PURCHASED, synthesis is deferred to a second wave.
 * When windows are ADOPTED from the cross-run index, all windows complete
 * instantly and synthesis runs in the same wave. This helper handles both.
 */
async function completePassA(m, env, runId, doc) {
  const opts = { budgetMs: 600_000 };
  const first = await m.passA.runPassA(
    env, runId, doc, "neutral.docx", async () => {}, opts,
  );
  if (first.slice.done) return first;
  assertEq(first.slice.windowsRemaining, 0, `${runId}: every primary window landed`);

  const second = await m.passA.runPassA(
    env, runId, doc, "neutral.docx", async () => {}, opts,
  );
  if (second.slice.done) return second;

  // A third wave is occasionally needed when synthesis retries.
  const third = await m.passA.runPassA(
    env, runId, doc, "neutral.docx", async () => {}, opts,
  );
  assertEq(third.slice.done, true, `${runId}: pass A must complete within three waves`);
  return third;
}

suite("CROSS-RUN UNIT REUSE — pass-A synthesis adoption", () => {

test("synthesis bought in run 1 is adopted in run 2 with zero-cost provenance and reusedFromRunId", async () => {
  const m = await mod();
  const evidence = memoryR2();
  const doc = documentFor();

  const provider = installProvider(({ unit }) => {
    if (unit === "A-synthesis") return { value: synthesisOutput() };
    return { value: nominatedPrimary(unit) };
  });
  try {
    // --- Run 1: buy everything.
    const env1 = envFor(evidence);
    const result1 = await completePassA(m, env1, "run-synth-1", doc, provider);
    assertEq(provider.count("A-w1"), 1, "run 1: one window-1 purchase");
    assertEq(provider.count("A-w2"), 1, "run 1: one window-2 purchase");
    assertEq(provider.count("A-synthesis"), 1, "run 1: one synthesis purchase");

    // Verify synthesis is stored in the cross-run index.
    const indexKeys = [...evidence._store.keys()].filter((k) => k.startsWith("v2/extract-units/"));
    let hasSynthesisUnit = false;
    for (const key of indexKeys) {
      const obj = await evidence.get(key);
      const entry = JSON.parse(await obj.text());
      if (entry.identity.unitKind === "pass-a-synthesis") hasSynthesisUnit = true;
    }
    assert(hasSynthesisUnit, "cross-run index must have a pass-a-synthesis entry after run 1");

    // --- Run 2: same document, same env. Windows adopt, synthesis should adopt.
    provider.reset();
    const env2 = envFor(evidence);
    const result2 = await completePassA(m, env2, "run-synth-2", doc, provider);

    // No synthesis purchase in run 2 (adopted from run 1).
    assertEq(provider.count("A-synthesis"), 0, "run 2 must not buy synthesis (adopted)");

    // The result must have the reusedFromRunId marker.
    const synthKey = [...evidence._store.keys()].find(
      (k) => k.includes("run-synth-2") && k.endsWith("cross-window-synthesis.json"),
    );
    assert(synthKey, "run 2 must have a synthesis artifact");
    const synthArtifact = JSON.parse(await (await evidence.get(synthKey)).text());
    assertEq(synthArtifact.reusedFromRunId, "run-synth-1", "adopted synthesis must carry reusedFromRunId");

    // All accounting calls for synthesis must be zero-cost (reused).
    const synthesisCalls = result2.accountingCalls.filter(
      (c) => c.role === "extract-pass-a-synthesis",
    );
    for (const call of synthesisCalls) {
      assertEq(call.usageSource, "reused-prior-artifact", "adopted synthesis accounting must be reused-prior-artifact");
    }

    // Run 2 synthesis result must match run 1.
    assertEq(
      result2.requirements.filter((r) => r.origin === "A-synthesis").length,
      result1.requirements.filter((r) => r.origin === "A-synthesis").length,
      "adopted synthesis must produce the same synthesis requirements",
    );
  } finally {
    provider.restore();
  }
});

test("identity miss: different window outputs (different document) force a live synthesis purchase", async () => {
  const m = await mod();
  const evidence = memoryR2();
  const doc1 = documentFor();

  // The second document has DIFFERENT text for the same block IDs.
  // This means windows produce different candidates -> different synthesis input hash -> MISS.
  const ALT_TEXT = {
    b0001: "For respondents in the standard group, apply the rule named Alpha.",
    b0002: "Alpha means the Submit control remains enabled at all times.",
  };
  const doc2 = documentFor([ALT_TEXT.b0001, ALT_TEXT.b0002]);

  // Provider responds correctly based on the block text it receives.
  const provider = installProvider(({ unit, user }) => {
    if (unit === "A-synthesis") {
      // Determine which document this synthesis is for based on what text appears in the prompt.
      if (user.includes("Alpha")) {
        return {
          value: {
            global_rules: [{
              id: "SYN-ALT-01",
              construct: "instruction",
              scope: "survey",
              quantifier: "specific",
              selector: null,
              exceptions: [],
              statement: "Standard respondents have Submit always enabled.",
              doc_quote: ALT_TEXT.b0001,
              block_ids: ["b0001", "b0002"],
              evidence_quotes: [
                { block_id: "b0001", quote: ALT_TEXT.b0001 },
                { block_id: "b0002", quote: ALT_TEXT.b0002 },
              ],
              browser_observable: "full",
              confidence: 0.95,
            }],
            cross_reference_resolutions: [{
              source_xref_handle: "A-w1:x:001",
              resolved_to_block: "b0002",
              statement: "Alpha is defined in the second block.",
              evidence_quotes: [
                { block_id: "b0001", quote: ALT_TEXT.b0001 },
                { block_id: "b0002", quote: ALT_TEXT.b0002 },
              ],
            }],
            ambiguities: [],
            unverifiable_from_browser: [],
          },
        };
      }
      return { value: synthesisOutput() };
    }
    if (unit === "A-w1") {
      if (user.includes("Alpha")) {
        return {
          value: {
            ...emptyPrimary(),
            cross_references: [xref("XREF-ALT-01", "b0001", ALT_TEXT.b0001, "Alpha")],
          },
        };
      }
      return { value: nominatedPrimary(unit) };
    }
    if (unit === "A-w2") {
      if (user.includes("Alpha")) {
        return {
          value: {
            ...emptyPrimary(),
            global_rules: [rule("GLOB-ALT-02", "b0002", ALT_TEXT.b0002)],
          },
        };
      }
      return { value: nominatedPrimary(unit) };
    }
    throw new Error(`unexpected unit ${unit}`);
  });

  try {
    // Run 1: complete with document 1.
    const env1 = envFor(evidence);
    await completePassA(m, env1, "run-miss-1", doc1, provider);
    assertEq(provider.count("A-synthesis"), 1, "run 1 bought synthesis");

    // Run 2: DIFFERENT document. Synthesis identity changes, must MISS.
    provider.reset();
    const env2 = envFor(evidence);
    await completePassA(m, env2, "run-miss-2", doc2, provider);
    assertEq(
      provider.count("A-synthesis"),
      1,
      "run 2 must buy synthesis live (identity miss from different window candidates)",
    );
  } finally {
    provider.restore();
  }
});

test("adopted synthesis revalidation refusal falls back to live purchase", async () => {
  const m = await mod();
  const evidence = memoryR2();
  const doc = documentFor();

  const provider = installProvider(({ unit }) => {
    if (unit === "A-synthesis") return { value: synthesisOutput() };
    return { value: nominatedPrimary(unit) };
  });
  try {
    // Run 1: complete normally.
    const env1 = envFor(evidence);
    await completePassA(m, env1, "run-reval-1", doc, provider);
    assertEq(provider.count("A-synthesis"), 1, "run 1 bought synthesis");

    // Corrupt the stored synthesis model output in the cross-run index.
    for (const key of [...evidence._store.keys()].filter((k) => k.startsWith("v2/extract-units/"))) {
      const obj = await evidence.get(key);
      const entry = JSON.parse(await obj.text());
      if (entry.identity.unitKind === "pass-a-synthesis") {
        entry.modelOutput = { deliberately: "corrupt" };
        await evidence.delete(key);
        await evidence.put(key, JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
      }
    }

    // Delete run 1's per-run synthesis artifact so the adoption path is attempted
    // (adoption only when existing === null, i.e., no per-run synthesis artifact).
    for (const key of [...evidence._store.keys()].filter(
      (k) => k.includes("run-reval-1") && k.endsWith("cross-window-synthesis.json"),
    )) {
      await evidence.delete(key);
    }

    // Run 2: same document. Adoption attempted, revalidation fails, falls back to purchase.
    provider.reset();
    const env2 = envFor(evidence);
    const result2 = await completePassA(m, env2, "run-reval-2", doc, provider);
    assert(
      provider.count("A-synthesis") > 0,
      "corrupt synthesis adoption must fall back to live purchase",
    );
    assertEq(result2.slice.done, true, "run 2 must still complete after revalidation fallback");
  } finally {
    provider.restore();
  }
});

test("failed synthesis never enters the cross-run index", async () => {
  const m = await mod();
  const evidence = memoryR2();
  const doc = documentFor();

  // Provider returns successful primary windows but FAILS synthesis.
  const provider = installProvider(({ unit }) => {
    if (unit === "A-synthesis") return { value: {}, status: 500 };
    return { value: nominatedPrimary(unit) };
  });
  try {
    const env1 = envFor(evidence, { EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "1" });

    // Land primary windows.
    const primary = await m.passA.runPassA(
      env1, "run-fail-synth-1", doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );
    assertEq(primary.slice.windowsRemaining, 0, "all primary windows landed");

    // Synthesis attempt fails.
    const afterSynth = await m.passA.runPassA(
      env1, "run-fail-synth-1", doc, "neutral.docx", async () => {}, { budgetMs: 600_000 },
    );

    // Verify no synthesis unit in the cross-run index.
    for (const key of [...evidence._store.keys()].filter((k) => k.startsWith("v2/extract-units/"))) {
      const obj = await evidence.get(key);
      const entry = JSON.parse(await obj.text());
      assert(
        entry.identity.unitKind !== "pass-a-synthesis",
        "failed synthesis must never be stored in the cross-run index",
      );
    }
  } finally {
    provider.restore();
  }
});

});
