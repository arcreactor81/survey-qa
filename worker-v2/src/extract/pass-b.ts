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
 *      A PURCHASE IS NOT AN ATTEMPT. `llm/chat.ts` retries inside a single `deepseekJson`
 *      call: every attempt gets its own `AbortSignal.timeout(LLM_TIMEOUT_MS)` and token
 *      usage accrues across all of them, so ONE billed purchase can occupy
 *      `EXTRACT_MAX_ATTEMPTS × LLM_TIMEOUT_MS` of wall clock. EXTRACT_MAX_ATTEMPTS is now
 *      DECLARED in `wrangler.jsonc` at 2, matching chat.ts's own default; it used to be
 *      undeclared, which is exactly how a step timeout that budgeted a single attempt looked
 *      correct while the live value was 2 — the axe could still fall on a call that had
 *      already been billed twice, which is precisely the case this invariant exists to
 *      delete. So `passBCallCeilingMs` is derived from BOTH knobs.
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
import { deepseekJson } from "../llm/deepseek";
import { ModelCallError } from "../llm/chat";
import { PROMPT_VERSION_B, SYSTEM_B, userMessageB, userMessageSweep } from "./prompts";
import { annotate, DOCX_BLOCKS_VERSION } from "./docx-blocks";
import type { CallUsage, ParsedDocument, PassResult, RawRequirement, SourceBlock } from "./types";
import { asArray, coerceConstructs, coerceDispositions, coerceRequirement, coerceAmbiguities, coerceUnverifiable } from "./coerce";
import { k } from "../keys";

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

export type PassBResult = PassResult & {
  slice: PassBSlice;
  /**
   * The calls this slice ACTUALLY BOUGHT, as opposed to `calls`, which also carries the
   * zero-cost telemetry of every chunk reused from storage. The run's usage ledger must be
   * charged from THIS list: `modelCalls.used` counts calls, not rows, and re-counting a
   * reused chunk once per wave would trip CAP_MODEL_CALLS on phantom spend.
   */
  issuedCalls: CallUsage[];
};

/** Slack over and above the budget and one whole purchase: R2 I/O, parsing, scheduling. */
export const PASS_B_STEP_SLACK_MS = 60_000;

/** Wall clock ONE pass-B slice may spend issuing. Configuration, not a constant. */
export function passBWaveBudgetMs(env: Env): number {
  return Math.max(0, num(env.EXTRACT_WAVE_BUDGET_MS, 600_000));
}

/**
 * THE WORST-CASE WALL CLOCK OF ONE PURCHASE — not of one HTTP attempt.
 *
 * `llm/chat.ts` retries inside a single `deepseekJson` call: each attempt gets its own
 * `AbortSignal.timeout(LLM_TIMEOUT_MS)` and token usage accrues across all of them, so a
 * purchase that retries is billed for every attempt and occupies the sum of their ceilings.
 * Mirrors chat.ts's own `Math.max(1, maxAttempts ?? 2)` clamp exactly, so a zero or negative
 * knob cannot make this number smaller than the code it is describing.
 */
export function passBCallCeilingMs(env: Env): number {
  return Math.max(1, num(env.EXTRACT_MAX_ATTEMPTS, 2)) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));
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
  const chunks = chunkBlocks(doc.blocks, num(env.EXTRACT_CHUNK_CHARS, 5_000), num(env.EXTRACT_CHUNK_MAX_BLOCKS, 45));
  const contextBlocks = globalContextBlocks(doc.blocks, num(env.EXTRACT_CONTEXT_CHARS, 4_000));
  const contextIds = new Set(contextBlocks.map((b) => b.blockId));

  const requirements: RawRequirement[] = [];
  const ambiguities: PassResult["ambiguities"] = [];
  const unverifiable: PassResult["unverifiable"] = [];
  const dispositions: PassResult["dispositions"] = [];
  const constructs: PassResult["constructs"] = [];
  const failedUnits: PassResult["failedUnits"] = [];
  const calls: CallUsage[] = [];
  const issuedCalls: CallUsage[] = [];

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
  let landed = 0;
  for (const chunk of chunks) {
    const blockIds = chunk.blocks.map((b) => b.blockId);
    const allowed = new Set(blockIds);
    const existing = await readChunk(env, runId, chunk.n, allowed);

    if (existing === null) {
      todo.push(chunk);
      continue;
    }

    if (existing.kind === "failed") {
      // A FAILED CHUNK IS RE-ISSUED A BOUNDED NUMBER OF TIMES, ACROSS THE WHOLE RUN — the
      // artifact carries the count, so waves and recovery instances share one budget rather
      // than each getting a fresh one. Unbounded re-issue is how one chunk id came to be
      // billed 21–24 times during a recovery storm.
      if (existing.attempts < maxIssues) {
        priorAttemptsByChunk.set(chunk.n, existing.attempts);
        todo.push(chunk);
        continue;
      }
      landed += 1;
      failedUnits.push({ unit: chunk.id, blockIds, detail: existing.detail });
      unresolvedFor(blockIds, `chunk ${chunk.id} failed after ${existing.attempts} attempt(s): ${existing.detail}`);
      continue;
    }

    landed += 1;
    requirements.push(...existing.obligations);
    dispositions.push(...existing.dispositions);
    constructs.push(...existing.constructs);
    ambiguities.push(...existing.ambiguities);
    unverifiable.push(...existing.unverifiable);
    if (existing.usage) {
      calls.push({
        ...existing.usage,
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
    const allowed = new Set(blockIds);
    // The context block is omitted for the chunk that CONTAINS the global instructions:
    // showing a chunk to itself as "do not extract from this" would suppress the very
    // requirements that chunk exists to produce.
    const overlapsContext = blockIds.some((id) => contextIds.has(id));
    const context = overlapsContext || contextBlocks.length === 0 ? null : annotate(contextBlocks);
    // This count came from the same strict decoder that admitted the failed artifact in
    // phase 1. A second, weaker read used to let a stale parser/prompt failure consume the
    // current retry budget even after `readChunk` had rejected it.
    const priorAttempts = priorAttemptsByChunk.get(chunk.n) ?? 0;

    try {
      const { value, usage } = await deepseekJson(env, {
        system: SYSTEM_B,
        user: userMessageB(documentName, chunk.id, annotate(chunk.blocks), context, blockIds),
        maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
        role: `extract-pass-b-${chunk.id}`,
        callId: `call_b_${chunk.n}`,
        maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
      });
      calls.push(usage);
      issuedCalls.push(usage);

      const chunkReqs: RawRequirement[] = [];
      for (const raw of asArray(value["obligations"])) {
        const req = coerceRequirement(raw, "B", chunk.id, sectionScope(chunk.blocks));
        if (req) chunkReqs.push(req);
      }
      const chunkDisps = coerceDispositions(value["block_dispositions"], allowed);
      const chunkConstructs = coerceConstructs(value["construct_checklist"]);
      const chunkAmb = coerceAmbiguities(value["ambiguities"], "B");
      const chunkUnv = coerceUnverifiable(value["unverifiable_from_browser"], "B");

      // PERSIST FIRST, ACCUMULATE SECOND.
      await env.EVIDENCE.put(
        chunkKey(runId, chunk.n),
        JSON.stringify(
          {
            chunkId: chunk.id,
            blockIds,
            parserVersion: DOCX_BLOCKS_VERSION,
            promptVersion: PROMPT_VERSION_B,
            usage,
            obligations: chunkReqs,
            dispositions: chunkDisps,
            constructs: chunkConstructs,
            ambiguities: chunkAmb,
            unverifiable: chunkUnv,
            missingDispositions: blockIds.filter((id) => !chunkDisps.some((d) => d.blockId === id)),
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );

      requirements.push(...chunkReqs);
      dispositions.push(...chunkDisps);
      constructs.push(...chunkConstructs);
      ambiguities.push(...chunkAmb);
      unverifiable.push(...chunkUnv);

      // A block the model simply did not mention is UNRESOLVED, and it stays that way.
      for (const id of blockIds) {
        if (!chunkDisps.some((d) => d.blockId === id)) {
          dispositions.push({
            blockId: id,
            disposition: "unresolved",
            reason: `chunk ${chunk.id} returned no disposition for this block`,
          });
        }
      }

      await onProgress?.(
        `pass B ${chunk.id}: ${chunkReqs.length} obligations, ${chunkDisps.length}/${blockIds.length} blocks dispositioned`,
      );
    } catch (err) {
      if (err instanceof ModelCallError) {
        calls.push(err.usage);
        issuedCalls.push(err.usage);
      }
      const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
      const attempts = priorAttempts + 1;
      failedUnits.push({ unit: chunk.id, blockIds, detail });
      unresolvedFor(blockIds, `chunk ${chunk.id} failed: ${detail}`);
      await env.EVIDENCE.put(
        chunkKey(runId, chunk.n),
        JSON.stringify(
          {
            chunkId: chunk.id,
            blockIds,
            parserVersion: DOCX_BLOCKS_VERSION,
            promptVersion: PROMPT_VERSION_B,
            status: "failed",
            attempts,
            detail,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );
      if (attempts < maxIssues) retriableFailures += 1;
      await onProgress?.(`pass B ${chunk.id}: FAILED (attempt ${attempts} of ${maxIssues}) — ${detail.slice(0, 120)}`);
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

  if (chunksRemaining === 0) {
    const unaccounted = unaccountedBlocks(doc.blocks, requirements, dispositions);

    for (let i = 0; i < sweepMax && i * sweepBlocksPerCall < unaccounted.length; i++) {
      const slice = unaccounted.slice(i * sweepBlocksPerCall, (i + 1) * sweepBlocksPerCall);
      const sweepId = `SWEEP${String(i + 1).padStart(2, "0")}`;
      const allowed = new Set(slice.map((b) => b.blockId));

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
        for (const id of allowed) {
          if (!sweptDisps.some((d) => d.blockId === id)) {
            dispositions.push({
              blockId: id,
              disposition: "unresolved",
              reason: `${sweepId} returned no disposition for this block`,
            });
          }
        }
        ambiguities.push(...sweptAmb);
        unverifiable.push(...sweptUnv);
      };

      // RESUME, symmetric with the chunks. These artifacts were written and never read, so
      // every step retry re-bought all three sweep calls at full price.
      const existing = await readSweep(env, runId, i, allowed);
      if (existing && existing.kind === "ok") {
        if (existing.usage) {
          calls.push({ ...existing.usage, detail: "reused: this sweep call was already persisted", costUsd: 0 });
        }
        absorb(existing.obligations, existing.dispositions, existing.ambiguities, existing.unverifiable);
        await onProgress?.(`pass B ${sweepId}: reused a previously persisted sweep call`);
        continue;
      }
      if (existing && existing.kind === "failed" && existing.attempts >= maxIssues) {
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail: existing.detail });
        continue;
      }
      if (!mayIssue()) {
        sweepRemaining += 1;
        continue;
      }
      issued += 1;
      sweepCallsIssued += 1;
      const priorAttempts = existing && existing.kind === "failed" ? existing.attempts : 0;

      try {
        const { value, usage } = await deepseekJson(env, {
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
        calls.push(usage);
        issuedCalls.push(usage);
        const sweptReqs: RawRequirement[] = [];
        for (const raw of asArray(value["obligations"])) {
          const req = coerceRequirement(raw, "B", sweepId, "survey");
          if (req) sweptReqs.push(req);
        }
        const sweptDisps = coerceDispositions(value["block_dispositions"], allowed);
        const sweptAmb = coerceAmbiguities(value["ambiguities"], "B");
        const sweptUnv = coerceUnverifiable(value["unverifiable_from_browser"], "B");
        await env.EVIDENCE.put(
          sweepKey(runId, i),
          JSON.stringify(
            {
              sweepId,
              blockIds: [...allowed],
              parserVersion: DOCX_BLOCKS_VERSION,
              promptVersion: PROMPT_VERSION_B,
              usage,
              obligations: sweptReqs,
              dispositions: sweptDisps,
              ambiguities: sweptAmb,
              unverifiable: sweptUnv,
            },
            null,
            2,
          ),
          { httpMetadata: { contentType: "application/json" } },
        );
        absorb(sweptReqs, sweptDisps, sweptAmb, sweptUnv);
        await onProgress?.(
          `pass B ${sweepId}: accounted for ${sweptDisps.length}/${allowed.size} previously unaccounted blocks (+${sweptReqs.length} obligations)`,
        );
      } catch (err) {
        if (err instanceof ModelCallError) {
          calls.push(err.usage);
          issuedCalls.push(err.usage);
        }
        const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
        const attempts = priorAttempts + 1;
        failedUnits.push({ unit: sweepId, blockIds: [...allowed], detail });
        // A failed sweep call is an artifact too, so its retries are bounded the same way a
        // chunk's are rather than being re-bought once per wave.
        await env.EVIDENCE.put(
          sweepKey(runId, i),
          JSON.stringify(
            {
              sweepId,
              blockIds: [...allowed],
              parserVersion: DOCX_BLOCKS_VERSION,
              promptVersion: PROMPT_VERSION_B,
              status: "failed",
              attempts,
              detail,
            },
            null,
            2,
          ),
          { httpMetadata: { contentType: "application/json" } },
        );
        if (attempts < maxIssues) sweepRemaining += 1;
        await onProgress?.(`pass B ${sweepId}: FAILED (attempt ${attempts} of ${maxIssues}) — ${detail.slice(0, 120)}`);
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
    done: chunksRemaining === 0 && sweepRemaining === 0,
    chunksTotal: chunks.length,
    chunksLanded: landed,
    chunksIssued: issued - sweepCallsIssued,
    chunksRemaining,
    sweepCallsIssued,
    sweepRemaining,
    deadlineHit,
  };

  return {
    pass: "B",
    provider: "deepseek",
    model: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    requirements,
    ambiguities,
    unverifiable,
    dispositions,
    constructs,
    failedUnits,
    calls,
    slice,
    issuedCalls,
  };
}

/**
 * Blocks the chunk walk left unexplained, counted the SAME WAY the ledger counts them.
 *
 * The sweep must agree with `merge.ts#buildLedger` or it buys calls for blocks that were
 * never going to hold the gate open. The ledger accounts a grid cell through its table ROW;
 * so does this.
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
    b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;
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
  usage: CallUsage | null;
}

interface FailedUnitArtifact {
  kind: "failed";
  attempts: number;
  detail: string;
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
  allowed: Set<string>,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  return readUnit(env, chunkKey(runId, n), allowed);
}

async function readSweep(
  env: Env,
  runId: string,
  i: number,
  allowed: Set<string>,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  return readUnit(env, sweepKey(runId, i), allowed);
}

async function readUnit(
  env: Env,
  key: string,
  allowed: Set<string>,
): Promise<PersistedChunk | FailedUnitArtifact | null> {
  const obj = await env.EVIDENCE.get(key);
  if (!obj) return null;
  try {
    const parsed = JSON.parse(await obj.text()) as Record<string, unknown>;
    if (parsed["parserVersion"] !== DOCX_BLOCKS_VERSION || parsed["promptVersion"] !== PROMPT_VERSION_B) {
      return null;
    }
    const blockIds = Array.isArray(parsed["blockIds"]) ? (parsed["blockIds"] as string[]) : [];
    if (blockIds.length !== allowed.size || blockIds.some((id) => !allowed.has(id))) return null;
    if (parsed["status"] === "failed") {
      const attempts = typeof parsed["attempts"] === "number" ? parsed["attempts"] : 1;
      const detail = typeof parsed["detail"] === "string" ? parsed["detail"] : "no detail recorded";
      return { kind: "failed", attempts, detail };
    }
    if (!Array.isArray(parsed["obligations"])) return null;
    return {
      kind: "ok",
      obligations: parsed["obligations"] as RawRequirement[],
      dispositions: (parsed["dispositions"] ?? []) as PassResult["dispositions"],
      constructs: (parsed["constructs"] ?? []) as PassResult["constructs"],
      ambiguities: (parsed["ambiguities"] ?? []) as PassResult["ambiguities"],
      unverifiable: (parsed["unverifiable"] ?? []) as PassResult["unverifiable"],
      usage: (parsed["usage"] ?? null) as CallUsage | null,
    };
  } catch {
    return null;
  }
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

/** The scope a chunk's obligations default to when the model does not name one. */
function sectionScope(blocks: SourceBlock[]): string {
  const section = blocks.find((b) => b.section !== null)?.section ?? null;
  return section ? `section:${section.slice(0, 60)}` : "survey";
}
