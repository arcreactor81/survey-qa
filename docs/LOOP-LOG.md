# Live-link loop — running log

A dated, plain-language record of what each session saw, concluded and did. Receipts first:
every claim here should be traceable to a run id, an evidence id or a gate output. This file is
tracked in git; the same entries are mirrored to the git-ignored `.local-private/OPUS-AGENT-LOG.md`.

---

## 2026-08-20 — v85 run read, C20 wall diagnosed, minimum-dwell patience shipped to source

### What I saw (receipts)

Run `v2r_01m0dj2vcznwcw8krwxhyw5qan` (launched on v85, prod version
`ed20ec25-2654-4023-8f24-7205fa01ee98`), `execution/progress.json`:

- deep walk `FLOOR-01`: **42 screens**, outcome `no-advance-control`, ending `unclassified`,
  detail "screen 42 offered no enabled control that advances the survey", evidence
  `ev_wt9grdknnpks`.
- three 2-screen `FLOOR-01--fi_…` walks ending `screened-out` — the deliberate termination
  probes, working as intended.

The 42 is **not** a regression from the previously reported 75. v85 stopped counting rejected
submits as page advances, so the counter now measures real screens. Progress on the walk's own
screens went from 20% (previous run) to **21%**, so v85's multi-question traversal did carry the
walk past the conjoint block that ended the previous one.

Full observation (`sha256:902677d4…`), last step:

- question **C20**, a best/worst conjoint screen, "SCREEN 1 of 4".
- `instructionText`: *"Please review the profiles carefully before proceeding. You will be
  allowed to proceed in 15 seconds."* — and 10 seconds at the next read five seconds later.
- `buttons`: `<<` (role back) `visible: true`; **`>>` `visible: false`, `disabled: false`**.
- the walker DID answer the screen (best = Profile Variation 1, worst = Profile Variation 1,
  both with exact choice readback) — the failure was purely navigational.

### What I concluded

The wall is a **minimum-dwell / forced-exposure gate**: the page holds its forward control out of
reach for a few seconds so the respondent has to look at the stimulus. `resolveAdvanceControl`
only ever considers controls that are usable at the instant of the read, so the walk read "no
control advances this screen", ended, and reported an ending on a screen that would have opened
by itself moments later — with about four fifths of the instrument unreached.

The class is: **a forward control the page is withholding is not a forward control the page
lacks.** Two related checks came out clean and needed no fix:

- **Cycle detection on repeated screens.** C20 repeats four times with an identical control
  skeleton, and the screen signature is a control skeleton — it stayed byte-identical while the
  countdown text changed. But the transition fingerprint also carries `historyLength` and the
  progress text, and both move (measured 45→50 and 15%→21% across steps 38–42), so legitimate
  repeats cannot collide. No change made.
- **Screen signature vs. countdown.** Confirmed the signature does NOT change while a countdown
  ticks (5204 bytes, identical); the visible text does. That measurement is what the terminal-page
  discrimination below is built on.

### What I did

Shipped to source (not yet deployed at time of writing):

1. `withheldForwardControls(screen)` — buttons present in the page but not usable, that would be
   forward candidates if they were. A DOM fact; no countdown words are read, in any language.
2. `awaitForwardRelease()` — bounded patience. Polls every 3 s until the control opens or a
   ceiling elapses. **No survey's dwell is encoded**: this instrument's 15 seconds appears nowhere
   in the code. The ceiling is a safety bound (default 90 s) and is raisable per deployment with
   `EXEC_FORWARD_RELEASE_MAX_WAIT_MS`.
3. The same patience on the post-submit side, so a gate that re-arms after a rejected submit is
   cleared by the existing bounded recovery rounds without anything parsing validation wording.
4. **The measured wait is evidence.** The press receipt now records "forward control enabled after
   ~Ns of polling" with the poll count and the ceiling that applied, so a run that waited can be
   distinguished from one that never met a gate — and where the document states a minimum-viewing
   rule, that measurement is what a verifier can check the site against.
5. **Terminal-looking screens keep only a short patience** (9 s): a screen with nothing left to
   answer is what every completed walk ends on, and a thank-you page shipping a hidden Next in its
   template must not cost the full ceiling on every walk. It earns the full ceiling back if its
   own prose keeps changing between polls — a ticking countdown is proof the page is still
   working. Stated limitation: a control-free screen gated by a *silent* timer longer than 9 s
   gets the short cap and ends with the withheld control named.
6. When the ceiling wins, the walk ends exactly where it ended before, but the outcome now names
   the control it could not press and counts a `forward-control-withheld` reader limitation, so a
   gate that never opens can never be read as a thank-you page.

Deliberately **not** shipped: an ending-classifier arm promoting these screens to `stalled`. A
real completion page whose wording this reader does not know could carry a hidden Next from the
same platform template, and `stalled` would be a positive wrong claim about a survey that actually
finished. The withheld control is reported as *evidence* on the `unclassified` ending instead;
completion and screen-out wording still win outright.

Gates: `npx tsc --noEmit` exit 0; full suite green; 12 new tests (amendment 13) covering gate
opens mid-poll, gate never opens, no-forward-control costs nothing, the terminal-looking cap and
its proof-of-life counterproof, the configured-ceiling wiring, and both ending arms; 9 new mutants
in `tools/mutate-w4-select.mjs`.

### A gate-design defect I introduced and then fixed

The first version of these tests slept REAL seconds — a 3-second poll interval, a 9-second cap, a
30-second ceiling — because the fixtures used production timing. The mutation campaign runs its
declared kill tests once per mutant, so every mutant paid those sleeps and the campaign was
heading for about two hours. A gate that expensive stops being run, which is its own defect.

Fixed by injection, the same discipline `readTimeoutMs` already uses: the poll interval, the
terminal-screen patience and the ceiling are all walk options with production defaults. Fixtures
pass 20 ms / 60 ms / 300 ms and exercise the identical decision procedure; production passes
nothing and gets 3 s / 9 s / 90 s.

The obvious hazard is that fixture speed becomes the shipped behaviour, so two tests exist to stop
it: one pins all three production defaults by value and by their relationships, and one calls the
wait with NO timing options and proves it declines to start a poll inside a 500 ms deadline —
which can only happen if it fell back to the real 3-second interval. Four mutants back them,
including one that makes the injection point default to the fixture value.

Measured effect: amendment 13 went from ~40 s to 4.8 s, and the campaign from ~6 mutants in 50
minutes to 16 in 10.

### Checks the forward scan asked for, answered with measurements

`docs/FORWARD-SCAN.md` §3.7 asked, before the next deep walk, whether legitimate repeated screens
(C20 four times, D40 eight times) can be mistaken for the walker being stuck. Checked:

- The transition key is built from the screen signature plus `screenOccurrenceFingerprint`, which
  carries `historyLength` and the progress text. Across steps 38–42 of the last run those read
  45,46,47,48,49,50 and 15%,15%,16%,17%,20%,21%. Both move on every page POST, so two repeats of
  the same question can never produce the same transition key. **Legitimate repeats are safe; no
  fix needed.** The screen-counter text ("SCREEN 1 of 4") is NOT what saves them.
- The flip side, and it is worth writing down: because `historyLength` grows on every POST on this
  platform, the transition key arguably never repeats at all, which would make the loop guard
  inert here. That is a guard that cannot fail, not a guard that works. It is bounded by the
  120-step cap so it cannot hang a walk. **Recorded as a finding, not fixed** — changing loop
  detection to be sensitive to repeats is exactly the change most likely to kill the legitimate
  ones, and nothing has yet gone wrong that it would have caught.

### Predicted, not yet measured — deliberately not built

1. **Best and worst on the same profile.** The walker answered C20 with Profile Variation 1 for
   both. If the site rejects that, the next wall is a distinct-choice constraint across sibling
   grid rows. A guess until a run's receipts show the rejection.
2. **The dwell gate's other shape.** The questionnaire states the gate as an ERROR MESSAGE
   ("[IF RESPONDENT TRIES TO CONTINUE BEFORE 15 SECONDS, SHOW ERROR…]") while the live site
   implemented it by hiding the control. The fix covers the shape the site actually used, and it
   also removes the trigger for the other one — the walker now waits for the control instead of
   submitting early. If a platform ever keeps Next pressable and rejects early submits by message,
   the recovery ladder would burn its rounds re-deriving an answer that was already right. That is
   a real gap, named here, and it needs a run's receipts before it is worth building.
3. **C10/D10 allocation ceilings** (`C10_1 <= B10_1` and friends). The forward scan's own advice is
   to read the first rejection before building anything, because whether the site enforces the
   ceiling at all is unknown from the document. Not built.

### Shipped — v86

- Commit `9995cb6` on `agent/v2-reading-visibility`, pushed to origin.
- Gates on the MAIN tree: `tsc --noEmit` exit 0; full suite **1534/1534, 0 failed**; w4 mutation
  **56/56 killed**.
- The 56th needs its own sentence, because it is the trap this repo has paid for before. The full
  campaign came back 55/56 with one **NO-RUN**, not a survivor: making the patience timings
  injectable had rewritten the very line one of my own mutants anchored on, so its find-string no
  longer matched and the mutant silently never ran. Retargeted the anchor to the new line and
  re-scored it alone — killed by its named test. The other 55 verdicts stand because only the
  mutant file changed; `driver.ts` was byte-identical between the two runs. A NO-RUN is not a
  pass, and a campaign that reports 55/56 while one guard was never tested is the same class of
  defect as a test that cannot fail.
- Deployed version `07356ef7-a0a9-4455-9751-d2d7aa9a7053` at 100%, SUCCESS line confirmed.
  `EXEC_MAX_STEPS_PER_PATH: "120"` verified present in the uploaded config before deploying.
- Canary launched: run **`v2r_01m0dvfmm162z50msh7pj9b96a`**, output in
  `.local-private/v86-canary-out/`. The previous walled run was terminated over two hours earlier,
  so the browser session had long drained.

**Useful datum for the integration phase:** the full suite on MAIN is 1534/1534 green, including
the corpus tests that both builder branches report failing in their worktrees ("frozen 20-file
corpus scores 89/99" / "corpus must carry 99 probes, got 0"). That failure is therefore
environmental to worktrees — an untracked corpus fixture they lack. If it appears on the merged
MAIN tree it is real, and the merge stops until it is understood.

## 2026-08-20 — the C20 wall fell live, and the three-branch integration

### The wall fell (receipts)

Run `v2r_01m0dvfmm162z50msh7pj9b96a` on v86. Deep walk `FLOOR-01` reached **screen 43** — past the
C20 minimum-dwell gate that ended the previous walk at 42 — and stopped on a completely different,
NAMED cause:

> "Please make sure you choose different Profile Variation for both Best and Worst rows."

That is exactly the constraint predicted from the previous run's receipts and deliberately NOT
built blind. The patience mechanism is proven on the live site, not merely by gates.

Two design decisions were confirmed by the same run:

- The terminal-looking cap worked. The screened-out probe reports "STILL out of reach after
  **6024ms** of waiting across 2 re-read(s)" — a completion-shaped page paid six seconds, not the
  90-second ceiling.
- The honest degradation worked. That probe's outcome now reads "a screen the survey did not open,
  not the end of the survey" instead of the old sentence that was word-for-word what a thank-you
  page produces.

### Integration of all three branches

Merged into `agent/v2-reading-visibility`: `report-path-fixes` @ `51672ea`, `bw-grid-fixes` @
`c4c79f7`, `ceiling-allocation-fixes` @ `c984c1e`.

- Suite titles renumbered so all coexist: 13 patience, 14 step-cap, 15 best/worst grid. Individual
  TEST names untouched, because mutation campaigns match kills by test name. Zero duplicate test
  names across all 1988, checked by script rather than by eye.
- `DEPLOY.md`'s mutation census hardcoded `-ne 44` while the manifest and `tools/` now both hold
  46. Counted both, fixed to 46; the release script would otherwise have failed closed.
- The w4 campaign now carries 73 mutants — mine, bw-grid's 6 and ceiling's 11 — the builders'
  arriving unscored by agreement, with the merged-tree run as the authoritative verdict.

**A mistake I made and how it was caught.** The report-path resolution left a live conflict marker
and I committed an unparseable test file. The cause: the cleanup replaced the substring
`"=======\n"`, which also matches the TAIL of a long `// ====` banner comment line, so it clipped a
banner and left the real separator in place — and my marker check grepped only for `<<<<<<<` and
`>>>>>>>`, so a bare `=======` passed it. Caught by running the suite, which is the point of
running it. Repaired by rebuilding the file from its three sources rather than patching: all three
versions are verified pure appends onto `ae7a370`. The marker check is now line-anchored and covers
all three markers.

### The corpus test: mystery closed, hardening deferred

Both builders saw "frozen 20-file corpus scores 89/99" fail in their worktrees. On the merged MAIN
tree it **PASSES at its known 89/99 with the failing set exactly the known ten**. The cause is that
its probe inputs (`test-suite/docx-robustness/corpus/_probes-*.json`) are git-ignored and absent
from fresh worktrees.

**Named, dated deferral (20 Aug 2026):** it fails there as a silent `0/99` — an empty denominator
scoring as a number, which is precisely the defect CLAUDE.md's "beware the check that cannot fail"
rule exists to stop. The fix is to make absent probe inputs a loud failure rather than a zero
score. Deferred deliberately: it is test-suite tooling, not the worker, and it does not belong in a
deploy train carrying three merged branches. It should be the next non-urgent piece of work.

### Shipped — v87, the four-branch train

Deployed version `a023ab22-66be-433e-8746-f8e85912b673` at 100%, SUCCESS confirmed,
`EXEC_MAX_STEPS_PER_PATH: "120"` verified present first. Canary launched:
**`v2r_01m0e6axg4phhm8wzeh3a3fxw5`**.

Merged gates on the final tree (patience + report-path @ `ef4a65c` + bw-grid + ceiling):

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| full suite | **1589/1589**, 0 failed |
| `mutate-w4-select` | **73/73 killed**, denominator 61, both self-checks passed |
| `mutate-report-defects` | 11/13 — two bounce-backs, below |

The 73/73 is the first real scoring of bw-grid's 6 and ceiling's 11 mutants, which arrived
unscored by agreement.

**A gate that reddened for the wrong reason, and what it cost.** The first merged w4 baseline came
back 60/61 with one of my own patience tests already red — on a tree whose full suite had been
1583/1583 twenty minutes earlier. The cause was mine: that fixture injected a 300 ms ceiling for
four 20 ms polls, under 4x headroom, and another builder's load on the machine erased it by
stretching a single sleep. Injected ceilings are now 5 s, so the POLL COUNT decides the outcome
rather than the wall clock (~60x headroom). The guards did not get weaker: each mutant is still
killed by an exact timing-independent assertion — removing the terminal cap changes `ceilingMs`
from 60 to 5000, removing the proof-of-life extension leaves `released` false. "It passed when the
machine was quiet" is not a result.

### v87 run: two more walls fell, and the next one is diagnosed

Run `v2r_01m0e6axg4phhm8wzeh3a3fxw5`. Deep walk `FLOOR-01` reached **screen 54, 39% progress** —
up from 43 on v86 and 42 on v85. The best/worst distinct-column wall fell (bw-grid, live-proven),
as did the C20 dwell gate (patience, live-proven a second time).

**The new wall — D10, and it is a NEW CLASS: the recovery ladder oscillates.**

Screen 54 is `iSecDTPP`/D10, an allocation grid whose column "Future w/ Product X, Product Y and
Product Z" needs five numeric cells summing to 100. The site's validation is explicit:

> "Please enter numeric answers for «PCV20 (Prevnar 20) [Pfizer]», … in column Future w/ Product X,
> Product Y and Product Z. Please ensure the sum of your answers equals 100…"

The receipts show the ladder going back and forth rather than converging:

| round | what it did |
|---|---|
| first attempt | typed `QA-PROBE` into all five `%` cells — the generic text default |
| recovery 1 | **set 100 / 0 / 0 / 0 / 0** — correct, derived from the numeric demand |
| recovery 2 | typed `QA-PROBE` into all five again — **threw the correct answer away** |
| recovery 3 | set 100 / 0 / 0 / 0 / 0 again |

Then the rounds ran out and the step ended `advance-timeout`. The field's own mask makes the cost
visible: the receipt records keyboard-type reading back `"-"` for `"QA-PROBE"`, so the probe text
cannot ever satisfy a numeric cell — it is discarded down to a single character.

**The class:** *a demand the site has already made is not withdrawn by a later round that does not
repeat it.* Each recovery round re-derives from the NEWEST validation only, so a round whose screen
read carries no numeric sentence falls back to the generic text default and destroys an answer the
previous round had already derived correctly. The fix is monotonic accumulation: once validation
has demanded numeric answers for a set of cells, that demand holds for the remainder of the step,
and no later round may re-derive those cells as free text. This is general — it is not about
percentages, sums, or this instrument — and it should degrade the same way it does now (rounds run
out, step ends named) when the accumulated demands still cannot be satisfied.

Not built in this session: the walk record shows it clearly and it is the next class fix.

## 2026-08-20 — v91 deployed (completion-lexicon fix), clean run launched

### What was deployed

Commit `e118ae5` — the completion-lexicon fix. The article "the" before "survey" in the
completion pattern is now optional; the noun is still required. This is the fix for the
mislabelling of the 81-screen completion page as `screened-out` on the previous run.

Gates: tsc exit 0; full suite **1629/1629**, 0 failed (mutations already verified at 85/85
on this exact code in the previous session).

Deployed version `7a1e16b1-3a86-4f8a-bbbd-b5b007e0993c` at 100%, SUCCESS confirmed.
`EXEC_MAX_STEPS_PER_PATH: "120"` verified present. Old run `v2r_01m0f1zccejfmq8fd02r7xq8kv`
terminated, ~2 min drain observed.

### Clean run launched

Run **`v2r_01m0f81gbe7n28zvhgrt0dphvm`** on v91. This is the run that should:
1. Reach the end of the survey again (81+ screens)
2. Correctly label it as `completed` (not `screened-out`)
3. Produce an honest published report

Watch: `https://survey-qa-v2.wellshit.co.in/runs/v2r_01m0f81gbe7n28zvhgrt0dphvm`
Report: `https://survey-qa-v2.wellshit.co.in/api/v2/runs/v2r_01m0f81gbe7n28zvhgrt0dphvm/report`

---

## THE END OF THE SURVEY WAS REACHED — 81 screens

Run **`v2r_01m0f1zccejfmq8fd02r7xq8kv`** (relaunch of v90's version, `dd0e4c97`), deep walk
`FLOOR-01`: **81 screens**, 104 steps. Deepest ever, against 54 the run before and 42 two trains
ago. The final screen reads:

> End of survey
> End of test link.

That is the completion page. The walk traversed the whole instrument.

**And the system called it a screen-out.** `classifyEnding` returned `screened-out` with the
evidence "no screen-out wording matched, but structural signals indicate a rejection page: the only
visible button(s) are back controls and the page has no answerable controls".

The cause is one missing article. The completion lexicon required "the end of THE survey"; the page
says "End of survey". Nothing matched, so the STRUCTURAL rejection arm fired on a survey that had
actually finished — a positive wrong claim about the single outcome this system exists to report,
and exactly the failure mode the completion-path audit predicted.

**Fixed:** the article is now optional in the completion pattern, the NOUN is not. The original
caution is preserved and pinned by a counterproof — a bare "the end" in ordinary prose still never
claims a completion, and a real disqualification page is still a screen-out. Amendment 19, 4/4
tests, 1 new mutant killed (restore the article requirement and the measured page fails).

That fix is in source and NOT yet deployed: the run above is still executing and must be left to
finish and publish its report, which is the first report produced from a walk that reached the end.

Standing caveat on this walk, from its own ending evidence: **62 of its answers were
navigator-defaults the harness chose**, not answers the document asked for. Where this walk went is
partly a fact about those fillers. The end-to-end bar — completion page plus terminations plus an
honest published report — is not met by this run alone.

### v90 run: shallow, and NOT a logic regression — page reads failed

Deployed `dd0e4c97-daa0-453c-8fcf-394a1a0f021e` (silent-refusal re-press). Gates: tsc 0, suite
**1625/1625**, `mutate-w4-select` **85/85** (83 in the full run plus the two wait-bound mutants
re-scored with child headroom — see below). Run `v2r_01m0f04dpk7m3xxjz99rrhwrj2`.

The deep walk stopped at **5%** on A20, far shallower than the 26–39% of the previous runs. It
looked like a regression and is not one. The receipts on step 27:

- `blockedReason: advance-timeout`, no validation on any read
- **two `screen-read-failed` capture failures**, so `screenAfterAdvance` is absent
- **zero** silent-refusal re-presses and **zero** withheld-control releases across the whole walk

So neither new mechanism ran at all. The reason is that the advance-poll reads of that screen
FAILED, leaving no post-press screen to reason about — and the re-press loop deliberately declines
to act when it cannot read the page, because a failed read is not evidence that the site refused
anything. That refusal to guess is the correct behaviour; the shallow depth is a page-read
problem, not a walker-logic one.

Next session should relaunch once and see whether the read failures reproduce. If they do, read
reliability on heavy grid screens is the next class — and it is a different class from anything
fixed so far.

### A NO-RUN is not a pass, again

The merged campaign came back 83/85 with two NO-RUNs, and both were mine. Neither was a weak
guard: both mutants remove a WAIT bound (the forward-release early return, and the silent-refusal
press bound), which makes the mutated tree genuinely slower, so the child was killed at the 120s
default before it could produce a summary. Left alone, the campaign would have reported a number
while two guards sat untested.

Fixed by making the press-bound mutant cheap (6 presses, still breaking the bound of 3) so it
fails fast, and by recording in the campaign header that this suite wants
`MUTATION_CHILD_TIMEOUT_MS=600000`. Re-scored both under that headroom: 2/2 killed, so the verdict
is **85/85**.

### v89 run: the dwell gate's SECOND shape

Run `v2r_01m0enh6bjc1en2bgesvcnt5jc`. The prose-progress signal behaved correctly and caused no
false advances — measured: it appeared alongside other evidence on 18 of 45 advanced steps and was
the SOLE evidence **zero** times.

The walk stopped at 26% on C20 "SCREEN 2 of 4", and the receipts are unambiguous. The walk answered
the best/worst grid CORRECTLY — the distinct-column repick fired and the readbacks confirm two
different columns checked. It pressed forward. Nothing happened: no movement, and no validation.
The screen's own instruction text says why:

- before the press: "You will be allowed to proceed in **4 seconds**"
- after the press: "You will be allowed to proceed in **0 seconds**"

The press landed inside the minimum-dwell gate and was swallowed, and the ladder then spent its
rounds re-deriving an answer that was already right.

**This is the gate's second shape.** On the first C20 screen the platform HID its forward control,
which the patience fix waits out. Here it leaves the control VISIBLE and simply ignores the press,
so nothing up to now noticed.

**The class: silence is not rejection.** A press producing neither movement nor a new complaint is
not evidence the answer was wrong. The walk now waits and presses again, bounded by press count,
and hands over to the answer-recovery ladder the moment the site does complain. Nothing reads the
countdown — the trigger is the absence of both movement and complaint, which is platform- and
language-neutral. A merely slow site benefits identically, and each re-press re-checks for movement
first so a late advance is never pressed through onto the next question.

The cadence is the advance window itself rather than a new knob: waiting again before re-pressing
is exactly "give this submit another advance window". That also keeps fixtures fast automatically
instead of making every non-advancing fixture sleep real seconds — the lesson from the patience
work, applied before it cost anything this time.

**Four of my own mutants failed first**, and the reasons are worth keeping:

- Two SURVIVED because the fixture's event landed BEFORE the guard it was meant to reach, so both
  inner guards were never executed at all. The fixture now times events by reads-since-press so
  they land inside the wait. A test that passes without executing the line it guards is not a test.
- Two assertions counted re-presses across ALL steps and so caught a LATER step's perfectly
  legitimate re-press. Scoped to the step under test.

Two existing d38 pins were also updated deliberately: they fed one screen three times, so the walk
never advances and now records its own limitation for the bounded re-press. Both were asserting
TOTALS while being about the LIFTING of screen-raised limitations, so they now scope by kind —
"listed with its step and counted" and "empty is a claim, not absence" both survive intact.

### Shipped — v89, the prose-progress signal

Deployed `e83fa046-e2f0-43a9-b7ce-ecc74f7c763c` at 100%, SUCCESS confirmed, step cap verified.
Old run terminated, ~2 min drain, canary launched: **`v2r_01m0enh6bjc1en2bgesvcnt5jc`**.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| full suite | **1619/1619**, 0 failed |
| `mutate-w4-select` | **81/81 killed**, denominator 68, both self-checks passed |

### v88 run: the D10 fix worked, and uncovered something bigger

Run `v2r_01m0eddha4xfq66xhynfmaq2cw`. The monotonic-demand fix did exactly what it was built to
do — all three recovery rounds held `100/0/0/0/0`, round 3 flipped to keyboard entry as the ladder
was always meant to, and probe text never reappeared. The oscillation is gone.

The walk still recorded `advance-timeout` at screen 54, and the receipts say why: **the survey was
advancing the whole time.** "Survey progress: 39%" became 43%, then 44%, across the three submits,
with validation empty throughout.

Nothing could see it. The D-section repeats one question shape, so the screen signature was
byte-identical, the question identity unchanged, the URL unchanged and `historyLength` pinned at
50. The existing numeric progress signal could not help either: this platform renders progress as
a `div` whose `now`/`max` are null, so the respondent's position exists ONLY inside the sentence.

**The class: a position indicator that is prose is still the site saying where the respondent is.**
Take the first number on each side, require an INCREASE. Safe because the baseline is the
POST-ACTION screen — a counter that moves when an answer is typed has already moved before the
comparison, so what remains is navigation. Requiring an increase rather than any change stops a
re-render that merely reworded itself from reading as movement, and the site's own rejection still
outranks the signal. An indicator with no number yields nothing and the walk falls back to the
structural signals: this adds evidence, never removes any.

This matters beyond D10. Any instrument that asks the same question shape repeatedly — loops,
scenario blocks, grids — was invisible to every movement signal the walker had.

**Two of my own mutants failed before this shipped**, and both are the kind worth writing down:

- One **NO-RUN** was the heredoc regex trap the runbook names: a backslash inside a JS string
  literal collapses, so `/-?\d+/` became `/-?d+/` and the anchor silently never matched. A mutant
  that cannot match is a guard that was never tested. Rewritten with `String.raw` and verified to
  resolve to exactly one occurrence in the source.
- One **SURVIVED** because no test exercised an ABSENT indicator against a present one — the
  mutant made absence compare as zero, which is this repo's oldest failure mode. Added that test.

### Shipped — v88, the third train

Deployed version `c8711704-ada9-4b3f-9817-f8af1efeaa64` at 100%, SUCCESS confirmed, step cap
verified present first. Old run terminated, ~2 min drain observed, canary launched:
**`v2r_01m0eddha4xfq66xhynfmaq2cw`**.

Contents: the D10 monotonic-demand fix, `report-blockers @ f58d399`, `corpus-gate-hardening @
7d77185`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| full suite | **1612/1612**, 0 failed |
| `mutate-w4-select` | **77/77 killed**, denominator 65, both self-checks passed |
| `mutate-report-defects` | 18/20 — two report-path guard gaps, bounced back, below |

### Third train: D10 fix built, and two more report bounce-backs

Built the D10 monotonic-demand fix (`mergeStandingDemands`) — commit `9e0a3d5`, amendment 16, 5/5
tests, 4/4 mutants killed including the exact regression: restore the old
`roundValidation = recovered?.validationMessages ?? []` and the measured-shape test fails.

Merged `report-blockers @ f58d399` (both earlier bounce-backs verified fixed) and
`corpus-gate-hardening @ 7d77185`. Merged-tree suite **1612/1612**, tsc 0, corpus gate green.

**`mutate-report-defects` came back 18/20 — two NEW mutants SURVIVED**, both from
`report-blockers`, both the same shape: the fixture never exercises the case the mutant breaks.

1. **B3 — "the attempt ledger reads v1's nested timestamps again".** The mutant strips the
   `?? a.startedAt` fallback, leaving only `a.timestamps?.startedAt`. The guard
   "B3 — the attempt ledger reports what the record holds, and absent is never a zero" still
   passed, so its fixture must be supplying v1-style NESTED timestamps — the very shape the
   fallback exists because v2 does NOT write. The fixture needs a v2 record with FLAT
   `startedAt`/`endedAt` and no `timestamps` object.
2. **B4 — "the record stops carrying how far the walk got".** The mutant deletes `screensAdvanced`
   from `deriveAttempts` entirely. The guard "B4 — HOW FAR WE GOT reaches the record and the page"
   still passed, so it is not asserting that the depth NUMBER reaches the rendered page. This is
   the same field as the standing debt item below — the record carrying walk depth as typed data.

Neither is a walker defect and neither blocks the walk: both are report-path guards that cannot
fail, which is the repo's cardinal sin but not a shipped-behaviour break. Handed back to the
report train; the deploy proceeds on the walker gates.

### Bounce-backs from the merged-tree campaigns (20 Aug)

The builders' new mutants arrived unscored by agreement, so the merged-tree runs are their first
real scoring. `mutate-report-defects` came back **11/13**. Neither failure is in the walker, and
both belong to the report train that is actively rewriting the same file
(`pipeline/report/lib/view-model.mjs`):

1. **NO-RUN — "an ending kind this reader does not know is folded into `completed`".** Not anchor
   drift: the anchor is present. The mutant is MALFORMED. It rewrites
   `else if (ENDING_KINDS.includes(kind)) …` into `else …`, but the following line is also an
   `else`, so the mutated source is `else` after `else` — a syntax error. The build fails, no tests
   run, and the harness correctly refuses to score it. Fix: replace both lines together.
2. **SURVIVED — "rows without an ending are dropped from the sentence instead of counted".** This
   is the real one. The guard is
   "A PARTIAL LEDGER IS NEVER SILENTLY SHORTER: rows without an ending are counted out loud", and
   it does not pin what the mutant breaks: its `endings.unstated` assertion reads a count computed
   UPSTREAM of the sentence, so it passes with the sentence suppressed. A guard against silent
   shortening that survives the sentence being silenced is the exact anti-pattern CLAUDE.md names.

### Named debt for the walker backlog (NOT this train)

B4 quotes the site's refusal by parsing the `"; validation said: "` marker out of `outcomeDetail`.
Reading a string a human wrote for humans is not a contract. The durable fix is a TYPED field on
the walk record, written by `driver.ts` where the validation messages are already in hand, with the
prose sentence derived from it rather than parsed back out of it.

### Integration queue (after this deploy lands)

`report-path-fixes` @ `51672ea`, 4 commits on `ae7a370`. Protocol: rebase-merge into
`agent/v2-reading-visibility`, re-run FULL gates on the merged tree, deploy as the next version.
Carried notes from its builder, to be checked rather than trusted:

- Its `driver.ts` edits are confined to the `COMPLETION_MARKERS` array and one evidence line in
  classifyEnding arm 3, so the patience work above should rebase textually clean. **Its lexicon
  widening is what makes dropping arm 3b safe** — the reason arm 3b was a wrong-claim risk is that
  a real completion page could go unrecognised, and that is the hole this branch closes.
- `ATTEMPT_PROJECTION_ID` 1.0.0 → 1.1.0 (`ok` now derives from the typed ending; the d41 pin moved
  with it).
- It repaired two guards in `mutate-exercised-gate` and `mutate-endings` that were silently
  unappliable or surviving at base. Those campaigns will not behave the way earlier notes describe.
- Its worktree suite was 1547/1548, the one failure being docx-robustness "corpus must carry 99
  probes, got 0", claimed pre-existing and blamed on an untracked corpus fixture missing from
  worktrees. **Verify on the merged MAIN tree before accepting that** — a suite failure explained
  away is exactly the shape this repo has shipped before.
- `DEPLOY.md` ~line 203 hardcodes `-ne 44` while `$MutationHarnesses` will hold 46 after the merge,
  so the release script fails closed. One-token fix 44 → 46 belongs in the integration commit.
- Known limitation, deliberately NOT fixed now: `TestCompletion` has no fourth partial state, so
  completion-axis labels stay coarse. Named and deferred.

### Deploy-time note carried forward

`wrangler.jsonc` sets `EXEC_MAX_STEPS_PER_PATH` to 120; the code fallback is 40, which would not
clear this survey's ~85–100 screen traversal. A deploy that lost that variable would silently cap
every deep walk at 40 screens and report it as a step cap. Verified present before this deploy;
`wrangler.jsonc` was not touched.

---

## 2026-08-21 — BACKFILL: the unlogged window, v91's run through v97 (written after the fact)

**Why this entry exists.** The log above stops at the v91 deploy (20 Aug 15:04). The eighteen
hours that followed — the most operationally consequential of the whole loop — were never
logged: the sessions that ran them were firefighting and the discipline lapsed. This entry is a
RECONSTRUCTION, written 21 Aug by the returning session, from durable receipts only: R2
checkpoints and progress ledgers fetched today, git history, and the Workflows engine's own step
table. Where a fact could not be recovered it is named as missing rather than filled in.

**What the lapse cost, in one sentence:** v93's report died on 20 Aug 19:24 with
`project-observations: Execution timed out after 180000ms` — and because no one wrote that down,
v96 was launched into the identical death nine hours later and the defect was only diagnosed
after it had killed a second 4-hour run.

### v91 run — the browser-error class appears (receipts)

Run `v2r_01m0f81gbe7n28zvhgrt0dphvm`, 11 walks, terminated by operator at 199 min
(`operator-terminated`, per its checkpoint failure record). Deep walks: 67 screens (time-cap)
and 8 screens (blocked). The new signal: **three walks recorded 0 screens with outcome
`error`** — the first cluster of walks that died before reaching the survey at all. The
completion-lexicon fix it carried was never exercised against the end page: no walk reached it.

### v92 — the D65/D58 train, and its walks drowned (receipts)

Commits `a14d406` (D65 composite binding score) + `7fa5b9c` (D58 bounded binding retry), merged
`1f67a32`. Run `v2r_01m0fmk3zr3k7jfsbqhmbg2y7m`: 13 walks, **seven of them 0-screen `error`
walks**, two more 0-screen per-case-timeouts; best real walks 54 and 14 screens; operator
terminated at 96 min. Diagnosis recorded in the revert commit and runbook: D65 was confidently
binding decisions to the WRONG screens on surveys with repeated question shapes — zero binding
refusals was WORSE than 62 refusals, because the navigator defaults handle unbound screens
correctly while a wrong binding steers positively. Both features were reverted the same evening
(`6f406c0`), tests and mutation campaigns removed with them.

### v93 — the revert run reached the END, and its report died first (receipts)

Run `v2r_01m0ftb0vcdfwvc1ctes58y19x` on the reverted tree: 13 walks, again seven 0-screen
`error` walks — but walk 13 reached **82 screens, ending `completed`**: the second traversal to
the end of the survey, confirming the revert cost no depth. Wall clock capped at 241 min, the
run moved into its judging tail, and:

> failure: step=`project-observations` — `Error: Execution timed out after 180000ms` (20 Aug 19:24:19)

`checkpoint.completion` closed as `test: failed, report: failed, reason: workflow-error`. This
is the FIRST report-tail death by projection timeout. It was not diagnosed at the time.

### v93b, v94, v95 — three runs lost to zombie browser sessions (receipts)

- v93b `v2r_01m0gd3qctvhfpmz2ewwgnyd7x`: 4 walks then stranded; operator-terminated.
- v94 `v2r_01m0gg88ycgwd2en7jbz1fs9js`: 0 walks, stranded from batch 0; operator-terminated.
  (v94 itself shipped the tracker phase-timeline work, `c066803` — a UI train, not a walker fix.)
- v95 `v2r_01m0gktc0rdy8tpac2mm8t5bst`: 0 walks, stranded again; operator-terminated. v95's own
  fix — the hard batch-abort timer (`c5d25e5`) — did NOT fire, which is how it was learned that
  when Puppeteer's WebSocket goes half-alive, NO timer callback in the isolate dispatches: not
  the abort timer, not the 80-minute Workflow step timeout. Each stranding held its step "alive"
  for 5+ hours.

The class and its measured boundary: CF Workflow step timeouts were enforced reliably at shorter
durations (v53–v63 died at exactly ~67 min) and not at 80 min over a live WebSocket.

### v96 — the timeout fix worked; the unfixed projection death took the report anyway

Commit `9c6f545`, version `11bbe5ed` at 100%: `EXEC_PER_CASE_TIMEOUT_MS` 30→15 min,
`EXEC_BATCH_MAX_MS` 65→18 min, `BATCH_POLICY` 80→22 min with retries 1→3. Run
`v2r_01m0gntj754aszafnjy1xfr1nq`, 28 walks over 244 min, **zero zombie strandings** — the
reduced ceiling is inside the enforcement range and the class is closed.

The run itself was the best yet: walk 5 reached **82 screens, `completed`**; deep walks of 75,
63, 61, 59, 57, 55 behind it; all six 2-screen termination probes fired; **362/429 obligations
exercised, 67 time-exhausted, 0 pending; $0.00 spent** (full extraction cache replay). Two new
facts it measured:

1. Walks 22–28 all stalled at 10–12 screens on "unable to accept" — that is the SCREENER
   working as designed against navigator-default filler answers, a coverage limitation to plan
   around, not a walker defect.
2. The halved per-case budget has a real cost: five walks time-capped at 55–63 screens that
   under the old 30-minute budget would have kept walking. Traded knowingly for the zombie fix.

Then the tail: `record-target-identity` burned its first attempt on "Worker exceeded CPU time
limit" (10 min) and succeeded on retry — and `project-observations` timed out at 180000ms on
ALL FOUR attempts, the v93 death repeated verbatim. `completion` closed `test: failed, report:
failed`. With 28 walks the evidence catalogue is ~2,000+ entries and `listCatalog` pays one R2
GET per entry; three minutes cannot cover it.

### v97 — the projection fix (this session)

Commit `172a3a5`, version `c0a13b71` at 100%: new `PROJECTION_POLICY` gives
`project-observations` a 10-minute step timeout with 60-second retry delays (sized to ~double
the current catalogue); `ENGINE_CAUSE_AFTER_MS` 5→12 min so the status reader's staleness gate
stays past the longest legitimate quiet stage; the failure-cause test's `goQuiet` fixture moved
to 15 min accordingly. Gates: tsc 0, suite 1629/1629. Run
`v2r_01m0h811506rysmn1hzgd886fn` launched and in flight at time of writing — walk 9 reached
**81 screens `completed`**; four 0-screen per-case-timeout walks so far (the browser-acquisition
shape, milder than v91–v93's `error` wave). Whether the report tail survives is the question
this run exists to answer; no projection timeout has been proven fixed until it does.

### Where the loop actually is (the honest summary)

The walker has now reached the end of the instrument on FOUR runs (v90-relaunch 81, v93 82,
v96 82, v97 81) — walker logic has not been the blocker since v90. What has blocked, in order:
browser-session `error` waves (v91–v93), zombie strandings (v93b–v95, closed by v96), and the
projection timeout that has eaten every report attempt to date (v93, v96; fix live in v97,
unproven). The open walker-logic items are the probabilistic C20 dwell-gate stall (walks still
stop at 42–47 roughly half the time; patience shows 0 polls in those receipts — unexplained)
and the screener-steering coverage question the 67 time-exhausted obligations pose.

---

## 2026-08-21 — v98: three builders, one integrator, every gate green including the one nobody ran

### What shipped (version `a0985e81-dc68-4b98-9546-bc50c9447ba7` at 100%, SUCCESS confirmed)

Six fixes, all from adversarially-verified review findings, built by three Opus 4.6 builders
in sha-pinned worktrees off `482b978` and integrated after line-review:

1. **Completeness reads the typed ending** (`c851543`): `completenessFor` read `walk.outcome`
   — the step-loop exit code — so walks that FINISHED the survey were marked partial and
   their exhaustive option-set verdicts refused downstream. Now reads `ending.kind`; absent
   and unclassified stay partial.
2. **A zombie browser no longer ends the run** (`c851543`): the hard-abort timer's bare
   `"hard-batch-abort"` stopReason broke the batch loop and labeled the run `partial-blocked`
   — a site accusation for an internal browser death. Single abort → next batch, fresh
   browser; three CONSECUTIVE aborts (durable counter) → registered `browser-abort-cap` →
   `partial-budget`.
3. **The whole judging tail gets the catalogue-sized budget** (`c851543` + the follow-up):
   v97 proved the projection fix then died in `derive-verdicts` at the same 3-minute limit
   (failure recorded 08:59:54Z). `derive-verdicts`, `assemble-record`, `mint-judgement`,
   `record-target-identity` and `project-observations` all reach the full evidence-catalogue
   fan-out; all five now carry the 10-minute policy.
4. **The dwell-gate re-press reaches the recovery loop** (`dfc827c`): the measured ~50%
   stall at screens 42–47 was the recovery loop pressing once with a 600ms wait against a
   re-arming 15s gate, while the 90-second patience budget was unreachable for a VISIBLE
   button. A shared `silentRefusalRepress` helper now serves both loops — same bound, same
   receipts; a visible control that goes hidden mid-wait hands off to the patience wait.
5. **Test guards proven able to fail** (`a9654e2` + follow-ups): four un-awaited
   assertThrows (guards deleted, tests stayed green — now awaited and re-proven); B3/B4
   report guards rebuilt to exercise the real code paths; first-ever test rendering the
   test:failed-with-record state; two abort-cap mutants and one re-press mutant re-aimed at
   the tests that actually redden after the campaigns scored them SURVIVED.
6. **The canary config gate is green for the first time** (`c851543`): the missing
   `EXEC_PER_CASE_TIMEOUT_MS` entry had 24 of `test-visual.mjs`'s 482 tests failing —
   invisible, because that runner was in no routine command. It is now in the runbook's
   gate list.

### Gates on the deploy sha (`f6f7f02`)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| full suite | **1640/1640** |
| `mutate-w4-select` | **89/89** (chunked union [0,89), no gaps — chunk slicing added for environments that kill long tasks) |
| `mutate-projection-carry` | 16/16 |
| `mutate-exercised-gate` | 17/17 (after re-aiming two mutants the first run scored SURVIVED) |
| `mutate-report-defects` | 20/20 (B3/B4 killed for the first time) |
| `test-visual.mjs` | **482/482, exit 0** (was 24 failing) |

Two campaign survivors were found and fixed DURING this integration — both the same class:
the guard asserted a value (a string literal, a constant) that the mutant never touched.
The kill now goes through what production actually emits.

### Run launched

**`v2r_01m0hzte6qmz28dpn7sgrf2kvj`** on v98. What it must show: (a) the judging tail
survives end to end → the FIRST REPORT; (b) deep walks stop coin-flipping at the dwell
gates; (c) an aborted browser costs one batch, not the run. The 67 screener-blocked
obligations are NOT expected to move — that fix (screener-screen recognition) is next.

## 2026-08-21 (evening) — THE FIRST REPORT

### Receipts

Run **`v2r_01m0hzte6qmz28dpn7sgrf2kvj`** on v98 (`a0985e81`), 28 walks, 211 min, $0.00:

> `completion: test=partial-blocked, report=COMPLETE, reportAvailable=true`

The report is live at `/api/v2/runs/v2r_01m0hzte6qmz28dpn7sgrf2kvj/report` (6.2MB, HTTP 200,
fetched and archived to `.local-private/v98-report.html`). Every stage ran: extraction
(cache), planning, 28 walks, projection, verification, verdict derivation, record assembly,
judgement, report build and publication. No prior run in this project's history got past
verification.

### What the run itself proved

1. **The judging-tail fix holds.** All five catalogue-reading steps ran inside their 10-minute
   budgets. The three-run death streak (v93, v96 at projection; v97 at verdicts) is over.
2. **The dwell-gate fix holds.** Six deep walks (39, 48, 52, 56, 38, 42 screens, all
   time-cap) crossed the screens-42–47 zone with ZERO stalls — the class that previously
   ended ~half of deep walks. The cost is visible too: the re-press patience spends budget,
   so deep walks now time-cap shallower than v96/v97's range. Depth is budget-bound now,
   not stall-bound.
3. **The report is honest when there is nothing to claim.** No walk completed this run
   (deepest 73, ending `unclassified`); 12 walks were screened out (6 of them the planner
   probing screener-gated cases at screens 10–11); 6 died at 0 screens. The published page
   says: settled requirements 0, "no result on this run cleared our evidence check", screened
   out early "is the survey working". No fabricated findings. Exactly the degradation the
   standing rules demand.

### What it did NOT prove, named

- **No requirement settled.** The checkpoint's own executor count said 13 exercised; the
  record shows 0. Whether that gap is correct demotion (verification refusing partial-scope
  evidence) or a projection defect needs one read of the record's demotion reasons — queued
  with #21.
- The 67 screener-gated obligations did not move (expected — the fix is #28, not shipped).
- The zero-screen class (6 walks) and the run's `executor-error` stop reason on the last
  batch are #30's evidence.

### The stage-2 trigger has fired

Owner's rule (21 Aug): report produced + wait-screen fix held live → stage-2 work un-parks.
Both conditions met by this run. Next: v99 (screener recognition #28 + startup budget #30)
with multilane (#14) and multimodel (#16) design starting in parallel.
