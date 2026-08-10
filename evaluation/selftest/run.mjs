#!/usr/bin/env node
/**
 * SELF-TEST RUNNER
 *
 * `node evaluation/selftest/run.mjs` — exits non-zero if any assertion fails.
 * Must be green before the first scored run; its result hash goes in FREEZE.json.
 *
 * Prints a SELFTEST summary line in the same shape scorer/test/run-suites.mjs greps for,
 * so this suite can be added to the repo's aggregate runner without special-casing.
 */

import { runCases, defaultScore, CASES } from "./cases.mjs";

const results = runCases(defaultScore);
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  if (r.ok) console.log(`  ok   ${r.name}`);
  else console.log(`  FAIL ${r.name}\n         ${r.error.split("\n").join("\n         ")}`);
}

console.log(`\nSELFTEST ${results.length - failed.length}/${results.length} passed (${CASES.length} cases)`);

if (failed.length) {
  console.log(
    "\nA red self-test means the scorer's behaviour no longer matches PRE-REGISTRATION.md.\n" +
      "Fix the scorer, or amend the pre-registration in writing — not silently.",
  );
  process.exit(1);
}
process.exit(0);
