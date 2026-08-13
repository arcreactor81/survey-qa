/**
 * W5 — sealed-authority multi-path seeds.
 *
 * A seed is stimulus, never evidence.  The only positive authority accepted here is an
 * `entailed` sealed option-set case's own `optionSet.asserted` payload.  In particular this
 * module never reads planner `model`, prose-mined labels, `siblings`, negative/ambiguous rows,
 * or a value discovered by a browser.  Candidates that fail that rule stay in the census.
 */
import type { ContractRevision, FacetInstance } from "../../../types/record";
import { canonicalHash } from "../../../store/hash";
import { pathSignature, type PlannedDecision, type PlannedPath } from "./plan-core.js";

export const SEALED_SEED_CERTIFICATE_KIND = "v2-sealed-positive-seed-certificate/1.0.0" as const;

export interface SealedSeedOption {
  assertedOrdinal: number;
  code: string | null;
  label: string;
}

export interface SealedPositiveSeedCertificate {
  kind: typeof SEALED_SEED_CERTIFICATE_KIND;
  certificateHash: string;
  contractRevisionId: string;
  contractHash: string;
  facetInstanceId: string;
  requirementLineageId: string;
  requirementVersionId: string;
  expansionCertificate: string;
  targetQuestionId: string;
  /** Complete positive payload from this case; never `siblings`. */
  assertedOptions: SealedSeedOption[];
  /** Ordinals within `assertedOptions` that this alternative will select. */
  selectedOrdinals: number[];
}

export interface SeedAlternative {
  alternativeId: string;
  caseId: string;
  basePathId: string;
  questionId: string;
  estimatedSteps: number;
  certificate: SealedPositiveSeedCertificate;
  path: PlannedPath;
}

export interface SeedWithheldRow {
  caseId: string;
  reason:
    | "not-positive-entailed-authority"
    | "typed-positive-payload-unavailable"
    | "target-question-unbound"
    | "witness-path-unavailable"
    | "target-occurrence-not-unique"
    | "unsupported-history-action"
    | "unsupported-history-text-readback"
    | "under-specified-history-transition";
  detail: string;
}

export interface SeedDropRow {
  alternativeId: string;
  caseId: string;
  reason: "candidate-cap" | "per-question-cap" | "per-base-path-cap" | "attempt-cap" | "step-cap";
  count: number;
}

export interface SeedPlanCensus {
  authorityRows: number;
  eligibleRows: number;
  withheldRows: number;
  candidateCount: number;
  materializedCandidateCount: number;
  omittedCandidateCount: number;
  withheldCombinationCount: number;
  withheldCombinationReason: "control-cardinality-not-sealed";
  selectedCount: number;
  droppedCount: number;
  residualCaseIds: string[];
  candidatesTruncated: boolean;
  selectedEstimatedSteps: number;
  budget: SeedBudget;
  withheld: SeedWithheldRow[];
  dropped: SeedDropRow[];
}

export interface SeedPlan {
  alternatives: SeedAlternative[];
  census: SeedPlanCensus;
}

export interface SeedBudget {
  candidateCap: number;
  perQuestionCap: number;
  perBasePathCap: number;
  attemptCap: number;
  stepCap: number;
}

export const DEFAULT_SEED_LIMITS = Object.freeze({
  candidateCap: 256,
  perQuestionCap: 8,
  perBasePathCap: 6,
  attemptCap: 32,
} as const);

type SeedCertificateBody = Omit<SealedPositiveSeedCertificate, "certificateHash">;

const exactPositiveOptions = (fi: FacetInstance): SealedSeedOption[] =>
  (fi.case.optionSet?.asserted ?? []).map((option, assertedOrdinal) => ({
    assertedOrdinal,
    code: option.code,
    label: option.label,
  }));

const certificateBody = (
  revision: ContractRevision,
  contractHash: string,
  fi: FacetInstance,
  assertedOptions: SealedSeedOption[],
  selectedOrdinals: number[],
): SeedCertificateBody => ({
  kind: SEALED_SEED_CERTIFICATE_KIND,
  contractRevisionId: revision.contractRevisionId,
  contractHash,
  facetInstanceId: fi.facetInstanceId,
  requirementLineageId: fi.requirementLineageId,
  requirementVersionId: fi.requirementVersionId,
  expansionCertificate: fi.expansionCertificate,
  targetQuestionId: fi.targetQuestionId!,
  assertedOptions,
  selectedOrdinals,
});

async function mintCertificate(body: SeedCertificateBody): Promise<SealedPositiveSeedCertificate> {
  return { ...body, certificateHash: `sha256:${await canonicalHash(body)}` };
}

/** Recompute the complete authority join. No field on the supplied certificate is trusted. */
export async function sealedSeedCertificateFailures(
  certificate: SealedPositiveSeedCertificate,
  revision: ContractRevision,
  contractHash: string,
): Promise<string[]> {
  const failures: string[] = [];
  if (!certificate || certificate.kind !== SEALED_SEED_CERTIFICATE_KIND) return ["certificate kind is invalid"];
  if (certificate.contractRevisionId !== revision.contractRevisionId) failures.push("contract revision id differs");
  if (certificate.contractHash !== contractHash) failures.push("contract revision hash differs");
  const cases = revision.facetInstances.filter((row) => row.facetInstanceId === certificate.facetInstanceId);
  if (cases.length !== 1) return [...failures, `sealed case resolves ${cases.length} times`];
  const fi = cases[0]!;
  const requirements = revision.requirements.filter((row) => row.requirementLineageId === fi.requirementLineageId);
  if (requirements.length !== 1) return [...failures, `sealed requirement resolves ${requirements.length} times`];
  const requirement = requirements[0]!;
  if (requirement.assertionStatus !== "entailed") failures.push(`assertion status is ${requirement.assertionStatus}`);
  if (fi.case.kind !== "option-set" || fi.expectationGap !== null || !fi.case.optionSet) {
    failures.push("case is not a typed positive option-set payload");
  }
  if (!fi.targetQuestionId) failures.push("sealed case has no target question");
  const options = exactPositiveOptions(fi);
  if (options.length === 0) failures.push("sealed case asserts no positive option");
  const ordinalsValid = validSelectedOrdinals(certificate.selectedOrdinals, options.length);
  if (!ordinalsValid) failures.push("selected option ordinals are invalid");
  const expected = ordinalsValid ? certificateBody(revision, contractHash, fi, options, certificate.selectedOrdinals) : null;
  if (expected) {
    if (certificate.requirementLineageId !== expected.requirementLineageId) failures.push("requirement lineage differs");
    if (certificate.requirementVersionId !== expected.requirementVersionId) failures.push("requirement version differs");
    if (certificate.expansionCertificate !== expected.expansionCertificate) failures.push("expansion certificate differs");
    if (certificate.targetQuestionId !== expected.targetQuestionId) failures.push("target question differs");
    if (JSON.stringify(certificate.assertedOptions) !== JSON.stringify(expected.assertedOptions)) failures.push("asserted option payload differs");
    const expectedHash = `sha256:${await canonicalHash(expected)}`;
    if (certificate.certificateHash !== expectedHash) failures.push("certificate content hash differs");
  }
  return failures;
}

const validSelectedOrdinals = (value: unknown, optionCount: number): value is number[] =>
  Array.isArray(value) && value.length === 1 && new Set(value).size === value.length &&
  value.every((ordinal) => Number.isInteger(ordinal) && ordinal >= 0 && ordinal < optionCount);

const clone = (path: PlannedPath): PlannedPath => JSON.parse(JSON.stringify(path)) as PlannedPath;

/**
 * Generate selected alternatives while leaving `caseOrder` untouched.  Alternatives carry a
 * `caseId` relation for a future receipt join, but are deliberately not PathAssignments and
 * therefore cannot close or duplicate a denominator row under today's executor.
 */
export async function buildSealedSeedPlan(args: {
  revision: ContractRevision;
  contractHash: string;
  floorPaths: PlannedPath[];
  witnessMap: Record<string, string>;
  baselineFloorSteps: number;
  limits?: Partial<Omit<SeedBudget, "stepCap">> & { stepCap?: number };
}): Promise<SeedPlan> {
  const budget: SeedBudget = {
    candidateCap: Math.max(0, Math.floor(args.limits?.candidateCap ?? DEFAULT_SEED_LIMITS.candidateCap)),
    perQuestionCap: Math.max(0, Math.floor(args.limits?.perQuestionCap ?? DEFAULT_SEED_LIMITS.perQuestionCap)),
    perBasePathCap: Math.max(0, Math.floor(args.limits?.perBasePathCap ?? DEFAULT_SEED_LIMITS.perBasePathCap)),
    attemptCap: Math.max(0, Math.floor(args.limits?.attemptCap ?? DEFAULT_SEED_LIMITS.attemptCap)),
    stepCap: Math.max(0, Math.floor(args.limits?.stepCap ?? Math.min(640, 2 * args.baselineFloorSteps))),
  };
  const pathById = new Map(args.floorPaths.map((path) => [path.id, path]));
  const requirementById = new Map(args.revision.requirements.map((row) => [row.requirementLineageId, row]));
  const withheld: SeedWithheldRow[] = [];
  const generated: SeedAlternative[] = [];
  const eligible: Array<{ fi: FacetInstance; options: SealedSeedOption[]; base: PlannedPath; basePathId: string }> = [];
  let eligibleRows = 0;
  let candidateCount = 0;
  let withheldCombinationCount = 0;

  const optionCases = args.revision.facetInstances.filter((fi) => fi.case.kind === "option-set");
  for (const fi of optionCases) {
    const req = requirementById.get(fi.requirementLineageId);
    if (!req || req.assertionStatus !== "entailed") {
      withheld.push({ caseId: fi.facetInstanceId, reason: "not-positive-entailed-authority", detail: `sealed assertion status is ${req?.assertionStatus ?? "missing"}` });
      continue;
    }
    const options = exactPositiveOptions(fi);
    if (fi.expectationGap !== null || !fi.case.optionSet || options.length === 0) {
      withheld.push({ caseId: fi.facetInstanceId, reason: "typed-positive-payload-unavailable", detail: fi.expectationGap?.code ?? "the sealed asserted payload is empty" });
      continue;
    }
    if (new Set(options.map((option) => option.label)).size !== options.length) {
      withheld.push({ caseId: fi.facetInstanceId, reason: "typed-positive-payload-unavailable", detail: "the asserted payload repeats a visible label, so an action cannot identify which occurrence it selected" });
      continue;
    }
    if (!fi.targetQuestionId) {
      withheld.push({ caseId: fi.facetInstanceId, reason: "target-question-unbound", detail: "the sealed case names no target question" });
      continue;
    }
    const basePathId = args.witnessMap[fi.requirementLineageId];
    const base = basePathId ? pathById.get(basePathId) : null;
    if (!basePathId || !base) {
      withheld.push({ caseId: fi.facetInstanceId, reason: "witness-path-unavailable", detail: "the sealed requirement has no readable floor witness" });
      continue;
    }
    const target = base.decisions.filter((decision) => decision.question === fi.targetQuestionId);
    if (target.length !== 1) {
      withheld.push({ caseId: fi.facetInstanceId, reason: "target-occurrence-not-unique", detail: `the base path contains ${target.length} target occurrences; refusing to guess which history applies` });
      continue;
    }
    const targetIndex = base.decisions.indexOf(target[0]!);
    const priorDecisions = base.decisions.slice(0, targetIndex);
    const priorActions = priorDecisions.filter((decision) => !!decision.action);
    if (priorActions.length > 0) {
      withheld.push({
        caseId: fi.facetInstanceId,
        reason: "unsupported-history-action",
        detail: `${priorActions.length} prior planned action transition(s) lack sealed exact execution/readback semantics`,
      });
      continue;
    }
    const priorText = priorDecisions.filter((decision) => decision.text_entry !== undefined);
    if (priorText.length > 0) {
      withheld.push({
        caseId: fi.facetInstanceId,
        reason: "unsupported-history-text-readback",
        detail: `${priorText.length} prior text transition(s) lack a retained typed DOM readback`,
      });
      continue;
    }
    const underSpecified = priorDecisions.filter((decision) =>
      (decision.select?.length ?? 0) === 0 && decision.text_entry === undefined && !decision.action);
    if (underSpecified.length > 0) {
      withheld.push({
        caseId: fi.facetInstanceId,
        reason: "under-specified-history-transition",
        detail: `${underSpecified.length} prior transition(s) name no exact action whose retained readback can bind the route`,
      });
      continue;
    }
    eligibleRows += 1;
    candidateCount += options.length;
    withheldCombinationCount += (options.length * (options.length - 1)) / 2;
    eligible.push({ fi, options, base, basePathId });
  }

  // Candidate admission must not depend on the document renderer's array order. Each still-open
  // sealed case contributes one marginal obligation; prefer the cheapest witness path, then use
  // sealed facet identity as the deterministic tie-break. Round-robin below preserves that
  // priority for every ordinal when the cap is smaller than the eligible case count.
  eligible.sort((left, right) =>
    left.base.steps - right.base.steps || left.fi.facetInstanceId.localeCompare(right.fi.facetInstanceId));

  // Round-robin by option ordinal gives every eligible case one candidate before any case gets
  // a second. Materialization stops at the persisted cap while the exact theoretical count
  // above remains the denominator, so bounding work cannot silently shrink coverage.
  for (let ordinal = 0; generated.length < budget.candidateCap; ordinal += 1) {
    let found = false;
    for (const { fi, options, base, basePathId } of eligible) {
      if (generated.length >= budget.candidateCap) break;
      if (ordinal >= options.length) continue;
      found = true;
      const ordinals = [ordinal];
      const chosen = [options[ordinal]!];
      const certificate = await mintCertificate(certificateBody(args.revision, args.contractHash, fi, options, ordinals));
      const path = clone(base);
      const vector = ordinals.map((n) => String(n)).join("-");
      const alternativeId = `SEED-${fi.facetInstanceId}-${vector}`;
      path.id = alternativeId;
      path.tier = 2;
      path.kind = "sealed-seed-alternative";
      path.intent = `exercise one certified positive option vector for sealed case ${fi.facetInstanceId}`;
      path.witnesses = [fi.requirementLineageId];
      path.seed_case_id = fi.facetInstanceId;
      path.seed_certificate = certificate;
      const decision = path.decisions.find((row) => row.question === fi.targetQuestionId)!;
      decision.select = chosen.map((option) => option.label);
      decision.source = `sealed-seed:${certificate.certificateHash}`;
      decision.seed_certificate_hash = certificate.certificateHash;
      path.signature = pathSignature(path.decisions, path.back_navigation);
      generated.push({
        alternativeId,
        caseId: fi.facetInstanceId,
        basePathId,
        questionId: certificate.targetQuestionId,
        estimatedSteps: path.steps,
        certificate,
        path,
      });
    }
    if (!found) break;
  }

  const alternatives: SeedAlternative[] = [];
  const dropped: SeedDropRow[] = [];
  const perQuestion = new Map<string, number>();
  const perBase = new Map<string, number>();
  let selectedSteps = 0;
  for (const candidate of generated) {
    let reason: SeedDropRow["reason"] | null = null;
    if ((perQuestion.get(candidate.questionId) ?? 0) >= budget.perQuestionCap) reason = "per-question-cap";
    else if ((perBase.get(candidate.basePathId) ?? 0) >= budget.perBasePathCap) reason = "per-base-path-cap";
    else if (alternatives.length >= budget.attemptCap) reason = "attempt-cap";
    else if (selectedSteps + candidate.estimatedSteps > budget.stepCap) reason = "step-cap";
    if (reason) {
      dropped.push({ alternativeId: candidate.alternativeId, caseId: candidate.caseId, reason, count: 1 });
      continue;
    }
    alternatives.push(candidate);
    selectedSteps += candidate.estimatedSteps;
    perQuestion.set(candidate.questionId, (perQuestion.get(candidate.questionId) ?? 0) + 1);
    perBase.set(candidate.basePathId, (perBase.get(candidate.basePathId) ?? 0) + 1);
  }
  const omittedCandidateCount = candidateCount - generated.length;
  if (omittedCandidateCount > 0) {
    dropped.push({ alternativeId: "candidate-population-after-cap", caseId: "*", reason: "candidate-cap", count: omittedCandidateCount });
  }
  const selectedCases = new Set(alternatives.map((row) => row.caseId));
  const residualCaseIds = optionCases.map((row) => row.facetInstanceId).filter((id) => !selectedCases.has(id));
  return {
    alternatives,
    census: {
      authorityRows: optionCases.length,
      eligibleRows,
      withheldRows: withheld.length,
      candidateCount,
      materializedCandidateCount: generated.length,
      omittedCandidateCount,
      withheldCombinationCount,
      withheldCombinationReason: "control-cardinality-not-sealed",
      selectedCount: alternatives.length,
      droppedCount: candidateCount - alternatives.length,
      residualCaseIds,
      candidatesTruncated: omittedCandidateCount > 0,
      selectedEstimatedSteps: selectedSteps,
      budget,
      withheld,
      dropped,
    },
  };
}

export interface PlannedOccurrenceIdentity {
  occurrenceId: string;
  occurrenceIndex: number;
  historyDigest: string;
}

/**
 * Stamp stable path-history identity independently of runtime capture identity.  A future
 * receipt must join this `occurrenceId` and `historyDigest` to the performed transition;
 * `presentationHash` remains a separate runtime fact (`screenSignatureHash`).
 */
type PlannedOccurrenceCarrier = {
  decisions: PlannedDecision[];
  signature?: string;
  back_navigation?: unknown;
};

export async function stampPlannedOccurrenceIdentity(paths: PlannedOccurrenceCarrier[]): Promise<number> {
  let stamped = 0;
  for (const path of paths) {
    // Structural history is prefix-only: it cannot depend on future decisions in a full-path
    // signature. Runtime receipts separately hash every performed pre-target transition.
    let historyDigest = `sha256:${await canonicalHash({ kind: "planned-occurrence-history-root/1" })}`;
    const seen = new Map<string, number>();
    for (const decision of path.decisions) {
      const question = String(decision.question ?? "");
      const occurrenceIndex = seen.get(question) ?? 0;
      seen.set(question, occurrenceIndex + 1);
      const occurrenceId = `occ_${(await canonicalHash({ question, occurrenceIndex, historyDigest })).slice(0, 24)}`;
      decision.occurrence_id = occurrenceId;
      decision.occurrence_index = occurrenceIndex;
      decision.history_digest = historyDigest;
      const transition = {
        question,
        occurrenceIndex,
        select: decision.select ?? [],
        textEntry: decision.text_entry?.value ?? null,
        action: decision.action ?? null,
      };
      historyDigest = `sha256:${await canonicalHash({ prior: historyDigest, transition })}`;
      stamped += 1;
    }
  }
  return stamped;
}
