/**
 * UI + PERSISTENCE DATA CONTRACTS for survey-qa-v2.
 *
 * Two of these are quoted verbatim from docs/ui-report-redesign.md §7 and are the
 * reason this worker exists in the shape it does:
 *
 *   run-status/2.0.0        (§7.3) — phase ARRAY + completion object + progressRevision
 *   coverage-snapshot/1.0.0 (§7.4) — sealed-contract state, seven buckets that SUM to
 *                                    the total, currentAttempt, usage vs caps
 *
 * Both are PROJECTIONS of one atomic durable checkpoint (§7.4: "Snapshot fields come
 * from one atomic durable checkpoint"). Nothing in the API layer may compute a phase,
 * a count or a usage number itself — it may only read the checkpoint and project it.
 * That rule is what makes "a phase changes only from a durable backend checkpoint"
 * true rather than aspirational.
 */

import type { RunPolicy } from "./env";

// ---------------------------------------------------------------------------
// Phases (ui-report-redesign §3.1)
// ---------------------------------------------------------------------------

export const PHASE_NAMES = [
  "extracting",
  "planning",
  "executing",
  "verifying",
  "adjudicating",
  "reporting",
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

/** Server-authored. The frontend never infers completion from enum order. */
export type PhaseState = "pending" | "active" | "complete" | "skipped" | "stopped";

export interface Phase {
  name: PhaseName;
  state: PhaseState;
  /** When the backend last committed this state. null while pending. */
  observedAt: string | null;
  /** Machine-readable cause for `skipped` / `stopped`. null otherwise. */
  reasonCode: string | null;
}

export const initialPhases = (): Phase[] =>
  PHASE_NAMES.map((name) => ({ name, state: "pending" as PhaseState, observedAt: null, reasonCode: null }));

// ---------------------------------------------------------------------------
// Completion — the second axis (ui-report-redesign §2.3, §7.3)
// ---------------------------------------------------------------------------

export type TestCompletion =
  | "not-started"
  | "running"
  | "complete"
  | "partial-budget"
  | "partial-time"
  | "partial-blocked"
  | "failed";

export type ReportCompletion = "not-started" | "building" | "complete" | "failed";

export interface Completion {
  test: TestCompletion;
  report: ReportCompletion;
  reasonCode: string | null;
}

/** A partial run is a reportable outcome: `Executing: stopped` + `Reporting: complete`. */
export const isTerminalTest = (t: TestCompletion): boolean =>
  t === "complete" || t === "failed" || t.startsWith("partial-");

// ---------------------------------------------------------------------------
// Coverage buckets (ui-report-redesign §3.2) — EXACTLY seven, and they must sum.
// ---------------------------------------------------------------------------

export const COVERAGE_BUCKETS = [
  "exercised",
  "not-reached",
  "proven-unreachable",
  "blocked",
  "budget-exhausted",
  "time-exhausted",
  "pending",
] as const;
export type CoverageBucket = (typeof COVERAGE_BUCKETS)[number];

export type CoverageCounts = Record<CoverageBucket, number>;

export const zeroCounts = (): CoverageCounts => ({
  exercised: 0,
  "not-reached": 0,
  "proven-unreachable": 0,
  blocked: 0,
  "budget-exhausted": 0,
  "time-exhausted": 0,
  pending: 0,
});

export const sumCounts = (c: CoverageCounts): number =>
  COVERAGE_BUCKETS.reduce((n, b) => n + (c[b] ?? 0), 0);

/**
 * §7.4: "After sealing, counts sum to contract.total."
 *
 * This is enforced at the WRITE boundary, not the read boundary — a checkpoint whose
 * ledger does not reconcile must never become durable, because the moment it does, the
 * progress UI is lying and no reader can tell. Before sealing there is no denominator
 * and the invariant does not apply.
 */
export class CoverageLedgerViolation extends Error {
  constructor(total: number, counts: CoverageCounts) {
    super(
      `coverage ledger does not reconcile: buckets sum to ${sumCounts(counts)} but the sealed ` +
        `contract total is ${total}. ${JSON.stringify(counts)}`,
    );
    this.name = "CoverageLedgerViolation";
  }
}

/**
 * A bucket that is not a non-negative safe integer.
 *
 * Arithmetic reconciliation alone is not enough, and the ways it fails are not exotic:
 * `{ exercised: -5, pending: 15 }` sums to 10 and reconciles against a total of 10 while
 * describing an impossible run; `1e21` and `NaN` both survive a `!==` comparison in ways
 * that make the sum meaningless; and a float bucket count means the progress UI renders
 * "3.0000000000000004 exercised". Every one of these produces a checkpoint that passes the
 * ledger check and then lies to every reader downstream, so the domain of a count is
 * enforced at the same boundary as the sum.
 */
export class CoverageDomainViolation extends Error {
  constructor(where: string, value: unknown) {
    super(
      `coverage ${where} is ${JSON.stringify(value)}, which is not a non-negative safe integer. ` +
        `A bucket count is a number of cases; it cannot be negative, fractional, NaN, or beyond exact integer range.`,
    );
    this.name = "CoverageDomainViolation";
  }
}

export const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function assertLedgerReconciles(contract: CheckpointContract, counts: CoverageCounts): void {
  for (const b of COVERAGE_BUCKETS) {
    if (!isCount(counts?.[b])) throw new CoverageDomainViolation(`bucket "${b}"`, counts?.[b]);
  }
  if (contract.state !== "sealed" || contract.total === null) return;
  if (!isCount(contract.total)) throw new CoverageDomainViolation("contract.total", contract.total);
  if (contract.requirements.total !== null && !isCount(contract.requirements.total)) {
    throw new CoverageDomainViolation("contract.requirements.total", contract.requirements.total);
  }
  for (const k of ["ambiguous", "disputed", "notBrowserObservable"] as const) {
    if (!isCount(contract.requirements[k])) {
      throw new CoverageDomainViolation(`contract.requirements.${k}`, contract.requirements[k]);
    }
  }
  if (sumCounts(counts) !== contract.total) throw new CoverageLedgerViolation(contract.total, counts);
}

// ---------------------------------------------------------------------------
// Contract state on the checkpoint
// ---------------------------------------------------------------------------

/**
 * §7.4: "Before extraction completes, contract.state is `unavailable`, contractHash and
 * total are null, and coverage counts are not presented as a final denominator."
 *
 * `total` is the MANDATORY-EXECUTION-CASE denominator (merged-contract §0: materialized
 * floorCases), because that is the denominator the seven buckets are states of.
 * `requirements` carries the OTHER denominator — document requirements / parent rows —
 * separately, never summed with it. §0 is explicit: "TWO DENOMINATORS always reported
 * separately ... never parent+children in one".
 */
export interface CheckpointContract {
  state: "unavailable" | "extracting" | "sealed";
  /** Immutable id of the sealed ContractRevision; the id IS the content hash. */
  contractRevisionId: string | null;
  contractHash: string | null;
  /** Mandatory execution cases. The seven buckets sum to this once sealed. */
  total: number | null;
  /** Document-requirement denominator, reported alongside and never merged. */
  requirements: {
    total: number | null;
    /** Rows visible but withheld from pass/fail (merged-contract §0). */
    ambiguous: number;
    disputed: number;
    notBrowserObservable: number;
  };
}

export const unavailableContract = (): CheckpointContract => ({
  state: "unavailable",
  contractRevisionId: null,
  contractHash: null,
  total: null,
  requirements: { total: null, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
});

// ---------------------------------------------------------------------------
// Usage — each limit keeps its own name and denominator (§3.2). NEVER averaged.
// ---------------------------------------------------------------------------

export interface UsageEvent {
  kind: "model-call" | "browser-session";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  browserSessions?: number;
  at: string;
}

export interface Usage {
  cost: { usedUsd: number; maxUsd: number; verificationReserveUsd: number; reportReserveUsd: number };
  modelCalls: { used: number; max: number };
  toolCalls: { used: number; max: number };
  wallClock: { usedMilliseconds: number; maxMilliseconds: number; startedAtMs: number };
  events: UsageEvent[];
  browserSessions: { used: number };
}

export interface CurrentAttempt {
  attemptId: string;
  pathId: string;
  pathLabel: string;
  attemptNumber: number;
}

// ---------------------------------------------------------------------------
// THE DURABLE CHECKPOINT — the single source both projections read
// ---------------------------------------------------------------------------

/**
 * `kind` is a DISCRIMINATOR, and it is load-bearing for v1/v2 coexistence.
 *
 * Prod's RunEnvelope (src/store.ts) has no discriminator: `getRun` casts whatever JSON
 * it finds to `RunEnvelope` and the sweeper then acts on `status`. If a v2 document ever
 * reached a v1 reader it would be parsed as a v1 envelope with `status: undefined` — and
 * `status !== "processing"` means the v1 sweeper would ignore it rather than corrupt it,
 * but the report path would render nonsense. Prefix disjointness prevents the encounter;
 * this field means a reader can also PROVE what it is holding. See MIGRATION.md.
 */
export const CHECKPOINT_KIND = "survey-qa-v2-checkpoint" as const;
export const CHECKPOINT_SCHEMA = "v2-checkpoint/1.0.0" as const;

export interface ExecutionCursor {
  /** Index of the next execute-batch step. Monotonic; survives recovery. */
  batchIndex: number;
  /** Live Browser Rendering session id, or null between sessions. */
  sessionId: string | null;
  /** When the current session was launched — used against SESSION_MAX_AGE_MS. */
  sessionOpenedAt: string | null;
  /** Ordered floor/exploration case ids still owed an observation. */
  pendingCaseIds: string[];
  /** Cases the executor has committed observations for. */
  completedCaseIds: string[];
  planRevisionId: string | null;
}

/**
 * WHO IS ALLOWED TO WRITE, AND SINCE WHEN.
 *
 * The sweeper's job is to replace an instance it believes is dead — but "believes" is the
 * operative word: NOT_FOUND, `errored` and "no progress for 45 minutes" are all evidence,
 * none is proof, and the original can be alive and mid-batch the whole time. Without a
 * fence the replacement and the original both drive a real browser against the same
 * survey, both commit observations, and both advance the same coverage ledger. Usage is
 * double-counted, a submitted form may be submitted twice, and the two instances overwrite
 * each other's cursors.
 *
 * The epoch is a monotonic counter bumped exactly once per recovery. Every checkpoint
 * write and every browser action carries the epoch its instance claimed, and a write whose
 * epoch is not the current one is REFUSED. The loser finds out at its next write — which,
 * because every step boundary writes a checkpoint, is at most one batch later.
 */
export interface Ownership {
  /** Workflow instance believed to own this run right now. */
  instanceId: string;
  /** Monotonic. Bumped by the sweeper when it hands the run to a replacement. */
  epoch: number;
  claimedAt: string;
}

export class OwnershipLost extends Error {
  constructor(runId: string, mine: { instanceId: string; epoch: number }, current: Ownership | null) {
    super(
      `instance ${mine.instanceId} (epoch ${mine.epoch}) may no longer write run ${runId}: ownership is now ` +
        `${current ? `${current.instanceId} (epoch ${current.epoch})` : "unclaimed"}. ` +
        `A superseded instance must stop rather than race its replacement.`,
    );
    this.name = "OwnershipLost";
  }
}

export interface RunCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA;
  kind: typeof CHECKPOINT_KIND;
  runId: string;
  /** Null only for a checkpoint created before any instance claimed the run. */
  ownership: Ownership | null;
  /** Monotonic. NEVER resets, including across recovery (§3.3). */
  revision: number;
  observedAt: string;
  /** The most recent COMMITTED artifact or state change. Not the heartbeat (§3.3). */
  lastProgressAt: string;

  phase: PhaseName;
  phases: Phase[];
  completion: Completion;

  contract: CheckpointContract;
  counts: CoverageCounts;
  currentAttempt: CurrentAttempt | null;
  attempts: { started: number; completed: number };
  usage: Usage;

  /** Server-authored effective policy. The landing page renders THIS (§4.2). */
  policy: RunPolicy;
  execution: ExecutionCursor | null;
  reportAvailable: boolean;
  /** Set by the sweeper; surfaced as the recovery sub-line (§3.3). */
  recovery: { active: boolean; attempt: number; reason: string | null } | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// PROJECTION 1 — run-status/2.0.0 (§7.3)
// ---------------------------------------------------------------------------

export const RUN_STATUS_SCHEMA = "run-status/2.0.0" as const;

export interface RunStatusV2 {
  schemaVersion: typeof RUN_STATUS_SCHEMA;
  runId: string;
  phase: PhaseName;
  phases: Phase[];
  completion: Completion;
  /** Proof the process checked in. A heartbeat is not progress. */
  heartbeatAt: string | null;
  lastProgressAt: string;
  /** Tells the client a newer coverage snapshot exists. */
  progressRevision: number;
  reportAvailable: boolean;
  /** Carried for the recovery sub-line only; not a phase. */
  recoveryMode: boolean;
  error: string | null;
}

/**
 * NOTE (deliberate divergence, stated rather than smuggled): §7.3 says to retain v1's
 * `status` / `stage` / legacy `progress` fields "during migration". v2 does NOT emit
 * them. v1 clients are served by the v1 worker on a different hostname and never poll
 * this endpoint, so there is no client to migrate — and re-emitting `stage` would
 * recreate the 0/1/2 lighting the redesign exists to delete.
 */
export function projectStatus(cp: RunCheckpoint, heartbeatAt: string | null): RunStatusV2 {
  return {
    schemaVersion: RUN_STATUS_SCHEMA,
    runId: cp.runId,
    phase: cp.phase,
    phases: cp.phases,
    completion: cp.completion,
    heartbeatAt,
    lastProgressAt: cp.lastProgressAt,
    progressRevision: cp.revision,
    reportAvailable: cp.reportAvailable,
    recoveryMode: cp.recovery?.active ?? false,
    error: cp.error,
  };
}

// ---------------------------------------------------------------------------
// PROJECTION 2 — coverage-snapshot/1.0.0 (§7.4)
// ---------------------------------------------------------------------------

export const COVERAGE_SNAPSHOT_SCHEMA = "coverage-snapshot/1.0.0" as const;

export interface CoverageSnapshot {
  schemaVersion: typeof COVERAGE_SNAPSHOT_SCHEMA;
  runId: string;
  revision: number;
  observedAt: string;
  /** Binds the snapshot to the exact checkpoint bytes it was projected from. */
  sourceCheckpointHash: string;
  contract: CheckpointContract;
  counts: CoverageCounts;
  currentAttempt: CurrentAttempt | null;
  attempts: { started: number; completed: number };
  usage: Usage;
}

export function projectCoverage(cp: RunCheckpoint, sourceCheckpointHash: string): CoverageSnapshot {
  // Read-side re-assertion of the write-side invariant. If this ever throws, a
  // checkpoint got past the writer that should not have; failing the request is
  // strictly better than serving a ledger that does not reconcile.
  assertLedgerReconciles(cp.contract, cp.counts);
  return {
    schemaVersion: COVERAGE_SNAPSHOT_SCHEMA,
    runId: cp.runId,
    revision: cp.revision,
    observedAt: cp.observedAt,
    sourceCheckpointHash,
    contract: cp.contract,
    counts: cp.counts,
    currentAttempt: cp.currentAttempt,
    attempts: cp.attempts,
    usage: cp.usage,
  };
}
