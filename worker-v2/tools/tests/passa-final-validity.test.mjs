/** A final Pass-A artifact is valid only when every window was successfully read. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, assertEq, assertThrows, fakeStep, loadWorker, memoryR2, REPO_ROOT, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;
const rates = {
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
};

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(), V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account", CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key", DEEPSEEK_API_KEY: "test-deepseek-key",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1", EXTRACT_MAX_ATTEMPTS: "1",
    ...rates, ...overrides,
  };
}

async function bed(m, env) {
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  const documentKey = m.keys.inputDocumentKey(runId);
  const file = path.join(REPO_ROOT, "public", "sample", "questionnaire.docx");
  const documentBytes = readFileSync(file);
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes);
  return { runId, fence, documentKey, documentSha256 };
}

async function workflowBed(m, env) {
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const documentKey = m.keys.inputDocumentKey(runId);
  const file = path.join(REPO_ROOT, "public", "sample", "questionnaire.docx");
  const documentBytes = readFileSync(file);
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes);
  await m.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0", kind: "survey-qa-v2-envelope",
    runId, createdAt: "2026-08-14T00:00:00.000Z", instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey", documentKey,
      documentSha256, documentName: "questionnaire.docx",
      targetBuildId: null, locale: "en", viewports: ["desktop"],
    },
    profile: "standard", contractRevisionId: null, recovery: null, finalCompletion: null,
  });
  return { runId, documentKey, documentSha256 };
}

async function putWholePass(m, env, runId, failedUnits, requirements) {
  const body = JSON.stringify({
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
    providerIndependence: "independent",
    pass: "A", provider: "grok-primary/deepseek-flash-fallback", model: "grok-4.6",
    requirements, ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
    failedUnits, calls: [], crossRefs: [], fallbackTriggers: [], routeReceipts: [],
  });
  await env.EVIDENCE.put(m.keys.extractionPassKey(runId, "a"), body);
  return body;
}

async function putReducedWholePass(m, env, runId) {
  const grokEventId = `core-model-call/pass-a/${runId}/A/issue-1/receipt-1`;
  const trigger = {
    kind: m.passA.GROK_FALLBACK_TRIGGER_VERSION,
    failureKind: "provider-unavailable",
    httpStatus: 502,
    grokModel: "grok-4.6",
    grokUsageEventId: grokEventId,
    detail: "neutral retained provider failure",
  };
  const calls = [
    {
      eventId: grokEventId, callId: "call_a_1", role: "extract-pass-a", provider: "grok",
      model: "grok-4.6", status: "error", inputTokens: 1, outputTokens: 1,
      costUsd: 0, latencyMs: 1, attempts: 1, usageSource: "conservative-ceiling",
    },
    {
      eventId: `core-model-call/pass-a/${runId}/A/issue-1/receipt-2`,
      callId: "call_a_1:grok-fallback", role: "extract-pass-a", provider: "deepseek",
      model: "deepseek-v4-flash", status: "ok", inputTokens: 1, outputTokens: 1,
      costUsd: 0, latencyMs: 1, attempts: 1, usageSource: "provider-reported",
    },
  ];
  await env.EVIDENCE.put(m.keys.extractionPassKey(runId, "a"), JSON.stringify({
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
    providerIndependence: "reduced-same-provider-fallback",
    pass: "A", provider: "grok-primary/deepseek-flash-fallback", model: "grok-4.6",
    requirements: [], ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
    failedUnits: [], calls, crossRefs: [], fallbackTriggers: [trigger],
    routeReceipts: [{ selected: "deepseek-v4-flash", trigger }],
  }));
}

async function putPassB(m, env, runId) {
  await env.EVIDENCE.put(m.keys.extractionPassKey(runId, "b"), JSON.stringify({
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passB.PASS_B_VERSION,
    providerPlanIdentity: m.deepseek.deepseekPassBIdentity(env),
    pass: "B", provider: "deepseek", model: "deepseek-v4-pro",
    requirements: [], ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
    failedUnits: [], calls: [],
  }));
}

function primarySourceRows(user) {
  const startMarker = "===== SOURCE BLOCKS JSONL (one object per physical line) =====";
  const endMarker = "===== END SOURCE BLOCKS JSONL =====";
  const start = user.indexOf(startMarker);
  const end = user.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, "the primary prompt exposes one bounded JSONL source section");
  return user
    .slice(start + startMarker.length, end)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function stubProvider({
  failed = new Set(), failedStatus = 502, emitRules = true, grokFallback = false,
  mutatePrimary = (value) => value,
} = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const match = user.match(/window (\d+) of (\d+)/);
    const window = match ? Number(match[1]) : 1;
    requests.push({ window, model: body.model });
    if (grokFallback && body.model === "grok-4.6") return new Response("unavailable", { status: 502 });
    if (failed.has(window)) return new Response("unavailable", { status: failedStatus });
    const sourceRows = primarySourceRows(user);
    const ids = [...new Set(sourceRows.map((row) => String(row.block_id)))];
    const exactQuote = String(sourceRows[0]?.text ?? "");
    assert(ids.length > 0 && exactQuote.length > 0, "the fixture reads exact source authority from JSONL");
    const rules = [];
    if (emitRules) rules.push({
      id: "A-w" + window, construct: "instruction", scope: "survey", quantifier: "every",
      selector: null, exceptions: [],
      statement: "the cited source text is an instruction", doc_quote: exactQuote,
      block_ids: [ids[0]],
      evidence_quotes: [{ block_id: ids[0], quote: exactQuote }],
      browser_observable: "full", confidence: 0.9,
    });
    const content = JSON.stringify(mutatePrimary({
      global_rules: rules, cross_references: [], ambiguities: [], unverifiable_from_browser: [],
    }));
    return Response.json({
      model: body.model, usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ message: { content }, finish_reason: "stop" }],
    });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

suite("Pass A final payload validity", () => {

test("mixed success plus a failed window leaves no final Pass-A payload", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "1000" });
  const ctx = await bed(m, env);
  const transport = stubProvider({ failed: new Set([2]), failedStatus: 401 });
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(outcome.terminal, true, "a shared nonretryable provider failure is terminal, not a new wave");
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "PASS_A_WINDOW_FAILURES");
    assert(outcome.slice.windowsRemaining > 0, "unread tail windows remain explicitly counted");
    assert(transport.requests.some((row) => row.window === 1), "a healthy window really succeeded");
    assert(transport.requests.some((row) => row.window === 2), "a different window really failed");
    assertEq(
      await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a")),
      null,
      "no final payload is persisted when any window failed",
    );
  } finally {
    transport.restore();
  }
});

test("a retained nonretryable Pass-A failure is never re-bought after the stage boundary", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });
  const ctx = await bed(m, env);
  const first = stubProvider({ failed: new Set([1]), failedStatus: 401 });
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "PASS_A_WINDOW_FAILURES");
    assertEq(first.requests.length, 1, "the first shared failure stops before later windows");
    const windowKey = [...env.EVIDENCE._store.keys()].find((key) => key.endsWith("window-01.json"));
    const artifact = JSON.parse(await (await env.EVIDENCE.get(windowKey)).text());
    assertEq(
      artifact.terminal,
      true,
      "the writer durably classifies a shared nonretryable failure; reclaim is a second defence",
    );
  } finally {
    first.restore();
  }
  const resumed = stubProvider();
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "PASS_A_WINDOW_FAILURES");
    assertEq(resumed.requests.length, 0, "the terminal artifact is durable authority across a retry");
    assert(outcome.slice.windowsRemaining > 0, "resume retains the unread denominator");
  } finally {
    resumed.restore();
  }
});

test("a receipted Flash substitute stops before later windows or a final Pass-A payload can authorize Pass B", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1", EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
  const ctx = await bed(m, env);
  const transport = stubProvider({ grokFallback: true });
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(outcome.terminal, true, "the provider decision is terminal for the pass, not resumable work");
    assertEq(outcome.slice.done, false, "terminal refusal is not misreported as whole-document completion");
    assert(outcome.slice.windowsTotal > 2, "the neutral document genuinely has later windows that could be overspent");
    assertEq(outcome.slice.windowsLanded, 1, "only the receipted substitute window landed");
    assertEq(outcome.slice.windowsRemaining, outcome.slice.windowsTotal - 1, "every unread tail window stays counted");
    assertEq(outcome.result.state, "not-evaluated", "a deliberate refusal is a durable value, not a retryable throw");
    assertEq(outcome.result.reason, "REDUCED_PROVIDER_INDEPENDENCE");
    assert(
      transport.requests.some((row) => row.model === "grok-4.6"),
      "the primary Grok route must really fail before the refusal",
    );
    assert(
      transport.requests.some((row) => row.model === "deepseek-v4-flash"),
      "the receipted substitute must really land before the refusal",
    );
    assertEq(
      transport.requests.map((row) => row.model).join(","),
      "grok-4.6,deepseek-v4-flash",
      "no later window is purchased after success became impossible",
    );
    assertEq(
      await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a")),
      null,
      "no final Pass-A artifact exists for the workflow to carry into Pass B",
    );
  } finally {
    transport.restore();
  }
});

test("fallback authority without a usable Flash receipt is a window failure, not reduced independence", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1",
  });
  const ctx = await bed(m, env);
  const first = stubProvider({ grokFallback: true, failed: new Set([1]) });
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(first.requests.map((row) => row.model).join(","), "grok-4.6,deepseek-v4-flash",
      "the primary trigger and failed substitute are both real transport attempts");
    assertEq(outcome.result.state, "not-evaluated");
    assertEq(outcome.result.reason, "PASS_A_WINDOW_FAILURES",
      "authorizing fallback is not evidence that a same-family substitute landed");
    assertEq(outcome.slice.terminalFailure, true);
    assertEq(outcome.slice.done, false);
  } finally {
    first.restore();
  }

  const resumed = stubProvider();
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(resumed.requests.length, 0, "the retained terminal artifact is reclaimed without a new purchase");
    assertEq(outcome.result.reason, "PASS_A_WINDOW_FAILURES",
      "reclaim still distinguishes failed fallback authority from landed Flash");
  } finally {
    resumed.restore();
  }
});

test("the full Workflow terminalizes a provider-independence refusal without retry or Pass B", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_MAX_WAVES: "3",
  });
  const ctx = await workflowBed(m, env);
  const transport = stubProvider({ grokFallback: true });
  const step = fakeStep();
  try {
    const workflow = new m.workflow.SurveyRunWorkflowV2({}, env);
    await workflow.run({
      payload: {
        runId: ctx.runId, surveyUrl: "https://fixture.invalid/survey",
        documentKey: ctx.documentKey, documentSha256: ctx.documentSha256,
        profile: "standard", locale: "en", viewports: ["desktop"],
      },
    }, step);

    assertEq(
      step.calls.filter((name) => name.startsWith("extract-pass-a-wave-")).length,
      1,
      "the completed refusal is not retried as another Workflow wave",
    );
    assertEq(
      step.calls.filter((name) => name.startsWith("extract-pass-b-wave-")).length,
      0,
      "the independently-routed Pass B is never purchased after independence has collapsed",
    );
    assert(step.calls.includes("stop-extract-pass-a-not-evaluated"), "the named stop is its own durable step");
    assert(!step.calls.includes("record-failure"), "a policy refusal is not laundered into an uncaught workflow error");
    assert(step.calls.includes("report") && step.calls.includes("finalize"), "the refusal reaches report finalization");
    assertEq(
      transport.requests.map((row) => row.model).join(","),
      "grok-4.6,deepseek-v4-flash",
      "only the primary and its authorized substitute were bought",
    );

    const cp = (await m.checkpoint.loadCheckpoint(env, ctx.runId)).checkpoint;
    assertEq(cp.completion.test, "failed", "nothing was exercised, so the test axis fails rather than going partial");
    assertEq(cp.completion.reasonCode, "extraction-pass-a-reduced-provider-independence");
    assert(cp.failure == null, "no retryable exception was recorded");
    assertEq(
      cp.error,
      "The document read stopped because the required independent extraction routes were not available.",
      "the public detail names the independence safeguard without copying provider or model output",
    );
    assert(!cp.error.includes("REDUCED_PROVIDER_INDEPENDENCE"), "internal stage prose is not public status text");
    assert(!cp.error.includes("remain unread"), "internal coverage prose is not public status text");
    const extraction = cp.phases.find((phase) => phase.name === "extracting");
    assertEq(extraction?.reasonCode, cp.completion.reasonCode, "phase and run expose one durable reason vocabulary");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a")), null, "no final Pass-A payload was authorized");
  } finally {
    transport.restore();
  }
});

test("the full Workflow terminalizes strict primary schema failure with zero Pass B or seal", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
    EXTRACT_PASS_A_MAX_WAVES: "3",
  });
  const ctx = await workflowBed(m, env);
  const transport = stubProvider({
    mutatePrimary: (value) => {
      value.global_rules[0].ignored_authority = "would have been silently dropped";
      return value;
    },
  });
  const step = fakeStep();
  try {
    const workflow = new m.workflow.SurveyRunWorkflowV2({}, env);
    await workflow.run({
      payload: {
        runId: ctx.runId, surveyUrl: "https://fixture.invalid/survey",
        documentKey: ctx.documentKey, documentSha256: ctx.documentSha256,
        profile: "standard", locale: "en", viewports: ["desktop"],
      },
    }, step);
    assertEq(transport.requests.length, 1, "one malformed primary purchase is retained terminal authority");
    assertEq(step.calls.filter((name) => name.startsWith("extract-pass-b-wave-")).length, 0);
    assert(!step.calls.includes("source-ledger"), "invalid Pass A cannot reach merge");
    assert(!step.calls.includes("seal-contract-revision"), "invalid Pass A cannot reach seal");
    const cp = (await m.checkpoint.loadCheckpoint(env, ctx.runId)).checkpoint;
    assertEq(cp.completion.reasonCode, "extraction-pass-a-pass-a-window-failures");
    assertEq(
      cp.error,
      "Document reading stopped under the named safeguard extraction-pass-a-pass-a-window-failures.",
      "strict-schema internals remain retained evidence rather than public status text",
    );
    assert(!cp.error.includes("keys are not closed"), "raw schema-decoder detail is not public status text");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a")), null);
  } finally {
    transport.restore();
  }
});

test("the full Workflow terminalizes synthesis wire overflow before purchase and never reaches Pass B", async () => {
  const m = await mod();
  const env = envFor({
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "1",
    EXTRACT_PASS_A_MAX_WAVES: "10",
  });
  const ctx = await workflowBed(m, env);
  const { doc } = await m.extractStage.loadDocument(
    env, ctx.documentKey, ctx.documentSha256, m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
  );
  env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS = String(Math.max(1, Math.ceil(doc.blocks.length / 2)));
  const transport = stubProvider();
  const step = fakeStep();
  try {
    const workflow = new m.workflow.SurveyRunWorkflowV2({}, env);
    await workflow.run({
      payload: {
        runId: ctx.runId, surveyUrl: "https://fixture.invalid/survey",
        documentKey: ctx.documentKey, documentSha256: ctx.documentSha256,
        profile: "standard", locale: "en", viewports: ["desktop"],
      },
    }, step);
    assert(transport.requests.length >= 2, "the document really landed multiple primary windows");
    assert(
      transport.requests.every((request) => request.model === "grok-4.6"),
      "the oversize synthesis and every Pass-B provider request remain at zero",
    );
    assertEq(step.calls.filter((name) => name.startsWith("extract-pass-b-wave-")).length, 0);
    assert(!step.calls.includes("source-ledger"));
    assert(!step.calls.includes("seal-contract-revision"));
    const cp = (await m.checkpoint.loadCheckpoint(env, ctx.runId)).checkpoint;
    assertEq(
      cp.completion.reasonCode,
      "extraction-model-input-wire-ceiling-exceeded",
      `synthesis overflow reason; detail=${cp.error}`,
    );
    assertEq(
      cp.error,
      "A document-reading unit exceeded the configured safe input limit; this refusal issued no new credential lookup or provider request.",
      "the exact public wire-limit reason survives the Workflow stop",
    );
    assert(
      !cp.error.includes("extraction-pass-a-pass-a-synthesis-failure"),
      "the legacy generic synthesis reason is not public status text",
    );
    assert(!cp.error.includes("PASS_A_SYNTHESIS_REQUEST_TOO_LARGE"), "raw wire-limit detail is not public status text");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a")), null);
  } finally {
    transport.restore();
  }
});

test("a retained summary-only reduced-independence payload is immutable invalid authority", async () => {
  const m = await mod();
  const env = envFor();
  const ctx = await workflowBed(m, env);
  await putReducedWholePass(m, env, ctx.runId);
  const transport = stubProvider();
  const step = fakeStep();
  try {
    const workflow = new m.workflow.SurveyRunWorkflowV2({}, env);
    await workflow.run({
      payload: {
        runId: ctx.runId, surveyUrl: "https://fixture.invalid/survey",
        documentKey: ctx.documentKey, documentSha256: ctx.documentSha256,
        profile: "standard", locale: "en", viewports: ["desktop"],
      },
    }, step);
    assertEq(transport.requests.length, 0, "resume neither re-buys Pass A nor purchases DeepSeek Pro Pass B");
    assertEq(step.calls.filter((name) => name.startsWith("extract-pass-b-wave-")).length, 0);
    const cp = (await m.checkpoint.loadCheckpoint(env, ctx.runId)).checkpoint;
    assertEq(cp.completion.reasonCode, "extraction-pass-a-pass-a-completion-artifact-invalid");
  } finally {
    transport.restore();
  }
});

test("an evaluated extraction pass is not misclassified as a terminal refusal", async () => {
  const m = await mod();
  assertEq(
    m.workflow.extractionPassRefusal("a", {
      state: "evaluated", value: {},
      proof: { evaluatorId: "fixture", evaluatorVersion: "1", inputHash: "sha256:x", observedAt: "now" },
    }),
    null,
    "the stop path must not over-correct and intercept a healthy pass",
  );
});

test("occupied all-failed and mixed-failed final keys are immutable terminal authority", async () => {
  const m = await mod();
  const cases = [["all-failed", []], ["mixed-failed", [{ id: "retained-success" }]]];
  for (const [label, requirements] of cases) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
    const ctx = await bed(m, env);
    const original = await putWholePass(
      m, env, ctx.runId,
      [{ unit: "A", blockIds: ["b0001"], detail: "legacy terminal failure" }],
      requirements,
    );
    const transport = stubProvider();
    try {
      const outcome = await m.extractStage.stagePassASlice(
        env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
      );
      assertEq(outcome.result.state, "not-evaluated", label + ": occupied invalid final is refused");
      assertEq(outcome.result.reason, "PASS_A_COMPLETION_ARTIFACT_INVALID");
      assertEq(transport.requests.length, 0, label + ": immutable authority forbids duplicate model work");
      const obj = await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a"));
      assertEq(await obj.text(), original, label + ": invalid occupied bytes are never overwritten");
    } finally {
      transport.restore();
    }
  }
});

test("consolidation refuses a current mixed-failed Pass-A payload", async () => {
  const m = await mod();
  const env = envFor();
  const ctx = await bed(m, env);
  const retained = [{
    id: "A-1", construct: "instruction", scope: "survey", quantifier: "every",
    selector: null, exceptions: [], statement: "every question is compulsory",
    docQuote: "Every question is compulsory.", blockIds: ["b0001"],
    browserObservable: "full", confidence: 0.9,
  }];
  const passABody = await putWholePass(
    m, env, ctx.runId,
    [{ unit: "A-w2", blockIds: ["b0002"], detail: "legacy terminal failure" }],
    retained,
  );
  await putPassB(m, env, ctx.runId);
  const outcome = await m.extractStage.stageConsolidate(
    env, ctx.runId, ctx.documentKey, ctx.documentSha256, "en", ["desktop"],
    m.docxBlocks.DOCUMENT_SEMANTICS_NONE, "questionnaire.docx",
    `sha256:${await m.hash.sha256Hex(passABody)}`,
    `sha256:${"0".repeat(64)}`,
  );
  assertEq(outcome.state, "not-evaluated", "failed Pass-A bytes are not consolidation input");
  assertEq(outcome.reason, "PASS_A_COMPLETION_ARTIFACT_INVALID", "the invalid completion authority is named");
  assert(outcome.detail.includes("PASS_A_COMPLETED_ARTIFACT_INVALID"), "the refusal binds the retained A bytes");
  assertEq(await env.EVIDENCE.get(m.extractStage.mergedKey(ctx.runId)), null, "no merged artifact is written");
});

test("a complete successful reading may contain zero requirements", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
  const ctx = await bed(m, env);
  const transport = stubProvider({ emitRules: false });
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(outcome.result.state, "evaluated", "empty is valid after a successful complete read");
    assertEq(outcome.result.value.requirementCount, 0, "the summary reports the honest empty result");
    assert(
      (await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a"))) !== null,
      "the successful zero-requirement pass is persisted",
    );
  } finally {
    transport.restore();
  }
});

test("a changed completed Pass-A hash blocks Pass B before any provider request", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "999999", EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999" });
  const ctx = await bed(m, env);
  const transport = stubProvider({ emitRules: false });
  try {
    const passA = await m.extractStage.stagePassASlice(
      env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE, ctx.documentSha256,
    );
    assertEq(passA.result.state, "evaluated");
    const passAKey = m.keys.extractionPassKey(ctx.runId, "a");
    const parsed = JSON.parse(await (await env.EVIDENCE.get(passAKey)).text());
    parsed.crossRefs.push({
      id: "forged-summary-row", fromBlock: null, target: "none", resolvedToBlock: null,
      statement: "not present in retained paid units",
    });
    const corrupted = JSON.stringify(parsed);
    await env.EVIDENCE.put(passAKey, corrupted);
    transport.requests.length = 0;
    const passB = await m.extractStage.stagePassBSlice(
      env,
      ctx.runId,
      ctx.documentKey,
      "questionnaire.docx",
      ctx.fence,
      async () => {},
      {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      passA.result.value.hash,
      ctx.documentSha256,
    );
    assertEq(passB.result.state, "not-evaluated");
    assertEq(passB.result.reason, "PASS_A_COMPLETION_ARTIFACT_INVALID");
    assertEq(transport.requests.length, 0, "the independent A hash check runs before any Pass-B credential/provider I/O");
    assertEq(await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "b")), null);
    assertEq(await (await env.EVIDENCE.get(passAKey)).text(), corrupted, "invalid completion bytes are not rewritten");
  } finally {
    transport.restore();
  }
});

});
