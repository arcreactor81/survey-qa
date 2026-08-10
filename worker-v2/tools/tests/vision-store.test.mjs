/**
 * Append-only visual storage tests. Standalone on purpose: the sprint owner can run this file
 * before registering the new storage/workflow stage in the repository-wide dispatcher.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "vision-store-test-"));
const storeBundle = path.join(bundleDir, "store.mjs");
const visionBundle = path.join(bundleDir, "vision.mjs");

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(WORKER_ROOT, "src/store/vision.ts")],
    outfile: storeBundle,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  }),
  esbuild.build({
    entryPoints: [path.join(WORKER_ROOT, "src/vision/index.ts")],
    outfile: visionBundle,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  }),
]);

const store = await import(pathToFileURL(storeBundle).href);
const vision = await import(pathToFileURL(visionBundle).href);
const encoder = new TextEncoder();

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalBytes = (value) => encoder.encode(canonicalize(value));

class MemoryR2 {
  objects = new Map();

  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return body(key, bytes);
  }

  async put(key, value, options = {}) {
    const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.objects.set(key, copy);
    return body(key, copy);
  }

  inject(key, bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.objects.set(key, copy);
  }
}

function body(key, bytes) {
  return {
    key,
    size: bytes.byteLength,
    etag: sha256(bytes),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

const bounds = (x = 0.1, y = 0.1, width = 0.7, height = 0.1) => ({ x, y, width, height });
const reading = (quote, box = bounds()) => ({
  quote,
  alternatives: [],
  readability: "read",
  modelConfidence: 0.95,
  bounds: box,
});

const modelInventory = {
  schemaVersion: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
  questionRegions: [{ localId: "q1", text: reading("Choose a treatment") }],
  optionGroups: [{
    localId: "g1",
    questionRegionId: "q1",
    selectionAppearance: "appears-single",
    bounds: bounds(0.08, 0.2, 0.8, 0.45),
    options: [{
      localId: "o1",
      text: reading("Option A", bounds(0.15, 0.28, 0.35, 0.08)),
      markAppearance: "appears-unselected",
    }],
  }],
  controls: [],
  messages: [],
  visualLimitations: [],
};

const model = {
  provider: "fixture-provider",
  model: "fixture-vision-v1",
  transport: "fixture-binding",
  configurationSha256: "c".repeat(64),
};

async function buildFixture() {
  const screenshot = new Uint8Array(24);
  screenshot.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(screenshot.buffer).setUint32(16, 100, false);
  new DataView(screenshot.buffer).setUint32(20, 80, false);
  const capture = {
    runId: "v2r_visual_store_test",
    attemptId: "attempt-store-1",
    pathId: "path-store-1",
    stepIndex: 1,
    slot: "before",
    epochId: "epoch_store_1",
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
  };
  const geometry = {
    source: "browser",
    viewportCssWidth: 100,
    viewportCssHeight: 80,
    screenshotPixelWidth: 100,
    screenshotPixelHeight: 80,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
  };
  const absentScreen = {
    state: "unavailable",
    failure: { kind: "fixture-screen-unavailable", count: 1, detail: "not supplied by this storage fixture" },
  };
  const absentAx = {
    state: "unavailable",
    failure: { kind: "fixture-ax-unavailable", count: 1, detail: "not supplied by this storage fixture" },
  };
  const pairedEvidenceSha256 = await vision.computePairedEvidenceSha256({
    capture,
    geometry,
    screen: absentScreen,
    accessibility: absentAx,
  });
  const requests = [];
  const observed = await vision.observeVisualPage(
    {
      screenshot: {
        evidenceId: "ev_store_screenshot",
        contentSha256: sha256(screenshot),
        mediaType: "image/png",
        bytes: screenshot,
      },
      screen: absentScreen,
      accessibility: absentAx,
      pairedEvidenceSha256,
      capture,
      geometry,
    },
    model,
    {
      client: {
        async observe(request) {
          requests.push(request);
          return {
            content: modelInventory,
            telemetry: {
              callId: request.callId,
              provider: model.provider,
              model: model.model,
              providerRequestId: "fixture-request-1",
              gatewayLogId: "fixture-log-1",
              inputTokens: 50,
              outputTokens: 25,
              costUsd: 0.001,
              usageSource: "provider-reported",
              attempts: 1,
              latencyMs: 25,
            },
          };
        },
      },
      sink: { async persist() {} },
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    },
  );
  assert.equal(observed.artifact.readState, "observed");
  const reconciliation = vision.reconcileOptionMembership({
    observation: observed.artifact,
    screen: null,
    accessibility: null,
  });
  assert.equal(reconciliation.facts.length, 1);
  const request = requests[0];
  const inferenceDigest = observed.artifact.inferenceCacheKey.split("/").at(-1);
  const epochDigest = observed.artifact.cacheKey.split("/").at(-1);
  const claim = {
    schemaVersion: store.VISUAL_INFERENCE_CLAIM_SCHEMA_VERSION,
    kind: "survey-qa-visual-inference-claim",
    inferenceCacheKey: observed.artifact.inferenceCacheKey,
    callId: request.callId,
    claimedAt: "2026-08-09T11:59:59.000Z",
    request: {
      screenshotSha256: request.screenshot.contentSha256,
      mediaType: "image/png",
      pixelWidth: request.screenshot.pixelWidth,
      pixelHeight: request.screenshot.pixelHeight,
      provider: model.provider,
      model: model.model,
      transport: model.transport,
      configurationSha256: model.configurationSha256,
      prompt: { version: request.prompt.version, sha256: request.prompt.sha256 },
      responseSchema: { version: request.responseSchema.version, sha256: request.responseSchema.sha256 },
    },
  };
  const outcome = {
    schemaVersion: store.VISUAL_INFERENCE_OUTCOME_SCHEMA_VERSION,
    kind: "survey-qa-visual-inference-outcome",
    inferenceCacheKey: claim.inferenceCacheKey,
    callId: claim.callId,
    settledAt: "2026-08-09T12:00:00.000Z",
    result: {
      state: "unavailable",
      inventory: null,
      responseSha256: null,
      failure: { kind: "fixture-normalized-provider-failure", count: 1, detail: "fixture" },
    },
    telemetry: null,
  };
  return {
    observation: observed.artifact,
    reconciliation,
    claim,
    outcome,
    inferenceDigest,
    epochDigest,
    inferenceKeys: {
      digest: inferenceDigest,
      claimKey: `visual/inference/${inferenceDigest}/claim.json`,
      outcomeKey: `visual/inference/${inferenceDigest}/outcome.json`,
    },
  };
}

test("a claim without an outcome is indeterminate and never authorizes repurchase", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  assert.equal(await store.claimVisualInference(bucket, fixture.inferenceKeys, fixture.claim), "stored");
  const state = await store.readVisualInferenceState(bucket, fixture.inferenceKeys);
  assert.equal(state.state, "indeterminate");
  assert.equal(state.issueNew, false);
  assert.equal(state.reason, "claim-present-outcome-absent");
  assert.equal("repurchase" in state, false);
});

test("exact retries reuse bytes while a conflicting receipt is refused", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  assert.equal(await store.claimVisualInference(bucket, fixture.inferenceKeys, fixture.claim), "stored");
  assert.equal(await store.claimVisualInference(bucket, fixture.inferenceKeys, structuredClone(fixture.claim)), "reused");
  assert.equal(await store.settleVisualInference(bucket, fixture.inferenceKeys, fixture.outcome), "stored");
  assert.equal(await store.settleVisualInference(bucket, fixture.inferenceKeys, structuredClone(fixture.outcome)), "reused");
  const state = await store.readVisualInferenceState(bucket, fixture.inferenceKeys);
  assert.equal(state.state, "settled");
  assert.equal(state.issueNew, false);

  const conflicting = structuredClone(fixture.claim);
  conflicting.claimedAt = "2026-08-09T11:59:58.000Z";
  await assert.rejects(
    store.claimVisualInference(bucket, fixture.inferenceKeys, conflicting),
    (error) => error.name === "VisualStorageImmutabilityError",
  );
});

test("outcome-without-claim and corrupt stored bytes are refused, never treated as unstarted", async () => {
  const fixture = await buildFixture();
  const source = new MemoryR2();
  await store.claimVisualInference(source, fixture.inferenceKeys, fixture.claim);
  await store.settleVisualInference(source, fixture.inferenceKeys, fixture.outcome);
  const outcomeBytes = source.objects.get(fixture.inferenceKeys.outcomeKey);

  const orphaned = new MemoryR2();
  orphaned.inject(fixture.inferenceKeys.outcomeKey, outcomeBytes);
  const orphanedState = await store.readVisualInferenceState(orphaned, fixture.inferenceKeys);
  assert.equal(orphanedState.state, "corrupt");
  assert.equal(orphanedState.issueNew, false);
  await assert.rejects(
    store.claimVisualInference(orphaned, fixture.inferenceKeys, fixture.claim),
    (error) => error.name === "VisualStorageCorruptionError",
  );
  await assert.rejects(
    store.settleVisualInference(new MemoryR2(), fixture.inferenceKeys, fixture.outcome),
    (error) => error.name === "VisualStorageCorruptionError",
  );

  const malformed = new MemoryR2();
  malformed.inject(fixture.inferenceKeys.claimKey, encoder.encode('{"kind":"not-a-claim","decision":"pass"}'));
  const malformedState = await store.readVisualInferenceState(malformed, fixture.inferenceKeys);
  assert.equal(malformedState.state, "corrupt");
  assert.equal(malformedState.issueNew, false);
});

test("grounded epoch writes are closed and immutable; decision or unknown fields are rejected", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  const epoch = await store.createGroundedVisualEpochResult({
    finalizedAt: "2026-08-09T12:00:01.000Z",
    observation: fixture.observation,
    reconciliation: fixture.reconciliation,
  });
  const storage = {
    digest: fixture.epochDigest,
    key: `visual/epoch/${fixture.epochDigest}/grounded.json`,
  };
  const stored = await store.persistGroundedVisualEpoch(bucket, storage, epoch);
  assert.equal((await store.persistGroundedVisualEpoch(bucket, storage, structuredClone(epoch))).contentSha256, stored.contentSha256);

  const conflicting = structuredClone(epoch);
  conflicting.finalizedAt = "2026-08-09T12:00:02.000Z";
  await assert.rejects(
    store.persistGroundedVisualEpoch(bucket, storage, conflicting),
    (error) => error.name === "VisualStorageImmutabilityError",
  );

  const decisionBearing = structuredClone(fixture.reconciliation);
  decisionBearing.verdict = "pass";
  await assert.rejects(
    store.createGroundedVisualEpochResult({
      finalizedAt: "2026-08-09T12:00:01.000Z",
      observation: fixture.observation,
      reconciliation: decisionBearing,
    }),
    (error) => error.name === "VisualStorageValidationError",
  );

  const unknownBearing = structuredClone(fixture.observation);
  unknownBearing.inventory.optionGroups[0].options[0].semanticChecked = false;
  await assert.rejects(
    store.createGroundedVisualEpochResult({
      finalizedAt: "2026-08-09T12:00:01.000Z",
      observation: unknownBearing,
      reconciliation: fixture.reconciliation,
    }),
    (error) => error.name === "VisualStorageValidationError",
  );
});

test("final manifest totals are mechanical and a self-consistent false total cannot finalize", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  const epoch = await store.createGroundedVisualEpochResult({
    finalizedAt: "2026-08-09T12:00:01.000Z",
    observation: fixture.observation,
    reconciliation: fixture.reconciliation,
  });
  const epochStorage = {
    digest: fixture.epochDigest,
    key: `visual/epoch/${fixture.epochDigest}/grounded.json`,
  };
  const storedEpoch = await store.persistGroundedVisualEpoch(bucket, epochStorage, epoch);
  const prepared = await store.prepareVisualRunManifest({
    runId: fixture.observation.input.capture.runId,
    finalizedAt: "2026-08-09T12:00:03.000Z",
    epochs: [storedEpoch],
  });
  assert.deepEqual(prepared.manifest.totals, {
    epochs: 1,
    observedEpochs: 1,
    nonObservedEpochs: 0,
    questionRegions: fixture.observation.counts.questionRegions,
    optionGroups: fixture.observation.counts.optionGroups,
    options: fixture.observation.counts.options,
    controls: fixture.observation.counts.controls,
    messages: fixture.observation.counts.messages,
    observationLimitations: fixture.observation.counts.limitations,
    facts: fixture.reconciliation.counts.facts,
    conflicts: fixture.reconciliation.counts.conflicts,
    reconciliationLimitations: fixture.reconciliation.counts.limitations,
  });

  const manifestStorage = {
    digest: prepared.contentSha256,
    key: `visual/manifest/${prepared.contentSha256}/index.json`,
  };
  assert.equal(await store.finalizeVisualRunManifest(bucket, manifestStorage, prepared), "stored");
  assert.equal(await store.finalizeVisualRunManifest(bucket, manifestStorage, prepared), "reused");
  assert.deepEqual(await store.readVisualRunManifest(bucket, manifestStorage), prepared.manifest);

  // Mutate the attested total AND update its canonical bytes/hash. This proves the validator,
  // rather than a stale-hash check, independently recomputes the denominator and can fail.
  const falsePrepared = structuredClone(prepared);
  falsePrepared.manifest.totals.facts += 1;
  falsePrepared.canonicalBytes = canonicalBytes(falsePrepared.manifest);
  falsePrepared.contentSha256 = sha256(falsePrepared.canonicalBytes);
  await assert.rejects(
    store.finalizeVisualRunManifest(
      bucket,
      {
        digest: falsePrepared.contentSha256,
        key: `visual/manifest/${falsePrepared.contentSha256}/index.json`,
      },
      falsePrepared,
    ),
    (error) => error.name === "VisualStorageValidationError" && error.message.includes("recomputes"),
  );
});

test("R2 VisualObservationSink accepts exact canonical bytes and refuses a repointed payload", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  const sink = store.createR2VisualObservationSink(bucket, (digest) => ({
    digest,
    key: `visual/observation/${digest}/artifact.json`,
  }));
  const bytes = canonicalBytes(fixture.observation);
  const input = {
    cacheKey: fixture.observation.cacheKey,
    inferenceCacheKey: fixture.observation.inferenceCacheKey,
    artifact: fixture.observation,
    canonicalBytes: bytes,
    contentSha256: sha256(bytes),
  };
  await sink.persist(input);
  await sink.persist(structuredClone(input));
  const loaded = await store.readVisualObservationArtifact(
    bucket,
    {
      digest: fixture.epochDigest,
      key: `visual/observation/${fixture.epochDigest}/artifact.json`,
    },
  );
  assert.equal(loaded.cacheKey, fixture.observation.cacheKey);

  const wrongBytes = new Uint8Array(bytes);
  wrongBytes[wrongBytes.length - 1] ^= 1;
  await assert.rejects(
    sink.persist({ ...input, canonicalBytes: wrongBytes, contentSha256: sha256(wrongBytes) }),
    (error) => error.name === "VisualStorageValidationError",
  );
});

test("reconciliation is independently immutable, re-readable, and bound to its observation", async () => {
  const fixture = await buildFixture();
  const bucket = new MemoryR2();
  const storage = {
    digest: fixture.epochDigest,
    key: `visual/reconciliation/${fixture.epochDigest}/artifact.json`,
  };
  const stored = await store.persistOptionMembershipReconciliation(
    bucket,
    storage,
    fixture.observation,
    fixture.reconciliation,
  );
  assert.match(stored.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    (
      await store.persistOptionMembershipReconciliation(
        bucket,
        storage,
        structuredClone(fixture.observation),
        structuredClone(fixture.reconciliation),
      )
    ).contentSha256,
    stored.contentSha256,
  );
  assert.deepEqual(
    await store.readOptionMembershipReconciliation(bucket, storage, fixture.observation),
    stored,
  );

  const conflicting = structuredClone(fixture.reconciliation);
  conflicting.limitations.push({
    kind: "model-visual-limitation",
    channel: "visual",
    count: 1,
    detail: "mutation proves append-only reconciliation storage can fail",
  });
  conflicting.counts.limitations += 1;
  await assert.rejects(
    store.persistOptionMembershipReconciliation(bucket, storage, fixture.observation, conflicting),
    (error) => error.name === "VisualStorageImmutabilityError",
  );

  const repointedObservation = structuredClone(fixture.observation);
  repointedObservation.input.capture.epochId = "different-epoch";
  await assert.rejects(
    store.readOptionMembershipReconciliation(bucket, storage, repointedObservation),
    (error) => error.name === "VisualStorageValidationError",
  );
});
