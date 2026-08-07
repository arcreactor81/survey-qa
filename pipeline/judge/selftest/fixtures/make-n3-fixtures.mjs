/**
 * selftest/fixtures/make-n3-fixtures.mjs — the PLANTED-VIOLATION fixture.
 * Run:  node make-n3-fixtures.mjs
 *
 * N3: as a side effect of the D5 "a completeness claim must attest its scope"
 * tripwire, five predicate classes lost the ability to return `fail` at all.
 * They observed the violation, attested a counter-witness, and were demoted to
 * NOT-ASSESSED / BLOCKED / QUERY before the verdict was computed, because their
 * `bad()` branch carried no `scope` while their `ok()` branch did. It fails
 * safe, so no suite caught it; and mini-run / mini-v2 contain no obligation of
 * any of the five kinds, so nothing ever drove them to a violation at all.
 *
 * This run plants exactly one genuine, plainly visible violation per affected
 * class, plus one for an UNaffected member of SCOPE_REQUIRED as a control:
 *
 *   control-absent-on-screen@1   a back button on the welcome screen
 *   screen-controls-only@1       an answer control on the welcome screen
 *   text-forbidden@1             the client name shown to respondents
 *   no-instruction-leak@1        "[ASK ALL]" left in the visible copy
 *   one-question-per-screen@1    two question stems on one screen
 *   option-present@1  (control)  a documented option that is not rendered
 *
 * Two sessions, and the violation is present in only ONE of them for the
 * screen-scoped classes. That is deliberate: the scope a violation declares
 * must be the WHOLE population it searched, not the subset it found hits in,
 * so a fix that declared the scope from `bads` instead of `caps` would still
 * be caught by the independent re-derivation in ScopeAttestor.
 *
 * The captures also carry the structure the other six SCOPE_REQUIRED
 * predicates need in order to be driven to a violation directly:
 *   Q1  an option documented but not rendered  (option-present, option-set-exact)
 *   Q2  codes rendered 2,1,3 as checkboxes     (option-order-fixed,
 *                                               option-order-randomized,
 *                                               selection-mode)
 *   Q3  a grid row missing in one session      (grid-row-present)
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSignedRunRecord } from './sign-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, 'mini-n3');
const OUT = join(RUN, 'artifacts');
const REPO = resolve(join(here, '..', '..', '..', '..'));
mkdirSync(OUT, { recursive: true });

const VP = { width: 1280, height: 900 };

const opt = (label, value, kind, name) => ({ kind, label, value, name, checked: false, disabled: false, visible: true });

const CONSENT = [opt('I agree to take part', '1', 'checkbox', 'CONSENT')];

// Q1: "Gamma option" is documented (see the checklist) and NOT rendered.
const Q1_INVENTORY = [
  opt('Alpha option', '1', 'radio', 'Q1'),
  opt('Beta option', '2', 'radio', 'Q1'),
];

// Q2: every documented option IS rendered — but out of documented order, and
// as checkboxes rather than a single-choice radio set.
const Q2_INVENTORY = [
  opt('Beta option', '2', 'checkbox', 'Q2'),
  opt('Alpha option', '1', 'checkbox', 'Q2'),
  opt('Gamma option', '3', 'checkbox', 'Q2'),
];

const gridRow = (label, name) => ({ label, inputs: [{ name, value: '1' }, { name, value: '2' }] });
const GRID_COMPLETE = [{ headers: ['', 'Yes', 'No'], rows: [gridRow('Row one', 'Q3_R1'), gridRow('Row two', 'Q3_R2')] }];
const GRID_MISSING_R2 = [{ headers: ['', 'Yes', 'No'], rows: [gridRow('Row one', 'Q3_R1')] }];

const controls = (back, nextText, nextVisible = true) => ({
  back: { text: back ? 'Back' : '', visible: back, disabled: false },
  next: { text: nextText, visible: nextVisible, disabled: false },
  progress: { visible: true, now: '0', text: 'in progress' },
});

function ev(seq, screen, {
  inventory = [], grid = [], back = true, next = 'Next', nextVisible = true,
  visibleText = '', heads = [],
} = {}) {
  return {
    step: seq, seq, screen_id: screen, action_taken: null,
    question_text: heads[0] || '', heads_html: heads,
    option_inventory: inventory, button_options: [], text_inputs: [], grid,
    controls_state: controls(back, next, nextVisible),
    validation_messages: [], visible_text: visibleText || heads.join('\n'),
    page_errors: [], viewport: VP, shimmed: false,
  };
}

const tr = (seq, screen, clicked) => {
  const t = { seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [] };
  if (clicked) t.applied = { question: screen, clicked: [{ label: clicked, ok: true, via: 'input', alias_used: null }], typed: null, grid: [], notes: [] };
  return t;
};

/**
 * @param {boolean} planted whether THIS session carries the screen-scoped
 *   violations. Both sessions render the same (defective) option sets, so the
 *   inventory-scoped classes violate on every capture; the copy/control classes
 *   violate on one capture out of two.
 */
function session(id, planted) {
  return {
    id,
    tier: 1,
    class: 'floor',
    probing: planted ? 'planted violations' : 'same screens, clean copy and controls',
    trace: [tr(1, 'WELCOME'), tr(2, 'Q1', 'Alpha option'), tr(3, 'Q2', 'Beta option'), tr(4, 'Q3'), tr(5, 'CLOSING')],
    evidence: [
      ev(1, 'WELCOME', {
        // PLANTED: a back button on the welcome screen -> control-absent-on-screen@1
        back: planted,
        next: 'Start survey',
        // PLANTED: an answer control on the welcome screen -> screen-controls-only@1
        inventory: planted ? CONSENT : [],
        // PLANTED: the client name shown to respondents -> text-forbidden@1
        visibleText: planted
          ? 'Welcome to our survey. Acme Beverages thanks you for taking part.'
          : 'Welcome to our survey. Thank you for taking part.',
        heads: ['Welcome'],
      }),
      ev(2, 'Q1', {
        inventory: Q1_INVENTORY,
        // PLANTED: a bracketed programmer instruction -> no-instruction-leak@1
        visibleText: planted
          ? 'Which do you own? [ASK ALL] Also, how often do you buy?'
          : 'Which do you own?',
        // PLANTED: two question stems on one screen -> one-question-per-screen@1
        heads: planted ? ['Which do you own?', 'How often do you buy?'] : ['Which do you own?'],
      }),
      ev(3, 'Q2', { inventory: Q2_INVENTORY, visibleText: 'Which have you bought?', heads: ['Which have you bought?'] }),
      ev(4, 'Q3', {
        // PLANTED: the second grid row is not rendered -> grid-row-present@1
        grid: planted ? GRID_MISSING_R2 : GRID_COMPLETE,
        visibleText: 'How much do you agree?',
        heads: ['How much do you agree?'],
      }),
      ev(5, 'CLOSING', { back: false, next: '', nextVisible: false, visibleText: 'Thank you.', heads: ['Thank you'] }),
    ],
    probes: [],
    page_errors: [],
  };
}

const CHECKLIST = {
  schema_version: '1.0',
  target: { name: 'mini-n3' },
  source_document: 'mini-n3',
  ambiguities: [],
  unverifiable_from_browser: [],
  obligations: [
    // --- the five classes N3 muted -----------------------------------------
    {
      id: 'N3-ONEQ', category: 'general', doc_quote: '', browser_observable: 'full',
      statement: 'Each question must be displayed on a separate screen.',
    },
    {
      id: 'N3-LEAK', category: 'general', doc_quote: '', browser_observable: 'full',
      statement: 'Programmer instructions within square brackets and capital letters must not be displayed to respondents.',
    },
    {
      id: 'N3-BACK', category: 'general', doc_quote: '', browser_observable: 'full',
      statement: 'The welcome screen must not display a back button.',
    },
    {
      id: 'N3-WELC', category: 'general', doc_quote: '', browser_observable: 'full',
      statement: 'The welcome screen must present only a single "Start survey" button and no answer fields or other input controls.',
    },
    {
      id: 'N3-FORB', category: 'copy', doc_quote: '', browser_observable: 'full',
      statement: 'The client name "Acme Beverages" must never be displayed to respondents.',
    },
    // --- control: an UNaffected member of SCOPE_REQUIRED --------------------
    { id: 'N3-Q1-OPT-1', category: 'option-set', doc_quote: '| 1 | Alpha option |', browser_observable: 'full', statement: 'Option 1 with answer text "Alpha option" is displayed on Q1.' },
    { id: 'N3-Q1-OPT-2', category: 'option-set', doc_quote: '| 2 | Beta option |', browser_observable: 'full', statement: 'Option 2 with answer text "Beta option" is displayed on Q1.' },
    { id: 'N3-Q1-OPT-3', category: 'option-set', doc_quote: '| 3 | Gamma option |', browser_observable: 'full', statement: 'Option 3 with answer text "Gamma option" is displayed on Q1.' },
    // --- Q2, so the DOCUMENT order of Q2 is reconstructible ------------------
    { id: 'N3-Q2-OPT-1', category: 'option-set', doc_quote: '| 1 | Alpha option |', browser_observable: 'full', statement: 'Option 1 with answer text "Alpha option" is displayed on Q2.' },
    { id: 'N3-Q2-OPT-2', category: 'option-set', doc_quote: '| 2 | Beta option |', browser_observable: 'full', statement: 'Option 2 with answer text "Beta option" is displayed on Q2.' },
    { id: 'N3-Q2-OPT-3', category: 'option-set', doc_quote: '| 3 | Gamma option |', browser_observable: 'full', statement: 'Option 3 with answer text "Gamma option" is displayed on Q2.' },
  ],
};

writeFileSync(join(RUN, 'checklist.json'), `${JSON.stringify(CHECKLIST, null, 2)}\n`, 'utf8');
writeFileSync(join(OUT, 'N3-A.json'), `${JSON.stringify(session('N3-A', true), null, 2)}\n`, 'utf8');
writeFileSync(join(OUT, 'N3-B.json'), `${JSON.stringify(session('N3-B', false), null, 2)}\n`, 'utf8');

writeSignedRunRecord({
  runDir: RUN, repoRoot: REPO, runId: 'mini-n3',
  checklist: JSON.parse(readFileSync(join(RUN, 'checklist.json'), 'utf8')),
});

console.log(`wrote fixtures to ${OUT}`);
