import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "vision-durable-client-test-"));

await esbuild.build({
  entryPoints: {
    vision: path.join(WORKER_ROOT, "src/vision/index.ts"),
    store: path.join(WORKER_ROOT, "src/store/vision.ts"),
  },
  outdir: bundleDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const vision = await import(pathToFileURL(path.join(bundleDir, "vision.js")).href);
const store = await import(pathToFileURL(path.join(bundleDir, "store.js")).href);
const enc = new TextEncoder();

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

class MemoryR2 {
  objects = new Map();

  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      etag: sha256(bytes),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const source = typeof value === "string" ? enc.encode(value) : new Uint8Array(value);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength, etag: sha256(bytes) };
  }
}

const model = {
  provider: "fixture-provider",
  model: "fixture-vision-v1",
  transport: "fixture-binding",
  configurationSha256: "c".repeat(64),
};

const bounds = { x: 0.1, y: 0.1, width: 0.7, height: 0.1 };
const inventory = {
  schemaVersion: "survey-qa-visual-inventory-response/1.0.0",
  questionRegions: [{
    localId: "q1",
    text: {
      quote: "Choose one",
      alternatives: [],
      readability: "read",
      modelConfidence: 0.9,
      bounds,
    },
  }],
  optionGroups: [],
  controls: [],
  messages: [],
  visualLimitations: [],
};

async function request() {
  const screenshot = new Uint8Array(24);
  screenshot.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(screenshot.buffer).setUint32(16, 64, false);
  new DataView(screenshot.buffer).setUint32(20, 48, false);
  const screenshotSha256 = sha256(screenshot);
  const [promptSha256, responseSchemaSha256] = await Promise.all([
    vision.visualPromptSha256(),
    vision.visualResponseSchemaSha256(),
  ]);
  const inferenceCacheKey = await vision.computeVisualInferenceCacheKey({
    screenshotSha256,
    pixelWidth: 64,
    pixelHeight: 48,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256,
    responseSchemaSha256,
  });
  return {
    callId: `visual-${inferenceCacheKey.slice(-32)}`,
    inferenceCacheKey,
    screenshot: {
      bytes: screenshot,
      contentSha256: screenshotSha256,
      mediaType: "image/png",
      pixelWidth: 64,
      pixelHeight: 48,
    },
    prompt: {
      version: vision.VISUAL_PROMPT_VERSION,
      sha256: promptSha256,
      text: vision.VISUAL_INVENTORY_PROMPT,
    },
    responseSchema: {
      version: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
      sha256: responseSchemaSha256,
      jsonSchema: vision.VISUAL_RESPONSE_JSON_SCHEMA,
    },
  };
}

const keysFor = (cacheKey) => {
  const digest = cacheKey.split("/").at(-1);
  const prefix = `v2/runs/durable-test/visual/inference/${digest}`;
  return { digest, claimKey: `${prefix}/claim.json`, outcomeKey: `${prefix}/outcome.json` };
};

function telemetry(req, overrides = {}) {
  return {
    callId: req.callId,
    provider: model.provider,
    model: model.model,
    providerRequestId: "provider-request-1",
    gatewayLogId: null,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: null,
    usageSource: "provider-reported",
    attempts: 1,
    latencyMs: 25,
    ...overrides,
  };
}

const fixedNow = () => new Date("2026-08-09T12:00:00.000Z");
const noSignal = () => new AbortController().signal;

test("one immutable purchase is replayed and configured cost is accounted under one event id", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  const accounted = [];
  let calls = 0;
  let admissions = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() { admissions += 1; },
    now: fixedNow,
    client: {
      async observe(actual) {
        calls += 1;
        return { content: inventory, telemetry: telemetry(actual) };
      },
    },
    estimateCostUsd: (actual) =>
      actual.inputTokens === null || actual.outputTokens === null
        ? null
        : (actual.inputTokens * 0.1 + actual.outputTokens * 0.3) / 1_000_000,
    async accountSettledAttempt(event) {
      accounted.push(event);
    },
    async accountNotAttempted() {},
  });

  const first = await client.observe(req, noSignal());
  const replay = await client.observe(req, noSignal());
  assert.deepEqual(first.content, inventory);
  assert.deepEqual(replay.content, inventory);
  assert.equal(calls, 1, "a settled outcome must never be repurchased");
  assert.equal(admissions, 1, "a replayed settled outcome must not consume call/cost admission again");
  assert.equal(accounted.length, 2, "the strict ledger is allowed to idempotently see replay");
  const usageEventId = `visual-model-call/sha256/${req.inferenceCacheKey.split("/").at(-1)}`;
  assert.equal(accounted[0].eventId, usageEventId);
  assert.equal(accounted[1].eventId, usageEventId);
  assert.equal(accounted[0].costUsd, 0.000016);
  assert.equal(first.telemetry.usageSource, "configured-rate");
});

test("strict admission refusal happens before both claim and provider purchase", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let calls = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    now: fixedNow,
    async admitNewPurchase() { throw new Error("fixture cost cap"); },
    client: { async observe() { calls += 1; throw new Error("must not run"); } },
    async accountSettledAttempt() {},
    async accountNotAttempted() {},
  });
  await assert.rejects(client.observe(req, noSignal()), /fixture cost cap/);
  assert.equal(calls, 0);
  assert.equal((await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey))).state, "unstarted");
});

test("an accounting failure leaves a settled outcome that can be recovered without repurchase", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let calls = 0;
  let ledgerAttempts = 0;
  const dependencies = {
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe(actual) {
        calls += 1;
        return { content: inventory, telemetry: telemetry(actual, { costUsd: 0.001 }) };
      },
    },
    async accountSettledAttempt() {
      ledgerAttempts += 1;
      if (ledgerAttempts === 1) throw new Error("fixture ledger unavailable");
    },
    async accountNotAttempted() {},
  };
  const client = new vision.DurableVisionClient(dependencies);
  await assert.rejects(client.observe(req, noSignal()), /fixture ledger unavailable/);
  const recovered = await client.observe(req, noSignal());
  assert.deepEqual(recovered.content, inventory);
  assert.equal(calls, 1);
  assert.equal(ledgerAttempts, 2);
});

test("claim-only state is indeterminate and blocks an automatic second purchase", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  const keys = keysFor(req.inferenceCacheKey);
  await store.claimVisualInference(bucket, keys, {
    schemaVersion: store.VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
    kind: "survey-qa-visual-inference-claim",
    inferenceCacheKey: req.inferenceCacheKey,
    callId: req.callId,
    claimedAt: "2026-08-09T11:59:00.000Z",
    request: {
      screenshotSha256: req.screenshot.contentSha256,
      mediaType: "image/png",
      pixelWidth: 64,
      pixelHeight: 48,
      provider: model.provider,
      model: model.model,
      transport: model.transport,
      configurationSha256: model.configurationSha256,
      prompt: { version: req.prompt.version, sha256: req.prompt.sha256 },
      responseSchema: { version: req.responseSchema.version, sha256: req.responseSchema.sha256 },
    },
  });
  let calls = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: { async observe() { calls += 1; throw new Error("must not run"); } },
    async accountSettledAttempt() {},
    async accountNotAttempted() {},
  });
  await assert.rejects(
    client.observe(req, noSignal()),
    (error) => error?.name === "VisualInferencePurchaseBlockedError" && error.reason === "claim-indeterminate",
  );
  assert.equal(calls, 0);
});

test("malformed decision-bearing content is cached as malformed, not retried or persisted raw", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let calls = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe(actual) {
        calls += 1;
        return { content: { ...inventory, verdict: "pass" }, telemetry: telemetry(actual, { costUsd: 0.001 }) };
      },
    },
    async accountSettledAttempt() {},
    async accountNotAttempted() {},
  });
  assert.equal((await client.observe(req, noSignal())).content, null);
  assert.equal((await client.observe(req, noSignal())).content, null);
  assert.equal(calls, 1);
  const state = await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey));
  assert.equal(state.state, "settled");
  assert.equal(state.outcome.result.state, "malformed");
  const storedText = [...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  assert.doesNotMatch(storedText, /\"verdict\"/);
});

test("reported model drift remains visible after durable replay", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let calls = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe(actual) {
        calls += 1;
        return {
          content: inventory,
          telemetry: telemetry(actual, { model: "fixture-vision-substituted", costUsd: 0.001 }),
        };
      },
    },
    async accountSettledAttempt() {},
    async accountNotAttempted() {},
  });
  assert.equal((await client.observe(req, noSignal())).telemetry.model, "fixture-vision-substituted");
  assert.equal((await client.observe(req, noSignal())).telemetry.model, "fixture-vision-substituted");
  assert.equal(calls, 1);
});

test("timeout outcome and unknown cost are counted and replayed without another provider call", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  const accounted = [];
  let calls = 0;
  const rawDetail = "raw-timeout-secret-MUST-NOT-PERSIST";
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe() {
        calls += 1;
        const failure = Object.assign(new vision.VisionProviderUnavailableError(rawDetail), {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "binding-timeout",
          providerFailurePhase: "binding",
          providerCallAttempted: true,
          arbitraryProviderPayload: rawDetail,
        });
        failure.name = "TimeoutError";
        throw failure;
      },
    },
    async accountSettledAttempt(event) { accounted.push(event); },
    async accountNotAttempted() {},
  });
  for (let replay = 0; replay < 2; replay++) {
    await assert.rejects(client.observe(req, noSignal()), (error) => {
      assert.equal(error?.name, "TimeoutError");
      assert.equal(error.providerFailureCategory, "workers-ai-binding");
      assert.equal(error.providerFailureCode, "binding-timeout");
      assert.doesNotMatch(`${String(error)}\n${JSON.stringify(error)}`, /raw-timeout-secret/);
      assert.equal("arbitraryProviderPayload" in error, false);
      return true;
    });
  }
  assert.equal(calls, 1);
  assert.equal(accounted.length, 2);
  assert.equal(accounted[0].costUsd, null);
  assert.equal(accounted[0].resultState, "timeout");
  const state = await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey));
  assert.equal(state.state, "settled");
  assert.equal(state.outcome.result.failure.kind, "provider-timeout:workers-ai-binding:binding-timeout");
  const storedText = [...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  assert.doesNotMatch(storedText, /raw-timeout-secret/);
});

test("coherent preflight failures replay without a paid accounting event", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  const released = [];
  let paidEvents = 0;
  let calls = 0;
  const rawDetail = "raw-preflight-secret-MUST-NOT-PERSIST";
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe() {
        calls += 1;
        throw Object.assign(new vision.VisionProviderUnavailableError(rawDetail), {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "request-contract-invalid",
          providerFailurePhase: "preflight",
          providerCallAttempted: false,
          arbitraryProviderPayload: rawDetail,
        });
      },
    },
    async accountSettledAttempt() { paidEvents += 1; },
    async accountNotAttempted(event) { released.push(event); },
  });

  for (let replay = 0; replay < 2; replay++) {
    await assert.rejects(client.observe(req, noSignal()), (error) => {
      assert.equal(error.name, "VisionProviderUnavailableError");
      assert.equal(error.telemetry, null);
      assert.equal(error.providerFailureCategory, "workers-ai-binding");
      assert.equal(error.providerFailureCode, "request-contract-invalid");
      assert.equal(error.providerFailurePhase, "preflight");
      assert.equal(error.providerCallAttempted, false);
      assert.doesNotMatch(`${String(error)}\n${JSON.stringify(error)}`, /raw-preflight-secret/);
      return true;
    });
  }
  assert.equal(calls, 1);
  assert.equal(paidEvents, 0);
  assert.equal(released.length, 2, "the release callback is intentionally idempotent on replay");
  assert.deepEqual(released[0], released[1]);
  assert.deepEqual(released[0], {
    eventId: `visual-model-call/sha256/${req.inferenceCacheKey.split("/").at(-1)}`,
    callId: req.callId,
    inferenceCacheKey: req.inferenceCacheKey,
    requestedProvider: model.provider,
    requestedModel: model.model,
    settledAt: fixedNow().toISOString(),
  });
  const state = await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey));
  assert.equal(state.state, "settled");
  assert.equal(
    state.outcome.result.failure.kind,
    "provider-not-attempted:workers-ai-binding:request-contract-invalid",
  );
  assert.equal(state.outcome.telemetry, null);
  assert.equal(vision.visualInferenceReceiptWasNotAttempted(state.outcome), true);
  const storedText = [...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  assert.doesNotMatch(storedText, /raw-preflight-secret/);
});

test("an unknown persisted not-attempted tuple is storage corruption and cannot release accounting", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let paidEvents = 0;
  let releases = 0;
  let calls = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe() {
        calls += 1;
        throw Object.assign(new vision.VisionProviderUnavailableError("private preflight"), {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "request-contract-invalid",
          providerFailurePhase: "preflight",
          providerCallAttempted: false,
        });
      },
    },
    async accountSettledAttempt() { paidEvents += 1; },
    async accountNotAttempted() { releases += 1; },
  });

  await assert.rejects(client.observe(req, noSignal()), /visual inference unavailable/);
  assert.equal(calls, 1);
  assert.equal(paidEvents, 0);
  assert.equal(releases, 1);

  const outcomeKey = keysFor(req.inferenceCacheKey).outcomeKey;
  const originalBytes = bucket.objects.get(outcomeKey);
  assert.ok(originalBytes);
  const original = new TextDecoder().decode(originalBytes);
  const corrupted = original.replace(
    "provider-not-attempted:workers-ai-binding:request-contract-invalid",
    "provider-not-attempted:workers-ai-binding:request-unknown",
  );
  assert.notEqual(corrupted, original, "fixture must mutate the persisted tuple");
  bucket.objects.set(outcomeKey, enc.encode(corrupted));

  const state = await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey));
  assert.equal(state.state, "corrupt");
  await assert.rejects(client.observe(req, noSignal()), (error) => {
    assert.equal(error?.name, "VisualInferencePurchaseBlockedError");
    assert.equal(error.reason, "storage-corrupt");
    return true;
  });
  assert.equal(calls, 1, "corrupt replay must never repurchase");
  assert.equal(paidEvents, 0, "unknown tuple must not become a paid settlement either");
  assert.equal(releases, 1, "unknown tuple must not release the reservation");
});

test("a contradictory not-attempted tuple remains a paid attempt", async () => {
  const bucket = new MemoryR2();
  const req = await request();
  let paidEvents = 0;
  let releases = 0;
  const client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: keysFor,
    async admitNewPurchase() {},
    now: fixedNow,
    client: {
      async observe() {
        throw Object.assign(new vision.VisionProviderUnavailableError("private contradiction"), {
          providerFailureCategory: "workers-ai-binding",
          providerFailureCode: "request-contract-invalid",
          providerFailurePhase: "binding",
          providerCallAttempted: false,
        });
      },
    },
    async accountSettledAttempt() { paidEvents += 1; },
    async accountNotAttempted() { releases += 1; },
  });
  await assert.rejects(client.observe(req, noSignal()), /visual inference unavailable/);
  assert.equal(paidEvents, 1);
  assert.equal(releases, 0);
});

test("a closed adapter failure code survives durability while raw or malformed exception data does not", async () => {
  const req = await request();
  for (const fixture of [
    {
      category: "workers-ai-binding",
      code: "inference-upstream",
      expected: "provider-unavailable:workers-ai-binding:inference-upstream",
      expectedReference: {
        providerFailureCategory: "workers-ai-binding",
        providerFailureCode: "inference-upstream",
      },
    },
    {
      category: "workers-ai-binding\ncredential-fragment",
      code: "x".repeat(101),
      expected: "provider-unavailable",
      expectedReference: null,
    },
    {
      category: "a".repeat(100),
      code: "b".repeat(100),
      expected: "provider-unavailable",
      expectedReference: null,
    },
  ]) {
    const bucket = new MemoryR2();
    let calls = 0;
    const rawDetail = "raw-provider-detail-MUST-NOT-PERSIST";
    const client = new vision.DurableVisionClient({
      bucket,
      model,
      storageKeys: keysFor,
      async admitNewPurchase() {},
      now: fixedNow,
      client: {
        async observe() {
          calls += 1;
          throw Object.assign(new vision.VisionProviderUnavailableError(rawDetail), {
            providerFailureCategory: fixture.category,
            providerFailureCode: fixture.code,
            arbitraryProviderPayload: rawDetail,
          });
        },
      },
      async accountSettledAttempt() {},
      async accountNotAttempted() {},
    });

    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(client.observe(req, noSignal()), (error) => {
        assert.equal(error.message, "visual inference unavailable");
        if (fixture.expectedReference === null) {
          assert.equal(error.providerFailureCategory, undefined);
          assert.equal(error.providerFailureCode, undefined);
        } else {
          assert.equal(error.providerFailureCategory, fixture.expectedReference.providerFailureCategory);
          assert.equal(error.providerFailureCode, fixture.expectedReference.providerFailureCode);
        }
        const publicFailure = `${String(error)}\n${JSON.stringify(error)}`;
        assert.doesNotMatch(publicFailure, /raw-provider-detail-MUST-NOT-PERSIST|credential-fragment/);
        assert.equal("arbitraryProviderPayload" in error, false);
        return true;
      });
    }
    assert.equal(calls, 1, "a classified failure receipt must not authorize a second purchase");
    const state = await store.readVisualInferenceState(bucket, keysFor(req.inferenceCacheKey));
    assert.equal(state.state, "settled");
    assert.equal(state.outcome.result.failure.kind, fixture.expected);
    const storedText = [...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    assert.doesNotMatch(storedText, /raw-provider-detail-MUST-NOT-PERSIST|credential-fragment/);
  }
});
