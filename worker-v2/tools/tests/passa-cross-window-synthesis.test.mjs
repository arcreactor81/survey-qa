/**
 * Pass-A cross-window candidate reconciliation.
 *
 * These fixtures are platform-neutral: their only convention is the typed extraction
 * contract. Each primary window is individually insufficient for the positive relation.
 * The provider is replaced only at fetch, so request serialization, route identity,
 * persistence, retries, grounding and accounting are production code.
 */
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
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
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "45000",
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
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

function nominatedPrimary(unit) {
  if (unit === "A-w1") {
    return { ...emptyPrimary(), cross_references: [xref("XREF-01", "b0001", TEXT.b0001)] };
  }
  if (unit === "A-w2") {
    return { ...emptyPrimary(), global_rules: [rule("GLOB-02", "b0002", TEXT.b0002)] };
  }
  throw new Error(`unexpected primary unit ${unit}`);
}

async function landPrimaryWindows(m, env, runId, doc, provider, onProgress) {
  const first = await m.passA.runPassA(
    env, runId, doc, "neutral.docx", onProgress, { budgetMs: 600_000 },
  );
  assertEq(first.slice.windowsRemaining, 0, "every primary window landed");
  assertEq(first.slice.synthesisState, "pending", "synthesis is explicitly pending");
  assertEq(first.slice.done, false, "pending synthesis prevents completion");
  assertEq(provider.count("A-synthesis"), 0, "synthesis is never bought in the final primary wave");
  return first;
}

suite("Pass-A cross-window synthesis — bounded, grounded, durable", () => {

test("a relation split across windows is added once and resolves the qualified primary xref", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_positive";
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
    return {
      value: {
        global_rules: [{
          id: "SYN-GLOB-01",
          construct: "skip-rule",
          scope: "survey",
          quantifier: "specific",
          selector: null,
          exceptions: [],
          statement: "Premium respondents are subject to Omega's answer-before-continue rule.",
          doc_quote: TEXT.b0001,
          block_ids: ["b0001", "b0002"],
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: TEXT.b0002 },
          ],
          browser_observable: "full",
          confidence: 0.95,
        }],
        cross_reference_resolutions: [{
          source_xref_handle: "A-w1:x:001",
          resolved_to_block: "b0002",
          statement: "Omega requires an answer before Continue becomes enabled.",
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: TEXT.b0002 },
          ],
        }],
        ambiguities: [],
        unverifiable_from_browser: [],
      },
    };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider, async () => {
      throw new Error("heartbeat unavailable after durable progress");
    });
    const done = await m.passA.runPassA(
      env,
      runId,
      doc,
      "neutral.docx",
      async () => { throw new Error("heartbeat unavailable after synthesis"); },
      { budgetMs: 600_000 },
    );
    assertEq(done.slice.done, true, "the separately timed synthesis unit completed");
    assertEq(done.slice.synthesisState, "ok");
    assertEq(provider.count("A-w1"), 1);
    assertEq(provider.count("A-w2"), 1);
    assertEq(provider.count("A-synthesis"), 1);
    assertEq(
      done.requirements.filter((row) => row.origin === "A-synthesis").length,
      1,
      "the cross-window obligation survives into Pass A exactly once",
    );
    assertEq(
      done.requirements.find((row) => row.origin === "A-synthesis")?.construct,
      "skip-rule",
      "the canonical construct enum accepted by the prompt is accepted by the decoder",
    );
    assertEq(done.crossRefs.length, 1, "the resolution replaces, rather than appends beside, its source xref");
    assertEq(done.crossRefs[0].sourceXrefHandle, "A-w1:x:001");
    assertEq(done.crossRefs[0].resolvedToBlock, "b0002");
    assert(
      !done.crossRefs.some((row) => row.sourceXrefHandle === "A-w1:x:001" && row.resolvedToBlock === null),
      "the original qualified xref is no longer reported unresolved",
    );
    assertEq(done.crossWindowLimitations.length, 1, "candidate dependence is never silent");
    const limitation = done.crossWindowLimitations[0];
    assertEq(limitation.candidatesSynthesized, 2);
    assertEq(limitation.candidatesUngrounded, 0);
    assertEq(limitation.sourceEvidenceBlocks, 2);
    assertEq(limitation.sourceEvidenceSpans, 2);
    assertEq(limitation.synthesisAdditions, 2);
    assert(
      limitation.detail.includes("never whole-source") &&
        limitation.detail.includes("unsupplied text inside represented blocks"),
      limitation.detail,
    );

    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "reentry reclaims primary and synthesis artifacts without a purchase");
    assertEq(reclaimed.crossRefs[0].resolvedToBlock, "b0002", "the replacement survives artifact reclaim");
    assertEq(reclaimed.requirements.filter((row) => row.origin === "A-synthesis").length, 1);
    assert(
      reclaimed.calls.every((call) => call.costUsd === 0),
      "every reclaimed provider receipt is explicitly zero-cost telemetry",
    );
  } finally {
    provider.restore();
  }
});

test("nearby window-local candidates do not manufacture a cross-window relation", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor([
    "Every introduction screen displays the study title.",
    "Every closing screen displays the thank-you message.",
  ]);
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") {
      return { value: { ...emptyPrimary(), global_rules: [rule("LOCAL-1", "b0001", doc.blocks[0].text)] } };
    }
    if (unit === "A-w2") {
      return { value: { ...emptyPrimary(), global_rules: [rule("LOCAL-2", "b0002", doc.blocks[1].text)] } };
    }
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, "run_synthesis_counterexample", doc, provider);
    const done = await m.passA.runPassA(env, "run_synthesis_counterexample", doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.requirements.length, 2, "only the two primary local rules remain");
    assertEq(done.requirements.filter((row) => row.origin === "A-synthesis").length, 0);
    assertEq(done.crossWindowLimitations[0].synthesisAdditions, 0);
  } finally {
    provider.restore();
  }
});

test("primary candidates preserve distinct exact evidence spans across cited blocks", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const provider = installProvider(() => ({
    value: {
      ...emptyPrimary(),
      global_rules: [{
        id: "PRIMARY-MULTI", construct: "instruction", scope: "survey", quantifier: "specific",
        selector: null, exceptions: [], statement: "The named rule and its definition apply together.",
        doc_quote: TEXT.b0001, block_ids: ["b0001", "b0002"],
        evidence_quotes: [
          { block_id: "b0001", quote: TEXT.b0001 },
          { block_id: "b0002", quote: TEXT.b0002 },
        ],
        browser_observable: "full", confidence: 0.95,
      }],
      cross_references: [{
        id: "LOCAL-XREF", from_block: "b0001", target: "Omega", resolved_to_block: "b0002",
        target_doc_quote: TEXT.b0002, statement: "Omega is defined in the target block.", doc_quote: TEXT.b0001,
      }],
    },
  }));
  try {
    const done = await m.passA.runPassA(env, "run_primary_multispan", doc, "first-name.docx");
    assertEq(done.slice.done, true);
    assertEq(done.requirements[0].evidenceQuotes.length, 2);
    assertEq(done.requirements[0].evidenceQuotes[0].quote, TEXT.b0001);
    assertEq(done.requirements[0].evidenceQuotes[1].quote, TEXT.b0002);
    assertEq(done.crossRefs[0].resolvedToBlock, "b0002");
    assertEq(done.crossRefs[0].evidenceQuotes[1].quote, TEXT.b0002);
    provider.reset();
    const renamed = await m.passA.runPassA(env, "run_primary_multispan", doc, "renamed-questionnaire.docx");
    assertEq(provider.calls.length, 0, "display filename is not semantic request or reclaim identity");
    assertEq(renamed.slice.done, true);
  } finally {
    provider.restore();
  }
});

test("malformed primary schemas and evidence terminalize without a second purchase", async () => {
  const cases = [
    {
      name: "missing required root array",
      output: () => {
        const value = emptyPrimary();
        delete value.global_rules;
        return value;
      },
      expected: "root keys are not closed",
    },
    {
      name: "unknown silently ignored rule field",
      output: () => ({
        ...emptyPrimary(), global_rules: [{ ...rule("EXTRA", "b0001", TEXT.b0001), applies_to: "all" }],
      }),
      expected: "global rule keys are not closed",
    },
    {
      name: "inexact second evidence span",
      output: () => ({
        ...emptyPrimary(),
        global_rules: [{
          ...rule("INEXACT", "b0001", TEXT.b0001),
          block_ids: ["b0001", "b0002"],
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: "words not present in the target block" },
          ],
        }],
      }),
      expected: "quote is not exact source text in b0002",
    },
    {
      name: "resolved target quote is inexact",
      output: () => ({
        ...emptyPrimary(),
        cross_references: [{
          id: "BAD-TARGET", from_block: "b0001", target: "Omega", resolved_to_block: "b0002",
          target_doc_quote: "not source text", statement: "Claims a local target.", doc_quote: TEXT.b0001,
        }],
      }),
      expected: "target_doc_quote is absent or not exact text",
    },
    {
      name: "none-observable rule has no linked unverifiable row",
      output: () => ({
        ...emptyPrimary(),
        global_rules: [{ ...rule("HIDDEN", "b0001", TEXT.b0001), browser_observable: "none" }],
      }),
      expected: "browser_observable=none requires an unverifiable row",
    },
  ];
  const m = await mod();
  for (const [index, fixture] of cases.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const provider = installProvider(() => ({ value: fixture.output() }));
    try {
      const failed = await m.passA.runPassA(env, `run_strict_primary_${index}`, doc, "neutral.docx");
      assertEq(failed.slice.terminalFailure, true, fixture.name);
      assertEq(provider.calls.length, 1, fixture.name);
      assert(
        failed.failedUnits.some((row) => row.detail.includes(fixture.expected)),
        `${fixture.name}: ${JSON.stringify(failed.failedUnits)}`,
      );
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, `run_strict_primary_${index}`, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, `${fixture.name}: semantic rejection is durable terminal authority`);
      assertEq(reclaimed.slice.terminalFailure, true, fixture.name);
    } finally {
      provider.restore();
    }
  }
});

test("retained primary typed projection is re-decoded from raw output and cannot be laundered", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const runId = "run_primary_typed_corruption";
  const provider = installProvider(() => ({
    value: { ...emptyPrimary(), global_rules: [rule("ONE", "b0001", TEXT.b0001)] },
  }));
  try {
    const landed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(landed.slice.done, true);
    const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    artifact.globalRules[0].statement = "typed bytes were changed without changing raw authority";
    const corrupted = JSON.stringify(artifact);
    await env.EVIDENCE.put(key, corrupted);
    provider.reset();
    const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0);
    assertEq(refused.slice.terminalFailure, true);
    assert(refused.failedUnits.some((row) => row.detail.includes("typed projection differs")));
    assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted);
  } finally {
    provider.restore();
  }
});

test("primary paid success cannot be relabeled as retryable semantic failure", async () => {
  const cases = [
    {
      name: "retained ok receipt",
      mutate: (artifact) => {
        const ok = artifact.usages[0];
        ok.eventId = ok.eventId.replace("issue-1/receipt-1", "issue-2/receipt-1");
        artifact.usages.unshift({
          ...ok,
          eventId: ok.eventId.replace("issue-2/receipt-1", "issue-1/receipt-1"),
          status: "parse-failed",
        });
        artifact.attempts = 2;
        artifact.terminal = true;
      },
      expected: "unauthorized provider receipt",
    },
    {
      name: "parse-failed receipt but nonterminal semantic state",
      mutate: (artifact) => { artifact.usages[0].status = "parse-failed"; },
      expected: "unauthorized provider receipt",
    },
    {
      name: "ok receipt hidden behind a provider-failure discriminator",
      configure: (artifact) => {
        artifact.failureStage = "provider";
        artifact.terminal = false;
      },
      mutate: () => {},
      expected: "unauthorized provider receipt",
    },
    {
      name: "no-trigger provider failure relabeled nonterminal",
      configure: (artifact) => {
        artifact.failureStage = "provider";
        artifact.terminal = false;
      },
      mutate: (artifact) => { artifact.usages[0].status = "error"; },
      expected: "unauthorized provider receipt",
    },
  ];
  const m = await mod();
  for (const [index, fixture] of cases.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const runId = `run_primary_status_launder_${index}`;
    const provider = installProvider(() => ({
      value: { ...emptyPrimary(), global_rules: [rule("ONE", "b0001", TEXT.b0001)] },
    }));
    try {
      await m.passA.runPassA(env, runId, doc, "neutral.docx");
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      delete artifact.kind;
      delete artifact.globalRules;
      delete artifact.crossRefs;
      delete artifact.ambiguities;
      delete artifact.unverifiable;
      delete artifact.routeReceipt;
      delete artifact.modelOutput;
      artifact.status = "failed";
      artifact.terminal = false;
      artifact.failureStage = "semantic-output";
      artifact.fallbackTrigger = null;
      artifact.detail = "forged retryable semantic state";
      fixture.configure?.(artifact);
      fixture.mutate(artifact);
      const corrupted = JSON.stringify(artifact);
      await env.EVIDENCE.put(key, corrupted);
      provider.reset();
      const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, fixture.name);
      assertEq(refused.slice.terminalFailure, true, fixture.name);
      assert(refused.failedUnits.some((row) => row.detail.includes(fixture.expected)), fixture.name);
      assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted);
    } finally {
      provider.restore();
    }
  }
});

function validCrossWindowRule() {
  return {
    id: "SYN-GLOB-VALID",
    construct: "instruction",
    scope: "survey",
    quantifier: "specific",
    selector: null,
    exceptions: [],
    statement: "The two nominated passages form one rule.",
    doc_quote: TEXT.b0001,
    block_ids: ["b0001", "b0002"],
    evidence_quotes: [
      { block_id: "b0001", quote: TEXT.b0001 },
      { block_id: "b0002", quote: TEXT.b0002 },
    ],
    browser_observable: "full",
    confidence: 0.8,
  };
}

function synthesisWithRule(row) {
  return { ...emptySynthesis(), global_rules: [row] };
}

test("malformed or ungrounded synthesis rows terminalize and are never re-bought", async () => {
  const cases = [
    {
      name: "single-window evidence",
      output: () => synthesisWithRule({
        ...validCrossWindowRule(),
        block_ids: ["b0001"],
        evidence_quotes: [{ block_id: "b0001", quote: TEXT.b0001 }],
      }),
      expected: "at least two blocks",
    },
    {
      name: "real but unsupplied span from a represented block",
      output: () => synthesisWithRule({
        ...validCrossWindowRule(),
        doc_quote: "premium group",
        evidence_quotes: [
          { block_id: "b0001", quote: "premium group" },
          { block_id: "b0002", quote: TEXT.b0002 },
        ],
      }),
      expected: "not shown to synthesis as that exact span",
    },
    {
      name: "invalid closed enum",
      output: () => synthesisWithRule({ ...validCrossWindowRule(), quantifier: "sometimes" }),
      expected: "invalid global rule quantifier",
    },
    {
      name: "noncanonical construct neighbor",
      output: () => synthesisWithRule({ ...validCrossWindowRule(), construct: "navigation" }),
      expected: "unknown global rule construct",
    },
    {
      name: "empty selector silently coercible to null",
      output: () => synthesisWithRule({ ...validCrossWindowRule(), selector: "" }),
      expected: "selector must be a non-empty string or null",
    },
    {
      name: "empty cited block id",
      output: () => synthesisWithRule({
        ...validCrossWindowRule(),
        block_ids: ["b0001", ""],
      }),
      expected: "block_ids must be a nonempty duplicate-free string array",
    },
    {
      name: "empty ambiguity reason",
      output: () => ({
        ...emptySynthesis(),
        ambiguities: [{
          id: "SYN-AMB-1",
          block_ids: ["b0001", "b0002"],
          doc_quote: TEXT.b0001,
          reading_a: "Reading A",
          reading_b: "Reading B",
          why_ambiguous: "",
          affects: [],
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: TEXT.b0002 },
          ],
        }],
      }),
      expected: "why_ambiguous must be a non-empty string",
    },
    {
      name: "identical ambiguity readings",
      output: () => ({
        ...emptySynthesis(),
        ambiguities: [{
          id: "SYN-AMB-SAME", block_ids: ["b0001", "b0002"], doc_quote: TEXT.b0001,
          reading_a: "Same reading", reading_b: "Same reading", why_ambiguous: "Claimed conflict.",
          affects: [], evidence_quotes: validCrossWindowRule().evidence_quotes,
        }],
      }),
      expected: "ambiguity readings must be distinct",
    },
    {
      name: "ambiguity affects is not typed",
      output: () => ({
        ...emptySynthesis(),
        ambiguities: [{
          id: "SYN-AMB-AFFECTS", block_ids: ["b0001", "b0002"], doc_quote: TEXT.b0001,
          reading_a: "Reading A", reading_b: "Reading B", why_ambiguous: "Two readings remain.",
          affects: [1], evidence_quotes: validCrossWindowRule().evidence_quotes,
        }],
      }),
      expected: "ambiguity.affects must be a string array",
    },
    {
      name: "unverifiable proxy evidence is missing",
      output: () => ({
        ...emptySynthesis(),
        unverifiable_from_browser: [{
          id: "SYN-UNV-NOPROXY", block_ids: ["b0001", "b0002"], doc_quote: TEXT.b0001,
          mandate: "A hidden implementation mandate.", why_not_observable: "It is hidden.",
          evidence_quotes: validCrossWindowRule().evidence_quotes,
        }],
      }),
      expected: "unverifiable keys are not closed",
    },
    {
      name: "duplicate competing xref resolutions",
      output: () => ({
        ...emptySynthesis(),
        cross_reference_resolutions: [0, 1].map((index) => ({
          source_xref_handle: "A-w1:x:001",
          resolved_to_block: index === 0 ? "b0002" : "b0001",
          statement: "Resolved.",
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: TEXT.b0002 },
          ],
        })),
      }),
      expected: "duplicate cross-reference resolution",
    },
  ];

  const m = await mod();
  for (const [index, fixture] of cases.entries()) {
    const env = envFor();
    const doc = documentFor();
    const runId = `run_synthesis_invalid_${index}`;
    const provider = installProvider(({ unit }) => ({
      value: unit === "A-synthesis" ? fixture.output() : nominatedPrimary(unit),
    }));
    try {
      await landPrimaryWindows(m, env, runId, doc, provider);
      const failed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(failed.slice.terminalFailure, true, fixture.name);
      assertEq(failed.slice.synthesisState, "failed", fixture.name);
      assertEq(provider.count("A-synthesis"), 1, fixture.name);
      assert(
        failed.failedUnits.some((row) => row.unit === "A-synthesis" && row.detail.includes(fixture.expected)),
        `${fixture.name}: ${JSON.stringify(failed.failedUnits)}`,
      );
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, `${fixture.name}: terminal artifact forbids rebuy`);
      assertEq(reclaimed.slice.terminalFailure, true, fixture.name);
    } finally {
      provider.restore();
    }
  }
});

test("duplicate local xref ids are resolved only through their qualified window handles", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_duplicate_local_ids";
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") {
      return { value: { ...emptyPrimary(), cross_references: [xref("XREF-01", "b0001", TEXT.b0001)] } };
    }
    if (unit === "A-w2") {
      return { value: { ...emptyPrimary(), cross_references: [xref("XREF-01", "b0002", TEXT.b0002, "premium rule")] } };
    }
    return {
      value: {
        ...emptySynthesis(),
        cross_reference_resolutions: [{
          source_xref_handle: "A-w2:x:001",
          resolved_to_block: "b0001",
          statement: "The second window points to the premium rule in the first.",
          evidence_quotes: [
            { block_id: "b0002", quote: TEXT.b0002 },
            { block_id: "b0001", quote: TEXT.b0001 },
          ],
        }],
      },
    };
  });
  try {
    const primaryWave = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600_000 },
    );
    assertEq(primaryWave.slice.windowsRemaining, 0);
    assertEq(provider.count("A-synthesis"), 0, "final-primary wave does not buy synthesis");
    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.crossRefs.length, 2);
    const first = done.crossRefs.find((row) => row.sourceXrefHandle === "A-w1:x:001");
    const second = done.crossRefs.find((row) => row.sourceXrefHandle === "A-w2:x:001");
    assert(first && first.resolvedToBlock === null, JSON.stringify(done.crossRefs));
    assert(second && second.resolvedToBlock === "b0001", JSON.stringify(done.crossRefs));
  } finally {
    provider.restore();
  }
});

test("the exact serialized provider request is gated before any synthesis purchase", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "100" });
  const doc = documentFor();
  const runId = "run_synthesis_wire_ceiling";
  const provider = installProvider(({ unit }) => ({
    value: unit === "A-synthesis" ? emptySynthesis() : nominatedPrimary(unit),
  }));
  try {
    const primaryWave = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600_000 },
    );
    assertEq(primaryWave.slice.windowsRemaining, 0);
    assertEq(provider.count("A-synthesis"), 0, "final-primary wave does not buy synthesis");
    const prepared = await m.passA.preparePassASynthesis(env, runId, doc, "neutral.docx");
    assert(prepared && prepared.inputBytes > 100, JSON.stringify(prepared));
    assertEq(
      prepared.inputBytes,
      Math.max(prepared.grokWireBytes, prepared.flashWireBytes),
      "the gated byte count is the larger exact provider body",
    );
    assert(prepared.inputBytes > prepared.catalogueBytes, "prompt wrapper/escaping is inside the ceiling");

    const failed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.count("A-synthesis"), 0, "an oversize exact request is refused before fetch");
    assertEq(failed.slice.terminalFailure, true);
    assertEq(failed.slice.synthesisAttempts, 0, "a zero-purchase refusal does not invent an attempt");
    assert(
      failed.failedUnits.some((row) =>
        row.detail.includes("PASS_A_SYNTHESIS_REQUEST_TOO_LARGE") &&
        row.detail.includes("exact serialized provider request")),
      JSON.stringify(failed.failedUnits),
    );

    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "the durable pre-purchase refusal is not rediscovered or re-bought");
    assertEq(reclaimed.slice.synthesisAttempts, 0);
  } finally {
    provider.restore();
  }
});

test("foreign primary ids and repeated quote ownership fail loudly before synthesis", async () => {
  const fixtures = [
    {
      name: "foreign rule block",
      doc: documentFor(),
      primary: () => ({
        ...emptyPrimary(),
        global_rules: [rule("FOREIGN", "b9999", TEXT.b0001)],
      }),
      expected: "outside the owning window",
    },
    {
      name: "incomplete per-block ambiguity evidence",
      doc: documentFor(["Shared exact words.", "Shared exact words.", TEXT.b0002]),
      env: { EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" },
      primary: () => ({
        ...emptyPrimary(),
        ambiguities: [{
          id: "AMB-REPEATED",
          block_ids: ["b0001", "b0002"],
          doc_quote: "Shared exact words.",
          evidence_quotes: [{ block_id: "b0001", quote: "Shared exact words." }],
          reading_a: "A",
          reading_b: "B",
          why_ambiguous: "Two source owners remain possible.",
          affects: [],
        }],
      }),
      expected: "evidence_quotes must map every block_id exactly once",
    },
  ];
  const m = await mod();
  for (const [index, fixture] of fixtures.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1", ...(fixture.env ?? {}) });
    const provider = installProvider(({ unit }) => {
      if (unit === "A-w1") return { value: fixture.primary() };
      return { value: emptyPrimary() };
    });
    try {
      const failed = await m.passA.runPassA(
        env, `run_primary_grounding_${index}`, fixture.doc, "neutral.docx",
      );
      assertEq(failed.slice.terminalFailure, true, fixture.name);
      assertEq(provider.count("A-synthesis"), 0, `${fixture.name}: no synthesis follows invalid input`);
      assert(
        failed.failedUnits.some((row) =>
          row.detail.includes("PASS_A_WINDOW_OUTPUT_") &&
          row.detail.includes(fixture.expected)),
        `${fixture.name}: ${JSON.stringify(failed.failedUnits)}`,
      );
    } finally {
      provider.restore();
    }
  }
});

test("primary success survives throwing progress and reentry buys zero calls", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const runId = "run_primary_progress_throw";
  const provider = installProvider(() => ({
    value: { ...emptyPrimary(), global_rules: [rule("ONE", "b0001", TEXT.b0001)] },
  }));
  try {
    const first = await m.passA.runPassA(
      env,
      runId,
      doc,
      "neutral.docx",
      async () => { throw new Error("progress store unavailable"); },
    );
    assertEq(first.slice.done, true, "observability failure cannot overwrite durable model success");
    assertEq(provider.calls.length, 1);
    provider.reset();
    const again = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "the landed primary window is reclaimed, not re-bought");
    assertEq(again.slice.done, true);
  } finally {
    provider.restore();
  }
});

test("window artifact ownership is exact, ordered, and duplicate-sensitive", async () => {
  const m = await mod();
  for (const [index, corrupt] of [
    (ids) => [ids[0], ids[0]],
    (ids) => [ids[0]],
    (ids) => [...ids].reverse(),
  ].entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const runId = `run_window_identity_${index}`;
    const provider = installProvider(() => ({
      value: { ...emptyPrimary(), global_rules: [rule("ONE", "b0001", TEXT.b0001)] },
    }));
    try {
      await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 1);
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      assert(key, "the primary window artifact exists");
      const obj = await env.EVIDENCE.get(key);
      const parsed = JSON.parse(await obj.text());
      parsed.blockIds = corrupt(parsed.blockIds);
      await env.EVIDENCE.put(key, JSON.stringify(parsed));

      const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 1, "same-policy corrupt ownership is terminal, never re-bought");
      assertEq(refused.slice.terminalFailure, true);
      assert(
        refused.failedUnits.some((row) => row.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID")),
        JSON.stringify(refused.failedUnits),
      );
    } finally {
      provider.restore();
    }
  }
});

test("corrupt or incoherent retained synthesis authority terminalizes with zero new fetch", async () => {
  const fixtures = [
    {
      name: "corrupt paid success",
      mutate: (row) => { delete row.modelOutput; },
      expected: "successful artifact has no closed model output",
    },
    {
      name: "malformed paid failure",
      mutate: (row) => {
        row.status = "failed";
        row.terminal = false;
        row.detail = "retained paid failure";
        row.fallbackTrigger = { kind: "malformed-trigger" };
        delete row.routeReceipt;
        delete row.modelOutput;
      },
      expected: "fallback trigger is malformed",
    },
    {
      name: "paid success laundered into retryable failure",
      mutate: (row) => {
        row.status = "failed";
        row.terminal = true;
        row.detail = "forged retryable failure";
        row.fallbackTrigger = null;
        row.failureStage = "semantic-output";
        const ok = row.usages[0];
        ok.eventId = ok.eventId.replace("issue-1/receipt-1", "issue-2/receipt-1");
        row.usages.unshift({
          ...ok,
          eventId: ok.eventId.replace("issue-2/receipt-1", "issue-1/receipt-1"),
          status: "parse-failed",
        });
        row.attempts = 2;
        delete row.routeReceipt;
        delete row.modelOutput;
      },
      expected: "failed-artifact state is incoherent",
    },
    {
      name: "semantic parse failure relabeled nonterminal",
      mutate: (row) => {
        row.status = "failed";
        row.terminal = false;
        row.detail = "forged nonterminal semantic failure";
        row.fallbackTrigger = null;
        row.failureStage = "semantic-output";
        row.usages[0].status = "parse-failed";
        delete row.routeReceipt;
        delete row.modelOutput;
      },
      expected: "failed-artifact state is incoherent",
    },
    {
      name: "ok receipt hidden behind provider-failure state",
      mutate: (row) => {
        row.status = "failed";
        row.terminal = false;
        row.detail = "forged provider failure";
        row.fallbackTrigger = null;
        row.failureStage = "provider";
        delete row.routeReceipt;
        delete row.modelOutput;
      },
      expected: "failed-artifact state is incoherent",
    },
    {
      name: "no-trigger provider failure relabeled nonterminal",
      mutate: (row) => {
        row.status = "failed";
        row.terminal = false;
        row.detail = "forged retryable provider failure";
        row.fallbackTrigger = null;
        row.failureStage = "provider";
        row.usages[0].status = "error";
        delete row.routeReceipt;
        delete row.modelOutput;
      },
      expected: "failed-artifact state is incoherent",
    },
    {
      name: "wrong synthesis role",
      mutate: (row) => { row.usages[0].role = "extract-pass-a"; },
      expected: "receipt role/call/provider is inconsistent",
    },
    {
      name: "wrong synthesis call id",
      mutate: (row) => { row.usages[0].callId = "call_a_1"; },
      expected: "receipt role/call/provider is inconsistent",
    },
    {
      name: "wrong synthesis model",
      mutate: (row) => { row.usages[0].model = "grok-4.5"; },
      expected: "receipt role/call/provider is inconsistent",
    },
    {
      name: "successful route has no ok selected receipt",
      mutate: (row) => { row.usages[0].status = "parse-failed"; },
      expected: "successful route receipt is malformed",
    },
    {
      name: "attempt receipt mismatch",
      mutate: (row) => { row.attempts = 2; },
      expected: "attempt count does not equal the highest retained receipt issue",
    },
  ];
  const m = await mod();
  for (const [index, fixture] of fixtures.entries()) {
    const env = envFor();
    const doc = documentFor();
    const runId = `run_invalid_retained_synthesis_${index}`;
    const provider = installProvider(({ unit }) => ({
      value: unit === "A-synthesis" ? emptySynthesis() : nominatedPrimary(unit),
    }));
    try {
      await landPrimaryWindows(m, env, runId, doc, provider);
      const landed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(landed.slice.done, true, fixture.name);
      const key = m.passA.passASynthesisKey(runId);
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      fixture.mutate(artifact);
      const corrupted = JSON.stringify(artifact);
      await env.EVIDENCE.put(key, corrupted);

      provider.reset();
      const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, `${fixture.name}: exact-key authority forbids rebuy`);
      assertEq(refused.slice.terminalFailure, true, fixture.name);
      assert(
        refused.failedUnits.some((row) =>
          row.unit === "A-synthesis-artifact" && row.detail.includes(fixture.expected)),
        `${fixture.name}: ${JSON.stringify(refused.failedUnits)}`,
      );
      assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted, "invalid authority is not overwritten");
    } finally {
      provider.restore();
    }
  }
});

test("a fallback route receipt cannot bind its trigger and selected leg across different issues", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_cross_issue_route";
  const provider = installProvider(({ unit, body }) => {
    if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
    if (body.model === "grok-4.6") return { value: {}, status: 429 };
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.count("A-synthesis"), 2, "the synthesis route really used Grok then Flash");
    const key = m.passA.passASynthesisKey(runId);
    const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    const selectedUsage = artifact.usages.find((usage) => usage.provider === "deepseek");
    selectedUsage.eventId = selectedUsage.eventId.replace("issue-1/receipt-2", "issue-2/receipt-2");
    artifact.attempts = 2;
    const corrupted = JSON.stringify(artifact);
    await env.EVIDENCE.put(key, corrupted);
    provider.reset();
    const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "cross-issue route authority cannot buy another synthesis call");
    assertEq(refused.slice.terminalFailure, true);
    assert(
      refused.failedUnits.some((row) => row.detail.includes("successful route receipt is malformed")),
      JSON.stringify(refused.failedUnits),
    );
    assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted);
  } finally {
    provider.restore();
  }
});

test("primary and synthesis Flash retries preserve one closed authorization chain across issues", async () => {
  const m = await mod();

  {
    const env = envFor({
      EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
      EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    });
    const doc = documentFor();
    let flashAttempts = 0;
    const provider = installProvider(({ body }) => {
      if (body.model === "grok-4.6") return { value: {}, status: 502 };
      flashAttempts += 1;
      return flashAttempts === 1
        ? { value: {}, status: 502 }
        : { value: emptyPrimary() };
    });
    try {
      const failed = await m.passA.runPassA(env, "run_primary_flash_retry", doc, "neutral.docx");
      assertEq(failed.slice.terminalFailure, false, "issue-1 Flash failure remains bounded retryable authority");
      const recovered = await m.passA.runPassA(env, "run_primary_flash_retry", doc, "neutral.docx");
      assertEq(recovered.slice.done, true);
      assertEq(recovered.providerIndependence, "reduced-same-provider-fallback");
      assertEq(provider.calls.filter((call) => call.body.model === "grok-4.6").length, 1);
      assertEq(provider.calls.filter((call) => call.body.model === "deepseek-v4-flash").length, 2);
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, "run_primary_flash_retry", doc, "neutral.docx");
      assertEq(provider.calls.length, 0, "writer-produced primary retry success is valid reclaim authority");
      assertEq(reclaimed.providerIndependence, "reduced-same-provider-fallback");
    } finally {
      provider.restore();
    }
  }

  {
    const env = envFor({ EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2" });
    const doc = documentFor();
    let synthesisFlashAttempts = 0;
    const provider = installProvider(({ unit, body }) => {
      if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
      if (body.model === "grok-4.6") return { value: {}, status: 502 };
      synthesisFlashAttempts += 1;
      return synthesisFlashAttempts === 1
        ? { value: {}, status: 502 }
        : { value: emptySynthesis() };
    });
    try {
      await landPrimaryWindows(m, env, "run_synthesis_flash_retry", doc, provider);
      const failed = await m.passA.runPassA(env, "run_synthesis_flash_retry", doc, "neutral.docx");
      assertEq(failed.slice.synthesisState, "pending");
      const recovered = await m.passA.runPassA(env, "run_synthesis_flash_retry", doc, "neutral.docx");
      assertEq(recovered.slice.done, true);
      assertEq(recovered.slice.synthesisState, "reduced-provider-independence");
      assertEq(provider.count("A-synthesis"), 3, "one Grok trigger and two Flash issues were bought");
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, "run_synthesis_flash_retry", doc, "neutral.docx");
      assertEq(provider.calls.length, 0, "writer-produced synthesis retry success is valid reclaim authority");
      assertEq(reclaimed.slice.synthesisState, "reduced-provider-independence");
    } finally {
      provider.restore();
    }
  }
});

test("fallback retry authority rejects a missing Flash issue, extra Grok purchase, and ineligible trigger", async () => {
  const m = await mod();
  const mutations = [
    {
      name: "missing issue-1 Flash receipt",
      apply: (artifact) => {
        artifact.usages = artifact.usages.filter((usage) =>
          !usage.eventId.includes("issue-1/receipt-2")
        );
      },
    },
    {
      name: "intervening Grok purchase",
      apply: (artifact) => {
        const trigger = artifact.usages.find((usage) => usage.provider === "grok");
        artifact.usages.push({
          ...trigger,
          eventId: trigger.eventId.replace("issue-1/receipt-1", "issue-2/receipt-1"),
        });
      },
    },
    {
      name: "invalid-content trigger without verified model identity",
      apply: (artifact) => {
        artifact.routeReceipt.trigger.failureKind = "invalid-content";
        const trigger = artifact.usages.find((usage) => usage.provider === "grok");
        trigger.usageSource = "unverified-model-rate-ceiling";
      },
    },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const env = envFor({
      EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
      EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    });
    const doc = documentFor();
    let flashAttempts = 0;
    const provider = installProvider(({ body }) => {
      if (body.model === "grok-4.6") return { value: {}, status: 502 };
      flashAttempts += 1;
      return flashAttempts === 1 ? { value: {}, status: 502 } : { value: emptyPrimary() };
    });
    try {
      await m.passA.runPassA(env, `run_primary_chain_mutation_${index}`, doc, "neutral.docx");
      await m.passA.runPassA(env, `run_primary_chain_mutation_${index}`, doc, "neutral.docx");
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      mutation.apply(artifact);
      const corrupted = JSON.stringify(artifact);
      await env.EVIDENCE.put(key, corrupted);
      provider.reset();
      const refused = await m.passA.runPassA(
        env, `run_primary_chain_mutation_${index}`, doc, "neutral.docx",
      );
      assertEq(provider.calls.length, 0, mutation.name);
      assertEq(refused.slice.terminalFailure, true, mutation.name);
      assert(refused.failedUnits.some((row) => row.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID")));
      assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted);
    } finally {
      provider.restore();
    }
  }
});

test("same-run synthesis request or policy identity drift is terminal, never a fresh purchase", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_policy_identity_drift";
  const provider = installProvider(({ unit }) => ({
    value: unit === "A-synthesis" ? emptySynthesis() : nominatedPrimary(unit),
  }));
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    await m.passA.runPassA(env, runId, doc, "neutral.docx");
    const before = await (await env.EVIDENCE.get(m.passA.passASynthesisKey(runId))).text();
    env.EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES = "44999";
    provider.reset();
    const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "policy drift cannot overwrite exact-key paid authority");
    assertEq(refused.slice.terminalFailure, true);
    assert(
      refused.failedUnits.some((row) => row.detail.includes("envelope identity differs")),
      JSON.stringify(refused.failedUnits),
    );
    assertEq(await (await env.EVIDENCE.get(m.passA.passASynthesisKey(runId))).text(), before);
  } finally {
    provider.restore();
  }
});

test("developer extraction refuses a multiwindow document before Pass B while synthesis is pending", async () => {
  const m = await mod();
  const env = envFor({ DEV_SEED: "enabled" });
  const provider = installProvider(({ unit }) => ({
    value: unit === "A-synthesis" ? emptySynthesis() : emptyPrimary(),
  }));
  try {
    const bytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const response = await m.router.route(new Request("https://fixture.invalid/api/v2/dev/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentBase64: Buffer.from(bytes).toString("base64"),
        documentName: "unseen-multiwindow-questionnaire.docx",
        wait: false,
      }),
    }), env, {});
    assertEq(response.status, 200);
    const runId = response.headers.get("x-run-id");
    assert(runId, "the async developer extraction exposes its durable run id");
    await response.text();

    const resultResponse = await m.router.route(new Request(
      `https://fixture.invalid/api/v2/dev/extract?runId=${encodeURIComponent(runId)}`,
    ), env, {});
    assertEq(resultResponse.status, 200);
    const result = await resultResponse.json();
    assertEq(result.mode, "pass-B-refused");
    assertEq(result.reason, "PASS_A_INCOMPLETE");
    assert(result.detail.includes("no Pass-B purchase was made"));
    assert(
      provider.calls.filter((call) => call.unit.startsWith("A-w")).length > 1,
      "the fixture really crossed a Pass-A window boundary",
    );
    assertEq(
      provider.calls.filter((call) => call.role.startsWith("extract-pass-b")).length,
      0,
      "an unfinished synthesis unit cannot authorize Pass B",
    );
    const loadedCheckpoint = await m.checkpoint.loadCheckpoint(env, runId);
    assert(loadedCheckpoint !== null);
    const checkpoint = loadedCheckpoint.checkpoint;
    assert(checkpoint.contract.state !== "sealed", "the developer route did not seal a partial contract");
  } finally {
    provider.restore();
  }
});

test("developer resume rejects same-parsed different source bytes without overwriting durable state", async () => {
  const m = await mod();
  const env = envFor({
    DEV_SEED: "enabled",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
  });
  const provider = installProvider(() => ({ value: emptyPrimary() }));
  try {
    const original = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const replacement = zipSync(unzipSync(original), { mtime: "2040-01-02T03:04:06.000Z" });
    assert(await m.hash.sha256Hex(original) !== await m.hash.sha256Hex(replacement));
    assertEq(
      m.hash.canonicalJson(m.docxBlocks.parseDocxBlocks(original)),
      m.hash.canonicalJson(m.docxBlocks.parseDocxBlocks(replacement)),
      "the resume counterexample differs only at raw source-byte authority",
    );

    const fresh = await m.router.route(new Request("https://fixture.invalid/api/v2/dev/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentBase64: Buffer.from(original).toString("base64"),
        documentName: "neutral-resume-questionnaire.docx",
        passOnly: "A",
        wait: false,
      }),
    }), env, {});
    assertEq(fresh.status, 200);
    const runId = fresh.headers.get("x-run-id");
    await fresh.text();

    const documentKey = m.keys.inputDocumentKey(runId);
    const envelopeKey = m.keys.envelopeKey(runId);
    const resultKey = m.keys.k("runs", runId, "extraction", "dev-result.json");
    const beforeDocument = new Uint8Array(await (await env.EVIDENCE.get(documentKey)).arrayBuffer());
    const beforeEnvelope = await (await env.EVIDENCE.get(envelopeKey)).text();
    const beforeResult = await (await env.EVIDENCE.get(resultKey)).text();
    const callsBeforeResume = provider.calls.length;

    const resumed = await m.router.route(new Request("https://fixture.invalid/api/v2/dev/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        documentBase64: Buffer.from(replacement).toString("base64"),
        documentName: "neutral-resume-questionnaire.docx",
        passOnly: "A",
        wait: false,
      }),
    }), env, {});
    assertEq(resumed.status, 409);
    const refusal = await resumed.json();
    assertEq(refusal.error.code, "extraction-document-source-authority-invalid");
    assert(String(refusal.error.detail).includes("DEV_RESUME_DOCUMENT_MISMATCH"));
    assertEq(provider.calls.length, callsBeforeResume, "a mismatched resume performs zero provider work");
    assertEq(
      await m.hash.sha256Hex(new Uint8Array(await (await env.EVIDENCE.get(documentKey)).arrayBuffer())),
      await m.hash.sha256Hex(beforeDocument),
      "the original submitted source is not overwritten",
    );
    assertEq(await (await env.EVIDENCE.get(envelopeKey)).text(), beforeEnvelope);
    assertEq(await (await env.EVIDENCE.get(resultKey)).text(), beforeResult);
  } finally {
    provider.restore();
  }
});

test("production synthesis knobs and prompt schema are exact and fingerprinted", async () => {
  const m = await mod();
  const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert(/"EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES"\s*:\s*"45000"/.test(wrangler));
  assert(/"EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES"\s*:\s*"2"/.test(wrangler));
  assert(m.contractReuse.EXTRACTION_POLICY_KEYS.includes("EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES"));
  assert(m.contractReuse.EXTRACTION_POLICY_KEYS.includes("EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES"));
  const base = envFor();
  const fingerprint = await m.contractReuse.extractionPolicyFingerprint(base);
  assert(
    fingerprint !== await m.contractReuse.extractionPolicyFingerprint(envFor({
      EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "44999",
    })),
    "changing the exact wire ceiling invalidates extraction reuse",
  );
  assert(
    fingerprint !== await m.contractReuse.extractionPolicyFingerprint(envFor({
      EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "3",
    })),
    "changing the synthesis issue ceiling invalidates extraction reuse",
  );

  const prompts = readFileSync(new URL("../../src/extract/prompts.ts", import.meta.url), "utf8");
  const canonical =
    "instruction|validation|skip-rule|terminate|randomization|piping|carry-forward|calculation|loop|option-list|question";
  assertEq(prompts.split(canonical).length - 1, 2, "primary and synthesis schemas share one canonical enum");
  assert(!prompts.includes("navigation|order"), "no prompt offers constructs the strict decoder rejects");
});

});
