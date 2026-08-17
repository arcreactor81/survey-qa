/**
 * D54 — PLANNER-DRIVEN SURVIVAL HINTS: the walker's position-1 default stops volunteering
 * documented screen-out answers, WITHOUT the hint ever becoming evidence.
 *
 * ==================== THE MEASURED DEFECT ====================
 *
 * The reach baseline (2026-08-10/11) measured s2-clean dying at S3: the option default
 * (`navigator-default:first-option`) answered "Which industry…" with its first option,
 * "Market research" — the one answer the questionnaire DOCUMENTS as disqualifying — and the
 * walk screened out with ~1-2 screens seen of ten. The plan already knew the trigger
 * (`Q.options[].terminates`, `model.terminals`); the driver simply had no channel for it.
 *
 * The channel is additive stimulus stamped by `stages/plan.ts#stampSurvivalHints`:
 * per-decision `avoid_labels` and per-path `survival_hints`. The driver PREFERS the first
 * answerable option matching no avoid label; when every answerable option is flagged it
 * falls back to today's position-1 pick — a hint may re-order a filler, never refuse one.
 *
 * ==================== THE INVARIANT THESE TESTS PIN ====================
 *
 * HINTS ARE INPUT, NEVER EVIDENCE. The leak vector is `select`: a planned label that is not
 * offered becomes `requestedButNotOffered` (missing-option evidence) and a non-empty select
 * makes the decision constraining (the exercised gate's denominator). A hint must reach
 * neither. The tests here prove the driver half — `requestedButNotOffered` carries the
 * plan's own unmet labels and no hint, the steered click still wears the
 * `navigator-default:` prefix and is counted as an invented answer — and the d36 extension
 * proves the plan half (signature-neutral, gate-invisible). The grid default and the value
 * fillers are deliberately NOT consumers: hints are a label mechanism (phase 2); numeric
 * screen-outs belong to the separate bounded-retry feature.
 *
 * Evidence these can fail: `tools/mutate-survival-hints.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d54000000001";
const PATH_ID = "path_d54000000001";

/* ------------------------------------------------------------------ fixtures */

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", roleVia: "text:Next", disabled: false, visible: true });

const option = (idx, label, { code = null, ...rest } = {}) => ({
  order: idx,
  idx,
  code,
  label,
  checked: false,
  disabled: false,
  visible: true,
  operable: true,
  actuatedVia: "self",
  labelIndex: null,
  ...rest,
});

const numberControl = (idx, rest = {}) => ({
  idx,
  tag: "input",
  type: "number",
  name: null,
  id: null,
  code: null,
  label: "",
  text: "",
  checked: null,
  value: "",
  valueIsUserSupplied: false,
  disabled: false,
  required: false,
  visible: true,
  operable: true,
  actuatedVia: "self",
  placeholder: null,
  maxlength: null,
  min: null,
  max: null,
  step: null,
  pattern: null,
  readOnly: false,
  ...rest,
});

const screen = (text, { controls = [], optionGroups = [], grid = null, buttons, signature } = {}) => ({
  at: "2026-08-11T00:05:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: text,
  instructionText: null,
  visibleText: text,
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls,
  optionGroups,
  grid,
  readerLimitations: [],
  buttons: buttons === undefined ? [nextBtn(30)] : buttons,
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: {
    controls: controls.length,
    optionGroups: optionGroups.length,
    options: optionGroups.reduce((n, g) => n + g.options.length, 0),
    textInputs: 0,
    valueInputs: controls.length,
    optionsNotOperable: 0,
    readerLimitations: 0,
  },
  screenSignature: signature ?? `sig:${text}`,
});

/** The measured s2 shape: position 1 is the documented disqualifying industry. */
const industryScreen = () =>
  screen("S3. Which industry do you work in for your main job?", {
    optionGroups: [
      {
        name: "S3",
        kind: "radio",
        options: [option(0, "Market research"), option(1, "Software engineering")],
      },
    ],
  });

/** A page that serves scripted screens and records clicks/keystrokes (d44 pattern). */
function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const typed = [];
  const set = [];
  const clicks = [];
  const handle = (selector, index) => ({
    async click() {
      clicks.push({ selector, index });
    },
    async type(text) {
      typed.push({ index, text });
    },
    async focus() {},
  });
  return {
    typed,
    set,
    clicks,
    async goto() {},
    async evaluate(script) {
      if (typeof script !== "string") return { ok: true };
      if (script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      const m = /el\.value = ("(?:[^"\\]|\\.)*");/.exec(script);
      if (m && script.includes("change")) {
        const value = JSON.parse(m[1]);
        set.push({ value });
        return { ok: true, reason: null, got: value };
      }
      // A click transport succeeding is not proof that a native radio retained the intended
      // state. Mirror the production scoped readback so this PageLike fixture exercises the
      // exact W4 receipt contract, as the repaired D32/D55 fixtures do.
      if (script.includes("W4_NATIVE_CHOICE_SCOPED_READBACK")) {
        const idx = Number(/const expectedIdx = (\d+);/.exec(script)?.[1]);
        // Echo the clicked option's REAL group kind: a checkbox group's readback must say
        // checkbox or the production type check correctly refuses the receipt.
        const owner = (last?.optionGroups ?? []).find((grp) => (grp.options ?? []).some((o) => o.idx === idx));
        return { idx, type: owner?.kind === "checkbox" ? "checkbox" : "radio", name: null, checked: true, checkedGroupIdxs: [idx] };
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$(selector) {
      return Array.from({ length: 32 }, (_, i) => handle(selector, i));
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

const advancing = (s) => [s, s, screen("Thank you for completing the survey.", { buttons: [] })];

async function walk(mod, env, reads, path = {}) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: PATH_ID, decisions: [], witnesses: [], ...path },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_d54test01",
      attemptId: ATTEMPT_ID,
      tier: 1,
      maxSteps: 1,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 200,
    },
    { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
  );
  return { obs, page };
}

const optionClicks = (obs) => (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "click-option" && a.ok);

/**
 * A bound discretion decision for the industry screen. It binds via the question token in the
 * heading ("S3." is printed), which is binding policy #4 — nothing here relies on wording.
 */
const boundDecision = (over = {}) => ({
  question: "S3",
  select: [],
  source: "default:navigator-discretion",
  ...over,
});

/* ============================================================ 1. bound-decision consumption */

suite("D54 — survival hints steer the option default on a BOUND decision", () => {
  test("THE MEASURED DEFECT: a screen offering [Terminating, Safe] answers Safe, and names what it avoided", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [boundDecision({ avoid_labels: ["Market research"] })],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    // Pre-fix this is the whole failure: position-1 "Market research" — the documented
    // disqualifying industry — is clicked and the walk dies at S3.
    assertEq(clicks[0].targetLabel, "Software engineering", `the default clicked "${clicks[0].targetLabel}"`);
    assert(
      clicks[0].detail.startsWith('navigator-default:first-non-flagged-option(avoided "Market research")'),
      `the steered pick is not named: ${clicks[0].detail}`,
    );
  });

  test("the steered pick is STILL an invented answer: navigator-default provenance is kept and counted", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [boundDecision({ avoid_labels: ["Market research"] })],
    });

    const clicks = optionClicks(obs);
    assert(clicks[0].detail.startsWith("navigator-default"), clicks[0].detail);
    assert(
      obs.navigatorDefaultAnswerCount >= 1,
      `the hint-steered filler was not counted as a navigator default: ${obs.navigatorDefaultAnswerCount}`,
    );
  });

  test("EVERY answerable option is flagged => today's position-1 fallback, never a refusal", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [boundDecision({ avoid_labels: ["Market research", "Software engineering"] })],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, "a hint refused an answer instead of falling back");
    assertEq(clicks[0].targetIdx, 0, "the fallback is position 1, exactly today's behaviour");
    assert(clicks[0].detail.startsWith("navigator-default:first-option ("), clicks[0].detail);
  });

  test("A HINT IS INPUT, NEVER EVIDENCE: requestedButNotOffered carries the plan's unmet labels and NO hint", async () => {
    const mod = await worker();
    const env = testEnv();
    // The planned label is genuinely missing from the screen — that IS missing-option
    // evidence and must survive. The hint must not join it.
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [boundDecision({ select: ["Blue widgets"], avoid_labels: ["Market research"] })],
    });

    assertEq(JSON.stringify(obs.steps[0].requestedButNotOffered), JSON.stringify(["Blue widgets"]));
    // And the hint still steered the filler on the same step.
    assertEq(optionClicks(obs)[0].targetLabel, "Software engineering");
  });
});

/* ============================================================ 2. unbound screens via path hints */

suite("D54 — survival hints reach UNBOUND screens through the path, by offered-label overlap only", () => {
  test("an unbound screen consumes path-level hints: the filler steers off the documented trigger", async () => {
    const mod = await worker();
    const env = testEnv();
    // No decisions at all: the screen binds nothing and is answered purely by navigator
    // default — gap (ii) of the design brief.
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [],
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });

    assertEq(obs.steps[0].decisionQuestion, null, "hints must never bind identity");
    assertEq(obs.steps[0].decisionSource, "navigator-default");
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Software engineering");
    assert(clicks[0].detail.startsWith("navigator-default:first-non-flagged-option"), clicks[0].detail);
    // Nothing was "requested": a consumed hint is not a planned answer.
    assertEq(JSON.stringify(obs.steps[0].requestedButNotOffered), JSON.stringify([]));
  });

  test("OVERLAP IS THE MATCH: a hint whose labels overlap nothing offered does not apply", async () => {
    const mod = await worker();
    const env = testEnv();
    // The hint is for some other screen (its labels are not offered here), so this screen
    // keeps today's position-1 pick — cross-screen steering would be a guess.
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [],
      survival_hints: [{ question: "S9", avoid_labels: ["Purple hats"] }],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetIdx, 0);
    assert(clicks[0].detail.startsWith("navigator-default:first-option ("), clicks[0].detail);
  });

  test("malformed hints are ignored, never a crash and never a refusal", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(industryScreen()), {
      decisions: [],
      survival_hints: [null, "nonsense", { question: "S3" }, { question: "S3", avoid_labels: [] }, { avoid_labels: 7 }],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1);
    assertEq(clicks[0].targetIdx, 0);
  });
});

/* ============================================================ 2b. documented CONTINUE answers (prefer_labels) */

/**
 * The measured 2026-08-16 shape: a screener whose position-1 AND position-2 fates differ —
 * position 1 is a documented terminator, position 2 is undocumented (could terminate too),
 * position 3 is the answer the document STATES continues the survey.
 */
const screenerScreen = () =>
  screen("S10. Which of the following best describes your current role?", {
    optionGroups: [
      {
        name: "S10",
        kind: "radio",
        options: [option(0, "Physician"), option(1, "Office Manager"), option(2, "Director of ops")],
      },
    ],
  });

const boundScreenerDecision = (over = {}) => ({
  question: "S10",
  select: [],
  source: "default:navigator-discretion",
  ...over,
});

suite("D54 — a documented CONTINUE answer outranks first-non-flagged, and never overrules avoid", () => {
  test("THE MEASURED DEFECT, other half: the filler takes the documented continue answer, not the nearest unflagged", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(screenerScreen()), {
      decisions: [boundScreenerDecision({ avoid_labels: ["Physician"], prefer_labels: ["Director of ops"] })],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    // First-non-flagged would click "Office Manager" — an option the document says nothing
    // about, which on the live run was ALSO a terminator. The documented continue wins.
    assertEq(clicks[0].targetLabel, "Director of ops", `the default clicked "${clicks[0].targetLabel}"`);
    assert(
      clicks[0].detail.startsWith('navigator-default:documented-continue-option("Director of ops"'),
      `the documented-continue pick is not named: ${clicks[0].detail}`,
    );
    assert(clicks[0].detail.startsWith("navigator-default"), "provenance prefix lost");
    assert(obs.navigatorDefaultAnswerCount >= 1, "a prefer-steered filler is still an invented answer");
  });

  test("prefer alone steers — no avoid labels required", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(screenerScreen()), {
      decisions: [boundScreenerDecision({ prefer_labels: ["Director of ops"] })],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Director of ops");
    assert(
      clicks[0].detail.startsWith('navigator-default:documented-continue-option("Director of ops") ('),
      clicks[0].detail,
    );
  });

  test("prefer NEVER overrules avoid: a label stamped both ways is not clicked", async () => {
    const mod = await worker();
    const env = testEnv();
    // Adversarial stamp (the planner's index drops conflicts, but the driver must not trust
    // that): the preferred label is also flagged. The pick falls back to first-non-flagged.
    const { obs } = await walk(mod, env, advancing(screenerScreen()), {
      decisions: [boundScreenerDecision({ avoid_labels: ["Physician"], prefer_labels: ["Physician"] })],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Office Manager", `the flagged prefer was honoured: ${clicks[0].detail}`);
    assert(clicks[0].detail.startsWith("navigator-default:first-non-flagged-option"), clicks[0].detail);
  });

  test("an UNBOUND screen consumes path-level prefer by the same offered-label overlap", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(screenerScreen()), {
      decisions: [],
      survival_hints: [{ question: "S10", avoid_labels: ["Physician"], prefer_labels: ["Director of ops"] }],
    });

    assertEq(obs.steps[0].decisionQuestion, null, "hints must never bind identity");
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Director of ops");
    assertEq(JSON.stringify(obs.steps[0].requestedButNotOffered), JSON.stringify([]));
  });

  test("a prefer-only hint row whose labels overlap nothing offered does not apply", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(screenerScreen()), {
      decisions: [],
      survival_hints: [{ question: "S9", avoid_labels: [], prefer_labels: ["Purple hats"] }],
    });

    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetIdx, 0);
    assert(clicks[0].detail.startsWith("navigator-default:first-option ("), clicks[0].detail);
  });
});

/* ============================================================ 2c. the exclusion-screener none-default */

/** The measured 2026-08-17 shape: a select-all-that-apply of disqualifying affiliations. */
const exclusionScreen = (extraOpts = {}) =>
  screen("S50. Do you or anyone in your household work for any of the following?", {
    optionGroups: [
      {
        name: "S50",
        kind: "checkbox",
        options: [
          option(0, "An advertising agency or media company"),
          option(1, "A pharmaceutical company"),
          option(2, "None of the above", extraOpts),
        ],
      },
    ],
  });

suite("D54 — an invented multi-select answer prefers the exclusive none-option", () => {
  test("THE MEASURED SHAPE: an unbound exclusion screener answers None of the above, named as such", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(exclusionScreen()), { decisions: [] });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(clicks[0].targetLabel, "None of the above", `three live pivots died drawing company options: ${clicks[0].targetLabel}`);
    assert(clicks[0].detail.startsWith('navigator-default:exclusive-none-option("None of the above")'), clicks[0].detail);
    assert(obs.navigatorDefaultAnswerCount >= 1, "still an invented, counted answer");
  });

  test("INERT ON SINGLE-SELECT: a radio group with a none-style option keeps position 1", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = exclusionScreen();
    s.optionGroups[0].kind = "radio";
    const { obs } = await walk(mod, env, advancing(s), { decisions: [] });
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetIdx, 0, "single-select defaults are untouched by the exclusion heuristic");
  });

  test("A DOCUMENTED HINT OUTRANKS THE HEURISTIC: prefer_labels beats none-of-the-above", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(exclusionScreen()), {
      decisions: [],
      survival_hints: [{ question: "S50", avoid_labels: [], prefer_labels: ["A pharmaceutical company"] }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "A pharmaceutical company", clicks[0].detail);
  });

  test("AN AVOID FLAG ON THE NONE-OPTION IS HONOURED: the heuristic never overrules a documented screen-out", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(exclusionScreen()), {
      decisions: [],
      survival_hints: [{ question: "S50", avoid_labels: ["None of the above"] }],
    });
    const clicks = optionClicks(obs);
    assert(clicks[0].targetLabel !== "None of the above", `a flagged none-option was clicked: ${clicks[0].detail}`);
  });
});

/* ============================================================ 3. the ONLY consumer is the option default */

suite("D54 — survival hints have exactly one consumer: grid and value fillers ignore them", () => {
  test("the grid default ignores hints: cells[0] is clicked even when its column is a flagged label", async () => {
    const mod = await worker();
    const env = testEnv();
    const gridScreen = screen("G1. Please pick a column for the row below.", {
      grid: {
        columns: ["Market research", "Software engineering"],
        rows: [
          {
            label: "Row 1",
            name: "r1",
            cells: [
              { column: "Market research", code: "1", checked: false, idx: 0 },
              { column: "Software engineering", code: "2", checked: false, idx: 1 },
            ],
          },
        ],
      },
    });
    // Bound via the question token in the heading, with a non-empty avoid list in scope —
    // the exact situation a hint-hungry grid mutant would consume.
    const { obs } = await walk(mod, env, advancing(gridScreen), {
      decisions: [{ question: "G1", select: [], source: "default:navigator-discretion", avoid_labels: ["Market research"] }],
    });

    const gridClicks = (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "select-grid-cell");
    assertEq(gridClicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(gridClicks[0].targetIdx, 0, "the grid default moved off cells[0] — a hint was consumed by the grid pass");
    assertEq(optionClicks(obs).length, 0, "the option default must not run on a grid screen");
  });

  test("the value filler ignores hints: the midpoint is unchanged when hints are present", async () => {
    const mod = await worker();
    const env = testEnv();
    const numberScreen = screen("S4. How old are you?", {
      controls: [numberControl(0, { min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, env, advancing(numberScreen), {
      decisions: [],
      survival_hints: [{ question: "S4", avoid_labels: ["Market research"] }],
    });

    const typed = (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "type-text" && a.ok);
    assertEq(typed.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(typed[0].value, "50", "the numeric filler moved — hints are a label mechanism only");
    assert(typed[0].detail.startsWith("navigator-default:"), typed[0].detail);
  });
});

/* ============================================================ 4. the RECOVERY re-pick consumes the same hints */

/**
 * THE GAP (survival-hints feature report): when a screen blocks and walkPath's recovery pass
 * re-invokes applyDecision, the synthetic decision it builds is NON-NULL — so
 * `survivalAvoidLabels` reads only ITS `avoid_labels`, and unstamped it read []. The re-pick
 * could therefore select the documented screen-out label the FIRST pass deliberately steered
 * around: hints steer S3 to safety, something else on the screen blocks, and the recovery
 * clicks position-1 "Market research" — the walk dies on a retry that attempt one would have
 * survived. The fix re-derives the first pass's avoid set (bound decision's `avoid_labels`,
 * else path-level `survival_hints` by offered-label overlap) onto the synthetic decision.
 *
 * A never-advancing read queue (`[s]` — exhaustion repeats the last screen) forces the
 * recovery pass; these assert on the RECOVERY step's own actions, not step 0's.
 */

const recoveryStep = (obs) => obs.steps.find((s) => s.decisionSource === "recovery");
const recoveryClicks = (obs) => (recoveryStep(obs)?.actions ?? []).filter((a) => a.kind === "click-option" && a.ok);

suite("D54 — survival hints reach the RECOVERY re-pick after a blocked screen", () => {
  test("THE RETRY REPLAY: a blocked screen's recovery re-pick steers off the flagged position-1 label", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, [industryScreen()], {
      decisions: [boundDecision({ avoid_labels: ["Market research"] })],
    });

    // The FIRST pass steered correctly — that half is pinned by suite 1 and holds here too.
    assertEq(optionClicks(obs)[0].targetLabel, "Software engineering");
    // Pre-fix this is the whole failure: the recovery's synthetic decision carried no
    // avoid_labels, so the re-pick clicked position-1 "Market research" — the documented
    // screen-out the hints exist to avoid — and wore plain `first-option` provenance.
    const clicks = recoveryClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(recoveryStep(obs)?.actions));
    assertEq(clicks[0].targetLabel, "Software engineering", `the recovery re-pick clicked "${clicks[0].targetLabel}"`);
    assert(
      clicks[0].detail.startsWith('navigator-default:first-non-flagged-option(avoided "Market research")'),
      `the avoid-steering is not named on the recovery action: ${clicks[0].detail}`,
    );
  });

  test("the recovery consumes PATH-LEVEL hints on an unbound screen — the second avoid-label source", async () => {
    const mod = await worker();
    const env = testEnv();
    // No decisions at all: the avoid set can only come from the path's survival_hints, by
    // offered-label overlap — the same source rule the main pass uses on unbound screens.
    const { obs } = await walk(mod, env, [industryScreen()], {
      decisions: [],
      survival_hints: [{ question: "S3", avoid_labels: ["Market research"] }],
    });

    const clicks = recoveryClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(recoveryStep(obs)?.actions));
    assertEq(clicks[0].targetLabel, "Software engineering", `the recovery re-pick clicked "${clicks[0].targetLabel}"`);
    assert(
      clicks[0].detail.startsWith("navigator-default:first-non-flagged-option"),
      `the avoid-steering is not named on the recovery action: ${clicks[0].detail}`,
    );
  });

  test("RECOVERY COUNTERWEIGHT: every answerable option flagged => position-1 fallback, never a refusal", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, [industryScreen()], {
      decisions: [boundDecision({ avoid_labels: ["Market research", "Software engineering"] })],
    });

    // A hint may re-order the recovery's filler — it may NEVER refuse one. All flagged
    // degrades to exactly today's position-1 pick, on the recovery pass as on the first.
    const clicks = recoveryClicks(obs);
    assertEq(clicks.length, 1, "the recovery refused an answer instead of falling back");
    assertEq(clicks[0].targetIdx, 0, "the fallback is position 1, exactly today's behaviour");
    assert(clicks[0].detail.startsWith("navigator-default:first-option ("), clicks[0].detail);
  });
});
