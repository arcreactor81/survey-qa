# Binder notes — binding a screen to its question

Working notes for the change that lets `verify-observations.ts` identify which sealed question
a captured screen IS, so a run can produce verdicts instead of exiting `insufficient` at
binding on every route and boundary case.

## The null run, confirmed by hand (8 Aug)

`tokenOnScreen` (the only screen-identity primitive) read three fields:

```ts
const haystack = norm(`${screen.questionText ?? ""} ${screen.title ?? ""} ${screen.visibleText ?? ""}`);
```

— i.e. **rendered text only**. On the t1-easy test survey those three fields never contain a
question id:

- `test-suite/blind/t1-easy/site/survey.js:449` renders `'<h1>' + esc(page.heading) + '</h1>'`
  and the page bodies carry `text:` prose ("Which of these ways of making coffee at home…").
  The `id:` field (`'Q1'`, `'Q5'`, …) is never printed.
- Consequence: `tokenOnScreen(screen, 'Q7')` is **false on every screen of the survey**, so
  `stepsOnTargetQuestion` returns `[]`, `selectCaseStep` returns
  `STEP_NOT_BOUND_TO_TARGET_QUESTION`, and the route/boundary predicates never reach an
  outcome. Zero verdicts. The destination half fails for the same reason.

## The ids are already captured — in the markup, not the text

`browser/page-script.ts:122-123` records `name` and `id` for every control, and `types.ts`
carries them through to `ControlState`. The test survey emits:

| survey.js | rendered attribute | resolves to |
|---|---|---|
| `:367` | `name="Q1"`, `id="Q1_3"` | exact `name` → `Q1` |
| `:427,433` | `name="Q9"`, `id="Q9_0"` / `Q9_dk"` | exact `name` → `Q9` |
| `:470` | `name="Q8"`, `id="Q8_txt"` | exact `name` → `Q8` |
| `:397` (grid) | `name="Q5_r1"`, `id="Q5_r1_1"` | no exact `name`; `id` prefix → `Q5` |
| `:412` (grid, stacked) | `name="Q5m_r1"`, `id="Q5m_r1_1"` | `Q5m` is not sealed → contributes nothing |
| `:373` (specify) | `id="Q1_3_txt"` | `id` prefix → `Q1` |

So the grid needs the `id`-prefix fallback; everything else binds on exact `name`.

## The rule implemented

Screen identity is now the **union** of two independent readings of the SAME re-read artifact:

1. sealed ids present in rendered text (unchanged `tokenOnScreen`);
2. sealed ids named by the screen's controls — per control, exact `name` first, else the
   `id` prefix before the first separator.

A screen "is" a question only when that union has **exactly one** member. Union, not
precedence: the union is the multi-question detector, and per-screen precedence (e.g. "if any
exact `name` matched, ignore ids") would hide a second question whose control happened to carry
a mangled name. Precedence is applied **per control** only, which is what keeps a sealed id
that itself contains a separator (`Q5_1`) from being shadowed by its own prefix (`Q5`).

Equivalence check: with `controls: []` the union reduces to the old rule exactly
(`present == {target}` ⟺ `tokenOnScreen(target) ∧ no other sealed id`). Every D19 fixture
builds screens with `controls: []`, so an unchanged D19 suite is the proof of that invariant.

## The assumption, stated (CLAUDE.md: no silent reliance on a convention)

**"A control's `name` is the sealed question id" is a convention of the surveys we have, not a
property of surveys.** A real platform may emit `QID12_4`, a GUID, a framework-mangled
`ctl00$body$Q7`, or no `name` at all. This change makes the test survey **measurable**; it does
not make the system general.

Degradation when it does not hold: the control reading contributes nothing, the union falls back
to text, and — for a survey that prints no ids either — the union is empty, so the case is
**refused** with the existing named reasons (`STEP_NOT_BOUND_TO_TARGET_QUESTION`,
`DESTINATION_NOT_IDENTIFIABLE`) which are already counted in the run's reason histogram. Never a
wrong bind. The `detail` lines now say identity was sought in BOTH places, so "we could not
identify the screen" is distinguishable from "we never looked at the markup".

## Fail-closed, preserved and extended

- >1 distinct sealed id on `screenBefore` → the step does not qualify (unchanged shape).
- >1 distinct sealed id on the reached screen, with the expected one among them →
  `DESTINATION_AMBIGUOUS` (unchanged).
- **New:** the expected id absent and >1 other sealed id present → `DESTINATION_AMBIGUOUS`
  rather than a `violated` naming an arbitrary `alsoPresent[0]`. Claiming a routing defect
  requires knowing WHICH screen was reached; with two candidates that is a guess, and rule 3
  forbids a verdict there. Checked first: every existing mismatch fixture (D15 ×2, D16, D19)
  reaches a screen presenting exactly ONE other id, so this strengthening moves no existing test.

## Baseline

`node tools/test.mjs` → **222/222** before the change (the brief's 217 predates the D23
payload-trust tests landing at 03:12). `tsc --noEmit` clean.

## Collisions

`verify-observations.ts` mtime 03:09 and `tools/test.mjs` 03:12 on 8 Aug — another agent is
live in this file's predicates. Mitigations: (a) all edits are exact-match `Edit` calls, which
fail rather than clobber on drift; (b) the new tests live in a NEW file
(`tools/tests/d24-screen-identity.test.mjs`) with a one-line append to `tools/test.mjs`, rather
than editing `d19-route-binding.test.mjs` which the predicate agent may hold.

`tools/mutate-verifier.mjs` pins the `DESTINATION_NOT_IDENTIFIABLE` return as an exact-string
`find`. Enriching that detail breaks the mutant, so the mutant's `find` is updated in the same
change and `node tools/mutate-verifier.mjs` re-run as the proof it still kills what it claims.

**COLLISION (03:28, 8 Aug) — not mine, not fought.** `pipeline/judge/lib/compile.mjs` gained a
SECOND `const SCREEN_TOKEN` at line 745, colliding with the one at line 150:

```
SyntaxError: Identifier 'SCREEN_TOKEN' has already been declared
    file:///E:/survey-qa/pipeline/judge/lib/compile.mjs:745
```

`tools/test.mjs` imports every test file up front, and `seam` / `d1-acceptance` pull in the
pipeline, so this blocks the WHOLE worker-v2 suite regardless of filter. It is another agent's
in-flight edit in a file this task does not own; the suite was 222/222 with every change in this
note already applied minutes before it appeared. Not edited, reported.

## Evidence the D24 tests can fail

`node tools/test.mjs` is not proof a new test would notice a regression, and CLAUDE.md names
that exact failure ("beware the check that cannot fail"). Six mutants were run through the
existing `tools/mutate-runner.mjs` (baseline-aware, no-op self-checked, nothing written to
`src/**`), from a SCRATCH script rather than a new committed harness — the brief asked for
confirmation, not apparatus:

| mutant | must kill |
|---|---|
| identity reads rendered text alone again | the 3 positive binds |
| only the ORIGIN wired; destination reads text | "THE ONE THAT MATTERS" + "A REAL MISMATCH" |
| singleton rule relaxed to `present.includes(target)` | FAIL-CLOSED, ORIGIN (two ids) |
| the new `alsoPresent.length > 1` refusal removed | FAIL-CLOSED, DESTINATION (two others) |
| the `id`-prefix fallback removed | THE GRID SHAPE |
| the limitation detail stops naming where it looked | the GUID degradation test |

The second one is the brief's own warning made executable: partial wiring reproduces the null
result, and a test suite that stays green under it would be measuring nothing.

**Result: 6/6 killed**, each by its named guard, over a clean 233/233 baseline and after the
runner's two self-checks (a no-op scores NOT killed; a mutation over a deliberately red baseline
scores NOT killed). The origin-only mutant is killed by "THE ONE THAT MATTERS", "THE GRID SHAPE",
"A REAL MISMATCH IS STILL CLAIMABLE" and both destination fail-closed tests — i.e. the suite does
distinguish "the origin binds" from "the run reaches a verdict".

`node tools/mutate-verifier.mjs` re-run after its anchor was updated: **14/14 killed**, unchanged.
Two of its mutants are now additionally witnessed by D24 tests, which is the seam working.

## Result

`node tools/test.mjs` → **233/233** (222 pre-existing + 11 new). `tsc --noEmit` clean.

## What this does NOT do

- It does not make the system general. It makes ONE instrument measurable. A run against a real
  Decipher / Qualtrics / SurveyJS link will still bind nothing unless that platform happens to
  name its controls after the document's ids, and the two degradation tests fix that outcome in
  place as a REFUSAL so the failure is legible in the reason histogram rather than absent.
- The general fix is matching a screen to a question by CONTENT from the document's side — the
  model verifier's job, still unwired (`WORKERSAI_ENABLED` is false).
- `tokenOnScreen`'s original caveat is untouched and still open: a screen that pipes the id of
  interest while never printing or naming its own is indistinguishable from that screen.
- Nothing outside identity/binding was touched — the route and boundary PREDICATE logic, the
  boundary outcome inference and `structuralDecision` are byte-identical.

## Residuals, named rather than fixed

**Nested sealed ids under the prefix rule.** If a document ever seals BOTH `Q5` and `Q5_1` as
distinct questions, a control with a mangled `name` and `id="Q5_1_3"` resolves by prefix to
`Q5` — so a screen that is really `Q5_1` could bind a case about `Q5`. That is a wrong bind,
not a named refusal, and it is the one place this change could produce one. It cannot fire on
the current vocabulary (no sealed id is a separator-boundary prefix of another; `Q12_x` splits
to `Q12`, never `Q1`), and the union catches it whenever the longer id surfaces by any other
reading — exact `name`, or the text. Longest-match/multi-match resolution would close it, and
is deliberately NOT implemented: there is no corpus that can exercise it, so the code would
ship untested and the fix would be guesswork about a platform nobody has seen.

**These fixtures are shaped like the survey; they are not the survey.** The screens above were
derived by reading `test-suite/blind/t1-easy/site/survey.js`, not from a captured artifact of a
real pipeline run. "The binder binds fixtures shaped like the survey" and "a run against the
survey produces verdicts" are different claims. Only a live run settles the second, and this
task was scoped to the binder with no deploy — so it is a handoff, not a gap.
