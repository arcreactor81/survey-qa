/**
 * judge/lib/engine.mjs — the derived-verdict engine.
 *
 *   signed RunRecord ──authority──▶ artifact allowlist (hash-pinned)
 *                                            │
 *   obligation ──compile──▶ typed expectation ──predicate──▶ outcome
 *                                                    │
 *   artifacts ──re-read (hash-checked)───────────────┘
 *                                                    │
 *          proof projections + scope attestation + tripwires
 *                     + dependency-aware ambiguity precedence
 *                                                    │
 *                                                    ▼
 *                                        verdict (from a closed enum)
 *                                                    │
 *                                                    ▼
 *                                    JudgementRecord (bound + attested)
 *
 * The agent never authors a verdict. There is no free-text field anywhere in a
 * result that scoring reads. Every verdict carries the artifacts it was
 * computed from, and `attest()` re-opens each of those artifacts — a second,
 * uncached read, checked against the SIGNED hash — and recomputes the whole
 * proof projection. If a cited artifact does not support the verdict, that is
 * an ERROR CONDITION and the obligation goes to NOT-ASSESSED. It never becomes
 * a pass.
 *
 * A3b: all public entry points are now async. The store fetches bytes through
 * an injected async source, so every read/attest call returns a Promise. The
 * algorithms are unchanged — this is mechanical await-propagation.
 */

import { COVERAGE, VERDICT, DISPOSITION, OUTCOME, REASON, ENGINE_VERSION, EVIDENCE_CLASS, PROOF_KIND } from './vocab.mjs';
import { EvidenceStore, EvidenceIntegrityError, PRIMARY_PROBES } from './evidence-store.mjs';
import { loadSessions } from './sessions.mjs';
import { buildRouteTable, sessionWalks, ROUTE_TABLE_VERSION } from './route-table.mjs';
import { buildCensus } from './census.mjs';
import { compileObligation, documentOptionOrder, buildDocumentIndex, documentScreens, COMPILER_VERSION } from './compile.mjs';
import { buildDocumentModel, DOCUMENT_MODEL_VERSION } from './document-model.mjs';
import { runPredicate, PREDICATE_VERSION } from './predicates.mjs';
import { buildAmbiguityIndex, precedenceFor, LOCKED_POLICY, AMBIGUITY_POLICY_VERSION } from './ambiguity.mjs';
import { ScopeAttestor, ATTESTABLE_SCOPES, SCOPE_ATTEST_VERSION } from './scope-attest.mjs';
import { PROOF_VERSION, PROOFS } from './proof.mjs';
import { certify } from './certification.mjs';
import { buildJudgementRecord, attestJudgementRecord } from './judgement-record.mjs';
import { nullAuthority, checkEvidenceSource } from './authority.mjs';

export { EvidenceIntegrityError };

export { ENGINE_VERSION };

/**
 * D5 — which proof projection each predicate's witnesses MUST carry. A witness
 * whose claim is structural (an edge, a base membership, a probe outcome) may
 * not be attested by a single-field lookup.
 */
const REQUIRED_PROOF = Object.freeze({
  'route@1': { both: [PROOF_KIND.ROUTE_EDGE] },
  'screen-conditional-presence@1': { both: [PROOF_KIND.GATED_OCCURRENCE] },
  'answer-requirement@1': { both: [PROOF_KIND.PROBE_OUTCOME] },
  // D10 — a text claim must prove the OCCURRENCE, not that a locator resolves.
  // These are one-sided: the positive witnesses of an absence claim are scope
  // samples ("this capture was searched"), which is a capture-field fact.
  'text-forbidden@1': { counter: [PROOF_KIND.TEXT_OCCURRENCE] },
  'no-instruction-leak@1': { counter: [PROOF_KIND.TEXT_OCCURRENCE] },
  'text-present@1': { positive: [PROOF_KIND.TEXT_OCCURRENCE] },
  // D10 — "only these controls" must cite the complete control census.
  'screen-controls-only@1': { counter: [PROOF_KIND.CONTROL_CENSUS, PROOF_KIND.CAPTURE_FIELD] },
});

/**
 * Predicates whose SATISFIED/VIOLATED outcome is a completeness claim.
 *
 * Exported so the selftest can assert the other half of the contract: every id
 * named here must be able to REACH a violation through this gate. A predicate
 * that omits `scope` on its `bad()` branch is silently demoted to NOT-ASSESSED
 * and can never report a defect (N3) — the tripwire below cannot tell that
 * apart from a genuine partial scan, so the guarantee has to be tested from
 * the predicate side.
 */
export const SCOPE_REQUIRED = new Set([
  'option-present@1', 'option-set-exact@1', 'option-order-fixed@1', 'option-order-randomized@1',
  'grid-row-present@1', 'text-forbidden@1', 'no-instruction-leak@1', 'one-question-per-screen@1',
  'control-absent-on-screen@1', 'screen-controls-only@1', 'selection-mode@1',
  // D8 — the four predicates that used to attest their own universes. Each one
  // now declares a filter in the population grammar and the scope authority
  // produces the membership root; a disagreement fails closed.
  'route@1', 'screen-conditional-presence@1', 'screen-universal@1', 'control-on-every-screen@1',
  // ... and the one the previous round named as the next instance of the same
  // class: "the first screen shown to EVERY respondent" is a completeness claim
  // over the whole session set.
  'first-screen@1',
]);

/**
 * D2 — WHICH EVIDENCE A SIGNATURE IS ALLOWED TO COVER.
 *
 * `judgeRun` used to accept `store` and `sessions` as ordinary options. That is
 * a production entry point, so anything holding a verified authority for run A
 * could hand it fabricated sessions, or run B's evidence store, and every
 * publishability check would still pass: the checks looked at the AUTHORITY that
 * was supplied, never at whether the evidence had been constructed from it.
 * Authority from one run could sign verdicts derived from another run's — or no
 * run's — artifacts.
 *
 * The fix has two halves:
 *   1. `judgeRun` refuses `store` / `sessions` outright (see below). Test
 *      injection now goes through `judgeRunWithInjectedEvidence`, which can
 *      never produce a publishable record.
 *   2. This registry records, for each evidence object, WHICH authority it was
 *      built from. Before a JudgementRecord may be signed the engine checks that
 *      the store it read was constructed here, from the very authority object
 *      the record binds to, and that the session set was loaded from that store.
 *      Identity, not equality: a look-alike authority does not satisfy it.
 */
const EVIDENCE_PROVENANCE = new WeakMap();

/** The binding fact, recomputed at judgement time. Never taken on trust. */
export function evidenceIdentityBinding(ctx, authority) {
  const s = ctx && ctx.store ? EVIDENCE_PROVENANCE.get(ctx.store) : null;
  const ses = ctx && ctx.sessions ? EVIDENCE_PROVENANCE.get(ctx.sessions) : null;
  const storeInternal = !!s && s.kind === 'evidence-store';
  const sessionsInternal = !!ses && ses.kind === 'sessions' && ses.store === ctx.store;
  // `authority` may legitimately be null on a diagnostic run; what may never
  // happen is a store built from a DIFFERENT authority than the one being bound.
  const wantAuthority = authority && authority.verified ? authority : null;
  const authorityMatches = storeInternal && s.authority === wantAuthority;
  // N2 — object identity said WHO built the store; it never said WHAT the store
  // reads. Run A's authority over run B's directory satisfied every clause
  // above, because the engine itself had built the store — from the wrong
  // directory. The evidence source is therefore checked too, from the store's
  // own canonical artifacts path against the source the authority verified.
  const src = ctx && ctx.store
    ? checkEvidenceSource(authority, ctx.store.runDir, { artifactsSubdir: ctx.store.evidenceSource ? ctx.store.evidenceSource.artifactsSubdir : 'artifacts' })
    : { ok: false, checked: true, why: 'there is no evidence store to bind' };
  const sourceMatches = src.ok;
  const problems = [];
  if (!storeInternal) problems.push('the evidence store was not constructed by this engine');
  else if (!authorityMatches) problems.push('the evidence store was constructed from a different authority than the one being bound');
  if (!sourceMatches) problems.push(`the evidence source is not the one the verified authority describes: ${src.why}`);
  if (!sessionsInternal) problems.push('the session set was not loaded from this run\'s evidence store');
  return {
    bound: storeInternal && authorityMatches && sessionsInternal && sourceMatches,
    storeInternal,
    sessionsInternal,
    authorityMatches,
    sourceMatches,
    evidenceSource: ctx && ctx.store ? ctx.store.evidenceSource || null : null,
    authorityEvidenceSource: authority ? authority.evidenceSource || null : null,
    problems,
  };
}

/**
 * A3b: async — store.read() and loadSessions() are async.
 */
export async function buildContext(runDir, checklist, { store: injectedStore, sessions: injectedSessions, authority = null, source = null } = {}) {
  // D3: the compiler is fed the SIGNED ContractRevision items, never the local
  // checklist. An unverified authority binds nothing and the run is already
  // diagnostic-only.
  //
  // It is built BEFORE the store because the store needs its screen vocabulary: a v2
  // PathObservation carries rendered screens and no screen ids, so the projection in
  // `v2-observation.mjs` recognises a screen by the DOCUMENT-DERIVED id it prints. v1
  // artifacts carry their own `screen_id` and are unaffected either way.
  const docIndex = buildDocumentIndex(checklist, authority);
  const screenIdVocabulary = documentScreens(docIndex);

  const store = injectedStore || new EvidenceStore(runDir, { authority, screenIdVocabulary, source });
  if (!injectedStore) EVIDENCE_PROVENANCE.set(store, { kind: 'evidence-store', authority, runDir });
  const sessions = injectedSessions || await loadSessions(store);
  if (!injectedSessions) EVIDENCE_PROVENANCE.set(sessions, { kind: 'sessions', store });

  // PRELOAD THE PRIMARY PROBES. The predicates are SYNC functions and read the
  // probe artifacts through `store.readCached()`, which never fetches. Awaiting
  // a real read() here — with all of its verification — is what makes that
  // cache-only read honest: by predicate time a probe is either verified in the
  // cache or genuinely absent from the run. Skipping this preload is exactly
  // the defect the pinned v1 baseline caught (two probe-backed obligations
  // silently demoted to NO_OBSERVATION_FOR_OBLIGATION).
  for (const probeName of PRIMARY_PROBES) {
    if (store.listArtifacts().includes(probeName)) await store.read(probeName);
  }

  const routeTable = buildRouteTable(sessions);
  const census = buildCensus(sessions);
  const walks = sessionWalks(sessions);
  const scopeAttestor = new ScopeAttestor(store, { documentModel: buildDocumentModel(docIndex) });
  const orderCache = new Map();
  return {
    store, sessions, routeTable, census, walks, checklist, docIndex, scopeAttestor, authority,
    documentModel: scopeAttestor.documentModel,
    documentOrder(screen) {
      if (!orderCache.has(screen)) orderCache.set(screen, documentOptionOrder(docIndex.bound.list, screen, docIndex));
      return orderCache.get(screen);
    },
  };
}

/**
 * Independent re-verification of every witness a predicate produced.
 * Runs AFTER the predicate, from the artifact through the source, with no cache,
 * and recomputes the witness's whole PROOF PROJECTION rather than one field.
 *
 * A3b: async. Groups witnesses by artifact and does ONE fresh fetch per artifact
 * per attest pass, attesting all of that artifact's witnesses against that single
 * fresh record. This preserves "fresh and uncached": the bytes come from the
 * source (fresh from R2/disk, never from the store's main cache), and each
 * artifact is fetched exactly once per attestAll call. The grouping avoids
 * redundant fetches without reusing cached data.
 */
async function attestAll(store, list) {
  // Group witnesses by artifact name so each artifact is fetched only once.
  const byArtifact = new Map();
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!w || !w.artifact) continue;
    if (!byArtifact.has(w.artifact)) byArtifact.set(w.artifact, []);
    byArtifact.get(w.artifact).push({ index: i, witness: w });
  }

  const results = new Array(list.length);

  // Handle witnesses without artifacts first.
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!w || !w.artifact) {
      results[i] = { witness: w, ok: false, reason: REASON.WITNESS_LOCATOR_UNRESOLVED };
    }
  }

  // For each artifact, fetch once and attest all its witnesses.
  for (const [artifactName, witnesses] of byArtifact) {
    // Fresh read: bytes come from the source, not the cache.
    const rec = await store.read(artifactName, { fresh: true });

    for (const { index, witness } of witnesses) {
      if (!rec.ok) {
        const reason = rec.reason === REASON.CITED_ARTIFACT_MISSING ? REASON.CITED_ARTIFACT_MISSING
          : rec.reason === REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST ? REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST
            : rec.reason === REASON.ARTIFACT_HASH_MISMATCH ? REASON.ARTIFACT_HASH_MISMATCH
              : rec.reason === REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT ? REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT
                : REASON.WITNESS_REREAD_FAILED;
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
            proofClaim: witness.proof ? witness.proof.claim : null,
          },
          ok: false, reason, sha256: rec.sha256 ?? null,
          proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
        };
        continue;
      }

      // A witness may pin a hash; it must agree with the signed one as well.
      if (witness.sha256 && witness.sha256 !== rec.sha256) {
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
            proofClaim: witness.proof ? witness.proof.claim : null,
          },
          ok: false, reason: REASON.WITNESS_REREAD_FAILED,
          observed: rec.sha256, sha256: rec.sha256,
          proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
        };
        continue;
      }

      // Non-primary evidence class check.
      const NON_PRIMARY = new Set([EVIDENCE_CLASS.IMAGE, EVIDENCE_CLASS.DERIVED_SUMMARY, EVIDENCE_CLASS.UNKNOWN]);
      const CLASS_REF = {
        [EVIDENCE_CLASS.IMAGE]: REASON.IMAGE_ONLY_EVIDENCE,
        [EVIDENCE_CLASS.DERIVED_SUMMARY]: REASON.DERIVED_SUMMARY_CITED_AS_PRIMARY,
        [EVIDENCE_CLASS.UNKNOWN]: REASON.UNKNOWN_ARTIFACT_CLASS_CITED,
      };
      if (NON_PRIMARY.has(rec.evidenceClass)) {
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
            proofClaim: witness.proof ? witness.proof.claim : null,
          },
          ok: false, reason: CLASS_REF[rec.evidenceClass], sha256: rec.sha256,
          evidenceClass: rec.evidenceClass,
          proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
        };
        continue;
      }

      const kind = witness.proofKind || (witness.proof && witness.proof.kind) || PROOF_KIND.CAPTURE_FIELD;
      const proof = PROOFS[kind];
      if (!proof) {
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: kind, proofClaim: witness.proof ? witness.proof.claim : null,
          },
          ok: false, reason: REASON.PROOF_PROJECTION_MISSING, sha256: rec.sha256, proofKind: kind,
        };
        continue;
      }

      const claim = kind === PROOF_KIND.CAPTURE_FIELD
        ? { locator: witness.locator, derive: witness.derive, ...('equals' in witness ? { equals: witness.equals } : {}) }
        : (witness.proof && witness.proof.claim) || null;
      if (!claim) {
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: kind, proofClaim: null,
          },
          ok: false, reason: REASON.PROOF_PROJECTION_MISSING, sha256: rec.sha256, proofKind: kind,
        };
        continue;
      }

      let r;
      try { r = proof(rec.data, claim); } catch (e) {
        results[index] = {
          witness: {
            artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null,
            locator: witness.locator, expected: witness.equals, note: witness.note ?? null,
            proofKind: kind, proofClaim: witness.proof ? witness.proof.claim : null,
          },
          ok: false, reason: REASON.PROOF_PROJECTION_FAILED, sha256: rec.sha256, proofKind: kind,
          observed: String(e && e.message ? e.message : e),
        };
        continue;
      }

      results[index] = {
        witness: {
          artifact: witness.artifact, session: witness.session ?? null, seq: witness.seq ?? null, locator: witness.locator,
          expected: witness.equals, note: witness.note ?? null,
          proofKind: witness.proofKind || PROOF_KIND.CAPTURE_FIELD,
          proofClaim: witness.proof ? witness.proof.claim : null,
        },
        ok: r.ok,
        reason: r.ok ? null : r.reason,
        detail: r.ok ? undefined : r.detail,
        observed: r.ok ? undefined : r.observed,
        proofKind: r.proofKind || kind,
        sha256: rec.sha256,
      };
    }
  }

  return results;
}

/**
 * FALSE-PASS TRIPWIRES. Every one of these turns a would-be pass into a
 * non-pass — and, since D5, every one of them turns a would-be FAIL into a
 * non-fail too where the claim's completeness is part of the assertion.
 *
 * A3b: async — scopeAttestor.attest() is async.
 */
async function tripwires(predicateResult, attestations, expectation, ctx) {
  const fired = [];
  const positives = predicateResult.witnesses || [];
  const counters = predicateResult.counterWitnesses || [];
  const pid = predicateResult.predicateId;
  const asserting = predicateResult.outcome === OUTCOME.SATISFIED || predicateResult.outcome === OUTCOME.VIOLATED;

  // 0. An asserting predicate must use the proof projection its claim requires.
  //    D10: the requirement is per SIDE, because the positive witnesses of an
  //    absence claim make a different kind of claim from its counter-witnesses.
  if (asserting && pid && REQUIRED_PROOF[pid]) {
    const spec = REQUIRED_PROOF[pid];
    const sides = [
      [spec.positive || spec.both, positives, 'positive'],
      [spec.counter || spec.both, counters, 'counter'],
    ];
    for (const [want, list, side] of sides) {
      if (!want) continue;
      let broke = false;
      for (const w of list) {
        const k = w.proofKind || PROOF_KIND.CAPTURE_FIELD;
        if (!want.includes(k)) {
          fired.push({ code: REASON.PROOF_PROJECTION_MISSING, detail: `${pid} ${side} witness uses ${k}; this claim requires ${want.join('|')}` });
          broke = true;
          break;
        }
      }
      if (broke) break;
    }
  }

  // 0b. Completeness claims are re-derived from the signed artifacts by a pass
  //     the predicate had no part in. A count the claimant authored is not
  //     evidence of completeness — for a PASS or for a VIOLATION.
  if (asserting && pid && SCOPE_REQUIRED.has(pid)) {
    const s = predicateResult.scope;
    if (!s || !ATTESTABLE_SCOPES.has(s.claimKind)) {
      fired.push({ code: REASON.SCOPE_INCOMPLETE_FOR_CLAIM, detail: `${pid} asserts a completeness claim with no attestable scope` });
    } else {
      const r = await ctx.scopeAttestor.attest(s);
      if (!r.ok) fired.push({ code: r.reason, detail: `scope re-derivation failed: ${JSON.stringify(r.detail)}` });
    }
  }

  if (predicateResult.outcome === OUTCOME.SATISFIED) {
    // 1. A pass must be positively evidenced.
    if (positives.length === 0 && !predicateResult.absenceClaim) {
      fired.push({ code: REASON.PASS_WITHOUT_WITNESS, detail: 'satisfied with no positive witness' });
    }
    // 2. An absence claim needs a complete, enumerated positive inventory.
    if (predicateResult.absenceClaim) {
      const s = predicateResult.scope;
      const enumerated = s && (s.capturesEnumerated || s.capturesScanned);
      if (!s || !s.claimKind || !enumerated) {
        fired.push({ code: REASON.INVENTORY_INCOMPLETE, detail: 'absence claim without a complete scoped inventory' });
      } else if (ATTESTABLE_SCOPES.has(s.claimKind)) {
        const r = await ctx.scopeAttestor.attest(s);
        if (!r.ok) fired.push({ code: r.reason, detail: `absence scope re-derivation failed: ${JSON.stringify(r.detail)}` });
      }
    }
    // 3. Every cited artifact must still support the claim on a fresh read.
    for (const a of attestations.positive) {
      if (!a.ok) fired.push({ code: a.reason, detail: `positive witness failed re-verification: ${a.witness.artifact} ${a.witness.locator}` });
    }
    // 4. Non-primary support cannot decide a machine verdict.
    if (positives.length > 0 && attestations.positive.every((a) => a.reason === REASON.IMAGE_ONLY_EVIDENCE)) {
      fired.push({ code: REASON.IMAGE_ONLY_EVIDENCE, detail: 'every supporting artifact is an image' });
    }
  }

  if (predicateResult.outcome === OUTCOME.VIOLATED) {
    if (counters.length === 0) {
      fired.push({ code: REASON.PASS_WITHOUT_WITNESS, detail: 'violation asserted with no counter-witness' });
    }
    for (const a of attestations.counter) {
      if (!a.ok) fired.push({ code: a.reason, detail: `counter-witness failed re-verification: ${a.witness.artifact} ${a.witness.locator}` });
    }
  }
  return fired;
}

/** The verdict derivation table. This is the whole judgement, and it is a lookup. */
function deriveVerdict({ expectation, predicateResult, trippedWires, precedence }) {
  if (!expectation) {
    return { verdict: VERDICT.NOT_ASSESSED, coverage: COVERAGE.PENDING, disposition: DISPOSITION.NONE, reason: REASON.NO_TYPED_EXPECTATION };
  }
  if (trippedWires.length) {
    return {
      verdict: VERDICT.NOT_ASSESSED, coverage: COVERAGE.BLOCKED, disposition: DISPOSITION.QUERY,
      reason: trippedWires[0].code,
      note: 'evidence integrity failure — a verdict whose cited artifact does not support it is an error, not a pass',
    };
  }
  switch (predicateResult.outcome) {
    case OUTCOME.ERROR:
      return { verdict: VERDICT.NOT_ASSESSED, coverage: COVERAGE.BLOCKED, disposition: DISPOSITION.QUERY, reason: predicateResult.reason };
    case OUTCOME.NO_OBSERVATION:
      return { verdict: VERDICT.NOT_ASSESSED, coverage: COVERAGE.NOT_REACHED, disposition: DISPOSITION.NONE, reason: REASON.NO_OBSERVATION_FOR_OBLIGATION };
    case OUTCOME.INSUFFICIENT:
      // Keep the two axes honest: "we could not reach it" and "we reached it
      // but could not decide" are different facts and must not share a cell.
      return {
        verdict: VERDICT.INCONCLUSIVE,
        coverage: predicateResult.reason === REASON.NO_OBSERVATION_FOR_OBLIGATION ? COVERAGE.NOT_REACHED : COVERAGE.EXERCISED,
        disposition: DISPOSITION.QUERY,
        reason: predicateResult.reason,
      };
    case OUTCOME.VIOLATED:
      if (precedence.blocksFail) {
        return {
          verdict: VERDICT.INCONCLUSIVE, coverage: COVERAGE.EXERCISED, disposition: DISPOSITION.QUERY,
          reason: REASON.AMBIGUITY_PRECEDENCE,
          withheld: { wouldHaveBeen: VERDICT.FAIL, blockedBy: precedence.ambiguities, certificationBlocker: true },
        };
      }
      return { verdict: VERDICT.FAIL, coverage: COVERAGE.EXERCISED, disposition: DISPOSITION.DEFECT, reason: predicateResult.reason };
    case OUTCOME.SATISFIED:
      if (precedence.blocksPass) {
        return {
          verdict: VERDICT.INCONCLUSIVE, coverage: COVERAGE.EXERCISED, disposition: DISPOSITION.AMBIGUITY,
          reason: REASON.AMBIGUITY_PRECEDENCE,
          withheld: { wouldHaveBeen: VERDICT.PASS, blockedBy: precedence.ambiguities, certificationBlocker: false },
        };
      }
      return { verdict: VERDICT.PASS, coverage: COVERAGE.EXERCISED, disposition: DISPOSITION.NONE, reason: predicateResult.reason };
    default:
      return { verdict: VERDICT.NOT_ASSESSED, coverage: COVERAGE.PENDING, disposition: DISPOSITION.NONE, reason: REASON.NO_TYPED_EXPECTATION };
  }
}

/**
 * Diagnostic ONLY. The derived verdict is computed without ever looking at the
 * prior claim; this cross-check exists so the run can report where the previous
 * prose contradicted the artifact it cited. It must never feed the verdict.
 *
 * A3b: async — store.read() is async.
 */
async function crossCheckPriorClaim(store, obligationId, prior) {
  if (!prior) return null;
  // The prior `evidence` field is FREE TEXT, which is the root of the whole
  // problem: a citation nothing can resolve is a citation nothing can check.
  const cited = String(prior.evidence || '').split(',').map((s) => s.trim()).filter(Boolean);
  const looksLikeRef = (s) => /\.(json|png|jpe?g)(#|$)/i.test(s) && !/[*]/.test(s) && !/\/\d{3}/.test(s);
  const refs = [];
  for (const c of cited) {
    const machineResolvable = looksLikeRef(c);
    const rec = machineResolvable ? await store.read(c) : { ok: false, evidenceClass: EVIDENCE_CLASS.UNKNOWN, sha256: null };
    refs.push({
      cited: c,
      machineResolvable,
      resolved: rec.ok,
      evidenceClass: rec.evidenceClass,
      sha256: rec.sha256,
      problem: !machineResolvable ? 'CITATION_NOT_MACHINE_RESOLVABLE'
        : !rec.ok ? REASON.CITED_ARTIFACT_MISSING
          : rec.evidenceClass === EVIDENCE_CLASS.DERIVED_SUMMARY ? REASON.DERIVED_SUMMARY_CITED_AS_PRIMARY
            : rec.evidenceClass === EVIDENCE_CLASS.IMAGE ? REASON.IMAGE_ONLY_EVIDENCE : null,
    });
  }
  return {
    priorVerdict: prior.verdict || null,
    priorObservationText: prior.observation || null,
    // Historical agent-authored prose is NEUTRAL: it is reported for contrast
    // and can never be published as a current result.
    status: 'neutral-historical-claim',
    citedArtifacts: refs,
    citationProblems: refs.filter((r) => r.problem).map((r) => ({ cited: r.cited, problem: r.problem })),
  };
}

const PRIOR_TO_AXIS = {
  MATCHES_DOCUMENT: VERDICT.PASS,
  DIVERGES_FROM_DOCUMENT: VERDICT.FAIL,
  PARTIALLY_OBSERVED: VERDICT.INCONCLUSIVE,
  AMBIGUOUS: VERDICT.INCONCLUSIVE,
  NOT_OBSERVABLE: VERDICT.NOT_ASSESSED,
};

/**
 * A3b: async — attestAll and tripwires are async.
 */
export async function judgeObligation(obligation, ctx, ambIndex, prior = null) {
  const { expectation, ruleId, unmintableDetail: mintDetail } = compileObligation(obligation, ctx.docIndex);
  const precedence = precedenceFor(obligation.id, ambIndex);

  let predicateResult = null;
  let attestations = { positive: [], counter: [] };
  let trippedWires = [];

  if (expectation) {
    predicateResult = runPredicate(expectation, ctx);
    attestations = {
      positive: await attestAll(ctx.store, predicateResult.witnesses || []),
      counter: await attestAll(ctx.store, predicateResult.counterWitnesses || []),
    };
    trippedWires = await tripwires(predicateResult, attestations, expectation, ctx);
  }

  const d = deriveVerdict({ expectation, predicateResult, trippedWires, precedence });
  const allAttestations = [...attestations.positive, ...attestations.counter];

  return {
    obligationId: obligation.id,
    category: obligation.category,
    statement: obligation.statement,
    docQuote: obligation.doc_quote,
    // D3: every row says whether the fields it was compiled from were covered
    // by the signature, and where they came from.
    compiledFieldsBound: obligation.fieldsBound === true,
    compiledFieldsSource: obligation.boundBy ?? 'unknown',
    compiledFieldsUnbound: obligation.unboundFields ? [...obligation.unboundFields] : [],

    // --- the derived judgement -------------------------------------------
    verdict: d.verdict,
    coverage: d.coverage,
    disposition: d.disposition,
    reason: d.reason,
    withheld: d.withheld || null,
    note: d.note || null,

    // Track 1: when an obligation has no typed expectation, name the family
    // so the report can say WHAT kind of obligation was not assessed.
    unmintableDetail: !expectation ? (mintDetail || null) : null,

    // --- how it was derived, in full -------------------------------------
    expectation: expectation || null,
    compiledBy: ruleId,
    predicateId: predicateResult ? predicateResult.predicateId : null,
    predicateOutcome: predicateResult ? predicateResult.outcome : null,
    predicateReason: predicateResult ? predicateResult.reason : null,
    predicateDetail: predicateResult ? (predicateResult.detail || null) : null,
    evidenceScope: predicateResult ? (predicateResult.scope || null) : null,
    pathConsistency: predicateResult && predicateResult.pathConsistency ? predicateResult.pathConsistency
      : (predicateResult && predicateResult.outcome === OUTCOME.SATISFIED ? 'consistent' : null),

    // --- evidence, re-verified at judgement time --------------------------
    evidenceRefs: dedupeRefs([...(predicateResult ? predicateResult.witnesses || [] : []), ...(predicateResult ? predicateResult.counterWitnesses || [] : [])]),
    supportingWitnesses: (predicateResult ? predicateResult.witnesses || [] : []).map(publicWitness),
    counterWitnesses: (predicateResult ? predicateResult.counterWitnesses || [] : []).map(publicWitness),
    attestation: {
      positive: attestations.positive,
      counter: attestations.counter,
      // An empty witness collection is not a verified one. `[].every(...)` is
      // true, which used to report `allVerified: true` for a claim that cited
      // nothing at all.
      allVerified: allAttestations.length > 0 && allAttestations.every((a) => a.ok),
      witnessCount: allAttestations.length,
      hashAuthority: ctx.store.authoritative ? 'signed-run-record' : 'unattested-local-read',
    },
    tripwires: trippedWires,
    ambiguityPrecedence: (precedence.ambiguities.length || (precedence.declinedAsIrrelevant || []).length) ? precedence : null,

    // --- diagnostic only --------------------------------------------------
    priorClaim: await crossCheckPriorClaim(ctx.store, obligation.id, prior),
    priorVerdictAxis: prior && prior.verdict ? (PRIOR_TO_AXIS[prior.verdict] || null) : null,
  };
}

function publicWitness(w) {
  return {
    artifact: w.artifact, sha256: w.sha256 ?? null, session: w.session ?? null,
    seq: w.seq ?? w.toSeq ?? null, fromSeq: w.fromSeq ?? undefined, toSeq: w.toSeq ?? undefined,
    locator: w.locator, value: w.equals, note: w.note ?? null,
    answer: w.answer ?? undefined, observedNext: w.observedNext ?? undefined,
    edgeSource: w.source ?? undefined,
    proofKind: w.proofKind || PROOF_KIND.CAPTURE_FIELD,
  };
}

function dedupeRefs(list) {
  const m = new Map();
  for (const w of list) {
    if (!w || !w.artifact) continue;
    if (!m.has(w.artifact)) m.set(w.artifact, { artifact: w.artifact, sha256: w.sha256 ?? null, locators: [] });
    const e = m.get(w.artifact);
    if (w.locator && !e.locators.includes(w.locator)) e.locators.push(w.locator);
  }
  return [...m.values()];
}

/**
 * A3b: async.
 * @param {object} o
 * @param {string} o.runDir
 * @param {object} o.checklist
 * @param {object} [o.authority]  the verified EvidenceAuthority (D1). Without
 *   one the run is DIAGNOSTIC ONLY: it still derives verdicts so an operator
 *   can see what happened, but nothing it produces may be published.
 * @param {{privateKeyPem:string,keyId:string,signedAt:string}} [o.signer]
 * @param {{names():string[], fetch(name:string):Promise<Uint8Array|null>}} [o.source]
 *   A3b: async byte source. When null the store creates a disk-backed source.
 */
export async function judgeRun({ runDir, checklist, priorObservations = null, authority = null, signer = null, source = null, ...rest }) {
  // D4: the ambiguity gate is locked. A caller-supplied policy was a documented
  // bypass of a rule the whole design calls non-negotiable.
  if ('policy' in rest) {
    throw new Error('judgeRun does not accept a policy: ambiguity precedence is a locked gate (see ambiguity.mjs LOCKED_POLICY)');
  }
  // D2: the PRODUCTION entry point does not accept evidence. It builds the
  // evidence store and the session set itself, from the authority it was given,
  // so a caller cannot combine a verified authority for run A with fabricated
  // sessions or run B's store. Test injection is a separate, never-publishable
  // entry point (`judgeRunWithInjectedEvidence`).
  if ('store' in rest || 'sessions' in rest) {
    throw new Error('judgeRun does not accept `store` or `sessions`: a signed judgement may only be derived from evidence this entry point constructed from its own authority. Use judgeRunWithInjectedEvidence for tests (it can never publish).');
  }
  // N2/D2 — THE PARAMETER SURFACE IS CLOSED, NOT ENUMERATED.
  //
  // The previous guard named `policy`, `store` and `sessions` and let every
  // other key through unread. Naming the known-bad arguments means the next
  // parameter added anywhere in this file is admitted by default; the surface is
  // now the six parameters below and nothing else, so a fourth injection point
  // cannot appear by omission.
  const extra = Object.keys(rest);
  if (extra.length) {
    throw new Error(`judgeRun does not accept [${extra.join(', ')}]: its parameters are exactly {runDir, checklist, priorObservations, authority, signer, source}. Anything else would be an input to a signed result that nothing verified.`);
  }
  return runJudgement({ runDir, checklist, priorObservations, authority, signer, injected: null, source });
}

/**
 * D2 — the TEST-ONLY entry point. It accepts an arbitrary evidence store and
 * session set, and in exchange the record it produces can never be publishable
 * and is never signed, whatever authority it is handed. That is the whole point
 * of separating it: injection and publication are now mutually exclusive by
 * construction rather than by convention.
 *
 * A3b: async.
 */
export async function judgeRunWithInjectedEvidence({ runDir, checklist, priorObservations = null, store = undefined, sessions = undefined, authority = null }) {
  return runJudgement({ runDir, checklist, priorObservations, authority, signer: null, injected: { store, sessions }, source: null });
}

/**
 * A3b: async — buildContext, judgeObligation, crossCheckPriorClaim are all async.
 */
async function runJudgement({ runDir, checklist, priorObservations, authority, signer, injected, source = null }) {
  const auth = authority || nullAuthority(REASON.EVIDENCE_AUTHORITY_UNVERIFIED, 'no signed evidence authority was supplied to judgeRun');
  // N2 — THE EVIDENCE SOURCE IS BOUND TO THE AUTHORITY, AND A MISMATCH REFUSES.
  //
  // This is the hard refusal, taken before a single artifact is opened. Judging
  // directory B under an authority verified over directory A is not a degraded
  // run to be annotated — the artifacts that disagree with A's signed hashes
  // would simply not be read, which is defect suppression with a valid
  // signature on top. There is no result to produce, so none is produced.
  const src = checkEvidenceSource(auth, runDir);
  if (!src.ok) {
    throw new EvidenceIntegrityError(
      'EVIDENCE_SOURCE_NOT_BOUND_TO_AUTHORITY',
      `refusing to judge evidence the verified authority does not describe: ${src.why}`,
      { expected: src.expected, actual: src.actual },
    );
  }
  const ctx = await buildContext(runDir, checklist, {
    store: injected ? injected.store : undefined,
    sessions: injected ? injected.sessions : undefined,
    authority: auth.verified ? auth : null,
    source,
  });
  // D2: recomputed here, from object identity, immediately before it is used.
  // Passing NOTHING through the injection entry point would otherwise let it
  // build the evidence internally and produce a publishable record — injection
  // and publication have to be mutually exclusive by construction, not by which
  // arguments happened to be supplied.
  const computed = evidenceIdentityBinding(ctx, auth);
  const evidenceBinding = injected
    ? { ...computed, bound: false, problems: [...computed.problems, 'derived through the test-only injection entry point, which may never publish'] }
    : computed;
  const compiled = new Map(ctx.docIndex.bound.list.map((o) => [o.id, compileObligation(o, ctx.docIndex)]));
  // D5: the ambiguity set that governs withholding is signed, or it is not, and
  // that fact travels with the index instead of being assumed.
  const ambiguityBinding = auth.ambiguityBinding || { signed: false, findings: [], detail: {} };
  const ambIndex = buildAmbiguityIndex(checklist, compiled, { binding: ambiguityBinding });

  const priorMap = priorObservations && priorObservations.obligation_observations ? priorObservations.obligation_observations : {};

  const results = [];
  for (const o of ctx.docIndex.bound.list) {
    results.push(await judgeObligation(o, ctx, ambIndex, priorMap[o.id] || null));
  }

  const counts = tally(results);
  const certification = certify({
    results, authority: auth, routeTable: ctx.routeTable, ambIndex, store: ctx.store, sessions: ctx.sessions,
    evidenceBinding, ambiguityBinding, documentModel: ctx.documentModel, contractBinding: ctx.docIndex.bound,
  });

  const versions = {
    engineVersion: ENGINE_VERSION,
    compilerVersion: COMPILER_VERSION,
    predicateVersion: PREDICATE_VERSION,
    ambiguityPolicyVersion: AMBIGUITY_POLICY_VERSION,
    proofVersion: PROOF_VERSION,
    routeTableVersion: ROUTE_TABLE_VERSION,
    scopeAttestVersion: SCOPE_ATTEST_VERSION,
    documentModelVersion: DOCUMENT_MODEL_VERSION,
  };

  const generatedAt = new Date().toISOString();
  const source_ = {
    runDir,
    artifactsRead: ctx.store.readCount,
    sessions: ctx.sessions.length,
    sessionsQuarantined: (ctx.sessions.quarantined || []).length,
    /** A3b — names listed in manifest but not fetched (hash-verified upstream, not engine-read). */
    listedNotFetched: ctx.sessions.listedNotFetched ?? 0,
    hashAuthority: ctx.store.authoritative ? 'signed-run-record' : 'unattested-local-read',
    // D2: stated on every output, not only when it fails.
    evidenceIdentityBound: evidenceBinding.bound,
    evidenceProvenance: evidenceBinding.bound
      ? 'constructed by judgeRun from the bound authority, over the evidence source that authority verified'
      : `NOT identity-bound: ${evidenceBinding.problems.join('; ')}`,
    // N2: the directory the verdicts were actually derived from, and the one the
    // authority was verified against. On a bound run they are the same path, and
    // the record now says so instead of leaving `runDir` unaccountable.
    evidenceSource: evidenceBinding.evidenceSource ? evidenceBinding.evidenceSource.artifactsDir : null,
    evidenceSourceBound: evidenceBinding.sourceMatches === true,
    authorityEvidenceSource: auth.evidenceSource ? auth.evidenceSource.artifactsDir : null,
    // D3
    compilerFieldsBound: ctx.docIndex.fieldsBound,
    // D9
    eligibilitySource: ctx.documentModel && ctx.documentModel.available ? ctx.documentModel.source : 'unavailable',
    // A3b — retained projection accounting
    retainedProjectionBytes: ctx.store.retainedBytes,
  };
  const denominator = {
    obligations: checklist.obligations.length,
    rule: 'the contract denominator is the extracted checklist; exploration adds findings, never rows',
  };
  const publicAmbiguityIndex = {
    version: ambIndex.version,
    policy: ambIndex.policy,
    obligationsTouched: ambIndex.obligationsTouched,
    integrity: ambIndex.integrity,
    loci: ambIndex.loci,
    suppressionsDeclinedAsIrrelevant: ambIndex.suppressionsDeclinedAsIrrelevant,
    map: Object.fromEntries([...ambIndex.index.entries()].map(([k, v]) => [k, v])),
  };
  const publicRt = publicRouteTable(ctx.routeTable);

  let judgement = buildJudgementRecord({
    authority: auth, versions, generatedAt, denominator, counts, certification,
    results, routeTable: publicRt, ambiguityIndex: publicAmbiguityIndex, source: source_,
    // D2/D3/D5: three separate facts a signature may not be issued without —
    // the evidence was built from THIS authority, every field the compiler read
    // was covered by it, and the ambiguity set that governs withholding is too.
    evidenceBinding,
    contractFieldsBound: ctx.docIndex.fieldsBound,
    ambiguitiesSigned: ambiguityBinding.signed,
  });
  let judgementAttestation = null;
  if (signer && judgement.publishable) {
    const r = attestJudgementRecord(judgement, signer);
    if (r.ok) { judgement = r.record; judgementAttestation = { ok: true }; }
    else judgementAttestation = { ok: false, code: r.code, errors: r.errors };
  } else if (signer) {
    judgementAttestation = { ok: false, code: 'NOT_BINDABLE', errors: [`unbindable: ${judgement.unbindableFields.join(', ') || 'authority unverified'}`] };
  }

  return {
    kind: 'derived-verdicts',
    ...versions,
    policy: LOCKED_POLICY,
    generatedAt,
    // The report contract: without a bindable, attested JudgementRecord this
    // output is an operational diagnostic and nothing more.
    status: judgement.publishable ? 'attestable' : 'diagnostic-only',
    publishable: judgement.publishable && !!(judgement.attestation),
    authority: publicAuthority(auth, ambiguityBinding),
    documentModel: ctx.documentModel,
    contractBinding: {
      version: ctx.docIndex.bound.version,
      fieldsBound: ctx.docIndex.fieldsBound,
      signedSource: ctx.docIndex.bound.signedSource,
      findings: ctx.docIndex.bindingFindings,
    },
    evidenceBinding,
    source: source_,
    denominator,
    counts,
    certification,
    results,
    routeTable: publicRt,
    ambiguityIndex: publicAmbiguityIndex,
    judgement,
    judgementAttestation,
  };
}

function publicAuthority(a, ambiguityBinding) {
  return {
    verified: a.verified,
    signatureVerified: a.signatureVerified,
    contractBound: a.contractBound,
    contractSealed: a.contractSealed,
    contractReviewState: a.contractReviewState,
    checklistBound: a.checklistBound,
    manifestComplete: a.manifestComplete,
    // D5: a CHECKED fact (see contract-binding.mjs), never the constant `false`
    // it used to be — which made `contractReviewed` unreachable by construction.
    ambiguitiesSigned: ambiguityBinding ? ambiguityBinding.signed : a.ambiguitiesSigned,
    ambiguityBinding: ambiguityBinding ? { signed: ambiguityBinding.signed, ...ambiguityBinding.detail } : null,
    runId: a.runId,
    runRecordPayloadHash: a.runRecordPayloadHash,
    contractRevisionId: a.contractRevisionId,
    contractRevisionHash: a.contractRevisionHash,
    targetBuildId: a.targetBuildId,
    targetBuildHash: a.targetBuildHash,
    evidenceManifestRoot: a.evidenceManifestRoot,
    signedArtifacts: a.manifest ? a.manifest.size : 0,
    findings: a.findings,
  };
}

function publicRouteTable(rt) {
  return {
    version: rt.version,
    sessions: rt.sessions,
    sessionsQuarantined: rt.sessionsQuarantined ?? 0,
    screenRank: rt.screenRank,
    integrity: rt.integrity,
    skipped: rt.skipped,
    rows: rt.rows.map((r) => ({
      question: r.question,
      answer: r.answer,
      answerLabels: r.answerLabels,
      answerCodes: r.answerCodes,
      observations: r.observations,
      pathConsistency: r.pathConsistency,
      destinations: Object.fromEntries(Object.entries(r.destinations).map(([k, v]) => [k, {
        count: v.count,
        witnesses: v.witnesses.slice(0, 5).map((w) => ({ artifact: w.artifact, session: w.session, fromSeq: w.fromSeq, toSeq: w.toSeq, locator: w.locator, source: w.source, proofKind: w.proofKind })),
      }])),
    })),
  };
}

function tally(results) {
  const byVerdict = { pass: 0, fail: 0, inconclusive: 0, 'not-assessed': 0 };
  const byCoverage = {};
  const byDisposition = {};
  const byReason = {};
  for (const r of results) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    byCoverage[r.coverage] = (byCoverage[r.coverage] || 0) + 1;
    byDisposition[r.disposition] = (byDisposition[r.disposition] || 0) + 1;
    byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  }
  return {
    byVerdict, byCoverage, byDisposition, byReason,
    withheldFails: results.filter((r) => r.withheld && r.withheld.wouldHaveBeen === VERDICT.FAIL).length,
    withheldPasses: results.filter((r) => r.withheld && r.withheld.wouldHaveBeen === VERDICT.PASS).length,
    noTypedExpectation: results.filter((r) => !r.expectation).length,
  };
}
