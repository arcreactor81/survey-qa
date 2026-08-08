/**
 * SurveyRunWorkflowV2 — the orchestration plan, expressed as code structure.
 *
 * extract → seal contract revision → plan → execute (batched browser work) →
 * derive verdicts → assemble record → report
 *
 * The step bodies are stubs. The STRUCTURE is not: what is durable, what is checkpointed,
 * where the denominator is frozen, where the browser session survives, and which step is
 * forbidden from authoring a verdict are all decided here, and every one of them is a
 * direct response to how the first run failed.
 *
 * SEVEN STRUCTURAL COMMITMENTS
 *
 * 1. THE DENOMINATOR IS SEALED BEFORE EXECUTION AND NEVER RECOMPUTED.
 *    `seal-contract-revision` is a separate step from extraction, and its output is an
 *    immutable content-addressed revision. Every later step reads the revision by id.
 *    Exploration may ADD findings; it can never change `contract.total`, because nothing
 *    downstream of the seal can write it.
 *
 * 2. EXECUTION IS A CHECKPOINTED BATCH LOOP, NOT ONE LONG STEP.
 *    Each `execute-batch-N` step: reconnect to the browser session → run at most
 *    EXEC_BATCH_MAX_ATTEMPTS attempts or EXEC_BATCH_MAX_MS of wall clock → commit
 *    observations → disconnect (NOT close) → advance the cursor. The spike proved the
 *    session survives the gap between steps with page state intact, so a crash at batch
 *    17 resumes at batch 17 on the same browser rather than restarting the walk.
 *
 * 3. VERDICTS ARE DERIVED, NOT WRITTEN.
 *    `derive-verdicts` is deterministic and reads only observations + the sealed contract.
 *    No model call is permitted in it. This is the fix for the one failure the first run
 *    had: the browser captured the divergence, and a prose step wrote "MATCHES_DOCUMENT"
 *    while citing the artifact that disproved it. The stage with no independent check was
 *    the only stage that failed, so v2 removes the stage rather than supervising it.
 *
 * 4. EVERY STEP BOUNDARY WRITES A CHECKPOINT AND A HEARTBEAT, AND THEY ARE DIFFERENT
 *    THINGS. The checkpoint is durable progress; the heartbeat is liveness. Heartbeats are
 *    written from INSIDE step closures, so a crash-looping instance cannot refresh its own
 *    liveness — a completed Workflow step returns its cached result and never re-executes.
 *
 * 5. A PARTIAL RUN IS A REPORTABLE OUTCOME. Budget/time/blocked exhaustion sets
 *    `Executing: stopped` with a reasonCode and falls THROUGH to reporting, which can
 *    still finish `complete`. Reporting is in a finally-shaped tail so it runs on the
 *    failure path too.
 *
 * 6. NO STAGE MAY CERTIFY WORK IT DID NOT DO, AND REPORTING MAY NOT CLOSE THE TEST AXIS.
 *    Stubs return `not-evaluated`, a state with no value in the successful domain, and the
 *    seal refuses to run on one. `completion.test` is closed by ONE gate — the
 *    adjudication/coverage gate in `close-test-axis` — and specifically NOT by the report
 *    step, which used to flip `running -> complete` merely because report CONSTRUCTION had
 *    ended, including when it had ended in failure.
 *
 * 7. A RECOVERED RUN RESUMES AND IS FENCED. `recoveryAttempt` is consumed: the workflow
 *    claims an ownership epoch, refuses to write once superseded, and picks up the sealed
 *    contract, the plan and the cursor that already exist instead of re-extracting and
 *    re-sealing from scratch.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types/env";
import { num } from "../types/env";
import {
  beat,
  claimOwnership,
  loadCheckpoint,
  setPhase,
  updateCheckpoint,
  type Fence,
} from "../store/checkpoint";
import { clearActive, updateEnvelope } from "../store/envelope";
import { tickWallClock } from "../store/usage";
import { denominators, sealContract } from "../store/contract-revision";
import { edgeCoverageKey, structureModelKey } from "../keys";
// `planStage` is no longer imported here: the arm registry binds it as the BASELINE `plan`
// component (arms/registry.ts). Reverting the seam means restoring this import and calling
// planStage directly at the one site below — two lines, both marked.
import { resolveArm } from "../arms/resolve";
import { executeBatch, loadProgress } from "./stages/execute-batch";
import {
  ERROR_TEXT_MAX,
  FAILURE_MESSAGE_MAX,
  OwnershipLost,
  sanitiseErrorText,
  type RunCheckpoint,
  type RunFailure,
  type TestCompletion,
} from "../types/contracts";
import { mintPlanRevisionId, recoveryInstanceId } from "../ids";
import type { ContractRevision } from "../types/record";
import { buildAndStoreReport } from "../report/build";
import {
  describeGates,
  notEvaluated,
  stageEvaluated,
  stageNotEvaluated,
  unmetGates,
  type GateOutcome,
  type GateProof,
  type StageResult,
} from "./gates";
import {
  extractionBudgetExceeded,
  loadMerged,
  stageConsolidate,
  stagePassASlice,
  stagePassBSlice,
  type ConsolidationSummary,
  type PassSummary,
} from "./stages/extract";
import { passAStepTimeoutMs, passAWaveBudgetMs, type PassASlice } from "../extract/pass-a";
import { passBStepTimeoutMs, passBWaveBudgetMs, type PassBSlice } from "../extract/pass-b";
import { projectObservations } from "./stages/project-observations";
import { verifyObservations } from "./stages/verify-observations";
import { deriveItemResults, mintJudgement } from "./stages/derive-verdicts";
import { assembleRecord } from "./stages/assemble-record";
import { computeEdgeCoverage } from "../structure/index";
import type { StructureModel } from "../structure/index";

export interface RunParamsV2 {
  runId: string;
  surveyUrl: string;
  documentKey: string;
  documentSha256: string;
  profile: "standard" | "deep";
  locale: string;
  viewports: string[];
  /** Set by the sweeper on a recreate so the new instance knows it is a continuation. */
  recoveryAttempt?: number;
}

/** Step policies. Extraction and reporting are retried; execution batches are not blindly
 *  retried, because a retried batch re-drives a real browser and can double-count usage.
 *
 *  THE 8-MINUTE FIGURE IS NOT A BUDGET FOR A FAN-OUT, and it never was. A Workflow step's
 *  timeout is applied PER ATTEMPT and the platform imposes no maximum on it (wall clock per
 *  step is documented "Unlimited"; only CPU is capped) — which is exactly why raising it was
 *  the wrong instinct. Measured: pass B's ~23 chunks at EXTRACT_CHUNK_CONCURRENCY=5 want
 *  ~1000 s of wall clock (a round costs the SLOWEST of its five calls; DeepSeek p90 206 s),
 *  plus up to three ledger-sweep calls run serially at the end, all inside this one step.
 *  On two real runs of the same document, one scraped through on attempt 3 of 3 and the
 *  other burned all three attempts on durably-recorded 480000 ms timeouts. The per-call
 *  ceiling (LLM_TIMEOUT_MS) could never fire, because no single call was slow.
 *
 *  So pass B no longer uses this policy at all: it is spread over as many `extract-pass-b-
 *  wave-N` steps as the document needs, each with its own timeout DERIVED from its own wall-
 *  clock budget (`passBStepTimeoutMs`).
 *
 *  NEITHER DOES PASS A, for the same reason one document larger than our fixtures would have
 *  found the hard way. `extract-pass-a-global` was one step under this policy, and inside it
 *  `splitWindows` walks SERIAL windows of EXTRACT_PASS_A_WINDOW_CHARS (90 000) each: two
 *  windows is 2 × LLM_TIMEOUT_MS = 600 s against this 480 s ceiling, four windows on a
 *  ~360 KB questionnaire is worse, and nothing was persisted per window — so the axe fell on
 *  windows that had already been billed and the retry bought every one of them again. Pass A
 *  now occupies `extract-pass-a-wave-N` steps with `passAStepTimeoutMs`.
 *
 *  This policy still covers the steps that really are one bounded unit of work — the
 *  deterministic merge/diff/plan steps. */
const EXTRACT_POLICY = { retries: { limit: 2, delay: "15 seconds", backoff: "linear" }, timeout: "8 minutes" } as const;
const BATCH_POLICY = { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" } as const;
/**
 * THE JUDGING STAGES. `delay` is 30 seconds and NOT 5 for a reason that is not politeness.
 *
 * When `verify-observations` exhausted the invocation's subrequest budget on
 * v2r_01kzfb6py8pbxznqv022p2qkhb, attempt 1 ran 1m19s and errored — and attempts 2 and 3
 * then errored in **0 seconds each**. They never reached any R2 call. A 5-second delay was
 * short enough that the retry resumed inside the SAME, already-spent invocation, so the
 * retry policy was burning attempts against a budget that could not recover.
 *
 * Workflows put an instance into the `waiting` state while it is waiting for a retry, and an
 * instance that resumes from `waiting` is scheduled afresh. The docs are explicit that the
 * transition "may not occur if the wait duration is very short" and name no threshold, so
 * this is a BEST-EFFORT boundary, not a guarantee — the guarantee comes from the subrequest
 * budget in wrangler.jsonc and from these stages costing far less than they used to. What
 * this buys is that a retry now has a real chance of being a new invocation instead of a
 * certainty of being the dead one.
 */
const DERIVE_POLICY = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "3 minutes" } as const;
const REPORT_POLICY = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

/** Reason codes a run terminates with. Named so the report can say which. */
const EXTRACTION_NOT_APPROVED = "extraction-gates-unmet";
/**
 * The whole-document pass ran out of the STEPS a run may spend on it while the document
 * still owed windows. Same shape, same reasoning as the block pass's code below: a document
 * that was never read all the way through has tested nothing, so it is `failed`, never a
 * `partial-*`.
 */
const EXTRACTION_PASS_A_WAVES_EXHAUSTED = "extraction-pass-a-waves-exhausted";
/**
 * The block pass ran out of the STEPS a run may spend on it while the document still owed
 * chunks. A budget/deadline reason, and deliberately NOT a `partial-*`: nothing was tested,
 * because nothing was even read all the way through.
 */
const EXTRACTION_WAVES_EXHAUSTED = "extraction-pass-b-waves-exhausted";
const NOT_IMPLEMENTED_VERIFICATION = "verification-not-implemented";
const NOT_IMPLEMENTED_ADJUDICATION = "adjudication-not-implemented";
const TEST_AXIS_NEVER_CLOSED = "test-axis-never-closed";
/**
 * PLANNING REFUSED THE SEALED CONTRACT IT WAS HANDED — a deliberate guard declining to
 * proceed, not a crash.
 *
 * The first real run ended `workflow-error`, the code this file uses for "something threw
 * and we do not know what". That was wrong twice over: the run had not hit an unknown
 * fault, it had hit a check that exists precisely to stop a malformed sealed contract from
 * becoming a plan (`planning refused duplicate sealed facetInstanceId fi_…`), and calling
 * a known refusal "unknown" tells the reader to go looking for an outage. The distinction
 * is operational: a refusal means the INPUT is wrong and the fix is upstream in extraction
 * or sealing; `workflow-error` means the SYSTEM is wrong and the fix is here.
 *
 * ONE code, not a family. Which guard refused, in which step, is carried by
 * `checkpoint.failure` (`step` + `message`) — that is what a structured field is FOR, and
 * minting a reason code per guard would put the same information in a vocabulary every
 * reader then has to keep up with.
 */
const PLANNING_REFUSED = "planning-refused";

/**
 * The phrases the planner's guards actually throw. Deliberately LITERAL and deliberately
 * short: this is a recogniser for refusals that already exist, not a taxonomy of failures
 * that might. Anything not on this list stays `workflow-error`, which is the honest answer
 * for a fault nobody has classified yet.
 *
 * These are matched on the MESSAGE because the guards throw a bare `Error` (plan.ts is
 * owned elsewhere and was not modified for this). The moment those sites throw a named
 * error class instead, `classifyFailure` should switch to `err.name` and this list should
 * shrink to nothing.
 */
const PLANNING_REFUSAL_PHRASES = [
  "planning refused ",
  "planning produced duplicate ",
  "sealed facetInstanceIds contain duplicates",
  "execution case ids contain duplicates",
  "not an exact sealed-case permutation",
] as const;

/**
 * THE RUN RAN OUT OF THE PLATFORM, NOT OUT OF ANSWERS.
 *
 * `v2r_01kzfb6py8pbxznqv022p2qkhb` died at `verify-observations-1` and the engine recorded
 * the cause perfectly on all three retries:
 *
 *   Error: Too many API requests by single Worker invocation.
 *
 * That is not "something threw and we do not know what" — it is the subrequest ceiling, it
 * is recognisable from its own sentence, and it is ACTIONABLE in a way no other failure in
 * this file is: the fix is `limits.subrequests` in the Wrangler config, or fewer R2 round
 * trips in the stage that spent them. Calling it `workflow-error` sends the reader looking
 * for a bug in a run that hit a quota.
 *
 * It is also the one failure mode that DISABLES THE RECORDER, because writing the cause is
 * itself a subrequest. See `commitFailure`.
 */
const SUBREQUEST_LIMIT_EXCEEDED = "subrequest-limit-exceeded";

/**
 * The two sentences the platform actually produces for the ceiling. Same discipline as
 * `PLANNING_REFUSAL_PHRASES`: LITERAL, short, and a recogniser for text we have seen rather
 * than a taxonomy of text we imagine. Matched case-insensitively because these arrive from
 * the runtime rather than from this codebase, so their capitalisation is not ours to
 * promise — the words are.
 *
 *   "Too many API requests by single Worker invocation."  — the internal-services ceiling
 *                                                            (R2/KV/D1), which is the one
 *                                                            this run hit.
 *   "Too many subrequests."                                — the general ceiling, documented
 *                                                            at workflows/reference/limits.
 */
const SUBREQUEST_LIMIT_PHRASES = [
  "too many api requests by single worker invocation",
  "too many subrequests",
] as const;

/**
 * How long the failure path pauses before trying to write its cause a second time.
 *
 * SHORT ON PURPOSE, and the two bounds are in tension. Long enough that the engine has a
 * reason to hibernate the instance (a hibernated instance is re-invoked, and a new
 * invocation is the only place a new subrequest budget could come from); short enough that
 * the sweeper — which watches for a run that has stopped beating — is not handed a stalled
 * run to recover while the run is still in the act of explaining itself.
 */
const FAILURE_RECORDING_COOLDOWN = "20 seconds";

/**
 * A thrown value → the reason code the run should end with, or null when we do not
 * recognise it. Null is not a failure of this function: `workflow-error` remains the
 * correct code for an unexpected crash, and widening this beyond failures we have actually
 * seen would trade a truthful "unknown" for a confident guess.
 *
 * EXPORTED because the read surface needs the same vocabulary. When a run is killed by the
 * subrequest ceiling it cannot write its own cause, and the only copy is the one the
 * Workflows engine kept; `src/api/runs.ts` fetches that sentence and classifies it HERE, so
 * a reason code means the same thing whether the run named it or the engine did.
 */
export function classifyFailure(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  if (PLANNING_REFUSAL_PHRASES.some((phrase) => message.includes(phrase))) return PLANNING_REFUSED;
  const lowered = message.toLowerCase();
  if (SUBREQUEST_LIMIT_PHRASES.some((phrase) => lowered.includes(phrase))) return SUBREQUEST_LIMIT_EXCEEDED;
  return null;
}

/** Build the structured cause from a thrown value. Sanitised at construction, so the
 *  unsafe form never reaches the checkpoint in the first place. */
function describeFailure(step: string, err: unknown): RunFailure {
  const message = sanitiseErrorText(err, FAILURE_MESSAGE_MAX).replace(/^[A-Za-z]*Error:\s*$/, "");
  return {
    step,
    reasonCode: classifyFailure(err) ?? "workflow-error",
    kind: err instanceof Error && typeof err.name === "string" && err.name ? err.name : "unknown",
    // NEVER PUBLISH AN EMPTY EXPLANATION. A thrown value that stringifies to nothing —
    // which is what the boundary can hand back — used to become an empty `error` field,
    // and an empty field reads as "the system has no idea" when in fact the system knows
    // exactly where to look. Saying which step, and saying that the message is what went
    // missing, is strictly more than the incident produced.
    message:
      message ||
      `${step} failed and the error did not survive the workflow step boundary; ` +
        `the engine's own record for this step has the original message`,
    at: new Date().toISOString(),
  };
}

export class SurveyRunWorkflowV2 extends WorkflowEntrypoint<Env, RunParamsV2> {
  /**
   * Steps this INSTANCE has written a cause for. Purely an optimisation: it lets a retry
   * that succeeds withdraw its own predecessor's cause without every successful step in
   * the run paying an R2 read to discover it has nothing to withdraw. The durable
   * backstop for the cross-isolate case is in `finalize`.
   */
  private readonly causeRecordedFor = new Set<string>();

  /**
   * THE COPY OF THE CAUSE THAT NEEDS NO STORAGE.
   *
   * `recordFailureCause` writes the cause to R2 — and when the failure IS the subrequest
   * ceiling, that write is itself a subrequest and throws the same error. It is wrapped in
   * try/catch on purpose ("a contention on the way to explaining an error must never become
   * the error the run reports"), so on `v2r_01kzfb6py8pbxznqv022p2qkhb` it swallowed its own
   * failure and the diagnosis evaporated between the throw and the outer catch six frames
   * later.
   *
   * A field on the instance survives that, because it is memory rather than I/O. FIRST
   * CAUSE WINS here for the same reason it does durably: `record-failure`'s own throw is
   * routed through the same wrapper, and last-write-wins would have the run report the
   * aftershock instead of the illness.
   *
   * ITS LIMIT, STATED: this is per-INSTANCE state. A hibernation (`step.sleep`) or a
   * recovery instance starts with an empty one. `stepInFlight` is what survives that, since
   * it is re-established by the very act of re-awaiting the step.
   */
  private lastFailure: RunFailure | null = null;

  /**
   * The step currently being awaited. Set BEFORE the call, so it is correct even when the
   * engine throws a cached failure at the boundary without ever running the body — the one
   * case where the outer catch has historically had nothing but "unknown" to work with.
   */
  private stepInFlight: string | null = null;

  async run(event: WorkflowEvent<RunParamsV2>, rawStep: WorkflowStep): Promise<void> {
    const p = event.payload;
    const runId = p.runId;

    // EVERY STEP, NOT JUST THE ONE THAT FAILED FIRST. See `instrumentSteps`.
    const step = this.instrumentSteps(rawStep, runId);

    // ONE EPOCH PER ATTEMPT, DERIVED — NOT RANDOM. The sweeper creates a replacement at
    // the deterministic id `${runId}-r{n}` and passes `recoveryAttempt: n`, so an instance
    // can compute its own identity without depending on a runtime API, and two instances
    // of the same attempt can never disagree about which epoch they hold.
    const attempt = p.recoveryAttempt ?? 0;
    const instanceId = attempt === 0 ? runId : recoveryInstanceId(runId, attempt);

    // THE FENCE, VISIBLE TO THE FAILURE PATH. Commitment 5 says a partial run is a
    // REPORTABLE outcome, and every deliberate stop below honours it — but an UNCAUGHT step
    // failure did not: `record-failure` rethrew and the run ended with no report at all, so
    // the one class of ending a reader most needs explained was the one class that produced
    // nothing to read. Reporting needs the fence, and the fence used to be scoped inside the
    // try, so it is captured here. Null means the claim itself never succeeded, and a run
    // that never owned itself must not write a report over the instance that does.
    let reportingFence: Fence | null = null;

    try {
      // Claim first, before ANY write or browser action. A superseded original loses here
      // and stops, rather than racing its replacement through the survey.
      const fence: Fence = await step.do("claim-ownership", async () => {
        const f = await claimOwnership(this.env, runId, instanceId, attempt);
        await beat(this.env, runId, `instance ${instanceId} claimed run at epoch ${attempt}`, `own:${attempt}`);
        return f;
      });
      reportingFence = fence;

      // ---------------------------------------------------------------------
      // RESUME. A replacement instance must continue the run, not restart it: the
      // contract is already sealed (and sealing is one-way), the plan is minted, the
      // cursor knows which cases still owe an observation, and the browser session id is
      // durable. `recoveryAttempt` used to be passed and never read, so every replacement
      // re-extracted and re-sealed from scratch — throwing away the work, the cursor and
      // the live session, and burning the run's budget a second time.
      // ---------------------------------------------------------------------
      const resumed = await step.do("resume-durable-state", async () => {
        const loaded = await loadCheckpoint(this.env, runId);
        const cp = loaded?.checkpoint ?? null;
        const sealedId = cp?.contract.state === "sealed" ? cp.contract.contractRevisionId : null;
        return {
          contractRevisionId: sealedId,
          contractHash: cp?.contract.contractHash ?? null,
          executionCases: cp?.contract.total ?? null,
          planRevisionId: cp?.execution?.planRevisionId ?? null,
          batchIndex: cp?.execution?.batchIndex ?? 0,
          isContinuation: attempt > 0,
        };
      });

      // ---------------------------------------------------------------------
      // EXTRACTION-BUDGET GUARD — checked HERE, at resume, AND at the seal step.
      //
      // `extractionBudgetExceeded` existed but was never called anywhere: extraction
      // could spend past the reserve set aside for verification and reporting, seal a
      // contract, and then trip `cost-cap` on batch 0 with a misleading `partial-budget`
      // after exercising NOTHING. The resume-time check catches a run that ALREADY
      // over-spent (a recovered instance arriving with an empty wallet); the seal-step
      // check catches fresh extraction that just over-spent. Both end the run `failed`,
      // never `partial-budget` over zero work.
      // ---------------------------------------------------------------------
      {
        const loaded0 = await loadCheckpoint(this.env, runId);
        const usage0 = loaded0?.checkpoint.usage ?? null;
        if (usage0 && extractionBudgetExceeded(this.env, usage0.cost.usedUsd, usage0.cost.maxUsd)) {
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              setPhase(d, "extracting", "stopped", "extraction-budget-exceeded");
              d.contract.state = "unavailable";
              d.completion.test = "failed";
              d.completion.reasonCode = "extraction-budget-exceeded";
              d.error =
                `extraction spent $${usage0.cost.usedUsd} of a $${usage0.cost.maxUsd} budget, ` +
                `exceeding the extraction fraction (${num(this.env.EXTRACT_BUDGET_FRACTION, 0.5)}). ` +
                "Nothing was exercised, so this is a failure, not a partial run.";
            },
            { progressed: true, fence },
          );
          await this.reportAndFinalize(step, runId, fence);
          return;
        }
      }

      // ---------------------------------------------------------------------
      // PHASE: extracting — TWO independent passes + source-first ledger + diff
      // (merged-contract §0: "review alone is NOT sufficient — a reviewer cannot
      //  see a row that was never proposed")
      // ---------------------------------------------------------------------
      let sealed: { contractRevisionId: string; contractHash: string; executionCases: number } | null = null;

      if (resumed.contractRevisionId && resumed.executionCases !== null) {
        // Already sealed by the instance we are replacing. Adopt it by id; re-sealing
        // would mint a second denominator for one run, which §0 forbids outright.
        sealed = {
          contractRevisionId: resumed.contractRevisionId,
          contractHash: resumed.contractHash ?? "",
          executionCases: resumed.executionCases,
        };
        await step.do("resume-sealed-contract", async () => {
          await beat(this.env, runId, `resuming sealed contract ${sealed!.contractRevisionId}`, "resume-seal");
        });
      } else {
        await step.do("phase-extracting", async () => {
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              setPhase(d, "extracting", "active");
              d.completion.test = "running";
              d.contract.state = "extracting";
            },
            { progressed: true, fence },
          );
          await beat(this.env, runId, "extracting", "extract");
        });

        // TWO PASSES THAT DIFFER IN METHOD, NOT ONLY IN MODEL (owner ruling). Pass A reads
        // the whole document for rules scoped to the SURVEY; pass B walks every block
        // against a construct checklist and must account for each one. Each step persists
        // its payload to R2 and returns a small summary — a step result is durable state
        // carried between steps, and 119 requirements with verbatim quotes do not belong
        // in one.
        // -------------------------------------------------------------------
        // PASS A IS A SERIAL WINDOW WALK, AND A WINDOW WALK DOES NOT FIT IN ONE STEP EITHER.
        //
        // It used to be one `extract-pass-a-global` step under EXTRACT_POLICY. That does not
        // bite the small fixture — one window, one call — which is exactly why it had to be
        // closed before a real client questionnaire arrived: `EXTRACT_PASS_A_WINDOW_CHARS`
        // is 90 000, so a ~180 KB document is already two SERIAL calls at up to
        // LLM_TIMEOUT_MS each (600 s > 480 s), and with no per-window persistence a timeout
        // re-bought every window. The cliff was the document's size, not ours.
        //
        // Same treatment as pass B, with pass A's own arithmetic: each wave reclaims every
        // window already on disk for free, issues new calls only while its own wall-clock
        // budget lasts, never abandons a call it has issued (the step timeout is the budget
        // plus a whole PURCHASE plus slack — `passAStepTimeoutMs`, which counts
        // EXTRACT_MAX_ATTEMPTS because chat.ts retries inside one purchase), always issues
        // at least one call so the loop cannot stall, and reports `done` only when every
        // window is accounted for. Exhausting the wave budget is a NAMED failure below.
        // -------------------------------------------------------------------
        const passAWavePolicy = {
          retries: { limit: 2, delay: "15 seconds", backoff: "linear" },
          timeout: passAStepTimeoutMs(this.env),
        } as const;
        const passAWaveBudget = passAWaveBudgetMs(this.env);
        const maxPassAWaves = Math.max(1, num(this.env.EXTRACT_PASS_A_MAX_WAVES, 10));

        let passA: StageResult<PassSummary> = stageNotEvaluated<PassSummary>(
          "PASS_A_NEVER_RAN",
          "the pass A wave loop was configured with no waves at all, so the whole-document pass never ran",
        );
        let passAUnfinished: PassASlice | null = null;

        for (let wave = 0; wave < maxPassAWaves; wave++) {
          const outcome = await step.do(`extract-pass-a-wave-${wave}`, passAWavePolicy, async () => {
            await beat(this.env, runId, `extract pass A wave ${wave} (whole-document / global rules)`, `extract-a-${wave}`);
            return await stagePassASlice(
              this.env,
              runId,
              p.documentKey,
              documentName(p),
              fence,
              async (msg) => {
                await beat(this.env, runId, msg, `extract-a-${wave}`);
              },
              { budgetMs: passAWaveBudget },
            );
          });
          passA = outcome.result;
          passAUnfinished = outcome.slice.done ? null : outcome.slice;
          if (outcome.slice.done) break;
        }

        if (passAUnfinished) {
          // AN HONEST, NAMED STOP — identical in shape to the block pass's below, because
          // the failure is identical: the run ran out of the STEPS it may spend reading, and
          // a document that was only partly read cannot support a denominator. `partial-*`
          // would describe a test that was cut short; nothing was exercised at all.
          const u = passAUnfinished;
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              setPhase(d, "extracting", "stopped", EXTRACTION_PASS_A_WAVES_EXHAUSTED);
              d.contract.state = "unavailable";
              d.completion.test = "failed";
              d.completion.reasonCode = EXTRACTION_PASS_A_WAVES_EXHAUSTED;
              d.error =
                `extraction pass A used all ${maxPassAWaves} of its wave step(s) (EXTRACT_PASS_A_MAX_WAVES) and ` +
                `still owes ${u.windowsRemaining} of ${u.windowsTotal} window(s). ${u.windowsLanded} window(s) ` +
                `landed. Nothing was sealed, because a contract over a half-read document would claim a ` +
                `denominator the document never approved — and pass A's whole purpose is the survey-scoped rule ` +
                `that only an unread window may state. Raise EXTRACT_PASS_A_MAX_WAVES or ` +
                `EXTRACT_PASS_A_WAVE_BUDGET_MS for a document this size.`;
            },
            { progressed: true, fence },
          );
          await this.reportAndFinalize(step, runId, fence);
          return;
        }

        // -------------------------------------------------------------------
        // PASS B IS A FAN-OUT, AND A FAN-OUT DOES NOT FIT IN ONE STEP.
        //
        // It used to be one `extract-pass-b-blocks` step under EXTRACT_POLICY, and that step
        // is where real runs died: the whole chunk walk plus the ledger sweep had to finish
        // inside one 480 s attempt, and the work grows with the document while the timeout
        // does not. A bigger number only moves the cliff.
        //
        // Workflow steps checkpoint independently, so the structurally correct answer is more
        // steps, not a longer one. Each wave:
        //   - reclaims every chunk already on disk for free (no model call, no charge);
        //   - issues new calls only while its own wall-clock budget lasts, and NEVER abandons
        //     a call it has issued — the step's timeout is the budget PLUS a whole PURCHASE
        //     plus slack (`passBStepTimeoutMs`, which counts EXTRACT_MAX_ATTEMPTS because
        //     chat.ts retries inside one purchase and bills every attempt), so the step axe
        //     cannot fall on work already paid for. That is what removes the ~1.7x duplicate
        //     model spend the old retries produced;
        //   - always issues at least one call, so the loop cannot stall;
        //   - returns `done` only when every chunk AND every sweep call is accounted for.
        //
        // The wave COUNT scales with the document. What is bounded is the number of steps a
        // run may spend on it, and exhausting that bound is a NAMED failure below — never a
        // partial contract over a document that was only half read.
        // -------------------------------------------------------------------
        const wavePolicy = {
          retries: { limit: 2, delay: "15 seconds", backoff: "linear" },
          timeout: passBStepTimeoutMs(this.env),
        } as const;
        const waveBudgetMs = passBWaveBudgetMs(this.env);
        const maxWaves = Math.max(1, num(this.env.EXTRACT_PASS_B_MAX_WAVES, 40));

        let passB: StageResult<PassSummary> = stageNotEvaluated<PassSummary>(
          "PASS_B_NEVER_RAN",
          "the pass B wave loop was configured with no waves at all, so the block pass never ran",
        );
        let passBUnfinished: PassBSlice | null = null;

        for (let wave = 0; wave < maxWaves; wave++) {
          const outcome = await step.do(`extract-pass-b-wave-${wave}`, wavePolicy, async () => {
            await beat(this.env, runId, `extract pass B wave ${wave} (source blocks / tables)`, `extract-b-${wave}`);
            return await stagePassBSlice(
              this.env,
              runId,
              p.documentKey,
              documentName(p),
              fence,
              async (msg) => {
                await beat(this.env, runId, msg, `extract-b-${wave}`);
              },
              { budgetMs: waveBudgetMs },
            );
          });
          passB = outcome.result;
          passBUnfinished = outcome.slice.done ? null : outcome.slice;
          if (outcome.slice.done) break;
        }

        if (passBUnfinished) {
          // AN HONEST, NAMED STOP — the same shape as the extraction-budget guard above.
          //
          // The run ran out of the STEPS it is allowed to spend on the block pass while the
          // document still owed chunks. Every alternative here is a lie: sealing would freeze
          // a denominator over a half-read document, and `partial-*` would describe a test
          // that was cut short rather than a read that never finished. `failed`, with the
          // arithmetic in the message, is the only true statement available.
          const u = passBUnfinished;
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              setPhase(d, "extracting", "stopped", EXTRACTION_WAVES_EXHAUSTED);
              d.contract.state = "unavailable";
              d.completion.test = "failed";
              d.completion.reasonCode = EXTRACTION_WAVES_EXHAUSTED;
              d.error =
                `extraction pass B used all ${maxWaves} of its wave step(s) (EXTRACT_PASS_B_MAX_WAVES) and still ` +
                `owes ${u.chunksRemaining} of ${u.chunksTotal} chunk(s) and ${u.sweepRemaining} ledger-sweep ` +
                `call(s). ${u.chunksLanded} chunk(s) landed. Nothing was sealed, because a contract over a ` +
                `half-read document would claim a denominator the document never approved. Raise ` +
                `EXTRACT_PASS_B_MAX_WAVES or EXTRACT_WAVE_BUDGET_MS for a document this size.`;
            },
            { progressed: true, fence },
          );
          await this.reportAndFinalize(step, runId, fence);
          return;
        }

        // MERGE + DIFF + LEDGER + FLOOR EXPANSION, deterministically, from the two
        // persisted payloads. No model call happens here, so the denominator this produces
        // is reproducible from the same two payloads by anyone who has them.
        const consolidated = await step.do("source-ledger", EXTRACT_POLICY, async () => {
          await beat(this.env, runId, "merging passes: source ledger, typed diff, floor expansion", "ledger");
          if (passA.state !== "evaluated" || passB.state !== "evaluated") {
            return stageNotEvaluated<ConsolidationSummary>(
              "PASS_MISSING",
              `consolidation needs both passes; A=${passA.state}, B=${passB.state}`,
            );
          }
          const result = await stageConsolidate(
            this.env,
            runId,
            p.documentKey,
            p.documentSha256,
            p.locale,
            p.viewports,
          );
          if (result.state === "evaluated") {
            for (const line of result.value.diffSummary) console.log(`v2 ${runId} diff: ${line}`);
          }
          return result;
        });

        const ledger = projectLedger(consolidated);
        const diff = projectDiff(consolidated);
        const constructs = projectConstructs(consolidated);
        const expansion = projectExpansion(consolidated);

        await step.do("extraction-diff", EXTRACT_POLICY, async () => {
          if (consolidated.state !== "evaluated") return;
          const c = consolidated.value;
          await beat(
            this.env,
            runId,
            `extraction: ${c.requirementCount} requirements, ${c.executionCaseCount} execution cases, ` +
              `${c.unexplainedNormativeBlocks} unaccounted blocks`,
            "diff",
          );
        });

        // -------------------------------------------------------------------
        // GATE + SEAL. After this step the denominator is frozen for the run.
        // HUMAN_REVIEW_MODE is an OPEN OWNER FORK (merged-contract §0) and is read
        // from config here rather than assumed, so flipping it is a var change.
        // -------------------------------------------------------------------
        const sealOutcome = await step.do("seal-contract-revision", async () => {
          const loaded = await loadCheckpoint(this.env, runId);
          const reviewMode = loaded?.checkpoint.policy.humanReviewMode ?? "high-risk-only";

          // EXTRACTION-BUDGET GUARD, wired at last. `extractionBudgetExceeded` existed but
          // was never called, so extraction could burn past the reserve set aside for
          // verification and reporting, seal a contract, and then trip `cost-cap` on
          // batch 0 with a misleading `partial-budget` after exercising NOTHING. Check it
          // HERE, before the seal: a run that spent its test budget extracting has no
          // business sealing a denominator it cannot afford to exercise, and the honest
          // end state is `failed`, not `partial-budget`.
          const usage = loaded?.checkpoint.usage ?? null;
          if (
            usage &&
            extractionBudgetExceeded(this.env, usage.cost.usedUsd, usage.cost.maxUsd)
          ) {
            await updateCheckpoint(
              this.env,
              runId,
              (d) => {
                setPhase(d, "extracting", "stopped", "extraction-budget-exceeded");
                d.contract.state = "unavailable";
                d.completion.test = "failed";
                d.completion.reasonCode = "extraction-budget-exceeded";
                d.error =
                  `extraction spent $${usage.cost.usedUsd} of a $${usage.cost.maxUsd} budget, ` +
                  `exceeding the extraction fraction (${num(this.env.EXTRACT_BUDGET_FRACTION, 0.5)}). ` +
                  "Nothing was exercised, so this is a failure, not a partial run.";
              },
              { progressed: true, fence },
            );
            return { sealed: false as const, unmet: ["extractionBudget:exceeded"] };
          }

          const gates = deriveGates(ledger, diff, constructs, expansion);
          const unmet = unmetGates(gates);

          if (unmet.length > 0) {
            // HONEST STOP. The old code turned two un-run stubs into four green gates and
            // sealed anyway. There is nothing to seal, so nothing is sealed, and the run
            // says which gates are unmet rather than proceeding over an empty contract
            // that would later read as "tested everything".
            await updateCheckpoint(
              this.env,
              runId,
              (d) => {
                setPhase(d, "extracting", "stopped", EXTRACTION_NOT_APPROVED);
                d.contract.state = "unavailable";
                d.completion.test = "failed";
                d.completion.reasonCode = EXTRACTION_NOT_APPROVED;
                d.error =
                  `extraction did not produce a sealable contract: unmet approval gates [${unmet.join(", ")}]. ` +
                  describeGates(gates);
              },
              { progressed: true, fence },
            );
            return { sealed: false as const, unmet };
          }

          // THE ROWS COME FROM THE MERGE, BY KEY — not from the step results. The merged
          // payload is the one artifact the diff, the ledger and the expansion preview were
          // all computed over, so sealing anything else would seal a denominator nothing
          // approved.
          const merged = await loadMerged(this.env, runId);
          if (!merged) {
            await updateCheckpoint(
              this.env,
              runId,
              (d) => {
                setPhase(d, "extracting", "stopped", "merged-extraction-missing");
                d.contract.state = "unavailable";
                d.completion.test = "failed";
                d.completion.reasonCode = "merged-extraction-missing";
                d.error = "the gates passed but the merged extraction payload is not in storage; refusing to seal";
              },
              { progressed: true, fence },
            );
            return { sealed: false as const, unmet: ["mergedPayloadPresent:missing"] };
          }

          const body: Omit<ContractRevision, "contractRevisionId"> = {
            schemaVersion: "v2-contract-revision/1.0.0",
            kind: "survey-qa-v2-contract-revision",
            documentRevisionId: p.documentSha256,
            documentSha256: p.documentSha256,
            sealedAt: new Date().toISOString(),
            requirements: merged.requirements,
            // The deterministic floor expander materialized these from what the DOCUMENT
            // enumerates (one case per answer a routing rule names, two per stated input
            // bound), never from what a run observed — a denominator that shrinks when
            // execution is missing hides the missing execution (D10).
            facetInstances: merged.facetInstances,
            contractSupplements: [],
            extraction: {
              passAHash: passA.state === "evaluated" ? passA.value.hash : "",
              passBHash: passB.state === "evaluated" ? passB.value.hash : "",
              sourceLedgerHash: ledger.state === "evaluated" ? ledger.value.hash : "",
              diffHash: diff.state === "evaluated" ? diff.value.hash : "",
              reviewMode,
              reviewedBy: null,
              reviewedAt: null,
              gates,
            },
          };

          const { contractRevisionId, contractHash, revision } = await sealContract(this.env, body);
          const d10 = denominators(revision);

          await updateEnvelope(this.env, runId, (env) => {
            env.contractRevisionId = contractRevisionId;
          });
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              d.contract = {
                state: "sealed",
                contractRevisionId,
                contractHash,
                total: d10.executionCases,
                requirements: {
                  total: d10.requirements,
                  ambiguous: d10.ambiguous,
                  disputed: d10.disputed,
                  notBrowserObservable: d10.notBrowserObservable,
                },
              };
              // Seal-time ledger: everything starts `pending`, and the seven buckets
              // must already sum to the total or the write is rejected.
              d.counts = { ...d.counts, pending: d10.executionCases };
              if (d10.executionCases === 0) {
                // A contract with nothing in it is not a run that tested everything — it is
                // a run that extracted nothing. Left alone it sails through every later
                // phase and lands on `test: complete` over an empty denominator, which reads
                // as a clean pass. Name it instead.
                setPhase(d, "extracting", "stopped", "empty-contract");
                d.completion.test = "failed";
                d.completion.reasonCode = "empty-contract";
                d.error = "extraction sealed a contract with zero execution cases — nothing was testable";
              } else {
                setPhase(d, "extracting", "complete");
              }
            },
            { progressed: true, fence },
          );

          return { sealed: true as const, contractRevisionId, contractHash, executionCases: d10.executionCases };
        });

        if (!sealOutcome.sealed) {
          // Fall THROUGH to reporting: a run that could not seal is still a reportable
          // outcome, and the report must say so rather than 404.
          await this.reportAndFinalize(step, runId, fence);
          return;
        }
        sealed = {
          contractRevisionId: sealOutcome.contractRevisionId,
          contractHash: sealOutcome.contractHash,
          executionCases: sealOutcome.executionCases,
        };
      }

      // ---------------------------------------------------------------------
      // PHASE: planning — floor plan + finite pinned exploration plan
      // ---------------------------------------------------------------------
      const plan = resumed.planRevisionId
        ? await step.do("resume-plan", async () => {
            const loaded = await loadCheckpoint(this.env, runId);
            const cursor = loaded?.checkpoint.execution ?? null;
            await beat(this.env, runId, `resuming plan ${resumed.planRevisionId}`, "resume-plan");
            return {
              planRevisionId: resumed.planRevisionId!,
              caseCount: (cursor?.pendingCaseIds.length ?? 0) + (cursor?.completedCaseIds.length ?? 0),
            };
          })
        : await step.do("plan", EXTRACT_POLICY, async () => {
            const planRevisionId = mintPlanRevisionId();
            await updateCheckpoint(this.env, runId, (d) => setPhase(d, "planning", "active"), {
              progressed: true,
              fence,
            });
            // The plan is built AGAINST the sealed revision, by id. Nothing here may widen
            // the denominator it was handed.
            await beat(
              this.env,
              runId,
              `planning routes for ${sealed!.executionCases} floor cases (${sealed!.contractRevisionId})`,
              "plan",
            );

            // WIRED: the deterministic two-tier planner (workflow/stages/plan.ts, a port of
            // pipeline/planner/plan-paths.mjs) runs here. Zero model calls. It returns the
            // floor path set that witnesses every obligation plus the risk-ranked
            // exploration queue, and the case ids below are the SEALED contract's mandatory
            // execution cases — never anything the plan invented.
            //
            // THE ARM SEAM, AND IT IS THE ONLY ONE (evaluation/arms/ARCHITECTURE.md §3.1).
            // `plan` is the slot where arms C and C-R differ and nowhere else, so this is
            // the one place the manifest selects an implementation. With no ARM_MANIFEST
            // set — which is every deployment of survey-qa-v2 — `resolveArm` returns the
            // baseline and `arm.plan` IS `planStage` with the same arguments. Deleting
            // these two lines and calling planStage directly restores the previous file
            // exactly; that is what "reversible" means here.
            const arm = await resolveArm(this.env);
            const planned = await arm.plan(this.env, {
              runId,
              contractRevisionId: sealed!.contractRevisionId,
              planRevisionId,
              surveyUrl: p.surveyUrl,
              seed: null,
            });
            const caseIds: string[] = planned.caseIds;
            await beat(
              this.env,
              runId,
              `plan ${planned.status}: ${planned.floorPaths} floor path(s) witnessing ` +
                `${planned.program.coverage.witnessedByFloor}/${planned.program.coverage.obligations} obligation(s), ` +
                `${planned.explorationEntries} exploration entries, ${caseIds.length} mandatory case(s)`,
              "plan-done",
            );

            await updateCheckpoint(
              this.env,
              runId,
              (d) => {
                d.execution = {
                  batchIndex: 0,
                  sessionId: null,
                  sessionOpenedAt: null,
                  pendingCaseIds: caseIds,
                  completedCaseIds: [],
                  planRevisionId,
                };
                setPhase(d, "planning", "complete");
              },
              { progressed: true, fence },
            );

            const structureModel = await arm.structure(this.env, {
              runId,
              contractRevisionId: sealed!.contractRevisionId,
            });
            if (structureModel) {
              await this.env.EVIDENCE.put(structureModelKey(runId), JSON.stringify(structureModel), {
                httpMetadata: { contentType: "application/json" },
              });
            }

            return { planRevisionId, caseCount: caseIds.length };
          });

      // ---------------------------------------------------------------------
      // PHASE: executing — the checkpointed batch loop
      // ---------------------------------------------------------------------
      await step.do("phase-executing", async () => {
        await updateCheckpoint(this.env, runId, (d) => setPhase(d, "executing", "active"), {
          progressed: true,
          fence,
        });
        await beat(this.env, runId, `executing plan ${plan.planRevisionId} (${plan.caseCount} cases)`, "exec");
      });

      const maxBatches = num(this.env.EXEC_MAX_BATCHES, 200);
      let stopReason: string | null = null;

      // RESUME AT THE DURABLE CURSOR, not at zero. Restarting the loop index would replay
      // batches whose observations are already committed and re-drive the browser for them.
      for (let batch = resumed.batchIndex; batch < resumed.batchIndex + maxBatches; batch++) {
        const outcome = await step.do(`execute-batch-${batch}`, BATCH_POLICY, async () => {
          const loaded = await loadCheckpoint(this.env, runId);
          if (!loaded) return { done: true, stopReason: "checkpoint-missing" as string | null };
          const cp = loaded.checkpoint;
          // FENCE BEFORE THE BROWSER, not only before the write. A batch that discovers it
          // has been superseded must not touch the target site at all: the side effects of
          // driving a survey (submissions, quota, vendor rate limits) cannot be rolled back
          // by losing the checkpoint write afterwards.
          assertOwner(runId, cp, fence);

          const cursor = cp.execution;
          // NO CURSOR MEANS NO PLAN TO EXECUTE. An EMPTY `pendingCaseIds` does NOT mean the
          // work is finished, though, and stopping here on it used to silently skip tier 2
          // altogether: exploration entries deliberately have no execution case id — that is
          // exactly how they are prevented from touching the denominator — so the mandatory
          // ledger empties while the exploration queue is still full. What is left to do is
          // a question for the executor, which owns the plan; it answers by returning
          // `done`.

          // CAP ENFORCEMENT IS A FIRST-CLASS EXIT, NOT AN EXCEPTION — and it runs BEFORE
          // the cursor check, not after. A run whose usage counters are already over their
          // cap must stop regardless of whether it has work left: skipping the check when
          // the cursor is null let a capped run sail through to `test: complete` with a
          // null reasonCode, which is the "cap protects nothing" shape this check exists
          // to delete. Each limit keeps its own name so the report can say WHICH one
          // stopped the run.
          //
          // THE WALL-CLOCK CAP GETS ITS COUNTER HERE. `tickWallClock` is the ONLY writer of
          // `usage.wallClock.usedMilliseconds`; without it the cap read a number nothing
          // ever incremented and could never fire. Await it so the check below compares
          // the live elapsed time, not a stale checkpoint value.
          await tickWallClock(this.env, runId, fence);
          const capStop = capExceeded(cp.usage);
          if (capStop) return { done: true, stopReason: capStop };

          if (!cursor) {
            return { done: true, stopReason: null as string | null };
          }

          // --- WIRED: drive the survey. browser/driver.ts walks the planned paths through
          // a real Browser Rendering session, captures the complete rendered inventory of
          // every screen plus a screenshot, writes each artifact into the content-addressed
          // store AS IT IS CAPTURED, and commits a checkpoint after EVERY path — so a crash
          // costs at most one walk and the replacement reconnects to the same browser.
          //
          // The executor records what it SAW. It does not decide whether that matches the
          // document: nothing it returns carries a verdict.
          const exec = await executeBatch(this.env, {
            runId,
            batch,
            fence,
            cursor,
            surveyUrl: p.surveyUrl,
            planRevisionId: cursor.planRevisionId ?? plan.planRevisionId,
          });
          await beat(
            this.env,
            runId,
            `batch ${batch}: ${exec.pathsWalked} path(s), ${exec.steps} screen(s), ${exec.casesClosed} case(s) closed`,
            `${batch}:done`,
          );
          return { done: exec.done, stopReason: exec.stopReason };
        });

        if (outcome.stopReason) {
          stopReason = outcome.stopReason;
          break;
        }
        if (outcome.done) break;
      }

      await step.do("phase-executing-close", async () => {
        await updateCheckpoint(
          this.env,
          runId,
          (d) => {
            const c = d.execution;
            const leftover = c?.pendingCaseIds.length ?? 0;
            if (stopReason) {
              // A limit stopped us. Reclassify what was never reached so the ledger still
              // reconciles: unexercised cases become the bucket named by the cap.
              const bucket = stopBucket(stopReason);
              d.counts[bucket] += d.counts.pending;
              d.counts.pending = 0;
              setPhase(d, "executing", "stopped", stopReason);
              d.completion.test = stopCompletion(stopReason);
              d.completion.reasonCode = stopReason;
            } else if (leftover > 0) {
              d.counts["not-reached"] += d.counts.pending;
              d.counts.pending = 0;
              setPhase(d, "executing", "stopped", "batch-budget-exhausted");
              d.completion.test = "partial-blocked";
              d.completion.reasonCode = "batch-budget-exhausted";
            } else {
              setPhase(d, "executing", "complete");
            }
          },
          { progressed: true, fence },
        );
      });

      // ---------------------------------------------------------------------
      // YIELD THE INVOCATION BEFORE JUDGING.
      //
      // Execution is the expensive half of a run in SUBREQUESTS, not just in time: every
      // screen read and every screenshot is a `putEvidence` (a head, a conditional put and a
      // catalogue put), and v2r_01kzfb6py8pbxznqv022p2qkhb wrote 1,707 of them across 14
      // `execute-batch` steps. Those steps share ONE Worker invocation with everything after
      // them, and the invocation has a bounded subrequest budget — so by the time the
      // judging tail ran, the budget was nearly gone and `verify-observations` died on it,
      // three attempts deep, with `Too many API requests by single Worker invocation`.
      //
      // A sleep is the documented way to make a Workflow yield: the instance goes to
      // `waiting` and is scheduled again when it wakes, and a fresh invocation starts with a
      // fresh budget. This sleep sits exactly on the execution/judging seam because the tail
      // behind it — project, verify, derive, assemble, mint, report — is a fixed, bounded
      // amount of work that has no business inheriting a budget spent on 46 walks. It also
      // covers the stages this file cannot make cheaper: `derive-verdicts` and `report`
      // still fetch and re-hash EVERY catalogued artifact.
      //
      // HONEST LIMIT OF THE CLAIM: Cloudflare's docs say the running→waiting transition "may
      // not occur if the wait duration is very short" and publish no threshold, so 30 seconds
      // is a judgement, not a proof, and nothing local can verify it. Treat this as one of
      // three layers, not the fix: the load-bearing ones are `limits.subrequests` in
      // wrangler.jsonc and verify-observations no longer listing the whole catalogue.
      //
      // It costs 30 seconds of wall time on a run that takes many minutes, and `step.sleep`
      // does not count against the Workflow's step limit.
      await step.sleep("yield-before-judging", "30 seconds");

      // ---------------------------------------------------------------------
      // COMMIT THE OBSERVATION LEDGER.
      //
      // The executor walks PATHS and leaves two durable things: the walk artifacts in the
      // content-addressed evidence store, and the walk ledger in `execution/progress.json`.
      // Neither is an `Observation`, and every judging stage below reads
      // `v2/runs/<id>/observations.json`. This step is the projection between them — the
      // plan's path→case assignment applied to what the walks actually closed — and without
      // it the aggregator ran over an empty array and returned `pending` for every sealed
      // case no matter how well the run had gone.
      //
      // It authors no verifier decision. It is deliberately BEFORE `verify-observations`
      // and separate from it: the stage that records what happened may not be the stage
      // that decides whether it was right.
      // ---------------------------------------------------------------------
      await step.do("project-observations", DERIVE_POLICY, async () => {
        await beat(this.env, runId, "committing the observation ledger", "project");
        const projected = await projectObservations(this.env, runId);
        if (projected.state === "evaluated") {
          await beat(
            this.env,
            runId,
            `committed ${projected.value.observations} observation(s) from ${projected.value.contributingWalks} ` +
              `of ${projected.value.walks} walk(s)`,
            "project-done",
          );
        } else {
          // A run with no plan or no program has nothing to project. That is a fact about
          // the run, reported as a note; the verify stage then reads an empty ledger and
          // the aggregator reports `pending`, which is the honest outcome.
          await beat(this.env, runId, `no observation ledger: ${projected.reason}`, "project-none");
        }
      });

      // ---------------------------------------------------------------------
      // PHASE: verifying — tri-state predicate verification of observations
      // ---------------------------------------------------------------------
      await step.do("verify-observations", DERIVE_POLICY, async () => {
        await updateCheckpoint(this.env, runId, (d) => setPhase(d, "verifying", "active"), {
          progressed: true,
          fence,
        });
        await beat(this.env, runId, "verifying observations", "verify");

        // WIRED: stages/verify-observations.ts. It stamps every observation with a
        // tri-state decision, and the ONLY route to `verified` is a closed predicate that
        // compared a TYPED EXPECTATION sealed in the contract revision against the walk
        // artifact's bytes, re-read and re-hashed by this stage. Remove any link of that
        // chain — no typed case, no locatable artifact, bytes that will not re-read, no
        // step that exercised the case — and the result is `insufficient`, not a pass. The
        // run therefore still cannot obtain a pass from a verifier that compared nothing.
        //
        // Case kinds with no model-free expectation (`rendered-state`, `copy`, `option-set`,
        // `configuration`) stay `insufficient` with NO_TYPED_EXPECTATION until the model
        // verifier is wired. That is a smaller claim than the run would like to make and it
        // is the true one.
        const verified = await verifyObservations(this.env, runId);

        await updateCheckpoint(
          this.env,
          runId,
          (d) => {
            if (verified.state !== "evaluated") {
              setPhase(d, "verifying", "stopped", NOT_IMPLEMENTED_VERIFICATION);
              return;
            }
            // COMPLETE means "every observation carries a decision", NOT "everything
            // verified". Zero observations is a complete pass over an empty set, and the
            // emptiness is already reported by the execution phase that produced it.
            setPhase(d, "verifying", "complete");
          },
          { progressed: true, fence },
        );
        if (verified.state === "evaluated") {
          await beat(
            this.env,
            runId,
            `verified ${verified.value.verified} · contradicted ${verified.value.contradicted} · ` +
              `insufficient ${verified.value.insufficient} of ${verified.value.observations}`,
            "verify-done",
          );
        }
      });

      // ---------------------------------------------------------------------
      // PHASE: adjudicating — DERIVE verdicts. NO MODEL CALL IS PERMITTED HERE.
      // ---------------------------------------------------------------------
      const adjudication = await step.do("derive-verdicts", DERIVE_POLICY, async () => {
        await updateCheckpoint(this.env, runId, (d) => setPhase(d, "adjudicating", "active"), {
          progressed: true,
          fence,
        });
        await beat(this.env, runId, "deriving verdicts", "derive");
        // WIRED: stages/derive-verdicts.ts#deriveItemResults — deterministic aggregation
        // over observations + the SEALED contract. No model call is reachable from it, and
        // `rejectModelDerivedVerdicts` refuses any ItemResult whose `derivedBy` is not the
        // aggregator, here and again at the record write boundary.
        //
        // The rules it implements, and why each one is in the aggregator rather than in a
        // prose stage that could be argued with:
        //   - fail-if-any across floor and executed exploration cases;
        //   - a later pass NEVER erases an earlier fail;
        //   - routes disagree => pathConsistency "mixed" + divergenceSet;
        //   - DEBRIEF fix #4: an obligation carrying an unresolved ambiguity may not be
        //     closed `fail` — it becomes JUDGMENT_WITHHELD_AMBIGUOUS;
        //   - AMBIGUITY SUPPRESSION IS DEPENDENCY-AWARE, NOT REDUNDANCY-AWARE (Tier-1
        //     ruling): an ambiguity withholds a result only when the competing readings
        //     would change a field THAT PREDICATE consumes. An outcome-relevant ambiguity
        //     withholds even when it is the sole covering obligation; an irrelevant
        //     wording ambiguity suppresses nothing.
        //   - every ItemResult.derivedBy is the aggregator id. A model id here is a
        //     contract violation and assemble-record rejects the record.
        const result = await deriveItemResults(this.env, runId);

        await updateCheckpoint(
          this.env,
          runId,
          (d) =>
            setPhase(
              d,
              "adjudicating",
              result.state === "evaluated" ? "complete" : "stopped",
              result.state === "evaluated" ? null : NOT_IMPLEMENTED_ADJUDICATION,
            ),
          { progressed: true, fence },
        );
        if (result.state === "evaluated") {
          await beat(
            this.env,
            runId,
            `derived ${result.value.summary.requirements} requirement verdict(s) over ` +
              `${result.value.summary.cases} case(s): ${JSON.stringify(result.value.summary.byVerdict)}`,
            "derive-done",
          );
        }
        return result;
      });

      // THE RECORD IS ASSEMBLED FROM THE AGGREGATOR'S OUTPUT, and the judge is run against
      // the RECORD — so the order is aggregate → assemble → judge and cannot be otherwise:
      // the JudgementRecord's binding names the record's payload hash, its sealed revision
      // and its evidence-manifest root, none of which exist before the record does.
      const assembled = await step.do("assemble-record", DERIVE_POLICY, async () => {
        await beat(this.env, runId, "assembling run record", "record");
        if (adjudication.state !== "evaluated") {
          return stageNotEvaluated<{ recordHash: string }>(
            "NO_VERDICTS",
            "the aggregator produced no ItemResults, so there is nothing for a record to record",
          );
        }
        const out = await assembleRecord(this.env, runId, adjudication.value.itemResults);
        if (out.state === "evaluated") {
          await beat(
            this.env,
            runId,
            `record assembled: ${out.value.requirements} requirement(s), ${out.value.evidence} evidence entr(ies), ` +
              `${out.value.signed ? "signed" : "UNSIGNED (no record key configured)"}`,
            "record-done",
          );
        }
        return out;
      });

      // THE INDEPENDENT RE-DERIVATION. `pipeline/judge/` runs IN THIS ISOLATE over the
      // signed record and the verified artifact bytes, and writes an attested
      // JudgementRecord to v2/runs/<id>/judgement.json — the key report/build.ts reads
      // through store/judgement.ts's four demoting gates.
      //
      // ITS FAILURE IS NOT THE RUN'S FAILURE. A run with no judgement still reports; it
      // reports ONE column and says the second is unavailable, which is strictly more
      // honest than a run that refuses to publish what it did observe.
      const judgement = await step.do("mint-judgement", DERIVE_POLICY, async () => {
        if (assembled.state !== "evaluated") {
          return stageNotEvaluated<{ status: string }>(
            "NO_RUN_RECORD",
            "no RunRecord was assembled, so there is nothing for the judge to re-derive verdicts from",
          );
        }
        await beat(this.env, runId, "re-deriving verdicts from signed evidence", "judge");
        const out = await mintJudgement(this.env, runId);
        if (out.state === "evaluated") {
          await beat(
            this.env,
            runId,
            `judgement ${out.value.status}: authority verified=${out.value.authority.verified} ` +
              `manifest=${out.value.authority.manifestComplete} over ${out.value.artifacts} artifact(s)`,
            "judge-done",
          );
        } else {
          console.log(`v2 ${runId}: judgement not minted — ${out.reason}: ${out.detail}`);
        }
        return out;
      });
      void judgement;

      // ---------------------------------------------------------------------
      // THE ONLY GATE THAT MAY CLOSE THE TEST AXIS.
      //
      // `completion.test` used to be flipped from `running` to `complete` inside the
      // report step, on both the success AND failure branches, purely because report
      // construction had ENDED. A run whose report failed to build therefore reported that
      // testing had completed. Closing the test axis is a claim about COVERAGE AND
      // ADJUDICATION, and it is made here, from proof, or not at all.
      // ---------------------------------------------------------------------
      await step.do("close-test-axis", async () => {
        const loaded = await loadCheckpoint(this.env, runId);
        if (!loaded) return;

        // Routing-graph edge coverage — informational, does not block the test axis.
        try {
          const progress = await loadProgress(this.env, runId, plan.planRevisionId);
          const allExercisedIds = new Set<string>();
          for (const w of progress.walks) {
            for (const cid of w.caseIds) allExercisedIds.add(cid);
          }
          const structureObj = await this.env.EVIDENCE.get(structureModelKey(runId));
          if (structureObj) {
            const model = (await structureObj.json()) as StructureModel;
            if (model && Array.isArray(model.edges)) {
              const coverage = computeEdgeCoverage(model, allExercisedIds);
              await beat(
                this.env,
                runId,
                `routing graph: ${coverage.traversed}/${coverage.denominator} edges traversed, ${coverage.untouched} untouched`,
                "structure-coverage",
              );
              // Store durably so the report can surface it.
              await this.env.EVIDENCE.put(
                edgeCoverageKey(runId),
                JSON.stringify(coverage),
                { httpMetadata: { contentType: "application/json" } },
              );
            }
          }
        } catch (err) {
          console.warn(
            `v2 ${runId}: edge coverage computation failed (non-blocking): ${String(err).slice(0, 500)}`,
          );
        }

        const blockers = testAxisBlockers(loaded.checkpoint, adjudication, assembled);
        if (blockers.length === 0) {
          await updateCheckpoint(
            this.env,
            runId,
            (d) => {
              // NEVER CLOBBER AN EARLIER STOP. A run that already ended `failed` or
              // `partial-blocked` (a cap was breached, execution stopped, a batch budget
              // ran out) has its reasonCode on file. The seed-shaped trap this deletes:
              // a cap-stopped run whose ledger happened to look settled (pending was
              // already 0 when the cap fired) used to be OVERWRITTEN here to
              // `test: complete / reasonCode: null` — the exact "cap protects nothing"
              // shape the cap check exists to prevent. The axis may be closed to
              // `complete` only from a state that is still `running`/`not-started`.
              if (d.completion.test === "running" || d.completion.test === "not-started") {
                d.completion.test = "complete";
                d.completion.reasonCode = null;
              }
            },
            { progressed: true, fence },
          );
          await beat(this.env, runId, "test axis closed: every case has a terminal disposition", "close");
        } else {
          await beat(this.env, runId, `test axis NOT closed: ${blockers.join("; ")}`, "close-blocked");
          console.log(`v2 ${runId}: test axis not closed — ${blockers.join("; ")}`);
        }
      });

      await this.reportAndFinalize(step, runId, fence);
    } catch (err) {
      if (err instanceof OwnershipLost) {
        // Not a failure of the run — a failure of THIS instance's claim on it. The owner
        // is still working; writing an error here would corrupt its state.
        console.log(`v2 ${runId}: ${err.message}`);
        return;
      }
      // THE CAUSE IS ASSEMBLED BEFORE ANY STEP RUNS, AND IT COSTS NOTHING TO HOLD.
      //
      // What arrives at `err` is whatever survived the durable step boundary, which on
      // `v2r_01kzf7ehb2sayx2y2xz4ecm1ed` was not the sentence the engine had recorded three
      // times. Two in-memory facts, both free, both better than the boundary's leftovers:
      //
      //   this.lastFailure   — the FIRST cause a step closure saw, captured in the same
      //                        isolate as the throw. Present whenever a body actually ran.
      //   this.stepInFlight  — the name of the step being awaited. Present EVEN WHEN THE
      //                        BODY DID NOT RUN (a cached failure re-thrown at the boundary
      //                        on replay), which is exactly when `lastFailure` is empty.
      //
      // Neither costs a subrequest, which is the whole point: on the run that prompted this,
      // storage was the thing that had run out.
      const cause = this.lastFailure ?? describeFailure(this.stepInFlight ?? "unknown", err);

      // RECORDING CAN FAIL, AND ITS FAILURE MUST NOT BECOME THE RUN'S ENDING.
      //
      // `record-failure` used to be an unguarded `await step.do(...)`. On
      // `v2r_01kzfb6py8pbxznqv022p2qkhb` it threw — the same subrequest-ceiling error, on
      // all four attempts, 0 seconds each — and that throw left the catch block, so the
      // reporting call below never ran. The engine's step list ends `verify-observations-1,
      // record-failure-1`: no `report-1`, no `finalize-1`. A run that could not explain
      // itself also lost the one artifact that could have explained it.
      let recorded = await this.commitFailure(step, runId, cause, "record-failure");

      // A SECOND ATTEMPT ON THE OTHER SIDE OF A SLEEP, AND WHAT IT IS AND IS NOT.
      //
      // `step.sleep` hibernates the instance; the engine then re-invokes it, and a NEW Worker
      // invocation is the only thing that could plausibly carry a new subrequest budget.
      // It is a SECOND CHANCE, NOT A GUARANTEE, and the honest reading of the incident is
      // that it may not be one at all: the four `record-failure` retries (5s, 10s, 20s
      // backoff) each failed instantly with the same ceiling error, so short retry delays
      // demonstrably did NOT reset the budget, and Cloudflare documents the ceiling as
      // "per Workflow instance" in one place and "per invocation" in another. So this path
      // is cheap, guarded, and load-bearing for nothing — the surface that actually rescued
      // this incident is the engine read in `src/api/runs.ts`, which needs no budget here at
      // all.
      if (!recorded) {
        try {
          await step.sleep("failure-recording-cooldown", FAILURE_RECORDING_COOLDOWN);
          recorded = await this.commitFailure(step, runId, cause, "record-failure-after-cooldown");
        } catch (sleepErr) {
          console.error(`v2 ${runId}: could not pause before re-recording the cause — ${String(sleepErr).slice(0, 300)}`);
        }
      }
      if (!recorded) {
        // THE ACTIVE MARKER STAYS SET, DELIBERATELY. `commitFailure` clears it only after
        // the cause is durable; a run whose ending was never written down is precisely the
        // run the sweeper must keep seeing.
        console.error(
          `v2 ${runId}: the run's cause could not be written to durable storage at all ` +
            `(${cause.reasonCode} in ${cause.step}). It remains readable from the Workflows engine, ` +
            `which is what the status endpoint falls back to.`,
        );
      }

      // AND THEN IT REPORTS. Every deliberate stop above ends with `reportAndFinalize`; the
      // uncaught-failure path did not, so a step that threw produced a run with an error on
      // file and no report to explain it — `GET .../report` 404s and the reader is left with
      // the least legible ending the system can produce. Reporting cannot change the test
      // axis (see reportAndFinalize), so this adds an explanation and nothing else.
      //
      // ITS OWN FAILURE IS SWALLOWED, DELIBERATELY: the original error is what actually
      // happened to this run and must be the one that propagates, so a report that cannot be
      // built (or a fence that has since been superseded) is logged and not allowed to
      // replace it.
      if (reportingFence) {
        try {
          await this.reportAndFinalize(step, runId, reportingFence);
        } catch (reportErr) {
          console.error(
            `v2 ${runId}: reporting the failure ALSO failed — ${String(reportErr).slice(0, 500)}. ` +
              `Rethrowing the original error.`,
          );
        }
      }
      throw err;
    }
  }

  /**
   * RECORD THE CAUSE WHERE THE CAUSE STILL EXISTS.
   *
   * This is the whole fix, and it is a fix about WHERE, not about what. The outer catch
   * below already recorded a failure and already rethrew; what it could not do was say
   * why, because by the time a step's error reaches it the error has crossed the durable
   * Workflow step boundary and arrives as whatever the engine chose to hand back. On
   * `v2r_01kzf7ehb2sayx2y2xz4ecm1ed` the engine's own step record held
   * `Error: planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9`
   * across all three attempts — a perfect diagnosis — and the run published
   * `reasonCode: "workflow-error"` with nothing in `error`. Two surfaces, one of them the
   * product's, and only the one nobody can reach had the answer.
   *
   * Wrapping the step BODY puts the recorder in the same isolate as the throw, before any
   * boundary, holding the real error object. It also learns the step's NAME, which the
   * outer catch has never had and which was only ever obtainable from the engine API.
   *
   * IT SWALLOWS NOTHING. Every path here ends in `throw err` with the original value, so
   * the step still fails, the retry policy still applies, and the Workflow instance still
   * genuinely errors. Recording is strictly additive: a failure to record is logged and
   * discarded, because a contention on the way to explaining an error must never become
   * the error the run reports.
   */
  private instrumentSteps(step: WorkflowStep, runId: string): WorkflowStep {
    // NEVER `.bind`, `.call` or `.apply` ANYTHING ON `step`, AND NEVER READ A METHOD OFF IT
    // TO HOLD ONTO. In production `step` is a JSRPC stub: property access is intercepted and
    // resolved as a method name on the far side, so `step.do.bind(step)` asks the remote for
    // a method literally called "bind" and the instance dies with
    // `TypeError: The RPC receiver does not implement the method "bind"` — in 0 seconds,
    // before step 1, which is what killed v2r_01kzfa0dx1pg90xcvamef6zb6c.
    //
    // The plain `target.method(...)` call form is the ONLY form a stub supports, so every
    // forward below uses it. This cannot be caught by the suite: the test double is an
    // ordinary object where `.bind` is `Function.prototype.bind` and works. The guard that
    // CAN fail is the source assertion in tools/tests/failure-cause.test.mjs.
    const inner = (name: string, a: unknown, b?: unknown): Promise<unknown> =>
      (b === undefined
        ? (step.do as (n: string, x: unknown) => Promise<unknown>)(name, a)
        : (step.do as (n: string, x: unknown, y: unknown) => Promise<unknown>)(name, a, b));

    const wrapped = (name: string, a: unknown, b?: unknown): Promise<unknown> => {
      // WHICH STEP WE ARE IN, RECORDED WHERE A REPLAY CAN STILL SEE IT. Set here rather
      // than inside `guarded`, because `guarded` is the BODY: on a replay after hibernation
      // the engine re-throws a step's persisted failure at the boundary and the body never
      // runs at all, and that is precisely the case where the outer catch would otherwise
      // be reduced to the word "unknown". One assignment, no I/O, correct on both passes.
      this.stepInFlight = name;
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      const guarded = async (): Promise<unknown> => {
        try {
          const result = await body();
          await this.withdrawFailureCause(runId, name);
          return result;
        } catch (err) {
          // NOT this run's failure — this instance's loss of the run. The outer catch
          // already treats it as "stop quietly"; writing a cause here would put a
          // superseded instance's complaint on the live owner's checkpoint.
          if (err instanceof OwnershipLost) throw err;
          await this.recordFailureCause(runId, name, err);
          throw err;
        }
      };
      return typeof a === "function" ? inner(name, guarded) : inner(name, a, guarded);
    };

    // A proxy rather than a hand-written delegate: `sleep`, `sleepUntil`, `waitForEvent`
    // and anything the platform adds later keep working without this file listing them,
    // and a test double's own properties (`calls`) stay visible to the test holding it.
    return new Proxy(step, {
      get(target, prop) {
        if (prop === "do") return wrapped;

        // `then` MUST NOT be forwarded. A stub answers every property, so a forwarded
        // `then` would make this proxy look thenable and any `await` on it would call a
        // remote method that does not exist — the same crash in a subtler place.
        if (prop === "then") return undefined;

        // Reading a property off a stub can itself throw. Losing an optional platform
        // method is survivable; taking down the run to look one up is not.
        let value: unknown;
        try {
          value = Reflect.get(target, prop);
        } catch {
          return undefined;
        }
        if (typeof value !== "function") return value;

        // Direct call form, resolved at CALL time — never a detached reference and never
        // `.bind`. On a stub this is the one shape that works; on a plain test double it
        // is an ordinary method call with the correct receiver.
        // MUST stay an inline `host[prop](...)` member call. Lifting it to
        // `const fn = host[prop]; fn(...)` detaches the receiver, which is the same defect
        // in a different shape. The `!` is type-level only and emits the member call.
        const host = target as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>;
        return (...args: unknown[]): unknown => host[prop]!(...args);
      },
    }) as WorkflowStep;
  }

  /**
   * COMMIT THE RUN'S ENDING — and report whether it actually landed.
   *
   * A `boolean` return rather than a throw, because the caller's next move depends on the
   * answer and a throw takes that decision away from it. This is the difference between the
   * run that prompted the change and the one that follows it: `record-failure` used to be an
   * unguarded `await step.do(...)` inside the catch, so when it exhausted its retries the
   * throw walked out of the catch block and reporting — the next statement — never ran.
   *
   * THE MUTATION IS THE HONEST-REASON RULE. See the comments inside.
   */
  private async commitFailure(
    step: WorkflowStep,
    runId: string,
    cause: RunFailure,
    stepName: string,
  ): Promise<boolean> {
    try {
      await step.do(stepName, { retries: { limit: 3, delay: "5 seconds" } }, async () => {
        await updateCheckpoint(
          this.env,
          runId,
          (d) => {
            // The in-closure record names the step and carries the untruncated cause; the
            // in-memory `cause` is the same object when the closure ran at all. Never
            // overwrite the better of the two.
            const failure = d.failure ?? cause;
            d.failure = failure;
            // ONE TRUTH, TWO SPELLINGS. `error` is the sentence a person reads and
            // `failure.message` is the same sentence a client renders; deriving one from
            // the other is what stops them from ever disagreeing.
            d.error = failure.message.slice(0, ERROR_TEXT_MAX);

            // ---------------------------------------------------------------
            // A PHASE OUTCOME IS NOT A RUN OUTCOME, AND THE HEADLINE BELONGS TO THE RUN.
            //
            // `v2r_01kzfb6py8pbxznqv022p2qkhb` published
            // `test: partial-blocked · reasonCode: walks-blocked-by-site`. Both halves were
            // once true — the site really did block most walks — and by the time a reader
            // saw them the run had been dead for minutes, killed in VERIFICATION by
            // something with nothing to do with the site. The old rule produced that: it
            // only promoted `running` to `failed`, and its `??` treated any reason already
            // on file as settled.
            //
            // `partial-*` is PROVISIONAL when the run reaches this catch. It is written by
            // `phase-executing-close` with verification, adjudication and reporting still
            // ahead; arriving here means those never happened, so the run did not end
            // partially — it died holding a partial result. `complete` and `failed` are
            // different: something downstream already closed the axis and already named a
            // cause, and THAT one is the deliberate ending. Do not touch it.
            //
            // NOTHING IS LOST. The phase rail keeps `executing: stopped ·
            // walks-blocked-by-site` untouched below, because this loop only ever writes to
            // phases still marked `active`. Two facts, two places, both true: what happened
            // in the walk phase, and what ended the run.
            // ---------------------------------------------------------------
            const alreadySettled = d.completion.test === "complete" || d.completion.test === "failed";
            if (alreadySettled) {
              // A NAMED REASON WHEN WE HAVE ONE. `workflow-error` is the code for "something
              // threw and we do not know what", and a guard that deliberately refused is not
              // that — `failure.reasonCode` says `planning-refused` where the classifier
              // recognised the refusal, and falls back to `workflow-error` where it did not.
              d.completion.reasonCode = d.completion.reasonCode ?? failure.reasonCode;
            } else {
              d.completion.test = "failed";
              d.completion.reasonCode = failure.reasonCode;
            }

            for (const ph of d.phases) {
              if (ph.state === "active") {
                ph.state = "stopped";
                // The phase rail has carried a `reasonCode` for `stopped` since it was
                // written and the uncaught path was the one branch that stopped a phase
                // without filling it in, so the rail showed which phase died and refused
                // to say why.
                ph.reasonCode = ph.reasonCode ?? failure.reasonCode;
              }
            }
          },
          { progressed: true },
        );
        // CLEARED LAST, AND ONLY ONCE THE CAUSE IS DURABLE. A crash before this line leaves
        // the run visible to the sweeper, which is the correct place for a run whose ending
        // nobody managed to write down.
        await clearActive(this.env, runId);
      });
      return true;
    } catch (recordErr) {
      console.error(
        `v2 ${runId}: ${stepName} could not reach durable storage — ` +
          `${sanitiseErrorText(recordErr, FAILURE_MESSAGE_MAX)}. The cause it was carrying was ` +
          `${cause.reasonCode} in ${cause.step}.`,
      );
      return false;
    }
  }

  /** Write the structured cause. Best-effort by construction; never replaces the error. */
  private async recordFailureCause(runId: string, stepName: string, err: unknown): Promise<void> {
    // FULL FIDELITY TO THE OPERATOR, SANITISED TEXT TO THE USER. Workers observability is
    // an authenticated surface and keeps the whole object, stack and all; the checkpoint
    // is a published one and gets only what `sanitiseErrorText` allows out.
    console.error(`v2 ${runId}: step ${stepName} threw —`, err);
    const failure = describeFailure(stepName, err);
    // THE FREE COPY, TAKEN BEFORE THE EXPENSIVE ONE IS ATTEMPTED. If the write below is the
    // thing that cannot happen — which is the whole shape of the subrequest-ceiling
    // failure — this line has already preserved everything the outer catch needs.
    if (!this.lastFailure) this.lastFailure = failure;
    try {
      await updateCheckpoint(this.env, runId, (d) => {
        // FIRST CAUSE WINS. `plan` failed three times with the same message; a run that
        // fails in extraction and then fails again while reporting the failure should
        // report the extraction, not the aftershock. Returning false writes nothing.
        if (d.failure) return false;
        d.failure = failure;
      });
      this.causeRecordedFor.add(stepName);
    } catch (recordErr) {
      console.error(
        `v2 ${runId}: could not record why ${stepName} failed — ${sanitiseErrorText(recordErr, FAILURE_MESSAGE_MAX)}`,
      );
    }
  }

  /**
   * A RETRY THAT SUCCEEDED IS NOT A FAILURE. `plan` runs under a 2-retry policy: if
   * attempt 1 throws and attempt 2 works, the run is fine and must not carry a cause that
   * contradicts its own outcome for the rest of its life.
   */
  private async withdrawFailureCause(runId: string, stepName: string): Promise<void> {
    // The in-memory copy is withdrawn too, and BEFORE the early return — it is written on
    // every throw, including the ones whose durable write never landed, so gating its
    // withdrawal on `causeRecordedFor` would let a step that eventually succeeded keep
    // handing the outer catch a cause its own outcome contradicts.
    if (this.lastFailure && this.lastFailure.step === stepName) this.lastFailure = null;
    if (!this.causeRecordedFor.has(stepName)) return;
    this.causeRecordedFor.delete(stepName);
    try {
      await updateCheckpoint(this.env, runId, (d) => {
        if (!d.failure || d.failure.step !== stepName) return false;
        d.failure = null;
      });
    } catch (err) {
      console.warn(`v2 ${runId}: could not withdraw ${stepName}'s superseded failure cause:`, err);
    }
  }

  /**
   * PHASE: reporting, then finalize. Runs even for a partial, stopped or unsealed test —
   * and CANNOT change the test axis, in either direction, on either branch.
   */
  private async reportAndFinalize(step: WorkflowStep, runId: string, fence: Fence): Promise<void> {
    await step.do("report", REPORT_POLICY, async () => {
      await updateCheckpoint(
        this.env,
        runId,
        (d) => {
          setPhase(d, "reporting", "active");
          d.completion.report = "building";
        },
        { progressed: true, fence },
      );
      await beat(this.env, runId, "building report", "report");

      // WIRED: the upgraded renderer (pipeline/report/) runs here, in-Worker, and
      // COMMITS its bytes to R2 behind an atomic pointer. `GET .../report` then serves
      // those exact bytes. Missing evidence/scorecard degrades ITS SECTION inside the view
      // model; a missing RunRecord is not a degraded report, it is no report, and says so.
      const built = await buildAndStoreReport(this.env, runId);

      await updateCheckpoint(
        this.env,
        runId,
        (d) => {
          if (built.ok) {
            setPhase(d, "reporting", "complete");
            d.completion.report = "complete";
            d.reportAvailable = true;
          } else {
            // NEVER `complete` without an artifact behind it. `report-artifact-missing`
            // exists as an endpoint state to catch this inconsistency; do not create it.
            setPhase(d, "reporting", "stopped", built.reasonCode);
            d.completion.report = "failed";
            d.completion.reasonCode = d.completion.reasonCode ?? built.reasonCode;
            d.reportAvailable = false;
          }
          // completion.test is DELIBERATELY UNTOUCHED on both branches. Reporting is a
          // different axis and knows nothing about coverage.
        },
        { progressed: true, fence },
      );

      if (!built.ok) console.error(`v2 report build failed for ${runId}: ${built.reasonCode} — ${built.detail}`);
      else console.log(`v2 report built for ${runId}:`, JSON.stringify(built.summary));
    });

    await step.do("finalize", async () => {
      // The envelope records what the checkpoint ACTUALLY says, not a hardcoded
      // success. A run that ended `partial-budget` / `report: failed` must be
      // recoverable as such from the envelope alone.
      const loaded = await loadCheckpoint(this.env, runId);

      // A run that reaches finalize with the test axis still `running` never closed it,
      // and leaving it there would keep the sweeper poking a finished run forever while
      // every reader shows an in-progress test. Name it.
      const stillRunning = loaded?.checkpoint.completion.test === "running";
      if (stillRunning) {
        await updateCheckpoint(
          this.env,
          runId,
          (d) => {
            d.completion.test = "failed";
            d.completion.reasonCode = d.completion.reasonCode ?? TEST_AXIS_NEVER_CLOSED;
            d.error =
              d.error ??
              "the run finished without any stage closing the test axis: no coverage/adjudication gate was satisfied";
          },
          { progressed: true, fence },
        );
      }

      const after = await loadCheckpoint(this.env, runId);
      const completion = after?.checkpoint.completion ?? { test: "failed" as const, report: "failed" as const };

      // RECOVERY STATE IS CLEARED ON A CLEAN FINISH. It used to be left set, so a run that
      // was successfully recovered kept reporting "recovery mode" forever and the sweeper
      // kept treating its attempt budget as spent.
      await updateCheckpoint(
        this.env,
        runId,
        (d) => {
          if (d.recovery?.active) d.recovery = { ...d.recovery, active: false };
          // A CAUSE WITH NO ERROR BEHIND IT IS A STEP THAT WAS RETRIED AWAY. Every path
          // that actually ends a run badly — `record-failure`, each deliberate stop, the
          // sweeper, the axis check just above — writes `error` as it writes the outcome.
          // A `failure` sitting beside a null `error` therefore belongs to an attempt that
          // subsequently succeeded, and leaving it would show a finished, healthy run a
          // cause it recovered from. `withdrawFailureCause` handles this in the common
          // case; this is the backstop for a retry that resumed in a different isolate.
          if (d.failure && d.error === null) d.failure = null;
        },
        { fence },
      );
      await clearActive(this.env, runId);
      await updateEnvelope(this.env, runId, (env) => {
        env.finalCompletion = { test: completion.test, report: completion.report };
        if (env.recovery) {
          env.recovery = {
            ...env.recovery,
            phase: undefined,
            leaseUntil: undefined,
            claimId: undefined,
            stallValue: undefined,
            stallSeenAt: undefined,
            unknownStreak: 0,
          };
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Gate derivation — the four §0 approval gates, from stage results
// ---------------------------------------------------------------------------

/**
 * Two of these gates used to be the literal `true` and two were `stub() === 0`. They are
 * now derived from the stage results, and an unevaluated stage yields `not-evaluated`,
 * which `gatePassed` refuses. There is no expression here that can produce `pass` without
 * a stage having actually run and handed over a proof.
 */
export function deriveGates(
  ledger: StageResult<{ hash: string; unexplainedNormativeBlocks: number }>,
  diff: StageResult<{ hash: string; highRiskDisagreements: number }>,
  constructs: StageResult<{ hash: string; undispositionedConstructs: number; names: string[] }>,
  expansion: StageResult<{ hash: string; unpreviewedRequirements: number }>,
): ContractRevision["extraction"]["gates"] {
  const fromCount = <T>(stage: StageResult<T>, read: (v: T) => number, label: string, detailOf?: (v: T) => string): GateOutcome => {
    if (stage.state === "not-evaluated") return notEvaluated(stage.reason, stage.detail);
    const n = read(stage.value);
    const detail = detailOf ? detailOf(stage.value) : `${label}: ${n}`;
    return n === 0
      ? { state: "pass", proof: stage.proof, detail: `${label}: 0` }
      : { state: "fail", proof: stage.proof, detail };
  };

  return {
    zeroUnexplainedNormativeBlocks: fromCount(
      ledger,
      (v) => v.unexplainedNormativeBlocks,
      "unexplained normative blocks",
    ),
    noUnresolvedHighRiskDisagreement: fromCount(
      diff,
      (v) => v.highRiskDisagreements,
      "high-risk disagreements",
    ),
    // Both of these were the literal `true`. They are now computed from what pass B
    // actually dispositioned and from what the floor expander actually previewed.
    allConstructClassesDispositioned: fromCount(
      constructs,
      (v) => v.undispositionedConstructs,
      "construct classes with no verdict",
      (v) => `construct classes with no verdict: ${v.names.join(", ")}`,
    ),
    allScopedExpansionsPreviewed: fromCount(
      expansion,
      (v) => v.unpreviewedRequirements,
      "requirements with no expansion preview",
    ),
  };
}

// ---------------------------------------------------------------------------
// Gate inputs, projected from ONE consolidation result
//
// The four gates read four different facts, but all four facts come from the same
// deterministic merge over the same two persisted passes. Projecting them here — rather
// than letting each gate compute its own — is what stops two gates from disagreeing about
// which extraction they are approving.
// ---------------------------------------------------------------------------

const proofOf = (c: StageResult<ConsolidationSummary>): GateProof =>
  c.state === "evaluated" ? c.proof : { evaluatorId: "", evaluatorVersion: "", inputHash: "", observedAt: "" };

export function projectLedger(
  c: StageResult<ConsolidationSummary>,
): StageResult<{ hash: string; unexplainedNormativeBlocks: number }> {
  if (c.state !== "evaluated") return stageNotEvaluated(c.reason, c.detail);
  return stageEvaluated(
    { hash: c.value.ledgerHash, unexplainedNormativeBlocks: c.value.unexplainedNormativeBlocks },
    { ...proofOf(c), evaluatorId: "source-ledger", inputHash: c.value.ledgerHash },
  );
}

export function projectDiff(
  c: StageResult<ConsolidationSummary>,
): StageResult<{ hash: string; highRiskDisagreements: number }> {
  if (c.state !== "evaluated") return stageNotEvaluated(c.reason, c.detail);
  // A disagreement the merge RESOLVED (one pass missed a row; the passes read one row with
  // different scope) is reported in the diff and does not block: the row is kept, or kept
  // as `disputed` and withheld from pass/fail. What blocks is a disagreement no merge
  // policy can settle — the same answer routed to two different destinations, where
  // sealing either one would be choosing on a human's behalf.
  return stageEvaluated(
    { hash: c.value.diffHash, highRiskDisagreements: c.value.unresolvableDisagreements },
    { ...proofOf(c), evaluatorId: "extraction-diff", inputHash: c.value.diffHash },
  );
}

export function projectConstructs(
  c: StageResult<ConsolidationSummary>,
): StageResult<{ hash: string; undispositionedConstructs: number; names: string[] }> {
  if (c.state !== "evaluated") return stageNotEvaluated(c.reason, c.detail);
  return stageEvaluated(
    {
      hash: c.value.mergedHash,
      undispositionedConstructs: c.value.undispositionedConstructs.length,
      names: c.value.undispositionedConstructs,
    },
    { ...proofOf(c), evaluatorId: "construct-checklist", inputHash: c.value.mergedHash },
  );
}

export function projectExpansion(
  c: StageResult<ConsolidationSummary>,
): StageResult<{ hash: string; unpreviewedRequirements: number }> {
  if (c.state !== "evaluated") return stageNotEvaluated(c.reason, c.detail);
  return stageEvaluated(
    { hash: c.value.previewHash, unpreviewedRequirements: c.value.unpreviewedRequirements },
    { ...proofOf(c), evaluatorId: "floor-expansion-preview", inputHash: c.value.previewHash },
  );
}

/** The document's own name, for the extraction prompts' first line. */
const documentName = (p: RunParamsV2): string =>
  `${p.documentKey.split("/").pop() ?? "questionnaire.docx"} (sha256 ${p.documentSha256.slice(0, 12)}…)`;

// ---------------------------------------------------------------------------
// The test-axis gate
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before `completion.test` may become `complete`. Each
 * blocker is a sentence, because the report has to be able to say WHY a run that finished
 * is not a run that tested everything.
 */
export function testAxisBlockers(
  cp: RunCheckpoint,
  adjudication: StageResult<unknown>,
  assembled: StageResult<unknown>,
): string[] {
  const blockers: string[] = [];
  if (cp.contract.state !== "sealed" || cp.contract.total === null) {
    blockers.push("no contract revision was sealed, so there is no denominator to be complete against");
  }
  if (cp.counts.pending > 0) {
    blockers.push(`${cp.counts.pending} execution case(s) still have no terminal disposition`);
  }
  // A TERMINAL DISPOSITION IS NOT A VERDICT.
  //
  // Observed on a real dev-drive run: execution stopped, reclassified both pending cases as
  // `blocked`, and set `completion.test = partial-blocked` — and then this gate closed the
  // axis to `complete` anyway, because `pending` was 0. A run in which nothing was verified
  // reported that testing had completed, which is the same overclaim, one gate further
  // down, that commitment 6 exists to stop. `blocked` / `budget-exhausted` / `time-exhausted`
  // / `not-reached` mean a case was NEVER SETTLED; only `exercised` cases can close an axis.
  const unsettled = (["blocked", "budget-exhausted", "time-exhausted", "not-reached"] as const)
    .map((b) => [b, cp.counts[b]] as const)
    .filter(([, n]) => n > 0);
  if (unsettled.length > 0) {
    blockers.push(
      `${unsettled.reduce((n, [, c]) => n + c, 0)} execution case(s) never reached a verdict ` +
        `(${unsettled.map(([b, n]) => `${b}: ${n}`).join(", ")})`,
    );
  }
  if (cp.contract.total !== null && cp.contract.total === 0) {
    blockers.push("the sealed contract has zero execution cases");
  }
  if (adjudication.state !== "evaluated") {
    blockers.push("no verdict was derived: the adjudication stage produced no result");
  }
  if (assembled.state !== "evaluated") {
    blockers.push("no RunRecord was assembled, so there is nothing to be complete about");
  }
  const adjudicating = cp.phases.find((ph) => ph.name === "adjudicating");
  if (adjudicating && adjudicating.state !== "complete") {
    blockers.push(`the adjudicating phase is "${adjudicating.state}", not complete`);
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Cap handling — each limit keeps its own identity all the way to the report
// ---------------------------------------------------------------------------

function assertOwner(runId: string, cp: RunCheckpoint, fence: Fence): void {
  const own = cp.ownership ?? null;
  if (!own || own.epoch !== fence.epoch || own.instanceId !== fence.instanceId) {
    throw new OwnershipLost(runId, fence, own);
  }
}

function capExceeded(usage: {
  cost: { usedUsd: number; maxUsd: number; verificationReserveUsd: number; reportReserveUsd: number };
  modelCalls: { used: number; max: number };
  toolCalls: { used: number; max: number };
  wallClock: { usedMilliseconds: number; maxMilliseconds: number };
}): string | null {
  // Reserves are PROTECTED: execution may not spend into the money set aside for
  // verification and reporting, or a run ends with observations and no report.
  const spendable = usage.cost.maxUsd - usage.cost.verificationReserveUsd - usage.cost.reportReserveUsd;
  if (usage.cost.usedUsd >= spendable) return "cost-cap";
  if (usage.modelCalls.used >= usage.modelCalls.max) return "model-call-cap";
  if (usage.toolCalls.used >= usage.toolCalls.max) return "tool-call-cap";
  if (usage.wallClock.usedMilliseconds >= usage.wallClock.maxMilliseconds) return "wall-clock-cap";
  return null;
}

const stopBucket = (reason: string): "budget-exhausted" | "time-exhausted" | "blocked" =>
  reason === "wall-clock-cap" ? "time-exhausted" : reason.endsWith("-cap") ? "budget-exhausted" : "blocked";

const stopCompletion = (reason: string): TestCompletion =>
  reason === "wall-clock-cap" ? "partial-time" : reason.endsWith("-cap") ? "partial-budget" : "partial-blocked";
