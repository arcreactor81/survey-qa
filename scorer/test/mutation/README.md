# Mutation safety net

The measuring apparatus is only as trustworthy as the tests that guard it. The
P0 adversarial audit (finding 11) measured that guard and found it thin: **a 45%
mutation kill rate, with 16 live gates that could each be deleted one at a time
with the whole suite still green.** That is an assurance hole rather than a live
one — every gate probed was correct on the day — but it means a fix landed
against that net is unverifiable: a reverted fix looks exactly like a working
one.

This directory is the net.

---

## Running it

```bash
# full run: 130 mutants x 6 suites, in a scratch copy of the tree
node scorer/test/mutation/run-mutations.mjs

# just check the catalogue still matches the source (fast, no suites)
node scorer/test/mutation/run-mutations.mjs --verify

# one module, or one gate
node scorer/test/mutation/run-mutations.mjs --only RES-
node scorer/test/mutation/run-mutations.mjs --only EV-CONTENT-HASH

# which suite kills what (no short-circuit; slower, full attribution)
node scorer/test/mutation/run-mutations.mjs --full --out report.json

# measure ONE suite in isolation, e.g. the corpus checks against the engine
node scorer/test/mutation/run-mutations.mjs --only ENG- --suite corpus
```

Exit codes: `0` every mutant matched its declared expectation · `1` a mutant
declared `killed` survived, a mutant declared `survives-by-design` was killed,
or the catalogue drifted · `2` the unmutated baseline was not green (nothing
could be measured).

---

## How it works

1. The tree is copied to a scratch directory (`$SURVEYQA_MUTATION_SCRATCH`, or a
   `survey-qa-mutation` folder under the OS temp dir). `node_modules` is linked,
   not copied. **The working tree is never modified**, and `test-suite/blind/`
   is never read or copied.
2. The unmutated baseline runs first. If any enforcing suite is red, the run
   aborts — mutation results against a red baseline mean nothing.
3. For each mutant, one exact-string replacement is applied to one file, the
   target suites run, and the file is restored.
4. A mutant is **KILLED** when at least one *enforcing* suite exits non-zero.

### The kill criterion is deliberately conservative

A suite kills a mutant only when its **process exits non-zero**, because that is
the only signal CI acts on. `scorer/integration/verify-integration.mjs` prints
`RESULT: GAPS-FOUND` and then **exits 0 unconditionally** — it can never fail a
build. It is included as a *non-enforcing* suite: changes to its `RESULT` line
are reported as `detected`, never counted as kills. Counting golden-output
diffs as kills would inflate exactly the number this exercise exists to make
honest.

### Reproducibility

Mutants run in id order, one at a time, no concurrency; the scratch copy walks
directory entries sorted; child processes get a scrubbed environment
(`TZ=UTC`, `LANG=C`, `NO_COLOR=1`); the JSON report contains no timestamps and
no absolute paths. Two runs of the same tree produce the same report.

---

## The catalogue is data

`mutants.mjs` exports `{ catalogueVersion, mutants: [...] }`. Extend it by
adding an entry — never by editing the harness.

```js
{
  id: "EV-CONTENT-HASH",                       // stable; results are keyed on it
  file: "scorer/src/lib/evidence.mjs",
  gate: "artifact bytes must match the signed contentHash (not just the length)",
  find:    "      if (hash !== ev.contentHash || bytes.length !== ev.byteLength) {",
  replace: "      if (bytes.length !== ev.byteLength) {",
  expectation: "killed",
  rationale: "...",
}
```

`find` **must occur exactly once** in `file`. `--verify` enforces that on every
run, which makes the catalogue a test of its own: a gate that is renamed or
deleted shows up as *catalogue drift* instead of quietly ceasing to be measured.
**If a source change moves a `find` string, update `mutants.mjs` in the same
commit.**

Mutation kinds used: flip a comparison, weaken a floor, drop a guard,
early-return, off-by-one, swap `&&` for `||`.

### `expectation` has three values

| value | meaning |
|---|---|
| `killed` | a suite must catch this. A survivor fails the run. |
| `survives-by-design` | an **equivalent or fully-duplicated** mutation: removing it cannot change any outcome. Documented here rather than pinned by a test that would only freeze an implementation detail. Excluded from the in-scope denominator. A *kill* here fails the run — it means the reasoning was wrong. |
| `known-gap` | a **real** guard that nothing kills yet, with the specific blocker and the change that would close it. Counted against the net (it is in the in-scope denominator) but does not fail the run. If one starts being killed, the run says so — retire it to `killed`. |

Writing a test purely to kill a mutant is not the goal. Where a mutant survives
because the behaviour genuinely does not matter, say so in `rationale` and leave
it: an assertion that pins an implementation detail is worse than an honest gap.

---

## Suites

| suite | script | enforcing |
|---|---|---|
| `selftest` | `scorer/test/selftest.mjs` — 25 adversarial fixtures, JCS conformance vectors | yes |
| `calibration-pins` | `scorer/test/calibration-pins.mjs` — frozen profile objects + threshold boundary fixtures | yes |
| `gate-coverage` | `scorer/test/gate-coverage.mjs` — one negative case per gate this net exposed | yes |
| `oracle-selfcheck` | `scorer/oracle/selfcheck.mjs` — ground-truth reconciliation + byte-identical rebuild | yes |
| `oracle-records` | `scorer/oracle/validate-oracle-records.mjs` — schema + cross-reference validity | yes |
| `corpus` | `test-suite/branching/validate.mjs` — the 824 corpus checks | yes |
| `integration` | `scorer/integration/verify-integration.mjs` | **no** — always exits 0 |

---

## Results on the tree as of this writing

**Before** (the four pre-existing suites only): **59/130 killed — 45.4%**, which
independently reproduces the audit's ~45% figure.

**After** adding `calibration-pins.mjs` and `gate-coverage.mjs`:
**118/130 killed — 90.8%** overall, **94.4%** over in-scope mutants (125, after
excluding 5 documented equivalents). Every module in `scorer/src/lib/` kills
100% of its in-scope mutants.

### The corpus suite, measured on its own

The audit flagged the headline "824 checks" as completely unaudited. Measured
against 12 semantic mutations of `test-suite/branching/engine.js` — the system
those checks exist to validate — with **only** `validate.mjs` running:

**6/12 killed — 50%.** Survivors: `ENG-CARRY-FORWARD-EXCLUDE`,
`ENG-COND-AND-OR`, `ENG-EXCLUSIVE-OPTION`, `ENG-LOOP-EXCLUDE`, `ENG-NUMBER-MIN`,
`ENG-PIPE-UNRESOLVED-TOKEN` — i.e. carry-forward exclusion, compound-condition
semantics, exclusive-option validation, loop exclusion, numeric minimums, and
literal rendering of unresolved piping tokens are all silently mutable with 824
checks green.

All 12 die once `oracle-selfcheck` is in the run, because the ground-truth
rebuild is byte-identical and any engine change moves it. That is worth stating
plainly: **the ground-truth pipeline is currently a stronger net over the survey
engine than the corpus suite that is cited as testing it.** Closing the gap
means adding behavioural assertions to `test-suite/branching/validate.mjs`,
which is outside this directory's remit.

---

## What to do when the fix round lands

The audit's point is that the constants being revised had no regression net.
They do now, in `scorer/test/calibration-pins.mjs`, which pins the **whole**
frozen profile object — not just the version string — and brackets every
threshold with a fixture either side.

So a calibration change is now a three-part, visible act:

1. change the constant in `scorer/src/lib/...`;
2. update the pinned literal in `calibration-pins.mjs`;
3. **bump the profile's version string in the same commit** — it lives inside
   the pinned literal, so a value change with a stale version fails by
   construction.

And run `run-mutations.mjs` before and after: a fix that changes no mutation
outcome has not been verified by this suite.
