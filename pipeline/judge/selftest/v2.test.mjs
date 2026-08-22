/**
 * selftest/v2.test.mjs — one regression per v2 defect.
 *
 *   node --test pipeline/judge/selftest/v2.test.mjs
 *
 * Every test here FAILS against the pre-fix engine. Where the old behaviour is
 * reachable from the current code (a caller-supplied policy, a witness without
 * a proof projection, a self-certifying scope) the test drives it directly, so
 * it is not merely asserting today's output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  judgeRun, buildContext, SCOPE_REQUIRED,
  judgeRunWithInjectedEvidence, evidenceIdentityBinding,
} from '../lib/engine.mjs';
import { buildDocumentIndex } from '../lib/compile.mjs';
import { buildDocumentModel } from '../lib/document-model.mjs';
import { loadSessions } from '../lib/sessions.mjs';
import { ambiguityToken, bindObligations, COMPILED_FROM, assertProjectionShape } from '../lib/contract-binding.mjs';
import { CONSUMED_FIELDS } from '../lib/ambiguity.mjs';
import { certify } from '../lib/certification.mjs';
import { loadEvidenceAuthority, evidenceManifestRoot, bindChecklist, sha256Of } from '../lib/authority.mjs';
import { contractItemFromRequirement } from '../../../worker-v2/shared/v2-record.mjs';
import { EvidenceStore, EvidenceIntegrityError, isSessionCandidate } from '../lib/evidence-store.mjs';
import { PREDICATES, runPredicate } from '../lib/predicates.mjs';
import { OUTCOME, REASON, VERDICT, COVERAGE, DISPOSITION, PROOF_KIND, EVIDENCE_CLASS, CERT_FACET } from '../lib/vocab.mjs';
import { precedenceFor, ambiguityLocus, locusTouchesExpectation, LOCKED_POLICY } from '../lib/ambiguity.mjs';
import { resolvePath } from '../lib/locator.mjs';
import {
  validateJudgementRecord, attestJudgementRecord, verifyJudgementRecord,
  JUDGEMENT_RECORD_KIND, JUDGEMENT_RECORD_SCHEMA,
} from '../lib/judgement-record.mjs';
import { evaluateJudgement } from '../../report/lib/judgement-record.mjs';
import { loadKeyRegistry } from '../../../scorer/src/lib/attest.mjs';
import { declareScope, ATTESTABLE_SCOPES } from '../lib/scope-attest.mjs';
import { writeSignedRunRecord } from './fixtures/sign-run.mjs';
import { SUBSTRATE_RUN, SUBSTRATE_RUN_ID, SUBSTRATE_SHAPE as SHAPE, privateOnly, announcePrivateRunGate } from '../../runs/run-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(here, '..', '..', '..'));
const MINI = resolve(join(here, 'fixtures', 'mini-run'));
const V2 = resolve(join(here, 'fixtures', 'mini-v2'));
const N3 = resolve(join(here, 'fixtures', 'mini-n3'));
/**
 * A REAL, SIGNED, MULTI-SESSION RUN — not a fixture, the producer's own output.
 *
 * Most of the tests below want that property and nothing else: a run the real
 * store, the real authority and the real judge can be driven over end to end.
 * `pipeline/runs/t1-easy` supplied it, but that run is DERIVED from the blind
 * corpus and is held back until the test runs are complete
 * (docs/EVALUATION-BOUNDARY.md), so this resolves to it when it is in the
 * checkout and to the public `pipeline/runs/synthetic-demo` when it is not.
 *
 * The few tests that are about t1-easy's CONTENT — a named obligation, a pinned
 * verdict — are gated with `privateOnly(...)` and say so; the count is pinned at
 * the bottom of this file.
 */
const T1 = SUBSTRATE_RUN;
const REGISTRY = join(REPO, 'scorer', 'fixtures', 'keys', 'registry.json');
const PRIVATE_PEM = join(REPO, 'scorer', 'fixtures', 'keys', 'TEST-ONLY-fixture-harness.private.pem');
// The fixtures are signed with the checked-in TEST-ONLY harness key, which is
// refused as a trust anchor unless a caller names it as such (audit finding
// 13). Opting in here is the test suite doing exactly that, once.
process.env.SURVEY_QA_ALLOW_FIXTURE_KEYS = '1';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const byId = (out) => new Map(out.results.map((r) => [r.obligationId, r]));

async function judge(runDir, { keyRegistryPath = REGISTRY, ...rest } = {}) {
  const checklist = readJson(join(runDir, 'checklist.json'));
  const authority = keyRegistryPath === null ? null : loadEvidenceAuthority({ runDir, checklist, keyRegistryPath });
  return await judgeRun({ runDir, checklist, authority, ...rest });
}

/** Copy a fixture run into a scratch dir so a test may tamper with it. */
function scratchCopy(src) {
  const dir = mkdtempSync(join(tmpdir(), 'judge-v2-'));
  cpSync(src, join(dir, 'run'), { recursive: true });
  return { dir, run: join(dir, 'run'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// D1 — the judge must consume the SIGNED evidence authority
// ===========================================================================

test('D1: an artifact replaced before the judge runs is rejected on first contact', async () => {
  const s = scratchCopy(V2);
  try {
    // The exact review scenario: swap the artifact, and it used to supply its
    // own new expected hash, re-verify against itself, and change the verdict
    // while still reporting allVerified.
    const victim = join(s.run, 'artifacts', 'V2-CLEAN-B.json');
    const doc = readJson(victim);
    // A LENGTH-PRESERVING edit, so only the signed content hash can catch it.
    doc.evidence[1].screen_id = 'Q7';
    assert.equal(doc.evidence[1].screen_id.length, 2);
    writeFileSync(victim, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const out = await judge(s.run);
    assert.equal(out.authority.signatureVerified, true, 'the RunRecord itself is untouched and still verifies');
    assert.equal(out.authority.verified, false, 'but its evidence catalogue no longer matches the disk');
    const store = new EvidenceStore(s.run, { authority: loadEvidenceAuthority({ runDir: s.run, checklist: readJson(join(s.run, 'checklist.json')), keyRegistryPath: REGISTRY }) });
    // N2: the mismatch RAISES. It used to be RETURNED as `{ok:false}`, which
    // every caller read as "skip this artifact" — see the N2 regression below.
    await assert.rejects(
      async () => await store.read('V2-CLEAN-B.json'),
      (e) => e instanceof EvidenceIntegrityError && e.code === REASON.ARTIFACT_HASH_MISMATCH,
      'the signed hash is the authority, not the file — and a disagreement is an error, not a skippable record',
    );
    assert.equal(out.status, 'diagnostic-only');
    assert.equal(out.certification.facets.recordAuthentic, false);
  } finally { s.cleanup(); }
});

test('D1: an artifact dropped into the directory after signing is not an input', async () => {
  const s = scratchCopy(V2);
  try {
    writeFileSync(join(s.run, 'artifacts', 'V2-PLANTED.json'), `${JSON.stringify({
      id: 'V2-PLANTED',
      trace: [{ seq: 1, screen: 'Q1', applied: { clicked: [{ label: 'Alpha option' }], typed: null, grid: [] } }],
      evidence: [{ seq: 1, screen_id: 'Q1', option_inventory: [], action_taken: null }, { seq: 2, screen_id: 'SCREENOUT', option_inventory: [], action_taken: null }],
    }, null, 2)}\n`, 'utf8');
    const checklist = readJson(join(s.run, 'checklist.json'));
    const auth = loadEvidenceAuthority({ runDir: s.run, checklist, keyRegistryPath: REGISTRY });
    assert.equal(auth.verified, false);
    assert.ok(auth.findings.some((f) => f.code === 'ARTIFACT_NOT_IN_SIGNED_MANIFEST' && f.artifact === 'V2-PLANTED.json'));
    const store = new EvidenceStore(s.run, { authority: { ...auth, verified: true } });
    assert.equal((await store.read('V2-PLANTED.json')).reason, REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST);
    assert.ok(!store.listArtifacts().includes('V2-PLANTED.json'), 'the signed catalogue is the artifact list');
  } finally { s.cleanup(); }
});

test('D1: a checklist that does not reproduce the signed contract cannot bind', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  checklist.obligations[0].statement = 'Something the signed ContractRevision never said.';
  const auth = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  assert.equal(auth.verified, false);
  assert.ok(auth.findings.some((f) => f.code === 'OBLIGATION_TEXT_DRIFT'));
});

test('D1: a stitched multi-span quote binds by its own digest, not by pretending it is one atom', async () => {
  const first = 'Respondents selecting code 2';
  const second = 'must continue to the follow-up screen.';
  const stitched = `${first} ${second}`;
  const requirement = {
    requirementLineageId: 'req_multispan_public_fixture',
    requirementVersionId: 'reqv_multispan_public_fixture',
    semanticFingerprint: 'sf_multispan_public_fixture',
    scope: 'question:Q1',
    quantifier: 'specific',
    selector: null,
    exceptions: [],
    facet: 'routing',
    assertionStatus: 'entailed',
    testability: 'browser-observable',
    sourceAtoms: [
      { blockId: 'b1', kind: 'paragraph', coords: null, role: 'routing', atomTextHash: sha256Of(Buffer.from(first)) },
      { blockId: 'b2', kind: 'paragraph', coords: null, role: 'routing', atomTextHash: sha256Of(Buffer.from(second)) },
    ],
    normativeStatement: 'Code 2 routes to the follow-up screen.',
    displayQuote: stitched,
    displayQuoteHash: sha256Of(Buffer.from(stitched)),
    retiredAt: null,
  };
  const contract = { items: [contractItemFromRequirement(requirement)] };
  const checklist = {
    obligations: [{
      id: requirement.requirementLineageId,
      statement: requirement.normativeStatement,
      doc_quote: stitched,
    }],
  };
  assert.deepEqual(bindChecklist(checklist, contract).findings, []);
  checklist.obligations[0].doc_quote = `${first} ${second} changed`;
  assert.ok(bindChecklist(checklist, contract).findings.some((finding) => finding.code === 'OBLIGATION_QUOTE_DRIFT'));
});

test('D1: without a pinned key registry nothing is publishable', async () => {
  const out = await judge(V2, { keyRegistryPath: null });
  assert.equal(out.status, 'diagnostic-only');
  assert.equal(out.judgement.publishable, false);
  assert.equal(out.judgement.attestation, undefined, 'a diagnostic is never signed');
  assert.match(out.judgement.renderingConstraint, /NON-FINAL OPERATIONAL DIAGNOSTIC/);
  assert.equal(out.certification.facets.recordAuthentic, false);
});

test('D1: a bound run mints a JudgementRecord that verifies against its bindings', async () => {
  const out = await judge(V2, { signer: { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' } });
  assert.equal(out.status, 'attestable');
  assert.equal(out.judgementAttestation.ok, true);
  assert.equal(validateJudgementRecord(out.judgement).ok, true);
  const runRecord = readJson(join(V2, 'run-record.json'));
  const v = verifyJudgementRecord(out.judgement, loadKeyRegistry(REGISTRY), {
    runRecord,
    expect: {
      runRecordPayloadHash: out.authority.runRecordPayloadHash,
      contractRevisionId: out.authority.contractRevisionId,
      targetBuildId: out.authority.targetBuildId,
      evidenceManifestRoot: out.authority.evidenceManifestRoot,
    },
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  for (const k of ['engineVersion', 'compilerVersion', 'predicateVersion', 'ambiguityPolicyVersion', 'resultPolicyVersion']) {
    assert.ok(out.judgement.binding[k], `binding.${k} is required`);
  }
});

test('D1: the minted record is the SHARED contract shape, accepted by the report boundary', async () => {
  // A variant spelling of "JudgementRecord" is rejected by name downstream, so
  // this is the test that keeps the judge from inventing its own.
  const out = await judge(V2, { signer: { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' } });
  assert.equal(out.judgement.kind, JUDGEMENT_RECORD_KIND);
  assert.equal(out.judgement.schemaVersion, JUDGEMENT_RECORD_SCHEMA);
  const r = evaluateJudgement({
    judgement: { judgementRecord: out.judgement },
    record: readJson(join(V2, 'run-record.json')),
    keyRegistry: loadKeyRegistry(REGISTRY),
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.state, 'trusted');
});

test('D1: an unsealed ContractRevision cannot be published, only diagnosed', async () => {
  // The frozen t1-easy RunRecord has no sealed revision block: its contract
  // hash identifies bytes, not a reviewed thing.
  const RUN = T1;
  const out = await judge(RUN, { signer: { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' } });
  assert.equal(out.authority.signatureVerified, true);
  assert.equal(out.authority.contractSealed, false);
  assert.equal(out.judgement.publishable, false);
  assert.equal(out.status, 'diagnostic-only');
  assert.equal(out.judgementAttestation.ok, false);
  assert.equal(out.certification.facets.contractReviewed, false);
});

test('D1: a diagnostic record refuses to be signed at all', async () => {
  const out = await judge(V2, { keyRegistryPath: null });
  const r = attestJudgementRecord(out.judgement, { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_BINDABLE');
});

test('D1: the evidence-manifest root is the SHARED definition and moves with the artifact set', async () => {
  const record = readJson(join(V2, 'run-record.json'));
  const auth = loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY });
  assert.equal(auth.evidenceManifestRoot, evidenceManifestRoot(record), 'the judge must not re-derive its own root');
  const altered = { ...record, evidence: record.evidence.map((e, i) => (i === 0 ? { ...e, contentHash: `sha256:${'0'.repeat(64)}` } : e)) };
  assert.notEqual(evidenceManifestRoot(altered), evidenceManifestRoot(record));
});

// ===========================================================================
// D3 — route identity and completeness
// ===========================================================================

test('D3: a code the DOCUMENT binds is the identity, so the route is reached', async () => {
  const r = byId(await judge(V2)).get('V2-ROUTE-DOCCODE');
  // The statement says "Beta"; the site renders "Beta option". Exact-label
  // matching reported this route as never reached while the table shows it.
  assert.equal(r.expectation.trigger.identity, 'code');
  assert.deepEqual(r.expectation.trigger.codes, ['2']);
  assert.equal(r.expectation.trigger.codeSource, 'doc_quote-routing-row');
  assert.notEqual(r.reason, REASON.NO_OBSERVATION_FOR_OBLIGATION);
  assert.equal(r.coverage, COVERAGE.EXERCISED);
});

test('D3: t1-easy — the two obligations reported not-reached over live routes are now judged', privateOnly('names the two obligations of the blind-derived run whose codes live only in its routing table'), async () => {
  const RUN = T1;
  const out = await judge(RUN);
  const m = byId(out);
  for (const id of ['OBL-B3C-12', 'OBL-B3C-13']) {
    const r = m.get(id);
    assert.equal(r.expectation.trigger.identity, 'code', `${id} must take its identity from the document's code`);
    assert.notEqual(r.reason, REASON.NO_OBSERVATION_FOR_OBLIGATION, `${id} was reported not-reached while the route table showed the route exercised`);
    assert.equal(r.coverage, COVERAGE.EXERCISED);
  }
});

test('D3: a label is corroboration only — it can never add a second live option', async () => {
  const out = await judge(V2);
  const r = byId(out).get('V2-ROUTE-DOCCODE');
  assert.equal(r.predicateDetail.corroboration.level, 'consistent', 'the document paraphrases the rendered label; it does not name a different option');
  assert.deepEqual(r.predicateDetail.corroboration.renderedAtTrigger, ['Beta option']);
  assert.deepEqual(r.predicateDetail.corroboration.conflicts, []);
});

test('D3: a code whose document label names a DIFFERENT live option is typed drift', async () => {
  const rows = [
    { answerLabels: ['Beta option'], answerCodes: ['2'], destinations: {}, answer: 'Beta option|2' },
    { answerLabels: ['Alpha option'], answerCodes: ['1'], destinations: {}, answer: 'Alpha option|1' },
  ];
  const ctx = { routeTable: { index: { Q1: rows }, sessions: 2 }, walks: [] };
  const exp = {
    kind: 'route', question: 'Q1', destination: 'Q3', mustNotShow: [],
    trigger: { mode: 'include', codes: ['2'], labels: ['Alpha option'], identity: 'code', codeSource: 'doc_quote-routing-row' },
    answerDomain: { sealed: true, codes: ['1', '2'], labels: {} },
  };
  const res = PREDICATES.route.run(exp, ctx);
  assert.equal(res.outcome, OUTCOME.INSUFFICIENT);
  assert.equal(res.reason, REASON.CODE_LABEL_CONFLICT, 'a code/label conflict is never an OR match');
});

test('D3: an exclusion rule needs the sealed answer domain', async () => {
  const r = byId(await judge(V2)).get('V2-ROUTE-UNSEALED');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.ANSWER_DOMAIN_UNSEALED);
  assert.notEqual(r.verdict, VERDICT.PASS, 'the complement of an unenumerated question is not a closed set');
});

test('D3: an exclusion rule passes only when every complement case ran', async () => {
  const pass = byId(await judge(V2)).get('V2-ROUTE-EXCLUDE');
  assert.equal(pass.verdict, VERDICT.PASS, 'all three documented codes of Q1 were exercised');

  // Drop one complement case and the same rule must stop passing.
  const rows = [
    { answerLabels: ['Alpha option'], answerCodes: ['1'], destinations: { Q2: { count: 1, witnesses: [] } }, answer: 'Alpha option|1' },
    { answerLabels: ['Beta option'], answerCodes: ['2'], destinations: { Q3: { count: 1, witnesses: [] } }, answer: 'Beta option|2' },
  ];
  const ctx = { routeTable: { index: { Q1: rows }, sessions: 2 }, walks: [] };
  const exp = {
    kind: 'route', question: 'Q1', destination: 'Q3', mustNotShow: [],
    trigger: { mode: 'exclude', codes: ['1'], labels: [], identity: 'code', codeSource: 'statement' },
    answerDomain: { sealed: true, codes: ['1', '2', '3'], labels: { 3: 'Gamma option' } },
  };
  const res = PREDICATES.route.run(exp, ctx);
  assert.equal(res.outcome, OUTCOME.INSUFFICIENT);
  assert.equal(res.reason, REASON.DOMAIN_CASE_UNEXERCISED);
  assert.deepEqual(res.detail.unexercised.map((u) => u.value), ['3']);
});

test('D3: conditional presence passes only when every domain case ran', async () => {
  assert.equal(byId(await judge(V2)).get('V2-PRESENCE').verdict, VERDICT.PASS);
  // ...and on the real run, the conditional rule whose base question has a
  // documented answer nobody gave cannot pass, however well the site behaved.
  const r = byId(await judge(T1)).get(SHAPE.unexercisedDomainObligation);
  assert.ok(r, `${SHAPE.unexercisedDomainObligation} must be judged`);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.DOMAIN_CASE_UNEXERCISED,
    'a documented answer that was never exercised leaves "only if code N" undecided');
});

test('D3: a code is never inferred from behaviour when the document supplies none', async () => {
  const rows = [{ answerLabels: ['Whatever'], answerCodes: ['7'], destinations: { Q3: { count: 1, witnesses: [] } }, answer: 'Whatever|7' }];
  const ctx = { routeTable: { index: { Q1: rows }, sessions: 1 }, walks: [] };
  const exp = {
    kind: 'route', question: 'Q1', destination: 'Q3', mustNotShow: [],
    trigger: { mode: 'include', codes: [], labels: ['Something else'], identity: 'label', codeSource: null },
    answerDomain: { sealed: false, codes: [] },
  };
  const res = PREDICATES.route.run(exp, ctx);
  assert.notEqual(res.outcome, OUTCOME.SATISFIED, 'the live code 7 must not be adopted as the document\'s identity');
});

// ===========================================================================
// D4 — ambiguity: locked policy, dependency-aware suppression
// ===========================================================================

test('D4: judgeRun refuses a caller-supplied policy', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, policy: {} }),
    /locked gate/,
    'a caller passing {} used to disable BOTH the pass- and fail-blocking halves',
  );
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, policy: { blockFail: false, blockPass: false } }), /locked gate/);
});

test('D4: precedenceFor takes no policy argument', async () => {
  const idx = { index: new Map() };
  assert.throws(() => precedenceFor('X', idx, { blockFail: false }), /no policy argument/);
  assert.equal(LOCKED_POLICY.blockFail, true);
  assert.equal(LOCKED_POLICY.blockPass, true);
  assert.equal(Object.isFrozen(LOCKED_POLICY), true);
});

test('D4: an ambiguity about a field the predicate never reads suppresses nothing', async () => {
  const out = await judge(V2);
  const r = byId(out).get('V2-BACKBUTTON');
  assert.equal(r.verdict, VERDICT.PASS, 'which screens are "the closing screens" cannot alter a rule pinned to WELCOME');
  assert.ok(out.ambiguityIndex.suppressionsDeclinedAsIrrelevant.some(
    (s) => s.obligationId === 'V2-BACKBUTTON' && s.ambiguityId === 'AMB-V2-IRRELEVANT',
  ));
});

test('D4: an outcome-relevant ambiguity still withholds — even as the sole covering obligation', async () => {
  const r = byId(await judge(V2)).get('V2-ROUTE-DOCCODE');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.AMBIGUITY_PRECEDENCE);
  assert.deepEqual(r.withheld.blockedBy, ['AMB-V2-RELEVANT']);
});

test('D4: relevance is decided per predicate, not per obligation', async () => {
  const locus = ambiguityLocus({
    reading_a: 'The two closing screens are the final thank-you screen and the screen-out screen.',
    reading_b: 'The two closing screens are the penultimate debrief screen and the final completion screen.',
  });
  assert.equal(locus.state, 'typed');
  // consumes only {control, screen}
  assert.equal(locusTouchesExpectation(locus, { kind: 'control-absent-on-screen', screen: 'WELCOME', control: 'back' }).relevant, false);
  // consumes screenScope — every screen is in play
  assert.equal(locusTouchesExpectation(locus, { kind: 'control-on-every-screen', control: 'progress' }).relevant, true);
});

test('D4: an ambiguity with no typed content fails CLOSED', async () => {
  const locus = ambiguityLocus({ reading_a: '', reading_b: '' });
  assert.equal(locus.state, 'unresolved');
  assert.equal(locusTouchesExpectation(locus, { kind: 'option-present', screen: 'Q1' }).relevant, true);
});

test('D4: the bare-screen repair no longer sprays suppression across unrelated facets', async () => {
  const RUN = T1;
  const out = await judge(RUN);
  const declined = out.ambiguityIndex.suppressionsDeclinedAsIrrelevant.filter((s) => s.ambiguityId === SHAPE.irrelevantAmbiguity);
  assert.ok(
    declined.length >= SHAPE.irrelevantAmbiguityMinDeclines,
    `a screen reference that touches no facet of these obligations used to suppress all of them (${declined.length} declined)`,
  );
});

// ===========================================================================
// D5 — proof projections and attested completeness
// ===========================================================================

test('D5: a route witness attests the COMPLETE edge tuple, not just the destination', async () => {
  const out = await judge(V2);
  const r = byId(out).get('V2-ROUTE-EXCLUDE');
  const w = r.attestation.positive[0];
  assert.equal(w.proofKind, PROOF_KIND.ROUTE_EDGE);
  assert.ok(w.witness.proofClaim.fromScreen && w.witness.proofClaim.toScreen);
  assert.ok(Array.isArray(w.witness.proofClaim.answerCodes));
  assert.equal(w.ok, true);
});

test('D5: an edge whose SOURCE answer is misreported fails re-verification', async () => {
  const store = new EvidenceStore(V2, { authority: loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY }) });
  const good = await store.attest({
    artifact: 'V2-CLEAN-B.json', proofKind: PROOF_KIND.ROUTE_EDGE,
    proof: { kind: PROOF_KIND.ROUTE_EDGE, claim: { fromSeq: 1, toSeq: 2, fromScreen: 'Q1', toScreen: 'Q3', answerLabels: ['Beta option'], answerCodes: ['2'], source: 'forward-answer' } },
  });
  assert.equal(good.ok, true);
  // The destination is genuinely Q3 — the OLD witness would still verify.
  const lie = await store.attest({
    artifact: 'V2-CLEAN-B.json', proofKind: PROOF_KIND.ROUTE_EDGE,
    proof: { kind: PROOF_KIND.ROUTE_EDGE, claim: { fromSeq: 1, toSeq: 2, fromScreen: 'Q1', toScreen: 'Q3', answerLabels: ['Alpha option'], answerCodes: ['1'], source: 'forward-answer' } },
  });
  assert.equal(lie.ok, false, 'the answer that produced the edge is part of the claim');
  const oldStyle = await store.attest({ artifact: 'V2-CLEAN-B.json', locator: 'evidence[1].screen_id', equals: 'Q3' });
  assert.equal(oldStyle.ok, true, 'which is exactly why the single-field projection was not enough');
});

test('D5: a non-adjacent "edge" is not a forward transition', async () => {
  const store = new EvidenceStore(V2, { authority: loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY }) });
  const r = await store.attest({
    artifact: 'V2-Q3-ONWARD.json', proofKind: PROOF_KIND.ROUTE_EDGE,
    proof: { kind: PROOF_KIND.ROUTE_EDGE, claim: { fromSeq: 1, toSeq: 3, fromScreen: 'Q1', toScreen: 'D1', answerLabels: ['Gamma option'], answerCodes: ['3'], source: 'forward-answer' } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASON.NOT_A_FORWARD_TRANSITION);
});

test('D5: a conditional-presence witness attests the GATE as well as the occurrence', async () => {
  const r = byId(await judge(V2)).get('V2-PRESENCE');
  const w = r.attestation.positive[0];
  assert.equal(w.proofKind, PROOF_KIND.GATED_OCCURRENCE);
  assert.equal(w.witness.proofClaim.gateScreen, 'Q1');
  assert.deepEqual(w.witness.proofClaim.gateCodes, ['1']);
  assert.equal(w.ok, true);
});

test('D5: a predicate-authored scope count cannot certify its own completeness', async () => {
  const out = await withPredicate('option-present', () => ({
    outcome: OUTCOME.SATISFIED,
    reason: REASON.COMPLETE_POSITIVE_INVENTORY,
    witnesses: [{ artifact: 'V2-CLEAN-A.json', locator: 'evidence[0].screen_id', equals: 'Q1' }],
    counterWitnesses: [],
    // A scope that says it enumerated a population it never touched.
    scope: { claimKind: 'scoped-inventory', screen: 'Q1', filter: { device: 'desktop', requires: 'inventory' }, capturesEnumerated: 999, memberCount: 999, membersDigest: `sha256:${'0'.repeat(64)}` },
  }), () => judge(V2));
  const r = byId(out).get('V2-OPT-1');
  assert.notEqual(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.SCOPE_DIGEST_MISMATCH);
});

test('D5: an absence claim over an unreproducible population is refused', async () => {
  const out = await withPredicate('option-present', () => ({
    outcome: OUTCOME.SATISFIED,
    reason: REASON.COMPLETE_POSITIVE_INVENTORY,
    witnesses: [{ artifact: 'V2-CLEAN-A.json', locator: 'evidence[0].screen_id', equals: 'Q1' }],
    counterWitnesses: [],
    absenceClaim: true,
    scope: { claimKind: 'scoped-absence', capturesScanned: 4242, memberCount: 4242, membersDigest: `sha256:${'f'.repeat(64)}`, filter: {} },
  }), () => judge(V2));
  const r = byId(out).get('V2-OPT-1');
  assert.notEqual(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.SCOPE_DIGEST_MISMATCH);
});

test('D5: a VIOLATION built on a partial scan is refused too, not just a pass', async () => {
  const out = await withPredicate('option-present', () => ({
    outcome: OUTCOME.VIOLATED,
    reason: REASON.OPTION_ABSENT,
    witnesses: [],
    counterWitnesses: [{ artifact: 'V2-CLEAN-A.json', locator: 'evidence[0].screen_id', equals: 'Q1' }],
    scope: { claimKind: 'scoped-inventory', screen: 'Q1', filter: { device: 'desktop', requires: 'inventory' }, capturesEnumerated: 1, memberCount: 1, membersDigest: `sha256:${'a'.repeat(64)}` },
  }), () => judge(V2));
  const r = byId(out).get('V2-OPT-1');
  assert.notEqual(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.SCOPE_DIGEST_MISMATCH);
});

test('D5: a structural claim may not be attested by a single-field lookup', async () => {
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.SATISFIED,
    reason: REASON.POSITIVE_WITNESS,
    // A perfectly TRUE single-field witness — and still not a proof of the edge.
    witnesses: [{ artifact: 'V2-CLEAN-B.json', locator: 'evidence[1].screen_id', equals: 'Q3' }],
    counterWitnesses: [],
  }), () => judge(V2));
  const r = byId(out).get('V2-ROUTE-EXCLUDE');
  assert.notEqual(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.PROOF_PROJECTION_MISSING);
});

test('D5: declareScope commits to a member digest the attestor can rebuild', async () => {
  const s = declareScope({ claimKind: 'scoped-inventory', screen: 'Q1' }, [{ artifact: 'A.json', seq: 1 }, { artifact: 'B.json', seq: 2 }]);
  assert.equal(s.memberCount, 2);
  assert.match(s.membersDigest, /^sha256:[0-9a-f]{64}$/);
  const other = declareScope({ claimKind: 'scoped-inventory', screen: 'Q1' }, [{ artifact: 'A.json', seq: 1 }]);
  assert.notEqual(s.membersDigest, other.membersDigest);
});

// ===========================================================================
// D6 — required-answer enforcement
// ===========================================================================

test('D6: a frozen page is not enforcement', async () => {
  const r = byId(await judge(V2)).get('V2-REQ-FROZEN');
  // advanced:false, blocked:false, no validation — `!advanced || blocked` PASSED.
  assert.notEqual(r.verdict, VERDICT.PASS);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.ENFORCEMENT_NOT_DEMONSTRATED);
});

test('D6: a self-contradictory probe is an integrity failure, not a pass', async () => {
  const r = byId(await judge(V2)).get('V2-REQ-CONTRA');
  // advanced:true AND blocked:true used to pass on the second disjunct.
  assert.notEqual(r.verdict, VERDICT.PASS);
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.coverage, COVERAGE.BLOCKED);
  assert.equal(r.reason, REASON.PROBE_SELF_CONTRADICTORY);
});

test('D6: a demonstrated refusal still passes', async () => {
  const r = byId(await judge(V2)).get('V2-REQ-ENFORCED');
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.attestation.positive[0].proofKind, PROOF_KIND.PROBE_OUTCOME);
  assert.equal(r.attestation.positive[0].ok, true);
});

test('D6: t1-easy keeps its one genuine enforcement pass', async () => {
  const RUN = T1;
  const out = await judge(RUN);
  const enforced = out.results.filter((r) => r.predicateId === 'answer-requirement@1' && r.verdict === VERDICT.PASS);
  assert.ok(enforced.length >= 1, 'FLOOR-04 is a real refusal (advanced=false, blocked=true, validation shown, screen unchanged)');
});

// ===========================================================================
// D7 — route-table admission
// ===========================================================================

test('D7: a same-screen re-capture is not a route', async () => {
  const out = await judge(V2);
  assert.ok(!out.routeTable.rows.some((r) => r.question === 'Q8'), 'the Q8 validation probe used to become the route Q8 -> Q8');
  assert.ok(out.routeTable.skipped.some((s) => s.session === 'V2-SAMESCRN' && /same screen/.test(s.why)));
});

test('D7: a typed action naming a control the capture lacks is not corroborated', async () => {
  const out = await judge(V2);
  assert.ok(!out.routeTable.rows.some((r) => r.question === 'Q9'), 'a typed step used to be admitted with no corroboration at all');
  assert.ok(out.routeTable.integrity.some((i) => i.code === REASON.ACTION_VALUE_NOT_CORROBORATED && i.session === 'V2-TYPED'));
});

test('D7: a duplicate capture index quarantines the session instead of overwriting it', async () => {
  const out = await judge(V2);
  assert.ok(out.routeTable.integrity.some((i) => i.code === REASON.SESSION_QUARANTINED && i.session === 'V2-BROKEN' && /DUPLICATE/.test(i.detail)));
  assert.ok(!out.routeTable.rows.some((r) => Object.keys(r.destinations).includes('SCREENOUT')),
    'the dropped capture used to become somebody else\'s "next screen"');
  assert.equal(out.source.sessionsQuarantined >= 2, true);
});

test('D7: a spine with a hole is quarantined, not treated as gap-free', async () => {
  const out = await judge(V2);
  assert.ok(out.routeTable.integrity.some((i) => i.code === REASON.SESSION_QUARANTINED && i.session === 'V2-GAP' && /CONSECUTIVE/.test(i.detail)));
});

test('D7: a quarantined session contributes no captures to any inventory', async () => {
  const ctx = await buildContext(V2, readJson(join(V2, 'checklist.json')), {
    authority: loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY }),
  });
  const sessionsInCensus = new Set(Object.values(ctx.census.byScreen).flatMap((c) => c.captures.map((x) => x.session)));
  assert.ok(!sessionsInCensus.has('V2-BROKEN'));
  assert.ok(!sessionsInCensus.has('V2-GAP'));
});

test('D7: a trace action whose screen disagrees with the capture is discarded', async () => {
  const s = scratchCopy(V2);
  try {
    const victim = join(s.run, 'artifacts', 'V2-CLEAN-A.json');
    const doc = readJson(victim);
    doc.trace[0].screen = 'Q5'; // the capture at seq 1 is Q1
    writeFileSync(victim, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    // resign, so this test isolates D7 rather than tripping D1
    resign(s.run);
    const before = (await judge(V2)).routeTable.rows.find((r) => r.question === 'Q1' && r.answer === 'Alpha option|1');
    const out = await judge(s.run);
    assert.ok(out.routeTable.integrity.some((i) => /trace screen Q5 != evidence screen Q1/.test(i.detail || '')));
    const alpha = out.routeTable.rows.find((r) => r.question === 'Q1' && r.answer === 'Alpha option|1');
    assert.equal(alpha.destinations.Q2.count, before.destinations.Q2.count - 1, 'the mismatched action must not author an edge');
  } finally { s.cleanup(); }
});

// ===========================================================================
// D8 — certification facets
// ===========================================================================

test('D8: the six facets are reported separately and certifiable is their conjunction', async () => {
  const out = await judge(V2);
  const f = out.certification.facets;
  for (const k of ['recordAuthentic', 'evidenceValid', 'contractReviewed', 'resultsReviewed', 'testComplete', 'defectFree']) {
    assert.equal(typeof f[k], 'boolean', `${k} must be reported`);
  }
  assert.equal(out.certification.certifiable, Object.values(f).every(Boolean));
  assert.deepEqual(out.certification.conjunction.sort(), Object.keys(f).sort());
});

test('D8: incomplete testing can no longer certify green', async () => {
  const out = await judge(V2);
  // no fails and nothing withheld-as-fail...
  assert.equal(out.counts.byVerdict.fail, 0);
  assert.equal(out.certification.facets.defectFree, true);
  // ...but rows are inconclusive / not exercised, so certification is refused.
  assert.equal(out.certification.facets.testComplete, false);
  assert.equal(out.certification.certifiable, false, 'the old rule was blockers===0 && fails===0, which this run satisfies');
  assert.ok(out.certification.blockers.some((b) => b.facet === 'testComplete'));
});

test('D8: an untyped obligation blocks resultsReviewed rather than vanishing', async () => {
  const out = await judge(MINI);
  assert.equal(out.counts.noTypedExpectation > 0, true);
  assert.equal(out.certification.facets.resultsReviewed, false);
  assert.ok(out.certification.blockers.some((b) => b.facet === 'resultsReviewed' && b.code === REASON.NO_TYPED_EXPECTATION));
});

test('D8: route-table integrity findings reach the certification blockers', async () => {
  const out = await judge(V2);
  assert.equal(out.certification.facets.evidenceValid, false);
  assert.ok(out.certification.blockers.some((b) => b.facet === 'evidenceValid' && b.code === REASON.SESSION_QUARANTINED));
});

// ===========================================================================
// advisory items
// ===========================================================================

test('advisory: attest() refuses a DERIVED_SUMMARY, not only an image', async () => {
  const store = new EvidenceStore(V2, { authority: loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY }) });
  const r = await store.attest({ artifact: '_analysis.json', locator: 'screens.Q1', equals: 'fine' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASON.DERIVED_SUMMARY_CITED_AS_PRIMARY);
});

test('advisory: attest() refuses an UNKNOWN artifact class', async () => {
  const store = new EvidenceStore(V2, { authority: loadEvidenceAuthority({ runDir: V2, checklist: readJson(join(V2, 'checklist.json')), keyRegistryPath: REGISTRY }) });
  const r = await store.attest({ artifact: 'mystery.json', locator: 'screens[0].id', equals: 'Q1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASON.UNKNOWN_ARTIFACT_CLASS_CITED);
});

test('advisory: evidence references cannot escape the artifacts directory', async () => {
  const store = new EvidenceStore(V2);
  for (const ref of ['../checklist.json', '../../../../etc/passwd', 'a/../../b.json', 'C:/Windows/win.ini', 'artifacts/../checklist.json']) {
    const rec = await store.read(ref);
    assert.equal(rec.ok, false, `${ref} must not resolve`);
    assert.equal(rec.reason, REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT, `${ref} must be refused as traversal`);
  }
});

test('advisory: a locator cannot reach an inherited or prototype property', async () => {
  assert.equal(resolvePath({}, 'constructor').ok, false);
  assert.equal(resolvePath({}, '__proto__').ok, false);
  assert.equal(resolvePath({}, 'toString').ok, false);
  assert.equal(resolvePath({ a: { b: 1 } }, 'a.b').ok, true);
});

test('advisory: allVerified is FALSE for an empty witness collection', async () => {
  const out = await withPredicate('option-present', () => ({
    outcome: OUTCOME.INSUFFICIENT, reason: REASON.INSUFFICIENT_SAMPLE, witnesses: [], counterWitnesses: [],
  }), () => judge(V2));
  const r = byId(out).get('V2-OPT-1');
  assert.equal(r.attestation.witnessCount, 0);
  assert.equal(r.attestation.allVerified, false, '[].every(...) is true, which reported a citation-free claim as verified');
});

// ===========================================================================
// N3 — five predicate classes could not return `fail` AT ALL
//
// The D5 tripwire demands that a SATISFIED *or* VIOLATED completeness claim
// attest its scope. Five predicates attached `declareScope(...)` only to their
// pass return, so their violation return was demoted to
// NOT-ASSESSED / BLOCKED / QUERY with reason SCOPE_INCOMPLETE_FOR_CLAIM before
// the verdict switch ever ran. They observed the violation, attested a
// counter-witness, and then could not call it a defect.
//
// It failed SAFE, which is why every suite stayed green: the demotion is not
// `inconclusive` (a distinct VERDICT cell), and mini-run / mini-v2 contain no
// obligation that drives any of the five to a violation at all. The fix does
// NOT weaken the gate — it hoists the existing `declareScope(...)` above the
// branch so the violation SATISFIES the same independent re-derivation.
//
// The fixture is `fixtures/mini-n3` (see make-n3-fixtures.mjs): one plainly
// visible planted violation per class, present in one session out of two.
// ===========================================================================

/** obligation -> the class it exercises, and the defect it must report. */
const N3_CLASSES = [
  { id: 'N3-FORB', predicateId: 'text-forbidden@1', reason: REASON.FORBIDDEN_TEXT_DISPLAYED, what: 'forbidden text — the client name shown to respondents' },
  { id: 'N3-LEAK', predicateId: 'no-instruction-leak@1', reason: REASON.PROGRAMMER_INSTRUCTION_LEAKED, what: 'a leaked programmer instruction — "[ASK ALL]" left in the copy' },
  { id: 'N3-BACK', predicateId: 'control-absent-on-screen@1', reason: REASON.CONTROL_PRESENT_WHERE_FORBIDDEN, what: 'a forbidden control — a back button on the welcome screen' },
  { id: 'N3-WELC', predicateId: 'screen-controls-only@1', reason: REASON.CONTROL_PRESENT_WHERE_FORBIDDEN, what: 'screen-controls-only — an answer control on the welcome screen' },
  { id: 'N3-ONEQ', predicateId: 'one-question-per-screen@1', reason: REASON.MULTIPLE_QUESTIONS_ON_SCREEN, what: 'two question stems on one screen' },
];

for (const c of N3_CLASSES) {
  test(`N3: ${c.predicateId} can report a violation (${c.what})`, async () => {
    const r = byId(await judge(N3)).get(c.id);
    assert.equal(r.predicateId, c.predicateId);
    assert.equal(r.predicateOutcome, OUTCOME.VIOLATED, 'the predicate must see the planted violation');
    // The whole defect: this used to be not-assessed / blocked / query.
    assert.equal(r.verdict, VERDICT.FAIL, `${c.predicateId} must be able to reach a fail`);
    assert.equal(r.coverage, COVERAGE.EXERCISED);
    assert.equal(r.disposition, DISPOSITION.DEFECT);
    assert.equal(r.reason, c.reason);
    assert.notEqual(r.reason, REASON.SCOPE_INCOMPLETE_FOR_CLAIM);
    // ...and D5 is SATISFIED, not bypassed, on the way there.
    assert.deepEqual(r.tripwires, [], 'no tripwire may fire on a well-scoped violation');
    assert.ok(r.evidenceScope, 'a published fail must carry a reproducible population');
    assert.ok(ATTESTABLE_SCOPES.has(r.evidenceScope.claimKind));
    assert.match(r.evidenceScope.membersDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(r.counterWitnesses.length > 0);
    assert.equal(r.attestation.allVerified, true);
  });
}

test('N3: every SCOPE_REQUIRED predicate can reach a violation that attests its scope', async () => {
  // Structural, so it cannot rot the way the old "one fixture per predicate"
  // layer did: it iterates the gate's own membership list. Adding an id to
  // SCOPE_REQUIRED without giving its violation branch a scope fails here.
  const checklist = readJson(join(N3, 'checklist.json'));
  const ctx = await buildContext(N3, checklist, {
    authority: loadEvidenceAuthority({ runDir: N3, checklist, keyRegistryPath: REGISTRY }),
  });
  // The four D8 predicates need a whole survey behind them — a route table, a
  // document-derived terminal set, a multi-screen control census. They are
  // driven against the REAL, SIGNED t1-easy run rather than a fixture shaped to
  // fit them: the expectation is synthetic (that is the point — it has to reach
  // the violation branch), every artifact underneath it is not.
  const t1Checklist = readJson(join(T1, 'checklist.json'));
  const t1 = await buildContext(T1, t1Checklist, {
    authority: loadEvidenceAuthority({ runDir: T1, checklist: t1Checklist, keyRegistryPath: REGISTRY }),
  });
  /** A hand-built expectation per id, driving the REAL predicate to VIOLATED. */
  const cases = {
    'option-present@1': { on: ctx, exp: { kind: 'option-present', screen: 'Q1', label: 'Gamma option', code: '3' } },
    'option-set-exact@1': { on: ctx, exp: { kind: 'option-set-exact', screen: 'Q1', labels: ['Alpha option', 'Beta option', 'Gamma option'] } },
    'option-order-fixed@1': { on: ctx, exp: { kind: 'option-order-fixed', screen: 'Q2' } },
    'option-order-randomized@1': { on: ctx, exp: { kind: 'option-order-randomized', screen: 'Q2', fixedLast: ['1'] } },
    'grid-row-present@1': { on: ctx, exp: { kind: 'grid-row-present', screen: 'Q3', rowLabel: 'R2', statement: 'Row two' } },
    'selection-mode@1': { on: ctx, exp: { kind: 'selection-mode', screen: 'Q2', mode: 'single' } },
    'text-forbidden@1': { on: ctx, exp: { kind: 'text-forbidden', text: 'Acme Beverages' } },
    'no-instruction-leak@1': { on: ctx, exp: { kind: 'no-instruction-leak' } },
    'one-question-per-screen@1': { on: ctx, exp: { kind: 'one-question-per-screen' } },
    'control-absent-on-screen@1': { on: ctx, exp: { kind: 'control-absent-on-screen', screen: 'WELCOME', control: 'back' } },
    'screen-controls-only@1': { on: ctx, exp: { kind: 'screen-controls-only', screen: 'WELCOME', button: 'Start survey' } },
    // --- D8: the four that used to attest their own universes ---------------
    // The routing rule this run really does get wrong, driven through the gate.
    // Its coordinates come from the run's substrate-shape.json, so a public
    // test file never restates a planted defect.
    'route@1': {
      on: t1,
      exp: {
        kind: 'route',
        question: SHAPE.divergingRoute.question,
        destination: SHAPE.divergingRoute.destination,
        sequence: null,
        mustNotShow: SHAPE.divergingRoute.mustNotShow,
        trigger: { mode: 'include', codes: SHAPE.divergingRoute.codes, labels: [], identity: 'code' },
        answerDomain: { sealed: false, codes: [] },
      },
    },
    'screen-conditional-presence@1': {
      on: t1,
      exp: {
        kind: 'screen-conditional-presence',
        screen: SHAPE.conditionalScreen.screen,
        condition: { question: SHAPE.conditionalScreen.question, codes: SHAPE.conditionalScreen.codes, labels: [], identity: 'code' },
        answerDomain: { sealed: false, codes: [] },
      },
    },
    // A genuinely conditional screen: completing sessions that never saw it are
    // real counter-evidence to "shown to every respondent".
    'screen-universal@1': { on: t1, exp: { kind: 'screen-universal', screen: SHAPE.notUniversalScreen } },
    // The welcome screen has no back button by design.
    'control-on-every-screen@1': { on: t1, exp: { kind: 'control-on-every-screen', control: 'back' } },
    // Every recorded session really does start on WELCOME, so claiming any
    // other screen is first is a violation over the whole session set.
    'first-screen@1': { on: t1, exp: { kind: 'first-screen', screen: SHAPE.notFirstScreen } },
  };
  assert.deepEqual([...SCOPE_REQUIRED].filter((id) => !cases[id]), [],
    'every predicate the D5 gate covers needs a violation case here, or it can be muted unnoticed');

  for (const id of SCOPE_REQUIRED) {
    const { on, exp } = cases[id];
    const res = runPredicate(exp, on);
    assert.equal(res.predicateId, id, `${id}: the case must drive the predicate under test`);
    assert.equal(res.outcome, OUTCOME.VIOLATED, `${id}: the fixture must actually violate it`);
    assert.ok(res.scope, `${id}: a violation carries a population-scoped count, so it must declare its scope`);
    assert.ok(ATTESTABLE_SCOPES.has(res.scope.claimKind), `${id}: claimKind ${res.scope.claimKind} is not attestable`);
    assert.notEqual(res.absenceClaim, true, `${id}: a violation is a PRESENCE finding, never an absence claim`);
    const att = await on.scopeAttestor.attest(res.scope);
    assert.equal(att.ok, true, `${id}: the declared population must re-derive from the signed artifacts: ${JSON.stringify(att.detail)}`);
  }
});

test('N3: a violation declares the WHOLE population it searched, not just the captures that violated', async () => {
  // mini-n3 has two sessions x five screens. The welcome-screen violations are
  // planted in ONE session only, and the survey-wide ones hit one capture. A
  // scope built from `bads` instead of the enumerated population would still be
  // refused by ScopeAttestor — this pins that the fix declares the right set.
  const m = byId(await judge(N3));
  assert.equal(m.get('N3-BACK').evidenceScope.memberCount, 2, 'both WELCOME captures, not only the offending one');
  assert.equal(m.get('N3-WELC').evidenceScope.memberCount, 2);
  assert.equal(m.get('N3-BACK').predicateDetail.violations, 1);
  assert.equal(m.get('N3-BACK').predicateDetail.of, 2);
  for (const id of ['N3-FORB', 'N3-LEAK', 'N3-ONEQ']) {
    assert.equal(m.get(id).evidenceScope.memberCount, 10, `${id}: every capture of every screen was searched`);
  }
});

test('N3: the five classes reach the defectFree facet as defects, not as evidence-integrity noise', async () => {
  const out = await judge(N3);
  assert.equal(out.certification.facets.defectFree, false);
  // Before the fix these landed in `evidenceValid` / `resultsReviewed` as
  // SCOPE_INCOMPLETE_FOR_CLAIM, and defectFree never saw them.
  const df = out.certification.blockers.filter((b) => b.facet === CERT_FACET.DEFECT_FREE);
  for (const c of N3_CLASSES) {
    const hit = df.find((b) => b.obligationId === c.id);
    assert.ok(hit, `${c.id} must block defectFree`);
    assert.equal(hit.code, c.reason, `${c.id} must block it as ${c.reason}, not as an integrity demotion`);
  }
  assert.equal(out.certification.facets.evidenceValid, true, 'a well-scoped defect is not an evidence-integrity failure');
  assert.equal(out.certification.facets.resultsReviewed, true);
  assert.equal(out.counts.byVerdict['not-assessed'], 0);
});

test('N3: an observed violation demoted below fail can never report defectFree', async () => {
  // The facet's own guard, independent of the five predicates: whatever demotes
  // a violation — this D5 tripwire, or the next one — `defectFree: true` would
  // be the claim that nothing was wrong, and a violation WAS observed.
  const out = await withPredicate('option-present', () => ({
    outcome: OUTCOME.VIOLATED,
    reason: REASON.OPTION_ABSENT,
    witnesses: [],
    counterWitnesses: [{ artifact: 'V2-CLEAN-A.json', locator: 'evidence[0].screen_id', equals: 'Q1' }],
    // a scope no independent re-derivation can reproduce -> demoted
    scope: { claimKind: 'scoped-inventory', screen: 'Q1', filter: { device: 'desktop', requires: 'inventory' }, memberCount: 1, membersDigest: `sha256:${'a'.repeat(64)}` },
  }), () => judge(V2));
  const r = byId(out).get('V2-OPT-1');
  assert.equal(r.predicateOutcome, OUTCOME.VIOLATED);
  assert.notEqual(r.verdict, VERDICT.FAIL, 'the D5 gate still refuses an unreproducible violation');
  assert.equal(out.counts.byVerdict.fail, 0, 'no row is a fail...');
  assert.ok(out.certification.counts.suppressedDefects >= 1, 'the demoted violation is counted, not lost');
  assert.equal(out.certification.facets.defectFree, false, '...and the run still may not call itself defect-free');
  assert.ok(out.certification.blockers.some((b) => b.facet === CERT_FACET.DEFECT_FREE && b.obligationId === 'V2-OPT-1'));
});

test('N3: the D5 gate was not narrowed to buy this — an unreproducible violation is still refused', async () => {
  // The tempting alternatives were "drop these five from SCOPE_REQUIRED" and
  // "run the tripwire only on SATISFIED". Both would let the five report a
  // fail, and both would trade a security property for a detection one: every
  // one of these violation payloads reports population-scoped counts
  // (`violations: N of M`, `matches: N of capturesScanned`), which are
  // self-certifying unless the population is independently rebuilt. This test
  // fails if either shortcut is ever taken. It is deliberately NOT sensitive to
  // reverting the real fix — it guards the opposite direction.
  for (const c of N3_CLASSES) {
    assert.ok(SCOPE_REQUIRED.has(c.predicateId), `${c.predicateId} must stay inside the D5 gate`);
  }
  const counter = [{ artifact: 'N3-A.json', locator: 'evidence[0].screen_id', equals: 'WELCOME' }];
  for (const c of N3_CLASSES) {
    const kind = c.predicateId.replace(/@1$/, '');
    // (a) a violation that declares no scope at all
    const noScope = await withPredicate(kind, () => ({
      outcome: OUTCOME.VIOLATED, reason: c.reason, witnesses: [], counterWitnesses: counter,
    }), async () => byId(await judge(N3)).get(c.id));
    assert.notEqual(noScope.verdict, VERDICT.FAIL, `${c.predicateId}: an unscoped violation must not publish`);
    // The tripwire LIST is asserted, not just the first code: since D10 the
    // same stubbed payload also trips PROOF_PROJECTION_MISSING (its
    // counter-witness is a bare capture-field lookup where the claim needs a
    // text-occurrence or a control census), and `reason` reports whichever
    // wire fired first. Asserting the list keeps this test pinned to the scope
    // gate rather than to the order the wires happen to run in.
    assert.ok(noScope.tripwires.some((t) => t.code === REASON.SCOPE_INCOMPLETE_FOR_CLAIM),
      `${c.predicateId}: the scope gate must be one of the wires that fired, got ${JSON.stringify(noScope.tripwires.map((t) => t.code))}`);

    // (b) a violation whose declared population does not exist
    const badScope = await withPredicate(kind, () => ({
      outcome: OUTCOME.VIOLATED, reason: c.reason, witnesses: [], counterWitnesses: counter,
      scope: { claimKind: 'scoped-absence', screen: 'WELCOME', filter: {}, capturesEnumerated: 999, memberCount: 999, membersDigest: `sha256:${'0'.repeat(64)}` },
    }), async () => byId(await judge(N3)).get(c.id));
    assert.notEqual(badScope.verdict, VERDICT.FAIL, `${c.predicateId}: a violation from a partial scan must not publish`);
    assert.ok(badScope.tripwires.some((t) => t.code === REASON.SCOPE_DIGEST_MISMATCH),
      `${c.predicateId}: the population must be re-derived and disagree, got ${JSON.stringify(badScope.tripwires.map((t) => t.code))}`);
  }
});

test('N3: the pass path of the five classes is unchanged', async () => {
  // The fix hoists a declaration; it must not turn a clean screen into a defect.
  const r = byId(await judge(V2)).get('V2-BACKBUTTON');
  assert.equal(r.predicateId, 'control-absent-on-screen@1');
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.COMPLETE_POSITIVE_INVENTORY);
  assert.equal(r.evidenceScope.claimKind, 'scoped-absence');
  const clean = byId(await judge(N3));
  for (const id of ['N3-Q1-OPT-1', 'N3-Q1-OPT-2', 'N3-Q2-OPT-1', 'N3-Q2-OPT-2', 'N3-Q2-OPT-3']) {
    assert.equal(clean.get(id).verdict, VERDICT.PASS, `${id} must still pass`);
  }
});

// ###########################################################################
// ROUND 3 — one regression per defect.
//
// Every acceptance proof below runs against an artifact set a real producer
// made: the frozen, signed `pipeline/runs/t1-easy` wherever the defect can be
// exercised there, and otherwise a fixture run rebuilt by its own generator and
// re-signed by `sign-run.mjs`. Where a test needs a specific violation branch it
// synthesises the EXPECTATION (the document side) and never the evidence.
// ###########################################################################

const t1Judge = () => judge(T1);
const t1Checklist = () => readJson(join(T1, 'checklist.json'));
const t1Authority = () => loadEvidenceAuthority({ runDir: T1, checklist: t1Checklist(), keyRegistryPath: REGISTRY });

// ===========================================================================
// D2 — injected evidence may not be signed by someone else's authority
// ===========================================================================

test('D2: the production entry point refuses injected evidence outright', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  const store = new EvidenceStore(V2, { authority });
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, store }),
    /does not accept `store` or `sessions`/,
    'judgeRun accepted an evidence store; that is the whole defect',
  );
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, sessions: await loadSessions(store) }),
    /does not accept `store` or `sessions`/,
  );
});

test('D2: authority from run A cannot sign verdicts derived from run B\'s evidence', async () => {
  // The exact attack: a VERIFIED authority for the real t1-easy run, combined
  // with an evidence store and session set built from a different run. Before
  // the fix the publishability checks looked at the authority that was supplied
  // and never at where the evidence came from.
  const foreignChecklist = readJson(join(V2, 'checklist.json'));
  const foreignAuthority = loadEvidenceAuthority({ runDir: V2, checklist: foreignChecklist, keyRegistryPath: REGISTRY });
  const foreignStore = new EvidenceStore(V2, { authority: foreignAuthority });
  const foreignSessions = await loadSessions(foreignStore);
  assert.equal(foreignAuthority.verified, true, 'the foreign run really is signed and verified');

  const out = await judgeRunWithInjectedEvidence({
    runDir: T1,
    checklist: t1Checklist(),
    authority: t1Authority(),          // run A's authority ...
    store: foreignStore,               // ... over run B's evidence
    sessions: foreignSessions,
  });
  assert.equal(out.evidenceBinding.bound, false);
  assert.equal(out.judgement.publishable, false, 'a cross-run derivation must never be publishable');
  assert.ok(out.judgement.unbindableFields.some((f) => f.startsWith('evidence(not identity-bound')),
    `unbindableFields must name the reason, got ${JSON.stringify(out.judgement.unbindableFields)}`);
  assert.equal(out.certification.facets.evidenceValid, false);
  assert.ok(out.certification.blockers.some((b) => b.code === REASON.EVIDENCE_STORE_NOT_IDENTITY_BOUND));

  // And the signer refuses it outright, so no attestation can rescue it.
  const signed = attestJudgementRecord(out.judgement, {
    privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(signed.ok, false);
  assert.equal(signed.code, 'NOT_BINDABLE');
});

test('D2: the binding is IDENTITY, not equality — a look-alike store does not satisfy it', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  // Same run, same authority object, same class — but built outside the engine.
  const store = new EvidenceStore(V2, { authority });
  const out = await judgeRunWithInjectedEvidence({
    runDir: V2, checklist, authority, store, sessions: await loadSessions(store),
  });
  assert.equal(out.evidenceBinding.storeInternal, false);
  assert.equal(out.judgement.publishable, false);

  // The production path over the same run does satisfy it, so the check is not
  // simply refusing everything.
  const clean = await judge(V2);
  assert.equal(clean.evidenceBinding.bound, true);
  assert.equal(clean.judgement.publishable, true);

  // And the injection entry point cannot publish even when it is handed nothing
  // to inject: injection and publication are mutually exclusive by construction,
  // not by which arguments were supplied.
  const empty = await judgeRunWithInjectedEvidence({ runDir: V2, checklist, authority });
  assert.equal(empty.evidenceBinding.bound, false);
  assert.equal(empty.judgement.publishable, false);
});

test('D2: evidenceIdentityBinding is recomputed from object identity', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  const ctx = await buildContext(V2, checklist, { authority });
  assert.equal(evidenceIdentityBinding(ctx, authority).bound, true);
  // A DIFFERENT authority object over the same run does not bind the store.
  const twin = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  assert.notEqual(twin, authority);
  assert.equal(evidenceIdentityBinding(ctx, twin).bound, false);
});

// ===========================================================================
// D3 — the compiler consumes only signed fields
// ===========================================================================

test('D3: flipping the unsigned category no longer decides whether a rule is judged', async () => {
  const s = scratchCopy(T1);
  try {
    const checklist = readJson(join(s.run, 'checklist.json'));
    const victim = checklist.obligations.find((o) => o.id === SHAPE.routeDefectObligation);
    assert.equal(victim.category, 'branch-outcome');
    // The ONLY edit. The statement and the doc_quote — the two fields authority
    // .mjs binds — are untouched, so the signature stays valid and the authority
    // stays verified. Before the fix this silenced the obligation completely.
    victim.category = 'other';
    writeFileSync(join(s.run, 'checklist.json'), `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');

    const authority = loadEvidenceAuthority({ runDir: s.run, checklist, keyRegistryPath: REGISTRY });
    assert.equal(authority.verified, true, 'the tamper leaves every existing integrity check green — that is the point');

    const out = await judgeRun({ runDir: s.run, checklist, authority });
    const r = byId(out).get(SHAPE.routeDefectObligation);
    assert.equal(r.compiledFieldsSource, 'signed-contract-revision');
    assert.equal(r.compiledFieldsBound, true);
    assert.ok(r.expectation, 'the routing rule must still compile: the unsigned field is no longer consulted');
    assert.equal(r.expectation.kind, 'route');
    // and it still reports the seeded defect it always reported
    assert.equal(r.verdict, VERDICT.FAIL);
    assert.equal(r.reason, REASON[SHAPE.routeDefectReason]);
  } finally { s.cleanup(); }
});

test('D3: the projection carries ONLY the fields a rule may read', async () => {
  const checklist = t1Checklist();
  const bound = bindObligations(checklist, t1Authority());
  assert.equal(bound.signedSource, true);
  assert.equal(bound.allBound, true);
  const p = bound.byId.get(SHAPE.routeDefectObligation);
  assert.deepEqual(assertProjectionShape(p), [], 'the projection leaked a field no rule is allowed to read');
  for (const f of COMPILED_FROM) assert.ok(f in p, `${f} must be on the projection`);
  // The unsigned fields of the checklist are simply not reachable.
  assert.equal(p.stimulus, undefined);
  assert.equal(p.expected_observable, undefined);
  assert.equal(p.confidence, undefined);
  // and `category` is the SIGNED typed facet
  const item = t1Authority().contractItems.get(SHAPE.routeDefectObligation);
  assert.equal(p.category, item.type);
});

test('D3: without a verified authority nothing claims to be bound', async () => {
  const checklist = t1Checklist();
  const di = buildDocumentIndex(checklist, null);
  assert.equal(di.fieldsBound, false);
  assert.equal(di.bound.signedSource, false);
  for (const p of di.bound.list) assert.equal(p.boundBy, 'local-checklist(unsigned)');
});

// ===========================================================================
// D5 — the ambiguity set is signed, and an unsigned locus may only ADD
// ===========================================================================

test('D5: ambiguitiesSigned is a checked fact and gates publication', async () => {
  // A harness run carries extraction ambiguities and no signed tokens.
  const declared = t1Checklist().ambiguities.length;
  assert.ok(declared > 0, 'the run must actually declare ambiguities, or this check is vacuous');
  const out = await t1Judge();
  assert.equal(out.authority.ambiguitiesSigned, false);
  assert.equal(out.authority.ambiguityBinding.localAmbiguities, declared);
  assert.equal(out.authority.ambiguityBinding.signedTokens, 0);
  assert.ok(out.judgement.unbindableFields.includes('ambiguitySet(not covered by the signature)'));
  assert.equal(out.judgement.publishable, false);

  // The fixture run signs its ambiguity set, so the same gate lets it through —
  // the check discriminates rather than refusing everything.
  const good = await judge(V2);
  assert.equal(good.authority.ambiguitiesSigned, true);
  assert.equal(good.judgement.publishable, true);
});

test('D5: an ambiguity edited after signing is no longer signed', async () => {
  const s = scratchCopy(V2);
  try {
    const checklist = readJson(join(s.run, 'checklist.json'));
    resign(s.run); // sign the pristine set first
    // Now change a READING. The obligations are untouched, so the contract
    // binding stays clean; only the ambiguity digest moves.
    checklist.ambiguities[0].reading_b = `${checklist.ambiguities[0].reading_b} (silently reinterpreted)`;
    writeFileSync(join(s.run, 'checklist.json'), `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');
    const authority = loadEvidenceAuthority({ runDir: s.run, checklist, keyRegistryPath: REGISTRY });
    assert.equal(authority.checklistBound, true, 'the obligations still reproduce the signed contract');
    assert.equal(authority.ambiguitiesSigned, false, 'but the ambiguity set no longer does');
    const out = await judgeRun({ runDir: s.run, checklist, authority });
    assert.equal(out.judgement.publishable, false);
    assert.equal(out.certification.facets.contractReviewed, false);
  } finally { s.cleanup(); }
});

test('D5/N4: a declared locus can only add fields, never narrow them — signed or not', async () => {
  const amb = {
    id: 'AMB-X',
    reading_a: 'Q3 must be shown to every respondent.',
    reading_b: 'Q4 may be omitted for some respondents.',
    // the dangerous input: an EMPTY typed locus
    locus: { fields: [], screens: [], codes: [] },
  };
  for (const signed of [false, true]) {
    const locus = ambiguityLocus(amb, { signed });
    assert.notEqual(locus.state, 'wording-only',
      `an empty ${signed ? 'SIGNED' : 'unsigned'} locus must not be able to declare an ambiguity irrelevant`);
    // N4: an empty field set is the ABSENCE of a claim, so it fails closed —
    // maximally relevant — rather than releasing what the ambiguity withholds.
    assert.equal(locus.state, 'unresolved');
    assert.equal(locusTouchesExpectation(locus, { kind: 'option-present', screen: 'Q1' }).relevant, true);
  }

  // A NON-empty declaration is unioned with the derived locus, so it may widen
  // and can never remove a field the readings really do disagree about.
  const narrowing = {
    ...amb,
    locus: { fields: ['copy'], screens: [], codes: [] },
  };
  const derived = ambiguityLocus({ id: amb.id, reading_a: amb.reading_a, reading_b: amb.reading_b }, { signed: false });
  const unioned = ambiguityLocus(narrowing, { signed: true });
  assert.equal(unioned.state, 'typed');
  assert.ok(unioned.fields.includes('copy'), 'the declaration is honoured — it may ADD');
  for (const f of derived.fields) {
    assert.ok(unioned.fields.includes(f), `a signed locus may not drop the derived field ${f}`);
  }
  // Signing still buys the certification credit (`contractReviewed` refuses a
  // decline taken on a token-derived locus), it just cannot buy narrowing.
  assert.equal(unioned.evidence, 'signed-typed');
  assert.equal(ambiguityLocus(narrowing, { signed: false }).evidence, 'heuristic-derived');
});

test('D5: the consumed-field table covers route sequence/order and conditional polarity', async () => {
  for (const f of ['sequence', 'order', 'ordering', 'polarity']) {
    assert.ok(CONSUMED_FIELDS.route.includes(f), `route consumes ${f} (checkSequence / mustNotShow) and must declare it`);
  }
  for (const f of ['polarity', 'quantifier']) {
    assert.ok(CONSUMED_FIELDS['screen-conditional-presence'].includes(f),
      `"displayed ONLY to X" is a ${f} claim and must declare it`);
  }
});

// ===========================================================================
// D6 — answer-domain closure is proved, not counted
// ===========================================================================

test('D6: "at least two codes" no longer seals an answer domain', async () => {
  const di = buildDocumentIndex(t1Checklist(), t1Authority());
  const sealed = di.answerDomains.get(SHAPE.sealedDomain.question);
  const open = di.answerDomains.get(SHAPE.unsealedDomain.question);
  // The document names a last option for this question, so the list is closed.
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.closure.rule, SHAPE.sealedDomain.rule);
  // ...and for this one it enumerates several codes — the old rule sealed it on
  // `>= 2` alone — and never says the list ends there.
  assert.ok(open.codes.length >= 2, 'the old heuristic would have sealed this');
  assert.equal(open.sealed, false);
  assert.equal(open.closure.rule, 'none');
  assert.match(open.closure.why, /a count is not a census/);
});

test('D6: a contradictory closure statement closes nothing', async () => {
  const checklist = readJson(join(MINI, 'checklist.json'));
  const di = buildDocumentIndex(checklist, loadEvidenceAuthority({ runDir: MINI, checklist, keyRegistryPath: REGISTRY }));
  const q1 = di.answerDomains.get('Q1');
  // The mini-run document enumerates codes 1..3 and separately pins code 2 as
  // the last option. Two different codes cannot both end the list.
  assert.equal(q1.sealed, false);
  assert.match(q1.closure.why, /last option|a count is not a census/);
});

test('D6: an unsealed domain FAILS CLOSED into inconclusive, never into a pass', async () => {
  const r = byId(await judge(V2)).get('V2-ROUTE-UNSEALED');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.ANSWER_DOMAIN_UNSEALED);
  // and the run may not call its testing complete on that basis
  const out = await judge(V2);
  assert.equal(out.certification.facets.testComplete, false);
  assert.ok(out.certification.blockers.some((b) => b.code === REASON.ANSWER_DOMAIN_UNSEALED));
});

// ===========================================================================
// D7 — certification is reachable, and the three trust facts stay three
// ===========================================================================

test('D7: contractReviewed is REACHABLE — it was false by construction', async () => {
  const out = await judge(V2);
  assert.equal(out.certification.facets.contractReviewed, true,
    'with a sealed revision, a bound checklist, bound compiler fields and a signed ambiguity set, this facet must be able to be true');
  assert.equal(out.certification.contractTrust.sealed, true);
  assert.equal(out.certification.contractTrust.certified, true);
});

test('D7: sealed, humanReviewed and certified stay THREE separate facts', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });
  assert.equal(authority.contractSealed, true);
  // A sealed-but-explicitly-unreviewed revision may bind identity and must
  // still not confer review or certification.
  const unreviewed = { ...authority, contractHumanReviewed: false };
  const out = await judgeRun({ runDir: V2, checklist, authority: unreviewed });
  assert.equal(out.certification.contractTrust.sealed, true, 'sealing is unaffected');
  assert.equal(out.certification.contractTrust.humanReviewed, false);
  assert.equal(out.certification.facets.contractReviewed, false, 'review is not implied by sealing');
  assert.ok(out.certification.blockers.some((b) => b.code === 'CONTRACT_REVISION_UNREVIEWED'));

  // The shared module's own review vocabulary is honoured without the caller
  // having to spell it out: `sealed-unreviewed` is what every real v2 run emits,
  // and it must never certify.
  const v2State = await judgeRun({
    runDir: V2, checklist, authority: { ...authority, contractReviewState: 'sealed-unreviewed' },
  });
  assert.equal(v2State.certification.contractTrust.sealed, true);
  assert.equal(v2State.certification.contractTrust.humanReviewed, false);
  assert.equal(v2State.certification.facets.contractReviewed, false);
});

test('D7: incomplete route coverage can never certify', async () => {
  const out = await t1Judge();
  const domainRows = out.results.filter((r) => r.reason === REASON.DOMAIN_CASE_UNEXERCISED || r.reason === REASON.ANSWER_DOMAIN_UNSEALED);
  assert.ok(domainRows.length > 0, 'the frozen run really does contain rows decided on an incomplete domain');
  assert.equal(out.certification.facets.testComplete, false);
  for (const r of domainRows) {
    assert.ok(out.certification.blockers.some((b) => b.facet === CERT_FACET.TEST_COMPLETE && b.obligationId === r.obligationId),
      `${r.obligationId}: an incomplete answer domain must reach the testComplete blockers`);
  }
});

test('D7: an inconclusive row is an open question, not a reviewed result', async () => {
  const out = await t1Judge();
  assert.ok(out.counts.byVerdict.inconclusive > 0);
  assert.equal(out.certification.facets.resultsReviewed, false);
  const someInconclusive = out.results.find((r) => r.verdict === VERDICT.INCONCLUSIVE);
  assert.ok(out.certification.blockers.some((b) => b.facet === CERT_FACET.RESULTS_REVIEWED && b.obligationId === someInconclusive.obligationId));
});

/**
 * `certify` is a pure function of ALREADY-DERIVED rows, so the two conjunctions
 * below are isolated exactly: one row differs and nothing else does. Asserting
 * them on a whole run does not isolate anything — the real run is blocked on
 * several grounds at once, so removing one conjunct changes no observable.
 */
function certBase(results) {
  return {
    results,
    authority: {
      verified: true, checklistBound: true, contractBound: true, contractSealed: true,
      contractReviewState: 'sealed', findings: [],
    },
    routeTable: { integrity: [] },
    ambIndex: { integrity: [], heuristicDeclines: 0 },
    store: { integrity: [], authoritative: true },
    sessions: [],
    evidenceBinding: { bound: true, problems: [] },
    ambiguityBinding: { signed: true },
    contractBinding: { allBound: true },
    documentModel: { available: true },
  };
}
const certRow = (over) => ({
  obligationId: 'X', expectation: { kind: 'option-present' }, verdict: VERDICT.PASS,
  coverage: COVERAGE.EXERCISED, reason: REASON.POSITIVE_WITNESS, tripwires: [],
  compiledFieldsBound: true, withheld: null, predicateOutcome: OUTCOME.SATISFIED, ...over,
});

test('D7: resultsReviewed is FALSE for an inconclusive row and TRUE without one', async () => {
  const clean = certify(certBase([certRow({ obligationId: 'A' })]));
  assert.equal(clean.facets.resultsReviewed, true, 'the baseline must be reviewable, or the next assertion proves nothing');
  const open = certify(certBase([
    certRow({ obligationId: 'A' }),
    certRow({ obligationId: 'B', verdict: VERDICT.INCONCLUSIVE, reason: REASON.AMBIGUITY_PRECEDENCE, predicateOutcome: OUTCOME.INSUFFICIENT }),
  ]));
  assert.equal(open.facets.resultsReviewed, false, 'one unresolved row means the results were not reviewed');
  assert.ok(open.blockers.some((b) => b.facet === CERT_FACET.RESULTS_REVIEWED && b.obligationId === 'B'));
});

test('D7: testComplete is FALSE for an exercised-but-domain-incomplete row', async () => {
  const clean = certify(certBase([certRow({ obligationId: 'A' })]));
  assert.equal(clean.facets.testComplete, true, 'the baseline must be complete, or the next assertion proves nothing');
  // EXERCISED — the old conjunction only looked at coverage, so this row was
  // invisible to `testComplete` and a run decided on a subset of a question's
  // answers certified as fully tested.
  const partial = certify(certBase([
    certRow({ obligationId: 'A' }),
    certRow({ obligationId: 'B', verdict: VERDICT.INCONCLUSIVE, reason: REASON.DOMAIN_CASE_UNEXERCISED, predicateOutcome: OUTCOME.INSUFFICIENT }),
  ]));
  assert.equal(partial.facets.testComplete, false, 'incomplete route coverage must never certify');
  assert.ok(partial.blockers.some((b) => b.facet === CERT_FACET.TEST_COMPLETE && b.obligationId === 'B'));

  const unsealed = certify(certBase([
    certRow({ obligationId: 'A' }),
    certRow({ obligationId: 'B', verdict: VERDICT.INCONCLUSIVE, reason: REASON.ANSWER_DOMAIN_UNSEALED, predicateOutcome: OUTCOME.INSUFFICIENT }),
  ]));
  assert.equal(unsealed.facets.testComplete, false, 'an unsealed answer domain is incomplete coverage too');

  const noEligibility = certify(certBase([
    certRow({ obligationId: 'A' }),
    certRow({ obligationId: 'B', verdict: VERDICT.INCONCLUSIVE, reason: REASON.ELIGIBILITY_NOT_DOCUMENT_DERIVED, predicateOutcome: OUTCOME.INSUFFICIENT }),
  ]));
  assert.equal(noEligibility.facets.testComplete, false, 'a screen whose eligible population is unknown is untested, not tested');
});

// ===========================================================================
// D8 — the four predicates no longer attest their own universes
// ===========================================================================

/**
 * The real violation cases, on the real signed run.
 *
 * The COORDINATES come from the run's own `substrate-shape.json`, not from
 * literals here: written out, "the routing rule for question X code Y goes to Z
 * instead of the documented W" is the blind corpus's planted defect restated in
 * a public file. The EXPECTATIONS are still hand-built (that is the point — they
 * have to reach the violation branch); every artifact underneath them is not.
 */
const D8_CASES = [
  ['route@1', {
    kind: 'route',
    question: SHAPE.divergingRoute.question,
    destination: SHAPE.divergingRoute.destination,
    sequence: null,
    mustNotShow: SHAPE.divergingRoute.mustNotShow,
    trigger: { mode: 'include', codes: SHAPE.divergingRoute.codes, labels: [], identity: 'code' },
    answerDomain: { sealed: false, codes: [] },
  }, 'scoped-route-edges'],
  ['screen-conditional-presence@1', {
    kind: 'screen-conditional-presence',
    screen: SHAPE.conditionalScreen.screen,
    condition: { question: SHAPE.conditionalScreen.question, codes: SHAPE.conditionalScreen.codes, labels: [], identity: 'code' },
    answerDomain: { sealed: false, codes: [] },
  }, 'scoped-occurrence-set'],
  ['screen-universal@1', { kind: 'screen-universal', screen: SHAPE.notUniversalScreen }, 'scoped-eligible-sessions'],
  ['control-on-every-screen@1', { kind: 'control-on-every-screen', control: 'back' }, 'scoped-capture-set'],
];

test('D8: every completeness-claiming predicate is INSIDE the gate', async () => {
  // Named explicitly, because the structural test below iterates SCOPE_REQUIRED
  // and therefore goes quiet if an id is simply removed from it. Each of these
  // publishes a population-scoped count ("N of M", "eligibleSessions", "route
  // rows considered"), which is self-certifying unless the population is
  // independently rebuilt.
  for (const id of [
    'route@1', 'screen-conditional-presence@1', 'screen-universal@1',
    'control-on-every-screen@1', 'first-screen@1',
  ]) {
    assert.ok(SCOPE_REQUIRED.has(id), `${id} reports a population-scoped count and must stay inside the completeness gate`);
  }
});

test('D8: each of the four declares a filter the scope authority rebuilds', async () => {
  const checklist = t1Checklist();
  const ctx = await buildContext(T1, checklist, { authority: t1Authority() });
  let total = 0;
  for (const [id, exp, claimKind] of D8_CASES) {
    assert.ok(SCOPE_REQUIRED.has(id), `${id} must be inside the completeness gate`);
    const res = runPredicate(exp, ctx);
    assert.equal(res.outcome, OUTCOME.VIOLATED, `${id}: the real run must reach this violation`);
    assert.equal(res.scope.claimKind, claimKind);
    assert.ok(res.scope.memberCount >= 1, `${id}: an empty population would make this check vacuous`);
    assert.match(res.scope.membersDigest, /^sha256:[0-9a-f]{64}$/);
    const att = await ctx.scopeAttestor.attest(res.scope);
    assert.equal(att.ok, true, `${id}: the authority must rebuild the same population: ${JSON.stringify(att.detail)}`);
    // The rebuild is INDEPENDENT: it counted the population itself and got the
    // same number, rather than echoing the declaration back.
    assert.equal(att.independentlyCounted, res.scope.memberCount, `${id}: the authority must count the population itself`);
    total += res.scope.memberCount;
  }
  assert.ok(total > 100, `the four populations together must be substantial, not four singletons (got ${total})`);
});

test('D8: a population the predicate under-reports is refused', async () => {
  const checklist = t1Checklist();
  const ctx = await buildContext(T1, checklist, { authority: t1Authority() });
  for (const [id, exp] of D8_CASES) {
    const res = runPredicate(exp, ctx);
    // Drop one member and re-declare — the shape a predicate that scanned less
    // than it claims produces.
    const shrunk = { ...res.scope, memberCount: res.scope.memberCount - 1 };
    const att = await ctx.scopeAttestor.attest(shrunk);
    assert.equal(att.ok, false, `${id}: an under-counted population must not attest`);
    assert.equal(att.reason, REASON.SCOPE_DIGEST_MISMATCH);
    // and an inflated digest is refused as well
    const faked = { ...res.scope, membersDigest: `sha256:${'0'.repeat(64)}` };
    assert.equal((await ctx.scopeAttestor.attest(faked)).reason, REASON.SCOPE_DIGEST_MISMATCH, `${id}: a fabricated digest must not attest`);
  }
});

test('D8: an unattestable population demotes the verdict rather than publishing it', async () => {
  // Drive route@1 through the ENGINE with a scope whose population does not
  // exist, and confirm the whole row is demoted.
  const bad = await withPredicate('route', () => ({
    outcome: OUTCOME.VIOLATED, reason: REASON.ROUTE_DESTINATION_MISMATCH,
    witnesses: [],
    counterWitnesses: [{
      artifact: 'V2-CLEAN-B.json', proofKind: PROOF_KIND.ROUTE_EDGE,
      proof: { kind: PROOF_KIND.ROUTE_EDGE, claim: { fromSeq: 1, toSeq: 2, fromScreen: 'Q1', toScreen: 'Q3', answerLabels: ['Beta option'], answerCodes: ['2'], source: 'forward-answer' } },
    }],
    scope: { claimKind: 'scoped-route-edges', filter: { question: 'Q1', identity: 'code', mode: 'include', codes: ['2'], labels: [] }, memberCount: 99, membersDigest: `sha256:${'0'.repeat(64)}` },
  }), async () => byId(await judge(V2)).get('V2-ROUTE-DOCCODE'));
  assert.equal(bad.predicateOutcome, OUTCOME.VIOLATED);
  assert.notEqual(bad.verdict, VERDICT.FAIL);
  assert.ok(bad.tripwires.some((t) => t.code === REASON.SCOPE_DIGEST_MISMATCH));
});

// ===========================================================================
// D9 — eligibility comes from the document, not from the survey under test
// ===========================================================================

test('D9: the eligible set does not move when the survey mis-reports its progress', async () => {
  const checklist = t1Checklist();
  const ctx = await buildContext(T1, checklist, { authority: t1Authority() });
  const before = runPredicate({ kind: 'screen-universal', screen: SHAPE.universalScreen }, ctx);
  assert.equal(before.outcome, OUTCOME.SATISFIED);

  // The implementation's own ordering signal, corrupted. Under the old rule this
  // decided who was eligible, so garbage here changed the verdict.
  const original = ctx.routeTable.screenRank;
  ctx.routeTable.screenRank = Object.fromEntries(Object.keys(original).map((k) => [k, 999]));
  try {
    const after = runPredicate({ kind: 'screen-universal', screen: SHAPE.universalScreen }, ctx);
    assert.equal(after.outcome, before.outcome, 'the verdict moved with the progress control');
    assert.equal(after.scope.eligibleSessions, before.scope.eligibleSessions);
    assert.equal(after.scope.membersDigest, before.scope.membersDigest);
    assert.equal(after.scope.orderingSource, 'signed ContractRevision items (type=terminal + first-mention order)');
    assert.ok(!/progress/i.test(after.scope.orderingSource), 'the progress control may not be named as the ordering source');
  } finally { ctx.routeTable.screenRank = original; }
});

test('D9: without a document-derived terminal set the predicate fails CLOSED', async () => {
  const checklist = t1Checklist();
  const ctx = await buildContext(T1, checklist, { authority: t1Authority() });
  assert.equal(ctx.documentModel.available, true);
  assert.deepEqual(ctx.documentModel.completionScreens, ['CLOSING']);
  // Remove the document model and the predicate must refuse, not fall back to
  // the implementation's numbers.
  const blind = { ...ctx, documentModel: { available: false, why: 'test: no signed terminal set' } };
  const res = runPredicate({ kind: 'screen-universal', screen: SHAPE.universalScreen }, blind);
  assert.equal(res.outcome, OUTCOME.INSUFFICIENT);
  assert.equal(res.reason, REASON.ELIGIBILITY_NOT_DOCUMENT_DERIVED);
});

test('D9: an unsigned run has no document model at all', async () => {
  const di = buildDocumentIndex(t1Checklist(), null);
  const dm = buildDocumentModel(di);
  assert.equal(dm.available, false);
  assert.deepEqual(dm.completionScreens, []);
});

// ===========================================================================
// D10 — evidence that RESOLVES is not evidence that the thing OCCURRED
// ===========================================================================

test('D10: a text witness proves the OCCURRENCE, not that a locator resolves', async () => {
  const store = new EvidenceStore(T1, { authority: t1Authority() });
  const artifact = store.listArtifacts().find((n) => /^EXP-/.test(n));
  const data = (await store.read(artifact)).data;
  const cap = data.evidence.find((e) => (e.visible_text || '').trim().length > 20);
  assert.ok(cap, 'the frozen run must have a capture with rendered copy');
  const present = String(cap.visible_text).trim().split(/\s+/).slice(0, 3).join(' ');

  // The OLD witness shape: a locator with no value. It still verifies, which is
  // exactly why it proved nothing.
  const locatorOnly = await store.attest({
    artifact, locator: `evidence[${data.evidence.indexOf(cap)}].visible_text`,
  });
  assert.equal(locatorOnly.ok, true, 'the old shape passes — that is the defect, restated');

  // The new projection: the same capture, a string that IS there.
  const real = await store.attest({
    artifact, proofKind: PROOF_KIND.TEXT_OCCURRENCE,
    proof: { kind: PROOF_KIND.TEXT_OCCURRENCE, claim: { seq: cap.seq, screen: cap.screen_id, needle: present, needleMulti: null } },
  });
  assert.equal(real.ok, true, `the projection must confirm text that is really there: ${JSON.stringify(real)}`);

  // ... and a string that is NOT there is refused, on the same capture.
  const fake = await store.attest({
    artifact, proofKind: PROOF_KIND.TEXT_OCCURRENCE,
    proof: { kind: PROOF_KIND.TEXT_OCCURRENCE, claim: { seq: cap.seq, screen: cap.screen_id, needle: 'Zzyzx Beverages Holdings Inc', needleMulti: null } },
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.reason, REASON.OCCURRENCE_NOT_PROVEN);
});

test('D10: a forbidden-text violation must carry the occurrence projection', async () => {
  const checklist = t1Checklist();
  const ctx = await buildContext(T1, checklist, { authority: t1Authority() });
  const store = ctx.store;
  const artifact = store.listArtifacts().find((n) => /^EXP-/.test(n));
  const data = (await store.read(artifact)).data;
  const cap = data.evidence.find((e) => (e.visible_text || '').trim().length > 20);
  const needle = String(cap.visible_text).trim().split(/\s+/).slice(0, 3).join(' ');
  const res = runPredicate({ kind: 'text-forbidden', text: needle }, ctx);
  assert.equal(res.outcome, OUTCOME.VIOLATED, 'copy that is really on screen must violate a never-display rule');
  for (const w of res.counterWitnesses) {
    assert.equal(w.proofKind, PROOF_KIND.TEXT_OCCURRENCE, 'a presence finding must prove presence');
    assert.equal((await store.attest(w)).ok, true);
  }
});

test('D10: screenControlsOnly cites the whole control census, not the option list', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const ctx = await buildContext(V2, checklist, { authority: loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY }) });
  // Find a screen whose only extra control is a TEXT INPUT — the case where the
  // old witness cited an EMPTY option_inventory and re-verified perfectly.
  const target = ctx.census.screens.find((s) => allCapturesOf(ctx, s).some((c) => c.inventory.length === 0 && (c.textInputs || []).length > 0));
  assert.ok(target, 'the fixture run must contain a text-input-only screen');
  const res = runPredicate({ kind: 'screen-controls-only', screen: target, button: 'Continue' }, ctx);
  assert.equal(res.outcome, OUTCOME.VIOLATED);
  const census = res.counterWitnesses.find((w) => w.proofKind === PROOF_KIND.CONTROL_CENSUS);
  assert.ok(census, `the extra control is a text input, so an option-list witness proves nothing: ${JSON.stringify(res.counterWitnesses.map((w) => w.proofKind))}`);
  assert.ok(census.proof.claim.counts.textInputs > 0);
  assert.equal((await ctx.store.attest(census)).ok, true);

  // The engine refuses the old shape outright.
  const cap = allCapturesOf(ctx, target).find((c) => c.inventory.length === 0 && (c.textInputs || []).length > 0);
  const oldShape = await withPredicate('screen-controls-only', () => ({
    outcome: OUTCOME.VIOLATED, reason: REASON.CONTROL_PRESENT_WHERE_FORBIDDEN, witnesses: [],
    counterWitnesses: [{ artifact: cap.artifact, sha256: cap.sha256, locator: `${cap.locatorBase}.option_inventory`, equals: [], derive: 'labels', proofKind: PROOF_KIND.INVENTORY_DIGEST }],
    scope: res.scope,
  }), async () => byId(await judge(V2)).get('V2-WELCOME-CONTROLS'));
  if (oldShape) {
    assert.notEqual(oldShape.verdict, VERDICT.FAIL);
    assert.ok(oldShape.tripwires.some((t) => t.code === REASON.PROOF_PROJECTION_MISSING));
  }
});

// ###########################################################################
// ROUND 4 — the two bypasses the round-3 verifier reproduced.
//
// N2 (HIGH)   judgeRun never checked that its runDir was the directory its
//             authority describes, so run A's verified authority over run B's
//             directory minted a SIGNED, publishable, run-A-bound record with
//             two of A's four genuine fails silently downgraded to inconclusive.
// N4 (MEDIUM) a SIGNED ambiguity locus replaced the derived one instead of
//             widening it, so the producer being graded could re-sign
//             `locus:{fields:[]}` and release every withheld verdict.
// ###########################################################################

test('N2: a verified authority may not be pointed at a different run directory', async () => {
  const a = scratchCopy(V2);
  const b = scratchCopy(V2);
  try {
    const checklist = readJson(join(a.run, 'checklist.json'));
    const authorityA = loadEvidenceAuthority({ runDir: a.run, checklist, keyRegistryPath: REGISTRY });
    assert.equal(authorityA.verified, true, 'run A really is signed and verified — that is what made the attack work');

    // THE ATTACK. Run B is run A with one fabricated field appended to an
    // artifact. B's altered bytes fail A's signed hash, so they were simply not
    // read: the record signed, bound to A, reported `evidenceIdentityBound:true`
    // and `unbindableFields: []`, and the obligations that rested on that
    // artifact quietly stopped failing.
    const victim = join(b.run, 'artifacts', 'V2-CLEAN-B.json');
    const doc = readJson(victim);
    doc.__fabricated_by_the_attacker = true;
    writeFileSync(victim, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const signer = { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' };
    await assert.rejects(async () => await judgeRun({ runDir: b.run, checklist, authority: authorityA, signer }),
      (e) => e instanceof EvidenceIntegrityError
        && e.code === 'EVIDENCE_SOURCE_NOT_BOUND_TO_AUTHORITY'
        && /does not describe/.test(e.message),
      'judging directory B under an authority verified over directory A must be a hard refusal, not a signed record',
    );

    // The refusal is about the SOURCE, not about the tamper: an untouched,
    // byte-identical copy of the same run at a different path is refused too.
    // Otherwise the check would only be a second hash comparison.
    const pristine = scratchCopy(V2);
    try {
      await assert.rejects(async () => await judgeRun({ runDir: pristine.run, checklist, authority: authorityA }),
        (e) => e.code === 'EVIDENCE_SOURCE_NOT_BOUND_TO_AUTHORITY',
      );
      // ... and the store refuses the same pairing structurally, one level down,
      // so no other call path can assemble it either.
      await assert.rejects(async () => await buildContext(pristine.run, checklist, { authority: authorityA }),
        (e) => e.code === 'EVIDENCE_SOURCE_NOT_BOUND_TO_AUTHORITY',
      );
    } finally { pristine.cleanup(); }

    // CONTROL: the same authority over its OWN directory still mints a
    // publishable, signed record. The check discriminates rather than refusing.
    const ok = await judgeRun({ runDir: a.run, checklist, authority: authorityA, signer });
    assert.equal(ok.judgement.publishable, true);
    assert.equal(ok.judgementAttestation.ok, true);
    assert.equal(ok.source.evidenceSourceBound, true);
    assert.equal(ok.source.evidenceSource, ok.source.authorityEvidenceSource);
    assert.equal(ok.evidenceBinding.sourceMatches, true);
  } finally { a.cleanup(); b.cleanup(); }
});

test('N2: an artifact that fails its hash check RAISES — it is never quietly skipped', async () => {
  // The half of N2 that converted real failures into inconclusives, isolated
  // from the runDir binding: same directory, same authority, and the artifact
  // changes AFTER the authority verified it. The store used to return
  // `{ok:false, reason:ARTIFACT_HASH_MISMATCH}`, `loadSessions` quarantined the
  // session and moved on, and the run reported a smaller evidence set as though
  // it were the whole one.
  const s = scratchCopy(T1);
  try {
    const checklist = readJson(join(s.run, 'checklist.json'));
    const authority = loadEvidenceAuthority({ runDir: s.run, checklist, keyRegistryPath: REGISTRY });
    assert.equal(authority.verified, true, 'the authority verified the directory it is about to read');

    const victim = join(s.run, 'artifacts', SHAPE.sampleArtifact);
    const doc = readJson(victim);
    doc.__fabricated_field = 'appended after the authority was verified';
    writeFileSync(victim, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    await assert.rejects(async () => await judgeRun({ runDir: s.run, checklist, authority }),
      (e) => e instanceof EvidenceIntegrityError
        && e.code === REASON.ARTIFACT_HASH_MISMATCH
        && e.artifact === SHAPE.sampleArtifact,
      'an artifact whose bytes disagree with the signed catalogue must abort the run, not shrink the evidence set',
    );
  } finally { s.cleanup(); }
});

test('N2/D2: judgeRun accepts exactly five parameters and refuses every other one', async () => {
  const checklist = readJson(join(V2, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir: V2, checklist, keyRegistryPath: REGISTRY });

  // The three named refusals (D2/D4) still hold ...
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, policy: {} }), /locked gate/);
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, store: new EvidenceStore(V2, { authority }) }), /does not accept `store` or `sessions`/);
  await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, sessions: [] }), /does not accept `store` or `sessions`/);

  // ... and so does everything the enumeration did not think of. A guard that
  // lists the known-bad names admits the next parameter by default; this one
  // admits nothing it does not name.
  for (const surface of ['ambIndex', 'certification', 'documentModel', 'evidenceBinding', 'scopeAttestor', 'compiled', 'results']) {
    await assert.rejects(async () => await judgeRun({ runDir: V2, checklist, authority, [surface]: {} }),
      new RegExp(`does not accept \\[${surface}\\]`),
      `${surface} must not be an unchecked input to a signed result`,
    );
  }

  // The five it does accept still work together.
  const out = await judgeRun({
    runDir: V2, checklist, authority, priorObservations: null,
    signer: { privateKeyPem: readFileSync(PRIVATE_PEM, 'utf8'), keyId: 'fixture-harness-key-1', signedAt: '2026-08-02T00:00:00.000Z' },
  });
  assert.equal(out.judgement.publishable, true);
});

test('N4: a RE-SIGNED narrowed ambiguity locus cannot release a withheld verdict', async () => {
  const s = scratchCopy(T1);
  try {
    const original = readJson(join(s.run, 'checklist.json'));

    // CONTROL — the real run, re-signed by the fixture producer so its ambiguity
    // set is genuinely covered by the signature. This is the state the attack
    // starts from: verified, signed ambiguities, publishable, N withheld.
    //
    // The two distributions are PINNED (in the run's own substrate-shape.json,
    // so a public test file does not restate a blind run's verdicts) for the
    // reason the original pin existed: a change that moves BOTH paths together —
    // an engine change, a checklist edit, an artifact edit — would otherwise slip
    // past a comparison that only checks the two against each other. Re-deriving
    // them is a deliberate act with a reviewer attached. It is not a tolerance
    // and it must never be widened to make a run pass.
    const PIN = SHAPE.narrowedLocusAttack;
    const control = await resignAndJudge(s.run, original);
    assert.equal(control.authority.ambiguitiesSigned, true);
    assert.equal(control.judgement.publishable, true);
    assert.deepEqual(control.counts.byVerdict, PIN.control);
    assert.equal(control.counts.withheldFails + control.counts.withheldPasses, PIN.withheld);
    assert.ok(PIN.withheld > 0, 'the control must actually withhold something, or the attack has nothing to release');

    // THE ATTACK — every ambiguity re-signed with an EMPTY typed locus. The
    // signature is valid (the digest covers the locus, so this is a genuine
    // re-sign, not the round-3 post-signature edit), and the old signed branch
    // returned it verbatim: 11 withheld verdicts released, pass 89 -> 98,
    // fail 4 -> 6, inconclusive 15 -> 4, and the record still published.
    const attacked = readJson(join(s.run, 'checklist.json'));
    for (const a of attacked.ambiguities) a.locus = { fields: [], screens: [], codes: [] };
    const out = await resignAndJudge(s.run, attacked);

    assert.equal(out.authority.ambiguitiesSigned, true,
      'the attack must be a VALID re-sign — otherwise this tests round 3\'s tamper detection, not N4');

    // Nothing is released. An empty locus is the absence of a claim about what
    // the readings disagree about, so it fails closed: strictly MORE suppression
    // than the honest run, never less.
    assert.ok(out.counts.byVerdict.pass <= control.counts.byVerdict.pass,
      `a narrowed locus may not create passes: ${out.counts.byVerdict.pass} > ${control.counts.byVerdict.pass}`);
    assert.ok(out.counts.byVerdict.fail <= control.counts.byVerdict.fail,
      'a narrowed locus may not create fails either — withholding protects both directions');
    assert.ok(out.counts.withheldFails + out.counts.withheldPasses >= PIN.withheld,
      `withholding must not shrink: ${out.counts.withheldFails + out.counts.withheldPasses} < ${PIN.withheld}`);
    assert.deepEqual(out.counts.byVerdict, PIN.attacked);

    // Every one of them is reported as fail-closed, not silently widened.
    const emptied = out.ambiguityIndex.integrity.filter((i) => i.code === 'AMBIGUITY_LOCUS_UNRESOLVED' && /empty locus/.test(i.detail || ''));
    assert.equal(emptied.length, attacked.ambiguities.length);

    // And the obligations the honest run withheld are still withheld.
    const before = new Map(control.results.map((r) => [r.obligationId, r]));
    for (const r of out.results) {
      const was = before.get(r.obligationId);
      if (was && was.withheld) {
        assert.equal(r.verdict, VERDICT.INCONCLUSIVE, `${r.obligationId} was withheld and must stay withheld`);
        assert.equal(r.reason, REASON.AMBIGUITY_PRECEDENCE);
      }
    }
  } finally { s.cleanup(); }
});

test('N4: a signed locus may still ADD, and still earns its certification credit', async () => {
  // The fix must not simply ignore signed loci: the fixture run declares two
  // signed typed loci, one of which correctly declines an irrelevant ambiguity,
  // and that decline still rests on a SIGNED locus (`contractReviewed` refuses a
  // decline taken on a token-derived one).
  const out = await judge(V2);
  const declined = out.ambiguityIndex.suppressionsDeclinedAsIrrelevant.find(
    (s) => s.obligationId === 'V2-BACKBUTTON' && s.ambiguityId === 'AMB-V2-IRRELEVANT',
  );
  assert.ok(declined, 'the irrelevant ambiguity is still declined');
  assert.equal(declined.evidenceClass, 'signed-typed');
  assert.equal(out.certification.facets.contractReviewed, true);

  // The locus that reached that decision is the UNION, so it is a superset of
  // what the extraction declared — the decline holds a fortiori for the signed
  // set alone, which is why it keeps the signed evidence class.
  const locus = out.ambiguityIndex.loci['AMB-V2-IRRELEVANT'];
  const declaredFields = readJson(join(V2, 'checklist.json')).ambiguities
    .find((a) => a.id === 'AMB-V2-IRRELEVANT').locus.fields;
  for (const f of declaredFields) assert.ok(locus.fields.includes(f));
  assert.ok(locus.fields.length > declaredFields.length, 'the derived locus was unioned in, not discarded');
});

// ===========================================================================
// helpers
// ===========================================================================

/** Write `checklist`, re-sign the run over it, and judge the result. */
// ===========================================================================
// A3b — the session-candidate pre-filter against the WALKER'S REAL LEAF NAMES
// ===========================================================================

test('A3b: the sweep filter excludes step captures named the way the walker actually names them', () => {
  // Measured on the real v100 catalogue: the step marker sits MID-NAME after
  // the pathId slug. An exclusion anchored at the start admitted 2,330 step
  // captures (73.6 MB raw) into the session sweep — each would have been
  // fetched, parsed, and cached. These exact shapes are from that catalogue.
  for (const stepLeaf of [
    'observations/FLOOR-01--fi_7187372b190ccf6f190c/FLOOR-01--fi_7187372b190ccf6f190c-step-000-after-action.json',
    'FLOOR-01--fi_dcba98cae8f76d0e28d1-step-074-blocked.json',
    'FLOOR-01--fi_421a7c07db164accd308-retry-1-step-010-before.json',
    'step-000-slot.json',
    'steps/EXP-001/007.accessibility.json',
    'FLOOR-01--fi_x-step-020-before.png',
  ]) {
    assert.equal(isSessionCandidate(stepLeaf), false, `${stepLeaf} is a step capture, never a session candidate`);
  }
  // And the sessions those steps belong to STAY candidates — including a path
  // family the plan generator has never used and a dotted slug.
  for (const sessionLeaf of [
    'observations/FLOOR-01--fi_dcba98cae8f76d0e28d1/FLOOR-01--fi_dcba98cae8f76d0e28d1-observation.json',
    'FLOOR-01--fi_421a7c07db164accd308-retry-1-observation.json',
    'SCR-2.1--fi_0a1b2c3d4e5f60718293-observation.json',
    'EXP-07.json',
    'SELF-01.json',
  ]) {
    assert.equal(isSessionCandidate(sessionLeaf), true, `${sessionLeaf} must stay in the sweep`);
  }
});

async function resignAndJudge(runDir, checklist) {
  writeFileSync(join(runDir, 'checklist.json'), `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');
  writeSignedRunRecord({ runDir, repoRoot: REPO, runId: SUBSTRATE_RUN_ID, checklist });
  const fresh = readJson(join(runDir, 'checklist.json'));
  const authority = loadEvidenceAuthority({ runDir, checklist: fresh, keyRegistryPath: REGISTRY });
  return await judgeRun({ runDir, checklist: fresh, authority });
}

function allCapturesOf(ctx, screen) {
  const c = ctx.census.byScreen[screen];
  return c ? c.captures : [];
}

/** Swap a predicate for one adversarial run, then always restore it. */
async function withPredicate(kind, impl, fn) {
  const original = PREDICATES[kind];
  PREDICATES[kind] = { id: original.id, run: impl };
  try { return await fn(); } finally { PREDICATES[kind] = original; }
}

/** Re-sign a scratch run after a deliberate edit, so D1 does not mask D7. */
function resign(runDir) {
  writeSignedRunRecord({ runDir, repoRoot: REPO, runId: 'mini-v2', checklist: readJson(join(runDir, 'checklist.json')) });
}

// ===========================================================================
// PUBLICATION BOUNDARY — the skip inventory is itself asserted
//
// `pipeline/runs/t1-easy` is DERIVED from the blind corpus and is held out of
// the public repository until the test runs are complete
// (docs/EVALUATION-BOUNDARY.md). Everything above drives SUBSTRATE_RUN, which
// is that run when it is present and the public `pipeline/runs/synthetic-demo`
// when it is not — so these tests keep running either way.
//
// One test is about t1-easy's CONTENT and has no honest synthetic equivalent.
// It is gated with a STATED REASON rather than a bare presence check, and the
// number of gates is pinned here and checked against this file's own source: a
// test that quietly disappears when a file is missing is the failure class this
// suite exists to delete. This test NEVER skips.
// ===========================================================================

const PRIVATE_GATED = 1;

test('publication boundary: the private-run gate is exactly as declared', async () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const gates = (src.match(/,\s*privateOnly\(/g) || []).length;
  assert.equal(gates, PRIVATE_GATED, `${gates} gated test(s) in this file, ${PRIVATE_GATED} declared`);
  const silent = new RegExp(['skip', ':\s*!existsSync'].join(''));
  assert.ok(!silent.test(src), 'a bare existence check is a SILENT skip: gate with a stated reason instead');
});

announcePrivateRunGate('pipeline/judge/selftest/v2.test.mjs', PRIVATE_GATED);
