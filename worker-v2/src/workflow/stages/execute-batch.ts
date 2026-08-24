/**
 * PHASE: executing — one checkpointed batch of browser work.
 *
 * THE UNIT OF WORK IS A WALK, THE UNIT OF PROGRESS IS A PATH, AND THE UNIT OF THE
 * DENOMINATOR IS AN EXECUTION CASE. Those are three different things and conflating them
 * is how a run ends up reporting coverage it never had:
 *
 *   - a WALK drives the live survey once, from the first screen to a terminal screen;
 *   - a PATH is a planned walk; completing one closes every mandatory execution CASE the
 *     plan assigned to it, all at once, in a single durable write;
 *   - an EXECUTION CASE is a row of the sealed denominator. Nothing here can mint one.
 *     Exploration walks close no cases at all — by construction, not by convention — so
 *     the seven coverage buckets cannot move when exploration runs.
 *
 * WHY THE CHECKPOINT IS WRITTEN AFTER EVERY PATH, NOT AT THE END OF THE BATCH. A crash
 * mid-batch must cost at most one walk. Each batch launches a FRESH browser and closes it
 * at the end (line ~2472) — reuse across batches ended with the long-walk budgets
 * (2026-08-17) because sessions die at unpredictable ages (platform eviction/rollouts;
 * the once-measured "~11-minute wall" did NOT reproduce — A/B of 24 Aug 2026,
 * spikes/runtime-br/results/FINDINGS-ab-lifetime-20260824.md: 7/10 sessions exceeded
 * 45 min, 3/10 evicted at ~25-27 min), so a walk must never inherit an already-aged
 * session. The session id on the cursor is cleared to null at every batch boundary; it
 * exists within a batch only for the cold-start retry (acquireWithRetry) and the
 * sessionExpired guard.
 *
 * THE FIRST COLD REQUEST TO BROWSER RENDERING CAN THROW EDGE ERROR 1042. It is transient
 * and it is retried exactly once. It is not retried in a loop: a retry storm against a
 * remote browser costs real money and hides a real outage.
 */

import type { Env } from "../../types/env";
import { num } from "../../types/env";
import { k } from "../../keys";
import { mintAttemptId } from "../../ids";
import { beat, updateCheckpoint, type Fence } from "../../store/checkpoint";
import { canonicalHash, sha256Hex } from "../../store/hash";
import { getBoundCatalogEntry, getVerifiedEvidence } from "../../store/evidence";
import { browserUsage, pushUsage } from "../../store/usage";
import type { ExecutionCursor } from "../../types/contracts";
import {
  acquireSession,
  applySessionToCursor,
  retireSession,
  sessionExpired,
  type SessionHandle,
} from "../browser-session";
import {
  isExecutableProbePath,
  loadProgram,
  probeCapabilityLimitations,
  requiredProbeCapabilityLimitations,
  type ExecutionProgram,
  type PathAssignment,
} from "./plan";
import { walkPath, FORWARD_RELEASE_MAX_WAIT_MS, type PageLike } from "../../browser/driver";
import type { CaptureContext } from "../../browser/capture";
import type { PathObservation, StepObservation, WalkEnding } from "../../browser/types";
import type { PlannedPath, PlannedDecision } from "./planner/plan-core.js";
import type { SeedAlternative } from "./planner/seed-plan";
import {
  deriveCaseWitnessReceipt,
  storedCaseWitnessReceiptFailures,
  type CaseWitnessReceipt,
} from "./planner/seed-receipt";

export const execProgressKey = (runId: string) => k("runs", runId, "execution", "progress.json");

/**
 * How much of the per-case budget is reserved for walkPath to WRAP UP (classify the ending,
 * assemble the observation) after its step loop exits at the walk deadline. The floor in
 * `walkDeadlineFor` keeps a pathological config (grace >= budget) from zeroing walk time.
 */
export const PER_CASE_WRAPUP_GRACE_MS = 20_000;

/**
 * STARTUP BUDGET — the wall-clock cap on the stretch between "session acquired" and "first
 * step recorded".
 *
 * THE DEFECT THIS CLOSES. The 2026-08-16/17 runs recorded 27 walks as 0-screen "per-case-
 * timeout" or "error" rows with wallMs=0 and steps=0, burning ~15 minutes each before the
 * first step ever ran. Browser session ACQUISITION is already bounded and raced
 * (`acquireSession`, line 810-830: reconnect raced against fresh launch). The UNBUDGETED
 * stretch is everything between "session acquired" and "first step recorded": page creation,
 * the survey goto, the first screen read. This budget bounds that stretch.
 *
 * THREE SUB-PHASES ARE INSTRUMENTED so the outcomeDetail names which one hung:
 *   - `page-create`: `browser.newPage()` — tracked by the executor;
 *   - `survey-load`: `page.goto(surveyUrl)` — tracked by `walkPath` via `onStartupPhase`;
 *   - `first-read`: the first screen read in the step loop — also via `onStartupPhase`.
 *
 * When the budget expires the walk is recorded as outcome "walk-never-started" with the
 * measured wallMs (the REAL elapsed time, never 0) and ONE retry on a completely fresh
 * session. A dead start must cost ~2-4 minutes and produce a receipt, never 15 silent
 * minutes.
 *
 * DEFAULT 120_000ms (2 minutes): page creation + goto + one screen read finishes in <15s on
 * a healthy browser. 2 minutes allows for cold-start headroom without letting a dead browser
 * eat the batch budget. Injectable via EXEC_WALK_STARTUP_BUDGET_MS for operators who need
 * wider headroom on slow providers.
 */
export const DEFAULT_STARTUP_BUDGET_MS = 120_000;
const STARTUP_BUDGET_FLOOR_MS = 10_000;
const STARTUP_BUDGET_CEILING_MS = 600_000;

/**
 * Resolve the startup budget from the environment, floor/ceiling-guarded.
 *
 * Exported and pure for the same reason `resolveMaxStepsPerPath` is: the fallback is testable
 * as BEHAVIOUR. A guard that can only read the source file is a guard a mutation cannot kill.
 */
export function resolveStartupBudgetMs(declared: string | undefined): number {
  const raw = num(declared, DEFAULT_STARTUP_BUDGET_MS);
  return Math.min(STARTUP_BUDGET_CEILING_MS, Math.max(STARTUP_BUDGET_FLOOR_MS, raw));
}

/**
 * PER-WALK PROGRESS WATCHDOG — fires when a walk makes no forward progress for this many ms.
 *
 * THE DEFECT THIS CLOSES. Across five archived runs, 19 zero-step walks burned ~285 minutes.
 * Every one passed startup (page-create, survey-load, first-read all completed) and froze
 * mid-walk: a wedged page call blocks the step loop, the in-loop deadline check never runs
 * (it is INSIDE the blocked await chain), and only the 15-minute external per-case axe fires —
 * destroying the entire recording. A walk that advanced 15 screens and then stalled should
 * NEVER be a steps=0 row.
 *
 * THE WATCHDOG TIMER LADDER — three layers, each with a different job:
 *
 *   1. STALL WATCHDOG (this, ~4 min default): fires when NO STEP has completed for the
 *      configured window. Closes the PAGE (not the browser), which unblocks all pending
 *      page calls. The walk returns its partial observation with outcome "walk-stalled",
 *      all steps and captures committed. The browser stays alive for the next walk.
 *
 *   2. PER-CASE AXE (withTimeout, ~15 min): fires when the ENTIRE walk exceeds its time
 *      budget. Rejects the walkOnce promise. The observation is synthesized from the outside
 *      with outcome "per-case-timeout" and no steps. The STALL WATCHDOG fires first on any
 *      walk that is making no progress, so the axe only fires on a walk whose steps are
 *      individually long but each one completes (a legitimately slow survey).
 *
 *   3. HARD BATCH ABORT (setTimeout, batch budget + 2 min): fires when the entire batch
 *      hangs — typically because a dead browser's WebSocket has starved the event loop and
 *      prevented all setTimeout callbacks from dispatching. Closes the BROWSER. This is the
 *      last backstop, and it fires only when timers 1 and 2 themselves cannot dispatch.
 *
 * DEFAULT 240_000ms (4 minutes): a healthy step takes ~20-30s (measured phase clocks). 4 min
 * allows a step to fail and retry several times before the watchdog fires, while catching the
 * defect class where a page call simply never resolves. Injectable via EXEC_WALK_STALL_MS.
 */
export const DEFAULT_WALK_STALL_MS = 240_000;
const WALK_STALL_FLOOR_MS = 30_000;
const WALK_STALL_CEILING_MS = 600_000;

/**
 * Resolve the stall watchdog window from the environment, floor/ceiling-guarded.
 *
 * Exported and pure for the same reason `resolveStartupBudgetMs` is: the fallback is testable
 * as BEHAVIOUR, and a mutant that changes the default is killed by a pin test.
 */
export function resolveWalkStallMs(declared: string | undefined): number {
  const raw = num(declared, DEFAULT_WALK_STALL_MS);
  return Math.min(WALK_STALL_CEILING_MS, Math.max(WALK_STALL_FLOOR_MS, raw));
}

/**
 * IS THIS ERROR A BROWSER-DEATH SIGNAL?
 *
 * Conservatively enumerated from the ARCHIVED error strings in the two instrumented runs
 * where a dead browser burned three paths as permanent zero-evidence rows in 1.2 seconds
 * ("Protocol error: Connection closed" x3, 600ms apart, v98 walks 13-15).
 *
 * ONLY CONNECTION-LEVEL ERRORS ARE MATCHED — a page-level error ("Execution context was
 * destroyed", "Target closed") is a dead PAGE, not a dead BROWSER, and a new page might
 * still work. The caller (the batch loop) uses this to STOP feeding remaining paths to a
 * dead session: not error rows, just unwalked.
 *
 * Exported and pure so the determination is testable and mutable.
 */
export function isBrowserDeathSignal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Protocol error[:\s].*Connection closed/i.test(msg) ||
    /WebSocket is not open/i.test(msg) ||
    /browser has disconnected/i.test(msg) ||
    /detached frame/i.test(msg)
  );
}

/**
 * Which sub-phase of the startup the walk reached BEFORE it timed out. The executor
 * records timestamps at each transition (page-create → survey-load → first-read) and this
 * function returns the phase that HUNG — the one after the last completed phase.
 */
export type StartupSubPhase = "page-create" | "survey-load" | "first-read";

export function hungStartupPhase(
  completedPhases: StartupSubPhase[],
): StartupSubPhase {
  if (completedPhases.length === 0) return "page-create";
  const last = completedPhases[completedPhases.length - 1];
  if (last === "page-create") return "survey-load";
  if (last === "survey-load") return "first-read";
  // If first-read completed, the startup is done — this should never be called.
  // Defensive: return the last known phase.
  return "first-read";
}

/**
 * Did this walk never start?
 *
 * True when the per-case timeout fired AND the startup sub-phases never reached "first-read"
 * — the hang was in the pre-first-step stretch (page-create, survey-load, or the first screen
 * read itself) and the outcome is "walk-never-started", an infrastructure fact about THIS
 * attempt, not a site accusation.
 *
 * Exported and pure so:
 *   (a) both the sequential path (execute-batch.ts) and the multi-lane path (multilane.ts)
 *       call this ONE function — the two cannot drift;
 *   (b) the determination is testable as BEHAVIOUR, not by reading the source;
 *   (c) the mutation harness can target the body and kill it.
 */
export function walkNeverStarted(
  perCaseTimedOut: boolean,
  startupPhases: StartupSubPhase[],
): boolean {
  return perCaseTimedOut && !startupPhases.includes("first-read");
}

/**
 * How many CONSECUTIVE hard batch aborts stop the run. A single abort is recoverable (the
 * next batch gets a fresh browser); three in a row indicates a persistently broken browser
 * environment for this survey URL. The number is small on purpose: each abort burns a full
 * batch step (22 min step timeout × 4 attempts = 88 min worst-case per batch, per
 * run-workflow.ts BATCH_POLICY and wrangler.jsonc EXEC_BATCH_MAX_MS), and 3 × 88 = 264 min
 * of wasted platform time is enough to be certain the problem is structural.
 */
export const HARD_ABORT_CONSECUTIVE_CAP = 3;

/**
 * The wall-clock deadline handed to ONE walk. Strictly tighter than the per-case axe by the
 * wrap-up grace, so a walk that merely runs long exits its own step loop and RETURNS a
 * "time-cap" partial observation — steps recorded, ending classified, evidence kept — while
 * the withTimeout axe fires only on a genuine hang between deadline checks. The 2026-08-16/17
 * runs recorded 27 walks as 0-screen "per-case-timeout" rows with wallMs=0 and no evidence of
 * where they hung, because only the observation-destroying axe enforced the budget.
 */
export function walkDeadlineFor(
  batchDeadline: number,
  now: number,
  batchMaxMs: number,
  perCaseTimeoutMs: number,
  graceMs: number = PER_CASE_WRAPUP_GRACE_MS,
): number {
  const walkBudgetMs = Math.max(perCaseTimeoutMs - graceMs, Math.floor(perCaseTimeoutMs / 2));
  return Math.min(batchDeadline, now + batchMaxMs, now + walkBudgetMs);
}

// ---------------------------------------------------------------------------
// THE EXECUTOR'S STOP-REASON VOCABULARY — all of it, in one place.
//
// These strings are not decoration. `run-workflow.ts#phase-executing-close` writes whatever
// the executor returns into BOTH `phases[executing].reasonCode` and `completion.reasonCode`,
// and the report and the status endpoint print it verbatim. A stop reason is therefore a
// PUBLISHED CLAIM about why a run did not finish, and the executor is the only thing that
// knows enough to make it.
//
// They were four bare literals scattered through the function below until a run published
// `walks-blocked-by-site` about a survey that had blocked exactly nothing (see
// `resolveStopReason`). Naming them here makes the vocabulary enumerable — a test can assert
// the set, and a new code cannot be invented at a call site without appearing in it.
//
// THIS IS THE REGISTRY. There is no other: `run-workflow.ts` names the EXTRACTION phase's
// codes at its own top and derives everything else structurally (`stopBucket` /
// `stopCompletion` key off a `-cap` suffix), so an executor code belongs to the executor.
// ---------------------------------------------------------------------------

/** No execution program could be loaded for this run's plan revision. */
export const EXEC_STOP_PLAN_MISSING = "plan-missing";
/** Two consecutive failures to acquire a remote browser. An outage, not a blip. */
export const EXEC_STOP_BROWSER_UNAVAILABLE = "browser-unavailable";
/** The executor itself threw. The run stops rather than reporting partial work as whole. */
export const EXEC_STOP_EXECUTOR_ERROR = "executor-error";
/**
 * THE SITE REFUSED TO ADVANCE, ON EVIDENCE. Only emitted when some walk carries positive
 * blocking evidence — see `hasBlockingEvidence`. It is an accusation against a customer's
 * survey and it must never be published on the mere absence of coverage.
 */
export const EXEC_STOP_WALKS_BLOCKED_BY_SITE = "walks-blocked-by-site";
/**
 * OUR SHORTFALL, NOT THEIRS. Every planned walk was attempted, nothing blocked, and cases
 * are still owed an observation — because the walks that ran did not exercise what the plan
 * assigned them (an unbound stimulus, a walk that ended before reaching its question). That
 * is an internal coverage gap and it says so, instead of blaming the site for it.
 */
export const EXEC_STOP_COVERAGE_SHORTFALL = "coverage-shortfall-unexercised";
/** Required planned work uses an action vocabulary this executor cannot perform or prove. */
export const EXEC_STOP_REQUIRED_PROBE_UNSUPPORTED = "required-probe-capability-unsupported";
/**
 * THREE CONSECUTIVE BATCHES WERE TERMINATED BY THE HARD ABORT TIMER.
 *
 * A single hard abort is a RECOVERABLE zombie-browser condition: the next batch launches a
 * fresh browser and tries again. THREE in a row means the browser environment is persistently
 * broken for this run's survey URL, and continuing would burn batches on a target that cannot
 * be driven. The `-cap` suffix is deliberate: `stopCompletion` maps it to `partial-budget`
 * (an internal retry budget ran out), which is honest — the site is not accused, and the
 * reader can see that the system stopped because it exhausted its own resilience budget.
 */
export const EXEC_STOP_BROWSER_ABORT_CAP = "browser-abort-cap";

/**
 * HOW MANY SCREENS ONE WALK MAY VISIT, when the environment does not say.
 *
 * THE DEFECT THIS CLOSES. The code default was 40 while every deployed environment declares
 * 120 (`wrangler.jsonc` and the four arm configs, plus both canary config tools). 40 does NOT
 * clear this instrument — the measured full traversal is ~85-100 screens — so a deploy that
 * lost the variable would silently cap every deep walk, convert it to `outcome: "step-cap"`
 * and therefore `ending: stalled` (driver.ts), and the run would report walks that gave up
 * instead of walks that finished. A default that cannot do the job it is the default for is a
 * silent short, which CLAUDE.md forbids.
 *
 * THE VALUE IS THE DEPLOYED ONE, and `d56-walker-first-real-walk-fixes.test.mjs` asserts that
 * against the config files themselves, so the two cannot drift apart again unnoticed. It is a
 * fallback, not a policy: the environment still overrides it, and a missing var is logged.
 */
export const DEFAULT_MAX_STEPS_PER_PATH = 120;

/**
 * THE STEP CAP THIS ENVIRONMENT GIVES ONE WALK.
 *
 * Exported and pure so the fallback is testable AS BEHAVIOUR. A guard that can only read the
 * source file is a guard a mutation cannot kill — the mutant harness rewrites the module inside
 * esbuild's load step and never touches the disk — and a budget nothing can falsify is exactly
 * how a 40 that could not finish this survey survived beside a config that says 120.
 */
export function resolveMaxStepsPerPath(declared: string | undefined): number {
  return num(declared, DEFAULT_MAX_STEPS_PER_PATH);
}

/** The complete set. A code not in here is a bug, not a new feature. */
export const EXEC_STOP_REASONS = [
  EXEC_STOP_PLAN_MISSING,
  EXEC_STOP_BROWSER_UNAVAILABLE,
  EXEC_STOP_EXECUTOR_ERROR,
  EXEC_STOP_WALKS_BLOCKED_BY_SITE,
  EXEC_STOP_COVERAGE_SHORTFALL,
  EXEC_STOP_REQUIRED_PROBE_UNSUPPORTED,
  EXEC_STOP_BROWSER_ABORT_CAP,
] as const;

export interface WalkRecord {
  pathId: string;
  tier: 1 | 2;
  attemptId: string;
  outcome: string;
  outcomeDetail: string | null;
  steps: number;
  wallMs: number;
  shimmed: boolean;
  loadCrash: boolean;
  evidenceCount: number;
  /** Mandatory cases this walk CLOSED. Empty when the walk did not reach the end. */
  caseIds: string[];
  /** Why those cases closed, or did not: the audit trail for every coverage number. */
  exercised: boolean;
  plannedDecisions: number;
  matchedDecisions: number;
  /**
   * THE DENOMINATOR THE GATE ACTUALLY USES, and the numerator against it. `plannedDecisions`
   * counts everything the plan listed INCLUDING the ones it explicitly delegated to the
   * navigator; those constrain nothing, so they cannot be evidence of anything. See
   * `isConstrainingDecision`.
   *
   * Both are persisted because the only reason run v2r_01kzfb6py8pbxznqv022p2qkhb could be
   * re-adjudicated at all was that its counts were on disk. A gate whose inputs are not
   * recorded can only ever be argued about.
   */
  constrainingDecisions: number;
  matchedConstraining: number;
  screensAdvanced: number;
  /**
   * Steps carrying POSITIVE evidence that the site refused to advance. Optional on purpose:
   * records written before this field existed re-read without it and must degrade to "no
   * evidence" — never to an accusation. See `blockedStepCount`.
   */
  blockedSteps?: number;
  /**
   * ==================== WHAT THE WALKER TYPED, CARRIED VERBATIM ====================
   *
   * THE GAP THIS CLOSES. `browser/driver.ts` computes all of these on EVERY walk and writes
   * them into the `PathObservation` artifact; this function threw them away. The artifact is
   * one R2 object per walk, so anyone reading the run's own ledger — `progress.json`, and
   * through `assemble-record.ts#executionWalks` the derived blockers and attempts, and
   * through `project-observations.ts` the signed record's observation payloads — could see
   * `outcome` and nothing else. On run `v2r_01kzggtye653abaa36sxeg23yd` that meant 41
   * observations reporting `no-advance-control`, a value that covers BOTH "the survey ended"
   * and "we never got in", with the disambiguating field sitting unread in the artifact.
   *
   * THEY ARE COPIES, NOT FINDINGS. Nothing here re-derives, re-classifies or summarises: each
   * field is the walker's own value under the walker's own name, so a drift between the
   * producer and this ledger is impossible rather than merely unlikely. A consumer that has to
   * DECIDE something still re-reads the artifact bytes and re-hashes them
   * (`verify-observations.ts#decideObservation` takes only the artifact POINTER from a
   * projected payload); these exist so the ledger can be READ without that fan-out.
   *
   * EVERY ONE IS OPTIONAL AND STAYS OPTIONAL. A `progress.json` written before these existed
   * re-reads without them, and absence must degrade to "this walk did not say", never to a
   * value — the same contract `blockedSteps` argues for above. In particular an absent
   * `ending` is NOT a completion, and `unclassified` is NOT a completion either: it is the
   * walker's counted residual for "the final screen said nothing about which ending this was",
   * and collapsing it here would hand every downstream reader a confident wrong answer with
   * the producer's name on it.
   */
  ending?: WalkEnding;
  /**
   * BOUNDED SCREEN-OUT RETRY: present ONLY on a pivot walk — the re-walk of an attempt
   * that ended `screened-out` on navigator-default answers (see `screenoutRetryEligible`).
   * `retryOf` names the attemptId this walk re-walked, so each pivot links its OWN
   * predecessor and the chain reads attempt 0 -> pivot 1 -> pivot 2; `ordinal` is the
   * durable pivot number (1..SCREENOUT_PIVOT_CAP) and doubles as the driver's
   * deterministic filler variant; `reason` says why the pivot ran, in words. Carried by
   * its own conditional spread in `walkRecord()` like every other optional walk fact —
   * absent means "not a pivot", never a default.
   */
  pivot?: { retryOf: string; ordinal: number; reason: string };
  /** Planned decisions no screen was ever identified as — the walk's account of what it did NOT do. */
  unboundDecisions?: PathObservation["unboundDecisions"];
  /** How many times a screen was refused a binding. The walker's name for it, kept. */
  bindingRefusalCount?: number;
  /** Every limitation the reader named on any screen of this walk, with the step it came from. */
  readerLimitations?: PathObservation["readerLimitations"];
  /** Total occurrences summed over screens. Counted by the walker, not recomputed here. */
  readerLimitationCount?: number;
  at: string;
  /** Exact verified PathObservation catalogue identity; absent on legacy/projected rows. */
  observationEvidenceId?: string;
}

export interface ExecProgress {
  kind: "v2-execution-progress/1.0.0";
  runId: string;
  planRevisionId: string;
  walks: WalkRecord[];
  floorDone: string[];
  explorationDone: string[];
  seedDone?: string[];
  caseWitnessReceipts?: CaseWitnessReceipt[];
  seedReceiptRefusals?: Array<{ alternativeId: string; caseId: string; attemptId: string; reason: string }>;
  /** Set once a walk proves the site cannot load unshimmed. Later walks start shimmed. */
  shimRequired: boolean;
  /**
   * CONSECUTIVE HARD ABORT COUNT — tracked DURABLY so it survives step boundaries. A hard
   * abort fires when the batch's backstop timer kills a zombie browser; the next batch
   * launches a fresh browser and resets the counter on any successful walk. After
   * HARD_ABORT_CONSECUTIVE_CAP consecutive hard aborts the run stops with
   * `browser-abort-cap` — an honest internal-budget reason that does not accuse the site.
   * Absent on progress.json written before this field existed; absence means zero.
   */
  consecutiveHardAborts?: number;
  /** Paths whose browser hung. A path here has had its one retry on a fresh session. */
  hungPaths?: string[];
  /**
   * BOUNDED SCREEN-OUT RETRY: pivots consumed per path id. Incremented and SAVED before
   * each re-walk starts (durable-before-effect, the hungPaths pattern), so a Workflow
   * step replay re-derives the same ordinal and the same deterministic filler variant —
   * never a third walk the cap forbids. Additive like `hungPaths`: a progress.json from
   * before this field re-reads as zero pivots everywhere.
   */
  screenoutPivots?: Record<string, number>;
  shimEvidence: string | null;
  totalSteps: number;
  totalEvidence: number;
}

export interface SeedCommitArtifact {
  kind: "v2-seed-attempt-commit/1.0.0";
  artifactHash: string;
  receipt: CaseWitnessReceipt | null;
  refusal: string | null;
  observationEvidenceId: string;
  observation: PathObservation;
  walk: WalkRecord;
}

const seedCommitArtifactKey = (runId: string, attemptId: string): string =>
  k("runs", runId, "execution", "seed-attempts", `${attemptId}.json`);

async function verifiedPathObservation(
  env: Env,
  runId: string,
  expected: Pick<PathObservation, "attemptId" | "pathId" | "observationEvidenceId">,
): Promise<{ observation: PathObservation; evidenceId: string }> {
  if (!expected.observationEvidenceId) throw new Error("W5 observation evidence pointer is absent");
  const entry = await getBoundCatalogEntry(env, runId, expected.observationEvidenceId);
  if (!entry || entry.sourceEvidenceId !== `EV-${expected.pathId}-observation` ||
    entry.attemptId !== expected.attemptId || entry.routeId !== expected.pathId ||
    entry.type !== "state" || entry.mediaType !== "application/json") {
    throw new Error("W5 exact observation catalogue identity differs");
  }
  const verified = await getVerifiedEvidence(env, entry);
  const observation = JSON.parse(new TextDecoder().decode(verified.bytes)) as PathObservation;
  if (observation.attemptId !== expected.attemptId || observation.pathId !== expected.pathId) {
    throw new Error("W5 verified observation bytes differ from catalogue identity");
  }
  return { observation, evidenceId: entry.evidenceId };
}

export async function seedCommitArtifact(
  receipt: CaseWitnessReceipt | null,
  refusal: string | null,
  observationEvidenceId: string,
  observation: PathObservation,
  walk: WalkRecord,
): Promise<SeedCommitArtifact> {
  const body = { kind: "v2-seed-attempt-commit/1.0.0" as const, receipt, refusal, observationEvidenceId, observation, walk };
  return { ...body, artifactHash: `sha256:${await canonicalHash(body)}` };
}

export async function seedCommitArtifactFailures(
  env: Env,
  runId: string,
  artifact: SeedCommitArtifact,
  alternative: SeedAlternative,
): Promise<string[]> {
  if (!artifact || artifact.kind !== "v2-seed-attempt-commit/1.0.0") return ["seed commit artifact kind differs"];
  const body = { kind: artifact.kind, receipt: artifact.receipt, refusal: artifact.refusal, observationEvidenceId: artifact.observationEvidenceId, observation: artifact.observation, walk: artifact.walk };
  const failures = artifact.artifactHash === `sha256:${await canonicalHash(body)}` ? [] : ["seed commit artifact hash differs"];
  let retainedObservation: PathObservation | null = null;
  try {
    const observationEntry = await getBoundCatalogEntry(env, runId, artifact.observationEvidenceId);
    if (!observationEntry || observationEntry.sourceEvidenceId !== `EV-${alternative.alternativeId}-observation` ||
      observationEntry.attemptId !== artifact.observation.attemptId ||
      observationEntry.routeId !== alternative.alternativeId || observationEntry.type !== "state" ||
      observationEntry.mediaType !== "application/json") {
      failures.push("cited exact PathObservation catalogue identity differs");
    } else {
      try {
        const verified = await getVerifiedEvidence(env, observationEntry);
        retainedObservation = JSON.parse(new TextDecoder().decode(verified.bytes)) as PathObservation;
        if (await canonicalHash(retainedObservation) !== await canonicalHash(artifact.observation)) {
          failures.push("embedded observation differs from cited verified PathObservation bytes");
        }
      } catch {
        failures.push("cited PathObservation bytes are absent, corrupt, or unreadable");
      }
    }
  } catch {
    failures.push("cited exact PathObservation catalogue binding is absent or corrupt");
  }
  if (artifact.receipt && retainedObservation) {
    const targetStep = retainedObservation.steps.find((step) =>
      step.evidence.screenCaptures?.some((epoch) => epoch.screenJson.evidenceId === artifact.receipt!.beforeEvidenceId),
    );
    const required = [artifact.receipt.beforeEvidenceId, artifact.receipt.afterEvidenceId];
    for (const [index, evidenceId] of required.entries()) {
      let entry;
      try {
        entry = await getBoundCatalogEntry(env, runId, evidenceId);
      } catch {
        failures.push(`cited screen evidence ${evidenceId} binding is corrupt`);
        continue;
      }
      if (!entry || entry.attemptId !== artifact.observation.attemptId ||
        entry.routeId !== alternative.alternativeId || entry.type !== "dom-excerpt" ||
        entry.mediaType !== "application/json") {
        failures.push(`cited exact screen evidence ${evidenceId} identity differs`);
        continue;
      }
      const slot = index === 0 ? "before" : "after-action";
      const epoch = targetStep?.evidence.screenCaptures?.filter((row) => row.slot === slot && row.screenJson.evidenceId === evidenceId) ?? [];
      if (epoch.length !== 1) failures.push(`cited ${slot} screen epoch identity differs`);
      else {
        const ref = epoch[0]!.screenJson;
        if (entry.evidenceId !== ref.evidenceId || entry.sourceEvidenceId !== ref.sourceEvidenceId || entry.artifactRef !== ref.artifactRef ||
          entry.contentHash !== ref.contentHash || entry.mediaType !== ref.mediaType || entry.size !== ref.size) {
          failures.push(`cited ${slot} screen catalogue binding differs from epoch reference`);
        } else {
          try {
            const verifiedScreen = await getVerifiedEvidence(env, entry);
            const parsed = JSON.parse(new TextDecoder().decode(verifiedScreen.bytes)) as { screenSignature?: unknown };
            // captureScreenJsonRef retains the raw RenderedScreen. Epoch/step/slot are bound by
            // the canonical PathObservation and the full ScreenArtifactRef above; they are not
            // fields in those screen bytes. The retained screen itself binds to that epoch by
            // the same raw signature hash the capture producer records.
            if (typeof parsed.screenSignature !== "string" ||
              await sha256Hex(parsed.screenSignature) !== epoch[0]!.screenSignatureHash) {
              failures.push(`cited ${slot} RenderedScreen signature differs from capture epoch`);
            }
            const retainedScreen = slot === "before" ? targetStep?.screenBefore : targetStep?.screenAfterAction;
            if (!retainedScreen || await canonicalHash(parsed) !== await canonicalHash(retainedScreen)) {
              failures.push(`cited ${slot} RenderedScreen bytes differ from the retained step screen`);
            }
          } catch {
            failures.push(`cited ${slot} RenderedScreen bytes are absent, corrupt, or unreadable`);
          }
        }
      }
    }
  }
  const derived = retainedObservation
    ? await deriveCaseWitnessReceipt(alternative, retainedObservation, artifact.observationEvidenceId)
    : { ok: false as const, reason: "cited verified PathObservation is absent" };
  if (artifact.receipt) {
    if (!derived.ok || derived.receipt.receiptHash !== artifact.receipt.receiptHash) failures.push("receipt does not recompute from retained observation");
    failures.push(...await storedCaseWitnessReceiptFailures(artifact.receipt, alternative));
  } else if (derived.ok || artifact.refusal !== derived.reason) {
    failures.push("receipt refusal does not recompute from retained observation");
  }
  const audit = assessExercised(retainedObservation ?? artifact.observation, alternative.path.decisions as PlannedDecision[]);
  const expectedWalk = walkRecord(retainedObservation ?? artifact.observation, artifact.receipt ? [artifact.receipt.caseId] : [], audit, undefined, artifact.observationEvidenceId);
  if (JSON.stringify(artifact.walk) !== JSON.stringify(expectedWalk)) failures.push("committed walk does not recompute from retained observation");
  return failures;
}

const emptyProgress = (runId: string, planRevisionId: string): ExecProgress => ({
  kind: "v2-execution-progress/1.0.0",
  runId,
  planRevisionId,
  walks: [],
  floorDone: [],
  explorationDone: [],
  seedDone: [],
  caseWitnessReceipts: [],
  seedReceiptRefusals: [],
  shimRequired: false,
  shimEvidence: null,
  hungPaths: [],
  screenoutPivots: {},
  consecutiveHardAborts: 0,
  totalSteps: 0,
  totalEvidence: 0,
});

export class ExecutionProgressCorruption extends Error {
  constructor(detail: string) {
    super(`execution-progress-corrupt: ${detail}`);
    this.name = "ExecutionProgressCorruption";
  }
}

const progressCorrupt = (detail: string): never => {
  throw new ExecutionProgressCorruption(detail);
};

const progressObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) progressCorrupt(`${path} is not an object`);
  return value as Record<string, unknown>;
};

const progressStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || !value.every((row) => typeof row === "string")) {
    progressCorrupt(`${path} is not an array of strings`);
  }
  return value as string[];
};

const progressCount = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) progressCorrupt(`${path} is not a non-negative safe integer`);
  return Number(value);
};

/**
 * Decode the durable execution ledger without inventing an empty run over unreadable bytes.
 * Only an absent object means "not started". Once an object exists, identity, row counts and
 * aggregate totals are authority and every contradiction is named corruption.
 */
export function decodeProgress(value: unknown, runId: string, planRevisionId: string): ExecProgress {
  const root = progressObject(value, "$progress");
  if (root.kind !== "v2-execution-progress/1.0.0") progressCorrupt("$.kind differs");
  if (root.runId !== runId) progressCorrupt("$.runId differs from the requested run");
  if (root.planRevisionId !== planRevisionId) progressCorrupt("$.planRevisionId differs from the requested plan");
  if (!Array.isArray(root.walks)) progressCorrupt("$.walks is not an array");
  const walks = root.walks as unknown[];
  let summedSteps = 0;
  let summedEvidence = 0;
  for (let i = 0; i < walks.length; i += 1) {
    const walk = progressObject(walks[i], `$.walks[${i}]`);
    if (typeof walk.pathId !== "string" || walk.pathId.length === 0) progressCorrupt(`$.walks[${i}].pathId is absent`);
    if (typeof walk.attemptId !== "string" || walk.attemptId.length === 0) progressCorrupt(`$.walks[${i}].attemptId is absent`);
    if (walk.tier !== 1 && walk.tier !== 2) progressCorrupt(`$.walks[${i}].tier differs`);
    if (!Array.isArray(walk.caseIds) || !walk.caseIds.every((row) => typeof row === "string")) {
      progressCorrupt(`$.walks[${i}].caseIds is not an array of strings`);
    }
    summedSteps += progressCount(walk.steps, `$.walks[${i}].steps`);
    summedEvidence += progressCount(walk.evidenceCount, `$.walks[${i}].evidenceCount`);
  }
  progressStringArray(root.floorDone, "$.floorDone");
  progressStringArray(root.explorationDone, "$.explorationDone");
  if (root.seedDone !== undefined) progressStringArray(root.seedDone, "$.seedDone");
  if (root.hungPaths !== undefined) progressStringArray(root.hungPaths, "$.hungPaths");
  if (typeof root.shimRequired !== "boolean") progressCorrupt("$.shimRequired is not boolean");
  if (root.shimEvidence !== null && typeof root.shimEvidence !== "string") {
    progressCorrupt("$.shimEvidence is neither null nor a string");
  }
  const totalSteps = progressCount(root.totalSteps, "$.totalSteps");
  const totalEvidence = progressCount(root.totalEvidence, "$.totalEvidence");
  if (totalSteps !== summedSteps) progressCorrupt(`$.totalSteps=${totalSteps} but walk rows sum to ${summedSteps}`);
  if (totalEvidence !== summedEvidence) progressCorrupt(`$.totalEvidence=${totalEvidence} but walk rows sum to ${summedEvidence}`);
  if (root.screenoutPivots !== undefined) {
    const pivots = progressObject(root.screenoutPivots, "$.screenoutPivots");
    for (const [pathId, count] of Object.entries(pivots)) {
      if (pathId.length === 0) progressCorrupt("$.screenoutPivots has an empty path id");
      progressCount(count, `$.screenoutPivots[${JSON.stringify(pathId)}]`);
    }
  }
  // Additive like `screenoutPivots`: a progress.json from before this field re-reads as zero.
  if (root.consecutiveHardAborts !== undefined) {
    progressCount(root.consecutiveHardAborts, "$.consecutiveHardAborts");
  }
  return root as unknown as ExecProgress;
}

export async function loadProgress(env: Env, runId: string, planRevisionId: string): Promise<ExecProgress> {
  const obj = await env.EVIDENCE.get(execProgressKey(runId));
  if (!obj) return emptyProgress(runId, planRevisionId);
  let parsed: unknown;
  try {
    parsed = await obj.json();
  } catch (err) {
    progressCorrupt(`stored JSON cannot be decoded: ${String(err).slice(0, 160)}`);
  }
  return decodeProgress(parsed, runId, planRevisionId);
}

export async function saveProgress(env: Env, p: ExecProgress): Promise<void> {
  await env.EVIDENCE.put(execProgressKey(p.runId), JSON.stringify(p), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function reconcileSeedProgress(
  env: Env,
  program: ExecutionProgram,
  cursor: ExecutionCursor,
  progress: ExecProgress,
): Promise<boolean> {
  const before = JSON.stringify({
    seedDone: progress.seedDone, caseWitnessReceipts: progress.caseWitnessReceipts,
    seedReceiptRefusals: progress.seedReceiptRefusals, walks: progress.walks,
    totalSteps: progress.totalSteps, totalEvidence: progress.totalEvidence, hungPaths: progress.hungPaths,
  });
  const ledger = cursor.seedExecution;
  if (!program.seedPlan) return false;
  if (!ledger) throw new Error("W5 seed execution ledger is absent");
  progress.seedDone = [...ledger.doneAlternativeIds];
  const receipts: CaseWitnessReceipt[] = [];
  const refusals: ExecProgress["seedReceiptRefusals"] = [];
  const seedPathIds = new Set(program.seedPlan.alternatives.map((row) => row.alternativeId));
  const walks = progress.walks.filter((walk) => !seedPathIds.has(walk.pathId));
  const artifacts = new Map<string, SeedCommitArtifact>();
  for (const pointer of ledger.attempts) {
    const alternative = program.seedPlan.alternatives.find((row) => row.alternativeId === pointer.alternativeId);
    if (!alternative) throw new Error(`W5 attempt ${pointer.attemptId} names an unknown alternative`);
    const object = await env.EVIDENCE.get(pointer.artifactKey);
    if (!object) throw new Error(`W5 attempt artifact ${pointer.artifactKey} is absent`);
    const artifact = (await object.json()) as SeedCommitArtifact;
    const failures = await seedCommitArtifactFailures(env, program.runId, artifact, alternative);
    if (artifact.artifactHash !== pointer.artifactHash || artifact.observation.attemptId !== pointer.attemptId || failures.length > 0) {
      throw new Error(`W5 attempt ${pointer.attemptId} refused: ${failures.join("; ") || "pointer differs"}`);
    }
    artifacts.set(pointer.attemptId, artifact);
    walks.push(artifact.walk);
    if (artifact.refusal) refusals.push({
      alternativeId: pointer.alternativeId,
      caseId: alternative.certificate.facetInstanceId,
      attemptId: pointer.attemptId,
      reason: artifact.refusal,
    });
  }
  for (const pointer of ledger.receipts) {
    const artifact = artifacts.get(pointer.attemptId);
    const receipt = artifact?.receipt ?? null;
    if (!receipt || receipt.receiptHash !== pointer.receiptHash || receipt.caseId !== pointer.caseId ||
      artifact!.artifactHash !== pointer.commitArtifactHash) throw new Error(`W5 receipt pointer ${pointer.receiptHash} differs`);
    receipts.push(receipt);
  }
  progress.caseWitnessReceipts = receipts;
  progress.walks = walks;
  progress.seedReceiptRefusals = refusals;
  progress.totalSteps = walks.reduce((sum, walk) => sum + walk.steps, 0);
  progress.totalEvidence = walks.reduce((sum, walk) => sum + walk.evidenceCount, 0);
  progress.hungPaths = [...new Set([
    ...(progress.hungPaths ?? []).filter((pathId) => !seedPathIds.has(pathId)),
    ...walks.filter((walk) => seedPathIds.has(walk.pathId) && walk.outcome === "browser-hung").map((walk) => walk.pathId),
  ])];
  return before !== JSON.stringify({
    seedDone: progress.seedDone, caseWitnessReceipts: progress.caseWitnessReceipts,
    seedReceiptRefusals: progress.seedReceiptRefusals, walks: progress.walks,
    totalSteps: progress.totalSteps, totalEvidence: progress.totalEvidence, hungPaths: progress.hungPaths,
  });
}

async function recoverSeedReservation(
  env: Env,
  args: BatchArgs,
  program: ExecutionProgram,
  cursor: ExecutionCursor,
): Promise<ExecutionCursor> {
  const reservation = cursor.seedExecution?.reservation ?? null;
  if (!reservation) return cursor;
  const alternative = program.seedPlan?.alternatives.find((row) => row.alternativeId === reservation.alternativeId);
  if (!alternative) throw new Error(`W5 reservation ${reservation.attemptId} names an unknown alternative`);
  const artifactKey = seedCommitArtifactKey(args.runId, reservation.attemptId);
  const object = await env.EVIDENCE.get(artifactKey);
  const artifact = object ? (await object.json()) as SeedCommitArtifact : null;
  if (artifact) {
    const failures = await seedCommitArtifactFailures(env, args.runId, artifact, alternative);
    if (failures.length > 0) throw new Error(`W5 orphan artifact ${reservation.attemptId} refused: ${failures.join("; ")}`);
  }
  const updated = await updateCheckpoint(env, args.runId, (d) => {
    const execution = d.execution;
    const current = execution?.seedExecution?.reservation;
    if (!execution || !current || current.attemptId !== reservation.attemptId) return false;
    let closed: string[] = [];
    if (artifact) {
      const receipt = artifact.receipt;
      const result = applySeedAttemptCommit(execution, {
        alternativeId: alternative.alternativeId,
        expectedCaseId: alternative.certificate.facetInstanceId,
        expectedCertificateHash: alternative.certificate.certificateHash,
        attemptId: reservation.attemptId,
        retryable: false,
        attemptArtifact: { alternativeId: alternative.alternativeId, attemptId: reservation.attemptId, artifactHash: artifact.artifactHash, artifactKey },
        receipt: receipt ? {
          caseId: receipt.caseId, alternativeId: receipt.alternativeId, attemptId: receipt.attemptId,
          receiptHash: receipt.receiptHash, seedCertificateHash: receipt.seedCertificateHash,
          commitArtifactHash: artifact.artifactHash, artifactKey,
        } : null,
      });
      closed = result.closed;
    } else {
      retireSeedReservationWithoutArtifact(execution, reservation);
    }
    execution.pendingCaseIds = execution.pendingCaseIds.filter((id) => !closed.includes(id));
    execution.completedCaseIds.push(...closed);
    d.counts.pending = Math.max(0, d.counts.pending - closed.length);
    d.counts.exercised += closed.length;
    d.attempts.started += 1;
    if (artifact && artifact.observation.outcome !== "error") d.attempts.completed += 1;
    d.currentAttempt = null;
  }, { progressed: true, fence: args.fence });
  if (!updated?.execution) throw new Error(`W5 reservation ${reservation.attemptId} could not be retired`);
  return updated.execution;
}

export interface BatchArgs {
  runId: string;
  batch: number;
  fence: Fence;
  cursor: ExecutionCursor;
  surveyUrl: string;
  planRevisionId: string;
}

export interface BatchOutcome {
  done: boolean;
  stopReason: string | null;
  pathsWalked: number;
  casesClosed: number;
  steps: number;
  /**
   * Whether the batch's hard-abort backstop timer fired. Reported so the caller can track
   * CONSECUTIVE hard aborts across batches in the durable execution state. A single fire is
   * recoverable (the next batch gets a fresh browser); the caller bounds the retry budget.
   */
  hardAbortFired?: boolean;
}

export function applySeedAttemptCommit(
  cursor: ExecutionCursor,
  args: {
    alternativeId: string;
    expectedCaseId: string;
    expectedCertificateHash: string;
    attemptId: string;
    retryable: boolean;
    attemptArtifact: { alternativeId: string; attemptId: string; artifactHash: string; artifactKey: string };
    receipt: {
      caseId: string;
      alternativeId: string;
      attemptId: string;
      receiptHash: string;
      seedCertificateHash: string;
      commitArtifactHash: string;
      artifactKey: string;
    } | null;
  },
): { committed: boolean; closed: string[] } {
  const ledger = cursor.seedExecution;
  if (!ledger) throw new Error("W5 seed closure refused because the checkpoint ledger is absent");
  if (ledger.committedAttemptIds.includes(args.attemptId)) return { committed: false, closed: [] };
  if (args.attemptArtifact.alternativeId !== args.alternativeId || args.attemptArtifact.attemptId !== args.attemptId) {
    throw new Error("W5 seed attempt artifact identity differs");
  }
  if (args.receipt && (
    args.receipt.caseId !== args.expectedCaseId || args.receipt.seedCertificateHash !== args.expectedCertificateHash ||
    args.receipt.alternativeId !== args.alternativeId ||
    args.receipt.attemptId !== args.attemptId || args.receipt.commitArtifactHash !== args.attemptArtifact.artifactHash ||
    args.receipt.artifactKey !== args.attemptArtifact.artifactKey
  )) throw new Error("W5 seed receipt pointer differs from selected case or attempt artifact");
  if (!ledger.reservation || ledger.reservation.alternativeId !== args.alternativeId || ledger.reservation.attemptId !== args.attemptId) {
    throw new Error("W5 seed closure refused because its pre-effect reservation differs");
  }
  ledger.committedAttemptIds.push(args.attemptId);
  ledger.reservation = null;
  ledger.attempts.push(args.attemptArtifact);
  if (!args.retryable && !ledger.doneAlternativeIds.includes(args.alternativeId)) {
    ledger.doneAlternativeIds.push(args.alternativeId);
  }
  if (!args.receipt || ledger.receipts.some((row) => row.caseId === args.receipt!.caseId)) {
    return { committed: true, closed: [] };
  }
  if (!cursor.pendingCaseIds.includes(args.receipt.caseId)) return { committed: true, closed: [] };
  ledger.receipts.push(args.receipt);
  return { committed: true, closed: [args.receipt.caseId] };
}

export function retireSeedReservationWithoutArtifact(
  cursor: ExecutionCursor,
  reservation: { alternativeId: string; attemptId: string },
): void {
  const ledger = cursor.seedExecution;
  if (!ledger || !ledger.reservation || ledger.reservation.alternativeId !== reservation.alternativeId ||
    ledger.reservation.attemptId !== reservation.attemptId) {
    throw new Error("W5 orphan retirement refused because its reservation differs");
  }
  ledger.reservation = null;
  if (!ledger.committedAttemptIds.includes(reservation.attemptId)) ledger.committedAttemptIds.push(reservation.attemptId);
  if (!ledger.doneAlternativeIds.includes(reservation.alternativeId)) ledger.doneAlternativeIds.push(reservation.alternativeId);
  ledger.refusals.push({
    alternativeId: reservation.alternativeId,
    attemptId: reservation.attemptId,
    reason: "pre-effect reservation had no immutable attempt artifact; retired without re-actuation or coverage credit",
  });
}

/** Acquire a browser session, retrying the known transient cold-start failure ONCE. */
/**
 * A REMOTE BROWSER CAN HANG, AND A HANG IS NOT AN ERROR — which is what makes it
 * dangerous. Reconnecting to a session whose previous holder died mid-flight does not
 * throw; it simply never resolves, and without a bound the batch sits there until the
 * Workflow step's five-minute timeout fires, gets retried once, and hangs again. A run
 * that is doing nothing must not be indistinguishable from a run that is working, so
 * every remote browser call this module makes is bounded and a timeout is a first-class,
 * named outcome.
 */
export class BrowserTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`browser: ${what} did not resolve within ${ms}ms`);
    this.name = "BrowserTimeout";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BrowserTimeout(what, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Reconnect, or launch fresh. Handles the two known ways this fails:
 *   - the first cold request can throw edge error 1042 (transient — retry ONCE, never in
 *     a loop: a retry storm against a remote browser costs real money and hides an outage);
 *   - a reconnect to a wedged session never returns at all, so it is raced against a
 *     timeout and the fallback is a FRESH browser rather than the same wedged one.
 */
export async function acquireWithRetry(env: Env, cursor: ExecutionCursor | null, timeoutMs: number): Promise<SessionHandle> {
  try {
    return await withTimeout(acquireSession(env, cursor), timeoutMs, "session acquire");
  } catch (err) {
    console.log(`v2 exec: browser acquire failed (${String(err).slice(0, 200)}); relaunching fresh, once`);
    await new Promise((r) => setTimeout(r, 2000));
    return await withTimeout(
      acquireSession(env, { ...(cursor ?? emptyCursor()), sessionId: null, sessionOpenedAt: null }),
      timeoutMs,
      "fresh session launch",
    );
  }
}

export const emptyCursor = (): ExecutionCursor => ({
  batchIndex: 0,
  sessionId: null,
  sessionOpenedAt: null,
  pendingCaseIds: [],
  completedCaseIds: [],
  planRevisionId: null,
});

export interface WorkItem {
  path: PlannedPath;
  tier: 1 | 2;
  assignment: PathAssignment | null;
  seedAlternative: SeedAlternative | null;
}

/**
 * A single closed reason for the run-level outcome; exact path/code counts remain in the plan
 * limitations and signed record blockers. Exported so the stop decision is directly testable
 * without acquiring a browser merely to discover that no browser action is possible.
 */
export function requiredProbeCapabilityStopReason(program: ExecutionProgram): string | null {
  return requiredProbeCapabilityLimitations(probeCapabilityLimitations(program.plan)).length > 0
    ? EXEC_STOP_REQUIRED_PROBE_UNSUPPORTED
    : null;
}

/** What is still owed: floor paths first, then as much exploration as the caps allow. */
export function selectWork(program: ExecutionProgram, progress: ExecProgress, maxExploration: number): WorkItem[] {
  const out: WorkItem[] = [];
  const floorDone = new Set(progress.floorDone);
  let pendingFloor = 0;
  for (const a of program.floor) {
    const p = program.plan.floor.paths.find((x) => x.id === a.pathId);
    if (!p) continue;
    // A legacy executor may already have written one of these ids to `floorDone` without
    // consuming its sibling probe action. No action receipt exists, so that marker is not
    // evidence and cannot grandfather the path into completion.
    const executable = isExecutableProbePath(p);
    if (floorDone.has(a.pathId) && executable) continue;
    pendingFloor += 1;
    if (!executable) continue;
    out.push({ path: p, tier: 1, assignment: a, seedAlternative: null });
  }
  // FLOOR FIRST, ALWAYS. An unsupported floor path is still pending contractual work; do not
  // run optional exploration past it and make the run look further along than it is.
  if (pendingFloor > 0) return out;

  const seedDone = new Set(progress.seedDone ?? []);
  for (const alternative of program.seedPlan?.alternatives ?? []) {
    if (seedDone.has(alternative.alternativeId)) continue;
    out.push({ path: alternative.path, tier: 2, assignment: null, seedAlternative: alternative });
  }
  // Selected seeds are denominator-directed work. Finish them before optional risk probes.
  if (out.length > 0) return out;

  const expDone = new Set(progress.explorationDone);
  // Old `explorationDone` rows for unsupported instructions prove only that one forward walk
  // ran. They consume no executable-work budget and never suppress the named limitation.
  const completedExecutable = program.plan.exploration.queue.filter(
    (entry) => expDone.has(entry.id) && isExecutableProbePath(entry),
  ).length;
  const budget = Math.max(0, maxExploration - completedExecutable);
  if (budget === 0) return out;
  for (const e of program.plan.exploration.queue) {
    if (expDone.has(e.id)) continue;
    if (!isExecutableProbePath(e)) continue;
    out.push({ path: e as unknown as PlannedPath, tier: 2, assignment: null, seedAlternative: null });
    if (out.length >= budget) break;
  }
  return out;
}

/**
 * MULTI-LANE BATCH — walks independent items in parallel waves, commits
 * results one at a time. Called only when effectiveLaneCount > 1 and no
 * seed work is in the queue. Screen-out pivots run AFTER each wave in the
 * existing sequential pivot loop with the identical-actions stop intact.
 *
 * WAVE-LEVEL ZOMBIE BACKSTOP (0a): a timer at (batchMaxMs + 120_000) force-
 * closes every lane's browser when a wave hangs. Each lane REGISTERS its
 * live browser handle into a wave-level registry (via the registerBrowserHandle
 * callback threaded through runLaneWave), and the backstop force-closes all
 * registered handles and marks waveAbortFired. This mirrors the sequential
 * path's hard batch abort timer (execute-batch.ts ~1438-1472).
 *
 * WHY A WAVE-LEVEL BACKSTOP AND NOT A BATCH-LEVEL ONE. The sequential path
 * has one browser for the whole batch, so one timer suffices. Multi-lane has
 * one browser PER LANE PER WAVE — a batch-level timer that fires between
 * waves would try to close browsers that were already retired, while a
 * wave-level timer scopes its handle set exactly to the wave in flight.
 */
async function executeMultiLaneBatch(
  env: Env,
  args: BatchArgs,
  program: ExecutionProgram,
  progress: ExecProgress,
  work: WorkItem[],
  opts: {
    batchDeadline: number;
    batchMaxMs: number;
    maxAttempts: number;
    maxSteps: number;
    advanceTimeoutMs: number;
    allowShim: boolean;
    acquireTimeoutMs: number;
    perCaseTimeoutMs: number;
    maxExploration: number;
    requiredProbeStop: string | null;
    lanes: number;
    multilane: typeof import("./multilane");
    /**
     * FORWARD RELEASE MAX WAIT (0c): the ceiling on waiting for a withheld
     * forward control to open. Resolved once by the caller (executeBatch)
     * from EXEC_FORWARD_RELEASE_MAX_WAIT_MS exactly as the sequential path
     * does, so every lane in every wave uses the same resolved value.
     */
    forwardReleaseMaxWaitMs: number;
    /**
     * STARTUP BUDGET (0c): wall-clock cap on the pre-first-step stretch,
     * resolved once by the caller from EXEC_WALK_STARTUP_BUDGET_MS exactly
     * as the sequential path does. Each lane gets its own startupPhases
     * tracker and its own walk-never-started determination.
     */
    startupBudgetMs: number;
    /**
     * STALL WATCHDOG (0c): wall-clock window after which a walk with no step
     * progress is abandoned. Resolved once by the caller from EXEC_WALK_STALL_MS.
     */
    walkStallMs: number;
  },
): Promise<BatchOutcome> {
  const {
    batchDeadline, batchMaxMs, maxAttempts, maxSteps, advanceTimeoutMs,
    allowShim, acquireTimeoutMs, perCaseTimeoutMs, maxExploration,
    requiredProbeStop, lanes, multilane, forwardReleaseMaxWaitMs,
    startupBudgetMs,
    // walkStallMs is carried on the opts type so the multilane module can consume it when it
    // adds its own stall watchdog; destructured to a void reference here to keep the type in
    // sync without a TS6133 warning. The sequential path resolves its own walkStallMs from
    // the same env var and threads it through walkOnce directly.
  } = opts;
  void opts.walkStallMs;
  // WAVE RESIDUAL MATH (0e): the minimum batch budget remaining before starting
  // a new wave. The sequential path uses `perCaseTimeoutMs` as the floor — a walk
  // that cannot run for at least that long has no chance of completing.
  //
  // DESIGN CHOICE: the startup budget does NOT tighten this bound further. The
  // startup budget is a SUB-BUDGET within the per-case timeout, not additive —
  // a walk's startup is PART of its per-case budget, not on top of it. If we
  // required (perCaseTimeoutMs + startupBudgetMs) remaining, we would refuse to
  // start waves that have enough time for a full walk. The per-case timeout alone
  // is the right floor because it is the total time one walk can consume, startup
  // included.
  const minBatchResidualMs = perCaseTimeoutMs;
  const seededCaseIds = new Set((program.seedPlan?.alternatives ?? []).map((row) => row.caseId));

  let pathsWalked = 0;
  let casesClosed = 0;
  let steps = 0;
  let stopReason: string | null = null;
  // WAVE ZOMBIE BACKSTOP (0a/0b): tracks whether any wave's backstop timer fired.
  // Returned as `hardAbortFired` so the caller (run-workflow.ts) can track
  // consecutive hard aborts across batches in the durable execution state.
  let waveAbortFired = false;

  console.log(
    `v2 exec batch ${args.batch}: multi-lane enabled, ${lanes} concurrent lanes`,
  );

  try {
    let workIndex = 0;
    while (workIndex < work.length) {
      if (pathsWalked >= maxAttempts || Date.now() >= batchDeadline) break;

      const remainingBudgetMs = batchDeadline - Date.now();
      if (remainingBudgetMs < minBatchResidualMs) {
        console.log(
          `v2 exec batch ${args.batch}: only ${remainingBudgetMs}ms remains, ` +
            `below the ${minBatchResidualMs}ms minimum residual — ending wave`,
        );
        break;
      }

      const waveSize = Math.min(
        lanes,
        work.length - workIndex,
        maxAttempts - pathsWalked,
      );
      const waveItems = work.slice(workIndex, workIndex + waveSize);
      workIndex += waveSize;

      // WAVE VISIBILITY (0d): the pre-wave beat already lists lane path ids.
      // DESIGN CHOICE: we do NOT fake a per-lane currentAttempt on the checkpoint
      // because currentAttempt is a scalar field that the sequential path sets to
      // ONE walk at a time. Writing multiple concurrent values to it would either
      // interleave checkpoint writes (which the wiring contract forbids) or show
      // only the last lane written (misleading). The beat message below is the
      // visibility mechanism for waves: it lists all path ids in the wave, and the
      // post-wave sequential commit sets currentAttempt=null for each lane result.
      // There is no existing batch-level note field on the checkpoint to attach
      // wave path ids to; adding one would change the checkpoint schema for a
      // dark-mode feature. The beat is sufficient and honest.
      await beat(
        env,
        args.runId,
        `batch ${args.batch}: walking ${waveItems.length} lanes ` +
          `[${waveItems.map((item) => item.path.id).join(", ")}]`,
        `${args.batch}:wave:${workIndex}`,
      );

      // WAVE-LEVEL ZOMBIE BACKSTOP (0a): a timer at (batchMaxMs + 120_000) that
      // force-closes every lane's browser when a wave hangs. Each lane registers
      // its handle via the callback, and the backstop iterates the registry.
      // Budget mirrors the sequential path: batchMaxMs + 2 minutes headroom.
      const waveHandles: import("../browser-session").SessionHandle[] = [];
      const hardWaveAbortMs = batchMaxMs + 120_000;
      const waveAbortTimer = setTimeout(() => {
        waveAbortFired = true;
        console.error(
          `v2 exec batch ${args.batch}: WAVE ZOMBIE BACKSTOP after ${hardWaveAbortMs}ms — ` +
            `force-closing ${waveHandles.length} lane browser(s) to unblock pending operations`,
        );
        for (const h of waveHandles) {
          try {
            h.browser.close();
          } catch {
            /* best-effort close — the browser may already be dead */
          }
        }
      }, hardWaveAbortMs);

      const registerBrowserHandle = (handle: import("../browser-session").SessionHandle) => {
        waveHandles.push(handle);
      };

      let results: import("./multilane").LaneResult[];
      try {
        results = await multilane.runLaneWave(env, waveItems, {
          runId: args.runId,
          batch: args.batch,
          planRevisionId: args.planRevisionId,
          surveyUrl: args.surveyUrl,
          fence: args.fence,
          batchDeadline,
          batchMaxMs,
          perCaseTimeoutMs,
          maxSteps,
          advanceTimeoutMs,
          shimRequired: progress.shimRequired,
          allowShim,
          acquireTimeoutMs,
          program,
          progress,
          // THREADED WALK OPTIONS (0c): forwardReleaseMaxWaitMs and startupBudgetMs
          // are resolved once by the caller (executeBatch) and threaded through
          // runLaneWave to each lane, exactly as the sequential path does.
          forwardReleaseMaxWaitMs,
          startupBudgetMs,
          // WAVE ZOMBIE BACKSTOP (0a): the registration callback. Each lane calls
          // this after acquiring its browser, so the backstop can force-close it.
          registerBrowserHandle,
        });
      } finally {
        // Disarm the wave backstop — the wave completed (or failed). If it already
        // fired, waveAbortFired is set and the walk loop will break on the
        // batchDeadline check.
        clearTimeout(waveAbortTimer);
      }

      // SEQUENTIAL COMMIT — each lane's result is applied one at a time so
      // no two checkpoint writes interleave. This reproduces the exact
      // ordering of the sequential path: walkRecord push, saveProgress,
      // updateCheckpoint, cursor sync.
      for (const result of results) {
        const obs = result.obs;
        const item = result.item;

        // Usage events collected during the lane (review fix A: pushed here,
        // not from inside the concurrent lane).
        if (result.usageEvents.length > 0) {
          await pushUsage(env, args.runId, args.fence, result.usageEvents);
        }

        // Shim detection — same as sequential path
        if (obs.outcome === "load-crash" && !obs.shimmed) {
          progress.shimRequired = true;
          progress.shimEvidence = obs.evidenceIds[0] ?? null;
        }

        const audit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);
        const standardClosed =
          item.assignment && audit.exercised
            ? item.assignment.caseIds.filter(
                (id) => !seededCaseIds.has(id) && !args.cursor.completedCaseIds.includes(id),
              )
            : [];
        const walkedOk = obs.outcome !== "error";

        progress.hungPaths = progress.hungPaths ?? [];
        const alreadyHung = progress.hungPaths.includes(item.path.id);
        if (result.browserHung && !alreadyHung) {
          progress.hungPaths.push(item.path.id);
        }
        const retryable = result.browserHung && !alreadyHung;

        if (!retryable) {
          if (item.tier === 1 && !progress.floorDone.includes(item.path.id)) {
            progress.floorDone.push(item.path.id);
          } else if (item.tier !== 1 && !progress.explorationDone.includes(item.path.id)) {
            progress.explorationDone.push(item.path.id);
          }
        }
        progress.walks.push(walkRecord(obs, standardClosed, audit));
        progress.totalSteps += obs.steps.length;
        progress.totalEvidence += obs.evidenceIds.length;
        await saveProgress(env, progress);

        let closed: string[] = [];
        let committed = false;
        await updateCheckpoint(
          env,
          args.runId,
          (d) => {
            const c = d.execution;
            if (!c) return false;
            closed = standardClosed.filter((id) => c.pendingCaseIds.includes(id));
            const next: ExecutionCursor = {
              ...c,
              batchIndex: args.batch + 1,
              pendingCaseIds: c.pendingCaseIds.filter((id) => !closed.includes(id)),
              completedCaseIds: [...c.completedCaseIds, ...closed],
              sessionId: null,
              sessionOpenedAt: null,
            };
            d.execution = next;
            d.counts.pending = Math.max(0, d.counts.pending - closed.length);
            d.counts.exercised += closed.length;
            d.attempts.started += 1;
            if (walkedOk) d.attempts.completed += 1;
            d.currentAttempt = null;
            committed = true;
            return true;
          },
          { progressed: true, fence: args.fence },
        );

        if (committed) {
          args.cursor.completedCaseIds = [...args.cursor.completedCaseIds, ...closed];
          args.cursor.pendingCaseIds = args.cursor.pendingCaseIds.filter((id) => !closed.includes(id));
        }
        pathsWalked += 1;
        casesClosed += closed.length;
        steps += obs.steps.length;
      }

      // PIVOTS — run sequentially after the wave, with the identical-actions
      // stop intact. Each lane's result is considered for pivot eligibility.
      for (const result of results) {
        const item = result.item;
        let obs = result.obs;
        let pivotParentActions = walkActionsJson(obs);
        while (
          screenoutRetryEligible({
            obs,
            path: item.path,
            pivots: progress.screenoutPivots,
            pathsWalked,
            maxAttempts,
            now: Date.now(),
            batchDeadline,
          })
        ) {
          const ordinal = (progress.screenoutPivots?.[item.path.id] ?? 0) + 1;
          progress.screenoutPivots = { ...(progress.screenoutPivots ?? {}), [item.path.id]: ordinal };
          await saveProgress(env, progress);

          const pivot = {
            retryOf: obs.attemptId,
            ordinal,
            reason:
              `attempt ${obs.attemptId} ended screened-out with ` +
              `${obs.navigatorDefaultAnswerCount ?? 0} navigator-default answer(s) — ` +
              `re-walking with deterministic filler variant ${ordinal}`,
          };
          const lastStepIndex = Math.floor(Number(obs.steps[obs.steps.length - 1]?.stepIndex ?? 0));
          const pivotFromStep = Math.max(0, lastStepIndex - 1);

          await beat(
            env,
            args.runId,
            `batch ${args.batch}: ${item.path.id} screened out on invented answers — re-walking with varied fillers (pivot ${ordinal})`,
            `${args.batch}:${item.path.id}:pivot${ordinal}`,
          );

          const pivotResults = await multilane.runLaneWave(env, [item], {
            runId: args.runId,
            batch: args.batch,
            planRevisionId: args.planRevisionId,
            surveyUrl: args.surveyUrl,
            fence: args.fence,
            batchDeadline,
            batchMaxMs,
            perCaseTimeoutMs,
            maxSteps,
            advanceTimeoutMs,
            shimRequired: progress.shimRequired,
            allowShim,
            acquireTimeoutMs,
            program,
            progress,
            variant: ordinal,
            variantFromStep: pivotFromStep,
            // THREADED WALK OPTIONS (0c): pivots also get the resolved values so
            // their lane walks use the same forward-release and startup budgets.
            forwardReleaseMaxWaitMs,
            startupBudgetMs,
          });
          const pivotResult = pivotResults[0]!;
          obs = pivotResult.obs;

          if (pivotResult.usageEvents.length > 0) {
            await pushUsage(env, args.runId, args.fence, pivotResult.usageEvents);
          }

          const retryAudit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);
          const retryClosed =
            item.assignment && retryAudit.exercised
              ? item.assignment.caseIds.filter(
                  (id) => !seededCaseIds.has(id) && !args.cursor.completedCaseIds.includes(id),
                )
              : [];
          const retryWalkedOk = obs.outcome !== "error";

          progress.walks.push(walkRecord(obs, retryClosed, retryAudit, pivot));
          progress.totalSteps += obs.steps.length;
          progress.totalEvidence += obs.evidenceIds.length;
          if (pivotResult.browserHung) {
            progress.hungPaths = progress.hungPaths ?? [];
            if (!progress.hungPaths.includes(item.path.id)) progress.hungPaths.push(item.path.id);
          }
          await saveProgress(env, progress);

          await updateCheckpoint(
            env,
            args.runId,
            (d) => {
              const c = d.execution;
              if (!c) return false;
              const next: ExecutionCursor = {
                ...c,
                batchIndex: args.batch + 1,
                pendingCaseIds: c.pendingCaseIds.filter((id) => !retryClosed.includes(id)),
                completedCaseIds: [...c.completedCaseIds, ...retryClosed],
                sessionId: null,
                sessionOpenedAt: null,
              };
              d.execution = next;
              d.counts.pending = Math.max(0, d.counts.pending - retryClosed.length);
              d.counts.exercised += retryClosed.length;
              d.attempts.started += 1;
              if (retryWalkedOk) d.attempts.completed += 1;
              d.currentAttempt = null;
              return true;
            },
            { progressed: true, fence: args.fence },
          );
          args.cursor.completedCaseIds = [...args.cursor.completedCaseIds, ...retryClosed];
          args.cursor.pendingCaseIds = args.cursor.pendingCaseIds.filter((id) => !retryClosed.includes(id));

          pathsWalked += 1;
          casesClosed += retryClosed.length;
          steps += obs.steps.length;

          if (pivotResult.browserHung) break;

          const pivotActions = walkActionsJson(obs);
          if (pivotActions === pivotParentActions) {
            await beat(
              env,
              args.runId,
              `batch ${args.batch}: ${item.path.id} pivot ${ordinal} reproduced the prior attempt's actions exactly — ` +
                `the varied-filler lever cannot change this route (its fatal answers are plan-pinned); ` +
                `stopping retries, document authority needed`,
              `${args.batch}:${item.path.id}:pivot-identical`,
            );
            break;
          }
          pivotParentActions = pivotActions;
        }
      }
    }
  } catch (err) {
    console.error(`v2 exec batch ${args.batch}: executor error`, err);
    stopReason = EXEC_STOP_EXECUTOR_ERROR;
  }

  // No shared session to retire — each lane retired its own browser.
  // Clear cursor session for the next batch.
  await updateCheckpoint(
    env,
    args.runId,
    (d) => {
      if (!d.execution) return false;
      d.execution = { ...d.execution, sessionId: null, sessionOpenedAt: null };
      return true;
    },
    { fence: args.fence },
  );

  const remaining = selectWork(program, progress, maxExploration).length;
  if (stopReason === null && remaining === 0 && requiredProbeStop !== null) {
    stopReason = requiredProbeStop;
  }
  const done = remaining === 0 || stopReason !== null;
  stopReason = resolveStopReason({
    done,
    pendingCases: args.cursor.pendingCaseIds.length,
    stopReason,
    walks: progress.walks,
  });
  // RETURN hardAbortFired (0b): the wave abort flag is surfaced to the caller so
  // run-workflow.ts can track consecutive hard aborts across batches in the durable
  // execution state. A single fire is recoverable; the caller bounds the retry budget.
  return { done, stopReason, pathsWalked, casesClosed, steps, ...(waveAbortFired ? { hardAbortFired: true } : {}) };
}

/**
 * Run one batch. Reconnect → walk up to N paths inside a wall-clock budget → disconnect
 * (NOT close). Every path commits its own checkpoint before the next one starts.
 */
export async function executeBatch(env: Env, args: BatchArgs): Promise<BatchOutcome> {
  const program = await loadProgram(env, args.runId, args.planRevisionId);
  if (!program) {
    return { done: true, stopReason: EXEC_STOP_PLAN_MISSING, pathsWalked: 0, casesClosed: 0, steps: 0 };
  }
  const progress = await loadProgress(env, args.runId, args.planRevisionId);
  args.cursor = await recoverSeedReservation(env, args, program, args.cursor);
  if (await reconcileSeedProgress(env, program, args.cursor, progress)) await saveProgress(env, progress);

  const maxExploration = num((env as unknown as { EXEC_MAX_EXPLORATION?: string }).EXEC_MAX_EXPLORATION, 0);
  const work = selectWork(program, progress, maxExploration);
  const requiredProbeStop = requiredProbeCapabilityStopReason(program);
  console.log(
    `v2 exec batch ${args.batch}: work=${work.length} floorDone=${progress.floorDone.length}/${program.floor.length} ` +
      `expDone=${progress.explorationDone.length} expBudget=${maxExploration} queue=${program.plan.exploration.queue.length}`,
  );
  if (work.length === 0) {
    return {
      done: true,
      stopReason: requiredProbeStop,
      pathsWalked: 0,
      casesClosed: 0,
      steps: 0,
    };
  }

  const batchDeadline = Date.now() + num(env.EXEC_BATCH_MAX_MS, 120_000);
  const maxAttempts = num(env.EXEC_BATCH_MAX_ATTEMPTS, 4);
  const declaredMaxSteps = (env as unknown as { EXEC_MAX_STEPS_PER_PATH?: string }).EXEC_MAX_STEPS_PER_PATH;
  if (declaredMaxSteps === undefined) {
    // NAMED, NOT SILENT (CLAUDE.md: detect when an assumption does not hold and report it).
    // The fallback below is only ever reached in an environment that lost the var, and the
    // consequence — every deep walk capped and typed `stalled` — is invisible in the output.
    console.log(
      `v2 exec batch ${args.batch}: EXEC_MAX_STEPS_PER_PATH is not set in this environment; ` +
        `falling back to the code default ${DEFAULT_MAX_STEPS_PER_PATH}`,
    );
  }
  const maxSteps = resolveMaxStepsPerPath(declaredMaxSteps);
  const advanceTimeoutMs = num((env as unknown as { EXEC_ADVANCE_TIMEOUT_MS?: string }).EXEC_ADVANCE_TIMEOUT_MS, 3500);
  const allowShim = (env as unknown as { BROWSER_COMPAT_SHIMS?: string }).BROWSER_COMPAT_SHIMS !== "off";

  const acquireTimeoutMs = num((env as unknown as { EXEC_ACQUIRE_TIMEOUT_MS?: string }).EXEC_ACQUIRE_TIMEOUT_MS, 45_000);
  const walkTimeoutMs = num((env as unknown as { EXEC_WALK_TIMEOUT_MS?: string }).EXEC_WALK_TIMEOUT_MS, 150_000);
  // PER-CASE TIME BUDGET. One stuck walk must not eat the batch: each case gets its own wall-
  // clock cap. The per-case timeout is the TIGHTER of (a) the explicit per-case budget and
  // (b) the legacy walk timeout, so it never exceeds what the old code allowed. Exceeding it
  // produces outcome "per-case-timeout" — a named, counted limitation the batch loop continues
  // past, just as it continues past a browser-hung walk.
  const perCaseTimeoutMs = Math.min(
    num((env as unknown as { EXEC_PER_CASE_TIMEOUT_MS?: string }).EXEC_PER_CASE_TIMEOUT_MS, 45_000),
    walkTimeoutMs,
  );
  // STARTUP BUDGET: bounds the pre-first-step stretch. See `DEFAULT_STARTUP_BUDGET_MS` for
  // why this exists and what the three instrumented sub-phases are. Floor/ceiling guarded so
  // a misconfigured env cannot zero the startup budget (making every walk "walk-never-started")
  // or set it higher than the per-case timeout (making it inert).
  const startupBudgetMs = Math.min(
    resolveStartupBudgetMs(
      (env as unknown as { EXEC_WALK_STARTUP_BUDGET_MS?: string }).EXEC_WALK_STARTUP_BUDGET_MS,
    ),
    perCaseTimeoutMs,
  );
  // STALL WATCHDOG: bounds the mid-walk stall. See `DEFAULT_WALK_STALL_MS` for the defect
  // and the timer ladder. Floor/ceiling guarded for the same reasons as the startup budget.
  // Capped at perCaseTimeoutMs so the stall window cannot exceed the per-case budget.
  const walkStallMs = Math.min(
    resolveWalkStallMs(
      (env as unknown as { EXEC_WALK_STALL_MS?: string }).EXEC_WALK_STALL_MS,
    ),
    perCaseTimeoutMs,
  );

  // MULTI-LANE BRANCH — the import sits BEHIND the lane-count check (review
  // fix D), so EXEC_LANES=1 runs never load multilane.ts and cannot be
  // affected by a bug in it. Seed alternatives stay sequential because
  // their checkpoint reservation protocol requires exclusive access. Pivots
  // run after the wave, in the existing sequential pivot loop, with the
  // identical-actions stop intact.
  const batchMaxMs = num(env.EXEC_BATCH_MAX_MS, 120_000);
  const requestedLanes = num((env as unknown as { EXEC_LANES?: string }).EXEC_LANES, 1);
  const hasSeedWork = work.some((item) => item.seedAlternative !== null);
  if (requestedLanes > 1 && !hasSeedWork) {
    const multilane = await import("./multilane");
    return await executeMultiLaneBatch(env, args, program, progress, work, {
      batchDeadline,
      batchMaxMs,
      maxAttempts,
      maxSteps,
      advanceTimeoutMs,
      allowShim,
      acquireTimeoutMs,
      perCaseTimeoutMs,
      maxExploration,
      requiredProbeStop,
      lanes: multilane.effectiveLaneCount(env),
      multilane,
      // THREADED WALK OPTIONS (0c): resolved once HERE, threaded to every
      // wave and every lane inside it, exactly as the sequential path does.
      // forwardReleaseMaxWaitMs: from EXEC_FORWARD_RELEASE_MAX_WAIT_MS, same
      // env read as sequential walkOnce line ~1593.
      forwardReleaseMaxWaitMs: num(
        (env as unknown as { EXEC_FORWARD_RELEASE_MAX_WAIT_MS?: string }).EXEC_FORWARD_RELEASE_MAX_WAIT_MS,
        FORWARD_RELEASE_MAX_WAIT_MS,
      ),
      // startupBudgetMs: already resolved above from EXEC_WALK_STARTUP_BUDGET_MS
      // with floor/ceiling guard, same as the sequential path.
      startupBudgetMs,
      // walkStallMs: already resolved above from EXEC_WALK_STALL_MS.
      walkStallMs,
    });
  }

  let handle: SessionHandle;
  try {
    handle = await acquireWithRetry(env, args.cursor, acquireTimeoutMs);
    if (sessionExpired(env, args.cursor, Date.now())) {
      await retireSession(handle);
      handle = await acquireWithRetry(env, { ...args.cursor, sessionId: null, sessionOpenedAt: null }, acquireTimeoutMs);
    }
  } catch (err) {
    // Two failures is an outage, not a blip. Stop the run honestly instead of looping.
    //
    // AND SAY WHY. This catch used to discard `err` entirely, so a run that never opened a
    // browser reported the bare string "browser-unavailable" — the same four words for an
    // expired quota, a network fault, a wedged session and a binding that is not wired at
    // all. The operator's next action is different in each case, so the provider's own
    // message is committed to the run's durable error field, which the status endpoint and
    // the report both already read.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`v2 exec ${args.runId}: browser unavailable — ${detail}`);
    await updateCheckpoint(
      env,
      args.runId,
      (d) => {
        d.error = `browser unavailable after two acquire attempts: ${detail}`.slice(0, 2000);
      },
      { progressed: true, fence: args.fence },
    );
    await beat(env, args.runId, `browser unavailable: ${detail.slice(0, 200)}`, `${args.batch}:browser-unavailable`);
    return {
      done: true,
      stopReason: EXEC_STOP_BROWSER_UNAVAILABLE,
      pathsWalked: 0,
      casesClosed: 0,
      steps: 0,
    };
  }

  await pushUsage(env, args.runId, args.fence, [browserUsage()]);

  // HARD BATCH ABORT — defense against platform step-timeout failures.
  //
  // Two consecutive runs (v93b batch 1, v94 batch 0) hung for 5+ hours on a single batch
  // because the CF Workflow step timeout (BATCH_POLICY.timeout = "22 minutes") did not fire
  // while the step held a live WebSocket to Browser Rendering. The per-case withTimeout
  // (15 min) also failed to fire — the likely cause is that a dead Puppeteer WebSocket
  // keeps the connection object alive without completing or erroring, starving the event
  // loop and preventing setTimeout callbacks from dispatching.
  //
  // This inner timer is the LAST backstop. When it fires:
  //   1. It closes the browser forcibly (browser.close()).
  //   2. Every pending Puppeteer call (page.goto, page.evaluate, etc.) receives a
  //      disconnect error and resolves, unblocking the withTimeout wrappers.
  //   3. The walk loop's Date.now() >= batchDeadline check is true on the next iteration
  //      (since this timer fires AFTER the batch deadline), so the loop breaks.
  //   4. Cleanup runs normally — session close (already closed, caught), checkpoint update,
  //      return done:false so the next batch continues with a fresh browser.
  //
  // Budget: batchMaxMs + 2 minutes headroom for wrap-up. The normal batchDeadline check
  // should end the batch BEFORE this timer fires — if it fires, the batchDeadline check
  // was starved by a hung walk.
  const hardBatchAbortMs = batchMaxMs + 120_000;
  let hardAbortFired = false;
  const batchAbortTimer = setTimeout(() => {
    hardAbortFired = true;
    console.error(
      `v2 exec batch ${args.batch}: HARD BATCH ABORT after ${hardBatchAbortMs}ms — ` +
        `closing browser forcibly to unblock pending operations`,
    );
    try {
      handle.browser.close();
    } catch {
      /* best-effort close — the browser may already be dead */
    }
  }, hardBatchAbortMs);

  let pathsWalked = 0;
  let sessionWedged = false;
  let casesClosed = 0;
  let steps = 0;
  let stopReason: string | null = null;

  // MINIMUM BATCH RESIDUAL GUARD (first real walk, analysis class b).
  //
  // All 7 time-caps on the first real walk were walks started with 1.1-56s of leftover
  // batch budget. A walk started with less budget than it needs is structurally doomed:
  // it burns an exploration slot or a path attempt, records zero steps, and produces
  // outcome "time-cap" — wasted work that is indistinguishable from a real timeout.
  //
  // The minimum residual is the per-case timeout: a walk that cannot run for at least
  // perCaseTimeoutMs has no chance of completing even a single healthy screen sequence.
  // When the remaining batch budget falls below this floor, the batch ends and hands
  // the remaining work to the next batch, which starts with a full budget.
  const minBatchResidualMs = perCaseTimeoutMs;

  try {
    for (const item of work) {
      if (pathsWalked >= maxAttempts || Date.now() >= batchDeadline) break;

      // DON'T-START GUARD: do not begin a walk when the remaining batch budget is
      // below the minimum residual. The analysis measured all 7 time-caps as walks
      // started with 1.1-56s of leftover budget against walks that need 52-95s.
      const remainingBudgetMs = batchDeadline - Date.now();
      if (remainingBudgetMs < minBatchResidualMs) {
        console.log(
          `v2 exec batch ${args.batch}: skipping ${item.path.id} — only ${remainingBudgetMs}ms ` +
            `of batch budget remains, below the ${minBatchResidualMs}ms minimum residual`,
        );
        break;
      }

      const attemptId = mintAttemptId();
      await updateCheckpoint(
        env,
        args.runId,
        (d) => {
          if (item.seedAlternative) {
            const ledger = d.execution?.seedExecution;
            if (!ledger) throw new Error("W5 seed actuation refused because the checkpoint ledger is absent");
            if (ledger.reservation) {
              throw new Error(
                `W5 seed actuation refused: unresolved reservation ${ledger.reservation.attemptId} for ${ledger.reservation.alternativeId}`,
              );
            }
            ledger.reservation = { alternativeId: item.seedAlternative.alternativeId, attemptId };
          }
          d.currentAttempt = {
            attemptId,
            pathId: item.path.id,
            pathLabel: String(item.path.intent ?? item.path.id).slice(0, 200),
            attemptNumber: progress.walks.length + 1,
          };
        },
        { fence: args.fence },
      );
      await beat(env, args.runId, `batch ${args.batch}: walking ${item.path.id}`, `${args.batch}:${item.path.id}`);

      // WHICH ATTEMPT OF THIS PATH THIS IS, counted from the durable walk rows. The judge's
      // signed manifest keys artifacts by BASENAME, and a re-walk of the same path under the
      // same refs raises MANIFEST_DUPLICATE_ARTIFACT and mints NO judgement (run
      // v2r_01m067zf40z4788yb60c380vgp: 482 ambiguous names from timeout re-attempts). The
      // first attempt stays ordinal 0 — refs byte-identical to every single-attempt run —
      // and each re-attempt is disjoint by construction. Pivot retries below count rows the
      // same way, so their names can never collide with a re-attempt's either.
      const priorAttemptsOfPath = progress.walks.filter((w) => w.pathId === item.path.id).length;
      const cap: CaptureContext = {
        env,
        runId: args.runId,
        attemptId,
        pathId: item.path.id,
        ...(priorAttemptsOfPath > 0 ? { attemptOrdinal: priorAttemptsOfPath } : {}),
        witnesses: Array.isArray(item.path.witnesses) ? (item.path.witnesses as string[]) : [],
      };

      // The defaults are the first attempt's identity. A BOUNDED SCREEN-OUT RETRY passes its
      // own fresh attemptId, its own attempt-ordinal capture context (attempt-unique artifact
      // refs — the judge's manifest keys by basename) and the pivot ordinal as the driver's
      // deterministic filler variant. The shim retry deliberately keeps the defaults: its
      // attemptId reuse is a pre-existing, documented exposure this change must not widen.
      //
      // STARTUP PHASE TRACKING: three timestamps instrument the pre-first-step stretch so a
      // "walk-never-started" outcome names WHICH sub-phase hung (page-create / survey-load /
      // first-read) from measured data, not from guessing. The tracker is shared between the
      // executor and the driver: `walkOnce` writes the page-create timestamp itself (newPage
      // is its first call), and passes an `onStartupPhase` callback that the driver calls at
      // each transition. See `WalkOptions.onStartupPhase` for the contract.
      const walkOnce = async (
        shim: boolean,
        walkAttemptId = attemptId,
        walkCap = cap,
        walkVariant = 0,
        walkVariantFromStep = 0,
        startupPhases?: StartupSubPhase[],
      ): Promise<PathObservation> => {
        const page = (await withTimeout(handle.browser.newPage(), 30_000, "newPage")) as PageLike;
        startupPhases?.push("page-create");

        // PER-WALK PROGRESS WATCHDOG — see DEFAULT_WALK_STALL_MS for the defect and the
        // timer ladder (stall watchdog 4 min → per-case axe 15 min → hard batch abort).
        // The abort signal is a mutable flag the walk loop polls; when set, the walk exits
        // cleanly and returns its partial observation with outcome "walk-stalled".
        const abortSignal: { aborted: boolean; reason?: string } = { aborted: false };
        let lastStepCompletedAt = Date.now();
        const stallCheckInterval = setInterval(() => {
          const stalledFor = Date.now() - lastStepCompletedAt;
          if (stalledFor >= walkStallMs) {
            abortSignal.aborted = true;
            abortSignal.reason =
              `no step completed for ${stalledFor}ms (stall window ${walkStallMs}ms)`;
            console.log(
              `v2 exec batch ${args.batch}: walk ${item.path.id} STALL WATCHDOG — ` +
                `no step completed for ${stalledFor}ms, closing page to unblock pending calls`,
            );
            // Close the PAGE (not the browser) to unblock all pending page calls. Each
            // pending call receives a disconnect error and resolves, the step loop catches
            // it, sees abortSignal.aborted, and breaks cleanly. The browser stays alive for
            // the next walk — only a dead browser (C2) retires the session.
            try {
              page.close();
            } catch {
              /* best-effort — the page may already be closed or unreachable */
            }
          }
        }, 10_000);

        try {
          return await walkPath(
            page,
            item.path,
            {
              surveyUrl: program.surveyUrl || args.surveyUrl,
              runId: args.runId,
              planRevisionId: args.planRevisionId,
              attemptId: walkAttemptId,
              tier: item.tier,
              maxSteps,
              deadline: walkDeadlineFor(batchDeadline, Date.now(), num(env.EXEC_BATCH_MAX_MS, 120_000), perCaseTimeoutMs),
              viewport: { width: 1280, height: 900 },
              applyHistoryShim: shim,
              advanceTimeoutMs,
              // A minimum-dwell gate's length is a property of the INSTRUMENT, never of this code:
              // the wait ends when the control opens, and this is only the bound that stops it
              // becoming an infinite wait. Raise it for an instrument with longer gates.
              forwardReleaseMaxWaitMs: num(
                (env as unknown as { EXEC_FORWARD_RELEASE_MAX_WAIT_MS?: string }).EXEC_FORWARD_RELEASE_MAX_WAIT_MS,
                FORWARD_RELEASE_MAX_WAIT_MS,
              ),
              variant: walkVariant,
              variantFromStep: walkVariantFromStep,
              // STARTUP PHASE INSTRUMENTATION: the driver calls this at two transitions (after
              // page.goto and after first screen read), so the executor can tell which sub-phase
              // hung when the startup budget expires. See `WalkOptions.onStartupPhase`.
              ...(startupPhases ? { onStartupPhase: (phase: "survey-load" | "first-read") => { startupPhases.push(phase); } } : {}),
              // PER-WALK PROGRESS WATCHDOG: the step-completion callback resets the stall
              // timer, and the abort signal tells the walk loop to stop when the stall window
              // expires. Both are OUTSIDE the walk's own await chain.
              onStepCompleted: () => { lastStepCompletedAt = Date.now(); },
              abortSignal,
            },
            walkCap,
          );
        } finally {
          clearInterval(stallCheckInterval);
          try {
            await page.close();
          } catch {
            /* a page that will not close must not lose the observation */
          }
        }
      };

      let obs: PathObservation;
      let browserHung = false;
      let perCaseTimedOut = false;
      // STARTUP BUDGET: a tighter race that fires before the per-case timeout when the walk
      // is still in its pre-first-step stretch. When the startup budget expires AND no step
      // has been recorded, the outcome is "walk-never-started" — a NEW outcome that names
      // the specific sub-phase that hung, carries the real wallMs, and gets ONE retry on a
      // completely fresh session. A dead start must cost ~2-4 minutes, never 15 silent minutes.
      const startupPhases: StartupSubPhase[] = [];
      const walkStartMs = Date.now();
      // BROWSER-DEATH BATCH ABANDONMENT (C2): when a walk dies on a connection-dead signal,
      // the batch stops feeding remaining paths to this session. The dead browser's error
      // row stays as-is, but the remaining paths are left UNWALKED — the next batch gets a
      // fresh browser. This closes the defect where one dead browser burned three paths as
      // permanent zero-evidence rows in 1.2 seconds ("Protocol error: Connection closed" x3,
      // 600ms apart, v98 walks 13-15).
      let browserDead = false;
      try {
        obs = await withTimeout(walkOnce(progress.shimRequired && allowShim, attemptId, cap, 0, 0, startupPhases), perCaseTimeoutMs, `walk ${item.path.id}`);
      } catch (err) {
        const elapsedMs = Date.now() - walkStartMs;
        // A BrowserTimeout from the per-case budget means the walk exceeded its time cap.
        // STARTUP BUDGET DISCRIMINATION: if the walk has no steps AND the elapsed time is
        // within the startup budget range, the hang was in the pre-first-step stretch and
        // the outcome is "walk-never-started" — an infrastructure fact about THIS attempt,
        // not a site accusation. The startup budget is checked AGAINST the elapsed time
        // rather than racing a second timer, because the phase tracker already tells us
        // whether the walk started. A walk with 0 steps that timed out before any step
        // could run is structurally the same whether it took 2 minutes or 15.
        perCaseTimedOut = err instanceof BrowserTimeout;
        const neverStarted = walkNeverStarted(perCaseTimedOut, startupPhases);
        browserHung = perCaseTimedOut;
        // BROWSER-DEATH DETECTION: if the error matches a connection-closed pattern, the
        // browser process is gone and no further walks on this session can succeed.
        browserDead = !perCaseTimedOut && isBrowserDeathSignal(err);
        obs = {
          kind: "v2-path-observation/1.0.0",
          runId: args.runId,
          pathId: item.path.id,
          tier: item.tier,
          attemptId,
          planRevisionId: args.planRevisionId,
          surveyUrl: program.surveyUrl || args.surveyUrl,
          startedAt: new Date(walkStartMs).toISOString(),
          endedAt: new Date().toISOString(),
          wallMs: elapsedMs,
          plannedWitnesses: [],
          steps: [],
          outcome: neverStarted ? "walk-never-started" : perCaseTimedOut ? "per-case-timeout" : "error",
          outcomeDetail: neverStarted
            ? `walk never started: hung in ${hungStartupPhase(startupPhases)} after ${elapsedMs}ms (startup budget ${startupBudgetMs}ms, phases completed: ${startupPhases.join(", ") || "none"})`
            : perCaseTimedOut ? `walk exceeded its per-case budget of ${perCaseTimeoutMs}ms` : String(err).slice(0, 500),
          shimmed: false,
          shimNote: null,
          loadFailure: null,
          evidenceIds: [],
          viewport: { width: 1280, height: 900 },
        };
      }

      // STARTUP BUDGET RETRY: a walk that never started gets ONE retry on a completely fresh
      // session. The premise is that a dead browser page or a hung goto is transient — the
      // second attempt uses a different page on the same session (newPage allocates a fresh
      // tab). If the retry also never starts, both attempts are recorded and the walk is done.
      // The retry uses the SAME attemptId/cap because the first attempt produced no artifacts
      // — there is nothing to collide with.
      if (obs.outcome === "walk-never-started") {
        console.log(
          `v2 exec batch ${args.batch}: ${item.path.id} walk-never-started ` +
            `(hung in ${hungStartupPhase(startupPhases)}, ${obs.wallMs}ms) — retrying once on a fresh page`,
        );
        // Record the failed startup attempt before retrying, so it is never lost.
        progress.walks.push(walkRecord(obs, []));
        progress.totalSteps += obs.steps.length;
        progress.totalEvidence += obs.evidenceIds.length;

        // The retry gets its own startup phase tracker and its own start time.
        const retryStartupPhases: StartupSubPhase[] = [];
        const retryStartMs = Date.now();
        try {
          obs = await withTimeout(
            walkOnce(progress.shimRequired && allowShim, attemptId, cap, 0, 0, retryStartupPhases),
            // The retry uses the startup budget as its timeout — no point waiting longer
            // than the startup budget for something that should complete in <15s.
            startupBudgetMs,
            `walk ${item.path.id} startup-retry`,
          );
          // The retry started successfully. Reset the browserHung flag — this session is alive.
          browserHung = false;
          perCaseTimedOut = false;
        } catch (retryErr) {
          const retryElapsedMs = Date.now() - retryStartMs;
          const retryTimedOut = retryErr instanceof BrowserTimeout;
          const retryNeverStarted = walkNeverStarted(retryTimedOut, retryStartupPhases);
          browserHung = retryTimedOut;
          perCaseTimedOut = retryTimedOut;
          obs = {
            kind: "v2-path-observation/1.0.0",
            runId: args.runId,
            pathId: item.path.id,
            tier: item.tier,
            attemptId,
            planRevisionId: args.planRevisionId,
            surveyUrl: program.surveyUrl || args.surveyUrl,
            startedAt: new Date(retryStartMs).toISOString(),
            endedAt: new Date().toISOString(),
            wallMs: retryElapsedMs,
            plannedWitnesses: [],
            steps: [],
            outcome: retryNeverStarted ? "walk-never-started" : retryTimedOut ? "per-case-timeout" : "error",
            outcomeDetail: retryNeverStarted
              ? `walk never started (retry): hung in ${hungStartupPhase(retryStartupPhases)} after ${retryElapsedMs}ms (startup budget ${startupBudgetMs}ms, phases completed: ${retryStartupPhases.join(", ") || "none"})`
              : retryTimedOut ? `walk exceeded its per-case budget of ${startupBudgetMs}ms (startup retry)` : String(retryErr).slice(0, 500),
            shimmed: false,
            shimNote: null,
            loadFailure: null,
            evidenceIds: [],
            viewport: { width: 1280, height: 900 },
          };
        }
      }

      // THE CRASH IS THE FINDING; THE SHIM IS HOW THE REST STILL GETS TESTED.
      // The unshimmed attempt is kept in the record exactly as captured, and the second
      // attempt is stamped `shimmed: true` so no later reader can mistake the two.
      if (obs.outcome === "load-crash" && allowShim && !obs.shimmed) {
        progress.shimRequired = true;
        progress.shimEvidence = obs.evidenceIds[0] ?? null;
        progress.walks.push(walkRecord(obs, []));
        progress.totalEvidence += obs.evidenceIds.length;
        await beat(
          env,
          args.runId,
          `${item.path.id}: site threw during load and rendered nothing — recorded, retrying with the one-property shim`,
          `${args.batch}:crash`,
        );
        obs = await walkOnce(true);
      }

      // A WALK CLOSES ITS CASES ONLY IF IT ACTUALLY WALKED THE SURVEY.
      //
      // This is the single most important line in the executor, and getting it wrong is
      // not hypothetical: the first live run marked all 119 mandatory cases `exercised`
      // off four walks that never got past a blank first screen, because the code closed
      // a path's cases whenever the path had been ATTEMPTED. The run then reported
      // `test: complete` over a survey that had never rendered a question — a clean pass
      // built out of nothing, which is exactly the failure mode this pipeline exists to
      // make impossible. Cases now close only when the walk reached the end of the survey
      // having advanced at least one screen; a crashed, blocked or capped walk leaves them
      // PENDING, and the executing-close gate reclassifies them under whichever stop reason
      // the run ended on — which is why that reason has to be the TRUE one (`resolveStopReason`).
      // ...AND ONLY IF IT DID WHAT THE PLAN ACTUALLY ASKED. `assessExercised` owns that
      // judgement whole — the denominator argument, the hard floor and the decision are one
      // function so there is one place to read, one place to test and one place to break.
      const audit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);
      const exercised = audit.exercised;
      const seededCaseIds = new Set((program.seedPlan?.alternatives ?? []).map((row) => row.caseId));
      const standardClosed =
        item.assignment && exercised
          ? item.assignment.caseIds.filter((id) => !seededCaseIds.has(id) && !args.cursor.completedCaseIds.includes(id))
          : [];
      let seedReceipt: CaseWitnessReceipt | null = null;
      let seedCommit: SeedCommitArtifact | null = null;
      let seedReceiptArtifactKey: string | null = null;
      let seedReceiptRefusal: string | null = null;
      progress.seedReceiptRefusals = progress.seedReceiptRefusals ?? [];
      if (item.seedAlternative) {
        const verified = await verifiedPathObservation(env, args.runId, obs);
        const retainedObservation = verified.observation;
        const retainedAudit = assessExercised(retainedObservation, item.path.decisions as PlannedDecision[] | undefined);
        const receiptResult = await deriveCaseWitnessReceipt(item.seedAlternative, retainedObservation, verified.evidenceId);
        if (receiptResult.ok) {
          seedReceipt = receiptResult.receipt;
        } else {
          seedReceiptRefusal = receiptResult.reason;
          progress.seedReceiptRefusals.push({
            alternativeId: item.seedAlternative.alternativeId,
            caseId: item.seedAlternative.caseId,
            attemptId: obs.attemptId,
            reason: receiptResult.reason,
          });
        }
        seedCommit = await seedCommitArtifact(
          seedReceipt,
          seedReceiptRefusal,
          verified.evidenceId,
          retainedObservation,
          walkRecord(retainedObservation, seedReceipt ? [seedReceipt.caseId] : [], retainedAudit, undefined, verified.evidenceId),
        );
        seedReceiptArtifactKey = seedCommitArtifactKey(args.runId, obs.attemptId);
        await env.EVIDENCE.put(seedReceiptArtifactKey, JSON.stringify(seedCommit), {
          httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
        });
      }
      const walkedOk = obs.outcome !== "error";

      // BROWSER-DEATH BATCH ABANDONMENT (C2): when a walk died on a connection-dead signal,
      // the batch stops feeding remaining paths to this session immediately. The error row for
      // THIS path stays as-is, but remaining paths are left UNWALKED (not error rows). The
      // next batch gets a fresh browser. A path that already produced an error row from the
      // dead browser stays as-is — but the pattern must not repeat within the batch.
      if (browserDead) {
        console.log(
          `v2 exec batch ${args.batch}: browser DEAD after walk ${item.path.id} — ` +
            `ending batch early, remaining paths left unwalked for the next batch`,
        );
        sessionWedged = true;
        // Record this walk — the error observation is real evidence.
        if (!item.seedAlternative) {
          if (item.tier === 1 && !progress.floorDone.includes(item.path.id)) progress.floorDone.push(item.path.id);
          else if (item.tier !== 1 && !progress.explorationDone.includes(item.path.id)) progress.explorationDone.push(item.path.id);
          progress.walks.push(walkRecord(obs, [], audit));
          progress.totalSteps += obs.steps.length;
          progress.totalEvidence += obs.evidenceIds.length;
          await saveProgress(env, progress);
        }
        // Commit the checkpoint so the error is durably recorded, then break.
        await updateCheckpoint(
          env,
          args.runId,
          (d) => {
            const c = d.execution;
            if (!c) return false;
            const next: ExecutionCursor = applySessionToCursor(
              { ...c, batchIndex: args.batch + 1 },
              handle,
            );
            d.execution = next;
            d.attempts.started += 1;
            d.currentAttempt = null;
            return true;
          },
          { progressed: true, fence: args.fence },
        );
        pathsWalked += 1;
        steps += obs.steps.length;
        // Break the batch loop — remaining work items are NOT walked and NOT recorded as
        // errors. They stay pending and the next batch (with a fresh browser) picks them up.
        break;
      }

      // A WEDGED BROWSER GETS THE PATH ONE MORE CHANCE, ON A FRESH SESSION — AND ONLY ONE.
      // Marking a hung path "done" would discard a whole floor path over a transient
      // remote failure; retrying it forever would spin the run. It is re-attempted once,
      // and the second hang closes it out so the run can terminate and say what happened.
      progress.hungPaths = progress.hungPaths ?? [];
      const alreadyHung = progress.hungPaths.includes(item.path.id);
      if (browserHung) {
        sessionWedged = true;
        if (!alreadyHung) progress.hungPaths.push(item.path.id);
      }
      const retryable = browserHung && !alreadyHung;

      // Ordinary paths keep the established progress-before-checkpoint protocol. Only W5
      // seed attempts use checkpoint-first because their immutable attempt artifact makes the
      // walk exactly reconstructible after a crash.
      if (!item.seedAlternative) {
        if (!retryable) {
          if (item.tier === 1 && !progress.floorDone.includes(item.path.id)) progress.floorDone.push(item.path.id);
          else if (item.tier !== 1 && !progress.explorationDone.includes(item.path.id)) progress.explorationDone.push(item.path.id);
        }
        progress.walks.push(walkRecord(obs, standardClosed, audit));
        progress.totalSteps += obs.steps.length;
        progress.totalEvidence += obs.evidenceIds.length;
        await saveProgress(env, progress);
      }

      let closed: string[] = [];
      let committed = false;
      const checkpointAfter = await updateCheckpoint(
        env,
        args.runId,
        (d) => {
          const c = d.execution;
          if (!c) return false;
          if (item.seedAlternative) {
            const result = applySeedAttemptCommit(c, {
              alternativeId: item.seedAlternative.alternativeId,
              expectedCaseId: item.seedAlternative.certificate.facetInstanceId,
              expectedCertificateHash: item.seedAlternative.certificate.certificateHash,
              attemptId: obs.attemptId,
              retryable,
              attemptArtifact: {
                alternativeId: item.seedAlternative.alternativeId,
                attemptId: obs.attemptId,
                artifactHash: seedCommit!.artifactHash,
                artifactKey: seedReceiptArtifactKey!,
              },
              receipt: seedReceipt && seedReceiptArtifactKey ? {
                caseId: seedReceipt.caseId,
                alternativeId: seedReceipt.alternativeId,
                attemptId: seedReceipt.attemptId,
                receiptHash: seedReceipt.receiptHash,
                seedCertificateHash: seedReceipt.seedCertificateHash,
                commitArtifactHash: seedCommit!.artifactHash,
                artifactKey: seedReceiptArtifactKey,
              } : null,
            });
            if (!result.committed) return false;
            closed = result.closed;
          } else {
            closed = standardClosed.filter((id) => c.pendingCaseIds.includes(id));
          }
          const next: ExecutionCursor = applySessionToCursor(
            {
              ...c,
              batchIndex: args.batch + 1,
              pendingCaseIds: c.pendingCaseIds.filter((id) => !closed.includes(id)),
              completedCaseIds: [...c.completedCaseIds, ...closed],
            },
            handle,
          );
          d.execution = next;
          d.counts.pending = Math.max(0, d.counts.pending - closed.length);
          d.counts.exercised += closed.length;
          d.attempts.started += 1;
          if (walkedOk) d.attempts.completed += 1;
          d.currentAttempt = null;
          committed = true;
          return true;
        },
        { progressed: true, fence: args.fence },
      );

      if (!committed || !checkpointAfter?.execution) continue;
      Object.assign(args.cursor, checkpointAfter.execution);
      if (item.seedAlternative && !retryable) {
        if (item.tier === 1) {
          if (!progress.floorDone.includes(item.path.id)) progress.floorDone.push(item.path.id);
        } else if (item.seedAlternative) {
          progress.seedDone = [...(args.cursor.seedExecution?.doneAlternativeIds ?? [])];
        } else if (!progress.explorationDone.includes(item.path.id)) {
          progress.explorationDone.push(item.path.id);
        }
      }
      if (seedReceipt && closed.length > 0) {
        progress.caseWitnessReceipts = [...(progress.caseWitnessReceipts ?? []), seedReceipt];
      }
      if (item.seedAlternative) {
        progress.walks.push(walkRecord(obs, closed, audit, undefined, seedCommit?.observationEvidenceId));
        progress.totalSteps += obs.steps.length;
        progress.totalEvidence += obs.evidenceIds.length;
        await saveProgress(env, progress);
      }

      // Keep the in-memory cursor in step with what we just committed, so a second path
      // in this same batch does not re-close cases the first one already closed.
      pathsWalked += 1;
      casesClosed += closed.length;
      steps += obs.steps.length;

      // ==================== BOUNDED SCREEN-OUT RETRY ====================
      //
      // The attempt above is COMMITTED — record pushed, progress saved, checkpoint
      // written, cursor synced — before any pivot is considered, so a pivot can never
      // un-say what the first walk observed. Each loop turn is one full attempt with the
      // same per-attempt commit discipline; `screenoutRetryEligible` owns every refusal
      // (typed screened-out on invented answers only, never sealed stimulus or intended
      // terminations, capped at SCREENOUT_PIVOT_CAP, attempt-budget-bounded,
      // deadline-bounded).
      //
      // DURABLE BEFORE EFFECT: the pivot counter is incremented and SAVED before the
      // re-walk starts — the hungPaths pattern. If the Workflow step replays after that
      // save, the counter yields the same ordinal, the same variant, the same walk; if
      // the instance dies between the save and the re-walk, the retry is LOST, not
      // repeated — the committed screened-out attempt stands and the path stays done.
      //
      // Closure is a UNION across attempts: each attempt closes cases through the same
      // `assessExercised` gate as any walk, and the cursor filter above each closure list
      // is what stops a pivot from re-closing what attempt 0 already closed.
      //
      // IDENTICAL-ACTIONS STOP: a pivot that reproduces its parent's action sequence
      // byte-for-byte proves the filler-variant lever has nothing left to vary on this
      // path — the v62 run spent four 14-minute pivots replaying a plan-pinned
      // "None of the above" click verbatim, because exact plan labels are outside the
      // variant's reach. One reproduction is the proof; further pivots are refused and
      // the stop is named in the activity beat.
      let pivotParentActions = walkActionsJson(obs);
      while (
        !item.seedAlternative &&
        screenoutRetryEligible({
          obs,
          path: item.path,
          pivots: progress.screenoutPivots,
          // The batch's attempt accounting, AT PIVOT TIME: the same `pathsWalked` counter
          // the outer work-item gate compares against `maxAttempts`. Each loop turn
          // re-reads it after the previous attempt's `pathsWalked += 1`, so a pivot is
          // admitted only while the budget the outer gate enforces has room left.
          pathsWalked,
          maxAttempts,
          now: Date.now(),
          batchDeadline,
        })
      ) {
        const ordinal = (progress.screenoutPivots?.[item.path.id] ?? 0) + 1;
        progress.screenoutPivots = { ...(progress.screenoutPivots ?? {}), [item.path.id]: ordinal };
        await saveProgress(env, progress);

        // The pivot record is derived from the PREVIOUS attempt, before `obs` is replaced.
        const pivot = {
          retryOf: obs.attemptId,
          ordinal,
          reason:
            `attempt ${obs.attemptId} ended screened-out with ` +
            `${obs.navigatorDefaultAnswerCount ?? 0} navigator-default answer(s) — ` +
            `re-walking with deterministic filler variant ${ordinal}`,
        };
        // A FRESH attemptId, never the shim retry's reuse: walk-artifact-index and
        // project-observations disambiguate multiple walks of one path by attemptId.
        // The NAMING ordinal counts durable walk rows (the shared per-path sequence with
        // plain re-attempts — see priorAttemptsOfPath), while `ordinal` above stays the
        // pivot's behavioural variant. For the common single-attempt-then-pivot case the
        // row count IS the pivot ordinal, so those refs are byte-identical to before.
        const retryAttemptId = mintAttemptId();
        const retryNamingOrdinal = progress.walks.filter((w) => w.pathId === item.path.id).length;
        const retryCap: CaptureContext = { ...cap, attemptId: retryAttemptId, attemptOrdinal: retryNamingOrdinal };
        await beat(
          env,
          args.runId,
          `batch ${args.batch}: ${item.path.id} screened out on invented answers — re-walking with varied fillers (pivot ${ordinal})`,
          `${args.batch}:${item.path.id}:pivot${ordinal}`,
        );

        // THE PIVOT RE-TRIES THE FAILING SCREEN, NOT THE WHOLE WALK. The screened-out
        // attempt's final step is the terminal screen; the step before it holds the answers
        // whose advance landed there. Steps below that replay the proven variant-0 answers
        // verbatim — the v47 run measured pivots that varied EVERY default disqualifying
        // themselves at screener #1 and never reaching the screen they existed to re-try.
        // INDEX, NOT COUNT: recovery half-steps (48.5) inflate steps.length past the last
        // real step index — the v60 pivot anchored at count-2 = 54 with last index 53 and
        // varied NOTHING, replaying the fatal answer verbatim. The last step's own index,
        // floored (a half-step terminal belongs to its parent screen), minus one, is the
        // screen whose answers led into the terminal.
        const lastStepIndex = Math.floor(Number(obs.steps[obs.steps.length - 1]?.stepIndex ?? 0));
        const pivotFromStep = Math.max(0, lastStepIndex - 1);
        let retryHung = false;
        let retryPerCaseTimedOut = false;
        // FALSE-ZERO FIX: track the pivot's start time so the synthetic observation carries the
        // REAL elapsed time, never wallMs=0. The old code used `new Date()` for both startedAt
        // and endedAt and hardcoded wallMs=0, making a 15-minute hang indistinguishable from a
        // walk that was never attempted. The timing values on a record are claims; a zero that
        // means "we do not know" is a false claim when we DO know.
        const pivotStartMs = Date.now();
        try {
          obs = await withTimeout(
            walkOnce(progress.shimRequired && allowShim, retryAttemptId, retryCap, ordinal, pivotFromStep),
            perCaseTimeoutMs,
            `walk ${item.path.id} pivot ${ordinal}`,
          );
        } catch (err) {
          const pivotElapsedMs = Date.now() - pivotStartMs;
          retryPerCaseTimedOut = err instanceof BrowserTimeout;
          retryHung = retryPerCaseTimedOut;
          obs = {
            kind: "v2-path-observation/1.0.0",
            runId: args.runId,
            pathId: item.path.id,
            tier: item.tier,
            attemptId: retryAttemptId,
            planRevisionId: args.planRevisionId,
            surveyUrl: program.surveyUrl || args.surveyUrl,
            startedAt: new Date(pivotStartMs).toISOString(),
            endedAt: new Date().toISOString(),
            wallMs: pivotElapsedMs,
            plannedWitnesses: [],
            steps: [],
            outcome: retryPerCaseTimedOut ? "per-case-timeout" : "error",
            outcomeDetail: retryPerCaseTimedOut ? `walk exceeded its per-case budget of ${perCaseTimeoutMs}ms` : String(err).slice(0, 500),
            shimmed: false,
            shimNote: null,
            loadFailure: null,
            evidenceIds: [],
            viewport: { width: 1280, height: 900 },
          };
        }

        // ---- the pivot's own per-attempt commit: same discipline as the walk above ----
        const retryAudit = assessExercised(obs, item.path.decisions as PlannedDecision[] | undefined);
        const retryClosed =
          item.assignment && retryAudit.exercised
            ? item.assignment.caseIds.filter(
                (id) =>
                  !(program.seedPlan?.alternatives ?? []).some((alternative) => alternative.caseId === id) &&
                  !args.cursor.completedCaseIds.includes(id),
              )
            : [];
        const retryWalkedOk = obs.outcome !== "error";

        progress.walks.push(walkRecord(obs, retryClosed, retryAudit, pivot));
        progress.totalSteps += obs.steps.length;
        progress.totalEvidence += obs.evidenceIds.length;
        if (retryHung) {
          // The path was already marked done by the attempt above; the hung marker only
          // records that THIS browser is dead so the batch hands it back.
          sessionWedged = true;
          progress.hungPaths = progress.hungPaths ?? [];
          if (!progress.hungPaths.includes(item.path.id)) progress.hungPaths.push(item.path.id);
        }
        await saveProgress(env, progress);

        await updateCheckpoint(
          env,
          args.runId,
          (d) => {
            const c = d.execution;
            if (!c) return false;
            const next: ExecutionCursor = applySessionToCursor(
              {
                ...c,
                batchIndex: args.batch + 1,
                pendingCaseIds: c.pendingCaseIds.filter((id) => !retryClosed.includes(id)),
                completedCaseIds: [...c.completedCaseIds, ...retryClosed],
              },
              handle,
            );
            d.execution = next;
            d.counts.pending = Math.max(0, d.counts.pending - retryClosed.length);
            d.counts.exercised += retryClosed.length;
            d.attempts.started += 1;
            if (retryWalkedOk) d.attempts.completed += 1;
            d.currentAttempt = null;
            return true;
          },
          { progressed: true, fence: args.fence },
        );
        args.cursor.completedCaseIds = [...args.cursor.completedCaseIds, ...retryClosed];
        args.cursor.pendingCaseIds = args.cursor.pendingCaseIds.filter((id) => !retryClosed.includes(id));

        // pathsWalked counts ATTEMPTS, so pivots spend the same maxAttempts/deadline
        // budget as any walk and the wall-clock ledger stays honest — and the eligibility
        // gate above READS this counter, so the spend is enforced, not just recorded.
        pathsWalked += 1;
        casesClosed += retryClosed.length;
        steps += obs.steps.length;

        if (retryHung) break;

        const pivotActions = walkActionsJson(obs);
        if (pivotActions === pivotParentActions) {
          await beat(
            env,
            args.runId,
            `batch ${args.batch}: ${item.path.id} pivot ${ordinal} reproduced the prior attempt's actions exactly — ` +
              `the varied-filler lever cannot change this route (its fatal answers are plan-pinned); ` +
              `stopping retries, document authority needed`,
            `${args.batch}:${item.path.id}:pivot-identical`,
          );
          break;
        }
        pivotParentActions = pivotActions;
      }

      if (sessionWedged) break; // this browser is dead; the next batch starts a fresh one
    }
  } catch (err) {
    // An unexpected executor failure must not leak the browser session. It is recorded as
    // a named stop reason (the report can say the executor stopped the run, and which
    // error did it) rather than thrown past the session handling below.
    console.error(`v2 exec batch ${args.batch}: executor error`, err);
    stopReason = EXEC_STOP_EXECUTOR_ERROR;
  }

  const remaining = selectWork(program, progress, maxExploration).length;
  if (stopReason === null && remaining === 0 && requiredProbeStop !== null) {
    stopReason = requiredProbeStop;
  }
  const done = remaining === 0 || stopReason !== null;

  // DISCONNECT BETWEEN BATCHES, CLOSE WHEN THE WORK IS DONE.
  //
  // Disconnecting is what lets the next step reconnect to the same browser with the page
  // state intact — but `disconnect()` leaves the session ALIVE for its full keep_alive
  // window, and nothing else ever closes it. Every finished run therefore held a remote
  // browser for another ten minutes, and consecutive runs stacked up against the account's
  // browser concurrency limit until new launches simply stopped being granted: the fourth
  // run in a row sat waiting on a session that could not be created. A finished run
  // returns its browser.
  // BOUNDED, LIKE EVERY OTHER REMOTE BROWSER CALL. `close()` and `disconnect()` are the
  // last two calls in the batch and they talk to the same remote browser everything else
  // does — so a wedged session can hang HERE too, after all the work is safely committed,
  // and leave the batch looking stuck with nothing left to do. Failing to hand the browser
  // back is a leak worth a log line; it is not worth hanging the run over.
  const closeSession = async (fn: () => Promise<void>, what: string) => {
    try {
      await withTimeout(fn(), 20_000, what);
    } catch (err) {
      console.error(`v2 exec: ${what} failed or timed out: ${String(err).slice(0, 200)}`);
    }
  };

  // Disarm the hard abort timer — the batch completed normally (or via executor error).
  // If it already fired, the browser is closed and sessionWedged-equivalent, but the walk
  // loop's batchDeadline guard broke normally. Record it for diagnostics but DO NOT stop the
  // run: a single hard abort is a RECOVERABLE zombie-browser condition. The next batch
  // launches a fresh browser and tries again. Consecutive aborts are tracked durably (below)
  // and capped at HARD_ABORT_CONSECUTIVE_CAP before the run stops.
  clearTimeout(batchAbortTimer);
  if (hardAbortFired) {
    console.log(`v2 exec batch ${args.batch}: hard batch abort was the exit cause`);
    // DO NOT set stopReason here. The batch returns done:false so the loop launches the
    // next batch with a fresh browser. The abort is recorded on the progress ledger via
    // the checkpoint event below.
  }

  // EVERY BATCH RETURNS ITS BROWSER — reuse across batches ended with the long-walk
  // budgets (2026-08-17). A walk may now run ~9 minutes, and the platform enforces a
  // measured ~11-minute total-session wall (run-records PLANNING-cloudflare-limits): a
  // walk starting on a session another batch already aged would hit that wall mid-walk,
  // which is exactly the destroyed-evidence class the budget raise exists to close. A
  // fresh launch per batch costs one session create (rate limit 1/s, billed by the same
  // browser-hours either way) and buys every batch the full wall.
  await closeSession(() => retireSession(handle), "session close");
  await updateCheckpoint(
    env,
    args.runId,
    (d) => {
      if (!d.execution) return false;
      d.execution = { ...d.execution, sessionId: null, sessionOpenedAt: null };
      return true;
    },
    { fence: args.fence },
  );

  // Every planned walk has been attempted and mandatory cases are still owed an observation.
  // WHOSE FAULT THAT IS is a question about evidence, not about the pending count — see
  // `resolveStopReason`. It reads the whole run's walks (durable, cumulative) rather than
  // this batch's, because the run-level cause is a fact about the run.
  stopReason = resolveStopReason({
    done,
    pendingCases: args.cursor.pendingCaseIds.length,
    stopReason,
    walks: progress.walks,
  });
  return { done, stopReason, pathsWalked, casesClosed, steps, ...(hardAbortFired ? { hardAbortFired: true } : {}) };
}

/**
 * Did this walk exercise anything?
 *
 * `completed` and `no-advance-control` are the two ways a walk legitimately reaches the
 * end of a survey (the last screen has no Next). Everything else — a load crash, a screen
 * that would not advance, a step or time cap, a driver error — means the walk stopped
 * somewhere in the middle, and the cases the plan assigned to it were not all observed.
 */
export function walkExercised(obs: PathObservation): boolean {
  if (obs.loadFailure) return false;
  if (obs.outcome !== "completed" && obs.outcome !== "no-advance-control") return false;
  return obs.steps.some((s) => s.advanced);
}

/**
 * DOES THIS DECISION CONSTRAIN ANYTHING?
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The exercised gate used to read
 * `plannedDecisions === 0 || matchedDecisions > 0` — every decision the plan listed counted
 * in the denominator. But a planner that cannot name an answer emits
 * `{ select: [], source: "default:navigator-discretion", strategy: "choose-the-first-valid-answer" }`,
 * which asks the driver to do PRECISELY what the driver does with no decision at all. Run
 * v2r_01kzfb6py8pbxznqv022p2qkhb emitted 515 of 585 decisions in exactly that shape, and 38
 * walks that drove the survey to its terminal screen were disqualified for "not matching"
 * instructions that instructed nothing.
 *
 * So the denominator is the decisions that DEMAND SOMETHING THE NAVIGATOR WOULD NOT DO BY
 * ITSELF. Four of them, and the reasons are structural rather than a list of planner strings:
 *
 *   - `case_action`  — the sealed stimulus of a typed case. THE MOST IMPORTANT ONE, and the
 *     one a naive "empty `select` means unconstrained" rule gets catastrophically wrong: a
 *     route case whose `routeAnswer.label` is null, or a boundary case carrying only an
 *     input value, has an EMPTY `select` and is still the entire point of the walk. Calling
 *     it unconstrained would let a walk close that case having answered the question with
 *     whatever option happened to be first — a closed case whose stimulus never ran.
 *   - `select` non-empty — a named answer.
 *   - `action` — a probe ("submit-without-answering"), i.e. a deliberate deviation FROM the
 *     default behaviour. If it never bound, the probe never happened.
 *   - `text_entry.value` on a decision the plan did NOT source from its own defaults.
 *
 * THE ASSUMPTION IN THAT LAST CLAUSE, WRITTEN DOWN (CLAUDE.md: no silent reliance on a
 * convention). `driver.ts` fills any text control with its own `PROBE_TEXT` when no decision
 * matched, and the planner emits that same filler as `text_entry.value` on discretion
 * decisions — so such a value is a default wearing an instruction's clothes. The planner
 * declares which those are by prefixing `source` with `default:`. Where `source` is absent
 * or unrecognised this DEGRADES STRICT: the text is treated as a constraint, so an unknown
 * planner can only ever make the gate harder to pass, never easier.
 */
export function isConstrainingDecision(d: PlannedDecision | null | undefined): boolean {
  if (!d || typeof d !== "object") return false;
  if (d.case_action) return true;
  if (Array.isArray(d.select) && d.select.length > 0) return true;
  if (typeof d.action === "string" && d.action.length > 0) return true;
  const planDeclaredDefault = typeof d.source === "string" && d.source.startsWith("default:");
  const text = d.text_entry?.value;
  if (!planDeclaredDefault && typeof text === "string" && text.length > 0) return true;
  return false;
}

/**
 * The questions whose decisions constrain. The gate joins the walk back to the PLAN through
 * this set rather than sniffing the step's own `requested` payload — because a matched
 * discretion decision records `requested.textEntry = "QA-PROBE"` (the driver's own filler),
 * and a numerator that read that shape would count a decision the denominator excluded.
 *
 * ASSUMPTION: a path answers each question at most once, so a question id identifies its
 * decision. `matchDecision` removes a decision from `remaining` once it binds, so a decision
 * cannot be counted twice; a path that legitimately revisits a question with both a
 * constraining and a delegated decision would count either as the constraining one. That is
 * generous by at most one step and is the only direction this join can err.
 */
export function constrainingQuestions(decisions: readonly PlannedDecision[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const d of decisions ?? []) {
    if (isConstrainingDecision(d) && typeof d.question === "string" && d.question.length > 0) out.add(d.question);
  }
  return out;
}

/** Steps where the driver actually applied a constraining decision — never a delegated one. */
export function countMatchedConstraining(obs: PathObservation, constrained: Set<string>): number {
  if (constrained.size === 0) return 0;
  return obs.steps.filter(
    (s) =>
      (s.decisionSource === "plan" || s.decisionSource === "probe") &&
      typeof s.decisionQuestion === "string" &&
      constrained.has(s.decisionQuestion),
  ).length;
}

export interface ExercisedAssessment {
  exercised: boolean;
  plannedDecisions: number;
  matchedDecisions: number;
  constrainingDecisions: number;
  matchedConstraining: number;
}

/**
 * THE GATE. Everything above is the denominator argument; this is the decision, and it is one
 * expression on purpose so there is exactly one place to mutate and exactly one place to test.
 *
 * `walkExercised` IS THE HARD FLOOR AND IT IS UNCHANGED — the walk must have reached a
 * terminal screen and advanced at least one screen. That is the line that stops the 119
 * incident (four walks that never got past a blank first screen closing every mandatory case)
 * and no amount of decision bookkeeping can talk past it.
 *
 * On top of the floor: if the plan named something specific, the walk must have DONE at least
 * one of those specific things. Note which direction this moves the gate. For a path with any
 * constraining decision the new rule IMPLIES the old one — the numerator shrank from "any
 * decision matched" to "a constraining decision matched", so those paths got STRICTER. Only
 * paths where the plan named nothing at all are freed, and there is nothing there to bind
 * wrongly: a walk cannot mis-apply an instruction that was never given.
 *
 * `> 0` rather than "all matched", deliberately: a routing case whose answer screens the
 * respondent out ends the survey before the path's later decisions are reachable, and
 * demanding all of them would disqualify the walk for obeying the plan.
 */
export function assessExercised(
  obs: PathObservation,
  decisions: readonly PlannedDecision[] | null | undefined,
): ExercisedAssessment {
  const planned = Array.isArray(decisions) ? decisions : [];
  const constrained = constrainingQuestions(planned);
  const matchedConstraining = countMatchedConstraining(obs, constrained);
  const matchedDecisions = obs.steps.filter((s) => s.decisionSource === "plan" || s.decisionSource === "probe").length;
  return {
    exercised: walkExercised(obs) && (constrained.size === 0 || matchedConstraining > 0),
    plannedDecisions: planned.length,
    matchedDecisions,
    constrainingDecisions: constrained.size,
    matchedConstraining,
  };
}

/**
 * ==================== BOUNDED SCREEN-OUT RETRY: THE ELIGIBILITY GATE ====================
 *
 * WHY A RETRY EXISTS AT ALL. Numeric screeners are structurally unreachable by planner
 * stimulus: `plan-core.js#mineThresholds` mines no numeric terminate rules and terminal
 * triggers are label-quoted only, so "terminate if >= 15" exists nowhere as data. Survival
 * hints (D54) steer LABEL fillers; when the walker's own invented NUMBER lands a typed
 * `screened-out`, the only honest move left is a bounded, deterministic re-walk with a
 * different filler variant — never a retuned constant (the midpoint is pinned, d44).
 *
 * EVERY CLAUSE IS A REFUSAL, and each is here because pivoting past it would fight an
 * outcome something else intended:
 *
 *   - not a typed `screened-out` ending — everything else (completed, stalled,
 *     unclassified, absent) is not the failure this feature exists for;
 *   - no navigator-default answers on the walk — the plan's own answers replay
 *     IDENTICALLY on every attempt, so a plan-caused screen-out reproduces byte-for-byte
 *     and a pivot could only waste the two walks the cap allows;
 *   - `terminated_at` non-null — the plan INTENDS this walk to terminate;
 *   - any `case_action` decision — sealed typed-case stimulus; its outcome is the
 *     observation, and re-walking it would fight the experiment itself;
 *   - a `just-triggers` terminal-adjacency probe — it exists to BE screened out.
 *     (VERIFIED: `adjacency.side` is emitted on exploration entries at
 *     plan-core.js:1699/1713 through the open index signature and travels verbatim in
 *     the plan artifact to this executor; it is not a declared ExplorationEntry field,
 *     so the clause reads it structurally and absent degrades to eligible — the
 *     terminated_at/case_action clauses and the cap still bound the damage.)
 *   - the pivot cap — two pivots, then the last walk's screened-out ending stands, with
 *     the pivot-linked records telling the story;
 *   - the batch attempt budget — EXEC_BATCH_MAX_ATTEMPTS caps ATTEMPTS, not outer work
 *     items, so the cap means the same thing everywhere. The clause reads the executor's
 *     own accounting pair: `pathsWalked` is the SAME counter the outer work-item gate
 *     compares against `maxAttempts`, passed at pivot time (the while condition re-reads
 *     it each turn, and every attempt — outer or pivot — consumes it identically with
 *     `pathsWalked += 1` after its per-attempt commit). Without this clause the named
 *     budget was not real for pivots: maxAttempts=1 could execute three attempts. Both
 *     fields are mandatory in the signature; the executor is the only caller.
 *   - the batch deadline — a pivot is budgeted work like any other walk.
 *
 * Pure and exported so every clause is directly testable without a browser; the executor
 * consults it and nothing else does. Evidence it can fail: `tools/mutate-screenout-retry.mjs`.
 */
export const SCREENOUT_PIVOT_CAP = 2;

export function screenoutRetryEligible(args: {
  obs: Pick<PathObservation, "ending" | "navigatorDefaultAnswerCount">;
  path: PlannedPath;
  pivots: Record<string, number> | undefined;
  pathsWalked: number;
  maxAttempts: number;
  now: number;
  batchDeadline: number;
}): boolean {
  const { obs, path } = args;
  if (obs.ending?.kind !== "screened-out") return false;
  if (!((obs.navigatorDefaultAnswerCount ?? 0) > 0)) return false;
  if (path.terminated_at != null) return false;
  if (Array.isArray(path.decisions) && path.decisions.some((d) => d && d.case_action !== undefined)) return false;
  if (Array.isArray(path.decisions) && path.decisions.some((d) => typeof d?.seed_certificate_hash === "string")) return false;
  if ((path as { adjacency?: { side?: string } }).adjacency?.side === "just-triggers") return false;
  if ((args.pivots?.[path.id] ?? 0) >= SCREENOUT_PIVOT_CAP) return false;
  if (args.pathsWalked >= args.maxAttempts) return false;
  if (args.now >= args.batchDeadline) return false;
  return true;
}

/** Outcomes that ARE the site refusing to advance: the walk died there. */
const BLOCKING_OUTCOMES = new Set(["blocked", "blocked-after-probe"]);

/**
 * POSITIVE EVIDENCE THAT THE SITE REFUSED — counted per walk, at the moment it was observed.
 *
 * Only two of the four `BlockedReason` values are evidence of anything (see
 * `browser/types.ts`, which argues this at length):
 *
 *   - `validation-visible` / `control-disabled` — the walker saw the survey say no.
 *   - `advance-timeout` — a LOST POLLING RACE. A slow-but-healthy page is byte-identical to
 *     a refusal here, so it is not evidence.
 *   - `no-advance-control` — the screen offered nothing to press. On the LAST screen of a
 *     survey that is the survey ENDING. Run v2r_01kzfb6py8pbxznqv022p2qkhb published
 *     `walks-blocked-by-site` because 41 walks ended this way; they had reached "that is the
 *     end of the survey".
 *
 * AND PROBE STEPS ARE EXCLUDED. Exploration probes exist to submit a screen without answering
 * it; a survey with correct validation answers them with a validation message, which is the
 * site WORKING. Counting that would rebuild the false accusation out of our own deliberate
 * misbehaviour. Recovery steps stay counted: a walk still blocked after answering validly is
 * genuine.
 */
export function blockedStepCount(obs: PathObservation): number {
  return obs.steps.filter((s: StepObservation) => {
    if (s.decisionSource === "probe") return false;
    return s.blockedReason === "validation-visible" || s.blockedReason === "control-disabled";
  }).length;
}

/**
 * A WALK THAT REACHED A TERMINAL PAGE WAS NOT REFUSED — whatever its `outcome` says.
 *
 * `classifyEnding` arm 0 (`browser/driver.ts`) REQUIRES `outcome: "blocked"` to recognise the
 * measured test-mode termination page: the survey printing "we are unable to accept your offer
 * to participate ... Terminated at S80" beside a ">>" the walker pressed twelve times without
 * the screen changing (run v2r_01m07qpwcjamfpcs89frs3syjs, screen 15). So on this platform a
 * CORRECTLY CLASSIFIED screen-out necessarily carries the outcome that `BLOCKING_OUTCOMES`
 * reads as proof the site refused us. Left alone, a screener behaving exactly as documented
 * manufactures the `walks-blocked-by-site` accusation that `resolveStopReason` below exists to
 * require evidence for — the gate intact, its input poisoned.
 *
 * ONLY THE OUTCOME ARM IS EXEMPTED, deliberately. `blockedSteps` counts steps where the walker
 * MEASURED the survey saying no to a non-probe answer (`blockedStepCount`, above) — that is
 * positive evidence of a refusal that happened, and it stays evidence even if the walk later
 * ran on to a terminal page. The termination page itself cannot forge one: its ">>" is present,
 * so `whyBlocked` types those steps `advance-timeout`, which `blockedStepCount` excludes.
 *
 * ABSENT IS NOT EXEMPT: a row with no `ending` (one written before endings were typed) keeps
 * counting exactly as before, and `stalled` / `unclassified` endings are not terminal.
 */
const reachedTerminalPage = (w: WalkRecord): boolean =>
  w.ending?.kind === "completed" || w.ending?.kind === "screened-out";

/** Did anything in this run actually get refused? Absent evidence is NOT evidence. */
export function hasBlockingEvidence(walks: readonly WalkRecord[]): boolean {
  return walks.some(
    (w) => (BLOCKING_OUTCOMES.has(w.outcome) && !reachedTerminalPage(w)) || (w.blockedSteps ?? 0) > 0,
  );
}

/**
 * WHY THE RUN STOPPED SHORT — and specifically, WHOSE FAULT IT WAS.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. This was `done && pending > 0 && stopReason === null →
 * "walks-blocked-by-site"`. That condition is "cases are still owed an observation" and
 * nothing else: it cannot tell "the site refused us" from "our own gate disqualified walks
 * that did everything asked of them". Run v2r_01kzfb6py8pbxznqv022p2qkhb published it against
 * a healthy customer survey that had refused NOTHING — 41 of 46 walks drove it to its terminal
 * screen. Per CLAUDE.md a confident wrong answer is the cardinal failure, and an unfounded
 * accusation about a customer's site is the worst-shaped one this pipeline can emit.
 *
 * So the accusation now requires evidence, and the shortfall keeps its own name.
 */
export function resolveStopReason(args: {
  done: boolean;
  pendingCases: number;
  stopReason: string | null;
  walks: readonly WalkRecord[];
}): string | null {
  if (args.stopReason !== null) return args.stopReason;
  if (!args.done || args.pendingCases <= 0) return null;
  return hasBlockingEvidence(args.walks) ? EXEC_STOP_WALKS_BLOCKED_BY_SITE : EXEC_STOP_COVERAGE_SHORTFALL;
}

const NOT_ASSESSED: ExercisedAssessment = {
  exercised: false,
  plannedDecisions: 0,
  matchedDecisions: 0,
  constrainingDecisions: 0,
  matchedConstraining: 0,
};

/**
 * The action sequence a walk actually performed, as comparable JSON — what was clicked,
 * typed and set, per step, in order, with success flags. Timing, captures and screen
 * payloads are deliberately excluded: two walks that ACTED identically fingerprint
 * identically even when the site rendered marginally differently around them. Exported
 * for the identical-actions pivot stop's tests.
 */
export function walkActionsJson(obs: PathObservation): string {
  return JSON.stringify(
    obs.steps.map((s) => [
      s.stepIndex,
      (s.actions ?? []).map((a) => {
        const row = a as { kind?: unknown; targetIdx?: unknown; value?: unknown; ok?: unknown };
        return [row.kind ?? null, row.targetIdx ?? null, row.value ?? null, row.ok !== false];
      }),
    ]),
  );
}

/**
 * LABEL COHERENCE — ONE DERIVATION, SHARED BY ALL THREE LAYERS.
 *
 * THE DEFECT THIS CLOSES. The walk-level outcome, the record row, and the report label each
 * independently decided what a walk's ending means:
 *   - `completenessFor` (project-observations.ts) reads `walk.ending.kind`
 *   - `reachedAnEnding` (assemble-record.mjs) reads `walk.ending.kind` AND `walk.outcome`
 * When any of these three independently re-derived what an ending means, they could disagree.
 * Now there is ONE function for each question, and all three layers call it.
 *
 * DID THE WALK REACH A REAL ENDING? True when the survey ended naturally (completed or
 * screened-out). False for stalled, unclassified, crashed, load-crash, or absent endings.
 * This is the function `reachedAnEnding` (assemble-record.mjs) and `completenessFor`
 * (project-observations.ts) must both call.
 */
export function walkReachedEnding(walk: Pick<WalkRecord, "ending" | "outcome" | "loadCrash">): boolean {
  if (walk.loadCrash) return false;
  const kind = walk.ending?.kind ?? null;
  if (kind === "completed" || kind === "screened-out") return true;
  if (kind === "stalled" || kind === "unclassified" || kind === "crashed") return false;
  // Legacy fallback: a row that predates typed endings uses the step-loop outcome.
  return walk.outcome === "completed" || walk.outcome === "no-advance-control";
}

/**
 * THE WALK, REDUCED TO A LEDGER ROW. Exported so the carry above can be tested directly:
 * driving a whole batch to prove that one field survives one function needs a browser, and a
 * property that can only be checked in a browser is a property this suite does not check.
 */
export function walkRecord(
  obs: PathObservation,
  caseIds: string[],
  audit: ExercisedAssessment = NOT_ASSESSED,
  /** BOUNDED SCREEN-OUT RETRY: set ONLY on a pivot walk. See `WalkRecord.pivot`. */
  pivot?: WalkRecord["pivot"],
  observationEvidenceId?: string,
): WalkRecord {
  return {
    ...audit,
    screensAdvanced: obs.steps.filter((s) => s.advanced).length,
    // COMPUTED HERE, NOT AT THE CALL SITE, so every record carries it — including the
    // load-crash record pushed before the shimmed retry, which is written by a different
    // call and would otherwise be a silent hole in the run-level evidence.
    blockedSteps: blockedStepCount(obs),
    // CARRIED ONLY WHEN THE PRODUCER SET IT, and then byte-for-byte. The conditional spread is
    // the point: `ending: obs.ending` would put the KEY on every record with the value
    // `undefined`, and a reader testing `"ending" in walk` would then see a walk that predates
    // the field as one that HAS an ending. There is no `??` on any line below, deliberately —
    // a default here is the whole defect, one hop earlier than where it was found.
    ...(obs.ending !== undefined ? { ending: obs.ending } : {}),
    ...(obs.unboundDecisions !== undefined ? { unboundDecisions: obs.unboundDecisions } : {}),
    ...(obs.bindingRefusalCount !== undefined ? { bindingRefusalCount: obs.bindingRefusalCount } : {}),
    ...(obs.readerLimitations !== undefined ? { readerLimitations: obs.readerLimitations } : {}),
    ...(obs.readerLimitationCount !== undefined ? { readerLimitationCount: obs.readerLimitationCount } : {}),
    // The pivot is the CALLER's fact, not the producer's — the walker does not know it is a
    // retry — but it travels by the same opt-in spread: without it, `"pivot" in walk` would
    // read every ordinary walk as one that HAS a (undefined) pivot.
    ...(pivot !== undefined ? { pivot } : {}),
    ...((observationEvidenceId ?? obs.observationEvidenceId) !== undefined
      ? { observationEvidenceId: observationEvidenceId ?? obs.observationEvidenceId }
      : {}),
    pathId: obs.pathId,
    tier: obs.tier,
    attemptId: obs.attemptId,
    outcome: obs.outcome,
    outcomeDetail: obs.outcomeDetail,
    steps: obs.steps.length,
    wallMs: obs.wallMs,
    shimmed: obs.shimmed,
    loadCrash: obs.loadFailure !== null,
    evidenceCount: obs.evidenceIds.length,
    caseIds,
    at: obs.endedAt,
  };
}
