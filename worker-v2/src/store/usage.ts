/**
 * USAGE TRACKING — records every model call and browser session as an immutable event
 * and updates the cumulative counters that the four budget caps read.
 *
 * `capExceeded()` in run-workflow.ts checks `usage.modelCalls.used`, `usage.cost.usedUsd`,
 * `usage.toolCalls.used` and `usage.wallClock.usedMilliseconds` before every execution
 * batch. Without events pushing data to those counters, the caps are structural guards
 * with nothing behind them.
 *
 * THIS MUST NEVER FAIL THE PIPELINE. Every call is wrapped in try/catch — a usage-tracking
 * write that fails must not stop a run that is otherwise working.
 */

import type { Env } from "../types/env";
import type { UsageEvent } from "../types/contracts";
import { updateCheckpoint, type Fence } from "./checkpoint";

export type { UsageEvent };

export function modelUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): UsageEvent {
  return { kind: "model-call", model, inputTokens, outputTokens, costUsd, at: new Date().toISOString() };
}

export function browserUsage(): UsageEvent {
  return { kind: "browser-session", at: new Date().toISOString() };
}

/**
 * WALL-CLOCK TICK — the only writer of `usage.wallClock.usedMilliseconds`.
 *
 * Before this function existed, the wall-clock cap was enforced against a counter nothing
 * ever incremented: `capExceeded` read `usedMilliseconds` and every value stayed 0, so
 * `wall-clock-cap` was structurally incapable of firing — a cap that cannot fail. Each
 * tick writes the elapsed time since the run started, so the cap finally has a number to
 * compare. The checkpoint carries `startedAtMs` so the write is a pure recomputation and
 * never drifts with retries (a replacement instance recomputes from the same origin).
 *
 * THIS MUST NEVER FAIL THE PIPELINE, same as pushUsage.
 */
export async function tickWallClock(env: Env, runId: string, fence: Fence): Promise<void> {
  try {
    await updateCheckpoint(
      env,
      runId,
      (d) => {
        const w = d.usage.wallClock;
        if (!w.startedAtMs) w.startedAtMs = Date.now();
        w.usedMilliseconds = Math.max(w.usedMilliseconds, Date.now() - w.startedAtMs);
      },
      { progressed: true, fence },
    );
  } catch (err) {
    console.error(`wall-clock tick failed for ${runId}:`, err);
  }
}

export async function pushUsage(
  env: Env,
  runId: string,
  fence: Fence,
  events: UsageEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    await updateCheckpoint(
      env,
      runId,
      (d) => {
        d.usage.events = [...(d.usage.events ?? []), ...events];
        for (const e of events) {
          if (e.kind === "model-call") {
            d.usage.modelCalls.used += 1;
            d.usage.cost.usedUsd = Math.round((d.usage.cost.usedUsd + (e.costUsd ?? 0)) * 1e6) / 1e6;
          }
          if (e.kind === "browser-session") {
            d.usage.browserSessions.used += 1;
            d.usage.toolCalls.used += 1;
          }
        }
      },
      { progressed: true, fence },
    );
  } catch (err) {
    console.error(`usage push failed for ${runId}:`, err);
  }
}
