import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { executeLiveBakeoff } from "./live-bakeoff-core.mjs";
import {
  LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION,
  LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION,
  LIVE_BAKEOFF_MODELS,
  LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE,
} from "./live-contract.mjs";
import {
  PRODUCTION_PROMPT_SHA256,
  PRODUCTION_RESPONSE_SCHEMA_SHA256,
  VISUAL_PROMPT_VERSION,
  VISUAL_RESPONSE_SCHEMA_VERSION,
} from "./schema.mjs";
import {
  DEFAULT_MANIFEST_PATH,
  evaluateSuite,
  loadEvaluatorProvenance,
  loadFixtures,
  loadPredictionRecords,
} from "./suite.mjs";

const ENDPOINT = "http://127.0.0.1:8788/invoke";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TEST_TEMP_ROOT = path.resolve(".test-tmp");
const WRANGLER_CONFIG_PATH = fileURLToPath(new URL("../../wrangler.vision-bakeoff.jsonc", import.meta.url));
const LIVE_WORKER_PATH = fileURLToPath(new URL("./live-worker.ts", import.meta.url));
const fixtures = await loadFixtures(DEFAULT_MANIFEST_PATH);
const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

test("local Wrangler config pins the project-supported workerd compatibility date", async () => {
  const source = await readFile(WRANGLER_CONFIG_PATH, "utf8");
  assert.match(source, /"compatibility_date"\s*:\s*"2026-06-01"/);
  assert.match(source, /"workers_dev"\s*:\s*false/);
  assert.match(source, /"preview_urls"\s*:\s*false/);
  assert.match(source, /"remote"\s*:\s*true/);
});

test("fake endpoint produces per-model records and separately admissible provenance", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.equal(url, ENDPOINT);
      assert.equal(init.method, "POST");
      const request = JSON.parse(init.body);
      assert.equal(request.schemaVersion, LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION);
      const fixture = fixtureById.get(request.fixtureId);
      return completedResponse(request, { modelContent: fixture.expectedInventory });
    };

    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 6 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "planned-calls-complete");
    assert.equal(summary.claimedAttemptCount, 6);
    assert.equal(summary.unclaimedPlannedEntryCount, 0);
    assert.equal(summary.recordedPredictionCount, 6);
    assert.equal(calls, 6);

    for (const candidate of LIVE_BAKEOFF_MODELS) {
      const predictionsPath = path.join(outputDir, `predictions.${candidate.selector}.json`);
      const provenancePath = path.join(outputDir, `evaluator-provenance.${candidate.selector}.json`);
      const [records, provenance] = await Promise.all([
        loadPredictionRecords(predictionsPath),
        loadEvaluatorProvenance(provenancePath),
      ]);
      assert.equal(records.length, 3);
      for (const record of records) {
        assert.equal(record.evidenceClass, "provider-observed");
        assert.equal(record.measurement.attempted, true);
        assert.ok(record.measurement.costUsd > 0);
      }
      const report = await evaluateSuite(fixtures, records, {}, provenance);
      assert.equal(report.admissionPassed, true, JSON.stringify(report.admissionErrors));
      assert.equal(report.passed, true);
    }
  });
});

test("production upper-bound reservation stops before a call that could cross $0.05", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      const request = JSON.parse(init.body);
      return completedResponse(request, {
        inputTokens: 256_000,
        outputTokens: 2_048,
        modelContent: fixtureById.get(request.fixtureId).expectedInventory,
      });
    };
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 2 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "precall-cost-reservation-exceeds-ceiling");
    assert.equal(summary.claimedAttemptCount, 1);
    assert.equal(summary.completedResultCount, 1);
    assert.equal(calls, 1);
    assert.ok(summary.knownCostUsd > 0.026 && summary.knownCostUsd < 0.027);
    assert.ok(summary.knownCostUsd < summary.globalCostCeilingUsd);
  });
});

test("one missing token count stays null-cost and stops before another fetch", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      return completedResponse(JSON.parse(init.body), { inputTokens: null, outputTokens: 37 });
    };
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 3 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "unknown-cost-or-accounting");
    assert.equal(summary.unknownAccountingCount, 1);
    assert.equal(summary.knownCostUsd, 0);
    assert.equal(summary.recordedPredictionCount, 0);
    assert.equal(calls, 1);
    const events = await readJournal(outputDir);
    const accounting = events.find((event) => event.event === "result").accounting;
    assert.equal(accounting.status, "unknown");
    assert.equal(accounting.costUsd, null);
    assert.equal(accounting.inputTokens, null);
    assert.equal(accounting.outputTokens, 37);
    assert.equal(accounting.ratesPerMillionUsd, null);
  });
});

test("restart never repurchases a claim whose outcome is indeterminate", async () => {
  await withOutputDirectory(async (outputDir) => {
    let firstFetches = 0;
    await assert.rejects(
      executeLiveBakeoff(
        { endpoint: ENDPOINT, outputDir, maxCalls: 2 },
        deterministicDependencies({
          fetchImpl: async () => {
            firstFetches += 1;
            throw new Error("must not fetch before crash injection");
          },
          afterClaim: async () => {
            throw new Error("simulated process loss after durable claim");
          },
        }),
      ),
      /simulated process loss/,
    );
    assert.equal(firstFetches, 0);

    let restartFetches = 0;
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 2 },
      deterministicDependencies({
        fetchImpl: async () => {
          restartFetches += 1;
          throw new Error("restart must not fetch");
        },
      }),
    );
    assert.equal(summary.stoppedReason, "indeterminate-attempt");
    assert.equal(summary.claimedAttemptCount, 1);
    assert.equal(summary.completedResultCount, 0);
    assert.equal(restartFetches, 0);
    assert.equal((await readJournal(outputDir)).length, 1);
  });
});

test("measurable provider error is charged once and never retried", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      const request = JSON.parse(init.body);
      const candidate = modelFor(request.modelSelector);
      return jsonResponse(
        {
          schemaVersion: LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION,
          fixtureId: request.fixtureId,
          modelSelector: request.modelSelector,
          callId: request.callId,
          attempted: true,
          status: "error",
          telemetry: telemetry(candidate.modelSpec.model, 123, 45),
          error: { code: "provider-returned-error" },
        },
        502,
      );
    };
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 4 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "provider-error");
    assert.equal(summary.unknownAccountingCount, 0);
    assert.ok(summary.knownCostUsd > 0);
    assert.equal(summary.recordedPredictionCount, 0);
    assert.equal(calls, 1);
  });
});

test("reported model drift with both token counts remains unknown and stops", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      const request = JSON.parse(init.body);
      return completedResponse(request, {
        inputTokens: 100,
        outputTokens: 20,
        reportedModel: "substituted/unknown-model",
      });
    };
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 2 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "unknown-cost-or-accounting");
    assert.equal(summary.knownCostUsd, 0);
    assert.equal(summary.unknownAccountingCount, 1);
    assert.equal(calls, 1);
    const result = (await readJournal(outputDir)).find((event) => event.event === "result");
    assert.equal(result.accounting.reason, "reported-model-drift");
    assert.equal(result.accounting.costUsd, null);
    assert.equal(result.accounting.inputTokens, 100);
    assert.equal(result.accounting.outputTokens, 20);
  });
});

test("malformed model content keeps its measurable attempt ledger but cannot pass evaluation", async () => {
  await withOutputDirectory(async (outputDir) => {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      return completedResponse(JSON.parse(init.body), { modelContent: "not-structured-model-content" });
    };
    const summary = await executeLiveBakeoff(
      { endpoint: ENDPOINT, outputDir, maxCalls: 1 },
      deterministicDependencies({ fetchImpl }),
    );
    assert.equal(summary.stoppedReason, "planned-calls-complete");
    assert.equal(summary.recordedPredictionCount, 1);
    assert.ok(summary.knownCostUsd > 0);
    assert.equal(calls, 1);

    const selector = LIVE_BAKEOFF_MODELS[0].selector;
    const records = await loadPredictionRecords(path.join(outputDir, `predictions.${selector}.json`));
    const provenance = await loadEvaluatorProvenance(
      path.join(outputDir, `evaluator-provenance.${selector}.json`),
    );
    assert.equal(records[0].modelContent, "not-structured-model-content");
    assert.equal(records[0].measurement.costUsd, summary.knownCostUsd);
    const result = (await readJournal(outputDir)).find((event) => event.event === "result");
    assert.equal(result.detail, "model-content-schema-invalid");
    assert.equal(result.accounting.status, "known");
    const report = await evaluateSuite([fixtures[0]], records, {}, provenance);
    assert.equal(report.reports[0].admission.eligible, true);
    assert.equal(report.qualityPassed, false);
    assert.equal(report.admissionPassed, false);
  });
});

test("local bakeoff preserves an adapter preflight failure as not attempted", async () => {
  const source = await readFile(LIVE_WORKER_PATH, "utf8");
  assert.match(
    source,
    /const attempted = stableProviderCallAttempted\(error\);/,
    "the endpoint catch must project the adapter's paid-boundary classification",
  );
  assert.match(
    source,
    /failure\(input, attempted, stableProviderFailureCode\(error\), telemetry\)/,
    "the projected attempted value must reach the endpoint error artifact",
  );
  const workerModule = await loadBundledWorkerModule();
  const rawDetail = "PRIVATE_PREFLIGHT_DETAIL_MUST_NOT_LEAVE";
  const typedFailure = (overrides = {}, telemetry = null) => Object.assign(
    new workerModule.VisionProviderUnavailableError(rawDetail, telemetry),
    {
      providerFailureCategory: "workers-ai-binding",
      providerFailureCode: "request-contract-invalid",
      providerFailurePhase: "preflight",
      providerCallAttempted: false,
      ...overrides,
    },
  );
  for (const code of [
    "request-contract-invalid",
    "request-screenshot-too-large",
    "request-payload-invalid",
  ]) {
    assert.equal(
      workerModule.stableProviderCallAttempted(typedFailure({ providerFailureCode: code })),
      false,
    );
  }
  for (const contradictory of [
    typedFailure({ providerFailurePhase: "binding" }),
    typedFailure({ providerFailurePhase: "response" }),
    typedFailure({ providerFailureCode: "inference-upstream" }),
    typedFailure({ providerFailureCategory: "other-adapter" }),
    typedFailure({ providerCallAttempted: true }),
    typedFailure({}, {}),
  ]) {
    assert.equal(
      workerModule.stableProviderCallAttempted(contradictory),
      true,
      "a contradictory typed failure must remain a conservative paid attempt",
    );
  }
  assert.equal(
    workerModule.stableProviderCallAttempted(new Error("unclassified binding failure")),
    true,
    "unknown errors remain conservative paid-attempts",
  );
  const hostile = {};
  Object.defineProperty(hostile, "providerCallAttempted", {
    get() { throw new Error(rawDetail); },
  });
  assert.equal(
    workerModule.stableProviderCallAttempted(hostile),
    true,
    "a hostile error accessor cannot forge a free preflight classification",
  );
});

test("local Worker uses both production adapters once and rejects unbound PNGs before AI", async () => {
  const worker = await loadBundledWorker();
  const fixture = fixtures[0];
  const screenshotBytes = await readFile(path.join(path.dirname(DEFAULT_MANIFEST_PATH), fixture.screenshot.file));
  const calls = [];
  const ai = {
    aiGatewayLogId: null,
    async run(model, input, options) {
      calls.push({ model, input, options });
      return {
        id: `fake-request-${calls.length}`,
        object: "chat.completion",
        created: 1,
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: JSON.stringify(fixture.expectedInventory), refusal: null },
          finish_reason: "stop",
          logprobs: null,
        }],
        usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      };
    },
  };
  const env = { AI: ai, BAKEOFF_LOCAL_ONLY: "true", BAKEOFF_GATEWAY_ID: "firstgateway" };

  for (const candidate of LIVE_BAKEOFF_MODELS) {
    const requestBody = endpointRequest(fixture, screenshotBytes, candidate.selector, `worker-fake-${calls.length + 1}`);
    const response = await worker.fetch(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.status, "completed");
    assert.equal(body.telemetry.reportedModel, candidate.modelSpec.model);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, LIVE_BAKEOFF_MODELS[0].modelSpec.model);
  assert.equal(calls[0].options.gateway, undefined);
  assert.equal(calls[1].model, LIVE_BAKEOFF_MODELS[1].modelSpec.model);
  assert.deepEqual(calls[1].options.gateway, {
    id: "firstgateway",
    collectLog: false,
    retries: { maxAttempts: 1 },
    skipCache: true,
  });
  for (const call of calls) assert.equal(call.input.max_completion_tokens, 2_048);

  const tampered = endpointRequest(fixture, screenshotBytes, LIVE_BAKEOFF_MODELS[0].selector, "tampered-png");
  tampered.screenshot.base64 = Buffer.from("not the bound png").toString("base64");
  const rejected = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tampered),
    }),
    env,
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).attempted, false);
  assert.equal(calls.length, 2);

  const classifiedFailure = new Error("sensitive provider detail must not escape");
  classifiedFailure.name = "InferenceUpstreamError";
  const failed = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        endpointRequest(fixture, screenshotBytes, LIVE_BAKEOFF_MODELS[0].selector, "classified-failure"),
      ),
    }),
    {
      ...env,
      AI: { async run() { throw classifiedFailure; } },
    },
  );
  assert.equal(failed.status, 502);
  const failedText = await failed.text();
  const failedBody = JSON.parse(failedText);
  assert.equal(failedBody.attempted, true);
  assert.equal(
    failedBody.error.code,
    "provider-unavailable-workers-ai-binding-inference-upstream",
  );
  assert.equal(failedText.includes(classifiedFailure.message), false);

  const unclassifiedFailure = new Error("another sensitive upstream detail");
  unclassifiedFailure.name = "UndocumentedProviderFailure";
  const unclassified = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        endpointRequest(fixture, screenshotBytes, LIVE_BAKEOFF_MODELS[0].selector, "unclassified-failure"),
      ),
    }),
    {
      ...env,
      AI: { async run() { throw unclassifiedFailure; } },
    },
  );
  const unclassifiedText = await unclassified.text();
  assert.equal(unclassified.status, 502);
  assert.equal(
    JSON.parse(unclassifiedText).error.code,
    "provider-unavailable-workers-ai-binding-unclassified-binding-failure",
  );
  assert.equal(unclassifiedText.includes(unclassifiedFailure.message), false);

  const truncated = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        endpointRequest(fixture, screenshotBytes, LIVE_BAKEOFF_MODELS[0].selector, "truncated-response"),
      ),
    }),
    {
      ...env,
      AI: {
        aiGatewayLogId: null,
        async run(model) {
          return {
            id: "fake-truncated-request",
            object: "chat.completion",
            created: 1,
            model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "PRIVATE_PARTIAL_TEXT", refusal: null },
              finish_reason: "length",
              logprobs: null,
            }],
            usage: { prompt_tokens: 210, completion_tokens: 2_048, total_tokens: 2_258 },
          };
        },
      },
    },
  );
  const truncatedText = await truncated.text();
  const truncatedBody = JSON.parse(truncatedText);
  assert.equal(truncated.status, 502);
  assert.equal(truncatedBody.attempted, true);
  assert.equal(
    truncatedBody.error.code,
    "provider-unavailable-workers-ai-binding-response-finish-length",
  );
  assert.deepEqual(truncatedBody.telemetry, {
    inputTokens: 210,
    outputTokens: 2_048,
    reportedModel: LIVE_BAKEOFF_MODELS[0].modelSpec.model,
    attempts: 1,
    latencyMs: truncatedBody.telemetry.latencyMs,
    usageSource: "provider-reported",
  });
  assert.equal(Number.isFinite(truncatedBody.telemetry.latencyMs), true);
  assert.equal(truncatedText.includes("PRIVATE_PARTIAL_TEXT"), false);
});

function completedResponse(request, overrides = {}) {
  const candidate = modelFor(request.modelSelector);
  const reportedModel = overrides.reportedModel ?? candidate.modelSpec.model;
  return jsonResponse({
    schemaVersion: LIVE_BAKEOFF_ENDPOINT_RESPONSE_SCHEMA_VERSION,
    fixtureId: request.fixtureId,
    modelSelector: request.modelSelector,
    callId: request.callId,
    attempted: true,
    status: "completed",
    provenance: {
      screenshot: {
        sha256: request.screenshot.sha256,
        pixelWidth: request.screenshot.pixelWidth,
        pixelHeight: request.screenshot.pixelHeight,
      },
      prompt: { version: VISUAL_PROMPT_VERSION, sha256: PRODUCTION_PROMPT_SHA256 },
      responseSchema: {
        version: VISUAL_RESPONSE_SCHEMA_VERSION,
        sha256: PRODUCTION_RESPONSE_SCHEMA_SHA256,
      },
      model: {
        provider: candidate.modelSpec.provider,
        requestedModel: candidate.modelSpec.model,
        reportedModel,
        transport: candidate.modelSpec.transport,
        configurationSha256: candidate.modelSpec.configurationSha256,
      },
      call: {
        callId: request.callId,
        receipt: { kind: "provider-request-id", sha256: "a".repeat(64) },
      },
    },
    telemetry: telemetry(
      reportedModel,
      Object.prototype.hasOwnProperty.call(overrides, "inputTokens") ? overrides.inputTokens : 100,
      Object.prototype.hasOwnProperty.call(overrides, "outputTokens") ? overrides.outputTokens : 20,
    ),
    modelContent: overrides.modelContent ?? emptyValidInventory(),
  });
}

function telemetry(reportedModel, inputTokens, outputTokens) {
  return {
    inputTokens,
    outputTokens,
    reportedModel,
    attempts: 1,
    latencyMs: 4.25,
    usageSource: "provider-reported",
  };
}

function endpointRequest(fixture, screenshotBytes, modelSelector, callId) {
  return {
    schemaVersion: LIVE_BAKEOFF_ENDPOINT_REQUEST_SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    modelSelector,
    callId,
    screenshot: {
      sha256: fixture.screenshot.sha256,
      pixelWidth: fixture.screenshot.pixelWidth,
      pixelHeight: fixture.screenshot.pixelHeight,
      base64: screenshotBytes.toString("base64"),
    },
  };
}

function emptyValidInventory() {
  return {
    schemaVersion: "survey-visual-inventory/1.0.0",
    viewport: { width: 1, height: 1 },
    visibleTexts: [],
    controls: [],
    groups: [],
    navigation: [],
    messages: [],
    limitations: [],
  };
}

function modelFor(selector) {
  const candidate = LIVE_BAKEOFF_MODELS.find((model) => model.selector === selector);
  assert.ok(candidate, `unknown fake model selector ${selector}`);
  return candidate;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function deterministicDependencies(overrides) {
  let milliseconds = 0;
  return {
    randomUUID: () => RUN_ID,
    now: () => new Date(Date.UTC(2026, 7, 9, 0, 0, 0, milliseconds++)),
    ...overrides,
  };
}

async function readJournal(outputDir) {
  const source = await readFile(path.join(outputDir, "attempt-journal.ndjson"), "utf8");
  return source.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function withOutputDirectory(run) {
  await mkdir(TEST_TEMP_ROOT, { recursive: true });
  const outputDir = await mkdtemp(path.join(TEST_TEMP_ROOT, "vision-live-"));
  try {
    await run(outputDir);
  } finally {
    const resolved = path.resolve(outputDir);
    assert.equal(path.dirname(resolved), TEST_TEMP_ROOT);
    await rm(resolved, { recursive: true, force: false });
  }
}

async function loadBundledWorker() {
  return (await loadBundledWorkerModule()).default;
}

async function loadBundledWorkerModule() {
  const result = await build({
    entryPoints: [LIVE_WORKER_PATH],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  assert.equal(result.outputFiles.length, 1);
  const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("live bakeoff contract pins two arms to the current production rate card", () => {
  // Keep these assertions inside node:test. A stale top-level assertion is reported as
  // post-test asynchronous activity and can obscure the actual contract failure.
  assert.equal(LIVE_BAKEOFF_MODELS.length, 2);
  assert.equal(LIVE_BAKEOFF_PRICING_EFFECTIVE_DATE, "2026-08-10");
});
