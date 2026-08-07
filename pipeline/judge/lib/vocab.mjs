/**
 * judge/lib/vocab.mjs — the closed vocabularies of the derived-verdict engine.
 *
 * Nothing in the judge may emit a status string that is not defined here.
 * The whole point of this module is that verdicts are drawn from a fixed,
 * versioned enumeration instead of being written as prose by a model.
 */

export const ENGINE_VERSION = '2.0.0';

/** Two-axis status, per docs/ui-report-redesign.md §2.6. */
export const COVERAGE = Object.freeze({
  EXERCISED: 'exercised',
  NOT_REACHED: 'not-reached',
  PROVEN_UNREACHABLE: 'proven-unreachable',
  BLOCKED: 'blocked',
  PENDING: 'pending',
});

export const VERDICT = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
  NOT_ASSESSED: 'not-assessed',
});

/** The answer key's finding taxonomy (DEBRIEF fix #5). The judge must choose one. */
export const DISPOSITION = Object.freeze({
  DEFECT: 'defect',
  QUERY: 'query',
  AMBIGUITY: 'ambiguity',
  OUT_OF_SCOPE: 'out-of-scope',
  NONE: 'none',
});

/** What a predicate is allowed to return. Never prose, never a score. */
export const OUTCOME = Object.freeze({
  SATISFIED: 'satisfied',
  VIOLATED: 'violated',
  INSUFFICIENT: 'insufficient', // observations exist but do not decide the predicate
  NO_OBSERVATION: 'no-observation', // nothing on disk exercises this obligation
  ERROR: 'error', // evidence integrity failure — never a pass
});

/** Reason codes. Closed registry; the report renders these, not free text. */
export const REASON = Object.freeze({
  // pass
  POSITIVE_WITNESS: 'POSITIVE_WITNESS',
  COMPLETE_POSITIVE_INVENTORY: 'COMPLETE_POSITIVE_INVENTORY',
  // fail
  ROUTE_DESTINATION_MISMATCH: 'ROUTE_DESTINATION_MISMATCH',
  ROUTE_SKIPPED_SCREEN_SHOWN: 'ROUTE_SKIPPED_SCREEN_SHOWN',
  SCREEN_SHOWN_OUTSIDE_BASE: 'SCREEN_SHOWN_OUTSIDE_BASE',
  SCREEN_MISSING_FOR_ELIGIBLE_SESSION: 'SCREEN_MISSING_FOR_ELIGIBLE_SESSION',
  OPTION_ABSENT: 'OPTION_ABSENT',
  OPTION_LABEL_MISMATCH_AT_CODE: 'OPTION_LABEL_MISMATCH_AT_CODE',
  OPTION_PRESENCE_INCONSISTENT: 'OPTION_PRESENCE_INCONSISTENT',
  OPTION_SET_MISMATCH: 'OPTION_SET_MISMATCH',
  OPTION_POSITION_MISMATCH: 'OPTION_POSITION_MISMATCH',
  ORDER_NOT_AS_DOCUMENTED: 'ORDER_NOT_AS_DOCUMENTED',
  ORDER_NOT_RANDOMIZED: 'ORDER_NOT_RANDOMIZED',
  FIXED_OPTION_NOT_LAST: 'FIXED_OPTION_NOT_LAST',
  TEXT_NOT_FOUND: 'TEXT_NOT_FOUND',
  GRID_ROW_ABSENT: 'GRID_ROW_ABSENT',
  GRID_HEADERS_MISMATCH: 'GRID_HEADERS_MISMATCH',
  CONTROL_MISSING_ON_SCREEN: 'CONTROL_MISSING_ON_SCREEN',
  CONTROL_PRESENT_WHERE_FORBIDDEN: 'CONTROL_PRESENT_WHERE_FORBIDDEN',
  MULTIPLE_QUESTIONS_ON_SCREEN: 'MULTIPLE_QUESTIONS_ON_SCREEN',
  PROGRAMMER_INSTRUCTION_LEAKED: 'PROGRAMMER_INSTRUCTION_LEAKED',
  FORBIDDEN_TEXT_DISPLAYED: 'FORBIDDEN_TEXT_DISPLAYED',
  SELECTION_MODE_MISMATCH: 'SELECTION_MODE_MISMATCH',
  MAXLENGTH_MISMATCH: 'MAXLENGTH_MISMATCH',
  MOBILE_LAYOUT_MISMATCH: 'MOBILE_LAYOUT_MISMATCH',
  FIRST_SCREEN_MISMATCH: 'FIRST_SCREEN_MISMATCH',
  // insufficient / not assessed
  NO_TYPED_EXPECTATION: 'NO_TYPED_EXPECTATION',
  NO_OBSERVATION_FOR_OBLIGATION: 'NO_OBSERVATION_FOR_OBLIGATION',
  INVENTORY_INCOMPLETE: 'INVENTORY_INCOMPLETE',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
  NOT_BROWSER_OBSERVABLE: 'NOT_BROWSER_OBSERVABLE',
  IMAGE_ONLY_EVIDENCE: 'IMAGE_ONLY_EVIDENCE',
  // ambiguity precedence
  AMBIGUITY_PRECEDENCE: 'AMBIGUITY_PRECEDENCE',
  // error conditions — evidence integrity
  CITED_ARTIFACT_MISSING: 'CITED_ARTIFACT_MISSING',
  WITNESS_REREAD_FAILED: 'WITNESS_REREAD_FAILED',
  WITNESS_LOCATOR_UNRESOLVED: 'WITNESS_LOCATOR_UNRESOLVED',
  ACTION_NOT_IN_INVENTORY: 'ACTION_NOT_IN_INVENTORY',
  DERIVED_SUMMARY_CITED_AS_PRIMARY: 'DERIVED_SUMMARY_CITED_AS_PRIMARY',
  PASS_WITHOUT_WITNESS: 'PASS_WITHOUT_WITNESS',
  SESSION_INTEGRITY_FAILURE: 'SESSION_INTEGRITY_FAILURE',

  // --- v2 -----------------------------------------------------------------
  // D1: signed evidence authority
  EVIDENCE_AUTHORITY_UNVERIFIED: 'EVIDENCE_AUTHORITY_UNVERIFIED',
  ARTIFACT_NOT_IN_SIGNED_MANIFEST: 'ARTIFACT_NOT_IN_SIGNED_MANIFEST',
  ARTIFACT_HASH_MISMATCH: 'ARTIFACT_HASH_MISMATCH',
  ARTIFACT_OUTSIDE_EVIDENCE_ROOT: 'ARTIFACT_OUTSIDE_EVIDENCE_ROOT',
  UNKNOWN_ARTIFACT_CLASS_CITED: 'UNKNOWN_ARTIFACT_CLASS_CITED',
  // D3: route identity
  ANSWER_DOMAIN_UNSEALED: 'ANSWER_DOMAIN_UNSEALED',
  DOMAIN_CASE_UNEXERCISED: 'DOMAIN_CASE_UNEXERCISED',
  CODE_LABEL_CONFLICT: 'CODE_LABEL_CONFLICT',
  TRIGGER_IDENTITY_UNRESOLVED: 'TRIGGER_IDENTITY_UNRESOLVED',
  // D4: ambiguity loci
  AMBIGUITY_LOCUS_UNRESOLVED: 'AMBIGUITY_LOCUS_UNRESOLVED',
  // D5: proof projections
  PROOF_PROJECTION_MISSING: 'PROOF_PROJECTION_MISSING',
  PROOF_PROJECTION_FAILED: 'PROOF_PROJECTION_FAILED',
  SCOPE_DIGEST_MISMATCH: 'SCOPE_DIGEST_MISMATCH',
  SCOPE_INCOMPLETE_FOR_CLAIM: 'SCOPE_INCOMPLETE_FOR_CLAIM',
  // D6: enforcement probes
  ENFORCEMENT_NOT_DEMONSTRATED: 'ENFORCEMENT_NOT_DEMONSTRATED',
  PROBE_SELF_CONTRADICTORY: 'PROBE_SELF_CONTRADICTORY',
  // D7: session admission
  SESSION_QUARANTINED: 'SESSION_QUARANTINED',
  ACTION_VALUE_NOT_CORROBORATED: 'ACTION_VALUE_NOT_CORROBORATED',
  NOT_A_FORWARD_TRANSITION: 'NOT_A_FORWARD_TRANSITION',

  // --- round 3 -------------------------------------------------------------
  // D2: the evidence a verdict rests on must have been built by the same entry
  // point that holds the authority. An injected store/session set is not.
  EVIDENCE_STORE_NOT_IDENTITY_BOUND: 'EVIDENCE_STORE_NOT_IDENTITY_BOUND',
  // D3: a semantic field the compiler consumes that the signature does not cover
  OBLIGATION_FIELDS_UNBOUND: 'OBLIGATION_FIELDS_UNBOUND',
  // D5: the ambiguity set that governs withholding is not covered by a signature
  AMBIGUITY_SET_UNSIGNED: 'AMBIGUITY_SET_UNSIGNED',
  // D8: a population the scope authority cannot rebuild
  POPULATION_NOT_RECONSTRUCTIBLE: 'POPULATION_NOT_RECONSTRUCTIBLE',
  // D9: eligibility/order inferred from the implementation under test
  ELIGIBILITY_NOT_DOCUMENT_DERIVED: 'ELIGIBILITY_NOT_DOCUMENT_DERIVED',
  // D10: evidence that resolves but does not establish the asserted occurrence
  OCCURRENCE_NOT_PROVEN: 'OCCURRENCE_NOT_PROVEN',
  CONTROL_CENSUS_INCOMPLETE: 'CONTROL_CENSUS_INCOMPLETE',
});

/** D5: closed set of proof projections. A witness names exactly one. */
export const PROOF_KIND = Object.freeze({
  CAPTURE_FIELD: 'capture-field',
  ROUTE_EDGE: 'route-edge',
  INVENTORY_DIGEST: 'inventory-digest',
  PROBE_OUTCOME: 'probe-outcome',
  GATED_OCCURRENCE: 'gated-occurrence',
  // D10 — a claim that a normalized string OCCURS in a capture's rendered copy,
  // re-derived by re-running the normalization and the search. A locator that
  // merely RESOLVES proves the field exists, not that the text is in it.
  TEXT_OCCURRENCE: 'text-occurrence',
  // D10 — the complete control census of one capture: options, text inputs,
  // grids, buttons and named controls, as a single digest. A claim that a screen
  // carries an extra control must cite the census, not one of its columns.
  CONTROL_CENSUS: 'control-census',
});

/** D8: the certification facets, reported separately and never merged. */
export const CERT_FACET = Object.freeze({
  RECORD_AUTHENTIC: 'recordAuthentic',
  EVIDENCE_VALID: 'evidenceValid',
  CONTRACT_REVIEWED: 'contractReviewed',
  RESULTS_REVIEWED: 'resultsReviewed',
  TEST_COMPLETE: 'testComplete',
  DEFECT_FREE: 'defectFree',
});

/** Evidence classes. Only PRIMARY_* may carry a verdict on its own. */
export const EVIDENCE_CLASS = Object.freeze({
  PRIMARY_SESSION: 'primary-session',
  PRIMARY_PROBE: 'primary-probe',
  DERIVED_SUMMARY: 'derived-summary',
  IMAGE: 'image',
  UNKNOWN: 'unknown',
});

export const ALL = Object.freeze({ COVERAGE, VERDICT, DISPOSITION, OUTCOME, REASON, EVIDENCE_CLASS });

export function assertVerdict(v) {
  if (!Object.values(VERDICT).includes(v)) throw new Error(`illegal verdict: ${v}`);
  return v;
}
export function assertReason(r) {
  if (!Object.values(REASON).includes(r)) throw new Error(`illegal reason code: ${r}`);
  return r;
}
