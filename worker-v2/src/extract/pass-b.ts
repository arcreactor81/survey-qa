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
} from "../llm/deepseek";
import { ModelCallError } from "../llm/chat";
import { PROMPT_VERSION_B, SYSTEM_B, userMessageB, userMessageSweep } from "./prompts";
import { annotate, DOCX_BLOCKS_VERSION } from "./docx-blocks";
import type { CallUsage, ParsedDocument, PassResult, RawRequirement, SourceBlock } from "./types";
import { sha256Hex } from "../store/hash";
import {
  decodePassBOutput,
  PASS_B_DECODER_VERSION,
  PassBOutputInvalid,
} from "./pass-b-decode";
import { k } from "../keys";

export { decodePassBOutput, PASS_B_DECODER_VERSION, PassBOutputInvalid };

export const PASS_B_VERSION = PROMPT_VERSION_B;

/** Where each chunk lands the instant it returns. */
const chunkKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-b", `chunk-${String(n).padStart(2, "0")}.json`);

/** Where each sweep call lands. Read back on resume — it used to be write-only. */
const sweepKey = (runId: string, i: number) =>
  k("runs", runId, "extraction", "pass-b", `sweep${String(i + 1).padStart(2, "0")}.json`);

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
  | { kind: "invalid"; detail: string; accountingCalls: CallUsage[]; slice: PassBSlice };

export const PASS_B_COMPLETION_KEYS = [
  "parserVersion", "promptVersion", "pass", "provider", "model", "providerPlanIdentity",
  "requirements", "ambiguities", "unverifiable", "dispositions", "constructs", "failedUnits",
  "calls", "slice", "issuedCalls", "accountingCalls",
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
      "failedUnits", "calls", "issuedCalls", "accountingCalls",
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

export async function runPassB(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  onProgress?: (msg: string) => Promise<void>,
  options?: PassBSliceOptions,
): Promise<PassBResult> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  // Compute once before reading or buying anything. Stored units from another model
  // plan are not answers to this run, even when their block ids happen to match.
  const providerPlanIdentity = deepseekPassBIdentity(env);
  const chunks = chunkBlocks(doc.blocks, num(env.EXTRACT_CHUNK_CHARS, 5_000), num(env.EXTRACT_CHUNK_MAX_BLOCKS, 45));
  const contextBlocks = globalContextBlocks(doc.blocks, num(env.EXTRACT_CONTEXT_CHARS, 4_000));
  const contextIds = new Set(contextBlocks.map((b) => b.blockId));
  const evidenceBlocksFor = (owned: readonly SourceBlock[], contextIncluded: boolean): SourceBlock[] => {
    if (!contextIncluded) return [...owned];
    const byId = new Map<string, SourceBlock>();
    for (const block of [...owned, ...contextBlocks]) byId.set(block.blockId, block);
    return [...byId.values()];
  };

  const requirements: RawRequirement[] = [];
  const ambiguities: PassResult["ambiguities"] = [];
  const unverifiable: PassResult["unverifiable"] = [];
  const dispositions: PassResult["dispositions"] = [];
  const constructs: PassResult["constructs"] = [];
  const failedUnits: PassResult["failedUnits"] = [];
  const calls: CallUsage[] = [];
  const issuedCalls: CallUsage[] = [];
  const accountingCalls: CallUsage[] = [];

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
  const mayIssue = (): boolean => {
    if (terminalFailure) return false;
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
  let landed = 0;
  for (const chunk of chunks) {
    const blockIds = chunk.blocks.map((b) => b.blockId);
    const includesContext = !blockIds.some((id) => contextIds.has(id)) && contextBlocks.length > 0;
    const existing = await readChunk(
      env, runId, chunk.n, chunk.blocks, evidenceBlocksFor(chunk.blocks, includesContext), parserVersion,
    );

    if (existing === null) {
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
        todo.push(chunk);
        continue;
      }
      landed += 1;
      terminalFailure = true;
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
  const concurrency = Math.max(1, num(env.EXTRACT_CHUNK_CONCURRENCY, 3));
  const queue = [...todo];
  const deferred: Chunk[] = [];
  /**
   * Chunks that FAILED in this slice and still hold re-issue budget. They are work
   * REMAINING, not work done: `done` must stay false so the next wave spends the budget the
   * artifact says is left, and the counter is bounded by EXTRACT_CHUNK_MAX_ISSUES so this
   * can never become a loop.
   */
  let retriableFailures = 0;

  const runChunk = async (chunk: Chunk): Promise<void> => {
    const blockIds = chunk.blocks.map((b) => b.blockId);
    // The context block is omitted for the chunk that CONTAINS the global instructions:
    // showing a chunk to itself as "do not extract from this" would suppress the very
    // requirements that chunk exists to produce.
    const overlapsContext = blockIds.some((id) => contextIds.has(id));
    const context = overlapsContext || contextBlocks.length === 0 ? null : annotate(contextBlocks);
    const evidenceBlocks = evidenceBlocksFor(chunk.blocks, context !== null);
    // This count came from the same strict decoder that admitted the failed artifact in
    // phase 1. A second, weaker read used to let a stale parser/prompt failure consume the
    // current retry budget even after `readChunk` had rejected it.
    const priorAttempts = priorAttemptsByChunk.get(chunk.n) ?? 0;
    const priorUsages = priorUsagesByChunk.get(chunk.n) ?? [];

    let purchasedUsages: CallUsage[] = [];
    let rawModelOutput: Record<string, unknown> | null = null;
    try {
      const outcome = await deepseekPassBJson(env, {
        system: SYSTEM_B,
        user: userMessageB(documentName, chunk.id, annotate(chunk.blocks), context, blockIds),
        maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
        role: `extract-pass-b-${chunk.id}`,
        callId: `call_b_${chunk.n}`,
        maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
      });
      const { value } = outcome;
      rawModelOutput = value;
      purchasedUsages = settlementUsages(runId, chunk.id, priorAttempts + 1, [outcome.usage]);
      const decoded = decodePassBOutput(value, chunk.id, chunk.blocks, evidenceBlocks);
      calls.push(...purchasedUsages);
      issuedCalls.push(...purchasedUsages);
      accountingCalls.push(...purchasedUsages);

      // PERSIST FIRST, ACCUMULATE SECOND.
      await env.EVIDENCE.put(
        chunkKey(runId, chunk.n),
        JSON.stringify(
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
        ),
        { httpMetadata: { contentType: "application/json" } },
      );

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
      if (!(err instanceof PassBOutputInvalid) && !(err instanceof ModelCallError)) throw err;
      const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
      const semanticFailure = err instanceof PassBOutputInvalid;
      const failureUsages: CallUsage[] = semanticFailure
        ? purchasedUsages.map((usage) => ({ ...usage, status: "parse-failed", detail }))
        : err instanceof ModelCallError
          ? settlementUsages(runId, chunk.id, priorAttempts + 1, [err.usage])
          : [];
      calls.push(...failureUsages);
      issuedCalls.push(...failureUsages);
      accountingCalls.push(...failureUsages);
      const attempts = priorAttempts + 1;
      const terminal = semanticFailure || attempts >= maxIssues;
      if (terminal) terminalFailure = true;
      failedUnits.push({ unit: chunk.id, blockIds, detail });
      unresolvedFor(blockIds, `chunk ${chunk.id} failed: ${detail}`);
      await env.EVIDENCE.put(
        chunkKey(runId, chunk.n),
        JSON.stringify(
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
        ),
        { httpMetadata: { contentType: "application/json" } },
      );
      if (!terminal) retriableFailures += 1;
      await reportProgress(
        onProgress,
        `pass B ${chunk.id}: FAILED (attempt ${attempts} of ${maxIssues}) — ${detail.slice(0, 120)}`,
      );
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

  landed += todo.length - deferred.length - retriableFailures;
  const chunksRemaining = deferred.length + retriableFailures;

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

  if (chunksRemaining === 0 && !terminalFailure && failedUnits.length === 0) {
    const unaccounted = unaccountedBlocks(doc.blocks, requirements, dispositions);

    for (let i = 0; i < sweepMax && i * sweepBlocksPerCall < unaccounted.length; i++) {
      const slice = unaccounted.slice(i * sweepBlocksPerCall, (i + 1) * sweepBlocksPerCall);
      const sweepId = `SWEEP${String(i + 1).padStart(2, "0")}`;
      const allowed = new Set(slice.map((b) => b.blockId));
      const sweepEvidenceBlocks = evidenceBlocksFor(slice, contextBlocks.length > 0);

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
      const existing = await readSweep(env, runId, i, slice, sweepEvidenceBlocks, parserVersion);
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
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail: existing.detail });
        break;
      }
      if (!mayIssue()) {
        sweepRemaining += 1;
        continue;
      }
      issued += 1;
      sweepCallsIssued += 1;
      const priorAttempts = existing && existing.kind === "failed" ? existing.attempts : 0;
      const priorUsages = existing && existing.kind === "failed" ? existing.usages : [];

      let purchasedUsages: CallUsage[] = [];
      let rawModelOutput: Record<string, unknown> | null = null;
      try {
        const outcome = await deepseekPassBJson(env, {
          system: SYSTEM_B,
          user: userMessageSweep(
            documentName,
            sweepId,
            annotate(slice),
            contextBlocks.length > 0 ? annotate(contextBlocks) : null,
            [...allowed],
          ),
          maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
          role: `extract-pass-b-${sweepId}`,
          callId: `call_b_sweep_${i + 1}`,
          maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
        });
        const { value } = outcome;
        rawModelOutput = value;
        purchasedUsages = settlementUsages(runId, sweepId, priorAttempts + 1, [outcome.usage]);
        const decoded = decodePassBOutput(value, sweepId, slice, sweepEvidenceBlocks);
        calls.push(...purchasedUsages);
        issuedCalls.push(...purchasedUsages);
        accountingCalls.push(...purchasedUsages);
        await env.EVIDENCE.put(
          sweepKey(runId, i),
          JSON.stringify(
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
          ),
          { httpMetadata: { contentType: "application/json" } },
        );
        absorb(decoded.obligations, decoded.dispositions, decoded.ambiguities, decoded.unverifiable);
        await reportProgress(onProgress,
          `pass B ${sweepId}: accounted for ${decoded.dispositions.length}/${allowed.size} ` +
            `previously unaccounted blocks (+${decoded.obligations.length} obligations)`,
        );
      } catch (err) {
        if (!(err instanceof PassBOutputInvalid) && !(err instanceof ModelCallError)) throw err;
        const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
        const semanticFailure = err instanceof PassBOutputInvalid;
        const failureUsages: CallUsage[] = semanticFailure
          ? purchasedUsages.map((usage) => ({ ...usage, status: "parse-failed", detail }))
          : err instanceof ModelCallError
            ? settlementUsages(runId, sweepId, priorAttempts + 1, [err.usage])
            : [];
        calls.push(...failureUsages);
        issuedCalls.push(...failureUsages);
        accountingCalls.push(...failureUsages);
        const attempts = priorAttempts + 1;
        const terminal = semanticFailure || attempts >= maxIssues;
        if (terminal) terminalFailure = true;
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail });
        // A failed sweep call is an artifact too, so its retries are bounded the same way a
        // chunk's are rather than being re-bought once per wave.
        await env.EVIDENCE.put(
          sweepKey(runId, i),
          JSON.stringify(
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
          ),
          { httpMetadata: { contentType: "application/json" } },
        );
        if (!terminal) sweepRemaining += 1;
        await reportProgress(
          onProgress,
          `pass B ${sweepId}: FAILED (attempt ${attempts} of ${maxIssues}) — ${detail.slice(0, 120)}`,
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
    done: chunksRemaining === 0 && sweepRemaining === 0 && !terminalFailure && failedUnits.length === 0,
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
    calls,
    slice,
    issuedCalls,
    accountingCalls,
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
  const accountingCalls: CallUsage[] = [];
  let chunksLanded = 0;
  let expectedSweepCalls = 0;
  let sweepsLanded = 0;

  const invalid = (detail: string): PassBAuthorityReconstruction => ({
    kind: "invalid",
    detail: `PASS_B_COMPLETED_ARTIFACT_INVALID: ${detail}. No unit was re-bought and no completed Pass-B payload is authorized.`,
    accountingCalls,
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
    if (unit === null) return invalid(`${chunk.id} is missing or belongs to a stale cache partition`);
    accountingCalls.push(...unit.usages);
    chunksLanded += 1;
    if (unit.kind === "failed") return invalid(`${chunk.id} retains failed authority: ${unit.detail}`);
    requirements.push(...unit.obligations);
    dispositions.push(...unit.dispositions);
    constructs.push(...unit.constructs);
    ambiguities.push(...unit.ambiguities);
    unverifiable.push(...unit.unverifiable);
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
    if (unit === null) return invalid(`${sweepId} is missing or belongs to a stale cache partition`);
    accountingCalls.push(...unit.usages);
    sweepsLanded += 1;
    if (unit.kind === "failed") return invalid(`${sweepId} retains failed authority: ${unit.detail}`);
    requirements.push(...unit.obligations);
    const owned = new Set(sourceBlocks.map((block) => block.blockId));
    for (let i = dispositions.length - 1; i >= 0; i -= 1) {
      if (owned.has(dispositions[i]!.blockId)) dispositions.splice(i, 1);
    }
    dispositions.push(...unit.dispositions);
    ambiguities.push(...unit.ambiguities);
    unverifiable.push(...unit.unverifiable);
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
    terminalFailure: false,
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
    failedUnits: [],
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
  usages: CallUsage[];
}

interface FailedUnitArtifact {
  kind: "failed";
  attempts: number;
  detail: string;
  usages: CallUsage[];
  terminal: boolean;
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
async function readChunk(
  env: Env,
  runId: string,
  n: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  const unitId = `C${String(n).padStart(2, "0")}-${blocks[0]?.blockId ?? "missing"}`;
  return readUnit(
    env, runId, chunkKey(runId, n), "chunkId", unitId, `call_b_${n}`,
    blocks, evidenceBlocks, parserVersion,
  );
}

async function readSweep(
  env: Env,
  runId: string,
  i: number,
  blocks: readonly SourceBlock[],
  evidenceBlocks: readonly SourceBlock[],
  parserVersion: string,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  const unitId = `SWEEP${String(i + 1).padStart(2, "0")}`;
  return readUnit(
    env, runId, sweepKey(runId, i), "sweepId", unitId, `call_b_sweep_${i + 1}`,
    blocks, evidenceBlocks, parserVersion,
  );
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
      detail: `PASS_B_UNIT_ARTIFACT_INVALID: ${unitId}: ${detail}. ` +
        `The retained exact-key artifact is terminal authority and will not be overwritten or re-bought.`,
    };
  };
  try {
    const decoded = JSON.parse(await obj.text()) as unknown;
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
      !Number.isSafeInteger(attempts) || (attempts as number) < 1
    ) return invalid("attempts/usages are malformed");
    const coherence = validatePassBUsageCoherence(
      usages as CallUsage[], runId, unitId, expectedCallId, attempts as number,
    );
    if (coherence !== null) return invalid(coherence);
    if (parsed["status"] === "failed") {
      if (
        typeof parsed["detail"] !== "string" || parsed["detail"].length === 0 ||
        typeof parsed["terminal"] !== "boolean" ||
        (parsed["failureStage"] !== "semantic-output" && parsed["failureStage"] !== "provider") ||
        parsed["obligations"] !== undefined || parsed["dispositions"] !== undefined ||
        parsed["constructs"] !== undefined || parsed["ambiguities"] !== undefined ||
        parsed["unverifiable"] !== undefined
      ) return invalid("failed artifact shape is malformed or retains successful fields");
      if ((usages as CallUsage[]).some((usage) => usage.status === "ok")) {
        return invalid("failed artifact retains a successful provider receipt");
      }
      if (parsed["failureStage"] === "semantic-output") {
        if (parsed["terminal"] !== true ||
            typeof parsed["modelOutput"] !== "object" || parsed["modelOutput"] === null ||
            Array.isArray(parsed["modelOutput"]) ||
            !(usages as CallUsage[]).some((usage) => usage.status === "parse-failed")) {
          return invalid("semantic failure lacks terminal raw-output/parse-failed authority");
        }
        try {
          decodePassBOutput(parsed["modelOutput"], unitId, sourceBlocks, evidenceSourceBlocks);
          return invalid("semantic-failure raw output now decodes successfully");
        } catch (error) {
          if (!(error instanceof PassBOutputInvalid)) throw error;
        }
      } else if (parsed["modelOutput"] !== null) {
        return invalid("provider failure must not claim a decoded model output");
      }
      return {
        kind: "failed",
        attempts: attempts as number,
        detail: parsed["detail"],
        usages: usages as CallUsage[],
        terminal: parsed["terminal"],
      };
    }
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
    return {
      kind: "ok",
      obligations: output.obligations,
      dispositions: output.dispositions,
      constructs: output.constructs,
      ambiguities: output.ambiguities,
      unverifiable: output.unverifiable,
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
