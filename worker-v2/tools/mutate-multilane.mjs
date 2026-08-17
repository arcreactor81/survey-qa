/**
 * EVIDENCE THAT THE MULTI-LANE EXECUTION GUARDS CAN FAIL.
 *
 * Each mutant re-opens one property — the lane cap, the stagger constant, the
 * flag-off default — and the named test must go red for it.
 *
 *   node tools/mutate-multilane.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const ML = "src/workflow/stages/multilane.ts";

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
  ],
});
