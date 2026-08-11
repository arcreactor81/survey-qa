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
import type { DocumentCoverage } from "../extract/types";

// ---------------------------------------------------------------------------
// Run envelope — v2's answer to prod's RunEnvelope (src/store.ts)
// ---------------------------------------------------------------------------

export const ENVELOPE_KIND = "survey-qa-v2-envelope" as const;
export const ENVELOPE_SCHEMA = "v2-run-envelope/1.0.0" as const;

/**
 * The denominator source is explicit and durable. It is never inferred from which files
 * happen to exist: that would let recovery restart the same run through a different reader.
 * Optional only for envelopes written before this discriminator existed; those mean extract.
 */
export type ContractSourceInput =
  | { mode: "extract" }
  | {
      mode: "human-authored";
      humanRequirementsKey: string;
      humanRequirementsSha256: string;
    };

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
    contractSource?: ContractSourceInput;
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
  /**
   * Structural table-origin coordinates whenever this atom came from a table cell. `kind` may
   * be `table-cell`, or an origin-bearing paragraph/list block lifted from that cell; `kind`
   * alone is therefore not the provenance discriminator.
   */
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
  /** Digest of the complete stitched display quote; distinct from each source atom digest. */
  displayQuoteHash?: string;
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

/**
 * ONE ANSWER OPTION THE DOCUMENT STATES, READ OUT OF THE DOCUMENT'S OWN QUOTE.
 *
 * `label` is the respondent-visible text and is the only field an accusation may rest on.
 * `code` is the document's answer code where the quote carried one — a MATCH KEY and never
 * an accusation in its own right, because a site is free to number its inputs however it
 * likes (`value="0"`-based, a GUID, a position). See `OptionSetPayload`.
 */
export interface DocumentedOption {
  code: string | null;
  label: string;
}

/**
 * Closure is a separate claim from positive option membership. A membership case can be fully
 * typed while the compiler still lacks language-neutral evidence that the document says
 * "these and no others". Recording that state prevents `exhaustive: false` from silently
 * meaning both "the document leaves the set open" and "this compiler did not evaluate it".
 */
export const OPTION_SET_CLOSURE_ASSESSMENT = Object.freeze({
  ESTABLISHED: "OPTION_SET_CLOSURE_ESTABLISHED",
  EVIDENCE_INCOMPLETE: "OPTION_SET_CLOSURE_EVIDENCE_INCOMPLETE",
  NOT_EVALUATED: "OPTION_SET_CLOSURE_NOT_EVALUATED",
} as const);

export type OptionSetClosureAssessment =
  | {
      status: "established";
      code: typeof OPTION_SET_CLOSURE_ASSESSMENT.ESTABLISHED;
      detail: string;
    }
  | {
      status: "not-established";
      code: typeof OPTION_SET_CLOSURE_ASSESSMENT.EVIDENCE_INCOMPLETE;
      detail: string;
    }
  | {
      status: "not-evaluated";
      code: typeof OPTION_SET_CLOSURE_ASSESSMENT.NOT_EVALUATED;
      detail: string;
    };

/**
 * WHAT THE DOCUMENT SAYS A QUESTION MUST OFFER — a MEMBERSHIP claim, not a set.
 *
 * ==================== WHY MEMBERSHIP AND NOT A SET ====================
 *
 * Extraction states option lists ONE ROW PER OPTION far more often than it states them as a
 * set — measured on three real sealed revisions: `"Q3 offers 'NURTEC' as an answer option."`,
 * `"S3 includes the response option 'Advertising or public relations' with code 3."`,
 * `"Q2 includes option 1: 'Yes, a daily oral preventive'."`. A row like that entails exactly
 * one thing: THIS option must be offered. It does NOT entail that the question offers no
 * others, and a payload that quietly upgraded it to a set would accuse every survey that
 * carries an "Other" or a "Prefer not to say" the document lists elsewhere.
 *
 * So `asserted` is what this requirement CLAIMS, `siblings` is context, and `exhaustive` is
 * the one flag that licenses an absence claim about the SITE'S extra options — set only when
 * the requirement's own words close the set (`"exactly the following five … and no others"`)
 * AND the document quote yields that many options.
 *
 * ==================== WHERE THE BYTES COME FROM ====================
 *
 * `label` and `code` are parsed from the requirement's `displayQuote` — the VERBATIM span of
 * the source document — and then required to be corroborated by the model's own
 * `normativeStatement`. A model that paraphrased an option ("25-34" for "25 to 34") fails the
 * corroboration and the row refuses. That is what keeps a model out of the verdict path here:
 * the model chose WHICH SPAN to point at; the document supplied the bytes that are compared.
 */
export interface OptionSetPayload {
  /** The option(s) THIS requirement says the question must offer. Never empty when sealed. */
  asserted: DocumentedOption[];
  /**
   * Options the document states for the SAME question in OTHER requirements. CORROBORATION
   * ONLY — never an accusation, and never an exhaustiveness claim. Its single job is to let a
   * predicate establish that the site's answer CODES mean the same thing the document's do
   * before any comparison keyed on a code is allowed to fire.
   */
  siblings: DocumentedOption[];
  /**
   * The requirement CLOSES the set in its own words and the quote yields the count it states.
   * Only an exhaustive payload can support "the site offers an option the document does not".
   */
  exhaustive: boolean;
  /** Computed coverage for the distinct closed-set/extra-option claim. */
  closureAssessment: OptionSetClosureAssessment;
}

export interface FacetCase {
  kind: "route" | "boundary" | "configuration" | "rendered-state" | "copy" | "option-set";
  routeAnswer: RouteAnswerPayload | null;
  boundaryInput: BoundaryInputPayload | null;
  configuration: CaseConfigurationPayload | null;
  expectedDestination: ExpectedDestinationPayload | null;
  /**
   * REQUIRED-NULLABLE like the four above, and for the reason stated there: an OPTIONAL field
   * lets a producer mint a case that looks decidable by omitting it. `null` on every kind but
   * `option-set`, and on an `option-set` case the expander could not read.
   */
  optionSet: OptionSetPayload | null;
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
  /**
   * AN OPTION LIST THE DOCUMENT DOES NOT ATTACH TO A QUESTION. Measured on the real sealed
   * revisions: a fifth of option rows sit under `scope: "survey"` and describe DIFFERENT
   * questions while all claiming code 1 — "18 to 24", "Every day", "Male". Binding one of
   * those to a question by document PROXIMITY is a one-in-three chance of telling a driver
   * that "Male" answers a coffee-frequency question, and attaching it to the wrong question
   * in the VERIFIER accuses a survey that is behaving perfectly. There is no arm that guesses.
   */
  OPTION_SET_NOT_BOUND_TO_A_QUESTION: "OPTION_SET_NOT_BOUND_TO_A_QUESTION",
  /**
   * The requirement is an option rule whose `displayQuote` yields no option line this expander
   * can read — a scale header (`"[SCALE — COLUMNS, IN THIS ORDER:]"`), a rating range
   * (`"[RATING SCALE 0–10]"`), a programmer note about ORDER. The labels exist only inside the
   * model's prose there, and prose is not the document.
   */
  OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE: "OPTION_SET_NOT_READ_FROM_THE_DOCUMENT_QUOTE",
  /**
   * The cited source block is visible document material, but its parser-origin role says it
   * is not an answer-list member: currently an open combo-box suggestion or a ruby phonetic
   * reading. Parsing its short text as an option could mint a missing/extra-option accusation
   * against the wrong kind of UI, so the case remains counted and explicitly untyped.
   */
  OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST: "OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST",
  /**
   * Every option line the quote yielded was contradicted by the requirement's own statement:
   * the statement does not contain the label the quote carries. One of the two readings of
   * this requirement is wrong and nothing here can say which, so no expectation is minted.
   */
  OPTION_LABEL_NOT_CORROBORATED_BY_THE_STATEMENT: "OPTION_LABEL_NOT_CORROBORATED_BY_THE_STATEMENT",
  /**
   * The requirement is scoped to one question and its statement names a DIFFERENT question the
   * document knows. Two readings of which question the options belong to, and an option set
   * compared against the wrong screen is the failure this whole module is arranged to avoid.
   */
  OPTION_SET_QUESTION_AMBIGUOUS: "OPTION_SET_QUESTION_AMBIGUOUS",
  /**
   * The document explicitly states that an option must NOT be offered. `OptionSetPayload`
   * currently represents positive membership only, so feeding this row to that predicate
   * would invert the document and accuse a compliant survey of MISSING the forbidden option.
   * The row stays counted and untyped until a polarity-bearing payload and predicate exist.
   */
  OPTION_SET_NEGATIVE_PREDICATE_NOT_AVAILABLE: "OPTION_SET_NEGATIVE_PREDICATE_NOT_AVAILABLE",
  /**
   * 1.7.0 — The quote carried at least one candidate option line the parser could not classify
   * safely: a trailing-colon shape ("Other (please specify):"), a two-sentence or over-long
   * label, or bracketed/symbol-only text whose structural role was not established. The whole
   * case is untyped and carries no `optionSet` payload. Some labels may have parsed safely, but
   * this schema has no separate place for "membership checked; closure unread"; putting a
   * payload beside `expectationGap` would contradict the invariant below and still let the
   * verifier mint a verdict from a case coverage calls untyped.
   */
  OPTION_SET_QUOTE_LINE_UNPARSED: "OPTION_SET_QUOTE_LINE_UNPARSED",
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

export interface HumanContractApproval {
  kind: "human-authored";
  gates: {
    inputSchemaValid: GateOutcome;
    documentHashBound: GateOutcome;
    allSourceSpansBound: GateOutcome;
    identitiesUnique: GateOutcome;
    allScopedExpansionsPreviewed: GateOutcome;
  };
}

export type RequirementsProvenance =
  | {
      method: "dual-model-extraction";
      expanderVersion: string;
    }
  | {
      method: "human-authored";
      authoringSchema: "v2-human-requirements/1.0.0";
      normalizedInputHash: string;
      validatorVersion: string;
      expanderVersion: string;
      authoredBy: string;
      authoredAt: string;
      /** The file supplies this label; the current seam does not bind it to an Access principal. */
      authorshipAssurance: "self-asserted";
      /** Honest limit: this path validates submitted rows; it does not rediscover omissions. */
      coverageClaim: "authored-requirements-only";
      /** Computed parser coverage, including unread and deliberately skipped archive parts. */
      documentCoverage: DocumentCoverage;
      /** Named, sealed limits that the final report must surface rather than silently omit. */
      limitations: string[];
      /** Exact-span provenance does not prove that the author's paraphrase entails the quote. */
      transcriptionAssumption:
        "authored-statements-and-expansion-hints-are-trusted-transcriptions-not-mechanically-proven-entailments";
    };

export interface ContractRevision {
  schemaVersion: "v2-contract-revision/1.0.0" | "v2-contract-revision/1.1.0";
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
  /** Present on 1.1 revisions; legacy 1.0 revisions retain their historical identity. */
  requirementsProvenance?: RequirementsProvenance;
  /** Human-authored revisions use method-specific gates instead of pretending two model passes ran. */
  approval?: HumanContractApproval;
  extraction: {
    method?: "dual-model-extraction" | "human-authored";
    /**
     * Content hash of every extraction input/policy that made this model denominator reusable.
     * Absent on historical 1.0 revisions; null on human-authored revisions, which never use the
     * model-extraction reuse index.
     */
    reuseInputsHash?: string | null;
    passAHash: string | null;
    passBHash: string | null;
    sourceLedgerHash: string;
    diffHash: string | null;
    reviewMode: "always" | "high-risk-only" | "human-authored";
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

/**
 * WHAT QUALIFIES EVERY RESULT IN THE RECORD — not a finding about a requirement.
 *
 * A `DefectClaim` is a pointer at ONE requirement, carrying its evidence through the
 * observation it names. Some of the most serious things a run learns fit neither half: the
 * target crashed on load and rendered nothing (no case closed, so no observation exists to
 * point at, and its evidence witnesses every requirement at once); the run only continued by
 * injecting a shim, so nothing observed afterwards describes the survey as served; the
 * execution ledger could not be read at all. Those are facts a reader must hold while reading
 * ANY verdict here, and this is where they live.
 *
 * Distinct from `run-workflow.ts#testAxisBlockers`, which is bookkeeping about whether the
 * run's test axis may close and which takes the assembled record as an input — so it could
 * not be a field of the record even in principle.
 *
 * NO SEVERITY AND NO CONFIDENCE FIELD, for the same reason `findingFromClaim` emits
 * `severity: null`: neither is derivable from the evidence, so a slot for one is an invitation
 * to invent one.
 */
export type RunBlockerKind =
  /** A walk recorded `loadCrash` — the page threw and rendered no question. */
  | "TARGET_FAILED_TO_LOAD"
  /** At least one walk ran against a page this harness patched. */
  | "OBSERVATIONS_MADE_AGAINST_SHIMMED_TARGET"
  /** No execution ledger, so nothing above can be said either way. */
  | "EXECUTION_LEDGER_UNAVAILABLE"
  /** A failing case cites an observation this record does not carry. */
  | "UNRESOLVED_FAIL_OBSERVATION"
  /** The plan requests a probe action for which the current executor can emit no receipt. */
  | "PLANNED_PROBE_NOT_EXECUTED";

export interface RunBlocker {
  blockerId: string;
  kind: RunBlockerKind;
  pathId: string | null;
  attemptId: string | null;
  /** The executor's own closed outcome word, e.g. `load-crash`. Never a verdict. */
  outcome: string | null;
  shimmed: boolean | null;
  at: string | null;
  /** Verbatim from the producer — the page's own error text, never a paraphrase. */
  detail: string;
  /** Ids that must exist in this record's own `evidence[]` catalogue. */
  evidenceIds: string[];
  observationRefs: string[];
  /** Count and exact identities copied from the planner's capability limitation. */
  count?: number | null;
  pathIds?: string[];
  /** The subset whose absence prevents the test axis closing. */
  blockingPathIds?: string[];
  derivedBy: string;
}

/**
 * A GENUINE DOCUMENT AMBIGUITY, CARRIED IN THE RECORD RATHER THAN DROPPED.
 *
 * CLAUDE.md: "Genuine document ambiguity is SURFACED AS A QUESTION, never guessed." The
 * extraction finds these, the seal keeps them (as `assertionStatus` on the requirement, and
 * as readings in the run's own checklist), and the record used to declare `ambiguities: []`
 * unconditionally — the same disconnected wire as `claims`, one field over. A reader of that
 * record sees a document nobody had a question about.
 *
 * `readings` is the pair the extraction wrote, VERBATIM, or an EMPTY array with
 * `readingsAvailable: false`. The two are different facts: an ambiguity sealed as a token
 * carries no recoverable readings (see `checklist-projection.mjs`), and reporting that as
 * "an ambiguity with nothing to say" would be the quietly-shorter-list failure again.
 */
export interface AmbiguityRecord {
  ambiguityId: string;
  /**
   * `ambiguous` / `disputed` — the SEALED requirement's own assertion status.
   * `extraction-declared` — an ambiguity the extraction wrote down that binds to no sealed
   * requirement by the one exact rule below. It is reported UNBOUND rather than attached to
   * a requirement by guesswork.
   */
  status: Extract<AssertionStatus, "ambiguous" | "disputed"> | "extraction-declared";
  /**
   * null ONLY for `extraction-declared`. THE BINDING RULE, STATED (CLAUDE.md: no silent
   * reliance on a convention): a checklist ambiguity binds to a requirement when its
   * `doc_quote` is EXACTLY the requirement's `displayQuote` after trimming. Nothing fuzzy,
   * nothing positional. When it does not match, the ambiguity is emitted unbound and says so.
   */
  normativeRef: { requirementLineageId: string; requirementVersionId: string } | null;
  /** The requirement's own sentence, verbatim. "" when unbound. */
  statement: string;
  /** The document's own copy, verbatim. */
  documentQuote: string;
  /** The competing readings, verbatim from the extraction, or []. */
  readings: string[];
  /** FALSE when only a sealed token survives, so [] cannot read as "no readings exist". */
  readingsAvailable: boolean;
  /** The extraction's own "why", verbatim. null when only the seal survives. */
  whyAmbiguous: string | null;
  /** What the extraction said this touches, verbatim. */
  affects: string[];
  derivedBy: string;
}

/**
 * A CASE THE SYSTEM MATERIALIZED AND HAS NO WAY TO CHECK.
 *
 * `FacetInstance.expectationGap` is REQUIRED on every sealed case and states, in a closed
 * code, why no model-free predicate can decide it. Every one of them is a limit of THIS
 * SYSTEM'S taxonomy, not a finding about the customer's survey — which is precisely why it
 * belongs in a counted list rather than nowhere: a run reporting 227 requirements and no
 * taxonomy gaps claims a coverage it does not have.
 *
 * It is NOT a `DefectClaim`. A claim points at an observation; a gap is the absence of one.
 */
export interface TaxonomyGapRecord {
  gapId: string;
  /** The closed `EXPECTATION_GAP` code the expander sealed. */
  code: ExpectationGapCode | string;
  /** The expander's own words, verbatim, including the unbindable text it quoted. */
  detail: string;
  facetInstanceId: string;
  caseKind: string;
  normativeRef: { requirementLineageId: string; requirementVersionId: string };
  derivedBy: string;
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
  /**
   * NULLABLE, because the execution ledger records when a walk ENDED (`at`) and how long it
   * ran (`wallMs`); the start is the subtraction of the two and is unavailable when either is.
   * A fabricated start time would make a duration in the report unfalsifiable.
   */
  startedAt: string | null;
  endedAt: string | null;
  ok: boolean;
  stopReason: string | null;
  /** Catalogue entries stamped with this walk's route AND attempt. */
  evidenceIds: string[];
  /**
   * TRUE when another walk row carries the same path AND attempt — the executor retries a
   * crashed path under the SAME attempt id, and the catalogue has no walk-level key, so the
   * ids above cannot be split between the two rows. Stated rather than silently over-counted.
   */
  evidenceSharedWithSiblingWalks: boolean;
  /** The projection that derived this row. Never a model, and never a caller. */
  derivedBy: string;
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

/**
 * WHERE THIS REVISION SITS IN THE RUN'S CHAIN OF SIGNED ACCOUNTS.
 *
 * ================== WHY A RUN NEEDS MORE THAN ONE SIGNED RECORD ==================
 *
 * The record is the judge's INPUT: `mintJudgement` reads it, re-derives every verdict from
 * the artifact bytes, and binds its JudgementRecord to this record's `attestation.payloadHash`.
 * A record that contained the judgement's own outcome would therefore have to contain a hash
 * of itself. So revision 1 MUST be signed before the judgement runs, and no reordering of
 * stages can change that.
 *
 * What was wrong is not the order — it is that NOTHING WAS SIGNED AFTERWARDS. Run 4 was
 * signed at 02:28:03; `mint-judgement` then failed with EVIDENCE_NAME_COLLISION at 02:29:57,
 * and that failure existed only in stdout. A customer verifying the signature got
 * cryptographic confidence in a document that could not say the judgement never happened.
 *
 * SUPERSEDE, NEVER MUTATE. Revision 1's bytes are preserved, unchanged and still
 * signature-valid, at their own content-addressed key; the judgement's binding to them still
 * resolves. Revision 2 is a NEW signed document that names revision 1's payload hash and adds
 * what only closure could know. Nothing is edited in place, ever.
 */
export interface RecordRevisionRef {
  /** The superseded revision's `attestation.payloadHash` (or its canonical payload hash when unsigned). */
  recordHash: string;
  revision: number;
  signedAt: string | null;
  /** Why a further revision exists at all — a sentence, not a code. */
  reason: string;
}

export interface RecordRevisionInfo {
  /** 1 for the record the judge binds to; 2+ for each superseding revision. */
  revision: number;
  /** null on revision 1. */
  supersedes: RecordRevisionRef | null;
  /**
   * THE PAYLOAD HASH OF REVISION 1 — the one a JudgementRecord binds to — carried forward
   * through every later revision. `null` on revision 1 itself, which cannot contain its own
   * hash without changing it.
   *
   * `store/judgement.ts#checkJudgementBinding` recomputes the payload hash of whatever record is
   * currently stored and requires the judgement to name it. Without this field, superseding
   * would silently demote every re-derived column to `unusable`. `supersedes.recordHash` alone
   * is insufficient: it names only the immediately preceding revision, so a third revision would
   * orphan a judgement bound to the first.
   */
  originalRecordHash: string | null;
}

/**
 * WHAT HAPPENED AFTER REVISION 1 WAS SIGNED — the only thing a superseding revision adds.
 *
 * `judgement.boundRecordHash` is the hash the judge actually bound to, so a reader can check
 * that the judgement in hand belongs to the prior revision of THIS chain rather than to some
 * other document.
 */
export interface RunClosure {
  judgement: {
    minted: boolean;
    /** The judge's own status word when it ran; null when it did not. */
    status: string | null;
    /** The closed reason code when it did NOT run, e.g. `EVIDENCE_NAME_COLLISION`. */
    reasonCode: string | null;
    detail: string | null;
    boundRecordHash: string | null;
  };
  testAxis: {
    closed: boolean;
    /** The checkpoint's `completion.test` after the gate ran. */
    completion: string;
    reasonCode: string | null;
    /** Verbatim sentences from `testAxisBlockers`; empty when the axis closed. */
    blockers: string[];
  };
  closedAt: string;
  derivedBy: string;
}

/**
 * THE IDENTITY OF THE THING THAT WAS TESTED, stated by the record itself.
 *
 * `run.targetBuildId` is the RECORDED id and stays exactly that — the report's precedence
 * treats a recorded id as owner-declared and binds judgements to it, so writing a derived
 * value there would relabel a fallback as a declaration. This sibling carries the resolved
 * identity WITH ITS PROVENANCE, so a record whose `targetBuildId` is null can still answer
 * "what was tested" instead of being unable to say.
 */
export interface RecordTargetIdentity {
  targetBuildId: string | null;
  source: "recorded" | "override" | "derived" | "none";
  note: string;
}

export interface RunRecordV2 {
  schemaVersion: "run-record/2.0.0";
  kind: typeof RUN_RECORD_KIND;
  runId: string;
  /**
   * Present from revision 1. A record with no `recordRevision` predates this chain and must
   * be read as revision 1 with an unknown successor — never as "the final word".
   */
  recordRevision: RecordRevisionInfo;
  /** null on revision 1, by construction: nothing had closed when it was signed. */
  closure: RunClosure | null;
  /** ONE immutable revision. The run may not regenerate its own denominator. */
  contract: { contractRevisionId: string; contractHash: string };
  run: {
    startedAt: string;
    endedAt: string | null;
    surveyUrl: string;
    documentSha256: string;
    /** Coherent target identity. Mixed-build runs are INVALID (merged-contract §0). */
    targetBuildId: string | null;
    /**
     * The RESOLVED identity and where it came from. Derived by the assembler from this run's
     * own evidence catalogue when nothing was recorded or configured, so `targetBuildId: null`
     * stops meaning "this record cannot say what was tested".
     */
    targetIdentity: RecordTargetIdentity;
    locale: string;
    viewports: string[];
  };
  /**
   * The attempt ledger. Present because the report path requires it: a record without it
   * could be assembled, stored and served, and then fail at render time with "not a
   * RunRecord" — which is exactly what D12 found. See report/renderable.ts for the single
   * validated interface both this type and the harness v1 shape are checked against.
   */
  /**
   * DERIVED BY THE ASSEMBLER FROM THE EXECUTION LEDGER, never supplied. It WAS a parameter,
   * and the one caller passed `attempts: []` — the identical disconnected wire that made
   * `claims` empty, one field over, and it was re-introduced in the very commit that fixed
   * claims. A ledger a caller may omit is a ledger that will be omitted.
   */
  attempts: AttemptRecordV2[];
  observations: Observation[];
  /**
   * DERIVED BY THE ASSEMBLER FROM `itemResults` + `observations`, never supplied. It was a
   * parameter, and a run with two real `contradicted` verdicts signed `claims: []` because
   * the caller passed one. See `assemble-record.mjs#deriveClaims`.
   */
  claims: DefectClaim[];
  /**
   * The document's own open questions. DERIVED, never supplied — see `AmbiguityRecord`. An
   * empty array now means the sealed revision flagged nothing ambiguous, which is a claim
   * about the document rather than about the wiring.
   */
  ambiguities: AmbiguityRecord[];
  /** Cases this system materialized and has no predicate for. DERIVED — see `TaxonomyGapRecord`. */
  taxonomyGaps: TaxonomyGapRecord[];
  blockers: RunBlocker[];
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
    /**
     * WHETHER `modelCalls` ABOVE IS THE WHOLE STORY. `checkpoint.modelCallLedger` does not
     * exist on `RunCheckpoint` and never has, so `modelCalls` has always been `[]` — and `[]`
     * beside `totals.modelCalls: 47` is indistinguishable from a run that made no calls at all.
     * `unrecorded` says the cost in `totals` cannot be checked against per-call rows from this
     * record; `no-calls` says the empty list is the complete truth.
     */
    perCallTelemetry: "recorded" | "unrecorded" | "no-calls";
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
