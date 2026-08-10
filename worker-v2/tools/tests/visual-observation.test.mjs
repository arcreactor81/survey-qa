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
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-observation-test-"));
const bundlePath = path.join(bundleDir, "vision.mjs");

await esbuild.build({
  entryPoints: [path.join(WORKER_ROOT, "src/vision/index.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const vision = await import(pathToFileURL(bundlePath).href);
const enc = new TextEncoder();

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function png(width = 100, height = 80) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const capturedJson = (evidenceId, value) => {
  const bytes = enc.encode(JSON.stringify(value));
  return {
    state: "captured",
    evidenceId,
    contentSha256: sha256(bytes),
    mediaType: "application/json",
    bytes,
  };
};

const unavailable = (kind, count, detail) => ({
  state: "unavailable",
  failure: { kind, count, detail },
});

async function makeInput(overrides = {}) {
  const screenshotBytes = png();
  const input = {
    screenshot: {
      evidenceId: "ev-screenshot",
      contentSha256: sha256(screenshotBytes),
      mediaType: "image/png",
      bytes: screenshotBytes,
    },
    screen: capturedJson("ev-screen", {
      questionText: "Which therapy are you aware of?",
      visibleText: "Which therapy are you aware of? NURTEC Pixel-only pseudo-label Next 1 of 2",
      controls: [{ label: "Next" }],
      optionGroups: [{ options: [{ label: "NURTEC" }] }],
      progress: { text: "1 of 2" },
    }),
    accessibility: capturedJson("ev-ax", {
      role: "WebArea",
      name: "Survey",
      children: [
        { role: "heading", name: "Which therapy are you aware of?" },
        { role: "checkbox", name: "NURTEC" },
        { role: "button", name: "Next" },
        { role: "StaticText", name: "1 of 2" },
      ],
    }),
    pairedEvidenceSha256: "",
    capture: {
      runId: "v2r_visual_test",
      attemptId: "attempt-1",
      pathId: "path-1",
      stepIndex: 2,
      slot: "before",
      epochId: "epoch-1",
      scope: { kind: "viewport", tileIndex: null, tileCount: null },
    },
    geometry: {
      source: "browser",
      viewportCssWidth: 100,
      viewportCssHeight: 80,
      screenshotPixelWidth: 100,
      screenshotPixelHeight: 80,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
    },
    ...overrides,
  };
  input.pairedEvidenceSha256 = await vision.computePairedEvidenceSha256({
    capture: input.capture,
    geometry: input.geometry,
    screen: pairBinding(input.screen),
    accessibility: pairBinding(input.accessibility),
  });
  return input;
}

function pairBinding(value) {
  return value.state === "captured"
    ? { state: "captured", evidenceId: value.evidenceId, contentSha256: value.contentSha256 }
    : { state: "unavailable", failure: value.failure };
}

const bounds = (x = 0.1, y = 0.1, width = 0.5, height = 0.1) => ({ x, y, width, height });
const reading = (quote, box = bounds(), alternatives = []) => ({
  quote,
  alternatives,
  readability: quote === null ? "unreadable" : "read",
  modelConfidence: quote === null ? 0 : 0.95,
  bounds: box,
});

function goodInventory() {
  return {
    schemaVersion: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
    questionRegions: [{ localId: "q1", text: reading("Which therapy are you aware of?") }],
    optionGroups: [{
      localId: "g1",
      questionRegionId: "q1",
      selectionAppearance: "appears-multiple",
      bounds: bounds(0.1, 0.2, 0.6, 0.4),
      options: [
        { localId: "o1", text: reading("NURTEC", bounds(0.15, 0.25, 0.2, 0.05)), markAppearance: "appears-unselected" },
        {
          localId: "o2",
          text: reading("CSS generated text", bounds(0.15, 0.32, 0.3, 0.05), ["Possible CSS generated text"]),
          markAppearance: "unknown",
        },
      ],
    }],
    controls: [{
      localId: "next",
      kind: "button",
      text: reading("Next", bounds(0.7, 0.8, 0.2, 0.1)),
      availabilityAppearance: "appears-enabled",
      selectionAppearance: "not-applicable",
      bounds: bounds(0.68, 0.78, 0.24, 0.14),
    }],
    messages: [{ localId: "progress", kind: "progress", text: reading("1 of 2", bounds(0.8, 0.02, 0.15, 0.05)) }],
    visualLimitations: [{ kind: "offscreen-indicator", count: 1, bounds: null }],
  };
}

const model = {
  provider: "fake-vision",
  model: "fake-v1",
  transport: "test-injected-client",
  configurationSha256: "c".repeat(64),
};

function outcomeFor(request, content = goodInventory(), telemetry = {}) {
  return {
    content,
    telemetry: {
      callId: request.callId,
      provider: model.provider,
      model: model.model,
      providerRequestId: "provider-request-1",
      gatewayLogId: "gateway-log-1",
      inputTokens: 123,
      outputTokens: 45,
      costUsd: 0.0034,
      usageSource: "provider-reported",
      attempts: 1,
      latencyMs: 250,
      ...telemetry,
    },
  };
}

function harness(factory = (request) => outcomeFor(request)) {
  const requests = [];
  const writes = [];
  return {
    requests,
    writes,
    dependencies: {
      client: {
        async observe(request, signal) {
          requests.push({ request, signal });
          return factory(request, signal);
        },
      },
      sink: {
        async persist(value) {
          writes.push(value);
        },
      },
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      timeoutMs: 50,
    },
  };
}

class MemoryR2 {
  objects = new Map();

  async get(key) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;
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

const durableKeys = (inferenceCacheKey) => {
  const digest = inferenceCacheKey.split("/").at(-1);
  const prefix = `v2/runs/observer-boundary/visual/inference/${digest}`;
  return {
    digest,
    claimKey: `${prefix}/claim.json`,
    outcomeKey: `${prefix}/outcome.json`,
  };
};

const limitation = (artifact, kind) => artifact.limitations.find((item) => item.kind === kind);

test("pixel request is target-neutral and grounded output retains visual-only text honestly", async () => {
  const h = harness();
  const result = await vision.observeVisualPage(await makeInput(), model, h.dependencies);

  assert.equal(result.persistence, "stored");
  assert.equal(result.artifact.readState, "observed");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys(h.requests[0].request).sort(), [
    "callId",
    "inferenceCacheKey",
    "prompt",
    "responseSchema",
    "screenshot",
  ]);
  assert.equal("screen" in h.requests[0].request, false);
  assert.equal("accessibility" in h.requests[0].request, false);
  assert.equal("cases" in h.requests[0].request, false);
  assert.equal("requirements" in h.requests[0].request, false);
  assert.equal(h.requests[0].request.prompt.text.includes("NURTEC"), false);

  const option = result.artifact.inventory.optionGroups[0].options[0];
  assert.equal(option.text.quote.grounding.kind, "paired-accessibility-exact");
  const visualOnly = result.artifact.inventory.optionGroups[0].options[1].text.quote;
  assert.equal(visualOnly.value, "CSS generated text");
  assert.equal(visualOnly.grounding.kind, "visual-only");
  assert.deepEqual(visualOnly.grounding.evidenceSha256, [result.artifact.input.screenshotSha256]);
  assert.equal(limitation(result.artifact, "model-region-not-metadata-grounded").count, 2);
  assert.equal(result.artifact.counts.visualOnlyQuotes, 2);
  assert.equal(result.artifact.counts.metadataGroundedQuotes, 4);
  assert.equal(result.artifact.provenance.call.inputTokens, 123);
  assert.equal(result.artifact.provenance.call.costUsd, 0.0034);
  assert.equal(result.artifact.provenance.model.configurationSha256, model.configurationSha256);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].inferenceCacheKey, result.artifact.inferenceCacheKey);
  assert.equal(sha256(h.writes[0].canonicalBytes), h.writes[0].contentSha256);
});

test("DOM-projected text and AX substrings cannot ground a pixel reading", async () => {
  const inventory = goodInventory();
  inventory.questionRegions[0].text = reading("Screen-only question");
  inventory.optionGroups[0].options[0].text = reading("NUR");
  const input = await makeInput({
    screen: capturedJson("ev-screen", {
      questionText: "Screen-only question",
      visibleText: "Screen-only question NUR Next",
      controls: [{ label: "Next" }],
      optionGroups: [{ options: [{ label: "NUR" }] }],
    }),
  });
  const h = harness((request) => outcomeFor(request, inventory));
  const result = await vision.observeVisualPage(input, model, h.dependencies);

  assert.equal(result.artifact.inventory.questionRegions[0].text.quote.grounding.kind, "visual-only");
  assert.equal(result.artifact.inventory.optionGroups[0].options[0].text.quote.grounding.kind, "visual-only");
  assert.equal(limitation(result.artifact, "model-region-not-metadata-grounded").count >= 2, true);
});

test("named AX absence remains explicit and does not suppress independent pixel reading", async () => {
  const input = await makeInput({ accessibility: unavailable("ax-snapshot-timeout", 2, "Chrome AX read timed out twice") });
  const h = harness();
  const result = await vision.observeVisualPage(input, model, h.dependencies);

  assert.equal(h.requests.length, 1);
  assert.equal(result.artifact.readState, "observed");
  assert.equal(result.artifact.input.accessibility.state, "unavailable");
  assert.deepEqual(result.artifact.input.accessibility.failure, {
    kind: "ax-snapshot-timeout",
    count: 2,
    detail: "Chrome AX read timed out twice",
  });
  assert.equal(limitation(result.artifact, "input-accessibility-metadata-unavailable").count, 2);
});

test("exact bytes and epoch pairing reject hash mutation and swapped step metadata before any call", async () => {
  const cases = [];
  const badScreenshot = await makeInput();
  badScreenshot.screenshot.contentSha256 = "f".repeat(64);
  cases.push([badScreenshot, "input-screenshot-hash-mismatch"]);

  const badScreen = await makeInput();
  badScreen.screen.contentSha256 = "e".repeat(64);
  cases.push([badScreen, "input-screen-hash-mismatch"]);

  const swappedEpoch = await makeInput();
  swappedEpoch.capture = { ...swappedEpoch.capture, stepIndex: swappedEpoch.capture.stepIndex + 1 };
  cases.push([swappedEpoch, "input-pair-hash-mismatch"]);

  for (const [input, expectedKind] of cases) {
    const h = harness();
    const result = await vision.observeVisualPage(input, model, h.dependencies);
    assert.equal(result.artifact.readState, "input-invalid");
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
    assert(limitation(result.artifact, expectedKind), expectedKind);
  }
});

test("malformed screenshot envelope is refused before hashing or invoking the client", async () => {
  const input = await makeInput();
  input.screenshot = { ...input.screenshot, bytes: "not-png-bytes" };
  const h = harness();
  const result = await vision.observeVisualPage(input, model, h.dependencies);
  assert.equal(result.artifact.readState, "input-invalid");
  assert.equal(h.requests.length, 0);
  assert(limitation(result.artifact, "input-capture-metadata-malformed"));
});

test("forbidden conclusion fields and unknown status fields discard the full model response", async () => {
  const forbidden = goodInventory();
  forbidden.verdict = "looks compliant";
  const forbiddenHarness = harness((request) => outcomeFor(request, forbidden));
  const forbiddenResult = await vision.observeVisualPage(await makeInput(), model, forbiddenHarness.dependencies);
  assert.equal(forbiddenResult.artifact.readState, "malformed");
  assert.equal(forbiddenResult.artifact.inventory.questionRegions.length, 0);
  assert.equal(limitation(forbiddenResult.artifact, "model-response-forbidden-decision-field").count, 1);

  const unknown = goodInventory();
  unknown.controls[0].status = "fine";
  const unknownHarness = harness((request) => outcomeFor(request, unknown));
  const unknownResult = await vision.observeVisualPage(await makeInput(), model, unknownHarness.dependencies);
  assert.equal(unknownResult.artifact.readState, "malformed");
  assert(limitation(unknownResult.artifact, "model-response-malformed"));
});

test("closed-schema mutation negatives exercise fields, bounds, identities, and abstention coherence", async () => {
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.questionRegions[0].text.bounds.x = -0.01; },
    (value) => { value.questionRegions[0].text.bounds.width = 0; },
    (value) => { delete value.controls[0].selectionAppearance; },
    (value) => { value.questionRegions.push(structuredClone(value.questionRegions[0])); },
    (value) => {
      value.questionRegions[0].text.readability = "unreadable";
      value.questionRegions[0].text.quote = "invented despite abstention";
    },
  ];

  for (const mutate of mutations) {
    const response = goodInventory();
    mutate(response);
    const h = harness((request) => outcomeFor(request, response));
    const result = await vision.observeVisualPage(await makeInput(), model, h.dependencies);
    assert.equal(result.artifact.readState, "malformed");
    assert(limitation(result.artifact, "model-response-malformed"));
    assert.equal(result.artifact.counts.questionRegions, 0);
  }
});

test("an unqualified empty inventory is counted when paired readers saw content, but not on a supported blank screen", async () => {
  const empty = {
    schemaVersion: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
    questionRegions: [],
    optionGroups: [],
    controls: [],
    messages: [],
    visualLimitations: [],
  };
  const nonblankHarness = harness((request) => outcomeFor(request, empty));
  const nonblank = await vision.observeVisualPage(await makeInput(), model, nonblankHarness.dependencies);
  assert.equal(nonblank.artifact.readState, "observed");
  assert(limitation(nonblank.artifact, "model-inventory-empty-despite-paired-content"));

  const blankInput = await makeInput({
    screen: capturedJson("ev-screen-blank", { visibleText: "", controls: [], optionGroups: [], buttons: [] }),
    accessibility: capturedJson("ev-ax-blank", { role: "WebArea", name: "", children: [] }),
  });
  const blankHarness = harness((request) => outcomeFor(request, empty));
  const blank = await vision.observeVisualPage(blankInput, model, blankHarness.dependencies);
  assert.equal(limitation(blank.artifact, "model-inventory-empty-despite-paired-content"), undefined);
});

test("configured geometry fallback keeps the pixel read while preserving unknown DPR and scroll", async () => {
  const input = await makeInput({
    geometry: {
      source: "configured-fallback",
      viewportCssWidth: 100,
      viewportCssHeight: 80,
      screenshotPixelWidth: 100,
      screenshotPixelHeight: 80,
      deviceScaleFactor: null,
      scrollX: null,
      scrollY: null,
    },
  });
  const h = harness();
  const result = await vision.observeVisualPage(input, model, h.dependencies);
  assert.equal(h.requests.length, 1);
  assert.equal(result.artifact.readState, "observed");
  assert(limitation(result.artifact, "input-capture-geometry-fallback"));
  assert.equal(result.artifact.input.geometry.deviceScaleFactor, null);

  const rtlInput = await makeInput({
    geometry: {
      source: "browser",
      viewportCssWidth: 100,
      viewportCssHeight: 80,
      screenshotPixelWidth: 100,
      screenshotPixelHeight: 80,
      deviceScaleFactor: 1.25,
      scrollX: -12.5,
      scrollY: 0.25,
    },
  });
  const rtlHarness = harness();
  const rtl = await vision.observeVisualPage(rtlInput, model, rtlHarness.dependencies);
  assert.equal(rtl.artifact.readState, "observed");
  assert.equal(rtl.artifact.input.geometry.scrollX, -12.5);
});

test("timeout, unavailable provider, and model identity drift become named counted limitations", async () => {
  let abortSettlementFinished = false;
  const timeoutHarness = harness((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      // Settlement is intentionally later than the timer. The observer must await it instead of
      // persisting a timeout while a paid client promise is still running in the background.
      setTimeout(() => {
        abortSettlementFinished = true;
        const error = new Error("raw abort detail must not be persisted");
        error.name = "AbortError";
        reject(error);
      }, 10);
    }, { once: true });
  }));
  timeoutHarness.dependencies.timeoutMs = 5;
  const timed = await vision.observeVisualPage(await makeInput(), model, timeoutHarness.dependencies);
  assert.equal(abortSettlementFinished, true, "observer returned before the aborted client settled");
  assert.equal(timed.artifact.readState, "timeout");
  assert(limitation(timed.artifact, "model-timeout"));
  assert.equal(JSON.stringify(timed.artifact).includes("raw abort detail"), false);

  const unavailableHarness = harness(() => {
    throw new vision.VisionProviderUnavailableError("secret-bearing provider message is not persisted");
  });
  const unavailableResult = await vision.observeVisualPage(await makeInput(), model, unavailableHarness.dependencies);
  assert.equal(unavailableResult.artifact.readState, "unavailable");
  assert(limitation(unavailableResult.artifact, "model-unavailable"));
  assert.equal(JSON.stringify(unavailableResult.artifact).includes("secret-bearing"), false);

  const driftHarness = harness((request) => outcomeFor(request, goodInventory(), { model: "silent-alias-change" }));
  const drift = await vision.observeVisualPage(await makeInput(), model, driftHarness.dependencies);
  assert.equal(drift.artifact.readState, "malformed");
  assert(limitation(drift.artifact, "model-identity-mismatch"));
});

test("a durable purchase-blocked error is fatal and cannot become model-unavailable", async () => {
  const blocked = new vision.VisualInferencePurchaseBlockedError("claim-indeterminate");
  const h = harness(() => { throw blocked; });

  await assert.rejects(
    vision.observeVisualPage(await makeInput(), model, h.dependencies),
    (error) => error === blocked && error.name === "VisualInferencePurchaseBlockedError",
  );
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.length, 0, "a purchase-blocked call must not emit an ordinary observation");
});

test("strict admission refusal from DurableVisionClient remains fatal before purchase or sink", async () => {
  const bucket = new MemoryR2();
  const admissionError = new Error("fixture visual cost cap");
  admissionError.name = "VisualUsageAdmissionRefused";
  let providerCalls = 0;
  const h = harness();
  h.dependencies.client = new vision.DurableVisionClient({
    bucket,
    model,
    storageKeys: durableKeys,
    now: h.dependencies.now,
    async admitNewPurchase() { throw admissionError; },
    client: {
      async observe() {
        providerCalls += 1;
        throw new Error("provider must not run after refused admission");
      },
    },
    async accountSettledAttempt() {},
    async accountNotAttempted() {},
  });

  await assert.rejects(
    vision.observeVisualPage(await makeInput(), model, h.dependencies),
    (error) => error === admissionError,
  );
  assert.equal(providerCalls, 0);
  assert.equal(bucket.objects.size, 0, "admission refusal precedes the immutable purchase claim");
  assert.equal(h.writes.length, 0);
});

test("durable accounting and storage failures remain fatal instead of advancing observations", async (t) => {
  await t.test("settled provider outcome cannot bypass a failed accounting commit", async () => {
    const bucket = new MemoryR2();
    const accountingError = new Error("fixture strict ledger unavailable");
    accountingError.name = "VisualUsageCheckpointMissing";
    let providerCalls = 0;
    const h = harness();
    h.dependencies.client = new vision.DurableVisionClient({
      bucket,
      model,
      storageKeys: durableKeys,
      now: h.dependencies.now,
      async admitNewPurchase() {},
      client: {
        async observe(request) {
          providerCalls += 1;
          return outcomeFor(request);
        },
      },
      async accountSettledAttempt() { throw accountingError; },
      async accountNotAttempted() {},
    });

    await assert.rejects(
      vision.observeVisualPage(await makeInput(), model, h.dependencies),
      (error) => error === accountingError,
    );
    assert.equal(providerCalls, 1);
    assert.equal(bucket.objects.size, 2, "claim and outcome settle before strict accounting replay");
    assert.equal(h.writes.length, 0, "failed accounting cannot reach the observation sink");
  });

  await t.test("claim storage failure cannot be mislabeled as provider unavailability", async () => {
    const storageError = new Error("fixture R2 claim write unavailable");
    storageError.name = "VisualStorageWriteFailure";
    const bucket = new MemoryR2();
    bucket.put = async () => { throw storageError; };
    let providerCalls = 0;
    const h = harness();
    h.dependencies.client = new vision.DurableVisionClient({
      bucket,
      model,
      storageKeys: durableKeys,
      now: h.dependencies.now,
      async admitNewPurchase() {},
      client: {
        async observe() {
          providerCalls += 1;
          throw new Error("provider must not run without a durable claim");
        },
      },
      async accountSettledAttempt() {},
      async accountNotAttempted() {},
    });

    await assert.rejects(
      vision.observeVisualPage(await makeInput(), model, h.dependencies),
      (error) => error === storageError,
    );
    assert.equal(providerCalls, 0);
    assert.equal(h.writes.length, 0);
  });
});

test("raw inference identity ignores epoch/paired readers while grounded observation identity includes them", async () => {
  const inputA = await makeInput();
  const inputB = await makeInput({
    accessibility: unavailable("ax-not-supported", 1, "AX was unavailable"),
    capture: {
      runId: "v2r_visual_test",
      attemptId: "attempt-2",
      pathId: "path-2",
      stepIndex: 7,
      slot: "after",
      epochId: "epoch-2",
      scope: { kind: "viewport", tileIndex: null, tileCount: null },
    },
  });
  const promptHash = await vision.visualPromptSha256();
  const schemaHash = await vision.visualResponseSchemaSha256();
  const common = {
    screenshotSha256: inputA.screenshot.contentSha256,
    pixelWidth: 100,
    pixelHeight: 80,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256: promptHash,
    responseSchemaSha256: schemaHash,
  };
  const inferenceA = await vision.computeVisualInferenceCacheKey(common);
  const inferenceB = await vision.computeVisualInferenceCacheKey(common);
  assert.equal(inferenceA, inferenceB);

  const observationA = await vision.computeVisualObservationCacheKey({
    screenshotSha256: common.screenshotSha256,
    pairedEvidenceSha256: inputA.pairedEvidenceSha256,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256: promptHash,
    responseSchemaSha256: schemaHash,
  });
  const observationB = await vision.computeVisualObservationCacheKey({
    screenshotSha256: common.screenshotSha256,
    pairedEvidenceSha256: inputB.pairedEvidenceSha256,
    provider: model.provider,
    model: model.model,
    configurationSha256: model.configurationSha256,
    promptSha256: promptHash,
    responseSchemaSha256: schemaHash,
  });
  assert.notEqual(observationA, observationB);
  assert.notEqual(await vision.computeVisualInferenceCacheKey({ ...common, pixelWidth: 101 }), inferenceA);
  assert.notEqual(await vision.computeVisualInferenceCacheKey({ ...common, model: "fake-v2" }), inferenceA);
  assert.notEqual(
    await vision.computeVisualInferenceCacheKey({ ...common, configurationSha256: "d".repeat(64) }),
    inferenceA,
  );
  assert.notEqual(await vision.computeVisualInferenceCacheKey({ ...common, promptSha256: "a".repeat(64) }), inferenceA);
  assert.notEqual(await vision.computeVisualInferenceCacheKey({ ...common, responseSchemaSha256: "b".repeat(64) }), inferenceA);
});

test("observation sink persistence failure is fatal and cannot return a processed artifact", async () => {
  const h = harness();
  h.dependencies.sink.persist = async () => { throw new Error("secret-bearing R2 detail"); };
  await assert.rejects(
    vision.observeVisualPage(await makeInput(), model, h.dependencies),
    (error) =>
      error?.name === "VisualObservationPersistenceError" &&
      error.message === "visual observation could not be durably persisted" &&
      !error.message.includes("secret-bearing"),
  );
  assert.equal(h.requests.length, 1);
});

test("neither provider request nor response schema admits case, expectation, or conclusion fields", () => {
  const forbiddenKeys = new Set(["case", "cases", "requirement", "requirements", "expected", "verdict", "pass", "fail", "status"]);
  const walkKeys = (value, found = []) => {
    if (Array.isArray(value)) value.forEach((item) => walkKeys(item, found));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key.toLowerCase())) found.push(key);
        walkKeys(child, found);
      }
    }
    return found;
  };
  assert.deepEqual(walkKeys(vision.VISUAL_RESPONSE_JSON_SCHEMA), []);
});
