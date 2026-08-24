# Forward scan of the unexplored remainder

**What this is.** A read-only scout report. The live walk currently stops at screen 75 of the
Confirmit instrument (the site's own progress bar reads about 20%). Everything past that point had
never been looked at. This document turns that remainder into a named work-list, so each wall the
walk hits next costs minutes of diagnosis instead of a whole iteration.

**Method.** Three sources, no live traffic:

1. The team's own questionnaire, `\.local-private\team-reference-63a45b98\questionnaire.docx`
   (168 paragraphs, 37 tables, extracted with python-docx).
2. The sealed contract `\.local-private\v80-contract.json` (452 requirements, 429 facet instances)
   — used to corroborate the document reading and to measure how much is riding on each question.
3. The walker's proven capability set, from
   `worker-v2\tools\tests\d56-walker-first-real-walk-fixes.test.mjs` (amendments 1–12) and
   `docs\LOOP-RUNBOOK.md` §"Lessons already paid for".

**What I did not do.** No source was edited, nothing was deployed, the live survey was not touched,
and nothing under `test-suite/blind/` was opened.

**The honesty caveat that governs every rating below.** The runbook's own warning applies
(`LOOP-RUNBOOK.md:180-186`): *"gates green does not mean wall falls … B10 was three stacked defects
… each was invisible until the previous one fell"*. So GREEN here means **"this exact shape has
already passed on the live link"**, not "a fixture covers it". Anything proved only by a test
fixture is rated AMBER at best. A scan cannot promise a screen will pass; it can only say where to
look first.

---

## 1. Where the walk stands, and what the wall probably is

The walk has cleared: consent, the whole S-screener, A10 through A30b, B10, B20, and the two
section intro screens the walk record calls `iSecC` and `iSecTPP`. It stops at a page the record
calls `hAttC20x1` through `hAttC20x4` — four question roots on one page.

**Those four names appear nowhere in this repository.** A search across all source, test and
document files found no match for `hAtt`, `iSecC` or `iSecTPP`. They exist only in the live walk
record. So what follows is inference from the naming, clearly labelled as such — not fact.

**Most likely reading.** In Confirmit, a leading `h` conventionally marks a hidden question, and
`Att` reads as *attribute*. `hAttC20x1..x4` then means *four hidden attribute carriers for C20*,
one per repeat — the questions that hold the experimental-design assignment for C20's four screens.
The document supports the count exactly: line 426 reads `[REPEAT C20 4 TIMES AS PER THE
EXPERIMENTAL DESIGNS FILE]`, and the contract carries the matching sealed requirement *"C20 must be
repeated 4 times as specified by the experimental designs file, across a total of 4 screens shown
sequentially."*

If that reading is right, the failure is precise and already has a named refusal in the code. Four
question roots on one page, none of them carrying a fillable respondent control, is exactly the
case amendment 12's counterproof pins as still refusing:
`"counterproof: roots without scoped control indexes keep the hard refusal"`
(`d56-walker-first-real-walk-fixes.test.mjs:2174`), refusing with
`MULTI_QUESTION_ACTUATION_UNSUPPORTED` (`driver.ts:4093`). Amendment 12 taught the walker to
traverse a multi-question page **per root**; it did not teach it that a root with no respondent
control of its own is a page to walk past rather than a page to refuse.

**Competing reading.** These could be four visible sub-questions of a genuine conjoint screen. The
document's C20 table (Table 30) renders as radio circles, not hidden fields, so this cannot be
dismissed.

**The diagnostic that separates them, from the existing walk artifact — no new run needed.** Read
the screen record for step 75 and check the control inventory for those four roots. Zero
respondent controls across all four roots confirms the hidden-carrier reading. Controls present
confirms the visible-conjoint reading. The relevant reader fields are `questionRoots[].controlIdxs`
from `COLLAPSE_QUESTION_ROOTS_SRC` (`page-script.ts:354`) and `isRespondentControl`
(`page-script.ts:779-809`).

**One more oddity worth flagging, not resolving.** The document orders C10 before C20, but the walk
reached a C20-named page without a recorded C10. Either the live instrument front-loads C20's design
carriers before C10 is asked, or C10 is still ahead. Both are consistent with the hidden-carrier
reading; neither is proven.

### A note on "20%"

Roughly 29 document pages sit behind the walk, yet the walk counter reads 75 and the site's bar
reads about 20%. Those three numbers do not reconcile as a plain page count. The walk counter runs
at roughly two and a half steps per document page, which is what per-root traversal and recovery
half-steps would produce. **Do not read "20%" as "38 screens is 80% of the work."** The document
implies about 38 more distinct pages; at the observed step ratio that is plausibly 90 to 100 more
walk steps. Twenty of those 38 pages are repeats of five questions. Budget accordingly.

---

## 2. The screen table

Document order, from the current wall to the end. Row 0 is the wall itself; rows 1–38 are the
unexplored remainder. "Riding on it" is the count of sealed facet instances the contract targets at
that question — a measure of how much verification work the screen carries.

| # | Question id | Question text (opening words) | Widget shape the document implies | Stated validation | Risk |
|---|---|---|---|---|---|
| 0 | `hAttC20x1`–`x4` (live name; no document id) | none shown — four question roots on one page | **Ambiguous.** Hidden design carriers, or a visible conjoint screen. See §1. | none stated | **RED** |
| 1 | Section C TPP, "SCENARIO 1 OUT OF 2" | *"We will now show you 2 profile variations of a hypothetical…"* | Info screen with a large product-profile table | none | AMBER |
| 2 | **C10** (repeat 1 of 2) | *"Based on the new product information you reviewed, what proportion of each…"* | Allocation, sum to 100, with an "Others (Please Specify___)" cell | Must sum to 100%; **C10_1 ≤ B10_1**; **C10_2 ≤ B10_2**; rows randomized; a piped read-only "Current scenario" column from B10; hyperlink to view the profile | **RED** |
| 3 | Section C TPP, "SCENARIO 2 OUT OF 2" | *"We will now show you 2 profile variations of a hypothetical…"* | Info screen with a large product-profile table | none | AMBER |
| 4 | **C10** (repeat 2 of 2) | as row 2 | Allocation, sum to 100, specify cell | as row 2 | **RED** |
| 5 | INTRO TEXT 2 | *"You will now be presented with 3 varying profiles of Product X…"* | Info screen, plain text | announces "a total of 4 screens" | GREEN |
| 6 | **C20** screen 1 of 4 | *"Based on the product profiles you just reviewed, please indicate the best and worst…"* | Best/worst radio grid: 2 rows (Best, Worst) × 3 columns (Profile Variation 1/2/3), plus 3 profile tables | **15-second dwell gate**; screen counter "SCREEN [# of 4]"; Best and Worst cannot both be the same profile | **RED** |
| 7 | **C20** screen 2 of 4 | as row 6 | as row 6 | as row 6 | **RED** |
| 8 | **C20** screen 3 of 4 | as row 6 | as row 6 | as row 6 | **RED** |
| 9 | **C20** screen 4 of 4 | as row 6 | as row 6 | as row 6 | **RED** |
| 10 | **C30** | *"To what extent would superior immune responses on a subset of serotypes influence…"* | Single choice, 5-point scale, one row | one answer required | GREEN |
| 11 | **C40** | *"To what extent would inferior immune responses on a subset of serotypes influence…"* | Single choice, 5-point scale, one row | one answer required | GREEN |
| 12 | INTRO TEXT 3 (Section D) | *"We will now show you 4 profile variations of hypothetical pneumococcal vaccines…"* | Info screen, plain text | none | GREEN |
| 13 | Section D TPP, "SCENARIO 1 OUT OF 4" | product profile set for Products X, Y and Z | Info screen with a large profile table | none | AMBER |
| 14 | **D10** (repeat 1 of 4) | *"Based on the new product information you reviewed, what proportion of each…"* | Allocation, sum to 100, six rows, "Others (Please Specify___)" cell | Must sum to 100%; **D10_1 ≤ C10_1**; **D10_2 ≤ C10_2**; **D10_3 ≤ C10_3**; rows randomized; piped read-only "Previous scenario" column from C10 | **RED** |
| 15 | Section D TPP, "SCENARIO 2 OUT OF 4" | as row 13 | Info screen with profile table | none | AMBER |
| 16 | **D10** (repeat 2 of 4) | as row 14 | as row 14 | as row 14 | **RED** |
| 17 | Section D TPP, "SCENARIO 3 OUT OF 4" | as row 13 | Info screen with profile table | none | AMBER |
| 18 | **D10** (repeat 3 of 4) | as row 14 | as row 14 | as row 14 | **RED** |
| 19 | Section D TPP, "SCENARIO 4 OUT OF 4" | as row 13 | Info screen with profile table | none | AMBER |
| 20 | **D10** (repeat 4 of 4) | as row 14 | as row 14 | as row 14 | **RED** |
| 21 | INTRO TEXT 4 | *"We will now show you variations of Product X, Product Y and Product Z."* | Info screen, plain text | none | GREEN |
| 22 | D20/D30 profile set 1 of 2 | best/worst profile set for Products X, Y, Z | Info screen with profile table — **may not be its own page**, see §3.6 | order randomized | AMBER |
| 23 | **D20** (set 1 of 2) | *"How likely are you to stock Product X, Product Y and Product Z for pediatric…"* | Grid: 3 rows (Product X/Y/Z) × 5-point scale | "Select one option per row" — one answer required per row; hyperlink to view the profile set | AMBER |
| 24 | **D30** (set 1 of 2) | *"Now, please rate the overall benefits versus the risks of Product X, Product Y…"* | Grid: 3 rows × 5-point scale | one answer required per row; hyperlink to view the profile set | AMBER |
| 25 | D20/D30 profile set 2 of 2 | as row 22 | Info screen with profile table | order randomized | AMBER |
| 26 | **D20** (set 2 of 2) | as row 23 | as row 23 | as row 23 | AMBER |
| 27 | **D30** (set 2 of 2) | as row 24 | as row 24 | as row 24 | AMBER |
| 28 | INTRO TEXT 5 | *"We will now show you a few other profiles of hypothetical pneumococcal vaccines…"* | Info screen, plain text | none | GREEN |
| 29 | D40 lead-in | *"You will now be presented with 3 profiles, each slightly varying in clinical endpoints."* | Info screen, plain text | announces "a total of 8 screens" | GREEN |
| 30 | **D40** screen 1 of 8 | *"Based on the product profiles you just reviewed, please indicate the best and worst…"* | Best/worst radio grid: 2 rows × 3 columns, plus 3 profile tables | **15-second dwell gate**; screen counter "SCREEN [# of 8]"; Best and Worst cannot both be the same profile | **RED** |
| 31 | **D40** screen 2 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 32 | **D40** screen 3 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 33 | **D40** screen 4 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 34 | **D40** screen 5 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 35 | **D40** screen 6 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 36 | **D40** screen 7 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 37 | **D40** screen 8 of 8 | as row 30 | as row 30 | as row 30 | **RED** |
| 38 | Completion page | *"Thank you for completing the survey!"* | Info screen, no controls, no forward button | none | AMBER |

**Tally: 7 GREEN, 13 AMBER, 19 RED, across 39 rows.**

Contract weight on the unexplored questions: D10 carries 19 facet instances, C10 carries 17,
D20 carries 15, D30 carries 10, C20 carries 8, D40 carries 7, C40 carries 3, C30 carries 2.
The two allocation questions and the two rating grids are where the verification value sits;
C20 and D40 are where the walk risk sits.

---

## 3. Class-fix sketches for every AMBER and RED

Written in the codebase's own idiom, naming the amendment each one extends.

### 3.1 RED — row 0: the current wall, question roots with no respondent control

*Extends amendment 12 ("multi-question screens traverse per root instead of ending the walk").*

Amendment 12 gave each question root its own scoped control indexes and its own navigator
defaults, and its counterproof deliberately kept the hard refusal for roots that have no scoped
control indexes at all (`d56-walker-first-real-walk-fixes.test.mjs:2174`). That counterproof is
correct as written — a root with controls the reader cannot scope must not be guessed at. But it
does not distinguish that case from a root that has **no controls because there is nothing to
answer**.

The fix is in `applyAcrossQuestionRoots` (`driver.ts:3908`): before refusing with
`MULTI_QUESTION_ACTUATION_UNSUPPORTED` (`driver.ts:4093`), separate the two cases. A root whose
`controlIdxs` is empty **and** which the reader found no respondent control under
(`isRespondentControl`, `page-script.ts:779-809`) is a display-only root, not an unscoped one. If
every root on the page is display-only and a forward control resolves
(`resolveAdvanceControl`, `driver.ts:3963`), the page is a walk-past, not a refusal.

Guard rails the North Star requires here: the assumption ("a page whose every question root
carries no respondent control is a display page") must be stated in code, and the walk-past must be
**counted and reported**, not silent — otherwise a page whose controls the reader simply failed to
see becomes an invisible skip. Ship it with a mutation or a negative fixture: a page with four
roots where one root does have a control must still refuse rather than walk past.

Confirm the diagnosis from the existing step-75 artifact first (§1). If the roots turn out to carry
visible controls, this fix is the wrong one and row 0 collapses into §3.3.

### 3.2 RED — rows 6–9 and 30–37: the 15-second dwell gate on C20 and D40

**This is the largest single block of risk: 12 screens, and no timing capability exists anywhere in
the walker.**

The document states it twice, identically, at lines 424 and 526:
`[IF RESPONDENT TRIES TO CONTINUE TO THE NEXT SCREEN BEFORE 15 SECONDS, SHOW ERROR STATEMENT:
"Please review the profiles carefully before proceeding"]`. The contract carries it as a sealed
browser-observable validation requirement for both C20 and D40.

The walker will submit in well under 15 seconds, and amendment 11 ("a rejected submit never reads
as an advance") will correctly refuse to call the re-render an advance. That part works. What
happens next is the problem: the recovery loop (`walkPath`, `driver.ts:4531`, recovery rounds
around `:5177-5380`) re-derives the answer from the newest validation message. **Re-deriving cannot
help.** The answer was already valid; only elapsed time clears this gate. So the walker burns its
three bounded recovery rounds re-entering a correct answer and then blocks — and `whyBlocked`
(`driver.ts:4171`) will report a validation message that looks like an answer problem and is not.
That mis-signal is worse than the block itself, because it will send the next iteration hunting the
wrong class.

*Extends amendment 4 ("a validation rejection overrides the already-answered skip on recovery") and
amendment 8 ("a blocked set-value recovery gets one keyboard-flip round").* Amendment 8 is the
closer precedent: it established that when a recovery is blocked, the walker gets **one extra
bounded round using a different mechanism**, folded into the same half-step. A dwell round is the
same pattern with time as the mechanism instead of the keyboard.

Sketch: in the recovery ladder, add a bounded dwell round that fires on a narrow, named condition —
the newly-arrived validation message (`newValidationMessages`, `driver.ts:4149`) repeats
unchanged, no control-level demand can be derived from it, and the answer state is unchanged since
the previous submit. On that condition, wait once, then re-press the forward control. One round
only, folded into the existing half-step per the runbook's ordinal rule
(`LOOP-RUNBOOK.md:174`).

Generalizability, which matters more than the fix: **do not hard-code 15 seconds, and do not
hard-code that message.** Fifteen seconds is this questionnaire's number and that sentence is this
questionnaire's wording; both fail the North Star test immediately. The honest shape is a
*time-gated advance* class — "the site rejected a submit and named no answerable demand" — with a
configured dwell bound that is declared as an assumption, detected when it does not hold (the same
message arrives again after the dwell), and degraded to a named, reported limitation rather than an
unbounded retry. Note this also costs real wall-clock time: 12 screens × 15 seconds is three
minutes of pure waiting, which must come out of `EXEC_PER_CASE_TIMEOUT_MS` (1,800,000 ms) — ample,
but it should be a deliberate spend, not a surprise.

### 3.3 RED — rows 6–9 and 30–37: the best/worst grid itself

Separate from the dwell gate, and worth pre-checking independently.

The survey outline (Table 2) labels C20 and D40 as **"Ranking"**, and the contract seals that
wording: *"Question C20 uses the response format 'Ranking'"*. But the response tables (Table 30 for
C20, Table 37 for D40) render as radio circles — 2 rows (Best, Worst) × 3 columns (Profile
Variation 1/2/3) — and the contract seals that too, cell by cell.

**This is a genuine ambiguity in the document and it decides the rating.** If the live site renders
radio circles, this is a small grid and close to conquered. If the word "Ranking" means the
programmer built a drag-to-order widget, it is flatly unsupported today: `page-script.ts:726`
refuses drag and sortable widgets with `drag-widget-actuation-unsupported` — *"this reader cannot
yet certify their semantic source/target relation or post-drag order; they are recorded as
unfillable, not moved"*. **Check which one it is before writing any fix.** The evidence favours
radios, but a scan cannot settle it.

Assuming radios, two twists remain:

- **Best and Worst cannot be the same profile.** The grid pass (`driver.ts:3154-3190`, emitting
  `kind:"select-grid-cell"`) picks a column per row with no cross-row awareness. If it picks the
  same column for both rows, the site rejects. *Extends amendment 12's per-root defaults* — the
  same idea one level down: a per-row default that is aware of what sibling rows already took.
  State the assumption ("a two-row best/worst grid forbids the same column twice"), detect it from
  the rejection rather than presuming it, and report it when it does not hold.
- **Grid classification must actually fire.** `CLASSIFY_TABLE_GRID_SRC` (`page-script.ts:264`)
  only accepts `'distinct-native-radio-row-groups'`. Two rows of three radios each should qualify,
  but if the profile tables and the answer grid are one table, it may hit
  `'mixed-or-checkbox-table-choice-semantics-unresolved'` (`page-script.ts:283`) and be dropped
  with a limitation instead. Check the reader output on the first C20 screen before trusting it.

### 3.4 RED — rows 2, 4, 14, 16, 18, 20: allocation under a carry-forward ceiling (C10, D10)

The allocation shape itself is conquered and proven live: B10 passed, and amendments 7, 8 and 10
cover multi-cell allocation, the keyboard mechanism flip, and clearing the "Others (Please
Specify)" text cell rather than allocating into it. **What is new is the ceiling.**

C10 must satisfy `C10_1 ≤ B10_1` and `C10_2 ≤ B10_2`. D10 must satisfy `D10_1 ≤ C10_1`,
`D10_2 ≤ C10_2` and `D10_3 ≤ C10_3`. All five are sealed in the contract as entailed,
browser-observable validation requirements.

**Why today's derivation breaks it.** `allocationValues` (`driver.ts:2428`) recovers a multi-cell
allocation as 100/0/0 — amendment 7's measured shape, `"three numeric cells recover as 100/0/0,
never 1/1/1"`. That puts 100 in the first cell. At C10 the first constrained row is PCV15, and
`C10_1 ≤ B10_1` will fail for any B10 answer that gave PCV15 less than 100. This is not a
hypothetical: it is the default behaviour meeting a stated constraint head-on.

**Why the fix is cheap.** The ceiling's inputs are *displayed on the screen*. C10 has a piped
read-only "Current scenario" column carrying the B10 answers; D10 has a piped "Previous scenario"
column carrying the C10 answers. The contract seals both as carry-forward requirements. So the
walker needs **no cross-screen memory** — it can read the ceiling off the row it is filling.

Simpler still: the constraints only bind the *carried-forward* rows. C10 constrains rows 1 and 2
(PCV15, PCV20) but not Product X or Others; D10 constrains rows 1, 2 and 3 (PCV15, PCV20,
Product X) but not Product Y, Product Z or Others. **Putting zero in every row that has a piped
ceiling and the full 100 in an unconstrained row satisfies every stated constraint at once**, and
still sums to 100.

*Extends amendment 7 and amendment 10, in `allocationValues` (`driver.ts:2428`) with the repair in
`exactLatticeRepair` (`driver.ts:2588`).* Generalized honestly, the class is: *an allocation row
that displays a carried-forward prior value is capped by it; prefer to place mass on rows that
display no such cap.* State the assumption, detect the cap from the row's own piped cell rather
than from question ids, and if no uncapped row exists, degrade to a reported limitation rather than
guessing.

**Two more twists on the same screens.** Rows are randomized (`[RANDOMIZE]` in the document,
sealed for D10 as *"The D10 vaccine list must be randomized"*), so **the cap must be matched by row
label, never by row position** — position is not stable across the repeats. And a hyperlink to view
the profile sits on the screen; it should classify as `other` in
`CLASSIFY_CONTROL_ROLE_SRC` (`page-script.ts:206`) and never be pressed as a forward control, but
that is worth confirming rather than assuming.

**One ambiguity, named.** The document writes these as `[C10_1 SHOULD BE LESS THAN OR EQUAL TO
B10_1]` — a programmer instruction. Whether the live site enforces it as a hard block, a soft
warning, or not at all is **unknown from the document**. If it is soft, these six screens drop to
AMBER. Read the first C10 rejection before building anything.

### 3.5 AMBER — rows 1, 3, 13, 15, 17, 19: profile display screens with no answerable control

Six screens whose whole content is a product-profile table and a forward button. Three twists:

- **The ending classifier.** `classifyEnding` (`driver.ts:4339`) has a structural arm that fires on
  a page with zero question controls — pinned by
  `"classifyEnding structural arm fires on a terminal page with zero question controls"`
  (`d56-walker-first-real-walk-fixes.test.mjs:955`). A mid-survey display page is exactly zero
  question controls. The walk already survived `iSecC` and `iSecTPP`, which are also control-free,
  so the arm evidently also requires no forward control — good precedent. But these pages are much
  larger and carry a table, so confirm rather than assume. A false ending here would report a
  completed or screened-out walk that in truth stopped two thirds of the way through — a wrong
  answer presented confidently, which the standing rules call a failure even if the walk looked fine.
- **The table classifier.** `CLASSIFY_TABLE_GRID_SRC` (`page-script.ts:264`) will inspect the
  profile table. With no native choice controls in it, it should land on `'no-native-choice-controls'`
  (`page-script.ts:277`) and be treated as content. Confirm.
- **The scenario counter.** These pages say "SCENARIO 1 OUT OF 2" / "SCENARIO 1 OUT OF 4" — see
  §3.7, which is why that matters.

### 3.6 AMBER — rows 22–27: the D20/D30 rating grids and their profile sets

D20 and D30 are 3 rows (Product X, Y, Z) × a 5-point scale, one answer required per row — the
cleanest shape in the whole remainder. The grid pass (`driver.ts:3154-3190`) should handle them.
They are AMBER only because **a per-row radio grid has not yet been proven on the live link**;
everything the walk has passed so far has been single-row. Sanity-check the reader output on D20
before trusting D30 and the second repeat.

Two things to pre-check:

- **Does grid classification fire?** As in §3.3, `'distinct-native-radio-row-groups'`
  (`page-script.ts:306`) is the only accepted shape. If it fails, watch for
  `grid-cell-label-contradiction` (`page-script.ts:1007`) — *"a column-matched answer on this grid
  is not trustworthy"* — which would make any answer here unreliable rather than merely absent.
- **Are the profile sets separate pages?** The document has a page break, then
  `[SHOW 2 PROFILE VARIATIONS (BEST AND WORST) … AND REPEAT D20 AND D30 FOR EACH PROFILE SET]`,
  then another page break, then D20. That reads as a standalone profile page before each D20/D30
  pair, which is how rows 22 and 25 are counted here — **but it is a programmer directive, not
  respondent-facing text, so the profile may instead be embedded in the D20 page.** If it is
  embedded, rows 22 and 25 do not exist and the remainder is 36 screens, not 38. Named as
  ambiguous; it changes the count, not the risk.

### 3.7 AMBER, cutting across everything — legitimate repeats read as no movement

**This one is not a screen, it is a property of the whole remainder, and it can end the walk
silently at the first repeat.**

Twenty of the 38 remaining pages are repeats of five questions: C10 twice, C20 four times, D10 four
times, D20 and D30 twice each, D40 eight times. The same question id, the same layout, often the
same option labels, page after page. Meanwhile `screenOccurrenceFingerprint` (`driver.ts:4126`) and
`transitionActionFingerprint` (`driver.ts:4106`) exist to detect loops and no-movement — the walker
being stuck on one screen.

A legitimate conjoint repeat looks, structurally, almost exactly like being stuck. If the
fingerprint is computed over question identity and control skeleton alone, the second C20 screen is
indistinguishable from a failure to advance.

**What should save it, and must be verified:** every repeated screen carries a counter that
changes. C20 shows `SCREEN [# of 4]`, D40 shows `SCREEN [# of 8]`, the profile screens show
`SCENARIO 1 OUT OF 2` / `1 OUT OF 4`. The contract seals these as entailed requirements for both
C20 and D40. So the screens *do* differ in text. The question is whether that text falls inside the
fingerprinted region.

**Check this before the next deep walk — it is cheap to check and expensive to discover live.**
Read `screenOccurrenceFingerprint` (`driver.ts:4126`) and confirm the counter text is inside its
input. If it is not, the fix is to include it, with a negative fixture proving two C20 screens that
differ only by "SCREEN 1 OF 4" versus "SCREEN 2 OF 4" are treated as different screens, and a
counterproof that two genuinely identical screens are still caught as no-movement. Beware the check
that cannot fail here: a fingerprint that never collides is not evidence, it is a disabled guard.

### 3.8 AMBER — row 38: proving the walk actually finished

The final page reads *"Thank you for completing the survey!"* — a textbook completion phrase.
`classifyEnding` (`driver.ts:4339`) matches endings against `COMPLETION_MARKERS`
(`driver.ts:4223`). **I did not verify that this exact wording is in that marker list**, and rating
it GREEN on an unchecked list would be precisely the unearned confidence this repo keeps paying for.

If the wording does not match, `driver.ts:4194` states the consequence plainly — *"A survey whose
terminal page says none of this … matches neither, and that ending is `unclassified` and counted."*
An unclassified ending means the run cannot prove it reached the end, which would waste the entire
walk it took to get there. One grep on `COMPLETION_MARKERS` settles it. Do it before the deep walk,
not after.

---

## 4. The expected completion path

Per the document, the last stretch runs: INTRO TEXT 5 (row 28) introduces the final exercise; a
lead-in page (row 29) tells the respondent they will see 3 profiles across "a total of 8 screens";
then D40 repeats eight times, each screen showing three product variations, a screen counter of the
form `SCREEN [# of 8]`, and the two-row best/worst grid; then a page break; then the final page:

> **Thank you for completing the survey!**

That page has no controls and no forward button. A walk that reaches it and classifies it as a
completion has finished the instrument. **D40 screen 8 of 8 is the last answerable screen in the
survey** — there is nothing after it but the thank-you.

### Terminations between 20% and the end

**There are none.**

Every documented termination trigger in this questionnaire lives in the screener. The last one is
at S140; S60's is deferred but still evaluated "AT END OF SCREENER". After the qualification
message — *"Congratulations, you have qualified for our research…"* — the document contains no
termination, no screen-out, and no quota close through to the thank-you page. The constraints on
C10 and D10 are validation rules that reject a submit, not terminations; the 15-second gate on C20
and D40 is a soft block, not a termination.

**So a deep walk past 20% cannot be screened out by anything the document states.** If a walk
beyond this point ends in a screen-out, that is a site defect or a walker misclassification — most
likely `classifyEnding`'s structural arm firing on a profile display page (§3.5) — and should be
investigated as one, never accepted as a legitimate ending.

### The avoid-list, and why it still matters

Every deep walk restarts from screen 1, so the walker re-runs the entire screener each time. These
labels must be avoided on every attempt. Quoted exactly as the document words them.

| Question | Answers that terminate | Safe answer |
|---|---|---|
| Consent | "I do not consent." | "I consent." |
| **S10** (role) | "Revenue Cycle Manager", "Finance Manager", "Finance Director", "Office Manager", "Office Reimbursement Coordinator", "Office Billing Coordinator", "Physician" (shown with "Only select if no other title applies"), "Pharmacist", "Other (Please Specify_______)" | any of "Chief Medical Officer", "Service Line Leader", "Director of Quality", "Director of Health Equity", "Director of Clinical Informatics", "Chief Pharmacy Officer", "Pharmacy Director", "Procurement Lead", "Procurement Director", "Chief Operating Officer", "Director of Population Health" |
| **S20** (departments, multi) | terminates if **"Pediatrics" is NOT selected** | must include "Pediatrics" |
| **S30** (organization) | "Single clinic/office-based practice", "Group of clinic/office-based practice(s)", "Hospital" | "IDN / Health system (i.e., a group of hospital(s) and clinic(s))" |
| **S30a** (institution) | "Other (Please Specify_______)" | "A private Integrated Delivery Network (IDN) / health system" or the public equivalent |
| **S35** (composition) | "Hospitals Only" | "Clinics Only" or "Both Hospitals and Clinics" |
| **S40a** (P&T role) | "I have no involvement with P&T / formulary committee decisions" | any other role option |
| **S50** (affiliations, multi) | every listed employer terminates — "An advertising agency or media company", "A marketing or market research firm or department", "A government regulatory agency (e.g., FDA)", "A pharmaceutical company or MedTech (excluding clinical trial participation)", "A government agency", "A healthcare consulting firm", "A health insurance company", "Any other health care company" | **"None of the above"** only |
| **S60** (states) | terminates at end of screener if the answer is Alaska, Idaho, Maine, Massachusetts, New Hampshire, New Mexico, Oregon, Rhode Island, Vermont or Washington | any other state |
| **S70** (years at organization) | terminates if the answer is **less than 1**; range 0–60 | 1 or more |
| **S80** (years in role) | terminates if the answer is **less than 2**; range 0–60 | 2 or more |
| **S100** (health system type) | "A primarily adult focused health system", "Another type of health system" | "A primarily pediatric focused health system" or "Equally a pediatric and adult focused health system" |
| **S110** (vaccine types, multi) | terminates if **"Pediatric vaccines" is NOT selected** | must include "Pediatric vaccines" |
| **S130** (PCV stocking frequency grid) | terminates unless "Frequently" or "Very Frequently" is chosen for at least one of "PCV15 - Vaxneuvance" or "PCV20 – Prevnar 20"; **and terminates if the decoy row "Prevnontera" is answered "Never", "Rarely", "Sometimes", "Frequently" or "Very Frequently"** | "Frequently" or "Very Frequently" on a real PCV row; **"Not Sure" on the "Prevnontera" decoy row** |
| **S140** (involvement grid) | terminates if the answer is below "3" on "Decision over which immunizations are available…" (always), and on the clinical or operational rows depending on how S10 classified the respondent | choose "4" or "5" on every row — that satisfies all branches at once |

Two of these are worth calling out because they are traps rather than exclusions. **S130 carries a
decoy product, "Prevnontera", which does not exist** — claiming to stock it terminates the
respondent. And **S140's terminations are conditional on the S10 answer**, so the safe play is to
answer high on every row rather than to reason about which branch applies.

---

## 5. What this scan does not tell you

Stated plainly, because a scan that reads as more certain than it is would be worse than none.

- **Everything here is the document's implication, not the live site's behaviour.** The document is
  the source of truth for what *should* be there; it is not evidence of what the programmer built.
  Every widget shape below the section level is an inference.
- **The four names at the wall are not in this repository** and my reading of them is a naming
  convention argument, not a fact. §1 gives the diagnostic that settles it from the existing
  artifact.
- **"Ranking" versus a radio grid at C20 and D40 is genuinely unresolved** (§3.3) and it is the
  difference between a small fix and an unsupported widget class.
- **Whether the C10/D10 ceilings are enforced at all is unknown** (§3.4).
- **Whether the D20/D30 profile sets are their own pages is unknown** (§3.6); the remainder is 38
  screens if they are, 36 if not.
- **Nothing here was measured against the live link.** No walk was run, no page was fetched. The
  ratings order the work; they do not predict the outcome.
- **The corpus is a measurement instrument, never a specification.** Every fix sketched above is
  written for a class, not for this questionnaire. Any of them implemented against these specific
  ids, this specific 15-second bound, or this specific error sentence would pass this survey and
  fail the next one, which is not finished work.
