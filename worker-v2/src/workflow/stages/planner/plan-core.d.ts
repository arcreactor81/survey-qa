/**
 * The typed boundary of the ported planner.
 *
 * `plan-core.js` is a verbatim port of working deterministic code (see its header). This
 * file types the four things the Worker actually calls and the shape of what comes back.
 * Everything the planner emits is JSON, so the plan itself is described structurally
 * rather than re-declaring 1,400 lines of internal model types: the fields below are the
 * ones the executor and the checkpoint depend on, and they are the ones that must not
 * drift.
 */

/** One answered screen on a planned walk. */
export interface PlannedCaseAction {
  facetInstanceId: string;
  targetQuestionId: string;
  kind: "route" | "boundary";
  routeAnswer: { code: string | null; label: string | null } | null;
  boundaryInput: {
    bound: "min" | "max" | "below-min" | "above-max" | "invalid" | "empty";
    value: string | null;
    expectedOutcome: "accepted" | "rejected" | "unspecified";
  } | null;
}

export interface PlannedDecision {
  question: string;
  /** Answer LABELS to select, verbatim from the contract. Empty for grid/text screens. */
  select: string[];
  source: string;
  strategy?: string;
  note?: string;
  /** A deliberate probe instead of a normal answer, e.g. "leave-blank-and-continue". */
  action?: string;
  text_entry?: { required: boolean; value: string; length?: number; note?: string };
  /** Exact sealed stimulus for a case-specific path. Never inferred from `select`. */
  case_action?: PlannedCaseAction;
  /**
   * THE DOCUMENT'S OWN WORDING of this question — the driver's PRIMARY identity signal.
   *
   * NOT emitted by `plan-core.js`. It is stamped by `stages/plan.ts#stampQuestionWording`
   * out of the SEALED revision (`facet: "question"` requirements under `scope:
   * "question:<id>"`), which is why it is optional: a question the contract never words is
   * a question the driver cannot recognise by wording, and the plan says so by leaving this
   * absent rather than by inventing a string.
   *
   * It is deliberately NOT part of `pathSignature` — two paths that differ only in the
   * wording stamped on them are the same experiment, and the signature must keep saying so.
   */
  question_text?: string;
  /** WHERE the wording came from: `scope-exact:<scope>` or `scope-sibling:<scope>`. */
  question_text_source?: string;
  [k: string]: unknown;
}

export interface PlannedSkippedQuestion {
  question: string;
  reason: string;
  base?: string;
  warning?: string;
  [k: string]: unknown;
}

export interface PlannedTermination {
  question: string;
  answer: string;
  terminal: string;
  [k: string]: unknown;
}

export interface PlannedPath {
  id: string;
  tier: number;
  kind: string;
  intent: string;
  decisions: PlannedDecision[];
  skipped_questions: PlannedSkippedQuestion[];
  terminated_at: PlannedTermination | null;
  witnesses: string[];
  witness_notes: unknown[];
  needs_repeats: unknown[];
  steps: number;
  signature?: string;
  back_navigation?: unknown;
  est_cost_usd?: number;
  [k: string]: unknown;
}

export interface ExplorationEntry {
  id: string;
  tier: number;
  class: string;
  anchor_question: string | null;
  /** Exploration entries explain their purpose through these emitted fields. */
  rationale: string;
  probing: string;
  intent?: string;
  decisions: PlannedDecision[];
  steps: number;
  priority_score: number;
  mandatory?: boolean;
  root_cause_key?: string;
  signature?: string;
  repeats?: number;
  back_navigation?: unknown;
  [k: string]: unknown;
}

/** A non-scoring contract-gap probe; it is not a normal Tier-2 execution entry. */
export interface UncontractedProbe {
  id: string;
  class: string;
  gap: string;
  status: string;
  rationale: string;
  probing: string;
  tier: "gap";
  steps: number;
  est_cost_usd: number;
  [k: string]: unknown;
}

export interface CoveragePlan {
  kind: "coverage-plan/two-tier-v1";
  generated_at: string;
  run: string;
  status: "OK" | "OK-WITH-GAPS" | "PROVISIONAL" | "BLOCKED";
  contract_status: string;
  blockers: Array<{ code: string; severity: string; detail: string; consequence: string }>;
  warnings: string[];
  denominator: {
    source: string;
    authority: string;
    contract_hash?: string | null;
    obligations: number;
    ambiguities?: number;
    out_of_scope_for_browser?: number;
    locked: boolean;
    rule?: string;
  };
  floor: {
    paths: PlannedPath[];
    coverage: {
      obligations: number;
      witnessed_by_floor: number;
      uncovered: Array<{ obligation: string; disposition: string; [k: string]: unknown }>;
      covers_all_obligations: boolean;
      covers_all_after_mandatory_exploration?: boolean;
      witness_map?: Record<string, string>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  exploration: {
    queue: ExplorationEntry[];
    by_class: Record<string, number>;
    [k: string]: unknown;
  };
  uncontracted_probes?: { probes: UncontractedProbe[]; [k: string]: unknown };
  model?: {
    question_order?: string[];
    questions?: Array<{ id: string; obligations?: string[]; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  estimate?: { total?: { steps: number; cost_usd: number; wall_clock_minutes: number } ; [k: string]: unknown };
  [k: string]: unknown;
}

/** Checklist-shaped obligation — the planner's only input row type. */
export interface PlannerObligation {
  id: string;
  category?: string;
  doc_quote?: string;
  statement?: string;
  stimulus?: string[];
  expected_observable?: string;
  browser_observable?: string;
  confidence?: number;
  source_chunk?: string | null;
  notes?: string;
  [k: string]: unknown;
}

export interface PlannerContract {
  obligations: PlannerObligation[];
  ambiguities?: Array<{ id: string; [k: string]: unknown }>;
  unverifiable_from_browser?: Array<{ id: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface PlanOptions {
  run?: string;
  source?: string;
  contractStatus?: string;
  priorPlan?: CoveragePlan | null;
  chunkAudit?: unknown;
  maxQueue?: number;
  perClassCap?: number;
  costPerStep?: number;
  secondsPerStep?: number;
  generatedAt?: string;
}

export function planFromContract(rawContract: PlannerContract | unknown, opts?: PlanOptions): CoveragePlan;
export function pathSignature(
  decisions: PlannedDecision[] | null | undefined,
  back?: unknown,
): string;
export function normalizeContract(
  raw: unknown,
  sourceLabel?: string,
): { ok: boolean; contract: PlannerContract & { contractHash: string | null }; warnings: string[]; blockers: unknown[] };
export function hashContract(c: unknown): string;
export function emptyContract(): PlannerContract;
export function rebaseAgainst(priorPlan: unknown, contract: unknown, floor: unknown): unknown;
