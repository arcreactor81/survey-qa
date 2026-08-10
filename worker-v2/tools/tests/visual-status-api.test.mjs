/** Focused endpoint proof for the observation-only visual child status surface. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { cleanupBundle } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-status-api-test-"));
const bundlePath = path.join(bundleDir, "visual-status-api.mjs");
const modulePath = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as launch from ${modulePath("src/store/visual-launch.ts")};`,
      `export * as work from ${modulePath("src/store/visual-work.ts")};`,
      `export * as coverage from ${modulePath("src/store/visual-coverage.ts")};`,
      `export * as terminal from ${modulePath("src/store/visual-status.ts")};`,
      `export * as hash from ${modulePath("src/store/hash.ts")};`,
      `export * as keys from ${modulePath("src/keys.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-status-api-entry.ts",
    loader: "ts",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const visual = await import(pathToFileURL(bundlePath).href);

after(() => {
  cleanupBundle();
  rmSync(bundleDir, { recursive: true, force: true });
});

const PLAN_ID = "plan_visual_status_api";
const AT = "2026-08-09T20:00:00.000Z";
const ROUTER_SOURCE = readFileSync(path.join(WORKER_ROOT, "src/api/router.ts"), "utf8");
const PROJECTION_SOURCE = readFileSync(path.join(WORKER_ROOT, "src/api/visual-status-projection.ts"), "utf8");

function engine(status = "running", error = undefined) {
  return {
    async get(id) {
      return {
        id,
        async status() {
          return { status, ...(error === undefined ? {} : { error }) };
        },
      };
    },
    async create() {},
    async createBatch() { return []; },
  };
}

async function fixture({ reportAvailable = true } = {}) {
  const mod = await worker();
  const env = testEnv({
    VISUAL_SHADOW_ENABLED: "false",
    V2_VISUAL_WORKFLOW: engine(),
  });
  const { runId } = await seedRun(mod, env);
  await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
    draft.ownership = { instanceId: runId, epoch: 0, claimedAt: AT };
    draft.execution = {
      batchIndex: 1,
      sessionId: null,
      sessionOpenedAt: null,
      pendingCaseIds: [],
      completedCaseIds: [],
      planRevisionId: PLAN_ID,
    };
    draft.reportAvailable = reportAvailable;
  });
  return { mod, env, runId, workflowInstanceId: `${runId}-visual-e0` };
}

async function response(fixtureValue, viaRouter = false) {
  const { mod, env, runId } = fixtureValue;
  const req = new Request(`https://worker.invalid/api/v2/runs/${runId}/visual-status`);
  return viaRouter
    ? mod.router.route(req, env)
    : mod.apiRuns.getVisualStatus(req, env, runId);
}

function markerExpected(value, state) {
  return {
    state,
    runId: value.runId,
    planRevisionId: PLAN_ID,
    workflowInstanceId: value.workflowInstanceId,
    ownership: { instanceId: value.runId, epoch: 0 },
  };
}

function minimalWork(runId) {
  const selected = {
    evidenceId: "ev_visual_status_walk",
    artifactRef: "observations/path-zero.json",
    contentHash: "1".repeat(64),
    mediaType: "application/json",
    sourceEvidenceId: "EV-path-zero-observation",
    attemptId: "attempt-zero",
    routeId: "path-zero",
    type: "state",
    size: 42,
  };
  const walks = [{
    walkOrdinal: 0,
    pathId: "path-zero",
    attemptId: "attempt-zero",
    indexState: "exact",
    walkIndexRowSha256: "2".repeat(64),
    selected,
    resolution: "verified",
    epochKnowledge: "known",
    epochCount: 0,
  }];
  return {
    schemaVersion: visual.work.VISUAL_WORK_MANIFEST_SCHEMA_VERSION,
    kind: "survey-qa-visual-work-manifest",
    runId,
    planRevisionId: PLAN_ID,
    walkArtifactIndexSha256: "3".repeat(64),
    walks,
    epochs: [],
    limitations: [],
    totals: visual.work.computeVisualWorkTotals(walks, [], [], walks.length),
  };
}

test("disabled run before the post-report launch is explicit and every visual store is not inspected", async () => {
  const value = await fixture({ reportAvailable: false });
  const res = await response(value);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();

  assert.equal(body.channel, "observation-only-non-verdict");
  assert.deepEqual(body.configuration, { state: "disabled" });
  assert.deepEqual(body.currentIdentity, { state: "unavailable", reason: "core-report-not-finalized" });
  for (const surface of ["launch", "childEngine", "work", "usage", "progress", "terminal", "coverage"]) {
    assert.deepEqual(body[surface], { state: "not-inspected", reason: "core-report-not-finalized" });
  }
});

test("accepted-never-started preserves both receipts and surfaces a child engine error", async () => {
  const value = await fixture();
  value.env.V2_VISUAL_WORKFLOW = engine("errored", { name: "Error", message: "child start step failed" });
  await visual.launch.writeVisualLaunchMarker(value.env.EVIDENCE, {
    ...markerExpected(value, "intent"),
    recordedAt: AT,
  });
  await visual.launch.writeVisualLaunchMarker(value.env.EVIDENCE, {
    ...markerExpected(value, "accepted"),
    recordedAt: "2026-08-09T20:00:01.000Z",
  });

  const res = await response(value, true);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.launch.state, "accepted-not-started");
  assert.equal(body.launch.markers.intent, AT);
  assert.equal(body.launch.markers.accepted, "2026-08-09T20:00:01.000Z");
  assert.equal(body.launch.markers.started, null);
  assert.equal(body.launch.markers.unresolved, null);
  assert.deepEqual(body.childEngine, { state: "available", status: "errored", errorReported: true });
  assert.equal(body.work.state, "absent");
  assert.equal(body.usage.state, "absent");
  assert.equal(body.progress.state, "not-inspected");
  assert.equal(body.terminal.state, "absent");
  assert.equal(body.coverage.state, "absent");
});

test("visual usage is projected from its own ledger and never folded into frozen core usage", async () => {
  const value = await fixture();
  const digest = "a".repeat(64);
  const identity = {
    eventId: `visual-model-call/sha256/${digest}`,
    callId: `visual-${digest.slice(-32)}`,
    inferenceCacheKey: `visual-inference/sha256/${digest}`,
  };
  const fence = { instanceId: value.runId, epoch: 0 };
  const coreBefore = await value.mod.checkpoint.loadCheckpoint(value.env, value.runId);
  await value.mod.usage.preflightVisualInferenceStrict(value.env, value.runId, fence, {
    callId: identity.callId,
    inferenceCacheKey: identity.inferenceCacheKey,
    provider: "fixture-vision-provider",
    model: "fixture-vision-model",
    maximumCostUsd: 0.01,
    maximumVisualCalls: 2,
    maximumVisualUsd: 0.02,
  });
  let body = await (await response(value)).json();
  assert.equal(body.usage.state, "available");
  assert.equal(body.usage.committedCalls, 0);
  assert.equal(body.usage.reservation.state, "active");
  assert.equal(body.usage.reservation.eventId, identity.eventId);

  await value.mod.usage.commitVisualUsageStrict(value.env, value.runId, fence, {
    ...identity,
    provider: "fixture-vision-provider",
    model: "fixture-vision-model",
    resultState: "observed",
    inputTokens: 10,
    outputTokens: 3,
    cost: { state: "known", usd: 0.004, source: "provider-reported" },
    at: "2026-08-09T20:00:03.000Z",
  });
  body = await (await response(value)).json();
  assert.equal(body.usage.committedCalls, 1);
  assert.equal(body.usage.knownCostUsd, 0.004);
  assert.deepEqual(body.usage.reservation, { state: "none" });
  const coreAfter = await value.mod.checkpoint.loadCheckpoint(value.env, value.runId);
  assert.equal(coreAfter.checkpoint.revision, coreBefore.checkpoint.revision);
  assert.equal(coreAfter.checkpoint.usage.modelCalls.used, 0);
});

test("started outranks unresolved without erasing the unresolved receipt", async () => {
  const value = await fixture();
  for (const [state, recordedAt] of [
    ["intent", AT],
    ["unresolved", "2026-08-09T20:00:01.000Z"],
    ["started", "2026-08-09T20:00:02.000Z"],
  ]) {
    await visual.launch.writeVisualLaunchMarker(value.env.EVIDENCE, {
      ...markerExpected(value, state),
      recordedAt,
    });
  }
  const body = await (await response(value)).json();
  assert.equal(body.launch.state, "started");
  assert.equal(body.launch.markers.unresolved, "2026-08-09T20:00:01.000Z");
  assert.equal(body.launch.markers.started, "2026-08-09T20:00:02.000Z");
});

test("a terminal limitation is resolved to its immutable target and returned as non-verdict status", async () => {
  const value = await fixture();
  const prepared = await visual.terminal.prepareVisualTerminalStatus({
    runId: value.runId,
    planRevisionId: PLAN_ID,
    finalizedAt: "2026-08-09T20:01:00.000Z",
    phase: "work-preparation",
    reason: "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
    detail: "The strict execution-walk artifact index is absent; visual coverage is unknown.",
  });
  const finalized = await visual.terminal.finalizeVisualTerminalStatus(value.env.EVIDENCE, prepared);

  const body = await (await response(value)).json();
  assert.equal(body.terminal.state, "limitation");
  assert.equal(body.terminal.reason, "VISUAL_WALK_ARTIFACT_INDEX_MISSING");
  assert.equal(body.terminal.statusRef.key, finalized.statusKey);
  assert.equal(body.coverage.state, "absent");
  assert.deepEqual(body.childEngine, { state: "not-queried", reason: "durable-result-present" });
});

test("corrupt finalized coverage fails loudly before an otherwise readable terminal can hide it", async () => {
  const value = await fixture();
  const prepared = await visual.terminal.prepareVisualTerminalStatus({
    runId: value.runId,
    planRevisionId: PLAN_ID,
    finalizedAt: "2026-08-09T20:02:00.000Z",
    phase: "work-preparation",
    reason: "VISUAL_WORK_PREPARATION_FAILED",
    detail: "Work preparation stopped at a named integrity boundary.",
  });
  await visual.terminal.finalizeVisualTerminalStatus(value.env.EVIDENCE, prepared);
  await value.env.EVIDENCE.put(visual.coverage.visualCoveragePointerKey(value.runId), "{}");

  const res = await response(value);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "VISUAL_STATUS_CORRUPT");
  assert.match(body.error.message, /visual coverage object/i);
});

test("complete coverage returns its exact closed denominator and totals", async () => {
  const value = await fixture();
  const manifest = await visual.work.validateVisualWorkManifest(minimalWork(value.runId));
  const workSha256 = await visual.hash.canonicalHash(manifest);
  await visual.work.putVisualWorkManifest(
    value.env.EVIDENCE,
    visual.keys.visualManifestKey(value.runId),
    manifest,
    { runId: value.runId, planRevisionId: PLAN_ID },
  );
  const inference = await visual.coverage.createDisabledVisualInferenceFingerprint({
    prompt: { version: "visual-status-prompt/1", sha256: "4".repeat(64) },
    responseSchema: { version: "visual-status-schema/1", sha256: "5".repeat(64) },
  });
  const authorization = {
    state: "disabled",
    rolloutConfigurationSha256: "6".repeat(64),
    maximumVisualCalls: 0,
    maximumVisualUsd: 0,
  };
  const inferenceFingerprintSha256 = await visual.coverage.visualInferenceFingerprintSha256(inference);
  const authorizationFingerprintSha256 = await visual.coverage.visualAuthorizationFingerprintSha256(authorization);
  const denominator = await visual.coverage.deriveVisualCoverageDenominator(manifest);
  assert.equal(denominator.length, 1, "known zero epochs must still have one counted denominator placeholder");
  const prepared = await visual.coverage.prepareVisualCoverageIndex({
    workManifest: manifest,
    visualWorkManifestSha256: workSha256,
    inference,
    authorization,
    finalizedAt: "2026-08-09T20:03:00.000Z",
    entries: denominator.map((item) => ({
      item,
      inferenceFingerprintSha256,
      authorizationFingerprintSha256,
      disposition: "input-ineligible",
      detail: "verified walk has no capture epochs",
      success: null,
    })),
  });
  const finalized = await visual.coverage.finalizeVisualCoverageIndex(value.env.EVIDENCE, prepared);

  const body = await (await response(value, true)).json();
  assert.equal(body.work.state, "available");
  assert.equal(body.work.denominatorItems, 1);
  assert.equal(body.coverage.state, "finalized");
  assert.equal(body.coverage.coverageRef.contentSha256, finalized.coverageSha256);
  assert.equal(body.coverage.totals.denominatorItems, 1);
  assert.equal(body.coverage.totals.noEpochWalkItems, 1);
  assert.equal(body.coverage.totals.limitationItems, 1);
  assert.deepEqual(body.progress, { state: "not-inspected", reason: "coverage-finalized" });
  assert.deepEqual(body.childEngine, { state: "not-queried", reason: "durable-result-present" });
});

test("receipt-order mutation is killed and the endpoint returns no partial projection", async () => {
  const value = await fixture();
  await visual.launch.writeVisualLaunchMarker(value.env.EVIDENCE, {
    ...markerExpected(value, "intent"),
    recordedAt: "2026-08-09T20:05:00.000Z",
  });
  await visual.launch.writeVisualLaunchMarker(value.env.EVIDENCE, {
    ...markerExpected(value, "accepted"),
    recordedAt: "2026-08-09T20:04:00.000Z",
  });
  const res = await response(value);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "VISUAL_STATUS_CORRUPT");
});

test("route and source ownership checks have mutations that genuinely fail", () => {
  const hasRoute = (source) =>
    source.includes('if (rest === "visual-status") return getVisualStatus(req, env, runId);');
  assert.equal(hasRoute(ROUTER_SOURCE), true);
  assert.equal(hasRoute(ROUTER_SOURCE.replace('rest === "visual-status"', 'rest === "visual-state"')), false);

  const importLines = PROJECTION_SOURCE.split(/\r?\n/).filter((line) => /^import\b/.test(line.trim())).join("\n");
  assert.doesNotMatch(importLines, /judg|verif|record|report/i, "status projection must not enter a verdict import graph");
  assert.doesNotMatch(PROJECTION_SOURCE, /EVIDENCE\.put\(/, "the GET projection must remain read-only");
});
