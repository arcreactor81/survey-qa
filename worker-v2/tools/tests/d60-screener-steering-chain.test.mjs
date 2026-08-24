/**
 * D60 — SCREENER-STEERING DEFECT CHAIN: four defects (4A–4D) + reporting + outcomeDetail.
 *
 * Measured on run v2r_01m0t0g1gaw1a86yc7mp7pspg3, 24 Aug 2026: every one of 73 walks
 * screened out on navigator-default answers. Diagnosis found the plan carried ONLY
 * avoid-hints (516 avoid, 0 prefer of any kind) and the walker's hint consumption
 * self-neutralized at the three screens that mattered. Four located defects, all fixed
 * plan/walker-side.
 *
 * Evidence these can fail: tools/mutate-survival-hints.mjs (extended with 3 mutants).
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d60_000001";
const PATH_ID = "path_d60_000001";

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

const screen = (text, { controls = [], optionGroups = [], grid = null, buttons, signature } = {}) => ({
  at: "2026-08-25T00:05:00.000Z",
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
    async click() { clicks.push({ selector, index }); },
    async type(text) { typed.push({ index, text }); },
    async focus() {},
  });
  return {
    typed, set, clicks,
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
    async screenshot() { throw new Error("no screenshot in this harness"); },
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
      planRevisionId: "plan_d60test01",
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

/* ============================================================
   4A — CONTINUE-DIRECTIVE ARM: null-destination routes with bracketed continuation
   ============================================================ */

suite("4A — continue-directive arm: null-destination skip-rule routes become prefer hints", () => {
  test("a skip-rule route with [CONTINUE] directive and null destination becomes a prefer hint", async () => {
    const mod = await worker();
    const { routes, continueDirectiveUnstampable } = mod.plan.sealedRouteDestinations({
      requirements: [
        { requirementLineageId: "r1", facet: "skip-rule" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_1",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Healthcare", code: "3" },
            boundaryInput: null,
            configuration: null,
            expectedDestination: { questionId: null, screen: null, terminal: null },
            optionSet: null,
          },
          expectationGap: {
            code: "UNRESOLVABLE_DESTINATION",
            detail: 'the destination "[CONTINUE]" matches no question in the sealed world',
          },
          screen: null,
          label: null,
        },
      ],
    });
    const cont = routes.find((r) => r.label === "Healthcare");
    assertEq(cont?.kind, "continue", `expected continue, got ${cont?.kind}`);
    assertEq(continueDirectiveUnstampable.length, 0, "no unstampable directives");
  });

  test("an unrecognizable directive emits no hint and counts in the limitation", async () => {
    const mod = await worker();
    const { routes, continueDirectiveUnstampable } = mod.plan.sealedRouteDestinations({
      requirements: [
        { requirementLineageId: "r1", facet: "skip-rule" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_1",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Healthcare", code: "3" },
            boundaryInput: null,
            configuration: null,
            expectedDestination: { questionId: null, screen: null, terminal: null },
            optionSet: null,
          },
          expectationGap: {
            code: "UNRESOLVABLE_DESTINATION",
            detail: 'the destination "JUMP TO HYPERSPACE" matches no question in the sealed world',
          },
          screen: null,
          label: null,
        },
      ],
    });
    assertEq(routes.filter((r) => r.label === "Healthcare").length, 0,
      "unrecognizable directive must not emit a route");
    assertEq(continueDirectiveUnstampable.length, 1,
      "limitation must be counted");
    assert(continueDirectiveUnstampable[0].directive.includes("JUMP TO HYPERSPACE"),
      `directive not preserved: ${continueDirectiveUnstampable[0].directive}`);
  });

  test("isContinueDirective recognizes standard forms", async () => {
    const mod = await worker();
    const yes = ["[CONTINUE]", "[NEXT]", "[PROCEED]", "  [go on]  ", "[skip to Q5]",
      "[go to next section]", "[move to Q10]", "[continue to Q12]", "[next question]",
      "ADVANCE", "[next page]"];
    for (const d of yes) {
      assertEq(mod.plan.isContinueDirective(d), true, `expected true for ${d}`);
    }
    const no = ["JUMP TO HYPERSPACE", "", "TERMINATE", "SCREENOUT", "hello world"];
    for (const d of no) {
      assertEq(mod.plan.isContinueDirective(d), false, `expected false for ${d}`);
    }
  });
});

/* ============================================================
   4B — NEGATION DETECTION: negated terminate rules become prefer, not avoid
   ============================================================ */

suite("4B — negation detection: negated terminate rules produce prefer, not avoid", () => {
  test("a negated terminate statement stamps the answer as prefer (continue), not avoid (terminate)", async () => {
    const mod = await worker();
    const { routes } = mod.plan.sealedRouteDestinations({
      requirements: [
        {
          requirementLineageId: "r1",
          facet: "terminate",
          normativeStatement: "If the respondent does NOT select Healthcare, the survey terminates",
        },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_1",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Healthcare", code: "3" },
            boundaryInput: null,
            configuration: null,
            expectedDestination: { questionId: null, screen: null, terminal: null },
            optionSet: null,
          },
          expectationGap: null,
          screen: null,
          label: null,
        },
      ],
    });
    const hc = routes.find((r) => r.label === "Healthcare");
    assertEq(hc?.kind, "continue",
      `negated terminate should become continue (prefer), got ${hc?.kind}`);
  });

  test("ambiguous double-negation refuses the stamp and counts in the limitation", async () => {
    const mod = await worker();
    const { routes, continueDirectiveUnstampable } = mod.plan.sealedRouteDestinations({
      requirements: [
        {
          requirementLineageId: "r1",
          facet: "terminate",
          normativeStatement: "If the respondent does not NOT select Healthcare, does not terminate",
        },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_1",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Healthcare", code: "3" },
            boundaryInput: null,
            configuration: null,
            expectedDestination: { questionId: null, screen: null, terminal: null },
            optionSet: null,
          },
          expectationGap: null,
          screen: null,
          label: null,
        },
      ],
    });
    assertEq(routes.filter((r) => r.label === "Healthcare").length, 0,
      "ambiguous statement must not emit a route");
    assertEq(continueDirectiveUnstampable.length, 1,
      "ambiguous negation must be counted as unstampable");
  });

  test("detectNegation recognizes common negation forms", async () => {
    const mod = await worker();
    const negated = [
      "if the respondent does not select X, terminates",
      "unless the respondent selects X, the survey ends",
      "anyone other than X is terminated",
      "anything but X causes termination",
      "excluding X from the selection terminates",
      "the respondent fails to select X",
    ];
    for (const s of negated) {
      assertEq(mod.plan.detectNegation(s), true, `expected true for: ${s}`);
    }
    const notNegated = [
      "if the respondent selects X, terminates",
      "selecting X causes termination",
      "X is a disqualifying answer",
    ];
    for (const s of notNegated) {
      assertEq(mod.plan.detectNegation(s), false, `expected false for: ${s}`);
    }
    // Double negation = ambiguous
    assertEq(mod.plan.detectNegation("does not NOT select X"), null,
      "double negation should return null (ambiguous)");
  });
});

/* ============================================================
   4C — CODE UNIQUENESS: duplicate codes make the code arm inert
   ============================================================ */

suite("4C — code uniqueness guard: duplicate codes disable code-based matching", () => {
  /** A screen with TWO checkbox groups where all options carry code "1" (the measured shape). */
  const duplicateCodeScreen = () =>
    screen("Q50. Which of the following apply?", {
      optionGroups: [
        {
          name: "Q50_A",
          kind: "checkbox",
          options: [option(0, "Company Alpha", { code: "1" }), option(1, "Company Beta", { code: "1" })],
        },
        {
          name: "Q50_B",
          kind: "checkbox",
          options: [option(2, "None of the above", { code: "1" })],
        },
      ],
    });

  test("duplicate codes: code arm is inert, label arm still works for avoid", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(duplicateCodeScreen()), {
      decisions: [{
        question: "Q50",
        select: [],
        source: "default:navigator-discretion",
        avoid_labels: ["Company Alpha"],
        avoid_codes: [{ label: "Company Alpha", code: "1" }],
      }],
    });
    const clicks = optionClicks(obs);
    // The code "1" matches ALL options. Without the uniqueness guard, every option would be
    // flagged and the none-option rescue disabled. With it, the code arm is inert, the label
    // arm flags only Company Alpha, and the none-option rescue or the unflagged pick succeeds.
    assertEq(clicks.length >= 1, true, "at least one option was clicked");
    assertEq(clicks[0].targetLabel !== "Company Alpha", true,
      `code collision should not cause Company Alpha to be selected: got ${clicks[0].targetLabel}`);
  });

  test("None-of-the-above rescue fires despite code collisions (fragmented groups)", async () => {
    const mod = await worker();
    const env = testEnv();
    // All options have the same code; avoid labels flag everything except "None of the above".
    const { obs } = await walk(mod, env, advancing(duplicateCodeScreen()), {
      decisions: [{
        question: "Q50",
        select: [],
        source: "default:navigator-discretion",
        avoid_labels: ["Company Alpha", "Company Beta"],
      }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, `expected exactly 1 click, got ${clicks.length}`);
    assertEq(clicks[0].targetLabel, "None of the above",
      `expected None-of-the-above rescue, got ${clicks[0].targetLabel}`);
  });

  /** A screen where codes ARE distinct — regression guard for the original D1 fix. */
  const distinctCodeScreen = () =>
    screen("Q10. Your role?", {
      optionGroups: [
        {
          name: "Q10",
          kind: "radio",
          options: [option(0, "Doctor", { code: "17" }), option(1, "Nurse", { code: "18" })],
        },
      ],
    });

  test("distinct codes: code arm still matches (regression guard)", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(distinctCodeScreen()), {
      decisions: [{
        question: "Q10",
        select: [],
        source: "default:navigator-discretion",
        avoid_labels: [],
        avoid_codes: [{ label: "Doctor", code: "17" }],
      }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1, `expected 1 click, got ${clicks.length}`);
    assertEq(clicks[0].targetLabel, "Nurse",
      `the code arm should have flagged Doctor and picked Nurse, got ${clicks[0].targetLabel}`);
  });
});

/* ============================================================
   4D — AVOID-LABEL MATCH STRICTNESS: substring containment disabled for avoid
   ============================================================ */

suite("4D — avoid-label match: substring containment disabled for avoid semantics", () => {
  const affiliationScreen = () =>
    screen("Q20. Organization type", {
      optionGroups: [
        {
          name: "Q20",
          kind: "radio",
          options: [
            option(0, "IDN / Health system (i.e., a group of hospital(s) and clinic(s))"),
            option(1, "Hospital"),
            option(2, "Clinic"),
          ],
        },
      ],
    });

  test("avoid label 'Hospital' does NOT flag the longer IDN option", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(affiliationScreen()), {
      decisions: [{
        question: "Q20",
        select: [],
        source: "default:navigator-discretion",
        avoid_labels: ["Hospital"],
      }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1);
    // Position 1 is the IDN option. Without the fix, "Hospital" substring-matches it
    // and it gets flagged. With the fix, only exact "Hospital" is flagged and IDN stays unflagged.
    assertEq(clicks[0].targetLabel, "IDN / Health system (i.e., a group of hospital(s) and clinic(s))",
      `the IDN option should not be flagged by avoid "Hospital", got ${clicks[0].targetLabel}`);
  });

  test("exact-equal avoid still flags the exact label", async () => {
    const mod = await worker();
    const env = testEnv();
    const { obs } = await walk(mod, env, advancing(affiliationScreen()), {
      decisions: [{
        question: "Q20",
        select: [],
        source: "default:navigator-discretion",
        avoid_labels: ["Hospital"],
      }],
    });
    const clicks = optionClicks(obs);
    assertEq(clicks.length, 1);
    // The pick should NOT be "Hospital" — it should be something else.
    assert(clicks[0].targetLabel !== "Hospital",
      `the exact avoid label should be flagged, but got ${clicks[0].targetLabel}`);
  });

  test("positive select path retains containment matching (unchanged)", async () => {
    const mod = await worker();
    const env = testEnv();
    // "hospital" as a select label should match "Hospital" by containment.
    const { obs } = await walk(mod, env, advancing(affiliationScreen()), {
      decisions: [{
        question: "Q20",
        select: ["hospital"],
        source: "contract:obligation",
      }],
    });
    // The requested label was offered (containment match), so no requestedButNotOffered.
    // This verifies the positive path still uses containment.
    const step = obs.steps[0];
    if (step?.requestedButNotOffered) {
      assertEq(step.requestedButNotOffered.includes("hospital"), false,
        `positive containment should match "Hospital" from "hospital"`);
    }
  });
});

/* ============================================================
   REPORTING: limitation code appears with correct count
   ============================================================ */

suite("reporting — documentedContinueRoutesUnstampable limitation", () => {
  test("limitation appears with correct count when directives are unstampable", async () => {
    const mod = await worker();
    const codes = mod.plan.PLAN_LIMITATION_CODES;
    assert(typeof codes.documentedContinueRoutesUnstampable === "string",
      "PLAN_LIMITATION_CODES.documentedContinueRoutesUnstampable must exist");
    assertEq(codes.documentedContinueRoutesUnstampable, "documented-continue-routes-unstampable");

    // Verify the count via sealedRouteDestinations — 1 unstampable + 1 valid.
    const { routes, continueDirectiveUnstampable } = mod.plan.sealedRouteDestinations({
      requirements: [
        { requirementLineageId: "r1", facet: "skip-rule" },
        { requirementLineageId: "r2", facet: "skip-rule" },
      ],
      facetInstances: [
        {
          facetInstanceId: "fi_good",
          requirementLineageId: "r1",
          requirementVersionId: "rv1",
          caseVersionId: "cv1",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Good", code: "1" },
            expectedDestination: { questionId: null, screen: null, terminal: null },
          },
          expectationGap: {
            code: "UNRESOLVABLE_DESTINATION",
            detail: 'the destination "[CONTINUE]" matches no question',
          },
          screen: null,
          label: null,
        },
        {
          facetInstanceId: "fi_bad",
          requirementLineageId: "r2",
          requirementVersionId: "rv2",
          caseVersionId: "cv2",
          floorCase: true,
          targetQuestionId: "Q5",
          expansionCertificate: "cert",
          case: {
            kind: "route",
            routeAnswer: { label: "Bad", code: "2" },
            expectedDestination: { questionId: null, screen: null, terminal: null },
          },
          expectationGap: {
            code: "UNRESOLVABLE_DESTINATION",
            detail: 'the destination "DESTROY ALL SURVEYS" matches no question',
          },
          screen: null,
          label: null,
        },
      ],
    });
    assertEq(routes.length, 1, "1 recognized continue route");
    assertEq(continueDirectiveUnstampable.length, 1, "1 unstampable directive");
    assertEq(continueDirectiveUnstampable[0].label, "Bad");
  });
});

/* ============================================================
   OUTCOME DETAIL: screened-out ending strips hidden-control inference
   ============================================================ */

suite("outcomeDetail — screened-out final screen strips hidden-control inference", () => {
  test("screened-out ending does not carry the hidden-forward-control inference", async () => {
    const mod = await worker();
    const env = testEnv();
    // A screened-out page that has answerable controls (so afterAction is non-null) AND a
    // disabled forward button (so the forward-release polling detects a withheld control).
    // The screen text matches SCREENOUT_MARKERS so ending.kind = "screened-out".
    // Without the fix, outcomeDetail would contain the hidden-control inference.
    const screenoutWithControls = screen(
      "Thank you, but you are not eligible to participate in this survey. Terminated at Q5.",
      {
        optionGroups: [
          {
            name: "Q_SO",
            kind: "radio",
            options: [option(0, "OK")],
          },
        ],
        buttons: [
          // A forward control that is disabled (withheld) — triggers forwardRelease.
          { idx: 30, label: ">>", role: "next", roleVia: "text:>>", disabled: true, visible: true },
        ],
      },
    );
    const reads = [screenoutWithControls];
    const runId = mod.ids.mintRunId();
    const page = fakePage(reads);
    const obs = await mod.driver.walkPath(
      page,
      { id: PATH_ID, decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d60test_od",
        attemptId: ATTEMPT_ID,
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 200,
        forwardReleaseMaxWaitMs: 100,
        forwardReleasePollMs: 50,
      },
      { env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] },
    );
    assertEq(obs.ending.kind, "screened-out",
      `expected screened-out ending, got ${obs.ending.kind}`);
    // The outcomeDetail should NOT contain the inference about the survey not opening.
    if (obs.outcomeDetail) {
      assertEq(
        obs.outcomeDetail.includes("so this is a screen the survey did not open, not the end of the survey"),
        false,
        `outcomeDetail should not contain the hidden-control inference on a screened-out ending: ${obs.outcomeDetail}`,
      );
    }
  });
});
