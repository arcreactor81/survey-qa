/**
 * D59 — RECORD HONESTY: the run record must tell the truth.
 *
 * Four defects from the harvest-run audit (24 Aug), all about the run record telling
 * the truth about what happened:
 *
 *   1. FALSE ZEROS: pivot timeout catch wrote wallMs=0 and timestamps at `new Date()`
 *      instead of the REAL elapsed time.
 *   2. CRASH-AS-SCREENOUT: a browser crash must produce `ending.kind: "crashed"`, never
 *      `"screened-out"`. Screen-out requires on-screen evidence from an intact page.
 *   3. LABEL COHERENCE: `walkReachedEnding` (execute-batch.ts) and `reachedAnEnding`
 *      (assemble-record.mjs) must agree on every input.
 *   4. SELECT-GRID-CELL READBACK RECEIPTS: `verifyChoiceGroupsAfterInteraction` must
 *      check `select-grid-cell` actions, not only `click-option`.
 *
 * Evidence each test can fail: each asserts a specific value that the OLD code did not
 * produce (wallMs was 0, ending.kind was "screened-out" or "unclassified" for crashes,
 * grid-cell mismatches were unchecked). A mutation that reverts the fix makes the test
 * fail.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// 1. FALSE ZEROS — pivot timeout wallMs must reflect real elapsed time
// ---------------------------------------------------------------------------

suite("D59-FALSE-ZEROS — pivot timeout carries real wallMs", () => {
  test("walkRecord reflects steps from the observation", async () => {
    const mod = await worker();
    const { walkRecord } = mod.executeBatch;

    // A synthetic observation with steps — screensAdvanced must match
    const obs = {
      kind: "v2-path-observation/1.0.0",
      runId: "run_test",
      pathId: "path_1",
      tier: 1,
      attemptId: "att_1",
      planRevisionId: "plan_1",
      surveyUrl: "https://fixture.invalid/survey",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:05:00.000Z",
      wallMs: 300000,
      plannedWitnesses: [],
      steps: [
        { stepIndex: 0, advanced: true, actions: [] },
        { stepIndex: 1, advanced: true, actions: [] },
        { stepIndex: 2, advanced: false, actions: [] },
      ],
      outcome: "per-case-timeout",
      outcomeDetail: "walk exceeded its per-case budget",
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: [],
      viewport: { width: 1280, height: 900 },
    };

    const record = walkRecord(obs, []);
    assertEq(record.screensAdvanced, 2, "screensAdvanced counts steps where advanced=true");
    assertEq(record.wallMs, 300000, "wallMs from the observation is preserved");
    assertEq(record.steps, 3, "step count from the observation is preserved");
  });

  test("walkRecord on an empty-steps observation preserves wallMs (the honest answer)", async () => {
    const mod = await worker();
    const { walkRecord } = mod.executeBatch;

    const obs = {
      kind: "v2-path-observation/1.0.0",
      runId: "run_test",
      pathId: "path_1",
      tier: 1,
      attemptId: "att_1",
      planRevisionId: "plan_1",
      surveyUrl: "https://fixture.invalid/survey",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:01:30.000Z",
      wallMs: 90000,
      plannedWitnesses: [],
      steps: [],
      outcome: "per-case-timeout",
      outcomeDetail: "walk exceeded its per-case budget",
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: [],
      viewport: { width: 1280, height: 900 },
    };

    const record = walkRecord(obs, []);
    assertEq(record.screensAdvanced, 0, "no steps means screensAdvanced is honestly 0");
    // THE FIX: wallMs must be the REAL elapsed time, not hardcoded 0
    assertEq(record.wallMs, 90000, "wallMs is the real elapsed time from the observation, not 0");
  });
});

// ---------------------------------------------------------------------------
// 2. CRASH-AS-SCREENOUT — browser crash must produce ending.kind: "crashed"
// ---------------------------------------------------------------------------

suite("D59-CRASH-AS-SCREENOUT — crash produces crashed ending, never screened-out", () => {
  const screenoutPage = () => ({
    at: "2026-08-08T00:05:00.000Z",
    url: "https://fixture.invalid/survey",
    title: null,
    collectedErrors: [],
    questionText: "Thank you for your interest. Unfortunately you do not qualify for this study.",
    instructionText: null,
    visibleText: "Thank you for your interest. Unfortunately you do not qualify for this study.",
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls: [],
    optionGroups: [],
    grid: null,
    buttons: [],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
    screenSignature: "sig:screenout",
  });

  test("classifyEnding with crashed=false on a screenout page returns screened-out", async () => {
    const mod = await worker();
    const { classifyEnding } = mod.driver;
    const ending = classifyEnding(screenoutPage(), {
      outcome: "no-advance-control",
      unboundDecisions: 0,
    });
    assertEq(ending.kind, "screened-out", "a screenout page without crash flag returns screened-out");
  });

  test("classifyEnding with crashed=true on a screenout page returns crashed, not screened-out", async () => {
    const mod = await worker();
    const { classifyEnding } = mod.driver;
    const ending = classifyEnding(screenoutPage(), {
      outcome: "error",
      unboundDecisions: 0,
      crashed: true,
    });
    assertEq(ending.kind, "crashed", "a crashed walk must never be typed as screened-out");
    assert(
      ending.evidence.some((e) => e.includes("crashed")),
      "the evidence must mention the crash",
    );
  });

  test("classifyEnding with crashed=true and no final screen returns crashed", async () => {
    const mod = await worker();
    const { classifyEnding } = mod.driver;
    const ending = classifyEnding(null, {
      outcome: "error",
      unboundDecisions: 0,
      crashed: true,
    });
    assertEq(ending.kind, "crashed", "a crash with no final screen is crashed, not unclassified");
  });

  test("classifyEnding with crashed=false and no final screen returns unclassified (existing behavior)", async () => {
    const mod = await worker();
    const { classifyEnding } = mod.driver;
    const ending = classifyEnding(null, {
      outcome: "error",
      unboundDecisions: 0,
    });
    assertEq(ending.kind, "unclassified", "no crash flag and no screen remains unclassified");
  });

  test("classifyEnding with crashed=true on a completion page returns crashed", async () => {
    const mod = await worker();
    const { classifyEnding } = mod.driver;
    const completionPage = {
      ...screenoutPage(),
      questionText: "Thank you for completing the survey.",
      visibleText: "Thank you for completing the survey.",
    };
    const ending = classifyEnding(completionPage, {
      outcome: "error",
      unboundDecisions: 0,
      crashed: true,
    });
    assertEq(ending.kind, "crashed", "a crashed walk on a completion page is still crashed");
  });
});

// ---------------------------------------------------------------------------
// 3. LABEL COHERENCE — walkReachedEnding and reachedAnEnding must agree
// ---------------------------------------------------------------------------

suite("D59-LABEL-COHERENCE — walkReachedEnding and reachedAnEnding agree", () => {
  const COHERENCE_CASES = [
    { ending: { kind: "completed", evidence: ["fixture"] }, outcome: "no-advance-control", loadCrash: false, expected: true, label: "completed ending" },
    { ending: { kind: "screened-out", evidence: ["fixture"] }, outcome: "no-advance-control", loadCrash: false, expected: true, label: "screened-out ending" },
    { ending: { kind: "stalled", evidence: ["fixture"] }, outcome: "blocked", loadCrash: false, expected: false, label: "stalled ending" },
    { ending: { kind: "unclassified", evidence: ["fixture"] }, outcome: "no-advance-control", loadCrash: false, expected: false, label: "unclassified ending" },
    { ending: { kind: "crashed", evidence: ["fixture"] }, outcome: "error", loadCrash: false, expected: false, label: "crashed ending" },
    { ending: undefined, outcome: "completed", loadCrash: false, expected: true, label: "legacy row with outcome=completed" },
    { ending: undefined, outcome: "no-advance-control", loadCrash: false, expected: true, label: "legacy row with outcome=no-advance-control" },
    { ending: undefined, outcome: "error", loadCrash: false, expected: false, label: "legacy row with outcome=error" },
    { ending: undefined, outcome: "per-case-timeout", loadCrash: false, expected: false, label: "legacy row with outcome=per-case-timeout" },
    { ending: { kind: "completed", evidence: ["fixture"] }, outcome: "completed", loadCrash: true, expected: false, label: "loadCrash overrides completed ending" },
  ];

  for (const c of COHERENCE_CASES) {
    test(`walkReachedEnding: ${c.label} → ${c.expected}`, async () => {
      const mod = await worker();
      const { walkReachedEnding } = mod.executeBatch;
      const walk = { ending: c.ending, outcome: c.outcome, loadCrash: c.loadCrash };
      assertEq(walkReachedEnding(walk), c.expected, c.label);
    });

    test(`reachedAnEnding (assemble-record.mjs): ${c.label} → ${c.expected}`, async () => {
      const mod = await worker();
      const { reachedAnEnding } = mod.assembleRecordProjection;
      const walk = { ending: c.ending, outcome: c.outcome, loadCrash: c.loadCrash };
      assertEq(reachedAnEnding(walk), c.expected, `reachedAnEnding: ${c.label}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. SELECT-GRID-CELL READBACK RECEIPTS
// ---------------------------------------------------------------------------

suite("D59-GRID-READBACK — verifyChoiceGroupsAfterInteraction covers select-grid-cell", () => {
  test("a select-grid-cell action with readback is verified in post-interaction check", async () => {
    const mod = await worker();
    const { verifyChoiceGroupsAfterInteraction } = mod.driver;

    const before = {
      optionGroups: [
        {
          kind: "radio",
          name: "grid_q1",
          formOwner: null,
          options: [
            { idx: 10, label: "Strongly agree", code: "1", checked: false },
            { idx: 11, label: "Agree", code: "2", checked: false },
            { idx: 12, label: "Neutral", code: "3", checked: false },
          ],
        },
      ],
    };

    // After interaction: the grid cell click was OVERWRITTEN — idx 10 was clicked but
    // now idx 12 is checked (e.g. a linked text input auto-selected a different option)
    const afterAction = {
      optionGroups: [
        {
          kind: "radio",
          name: "grid_q1",
          formOwner: null,
          options: [
            { idx: 10, label: "Strongly agree", code: "1", checked: false },
            { idx: 11, label: "Agree", code: "2", checked: false },
            { idx: 12, label: "Neutral", code: "3", checked: true },
          ],
        },
      ],
    };

    const actions = [
      {
        kind: "select-grid-cell",
        targetIdx: 10,
        targetLabel: "Row 1 / Col 1",
        targetCode: "1",
        value: null,
        ok: true,
        detail: "clicked grid cell",
        choiceReadback: {
          idx: 10,
          type: "radio",
          name: "grid_q1",
          formOwner: null,
          checked: true,
          checkedGroupIdxs: [10],
        },
      },
    ];

    const observations = verifyChoiceGroupsAfterInteraction(before, afterAction, actions);
    assert(observations.length > 0, "a mismatch for select-grid-cell must be detected");
    assertEq(
      observations[0].kind,
      "select-grid-cell",
      "the mismatch action uses the original kind (select-grid-cell), not click-option",
    );
    assertEq(observations[0].ok, false, "the mismatch is recorded as not ok");
    assert(
      observations[0].detail.includes("choice-group-verification-mismatch"),
      "the detail names the mismatch",
    );
  });

  test("a click-option mismatch still uses kind click-option (existing behavior preserved)", async () => {
    const mod = await worker();
    const { verifyChoiceGroupsAfterInteraction } = mod.driver;

    const before = {
      optionGroups: [
        {
          kind: "radio",
          name: "q1",
          formOwner: null,
          options: [
            { idx: 0, label: "Yes", code: "1", checked: false },
            { idx: 1, label: "No", code: "2", checked: false },
          ],
        },
      ],
    };

    const afterAction = {
      optionGroups: [
        {
          kind: "radio",
          name: "q1",
          formOwner: null,
          options: [
            { idx: 0, label: "Yes", code: "1", checked: false },
            { idx: 1, label: "No", code: "2", checked: true },
          ],
        },
      ],
    };

    const actions = [
      {
        kind: "click-option",
        targetIdx: 0,
        targetLabel: "Yes",
        targetCode: "1",
        value: null,
        ok: true,
        detail: "clicked option",
        choiceReadback: {
          idx: 0,
          type: "radio",
          name: "q1",
          formOwner: null,
          checked: true,
          checkedGroupIdxs: [0],
        },
      },
    ];

    const observations = verifyChoiceGroupsAfterInteraction(before, afterAction, actions);
    assert(observations.length > 0, "the click-option mismatch is still detected");
    assertEq(observations[0].kind, "click-option", "the mismatch uses kind click-option");
  });

  test("no select-grid-cell mismatch when readback is consistent", async () => {
    const mod = await worker();
    const { verifyChoiceGroupsAfterInteraction } = mod.driver;

    const before = {
      optionGroups: [
        {
          kind: "radio",
          name: "grid_q1",
          formOwner: null,
          options: [
            { idx: 10, label: "Strongly agree", code: "1", checked: false },
            { idx: 11, label: "Agree", code: "2", checked: false },
          ],
        },
      ],
    };

    // After interaction: the grid cell click is still correct
    const afterAction = {
      optionGroups: [
        {
          kind: "radio",
          name: "grid_q1",
          formOwner: null,
          options: [
            { idx: 10, label: "Strongly agree", code: "1", checked: true },
            { idx: 11, label: "Agree", code: "2", checked: false },
          ],
        },
      ],
    };

    const actions = [
      {
        kind: "select-grid-cell",
        targetIdx: 10,
        targetLabel: "Row 1 / Col 1",
        targetCode: "1",
        value: null,
        ok: true,
        detail: "clicked grid cell",
        choiceReadback: {
          idx: 10,
          type: "radio",
          name: "grid_q1",
          formOwner: null,
          checked: true,
          checkedGroupIdxs: [10],
        },
      },
    ];

    const observations = verifyChoiceGroupsAfterInteraction(before, afterAction, actions);
    assertEq(observations.length, 0, "no mismatch when the grid cell readback is consistent");
  });
});

// ---------------------------------------------------------------------------
// CRASH-AS-SCREENOUT — WalkEndingKind includes "crashed"
// ---------------------------------------------------------------------------

suite("D59-CRASH-TYPE — crashed is a recognized WalkEndingKind", () => {
  test("walkRecord carries crashed ending from the observation", async () => {
    const mod = await worker();
    const { walkRecord, walkReachedEnding } = mod.executeBatch;

    const obs = {
      kind: "v2-path-observation/1.0.0",
      runId: "run_test",
      pathId: "path_1",
      tier: 1,
      attemptId: "att_1",
      planRevisionId: "plan_1",
      surveyUrl: "https://fixture.invalid/survey",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:01:00.000Z",
      wallMs: 60000,
      plannedWitnesses: [],
      steps: [],
      outcome: "error",
      outcomeDetail: "browser process died",
      ending: { kind: "crashed", evidence: ["the browser crashed"] },
      shimmed: false,
      shimNote: null,
      loadFailure: null,
      evidenceIds: [],
      viewport: { width: 1280, height: 900 },
    };

    const record = walkRecord(obs, []);
    assert(record.ending !== undefined, "ending is carried on the record");
    assertEq(record.ending.kind, "crashed", "ending.kind is crashed");
    assertEq(record.outcome, "error", "outcome is error");
    // Label coherence: a crashed ending is not "reached an ending"
    assertEq(walkReachedEnding(record), false, "a crashed walk did not reach an ending");
  });
});
