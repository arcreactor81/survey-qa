/**
 * judge/lib/certification.mjs — D8. SIX FACETS, NEVER ONE GREEN BADGE.
 *
 * Certification used to be:
 *
 *     certifiable: blockers.length === 0 && counts.byVerdict.fail === 0
 *
 * which is "nothing was withheld and nothing failed". It ignored every other
 * way a run can be unfit to certify: obligations with no typed expectation,
 * obligations never reached, obligations blocked by an evidence-integrity
 * tripwire, inconclusive rows, quarantined sessions, route-table integrity
 * findings and an unverifiable RunRecord. A run in which almost nothing was
 * actually tested certified green.
 *
 * AMENDMENT A of docs/ui-report-redesign.md requires four separate trust
 * statements rather than a generic "Verified"; this is the machine form of
 * that, plus the two completeness axes the contract keeps distinct:
 *
 *   recordAuthentic   the RunRecord's signature, contract binding and evidence
 *                     catalogue all verified
 *   evidenceValid     every artifact read matched its signed hash; no tripped
 *                     integrity wire; no quarantined session
 *   contractReviewed  the judged checklist reproduces a SEALED, reviewed
 *                     ContractRevision (incl. its ambiguity set)
 *   resultsReviewed   every row reached a reviewable derived outcome — no
 *                     untyped rows, no rows blocked by evidence integrity
 *   testComplete      every row was actually exercised
 *   defectFree        no fail, no fail withheld by ambiguity precedence, and
 *                     no observed violation demoted below fail by any other
 *                     route (N3)
 *
 * `certifiable` is their explicit conjunction. Incompleteness can no longer
 * certify by omission, because incompleteness now has its own false facet.
 */

import { VERDICT, COVERAGE, REASON, CERT_FACET, OUTCOME } from './vocab.mjs';

export const CERTIFICATION_VERSION = '1.0.0';

/** Integrity findings that are hard blockers rather than annotations. */
const HARD_INTEGRITY = new Set([
  REASON.SESSION_QUARANTINED,
  REASON.SESSION_INTEGRITY_FAILURE,
  REASON.ACTION_NOT_IN_INVENTORY,
  REASON.ACTION_VALUE_NOT_CORROBORATED,
  REASON.ARTIFACT_HASH_MISMATCH,
  REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST,
  REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT,
]);

export function certify({
  results, authority, routeTable, ambIndex, store, sessions,
  // Round 3 (D7). Certification is a conjunction of SEPARATE facts; these three
  // were either uncomputable or simply absent from it.
  evidenceBinding = null, ambiguityBinding = null, documentModel = null, contractBinding = null,
}) {
  const blockers = [];
  const push = (facet, code, detail, extra = {}) => blockers.push({ facet, code, detail, ...extra });

  // --- recordAuthentic -----------------------------------------------------
  const recordAuthentic = !!(authority && authority.verified);
  if (!recordAuthentic) {
    const why = authority && authority.findings.length ? authority.findings : [{ code: REASON.EVIDENCE_AUTHORITY_UNVERIFIED, detail: 'no signed authority' }];
    for (const f of why) push(CERT_FACET.RECORD_AUTHENTIC, f.code, f.detail, { artifact: f.artifact });
  }

  // --- evidenceValid -------------------------------------------------------
  const storeIntegrity = (store && store.integrity) || [];
  const rtIntegrity = (routeTable && routeTable.integrity) || [];
  const hardFindings = [...storeIntegrity, ...rtIntegrity].filter((i) => HARD_INTEGRITY.has(i.code));
  const quarantined = (sessions && sessions.quarantined) || [];
  const trippedRows = results.filter((r) => r.tripwires && r.tripwires.length);
  // D2: evidence that was not constructed from THIS authority is not valid
  // evidence for a judgement bound to it, however clean each artifact looks.
  const evidenceIdentityBound = !!(evidenceBinding && evidenceBinding.bound);
  const evidenceValid = hardFindings.length === 0 && quarantined.length === 0 && trippedRows.length === 0
    && (!store || store.authoritative) && evidenceIdentityBound;
  if (!evidenceValid) {
    if (!evidenceIdentityBound) {
      push(CERT_FACET.EVIDENCE_VALID, REASON.EVIDENCE_STORE_NOT_IDENTITY_BOUND,
        evidenceBinding && evidenceBinding.problems.length
          ? evidenceBinding.problems.join('; ')
          : 'the evidence this judgement was derived from was not proved to come from the bound authority');
    }
    if (store && !store.authoritative) push(CERT_FACET.EVIDENCE_VALID, REASON.EVIDENCE_AUTHORITY_UNVERIFIED, 'artifacts were read without a signed hash allowlist');
    for (const f of hardFindings.slice(0, 20)) push(CERT_FACET.EVIDENCE_VALID, f.code, f.detail, { session: f.session });
    for (const q of quarantined) push(CERT_FACET.EVIDENCE_VALID, REASON.SESSION_QUARANTINED, `${q.id} was excluded: malformed capture spine`);
    for (const r of trippedRows) push(CERT_FACET.EVIDENCE_VALID, r.tripwires[0].code, r.tripwires[0].detail, { obligationId: r.obligationId });
  }

  // --- contractReviewed ----------------------------------------------------
  //
  // D7 — THREE SEPARATE FACTS, AND THE ONE THAT WAS IMPOSSIBLE.
  //
  // `authority.ambiguitiesSigned` was the constant `false`, so this facet could
  // NEVER be true: certification was unreachable by construction, and a facet
  // that can never be true is not a check, it is a decoration. It is now a
  // checked fact (contract-binding.mjs).
  //
  // Sealing, human review and certification stay THREE facts. A
  // `sealed-unreviewed` revision may satisfy identity binding — it is a real,
  // write-once revision id — but it may not confer review, so this facet
  // requires `humanReviewed` when the record states it and never infers it from
  // sealing. Nor may a heuristic irrelevance decision (D5) pass as review: an
  // ambiguity whose locus was token-derived rather than signed and typed leaves
  // the denominator unreviewed in exactly the way this facet asserts it is not.
  const ambSigned = ambiguityBinding ? ambiguityBinding.signed === true : !!(authority && authority.ambiguitiesSigned);
  const contractFieldsBound = contractBinding ? contractBinding.allBound === true : false;
  const heuristicDeclines = ambIndex && typeof ambIndex.heuristicDeclines === 'number' ? ambIndex.heuristicDeclines : 0;
  // The shared contract module's own vocabulary (`sealedContractRevision`):
  // "sealed"/"reviewed" mean a person signed the extraction off;
  // "sealed-unreviewed" — which every real v2 run emits — means the revision has
  // a write-once identity and NOBODY has reviewed it. It may bind, and it must
  // never certify.
  const humanReviewed = authority && authority.contractHumanReviewed !== undefined
    ? !!authority.contractHumanReviewed
    : (authority && authority.contractReviewState === 'sealed-unreviewed' ? false
      : (authority && (authority.contractReviewState === 'sealed' || authority.contractReviewState === 'reviewed') ? true
        : null));
  const contractReviewed = !!(authority && authority.checklistBound && authority.contractBound && authority.contractSealed)
    && ambSigned && contractFieldsBound && heuristicDeclines === 0 && humanReviewed !== false;
  if (!contractReviewed) {
    if (!authority || !authority.contractBound) push(CERT_FACET.CONTRACT_REVIEWED, 'CONTRACT_REVISION_UNSEALED', 'the judged contract is not pinned inside a verified signature');
    else if (!authority.contractSealed) push(CERT_FACET.CONTRACT_REVIEWED, 'CONTRACT_REVISION_UNSEALED', `the RunRecord carries no sealed ContractRevision (review state: ${authority.contractReviewState})`);
    else if (!authority.checklistBound) push(CERT_FACET.CONTRACT_REVIEWED, 'CHECKLIST_DOES_NOT_REPRODUCE_CONTRACT', 'the checklist being judged diverges from the signed ContractRevision');
    if (!contractFieldsBound) push(CERT_FACET.CONTRACT_REVIEWED, REASON.OBLIGATION_FIELDS_UNBOUND, 'at least one obligation field the compiler consumes is not covered by the signature');
    if (!ambSigned) push(CERT_FACET.CONTRACT_REVIEWED, REASON.AMBIGUITY_SET_UNSIGNED, 'the ambiguity set that governs withholding is not covered by the signature');
    if (heuristicDeclines > 0) {
      push(CERT_FACET.CONTRACT_REVIEWED, 'AMBIGUITY_RELEVANCE_HEURISTIC',
        `${heuristicDeclines} ambiguity suppression(s) were declined on a token-derived locus; irrelevance was not established from a signed typed locus`);
    }
    if (humanReviewed === false) {
      push(CERT_FACET.CONTRACT_REVIEWED, 'CONTRACT_REVISION_UNREVIEWED',
        'the ContractRevision is sealed but NOT human-reviewed; sealing is an identity, not a review');
    }
  }

  // --- resultsReviewed -----------------------------------------------------
  //
  // D7 — an INCONCLUSIVE row has not reached a reviewable derived outcome: it is
  // an open question, and a run full of open questions is not one whose results
  // have been reviewed. It used to be counted and then ignored here, so a run
  // could report `resultsReviewed: true` with every row withheld.
  const untyped = results.filter((r) => !r.expectation);
  const blocked = results.filter((r) => r.coverage === COVERAGE.BLOCKED);
  const inconclusive = results.filter((r) => r.verdict === VERDICT.INCONCLUSIVE);
  const unboundFields = results.filter((r) => r.compiledFieldsBound === false);
  const resultsReviewed = untyped.length === 0 && blocked.length === 0
    && inconclusive.length === 0 && unboundFields.length === 0;
  if (!resultsReviewed) {
    for (const r of untyped.slice(0, 50)) push(CERT_FACET.RESULTS_REVIEWED, REASON.NO_TYPED_EXPECTATION, `${r.obligationId} produced no typed expectation, so nothing was judged`, { obligationId: r.obligationId });
    for (const r of blocked.slice(0, 50)) push(CERT_FACET.RESULTS_REVIEWED, r.reason, `${r.obligationId} is blocked by an evidence-integrity condition`, { obligationId: r.obligationId });
    for (const r of inconclusive.slice(0, 50)) push(CERT_FACET.RESULTS_REVIEWED, r.reason, `${r.obligationId} is inconclusive — an open question, not a reviewed result`, { obligationId: r.obligationId });
    for (const r of unboundFields.slice(0, 50)) push(CERT_FACET.RESULTS_REVIEWED, REASON.OBLIGATION_FIELDS_UNBOUND, `${r.obligationId} was compiled from fields the signature does not cover`, { obligationId: r.obligationId });
  }

  // --- testComplete --------------------------------------------------------
  //
  // D7 — route/domain coverage must never certify. A row decided on a subset of
  // a question's answer domain, or on a domain the document never closed (D6),
  // is exactly "incomplete route coverage", and it used to reach `testComplete`
  // only if it also happened to be un-exercised. `domainIncomplete` was computed
  // and then never used.
  const notExercised = results.filter((r) => r.coverage !== COVERAGE.EXERCISED && r.coverage !== COVERAGE.PROVEN_UNREACHABLE);
  const domainIncomplete = results.filter((r) => r.reason === REASON.DOMAIN_CASE_UNEXERCISED || r.reason === REASON.ANSWER_DOMAIN_UNSEALED);
  const eligibilityUnderived = results.filter((r) => r.reason === REASON.ELIGIBILITY_NOT_DOCUMENT_DERIVED);
  const testComplete = notExercised.length === 0 && domainIncomplete.length === 0 && eligibilityUnderived.length === 0;
  if (!testComplete) {
    for (const r of notExercised.slice(0, 50)) push(CERT_FACET.TEST_COMPLETE, r.reason, `${r.obligationId} coverage=${r.coverage}`, { obligationId: r.obligationId });
    for (const r of domainIncomplete.slice(0, 50)) push(CERT_FACET.TEST_COMPLETE, r.reason, `${r.obligationId}: the question's answer domain is unsealed or was not exercised on every applicable case`, { obligationId: r.obligationId });
    for (const r of eligibilityUnderived.slice(0, 50)) push(CERT_FACET.TEST_COMPLETE, r.reason, `${r.obligationId}: who was eligible for this screen is not a document-derived fact`, { obligationId: r.obligationId });
  }

  // --- defectFree ----------------------------------------------------------
  const fails = results.filter((r) => r.verdict === VERDICT.FAIL);
  const withheldFails = results.filter((r) => r.withheld && r.withheld.certificationBlocker);
  // N3: a row whose PREDICATE observed a violation but whose verdict is not a
  // fail is a defect claim that could not be ASSERTED — an evidence-integrity
  // demotion, not an absence of defects. Before this guard, five predicate
  // classes could be demoted to not-assessed by the D5 scope tripwire and the
  // run still reported `defectFree: true`: a survey with plainly visible
  // defects certifying as defect-free. `defectFree` states that nothing was
  // wrong, so it must be false whenever a violation was observed and could not
  // be published — for whatever reason. (Ambiguity-withheld fails are already
  // counted above and are not double-reported here.)
  const suppressedDefects = results.filter((r) => r.predicateOutcome === OUTCOME.VIOLATED
    && r.verdict !== VERDICT.FAIL
    && !(r.withheld && r.withheld.certificationBlocker));
  const defectFree = fails.length === 0 && withheldFails.length === 0 && suppressedDefects.length === 0;
  if (!defectFree) {
    for (const r of fails) push(CERT_FACET.DEFECT_FREE, r.reason, `${r.obligationId} is a defect`, { obligationId: r.obligationId });
    for (const r of withheldFails) push(CERT_FACET.DEFECT_FREE, REASON.AMBIGUITY_PRECEDENCE, `${r.obligationId} would have failed but is withheld by ${(r.withheld.blockedBy || []).join(', ')}`, { obligationId: r.obligationId });
    for (const r of suppressedDefects.slice(0, 50)) {
      push(CERT_FACET.DEFECT_FREE, r.reason, `${r.obligationId} observed a violation (${r.predicateReason}) that could not be asserted; it is not evidence of an absence of defects`, { obligationId: r.obligationId });
    }
  }

  const facets = {
    recordAuthentic, evidenceValid, contractReviewed, resultsReviewed, testComplete, defectFree,
  };

  return {
    version: CERTIFICATION_VERSION,
    facets,
    // The conjunction is explicit and printed, so "certifiable" can never be
    // read as "some subset of the checks was green".
    certifiable: Object.values(facets).every(Boolean),
    conjunction: Object.keys(facets),
    counts: {
      untyped: untyped.length,
      blocked: blocked.length,
      inconclusive: inconclusive.length,
      notExercised: notExercised.length,
      domainIncomplete: domainIncomplete.length,
      quarantinedSessions: quarantined.length,
      hardIntegrityFindings: hardFindings.length,
      fails: fails.length,
      withheldFails: withheldFails.length,
      suppressedDefects: suppressedDefects.length,
      unboundCompiledFields: unboundFields.length,
      eligibilityNotDocumentDerived: eligibilityUnderived.length,
      heuristicAmbiguityDeclines: heuristicDeclines,
    },
    // D7 — the three facts stay THREE, and are printed as three.
    contractTrust: {
      sealed: !!(authority && authority.contractSealed),
      humanReviewed,
      certified: contractReviewed,
      note: 'sealed is an identity, humanReviewed is a review, certified is this run\'s conjunction; a sealed-unreviewed revision confers neither of the other two',
    },
    evidenceIdentityBound,
    blockers,
    integrity: [...(ambIndex ? ambIndex.integrity : []), ...rtIntegrity, ...storeIntegrity],
  };
}
