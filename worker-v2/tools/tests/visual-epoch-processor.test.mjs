/** Single-epoch proof: exact input -> one paid receipt -> three immutable, re-read artifacts. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-epoch-processor-test-"));
const bundlePath = path.join(bundleDir, "visual-epoch-processor.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as processor from ${p("src/workflow/stages/visual-epoch.ts")};`,
      `export * as evidence from ${p("src/store/evidence.ts")};`,
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
      `export * as checkpoint from ${p("src/store/checkpoint.ts")};`,
      `export * as usage from ${p("src/store/usage.ts")};`,
      `export * as visionStore from ${p("src/store/vision.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as ids from ${p("src/ids.ts")};`,
      `export * as visionTypes from ${p("src/vision/types.ts")};`,
      `export * as visionObserve from ${p("src/vision/observe.ts")};`,
      `export * as visionSchema from ${p("src/vision/schema.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-epoch-processor-test-entry.ts",
    loader: "ts",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const mod = await import(pathToFileURL(bundlePath).href);
const enc = new TextEncoder();
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const FIXED_AT = "2026-08-09T12:00:10.000Z";
const fixedNow = () => new Date(FIXED_AT);
const at = (second) => `2026-08-09T12:00:${String(second).padStart(2, "0")}.000Z`;

const model = {
  provider: "cloudflare-workers-ai",
  model: "@cf/google/gemma-4-26b-a4b-it",
  transport: "workers-ai-binding-native",
  configurationSha256: "c".repeat(64),
};

const rollout = { maximumCalls: 5, maximumUsd: 1, timeoutMs: 1_000 };
const bounds = { x: 0.1, y: 0.1, width: 0.7, height: 0.1 };

const inventory = {
  schemaVersion: "survey-qa-visual-inventory-response/1.0.0",
  questionRegions: [{
    localId: "question-1",
    text: {
      quote: "Choose one",
      alternatives: [],
      readability: "read",
      modelConfidence: 0.98,
      bounds,
    },
  }],
  optionGroups: [{
    localId: "group-1",
    questionRegionId: "question-1",
    selectionAppearance: "appears-single",
    bounds: { x: 0.1, y: 0.25, width: 0.7, height: 0.3 },
    options: [{
      localId: "option-1",
      text: {
        quote: "Option A",
        alternatives: [],
        readability: "read",
        modelConfidence: 0.97,
        bounds: { x: 0.15, y: 0.3, width: 0.4, height: 0.08 },
      },
      markAppearance: "appears-unselected",
    }],
  }],
  controls: [],
  messages: [],
  visualLimitations: [],
};

function png(width = 100, height = 80) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const geometry = () => ({
  width: 100,
  height: 80,
  deviceScaleFactor: 1,
  scrollX: 0,
  scrollY: 0,
  documentWidth: 100,
  documentHeight: 160,
  source: "browser",
});

const scope = () => ({ kind: "viewport", tileIndex: null, tileCount: null });

function ref(entry, kind) {
  return {
    kind,
    evidenceId: entry.evidenceId,
    artifactRef: entry.artifactRef,
    sourceEvidenceId: entry.sourceEvidenceId,
    contentHash: entry.contentHash,
    mediaType: entry.mediaType,
    size: entry.size,
  };
}

function settleArtifactBytes(artifact) {
  for (let pass = 0; pass < 10; pass += 1) {
    const bytes = enc.encode(JSON.stringify(artifact));
    if (artifact.capture.serializedBytes === bytes.byteLength) return bytes;
    artifact.capture.serializedBytes = bytes.byteLength;
  }
  throw new Error("AX serializedBytes did not settle");
}

async function putEvidence(fx, input) {
  return mod.evidence.putEvidence(fx.env, {
    runId: fx.runId,
    attemptId: fx.attemptId,
    routeId: fx.pathId,
    ...input,
  });
}

async function fixture({ capModelCalls = 20 } = {}) {
  const runId = mod.ids.mintRunId(1_786_262_400_000);
  const bucket = memoryR2();
  const env = {
    EVIDENCE: bucket,
    CAP_MODEL_CALLS: String(capModelCalls),
    CAP_STANDARD_MAX_USD: "10",
    CAP_VERIFICATION_RESERVE_FRACTION: "0",
    CAP_REPORT_RESERVE_FRACTION: "0",
  };
  const fx = {
    runId,
    bucket,
    env,
    attemptId: "attempt-visual-epoch",
    pathId: "path-visual-epoch",
  };
  const screenEntry = await putEvidence(fx, {
    bytes: enc.encode(JSON.stringify({ visibleText: "DOM is paired provenance only", controls: [] })),
    type: "dom-excerpt",
    mediaType: "application/json",
    sourceEvidenceId: "EV-screen",
    artifactRef: "observations/path/screen.json",
  });
  const screenshotEntry = await putEvidence(fx, {
    bytes: png(),
    type: "screenshot",
    mediaType: "image/png",
    sourceEvidenceId: "EV-screenshot",
    artifactRef: "observations/path/screen.png",
  });
  const screenRef = ref(screenEntry, "screen-json");
  const screenshotRef = ref(screenshotEntry, "screenshot");
  const axArtifact = {
    kind: "v2-accessibility-snapshot/1.0.0",
    epochId: "epoch-visual-1",
    stepIndex: 0,
    slot: "before",
    scope: scope(),
    capturedAt: at(2),
    screenReadAt: at(1),
    screenSignatureHash: "a".repeat(64),
    geometry: geometry(),
    pairing: { screenJson: screenRef, screenshot: screenshotRef },
    capture: {
      interestingOnly: false,
      completeness: "complete",
      limitations: [],
      nodeCount: 3,
      maxDepthObserved: 2,
      serializedBytes: 0,
      limits: { maxNodes: 5_000, maxDepth: 64, maxValueChars: 16_384, maxSerializedBytes: 1_500_000 },
    },
    tree: {
      role: "WebArea",
      name: "Survey",
      children: [{
        role: "radiogroup",
        name: "Choose one",
        children: [{ role: "radio", name: "Option A", checked: false, children: [] }],
      }],
    },
  };
  const accessibilityEntry = await putEvidence(fx, {
    bytes: settleArtifactBytes(axArtifact),
    type: "state",
    mediaType: "application/json",
    sourceEvidenceId: "EV-accessibility",
    artifactRef: "observations/path/screen.accessibility.json",
  });
  const row = {
    walkOrdinal: 0,
    pathId: fx.pathId,
    attemptId: fx.attemptId,
    walkArtifact: {
      evidenceId: "ev_walk_fixture",
      sourceEvidenceId: "EV-walk-observation",
      artifactRef: "observations/path.json",
      contentHash: "b".repeat(64),
      mediaType: "application/json",
      size: 1,
      attemptId: fx.attemptId,
      routeId: fx.pathId,
    },
    epochOrdinal: 0,
    epochId: "epoch-visual-1",
    stepIndex: 0,
    slot: "before",
    scope: scope(),
    startedAt: at(0),
    endedAt: at(3),
    screenReadAt: at(1),
    screenSignatureHash: "a".repeat(64),
    geometry: geometry(),
    screen: { status: "captured", ref: screenRef },
    screenshot: { status: "captured", ref: screenshotRef },
    accessibility: {
      status: "captured",
      ref: ref(accessibilityEntry, "accessibility"),
      completeness: "complete",
      limitations: [],
    },
    cacheInputIdentity: null,
    eligibility: "eligible",
    ambiguityKinds: [],
    limitationKinds: [],
  };
  row.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(row);
  await mod.checkpoint.createCheckpoint(
    env,
    mod.checkpoint.initialCheckpoint(env, runId, "standard", false),
  );
  const fence = await mod.checkpoint.claimOwnership(env, runId, "visual-epoch-test", 1);
  return { ...fx, row, fence };
}

function telemetry(request, overrides = {}) {
  return {
    callId: request.callId,
    provider: model.provider,
    model: model.model,
    providerRequestId: "provider-request-1",
    gatewayLogId: null,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.001,
    usageSource: "provider-reported",
    attempts: 1,
    latencyMs: 25,
    ...overrides,
  };
}

function observedClient(counter, content = inventory) {
  return {
    async observe(request) {
      counter.calls += 1;
      return { content, telemetry: telemetry(request) };
    },
  };
}

const inputFor = (fx, client, overrides = {}) => ({
  env: fx.env,
  runId: fx.runId,
  fence: fx.fence,
  row: fx.row,
  rollout,
  client,
  model,
  now: fixedNow,
  ...overrides,
});

function instrumentBucket(inner) {
  const operations = [];
  return {
    _store: inner._store,
    _log: inner._log,
    operations,
    async get(key, ...args) { operations.push({ op: "get", key }); return inner.get(key, ...args); },
    async put(key, ...args) { operations.push({ op: "put", key }); return inner.put(key, ...args); },
    async head(key, ...args) { operations.push({ op: "head", key }); return inner.head(key, ...args); },
    async list(...args) { operations.push({ op: "list" }); return inner.list(...args); },
    async delete(...args) { operations.push({ op: "delete" }); return inner.delete(...args); },
  };
}

function faultBucket(inner, { operation, suffix, occurrence = 1, label }) {
  let seen = 0;
  const maybeFail = (op, key) => {
    if (op === operation && typeof key === "string" && key.endsWith(suffix)) {
      seen += 1;
      if (seen === occurrence) {
        const error = new Error(label);
        error.name = "FixtureStorageError";
        throw error;
      }
    }
  };
  return {
    _store: inner._store,
    _log: inner._log,
    get seen() { return seen; },
    async get(key, ...args) { maybeFail("get", key); return inner.get(key, ...args); },
    async put(key, ...args) { maybeFail("put", key); return inner.put(key, ...args); },
    async head(key, ...args) { maybeFail("head", key); return inner.head(key, ...args); },
    async list(...args) { return inner.list(...args); },
    async delete(...args) { return inner.delete(...args); },
  };
}

function allStoredText(bucket) {
  return [...bucket._store.values()]
    .map((entry) => new TextDecoder().decode(entry.bytes))
    .join("\n");
}

test("one loaded epoch stores and re-reads observation, reconciliation, and grounded bytes", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const result = await mod.processor.processVisualEpoch(inputFor(fx, observedClient(counter)));

  assert.equal(result.state, "stored");
  assert.equal(result.readState, "observed");
  assert.equal(result.reconciliation.facts, 1);
  assert.equal(result.reconciliation.conflicts, 0);
  assert.equal(counter.calls, 1);
  assert.match(result.observation.storage.key, /\/observation\.json$/);
  assert.match(result.reconciliation.storage.key, /\/reconciliation\.json$/);
  assert.match(result.groundedEpoch.storage.key, /\/grounded\.json$/);
  assert.equal((await fx.bucket.get(result.observation.storage.key)) !== null, true);
  assert.equal((await fx.bucket.get(result.reconciliation.storage.key)) !== null, true);
  assert.equal((await fx.bucket.get(result.groundedEpoch.storage.key)) !== null, true);
  assert.doesNotMatch(JSON.stringify(result), /"(?:verdict|pass|fail)"\s*:/i);

  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  const usage = await mod.usage.readVisualUsageLedger(fx.bucket, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
  assert.equal(usage.totals.modelCallsUsed, 1);
  assert.equal(usage.events.length, 1);
});

test("paired-content empty-inventory limitation survives the stored epoch projection", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const empty = {
    schemaVersion: "survey-qa-visual-inventory-response/1.0.0",
    questionRegions: [],
    optionGroups: [],
    controls: [],
    messages: [],
    visualLimitations: [],
  };
  const result = await mod.processor.processVisualEpoch(inputFor(fx, observedClient(counter, empty)));

  assert.equal(result.state, "stored");
  assert.equal(result.readState, "observed");
  assert.deepEqual(result.observation.limitationKinds, ["model-inventory-empty-despite-paired-content"]);
  assert.equal(result.observation.limitations, 1);
  assert.equal(counter.calls, 1);
});

test("a stored epoch replays without another provider purchase or accounting charge", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const client = observedClient(counter);
  const first = await mod.processor.processVisualEpoch(inputFor(fx, client));
  const replay = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.deepEqual(replay, first);
  assert.equal(counter.calls, 1);
  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  const usage = await mod.usage.readVisualUsageLedger(fx.bucket, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
  assert.equal(usage.totals.modelCallsUsed, 1);
  assert.equal(usage.events.length, 1);
});

test("loader-ineligible returns a counted non-purchase result with zero I/O or ledger activity", async () => {
  const fx = await fixture();
  fx.row.eligibility = "ineligible";
  const instrumented = instrumentBucket(fx.bucket);
  const counter = { calls: 0 };
  const result = await mod.processor.processVisualEpoch(inputFor(fx, observedClient(counter), {
    env: { ...fx.env, EVIDENCE: instrumented },
  }));
  assert.equal(result.state, "input-ineligible");
  assert.equal(result.limitation.kind, "manifest-row-not-eligible");
  assert.equal(counter.calls, 0);
  assert.deepEqual(instrumented.operations, []);

  const malformed = await fixture();
  delete malformed.row.pathId;
  const malformedBucket = instrumentBucket(malformed.bucket);
  const malformedCounter = { calls: 0 };
  const malformedResult = await mod.processor.processVisualEpoch(inputFor(
    malformed,
    observedClient(malformedCounter),
    { env: { ...malformed.env, EVIDENCE: malformedBucket } },
  ));
  assert.equal(malformedResult.state, "input-ineligible");
  assert.equal(malformedResult.limitation.kind, "manifest-row-malformed");
  assert.equal(malformedResult.work.pathId, "<unavailable>");
  assert.equal(malformedCounter.calls, 0);
  assert.deepEqual(malformedBucket.operations, []);
});

test("strict admission refusal writes no claim and invokes no provider", async () => {
  const fx = await fixture({ capModelCalls: 0 });
  const counter = { calls: 0 };
  await assert.rejects(
    mod.processor.processVisualEpoch(inputFor(fx, observedClient(counter))),
    (error) => error?.name === "VisualUsageAdmissionRefused" && error.reason === "model-call-cap",
  );
  assert.equal(counter.calls, 0);
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => /\/visual\/inference\//.test(key)),
    false,
  );
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => /\/visual\/epochs\//.test(key)),
    false,
  );
});

test("coherent adapter preflight rejection releases reservation without paid usage", async () => {
  const fx = await fixture();
  const secretMarker = "raw-preflight-secret-must-not-persist";
  let adapterEntries = 0;
  const client = {
    async observe() {
      adapterEntries += 1;
      throw Object.assign(
        new mod.visionTypes.VisionProviderUnavailableError(secretMarker),
        {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "request-contract-invalid",
          providerFailurePhase: "preflight",
          providerCallAttempted: false,
          arbitraryProviderPayload: secretMarker,
        },
      );
    },
  };

  const result = await mod.processor.processVisualEpoch(inputFor(fx, client));
  const replay = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.deepEqual(replay, result);
  assert.equal(result.readState, "unavailable");
  assert.equal(adapterEntries, 1, "the immutable not-attempted receipt prevents adapter replay");
  const usage = await mod.usage.readVisualUsageLedger(fx.bucket, fx.runId);
  assert.equal(usage.reservation, null);
  assert.equal(usage.events.length, 0);
  assert.deepEqual(usage.totals, { modelCallsUsed: 0, knownCostUsd: 0, unknownCostCount: 0 });
  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
  const observation = await mod.visionStore.readVisualObservationArtifact(
    fx.bucket,
    result.observation.storage,
  );
  assert.deepEqual(
    observation.limitations.find((item) => item.kind === "model-unavailable").providerFailure,
    { category: "workers-ai-binding", code: "request-contract-invalid" },
  );
  assert.doesNotMatch(allStoredText(fx.bucket), new RegExp(secretMarker));
  assert.match(allStoredText(fx.bucket), /provider-not-attempted:workers-ai-binding:request-contract-invalid/);
});

test("provider unavailability becomes a stored named read, never raw provider text", async () => {
  const fx = await fixture();
  const secretMarker = "raw-provider-secret-must-not-persist";
  let calls = 0;
  const client = {
    async observe(request) {
      calls += 1;
      throw Object.assign(
        new mod.visionTypes.VisionProviderUnavailableError(secretMarker, telemetry(request)),
        {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "inference-upstream",
          arbitraryProviderPayload: secretMarker,
        },
      );
    },
  };
  const result = await mod.processor.processVisualEpoch(inputFor(fx, client));
  const replay = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.equal(result.state, "stored");
  assert.deepEqual(replay, result);
  assert.equal(result.readState, "unavailable");
  assert.equal(result.reconciliation.facts, 0);
  assert.equal(calls, 1);
  const observation = await mod.visionStore.readVisualObservationArtifact(
    fx.bucket,
    result.observation.storage,
  );
  const unavailable = observation.limitations.find((item) => item.kind === "model-unavailable");
  assert.deepEqual(unavailable.providerFailure, {
    category: "workers-ai-binding",
    code: "inference-upstream",
  });
  assert.doesNotMatch(allStoredText(fx.bucket), new RegExp(secretMarker));
  assert.match(
    allStoredText(fx.bucket),
    /provider-unavailable:workers-ai-binding:inference-upstream|"providerFailure"|model-unavailable/,
  );
});

test("deadline abort awaits durable timeout settlement and accounting before observation storage", async () => {
  const fx = await fixture();
  let calls = 0;
  let abortSettlementFinished = false;
  const client = {
    async observe(request, signal) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            abortSettlementFinished = true;
            const error = Object.assign(
              new mod.visionTypes.VisionProviderUnavailableError("raw abort detail must not persist"),
              {
                providerFailureCategory: "workers-ai-binding",
                providerFailureCode: "binding-abort",
                arbitraryProviderPayload: "raw abort detail must not persist",
              },
            );
            error.name = "AbortError";
            reject(error);
          }, 10);
        }, { once: true });
      });
    },
  };

  const result = await mod.processor.processVisualEpoch(inputFor(fx, client));
  const replay = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.deepEqual(replay, result);
  assert.equal(result.state, "stored");
  assert.equal(result.readState, "timeout");
  assert.equal(abortSettlementFinished, true);
  assert.equal(calls, 1);
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/observation.json")),
    true,
  );
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/outcome.json")),
    true,
  );
  assert.doesNotMatch(allStoredText(fx.bucket), /raw abort detail/);
  const observation = await mod.visionStore.readVisualObservationArtifact(
    fx.bucket,
    result.observation.storage,
  );
  assert.deepEqual(
    observation.limitations.find((item) => item.kind === "model-timeout").providerFailure,
    { category: "workers-ai-binding", code: "binding-abort" },
  );
  assert.match(allStoredText(fx.bucket), /provider-timeout:workers-ai-binding:binding-abort/);
  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  const usage = await mod.usage.readVisualUsageLedger(fx.bucket, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
  assert.equal(usage.totals.modelCallsUsed, 1);
});

test("a pre-existing claim-only receipt is purchase-blocked and writes no observation", async () => {
  const fx = await fixture();
  const [promptSha256, responseSchemaSha256] = await Promise.all([
    mod.visionObserve.visualPromptSha256(),
    mod.visionObserve.visualResponseSchemaSha256(),
  ]);
  const inferenceCacheKey = await mod.visionObserve.computeVisualInferenceCacheKey({
    screenshotSha256: fx.row.screenshot.ref.contentHash,
    pixelWidth: 100,
    pixelHeight: 80,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  const digest = mod.keys.visualInferenceDigest(inferenceCacheKey);
  const callId = `visual-${digest.slice(-32)}`;
  await mod.visionStore.claimVisualInference(
    fx.bucket,
    {
      digest,
      claimKey: mod.keys.visualInferenceClaimKey(fx.runId, inferenceCacheKey),
      outcomeKey: mod.keys.visualInferenceOutcomeKey(fx.runId, inferenceCacheKey),
    },
    {
      schemaVersion: mod.visionStore.VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
      kind: "survey-qa-visual-inference-claim",
      inferenceCacheKey,
      callId,
      claimedAt: FIXED_AT,
      request: {
        screenshotSha256: fx.row.screenshot.ref.contentHash,
        mediaType: "image/png",
        pixelWidth: 100,
        pixelHeight: 80,
        provider: model.provider,
        model: model.model,
        transport: model.transport,
        configurationSha256: model.configurationSha256,
        prompt: { version: mod.visionSchema.VISUAL_PROMPT_VERSION, sha256: promptSha256 },
        responseSchema: {
          version: mod.visionSchema.VISUAL_RESPONSE_SCHEMA_VERSION,
          sha256: responseSchemaSha256,
        },
      },
    },
  );
  let calls = 0;
  await assert.rejects(
    mod.processor.processVisualEpoch(inputFor(fx, {
      async observe() { calls += 1; throw new Error("provider must not run"); },
    })),
    (error) => error?.name === "VisualInferencePurchaseBlockedError" &&
      error.reason === "claim-indeterminate",
  );
  assert.equal(calls, 0);
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/observation.json")),
    false,
  );
  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
});

test("settled receipt plus prior accounting failure recovers without repurchase", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const client = observedClient(counter);
  const broken = faultBucket(fx.bucket, {
    operation: "put",
    suffix: "/visual/usage.json",
    // Reservation is visual-usage CAS #1. Fail the exact settlement conversion CAS #2.
    occurrence: 2,
    label: "fixture accounting unavailable",
  });
  await assert.rejects(
    mod.processor.processVisualEpoch(inputFor(fx, client, {
      env: { ...fx.env, EVIDENCE: broken },
    })),
    (error) => error?.name === "FixtureStorageError",
  );
  assert.equal(counter.calls, 1);
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/outcome.json")),
    true,
  );
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/observation.json")),
    false,
  );

  const recovered = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.equal(recovered.state, "stored");
  assert.equal(counter.calls, 1);
  const checkpoint = await mod.checkpoint.loadCheckpoint(fx.env, fx.runId);
  const usage = await mod.usage.readVisualUsageLedger(fx.bucket, fx.runId);
  assert.equal(checkpoint.checkpoint.usage.modelCalls.used, 0);
  assert.equal(usage.totals.modelCallsUsed, 1);
});

test("observation-only crash is completed from immutable bytes without repurchase", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const client = observedClient(counter);
  const broken = faultBucket(fx.bucket, {
    operation: "put",
    suffix: "/reconciliation.json",
    occurrence: 1,
    label: "fixture reconciliation write unavailable",
  });
  await assert.rejects(
    mod.processor.processVisualEpoch(inputFor(fx, client, {
      env: { ...fx.env, EVIDENCE: broken },
    })),
    (error) => error?.name === "FixtureStorageError",
  );
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/observation.json")),
    true,
  );
  assert.equal(
    [...fx.bucket._store.keys()].some((key) => key.endsWith("/grounded.json")),
    false,
  );
  const observationKey = [...fx.bucket._store.keys()].find((key) => key.endsWith("/observation.json"));
  const observationBefore = new Uint8Array(await (await fx.bucket.get(observationKey)).arrayBuffer());

  const recovered = await mod.processor.processVisualEpoch(inputFor(fx, client));
  assert.equal(recovered.state, "stored");
  assert.equal(counter.calls, 1);
  assert.equal((await fx.bucket.get(recovered.groundedEpoch.storage.key)) !== null, true);
  const observationAfter = new Uint8Array(await (await fx.bucket.get(observationKey)).arrayBuffer());
  assert.deepEqual(observationAfter, observationBefore, "replay must reuse exact immutable observation bytes");
});

test("sink, reconciliation, and grounded write/read failures are fatal", async (t) => {
  const cases = [
    {
      name: "observation write",
      operation: "put",
      suffix: "/observation.json",
      occurrence: 1,
      expectedName: "VisualObservationPersistenceError",
    },
    {
      name: "observation reread",
      operation: "get",
      suffix: "/observation.json",
      occurrence: 2,
      expectedName: "FixtureStorageError",
    },
    {
      name: "reconciliation write",
      operation: "put",
      suffix: "/reconciliation.json",
      occurrence: 1,
      expectedName: "FixtureStorageError",
    },
    {
      name: "reconciliation reread",
      operation: "get",
      suffix: "/reconciliation.json",
      occurrence: 1,
      expectedName: "FixtureStorageError",
    },
    {
      name: "grounded write",
      operation: "put",
      suffix: "/grounded.json",
      occurrence: 1,
      expectedName: "FixtureStorageError",
    },
    {
      name: "grounded reread",
      operation: "get",
      suffix: "/grounded.json",
      occurrence: 2,
      expectedName: "FixtureStorageError",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const counter = { calls: 0 };
      const broken = faultBucket(fx.bucket, {
        operation: item.operation,
        suffix: item.suffix,
        occurrence: item.occurrence,
        label: `fixture ${item.name} unavailable`,
      });
      await assert.rejects(
        mod.processor.processVisualEpoch(inputFor(fx, observedClient(counter), {
          env: { ...fx.env, EVIDENCE: broken },
        })),
        (error) => error?.name === item.expectedName,
      );
      assert.equal(counter.calls, 1);
      assert.equal(broken.seen >= item.occurrence, true, "the requested fault branch must execute");
    });
  }
});

test("mutated observation identity/key bytes are refused without another provider call", async () => {
  const fx = await fixture();
  const counter = { calls: 0 };
  const client = observedClient(counter);
  const first = await mod.processor.processVisualEpoch(inputFor(fx, client));
  const stored = await fx.bucket.get(first.observation.storage.key);
  const artifact = JSON.parse(await stored.text());
  artifact.cacheKey = `visual-observation/sha256/${"d".repeat(64)}`;
  await fx.bucket.put(first.observation.storage.key, JSON.stringify(artifact));

  await assert.rejects(
    mod.processor.processVisualEpoch(inputFor(fx, client)),
    (error) =>
      error?.name === "VisualStorageValidationError" ||
      error?.name === "VisualStorageCorruptionError" ||
      error?.name === "VisualEpochProcessingError",
  );
  assert.equal(counter.calls, 1);
});
