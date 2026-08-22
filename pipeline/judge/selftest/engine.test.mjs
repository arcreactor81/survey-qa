/**
 * selftest/engine.test.mjs —  node --test pipeline/judge/selftest/
 *
 * Two layers:
 *   A. one fixture per predicate on a synthetic mini-run;
 *   B. ADVERSARIAL cases aimed squarely at the failure this engine exists to
 *      fix — a verdict that cites an artifact that does not support it. Every
 *      one of these must end in a non-pass, and the engine must say why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeRun, buildContext } from '../lib/engine.mjs';
import { loadEvidenceAuthority } from '../lib/authority.mjs';
import { EvidenceStore, resolvePath, PROJECTIONS, classifyArtifact } from '../lib/evidence-store.mjs';
import { PREDICATES } from '../lib/predicates.mjs';
import { OUTCOME, REASON, VERDICT, COVERAGE, DISPOSITION, EVIDENCE_CLASS } from '../lib/vocab.mjs';
import { norm, normLine } from '../lib/normalize.mjs';
import { compileObligation } from '../lib/compile.mjs';
import { PRIVATE_RUN, privateOnly, announcePrivateRunGate } from '../../runs/run-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MINI = resolve(join(here, 'fixtures', 'mini-run'));
// Section D below is a REGRESSION against the blind-derived run. Those four
// tests are about that run's CONTENT — named obligations, one named route row —
// so there is no honest synthetic stand-in for them: a synthetic survey would
// only prove that the engine judges a different survey. They are gated with a
// stated reason when the run is out of the checkout (docs/EVALUATION-BOUNDARY.md).
// Everything else in this file runs on the synthetic `mini-run` fixture and is
// unaffected.
const REAL = PRIVATE_RUN;
const REGISTRY = resolve(join(here, '..', '..', '..', 'scorer', 'fixtures', 'keys', 'registry.json'));
// The fixtures are signed with the checked-in TEST-ONLY harness key, which is
// refused as a trust anchor unless a caller names it as such (audit finding
// 13). Opting in here is the test suite doing exactly that, once.
process.env.SURVEY_QA_ALLOW_FIXTURE_KEYS = '1';

const miniChecklist = () => JSON.parse(readFileSync(join(MINI, 'checklist.json'), 'utf8'));
const byId = (out) => new Map(out.results.map((r) => [r.obligationId, r]));

/** Every run now goes through the signed evidence authority (D1). */
const authorityFor = (runDir, checklist) => loadEvidenceAuthority({ runDir, checklist, keyRegistryPath: REGISTRY });

async function judgeMini(extra = {}) {
  const checklist = miniChecklist();
  return judgeRun({ runDir: MINI, checklist, authority: authorityFor(MINI, checklist), ...extra });
}
async function judgeReal() {
  const checklist = JSON.parse(readFileSync(join(REAL, 'checklist.json'), 'utf8'));
  return judgeRun({ runDir: REAL, checklist, authority: authorityFor(REAL, checklist) });
}

// ===========================================================================
// A. one fixture per predicate
// ===========================================================================

test('option-present: satisfied only with a complete positive inventory', async () => {
  const r = byId(await judgeMini()).get('SELF-OPT-PASS');
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.COMPLETE_POSITIVE_INVENTORY);
  assert.ok(r.supportingWitnesses.length > 0, 'a pass must ship a positive witness');
  assert.ok(r.evidenceScope.completeRenderedSet.includes('Alpha|1'));
});

test('option-present: an absence claim enumerates everything that WAS rendered', async () => {
  const r = byId(await judgeMini()).get('SELF-OPT-ABSENT');
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.OPTION_ABSENT);
  assert.deepEqual(r.evidenceScope.completeRenderedSet, ['Alpha|1', 'Beta|2']);
  assert.ok(r.evidenceScope.capturesEnumerated >= 1);
});

test('option-present: wrong copy at a documented code is a label mismatch, not an absence', async () => {
  const r = byId(await judgeMini()).get('SELF-OPT-LABEL');
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.OPTION_LABEL_MISMATCH_AT_CODE);
  assert.deepEqual(r.predicateDetail.renderedLabels, ['Beta']);
});

test('route: destination agreement passes and carries the route-table witnesses', async () => {
  const r = byId(await judgeMini()).get('SELF-ROUTE-PASS');
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.predicateId, 'route@1');
  assert.ok(r.supportingWitnesses.every((w) => w.locator.endsWith('.screen_id')));
});

test('route: a contradicting destination is a defect derived by lookup, not narrative', async () => {
  const r = byId(await judgeMini()).get('SELF-ROUTE-FAIL');
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.disposition, DISPOSITION.DEFECT);
  assert.equal(r.reason, REASON.ROUTE_DESTINATION_MISMATCH);
  assert.deepEqual(r.predicateDetail.observedDestinations, { Q3: 2 });
});

test('route: a screen the document says to skip appearing anyway is its own reason code', async () => {
  const r = byId(await judgeMini()).get('SELF-ROUTE-SKIP');
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.ROUTE_SKIPPED_SCREEN_SHOWN);
});

test('route: an unexercised code is inconclusive — never a pass', async () => {
  const r = byId(await judgeMini()).get('SELF-ROUTE-UNEXERCISED');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.disposition, DISPOSITION.QUERY);
  assert.notEqual(r.verdict, VERDICT.PASS);
});

test('screen-conditional-presence: base membership judged from the walk, not from prose', async () => {
  const r = byId(await judgeMini()).get('SELF-PRESENCE');
  assert.equal(r.predicateId, 'screen-conditional-presence@1');
  assert.equal(r.predicateDetail.outOfBase, undefined, 'nothing was seen outside the base');
  // D3: "only for code 1" is a claim about EVERY other documented code, so it
  // is not decidable from what ran. Inconclusive, not a pass.
  //
  // D6 (round 3) sharpened WHY it is not decidable. The mini-run's document
  // enumerates codes 1..3 for Q1 while separately pinning code 2 as the LAST
  // option — it contradicts itself about where its own list ends, so the answer
  // domain is not closed at all. `sealed: codes.length >= 2` used to call three
  // extracted codes a complete universe and the rule then failed only on the
  // narrower ground that code 3 was never walked. Both refusals are correct;
  // the unsealed one is the stronger and comes first.
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.reason, REASON.ANSWER_DOMAIN_UNSEALED);
  assert.notEqual(r.verdict, VERDICT.PASS);
});

test('a screen that was never reached is NOT-ASSESSED, never PASS', async () => {
  const r = byId(await judgeMini()).get('SELF-NO-OBSERVATION');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.coverage, COVERAGE.NOT_REACHED);
});

test('an obligation with no typed expectation is NOT-ASSESSED and visible, never PASS', async () => {
  const r = byId(await judgeMini()).get('SELF-UNTYPED');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.reason, REASON.NO_TYPED_EXPECTATION);
  assert.equal(r.expectation, null);
});

test('ambiguity precedence: a violated obligation carrying an ambiguity becomes a QUERY', async () => {
  const r = byId(await judgeMini()).get('SELF-ROUTE-AMBIGUOUS');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(r.disposition, DISPOSITION.QUERY);
  assert.equal(r.reason, REASON.AMBIGUITY_PRECEDENCE);
  assert.equal(r.withheld.wouldHaveBeen, VERDICT.FAIL);
  assert.deepEqual(r.withheld.blockedBy, ['AMB-SELF-01']);
  // withholding must not hide the evidence
  assert.ok(r.counterWitnesses.length > 0, 'the withheld defect keeps its counter-witnesses');
  assert.equal(r.withheld.certificationBlocker, true);
});

test('ambiguity precedence is a hard rule: there is no policy path at all', async () => {
  // D4: this used to be tunable. A caller passing an empty policy object
  // disabled BOTH halves of a gate the design calls non-negotiable.
  await assert.rejects(async () => await judgeMini({ policy: { blockFail: true, blockPass: false } }), /locked gate/);
  await assert.rejects(async () => await judgeMini({ policy: {} }), /locked gate/);
  const r = byId(await judgeMini()).get('SELF-ROUTE-AMBIGUOUS');
  assert.notEqual(r.verdict, VERDICT.FAIL);
});

// ===========================================================================
// route-table soundness
// ===========================================================================

test('route table: a trace seq JUMP never becomes a phantom edge', async () => {
  const out = await judgeMini();
  const alpha = out.routeTable.rows.find((r) => r.question === 'Q1' && r.answer === 'Alpha|1');
  assert.deepEqual(Object.keys(alpha.destinations), ['Q2'],
    'SELF-03 goes Q1(Alpha) ... back hop ... Q3; a trace-only table would emit Q1(Alpha)->Q3');
  assert.ok(out.routeTable.skipped.some((s) => s.session === 'SELF-03'));
});

test('route table: a post-mutation answer is a real, attributed edge', async () => {
  const out = await judgeMini();
  const beta = out.routeTable.rows.find((r) => r.question === 'Q1' && r.answer === 'Beta|2');
  assert.equal(beta.destinations.Q3.count, 2);
  assert.ok(beta.destinations.Q3.witnesses.some((w) => w.source === 'post-mutation'));
});

test('route table: an overshot mutation and an uncorroborated click are integrity failures', async () => {
  const out = await judgeMini();
  const codes = out.routeTable.integrity.map((i) => i.code);
  assert.ok(codes.includes('ACTION_NOT_IN_INVENTORY'));
  assert.ok(codes.includes('SESSION_INTEGRITY_FAILURE'));
});

// ===========================================================================
// B. ADVERSARIAL — the verdict/evidence contradiction itself
// ===========================================================================

const store = () => new EvidenceStore(MINI);

test('adversarial: attest fails when the cited artifact does not exist', async () => {
  const r = await store().attest({ artifact: 'NOPE-999.json', locator: 'evidence[0].screen_id', equals: 'WELCOME' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CITED_ARTIFACT_MISSING');
});

test('adversarial: attest fails when the artifact contradicts the claimed value', async () => {
  const r = await store().attest({ artifact: 'SELF-02.json', locator: 'evidence[2].screen_id', equals: 'Q2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WITNESS_REREAD_FAILED');
  assert.equal(r.observed, 'Q3', 'the engine reports what the artifact actually says');
});

test('adversarial: attest fails when the locator does not resolve', async () => {
  const r = await store().attest({ artifact: 'SELF-01.json', locator: 'evidence[99].screen_id', equals: 'Q2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WITNESS_LOCATOR_UNRESOLVED');
});

test('adversarial: attest fails when the artifact changed under a pinned hash', async () => {
  const r = await store().attest({ artifact: 'SELF-01.json', sha256: '0'.repeat(64), locator: 'evidence[0].screen_id', equals: 'WELCOME' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WITNESS_REREAD_FAILED');
});

test('adversarial: an image cannot machine-support a verdict', async () => {
  assert.equal(classifyArtifact('shot.png'), EVIDENCE_CLASS.IMAGE);
  const r = await store().attest({ artifact: 'shot.png', locator: 'whatever', equals: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'IMAGE_ONLY_EVIDENCE');
});

test('adversarial: attest re-derives a summarizing projection instead of believing it', async () => {
  const s = store();
  const good = await s.attest({ artifact: 'SELF-01.json', locator: 'evidence[1].option_inventory', derive: 'labels', equals: ['Alpha', 'Beta'] });
  assert.equal(good.ok, true);
  const lie = await s.attest({ artifact: 'SELF-01.json', locator: 'evidence[1].option_inventory', derive: 'labels', equals: ['Alpha', 'Beta', 'Gamma'] });
  assert.equal(lie.ok, false);
  assert.equal(lie.reason, 'WITNESS_REREAD_FAILED');
});

/** Swap a predicate for one adversarial run, then always restore it. */
async function withPredicate(kind, impl, fn) {
  const original = PREDICATES[kind];
  PREDICATES[kind] = { id: `${kind}@adversarial`, run: impl };
  try { return await fn(); } finally { PREDICATES[kind] = original; }
}

test('ADVERSARIAL: a verdict citing an artifact that proves the opposite is NOT a pass', async () => {
  // This is the t1-easy failure in miniature: SATISFIED, confidently citing
  // SELF-02 evidence[2] — which says Q3, not Q2.
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.SATISFIED,
    reason: REASON.POSITIVE_WITNESS,
    witnesses: [{ artifact: 'SELF-02.json', session: 'SELF-02', seq: 3, locator: 'evidence[2].screen_id', equals: 'Q2', note: 'Beta -> Q2, no Q3 shown' }],
    counterWitnesses: [],
  }), async () => await judgeMini());

  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.notEqual(r.verdict, VERDICT.PASS, 'a fabricated pass must not survive re-verification');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.coverage, COVERAGE.BLOCKED);
  assert.equal(r.reason, REASON.WITNESS_REREAD_FAILED);
  assert.equal(r.attestation.allVerified, false);
  assert.equal(r.attestation.positive[0].observed, 'Q3');
});

test('ADVERSARIAL: a verdict citing a missing artifact is an error condition', async () => {
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.SATISFIED,
    reason: REASON.POSITIVE_WITNESS,
    witnesses: [{ artifact: 'GONE.json', locator: 'evidence[0].screen_id', equals: 'Q2' }],
    counterWitnesses: [],
  }), async () => await judgeMini());
  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  // D1 tightened this: an artifact the signed catalogue never listed is
  // refused before the filesystem is even consulted, so the reason is now the
  // stronger ARTIFACT_NOT_IN_SIGNED_MANIFEST. Either way it is an error
  // condition, never a pass.
  assert.ok([REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST, REASON.CITED_ARTIFACT_MISSING].includes(r.reason), r.reason);
});

test('ADVERSARIAL: a pass with no positive witness is refused', async () => {
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.SATISFIED, reason: REASON.POSITIVE_WITNESS, witnesses: [], counterWitnesses: [],
  }), async () => await judgeMini());
  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.reason, REASON.PASS_WITHOUT_WITNESS);
});

test('ADVERSARIAL: an absence claim without a complete scoped inventory is refused', async () => {
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.SATISFIED, reason: REASON.COMPLETE_POSITIVE_INVENTORY,
    witnesses: [], counterWitnesses: [], absenceClaim: true, scope: null,
  }), async () => await judgeMini());
  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.reason, REASON.INVENTORY_INCOMPLETE);
});

test('ADVERSARIAL: a defect asserted with no counter-witness is refused too', async () => {
  const out = await withPredicate('route', () => ({
    outcome: OUTCOME.VIOLATED, reason: REASON.ROUTE_DESTINATION_MISMATCH, witnesses: [], counterWitnesses: [],
  }), async () => await judgeMini());
  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.notEqual(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.PASS_WITHOUT_WITNESS);
});

test('ADVERSARIAL: a predicate that throws yields not-assessed, not a pass', async () => {
  const out = await withPredicate('route', () => { throw new Error('boom'); }, async () => await judgeMini());
  const r = byId(out).get('SELF-ROUTE-PASS');
  assert.equal(r.verdict, VERDICT.NOT_ASSESSED);
  assert.equal(r.coverage, COVERAGE.BLOCKED);
});

// ===========================================================================
// C. small units that the above depends on
// ===========================================================================

test('resolvePath is total — a bad path returns not-ok rather than throwing', async () => {
  assert.deepEqual(resolvePath({ a: [{ b: 1 }] }, 'a[0].b'), { ok: true, value: 1 });
  assert.equal(resolvePath({ a: 1 }, 'a[0].b').ok, false);
  assert.equal(resolvePath(null, 'a').ok, false);
});

test('normalization folds every dash and quote variant it claims to', async () => {
  assert.equal(normLine('screen‐out'), 'screen-out');
  assert.equal(normLine('screen‑out'), 'screen-out');
  assert.equal(normLine('don’t'), "don't");
  assert.equal(norm('a  b'), 'a b');
});

test('the compiler is evidence-blind and fails closed', async () => {
  const { expectation } = compileObligation({ id: 'X', category: 'instruction', statement: 'The survey should be nice.', doc_quote: '' });
  assert.equal(expectation, null, 'an unrecognised statement compiles to nothing, which becomes NOT-ASSESSED');
});

test('a fixed-bottom option is not compiled into a positional claim', async () => {
  const { expectation } = compileObligation({
    id: 'X', category: 'option-set',
    statement: 'Option 6 with answer text "Another brand" marked [SPECIFY] [FIX] appears as a fixed bottom choice on Q2.',
    doc_quote: '| 6 | Another brand |',
  });
  assert.equal(expectation.kind, 'option-present');
  assert.equal(expectation.position, null, 'several codes may share the fixed bottom block');
});

test('PROJECTIONS are a closed registry the attestor recomputes', async () => {
  assert.deepEqual(PROJECTIONS.labels([{ label: 'a' }, { label: 'b' }]), ['a', 'b']);
  assert.deepEqual(PROJECTIONS.labelsWithValues([{ label: 'a', value: '1' }]), ['a|1']);
  assert.equal(PROJECTIONS.gridRowLabels([{ rows: [{ label: 'r' }] }])[0], 'r');
});

// ===========================================================================
// D. regression against the real frozen run
//
// PUBLICATION BOUNDARY. These four are regressions against
// `pipeline/runs/t1-easy`, which is DERIVED from the blind corpus and is held
// back until the test runs are complete (docs/EVALUATION-BOUNDARY.md). They
// assert that run's content — named obligations and one named route row — so
// they cannot be repointed at the synthetic stand-in without becoming a
// statement about a different survey. They are SKIPPED WITH A STATED REASON
// when the run is absent, and the count is pinned at the bottom of this file so
// a fifth silent skip cannot be added later.
//
// They also no longer restate the blind material: the row this section is about
// is located through the compiled expectation of the obligation that covers it,
// so the private facts stay in the private run.
// ===========================================================================

const PRIVATE_GATED = 4;

test('t1-easy replay: the three false passes are no longer passes', privateOnly('names three obligations of the blind-derived run that used to pass falsely'), async () => {
  const out = await judgeReal();
  const m = byId(out);
  for (const id of ['OBL-B2B-11', 'OBL-B3C-16', 'OBL-B2B-12']) {
    assert.notEqual(m.get(id).verdict, VERDICT.PASS, `${id} must not be a pass`);
  }
  // the missed seeded defect is caught as an asserted defect on at least one of them
  assert.ok(['OBL-B2B-11', 'OBL-B2B-12'].some((id) => m.get(id).verdict === VERDICT.FAIL));
  // the third is withheld by its own extraction ambiguity, but stays visible
  assert.equal(m.get('OBL-B3C-16').withheld.wouldHaveBeen, VERDICT.FAIL);
});

test('t1-easy replay: the penalized false positive becomes a query', privateOnly('names one obligation of the blind-derived run and the ambiguity that withholds it'), async () => {
  const out = await judgeReal();
  const r = byId(out).get('OBL-B2A-03');
  assert.notEqual(r.verdict, VERDICT.FAIL);
  assert.equal(r.disposition, DISPOSITION.QUERY);
  assert.ok(r.withheld.blockedBy.includes('AMB-B2A-02'));
});

test('t1-easy replay: the route table contains the row that was denied', privateOnly('asserts one route row of the blind-derived run against its documented destination'), async () => {
  const checklist = JSON.parse(readFileSync(join(REAL, 'checklist.json'), 'utf8'));
  const ctx = await buildContext(REAL, checklist, { authority: authorityFor(REAL, checklist) });
  // The row is located through the COMPILED EXPECTATION of the obligation that
  // covers it, so no answer text, screen id or destination from the blind
  // corpus is written into this public file. The bug was that this row was
  // reported as never observed; it was observed, and it went somewhere else.
  const { expectation } = compileObligation(checklist.obligations.find((o) => o.id === 'OBL-B3C-16'));
  assert.equal(expectation.kind, 'route');
  const rows = ctx.routeTable.rows.filter(
    (r) => r.question === expectation.question && (r.answerCodes || []).some((c) => expectation.trigger.codes.includes(c)),
  );
  assert.ok(rows.length > 0, `${expectation.question} must carry the triggering answers in the route table`);
  // Exactly one of the triggering answers diverged, and the table has to hold
  // the row that says so — the bug was that this row was reported as never
  // observed at all.
  const diverged = rows.filter((r) => {
    const dests = Object.keys(r.destinations);
    return dests.length > 0 && !dests.includes(expectation.destination);
  });
  assert.equal(diverged.length, 1, `exactly one triggering answer of ${expectation.question} diverged`);
  const observed = Object.keys(diverged[0].destinations);
  assert.ok(
    expectation.mustNotShow.some((s) => observed.includes(s)),
    `the observed destination is a screen the document forbade here (observed ${observed.join(', ')})`,
  );
  // ...and the answers that did NOT diverge are in the table too, as passes.
  assert.ok(rows.length > diverged.length, 'the non-diverging triggering answers are recorded as well');
});

test('t1-easy replay: every asserted verdict survived re-verification', privateOnly('re-verifies every asserted verdict of the blind-derived run'), async () => {
  const out = await judgeReal();
  const bad = out.results.filter((r) => (r.verdict === VERDICT.PASS || r.verdict === VERDICT.FAIL) && !r.attestation.allVerified);
  assert.deepEqual(bad.map((r) => r.obligationId), []);
});

// ===========================================================================
// E. the skip inventory is itself asserted
//
// A test that quietly disappears when a file is missing is the failure class
// this suite exists to delete, so the gate above is counted rather than
// trusted: the number of `privateOnly(...)` gates in this file is pinned, and
// the pin is checked against the file's own source. Adding a fifth gate — or
// converting a live test into a bare presence check — turns this
// red. This test NEVER skips.
// ===========================================================================

test('publication boundary: the private-run gate is exactly as declared', async () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const gates = (src.match(/,\s*privateOnly\(/g) || []).length;
  assert.equal(gates, PRIVATE_GATED, `${gates} gated test(s) in this file, ${PRIVATE_GATED} declared`);
  const silent = new RegExp(['skip', ':\\s*!existsSync'].join(''));
  assert.ok(!silent.test(src), 'a bare existence check is a SILENT skip: gate with a stated reason instead');
});

announcePrivateRunGate('pipeline/judge/selftest/engine.test.mjs', PRIVATE_GATED);
