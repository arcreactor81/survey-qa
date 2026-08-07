/**
 * selftest/fixtures/make-fixtures.mjs — regenerate the synthetic session
 * artifacts for the mini-run fixture. Run:  node make-fixtures.mjs
 *
 * The artifacts deliberately reproduce the shapes that broke the real run:
 *   SELF-01  clean forward walk (Alpha -> Q2 -> Q3)
 *   SELF-02  Beta -> Q3, contradicting the document's "Beta -> Q2"
 *   SELF-03  a back-navigation session whose `trace` seq JUMPS over the
 *            captures in `evidence` — the exact shape that makes a
 *            trace-only route table produce a phantom edge
 *   SELF-04  a mutation annotation naming a screen the capture is not on
 *            (driver overshot its target) plus a click that the capture's own
 *            option inventory does not contain
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSignedRunRecord } from './sign-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, 'mini-run');
const OUT = join(RUN, 'artifacts');
const REPO = resolve(join(here, '..', '..', '..', '..'));
mkdirSync(OUT, { recursive: true });

const OPTIONS_Q1 = [
  { kind: 'radio', label: 'Alpha', value: '1', name: 'Q1', checked: false, disabled: false, visible: true, y: 100, x: 40 },
  { kind: 'radio', label: 'Beta', value: '2', name: 'Q1', checked: false, disabled: false, visible: true, y: 140, x: 40 },
];

const controls = (back, next, progress) => ({
  back: { text: back ? 'Back' : '', visible: back, disabled: false },
  next: { text: next, visible: true, disabled: false },
  progress: { visible: true, now: String(progress), text: `${progress}% complete` },
});

function ev(seq, screen, { inventory = [], action_taken = null, progress = 0, back = true, next = 'Next', visible_text = '', heads = [], checked = null } = {}) {
  const inv = inventory.map((o) => (checked && o.label === checked ? { ...o, checked: true } : { ...o }));
  return {
    step: seq, seq, screen_id: screen, action_taken,
    question_text: heads[0] || '', heads_html: heads,
    option_inventory: inv, button_options: [], text_inputs: [], grid: [],
    controls_state: controls(back, next, progress),
    validation_messages: [], visible_text: visible_text || heads.join('\n'),
    page_errors: [], viewport: { width: 1280, height: 900 }, shimmed: false,
  };
}

function tr(seq, screen, clicked) {
  const t = { seq, screen, options: [], texts: [], grid_rows: [], grid_headers: [], errs: [] };
  if (clicked) t.applied = { question: screen, clicked: [{ label: clicked, ok: true, via: 'input', alias_used: null }], typed: null, grid: [], notes: [] };
  return t;
}

// --- SELF-01: clean walk, Alpha -> Q2 ---------------------------------------
writeFileSync(join(OUT, 'SELF-01.json'), `${JSON.stringify({
  id: 'SELF-01', tier: 1, class: 'floor', probing: 'clean forward walk',
  trace: [tr(1, 'WELCOME'), tr(2, 'Q1', 'Alpha'), tr(3, 'Q2', 'Yes'), tr(4, 'Q3', null)],
  evidence: [
    ev(1, 'WELCOME', { back: false, next: 'Continue', progress: 0, heads: ['Welcome to the mini survey.'] }),
    ev(2, 'Q1', { inventory: OPTIONS_Q1, progress: 25, heads: ['Which one?'] }),
    ev(3, 'Q2', { inventory: [{ kind: 'radio', label: 'Yes', value: '1', name: 'Q2', checked: false, disabled: false, visible: true }], progress: 50, heads: ['Follow-up for Alpha only.'] }),
    ev(4, 'Q3', { inventory: [{ kind: 'radio', label: 'Done', value: '1', name: 'Q3', checked: false, disabled: false, visible: true }], progress: 75, heads: ['Last question.'] }),
  ],
  page_errors: [],
}, null, 2)}\n`, 'utf8');

// --- SELF-02: Beta -> Q3, contradicting the document -------------------------
writeFileSync(join(OUT, 'SELF-02.json'), `${JSON.stringify({
  id: 'SELF-02', tier: 2, class: 'alternate-arrival', probing: 'take Beta and assert Q2 follows',
  trace: [tr(1, 'WELCOME'), tr(2, 'Q1', 'Beta'), tr(3, 'Q3', null)],
  evidence: [
    ev(1, 'WELCOME', { back: false, next: 'Continue', progress: 0, heads: ['Welcome to the mini survey.'] }),
    ev(2, 'Q1', { inventory: OPTIONS_Q1, progress: 25, heads: ['Which one?'] }),
    ev(3, 'Q3', { inventory: [{ kind: 'radio', label: 'Done', value: '1', name: 'Q3', checked: false, disabled: false, visible: true }], progress: 75, heads: ['Last question.'] }),
  ],
  page_errors: [],
}, null, 2)}\n`, 'utf8');

// --- SELF-03: trace seq jump over a back hop --------------------------------
// trace says 2 -> 6 (adjacent entries), evidence records 3,4,5 in between.
// A trace-only route table would emit the phantom edge Q1(Alpha) -> Q3.
writeFileSync(join(OUT, 'SELF-03.json'), `${JSON.stringify({
  id: 'SELF-03', tier: 2, class: 'revisit-mutation', probing: 'answer, go back, change, go forward',
  trace: [tr(1, 'WELCOME'), tr(2, 'Q1', 'Alpha'), tr(6, 'Q3', null)],
  evidence: [
    ev(1, 'WELCOME', { back: false, next: 'Continue', progress: 0, heads: ['Welcome to the mini survey.'] }),
    ev(2, 'Q1', { inventory: OPTIONS_Q1, progress: 25, heads: ['Which one?'] }),
    ev(3, 'Q2', { progress: 50, action_taken: 'reached the screen after Q1', heads: ['Follow-up for Alpha only.'] }),
    ev(4, 'Q1', { inventory: OPTIONS_Q1, progress: 25, action_taken: 'back hop', heads: ['Which one?'] }),
    ev(5, 'Q1', { inventory: OPTIONS_Q1, progress: 25, action_taken: 'mutated Q1 to ["Beta"]', checked: 'Beta', heads: ['Which one?'] }),
    ev(6, 'Q3', { progress: 75, heads: ['Last question.'] }),
  ],
  page_errors: [],
}, null, 2)}\n`, 'utf8');

// --- SELF-04: overshot mutation + uncorroborated click ----------------------
writeFileSync(join(OUT, 'SELF-04.json'), `${JSON.stringify({
  id: 'SELF-04', tier: 2, class: 'revisit-mutation', probing: 'driver overshoots its back-navigation target',
  trace: [tr(1, 'WELCOME'), tr(2, 'Q1', 'Omega')],
  evidence: [
    ev(1, 'WELCOME', { back: false, next: 'Continue', progress: 0, heads: ['Welcome to the mini survey.'] }),
    ev(2, 'Q1', { inventory: OPTIONS_Q1, progress: 25, heads: ['Which one?'] }),
    ev(3, 'Q3', { progress: 75, action_taken: 'mutated Q1 to ["Beta"]', heads: ['Last question.'] }),
    ev(4, 'Q3', { progress: 75, heads: ['Last question.'] }),
  ],
  page_errors: [],
}, null, 2)}\n`, 'utf8');

// --- a non-JSON artifact, so the image-only evidence rule can be exercised ---
writeFileSync(join(OUT, 'shot.png'), 'not-a-real-png-but-the-extension-is-what-classifies-it\n', 'utf8');

// --- the signed RunRecord: without one the judge is diagnostic-only (D1) -----
writeSignedRunRecord({
  runDir: RUN, repoRoot: REPO, runId: 'mini-run',
  checklist: JSON.parse(readFileSync(join(RUN, 'checklist.json'), 'utf8')),
});

console.log(`wrote fixtures to ${OUT}`);
