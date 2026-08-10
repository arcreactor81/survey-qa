/** Focused mutation proof for the durable visual terminal-limitation store. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";
import { cleanupBundle, memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-status-test-"));
const bundlePath = path.join(bundleDir, "visual-status.mjs");

await esbuild.build({
  entryPoints: [path.join(WORKER_ROOT, "src/store/visual-status.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const statusStore = await import(pathToFileURL(bundlePath).href);

after(() => {
  cleanupBundle();
  rmSync(bundleDir, { recursive: true, force: true });
});

const RUN_ID = "v2r_visual_terminal_status";
const PLAN_ID = "plan_visual_terminal_status";
const FINALIZED_AT = "2026-08-09T18:30:00.000Z";
const hash = (character) => character.repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function baseInput(overrides = {}) {
  return {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    finalizedAt: FINALIZED_AT,
    phase: "work-preparation",
    reason: "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
    detail: "The strict walk-artifact index is absent; visual coverage is unknown and no call was authorized.",
    ...overrides,
  };
}

async function putMalformedStatus(bucket, runId, value) {
  const bytes = Buffer.from(canonicalize(value));
  const contentSha256 = digest(bytes);
  const key = statusStore.visualTerminalStatusKey(runId, contentSha256);
  await bucket.put(key, bytes);
  return contentSha256;
}

test("phase and reason vocabularies are closed and every allowed pair is constructible", async () => {
  assert.deepEqual(statusStore.VISUAL_TERMINAL_PHASES, [
    "work-preparation",
    "rollout-initialization",
    "wave-orchestration",
    "coverage-finalization",
  ]);
  assert.deepEqual(statusStore.VISUAL_TERMINAL_REASONS, [
    "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
    "VISUAL_WORK_CAPACITY_EXCEEDED",
    "VISUAL_WORK_PREPARATION_FAILED",
    "VISUAL_ROLLOUT_INITIALIZATION_FAILED",
    "VISUAL_WAVE_ORCHESTRATION_FAILED",
    "VISUAL_COVERAGE_FINALIZATION_FAILED",
    "VISUAL_COVERAGE_LIMIT_EXCEEDED",
  ]);

  for (const reason of statusStore.VISUAL_TERMINAL_REASONS) {
    const prepared = await statusStore.prepareVisualTerminalStatus(baseInput({
      reason,
      phase: statusStore.VISUAL_TERMINAL_REASON_PHASE[reason],
    }));
    assert.equal(prepared.status.reason, reason);
  }

  await assert.rejects(
    statusStore.prepareVisualTerminalStatus(baseInput({
      phase: "coverage-finalization",
      reason: "VISUAL_WORK_PREPARATION_FAILED",
    })),
    (error) => error.name === "VisualTerminalStatusValidationError" && error.message.includes("belongs to"),
  );
  await assert.rejects(
    statusStore.prepareVisualTerminalStatus(baseInput({ reason: "VISUAL_UNKNOWN_REASON" })),
    (error) => error.name === "VisualTerminalStatusValidationError" && error.message.includes("must be one of"),
  );
  await assert.rejects(
    statusStore.prepareVisualTerminalStatus(baseInput({ detail: "authorization: Bearer should-not-be-stored" })),
    (error) =>
      error.name === "VisualTerminalStatusValidationError" && error.message.includes("pre-redacted"),
  );
});

test("exact replay reuses both immutable objects and resolves the fixed pointer", async () => {
  const bucket = memoryR2();
  const prepared = await statusStore.prepareVisualTerminalStatus(baseInput());

  const first = await statusStore.finalizeVisualTerminalStatus(bucket, prepared);
  assert.equal(first.statusWrite, "stored");
  assert.equal(first.pointerWrite, "stored");
  assert.equal(first.statusKey, statusStore.visualTerminalStatusKey(RUN_ID, prepared.contentSha256));
  assert.equal(first.pointerKey, statusStore.visualTerminalStatusPointerKey(RUN_ID));

  const replay = await statusStore.finalizeVisualTerminalStatus(bucket, structuredClone(prepared));
  assert.equal(replay.statusWrite, "reused");
  assert.equal(replay.pointerWrite, "reused");
  assert.deepEqual(replay.pointer, first.pointer);

  const resolved = await statusStore.readVisualTerminalStatusFromPointer(bucket, RUN_ID, {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    finalizedAt: FINALIZED_AT,
    phase: "work-preparation",
    reason: "VISUAL_WALK_ARTIFACT_INDEX_MISSING",
    workManifestSha256: null,
    coverageIndexSha256: null,
    inferenceFingerprintSha256: null,
    authorizationFingerprintSha256: null,
  });
  assert.deepEqual(resolved, { pointer: first.pointer, status: prepared.status });
  assert.equal(bucket._log.filter((row) => row.op === "put").length, 2, "replay must not rewrite either object");
});

test("optional references and fingerprints bind exact bytes, keys, run, and namespace", async () => {
  const bucket = memoryR2();
  const workBytes = Buffer.from(canonicalize({ kind: "test-work-manifest" }));
  const workSha256 = digest(workBytes);
  const workKey = `v2/runs/${RUN_ID}/visual/manifest.json`;
  const coverageBytes = Buffer.from(canonicalize({ kind: "test-coverage-index" }));
  const coverageSha256 = digest(coverageBytes);
  const coverageKey = `v2/runs/${RUN_ID}/visual/coverage/sha256/${coverageSha256}/index.json`;
  await bucket.put(workKey, workBytes);
  await bucket.put(coverageKey, coverageBytes);

  const prepared = await statusStore.prepareVisualTerminalStatus(baseInput({
    phase: "coverage-finalization",
    reason: "VISUAL_COVERAGE_FINALIZATION_FAILED",
    workManifest: { key: workKey, contentSha256: workSha256 },
    coverageIndex: { key: coverageKey, contentSha256: coverageSha256 },
    inferenceFingerprintSha256: hash("a"),
    authorizationFingerprintSha256: hash("b"),
  }));
  await statusStore.finalizeVisualTerminalStatus(bucket, prepared);
  const resolved = await statusStore.readVisualTerminalStatusFromPointer(bucket, RUN_ID, {
    workManifestSha256: workSha256,
    coverageIndexSha256: coverageSha256,
    inferenceFingerprintSha256: hash("a"),
    authorizationFingerprintSha256: hash("b"),
  });
  assert.equal(resolved.status.workManifest.contentSha256, workSha256);
  assert.equal(resolved.status.coverageIndex.contentSha256, coverageSha256);

  await assert.rejects(
    statusStore.prepareVisualTerminalStatus(baseInput({
      workManifest: { key: "runs/prod/visual/manifest.json", contentSha256: workSha256 },
    })),
    (error) => error.name === "VisualTerminalStatusValidationError" && error.message.includes("v2 namespace"),
  );
  await assert.rejects(
    statusStore.prepareVisualTerminalStatus(baseInput({
      workManifest: {
        key: `v2/runs/a-different-run/visual/manifest.json`,
        contentSha256: workSha256,
      },
    })),
    (error) => error.name === "VisualTerminalStatusValidationError" && error.message.includes("for this run"),
  );

  const missingRefBucket = memoryR2();
  const missingRef = await statusStore.prepareVisualTerminalStatus(baseInput({
    workManifest: { key: workKey, contentSha256: workSha256 },
  }));
  await assert.rejects(
    statusStore.finalizeVisualTerminalStatus(missingRefBucket, missingRef),
    (error) => error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("target is absent"),
  );
});

test("strict reader rejects omitted and unknown fields instead of accepting a shorter status", async () => {
  const prepared = await statusStore.prepareVisualTerminalStatus(baseInput());

  const omittedBucket = memoryR2();
  const omitted = structuredClone(prepared.status);
  delete omitted.detail;
  const omittedSha256 = await putMalformedStatus(omittedBucket, RUN_ID, omitted);
  await assert.rejects(
    statusStore.readVisualTerminalStatus(omittedBucket, RUN_ID, omittedSha256),
    (error) =>
      error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("must contain exactly"),
  );

  const unknownBucket = memoryR2();
  const unknown = { ...structuredClone(prepared.status), silentSuccess: true };
  const unknownSha256 = await putMalformedStatus(unknownBucket, RUN_ID, unknown);
  await assert.rejects(
    statusStore.readVisualTerminalStatus(unknownBucket, RUN_ID, unknownSha256),
    (error) =>
      error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("must contain exactly"),
  );

  const pointerSource = await statusStore.finalizeVisualTerminalStatus(memoryR2(), prepared);
  const omittedPointerBucket = memoryR2();
  const omittedPointer = structuredClone(pointerSource.pointer);
  delete omittedPointer.reason;
  await omittedPointerBucket.put(
    statusStore.visualTerminalStatusPointerKey(RUN_ID),
    canonicalize(omittedPointer),
  );
  await assert.rejects(
    statusStore.readVisualTerminalStatusPointer(omittedPointerBucket, RUN_ID),
    (error) =>
      error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("must contain exactly"),
  );

  const unknownPointerBucket = memoryR2();
  const unknownPointer = { ...structuredClone(pointerSource.pointer), passed: true };
  await unknownPointerBucket.put(
    statusStore.visualTerminalStatusPointerKey(RUN_ID),
    canonicalize(unknownPointer),
  );
  await assert.rejects(
    statusStore.readVisualTerminalStatusPointer(unknownPointerBucket, RUN_ID),
    (error) =>
      error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("must contain exactly"),
  );
});

test("hash and pointer-key mutations fail independently of schema validation", async () => {
  const prepared = await statusStore.prepareVisualTerminalStatus(baseInput());

  const hashBucket = memoryR2();
  const key = statusStore.visualTerminalStatusKey(RUN_ID, prepared.contentSha256);
  const altered = { ...structuredClone(prepared.status), detail: "A different but schema-valid terminal detail." };
  await hashBucket.put(key, canonicalize(altered));
  await assert.rejects(
    statusStore.readVisualTerminalStatus(hashBucket, RUN_ID, prepared.contentSha256),
    (error) => error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("key digest"),
  );

  const preparedHashMutation = structuredClone(prepared);
  preparedHashMutation.contentSha256 = hash("f");
  await assert.rejects(
    statusStore.finalizeVisualTerminalStatus(memoryR2(), preparedHashMutation),
    (error) => error.name === "VisualTerminalStatusValidationError" && error.message.includes("does not hash"),
  );

  const pointerBucket = memoryR2();
  const finalized = await statusStore.finalizeVisualTerminalStatus(pointerBucket, prepared);
  const mutatedPointer = structuredClone(finalized.pointer);
  mutatedPointer.status.key = statusStore.visualTerminalStatusKey("v2r_another_run", prepared.contentSha256);
  const pointerKey = statusStore.visualTerminalStatusPointerKey(RUN_ID);
  await pointerBucket.put(pointerKey, canonicalize(mutatedPointer));
  await assert.rejects(
    statusStore.readVisualTerminalStatusPointer(pointerBucket, RUN_ID),
    (error) =>
      error.name === "VisualTerminalStatusCorruptionError" && error.message.includes("for this run"),
  );
});

test("a differing retry cannot repoint the terminal status", async () => {
  const bucket = memoryR2();
  const original = await statusStore.prepareVisualTerminalStatus(baseInput());
  const first = await statusStore.finalizeVisualTerminalStatus(bucket, original);

  const divergent = await statusStore.prepareVisualTerminalStatus(baseInput({
    detail: "The same phase reached a materially different terminal explanation.",
  }));
  await assert.rejects(
    statusStore.finalizeVisualTerminalStatus(bucket, divergent),
    (error) =>
      error.name === "VisualTerminalStatusImmutabilityError" &&
      error.key === statusStore.visualTerminalStatusPointerKey(RUN_ID),
  );

  const stillOriginal = await statusStore.readVisualTerminalStatusFromPointer(bucket, RUN_ID);
  assert.equal(stillOriginal.pointer.status.contentSha256, first.contentSha256);
  assert.deepEqual(stillOriginal.status, original.status);
  assert.notEqual(first.contentSha256, divergent.contentSha256);
});
