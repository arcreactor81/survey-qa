#!/usr/bin/env node
/**
 * EVIDENCE THAT THE WALKER ECONOMY GUARDS CAN FAIL.
 *
 *   node tools/mutate-walker-economy.mjs
 *
 * C1+C2 add two defences:
 *
 *   1. The stall watchdog MUST exist — removing it lets a wedged mid-walk page call eat the
 *      entire per-case budget, producing a steps=0 row from a walk that advanced 15 screens.
 *   2. The partial salvage MUST commit steps — zeroing the steps on a stalled walk rebuilds
 *      the original defect (19 zero-step rows burning ~285 minutes across five runs).
 *   3. The browser-death detection MUST exist — removing it lets a dead browser burn three
 *      paths as permanent zero-evidence rows in 1.2 seconds.
 *   4. The new outcome MUST NOT be bucketed as site-blocked — walk-stalled is infrastructure,
 *      and routing it to "blocked" would accuse the customer's survey.
 *
 * NOTHING IS WRITTEN TO `src/**`: `testkit.mjs#mutantPlugin` rewrites the source inside
 * esbuild's load step, so an interrupted run leaves the working copy untouched.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const DR = "src/browser/driver.ts";
const BATCH = "src/workflow/stages/execute-batch.ts";
const CONTRACTS = "src/types/contracts.ts";

const MUTANTS = [
  {
    name: "REMOVE THE STALL WATCHDOG: resolveWalkStallMs always returns the ceiling",
    breaks:
      "without the configurable stall window, operators cannot tune the watchdog for their " +
      "instrument, and the default/floor/ceiling resolution is dead code. The test pins the " +
      "default at 240s, the floor at 30s, and the ceiling at 600s.",
    file: BATCH,
    find: `export function resolveWalkStallMs(declared: string | undefined): number {
  const raw = num(declared, DEFAULT_WALK_STALL_MS);
  return Math.min(WALK_STALL_CEILING_MS, Math.max(WALK_STALL_FLOOR_MS, raw));
}`,
    replace: `export function resolveWalkStallMs(declared: string | undefined): number {
  return 600_000;
}`,
    kills: [
      "defaults to DEFAULT_WALK_STALL_MS when env is undefined",
    ],
  },
  {
    name: "SALVAGE DROPPED: walkRecord zeroes steps on walk-stalled outcome",
    breaks:
      "the partial observation commits steps=0 instead of carrying the steps recorded before " +
      "the stall — rebuilding the original defect where 19 walks burned 285 minutes as " +
      "steps=0 rows",
    file: BATCH,
    find: `    screensAdvanced: obs.steps.filter((s) => s.advanced).length,`,
    replace: `    screensAdvanced: obs.outcome === "walk-stalled" ? 0 : obs.steps.filter((s) => s.advanced).length,`,
    kills: [
      "walk-stalled observation with steps produces a valid WalkRecord",
    ],
  },
  {
    name: "BROWSER-DEATH DETECTION REMOVED: isBrowserDeathSignal always returns false",
    breaks:
      "without browser-death detection, a dead browser keeps feeding remaining paths to " +
      "the dead session — the v98 defect where three paths burned as zero-evidence rows",
    file: BATCH,
    find: `export function isBrowserDeathSignal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Protocol error[:\\s].*Connection closed/i.test(msg) ||
    /WebSocket is not open/i.test(msg) ||
    /browser has disconnected/i.test(msg) ||
    /detached frame/i.test(msg)
  );
}`,
    replace: `export function isBrowserDeathSignal(err: unknown): boolean {
  return false;
}`,
    kills: [
      "recognises 'Protocol error: Connection closed'",
    ],
  },
  {
    name: "WALK-STALLED MIS-BUCKETED AS SITE-BLOCKED",
    breaks:
      "walk-stalled is infrastructure — the walk froze, not the site. Routing it to " +
      "'blocked' would accuse the customer's survey of refusing the driver",
    file: CONTRACTS,
    find: `  return (SITE_REFUSAL_REASON_CODES as readonly string[]).includes(reason) ? "blocked" : "not-reached";`,
    replace: `  return (SITE_REFUSAL_REASON_CODES as readonly string[]).includes(reason) || reason === "walk-stalled" ? "blocked" : "not-reached";`,
    kills: [
      "unsettledBucketFor routes walk-stalled to not-reached",
    ],
  },
  // ---------------------------------------------------------------- PROPERTY 5
  // The capture diet must not suppress the "before" epoch — it is the verdict-bearing
  // capture that the judge spine reads. A mutant that skips BOTH the after-action AND
  // the before epoch would silently thin the evidence without a policy entry. The test
  // that pins the before epoch must newly fail.
  {
    name: "CAPTURE DIET OVER-APPLIED: before epoch is skipped alongside after-action",
    breaks:
      "the 'before' epoch is the judge spine's screen capture for each step. Skipping it " +
      "destroys the spine's seq-ordered capture chain and removes all step-level visual " +
      "evidence. The test that asserts at least one epoch per step must fail.",
    file: DR,
    find: `    const beforeCapture = recordEpoch(
      await timed(() => captureScreenEpoch(page, cap, before, "before", stepIndex, opts.viewport), (ms) => (phaseCaptureMs += ms)),
    );`,
    replace: `    const beforeCapture = /** @type {any} */ ({
      screenJson: { evidenceId: null, artifactRef: "", sourceEvidenceId: "", contentHash: "", mediaType: "application/json", size: 0, kind: "screen-json" },
      screenshot: { status: "failed", failure: { kind: "screenshot-capture-failed", detail: "mutant: silently dropped", count: 1, at: "", stepIndex, slot: "before" } },
      accessibility: { status: "failed", failure: { kind: "accessibility-snapshot-failed", detail: "mutant: silently dropped", count: 1, at: "", stepIndex, slot: "before" } },
      pdf: { status: "failed", failure: { kind: "pdf-capture-failed", detail: "mutant: silently dropped", count: 1, at: "", stepIndex, slot: "before" } },
      captureFailures: [], captureFailureCount: 0,
      epochId: "epoch_mutant", stepIndex, slot: "before",
      scope: { kind: "viewport", tileIndex: null, tileCount: null },
      startedAt: "", endedAt: "", screenReadAt: "", screenSignatureHash: "",
      geometry: { width: 0, height: 0, deviceScaleFactor: null, scrollX: null, scrollY: null, documentWidth: null, documentHeight: null, source: "configured-fallback" },
      kind: "v2-screen-capture-epoch/1.1.0",
    });`,
    kills: [
      "a terminal screen carries before/final PNG+AX refs at both step and walk scope",
    ],
  },
];

await runMutantSuite({
  title: "Walker economy — can the stall watchdog, browser-death guards, and capture diet fail?",
  filter: "",
  mutants: MUTANTS,
});
