/**
 * PASS B — the block-by-block pass. DEEPSEEK.
 *
 * The document is walked in CHUNKS of source blocks, each chunk carrying the document's
 * global-instruction blocks as read-only context (the shape that worked in
 * `pipeline/runs/t1-easy/chunks/`), and each chunk's result is PERSISTED THE MOMENT IT
 * ARRIVES. Two earlier agents died holding whole responses in memory; a chunk that is on
 * disk cannot be lost by whatever happens to the next one, and a resumed run re-reads what
 * is already there instead of paying for it twice.
 *
 * Every chunk owes three things back: obligations, a disposition for EVERY block id it was
 * given, and a verdict for every construct class. A chunk that fails is a FAILED UNIT with
 * its block ids named — never an empty chunk, because an empty chunk is indistinguishable
 * from a chunk that found nothing.
 *
 * =====================================================================================
 * WHY THIS PASS IS A *SLICE*, AND NOT ONE LONG RUN
 * =====================================================================================
 *
 * MEASURED, on real Cloudflare Workflow history: the whole fan-out used to run inside ONE
 * Workflow step whose timeout was 8 minutes (480 s). A reference document produced ~23
 * chunks; at EXTRACT_CHUNK_CONCURRENCY=5 that is 5 sequential rounds, and a round costs the
 * SLOWEST of its five calls (DeepSeek median 127.5 s, p90 206 s, max 285 s) — call it
 * ~1000 s — plus up to EXTRACT_SWEEP_MAX_CALLS more calls run SERIALLY at the end, inside
 * the same step. The per-call ceiling (LLM_TIMEOUT_MS, 300 s) could never fire, because no
 * single call was slow: the STEP died instead. Two real runs of the same document: one
 * scraped through on attempt 3 of 3, the other burned all three attempts and errored with
 * three durably-recorded 480000 ms timeouts. A coin flip, and a larger questionnaire makes
 * it worse, not better.
 *
 * Raising the number only moves the cliff — the work grows with the document and the
 * timeout does not. So the fan-out is now sliced:
 *
 *   1. A SLICE IS GIVEN A WALL-CLOCK BUDGET, and it stops ISSUING new calls when the budget
 *      is gone. It never abandons a call it already issued. The Workflow gives each slice
 *      its own step, and `passBStepTimeoutMs` sets that step's timeout to the slice budget
 *      PLUS one whole PURCHASE PLUS slack — so the step axe can never fall on a call that
 *      is still in flight. THAT is what deletes the duplicate spend: a killed in-flight call
 *      was billed and never persisted, so the retry bought it again.
 *
 *      A LOGICAL UNIT IS NOT ONE ATTEMPT. Normal Pass B is one DeepSeek Pro purchase with a
 *      bounded number of transport attempts. Every attempt gets its own AbortSignal timeout and
 *      every purchase keeps its own usage receipt. `passBCallCeilingMs` covers that bounded
 *      attempt plan before a Workflow step may time out; it does not imply a cross-model fallback.
 *
 *   2. A SLICE ALWAYS MAKES PROGRESS. Even at a budget of zero it issues at least one call,
 *      so a wave loop over slices cannot livelock, and the number of waves a document needs
 *      is bounded by its chunk count.
 *
 *   3. WORK THAT LANDED IS NEVER RE-BOUGHT. Chunk artifacts are the unit of resume, and the
 *      sweep's calls are now artifacts too (they were persisted but never read back, so
 *      every retry re-bought all three). A chunk that FAILED is re-issued at most
 *      EXTRACT_CHUNK_MAX_ISSUES times ACROSS THE WHOLE RUN — the artifact carries its own
 *      attempt count — so a chunk the provider will never answer costs a bounded amount
 *      instead of one call per wave per recovery instance.
 */

import type { Env } from "../types/env";
import { num } from "../types/env";
import {
  DEFAULT_DEEPSEEK_FALLBACK_MODEL,
  deepseekPassBAttemptCeiling,
  deepseekPassBIdentity,
  deepseekPassBJson,
  deepseekPassBRequestShape,
} from "../llm/deepseek";
import { chatRequestBodyText, keyFor, MissingCredential, ModelCallError } from "../llm/chat";
import {
  EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
  extractionWireFailureDetail,
  extractionWirePolicy,
  extractionWirePreSerializationFailureDetail,
  preflightExtractionRequestBodies,
} from "../llm/extraction-wire";
import { PROMPT_VERSION_B, SYSTEM_B, userMessageB, userMessageSweep } from "./prompts";
import { DOCX_BLOCKS_VERSION } from "./docx-blocks";
import { buildBoundedSourceBlocksJsonl } from "./bounded-source-block-jsonl";
import type { CallUsage, ParsedDocument, PassResult, RawRequirement, SourceBlock } from "./types";
import { sha256Hex } from "../store/hash";
import {
  decodePassBOutput,
  PASS_B_DECODER_VERSION,
  PassBOutputInvalid,
  salvagePassBOutput,
} from "./pass-b-decode";
import { k } from "../keys";
import {
  publicExtractionFailureDetail,
  sourceContextForUnit,
  type DocumentReadingUnitStartObserver,
} from "../observability/document-reading";

export { decodePassBOutput, PASS_B_DECODER_VERSION, PassBOutputInvalid, salvagePassBOutput };

export const PASS_B_VERSION = PROMPT_VERSION_B;

/**
 * When the fraction of terminally-failed chunks exceeds this threshold the pass
 * stops issuing new chunks and seals with PASS_B_FAILURE_RATE_EXCEEDED.
 *
 * Rationale (from the production incident analysis): the run that prompted this
 * fix measured 3/67 = 4.5% terminal failures from prompt/validator mismatch.
 * That was systematic but low enough that salvage or a retry with echo would
 * recover most of them. Past 20% the read is suspect — the model is consistently
 * producing output the decoder cannot use, and each additional purchase is more
 * likely to waste money than to land usable obligations.
 */
export const PASS_B_TERMINAL_FAILURE_RATE_THRESHOLD = 0.2;

/** Where each chunk lands the instant it returns. */
const chunkKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}.json`);
const chunkWireCeilingKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}-wire-ceiling.json`);

/** Where each sweep call lands. Read back on resume — it used to be write-only. */
const sweepKey = (runId: string, i: number) =>
  k("runs", runId, "extraction", "pass-b", `sweep${String(i + 1).padStart(2, "0")}.json`);
const sweepWireCeilingKey = (runId: string, i: number) =>
  k("runs", runId, "extraction", "pass-b", `sweep${String(i + 1).padStart(2, "0")}-wire-ceiling.json`);

const chunkHistoryKey = (runId: string, n: number, digest: string) =>
  k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}-history-${digest}.json`);
const chunkCasConflictKey = (runId: string, n: number, digest: string) =>
  k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}-cas-conflict-${digest}.json`);
const sweepHistoryKey = (runId: string, i: number, digest: string) =>
  k("runs", runId, "extraction", "pass-b", `sweep${String(i + 1).padStart(2, "0")}-history-${digest}.json`);
const sweepCasConflictKey = (runId: string, i: number, digest: string) =>
  k("runs", runId, "extraction", "pass-b", `sweep${String(i + 1).padStart(2, "0")}-cas-conflict-${digest}.json`);

export interface Chunk {
  id: string;
  n: number;
  blocks: SourceBlock[];
}

/**
 * What ONE slice of pass B did, and what is left. This is the value the Workflow's wave
 * loop steers on, so every field here is a fact about work, never a summary of intent.
 */
export interface PassBSlice {
  /** Every chunk AND every sweep call this document owes is accounted for. */
  done: boolean;
  chunksTotal: number;
  /** Chunks with a usable or terminally-failed artifact after this slice. */
  chunksLanded: number;
  /** NEW model calls this slice issued for chunks. Reused chunks are not calls. */
  chunksIssued: number;
  /** Chunks still owed a call — deferred to the next slice because the budget ran out. */
  chunksRemaining: number;
  sweepCallsIssued: number;
  sweepRemaining: number;
  /** A retained terminal chunk/sweep failure forbids a whole-pass payload. */
  terminalFailure: boolean;
  /** The slice stopped issuing because its wall-clock budget was spent. */
  deadlineHit: boolean;
}

export interface PassBSliceOptions {
  /**
   * Wall clock this slice may spend ISSUING new model calls. A slice never abandons a call
   * it already issued, so the caller's step timeout must exceed this by at least one whole
   * PURCHASE — see `passBStepTimeoutMs`, which is the only place that arithmetic lives.
   *
   * Omitted (or Infinity) means "no deadline", which is the pre-slicing behaviour and what
   * the dev extraction endpoint — a plain request, with no Workflow step around it — wants.
   */
  budgetMs?: number;
  /** Injectable only so a test can be deterministic; production always reads the clock. */
  now?: () => number;
}

/**
 * Heartbeats are observability only. A callback outage after a paid answer was durably
 * persisted cannot turn that successful unit into a failed artifact or authorize a rebuy.
 */
async function reportProgress(
  callback: ((msg: string) => Promise<void>) | undefined,
  message: string,
): Promise<void> {
  try {
    await callback?.(message);
  } catch {
    // Best effort by contract: durable unit evidence, not heartbeat delivery, is authority.
  }
}

/** A per-obligation limitation from salvage: closed machine reason, never model text. */
export interface PassBLimitation {
  unit: string;
  rowIndex: number;
  rowKind: "obligation" | "ambiguity" | "unverifiable";
  reason: "obligation-malformed" | "root-malformed";
}

export type PassBResult = PassResult & {
  /** Exact same-provider model plan that every persisted unit must match. */
  providerPlanIdentity: string;
  slice: PassBSlice;
  /**
   * The calls this slice ACTUALLY BOUGHT, as opposed to `calls`, which also carries the
   * zero-cost telemetry of every chunk reused from storage. The run's usage ledger must be
   * charged from THIS list: `modelCalls.used` counts calls, not rows, and re-counting a
   * reused chunk once per wave would trip CAP_MODEL_CALLS on phantom spend.
   */
  issuedCalls: CallUsage[];
  /** All persisted receipts offered to the idempotent core settlement CAS. */
  accountingCalls: CallUsage[];
  /** Obligations/items dropped as named limitations during per-item salvage. */
  limitations: PassBLimitation[];
  terminalReasonCode?: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED | string;
  credentialRefusal?: { reason: "NO_CREDENTIAL"; binding: string; provider: "deepseek" };
};

export type PassBCompletedAuthority = Omit<
  PassBResult,
  "issuedCalls" | "accountingCalls"
> & {
  /** Canonical raw receipts reconstructed from immutable per-unit authority. */
  calls: CallUsage[];
  issuedCalls: [];
  accountingCalls: CallUsage[];
};

export type PassBAuthorityReconstruction =
  | {
      kind: "ok";
      value: PassBCompletedAuthority;
      /** Exact completion bytes the stage must write immutably. */
      body: string;
      /** SHA-256 of body, bound into continuation/consolidation state. */
      hash: string;
    }
  | {
      kind: "invalid";
      detail: string;
      accountingCalls: CallUsage[];
      slice: PassBSlice;
      /** Exact durable unit when reconstruction can identify one. */
      failedUnit: PassResult["failedUnits"][number] | null;
    };

export const PASS_B_COMPLETION_KEYS = [
  "parserVersion", "promptVersion", "pass", "provider", "model", "providerPlanIdentity",
  "requirements", "ambiguities", "unverifiable", "dispositions", "constructs", "failedUnits",
  "limitations", "calls", "slice", "issuedCalls", "accountingCalls",
] as const;

/** One shared closed projection for stage reads and exact reconstruction comparison. */
export function passBCompletionProjection(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PASS_B_COMPLETION_KEYS) out[key] = value[key];
  return out;
}

export function passBCompletionShapeClosed(value: Record<string, unknown>): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...PASS_B_COMPLETION_KEYS].sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    [
      "requirements", "ambiguities", "unverifiable", "dispositions", "constructs",
      "failedUnits", "limitations", "calls", "issuedCalls", "accountingCalls",
    ].every((key) => Array.isArray(value[key]));
}

/** Slack over and above the budget and one whole purchase: R2 I/O, parsing, scheduling. */
export const PASS_B_STEP_SLACK_MS = 60_000;

/** Wall clock ONE pass-B slice may spend issuing. Configuration, not a constant. */
export function passBWaveBudgetMs(env: Env): number {
  return Math.max(0, num(env.EXTRACT_WAVE_BUDGET_MS, 600_000));
}

/**
 * THE WORST-CASE WALL CLOCK OF ONE LOGICAL UNIT — not of one HTTP attempt.
 *
 * Pass B's one DeepSeek Pro purchase has bounded transport attempts. The pass-B client owns
 * that clamp, and this timeout derives from the same plan so the step axe cannot kill a paid
 * request before its artifact and usage receipt are persisted.
 */
export function passBCallCeilingMs(env: Env): number {
  return deepseekPassBAttemptCeiling(env) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));
}

/**
 * THE INVARIANT THAT DELETES THE CLIFF, in one expression.
 *
 * A slice stops ISSUING at its budget but lets an in-flight purchase run to its own ceiling.
 * So the step around it must be allowed to live for the budget PLUS a whole purchase PLUS
 * slack. Anything less and the step axe can fall on a call that was already paid for and not
 * yet persisted — which is precisely the duplicate spend this design removes. Derived from
 * the same knobs the slice AND THE TRANSPORT read, so no config change can silently
 * reintroduce the 480 s ceiling.
 */
export function passBStepTimeoutMs(env: Env): number {
  return passBWaveBudgetMs(env) + passBCallCeilingMs(env) + PASS_B_STEP_SLACK_MS;
}

/** Bounded storage-only attempts. No branch below is allowed to repeat a model purchase. */
export const PASS_B_PAID_ARTIFACT_PERSIST_ATTEMPTS = 2;

interface PassBUnitStorageAuthority {
  /** Exact R2 version decoded by the strict canonical reader before a replacement purchase. */
  etag: string;
  /** Exact predecessor bytes; semantic equality is not append-only retention. */
  bodyText: string;
}

interface PassBPaidArtifactAddress {
  canonicalKey: string;
  historyKey: (digest: string) => string;
  conflictKey: (digest: string) => string;
}

type PassBPaidArtifactPersistence =
  | { ok: true }
  | { ok: false; detail: string; conflictKey: string };

const storageDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Create one content-addressed append-only object and prove its exact bytes after every
 * ambiguous/null result. Equal bytes are idempotent success; different bytes at the same
 * digest key are corruption (or a SHA-256 collision), never overwrite authority.
 */
async function persistPassBAppendOnlyExact(
  env: Env,
  key: string,
  bodyText: string,
  unitId: string,
  purpose: "history" | "cas-conflict",
): Promise<void> {
  let lastProblem = "storage did not return a result";
  for (
    let attempt = 1;
    attempt <= PASS_B_PAID_ARTIFACT_PERSIST_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const written = await env.EVIDENCE.put(key, bodyText, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (written !== null) return;
      lastProblem = "conditional create found an occupied append-only key";
    } catch (error) {
      lastProblem = `conditional create failed with ${storageDetail(error)}`;
    }

    let retained: R2ObjectBody | null;
    try {
      retained = await env.EVIDENCE.get(key);
    } catch (error) {
      lastProblem += `; exact reread failed with ${storageDetail(error)}`;
      continue;
    }
    if (retained === null) {
      lastProblem += "; exact reread found no object";
      continue;
    }
    let retainedText: string;
    try {
      retainedText = await retained.text();
    } catch (error) {
      lastProblem += `; retained bytes could not be read: ${storageDetail(error)}`;
      continue;
    }
    if (retainedText === bodyText) return;
    throw new Error(
      `PASS_B_${purpose === "history" ? "HISTORY" : "CAS_CONFLICT"}_ARTIFACT_IMMUTABLE: ` +
        `${unitId} append-only key ${key} contains different bytes`,
    );
  }
  throw new Error(
    `PASS_B_${purpose === "history" ? "HISTORY" : "CAS_CONFLICT"}_ARTIFACT_PERSISTENCE_FAILED: ` +
      `${unitId}: ${lastProblem}`,
  );
}

/**
 * Persist one already-paid Pass-B unit without overwriting canonical bytes.
 *
 * A strict-read predecessor is archived verbatim before its exact etag can be replaced.
 * Absence permits only conditional creation. Every null/throw is resolved by an exact
 * canonical reread. If another writer won, the losing paid bytes move to their immutable
 * content-addressed conflict key and this unit terminalizes with no semantic/coverage credit.
 */
async function persistPassBPaidUnitArtifact(
  env: Env,
  unitId: string,
  address: PassBPaidArtifactAddress,
  predecessor: PassBUnitStorageAuthority | null,
  bodyText: string,
): Promise<PassBPaidArtifactPersistence> {
  const targetDigest = await sha256Hex(bodyText);
  const conflictKey = address.conflictKey(targetDigest);
  const preserveConflict = async (): Promise<void> =>
    persistPassBAppendOnlyExact(env, conflictKey, bodyText, unitId, "cas-conflict");

  if (predecessor !== null) {
    const predecessorDigest = await sha256Hex(predecessor.bodyText);
    try {
      await persistPassBAppendOnlyExact(
        env,
        address.historyKey(predecessorDigest),
        predecessor.bodyText,
        unitId,
        "history",
      );
    } catch (error) {
      await preserveConflict();
      return {
        ok: false,
        conflictKey,
        detail:
          `PASS_B_UNIT_HISTORY_PERSISTENCE_FAILED: ${unitId}: ${storageDetail(error)}. ` +
          `The paid target is retained at ${conflictKey}; canonical authority was not changed.`,
      };
    }
  }

  let expected = predecessor;
  let lastProblem = "canonical storage did not return a result";
  for (
    let attempt = 1;
    attempt <= PASS_B_PAID_ARTIFACT_PERSIST_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const written = await env.EVIDENCE.put(address.canonicalKey, bodyText, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: expected === null
          ? { etagDoesNotMatch: "*" }
          : { etagMatches: expected.etag },
      });
      if (written !== null) return { ok: true };
      lastProblem = expected === null
        ? "conditional create found an occupied canonical key"
        : "conditional replacement no longer matched the strict-read predecessor";
    } catch (error) {
      lastProblem = `conditional canonical write failed with ${storageDetail(error)}`;
    }

    let retained: R2ObjectBody | null;
    try {
      retained = await env.EVIDENCE.get(address.canonicalKey);
    } catch (error) {
      lastProblem += `; exact canonical reread failed with ${storageDetail(error)}`;
      continue;
    }
    if (retained === null) {
      if (expected !== null) {
        await preserveConflict();
        return {
          ok: false,
          conflictKey,
          detail:
            `PASS_B_UNIT_CANONICAL_AUTHORITY_LOST: ${unitId}: the strict-read predecessor ` +
            `disappeared before replacement. The paid target is retained at ${conflictKey}; ` +
            `the canonical key was not recreated.`,
        };
      }
      lastProblem += "; exact canonical reread found no object";
      continue;
    }

    let retainedText: string;
    try {
      retainedText = await retained.text();
    } catch (error) {
      lastProblem += `; canonical bytes could not be read: ${storageDetail(error)}`;
      continue;
    }
    if (retainedText === bodyText) return { ok: true };
    if (expected !== null && retainedText === expected.bodyText) {
      // A before-commit transport failure left the exact predecessor in place. The next
      // bounded retry is tied to the exact version just reread, never to a stale etag.
      expected = { etag: retained.etag, bodyText: retainedText };
      lastProblem += "; exact predecessor remains current";
      continue;
    }

    await preserveConflict();
    return {
      ok: false,
      conflictKey,
      detail:
        `PASS_B_UNIT_CANONICAL_CAS_CONFLICT: ${unitId}: another exact canonical artifact won. ` +
        `The winner was not overwritten; the losing paid target is retained at ${conflictKey}.`,
    };
  }

  await preserveConflict();
  return {
    ok: false,
    conflictKey,
    detail:
      `PASS_B_UNIT_CANONICAL_PERSISTENCE_UNRESOLVED: ${unitId}: ${lastProblem}. ` +
      `The losing paid target is retained at ${conflictKey}; canonical authority was not overwritten.`,
  };
}

export async function runPassB(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  onProgress?: (msg: string) => Promise<void>,
  options?: PassBSliceOptions,
  onUnitStart?: DocumentReadingUnitStartObserver,
): Promise<PassBResult> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  // Compute once before reading or buying anything. Stored units from another model
  // plan are not answers to this run, even when their block ids happen to match.
  const providerPlanIdentity = deepseekPassBIdentity(env);
  const chunks = chunkBlocks(doc.blocks, num(env.EXTRACT_CHUNK_CHARS, 5_000), num(env.EXTRACT_CHUNK_MAX_BLOCKS, 45));
  const contextBlocks = globalContextBlocks(doc.blocks, num(env.EXTRACT_CONTEXT_CHARS, 4_000));
  const contextIds = new Set(contextBlocks.map((b) => b.blockId));
  const wireMaxBytes = extractionWirePolicy(env).maxInputBytes;
  const boundedContextJsonl = buildBoundedSourceBlocksJsonl(contextBlocks, wireMaxBytes);
  const evidenceBlocksFor = (owned: readonly SourceBlock[], contextIncluded: boolean): SourceBlock[] => {
    if (!contextIncluded) return [...owned];
    const byId = new Map<string, SourceBlock>();
    for (const block of [...owned, ...contextBlocks]) byId.set(block.blockId, block);
    return [...byId.values()];
  };
  const chunkRequestFor = (chunk: Chunk, priorFailureDetail?: string) => {
    const blockIds = chunk.blocks.map((block) => block.blockId);
    const overlapsContext = blockIds.some((id) => contextIds.has(id));
    const includesContext = !overlapsContext && contextBlocks.length > 0;
    const evidenceBlocks = evidenceBlocksFor(chunk.blocks, includesContext);
    const ownedJsonl = buildBoundedSourceBlocksJsonl(chunk.blocks, wireMaxBytes);
    if (!ownedJsonl.ok) {
      return {
        ok: false as const,
        blockIds,
        evidenceBlocks,
        detail: extractionWirePreSerializationFailureDetail(
          chunk.id, blockIds.length, ownedJsonl, "EXTRACT_MODEL_INPUT_MAX_BYTES",
        ),
      };
    }
    if (includesContext && !boundedContextJsonl.ok) {
      return {
        ok: false as const,
        blockIds,
        evidenceBlocks,
        detail: extractionWirePreSerializationFailureDetail(
          chunk.id, blockIds.length, boundedContextJsonl, "EXTRACT_MODEL_INPUT_MAX_BYTES",
        ),
      };
    }
    const context = includesContext && boundedContextJsonl.ok ? boundedContextJsonl.text : null;
    let userText = userMessageB(
      documentName,
      chunk.id,
      ownedJsonl.text,
      context,
      blockIds,
    );
    // B2: echo the validator error on retry so the model can correct its output.
    if (priorFailureDetail) {
      const bounded = priorFailureDetail.slice(0, 400);
      userText += `\n\nPREVIOUS ATTEMPT REJECTED\nYour previous answer for this chunk was rejected by the output validator with: ${bounded}\nEmit the corrected JSON object; change nothing that was not named.`;
    }
    const optionsForCall = {
      system: SYSTEM_B,
      user: userText,
      maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
      role: `extract-pass-b-${chunk.id}`,
      callId: `call_b_${chunk.n}`,
      maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
    };
    return { ok: true as const, blockIds, evidenceBlocks, optionsForCall };
  };
  const requirements: RawRequirement[] = [];
  const ambiguities: PassResult["ambiguities"] = [];
  const unverifiable: PassResult["unverifiable"] = [];
  const dispositions: PassResult["dispositions"] = [];
  const constructs: PassResult["constructs"] = [];
  const failedUnits: PassResult["failedUnits"] = [];
  const limitations: PassBLimitation[] = [];
  const calls: CallUsage[] = [];
  const issuedCalls: CallUsage[] = [];
  const accountingCalls: CallUsage[] = [];
  let terminalSemanticFailures = 0;
  let terminalProviderFailures = 0;
  let terminalReasonCode: typeof EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED | string | undefined;
  let credentialRefusal: PassBResult["credentialRefusal"];
  let deepseekPurchaseEnv: Env | null = null;
  const resolveDeepseekPurchaseEnv = async (): Promise<Env> => {
    if (deepseekPurchaseEnv !== null) return deepseekPurchaseEnv;
    const deepseekKey = await keyFor(env, "deepseek");
    deepseekPurchaseEnv = { ...env, DEEPSEEK_API_KEY: deepseekKey };
    return deepseekPurchaseEnv;
  };
  const persistZeroReceiptWireFailure = async (input: {
    key: string;
    idField: "chunkId" | "sweepId";
    unitId: string;
    blockIds: string[];
    evidenceBlockIds: string[];
    detail: string;
  }): Promise<void> => {
    const bodyText = JSON.stringify(
      {
        [input.idField]: input.unitId,
        blockIds: input.blockIds,
        evidenceBlockIds: input.evidenceBlockIds,
        parserVersion,
        promptVersion: PROMPT_VERSION_B,
        providerPlanIdentity,
        decoderIdentity: PASS_B_DECODER_VERSION,
        status: "failed",
        attempts: 0,
        usages: [],
        failureStage: "wire-ceiling",
        terminal: true,
        detail: input.detail,
      },
      null,
      2,
    );
    const written = await env.EVIDENCE.put(input.key, bodyText, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written !== null) return;
    const retained = await env.EVIDENCE.get(input.key);
    if (!retained || await retained.text() !== bodyText) {
      throw new Error(
        `PASS_B_WIRE_CEILING_ARTIFACT_IMMUTABLE: ${input.unitId} exact key is already occupied ` +
          `by different bytes; it was not overwritten and no provider request was issued`,
      );
    }
  };

  // B2: PRE-SCAN for prior semantic failures so the preflight includes the echo.
  // This is a lightweight R2 read pass that gathers only the failure details needed to
  // build the retry request bodies with the echoed validator error.
  const maxIssuesForPrescan = Math.max(1, num(env.EXTRACT_CHUNK_MAX_ISSUES, 2));
  const priorFailureDetailByChunk = new Map<number, string>();
  for (const chunk of chunks) {
    const includesContext = !chunk.blocks.some((b) => contextIds.has(b.blockId)) && contextBlocks.length > 0;
    const read = await readChunkWithAuthority(
      env, runId, chunk.n, chunk.blocks, evidenceBlocksFor(chunk.blocks, includesContext), parserVersion,
    );
    if (
      read.artifact?.kind === "failed" &&
      !read.artifact.terminal &&
      read.artifact.attempts < maxIssuesForPrescan &&
      read.artifact.detail
    ) {
      priorFailureDetailByChunk.set(chunk.n, read.artifact.detail);
    }
  }

  // EXTRACTION_WIRE_PREFLIGHT_BEFORE_CHUNK_FANOUT: every canonical chunk body is measured
  // before the concurrent queue exists. One later oversized/escaped row therefore prevents
  // all new chunk purchases in this wave instead of being found after earlier workers spend.
  // The pre-scan above populated priorFailureDetailByChunk so retried chunks include
  // the echoed validator error in their preflighted bytes — the same bytes the hash pins.
  const chunkWireChecks = new Map<number,
    | { ok: true; requestHash: string }
    | { ok: false; detail: string }
  >();
  for (const chunk of chunks) {
    const request = chunkRequestFor(chunk, priorFailureDetailByChunk.get(chunk.n));
    if (!request.ok) {
      chunkWireChecks.set(chunk.n, { ok: false, detail: request.detail });
      continue;
    }
    const bodyText = chatRequestBodyText(deepseekPassBRequestShape(env), request.optionsForCall);
    const check = preflightExtractionRequestBodies(env, [{
      route: "deepseek-v4-pro",
      bodyText,
    }]);
    chunkWireChecks.set(
      chunk.n,
      check.ok
        ? { ok: true, requestHash: `sha256:${await sha256Hex(bodyText)}` }
        : {
            ok: false,
            detail: extractionWireFailureDetail(chunk.id, request.blockIds.length, check),
          },
    );
  }

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
  let terminalFailure = false;
  let failureRateExceeded = false;
  /** Paid targets preserved only as conflict evidence receive no landed/coverage credit. */
  let persistenceConflictFailures = 0;
  const mayIssue = (): boolean => {
    // Infrastructure failures (persistence conflict, wire ceiling) stop immediately.
    if (persistenceConflictFailures > 0) return false;
    if (terminalReasonCode === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED) return false;
    if (failureRateExceeded) return false;
    // All terminal failures (semantic + provider) use the 20% guardrail: stop only when
    // terminal failures exceed 20% of the total chunk count. Below that, continue — each purchase
    // is persisted and reusable on resume, and the existing ledger sweep may claim the
    // dead chunks' blocks. // mutation-anchor: failure-rate-guardrail
    if ((terminalSemanticFailures + terminalProviderFailures) > Math.ceil(chunks.length * PASS_B_TERMINAL_FAILURE_RATE_THRESHOLD)) {
      failureRateExceeded = true;
      terminalReasonCode = "PASS_B_FAILURE_RATE_EXCEEDED";
      return false;
    }
    if (issued === 0) return true;
    if (now() < deadlineAt) return true;
    deadlineHit = true;
    return false;
  };

  const maxIssues = Math.max(1, num(env.EXTRACT_CHUNK_MAX_ISSUES, 2));

  const unresolvedFor = (blockIds: string[], reason: string): void => {
    for (const id of blockIds) dispositions.push({ blockId: id, disposition: "unresolved", reason });
  };

  // -------------------------------------------------------------------------
  // PHASE 1 — RECLAIM. Free: R2 reads only, never metered by the deadline.
  //
  // A chunk already on disk is a chunk already paid for. Re-running an extraction after a
  // crash, a Workflow step retry, a wave boundary or a dev-server restart must not buy the
  // same answer twice — and because each chunk names the blocks it owns, a reused chunk is
  // exactly as accountable as a fresh one.
  // -------------------------------------------------------------------------
  const todo: Chunk[] = [];
  const priorAttemptsByChunk = new Map<number, number>();
  const priorUsagesByChunk = new Map<number, CallUsage[]>();
  const priorAuthorityByChunk = new Map<number, PassBUnitStorageAuthority | null>();
  let landed = 0;
  for (const chunk of chunks) {
    const blockIds = chunk.blocks.map((b) => b.blockId);
    if (onUnitStart) {
      await onUnitStart({
        stage: "secondary-chunks",
        unit: {
          kind: "chunk",
          name: chunk.id,
          ordinal: chunk.n,
          total: chunks.length,
          sourceContext: sourceContextForUnit(doc.blocks, blockIds),
        },
        primary: null,
        secondary: {
          total: chunks.length,
          landed,
          remaining: chunks.length - landed,
          sweepRemaining: null,
        },
      });
    }
    const includesContext = !blockIds.some((id) => contextIds.has(id)) && contextBlocks.length > 0;
    const read = await readChunkWithAuthority(
      env, runId, chunk.n, chunk.blocks, evidenceBlocksFor(chunk.blocks, includesContext), parserVersion,
    );
    const existing = read.artifact;

    if (existing === null) {
      priorAuthorityByChunk.set(chunk.n, read.predecessor);
      todo.push(chunk);
      continue;
    }

    if (existing.kind === "failed") {
      accountingCalls.push(...existing.usages);
      for (const usage of existing.usages) {
        calls.push({ ...usage, detail: "reused: prior failed chunk purchase", costUsd: 0 });
      }
      // A FAILED CHUNK IS RE-ISSUED A BOUNDED NUMBER OF TIMES, ACROSS THE WHOLE RUN — the
      // artifact carries the count, so waves and recovery instances share one budget rather
      // than each getting a fresh one. Unbounded re-issue is how one chunk id came to be
      // billed 21–24 times during a recovery storm.
      if (!existing.terminal && existing.attempts < maxIssues) {
        priorAttemptsByChunk.set(chunk.n, existing.attempts);
        priorUsagesByChunk.set(chunk.n, existing.usages);
        priorAuthorityByChunk.set(chunk.n, read.predecessor);
        todo.push(chunk);
        continue;
      }
      landed += 1;
      terminalFailure = true;
      if (existing.wireCeiling) {
        terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
      }
      failedUnits.push({ unit: chunk.id, blockIds, detail: existing.detail });
      unresolvedFor(blockIds, `chunk ${chunk.id} failed after ${existing.attempts} attempt(s): ${existing.detail}`);
      continue;
    }

    landed += 1;
    accountingCalls.push(...existing.usages);
    requirements.push(...existing.obligations);
    dispositions.push(...existing.dispositions);
    constructs.push(...existing.constructs);
    ambiguities.push(...existing.ambiguities);
    unverifiable.push(...existing.unverifiable);
    for (const usage of existing.usages) {
      calls.push({
        ...usage,
        detail: "reused: this chunk was already persisted by an earlier attempt",
        costUsd: 0,
      });
    }
    for (const id of blockIds) {
      if (!existing.dispositions.some((d) => d.blockId === id)) {
        dispositions.push({
          blockId: id,
          disposition: "unresolved",
          reason: `chunk ${chunk.id} returned no disposition for this block`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — ISSUE, under bounded concurrency AND the slice deadline.
  //
  // Chunks are independent — each one is told exactly which blocks it owns — so running them
  // strictly one at a time turns a 9-call extraction into ten minutes of mostly-waiting.
  // Results are still persisted per chunk the moment each returns.
  // -------------------------------------------------------------------------
  let pendingChunkWireFailure: {
    chunk: Chunk;
    detail: string;
  } | null = null;
  for (const chunk of todo) {
    const check = chunkWireChecks.get(chunk.n);
    if (check && !check.ok) {
      pendingChunkWireFailure = { chunk, detail: check.detail };
      break;
    }
  }
  // A retained terminal unit is earlier durable authority than any new cap-drift refusal.
  // Do not persist/relabel another chunk or exclude it from the explicit remaining count.
  if (terminalFailure) pendingChunkWireFailure = null;
  if (pendingChunkWireFailure !== null) {
    const chunk = pendingChunkWireFailure.chunk;
    const request = chunkRequestFor(chunk);
    const detail = pendingChunkWireFailure.detail;
    const hasPriorPaidArtifact = (priorAttemptsByChunk.get(chunk.n) ?? 0) > 0;
    await persistZeroReceiptWireFailure({
      key: hasPriorPaidArtifact ? chunkWireCeilingKey(runId, chunk.n) : chunkKey(runId, chunk.n),
      idField: "chunkId",
      unitId: chunk.id,
      blockIds: request.blockIds,
      evidenceBlockIds: request.evidenceBlocks.map((block) => block.blockId),
      detail,
    });
    terminalFailure = true;
    terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
    failedUnits.push({ unit: chunk.id, blockIds: request.blockIds, detail });
    unresolvedFor(request.blockIds, detail);
    await reportProgress(
      onProgress,
      `pass B ${chunk.id}: FAILED — ${publicExtractionFailureDetail(detail)}`,
    );
  }
  if (pendingChunkWireFailure === null && !failureRateExceeded && persistenceConflictFailures === 0 && terminalReasonCode !== EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED && todo.length > 0) {
    try {
      await resolveDeepseekPurchaseEnv();
    } catch (error) {
      if (!(error instanceof MissingCredential)) throw error;
      credentialRefusal = { reason: "NO_CREDENTIAL", binding: error.binding, provider: "deepseek" };
      terminalFailure = true;
      const first = todo[0]!;
      failedUnits.push({
        unit: first.id,
        blockIds: first.blocks.map((block) => block.blockId),
        detail: `${error.binding} is unavailable after all-chunk request-size preflight; ` +
          `no new Pass-B provider request was issued.`,
      });
    }
  }
  const concurrency = Math.max(1, num(env.EXTRACT_CHUNK_CONCURRENCY, 3));
  // Infrastructure failures (wire ceiling, persistence conflict, credential) block issuing;
  // semantic terminal failures are handled by mayIssue's 20% guardrail at dequeue time.
  const infrastructureBlock = pendingChunkWireFailure !== null || persistenceConflictFailures > 0 || credentialRefusal !== undefined;
  const queue = !infrastructureBlock ? [...todo] : [];
  const deferred: Chunk[] = !infrastructureBlock
    ? []
    : pendingChunkWireFailure === null
      ? [...todo]
      : todo.filter((chunk) => chunk.n !== pendingChunkWireFailure.chunk.n);
  /**
   * Chunks that FAILED in this slice and still hold re-issue budget. They are work
   * REMAINING, not work done: `done` must stay false so the next wave spends the budget the
   * artifact says is left, and the counter is bounded by EXTRACT_CHUNK_MAX_ISSUES so this
   * can never become a loop.
   */
  let retriableFailures = 0;
  // Per invocation/wave only. `finally` empties the set after every unit, so a failed
  // callback or provider call cannot leak concurrency into a later or resumed wave.
  const activeChunkReads = new Set<number>();

  const runChunk = async (chunk: Chunk): Promise<void> => {
    const request = chunkRequestFor(chunk, priorFailureDetailByChunk.get(chunk.n));
    if (!request.ok) {
      throw new Error(`PASS_B_WIRE_PREFLIGHT_DRIFT: ${chunk.id} became oversized after all-chunk preflight`);
    }
    const admitted = chunkWireChecks.get(chunk.n);
    if (!admitted?.ok) {
      throw new Error(`PASS_B_WIRE_PREFLIGHT_DRIFT: ${chunk.id} lost its admitted request authority`);
    }
    const exactBodyText = chatRequestBodyText(deepseekPassBRequestShape(env), request.optionsForCall);
    if (`sha256:${await sha256Hex(exactBodyText)}` !== admitted.requestHash) {
      throw new Error(`PASS_B_WIRE_PREFLIGHT_DRIFT: ${chunk.id} request bytes changed after the all-chunk barrier`);
    }
    const { blockIds, evidenceBlocks } = request;
    const optionsForCall = { ...request.optionsForCall, preSerializedBodyText: exactBodyText };
    activeChunkReads.add(chunk.n);
    try {
    // This count came from the same strict decoder that admitted the failed artifact in
    // phase 1. A second, weaker read used to let a stale parser/prompt failure consume the
    // current retry budget even after `readChunk` had rejected it.
    const priorAttempts = priorAttemptsByChunk.get(chunk.n) ?? 0;
    const priorUsages = priorUsagesByChunk.get(chunk.n) ?? [];
    const predecessor = priorAuthorityByChunk.get(chunk.n) ?? null;

    let purchasedUsages: CallUsage[] = [];
    let rawModelOutput: Record<string, unknown> | null = null;
    try {
      if (onUnitStart) {
        await onUnitStart({
          stage: "secondary-chunks",
          unit: {
            kind: "chunk",
            name: chunk.id,
            ordinal: chunk.n,
            total: chunks.length,
            sourceContext: sourceContextForUnit(doc.blocks, blockIds),
          },
          primary: null,
          secondary: {
            total: chunks.length,
            landed,
            remaining: chunks.length - landed,
            sweepRemaining: null,
          },
          concurrentUnitsInFlight: activeChunkReads.size,
        });
      }
      if (deepseekPurchaseEnv === null) {
        throw new Error("PASS_B_CREDENTIAL_PREFLIGHT_MISSING: chunk worker started without resolved DeepSeek authority");
      }
      const outcome = await deepseekPassBJson(deepseekPurchaseEnv, optionsForCall);
      const { value } = outcome;
      rawModelOutput = value;
      purchasedUsages = settlementUsages(runId, chunk.id, priorAttempts + 1, [outcome.usage]);
      const decoded = decodePassBOutput(value, chunk.id, chunk.blocks, evidenceBlocks);
      calls.push(...purchasedUsages);
      issuedCalls.push(...purchasedUsages);
      accountingCalls.push(...purchasedUsages);

      // PERSIST FIRST, ACCUMULATE SECOND.
      const successBody = JSON.stringify(
        {
          chunkId: chunk.id,
          blockIds,
          evidenceBlockIds: evidenceBlocks.map((block) => block.blockId),
          parserVersion,
          promptVersion: PROMPT_VERSION_B,
          providerPlanIdentity,
          decoderIdentity: PASS_B_DECODER_VERSION,
          status: "ok",
          attempts: priorAttempts + 1,
          usages: [...priorUsages, ...purchasedUsages],
          modelOutput: value,
          obligations: decoded.obligations,
          dispositions: decoded.dispositions,
          constructs: decoded.constructs,
          ambiguities: decoded.ambiguities,
          unverifiable: decoded.unverifiable,
        },
        null,
        2,
      );
      const persistence = await persistPassBPaidUnitArtifact(
        env,
        chunk.id,
        {
          canonicalKey: chunkKey(runId, chunk.n),
          historyKey: (digest) => chunkHistoryKey(runId, chunk.n, digest),
          conflictKey: (digest) => chunkCasConflictKey(runId, chunk.n, digest),
        },
        predecessor,
        successBody,
      );
      if (!persistence.ok) {
        terminalFailure = true;
        persistenceConflictFailures += 1;
        failedUnits.push({ unit: chunk.id, blockIds, detail: persistence.detail });
        unresolvedFor(blockIds, persistence.detail);
        await reportProgress(
          onProgress,
          `pass B ${chunk.id}: FAILED â€" paid artifact retained without canonical or coverage authority`,
        );
        return;
      }

      requirements.push(...decoded.obligations);
      dispositions.push(...decoded.dispositions);
      constructs.push(...decoded.constructs);
      ambiguities.push(...decoded.ambiguities);
      unverifiable.push(...decoded.unverifiable);

      await reportProgress(onProgress,
        `pass B ${chunk.id}: ${decoded.obligations.length} obligations, ` +
          `${decoded.dispositions.length}/${blockIds.length} blocks dispositioned`,
      );
    } catch (err) {
      // Exact Pro bytes were preflighted before the fan-out existed. Credential lookup is
      // deliberately inside the provider client after that proof; missing configuration is
      // reported by the stage and must not become a paid/semantic unit artifact.
      if (err instanceof MissingCredential) throw err;
      if (!(err instanceof PassBOutputInvalid) && !(err instanceof ModelCallError)) throw err;
      const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
      const semanticFailure = err instanceof PassBOutputInvalid;
      const publicFailureDetail = publicExtractionFailureDetail(
        semanticFailure
          ? "extraction-pass-b-semantic-output-invalid"
          : `extraction-provider-${err instanceof ModelCallError ? err.failureKind : "request-failed"}`,
      );
      const failureUsages: CallUsage[] = semanticFailure
        ? purchasedUsages.map((usage) => ({ ...usage, status: "parse-failed", detail }))
        : err instanceof ModelCallError
          ? settlementUsages(runId, chunk.id, priorAttempts + 1, [err.usage])
          : [];
      const attempts = priorAttempts + 1;
      const terminal = attempts >= maxIssues; // mutation-anchor: semantic-failure-not-instantly-terminal
      if (terminal) {
        terminalSemanticFailures += semanticFailure ? 1 : 0;
        terminalProviderFailures += semanticFailure ? 0 : 1;
        terminalFailure = true;
      }
      // B3: per-obligation salvage at retry exhaustion for semantic failures.
      let salvaged = false;
      if (terminal && semanticFailure && rawModelOutput !== null) {
        try {
          const salvageResult = salvagePassBOutput(
            rawModelOutput, chunk.id, chunk.blocks, evidenceBlocks,
          );
          if (salvageResult !== null) {
            // Salvage succeeded: replace parse-failed usages with ok (degraded).
            // Push only the degraded usages — not the original failureUsages —
            // so a single purchase is never double-counted. Matches pass A's
            // usage-status restoration pattern (spec B3).
            const degradedUsages = failureUsages.map((usage) => ({
              ...usage,
              status: "ok" as const,
              detail: `degraded: ${salvageResult.limitations.length} obligation(s) dropped`,
            }));
            calls.push(...degradedUsages);
            issuedCalls.push(...degradedUsages);
            accountingCalls.push(...degradedUsages);
            const degradedBody = JSON.stringify(
              {
                chunkId: chunk.id,
                blockIds,
                evidenceBlockIds: evidenceBlocks.map((block) => block.blockId),
                parserVersion,
                promptVersion: PROMPT_VERSION_B,
                providerPlanIdentity,
                decoderIdentity: PASS_B_DECODER_VERSION,
                status: "ok",
                attempts,
                usages: [...priorUsages, ...degradedUsages],
                modelOutput: salvageResult.modelOutput,
                rawModelOutputPreDegradation: rawModelOutput,
                obligations: salvageResult.decoded.obligations,
                dispositions: salvageResult.decoded.dispositions,
                constructs: salvageResult.decoded.constructs,
                ambiguities: salvageResult.decoded.ambiguities,
                unverifiable: salvageResult.decoded.unverifiable,
                limitations: salvageResult.limitations,
              },
              null,
              2,
            );
            const persistence = await persistPassBPaidUnitArtifact(
              env,
              chunk.id,
              {
                canonicalKey: chunkKey(runId, chunk.n),
                historyKey: (digest) => chunkHistoryKey(runId, chunk.n, digest),
                conflictKey: (digest) => chunkCasConflictKey(runId, chunk.n, digest),
              },
              predecessor,
              degradedBody,
            );
            if (persistence.ok) {
              salvaged = true;
              requirements.push(...salvageResult.decoded.obligations);
              dispositions.push(...salvageResult.decoded.dispositions);
              constructs.push(...salvageResult.decoded.constructs);
              ambiguities.push(...salvageResult.decoded.ambiguities);
              unverifiable.push(...salvageResult.decoded.unverifiable);
              limitations.push(...salvageResult.limitations);
              // Remove from failed units tracking since salvage landed.
              terminalSemanticFailures -= 1;
              terminalFailure = terminalSemanticFailures > 0 || terminalProviderFailures > 0 || persistenceConflictFailures > 0;
              await reportProgress(onProgress,
                `pass B ${chunk.id}: SALVAGED ${salvageResult.decoded.obligations.length} obligations, ` +
                  `${salvageResult.limitations.length} limitation(s) — ${publicFailureDetail}`,
              );
            }
          }
        } catch {
          // Salvage errors fall through to the normal terminal path.
        }
      }
      if (!salvaged) {
        // Salvage did not run or did not succeed — record the original failure usages.
        // This is the only path that pushes failureUsages; the salvage-success path
        // pushes degradedUsages instead. Neither path pushes both.
        calls.push(...failureUsages);
        issuedCalls.push(...failureUsages);
        accountingCalls.push(...failureUsages);
        const failureBody = JSON.stringify(
          {
            chunkId: chunk.id,
            blockIds,
            evidenceBlockIds: evidenceBlocks.map((block) => block.blockId),
            parserVersion,
            promptVersion: PROMPT_VERSION_B,
            providerPlanIdentity,
            decoderIdentity: PASS_B_DECODER_VERSION,
            status: "failed",
            attempts,
            usages: [...priorUsages, ...failureUsages],
            failureStage: semanticFailure ? "semantic-output" : "provider",
            terminal,
            modelOutput: semanticFailure ? rawModelOutput : null,
            detail,
          },
          null,
          2,
        );
        const persistence = await persistPassBPaidUnitArtifact(
          env,
          chunk.id,
          {
            canonicalKey: chunkKey(runId, chunk.n),
            historyKey: (digest) => chunkHistoryKey(runId, chunk.n, digest),
            conflictKey: (digest) => chunkCasConflictKey(runId, chunk.n, digest),
          },
          predecessor,
          failureBody,
        );
        if (!persistence.ok) {
          terminalFailure = true;
          persistenceConflictFailures += 1;
          failedUnits.push({ unit: chunk.id, blockIds, detail: persistence.detail });
          unresolvedFor(blockIds, persistence.detail);
          await reportProgress(
            onProgress,
            `pass B ${chunk.id}: FAILED — paid artifact retained without canonical or coverage authority`,
          );
          return;
        }
        failedUnits.push({ unit: chunk.id, blockIds, detail });
        unresolvedFor(blockIds, `chunk ${chunk.id} failed: ${detail}`);
        if (!terminal) retriableFailures += 1;
        const willRetry = !terminal;
        await reportProgress(
          onProgress,
          willRetry
            ? `pass B ${chunk.id}: FAILED (attempt ${attempts} of ${maxIssues}) — will retry — ${publicFailureDetail}`
            : `pass B ${chunk.id}: FAILED (attempt ${attempts} of ${maxIssues}) — TERMINAL — ${publicFailureDetail}`,
        );
      }
    }
    } finally {
      activeChunkReads.delete(chunk.n);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      // The check is SYNCHRONOUS with the shift and the increment, so the "at least one"
      // exemption is claimed by exactly one worker no matter how many are racing.
      if (!mayIssue()) {
        deferred.push(next);
        continue;
      }
      issued += 1;
      await runChunk(next);
    }
  });
  await Promise.all(workers);

  landed += todo.length - deferred.length - retriableFailures - persistenceConflictFailures;
  const chunksRemaining = deferred.length + retriableFailures + persistenceConflictFailures;

  // ---------------------------------------------------------------------------
  // PHASE 3 — THE LEDGER SWEEP. Only once EVERY chunk has landed.
  //
  // The difference between a ledger with holes and a run that stops. On the first real
  // document this gate FAILED: the block pass called blocks normative and then cited none of
  // them, so `zeroUnexplainedNormativeBlocks` was `fail` and nothing sealed. That is the
  // honest outcome of an incomplete read, and the answer is to FINISH THE READ — one extra
  // call over exactly the unaccounted blocks — not to reclassify them in code, which would
  // be the self-validating green this whole design deletes. If the sweep still cannot
  // account for a block, the gate still fails, and it names the block.
  //
  // IT WAITS FOR EVERY CHUNK because the set of unaccounted blocks is computed from the
  // WHOLE chunk walk. Sweeping over a half-walked document would buy calls about blocks a
  // later chunk was about to explain, and would make the sweep's own block set — which is
  // what its artifact is keyed on — depend on how the waves happened to fall.
  // ---------------------------------------------------------------------------
  const sweepMax = num(env.EXTRACT_SWEEP_MAX_CALLS, 3);
  const sweepBlocksPerCall = num(env.EXTRACT_SWEEP_BLOCKS_PER_CALL, 40);
  let sweepCallsIssued = 0;
  let sweepRemaining = 0;

  // Run the sweep when all chunks are accounted for (ok, degraded, or terminal), even
  // with terminal failed units. The dead chunks' blocks are unaccounted and the sweep is
  // their built-in second read. Only infrastructure failures block the sweep.
  if (chunksRemaining === 0 && persistenceConflictFailures === 0 && !failureRateExceeded && terminalReasonCode !== EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED) {
    const unaccounted = unaccountedBlocks(doc.blocks, requirements, dispositions);
    const sweepCount = Math.min(
      Math.max(0, Math.floor(sweepMax)),
      sweepBlocksPerCall > 0 ? Math.ceil(unaccounted.length / sweepBlocksPerCall) : 0,
    );
    const sweepRequestFor = (i: number, sourceBlocks: SourceBlock[]) => {
      const sweepId = `SWEEP${String(i + 1).padStart(2, "0")}`;
      const blockIds = sourceBlocks.map((block) => block.blockId);
      const evidenceBlocks = evidenceBlocksFor(sourceBlocks, contextBlocks.length > 0);
      const sourceJsonl = buildBoundedSourceBlocksJsonl(sourceBlocks, wireMaxBytes);
      const preSerializationFailure = !sourceJsonl.ok
        ? extractionWirePreSerializationFailureDetail(
            sweepId, blockIds.length, sourceJsonl, "EXTRACT_MODEL_INPUT_MAX_BYTES",
          )
        : contextBlocks.length > 0 && !boundedContextJsonl.ok
          ? extractionWirePreSerializationFailureDetail(
              sweepId, blockIds.length, boundedContextJsonl, "EXTRACT_MODEL_INPUT_MAX_BYTES",
            )
          : null;
      if (preSerializationFailure !== null || !sourceJsonl.ok) {
        return {
          ok: false as const,
          sweepId,
          blockIds,
          evidenceBlocks,
          detail: preSerializationFailure!,
        };
      }
      const sweepContext = contextBlocks.length > 0 && boundedContextJsonl.ok
        ? boundedContextJsonl.text
        : null;
      const optionsForCall = {
        system: SYSTEM_B,
        user: userMessageSweep(
          documentName,
          sweepId,
          sourceJsonl.text,
          sweepContext,
          blockIds,
        ),
        maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
        role: `extract-pass-b-${sweepId}`,
        callId: `call_b_sweep_${i + 1}`,
        maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
      };
      return { ok: true as const, sweepId, blockIds, evidenceBlocks, optionsForCall };
    };
    const sweepPlans: Array<{
      i: number;
      sourceBlocks: SourceBlock[];
      sweepId: string;
      blockIds: string[];
      evidenceBlocks: SourceBlock[];
      wireCheck: { ok: true } | { ok: false; detail: string };
      requestHash?: string;
    }> = [];
    for (let i = 0; i < sweepCount; i += 1) {
      const sourceBlocks = unaccounted.slice(
        i * sweepBlocksPerCall,
        (i + 1) * sweepBlocksPerCall,
      );
      const request = sweepRequestFor(i, sourceBlocks);
      if (!request.ok) {
        sweepPlans.push({
          i,
          sourceBlocks,
          sweepId: request.sweepId,
          blockIds: request.blockIds,
          evidenceBlocks: request.evidenceBlocks,
          wireCheck: { ok: false, detail: request.detail },
        });
        continue;
      }
      const bodyText = chatRequestBodyText(deepseekPassBRequestShape(env), request.optionsForCall);
      const exactCheck = preflightExtractionRequestBodies(env, [{
        route: "deepseek-v4-pro",
        bodyText,
      }]);
      const wireCheck = exactCheck.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            detail: extractionWireFailureDetail(request.sweepId, request.blockIds.length, exactCheck),
          };
      sweepPlans.push({
        i,
        sourceBlocks,
        sweepId: request.sweepId,
        blockIds: request.blockIds,
        evidenceBlocks: request.evidenceBlocks,
        wireCheck,
        ...(exactCheck.ok ? { requestHash: `sha256:${await sha256Hex(bodyText)}` } : {}),
      });
    }

    // EXTRACTION_WIRE_PREFLIGHT_BEFORE_FIRST_SWEEP_PURCHASE: the complete, deterministic
    // sweep plan is serialized and all current artifacts are reclaimed before any sweep can
    // touch a credential. A later oversized slice therefore blocks every new sweep purchase.
    const existingSweeps = new Map<number, PersistedChunk | FailedUnitArtifact | null>();
    const sweepPredecessors = new Map<number, PassBUnitStorageAuthority | null>();
    let pendingSweepWireFailure: {
      i: number;
      detail: string;
    } | null = null;
    let retainedSweepTerminal: number | null = null;
    for (const plan of sweepPlans) {
      const read = await readSweepWithAuthority(
        env, runId, plan.i, plan.sourceBlocks, plan.evidenceBlocks, parserVersion,
      );
      const existing = read.artifact;
      existingSweeps.set(plan.i, existing);
      sweepPredecessors.set(plan.i, read.predecessor);
      if (retainedSweepTerminal === null && existing?.kind === "failed" && existing.terminal) {
        retainedSweepTerminal = plan.i;
      }
      if (
        pendingSweepWireFailure === null && !plan.wireCheck.ok &&
        (existing === null || (existing.kind === "failed" && !existing.terminal))
      ) {
        pendingSweepWireFailure = { i: plan.i, detail: plan.wireCheck.detail };
      }
    }

    const firstSweepNeedingPurchase = pendingSweepWireFailure === null && retainedSweepTerminal === null
      ? sweepPlans.find((plan) => {
          const existing = existingSweeps.get(plan.i) ?? null;
          return existing === null || (existing.kind === "failed" && !existing.terminal);
        }) ?? null
      : null;
    if (firstSweepNeedingPurchase !== null && deepseekPurchaseEnv === null) {
      try {
        await resolveDeepseekPurchaseEnv();
      } catch (error) {
        if (!(error instanceof MissingCredential)) throw error;
        credentialRefusal = { reason: "NO_CREDENTIAL", binding: error.binding, provider: "deepseek" };
        terminalFailure = true;
        failedUnits.push({
          unit: firstSweepNeedingPurchase.sweepId,
          blockIds: firstSweepNeedingPurchase.blockIds,
          detail: `${error.binding} is unavailable after all-sweep request-size preflight; ` +
            `no new Pass-B provider request was issued.`,
        });
      }
    }

    for (const plan of sweepPlans) {
      const { i, sourceBlocks: slice, sweepId, blockIds, evidenceBlocks: sweepEvidenceBlocks } = plan;
      const allowed = new Set(blockIds);
      if (onUnitStart) {
        await onUnitStart({
          stage: "secondary-sweep",
          unit: {
            kind: "sweep",
            name: sweepId,
            ordinal: i + 1,
            total: null,
            sourceContext: sourceContextForUnit(doc.blocks, [...allowed]),
          },
          primary: null,
          secondary: {
            total: chunks.length,
            landed: chunks.length,
            remaining: 0,
            sweepRemaining: null,
          },
        });
      }

      const absorb = (
        sweptReqs: RawRequirement[],
        sweptDisps: PassResult["dispositions"],
        sweptAmb: PassResult["ambiguities"],
        sweptUnv: PassResult["unverifiable"],
      ): void => {
        requirements.push(...sweptReqs);
        // The sweep's verdict REPLACES the earlier one for the blocks it was asked about: it
        // is the later and better-informed read of exactly those blocks.
        for (let j = dispositions.length - 1; j >= 0; j--) {
          if (allowed.has(dispositions[j]!.blockId)) dispositions.splice(j, 1);
        }
        dispositions.push(...sweptDisps);
        ambiguities.push(...sweptAmb);
        unverifiable.push(...sweptUnv);
      };

      // RESUME, symmetric with the chunks. These artifacts were written and never read, so
      // every step retry re-bought all three sweep calls at full price.
      const existing = existingSweeps.get(i) ?? null;
      if (existing && existing.kind === "ok") {
        accountingCalls.push(...existing.usages);
        for (const usage of existing.usages) {
          calls.push({ ...usage, detail: "reused: this sweep call was already persisted", costUsd: 0 });
        }
        absorb(existing.obligations, existing.dispositions, existing.ambiguities, existing.unverifiable);
        await reportProgress(onProgress, `pass B ${sweepId}: reused a previously persisted sweep call`);
        continue;
      }
      if (existing && existing.kind === "failed") {
        accountingCalls.push(...existing.usages);
        for (const usage of existing.usages) {
          calls.push({ ...usage, detail: "reused: prior failed sweep purchase", costUsd: 0 });
        }
      }
      if (existing && existing.kind === "failed" &&
          (existing.terminal || existing.attempts >= maxIssues)) {
        terminalFailure = true;
        if (existing.wireCeiling) {
          terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
        }
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail: existing.detail });
        break;
      }
      if (retainedSweepTerminal !== null) {
        // A later retained terminal sweep makes this wave non-purchasing. Earlier successes
        // were reclaimed above; missing/retryable units remain explicitly outstanding.
        sweepRemaining += 1;
        continue;
      }
      if (pendingSweepWireFailure !== null) {
        if (pendingSweepWireFailure.i !== i) {
          // Reclaim succeeded units above, but never buy an earlier missing/retryable sweep
          // when a later canonical slice is already known to be unsafe on the wire.
          sweepRemaining += 1;
          continue;
        }
        const detail = pendingSweepWireFailure.detail;
        const hasPriorPaidArtifact = existing?.kind === "failed" && existing.attempts > 0;
        await persistZeroReceiptWireFailure({
          key: hasPriorPaidArtifact ? sweepWireCeilingKey(runId, i) : sweepKey(runId, i),
          idField: "sweepId",
          unitId: sweepId,
          blockIds,
          evidenceBlockIds: sweepEvidenceBlocks.map((block) => block.blockId),
          detail,
        });
        terminalFailure = true;
        terminalReasonCode = EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED;
        failedUnits.push({ unit: sweepId, blockIds, detail });
        unresolvedFor(blockIds, detail);
        sweepRemaining += Math.max(0, sweepPlans.length - (i + 1));
        await reportProgress(
          onProgress,
          `pass B ${sweepId}: FAILED — ${publicExtractionFailureDetail(detail)}`,
        );
        break;
      }
      if (credentialRefusal !== undefined) {
        sweepRemaining += 1;
        continue;
      }
      if (!mayIssue()) {
        sweepRemaining += 1;
        continue;
      }
      issued += 1;
      sweepCallsIssued += 1;
      const priorAttempts = existing && existing.kind === "failed" ? existing.attempts : 0;
      const priorUsages = existing && existing.kind === "failed" ? existing.usages : [];
      const predecessor = sweepPredecessors.get(i) ?? null;

      let purchasedUsages: CallUsage[] = [];
      let rawModelOutput: Record<string, unknown> | null = null;
      try {
        if (deepseekPurchaseEnv === null) {
          throw new Error("PASS_B_CREDENTIAL_PREFLIGHT_MISSING: sweep started without resolved DeepSeek authority");
        }
        const purchaseRequest = sweepRequestFor(i, slice);
        if (!purchaseRequest.ok || !plan.wireCheck.ok || plan.requestHash === undefined) {
          throw new Error(`PASS_B_WIRE_PREFLIGHT_DRIFT: ${sweepId} has no safe purchase authority`);
        }
        const exactBodyText = chatRequestBodyText(
          deepseekPassBRequestShape(env),
          purchaseRequest.optionsForCall,
        );
        if (`sha256:${await sha256Hex(exactBodyText)}` !== plan.requestHash) {
          throw new Error(`PASS_B_WIRE_PREFLIGHT_DRIFT: ${sweepId} request bytes changed after the all-sweep barrier`);
        }
        const outcome = await deepseekPassBJson(deepseekPurchaseEnv, {
          ...purchaseRequest.optionsForCall,
          preSerializedBodyText: exactBodyText,
        });
        const { value } = outcome;
        rawModelOutput = value;
        purchasedUsages = settlementUsages(runId, sweepId, priorAttempts + 1, [outcome.usage]);
        const decoded = decodePassBOutput(value, sweepId, slice, sweepEvidenceBlocks);
        calls.push(...purchasedUsages);
        issuedCalls.push(...purchasedUsages);
        accountingCalls.push(...purchasedUsages);
        const successBody = JSON.stringify(
          {
            sweepId,
            blockIds: [...allowed],
            evidenceBlockIds: sweepEvidenceBlocks.map((block) => block.blockId),
            parserVersion,
            promptVersion: PROMPT_VERSION_B,
            providerPlanIdentity,
            decoderIdentity: PASS_B_DECODER_VERSION,
            status: "ok",
            attempts: priorAttempts + 1,
            usages: [...priorUsages, ...purchasedUsages],
            modelOutput: value,
            obligations: decoded.obligations,
            dispositions: decoded.dispositions,
            constructs: decoded.constructs,
            ambiguities: decoded.ambiguities,
            unverifiable: decoded.unverifiable,
          },
          null,
          2,
        );
        const persistence = await persistPassBPaidUnitArtifact(
          env,
          sweepId,
          {
            canonicalKey: sweepKey(runId, i),
            historyKey: (digest) => sweepHistoryKey(runId, i, digest),
            conflictKey: (digest) => sweepCasConflictKey(runId, i, digest),
          },
          predecessor,
          successBody,
        );
        if (!persistence.ok) {
          terminalFailure = true;
          failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail: persistence.detail });
          unresolvedFor(blockIds, persistence.detail);
          sweepRemaining += Math.max(0, sweepPlans.length - i);
          await reportProgress(
            onProgress,
            `pass B ${sweepId}: FAILED â€" paid artifact retained without canonical or coverage authority`,
          );
          break;
        }
        absorb(decoded.obligations, decoded.dispositions, decoded.ambiguities, decoded.unverifiable);
        await reportProgress(onProgress,
          `pass B ${sweepId}: accounted for ${decoded.dispositions.length}/${allowed.size} ` +
            `previously unaccounted blocks (+${decoded.obligations.length} obligations)`,
        );
      } catch (err) {
        if (err instanceof MissingCredential) throw err;
        if (!(err instanceof PassBOutputInvalid) && !(err instanceof ModelCallError)) throw err;
        const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
        const semanticFailure = err instanceof PassBOutputInvalid;
        const publicFailureDetail = publicExtractionFailureDetail(
          semanticFailure
            ? "extraction-pass-b-semantic-output-invalid"
            : `extraction-provider-${err instanceof ModelCallError ? err.failureKind : "request-failed"}`,
        );
        const failureUsages: CallUsage[] = semanticFailure
          ? purchasedUsages.map((usage) => ({ ...usage, status: "parse-failed", detail }))
          : err instanceof ModelCallError
            ? settlementUsages(runId, sweepId, priorAttempts + 1, [err.usage])
            : [];
        calls.push(...failureUsages);
        issuedCalls.push(...failureUsages);
        accountingCalls.push(...failureUsages);
        const attempts = priorAttempts + 1;
        const terminal = attempts >= maxIssues; // sweep mirrors chunk: semantic failure is not instantly terminal
        if (terminal) terminalFailure = true;
        // A failed sweep call is an artifact too, so its retries are bounded the same way a
        // chunk's are rather than being re-bought once per wave.
        const failureBody = JSON.stringify(
          {
            sweepId,
            blockIds: [...allowed],
            evidenceBlockIds: sweepEvidenceBlocks.map((block) => block.blockId),
            parserVersion,
            promptVersion: PROMPT_VERSION_B,
            providerPlanIdentity,
            decoderIdentity: PASS_B_DECODER_VERSION,
            status: "failed",
            attempts,
            usages: [...priorUsages, ...failureUsages],
            failureStage: semanticFailure ? "semantic-output" : "provider",
            terminal,
            modelOutput: semanticFailure ? rawModelOutput : null,
            detail,
          },
          null,
          2,
        );
        const persistence = await persistPassBPaidUnitArtifact(
          env,
          sweepId,
          {
            canonicalKey: sweepKey(runId, i),
            historyKey: (digest) => sweepHistoryKey(runId, i, digest),
            conflictKey: (digest) => sweepCasConflictKey(runId, i, digest),
          },
          predecessor,
          failureBody,
        );
        if (!persistence.ok) {
          terminalFailure = true;
          failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail: persistence.detail });
          unresolvedFor(blockIds, persistence.detail);
          sweepRemaining += Math.max(0, sweepPlans.length - i);
          await reportProgress(
            onProgress,
            `pass B ${sweepId}: FAILED â€" paid artifact retained without canonical or coverage authority`,
          );
          break;
        }
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail });
        if (!terminal) sweepRemaining += 1;
        const sweepWillRetry = !terminal;
        await reportProgress(
          onProgress,
          sweepWillRetry
            ? `pass B ${sweepId}: FAILED (attempt ${attempts} of ${maxIssues}) — will retry — ${publicFailureDetail}`
            : `pass B ${sweepId}: FAILED (attempt ${attempts} of ${maxIssues}) — TERMINAL — ${publicFailureDetail}`,
        );
        if (terminal) break;
      }
    }
  }

  // Deterministic order regardless of which chunk finished first: the merge, the ledger and
  // every id derived from them must not depend on provider latency.
  const chunkOrder = new Map(chunks.map((c, i) => [c.id, i]));
  requirements.sort((a, b) => (chunkOrder.get(a.origin) ?? 0) - (chunkOrder.get(b.origin) ?? 0));
  dispositions.sort((a, b) => a.blockId.localeCompare(b.blockId));
  failedUnits.sort((a, b) => (chunkOrder.get(a.unit) ?? 0) - (chunkOrder.get(b.unit) ?? 0));
  calls.sort((a, b) => a.callId.localeCompare(b.callId));

  const slice: PassBSlice = {
    done: chunksRemaining === 0 && sweepRemaining === 0 && persistenceConflictFailures === 0 && !failureRateExceeded && terminalReasonCode !== EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED, // mutation-anchor: done-does-not-require-zero-failed-units
    chunksTotal: chunks.length,
    chunksLanded: landed,
    chunksIssued: issued - sweepCallsIssued,
    chunksRemaining,
    sweepCallsIssued,
    sweepRemaining,
    terminalFailure,
    deadlineHit,
  };

  return {
    pass: "B",
    provider: "deepseek",
    model: providerPlanIdentity,
    providerPlanIdentity,
    requirements,
    ambiguities,
    unverifiable,
    dispositions,
    constructs,
    failedUnits,
    limitations,
    calls,
    slice,
    issuedCalls,
    accountingCalls,
    ...(terminalReasonCode ? { terminalReasonCode } : {}),
    ...(credentialRefusal ? { credentialRefusal } : {}),
  };
}

/**
 * Rebuild completed Pass-B solely from strict, current per-unit artifacts.
 *
 * This function never calls a provider and never treats a missing/corrupt current unit as
 * a cache miss. Its exact bytes and hash are the only completion authority a stage should
 * publish or pass to consolidation.
 */
export async function reconstructPassBCompletedAuthority(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName = "document.docx",
): Promise<PassBAuthorityReconstruction> {
  void documentName; // Display filenames are deliberately absent from semantic identity.
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const providerPlanIdentity = deepseekPassBIdentity(env);
  const chunks = chunkBlocks(
    doc.blocks,
    num(env.EXTRACT_CHUNK_CHARS, 5_000),
    num(env.EXTRACT_CHUNK_MAX_BLOCKS, 45),
  );
  const contextBlocks = globalContextBlocks(doc.blocks, num(env.EXTRACT_CONTEXT_CHARS, 4_000));
  const contextIds = new Set(contextBlocks.map((block) => block.blockId));
  const evidenceBlocksFor = (owned: readonly SourceBlock[], includeContext: boolean): SourceBlock[] => {
    const byId = new Map<string, SourceBlock>();
    for (const block of includeContext ? [...owned, ...contextBlocks] : owned) {
      byId.set(block.blockId, block);
    }
    return [...byId.values()];
  };
  const requirements: RawRequirement[] = [];
  const dispositions: PassResult["dispositions"] = [];
  const constructs: PassResult["constructs"] = [];
  const ambiguities: PassResult["ambiguities"] = [];
  const unverifiable: PassResult["unverifiable"] = [];
  const reconstructedLimitations: PassBLimitation[] = [];
  const accountingCalls: CallUsage[] = [];
  const reconstructionFailedUnits: PassResult["failedUnits"] = [];
  let chunksLanded = 0;
  let expectedSweepCalls = 0;
  let sweepsLanded = 0;

  const invalid = (
    detail: string,
    failedUnit: PassResult["failedUnits"][number] | null = null,
  ): PassBAuthorityReconstruction => ({
    kind: "invalid",
    detail: `PASS_B_COMPLETED_ARTIFACT_INVALID: ${detail}. No unit was re-bought and no completed Pass-B payload is authorized.`,
    accountingCalls,
    failedUnit,
    slice: {
      done: false,
      chunksTotal: chunks.length,
      chunksLanded,
      chunksIssued: 0,
      chunksRemaining: Math.max(0, chunks.length - chunksLanded),
      sweepCallsIssued: 0,
      sweepRemaining: Math.max(0, expectedSweepCalls - sweepsLanded),
      terminalFailure: true,
      deadlineHit: false,
    },
  });

  for (const chunk of chunks) {
    const includesContext =
      !chunk.blocks.some((block) => contextIds.has(block.blockId)) && contextBlocks.length > 0;
    const unit = await readChunk(
      env, runId, chunk.n, chunk.blocks, evidenceBlocksFor(chunk.blocks, includesContext), parserVersion,
    );
    if (unit === null) {
      const detail = `${chunk.id} is missing or belongs to a stale cache partition`;
      return invalid(detail, { unit: chunk.id, blockIds: chunk.blocks.map((block) => block.blockId), detail });
    }
    accountingCalls.push(...unit.usages);
    chunksLanded += 1;
    if (unit.kind === "failed") {
      // Terminal-failed chunks are accepted as part of a completed pass. Their blocks are
      // left unaccounted and will be picked up by the sweep or the final residual check.
      const blockIds = chunk.blocks.map((block) => block.blockId);
      reconstructionFailedUnits.push({ unit: chunk.id, blockIds, detail: unit.detail });
      // Mark blocks as unresolved so they appear in the unaccounted set for the sweep.
      for (const id of blockIds) {
        dispositions.push({ blockId: id, disposition: "unresolved", reason: `chunk ${chunk.id} failed: ${unit.detail}` });
      }
      continue;
    }
    requirements.push(...unit.obligations);
    dispositions.push(...unit.dispositions);
    constructs.push(...unit.constructs);
    ambiguities.push(...unit.ambiguities);
    unverifiable.push(...unit.unverifiable);
    reconstructedLimitations.push(...unit.limitations);
  }

  const unaccounted = unaccountedBlocks(doc.blocks, requirements, dispositions);
  const sweepMax = Math.max(0, Math.floor(num(env.EXTRACT_SWEEP_MAX_CALLS, 3)));
  const sweepBlocksPerCall = Math.floor(num(env.EXTRACT_SWEEP_BLOCKS_PER_CALL, 40));
  if (unaccounted.length > 0 && sweepBlocksPerCall < 1) {
    return invalid("ledger sweep block capacity is below one while unaccounted source blocks remain");
  }
  expectedSweepCalls = unaccounted.length === 0
    ? 0
    : Math.min(sweepMax, Math.ceil(unaccounted.length / sweepBlocksPerCall));
  if (unaccounted.length > expectedSweepCalls * Math.max(0, sweepBlocksPerCall)) {
    return invalid(
      `ledger sweep capacity covers only ${expectedSweepCalls * Math.max(0, sweepBlocksPerCall)} of ` +
      `${unaccounted.length} unaccounted source blocks`,
    );
  }

  for (let index = 0; index < expectedSweepCalls; index += 1) {
    const sourceBlocks = unaccounted.slice(
      index * sweepBlocksPerCall,
      (index + 1) * sweepBlocksPerCall,
    );
    const sweepId = `SWEEP${String(index + 1).padStart(2, "0")}`;
    const unit = await readSweep(
      env, runId, index, sourceBlocks, evidenceBlocksFor(sourceBlocks, contextBlocks.length > 0),
      parserVersion,
    );
    if (unit === null) {
      const detail = `${sweepId} is missing or belongs to a stale cache partition`;
      return invalid(detail, { unit: sweepId, blockIds: sourceBlocks.map((block) => block.blockId), detail });
    }
    accountingCalls.push(...unit.usages);
    sweepsLanded += 1;
    if (unit.kind === "failed") {
      return invalid(
        `${sweepId} retains failed authority: ${unit.detail}`,
        { unit: sweepId, blockIds: sourceBlocks.map((block) => block.blockId), detail: unit.detail },
      );
    }
    requirements.push(...unit.obligations);
    const owned = new Set(sourceBlocks.map((block) => block.blockId));
    for (let i = dispositions.length - 1; i >= 0; i -= 1) {
      if (owned.has(dispositions[i]!.blockId)) dispositions.splice(i, 1);
    }
    dispositions.push(...unit.dispositions);
    ambiguities.push(...unit.ambiguities);
    unverifiable.push(...unit.unverifiable);
    reconstructedLimitations.push(...unit.limitations);
  }

  const residual = unaccountedBlocks(doc.blocks, requirements, dispositions);
  if (residual.length > 0) {
    return invalid(
      `strict reconstruction leaves ${residual.length} normative/unresolved source block(s) unaccounted: ` +
      residual.slice(0, 5).map((block) => block.blockId).join(", "),
    );
  }

  const unitOrder = new Map([
    ...chunks.map((chunk, index) => [chunk.id, index] as const),
    ...Array.from({ length: expectedSweepCalls }, (_, index) =>
      [`SWEEP${String(index + 1).padStart(2, "0")}`, chunks.length + index] as const),
  ]);
  requirements.sort((a, b) => (unitOrder.get(a.origin) ?? 0) - (unitOrder.get(b.origin) ?? 0));
  dispositions.sort((a, b) => a.blockId.localeCompare(b.blockId));
  accountingCalls.sort((a, b) =>
    a.callId.localeCompare(b.callId) || (a.eventId ?? "").localeCompare(b.eventId ?? ""));

  const slice: PassBSlice = {
    done: true,
    chunksTotal: chunks.length,
    chunksLanded: chunks.length,
    chunksIssued: 0,
    chunksRemaining: 0,
    sweepCallsIssued: 0,
    sweepRemaining: 0,
    terminalFailure: reconstructionFailedUnits.length > 0,
    deadlineHit: false,
  };
  const value: PassBCompletedAuthority = {
    pass: "B",
    provider: "deepseek",
    model: providerPlanIdentity,
    providerPlanIdentity,
    requirements,
    ambiguities,
    unverifiable,
    dispositions,
    constructs,
    failedUnits: reconstructionFailedUnits,
    limitations: reconstructedLimitations,
    calls: accountingCalls,
    slice,
    issuedCalls: [],
    accountingCalls,
  };
  const body = JSON.stringify(
    { parserVersion, promptVersion: PASS_B_VERSION, ...value },
    null,
    2,
  );
  return {
    kind: "ok",
    value,
    body,
    hash: `sha256:${await sha256Hex(body)}`,
  };
}

/**
 * Blocks the chunk walk left unexplained, counted the SAME WAY the ledger counts them.
 *
 * The sweep must agree with `merge.ts#buildLedger` or it buys calls for blocks that were
 * never going to hold the gate open. The ledger accounts a grid cell through its table ROW;
 * so does this — and, like the ledger, ONLY a true `table-cell` block is row-accountable.
 * An origin-bearing block LIFTED to its host cell's coordinates (a combo-box suggestion,
 * a ruby reading) carries tableId+coords as PROVENANCE, not as row membership: it is never
 * absorbed behind a cited sibling cell, so an uncited one stays in this sweep's set instead
 * of silently vanishing (Codex review, blocker 3).
 */
function unaccountedBlocks(
  blocks: SourceBlock[],
  requirements: RawRequirement[],
  dispositions: PassResult["dispositions"],
): SourceBlock[] {
  const cited = new Set(requirements.flatMap((r) => r.blockIds));
  const dispositionOf = new Map<string, string>();
  for (const d of dispositions) {
    const prev = dispositionOf.get(d.blockId);
    if (!prev || prev === "unresolved") dispositionOf.set(d.blockId, d.disposition);
  }
  const rowOf = (b: SourceBlock): string | null =>
    b.kind === "table-cell" && b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;
  const citedRows = new Set<string>();
  for (const b of blocks) {
    const row = rowOf(b);
    if (row !== null && cited.has(b.blockId)) citedRows.add(row);
  }
  return blocks.filter((b) => {
    if (cited.has(b.blockId)) return false;
    const row = rowOf(b);
    if (row !== null && citedRows.has(row)) return false;
    const d = dispositionOf.get(b.blockId) ?? "unresolved";
    return d === "normative" || d === "unresolved";
  });
}

interface PersistedChunk {
  kind: "ok";
  obligations: RawRequirement[];
  dispositions: PassResult["dispositions"];
  constructs: PassResult["constructs"];
  ambiguities: PassResult["ambiguities"];
  unverifiable: PassResult["unverifiable"];
  limitations: PassBLimitation[];
  usages: CallUsage[];
}

interface FailedUnitArtifact {
  kind: "failed";
  attempts: number;
  detail: string;
  usages: CallUsage[];
  terminal: boolean;
  /** True only for a strictly decoded attempts=0/usages=[] wire-ceiling artifact. */
  wireCeiling: boolean;
}

interface PassBUnitReadResult {
  artifact: PersistedChunk | FailedUnitArtifact | null;
  /** Present whenever the canonical exact key was readable, including stale identities. */
  predecessor: PassBUnitStorageAuthority | null;
}

function combinePassBWireSidecar(
  unitId: string,
  sidecar: FailedUnitArtifact | null,
  main: PersistedChunk | FailedUnitArtifact | null,
): PersistedChunk | FailedUnitArtifact | null {
  if (sidecar === null) return main;
  if (!sidecar.wireCeiling) {
    return {
      kind: "failed",
      attempts: main?.kind === "failed" ? main.attempts : 0,
      usages: main?.usages ?? sidecar.usages,
      terminal: true,
      wireCeiling: false,
      detail: `PASS_B_WIRE_CEILING_SIDECAR_INVALID: ${unitId}: ${sidecar.detail}`,
    };
  }
  if (
    main?.kind !== "failed" || main.wireCeiling || main.attempts < 1 || main.terminal
  ) {
    return {
      kind: "failed",
      attempts: main?.kind === "failed" ? main.attempts : 0,
      usages: main?.usages ?? [],
      terminal: true,
      wireCeiling: false,
      detail: `PASS_B_WIRE_CEILING_SIDECAR_CONFLICT: ${unitId} has no valid retryable paid ` +
        `main artifact beneath its sidecar; neither retained artifact was overwritten or re-bought.`,
    };
  }
  return {
    kind: "failed",
    attempts: main.attempts,
    usages: main.usages,
    terminal: true,
    wireCeiling: true,
    detail: sidecar.detail,
  };
}

/**
 * What is on disk for this chunk: a usable answer, a recorded failure with its attempt
 * count, or nothing at all. The three are DIFFERENT — collapsing "failed" into "nothing"
 * is what let a failing chunk be re-bought once per attempt, per wave, per recovery
 * instance, forever.
 *
 * A block-set mismatch reads as NOTHING, deliberately: the chunking changed under this run,
 * so the artifact answers a question nobody is asking any more.
 */
async function readChunkWithAuthority(
  env: Env,
  runId: string,
  n: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PassBUnitReadResult> {
  const unitId = `C${String(n).padStart(2, "0")}-${blocks[0]?.blockId ?? "missing"}`;
  const sidecar = await readUnit(
    env, runId, chunkWireCeilingKey(runId, n), "chunkId", unitId, `call_b_${n}`,
    blocks, evidenceBlocks, parserVersion, true,
  );
  let predecessor: PassBUnitStorageAuthority | null = null;
  const main = await readUnit(
    env, runId, chunkKey(runId, n), "chunkId", unitId, `call_b_${n}`,
    blocks, evidenceBlocks, parserVersion, false,
    (authority) => { predecessor = authority; },
  );
  return {
    artifact: combinePassBWireSidecar(
      unitId,
      sidecar?.kind === "failed" ? sidecar : null,
      main,
    ),
    predecessor,
  };
}

async function readChunk(
  env: Env,
  runId: string,
  n: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  return (await readChunkWithAuthority(
    env, runId, n, blocks, evidenceBlocks, parserVersion,
  )).artifact;
}

async function readSweepWithAuthority(
  env: Env,
  runId: string,
  i: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PassBUnitReadResult> {
  const unitId = `SWEEP${String(i + 1).padStart(2, "0")}`;
  const sidecar = await readUnit(
    env, runId, sweepWireCeilingKey(runId, i), "sweepId", unitId, `call_b_sweep_${i + 1}`,
    blocks, evidenceBlocks, parserVersion, true,
  );
  let predecessor: PassBUnitStorageAuthority | null = null;
  const main = await readUnit(
    env, runId, sweepKey(runId, i), "sweepId", unitId, `call_b_sweep_${i + 1}`,
    blocks, evidenceBlocks, parserVersion, false,
    (authority) => { predecessor = authority; },
  );
  return {
    artifact: combinePassBWireSidecar(
      unitId,
      sidecar?.kind === "failed" ? sidecar : null,
      main,
    ),
    predecessor,
  };
}

async function readSweep(
  env: Env,
  runId: string,
  i: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  return (await readSweepWithAuthority(
    env, runId, i, blocks, evidenceBlocks, parserVersion,
  )).artifact;
}

async function readUnit(
  env: Env,
  runId: string,
  key: string,
  idField: "chunkId" | "sweepId",
  unitId: string,
  expectedCallId: string,
  sourceBlocks: readonly SourceBlock[],
  evidenceSourceBlocks: readonly SourceBlock[],
  parserVersion: string,
  wireSidecarOnly = false,
  onStorageAuthority?: (authority: PassBUnitStorageAuthority) => void,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  const obj = await env.EVIDENCE.get(key);
  if (!obj) return null;
  let parsed: Record<string, unknown> | undefined;
  const invalid = (detail: string): FailedUnitArtifact => {
    const usages = Array.isArray(parsed?.["usages"])
      ? parsed!["usages"].filter((usage): usage is CallUsage => isCallUsage(usage))
      : [];
    const declared = parsed?.["attempts"];
    const attempts = Number.isSafeInteger(declared) && (declared as number) >= 0
      ? declared as number
      : usages.reduce((highest, usage) =>
          Math.max(highest, passBUsagePosition(usage, runId, unitId)?.issue ?? 0), 0);
    return {
      kind: "failed",
      attempts,
      usages,
      terminal: true,
      wireCeiling: false,
      detail: `PASS_B_UNIT_ARTIFACT_INVALID: ${unitId}: ${detail}. ` +
        `The retained exact-key artifact is terminal authority and will not be overwritten or re-bought.`,
    };
  };
  try {
    const bodyText = await obj.text();
    onStorageAuthority?.({ etag: obj.etag, bodyText });
    const decoded = JSON.parse(bodyText) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return invalid("artifact root is not an object");
    }
    parsed = decoded as Record<string, unknown>;
    if (parsed["parserVersion"] !== parserVersion || parsed["promptVersion"] !== PROMPT_VERSION_B) {
      return null;
    }
    if (parsed["providerPlanIdentity"] !== deepseekPassBIdentity(env)) return null;
    if (parsed["decoderIdentity"] !== PASS_B_DECODER_VERSION) return null;
    if (parsed[idField] !== unitId) return invalid(`${idField} does not match this artifact key`);
    const blockIds = Array.isArray(parsed["blockIds"]) ? (parsed["blockIds"] as string[]) : [];
    const expectedBlockIds = sourceBlocks.map((block) => block.blockId);
    if (
      blockIds.length !== expectedBlockIds.length ||
      blockIds.some((id, index) => id !== expectedBlockIds[index])
    ) return invalid("blockIds do not exactly match the current unit source authority");
    const evidenceBlockIds = Array.isArray(parsed["evidenceBlockIds"])
      ? parsed["evidenceBlockIds"] as unknown[]
      : [];
    const expectedEvidenceBlockIds = evidenceSourceBlocks.map((block) => block.blockId);
    if (
      evidenceBlockIds.length !== expectedEvidenceBlockIds.length ||
      evidenceBlockIds.some((id, index) => id !== expectedEvidenceBlockIds[index])
    ) return invalid("evidenceBlockIds do not exactly match the provider-visible source context");
    const usages = Array.isArray(parsed["usages"]) ? parsed["usages"] : null;
    const attempts = parsed["attempts"];
    if (
      usages === null || !usages.every(isCallUsage) ||
      !Number.isSafeInteger(attempts) || (attempts as number) < 0
    ) return invalid("attempts/usages are malformed");
    const zeroReceiptWireFailure =
      parsed["status"] === "failed" && parsed["failureStage"] === "wire-ceiling" &&
      attempts === 0 && usages.length === 0;
    const coherence = zeroReceiptWireFailure
      ? null
      : validatePassBUsageCoherence(
          usages as CallUsage[], runId, unitId, expectedCallId, attempts as number,
        );
    if (coherence !== null) return invalid(coherence);
    if (parsed["status"] === "failed") {
      if (
        typeof parsed["detail"] !== "string" || parsed["detail"].length === 0 ||
        typeof parsed["terminal"] !== "boolean" ||
        (parsed["failureStage"] !== "semantic-output" && parsed["failureStage"] !== "provider" &&
          parsed["failureStage"] !== "wire-ceiling") ||
        parsed["obligations"] !== undefined || parsed["dispositions"] !== undefined ||
        parsed["constructs"] !== undefined || parsed["ambiguities"] !== undefined ||
        parsed["unverifiable"] !== undefined
      ) return invalid("failed artifact shape is malformed or retains successful fields");
      const wireCeiling = parsed["failureStage"] === "wire-ceiling";
      if (
        wireCeiling &&
        ((attempts as number) !== 0 || usages.length !== 0 || parsed["terminal"] !== true ||
          !parsed["detail"].startsWith(`${EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED}:`) ||
          Object.hasOwn(parsed, "modelOutput"))
      ) return invalid("wire-ceiling failure is not an exact zero-receipt terminal refusal");
      if (!wireCeiling && (attempts as number) < 1) {
        return invalid("paid/semantic failure has no attempt");
      }
      if (wireSidecarOnly && !wireCeiling) {
        return invalid("wire-ceiling sidecar contains a non-wire failure stage");
      }
      if ((usages as CallUsage[]).some((usage) => usage.status === "ok")) {
        return invalid("failed artifact retains a successful provider receipt");
      }
      if (parsed["failureStage"] === "semantic-output") {
        if (typeof parsed["modelOutput"] !== "object" || parsed["modelOutput"] === null ||
            Array.isArray(parsed["modelOutput"]) ||
            !(usages as CallUsage[]).some((usage) => usage.status === "parse-failed")) {
          return invalid("semantic failure lacks raw-output/parse-failed authority");
        }
        // A non-terminal semantic failure is retryable; only terminal ones must still fail decode.
        if (parsed["terminal"] === true) {
          try {
            decodePassBOutput(parsed["modelOutput"], unitId, sourceBlocks, evidenceSourceBlocks);
            return invalid("semantic-failure raw output now decodes successfully");
          } catch (error) {
            if (!(error instanceof PassBOutputInvalid)) throw error;
          }
        }
      } else if (!wireCeiling && parsed["modelOutput"] !== null) {
        return invalid("provider failure must not claim a decoded model output");
      }
      return {
        kind: "failed",
        attempts: attempts as number,
        detail: parsed["detail"],
        usages: usages as CallUsage[],
        terminal: parsed["terminal"],
        wireCeiling,
      };
    }
    if (wireSidecarOnly) return invalid("wire-ceiling sidecar contains a successful artifact");
    if (parsed["status"] !== "ok") return invalid("status is neither ok nor failed");
    if (typeof parsed["modelOutput"] !== "object" || parsed["modelOutput"] === null ||
        Array.isArray(parsed["modelOutput"])) {
      return invalid("successful artifact has no raw model output");
    }
    if ((usages as CallUsage[]).filter((usage) => usage.status === "ok").length !== 1) {
      return invalid("successful artifact must retain exactly one successful provider receipt");
    }
    const output = decodePassBOutput(
      parsed["modelOutput"], unitId, sourceBlocks, evidenceSourceBlocks,
    );
    if (
      JSON.stringify(parsed["obligations"]) !== JSON.stringify(output.obligations) ||
      JSON.stringify(parsed["dispositions"]) !== JSON.stringify(output.dispositions) ||
      JSON.stringify(parsed["constructs"]) !== JSON.stringify(output.constructs) ||
      JSON.stringify(parsed["ambiguities"]) !== JSON.stringify(output.ambiguities) ||
      JSON.stringify(parsed["unverifiable"]) !== JSON.stringify(output.unverifiable)
    ) return invalid("persisted typed arrays do not exactly reconstruct from raw model output");
    // Limitations are written by salvage (per-item degradation). Absent means none.
    const storedLimitations: PassBLimitation[] = [];
    if (Array.isArray(parsed["limitations"])) {
      for (const raw of parsed["limitations"]) {
        if (
          typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
          typeof (raw as Record<string, unknown>)["unit"] === "string" &&
          Number.isSafeInteger((raw as Record<string, unknown>)["rowIndex"]) &&
          typeof (raw as Record<string, unknown>)["rowKind"] === "string" &&
          typeof (raw as Record<string, unknown>)["reason"] === "string"
        ) {
          storedLimitations.push(raw as PassBLimitation);
        }
      }
    }
    return {
      kind: "ok",
      obligations: output.obligations,
      dispositions: output.dispositions,
      constructs: output.constructs,
      ambiguities: output.ambiguities,
      unverifiable: output.unverifiable,
      limitations: storedLimitations,
      usages: usages as CallUsage[],
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "artifact JSON is unreadable");
  }
}

function passBUsagePosition(
  usage: CallUsage,
  runId: string,
  unitId: string,
): { issue: number; receipt: number } | null {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = usage.eventId?.match(new RegExp(
    `^core-model-call/pass-b/${escape(runId)}/${escape(unitId)}/issue-(\\d+)/receipt-(\\d+)$`,
    "u",
  ));
  if (!match) return null;
  const issue = Number(match[1]);
  const receipt = Number(match[2]);
  return Number.isSafeInteger(issue) && issue >= 1 && receipt === 1 ? { issue, receipt } : null;
}

function validatePassBUsageCoherence(
  usages: CallUsage[],
  runId: string,
  unitId: string,
  expectedCallId: string,
  attempts: number,
): string | null {
  const positions = usages.map((usage) => passBUsagePosition(usage, runId, unitId));
  if (positions.some((position) => position === null)) return "usage receipt is bound outside this unit";
  if (new Set(usages.map((usage) => usage.eventId)).size !== usages.length) {
    return "usage receipts contain duplicate event ids";
  }
  if (usages.some((usage) =>
    usage.role !== `extract-pass-b-${unitId}` ||
    usage.callId !== expectedCallId ||
    usage.provider !== "deepseek" ||
    usage.model !== DEFAULT_DEEPSEEK_FALLBACK_MODEL)) {
    return "usage receipt role/call/provider/model does not exactly match this Pass-B unit";
  }
  const issues = positions.map((position) => position!.issue);
  if (
    issues.length !== attempts ||
    new Set(issues).size !== attempts ||
    Array.from({ length: attempts }, (_, index) => index + 1).some((issue) => !issues.includes(issue))
  ) return "retained receipts must contain exactly one receipt for every issue without gaps";
  return null;
}

function isCallUsage(value: unknown): value is CallUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Partial<CallUsage>;
  const finiteNonNegative = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  return (
    typeof row.eventId === "string" &&
    row.eventId.startsWith("core-model-call/pass-b/") &&
    typeof row.callId === "string" &&
    row.callId.length > 0 &&
    typeof row.role === "string" &&
    row.role.length > 0 &&
    row.provider === "deepseek" &&
    typeof row.model === "string" &&
    row.model.length > 0 &&
    (row.status === "ok" || row.status === "parse-failed" || row.status === "error") &&
    finiteNonNegative(row.inputTokens) &&
    finiteNonNegative(row.outputTokens) &&
    finiteNonNegative(row.costUsd) &&
    finiteNonNegative(row.latencyMs) &&
    Number.isSafeInteger(row.attempts) &&
    (row.attempts ?? 0) >= 1 &&
    (
      row.usageSource === "provider-reported" ||
      row.usageSource === "conservative-ceiling" ||
      row.usageSource === "unverified-model-rate-ceiling"
    )
  );
}

function settlementUsages(
  runId: string,
  unitId: string,
  issue: number,
  usages: CallUsage[],
): CallUsage[] {
  return usages.map((usage, index) => ({
    ...usage,
    eventId: `core-model-call/pass-b/${runId}/${unitId}/issue-${issue}/receipt-${index + 1}`,
  }));
}

/**
 * Chunk on block boundaries, never inside one, and keep a table's cells together when they
 * fit: a cell separated from its table loses the coordinates that make it readable.
 */
export function chunkBlocks(blocks: SourceBlock[], maxChars: number, maxBlocks: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: SourceBlock[] = [];
  let size = 0;
  const flush = () => {
    if (current.length === 0) return;
    const n = chunks.length + 1;
    const first = current[0]!;
    chunks.push({ id: `C${String(n).padStart(2, "0")}-${first.blockId}`, n, blocks: current });
    current = [];
    size = 0;
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const cost = b.text.length + 40;
    const prev = current[current.length - 1];
    // A TABLE MAY BE SPLIT BETWEEN ROWS, NEVER INSIDE ONE. Refusing to split a table at all
    // is what produced a 46-cell chunk on the t1 questionnaire — one call owing 46 block
    // dispositions, which took 150 s when it succeeded and aborted at the timeout when it
    // did not, twice. A row is the smallest unit that still reads as a fact ("this option,
    // this column"), and every cell carries its own row/column labels, so a chunk that
    // starts mid-table is still self-describing.
    const sameTable = current.length > 0 && b.tableId !== null && prev !== undefined && b.tableId === prev.tableId;
    const sameRow = sameTable && b.coords !== null && prev?.coords != null && b.coords.row === prev.coords.row;
    const boundaryOk = current.length === 0 || !sameTable || !sameRow;
    if ((size + cost > maxChars || current.length >= maxBlocks) && current.length > 0 && boundaryOk) flush();
    current.push(b);
    size += cost;
  }
  flush();
  return chunks;
}

/**
 * The document's own global-instruction blocks, handed to every other chunk as context.
 * Selected STRUCTURALLY (the blocks before the first section heading that follows the
 * instruction heading), not by guessing at meaning, and capped so context never dwarfs the
 * chunk it is meant to qualify.
 */
export function globalContextBlocks(blocks: SourceBlock[], maxChars = 4_000): SourceBlock[] {
  const startIdx = blocks.findIndex(
    (b) => b.kind === "heading" && /instruction|programm|convention|general/i.test(b.text),
  );
  if (startIdx === -1) return [];
  const out: SourceBlock[] = [];
  let size = 0;
  for (let i = startIdx; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (i > startIdx && b.kind === "heading") break;
    size += b.text.length;
    if (size > maxChars) break;
    out.push(b);
  }
  return out;
}
