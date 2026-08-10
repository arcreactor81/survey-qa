/** Mutation-proven proof for the closed visual shadow coverage index. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";
import { memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-coverage-test-"));
const bundlePath = path.join(bundleDir, "visual-coverage.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as coverage from ${p("src/store/visual-coverage.ts")};`,
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as hash from ${p("src/store/hash.ts")};`,
      `export * as vision from ${p("src/vision/index.ts")};`,
      `export * as visionStore from ${p("src/store/vision.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-coverage-test-entry.ts",
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
const encoder = new TextEncoder();
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const at = (second) => `2026-08-09T12:00:${String(second).padStart(2, "0")}.000Z`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalBytes = (value) => encoder.encode(canonicalize(value));
const screenshotBytes = new Uint8Array(24);
screenshotBytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
new DataView(screenshotBytes.buffer).setUint32(16, 100, false);
new DataView(screenshotBytes.buffer).setUint32(20, 80, false);
const screenBytes = encoder.encode("{}");
const accessibilityBytes = encoder.encode(JSON.stringify({ role: "button", name: "Continue" }));

function binding(pathId, attemptId, digit) {
  return {
    evidenceId: `ev_walk_${digit}`,
    artifactRef: `observations/${pathId}.json`,
    contentHash: digit.repeat(64),
    mediaType: "application/json",
    sourceEvidenceId: `EV-${pathId}-observation`,
    attemptId,
    routeId: pathId,
    type: "state",
    size: 500,
  };
}

function artifactRef(kind, digit) {
  return {
    kind,
    evidenceId: `ev_${kind}_${digit}`,
    artifactRef: `captures/${kind}-${digit}.${kind === "screenshot" ? "png" : "json"}`,
    sourceEvidenceId: `EV-${kind}-${digit}`,
    contentHash: digit.repeat(64),
    mediaType: kind === "screenshot" ? "image/png" : "application/json",
    size: 100 + Number.parseInt(digit, 16),
  };
}

async function workFixture() {
  const runId = "v2r_visual_coverage_fixture";
  const planRevisionId = "plan_visual_coverage_fixture";
  const selected0 = binding("path-epoch", "attempt-epoch", "1");
  const selected1 = binding("path-unknown", "attempt-unknown", "2");
  const selected2 = binding("path-empty", "attempt-empty", "3");
  const walks = [
    {
      walkOrdinal: 0,
      pathId: "path-epoch",
      attemptId: "attempt-epoch",
      indexState: "exact",
      walkIndexRowSha256: "4".repeat(64),
      selected: selected0,
      resolution: "verified",
      epochKnowledge: "known",
      epochCount: 1,
    },
    {
      walkOrdinal: 1,
      pathId: "path-unknown",
      attemptId: "attempt-unknown",
      indexState: "exact",
      walkIndexRowSha256: "5".repeat(64),
      selected: selected1,
      resolution: "verified",
      epochKnowledge: "unknown",
      epochCount: null,
    },
    {
      walkOrdinal: 2,
      pathId: "path-empty",
      attemptId: "attempt-empty",
      indexState: "exact",
      walkIndexRowSha256: "6".repeat(64),
      selected: selected2,
      resolution: "verified",
      epochKnowledge: "known",
      epochCount: 0,
    },
  ];
  const epoch = {
    walkOrdinal: 0,
    pathId: "path-epoch",
    attemptId: "attempt-epoch",
    walkArtifact: selected0,
    epochOrdinal: 0,
    epochId: "epoch-coverage-0",
    stepIndex: 2,
    slot: "before",
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
    startedAt: at(0),
    endedAt: at(3),
    screenReadAt: at(1),
    screenSignatureHash: "7".repeat(64),
    geometry: {
      width: 100,
      height: 80,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 100,
      documentHeight: 80,
      source: "browser",
    },
    screen: {
      status: "captured",
      ref: {
        ...artifactRef("screen-json", "8"),
        contentHash: sha256(screenBytes),
        size: screenBytes.byteLength,
      },
    },
    screenshot: {
      status: "captured",
      ref: {
        ...artifactRef("screenshot", "9"),
        contentHash: sha256(screenshotBytes),
        size: screenshotBytes.byteLength,
      },
    },
    accessibility: {
      status: "captured",
      ref: {
        ...artifactRef("accessibility", "a"),
        contentHash: sha256(accessibilityBytes),
        size: accessibilityBytes.byteLength,
      },
      completeness: "complete",
      limitations: [],
    },
    cacheInputIdentity: null,
    eligibility: "eligible",
    ambiguityKinds: [],
    limitationKinds: [],
  };
  epoch.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(epoch);
  const limitations = [
    {
      scope: "walk",
      walkOrdinal: 1,
      epochOrdinal: null,
      kind: "screen-captures-absent",
      count: 1,
      detail: "the verified observation has no screenCaptures field; its epoch count is unknown",
    },
  ];
  const manifest = await mod.visualWork.validateVisualWorkManifest({
    schemaVersion: mod.visualWork.VISUAL_WORK_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-work-manifest",
    runId,
    planRevisionId,
    walkArtifactIndexSha256: "b".repeat(64),
    walks,
    epochs: [epoch],
    limitations,
    totals: mod.visualWork.computeVisualWorkTotals(walks, [epoch], limitations, walks.length),
  });
  return { manifest, sha256: await mod.hash.canonicalHash(manifest) };
}

const inference = {
  provider: "fixture-provider",
  model: "fixture-vision-v1",
  transport: "fixture-binding",
  configurationSha256: "c".repeat(64),
  prompt: { version: "visual-prompt/1", sha256: "d".repeat(64) },
  responseSchema: { version: "visual-schema/1", sha256: "e".repeat(64) },
};

const authorization = {
  state: "authorized",
  rolloutConfigurationSha256: "f".repeat(64),
  maximumVisualCalls: 3,
  maximumVisualUsd: 0.05,
};

async function preparedFixture({ disabled = false, finalizedAt = at(10) } = {}) {
  const work = await workFixture();
  const selectedInference = disabled
    ? await mod.coverage.createDisabledVisualInferenceFingerprint({
        prompt: inference.prompt,
        responseSchema: inference.responseSchema,
      })
    : inference;
  const selectedAuthorization = disabled
    ? {
        state: "disabled",
        rolloutConfigurationSha256: "0".repeat(64),
        maximumVisualCalls: 0,
        maximumVisualUsd: 0,
      }
    : authorization;
  const inferenceFingerprintSha256 = await mod.coverage.visualInferenceFingerprintSha256(selectedInference);
  const authorizationFingerprintSha256 = await mod.coverage.visualAuthorizationFingerprintSha256(
    selectedAuthorization,
  );
  const denominator = await mod.coverage.deriveVisualCoverageDenominator(work.manifest);
  const entries = denominator.map((item) => {
    let disposition;
    if (item.kind === "epoch") disposition = disabled ? "budget-not-authorized" : "wave-limit-uncovered";
    else disposition = "input-ineligible";
    return {
      item,
      inferenceFingerprintSha256,
      authorizationFingerprintSha256,
      disposition,
      detail: `fixture:${disposition}`,
      success: null,
    };
  });
  const prepared = await mod.coverage.prepareVisualCoverageIndex({
    workManifest: work.manifest,
    visualWorkManifestSha256: work.sha256,
    inference: selectedInference,
    authorization: selectedAuthorization,
    finalizedAt,
    entries,
  });
  return { work, prepared, entries, denominator, selectedInference, selectedAuthorization };
}

async function storeWork(bucket, work) {
  await bucket.put(mod.keys.visualManifestKey(work.manifest.runId), canonicalBytes(work.manifest), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
}

async function observedSuccessFixture({ emptyDespitePairedContent = false } = {}) {
  const work = await workFixture();
  const workEpoch = work.manifest.epochs[0];
  const model = {
    provider: "fixture-provider",
    model: "fixture-vision-v1",
    transport: "fixture-binding",
    configurationSha256: "c".repeat(64),
  };
  const capture = {
    runId: work.manifest.runId,
    attemptId: workEpoch.attemptId,
    pathId: workEpoch.pathId,
    stepIndex: workEpoch.stepIndex,
    slot: workEpoch.slot,
    epochId: workEpoch.epochId,
    scope: workEpoch.scope,
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
  const screen = {
    state: "captured",
    evidenceId: workEpoch.screen.ref.evidenceId,
    contentSha256: workEpoch.screen.ref.contentHash,
    mediaType: "application/json",
    bytes: screenBytes,
  };
  const accessibility = {
    state: "captured",
    evidenceId: workEpoch.accessibility.ref.evidenceId,
    contentSha256: workEpoch.accessibility.ref.contentHash,
    mediaType: "application/json",
    bytes: accessibilityBytes,
  };
  const pairedEvidenceSha256 = await mod.vision.computePairedEvidenceSha256({
    capture,
    geometry,
    screen: {
      state: "captured",
      evidenceId: screen.evidenceId,
      contentSha256: screen.contentSha256,
    },
    accessibility: {
      state: "captured",
      evidenceId: accessibility.evidenceId,
      contentSha256: accessibility.contentSha256,
    },
  });
  const observed = await mod.vision.observeVisualPage(
    {
      screenshot: {
        evidenceId: workEpoch.screenshot.ref.evidenceId,
        contentSha256: workEpoch.screenshot.ref.contentHash,
        mediaType: "image/png",
        bytes: screenshotBytes,
      },
      screen,
      accessibility,
      pairedEvidenceSha256,
      capture,
      geometry,
    },
    model,
    {
      client: {
        async observe(request) {
          return {
            content: emptyDespitePairedContent ? {
              schemaVersion: mod.vision.VISUAL_RESPONSE_SCHEMA_VERSION,
              questionRegions: [],
              optionGroups: [],
              controls: [],
              messages: [],
              visualLimitations: [],
            } : {
              schemaVersion: mod.vision.VISUAL_RESPONSE_SCHEMA_VERSION,
              questionRegions: [
                {
                  localId: "q1",
                  text: {
                    quote: "Choose one",
                    alternatives: [],
                    readability: "read",
                    modelConfidence: 0.9,
                    bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
                  },
                },
              ],
              optionGroups: [
                {
                  localId: "g1",
                  questionRegionId: "q1",
                  selectionAppearance: "appears-single",
                  bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
                  options: [
                    {
                      localId: "o1",
                      text: {
                        quote: "Option A",
                        alternatives: [],
                        readability: "read",
                        modelConfidence: 0.9,
                        bounds: { x: 0.15, y: 0.3, width: 0.4, height: 0.08 },
                      },
                      markAppearance: "appears-unselected",
                    },
                  ],
                },
              ],
              controls: [],
              messages: [],
              visualLimitations: [],
            },
            telemetry: {
              callId: request.callId,
              provider: model.provider,
              model: model.model,
              providerRequestId: "fixture-request",
              gatewayLogId: null,
              inputTokens: 100,
              outputTokens: 50,
              costUsd: 0.001,
              usageSource: "provider-reported",
              attempts: 1,
              latencyMs: 20,
            },
          };
        },
      },
      sink: { async persist() {} },
      now: () => new Date(at(8)),
    },
  );
  assert.equal(observed.artifact.readState, "observed", JSON.stringify(observed.artifact.limitations));
  assert.equal(
    observed.artifact.limitations.some(
      (limitation) => limitation.kind === "model-inventory-empty-despite-paired-content",
    ),
    emptyDespitePairedContent,
  );
  const reconciliation = mod.vision.reconcileOptionMembership({
    observation: observed.artifact,
    screen: null,
    accessibility: null,
  });
  const grounded = await mod.visionStore.createGroundedVisualEpochResult({
    finalizedAt: at(9),
    observation: observed.artifact,
    reconciliation,
  });
  const realInference = {
    ...model,
    prompt: {
      version: mod.vision.VISUAL_PROMPT_VERSION,
      sha256: await mod.vision.visualPromptSha256(),
    },
    responseSchema: {
      version: mod.vision.VISUAL_RESPONSE_SCHEMA_VERSION,
      sha256: await mod.vision.visualResponseSchemaSha256(),
    },
  };
  const inferenceFingerprintSha256 = await mod.coverage.visualInferenceFingerprintSha256(realInference);
  const authorizationFingerprintSha256 = await mod.coverage.visualAuthorizationFingerprintSha256(authorization);
  const denominator = await mod.coverage.deriveVisualCoverageDenominator(work.manifest);
  const observationBytes = canonicalBytes(observed.artifact);
  const reconciliationBytes = canonicalBytes(reconciliation);
  const groundedBytes = canonicalBytes(grounded);
  const observationKey = mod.keys.visualEpochObservationKey(work.manifest.runId, observed.artifact.cacheKey);
  const reconciliationKey = mod.keys.visualEpochReconciliationKey(work.manifest.runId, observed.artifact.cacheKey);
  const groundedKey = mod.keys.k(
    "runs",
    work.manifest.runId,
    "visual",
    "epochs",
    grounded.epochDigest,
    "grounded.json",
  );
  const entries = denominator.map((item) =>
    item.kind === "epoch"
      ? {
          item,
          inferenceFingerprintSha256,
          authorizationFingerprintSha256,
          disposition: "observed-stored",
          detail: null,
          success: {
            epochDigest: grounded.epochDigest,
            inferenceDigest: grounded.inferenceDigest,
            observation: { key: observationKey, contentSha256: sha256(observationBytes) },
            reconciliation: { key: reconciliationKey, contentSha256: sha256(reconciliationBytes) },
            grounded: { key: groundedKey, contentSha256: sha256(groundedBytes) },
          },
        }
      : {
          item,
          inferenceFingerprintSha256,
          authorizationFingerprintSha256,
          disposition: "input-ineligible",
          detail: "fixture:input-ineligible",
          success: null,
        },
  );
  const prepared = await mod.coverage.prepareVisualCoverageIndex({
    workManifest: work.manifest,
    visualWorkManifestSha256: work.sha256,
    inference: realInference,
    authorization,
    finalizedAt: at(10),
    entries,
  });
  return {
    work,
    prepared,
    artifacts: [
      [observationKey, observationBytes],
      [reconciliationKey, reconciliationBytes],
      [groundedKey, groundedBytes],
    ],
  };
}

test("denominator closes known epochs, unknown walks, and verified zero-epoch walks", async () => {
  const fixture = await preparedFixture();
  assert.deepEqual(
    fixture.denominator.map((item) => item.kind),
    ["epoch", "walk-epochs-unknown", "walk-no-epochs"],
  );
  assert.deepEqual(fixture.prepared.index.totals, {
    denominatorItems: 3,
    epochItems: 1,
    eligibleEpochItems: 1,
    ineligibleEpochItems: 0,
    unknownEpochWalkItems: 1,
    noEpochWalkItems: 1,
    successfulItems: 0,
    limitationItems: 3,
    dispositions: {
      "observed-stored": 0,
      "input-ineligible": 2,
      "input-integrity-failed": 0,
      "provider-unavailable": 0,
      "provider-malformed": 0,
      "persistence-failed": 0,
      "purchase-blocked": 0,
      "accounting-failed": 0,
      "rollout-config-invalid": 0,
      "budget-not-authorized": 0,
      "wave-limit-uncovered": 1,
    },
  });
});

test("disabled rollout uses the closed sentinel and mechanically closes eligible work as not authorized", async () => {
  const fixture = await preparedFixture({ disabled: true });
  assert.equal(fixture.prepared.index.inference.provider, "not-authorized");
  assert.equal(fixture.prepared.index.inference.model, "not-selected");
  assert.equal(fixture.prepared.index.authorization.state, "disabled");
  assert.equal(fixture.prepared.index.totals.dispositions["budget-not-authorized"], 1);

  const invalidEntries = structuredClone(fixture.entries);
  invalidEntries[0].disposition = "provider-unavailable";
  invalidEntries[0].detail = "this must not be accepted as a fake provider call";
  await assert.rejects(
    mod.coverage.prepareVisualCoverageIndex({
      workManifest: fixture.work.manifest,
      visualWorkManifestSha256: fixture.work.sha256,
      inference: fixture.selectedInference,
      authorization: fixture.selectedAuthorization,
      finalizedAt: at(10),
      entries: invalidEntries,
    }),
    (error) => error.name === "VisualCoverageValidationError" && error.message.includes("budget-not-authorized"),
  );

  const invalidAuthorization = {
    state: "invalid",
    rolloutConfigurationSha256: "1".repeat(64),
    maximumVisualCalls: 0,
    maximumVisualUsd: 0,
  };
  const invalidAuthorizationSha256 = await mod.coverage.visualAuthorizationFingerprintSha256(
    invalidAuthorization,
  );
  const configInvalidEntries = structuredClone(fixture.entries);
  for (const entry of configInvalidEntries) {
    entry.authorizationFingerprintSha256 = invalidAuthorizationSha256;
  }
  configInvalidEntries[0].disposition = "rollout-config-invalid";
  configInvalidEntries[0].detail = "the rollout configuration failed closed before any provider call";
  const configInvalid = await mod.coverage.prepareVisualCoverageIndex({
    workManifest: fixture.work.manifest,
    visualWorkManifestSha256: fixture.work.sha256,
    inference: fixture.selectedInference,
    authorization: invalidAuthorization,
    finalizedAt: at(10),
    entries: configInvalidEntries,
  });
  assert.equal(configInvalid.index.totals.dispositions["rollout-config-invalid"], 1);
});

test("remove-one, duplicate, extra, ordinal, and fingerprint mutations all fail closed", async () => {
  const fixture = await preparedFixture();
  const base = {
    workManifest: fixture.work.manifest,
    visualWorkManifestSha256: fixture.work.sha256,
    inference,
    authorization,
    finalizedAt: at(10),
  };
  await assert.rejects(
    mod.coverage.prepareVisualCoverageIndex({ ...base, entries: fixture.entries.slice(0, -1) }),
    /omits 1 denominator item/,
  );

  const duplicate = structuredClone(fixture.entries);
  duplicate[2] = structuredClone(duplicate[1]);
  await assert.rejects(mod.coverage.prepareVisualCoverageIndex({ ...base, entries: duplicate }), /duplicates denominator/);

  const extra = structuredClone(fixture.entries);
  const extraRow = structuredClone(extra[0]);
  extraRow.item.walkOrdinal = 99;
  extra.push(extraRow);
  await assert.rejects(mod.coverage.prepareVisualCoverageIndex({ ...base, entries: extra }), /extra denominator/);

  const ordinal = structuredClone(fixture.entries);
  ordinal[0].item.epochOrdinal = 1;
  await assert.rejects(mod.coverage.prepareVisualCoverageIndex({ ...base, entries: ordinal }), /extra denominator/);

  const fingerprint = structuredClone(fixture.entries);
  fingerprint[0].inferenceFingerprintSha256 = "1".repeat(64);
  await assert.rejects(
    mod.coverage.prepareVisualCoverageIndex({ ...base, entries: fingerprint }),
    /does not match the sealed provider\/model configuration/,
  );
});

test("observed-stored refuses missing or unverified immutable success refs", async () => {
  const fixture = await preparedFixture();
  const missingRefs = structuredClone(fixture.entries);
  missingRefs[0].disposition = "observed-stored";
  missingRefs[0].detail = null;
  missingRefs[0].success = null;
  await assert.rejects(
    mod.coverage.prepareVisualCoverageIndex({
      workManifest: fixture.work.manifest,
      visualWorkManifestSha256: fixture.work.sha256,
      inference,
      authorization,
      finalizedAt: at(10),
      entries: missingRefs,
    }),
    /requires all immutable artifact refs and hashes/,
  );

  const absentArtifacts = structuredClone(fixture.entries);
  const epochDigest = "2".repeat(64);
  absentArtifacts[0] = {
    ...absentArtifacts[0],
    disposition: "observed-stored",
    detail: null,
    success: {
      epochDigest,
      inferenceDigest: "3".repeat(64),
      observation: {
        key: `v2/runs/${fixture.work.manifest.runId}/visual/epochs/${epochDigest}/observation.json`,
        contentSha256: "4".repeat(64),
      },
      reconciliation: {
        key: `v2/runs/${fixture.work.manifest.runId}/visual/epochs/${epochDigest}/reconciliation.json`,
        contentSha256: "5".repeat(64),
      },
      grounded: {
        key: `v2/runs/${fixture.work.manifest.runId}/visual/epochs/${epochDigest}/grounded.json`,
        contentSha256: "6".repeat(64),
      },
    },
  };
  const prepared = await mod.coverage.prepareVisualCoverageIndex({
    workManifest: fixture.work.manifest,
    visualWorkManifestSha256: fixture.work.sha256,
    inference,
    authorization,
    finalizedAt: at(10),
    entries: absentArtifacts,
  });
  const bucket = memoryR2();
  await storeWork(bucket, fixture.work);
  await assert.rejects(
    mod.coverage.finalizeVisualCoverageIndex(bucket, prepared),
    (error) => error.name === "VisualCoverageCorruptionError" && error.message.includes("is absent"),
  );
  assert.equal(await bucket.get(mod.coverage.visualCoverageIndexKey(fixture.work.manifest.runId, prepared.contentSha256)), null);
});

test("observed-stored finalization re-reads and binds all three immutable artifacts", async () => {
  const fixture = await observedSuccessFixture();
  const bucket = memoryR2();
  await storeWork(bucket, fixture.work);
  for (const [key, bytes] of fixture.artifacts) {
    await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
  }
  const finalized = await mod.coverage.finalizeVisualCoverageIndex(bucket, fixture.prepared);
  assert.equal(finalized.coverageWrite, "stored");
  assert.equal(fixture.prepared.index.totals.successfulItems, 1);
  const read = await mod.coverage.readVisualCoverageIndex(
    bucket,
    fixture.work.manifest.runId,
    finalized.coverageSha256,
    fixture.work.manifest,
  );
  assert.equal(read.entries[0].disposition, "observed-stored");
});

test("observed-stored finalization rejects the named paired-content empty-inventory limitation", async () => {
  const fixture = await observedSuccessFixture({ emptyDespitePairedContent: true });
  const bucket = memoryR2();
  await storeWork(bucket, fixture.work);
  for (const [key, bytes] of fixture.artifacts) {
    await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
  }
  assert.equal(fixture.prepared.index.totals.successfulItems, 1, "the fixture must exercise the false-success mutation");
  await assert.rejects(
    mod.coverage.finalizeVisualCoverageIndex(bucket, fixture.prepared),
    (error) =>
      error.name === "VisualCoverageCorruptionError" &&
      error.message.includes("model-inventory-empty-despite-paired-content"),
  );
  assert.equal(
    await bucket.get(mod.coverage.visualCoverageIndexKey(fixture.work.manifest.runId, fixture.prepared.contentSha256)),
    null,
  );
});

test("bad totals and digest mutations fail even when an attacker updates the enclosing hash", async () => {
  const fixture = await preparedFixture();
  const bucket = memoryR2();
  await storeWork(bucket, fixture.work);

  const falsePrepared = structuredClone(fixture.prepared);
  falsePrepared.index.totals.denominatorItems += 1;
  falsePrepared.canonicalBytes = canonicalBytes(falsePrepared.index);
  falsePrepared.contentSha256 = sha256(falsePrepared.canonicalBytes);
  await assert.rejects(
    mod.coverage.finalizeVisualCoverageIndex(bucket, falsePrepared),
    (error) => error.name === "VisualCoverageValidationError" && error.message.includes("mechanically recompute"),
  );

  const finalized = await mod.coverage.finalizeVisualCoverageIndex(bucket, fixture.prepared);
  await bucket.put(finalized.coverageKey, encoder.encode("{\"mutated\":true}"));
  await assert.rejects(
    mod.coverage.readVisualCoverageIndex(
      bucket,
      fixture.work.manifest.runId,
      fixture.prepared.contentSha256,
      fixture.work.manifest,
    ),
    (error) => error.name === "VisualCoverageCorruptionError" && error.message.includes("key digest"),
  );
});

test("content-addressed finalization is idempotent and a differing fixed pointer is never overwritten", async () => {
  const fixture = await preparedFixture();
  const bucket = memoryR2();
  await storeWork(bucket, fixture.work);
  const first = await mod.coverage.finalizeVisualCoverageIndex(bucket, fixture.prepared);
  const retry = await mod.coverage.finalizeVisualCoverageIndex(bucket, fixture.prepared);
  assert.equal(first.coverageWrite, "stored");
  assert.equal(first.pointerWrite, "stored");
  assert.equal(retry.coverageWrite, "reused");
  assert.equal(retry.pointerWrite, "reused");
  const before = await mod.coverage.readVisualCoveragePointer(bucket, fixture.work.manifest.runId);

  const differing = await preparedFixture({ finalizedAt: at(11) });
  await assert.rejects(
    mod.coverage.finalizeVisualCoverageIndex(bucket, differing.prepared),
    (error) => error.name === "VisualCoverageImmutabilityError" && error.key === first.pointerKey,
  );
  const afterPointer = await mod.coverage.readVisualCoveragePointer(bucket, fixture.work.manifest.runId);
  assert.deepEqual(afterPointer, before);
});
