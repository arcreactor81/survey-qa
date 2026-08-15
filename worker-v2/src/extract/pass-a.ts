/**
 * PASS A — the bounded cross-cutting pass. GROK.
 *
 * One or more bounded primary calls hunt rules scoped to the survey rather than to a
 * question; a separately receipted candidate reconciliation follows when there are several
 * windows. The first real run's most expensive miss was exactly this class: a global
 * "a question must block until it is answered" rule that covered 9 of 11 questions and
 * that a question-by-question read had no reason to emit even once.
 *
 * A document too large for one call is split into WINDOWS rather than silently truncated,
 * and each window says so in its prompt. A window that fails is recorded as a failed unit —
 * never as a window that found nothing.
 *
 * =====================================================================================
 * WHY THIS PASS IS A *SLICE* TOO, AND NOT ONE LONG STEP
 * =====================================================================================
 *
 * THE DEFECT, in the same shape pass B had (see extract/pass-b.ts for the measured history
 * that produced this design):
 *
 *   `extract-pass-a-global` was ONE Workflow step under EXTRACT_POLICY — 8 minutes, 480 s.
 *   Inside it, `splitWindows` walks the document SERIALLY at EXTRACT_PASS_A_WINDOW_CHARS
 *   (90 000) per window. A ~360 KB questionnaire is 4 windows; even TWO windows is 2 ×
 *   LLM_TIMEOUT_MS = 600 s against a 480 s step. And nothing was persisted per window —
 *   only the whole pass, at the end — so the step axe fell on windows that had already
 *   been BILLED, and the retry bought every one of them again. That is the same cliff, on
 *   the Grok leg, waiting for the first document larger than our fixtures. It does not bite
 *   the small test document, which is exactly why it had to be fixed before one arrives.
 *
 * The treatment is the one pass B proved, with the differences pass A actually has:
 *
 *   1. A SLICE IS GIVEN A WALL-CLOCK BUDGET, and it stops ISSUING new calls when the budget
 *      is gone. It never abandons a call it already issued. `passAStepTimeoutMs` derives the
 *      step's timeout from that budget plus one whole PURCHASE plus slack, so the step axe
 *      can never fall on a call that is still in flight.
 *
 *   2. A SLICE ALWAYS MAKES PROGRESS — even at a budget of zero it issues at least one call,
 *      so the number of waves a document needs is bounded by its WINDOW COUNT rather than by
 *      luck.
 *
 *   3. WORK THAT LANDED IS NEVER RE-BOUGHT. Each window is persisted THE MOMENT IT RETURNS
 *      and reclaimed for free on re-entry, and a window that FAILED carries its own attempt
 *      count in its artifact — so waves, Workflow step retries and recovery instances share
 *      ONE purchase budget instead of each starting a fresh one.
 *
 * WHERE PASS A DIFFERS FROM PASS B, DELIBERATELY:
 *
 *   - WINDOWS STAY SERIAL. Pass B fans its small chunks out under bounded concurrency
 *     because 23 serial calls is ten minutes of waiting. Pass A's units are the largest
 *     prompts in the system (90 KB of source each) and there are a handful of them: running
 *     them concurrently multiplies peak memory in one isolate and widens the blast radius of
 *     a step kill, for a saving the wave budget already provides. Serial issue also keeps
 *     window order — and therefore requirement order, `A-wN` origins and the diff's
 *     provenance — identical no matter which wave bought which window.
 *   - THERE IS NO SWEEP AND NO DISPOSITION LEDGER. Pass A does not disposition blocks, so
 *     it owes no per-block accounting and has no third phase; `done` is purely about
 *     windows.
 *   - CROSS-REFERENCES RIDE THE WINDOW ARTIFACT. They are pass A's only output with no pass
 *     B analogue, and a resumed pass that dropped them would silently shorten the diff — the
 *     exact class of failure per-unit persistence exists to prevent. So they are persisted
 *     and reclaimed with everything else.
 *
 * NOT a difference: the purchase ceiling counting retries. Pass B derives its step timeout
 * the same way now (`passBCallCeilingMs`), so the arithmetic is SHARED, not pass A's own —
 * see `passACallCeilingMs` below for why one purchase is not one attempt.
 */

import type { Env } from "../types/env";
import { num } from "../types/env";
import {
  DEFAULT_GROK_MODEL,
  grokFlashFallbackEligible,
  grokFlashRouteIdentity,
  grokJson,
  grokRequestShape,
} from "../llm/grok";
import {
  deepseekGrokFallbackJson,
  deepseekGrokFallbackRequestShape,
} from "../llm/deepseek";
import {
  geminiGrokSubstituteJson,
  geminiGrokSubstituteRequestShape,
  geminiMaxTotalUsd,
  keyForGemini,
  GEMINI_OFFICIAL_RATES,
  DEFAULT_GEMINI_MODEL,
} from "../llm/gemini";
import {
  enforceGeminiCap,
  ProviderCapExceededRefusal,
  ProviderLedgerCorrupt,
  conservativeGeminiReservation,
} from "../store/provider-spend-ledger";
import {
  chatRequestBodyText,
  keyFor,
  MissingCredential,
  ModelCallError,
  type ModelFailureKind,
} from "../llm/chat";
import {
  EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
  extractionWireFailureDetail,
  extractionWirePolicy,
  extractionWirePreSerializationFailureDetail,
  preflightExtractionRequestBodies,
  utf8ByteLength,
} from "../llm/extraction-wire";
import {
  PROMPT_VERSION_A,
  SYSTEM_A,
  SYSTEM_A_SYNTHESIS,
  userMessageA,
  userMessageASynthesis,
} from "./prompts";
import {
  CONSTRUCT_CLASSES,
  type
  CallUsage,
  ParsedDocument,
  PassResult,
  RawAmbiguity,
  RawRequirement,
  RawUnverifiable,
  SourceBlock,
} from "./types";
import { DOCX_BLOCKS_VERSION } from "./docx-blocks";
import {
  buildBoundedJsonText,
  buildBoundedSourceBlocksJsonl,
} from "./bounded-source-block-jsonl";
import { coerceRequirement, coerceAmbiguities, coerceUnverifiable } from "./coerce";
import { k } from "../keys";
import { canonicalJson, sha256Hex } from "../store/hash";
import {
  publicExtractionFailureDetail,
  sourceContextForUnit,
  type DocumentReadingUnitStartObserver,
} from "../observability/document-reading";
import {
  PASS_A_PRIMARY_GROUNDING_LIMITATION_KIND,
  validatePassAPrimaryGroundingLimitations,
  type PassAPrimaryGroundingLimitationWire,
  type PassAPrimaryGroundingReason,
  type PassAPrimaryGroundingRowKind,
} from "../../shared/pass-a-grounding-limitations.mjs";

export const PASS_A_VERSION = PROMPT_VERSION_A;
export const GROK_FALLBACK_TRIGGER_VERSION = "grok-flash-fallback-trigger/1.0.0";
export const PASS_A_SYNTHESIS_VERSION = "v2-extract-pass-a-synthesis/1.1.0";

export type PassAProviderIndependence =
  | "independent"
  | "independent-gemini-substitute"
  | "reduced-same-provider-fallback";

export interface GrokFallbackTrigger {
  kind: typeof GROK_FALLBACK_TRIGGER_VERSION;
  failureKind: ModelFailureKind;
  httpStatus: number | null;
  grokModel: typeof DEFAULT_GROK_MODEL;
  grokUsageEventId: string;
  detail: string;
}

export interface PassARouteReceipt {
  selected: "grok-4.6" | "gemini-2.5-flash" | "deepseek-v4-flash";
  trigger: GrokFallbackTrigger | null;
}

/** Where each window lands the instant it returns. The unit of resume for this pass. */
const windowKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-a", `window-${String(n).padStart(2, "0")}.json`);
const windowCasConflictKey = (runId: string, n: number, bodySha256: string) =>
  k(
    "runs",
    runId,
    "extraction",
    "pass-a",
    `window-${String(n).padStart(2, "0")}-cas-conflict-${bodySha256}.json`,
  );
const windowHistoryKey = (runId: string, n: number, bodySha256: string) =>
  k(
    "runs",
    runId,
    "extraction",
    "pass-a",
    `window-${String(n).padStart(2, "0")}-history-${bodySha256}.json`,
  );
const windowWireCeilingKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-a", `window-${String(n).padStart(2, "0")}-wire-ceiling.json`);

const windowPolicyIdentity = (env: Env): string =>
  `pass-a-window-policy/1.1.0|chars:${num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000)}` +
  `|blocks:${num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 100)}` +
  `|max-issues:${Math.max(1, num(env.EXTRACT_PASS_A_WINDOW_MAX_ISSUES, 2))}`;

/** One durable reconciliation unit, distinct from every independently read primary window. */
export const passASynthesisKey = (runId: string) =>
  k("runs", runId, "extraction", "pass-a", "cross-window-synthesis.json");
const passASynthesisWireCeilingKey = (runId: string) =>
  k("runs", runId, "extraction", "pass-a", "cross-window-synthesis-wire-ceiling.json");
const passASynthesisHistoryKey = (runId: string, bodySha256: string) =>
  k(
    "runs",
    runId,
    "extraction",
    "pass-a",
    `cross-window-synthesis-history-${bodySha256}.json`,
  );
const passASynthesisCasConflictKey = (runId: string, bodySha256: string) =>
  k(
    "runs",
    runId,
    "extraction",
    "pass-a",
    `cross-window-synthesis-cas-conflict-${bodySha256}.json`,
  );

export interface CrossWindowEvidenceQuote {
  blockId: string;
  quote: string;
}

/**
 * A primary reader may name a target only when it also supplies an exact quote from that
 * target block. If the source side of the reference is exact but the target proof is not,
 * the reference survives only as this unresolved question. It is not a requirement and can
 * therefore mint no coverage credit; a later cross-window synthesis may resolve it only by
 * supplying exact evidence from both sides.
 */
export const PASS_A_UNPROVEN_TARGET_STATEMENT =
  "Resolution withheld: the primary reader did not supply exact evidence from the claimed target block." as const;

/** Cross-references pass A resolved (or failed to), surfaced in the diff. */
export interface CrossRef {
  id: string;
  fromBlock: string | null;
  target: string;
  resolvedToBlock: string | null;
  statement: string;
  /** Exact primary source span naming the reference. */
  docQuote?: string;
  /** Exact target span required whenever a primary reader claims a local resolution. */
  targetDocQuote?: string | null;
  /** Exact spans checked against source when this row was resolved across windows. */
  evidenceQuotes?: CrossWindowEvidenceQuote[];
  /** The unresolved primary-window reference this synthesis row resolves. */
  sourceXrefId?: string;
  /** Stable owning-window/id pair; raw xref ids may collide across independent readers. */
  sourceXrefHandle?: string;
}

export interface PassASynthesisCoverage {
  primaryWindowsTotal: number;
  primaryWindowsIncluded: number;
  candidateRowsTotal: number;
  candidateRowsIncluded: number;
  candidateRowsUngrounded: number;
  sourceBlocksTotal: number;
  sourceEvidenceBlocksIncluded: number;
  sourceEvidenceSpansIncluded: number;
  sourceBlocksOmitted: number;
  /** Explicitly distinguishes reconciliation from an attested whole-source primary read. */
  method: "window-output-candidates-plus-exact-source-evidence";
}

export interface PassACrossWindowLimitation {
  kind: "pass-a-cross-window-candidate-dependence";
  windowsTotal: number;
  /** Window-output candidate rows actually offered to the bounded synthesis call. */
  candidatesSynthesized: number;
  candidatesUngrounded: number;
  sourceEvidenceBlocks: number;
  sourceEvidenceSpans: number;
  synthesisAdditions: number;
  detail: string;
}

export interface PassASynthesisAdditions {
  globalRules: RawRequirement[];
  crossRefs: CrossRef[];
  ambiguities: RawAmbiguity[];
  unverifiable: RawUnverifiable[];
}

export interface PassASynthesisOutcome {
  state: "not-required" | "pending" | "ok" | "failed" | "reduced-provider-independence";
  required: boolean;
  issued: number;
  attempts: number;
  inputHash: string | null;
  coverage: PassASynthesisCoverage | null;
  additions: PassASynthesisAdditions;
  calls: CallUsage[];
  issuedCalls: CallUsage[];
  accountingCalls: CallUsage[];
  routeReceipt: PassARouteReceipt | null;
  fallbackTrigger: GrokFallbackTrigger | null;
  failedUnit: PassResult["failedUnits"][number] | null;
  limitation: PassACrossWindowLimitation | null;
  terminalReasonCode?: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
  credentialRefusal?: { reason: "NO_CREDENTIAL"; binding: string; provider: "grok" | "deepseek" | "gemini" };
}

export interface PassASynthesisOptions {
  /** False defers the purchase to a later Workflow wave; artifact reclaim is always allowed. */
  issueAuthorized: boolean;
}

/**
 * What ONE slice of pass A did, and what is left. The Workflow's wave loop steers on this,
 * so every field is a fact about work, never a summary of intent.
 */
export interface PassASlice {
  /** Every window this document owes is accounted for: answered, or terminally failed. */
  done: boolean;
  windowsTotal: number;
  /** Windows with a usable or terminally-failed artifact after this slice. */
  windowsLanded: number;
  /** NEW model calls this slice issued. A reclaimed window is not a call. */
  windowsIssued: number;
  /** Windows still owed a call — deferred because the budget ran out, or retriably failed. */
  windowsRemaining: number;
  /** A window exhausted a terminal failure, so no later window may be bought for this pass. */
  terminalFailure: boolean;
  /** Candidate reconciliation is its own durable unit after every primary window lands. */
  synthesisState?: PassASynthesisOutcome["state"] | "waiting-for-windows";
  /** Durable synthesis issue count; zero while waiting or before the first purchase. */
  synthesisAttempts?: number;
  /** New provider receipts bought by synthesis in this wave; normally zero or one. */
  synthesisIssued?: number;
  /** The slice stopped issuing because its wall-clock budget was spent. */
  deadlineHit: boolean;
}

export interface PassASliceOptions {
  /**
   * Wall clock this slice may spend ISSUING new model calls. A slice never abandons a call
   * it already issued, so the caller's step timeout must exceed this by at least one whole
   * PURCHASE — see `passAStepTimeoutMs`, which is the only place that arithmetic lives.
   *
   * Omitted (or Infinity) means "no deadline", which is the pre-slicing behaviour and what
   * the dev extraction endpoint — a plain request, with no Workflow step around it — wants.
   */
  budgetMs?: number;
  /** Injectable only so a test can be deterministic; production always reads the clock. */
  now?: () => number;
}

export type PassAResult = PassResult & {
  providerRouteIdentity: string;
  providerIndependence: PassAProviderIndependence;
  routeReceipts: PassARouteReceipt[];
  fallbackTriggers: GrokFallbackTrigger[];
  crossRefs: CrossRef[];
  /** Counted honesty boundary for a synthesis that sees candidates, not every source byte. */
  crossWindowLimitations: PassACrossWindowLimitation[];
  /** Counted candidates withheld from authority because exact document grounding failed. */
  primaryGroundingLimitations: PassAPrimaryGroundingLimitationWire[];
  slice: PassASlice;
  /**
   * The calls this slice ACTUALLY BOUGHT, as opposed to `calls`, which also carries the
   * zero-cost telemetry of every window reclaimed from storage. The run's usage ledger must
   * be charged from THIS list: `modelCalls.used` counts calls, not rows, and re-counting a
   * reclaimed window once per wave would trip CAP_MODEL_CALLS on phantom spend.
   */
  issuedCalls: CallUsage[];
  /** Persisted receipts re-offered to the idempotent usage CAS after any restart. */
  accountingCalls: CallUsage[];
  terminalReasonCode?: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
  credentialRefusal?: { reason: "NO_CREDENTIAL"; binding: string; provider: "grok" | "deepseek" | "gemini" };
};

export type PassACompletedAuthority = Omit<
  PassAResult,
  "issuedCalls" | "accountingCalls"
> & {
  /** Canonical raw receipts reconstructed from immutable per-unit authority, in unit order. */
  calls: CallUsage[];
  issuedCalls: [];
  accountingCalls: CallUsage[];
};

export type PassAAuthorityReconstruction =
  | { kind: "ok"; value: PassACompletedAuthority }
  | {
      kind: "invalid";
      detail: string;
      accountingCalls: CallUsage[];
      slice: PassASlice;
      /** Exact paid unit that blocked reconstruction, when one can be named honestly. */
      failedUnit: PassResult["failedUnits"][number] | null;
    };

export const PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE =
  "legacy-reading-progress-from-artifact-census" as const;

/**
 * Metadata-only compatibility evidence for runs created before structured reading progress.
 *
 * This deliberately cannot carry requirements, model output, dispositions, or coverage. A
 * caller may use it to say how many canonical primary-window artifacts were durably accounted
 * for, and nothing more.
 */
export interface PassAHistoricalProgressCensusValue {
  total: number;
  accounted: number;
  remaining: number;
  failedUnit: PassResult["failedUnits"][number];
  limitation: {
    code: typeof PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE;
    count: 1;
    detail: string;
  };
}

export type PassAHistoricalProgressCensus =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | { kind: "ok"; value: PassAHistoricalProgressCensusValue };

/** Slack over and above the budget and one whole purchase: R2 I/O, parsing, scheduling. */
export const PASS_A_STEP_SLACK_MS = 60_000;

/** Wall clock ONE pass-A slice may spend issuing. Configuration, not a constant. */
export function passAWaveBudgetMs(env: Env): number {
  return Math.max(0, num(env.EXTRACT_PASS_A_WAVE_BUDGET_MS, 600_000));
}

/**
 * THE WORST-CASE WALL CLOCK OF ONE PURCHASE — not of one HTTP attempt.
 *
 * `llm/chat.ts` retries inside a single `grokJson` call: each attempt gets its own
 * `AbortSignal.timeout(LLM_TIMEOUT_MS)` and token usage accrues across all of them, so a
 * purchase that retries is billed for every attempt and occupies the sum of their ceilings.
 * Mirrors chat.ts's own `Math.max(1, maxAttempts ?? 2)` clamp exactly, so a zero or negative
 * knob cannot make this number smaller than the code it is describing.
 */
export function passACallCeilingMs(env: Env): number {
  // Worst case is one exhausted/non-responsive Grok purchase followed by one Flash
  // substitute purchase. The eligible Grok receipt is persisted between them.
  return 2 * Math.max(1, num(env.EXTRACT_MAX_ATTEMPTS, 2)) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));
}

/**
 * THE INVARIANT THAT DELETES THE CLIFF, in one expression.
 *
 * A slice stops ISSUING at its budget but lets an in-flight purchase run to its own ceiling.
 * So the step around it must be allowed to live for the budget PLUS a whole purchase PLUS
 * slack. Anything less and the step axe can fall on a call that was already paid for and not
 * yet persisted — which is precisely the duplicate spend this design removes. Derived from
 * the same knobs the slice and the transport read, so no config change can silently
 * reintroduce the 480 s ceiling.
 */
export function passAStepTimeoutMs(env: Env): number {
  return passAWaveBudgetMs(env) + passACallCeilingMs(env) + PASS_A_STEP_SLACK_MS;
}

/** Exact immutable paid-window writes attempted before storage failure becomes a terminal stop. */
export const PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS = 2;

interface PassAWindowStorageAuthority {
  /** R2 version that the strict reader actually decoded before this purchase. */
  etag: string;
  /** Exact decoded object bytes; an equal-looking replacement is not inferred from fields. */
  bodyText: string;
}

// Storage authority is deliberately not a persisted/projected field. The WeakMap binds the
// exact R2 object version to the in-memory value produced by the strict reader without letting
// an internal CAS token leak into completion payloads or reports.
const passAWindowStorageAuthority = new WeakMap<object, PassAWindowStorageAuthority>();

function rememberPassAWindowStorageAuthority<T extends object>(
  value: T,
  authority: PassAWindowStorageAuthority,
): T {
  passAWindowStorageAuthority.set(value, authority);
  return value;
}

function storageAuthorityOf(
  value: PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null,
): PassAWindowStorageAuthority | null {
  return value === null ? null : passAWindowStorageAuthority.get(value) ?? null;
}

/**
 * A valid, grounded model answer reached the durable-write boundary but could not be
 * proven present afterwards. This is infrastructure failure, never semantic-output
 * authority: the slice returns a terminal no-rebuy outcome carrying the paid receipt. It
 * must not throw into the Workflow step retry policy, rewrite the receipt as parse-failed,
 * or persist an artifact that authorizes another model issue.
 */
class PassAPrimaryPersistenceError extends Error {
  constructor(
    origin: string,
    writeError: unknown,
    retainedState: string,
  ) {
    const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
    super(
      `PASS_A_WINDOW_PERSISTENCE_FAILED: ${origin}: ${writeDetail}; ` +
        `success artifact reread ${retainedState}`,
    );
    this.name = "PassAPrimaryPersistenceError";
  }
}

/**
 * Preserve the losing paid answer verbatim when another invocation wins the canonical-key CAS.
 * The body hash makes this append-only write idempotent; canonical readers ignore this key,
 * while failure inventory can still reconcile the top-level usage receipts in the exact body.
 */
async function persistPrimaryWindowAppendOnly(
  env: Env,
  key: string,
  serialized: string,
  failureCode: string,
): Promise<string> {
  let writeError: unknown = null;
  try {
    const written = await env.EVIDENCE.put(key, serialized, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written !== null) return key;
  } catch (error) {
    // A transport error can arrive after commit. Exact reread below decides, never the throw.
    writeError = error;
  }
  let retained: R2ObjectBody | null;
  try {
    retained = await env.EVIDENCE.get(key);
  } catch (readError) {
    throw new Error(
      `${failureCode}: ${key}: ` +
        `${writeError instanceof Error ? writeError.message : String(writeError ?? "conditional create refused")}; ` +
        `exact reread failed: ${readError instanceof Error ? readError.message : String(readError)}`,
    );
  }
  let retainedText: string | null = null;
  try {
    retainedText = retained === null ? null : await retained.text();
  } catch (readError) {
    throw new Error(
      `${failureCode}: ${key}: exact retained bytes could not be read: ` +
        `${readError instanceof Error ? readError.message : String(readError)}`,
    );
  }
  if (retainedText === serialized) return key;
  throw new Error(
    `${failureCode}: ${key}: append-only key did not retain the exact artifact bytes`,
  );
}

async function persistPrimaryWindowCasConflict(
  env: Env,
  runId: string,
  n: number,
  serialized: string,
): Promise<string> {
  const bodySha256 = await sha256Hex(serialized);
  return persistPrimaryWindowAppendOnly(
    env,
    windowCasConflictKey(runId, n, bodySha256),
    serialized,
    "PASS_A_WINDOW_CAS_CONFLICT_PERSISTENCE_FAILED",
  );
}

async function persistPrimaryWindowHistory(
  env: Env,
  runId: string,
  n: number,
  serialized: string,
): Promise<string> {
  const bodySha256 = await sha256Hex(serialized);
  return persistPrimaryWindowAppendOnly(
    env,
    windowHistoryKey(runId, n, bodySha256),
    serialized,
    "PASS_A_WINDOW_HISTORY_PERSISTENCE_FAILED",
  );
}

/**
 * A paid target that cannot become canonical must still survive under its deterministic
 * append-only conflict key. Returning the error instead of throwing inside this helper lets
 * every terminal branch preserve the same original write context and, when even the conflict
 * namespace fails, report both storage failures without implying that bytes were retained.
 */
async function primaryWindowPersistenceFailure(
  env: Env,
  runId: string,
  n: number,
  origin: string,
  serialized: string,
  writeError: unknown,
  retainedState: string,
): Promise<PassAPrimaryPersistenceError> {
  try {
    const conflictKey = await persistPrimaryWindowCasConflict(env, runId, n, serialized);
    return new PassAPrimaryPersistenceError(
      origin,
      writeError,
      `${retainedState}; exact paid bytes retained at ${conflictKey}`,
    );
  } catch (conflictError) {
    const originalDetail = writeError instanceof Error ? writeError.message : String(writeError);
    const conflictDetail = conflictError instanceof Error ? conflictError.message : String(conflictError);
    return new PassAPrimaryPersistenceError(
      origin,
      `${originalDetail}; append-only conflict retention also failed: ${conflictDetail}`,
      `${retainedState}; exact paid bytes could not be retained`,
    );
  }
}

/**
 * Persist one already-paid window artifact without ever repeating the model purchase.
 *
 * The bytes are constructed by the caller exactly once. A failed put is ambiguous because
 * R2 can report a transport error after commit, so recovery first compares the retained
 * bytes and then runs the normal current-identity strict reader. A missing artifact permits
 * another put of the SAME bytes; an occupied different/invalid key is immutable authority
 * and stops immediately.
 */
async function persistPrimaryWindowArtifact(
  env: Env,
  runId: string,
  n: number,
  source: SourceBlock[],
  parserVersion: string,
  origin: string,
  predecessor: PassAWindowStorageAuthority | null,
  serialized: string,
  accept: (artifact: PersistedWindow | FailedWindowArtifact) => boolean,
): Promise<PersistedWindow | FailedWindowArtifact | null> {
  let lastFailure: PassAPrimaryPersistenceError | null = null;
  let expected = predecessor;
  const key = windowKey(runId, n);
  if (expected !== null) {
    try {
      await persistPrimaryWindowHistory(env, runId, n, expected.bodyText);
    } catch (historyError) {
      throw await primaryWindowPersistenceFailure(
        env,
        runId,
        n,
        origin,
        serialized,
        historyError,
        "could not archive the exact predecessor before replacement",
      );
    }
  }
  for (
    let storageAttempt = 1;
    storageAttempt <= PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS;
    storageAttempt += 1
  ) {
    let writeError: unknown;
    try {
      const written = await env.EVIDENCE.put(
        key,
        serialized,
        {
          httpMetadata: { contentType: "application/json" },
          onlyIf: expected === null
            ? { etagDoesNotMatch: "*" }
            : { etagMatches: expected.etag },
        },
      );
      if (written !== null) return null;
      writeError = new Error(
        expected === null
          ? "conditional create found an occupied window key"
          : "conditional replacement no longer matched the exact predecessor",
      );
    } catch (error) {
      writeError = error;
    }
    {
      let object: R2ObjectBody | null;
      try {
        object = await env.EVIDENCE.get(key);
      } catch (readError) {
        const readDetail = readError instanceof Error ? readError.message : String(readError);
        lastFailure = new PassAPrimaryPersistenceError(
          origin,
          writeError,
          `failed with ${readDetail}`,
        );
        continue;
      }
      if (object === null) {
        if (expected !== null) {
          throw await primaryWindowPersistenceFailure(
            env,
            runId,
            n,
            origin,
            serialized,
            writeError,
            "found the exact predecessor missing; refusing to recreate over lost retained authority",
          );
        }
        lastFailure = new PassAPrimaryPersistenceError(
          origin,
          writeError,
          "found no current artifact",
        );
        continue;
      }
      let retainedBytes: string;
      try {
        retainedBytes = await object.text();
      } catch (readError) {
        const readDetail = readError instanceof Error ? readError.message : String(readError);
        lastFailure = new PassAPrimaryPersistenceError(
          origin,
          writeError,
          `could not read retained bytes: ${readDetail}`,
        );
        continue;
      }
      if (retainedBytes !== serialized) {
        if (expected !== null && retainedBytes === expected.bodyText) {
          // A before-commit transport error, or an equal-byte predecessor re-put, leaves the
          // exact authority in place. Bind the next bounded CAS to the version just reread.
          expected = { etag: object.etag, bodyText: retainedBytes };
          lastFailure = new PassAPrimaryPersistenceError(
            origin,
            writeError,
            "found the exact predecessor still present",
          );
          continue;
        }
        throw await primaryWindowPersistenceFailure(
          env,
          runId,
          n,
          origin,
          serialized,
          writeError,
          "found an occupied artifact with different bytes; the winner was not overwritten",
        );
      }
      let retained: PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null;
      try {
        retained = await readWindow(env, runId, n, source, parserVersion, origin);
      } catch (readError) {
        const readDetail = readError instanceof Error ? readError.message : String(readError);
        lastFailure = new PassAPrimaryPersistenceError(
          origin,
          writeError,
          `strict reread failed with ${readDetail}`,
        );
        continue;
      }
      if (retained !== null && retained.kind !== "invalid" && accept(retained)) return retained;
      throw await primaryWindowPersistenceFailure(
        env,
        runId,
        n,
        origin,
        serialized,
        writeError,
        retained === null ? "lost the exact artifact before strict reread" :
          `found exact bytes with ${retained.kind} authority that failed the expected-state check`,
      );
    }
  }
  throw await primaryWindowPersistenceFailure(
    env,
    runId,
    n,
    origin,
    serialized,
    lastFailure ?? "unknown storage failure",
    "did not prove the exact current artifact",
  );
}

async function persistImmutableExtractionArtifact(
  env: Env,
  key: string,
  bodyText: string,
  unit: string,
): Promise<void> {
  const written = await env.EVIDENCE.put(key, bodyText, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return;
  const retained = await env.EVIDENCE.get(key);
  if (!retained || await retained.text() !== bodyText) {
    throw new Error(
      `EXTRACTION_WIRE_CEILING_ARTIFACT_IMMUTABLE: ${unit} exact key is occupied by ` +
        `different bytes; it was not overwritten and no provider request was issued`,
    );
  }
}

export async function runPassA(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  onProgress?: (msg: string) => Promise<void>,
  options?: PassASliceOptions,
  onUnitStart?: DocumentReadingUnitStartObserver,
): Promise<PassAResult> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const providerRouteIdentity = grokFlashRouteIdentity(env);
  // Local, NOT module scope: one isolate serves many runs, and a module-level accumulator
  // would let two concurrent extractions read each other's cross-references.
  const crossRefs: CrossRef[] = [];
  const windows = splitWindows(
    doc.blocks,
    num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000),
    num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 100),
  );
  const requirements: RawRequirement[] = [];
  const ambiguities: PassResult["ambiguities"] = [];
  const unverifiable: PassResult["unverifiable"] = [];
  const failedUnits: PassResult["failedUnits"] = [];
  const calls: CallUsage[] = [];
  const issuedCalls: CallUsage[] = [];
  const accountingCalls: CallUsage[] = [];
  const routeReceipts: PassARouteReceipt[] = [];
  const fallbackTriggers: GrokFallbackTrigger[] = [];
  const crossWindowLimitations: PassACrossWindowLimitation[] = [];
  const primaryGroundingLimitations: PassAPrimaryGroundingLimitationWire[] = [];
  let providerIndependence: PassAProviderIndependence = "independent";
  const model = DEFAULT_GROK_MODEL;
  let resolvedGrokKey: string | null = null;
  let resolvedDeepseekKey: string | null = null;
  let resolvedGeminiKey: string | null = null;
  const purchaseEnvFor = async (needsGrok: boolean, needsDeepseek: boolean): Promise<Env> => {
    if (needsGrok && resolvedGrokKey === null) resolvedGrokKey = await keyFor(env, "grok");
    if (needsDeepseek && resolvedDeepseekKey === null) {
      resolvedDeepseekKey = await keyFor(env, "deepseek");
    }
    return {
      ...env,
      ...(resolvedGrokKey !== null ? { XAI_API_KEY: resolvedGrokKey } : {}),
      ...(resolvedDeepseekKey !== null ? { DEEPSEEK_API_KEY: resolvedDeepseekKey } : {}),
      ...(resolvedGeminiKey !== null ? { GEMINI_API_KEY: resolvedGeminiKey } : {}),
    };
  };
  /** Resolve the Gemini key lazily — only when the substitution path is actually taken. */
  const resolveGeminiKey = async (): Promise<void> => {
    if (resolvedGeminiKey === null) {
      resolvedGeminiKey = await keyForGemini(env);
    }
  };

  // THE DEADLINE, AND THE ONE EXCEPTION TO IT. `issued === 0` keeps the first call of every
  // slice unconditional: a slice that issues nothing makes no progress, and a wave loop over
  // slices that make no progress runs its whole budget of steps without moving. Guaranteed
  // forward progress is what makes the wave count a bound on the DOCUMENT rather than a
  // bound on luck.
  const now = options?.now ?? (() => Date.now());
  const budgetMs = options?.budgetMs ?? Number.POSITIVE_INFINITY;
  const deadlineAt = Number.isFinite(budgetMs) ? now() + Math.max(0, budgetMs) : Number.POSITIVE_INFINITY;
  let issued = 0;
  let deadlineHit = false;
  const mayIssue = (): boolean => {
    if (issued === 0) return true;
    if (now() < deadlineAt) return true;
    deadlineHit = true;
    return false;
  };

  const maxIssues = Math.max(1, num(env.EXTRACT_PASS_A_WINDOW_MAX_ISSUES, 2));

  const primaryWireMaxBytes = extractionWirePolicy(env).maxInputBytes;
  const primaryPlanFor = (
    source: SourceBlock[],
    n: number,
    label: string | null,
  ) => {
    const jsonl = buildBoundedSourceBlocksJsonl(source, primaryWireMaxBytes);
    const origin = windows.length === 1 ? "A" : `A-w${n}`;
    if (!jsonl.ok) {
      return {
        ok: false as const,
        detail: extractionWirePreSerializationFailureDetail(
          origin, source.length, jsonl, "EXTRACT_MODEL_INPUT_MAX_BYTES",
        ),
      };
    }
    const optionsForCall = {
      system: SYSTEM_A,
      user: userMessageA(documentName, jsonl.text, label),
      maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
      role: `extract-pass-a${label ? `-w${n}` : ""}`,
      callId: `call_a_${n}`,
      maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
    };
    const check = preflightExtractionRequestBodies(env, [
      { route: "grok-4.6", bodyText: chatRequestBodyText(grokRequestShape(env), optionsForCall) },
      {
        route: "gemini-2.5-flash",
        bodyText: chatRequestBodyText(geminiGrokSubstituteRequestShape(env), optionsForCall),
      },
      {
        route: "deepseek-v4-flash",
        bodyText: chatRequestBodyText(deepseekGrokFallbackRequestShape(env), optionsForCall),
      },
    ]);
    return check.ok
      ? { ok: true as const, optionsForCall }
      : { ok: false as const, detail: extractionWireFailureDetail(origin, source.length, check) };
  };

  // EXTRACTION_WIRE_PREFLIGHT_BEFORE_PRIMARY_PURCHASE: serialize BOTH possible route
  // bodies for EVERY canonical window before A-w1 can spend. A later giant/escaped block
  // therefore cannot be discovered only after earlier windows have already been bought.
  const primaryWireChecks = windows.map((source, index) => {
    const n = index + 1;
    const label = windows.length === 1
      ? null
      : `window ${n} of ${windows.length} (${source[0]!.blockId}–${source[source.length - 1]!.blockId})`;
    const plan = primaryPlanFor(source, n, label);
    // The all-window barrier retains only compact verdicts. Keeping every accepted user/body
    // string would turn thousands of independently safe windows into an aggregate Worker OOM.
    return plan.ok ? { ok: true as const } : plan;
  });
  let pendingPrimaryWireFailure: {
    index: number;
    detail: string;
  } | null = null;
  for (let index = 0; index < primaryWireChecks.length; index += 1) {
    const check = primaryWireChecks[index]!;
    const n = index + 1;
    const origin = windows.length === 1 ? "A" : `A-w${n}`;
    const retained = await readWindow(env, runId, n, windows[index]!, parserVersion, origin);
    // A retained terminal wire refusal is itself wave-wide authority. Re-entry must not
    // touch a credential or buy an earlier missing/retryable unit before reaching it.
    if (retained?.kind === "failed" && retained.terminal && retained.wireCeiling) {
      pendingPrimaryWireFailure = { index, detail: retained.detail };
      break;
    }
    if (check.ok) continue;
    // A successful current artifact already owns this unit. Invalid or other terminal
    // authority still makes the wave non-purchasing; its own strict failure is surfaced
    // when the ordered reclaim loop reaches it rather than being relabelled as wire overflow.
    if (retained?.kind === "ok") continue;
    if (retained?.kind === "invalid" || retained?.terminal) {
      pendingPrimaryWireFailure = { index, detail: check.detail };
      break;
    }
    pendingPrimaryWireFailure = { index, detail: check.detail };
    break;
  }

  let landed = 0;
  let remaining = 0;
  let terminalFailure = false;
  let synthesisState: PassASlice["synthesisState"] =
    windows.length > 1 ? "waiting-for-windows" : "not-required";
  let synthesisIssued = 0;
  let synthesisAttempts = 0;
  let terminalReasonCode: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED | undefined;
  let credentialRefusal: PassAResult["credentialRefusal"];

  // WINDOWS ARE WALKED IN DOCUMENT ORDER, ONE AT A TIME. See the header for why this pass
  // does not fan out. The order matters beyond latency: it is what makes `requirements`,
  // `A-wN` origins and the diff's provenance identical regardless of which wave bought
  // which window.
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const n = i + 1;
    const blockIds = w.map((b) => b.blockId);
    const label =
      windows.length === 1 ? null : `window ${n} of ${windows.length} (${w[0]!.blockId}–${w[w.length - 1]!.blockId})`;
    const origin = windows.length === 1 ? "A" : `A-w${n}`;

    // This awaited structured write is deliberately BEFORE the artifact read and therefore
    // before any possible purchase. A failed visibility write throws without buying model
    // work; the Workflow can retry the checkpoint write without ever re-buying this unit.
    if (onUnitStart) {
      await onUnitStart({
        stage: "primary-windows",
        unit: {
          kind: "window",
          name: origin,
          ordinal: n,
          total: windows.length,
          sourceContext: sourceContextForUnit(doc.blocks, blockIds),
        },
        primary: {
          total: windows.length,
          landed,
          remaining: windows.length - landed,
          synthesisState: "waiting-for-windows",
        },
        secondary: null,
      });
    }

    const absorb = (unit: PersistedWindow): void => {
      requirements.push(...unit.globalRules);
      crossRefs.push(...unit.crossRefs);
      ambiguities.push(...unit.ambiguities);
      unverifiable.push(...unit.unverifiable);
      // PASS_A_PRIMARY_GROUNDING_LIMITATION_AGGREGATE: withheld rows remain counted in
      // deterministic window/row order without entering requirements or synthesis input.
      primaryGroundingLimitations.push(...unit.primaryGroundingLimitations);
    };

    // -----------------------------------------------------------------------
    // RECLAIM. Free: an R2 read, never metered by the deadline.
    //
    // A window already on disk is a window already paid for. Re-running pass A after a
    // crash, a Workflow step retry, a wave boundary or a dev-server restart must not buy the
    // same answer twice — and because each artifact names the blocks it owns, a reclaimed
    // window is exactly as accountable as a fresh one.
    // -----------------------------------------------------------------------
    const existing = await readWindow(env, runId, n, w, parserVersion, origin);
    let predecessorAuthority = storageAuthorityOf(existing);

    if (
      pendingPrimaryWireFailure?.index === i &&
      (existing === null || (existing.kind === "failed" && !existing.terminal))
    ) {
      const detail = pendingPrimaryWireFailure.detail;
      const wireArtifact = JSON.stringify(
        {
          windowId: origin,
          windowNumber: n,
          blockIds,
          parserVersion,
          promptVersion: PROMPT_VERSION_A,
          providerRouteIdentity,
          windowPolicyIdentity: windowPolicyIdentity(env),
          status: "failed",
          attempts: 0,
          usages: [],
          fallbackTrigger: null,
          terminal: true,
          failureStage: "wire-ceiling",
          detail,
        },
        null,
        2,
      );
      if (existing?.kind === "failed") {
        accountingCalls.push(...existing.usages);
        for (const usage of existing.usages) {
          calls.push({ ...usage, detail: "reused: prior failed pass-A purchase", costUsd: 0 });
        }
        if (existing.fallbackTrigger !== null) fallbackTriggers.push(existing.fallbackTrigger);
        await persistImmutableExtractionArtifact(
          env,
          windowWireCeilingKey(runId, n),
          wireArtifact,
          origin,
        );
      } else {
        await persistImmutableExtractionArtifact(
          env, windowKey(runId, n), wireArtifact, origin,
        );
      }
      landed += 1;
      terminalFailure = true;
      terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
      failedUnits.push({ unit: origin, blockIds, detail });
      remaining += windows.length - (i + 1);
      if (onProgress) {
        try {
          await onProgress(`pass A ${origin}: FAILED — ${publicExtractionFailureDetail(detail)}`);
        } catch {
          // The zero-purchase terminal artifact is already durable authority.
        }
      }
      break;
    }

    if (existing?.kind === "invalid") {
      accountingCalls.push(...existing.usages);
      for (const usage of existing.usages) {
        calls.push({ ...usage, detail: "reused: invalid retained pass-A window artifact", costUsd: 0 });
      }
      landed += 1;
      terminalFailure = true;
      failedUnits.push({ unit: origin, blockIds, detail: existing.detail });
      remaining += windows.length - (i + 1);
      break;
    }

    if (existing && existing.kind === "ok") {
      landed += 1;
      accountingCalls.push(...existing.usages);
      for (const usage of existing.usages) {
        calls.push({
          ...usage,
          detail: "reused: this window was already persisted by an earlier attempt",
          costUsd: 0,
        });
      }
      routeReceipts.push(existing.routeReceipt);
      if (existing.routeReceipt.trigger !== null) {
        fallbackTriggers.push(existing.routeReceipt.trigger);
        providerIndependence = "reduced-same-provider-fallback";
      }
      absorb(existing);
      if (onProgress) {
        try {
          await onProgress(`pass A ${origin}: reused a previously persisted window`);
        } catch {
          // A heartbeat is observability, never authority to retry durable model work.
        }
      }
      // A receipted Flash result makes the configured DeepSeek Pass B ineligible forever.
      // Stop buying later windows immediately; the stage turns this completed provider
      // decision into a named, non-retrying terminal result after settling these receipts.
      if (existing.routeReceipt.trigger !== null) {
        remaining += windows.length - (i + 1);
        break;
      }
      continue;
    }

    const priorUsages = existing && existing.kind === "failed" ? existing.usages : [];
    if (existing && existing.kind === "failed") {
      accountingCalls.push(...existing.usages);
      for (const usage of existing.usages) {
        calls.push({ ...usage, detail: "reused: prior failed pass-A purchase", costUsd: 0 });
      }
      if (existing.fallbackTrigger !== null) {
        fallbackTriggers.push(existing.fallbackTrigger);
      }
      if (existing.terminal) {
        landed += 1;
        terminalFailure = true;
        if (existing.wireCeiling) {
          terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
        }
        failedUnits.push({
          unit: origin,
          blockIds,
          detail: `window ${origin} has a retained terminal failure: ${existing.detail}`,
        });
        remaining += windows.length - (i + 1);
        break;
      }
    }

    // A FAILED WINDOW IS RE-ISSUED A BOUNDED NUMBER OF TIMES, ACROSS THE WHOLE RUN — the
    // artifact carries the count, so waves and recovery instances share one budget rather
    // than each getting a fresh one. Unbounded re-issue is how one pass-B chunk id came to
    // be billed 21–24 times during a recovery storm; the same arithmetic applies here, on a
    // call that costs far more.
    const pendingSubstitute = existing && existing.kind === "failed" &&
      existing.fallbackTrigger !== null &&
      !existing.usages.some((usage) => usage.provider === "deepseek" || usage.provider === "gemini");
    if (existing && existing.kind === "failed" && existing.attempts >= maxIssues && !pendingSubstitute) {
      landed += 1;
      failedUnits.push({
        unit: origin,
        blockIds,
        detail: `window ${origin} failed after ${existing.attempts} attempt(s): ${existing.detail}`,
      });
      terminalFailure = true;
      remaining += windows.length - (i + 1);
      break;
    }

    const priorAttempts = existing && existing.kind === "failed" ? existing.attempts : 0;

    // A later canonical window already failed the all-window wire preflight. Reclaiming
    // durable earlier work is safe, but buying any missing/retryable earlier unit is not.
    if (pendingPrimaryWireFailure !== null) {
      remaining += 1;
      continue;
    }

    if (!mayIssue()) {
      remaining += 1;
      continue;
    }
    const purchasePlan = primaryPlanFor(w, n, label);
    if (!purchasePlan.ok) {
      const detail = purchasePlan.detail;
      const wireArtifact = JSON.stringify({
        windowId: origin,
        windowNumber: n,
        blockIds,
        parserVersion,
        promptVersion: PROMPT_VERSION_A,
        providerRouteIdentity,
        windowPolicyIdentity: windowPolicyIdentity(env),
        status: "failed",
        attempts: 0,
        usages: [],
        fallbackTrigger: null,
        terminal: true,
        failureStage: "wire-ceiling",
        detail,
      }, null, 2);
      if (existing?.kind === "failed") {
        await persistImmutableExtractionArtifact(
          env, windowWireCeilingKey(runId, n), wireArtifact, origin,
        );
      } else {
        await persistImmutableExtractionArtifact(
          env, windowKey(runId, n), wireArtifact, origin,
        );
      }
      landed += 1;
      terminalFailure = true;
      terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
      failedUnits.push({ unit: origin, blockIds, detail });
      remaining += windows.length - (i + 1);
      break;
    }
    const optionsForCall = purchasePlan.optionsForCall;
    let purchaseEnv: Env;
    try {
      // A fresh unit may legitimately fall back, so Grok and DeepSeek credentials are
      // resolved once after all-window wire preflight but before Grok can spend. Gemini
      // credentials are resolved lazily inside the substitution path only when needed.
      // A retained fallback checkpoint needs only substitutes. The cloned env turns
      // subsequent client reads into side-effect-free string lookups.
      purchaseEnv = await purchaseEnvFor(
        !(existing?.kind === "failed" && existing.fallbackTrigger !== null),
        true,
      );
    } catch (error) {
      if (!(error instanceof MissingCredential)) throw error;
      credentialRefusal = {
        reason: "NO_CREDENTIAL",
        binding: error.binding,
        provider: error.binding === "XAI_API_KEY" ? "grok" : error.binding === "GEMINI_API_KEY" ? "gemini" : "deepseek",
      };
      terminalFailure = true;
      const detail = `${error.binding} is unavailable after request-size preflight; no new ` +
        `provider request was issued for ${origin}.`;
      failedUnits.push({ unit: origin, blockIds, detail });
      remaining += windows.length - i;
      break;
    }
    issued += 1;

    const purchasedUsages: CallUsage[] = [];
    let rawModelOutput: Record<string, unknown> | null = null;
    let fallbackTrigger = existing && existing.kind === "failed" ? existing.fallbackTrigger : null;
    const issue = pendingSubstitute ? Math.max(1, priorAttempts) : priorAttempts + 1;

    try {
      let value: Record<string, unknown> | null = null;
      let routeReceipt: PassARouteReceipt | null = null;

      if (fallbackTrigger === null) {
        try {
          const outcome = await grokJson(purchaseEnv, optionsForCall);
          const usage = settlementUsage(runId, origin, issue, 1, outcome.usage);
          purchasedUsages.push(usage);
          calls.push(usage);
          issuedCalls.push(usage);
          accountingCalls.push(usage);
          value = outcome.value;
          rawModelOutput = outcome.value;
          routeReceipt = { selected: "grok-4.6", trigger: null };
        } catch (err) {
          if (!(err instanceof ModelCallError) || !grokFlashFallbackEligible(err)) throw err;
          const usage = settlementUsage(runId, origin, issue, 1, err.usage);
          purchasedUsages.push(usage);
          calls.push(usage);
          issuedCalls.push(usage);
          accountingCalls.push(usage);
          fallbackTrigger = {
            kind: GROK_FALLBACK_TRIGGER_VERSION,
            failureKind: err.failureKind,
            httpStatus: err.httpStatus,
            grokModel: DEFAULT_GROK_MODEL,
            grokUsageEventId: usage.eventId!,
            detail: err.message.slice(0, 400),
          };
          fallbackTriggers.push(fallbackTrigger);
          // COMMIT AUTHORITY BEFORE EFFECT. If the isolate dies after this put, the next
          // invocation sees the exact paid Grok receipt and calls Flash directly. It cannot
          // retry Grok and erase the condition that authorized another provider purchase.
          const authorizedTrigger = fallbackTrigger;
          const fallbackArtifact = JSON.stringify({
            windowId: origin,
            windowNumber: n,
            blockIds,
            parserVersion,
            promptVersion: PROMPT_VERSION_A,
            providerRouteIdentity,
            windowPolicyIdentity: windowPolicyIdentity(env),
            status: "failed",
            attempts: issue,
            usages: [...priorUsages, ...purchasedUsages],
            fallbackTrigger: authorizedTrigger,
            terminal: false,
            failureStage: "fallback-authorized",
            detail: `Flash fallback authorized but not yet landed: ${authorizedTrigger.detail}`,
          }, null, 2);
          const retainedFallbackCheckpoint = await persistPrimaryWindowArtifact(
            env,
            runId,
            n,
            w,
            parserVersion,
            origin,
            predecessorAuthority,
            fallbackArtifact,
            (artifact) =>
              artifact.kind === "failed" &&
              artifact.terminal === false &&
              artifact.fallbackTrigger?.grokUsageEventId === authorizedTrigger.grokUsageEventId,
          );
          if (retainedFallbackCheckpoint !== null) {
            // The checkpoint committed despite its transport error. Preserve the existing
            // commit-before-effect boundary: end this wave pending and let the next wave buy
            // Flash from retained authority rather than adding another provider effect to
            // the invocation that observed an uncertain write response.
            throw new Error("pass-A fallback checkpoint was recovered after its transport failed");
          }
          const committedFallbackCheckpoint = await readWindow(
            env, runId, n, w, parserVersion, origin,
          );
          const committedFallbackAuthority = storageAuthorityOf(committedFallbackCheckpoint);
          if (
            committedFallbackCheckpoint?.kind !== "failed" ||
            committedFallbackCheckpoint.terminal ||
            committedFallbackCheckpoint.fallbackTrigger?.grokUsageEventId !==
              authorizedTrigger.grokUsageEventId ||
            committedFallbackAuthority === null ||
            committedFallbackAuthority.bodyText !== fallbackArtifact
          ) {
            throw new Error(
              "pass-A fallback checkpoint committed but its exact strict predecessor authority could not be reread",
            );
          }
          predecessorAuthority = committedFallbackAuthority;
        }
      }

      if (fallbackTrigger !== null) {
        // SUBSTITUTION CHAIN (owner-approved 15 Aug 2026):
        // 1. Gemini gemini-2.5-flash — cross-family, preserves full independence
        // 2. DeepSeek Flash — same family as pass B, reduces independence (existing path)
        //
        // Gemini is attempted first. If it fails with a typed eligible error, the existing
        // DeepSeek Flash path fires as the last resort with its unchanged semantics.
        let substituteSucceeded = false;

        let geminiAttempted = false;

        // Resolve Gemini key lazily — only when a Grok failure has already happened
        try {
          await resolveGeminiKey();
          // Re-create the purchase env with the resolved Gemini key
          purchaseEnv = await purchaseEnvFor(false, false);
        } catch (geminiKeyErr) {
          if (geminiKeyErr instanceof MissingCredential) {
            // No Gemini key: fall through to DeepSeek Flash directly
            geminiAttempted = false;
          } else {
            throw geminiKeyErr;
          }
        }

        if (resolvedGeminiKey !== null) try {
          // ENFORCE cumulative Gemini cap BEFORE the purchase. A conservative reservation
          // uses request-byte ceiling as input tokens and max_tokens as output tokens,
          // mirroring how Grok reserves at its max-known rates.
          const geminiShape = geminiGrokSubstituteRequestShape(purchaseEnv);
          const geminiBodyBytes = new TextEncoder().encode(
            chatRequestBodyText(geminiShape, optionsForCall),
          ).byteLength;
          const geminiRates = GEMINI_OFFICIAL_RATES[DEFAULT_GEMINI_MODEL];
          const geminiReservation = conservativeGeminiReservation(
            geminiBodyBytes,
            Math.max(0, Math.ceil(optionsForCall.maxTokens)),
            geminiRates.inputUsdPerMTok,
            geminiRates.outputUsdPerMTok,
          );
          await enforceGeminiCap(purchaseEnv.EVIDENCE, geminiMaxTotalUsd(purchaseEnv), geminiReservation);

          const geminiOutcome = await geminiGrokSubstituteJson(purchaseEnv, {
            ...optionsForCall,
            callId: `${optionsForCall.callId}:grok-gemini-substitute`,
          });
          const geminiUsage = settlementUsage(runId, origin, issue, 2, geminiOutcome.usage);
          purchasedUsages.push(geminiUsage);
          calls.push(geminiUsage);
          issuedCalls.push(geminiUsage);
          accountingCalls.push(geminiUsage);
          value = geminiOutcome.value;
          rawModelOutput = geminiOutcome.value;
          routeReceipt = { selected: "gemini-2.5-flash", trigger: fallbackTrigger };
          providerIndependence = "independent-gemini-substitute";
          substituteSucceeded = true;
          geminiAttempted = true;
        } catch (geminiErr) {
          geminiAttempted = true;
          // Record the Gemini failure usage if it was a model call error
          if (geminiErr instanceof ModelCallError) {
            const geminiUsage = settlementUsage(runId, origin, issue, 2, geminiErr.usage);
            purchasedUsages.push(geminiUsage);
            calls.push(geminiUsage);
            issuedCalls.push(geminiUsage);
            accountingCalls.push(geminiUsage);
          }
          // Cap exceeded or ledger corrupt: typed refusal, fall through to DeepSeek Flash
          if (geminiErr instanceof ProviderCapExceededRefusal) {
            // Fall through to DeepSeek Flash — the run continues reduced, not killed
          } else if (geminiErr instanceof ProviderLedgerCorrupt) {
            // Corrupt ledger = fail closed for Gemini, fall through to DeepSeek Flash
          } else if (geminiErr instanceof ModelCallError && grokFlashFallbackEligible(geminiErr)) {
            // Fall through to DeepSeek Flash below
          } else if (geminiErr instanceof MissingCredential) {
            // No Gemini key: fall through to DeepSeek Flash
          } else {
            // Non-eligible Gemini error: fall through to DeepSeek Flash as last resort
            // (semantic/parse errors on Gemini still allow DeepSeek Flash attempt)
          }
        }

        if (!substituteSucceeded) {
          // DeepSeek Flash as last resort — existing reduced-independence path, unchanged
          const flashOutcome = await deepseekGrokFallbackJson(purchaseEnv, {
            ...optionsForCall,
            callId: `${optionsForCall.callId}:grok-fallback`,
          });
          const flashReceiptIndex = geminiAttempted ? 3 : 2;
          const flashUsage = settlementUsage(runId, origin, issue, flashReceiptIndex, flashOutcome.usage);
          purchasedUsages.push(flashUsage);
          calls.push(flashUsage);
          issuedCalls.push(flashUsage);
          accountingCalls.push(flashUsage);
          value = flashOutcome.value;
          rawModelOutput = flashOutcome.value;
          routeReceipt = { selected: "deepseek-v4-flash", trigger: fallbackTrigger };
          providerIndependence = "reduced-same-provider-fallback";
        }
      }
      if (value === null || routeReceipt === null) {
        throw new Error("pass-A provider route produced neither a primary nor a fallback outcome");
      }

      const strict = strictPrimaryOutput(value, origin);

      // ONE OBJECT IS BOTH PERSISTED AND ABSORBED, so what a resumed wave reads back cannot
      // drift from what this wave used. Written as two literals it drifted silently once
      // already elsewhere in this codebase; here it would mean a resumed pass quietly
      // publishing less than the pass that paid for it.
      let landedWindow = inspectPrimaryWindowGrounding({
        kind: "ok",
        ...strict,
        primaryGroundingLimitations: [],
        usages: [...priorUsages, ...purchasedUsages],
        routeReceipt,
      }, w, origin).unit;

      // PERSIST FIRST, ACCUMULATE SECOND. Serialize ONCE, then retry only these exact bytes:
      // a storage retry can never become another model purchase or a drifted projection.
      const successArtifact = JSON.stringify(
        {
          windowId: origin,
          windowNumber: n,
          blockIds,
          parserVersion,
          promptVersion: PROMPT_VERSION_A,
          providerRouteIdentity,
          windowPolicyIdentity: windowPolicyIdentity(env),
          attempts: issue,
          modelOutput: value,
          ...landedWindow,
        },
        null,
        2,
      );
      const retainedSuccess = await persistPrimaryWindowArtifact(
        env,
        runId,
        n,
        w,
        parserVersion,
        origin,
        predecessorAuthority,
        successArtifact,
        (artifact) => artifact.kind === "ok",
      );
      if (retainedSuccess?.kind === "ok") {
        landedWindow = retainedSuccess;
        routeReceipt = retainedSuccess.routeReceipt;
      }

      landed += 1;
      routeReceipts.push(routeReceipt);
      absorb(landedWindow);
      // Progress is best-effort observability. Once the model answer and receipt are
      // durably persisted, a heartbeat error cannot relabel that purchase as failed.
      if (onProgress) {
        try {
          await onProgress(
            `pass A ${origin}: ${landedWindow.globalRules.length} grounded cross-cutting rule(s), ` +
              `${landedWindow.crossRefs.length} grounded cross-reference(s), ` +
              `${landedWindow.primaryGroundingLimitations.length} candidate limitation(s) over ` +
              `${blockIds.length} block(s)`,
          );
        } catch {
          // Preserve the successful artifact and continue/reclaim; never authorize rebuy.
        }
      }
      if (routeReceipt.trigger !== null) {
        remaining += windows.length - (i + 1);
        break;
      }
    } catch (err) {
      // Credential resolution belongs to the provider client, after the exact request-body
      // preflight above. Let the stage report a missing binding; it is neither a provider
      // purchase nor a semantic model-output failure and must not mint either artifact.
      if (err instanceof MissingCredential && purchasedUsages.length === 0) throw err;
      // Persistence is outside both the semantic/provider retry policy AND the Workflow
      // step retry policy. Return a terminal result carrying the still-ok paid receipt so
      // stagePassASlice charges it once; throwing here would re-enter with no artifact and
      // buy the model answer again.
      if (err instanceof PassAPrimaryPersistenceError) {
        const detail = err.message.slice(0, 400);
        terminalFailure = true;
        failedUnits.push({ unit: origin, blockIds, detail });
        remaining += windows.length - i;
        if (onProgress) {
          try {
            await onProgress(
              `pass A ${origin}: FAILED — ${publicExtractionFailureDetail("pass-a-success-artifact-persistence-failed")}`,
            );
          } catch {
            // The terminal no-rebuy outcome and paid receipt remain authoritative in memory.
          }
        }
        break;
      }
      // R2 may report a transport failure after committing the fallback-authority PUT.
      // Re-read the exact unit before writing any different state: if the checkpoint is
      // present, it owns recovery and the next invocation must buy only the pending Flash
      // receipt on this same issue. Overwriting it here would make crash timing erase the
      // authorization boundary and either re-buy Grok or terminalize paid work.
      if (
        !(err instanceof ModelCallError) && fallbackTrigger !== null &&
        purchasedUsages.length === 1 && purchasedUsages[0]?.provider === "grok"
      ) {
        const retained = await readWindow(env, runId, n, w, parserVersion, origin);
        if (
          retained?.kind === "failed" && !retained.terminal && retained.fallbackTrigger !== null &&
          retained.fallbackTrigger.grokUsageEventId === fallbackTrigger.grokUsageEventId &&
          !retained.usages.some((usage) => usage.provider === "deepseek")
        ) {
          const detail = `Flash fallback remains durably authorized after checkpoint transport failure: ` +
            `${err instanceof Error ? err.message : String(err)}`;
          failedUnits.push({ unit: origin, blockIds, detail });
          remaining += windows.length - i;
          if (onProgress) {
            try { await onProgress(`pass A ${origin}: fallback checkpoint retained; Flash remains pending`); }
            catch { /* Observability cannot rewrite retained authority. */ }
          }
          break;
        }
      }
      if (err instanceof ModelCallError) {
        const receiptIndex = fallbackTrigger !== null ? 2 : 1;
        const usage = settlementUsage(runId, origin, issue, receiptIndex, err.usage);
        purchasedUsages.push(usage);
        calls.push(usage);
        issuedCalls.push(usage);
        accountingCalls.push(usage);
      }
      const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
      const publicDetail = publicExtractionFailureDetail(
        err instanceof ModelCallError
          ? `extraction-provider-${err.failureKind}`
          : "extraction-pass-a-semantic-output-invalid",
      );
      if (!(err instanceof ModelCallError) && purchasedUsages.length > 0) {
        const selected = purchasedUsages[purchasedUsages.length - 1]!;
        purchasedUsages[purchasedUsages.length - 1] = {
          ...selected,
          status: "parse-failed",
          detail: `semantic output rejected: ${detail}`.slice(0, 400),
        };
        const replaceByEventId = (rows: CallUsage[]): void => {
          const index = rows.findIndex((usage) => usage.eventId === selected.eventId);
          if (index >= 0) rows[index] = purchasedUsages[purchasedUsages.length - 1]!;
        };
        replaceByEventId(calls);
        replaceByEventId(issuedCalls);
        replaceByEventId(accountingCalls);
      }
      // `issue` is the durable per-window issue number. On recovery after the Grok
      // fallback-authority PUT, pending Flash belongs to that SAME issue; incrementing
      // `priorAttempts` here would make crash timing consume an issue that was never bought.
      const attempts = issue;
      const nonRetryablePrimaryFailure =
        fallbackTrigger === null && err instanceof ModelCallError && !grokFlashFallbackEligible(err);
      const durableTerminal =
        !(err instanceof ModelCallError) || nonRetryablePrimaryFailure || attempts >= maxIssues;
      // A failed window is an artifact too, so its re-purchases are bounded the same way a
      // successful one's are cached rather than being re-bought once per wave.
      const failedArtifact = JSON.stringify(
        {
          windowId: origin,
          windowNumber: n,
          blockIds,
          parserVersion,
          promptVersion: PROMPT_VERSION_A,
          providerRouteIdentity,
          windowPolicyIdentity: windowPolicyIdentity(env),
          status: "failed",
          attempts: Math.max(attempts, issue),
          usages: [...priorUsages, ...purchasedUsages],
          fallbackTrigger,
          terminal: durableTerminal,
          failureStage: err instanceof ModelCallError ? "provider" : "semantic-output",
          detail,
          modelOutput: err instanceof ModelCallError ? null : rawModelOutput,
        },
        null,
        2,
      );
      try {
        await persistPrimaryWindowArtifact(
          env,
          runId,
          n,
          w,
          parserVersion,
          origin,
          predecessorAuthority,
          failedArtifact,
          (artifact) => artifact.kind === "failed",
        );
      } catch (persistenceError) {
        if (!(persistenceError instanceof PassAPrimaryPersistenceError)) throw persistenceError;
        const persistenceDetail = persistenceError.message.slice(0, 400);
        terminalFailure = true;
        failedUnits.push({ unit: origin, blockIds, detail: persistenceDetail });
        remaining += windows.length - i;
        if (onProgress) {
          try {
            await onProgress(
              `pass A ${origin}: FAILED — ${publicExtractionFailureDetail("pass-a-failed-artifact-persistence-failed")}`,
            );
          } catch {
            // The terminal no-rebuy outcome still carries the paid provider/semantic receipt.
          }
        }
        break;
      }
      failedUnits.push({ unit: origin, blockIds, detail });
      if (attempts < maxIssues && !nonRetryablePrimaryFailure) remaining += 1;
      else {
        landed += 1;
        terminalFailure = true;
      }
      if (onProgress) {
        try {
          await onProgress(
            `pass A ${origin}: FAILED (attempt ${attempts} of ${maxIssues}) — ${publicDetail}`,
          );
        } catch {
          // The terminal/failed artifact above is authoritative; heartbeat loss cannot retry it.
        }
      }
      remaining += windows.length - (i + 1);
      break;
    }
  }

  // CROSS-WINDOW SYNTHESIS IS A SEPARATE PURCHASE UNIT. It is reachable only after every
  // primary window landed successfully, and it may issue only when this wave bought ZERO
  // primary windows. That forces a later Workflow step after the final primary purchase;
  // otherwise one step could contain two over-budget calls while its timeout protects one.
  if (
    windows.length > 1 && remaining === 0 && !terminalFailure &&
    failedUnits.length === 0 && providerIndependence === "independent"
  ) {
    if (onUnitStart) {
      const nominated = new Set<string>();
      for (const row of requirements) {
        for (const evidence of row.evidenceQuotes ?? []) nominated.add(evidence.blockId);
      }
      for (const row of crossRefs) {
        for (const evidence of row.evidenceQuotes ?? []) nominated.add(evidence.blockId);
      }
      for (const row of [...ambiguities, ...unverifiable]) {
        for (const evidence of row.evidenceQuotes ?? []) nominated.add(evidence.blockId);
      }
      const synthesisBlockIds = doc.blocks
        .map((block) => block.blockId)
        .filter((blockId) => nominated.has(blockId));
      await onUnitStart({
        stage: "cross-window-synthesis",
        unit: {
          kind: "synthesis",
          name: "A-synthesis",
          ordinal: null,
          total: null,
          sourceContext: sourceContextForUnit(doc.blocks, synthesisBlockIds),
        },
        primary: {
          total: windows.length,
          landed: windows.length,
          remaining: 0,
          synthesisState: "pending",
        },
        secondary: null,
      });
    }
    // The synthesis primitive already makes progress best-effort after durable writes.
    // Do not forward an outer heartbeat callback whose throw could unwind the completed
    // Pass-A assembly after all paid artifacts landed.
    const synthesis = await runPassASynthesis(
      env, runId, doc, documentName, { issueAuthorized: issued === 0 },
    );
    synthesisState = synthesis.state;
    synthesisIssued = synthesis.issued;
    synthesisAttempts = synthesis.attempts;
    calls.push(...synthesis.calls);
    issuedCalls.push(...synthesis.issuedCalls);
    accountingCalls.push(...synthesis.accountingCalls);
    if (synthesis.routeReceipt !== null) routeReceipts.push(synthesis.routeReceipt);
    if (synthesis.fallbackTrigger !== null) fallbackTriggers.push(synthesis.fallbackTrigger);
    if (synthesis.terminalReasonCode !== undefined) {
      terminalReasonCode = synthesis.terminalReasonCode;
    }
    if (synthesis.credentialRefusal !== undefined) {
      credentialRefusal = synthesis.credentialRefusal;
    }
    if (synthesis.state === "reduced-provider-independence") {
      providerIndependence = "reduced-same-provider-fallback";
    }
    if (synthesis.state === "ok") {
      applySynthesisAdditions(
        requirements, crossRefs, ambiguities, unverifiable, synthesis.additions,
      );
      if (synthesis.limitation !== null) crossWindowLimitations.push(synthesis.limitation);
      if (onProgress) {
        try {
          await onProgress(
            `pass A synthesis: applied ${synthesis.limitation?.synthesisAdditions ?? 0} addition(s)`,
          );
        } catch {
          // Best effort only; synthesis and primary artifacts already landed.
        }
      }
    }
    if (synthesis.state === "failed") {
      terminalFailure = true;
      if (synthesis.failedUnit !== null) failedUnits.push(synthesis.failedUnit);
    }
  }

  const synthesisComplete =
    synthesisState === "not-required" || synthesisState === "ok" ||
    synthesisState === "failed" || synthesisState === "reduced-provider-independence";
  const slice: PassASlice = {
    done: remaining === 0 && synthesisComplete,
    windowsTotal: windows.length,
    windowsLanded: landed,
    windowsIssued: issued,
    windowsRemaining: remaining,
    terminalFailure,
    synthesisState,
    synthesisIssued,
    synthesisAttempts,
    deadlineHit,
  };

  return {
    pass: "A",
    provider: "grok-primary/gemini-substitute/deepseek-flash-fallback",
    model,
    providerRouteIdentity,
    providerIndependence,
    routeReceipts,
    fallbackTriggers,
    requirements,
    ambiguities,
    unverifiable,
    // Pass A does not disposition blocks: it reads for rules that span them. Claiming a
    // per-block verdict it never formed would be the source ledger's whole point inverted.
    dispositions: [],
    constructs: [],
    failedUnits,
    calls,
    crossRefs,
    crossWindowLimitations,
    primaryGroundingLimitations,
    slice,
    issuedCalls,
    accountingCalls,
    ...(terminalReasonCode ? { terminalReasonCode } : {}),
    ...(credentialRefusal ? { credentialRefusal } : {}),
  };
}

interface PersistedWindow {
  kind: "ok";
  globalRules: RawRequirement[];
  crossRefs: CrossRef[];
  ambiguities: PassResult["ambiguities"];
  unverifiable: PassResult["unverifiable"];
  primaryGroundingLimitations: PassAPrimaryGroundingLimitationWire[];
  usages: CallUsage[];
  routeReceipt: PassARouteReceipt;
}

interface FailedWindowArtifact {
  kind: "failed";
  attempts: number;
  detail: string;
  usages: CallUsage[];
  fallbackTrigger: GrokFallbackTrigger | null;
  /** Durable authority that this exact failure must not be purchased again after a crash. */
  terminal: boolean;
  /** Derived only from a strictly decoded zero-receipt wire-ceiling artifact/sidecar. */
  wireCeiling: boolean;
}

interface InvalidWindowArtifact {
  kind: "invalid";
  attempts: number;
  detail: string;
  /** Any strictly decodable receipts remain accounting authority even when content is corrupt. */
  usages: CallUsage[];
}

class PassAPrimaryGroundingError extends Error {
  constructor(
    readonly rowKind: PassAPrimaryGroundingRowKind,
    readonly reason: PassAPrimaryGroundingReason,
    readonly sourceBlockIds: string[],
    origin: string,
    rowIndex: number,
    detail: string,
  ) {
    super(
      `PASS_A_WINDOW_OUTPUT_UNGROUNDED: ${origin} ${rowKind} ${rowIndex + 1}: ${detail}`,
    );
    this.name = "PassAPrimaryGroundingError";
  }
}

/**
 * Bind every primary candidate to exact source inside the window that produced it.
 * A foreign id, empty/inexact quote, or quote that maps to several eligible blocks is a
 * failed model answer, never a candidate we quietly omit from reconciliation coverage.
 */
function groundPrimaryWindow(
  unit: PersistedWindow,
  source: SourceBlock[],
  origin: string,
): PersistedWindow {
  const byId = new Map(source.map((block) => [block.blockId, block]));
  const ownedIds = (ids: readonly string[]): string[] => {
    const seen = new Set<string>();
    return ids.filter((id) => byId.has(id) && !seen.has(id) && Boolean(seen.add(id)));
  };
  const fail = (
    kind: PassAPrimaryGroundingRowKind,
    index: number,
    reason: PassAPrimaryGroundingReason,
    claimedIds: readonly string[],
    detail: string,
  ): never => {
    throw new PassAPrimaryGroundingError(
      kind,
      reason,
      ownedIds(claimedIds),
      origin,
      index,
      detail,
    );
  };
  const exactOne = (
    quote: string,
    eligibleIds: string[],
    kind: PassAPrimaryGroundingRowKind,
    index: number,
  ): CrossWindowEvidenceQuote => {
    if (quote.length === 0) {
      fail(kind, index, "source-quote-not-exact", eligibleIds, "doc_quote is empty");
    }
    const ids = uniqueStrings(eligibleIds);
    if (ids.length === 0) {
      fail(kind, index, "source-block-ownership-invalid", eligibleIds, "no source block id is available");
    }
    const foreign = ids.filter((id) => !byId.has(id));
    if (foreign.length > 0) {
      fail(
        kind, index, "source-block-ownership-invalid", ids,
        `block id(s) are outside the owning window: ${foreign.join(", ")}`,
      );
    }
    const matches = ids.filter((id) => byId.get(id)!.text.includes(quote));
    if (matches.length !== 1) {
      fail(
        kind, index, "source-quote-not-exact", ids,
        `doc_quote matched ${matches.length} eligible source blocks; exact ownership requires one`,
      );
    }
    return { blockId: matches[0]!, quote };
  };
  const exactEvidenceSet = (
    docQuote: string,
    blockIds: string[],
    evidenceQuotes: CrossWindowEvidenceQuote[] | undefined,
    kind: PassAPrimaryGroundingRowKind,
    index: number,
  ): CrossWindowEvidenceQuote[] => {
    const ids = uniqueStrings(blockIds);
    if (ids.length === 0 || ids.length !== blockIds.length) {
      fail(kind, index, "source-evidence-set-invalid", blockIds, "block ids are empty or duplicated");
    }
    const evidence = evidenceQuotes ?? [];
    const evidenceIds = evidence.map((item) => item.blockId);
    if (
      evidence.length !== ids.length || new Set(evidenceIds).size !== evidenceIds.length ||
      ids.some((id) => !evidenceIds.includes(id)) || evidenceIds.some((id) => !ids.includes(id)) ||
      !evidence.some((item) => item.quote === docQuote)
    ) {
      fail(
        kind, index, "source-evidence-set-invalid", blockIds,
        "evidence quote ids must equal block ids and include doc_quote",
      );
    }
    for (const item of evidence) {
      const block = byId.get(item.blockId);
      if (!block) {
        fail(
          kind, index, "source-block-ownership-invalid", blockIds,
          `block id ${item.blockId} is outside the owning window`,
        );
      }
      if (item.quote.length === 0 || !block?.text.includes(item.quote)) {
        fail(
          kind, index, "source-quote-not-exact", blockIds,
          `quote is not exact source text in ${item.blockId}`,
        );
      }
    }
    return evidence;
  };
  const unresolvedUnprovenTarget = (
    row: CrossRef,
    evidenceQuotes: CrossWindowEvidenceQuote[],
  ): CrossRef => ({
    ...row,
    resolvedToBlock: null,
    targetDocQuote: null,
    statement: PASS_A_UNPROVEN_TARGET_STATEMENT,
    evidenceQuotes,
  });

  const globalRules = unit.globalRules.map((row, index) => {
    if (row.docQuote.length === 0) {
      fail("global-rule", index, "source-quote-not-exact", row.blockIds, "doc_quote is empty");
    }
    const evidenceQuotes = exactEvidenceSet(
      row.docQuote, row.blockIds, row.evidenceQuotes, "global-rule", index,
    );
    return { ...row, evidenceQuotes };
  });
  const crossRefs = unit.crossRefs.map((row, index) => {
    if (row.fromBlock === null) {
      fail("cross-reference", index, "source-block-ownership-invalid", [], "from_block is absent");
    }
    const fromBlock = row.fromBlock as string;
    const sourceEvidence = exactOne(
      row.docQuote ?? "",
      [fromBlock],
      "cross-reference",
      index,
    );
    const evidenceQuotes = [sourceEvidence];
    if (row.resolvedToBlock !== null) {
      const target = byId.get(row.resolvedToBlock);
      if (!target) {
        return unresolvedUnprovenTarget(row, evidenceQuotes);
      }
      const exactTarget = target as SourceBlock;
      const targetQuote = row.targetDocQuote ?? "";
      if (targetQuote.length === 0 || !exactTarget.text.includes(targetQuote)) {
        return unresolvedUnprovenTarget(row, evidenceQuotes);
      }
      evidenceQuotes.push({ blockId: exactTarget.blockId, quote: targetQuote });
    } else if (row.targetDocQuote !== null && row.targetDocQuote !== undefined) {
      fail(
        "cross-reference", index, "source-evidence-set-invalid", [fromBlock],
        "target_doc_quote must be null when resolved_to_block is null",
      );
    }
    return { ...row, evidenceQuotes };
  });
  const groundQuoted = <T extends RawAmbiguity | RawUnverifiable>(
    rows: T[],
    kind: "ambiguity" | "unverifiable",
  ): T[] => rows.map((row, index) => {
    const declared = row.blockIds ?? [];
    const evidenceQuotes = exactEvidenceSet(
      row.docQuote, declared, row.evidenceQuotes, kind, index,
    );
    return {
      ...row,
      blockIds: [...declared],
      evidenceQuotes,
    };
  });
  return {
    ...unit,
    globalRules,
    crossRefs,
    ambiguities: groundQuoted(unit.ambiguities, "ambiguity"),
    unverifiable: groundQuoted(unit.unverifiable, "unverifiable"),
  };
}

function strictPrimaryRows(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: ${key} must be an array of objects`);
  }
  return raw as Record<string, unknown>[];
}

function strictPrimaryKeys(raw: Record<string, unknown>, allowed: readonly string[], row: string): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(raw).filter((key) => !allow.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(raw, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `PASS_A_WINDOW_OUTPUT_INVALID: ${row} keys are not closed; missing=[${missing.join(",")}], ` +
        `unexpected=[${unexpected.join(",")}]`,
    );
  }
}

function strictPrimaryString(raw: Record<string, unknown>, key: string, row: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: ${row}.${key} must be a non-empty string`);
  }
  return value;
}

function strictPrimaryBlockIds(raw: Record<string, unknown>, row: string): string[] {
  const value = raw["block_ids"];
  if (!Array.isArray(value)) {
    throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: ${row}.block_ids must be an array`);
  }
  if (value.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    throw new Error(
      `PASS_A_WINDOW_OUTPUT_INVALID: ${row}.block_ids members must be non-empty strings`,
    );
  }
  // Empty and duplicate sets are structurally typed model answers. They fail exact source
  // grounding row-locally, where the candidate can be withheld and counted without turning
  // valid siblings or the unread document tail into a failed unit.
  return value as string[];
}

function strictPrimaryEvidence(
  raw: Record<string, unknown>,
  blockIds: string[],
  docQuote: string,
  row: string,
): CrossWindowEvidenceQuote[] {
  const rows = raw["evidence_quotes"];
  if (!Array.isArray(rows)) {
    throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: ${row}.evidence_quotes must be an array`);
  }
  const evidence = rows.map((value): CrossWindowEvidenceQuote => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: ${row}.evidence_quotes members must be objects`);
    }
    const item = value as Record<string, unknown>;
    strictPrimaryKeys(item, ["block_id", "quote"], `${row}.evidence_quote`);
    return {
      blockId: strictPrimaryString(item, "block_id", `${row}.evidence_quote`),
      quote: strictPrimaryString(item, "quote", `${row}.evidence_quote`),
    };
  });
  // Membership/cardinality/doc-quote linkage is source grounding, not JSON shape. The
  // row-local grounder can safely withhold and count that one candidate while preserving
  // structurally valid siblings. Non-array/member/key/type failures above remain terminal.
  void blockIds;
  void docQuote;
  return evidence;
}

function strictPrimaryOutput(
  value: Record<string, unknown>,
  origin: string,
): Omit<PersistedWindow, "kind" | "usages" | "routeReceipt" | "primaryGroundingLimitations"> {
  strictPrimaryKeys(
    value,
    ["global_rules", "cross_references", "ambiguities", "unverifiable_from_browser"],
    "root",
  );
  const globalRows = strictPrimaryRows(value, "global_rules");
  const xrefRows = strictPrimaryRows(value, "cross_references");
  const ambiguityRows = strictPrimaryRows(value, "ambiguities");
  const unverifiableRows = strictPrimaryRows(value, "unverifiable_from_browser");

  const globalRules = globalRows.map((raw) => {
    strictPrimaryKeys(raw, [
      "id", "construct", "scope", "quantifier", "selector", "exceptions", "statement",
      "doc_quote", "block_ids", "evidence_quotes", "browser_observable", "confidence",
    ], "global rule");
    strictPrimaryString(raw, "id", "global rule");
    const construct = strictPrimaryString(raw, "construct", "global rule");
    const scope = strictPrimaryString(raw, "scope", "global rule");
    const quantifier = strictPrimaryString(raw, "quantifier", "global rule");
    const observable = strictPrimaryString(raw, "browser_observable", "global rule");
    const statement = strictPrimaryString(raw, "statement", "global rule");
    const docQuote = strictPrimaryString(raw, "doc_quote", "global rule");
    if (!new Set<string>(CONSTRUCT_CLASSES).has(construct)) {
      throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: unknown construct ${JSON.stringify(construct)}`);
    }
    if (scope !== "survey" && !/^section:.+/.test(scope)) {
      throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: invalid scope ${JSON.stringify(scope)}`);
    }
    if (!SYNTHESIS_QUANTIFIERS.has(quantifier)) {
      throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: invalid quantifier ${JSON.stringify(quantifier)}`);
    }
    if (!SYNTHESIS_OBSERVABILITY.has(observable)) {
      throw new Error(`PASS_A_WINDOW_OUTPUT_INVALID: invalid browser_observable ${JSON.stringify(observable)}`);
    }
    const blockIds = strictPrimaryBlockIds(raw, "global rule");
    if (
      !Array.isArray(raw["exceptions"]) ||
      raw["exceptions"].some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error("PASS_A_WINDOW_OUTPUT_INVALID: exceptions must contain only non-empty strings");
    }
    if (
      raw["selector"] !== null &&
      (typeof raw["selector"] !== "string" || raw["selector"].trim().length === 0)
    ) throw new Error("PASS_A_WINDOW_OUTPUT_INVALID: selector must be a non-empty string or null");
    if (
      typeof raw["confidence"] !== "number" || !Number.isFinite(raw["confidence"]) ||
      raw["confidence"] < 0 || raw["confidence"] > 1
    ) throw new Error("PASS_A_WINDOW_OUTPUT_INVALID: confidence must be within 0..1");
    const coerced = coerceRequirement(raw, "A", origin, "survey");
    const row: RawRequirement = coerced ?? {
      id: strictPrimaryString(raw, "id", "global rule"),
      construct,
      scope,
      quantifier,
      selector: raw["selector"] as string | null,
      exceptions: raw["exceptions"] as string[],
      statement,
      docQuote,
      blockIds,
      browserObservable: observable as RawRequirement["browserObservable"],
      confidence: raw["confidence"] as number,
      expansion: null,
      pass: "A",
      origin,
    };
    return {
      ...row,
      blockIds,
      evidenceQuotes: strictPrimaryEvidence(
        raw, blockIds, docQuote, "global rule",
      ),
    };
  });

  const crossRefs = xrefRows.map((raw, index): CrossRef => {
    strictPrimaryKeys(raw, [
      "id", "from_block", "target", "resolved_to_block", "target_doc_quote", "statement", "doc_quote",
    ], "cross-reference");
    const resolvedToBlock = raw["resolved_to_block"] === null ? null :
      strictPrimaryString(raw, "resolved_to_block", "cross-reference");
    const targetDocQuote = raw["target_doc_quote"] === null ? null :
      strictPrimaryString(raw, "target_doc_quote", "cross-reference");
    return {
      id: strictPrimaryString(raw, "id", "cross-reference"),
      sourceXrefHandle: `${origin}:x:${String(index + 1).padStart(3, "0")}`,
      fromBlock: strictPrimaryString(raw, "from_block", "cross-reference"),
      target: strictPrimaryString(raw, "target", "cross-reference"),
      resolvedToBlock,
      targetDocQuote,
      statement: strictPrimaryString(raw, "statement", "cross-reference"),
      docQuote: strictPrimaryString(raw, "doc_quote", "cross-reference"),
    };
  });

  const ambiguities = ambiguityRows.map((raw, index): RawAmbiguity => {
    strictPrimaryKeys(raw, [
      "id", "block_ids", "doc_quote", "evidence_quotes", "reading_a", "reading_b", "why_ambiguous", "affects",
    ], "ambiguity");
    const readingA = strictPrimaryString(raw, "reading_a", "ambiguity");
    const readingB = strictPrimaryString(raw, "reading_b", "ambiguity");
    if (readingA.trim() === readingB.trim()) {
      throw new Error("PASS_A_WINDOW_OUTPUT_INVALID: ambiguity readings must be distinct");
    }
    if (
      !Array.isArray(raw["affects"]) ||
      raw["affects"].some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error("PASS_A_WINDOW_OUTPUT_INVALID: ambiguity.affects must contain only non-empty strings");
    }
    const blockIds = strictPrimaryBlockIds(raw, "ambiguity");
    const docQuote = strictPrimaryString(raw, "doc_quote", "ambiguity");
    return {
      id: strictPrimaryString(raw, "id", "ambiguity"),
      docQuote,
      readingA, readingB,
      whyAmbiguous: strictPrimaryString(raw, "why_ambiguous", "ambiguity"),
      affects: raw["affects"] as string[], pass: "A", blockIds,
      evidenceQuotes: strictPrimaryEvidence(raw, blockIds, docQuote, "ambiguity"),
    };
  });

  const unverifiable = unverifiableRows.map((raw): RawUnverifiable => {
    strictPrimaryKeys(raw, [
      "id", "block_ids", "doc_quote", "evidence_quotes", "mandate", "why_not_observable", "browser_proxy_evidence",
    ], "unverifiable");
    const blockIds = strictPrimaryBlockIds(raw, "unverifiable");
    const docQuote = strictPrimaryString(raw, "doc_quote", "unverifiable");
    return {
      id: strictPrimaryString(raw, "id", "unverifiable"),
      docQuote,
      mandate: strictPrimaryString(raw, "mandate", "unverifiable"),
      whyNotObservable: strictPrimaryString(raw, "why_not_observable", "unverifiable"),
      browserProxyEvidence: strictPrimaryString(raw, "browser_proxy_evidence", "unverifiable"),
      pass: "A",
      blockIds,
      evidenceQuotes: strictPrimaryEvidence(raw, blockIds, docQuote, "unverifiable"),
    };
  });
  return { globalRules, crossRefs, ambiguities, unverifiable };
}

function inspectPrimaryWindowGrounding(
  unit: PersistedWindow,
  source: SourceBlock[],
  origin: string,
): { unit: PersistedWindow; limitations: PassAPrimaryGroundingLimitationWire[] } {
  const limitations: PassAPrimaryGroundingLimitationWire[] = [];
  const ownedIds = new Set(source.map((block) => block.blockId));
  const empty = (): PersistedWindow => ({
    ...unit,
    globalRules: [],
    crossRefs: [],
    ambiguities: [],
    unverifiable: [],
    primaryGroundingLimitations: [],
  });
  type GroundedRow<T> = { row: T; sourceIndex: number };
  const collect = <T>(
    rowKind: PassAPrimaryGroundingRowKind,
    rows: T[],
    project: (single: PersistedWindow) => T[],
    place: (single: PersistedWindow, row: T) => void,
  ): GroundedRow<T>[] => rows.flatMap((row, index) => {
    const single = empty();
    place(single, row);
    try {
      return project(groundPrimaryWindow(single, source, origin)).map((grounded) => ({
        row: grounded,
        sourceIndex: index,
      }));
    } catch (error) {
      if (!(error instanceof PassAPrimaryGroundingError)) throw error;
      limitations.push({
        kind: PASS_A_PRIMARY_GROUNDING_LIMITATION_KIND,
        unit: origin,
        rowKind,
        rowIndex: index + 1,
        sourceBlockIds: [...error.sourceBlockIds],
        reason: error.reason,
      });
      return [];
    }
  });
  const groundedGlobalRules = collect(
    "global-rule", unit.globalRules, (single) => single.globalRules,
    (single, row) => { single.globalRules = [row]; },
  );
  const groundedCrossRefs = collect(
    "cross-reference", unit.crossRefs, (single) => single.crossRefs,
    (single, row) => { single.crossRefs = [row]; },
  );
  const groundedAmbiguities = collect(
    "ambiguity", unit.ambiguities, (single) => single.ambiguities,
    (single, row) => { single.ambiguities = [row]; },
  );
  const groundedUnverifiable = collect(
    "unverifiable", unit.unverifiable, (single) => single.unverifiable,
    (single, row) => { single.unverifiable = [row]; },
  );
  const globalRules = groundedGlobalRules.flatMap(({ row, sourceIndex }) => {
    if (row.browserObservable !== "none") return [row];
    const linked = groundedUnverifiable.some(({ row: unv }) =>
      unv.docQuote === row.docQuote && (unv.blockIds ?? []).some((id) => row.blockIds.includes(id))
    );
    if (linked) return [row];
    limitations.push({
      kind: PASS_A_PRIMARY_GROUNDING_LIMITATION_KIND,
      unit: origin,
      rowKind: "global-rule",
      rowIndex: sourceIndex + 1,
      sourceBlockIds: row.blockIds.filter((id, index, ids) =>
        ownedIds.has(id) && ids.indexOf(id) === index
      ),
      reason: "grounded-row-linkage-incomplete",
    });
    return [];
  });
  const rowKindOrder = new Map<PassAPrimaryGroundingRowKind, number>([
    ["global-rule", 0], ["cross-reference", 1], ["ambiguity", 2], ["unverifiable", 3],
  ]);
  limitations.sort((left, right) =>
    (rowKindOrder.get(left.rowKind)! - rowKindOrder.get(right.rowKind)!) ||
    left.rowIndex - right.rowIndex
  );
  const validatedLimitations = validatePassAPrimaryGroundingLimitations(limitations);
  return {
    unit: {
      ...unit,
      globalRules,
      crossRefs: groundedCrossRefs.map(({ row }) => row),
      ambiguities: groundedAmbiguities.map(({ row }) => row),
      unverifiable: groundedUnverifiable.map(({ row }) => row),
      primaryGroundingLimitations: validatedLimitations,
    },
    limitations: validatedLimitations,
  };
}

function applySynthesisAdditions(
  requirements: RawRequirement[],
  crossRefs: CrossRef[],
  ambiguities: RawAmbiguity[],
  unverifiable: RawUnverifiable[],
  additions: PassASynthesisAdditions,
): void {
  requirements.push(...additions.globalRules);
  for (const resolution of additions.crossRefs) {
    const handle = resolution.sourceXrefHandle;
    const matches = crossRefs
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.sourceXrefHandle === handle);
    if (handle === undefined || matches.length !== 1) {
      throw new Error(
        `PASS_A_SYNTHESIS_RESOLUTION_APPLY_INVALID: expected one primary cross-reference for ` +
          `${JSON.stringify(handle)}, found ${matches.length}`,
      );
    }
    const original = matches[0]!.row;
    crossRefs[matches[0]!.index] = {
      ...original,
      ...resolution,
      id: original.id,
      sourceXrefId: original.id,
      sourceXrefHandle: handle,
    };
  }
  ambiguities.push(...additions.ambiguities);
  unverifiable.push(...additions.unverifiable);
}

/**
 * What is on disk for this window: a usable answer, a recorded failure with its attempt
 * count, or nothing at all. The three are DIFFERENT — collapsing "failed" into "nothing"
 * is what lets a failing unit be re-bought once per attempt, per wave, per recovery
 * instance, forever.
 *
 * A block-set mismatch reads as NOTHING, deliberately: EXTRACT_PASS_A_WINDOW_CHARS changed
 * under this run, so the artifact answers a question nobody is asking any more.
 */
async function readWindow(
  env: Env,
  runId: string,
  n: number,
  expectedBlocks: SourceBlock[],
  parserVersion: string,
  origin: string,
): Promise<PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null> {
  const sidecar = await readWindowArtifact(
    env, runId, n, expectedBlocks, parserVersion, origin, windowWireCeilingKey(runId, n),
  );
  const main = await readWindowArtifact(
    env, runId, n, expectedBlocks, parserVersion, origin, windowKey(runId, n),
  );
  if (sidecar === null) return main;
  const sidecarInvalid = (detail: string): InvalidWindowArtifact => ({
    kind: "invalid",
    attempts: main?.kind === "failed" || main?.kind === "invalid" ? main.attempts : 0,
    usages: main?.usages ?? sidecar.usages,
    detail: `PASS_A_WINDOW_WIRE_CEILING_SIDECAR_INVALID: ${origin}: ${detail}. ` +
      `Neither retained artifact was overwritten or re-bought.`,
  });
  if (sidecar.kind !== "failed" || !sidecar.wireCeiling) {
    return sidecarInvalid(
      sidecar.kind === "ok" ? "sidecar contains a successful artifact" : sidecar.detail,
    );
  }
  // A sidecar is written only when a valid, paid, retryable main artifact already owns the
  // exact key. Fresh zero-receipt refusals live at the main key. Anything else is a retained
  // conflict, not permission to relabel successful/corrupt/terminal authority as wire-safe.
  if (
    main?.kind !== "failed" || main.wireCeiling || main.attempts < 1 || main.terminal
  ) {
    return sidecarInvalid("wire-ceiling sidecar has no valid retryable paid main artifact");
  }
  return {
    kind: "failed",
    attempts: main.attempts,
    usages: main.usages,
    fallbackTrigger: main.fallbackTrigger,
    terminal: true,
    wireCeiling: true,
    detail: sidecar.detail,
  };
}

async function readWindowArtifact(
  env: Env,
  runId: string,
  n: number,
  expectedBlocks: SourceBlock[],
  parserVersion: string,
  origin: string,
  artifactKey: string,
): Promise<PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null> {
  const obj = await env.EVIDENCE.get(artifactKey);
  if (!obj) return null;
  const expectedBlockIds = expectedBlocks.map((block) => block.blockId);
  const invalid = (detail: string, parsed?: Record<string, unknown>): InvalidWindowArtifact => {
    const usages = Array.isArray(parsed?.['usages'])
      ? parsed!['usages'].filter((usage): usage is CallUsage =>
          isCallUsage(usage) && passAUsagePosition(usage, runId, origin) !== null)
      : [];
    const declared = parsed?.['attempts'];
    const attempts = Number.isSafeInteger(declared) && (declared as number) >= 0
      ? declared as number
      : usages.reduce((highest, usage) =>
          Math.max(highest, passAUsagePosition(usage, runId, origin)?.issue ?? 0), 0);
    return {
      kind: 'invalid', attempts, usages,
      detail: `PASS_A_WINDOW_ARTIFACT_INVALID: ${origin}: ${detail}. ` +
        'The current-identity paid artifact is terminal authority and will not be overwritten or re-bought.',
    };
  };
  let artifactBodyText: string;
  try {
    artifactBodyText = await obj.text();
  } catch {
    return invalid('artifact bytes are unreadable');
  }
  const storageAuthority = { etag: obj.etag, bodyText: artifactBodyText };
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(artifactBodyText) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return invalid('artifact root is not an object');
    }
    parsed = decoded as Record<string, unknown>;
  } catch {
    return invalid('artifact JSON is unreadable');
  }
  try {
    // A valid artifact from an old parser/prompt/route is a cache miss. Once those current
    // identities match, corruption is retained authority: absence and invalidity diverge.
    if (parsed["parserVersion"] !== parserVersion || parsed["promptVersion"] !== PROMPT_VERSION_A) return null;
    if (parsed["providerRouteIdentity"] !== grokFlashRouteIdentity(env)) return null;
    if (parsed["windowPolicyIdentity"] !== windowPolicyIdentity(env)) return null;
    if (parsed["windowId"] !== origin || parsed["windowNumber"] !== n) {
      return invalid("windowId/windowNumber do not match this exact window key", parsed);
    }
    const blockIds = Array.isArray(parsed["blockIds"]) ? (parsed["blockIds"] as string[]) : [];
    if (
      blockIds.length !== expectedBlockIds.length ||
      blockIds.some((id, index) => id !== expectedBlockIds[index])
    ) return invalid('ordered source-block ownership does not match the current window', parsed);
    const attempts = parsed["attempts"];
    const usages = Array.isArray(parsed["usages"]) ? parsed["usages"] : null;
    if (
      !Number.isSafeInteger(attempts) || (attempts as number) < 0 ||
      usages === null || !usages.every(isCallUsage)
    ) return invalid('attempts/usages are malformed', parsed);
    const zeroReceiptWireFailure =
      parsed["status"] === "failed" && parsed["failureStage"] === "wire-ceiling" &&
      attempts === 0 && usages.length === 0;
    const coherence = zeroReceiptWireFailure
      ? null
      : validatePassAUnitUsageCoherence(usages as CallUsage[], runId, origin, attempts as number);
    if (coherence !== null) return invalid(coherence, parsed);
    if (parsed["status"] === "failed") {
      if (typeof parsed["detail"] !== 'string' || parsed["detail"].length === 0) {
        return invalid('failed artifact has no detail', parsed);
      }
      const fallbackTrigger = parsed["fallbackTrigger"] === null
        ? null
        : parseFallbackTrigger(parsed["fallbackTrigger"], usages as CallUsage[]);
      if (
        parsed["fallbackTrigger"] !== null &&
        (fallbackTrigger === null ||
          passAUsagePosition(
            (usages as CallUsage[]).find((usage) => usage.eventId === fallbackTrigger.grokUsageEventId)!,
            runId, origin,
          ) === null)
      ) return invalid('fallback trigger is malformed or bound outside this window', parsed);
      if (typeof parsed["terminal"] !== "boolean") return invalid('terminal flag is malformed', parsed);
      const failureStage = parsed["failureStage"];
      if (
        failureStage !== 'fallback-authorized' &&
        failureStage !== 'provider' && failureStage !== 'semantic-output' &&
        failureStage !== 'wire-ceiling'
      ) return invalid('failureStage is missing or invalid', parsed);
      const fallbackChainFailure = fallbackTrigger === null ? null : validatePassAFallbackUsageChain(
        usages as CallUsage[], runId, origin, attempts as number, fallbackTrigger,
        failureStage === 'fallback-authorized' ? 'pending' :
          failureStage === 'semantic-output' ? 'semantic-failed' : 'provider-failed',
      );
      if (
        parsed["routeReceipt"] !== undefined || parsed["globalRules"] !== undefined ||
        parsed["crossRefs"] !== undefined || parsed["ambiguities"] !== undefined ||
        parsed["unverifiable"] !== undefined || parsed["primaryGroundingLimitations"] !== undefined ||
        (failureStage === 'wire-ceiling' &&
          ((attempts as number) !== 0 || usages.length !== 0 || fallbackTrigger !== null ||
            parsed["terminal"] !== true ||
            Object.hasOwn(parsed, "modelOutput") ||
            !(parsed["detail"] as string).startsWith(
              `${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}:`,
            ))) ||
        (failureStage !== 'wire-ceiling' && (attempts as number) === 0) ||
        (failureStage === 'provider' && fallbackTrigger === null && parsed["terminal"] !== true) ||
        (fallbackTrigger === null && (usages as CallUsage[]).some((usage) => usage.provider === 'deepseek')) ||
        (usages as CallUsage[]).some((usage) => usage.status === 'ok') ||
        (failureStage === 'semantic-output' &&
          (parsed["terminal"] !== true || !(usages as CallUsage[]).some((usage) => usage.status === 'parse-failed'))) ||
        (failureStage === 'fallback-authorized' &&
          (parsed["terminal"] !== false || fallbackTrigger === null ||
            (usages as CallUsage[]).some((usage) => usage.provider === 'deepseek'))) ||
        fallbackChainFailure !== null
      ) return invalid('failed artifact retains successful-shape fields or an unauthorized provider receipt', parsed);
      const failedModelOutput = parsed["modelOutput"];
      if (failureStage === "semantic-output") {
        if (
          typeof failedModelOutput !== "object" || failedModelOutput === null ||
          Array.isArray(failedModelOutput)
        ) return invalid("semantic-output failure has no retained raw modelOutput", parsed);
        try {
          strictPrimaryOutput(failedModelOutput as Record<string, unknown>, origin);
          return invalid("semantic-output failure does not reproduce under the current strict decoder", parsed);
        } catch {
          // Exact raw parsed output remains private evidence only. Reproducing the strict
          // failure proves the failed envelope; it grants no typed or coverage authority.
        }
      } else if (failedModelOutput !== undefined && failedModelOutput !== null) {
        return invalid("provider/fallback failure carries model output it could not have produced", parsed);
      }
      return rememberPassAWindowStorageAuthority<FailedWindowArtifact>({
        kind: "failed", attempts: attempts as number, detail: parsed["detail"], usages: usages as CallUsage[],
        fallbackTrigger, terminal: parsed["terminal"], wireCeiling: failureStage === "wire-ceiling",
      }, storageAuthority);
    }
    if (
      parsed["kind"] !== 'ok' || parsed["status"] !== undefined ||
      parsed["detail"] !== undefined || parsed["failureStage"] !== undefined ||
      parsed["terminal"] !== undefined || parsed["fallbackTrigger"] !== undefined
    ) return invalid('successful artifact discriminator/shape is not closed', parsed);
    if (
      !Array.isArray(parsed["globalRules"]) || !Array.isArray(parsed["crossRefs"]) ||
      !Array.isArray(parsed["ambiguities"]) || !Array.isArray(parsed["unverifiable"])
    ) return invalid('successful typed output arrays are missing', parsed);
    const routeReceipt = validatePassARouteReceiptForUnit(
      parsed["routeReceipt"], usages as CallUsage[], runId, origin,
    );
    if (routeReceipt === null) return invalid('successful route receipt is not bound to this window', parsed);
    const modelOutput = parsed["modelOutput"];
    if (typeof modelOutput !== 'object' || modelOutput === null || Array.isArray(modelOutput)) {
      return invalid('successful artifact has no raw modelOutput authority', parsed);
    }
    const strict = strictPrimaryOutput(modelOutput as Record<string, unknown>, origin);
    const decoded = inspectPrimaryWindowGrounding({
      kind: "ok",
      ...strict,
      primaryGroundingLimitations: [],
      usages: usages as CallUsage[],
      routeReceipt,
    }, expectedBlocks, origin).unit;
    const storedLimitations = validatePassAPrimaryGroundingLimitations(
      parsed["primaryGroundingLimitations"],
    );
    const typedStored = {
      globalRules: parsed["globalRules"], crossRefs: parsed["crossRefs"],
      ambiguities: parsed["ambiguities"], unverifiable: parsed["unverifiable"],
      primaryGroundingLimitations: storedLimitations,
    };
    const typedDecoded = {
      globalRules: decoded.globalRules, crossRefs: decoded.crossRefs,
      ambiguities: decoded.ambiguities, unverifiable: decoded.unverifiable,
      primaryGroundingLimitations: decoded.primaryGroundingLimitations,
    };
    if (canonicalJson(typedStored) !== canonicalJson(typedDecoded)) {
      return invalid('typed projection differs from strict re-decoding of raw modelOutput', parsed);
    }
    return rememberPassAWindowStorageAuthority(decoded, storageAuthority);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'typed output validation failed', parsed);
  }
}

type CompactEvidenceRow = [evidenceId: string, blockId: string, exactQuote: string];
type CompactRuleRow = [
  handle: string, construct: string, scope: string, quantifier: string,
  selector: string | null, exceptions: string[], statement: string,
  evidenceIds: string[], originalBlockIds: string[],
  browserObservable: RawRequirement["browserObservable"], expansion: RawRequirement["expansion"],
];
type CompactXrefRow = [
  handle: string, fromBlock: string | null, target: string,
  resolvedToBlock: string | null, statement: string, evidenceIds: string[],
];
type CompactAmbiguityRow = [
  handle: string, evidenceIds: string[], readingA: string, readingB: string,
  whyAmbiguous: string, affects: string[],
];
type CompactUnverifiableRow = [
  handle: string, evidenceIds: string[], mandate: string,
  whyNotObservable: string, browserProxyEvidence: string,
];
type CompactWindowRow = [
  windowId: string,
  rules: CompactRuleRow[],
  crossRefs: CompactXrefRow[],
  ambiguities: CompactAmbiguityRow[],
  unverifiable: CompactUnverifiableRow[],
];

/** Lossless positional wire projection; the prompt defines every slot. */
interface PassASynthesisInput {
  v: 1;
  c: [
    windowsTotal: number,
    candidateRowsTotal: number,
    sourceBlocksTotal: number,
    evidenceSpanCount: number,
  ];
  w: CompactWindowRow[];
  e: CompactEvidenceRow[];
}

interface PassASynthesisContext {
  parserVersion: string;
  inputJson: string;
  inputHash: string;
  /** Candidate catalogue alone, useful for diagnostics but never the purchase ceiling. */
  catalogueBytes: number;
  /** Larger of the exact Grok and Flash serialized request bodies. */
  wireBytes: number;
  grokWireBytes: number;
  flashWireBytes: number;
  /** Closed refusal detail, null only when both exact provider bodies fit. */
  wireFailureDetail: string | null;
  /** Every source block whose exact span is owned by this synthesis unit. */
  sourceBlockIds: string[];
  requestHash: string;
  policyIdentity: string;
  maxBytes: number;
  maxIssues: number;
  optionsForCall: {
    system: string;
    user: string;
    maxTokens: number;
    role: string;
    callId: string;
    maxAttempts: number;
  };
  coverage: PassASynthesisCoverage;
  blocks: Map<string, SourceBlock>;
  windowByBlock: Map<string, number>;
  evidenceBlockIds: Set<string>;
  /** Exact source spans actually supplied on the compact wire, keyed blockId + NUL + quote. */
  evidenceSpanKeys: Set<string>;
  primaryCrossRefs: Array<{ handle: string; windowNumber: number; row: CrossRef }>;
}

export interface PassASynthesisContextView {
  parserVersion: string;
  inputJson: string;
  inputHash: string;
  requestHash: string;
  policyIdentity: string;
  /** Exact maximum provider request size; this is what the configured ceiling gates. */
  inputBytes: number;
  catalogueBytes: number;
  grokWireBytes: number;
  flashWireBytes: number;
  coverage: PassASynthesisCoverage;
}

type PersistedPassASynthesis =
  | {
      kind: "ok";
      attempts: number;
      usages: CallUsage[];
      routeReceipt: PassARouteReceipt;
      additions: PassASynthesisAdditions;
    }
  | {
      kind: "failed";
      attempts: number;
      usages: CallUsage[];
      fallbackTrigger: GrokFallbackTrigger | null;
      terminal: boolean;
      wireCeiling: boolean;
      detail: string;
    }
  | {
      /** Exact-key artifact exists, but its retained authority is not safely decodable. */
      kind: 'invalid';
      attempts: number;
      usages: CallUsage[];
      detail: string;
    };

interface PassASynthesisStorageAuthority {
  /** R2 version strictly decoded before the next paid synthesis transition. */
  etag: string;
  /** Exact canonical bytes; semantic equality is never enough to authorize replacement. */
  bodyText: string;
}

const passASynthesisStorageAuthority =
  new WeakMap<object, PassASynthesisStorageAuthority>();

function rememberPassASynthesisStorageAuthority<T extends object>(
  value: T,
  authority: PassASynthesisStorageAuthority,
): T {
  passASynthesisStorageAuthority.set(value, authority);
  return value;
}

function synthesisStorageAuthorityOf(
  value: PersistedPassASynthesis | null,
): PassASynthesisStorageAuthority | null {
  return value === null ? null : passASynthesisStorageAuthority.get(value) ?? null;
}

const PASS_A_SYNTHESIS_ARTIFACT_PERSIST_ATTEMPTS = 2;

class PassASynthesisPersistenceError extends Error {
  constructor(writeError: unknown, retainedState: string) {
    const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
    super(
      `PASS_A_SYNTHESIS_PERSISTENCE_FAILED: ${writeDetail}; synthesis artifact reread ${retainedState}`,
    );
    this.name = "PassASynthesisPersistenceError";
  }
}

const emptySynthesisAdditions = (): PassASynthesisAdditions => ({
  globalRules: [],
  crossRefs: [],
  ambiguities: [],
  unverifiable: [],
});

function synthesisOutcome(
  state: PassASynthesisOutcome["state"],
  patch: Partial<Omit<PassASynthesisOutcome, "state">> = {},
): PassASynthesisOutcome {
  return {
    state,
    required: state !== "not-required",
    issued: 0,
    attempts: 0,
    inputHash: null,
    coverage: null,
    additions: emptySynthesisAdditions(),
    calls: [],
    issuedCalls: [],
    accountingCalls: [],
    routeReceipt: null,
    fallbackTrigger: null,
    failedUnit: null,
    limitation: null,
    ...patch,
  };
}

/** Read-only builder used by focused tests; no model purchase or artifact mutation. */
export async function preparePassASynthesis(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName = "document.docx",
): Promise<PassASynthesisContextView | null> {
  const context = await buildPassASynthesisContext(env, runId, doc, documentName);
  return context === null
    ? null
    : {
        inputJson: context.inputJson,
        inputHash: context.inputHash,
        parserVersion: context.parserVersion,
        requestHash: context.requestHash,
        policyIdentity: context.policyIdentity,
        inputBytes: context.wireBytes,
        catalogueBytes: context.catalogueBytes,
        grokWireBytes: context.grokWireBytes,
        flashWireBytes: context.flashWireBytes,
        coverage: context.coverage,
      };
}

function synthesisArtifactEnvelope(
  env: Env,
  context: PassASynthesisContext,
): {
  schemaVersion: typeof PASS_A_SYNTHESIS_VERSION;
  parserVersion: string;
  promptVersion: typeof PROMPT_VERSION_A;
  providerRouteIdentity: string;
  inputHash: string;
  requestHash: string;
  policyIdentity: string;
  coverage: PassASynthesisCoverage;
  blockIds: string[];
} {
  return {
    schemaVersion: PASS_A_SYNTHESIS_VERSION,
    parserVersion: context.parserVersion,
    promptVersion: PROMPT_VERSION_A,
    providerRouteIdentity: grokFlashRouteIdentity(env),
    inputHash: context.inputHash,
    requestHash: context.requestHash,
    policyIdentity: context.policyIdentity,
    coverage: context.coverage,
    blockIds: context.sourceBlockIds,
  };
}

function synthesisUsageIssue(
  usage: CallUsage,
  runId: string,
): { issue: number; receipt: number } | null {
  const position = passAUsagePosition(usage, runId, 'A-synthesis');
  return position === null ? null : { issue: position.issue, receipt: position.receipt };
}

function passAUsagePosition(
  usage: CallUsage,
  runId: string,
  expectedUnit?: string,
): { unit: string; issue: number; receipt: number } | null {
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = usage.eventId?.match(new RegExp(
    `^core-model-call/pass-a/${escapedRunId}/(A(?:-w\\d+|-synthesis)?)/issue-(\\d+)/receipt-([123])$`,
  ));
  if (!match) return null;
  const unit = match[1]!;
  const issue = Number(match[2]);
  const receipt = Number(match[3]);
  if (expectedUnit !== undefined && unit !== expectedUnit) return null;
  return Number.isSafeInteger(issue) && issue >= 1 ? { unit, issue, receipt } : null;
}

function validatePassAUnitUsageCoherence(
  usages: CallUsage[],
  runId: string,
  unit: string,
  attempts: number,
): string | null {
  if (attempts < 1 || usages.length === 0) return 'paid unit has no attempt/receipt';
  const positions = usages.map((usage) => passAUsagePosition(usage, runId, unit));
  if (positions.some((position) => position === null)) {
    return 'a receipt has the wrong run/window/issue settlement identity';
  }
  const keys = positions.map((position) => `${position!.issue}:${position!.receipt}`);
  if (new Set(keys).size !== keys.length) return 'receipt settlement identities are duplicated';
  if (Math.max(...positions.map((position) => position!.issue)) !== attempts) {
    return 'attempt count does not equal the highest retained receipt issue';
  }
  for (let issue = 1; issue <= attempts; issue += 1) {
    if (!positions.some((position) => position!.issue === issue)) return `receipt issue ${issue} is missing`;
  }
  const windowNumber = unit === 'A' ? 1 : Number(unit.match(/^A-w(\d+)$/)?.[1]);
  const expectedRole = unit === 'A' ? 'extract-pass-a' :
    unit === 'A-synthesis' ? 'extract-pass-a-synthesis' : `extract-pass-a-w${windowNumber}`;
  const expectedCallId = unit === 'A-synthesis' ? 'call_a_synthesis' : `call_a_${windowNumber}`;
  for (let index = 0; index < usages.length; index += 1) {
    const usage = usages[index]!;
    const position = positions[index]!;
    const isGeminiSubstitute =
      position.receipt === 2 &&
      usage.provider === 'gemini' &&
      usage.model === 'gemini-2.5-flash' &&
      usage.callId === `${expectedCallId}:grok-gemini-substitute`;
    const isFlashFallback =
      position.receipt === 2 &&
      usage.provider === 'deepseek' &&
      usage.model === 'deepseek-v4-flash' &&
      usage.callId === `${expectedCallId}:grok-fallback`;
    const isFlashAfterGemini =
      position.receipt === 3 &&
      usage.provider === 'deepseek' &&
      usage.model === 'deepseek-v4-flash' &&
      usage.callId === `${expectedCallId}:grok-fallback`;
    if (
      usage.role !== expectedRole ||
      (position.receipt === 1 && usage.callId !== expectedCallId) ||
      (position.receipt === 1 && (usage.provider !== 'grok' || usage.model !== DEFAULT_GROK_MODEL)) ||
      (position.receipt === 2 && !isGeminiSubstitute && !isFlashFallback) ||
      (position.receipt === 3 && !isFlashAfterGemini)
    ) return 'receipt role/call/provider is inconsistent with its settlement identity';
  }
  return null;
}

function validateSynthesisUsageCoherence(
  usages: CallUsage[],
  runId: string,
  attempts: number,
): string | null {
  if (attempts === 0) return usages.length === 0 ? null : 'zero attempts retained paid receipts';
  return validatePassAUnitUsageCoherence(usages, runId, 'A-synthesis', attempts);
}

function invalidSynthesisArtifact(
  runId: string,
  detail: string,
  parsed?: Record<string, unknown>,
): PersistedPassASynthesis {
  const usages = Array.isArray(parsed?.['usages'])
    ? parsed!['usages'].filter((usage): usage is CallUsage =>
        isCallUsage(usage) && synthesisUsageIssue(usage, runId) !== null)
    : [];
  const declaredAttempts = parsed?.['attempts'];
  const attempts = Number.isSafeInteger(declaredAttempts) && (declaredAttempts as number) >= 0
    ? declaredAttempts as number
    : usages.reduce((highest, usage) =>
        Math.max(highest, synthesisUsageIssue(usage, runId)?.issue ?? 0), 0);
  return {
    kind: 'invalid',
    attempts,
    usages,
    detail: `PASS_A_SYNTHESIS_ARTIFACT_INVALID: ${detail}. ` +
      'The retained exact-key artifact is terminal authority; it will not be overwritten or re-bought.',
  };
}

async function readPassASynthesis(
  env: Env,
  runId: string,
  context: PassASynthesisContext,
): Promise<PersistedPassASynthesis | null> {
  const sidecar = await readPassASynthesisArtifact(
    env, runId, context, passASynthesisWireCeilingKey(runId),
  );
  const main = await readPassASynthesisArtifact(env, runId, context, passASynthesisKey(runId));
  if (sidecar === null) return main;
  const invalid = (detail: string): PersistedPassASynthesis => invalidSynthesisArtifact(
    runId,
    `wire-ceiling sidecar is invalid: ${detail}`,
    { attempts: main?.attempts ?? 0, usages: main?.usages ?? [] },
  );
  if (sidecar.kind !== "failed" || !sidecar.wireCeiling) {
    return invalid(
      sidecar.kind === "ok" ? "it contains a successful artifact" : sidecar.detail,
    );
  }
  if (
    main?.kind !== "failed" || main.wireCeiling || main.attempts < 1 || main.terminal
  ) {
    return invalid("it has no valid retryable paid main synthesis artifact beneath it");
  }
  return {
    kind: "failed",
    attempts: main.attempts,
    usages: main.usages,
    fallbackTrigger: main.fallbackTrigger,
    terminal: true,
    wireCeiling: true,
    detail: sidecar.detail,
  };
}

async function readPassASynthesisArtifact(
  env: Env,
  runId: string,
  context: PassASynthesisContext,
  artifactKey: string,
): Promise<PersistedPassASynthesis | null> {
  const obj = await env.EVIDENCE.get(artifactKey);
  if (!obj) return null;
  let artifactBodyText: string;
  try {
    artifactBodyText = await obj.text();
  } catch {
    return invalidSynthesisArtifact(runId, "artifact bytes are unreadable");
  }
  const storageAuthority = { etag: obj.etag, bodyText: artifactBodyText };
  let parsedForFailure: Record<string, unknown> | undefined;
  try {
    const decoded = JSON.parse(artifactBodyText) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return invalidSynthesisArtifact(runId, 'artifact root is not an object');
    }
    const parsed = decoded as Record<string, unknown>;
    parsedForFailure = parsed;
    const expected = synthesisArtifactEnvelope(env, context);
    if (
      parsed["schemaVersion"] !== expected.schemaVersion ||
      parsed["parserVersion"] !== expected.parserVersion ||
      parsed["promptVersion"] !== expected.promptVersion ||
      parsed["providerRouteIdentity"] !== expected.providerRouteIdentity ||
      parsed["inputHash"] !== expected.inputHash ||
      parsed["requestHash"] !== expected.requestHash ||
      parsed["policyIdentity"] !== expected.policyIdentity
    ) {
      return invalidSynthesisArtifact(
        runId,
        'artifact envelope identity differs from the current parser/prompt/route/request/policy identity',
        parsed,
      );
    }
    if (JSON.stringify(parsed["blockIds"]) !== JSON.stringify(expected.blockIds)) {
      return invalidSynthesisArtifact(
        runId, 'ordered source-block ownership does not match the exact synthesis request', parsed,
      );
    }
    if (JSON.stringify(parsed["coverage"]) !== JSON.stringify(expected.coverage)) {
      return invalidSynthesisArtifact(
        runId, 'coverage census does not match the request identity', parsed,
      );
    }
    const attempts = parsed["attempts"];
    const usages = parsed["usages"];
    if (
      !Number.isSafeInteger(attempts) || (attempts as number) < 0 ||
      !Array.isArray(usages) || !usages.every(isCallUsage)
    ) return invalidSynthesisArtifact(runId, 'attempts/usages are malformed', parsed);
    const coherence = validateSynthesisUsageCoherence(usages as CallUsage[], runId, attempts as number);
    if (coherence !== null) return invalidSynthesisArtifact(runId, coherence, parsed);

    if (parsed["status"] === "failed") {
      const fallbackTrigger = parsed["fallbackTrigger"] === null
        ? null
        : parseFallbackTrigger(parsed["fallbackTrigger"], usages as CallUsage[]);
      if (parsed["fallbackTrigger"] !== null && fallbackTrigger === null) {
        return invalidSynthesisArtifact(
          runId, 'fallback trigger is malformed or not bound to its Grok receipt', parsed,
        );
      }
      const failureStage = parsed["failureStage"];
      if (
        failureStage !== "input-grounding" && failureStage !== "wire-ceiling" &&
        failureStage !== "fallback-authorized" && failureStage !== "provider" &&
        failureStage !== "semantic-output"
      ) return invalidSynthesisArtifact(runId, 'failureStage is missing or invalid', parsed);
      const zeroReceiptStage =
        failureStage === "input-grounding" || failureStage === "wire-ceiling";
      const fallbackChainFailure = fallbackTrigger === null ? null : validatePassAFallbackUsageChain(
        usages as CallUsage[], runId, 'A-synthesis', attempts as number, fallbackTrigger,
        failureStage === "fallback-authorized" ? "pending" :
          failureStage === "semantic-output" ? "semantic-failed" : "provider-failed",
      );
      if (
        typeof parsed["terminal"] !== "boolean" ||
        typeof parsed["detail"] !== "string" || parsed["detail"].length === 0 ||
        ((attempts as number) === 0 &&
          (usages.length !== 0 || fallbackTrigger !== null || parsed["terminal"] !== true)) ||
        ((attempts as number) === 0 && !zeroReceiptStage) ||
        (zeroReceiptStage && (attempts as number) !== 0) ||
        (failureStage === "wire-ceiling" &&
          !parsed["detail"].startsWith(`${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}:`)) ||
        ((attempts as number) > 0 && usages.length === 0) ||
        parsed["routeReceipt"] !== undefined ||
        (failureStage === "provider" && fallbackTrigger === null && parsed["terminal"] !== true) ||
        (usages as CallUsage[]).some((usage) => usage.status === "ok") ||
        (failureStage === "semantic-output" &&
          (parsed["terminal"] !== true || !(usages as CallUsage[]).some((usage) => usage.status === "parse-failed"))) ||
        (failureStage === "fallback-authorized" &&
          (parsed["terminal"] !== false || fallbackTrigger === null ||
            (usages as CallUsage[]).some((usage) => usage.provider === "deepseek"))) ||
        fallbackChainFailure !== null
      ) return invalidSynthesisArtifact(runId, 'failed-artifact state is incoherent', parsed);
      const failedModelOutput = parsed["modelOutput"];
      if (failureStage === "semantic-output") {
        if (
          typeof failedModelOutput !== "object" || failedModelOutput === null ||
          Array.isArray(failedModelOutput)
        ) {
          return invalidSynthesisArtifact(
            runId, "semantic-output failure has no retained raw modelOutput", parsed,
          );
        }
        let semanticReplayDetail: string | null = null;
        try {
          validatePassASynthesisOutput(
            failedModelOutput as Record<string, unknown>,
            context,
          );
        } catch (error) {
          semanticReplayDetail = error instanceof Error ? error.message : String(error);
        }
        if (semanticReplayDetail === null) {
          return invalidSynthesisArtifact(
            runId,
            "semantic-output failure does not reproduce under the current strict decoder",
            parsed,
          );
        }
        if (
          semanticReplayDetail !== null &&
          parsed["detail"] !== semanticReplayDetail.slice(0, 400)
        ) {
          return invalidSynthesisArtifact(
            runId, "semantic-output detail differs from strict raw-output re-decoding", parsed,
          );
        }
      } else if (failedModelOutput !== undefined) {
        return invalidSynthesisArtifact(
          runId, "non-semantic failure carries model output it could not have produced", parsed,
        );
      }
      return rememberPassASynthesisStorageAuthority({
        kind: "failed" as const,
        attempts: attempts as number,
        usages: usages as CallUsage[],
        fallbackTrigger,
        terminal: parsed["terminal"],
        wireCeiling: failureStage === "wire-ceiling",
        detail: parsed["detail"],
      }, storageAuthority);
    }
    if (
      parsed["status"] !== "ok" || parsed["kind"] !== undefined ||
      parsed["failureStage"] !== undefined || parsed["terminal"] !== undefined ||
      parsed["detail"] !== undefined || parsed["fallbackTrigger"] !== undefined
    ) {
      return invalidSynthesisArtifact(runId, 'status is neither ok nor failed', parsed);
    }
    if ((attempts as number) < 1 || usages.length === 0) {
      return invalidSynthesisArtifact(runId, 'successful artifact has no paid attempt/receipt', parsed);
    }
    const routeReceipt = validatePassARouteReceiptForUnit(
      parsed["routeReceipt"], usages as CallUsage[], runId, 'A-synthesis',
    );
    if (routeReceipt === null) {
      return invalidSynthesisArtifact(runId, 'successful route receipt is malformed', parsed);
    }
    const modelOutput = parsed["modelOutput"];
    if (typeof modelOutput !== "object" || modelOutput === null || Array.isArray(modelOutput)) {
      return invalidSynthesisArtifact(runId, 'successful artifact has no closed model output', parsed);
    }
    // Re-run the exact source/provenance decoder on every reclaim. Durable does not mean
    // trusted: corrupt or hand-edited additions must never bypass grounding after a crash.
    const additions = validatePassASynthesisOutput(modelOutput as Record<string, unknown>, context);
    return rememberPassASynthesisStorageAuthority({
      kind: "ok" as const,
      attempts: attempts as number,
      usages: usages as CallUsage[],
      routeReceipt,
      additions,
    }, storageAuthority);
  } catch (error) {
    return invalidSynthesisArtifact(
      runId,
      error instanceof Error ? `retained model output failed validation: ${error.message}` :
        'retained model output failed validation',
      parsedForFailure,
    );
  }
}

async function persistPassASynthesisHistory(
  env: Env,
  runId: string,
  bodyText: string,
): Promise<string> {
  const bodySha256 = await sha256Hex(bodyText);
  return persistPrimaryWindowAppendOnly(
    env,
    passASynthesisHistoryKey(runId, bodySha256),
    bodyText,
    "PASS_A_SYNTHESIS_HISTORY_PERSISTENCE_FAILED",
  );
}

async function persistPassASynthesisCasConflict(
  env: Env,
  runId: string,
  bodyText: string,
): Promise<string> {
  const bodySha256 = await sha256Hex(bodyText);
  return persistPrimaryWindowAppendOnly(
    env,
    passASynthesisCasConflictKey(runId, bodySha256),
    bodyText,
    "PASS_A_SYNTHESIS_CAS_CONFLICT_PERSISTENCE_FAILED",
  );
}

async function writePassASynthesis(
  env: Env,
  runId: string,
  context: PassASynthesisContext,
  predecessor: PassASynthesisStorageAuthority | null,
  body: Record<string, unknown>,
  accept: (artifact: PersistedPassASynthesis) => boolean,
): Promise<PersistedPassASynthesis | null> {
  const key = passASynthesisKey(runId);
  const bodyText = JSON.stringify(
    { ...synthesisArtifactEnvelope(env, context), ...body },
    null,
    2,
  );
  let synthesisExpected = predecessor;
  let lastFailure: PassASynthesisPersistenceError | null = null;

  if (synthesisExpected !== null) {
    try {
      await persistPassASynthesisHistory(env, runId, synthesisExpected.bodyText);
    } catch (historyError) {
      let losingState = "could not retain the losing paid synthesis artifact";
      try {
        const conflictKey = await persistPassASynthesisCasConflict(env, runId, bodyText);
        losingState = `retained the losing paid synthesis artifact at ${conflictKey}`;
      } catch {
        // The history refusal stays primary. No canonical bytes are overwritten.
      }
      throw new PassASynthesisPersistenceError(
        historyError,
        `could not archive the exact predecessor before replacement and ${losingState}`,
      );
    }
  }

  for (
    let storageAttempt = 1;
    storageAttempt <= PASS_A_SYNTHESIS_ARTIFACT_PERSIST_ATTEMPTS;
    storageAttempt += 1
  ) {
    let writeError: unknown;
    try {
      const written = await env.EVIDENCE.put(key, bodyText, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: synthesisExpected === null
          ? { etagDoesNotMatch: "*" }
          : { etagMatches: synthesisExpected.etag },
      });
      if (written !== null) return null;
      writeError = new Error(
        synthesisExpected === null
          ? "conditional create found an occupied synthesis key"
          : "conditional replacement no longer matched the exact synthesis predecessor",
      );
    } catch (error) {
      // A transport error can arrive before or after commit. Exact reread decides which.
      writeError = error;
    }

    let object: R2ObjectBody | null;
    try {
      object = await env.EVIDENCE.get(key);
    } catch (readError) {
      lastFailure = new PassASynthesisPersistenceError(
        writeError,
        `failed with ${readError instanceof Error ? readError.message : String(readError)}`,
      );
      continue;
    }

    if (object === null) {
      if (synthesisExpected === null) {
        lastFailure = new PassASynthesisPersistenceError(
          writeError,
          "found no current synthesis artifact",
        );
        continue;
      }
      let losingState = "could not retain the losing paid synthesis artifact";
      try {
        const conflictKey = await persistPassASynthesisCasConflict(env, runId, bodyText);
        losingState = `retained the losing paid synthesis artifact at ${conflictKey}`;
      } catch {
        // The missing predecessor remains terminal even if the conflict archive also fails.
      }
      throw new PassASynthesisPersistenceError(
        writeError,
        `found the exact predecessor missing; refusing to recreate over lost authority; ${losingState}`,
      );
    }

    let retainedBytes: string;
    try {
      retainedBytes = await object.text();
    } catch (readError) {
      lastFailure = new PassASynthesisPersistenceError(
        writeError,
        `could not read retained bytes: ${readError instanceof Error ? readError.message : String(readError)}`,
      );
      continue;
    }

    if (retainedBytes !== bodyText) {
      if (synthesisExpected !== null && retainedBytes === synthesisExpected.bodyText) {
        synthesisExpected = { etag: object.etag, bodyText: retainedBytes };
        lastFailure = new PassASynthesisPersistenceError(
          writeError,
          "found the exact synthesis predecessor still present",
        );
        continue;
      }
      let conflictKey: string;
      try {
        conflictKey = await persistPassASynthesisCasConflict(env, runId, bodyText);
      } catch (conflictError) {
        throw new PassASynthesisPersistenceError(
          conflictError,
          "found an occupied synthesis artifact with different bytes and could not retain the losing paid artifact",
        );
      }
      throw new PassASynthesisPersistenceError(
        writeError,
        `found an occupied synthesis artifact with different bytes; exact losing bytes retained at ${conflictKey}`,
      );
    }

    const retained = await readPassASynthesisArtifact(env, runId, context, key);
    if (retained !== null && retained.kind !== "invalid" && accept(retained)) return retained;
    throw new PassASynthesisPersistenceError(
      writeError,
      retained === null
        ? "lost the exact synthesis artifact before strict reread"
        : `found exact bytes with ${retained.kind} authority that failed the expected-state check`,
    );
  }

  let retainedState = "did not prove the exact current synthesis artifact";
  try {
    const conflictKey = await persistPassASynthesisCasConflict(env, runId, bodyText);
    retainedState += `; exact paid bytes retained at ${conflictKey}`;
  } catch {
    retainedState += "; exact paid bytes could not be retained at the conflict key";
  }
  throw lastFailure ?? new PassASynthesisPersistenceError(
    "unknown storage failure",
    retainedState,
  );
}

/**
 * Execute or reclaim the ONE bounded candidate-reconciliation unit.
 *
 * The Workflow must call this only in a wave that issued ZERO primary-window purchases.
 * The issueAuthorized flag makes that invariant explicit at the call site: a final window
 * may already consume the one over-budget purchase protected by the step timeout.
 */
export async function runPassASynthesis(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  options: PassASynthesisOptions,
  onProgress?: (msg: string) => Promise<void>,
): Promise<PassASynthesisOutcome> {
  const context = await buildPassASynthesisContext(env, runId, doc, documentName);
  if (context === null) return synthesisOutcome("not-required");
  const coverage = context.coverage;
  const maxIssues = context.maxIssues;
  const existing = await readPassASynthesis(env, runId, context);
  const reusedCalls = (usages: CallUsage[], detail: string): CallUsage[] =>
    usages.map((usage) => ({ ...usage, costUsd: 0, detail }));

  if (existing?.kind === "ok") {
    const limitation = synthesisLimitation(coverage, existing.additions);
    return synthesisOutcome(
      existing.routeReceipt.trigger === null ? "ok" : "reduced-provider-independence",
      {
        attempts: existing.attempts,
        inputHash: context.inputHash,
        coverage,
        additions: existing.additions,
        calls: reusedCalls(existing.usages, "reused: cross-window synthesis artifact"),
        accountingCalls: existing.usages,
        routeReceipt: existing.routeReceipt,
        fallbackTrigger: existing.routeReceipt.trigger,
        limitation,
      },
    );
  }

  if (existing?.kind === 'invalid') {
    return synthesisOutcome('failed', {
      attempts: existing.attempts,
      inputHash: context.inputHash,
      coverage,
      calls: reusedCalls(existing.usages, 'reused: invalid retained cross-window synthesis artifact'),
      accountingCalls: existing.usages,
      failedUnit: { unit: 'A-synthesis-artifact', blockIds: context.sourceBlockIds, detail: existing.detail },
    });
  }

  if (existing?.kind === "failed" && existing.terminal) {
    return synthesisOutcome("failed", {
      attempts: existing.attempts,
      inputHash: context.inputHash,
      coverage,
      calls: reusedCalls(existing.usages, "reused: terminal cross-window synthesis failure"),
      accountingCalls: existing.usages,
      fallbackTrigger: existing.fallbackTrigger,
      failedUnit: { unit: "A-synthesis", blockIds: context.sourceBlockIds, detail: existing.detail },
      ...(existing.wireCeiling
        ? { terminalReasonCode: EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED }
        : {}),
    });
  }

  if (context.wireFailureDetail !== null) {
    const detail = context.wireFailureDetail;
    const wireBody = JSON.stringify({
      ...synthesisArtifactEnvelope(env, context),
      status: "failed", attempts: 0, usages: [], fallbackTrigger: null, terminal: true,
      failureStage: "wire-ceiling", detail,
    }, null, 2);
    await persistImmutableExtractionArtifact(
      env,
      existing ? passASynthesisWireCeilingKey(runId) : passASynthesisKey(runId),
      wireBody,
      "A-synthesis",
    );
    return synthesisOutcome("failed", {
      attempts: existing?.attempts ?? 0,
      inputHash: context.inputHash,
      coverage,
      calls: existing ? reusedCalls(existing.usages, "reused: terminal synthesis oversize") : [],
      accountingCalls: existing?.usages ?? [],
      fallbackTrigger: existing?.fallbackTrigger ?? null,
      failedUnit: { unit: "A-synthesis", blockIds: context.sourceBlockIds, detail },
      terminalReasonCode: EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
    });
  }

  const predecessorAuthority = existing?.kind === "failed"
    ? synthesisStorageAuthorityOf(existing)
    : null;
  if (existing?.kind === "failed" && predecessorAuthority === null) {
    const detail =
      "PASS_A_SYNTHESIS_STORAGE_AUTHORITY_MISSING: a retryable retained artifact did not carry " +
      "the exact strict-read etag/body authority; no new provider request was issued.";
    return synthesisOutcome("failed", {
      attempts: existing.attempts,
      inputHash: context.inputHash,
      coverage,
      calls: reusedCalls(existing.usages, "reused: synthesis storage authority refusal"),
      accountingCalls: existing.usages,
      fallbackTrigger: existing.fallbackTrigger,
      failedUnit: { unit: "A-synthesis-artifact", blockIds: context.sourceBlockIds, detail },
    });
  }

  const pendingSubstituteSynthesis = existing?.kind === "failed" &&
    existing.fallbackTrigger !== null &&
    !existing.usages.some((usage) => usage.provider === "deepseek" || usage.provider === "gemini");
  if (existing?.kind === "failed" && existing.attempts >= maxIssues && !pendingSubstituteSynthesis) {
    return synthesisOutcome("failed", {
      attempts: existing.attempts,
      inputHash: context.inputHash,
      coverage,
      calls: reusedCalls(existing.usages, "reused: terminal cross-window synthesis failure"),
      accountingCalls: existing.usages,
      fallbackTrigger: existing.fallbackTrigger,
      failedUnit: { unit: "A-synthesis", blockIds: context.sourceBlockIds, detail: existing.detail },
    });
  }
  if (!options.issueAuthorized) {
    return synthesisOutcome("pending", {
      attempts: existing?.attempts ?? 0,
      inputHash: context.inputHash,
      coverage,
      calls: existing ? reusedCalls(existing.usages, "reused: prior cross-window synthesis failure") : [],
      accountingCalls: existing?.usages ?? [],
      fallbackTrigger: existing?.fallbackTrigger ?? null,
    });
  }

  const priorUsages = existing?.kind === "failed" ? existing.usages : [];
  const priorAttempts = existing?.kind === "failed" ? existing.attempts : 0;
  const issue = pendingSubstituteSynthesis ? Math.max(1, priorAttempts) : priorAttempts + 1;
  let fallbackTrigger = existing?.kind === "failed" ? existing.fallbackTrigger : null;
  const purchasedUsages: CallUsage[] = [];
  const calls = reusedCalls(priorUsages, "reused: prior cross-window synthesis purchase");
  let purchaseEnv: Env;
  try {
    const grokKey = fallbackTrigger === null ? await keyFor(env, "grok") : null;
    const deepseekKey = await keyFor(env, "deepseek");
    purchaseEnv = {
      ...env,
      ...(grokKey !== null ? { XAI_API_KEY: grokKey } : {}),
      DEEPSEEK_API_KEY: deepseekKey,
    };
  } catch (error) {
    if (!(error instanceof MissingCredential)) throw error;
    const provider = error.binding === "XAI_API_KEY" ? "grok" : "deepseek";
    const detail = `${error.binding} is unavailable after exact synthesis request preflight; ` +
      `no new provider request was issued for A-synthesis.`;
    return synthesisOutcome("failed", {
      attempts: priorAttempts,
      inputHash: context.inputHash,
      coverage,
      calls,
      accountingCalls: priorUsages,
      fallbackTrigger,
      failedUnit: { unit: "A-synthesis", blockIds: context.sourceBlockIds, detail },
      credentialRefusal: { reason: "NO_CREDENTIAL", binding: error.binding, provider },
    });
  }
  return await purchasePassASynthesis(
    purchaseEnv, runId, context, documentName, context.optionsForCall, issue, maxIssues,
    priorUsages, purchasedUsages, calls, fallbackTrigger, predecessorAuthority, onProgress,
  );
}

async function purchasePassASynthesis(
  env: Env,
  runId: string,
  context: PassASynthesisContext,
  _documentName: string,
  optionsForCall: {
    system: string; user: string; maxTokens: number; role: string; callId: string; maxAttempts: number;
  },
  issue: number,
  maxIssues: number,
  priorUsages: CallUsage[],
  purchasedUsages: CallUsage[],
  calls: CallUsage[],
  initialFallbackTrigger: GrokFallbackTrigger | null,
  initialPredecessor: PassASynthesisStorageAuthority | null,
  onProgress?: (msg: string) => Promise<void>,
): Promise<PassASynthesisOutcome> {
  let fallbackTrigger = initialFallbackTrigger;
  let predecessorAuthority = initialPredecessor;
  let rawModelOutput: Record<string, unknown> | null = null;
  const persistenceFailureOutcome = (
    error: PassASynthesisPersistenceError,
  ): PassASynthesisOutcome => {
    const detail = error.message.slice(0, 400);
    return synthesisOutcome("failed", {
      issued: purchasedUsages.length,
      attempts: issue,
      inputHash: context.inputHash,
      coverage: context.coverage,
      calls,
      issuedCalls: purchasedUsages,
      accountingCalls: [...priorUsages, ...purchasedUsages],
      fallbackTrigger,
      failedUnit: {
        unit: "A-synthesis-artifact",
        blockIds: context.sourceBlockIds,
        detail,
      },
    });
  };
  try {
    let value: Record<string, unknown> | null = null;
    let routeReceipt: PassARouteReceipt | null = null;
    if (fallbackTrigger === null) {
      try {
        const outcome = await grokJson(env, optionsForCall);
        const usage = settlementUsage(runId, "A-synthesis", issue, 1, outcome.usage);
        purchasedUsages.push(usage);
        calls.push(usage);
        value = outcome.value;
        rawModelOutput = outcome.value;
        routeReceipt = { selected: "grok-4.6", trigger: null };
      } catch (error) {
        if (!(error instanceof ModelCallError) || !grokFlashFallbackEligible(error)) throw error;
        const usage = settlementUsage(runId, "A-synthesis", issue, 1, error.usage);
        purchasedUsages.push(usage);
        calls.push(usage);
        fallbackTrigger = {
          kind: GROK_FALLBACK_TRIGGER_VERSION,
          failureKind: error.failureKind,
          httpStatus: error.httpStatus,
          grokModel: DEFAULT_GROK_MODEL,
          grokUsageEventId: usage.eventId!,
          detail: error.message.slice(0, 400),
        };
        const authorizedTrigger = fallbackTrigger;
        const retainedFallbackCheckpoint = await writePassASynthesis(
          env,
          runId,
          context,
          predecessorAuthority,
          {
            status: "failed",
            attempts: issue,
            usages: [...priorUsages, ...purchasedUsages],
            fallbackTrigger: authorizedTrigger,
            terminal: false,
            failureStage: "fallback-authorized",
            detail: "Flash fallback authorized but not yet landed: " + authorizedTrigger.detail,
          },
          (artifact) =>
            artifact.kind === "failed" &&
            !artifact.terminal &&
            artifact.fallbackTrigger?.grokUsageEventId === authorizedTrigger.grokUsageEventId,
        );
        if (retainedFallbackCheckpoint !== null) {
          // The target committed despite a transport error. End this invocation at the
          // commit-before-effect boundary; the next strict reclaim may buy only Flash.
          return synthesisOutcome("pending", {
            issued: purchasedUsages.length,
            attempts: issue,
            inputHash: context.inputHash,
            coverage: context.coverage,
            calls,
            issuedCalls: purchasedUsages,
            accountingCalls: retainedFallbackCheckpoint.usages,
            fallbackTrigger: authorizedTrigger,
          });
        }
        const committedFallbackCheckpoint = await readPassASynthesisArtifact(
          env,
          runId,
          context,
          passASynthesisKey(runId),
        );
        const committedFallbackAuthority =
          synthesisStorageAuthorityOf(committedFallbackCheckpoint);
        if (
          committedFallbackCheckpoint?.kind !== "failed" ||
          committedFallbackCheckpoint.terminal ||
          committedFallbackCheckpoint.fallbackTrigger?.grokUsageEventId !==
            authorizedTrigger.grokUsageEventId ||
          committedFallbackAuthority === null
        ) {
          throw new PassASynthesisPersistenceError(
            "fallback checkpoint committed without strict reread authority",
            "could not bind the exact fallback-authorized predecessor before Flash",
          );
        }
        predecessorAuthority = committedFallbackAuthority;
      }
    }

    if (fallbackTrigger !== null) {
      // Same substitution chain as primary windows: Gemini first, DeepSeek Flash last resort
      let substituteSucceeded = false;
      try {
        // ENFORCE cumulative Gemini cap BEFORE the synthesis purchase
        const geminiShape = geminiGrokSubstituteRequestShape(env);
        const geminiBodyBytes = new TextEncoder().encode(
          chatRequestBodyText(geminiShape, optionsForCall),
        ).byteLength;
        const geminiRates = GEMINI_OFFICIAL_RATES[DEFAULT_GEMINI_MODEL];
        const geminiReservation = conservativeGeminiReservation(
          geminiBodyBytes,
          Math.max(0, Math.ceil(optionsForCall.maxTokens)),
          geminiRates.inputUsdPerMTok,
          geminiRates.outputUsdPerMTok,
        );
        await enforceGeminiCap(env.EVIDENCE, geminiMaxTotalUsd(env), geminiReservation);

        const geminiOutcome = await geminiGrokSubstituteJson(env, {
          ...optionsForCall,
          callId: `${optionsForCall.callId}:grok-gemini-substitute`,
        });
        const geminiUsage = settlementUsage(runId, "A-synthesis", issue, 2, geminiOutcome.usage);
        purchasedUsages.push(geminiUsage);
        calls.push(geminiUsage);
        value = geminiOutcome.value;
        rawModelOutput = geminiOutcome.value;
        routeReceipt = { selected: "gemini-2.5-flash", trigger: fallbackTrigger };
        substituteSucceeded = true;
      } catch (geminiErr) {
        if (geminiErr instanceof ModelCallError) {
          const geminiUsage = settlementUsage(runId, "A-synthesis", issue, 2, geminiErr.usage);
          purchasedUsages.push(geminiUsage);
          calls.push(geminiUsage);
        }
        // Cap exceeded or ledger corrupt: typed refusal, fall through to DeepSeek Flash
        if (geminiErr instanceof ProviderCapExceededRefusal) {
          // Fall through to DeepSeek Flash — the run continues reduced, not killed
        } else if (geminiErr instanceof ProviderLedgerCorrupt) {
          // Corrupt ledger = fail closed for Gemini, fall through to DeepSeek Flash
        }
        // All other Gemini errors: fall through to DeepSeek Flash
      }
      if (!substituteSucceeded) {
        const flashOutcome = await deepseekGrokFallbackJson(env, {
          ...optionsForCall,
          callId: `${optionsForCall.callId}:grok-fallback`,
        });
        const flashReceiptIndex = purchasedUsages.length > 1 ? 3 : 2;
        const flashUsage = settlementUsage(runId, "A-synthesis", issue, flashReceiptIndex, flashOutcome.usage);
        purchasedUsages.push(flashUsage);
        calls.push(flashUsage);
        value = flashOutcome.value;
        rawModelOutput = flashOutcome.value;
        routeReceipt = { selected: "deepseek-v4-flash", trigger: fallbackTrigger };
      }
    }
    if (value === null || routeReceipt === null) {
      throw new Error("pass-A synthesis route produced neither a primary nor a fallback outcome");
    }

    let additions = validatePassASynthesisOutput(value, context);
    const usages = [...priorUsages, ...purchasedUsages];
    const retainedSuccess = await writePassASynthesis(
      env,
      runId,
      context,
      predecessorAuthority,
      { status: "ok", attempts: issue, usages, routeReceipt, modelOutput: value },
      (artifact) => artifact.kind === "ok",
    );
    if (retainedSuccess?.kind === "ok") {
      additions = retainedSuccess.additions;
      routeReceipt = retainedSuccess.routeReceipt;
    }
    const limitation = synthesisLimitation(context.coverage, additions);
    // Progress is observability, not extraction authority. A heartbeat failure after the
    // success artifact lands must never overwrite it as failed and authorize a repurchase.
    if (onProgress) {
      try {
        await onProgress(
          `pass A synthesis: reconciled ${context.coverage.candidateRowsIncluded} candidate(s) across ` +
            `${context.coverage.primaryWindowsTotal} windows; ${limitation.synthesisAdditions} addition(s)`,
        );
      } catch {
        // Best effort only; the durable model outcome and receipts already landed.
      }
    }
    return synthesisOutcome(
      routeReceipt.trigger === null ? "ok" : "reduced-provider-independence",
      {
        issued: purchasedUsages.length,
        attempts: issue,
        inputHash: context.inputHash,
        coverage: context.coverage,
        additions,
        calls,
        issuedCalls: purchasedUsages,
        accountingCalls: usages,
        routeReceipt,
        fallbackTrigger: routeReceipt.trigger,
        limitation,
      },
    );
  } catch (error) {
    // The exact Grok + Flash bodies were preflighted before purchase. A missing secret is a
    // stage configuration refusal, not a paid/semantic synthesis attempt.
    if (error instanceof MissingCredential && purchasedUsages.length === 0) throw error;
    if (error instanceof PassASynthesisPersistenceError) {
      return persistenceFailureOutcome(error);
    }
    if (error instanceof ModelCallError) {
      const receipt = fallbackTrigger === null ? 1 : 2;
      const usage = settlementUsage(runId, "A-synthesis", issue, receipt, error.usage);
      purchasedUsages.push(usage);
      calls.push(usage);
    }
    const semanticFailure = !(error instanceof ModelCallError) && rawModelOutput !== null;
    if (!(error instanceof ModelCallError) && !semanticFailure) throw error;
    const detail = error instanceof Error ? error.message.slice(0, 400) : String(error);
    if (semanticFailure && purchasedUsages.length > 0) {
      const selected = purchasedUsages[purchasedUsages.length - 1]!;
      purchasedUsages[purchasedUsages.length - 1] = {
        ...selected,
        status: "parse-failed",
        detail: `semantic output rejected: ${detail}`.slice(0, 400),
      };
      const index = calls.findIndex((usage) => usage.eventId === selected.eventId);
      if (index >= 0) calls[index] = purchasedUsages[purchasedUsages.length - 1]!;
    }
    const terminal = semanticFailure || (
      error instanceof ModelCallError &&
      ((fallbackTrigger === null && !grokFlashFallbackEligible(error)) || issue >= maxIssues)
    );
    const usages = [...priorUsages, ...purchasedUsages];
    try {
      await writePassASynthesis(
        env,
        runId,
        context,
        predecessorAuthority,
        {
          status: "failed",
          attempts: issue,
          usages,
          fallbackTrigger,
          terminal,
          failureStage: semanticFailure ? "semantic-output" : "provider",
          detail,
          ...(semanticFailure ? { modelOutput: rawModelOutput } : {}),
        },
        (artifact) => artifact.kind === "failed",
      );
    } catch (persistenceError) {
      if (!(persistenceError instanceof PassASynthesisPersistenceError)) {
        throw persistenceError;
      }
      return persistenceFailureOutcome(persistenceError);
    }
    return synthesisOutcome(terminal ? "failed" : "pending", {
      issued: purchasedUsages.length,
      attempts: issue,
      inputHash: context.inputHash,
      coverage: context.coverage,
      calls,
      issuedCalls: purchasedUsages,
      accountingCalls: usages,
      fallbackTrigger,
      failedUnit: terminal ? { unit: "A-synthesis", blockIds: context.sourceBlockIds, detail } : null,
    });
  }
}

const uniqueStrings = (values: string[]): string[] => [...new Set(values)];

/**
 * Build a bounded reconciliation catalogue from exact persisted primary-window CANDIDATES.
 *
 * This is deliberately not whole-source coverage. Only source blocks nominated by a primary
 * rule/reference or uniquely grounded primary ambiguity/unverifiable quote are included. The
 * resulting final Pass-A payload carries pass-a-cross-window-candidate-dependence with the
 * exact omitted-source count. This purchase can reconcile evidence the primary readers
 * surfaced; it cannot claim it discovered relationships whose two halves neither reader
 * nominated.
 *
 * Nothing INSIDE that candidate catalogue is sampled or truncated. If the complete catalogue
 * exceeds its declared byte ceiling, synthesis is a named terminal failure and no pass seals.
 */
async function buildPassASynthesisContext(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
): Promise<PassASynthesisContext | null> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const windows = splitWindows(
    doc.blocks,
    num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000),
    num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 100),
  );
  if (windows.length <= 1) return null;

  const synthesisMaxRaw = env.EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES ?? "45000";
  if (!/^[1-9]\d*$/.test(synthesisMaxRaw)) {
    throw new Error("EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES must be a canonical positive integer");
  }
  const configuredSynthesisMaxBytes = Number(synthesisMaxRaw);
  if (!Number.isSafeInteger(configuredSynthesisMaxBytes)) {
    throw new Error("EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES must be a safe positive integer");
  }
  const universalWireMaxBytes = extractionWirePolicy(env).maxInputBytes;
  if (configuredSynthesisMaxBytes > universalWireMaxBytes) {
    throw new Error(
      `EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES (${configuredSynthesisMaxBytes}) must not exceed ` +
        `EXTRACT_MODEL_INPUT_MAX_BYTES (${universalWireMaxBytes})`,
    );
  }
  const maxBytes = configuredSynthesisMaxBytes;
  const maxIssues = Math.max(1, Math.floor(num(env.EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES, 2)));
  const inputWindows: CompactWindowRow[] = [];
  const evidenceRows: CompactEvidenceRow[] = [];
  const evidenceBySpan = new Map<string, string>();
  const primaryCrossRefs: PassASynthesisContext["primaryCrossRefs"] = [];
  const blocks = new Map<string, SourceBlock>();
  const windowByBlock = new Map<string, number>();
  const evidenceBlockIds = new Set<string>();
  const evidenceSpanKeys = new Set<string>();
  let primaryArtifactChainHash = `sha256:${await sha256Hex("pass-a-synthesis-primary-artifact-chain/v1")}`;
  let candidateRowsTotal = 0;
  let candidateRowsUngrounded = 0;
  let catalogueRefusal: Extract<ReturnType<typeof buildBoundedJsonText>, { ok: false }> | null = null;
  const noteEvidenceBlockIds = (
    rows: readonly { evidenceQuotes?: CrossWindowEvidenceQuote[] }[],
  ): void => {
    for (const row of rows) {
      for (const quote of row.evidenceQuotes ?? []) evidenceBlockIds.add(quote.blockId);
    }
  };
  const evidenceIdsFor = (quotes: CrossWindowEvidenceQuote[] | undefined): string[] => {
    if (!quotes || quotes.length === 0) return [];
    return quotes.map((evidence) => {
      const key = `${evidence.blockId}\u0000${evidence.quote}`;
      const existing = evidenceBySpan.get(key);
      if (existing) return existing;
      const id = `e${String(evidenceRows.length + 1).padStart(3, "0")}`;
      evidenceBySpan.set(key, id);
      evidenceSpanKeys.add(key);
      evidenceRows.push([id, evidence.blockId, evidence.quote]);
      evidenceBlockIds.add(evidence.blockId);
      return id;
    });
  };

  for (let i = 0; i < windows.length; i++) {
    const source = windows[i]!;
    const n = i + 1;
    const unit = await readWindow(env, runId, n, source, parserVersion, `A-w${n}`);
    // The caller may invoke this helper only after every independently read window landed.
    // Missing/failed input is not interpreted as an empty output and never triggers a call.
    if (!unit || unit.kind !== "ok") {
      throw new Error(
        `PASS_A_SYNTHESIS_INPUT_INCOMPLETE: primary window ${n} of ${windows.length} has no current successful artifact`,
      );
    }
    if (unit.routeReceipt.trigger !== null) {
      // A landed Flash substitute already made the configured DeepSeek Pass B ineligible.
      // Synthesis cannot restore independence, so it must not buy another call.
      return null;
    }
    const primaryArtifact = await env.EVIDENCE.get(windowKey(runId, n));
    if (primaryArtifact === null) {
      throw new Error(`PASS_A_SYNTHESIS_INPUT_INCOMPLETE: primary window ${n} artifact disappeared`);
    }
    const primaryArtifactHash = `sha256:${await sha256Hex(await primaryArtifact.text())}`;
    primaryArtifactChainHash = `sha256:${await sha256Hex(
      `${primaryArtifactChainHash}\nwindow:${n}\n${primaryArtifactHash}`,
    )}`;
    // readWindow already re-derived this exact projection from immutable raw modelOutput.
    // Re-inspecting the accepted subset would erase the counted coordinates of rows that
    // were deliberately withheld. Only closed metadata enters the synthesis input hash.
    const grounded = unit;
    candidateRowsUngrounded += unit.primaryGroundingLimitations.length;
    const qualifiedCrossRefs = grounded.crossRefs.map((row) => {
      const handle = row.sourceXrefHandle;
      if (typeof handle !== "string" || !handle.startsWith(`A-w${n}:x:`)) {
        throw new Error(`PASS_A_SYNTHESIS_INPUT_INVALID: surviving cross-reference lost its source-row handle`);
      }
      return { handle, windowNumber: n, row };
    });
    candidateRowsTotal +=
      unit.globalRules.length + unit.crossRefs.length + unit.ambiguities.length + unit.unverifiable.length +
      unit.primaryGroundingLimitations.length;
    noteEvidenceBlockIds(unit.globalRules);
    noteEvidenceBlockIds(unit.crossRefs);
    noteEvidenceBlockIds(unit.ambiguities);
    noteEvidenceBlockIds(unit.unverifiable);

    // Once the complete catalogue is already proven too large, retain no more candidate,
    // evidence or decode-only state. We still strict-read and hash every later immutable
    // window above, and keep exact scalar counts plus every affected source block id.
    if (catalogueRefusal !== null) continue;

    for (const block of source) {
      blocks.set(block.blockId, block);
      windowByBlock.set(block.blockId, n);
    }
    primaryCrossRefs.push(...qualifiedCrossRefs);
    const rules: CompactRuleRow[] = grounded.globalRules.map((row, index) => [
      `A-w${n}:r:${String(index + 1).padStart(3, "0")}`,
      row.construct, row.scope, row.quantifier, row.selector, row.exceptions, row.statement,
      evidenceIdsFor(row.evidenceQuotes), row.blockIds, row.browserObservable, row.expansion,
    ]);
    const xrefs: CompactXrefRow[] = grounded.crossRefs.map((row) => [
      row.sourceXrefHandle!,
      row.fromBlock, row.target, row.resolvedToBlock, row.statement,
      evidenceIdsFor(row.evidenceQuotes),
    ]);
    const candidateEvidence = (row: RawAmbiguity | RawUnverifiable): string[] =>
      evidenceIdsFor(row.evidenceQuotes);
    const amb: CompactAmbiguityRow[] = grounded.ambiguities.map((row, index) => [
      `A-w${n}:a:${String(index + 1).padStart(3, "0")}`,
      candidateEvidence(row), row.readingA, row.readingB, row.whyAmbiguous, row.affects,
    ]);
    const unv: CompactUnverifiableRow[] = grounded.unverifiable.map((row, index) => [
      `A-w${n}:u:${String(index + 1).padStart(3, "0")}`,
      candidateEvidence(row), row.mandate, row.whyNotObservable, row.browserProxyEvidence,
    ]);
    inputWindows.push([`A-w${n}`, rules, xrefs, amb, unv]);

    // A single primary output is provider-output-bounded. Checking after each window caps
    // aggregate retained catalogue state at the synthesis ceiling instead of accumulating
    // every paid window and only discovering the overflow at the final JSON.stringify.
    const partialInput: PassASynthesisInput = {
      v: 1,
      c: [windows.length, candidateRowsTotal, doc.blocks.length, evidenceRows.length],
      w: inputWindows,
      e: evidenceRows,
    };
    const partialBound = buildBoundedJsonText(partialInput, maxBytes);
    if (!partialBound.ok) {
      catalogueRefusal = partialBound;
      inputWindows.length = 0;
      evidenceRows.length = 0;
      evidenceBySpan.clear();
      evidenceSpanKeys.clear();
      primaryCrossRefs.length = 0;
      blocks.clear();
      windowByBlock.clear();
    }
  }

  const candidateRowsIncluded = catalogueRefusal === null
    ? inputWindows.reduce(
        (sum, window) => sum + window[1].length + window[2].length + window[3].length + window[4].length,
        0,
      )
    : 0;
  const coverage: PassASynthesisCoverage = {
    primaryWindowsTotal: windows.length,
    primaryWindowsIncluded: catalogueRefusal === null ? inputWindows.length : 0,
    candidateRowsTotal,
    candidateRowsIncluded,
    candidateRowsUngrounded,
    sourceBlocksTotal: doc.blocks.length,
    sourceEvidenceBlocksIncluded: catalogueRefusal === null ? evidenceBlockIds.size : 0,
    sourceEvidenceSpansIncluded: catalogueRefusal === null ? evidenceRows.length : 0,
    sourceBlocksOmitted: catalogueRefusal === null ? doc.blocks.length - evidenceBlockIds.size : doc.blocks.length,
    method: "window-output-candidates-plus-exact-source-evidence",
  };
  if (catalogueRefusal === null && (
    coverage.primaryWindowsIncluded !== coverage.primaryWindowsTotal ||
    coverage.candidateRowsIncluded + coverage.candidateRowsUngrounded !== coverage.candidateRowsTotal
  )) {
    throw new Error(
      `PASS_A_SYNTHESIS_COVERAGE_MISMATCH: included ${coverage.primaryWindowsIncluded}/${coverage.primaryWindowsTotal} ` +
        `windows and ${coverage.candidateRowsIncluded}/${coverage.candidateRowsTotal} candidate rows`,
    );
  }

  const input: PassASynthesisInput = {
    v: 1,
    c: [windows.length, candidateRowsTotal, doc.blocks.length, evidenceRows.length],
    w: inputWindows,
    e: evidenceRows,
  };
  const sourceBlockIds = catalogueRefusal === null
    ? doc.blocks.map((block) => block.blockId).filter((blockId) => evidenceBlockIds.has(blockId))
    : doc.blocks.map((block) => block.blockId);
  const boundedInput = catalogueRefusal ?? buildBoundedJsonText(input, maxBytes);
  const inputJson = boundedInput.ok ? boundedInput.text : "";
  const catalogueBytes = boundedInput.ok
    ? boundedInput.utf8Bytes
    : boundedInput.provenUtf8ByteLowerBound;
  const inputIdentity = boundedInput.ok
    ? {
        catalogueHash: await sha256Hex(inputJson),
        primaryArtifactChainHash,
      }
    : {
        refusal: EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
        proof: {
          phase: boundedInput.phase,
          maxBytes: boundedInput.maxBytes,
          provenUtf8ByteLowerBound: boundedInput.provenUtf8ByteLowerBound,
        },
        coverage,
        sourceBlockIds,
        primaryArtifactChainHash,
      };
  const inputHash = `sha256:${await sha256Hex(JSON.stringify(inputIdentity))}`;
  const optionsForCall = {
    system: SYSTEM_A_SYNTHESIS,
    user: userMessageASynthesis(documentName, inputJson),
    maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
    role: "extract-pass-a-synthesis",
    callId: "call_a_synthesis",
    maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
  };
  let grokWireBytes = 0;
  let flashWireBytes = 0;
  let wireBytes = 0;
  let wireFailureDetail: string | null;
  let requestHash: string;
  if (!boundedInput.ok) {
    wireFailureDetail = extractionWirePreSerializationFailureDetail(
      "A-synthesis",
      sourceBlockIds.length,
      boundedInput,
      "EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES",
    );
    requestHash = `sha256:${await sha256Hex(JSON.stringify({ inputHash, wireFailureDetail }))}`;
  } else {
    const grokBody = chatRequestBodyText(grokRequestShape(env), optionsForCall);
    const flashBody = chatRequestBodyText(deepseekGrokFallbackRequestShape(env), optionsForCall);
    grokWireBytes = utf8ByteLength(grokBody);
    flashWireBytes = utf8ByteLength(flashBody);
    wireBytes = Math.max(grokWireBytes, flashWireBytes);
    const wirePreflight = preflightExtractionRequestBodies(
      env,
      [
        { route: "grok-4.6", bodyText: grokBody },
        { route: "deepseek-v4-flash", bodyText: flashBody },
      ],
      { name: "EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES", maxBytes },
    );
    wireFailureDetail = wirePreflight.ok
      ? null
      : extractionWireFailureDetail("A-synthesis", sourceBlockIds.length, wirePreflight);
    requestHash = `sha256:${await sha256Hex(JSON.stringify({ grokBody, flashBody }))}`;
  }
  const policyIdentity = [
    PASS_A_SYNTHESIS_VERSION,
    `max-bytes:${maxBytes}`,
    `max-issues:${maxIssues}`,
  ].join("|");
  return {
    parserVersion, inputJson, inputHash, catalogueBytes, wireBytes, grokWireBytes, flashWireBytes,
    wireFailureDetail, sourceBlockIds,
    requestHash, policyIdentity, maxBytes, maxIssues, optionsForCall,
    coverage, blocks, windowByBlock, evidenceBlockIds, evidenceSpanKeys, primaryCrossRefs,
  };
}

function synthesisLimitation(
  coverage: PassASynthesisCoverage,
  additions: PassASynthesisAdditions,
): PassACrossWindowLimitation {
  const synthesisAdditions =
    additions.globalRules.length + additions.crossRefs.length +
    additions.ambiguities.length + additions.unverifiable.length;
  return {
    kind: "pass-a-cross-window-candidate-dependence",
    windowsTotal: coverage.primaryWindowsTotal,
    candidatesSynthesized: coverage.candidateRowsIncluded,
    candidatesUngrounded: coverage.candidateRowsUngrounded,
    sourceEvidenceBlocks: coverage.sourceEvidenceBlocksIncluded,
    sourceEvidenceSpans: coverage.sourceEvidenceSpansIncluded,
    synthesisAdditions,
    detail:
      `Cross-window reconciliation compared all ${coverage.candidateRowsIncluded} candidate row(s) emitted by ` +
      `${coverage.primaryWindowsTotal} primary window reader(s), using ` +
      `${coverage.sourceEvidenceSpansIncluded} exact candidate quote span(s) from ` +
      `${coverage.sourceEvidenceBlocksIncluded} of ${coverage.sourceBlocksTotal} block(s). It did not inspect ` +
      `unsupplied text inside represented blocks or the ${coverage.sourceBlocksOmitted} block(s) no primary reader ` +
      `nominated. This is never whole-source cross-window discovery, even when the omitted-block count is zero.`,
  };
}

function strictModelRows(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: ${name} must be an array`);
  }
  if (value.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: ${name} contains a non-object row`);
  }
  return value as Record<string, unknown>[];
}

function strictSynthesisKeys(raw: Record<string, unknown>, allowed: readonly string[], row: string): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(raw).filter((key) => !allow.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(raw, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `PASS_A_SYNTHESIS_OUTPUT_INVALID: ${row} keys are not closed; missing=[${missing.join(",")}], ` +
        `unexpected=[${unexpected.join(",")}]`,
    );
  }
}

function synthesisEvidence(
  raw: Record<string, unknown>,
  blockIds: string[],
  context: PassASynthesisContext,
): CrossWindowEvidenceQuote[] {
  const rows = strictModelRows(raw["evidence_quotes"], "evidence_quotes");
  const evidence: CrossWindowEvidenceQuote[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    strictSynthesisKeys(row, ["block_id", "quote"], "evidence quote");
    const blockId = typeof row["block_id"] === "string" ? row["block_id"] : "";
    const quote = typeof row["quote"] === "string" ? row["quote"] : "";
    const block = context.blocks.get(blockId);
    const spanKey = `${blockId}\u0000${quote}`;
    if (
      blockId.length === 0 || quote.length === 0 || seen.has(blockId) ||
      !context.evidenceBlockIds.has(blockId) || !context.evidenceSpanKeys.has(spanKey) ||
      !block || !block.text.includes(quote)
    ) {
      throw new Error(
        `PASS_A_SYNTHESIS_OUTPUT_INVALID: evidence for ${JSON.stringify(blockId)} is absent, repeated, ` +
          `was not shown to synthesis as that exact span, or is not an exact source substring`,
      );
    }
    seen.add(blockId);
    evidence.push({ blockId, quote });
  }
  const cited = uniqueStrings(blockIds);
  if (
    cited.length < 2 || cited.some((id) => !seen.has(id)) ||
    evidence.some((row) => !cited.includes(row.blockId))
  ) {
    throw new Error(
      "PASS_A_SYNTHESIS_OUTPUT_INVALID: block_ids and evidence_quotes must be the same set with at least two blocks",
    );
  }
  const windows = new Set(cited.map((id) => context.windowByBlock.get(id)));
  if (windows.has(undefined) || windows.size < 2) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: a synthesis row must cite exact evidence across two windows");
  }
  return evidence;
}

function rawBlockIds(raw: Record<string, unknown>): string[] {
  if (
    !Array.isArray(raw["block_ids"]) ||
    raw["block_ids"].length === 0 ||
    raw["block_ids"].some((id) => typeof id !== "string" || id.trim().length === 0) ||
    new Set(raw["block_ids"]).size !== raw["block_ids"].length
  ) {
    throw new Error(
      "PASS_A_SYNTHESIS_OUTPUT_INVALID: block_ids must be a nonempty duplicate-free string array",
    );
  }
  return raw["block_ids"] as string[];
}

const SYNTHESIS_QUANTIFIERS = new Set(["every", "each", "only", "any", "none", "specific"]);
const SYNTHESIS_OBSERVABILITY = new Set(["full", "partial", "none"]);
const SYNTHESIS_CONSTRUCTS = new Set<string>(CONSTRUCT_CLASSES);

function nonemptyRawString(raw: Record<string, unknown>, key: string, row: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: ${row}.${key} must be a non-empty string`);
  }
  return value;
}

function validateSynthesisRuleShape(raw: Record<string, unknown>): void {
  strictSynthesisKeys(raw, [
    "id", "construct", "scope", "quantifier", "selector", "exceptions", "statement",
    "doc_quote", "block_ids", "evidence_quotes", "browser_observable", "confidence",
  ], "global rule");
  nonemptyRawString(raw, "id", "global rule");
  const construct = nonemptyRawString(raw, "construct", "global rule");
  const scope = nonemptyRawString(raw, "scope", "global rule");
  const quantifier = nonemptyRawString(raw, "quantifier", "global rule");
  const observable = nonemptyRawString(raw, "browser_observable", "global rule");
  nonemptyRawString(raw, "statement", "global rule");
  nonemptyRawString(raw, "doc_quote", "global rule");
  rawBlockIds(raw);
  if (!SYNTHESIS_CONSTRUCTS.has(construct)) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: unknown global rule construct ${JSON.stringify(construct)}`);
  }
  if (scope !== "survey" && !/^section:.+/.test(scope)) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: invalid global rule scope ${JSON.stringify(scope)}`);
  }
  if (!SYNTHESIS_QUANTIFIERS.has(quantifier)) {
    throw new Error(`PASS_A_SYNTHESIS_OUTPUT_INVALID: invalid global rule quantifier ${JSON.stringify(quantifier)}`);
  }
  if (!SYNTHESIS_OBSERVABILITY.has(observable)) {
    throw new Error(
      `PASS_A_SYNTHESIS_OUTPUT_INVALID: invalid browser_observable ${JSON.stringify(observable)}`,
    );
  }
  if (
    !Array.isArray(raw["exceptions"]) ||
    raw["exceptions"].some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: global rule exceptions must be a string array");
  }
  if (
    raw["selector"] !== null &&
    (typeof raw["selector"] !== "string" || raw["selector"].trim().length === 0)
  ) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: global rule selector must be a non-empty string or null");
  }
  if (
    typeof raw["confidence"] !== "number" || !Number.isFinite(raw["confidence"]) ||
    raw["confidence"] < 0 || raw["confidence"] > 1
  ) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: global rule confidence must be within 0..1");
  }
}

/** Strict fail-closed decoder: one malformed/inexact row invalidates the synthesis purchase. */
export function validatePassASynthesisOutput(
  value: Record<string, unknown>,
  context: PassASynthesisContext,
): PassASynthesisAdditions {
  strictSynthesisKeys(
    value,
    ["global_rules", "cross_reference_resolutions", "ambiguities", "unverifiable_from_browser"],
    "root",
  );
  const globalRules: RawRequirement[] = [];
  for (const raw of strictModelRows(value["global_rules"], "global_rules")) {
    validateSynthesisRuleShape(raw);
    const requirement = coerceRequirement(raw, "A", "A-synthesis", "survey");
    if (requirement === null) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: a global rule lacked a required typed field");
    }
    const evidenceQuotes = synthesisEvidence(raw, requirement.blockIds, context);
    if (!evidenceQuotes.some((row) => row.quote === requirement.docQuote)) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: doc_quote must equal one exact per-block evidence quote");
    }
    globalRules.push({ ...requirement, evidenceQuotes });
  }

  const crossRefs: CrossRef[] = [];
  const resolvedHandles = new Set<string>();
  for (const raw of strictModelRows(value["cross_reference_resolutions"], "cross_reference_resolutions")) {
    strictSynthesisKeys(raw, [
      "source_xref_handle", "resolved_to_block", "statement", "evidence_quotes",
    ], "cross-reference resolution");
    const sourceXrefHandle =
      typeof raw["source_xref_handle"] === "string" ? raw["source_xref_handle"] : "";
    const resolvedToBlock = typeof raw["resolved_to_block"] === "string" ? raw["resolved_to_block"] : "";
    const statement = typeof raw["statement"] === "string" ? raw["statement"].trim() : "";
    if (resolvedHandles.has(sourceXrefHandle)) {
      throw new Error(
        `PASS_A_SYNTHESIS_OUTPUT_INVALID: duplicate cross-reference resolution for ${JSON.stringify(sourceXrefHandle)}`,
      );
    }
    resolvedHandles.add(sourceXrefHandle);
    const matches = context.primaryCrossRefs.filter((entry) => entry.handle === sourceXrefHandle);
    const primary = matches.length === 1 ? matches[0]!.row : null;
    if (
      !primary || primary.fromBlock === null || primary.resolvedToBlock !== null ||
      resolvedToBlock.length === 0 || statement.length === 0
    ) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: cross-reference resolution has no exact primary source");
    }
    const blockIds = uniqueStrings([primary.fromBlock, resolvedToBlock]);
    const evidenceQuotes = synthesisEvidence(raw, blockIds, context);
    crossRefs.push({
      id: primary.id,
      sourceXrefId: primary.id,
      sourceXrefHandle,
      fromBlock: primary.fromBlock,
      target: primary.target,
      resolvedToBlock,
      statement,
      evidenceQuotes,
    });
  }

  const ambiguities: RawAmbiguity[] = [];
  const ambiguityRows = strictModelRows(value["ambiguities"], "ambiguities");
  for (const raw of ambiguityRows) {
    strictSynthesisKeys(raw, [
      "id", "block_ids", "doc_quote", "reading_a", "reading_b", "why_ambiguous", "affects",
      "evidence_quotes",
    ], "ambiguity");
    const readingA = nonemptyRawString(raw, "reading_a", "ambiguity");
    const readingB = nonemptyRawString(raw, "reading_b", "ambiguity");
    if (readingA.trim() === readingB.trim()) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: ambiguity readings must be distinct");
    }
    if (
      !Array.isArray(raw["affects"]) ||
      raw["affects"].some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: ambiguity.affects must be a string array");
    }
  }
  const coercedAmbiguities = coerceAmbiguities(ambiguityRows, "A");
  if (coercedAmbiguities.length !== ambiguityRows.length) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: an ambiguity lacked two complete readings");
  }
  for (let i = 0; i < ambiguityRows.length; i++) {
    const raw = ambiguityRows[i]!;
    nonemptyRawString(raw, "id", "ambiguity");
    nonemptyRawString(raw, "doc_quote", "ambiguity");
    nonemptyRawString(raw, "reading_a", "ambiguity");
    nonemptyRawString(raw, "reading_b", "ambiguity");
    nonemptyRawString(raw, "why_ambiguous", "ambiguity");
    const row = coercedAmbiguities[i]!;
    const blockIds = rawBlockIds(raw);
    const evidenceQuotes = synthesisEvidence(raw, blockIds, context);
    if (!evidenceQuotes.some((evidence) => evidence.quote === row.docQuote)) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: ambiguity doc_quote is not exact evidence");
    }
    ambiguities.push({ ...row, blockIds, evidenceQuotes });
  }

  const unverifiable: RawUnverifiable[] = [];
  const unverifiableRows = strictModelRows(value["unverifiable_from_browser"], "unverifiable_from_browser");
  for (const raw of unverifiableRows) {
    strictSynthesisKeys(raw, [
      "id", "block_ids", "doc_quote", "mandate", "why_not_observable", "browser_proxy_evidence",
      "evidence_quotes",
    ], "unverifiable");
    nonemptyRawString(raw, "browser_proxy_evidence", "unverifiable");
  }
  const coercedUnverifiable = coerceUnverifiable(unverifiableRows, "A");
  if (coercedUnverifiable.length !== unverifiableRows.length) {
    throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: an unverifiable row lacked a mandate");
  }
  for (let i = 0; i < unverifiableRows.length; i++) {
    const raw = unverifiableRows[i]!;
    nonemptyRawString(raw, "id", "unverifiable");
    nonemptyRawString(raw, "doc_quote", "unverifiable");
    nonemptyRawString(raw, "mandate", "unverifiable");
    nonemptyRawString(raw, "why_not_observable", "unverifiable");
    const row = coercedUnverifiable[i]!;
    const blockIds = rawBlockIds(raw);
    const evidenceQuotes = synthesisEvidence(raw, blockIds, context);
    if (!evidenceQuotes.some((evidence) => evidence.quote === row.docQuote)) {
      throw new Error("PASS_A_SYNTHESIS_OUTPUT_INVALID: unverifiable doc_quote is not exact evidence");
    }
    unverifiable.push({ ...row, blockIds, evidenceQuotes });
  }

  return { globalRules, crossRefs, ambiguities, unverifiable };
}

const STALE_PASS_A_PROMPT_IDENTITY = /^v2-extract-pass-a\/\d+\.\d+\.\d+$/;

/**
 * Reconstruct only the amount of historical primary-window work that durably landed.
 *
 * Unlike `reconstructPassACompletedAuthority`, this compatibility reader intentionally does
 * not decode `modelOutput`, re-ground candidate rows, or return any semantic payload. It is
 * useful only when a pre-reading-progress run retained artifacts written by an older Pass-A
 * prompt. Every other identity remains current and exact; relaxing more than the prompt
 * would turn a historical display into an accidental cache/coverage authority.
 */
export async function reconstructPassAHistoricalProgressCensus(
  env: Env,
  runId: string,
  doc: ParsedDocument,
): Promise<PassAHistoricalProgressCensus> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const windows = splitWindows(
    doc.blocks,
    num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000),
    num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 100),
  );
  const routeIdentity = grokFlashRouteIdentity(env);
  const policyIdentity = windowPolicyIdentity(env);
  let historicalPromptIdentity: string | null = null;

  const invalid = (detail: string): PassAHistoricalProgressCensus => ({
    kind: "invalid",
    detail: `PASS_A_HISTORICAL_PROGRESS_CENSUS_INVALID: ${detail}. ` +
      "No stored model output was decoded, reused, or granted coverage authority.",
  });

  for (let index = 0; index < windows.length; index += 1) {
    const n = index + 1;
    const origin = windows.length === 1 ? "A" : `A-w${n}`;
    const expectedBlockIds = windows[index]!.map((block) => block.blockId);
    const object = await env.EVIDENCE.get(windowKey(runId, n));
    if (!object) {
      return historicalPromptIdentity === null
        ? { kind: "none" }
        : invalid(`${origin} is missing from the contiguous retained sequence`);
    }

    let parsed: Record<string, unknown>;
    try {
      const decoded = JSON.parse(await object.text()) as unknown;
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        return historicalPromptIdentity === null
          ? { kind: "none" }
          : invalid(`${origin} artifact root is not an object`);
      }
      parsed = decoded as Record<string, unknown>;
    } catch {
      return historicalPromptIdentity === null
        ? { kind: "none" }
        : invalid(`${origin} artifact JSON is unreadable`);
    }

    const promptIdentity = parsed["promptVersion"];
    if (historicalPromptIdentity === null) {
      // Current-prompt artifacts belong to the strict authority decoder, including its
      // corruption handling. This reader only arbitrates a positively identified stale
      // Pass-A lineage.
      if (
        promptIdentity === PROMPT_VERSION_A ||
        typeof promptIdentity !== "string" ||
        !STALE_PASS_A_PROMPT_IDENTITY.test(promptIdentity)
      ) return { kind: "none" };
      historicalPromptIdentity = promptIdentity;
    } else if (promptIdentity !== historicalPromptIdentity) {
      return invalid(`${origin} does not share the first artifact's stale prompt identity`);
    }

    if (
      parsed["parserVersion"] !== parserVersion ||
      parsed["providerRouteIdentity"] !== routeIdentity ||
      parsed["windowPolicyIdentity"] !== policyIdentity
    ) return invalid(`${origin} does not match the current parser, route, and partition identities`);
    if (parsed["windowId"] !== origin || parsed["windowNumber"] !== n) {
      return invalid(`${origin} does not own its declared window id and ordinal`);
    }

    const blockIds = parsed["blockIds"];
    // HISTORICAL_CENSUS_ORDERED_BLOCK_OWNERSHIP_GUARD: progress is counted only when the
    // retained unit owns exactly the canonical current window, in exact document order.
    if (
      !Array.isArray(blockIds) ||
      blockIds.length !== expectedBlockIds.length ||
      blockIds.some((id, blockIndex) =>
        typeof id !== "string" || id !== expectedBlockIds[blockIndex]
      )
    ) return invalid(`${origin} ordered source-block ownership is not canonical`);

    const attempts = parsed["attempts"];
    const usages = parsed["usages"];
    if (
      !Number.isSafeInteger(attempts) || (attempts as number) < 0 ||
      !Array.isArray(usages) || !usages.every(isCallUsage)
    ) return invalid(`${origin} attempts or paid receipts are malformed`);
    const typedUsages = usages as CallUsage[];
    const zeroReceiptWireFailure =
      parsed["status"] === "failed" && parsed["failureStage"] === "wire-ceiling" &&
      attempts === 0 && typedUsages.length === 0;
    const coherence = zeroReceiptWireFailure
      ? null
      : validatePassAUnitUsageCoherence(typedUsages, runId, origin, attempts as number);
    if (coherence !== null) return invalid(`${origin} ${coherence}`);

    if (parsed["status"] === "failed") {
      const fallbackTrigger = parsed["fallbackTrigger"] === null
        ? null
        : parseFallbackTrigger(parsed["fallbackTrigger"], typedUsages);
      if (
        typeof parsed["detail"] !== "string" || parsed["detail"].length === 0 ||
        typeof parsed["terminal"] !== "boolean" ||
        parsed["kind"] !== undefined ||
        parsed["routeReceipt"] !== undefined ||
        parsed["globalRules"] !== undefined || parsed["crossRefs"] !== undefined ||
        parsed["ambiguities"] !== undefined || parsed["unverifiable"] !== undefined ||
        parsed["primaryGroundingLimitations"] !== undefined ||
        (parsed["fallbackTrigger"] !== null && fallbackTrigger === null)
      ) return invalid(`${origin} failed-state envelope is malformed or carries success output`);

      const failureStage = parsed["failureStage"];
      if (
        failureStage !== "fallback-authorized" &&
        failureStage !== "provider" &&
        failureStage !== "semantic-output" &&
        failureStage !== "wire-ceiling"
      ) return invalid(`${origin} failure stage is missing or invalid`);
      const retainedModelOutput = parsed["modelOutput"];
      if (
        failureStage === "semantic-output" && retainedModelOutput !== undefined &&
        (typeof retainedModelOutput !== "object" || retainedModelOutput === null ||
          Array.isArray(retainedModelOutput))
      ) return invalid(`${origin} retained semantic model output is not an object`);
      if (
        failureStage !== "semantic-output" &&
        retainedModelOutput !== undefined && retainedModelOutput !== null
      ) return invalid(`${origin} provider/fallback failure carries impossible model output`);
      if (
        fallbackTrigger !== null &&
        !typedUsages.some((usage) => usage.eventId === fallbackTrigger.grokUsageEventId)
      ) return invalid(`${origin} fallback trigger is not bound to a retained receipt`);
      const fallbackChainFailure = fallbackTrigger === null ? null : validatePassAFallbackUsageChain(
        typedUsages,
        runId,
        origin,
        attempts as number,
        fallbackTrigger,
        failureStage === "fallback-authorized" ? "pending" :
          failureStage === "semantic-output" ? "semantic-failed" : "provider-failed",
      );
      if (
        (failureStage === "wire-ceiling" &&
          ((attempts as number) !== 0 || typedUsages.length !== 0 || fallbackTrigger !== null ||
            parsed["terminal"] !== true || Object.hasOwn(parsed, "modelOutput") ||
            !(parsed["detail"] as string).startsWith(
              `${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}:`,
            ))) ||
        (failureStage !== "wire-ceiling" && (attempts as number) === 0) ||
        (failureStage === "provider" && fallbackTrigger === null && parsed["terminal"] !== true) ||
        (fallbackTrigger === null && typedUsages.some((usage) => usage.provider === "deepseek")) ||
        typedUsages.some((usage) => usage.status === "ok") ||
        (failureStage === "semantic-output" &&
          (parsed["terminal"] !== true || !typedUsages.some((usage) => usage.status === "parse-failed"))) ||
        (failureStage === "fallback-authorized" &&
          (parsed["terminal"] !== false || fallbackTrigger === null ||
            typedUsages.some((usage) => usage.provider === "deepseek"))) ||
        fallbackChainFailure !== null
      ) return invalid(`${origin} failure state is inconsistent with its retained receipts`);
      if (parsed["terminal"] !== true) {
        return invalid(`${origin} is a non-terminal failure, so it is not an accounted unit`);
      }

      // Serial Pass A cannot legitimately persist a later canonical window after a terminal
      // failure. Check only key presence; later bodies remain unread and have no authority.
      for (let laterIndex = index + 1; laterIndex < windows.length; laterIndex += 1) {
        const later = await env.EVIDENCE.get(windowKey(runId, laterIndex + 1));
        if (later) {
          return invalid(
            `${origin} is terminal but a later canonical primary-window artifact is present`,
          );
        }
      }

      const accounted = n;
      return {
        kind: "ok",
        value: {
          total: windows.length,
          accounted,
          remaining: windows.length - accounted,
          failedUnit: {
            unit: origin,
            blockIds: [...expectedBlockIds],
            detail:
              "A retained primary-window artifact records a terminal failure; semantic output was not reused.",
          },
          limitation: {
            code: PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE,
            count: 1,
            detail:
              "Primary-window progress was reconstructed from retained artifact metadata after the run. " +
              "Stored model output was neither decoded nor reused, and this census grants no extraction or coverage authority.",
          },
        },
      };
    }

    if (
      parsed["kind"] !== "ok" ||
      parsed["status"] !== undefined || parsed["detail"] !== undefined ||
      parsed["failureStage"] !== undefined || parsed["terminal"] !== undefined ||
      parsed["fallbackTrigger"] !== undefined ||
      !Array.isArray(parsed["globalRules"]) || !Array.isArray(parsed["crossRefs"]) ||
      !Array.isArray(parsed["ambiguities"]) || !Array.isArray(parsed["unverifiable"]) ||
      typeof parsed["modelOutput"] !== "object" || parsed["modelOutput"] === null ||
      Array.isArray(parsed["modelOutput"])
    ) return invalid(`${origin} successful-state envelope is malformed`);
    if (validatePassARouteReceiptForUnit(parsed["routeReceipt"], typedUsages, runId, origin) === null) {
      return invalid(`${origin} successful route receipt is not bound to this window`);
    }
    // Do not inspect the typed arrays or modelOutput here. Their meaning belongs exclusively
    // to the strict decoder; presence plus paid-unit coherence is enough to observe progress.
  }

  return invalid("the retained sequence contains no terminal failed primary window");
}

/**
 * Rebuild the completed Pass-A authority exclusively from its persisted paid units.
 * This path is read-only: missing, malformed, or conflicting unit authority is a named
 * invalid result and can never fall through to the model purchase path.
 */
export async function reconstructPassACompletedAuthority(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName = "document.docx",
): Promise<PassAAuthorityReconstruction> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const windows = splitWindows(
    doc.blocks,
    num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000),
    num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 100),
  );
  const requirements: RawRequirement[] = [];
  const crossRefs: CrossRef[] = [];
  const ambiguities: RawAmbiguity[] = [];
  const unverifiable: RawUnverifiable[] = [];
  const accountingCalls: CallUsage[] = [];
  const routeReceipts: PassARouteReceipt[] = [];
  const fallbackTriggers: GrokFallbackTrigger[] = [];
  const crossWindowLimitations: PassACrossWindowLimitation[] = [];
  const primaryGroundingLimitations: PassAPrimaryGroundingLimitationWire[] = [];
  let windowsLanded = 0;
  let invalidSynthesisState: PassASlice["synthesisState"] =
    windows.length > 1 ? "waiting-for-windows" : "not-required";
  let synthesisAttempts = 0;
  const invalid = (
    detail: string,
    failedUnit: PassResult["failedUnits"][number] | null = null,
  ): PassAAuthorityReconstruction => ({
    kind: "invalid",
    detail: `PASS_A_COMPLETED_ARTIFACT_INVALID: ${detail}. ` +
      "No unit was re-bought and the completed payload is not continuation authority.",
    accountingCalls,
    failedUnit,
    slice: {
      done: false,
      windowsTotal: windows.length,
      windowsLanded,
      windowsIssued: 0,
      windowsRemaining: Math.max(0, windows.length - windowsLanded),
      terminalFailure: true,
      synthesisState: invalidSynthesisState,
      synthesisAttempts,
      synthesisIssued: 0,
      deadlineHit: false,
    },
  });

  for (let index = 0; index < windows.length; index += 1) {
    const origin = windows.length === 1 ? "A" : `A-w${index + 1}`;
    const blockIds = windows[index]!.map((block) => block.blockId);
    const unit = await readWindow(env, runId, index + 1, windows[index]!, parserVersion, origin);
    if (unit === null) {
      const detail = `${origin} is missing or belongs to a stale partition policy`;
      return invalid(detail, { unit: origin, blockIds, detail });
    }
    accountingCalls.push(...unit.usages);
    if (unit.kind === "invalid") {
      windowsLanded = index + 1;
      return invalid(unit.detail, { unit: origin, blockIds, detail: unit.detail });
    }
    if (unit.kind === "failed") {
      windowsLanded = index + 1;
      const detail = `${origin} retains failed authority: ${unit.detail}`;
      return invalid(detail, { unit: origin, blockIds, detail: unit.detail });
    }
    windowsLanded = index + 1;
    requirements.push(...unit.globalRules);
    crossRefs.push(...unit.crossRefs);
    ambiguities.push(...unit.ambiguities);
    unverifiable.push(...unit.unverifiable);
    primaryGroundingLimitations.push(...unit.primaryGroundingLimitations);
    routeReceipts.push(unit.routeReceipt);
    if (unit.routeReceipt.trigger !== null) {
      fallbackTriggers.push(unit.routeReceipt.trigger);
      // A Gemini substitute preserves cross-family independence; only DeepSeek Flash reduces it.
      if (unit.routeReceipt.selected === "deepseek-v4-flash") {
        const detail = `${origin} used same-family Flash fallback`;
        return invalid(detail, { unit: origin, blockIds, detail });
      }
    }
  }

  let synthesisState: PassASlice["synthesisState"] = "not-required";
  if (windows.length > 1) {
    invalidSynthesisState = "failed";
    let context: PassASynthesisContext | null;
    try {
      context = await buildPassASynthesisContext(env, runId, doc, documentName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "synthesis context is unreadable";
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail });
    }
    if (context === null) {
      const detail = "multiwindow synthesis context is absent";
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail });
    }
    const synthesis = await readPassASynthesis(env, runId, context);
    if (synthesis === null) {
      const detail = "cross-window synthesis artifact is missing";
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail });
    }
    accountingCalls.push(...synthesis.usages);
    synthesisAttempts = synthesis.attempts;
    if (synthesis.kind === "invalid") {
      return invalid(synthesis.detail, { unit: "A-synthesis", blockIds: [], detail: synthesis.detail });
    }
    if (synthesis.kind === "failed") {
      const detail = `cross-window synthesis failed: ${synthesis.detail}`;
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail: synthesis.detail });
    }
    routeReceipts.push(synthesis.routeReceipt);
    if (synthesis.routeReceipt.trigger !== null) fallbackTriggers.push(synthesis.routeReceipt.trigger);
    if (synthesis.routeReceipt.trigger !== null && synthesis.routeReceipt.selected === "deepseek-v4-flash") {
      const detail = "cross-window synthesis used same-family Flash fallback";
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail });
    }
    try {
      applySynthesisAdditions(requirements, crossRefs, ambiguities, unverifiable, synthesis.additions);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "synthesis additions cannot be applied";
      return invalid(detail, { unit: "A-synthesis", blockIds: [], detail });
    }
    crossWindowLimitations.push(synthesisLimitation(context.coverage, synthesis.additions));
    synthesisState = "ok";
  }

  // Only DeepSeek Flash triggers reduce independence. Gemini triggers are cross-family.
  const hasFlashFallback = routeReceipts.some((receipt) => receipt.selected === "deepseek-v4-flash");
  if (hasFlashFallback) {
    return invalid("a primary window used same-family Flash fallback");
  }
  try {
    validatePassAPrimaryGroundingLimitations(primaryGroundingLimitations);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "primary grounding limitations are malformed");
  }
  const slice: PassASlice = {
    done: true,
    windowsTotal: windows.length,
    windowsLanded: windows.length,
    windowsIssued: 0,
    windowsRemaining: 0,
    terminalFailure: false,
    synthesisState,
    synthesisAttempts,
    synthesisIssued: 0,
    deadlineHit: false,
  };
  // Derive provider independence from route receipts
  const reconstructedIndependence: PassAProviderIndependence =
    fallbackTriggers.length === 0
      ? "independent"
      : routeReceipts.some((receipt) => receipt.selected === "gemini-2.5-flash")
        ? "independent-gemini-substitute"
        : "independent"; // All windows used Grok successfully (no DeepSeek Flash reached here)
  return {
    kind: "ok",
    value: {
      pass: "A",
      provider: "grok-primary/gemini-substitute/deepseek-flash-fallback",
      model: DEFAULT_GROK_MODEL,
      providerRouteIdentity: grokFlashRouteIdentity(env),
      providerIndependence: reconstructedIndependence,
      routeReceipts,
      fallbackTriggers,
      requirements,
      ambiguities,
      unverifiable,
      dispositions: [],
      constructs: [],
      failedUnits: [],
      calls: accountingCalls,
      crossRefs,
      crossWindowLimitations,
      primaryGroundingLimitations,
      slice,
      issuedCalls: [],
      accountingCalls,
    },
  };
}

function isCallUsage(value: unknown): value is CallUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Partial<CallUsage>;
  const finiteNonNegative = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  return (
    typeof row.eventId === "string" && row.eventId.startsWith("core-model-call/pass-a/") &&
    typeof row.callId === "string" && row.callId.length > 0 &&
    typeof row.role === "string" && row.role.length > 0 &&
    (row.provider === "grok" || row.provider === "deepseek" || row.provider === "gemini") &&
    typeof row.model === "string" && row.model.length > 0 &&
    (row.status === "ok" || row.status === "parse-failed" || row.status === "error") &&
    finiteNonNegative(row.inputTokens) && finiteNonNegative(row.outputTokens) &&
    finiteNonNegative(row.costUsd) && finiteNonNegative(row.latencyMs) &&
    Number.isSafeInteger(row.attempts) && (row.attempts ?? 0) >= 1 &&
    (row.usageSource === "provider-reported" || row.usageSource === "conservative-ceiling" ||
      row.usageSource === "unverified-model-rate-ceiling")
  );
}

function parseFallbackTrigger(value: unknown, usages: CallUsage[]): GrokFallbackTrigger | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Partial<GrokFallbackTrigger>;
  const eligible = new Set<ModelFailureKind>([
    "rate-limited", "insufficient-balance", "timeout-or-network", "provider-unavailable", "invalid-content",
  ]);
  if (
    row.kind !== GROK_FALLBACK_TRIGGER_VERSION || !row.failureKind || !eligible.has(row.failureKind) ||
    (row.httpStatus !== null && (!Number.isSafeInteger(row.httpStatus) || (row.httpStatus ?? 0) < 100)) ||
    row.grokModel !== DEFAULT_GROK_MODEL || typeof row.grokUsageEventId !== "string" ||
    typeof row.detail !== "string" || row.detail.length === 0
  ) return null;
  const bound = usages.find((usage) => usage.eventId === row.grokUsageEventId);
  if (
    !bound || bound.provider !== "grok" || bound.status !== "error" ||
    bound.model !== DEFAULT_GROK_MODEL ||
    (row.failureKind === "invalid-content" &&
      bound.usageSource === "unverified-model-rate-ceiling")
  ) return null;
  return row as GrokFallbackTrigger;
}

function parseRouteReceipt(value: unknown, usages: CallUsage[]): PassARouteReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Partial<PassARouteReceipt>;
  if (row.selected === "grok-4.6" && row.trigger === null) {
    return usages.some((usage) => usage.provider === "deepseek" || usage.provider === "gemini")
      ? null
      : { selected: row.selected, trigger: null };
  }
  if (row.selected === "gemini-2.5-flash") {
    const trigger = parseFallbackTrigger(row.trigger, usages);
    if (trigger === null || !usages.some((usage) => usage.provider === "gemini" && usage.model === "gemini-2.5-flash")) {
      return null;
    }
    return { selected: row.selected, trigger };
  }
  if (row.selected !== "deepseek-v4-flash") return null;
  const trigger = parseFallbackTrigger(row.trigger, usages);
  if (trigger === null || !usages.some((usage) => usage.provider === "deepseek" && usage.model === "deepseek-v4-flash")) {
    return null;
  }
  return { selected: row.selected, trigger };
}

type PassAFallbackChainState = "pending" | "provider-failed" | "semantic-failed" | "success";

/**
 * Prove the complete authorization chain behind a Flash leg.
 *
 * The Grok error authorizes Flash once and remains the sole Grok receipt for the unit. A
 * failed Flash purchase may be retried on the next durable issue, but every issue from the
 * trigger through the current/selected issue must carry exactly one receipt-2 Flash result.
 * This admits the writer-produced issue-1 Flash error -> issue-2 Flash success path without
 * admitting a trigger/selection splice, a skipped paid issue, or an extra Grok purchase.
 */
function validatePassAFallbackUsageChain(
  usages: CallUsage[],
  runId: string,
  unit: string,
  attempts: number,
  trigger: GrokFallbackTrigger,
  state: PassAFallbackChainState,
): string | null {
  const triggerMatches = usages.filter((usage) => usage.eventId === trigger.grokUsageEventId);
  if (triggerMatches.length !== 1) return "fallback trigger does not bind exactly one Grok receipt";
  const triggerUsage = triggerMatches[0]!;
  const triggerPosition = passAUsagePosition(triggerUsage, runId, unit);
  if (
    triggerPosition === null || triggerPosition.receipt !== 1 ||
    triggerUsage.provider !== "grok" || triggerUsage.model !== DEFAULT_GROK_MODEL ||
    triggerUsage.status !== "error"
  ) return "fallback trigger is not a bound Grok receipt-1 error";
  const grokUsages = usages.filter((usage) => usage.provider === "grok");
  if (grokUsages.length !== 1) return "fallback chain contains an extra Grok purchase";
  if (triggerPosition.issue > attempts) return "fallback trigger issue exceeds retained attempts";

  const flashRows = usages.flatMap((usage) => {
    if (usage.provider !== "deepseek") return [];
    const position = passAUsagePosition(usage, runId, unit);
    return position === null ? [] : [{ usage, position }];
  });
  if (state === "pending") {
    return attempts === triggerPosition.issue && flashRows.length === 0
      ? null
      : "pending fallback authority must contain only its trigger issue";
  }

  if (flashRows.some(({ position }) =>
    position.receipt !== 2 ||
    position.issue < triggerPosition.issue ||
    position.issue > attempts
  )) return "fallback chain contains a Flash receipt outside its authorized issue range";
  const expectedFlashIssues = attempts - triggerPosition.issue + 1;
  const completeFlashIssues =
    flashRows.length === expectedFlashIssues &&
    Array.from({ length: expectedFlashIssues }, (_, offset) => triggerPosition.issue + offset)
      .every((issue) => flashRows.filter((row) => row.position.issue === issue).length === 1);
  if (!completeFlashIssues) return "fallback chain has a missing or duplicate Flash issue";
  const selected = flashRows.find((row) => row.position.issue === attempts)!.usage;
  const prior = flashRows.filter((row) => row.position.issue < attempts).map((row) => row.usage);
  if (prior.some((usage) => usage.status !== "error")) {
    return "a prior Flash issue is not a provider error";
  }
  if (state === "success") {
    return selected.status === "ok" ? null : "selected Flash receipt is not the sole success";
  }
  if (state === "provider-failed") {
    return selected.status === "error" ? null : "latest provider-failed Flash receipt is not an error";
  }
  return selected.status === "parse-failed"
    ? null
    : "latest semantic-failed Flash receipt is not parse-failed";
}

function validatePassARouteReceiptForUnit(
  value: unknown,
  usages: CallUsage[],
  runId: string,
  unit: string,
): PassARouteReceipt | null {
  const receipt = parseRouteReceipt(value, usages);
  if (receipt === null) return null;
  const positions = usages.map((usage) => passAUsagePosition(usage, runId, unit));
  if (positions.some((position) => position === null)) return null;
  const okUsages = usages.filter((usage) => usage.status === "ok");
  if (okUsages.length !== 1) return null;
  const selected = okUsages[0]!;
  if (receipt.selected === "grok-4.6") {
    return selected.provider === "grok" && selected.model === DEFAULT_GROK_MODEL &&
        !usages.some((usage) => usage.provider === "deepseek" || usage.provider === "gemini")
      ? receipt
      : null;
  }
  if (receipt.selected === "gemini-2.5-flash") {
    // Gemini substitute: the selected usage must be gemini, receipt position 2, with a trigger
    if (
      selected.provider !== "gemini" || selected.model !== "gemini-2.5-flash" ||
      receipt.trigger === null
    ) return null;
    const triggerUsage = usages.find((usage) => usage.eventId === receipt.trigger!.grokUsageEventId);
    if (!triggerUsage || triggerUsage.status !== "error") return null;
    return receipt;
  }
  const selectedPosition = passAUsagePosition(selected, runId, unit);
  if (
    selected.provider !== "deepseek" || selected.model !== "deepseek-v4-flash" ||
    receipt.trigger === null
  ) return null;
  const triggerUsage = usages.find((usage) => usage.eventId === receipt.trigger!.grokUsageEventId);
  const triggerPosition = triggerUsage ? passAUsagePosition(triggerUsage, runId, unit) : null;
  if (
    !triggerUsage || triggerUsage.status !== "error" || triggerPosition?.receipt !== 1 ||
    selectedPosition === null || selectedPosition.issue === undefined ||
    validatePassAFallbackUsageChain(
      usages, runId, unit, selectedPosition.issue, receipt.trigger, "success",
    ) !== null
  ) return null;
  return receipt;
}

/** Strict completed-pass decoder used before reuse or consolidation. */
export function validatePassAProviderState(value: unknown): PassAProviderIndependence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const calls = Array.isArray(row["calls"]) ? row["calls"] : null;
  const rawTriggers = Array.isArray(row["fallbackTriggers"]) ? row["fallbackTriggers"] : null;
  const rawReceipts = Array.isArray(row["routeReceipts"]) ? row["routeReceipts"] : null;
  if (calls === null || !calls.every(isCallUsage) || rawTriggers === null || rawReceipts === null) return null;
  const usages = calls as CallUsage[];
  const triggers = rawTriggers.map((trigger) => parseFallbackTrigger(trigger, usages));
  if (triggers.some((trigger) => trigger === null)) return null;
  const triggerIds = triggers.map((trigger) => trigger!.grokUsageEventId);
  if (new Set(triggerIds).size !== triggerIds.length) return null;
  const parsedReceipts = rawReceipts.map((receipt) => parseRouteReceipt(receipt, usages));
  if (parsedReceipts.some((receipt) => receipt === null)) return null;
  // Derive independence from the trigger and receipt combination:
  // - No triggers: independent
  // - Triggers with Gemini receipts only: independent-gemini-substitute (cross-family)
  // - Triggers with DeepSeek Flash receipts: reduced-same-provider-fallback
  let derived: PassAProviderIndependence;
  if (triggers.length === 0) {
    derived = "independent";
  } else {
    const hasDeepseekFlashReceipt = parsedReceipts.some(
      (receipt) => receipt !== null && receipt.selected === "deepseek-v4-flash",
    );
    derived = hasDeepseekFlashReceipt
      ? "reduced-same-provider-fallback"
      : "independent-gemini-substitute";
  }
  return row["providerIndependence"] === derived ? derived : null;
}

function settlementUsage(
  runId: string,
  unitId: string,
  issue: number,
  receipt: number,
  usage: CallUsage,
): CallUsage {
  return {
    ...usage,
    eventId: `core-model-call/pass-a/${runId}/${unitId}/issue-${issue}/receipt-${receipt}`,
  };
}

/**
 * Split on block boundaries so a window never cuts a table cell in half. Characters and
 * blocks are independent ceilings: a table-heavy document can pack thousands of short cells
 * below the character limit while still producing an oversized prompt and response. One
 * indivisible block may exceed the character ceiling, but it always remains intact.
 */
function splitWindows(blocks: SourceBlock[], maxChars: number, maxBlocks: number): SourceBlock[][] {
  const windows: SourceBlock[][] = [];
  let current: SourceBlock[] = [];
  let size = 0;
  const blockLimit = Math.max(1, Math.floor(maxBlocks));
  for (const b of blocks) {
    const cost = b.text.length + b.blockId.length + 16;
    const exceedsCharacterLimit = size + cost > maxChars;
    const reachesBlockLimit = current.length >= blockLimit;
    if ((exceedsCharacterLimit || reachesBlockLimit) && current.length > 0) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(b);
    size += cost;
  }
  if (current.length > 0) windows.push(current);
  return windows.length > 0 ? windows : [[]];
}
