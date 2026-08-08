/**
 * Bindings and configuration for survey-qa-v2.
 *
 * DELIBERATE NAMING: none of the binding names here match the production worker's
 * (`ARTIFACTS`, `RUN_WORKFLOW`). Copy-pasting a v1 helper into v2 therefore fails to
 * compile instead of silently writing into the v1 namespace. See MIGRATION.md.
 */

export interface SecretBinding {
  get(): Promise<string>;
}

export interface Env {
  // --- platform bindings ---
  ASSETS: Fetcher;
  /** Browser Rendering. Sessions are launched/reconnected per call; see workflow/browser-session.ts */
  BROWSER: Fetcher;
  /** SHARED bucket survey-qa-artifacts, but every key is forced under `v2/` by store/keys. */
  EVIDENCE: R2Bucket;
  /** Workflow binding — distinct name AND class from prod's RUN_WORKFLOW/RunWorkflow. */
  V2_RUN_WORKFLOW: Workflow;
  /** Workers AI. Optional at runtime: free neurons are exhausted, validators must degrade. */
  AI?: Ai;

  // --- secrets (Secrets Store bindings resolve via .get()) ---
  ANTHROPIC_API_KEY?: string | SecretBinding;
  DEEPSEEK_API_KEY?: string | SecretBinding;
  /**
   * The second extraction leg's credential. The owner's ruling is TWO independent passes,
   * Grok + DeepSeek, from day one — so this is not optional in spirit even though the type
   * allows it to be absent: `llm/chat.ts#keyFor` refuses to run one leg and present the
   * result as an agreement of two.
   */
  XAI_API_KEY?: string | SecretBinding;

  // --- AI Gateway routing (unified logging, caching, cost tracking, spend limits) ---
  // The provider legs BRANCH on these: absent, they call api.x.ai / api.deepseek.com
  // directly and the gateway can neither log nor cap the spend.
  /**
   * Deliberate bypass of the fail-closed gateway check in `llm/chat.ts`. Set to the string
   * "true" ONLY to call a provider directly (local dev against a stub, or a gateway
   * outage). Never set it in production: a direct call is unmetered and uncapped.
   */
  ALLOW_DIRECT_LLM_BASE_URL?: string;
  CF_AIG_ACCOUNT_ID?: string;
  CF_AIG_GATEWAY_ID?: string;
  /** Only for a gateway with authentication enabled; `firstgateway` needs none. */
  CF_AIG_TOKEN?: string;

  // --- namespace guard ---
  V2_PREFIX?: string;

  // --- retention posture (CONFIGURATION, never hardcoded) ---
  RETENTION_RAW_EVIDENCE_DAYS?: string;
  RETENTION_REPORT_DAYS?: string;
  RETENTION_CONTRACT_DAYS?: string;
  RETENTION_MODE?: string; // "report-only" | "delete"
  /** Objects the retention sweep may examine per cron tick. Keeps a tick bounded. */
  RETENTION_SCAN_BUDGET?: string;

  // --- browser session policy (spike-derived) ---
  BROWSER_KEEP_ALIVE_MS?: string;
  SESSION_MAX_AGE_MS?: string;
  EXEC_BATCH_MAX_MS?: string;
  EXEC_BATCH_MAX_ATTEMPTS?: string;
  EXEC_MAX_BATCHES?: string;

  // --- caps: each keeps its own name and denominator (ui-report-redesign §3.2) ---
  CAP_STANDARD_MAX_USD?: string;
  CAP_STANDARD_MIN_USD?: string;
  CAP_DEEP_MAX_USD?: string;
  CAP_VERIFICATION_RESERVE_FRACTION?: string;
  CAP_REPORT_RESERVE_FRACTION?: string;
  CAP_MODEL_CALLS?: string;
  CAP_TOOL_CALLS?: string;
  CAP_WALL_CLOCK_MS?: string;

  // --- open owner forks, surfaced as config rather than buried in code ---
  HUMAN_REVIEW_MODE?: string; // "always" | "high-risk-only"
  ORACLE_GAP_POLICY?: string; // "neutral-blocking" | "strict-fp"

  /**
   * PINNED PUBLIC KEYS for JudgementRecord attestation, as JSON:
   *   { "keys": { "<keyId>": { "publicKeySpki": "<base64 SPKI DER>", "trust": "production" } } }
   *
   * Configuration, not a secret — these are public keys, and pinning them in the config a
   * deploy ships is the point: a key that can certify current results must be a reviewed
   * change to this file, not something a caller supplies at request time.
   *
   * ABSENT MEANS FAIL-CLOSED, NOT OFF. With no registry the Worker cannot check any
   * judgement signature, so every judgement is `unusable` and the report may show it only
   * as a non-final operational diagnostic. That is the correct default for a build whose
   * judging stage is not yet wired: it degrades to "no current results", never to
   * "trusted because unchecked".
   */
  JUDGEMENT_KEY_REGISTRY?: string;

  /** Coherent target identity for a run when the caller does not supply one (§0). */
  DEFAULT_TARGET_BUILD_ID?: string;

  // --- per-arm deployment isolation (evaluation/arms/ARCHITECTURE.md) ---
  /**
   * The arm's build manifest, as a pinned JSON string — the SAME mechanism as
   * JUDGEMENT_KEY_REGISTRY above, and for the same reason: which components an arm runs
   * must be a reviewed edit to a config file, never something a request can supply.
   *
   * ABSENT MEANS BASELINE, and baseline is byte-for-byte today's behaviour. survey-qa-v2
   * carries no ARM_MANIFEST and is unaffected by the seam. An arm Worker carries one, and
   * a component it names that does not exist THROWS at resolve time rather than falling
   * back — a silent fallback is the wrong-arm failure the isolation exists to prevent.
   */
  ARM_MANIFEST?: string;
  /**
   * Build identity injected by evaluation/arms/build-all.mjs, as JSON: armId, sourceSha,
   * gitDirty, treeHash, manifestHash, componentSetHash, buildId. Echoed on every finding
   * and run record so a result carries proof of what produced it. ARCHITECTURE.md §5.
   */
  ARM_BUILD_IDENTITY?: string;

  // --- submission limits (advisory hardening; each keeps its own name) ---
  MAX_DOCUMENT_BYTES?: string;
  MAX_VIEWPORTS?: string;
  MAX_LOCALE_LENGTH?: string;
  /** "block-private" (default) | "allow-private" — outbound survey-URL target policy. */
  OUTBOUND_URL_POLICY?: string;

  // --- extraction models, prices and effort (each leg keeps its own name) ---
  GROK_MODEL?: string;
  GROK_REASONING_EFFORT?: string;
  GROK_INPUT_USD_PER_MTOK?: string;
  GROK_OUTPUT_USD_PER_MTOK?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_REASONING_EFFORT?: string;
  DEEPSEEK_INPUT_USD_PER_MTOK?: string;
  DEEPSEEK_OUTPUT_USD_PER_MTOK?: string;
  /** Characters of source per pass-B chunk. Smaller = more calls, less truncation risk. */
  EXTRACT_CHUNK_CHARS?: string;
  /**
   * Blocks per pass-B chunk, enforced ALONGSIDE the character budget. A table-heavy
   * questionnaire packs 60 short cells into 2 KB, and a chunk with 60 blocks owes 60 block
   * dispositions — which is what pushes an answer into truncation long before the
   * character budget notices.
   */
  EXTRACT_CHUNK_MAX_BLOCKS?: string;
  /** Characters of front matter repeated to later pass-B chunks as interpretive context. */
  EXTRACT_CONTEXT_CHARS?: string;
  /** Characters of source per pass-A window. A window is a WHOLE-DOCUMENT read when it fits. */
  EXTRACT_PASS_A_WINDOW_CHARS?: string;
  /**
   * WALL CLOCK ONE PASS-A WAVE MAY SPEND ISSUING NEW MODEL CALLS.
   *
   * Pass A splits a document larger than EXTRACT_PASS_A_WINDOW_CHARS into SERIAL windows,
   * and serial windows do not fit in one Workflow step: two windows is already 2 ×
   * LLM_TIMEOUT_MS = 600 s against the 480 s step the pass used to live in, and a ~360 KB
   * questionnaire is four. So the walk is spread over as many STEPS as the document needs,
   * and this is what one of them may spend.
   *
   * A wave stops ISSUING at this budget; it never abandons a call already in flight. The
   * step's own timeout is derived from this plus a whole PURCHASE (extract/pass-a.ts#
   * passAStepTimeoutMs), so the step axe can never kill — and force a re-buy of — a window
   * that was already paid for.
   */
  EXTRACT_PASS_A_WAVE_BUDGET_MS?: string;
  /**
   * How many pass-A wave STEPS a run may use before it stops with a named reason. A backstop,
   * not a tuning knob: waves are bounded by the WINDOW COUNT (a wave always issues at least
   * one call), and windows are 90 KB of source each, so a double-digit value covers documents
   * far larger than any real questionnaire. A run that exhausts this ends `failed` /
   * `extraction-pass-a-waves-exhausted` naming how many windows are still owed — never a
   * `partial-*` over a document nobody finished reading.
   */
  EXTRACT_PASS_A_MAX_WAVES?: string;
  /**
   * How many times ONE pass-A window may be BOUGHT across the whole run. The count lives in
   * the window's own R2 artifact, so waves, Workflow step retries and recovery instances
   * share one budget instead of each starting a fresh one. Kept separate from
   * EXTRACT_CHUNK_MAX_ISSUES because a pass-A window is a 90 KB purchase and a pass-B chunk
   * is a 5 KB one — the same number does not mean the same money.
   * `EXTRACT_MAX_ATTEMPTS` still absorbs transport blips INSIDE one purchase.
   */
  EXTRACT_PASS_A_WINDOW_MAX_ISSUES?: string;
  /** Output ceiling per extraction call. Reasoning shares this budget on both providers. */
  EXTRACT_MAX_OUTPUT_TOKENS?: string;
  /** Attempts per extraction call. Two is the money rule, not a default worth raising. */
  EXTRACT_MAX_ATTEMPTS?: string;
  /** Share of the run's cost cap extraction may spend before the reserves are at risk. */
  EXTRACT_BUDGET_FRACTION?: string;
  /** Pass-B chunks in flight at once. Chunks are independent; serial is just slower. */
  EXTRACT_CHUNK_CONCURRENCY?: string;
  /**
   * WALL CLOCK ONE PASS-B WAVE MAY SPEND ISSUING NEW MODEL CALLS.
   *
   * The pass-B fan-out does not fit in one Workflow step and no single number makes it fit:
   * ~23 chunks at concurrency 5 is 5 sequential rounds, and a round costs the SLOWEST of its
   * five calls (measured DeepSeek p90 206 s), so the reference document alone wants ~1000 s
   * against the 480 s step the fan-out used to live in. So the fan-out is spread over as
   * many STEPS as the document needs, and this is what one of them may spend.
   *
   * A wave stops ISSUING at this budget; it never abandons a call already in flight. The
   * step's own timeout is derived from this plus a whole PURCHASE (extract/pass-b.ts#
   * passBStepTimeoutMs, which counts EXTRACT_MAX_ATTEMPTS because chat.ts retries inside one
   * purchase and bills every attempt), so the step axe can never kill — and force a re-buy
   * of — a call that was already paid for. Same arithmetic as the pass-A twin above.
   */
  EXTRACT_WAVE_BUDGET_MS?: string;
  /**
   * How many pass-B wave STEPS a run may use before it stops with a named reason. This is a
   * backstop, not a tuning knob: waves scale with the document, and a run that exhausts this
   * ends `failed` / `extraction-pass-b-waves-exhausted` naming how many chunks are still
   * owed — never a `partial-*` over work that did not happen.
   */
  EXTRACT_PASS_B_MAX_WAVES?: string;
  /**
   * How many times ONE pass-B unit (a chunk, or a ledger-sweep call) may be BOUGHT across
   * the whole run. The count lives in the unit's own R2 artifact, so waves, Workflow step
   * retries and recovery instances share one budget instead of each starting a fresh one —
   * a gateway trace once showed a single chunk id billed 21–24 times during a recovery
   * storm. `EXTRACT_MAX_ATTEMPTS` still absorbs transport blips INSIDE one purchase.
   */
  EXTRACT_CHUNK_MAX_ISSUES?: string;
  /** Extra pass-B calls that re-ask about blocks the chunk walk left unaccounted. */
  EXTRACT_SWEEP_MAX_CALLS?: string;
  EXTRACT_SWEEP_BLOCKS_PER_CALL?: string;
  /** Per-call abort ceiling, in ms. A reasoning model on a dense chunk can need minutes. */
  LLM_TIMEOUT_MS?: string;

  // --- models / versions ---
  EXTRACTION_MODEL?: string;
  JUDGE_MODEL?: string;
  WORKERSAI_VALIDATOR_MODEL?: string;
  WORKERSAI_ENABLED?: string;
  AGGREGATOR_VERSION?: string;
  RESULT_POLICY_VERSION?: string;

  /**
   * LOCAL DEV ONLY. Deliberately absent from wrangler.jsonc so it cannot be deployed on:
   * `POST /api/v2/dev/seed` 404s unless this is exactly "enabled", which only
   * `wrangler dev --var DEV_SEED:enabled` can do. See api/devseed.ts.
   */
  DEV_SEED?: string;
}

export async function resolveSecret(v: string | SecretBinding | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v.get === "function") {
    try {
      const s = await v.get();
      return s && s.length > 0 ? s : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Effective run policy — the server is the authority. The landing page renders
// THIS, never the client's requested values (ui-report-redesign §4.2).
// ---------------------------------------------------------------------------

export interface RunLimits {
  maxUsd: number;
  verificationReserveUsd: number;
  reportReserveUsd: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

export interface RunPolicy {
  profile: "standard" | "deep";
  profileVersion: string;
  deepModeAvailable: boolean;
  limits: RunLimits;
  humanReviewMode: "always" | "high-risk-only";
  oracleGapPolicy: "neutral-blocking" | "strict-fp";
}

export function effectivePolicy(env: Env, requested: "standard" | "deep", deepAuthorized: boolean): RunPolicy {
  const profile: "standard" | "deep" = requested === "deep" && deepAuthorized ? "deep" : "standard";
  const maxUsd =
    profile === "deep" ? num(env.CAP_DEEP_MAX_USD, 75) : num(env.CAP_STANDARD_MAX_USD, 30);
  const vFrac = num(env.CAP_VERIFICATION_RESERVE_FRACTION, 0.15);
  const rFrac = num(env.CAP_REPORT_RESERVE_FRACTION, 0.1);
  // RESERVES MUST NOT EXCEED THE BUDGET. `capExceeded` computes
  // `spendable = maxUsd - verificationReserve - reportReserve`; if the fractions sum
  // past 1, spendable goes NEGATIVE and `usedUsd (0) >= spendable` fires cost-cap on
  // batch 0 of EVERY run — a config typo silently kills all runs. Clamp each fraction
  // to [0, 1] and refuse the combination outright (fail loud, not quiet).
  const saneV = Math.min(Math.max(vFrac, 0), 1);
  const saneR = Math.min(Math.max(rFrac, 0), 1);
  if (saneV + saneR > 1) {
    throw new Error(
      `CAP_VERIFICATION_RESERVE_FRACTION (${saneV}) + CAP_REPORT_RESERVE_FRACTION (${saneR}) exceed 1.0 — ` +
        "the verification and report reserves would consume the whole budget and every run would " +
        "trip cost-cap before exercising anything. Fix the env vars.",
    );
  }
  return {
    profile,
    profileVersion: `v2-profile/${profile}/1.0.0`,
    deepModeAvailable: deepAuthorized,
    limits: {
      maxUsd,
      verificationReserveUsd: round2(maxUsd * saneV),
      reportReserveUsd: round2(maxUsd * saneR),
      maxModelCalls: num(env.CAP_MODEL_CALLS, 400),
      maxToolCalls: num(env.CAP_TOOL_CALLS, 4000),
      maxWallClockMs: num(env.CAP_WALL_CLOCK_MS, 3_600_000),
    },
    humanReviewMode: env.HUMAN_REVIEW_MODE === "always" ? "always" : "high-risk-only",
    oracleGapPolicy: env.ORACLE_GAP_POLICY === "strict-fp" ? "strict-fp" : "neutral-blocking",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
