/** Focused proof for the execution-walk -> PathObservation resolution index. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";
import { cleanupBundle, memoryR2 } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "walk-artifact-index-test-"));
const bundlePath = path.join(bundleDir, "walk-index.mjs");
const encoder = new TextEncoder();

await esbuild.build({
  entryPoints: [path.join(WORKER_ROOT, "src/store/walk-artifact-index.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const indexStore = await import(pathToFileURL(bundlePath).href);

after(() => {
  cleanupBundle();
  rmSync(bundleDir, { recursive: true, force: true });
});

const walk = (pathId, attemptId, ordinal, caseIds = []) => ({
  pathId,
  attemptId,
  at: `2026-08-09T12:00:${String(ordinal).padStart(2, "0")}.000Z`,
  caseIds,
});

const entry = (pathId, attemptId, suffix) => ({
  evidenceId: `ev_${suffix}`,
  sourceEvidenceId: `EV-${pathId}-observation`,
  artifactRef: `observations/${pathId}/${pathId}-observation-${suffix}.json`,
  contentHash: suffix.padEnd(64, "a").slice(0, 64),
  mediaType: "application/json",
  size: 321,
  type: "state",
  capturedAt: "2026-08-09T12:00:00.000Z",
  attemptId,
  routeId: pathId,
  witnesses: [],
});

function mixedFixture() {
  const walks = [
    walk("path-exact", "attempt-exact", 0, ["fi-exact"]),
    walk("path-legacy", "attempt-current", 1),
    walk("path-missing", "attempt-missing", 2, ["fi-missing"]),
    walk("path-ambiguous", "attempt-ambiguous", 3),
  ];
  const catalog = [
    entry("path-ambiguous", "attempt-ambiguous", "4"),
    entry("path-exact", "attempt-exact", "1"),
    entry("path-legacy", null, "2"),
    // Exact duplicate candidates. Catalogue order must not choose either.
    entry("path-ambiguous", "attempt-ambiguous", "3"),
  ];
  return { walks, catalog };
}

test("every execution walk is indexed and exact/legacy/missing/ambiguous totals recompute", () => {
  const { walks, catalog } = mixedFixture();
  const index = indexStore.buildWalkArtifactIndex({
    runId: "v2r_walk_index_test",
    planRevisionId: "plan_walk_index_test",
    walks,
    catalog,
  });

  assert.equal(index.rows.length, walks.length, "non-contributing walks must remain in the denominator");
  assert.deepEqual(index.rows.map((row) => row.state), ["exact", "legacy", "missing", "ambiguous"]);
  assert.equal(index.rows[0].selected.evidenceId, "ev_1");
  assert.equal(index.rows[1].selected.evidenceId, "ev_2");
  assert.equal(index.rows[2].selected, null);
  assert.equal(index.rows[3].selected, null);
  assert.deepEqual(index.rows[3].candidates.map((candidate) => candidate.evidenceId), ["ev_3", "ev_4"]);
  assert.deepEqual(index.totals, {
    walks: 4,
    contributingWalks: 2,
    exact: 1,
    legacy: 1,
    missing: 1,
    mismatched: 0,
    ambiguous: 1,
    uniquelyResolved: 2,
    unresolved: 2,
    candidateReferences: 4,
  });

  // Catalogue ordering is observationally irrelevant.
  const reversed = indexStore.buildWalkArtifactIndex({
    runId: index.runId,
    planRevisionId: index.planRevisionId,
    walks,
    catalog: [...catalog].reverse(),
  });
  assert.equal(canonicalize(reversed), canonicalize(index));
});

test("a sole artifact stamped for another attempt is mismatched, never legacy-selected", () => {
  const index = indexStore.buildWalkArtifactIndex({
    runId: "v2r_walk_index_mismatch",
    planRevisionId: "plan_walk_index_mismatch",
    walks: [walk("path-retried", "attempt-new", 0, ["fi-retried"])],
    catalog: [entry("path-retried", "attempt-old", "8")],
  });
  assert.equal(index.rows[0].state, "mismatched");
  assert.equal(index.rows[0].selected, null);
  assert.equal(index.totals.mismatched, 1);
  assert.equal(index.totals.unresolved, 1);
});

test("duplicate PathObservation candidates never reach a projected observation citation", async () => {
  const mod = await worker();
  const pathId = "path-duplicate";
  const attemptId = "attempt-duplicate";
  const candidates = [entry(pathId, attemptId, "5"), entry(pathId, attemptId, "6")];
  // Unrelated evidence from the same attempt remains available; only the ambiguous whole-walk
  // candidates are prohibited from leaking through the broad attempt evidence list.
  const unrelated = {
    ...entry("some-other-path", attemptId, "7"),
    evidenceId: "ev_unrelated",
    sourceEvidenceId: "EV-screen-before",
  };
  const progress = {
    kind: "v2-execution-progress/1.0.0",
    runId: "v2r_walk_projection_test",
    planRevisionId: "plan_walk_projection_test",
    walks: [{
      ...walk(pathId, attemptId, 0, ["fi-one"]),
      outcome: "completed",
      outcomeDetail: null,
      screensAdvanced: 1,
      steps: 1,
      exercised: true,
    }],
  };

  assert.equal(mod.projectObservations.findWalkArtifact(candidates, progress.walks[0]), null);
  const projected = await mod.projectObservations.observationsFromWalks(
    progress.runId,
    {},
    progress,
    [...candidates, unrelated],
  );
  assert.equal(projected.rows.length, 1);
  assert.equal(projected.withoutArtifact, 1);
  assert.equal(projected.rows[0].payload.observationEvidenceId, null);
  assert.deepEqual(projected.rows[0].evidenceIds, ["ev_unrelated"]);
  assert.equal(projected.rows[0].evidenceIds.includes("ev_5"), false);
  assert.equal(projected.rows[0].evidenceIds.includes("ev_6"), false);
});

test("immutable persistence reuses exact bytes and refuses a divergent index", async () => {
  const { walks, catalog } = mixedFixture();
  const bucket = memoryR2();
  const key = "v2/runs/v2r_walk_index_test/visual/walk-artifact-index.json";
  const index = indexStore.buildWalkArtifactIndex({
    runId: "v2r_walk_index_test",
    planRevisionId: "plan_walk_index_test",
    walks,
    catalog,
  });
  assert.equal(await indexStore.putWalkArtifactIndex(bucket, key, index), "stored");
  assert.equal(await indexStore.putWalkArtifactIndex(bucket, key, structuredClone(index)), "reused");
  assert.deepEqual(
    await indexStore.readWalkArtifactIndex(bucket, key, {
      runId: index.runId,
      planRevisionId: index.planRevisionId,
      walks: walks.length,
    }),
    index,
  );

  const divergent = indexStore.buildWalkArtifactIndex({
    runId: index.runId,
    planRevisionId: "plan_walk_index_changed",
    walks,
    catalog,
  });
  await assert.rejects(
    indexStore.putWalkArtifactIndex(bucket, key, divergent),
    (error) => error.name === "WalkArtifactIndexImmutableError",
  );
});

test("strict reader rejects corrupt JSON, unknown fields, and a self-consistent count mutation", async () => {
  const { walks, catalog } = mixedFixture();
  const key = "v2/runs/v2r_walk_index_corrupt/visual/walk-artifact-index.json";
  const index = indexStore.buildWalkArtifactIndex({
    runId: "v2r_walk_index_corrupt",
    planRevisionId: "plan_walk_index_corrupt",
    walks,
    catalog,
  });

  const malformedBucket = memoryR2();
  await malformedBucket.put(key, "{not-json");
  await assert.rejects(
    indexStore.readWalkArtifactIndex(malformedBucket, key),
    (error) => error.name === "WalkArtifactIndexCorruptError",
  );

  const unknownBucket = memoryR2();
  const unknown = structuredClone(index);
  unknown.rows[0].verdict = "pass";
  await unknownBucket.put(key, canonicalize(unknown));
  await assert.rejects(
    indexStore.readWalkArtifactIndex(unknownBucket, key),
    (error) => error.name === "WalkArtifactIndexCorruptError" && error.message.includes("unknown field"),
  );

  // Re-canonicalize after changing the count. This makes the test independent of the canonical
  // byte check and proves the mechanical denominator check itself can fail.
  const countBucket = memoryR2();
  const falseCount = structuredClone(index);
  falseCount.totals.missing += 1;
  await countBucket.put(key, canonicalize(falseCount));
  await assert.rejects(
    indexStore.readWalkArtifactIndex(countBucket, key),
    (error) => error.name === "WalkArtifactIndexCorruptError" && error.message.includes("mechanically recomputes"),
  );
});
