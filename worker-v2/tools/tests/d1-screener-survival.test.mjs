/**
 * D1 — SCREENER-SURVIVAL IMPROVEMENTS: four outcomes, each with the can-fail half.
 *
 * OUTCOME 1: Code-based matching in survival hints.
 * OUTCOME 2: Recovery re-pick carries prefer_labels alongside avoid_labels.
 * OUTCOME 3: Mid-walk termination announcement detection.
 * OUTCOME 4: Documented-accepted numeric value from BoundaryInputPayload.
 *
 * Evidence these can fail: tools/mutate-survival-hints.mjs (extended).
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d1_000000001";
const PATH_ID = "path_d1_000000001";

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
  at: "2026-08-24T00:05:00.000Z",
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
      if (script.includes("W4_NATIVE_CHOICE_SCOPED_READBACK")) {
        const idx = Number(/const expectedIdx = (\d+);/.exec(script)?.[1]);
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
      planRevisionId: "plan_d1test01",
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
const recoveryStep = (obs) => obs.steps.find((s) => s.decisionSource === "recovery");
const recoveryClicks = (obs) => (recoveryStep(obs)?.actions ?? []).filter((a) => a.kind === "click-option" && a.ok);

/* ============================================================
   OUTCOME 1: CODE-BASED MATCHING
   ============================================================ */

/** A screen where options have codes but labels do NOT match hint labels. */
const codeOnlyScreen = () =>
  screen("S10. Which of the following best describes your current role?", {
    optionGroups: [
      {
        name: "S10",
        kind: "radio",
        options: [
          option(0, "Role Alpha", { code: "17" }),
          option(1, "Role Beta", { code: "19" }),
          option(2, "Role Gamma", { code: "98" }),
        ],
      },
    ],
  });

const codeDecision = (over = {}) => ({
  question: "S10",
  select: [],
  source: "default:navigator-discretion",
  ...over,
});

suite("D1-OUTCOME1 — code-based matching steers the option default when labels do not match", () => {
  test("an avoid_codes entry flags an option by exact code, even when labels differ", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(codeOnlyScreen()), {
      decisions: [codeDecision({
        avoid_labels: ["Physician"],  // does NOT match any label on screen
        avoid_codes: [{ label: "Physician", code: "17" }],  // DOES match Role Alpha's code
      })],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, JSON.stringify(obs.steps[0]?.actions));
    // Position-1 "Role Alpha" (code=17) is flagged by code match, so the pick moves.
    assert(clicks[0].targetLabel !== "Role Alpha", `code-flagged option was clicked: ${clicks[0].targetLabel}`);
  });

  test("a prefer_codes entry prefers an option by exact code", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(codeOnlyScreen()), {
      decisions: [codeDecision({
        avoid_labels: ["Physician"],
        avoid_codes: [{ label: "Physician", code: "17" }],
        prefer_labels: ["Dir Population Health"],  // does NOT match any label
        prefer_codes: [{ label: "Dir Population Health", code: "19" }],  // DOES match Role Beta
      })],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Role Beta", `code-preferred option was not clicked: ${clicks[0].targetLabel}`);
    assert(clicks[0].detail.includes("documented-continue-option"), clicks[0].detail);
  });

  test("code matching is EXACT: '17' does not match '170'", async () => {
    const mod = await worker();
    const env = testEnv();
    const s = screen("Test", {
      optionGroups: [{
        name: "Q1",
        kind: "radio",
        options: [option(0, "Alpha", { code: "170" }), option(1, "Beta")],
      }],
    });
    const { obs } = await walk(mod, env, advancing(s), {
      decisions: [{
        question: "Q1", select: [], source: "default:navigator-discretion",
        avoid_codes: [{ label: "X", code: "17" }],
        avoid_labels: [],
      }],
    });
    const clicks = optionClicks(obs);
    // Code "170" does NOT match "17", so position-1 Alpha is still picked.
    assertEq(clicks[0].targetLabel, "Alpha", `inexact code match flagged an option: ${clicks[0].detail}`);
  });

  test("path-level hint codes reach unbound screens", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(codeOnlyScreen()), {
      decisions: [],
      survival_hints: [{
        question: "S10",
        avoid_labels: ["Physician"],
        avoid_codes: [{ label: "Physician", code: "17" }],
        prefer_labels: [],
        prefer_codes: [{ label: "Dir Population Health", code: "19" }],
      }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks[0].targetLabel, "Role Beta", `code-preferred option was not clicked: ${clicks[0].targetLabel}`);
  });
});

/* ============================================================
   OUTCOME 2: RECOVERY CARRIES PREFER_LABELS
   ============================================================ */

const screenerScreen = () =>
  screen("S10. Which of the following best describes your current role?", {
    optionGroups: [
      {
        name: "S10",
        kind: "radio",
        options: [
          option(0, "Physician"),
          option(1, "Office Manager"),
          option(2, "Director of ops"),
        ],
      },
    ],
  });

suite("D1-OUTCOME2 — recovery re-pick carries documented-continue (prefer_labels) steering", () => {
  test("THE GAP CLOSED: a recovery on a screener screen picks the documented-continue answer", async () => {
    const mod = await worker();
    const env = testEnv();
    // The never-advancing read queue forces recovery. The decision carries both avoid and prefer.
    const { obs } = await walk(mod, env, [screenerScreen()], {
      decisions: [{
        question: "S10", select: [], source: "default:navigator-discretion",
        avoid_labels: ["Physician"],
        prefer_labels: ["Director of ops"],
      }],
    });
    // First pass steers correctly (covered by D54).
    assertEq(optionClicks(obs)[0].targetLabel, "Director of ops");
    // Pre-fix: the recovery lost prefer and fell back to first-non-flagged (Office Manager).
    const rClicks = recoveryClicks(obs);
    assertEq(rClicks.length, 1, JSON.stringify(recoveryStep(obs)?.actions));
    assertEq(rClicks[0].targetLabel, "Director of ops",
      `recovery lost prefer_labels and clicked "${rClicks[0].targetLabel}"`);
    assert(rClicks[0].detail.includes("documented-continue-option"), rClicks[0].detail);
  });

  test("recovery carries path-level prefer on an unbound screen", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, [screenerScreen()], {
      decisions: [],
      survival_hints: [{
        question: "S10",
        avoid_labels: ["Physician"],
        prefer_labels: ["Director of ops"],
      }],
    });
    const rClicks = recoveryClicks(obs);
    assertEq(rClicks[0].targetLabel, "Director of ops",
      `recovery lost path-level prefer and clicked "${rClicks[0].targetLabel}"`);
  });
});

/* ============================================================
   OUTCOME 3: TERMINATION ANNOUNCEMENT DETECTION
   ============================================================ */

suite("D1-OUTCOME3 — mid-walk termination announcement detection", () => {
  test("a screen matching SCREENOUT_MARKERS is labeled as a termination announcement", async () => {
    const mod = await worker();
    const env = testEnv();
    // A mid-walk interstitial announcing termination. The screen still has a Next button.
    const interstitial = screen(
      "For testing only: we are unable to accept your offer. Survey status: Terminated at S10",
      { buttons: [nextBtn(30)] },
    );
    const { obs } = await walk(mod, env, advancing(interstitial), { decisions: [] });
    const step = obs.steps[0];
    assert(step.terminationAnnouncement != null,
      "no terminationAnnouncement on a screen with screenout markers");
    assert(step.terminationAnnouncement.matchedText.length > 0,
      "matchedText is empty");
    // The text names "S10" — when it matches a walk question id, it should be extracted.
    // But our walk has no decisions with question ids, so questionToken should be null here.
    assertEq(step.terminationAnnouncement.questionToken, null);
    assert(obs.terminationAnnouncementCount >= 1,
      `terminationAnnouncementCount is ${obs.terminationAnnouncementCount}`);
  });

  test("a screen with question token in announcement extracts the question id", async () => {
    const mod = await worker();
    const env = testEnv();
    const interstitial = screen(
      "Respondent will be terminated at the end of the screener. Survey status: Terminated at S10",
      { buttons: [nextBtn(30)] },
    );
    const { obs } = await walk(mod, env, advancing(interstitial), {
      decisions: [{ question: "S10", select: [], source: "default:navigator-discretion" }],
    });
    const step = obs.steps[0];
    assert(step.terminationAnnouncement != null,
      "no terminationAnnouncement on a termination screen");
    assertEq(step.terminationAnnouncement.questionToken, "S10",
      `questionToken should be S10 but got ${step.terminationAnnouncement.questionToken}`);
  });

  test("NOT recorded on a normal screen mentioning 'end' in prose — the lexicon's precision", async () => {
    const mod = await worker();
    const env = testEnv();
    // A screen that mentions "end" in ordinary prose but does NOT match any SCREENOUT_MARKERS.
    const normalScreen = screen(
      "At the end of the day, which product do you prefer? Please select one.",
      {
        optionGroups: [{
          name: "Q1",
          kind: "radio",
          options: [option(0, "Product A"), option(1, "Product B")],
        }],
      },
    );
    const { obs } = await walk(mod, env, advancing(normalScreen), { decisions: [] });
    const step = obs.steps[0];
    assertEq(step.terminationAnnouncement, undefined,
      `false positive: terminationAnnouncement on a normal screen: ${JSON.stringify(step.terminationAnnouncement)}`);
    assertEq(obs.terminationAnnouncementCount, 0);
  });

  test("not recorded on a normal completion page — this is for MID-WALK announcements", async () => {
    const mod = await worker();
    const env = testEnv();
    // A "thank you" screen that the COMPLETION lexicon matches. It should NOT be a
    // termination announcement because it does NOT match SCREENOUT_MARKERS.
    const completionScreen = screen(
      "Thank you for completing the survey. Your responses have been recorded.",
      { buttons: [] },
    );
    const { obs } = await walk(mod, env, [completionScreen], { decisions: [] });
    const step = obs.steps[0];
    assertEq(step.terminationAnnouncement, undefined,
      "a completion page should not be labeled as a termination announcement");
  });
});

/* ============================================================
   OUTCOME 4: DOCUMENTED-ACCEPTED NUMERIC VALUE
   ============================================================ */

suite("D1-OUTCOME4 — documented-accepted value steers the numeric filler", () => {
  test("a number control uses the documented-accepted value instead of blind midpoint", async () => {
    const mod = await worker();
    const env = testEnv();
    const numScreen = screen("S4. How old are you?", {
      controls: [numberControl(0, { min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, env, advancing(numScreen), {
      decisions: [{
        question: "S4", select: [], source: "default:navigator-discretion",
        prefer_value: { value: "25", bound: "max", derivation: "boundary row accepted" },
      }],
    });
    const typed = (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "type-text" && a.ok);
    assertEq(typed.length, 1, JSON.stringify(obs.steps[0]?.actions));
    assertEq(typed[0].value, "25",
      `the numeric filler did not use the documented-accepted value: ${typed[0].value}`);
    assert(typed[0].detail.includes("documented-accepted-value"),
      `provenance does not name the source: ${typed[0].detail}`);
    assert(typed[0].detail.startsWith("navigator-default:"),
      `still an invented answer: ${typed[0].detail}`);
  });

  test("no prefer_value => exactly today's midpoint behavior", async () => {
    const mod = await worker();
    const env = testEnv();
    const numScreen = screen("S4. How old are you?", {
      controls: [numberControl(0, { min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, env, advancing(numScreen), {
      decisions: [{
        question: "S4", select: [], source: "default:navigator-discretion",
        // No prefer_value — midpoint should be 50.
      }],
    });
    const typed = (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "type-text" && a.ok);
    assertEq(typed[0].value, "50", `the midpoint changed when no prefer_value was stamped: ${typed[0].value}`);
  });

  test("path-level prefer_value reaches an unbound screen", async () => {
    const mod = await worker();
    const env = testEnv();
    const numScreen = screen("S4. How old are you?", {
      controls: [numberControl(0, { min: "0", max: "99" })],
    });
    const { obs } = await walk(mod, env, advancing(numScreen), {
      decisions: [],
      survival_hints: [{
        question: "S4",
        avoid_labels: [],
        prefer_value: { value: "30", bound: "min", derivation: "test derivation" },
      }],
    });
    const typed = (obs.steps[0]?.actions ?? []).filter((a) => a.kind === "type-text" && a.ok);
    assertEq(typed[0].value, "30",
      `path-level prefer_value not consumed: ${typed[0].value}`);
  });
});

/* ============================================================
   OUTCOME 1+4: PLAN-SIDE MINING
   ============================================================ */

suite("D1 — plan-side mining carries codes and boundary values", () => {
  test("sealedRouteDestinations carries route answer codes", async () => {
    const mod = await worker();
    const routes = mod.plan.sealedRouteDestinations({
      requirements: [
        { requirementLineageId: "r1", facet: "terminate" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_1",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "S10",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Physician", code: "17" },
            boundaryInput: null,
            configuration: null,
            expectedDestination: { questionId: null, screen: null, terminal: "screenout" },
            optionSet: null,
          },
          expectationGap: null,
          screen: null,
          label: null,
        },
      ],
    });
    assertEq(routes.length, 1);
    assertEq(routes[0].label, "Physician");
    assertEq(routes[0].code, "17", `route code not carried: ${routes[0].code}`);
    assertEq(routes[0].kind, "terminate");
  });

  test("survivalAvoidIndex carries avoidCodes and preferCodes from routes", async () => {
    const mod = await worker();
    const { avoidCodes, preferCodes } = mod.plan.survivalAvoidIndex({}, [
      { question: "S10", label: "Physician", code: "17", kind: "terminate" },
      { question: "S10", label: "Dir Pop Health", code: "19", kind: "continue" },
    ]);
    const ac = avoidCodes.get("S10") ?? [];
    assert(ac.some((e) => e.code === "17"), `avoidCodes missing code 17: ${JSON.stringify(ac)}`);
    const pc = preferCodes.get("S10") ?? [];
    assert(pc.some((e) => e.code === "19"), `preferCodes missing code 19: ${JSON.stringify(pc)}`);
  });

  test("stampSurvivalHints mines accepted boundary values from facetInstances", async () => {
    const mod = await worker();
    const carriers = [
      {
        decisions: [{ question: "S4", select: [], source: "default:navigator-discretion" }],
      },
    ];
    const facetInstances = [
      {
        facetInstanceId: "fi_b1",
        requirementLineageId: "r_b1",
        requirementVersionId: "rv_b1",
        caseVersionId: "cv_b1",
        floorCase: true,
        targetQuestionId: "S4",
        expansionCertificate: "cert",
        case: {
          kind: "boundary",
          routeAnswer: null,
          boundaryInput: { bound: "max", value: "25", expectedOutcome: "accepted" },
          configuration: null,
          expectedDestination: null,
          optionSet: null,
        },
        expectationGap: null,
        screen: null,
        label: null,
      },
    ];
    const result = mod.plan.stampSurvivalHints(carriers, {}, [], facetInstances);
    // The decision should have prefer_value stamped.
    const d = carriers[0].decisions[0];
    assert(d.prefer_value != null, "prefer_value not stamped on decision");
    assertEq(d.prefer_value.value, "25", `wrong prefer_value: ${d.prefer_value.value}`);
    assertEq(d.prefer_value.bound, "max");
    // Path-level hints should also carry it.
    const hints = carriers[0].survival_hints;
    assert(Array.isArray(hints) && hints.length > 0, "no path-level hints");
    assert(hints[0].prefer_value != null, "prefer_value not in path-level hint");
    assertEq(hints[0].prefer_value.value, "25");
  });

  test("conflicting boundary outcomes are refused, not guessed", async () => {
    const mod = await worker();
    const carriers = [
      {
        decisions: [{ question: "S4", select: [], source: "default:navigator-discretion" }],
      },
    ];
    const facetInstances = [
      {
        facetInstanceId: "fi_b1",
        requirementLineageId: "r_b1",
        requirementVersionId: "rv_b1",
        caseVersionId: "cv_b1",
        floorCase: true,
        targetQuestionId: "S4",
        expansionCertificate: "cert",
        case: {
          kind: "boundary",
          routeAnswer: null,
          boundaryInput: { bound: "max", value: "25", expectedOutcome: "accepted" },
          configuration: null,
          expectedDestination: null,
          optionSet: null,
        },
        expectationGap: null,
        screen: null,
        label: null,
      },
      {
        facetInstanceId: "fi_b2",
        requirementLineageId: "r_b2",
        requirementVersionId: "rv_b2",
        caseVersionId: "cv_b2",
        floorCase: true,
        targetQuestionId: "S4",
        expansionCertificate: "cert",
        case: {
          kind: "boundary",
          routeAnswer: null,
          boundaryInput: { bound: "min", value: "0", expectedOutcome: "rejected" },
          configuration: null,
          expectedDestination: null,
          optionSet: null,
        },
        expectationGap: null,
        screen: null,
        label: null,
      },
    ];
    const result = mod.plan.stampSurvivalHints(carriers, {}, [], facetInstances);
    // Should be in unstampable, not in prefer_value.
    assert(result.unstampable.some((u) => u.question === "S4" && u.why.includes("conflicting")),
      `conflicting boundaries not refused: ${JSON.stringify(result.unstampable)}`);
    const d = carriers[0].decisions[0];
    assertEq(d.prefer_value, undefined, "conflicting boundaries should not stamp prefer_value");
  });
});

/* ============================================================
   OUTCOME 3: DETECTION FUNCTION UNIT TESTS
   ============================================================ */

suite("D1-OUTCOME3 — detectTerminationAnnouncement precision", () => {
  test("matches 'status: Terminated' (the Confirmit pattern)", async () => {
    const mod = await worker();
    const result = mod.driver.detectTerminationAnnouncement(
      screen("For testing only. Survey status: Terminated at S10"),
      ["S10", "S20"],
    );
    assert(result !== null, "did not detect 'status: Terminated'");
    assertEq(result.questionToken, "S10");
  });

  test("matches 'unable to accept' (the Confirmit decline pattern)", async () => {
    const mod = await worker();
    const result = mod.driver.detectTerminationAnnouncement(
      screen("We are unable to accept your offer to participate."),
      [],
    );
    assert(result !== null, "did not detect 'unable to accept'");
  });

  test("does NOT match ordinary prose with 'end'", async () => {
    const mod = await worker();
    const result = mod.driver.detectTerminationAnnouncement(
      screen("At the end of the day, which product do you prefer?"),
      [],
    );
    assertEq(result, null, `false positive on ordinary prose: ${JSON.stringify(result)}`);
  });

  test("does NOT match 'thank you for completing' (completion, not screenout)", async () => {
    const mod = await worker();
    const result = mod.driver.detectTerminationAnnouncement(
      screen("Thank you for completing the survey."),
      [],
    );
    assertEq(result, null, `false positive on completion wording: ${JSON.stringify(result)}`);
  });
});
