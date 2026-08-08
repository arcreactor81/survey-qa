/**
 * PHASE: verifying — stamp every observation with a tri-state verifier decision.
 *
 * The aggregator downstream reads exactly one field, `observation.verifier.decision`, and
 * only `verified` becomes a pass. This stage is where that field is filled in, and the
 * shape of what it may do is the whole point:
 *
 *   - it may DEMOTE on structural grounds alone — and since D23 that demotion may only ever be
 *     to `insufficient`, because the structural floor is evidence-blind;
 *   - it may leave `insufficient`, which costs the run a pass;
 *   - it may PROMOTE to `verified`, OR claim `contradicted`, ONLY through a closed predicate
 *     that compared a TYPED EXPECTATION sealed in the contract revision against ARTIFACT BYTES
 *     it re-read and re-hashed itself.
 *
 * ==================== HOW A `verified` IS EARNED, AND WHY IT CANNOT BE FAKED ====================
 *
 * THE RULE THIS FILE OBEYS, inherited from the defect that cost this project nine fabricated
 * verdicts: COMPILE IS EVIDENCE-BLIND, PREDICATES ARE DOCUMENT-BLIND, AND VERDICTS COME FROM
 * A CLOSED ENUM. Applied here that is three separated steps, and no step can do another's job:
 *
 *   1. THE EXPECTATION comes from the SEALED revision alone — `FacetInstance.case`, a typed
 *      payload (`routeAnswer` + `expectedDestination`, or `boundaryInput`). This step never
 *      looks at what happened. A case with no typed payload yields NO_TYPED_EXPECTATION and
 *      can never be verified, however good the evidence looks.
 *   2. THE OBSERVED FACT comes from the walk artifact, RE-READ from the content-addressed
 *      store through `getVerifiedEvidence` — which re-hashes the bytes against the catalogue
 *      entry that names them — and never from the observation's own `payload`. The payload
 *      is a POINTER. A verifier that trusted the producer's summary of itself would be
 *      certifying the producer's word, which is exactly the shape being avoided.
 *   3. THE PREDICATE is a pure function of (1) and (2) returning one of five outcomes, and
 *      the outcome→decision mapping below is total, with no default arm that could quietly
 *      promote something unrecognised.
 *
 * So `verified` requires: a sealed typed expectation, a located artifact whose bytes hash to
 * what the catalogue says, a step inside those bytes that actually exercised the case, and a
 * positive match. Remove any one and the result is `insufficient`, not a pass.
 *
 * ==================== WHICH STEP IS *THIS CASE'S* STEP (D19) ====================
 *
 * A walk is a whole survey, not one question. Until D19 both predicates picked their step
 * with `walk.steps.find(...)` over the STIMULUS ALONE — the first step that clicked the
 * documented code/label, or typed the documented value — with no check that the step
 * happened on the question the case is about. Clone paths retain every base decision
 * (`plan.ts`), so on any survey where "Yes" / "1" / "18" is also answered on an EARLIER
 * question, the predicate read the wrong step: the wrong `screenAfterAdvance`, and from it a
 * `contradicted` about a healthy site or a `verified` that concealed a real defect. On a
 * Yes/No screener that is the common case, not an edge case.
 *
 * THE BINDING RULE, and it is fail-closed: a step may decide a case only when THE STEP'S OWN
 * SCREEN IDENTIFIES ITSELF as the case's `targetQuestionId` — the sealed question ids that
 * `screenBefore` presents are EXACTLY `{target}`, one id and that one. Exactly one such step
 * must have performed the documented stimulus. Zero → `insufficient`; more than one →
 * `insufficient`. Nothing else is accepted as a binder. In particular
 * `StepObservation.decisionQuestion` is NOT used: it is the driver's own heuristic match
 * (`browser/driver.ts#matchDecision` scores option-label overlap alone, with no question token
 * at all), so binding on it would let the same mislabelling back in through a narrower door.
 *
 * WHAT "PRESENTS" MEANS, and it is TWO readings of the same re-read bytes, unioned:
 *   (a) the id printed in the screen's rendered text (`tokenOnScreen`), and
 *   (b) the id named by one of the screen's CONTROLS — `name` outright, else the `id` prefix
 *       before its first separator (`controlSealedIdsOnScreen`).
 * (b) exists because reading text alone produced a NULL RUN: the instrument under test renders
 * prose headings and prints no question numbers anywhere, so every route and boundary case
 * exited at binding and the stage returned zero verdicts — while `browser/page-script.ts` had
 * been capturing `name` and `id` on every control the whole time. The union is what stays
 * fail-closed: a screen whose markup says one question and whose text pipes another presents
 * two sealed ids, so it has not identified itself and nothing is concluded from it.
 *
 * THE TWO READINGS ARE NOT EQUALLY STRONG, and one arm has to know it (0.2). PROSE REFERS TO
 * OTHER QUESTIONS — "as you said in Q2, which brands do you buy?" prints `Q2` on a screen that
 * is not Q2 — while a control's `name` is a field THIS screen submits. A screen presenting
 * exactly one FOREIGN sealed id in prose alone is therefore not evidence of where the walk
 * landed, and the route predicate's `violated` arm (the only arm here that accuses a survey of
 * a defect) requires the MARKUP witness before it names a destination. `screenIdentity` carries
 * the provenance so that requirement lives in one seam rather than in predicate branches.
 *
 * THE ASSUMPTIONS THIS STATES (CLAUDE.md: no silent reliance on a convention). BOTH readings
 * are conventions of the surveys we have, not properties of surveys:
 *   - text: A SCREEN PRINTS ITS OWN QUESTION ID and does not print another question's;
 *   - markup: A CONTROL'S `name` IS THE SEALED QUESTION ID. A real platform may emit `QID12_4`,
 *     a GUID, a framework-mangled `ctl00$body$Q7`, or no `name` at all.
 * Reading control attributes therefore makes THE TEST SURVEY MEASURABLE; IT DOES NOT MAKE THE
 * SYSTEM GENERAL. When neither convention holds the case is not decided — it is reported as
 * `STEP_NOT_BOUND_TO_TARGET_QUESTION` / `STEP_BINDING_AMBIGUOUS` / `CASE_TARGET_QUESTION_UNKNOWN`
 * / `DESTINATION_NOT_IDENTIFIABLE`, each a named limitation in the reason histogram and none of
 * them a verdict. A survey that neither prints its ids nor names its controls after them
 * therefore yields no route verdicts at all, and says so. Binding such a survey needs the id
 * matched from the DOCUMENT'S side by screen content, which is the model verifier's job and is
 * not wired.
 *
 * ==================== WHAT "THE SURVEY REJECTED IT" MEANS (0.1) ====================
 *
 * The boundary predicate used to read `step.blocked === true || validationMessages.length > 0`
 * as "the survey refused this input". `blocked` is `!advanced`, and `advanced` is the result of
 * WINNING A POLLING RACE against `advanceTimeoutMs` — so A SLOW BUT HEALTHY SURVEY WAS
 * INDISTINGUISHABLE FROM ONE THAT REFUSED, and the run reported a confident defect about a
 * working site. The repair is four-valued, not three, and it turns on three separate things:
 *
 *   1. THE QUADRANT IS KEYED ON `advanced`, NEVER ON `blocked`. `blocked` is false on the
 *      no-advance-control path — which is where a DISABLED NEXT BUTTON lands, the commonest
 *      silent refusal there is — so a tri-state keyed on it ships `BOUNDARY_NOT_REJECTED`
 *      about a survey that refused exactly as documented.
 *   2. THE WITNESS IS A DELTA AND IS ATTRIBUTED. A message already on the screen before we
 *      typed (the capture's selector matches cookie banners and toasts) is not about our
 *      input; and the driver types the planned value into EVERY empty text control, so a
 *      sibling field's refusal is not this case's.
 *   3. TWO OF THE FOUR STATES ARE `insufficient`, INCLUDING advanced-AND-complaining, which a
 *      naive tri-state scores as accepted and which is what server-side validation looks like.
 *
 * See `readBoundaryOutcome`. The walker's own account of why it stopped travels on the
 * artifact (`StepObservation.blockedReason`) so this stage READS a witness instead of
 * reconstructing one — and that account may name a refusal to decide and never author one.
 *
 * WHAT IS DELIBERATELY *NOT* CLAIMED. Only two case kinds carry an expectation this stage can
 * decide without reading the document: `route` and `boundary`. `rendered-state`, `copy`,
 * `option-set` and `configuration` need the document's own prose compared to a screen, which
 * is the model verifier's job, and it is not wired. They return `insufficient` with
 * NO_TYPED_EXPECTATION and the run reports `pending` for them. A narrower verifier that is
 * right is worth more than a broad one that guesses.
 *
 * ==================== THE DOCUMENT'S OWN WORDING IS THE THIRD WITNESS (1.4.0) ====================
 *
 * THE DISAGREEMENT THIS CLOSES. `browser/driver.ts` and this file both answer ONE question —
 * "which document question is this screen?" — and until 1.4.0 they answered it by different
 * evidence. The driver was rebuilt around the DOCUMENT'S WORDING of the question (an F-measure
 * whose precision is taken against the screen's HEADING and whose recall is taken against the
 * screen's FULL text, binding at >=0.70 with a >=1.25x margin), corroborated by control markup,
 * with option-label overlap forbidden from ever binding. This file read TEXT TOKENS plus MARKUP
 * and did not look at wording at all. Two consequences, and neither is theoretical:
 *
 *   1. THE VERIFIER COULD ACCEPT A SCREEN THE WALKER REFUSED. `tokenOnScreen` reads the id
 *      ANYWHERE in the rendered prose, so a screen that merely back-references the target
 *      ("as you said in Q7…") and names nothing else sealed presents exactly `{Q7}` here. If the
 *      walker had REFUSED to bind Q7 to that screen and answered it by `navigator-default`, and
 *      that default happened to perform the documented stimulus, this file would have decided
 *      the case off a screen the walker itself declined to identify — a verdict from the one
 *      screen both halves had reason to distrust.
 *   2. THE VERIFIER WAS BLIND WHERE THE WALKER COULD SEE. On an instrument that prints no ids
 *      and names no controls after them — the general case — the driver binds by wording and
 *      this file bound nothing, so every case came back "exercised, and unverifiable". A null
 *      run with a confident walk in front of it.
 *
 * SO WORDING JOINS `ScreenIdentity` AS A THIRD WITNESS, ON THE UNION, AND THE UNION IS WHY THAT
 * IS SAFE. Adding a witness source can only move the id set 0 -> 1 (a screen that identifies
 * itself where none did) or 1 -> 2 (a screen whose witnesses disagree, which every caller here
 * refuses on). IT CAN NEVER MOVE 2 -> 1: no witness removes an id another witness saw. Every
 * "exactly one sealed id" rule in this file therefore keeps its exact meaning, and the new
 * signal can buy yield or buy refusals but never a relaxation.
 *
 * A WORDING TIE IS PUT INTO THE UNION, NOT DROPPED. When the top-scoring wording does not clear
 * the runner-up by the margin, BOTH ids enter — which makes the screen non-singleton and refuses
 * it. That is the driver's `identity-ambiguous` refusal expressed in this file's vocabulary, and
 * the consistency is the point: everywhere the tie costs a verdict here, the driver also refused
 * to walk the screen, so the case was not exercised on it either.
 *
 * WHAT WORDING IS NOT ALLOWED TO DO, AND THIS IS THE LINE THAT DID NOT MOVE: it may not carry
 * the route predicate's `violated` arm. Wording is DOCUMENT PROSE matched against SCREEN PROSE —
 * a text-class witness, and prose quotes other questions. The accusation still requires the
 * MARKUP witness (`DESTINATION_IDENTIFIED_BY_TEXT_ONLY`), exactly as in 1.3.0.
 *
 * WHERE THE WORDING COMES FROM: the SEALED REVISION, never the walk. `plan.ts`'s
 * `buildQuestionWordingIndex` reads `facet: "question"` requirements' `displayQuote` out of the
 * same contract revision this stage already loads, and `resolveQuestionWording` applies the same
 * sibling-scope rule the plan applied when it stamped the decisions. Sharing those two functions
 * is what stops the walker and the verifier drifting apart again; re-deriving the wording here
 * would recreate the divergence this section exists to remove. The step of the chain that must
 * stay untouched is untouched: the EXPECTATION still comes from the seal alone and the FACT
 * still comes from re-read, re-hashed artifact bytes.
 *
 * ==================== THE WALKER'S REFUSALS ARE READ, ITS BINDINGS ARE NOT (1.4.0) ====================
 *
 * The driver now records `bindingVia` and `bindingRefusals` per step and `unboundDecisions` per
 * walk. The polarity rule that governs `blockedReason` governs these too, and it decides which
 * of them this file may read:
 *
 *   `bindingVia` IS THE PRODUCER'S SUMMARY OF ITS OWN BINDING and is NOT read. Treating it as a
 *   binder is the same mistake as binding on `decisionQuestion`, through a better-argued door.
 *   `bindingRefusals` / `unboundDecisions` ARE READ, AS A VETO. A refusal can only ever SUBTRACT
 *   — it withholds a pass and accuses nobody — so trusting the walker's own account of what it
 *   declined to identify cannot manufacture a verdict. When the walker says "I would not call
 *   this screen Q7" and this file's recomputation says "it is Q7", the two disagree, and a
 *   disagreement about identity is exactly what neither half may resolve alone.
 *
 * That veto is also the runtime drift detector between the two halves: it can only fire when
 * their computations diverge, and it names the divergence in the reason histogram instead of
 * letting one of them win silently. All three fields are OPTIONAL — an artifact written before
 * they existed carries none, and their ABSENCE vetoes nothing and changes no verdict.
 *
 * WORKERSAI_ENABLED IS FALSE BY DEFAULT (the free neuron allowance is spent), and the
 * degradation is the design, not a stopgap: a verifier that is unavailable yields
 * `insufficient` for everything it cannot decide, the run reports `incomplete` for those, and
 * nobody gets a green page out of a validator that never ran. A verifier that BLOCKED the run
 * instead would be worse — it would trade a truthful partial report for no report at all.
 */

import type { Env } from "../../types/env";
import { observationsKey } from "../../keys";
import { getBoundCatalogEntry, getVerifiedEvidence } from "../../store/evidence";
import { loadRunInputs } from "./run-inputs";
import type { StageResult } from "../gates";
import type {
  EvidenceCatalogEntry,
  FacetCase,
  FacetInstance,
  Observation,
  VerifierDecision,
} from "../../types/record";
import type { PathObservation, RenderedScreen, StepObservation } from "../../browser/types";
import type { WalkProjectionPayload } from "./project-observations";
// THE WORDING IS SHARED CODE, NOT A SECOND IMPLEMENTATION. `questionWordingScore` is the
// driver's own scorer and `buildQuestionWordingIndex`/`resolveQuestionWording` are the plan's own
// resolver, imported rather than reproduced: a copy here would be free to drift from the binder
// it is supposed to agree with, which is the defect 1.4.0 exists to close. Neither import
// carries a walk fact — the index is built from the SEALED revision this stage already loads.
import { questionWordingScore } from "../../browser/driver";
import { buildQuestionWordingIndex, resolveQuestionWording } from "./plan";
import type { QuestionWordingIndex } from "./plan";

/**
 * 1.4.0 — the document's own wording of a question became a third screen-identity witness
 * (shared with `browser/driver.ts`, on the union, so it may bind or refuse and never relax), and
 * the walker's recorded binding REFUSALS became a veto. Both change which observations reach a
 * verdict, so a record written by 1.3.0 and one written by this must not be compared as though
 * the same predicate produced them.
 *
 * 1.3.0 — the boundary outcome became four-valued and screen identity gained provenance.
 */
export const VERIFIER_VERSION = "v2-structural-verifier/1.4.0";

/** What a predicate may return. Never prose, never a score. */
export type PredicateOutcome = "satisfied" | "violated" | "insufficient" | "no-observation" | "error";

/**
 * THE CLOSED REASON REGISTRY. Every decision this stage writes names one of these, so a
 * reader can ask WHY without parsing a sentence. Adding a reason is a deliberate act;
 * emitting one that is not here is not possible.
 */
export const VERIFIER_REASON = Object.freeze({
  // verified
  ROUTE_DESTINATION_REACHED: "ROUTE_DESTINATION_REACHED",
  BOUNDARY_ACCEPTED_AS_DOCUMENTED: "BOUNDARY_ACCEPTED_AS_DOCUMENTED",
  BOUNDARY_REJECTED_AS_DOCUMENTED: "BOUNDARY_REJECTED_AS_DOCUMENTED",
  // contradicted
  ROUTE_DESTINATION_MISMATCH: "ROUTE_DESTINATION_MISMATCH",
  BOUNDARY_NOT_REJECTED: "BOUNDARY_NOT_REJECTED",
  BOUNDARY_REJECTED_UNEXPECTEDLY: "BOUNDARY_REJECTED_UNEXPECTEDLY",
  /**
   * RETIRED BY D23 AND DELIBERATELY NOT DELETED. Nothing emits this: it named the arm that
   * turned a producer's own `contradiction`/`error` payload key into a defect claim, and that
   * arm now demotes to PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED instead. It stays in the registry so
   * a record written before that change still names a reason this enum knows, and so the
   * mutation that reinstates the old arm reinstates it exactly. Nothing new may use it.
   */
  STRUCTURAL_CONTRADICTION: "STRUCTURAL_CONTRADICTION",
  // insufficient
  NO_TYPED_EXPECTATION: "NO_TYPED_EXPECTATION",
  NO_SEALED_CASE: "NO_SEALED_CASE",
  NO_EVIDENCE_CITED: "NO_EVIDENCE_CITED",
  ARTIFACT_NOT_LOCATED: "ARTIFACT_NOT_LOCATED",
  ARTIFACT_UNREADABLE: "ARTIFACT_UNREADABLE",
  ROUTE_ANSWER_NOT_SELECTED: "ROUTE_ANSWER_NOT_SELECTED",
  ROUTE_NOT_ADVANCED: "ROUTE_NOT_ADVANCED",
  TERMINAL_DESTINATION_NOT_DISCRIMINABLE: "TERMINAL_DESTINATION_NOT_DISCRIMINABLE",
  DESTINATION_NOT_IDENTIFIABLE: "DESTINATION_NOT_IDENTIFIABLE",
  // D19 — the case's own step could not be identified in the walk. Each of these is a NAMED
  // limitation of screen-witnessed binding, and each costs the run a pass rather than
  // deciding the case off a step that merely looked right.
  CASE_TARGET_QUESTION_UNKNOWN: "CASE_TARGET_QUESTION_UNKNOWN",
  STEP_NOT_BOUND_TO_TARGET_QUESTION: "STEP_NOT_BOUND_TO_TARGET_QUESTION",
  STEP_BINDING_AMBIGUOUS: "STEP_BINDING_AMBIGUOUS",
  DESTINATION_AMBIGUOUS: "DESTINATION_AMBIGUOUS",
  /**
   * 0.2 — the reached screen carries the foreign id ONLY in its rendered prose. Prose
   * back-references another question ("as you said in Q2") and markup does not, so a
   * text-only foreign id cannot carry a destination MISMATCH. See `routeDestination`.
   */
  DESTINATION_IDENTIFIED_BY_TEXT_ONLY: "DESTINATION_IDENTIFIED_BY_TEXT_ONLY",
  BOUNDARY_INPUT_NOT_ENTERED: "BOUNDARY_INPUT_NOT_ENTERED",
  /**
   * 1.4.0 — THE WALKER REFUSED TO CALL THIS SCREEN THIS QUESTION, and this file's own
   * recomputation would have. `StepObservation.bindingRefusals` is the driver's record of a
   * decision it declined to bind to the screen in front of it; when it names the case's target,
   * the two halves of the system disagree about the screen's identity, and neither half may
   * settle that alone. The veto only ever SUBTRACTS, which is why reading the producer's word
   * here is admissible at all.
   */
  WALKER_REFUSED_THIS_SCREEN: "WALKER_REFUSED_THIS_SCREEN",
  /**
   * 1.4.0 — the walk's own `unboundDecisions` says it never bound a decision to this case's
   * question at all. A step this file binds to that question anyway would be a screen the
   * walker declined to identify, answered by the navigator's default rather than by the
   * document's answer. Absent on artifacts written before the field existed, and its absence
   * vetoes nothing.
   */
  TARGET_QUESTION_NEVER_BOUND_IN_WALK: "TARGET_QUESTION_NEVER_BOUND_IN_WALK",
  /**
   * SUPERSEDED BY 0.1 AND DELIBERATELY NOT DELETED. It named the single "we could not tell"
   * arm of the two-valued boundary read; the four-state read splits that into three reasons
   * that call for three different repairs. It stays so a record written before the change
   * still names a reason this enum knows. Nothing new emits it.
   */
  BOUNDARY_OUTCOME_UNDECIDED: "BOUNDARY_OUTCOME_UNDECIDED",
  // 0.1 — THE THREE NON-VERDICT QUADRANTS OF THE BOUNDARY OUTCOME. Each names a DIFFERENT
  // thing the walk failed to establish, because "we could not tell" collapses three very
  // different repairs into one bucket. See `readBoundaryOutcome`.
  /** No advance and no message appeared: a silent refusal and a slow page are the same bytes. */
  BOUNDARY_REJECTION_NOT_WITNESSED: "BOUNDARY_REJECTION_NOT_WITNESSED",
  /** It advanced AND a message appeared — server-side validation on an interstitial, or noise. */
  BOUNDARY_OUTCOME_CONFLICTING: "BOUNDARY_OUTCOME_CONFLICTING",
  /** A rejection was witnessed, but the screen offers more than one thing it could be about. */
  BOUNDARY_REJECTION_NOT_ATTRIBUTABLE: "BOUNDARY_REJECTION_NOT_ATTRIBUTABLE",
  PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE: "PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE",
  // D23 — the observation's own payload flagged a contradiction or an error. That is the
  // PRODUCER'S word about itself, so it is a reason to withhold a pass and never a reason to
  // claim a defect. See `structuralDecision`.
  PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED: "PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED",
} as const);

export type VerifierReason = (typeof VERIFIER_REASON)[keyof typeof VERIFIER_REASON];

export interface PredicateResult {
  outcome: PredicateOutcome;
  reason: VerifierReason;
  predicate: string;
  detail: string | null;
  /**
   * True when `satisfied` was concluded from something NOT being there. Such a conclusion
   * needs a complete scoped inventory behind it; a partial walk cannot support it.
   */
  fromAbsence?: boolean;
}

export interface VerificationSummary {
  observations: number;
  verified: number;
  contradicted: number;
  insufficient: number;
  modelVerifierAvailable: boolean;
  /** Reason-code histogram, so the run can say WHY it did not verify more than it did. */
  byReason: Record<string, number>;
}

/**
 * OUTCOME → DECISION. Total over the five outcomes, with no default arm. `no-observation`
 * and `error` are NOT failures: nothing observed and evidence that would not re-read are
 * both "we do not know", and calling either a `contradicted` would invent a defect.
 */
const OUTCOME_TO_DECISION: Record<PredicateOutcome, VerifierDecision> = {
  satisfied: "verified",
  violated: "contradicted",
  insufficient: "insufficient",
  "no-observation": "insufficient",
  error: "insufficient",
};

export async function verifyObservations(env: Env, runId: string): Promise<StageResult<VerificationSummary>> {
  // THE CATALOGUE IS NOT LISTED HERE, AND THAT IS A SUBREQUEST BUDGET DECISION.
  //
  // `listCatalog` is a fan-out: one R2 LIST plus one R2 GET **per catalogue entry**. Run
  // v2r_01kzfb6py8pbxznqv022p2qkhb catalogued 1,707 artifacts (every screen read and every
  // screenshot of 46 walks), so `loadRunInputs({ catalog: true })` cost ~1,709 subrequests
  // here — and `project-observations`, the step immediately before, had just paid the same
  // 1,709. A Worker invocation has a finite subrequest budget that Workflow steps SHARE, so
  // that second fan-out is what exhausted it: the step spent 1m19s walking the catalogue and
  // died with `Too many API requests by single Worker invocation`, and its two retries then
  // died in 0 seconds against the same spent invocation.
  //
  // Nothing in this file ever needed the whole catalogue. It needs the ONE entry that names
  // each cited walk artifact, and `getBoundCatalogEntry` fetches exactly that by key — so the
  // cost is O(distinct artifacts cited), which is the number of CONTRIBUTING WALKS (8 in that
  // run), not O(everything the run ever captured).
  //
  // THE INTEGRITY CHAIN IS UNCHANGED, which is the only reason this is allowed to be cheaper:
  // `getBoundCatalogEntry` runs the same `assertCatalogBinding` that `listCatalog` runs (the
  // evidenceId is recomputed from runId + sourceEvidenceId + contentHash + artifactRef and
  // must match, so a repointed entry is refused), and `getVerifiedEvidence` still re-reads the
  // blob and re-hashes it against that entry's `contentHash`. A key that does not exist, does
  // not bind, or does not re-hash yields `insufficient`/`error` exactly as before. This buys
  // subrequests by not READING bytes nobody was going to look at — it does not skip a check.
  const inputs = await loadRunInputs(env, runId, { catalog: false });
  const modelVerifierAvailable = env.WORKERSAI_ENABLED === "true" && !!env.AI;

  const casesById = new Map<string, FacetInstance>();
  for (const fi of inputs.revision?.facetInstances ?? []) casesById.set(fi.facetInstanceId, fi);

  // Every question id the SEAL knows about. The route predicate needs it to tell "the walk
  // landed on a different documented screen" (a real mismatch) from "the screen does not
  // print question numbers" (unknowable) — see `routeDestination`.
  const sealedQuestionIds = [
    ...new Set(
      (inputs.revision?.facetInstances ?? [])
        .map((f) => f.targetQuestionId)
        .filter((q): q is string => typeof q === "string" && q.length > 0),
    ),
  ];

  // THE DOCUMENT'S WORDING OF EVERY QUESTION IT WORDS, BUILT FROM THE SEAL AND NOTHING ELSE.
  //
  // This is the same index `plan.ts` stamped onto the planned decisions and the same one
  // `browser/driver.ts` scored screens against, built by the SAME function over the SAME sealed
  // revision — so "which question is this screen?" is answered from one body of evidence on
  // both sides of the run. It costs no subrequest: `inputs.revision` is already in hand.
  //
  // A revision that words no question yields an EMPTY index, every wording claim is then absent,
  // and screen identity falls back to exactly the two readings 1.3.0 used. Absent evidence must
  // change nothing, which is what makes this additive rather than a re-interpretation.
  const questionWording = inputs.revision ? buildQuestionWordingIndex(inputs.revision) : null;

  // One re-read per ARTIFACT, not per case: a walk that closes forty cases is one blob, and
  // `getVerifiedEvidence` re-hashes it on the way in. The cache holds bytes that already
  // passed that check; it never holds a producer's summary of them.
  //
  // The cache is also what bounds the subrequest cost: a NEGATIVE result is cached too (the
  // `has` test, not a truthiness test), so 212 observations citing 8 artifacts cost 8 lookups
  // whether those lookups succeed or fail — a missing artifact cited by forty cases is looked
  // for once, not forty times.
  const artifacts = new Map<string, PathObservation | null>();
  const readArtifact = async (evidenceId: string): Promise<PathObservation | null> => {
    if (artifacts.has(evidenceId)) return artifacts.get(evidenceId) ?? null;
    const parsed = await readWalkArtifact(env, runId, evidenceId);
    artifacts.set(evidenceId, parsed);
    return parsed;
  };

  const verified: Observation[] = [];
  for (const o of inputs.observations) {
    const result = await decideObservation(
      o,
      casesById.get(o.facetInstanceId) ?? null,
      sealedQuestionIds,
      readArtifact,
      questionWording,
    );
    verified.push({
      ...o,
      verifier: {
        decision: OUTCOME_TO_DECISION[result.outcome],
        evidenceIds: o.evidenceIds ?? [],
        verifierVersion: modelVerifierAvailable
          ? `${VERIFIER_VERSION}+model-unwired`
          : `${VERIFIER_VERSION}+no-model`,
        predicate: result.predicate,
        reason: result.reason,
        detail: result.detail,
      },
    });
  }

  // Written back so the aggregator and the record read the SAME decisions. Recomputing them
  // in each consumer is how two stages come to disagree about one observation.
  if (verified.length > 0) {
    await env.EVIDENCE.put(observationsKey(runId), JSON.stringify({ observations: verified }), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  const count = (d: string) => verified.filter((o) => o.verifier.decision === d).length;
  const byReason: Record<string, number> = {};
  for (const o of verified) {
    const r = (o.verifier as { reason?: string }).reason ?? "UNKNOWN";
    byReason[r] = (byReason[r] ?? 0) + 1;
  }
  return {
    state: "evaluated",
    value: {
      observations: verified.length,
      verified: count("verified"),
      contradicted: count("contradicted"),
      insufficient: count("insufficient"),
      modelVerifierAvailable,
      byReason,
    },
    proof: {
      evaluatorId: VERIFIER_VERSION,
      evaluatorVersion: VERIFIER_VERSION,
      inputHash: `observations:${verified.length}`,
      observedAt: new Date().toISOString(),
    },
  };
}

/**
 * THE DECISION FOR ONE OBSERVATION: structural floor first, then the predicate.
 *
 * The floor can only ever DEMOTE, and it runs first precisely so that no predicate result
 * can climb over a structural disqualification.
 */
export async function decideObservation(
  o: Observation,
  sealedCase: FacetInstance | null,
  sealedQuestionIds: string[],
  readArtifact: (evidenceId: string) => Promise<PathObservation | null>,
  /**
   * The document's wording of each question, from the sealed revision. OPTIONAL so a caller
   * written before 1.4.0 still compiles and still behaves exactly as it did: no index means no
   * wording witness, and screen identity is the two readings of 1.3.0.
   */
  questionWording: QuestionWordingIndex | null = null,
): Promise<PredicateResult> {
  const floor = structuralDecision(o);
  if (floor) return floor;

  if (!sealedCase) {
    return insufficient(
      "expectation",
      VERIFIER_REASON.NO_SEALED_CASE,
      `no sealed execution case ${o.facetInstanceId} in the contract revision, so there is no expectation to check against`,
    );
  }

  // (1) THE EXPECTATION — from the seal alone. Evidence-blind by construction: nothing about
  // the walk is in scope here, and a case with no typed payload stops the whole decision.
  const expectation = sealedCase.case ?? null;
  const predicate = expectation ? PREDICATE_FOR_KIND[expectation.kind] ?? null : null;
  if (!expectation || !predicate) {
    return insufficient(
      "expectation",
      VERIFIER_REASON.NO_TYPED_EXPECTATION,
      expectation
        ? `execution case kind "${expectation.kind}" carries no expectation this verifier can decide without reading the document`
        : "the sealed execution case carries no typed case payload",
    );
  }

  // (2) THE OBSERVED FACT — re-read, re-hashed, and never taken from the payload. The
  // payload supplies the POINTER and nothing else.
  const payload = o.payload as WalkProjectionPayload | null;
  const artifactId = payload?.observationEvidenceId ?? null;
  if (!artifactId) {
    return insufficient(
      predicate.id,
      VERIFIER_REASON.ARTIFACT_NOT_LOCATED,
      "the observation cites no walk artifact, so there are no bytes to re-read and nothing to compare",
    );
  }
  const walk = await readArtifact(artifactId);
  if (!walk) {
    return {
      outcome: "error",
      reason: VERIFIER_REASON.ARTIFACT_UNREADABLE,
      predicate: predicate.id,
      detail: `the walk artifact ${artifactId} did not re-read as a PathObservation; evidence that cannot be re-read can never support a pass`,
    };
  }

  // (3) THE PREDICATE — pure over (expectation, re-read bytes). `targetQuestionId` travels
  // with the expectation because it comes from the SAME sealed row: it says which question
  // this case is about, and no step outside that question may decide it.
  const result = predicate.run(expectation, walk, {
    sealedQuestionIds,
    targetQuestionId: sealedCase.targetQuestionId ?? null,
    questionWording,
  });

  // An absence-derived `satisfied` needs a complete scoped inventory behind it. A partial
  // walk saw part of the survey, and "it was not there" over part of a survey is not a fact.
  //
  // NOTE FOR THE NEXT PERSON: NO PREDICATE IN THIS FILE CURRENTLY SETS `fromAbsence`. Both
  // route and boundary conclude from positive witnesses, so this branch is unreachable today
  // and is untested. It is here because the absence-shaped predicates (`option-set`,
  // `copy`) are the ones the model verifier will bring, and the completeness rule has to be
  // enforced at the promotion point rather than remembered by whoever writes them. Do not
  // read it as protection that is currently doing work.
  if (result.outcome === "satisfied" && result.fromAbsence && o.completeness !== "complete-scoped-inventory") {
    return insufficient(
      predicate.id,
      VERIFIER_REASON.PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE,
      `the predicate concluded from absence over a "${o.completeness}" scope; only a complete scoped inventory can support that`,
    );
  }
  return result;
}

const insufficient = (predicate: string, reason: VerifierReason, detail: string): PredicateResult => ({
  outcome: "insufficient",
  reason,
  predicate,
  detail,
});

/**
 * The model-free structural floor. SINCE D23 IT CAN ONLY EVER SAY `insufficient`, and returns
 * null when it has no opinion so the predicate may run.
 *
 * Nothing in this function looks at the DOCUMENT, and nothing in it re-reads a byte of
 * EVIDENCE, so nothing in it is entitled to say an observation matched one or failed one. That
 * was true before there was any predicate at all and it is still true; what changed is that a
 * separate step, which DOES compare a sealed expectation to re-read bytes, is now allowed to
 * author a verdict. Demoting on structural grounds stays legitimate here — withholding a pass
 * costs the run a pass and accuses nobody — but a VERDICT is not the floor's to give.
 */
export function structuralDecision(o: Observation): PredicateResult | null {
  const payload = o.payload as { contradiction?: unknown; error?: unknown } | null;
  if (payload && (payload.contradiction || payload.error)) {
    // D23 — DEMOTION, NOT A VERDICT, AND THIS IS THE WHOLE POINT OF THE BRANCH.
    //
    // Until 0.3 this arm returned `violated`, which `OUTCOME_TO_DECISION` maps to
    // `contradicted` and the aggregator maps to `fail` — a full, confident defect claim about
    // a client's survey, derived from NOTHING BUT TWO KEYS THE PRODUCER WROTE ONTO ITS OWN
    // PAYLOAD. The payload is a POINTER (see the header): no artifact was located, no bytes
    // were re-hashed, no sealed expectation was consulted. And because the floor runs BEFORE
    // the predicate, nothing downstream could catch it.
    //
    // It was dormant only because no producer sets either key today. Model-observations
    // (Phase 3.3) carry an `error` on every failed model call, so wiring them would have turned
    // each transport failure into a defect claim — silently defeating the never-`violated`
    // invariant that is the model verifier's entire owner-approved safety rationale.
    //
    // IF A PRODUCER-FLAGGED-ERROR CHANNEL IS EVER WANTED, IT MUST ROUTE THROUGH AN
    // EVIDENCE-READ PREDICATE — a typed expectation from the SEAL compared against ARTIFACT
    // BYTES this stage re-read and re-hashed itself, exactly as `route` and `boundary` do, and
    // registered in `PREDICATE_FOR_KIND`. Restoring `violated` here re-opens the hole; the
    // producer's summary of itself is not evidence, however honest the producer is.
    return {
      outcome: "insufficient",
      reason: VERIFIER_REASON.PRODUCER_FLAGGED_PAYLOAD_UNVERIFIED,
      predicate: "structural",
      detail:
        "the observation's own payload carries a producer-authored contradiction/error key; that is the " +
        "producer's word about itself, not evidence, so it withholds a pass and claims no defect",
    };
  }
  if (!Array.isArray(o.evidenceIds) || o.evidenceIds.length === 0) {
    return insufficient(
      "structural",
      VERIFIER_REASON.NO_EVIDENCE_CITED,
      "an observation citing no evidence cannot support a positive claim",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-reading the walk
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the walk artifact.
 *
 * TWO CHECKS, BOTH STILL HERE. `getBoundCatalogEntry` reads the ONE catalogue entry by its
 * key and re-derives its `evidenceId` from (runId, sourceEvidenceId, contentHash,
 * artifactRef) — an entry repointed at other bytes fails to bind and throws. Then
 * `getVerifiedEvidence` re-reads the blob and re-hashes it against that entry's
 * `contentHash`, so a substituted or corrupted blob cannot reach a predicate.
 *
 * This used to take the whole catalogue and `find` in it. It takes the runId and does a
 * keyed GET instead — same two checks on the same entry, without paying one R2 GET for every
 * OTHER artifact in the run to reach it. See the note at the top of `verifyObservations`.
 */
async function readWalkArtifact(
  env: Env,
  runId: string,
  evidenceId: string,
): Promise<PathObservation | null> {
  let entry: EvidenceCatalogEntry | null;
  try {
    // Bad id shape, absent key, or a failed binding all mean "we cannot locate this
    // evidence" — which is `insufficient` for the caller, never a pass.
    entry = await getBoundCatalogEntry(env, runId, evidenceId);
  } catch {
    return null;
  }
  if (!entry) return null;
  try {
    const { bytes } = await getVerifiedEvidence(env, entry);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PathObservation;
    return parsed && parsed.kind === "v2-path-observation/1.0.0" && Array.isArray(parsed.steps) ? parsed : null;
  } catch {
    // An integrity failure or unparseable blob is "we cannot know", not "the survey failed".
    return null;
  }
}

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

/**
 * What a predicate is told about the SEALED ROW it is deciding, beyond the expectation
 * itself. Both fields are sealed facts, not walk facts: the predicate stays document-blind.
 */
interface PredicateContext {
  /** Every question id the sealed revision knows — the vocabulary screens are read against. */
  sealedQuestionIds: string[];
  /** The question THIS case is about. A step on another question cannot decide it. */
  targetQuestionId: string | null;
  /**
   * The document's own wording of each question it words, read out of the SAME sealed revision
   * (1.4.0). Null when the revision words nothing, which restores 1.3.0's identity exactly.
   */
  questionWording: QuestionWordingIndex | null;
}

interface Predicate {
  id: string;
  run(expectation: FacetCase, walk: PathObservation, ctx: PredicateContext): PredicateResult;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Does this screen present `token` as a whole word? The driver's own matching rule.
 *
 * THE CONVENTION THIS RELIES ON, stated because it is a reliance: that a screen printing a
 * question id IS that question. A screen that PIPES or back-references another question
 * ("as you said in Q2…") prints a token it is not. Callers must therefore treat "presents"
 * as "presents, possibly as a reference", and the two places that matter here —
 * `stepsOnTargetQuestion` and the destination check — both refuse to conclude when a screen
 * presents MORE THAN ONE sealed id, since at most one of them can be its identity.
 *
 * WHAT THAT STILL DOES NOT CATCH, and it is reported rather than papered over: a screen that
 * pipes the id of interest while never printing its own is indistinguishable from that
 * screen. Detecting it needs the document's own text for the piped question, which is the
 * model verifier's job and is not wired.
 */
function tokenOnScreen(screen: RenderedScreen | null, token: string): boolean {
  if (!screen || !token) return false;
  const haystack = norm(`${screen.questionText ?? ""} ${screen.title ?? ""} ${screen.visibleText ?? ""}`);
  const t = norm(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(haystack);
}

/**
 * WHICH SEALED QUESTION IDS DOES THIS SCREEN'S *MARKUP* NAME?
 *
 * The reason this exists: `tokenOnScreen` reads rendered text only, and a survey is free to
 * print prose headings and no question numbers at all — which the t1-easy instrument does.
 * Every route and boundary case then exits at binding and the run yields ZERO verdicts, while
 * the ids the binder needed were sitting unread in the artifact the whole time:
 * `browser/page-script.ts` records `name` and `id` for every control, and this survey emits
 * `name="<questionId>"` with `id="<questionId>_<optionCode>"`.
 *
 * ================= THE CONVENTION THIS RELIES ON, AND IT IS A RELIANCE =================
 *
 * "A control's `name` is the sealed question id" IS A CONVENTION OF THE SURVEYS WE HAVE, NOT A
 * PROPERTY OF SURVEYS. A real platform may emit `QID12_4`, a GUID, a framework-mangled
 * `ctl00$body$Q7`, or no `name` at all; Decipher, Qualtrics and SurveyJS each name controls
 * their own way and none of them promises the document's own id. THIS MAKES THE TEST SURVEY
 * MEASURABLE; IT DOES NOT MAKE THE SYSTEM GENERAL (CLAUDE.md, the north star).
 *
 * Which is why the failure mode is the SAFE one and is named rather than silent: when the
 * convention does not hold, no control resolves, this function returns `[]`, screen identity
 * falls back to the rendered text, and a survey that prints no ids there either is REFUSED —
 * `STEP_NOT_BOUND_TO_TARGET_QUESTION` / `DESTINATION_NOT_IDENTIFIABLE`, both already counted in
 * the run's reason histogram. A named limitation, never a wrong answer. Making this general
 * needs the id read from the DOCUMENT'S side and matched to a screen by its content, which is
 * the model verifier's job and is not wired.
 *
 * THE TWO READINGS, applied PER CONTROL and in this order:
 *   1. `name` equal to a sealed id outright.
 *   2. otherwise the `id` prefix before its first separator — the fallback the GRID needs,
 *      where the per-row name is `Q5_r1` and only `id="Q5_r1_1"` still carries `Q5`.
 *
 * The precedence is per CONTROL and deliberately not per SCREEN. Per screen ("if any exact
 * name matched, never consult ids") a second question whose control carried a mangled name
 * would go unseen, and the whole point of collecting the set is to notice it. Per control, a
 * sealed id that itself contains a separator (`Q5_1`) is still matched by its own `name`
 * before its prefix (`Q5`) is ever considered.
 *
 * Invisible controls are included on purpose: a hidden leftover from another question can only
 * ADD an id, and adding an id can only push the caller toward refusing. It can never bind.
 */
function controlSealedIdsOnScreen(screen: RenderedScreen | null, sealedQuestionIds: string[]): string[] {
  if (!screen || !Array.isArray(screen.controls) || screen.controls.length === 0) return [];
  const sealed = new Set(sealedQuestionIds.filter((q) => typeof q === "string" && q.length > 0));
  if (sealed.size === 0) return [];
  const found = new Set<string>();
  for (const c of screen.controls) {
    if (typeof c?.name === "string" && sealed.has(c.name)) {
      found.add(c.name);
      continue;
    }
    const prefix = typeof c?.id === "string" ? c.id.split(/[_\-.:$[\]]/)[0] : "";
    if (prefix && sealed.has(prefix)) found.add(prefix);
  }
  return [...found];
}

/**
 * THE WORDING THRESHOLDS. They MIRROR `browser/driver.ts`'s calibrated constants, which are not
 * exported, and the mirroring is a liability this file states rather than hides: two numbers in
 * two modules can drift, and a drift here re-opens exactly the disagreement 1.4.0 closes. What
 * stops that is not discipline but a test — `d35`'s cross-module agreement case drives the REAL
 * `bindDecision` and this file's REAL identity seam over the same screens and asserts they reach
 * the same conclusion, so moving either number reddens the suite.
 *
 * The calibration itself is the driver's (measured against the live instrument: a screen's own
 * question scored 0.969–1.000, the worst confusable pair 0.642), and its assumption travels with
 * it: a site that paraphrases heavily or renders in another language scores near zero, binds
 * nothing by wording, and degrades to markup identity and then to a counted refusal.
 */
const WORDING_BIND_MIN = 0.7;
const WORDING_MARGIN_RATIO = 1.25;

/**
 * WHICH QUESTION DOES THE DOCUMENT'S OWN WORDING SAY THIS SCREEN IS?
 *
 * The third witness (1.4.0), and the only one that does not depend on the survey printing or
 * naming an id anywhere. Each candidate question's wording is resolved out of the SEALED
 * revision — by `plan.ts`'s resolver, including its sibling-scope rule, so a question whose
 * wording extraction filed under `question:S2_coffee` is found for `S2` here exactly as it was
 * found when the plan stamped the decision — and scored against the screen by the DRIVER'S OWN
 * scorer. Same evidence, same arithmetic, same thresholds as the half that chose the action.
 *
 * IT RETURNS A CLAIM SET, NOT A WINNER, AND A TIE RETURNS TWO. The driver refuses a screen its
 * top two wordings describe about equally (`identity-ambiguous`); this file expresses the same
 * refusal by putting BOTH ids into the identity union, where every caller's "exactly one sealed
 * id" rule then declines to bind. Dropping the tie instead would let a corroborating markup id
 * bind a screen the driver would not have walked — the two halves disagreeing again, in the
 * direction where this file is the more permissive one.
 *
 * A KNOWN FALSE AMBIGUITY, NAMED RATHER THAN PAPERED OVER: when two sealed ids resolve to the
 * SAME wording — a question extraction fragmented across sibling scopes, both of which are some
 * case's target — they score identically, tie, and refuse forever. That is the fail-closed
 * direction (this file cannot tell which fragment the screen is), it costs yield on a fragmented
 * extraction, and closing it needs the fragments reconciled at extraction time, not a tie-break
 * invented here.
 */
function wordingClaims(
  screen: RenderedScreen | null,
  vocabulary: string[],
  index: QuestionWordingIndex | null,
): string[] {
  if (!screen || !index || index.size === 0) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const id of new Set(vocabulary)) {
    if (typeof id !== "string" || id.length === 0) continue;
    const resolved = resolveQuestionWording(index, id);
    if (!resolved.wording) continue;
    const score = questionWordingScore(resolved.wording.text, screen);
    if (score > 0) scored.push({ id, score });
  }
  if (scored.length === 0) return [];
  // Ties broken lexicographically so the claim set is identical on a re-verify of the same bytes.
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const top = scored[0]!;
  if (top.score < WORDING_BIND_MIN) return [];
  const runnerUp = scored[1];
  const separated = !runnerUp || runnerUp.score <= 0 || top.score >= runnerUp.score * WORDING_MARGIN_RATIO;
  return separated ? [top.id] : [top.id, runnerUp!.id];
}

/**
 * WHAT THIS SCREEN SAYS IT IS — THE ONE SEAM ALL SCREEN IDENTITY GOES THROUGH.
 *
 * Every sealed question id the screen presents, by either reading of the same re-read bytes,
 * AND WHICH READING SAW IT. Both are facts about the artifact; neither is the producer's
 * opinion of it. The provenance is not decoration — the two readings are not equally strong
 * evidence of identity, and one caller has to tell them apart:
 *
 *   `text`   the id is printed in the screen's rendered prose. PROSE REFERS TO OTHER
 *            QUESTIONS. "As you said in Q2…" prints `Q2` on a screen that is not Q2, and no
 *            amount of reading the screen can distinguish a heading from a back-reference.
 *   `markup` the id is carried by a CONTROL's `name`, or by its `id` prefix — the fields this
 *            screen submits. A screen's own form fields are a much stronger statement of
 *            which question it is than its prose is; back-references do not have `name`
 *            attributes.
 *
 * Neither is a guarantee, and both assumptions are stated in the header. What the split buys
 * is that the one arm which ACCUSES A SURVEY OF A DEFECT can require the stronger witness
 * while everything else keeps using the union.
 *
 * The UNION is the fail-closed mechanism, so `ids` is a union and not a precedence. A screen
 * whose markup says `Q7` while its text pipes `Q2` presents two sealed ids and has therefore
 * not identified itself to this verifier — at most one of them is its identity and choosing
 * would be a guess. Callers require the set to be a SINGLETON before they conclude anything.
 *
 * THIS IS THE SEAM 0.4's control-attribute binder filled and a later composite/model binder
 * fills next: a new way of recognising a screen is a new `witnessedBy` source here, not a new
 * branch in a predicate.
 */
export interface ScreenIdentity {
  /** The union — every sealed id the screen presents, by any reading. */
  ids: string[];
  /** Ids printed in the rendered prose. May be this screen's, or a reference to another's. */
  text: string[];
  /** Ids carried by the screen's own controls' `name` / `id`. */
  markup: string[];
  /**
   * Ids the DOCUMENT'S OWN WORDING claims (1.4.0) — one when the wording identified the screen,
   * TWO when its top two candidates tied and it could not, which is a refusal expressed as a
   * non-singleton union. A wording claim is a TEXT-CLASS witness: it is document prose matched
   * against screen prose, so the arm that ACCUSES may not rest on it.
   */
  wording: string[];
}

/**
 * EXPORTED FOR ONE REASON: the cross-module agreement test. `d35` drives THIS function and the
 * driver's REAL `bindDecision` over the same screens and asserts they reach the same conclusion,
 * which is the only thing that keeps two calibrated thresholds in two modules from drifting
 * apart. Nothing in `src/**` calls it from outside this file.
 */
export function screenIdentity(
  screen: RenderedScreen | null,
  sealedQuestionIds: string[],
  questionWording?: QuestionWordingIndex | null,
): ScreenIdentity {
  const text = sealedQuestionIds.filter((q) => tokenOnScreen(screen, q));
  const markup = controlSealedIdsOnScreen(screen, sealedQuestionIds);
  const wording = wordingClaims(screen, sealedQuestionIds, questionWording ?? null);
  const ids = [...new Set([...text, ...markup, ...wording])];
  return { ids, text: [...new Set(text)], markup, wording };
}

/** The union alone, for the callers that only ever need "is this set a singleton?". */
const sealedIdsOnScreen = (
  screen: RenderedScreen | null,
  sealedQuestionIds: string[],
  questionWording?: QuestionWordingIndex | null,
): string[] => screenIdentity(screen, sealedQuestionIds, questionWording).ids;

/**
 * IS THIS SCREEN THE QUESTION `target`? Only when the sealed ids it presents are EXACTLY
 * `{target}` — one id, and that one. Zero is "it did not identify itself"; two or more is
 * "it presented more than one and at most one of them is its identity". Both refuse.
 */
const screenIsQuestion = (
  screen: RenderedScreen | null,
  target: string,
  sealedQuestionIds: string[],
  questionWording?: QuestionWordingIndex | null,
): boolean => {
  const present = sealedIdsOnScreen(screen, sealedQuestionIds, questionWording);
  return present.length === 1 && present[0] === target;
};

/**
 * THE STEPS OF THIS WALK THAT HAPPENED ON THE CASE'S OWN QUESTION.
 *
 * A step qualifies only when its `screenBefore` identifies itself as the target question and
 * as nothing else — the sealed ids it presents, in its rendered text, in its controls'
 * `name`/`id` attributes, OR by the document's own wording of the question (1.4.0), are exactly
 * `{target}`. A screen presenting two sealed ids has not identified itself: it has printed,
 * named or described one and referenced the other, and this verifier cannot tell which way
 * round. Every reading is a positive check on the RE-READ artifact against the SEALED document;
 * nothing here consults the step's `decisionQuestion` or its `bindingVia`, which are the
 * producer's own account of this same match and are exactly the inputs a verifier must not take
 * on trust. Its `bindingRefusals` ARE consulted, in `selectCaseStep`, and only ever to refuse.
 */
function stepsOnTargetQuestion(
  walk: PathObservation,
  targetQuestionId: string,
  sealedQuestionIds: string[],
  questionWording: QuestionWordingIndex | null,
): StepObservation[] {
  return walk.steps.filter((s) =>
    screenIsQuestion(s.screenBefore, targetQuestionId, sealedQuestionIds, questionWording),
  );
}

/**
 * The stimulus a case is defined by — "clicked this answer", "typed this value" — plus the
 * reason to give when NO step in the walk performed it at all.
 */
interface CaseStimulus {
  performed(step: StepObservation): boolean;
  /** Phrase naming the stimulus, for the detail line. */
  describe: string;
  notPerformed: VerifierReason;
  notPerformedDetail: string;
}

type StepSelection =
  | { step: StepObservation; failure: null }
  | { step: null; failure: PredicateResult };

/**
 * PICK THE ONE STEP THAT EXERCISED THIS CASE, OR REFUSE TO DECIDE.
 *
 * The order matters. Binding is checked BEFORE the outcome is ever read, so no wrongly
 * chosen step can contribute a screen to a verdict. Every non-selection is an
 * `insufficient` naming what was missing; none of them is a defect claim, because "I could
 * not find the step" says nothing whatever about the survey.
 */
function selectCaseStep(
  predicateId: string,
  walk: PathObservation,
  ctx: PredicateContext,
  stimulus: CaseStimulus,
): StepSelection {
  const target = ctx.targetQuestionId;
  if (!target) {
    return {
      step: null,
      failure: insufficient(
        predicateId,
        VERIFIER_REASON.CASE_TARGET_QUESTION_UNKNOWN,
        "the sealed case names no target question, so no step of this walk can be shown to be the one that exercised it",
      ),
    };
  }

  // VETO 1 — THE WALK'S OWN ACCOUNT OF WHAT IT NEVER BOUND (1.4.0). `unboundDecisions` is the
  // walker saying it never identified a screen as this question at all, so it answered whatever
  // screens it saw by the navigator's default rather than by the document's answer. A step this
  // file then binds to that question is a screen the walker declined to identify, and a verdict
  // off it would be the two halves of the system disagreeing with only one of them heard.
  // ABSENT ON OLDER ARTIFACTS, and absence vetoes nothing (it is not evidence everything bound).
  const neverBound = (walk.unboundDecisions ?? []).find((u) => u && u.question === target);
  if (neverBound) {
    return {
      step: null,
      failure: insufficient(
        predicateId,
        VERIFIER_REASON.TARGET_QUESTION_NEVER_BOUND_IN_WALK,
        `the walk records that it never bound a planned decision to ${target} (${neverBound.reason}), so it never ` +
          `deliberately answered that question; any step this verifier binds to ${target} is a screen the walker ` +
          `itself declined to identify, and the two halves disagreeing about identity is not something either may settle`,
      ),
    };
  }

  const candidates = stepsOnTargetQuestion(walk, target, ctx.sealedQuestionIds, ctx.questionWording).filter((s) =>
    stimulus.performed(s),
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only) {
    // VETO 2 — THE WALKER REFUSED THIS EXACT SCREEN FOR THIS EXACT QUESTION (1.4.0). This is
    // the precise form of the same disagreement, and it is the drift detector between the two
    // binders: it can only fire when the driver's rebuilt identity and this file's recomputed
    // identity reach opposite conclusions about one screen. It only ever SUBTRACTS, which is
    // why reading the producer's own record is admissible here and not for `bindingVia`.
    const refusal = (only.bindingRefusals ?? []).find((r) => r && r.question === target);
    if (refusal) {
      return {
        step: null,
        failure: insufficient(
          predicateId,
          VERIFIER_REASON.WALKER_REFUSED_THIS_SCREEN,
          `this verifier reads step ${only.stepIndex}'s screen as ${target}, but the walker refused to bind ${target} ` +
            `to that same screen (${refusal.reason}: ${refusal.detail}). One of the two identity readings is wrong ` +
            `and nothing here can say which, so no verdict is taken from it`,
        ),
      };
    }
    return { step: only, failure: null };
  }
  if (candidates.length > 1) {
    return {
      step: null,
      failure: insufficient(
        predicateId,
        VERIFIER_REASON.STEP_BINDING_AMBIGUOUS,
        `${candidates.length} steps of this walk are on ${target} and each performed ${stimulus.describe}; ` +
          `which one this case is about cannot be read off the walk, and choosing one would be a guess`,
      ),
    };
  }

  // Nothing bound. Distinguish "the stimulus never happened anywhere" — a fact about the
  // walk — from "it happened, but never on a screen that identified itself as the target",
  // which is a fact about this verifier's reach and must not be reported as the former.
  const elsewhere = walk.steps.filter((s) => stimulus.performed(s));
  if (elsewhere.length === 0) {
    return { step: null, failure: insufficient(predicateId, stimulus.notPerformed, stimulus.notPerformedDetail) };
  }
  return {
    step: null,
    failure: insufficient(
      predicateId,
      VERIFIER_REASON.STEP_NOT_BOUND_TO_TARGET_QUESTION,
      `${elsewhere.length} step(s) of this walk performed ${stimulus.describe}, but none of them is on ${target}: ` +
        `no step's own screen presented ${target} and nothing else sealed, in either its rendered text or its ` +
        `controls' name/id attributes. Reading one of them anyway would be deciding this case off another ` +
        `question's screen`,
    ),
  };
}

/**
 * ROUTE — "answering Q7 'Can't remember' must land on Q9".
 *
 * The expectation is entirely from the seal (`routeAnswer` + `expectedDestination`); the
 * fact is entirely from the re-read walk. The asymmetry between the two failure arms is the
 * important part:
 *
 *   VERIFIED needs a positive witness — the expected destination is ON the reached screen.
 *   CONTRADICTED needs a positive witness TOO — some OTHER sealed question is on the reached
 *   screen. Absence of the expected token is NOT a mismatch: plenty of surveys never print
 *   question numbers, and failing on that would fabricate defects out of formatting. When
 *   neither witness is available the answer is `insufficient`, which costs the run a pass
 *   and accuses nobody.
 */
const routeDestination: Predicate = {
  id: "route-destination/1.0.0",
  run(expectation, walk, ctx) {
    const answer = expectation.routeAnswer;
    const dest = expectation.expectedDestination;
    if (!answer || !dest || (answer.code === null && answer.label === null)) {
      return insufficient(
        this.id,
        VERIFIER_REASON.NO_TYPED_EXPECTATION,
        "the sealed route case names no answer or no expected destination",
      );
    }

    // THE STEP MUST BE THIS CASE'S OWN STEP. Selecting it by the answer alone reads whichever
    // earlier question happened to be answered "Yes" too — see the D19 header.
    const selection = selectCaseStep(this.id, walk, ctx, {
      performed: (s) => selectedAnswer(s, answer.code, answer.label),
      describe: `the documented answer (code=${answer.code ?? "-"}, label=${answer.label ?? "-"})`,
      notPerformed: VERIFIER_REASON.ROUTE_ANSWER_NOT_SELECTED,
      notPerformedDetail:
        `no step in this walk selected the documented answer (code=${answer.code ?? "-"}, label=${answer.label ?? "-"}), ` +
        `so this walk never exercised the branch`,
    });
    if (selection.step === null) return selection.failure;
    const step = selection.step;

    if (!step.advanced || !step.screenAfterAdvance) {
      return insufficient(
        this.id,
        VERIFIER_REASON.ROUTE_NOT_ADVANCED,
        "the documented answer was selected but the survey did not advance, so no destination was reached",
      );
    }
    if (dest.terminal) {
      // "complete" vs "screenout" vs "quota" is a distinction the DOM does not draw, and
      // guessing it from the absence of a Next button would be exactly that: a guess.
      return insufficient(
        this.id,
        VERIFIER_REASON.TERMINAL_DESTINATION_NOT_DISCRIMINABLE,
        `the sealed destination is the terminal state "${dest.terminal}", which this verifier cannot tell apart ` +
          `from the other terminal states without reading the document`,
      );
    }

    const wanted = dest.questionId ?? dest.screen;
    if (!wanted) {
      return insufficient(this.id, VERIFIER_REASON.NO_TYPED_EXPECTATION, "the sealed destination names neither a question nor a screen");
    }

    // THE SECOND HALF OF SCREEN IDENTITY, and it must read the artifact the same way the
    // binding half does. Identifying the ORIGIN screen from the markup while still reading the
    // DESTINATION out of rendered text alone binds every case and then concludes nothing about
    // any of them — a null run with extra steps.
    // `wanted` JOINS THE VOCABULARY EXPLICITLY. `ctx.sealedQuestionIds` is built from the
    // cases' `targetQuestionId`s, and a documented DESTINATION need not itself be any case's
    // target — so reading identity over the sealed list alone would drop the very id being
    // looked for and report every reached screen as unidentifiable.
    const reached = step.screenAfterAdvance;
    const identity = screenIdentity(reached, [wanted, ...ctx.sealedQuestionIds], ctx.questionWording);
    const present = identity.ids;
    const alsoPresent = present.filter((q) => q !== wanted);
    if (present.includes(wanted)) {
      // The reached screen names the destination — and something else the seal knows. Under
      // one-question-per-screen at most one of them is its identity and the rest are pipes or
      // back-references, so "it presented ${wanted}" no longer implies "it IS ${wanted}".
      if (alsoPresent.length > 0) {
        return insufficient(
          this.id,
          VERIFIER_REASON.DESTINATION_AMBIGUOUS,
          `the reached screen presents ${wanted} and also ${alsoPresent.join(", ")}; at most one of those is the ` +
            `screen's own identity and the others are piped or back-referenced, which this verifier cannot tell ` +
            `apart without the document`,
        );
      }
      return {
        outcome: "satisfied",
        reason: VERIFIER_REASON.ROUTE_DESTINATION_REACHED,
        predicate: this.id,
        detail: `selecting the documented answer advanced to a screen presenting ${wanted}`,
      };
    }

    // THE EXPECTED ID IS ABSENT AND SEVERAL OTHERS ARE PRESENT. Claiming a routing defect means
    // naming the screen that WAS reached, and with two candidates that name is a guess — the
    // same guess the singleton rule refuses one line above, and a `violated` is the one outcome
    // a guess may never produce. This arm used to take `alsoPresent[0]` regardless of how many
    // there were; every mismatch fixture in the suite presents exactly one, which is why the
    // hole was invisible rather than harmless.
    if (alsoPresent.length > 1) {
      return insufficient(
        this.id,
        VERIFIER_REASON.DESTINATION_AMBIGUOUS,
        `the reached screen does not present ${wanted}, and presents ${alsoPresent.join(", ")} — more than one ` +
          `sealed question — so which screen was actually reached cannot be read off it, and a mismatch naming ` +
          `any one of them would be a guess`,
      );
    }

    const other = alsoPresent[0];
    if (other) {
      // EXACTLY ONE FOREIGN ID — AND NOW THE QUESTION IS WHICH READING SAW IT (0.2).
      //
      // A screen that prints no id of its own and says "as you said in Q2, which brands…" puts
      // `Q2` on a screen that is NOT Q2. Under text-only identity that screen "presents Q2",
      // `wanted` is absent, exactly one foreign id is present — and this arm reported a ROUTING
      // DEFECT ON A HEALTHY SURVEY, naming a destination the walk never reached. The length
      // check one branch up does not catch it: a back-reference to one question is the common
      // shape, so `alsoPresent.length === 1` is the case it produces.
      //
      // Prose refers to other questions; a control's `name`/`id` does not. So the arm that
      // ACCUSES requires the MARKUP witness, while the union still governs everything else.
      // The price is stated openly and was accepted with the fix (DIRECTIONAL-PLAN §0.2): on an
      // instrument that carries its ids only in prose, this verifier stops claiming routing
      // defects altogether and says so per case. A named `insufficient` on a real defect costs
      // the run one finding; a `contradicted` on a healthy site costs the product its claim to
      // be worth reading.
      //
      // 1.4.0 DID NOT MOVE THIS LINE, AND THE NEW WITNESS DOES NOT GET TO CROSS IT. A wording
      // claim is DOCUMENT PROSE matched against SCREEN PROSE, so it fails in the same direction
      // a back-reference does: a screen that quotes or summarises ${other} scores like ${other}
      // without being it. The wording witness may therefore identify a screen for BINDING (where
      // being wrong costs a refusal) and may never carry the ACCUSATION (where being wrong costs
      // a client a fabricated defect). Markup — the fields this screen submits — remains the
      // only witness admissible here.
      if (!identity.markup.includes(other)) {
        const sawIt = [
          ...(identity.text.includes(other) ? [`prints ${other} in its rendered text`] : []),
          ...(identity.wording.includes(other) ? [`matches the document's own wording of ${other}`] : []),
        ];
        return insufficient(
          this.id,
          VERIFIER_REASON.DESTINATION_IDENTIFIED_BY_TEXT_ONLY,
          `the reached screen does not present ${wanted}; it ${sawIt.join(" and ")}, but no control ` +
            `on it is named after ${other}. Rendered prose carries BACK-REFERENCES ("as you said in ${other}…") and a ` +
            `screen that quotes or summarises a question scores like its wording, so a screen matching ${other} need ` +
            `not BE ${other} — and naming it as the destination actually reached would be a guess in the one ` +
            `direction a guess may never go`,
        );
      }
      return {
        outcome: "violated",
        reason: VERIFIER_REASON.ROUTE_DESTINATION_MISMATCH,
        predicate: this.id,
        detail:
          `the document routes to ${wanted}; the walk reached a screen whose own controls are named after ${other}` +
          (identity.text.includes(other) ? " and whose text prints it too" : ""),
      };
    }
    return insufficient(
      this.id,
      VERIFIER_REASON.DESTINATION_NOT_IDENTIFIABLE,
      `the reached screen presents neither ${wanted} nor any other sealed question id — not in its rendered text ` +
        `and not in its controls' name/id attributes — so the destination cannot be identified`,
    );
  },
};

/** Did this step actually click the documented answer? Exact code, or exact label. */
function selectedAnswer(step: StepObservation, code: string | null, label: string | null): boolean {
  return step.actions.some(
    (a) =>
      a.kind === "click-option" &&
      a.ok &&
      ((code !== null && a.targetCode === code) ||
        (label !== null && a.targetLabel !== null && norm(a.targetLabel) === norm(label))),
  );
}

/**
 * VALIDATION MESSAGES THAT APPEARED AFTER *THIS* SUBMIT — a DELTA, never a presence test.
 *
 * THE DEFECT THIS CLOSES (path #4). `browser/page-script.ts` collects messages with
 * `.error, [class*=error], [role=alert], [aria-live], .validation, [class*=invalid]`. On a real
 * site that selector matches the cookie banner, a toast, a live region announcing the progress
 * bar, and any element whose class merely contains "error". A PRESENCE test over that selector
 * reports "the survey rejected this input" because the page has a cookie banner.
 *
 * A message that was ALREADY ON THE SCREEN BEFORE WE TOUCHED IT cannot be about what we typed.
 * Subtracting `screenBefore` removes every persistent decoy in one rule, without this file
 * having to know what a cookie banner looks like — which is the only version of the rule that
 * survives a survey nobody here has seen.
 *
 * BOTH POST-SUBMIT SCREENS ARE READ, and that is a fix in its own right. `screenAfterAction` is
 * captured after the field is filled but BEFORE Next is clicked, so a survey that validates ON
 * SUBMIT — the common case — had its message land in `screenAfterAdvance`, which this predicate
 * never looked at. Rejections were being missed outright, and the `blocked` flag was covering
 * for it.
 */
function deltaValidationMessages(step: StepObservation): string[] {
  const had = new Set((step.screenBefore?.validationMessages ?? []).map(norm).filter(Boolean));
  const after = [
    ...(step.screenAfterAction?.validationMessages ?? []),
    ...(step.screenAfterAdvance?.validationMessages ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of after) {
    const n = norm(m);
    if (!n || had.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(m);
  }
  return out;
}

/**
 * IS A REJECTION ON THIS SCREEN ATTRIBUTABLE TO THE DOCUMENTED CONTROL?
 *
 * THE DEFECT THIS CLOSES. `browser/driver.ts#applyDecision` types the planned value into
 * EVERY empty text control on the screen:
 *
 *     for (const c of textControls) { if (c.value?.length) continue; await typeIdx(page, c.idx, value); }
 *
 * So on a screen with an age field and a postcode field, "151" goes into both. The postcode
 * field refuses it, one screen-level message appears, and the predicate credits — or blames —
 * the age boundary for it. The message is real; the attribution is invented.
 *
 * THE MESSAGES THEMSELVES CARRY NO BINDING. `RenderedScreen.validationMessages` is a
 * `string[]`: the capture records what the error elements said and not which control they were
 * about. Binding them properly is a CAPTURE change (see the note below), so until that lands
 * attribution is established by EXCLUSIVITY — this step wrote to exactly one thing that could
 * have raised the message — and refuses when it cannot be:
 *
 *   1. EXACTLY ONE text control was written to by this step. Two writes, two candidates.
 *   2. NO GRID on the screen. `applyDecision` skips its default-answer pass entirely when
 *      `screen.grid` is set (`if (!answeredSomething && !screen.grid)`), so a grid screen
 *      submits with rows unanswered and the message is as likely to be the grid's.
 *   3. EVERY option group was answered at submit time. An unanswered radio raises "please
 *      answer this question", which is not our boundary's rejection.
 *
 * All three read bytes already in the artifact. When any fails the outcome is
 * `BOUNDARY_REJECTION_NOT_ATTRIBUTABLE` — insufficient, naming which one.
 *
 * WHAT WOULD MAKE THIS BETTER, and it is IN SCOPE for this file's owner but deliberately not
 * done here: capture a per-message association in `page-script.ts` — the control that
 * `aria-describedby`/`aria-errormessage` points at the message node, a `label[for]`, or the
 * nearest ancestor containing exactly one control — as an optional structured
 * `validationSignals` array beside the existing strings. That would let a MULTI-input screen
 * still reach a verdict instead of refusing. It is not done in this change because the page
 * script is an in-page string blob with no browser in the test suite to execute it, the first
 * real run is imminent, and CORRECTNESS here does not depend on it: without it the predicate
 * loses yield on multi-input screens; with a wrong version of it, it fabricates defects.
 *
 * ONLY THE REJECTION ARMS NEED THIS. An ADVANCE is screen-wide: the survey accepted everything
 * on the screen, so it accepted ours. Refusal is the asymmetric one, and refusal is the only
 * thing being attributed.
 */
function boundaryControlAttribution(step: StepObservation): { ok: true } | { ok: false; why: string } {
  const writes = step.actions.filter((a) => a.ok && (a.kind === "type-text" || a.kind === "clear-text"));
  if (writes.length !== 1) {
    return {
      ok: false,
      why:
        `this step wrote to ${writes.length} text control(s) on the screen, so a screen-level validation message ` +
        `cannot be tied to the documented one — the driver types the planned value into every empty text control, ` +
        `and a sibling field's refusal looks identical from here`,
    };
  }
  if (step.screenBefore?.grid) {
    return {
      ok: false,
      why:
        "the screen carries a grid, which the driver does not auto-answer, so the submit could have been refused " +
        "for an unanswered grid row rather than for the documented input",
    };
  }
  const atSubmit = step.screenAfterAction ?? step.screenBefore ?? null;
  const unanswered = (atSubmit?.optionGroups ?? []).filter((g) => !g.options.some((o) => o.checked === true));
  if (unanswered.length > 0) {
    return {
      ok: false,
      why:
        `${unanswered.length} option group(s) on this screen (${unanswered.map((g) => g.name).join(", ")}) were ` +
        `unanswered at submit, and an unanswered question raises a validation message of its own`,
    };
  }
  return { ok: true };
}

/**
 * WHAT THE SURVEY DID WITH THIS INPUT — FOUR STATES, AND TWO OF THEM ARE "I DO NOT KNOW".
 *
 * ==================== THE DEFECT THIS REPLACES ====================
 *
 *     const rejected = step.blocked === true || (step.screenAfterAction?.validationMessages.length ?? 0) > 0;
 *
 * `blocked` is `!advanced` (`browser/driver.ts`), and `advanced` is set by WINNING A POLLING
 * RACE against `advanceTimeoutMs`. A slow-but-healthy survey loses that race and is byte-
 * identical, at this line, to a survey that refused the input — so a boundary the site
 * correctly ACCEPTED became `BOUNDARY_REJECTED_UNEXPECTEDLY`, and the run reported a confident
 * defect about a working survey. That is the product's cardinal failure, not a rough edge.
 *
 * ==================== WHY THE OBVIOUS FIX IS ALSO WRONG ====================
 *
 * "Require a validation message" flips the other arm. A survey that refuses SILENTLY — the
 * submit does nothing, the Next button greys out, no message — then reads as ACCEPTED, and a
 * boundary the document says must be rejected becomes `BOUNDARY_NOT_REJECTED`: a NEW confident
 * false defect, on the same healthy-survey side. Trading one fabrication for another is not a
 * fix.
 *
 * And a naive tri-state still misses a fourth quadrant: server-side validation that NAVIGATES
 * to an error interstitial ADVANCES and shows a message. Read as "advanced → accepted", a
 * survey that rejected the input on the server certifies it as accepted.
 *
 * ==================== THE FOUR STATES ====================
 *
 *   advanced + no witness  → ACCEPTED     the survey took it and moved on
 *   no advance + witness   → REJECTED     it stayed put and said why (and see the attribution rule)
 *   no advance + no witness→ insufficient BOUNDARY_REJECTION_NOT_WITNESSED — silent refusal and
 *                                         slow page are the same bytes; DO NOT GUESS
 *   advanced + witness     → insufficient BOUNDARY_OUTCOME_CONFLICTING — it moved AND complained;
 *                                         an error interstitial and a noisy accept are the same
 *                                         bytes; DO NOT GUESS
 *
 * ==================== WHICH FIELD THIS KEYS ON, AND WHY IT IS NOT `blocked` ====================
 *
 * IT KEYS ON `advanced`. `blocked` has a hole with a survey behind it: when a screen offers no
 * ENABLED advance control, `walkPath` takes the no-button path and writes `blocked: false` AND
 * `advanced: false` — and A DISABLED NEXT BUTTON IS THE COMMON WAY A SURVEY REFUSES AN INPUT.
 * A tri-state keyed on `blocked` therefore reads a disabled-Next refusal as "not rejected" and
 * ships `BOUNDARY_NOT_REJECTED` — the exact false defect this function exists to remove, re-
 * introduced by the fix for it. `advanced` has no such hole: it is false on both no-advance
 * shapes, so both land in the no-advance quadrants and neither can become a verdict by accident.
 *
 * `blockedReason` is read only to NAME the insufficient. It is the walker's account of its own
 * decision, not the survey's, so it may sharpen a refusal to decide and may never author a
 * decision — and it is absent on artifacts written before it existed, which must change nothing.
 */
type BoundaryRead =
  | { state: "accepted"; detail: string }
  | { state: "rejected"; detail: string }
  | { state: "insufficient"; reason: VerifierReason; detail: string };

function readBoundaryOutcome(step: StepObservation): BoundaryRead {
  const messages = deltaValidationMessages(step);
  const witnessed = messages.length > 0;
  const said = messages.map((m) => `"${m}"`).join(", ");
  const walker = step.blockedReason ? ` The walker recorded why it stopped: ${step.blockedReason}.` : "";

  if (step.advanced === true) {
    if (!witnessed) {
      return { state: "accepted", detail: "the survey advanced and raised no message it was not already showing" };
    }
    return {
      state: "insufficient",
      reason: VERIFIER_REASON.BOUNDARY_OUTCOME_CONFLICTING,
      detail:
        `the survey ADVANCED and a validation message appeared after the submit (${said}). Server-side validation ` +
        `that navigates to an error page looks exactly like this, and so does an accepted input on a page that ` +
        `announces something unrelated; deciding between them needs the destination read against the document`,
    };
  }

  if (!witnessed) {
    return {
      state: "insufficient",
      reason: VERIFIER_REASON.BOUNDARY_REJECTION_NOT_WITNESSED,
      detail:
        `the survey did not advance and showed no message it was not already showing. A survey that refuses ` +
        `silently and a survey that is merely slower than the advance timeout produce identical bytes here, so ` +
        `neither "rejected" nor "accepted" can be read off this step.${walker}`,
    };
  }

  const attribution = boundaryControlAttribution(step);
  if (!attribution.ok) {
    return {
      state: "insufficient",
      reason: VERIFIER_REASON.BOUNDARY_REJECTION_NOT_ATTRIBUTABLE,
      detail: `the survey refused the submit and said ${said}, but ${attribution.why}`,
    };
  }
  return { state: "rejected", detail: `the survey did not advance and said ${said}` };
}

/**
 * BOUNDARY — "entering 151 in the age field must be rejected".
 *
 * Both arms need a POSITIVE witness, and they need DIFFERENT ones: acceptance is witnessed by
 * the survey advancing without complaint, rejection by a message that appeared after this
 * submit and belongs to this control. Everything else is `insufficient` — see
 * `readBoundaryOutcome` for the four states and why three-valued logic is not enough.
 * `unspecified` is not an expectation and is never decided.
 */
const boundaryOutcome: Predicate = {
  id: "boundary-outcome/1.0.0",
  run(expectation, walk, ctx) {
    const b = expectation.boundaryInput;
    if (!b || b.expectedOutcome === "unspecified") {
      return insufficient(
        this.id,
        VERIFIER_REASON.NO_TYPED_EXPECTATION,
        "the sealed boundary case states no expected outcome, so there is nothing to check the walk against",
      );
    }

    // SAME BINDING RULE AS ROUTE, and for the same reason: "18" or an empty field is typed on
    // plenty of questions, and the first one is not this case's one. An unbound step here
    // produces `BOUNDARY_NOT_REJECTED` — a defect claim — off another question's validation.
    const selection = selectCaseStep(this.id, walk, ctx, {
      performed: (s) =>
        s.actions.some(
          (a) =>
            a.ok &&
            ((b.bound === "empty" && a.kind === "clear-text") ||
              (a.kind === "type-text" && b.value !== null && a.value === b.value)),
        ),
      describe: `the documented boundary input (${b.bound}: ${b.value ?? "<empty>"})`,
      notPerformed: VERIFIER_REASON.BOUNDARY_INPUT_NOT_ENTERED,
      notPerformedDetail: `no step in this walk entered the documented boundary input (${b.bound}: ${b.value ?? "<empty>"})`,
    });
    if (selection.step === null) return selection.failure;
    const step = selection.step;

    // THE OUTCOME IS READ ONCE, INDEPENDENTLY OF WHAT THE DOCUMENT EXPECTS. A read that knew
    // the expectation could resolve its own uncertainty in the expectation's favour, which is
    // how a verifier comes to confirm whatever it was looking for; this one is document-blind
    // and returns the same four states whichever way the seal points.
    const read = readBoundaryOutcome(step);
    if (read.state === "insufficient") return insufficient(this.id, read.reason, read.detail);

    if (b.expectedOutcome === "rejected") {
      return read.state === "rejected"
        ? {
            outcome: "satisfied",
            reason: VERIFIER_REASON.BOUNDARY_REJECTED_AS_DOCUMENTED,
            predicate: this.id,
            detail: `the documented out-of-range input was refused, as the document requires: ${read.detail}`,
          }
        : {
            outcome: "violated",
            reason: VERIFIER_REASON.BOUNDARY_NOT_REJECTED,
            predicate: this.id,
            detail: `the document requires this input to be rejected; ${read.detail}`,
          };
    }
    return read.state === "rejected"
      ? {
          outcome: "violated",
          reason: VERIFIER_REASON.BOUNDARY_REJECTED_UNEXPECTEDLY,
          predicate: this.id,
          detail: `the document requires this input to be accepted; ${read.detail}`,
        }
      : {
          outcome: "satisfied",
          reason: VERIFIER_REASON.BOUNDARY_ACCEPTED_AS_DOCUMENTED,
          predicate: this.id,
          detail: `the documented in-range input was accepted: ${read.detail}`,
        };
  },
};

/**
 * THE REGISTRY. Case kinds absent from this table are UNVERIFIABLE BY THIS STAGE — the
 * lookup returns undefined and the decision is `insufficient`. There is no default
 * predicate, because a default is how an unrecognised case kind would acquire a pass.
 */
const PREDICATE_FOR_KIND: Partial<Record<FacetCase["kind"], Predicate>> = {
  route: routeDestination,
  boundary: boundaryOutcome,
};
