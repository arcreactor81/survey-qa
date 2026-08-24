/**
 * BROWSER SESSIONS — ONE FRESH BROWSER PER BATCH.
 *
 * This module encodes the runtime spike result (spikes/runtime-br), which is the finding
 * that removed the container runner from the v2 architecture:
 *
 *   `keep_alive` is an IDLE timeout that RESETS ON ACTIVITY. Sessions survived gaps of
 *   30 / 60 / 90 / 150 / 300 seconds with PAGE STATE INTACT across reconnects, and lived
 *   about 11 minutes in total.
 *
 * Consequences, and the rules that follow from them:
 *
 *  1. ONE FRESH BROWSER PER BATCH. Each `execute-batch` step launches a new browser and
 *     closes it at the end (see execute-batch.ts line ~2472). Reuse across batches ended
 *     with the long-walk budgets (2026-08-17): a walk may now run ~9 minutes, and the
 *     platform enforces a measured ~11-minute total-session wall, so a walk starting on a
 *     session another batch already aged would hit that wall mid-walk. A fresh launch per
 *     batch costs one session create and buys every batch the full wall.
 *  2. THE SESSION ID IS DURABLE STATE. It lives in the checkpoint's `ExecutionCursor` for
 *     use WITHIN a batch (e.g. the acquireWithRetry cold-start retry and the
 *     sessionExpired guard), but is cleared to null at every batch boundary so the next
 *     batch always launches fresh.
 *  3. `SESSION_MAX_AGE_MS` (default 8 min) proactively retires a session while it is
 *     still healthy, rather than discovering the ~11-minute wall mid-attempt.
 *  4. A LOST SESSION IS NORMAL, NOT AN ERROR. `acquireSession` transparently relaunches
 *     and reports `reconnected: false` so the caller can record that the page state was
 *     lost and re-establish position, instead of silently observing the wrong screen.
 *
 * The step-level batching that keeps each step inside its own wall-clock budget lives in
 * run-workflow.ts; this module owns only the session lifecycle.
 */

import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../types/env";
import { num } from "../types/env";
import type { ExecutionCursor } from "../types/contracts";

export interface SessionHandle {
  browser: BrowserLike;
  sessionId: string;
  /** false => the previous session was gone and this is a fresh browser; page state lost. */
  reconnected: boolean;
  openedAt: string;
}

/**
 * Structural type over the puppeteer browser surface v2 uses. Declared here rather than
 * imported so the orchestration code can be reasoned about (and unit-substituted) without
 * dragging the whole puppeteer type graph through every module.
 */
export interface BrowserLike {
  sessionId(): string;
  disconnect(): Promise<void>;
  close(): Promise<void>;
  newPage(): Promise<unknown>;
  pages(): Promise<unknown[]>;
}

const asBrowser = (b: unknown): BrowserLike => b as BrowserLike;

export function sessionExpired(env: Env, cursor: ExecutionCursor | null, now: number): boolean {
  if (!cursor?.sessionOpenedAt) return false;
  const maxAge = num(env.SESSION_MAX_AGE_MS, 480_000);
  return now - Date.parse(cursor.sessionOpenedAt) >= maxAge;
}

/**
 * Reattach to the run's session, or launch a new one. Call at the START of every step
 * that touches the browser; pair with `releaseSession` in a finally block.
 */
export async function acquireSession(env: Env, cursor: ExecutionCursor | null): Promise<SessionHandle> {
  const keepAlive = num(env.BROWSER_KEEP_ALIVE_MS, 600_000);
  const existing = cursor?.sessionId ?? null;

  if (existing && !sessionExpired(env, cursor, Date.now())) {
    try {
      const browser = asBrowser(await puppeteer.connect(env.BROWSER as never, existing));
      return {
        browser,
        sessionId: browser.sessionId(),
        reconnected: true,
        openedAt: cursor?.sessionOpenedAt ?? new Date().toISOString(),
      };
    } catch (err) {
      // Expected outcome, not a failure: the idle timer won, or the ~11min wall was hit.
      console.log(`browser: reconnect to ${existing} failed (${String(err).slice(0, 160)}); relaunching`);
    }
  }

  const browser = asBrowser(await puppeteer.launch(env.BROWSER as never, { keep_alive: keepAlive } as never));
  return { browser, sessionId: browser.sessionId(), reconnected: false, openedAt: new Date().toISOString() };
}

/**
 * End the step's hold WITHOUT ending the session. This is the call that makes long
 * browser work survive step boundaries; using close() here is the single mistake that
 * would silently reintroduce the need for a container runner.
 */
export async function releaseSession(handle: SessionHandle): Promise<void> {
  try {
    await handle.browser.disconnect();
  } catch (err) {
    console.error(`browser: disconnect failed for ${handle.sessionId}:`, err);
  }
}

/** The ONLY place v2 destroys a browser: end of run, or proactive age-based recycle. */
export async function retireSession(handle: SessionHandle): Promise<void> {
  try {
    await handle.browser.close();
  } catch (err) {
    console.error(`browser: close failed for ${handle.sessionId}:`, err);
  }
}

/** Fold the session facts back into the durable cursor before the checkpoint is written. */
export function applySessionToCursor(cursor: ExecutionCursor, handle: SessionHandle): ExecutionCursor {
  return { ...cursor, sessionId: handle.sessionId, sessionOpenedAt: handle.openedAt };
}
