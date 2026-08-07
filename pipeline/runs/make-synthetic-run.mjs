#!/usr/bin/env node
/**
 * pipeline/runs/make-synthetic-run.mjs — build the PUBLIC stand-in run.
 *
 *   node pipeline/runs/make-synthetic-run.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * The blind corpus (`test-suite/blind/`) and everything derived from it are held
 * out of the public repository until the test runs are complete — see
 * `docs/EVALUATION-BOUNDARY.md`. The derived run `pipeline/runs/t1-easy/` is the
 * biggest of those derived artifacts: its captured artifacts reconstruct the
 * corpus and every planted defect on their own, so it cannot ship early.
 *
 * Five public test suites used that run as their SUBSTRATE — not for its
 * content, but because it is a real, signed, multi-session run that the real
 * judge, the real store and the real report can be driven over. This file
 * builds a substrate with the same shape out of a survey that exists nowhere
 * else: a short houseplant-care questionnaire invented for this file alone. It
 * shares no question, no answer text, no code frame and no defect with any
 * blind tier. (Screen ids are `Q1..Q7`/`WELCOME`/`CLOSING`/`SCREENOUT` because
 * that is the grammar `pipeline/judge/lib/compile.mjs` parses — a property of
 * the tool, not of any corpus.)
 *
 * It follows the pattern of `pipeline/judge/selftest/fixtures/make-v2-fixtures.mjs`
 * (author the artifacts, author the checklist, then sign the RunRecord with
 * `sign-run.mjs`), and it is regenerable: delete `synthetic-demo/` and re-run.
 *
 * THE SURVEY (public, synthetic, deliberately dull)
 * ------------------------------------------------
 *   WELCOME  no back button, "Start" instead of "Next"
 *   Q1  How do you usually water your houseplants?   codes 1-4, sealed, 4 = terminate
 *   Q2  Which watering can do you use?               codes 1-4, sealed, ASK ONLY IF Q1 = 1
 *   Q3  Where do you keep most of your plants?       codes 1-4, NOT sealed by the document
 *   Q4  Do you use plant food?                       codes 1-2, sealed  (skip rule)
 *   Q5  How often do you use plant food?             codes 1-3, sealed
 *   Q6  Anything else about your plants?             free text
 *   Q7  How did you get that watering can?           codes 1-2, ASK ONLY IF Q2 = 1
 *   CLOSING / SCREENOUT
 *
 * WHAT IS DELIBERATELY WRONG WITH IT, stated openly because nothing here is
 * blind. Every one of these exists because some public suite needs a run that
 * exhibits it:
 *
 *   1. ROUTE DEFECT (asserted fail). The document skips Q5 when Q4 = code 2
 *      ("No") and goes straight to Q6; the simulated site shows Q5 anyway.
 *      -> SYN-ROUTE-Q4-2 fails with ROUTE_SKIPPED_SCREEN_SHOWN.
 *   2. LABEL DEFECT (withheld fail). Q3 code 4 is documented "Somewhere else"
 *      and rendered "Somewhere else in the home" — and the document contradicts
 *      itself about that wording, so AMB-SYN-LABEL withholds the verdict.
 *      -> SYN-OPT-Q3-4 is INCONCLUSIVE with the fail visible underneath.
 *   3. UNEXERCISED DOMAIN CASE. Q2 code 4 is documented and rendered, and no
 *      session ever selects it, so a rule quantified over Q2's answers cannot
 *      be decided. -> SYN-PRESENCE-Q7 is INCONCLUSIVE / DOMAIN_CASE_UNEXERCISED.
 *   4. UNSEALED DOMAIN. The document enumerates four codes for Q3 and never
 *      says the list ends there. -> Q3's answer domain is not sealed.
 *   5. NOT BROWSER-OBSERVABLE. SYN-DATAFILE is about the data file.
 *
 * The RunRecord is left in the same TRUST POSTURE as a real harness run: the
 * contract revision is NOT sealed and the ambiguity set is NOT covered by the
 * signature, so the judge diagnoses it and refuses to publish. Consumers that
 * need a publishable record seal it themselves, exactly as they do for the
 * private run (`pipeline/report/make-acceptance-artifact.mjs`,
 * `worker-v2/tools/assembler/assemble-v2.mjs`).
 *
 * It also writes `substrate-shape.json` — the handful of coordinates a test
 * needs to drive a predicate at this run (which route diverges, which screen is
 * conditional, which obligation carries the route defect). `pipeline/runs/t1-easy`
 * carries the same file with its own coordinates, so the public suites never
 * spell out blind material.
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSignedRunRecord, keyPaths } from '../judge/selftest/fixtures/sign-run.mjs';
import { signRecord } from '../../scorer/src/lib/attest.mjs';
import { jcsHash } from '../../scorer/src/lib/canonical.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(here, '..', '..'));
export const RUN_ID = 'synthetic-demo';
const RUN = join(here, RUN_ID);
const OUT = join(RUN, 'artifacts');
const SIGNED_AT = '2026-08-02T00:00:00.000Z';

if (existsSync(RUN)) rmSync(RUN, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// the simulated site
// ---------------------------------------------------------------------------

const OPT = (screen, label, value) => ({
  kind: 'radio', label, value, name: screen, checked: false, disabled: false, visible: true, y: 100, x: 40,
});

/** What the SITE renders. The document's version of Q3 code 4 is shorter. */
const OPTIONS = {
  Q1: [
    OPT('Q1', 'A watering can', '1'),
    OPT('Q1', 'The kitchen tap', '2'),
    OPT('Q1', 'A self-watering pot', '3'),
    OPT('Q1', 'I do not have any houseplants', '4'),
  ],
  Q2: [
    OPT('Q2', 'Metal', '1'),
    OPT('Q2', 'Plastic', '2'),
    OPT('Q2', 'Ceramic', '3'),
    OPT('Q2', 'I do not use a watering can', '4'),
  ],
  Q3: [
    OPT('Q3', 'On a windowsill', '1'),
    OPT('Q3', 'On a balcony', '2'),
    OPT('Q3', 'On a desk', '3'),
    OPT('Q3', 'Somewhere else in the home', '4'), // documented as "Somewhere else"
  ],
  Q4: [
    OPT('Q4', 'Yes', '1'),
    OPT('Q4', 'No', '2'),
  ],
  Q5: [
    OPT('Q5', 'Every week', '1'),
    OPT('Q5', 'Every month', '2'),
    OPT('Q5', 'Rarely', '3'),
  ],
  Q7: [
    OPT('Q7', 'Bought new', '1'),
    OPT('Q7', 'Handed down', '2'),
  ],
};

/** What the DOCUMENT says the answer text is, where it differs from the site. */
const DOC_LABEL = { 'Q3|4': 'Somewhere else' };
const docLabel = (screen, code, rendered) => DOC_LABEL[`${screen}|${code}`] ?? rendered;

const HEAD = {
  WELCOME: 'Welcome. This short survey is about looking after houseplants.',
  Q1: 'How do you usually water your houseplants?',
  Q2: 'Which watering can do you use?',
  Q3: 'Where do you keep most of your plants?',
  Q4: 'Do you use plant food?',
  Q5: 'How often do you use plant food?',
  Q6: 'Anything else about your plants?',
  Q7: 'How did you get that watering can?',
  CLOSING: 'Thank you. Your answers have been recorded.',
  SCREENOUT: 'Thank you for your interest. This survey is for houseplant owners.',
};

const PROGRESS = { WELCOME: 0, Q1: 15, Q2: 30, Q7: 35, Q3: 45, Q4: 60, Q5: 75, Q6: 90, CLOSING: 100, SCREENOUT: 100 };

const controls = (screen, { back = true, next = 'Next' } = {}) => ({
  back: { text: back ? 'Back' : '', visible: back, disabled: false },
  next: { text: next, visible: true, disabled: false },
  progress: { visible: true, now: String(PROGRESS[screen] ?? 0), text: `${PROGRESS[screen] ?? 0}%` },
});

const TEXTBOX = [{ id: 'Q6_txt', name: 'Q6', tag: 'textarea', label: 'Your answer', value: '', maxlength: '500', visible: true, disabled: false }];

/** One capture of one screen, in the harness's evidence shape. */
function ev(seq, screen, { checked = null, back = true, next = 'Next', validation_messages = [] } = {}) {
  const inventory = (OPTIONS[screen] ?? []).map((o) => ({ ...o, checked: checked != null && o.value === checked }));
  return {
    step: seq,
    seq,
    screen_id: screen,
    action_taken: null,
    question_text: HEAD[screen],
    heads_html: [HEAD[screen]],
    option_inventory: inventory,
    button_options: [],
    text_inputs: screen === 'Q6' ? TEXTBOX : [],
    grid: [],
    controls_state: controls(screen, { back, next }),
    validation_messages,
    visible_text: HEAD[screen],
    page_errors: [],
    viewport: { width: 1280, height: 900 },
    shimmed: false,
  };
}

const clickTrace = (seq, screen, label) => ({
  seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [],
  applied: { question: screen, clicked: [{ label, ok: true, via: 'input', alias_used: null }], typed: null, grid: [], notes: [] },
});
const plainTrace = (seq, screen) => ({
  seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [],
  applied: { question: screen, clicked: [], typed: null, grid: [], notes: [] },
});

const labelFor = (screen, code) => (OPTIONS[screen] ?? []).find((o) => o.value === code)?.label ?? null;

const ARTIFACTS = [];

/**
 * Walk the simulated site. Every session starts on WELCOME, which has no back
 * control, so "a back button on every screen" is violated over the whole
 * capture population rather than in one lucky session.
 *
 * @param {Array<[string,string|null]>} picks  [screen, answerCode|null] in order
 * @param {string} last  the terminal screen the walk ends on
 */
function session(id, { tier = 1, cls = 'floor', picks, last, probes = [] }) {
  const trace = [plainTrace(1, 'WELCOME')];
  const evidence = [ev(1, 'WELCOME', { back: false, next: 'Start' })];
  let seq = 2;
  for (const [screen, code] of picks) {
    const label = code == null ? null : labelFor(screen, code);
    trace.push(label ? clickTrace(seq, screen, label) : plainTrace(seq, screen));
    evidence.push(ev(seq, screen, { checked: code }));
    seq += 1;
  }
  trace.push(plainTrace(seq, last));
  evidence.push(ev(seq, last));
  const doc = { id, tier, class: cls, trace, evidence, page_errors: [] };
  if (probes.length) doc.probes = probes;
  writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  ARTIFACTS.push(`${id}.json`);
}

/**
 * The site's routing, INCLUDING defect 1: code 2 at Q4 should skip Q5.
 * @param {string} q1 @param {string|null} q2 @param {string} q3 @param {string} q4 @param {string} q5
 */
function walk(q1, { q2 = null, q3 = '1', q4 = '1', q5 = '1', q7 = '1' } = {}) {
  if (q1 === '4') return { picks: [['Q1', '4']], last: 'SCREENOUT' };
  const picks = [['Q1', q1]];
  if (q1 === '1') {
    const code = q2 ?? '1';
    picks.push(['Q2', code]);
    // Q7 is correctly conditional on Q2 = code 1. Q2's code 4 is never
    // selected by any session, so a rule quantified over Q2's answers cannot
    // be decided — which is defect 3's whole point.
    if (code === '1') picks.push(['Q7', q7]);
  }
  picks.push(['Q3', q3], ['Q4', q4]);
  // DEFECT 1: Q5 is shown for BOTH codes of Q4, though the document skips it for code 2.
  picks.push(['Q5', q5]);
  picks.push(['Q6', null]);
  return { picks, last: 'CLOSING' };
}

// --- the walks -------------------------------------------------------------
// Between them every documented code of Q1, Q3, Q4 and Q5 is exercised, and
// Q2's code 4 deliberately is NOT (defect 3). ~24 sessions x 7-8 captures keeps
// the populations the completeness gate rebuilds well clear of a handful.

let n = 0;
const floor = (o) => session(`FLOOR-${String(++n).padStart(2, '0')}`, { tier: 1, cls: 'floor', ...walk(o.q1, o) });
const exp = (o) => session(`EXP-${String(++n).padStart(2, '0')}`, { tier: 2, cls: 'exploration', ...walk(o.q1, o) });

// Q1 = 1 -> Q2 shown. Q2 codes 1..3 (never 4), every Q3/Q4/Q5 combination once.
for (const q2 of ['1', '2', '3']) {
  for (const q4 of ['1', '2']) {
    floor({ q1: '1', q2, q3: '1', q4, q5: '1' });
  }
}
// Q1 = 2 and 3 -> Q2 correctly skipped.
for (const q1 of ['2', '3']) {
  for (const q3 of ['1', '2', '3', '4']) {
    exp({ q1, q3, q4: q3 === '2' ? '2' : '1', q5: q3 === '4' ? '3' : '2' });
  }
}
// Q1 = 4 terminates. Several, so the screen-out population is not a singleton.
for (let i = 0; i < 4; i += 1) exp({ q1: '4' });
// A few more completing walks so the eligible-session population is substantial.
for (const q3 of ['2', '3', '4']) {
  for (const q5 of ['1', '2', '3']) exp({ q1: '2', q3, q4: '1', q5 });
}

// A genuine enforcement refusal on Q1: did not advance, was blocked, said why,
// and stayed put. This is the shape the enforcement predicate accepts.
session('EXP-99', {
  tier: 2,
  cls: 'validation',
  ...walk('1', { q2: '1' }),
  probes: [{
    probe: 'submit-without-answering',
    at: 'Q1',
    before: { texts: [], checked: [], full_inventory: [] },
    after_screen: 'Q1',
    validation: ['Please choose one answer.'],
    advanced: false,
    blocked: true,
  }],
});

// ---------------------------------------------------------------------------
// the document, as the planner would have extracted it
// ---------------------------------------------------------------------------

/** Q3 is deliberately left without a closure anchor: four codes, no census. */
const SEALS_ITS_LIST = new Set(['Q1', 'Q2', 'Q4', 'Q5', 'Q7']);

const optionObligations = [];
for (const [screen, opts] of Object.entries(OPTIONS)) {
  opts.forEach((o, i) => {
    const label = docLabel(screen, o.value, o.label);
    const final = i === opts.length - 1 && SEALS_ITS_LIST.has(screen);
    optionObligations.push({
      id: `SYN-OPT-${screen}-${o.value}`,
      category: 'option-set',
      doc_quote: `| ${o.value} | ${label} |`,
      statement: final
        ? `Option ${o.value} with answer text "${label}" is displayed as the final option on ${screen}.`
        : `Option ${o.value} with answer text "${label}" is displayed on ${screen}.`,
      stimulus: [],
      expected_observable: `${label} appears on ${screen}.`,
      browser_observable: 'full',
    });
  });
}

const route = (id, quote, statement) => ({
  id, category: 'branch-outcome', doc_quote: quote, statement,
  stimulus: [], expected_observable: '', browser_observable: 'full',
});

const routeObligations = [
  route('SYN-ROUTE-Q1-1',
    'Q1 | Code 1 selected | Continue to Q2',
    'If a respondent selects "A watering can" (code 1) at Q1, the next screen must be Q2.'),
  route('SYN-ROUTE-Q1-2',
    'Q1 | Code 2 selected | Skip Q2 and continue to Q3',
    'If a respondent selects "The kitchen tap" (code 2) at Q1, the survey must skip Q2 and the next screen must be Q3.'),
  route('SYN-ROUTE-Q1-3',
    'Q1 | Code 3 selected | Skip Q2 and continue to Q3',
    'If a respondent selects "A self-watering pot" (code 3) at Q1, the survey must skip Q2 and the next screen must be Q3.'),
  route('SYN-ROUTE-Q1-4',
    'Q1 | Code 4 selected | TERMINATE',
    'If a respondent selects "I do not have any houseplants" (code 4) at Q1, the next screen must be the screen-out screen.'),
  route('SYN-ROUTE-Q4-1',
    'Q4 | Code 1 selected | Continue to Q5',
    'If a respondent selects "Yes" (code 1) at Q4, the next screen must be Q5.'),
  // DEFECT 1. The site shows Q5 for code 2 as well.
  route('SYN-ROUTE-Q4-2',
    'Q4 | Code 2 selected | Skip Q5 and continue to Q6',
    'If a respondent selects "No" (code 2) at Q4, the survey must skip Q5 and the next screen must be Q6.'),
];

const checklist = {
  schema_version: 'synthetic-1',
  target: RUN_ID,
  source_document: 'synthetic',
  counts: {},
  obligations: [
    ...optionObligations,
    ...routeObligations,
    {
      id: 'SYN-PRESENCE-Q2',
      category: 'question-presence',
      doc_quote: 'ASK ONLY THOSE WHO ANSWERED CODE 1 AT Q1.',
      statement: 'Q2 must be displayed only to respondents who selected answer code 1 on Q1.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    // DEFECT 3's consumer. The site honours this rule exactly, but Q2's
    // documented code 4 is never exercised, so "only if code 1" is a claim
    // about answers nobody gave. It fails closed to INCONCLUSIVE rather than
    // passing on the strength of what happened to run.
    {
      id: 'SYN-PRESENCE-Q7',
      category: 'question-presence',
      doc_quote: 'ASK ONLY THOSE WHO ANSWERED CODE 1 AT Q2.',
      statement: 'Q7 must be displayed only to respondents who selected answer code 1 on Q2.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    // The document's own names for its terminal screens. `buildDocumentModel`
    // reads these (and only these) to decide who completed the survey, which is
    // what makes eligibility a document-derived fact instead of a progress bar.
    {
      id: 'SYN-TERM-CLOSING',
      category: 'terminal',
      doc_quote: 'THE CLOSING SCREEN ENDS THE INTERVIEW.',
      statement: 'The closing screen must be shown to every respondent who reaches the end of the interview.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-TERM-SCREENOUT',
      category: 'terminal',
      doc_quote: 'RESPONDENTS WITHOUT HOUSEPLANTS ARE SCREENED OUT.',
      statement: 'The survey must present a screen identified as the screen-out screen after routing from S1 code 4.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-REQ-Q1',
      category: 'instruction',
      doc_quote: 'Q1 IS COMPULSORY.',
      statement: 'Q1 requires the respondent to select at least one answer before proceeding.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-BACKBUTTON',
      category: 'instruction',
      doc_quote: 'NO BACK BUTTON ON THE WELCOME SCREEN.',
      statement: 'The welcome screen must not display a back button.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-PROGRESS',
      category: 'instruction',
      doc_quote: 'A PROGRESS BAR MUST APPEAR THROUGHOUT.',
      statement: 'A progress bar must be displayed on every survey screen.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-WELCOME-LINE',
      category: 'instruction',
      doc_quote: 'WELCOME TEXT (VERBATIM).',
      statement: `The welcome screen must contain the exact line "${HEAD.WELCOME}".`,
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    // A scoped-absence claim: the predicate must search the WHOLE captured
    // population and attest what it searched, which is a distinct proof shape
    // from a positive witness and several suites exercise it.
    {
      id: 'SYN-NO-CLIENT-NAME',
      category: 'instruction',
      doc_quote: 'DO NOT NAME THE CLIENT ANYWHERE IN THE SURVEY.',
      statement: 'The client name "Fernbrook Botanicals" must never be displayed to the respondent.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    {
      id: 'SYN-SINGLE-Q1',
      category: 'instruction',
      doc_quote: 'Q1 IS A SINGLE-CODE QUESTION.',
      statement: 'Q1 must allow only a single answer to be selected.',
      stimulus: [], expected_observable: '', browser_observable: 'full',
    },
    // DEFECT 5: not decidable from a browser at all. The report distinguishes
    // "not tested" from "not testable" and something has to exercise that.
    {
      id: 'SYN-DATAFILE',
      category: 'instruction',
      doc_quote: 'THE ANSWER CODES MUST BE WRITTEN TO THE DATA FILE.',
      statement: 'The answer codes for Q1 must be written to the data file exactly as documented.',
      stimulus: [], expected_observable: '', browser_observable: 'none',
    },
  ],
  ambiguities: [
    // RELEVANT. The two readings disagree about the answer text itself, which
    // is exactly what the option predicate reads, so the observed mismatch on
    // Q3 code 4 (DEFECT 2) is WITHHELD rather than asserted.
    {
      id: 'AMB-SYN-LABEL',
      doc_quote: '| 4 | Somewhere else |',
      reading_a: 'The answer text is exactly "Somewhere else".',
      reading_b: 'The answer text is "Somewhere else in the home", shortened to fit the code frame.',
      why_ambiguous: 'The code frame and the question wording give different answer text for code 4.',
      locus: { fields: ['labels'], screens: ['Q3'], codes: ['4'] },
      affects: ['SYN-OPT-Q3-4'],
    },
    // IRRELEVANT to everything it is attached to: the readings disagree about
    // WHICH SCREENS are the closing ones, and none of the obligations below is
    // about a closing screen. This is the case where suppression must be
    // DECLINED rather than sprayed across every facet of the named screens.
    {
      id: 'AMB-SYN-CLOSING',
      doc_quote: 'THE LAST TWO CLOSING SCREENS CARRY THE PRIVACY NOTICE.',
      reading_a: 'The two closing screens are the completion screen and the screen-out screen.',
      reading_b: 'The two closing screens are the closing screen and a debrief screen shown before it.',
      why_ambiguous: 'The document never says which screens it counts as closing screens.',
      locus: { fields: ['screen', 'screenScope'], screens: ['CLOSING', 'SCREENOUT'], codes: [] },
      affects: [
        'SYN-OPT-Q1-1', 'SYN-OPT-Q1-2', 'SYN-OPT-Q1-3', 'SYN-OPT-Q1-4',
        'SYN-OPT-Q5-1', 'SYN-OPT-Q5-2', 'SYN-OPT-Q5-3',
      ],
    },
  ],
  unverifiable_from_browser: [
    { id: 'SYN-DATAFILE', why: 'the data file is written server-side and is not observable from a browser' },
  ],
};
checklist.counts = { obligations: checklist.obligations.length, ambiguities: checklist.ambiguities.length };

writeFileSync(join(RUN, 'checklist.json'), `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// observations.json — the execution notes the harness leaves beside a run.
// ---------------------------------------------------------------------------

writeFileSync(join(RUN, 'observations.json'), `${JSON.stringify({
  kind: 'execution-observations/v1',
  run: RUN_ID,
  generated_at: SIGNED_AT,
  synthetic: true,
  note:
    'Authored by pipeline/runs/make-synthetic-run.mjs. This run has no blind corpus behind it: '
    + 'the survey, the walks and the planted defects are invented in that file and are listed in '
    + 'full in its header. Nothing here derives from test-suite/blind/.',
  driver: { layer: 'simulated', tool: 'make-synthetic-run.mjs', browser: 'none', serving: 'none' },
  scale: { sessions: ARTIFACTS.length, screens: Object.keys(HEAD).length },
  obligation_observations: {},
  candidate_divergences: [
    { id: 'SYN-DIV-001', obligation: 'SYN-ROUTE-Q4-2', summary: 'Q4 code 2 is documented to skip Q5; the site shows Q5 anyway.' },
    { id: 'SYN-DIV-002', obligation: 'SYN-OPT-Q3-4', summary: 'Q3 code 4 renders longer answer text than the code frame documents.' },
  ],
  could_not_observe: [
    { item: 'SYN-DATAFILE — the answer codes written to the data file', why: 'the data file is server-side' },
  ],
  harness_caveats: ['This is a synthetic stand-in run; it proves shape and plumbing, not site behaviour.'],
}, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// the signed RunRecord, in a real harness run's TRUST POSTURE
// ---------------------------------------------------------------------------

// `sign-run.mjs` seals the revision and signs the ambiguity set, which is what a
// purpose-built fixture wants. A HARNESS run has neither: the contract hash
// identifies bytes rather than a reviewed thing, and the ambiguity set that
// decides which verdicts are withheld is not covered by the signature. The
// public suites assert that the judge DIAGNOSES exactly that and refuses to
// publish, so the stand-in has to be in the same state as the run it stands in
// for. Both properties are removed here and the record is re-signed, so it is a
// genuinely signed record that is genuinely unsealed — not a broken signature.
const record = writeSignedRunRecord({ runDir: RUN, repoRoot: REPO, runId: RUN_ID, checklist });

/**
 * THE HARNESS'S OWN DISPOSITIONS.
 *
 * `itemResults` is what the RUN said about itself while it was walking — not
 * what the judge later decided from the artifacts. A real harness run is
 * optimistic here (that gap is the reason the judging engine exists), so this
 * is too: everything the walk touched is `pass`, except the two divergences the
 * harness itself noticed and the one requirement it could not observe at all.
 * The worker-v2 acceptance suite lifts these into RunRecordV2 item results and
 * reconciles the coverage ledger against them.
 */
const HARNESS_DISPOSITION = {
  'SYN-ROUTE-Q4-2': { coverageStatus: 'exercised', verdict: 'fail', code: 'requirement-mismatch', summary: 'Q5 was displayed after Q4 code 2, which the document says to skip.' },
  'SYN-OPT-Q3-4': { coverageStatus: 'exercised', verdict: 'inconclusive', code: 'ambiguous-requirement', summary: 'The rendered answer text is longer than the code frame; the document gives both.' },
  'SYN-PRESENCE-Q7': { coverageStatus: 'exercised', verdict: 'inconclusive', code: 'insufficient-evidence', summary: 'No session selected Q2 code 4, so the conditional rule was not exercised over its whole domain.' },
  'SYN-DATAFILE': { coverageStatus: 'blocked', verdict: 'not-assessed', code: 'external-block', summary: 'The data file is written server-side and is not observable from a browser.' },
};
const DEFAULT_DISPOSITION = { coverageStatus: 'exercised', verdict: 'pass', code: 'requirement-met', summary: 'Observed on every capture that carried the screen.' };
const FIRST_EVIDENCE = `EV-${ARTIFACTS[0]}`;

record.itemResults = checklist.obligations.map((o) => {
  const d = HARNESS_DISPOSITION[o.id] ?? DEFAULT_DISPOSITION;
  return {
    itemId: o.id,
    coverageStatus: d.coverageStatus,
    verdict: d.verdict,
    reason: { code: d.code, summary: d.summary },
    confidence: 0.9,
    attemptRefs: [],
    findingRefs: d.verdict === 'fail' ? ['SYN-DIV-001'] : [],
    evidenceRefs: [FIRST_EVIDENCE],
  };
});

record.findings = [
  {
    findingId: 'SYN-DIV-001',
    kind: 'defect',
    severity: 'major',
    category: 'routing',
    summary: 'Q4 code 2 ("No") is documented to skip Q5 and continue to Q6. Every session that answered code 2 was shown Q5.',
    expected: 'Q4 | Code 2 selected | Skip Q5 and continue to Q6',
    observed: 'Q5 was displayed immediately after Q4 in every session that selected code 2.',
    confidence: 1,
    itemRefs: ['SYN-ROUTE-Q4-2'],
    attemptRefs: [],
    evidenceRefs: [FIRST_EVIDENCE],
  },
];

// `sign-run.mjs` seals the revision and signs the ambiguity set, which is what a
// purpose-built fixture wants. A HARNESS run has neither: the contract hash
// identifies bytes rather than a reviewed thing, and the ambiguity set that
// decides which verdicts are withheld is not covered by the signature. The
// public suites assert that the judge DIAGNOSES exactly that and refuses to
// publish, so the stand-in has to be in the same state as the run it stands in
// for. Both properties are removed here and the record is re-signed, so it is a
// genuinely signed record that is genuinely unsealed — not a broken signature.
const { revision: _sealed, assumptions: _signedAmbiguities, ...contractBody } = record.contract;
const contract = { ...contractBody, assumptions: [] };
const { attestation: _drop, ...rest } = record;
const unsealed = { ...rest, run: { ...record.run, contractHash: jcsHash(contract) }, contract };
const { privatePem, keyId } = keyPaths(REPO);
unsealed.attestation = signRecord(unsealed, readFileSync(privatePem, 'utf8'), keyId, SIGNED_AT);
writeFileSync(join(RUN, 'run-record.json'), `${JSON.stringify(unsealed, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// substrate-shape.json — the coordinates a public test needs to drive a
// predicate at THIS run. `pipeline/runs/t1-easy/substrate-shape.json` is the
// same file for the private run; keeping them out of the test source is what
// lets the public suites stay blind about the blind corpus.
// ---------------------------------------------------------------------------

writeFileSync(join(RUN, 'substrate-shape.json'), `${JSON.stringify({
  runId: RUN_ID,
  synthetic: true,
  note: 'Written by pipeline/runs/make-synthetic-run.mjs. See pipeline/runs/run-source.mjs.',

  // an artifact that exists, for tamper tests
  sampleArtifact: `${ARTIFACTS[0]}`,

  // the routing rule the site gets wrong, and the obligation that carries it
  divergingRoute: { question: 'Q4', codes: ['2'], destination: 'Q6', mustNotShow: ['Q5'] },
  routeDefectObligation: 'SYN-ROUTE-Q4-2',
  routeDefectReason: 'ROUTE_SKIPPED_SCREEN_SHOWN',

  // a screen the document makes conditional, stated as the predicate reads it
  conditionalScreen: { screen: 'Q5', question: 'Q4', codes: ['1'] },
  // a screen that is NOT shown to everyone, so "universal" is violated
  notUniversalScreen: 'Q2',
  // a screen that is never first, so "first screen" is violated
  notFirstScreen: 'Q6',
  // a screen shown in every session, so "universal" is satisfied
  universalScreen: 'Q1',

  // answer domains: one the document closes, one it does not
  sealedDomain: { question: 'Q1', rule: 'last-option-anchor' },
  unsealedDomain: { question: 'Q3' },

  // rows that cannot be decided
  unexercisedDomainObligation: 'SYN-PRESENCE-Q7',

  // the ambiguity whose suppression must be DECLINED as irrelevant
  irrelevantAmbiguity: 'AMB-SYN-CLOSING',
  irrelevantAmbiguityMinDeclines: 5,

  // The denominator, the artifact count, and the verdict distribution the judge
  // produces from the v1 record. worker-v2's acceptance suite pins the last of
  // these and compares its v2 path against it obligation by obligation.
  obligationCount: checklist.obligations.length,
  artifactCount: ARTIFACTS.length,
  v1BaselineDistribution: { pass: 30, fail: 1, inconclusive: 2, 'not-assessed': 3 },

  // N4: the verdict distribution before and after every ambiguity is re-signed
  // with an EMPTY typed locus. Pinned so that a change moving BOTH paths
  // together cannot slip past a comparison that only checks the two against
  // each other. Re-derive with `node pipeline/runs/make-synthetic-run.mjs` ONLY
  // after deciding the new numbers are correct; this is not a tolerance.
  narrowedLocusAttack: {
    control: { pass: 30, fail: 1, inconclusive: 2, 'not-assessed': 3 },
    attacked: { pass: 23, fail: 1, inconclusive: 9, 'not-assessed': 3 },
    withheld: 1,
  },
}, null, 2)}\n`, 'utf8');

process.stdout.write(
  [
    `wrote ${RUN}`,
    `  obligations ${checklist.obligations.length}`,
    `  ambiguities ${checklist.ambiguities.length}`,
    `  artifacts   ${ARTIFACTS.length}`,
    '',
  ].join('\n'),
);
