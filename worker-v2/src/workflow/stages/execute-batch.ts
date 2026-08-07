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
import { loadProgram, type ExecutionProgram, type PathAssignment } from "./plan";
import { walkPath, type PageLike } from "../../browser/driver";
import type { CaptureContext } from "../../browser/capture";
import type { PathObservation } from "../../browser/types";
import type { PlannedPath } from "./planner/plan-core.js";

export const execProgressKey = (runId: string) => k("runs", runId, "execution", "progress.json");

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
  screensAdvanced: number;
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

/** What is still owed: floor paths first, then as much exploration as the caps allow. */
export function selectWork(program: ExecutionProgram, progress: ExecProgress, maxExploration: number): WorkItem[] {
  const out: WorkItem[] = [];
  const floorDone = new Set(progress.floorDone);
  for (const a of program.floor) {
    if (floorDone.has(a.pathId)) continue;
    const p = program.plan.floor.paths.find((x) => x.id === a.pathId);
    if (p) out.push({ path: p, tier: 1, assignment: a });
  }
  if (out.length > 0) return out; // FLOOR FIRST, ALWAYS. It is the contractual set.

  const expDone = new Set(progress.explorationDone);
  const budget = Math.max(0, maxExploration - expDone.size);
  if (budget === 0) return out;
  for (const e of program.plan.exploration.queue) {
    if (expDone.has(e.id)) continue;
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
    return { done: true, stopReason: "plan-missing", pathsWalked: 0, casesClosed: 0, steps: 0 };
  }
  const progress = await loadProgress(env, args.runId, args.planRevisionId);

  const maxExploration = num((env as unknown as { EXEC_MAX_EXPLORATION?: string }).EXEC_MAX_EXPLORATION, 0);
  const work = selectWork(program, progress, maxExploration);
  console.log(
    `v2 exec batch ${args.batch}: work=${work.length} floorDone=${progress.floorDone.length}/${program.floor.length} ` +
      `expDone=${progress.explorationDone.length} expBudget=${maxExploration} queue=${program.plan.exploration.queue.length}`,
  );
  if (work.length === 0) {
    return { done: true, stopReason: null, pathsWalked: 0, casesClosed: 0, steps: 0 };
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
      stopReason: "browser-unavailable",
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
      // PENDING, and the executing-close gate buckets them as blocked rather than
      // exercised.
      const plannedDecisions = Array.isArray(item.path.decisions) ? item.path.decisions.length : 0;
      const matchedDecisions = obs.steps.filter((s) => s.decisionSource === "plan" || s.decisionSource === "probe").length;
      const exercised = walkExercised(obs) && (plannedDecisions === 0 || matchedDecisions > 0);
      const closed =
        item.assignment && exercised
          ? item.assignment.caseIds.filter((id) => !args.cursor.completedCaseIds.includes(id))
          : [];
      const walkedOk = obs.outcome !== "error";

      progress.walks.push(walkRecord(obs, closed, { exercised, plannedDecisions, matchedDecisions }));
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
    stopReason = "executor-error";
  }

  const remaining = selectWork(program, progress, maxExploration).length;
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

  if (done && args.cursor.pendingCaseIds.length > 0 && stopReason === null) {
    // Every planned walk has been attempted and mandatory cases are still owed an
    // observation. That is a BLOCKED run, not a finished one, and it keeps its own name
    // so the report can say the site stopped the walk rather than the budget did.
    stopReason = "walks-blocked-by-site";
  }
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

function walkRecord(
  obs: PathObservation,
  caseIds: string[],
  audit: { exercised: boolean; plannedDecisions: number; matchedDecisions: number } = {
    exercised: false,
    plannedDecisions: 0,
    matchedDecisions: 0,
  },
): WalkRecord {
  return {
    ...audit,
    screensAdvanced: obs.steps.filter((s) => s.advanced).length,
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
