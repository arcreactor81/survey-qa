/** A final Pass-A artifact is valid only when every window was successfully read. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, REPO_ROOT, suite, test } from "../testkit.mjs";

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
  await env.EVIDENCE.put(documentKey, readFileSync(file));
  return { runId, fence, documentKey };
}

async function putWholePass(m, env, runId, failedUnits, requirements) {
  await env.EVIDENCE.put(m.keys.extractionPassKey(runId, "a"), JSON.stringify({
    parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
    providerIndependence: "independent",
    pass: "A", provider: "grok-primary/deepseek-flash-fallback", model: "grok-4.6",
    requirements, ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
    failedUnits, calls: [], crossRefs: [], fallbackTriggers: [], routeReceipts: [],
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

function stubProvider({ failed = new Set(), emitRules = true, grokFallback = false } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const match = user.match(/window (\d+) of (\d+)/);
    const window = match ? Number(match[1]) : 1;
    requests.push({ window, model: body.model });
    if (grokFallback && body.model === "grok-4.6") return new Response("unavailable", { status: 502 });
    if (failed.has(window)) return new Response("unavailable", { status: 502 });
    const ids = [...new Set([...user.matchAll(/\[(b\d{4})\]/g)].map((row) => row[1]))];
    const rules = [];
    if (emitRules) rules.push({
      id: "A-w" + window, construct: "instruction", scope: "survey", quantifier: "every",
      selector: null, exceptions: [],
      statement: "every question is compulsory", doc_quote: "Every question is compulsory.",
      block_ids: ids, browser_observable: "full", confidence: 0.9,
    });
    const content = JSON.stringify({
      global_rules: rules, cross_references: [], ambiguities: [], unverifiable_from_browser: [],
    });
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
  const transport = stubProvider({ failed: new Set([2]) });
  try {
    await assertThrows(
      () => m.extractStage.stagePassASlice(
        env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      ),
      "PASS_A_WINDOW_FAILURES",
      "successful neighbours cannot substitute for the failed window",
    );
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

test("a receipted Flash substitute stops before a final Pass-A payload can authorize Pass B", async () => {
  const m = await mod();
  const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
  const ctx = await bed(m, env);
  const transport = stubProvider({ grokFallback: true });
  try {
    await assertThrows(
      () => m.extractStage.stagePassASlice(
        env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      ),
      "REDUCED_PROVIDER_INDEPENDENCE",
      "a same-family fallback cannot authorize the independently-read Pass B purchase",
    );
    assert(
      transport.requests.some((row) => row.model === "grok-4.6"),
      "the primary Grok route must really fail before the refusal",
    );
    assert(
      transport.requests.some((row) => row.model === "deepseek-v4-flash"),
      "the receipted substitute must really land before the refusal",
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

test("current all-failed and mixed-failed payloads cannot take early reuse", async () => {
  const m = await mod();
  const cases = [["all-failed", []], ["mixed-failed", [{ id: "retained-success" }]]];
  for (const [label, requirements] of cases) {
    const env = envFor({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
    const ctx = await bed(m, env);
    await putWholePass(
      m, env, ctx.runId,
      [{ unit: "A", blockIds: ["b0001"], detail: "legacy terminal failure" }],
      requirements,
    );
    const transport = stubProvider();
    try {
      const outcome = await m.extractStage.stagePassASlice(
        env, ctx.runId, ctx.documentKey, "questionnaire.docx", ctx.fence, async () => {}, {},
      );
      assertEq(outcome.result.state, "evaluated", label + ": fresh reading evaluates");
      assert(transport.requests.length > 0, label + ": poisoned bytes do not suppress model work");
      const obj = await env.EVIDENCE.get(m.keys.extractionPassKey(ctx.runId, "a"));
      const stored = JSON.parse(await obj.text());
      assertEq(stored.failedUnits.length, 0, label + ": valid bytes replace the poisoned artifact");
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
  await putWholePass(
    m, env, ctx.runId,
    [{ unit: "A-w2", blockIds: ["b0002"], detail: "legacy terminal failure" }],
    retained,
  );
  await putPassB(m, env, ctx.runId);
  const outcome = await m.extractStage.stageConsolidate(
    env, ctx.runId, ctx.documentKey, "d".repeat(64), "en", ["desktop"],
  );
  assertEq(outcome.state, "not-evaluated", "failed Pass-A bytes are not consolidation input");
  assertEq(outcome.reason, "MISSING_PASS", "the invalid pass is named as unavailable");
  assert(outcome.detail.includes("pass A left no payload"), "valid pass B isolates the refusal to pass A");
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

});
