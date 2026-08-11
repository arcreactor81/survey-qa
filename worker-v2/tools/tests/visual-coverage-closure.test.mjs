import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-coverage-closure-test-"));
const bundlePath = path.join(bundleDir, "closure.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as closure from ${p("src/workflow/stages/visual-coverage-closure.ts")};`,
      `export * as coverage from ${p("src/store/visual-coverage.ts")};`,
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-coverage-closure-test-entry.ts",
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
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const at = (second) => `2026-08-09T12:00:${String(second).padStart(2, "0")}.000Z`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function binding(pathId, attemptId, digit) {
  return {
    evidenceId: `ev-walk-${digit}`,
    artifactRef: `walks/${digit}.json`,
    contentHash: digit.repeat(64),
    mediaType: "application/json",
    sourceEvidenceId: `EV-${pathId}-observation`,
    attemptId,
    routeId: pathId,
    type: "state",
    size: 500,
  };
}

function captureRef(kind, digit) {
  const screenshot = kind === "screenshot";
  return {
    kind,
    evidenceId: `ev-${kind}-${digit}`,
    artifactRef: `captures/${kind}-${digit}.${screenshot ? "png" : "json"}`,
    sourceEvidenceId: `EV-${kind}-${digit}`,
    contentHash: digit.repeat(64),
    mediaType: screenshot ? "image/png" : "application/json",
    size: 100,
  };
}

async function fixture() {
  const selectedEpoch = binding("path-epoch", "attempt-epoch", "1");
  const selectedUnknown = binding("path-unknown", "attempt-unknown", "2");
  const selectedEmpty = binding("path-empty", "attempt-empty", "3");
  const walks = [
    {
      walkOrdinal: 0,
      pathId: "path-epoch",
      attemptId: "attempt-epoch",
      indexState: "exact",
      walkIndexRowSha256: "4".repeat(64),
      selected: selectedEpoch,
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
      selected: selectedUnknown,
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
      selected: selectedEmpty,
      resolution: "verified",
      epochKnowledge: "known",
      epochCount: 0,
    },
  ];
  const epoch = {
    walkOrdinal: 0,
    pathId: "path-epoch",
    attemptId: "attempt-epoch",
    walkArtifact: selectedEpoch,
    epochOrdinal: 0,
    epochId: "epoch-0",
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
    screen: { status: "captured", ref: captureRef("screen-json", "8") },
    screenshot: { status: "captured", ref: captureRef("screenshot", "9") },
    accessibility: {
      status: "captured",
      ref: captureRef("accessibility", "a"),
      completeness: "complete",
      limitations: [],
    },
    cacheInputIdentity: null,
    eligibility: "eligible",
    ambiguityKinds: [],
    limitationKinds: [],
  };
  epoch.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(epoch);
  const limitations = [{
    scope: "walk",
    walkOrdinal: 1,
    epochOrdinal: null,
    kind: "screen-captures-absent",
    count: 1,
    detail: "capture epochs are explicitly unknown",
  }];
  const manifest = await mod.visualWork.validateVisualWorkManifest({
    schemaVersion: mod.visualWork.VISUAL_WORK_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-work-manifest",
    runId: "v2r_visual_closure_fixture",
    planRevisionId: "plan_visual_closure_fixture",
    walkArtifactIndexSha256: "c".repeat(64),
    walks,
    epochs: [epoch],
    limitations,
    totals: mod.visualWork.computeVisualWorkTotals(walks, [epoch], limitations, walks.length),
  });
  const denominator = await mod.coverage.deriveVisualCoverageDenominator(manifest);
  return { manifest, denominator, epoch };
}

function close(input) {
  return mod.closure.closeVisualCoverageEntries({
    inferenceFingerprintSha256: HASH_A,
    authorizationFingerprintSha256: HASH_B,
    ...input,
  });
}

function storedResult(epoch, readState = "observed", limitationKinds = []) {
  const digest = "d".repeat(64);
  return {
    state: "stored",
    work: {
      walkOrdinal: epoch.walkOrdinal,
      epochOrdinal: epoch.epochOrdinal,
      pathId: epoch.pathId,
      attemptId: epoch.attemptId,
      epochId: epoch.epochId,
      stepIndex: epoch.stepIndex,
      slot: epoch.slot,
      cacheInputIdentity: epoch.cacheInputIdentity,
    },
    capture: {},
    model: {},
    readState,
    inference: {
      cacheKey: `visual-inference/sha256/${"e".repeat(64)}`,
      digest: "e".repeat(64),
      claimKey: "claim",
      outcomeKey: "outcome",
      durableState: "settled",
    },
    observation: {
      cacheKey: `visual-observation/sha256/${digest}`,
      storage: { key: `v2/runs/run/visual/epochs/${digest}/observation.json`, digest },
      contentSha256: "1".repeat(64),
      limitations: limitationKinds.length,
      limitationKinds,
    },
    reconciliation: {
      storage: { key: `v2/runs/run/visual/epochs/${digest}/reconciliation.json`, digest },
      contentSha256: "2".repeat(64),
      facts: 1,
      conflicts: 0,
      limitations: 0,
    },
    groundedEpoch: {
      storage: { key: `v2/runs/run/visual/epochs/${digest}/grounded.json`, digest },
      contentSha256: "3".repeat(64),
    },
  };
}

test("disabled closure counts the exact denominator and never drops unknown/zero walks", async () => {
  const fx = await fixture();
  const entries = await close({
    workManifest: fx.manifest,
    processed: [],
    remainder: { state: "disabled", detail: "rollout disabled by deployment" },
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.disposition), [
    "budget-not-authorized",
    "input-ineligible",
    "input-ineligible",
  ]);
  assert.equal(entries.every((entry) => entry.success === null), true);
  assert.equal(entries.every((entry) => entry.inferenceFingerprintSha256 === HASH_A), true);
});

test("processed observations map to exact success refs while provider failures remain limitations", async () => {
  const fx = await fixture();
  const observed = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch, "observed"),
  );
  const entries = await close({
    workManifest: fx.manifest,
    processed: [observed],
    remainder: { state: "wave-limit", detail: "fixture limit" },
  });
  assert.equal(entries[0].disposition, "observed-stored");
  assert.equal(entries[0].success.epochDigest, "d".repeat(64));
  assert.equal(entries[0].detail, null);

  for (const [state, disposition] of [
    ["malformed", "provider-malformed"],
    ["timeout", "provider-unavailable"],
    ["unavailable", "provider-unavailable"],
  ]) {
    const mapped = mod.closure.visualProcessedItemFromEpochResult(
      0,
      fx.denominator[0],
      storedResult(fx.epoch, state),
    );
    assert.equal(mapped.disposition, disposition);
    assert.equal(mapped.success, null);
  }
});

test("identity-mismatch malformed reads close as provider-malformed naming the drift, not a schema failure", async () => {
  // Companion to review vision-billing finding E1: the epoch no longer throws on a provider
  // model-echo drift (visual-epoch.ts), so the drifted epoch now reaches this projection with
  // readState "malformed" and the named model-identity-mismatch limitation. The coverage row
  // must name the identity mismatch; the generic malformed detail would falsely claim the
  // schema-valid response "failed the closed observation schema".
  const fx = await fixture();
  const kind = "model-identity-mismatch";
  const drifted = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch, "malformed", [kind]),
  );
  assert.equal(drifted.disposition, "provider-malformed");
  assert.equal(drifted.success, null);
  assert.match(drifted.detail, new RegExp(kind));
  assert.doesNotMatch(drifted.detail, /failed the closed observation schema/);

  const generic = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch, "malformed"),
  );
  assert.equal(generic.disposition, "provider-malformed");
  assert.match(generic.detail, /failed the closed observation schema/);

  const entries = await close({
    workManifest: fx.manifest,
    processed: [drifted],
    remainder: { state: "wave-limit", detail: "fixture limit" },
  });
  const totals = mod.coverage.computeVisualCoverageTotals(entries);
  assert.equal(totals.successfulItems, 0, "an identity drift is never visual coverage");
  assert.equal(totals.dispositions["provider-malformed"], 1);
});

test("paired-content empty inventory closes as a counted limitation, never as successful coverage", async () => {
  const fx = await fixture();
  const kind = "model-inventory-empty-despite-paired-content";
  const suspicious = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch, "observed", [kind]),
  );
  assert.equal(suspicious.disposition, "provider-malformed");
  assert.equal(suspicious.success, null);
  assert.match(suspicious.detail, new RegExp(kind));

  const entries = await close({
    workManifest: fx.manifest,
    processed: [suspicious],
    remainder: { state: "wave-limit", detail: "fixture limit" },
  });
  const totals = mod.coverage.computeVisualCoverageTotals(entries);
  assert.equal(totals.denominatorItems, 3, "the limitation must not shorten the denominator");
  assert.equal(totals.successfulItems, 0);
  assert.equal(totals.limitationItems, 3);
  assert.equal(totals.dispositions["provider-malformed"], 1);

  const supportedBlank = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch, "observed", []),
  );
  assert.equal(supportedBlank.disposition, "observed-stored");
  assert.notEqual(supportedBlank.success, null);
});

test("a loader refusal after preparation is surfaced as input integrity failure", async () => {
  const fx = await fixture();
  const base = storedResult(fx.epoch);
  const mapped = mod.closure.visualProcessedItemFromEpochResult(0, fx.denominator[0], {
    state: "input-ineligible",
    work: base.work,
    limitation: { kind: "screenshot-hash-mismatch", channel: "screenshot", detail: "fixture" },
  });
  assert.equal(mapped.disposition, "input-integrity-failed");
  assert.match(mapped.detail, /no model call was authorized/i);
});

test("every authorized terminal posture closes untouched eligible work with its exact reason", async () => {
  const fx = await fixture();
  for (const [state, expected] of [
    ["invalid", "rollout-config-invalid"],
    ["budget-exhausted", "budget-not-authorized"],
    ["purchase-blocked", "purchase-blocked"],
    ["wave-limit", "wave-limit-uncovered"],
  ]) {
    const entries = await close({
      workManifest: fx.manifest,
      processed: [],
      remainder: { state, detail: `fixture ${state}` },
    });
    assert.equal(entries[0].disposition, expected);
    assert.match(entries[0].detail, /no call was attempted/i);
    assert.equal(entries[1].disposition, "input-ineligible", "mechanical state must override terminal state");
  }
});

test("prefix gaps, hash mutations, identity drift, and false ineligibility fail loudly", async () => {
  const fx = await fixture();
  const valid = mod.closure.visualProcessedItemFromEpochResult(
    0,
    fx.denominator[0],
    storedResult(fx.epoch),
  );
  const mutations = [
    { ...valid, denominatorOrdinal: 1 },
    { ...valid, workItemSha256: "f".repeat(64) },
    { ...valid, disposition: "input-ineligible", detail: "false", success: null },
    { ...valid, disposition: "observed-stored", detail: "not-null" },
    { ...valid, unexpected: true },
  ];
  for (const item of mutations) {
    await assert.rejects(
      close({
        workManifest: fx.manifest,
        processed: [item],
        remainder: { state: "wave-limit", detail: "fixture" },
      }),
      (error) => error?.name === "VisualCoverageClosureError",
    );
  }

  const drifted = storedResult(fx.epoch);
  drifted.work.pathId = "other-path";
  assert.throws(
    () => mod.closure.visualProcessedItemFromEpochResult(0, fx.denominator[0], drifted),
    (error) => error?.name === "VisualCoverageClosureError",
  );
});
