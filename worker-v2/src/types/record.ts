/**
 * v2 record types — RunEnvelope, sealed ContractRevision, Observation, DefectClaim,
 * RunRecord. Deliberately typed to the merged contract (docs/structured-claim-contract-merged.md
 * §1, §4, §5) even though the pipeline bodies are stubs: the whole point of this scaffold
 * is that the SHAPES are right before any behaviour is written against them.
 *
 * THE ONE RULE THAT MOTIVATES ALL OF IT (merged-contract §1, DEBRIEF fix #1):
 * the agent NEVER authors a verdict. It authors an ATTESTED OBSERVATION; the scorer
 * derives the delta. That is why `Observation` has typed payload + completeness +
 * verifier decision + evidence refs and NO verdict field, and why `ItemResult.verdict`
 * is stamped with `derivedBy` so a hand-written verdict is structurally impossible to
 * confuse with a derived one.
 *
 * The first run failed exactly here: the browser captured the divergence, and the
 * verdict-writing step wrote "MATCHES_DOCUMENT" while citing the artifact that proved
 * the opposite. Three false passes came from one unchecked prose step.
 */

import type { GateOutcome } from "../workflow/gates";

// ---------------------------------------------------------------------------
// Run envelope — v2's answer to prod's RunEnvelope (src/store.ts)
// ---------------------------------------------------------------------------

export const ENVELOPE_KIND = "survey-qa-v2-envelope" as const;
export const ENVELOPE_SCHEMA = "v2-run-envelope/1.0.0" as const;

/**
 * COLLISION NOTE. Prod's envelope is
 *   { status: "processing"|"awaiting-claude"|"complete"|"failed", seeded, lang, error, recovery, report }
 * at `runs/{id}/run.json`, read by an unguarded `(await obj.json()) as RunEnvelope`.
 * v2's is a different shape at a different prefix under a different filename WITH a
 * discriminator. `status` is intentionally NOT reused as a field name: v2's lifecycle
 * is two-axis (phase + completion), and a single `status` string is precisely the
 * conflation the redesign removes.
 */
export interface RunEnvelopeV2 {
  schemaVersion: typeof ENVELOPE_SCHEMA;
  kind: typeof ENVELOPE_KIND;
  runId: string;
  createdAt: string;
  /** Workflow instance currently believed to own this run. */
  instanceId: string;
  input: {
    surveyUrl: string;
    documentKey: string;
    documentSha256: string;
    documentName: string;
    /** Coherent target identity — mixed-build runs are INVALID (merged-contract §0). */
    targetBuildId: string | null;
    locale: string;
    viewports: string[];
  };
  profile: "standard" | "deep";
  /** Bound at seal time; a run may never regenerate its own denominator. */
  contractRevisionId: string | null;
  recovery: RunRecoveryV2 | null;
  /** Terminal outcome mirror; the checkpoint remains the live authority. */
  finalCompletion: { test: string; report: string } | null;
}

/** Carried forward from src/store.ts RunRecovery — the shape earned by prod's sweeper. */
export interface RunRecoveryV2 {
  claimId?: string;
  phase?: "claimed" | "restarting" | "recreating" | "failed";
  leaseUntil?: string;
  attempt?: number;
  targetInstanceId?: string;
  startedAt?: string;
  reason?: string;
  unknownStreak?: number;
  lastUnknownAt?: string;
  stallValue?: string;
  stallSeenAt?: string;
}

// ---------------------------------------------------------------------------
// Sealed ContractRevision (merged-contract §0)
// ---------------------------------------------------------------------------

export type AssertionStatus = "entailed" | "explicit-negative" | "document-silent" | "ambiguous" | "disputed";

/** Only `entailed` and `explicit-negative` constrain matching (merged-contract §B). */
export const constrainsMatching = (s: AssertionStatus): boolean =>
  s === "entailed" || s === "explicit-negative";

export interface SourceAtom {
  blockId: string;
  kind: "paragraph" | "table-cell" | "footnote" | "cross-reference" | "heading" | "list-item";
  /** Table coordinates with inherited headers, when kind === "table-cell". */
  coords: { row: number; col: number; rowHeader: string | null; colHeader: string | null } | null;
  role: string;
  atomTextHash: string;
}

/**
 * merged-contract §0 row identity. NEVER derived from Q-number, row position, quote,
 * DOM locator, or content hash alone.
 */
export interface ScopedRequirement {
  requirementLineageId: string;
  requirementVersionId: string;
  semanticFingerprint: string;
  /** "survey" | "section:S2" | "question:Q7" ... */
  scope: string;
  quantifier: "every" | "each" | "only" | "any" | "none" | "specific";
  selector: string | null;
  exceptions: string[];
  facet: string;
  assertionStatus: AssertionStatus;
  testability: "browser-observable" | "not-browser-observable";
  notBrowserObservableReason: string | null;
  sourceAtoms: SourceAtom[];
  composition: string | null;
  /**
   * THE NORMATIVE SENTENCE — what the requirement OBLIGES, in the extraction's own words.
   * Bound by `authority.mjs#bindChecklist` against the checklist obligation's `statement`
   * (`OBLIGATION_TEXT_DRIFT`), and read by every compiler rule that matches on prose.
   *
   * It is NOT the document's copy. Conflating the two is the defect this field exists to
   * make unrepresentable: the projection used to publish one string as both
   * `contract.items[].requirement` (the statement) and `sourceAnchor.quote` (the document
   * quote), so `compile.mjs` built its `text-present` expectations out of the requirement
   * SENTENCE and searched the captured pages for text no page ever contained. Three
   * obligations turned into fabricated TEXT_NOT_FOUND failures and six lost their positive
   * witness. Two different facts need two different fields.
   */
  normativeStatement: string;
  /**
   * THE DOCUMENT'S OWN COPY — the human-readable quote stitched from `sourceAtoms`
   * (merged-contract §A2), carrying zero identity weight but full evidentiary meaning.
   * This is what `sourceAnchor.quote` publishes, what the judge digests against
   * `atomTextHash`, and what the compiler searches captures for.
   */
  displayQuote: string;
  retiredAt: string | null;
}

/**
 * THE TYPED EXECUTION CASE (D12).
 *
 * A FacetInstance used to be five ids, a question id and a certificate. That is enough to
 * COUNT mandatory cases and not enough to SAY WHAT ANY OF THEM IS, so the sealed ledger
 * could not express the "test everything" denominator at all: a routing requirement with
 * four answer codes was one nameless row, and the register had nothing to key a per-case
 * result by. The four payloads below are the four things an execution case can be
 * parameterised by, and every one of them is typed rather than prose — a case a reviewer
 * cannot reproduce from the ledger is not a mandatory case, it is a note.
 *
 * All four are nullable and independent. A rendered-state case carries none of them; a
 * route case carries `routeAnswer` + `expectedDestination`; a validation case carries
 * `boundaryInput`; a case that only exists under one locale/viewport carries
 * `configuration`. Nothing is inferred from anything else.
 */
export interface RouteAnswerPayload {
  /** The document's answer CODE, as written. Never renumbered. */
  code: string | null;
  /** The answer LABEL, verbatim. Matching is by exact code or exact label, never fuzzy. */
  label: string | null;
}

export interface BoundaryInputPayload {
  bound: "min" | "max" | "below-min" | "above-max" | "invalid" | "empty";
  /** The literal input to type. `null` only for `empty`. */
  value: string | null;
  /** What the document says must happen — an expectation, never an observation. */
  expectedOutcome: "accepted" | "rejected" | "unspecified";
}

export interface CaseConfigurationPayload {
  locale: string | null;
  viewport: string | null;
  profileId: string | null;
}

export interface ExpectedDestinationPayload {
  /** Where the route must land. */
  questionId: string | null;
  screen: string | null;
  /** A terminal destination is not a question. `null` when the destination is a question. */
  terminal: "complete" | "screenout" | "quota" | null;
}

export interface FacetCase {
  kind: "route" | "boundary" | "configuration" | "rendered-state" | "copy" | "option-set";
  routeAnswer: RouteAnswerPayload | null;
  boundaryInput: BoundaryInputPayload | null;
  configuration: CaseConfigurationPayload | null;
  expectedDestination: ExpectedDestinationPayload | null;
}

/**
 * WHY A SEALED CASE CARRIES NO EXPECTATION A MODEL-FREE PREDICATE CAN DECIDE.
 *
 * THE DEFECT THIS CLOSES. `FacetCase` is four nullable payloads, so "a route case whose
 * document never named a destination" and "a route case whose destination the expander
 * bound to a question id" were the SAME shape with different nulls. The verifier could
 * only answer `NO_TYPED_EXPECTATION` to both, and the run could not say which of its
 * cases were unverifiable BY CONSTRUCTION and which were unverifiable because extraction
 * had not bound something it should have. The first number is a ceiling on what any run
 * can ever verify; the second is a work item. Collapsing them hides both.
 *
 * A CODE HERE IS A REFUSAL, NOT A FAILURE. Every one of these means "the document, as
 * extracted, does not entail an expectation this case could be checked against" — so the
 * expander declines to invent one. The case still enters the denominator (the document
 * enumerates it; D10 forbids a denominator that shrinks when we cannot discharge it) and
 * it is counted, by code, in the expansion coverage the run reports.
 *
 * THE REGISTRY IS CLOSED. Emitting a code not listed here is not representable, for the
 * same reason `VERIFIER_REASON` is closed: a reader must be able to ask WHY without
 * parsing a sentence, and a free-text reason is how a category quietly becomes a
 * synonym of another one.
 */
export const EXPECTATION_GAP = Object.freeze({
  /**
   * The case kind needs the document's own prose compared against a screen, which is the
   * model verifier's job. Structural for as long as that verifier is unwired — it is not
   * an extraction defect and no better extraction would close it.
   */
  NO_TYPED_PREDICATE_FOR_KIND: "NO_TYPED_PREDICATE_FOR_KIND",
  /**
   * A routing requirement whose answer set the document does not enumerate — most often
   * because it is stated by exclusion ("all codes except 6") or as prose about who
   * reaches a question. Inventing the answers is exactly the D10 violation the expander
   * exists to refuse.
   */
  ROUTE_ANSWERS_NOT_ENUMERATED: "ROUTE_ANSWERS_NOT_ENUMERATED",
  /** The answer is enumerated; no destination was bound to it. An EXTRACTION gap. */
  ROUTE_DESTINATION_NOT_STATED: "ROUTE_DESTINATION_NOT_STATED",
  /**
   * A destination phrase was extracted but does not resolve to any question the document
   * names ("CONTINUE", "the next screen", "Q2 then Q3"). An EXTRACTION gap, and the one
   * that must never be closed by guessing: a guessed destination is an expectation the
   * document never stated, and the verifier would certify or refute it just as happily.
   */
  ROUTE_DESTINATION_NOT_BOUND: "ROUTE_DESTINATION_NOT_BOUND",
  /**
   * The destination is a terminal state. "complete" vs "screenout" vs "quota" is a
   * distinction the DOM does not draw, so no model-free predicate can decide it.
   */
  ROUTE_DESTINATION_TERMINAL: "ROUTE_DESTINATION_TERMINAL",
  /** A validation requirement whose bound the document does not state numerically. */
  INPUT_BOUND_NOT_STATED: "INPUT_BOUND_NOT_STATED",
  /**
   * A LENGTH bound states how long an answer may be. It does not state that a synthetic
   * string of that length IS a valid answer, so "this will be accepted" is not entailed —
   * and a field that rejects the filler for its CONTENT would be reported as a defect it
   * does not have.
   */
  INPUT_CONTENT_NOT_STATED: "INPUT_CONTENT_NOT_STATED",
  /**
   * A min/max SELECTION count is not a literal input to type. `BoundaryInputPayload.value`
   * is documented as "the literal input to type", so writing the count there produces a
   * case that says "type 2 into the field" — which on any numeric field is BOTH a possible
   * false pass and a possible fabricated defect. There is no selection-count payload and
   * no predicate for one, so the honest output is a counted gap.
   */
  SELECTION_BOUND_IS_NOT_A_TEXT_INPUT: "SELECTION_BOUND_IS_NOT_A_TEXT_INPUT",
} as const);

export type ExpectationGapCode = (typeof EXPECTATION_GAP)[keyof typeof EXPECTATION_GAP];

export interface ExpectationGap {
  code: ExpectationGapCode;
  /** What was actually in hand, in words, including the unbindable text verbatim. */
  detail: string;
}

/** Materialized by the deterministic expander: one mandatory floor case per applicable question. */
export interface FacetInstance {
  facetInstanceId: string;
  requirementLineageId: string;
  requirementVersionId: string;
  caseVersionId: string;
  /** Mandatory execution subrow. Exploration NEVER mints one of these. */
  floorCase: true;
  targetQuestionId: string | null;
  expansionCertificate: string;
  /**
   * REQUIRED, not optional. A ledger row with no typed case is a row nothing can be
   * executed against, and an untyped mandatory case is how "the ledger is present" came
   * to coexist with "no case was ever materialized".
   */
  case: FacetCase;
  /**
   * `null` IFF a registered model-free predicate can decide this case from the sealed
   * payload alone. Otherwise the closed code saying why it cannot — see `EXPECTATION_GAP`.
   *
   * REQUIRED, not optional, and for the same reason `case` is: a producer that may omit
   * this can mint a case that LOOKS decidable, and "the ledger is present" comes back to
   * coexisting with "nothing in it could ever be checked". Stating `null` is a claim
   * ("a predicate can decide this"), so it has to be made deliberately.
   */
  expectationGap: ExpectationGap | null;
  /** The screen this case is exercised on, when the document names one. */
  screen: string | null;
  /** Human label. Derived from the typed payload; never the only carrier of meaning. */
  label: string | null;
}

export const CONTRACT_REVISION_KIND = "survey-qa-v2-contract-revision" as const;

export interface ContractRevision {
  schemaVersion: "v2-contract-revision/1.0.0";
  kind: typeof CONTRACT_REVISION_KIND;
  /** IS the sha-256 of the canonical bytes. Immutable by construction. */
  contractRevisionId: string;
  documentRevisionId: string;
  documentSha256: string;
  sealedAt: string;
  requirements: ScopedRequirement[];
  facetInstances: FacetInstance[];
  /** Non-denominator (merged-contract §5). */
  contractSupplements: unknown[];
  extraction: {
    passAHash: string;
    passBHash: string;
    sourceLedgerHash: string;
    diffHash: string;
    reviewMode: "always" | "high-risk-only";
    reviewedBy: string | null;
    reviewedAt: string | null;
    /**
     * Approval gates from merged-contract §0. All four must be `pass` WITH A PROOF to
     * seal.
     *
     * These were four booleans, and two of them were the literal `true` while the other
     * two were `stub() === 0`. A denominator therefore sealed with every gate green over
     * an extraction that had not run. A `GateOutcome` has a third arm — `not-evaluated` —
     * that carries no boolean at all, so an unevaluated gate cannot be read as a passing
     * one, and a passing one has to name the evaluator, its version and the digest of the
     * input it read.
     */
    gates: {
      zeroUnexplainedNormativeBlocks: GateOutcome;
      allConstructClassesDispositioned: GateOutcome;
      allScopedExpansionsPreviewed: GateOutcome;
      noUnresolvedHighRiskDisagreement: GateOutcome;
    };
  };
}

// ---------------------------------------------------------------------------
// Observations — attested, typed, NO verdict
// ---------------------------------------------------------------------------

export type VerifierDecision = "verified" | "contradicted" | "insufficient";

export interface Observation {
  observationId: string;
  facetInstanceId: string;
  attemptId: string;
  routeId: string;
  observedAt: string;
  /** Discriminated by claim-kind registry (merged-contract §4). */
  payloadKind: string;
  payload: unknown;
  /**
   * Negative claims require COMPLETE scoped evidence; partial observation is
   * `unknown`, never "absent" (merged-contract §1).
   */
  completeness: "complete-scoped-inventory" | "partial" | "unknown";
  evidenceIds: string[];
  /**
   * Tri-state. A model verifier produces an atomic decision, never a similarity score.
   *
   * `predicate` and `reason` are the AUDIT TRAIL of that decision: which closed predicate
   * ran, and which closed reason code it returned (`stages/verify-observations.ts`). They
   * are optional because a lifted or fixture observation may carry no verifier run at all —
   * but a decision produced by this Worker always names both, so "verified" can be
   * interrogated rather than merely believed.
   */
  verifier: {
    decision: VerifierDecision;
    evidenceIds: string[];
    verifierVersion: string;
    predicate?: string;
    reason?: string;
    detail?: string | null;
  };
  attestation: { producedBy: string; producerVersion: string; payloadHash: string };
}

/** Pointer-only claim (merged-contract §2). The typed payload lives in observations[]. */
export interface DefectClaim {
  claimId: string;
  claimClass: "defect" | "ambiguity" | "taxonomy-gap";
  claimType: string;
  normativeRef: { requirementLineageId: string; requirementVersionId: string };
  observationRefs: string[];
  /** ZERO matching weight. Never read by the scorer. */
  prose: string;
}

// ---------------------------------------------------------------------------
// Derived results — the scorer's output, never the agent's
// ---------------------------------------------------------------------------

export type CaseStatus =
  | "pass"
  | "fail"
  | "judgment-withheld-ambiguous"
  | "not-reached"
  | "proven-unreachable"
  | "blocked"
  | "budget-exhausted"
  | "time-exhausted"
  | "pending";

export interface FacetResult {
  facetInstanceId: string;
  routeId: string;
  status: CaseStatus;
  observationIds: string[];
}

export interface ItemResult {
  requirementLineageId: string;
  requirementVersionId: string;
  facetResults: FacetResult[];
  /** Deterministic aggregation: FAIL if any case fails; later passes never erase a fail. */
  verdict: "pass" | "fail" | "mixed" | "withheld" | "incomplete";
  pathConsistency: "consistent" | "mixed";
  divergenceSet: string[];
  /**
   * Provenance of the verdict. `derivedBy` is always the aggregator id, never a model.
   * A verdict with a model id here is a contract violation, and the assembler rejects it.
   */
  derivedBy: string;
  resultPolicyVersion: string;
}

// ---------------------------------------------------------------------------
// RunRecord v2
// ---------------------------------------------------------------------------

export const RUN_RECORD_KIND = "survey-qa-v2-run-record" as const;

/**
 * One execution attempt. The record carries its own attempt ledger because the report
 * path needs it and because "how many attempts ran" must be answerable from the signed
 * document alone, not reconstructed from a live checkpoint that keeps moving.
 */
export interface AttemptRecordV2 {
  attemptId: string;
  pathId: string;
  pathLabel: string | null;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  retryReason: string | null;
  /** Execution cases this attempt was routed to exercise. */
  targetCaseIds: string[];
  startedAt: string;
  endedAt: string | null;
  ok: boolean;
  stopReason: string | null;
  evidenceIds: string[];
}

/** Per-call model telemetry. DEBRIEF fix #6: zeroed token counts make cost unfalsifiable. */
export interface ModelCallRecord {
  callId: string;
  role: string;
  provider: string;
  model: string;
  promptVersion: string | null;
  promptHash: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export interface ToolVersionRecord {
  name: string;
  version: string;
  note?: string | null;
}

export interface RunRecordV2 {
  schemaVersion: "run-record/2.0.0";
  kind: typeof RUN_RECORD_KIND;
  runId: string;
  /** ONE immutable revision. The run may not regenerate its own denominator. */
  contract: { contractRevisionId: string; contractHash: string };
  run: {
    startedAt: string;
    endedAt: string | null;
    surveyUrl: string;
    documentSha256: string;
    /** Coherent target identity. Mixed-build runs are INVALID (merged-contract §0). */
    targetBuildId: string | null;
    locale: string;
    viewports: string[];
  };
  /**
   * The attempt ledger. Present because the report path requires it: a record without it
   * could be assembled, stored and served, and then fail at render time with "not a
   * RunRecord" — which is exactly what D12 found. See report/renderable.ts for the single
   * validated interface both this type and the harness v1 shape are checked against.
   */
  attempts: AttemptRecordV2[];
  observations: Observation[];
  claims: DefectClaim[];
  ambiguities: unknown[];
  taxonomyGaps: unknown[];
  blockers: unknown[];
  itemResults: ItemResult[];
  /** Plan hash + per-kind counts. Exploration may ADD findings, never change the denominator. */
  exploration: { planHash: string | null; perKindCounts: Record<string, number>; testComplete: boolean };
  evidence: EvidenceCatalogEntry[];
  /**
   * RESOURCE SHAPE IS SHARED WITH THE RENDERER, NOT PARALLEL TO IT.
   *
   * This block used to declare `modelCalls: number` and `toolCalls: number` while the one
   * renderer both call sites use treats `resources.modelCalls` and `resources.toolVersions`
   * as ARRAYS of per-call telemetry and reads the scalars from `resources.totals`. Two
   * meanings for one field name is how a conforming record renders an empty provenance
   * table and nobody notices. The counts now live in `totals`, where the renderer looks
   * for them, and the arrays keep the names the renderer iterates.
   */
  resources: {
    modelCalls: ModelCallRecord[];
    toolVersions: ToolVersionRecord[];
    totals: {
      costUsd: number;
      modelCalls: number;
      toolCalls: number;
      wallClockMs: number;
      tokens: { input: number; output: number };
    };
    limits: {
      maxUsd: number;
      maxModelCalls: number;
      maxToolCalls: number;
      maxWallClockMs: number;
    };
  };
  versions: {
    aggregator: string;
    resultPolicy: string;
    normalizer: string;
    projection: string;
    registry: string;
  };
  attestation: { recordHash: string; signedAt: string; signer: string } | null;
}

export interface EvidenceCatalogEntry {
  evidenceId: string;
  /**
   * The id this blob carries inside the RunRecord's own `evidence[]` catalogue, when the
   * two namespaces differ. They DO differ, and the report is where it bites: the register
   * cites `EV-EXP-049.json` (record-side), while the storage layer mints `ev_<12>` so an
   * id can never be used as an R2 path. Without this link the report's evidence audit
   * matches nothing and every cited artifact renders un-audited — which is exactly the
   * "cited artifact I cannot check" failure v2 exists to eliminate. null when the run
   * minted the id itself and the two are the same.
   */
  sourceEvidenceId?: string | null;
  /**
   * The path the RUN RECORD cites this blob by, e.g. `runs/<id>/artifacts/EXP-049.json`.
   *
   * It is not decoration. The offline judge resolves an artifact on disk by the BASENAME
   * of this field, and the register's evidence resolver falls back to it when a citation
   * carries no hash. Without it a v2 record's evidence is un-resolvable by name and every
   * artifact the judge is asked to re-read is "not in the signed catalogue".
   *
   * It participates in the evidence id (see ids.ts#evidenceIdFor), so it cannot be
   * repointed after the fact any more than `contentHash` can.
   */
  artifactRef?: string | null;
  /** Content address. The blob lives at v2/evidence/sha256/xx/yy/<hash>. */
  contentHash: string;
  mediaType: string;
  size: number;
  type: "screenshot" | "dom-excerpt" | "trace" | "state" | "har" | "other";
  capturedAt: string;
  attemptId: string | null;
  routeId: string | null;
  /** Ref counting is why retention must be reference-aware, not age-only. */
  witnesses: string[];
}
