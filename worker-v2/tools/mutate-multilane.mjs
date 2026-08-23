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
    // ==================== STAGE 0 RELIABILITY PORT MUTANTS ====================
    {
      name: "waveAbortFired always true (0b: hardAbortFired return inverted)",
      breaks:
        "the hardAbortFired return. With waveAbortFired always true, every " +
        "multi-lane batch returns hardAbortFired: true — even healthy batches " +
        "that completed normally. The test asserts that a normal batch does " +
        "NOT have hardAbortFired === true, so the inversion is detected",
      file: EB,
      find: "  let waveAbortFired = false;",
      replace: "  let waveAbortFired = true; // MUTANT: always fires",
      kills: [
        "executeMultiLaneBatch surfaces waveAbortFired as hardAbortFired on the BatchOutcome",
      ],
    },
    {
      name: "forwardReleaseMaxWaitMs threading removed from executeBatch (0c)",
      breaks:
        "the option threading. Without forwardReleaseMaxWaitMs in the " +
        "executeMultiLaneBatch call, the lane walks fall back to the driver's " +
        "code default instead of using the operator's environment override. " +
        "The test checks that executeBatch.toString() references " +
        "forwardReleaseMaxWaitMs at least twice (once in the sequential " +
        "walkOnce, once in the multilane threading). The mutation removes " +
        "the multilane reference, dropping the count to 1",
      file: EB,
      find: "      // THREADED WALK OPTIONS (0c): resolved once HERE, threaded to every\n      // wave and every lane inside it, exactly as the sequential path does.\n      // forwardReleaseMaxWaitMs: from EXEC_FORWARD_RELEASE_MAX_WAIT_MS, same\n      // env read as sequential walkOnce line ~1593.\n      forwardReleaseMaxWaitMs: num(\n        (env as unknown as { EXEC_FORWARD_RELEASE_MAX_WAIT_MS?: string }).EXEC_FORWARD_RELEASE_MAX_WAIT_MS,\n        FORWARD_RELEASE_MAX_WAIT_MS,\n      ),\n      // startupBudgetMs: already resolved above from EXEC_WALK_STARTUP_BUDGET_MS\n      // with floor/ceiling guard, same as the sequential path.\n      startupBudgetMs,",
      replace: "      // MUTANT: walk-option threading removed from multilane call",
      kills: [
        "forwardReleaseMaxWaitMs threaded from executeBatch to multilane waves",
      ],
    },
    {
      name: "wave handle registry nullified (0a: backstop cannot close handles)",
      breaks:
        "the wave zombie backstop's handle registry. With waveHandles set " +
        "to null, the registerBrowserHandle callback's push() call throws " +
        "a TypeError (null has no push method). Every lane that acquires a " +
        "browser crashes in registerBrowserHandle, producing error results " +
        "instead of walk completions. The live two-lane test fails because " +
        "it expects both walks to complete and close their cases",
      file: EB,
      find: "      const waveHandles: import(\"../browser-session\").SessionHandle[] = [];",
      replace: "      const waveHandles: any = null; // MUTANT: registry nullified",
      kills: [
        "EXEC_LANES=2: both walks recorded, commit ordering held, evidence names disjoint, stagger measured",
      ],
    },
    {
      name: "lane startup-budget determination removed (0c: neverStarted always false)",
      breaks:
        "the walk-never-started outcome. With neverStarted always false, a " +
        "lane whose screen read hangs is recorded as 'per-case-timeout' " +
        "instead of 'walk-never-started', and the one-retry-on-fresh-page " +
        "path is never taken. The test exercises walkLane with a hanging " +
        "fake browser and asserts outcome === 'walk-never-started' — the " +
        "mutation produces 'per-case-timeout' instead",
      // Re-anchored: inline expression was extracted to shared walkNeverStarted()
      // in execute-batch.ts; old anchor targeted the call site in multilane.ts
      // which no longer contains the logic inline.
      file: EB,
      find: "  return perCaseTimedOut && !startupPhases.includes(\"first-read\");",
      replace: "  return false; // MUTANT: startup-budget discrimination removed",
      kills: [
        "lane-level walk-never-started recorded with sub-phase and real wallMs",
      ],
    },
  ],
});
