/**
 * PHASE: planning — the two-tier coverage plan, computed INSIDE the Worker.
 *
 * WHAT THIS STAGE IS. A pure, deterministic function of the SEALED contract revision:
 * a floor path set that provably witnesses every obligation, plus a risk-ranked
 * exploration queue. Zero model calls. Same contract in, same plan out.
 *
 * THE TWO RULES IT IS BUILT AROUND (owner ruling, restated in the emitted plan):
 *
 *   1. THE FLOOR MUST COVER EVERYTHING. `floor.coverage.covers_all_obligations` is
 *      computed, not asserted, and this stage refuses to report a plan as complete
 *      coverage when it is not. A gap is emitted as an `uncovered` row with a
 *      disposition, so a reader can see WHICH obligation no path witnesses.
 *
 *   2. EXPLORATION ONLY ADDS FINDINGS; IT NEVER CHANGES THE DENOMINATOR. That is
 *      enforced structurally here rather than promised: the execution cursor's
 *      `pendingCaseIds` are the SEALED contract's `facetInstances` — the mandatory
 *      execution cases minted at seal time — and nothing in the plan can add one.
 *      Exploration entries live in the plan's own queue and have no case id at all, so
 *      the seven coverage buckets cannot move when exploration runs.
 *
 * THE ASSIGNMENT is the bridge between the two: each mandatory execution case is mapped
 * to the floor path that witnesses its requirement. The executor walks PATHS (a walk is
 * the unit of browser work); completing a path closes every case assigned to it. A case
 * with no assigned path is left pending and is bucketed by the executing-close gate —
 * it is never quietly dropped, because a denominator that shrinks when execution is
 * missing hides the missing execution.
 */

import type { Env } from "../../types/env";
import { num } from "../../types/env";
import { planKey, plannerSidecarKey } from "../../keys";
import { getContractRevision, revisionIdentity } from "../../store/contract-revision";
import { loadCheckpoint } from "../../store/checkpoint";
import { canonicalHash } from "../../store/hash";
import type { ContractRevision, FacetInstance, ScopedRequirement } from "../../types/record";
import { hashContract, planFromContract, pathSignature } from "./planner/plan-core.js";
/**
 * Re-exported so a test reaches the planner THROUGH THIS MODULE. `tools/mutate-runner.mjs`
 * mutates sources inside esbuild's load step, so a test that imports `plan-core.js` directly
 * runs unmutated code and its guard can never be shown to fail — the exact "check that cannot
 * fail" shape CLAUDE.md warns about. Nothing in `src/**` calls these three from outside.
 */
export { hashContract, pathSignature, planFromContract };
import type {
  CoveragePlan,
  PlannedCaseAction,
  PlannedDecision,
  PlannedPath,
  PlannerContract,
  PlannerObligation,
} from "./planner/plan-core.js";
import {
  buildSealedSeedPlan,
  stampPlannedOccurrenceIdentity,
  type SeedPlan,
} from "./planner/seed-plan";
export {
  buildSealedSeedPlan,
  sealedSeedCertificateFailures,
  stampPlannedOccurrenceIdentity,
} from "./planner/seed-plan";
export { deriveCaseWitnessReceipt, retainFirstCaseWitnessReceipt, storedCaseWitnessReceiptFailures } from "./planner/seed-receipt";
import { sealedSeedCertificateFailures } from "./planner/seed-plan";

/**
 * NOT BUMPED, AND THE CHECK IS THE POINT. Everything this stage gained is ADDITIVE —
 * `PlannedDecision` already carries `[k: string]: unknown`, and `limitations` is a new
 * optional field nothing older reads. Bumping this constant would have re-run the 5 Aug
 * failure: four suite files (`d11`, `d15`, `d16`) seed the LITERAL `"v2-execution-program/2.0.0"`
 * into programs that `executionProgramFailures` then rejects on `kind`, so a bump breaks 22
 * tests that are testing something else entirely. A version is a promise about a shape a
 * READER depends on; nothing here changed a field a reader depends on.
 */
export const LEGACY_EXECUTION_PROGRAM_KIND = "v2-execution-program/2.0.0" as const;
export const EXECUTION_PROGRAM_KIND = "v2-execution-program/2.1.0" as const;

/**
 * A NAMED SHORTFALL IN THE PLAN — computed, counted, and carried on the artifact.
 *
 * WHY THIS IS NOT A WARNING STRING. `warnings` is an unstructured, unbounded list: the run
 * that motivated this emitted 48 separate "case … is unassigned: its route/boundary stimulus
 * is incomplete" lines into it, and the fact that A FIFTH OF THE SEALED CASES WERE NEVER
 * ASSIGNED TO ANY WALK was, in practice, invisible. A shortfall a reader has to grep for is a
 * shortfall that gets reported as a clean run.
 *
 * EVERY code is emitted ON EVERY PLAN, INCLUDING WITH `count: 0`. "We looked and it was zero"
 * has to be distinguishable from "nobody looked" (CLAUDE.md: coverage is computed, not
 * attested) — a limitations array that only lists non-zero rows cannot express the difference.
 */
export interface PlanLimitation {
  code: string;
  /** One sentence a reader can act on, in the plan's own words. */
  what: string;
  count: number;
  /** Sealed case ids this shortfall is about, when it is about cases. */
  caseIds?: string[];
  /** Question ids this shortfall is about, when it is about questions. */
  questionIds?: string[];
  /** Planned path ids this shortfall is about, when it is about executable work. */
  pathIds?: string[];
  /**
   * The exact subset whose absence prevents the test axis closing. An empty array means the
   * limitation qualifies optional exploration only; absence means this older limitation did
   * not make a closure claim.
   */
  blockingPathIds?: string[];
}

export const PLAN_LIMITATION_CODES = {
  /** Sealed cases no floor path witnesses: planned, counted, and NEVER walked. */
  unassignedCases: "cases-not-assigned-to-any-walk",
  /** Decisions the driver cannot recognise by the document's wording. */
  wordingMissing: "decisions-without-document-wording",
  /** Route "answers" that are routing CONDITIONS, so no option can ever match them. */
  routingConditionLabels: "route-labels-that-are-routing-conditions",
  /** Route answers naming only a CODE, which no sealed case gives a label for. */
  unresolvedRouteCodes: "route-codes-with-no-answer-label",
  /**
   * The four reasons a sealed case reaches no walk, each counted on its own.
   *
   * WHY THESE ARE SEPARATE CODES. `unassignedCases` above says HOW MANY; it cannot say what
   * to fix, and the single warning string it replaced actively misled: all 48 unassigned
   * cases in the motivating run were reported as "its route/boundary stimulus is incomplete",
   * which sent the next reader upstream to look for a missing stimulus — while 21 of the 48
   * have a perfectly good stimulus and no `targetQuestionId`, a different defect in a
   * different part of extraction. A shortfall reported under the wrong cause is worse than an
   * uncounted one, because it is acted on.
   */
  caseWithoutTargetQuestion: "cases-with-no-target-question-id",
  caseWithoutStimulus: "cases-with-no-stimulus-payload",
  caseTargetNotOnWitnessPath: "cases-whose-target-question-is-not-on-their-witness-path",
  caseWithoutWitnessPath: "cases-whose-requirement-has-no-witness-path",
  /**
   * Documented screen-outs the survival-hint stamp could not steer around: the document
   * states a disqualification but no answer LABEL could be resolved for it, so the walker's
   * default fillers may still walk into it. Emitted at zero so "nothing to avoid" stays
   * distinguishable from "no hints were stamped".
   */
  survivalHintsUnstampable: "screen-outs-with-no-stampable-answer-label",
  /** Planned browser actions the current forward-only driver has no action or receipt for. */
  backNavigationUnsupported: "planned-back-navigation-not-executable",
  /** Multi-session evidence the current one-walk-per-path executor cannot produce. */
  repeatedSessionsUnsupported: "planned-independent-session-repeats-not-executable",
  seedAuthorityWithheld: "sealed-positive-seed-authority-withheld",
  seedCardinalityWithheld: "seed-combinations-without-sealed-cardinality",
  seedBudgetExhausted: "seed-budget-exhausted",
} as const;

type ProbeCarrier = Partial<PlannedPath> & {
  mandatory?: unknown;
  observation_role?: unknown;
  covers_floor_gap?: unknown;
  requires_back_navigation?: unknown;
  repeats?: unknown;
  needs_repeats?: unknown;
};

export interface ProbeExecutionRequirements {
  backNavigation: boolean;
  repeatedSessions: boolean;
  unsupported: boolean;
}

/**
 * WHAT THE CURRENT BROWSER DRIVER CAN ACTUALLY CONSUME.
 *
 * `browser/driver.ts#walkPath` consumes `path.decisions` once. It has no consumer for the
 * planner's sibling `back_navigation` instruction, no session-index loop for `repeats`, and
 * no receipt shape that could prove either happened. Keeping that assumption here makes it a
 * checked capability boundary rather than a convention hidden in the executor.
 *
 * Unknown non-empty shapes degrade strict. A future planner spelling either instruction in a
 * new shape is unsupported until an adapter can execute it and emit verifiable receipts; it
 * must never fall through to an ordinary forward walk.
 */
export function probeExecutionRequirements(path: ProbeCarrier | null | undefined): ProbeExecutionRequirements {
  const p = path && typeof path === "object" ? path : {};
  const back = p.back_navigation;
  const backNavigation =
    p.requires_back_navigation === true ||
    (Array.isArray(back) ? back.length > 0 : back !== undefined && back !== null && back !== false);

  const repeats = p.repeats;
  const repeatedSessions =
    repeats !== undefined &&
    !(typeof repeats === "number" && Number.isFinite(repeats) && Number.isInteger(repeats) && repeats === 1);

  return { backNavigation, repeatedSessions, unsupported: backNavigation || repeatedSessions };
}

/** The current executor may only select paths whose complete action vocabulary it consumes. */
export function isExecutableProbePath(path: ProbeCarrier | null | undefined): boolean {
  return !probeExecutionRequirements(path).unsupported;
}

const requiredExploration = (path: ProbeCarrier): boolean =>
  path.mandatory === true ||
  path.observation_role === "required-additional" ||
  (typeof path.covers_floor_gap === "string" && path.covers_floor_gap.length > 0);

const exactIds = (values: unknown[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();

/**
 * Count every planned probe the current execution adapter cannot prove it performed.
 *
 * Both rows are emitted even at zero. `pathIds` is the full limitation; `blockingPathIds` is
 * the exact subset that represents floor work or explicitly required additional evidence.
 * Optional risk exploration remains visible without falsely moving the sealed denominator.
 */
export function probeCapabilityLimitations(plan: CoveragePlan): PlanLimitation[] {
  const floor = (plan?.floor?.paths ?? []) as ProbeCarrier[];
  const exploration = (plan?.exploration?.queue ?? []) as ProbeCarrier[];
  const carriers = [
    ...floor.map((path) => ({ path, tier: 1 as const })),
    ...exploration.map((path) => ({ path, tier: 2 as const })),
  ];

  const back = carriers.filter(({ path }) => probeExecutionRequirements(path).backNavigation);
  const blockingBack = back.filter(({ path, tier }) => tier === 1 || requiredExploration(path));

  // `needs_repeats` is the floor's own statement that one observation is insufficient. It is
  // included even if the repeated exploration entry was later dropped by a queue cap; a cap
  // must not turn known-insufficient evidence into a complete test. Those floor paths still run
  // once for their other obligations, so only direct `repeats` requests are filtered by the
  // executor below.
  const repeated = carriers.filter(({ path }) => {
    const needs = Array.isArray(path.needs_repeats) ? path.needs_repeats.length > 0 : false;
    return probeExecutionRequirements(path).repeatedSessions || needs;
  });

  const backIds = exactIds(back.map(({ path }) => path.id));
  const blockingBackIds = exactIds(blockingBack.map(({ path }) => path.id));
  const repeatedIds = exactIds(repeated.map(({ path }) => path.id));

  return [
    {
      code: PLAN_LIMITATION_CODES.backNavigationUnsupported,
      what:
        `${backIds.length} planned path(s) request back-navigation, but the current browser executor consumes only ` +
        `the forward decisions list and records no back-navigation receipt. ${blockingBackIds.length} of these are ` +
        `floor or explicitly mandatory work; they are excluded from executable work and prevent test completion.`,
      count: backIds.length,
      pathIds: backIds,
      blockingPathIds: blockingBackIds,
    },
    {
      code: PLAN_LIMITATION_CODES.repeatedSessionsUnsupported,
      what:
        `${repeatedIds.length} planned path(s) require evidence from more than one independent session, but the ` +
        `current executor invokes each path once and records no session-index receipt. These paths remain named ` +
        `insufficient evidence and prevent test completion; one forward walk is never certified as the experiment.`,
      count: repeatedIds.length,
      pathIds: repeatedIds,
      blockingPathIds: repeatedIds,
    },
  ];
}

/** Only capability gaps that make a complete test claim impossible. */
export function requiredProbeCapabilityLimitations(
  limitations: readonly PlanLimitation[] | null | undefined,
): PlanLimitation[] {
  if (!Array.isArray(limitations)) return [];
  const codes = new Set<string>([
    PLAN_LIMITATION_CODES.backNavigationUnsupported,
    PLAN_LIMITATION_CODES.repeatedSessionsUnsupported,
  ]);
  return limitations.filter(
    (limitation) =>
      codes.has(limitation.code) &&
      limitation.count > 0 &&
      Array.isArray(limitation.blockingPathIds) &&
      limitation.blockingPathIds.length > 0,
  );
}

/** One planned walk, with cases it is assigned to exercise. Assignment is not closure. */
export interface PathAssignment {
  pathId: string;
  tier: 1 | 2;
  /** Mandatory case ids this path targets. Evidence decides which, if any, it exercises. */
  caseIds: string[];
  /** Obligation ids the plan says this walk witnesses. Claim of relevance, NOT a verdict. */
  witnesses: string[];
}

export interface ExecutionProgram {
  kind: typeof EXECUTION_PROGRAM_KIND | typeof LEGACY_EXECUTION_PROGRAM_KIND;
  runId: string;
  planRevisionId: string;
  contractRevisionId: string;
  contractHash: string | null;
  generatedAt: string;
  surveyUrl: string;
  /** Floor first, in plan order; the executor consumes this list head-first. */
  floor: PathAssignment[];
  /** Tier 2. No case ids by construction — exploration may only ADD findings. */
  exploration: Array<{ pathId: string; cls: string; priority: number; mandatory: boolean }>;
  /** Exact duplicate-free permutation of the sealed mandatory case ids, in sealed order. */
  caseOrder: string[];
  /** Cases no floor path witnesses. Never removed from the denominator. */
  unassignedCaseIds: string[];
  /** Alternatives for unchanged sealed cases. They are exploration until an exact receipt closes one. */
  seedPlan?: SeedPlan;
  /**
   * NAMED, COUNTED SHORTFALLS. Always present on a plan this stage built; optional on the
   * TYPE because programs written before it existed re-read without it and must not be
   * silently treated as "no shortfalls" — read it through `programLimitations()`.
   */
  limitations?: PlanLimitation[];
  coverage: {
    obligations: number;
    witnessedByFloor: number;
    coversAllObligations: boolean;
    coversAllAfterMandatoryExploration: boolean;
    uncovered: Array<{ obligation: string; disposition: string }>;
  };
  warnings: string[];
  plan: CoveragePlan;
}

export interface PlanStageResult {
  planRevisionId: string;
  /** Hash of the exact immutable program bytes, independently sealed by the checkpoint. */
  programHash: string;
  program: ExecutionProgram;
  caseIds: string[];
  floorPaths: number;
  explorationEntries: number;
  plannedSteps: number;
  status: CoveragePlan["status"];
  /** The same named shortfalls the program carries, so a caller need not re-derive them. */
  limitations: PlanLimitation[];
}

/**
 * A program's limitations, whether or not it was written by a build that had them.
 *
 * An OLDER artifact has no `limitations` field. Reading `p.limitations ?? []` at each call
 * site would make "this plan predates the check" indistinguishable from "this plan was
 * checked and had nothing" — which is the exact confusion the block exists to remove — so
 * the absent case is named here once instead.
 */
export function programLimitations(program: ExecutionProgram | null | undefined): PlanLimitation[] {
  if (!program || !Array.isArray(program.limitations)) {
    return [
      {
        code: "plan-predates-limitation-reporting",
        what:
          "this execution program was written before the planner reported named limitations, so its " +
          "unassigned cases, unworded decisions and unusable route labels were never counted",
        count: 0,
      },
    ];
  }
  return program.limitations;
}

/** Bind W5's complete program bytes to a separately committed checkpoint hash. */
export async function w5ProgramAuthorityFailures(
  program: ExecutionProgram,
  checkpointProgramHash: string | null,
): Promise<string[]> {
  if (program.kind === LEGACY_EXECUTION_PROGRAM_KIND) {
    return program.seedPlan ? ["legacy execution program cannot carry W5 seed authority"] : [];
  }
  const failures: string[] = [];
  if (!program.seedPlan) failures.push("W5 execution program omits its required seed plan and census");
  const actualHash = `sha256:${await canonicalHash(program)}`;
  if (!checkpointProgramHash || checkpointProgramHash !== actualHash) {
    failures.push("W5 execution program is not exactly bound by the authoritative checkpoint");
  }
  return failures;
}

export const executionProgramHash = async (program: ExecutionProgram): Promise<string> =>
  `sha256:${await canonicalHash(program)}`;

export async function regeneratedSeedPlanFailures(
  program: ExecutionProgram,
  revision: ContractRevision,
  contractHash: string,
): Promise<string[]> {
  if (!program.seedPlan) return ["W5 seed plan is absent"];
  const floorPaths = JSON.parse(JSON.stringify(program.plan.floor.paths)) as PlannedPath[];
  for (const path of floorPaths) for (const decision of path.decisions) {
    delete decision.occurrence_id;
    delete decision.occurrence_index;
    delete decision.history_digest;
  }
  const expected = await buildSealedSeedPlan({
    revision,
    contractHash,
    floorPaths,
    witnessMap: (program.plan.floor.coverage.witness_map ?? {}) as Record<string, string>,
    baselineFloorSteps: program.plan.floor.paths.reduce((sum, path) => sum + path.steps, 0),
    limits: program.seedPlan.census.budget,
  });
  await stampPlannedOccurrenceIdentity(expected.alternatives.map((alternative) => alternative.path));
  return JSON.stringify(expected) === JSON.stringify(program.seedPlan)
    ? []
    : ["W5 seed plan and census do not exactly regenerate from sealed revision, floor, witness map, and persisted budget"];
}

/**
 * The planner's input row shape, out of the sealed revision.
 *
 * A `ScopedRequirement` is the CONTRACT's shape; a checklist obligation is the PLANNER's.
 * The two carry the same facts under different names, except for `stimulus` — the
 * document's own "ASK Q3 IF..." lines — which the planner uses to build its question
 * model and which the sealed type has no field for. Extraction therefore writes its
 * planner-native contract as a sidecar next to the revision, and this stage prefers it
 * when it is there; when it is not, the requirements are mapped field-for-field and the
 * plan says so in `contract_status`, rather than silently planning against a thinner
 * model and reporting the same confidence.
 */
/**
 * SEALED FACET NAME -> THE PLANNER'S CATEGORY NAME. The two vocabularies are not the same
 * vocabulary, and until this map existed the mismatch was silently absorbed.
 *
 * ============================ THE DEFECT, MEASURED ============================
 *
 * `plan-core.js#mineOptions` reads a question's ANSWER OPTIONS out of obligations whose
 * category is `option-set` or `instruction`, and nothing else. Extraction seals those rows
 * under `facet: "option-list"` (`src/extract/types.ts#CONSTRUCT_CLASSES`), this function
 * passed the facet through as the category unchanged, and so `"option-list" !== "option-set"`
 * meant EVERY option row was skipped. On the real sealed revision
 * `cr_c3929b37…` that is 63 of 194 requirements — every answer label the document states.
 *
 * The consequences were not subtle, and all three were being reported as something else:
 *   - `model.inference_gaps.questions_without_mined_options` listed ALL THIRTEEN questions;
 *   - 277 of 286 planned decisions had an EMPTY `select`, so a walk answered almost every
 *     screen by navigator discretion — which is also what made decision-to-screen binding
 *     ambiguous enough to mis-bind (D32);
 *   - a sealed route case naming `code: "1", label: null` could not be turned into anything
 *     clickable, because the code->label mapping lives in exactly the rows being skipped.
 *
 * The translation itself is not a new claim: `src/extract/expand.ts` already carries
 * `"option-list": "option-set"` for the case-kind vocabulary. This is the same fact, applied
 * on the other side of the same seam.
 *
 * ==================== WHY ONLY THESE FOUR, AND NO MORE ====================
 *
 * A pair is here only where the planner's use-sites were read and the semantics MATCH:
 *   - `option-list` -> `option-set`: `mineOptions` (option mining).
 *   - `validation`  -> `validation-rule`: `RULE_CATEGORIES`, the implicit single-answer
 *     threshold's obligation attribution, and rule-interaction weighting.
 *   - `terminate`   -> `terminal`: adds the terminal's DESTINATION as an observation point.
 *
 * `navigation`, `randomization`, `question` and `loop` are NOT mapped: the planner has no
 * category with those meanings, and inventing a near-neighbour would silently re-file a
 * requirement as a kind of rule it is not. They pass through under their own name and are
 * treated as an uncategorised obligation, exactly as before. `branch-source` is never a
 * mapping target because no obligation may carry it — `plan-core.js` synthesises it for a
 * question it has already proven gates another.
 *
 * ============ `skip-rule` -> `branch-outcome` IS DELIBERATELY ABSENT, AND MEASURED ============
 *
 * It is the obvious fifth pair and it is WRONG, which is why it is named here instead of
 * merely omitted. `plan-core.js` derives question ORDER from a `branch-outcome` obligation by
 * drawing an edge between consecutive question ids IN THE ORDER ITS STATEMENT MENTIONS THEM.
 * A skip rule states its DESTINATION first — "Ask Q2 only if code 2 was selected at Q1" — so
 * the edge drawn is Q2 -> Q1, backwards. Measured on the real sealed revision, adding this
 * pair alone reorders the survey from `Q1..Q9, S1, S2, C10, D1` to
 * `Q4, Q5, Q6, S1, S2, C10, D1, Q1, Q2, Q3, Q7, Q8, Q9` — a walk order the document does not
 * describe — while changing assigned cases, non-empty selects and coverage by exactly zero.
 * Routing belongs in the order graph, but through an edge that knows which end is the source;
 * a category rename cannot carry that, so it is not attempted.
 *
 * WHAT THE THREE PAIRS ABOVE COST AND BUY, on that same revision (`tools/` harness numbers):
 * Tier 1 is UNCHANGED — 22 floor paths, 286 decisions, 164 assigned cases, 194/194 obligations
 * witnessed — so no walk that carries a sealed case is affected either way. `option-list` is
 * currently inert on this particular extraction (its miner reads DOUBLE-quoted labels out of a
 * statement and this extraction writes them single-quoted, so nothing mines and nothing costs);
 * it is kept because the NAME is what was wrong and no correct mining can happen until it is.
 * `validation` and `terminate` populate the per-question rule list, which grows the TIER 2
 * queue from 23 entries to 37 (441 -> 651 estimated steps). Tier 2 may only add findings and
 * never moves the denominator, and the executor walks the floor first, so this trades run cost
 * for exploration breadth without putting any sealed case at risk.
 *
 * ASSUMPTION, STATED (CLAUDE.md: no silent reliance on a convention). This maps NAMES, not
 * prose, so it is language-independent. What it feeds is not: `mineOptions` reads option
 * labels out of English normative sentences ("… option with code 1 and label '…'"). Where
 * that does not hold the options simply do not mine, the question keeps zero options, and
 * `questions_without_mined_options` names it — a reported gap, never a wrong label.
 */
export const SEALED_FACET_TO_PLANNER_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  "option-list": "option-set",
  validation: "validation-rule",
  terminate: "terminal",
});

/** The planner-vocabulary category for a sealed facet; the facet itself when none is named. */
export function plannerCategory(facet: string): string {
  return SEALED_FACET_TO_PLANNER_CATEGORY[facet] ?? facet;
}

export function requirementToObligation(r: ScopedRequirement): PlannerObligation {
  const loose = r as unknown as Record<string, unknown>;
  const stimulus = Array.isArray(loose["stimulus"]) ? (loose["stimulus"] as string[]) : [];
  return {
    id: r.requirementLineageId,
    category: plannerCategory(typeof loose["category"] === "string" ? (loose["category"] as string) : r.facet),
    doc_quote: r.displayQuote,
    statement: r.normativeStatement,
    stimulus,
    expected_observable:
      typeof loose["expected_observable"] === "string" ? (loose["expected_observable"] as string) : "",
    browser_observable: r.testability === "browser-observable" ? "full" : "no",
    source_chunk: r.scope ?? null,
    requirement_version_id: r.requirementVersionId,
    assertion_status: r.assertionStatus,
  };
}

// ---------------------------------------------------------------------------
// QUESTION WORDING — the identity signal the driver binds on.
//
// THE DEFECT THIS EXISTS TO CLOSE. `browser/driver.ts` matched a planned decision to the
// screen in front of it by (a) the question TOKEN appearing in the rendered text and (b)
// option-label overlap. On the instrument under test the token appears NOWHERE in any
// screen's text, and the planner emitted 275 of 286 decisions with an EMPTY `select` — so
// binding ran on option-label overlap alone, for the eleven decisions that had any. That is
// not weak identity, it is NO identity: a decision for Q7 wanting "Can't remember" bound to
// a different screen that offered "Don't know / can't remember", was consumed there, and the
// real Q7 screen then took the OPPOSITE branch under `navigator-default` — while the case was
// marked exercised. A confident verification of a route the walk never took.
//
// The document says what each question SAYS, and the site renders it. That is the signal that
// exists on every survey rather than on the ones that print their ids, so it is the one the
// plan hands the driver.
//
// ASSUMPTION, STATED (CLAUDE.md: no silent reliance on a convention). "The site renders the
// document's question wording" is an assumption, not a law: a site may paraphrase, translate,
// or split a question across screens. WHERE IT DOES NOT HOLD the wording simply does not
// match, the driver REFUSES to bind, and the decision is reported as unbound — a named
// limitation, never a wrong answer. That is the degradation the old code did not have.
// ---------------------------------------------------------------------------

/**
 * The shortest quote that can serve as a question's identity.
 *
 * The sealed revision carries several `facet: "question"` rows per question, and most of them
 * are not the question: the real contract this was built against holds `"ASK ALL."`,
 * `"MULTI CODE."`, `"SINGLE CODE."`, `"OPEN TEXT."` and `"Q8. [OPTIONAL]"` under exactly the
 * same facet and scope as the wording. A three-word programmer instruction matches every
 * screen equally, which is worse than no signal at all, so it is not usable AS one.
 */
const MIN_WORDING_TOKENS = 4;

const wordingTokens = (s: string): string[] =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

export interface QuestionWording {
  /** The document's own wording, verbatim from `displayQuote`. */
  text: string;
  /** The requirement scope it was read from, e.g. `question:S2_coffee`. */
  scope: string;
}

export type QuestionWordingIndex = Map<string, QuestionWording>;

/**
 * INDEX THE DOCUMENT'S QUESTION WORDING, BY THE SCOPE ID IT WAS SEALED UNDER.
 *
 * Only `facet: "question"` rows are read. Widening to other facets is tempting and wrong:
 * `option-list` rows under `question:Q2` carry `"Keurig"`, `"Nespresso"` — option labels, which
 * would make a question's "wording" the text of one of its answers and bind Q2's decision to
 * any screen that happens to offer that answer. That is the same class of mistake as the defect
 * this closes.
 *
 * Where several usable quotes share a scope, the LONGEST wins (most tokens; ties broken
 * lexicographically so the choice is deterministic and identical on a replan).
 */
export function buildQuestionWordingIndex(revision: ContractRevision): QuestionWordingIndex {
  const index: QuestionWordingIndex = new Map();
  for (const r of revision.requirements ?? []) {
    if (r.facet !== "question") continue;
    if (typeof r.scope !== "string" || !r.scope.startsWith("question:")) continue;
    const qid = r.scope.slice("question:".length).trim();
    if (!qid) continue;
    const text = String(r.displayQuote ?? "").trim();
    if (wordingTokens(text).length < MIN_WORDING_TOKENS) continue;
    const held = index.get(qid);
    if (!held) {
      index.set(qid, { text, scope: r.scope });
      continue;
    }
    const a = wordingTokens(text).length;
    const b = wordingTokens(held.text).length;
    if (a > b || (a === b && text < held.text)) index.set(qid, { text, scope: r.scope });
  }
  return index;
}

/** Separators an extraction uses when it splits one question's id across sibling scopes. */
const SCOPE_SIBLING_SEPARATOR = /^[_\-.:]/;

export interface WordingResolution {
  wording: QuestionWording | null;
  /** `scope-exact:<scope>` / `scope-sibling:<scope>`, or why nothing resolved. */
  via: string;
}

/**
 * FIND A QUESTION'S WORDING, INCLUDING WHEN EXTRACTION FILED IT UNDER A SIBLING SCOPE.
 *
 * MEASURED, NOT HYPOTHETICAL. In the sealed revision this was built against, the decision for
 * `S2` has no `question:S2` wording at all — extraction fragmented that question across TWO
 * scopes and put the wording under `question:S2_coffee`, while `question:S2` kept three rows
 * that are not the question. An exact-key lookup returns nothing for S2, and an earlier
 * investigation into this very binder mis-reported a working resolution as broken for exactly
 * that reason. So the sibling search is part of the resolver, not a nicety.
 *
 * A SIBLING IS A SEPARATOR-SUFFIX RELATION, IN EITHER DIRECTION: `S2` ↔ `S2_coffee`. Requiring
 * the separator is what keeps `Q1` from claiming `Q10`'s wording and `D` from claiming `D1`'s —
 * a bare prefix test silently swaps two different questions' identities, which is the failure
 * mode this whole change exists to remove.
 *
 * MORE THAN ONE SIBLING REFUSES. Two candidate wordings mean at most one of them is this
 * question's, and picking one would be a guess.
 */
export function resolveQuestionWording(index: QuestionWordingIndex, questionId: string): WordingResolution {
  const qid = String(questionId ?? "").trim();
  if (!qid) return { wording: null, via: "no-question-id" };
  const exact = index.get(qid);
  if (exact) return { wording: exact, via: `scope-exact:${exact.scope}` };

  const children: string[] = [];
  const parents: string[] = [];
  for (const key of index.keys()) {
    if (key === qid) continue;
    if (key.startsWith(qid) && SCOPE_SIBLING_SEPARATOR.test(key.slice(qid.length))) children.push(key);
    else if (qid.startsWith(key) && SCOPE_SIBLING_SEPARATOR.test(qid.slice(key.length))) parents.push(key);
  }
  // A child scope (`S2_coffee` for `S2`) is the more specific statement of the same question,
  // so it is preferred; a parent is consulted only when no child exists.
  const candidates = children.length > 0 ? children : parents;
  if (candidates.length === 0) return { wording: null, via: "no-wording-in-contract" };
  if (candidates.length > 1) {
    return { wording: null, via: `ambiguous-sibling-scopes:${[...candidates].sort().join(",")}` };
  }
  const key = candidates[0]!;
  const hit = index.get(key)!;
  return { wording: hit, via: `scope-sibling:${hit.scope}` };
}

/**
 * STAMP THE WORDING ONTO EVERY PLANNED DECISION. Additive: no existing field is touched, and
 * `pathSignature` does not hash these keys, so no path identity moves.
 *
 * Runs BEFORE `materializeCasePaths`, so every per-case clone inherits the wording with the
 * rest of the decision and there is no second place where a decision can acquire an identity.
 */
export function stampQuestionWording(
  carriers: Array<{ decisions?: PlannedDecision[] }>,
  index: QuestionWordingIndex,
): { stamped: number; decisions: number; unresolved: Array<{ question: string; via: string }> } {
  let stamped = 0;
  let decisions = 0;
  const unresolvedByQuestion = new Map<string, string>();
  for (const carrier of carriers) {
    for (const d of carrier?.decisions ?? []) {
      decisions += 1;
      const resolved = resolveQuestionWording(index, String(d.question ?? ""));
      if (!resolved.wording) {
        unresolvedByQuestion.set(String(d.question ?? ""), resolved.via);
        continue;
      }
      d.question_text = resolved.wording.text;
      d.question_text_source = resolved.via;
      stamped += 1;
    }
  }
  return {
    stamped,
    decisions,
    unresolved: [...unresolvedByQuestion.entries()]
      .map(([question, via]) => ({ question, via }))
      .sort((a, b) => (a.question < b.question ? -1 : a.question > b.question ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// SURVIVAL HINTS — the plan's documented screen-out triggers, handed to the walker's
// FILLERS as steering input.
//
// THE DEFECT THIS EXISTS TO CLOSE. `plan-core.js#defaultAnswer` already avoids documented
// terminating labels when it can name an answer — but a `default:navigator-discretion`
// decision has an EMPTY select, and a screen no decision binds has nothing at all, so the
// DRIVER answers both with its position-1 default, terminate-blind. Measured on the reach
// baseline (2026-08-10/11): s2-clean died at S3 because position 1, "Market research", is
// the questionnaire's documented disqualifying industry. The trigger data was in the plan
// artifact the whole time (`model.questions[].options[].terminates`, `questions[].terminates`,
// `model.terminals`); nothing carried it to the walker.
//
// THE CHANNEL IS ADDITIVE AND EVIDENCE-INVISIBLE, by construction:
//   - per-decision `avoid_labels` and per-path `survival_hints` are fields `pathSignature`
//     does not hash (the `question_text` precedent, plan-core.d.ts:44-49) and
//     `isConstrainingDecision` does not read — stamping moves no path identity and no
//     coverage gate;
//   - the driver consumes them ONLY to pick among its own navigator-default fillers
//     (`browser/driver.ts#survivalAvoidLabels`); they never enter `select`, so they can
//     never become `requestedButNotOffered` (missing-option evidence);
//   - a hint can only re-order which invented answer is clicked — reach, never verdict.
//
// Numeric screen-outs ("terminate if age < 18") are NOT mined by extraction at all
// (`mineThresholds` reads character/selection/scale bounds only), so no hint can exist for
// them — that gap belongs to the bounded screen-out retry, not to this stamp.
// ---------------------------------------------------------------------------

/** One question's documented terminating labels, stamped onto a path for unbound screens. */
export interface SurvivalHintStamp {
  question: string;
  /** The document's wording, when a decision on the same carrier already carries it. */
  question_text?: string;
  avoid_labels: string[];
  /** Labels the document states CONTINUE the survey — same channel, same evidence boundary. */
  prefer_labels?: string[];
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

/**
 * A sealed route case's destination, read from TYPED fields only. This exists because the
 * prose miners above it starve together: `buildTerminals` resolves a trigger only against a
 * question's MINED option list, so a question whose options never mined (measured on the
 * 2026-08-16 live run: S10 — 9 sealed terminate routes, 0 mined options, 0 hints stamped,
 * every navigator-default walk screened out) contributes nothing, even though the sealed
 * contract states the trigger verbatim in `routeAnswer.label`. A route case IS a resolved
 * trigger: question = `targetQuestionId`, answer = `routeAnswer.label`, destination = the
 * requirement's facet — `terminate` (a documented screen-out) or `skip-rule` (a documented
 * continue). No prose is read; a route under any OTHER facet is skipped, never guessed.
 */
export interface SealedRouteDestination {
  question: string;
  label: string;
  kind: "terminate" | "continue";
}

export function sealedRouteDestinations(revision: {
  requirements: ScopedRequirement[];
  facetInstances: FacetInstance[];
}): SealedRouteDestination[] {
  const facetByLineage = new Map<string, string>();
  for (const r of revision.requirements) facetByLineage.set(r.requirementLineageId, r.facet);
  const out: SealedRouteDestination[] = [];
  for (const fi of revision.facetInstances) {
    if (fi.case?.kind !== "route") continue;
    const question = nonEmpty(fi.targetQuestionId);
    const label = nonEmpty(fi.case.routeAnswer?.label ?? null);
    if (!question || !label) continue;
    const facet = facetByLineage.get(fi.requirementLineageId);
    if (facet === "terminate") out.push({ question, label, kind: "terminate" });
    else if (facet === "skip-rule") out.push({ question, label, kind: "continue" });
  }
  return out;
}

/**
 * EVERY documented terminate trigger the model states at label level, per question — plus
 * the screen-outs that could NOT be resolved to a label, which are the stamp's own named
 * shortfall. Reads the three places `plan-core.js` emits trigger data (options[].terminates,
 * questions[].terminates, model.terminals) and dedupes; `buildTerminals` already folds the
 * first two into each other, so the union is defensive, not doctrinal. Sealed route
 * destinations are the fourth source and the only TYPED one: their terminate labels join
 * `avoid`, their continue labels build `prefer` — minus any label the same question also
 * documents as terminating, because a contract that states both ways is a conflict to
 * sit out, not a hint to gamble on.
 */
export function survivalAvoidIndex(
  model: unknown,
  routes: readonly SealedRouteDestination[] = [],
): {
  avoid: Map<string, string[]>;
  prefer: Map<string, string[]>;
  unstampable: Array<{ terminal: string; question: string | null; why: string }>;
} {
  const avoid = new Map<string, string[]>();
  const put = (q: string, label: string): void => {
    const held = avoid.get(q) ?? [];
    if (!held.includes(label)) held.push(label);
    avoid.set(q, held);
  };
  const m = (model ?? {}) as { questions?: unknown; terminals?: unknown };
  for (const row of Array.isArray(m.questions) ? m.questions : []) {
    const q = (row ?? {}) as { id?: unknown; options?: unknown; terminates?: unknown };
    const qid = nonEmpty(q.id);
    if (!qid) continue;
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const opt = (o ?? {}) as { text?: unknown; terminates?: unknown };
      const label = nonEmpty(opt.text);
      // The emitted model coerces this to a boolean (`terminates: !!o.terminates`); truthy
      // is accepted so a pre-coercion model object stamps identically.
      if (label && opt.terminates) put(qid, label);
    }
    for (const t of Array.isArray(q.terminates) ? q.terminates : []) {
      const label = nonEmpty((t as { answer?: unknown } | null)?.answer);
      if (label) put(qid, label);
    }
  }
  const unstampable: Array<{ terminal: string; question: string | null; why: string }> = [];
  for (const row of Array.isArray(m.terminals) ? m.terminals : []) {
    const t = (row ?? {}) as { id?: unknown; kind?: unknown; trigger?: unknown };
    // Completion endpoints are successful ends, not screen-outs; nothing to avoid there.
    if (t.kind !== "screen-out") continue;
    const trigger = (t.trigger ?? null) as { question?: unknown; answers?: unknown } | null;
    const tq = trigger ? nonEmpty(trigger.question) : null;
    const answers = (trigger && Array.isArray(trigger.answers) ? trigger.answers : [])
      .map(nonEmpty)
      .filter((x): x is string => x !== null);
    if (!tq || answers.length === 0) {
      unstampable.push({
        terminal: nonEmpty(t.id) ?? "TERM-?",
        question: tq,
        why: trigger
          ? "the screen-out's trigger names no usable answer label"
          : "the document states a screen-out but no triggering answer could be resolved to a label",
      });
      continue;
    }
    for (const a of answers) put(tq, a);
  }
  for (const r of routes) if (r.kind === "terminate") put(r.question, r.label);
  const prefer = new Map<string, string[]>();
  for (const r of routes) {
    if (r.kind !== "continue") continue;
    if ((avoid.get(r.question) ?? []).includes(r.label)) continue;
    const held = prefer.get(r.question) ?? [];
    if (!held.includes(r.label)) held.push(r.label);
    prefer.set(r.question, held);
  }
  return { avoid, prefer, unstampable };
}

/**
 * STAMP SURVIVAL HINTS ONTO EVERY ELIGIBLE CARRIER. Additive and signature-neutral, and it
 * runs in the SAME SEAM as `stampQuestionWording` — after wording (so path hints can carry
 * it), BEFORE `materializeCasePaths` (so every per-case clone inherits the stamps and there
 * is still exactly one place a decision acquires anything).
 *
 * THREE REFUSALS, each a thing this pass could do and must not:
 *   - a carrier with `terminated_at` set is a walk that INTENDS its termination — the plan
 *     chose a documented trigger on purpose; steering its fillers would fight the experiment;
 *   - a terminal-adjacency probe whose `adjacency.side` is `just-triggers` exists to take
 *     the terminating answer; same reason, stronger form;
 *   - a decision carrying `case_action` is sealed stimulus and is never written to
 *     (`materializeCasePaths` documents why nothing may rewrite it). Clones minted AFTER
 *     this pass inherit stamps passively, exactly as they inherit `question_text`.
 */
export function stampSurvivalHints(
  carriers: Array<{ decisions?: PlannedDecision[]; [k: string]: unknown }>,
  model: unknown,
  routes: readonly SealedRouteDestination[] = [],
): {
  decisionsStamped: number;
  pathsStamped: number;
  /** question id -> the labels stamped, for the report and the tests. */
  questions: Array<{ question: string; avoid_labels: string[]; prefer_labels?: string[] }>;
  /** Documented screen-outs this pass could NOT steer around, each with the reason. */
  unstampable: Array<{ terminal: string; question: string | null; why: string }>;
} {
  const { avoid, prefer, unstampable } = survivalAvoidIndex(model, routes);
  // One row per hinted question, avoid-map order first, prefer-only questions after —
  // both insertion-ordered from deterministic inputs, so a replan is byte-stable.
  const hintedQuestions: string[] = [...avoid.keys()];
  for (const q of prefer.keys()) if (!hintedQuestions.includes(q)) hintedQuestions.push(q);
  let decisionsStamped = 0;
  let pathsStamped = 0;
  for (const carrier of hintedQuestions.length > 0 ? carriers : []) {
    if (!carrier || typeof carrier !== "object") continue;
    if (carrier["terminated_at"] != null) continue;
    const adjacency = carrier["adjacency"] as { side?: unknown } | null | undefined;
    if (adjacency && adjacency.side === "just-triggers") continue;
    const decisions = Array.isArray(carrier.decisions) ? carrier.decisions : [];
    const wordingByQuestion = new Map<string, string>();
    for (const d of decisions) {
      const q = nonEmpty(d?.question);
      if (q && typeof d.question_text === "string" && !wordingByQuestion.has(q)) {
        wordingByQuestion.set(q, d.question_text);
      }
    }
    for (const d of decisions) {
      if (!d || d.case_action) continue;
      const q = String(d.question ?? "");
      const labels = avoid.get(q);
      const liked = prefer.get(q);
      if ((!labels || labels.length === 0) && (!liked || liked.length === 0)) continue;
      if (labels && labels.length > 0) d.avoid_labels = [...labels];
      if (liked && liked.length > 0) d.prefer_labels = [...liked];
      decisionsStamped += 1;
    }
    // Path-level hints cover the screens NO decision binds; the driver matches them by
    // offered-label overlap only. Emitted in model question order, so a replan is byte-stable.
    const hints: SurvivalHintStamp[] = hintedQuestions.map((question) => ({
      question,
      ...(wordingByQuestion.has(question) ? { question_text: wordingByQuestion.get(question)! } : {}),
      avoid_labels: [...(avoid.get(question) ?? [])],
      ...(prefer.has(question) ? { prefer_labels: [...prefer.get(question)!] } : {}),
    }));
    if (hints.length > 0) {
      carrier["survival_hints"] = hints;
      pathsStamped += 1;
    }
  }
  return {
    decisionsStamped,
    pathsStamped,
    questions: hintedQuestions.map((question) => ({
      question,
      avoid_labels: [...(avoid.get(question) ?? [])],
      ...(prefer.has(question) ? { prefer_labels: [...prefer.get(question)!] } : {}),
    })),
    unstampable,
  };
}

export function contractFromRevision(revision: ContractRevision): PlannerContract {
  return {
    obligations: revision.requirements.map(requirementToObligation),
    ambiguities: revision.requirements
      .filter((r) => r.assertionStatus === "ambiguous")
      .map((r) => ({ id: `AMB-${r.requirementLineageId}`, statement: r.normativeStatement })),
    unverifiable_from_browser: revision.requirements
      .filter((r) => r.testability === "not-browser-observable")
      .map((r) => ({ id: r.requirementLineageId, reason: r.notBrowserObservableReason ?? "" })),
  };
}

/**
 * The planner-native sidecar, when extraction wrote one.
 *
 * IT IS NOT AN ALTERNATIVE DENOMINATOR. It is accepted only for the rows the sealed
 * revision already carries: every obligation is matched to a sealed requirement by
 * lineage id, anything the seal does not carry is DROPPED with a warning, and anything
 * the seal carries that the sidecar omits is added back from the revision. The plan can
 * therefore be richer than the sealed type, and still cannot be wider than it.
 */
export async function loadPlannerSidecar(
  env: Env,
  runId: string,
): Promise<{ contract: PlannerContract; source: string } | null> {
  const key = plannerSidecarKey(runId);
  const obj = await env.EVIDENCE.get(key);
  if (!obj) return null;
  try {
    const parsed = (await obj.json()) as PlannerContract;
    if (!parsed || !Array.isArray(parsed.obligations) || parsed.obligations.length === 0) return null;
    return { contract: parsed, source: key };
  } catch {
    return null;
  }
}

function reconcileWithSeal(
  sidecar: PlannerContract,
  revision: ContractRevision,
): { contract: PlannerContract; warnings: string[] } {
  const warnings: string[] = [];
  const sealed = new Map(revision.requirements.map((r) => [r.requirementLineageId, r]));
  const kept: PlannerObligation[] = [];
  const seen = new Set<string>();
  for (const o of sidecar.obligations) {
    const lineage = typeof o["requirement_lineage_id"] === "string" ? (o["requirement_lineage_id"] as string) : o.id;
    if (!sealed.has(lineage)) {
      warnings.push(
        `planner sidecar carries obligation "${o.id}" which the sealed contract revision does not: dropped. ` +
          `The denominator is the seal, and a plan may not widen it.`,
      );
      continue;
    }
    seen.add(lineage);
    kept.push({ ...o, id: lineage });
  }
  for (const [lineage, r] of sealed) {
    if (seen.has(lineage)) continue;
    warnings.push(`planner sidecar omits sealed requirement ${lineage}: planned from the sealed row instead.`);
    kept.push(requirementToObligation(r));
  }
  return {
    contract: {
      ...sidecar,
      obligations: kept,
    },
    warnings,
  };
}

/**
 * Build the plan and the execution program. Deterministic; makes no model call and no
 * browser call. Writes ONE artifact (the program, with the full plan embedded) and
 * returns what the checkpoint needs.
 */
export async function planStage(
  env: Env,
  args: { runId: string; contractRevisionId: string; planRevisionId: string; surveyUrl: string },
): Promise<PlanStageResult> {
  const revision = await getContractRevision(env, args.contractRevisionId);
  if (!revision) {
    throw new Error(
      `plan: sealed contract revision ${args.contractRevisionId} is not readable. Planning against a contract ` +
        `that cannot be re-read would mint a denominator nobody can audit.`,
    );
  }

  const sidecar = await loadPlannerSidecar(env, args.runId);
  let contract: PlannerContract;
  let source: string;
  let contractStatus: string;
  const warnings: string[] = [];
  if (sidecar) {
    const rec = reconcileWithSeal(sidecar.contract, revision);
    contract = rec.contract;
    warnings.push(...rec.warnings);
    source = sidecar.source;
    contractStatus = "authoritative";
  } else {
    contract = contractFromRevision(revision);
    source = `contract-revision:${args.contractRevisionId}`;
    contractStatus = "authoritative";
    warnings.push(
      "no planner-native checklist sidecar was found, so the plan was built by mapping the sealed " +
        "ScopedRequirements. Requirements carry no `stimulus` lines, so the inferred question model is " +
        "thinner than it would be from a checklist and more obligations may land in `uncovered`.",
    );
  }

  // Read as loose config so the planner's two caps can be tuned per deployment without
  // this stage owning a change to the shared Env interface.
  const cfg = env as unknown as { PLAN_MAX_QUEUE?: string; PLAN_PER_CLASS_CAP?: string };
  const plan = planFromContract(contract, {
    run: args.runId,
    source,
    contractStatus,
    maxQueue: num(cfg.PLAN_MAX_QUEUE, 400),
    perClassCap: num(cfg.PLAN_PER_CLASS_CAP, 60),
  });

  // ---- identity: stamp the document's wording on every decision, before anything clones ----
  //
  // Order matters. `materializeCasePaths` deep-clones a floor path per typed case, so stamping
  // here means every clone inherits the wording and there is exactly ONE place a decision can
  // acquire an identity. The exploration queue is stamped too: a Tier-2 walk drives the same
  // driver and would otherwise bind by option-label overlap alone.
  const wordingIndex = buildQuestionWordingIndex(revision);
  const wording = stampQuestionWording([...plan.floor.paths, ...plan.exploration.queue], wordingIndex);

  // ---- survival: stamp documented screen-out triggers, in the SAME pre-clone seam ----
  //
  // After wording (so path hints can carry `question_text`), before `materializeCasePaths`
  // (so per-case clones inherit). Hints are INPUT, never EVIDENCE: `avoid_labels` /
  // `survival_hints` are unhashed, gate-invisible fields the driver reads only to pick
  // among its own navigator-default fillers. See `stampSurvivalHints`.
  const survival = stampSurvivalHints(
    [...plan.floor.paths, ...plan.exploration.queue],
    plan.model,
    sealedRouteDestinations(revision),
  );

  // ---- assignment: mandatory execution case -> the floor path that witnesses it ----
  const witnessMap: Record<string, string> = (plan.floor.coverage.witness_map ?? {}) as Record<string, string>;
  const materialized = materializeCasePaths(plan.floor.paths, revision.facetInstances, witnessMap);
  plan.floor.paths = materialized.paths;
  warnings.push(...materialized.warnings);
  recomputeFloorEstimate(plan);
  const floor = materialized.assignments;
  const unassigned = materialized.unassignedCaseIds;

  // ---- W5 seeds: alternatives for the SAME sealed cases, never new denominator rows ----
  const sealedIdentity = await revisionIdentity(revision);
  const seedCfg = env as unknown as {
    SEED_CANDIDATE_CAP?: string;
    SEED_PER_QUESTION_CAP?: string;
    SEED_PER_BASE_PATH_CAP?: string;
    SEED_ATTEMPT_CAP?: string;
    SEED_STEP_CAP?: string;
  };
  const baselineFloorSteps = plan.floor.paths.reduce((sum, path) => sum + path.steps, 0);
  const seedPlan = await buildSealedSeedPlan({
    revision,
    contractHash: sealedIdentity.contractHash,
    floorPaths: plan.floor.paths,
    witnessMap,
    baselineFloorSteps,
    limits: {
      candidateCap: num(seedCfg.SEED_CANDIDATE_CAP, 256),
      perQuestionCap: num(seedCfg.SEED_PER_QUESTION_CAP, 8),
      perBasePathCap: num(seedCfg.SEED_PER_BASE_PATH_CAP, 6),
      attemptCap: num(seedCfg.SEED_ATTEMPT_CAP, 32),
      stepCap: num(seedCfg.SEED_STEP_CAP, Math.min(640, 2 * baselineFloorSteps)),
    },
  });
  await stampPlannedOccurrenceIdentity([
    ...plan.floor.paths,
    ...plan.exploration.queue,
    ...seedPlan.alternatives.map((alternative) => alternative.path),
  ]);

  // ---- report what the typed-case materialization above compiled ----
  //
  // `materializeCasePaths` is the ONLY place typed cases reach a decision. It clones the
  // witness path once per actionable sealed case, binds exactly one stimulus to the clone,
  // applies the union/replace select semantics documented on that function, and re-stamps
  // the clone's signature over its own enriched decisions. All of that lives next to the
  // code that performs it, so a reader is never told a property holds somewhere else.
  if (materialized.enrichedRoute + materialized.enrichedBoundary > 0) {
    warnings.push(
      `typed-case materialization: ${materialized.enrichedRoute} independent route path(s) + ` +
        `${materialized.enrichedBoundary} independent boundary path(s) compiled from the sealed cases`,
    );
  }
  const caseOrder = materialized.caseOrder;

  // ---- the named, counted shortfalls; emitted whether or not any of them bit ----
  const limitations: PlanLimitation[] = [
    {
      code: PLAN_LIMITATION_CODES.unassignedCases,
      what:
        `${unassigned.length} of ${caseOrder.length} sealed execution case(s) are assigned to NO walk, so nothing ` +
        `in this run will exercise them. They stay in the denominator and will be bucketed as not-executed; the ` +
        `plan cannot fix them because the shortfall is in the sealed stimulus, not in the planning.`,
      count: unassigned.length,
      caseIds: [...unassigned],
    },
    {
      code: PLAN_LIMITATION_CODES.wordingMissing,
      what:
        `${wording.decisions - wording.stamped} of ${wording.decisions} planned decision(s) carry no question ` +
        `wording from the contract, so on a survey that also prints no question id the driver cannot identify ` +
        `their screen and will report them unbound rather than answer the wrong one.`,
      count: wording.decisions - wording.stamped,
      questionIds: wording.unresolved.map((u) => `${u.question} (${u.via})`),
    },
    {
      code: PLAN_LIMITATION_CODES.routingConditionLabels,
      what:
        `${materialized.routingConditionSelects.length} sealed route answer(s) are routing CONDITIONS about ` +
        `another question rather than an option label on their own, so no option can ever match them. They were ` +
        `kept verbatim in case_action and removed from what the driver clicks.`,
      count: materialized.routingConditionSelects.length,
      caseIds: materialized.routingConditionSelects.map((r) => r.facetInstanceId),
    },
    {
      code: PLAN_LIMITATION_CODES.unresolvedRouteCodes,
      what:
        `${materialized.unresolvedRouteCodes.length} sealed route case(s) leave the driver NOTHING TO CLICK: the ` +
        `answer is given as a code, and no other sealed case on the same question names that code with a label, so ` +
        `the route will not be driven. ${materialized.resolvedRouteLabels.length} other(s) WERE resolved that way. ` +
        // THE ROWS OVERLAP, SO THE OVERLAP IS COMPUTED AND SAID. A case whose "label" was a
        // routing condition is stripped by `routingConditionLabels` AND then fails code
        // resolution here: one case, two rows, and a reader who adds the counts double-books it.
        `${
          materialized.unresolvedRouteCodes.filter((r) =>
            materialized.routingConditionSelects.some((c) => c.facetInstanceId === r.facetInstanceId),
          ).length
        } of these are ALSO counted under ${PLAN_LIMITATION_CODES.routingConditionLabels} — the same case seen from ` +
        `two sides — so the two rows must not be added together. ` +
        `No label was invented: the contract's unscoped option lists claim the same codes for several different ` +
        `questions, so reading one would have been a guess with a wrong answer as its likely outcome.`,
      count: materialized.unresolvedRouteCodes.length,
      caseIds: materialized.unresolvedRouteCodes.map((r) => r.facetInstanceId),
      questionIds: [...new Set(materialized.unresolvedRouteCodes.map((r) => `${r.question} (code ${r.code})`))].sort(),
    },
    {
      code: PLAN_LIMITATION_CODES.survivalHintsUnstampable,
      what:
        `${survival.unstampable.length} documented screen-out(s) name no answer label this plan could stamp as a ` +
        `survival hint, so the walker's default fillers cannot steer around them and a walk may still end there. ` +
        `${survival.pathsStamped} path(s) did receive hints covering ${survival.questions.length} question(s); ` +
        `zero here means every documented screen-out was stamped, not that nobody looked.`,
      count: survival.unstampable.length,
      questionIds: survival.unstampable.map((u) => `${u.terminal}${u.question ? ` (${u.question})` : ""} — ${u.why}`),
    },
    {
      code: PLAN_LIMITATION_CODES.seedAuthorityWithheld,
      what:
        `${seedPlan.census.withheldRows} of ${seedPlan.census.authorityRows} sealed option-set case(s) could not ` +
        `authorize a seed. Only an entailed typed case's own asserted payload is authority; siblings, planner-model ` +
        `labels, ambiguous/negative rows and document-silent values are never used.`,
      count: seedPlan.census.withheldRows,
      caseIds: seedPlan.census.withheld.map((row) => row.caseId),
    },
    {
      code: PLAN_LIMITATION_CODES.seedCardinalityWithheld,
      what:
        `${seedPlan.census.withheldCombinationCount} pairwise option combination(s) were withheld because positive ` +
        `option membership does not state that the control accepts multiple selections. These combinations remain ` +
        `ineligible until extraction seals cardinality/multiselect semantics.`,
      count: seedPlan.census.withheldCombinationCount,
    },
    {
      code: PLAN_LIMITATION_CODES.seedBudgetExhausted,
      what:
        `${seedPlan.census.droppedCount} of ${seedPlan.census.candidateCount} authorized singleton seed candidate(s) ` +
        `were not selected under the persisted caps; ${seedPlan.census.selectedCount} were selected and ` +
        `${seedPlan.census.residualCaseIds.length} option-set case(s) retain no selected alternative. The sealed ` +
        `case denominator is unchanged.`,
      count: seedPlan.census.droppedCount,
      caseIds: seedPlan.census.residualCaseIds,
      pathIds: seedPlan.census.dropped.map((row) => row.alternativeId),
    },
    // THE FOUR CAUSES BEHIND `unassignedCases`, counted apart. The aggregate row above says how
    // many walks are missing; these say what to fix, and each is emitted at zero so a cause that
    // did not bite stays distinguishable from a cause nobody checked for.
    ...(
      [
        [PLAN_LIMITATION_CODES.caseWithoutTargetQuestion, "name no targetQuestionId, so no screen can be identified to apply their stimulus to"],
        [PLAN_LIMITATION_CODES.caseWithoutStimulus, "name a target question but state no answer or input value, so there is nothing to drive"],
        [PLAN_LIMITATION_CODES.caseTargetNotOnWitnessPath, "target a question their witness path does not answer exactly once"],
        [PLAN_LIMITATION_CODES.caseWithoutWitnessPath, "belong to a requirement no floor path witnesses"],
      ] as const
    ).map(([code, what]) => {
      const rows = materialized.unassignedByCause.filter((u) => u.cause === code);
      return {
        code,
        what: `${rows.length} sealed execution case(s) reach no walk because they ${what}.`,
        count: rows.length,
        caseIds: rows.map((r) => r.facetInstanceId),
      };
    }),
    // Capability accounting is computed from the exact paths this artifact will hand to the
    // executor. These rows are present at zero too, so absence can never mean "supported".
    ...probeCapabilityLimitations(plan),
  ];

  const program: ExecutionProgram = {
    kind: EXECUTION_PROGRAM_KIND,
    runId: args.runId,
    planRevisionId: args.planRevisionId,
    contractRevisionId: args.contractRevisionId,
    contractHash: (plan.denominator.contract_hash ?? null) as string | null,
    generatedAt: new Date().toISOString(),
    surveyUrl: args.surveyUrl,
    floor,
    exploration: plan.exploration.queue.map((e) => ({
      pathId: e.id,
      cls: e.class,
      priority: e.priority_score,
      mandatory: e.mandatory === true,
    })),
    caseOrder,
    unassignedCaseIds: unassigned,
    seedPlan,
    limitations,
    coverage: {
      obligations: plan.floor.coverage.obligations,
      witnessedByFloor: plan.floor.coverage.witnessed_by_floor,
      coversAllObligations: plan.floor.coverage.covers_all_obligations,
      coversAllAfterMandatoryExploration: plan.floor.coverage.covers_all_after_mandatory_exploration === true,
      uncovered: (plan.floor.coverage.uncovered ?? []).map((u) => ({
        obligation: String(u.obligation),
        disposition: String(u.disposition),
      })),
    },
    // The limitations block above is the reportable form; these lines keep the same facts in
    // the prose channel so a reader of either surface sees the shortfall named once more.
    warnings: [
      ...limitations.filter((l) => l.count > 0).map((l) => `LIMITATION ${l.code}: ${l.what}`),
      ...warnings,
      ...(plan.warnings ?? []),
    ],
    plan,
  };

  const programBytes = JSON.stringify(program);
  const programHash = await executionProgramHash(program);
  await env.EVIDENCE.put(planKey(args.runId, args.planRevisionId), programBytes, {
    httpMetadata: { contentType: "application/json" },
  });

  return {
    planRevisionId: args.planRevisionId,
    programHash,
    program,
    caseIds: caseOrder,
    floorPaths: floor.length,
    explorationEntries: program.exploration.length + seedPlan.census.selectedCount,
    plannedSteps: (plan.estimate?.total?.steps ?? 0) + seedPlan.census.selectedEstimatedSteps,
    status: plan.status,
    limitations,
  };
}

/** Re-read the program a previous step (or a previous instance) wrote. */
export async function loadProgram(env: Env, runId: string, planRevisionId: string): Promise<ExecutionProgram | null> {
  const obj = await env.EVIDENCE.get(planKey(runId, planRevisionId));
  if (!obj) return null;
  try {
    const parsed = (await obj.json()) as ExecutionProgram;
    const failures = executionProgramFailures(parsed, runId, planRevisionId);
    if (failures.length > 0) throw new Error(failures.join("; "));
    const revision = await getContractRevision(env, parsed.contractRevisionId);
    if (!revision) throw new Error(`sealed contract revision ${parsed.contractRevisionId} is missing`);
    const identity = await revisionIdentity(revision);
    const loaded = await loadCheckpoint(env, runId);
    const authorityFailures = await w5ProgramAuthorityFailures(
      parsed,
      loaded?.checkpoint.execution?.seedExecution?.programHash ?? null,
    );
    if (authorityFailures.length > 0) throw new Error(authorityFailures.join("; "));
    if (parsed.kind === EXECUTION_PROGRAM_KIND) {
      const regenerationFailures = await regeneratedSeedPlanFailures(parsed, revision, identity.contractHash);
      if (regenerationFailures.length > 0) throw new Error(regenerationFailures.join("; "));
    }
    for (const alternative of parsed.seedPlan?.alternatives ?? []) {
      const certificateFailures = await sealedSeedCertificateFailures(alternative.certificate, revision, identity.contractHash);
      if (certificateFailures.length > 0) {
        throw new Error(`seed alternative ${alternative.alternativeId} certificate refused: ${certificateFailures.join("; ")}`);
      }
      const selectedLabels = alternative.certificate.selectedOrdinals.map(
        (ordinal) => alternative.certificate.assertedOptions[ordinal]?.label,
      );
      const decisions = alternative.path.decisions.filter(
        (decision) => decision.seed_certificate_hash === alternative.certificate.certificateHash,
      );
      if (decisions.length !== 1 || JSON.stringify(decisions[0]!.select) !== JSON.stringify(selectedLabels)) {
        throw new Error(`seed alternative ${alternative.alternativeId} decision does not equal its certified selection`);
      }
    }
    const sealedIds = revision.facetInstances.map((fi) => fi.facetInstanceId);
    assertExactCasePermutation(sealedIds, parsed.caseOrder, "caseOrder");
    assertExactCasePermutation(
      sealedIds,
      [...parsed.floor.flatMap((a) => a.caseIds), ...parsed.unassignedCaseIds],
      "assignments + unassignedCaseIds",
    );
    return parsed;
  } catch (err) {
    throw new Error(
      `execution program ${planRevisionId} for run ${runId} is corrupt or stale: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * MATERIALIZE INDEPENDENT WITNESSES FOR ACTIONABLE ROUTE/BOUNDARY CASES.
 *
 * Pure, deterministic, model-free. This is the ONLY place a sealed typed case reaches a
 * planned decision — there is no second enrichment pass, and any safety property claimed
 * for typed-case driving must be readable here.
 *
 * The deterministic planner's paths remain requirement-level coverage proofs. They are
 * retained as base walks for non-typed cases, while each typed case receives a deep clone
 * carrying exactly one sealed stimulus and one assignment. No clone can overwrite another.
 *
 * SELECT-LIST SEMANTICS. `decision.select` is what the driver actually clicks
 * (`src/browser/driver.ts`), so what happens to it is behaviour, not bookkeeping:
 *
 *  - ROUTE on a SINGLE-SELECT question REPLACES the select list with the typed label.
 *    Appending would click both the planner's default and the typed answer; for a radio
 *    the last click wins by DOM order, which may not be the typed answer.
 *  - ROUTE on a MULTI-SELECT question UNIONS the typed label into the planner's
 *    selection. The planner chose a SET to keep downstream questions reachable ("select
 *    A and B so Q8's base is met"); replacing it with the single typed label would drop
 *    the other selections, skip the downstream question, and the verifier would report a
 *    CONTRADICTED destination the survey never actually produced — a fabricated defect
 *    verdict against a correct survey. Union is idempotent: a typed label the planner
 *    already selected is not added twice.
 *  - A code-only route (`label === null`) puts nothing in `select`; the exact target
 *    lives in `case_action`. On a multi-select base the planner's gating selections are
 *    KEPT rather than cleared, for the same downstream-reachability reason.
 *  - BOUNDARY cases set the text_entry value or the empty-input probe action.
 *
 * ASSUMPTION, STATED (CLAUDE.md: no silent reliance on a convention). Multi-select is
 * detected as `select.length > 1`, because `PlannedDecision` carries no cardinality flag
 * and the planner only ever picks one label for a radio. WHERE IT DOES NOT HOLD: a
 * multi-select question on which the planner happened to pick exactly ONE gating label is
 * indistinguishable from a radio here and takes the REPLACE branch, so that single gating
 * selection can still be dropped. Closing that needs a cardinality flag on
 * `PlannedDecision` from plan-core, which this function cannot mint without inventing it.
 *
 * NO SILENT LAST-WRITE-WINS. Two cases naming different answers to the SAME single-select
 * question do not contend for one decision: each gets its own clone and its own walk, so
 * both are driven and neither is lost. That makes a `conflicts[]` report unnecessary here
 * rather than merely omitted — the per-case clone is a stronger guarantee than naming the
 * loss would be, and reporting "only the first can be driven" would now be false. D20
 * tests this property directly.
 *
 * A case whose question has no decision — or more than one — in its assigned path is
 * never guessed at: it is pushed to `unassignedCaseIds` with a warning, because inventing
 * a decision here would be planning outside the sealed contract.
 */
export function materializeCasePaths(
  paths: PlannedPath[],
  facetInstances: FacetInstance[],
  witnessMap: Record<string, string>,
): {
  paths: PlannedPath[];
  assignments: PathAssignment[];
  unassignedCaseIds: string[];
  /** The same ids, each carrying WHICH of the four refusals applied. Same length, same order. */
  unassignedByCause: Array<{ facetInstanceId: string; cause: string; detail: string }>;
  caseOrder: string[];
  warnings: string[];
  enrichedRoute: number;
  enrichedBoundary: number;
  /** Sealed route "answers" that are conditions about another question. See below. */
  routingConditionSelects: Array<{ facetInstanceId: string; question: string; label: string }>;
  /** Code-only route answers this run turned into a clickable label, and how. */
  resolvedRouteLabels: Array<{ facetInstanceId: string; question: string; code: string; label: string; via: string }>;
  /** Code-only route answers still carrying NOTHING the driver can click, and why not. */
  unresolvedRouteCodes: Array<{ facetInstanceId: string; question: string; code: string; why: string }>;
} {
  // Every question this plan knows about, from BOTH sides: the cases' targets and the walks'
  // own decisions. A question that appears only as the CONDITION of a skip rule ("ask Q2 if
  // code 2 at Q1") may have no case of its own, and it is precisely the one a route label is
  // most likely to be talking about.
  const sealedQuestionIds = new Set(
    [
      ...facetInstances.map((fi) => fi.targetQuestionId),
      ...paths.flatMap((path) => (path.decisions ?? []).map((d) => d.question)),
    ]
      .map((q) => (typeof q === "string" ? q.toLowerCase() : ""))
      .filter(Boolean),
  );
  const routingConditionSelects: Array<{ facetInstanceId: string; question: string; label: string }> = [];
  const resolvedRouteLabels: Array<{ facetInstanceId: string; question: string; code: string; label: string; via: string }> = [];
  const unresolvedRouteCodes: Array<{ facetInstanceId: string; question: string; code: string; why: string }> = [];
  const codeLabels = buildRouteCodeLabelIndex(facetInstances, sealedQuestionIds);
  const baseById = new Map(paths.map((path) => [path.id, path]));
  const typedByBase = new Map<string, Array<{ path: PlannedPath; caseId: string }>>();
  const genericByBase = new Map<string, string[]>();
  const unassignedCaseIds: string[] = [];
  const unassignedByCause: Array<{ facetInstanceId: string; cause: string; detail: string }> = [];
  const warnings: string[] = [];
  const seenCaseIds = new Set<string>();
  let enrichedRoute = 0;
  let enrichedBoundary = 0;
  /**
   * Refuse this case AND SAY WHICH OF THE FOUR THINGS WENT WRONG. The cause travels with the
   * id so `planStage` can count the reasons separately; the prose is built from it so the two
   * surfaces cannot drift into telling a reader different stories.
   */
  const refuse = (facetInstanceId: string, cause: string, detail: string): void => {
    unassignedCaseIds.push(facetInstanceId);
    unassignedByCause.push({ facetInstanceId, cause, detail });
    warnings.push(`case ${facetInstanceId} is unassigned (${cause}): ${detail}`);
  };

  for (const fi of facetInstances) {
    if (seenCaseIds.has(fi.facetInstanceId)) {
      throw new Error(`planning refused duplicate sealed facetInstanceId ${fi.facetInstanceId}`);
    }
    seenCaseIds.add(fi.facetInstanceId);

    const hasWitness = Object.prototype.hasOwnProperty.call(witnessMap, fi.requirementLineageId);
    const baseId = hasWitness ? witnessMap[fi.requirementLineageId] : null;
    const base = baseId ? baseById.get(baseId) : null;
    if (!baseId || !base) {
      refuse(
        fi.facetInstanceId,
        PLAN_LIMITATION_CODES.caseWithoutWitnessPath,
        `requirement ${fi.requirementLineageId} has no readable witness path, so there is no walk to attach it to`,
      );
      continue;
    }

    const typed = fi.case.kind === "route" || fi.case.kind === "boundary";
    if (!typed) {
      const ids = genericByBase.get(baseId) ?? [];
      ids.push(fi.facetInstanceId);
      genericByBase.set(baseId, ids);
      continue;
    }

    const qid = fi.targetQuestionId;
    const hasPayload =
      (fi.case.kind === "route" &&
        fi.case.routeAnswer !== null &&
        (fi.case.routeAnswer.code !== null || fi.case.routeAnswer.label !== null)) ||
      (fi.case.kind === "boundary" &&
        fi.case.boundaryInput !== null &&
        (fi.case.boundaryInput.bound === "empty" || fi.case.boundaryInput.value !== null));
    // THE TWO FAILURES BELOW WERE ONE MESSAGE, AND THEY ARE NOT ONE DEFECT. A case with no
    // `targetQuestionId` names no screen: its stimulus may be complete and still unusable,
    // because nothing says where to apply it. A case with a target but no payload knows the
    // screen and not the input. Reporting both as "its stimulus is incomplete" sent readers
    // hunting for a missing stimulus on 21 cases that have one.
    if (!qid) {
      refuse(
        fi.facetInstanceId,
        PLAN_LIMITATION_CODES.caseWithoutTargetQuestion,
        `the sealed ${fi.case.kind} case names no targetQuestionId, so there is no screen to apply it to` +
          (hasPayload ? " — its stimulus is otherwise complete" : " and its stimulus is empty as well"),
      );
      continue;
    }
    if (!hasPayload) {
      // THE SEAL ALREADY SAYS WHY, AND IT IS NOT ALWAYS A SHORTFALL. `expectationGap` is written
      // at expansion time and carried on the case: 18 of the 23 payload-free cases in the real
      // revision are `SELECTION_BOUND_IS_NOT_A_TEXT_INPUT` — the expander DELIBERATELY refusing
      // to write a selection count into a text-input payload, because "type 2" would then be
      // checkable against fields it has nothing to do with. Quoting the seal's own code turns
      // "the planner could not use this" into "here is what would have to exist for it to".
      refuse(
        fi.facetInstanceId,
        PLAN_LIMITATION_CODES.caseWithoutStimulus,
        `the sealed ${fi.case.kind} case targets ${qid} but states no ${
          fi.case.kind === "route" ? "answer code or label" : "input value"
        }, so there is nothing to drive` +
          (fi.expectationGap?.code ? ` (the seal's own reason: ${fi.expectationGap.code})` : ""),
      );
      continue;
    }

    const decisions = base.decisions.filter((decision) => decision.question === qid);
    if (decisions.length !== 1) {
      refuse(
        fi.facetInstanceId,
        PLAN_LIMITATION_CODES.caseTargetNotOnWitnessPath,
        `witness path ${base.id} contains ${decisions.length} decisions for target ${qid}; exactly one is required`,
      );
      continue;
    }

    const clone = clonePlannedPath(base);
    clone.id = `${base.id}--${fi.facetInstanceId}`;
    clone.intent = `${base.intent} [sealed case ${fi.facetInstanceId}]`;
    clone.witnesses = [fi.requirementLineageId];
    clone.base_path_id = base.id;
    clone.facet_instance_id = fi.facetInstanceId;
    const decision = clone.decisions.find((d) => d.question === qid)!;
    const caseAction: PlannedCaseAction = {
      facetInstanceId: fi.facetInstanceId,
      targetQuestionId: qid,
      kind: fi.case.kind as "route" | "boundary",
      routeAnswer: fi.case.routeAnswer,
      boundaryInput: fi.case.boundaryInput,
    };
    decision.case_action = caseAction;
    decision.source = `typed-case:${fi.facetInstanceId}`;

    if (fi.case.kind === "route" && fi.case.routeAnswer) {
      delete decision.action;
      // Read the cardinality signal BEFORE overwriting: >1 selection can only have come
      // from a multi-select, and those extra selections are what keep downstream
      // questions reachable. See the SELECT-LIST SEMANTICS note above.
      const sealedLabel = fi.case.routeAnswer.label;
      const sealedCode = fi.case.routeAnswer.code;
      const isCondition = sealedLabel !== null && isRoutingConditionLabel(sealedLabel, qid, sealedQuestionIds);
      if (isCondition) routingConditionSelects.push({ facetInstanceId: fi.facetInstanceId, question: qid, label: sealedLabel! });
      let label = isCondition ? null : sealedLabel;
      // NO USABLE LABEL, BUT A CODE: ask the SEAL what that code is called on this question.
      // Never a guess and never a paraphrase — see `buildRouteCodeLabelIndex`. `case_action`
      // keeps the sealed `routeAnswer` verbatim either way; only what the driver CLICKS moves.
      if (label === null && sealedCode !== null) {
        const found = codeLabels.get(routeCodeKey(qid, sealedCode));
        if (found && found.label !== null) {
          label = found.label;
          decision.route_label_source = found.via;
          resolvedRouteLabels.push({
            facetInstanceId: fi.facetInstanceId,
            question: qid,
            code: sealedCode,
            label: found.label,
            via: found.via,
          });
        } else {
          unresolvedRouteCodes.push({
            facetInstanceId: fi.facetInstanceId,
            question: qid,
            code: sealedCode,
            why: found?.why ?? "no sealed case names an answer label for this code on this question",
          });
        }
      }
      const planned = decision.select;
      if (planned.length > 1) {
        decision.select = label === null || planned.includes(label) ? [...planned] : [...planned, label];
      } else {
        decision.select = label === null ? [] : [label];
      }
      enrichedRoute += 1;
    } else if (fi.case.kind === "boundary" && fi.case.boundaryInput) {
      const boundary = fi.case.boundaryInput;
      delete decision.action;
      delete decision.text_entry;
      if (boundary.bound === "empty") {
        decision.action = "leave-blank-and-continue";
        decision.text_entry = { required: false, value: "", note: "typed: empty boundary" };
      } else {
        decision.text_entry = { required: true, value: boundary.value!, note: `typed: ${boundary.bound} boundary` };
      }
      enrichedBoundary += 1;
    }
    clone.signature = pathSignature(clone.decisions, clone.back_navigation);
    const typedRows = typedByBase.get(baseId) ?? [];
    typedRows.push({ path: clone, caseId: fi.facetInstanceId });
    typedByBase.set(baseId, typedRows);
  }

  const materializedPaths: PlannedPath[] = [];
  const assignments: PathAssignment[] = [];
  const pathIds = new Set<string>();
  for (const base of paths) {
    if (pathIds.has(base.id)) throw new Error(`planning refused duplicate base path id ${base.id}`);
    pathIds.add(base.id);
    materializedPaths.push(base);
    assignments.push({
      pathId: base.id,
      tier: 1,
      caseIds: genericByBase.get(base.id) ?? [],
      witnesses: [...(base.witnesses ?? [])],
    });
    for (const typed of typedByBase.get(base.id) ?? []) {
      if (pathIds.has(typed.path.id)) throw new Error(`planning produced duplicate case path id ${typed.path.id}`);
      pathIds.add(typed.path.id);
      materializedPaths.push(typed.path);
      assignments.push({
        pathId: typed.path.id,
        tier: 1,
        caseIds: [typed.caseId],
        witnesses: [...(typed.path.witnesses ?? [])],
      });
    }
  }

  const caseOrder = facetInstances.map((fi) => fi.facetInstanceId);
  assertExactCasePermutation(caseOrder, caseOrder, "caseOrder");
  assertExactCasePermutation(
    caseOrder,
    [...assignments.flatMap((assignment) => assignment.caseIds), ...unassignedCaseIds],
    "assignments + unassignedCaseIds",
  );
  for (const r of resolvedRouteLabels) {
    warnings.push(
      `case ${r.facetInstanceId}: sealed route answer on ${r.question} named only code ${JSON.stringify(r.code)} and no ` +
        `label, so the driver had nothing to click. The label ${JSON.stringify(r.label)} was taken from ${r.via} — the ` +
        `SAME question and the SAME code in the same sealed contract — and put in select. case_action still carries the ` +
        `sealed answer verbatim.`,
    );
  }
  for (const r of unresolvedRouteCodes) {
    warnings.push(
      `case ${r.facetInstanceId}: sealed route answer on ${r.question} names code ${JSON.stringify(r.code)} and NO label, ` +
        `and ${r.why}. The walk still runs, but this decision clicks nothing on ${r.question} and the route it is supposed ` +
        `to witness will not be driven. Inventing a label would be a fabricated answer, so none was invented.`,
    );
  }
  for (const r of routingConditionSelects) {
    warnings.push(
      `case ${r.facetInstanceId}: sealed route answer ${JSON.stringify(r.label)} on ${r.question} is a routing ` +
        `CONDITION about another question, not an option label; removed from what the driver clicks (kept verbatim ` +
        `in case_action). No option on ${r.question} can ever carry that text, so clicking it was never possible ` +
        `and reporting it as "not offered" would have been a fabricated defect.`,
    );
  }
  return {
    paths: materializedPaths,
    assignments,
    unassignedCaseIds,
    unassignedByCause,
    caseOrder,
    warnings,
    enrichedRoute,
    enrichedBoundary,
    routingConditionSelects,
    resolvedRouteLabels,
    unresolvedRouteCodes,
  };
}

/**
 * Index key for one answer code on one question.
 *
 * The separator is NUL, written as an ESCAPE rather than as a literal byte. A raw control
 * character in a source file makes that file read as BINARY to grep and to the mutation
 * harness's exact-anchor matcher — which is how the guard below first scored as
 * BROKEN-ANCHOR (untestable) rather than as killed. NUL is chosen because it is the one
 * byte that cannot occur inside a question id or an answer code, so `Q1` + `23` and
 * `Q12` + `3` cannot collide on a single key.
 */
const ROUTE_CODE_KEY_SEPARATOR = "\u0000";
export function routeCodeKey(questionId: string, code: string): string {
  return [String(questionId ?? "").trim(), String(code ?? "").trim()].join(ROUTE_CODE_KEY_SEPARATOR);
}

/**
 * WHAT A SEALED ANSWER CODE IS CALLED — read off OTHER SEALED CASES, never inferred.
 *
 * ============================ THE DEFECT, MEASURED ============================
 *
 * A sealed route case may name its answer by CODE with `label: null`. `select` is then empty,
 * the driver is handed nothing to click, the walk answers that screen by navigator discretion,
 * and the route the case exists to witness is never taken — while the case still closes. On the
 * real sealed revision `cr_c3929b37…` that is eight assigned route cases: S2 codes 1–4, Q7
 * codes 2–3, and the two whose "label" is a routing condition.
 *
 * ============================ THE ONLY SOURCE USED ============================
 *
 * A DIFFERENT SEALED CASE ON THE SAME QUESTION THAT NAMES THE SAME CODE AND DOES CARRY A LABEL.
 * `fi_942d…` is Q7 / code 2 / label null; `fi_568d…` is Q7 / code 2 / label "No". Both are rows
 * of the same seal, minted from the same document, so the join is an EQUALITY on sealed data:
 * no prose is parsed, no wording is paraphrased, and it works identically on a questionnaire in
 * any language. The label is copied byte-for-byte.
 *
 * ============ WHAT IS DELIBERATELY *NOT* A SOURCE, AND WHY IT WOULD BE FABRICATION ============
 *
 * The contract also carries `facet: "option-list"` requirements whose sentences state code and
 * label together, and 20 of the 63 in that revision sit under `scope: "survey"` rather than
 * under any question. Those twenty describe AT LEAST THREE DIFFERENT QUESTIONS — an age band
 * list (code 1 = "18 to 24"), a frequency list (code 1 = "Every day") and a gender list
 * (code 1 = "Male") — all claiming code 1, with nothing in the seal saying which question each
 * belongs to. Attaching them by document proximity would have a one-in-three chance of telling
 * the driver to click "Male" to answer "how often do you drink coffee at home", and the run
 * would then report a route defect against a survey that is behaving perfectly. There is no
 * amount of care that makes an unscoped list safe, so unscoped lists are not read at all and
 * the four S2 cases they would have "resolved" stay counted as unresolved. That is the honest
 * outcome the sealed contract supports.
 *
 * TWO REFUSALS INSIDE THE JOIN ITSELF:
 *   - A label that `isRoutingConditionLabel` rejects never ENTERS the index. Propagating
 *     "Code 2 at Q1" from one case to another would spread the exact poison D32 removed.
 *   - Two sealed cases giving DIFFERENT labels for the same question+code do not vote. At most
 *     one of them can be right, so the entry resolves to nothing and says which two disagreed.
 */
export function buildRouteCodeLabelIndex(
  facetInstances: FacetInstance[],
  sealedQuestionIds: Set<string>,
): Map<string, { label: string | null; via: string; why?: string }> {
  const index = new Map<string, { label: string | null; via: string; why?: string }>();
  for (const fi of facetInstances) {
    if (fi.case?.kind !== "route") continue;
    const qid = fi.targetQuestionId;
    const answer = fi.case.routeAnswer;
    if (!qid || !answer || answer.code === null || answer.label === null) continue;
    if (isRoutingConditionLabel(answer.label, qid, sealedQuestionIds)) continue;
    const key = routeCodeKey(qid, answer.code);
    const held = index.get(key);
    if (!held) {
      index.set(key, { label: answer.label, via: `sealed-case:${fi.facetInstanceId}` });
      continue;
    }
    if (held.label === answer.label) continue;
    if (held.label === null) continue; // already refused by an earlier disagreement
    index.set(key, {
      label: null,
      via: `ambiguous:${held.via},sealed-case:${fi.facetInstanceId}`,
      why:
        `two sealed cases disagree about what that code is called (${JSON.stringify(held.label)} vs ` +
        `${JSON.stringify(answer.label)}), so at most one is right and neither was used`,
    });
  }
  return index;
}

/**
 * IS THIS "ANSWER" ACTUALLY A ROUTING CONDITION ABOUT ANOTHER QUESTION?
 *
 * MEASURED, NOT HYPOTHETICAL. Two sealed cases in the real revision carry
 * `routeAnswer.label = "Code 2 at Q1"` and `"Any other code at Q1 except 2"` on decisions for
 * Q2. Those are the document's skip-rule conditions ("ASK Q2 IF CODE 2 AT Q1"), not labels of
 * anything Q2 offers. Left in `select` they cost twice: the driver clicks nothing and then
 * records the string in `requestedButNotOffered`, which reads downstream as "the site is
 * missing an option the document requires" — a confident defect claim about a healthy survey.
 *
 * THE RULE, and it is deliberately about STRUCTURE rather than about phrasing: a label that
 * names a DIFFERENT sealed question is talking about that other question. No phrase list, no
 * "code"/"except" keywords — those are English and this must work on a French questionnaire.
 *
 * TWO GUARDS AGAINST EATING A REAL ANSWER:
 *   - at least three tokens, so a one-word option that happens to equal an id ("D") is safe;
 *   - the referenced id must contain a digit. Sealed ids in a real contract include bare
 *     letters (`D`, `E`, grid rows `rowA`) and words (`unknown`), and an option label is free
 *     to contain those as ordinary text. "Question identifiers carry a number" is an
 *     ASSUMPTION, stated here: where it does not hold, this returns false, the label stays in
 *     `select`, and behaviour is exactly what it is today — the failure is toward the status
 *     quo, never toward silently dropping a real answer.
 */
export function isRoutingConditionLabel(
  label: string,
  ownQuestionId: string,
  sealedQuestionIds: Set<string>,
): boolean {
  const tokens = wordingTokens(label);
  if (tokens.length < 3) return false;
  const own = String(ownQuestionId ?? "").toLowerCase();
  return tokens.some((t) => t !== own && /\d/.test(t) && sealedQuestionIds.has(t));
}

function clonePlannedPath(path: PlannedPath): PlannedPath {
  return JSON.parse(JSON.stringify(path)) as PlannedPath;
}

export function assertExactCasePermutation(expected: string[], actual: string[], context: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length) throw new Error(`${context}: sealed facetInstanceIds contain duplicates`);
  if (actualSet.size !== actual.length) throw new Error(`${context}: execution case ids contain duplicates`);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0 || expected.length !== actual.length) {
    throw new Error(
      `${context}: not an exact sealed-case permutation (missing=${missing.join(",") || "-"}; extra=${extra.join(",") || "-"})`,
    );
  }
}

export function executionProgramFailures(
  program: unknown,
  expectedRunId: string,
  expectedPlanRevisionId: string,
): string[] {
  const p = program as Partial<ExecutionProgram> | null;
  if (!p || typeof p !== "object") return ["payload is not an object"];
  const failures: string[] = [];
  if (p.kind !== EXECUTION_PROGRAM_KIND && p.kind !== LEGACY_EXECUTION_PROGRAM_KIND) failures.push(`kind is ${String(p.kind)}`);
  if (p.runId !== expectedRunId) failures.push(`runId is ${String(p.runId)}`);
  if (p.planRevisionId !== expectedPlanRevisionId) failures.push(`planRevisionId is ${String(p.planRevisionId)}`);
  if (!Array.isArray(p.floor)) failures.push("floor is not an array");
  if (!Array.isArray(p.caseOrder)) failures.push("caseOrder is not an array");
  if (!Array.isArray(p.unassignedCaseIds)) failures.push("unassignedCaseIds is not an array");
  if (failures.length > 0) return failures;

  const floor = p.floor as PathAssignment[];
  const pathIds = floor.map((assignment) => assignment.pathId);
  if (new Set(pathIds).size !== pathIds.length) failures.push("floor path ids are duplicated");
  if (new Set(p.caseOrder!).size !== p.caseOrder!.length) failures.push("caseOrder contains duplicates");
  const planPathIds = new Set((p.plan?.floor?.paths ?? []).map((path) => path.id));
  for (const pathId of pathIds) if (!planPathIds.has(pathId)) failures.push(`assignment names missing plan path ${pathId}`);
  if (p.seedPlan) {
    const alternatives = p.seedPlan.alternatives ?? [];
    const ids = alternatives.map((row) => row.alternativeId);
    if (new Set(ids).size !== ids.length) failures.push("seed alternative ids are duplicated");
    for (const row of alternatives) {
      if (!p.caseOrder!.includes(row.caseId)) failures.push(`seed alternative names non-denominator case ${row.caseId}`);
      if (row.caseId !== row.certificate.facetInstanceId) failures.push(`seed alternative ${row.alternativeId} case differs from certificate`);
      if (row.path.id !== row.alternativeId) failures.push(`seed alternative ${row.alternativeId} path id differs`);
    }
    const census = p.seedPlan.census;
    if (census.selectedCount !== alternatives.length) failures.push("seed selected census differs from alternatives");
    if (census.droppedCount !== census.candidateCount - census.selectedCount) failures.push("seed dropped census is not candidate minus selected");
    if (census.materializedCandidateCount + census.omittedCandidateCount !== census.candidateCount) failures.push("seed candidate census does not reconcile");
  }
  return failures;
}

function recomputeFloorEstimate(plan: CoveragePlan): void {
  const estimate = plan.estimate as unknown as {
    assumptions?: { cost_per_navigator_step_usd?: number; seconds_per_step?: number };
    floor?: { paths: number; steps: number; cost_usd: number; wall_clock_minutes: number };
    total?: { steps: number; cost_usd: number; wall_clock_minutes: number };
  } | undefined;
  if (!estimate?.floor || !estimate.total) return;
  const oldFloorSteps = estimate.floor.steps;
  const floorSteps = plan.floor.paths.reduce((sum, path) => sum + (Number.isFinite(path.steps) ? path.steps : 0), 0);
  const costPerStep = estimate.assumptions?.cost_per_navigator_step_usd ?? 0;
  const secondsPerStep = estimate.assumptions?.seconds_per_step ?? 0;
  estimate.floor = {
    paths: plan.floor.paths.length,
    steps: floorSteps,
    cost_usd: Number((floorSteps * costPerStep).toFixed(4)),
    wall_clock_minutes: Number(((floorSteps * secondsPerStep) / 60).toFixed(1)),
  };
  estimate.total = {
    steps: estimate.total.steps - oldFloorSteps + floorSteps,
    cost_usd: Number((estimate.total.cost_usd + (floorSteps - oldFloorSteps) * costPerStep).toFixed(4)),
    wall_clock_minutes: Number(
      (estimate.total.wall_clock_minutes + ((floorSteps - oldFloorSteps) * secondsPerStep) / 60).toFixed(1),
    ),
  };
}
