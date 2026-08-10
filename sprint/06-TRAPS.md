# Traps — read before writing a single check

Your own words for this project's failure mode:

> *"Twelve cannot-fail artifacts in two days mean the development process is producing evidence-shaped objects
> instead of evidence."*

Every one below was found by **running the system** or by a **mutation harness**. None was caught by the test
suite, which was green throughout.

## The twelve

1. A **340/340 green suite** shipped a crash that killed every run in 1 second. Production hands the workflow a
   **JSRPC stub**, where property access is resolved as a *remote method name* — so `step.do.bind(step)` asks the
   far side for a method called `bind`. The test double is a plain object where `.bind` works fine. **Never
   `.bind` / `.call` / `.apply` on a platform binding, and never hold a detached method reference.**
2. The **mutation harness could not mutate `.mjs` at all** (esbuild filter was `/\.ts$/`), so the deterministic
   aggregator — the most safety-critical module — was never mutation-tested, and the harness printed "survived"
   instead of erroring. **Every past `.mjs` mutation claim was fictional.** Fixed; a never-loaded target now
   raises BROKEN-ANCHOR.
3. A fleet **leak check reported "no leaks" over an empty denominator** — its guard skipped every target under
   the exact commands you would use to audit a deployed fleet.
4. A reader-mutation scorer read a **browser crash as "mutant survived"** — no verdict line was parsed as zero
   failures.
5. A report test used `!/programming problem\b/i`; **`\b` does not match between "problem" and "s"**, so a lane
   headed *"0 programming problems"* sailed past a no-defects assertion.
6. A boundary test typed the **literal string `<exactly 500 characters>`** — 24 characters — into a 500-char
   limit field. The field accepted it. The check reported **PASS**.
7. Two agents caught **their own new tests passing whether or not the guard under test ran**.
8. **`claims: []` was hardcoded** while the deriving code sat unused — so the first record ever to contain real
   defects is Ed25519-signed with zero claims. The signature verifies, permanently, over a statement
   structurally unable to contain a failure.
9. **`coversAllObligations: true`** on a run where 27 requirements had every case unassigned.
10. **Observation counts that RISE when nothing happens** — a walk stalled on screen 2 reported 38 observations
    (one payload fanned across 38 case ids) and was reported upward as a success. Twice.
11. **`no-advance-control`** meant *both* "the survey completed normally" *and* "we never got in" — one enum
    value covering a survey finished 38 times and four surveys never entered.
12. The **navigator answered "What is your age?" with `1`** — the lowest legal value — and got screened out. A
    whole class: *defaults pick extremes, and extremes are where surveys terminate.* The radio `first-option`
    default has the identical defect and is **still unfixed**.

## What they share

Every check was written by the entity that benefits from it passing. The proxy was accepted without proving the
causal behaviour.

## The four practices that actually worked

1. **Mutation-prove every check.** `tools/mutate-runner.mjs` is baseline-aware, requires a *specifically named*
   guard test to fail, and self-checks against a deliberately RED baseline. A check with no mutant is a claim,
   not evidence.
2. **Negative controls, always.** "It found the defect" is meaningless without "and it stayed silent on the
   clean twin". The paired corpus exists for exactly this.
3. **Ask of every metric: what does this read when the work does not happen?** If the answer is "the same, or
   higher", the metric is worthless. That question alone would have caught #3, #9 and #10.
4. **Assume your first test is broken until a mutation proves otherwise.** Multiple agents wrote a test, ran the
   mutant, found it survived, and discovered their own test could not fail. That is the loop working.

## Sprint-specific hazards

- **A "passing" frozen-contract test that never carries the contract's content into the decision** would be
  instance #13. Prove it by sealing a *deliberately wrong* requirement and showing a *different, wrong* verdict.
- **A defect planted but unreachable** counts as a miss and looks like a predicate failure. Verify reach locally
  before counting it planted.
- **`insufficient` is not failure — except against the ≤4 threshold.** Read reason codes, never bare counts.
- **Do not read the defect manifest until results are in.**
- **Do not move the thresholds after seeing results.**

## Where the orchestrator was wrong, so you can discount its framing

Sub-agents corrected the orchestrating model's diagnosis **four times in two days**, and each time the agent was
right:

- "The driver doesn't fill numeric inputs" → it did; it filled them with the *lowest legal value*.
- "Sign the record after the judgement closes" → impossible; the judgement binds to the record's own hash. The
  real fix was a *superseding* revision.
- "The verifier's terminal discrimination is dead code" → it reads the artifact, not the payload; what was dead
  was record-side visibility.
- "The verifier is blind where the driver binds" → the worse direction was the opposite: the verifier was the
  *more permissive* half and could decide off a screen the walker had refused.

**Trust the artifacts over any narrative in these files, including this one.**
