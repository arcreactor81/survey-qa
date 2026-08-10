/** Focused proof for the immutable, pre-provider visual work denominator. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";
import { memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-work-test-"));
const bundlePath = path.join(bundleDir, "visual-work.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
      `export * as walkIndex from ${p("src/store/walk-artifact-index.ts")};`,
      `export * as evidence from ${p("src/store/evidence.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as ids from ${p("src/ids.ts")};`,
      `export * as stage from ${p("src/workflow/stages/visual-perception.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-work-test-entry.ts",
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

const artifactRef = (kind, digit) => ({
  kind,
  evidenceId: `ev_${kind.replace(/[^a-z]/g, "").slice(0, 8)}_${digit}`,
  artifactRef: `captures/${kind}-${digit}.${kind === "screenshot" ? "png" : "json"}`,
  sourceEvidenceId: `EV-${kind}-${digit}`,
  contentHash: digit.repeat(64),
  mediaType: kind === "screenshot" ? "image/png" : "application/json",
  size: 100 + Number(digit),
});

function captureFailure(kind = "screenshot-capture-failed") {
  return {
    kind,
    detail: `${kind} fixture`,
    count: 1,
    at: at(2),
    stepIndex: 0,
    slot: "before",
  };
}

function epoch({ epochId = "epoch-1", screenshotFailed = false } = {}) {
  const failure = screenshotFailed ? captureFailure() : null;
  return {
    kind: "v2-screen-capture-epoch/1.0.0",
    epochId,
    stepIndex: 0,
    slot: "before",
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
    startedAt: at(0),
    endedAt: at(3),
    screenReadAt: at(1),
    screenSignatureHash: "a".repeat(64),
    geometry: {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 1280,
      documentHeight: 720,
      source: "browser",
    },
    screenJson: artifactRef("screen-json", "1"),
    screenshot: screenshotFailed
      ? { status: "failed", failure }
      : { status: "captured", ref: artifactRef("screenshot", "2") },
    accessibility: {
      status: "captured",
      ref: artifactRef("accessibility", "3"),
      completeness: "complete",
      limitations: [],
    },
    captureFailures: failure ? [failure] : [],
    captureFailureCount: failure ? 1 : 0,
  };
}

function observation({ runId, planRevisionId, pathId, attemptId, epochs, omitCaptureFields = false }) {
  const value = {
    kind: "v2-path-observation/1.0.0",
    runId,
    pathId,
    tier: 1,
    attemptId,
    planRevisionId,
    surveyUrl: "https://example.test/survey",
    startedAt: at(0),
    endedAt: at(5),
    wallMs: 5000,
    plannedWitnesses: [],
    steps: [],
    outcome: "completed",
    outcomeDetail: null,
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    evidenceIds: [],
    viewport: { width: 1280, height: 720 },
  };
  if (!omitCaptureFields) {
    value.screenCaptures = epochs;
    value.screenCaptureCount = epochs.length;
    value.captureFailures = epochs.flatMap((item) => item.captureFailures);
    value.captureFailureCount = value.captureFailures.reduce((sum, item) => sum + item.count, 0);
  }
  return value;
}

async function addWalk(fixture, { pathId, attemptId, epochs = [], legacy = false, omitCaptureFields = false }) {
  const body = observation({
    runId: fixture.runId,
    planRevisionId: fixture.planRevisionId,
    pathId,
    attemptId,
    epochs,
    omitCaptureFields,
  });
  const entry = await mod.evidence.putEvidence(fixture.env, {
    runId: fixture.runId,
    bytes: encoder.encode(JSON.stringify(body)),
    mediaType: "application/json",
    type: "state",
    attemptId: legacy ? null : attemptId,
    routeId: pathId,
    sourceEvidenceId: `EV-${pathId}-observation`,
    artifactRef: `observations/${pathId}.json`,
  });
  fixture.walks.push({ pathId, attemptId, at: at(fixture.walks.length), caseIds: [] });
  fixture.catalog.push(entry);
  return entry;
}

function fixture() {
  const runId = mod.ids.mintRunId(1_786_262_400_000);
  return {
    runId,
    planRevisionId: "plan_visual_work_fixture",
    env: { EVIDENCE: memoryR2() },
    walks: [],
    catalog: [],
  };
}

async function persistIndex(fx) {
  const index = mod.walkIndex.buildWalkArtifactIndex({
    runId: fx.runId,
    planRevisionId: fx.planRevisionId,
    walks: fx.walks,
    catalog: fx.catalog,
  });
  await mod.walkIndex.putWalkArtifactIndex(fx.env.EVIDENCE, mod.keys.walkArtifactIndexKey(fx.runId), index);
  return index;
}

test("duplicate epoch and paired-input identities mark every occurrence ambiguous", async () => {
  const fx = fixture();
  const repeated = epoch({ epochId: "epoch-duplicate" });
  await addWalk(fx, {
    pathId: "path-duplicate",
    attemptId: "attempt-duplicate",
    epochs: [repeated, structuredClone(repeated)],
  });
  const index = await persistIndex(fx);
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  const retry = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(retry.state, "evaluated");
  assert.equal(retry.value.manifestSha256, result.value.manifestSha256, "an exact retry must reuse identical bytes");
  assert.equal(result.value.totals.indexWalks, 1);
  assert.equal(result.value.totals.walksReconciled, 1);
  assert.equal(result.value.totals.epochsDiscovered, 2);
  assert.equal(result.value.totals.eligibleEpochs, 0);
  assert.equal(result.value.totals.ineligibleEpochs, 2);
  assert.equal(result.value.totals.ambiguousEpochs, 2);
  const manifest = await mod.visualWork.readVisualWorkManifest(
    fx.env.EVIDENCE,
    mod.keys.visualManifestKey(fx.runId),
    { index },
  );
  assert.deepEqual(
    manifest.epochs.map((row) => row.ambiguityKinds),
    [
      ["duplicate-cache-input-identity", "duplicate-epoch-identity"],
      ["duplicate-cache-input-identity", "duplicate-epoch-identity"],
    ],
  );
  assert.equal(manifest.totals.limitations.find((row) => row.kind === "duplicate-epoch-identity").rows, 2);
  assert.equal(manifest.totals.limitations.find((row) => row.kind === "duplicate-cache-input-identity").rows, 2);
});

test("corrupt and unreadable indexed walks stay unknown, never zero-epoch", async () => {
  const fx = fixture();
  const corruptEntry = await mod.evidence.putEvidence(fx.env, {
    runId: fx.runId,
    bytes: encoder.encode("{corrupt-json"),
    mediaType: "application/json",
    type: "state",
    attemptId: "attempt-corrupt",
    routeId: "path-corrupt",
    sourceEvidenceId: "EV-path-corrupt-observation",
    artifactRef: "observations/path-corrupt.json",
  });
  fx.walks.push({ pathId: "path-corrupt", attemptId: "attempt-corrupt", at: at(0), caseIds: [] });
  fx.catalog.push(corruptEntry);
  const unreadableEntry = await addWalk(fx, {
    pathId: "path-unreadable",
    attemptId: "attempt-unreadable",
    epochs: [epoch()],
  });
  await persistIndex(fx);
  // Bypass the public immutable evidence writer to simulate damaged CAS bytes after indexing.
  await fx.env.EVIDENCE.put(mod.keys.evidenceBlobKey(unreadableEntry.contentHash), encoder.encode("damaged"));
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  assert.equal(result.value.totals.epochsDiscovered, 0);
  assert.equal(result.value.totals.unknownEpochWalks, 2);
  assert.equal(result.value.totals.verifiedArtifactWalks, 0);
  assert.equal(result.value.totals.limitations.find((row) => row.kind === "walk-artifact-unreadable").rows, 1);
  assert.equal(result.value.totals.limitations.find((row) => row.kind === "walk-artifact-corrupt").rows, 1);
});

test("a failed PNG capture remains in the denominator but is ineligible for a paid call", async () => {
  const fx = fixture();
  await addWalk(fx, {
    pathId: "path-shot-failed",
    attemptId: "attempt-shot-failed",
    epochs: [epoch({ screenshotFailed: true })],
  });
  const index = await persistIndex(fx);
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  assert.equal(result.value.totals.epochsDiscovered, 1);
  assert.equal(result.value.totals.eligibleEpochs, 0);
  assert.equal(result.value.totals.ineligibleEpochs, 1);
  const manifest = await mod.visualWork.readVisualWorkManifest(
    fx.env.EVIDENCE,
    mod.keys.visualManifestKey(fx.runId),
    { index },
  );
  assert.equal(manifest.epochs[0].screenshot.status, "failed");
  assert.equal(manifest.epochs[0].cacheInputIdentity, null);
  assert.equal(manifest.epochs[0].limitationKinds.includes("capture-failure:screenshot-capture-failed"), true);
});

test("a legacy artifact without screenCaptures is explicitly unknown", async () => {
  const fx = fixture();
  await addWalk(fx, {
    pathId: "path-legacy",
    attemptId: "attempt-current",
    legacy: true,
    omitCaptureFields: true,
  });
  const index = await persistIndex(fx);
  assert.equal(index.rows[0].state, "legacy");
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  assert.equal(result.value.totals.epochsDiscovered, 0);
  assert.equal(result.value.totals.unknownEpochWalks, 1);
  assert.equal(
    result.value.totals.limitations.find((row) => row.kind === "legacy-screen-captures-absent").rows,
    1,
  );
});

test("a false declared capture count is named without shortening discovered epoch work", async () => {
  const fx = fixture();
  const pathId = "path-false-count";
  const attemptId = "attempt-false-count";
  const body = observation({
    runId: fx.runId,
    planRevisionId: fx.planRevisionId,
    pathId,
    attemptId,
    epochs: [epoch()],
  });
  body.screenCaptureCount = 0;
  const entry = await mod.evidence.putEvidence(fx.env, {
    runId: fx.runId,
    bytes: encoder.encode(JSON.stringify(body)),
    mediaType: "application/json",
    type: "state",
    attemptId,
    routeId: pathId,
    sourceEvidenceId: `EV-${pathId}-observation`,
    artifactRef: `observations/${pathId}.json`,
  });
  fx.walks.push({ pathId, attemptId, at: at(0), caseIds: [] });
  fx.catalog.push(entry);
  await persistIndex(fx);
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  assert.equal(result.value.totals.epochsDiscovered, 1);
  assert.equal(result.value.totals.eligibleEpochs, 1);
  assert.equal(
    result.value.totals.limitations.find((row) => row.kind === "inconsistent-declared-capture-counts").rows,
    1,
  );
});

test("a walk-level screen read failure is counted without inventing an epoch", async () => {
  const fx = fixture();
  const pathId = "path-screen-read-failed";
  const attemptId = "attempt-screen-read-failed";
  const body = observation({
    runId: fx.runId,
    planRevisionId: fx.planRevisionId,
    pathId,
    attemptId,
    epochs: [],
  });
  const failure = captureFailure("screen-read-failed");
  body.captureFailures = [failure];
  body.captureFailureCount = 1;
  const entry = await mod.evidence.putEvidence(fx.env, {
    runId: fx.runId,
    bytes: encoder.encode(JSON.stringify(body)),
    mediaType: "application/json",
    type: "state",
    attemptId,
    routeId: pathId,
    sourceEvidenceId: `EV-${pathId}-observation`,
    artifactRef: `observations/${pathId}.json`,
  });
  fx.walks.push({ pathId, attemptId, at: at(0), caseIds: [] });
  fx.catalog.push(entry);
  await persistIndex(fx);
  const result = await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  assert.equal(result.state, "evaluated");
  assert.equal(result.value.totals.epochsDiscovered, 0);
  assert.equal(result.value.totals.unknownEpochWalks, 0);
  assert.equal(result.value.totals.limitations.find((row) => row.kind === "capture-failure:screen-read-failed").occurrences, 1);
  assert.equal(
    result.value.totals.limitations.some((row) => row.kind === "inconsistent-declared-capture-counts"),
    false,
  );
});

test("strict reader kills a canonical totals mutation and missing index is not evaluated", async () => {
  const missing = fixture();
  const absent = await mod.stage.prepareVisualPerceptionWork(missing.env, missing.runId);
  assert.deepEqual(absent, {
    state: "not-evaluated",
    reason: "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
    detail:
      "the strict execution-walk artifact index is absent, so visual epoch coverage is unknown and no paid " +
      "visual request is authorized",
  });

  const fx = fixture();
  await addWalk(fx, { pathId: "path-count", attemptId: "attempt-count", epochs: [epoch()] });
  await persistIndex(fx);
  await mod.stage.prepareVisualPerceptionWork(fx.env, fx.runId);
  const key = mod.keys.visualManifestKey(fx.runId);
  const stored = JSON.parse(await (await fx.env.EVIDENCE.get(key)).text());
  stored.totals.eligibleEpochs += 1;
  await fx.env.EVIDENCE.put(key, canonicalize(stored));
  await assert.rejects(
    mod.visualWork.readVisualWorkManifest(fx.env.EVIDENCE, key),
    (error) =>
      error.name === "VisualWorkCorruptError" && error.message.includes("does not mechanically recompute"),
  );
});

test("unsharded capacity admits its exact bound and refuses the next denominator row before provider work", async () => {
  const makeIndex = (count) => mod.walkIndex.buildWalkArtifactIndex({
    runId: fixture().runId,
    planRevisionId: "plan_visual_capacity",
    walks: Array.from({ length: count }, (_, ordinal) => ({
      pathId: `path-capacity-${ordinal}`,
      attemptId: `attempt-capacity-${ordinal}`,
      at: at(ordinal % 60),
      caseIds: [],
    })),
    catalog: [],
  });
  const maximum = mod.visualWork.VISUAL_WORK_UNSHARDED_DENOMINATOR_LIMIT;
  const atLimit = await mod.visualWork.buildVisualWorkManifest(
    { EVIDENCE: memoryR2() },
    makeIndex(maximum),
    { maximumDenominatorItems: maximum },
  );
  assert.equal(atLimit.walks.length, maximum);
  assert.equal(atLimit.epochs.length, 0);
  assert.equal(atLimit.totals.unknownEpochWalks, maximum);

  await assert.rejects(
    mod.visualWork.buildVisualWorkManifest(
      { EVIDENCE: memoryR2() },
      makeIndex(maximum + 1),
      { maximumDenominatorItems: maximum },
    ),
    (error) =>
      error.name === "VisualWorkCapacityExceededError" &&
      error.observedLowerBound === maximum + 1 &&
      error.maximumDenominatorItems === maximum,
  );

  // Mutation proof: lowering the same bound by one must make the previously admitted fixture fail.
  await assert.rejects(
    mod.visualWork.buildVisualWorkManifest(
      { EVIDENCE: memoryR2() },
      makeIndex(maximum),
      { maximumDenominatorItems: maximum - 1 },
    ),
    (error) => error.name === "VisualWorkCapacityExceededError",
  );
});
