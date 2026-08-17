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
import {
  publicExtractionFailureDetail,
  projectDocumentReadingProgress,
  selectExtractionFailureReason,
  withoutDocumentSourceContext,
  type DocumentReadingProgress,
} from "../observability/document-reading";

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
  /**
   * ADDITIVE (Direction 2 upgrade). When the phase transitioned to `active`.
   * null while pending or for checkpoints written before this field existed.
   * Optional because older checkpoints do not carry it.
   */
  startedAt?: string | null;
  /**
   * ADDITIVE (Direction 2 upgrade). When the phase left `active` (complete/stopped/skipped).
   * null while pending or active, or for checkpoints written before this field existed.
   * Optional because older checkpoints do not carry it.
   */
  endedAt?: string | null;
}

export const initialPhases = (): Phase[] =>
  PHASE_NAMES.map((name) => ({
    name,
    state: "pending" as PhaseState,
    observedAt: null,
    reasonCode: null,
    startedAt: null,
    endedAt: null,
  }));

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

export const PARTIAL_TEST_COMPLETIONS = [
  "partial-budget",
  "partial-time",
  "partial-blocked",
] as const satisfies readonly TestCompletion[];
export type PartialTestCompletion = (typeof PARTIAL_TEST_COMPLETIONS)[number];

/** Runtime guard for persisted/untyped status data; prefix-shaped unknown states are not valid. */
export const isPartialTestCompletion = (value: unknown): value is PartialTestCompletion =>
  typeof value === "string" && (PARTIAL_TEST_COMPLETIONS as readonly string[]).includes(value);

export type ReportCompletion = "not-started" | "building" | "complete" | "failed";

export interface Completion {
  test: TestCompletion;
  report: ReportCompletion;
  reasonCode: string | null;
}

/** A partial run is a reportable outcome: `Executing: stopped` + `Reporting: complete`. */
export const isTerminalTest = (t: TestCompletion): boolean =>
  t === "complete" || t === "failed" || isPartialTestCompletion(t);

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

/** Exact calculated model-call telemetry; the strict core ledger meters it conservatively. */
export interface ModelCallUsageEvent {
  kind: "model-call";
  /** Optional on legacy/pass-A events; pass-B uses it for atomic retry deduplication. */
  eventId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
}

/** Legacy/best-effort browser usage. */
export interface BrowserSessionUsageEvent {
  kind: "browser-session";
  browserSessions?: number;
  at: string;
}

export type BestEffortUsageEvent = ModelCallUsageEvent | BrowserSessionUsageEvent;

/**
 * Cost is a state, not a falsy number. In particular, `unknown` may never be serialized as
 * `usd: 0`: doing so would silently convert an unbounded future charge into budget headroom.
 */
export type VisualUsageCost =
  | {
      state: "known";
      usd: number;
      source: "provider-reported" | "gateway-reported" | "configured-rate";
    }
  | {
      state: "unknown";
      reason: "provider-not-reported" | "transport-no-cost-telemetry" | "attempt-outcome-uncertain";
    };

/** Provider boundary outcome. Kept in the ledger so failed paid attempts remain auditable. */
export type VisualUsageResultState = "observed" | "malformed" | "timeout" | "unavailable";

/**
 * One durable charge event per paid screenshot inference. `eventId` is derived from the raw
 * inference cache key, while `callId` is required to carry the same digest suffix. This keeps
 * retries/replays idempotent without assuming anything about a survey or its platform.
 */
export interface VisualModelCallUsageEvent {
  kind: "visual-model-call";
  eventId: string;
  callId: string;
  inferenceCacheKey: string;
  provider: string;
  model: string;
  resultState: VisualUsageResultState;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: VisualUsageCost;
  at: string;
}

export type UsageEvent = BestEffortUsageEvent | VisualModelCallUsageEvent;

export interface Usage {
  cost: {
    /** Conservative cap-accounted USD; exact calculated call costs remain in `events`. */
    usedUsd: number;
    maxUsd: number;
    verificationReserveUsd: number;
    reportReserveUsd: number;
  };
  modelCalls: { used: number; max: number };
  toolCalls: { used: number; max: number };
  wallClock: { usedMilliseconds: number; maxMilliseconds: number; startedAtMs: number };
  events: UsageEvent[];
  browserSessions: { used: number };
  /**
   * Optional only for compatibility with checkpoints written before paid visual admission
   * existed. Its absence makes the shared model allowance unverifiable and therefore cannot
   * authorize a new visual purchase.
   */
  paidModelAccounting?: {
    mode: "fail-loud-v1" | "fail-loud-v2-micro-ceiling";
  };
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
  /**
   * W5's single durable authority. Receipt bytes are immutable artifacts written before the
   * fenced checkpoint CAS; only pointers committed here can close a seeded case. Progress.json
   * is a derived reader surface and can never authorize closure.
   */
  seedExecution?: {
    programHash: string;
    doneAlternativeIds: string[];
    committedAttemptIds: string[];
    reservation: { alternativeId: string; attemptId: string } | null;
    attempts: Array<{
      alternativeId: string;
      attemptId: string;
      artifactHash: string;
      artifactKey: string;
    }>;
    refusals: Array<{ alternativeId: string; attemptId: string; reason: string }>;
    receipts: Array<{
      caseId: string;
      alternativeId: string;
      attemptId: string;
      receiptHash: string;
      seedCertificateHash: string;
      commitArtifactHash: string;
      artifactKey: string;
    }>;
  };
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

// ---------------------------------------------------------------------------
// WHY A RUN ENDED BADLY — the diagnosis, structured, on its way to a reader
// ---------------------------------------------------------------------------

/**
 * THE FIELD THAT DID NOT EXIST WHEN THE FIRST REAL RUN DIED.
 *
 * `v2r_01kzf7ehb2sayx2y2xz4ecm1ed` ended `workflow-error` with nothing else to say. The
 * cause was on file the whole time — Cloudflare's own Workflow API returned
 * `planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9` instantly —
 * but that sentence lived only in the engine's step record, which no product surface reads
 * and no user can reach. Everything the run itself published had been flattened to one
 * generic word by the time it crossed the durable step boundary.
 *
 * So the cause is now written down where the cause still exists (inside the step closure,
 * in the same isolate as the error object) and carried out through both read surfaces, in
 * FOUR SEPARATE FACTS rather than one blob:
 *
 *   step       — WHICH stage refused. Recoverable from nothing else; the outer catch does
 *                not know, and `plan-1` was only ever obtainable from the engine.
 *   reasonCode — the machine field, same vocabulary as `completion.reasonCode`. A client
 *                branches on THIS and never on the prose.
 *   kind       — the error's class name when the thrower set one. Distinguishes a guard
 *                that refused from a crash that happened to say something similar.
 *   message    — the human sentence, SANITISED (see `sanitiseErrorText`). The only part
 *                of a thrown error that is ever allowed to reach a browser.
 */
export interface RunFailure {
  /** Workflow step that threw, by the name this code gives it (`plan`, `execute-batch-3`). */
  step: string;
  /** Stable machine code. Shares the `completion.reasonCode` vocabulary deliberately. */
  reasonCode: string;
  /** `err.name` when the thrower set one; `"unknown"` for a non-Error throw. */
  kind: string;
  /** Sanitised, bounded, renderable. NEVER the raw thrown value. */
  message: string;
  at: string;
}

/** The structured diagnosis is short by contract. A status line is not a log sink. */
export const FAILURE_MESSAGE_MAX = 300;
/** The legacy prose field keeps the checkpoint's own bound; it carries real explanations. */
export const ERROR_TEXT_MAX = 2000;

/**
 * AN ERROR MESSAGE IS USER-VISIBLE TEXT, so it is treated as untrusted output rather than
 * as a debugging aid. Everything here is removed on the way to a reader:
 *
 *  - STACK FRAMES. `at Object.planStage (/worker/src/workflow/stages/plan.ts:413:13)` names
 *    the deploy's filesystem layout and nothing a reader can act on. Frame lines are
 *    dropped whole, so a multi-line explanation survives and its stack does not.
 *  - URLs of every scheme, entire. The host is the sensitive half (an internal service, a
 *    bucket endpoint, an AI-gateway route) and the path is where tokens hide, so the whole
 *    thing goes rather than a hostname being kept for readability.
 *  - FILESYSTEM PATHS, Windows and POSIX.
 *  - CREDENTIALS: `Authorization:` / `api_key=` / `token=`-shaped assignments (the KEY NAME
 *    is kept so a reader can see WHAT was withheld), bearer tokens, and the common
 *    provider key prefixes this worker actually handles.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: the diagnosis. `fi_b74430a941910fc9a6f9`, contract
 * revision ids, sha-256 hashes and bucket-free R2 key fragments are the answer to "why did
 * my run fail" and a sanitiser that eats them has failed at the job it exists for.
 */
export function sanitiseErrorText(raw: unknown, max: number = FAILURE_MESSAGE_MAX): string {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? `${raw.name}: ${raw.message}`
        : raw === null || raw === undefined
          ? ""
          : String(raw);

  let out = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S/.test(line))
    .join(" ");

  // Credentials first: a token inside a URL must be redacted as a credential before the
  // URL rule swallows the evidence that there was one.
  //
  // BEARER BEFORE THE ASSIGNMENT RULE, AND THE ORDER IS THE WHOLE POINT. `Authorization:
  // Bearer eyJhbGci…` matches the assignment rule too, and that rule's value class stops
  // at the first space — so running it first consumes the literal word "Bearer" as if it
  // were the secret and leaves the JWT standing in the clear. A key-prefixed token
  // (`sk-ant-…`) happens to be caught by the prefix rule below; a JWT and a Cloudflare
  // Access token are not, and would have walked straight out.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  out = out.replace(
    /\b(authorization|api[-_]?key|access[-_]?key|secret[-_]?key|client[-_]?secret|secret|token|password|passwd|pwd|cookie|signature)\b(\s*[:=]\s*|\s+)(?:"|')?[^\s"'&,;]+/gi,
    "$1=[redacted]",
  );
  out = out.replace(/\b(sk|pk|rk|xai|ghp|gho|ghs|glpat|AIza)[-_][A-Za-z0-9._-]{8,}/g, "$1-[redacted]");

  out = out.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>)]+/g, "[url]");
  out = out.replace(/\b[A-Za-z]:\\[^\s"'<>)]*/g, "[path]");
  out = out.replace(
    /(^|[\s"'(=[])\/(?:home|root|usr|var|etc|opt|tmp|bin|sbin|proc|sys|mnt|media|srv|Users|Applications|Library|workspace|worker|app|build|dist|node_modules)\b[^\s"'<>)\]]*/g,
    "$1[path]",
  );

  return out.replace(/\s+/g, " ").trim().slice(0, Math.max(0, max));
}

/** Read-side re-sanitisation. A checkpoint written before this existed is not trusted. */
export function projectFailure(failure: RunFailure | null | undefined): RunFailure | null {
  if (!failure || typeof failure !== "object") return null;
  const message = sanitiseErrorText(failure.message, FAILURE_MESSAGE_MAX);
  const reasonCode = typeof failure.reasonCode === "string" ? failure.reasonCode.slice(0, 80) : "workflow-error";
  if (!message && !reasonCode) return null;
  return {
    step: sanitiseErrorText(failure.step, 120),
    reasonCode,
    kind: sanitiseErrorText(failure.kind, 80) || "unknown",
    message,
    at: typeof failure.at === "string" ? failure.at : "",
  };
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
  /**
   * The structured cause, when there is one. OPTIONAL because `loadCheckpoint` is a bare
   * cast over stored bytes: every checkpoint written before this field existed has no
   * `failure` key at all, and declaring it required would make the type lie about the
   * objects actually in the bucket.
   */
  failure?: RunFailure | null;
  /**
   * Optional because checkpoints written before the visibility upgrade do not carry it.
   * Every read passes through the closed projector; malformed progress becomes a named
   * unavailable state, never plausible-looking zero progress.
   */
  documentReading?: DocumentReadingProgress | null;
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
  /**
   * The heartbeat's OWN WORDS for what the run is doing right now — the thing the long
   * quiet stages have to say for themselves. Server-authored machine text (`extract pass A
   * wave 3 (whole-document / global rules)`), not prose: the client renders it as a machine
   * string rather than translating it, and NOTHING derives a duration, a percentage or an
   * estimate from it. A note says what IS happening, never how long is left.
   *
   * OMITTED, not null, when the run has not written one. A run with no note therefore
   * serializes byte-for-byte as it did before this field existed, so no client can start
   * rendering an empty flash where there was previously nothing at all.
   */
  heartbeatNote?: string;
  lastProgressAt: string;
  /** Tells the client a newer coverage snapshot exists. */
  progressRevision: number;
  reportAvailable: boolean;
  /** Carried for the recovery sub-line only; not a phase. */
  recoveryMode: boolean;
  /**
   * The human sentence, SANITISED at the projection rather than at each of the eight
   * places that write it. Sanitising here is what makes the guarantee checkable: every
   * writer, including the ones in other modules that interpolate a browser binding's
   * exception or a Cloudflare API error body, passes through this one function on its way
   * to a client, so no future writer can open the hole again by forgetting.
   */
  error: string | null;
  /**
   * WHY, structured — `{ step, reasonCode, kind, message }`. A client branches on
   * `failure.reasonCode` and renders `failure.message`; it never parses `error`.
   *
   * OMITTED, not null, when the run has no recorded failure — the same rule `heartbeatNote`
   * follows and for the same reason: a healthy run must serialize byte-for-byte as it did
   * before the field existed, so no client starts rendering an empty error row on runs that
   * are fine.
   */
  failure?: RunFailure;
  /** Durable questionnaire-reading facts. Omitted before extraction has durable facts. */
  documentReading?: DocumentReadingProgress;
}

/**
 * NOTE (deliberate divergence, stated rather than smuggled): §7.3 says to retain v1's
 * `status` / `stage` / legacy `progress` fields "during migration". v2 does NOT emit
 * them. v1 clients are served by the v1 worker on a different hostname and never poll
 * this endpoint, so there is no client to migrate — and re-emitting `stage` would
 * recreate the 0/1/2 lighting the redesign exists to delete.
 */
export function projectStatus(
  cp: RunCheckpoint,
  heartbeatAt: string | null,
  heartbeatNote: string | null = null,
): RunStatusV2 {
  // A note only travels if it actually says something. An empty or whitespace-only note
  // would render as a blank line implying the run is doing nothing, which is a worse lie
  // than the quiet stage copy it would have replaced. Bounded for the same reason the
  // producer bounds its own interpolations: a status line is not a log sink.
  const note = typeof heartbeatNote === "string" ? heartbeatNote.trim().slice(0, 200) : "";
  // The cause travels beside the prose, never instead of it. `error` is what a person
  // reads; `failure` is what a client switches on.
  const projectedFailure = projectFailure(cp.failure);
  const internalDocumentReading = projectDocumentReadingProgress(cp.documentReading);
  const documentReading = internalDocumentReading
    ? withoutDocumentSourceContext(internalDocumentReading)
    : null;
  const readingFailure = documentReading?.failure ?? null;
  const stoppedExtraction = cp.phases.find(
    (phase) => phase.name === "extracting" && phase.state === "stopped",
  );
  const extractionReason = selectExtractionFailureReason(
    readingFailure?.reasonCode,
    cp.completion.reasonCode,
    cp.failure?.reasonCode,
    stoppedExtraction?.reasonCode,
  ) ?? (stoppedExtraction?.reasonCode === "workflow-error" ? "workflow-error" : null);
  const publicExtractionDetail = extractionReason
    ? publicExtractionFailureDetail(extractionReason)
    : null;
  const failure = projectedFailure && publicExtractionDetail
    ? { ...projectedFailure, message: publicExtractionDetail }
    : projectedFailure;
  const error = publicExtractionDetail
    ? publicExtractionDetail
    : cp.error === null || cp.error === undefined ? null : sanitiseErrorText(cp.error, ERROR_TEXT_MAX);
  const publicNote = publicExtractionDetail && note ? publicExtractionDetail : note;
  return {
    schemaVersion: RUN_STATUS_SCHEMA,
    runId: cp.runId,
    phase: cp.phase,
    phases: cp.phases,
    completion: cp.completion,
    heartbeatAt,
    ...(publicNote ? { heartbeatNote: publicNote } : {}),
    lastProgressAt: cp.lastProgressAt,
    progressRevision: cp.revision,
    reportAvailable: cp.reportAvailable,
    recoveryMode: cp.recovery?.active ?? false,
    error,
    ...(failure ? { failure } : {}),
    ...(documentReading ? { documentReading } : {}),
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
