/**
 * pipeline/runs/run-source.mjs — which run the public test suites drive.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `pipeline/runs/t1-easy/` is DERIVED from the blind corpus and reconstructs it:
 * its captured artifacts carry a verbatim doc-vs-site copy of every screen, the
 * full option inventory with codes, and the trace of each planted defect. It is
 * therefore held out of the public repository until the test runs are complete
 * (`docs/EVALUATION-BOUNDARY.md`, PHASE 1 of a staggered push).
 *
 * Five public suites used it as their SUBSTRATE — they need "a real, signed,
 * multi-session run the real judge/store/report can be driven over", not that
 * particular survey. `pipeline/runs/synthetic-demo/` is a public run of the same
 * shape built from an invented houseplant questionnaire
 * (`pipeline/runs/make-synthetic-run.mjs`). SUBSTRATE_RUN resolves to the
 * private run when it is present and to the synthetic one when it is not, so a
 * clean clone runs the same suites end to end.
 *
 * A HANDFUL of tests are about the private run's CONTENT — a named obligation
 * id, a pinned verdict distribution, a specific planted defect. Those cannot be
 * repointed without either weakening them into nothing or restating the blind
 * material they exist to check. They are gated with `privateOnly()`, which
 * produces a node:test skip carrying a STATED REASON, and every file that gates
 * anything must call `announcePrivateRunGate()` so the gate is announced on
 * stderr instead of vanishing. `gatedCount` lets a suite assert how many of its
 * own tests are gated, so a silent skip cannot be added later without the pin
 * moving.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The blind-derived run. Present in the owner's tree, absent from the public repo. */
export const PRIVATE_RUN = resolve(join(here, 't1-easy'));
/** The public stand-in. Regenerate with `node pipeline/runs/make-synthetic-run.mjs`. */
export const SYNTHETIC_RUN = resolve(join(here, 'synthetic-demo'));

export const PRIVATE_RUN_ID = 't1-easy';
export const SYNTHETIC_RUN_ID = 'synthetic-demo';

export const PRIVATE_RUN_PRESENT = existsSync(join(PRIVATE_RUN, 'run-record.json'));

/**
 * The run the suites drive when they only need A real signed run.
 * Private when it exists (so the owner keeps the coverage they had), synthetic
 * otherwise (so the public repo keeps a green suite).
 */
export const SUBSTRATE_RUN = PRIVATE_RUN_PRESENT ? PRIVATE_RUN : SYNTHETIC_RUN;
export const SUBSTRATE_RUN_ID = PRIVATE_RUN_PRESENT ? PRIVATE_RUN_ID : SYNTHETIC_RUN_ID;
export const SUBSTRATE_IS_PRIVATE = PRIVATE_RUN_PRESENT;

if (!existsSync(join(SYNTHETIC_RUN, 'run-record.json'))) {
  throw new Error(
    `the public stand-in run is missing at ${SYNTHETIC_RUN}. `
    + 'Rebuild it with `node pipeline/runs/make-synthetic-run.mjs`. '
    + 'It is committed, so an absence here means it was deleted, not that it is optional.',
  );
}

/**
 * WHERE THE PRIVATE FACTS LIVE.
 *
 * A few suites have to name a coordinate of the run they drive — which routing
 * rule diverges, which screen is conditional, which obligation carries the
 * route defect. Written into a public test file those coordinates ARE the blind
 * corpus's planted defects, spelled out. So each run carries its own
 * `substrate-shape.json` and the tests read it: the private run's copy lives
 * inside the private run and ships with it in phase 2.
 */
export const SUBSTRATE_SHAPE = JSON.parse(readFileSync(join(SUBSTRATE_RUN, 'substrate-shape.json'), 'utf8'));

/**
 * node:test options that skip a test WITH A STATED REASON when the private run
 * is absent, and run it normally when it is present.
 *
 * Use ONLY where the assertion is about the private run's content and has no
 * honest synthetic equivalent. Anything that merely needs a run belongs on
 * SUBSTRATE_RUN.
 *
 * @param {string} why  what this test asserts that only the private run carries
 */
export function privateOnly(why) {
  if (PRIVATE_RUN_PRESENT) return {};
  return { skip: `PRIVATE RUN REQUIRED — ${why} (pipeline/runs/t1-easy is not in this checkout; see docs/EVALUATION-BOUNDARY.md)` };
}

/**
 * Say out loud, once per test file, that some of its tests are gated.
 *
 * @param {string} file      the suite announcing
 * @param {number} gated     how many tests in it are gated
 */
export function announcePrivateRunGate(file, gated) {
  if (PRIVATE_RUN_PRESENT || gated === 0) return;
  process.stderr.write(
    `\n${'='.repeat(74)}\n`
    + `EVALUATION BOUNDARY — ${file}\n`
    + `  ${gated} test(s) in this file assert facts about the private run\n`
    + `  pipeline/runs/t1-easy, which is held out of this checkout until the test\n`
    + '  runs are complete (docs/EVALUATION-BOUNDARY.md). They are reported as\n'
    + '  SKIP with a stated reason, NOT quietly passed over.\n'
    + `  Every other test in this file runs against ${SYNTHETIC_RUN_ID}.\n`
    + `${'='.repeat(74)}\n\n`,
  );
}
