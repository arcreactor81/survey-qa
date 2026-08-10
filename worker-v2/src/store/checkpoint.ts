/**
 * THE DURABLE CHECKPOINT — the single atomic object every live projection reads.
 *
 * Three properties this module exists to guarantee, all of which the redesign states
 * as requirements and none of which survive being left to callers:
 *
 *  1. ATOMIC. One R2 object, written whole. `run-status` and `coverage-snapshot` are
 *     projected from the same bytes, so they can never disagree about revision, phase
 *     or counts (§7.4 "Snapshot fields come from one atomic durable checkpoint").
 *  2. MONOTONIC REVISION, including across recovery (§7.4, §3.3 "Recovery never resets
 *     counters"). Enforced by an etag-guarded compare-and-set: a writer that read
 *     revision N may only publish N+1, and it loses the write if anyone else got there.
 *  3. RECONCILING LEDGER. A checkpoint whose seven buckets do not sum to a sealed
 *     total cannot become durable — `assertLedgerReconciles` runs before the put.
 *
 * The CAS loop is carried forward from prod's `updateRun` (src/store.ts), which learned
 * the hard way that a bare get→mutate→put is last-writer-wins and silently drops a
 * concurrent writer's findings. R2 returns null (it does NOT throw) when `onlyIf` fails.
 */

import type { Env } from "../types/env";
import { effectivePolicy } from "../types/env";
import {
  CHECKPOINT_KIND,
  CHECKPOINT_SCHEMA,
  OwnershipLost,
  assertLedgerReconciles,
  initialPhases,
  unavailableContract,
  zeroCounts,
  type Ownership,
  type PhaseName,
  type PhaseState,
  type RunCheckpoint,
} from "../types/contracts";
import { checkpointKey, heartbeatKey } from "../keys";
import { assertV2RunId } from "../ids";
import { sha256Hex } from "./hash";

const MAX_CAS_ATTEMPTS = 6;

export class CheckpointContention extends Error {
  constructor(runId: string) {
    super(`checkpoint: persistent write contention on run ${runId} (exhausted ${MAX_CAS_ATTEMPTS} attempts)`);
    this.name = "CheckpointContention";
  }
}

export class RevisionRegression extends Error {
  constructor(runId: string, from: number, to: number) {
    super(`checkpoint: refused to move run ${runId} revision backwards (${from} -> ${to})`);
    this.name = "RevisionRegression";
  }
}

export interface LoadedCheckpoint {
  checkpoint: RunCheckpoint;
  /** sha-256 of the exact stored bytes — becomes `sourceCheckpointHash` and the ETag. */
  bytesHash: string;
  etag: string;
}

export function initialCheckpoint(env: Env, runId: string, profile: "standard" | "deep", deepAuthorized: boolean): RunCheckpoint {
  const now = new Date().toISOString();
  const policy = effectivePolicy(env, profile, deepAuthorized);
  return {
    schemaVersion: CHECKPOINT_SCHEMA,
    kind: CHECKPOINT_KIND,
    runId,
    // Unclaimed until the Workflow instance starts and fences itself in (see
    // `claimOwnership`). The submitting request must not claim on the instance's behalf:
    // it does not know whether the instance ever starts.
    ownership: null,
    revision: 1,
    observedAt: now,
    lastProgressAt: now,
    phase: "extracting",
    phases: initialPhases(),
    completion: { test: "not-started", report: "not-started", reasonCode: null },
    contract: unavailableContract(),
    counts: zeroCounts(),
    currentAttempt: null,
    attempts: { started: 0, completed: 0 },
    usage: {
      cost: {
        usedUsd: 0,
        maxUsd: policy.limits.maxUsd,
        verificationReserveUsd: policy.limits.verificationReserveUsd,
        reportReserveUsd: policy.limits.reportReserveUsd,
      },
      modelCalls: { used: 0, max: policy.limits.maxModelCalls },
      toolCalls: { used: 0, max: policy.limits.maxToolCalls },
      wallClock: { usedMilliseconds: 0, maxMilliseconds: policy.limits.maxWallClockMs, startedAtMs: Date.now() },
      events: [],
      browserSessions: { used: 0 },
      paidModelAccounting: { mode: "fail-loud-v2-micro-ceiling" },
    },
    policy,
    execution: null,
    reportAvailable: false,
    recovery: null,
    error: null,
  };
}

export async function loadCheckpoint(env: Env, runId: string): Promise<LoadedCheckpoint | null> {
  assertV2RunId(runId);
  const obj = await env.EVIDENCE.get(checkpointKey(runId));
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  const text = new TextDecoder().decode(bytes);
  const checkpoint = JSON.parse(text) as RunCheckpoint;
  if (checkpoint.kind !== CHECKPOINT_KIND) {
    throw new Error(`checkpoint: object at ${checkpointKey(runId)} is not a ${CHECKPOINT_KIND}`);
  }
  return { checkpoint, bytesHash: await sha256Hex(bytes), etag: obj.etag };
}

/** First write of a run. Unconditional by necessity — there is no prior state. */
export async function createCheckpoint(env: Env, cp: RunCheckpoint): Promise<void> {
  assertLedgerReconciles(cp.contract, cp.counts);
  await env.EVIDENCE.put(checkpointKey(cp.runId), JSON.stringify(cp), {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
}

/**
 * Compare-and-set update. `mutate` receives a DRAFT (revision/observedAt already
 * advanced) and mutates it in place; returning `false` aborts the write.
 *
 * `progressed: true` stamps `lastProgressAt` — reserve it for a committed artifact or
 * state change. A heartbeat is not progress (§3.3), which is why heartbeats do not go
 * through this function at all.
 */
export interface Fence {
  instanceId: string;
  epoch: number;
}

/**
 * Refuse the write unless the caller still owns the run. Checked on EVERY compare-and-set
 * attempt, after the re-read, so a fence cannot be evaluated against stale state.
 */
function assertOwnership(runId: string, current: RunCheckpoint, fence: Fence | undefined): void {
  if (!fence) return;
  const own: Ownership | null = current.ownership ?? null;
  if (!own || own.epoch !== fence.epoch || own.instanceId !== fence.instanceId) {
    throw new OwnershipLost(runId, fence, own);
  }
}

export async function updateCheckpoint(
  env: Env,
  runId: string,
  mutate: (draft: RunCheckpoint) => boolean | void,
  opts: { progressed?: boolean; fence?: Fence } = {},
): Promise<RunCheckpoint | null> {
  assertV2RunId(runId);
  const key = checkpointKey(runId);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const obj = await env.EVIDENCE.get(key);
    if (!obj) return null;
    const current = JSON.parse(await obj.text()) as RunCheckpoint;
    assertOwnership(runId, current, opts.fence);

    const draft: RunCheckpoint = JSON.parse(JSON.stringify(current)) as RunCheckpoint;
    const now = new Date().toISOString();
    draft.revision = current.revision + 1;
    draft.observedAt = now;
    if (opts.progressed) draft.lastProgressAt = now;

    if (mutate(draft) === false) return current;

    if (draft.revision <= current.revision) throw new RevisionRegression(runId, current.revision, draft.revision);
    assertLedgerReconciles(draft.contract, draft.counts);

    const written = await env.EVIDENCE.put(key, JSON.stringify(draft), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      onlyIf: { etagMatches: obj.etag },
    });
    if (written !== null) return draft;
    // Precondition failed: someone else advanced the checkpoint. Re-read and re-apply.
  }
  throw new CheckpointContention(runId);
}

/**
 * Take ownership of a run at `epoch`, and return the fence every later write must carry.
 *
 * Monotonic: a claim at an epoch LOWER than the current one is refused. That is what stops
 * a superseded original from re-claiming the run after its replacement has taken over —
 * the original would have to go backwards, and it cannot.
 */
export async function claimOwnership(
  env: Env,
  runId: string,
  instanceId: string,
  epoch: number,
): Promise<Fence> {
  const updated = await updateCheckpoint(env, runId, (d) => {
    const own = d.ownership;
    if (own && own.epoch > epoch) throw new OwnershipLost(runId, { instanceId, epoch }, own);
    if (own && own.epoch === epoch && own.instanceId !== instanceId) {
      throw new OwnershipLost(runId, { instanceId, epoch }, own);
    }
    d.ownership = { instanceId, epoch, claimedAt: new Date().toISOString() };
  });
  if (!updated) throw new Error(`claimOwnership: no checkpoint for ${runId}`);
  return { instanceId, epoch };
}

/** Convenience: set one phase's state without touching the others. */
export function setPhase(draft: RunCheckpoint, name: PhaseName, state: PhaseState, reasonCode: string | null = null): void {
  const now = new Date().toISOString();
  for (const p of draft.phases) {
    if (p.name === name) {
      p.state = state;
      p.observedAt = now;
      p.reasonCode = reasonCode;
    }
  }
  if (state === "active") draft.phase = name;
}

// ---------------------------------------------------------------------------
// Heartbeat — liveness only, deliberately NOT part of the checkpoint
// ---------------------------------------------------------------------------

export interface Heartbeat {
  at: string;
  note: string;
  /** Fingerprint the sweeper compares across ticks to detect a stalled-but-beating run. */
  fingerprint: string;
}

/**
 * Best-effort. Failures are swallowed: a heartbeat must never fail a run (prod's `beat`
 * learned this). Written from INSIDE step closures so a crash-looping instance cannot
 * refresh its own liveness — completed Workflow steps return cached results and never
 * re-execute.
 */
export async function beat(env: Env, runId: string, note: string, fingerprint: string): Promise<void> {
  try {
    const hb: Heartbeat = { at: new Date().toISOString(), note, fingerprint };
    await env.EVIDENCE.put(heartbeatKey(runId), JSON.stringify(hb), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  } catch (err) {
    console.error(`heartbeat write failed for v2 run ${runId} (${note}):`, err);
  }
}

export async function readHeartbeat(env: Env, runId: string): Promise<Heartbeat | null> {
  const obj = await env.EVIDENCE.get(heartbeatKey(runId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as Heartbeat;
  } catch {
    return null;
  }
}
