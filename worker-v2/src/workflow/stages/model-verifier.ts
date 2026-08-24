/**
 * MODEL VERIFIER LANE v1 — exact-text/copy family only.
 *
 * THE OWNER RULING THIS OBEYS (docs/OWNER-RULINGS.md, 2 Aug): a model may NEVER emit a
 * fail/violated verdict. The output space is {verified, insufficient} plus FLAGS rendered
 * separately. That is enforced here structurally: the return type is a `PredicateResult`
 * whose `outcome` is constrained to `"satisfied" | "insufficient"`, and no code path in
 * this file constructs `"violated"`. The mutation campaign (`tools/mutate-model-verifier.mjs`)
 * proves that guard is load-bearing.
 *
 * WHAT THIS LANE DOES. It compares the SEALED REQUIREMENT'S text (the document's own copy,
 * from `displayQuote` or `normativeStatement`) against the RENDERED SCREEN TEXT of the walk
 * artifact. The model receives both and returns a structured judgment of whether the screen
 * reflects the requirement. No survey-specific values appear in the prompt: it is built
 * from the sealed contract's own text plus the recorded screen text.
 *
 * WHEN IT RUNS. Only when:
 *   1. `env.WORKERSAI_ENABLED === "true" && !!env.AI` — the existing gate in
 *      `verify-observations.ts` line 708.
 *   2. The deterministic verifier returned `insufficient` with `NO_TYPED_EXPECTATION`.
 *   3. The sealed case kind is `"copy"`.
 *
 * WHEN IT DOES NOT RUN (the gate is off), the behavior is byte-identical to the base:
 * `NO_TYPED_EXPECTATION` / `insufficient`, exactly as before.
 *
 * PROVENANCE. Every decision carries: the model id used, a SHA-256 hash of the prompt
 * text (so prompt refinements are versioned), and the evidence artifact ids consulted.
 * These travel on the `verifierVersion` and `detail` fields of the observation's verifier
 * stamp.
 *
 * SPEND. Every model call produces a `ModelCallUsageEvent` routed through the existing
 * `pushModelUsageStrict` path in `store/usage.ts`, when a checkpoint fence is available.
 * Workers AI included models report no per-call cost and no token counts, so the event
 * records the model id with zero tokens and zero cost — the same shape the visual usage
 * path uses for unknown-cost providers. A call that fails still books its usage event
 * (a failed call spent compute time) and demotes to a named `insufficient`
 * (`MODEL_CALL_FAILED`), never populating any payload key that downstream code reads as
 * a verdict signal.
 *
 * FLAGS. When the model detects a textual discrepancy, it is recorded as a flag in the
 * decision's `detail` field with the prefix `[FLAG:COPY_DISCREPANCY]`. Flags are metadata
 * for the report renderer; they never change a verdict count and never map to
 * `contradicted`/`fail`.
 */

import type { Env } from "../../types/env";
import type {
  FacetInstance,
} from "../../types/record";
import type { PathObservation, RenderedScreen } from "../../browser/types";
import type { PredicateResult } from "./verify-observations";
import { VERIFIER_REASON, type VerifierReason } from "./verify-observations";
import type { Fence } from "../../store/checkpoint";
import { modelUsage, pushModelUsageStrict } from "../../store/usage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MODEL_VERIFIER_VERSION = "v2-model-verifier/1.0.0";

/** The Workers AI model used for v1 copy verification. */
const COPY_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";

const COPY_PREDICATE_ID = "model-copy/1.0.0";

/**
 * Maximum number of screens to check in the no-target-question (survey-wide copy)
 * path. Bounds the model calls so a walk with many screens does not exhaust the
 * Workers AI quota or the subrequest budget.
 */
const MAX_SCREENS_NO_TARGET = 3;

/**
 * MODEL DECISION TYPE — structurally constrained to {satisfied, insufficient}.
 *
 * THE FAIL GUARD IS HERE. `"violated"` is not in this union, and every return site in this
 * file types through this. A mutation that adds `"violated"` to this type would let the
 * downstream `OUTCOME_TO_DECISION` map it to `contradicted` → `fail`, defeating the owner
 * ruling. The mutation campaign proves the guard is load-bearing.
 */
type ModelDecisionOutcome = "satisfied" | "insufficient";

// ---------------------------------------------------------------------------
// Prompt construction — no survey-specific values
// ---------------------------------------------------------------------------

/**
 * THE PROMPT IS BUILT FROM THE SEALED CONTRACT'S OWN TEXT PLUS THE RECORDED SCREEN TEXT.
 * No survey name, no question id, no option label appears in the template itself. The
 * model sees only what the contract and the artifact supply.
 */
function buildCopyPrompt(requirementText: string, screenText: string): string {
  return (
    `You are a text-comparison tool for survey questionnaire quality assurance.\n\n` +
    `TASK: Compare the REQUIREMENT TEXT from a survey questionnaire document against the ` +
    `SCREEN TEXT captured from a live survey page. Determine whether the screen text ` +
    `faithfully reflects the requirement.\n\n` +
    `REQUIREMENT TEXT (from the document):\n` +
    `---\n${requirementText}\n---\n\n` +
    `SCREEN TEXT (from the live survey):\n` +
    `---\n${screenText}\n---\n\n` +
    `INSTRUCTIONS:\n` +
    `- If the screen text contains the substance of the requirement (exact or near-exact ` +
    `wording match), respond with: VERIFIED\n` +
    `- If you cannot confirm the match (text is missing, substantially different, or the ` +
    `screen text does not contain enough to judge), respond with: INSUFFICIENT\n` +
    `- If you detect a discrepancy (the text is present but altered in meaning), respond ` +
    `with: INSUFFICIENT followed by FLAG:COPY_DISCREPANCY and a brief description.\n\n` +
    `Respond with ONLY one of the above. Do not explain further unless flagging a discrepancy.`
  );
}

/**
 * Compute a SHA-256 hex digest of the prompt text. This is the prompt identity for
 * provenance: a prompt refinement changes this hash, so any reader can tell which prompt
 * version produced a given decision.
 */
async function promptHash(prompt: string): Promise<string> {
  const bytes = new TextEncoder().encode(prompt);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedModelResponse {
  decision: ModelDecisionOutcome;
  flag: string | null;
}

/**
 * Parse the model's raw text response into a structured decision.
 *
 * THE FAIL GUARD IS ALSO HERE: even if the model outputs something unexpected, the
 * parser maps it to `insufficient`, never to `violated` or `satisfied`. Only an
 * explicit "VERIFIED" token in the response produces `satisfied`.
 */
function parseModelResponse(raw: string): ParsedModelResponse {
  const trimmed = raw.trim().toUpperCase();

  if (trimmed.startsWith("VERIFIED")) {
    return { decision: "satisfied", flag: null };
  }

  // Any response containing a flag marker carries it as metadata.
  const flagMatch = raw.match(/FLAG:COPY_DISCREPANCY\s*(.*)/i);
  const flag = flagMatch ? flagMatch[1]?.trim() || "discrepancy detected" : null;

  // Everything else — including explicit "INSUFFICIENT", garbled output, empty string —
  // maps to insufficient. The fail-closed direction.
  return { decision: "insufficient", flag };
}

// ---------------------------------------------------------------------------
// Usage tracking — Workers AI model calls
// ---------------------------------------------------------------------------

/**
 * Push a usage event for a Workers AI model call. Workers AI included models report
 * no per-call cost and no token counts in their response, so the event records zero
 * for both — the same pattern the visual usage path follows when cost telemetry is
 * unavailable. The model id is always recorded so the event is attributable.
 *
 * When `fence` is null (dev/replay paths), usage is not pushed — those paths have
 * no checkpoint ownership and cannot write usage events.
 */
async function pushWorkersAIUsage(
  env: Env,
  runId: string,
  fence: Fence | null,
  hash: string,
): Promise<void> {
  if (!fence) return;
  try {
    const event = modelUsage(
      COPY_MODEL_ID,
      0, // inputTokens — Workers AI does not report token counts
      0, // outputTokens — Workers AI does not report token counts
      0, // costUsd — Workers AI included models have no per-call charge
      `model-verifier/${hash}`, // eventId — deduplicates on Workflow step retry
    );
    await pushModelUsageStrict(env, runId, fence, [event]);
  } catch (err) {
    // Usage push failure MUST NOT prevent the verifier from returning its decision.
    // The model call already happened; failing to account it is a named limitation,
    // not a reason to discard the verdict. Log and continue.
    console.error(`model-verifier usage push failed for run ${runId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// The lane entry point
// ---------------------------------------------------------------------------

export interface ModelVerifierInput {
  env: Env;
  runId: string;
  sealedCase: FacetInstance;
  walkArtifact: PathObservation;
  requirementText: string;
  evidenceIds: string[];
  /** Checkpoint fence for usage tracking. Null on dev/replay paths. */
  fence: Fence | null;
}

/**
 * Run the model verifier for one copy-family observation.
 *
 * RETURNS null when the model call cannot be attempted (no AI binding, wrong case kind).
 * RETURNS a PredicateResult on success or on a caught model failure. The result's outcome
 * is ALWAYS `satisfied` or `insufficient` — never `violated`.
 *
 * SCREEN SELECTION. When the sealed case names a target question:
 *   - Only screens whose text mentions that question id are candidates.
 *   - If NO screen matches, the result is a named `insufficient` with
 *     `MODEL_COPY_TARGET_SCREEN_NOT_FOUND` — the model is never called with an
 *     unrelated screen (fail-closed).
 *   - If a screen matches, the model compares its text against the requirement.
 *
 * When no target question is known (survey-wide copy):
 *   - Screens are iterated in walk order, up to MAX_SCREENS_NO_TARGET (3).
 *   - The first screen that produces VERIFIED wins.
 *   - If none verified, the last result (insufficient) is returned.
 *   - The `detail` field records how many screens were checked of how many available.
 */
export async function runCopyModelVerifier(
  input: ModelVerifierInput,
): Promise<PredicateResult | null> {
  const { env, runId, sealedCase, walkArtifact, requirementText, evidenceIds, fence } = input;

  // Gate check (redundant with the caller, but defense in depth).
  if (env.WORKERSAI_ENABLED !== "true" || !env.AI) return null;

  // Case kind check.
  if (sealedCase.case?.kind !== "copy") return null;

  // Collect screen text from the walk artifact's steps.
  const targetQ = sealedCase.targetQuestionId;
  const allScreenTexts: string[] = [];
  const targetMatchScreenTexts: string[] = [];
  for (const step of walkArtifact.steps) {
    const screen = step.screenBefore as RenderedScreen | null;
    if (!screen) continue;
    const text = screen.visibleText ?? screen.questionText ?? "";
    if (!text) continue;
    allScreenTexts.push(text);
    if (targetQ && text.toLowerCase().includes(targetQ.toLowerCase())) {
      targetMatchScreenTexts.push(text);
    }
  }

  if (allScreenTexts.length === 0) {
    return modelInsufficient(
      VERIFIER_REASON.MODEL_COPY_NO_SCREEN_TEXT,
      "the walk artifact contains no screen text to compare against the requirement",
      COPY_MODEL_ID,
      "",
      evidenceIds,
    );
  }

  // TARGET QUESTION KNOWN — use only the matched screen.
  if (targetQ) {
    if (targetMatchScreenTexts.length === 0) {
      // FAIL-CLOSED: no screen mentions the target question. Returning insufficient
      // rather than comparing against an arbitrary screen that might share common
      // header/instruction text with the requirement.
      return modelInsufficient(
        VERIFIER_REASON.MODEL_COPY_TARGET_SCREEN_NOT_FOUND,
        `target question ${targetQ} not found in any of ${allScreenTexts.length} screen(s)`,
        COPY_MODEL_ID,
        "",
        evidenceIds,
      );
    }
    return callModelForScreen(env, runId, fence, targetMatchScreenTexts[0]!, requirementText, evidenceIds);
  }

  // NO TARGET QUESTION — survey-wide copy. Iterate screens, first VERIFIED wins.
  // Bound the iteration to MAX_SCREENS_NO_TARGET to limit model calls.
  const screensToCheck = allScreenTexts.slice(0, MAX_SCREENS_NO_TARGET);
  let lastResult: PredicateResult | null = null;
  let screensChecked = 0;

  for (const screenText of screensToCheck) {
    screensChecked++;
    const result = await callModelForScreen(env, runId, fence, screenText, requirementText, evidenceIds);
    if (!result) continue;
    if (result.outcome === "satisfied") {
      // Append screens-checked provenance to the detail.
      return {
        ...result,
        detail: `${result.detail} screensChecked=${screensChecked}/${allScreenTexts.length}`,
      };
    }
    lastResult = result;
  }

  // None verified — return the last insufficient with screens-checked provenance.
  if (lastResult) {
    return {
      ...lastResult,
      detail: `${lastResult.detail} screensChecked=${screensChecked}/${allScreenTexts.length}`,
    };
  }

  // Should not reach here (allScreenTexts is non-empty), but fail-closed.
  return modelInsufficient(
    VERIFIER_REASON.MODEL_COPY_NO_SCREEN_TEXT,
    "no screen text could be checked",
    COPY_MODEL_ID,
    "",
    evidenceIds,
  );
}

/**
 * Call the model for a single screen and push a usage event. Returns a PredicateResult
 * on success or caught failure. The usage event is pushed on BOTH paths.
 */
async function callModelForScreen(
  env: Env,
  runId: string,
  fence: Fence | null,
  screenText: string,
  requirementText: string,
  evidenceIds: string[],
): Promise<PredicateResult | null> {
  const prompt = buildCopyPrompt(requirementText, screenText);
  const hash = await promptHash(prompt);

  // THE MODEL CALL — wrapped in a try/catch so a failure demotes to a named insufficient.
  // A model-call failure MUST NEVER populate any payload key that downstream code reads as
  // a verdict signal. That is fabrication path #5 (d3-lane-design.md).
  let rawResponse: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Workers AI model names
    // are a branded union; casting is necessary for a configurable model id.
    const result = await env.AI!.run(COPY_MODEL_ID as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0,
    });
    // Workers AI returns either { response: string } or a ReadableStream.
    if (typeof result === "object" && result !== null && "response" in result) {
      rawResponse = String((result as { response: string }).response);
    } else {
      rawResponse = String(result);
    }
  } catch (err) {
    // MODEL CALL FAILED — push usage for the failed call (it still consumed compute),
    // then demote to named insufficient with the reason code.
    await pushWorkersAIUsage(env, runId, fence, hash);
    const errMsg = err instanceof Error ? err.message : String(err);
    return modelInsufficient(
      VERIFIER_REASON.MODEL_CALL_FAILED,
      `model call to ${COPY_MODEL_ID} failed: ${errMsg.slice(0, 200)}`,
      COPY_MODEL_ID,
      hash,
      evidenceIds,
    );
  }

  // Success path — push usage for the completed call.
  await pushWorkersAIUsage(env, runId, fence, hash);

  // Parse the model's response.
  const parsed = parseModelResponse(rawResponse);

  // Build the detail string with provenance and optional flag.
  const flagNote = parsed.flag ? ` [FLAG:COPY_DISCREPANCY] ${parsed.flag}` : "";
  const detail =
    `model=${COPY_MODEL_ID} promptHash=${hash} evidenceRefs=[${evidenceIds.join(",")}]` +
    `${flagNote}`;

  // THE DECISION — structurally constrained by the ModelDecisionOutcome type.
  const outcome: ModelDecisionOutcome = parsed.decision;
  const reason: VerifierReason =
    outcome === "satisfied"
      ? VERIFIER_REASON.MODEL_COPY_VERIFIED
      : VERIFIER_REASON.MODEL_COPY_INSUFFICIENT;

  return {
    outcome,
    reason,
    predicate: COPY_PREDICATE_ID,
    detail,
  };
}

/**
 * Build a named insufficient result for the model lane with full provenance.
 */
function modelInsufficient(
  reason: VerifierReason,
  detail: string,
  modelId: string,
  hash: string,
  evidenceIds: string[],
): PredicateResult {
  return {
    outcome: "insufficient",
    reason,
    predicate: COPY_PREDICATE_ID,
    detail: `model=${modelId} promptHash=${hash} evidenceRefs=[${evidenceIds.join(",")}] — ${detail}`,
  };
}
