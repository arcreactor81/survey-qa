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
