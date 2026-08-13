/**
 * PASS A — the whole-document, cross-cutting pass. GROK.
 *
 * ONE call over the ENTIRE document, hunting rules scoped to the survey rather than to a
 * question. The first real run's most expensive miss was exactly this class: a global
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
} from "../llm/grok";
import { deepseekGrokFallbackJson } from "../llm/deepseek";
import { ModelCallError, type ModelFailureKind } from "../llm/chat";
import { PROMPT_VERSION_A, SYSTEM_A, userMessageA } from "./prompts";
import type { CallUsage, ParsedDocument, PassResult, RawRequirement, SourceBlock } from "./types";
import { annotate, DOCX_BLOCKS_VERSION } from "./docx-blocks";
import { asArray, coerceRequirement, coerceAmbiguities, coerceUnverifiable } from "./coerce";
import { k } from "../keys";

export const PASS_A_VERSION = PROMPT_VERSION_A;
export const GROK_FALLBACK_TRIGGER_VERSION = "grok-flash-fallback-trigger/1.0.0";

export type PassAProviderIndependence = "independent" | "reduced-same-provider-fallback";

export interface GrokFallbackTrigger {
  kind: typeof GROK_FALLBACK_TRIGGER_VERSION;
  failureKind: ModelFailureKind;
  httpStatus: number | null;
  grokModel: typeof DEFAULT_GROK_MODEL;
  grokUsageEventId: string;
  detail: string;
}

export interface PassARouteReceipt {
  selected: "grok-4.6" | "deepseek-v4-flash";
  trigger: GrokFallbackTrigger | null;
}

/** Where each window lands the instant it returns. The unit of resume for this pass. */
const windowKey = (runId: string, n: number) =>
  k("runs", runId, "extraction", "pass-a", `window-${String(n).padStart(2, "0")}.json`);

/** Cross-references pass A resolved (or failed to), surfaced in the diff. */
export interface CrossRef {
  id: string;
  fromBlock: string | null;
  target: string;
  resolvedToBlock: string | null;
  statement: string;
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
};

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

export async function runPassA(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  onProgress?: (msg: string) => Promise<void>,
  options?: PassASliceOptions,
): Promise<PassAResult> {
  const parserVersion = doc.parserVersion ?? DOCX_BLOCKS_VERSION;
  const providerRouteIdentity = grokFlashRouteIdentity(env);
  // Local, NOT module scope: one isolate serves many runs, and a module-level accumulator
  // would let two concurrent extractions read each other's cross-references.
  const crossRefs: CrossRef[] = [];
  const windows = splitWindows(
    doc.blocks,
    num(env.EXTRACT_PASS_A_WINDOW_CHARS, 90_000),
    num(env.EXTRACT_PASS_A_WINDOW_MAX_BLOCKS, 250),
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
  let providerIndependence: PassAProviderIndependence = "independent";
  const model = DEFAULT_GROK_MODEL;

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

  let landed = 0;
  let remaining = 0;

  // WINDOWS ARE WALKED IN DOCUMENT ORDER, ONE AT A TIME. See the header for why this pass
  // does not fan out. The order matters beyond latency: it is what makes `requirements`,
  // `A-wN` origins and the diff's provenance identical regardless of which wave bought
  // which window.
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const n = i + 1;
    const blockIds = w.map((b) => b.blockId);
    const allowed = new Set(blockIds);
    const label =
      windows.length === 1 ? null : `window ${n} of ${windows.length} (${w[0]!.blockId}–${w[w.length - 1]!.blockId})`;
    const origin = windows.length === 1 ? "A" : `A-w${n}`;

    const absorb = (unit: PersistedWindow): void => {
      requirements.push(...unit.globalRules);
      crossRefs.push(...unit.crossRefs);
      ambiguities.push(...unit.ambiguities);
      unverifiable.push(...unit.unverifiable);
    };

    // -----------------------------------------------------------------------
    // RECLAIM. Free: an R2 read, never metered by the deadline.
    //
    // A window already on disk is a window already paid for. Re-running pass A after a
    // crash, a Workflow step retry, a wave boundary or a dev-server restart must not buy the
    // same answer twice — and because each artifact names the blocks it owns, a reclaimed
    // window is exactly as accountable as a fresh one.
    // -----------------------------------------------------------------------
    const existing = await readWindow(env, runId, n, allowed, parserVersion);

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
      await onProgress?.(`pass A ${origin}: reused a previously persisted window`);
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
        providerIndependence = "reduced-same-provider-fallback";
      }
    }

    // A FAILED WINDOW IS RE-ISSUED A BOUNDED NUMBER OF TIMES, ACROSS THE WHOLE RUN — the
    // artifact carries the count, so waves and recovery instances share one budget rather
    // than each getting a fresh one. Unbounded re-issue is how one pass-B chunk id came to
    // be billed 21–24 times during a recovery storm; the same arithmetic applies here, on a
    // call that costs far more.
    const pendingFlash = existing && existing.kind === "failed" &&
      existing.fallbackTrigger !== null &&
      !existing.usages.some((usage) => usage.provider === "deepseek");
    if (existing && existing.kind === "failed" && existing.attempts >= maxIssues && !pendingFlash) {
      landed += 1;
      failedUnits.push({
        unit: origin,
        blockIds,
        detail: `window ${origin} failed after ${existing.attempts} attempt(s): ${existing.detail}`,
      });
      continue;
    }

    const priorAttempts = existing && existing.kind === "failed" ? existing.attempts : 0;

    if (!mayIssue()) {
      remaining += 1;
      continue;
    }
    issued += 1;

    const purchasedUsages: CallUsage[] = [];
    let fallbackTrigger = existing && existing.kind === "failed" ? existing.fallbackTrigger : null;
    const priorHadFlash = priorUsages.some((usage) => usage.provider === "deepseek");
    const issue = pendingFlash ? Math.max(1, priorAttempts) : priorAttempts + 1;
    const optionsForCall = {
      system: SYSTEM_A,
      user: userMessageA(documentName, annotate(w), label),
      maxTokens: num(env.EXTRACT_MAX_OUTPUT_TOKENS, 32_000),
      role: `extract-pass-a${label ? `-w${n}` : ""}`,
      callId: `call_a_${n}`,
      maxAttempts: num(env.EXTRACT_MAX_ATTEMPTS, 2),
    };

    try {
      let value: Record<string, unknown> | null = null;
      let routeReceipt: PassARouteReceipt | null = null;

      if (fallbackTrigger === null) {
        try {
          const outcome = await grokJson(env, optionsForCall);
          const usage = settlementUsage(runId, origin, issue, 1, outcome.usage);
          purchasedUsages.push(usage);
          calls.push(usage);
          issuedCalls.push(usage);
          accountingCalls.push(usage);
          value = outcome.value;
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
          providerIndependence = "reduced-same-provider-fallback";

          // COMMIT AUTHORITY BEFORE EFFECT. If the isolate dies after this put, the next
          // invocation sees the exact paid Grok receipt and calls Flash directly. It cannot
          // retry Grok and erase the condition that authorized another provider purchase.
          await env.EVIDENCE.put(
            windowKey(runId, n),
            JSON.stringify({
              windowId: origin,
              windowNumber: n,
              blockIds,
              parserVersion,
              promptVersion: PROMPT_VERSION_A,
              providerRouteIdentity,
              status: "failed",
              attempts: issue,
              usages: [...priorUsages, ...purchasedUsages],
              fallbackTrigger,
              detail: `Flash fallback authorized but not yet landed: ${fallbackTrigger.detail}`,
            }, null, 2),
            { httpMetadata: { contentType: "application/json" } },
          );
        }
      }

      if (fallbackTrigger !== null) {
        providerIndependence = "reduced-same-provider-fallback";
        const outcome = await deepseekGrokFallbackJson(env, {
          ...optionsForCall,
          callId: `${optionsForCall.callId}:grok-fallback`,
        });
        const receiptIndex = priorHadFlash ? 1 : 2;
        const usage = settlementUsage(runId, origin, issue, receiptIndex, outcome.usage);
        purchasedUsages.push(usage);
        calls.push(usage);
        issuedCalls.push(usage);
        accountingCalls.push(usage);
        value = outcome.value;
        routeReceipt = { selected: "deepseek-v4-flash", trigger: fallbackTrigger };
      }
      if (value === null || routeReceipt === null) {
        throw new Error("pass-A provider route produced neither a primary nor a fallback outcome");
      }

      const windowRules: RawRequirement[] = [];
      for (const raw of asArray(value["global_rules"])) {
        const req = coerceRequirement(raw, "A", origin, "survey");
        if (req) windowRules.push(req);
      }
      // A cross-reference is not itself an obligation, but an UNRESOLVED one is a hole the
      // reviewer has to see, so they travel into the diff rather than being dropped here.
      // The fallback id is keyed on the WINDOW, not on how many cross-refs happened to
      // arrive before it: an id that shifted depending on which wave bought which window
      // would not survive a resume.
      const windowXrefs: CrossRef[] = [];
      for (const raw of asArray(value["cross_references"])) {
        const x = raw as Record<string, unknown>;
        const statement = typeof x["statement"] === "string" ? x["statement"] : "";
        if (statement.length === 0) continue;
        windowXrefs.push({
          id: String(x["id"] ?? `XREF-${n}-${windowXrefs.length + 1}`),
          fromBlock: typeof x["from_block"] === "string" ? x["from_block"] : null,
          target: String(x["target"] ?? ""),
          resolvedToBlock: typeof x["resolved_to_block"] === "string" ? x["resolved_to_block"] : null,
          statement,
        });
      }
      const windowAmb = coerceAmbiguities(value["ambiguities"], "A");
      const windowUnv = coerceUnverifiable(value["unverifiable_from_browser"], "A");

      // ONE OBJECT IS BOTH PERSISTED AND ABSORBED, so what a resumed wave reads back cannot
      // drift from what this wave used. Written as two literals it drifted silently once
      // already elsewhere in this codebase; here it would mean a resumed pass quietly
      // publishing less than the pass that paid for it.
      const landedWindow: PersistedWindow = {
        kind: "ok",
        globalRules: windowRules,
        crossRefs: windowXrefs,
        ambiguities: windowAmb,
        unverifiable: windowUnv,
        usages: [...priorUsages, ...purchasedUsages],
        routeReceipt,
      };

      // PERSIST FIRST, ACCUMULATE SECOND. A window that is on disk cannot be lost by
      // whatever happens to the next one — including the step timeout that used to make
      // every window in flight a re-purchase.
      await env.EVIDENCE.put(
        windowKey(runId, n),
        JSON.stringify(
          {
            windowId: origin,
            windowNumber: n,
            blockIds,
            parserVersion,
            promptVersion: PROMPT_VERSION_A,
            providerRouteIdentity,
            ...landedWindow,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );

      landed += 1;
      routeReceipts.push(routeReceipt);
      absorb(landedWindow);
      await onProgress?.(
        `pass A ${origin}: ${windowRules.length} cross-cutting rule(s), ${windowXrefs.length} cross-reference(s) ` +
          `over ${blockIds.length} block(s)`,
      );
    } catch (err) {
      if (err instanceof ModelCallError) {
        const receiptIndex = fallbackTrigger !== null && !priorHadFlash ? 2 : 1;
        const usage = settlementUsage(runId, origin, issue, receiptIndex, err.usage);
        purchasedUsages.push(usage);
        calls.push(usage);
        issuedCalls.push(usage);
        accountingCalls.push(usage);
      }
      const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
      const attempts = priorAttempts + 1;
      failedUnits.push({ unit: origin, blockIds, detail });
      // A failed window is an artifact too, so its re-purchases are bounded the same way a
      // successful one's are cached rather than being re-bought once per wave.
      await env.EVIDENCE.put(
        windowKey(runId, n),
        JSON.stringify(
          {
            windowId: origin,
            windowNumber: n,
            blockIds,
            parserVersion,
            promptVersion: PROMPT_VERSION_A,
            providerRouteIdentity,
            status: "failed",
            attempts: Math.max(attempts, issue),
            usages: [...priorUsages, ...purchasedUsages],
            fallbackTrigger,
            detail,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );
      if (attempts < maxIssues) remaining += 1;
      else landed += 1;
      await onProgress?.(`pass A ${origin}: FAILED (attempt ${attempts} of ${maxIssues}) — ${detail.slice(0, 120)}`);
    }
  }

  const slice: PassASlice = {
    done: remaining === 0,
    windowsTotal: windows.length,
    windowsLanded: landed,
    windowsIssued: issued,
    windowsRemaining: remaining,
    deadlineHit,
  };

  return {
    pass: "A",
    provider: "grok-primary/deepseek-flash-fallback",
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
    slice,
    issuedCalls,
    accountingCalls,
  };
}

interface PersistedWindow {
  kind: "ok";
  globalRules: RawRequirement[];
  crossRefs: CrossRef[];
  ambiguities: PassResult["ambiguities"];
  unverifiable: PassResult["unverifiable"];
  usages: CallUsage[];
  routeReceipt: PassARouteReceipt;
}

interface FailedWindowArtifact {
  kind: "failed";
  attempts: number;
  detail: string;
  usages: CallUsage[];
  fallbackTrigger: GrokFallbackTrigger | null;
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
  allowed: Set<string>,
  parserVersion: string,
): Promise<PersistedWindow | FailedWindowArtifact | null> {
  const obj = await env.EVIDENCE.get(windowKey(runId, n));
  if (!obj) return null;
  try {
    const parsed = JSON.parse(await obj.text()) as Record<string, unknown>;
    if (parsed["parserVersion"] !== parserVersion || parsed["promptVersion"] !== PROMPT_VERSION_A) {
      return null;
    }
    if (parsed["providerRouteIdentity"] !== grokFlashRouteIdentity(env)) return null;
    const blockIds = Array.isArray(parsed["blockIds"]) ? (parsed["blockIds"] as string[]) : [];
    if (blockIds.length !== allowed.size || blockIds.some((id) => !allowed.has(id))) return null;
    const usages = Array.isArray(parsed["usages"]) ? parsed["usages"] : null;
    if (usages === null || !usages.every(isCallUsage)) return null;
    if (parsed["status"] === "failed") {
      const attempts = parsed["attempts"];
      if (!Number.isSafeInteger(attempts) || (attempts as number) < 1) return null;
      const detail = typeof parsed["detail"] === "string" ? parsed["detail"] : "no detail recorded";
      const fallbackTrigger = parsed["fallbackTrigger"] === null
        ? null
        : parseFallbackTrigger(parsed["fallbackTrigger"], usages as CallUsage[]);
      if (parsed["fallbackTrigger"] !== null && fallbackTrigger === null) return null;
      return { kind: "failed", attempts: attempts as number, detail, usages: usages as CallUsage[], fallbackTrigger };
    }
    if (!Array.isArray(parsed["globalRules"])) return null;
    const routeReceipt = parseRouteReceipt(parsed["routeReceipt"], usages as CallUsage[]);
    if (routeReceipt === null) return null;
    return {
      kind: "ok",
      globalRules: parsed["globalRules"] as RawRequirement[],
      // Cross-references are pass A's alone. An artifact that dropped them would let a
      // resumed run report a SHORTER diff than the run that paid for it.
      crossRefs: (parsed["crossRefs"] ?? []) as CrossRef[],
      ambiguities: (parsed["ambiguities"] ?? []) as PassResult["ambiguities"],
      unverifiable: (parsed["unverifiable"] ?? []) as PassResult["unverifiable"],
      usages: usages as CallUsage[],
      routeReceipt,
    };
  } catch {
    return null;
  }
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
    (row.provider === "grok" || row.provider === "deepseek") &&
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
  if (!bound || bound.provider !== "grok" || bound.status !== "error" || bound.model !== DEFAULT_GROK_MODEL) return null;
  return row as GrokFallbackTrigger;
}

function parseRouteReceipt(value: unknown, usages: CallUsage[]): PassARouteReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Partial<PassARouteReceipt>;
  if (row.selected === "grok-4.6" && row.trigger === null) {
    return usages.some((usage) => usage.provider === "deepseek") ? null : { selected: row.selected, trigger: null };
  }
  if (row.selected !== "deepseek-v4-flash") return null;
  const trigger = parseFallbackTrigger(row.trigger, usages);
  if (trigger === null || !usages.some((usage) => usage.provider === "deepseek" && usage.model === "deepseek-v4-flash")) {
    return null;
  }
  return { selected: row.selected, trigger };
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
  if (rawReceipts.some((receipt) => parseRouteReceipt(receipt, usages) === null)) return null;
  const derived: PassAProviderIndependence = triggers.length > 0
    ? "reduced-same-provider-fallback"
    : "independent";
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
