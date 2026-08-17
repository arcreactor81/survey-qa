/**
 * MULTI-LANE EXECUTION — several planned cases walked at the same time, each
 * lane in its own browser session.
 *
 * FLAG-GATED, DEFAULT OFF. When `EXEC_LANES` is "1" or absent, the existing
 * sequential `executeBatch` path runs unchanged. Multi-lane activates at "2"+.
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
 */

import type { Env } from "../../types/env";
import { num } from "../../types/env";
import { mintAttemptId } from "../../ids";
import { type Fence } from "../../store/checkpoint";
import { browserUsage, pushUsage } from "../../store/usage";
import type { ExecutionCursor } from "../../types/contracts";
import {
  retireSession,
  type SessionHandle,
} from "../browser-session";
import {
  type BatchArgs,
  type BatchOutcome,
  type WorkItem,
  type ExecProgress,
  walkDeadlineFor,
  withTimeout,
  BrowserTimeout,
  acquireWithRetry,
  emptyCursor,
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

/** Result from one lane's walk. */
export interface LaneResult {
  item: WorkItem;
  obs: PathObservation;
  attemptId: string;
  browserHung: boolean;
  perCaseTimedOut: boolean;
  /** Whether the lane's browser session should be considered wedged. */
  sessionWedged: boolean;
  /** Error detail if the lane's browser acquisition failed. */
  acquisitionError: string | null;
}

/**
 * Walk one lane: acquire a browser, walk the path, retire the browser.
 * Every browser session is retired in a finally block so a lane crash never
 * leaks a session.
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
    perCaseTimeoutMs: number;
    maxSteps: number;
    advanceTimeoutMs: number;
    shimRequired: boolean;
    allowShim: boolean;
    acquireTimeoutMs: number;
    priorAttempts: number;
    program: ExecutionProgram;
  },
): Promise<LaneResult> {
  const attemptId = mintAttemptId();
  let handle: SessionHandle | null = null;

  const makeErrorObs = (reason: string, detail: string): PathObservation => ({
    kind: "v2-path-observation/1.0.0",
    runId: args.runId,
    pathId: args.item.path.id,
    tier: args.item.tier,
    attemptId,
    planRevisionId: args.planRevisionId,
    surveyUrl: args.program.surveyUrl || args.surveyUrl,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    wallMs: 0,
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
    // Each lane acquires its own fresh browser — no session reuse across lanes.
    handle = await acquireWithRetry(env, { ...emptyCursor(), sessionId: null, sessionOpenedAt: null }, args.acquireTimeoutMs);
    await pushUsage(env, args.runId, args.fence, [browserUsage()]);

    const cap: CaptureContext = {
      env,
      runId: args.runId,
      attemptId,
      pathId: args.item.path.id,
      ...(args.priorAttempts > 0 ? { attemptOrdinal: args.priorAttempts } : {}),
      witnesses: Array.isArray(args.item.path.witnesses) ? (args.item.path.witnesses as string[]) : [],
    };

    const page = (await withTimeout(handle.browser.newPage(), 30_000, "newPage")) as PageLike;
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
              num(env.EXEC_BATCH_MAX_MS, 120_000),
              args.perCaseTimeoutMs,
            ),
            viewport: { width: 1280, height: 900 },
            applyHistoryShim: args.shimRequired && args.allowShim,
            advanceTimeoutMs: args.advanceTimeoutMs,
            variant: 0,
            variantFromStep: 0,
          },
          cap,
        ),
        args.perCaseTimeoutMs,
        `walk ${args.item.path.id}`,
      );
    } catch (err) {
      perCaseTimedOut = err instanceof BrowserTimeout;
      browserHung = perCaseTimedOut;
      obs = makeErrorObs(
        perCaseTimedOut ? "per-case-timeout" : "error",
        perCaseTimedOut
          ? `walk exceeded its per-case budget of ${args.perCaseTimeoutMs}ms`
          : String(err).slice(0, 500),
      );
    } finally {
      try {
        await page.close();
      } catch {
        /* a page that will not close must not lose the observation */
      }
    }

    // Handle load-crash shim retry within the lane
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
              num(env.EXEC_BATCH_MAX_MS, 120_000),
              args.perCaseTimeoutMs,
            ),
            viewport: { width: 1280, height: 900 },
            applyHistoryShim: true,
            advanceTimeoutMs: args.advanceTimeoutMs,
            variant: 0,
            variantFromStep: 0,
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
    };
  } catch (err) {
    // Lane-level catch: browser acquisition failure or unexpected error.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      item: args.item,
      obs: makeErrorObs("error", `lane error: ${detail.slice(0, 500)}`),
      attemptId,
      browserHung: false,
      perCaseTimedOut: false,
      sessionWedged: false,
      acquisitionError: detail,
    };
  } finally {
    // EVERY LANE RETIRES ITS OWN BROWSER SESSION.
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

// emptyCursor imported from execute-batch

/**
 * Run one wave of lanes concurrently with staggered launches.
 * Returns the results in lane order.
 */
export async function runLaneWave(
  env: Env,
  items: WorkItem[],
  laneArgs: Omit<Parameters<typeof walkLane>[1], "item" | "priorAttempts"> & {
    progress: ExecProgress;
  },
): Promise<LaneResult[]> {
  const lanePromises: Promise<LaneResult>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const priorAttempts = laneArgs.progress.walks.filter(
      (w) => w.pathId === item.path.id,
    ).length;

    lanePromises.push(
      walkLane(env, {
        ...laneArgs,
        item,
        priorAttempts,
      }),
    );

    // Stagger the NEXT lane launch (not after the last one).
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, LANE_STAGGER_MS));
    }
  }

  const settled = await Promise.allSettled(lanePromises);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    // This should not happen since walkLane catches internally, but defend.
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
        attemptId: "unknown",
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
      attemptId: "unknown",
      browserHung: false,
      perCaseTimedOut: false,
      sessionWedged: false,
      acquisitionError: detail,
    };
  });
}
