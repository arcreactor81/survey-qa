/**
 * D31 — THE TWO NUMBERS RUN v2r_01kzfb6py8pbxznqv022p2qkhb PUBLISHED, AND WHY BOTH WERE WRONG.
 *
 * That run reported "committed 8 observation(s) from 8 of 46 walk(s)",
 * `completion.test = partial-blocked` and `reasonCode = walks-blocked-by-site`. Its own
 * execution ledger says the site refused NOTHING: 41 of the 46 walks drove the survey to its
 * terminal screen, advancing 11–13 screens each. Two independent defects produced that:
 *
 *   DEFECT 1 — THE DENOMINATOR. The gate read
 *   `walkExercised(obs) && (plannedDecisions === 0 || matchedDecisions > 0)`. But 515 of the
 *   585 decisions that plan emitted were `{ select: [], source: "default:navigator-discretion" }`
 *   — the planner explicitly delegating the choice — and the driver's `navigator-default` then
 *   does exactly what was delegated. Counting those as "unmatched" disqualified walks for
 *   failing to obey instructions that instructed nothing.
 *
 *   DEFECT 2 — THE ACCUSATION. `walks-blocked-by-site` was emitted from
 *   `done && pending > 0 && stopReason === null`, which is "cases are still owed an
 *   observation" and NOTHING ELSE. It cannot distinguish "the site refused us" from "our own
 *   gate disqualified walks that did everything asked of them", and it published the former
 *   about a healthy customer survey. Per CLAUDE.md that is the cardinal failure class.
 *
 * ==================== WHY THIS FILE IS SHAPED THE WAY IT IS ====================
 *
 * Loosening a coverage gate is how this project produced false confidence before: the first
 * live run marked all 119 mandatory cases `exercised` off four walks that never got past a
 * blank first screen. So the tests below are deliberately weighted toward the NEGATIVE
 * direction — a gate that cannot fail is worthless however green it is:
 *
 *   - the hard floor (`walkExercised`) has its own counterweights, and they use the REAL
 *     load-crash and time-cap records from the run above rather than invented ones;
 *   - the SEALED STIMULUS case is the one a naive "empty `select` means unconstrained" rule
 *     gets catastrophically wrong, and it has both arms (unapplied → not exercised, applied →
 *     exercised) so a broken predicate cannot pass by always saying no;
 *   - the accusation has a counterweight too. A `walks-blocked-by-site` that can never fire
 *     is the same disease inverted, so a genuinely blocked walk MUST still produce it.
 *
 * Evidence these can fail: `tools/mutate-exercised-gate.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE REAL RUN, ON DISK. `walks` is `v2/runs/<id>/execution/progress.json .walks` verbatim
 * (all 46 WalkRecords); `decisionsByPath` is the `decisions` array of every path in
 * `v2/runs/<id>/plan/plan_hnjpwq5vfhng.json` verbatim. Nothing in it is invented, which is
 * the only reason the before/after numbers below mean anything.
 */
const REAL = JSON.parse(readFileSync(path.join(HERE, "../fixtures/real-run-v2r01kzfb6p-execution.json"), "utf8"));

// ---------------------------------------------------------------------------
// Observation builders. Small, and each field is one the gate actually reads.
// ---------------------------------------------------------------------------

const step = ({ advanced = true, source = "navigator-default", question = null, blockedReason = null } = {}) => ({
  stepIndex: 0,
  decisionQuestion: question,
  decisionSource: source,
  requested: null,
  screenBefore: null,
  screenAfterAction: null,
  screenAfterAdvance: null,
  actions: [],
  requestedButNotOffered: [],
  advanced,
  blocked: !advanced,
  blockedReason,
  pageErrors: [],
  consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 5,
});

const obs = ({ outcome = "no-advance-control", steps = [step()], loadFailure = null } = {}) => ({
  kind: "v2-path-observation/1.0.0",
  runId: "v2r_test",
  pathId: "FLOOR-01",
  tier: 1,
  attemptId: "att_test",
  planRevisionId: "plan_test",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:00:00.000Z",
  endedAt: "2026-08-08T00:00:10.000Z",
  wallMs: 10,
  plannedWitnesses: [],
  steps,
  outcome,
  outcomeDetail: null,
  shimmed: false,
  shimNote: null,
  loadFailure,
  evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

/** The exact shape the planner emits when it cannot name an answer. Real, from the run. */
const delegated = (question) => ({
  question,
  select: [],
  source: "default:navigator-discretion",
  strategy: "navigator:choose-the-first-valid-answer",
  note: "the contract never enumerates this question's answers, so the planner cannot name one",
});

/** A delegated decision that ALSO carries the driver's own filler as its text value. */
const delegatedText = (question) => ({ ...delegated(question), strategy: "text:enter-short-valid-text", text_entry: { required: true, value: "QA-PROBE" } });

/** A sealed route stimulus whose answer LABEL the contract never gave. `select` is empty. */
const sealedRouteNoLabel = (question, code) => ({
  question,
  select: [],
  source: `typed-case:fi_${question}`,
  strategy: "navigator:choose-the-first-valid-answer",
  case_action: {
    facetInstanceId: `fi_${question}`,
    targetQuestionId: question,
    kind: "route",
    routeAnswer: { code, label: null },
    boundaryInput: null,
  },
});

const probe = (question) => ({ ...delegated(question), action: "submit-without-answering", note: "PROBE" });

const walkRec = (over = {}) => ({
  pathId: "FLOOR-01",
  tier: 1,
  attemptId: "att_x",
  outcome: "no-advance-control",
  outcomeDetail: null,
  steps: 3,
  wallMs: 10,
  shimmed: false,
  loadCrash: false,
  evidenceCount: 0,
  caseIds: [],
  exercised: true,
  plannedDecisions: 0,
  matchedDecisions: 0,
  constrainingDecisions: 0,
  matchedConstraining: 0,
  screensAdvanced: 3,
  blockedSteps: 0,
  at: "2026-08-08T00:00:00.000Z",
  ...over,
});

// ===========================================================================
suite("D31 — the exercised gate counts CONSTRAINING decisions, not delegated ones", () => {
  test("THE FIX: a walk whose plan delegated EVERY choice is exercised once it walked the survey", async () => {
    const mod = await worker();
    // 13 decisions, all `select: []` + `source: default:navigator-discretion` — the exact
    // census of every exploration path in the real run. Nothing bound, because there was
    // nothing to bind: the walk did precisely what the plan asked.
    const plan = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "S1", "S2", "C10", "D1"].map(delegated);
    const walk = obs({ steps: [step(), step(), step(), step({ advanced: false, blockedReason: "no-advance-control" })] });

    const a = mod.executeBatch.assessExercised(walk, plan);
    assertEq(a.plannedDecisions, 13, "the plan really did list 13 decisions");
    assertEq(a.constrainingDecisions, 0, "and not one of them constrains anything");
    assertEq(a.matchedConstraining, 0);
    assertEq(a.exercised, true, "so the walk that drove the survey to its end IS exercised");

    // The old gate is what this replaces, spelled out so the difference is not a matter of
    // opinion: `matchedDecisions === 0`, so `plannedDecisions === 0 || matchedDecisions > 0`
    // was false and this walk was thrown away.
    assertEq(a.matchedDecisions, 0, "the old numerator: zero — which is why it was disqualified");
  });

  test("THE SEALED STIMULUS THAT NEVER RAN is NOT exercised — even though its `select` is empty", async () => {
    const mod = await worker();
    // A route case whose documented answer LABEL is null carries an EMPTY `select` and IS
    // the entire point of the walk. A rule that read "empty select ⇒ unconstrained" would
    // close this case on whatever option the navigator happened to click first — a closed
    // case whose stimulus never ran, which is the 119 incident wearing a plausible costume.
    const plan = [delegated("Q1"), sealedRouteNoLabel("S2", "2"), delegated("C10")];
    const walk = obs({ steps: [step(), step(), step(), step({ advanced: false, blockedReason: "no-advance-control" })] });

    const a = mod.executeBatch.assessExercised(walk, plan);
    assertEq(a.constrainingDecisions, 1, "the sealed stimulus constrains, whatever `select` says");
    assertEq(a.matchedConstraining, 0, "and nothing applied it");
    assertEq(a.exercised, false, "so the case must stay OPEN");
  });

  test("...and the SAME walk with the stimulus applied IS exercised — the predicate is not just saying no", async () => {
    const mod = await worker();
    const plan = [delegated("Q1"), sealedRouteNoLabel("S2", "2"), delegated("C10")];
    const walk = obs({
      steps: [step(), step({ source: "plan", question: "S2" }), step({ advanced: false, blockedReason: "no-advance-control" })],
    });

    const a = mod.executeBatch.assessExercised(walk, plan);
    assertEq(a.matchedConstraining, 1);
    assertEq(a.exercised, true);
  });

  test("A MATCHED DELEGATED DECISION does not satisfy a constraining denominator", async () => {
    const mod = await worker();
    // The asymmetry that makes a `requested`-sniffing numerator wrong: the driver records
    // `requested.textEntry = "QA-PROBE"` for a delegated text decision, which LOOKS like an
    // instruction and is the driver's own filler. It binds — `decisionSource: "plan"` — and
    // it must not count toward the sealed stimulus the walk still owes.
    const plan = [delegatedText("Q8"), sealedRouteNoLabel("S2", "2")];
    const walk = obs({
      steps: [step({ source: "plan", question: "Q8" }), step({ advanced: false, blockedReason: "no-advance-control" })],
    });

    const a = mod.executeBatch.assessExercised(walk, plan);
    assertEq(a.matchedDecisions, 1, "a decision really did bind");
    assertEq(a.constrainingDecisions, 1, "but the only CONSTRAINING one is the sealed stimulus");
    assertEq(a.matchedConstraining, 0, "which is not the one that bound");
    assertEq(a.exercised, false);
  });

  test("A PROBE IS A CONSTRAINT: it deviates from the default, so an unbound probe never happened", async () => {
    const mod = await worker();
    const plan = [delegated("Q1"), probe("Q8")];
    assertEq(mod.executeBatch.assessExercised(obs(), plan).constrainingDecisions, 1);
    assertEq(mod.executeBatch.assessExercised(obs(), plan).exercised, false, "unbound probe ⇒ not exercised");

    const ran = obs({ steps: [step({ source: "probe", question: "Q8" }), step({ advanced: false })] });
    assertEq(mod.executeBatch.assessExercised(ran, plan).exercised, true);
  });

  test("ONE constraining match is enough — a route that ENDS the survey must not be punished for obeying", async () => {
    const mod = await worker();
    // The real FLOOR-01--fi_8e1bf66783d8308bf028: "I never drink coffee at home" screens the
    // respondent out after 3 screens, so the path's later decisions are unreachable BY
    // DESIGN. Demanding all of them would disqualify the walk for doing what it was told.
    const plan = [sealedRouteNoLabel("S2", "6"), sealedRouteNoLabel("Q7", "1")];
    const walk = obs({ steps: [step({ source: "plan", question: "S2" }), step({ advanced: false, blockedReason: "no-advance-control" })] });

    const a = mod.executeBatch.assessExercised(walk, plan);
    assertEq(a.constrainingDecisions, 2);
    assertEq(a.matchedConstraining, 1);
    assertEq(a.exercised, true);
  });

  test("AN UNRECOGNISED PLANNER DEGRADES STRICT: a text value with no `default:` source constrains", async () => {
    const mod = await worker();
    // CLAUDE.md's north star: no silent reliance on a convention. The `default:` prefix is
    // how OUR planner declares a decision is its own filler. A planner that does not use it
    // can only make this gate harder to pass, never easier.
    const unknown = { question: "Q8", select: [], source: "some-future-planner", text_entry: { required: true, value: "ACME" } };
    assertEq(mod.executeBatch.isConstrainingDecision(unknown), true);
    assertEq(mod.executeBatch.isConstrainingDecision({ ...unknown, source: "default:navigator-discretion" }), false);
  });
});

// ===========================================================================
suite("D31 — the hard floor is UNCHANGED (the counterweights)", () => {
  test("A WALK THAT DID NOTHING is not exercised, however little the plan asked of it", async () => {
    const mod = await worker();
    // THE 119 INCIDENT, REPRODUCED. Four walks never got past a blank first screen and the
    // executor closed every mandatory case anyway. With zero constraining decisions the new
    // gate reduces to `walkExercised`, and `walkExercised` is what stops this — so this test
    // is the one that must never be allowed to go green by accident.
    const blank = obs({ outcome: "no-advance-control", steps: [step({ advanced: false, blockedReason: "no-advance-control" })] });
    assertEq(mod.executeBatch.walkExercised(blank), false, "no screen advanced");
    assertEq(mod.executeBatch.assessExercised(blank, []).exercised, false);
    assertEq(mod.executeBatch.assessExercised(blank, [delegated("Q1")]).exercised, false);
  });

  test("A LOAD CRASH is not exercised — from the run's OWN first record", async () => {
    const mod = await worker();
    const real = REAL.walks.find((w) => w.loadCrash);
    assert(real, "the real run's first walk crashed on load");
    assertEq(real.screensAdvanced, 0);
    const crashed = obs({ outcome: "load-crash", steps: [], loadFailure: { message: real.outcomeDetail, stack: null, capturedAt: real.at } });
    assertEq(mod.executeBatch.assessExercised(crashed, []).exercised, false);
  });

  test("A WALK CAPPED MID-SURVEY is not exercised, even after ten screens", async () => {
    const mod = await worker();
    // The real `time-cap` records advanced 1–11 screens and never reached the end. Advancing
    // is not finishing, and a path's cases are not all observed until it finishes.
    const capped = REAL.walks.filter((w) => w.outcome === "time-cap");
    assert(capped.length === 4, `the real run has 4 time-cap walks, got ${capped.length}`);
    assert(
      capped.some((w) => w.screensAdvanced >= 10),
      "at least one got deep into the survey — which is exactly why the floor is the OUTCOME, not the depth",
    );
    const walk = obs({ outcome: "time-cap", steps: [step(), step(), step()] });
    assertEq(mod.executeBatch.walkExercised(walk), false);
    assertEq(mod.executeBatch.assessExercised(walk, []).exercised, false, "zero constraining decisions does not buy a pass");
  });
});

// ===========================================================================
suite("D31 — the real 46 walks, replayed through the new gate", () => {
  /**
   * WHAT CAN AND CANNOT BE MEASURED FROM THE LEDGER. A `WalkRecord` carries counts, not steps,
   * and the per-attempt observations were never written to R2 — so `matchedConstraining` is
   * recoverable exactly for the 38 walks with `matchedDecisions === 0` (it must be 0) and
   * BOUNDED for the 8 with `matchedDecisions === 1`. Both bounds are asserted rather than one
   * being quietly chosen: `pessimistic` assumes no constraining decision ever bound,
   * `optimistic` assumes the single bound decision was the constraining one.
   */
  const replay = (mod, mode) =>
    REAL.walks.filter((w) => {
      const constrained = mod.executeBatch.constrainingQuestions(REAL.decisionsByPath[w.pathId] ?? []);
      const floor = !w.loadCrash && (w.outcome === "completed" || w.outcome === "no-advance-control") && w.screensAdvanced > 0;
      const matched = mode === "optimistic" ? w.matchedDecisions : 0;
      return floor && (constrained.size === 0 || matched > 0);
    });

  test("BEFORE 8, AFTER 26 — and the hard floor says 41 walks reached the end of the survey", async () => {
    const mod = await worker();
    assertEq(REAL.walks.length, 46);
    assertEq(REAL.walks.filter((w) => w.exercised).length, 8, "what the run published");

    const floor = REAL.walks.filter(
      (w) => !w.loadCrash && (w.outcome === "completed" || w.outcome === "no-advance-control") && w.screensAdvanced > 0,
    );
    assertEq(floor.length, 41, "41 walks drove the survey to a terminal screen having advanced");

    assertEq(replay(mod, "optimistic").length, 26);
    assertEq(replay(mod, "pessimistic").length, 18, "the lower bound: even assuming NO stimulus ever bound");
  });

  test("EVERY walk that changes status is tier 2 — so the fix closes ZERO extra mandatory cases", async () => {
    const mod = await worker();
    // THE NUMBER THAT MATTERS, AND IT IS NOT 26. Tier-2 exploration walks are assigned no
    // cases at all (`assignment: null` ⇒ `closed = []`), so their `exercised` flag is an
    // audit fact and cannot move a coverage bucket. The 13 tier-1 walks that completed the
    // survey and stayed disqualified did so because their SEALED STIMULUS never bound —
    // a decision-binding defect this change deliberately does not paper over.
    const gained = replay(mod, "optimistic").filter((w) => !w.exercised);
    assertEq(gained.length, 18);
    assertEq(gained.filter((w) => w.tier === 2).length, 18, "not one of them is tier 1");

    const tier1After = replay(mod, "optimistic").filter((w) => w.tier === 1).length;
    assertEq(tier1After, 8, "tier-1 exercised is unchanged: 8 before, 8 after");
  });

  test("NOT ONE of the 46 walks disqualified by the old gate had ANY constraining decision matched", async () => {
    const mod = await worker();
    // The claim under the "optimistic" bound, stated so it can be checked: the 8 walks that
    // were already exercised are exactly the 8 with a bound decision, and every one of them
    // is on a path that HAS a constraining decision. If a future plan broke that, this fails.
    for (const w of REAL.walks.filter((x) => x.matchedDecisions > 0)) {
      const constrained = mod.executeBatch.constrainingQuestions(REAL.decisionsByPath[w.pathId] ?? []);
      assert(constrained.size > 0, `${w.pathId} bound a decision but the plan gave it nothing to bind`);
    }
    assertEq(REAL.walks.filter((w) => w.matchedDecisions > 0).length, 8);
  });
});

// ===========================================================================
suite("D31 — `walks-blocked-by-site` requires EVIDENCE of blocking", () => {
  test("THE RUN THAT STARTED THIS: 46 real walks, zero blocking evidence, no accusation", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.hasBlockingEvidence(REAL.walks), false, "the site refused nothing");
    assertEq(
      mod.executeBatch.resolveStopReason({ done: true, pendingCases: 111, stopReason: null, walks: REAL.walks }),
      "coverage-shortfall-unexercised",
      "our shortfall keeps our name on it",
    );
  });

  test("`no-advance-control` IS NOT BLOCKING — it is the survey ending", async () => {
    const mod = await worker();
    // 41 of the 46 ended this way after 11–13 screens. The final screen's Back/Next are
    // `visible: false`, so there is no enabled advance control — because there is nothing
    // left to advance to.
    const ending = REAL.walks.filter((w) => w.outcome === "no-advance-control");
    assertEq(ending.length, 41);
    assertEq(mod.executeBatch.hasBlockingEvidence(ending), false);
  });

  test("`advance-timeout` IS NOT BLOCKING — it is a lost polling race against a slow page", async () => {
    const mod = await worker();
    const timedOut = obs({ steps: [step({ advanced: false, blockedReason: "advance-timeout" })] });
    assertEq(mod.executeBatch.blockedStepCount(timedOut), 0);
  });

  test("COUNTERWEIGHT — a genuinely blocked walk STILL produces the accusation", async () => {
    const mod = await worker();
    // An accusation gate that can never accuse is the same disease inverted. A survey that
    // showed a validation message and would not move IS a blocked walk and must be named.
    const blockedWalk = walkRec({ outcome: "no-advance-control", blockedSteps: 1 });
    assertEq(mod.executeBatch.hasBlockingEvidence([blockedWalk]), true);
    assertEq(
      mod.executeBatch.resolveStopReason({ done: true, pendingCases: 4, stopReason: null, walks: [blockedWalk] }),
      "walks-blocked-by-site",
    );
  });

  test("COUNTERWEIGHT — a walk that ENDED `blocked` is evidence on its own", async () => {
    const mod = await worker();
    for (const outcome of ["blocked", "blocked-after-probe"]) {
      assertEq(mod.executeBatch.hasBlockingEvidence([walkRec({ outcome, blockedSteps: 0 })]), true, outcome);
    }
    assertEq(mod.executeBatch.hasBlockingEvidence([walkRec({ outcome: "time-cap", blockedSteps: 0 })]), false);
  });

  test("BOTH blocking reasons count, and only those two", async () => {
    const mod = await worker();
    assertEq(mod.executeBatch.blockedStepCount(obs({ steps: [step({ advanced: false, blockedReason: "validation-visible" })] })), 1);
    assertEq(mod.executeBatch.blockedStepCount(obs({ steps: [step({ advanced: false, blockedReason: "control-disabled" })] })), 1);
    assertEq(mod.executeBatch.blockedStepCount(obs({ steps: [step({ advanced: false, blockedReason: "no-advance-control" })] })), 0);
    assertEq(mod.executeBatch.blockedStepCount(obs({ steps: [step({ advanced: false, blockedReason: null })] })), 0);
    assertEq(mod.executeBatch.blockedStepCount(obs({ steps: [step({ advanced: false })] })), 0, "an artifact with no reason field at all");
  });

  test("OUR OWN PROBE IS NOT THE SITE'S FAULT: a probe blocked by validation is the survey WORKING", async () => {
    const mod = await worker();
    // EXP-018..022 submit a screen WITHOUT answering it, on purpose. A survey with correct
    // validation answers that with a message and refuses to advance — which is the site
    // behaving. Counting it would rebuild the false accusation out of our own misbehaviour.
    const probed = obs({ steps: [step({ advanced: false, source: "probe", question: "Q8", blockedReason: "validation-visible" })] });
    assertEq(mod.executeBatch.blockedStepCount(probed), 0);

    // ...and the RECOVERY step after it is still counted: a walk still stuck after answering
    // validly is a genuine refusal, whatever provoked the first block.
    const recovered = obs({ steps: [step({ advanced: false, source: "recovery", question: "Q8", blockedReason: "validation-visible" })] });
    assertEq(mod.executeBatch.blockedStepCount(recovered), 1);
  });

  test("A LEGACY RECORD WITH NO `blockedSteps` degrades to no-evidence, never to an accusation", async () => {
    const mod = await worker();
    const legacy = { ...walkRec({ outcome: "no-advance-control" }) };
    delete legacy.blockedSteps;
    assertEq(mod.executeBatch.hasBlockingEvidence([legacy]), false);
    // Which is exactly the shape of the real 46 — they predate the field.
    assert(REAL.walks.every((w) => w.blockedSteps === undefined), "the real records predate the field");
  });

  test("NOTHING PENDING is not a stop reason, and an existing reason is never overwritten", async () => {
    const mod = await worker();
    const walks = [walkRec({ blockedSteps: 3 })];
    assertEq(mod.executeBatch.resolveStopReason({ done: true, pendingCases: 0, stopReason: null, walks }), null);
    assertEq(mod.executeBatch.resolveStopReason({ done: false, pendingCases: 9, stopReason: null, walks }), null);
    assertEq(
      mod.executeBatch.resolveStopReason({ done: true, pendingCases: 9, stopReason: "cost-cap", walks }),
      "cost-cap",
      "a cap that already stopped the run keeps its name",
    );
  });

  test("the executor's stop-reason vocabulary is CLOSED and both codes are in it", async () => {
    const mod = await worker();
    const eb = mod.executeBatch;
    assertEq(JSON.stringify([...eb.EXEC_STOP_REASONS].sort()), JSON.stringify([
      "browser-unavailable",
      "coverage-shortfall-unexercised",
      "executor-error",
      "plan-missing",
      "walks-blocked-by-site",
    ]));
    // Neither may end in `-cap`: `run-workflow.ts#stopBucket`/`stopCompletion` key off that
    // suffix to mean "a budget limit stopped us", and neither of these is a budget.
    for (const r of eb.EXEC_STOP_REASONS) assert(!r.endsWith("-cap"), `${r} would be read as a budget cap`);
  });
});

// ===========================================================================
// THE LIVE PATH. Everything above binds to an exported function; these drive the REAL
// `executeBatch` — real plan load, real browser session handling, the real walker against a
// fake page, real checkpoint commits — so that a mutation of a CALL SITE has something to
// make red. A guard nobody can kill is a guard nobody has proved exists.
// ===========================================================================

const nextBtn = (idx = 9, disabled = false) => ({ idx, label: "Next", role: "next", disabled, visible: true });

const liveScreen = (text, { buttons = [nextBtn()], validationMessages = [] } = {}) => ({
  at: "2026-08-08T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  grid: null,
  buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages,
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${text}`,
});

/** A page that serves a scripted sequence of screens; the last one repeats. As in D29. */
function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  return {
    async goto() {},
    async evaluate(script) {
      if (typeof script === "string" && script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$() {
      return [];
    },
    async screenshot() {
      throw new Error("no screenshot in this harness");
    },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

/** Install the opt-in browser for one test. Always removed, even on failure. */
async function withBrowser(reads, fn) {
  const browser = {
    async newPage() {
      return fakePage(reads);
    },
    async close() {},
    disconnect() {},
    sessionId() {
      return "sess_test";
    },
  };
  globalThis.__V2_TEST_BROWSER__ = { async launch() { return browser; }, async connect() { return browser; } };
  try {
    return await fn();
  } finally {
    delete globalThis.__V2_TEST_BROWSER__;
  }
}

/**
 * A run with a sealed 2-case contract, a plan whose ONE floor path is entirely delegated
 * decisions and is assigned ONE of the two cases, and the other case left unassigned. So a
 * successful batch closes one case and leaves one pending — which is precisely the state
 * that used to publish `walks-blocked-by-site`.
 */
async function liveBed(mod, env) {
  const { seedRun } = await import("./_helpers.mjs");
  const seeded = await seedRun(mod, env, { testCompletion: "running" });
  const sealed = (await mod.contractRevision.getContractRevision(env, seeded.contractRevisionId)).facetInstances.map(
    (fi) => fi.facetInstanceId,
  );
  const planRevisionId = "plan_d31live001";
  const path = {
    id: "FLOOR-01",
    tier: 1,
    kind: "floor",
    intent: "walk the survey",
    decisions: [delegated("Q1"), delegated("Q2")],
    skipped_questions: [],
    terminated_at: null,
    witnesses: [],
    witness_notes: [],
    needs_repeats: [],
    steps: 3,
  };
  await env.EVIDENCE.put(
    mod.keys.planKey(seeded.runId, planRevisionId),
    JSON.stringify({
      kind: "v2-execution-program/2.0.0",
      runId: seeded.runId,
      planRevisionId,
      contractRevisionId: seeded.contractRevisionId,
      contractHash: seeded.contractHash,
      generatedAt: "2026-08-08T00:00:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      floor: [{ pathId: "FLOOR-01", caseIds: [sealed[0]] }],
      exploration: [],
      caseOrder: sealed,
      unassignedCaseIds: sealed.slice(1),
      coverage: { obligations: 2, witnessedByFloor: 1, coversAllObligations: false, coversAllAfterMandatoryExploration: false, uncovered: [] },
      warnings: [],
      plan: { floor: { paths: [path] }, exploration: { queue: [] } },
    }),
    { httpMetadata: { contentType: "application/json" } },
  );

  const fence = await mod.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);
  const cursor = {
    batchIndex: 0,
    sessionId: null,
    sessionOpenedAt: null,
    pendingCaseIds: [...sealed],
    completedCaseIds: [],
    planRevisionId,
  };
  await mod.checkpoint.updateCheckpoint(env, seeded.runId, (d) => {
    d.execution = { ...cursor };
    d.counts = { ...d.counts, exercised: 0, pending: sealed.length };
  }, { fence });

  return { runId: seeded.runId, fence, cursor, planRevisionId, sealed };
}

suite("D31 — the LIVE executor: a healthy survey is never accused", () => {
  test("END TO END: a delegated walk closes its case and the leftover is OUR shortfall, not the site's fault", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);

    // Three screens then a terminal screen with no enabled advance control — the real
    // survey's ending, and the shape that used to be read as "blocked".
    const reads = [
      liveScreen("How old are you?"),
      liveScreen("Where do you live?"),
      liveScreen("That is the end of the survey.", { buttons: [] }),
    ];

    const out = await withBrowser(reads, () =>
      mod.executeBatch.executeBatch(env, {
        runId: bed.runId,
        batch: 0,
        fence: bed.fence,
        cursor: bed.cursor,
        surveyUrl: "https://fixture.invalid/survey",
        planRevisionId: bed.planRevisionId,
      }),
    );

    assertEq(out.pathsWalked, 1, "the walk really happened");
    assertEq(out.casesClosed, 1, "and its case closed — the gate no longer disqualifies a delegated walk");
    assertEq(out.done, true);
    assertEq(out.stopReason, "coverage-shortfall-unexercised", "one case is still owed and the site did nothing wrong");

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assertEq(progress.walks.length, 1);
    assertEq(progress.walks[0].exercised, true);
    assertEq(progress.walks[0].constrainingDecisions, 0, "the audit trail records the denominator it used");
    assertEq(progress.walks[0].plannedDecisions, 2, "and the raw count, so the two can never be confused");
    assertEq(progress.walks[0].blockedSteps, 0);
  });

  test("END TO END: the SAME survey that actually blocks IS named — the live path can still accuse", async () => {
    const mod = await worker();
    const env = testEnv();
    const bed = await liveBed(mod, env);

    // Next is pressed and a message the page was not showing before appears, with the advance
    // control still there. That is `validation-visible`, and it is the site saying no.
    const stuck = (msgs = []) => liveScreen("How old are you?", { validationMessages: msgs });
    const reads = [stuck(), stuck(["Please enter a whole number."]), stuck(["Please enter a whole number."])];

    const out = await withBrowser(reads, () =>
      mod.executeBatch.executeBatch(env, {
        runId: bed.runId,
        batch: 0,
        fence: bed.fence,
        cursor: bed.cursor,
        surveyUrl: "https://fixture.invalid/survey",
        planRevisionId: bed.planRevisionId,
      }),
    );

    const progress = await mod.executeBatch.loadProgress(env, bed.runId, bed.planRevisionId);
    assert(progress.walks[0].blockedSteps > 0, `the walker recorded the refusal: ${JSON.stringify(progress.walks[0])}`);
    assertEq(out.casesClosed, 0, "a walk that never reached the end closes nothing");
    assertEq(out.stopReason, "walks-blocked-by-site", "and THIS is when the accusation is honest");
  });
});
