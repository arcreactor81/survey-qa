/**
 * D58 — A PLATFORM NAVIGATION WIDGET'S OPTION LABELS MUST NOT POLLUTE SCREEN IDENTITY.
 *
 * ==================== THE DEFECT, AS v98 PERFORMED IT ====================
 *
 * Run v2r_01m0hzte6qmz28dpn7sgrf2kvj (v98) produced the first-ever report and settled ZERO of
 * 452 requirements. All 13 closed cases verified as insufficient — 12 with reason
 * STEP_NOT_BOUND_TO_TARGET_QUESTION, 1 with NO_TYPED_EXPECTATION.
 *
 * ROOT CAUSE, MEASURED: this platform renders a "QUESTION SKIP MENU" `<select>` on EVERY screen.
 * Its option labels ARE question IDs (S10, S20, S30, A10, etc.), and `document.body.innerText`
 * includes them all. `tokenOnScreen` scanned the full `visibleText` and found 23+ sealed question
 * IDs on the S10 screen alone — making `screenIdentity`'s union non-singleton on every screen.
 * `screenIsQuestion` therefore returned false for EVERY target, and all cases came back
 * `STEP_NOT_BOUND_TO_TARGET_QUESTION`.
 *
 * RECEIPT — exact data from the S10 screen of the v96 82-step observation (w5-obs.json, step 1):
 *
 *   visibleText starts: "S10\nWhich of the following best describes your current role?\n..."
 *   questionText: "" (empty — no heading-ish element found by the reader)
 *   controls: 4 radios with name="S10", id="S10_1" through "S10_4"
 *   ...followed by the QUESTION SKIP MENU select (name=null, id=null) with 40 options whose
 *   labels are question IDs (S10, S20, S30, A10, ...), each rendered into visibleText.
 *
 *   Before fix: tokenOnScreen("S10", ...) = true, and so is tokenOnScreen("S20", ...),
 *   tokenOnScreen("S30", ...), etc. — 23 sealed IDs found. screenIsQuestion = false.
 *   After fix: tokenOnScreen scans stripped text, finds only "S10". screenIsQuestion = true.
 *
 * ==================== WHAT THESE TESTS PIN ====================
 *
 *   POSITIVE (2)       a screen with a skip menu now binds after stripping, at BOTH the driver
 *                      and the verifier. Fails without the strip.
 *
 *   FAIL-CLOSED (2)    a screen that prints TWO sealed IDs in its own heading (not from the
 *                      menu) still refuses — the strip does not eat real question references.
 *                      And a prose-body mention of a different question does not bind.
 *
 *   COUNTERWEIGHT (1)  a screen with NO navigation widget is unaffected — stripping returns
 *                      the original text, and binding works the same as before.
 *
 * EVIDENCE THESE CAN FAIL: `tools/mutate-binding.mjs` covers `questionWordingScore`, and a new
 * mutant in `tools/mutate-verifier-identity.mjs` covers `tokenOnScreen`.
 *
 * FIXTURE FIDELITY (repo rule): every screen and option below is copied from the REAL v96/v98
 * captures, not invented. The skip menu labels are the REAL question IDs from the platform.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { worker } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// REAL PLATFORM NAVIGATION WIDGET — the exact shape from the v96 captures.
// A <select> with name=null, id=null, whose options are question-jump URLs.
// ---------------------------------------------------------------------------

const SKIP_MENU_LABELS = [
  "QUESTION SKIP MENU",
  "l", "qConsent", "QCHCaptcha", "hidCaptcha",
  "S10", "RDcheck", "hidS10", "S20", "S30", "S30a", "S35",
  "S40", "S40a", "S50", "S60", "S60x2", "hidS60v2",
  "S70", "S80", "S100", "S110", "S130", "hidS130",
  "S140", "S150", "hidPassword",
  "A10", "A20", "A30G", "A30a", "A30b",
  "B10G", "B20", "hidlpC10Ord", "Version",
  "C30", "C40", "hidlpD10Ord", "hidlpD20Ord",
];

function skipMenuControl(idx) {
  return {
    idx,
    tag: "select",
    type: "select",
    name: null,
    id: null,
    code: null,
    label: "",
    text: "",
    checked: null,
    value: "",
    disabled: false,
    required: false,
    visible: true,
    placeholder: null,
    maxlength: null,
    readOnly: false,
    options: SKIP_MENU_LABELS.map((label, i) => ({
      order: i,
      code: `https://survey.example.com/wix/p1234.aspx?__goto=${label}`,
      label,
      selected: i === 0,
      disabled: false,
    })),
  };
}

function radioControl(idx, name, id, code, label) {
  return {
    idx,
    tag: "input",
    type: "radio",
    name,
    id,
    code,
    label,
    text: "",
    checked: false,
    value: null,
    disabled: false,
    required: false,
    visible: true,
    placeholder: null,
    maxlength: null,
    readOnly: false,
  };
}

// ---------------------------------------------------------------------------
// REAL SCREENS from the v96 capture, with the skip menu block appended.
// ---------------------------------------------------------------------------

/** THE S10 SCREEN — the first screen that failed binding on v98. */
function s10ScreenWithSkipMenu() {
  const controls = [
    radioControl(0, "S10", "S10_1", "1", "Pharmacy Director"),
    radioControl(1, "S10", "S10_2", "2", "Office Reimbursement Coordinator"),
    radioControl(2, "S10", "S10_3", "3", "Pharmacist"),
    radioControl(3, "S10", "S10_4", "4", "Office Billing Coordinator"),
    skipMenuControl(4),
  ];

  const skipMenuText = SKIP_MENU_LABELS.join("\n");
  const visibleText = [
    "S10",
    "Which of the following best describes your current role?",
    " Pharmacy Director",
    " Office Reimbursement Coordinator",
    " Pharmacist",
    " Office Billing Coordinator",
    "",
    "Unique Survey Link: https://survey.example.com/wix/p1234.aspx",
    "",
    skipMenuText,
  ].join("\n");

  return {
    at: "2026-08-21T00:00:00.000Z",
    url: "https://survey.example.com/wix/p1234.aspx",
    title: null,
    collectedErrors: [],
    questionText: "",
    instructionText: null,
    visibleText,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [{
      name: "S10",
      kind: "radio",
      options: controls.slice(0, 4).map((c, i) => ({
        order: i, idx: i, code: c.code, label: c.label,
        checked: false, disabled: false, visible: true,
      })),
    }],
    grid: null,
    buttons: [{ idx: 5, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    readerLimitations: [],
    counts: { controls: 5, optionGroups: 1, options: 4, textInputs: 0 },
    screenSignature: "sig:S10",
  };
}

/** A screen with NO navigation widget — baseline: stripping must be a no-op. */
function plainS100Screen() {
  const controls = [
    radioControl(0, "S100", "S100_1", "1", "A primarily pediatric focused health system"),
    radioControl(1, "S100", "S100_2", "2", "A primarily adult focused health system"),
    radioControl(2, "S100", "S100_3", "3", "Equally a pediatric and adult focused health system"),
    radioControl(3, "S100", "S100_4", "4", "Other"),
  ];

  return {
    at: "2026-08-21T00:00:00.000Z",
    url: "https://survey.example.com/wix/p1234.aspx",
    title: null,
    collectedErrors: [],
    questionText: "",
    instructionText: null,
    visibleText: "S100\nWhat type of health system would you consider yours to be?\nSelect one\n A primarily pediatric focused health system\n A primarily adult focused health system\n Equally a pediatric and adult focused health system\n Other",
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [{
      name: "S100",
      kind: "radio",
      options: controls.map((c, i) => ({
        order: i, idx: i, code: c.code, label: c.label,
        checked: false, disabled: false, visible: true,
      })),
    }],
    grid: null,
    buttons: [{ idx: 4, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: false, kind: null, now: null, max: null, text: null },
    validationMessages: [],
    readerLimitations: [],
    counts: { controls: 4, optionGroups: 1, options: 4, textInputs: 0 },
    screenSignature: "sig:S100",
  };
}

/** A screen where TWO sealed IDs appear in the heading — must REFUSE, not bind. */
function twoSealedIdsScreen() {
  // Controls named both D20 and D30 — the multi-question screen from step 76/77
  const controls = [
    radioControl(0, "D20_1", "D20_1_1", "1", "Product X"),
    radioControl(1, "D20_1", "D20_1_2", "2", "Product Y"),
    radioControl(2, "D30_1", "D30_1_1", "1", "Product X"),
    radioControl(3, "D30_1", "D30_1_2", "2", "Product Y"),
  ];

  return {
    at: "2026-08-21T00:00:00.000Z",
    url: "https://survey.example.com/wix/p1234.aspx",
    title: null,
    collectedErrors: [],
    questionText: "",
    instructionText: null,
    visibleText: "D20 D30\nPlease allocate between products\nProduct X\nProduct Y",
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [],
    grid: null,
    buttons: [{ idx: 4, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: true, kind: "text", now: 48, max: 100, text: "Survey progress: 48%" },
    validationMessages: [],
    readerLimitations: [],
    counts: { controls: 4, optionGroups: 0, options: 0, textInputs: 0 },
    screenSignature: "sig:D20-D30",
  };
}

/** A screen whose body prose mentions a different question — must NOT bind to that question. */
function bodyMentionScreen() {
  // Screen is for A10 but body text says "Based on your answer to S10, ..."
  const controls = [
    radioControl(0, "A10_1", "A10_1_1", "1", "Never"),
    radioControl(1, "A10_1", "A10_1_2", "2", "Rarely"),
    radioControl(2, "A10_1", "A10_1_3", "3", "Sometimes"),
  ];

  return {
    at: "2026-08-21T00:00:00.000Z",
    url: "https://survey.example.com/wix/p1234.aspx",
    title: null,
    collectedErrors: [],
    questionText: "",
    instructionText: null,
    visibleText: "A10\nBased on your answer to S10, how often do you stock multiple PCVs?\n Never\n Rarely\n Sometimes",
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: [{
      name: "A10_1",
      kind: "radio",
      options: controls.map((c, i) => ({
        order: i, idx: i, code: c.code, label: c.label,
        checked: false, disabled: false, visible: true,
      })),
    }],
    grid: null,
    buttons: [{ idx: 3, label: "Next", role: "next", disabled: false, visible: true }],
    progress: { present: true, kind: "text", now: 4, max: 100, text: "Survey progress: 4%" },
    validationMessages: [],
    readerLimitations: [],
    counts: { controls: 3, optionGroups: 1, options: 3, textInputs: 0 },
    screenSignature: "sig:A10-body-mention",
  };
}

// ===========================================================================
suite("D58 — stripNavigationWidgetText removes skip menu labels from visibleText", () => {
  test("a screen with a skip menu has its menu labels stripped", async () => {
    const mod = await worker();
    const screen = s10ScreenWithSkipMenu();
    const stripped = mod.driver.stripNavigationWidgetText(screen);

    // The skip menu text should be gone
    assert(!stripped.includes("QUESTION SKIP MENU"), "skip menu header should be stripped");
    assert(!stripped.includes("\nS20\n"), "S20 from skip menu should be stripped");
    assert(!stripped.includes("\nA10\n"), "A10 from skip menu should be stripped");
    assert(!stripped.includes("\nC30\n"), "C30 from skip menu should be stripped");

    // The question's own "S10" heading should still be present
    assert(stripped.includes("S10"), "the question's own S10 must survive the strip");
    assert(stripped.includes("best describes your current role"), "question text must survive");
  });

  test("a screen without a navigation widget returns its original text unchanged", async () => {
    const mod = await worker();
    const screen = plainS100Screen();
    const stripped = mod.driver.stripNavigationWidgetText(screen);
    assertEq(stripped, screen.visibleText, "no stripping should occur on a screen without a nav widget");
  });
});

// ===========================================================================
suite("D58 — DRIVER SIDE: bindDecision works after skip menu stripping", () => {
  test("S10 with skip menu binds to its planned decision via markup", async () => {
    const mod = await worker();
    const screen = s10ScreenWithSkipMenu();
    const remaining = [
      { question: "S10", select: ["Office Billing Coordinator"], question_text: null },
      { question: "S20", select: [], question_text: null },
    ];
    const universe = ["S10", "S20", "S30", "A10", "C30"];
    const result = mod.driver.bindDecision(screen, remaining, universe);

    assert(result.match !== null, "S10 should bind");
    assertEq(result.match.decision.question, "S10", "should bind to S10, not another question");
    assert(/markup:S10/.test(result.match.via), `binding via should include markup:S10, got ${result.match.via}`);
  });
});

// ===========================================================================
suite("D58 — VERIFIER SIDE: screenIdentity returns singleton after skip menu stripping", () => {
  test("S10 screen with skip menu identifies as exactly S10", async () => {
    const mod = await worker();
    const screen = s10ScreenWithSkipMenu();
    const sealedIds = ["S10", "S20", "S30", "S30a", "S35", "S40", "A10", "A20", "C30", "C40"];
    const identity = mod.verifyObservations.screenIdentity(screen, sealedIds);

    // Before fix: identity.ids would have 10+ entries (all the skip menu IDs).
    // After fix: identity.ids should be exactly ["S10"] or a small set containing S10.
    assert(identity.ids.includes("S10"), "S10 must be in the identity set");
    assertEq(identity.ids.length, 1, `identity should be singleton {S10}, got {${identity.ids.join(", ")}}`);
  });
});

// ===========================================================================
suite("D58 — FAIL-CLOSED: multi-id screens still refuse after the fix", () => {
  test("a screen printing TWO sealed IDs in its own text refuses to bind", async () => {
    const mod = await worker();
    const screen = twoSealedIdsScreen();
    const sealedIds = ["D20", "D30", "A10", "S10"];

    // The screen prints D20 and D30 in its text AND has controls named D20_* and D30_*.
    // screenIdentity should return at least {D20, D30} — a non-singleton.
    const identity = mod.verifyObservations.screenIdentity(screen, sealedIds);
    assert(identity.ids.length >= 2, `multi-id screen should be non-singleton, got ${identity.ids.length}: {${identity.ids.join(", ")}}`);
    assert(identity.ids.includes("D20"), "D20 should be in the set");
    assert(identity.ids.includes("D30"), "D30 should be in the set");

    // bindDecision should refuse or return null for either question
    const remaining = [
      { question: "D20", select: [], question_text: null },
      { question: "D30", select: [], question_text: null },
    ];
    const result = mod.driver.bindDecision(screen, remaining, sealedIds);
    assertEq(result.match, null, "a screen with two sealed IDs in markup must not bind");
  });

  test("a prose-body mention of another question does not bind to that question", async () => {
    const mod = await worker();
    const screen = bodyMentionScreen();
    // The screen's body says "Based on your answer to S10, ..." but its controls are A10.
    // The sealed IDs on screen should include A10 (from markup) and S10 (from body text).
    // Since TWO sealed IDs are present, the screen should NOT bind to either.
    const sealedIds = ["A10", "S10", "S20", "C30"];
    const identity = mod.verifyObservations.screenIdentity(screen, sealedIds);

    // Both A10 (from markup and text) and S10 (from body text) should be found
    assert(identity.ids.includes("A10"), "A10 should be in text identity");
    assert(identity.ids.includes("S10"), "S10 from body mention should be in text identity");
    // The screen is non-singleton, so no binding should happen
    assert(identity.ids.length >= 2, `body mention should make identity non-singleton, got {${identity.ids.join(", ")}}`);
  });
});

// ===========================================================================
suite("D58 — COUNTERWEIGHT: no-nav-widget screens bind exactly as before", () => {
  test("S100 without skip menu binds to its planned decision by markup", async () => {
    const mod = await worker();
    const screen = plainS100Screen();
    const remaining = [
      { question: "S100", select: ["Equally a pediatric and adult focused health system"], question_text: null },
    ];
    const universe = ["S100", "S110"];
    const result = mod.driver.bindDecision(screen, remaining, universe);

    assert(result.match !== null, "S100 should bind");
    assertEq(result.match.decision.question, "S100", "should bind to S100");
    assert(/markup:S100/.test(result.match.via), `binding should be via markup:S100, got ${result.match.via}`);
  });
});
