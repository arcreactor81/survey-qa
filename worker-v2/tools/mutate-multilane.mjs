/**
 * EVIDENCE THAT THE MULTI-LANE EXECUTION GUARDS CAN FAIL.
 *
 * Each mutant re-opens one property — the lane cap, the stagger constant, the
 * flag-off default, wiring-level commit serialization, leftover accounting —
 * and the named test must go red for it.
 *
 *   node tools/mutate-multilane.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const ML = "src/workflow/stages/multilane.ts";
const EB = "src/workflow/stages/execute-batch.ts";

await runMutantSuite({
  title: "Multi-lane execution — can the guards fail?",
  filter: "multi-lane",
  mutants: [
    {
      name: "the lane cap is removed (allows unlimited concurrent browsers)",
      breaks:
        "the hard ceiling. Without the clamp EXEC_LANES=100 would open 100 " +
        "browsers against a 120-limit account, and the effectiveLaneCount test " +
        "asserts the clamp to LANE_CAP",
      file: ML,
      find: "  const effective = Math.min(Math.max(1, requested), LANE_CAP);",
      replace: "  const effective = Math.max(1, requested);",
      kills: [
        "lane cap clamp: EXEC_LANES=10 -> clamped to LANE_CAP (4)",
        "lane cap clamp: EXEC_LANES=100 -> clamped to LANE_CAP (4)",
      ],
    },
    {
      name: "the minimum clamp is removed (allows EXEC_LANES=0)",
      breaks:
        "the minimum floor. EXEC_LANES=0 would produce zero lanes and the " +
        "executor would walk nothing",
      file: ML,
      find: "  const effective = Math.min(Math.max(1, requested), LANE_CAP);",
      replace: "  const effective = Math.min(requested, LANE_CAP);",
      kills: [
        "lane cap clamp: EXEC_LANES=0 -> clamped to 1 (minimum)",
        "lane cap clamp: EXEC_LANES=-1 -> clamped to 1 (minimum)",
      ],
    },
    {
      name: "isMultiLane threshold is wrong (treats 1 lane as multi)",
      breaks:
        "flag-off equivalence. The sequential path must be byte-identical when " +
        "EXEC_LANES=1, and isMultiLane returning true would activate the " +
        "concurrent code path",
      file: ML,
      find: "  return effectiveLaneCount(env) > 1;",
      replace: "  return effectiveLaneCount(env) >= 1;",
      kills: [
        "flag-off: EXEC_LANES=1 -> isMultiLane is false",
        "flag-off: absent EXEC_LANES -> isMultiLane is false",
      ],
    },
    {
      name: "LANE_CAP constant changed to 8",
      breaks:
        "the documented ceiling. LANE_CAP is 4 and is verified by a pinned test",
      file: ML,
      find: "export const LANE_CAP = 4;",
      replace: "export const LANE_CAP = 8;",
      kills: [
        "LANE_CAP constant is 4",
      ],
    },
    {
      name: "LANE_STAGGER_MS dropped below the Cloudflare rate limit",
      breaks:
        "the stagger. LANE_STAGGER_MS must be >= 1500 to respect the 1-browser-" +
        "per-second launch rate limit with a safety margin",
      file: ML,
      find: "export const LANE_STAGGER_MS = 1500;",
      replace: "export const LANE_STAGGER_MS = 200;",
      kills: [
        "LANE_STAGGER_MS is at least 1500",
      ],
    },
    // ==================== WIRING MUTANTS ====================
    {
      name: "lane-count check inverted (multi-lane runs when EXEC_LANES=1)",
      breaks:
        "flag-off isolation. The multi-lane import must sit behind the lane " +
        "count check so EXEC_LANES=1 runs cannot be affected by a multi-lane " +
        "bug. Inverting the check activates multi-lane on single-lane config, " +
        "which attempts to acquire per-lane browsers instead of a shared session",
      file: EB,
      find: "  if (requestedLanes > 1 && !hasSeedWork) {",
      replace: "  if (requestedLanes <= 1 && !hasSeedWork) {",
      kills: [
        "flag-off proof: EXEC_LANES=1 executeBatch takes the sequential path, not the multi-lane path",
      ],
    },
    {
      name: "commit loop dropped (no walk records saved after wave)",
      breaks:
        "the sequential commit property. Without the commit loop, wave results " +
        "are discarded and no walkRecord is pushed to progress, so the two-lane " +
        "batch test sees zero walks",
      file: EB,
      find: "      // SEQUENTIAL COMMIT — each lane's result is applied one at a time so\n      // no two checkpoint writes interleave. This reproduces the exact\n      // ordering of the sequential path: walkRecord push, saveProgress,\n      // updateCheckpoint, cursor sync.\n      for (const result of results) {",
      replace: "      // SEQUENTIAL COMMIT — each lane's result is applied one at a time so\n      // no two checkpoint writes interleave. This reproduces the exact\n      // ordering of the sequential path: walkRecord push, saveProgress,\n      // updateCheckpoint, cursor sync.\n      for (const result of []) {",
      kills: [
        "EXEC_LANES=2: both walks recorded, commit ordering held, evidence names disjoint, stagger measured",
      ],
    },
    {
      name: "stagger removed from runLaneWave (all lanes launch simultaneously)",
      breaks:
        "the browser launch stagger. Without the stagger, all lanes launch at " +
        "the same millisecond, which violates the 1-browser-per-second rate limit",
      file: ML,
      find: "    if (i < items.length - 1) {\n      await new Promise((r) => setTimeout(r, LANE_STAGGER_MS));\n    }",
      replace: "    // stagger removed",
      kills: [
        "EXEC_LANES=2: both walks recorded, commit ordering held, evidence names disjoint, stagger measured",
      ],
    },
    {
      name: "leftover accounting dropped (remaining work silently lost)",
      breaks:
        "the leftover handback. Without computing remaining work after the " +
        "multi-lane loop, the function returns done=true even when work items " +
        "were skipped, and the run never revisits them",
      file: EB,
      find: "  // No shared session to retire — each lane retired its own browser.\n  // Clear cursor session for the next batch.\n  await updateCheckpoint(",
      replace: "  // No shared session to retire — each lane retired its own browser.\n  // Clear cursor session for the next batch.\n  return { done: true, stopReason: null, pathsWalked: 0, casesClosed: 0, steps: 0 };\n  await updateCheckpoint(",
      kills: [
        "EXEC_LANES=2: both walks recorded, commit ordering held, evidence names disjoint, stagger measured",
      ],
    },
  ],
});
