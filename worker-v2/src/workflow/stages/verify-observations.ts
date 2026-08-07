/**
 * PHASE: verifying — stamp every observation with a tri-state verifier decision.
 *
 * The aggregator downstream reads exactly one field, `observation.verifier.decision`, and
 * only `verified` becomes a pass. This stage is where that field is filled in, and the
 * shape of what it may do is the whole point:
 *
 *   - it may DEMOTE a structural contradiction to `contradicted`;
 *   - it may leave `insufficient`, which costs the run a pass;
 *   - it may PROMOTE to `verified` ONLY through a closed predicate that compared a TYPED
 *     EXPECTATION sealed in the contract revision against ARTIFACT BYTES it re-read and
 *     re-hashed itself.
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
 * SCREEN IDENTIFIES ITSELF as the case's `targetQuestionId` — the id appears as a whole word
 * on `screenBefore`, and no OTHER sealed question id does. Exactly one such step must have
 * performed the documented stimulus. Zero → `insufficient`; more than one → `insufficient`.
 * Nothing else is accepted as a binder. In particular `StepObservation.decisionQuestion` is
 * NOT used: it is the driver's own heuristic match (`browser/driver.ts#matchDecision` scores
 * option-label overlap alone, with no question token at all), so binding on it would let the
 * same mislabelling back in through a narrower door.
 *
 * THE ASSUMPTION THIS STATES (CLAUDE.md: no silent reliance on a convention). Screen-witnessed
 * binding assumes A SCREEN PRINTS ITS OWN QUESTION ID and does not print another question's.
 * When that does not hold the case is not decided — it is reported as
 * `STEP_NOT_BOUND_TO_TARGET_QUESTION` / `STEP_BINDING_AMBIGUOUS` / `CASE_TARGET_QUESTION_UNKNOWN`,
 * which is a named limitation in the reason histogram, not a verdict. A survey that prints no
 * ids therefore yields no route verdicts at all — which was already true of the DESTINATION
 * half of the same predicate, since it needs the id printed on the reached screen to conclude
 * anything.
 *
 * WHAT IS DELIBERATELY *NOT* CLAIMED. Only two case kinds carry an expectation this stage can
 * decide without reading the document: `route` and `boundary`. `rendered-state`, `copy`,
 * `option-set` and `configuration` need the document's own prose compared to a screen, which
 * is the model verifier's job, and it is not wired. They return `insufficient` with
 * NO_TYPED_EXPECTATION and the run reports `pending` for them. A narrower verifier that is
 * right is worth more than a broad one that guesses.
 *
 * WORKERSAI_ENABLED IS FALSE BY DEFAULT (the free neuron allowance is spent), and the
 * degradation is the design, not a stopgap: a verifier that is unavailable yields
 * `insufficient` for everything it cannot decide, the run reports `incomplete` for those, and
 * nobody gets a green page out of a validator that never ran. A verifier that BLOCKED the run
 * instead would be worse — it would trade a truthful partial report for no report at all.
 */

import type { Env } from "../../types/env";
import { observationsKey } from "../../keys";
import { getVerifiedEvidence } from "../../store/evidence";
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

export const VERIFIER_VERSION = "v2-structural-verifier/1.2.0";

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
  BOUNDARY_INPUT_NOT_ENTERED: "BOUNDARY_INPUT_NOT_ENTERED",
  BOUNDARY_OUTCOME_UNDECIDED: "BOUNDARY_OUTCOME_UNDECIDED",
  PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE: "PARTIAL_SCOPE_CANNOT_SUPPORT_ABSENCE",
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
  const inputs = await loadRunInputs(env, runId);
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

  // One re-read per ARTIFACT, not per case: a walk that closes forty cases is one blob, and
  // `getVerifiedEvidence` re-hashes it on the way in. The cache holds bytes that already
  // passed that check; it never holds a producer's summary of them.
  const artifacts = new Map<string, PathObservation | null>();
  const readArtifact = async (evidenceId: string): Promise<PathObservation | null> => {
    if (artifacts.has(evidenceId)) return artifacts.get(evidenceId) ?? null;
    const parsed = await readWalkArtifact(env, inputs.evidence, evidenceId);
    artifacts.set(evidenceId, parsed);
    return parsed;
  };

  const verified: Observation[] = [];
  for (const o of inputs.observations) {
    const result = await decideObservation(o, casesById.get(o.facetInstanceId) ?? null, sealedQuestionIds, readArtifact);
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
 * The model-free structural floor. It can only ever say `contradicted` or `insufficient`,
 * and returns null when it has no opinion so the predicate may run.
 *
 * Nothing in this function looks at the DOCUMENT, so nothing in it is entitled to say an
 * observation matched one. That was true before there was any predicate at all and it is
 * still true; what changed is that a separate step, which DOES compare a sealed expectation
 * to re-read bytes, is now allowed to promote.
 */
export function structuralDecision(o: Observation): PredicateResult | null {
  const payload = o.payload as { contradiction?: unknown; error?: unknown } | null;
  if (payload && (payload.contradiction || payload.error)) {
    return {
      outcome: "violated",
      reason: VERIFIER_REASON.STRUCTURAL_CONTRADICTION,
      predicate: "structural",
      detail: "the observation carries its own contradiction or error payload",
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
 * Fetch and parse the walk artifact. `getVerifiedEvidence` re-hashes the stored bytes
 * against the catalogue entry, so a substituted or corrupted blob cannot reach a predicate.
 */
async function readWalkArtifact(
  env: Env,
  catalog: EvidenceCatalogEntry[],
  evidenceId: string,
): Promise<PathObservation | null> {
  const entry = catalog.find((e) => e.evidenceId === evidenceId);
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

/** Which sealed question ids OTHER than `self` does this screen present? */
const otherSealedIdsOnScreen = (screen: RenderedScreen | null, self: string, sealedQuestionIds: string[]): string[] =>
  sealedQuestionIds.filter((q) => q !== self && tokenOnScreen(screen, q));

/**
 * THE STEPS OF THIS WALK THAT HAPPENED ON THE CASE'S OWN QUESTION.
 *
 * A step qualifies only when its `screenBefore` names the target question as a whole word
 * AND names no other sealed question — a screen presenting two sealed ids has not identified
 * itself, it has printed one and referenced the other, and this verifier cannot tell which
 * way round. Both halves are positive checks on the RE-READ artifact; nothing here consults
 * the step's `decisionQuestion`, which is the producer's own heuristic guess at the same
 * question and is exactly the input a verifier must not take on trust.
 */
function stepsOnTargetQuestion(
  walk: PathObservation,
  targetQuestionId: string,
  sealedQuestionIds: string[],
): StepObservation[] {
  return walk.steps.filter(
    (s) =>
      tokenOnScreen(s.screenBefore, targetQuestionId) &&
      otherSealedIdsOnScreen(s.screenBefore, targetQuestionId, sealedQuestionIds).length === 0,
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

  const candidates = stepsOnTargetQuestion(walk, target, ctx.sealedQuestionIds).filter((s) => stimulus.performed(s));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only) return { step: only, failure: null };
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
        `no step's own screen presented ${target} and nothing else sealed. Reading one of them anyway would be ` +
        `deciding this case off another question's screen`,
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

    const reached = step.screenAfterAdvance;
    const alsoPresent = otherSealedIdsOnScreen(reached, wanted, ctx.sealedQuestionIds);
    if (tokenOnScreen(reached, wanted)) {
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

    const other = alsoPresent[0];
    if (other) {
      return {
        outcome: "violated",
        reason: VERIFIER_REASON.ROUTE_DESTINATION_MISMATCH,
        predicate: this.id,
        detail: `the document routes to ${wanted}; the walk reached a screen presenting ${other}`,
      };
    }
    return insufficient(
      this.id,
      VERIFIER_REASON.DESTINATION_NOT_IDENTIFIABLE,
      `the reached screen presents neither ${wanted} nor any other sealed question id, so the destination cannot be identified`,
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
 * BOUNDARY — "entering 151 in the age field must be rejected".
 *
 * Both arms are positive here: acceptance is witnessed by the survey advancing with no
 * validation message, rejection by a validation message or a blocked advance. `unspecified`
 * is not an expectation and is never decided.
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

    const rejected = step.blocked === true || (step.screenAfterAction?.validationMessages.length ?? 0) > 0;
    if (b.expectedOutcome === "rejected") {
      return rejected
        ? {
            outcome: "satisfied",
            reason: VERIFIER_REASON.BOUNDARY_REJECTED_AS_DOCUMENTED,
            predicate: this.id,
            detail: "the documented out-of-range input was refused, as the document requires",
          }
        : {
            outcome: "violated",
            reason: VERIFIER_REASON.BOUNDARY_NOT_REJECTED,
            predicate: this.id,
            detail: "the document requires this input to be rejected; the survey accepted it",
          };
    }
    if (rejected) {
      return {
        outcome: "violated",
        reason: VERIFIER_REASON.BOUNDARY_REJECTED_UNEXPECTEDLY,
        predicate: this.id,
        detail: "the document requires this input to be accepted; the survey refused it",
      };
    }
    return step.advanced
      ? {
          outcome: "satisfied",
          reason: VERIFIER_REASON.BOUNDARY_ACCEPTED_AS_DOCUMENTED,
          predicate: this.id,
          detail: "the documented in-range input was accepted and the survey advanced",
        }
      : insufficient(
          this.id,
          VERIFIER_REASON.BOUNDARY_OUTCOME_UNDECIDED,
          "the input raised no validation message but the survey did not advance either, so acceptance is undecided",
        );
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
