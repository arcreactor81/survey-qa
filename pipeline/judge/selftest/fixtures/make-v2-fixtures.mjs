/**
 * selftest/fixtures/make-v2-fixtures.mjs — the `mini-v2` run.
 *
 * One fixture per v2 defect, each shaped so the OLD code passes it and the new
 * code refuses it. Run:  node make-v2-fixtures.mjs
 *
 *   V2-CLEAN     a clean two-branch walk over a fully enumerated question
 *   V2-DOCCODE   the answer whose code exists only in the document's routing
 *                table, rendered with different copy   (D3)
 *   V2-FROZEN    a probe that neither advanced nor was blocked, with no
 *                validation message — a frozen page                (D6)
 *   V2-CONTRA    a probe recording advanced AND blocked             (D6)
 *   V2-ENFORCED  a probe that was genuinely refused                 (D6)
 *   V2-SAMESCRN  an action followed by a re-capture of the SAME screen — a
 *                validation probe that used to be admitted as a route (D7)
 *   V2-TYPED     a typed action naming a control the capture does not have (D7)
 *   V2-BROKEN    a capture spine with a duplicate seq                (D7)
 *   V2-GAP       a capture spine with a hole in it                   (D7)
 *   _analysis.json / mystery.json — a derived summary and an unclassifiable
 *                artifact, for the attest() class refusals
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSignedRunRecord } from './sign-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(here, '..', '..', '..', '..'));
const RUN = join(here, 'mini-v2');
const OUT = join(RUN, 'artifacts');
if (existsSync(RUN)) rmSync(RUN, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const OPT = (label, value) => ({ kind: 'radio', label, value, name: 'Q1', checked: false, disabled: false, visible: true, y: 100, x: 40 });
const Q1_OPTIONS = [OPT('Alpha option', '1'), OPT('Beta option', '2'), OPT('Gamma option', '3')];

const controls = (progress, back = true, next = 'Next') => ({
  back: { text: back ? 'Back' : '', visible: back, disabled: false },
  next: { text: next, visible: true, disabled: false },
  progress: { visible: true, now: String(progress), text: `${progress}%` },
});

function ev(seq, screen, o = {}) {
  const {
    inventory = [], action_taken = null, progress = 0, heads = [], checked = null,
    text_inputs = [], validation_messages = [], back = true, next = 'Next',
  } = o;
  return {
    step: seq, seq, screen_id: screen, action_taken,
    question_text: heads[0] || '', heads_html: heads,
    option_inventory: inventory.map((x) => (checked && x.label === checked ? { ...x, checked: true } : { ...x })),
    button_options: [], text_inputs, grid: [],
    controls_state: controls(progress, back, next),
    validation_messages, visible_text: heads.join('\n'),
    page_errors: [], viewport: { width: 1280, height: 900 }, shimmed: false,
  };
}

const clickTrace = (seq, screen, label) => ({
  seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [],
  applied: { question: screen, clicked: [{ label, ok: true, via: 'input', alias_used: null }], typed: null, grid: [], notes: [] },
});
const typedTrace = (seq, screen, typed) => ({
  seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [],
  applied: { question: screen, clicked: [], typed, grid: [], notes: [] },
});

const write = (name, obj) => writeFileSync(join(OUT, name), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');

// Every documented code of Q1 is exercised, so a sealed-domain rule CAN pass.
for (const [file, label, code, dest] of [
  ['V2-CLEAN-A.json', 'Alpha option', '1', 'Q2'],
  ['V2-CLEAN-B.json', 'Beta option', '2', 'Q3'],
  ['V2-CLEAN-C.json', 'Gamma option', '3', 'Q3'],
]) {
  write(file, {
    id: file.replace(/\.json$/, ''), tier: 1, class: 'floor',
    trace: [clickTrace(1, 'Q1', label), { seq: 2, screen: dest }],
    evidence: [
      ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
      ev(2, dest, { progress: 60, heads: [`${dest} body`] }),
    ],
    page_errors: [],
  });
}

// Q3 is answered but NEVER enumerated by the document: its complement is not a
// closed set, so an exclusion rule over it may not be decided.
write('V2-Q3-ONWARD.json', {
  id: 'V2-Q3-ONWARD', tier: 2, class: 'exploration',
  trace: [clickTrace(1, 'Q1', 'Gamma option'), clickTrace(2, 'Q3', 'Alpha option'), { seq: 3, screen: 'D1' }],
  evidence: [
    ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(2, 'Q3', { inventory: Q1_OPTIONS, progress: 60, heads: ['Q3 body'] }),
    ev(3, 'D1', { progress: 95, heads: ['D1 body'] }),
  ],
  page_errors: [],
});

// A welcome screen with no back button, so the irrelevant-ambiguity case has a
// real observation to release.
write('V2-WELCOME.json', {
  id: 'V2-WELCOME', tier: 1, class: 'floor',
  trace: [{ seq: 1, screen: 'WELCOME', applied: { question: 'WELCOME', clicked: [], typed: null, grid: [], notes: [] } }, clickTrace(2, 'Q1', 'Alpha option'), { seq: 3, screen: 'Q2' }],
  evidence: [
    ev(1, 'WELCOME', { progress: 0, back: false, next: 'Start', heads: ['Welcome.'] }),
    ev(2, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(3, 'Q2', { progress: 60, heads: ['Q2 body'] }),
  ],
  page_errors: [],
});

// D3 — the routing rule for code 2 is stated in words the site never renders.
// The document's own table binds it to code 2, and the site rendered "Beta
// option" there. Old compiler: no code, exact label mismatch, NOT REACHED.
write('V2-DOCCODE.json', {
  id: 'V2-DOCCODE', tier: 2, class: 'exploration',
  trace: [clickTrace(1, 'Q1', 'Beta option'), { seq: 2, screen: 'Q3' }],
  evidence: [
    ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(2, 'Q3', { progress: 60, heads: ['Q3 body'] }),
  ],
  page_errors: [],
});

// D6 — the three probe shapes.
const probeSession = (id, at, probe) => ({
  id, tier: 1, class: 'floor',
  trace: [clickTrace(1, 'Q1', 'Alpha option'), { seq: 2, screen: 'Q2' }],
  evidence: [
    ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(2, 'Q2', { progress: 60, heads: ['Q2 body'] }),
  ],
  probes: [probe],
  page_errors: [],
});

// Frozen page: the click never landed, so nothing advanced and nothing blocked.
write('V2-FROZEN.json', probeSession('V2-FROZEN', 'Q4', {
  probe: 'submit-without-answering', at: 'Q4',
  before: { texts: [], checked: [], full_inventory: [] },
  after_screen: null, validation: [], advanced: false, blocked: false,
}));
// Self-contradictory record.
write('V2-CONTRA.json', probeSession('V2-CONTRA', 'Q6', {
  probe: 'submit-without-answering', at: 'Q6',
  before: { texts: [], checked: [], full_inventory: [] },
  after_screen: 'Q6', validation: [], advanced: true, blocked: true,
}));
// A real refusal: did not advance, was blocked, said why, and stayed put.
write('V2-ENFORCED.json', probeSession('V2-ENFORCED', 'Q7', {
  probe: 'submit-without-answering', at: 'Q7',
  before: { texts: [], checked: [], full_inventory: [] },
  after_screen: 'Q7', validation: ['Please answer this question.'], advanced: false, blocked: true,
}));

// D7 — a validation probe: answer attempted on Q8, same screen captured again.
// The old admission rule accepted this as the route "Q8 -> Q8".
write('V2-SAMESCRN.json', {
  id: 'V2-SAMESCRN', tier: 2, class: 'validation',
  trace: [clickTrace(1, 'Q8', 'Alpha option'), { seq: 2, screen: 'Q8' }],
  evidence: [
    ev(1, 'Q8', { inventory: Q1_OPTIONS, progress: 80, heads: ['Q8?'] }),
    ev(2, 'Q8', { inventory: Q1_OPTIONS, progress: 80, heads: ['Q8?'], validation_messages: ['Please answer this question.'] }),
  ],
  page_errors: [],
});

// D7 — a typed action naming a control this capture does not contain.
write('V2-TYPED.json', {
  id: 'V2-TYPED', tier: 2, class: 'exploration',
  trace: [typedTrace(1, 'Q9', { ok: true, id: 'NOT_A_REAL_CONTROL', applied: 8, requested: 8, maxlength: '500' }), { seq: 2, screen: 'D1' }],
  evidence: [
    ev(1, 'Q9', { progress: 90, heads: ['Q9?'], text_inputs: [{ id: 'Q9_txt', name: 'Q9', tag: 'textarea', label: 'Your answer', value: '', maxlength: '500', visible: true, disabled: false }] }),
    ev(2, 'D1', { progress: 95, heads: ['D1 body'] }),
  ],
  page_errors: [],
});

// D7 — a spine with a DUPLICATE capture index. `new Map(steps)` used to drop
// the first of the two silently, and the survivor became someone else's "next".
write('V2-BROKEN.json', {
  id: 'V2-BROKEN', tier: 2, class: 'exploration',
  trace: [clickTrace(1, 'Q1', 'Alpha option')],
  evidence: [
    ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(2, 'SCREENOUT', { progress: 99, heads: ['Sorry.'] }),
    ev(2, 'Q2', { progress: 60, heads: ['Q2 body'] }),
  ],
  page_errors: [],
});

// D7 — a spine with a HOLE: captures 1 and 3, nothing at 2.
write('V2-GAP.json', {
  id: 'V2-GAP', tier: 2, class: 'exploration',
  trace: [clickTrace(1, 'Q1', 'Alpha option')],
  evidence: [
    ev(1, 'Q1', { inventory: Q1_OPTIONS, progress: 20, heads: ['Which one?'] }),
    ev(3, 'SCREENOUT', { progress: 99, heads: ['Sorry.'] }),
  ],
  page_errors: [],
});

// Advisory: a derived summary and an unclassifiable JSON blob. Neither may
// machine-support a verdict; only images used to be refused.
write('_analysis.json', { note: 'a summary produced by the stage that fabricated the verdicts', screens: { Q1: 'fine' } });
write('mystery.json', { screens: [{ id: 'Q1' }], note: 'no capture spine, no known name' });
writeFileSync(join(OUT, 'shot.png'), 'not-a-real-png\n', 'utf8');

// ---------------------------------------------------------------------------

const checklist = {
  schema_version: 'selftest-2',
  target: 'mini-v2',
  source_document: 'synthetic',
  obligations: [
    // the document enumerates Q1's three codes: this is the SEALED domain
    { id: 'V2-OPT-1', category: 'option-set', doc_quote: '| 1 | Alpha option |', statement: 'Option 1 with answer text "Alpha option" is displayed on Q1.', expected_observable: '', browser_observable: 'full' },
    { id: 'V2-OPT-2', category: 'option-set', doc_quote: '| 2 | Beta option |', statement: 'Option 2 with answer text "Beta option" is displayed on Q1.', expected_observable: '', browser_observable: 'full' },
    // D6: an enumeration is not a census. The document has to say where its
    // list ENDS, or the domain stays unsealed and every complement claim built
    // on it is inconclusive. Code 3 is the anchor that closes Q1.
    { id: 'V2-OPT-3', category: 'option-set', doc_quote: '| 3 | Gamma option |', statement: 'Option 3 with answer text "Gamma option" is displayed as the final option on Q1.', expected_observable: '', browser_observable: 'full' },

    // D3: the code lives ONLY in the document's routing row; the statement
    // paraphrases the option ("Beta"), which no rendered label equals.
    {
      id: 'V2-ROUTE-DOCCODE', category: 'branch-outcome',
      doc_quote: 'Q1 | Code 2 selected (Beta) | Continue to Q3',
      statement: 'If a respondent selects "Beta" for Q1, the next screen must be Q3.',
      expected_observable: '', browser_observable: 'full',
    },
    // D3: an exclusion rule — a claim about the complement of code 1.
    {
      id: 'V2-ROUTE-EXCLUDE', category: 'branch-outcome',
      doc_quote: 'Q1 | Any code other than code 1 | Continue to Q3',
      statement: 'If a respondent does not select code 1 at Q1, the next screen must be Q3.',
      expected_observable: '', browser_observable: 'full',
    },
    // D3: the same exclusion over a question the document never enumerates.
    {
      id: 'V2-ROUTE-UNSEALED', category: 'branch-outcome',
      doc_quote: 'Q3 | Any code other than code 1 | Continue to D1',
      statement: 'If a respondent does not select code 1 at Q3, the next screen must be D1.',
      expected_observable: '', browser_observable: 'full',
    },
    // D3: conditional presence over the sealed domain.
    {
      id: 'V2-PRESENCE', category: 'question-presence',
      doc_quote: 'ASK ONLY THOSE WHO ANSWERED CODE 1 AT Q1.',
      statement: 'Q2 must be displayed only to respondents who selected answer code 1 on Q1.',
      expected_observable: '', browser_observable: 'full',
    },

    // D6: three enforcement obligations, one per probe shape.
    { id: 'V2-REQ-FROZEN', category: 'instruction', doc_quote: 'Q4 IS COMPULSORY.', statement: 'Q4 requires the respondent to select at least one answer before proceeding.', expected_observable: '', browser_observable: 'full' },
    { id: 'V2-REQ-CONTRA', category: 'instruction', doc_quote: 'Q6 IS COMPULSORY.', statement: 'Q6 requires the respondent to select at least one answer before proceeding.', expected_observable: '', browser_observable: 'full' },
    { id: 'V2-REQ-ENFORCED', category: 'instruction', doc_quote: 'Q7 IS COMPULSORY.', statement: 'Q7 requires the respondent to select at least one answer before proceeding.', expected_observable: '', browser_observable: 'full' },

    // D4: an ambiguity that cannot touch this predicate.
    { id: 'V2-BACKBUTTON', category: 'instruction', doc_quote: 'NO BACK BUTTON ON THE WELCOME SCREEN.', statement: 'The welcome screen must not display a back button.', expected_observable: '', browser_observable: 'full' },
  ],
  ambiguities: [
    {
      id: 'AMB-V2-IRRELEVANT',
      doc_quote: 'SHOW A BACK BUTTON ON EVERY SCREEN EXCEPT THE WELCOME SCREEN AND THE TWO CLOSING SCREENS.',
      reading_a: 'The two closing screens are the final thank-you screen and the screen-out screen.',
      reading_b: 'The two closing screens are the penultimate debrief screen and the final completion screen.',
      why_ambiguous: 'The document never says which screens are the closing ones.',
      // D5: the TYPED LOCUS, declared by the extraction and covered by the
      // signature (sign-run.mjs digests it into the assumption token). A locus
      // that is signed may narrow; an unsigned one may only add.
      locus: { fields: ['screen', 'screenScope'], screens: ['CLOSING', 'SCREENOUT'], codes: [] },
      affects: ['V2-BACKBUTTON'],
    },
    {
      id: 'AMB-V2-RELEVANT',
      doc_quote: 'Q1 | Code 2 selected (Beta) | Continue to Q3',
      reading_a: 'Code 2 continues to Q3.',
      reading_b: 'Code 2 continues to Q2 and only then to Q3.',
      why_ambiguous: 'The routing table and the prose disagree about the destination for code 2.',
      locus: { fields: ['destination', 'sequence', 'order'], screens: ['Q2', 'Q3'], codes: ['2'] },
      affects: ['V2-ROUTE-DOCCODE'],
    },
  ],
  unverifiable_from_browser: [],
};

writeFileSync(join(RUN, 'checklist.json'), `${JSON.stringify(checklist, null, 2)}\n`, 'utf8');
writeSignedRunRecord({ runDir: RUN, repoRoot: REPO, runId: 'mini-v2', checklist });

console.log(`wrote mini-v2 fixtures to ${RUN}`);
