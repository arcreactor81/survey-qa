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
import { planKey } from "../../keys";
import { getContractRevision } from "../../store/contract-revision";
import type { ContractRevision, FacetInstance, ScopedRequirement } from "../../types/record";
import { planFromContract, pathSignature } from "./planner/plan-core.js";
export { pathSignature };
import type {
  CoveragePlan,
  PlannedCaseAction,
  PlannedPath,
  PlannerContract,
  PlannerObligation,
} from "./planner/plan-core.js";

export const EXECUTION_PROGRAM_KIND = "v2-execution-program/2.0.0" as const;

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
  kind: typeof EXECUTION_PROGRAM_KIND;
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
  program: ExecutionProgram;
  caseIds: string[];
  floorPaths: number;
  explorationEntries: number;
  plannedSteps: number;
  status: CoveragePlan["status"];
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
export function requirementToObligation(r: ScopedRequirement): PlannerObligation {
  const loose = r as unknown as Record<string, unknown>;
  const stimulus = Array.isArray(loose["stimulus"]) ? (loose["stimulus"] as string[]) : [];
  return {
    id: r.requirementLineageId,
    category: typeof loose["category"] === "string" ? (loose["category"] as string) : r.facet,
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
  const key = `v2/runs/${runId}/extraction/checklist.json`;
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

  // ---- assignment: mandatory execution case -> the floor path that witnesses it ----
  const witnessMap: Record<string, string> = (plan.floor.coverage.witness_map ?? {}) as Record<string, string>;
  const materialized = materializeCasePaths(plan.floor.paths, revision.facetInstances, witnessMap);
  plan.floor.paths = materialized.paths;
  warnings.push(...materialized.warnings);
  recomputeFloorEstimate(plan);
  const floor = materialized.assignments;
  const unassigned = materialized.unassignedCaseIds;

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
    warnings: [...warnings, ...(plan.warnings ?? [])],
    plan,
  };

  await env.EVIDENCE.put(planKey(args.runId, args.planRevisionId), JSON.stringify(program), {
    httpMetadata: { contentType: "application/json" },
  });

  return {
    planRevisionId: args.planRevisionId,
    program,
    caseIds: caseOrder,
    floorPaths: floor.length,
    explorationEntries: program.exploration.length,
    plannedSteps: plan.estimate?.total?.steps ?? 0,
    status: plan.status,
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
  caseOrder: string[];
  warnings: string[];
  enrichedRoute: number;
  enrichedBoundary: number;
} {
  const baseById = new Map(paths.map((path) => [path.id, path]));
  const typedByBase = new Map<string, Array<{ path: PlannedPath; caseId: string }>>();
  const genericByBase = new Map<string, string[]>();
  const unassignedCaseIds: string[] = [];
  const warnings: string[] = [];
  const seenCaseIds = new Set<string>();
  let enrichedRoute = 0;
  let enrichedBoundary = 0;

  for (const fi of facetInstances) {
    if (seenCaseIds.has(fi.facetInstanceId)) {
      throw new Error(`planning refused duplicate sealed facetInstanceId ${fi.facetInstanceId}`);
    }
    seenCaseIds.add(fi.facetInstanceId);

    const hasWitness = Object.prototype.hasOwnProperty.call(witnessMap, fi.requirementLineageId);
    const baseId = hasWitness ? witnessMap[fi.requirementLineageId] : null;
    const base = baseId ? baseById.get(baseId) : null;
    if (!baseId || !base) {
      unassignedCaseIds.push(fi.facetInstanceId);
      warnings.push(
        `case ${fi.facetInstanceId} is unassigned: requirement ${fi.requirementLineageId} has no readable witness path`,
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
    if (!qid || !hasPayload) {
      unassignedCaseIds.push(fi.facetInstanceId);
      warnings.push(`case ${fi.facetInstanceId} is unassigned: its ${fi.case.kind} stimulus is incomplete`);
      continue;
    }

    const decisions = base.decisions.filter((decision) => decision.question === qid);
    if (decisions.length !== 1) {
      unassignedCaseIds.push(fi.facetInstanceId);
      warnings.push(
        `case ${fi.facetInstanceId} is unassigned: witness path ${base.id} contains ${decisions.length} decisions for target ${qid}; exactly one is required`,
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
      const label = fi.case.routeAnswer.label;
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
  return {
    paths: materializedPaths,
    assignments,
    unassignedCaseIds,
    caseOrder,
    warnings,
    enrichedRoute,
    enrichedBoundary,
  };
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
  if (p.kind !== EXECUTION_PROGRAM_KIND) failures.push(`kind is ${String(p.kind)}`);
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
