/**
 * MULTI-LANE EXECUTION — several planned cases walked at the same time, each
 * lane in its own browser session.
 *
 * FLAG-GATED, DEFAULT OFF. When `EXEC_LANES` is "1" or absent, the existing
 * sequential `executeBatch` path runs unchanged — this module is not even
 * imported (review fix D). Multi-lane activates at "2"+.
 *
 * CLOUDFLARE BROWSER RENDERING LIMITS (verified against their docs):
 *   - max 120 concurrent browsers per account
 *   - max 1 browser launch per second
 * A previous run DIED from launch contention. Lanes are staggered >= 1500ms
 * apart and the concurrent lane count is hard-capped at 4.
 *
 * ASSUMPTION, STATED (CLAUDE.md): this module assumes each planned path is
 * independent and can be walked in any order. Where that does not hold (a path
 * requires seeing another path's effect, or a seed alternative needs sequential
 * checkpoint reservation), the work is excluded from parallel waves and walked
 * sequentially. If the assumption fails on an unseen survey, the walks produce
 * independent observations and the existing exercised gate catches the gap.
 *
 * WHAT STAYS SEQUENTIAL (wiring contract):
 *   - Seed alternatives: checkpoint reservation protocol requires sequential
 *     exclusive access.
 *   - Screen-out pivots: pivots for a lane's screened-out walk run AFTER the
 *     wave settles, in the existing sequential pivot loop, with the
 *     identical-actions stop intact.
 *   - Per-attempt commits: walkRecord push, saveProgress, updateCheckpoint,
 *     cursor sync are applied to each lane's result ONE AT A TIME after the
 *     wave, so no two checkpoint writes interleave.
 *
 * USAGE STORE SAFETY (review fix A): `pushUsage` calls `updateCheckpoint`
 * which uses CAS (compare-and-swap with etag/onlyIf). Under concurrent
 * writers, CAS retries on contention, but `pushUsage` wraps the whole call
 * in try/catch and logs failures — so a concurrent lane's usage push can be
 * SILENTLY LOST if the checkpoint changes between read and write and the
 * retry budget exhausts. Browser usage is declared best-effort in usage.ts
 * line 89 ("Browser telemetry remains best-effort"), BUT losing browser
 * session counts understates `toolCalls.used`, which is a cap counter.
 * Therefore: usage pushes are collected from lanes and applied in the
 * sequential post-wave commit step, one checkpoint write per wave.
 */

import type { Env } from "../../types/env";
import { num } from "../../types/env";
import { mintAttemptId } from "../../ids";
import { type Fence } from "../../store/checkpoint";
import { browserUsage } from "../../store/usage";
import type { BrowserSessionUsageEvent } from "../../types/contracts";
import {
  retireSession,
  type SessionHandle,
} from "../browser-session";
import {
  type WorkItem,
  type ExecProgress,
  type StartupSubPhase,
  walkDeadlineFor,
  withTimeout,
  BrowserTimeout,
  acquireWithRetry,
  emptyCursor,
  hungStartupPhase,
  walkNeverStarted,
} from "./execute-batch";
import { type ExecutionProgram } from "./plan";
import { walkPath, type PageLike } from "../../browser/driver";
import type { CaptureContext } from "../../browser/capture";
import type { PathObservation } from "../../browser/types";

/** Minimum gap between consecutive browser launches (ms). */
export const LANE_STAGGER_MS = 1500;

/** Hard ceiling on concurrent lanes, regardless of EXEC_LANES. */
export const LANE_CAP = 4;

/**
 * Read the effective lane count from config. Clamps to [1, LANE_CAP] and logs
 * when clamping occurs.
 */
export function effectiveLaneCount(env: Env): number {
  const requested = num((env as unknown as { EXEC_LANES?: string }).EXEC_LANES, 1);
  const effective = Math.min(Math.max(1, requested), LANE_CAP);
  if (effective !== requested) {
    console.log(
      `v2 exec: EXEC_LANES=${requested} clamped to ${effective} (hard ceiling ${LANE_CAP})`,
    );
  }
  return effective;
}

/** Whether multi-lane is active. */
export function isMultiLane(env: Env): boolean {
  return effectiveLaneCount(env) > 1;
}

/**
 * Callback a lane uses to register its live browser handle into the wave-level
 * zombie backstop registry. The backstop owns the decision to force-close;
 * the lane owns the decision to register and deregister (via finally). This
 * separation means a lane that crashes in its own finally block does not
 * prevent the backstop from closing its browser — the handle is already in the
 * registry before the lane's try block starts.
 */
export type RegisterBrowserHandle = (handle: SessionHandle) => void;

/** Result from one lane's walk. */
export interface LaneResult {
  item: WorkItem;
  obs: PathObservation;
  attemptId: string;
  browserHung: boolean;
  perCaseTimedOut: boolean;
  sessionWedged: boolean;
  acquisitionError: string | null;
  /**
   * Browser usage events collected during this lane's walk. Applied in the
   * sequential post-wave commit step, never from inside the concurrent lane
   * (review fix A: pushUsage uses CAS checkpoint writes, which under
   * concurrent writers can lose events silently).
   */
  usageEvents: BrowserSessionUsageEvent[];
  /**
   * STARTUP INSTRUMENTATION: which sub-phases of the startup the lane completed
   * before the walk's per-case timeout (or startup budget) fired. Empty means
   * "page-create never finished". Each lane gets its own tracker, mirroring
   * the sequential path where each walkOnce has its own startupPhases array.
   */
  startupPhases: StartupSubPhase[];
}

/**
 * Walk one lane: acquire a browser, walk the path, retire the browser.
 * Every browser session is retired in a finally block so a lane crash never
 * leaks a session.
 *
 * Review fix C: `batchMaxMs` is threaded from the caller's resolved value
 * instead of re-reading env with a potentially different fallback. The
 * sequential path resolves `num(env.EXEC_BATCH_MAX_MS, 120_000)` once at
 * batch start; this function receives that resolved value.
 *
 * WAVE ZOMBIE BACKSTOP (0a): the lane REGISTERS its acquired browser handle
 * into the wave-level registry via `registerBrowserHandle`, so the backstop
 * timer can force-close every lane's browser when a wave hangs. The lane
 * still owns its own retirement in a finally block — the backstop is the
 * LAST resort, not the primary cleanup.
 */
export async function walkLane(
  env: Env,
  args: {
    runId: string;
    batch: number;
    planRevisionId: string;
    surveyUrl: string;
    fence: Fence;
    item: WorkItem;
    batchDeadline: number;
    batchMaxMs: number;
    perCaseTimeoutMs: number;
    maxSteps: number;
    advanceTimeoutMs: number;
    shimRequired: boolean;
    allowShim: boolean;
    acquireTimeoutMs: number;
    priorAttempts: number;
    program: ExecutionProgram;
    attemptId: string;
    variant?: number;
    variantFromStep?: number;
    /**
     * FORWARD RELEASE MAX WAIT — the ceiling on waiting for a withheld forward
     * control to open (a forced-exposure / minimum-dwell gate). Threading this
     * from the caller mirrors the sequential path, which reads
     * EXEC_FORWARD_RELEASE_MAX_WAIT_MS once at batch start.
     */
    forwardReleaseMaxWaitMs?: number;
    /**
     * STARTUP BUDGET — the wall-clock cap on the stretch between "session
     * acquired" and "first step recorded". Each lane gets its own budget,
     * mirroring the sequential path's per-walk startup budget. The budget is
     * resolved once by the caller (executeMultiLaneBatch) and threaded here
     * so every lane in a wave uses the same resolved value.
     */
    startupBudgetMs?: number;
    /**
     * WAVE ZOMBIE BACKSTOP (0a): callback to register this lane's browser
     * handle into the wave-level registry. When present, the lane registers
     * its handle immediately after acquisition so the backstop can force-close
     * it if the wave hangs.
     */
    registerBrowserHandle?: RegisterBrowserHandle;
  },
): Promise<LaneResult> {
  const attemptId = args.attemptId;
  let handle: SessionHandle | null = null;
  const usageEvents: BrowserSessionUsageEvent[] = [];
  // STARTUP PHASE TRACKING (0c): each lane gets its own tracker, exactly
  // mirroring the sequential path where each walkOnce has its own
  // startupPhases array. The phases are: page-create, survey-load, first-read.
  const startupPhases: StartupSubPhase[] = [];

  const makeErrorObs = (reason: string, detail: string, wallMs = 0, startedAt?: string): PathObservation => ({
    kind: "v2-path-observation/1.0.0",
    runId: args.runId,
    pathId: args.item.path.id,
    tier: args.item.tier,
    attemptId,
    planRevisionId: args.planRevisionId,
    surveyUrl: args.program.surveyUrl || args.surveyUrl,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    wallMs,
    plannedWitnesses: [],
    steps: [],
    outcome: reason,
    outcomeDetail: detail,
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    evidenceIds: [],
    viewport: { width: 1280, height: 900 },
  });

  try {
    handle = await acquireWithRetry(env, { ...emptyCursor(), sessionId: null, sessionOpenedAt: null }, args.acquireTimeoutMs);
    usageEvents.push(browserUsage());

    // WAVE ZOMBIE BACKSTOP (0a): register the handle so the wave-level
    // timer can force-close this lane's browser if the wave hangs. The
    // registration happens BEFORE any page work so the backstop can act
    // even if newPage itself hangs.
    args.registerBrowserHandle?.(handle);

    const cap: CaptureContext = {
      env,
      runId: args.runId,
      attemptId,
      pathId: args.item.path.id,
      ...(args.priorAttempts > 0 ? { attemptOrdinal: args.priorAttempts } : {}),
      witnesses: Array.isArray(args.item.path.witnesses) ? (args.item.path.witnesses as string[]) : [],
    };

    const walkStartMs = Date.now();
    const page = (await withTimeout(handle.browser.newPage(), 30_000, "newPage")) as PageLike;
    startupPhases.push("page-create");
    let obs: PathObservation;
    let browserHung = false;
    let perCaseTimedOut = false;
    try {
      obs = await withTimeout(
        walkPath(
          page,
          args.item.path,
          {
            surveyUrl: args.program.surveyUrl || args.surveyUrl,
            runId: args.runId,
            planRevisionId: args.planRevisionId,
            attemptId,
            tier: args.item.tier,
            maxSteps: args.maxSteps,
            deadline: walkDeadlineFor(
              args.batchDeadline,
              Date.now(),
              args.batchMaxMs,
              args.perCaseTimeoutMs,
            ),
            viewport: { width: 1280, height: 900 },
            applyHistoryShim: args.shimRequired && args.allowShim,
            advanceTimeoutMs: args.advanceTimeoutMs,
            // FORWARD RELEASE MAX WAIT (0c): threaded from the caller, mirroring
            // the sequential path which reads EXEC_FORWARD_RELEASE_MAX_WAIT_MS
            // once at batch start and passes the resolved value to every walkOnce.
            ...(args.forwardReleaseMaxWaitMs !== undefined
              ? { forwardReleaseMaxWaitMs: args.forwardReleaseMaxWaitMs }
              : {}),
            variant: args.variant ?? 0,
            variantFromStep: args.variantFromStep ?? 0,
            // STARTUP PHASE INSTRUMENTATION (0c): the driver calls this at two
            // transitions (after page.goto and after first screen read), so a
            // "walk-never-started" outcome names WHICH sub-phase hung.
            onStartupPhase: (phase: "survey-load" | "first-read") => { startupPhases.push(phase); },
          },
          cap,
        ),
        args.perCaseTimeoutMs,
        `walk ${args.item.path.id}`,
      );
    } catch (err) {
      const elapsedMs = Date.now() - walkStartMs;
      perCaseTimedOut = err instanceof BrowserTimeout;
      // STARTUP BUDGET DISCRIMINATION (0c): if the walk has no steps AND the
      // startup sub-phases never reached "first-read", the hang was in the
      // pre-first-step stretch and the outcome is "walk-never-started" — an
      // infrastructure fact about THIS attempt, not a site accusation. Mirrors
      // the sequential path's startup-budget detection.
      const neverStarted = walkNeverStarted(perCaseTimedOut, startupPhases);
      browserHung = perCaseTimedOut;
      obs = makeErrorObs(
        neverStarted ? "walk-never-started" : perCaseTimedOut ? "per-case-timeout" : "error",
        neverStarted
          ? `walk never started: hung in ${hungStartupPhase(startupPhases)} after ${elapsedMs}ms (startup budget ${args.startupBudgetMs ?? "unset"}ms, phases completed: ${startupPhases.join(", ") || "none"})`
          : perCaseTimedOut
            ? `walk exceeded its per-case budget of ${args.perCaseTimeoutMs}ms`
            : String(err).slice(0, 500),
        elapsedMs,
        new Date(walkStartMs).toISOString(),
      );
    } finally {
      try {
        await page.close();
      } catch {
        /* a page that will not close must not lose the observation */
      }
    }

    // STARTUP BUDGET RETRY (0c): a walk that never started gets ONE retry on a
    // completely fresh page in THIS LANE's own session — mirroring the sequential
    // path's retry. The premise is the same: a dead browser page or a hung goto
    // is transient. The retry uses the SAME attemptId/cap because the first attempt
    // produced no artifacts — there is nothing to collide with.
    if (obs.outcome === "walk-never-started") {
      console.log(
        `v2 exec lane ${args.item.path.id}: walk-never-started ` +
          `(hung in ${hungStartupPhase(startupPhases)}, ${obs.wallMs}ms) — retrying once on a fresh page`,
      );
      const retryStartupPhases: StartupSubPhase[] = [];
      const retryStartMs = Date.now();
      const retryPage = (await withTimeout(handle.browser.newPage(), 30_000, "newPage (startup retry)")) as PageLike;
      retryStartupPhases.push("page-create");
      try {
        obs = await withTimeout(
          walkPath(
            retryPage,
            args.item.path,
            {
              surveyUrl: args.program.surveyUrl || args.surveyUrl,
              runId: args.runId,
              planRevisionId: args.planRevisionId,
              attemptId,
              tier: args.item.tier,
              maxSteps: args.maxSteps,
              deadline: walkDeadlineFor(
                args.batchDeadline,
                Date.now(),
                args.batchMaxMs,
                args.perCaseTimeoutMs,
              ),
              viewport: { width: 1280, height: 900 },
              applyHistoryShim: args.shimRequired && args.allowShim,
              advanceTimeoutMs: args.advanceTimeoutMs,
              ...(args.forwardReleaseMaxWaitMs !== undefined
                ? { forwardReleaseMaxWaitMs: args.forwardReleaseMaxWaitMs }
                : {}),
              variant: args.variant ?? 0,
              variantFromStep: args.variantFromStep ?? 0,
              onStartupPhase: (phase: "survey-load" | "first-read") => { retryStartupPhases.push(phase); },
            },
            cap,
          ),
          // The retry uses the startup budget as its timeout — no point waiting
          // longer than the startup budget for something that should complete in <15s.
          args.startupBudgetMs ?? args.perCaseTimeoutMs,
          `walk ${args.item.path.id} startup-retry`,
        );
        // The retry started successfully. Reset the browserHung flag.
        browserHung = false;
        perCaseTimedOut = false;
        // Replace the startupPhases with the retry's phases for reporting.
        startupPhases.length = 0;
        startupPhases.push(...retryStartupPhases);
      } catch (retryErr) {
        const retryElapsedMs = Date.now() - retryStartMs;
        const retryTimedOut = retryErr instanceof BrowserTimeout;
        const retryNeverStarted = walkNeverStarted(retryTimedOut, retryStartupPhases);
        browserHung = retryTimedOut;
        perCaseTimedOut = retryTimedOut;
        obs = makeErrorObs(
          retryNeverStarted ? "walk-never-started" : retryTimedOut ? "per-case-timeout" : "error",
          retryNeverStarted
            ? `walk never started (retry): hung in ${hungStartupPhase(retryStartupPhases)} after ${retryElapsedMs}ms (startup budget ${args.startupBudgetMs ?? "unset"}ms, phases completed: ${retryStartupPhases.join(", ") || "none"})`
            : retryTimedOut ? `walk exceeded its per-case budget of ${args.startupBudgetMs ?? args.perCaseTimeoutMs}ms (startup retry)` : String(retryErr).slice(0, 500),
          retryElapsedMs,
          new Date(retryStartMs).toISOString(),
        );
        // Keep the retry's phases for reporting.
        startupPhases.length = 0;
        startupPhases.push(...retryStartupPhases);
      } finally {
        try {
          await retryPage.close();
        } catch {
          /* */
        }
      }
    }

    if (obs.outcome === "load-crash" && args.allowShim && !obs.shimmed) {
      const shimPage = (await withTimeout(handle.browser.newPage(), 30_000, "newPage")) as PageLike;
      try {
        obs = await walkPath(
          shimPage,
          args.item.path,
          {
            surveyUrl: args.program.surveyUrl || args.surveyUrl,
            runId: args.runId,
            planRevisionId: args.planRevisionId,
            attemptId,
            tier: args.item.tier,
            maxSteps: args.maxSteps,
            deadline: walkDeadlineFor(
              args.batchDeadline,
              Date.now(),
              args.batchMaxMs,
              args.perCaseTimeoutMs,
            ),
            viewport: { width: 1280, height: 900 },
            applyHistoryShim: true,
            advanceTimeoutMs: args.advanceTimeoutMs,
            ...(args.forwardReleaseMaxWaitMs !== undefined
              ? { forwardReleaseMaxWaitMs: args.forwardReleaseMaxWaitMs }
              : {}),
            variant: args.variant ?? 0,
            variantFromStep: args.variantFromStep ?? 0,
          },
          cap,
        );
      } finally {
        try {
          await shimPage.close();
        } catch {
          /* */
        }
      }
    }

    return {
      item: args.item,
      obs,
      attemptId,
      browserHung,
      perCaseTimedOut,
      sessionWedged: browserHung,
      acquisitionError: null,
      usageEvents,
      startupPhases,
    };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      item: args.item,
      obs: makeErrorObs("error", `lane error: ${detail.slice(0, 500)}`),
      attemptId,
      browserHung: false,
      perCaseTimedOut: false,
      sessionWedged: false,
      acquisitionError: detail,
      usageEvents,
      startupPhases,
    };
  } finally {
    if (handle) {
      try {
        await withTimeout(retireSession(handle), 20_000, "lane session close");
      } catch (err) {
        console.error(
          `v2 exec: lane session close failed: ${String(err).slice(0, 200)}`,
        );
      }
    }
  }
}

/**
 * Run one wave of lanes concurrently with staggered launches.
 * Returns the results in lane order.
 *
 * Review fix B: each lane's attemptId is pre-minted BEFORE launch, so the
 * Promise.allSettled fallback uses a real id, never "unknown".
 *
 * WAVE ZOMBIE BACKSTOP (0a): accepts a `registerBrowserHandle` callback and
 * threads it to each lane. The wave caller (executeMultiLaneBatch) owns the
 * backstop timer and the handle registry; this function is the relay that
 * connects lanes to that registry.
 */
export async function runLaneWave(
  env: Env,
  items: WorkItem[],
  laneArgs: Omit<Parameters<typeof walkLane>[1], "item" | "priorAttempts" | "attemptId"> & {
    progress: ExecProgress;
  },
): Promise<LaneResult[]> {
  const lanePromises: Promise<LaneResult>[] = [];
  const preMintedIds: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const attemptId = mintAttemptId();
    preMintedIds.push(attemptId);
    const priorAttempts = laneArgs.progress.walks.filter(
      (w) => w.pathId === item.path.id,
    ).length;

    lanePromises.push(
      walkLane(env, {
        ...laneArgs,
        item,
        priorAttempts,
        attemptId,
      }),
    );

    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, LANE_STAGGER_MS));
    }
  }

  const settled = await Promise.allSettled(lanePromises);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const detail = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);
    return {
      item: items[index]!,
      obs: {
        kind: "v2-path-observation/1.0.0" as const,
        runId: laneArgs.runId,
        pathId: items[index]!.path.id,
        tier: items[index]!.tier,
        attemptId: preMintedIds[index]!,
        planRevisionId: laneArgs.planRevisionId,
        surveyUrl: laneArgs.surveyUrl,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        wallMs: 0,
        plannedWitnesses: [],
        steps: [],
        outcome: "error" as const,
        outcomeDetail: `lane promise rejected: ${detail.slice(0, 500)}`,
        shimmed: false,
        shimNote: null,
        loadFailure: null,
        evidenceIds: [],
        viewport: { width: 1280, height: 900 },
      } as PathObservation,
      attemptId: preMintedIds[index]!,
      browserHung: false,
      perCaseTimedOut: false,
      sessionWedged: false,
      acquisitionError: detail,
      usageEvents: [],
      startupPhases: [],
    };
  });
}
