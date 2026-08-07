# survey-qa — directional plan (v2.1)

**Status:** rewritten 8 Aug 2026 after a cross-validation round demolished v1's prescriptions;
**corrected the same day (v2.1) after two further independent validators demolished parts of v2.**
Directional, not line-in-stone. **v1's facts largely held; v1's PRESCRIPTIONS broke.** That is the
governing lesson of this document: every fix below is specified at surgery level, because the
one-liner version of two of them would have shipped new fabrication paths.

**What v2.1 changed, in one breath:** the text binder's premise was FALSE and its replacement is an
order of magnitude cheaper (0.4); the "pre-registered prediction" claimed a blindness it does not
have (Phase 2); the leak surface was aimed at the wrong files (Phase 1); a real finding was
acknowledged and scheduled nowhere (3.5); this file's own last row was a false claim; and three v1
findings had vanished with no disposition. See the v2 → v2.1 table at the end.

## Review inventory (so "was anything dropped" is answerable)

| # | Lens | Verdict source |
|---|---|---|
| R1 | Trajectory / product direction | effort misordered; single bet = one useful report |
| R2 | Architecture / yield | spine right, inputs starved; option-set is the lever |
| R3 | Yield path / decidability | build a decidability ladder; model verifier is the last rung |
| R4 | Codebase reality / debt | **P0: deployed Worker untracked**; 10 lying comments |
| R5 | Risk / honesty / readiness | publication hazards; completion vocabulary |
| X1 | Cross-val: goal & framing | unit of proof is a PAIR; "yield" is the wrong metric name |
| X2 | Cross-val: sequencing | binder dependency runs the OTHER way; schema-batching |
| X3 | Cross-val: risks | **5 fabrication paths, not 2**; no clean control anywhere |
| X4 | Adversarial | **my Phase 0.1 fix ships a NEW fabrication path** |
| X5 | Adversarial (2nd) | **t1-easy does not print ids → Phase 2 yields ZERO by construction** |

---

## THE DECISIVE FINDING (verified by hand; **amended in v2.1**)

`targets/t1-easy-host/public/survey.js`: the renderer emits `page.heading` and `page.text` only
(line 449). Question ids (`'S1'`, `'Q1'`) exist solely in the JS data model (lines 14-216) and
reach the DOM only as **control attributes** — `name="' + page.id + '"` and
`id="' + page.id + '_' + o.code + '"`, both at line 367. A grep for the id appearing in any
template or heading returns **nothing**.

The capture reads `title` / `questionText` / `visibleText` (`page-script.ts:228-240`) — exactly
the three fields `tokenOnScreen` reads (`verify-observations.ts:437-443`).

**Therefore `stepsOnTargetQuestion` returns empty for every case, every route/boundary predicate
exits `insufficient` at binding, and a Phase 2 run as v1 specified it produces ZERO verified and
ZERO violated.** Not low yield — *null* yield, teaching us nothing about the pipeline because the
binder swallows everything before a predicate runs.

**Consequence: the binder is not Phase 4 work. It is a Phase 2 blocker.**

> **v2.1 AMENDMENT — the ids are already in the artifact; only the binder is blind.**
> The finding above is right that no *rendered text* carries the id, and wrong to stop there.
> `page-script.ts:122-123` **already captures `name` and `id` per control**, so
> `name="<sealedQuestionId>"` — unmangled, exactly the sealed id — and
> `id="<sealedQuestionId>_<optionCode>"`, which carries it as a clean prefix, are **sitting in every
> screen artifact we have already collected**.
> `tokenOnScreen` (`verify-observations.ts:437-443`) simply never looks at them: it reads
> `questionText + title + visibleText` and nothing else.
> This does not weaken the "binder is a Phase 2 blocker" conclusion. It makes the first rung of
> the fix an order of magnitude cheaper — see **0.4**, rewritten.

---

## Ground truth (corrected — v1 claims that were FALSE are struck)

- v2 deployed (`survey-qa-v2`, version `823be409`). Suite 217/217 and tsc-clean **as a snapshot,
  not a property** (counts drift; earlier notes recorded 140/145).
- Never produced a real verdict on a real survey. The one completed cloud run used a placeholder
  URL and stopped `walks-blocked-by-site`.
- ~~"23 walks, 92 artifacts"~~ **UNRECORDED.** The only durable record lists `evidence/ (8 entries)`.
  Do not cite the larger numbers.
- Whole v2 tree was untracked; now 4 local commits. **Origin is PUBLIC. No git hooks. Push URL live.**
- Yield: 16 typed / 220 cases; 134 of 204 gaps are `NO_TYPED_PREDICATE_FOR_KIND`.
- ~~"the deployed docx parser reads only word/document.xml"~~ **FALSE.** v2 reads footnotes,
  endnotes, headers/footers, and resolves the main part from the package
  (`extract/docx-blocks.ts:45-47, 353, 385-424`). **The real gap is Word auto-numbering**
  (`numbering.xml` never parsed).
- ~~"option-set is a missing PAYLOAD, not a missing predicate"~~ **FALSE on both halves.** No
  predicate (`PREDICATE_FOR_KIND` = route+boundary only) and no field to carry an option list
  (`RawExpansion`, `FacetCase` both lack it).
- ~~"completion.test flips to complete over pending verdicts"~~ **HALF-FALSE.** `testAxisBlockers`
  DOES block on pending and every unsettled bucket. The residue is narrower: **`insufficient`
  verdicts on *exercised* cases do not block `complete`.**
- Model verifier: not wired, and its never-`violated` property is a **documented, owner-approved
  invariant** ("a fabricated defect is the worse error by a wide margin") — not an oversight.
- Edge coverage: dead on the deployed baseline (`structure: "none"`), and structurally unable to
  reach 100% where any fallthrough edge exists (`sources: []`).
- **Reviewer conflict adjudicated:** corpus100 dev surveys E18/M83 **exist and are built** —
  verified by directory listing (this session) and by grep (two reviewers). The "directories are
  empty" claim cites a stale doc and is rejected.

---

## FIVE fabrication paths (v1 named two)

| # | Path | Status |
|---|---|---|
| 1 | Timeout read as rejection → false **defect** | open |
| 2 | Back-reference token read as screen identity → false **defect** | open |
| 3 | **False-PASS twin of #1** — slow-but-accepting site certifies a rule it doesn't enforce | open, unnamed in v1 |
| 4 | **Witness pollution** — `[aria-live]`, `[role=alert]`, cookie banners all count as validation | open |
| 5 | **Dormant producer-trust hole** — `structuralDecision` emits `contradicted` from the observation's own `error`/`contradiction` payload keys | dormant; **detonates when model-observations land** |

---

## PHASE 0 — trust surgery + free safety (no owner ruling needed; parallel with Phase 1)

**0.1 — The boundary outcome. ONE surgery, FOUR parts. Not a one-liner.**
v1 said "require a validation-message witness." That flips the other arm: a survey that rejects
*silently* (blocked advance, no message — a disabled Next button is common) would return
`BOUNDARY_NOT_REJECTED` → **violated** → a new confident false defect. Required shape:
1. **Tri-state**: advanced+no-message → accepted; no-advance+witness → rejected;
   no-advance+no-witness → **`insufficient`**, never a verdict.
2. **Delta-based, control-bound witness** — the message must have *appeared after this submit* and
   be tied to *this control*. Presence-based inherits the polluted selector (path #4).
3. **The walker records WHY it called the step blocked** (timed-out / validation-visible /
   control-disabled) so the verifier reads a witness instead of reconstructing one.
4. **Control attribution on multi-input screens** — the driver types the boundary value into every
   empty text control and the predicate reads screen-level messages; a sibling field's rejection is
   currently attributed to the documented boundary. *(From R2; no cross-validator carried it
   forward — do not let it fall between rounds.)*
Closes paths #1, #3, #4.

**0.2 — Screen identity. Shaped as a seam, with its price stated.**
The `violated` arm takes `alsoPresent[0]` with **no length check**, while the `satisfied` arm
refuses on ambiguity — the defect-claiming arm is the unguarded one. Fix demotes single-foreign-token
mismatches to `insufficient`. **Price, stated openly: this spends most of route's remaining
deterministic defect detection on id-sparse instruments.** Implement as a `screenIdentity(screen,
sealedIds)` seam that 0.4's **control-attribute binder** and a later composite binder fill — not as
predicate logic. *(v2 said "0.4's text binder"; see 0.4, rewritten.)* Closes path #2.

**0.3 — Close the dormant payload-trust hole (path #5).** `structuralDecision` must not derive a
verdict from producer-supplied `error`/`contradiction` keys. **Must land in Phase 0 or explicitly
before any model-observations work** — it detonates exactly when that work arrives.

**0.4 — CONTROL-ATTRIBUTE BINDER (rewritten in v2.1; this is what makes Phase 2 possible).**

> **v2's premise here was FALSE.** v2 said *"sealed question text is already in the contract"* and
> prescribed a normalized question-text match. A validator proved it false: **no question-stem field
> exists anywhere in the sealed revision.** `displayQuote` is the *requirement's* source prose, not
> the question's on-screen stem. A text-match binder therefore has nothing on the sealed side to
> match against, and would have needed a schema revision plus a full re-extraction before it could
> bind a single screen.

**The actual first rung, using data we already capture:** extend the `screenIdentity` seam (0.2) to
consider **control attributes** in addition to rendered text.

1. **Exact `name` match.** A control's `name` equals a sealed question id → that screen presents
   that question. `page-script.ts:122-123` already records `name` per control; `survey.js:367`
   emits `name="' + page.id + '"` — the sealed id, unmangled.
2. **`id` prefix.** `survey.js:367` also emits `id="' + page.id + '_' + o.code + '"`, carrying the
   sealed id as a clean prefix before the option code — usable when `name` is absent.
3. **Same fail-closed rule as today.** More than one *distinct* sealed id across a screen's controls
   → the screen has not identified itself → `insufficient`, never a verdict. Identical to the
   existing multi-token refusal, just over a second field.

**Cost: deterministic, no schema change, no re-extraction, no new capture.** The bytes are already in
the artifacts on disk. This is a read-side change to one seam.

**Wire it through BOTH call sites** — `stepsOnTargetQuestion` (`verify-observations.ts:459`) **and**
the destination-identity check (`~verify-observations.ts:610`, the `tokenOnScreen(reached, wanted)` /
`otherSealedIdsOnScreen` pair). A validator warned specifically that wiring only one reproduces the
null yield: a case that binds its origin screen but cannot identify its destination still exits
`insufficient`, and the run still teaches nothing.

**THE HONEST CAVEAT, stated because the north star requires it.** "`name` equals the sealed id" is
*also* a convention. A real platform may emit `name="QID12_4"`, a GUID, or nothing at all. So this rung makes
**t1-easy runnable** — it does **not** satisfy "works for ANY survey + link". It buys a measurable
Phase 2 instead of a null one, and nothing more. **Phase 2 Run 3 (E18, no ids anywhere) is precisely
the measurement that prices what this does NOT solve**, and it must be run and reported as such
under 0.6's detection requirement.

**Later rung, no longer a Phase 0 blocker: the sealed-stem ledger.** Carrying question stems on the
sealed revision so a text binder becomes possible is still worth doing — as **one more field inside
3.0's single schema revision**, batched with 3.1/3.2/3.4 so it costs a share of one re-extraction
rather than a whole one of its own.

**0.5 — Report vocabulary.** Scope to projection/report only — **not the gate**, which already
blocks on pending. The residue is `insufficient`-on-exercised. Agree the end-state vocabulary here
so Phase 3.3's provenance-split *extends* rather than renames it.

**0.6 — Detection, not just degradation (north-star requirement).** Report "N of M screens printed
a self-id; below threshold this instrument is outside the current binder envelope." Converts the
ceiling into a *named, detected* limitation now.

**0.7 — ~~Free safety, no rulings~~ — BOTH ITEMS WERE ALREADY RULED ON. See
[`docs/OWNER-RULINGS.md`](OWNER-RULINGS.md).** v2 filed these as "no ruling needed"; both had in fact
been decided, and one had been decided *against*.
- ~~Set AI Gateway `spend_limits`~~ — **DECLINED AS MOOT (2 Aug).** Grok and DeepSeek are prepaid;
  there is no runaway spend to cap. **Do not re-raise.**
- ~~Push the commits to a private mirror or git bundle~~ — **DEFERRED by the owner (8 Aug).** The
  underlying risk is real (the only copy of a live deployment's source, on one disk) but acting on
  it needs a fresh ruling. Do not do it under this plan's authority.

**0.8 — Standards:** every fix ships with a negative fixture and a baseline-aware mutant. This is
verifier-arm surgery — the exact class where this repo has shipped vacuous tests before.

---

## PHASE 1 — rulings, REORGANIZED BY WHAT EACH ACTUALLY GATES

**Gates the run (must decide before Phase 2):**
- **Seal-gate policy.** `sealContract` refuses unless all four gates pass and
  `unexplainedNormativeBlocks === 0`, with **no override in the gate path**. It historically refused
  on the real 353-block questionnaire (10 loose ends). Strict, or proceed-with-named-gaps? If
  strict, `extraction-not-approved` is a *pre-declared acceptable Phase 2 outcome*.

**Gates the push (not the run):**
- Gateway identifiers: rotate/authenticate/move-to-secrets, or accept publication.
- **The leak surface is UNTRACKED KEY-DERIVED PROSE, not the README's scoring lines** *(corrected in
  v2.1 — v2 aimed this bullet at the wrong files).* Stripping a few README lines is cosmetic. The
  material that actually encodes answer-key knowledge is **not in the four commits at all**, so a
  sweep of those commits would not find any of it:
  - `pipeline/runs/t1-easy/DEBRIEF.md` — **untracked**; republishes the full seed table with
    per-seed difficulty and the key's trap list. Written after opening `truth/`, and says so.
  - `pipeline/judge/VERIFICATION*.md` — **untracked**; states outright that it read the answer key
    and seeded-defect files.
  - The **uncommitted README hunk** carrying t1-easy scoring prose (`README.md` is tracked; the
    scoring lines are in the working-tree diff, not in any commit — `git grep t1-easy origin/master`
    returns nothing).
  - **This plan and every local commit, including the v2.1 commit itself.** The prediction below
    names seeded-defect IDs and classes, which is key-derived knowledge one hop removed.
  **The push gate is therefore: an identifier + blind-material sweep of ALL local commits *and* of
  every untracked key-derived file, before anything is staged** — not a sweep of four commits.
  (~800 files were never swept; only `DEPLOYED.md` was hand-sanitised.)
- **Push: yes/no, gated on the sweep above.**

**Gates Phase 3.3 only:**
- **Model verifier two-sidedness.** Note precisely: this asks you to **revisit a documented,
  owner-approved safety invariant**, and a model-attested `violated` requires slot identity — i.e.
  it is **coupled to the binder**, not an independent rung. The 2 Aug **ENABLE** ruling and its model
  policy are recorded in [`docs/OWNER-RULINGS.md`](OWNER-RULINGS.md) — cite that file, do not assert
  rulings inline *(v2 asserted this one with no durable record anywhere; the only trace on disk
  showed it requested and recommended, not granted)*. ENABLE settles that the verifier runs. **The
  two-sidedness question is separate and still open.**

**Gates publishability only (not the run):**
- Target-build-id. A null value is **legal**; it makes judgements diagnostic-only.

**Owner-direction reversals, promoted out of STOP DOING** (they were buried as operational):
- Stop corpus batches 2-7? — reverses your 100-survey program.
- Freeze the four-arm ablation? — reverses a pre-registered study.

---

## PHASE 2 — THREE runs, one deploy, one pre-registered prediction

**Precondition (missing from v1): DEPLOY and confirm the served version id ≠ `823be409`.** v1 would
have run the unfixed code and read the output as if fixed.

**Run 1 — t1-easy (seeded).** Plumbing + real extraction + the binder actually binding.
**Run 2 — a clean control** (open branching corpus has clean variants). **This is the metric the
project's own frozen pre-registration calls "the headline safety number, stated in the report
headline regardless of what recall did."** v1 measured it nowhere.
**Run 3 — E18** (no question id anywhere in the DOM; already built in the dev split). Prices the
binder ceiling as a *reason histogram* rather than a claim.

> ### OPEN — **BLOCKS THE EXIT CRITERION** (found in v2.1's correction round, verified)
> **The judge engine cannot parse v2 walk artifacts at all.**
> `grep -rl "v2-path-observation\|PathObservation" pipeline/ scorer/` returns **nothing**. The
> `PathObservation` type exists only inside `worker-v2/`; the offline judge engine has no reader for
> it. Every Phase 2 exit criterion below assumes a judgement over v2 walks that nothing currently
> produces. **Not fixed here — this is a separate piece of work** — but it must be named before the
> run, not discovered during it, and it is the reason the prediction carries an assessed-row floor.

**PRE-REGISTERED PREDICTION — fully determined, and NOT a blind measurement.**

*(Corrected in v2.1. v2 wrote "two leaked, third class unknown → ceiling ~1/3" and claimed the
derivation was made without opening `truth/`. Both halves were wrong: all three classes are known to
us, and the knowledge is **not public**.)*

**Provenance, stated plainly.** t1-easy is **owner-retired** material under retire-and-replenish. Its
seeded-defect classes are known to us from **key-derived local analysis** — untracked prose written
after opening the answer key — **not** from anything public. Therefore:

> **Run 1 is CALIBRATION on a retired instrument, not a blind measurement. Its recall must NEVER be
> quoted as detection evidence, in the report headline or anywhere else. The blind measurements in
> this phase are Run 2 (clean control) and Run 3 (E18).**

The prediction is fully determined — a fake forecast is worse than an honest one:

| Seed | Class | Reachable under Phase 2 predicates? |
|---|---|---|
| **T1-D2** | route | **Yes — iff 0.4 lands.** The only one in reach, and only because of the binder. |
| **T1-D1** | option | **No — unreachable until 3.1.** No option-set predicate and no field to carry an option list. |
| **T1-D3** | label/copy | **No — unreachable, no predicate exists.** Nothing in route+boundary can see copy. |

**Predicted Run 1 recall: exactly 1 of 3.** Not "~1/3" — 1/3, determined.

- **Assessed-row floor:** Run 1's attested judgement must show **at least one assessed row**. **Zero
  assessed means the run measured the judge-evidence gap above, not the binder** — a different
  experiment with a different conclusion, and it must be reported as that.
- **HARD BAR, unchanged: ZERO fabricated defects, on all three runs.** A defect assertion on the
  clean control is a failure **regardless of recall**.

Without this, Phase 2 is itself a check that cannot fail.

**Exit criterion (restated — v1's was arithmetically impossible):** a trustworthy report, real
extraction, an honest reason histogram, and the defects route/boundary can actually see. **Not**
"decides most of its rows" — that requires Phase 3.

---

## PHASE 3 — the DECISION ladder (renamed from "yield")

*A pass that could not have failed is not a pass.* Order by **two-sided decisions added**.

**3.0 — Batch the seal-schema changes into ONE revision.** 3.1, 3.2 and 3.4 each change
prompts/coerce/`RawExpansion`/`FacetCase`/expander. Landed serially that is **three full
re-extractions**, three fixture migrations, three rounds of suite churn.

**3.1 — Option-set.** Biggest *deterministic defect* lever. **A week-shaped rung**, not payload
plumbing: prompts + coerce + two type changes + expander + a NEW predicate + report vocabulary +
re-extraction. **Named sub-dependency:** the absence guard keys on walk outcome `completed`, which
**the driver can never emit** (every loop exit overwrites it). Without fixing that, the pass arm
returns `insufficient` and this rung delivers defect detection and **zero** certification yield.

**3.2 — Selection-count.** ~38 cases/doc, both arms, no model. Understated in v1: needs a **new
planned action** through plan-core, `materializeCasePaths` and `applyDecision` — driver capability
work.

**3.3 — Model verifier**, last to land (may be built in parallel), with the flags lane and
provenance-split reporting from day one. Blocked on the Phase 1 two-sidedness ruling and coupled to
the binder.

**3.4 — RESOLVED-provenance destination binding** for relative destinations.

**3.5 — Planner-native checklist sidecar** *(missing from v1 entirely; possibly the cheapest rung)*.
`plan.ts` reads a checklist key written **only by dev endpoints**, so every real run plans from a
thin mapping with no stimulus lines and the judge runs with ambiguity-withholding disarmed.
**Land this BEFORE baselining the ladder** or every rung's measured delta is confounded.

**3.6 — Drive code-only route cases.** `case_action` is consumed only by `pathSignature`; the driver
matches by label alone, so a code-only route case is never performed and reports
`ROUTE_ANSWER_NOT_SELECTED` — indistinguishable from a genuine miss.

---

## PHASE 4 — generalizability

Composite binder (**control attributes from 0.4** + sealed stems once 3.0 carries them + option
fingerprint + graph position — **note: graph position requires `structure: "routing-graph"`,
hard-defaulted OFF**). Then the remaining convention-stress surveys. E18 has already been measured in
Phase 2, and that measurement is what prices how much of this phase is actually needed.

---

## STOP DOING — with carve-outs and a re-entry trigger

- Corpus batches 2-7. **CARVE-OUT: the already-built 10-survey gate set is exempt and must not rot.**
  **Re-entry trigger:** resume when the deployed system produces two-sided decisions on a majority
  of gate-set rows with zero fabrications.
- The four-arm ablation as an active workstream — **freeze the pre-registration as-is, do not delete.**
- Writing status documents faster than committing code.
- **NOT stopped (v1 banned these by accident):** the mutation harness stays — new predicates arrive
  in Phase 3 and this repo's own rule is that new gates ship with evidence they can fail.

**Per-bug dispositions** (v1 named these and scheduled none):
| Bug | Disposition |
|---|---|
| Edge coverage can't reach 100% (empty-source fallthroughs) | Fix before quoting the number, or don't quote it |
| Edge coverage dead on deployed baseline | Accept, or wire `structure` — decide before Phase 4 |
| Label-only driver matching | Phase 3.6 |
| English next-button regex | Accept + name the limitation (falls back to "only non-back button") |
| 40-step cap all-or-nothing | Accept for t1-easy (env-tunable); revisit for long surveys |
| Word auto-numbering unparsed | Defer; name it |
| **"10 lying comments" (R4)** — acknowledged in the inventory, scheduled nowhere until v2.1 | **Phase 3.5.** Live and confirmed: `worker-v2/src/workflow/stages/checklist-store.ts:11` states the extraction stage writes the checklist to `v2/runs/<id>/checklist.json` — **no extraction code calls `writeRunChecklist`**; the only caller is `api/devseed.ts:177`. `checklist-projection.mjs` repeats the same false claim. The comment documents the exact mechanism 3.5 fixes, so the stale-comment sweep rides with 3.5 and the comment becomes true instead of being deleted. |

---

## The bet (restated)

**Not** one report. **Three runs and a prediction**: the seeded survey proves the plumbing, the clean
control proves we don't invent defects, and E18 prices the ceiling — with the expected result written
down first. That is the smallest unit of evidence that "works for ANY survey + link" is a live claim
rather than a slogan.

---

## Changes from v1 — every finding, and where it landed

| Finding | Source | Landed |
|---|---|---|
| t1-easy prints no ids → Phase 2 yields zero | X5 + verified by hand | **Decisive finding**; binder promoted to 0.4 |
| Phase 0.1 one-liner ships a new fabrication path | X4 | 0.1, four-part surgery |
| False-PASS twin of the timeout bug | X3 | 0.1 tri-state |
| Witness pollution (`[aria-live]` etc.) | X3 | 0.1 part 2 |
| Dormant `structuralDecision` payload-trust hole | X3 | **0.3**, must precede model work |
| Control attribution on multi-input screens | R2 | 0.1 part 4 |
| `violated` arm has no length check | X4 | 0.2 |
| 0.2's price: route defect yield → ~0 | X4 | Stated in 0.2 |
| Option-set: no predicate AND no field | X2, X3 | Ground truth + 3.1 as a week-rung |
| Absence guard keys on unreachable `completed` | X3 | 3.1 named sub-dependency |
| Binder dependency runs the other way | X2 | 0.4 + 3.1 ordering |
| Three schema changes → 3 re-extractions | X2 | **3.0** batching |
| Planner sidecar written only by dev endpoints | X2 | **3.5** |
| `case_action` never driven | X2 | **3.6** |
| No clean control anywhere | X3 | **Phase 2 run 2** |
| Convention-stress already built | X1, X2 | **Phase 2 run 3** |
| Unit of proof is a pair | X1 | Three runs |
| "yield" contradicts the pre-registration | X1, X3 | Renamed **decision ladder** |
| Phase 2 is a check that cannot fail | X4 | **Pre-registered prediction** |
| "Decides most of its rows" impossible | X2 | Exit criterion restated |
| Missing deploy step | X2, X3, X4 | Phase 2 precondition |
| Phase 1 gates the wrong things | X2, X4 | Rulings reorganized by what each gates |
| Seal gate can kill the run | X4 | Promoted to gates-the-run |
| Edge spend uncapped, submit live | X4 | **0.7**, no ruling needed |
| Off-machine backup missing | X4 | 0.7 |
| Owner reversals hidden in STOP DOING | X4 | Promoted to Phase 1 |
| STOP banned the fixes the plan demands | X4 | Per-bug disposition table |
| Mutation harness retired as predicates arrive | X3 | STOP carve-out |
| Gate-set exempt + re-entry trigger | X1 | STOP carve-outs |
| Phase 0 ∥ Phase 1, not sequence | X2 | Stated in Phase 0 header |
| Never-`violated` is a deliberate invariant | X3, X4 | Ground truth + Phase 1 framing |
| Parser reads more than document.xml | X3, X4 | Ground truth struck |
| "23 walks / 92 artifacts" unrecorded | X4 | Ground truth struck |
| `completion.test` half-false | X4 | Ground truth + 0.5 rescoped |
| Self-id detection as a named limitation | X4 | **0.6** |
| corpus100 "empty" vs built | X2 vs X4 | **Adjudicated: built** |
| No git hooks; push is convention only | X3 | Phase 1 push ruling + 0.7 |
| Plan lived in a scratchpad | X4 | ~~"This file is committed to `docs/`"~~ **FALSE when v2 wrote it** — the file was **untracked** (`git status` showed `??`), which is precisely the STOP-DOING item about documents outrunning commits, committed by the document that names it. **True as of v2.1: committed in the v2.1 commit.** |

---

## Changes from v2 → v2.1 — the second correction round

| Finding | Landed |
|---|---|
| **0.4's premise was FALSE** — no question-stem field exists in the sealed revision; `displayQuote` is the requirement's source prose, so a text binder had nothing to match | **0.4 rewritten**: control-`name`/`id`-prefix binder, deterministic, no schema change, no re-extraction, both call sites; sealed-stem ledger demoted into 3.0's batch |
| Ids ARE in the artifact (`page-script.ts:122-123` captures `name`/`id`); the binder just never reads them | Decisive-finding **amendment** |
| Binder rung is a convention too — makes t1-easy runnable, not the north star satisfied | Caveat stated in 0.4; Run 3/E18 named as the price-check |
| Partial wiring reproduces null yield | 0.4 names **both** call sites explicitly |
| Prediction claimed blindness it does not have; classes are key-derived, **not public** (`DEBRIEF.md` is untracked; `git grep t1-easy origin/master` → nothing) | Prediction **reframed as calibration on a retired instrument**; Run 1 recall never quotable as detection evidence |
| "Third class unknown" was false — all three classes are known | Prediction **fully determined: exactly 1/3** |
| Leak surface aimed at README scoring lines | **Replaced**: sweep untracked key-derived prose (`DEBRIEF.md`, `VERIFICATION*.md`), the uncommitted README hunk, and **all local commits including this one** |
| Judge engine has no `PathObservation`/v2-walk reader | **New OPEN blocker** at Phase 2 + assessed-row floor in the prediction |
| R4's "10 lying comments" scheduled nowhere | **Disposition row → Phase 3.5** |
| 0.7 proposed two actions the owner had already ruled on (cap declined as moot; bundle deferred) | **0.7 struck and re-pointed** at `docs/OWNER-RULINGS.md` |
| Rulings asserted inline with no durable record | **`docs/OWNER-RULINGS.md` created**; Phase 1 cites it |
| "This file is committed to `docs/`" was false | Row corrected; **made true by the v2.1 commit** |

**Three v1 findings that vanished in v2 with no disposition — now dispositioned:**

| v1 finding | Disposition in v2.1 |
|---|---|
| **(a)** Passes A and B are designed disjoint, so per-question detail gets no semantic cross-validation | **CARRIED FORWARD, AMENDED — partly wrong as stated.** `worker-v2/src/extract/merge.ts` **does** align the two passes and mark irreconcilable readings `disputed` (`merge.ts:15, 246, 295, 330-335`), so the cross-validation mechanism exists. The *empirical* problem is that it almost never fires: `docs/SESSION-HANDOFF-2AUG.md` records **only 3 of 226 rows found by both passes**, with the diagnosis (disjoint-by-design vs dead matcher vs hallucination) still open and explicitly listed as cheap and worth doing **before trusting the contract**. Keep it as a pre-Phase-2 diagnostic, not as an architecture claim. |
| **(b)** Phase 2 should baseline against the offline judge's 3/3 seeded recall (`README.md:137`) | **DROPPED, deliberately — superseded by the pre-registered prediction.** Saying so because a silent drop is what this table exists to prevent. Two reasons it should not come back: the 3/3 was produced by re-deriving verdicts from already-collected artifacts *with the answer key in hand*, and t1-easy recall is now classified as calibration on a retired instrument, so it is not a baseline anything should be scored against. |
| **(c)** Target-build-id: v1 asked to "accept a derivation or name a scheme"; v2 reframed it | **CARRIED FORWARD as the reframing, noted here because the reframe was silent.** Current position (Phase 1, gates publishability only): **a null value is legal**; it makes judgements **diagnostic-only** rather than blocking a run. That is a genuine loosening of v1's demand, and it is the position in force. |
