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
 * mid-batch must cost at most one walk. The session id is durable too, so the replacement
 * instance reconnects to the SAME browser instead of restarting the survey — the spike
 * proved keep_alive is an idle timeout that resets on activity, which is what makes
 * reconnect-per-step across Workflow step boundaries viable without a container runner.
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
import { browserUsage, pushUsage } from "../../store/usage";
import type { ExecutionCursor } from "../../types/contracts";
import {
  acquireSession,
  applySessionToCursor,
  releaseSession,
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
import { walkPath, type PageLike } from "../../browser/driver";
import type { CaptureContext } from "../../browser/capture";
import type { PathObservation, StepObservation, WalkEnding } from "../../browser/types";
import type { PlannedPath, PlannedDecision } from "./planner/plan-core.js";

export const execProgressKey = (runId: string) => k("runs", runId, "execution", "progress.json");

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

/** The complete set. A code not in here is a bug, not a new feature. */
export const EXEC_STOP_REASONS = [
  EXEC_STOP_PLAN_MISSING,
  EXEC_STOP_BROWSER_UNAVAILABLE,
  EXEC_STOP_EXECUTOR_ERROR,
  EXEC_STOP_WALKS_BLOCKED_BY_SITE,
  EXEC_STOP_COVERAGE_SHORTFALL,
  EXEC_STOP_REQUIRED_PROBE_UNSUPPORTED,
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
  /** Planned decisions no screen was ever identified as — the walk's account of what it did NOT do. */
  unboundDecisions?: PathObservation["unboundDecisions"];
  /** How many times a screen was refused a binding. The walker's name for it, kept. */
  bindingRefusalCount?: number;
  /** Every limitation the reader named on any screen of this walk, with the step it came from. */
  readerLimitations?: PathObservation["readerLimitations"];
  /** Total occurrences summed over screens. Counted by the walker, not recomputed here. */
  readerLimitationCount?: number;
  at: string;
}

export interface ExecProgress {
  kind: "v2-execution-progress/1.0.0";
  runId: string;
  planRevisionId: string;
  walks: WalkRecord[];
  floorDone: string[];
  explorationDone: string[];
  /** Set once a walk proves the site cannot load unshimmed. Later walks start shimmed. */
  shimRequired: boolean;
  /** Paths whose browser hung. A path here has had its one retry on a fresh session. */
  hungPaths?: string[];
  shimEvidence: string | null;
  totalSteps: number;
  totalEvidence: number;
}

const emptyProgress = (runId: string, planRevisionId: string): ExecProgress => ({
  kind: "v2-execution-progress/1.0.0",
  runId,
  planRevisionId,
  walks: [],
  floorDone: [],
  explorationDone: [],
  shimRequired: false,
  shimEvidence: null,
  hungPaths: [],
  totalSteps: 0,
  totalEvidence: 0,
});

export async function loadProgress(env: Env, runId: string, planRevisionId: string): Promise<ExecProgress> {
  const obj = await env.EVIDENCE.get(execProgressKey(runId));
  if (!obj) return emptyProgress(runId, planRevisionId);
  try {
    const p = (await obj.json()) as ExecProgress;
    return p && p.kind === "v2-execution-progress/1.0.0" ? p : emptyProgress(runId, planRevisionId);
  } catch {
    return emptyProgress(runId, planRevisionId);
  }
}

async function saveProgress(env: Env, p: ExecProgress): Promise<void> {
  await env.EVIDENCE.put(execProgressKey(p.runId), JSON.stringify(p), {
    httpMetadata: { contentType: "application/json" },
  });
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
async function acquireWithRetry(env: Env, cursor: ExecutionCursor | null, timeoutMs: number): Promise<SessionHandle> {
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

const emptyCursor = (): ExecutionCursor => ({
  batchIndex: 0,
  sessionId: null,
  sessionOpenedAt: null,
  pendingCaseIds: [],
  completedCaseIds: [],
  planRevisionId: null,
});

interface WorkItem {
  path: PlannedPath;
  tier: 1 | 2;
  assignment: PathAssignment | null;
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
    out.push({ path: p, tier: 1, assignment: a });
  }
  // FLOOR FIRST, ALWAYS. An unsupported floor path is still pending contractual work; do not
  // run optional exploration past it and make the run look further along than it is.
  if (pendingFloor > 0) return out;

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
    out.push({ path: e as unknown as PlannedPath, tier: 2, assignment: null });
    if (out.length >= budget) break;
  }
  return out;
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
  const maxSteps = num((env as unknown as { EXEC_MAX_STEPS_PER_PATH?: string }).EXEC_MAX_STEPS_PER_PATH, 40);
  const advanceTimeoutMs = num((env as unknown as { EXEC_ADVANCE_TIMEOUT_MS?: string }).EXEC_ADVANCE_TIMEOUT_MS, 3500);
  const allowShim = (env as unknown as { BROWSER_COMPAT_SHIMS?: string }).BROWSER_COMPAT_SHIMS !== "off";

  const acquireTimeoutMs = num((env as unknown as { EXEC_ACQUIRE_TIMEOUT_MS?: string }).EXEC_ACQUIRE_TIMEOUT_MS, 45_000);
  const walkTimeoutMs = num((env as unknown as { EXEC_WALK_TIMEOUT_MS?: string }).EXEC_WALK_TIMEOUT_MS, 150_000);

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

  let pathsWalked = 0;
  let sessionWedged = false;
  let casesClosed = 0;
  let steps = 0;
  let stopReason: string | null = null;

  try {
    for (const item of work) {
      if (pathsWalked >= maxAttempts || Date.now() >= batchDeadline) break;

      const attemptId = mintAttemptId();
      await updateCheckpoint(
        env,
        args.runId,
        (d) => {
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

      const cap: CaptureContext = {
        env,
        runId: args.runId,
        attemptId,
        pathId: item.path.id,
        witnesses: Array.isArray(item.path.witnesses) ? (item.path.witnesses as string[]) : [],
      };

      const walkOnce = async (shim: boolean): Promise<PathObservation> => {
        const page = (await withTimeout(handle.browser.newPage(), 30_000, "newPage")) as PageLike;
        try {
          return await walkPath(
            page,
            item.path,
            {
              surveyUrl: program.surveyUrl || args.surveyUrl,
              runId: args.runId,
              planRevisionId: args.planRevisionId,
              attemptId,
              tier: item.tier,
              maxSteps,
              deadline: Math.min(batchDeadline, Date.now() + num(env.EXEC_BATCH_MAX_MS, 120_000)),
              viewport: { width: 1280, height: 900 },
              applyHistoryShim: shim,
              advanceTimeoutMs,
            },
            cap,
          );
        } finally {
          try {
            await page.close();
          } catch {
            /* a page that will not close must not lose the observation */
          }
        }
      };

      let obs: PathObservation;
      let browserHung = false;
      try {
        obs = await withTimeout(walkOnce(progress.shimRequired && allowShim), walkTimeoutMs, `walk ${item.path.id}`);
      } catch (err) {
        browserHung = err instanceof BrowserTimeout;
        obs = {
          kind: "v2-path-observation/1.0.0",
          runId: args.runId,
          pathId: item.path.id,
          tier: item.tier,
          attemptId,
          planRevisionId: args.planRevisionId,
          surveyUrl: program.surveyUrl || args.surveyUrl,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          wallMs: 0,
          plannedWitnesses: [],
          steps: [],
          outcome: browserHung ? "browser-hung" : "error",
          outcomeDetail: String(err).slice(0, 500),
          shimmed: false,
          shimNote: null,
          loadFailure: null,
          evidenceIds: [],
          viewport: { width: 1280, height: 900 },
        };
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
      const closed =
        item.assignment && exercised
          ? item.assignment.caseIds.filter((id) => !args.cursor.completedCaseIds.includes(id))
          : [];
      const walkedOk = obs.outcome !== "error";

      progress.walks.push(walkRecord(obs, closed, audit));
      progress.totalSteps += obs.steps.length;
      progress.totalEvidence += obs.evidenceIds.length;

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

      if (!retryable) {
        if (item.tier === 1) {
          if (!progress.floorDone.includes(item.path.id)) progress.floorDone.push(item.path.id);
        } else if (!progress.explorationDone.includes(item.path.id)) {
          progress.explorationDone.push(item.path.id);
        }
      }
      await saveProgress(env, progress);

      // ---- COMMIT: one durable write per path ----
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
          return true;
        },
        { progressed: true, fence: args.fence },
      );

      // Keep the in-memory cursor in step with what we just committed, so a second path
      // in this same batch does not re-close cases the first one already closed.
      args.cursor.completedCaseIds = [...args.cursor.completedCaseIds, ...closed];
      args.cursor.pendingCaseIds = args.cursor.pendingCaseIds.filter((id) => !closed.includes(id));

      pathsWalked += 1;
      casesClosed += closed.length;
      steps += obs.steps.length;

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

  if (sessionWedged || done) {
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
  } else {
    await closeSession(() => releaseSession(handle), "session disconnect");
  }

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
  return { done, stopReason, pathsWalked, casesClosed, steps };
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

/** Did anything in this run actually get refused? Absent evidence is NOT evidence. */
export function hasBlockingEvidence(walks: readonly WalkRecord[]): boolean {
  return walks.some((w) => BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0);
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
 * THE WALK, REDUCED TO A LEDGER ROW. Exported so the carry above can be tested directly:
 * driving a whole batch to prove that one field survives one function needs a browser, and a
 * property that can only be checked in a browser is a property this suite does not check.
 */
export function walkRecord(obs: PathObservation, caseIds: string[], audit: ExercisedAssessment = NOT_ASSESSED): WalkRecord {
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
