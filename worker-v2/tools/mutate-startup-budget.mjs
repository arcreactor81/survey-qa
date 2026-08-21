#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D58 TESTS CAN FAIL.
 *
 *   node tools/mutate-startup-budget.mjs
 *
 * D58 adds a STARTUP BUDGET: a wall-clock cap on the pre-first-step stretch (page creation,
 * survey goto, first screen read) so a dead browser costs ~2-4 minutes instead of 15 silent
 * minutes. Three properties are guarded:
 *
 *   1. The startup budget MUST exist — removing it lets a dead start eat the entire per-case
 *      budget again, and the outcomeDetail loses the sub-phase that hung.
 *   2. The retry MUST be bounded — removing the retry means a transient page-create failure
 *      has no recovery at all, and removing the bound means it can retry forever.
 *   3. The new outcome MUST NOT be bucketed as a site accusation — "walk-never-started" is
 *      infrastructure; routing it to "blocked" would rebuild the false-accusation defect
 *      resolveStopReason exists to close.
 *
 * NOTHING IS WRITTEN TO `src/**`: `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run leaves the working copy untouched.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const BATCH_FILE = "src/workflow/stages/execute-batch.ts";

const MUTANTS = [
  {
    name: "REMOVE THE STARTUP BUDGET: the walk-never-started outcome disappears",
    breaks:
      "without the startup budget, a walk that hangs during page-create/survey-load/first-read " +
      "is classified as per-case-timeout with wallMs=0 instead of walk-never-started with the " +
      "real elapsed time and the sub-phase that hung",
    file: BATCH_FILE,
    find: "const neverStarted = perCaseTimedOut && !startupPhases.includes(\"first-read\");",
    replace: "const neverStarted = false;",
    kills: [
      "walk-never-started observation produces a valid WalkRecord with real wallMs",
    ],
  },
  {
    name: "REMOVE THE RETRY BOUND: walk-never-started rows are never retried",
    breaks:
      "the startup retry gives a transient page-create failure one chance to recover on a " +
      "fresh page. Removing the retry block means every walk-never-started is final — a " +
      "single cold-start hiccup kills an entire path with no recovery",
    file: BATCH_FILE,
    find: "if (obs.outcome === \"walk-never-started\") {",
    replace: "if (false) {",
    kills: [
      "walk-never-started observation produces a valid WalkRecord with real wallMs",
    ],
  },
  {
    name: "MIS-BUCKET THE NEW OUTCOME: walk-never-started routes to blocked",
    breaks:
      "walk-never-started is infrastructure — we could not start, the site did not refuse us. " +
      "Routing it to 'blocked' would accuse the customer's survey of refusing the driver when " +
      "the driver never even reached it",
    file: "src/types/contracts.ts",
    find: "  return (SITE_REFUSAL_REASON_CODES as readonly string[]).includes(reason) ? \"blocked\" : \"not-reached\";",
    replace: "  return (SITE_REFUSAL_REASON_CODES as readonly string[]).includes(reason) || reason === \"walk-never-started\" ? \"blocked\" : \"not-reached\";",
    kills: [
      "unsettledBucketFor routes walk-never-started to not-reached",
    ],
  },
];

// The runner's inputs are `title` and `filter` (see mutate-runner.mjs#runMutantSuite);
// the first version of this call passed `name`/`testFile` — neither exists — and crashed
// on the banner write before any mutant ran. The release battery caught it: a campaign
// that has never executed is a guard that has never been tested.
await runMutantSuite({
  title: "D58 startup budget — can the walk-never-started guards fail?",
  // No filter: the guards live in execute-batch.ts and contracts.ts, which D31/D30/D11
  // also exercise; a baseline over only D58 would miss a mutation that reddens those.
  filter: "",
  mutants: MUTANTS,
});
