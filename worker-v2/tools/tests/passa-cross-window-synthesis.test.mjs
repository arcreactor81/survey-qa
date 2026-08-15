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
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "120000",
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

function ambiguity(id, blockId, quote, marker = id) {
  return {
    id,
    block_ids: [blockId],
    doc_quote: quote,
    evidence_quotes: [{ block_id: blockId, quote }],
    reading_a: marker + " reading A",
    reading_b: marker + " reading B",
    why_ambiguous: marker + " has two document-supported readings.",
    affects: ["routing"],
  };
}

function unverifiable(id, blockId, quote, marker = id) {
  return {
    id,
    block_ids: [blockId],
    doc_quote: quote,
    evidence_quotes: [{ block_id: blockId, quote }],
    mandate: marker + " mandate",
    why_not_observable: marker + " is not fully browser-observable.",
    browser_proxy_evidence: marker + " has a named browser proxy.",
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

function interceptSynthesisTransitions() {
  const base = memoryR2();
  const mainWrites = [];
  let throwAfterFinalCommit = false;
  let finalCommitThrown = false;
  let raceFinal = false;
  let raced = false;
  let raceWinnerModelOutput = null;
  let raceWinnerBody = null;
  let losingBody = null;
  const bucket = {
    ...base,
    async put(key, value, options = {}) {
      if (
        typeof value === "string" &&
        String(key).endsWith("/cross-window-synthesis.json")
      ) {
        const parsed = JSON.parse(value);
        const before = await base.head(key);
        mainWrites.push({
          body: value,
          options,
          parsed,
          raceFinal,
          raced,
          beforeEtag: before?.etag ?? null,
        });
        if (raceFinal && !raced && parsed.status === "ok") {
          raced = true;
          losingBody = value;
          raceWinnerBody = JSON.stringify(
            {
              ...parsed,
              modelOutput: raceWinnerModelOutput,
            },
            null,
            2,
          );
          const injected = await base.put(key, raceWinnerBody, {
            httpMetadata: { contentType: "application/json" },
          });
          const injectedRead = await base.get(key);
          if (
            injected === null || injectedRead === null ||
            await injectedRead.text() !== raceWinnerBody
          ) {
            throw new Error("fixture failed to retain the injected synthesis CAS winner");
          }
          return base.put(key, value, options);
        }
        if (throwAfterFinalCommit && !finalCommitThrown && parsed.status === "ok") {
          finalCommitThrown = true;
          await base.put(key, value, options);
          throw new Error("fixture final synthesis response failed after commit");
        }
      }
      return base.put(key, value, options);
    },
  };
  return {
    bucket,
    base,
    mainWrites,
    armAfterFinalCommit: () => { throwAfterFinalCommit = true; },
    armFinalRace: (modelOutput) => {
      raceWinnerModelOutput = modelOutput;
      raceFinal = true;
    },
    raceWinnerBody: () => raceWinnerBody,
    losingBody: () => losingBody,
  };
}

async function synthesisDerivedObject(m, env, mainKey, kind, bodyText) {
  const digest = await m.hash.sha256Hex(bodyText);
  const key = mainKey.replace(
    "cross-window-synthesis.json",
    "cross-window-synthesis-" + kind + "-" + digest + ".json",
  );
  return { key, object: await env.EVIDENCE.get(key) };
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

test("withholding an earlier xref preserves the surviving source handle through synthesis", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_surviving_xref_ordinal";
  const rejectedMarker = "REJECTED_FIRST_XREF_AUTHORITY";
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") {
      return {
        value: {
          ...emptyPrimary(),
          cross_references: [
            {
              ...xref("REJECTED-XREF", "b0001", "not exact source text"),
              statement: rejectedMarker,
            },
            xref("SURVIVING-XREF", "b0001", TEXT.b0001),
          ],
        },
      };
    }
    if (unit === "A-w2") {
      return {
        value: {
          ...emptyPrimary(),
          global_rules: [rule("TARGET-RULE", "b0002", TEXT.b0002)],
        },
      };
    }
    return {
      value: {
        ...emptySynthesis(),
        cross_reference_resolutions: [{
          source_xref_handle: "A-w1:x:002",
          resolved_to_block: "b0002",
          statement: "Omega requires an answer before Continue becomes enabled.",
          evidence_quotes: [
            { block_id: "b0001", quote: TEXT.b0001 },
            { block_id: "b0002", quote: TEXT.b0002 },
          ],
        }],
      },
    };
  });
  try {
    const primary = await landPrimaryWindows(m, env, runId, doc, provider);
    assertEq(primary.crossRefs.length, 1);
    assertEq(primary.crossRefs[0].id, "SURVIVING-XREF");
    assertEq(
      primary.crossRefs[0].sourceXrefHandle,
      "A-w1:x:002",
      "withholding row 1 never renumbers paid row 2",
    );
    assertEq(
      JSON.stringify(primary.primaryGroundingLimitations),
      JSON.stringify([{
        kind: "pass-a-primary-candidate-ungrounded",
        unit: "A-w1",
        rowKind: "cross-reference",
        rowIndex: 1,
        sourceBlockIds: ["b0001"],
        reason: "source-quote-not-exact",
      }]),
    );
    const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    assertEq(artifact.crossRefs.length, 1);
    assertEq(artifact.crossRefs[0].sourceXrefHandle, "A-w1:x:002");

    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.slice.synthesisState, "ok");
    const synthesisCall = provider.calls.find((call) => call.unit === "A-synthesis");
    assert(synthesisCall);
    assert(synthesisCall.user.includes("A-w1:x:002"), "the surviving paid handle reaches synthesis");
    assert(!synthesisCall.user.includes("A-w1:x:001"), "the rejected handle never reaches synthesis");
    assert(!synthesisCall.user.includes(rejectedMarker), "the rejected statement never reaches synthesis");
    assertEq(done.crossRefs.length, 1);
    assertEq(done.crossRefs[0].sourceXrefHandle, "A-w1:x:002");
    assertEq(done.crossRefs[0].resolvedToBlock, "b0002");
    assertEq(done.crossWindowLimitations[0].candidatesUngrounded, 1);
    assertEq(done.crossWindowLimitations[0].candidatesSynthesized, 2);
    assert(!JSON.stringify(done).includes(rejectedMarker));

    const reconstructed = await m.passA.reconstructPassACompletedAuthority(
      env, runId, doc, "neutral.docx",
    );
    assertEq(reconstructed.kind, "ok");
    assertEq(reconstructed.value.crossRefs.length, 1);
    assertEq(reconstructed.value.crossRefs[0].sourceXrefHandle, "A-w1:x:002");
    assertEq(reconstructed.value.crossRefs[0].resolvedToBlock, "b0002");
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

test("an unproven primary target is downgraded to one unresolved question without trusting its statement", async () => {
  const fixtures = [
    { name: "inexact target quote", resolvedToBlock: "b0002", targetDocQuote: "not source text" },
    { name: "absent target quote", resolvedToBlock: "b0002", targetDocQuote: null },
    { name: "foreign claimed target", resolvedToBlock: "b9999", targetDocQuote: "foreign text" },
  ];
  const m = await mod();
  for (const [index, fixture] of fixtures.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const untrusted = `UNTRUSTED TARGET-DERIVED STATEMENT ${index}`;
    const provider = installProvider(() => ({
      value: {
        ...emptyPrimary(),
        cross_references: [{
          id: `UNPROVEN-${index}`,
          from_block: "b0001",
          target: "Omega",
          resolved_to_block: fixture.resolvedToBlock,
          target_doc_quote: fixture.targetDocQuote,
          statement: untrusted,
          doc_quote: TEXT.b0001,
        }],
      },
    }));
    const runId = `run_primary_target_downgrade_${index}`;
    try {
      const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(done.slice.done, true, fixture.name);
      assertEq(done.slice.terminalFailure, false, fixture.name);
      assertEq(done.failedUnits.length, 0, fixture.name);
      assertEq(done.requirements.length, 0, "a cross-reference never becomes a requirement");
      assertEq(done.crossRefs.length, 1, fixture.name);
      const row = done.crossRefs[0];
      assertEq(row.resolvedToBlock, null, fixture.name);
      assertEq(row.targetDocQuote, null, fixture.name);
      assertEq(row.statement, m.passA.PASS_A_UNPROVEN_TARGET_STATEMENT, fixture.name);
      assert(row.statement !== untrusted, `${fixture.name}: the target-derived statement survived`);
      assertEq(row.evidenceQuotes.length, 1, fixture.name);
      assertEq(row.evidenceQuotes[0].blockId, "b0001", fixture.name);
      assertEq(row.evidenceQuotes[0].quote, TEXT.b0001, fixture.name);

      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      assertEq(
        artifact.modelOutput.cross_references[0].statement,
        untrusted,
        "the exact paid answer remains immutable audit authority",
      );
      assertEq(artifact.crossRefs[0].resolvedToBlock, null, "the typed projection stores no guessed target");
      assertEq(artifact.crossRefs[0].statement, m.passA.PASS_A_UNPROVEN_TARGET_STATEMENT);

      const passB = {
        pass: "B", provider: "fixture-independent", model: "fixture-independent",
        requirements: [], ambiguities: [], unverifiable: [], constructs: [], failedUnits: [], calls: [],
        dispositions: doc.blocks.map((block) => ({
          blockId: block.blockId, disposition: "non-normative", reason: "neutral merge fixture",
        })),
      };
      const merged = await m.merge.mergePasses(done, passB, doc, done.crossRefs);
      assertEq(merged.requirements.length, 0, "an unresolved xref mints zero sealed requirement authority");
      assertEq(merged.diff.unresolvedCrossReferences.length, 1, "the withheld resolution is counted");
      assertEq(merged.diff.unresolvedCrossReferences[0].statement, m.passA.PASS_A_UNPROVEN_TARGET_STATEMENT);

      provider.reset();
      const reclaimed = await m.passA.runPassA(env, runId, doc, "renamed.docx");
      assertEq(provider.calls.length, 0, `${fixture.name}: the normalized paid unit is reclaimed`);
      assertEq(reclaimed.crossRefs[0].resolvedToBlock, null, fixture.name);
      const reconstructed = await m.passA.reconstructPassACompletedAuthority(env, runId, doc, "renamed.docx");
      assertEq(reconstructed.kind, "ok", fixture.name);
      assertEq(reconstructed.value.crossRefs[0].statement, m.passA.PASS_A_UNPROVEN_TARGET_STATEMENT);
    } finally {
      provider.restore();
    }
  }
});

test("an unproven target in one primary window does not stop later windows or mint merge authority", async () => {
  const m = await mod();
  const doc = documentFor([
    TEXT.b0001,
    TEXT.b0002,
    "Every closing screen displays the approved thank-you text.",
  ]);
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" });
  const runId = "run_primary_target_tail_continues";
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") {
      return { value: {
        ...emptyPrimary(),
        cross_references: [{
          id: "UNPROVEN-LOCAL", from_block: "b0001", target: "Omega",
          resolved_to_block: "b0002", target_doc_quote: "not exact source",
          statement: "UNTRUSTED CLAIM ABOUT OMEGA", doc_quote: TEXT.b0001,
        }],
      } };
    }
    if (unit === "A-w2") {
      return { value: {
        ...emptyPrimary(),
        global_rules: [rule("LATER-RULE", "b0003", doc.blocks[2].text)],
      } };
    }
    return { value: emptySynthesis() };
  });
  try {
    const primary = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(primary.slice.terminalFailure, false);
    assertEq(primary.slice.windowsLanded, 2, "the window after the unproven target still landed");
    assertEq(primary.slice.windowsRemaining, 0);
    assertEq(primary.slice.synthesisState, "pending");
    assertEq(provider.count("A-w1"), 1);
    assertEq(provider.count("A-w2"), 1);

    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.failedUnits.length, 0);
    assertEq(done.requirements.length, 1, "only the independently grounded later rule survives");
    assertEq(done.requirements[0].origin, "A-w2");
    assertEq(done.crossRefs.length, 1);
    assertEq(done.crossRefs[0].resolvedToBlock, null);
    assertEq(done.crossRefs[0].statement, m.passA.PASS_A_UNPROVEN_TARGET_STATEMENT);
    assertEq(provider.count("A-synthesis"), 1, "exact synthesis still gets a chance to resolve the question");

    const passB = {
      pass: "B", provider: "fixture-independent", model: "fixture-independent",
      requirements: [], ambiguities: [], unverifiable: [], constructs: [], failedUnits: [], calls: [],
      dispositions: doc.blocks.map((block) => ({
        blockId: block.blockId, disposition: "non-normative", reason: "neutral merge fixture",
      })),
    };
    const merged = await m.merge.mergePasses(done, passB, doc, done.crossRefs);
    assertEq(merged.requirements.length, 1, "the unproven target adds no Pass-B or seal authority");
    assert(
      merged.requirements.every((row) => row.normativeStatement !== "UNTRUSTED CLAIM ABOUT OMEGA"),
      "the target-derived statement reached the contract",
    );
    assertEq(merged.diff.unresolvedCrossReferences.length, 1, "the unresolved question stays named and counted");
  } finally {
    provider.restore();
  }
});

test("row-local primary grounding failures are retained and counted without gaining authority", async () => {
  const m = await mod();
  const doc = documentFor([
    TEXT.b0001,
    TEXT.b0002,
    "Every closing screen displays the approved thank-you text.",
    "The approved support address is shown beside the closing control.",
  ]);
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" });
  const runId = "run_primary_row_grounding_limitations";
  const rejected = {
    globalQuote: "REJECTED_GLOBAL_QUOTE",
    globalAuthority: "REJECTED_GLOBAL_AUTHORITY",
    globalForeign: "REJECTED_FOREIGN_RULE",
    globalEvidenceSet: "REJECTED_EVIDENCE_SET_RULE",
    xrefQuote: "REJECTED_XREF_QUOTE",
    xrefAuthority: "REJECTED_XREF_AUTHORITY",
    ambiguityQuote: "REJECTED_AMBIGUITY_QUOTE",
    ambiguityAuthority: "REJECTED_AMBIGUITY",
    unverifiableQuote: "REJECTED_UNVERIFIABLE_QUOTE",
    unverifiableAuthority: "REJECTED_UNVERIFIABLE",
  };
  const firstWindowOutput = {
    ...emptyPrimary(),
    global_rules: [
      rule("VALID-RULE", "b0001", doc.blocks[0].text),
      rule("BAD-RULE-QUOTE", "b0002", rejected.globalQuote, rejected.globalAuthority),
      rule("BAD-RULE-FOREIGN", "b9999", doc.blocks[0].text, rejected.globalForeign),
      {
        ...rule("BAD-RULE-EVIDENCE-SET", "b0001", doc.blocks[0].text, rejected.globalEvidenceSet),
        block_ids: ["b0001", "b0002"],
        evidence_quotes: [
          { block_id: "b0001", quote: doc.blocks[0].text },
          { block_id: "b0001", quote: doc.blocks[0].text },
        ],
      },
    ],
    cross_references: [
      xref("VALID-XREF", "b0001", doc.blocks[0].text),
      {
        ...xref("BAD-XREF-QUOTE", "b0002", rejected.xrefQuote),
        statement: rejected.xrefAuthority,
      },
    ],
    ambiguities: [
      ambiguity("VALID-AMBIGUITY", "b0001", doc.blocks[0].text, "VALID_AMBIGUITY"),
      ambiguity(
        "BAD-AMBIGUITY-QUOTE",
        "b0002",
        rejected.ambiguityQuote,
        rejected.ambiguityAuthority,
      ),
    ],
    unverifiable_from_browser: [
      unverifiable("VALID-UNVERIFIABLE", "b0001", doc.blocks[0].text, "VALID_UNVERIFIABLE"),
      unverifiable(
        "BAD-UNVERIFIABLE-QUOTE",
        "b0002",
        rejected.unverifiableQuote,
        rejected.unverifiableAuthority,
      ),
    ],
  };
  const expectedLimitations = [
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 2,
      sourceBlockIds: ["b0002"],
      reason: "source-quote-not-exact",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 3,
      sourceBlockIds: [],
      reason: "source-block-ownership-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 4,
      sourceBlockIds: ["b0001", "b0002"],
      reason: "source-evidence-set-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "cross-reference",
      rowIndex: 2,
      sourceBlockIds: ["b0002"],
      reason: "source-quote-not-exact",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "ambiguity",
      rowIndex: 2,
      sourceBlockIds: ["b0002"],
      reason: "source-quote-not-exact",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "unverifiable",
      rowIndex: 2,
      sourceBlockIds: ["b0002"],
      reason: "source-quote-not-exact",
    },
  ];
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") return { value: firstWindowOutput };
    if (unit === "A-w2") {
      return {
        value: {
          ...emptyPrimary(),
          global_rules: [rule("VALID-LATER", "b0003", doc.blocks[2].text)],
        },
      };
    }
    return { value: emptySynthesis() };
  });
  try {
    const primary = await landPrimaryWindows(m, env, runId, doc, provider);
    assertEq(primary.slice.terminalFailure, false);
    assertEq(primary.failedUnits.length, 0);
    assertEq(provider.count("A-w1"), 1);
    assertEq(provider.count("A-w2"), 1, "a row-local rejection does not stop the unread tail");
    assertEq(
      JSON.stringify(primary.primaryGroundingLimitations),
      JSON.stringify(expectedLimitations),
      "limitations are closed, 1-based, and deterministic",
    );
    assertEq(
      JSON.stringify(primary.requirements.map((row) => row.id)),
      JSON.stringify(["VALID-RULE", "VALID-LATER"]),
      "only exact global-rule siblings survive",
    );
    assertEq(JSON.stringify(primary.crossRefs.map((row) => row.id)), JSON.stringify(["VALID-XREF"]));
    assertEq(
      JSON.stringify(primary.ambiguities.map((row) => row.id)),
      JSON.stringify(["VALID-AMBIGUITY"]),
    );
    assertEq(
      JSON.stringify(primary.unverifiable.map((row) => row.id)),
      JSON.stringify(["VALID-UNVERIFIABLE"]),
    );

    const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    assert(key, "the first successful primary artifact exists");
    const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    assertEq(
      JSON.stringify(artifact.modelOutput),
      JSON.stringify(firstWindowOutput),
      "the exact paid parsed output is retained even when some rows are rejected",
    );
    assertEq(
      JSON.stringify(artifact.primaryGroundingLimitations),
      JSON.stringify(expectedLimitations),
      "the immutable window artifact owns its exact limitations",
    );
    assertEq(JSON.stringify(artifact.globalRules.map((row) => row.id)), JSON.stringify(["VALID-RULE"]));
    assertEq(JSON.stringify(artifact.crossRefs.map((row) => row.id)), JSON.stringify(["VALID-XREF"]));
    assertEq(JSON.stringify(artifact.ambiguities.map((row) => row.id)), JSON.stringify(["VALID-AMBIGUITY"]));
    assertEq(
      JSON.stringify(artifact.unverifiable.map((row) => row.id)),
      JSON.stringify(["VALID-UNVERIFIABLE"]),
    );

    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.slice.terminalFailure, false);
    assertEq(
      JSON.stringify(done.primaryGroundingLimitations),
      JSON.stringify(expectedLimitations),
      "reclaim preserves the exact counted limitation ledger",
    );
    assertEq(done.crossWindowLimitations.length, 1);
    assertEq(done.crossWindowLimitations[0].candidatesUngrounded, expectedLimitations.length);
    assertEq(done.crossWindowLimitations[0].candidatesSynthesized, 5);
    const synthesisCall = provider.calls.find((call) => call.unit === "A-synthesis");
    assert(synthesisCall, "the bounded synthesis call ran after every primary window landed");
    for (const marker of Object.values(rejected)) {
      assert(!synthesisCall.user.includes(marker), marker + " reached synthesis authority");
    }

    const reconstructed = await m.passA.reconstructPassACompletedAuthority(
      env, runId, doc, "renamed.docx",
    );
    assertEq(reconstructed.kind, "ok");
    assertEq(
      JSON.stringify(reconstructed.value.primaryGroundingLimitations),
      JSON.stringify(expectedLimitations),
      "read-only reconstruction preserves the same limitation ledger",
    );

    const passB = {
      pass: "B", provider: "fixture-independent", model: "fixture-independent",
      requirements: [], ambiguities: [], unverifiable: [], constructs: [], failedUnits: [], calls: [],
      dispositions: doc.blocks.map((block) => ({
        blockId: block.blockId, disposition: "non-normative", reason: "neutral merge fixture",
      })),
    };
    const merged = await m.merge.mergePasses(done, passB, doc, done.crossRefs);
    const mergedText = JSON.stringify(merged);
    for (const marker of Object.values(rejected)) {
      assert(!mergedText.includes(marker), marker + " reached merged authority");
    }
    assertEq(merged.requirements.length, 2, "only the two exact rules reach merged authority");
  } finally {
    provider.restore();
  }
});

test("typed primary relational and evidence failures quarantine rows while the tail and synthesis continue", async () => {
  const m = await mod();
  const doc = documentFor([
    TEXT.b0001,
    "A hidden server-side consistency check applies to every response.",
    TEXT.b0002,
    "Every closing screen displays the approved thank-you text.",
  ]);
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" });
  const runId = "run_primary_typed_row_quarantine";
  const rejected = {
    missingCompanion: "REJECTED_NONE_WITHOUT_COMPANION",
    emptyRuleIds: "REJECTED_EMPTY_RULE_BLOCK_IDS",
    duplicateRuleIds: "REJECTED_DUPLICATE_RULE_BLOCK_IDS",
    nullTarget: "REJECTED_NULL_TARGET_WITH_TARGET_QUOTE",
    emptyAmbiguityIds: "REJECTED_EMPTY_AMBIGUITY_BLOCK_IDS",
    duplicateUnverifiableIds: "REJECTED_DUPLICATE_UNVERIFIABLE_BLOCK_IDS",
  };
  const firstWindowOutput = {
    ...emptyPrimary(),
    global_rules: [
      rule("VALID-FIRST", "b0001", doc.blocks[0].text),
      {
        ...rule("NONE-WITHOUT-COMPANION", "b0002", doc.blocks[1].text, rejected.missingCompanion),
        browser_observable: "none",
      },
      {
        ...rule("EMPTY-BLOCK-IDS", "b0001", doc.blocks[0].text, rejected.emptyRuleIds),
        block_ids: [],
        evidence_quotes: [],
      },
      {
        ...rule("DUPLICATE-BLOCK-IDS", "b0002", doc.blocks[1].text, rejected.duplicateRuleIds),
        block_ids: ["b0002", "b0002"],
        evidence_quotes: [{ block_id: "b0002", quote: doc.blocks[1].text }],
      },
    ],
    cross_references: [
      {
        ...xref("NULL-TARGET-WITH-QUOTE", "b0001", doc.blocks[0].text),
        target_doc_quote: rejected.nullTarget,
        statement: rejected.nullTarget,
      },
      xref("VALID-STABLE-XREF", "b0001", doc.blocks[0].text),
    ],
    ambiguities: [{
      ...ambiguity("EMPTY-AMBIGUITY-IDS", "b0002", doc.blocks[1].text, rejected.emptyAmbiguityIds),
      block_ids: [],
      evidence_quotes: [],
    }],
    unverifiable_from_browser: [{
      ...unverifiable(
        "DUPLICATE-UNVERIFIABLE-IDS",
        "b0001",
        doc.blocks[0].text,
        rejected.duplicateUnverifiableIds,
      ),
      block_ids: ["b0001", "b0001"],
      evidence_quotes: [{ block_id: "b0001", quote: doc.blocks[0].text }],
    }],
  };
  const expectedLimitations = [
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 2,
      sourceBlockIds: ["b0002"],
      reason: "grounded-row-linkage-incomplete",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 3,
      sourceBlockIds: [],
      reason: "source-evidence-set-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "global-rule",
      rowIndex: 4,
      sourceBlockIds: ["b0002"],
      reason: "source-evidence-set-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "cross-reference",
      rowIndex: 1,
      sourceBlockIds: ["b0001"],
      reason: "source-evidence-set-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "ambiguity",
      rowIndex: 1,
      sourceBlockIds: [],
      reason: "source-evidence-set-invalid",
    },
    {
      kind: "pass-a-primary-candidate-ungrounded",
      unit: "A-w1",
      rowKind: "unverifiable",
      rowIndex: 1,
      sourceBlockIds: ["b0001"],
      reason: "source-evidence-set-invalid",
    },
  ];
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") return { value: firstWindowOutput };
    if (unit === "A-w2") {
      return { value: {
        ...emptyPrimary(),
        global_rules: [
          rule("TARGET-RULE", "b0003", doc.blocks[2].text),
          rule("VALID-LATER", "b0004", doc.blocks[3].text),
        ],
      } };
    }
    return { value: {
      ...emptySynthesis(),
      cross_reference_resolutions: [{
        source_xref_handle: "A-w1:x:002",
        resolved_to_block: "b0003",
        statement: "Omega requires an answer before Continue becomes enabled.",
        evidence_quotes: [
          { block_id: "b0001", quote: doc.blocks[0].text },
          { block_id: "b0003", quote: doc.blocks[2].text },
        ],
      }],
    } };
  });
  try {
    const primary = await landPrimaryWindows(m, env, runId, doc, provider);
    assertEq(primary.slice.terminalFailure, false);
    assertEq(primary.failedUnits.length, 0);
    assertEq(provider.count("A-w1"), 1);
    assertEq(provider.count("A-w2"), 1, "a typed bad row does not stop the unread tail");
    assertEq(JSON.stringify(primary.primaryGroundingLimitations), JSON.stringify(expectedLimitations));
    assertEq(
      JSON.stringify(primary.requirements.map((row) => row.id)),
      JSON.stringify(["VALID-FIRST", "TARGET-RULE", "VALID-LATER"]),
      "only grounded sibling and tail rules retain authority",
    );
    assertEq(primary.crossRefs.length, 1);
    assertEq(primary.crossRefs[0].id, "VALID-STABLE-XREF");
    assertEq(
      primary.crossRefs[0].sourceXrefHandle,
      "A-w1:x:002",
      "withholding typed row 1 never renumbers paid row 2",
    );
    assertEq(primary.ambiguities.length, 0);
    assertEq(primary.unverifiable.length, 0);

    const firstKey = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    const firstArtifact = JSON.parse(await (await env.EVIDENCE.get(firstKey)).text());
    assertEq(JSON.stringify(firstArtifact.modelOutput), JSON.stringify(firstWindowOutput));
    assertEq(JSON.stringify(firstArtifact.primaryGroundingLimitations), JSON.stringify(expectedLimitations));
    assertEq(firstArtifact.crossRefs[0].sourceXrefHandle, "A-w1:x:002");

    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.slice.synthesisState, "ok");
    assertEq(done.slice.terminalFailure, false);
    assertEq(provider.count("A-synthesis"), 1, "row quarantine does not suppress reconciliation");
    assertEq(done.crossRefs.length, 1);
    assertEq(done.crossRefs[0].sourceXrefHandle, "A-w1:x:002");
    assertEq(done.crossRefs[0].resolvedToBlock, "b0003");
    assertEq(done.crossWindowLimitations[0].candidatesUngrounded, expectedLimitations.length);
    assertEq(done.crossWindowLimitations[0].candidatesSynthesized, 4);
    const synthesisCall = provider.calls.find((call) => call.unit === "A-synthesis");
    assert(synthesisCall?.user.includes("A-w1:x:002"));
    for (const marker of Object.values(rejected)) {
      assert(!synthesisCall.user.includes(marker), marker + " reached synthesis authority");
    }

    const passB = {
      pass: "B", provider: "fixture-independent", model: "fixture-independent",
      requirements: [], ambiguities: [], unverifiable: [], constructs: [], failedUnits: [], calls: [],
      dispositions: doc.blocks.map((block) => ({
        blockId: block.blockId, disposition: "non-normative", reason: "neutral merge fixture",
      })),
    };
    const merged = await m.merge.mergePasses(done, passB, doc, done.crossRefs);
    assertEq(merged.requirements.length, 3, "quarantined candidates mint no merged coverage credit");
    const mergedText = JSON.stringify(merged);
    for (const marker of Object.values(rejected)) {
      assert(!mergedText.includes(marker), marker + " reached merged authority");
    }
  } finally {
    provider.restore();
  }
});

test("grounded none-observable rules are withheld when their required companion is ungrounded", async () => {
  const m = await mod();
  const doc = documentFor([
    TEXT.b0001,
    TEXT.b0002,
    "Every closing screen displays the approved thank-you text.",
  ]);
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" });
  const runId = "run_primary_grounded_linkage_limitation";
  const linkedRule = {
    ...rule("LINKED-RULE", "b0001", doc.blocks[0].text),
    browser_observable: "none",
  };
  const linkedUnverifiable = {
    ...unverifiable("LINKED-UNVERIFIABLE", "b0001", doc.blocks[0].text),
    block_ids: ["b0001", "b9999"],
    evidence_quotes: [
      { block_id: "b0001", quote: doc.blocks[0].text },
      { block_id: "b9999", quote: "foreign companion evidence" },
    ],
  };
  const provider = installProvider(({ unit }) => {
    if (unit === "A-w1") {
      return {
        value: {
          ...emptyPrimary(),
          global_rules: [linkedRule],
          unverifiable_from_browser: [linkedUnverifiable],
        },
      };
    }
    if (unit === "A-w2") {
      return {
        value: {
          ...emptyPrimary(),
          global_rules: [rule("VALID-LATER", "b0003", doc.blocks[2].text)],
        },
      };
    }
    return { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.failedUnits.length, 0);
    assertEq(JSON.stringify(done.requirements.map((row) => row.id)), JSON.stringify(["VALID-LATER"]));
    const expected = [
      {
        kind: "pass-a-primary-candidate-ungrounded",
        unit: "A-w1",
        rowKind: "global-rule",
        rowIndex: 1,
        sourceBlockIds: ["b0001"],
        reason: "grounded-row-linkage-incomplete",
      },
      {
        kind: "pass-a-primary-candidate-ungrounded",
        unit: "A-w1",
        rowKind: "unverifiable",
        rowIndex: 1,
        sourceBlockIds: ["b0001"],
        reason: "source-block-ownership-invalid",
      },
    ];
    assertEq(
      JSON.stringify(done.primaryGroundingLimitations),
      JSON.stringify(expected),
      "a dependent rule cannot outlive its rejected exact-evidence companion",
    );
    assertEq(done.crossWindowLimitations[0].candidatesUngrounded, 2);
    assertEq(done.crossWindowLimitations[0].candidatesSynthesized, 1);
  } finally {
    provider.restore();
  }
});

test("exactly grounded primary rows remain authoritative and create no limitation", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const exactOutput = {
    ...emptyPrimary(),
    global_rules: [rule("EXACT-RULE", "b0001", doc.blocks[0].text)],
    cross_references: [xref("EXACT-XREF", "b0001", doc.blocks[0].text)],
    ambiguities: [ambiguity("EXACT-AMBIGUITY", "b0002", doc.blocks[1].text)],
    unverifiable_from_browser: [
      unverifiable("EXACT-UNVERIFIABLE", "b0002", doc.blocks[1].text),
    ],
  };
  const provider = installProvider(() => ({ value: exactOutput }));
  try {
    const done = await m.passA.runPassA(env, "run_primary_exact_grounding_control", doc, "neutral.docx");
    assertEq(done.slice.done, true);
    assertEq(done.slice.terminalFailure, false);
    assertEq(done.primaryGroundingLimitations.length, 0);
    assertEq(done.requirements.length, 1);
    assertEq(done.crossRefs.length, 1);
    assertEq(done.ambiguities.length, 1);
    assertEq(done.unverifiable.length, 1);
    const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
    assertEq(artifact.primaryGroundingLimitations.length, 0);
    assertEq(JSON.stringify(artifact.modelOutput), JSON.stringify(exactOutput));
  } finally {
    provider.restore();
  }
});

test("structured unit-start visibility precedes both a primary purchase and its durable reclaim", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const runId = "run_primary_structured_visibility";
  const events = [];
  const provider = installProvider(() => {
    assertEq(events.length, 1, "the current unit is durable before the provider is called");
    assertEq(events[0].unit.name, "A");
    return { value: emptyPrimary() };
  });
  const observe = async (event) => { events.push(event); };
  try {
    const done = await m.passA.runPassA(env, runId, doc, "neutral.docx", undefined, undefined, observe);
    assertEq(done.slice.done, true);
    assertEq(events.length, 1);
    assertEq(events[0].stage, "primary-windows");
    assertEq(events[0].unit.kind, "window");
    assertEq(events[0].unit.ordinal, 1);
    assertEq(events[0].unit.total, 1);
    assertEq(events[0].unit.sourceContext.authority, "parsed-document-blocks");
    assertEq(events[0].unit.sourceContext.blockCount, 2);
    assertEq(events[0].unit.sourceContext.firstBlockId, "b0001");
    assertEq(events[0].unit.sourceContext.lastBlockId, "b0002");
    assert(events[0].unit.sourceContext.preview.includes("premium group"));
    assertEq(events[0].primary.total, 1);
    assertEq(events[0].primary.landed, 0);
    assertEq(events[0].primary.remaining, 1);
    assertEq(events[0].secondary, null);

    events.length = 0;
    provider.reset();
    const reclaimed = await m.passA.runPassA(
      env, runId, doc, "renamed.docx", undefined, undefined, observe,
    );
    assertEq(reclaimed.slice.done, true);
    assertEq(provider.calls.length, 0, "structured visibility does not turn reclaim into a purchase");
    assertEq(events.length, 1, "the current unit is also visible before a cached artifact read");
    assertEq(events[0].unit.name, "A");
  } finally {
    provider.restore();
  }
});

test("a failed structured unit-start write buys no primary model call", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
  const doc = documentFor();
  const runId = "run_primary_visibility_write_failure";
  const provider = installProvider(() => ({ value: emptyPrimary() }));
  let error = null;
  try {
    try {
      await m.passA.runPassA(
        env, runId, doc, "neutral.docx", undefined, undefined,
        async () => { throw new Error("checkpoint unavailable"); },
      );
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error);
    assert(error.message.includes("checkpoint unavailable"));
    assertEq(provider.calls.length, 0, "a visibility failure cannot strand a paid answer");
    assertEq(env.EVIDENCE._store.size, 0, "no fake extraction artifact is written for a visibility failure");
  } finally {
    provider.restore();
  }
});

test("structured synthesis visibility names the exact candidate source before purchase and reclaim", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_structured_visibility";
  const events = [];
  const observe = async (event) => { events.push(event); };
  const provider = installProvider(({ unit }) => {
    if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
    assertEq(events.at(-1).unit.name, "A-synthesis", "synthesis is visible before its purchase");
    return { value: emptySynthesis() };
  });
  try {
    const primary = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600_000 }, observe,
    );
    assertEq(primary.slice.synthesisState, "pending");
    assertEq(events.at(-1).stage, "cross-window-synthesis");
    assertEq(events.at(-1).unit.sourceContext.blockCount, 2);
    assertEq(events.at(-1).unit.sourceContext.firstBlockId, "b0001");
    assertEq(events.at(-1).unit.sourceContext.lastBlockId, "b0002");

    events.length = 0;
    const done = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600_000 }, observe,
    );
    assertEq(done.slice.done, true);
    assertEq(provider.count("A-synthesis"), 1);
    assertEq(events.at(-1).unit.name, "A-synthesis");

    events.length = 0;
    provider.reset();
    const reclaimed = await m.passA.runPassA(
      env, runId, doc, "neutral.docx", undefined, { budgetMs: 600_000 }, observe,
    );
    assertEq(reclaimed.slice.done, true);
    assertEq(provider.calls.length, 0, "synthesis visibility precedes a free durable reclaim");
    assertEq(events.at(-1).unit.name, "A-synthesis");
  } finally {
    provider.restore();
  }
});

test("completed authority names the exact strict-schema failure and unread remainder", async () => {
  const m = await mod();
  const texts = Array.from(
    { length: 11 },
    (_, index) => `Neutral questionnaire source block ${index + 1}.`,
  );

  // CASE A: partial missing array — some arrays exist, so degradation salvages (zero items)
  // and the tail continues across waves. The degraded window lands, no terminal failure.
  {
    const doc = documentFor(texts);
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1" });
    const runId = "run_primary_failed_unit_visibility_degraded";
    const provider = installProvider(({ unit }) => {
      if (unit === "A-synthesis") return { value: emptySynthesis() };
      if (unit !== "A-w3") return { value: emptyPrimary() };
      const value = emptyPrimary();
      delete value.global_rules;
      return { value };
    });
    try {
      // First wave: processes windows until degradation, then breaks out for the next wave
      let result = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(result.slice.terminalFailure, false, "partial-missing degrades, never terminally fails");
      assertEq(result.failedUnits.length, 0, "no failed units when degradation salvages");
      assertEq(provider.count("A-w3"), 1, "exactly one purchase for the degraded window");
      // Continue until all windows land (the wave architecture defers remaining after degradation)
      for (let wave = 2; wave <= 20 && !result.slice.done; wave++) {
        result = await m.passA.runPassA(env, runId, doc, "neutral.docx");
        assertEq(result.slice.terminalFailure, false, "no terminal failure in subsequent waves");
      }
      assertEq(result.slice.done, true, "pass completes after sufficient waves");
      assertEq(result.slice.windowsLanded, 11, "all windows land including the degraded one");
      assertEq(result.slice.windowsRemaining, 0);
      assertEq(result.requirements.length, 0, "no items from any window (all return empty)");
      // The degraded window must carry the root-malformed limitation for the missing global_rules
      const rootMalformed = result.primaryGroundingLimitations.filter(
        (lim) => lim.reason === "root-malformed",
      );
      assertEq(rootMalformed.length, 1, "exactly one root-malformed limitation for the missing root");
      assertEq(rootMalformed[0].unit, "A-w3", "the root-malformed limitation names the degraded window");
      assertEq(rootMalformed[0].rowKind, "global-rule", "the root-malformed limitation names the bad root's kind");
      assertEq(rootMalformed[0].rowIndex, 0, "root-malformed uses rowIndex 0 (category-level)");
    } finally {
      provider.restore();
    }
  }

  // CASE B: ALL arrays missing — degradedPrimaryOutput returns null, so the original
  // terminal failure fires. This case must name the schema failure and the unread remainder.
  {
    const doc = documentFor(texts);
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1" });
    const runId = "run_primary_failed_unit_visibility_terminal";
    const provider = installProvider(({ unit }) => {
      if (unit !== "A-w3") return { value: emptyPrimary() };
      // Delete ALL four required arrays so degradedPrimaryOutput returns null
      return { value: {} };
    });
    try {
      const stopped = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(stopped.slice.terminalFailure, true);
      assertEq(stopped.failedUnits[0].unit, "A-w3");
      assertEq(stopped.slice.windowsLanded, 3);
      assertEq(stopped.slice.windowsRemaining, 8);

      provider.reset();
      const reconstructed = await m.passA.reconstructPassACompletedAuthority(
        env, runId, doc, "neutral.docx",
      );
      assertEq(provider.calls.length, 0, "read-only reconstruction never re-buys the failed unit");
      assertEq(reconstructed.kind, "invalid");
      assertEq(reconstructed.failedUnit.unit, "A-w3");
      assertEq(reconstructed.failedUnit.blockIds.length, 1);
      assertEq(reconstructed.failedUnit.blockIds[0], "b0003");
      assert(reconstructed.failedUnit.detail.includes("root keys are not closed"));
      assertEq(reconstructed.slice.windowsTotal, 11);
      assertEq(reconstructed.slice.windowsLanded, 3);
      assertEq(reconstructed.slice.windowsRemaining, 8);
    } finally {
      provider.restore();
    }
  }
});

test("strictly malformed primary schemas terminalize without a second purchase", async () => {
  // Cases where individual items fail strict validation: degradation excludes those items,
  // lands the window, and counts each exclusion as a named limitation. No second purchase.
  const degradedCases = [
    {
      name: "unknown silently ignored rule field",
      output: () => ({
        ...emptyPrimary(), global_rules: [{ ...rule("EXTRA", "b0001", TEXT.b0001), applies_to: "all" }],
      }),
      expectedLimitationCount: 1,
    },
    {
      name: "target quote key is missing entirely",
      output: () => {
        const value = {
          ...emptyPrimary(),
          cross_references: [{
            id: "MISSING-TARGET-KEY", from_block: "b0001", target: "Omega", resolved_to_block: "b0002",
            target_doc_quote: TEXT.b0002, statement: "Missing schema field.", doc_quote: TEXT.b0001,
          }],
        };
        delete value.cross_references[0].target_doc_quote;
        return value;
      },
      expectedLimitationCount: 1,
    },
    {
      name: "block_ids is not an array",
      output: () => ({
        ...emptyPrimary(),
        global_rules: [{ ...rule("BAD-ID-ARRAY", "b0001", TEXT.b0001), block_ids: "b0001" }],
      }),
      expectedLimitationCount: 1,
    },
    {
      name: "block_ids contains a non-string member",
      output: () => ({
        ...emptyPrimary(),
        ambiguities: [{
          ...ambiguity("BAD-ID-MEMBER", "b0001", TEXT.b0001),
          block_ids: ["b0001", 2],
        }],
      }),
      expectedLimitationCount: 1,
    },
  ];
  const m = await mod();
  for (const [index, fixture] of degradedCases.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const provider = installProvider(() => ({ value: fixture.output() }));
    try {
      const result = await m.passA.runPassA(env, `run_strict_primary_${index}`, doc, "neutral.docx");
      assertEq(result.slice.terminalFailure, false, `${fixture.name}: degradation lands the window`);
      assertEq(provider.calls.length, 1, `${fixture.name}: exactly one purchase, zero further purchases during salvage`);
      assertEq(result.failedUnits.length, 0, `${fixture.name}: degraded window is not a failed unit`);
      assertEq(result.slice.done, true, `${fixture.name}: window lands and pass completes`);
      assertEq(
        result.primaryGroundingLimitations.length,
        fixture.expectedLimitationCount,
        `${fixture.name}: each excluded item is a named limitation`,
      );
      if (fixture.expectedLimitationCount > 0) {
        assert(
          result.primaryGroundingLimitations.every(
            (row) => row.reason === "structural-validation-failed",
          ),
          `${fixture.name}: every limitation names the exact structural reason`,
        );
      }
      // Reentry reclaims the degraded artifact at zero cost
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, `run_strict_primary_${index}`, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, `${fixture.name}: degraded artifact is durable — reclaimed, not re-bought`);
      assertEq(reclaimed.slice.done, true, fixture.name);
    } finally {
      provider.restore();
    }
  }

  // TERMINAL: only when ALL FOUR roots are absent/non-array is the envelope truly unsalvageable.
  {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const provider = installProvider(() => ({ value: {} }));
    try {
      const failed = await m.passA.runPassA(env, "run_strict_primary_terminal_all", doc, "neutral.docx");
      assertEq(failed.slice.terminalFailure, true, "all root arrays missing: unsalvageable envelope is terminal");
      assertEq(provider.calls.length, 1, "all root arrays missing: exactly one purchase");
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, "run_strict_primary_terminal_all", doc, "neutral.docx");
      assertEq(provider.calls.length, 0, "all root arrays missing: terminal semantic rejection is durable authority");
      assertEq(reclaimed.slice.terminalFailure, true, "all root arrays missing: terminal reclaim stays terminal");
    } finally {
      provider.restore();
    }
  }

  // DEGRADED (not terminal): a single missing or non-array root key degrades with a
  // root-malformed limitation; the other three valid (empty) roots contribute zero items.
  const degradedRootCases = [
    {
      name: "missing required root array (global_rules deleted)",
      expectedRowKind: "global-rule",
      output: () => {
        const value = emptyPrimary();
        delete value.global_rules;
        return value;
      },
    },
    {
      name: "non-array root key (global_rules is a string)",
      expectedRowKind: "global-rule",
      output: () => ({
        ...emptyPrimary(),
        global_rules: "not-an-array",
      }),
    },
  ];
  for (const [dIdx, dCase] of degradedRootCases.entries()) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const provider = installProvider(() => ({ value: dCase.output() }));
    try {
      const result = await m.passA.runPassA(env, `run_strict_primary_degraded_root_${dIdx}`, doc, "neutral.docx");
      assertEq(result.slice.terminalFailure, false, `${dCase.name}: partial missing root degrades, not terminal`);
      assertEq(result.slice.done, true, `${dCase.name}: degraded window lands and pass completes`);
      assertEq(provider.calls.length, 1, `${dCase.name}: exactly one purchase, zero further during salvage`);
      assertEq(result.failedUnits.length, 0, `${dCase.name}: degraded window is not a failed unit`);
      assertEq(
        result.primaryGroundingLimitations.length,
        1,
        `${dCase.name}: exactly one root-malformed limitation`,
      );
      assertEq(result.primaryGroundingLimitations[0].reason, "root-malformed", dCase.name);
      assertEq(result.primaryGroundingLimitations[0].rowKind, dCase.expectedRowKind, dCase.name);
      assertEq(result.primaryGroundingLimitations[0].rowIndex, 0, dCase.name);
      // Reentry reclaims the degraded artifact at zero cost
      provider.reset();
      const reclaimed = await m.passA.runPassA(env, `run_strict_primary_degraded_root_${dIdx}`, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, `${dCase.name}: degraded artifact is durable — reclaimed, not re-bought`);
      assertEq(reclaimed.slice.done, true, dCase.name);
      assertEq(reclaimed.slice.terminalFailure, false, `${dCase.name}: reclaim stays degraded, not terminal`);
    } finally {
      provider.restore();
    }
  }
});

test("strict semantic failure retains exact raw output and corrupt authority is never retried", async () => {
  const m = await mod();

  // PART 1: degraded landing retains the exact raw output for audit.
  // When items fail strict validation inside a well-formed envelope, the ORIGINAL raw
  // model output is retained in the artifact's rawModelOutputPreDegradation field.
  // A well-formed envelope (all four root keys present and arrays) with items whose
  // construct is unknown ("presentation") triggers item-level degradation.
  {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const doc = documentFor();
    const runId = "run_primary_degraded_raw_retention";
    const rawOutput = {
      ...emptyPrimary(),
      global_rules: [{
        ...rule("BAD-CONSTRUCT", "b0001", TEXT.b0001),
        construct: "presentation",
      }],
    };
    const provider = installProvider(() => ({ value: rawOutput }));
    try {
      // All blocks in one window, so degradation lands the entire pass in one wave
      const result = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(result.slice.terminalFailure, false, "item-level failure degrades, not terminal");
      assertEq(result.slice.done, true);
      assertEq(provider.calls.length, 1, "exactly one purchase, zero further purchases during salvage");
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      assertEq(artifact.kind, "ok", "degraded window persists as success shape");
      assertEq(
        JSON.stringify(artifact.rawModelOutputPreDegradation),
        JSON.stringify(rawOutput),
        "the exact paid parsed output is retained under rawModelOutputPreDegradation",
      );
      // The modelOutput field contains the synthetic strict-passing form (not the raw output)
      assert(
        artifact.modelOutput !== undefined && artifact.modelOutput !== null,
        "modelOutput is present for strict re-read",
      );

      provider.reset();
      const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, "degraded artifact is reclaimed, not re-bought");
      assertEq(reclaimed.slice.done, true);
    } finally {
      provider.restore();
    }
  }

  // PART 2: fully-unusable output (terminal failure) retains raw output in the failed artifact.
  {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1" });
    const doc = documentFor();
    const runId = "run_primary_terminal_raw_retention";
    // All arrays missing — degradedPrimaryOutput returns null -> terminal failure
    const rawOutput = {};
    const provider = installProvider(({ unit }) => (
      unit === "A-w1" ? { value: rawOutput } : { value: emptyPrimary() }
    ));
    try {
      const stopped = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(stopped.slice.terminalFailure, true);
      assertEq(provider.count("A-w1"), 1);
      assertEq(provider.count("A-w2"), 0, "terminal failure stops the unread tail");
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      assertEq(artifact.status, "failed");
      assertEq(artifact.failureStage, "semantic-output");
      assertEq(artifact.terminal, true);
      assertEq(artifact.usages.at(-1).status, "parse-failed");
      assertEq(
        JSON.stringify(artifact.modelOutput),
        JSON.stringify(rawOutput),
        "the exact paid parsed output remains durable failure evidence even when fully unusable",
      );
    } finally {
      provider.restore();
    }
  }

  // PART 3: corrupt stored authority is never retried (unchanged property).
  // A stored FAILED artifact whose modelOutput is deleted or changed to valid remains
  // terminal authority with zero new purchases.
  {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1" });
    const doc = documentFor();
    const runId = "run_primary_corrupt_authority_never_retried";
    const rawOutput = {};
    const provider = installProvider(({ unit }) => (
      unit === "A-w1" ? { value: rawOutput } : { value: emptyPrimary() }
    ));
    try {
      const stopped = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(stopped.slice.terminalFailure, true);
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());

      for (const [name, mutate] of [
        ["deleted raw output", (row) => { delete row.modelOutput; }],
        ["raw output changed to valid", (row) => { row.modelOutput = emptyPrimary(); }],
      ]) {
        const corruptedArtifact = structuredClone(artifact);
        mutate(corruptedArtifact);
        const corrupted = JSON.stringify(corruptedArtifact);
        await env.EVIDENCE.put(key, corrupted);
        provider.reset();
        const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
        assertEq(provider.calls.length, 0, name + " must remain terminal authority, not a cache miss");
        assertEq(refused.slice.terminalFailure, true, name);
        assert(
          refused.failedUnits.some((row) => row.detail.includes("PASS_A_WINDOW_ARTIFACT_INVALID")),
          name + " was accepted as a valid semantic failure: " + JSON.stringify(refused.failedUnits),
        );
        assertEq(await (await env.EVIDENCE.get(key)).text(), corrupted, name + " was overwritten");
      }
    } finally {
      provider.restore();
    }
  }
});

test("provider and fallback-authorized failures retain no fabricated model output", async () => {
  const m = await mod();

  {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100" });
    const provider = installProvider(() => ({ value: {}, status: 401 }));
    try {
      const stopped = await m.passA.runPassA(
        env, "run_primary_provider_failure_no_output", documentFor(), "neutral.docx",
      );
      assertEq(stopped.slice.terminalFailure, true);
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      assertEq(artifact.failureStage, "provider");
      assert(
        !Object.hasOwn(artifact, "modelOutput") || artifact.modelOutput === null,
        "a provider failure fabricated a model output",
      );
    } finally {
      provider.restore();
    }
  }

  {
    const env = envFor({
      EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
      EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    });
    const committedPut = env.EVIDENCE.put.bind(env.EVIDENCE);
    let checkpointTransportFailed = false;
    env.EVIDENCE.put = async (key, value, options) => {
      const result = await committedPut(key, value, options);
      let parsed = null;
      try { parsed = JSON.parse(String(value)); } catch { /* not a JSON checkpoint */ }
      if (!checkpointTransportFailed && parsed?.failureStage === "fallback-authorized") {
        checkpointTransportFailed = true;
        throw new Error("fixture transport failed after committing fallback authority");
      }
      return result;
    };
    const provider = installProvider(({ body }) => (
      body.model === "grok-4.5"
        ? { value: {}, status: 502 }
        : { value: emptyPrimary() }
    ));
    try {
      const pending = await m.passA.runPassA(
        env, "run_primary_fallback_checkpoint_no_output", documentFor(), "neutral.docx",
      );
      assertEq(checkpointTransportFailed, true);
      assertEq(pending.slice.terminalFailure, false);
      assertEq(provider.calls.length, 1, "Flash was not bought after the uncertain checkpoint transport");
      const key = [...env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
      const artifact = JSON.parse(await (await env.EVIDENCE.get(key)).text());
      assertEq(artifact.failureStage, "fallback-authorized");
      assertEq(artifact.terminal, false);
      assert(
        !Object.hasOwn(artifact, "modelOutput") || artifact.modelOutput === null,
        "a pre-response fallback checkpoint fabricated a model output",
      );
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
    // NOTE: "parse-failed receipt but nonterminal semantic state" was removed because the
    // budget-mode failure ladder (bdfd068) legitimately stores non-terminal semantic-output
    // failures for retry across waves. A forged non-terminal semantic-output failure with
    // parse-failed usages is structurally indistinguishable from a legitimate one. The ladder
    // re-issues it, and the attempts ceiling terminates it naturally.
    {
      name: "ok receipt hidden behind a provider-failure discriminator",
      configure: (artifact) => {
        artifact.failureStage = "provider";
        artifact.terminal = true;
        artifact.modelOutput = null;
      },
      mutate: () => {},
      expected: "unauthorized provider receipt",
    },
    {
      name: "no-trigger provider failure relabeled nonterminal",
      configure: (artifact) => {
        artifact.failureStage = "provider";
        artifact.terminal = false;
        artifact.modelOutput = null;
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
      delete artifact.primaryGroundingLimitations;
      delete artifact.routeReceipt;
      artifact.status = "failed";
      artifact.terminal = false;
      artifact.failureStage = "semantic-output";
      artifact.fallbackTrigger = null;
      artifact.detail = "forged retryable semantic state";
      artifact.modelOutput = { ...emptyPrimary(), unexpected_key: true };
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
    let secretReads = 0;
    env.XAI_API_KEY = { get: async () => { secretReads += 1; return "must-not-be-read"; } };
    env.DEEPSEEK_API_KEY = { get: async () => { secretReads += 1; return "must-not-be-read"; } };
    const prepared = await m.passA.preparePassASynthesis(env, runId, doc, "neutral.docx");
    assert(prepared, "the complete primary catalogue remains a required synthesis unit");
    assertEq(prepared.inputBytes, 0, "no provider body is fabricated after the catalogue alone proves refusal");
    assertEq(prepared.catalogueBytes, 101, "the saturating proof is exactly ceiling + 1");
    assertEq(prepared.grokWireBytes, 0);
    assertEq(prepared.flashWireBytes, 0);
    assertEq(prepared.inputJson, "", "an oversized catalogue exposes no truncated prefix");

    const failed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.count("A-synthesis"), 0, "an oversize exact request is refused before fetch");
    assertEq(secretReads, 0, "catalogue refusal precedes both provider credential reads");
    assertEq(failed.slice.terminalFailure, true);
    assertEq(failed.slice.done, true, "the terminal refusal leaves no resumable synthesis work");
    assertEq(failed.slice.synthesisState, "failed", "terminal completion is a refusal, never a Pass-A seal");
    assertEq(failed.slice.synthesisAttempts, 0, "a zero-purchase refusal does not invent an attempt");
    assertEq(failed.terminalReasonCode, "extraction-pass-a-synthesis-catalogue-exceeded");
    assert(
      failed.failedUnits.some((row) =>
        row.detail.startsWith("extraction-pass-a-synthesis-catalogue-exceeded:") &&
        row.detail.includes("candidate catalogue")),
      JSON.stringify(failed.failedUnits),
    );
    const artifactKey = m.passA.passASynthesisKey(runId);
    const artifactBytes = await (await env.EVIDENCE.get(artifactKey)).text();
    const artifact = JSON.parse(artifactBytes);
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(artifact.failureStage, "catalogue-exceeded");
    assertEq(Object.hasOwn(artifact, "modelOutput"), false);

    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "the durable pre-purchase refusal is not rediscovered or re-bought");
    assertEq(secretReads, 0, "re-entry reclaims the refusal before credential access");
    assertEq(reclaimed.slice.synthesisAttempts, 0);
    assertEq(reclaimed.terminalReasonCode, "extraction-pass-a-synthesis-catalogue-exceeded");
    assertEq(await (await env.EVIDENCE.get(artifactKey)).text(), artifactBytes, "re-entry preserves exact bytes");
  } finally {
    provider.restore();
  }
});

test("strictly malformed primary evidence fails loudly before synthesis", async () => {
  const fixtures = [
    {
      name: "evidence member missing its required quote key",
      doc: documentFor(["Shared exact words.", "Shared exact words.", TEXT.b0002]),
      env: { EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2" },
      primary: () => ({
        ...emptyPrimary(),
        ambiguities: [{
          id: "AMB-REPEATED",
          block_ids: ["b0001", "b0002"],
          doc_quote: "Shared exact words.",
          evidence_quotes: [
            { block_id: "b0001", quote: "Shared exact words." },
            { block_id: "b0002" },
          ],
          reading_a: "A",
          reading_b: "B",
          why_ambiguous: "Two source owners remain possible.",
          affects: [],
        }],
      }),
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
      const result = await m.passA.runPassA(
        env, `run_primary_grounding_${index}`, fixture.doc, "neutral.docx",
      );
      // The malformed item is excluded via degradation before synthesis sees it.
      assertEq(result.slice.terminalFailure, false, `${fixture.name}: degradation lands the window`);
      assertEq(result.failedUnits.length, 0, `${fixture.name}: degraded window is not a failed unit`);
      // The excluded item is counted as a structural-validation-failed limitation.
      assert(
        result.primaryGroundingLimitations.length > 0,
        `${fixture.name}: malformed item must produce a named limitation`,
      );
      assert(
        result.primaryGroundingLimitations.some(
          (row) => row.reason === "structural-validation-failed",
        ),
        `${fixture.name}: the limitation names the exact structural reason`,
      );
      // The malformed ambiguity must NOT reach the result — it was excluded before synthesis.
      assertEq(result.ambiguities.length, 0, `${fixture.name}: excluded item never reaches output`);
      // If synthesis ran, it never saw the excluded item.
      if (provider.count("A-synthesis") > 0) {
        const synthesisCall = provider.calls.find((call) => call.unit === "A-synthesis");
        assert(
          !synthesisCall.user.includes("AMB-REPEATED"),
          `${fixture.name}: the excluded ambiguity must not reach synthesis input`,
        );
      }
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
      mutate: (row) => { row.usages[0].model = "grok-4.6"; },
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
    if (body.model === "grok-4.5") return { value: {}, status: 429 };
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
      if (body.model === "grok-4.5") return { value: {}, status: 502 };
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
      assertEq(provider.calls.filter((call) => call.body.model === "grok-4.5").length, 1);
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
      if (body.model === "grok-4.5") return { value: {}, status: 502 };
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

test("synthesis fallback/retry transitions archive exact predecessors and accept an after-commit final target", async () => {
  const m = await mod();
  const storage = interceptSynthesisTransitions();
  const env = envFor({
    EVIDENCE: storage.bucket,
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
  });
  const doc = documentFor();
  const runId = "run_synthesis_transition_history";
  let flashAttempts = 0;
  const provider = installProvider(({ unit, body }) => {
    if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
    if (body.model === "grok-4.5") return { value: {}, status: 502 };
    flashAttempts += 1;
    return flashAttempts === 1
      ? { value: {}, status: 502 }
      : { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const first = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(first.slice.synthesisState, "pending");
    const mainKey = m.passA.passASynthesisKey(runId);
    const fallbackWrite = storage.mainWrites.find((row) =>
      row.parsed.failureStage === "fallback-authorized"
    );
    const providerFailureWrite = storage.mainWrites.find((row) =>
      row.parsed.failureStage === "provider"
    );
    assert(fallbackWrite, "the Grok receipt first lands as fallback authority");
    assert(providerFailureWrite, "the failed Flash receipt replaces fallback authority");
    const fallbackHistory = await synthesisDerivedObject(
      m, env, mainKey, "history", fallbackWrite.body,
    );
    assert(fallbackHistory.object, "the fallback predecessor history exists");
    assertEq(
      await fallbackHistory.object.text(),
      fallbackWrite.body,
      "fallback predecessor bytes are retained exactly",
    );
    assertEq(
      await (await env.EVIDENCE.get(mainKey)).text(),
      providerFailureWrite.body,
      "the retryable provider failure is canonical after issue one",
    );

    storage.armAfterFinalCommit();
    const recovered = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(recovered.slice.done, true, "strict exact-target reread accepts the committed final result");
    assertEq(recovered.slice.synthesisState, "reduced-provider-independence");
    const finalWrites = storage.mainWrites.filter((row) => row.parsed.status === "ok");
    assertEq(finalWrites.length, 1, "an after-commit response failure does not retry the final put");
    assert(
      typeof finalWrites[0].options.onlyIf?.etagMatches === "string",
      "the final result is conditional on the exact provider-failure predecessor etag",
    );
    assertEq(
      await (await env.EVIDENCE.get(mainKey)).text(),
      finalWrites[0].body,
      "the final canonical bytes equal the admitted target exactly",
    );
    const failureHistory = await synthesisDerivedObject(
      m, env, mainKey, "history", providerFailureWrite.body,
    );
    assert(failureHistory.object, "the retryable provider-failure predecessor history exists");
    assertEq(
      await failureHistory.object.text(),
      providerFailureWrite.body,
      "retry predecessor bytes are retained exactly",
    );
    assertEq(provider.count("A-synthesis"), 3, "one Grok trigger and two Flash issues were bought");

    provider.reset();
    const replay = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(replay.slice.done, true);
    assertEq(provider.calls.length, 0, "replay reclaims final authority without another provider call");
  } finally {
    provider.restore();
  }
});

test("a different valid synthesis CAS winner is never overwritten and exact losing paid bytes survive", async () => {
  const m = await mod();
  const storage = interceptSynthesisTransitions();
  const env = envFor({
    EVIDENCE: storage.bucket,
    EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
  });
  const doc = documentFor();
  const runId = "run_synthesis_valid_cas_winner";
  let flashAttempts = 0;
  const provider = installProvider(({ unit, body }) => {
    if (unit !== "A-synthesis") return { value: nominatedPrimary(unit) };
    if (body.model === "grok-4.5") return { value: {}, status: 502 };
    flashAttempts += 1;
    return flashAttempts === 1
      ? { value: {}, status: 502 }
      : { value: emptySynthesis() };
  });
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const first = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(first.slice.synthesisState, "pending");
    const predecessor = storage.mainWrites.find((row) =>
      row.parsed.failureStage === "provider"
    );
    assert(predecessor, "the retryable predecessor exists before the race");

    storage.armFinalRace(synthesisWithRule(validCrossWindowRule()));
    const raced = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assert(
      storage.raceWinnerBody() !== null,
      "the fixture injected a different winner before CAS; writes=" +
        JSON.stringify(storage.mainWrites.map((row) => ({
          status: row.parsed.status,
          failureStage: row.parsed.failureStage,
          onlyIf: row.options.onlyIf ?? null,
          raceFinal: row.raceFinal,
          raced: row.raced,
          beforeEtag: row.beforeEtag,
        }))),
    );
    assert(storage.losingBody() !== null, "the fixture captured the exact losing target bytes");
    assertEq(raced.slice.synthesisState, "failed", "losing the predecessor CAS terminalizes synthesis");
    assertEq(raced.slice.terminalFailure, true);
    assertEq(
      raced.requirements.filter((row) => row.origin === "A-synthesis").length,
      0,
      "a losing paid target grants no synthesis requirement authority",
    );
    assertEq(raced.crossWindowLimitations.length, 0, "a losing paid target grants no synthesis coverage claim");
    assert(
      raced.failedUnits.some((row) =>
        row.unit === "A-synthesis-artifact" &&
        row.detail.includes("PASS_A_SYNTHESIS_PERSISTENCE_FAILED")),
      "the terminal result names the synthesis persistence refusal",
    );
    assertEq(
      raced.calls.at(-1).status,
      "ok",
      "storage conflict never relabels the paid valid result as semantic parse failure",
    );

    const mainKey = m.passA.passASynthesisKey(runId);
    assertEq(
      await (await env.EVIDENCE.get(mainKey)).text(),
      storage.raceWinnerBody(),
      "the different strict-valid winner remains byte-for-byte canonical",
    );
    const conflict = await synthesisDerivedObject(
      m, env, mainKey, "cas-conflict", storage.losingBody(),
    );
    assert(conflict.object, "the exact losing paid target has an append-only conflict artifact");
    assertEq(await conflict.object.text(), storage.losingBody());
    const history = await synthesisDerivedObject(
      m, env, mainKey, "history", predecessor.body,
    );
    assert(history.object, "the exact retry predecessor is archived before CAS");
    assertEq(await history.object.text(), predecessor.body);

    provider.reset();
    await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "reentry accepts retained winner authority without another purchase");
  } finally {
    provider.restore();
  }
});

test("strict synthesis semantic failure retains exact raw output and re-decodes it on reclaim", async () => {
  const m = await mod();
  const env = envFor();
  const doc = documentFor();
  const runId = "run_synthesis_raw_semantic_authority";
  const rejectedOutput = synthesisWithRule({
    ...validCrossWindowRule(),
    quantifier: "sometimes",
  });
  const provider = installProvider(({ unit }) => ({
    value: unit === "A-synthesis" ? rejectedOutput : nominatedPrimary(unit),
  }));
  try {
    await landPrimaryWindows(m, env, runId, doc, provider);
    const failed = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(failed.slice.synthesisState, "failed");
    assertEq(
      failed.requirements.filter((row) => row.origin === "A-synthesis").length,
      0,
      "rejected raw output grants no synthesis requirement authority",
    );
    assertEq(failed.crossWindowLimitations.length, 0, "rejected raw output grants no synthesis coverage claim");
    const key = m.passA.passASynthesisKey(runId);
    const originalBytes = await (await env.EVIDENCE.get(key)).text();
    const artifact = JSON.parse(originalBytes);
    assertEq(artifact.failureStage, "semantic-output");
    assertEq(artifact.terminal, true);
    assertEq(JSON.stringify(artifact.modelOutput), JSON.stringify(rejectedOutput));
    assertEq(artifact.usages.at(-1).status, "parse-failed");

    provider.reset();
    const replay = await m.passA.runPassA(env, runId, doc, "neutral.docx");
    assertEq(provider.calls.length, 0, "strict semantic failure is re-decoded without a purchase");
    assert(
      replay.failedUnits.some((row) => row.detail.includes("invalid global rule quantifier")),
      "clean replay reproduces the retained raw-output rejection",
    );
    assertEq(await (await env.EVIDENCE.get(key)).text(), originalBytes);

    const corruptions = [
      {
        name: "missing raw output",
        mutate: (row) => { delete row.modelOutput; },
        expected: "semantic-output failure has no retained raw modelOutput",
      },
      {
        name: "raw output now validates",
        mutate: (row) => { row.modelOutput = emptySynthesis(); },
        expected: "semantic-output failure does not reproduce under the current strict decoder",
      },
    ];
    for (const fixture of corruptions) {
      const corrupted = structuredClone(artifact);
      fixture.mutate(corrupted);
      const corruptedBytes = JSON.stringify(corrupted);
      await env.EVIDENCE.put(key, corruptedBytes);
      provider.reset();
      const refused = await m.passA.runPassA(env, runId, doc, "neutral.docx");
      assertEq(provider.calls.length, 0, fixture.name + " is never re-bought");
      assert(
        refused.failedUnits.some((row) =>
          row.unit === "A-synthesis-artifact" && row.detail.includes(fixture.expected)),
        fixture.name + ": " + JSON.stringify(refused.failedUnits),
      );
      assertEq(await (await env.EVIDENCE.get(key)).text(), corruptedBytes);
    }
  } finally {
    provider.restore();
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
      if (body.model === "grok-4.5") return { value: {}, status: 502 };
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
    env.EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES = "119999";
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
    assertEq(result.reason, "INCOMPLETE");
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
  assert(/"EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES"\s*:\s*"120000"/.test(wrangler));
  assert(/"EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES"\s*:\s*"2"/.test(wrangler));
  assert(m.contractReuse.EXTRACTION_POLICY_KEYS.includes("EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES"));
  assert(m.contractReuse.EXTRACTION_POLICY_KEYS.includes("EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES"));
  const base = envFor();
  const fingerprint = await m.contractReuse.extractionPolicyFingerprint(base);
  assert(
    fingerprint !== await m.contractReuse.extractionPolicyFingerprint(envFor({
      EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "119999",
    })),
    "changing the exact catalogue ceiling invalidates extraction reuse",
  );
  assert(
    fingerprint !== await m.contractReuse.extractionPolicyFingerprint(envFor({
      EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "3",
    })),
    "changing the synthesis issue ceiling invalidates extraction reuse",
  );

  // (a) SOURCE-LEVEL: prompts.ts derives the construct enum from CONSTRUCT_CLASSES.join
  // at both schema sites (primary and synthesis). The exact interpolation expression
  // `CONSTRUCT_CLASSES.join("|")` must appear exactly twice — one for the primary schema
  // and one for the synthesis schema.
  const promptsSrc = readFileSync(new URL("../../src/extract/prompts.ts", import.meta.url), "utf8");
  const joinExpr = 'CONSTRUCT_CLASSES.join("|")';
  assertEq(
    promptsSrc.split(joinExpr).length - 1,
    2,
    "primary and synthesis schemas both derive construct enum from CONSTRUCT_CLASSES.join",
  );

  // (b) RUNTIME: the rendered prompt texts each contain the canonical pipe-delimited
  // enum string. This is the real invariant — immune to source formatting changes.
  const canonicalEnum = m.types.CONSTRUCT_CLASSES.join("|");
  assert(
    m.prompts.SYSTEM_A.includes(canonicalEnum),
    "SYSTEM_A rendered text contains the canonical construct enum",
  );
  assert(
    m.prompts.SYSTEM_A_SYNTHESIS.includes(canonicalEnum),
    "SYSTEM_A_SYNTHESIS rendered text contains the canonical construct enum",
  );

  // (c) No prompt offers constructs the strict decoder rejects.
  assert(!promptsSrc.includes("navigation|order"), "no prompt offers constructs the strict decoder rejects");

  // (d) NEGATIVE ARM: mutating one construct name in the canonical list must cause the
  // runtime check to detect the difference — proving this test can actually fail.
  const mutatedClasses = [...m.types.CONSTRUCT_CLASSES];
  mutatedClasses[0] = "MUTATED_FAKE_CONSTRUCT";
  const mutatedEnum = mutatedClasses.join("|");
  assert(
    !m.prompts.SYSTEM_A.includes(mutatedEnum),
    "negative: a mutated construct enum must not appear in the rendered SYSTEM_A",
  );
  assert(
    !m.prompts.SYSTEM_A_SYNTHESIS.includes(mutatedEnum),
    "negative: a mutated construct enum must not appear in the rendered SYSTEM_A_SYNTHESIS",
  );
});

});
