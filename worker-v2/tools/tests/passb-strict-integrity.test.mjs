/**
 * Pass-B strict unit integrity.
 *
 * Provider output is one purchased semantic unit: one malformed row invalidates all rows,
 * exact source evidence is mandatory, and retained exact-key corruption is terminal rather
 * than a cache miss that authorizes another purchase.
 */

import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

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

const TEXT = {
  b0001: "Alpha question must be answered.",
  b0002: "Beta question must be answered.",
};

function sourceBlock(blockId) {
  return {
    blockId,
    kind: "paragraph",
    text: TEXT[blockId],
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
    formatting: {},
    semanticSpans: [],
  };
}

function documentFor(m, ids) {
  const blocks = ids.map(sourceBlock);
  return {
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    documentSemanticsProfile: { kind: "none", version: "1.0.0" },
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

function evidence(blockIds) {
  return blockIds.map((blockId) => ({ block_id: blockId, quote: TEXT[blockId] }));
}

function obligation(unit, blockIds, id = `${unit}-R1`) {
  return {
    id,
    construct: "question",
    scope: `question:${blockIds[0]}`,
    quantifier: "every",
    selector: blockIds[0],
    exceptions: [],
    statement: "The documented question must be asked and answered.",
    doc_quote: TEXT[blockIds[0]],
    block_ids: blockIds,
    evidence_quotes: evidence(blockIds),
    browser_observable: "full",
    confidence: 0.9,
    expansion: null,
  };
}

function payload(unit, blockIds, options = {}) {
  const obligations = options.obligations ??
    (options.cite === false ? [] : blockIds.map((id, index) => obligation(unit, [id], `${unit}-R${index + 1}`)));
  const normative = options.normative ?? obligations.length > 0;
  const cited = [...new Set(obligations.flatMap((row) => row.block_ids ?? []))];
  return {
    chunk_id: unit,
    obligations,
    block_dispositions: blockIds.map((block_id) => ({
      block_id,
      disposition: normative ? "normative" : "non-normative",
      reason: normative ? "The block states a required survey behavior." : "The block is non-normative.",
    })),
    construct_checklist: CONSTRUCTS.map((construct) => ({
      construct,
      present: construct === "question" && cited.length > 0,
      block_ids: construct === "question" ? cited : [],
    })),
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_FALLBACK_MODE: "disabled",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
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
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "1000",
    EXTRACT_CHUNK_CONCURRENCY: "1",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_CHUNK_MAX_ISSUES: "2",
    ...overrides,
  };
}

function stubProvider(answer) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1];
    requests.push(unit);
    const output = answer(unit, requests.length, user);
    return new Response(JSON.stringify({
      model: body.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    requests,
    reset() { requests.length = 0; },
    restore() { globalThis.fetch = original; },
  };
}

const chunkKey = (m, runId, n = 1) =>
  m.keys.k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}.json`);
const sweepKey = (m, runId, n = 1) =>
  m.keys.k("runs", runId, "extraction", "pass-b", `sweep${String(n).padStart(2, "0")}.json`);

async function integratedBed(m) {
  const bed = await passABed(m);
  const { env, runId, documentKey, documentSha256 } = bed;
  const provider = stubProvider((unit, _count, user) => {
    const declared = (user.match(/Your chunk contains exactly \d+ blocks: ([^\n]+)/) ?? [])[1] ?? "";
    const blockIds = declared.split(",").map((value) => value.trim()).filter(Boolean);
    return payload(unit, blockIds, { cite: false, normative: false });
  });
  const passB = await m.extractStage.stagePassBSlice(
    env, runId, documentKey, "questionnaire.docx", bed.fence, async () => {}, {},
    m.docxBlocks.DOCUMENT_SEMANTICS_NONE, bed.passAHash,
    documentSha256,
  );
  assertEq(passB.result.state, "evaluated", "integrated fixture retains canonical Pass-B authority");
  return {
    ...bed,
    provider,
    passBHash: passB.result.value.hash,
  };
}

async function sourceBed(m) {
  const env = envFor({
    EXTRACT_CHUNK_MAX_BLOCKS: "999999",
    EXTRACT_CHUNK_CHARS: "99999999",
    EXTRACT_SWEEP_MAX_CALLS: "0",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
    EXTRACT_PASS_A_WINDOW_CHARS: "99999999",
  });
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  const documentKey = m.keys.inputDocumentKey(runId);
  const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes);
  return { env, runId, documentKey, documentBytes, documentSha256, fence };
}

async function passABed(m) {
  const bed = await sourceBed(m);
  const { env, runId, documentKey, documentSha256, fence } = bed;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({
      model: body.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{
        message: { content: JSON.stringify({
          global_rules: [], cross_references: [], ambiguities: [], unverifiable_from_browser: [],
        }) },
        finish_reason: "stop",
      }],
    });
  };
  let passA;
  try {
    passA = await m.extractStage.stagePassASlice(
      env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      documentSha256,
    );
  } finally {
    globalThis.fetch = original;
  }
  assertEq(passA.result.state, "evaluated", "integrated fixture retains canonical Pass-A authority");
  return {
    ...bed,
    passAHash: passA.result.value.hash,
  };
}

function byteDifferentEquivalentDocx(bytes) {
  return zipSync(unzipSync(bytes), { mtime: "2040-01-02T03:04:06.000Z" });
}

function assertEquivalentParsedDocument(m, original, replacement) {
  assertEq(
    m.hash.canonicalJson(m.docxBlocks.parseDocxBlocks(replacement)),
    m.hash.canonicalJson(m.docxBlocks.parseDocxBlocks(original)),
    "the replacement parses to the same document; only exact-byte authority can distinguish it",
  );
}

async function consolidate(m, bed) {
  return await m.extractStage.stageConsolidate(
    bed.env, bed.runId, bed.documentKey, bed.documentSha256, "en", ["desktop"],
    m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx", bed.passAHash, bed.passBHash,
  );
}

async function assertNoConsolidationArtifacts(m, bed) {
  assertEq(await bed.env.EVIDENCE.get(m.extractStage.mergedKey(bed.runId)), null);
  assertEq(await bed.env.EVIDENCE.get(m.extractStage.previewKey(bed.runId)), null);
  assertEq(await bed.env.EVIDENCE.get(m.keys.extractionDiffKey(bed.runId)), null);
  assertEq(await bed.env.EVIDENCE.get(m.keys.sourceLedgerKey(bed.runId)), null);
}

suite("Pass B strict decoder preserves cardinality and source authority", () => {

test("a valid empty unit is accepted only with complete dispositions and checklist", async () => {
  const m = await mod();
  const decoded = m.passB.decodePassBOutput(
    payload("C01-b0001", ["b0001"], { cite: false, normative: false }),
    "C01-b0001",
    [sourceBlock("b0001")],
  );
  assertEq(decoded.obligations.length, 0);
  assertEq(decoded.dispositions.length, 1);
  assertEq(decoded.constructs.length, CONSTRUCTS.length);
  assertEq(decoded.ambiguities.length, 0);
  assertEq(decoded.unverifiable.length, 0);
});

test("multi-block obligations, ambiguities, and unverifiable rows require exact per-block quotes", async () => {
  const m = await mod();
  const unit = "C01-b0001";
  const blockIds = ["b0001", "b0002"];
  const valid = payload(unit, blockIds, { obligations: [obligation(unit, blockIds)] });
  valid.ambiguities = [{
    id: "AMB-B-01",
    block_ids: blockIds,
    evidence_quotes: evidence(blockIds),
    doc_quote: TEXT.b0001,
    reading_a: "The rule applies to both questions.",
    reading_b: "The rule applies only to the second question.",
    why_ambiguous: "The attachment is unclear.",
    affects: ["b0001", "b0002"],
  }];
  valid.unverifiable_from_browser = [{
    id: "UNV-B-01",
    block_ids: blockIds,
    evidence_quotes: evidence(blockIds),
    doc_quote: TEXT.b0002,
    mandate: "Retain the documented audit metadata.",
    why_not_observable: "The metadata is server-side.",
    browser_proxy_evidence: "none",
  }];
  const decoded = m.passB.decodePassBOutput(valid, unit, blockIds.map(sourceBlock));
  assertEq(decoded.obligations[0].evidenceQuotes.length, 2);
  assertEq(decoded.ambiguities[0].blockIds.length, 2);
  assertEq(decoded.unverifiable[0].evidenceQuotes.length, 2);

  const inexact = structuredClone(valid);
  inexact.obligations[0].evidence_quotes[1].quote = "invented quote";
  await assertThrows(
    () => m.passB.decodePassBOutput(inexact, unit, blockIds.map(sourceBlock)),
    "not an exact span",
    "one inexact cited block must invalidate the whole semantic unit",
  );
});

test("a missing mandatory top-level array is rejected rather than read as empty", async () => {
  const m = await mod();
  const invalid = payload("C01-b0001", ["b0001"]);
  delete invalid.ambiguities;
  await assertThrows(
    () => m.passB.decodePassBOutput(invalid, "C01-b0001", [sourceBlock("b0001")]),
    "unknown or missing fields",
  );
});

test("none-observable obligations require an exact overlapping unverifiable row; full needs none", async () => {
  const m = await mod();
  const unit = "C01-b0001";
  const blocks = [sourceBlock("b0001")];
  const full = payload(unit, ["b0001"]);
  assertEq(m.passB.decodePassBOutput(full, unit, blocks).unverifiable.length, 0);

  const hidden = payload(unit, ["b0001"]);
  hidden.obligations[0].browser_observable = "none";
  await assertThrows(
    () => m.passB.decodePassBOutput(hidden, unit, blocks),
    "has no unverifiable row",
  );
  hidden.unverifiable_from_browser = [{
    id: "UNV-B-01",
    block_ids: ["b0001"],
    evidence_quotes: evidence(["b0001"]),
    doc_quote: TEXT.b0001,
    mandate: "Retain server-side metadata.",
    why_not_observable: "The browser cannot inspect server storage.",
    browser_proxy_evidence: "none",
  }];
  assertEq(m.passB.decodePassBOutput(hidden, unit, blocks).unverifiable.length, 1);
});

test("read-only context may ground an ambiguity but can never become owned obligation/disposition evidence", async () => {
  const m = await mod();
  const unit = "C02-b0002";
  const owned = [sourceBlock("b0002")];
  const context = [sourceBlock("b0001"), ...owned];
  const valid = payload(unit, ["b0002"]);
  valid.ambiguities = [{
    id: "AMB-B-CONTEXT",
    block_ids: ["b0001", "b0002"],
    evidence_quotes: evidence(["b0001", "b0002"]),
    doc_quote: TEXT.b0001,
    reading_a: "The context applies to the owned question.",
    reading_b: "The context does not apply to the owned question.",
    why_ambiguous: "The relationship is not explicit.",
    affects: ["b0002"],
  }];
  assertEq(m.passB.decodePassBOutput(valid, unit, owned, context).ambiguities.length, 1);

  const contextObligation = structuredClone(valid);
  contextObligation.obligations = [obligation(unit, ["b0001"])];
  await assertThrows(
    () => m.passB.decodePassBOutput(contextObligation, unit, owned, context),
    "subset of this unit's source blocks",
  );
});

});

suite("Pass B malformed provider units are durable terminal authority", () => {

test("a malformed second row terminalizes the whole chunk, keeps its paid receipt, and never sweeps or shortens", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_SWEEP_MAX_CALLS: "3" });
  const runId = "run_passb_malformed_second";
  const provider = stubProvider((unit) => {
    const id = unit.endsWith("b0001") ? "b0001" : "b0002";
    const out = payload(unit, [id]);
    if (id === "b0002") {
      const malformed = { ...obligation(unit, [id], `${unit}-BROKEN`) };
      delete malformed.statement;
      out.obligations.push(malformed);
    }
    return out;
  });
  try {
    const result = await m.passB.runPassB(env, runId, documentFor(m, ["b0001", "b0002"]), "ignored.docx");
    assertEq(result.slice.done, false, "terminal semantic failure cannot be called complete");
    assertEq(result.slice.terminalFailure, true);
    assertEq(result.requirements.length, 1, "the valid neighbour in a malformed unit is not retained");
    assert(result.failedUnits.some((row) => row.unit === "C02-b0002"), "the failed chunk is named");
    assertEq(provider.requests.length, 2, "only the two bounded chunk purchases occur");
    assert(!provider.requests.some((unit) => unit.startsWith("SWEEP")), "a sweep cannot launder a failed chunk");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "b")), null, "no whole-pass key exists");

    const artifact = await (await env.EVIDENCE.get(chunkKey(m, runId, 2))).json();
    assertEq(artifact.status, "failed");
    assertEq(artifact.failureStage, "semantic-output");
    assertEq(artifact.terminal, true);
    assertEq(artifact.modelOutput.obligations.length, 2, "raw provider output is retained");
    assertEq(artifact.usages.at(-1).status, "parse-failed", "the paid receipt is truthfully reclassified");
    assertEq(artifact.obligations, undefined, "no partial typed artifact is persisted");

    provider.reset();
    const resumed = await m.passB.runPassB(
      env, runId, documentFor(m, ["b0001", "b0002"]), "different-name.docx",
    );
    assertEq(provider.requests.length, 0, "terminal exact-key authority is never re-bought");
    assertEq(resumed.slice.terminalFailure, true);
  } finally {
    provider.restore();
  }
});

test("a terminal malformed sweep cannot repair itself or authorize a final Pass-B payload", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_SWEEP_MAX_CALLS: "1" });
  const runId = "run_passb_terminal_sweep";
  const provider = stubProvider((unit) => {
    if (!unit.startsWith("SWEEP")) {
      return payload(unit, ["b0001"], { cite: false, normative: true });
    }
    const out = payload(unit, ["b0001"]);
    const malformed = { ...obligation(unit, ["b0001"], `${unit}-BROKEN`) };
    delete malformed.doc_quote;
    out.obligations.push(malformed);
    return out;
  });
  try {
    const result = await m.passB.runPassB(env, runId, documentFor(m, ["b0001"]), "ignored.docx");
    assertEq(result.slice.terminalFailure, true);
    assert(result.failedUnits.some((row) => row.unit === "SWEEP01"), "the failed sweep is named");
    assertEq(provider.requests.join(","), "C01-b0001,SWEEP01");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "b")), null);
    const artifact = await (await env.EVIDENCE.get(sweepKey(m, runId))).json();
    assertEq(artifact.usages.at(-1).status, "parse-failed");

    provider.reset();
    const resumed = await m.passB.runPassB(env, runId, documentFor(m, ["b0001"]), "ignored.docx");
    assertEq(provider.requests.length, 0, "the terminal sweep is not purchased again");
    assertEq(resumed.slice.terminalFailure, true);
  } finally {
    provider.restore();
  }
});

test("a throwing progress callback cannot overwrite paid success and reentry buys zero", async () => {
  const m = await mod();
  const env = envFor();
  const runId = "run_passb_progress_throw";
  const provider = stubProvider((unit) => payload(unit, ["b0001"]));
  try {
    const progress = async () => { throw new Error("heartbeat unavailable"); };
    const first = await m.passB.runPassB(
      env, runId, documentFor(m, ["b0001"]), "ignored.docx", progress,
    );
    assertEq(first.slice.done, true);
    const artifact = await (await env.EVIDENCE.get(chunkKey(m, runId))).json();
    assertEq(artifact.status, "ok", "observability failure does not rewrite semantic success");

    provider.reset();
    const resumed = await m.passB.runPassB(
      env, runId, documentFor(m, ["b0001"]), "renamed.docx", progress,
    );
    assertEq(provider.requests.length, 0);
    assertEq(resumed.slice.done, true);
  } finally {
    provider.restore();
  }
});

test("corrupt current-key success is terminal on resume and causes zero provider fetches", async () => {
  const m = await mod();
  const env = envFor();
  const runId = "run_passb_corrupt_resume";
  const provider = stubProvider((unit) => payload(unit, ["b0001"]));
  try {
    const doc = documentFor(m, ["b0001"]);
    const first = await m.passB.runPassB(env, runId, doc, "ignored.docx");
    assertEq(first.slice.done, true);

    const key = chunkKey(m, runId);
    const artifact = await (await env.EVIDENCE.get(key)).json();
    artifact.modelOutput.obligations[0].scope = "question";
    await env.EVIDENCE.put(key, JSON.stringify(artifact));

    provider.reset();
    const resumed = await m.passB.runPassB(env, runId, doc, "ignored.docx");
    assertEq(provider.requests.length, 0, "current-key corruption is not treated as a cache miss");
    assertEq(resumed.slice.terminalFailure, true);
    assert(
      resumed.failedUnits.some((row) => row.detail.includes("PASS_B_UNIT_ARTIFACT_INVALID")),
      "the corruption has a named terminal failure",
    );
  } finally {
    provider.restore();
  }
});

test("a current-key receipt with the wrong role is terminal and never authorizes a replacement call", async () => {
  const m = await mod();
  const env = envFor();
  const runId = "run_passb_receipt_binding";
  const provider = stubProvider((unit) => payload(unit, ["b0001"]));
  try {
    const doc = documentFor(m, ["b0001"]);
    assertEq((await m.passB.runPassB(env, runId, doc, "ignored.docx")).slice.done, true);
    const key = chunkKey(m, runId);
    const artifact = await (await env.EVIDENCE.get(key)).json();
    artifact.usages[0].role = "extract-pass-b-some-other-unit";
    await env.EVIDENCE.put(key, JSON.stringify(artifact));

    provider.reset();
    const resumed = await m.passB.runPassB(env, runId, doc, "ignored.docx");
    assertEq(provider.requests.length, 0);
    assertEq(resumed.slice.terminalFailure, true);
    assert(resumed.failedUnits[0].detail.includes("role/call/provider/model"));
  } finally {
    provider.restore();
  }
});

});

suite("Pass B completed authority is reconstructed from immutable units", () => {

test("byte-different DOCX with identical parsed blocks is refused before Pass A buys anything", async () => {
  const m = await mod();
  const bed = await sourceBed(m);
  const replacement = byteDifferentEquivalentDocx(bed.documentBytes);
  assertEquivalentParsedDocument(m, bed.documentBytes, replacement);
  assert(
    await m.hash.sha256Hex(replacement) !== bed.documentSha256,
    "the counterexample must change source bytes while preserving parsed document semantics",
  );
  await bed.env.EVIDENCE.put(bed.documentKey, replacement);

  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("source mismatch must be terminal before Pass A transport");
  };
  try {
    const outcome = await m.extractStage.stagePassASlice(
      bed.env, bed.runId, bed.documentKey, "questionnaire.docx", bed.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, bed.documentSha256,
    );
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "extraction-document-source-authority-invalid");
    assertEq(outcome.slice.done, false);
    assertEq(outcome.slice.terminalFailure, true);
    assertEq(providerRequests, 0);
    assertEq(await bed.env.EVIDENCE.get(m.keys.extractionPassKey(bed.runId, "a")), null);
    assertEq(
      await m.hash.sha256Hex(new Uint8Array(await (await bed.env.EVIDENCE.get(bed.documentKey)).arrayBuffer())),
      await m.hash.sha256Hex(replacement),
      "the refusal does not overwrite the changed object",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transient source-storage failures remain retryable and are not laundered into terminal authority", async () => {
  const m = await mod();
  const bed = await sourceBed(m);
  const originalGet = bed.env.EVIDENCE.get.bind(bed.env.EVIDENCE);
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  bed.env.EVIDENCE.get = async (key) => {
    if (key === bed.documentKey) throw new Error("transient-r2-read-fault");
    return originalGet(key);
  };
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("storage failed before provider authority");
  };
  try {
    await assertThrows(
      () => m.extractStage.stagePassASlice(
        bed.env, bed.runId, bed.documentKey, "questionnaire.docx", bed.fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, bed.documentSha256,
      ),
      "transient-r2-read-fault",
    );
    assertEq(providerRequests, 0);
    assertEq(await originalGet(m.keys.extractionPassKey(bed.runId, "a")), null);
  } finally {
    bed.env.EVIDENCE.get = originalGet;
    globalThis.fetch = originalFetch;
  }
});

test("a same-parsed source swap after Pass A refuses Pass B with zero requests and preserves A", async () => {
  const m = await mod();
  const bed = await passABed(m);
  const passAObject = await bed.env.EVIDENCE.get(m.keys.extractionPassKey(bed.runId, "a"));
  const passABytes = new Uint8Array(await passAObject.arrayBuffer());
  const replacement = byteDifferentEquivalentDocx(bed.documentBytes);
  assertEquivalentParsedDocument(m, bed.documentBytes, replacement);
  assert(await m.hash.sha256Hex(replacement) !== bed.documentSha256);
  await bed.env.EVIDENCE.put(bed.documentKey, replacement);

  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("source mismatch must be terminal before Pass B transport");
  };
  try {
    const outcome = await m.extractStage.stagePassBSlice(
      bed.env, bed.runId, bed.documentKey, "questionnaire.docx", bed.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, bed.passAHash, bed.documentSha256,
    );
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "extraction-document-source-authority-invalid");
    assertEq(outcome.slice.done, false);
    assertEq(outcome.slice.terminalFailure, true);
    assertEq(providerRequests, 0);
    assertEq(await bed.env.EVIDENCE.get(m.keys.extractionPassKey(bed.runId, "b")), null);
    assertEq(
      await m.hash.sha256Hex(new Uint8Array(await (await bed.env.EVIDENCE.get(m.keys.extractionPassKey(bed.runId, "a"))).arrayBuffer())),
      await m.hash.sha256Hex(passABytes),
      "the retained Pass-A authority is not rewritten",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cached source-ledger cannot seal after a byte-different source swap with identical parsed blocks", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const consolidated = await consolidate(m, bed);
    assertEq(consolidated.state, "evaluated");
    assert((await bed.env.EVIDENCE.get(m.keys.sourceLedgerKey(bed.runId))) !== null);
    const replacement = byteDifferentEquivalentDocx(bed.documentBytes);
    assertEquivalentParsedDocument(m, bed.documentBytes, replacement);
    assert(await m.hash.sha256Hex(replacement) !== bed.documentSha256);
    await bed.env.EVIDENCE.put(bed.documentKey, replacement);
    bed.provider.reset();

    const authority = await m.extractStage.validateExtractionSealAuthority(
      bed.env, bed.runId, bed.documentKey, bed.documentSha256,
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx",
      bed.passAHash, bed.passBHash, consolidated.value.mergedHash,
    );
    assertEq(authority.kind, "invalid");
    assertEq(authority.reason, "extraction-document-source-authority-invalid");
    assert(authority.detail.includes("current document bytes do not match"));
    assert(authority.detail.includes("No contract was sealed"));
    assertEq(bed.provider.requests.length, 0);
  } finally {
    bed.provider.restore();
  }
});

test("completed reconstruction is zero-purchase, byte-stable, closed, and returns its exact hash", async () => {
  const m = await mod();
  const env = envFor();
  const runId = "run_passb_reconstruct";
  const provider = stubProvider((unit) => {
    const id = unit.endsWith("b0001") ? "b0001" : "b0002";
    return payload(unit, [id]);
  });
  try {
    const doc = documentFor(m, ["b0001", "b0002"]);
    assertEq((await m.passB.runPassB(env, runId, doc, "ignored.docx")).slice.done, true);
    provider.reset();

    const first = await m.passB.reconstructPassBCompletedAuthority(env, runId, doc, "first.docx");
    const second = await m.passB.reconstructPassBCompletedAuthority(env, runId, doc, "renamed.docx");
    assertEq(first.kind, "ok");
    assertEq(second.kind, "ok");
    assertEq(provider.requests.length, 0, "reconstruction never crosses the provider boundary");
    assertEq(first.body, second.body, "display filename and re-read timing cannot change completion bytes");
    assertEq(first.hash, second.hash);
    assert(/^sha256:[0-9a-f]{64}$/.test(first.hash), "completion returns an exact SHA-256");
    assertEq(first.hash, `sha256:${await m.hash.sha256Hex(first.body)}`, "hash binds the exact completion bytes");
    const parsed = JSON.parse(first.body);
    assertEq(m.passB.passBCompletionShapeClosed(parsed), true);
    assertEq(parsed.requirements.length, 2);
    assertEq(parsed.failedUnits.length, 0);
    assertEq(parsed.slice.done, true);
    assertEq(parsed.issuedCalls.length, 0);
  } finally {
    provider.restore();
  }
});

test("mutating a retained successful unit invalidates reconstruction with zero fetches", async () => {
  const m = await mod();
  const env = envFor();
  const runId = "run_passb_reconstruct_mutated";
  const provider = stubProvider((unit) => payload(unit, ["b0001"]));
  try {
    const doc = documentFor(m, ["b0001"]);
    assertEq((await m.passB.runPassB(env, runId, doc, "ignored.docx")).slice.done, true);
    const key = chunkKey(m, runId);
    const artifact = await (await env.EVIDENCE.get(key)).json();
    artifact.obligations = [];
    await env.EVIDENCE.put(key, JSON.stringify(artifact));

    provider.reset();
    const authority = await m.passB.reconstructPassBCompletedAuthority(env, runId, doc);
    assertEq(provider.requests.length, 0);
    assertEq(authority.kind, "invalid");
    assert(authority.detail.includes("persisted typed arrays do not exactly reconstruct"));
    assertEq(authority.slice.terminalFailure, true);
  } finally {
    provider.restore();
  }
});

test("a retained Pass-B unit mutation blocks integrated consolidation with zero re-buy or partial output", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const key = chunkKey(m, bed.runId);
    const artifact = await (await bed.env.EVIDENCE.get(key)).json();
    artifact.dispositions = [];
    await bed.env.EVIDENCE.put(key, JSON.stringify(artifact));
    bed.provider.reset();

    const outcome = await consolidate(m, bed);
    assertEq(outcome.state, "not-evaluated");
    assertEq(outcome.reason, "PASS_B_COMPLETION_ARTIFACT_INVALID");
    assertEq(
      outcome.detail,
      "Document reading stopped under the named safeguard PASS_B_COMPLETION_ARTIFACT_INVALID.",
    );
    assert(
      !outcome.detail.includes("persisted typed arrays do not exactly reconstruct"),
      "the integrated stage result must not expose the retained internal corruption diagnostic",
    );
    assertEq(bed.provider.requests.length, 0, "authority revalidation never purchases a replacement unit");
    await assertNoConsolidationArtifacts(m, bed);
  } finally {
    bed.provider.restore();
  }
});

test("a changed whole Pass-B completion body is hash-refused before integrated consolidation writes", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const key = m.keys.extractionPassKey(bed.runId, "b");
    const completion = await (await bed.env.EVIDENCE.get(key)).json();
    completion.requirements.push({ id: "forged-summary-only-row" });
    await bed.env.EVIDENCE.put(key, JSON.stringify(completion));
    bed.provider.reset();

    const outcome = await consolidate(m, bed);
    assertEq(outcome.state, "not-evaluated");
    assertEq(outcome.reason, "PASS_B_COMPLETION_ARTIFACT_INVALID");
    assert(outcome.detail.includes("no longer binds current bytes"));
    assertEq(bed.provider.requests.length, 0);
    await assertNoConsolidationArtifacts(m, bed);
  } finally {
    bed.provider.restore();
  }
});

test("integrated consolidation requires the exact durable A and B completion hashes", async () => {
  const m = await mod();
  for (const pass of ["A", "B"]) {
    const bed = await integratedBed(m);
    try {
      bed.provider.reset();
      const altered = {
        ...bed,
        ...(pass === "A"
          ? { passAHash: `sha256:${"0".repeat(64)}` }
          : { passBHash: `sha256:${"0".repeat(64)}` }),
      };
      const outcome = await consolidate(m, altered);
      assertEq(outcome.state, "not-evaluated");
      assertEq(outcome.reason, `PASS_${pass}_COMPLETION_ARTIFACT_INVALID`);
      assert(outcome.detail.includes("no longer binds current bytes"));
      assertEq(bed.provider.requests.length, 0, `${pass} hash validation never reaches a provider`);
      await assertNoConsolidationArtifacts(m, bed);
    } finally {
      bed.provider.restore();
    }
  }
});

test("cached source-ledger state cannot authorize seal after a retained Pass-B unit mutation", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const consolidated = await consolidate(m, bed);
    assertEq(consolidated.state, "evaluated");
    assert((await bed.env.EVIDENCE.get(m.keys.sourceLedgerKey(bed.runId))) !== null);

    const key = chunkKey(m, bed.runId);
    const artifact = await (await bed.env.EVIDENCE.get(key)).json();
    artifact.obligations = [{ id: "forged-after-source-ledger" }];
    await bed.env.EVIDENCE.put(key, JSON.stringify(artifact));
    bed.provider.reset();

    const authority = await m.extractStage.validateExtractionSealAuthority(
      bed.env, bed.runId, bed.documentKey, bed.documentSha256,
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx",
      bed.passAHash, bed.passBHash, consolidated.value.mergedHash,
    );
    assertEq(authority.kind, "invalid");
    assert(authority.detail.includes("PASS_B_COMPLETION_ARTIFACT_INVALID"));
    assert(authority.detail.includes("No contract was sealed"));
    assertEq(bed.provider.requests.length, 0, "seal revalidation is a zero-purchase authority check");
  } finally {
    bed.provider.restore();
  }
});

test("cached source-ledger state cannot authorize seal after a retained Pass-A window mutation", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const consolidated = await consolidate(m, bed);
    assertEq(consolidated.state, "evaluated");
    const key = [...bed.env.EVIDENCE._store.keys()].find((value) => value.endsWith("window-01.json"));
    assert(key, "the exact Pass-A window authority exists");
    const artifact = await (await bed.env.EVIDENCE.get(key)).json();
    artifact.modelOutput.forged_after_source_ledger = true;
    await bed.env.EVIDENCE.put(key, JSON.stringify(artifact));
    bed.provider.reset();

    const authority = await m.extractStage.validateExtractionSealAuthority(
      bed.env, bed.runId, bed.documentKey, bed.documentSha256,
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx",
      bed.passAHash, bed.passBHash, consolidated.value.mergedHash,
    );
    assertEq(authority.kind, "invalid");
    assert(authority.detail.includes("PASS_A_COMPLETION_ARTIFACT_INVALID"));
    assert(authority.detail.includes("No contract was sealed"));
    assertEq(bed.provider.requests.length, 0, "seal-time Pass-A reconstruction never buys replacement work");
  } finally {
    bed.provider.restore();
  }
});

test("seal authority rejects merged bytes that do not bind the exact A and B inputs", async () => {
  const m = await mod();
  const bed = await integratedBed(m);
  try {
    const consolidated = await consolidate(m, bed);
    assertEq(consolidated.state, "evaluated");
    const key = m.extractStage.mergedKey(bed.runId);
    const merged = await (await bed.env.EVIDENCE.get(key)).json();
    merged.inputAuthority.passBHash = `sha256:${"f".repeat(64)}`;
    const body = JSON.stringify(merged, null, 2);
    await bed.env.EVIDENCE.put(key, body);
    bed.provider.reset();

    const authority = await m.extractStage.validateExtractionSealAuthority(
      bed.env, bed.runId, bed.documentKey, bed.documentSha256,
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx",
      bed.passAHash, bed.passBHash, `sha256:${await m.hash.sha256Hex(body)}`,
    );
    assertEq(authority.kind, "invalid");
    assert(authority.detail.includes("does not bind the current document and exact evaluated Pass-A/Pass-B hashes"));
    assertEq(bed.provider.requests.length, 0);
  } finally {
    bed.provider.restore();
  }
});

});
