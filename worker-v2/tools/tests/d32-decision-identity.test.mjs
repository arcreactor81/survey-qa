/**
 * D32 — A PLANNED DECISION IS BOUND TO A SCREEN BY IDENTITY, OR IT IS REFUSED AND COUNTED.
 *
 * ===================== THE DEFECT, AS PRODUCTION PERFORMED IT =====================
 *
 * Run `v2r_01kzfb6py8pbxznqv022p2qkhb` walked the survey cleanly and reported 8 cases
 * exercised. THREE OF THEM CARRY EVIDENCE FROM THE WRONG QUESTION.
 *
 * Case `fi_d2db2a271da3fc008605` tests the route Q7 = "Can't remember" → Q9. Its decision for
 * Q7 was the ONLY decision on that walk with a non-empty `select` in the region — the planner
 * emitted 275 of its 286 decisions with an EMPTY one. The survey prints no question ids in its
 * text, so `matchDecision` had no identity signal at all and fell back to option-label overlap,
 * and `labelMatches` is containment-tolerant. On an EARLIER screen offering
 * "Don't know / can't remember", "Can't remember" is contained in that label, the Q7 decision
 * scored, bound, was clicked there, and `remaining.splice()` consumed it. When the REAL Q7
 * screen arrived — offering exactly "Can't remember" — the decision was gone and
 * `navigator-default` clicked "1: Yes", taking the OPPOSITE BRANCH. The case was then marked
 * exercised and closed. It claims to have verified a route the walk never took.
 *
 * THIS WAS REPRODUCED LIVE, against the real survey, through the real `walkPath`, before the
 * fix (local Chrome, zero Browser Rendering quota):
 *
 *     step 4 | bound=Q7 | screen="Thinking about the most recent occasion when you bought
 *              coffee…" | clicked=9:Don't know / can't remember
 *     step 8 | bound=null (navigator-default) | screen="In the past 3 months, have you tried a
 *              coffee product at home…" | clicked=1:Yes  [DEFAULT]
 *
 * Every string in the fixtures below is copied from that production contract revision and that
 * live capture. The screens are the real screens; the wordings are the real `displayQuote`s.
 *
 * ===================== WHY A TIGHTER MATCHER IS NOT THE FIX =====================
 *
 * One of the three measured mis-bindings matched "Yes" against "Yes" EXACTLY, on the wrong
 * screen. Exact-match containment rules do not help: WITHOUT QUESTION IDENTITY, BINDING IS
 * AMBIGUOUS IN PRINCIPLE. So the plan now stamps the DOCUMENT'S OWN WORDING on every decision
 * and the driver binds on that, corroborated by the ids the screen's controls carry, and
 * REFUSES when it has neither.
 *
 * ===================== WHAT THE HALVES OF THIS FILE ARE FOR =====================
 *
 *   THE REPRO — the production case, at the binder and end-to-end through `walkPath`. Fails on
 *   the code as it was; the end-to-end one fails by clicking the wrong option on the wrong
 *   screen, which is the defect itself and not a proxy for it.
 *
 *   THE COUNTERWEIGHTS — half the file, because a driver that refuses everything would pass
 *   every "no mis-binding" test and destroy the product. A screen its wording identifies MUST
 *   bind even when the option it wants is MISSING (that absence is the finding this product
 *   exists to report), and a question the contract never worded must still bind by markup.
 *
 *   THE REFUSALS — each named, each counted, none of them silent.
 *
 *   THE PLANNER — the wording resolver (including the sibling scope that a prior investigation
 *   got wrong), the instruction rows that are not wording, the routing conditions that no
 *   option can ever match, and the named limitations.
 *
 * MARKUP IS DELIBERATELY ABSENT FROM THE WORDING FIXTURES. The live survey happens to emit
 * `name="Q7"`, and if these screens did too, every wording assertion would pass whether or not
 * the wording resolver worked at all — the exact shape of un-failable check this repo keeps
 * shipping. Screens meant to prove the WORDING path carry GUID control names instead.
 *
 * EVIDENCE THESE CAN FAIL: `tools/mutate-binding.mjs`.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { passingGates } from "../fixtures/v2-fixture.mjs";

// ---------------------------------------------------------------------------
// The real strings, from the sealed revision cr_c3929b372c…944f and the live capture.
// ---------------------------------------------------------------------------

const DOC = {
  Q3: "Thinking about the most recent occasion when you bought coffee to drink at home, where did you buy it?",
  Q7: "In the past 3 months, have you tried a coffee product at home that was new to you - for example a brand, blend, roast or format you had not tried before?",
  Q8: "You said that in the past 3 months you have tried a coffee product at home that was new to you. Please tell us what it was, and what made you try it.",
  S2: "How often, if at all, do you drink coffee at home? Please include any kind of coffee that you make or prepare yourself at home - brewed, instant, pods or capsules, hot or cold.",
  D1: "Finally, which of the following best describes you?",
};

const Q3_OPTIONS = [
  ["1", "Supermarket or grocery store, shopping in person"],
  ["2", "Supermarket or grocery store website, for delivery or pick-up"],
  ["3", "Amazon or another online-only retailer"],
  ["6", "A coffee shop or cafe"],
  ["8", "Somewhere else"],
  // THE ONE THAT ATE THE Q7 DECISION.
  ["9", "Don't know / can't remember"],
];
const Q7_OPTIONS = [
  ["1", "Yes"],
  ["2", "No"],
  ["3", "Can't remember"],
];
const S2_OPTIONS = [
  ["1", "Every day"],
  ["2", "4 to 6 days a week"],
  ["6", "I never drink coffee at home"],
];

// ---------------------------------------------------------------------------
// Screen builders. `named` carries the document's question id in its control names; `opaque`
// carries GUIDs, which is what a real Decipher / Qualtrics / SurveyJS instrument may emit and
// what forces the wording path to do the work.
// ---------------------------------------------------------------------------

let guidSeed = 0;
const opaqueName = () => `ctl_${(guidSeed += 1).toString(16).padStart(8, "0")}-4a1b-11ef-9c22-0242ac120002`;

const control = (idx, name, id, code, label) => ({
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
});

const nextBtn = (idx) => ({ idx, label: "Next", role: "next", disabled: false, visible: true });

/**
 * One question on one screen.
 *
 * `heading` is what `page-script.ts` reports as `questionText`; `extra` is prose the site
 * renders below it — on the live survey S2's document sentence continues into exactly such a
 * line, which is why the score's recall is taken over the whole screen and not the heading.
 */
function screenFor({ heading, options = [], id = null, extra = "", textInput = false }) {
  const group = { name: id ?? opaqueName(), kind: "radio", options: [] };
  const controls = [];
  options.forEach(([code, label], i) => {
    const ctlName = id ?? opaqueName();
    controls.push(control(i, ctlName, id ? `${id}_${code}` : `${ctlName}_${code}`, code, label));
    group.options.push({ order: i, idx: i, code, label, checked: false, disabled: false, visible: true });
  });
  if (textInput) {
    const ctlName = id ?? opaqueName();
    controls.push({
      ...control(controls.length, ctlName, id ? `${id}_txt` : `${ctlName}_txt`, null, heading),
      tag: "input",
      type: "text",
      checked: null,
      value: "",
    });
  }
  const visibleText = [heading, extra, ...options.map(([, label]) => label), "Back", "Next"].filter(Boolean).join("\n");
  return {
    at: "2026-08-08T00:30:00.000Z",
    url: "https://survey-qa-target-t1-easy.arcreactor81.workers.dev/",
    title: null,
    collectedErrors: [],
    questionText: heading,
    instructionText: extra || null,
    visibleText,
    visibleTextTruncated: false,
    bracketedInstructionsVisible: [],
    controls,
    optionGroups: options.length > 0 ? [group] : [],
    grid: null,
    buttons: [nextBtn(controls.length)],
    progress: { present: true, kind: "bar", now: 1, max: 10, text: null },
    validationMessages: [],
    counts: {
      controls: controls.length,
      optionGroups: options.length > 0 ? 1 : 0,
      options: options.length,
      textInputs: textInput ? 1 : 0,
    },
    screenSignature: `sig:${heading}`,
  };
}

/** The three live screens this defect happened on, with NO document ids in the markup. */
const q3Screen = () => screenFor({ heading: DOC.Q3, options: Q3_OPTIONS });
const q7Screen = () => screenFor({ heading: DOC.Q7, options: Q7_OPTIONS });
const q8Screen = () => screenFor({ heading: DOC.Q8, textInput: true });

/** A planned decision, in the shape `stampQuestionWording` leaves behind. */
const decision = (question, select, wording, extra = {}) => ({
  question,
  select,
  source: "default:navigator-discretion",
  ...(wording ? { question_text: wording, question_text_source: `scope-exact:question:${question}` } : {}),
  ...extra,
});

/** The production case: Q7 = "Can't remember" → Q9. */
const q7RouteDecision = () =>
  decision("Q7", ["Can't remember"], DOC.Q7, {
    source: "typed-case:fi_d2db2a271da3fc008605",
    case_action: {
      facetInstanceId: "fi_d2db2a271da3fc008605",
      targetQuestionId: "Q7",
      kind: "route",
      routeAnswer: { code: "3", label: "Can't remember" },
      boundaryInput: null,
    },
  });

// ===========================================================================
suite("D32 — THE REPRO: the production mis-binding, at the binder", () => {
  test("THE DEFECT: a foreign screen offering a similar label no longer eats the Q7 decision", async () => {
    const mod = await worker();

    // Exactly the production shape: the Q3 decision has an EMPTY select (275 of 286 did), the
    // Q7 decision is the one carrying an answer, and NOTHING on this screen is a document id.
    const remaining = [decision("Q3", [], DOC.Q3), q7RouteDecision()];
    const bound = mod.driver.bindDecision(q3Screen(), remaining, ["Q3", "Q7"]);

    assertEq(bound.match?.decision.question, "Q3", `bound ${bound.match?.decision.question} via ${bound.match?.via}`);
    assert(/wording:/.test(bound.match.via), `the wording must be the binding evidence, got ${bound.match.via}`);

    // The Q7 decision is UNTOUCHED and still pending — the half of the repair that matters.
    remaining.splice(bound.match.index, 1);
    assertEq(remaining.length, 1);
    assertEq(remaining[0].question, "Q7");

    // …and it binds on its own screen, where the label it wants really is offered.
    const onQ7 = mod.driver.bindDecision(q7Screen(), remaining, ["Q3", "Q7"]);
    assertEq(onQ7.match?.decision.question, "Q7");
  });

  test("THE REFUSAL ARM: with nothing else to bind, a similar label ALONE is refused, not bound", async () => {
    const mod = await worker();

    // The Q3 decision has already been used, so option overlap is the ONLY thing the old
    // binder had — and it bound. This is the exact input on which it produced a wrong answer.
    const bound = mod.driver.bindDecision(q3Screen(), [q7RouteDecision()], ["Q3", "Q7"]);

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
    assertEq(bound.refusals.length, 1);
    assertEq(bound.refusals[0].question, "Q7");
    assertEq(bound.refusals[0].reason, "option-labels-only");
    assert(
      /Two different questions may offer the same words/.test(bound.refusals[0].detail),
      "the refusal must say WHY, not just that",
    );
  });

  test("exactness does not rescue the old rule: 'Yes' against 'Yes' on the wrong screen also refuses", async () => {
    const mod = await worker();

    // One of the three measured mis-bindings was an EXACT label match on a foreign screen.
    // A stricter `labelMatches` would have bound this one too.
    const yesNo = screenFor({ heading: "Do you own a coffee machine?", options: [["1", "Yes"], ["2", "No"]] });
    const bound = mod.driver.bindDecision(yesNo, [decision("Q8", ["Yes"], DOC.Q8)], ["Q8"]);

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
    assertEq(bound.refusals[0].reason, "option-labels-only");
  });
});

// ===========================================================================
// END TO END. Not a proxy: the real `walkPath` over the real screens, asserting on WHAT WAS
// CLICKED. `PageLike` is a structural interface, so a fake page drives production code.
// ===========================================================================

function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0] ?? null;
  const clicked = [];
  const handle = (idx) => ({
    async click() {
      clicked.push(idx);
    },
    async type() {},
    async focus() {},
  });
  return {
    clicked,
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
      return Array.from({ length: 16 }, (_, i) => handle(i));
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

async function walk(mod, env, { decisions, reads, maxSteps }) {
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: "FLOOR-01--fi_d2db2a271da3fc008605", decisions, witnesses: ["req_route_q7"] },
    {
      surveyUrl: "https://survey-qa-target-t1-easy.arcreactor81.workers.dev/",
      runId,
      planRevisionId: "plan_d32test01",
      attemptId: "att_d32test0001",
      tier: 1,
      maxSteps,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs: 200,
    },
    { env, runId, attemptId: "att_d32test0001", pathId: "FLOOR-01--fi_d2db2a271da3fc008605", witnesses: [] },
  );
  return { obs, page };
}

const optionClicks = (step) => step.actions.filter((a) => a.kind === "click-option");

// ===========================================================================
suite("D32 — THE REPRO, end to end: what the walk actually clicked", () => {
  test("THE ROUTE CASE CLICKS ITS ANSWER ON ITS OWN SCREEN, not on the screen that resembles it", async () => {
    const mod = await worker();
    const env = testEnv();

    // THE PRODUCTION SHAPE, EXACTLY. The Q3 decision carries NO wording — under the old code
    // no decision carried any, which is why option overlap was the only thing left and why the
    // Q7 decision could win a screen that was not Q7's. A fixture in which the rival decision
    // also has wording would bind correctly even with the defect reinstated, and would
    // therefore prove nothing; `tools/mutate-binding.mjs` caught that draft.
    const { obs } = await walk(mod, env, {
      decisions: [decision("Q3", [], null), q7RouteDecision()],
      reads: [q3Screen(), q3Screen(), q7Screen(), q7Screen(), q8Screen(), q8Screen(), q8Screen()],
      maxSteps: 3,
    });

    const onQ3 = obs.steps[0];
    const onQ7 = obs.steps[1];

    // THE ASSERTION THE OLD CODE FAILS: "9: Don't know / can't remember" must not be clicked
    // as an ANSWER here. The navigator still answers the screen to keep walking — it just does
    // so as itself, on the record, instead of spending Q7's decision.
    assertEq(onQ3.decisionQuestion, null, JSON.stringify({ via: onQ3.bindingVia, refusals: onQ3.bindingRefusals }));
    assert(
      (onQ3.bindingRefusals ?? []).some((r) => r.question === "Q7" && r.reason === "option-labels-only"),
      JSON.stringify(onQ3.bindingRefusals),
    );
    for (const a of optionClicks(onQ3)) {
      assert(
        a.targetCode !== "9" || /navigator-default/.test(a.detail ?? ""),
        `the walk clicked "${a.targetLabel}" as a planned answer on a screen that is not Q7's`,
      );
      assert(a.value !== "Can't remember", `the Q7 decision was spent here: ${JSON.stringify(a)}`);
    }

    assertEq(onQ7.decisionQuestion, "Q7", JSON.stringify({ via: onQ7.bindingVia, refusals: onQ7.bindingRefusals }));
    assertEq(onQ7.decisionSource, "plan");
    const q7Clicks = optionClicks(onQ7);
    assertEq(q7Clicks.length, 1, JSON.stringify(q7Clicks));
    assertEq(q7Clicks[0].targetCode, "3");
    assertEq(q7Clicks[0].targetLabel, "Can't remember");
    // The proof that this was the PLAN and not the navigator: production clicked "1: Yes" here.
    assert(!/navigator-default/.test(q7Clicks[0].detail ?? ""), q7Clicks[0].detail ?? "");
  });

  test("a walk that never bound a decision SAYS SO on the observation, with a count", async () => {
    const mod = await worker();
    const env = testEnv();

    // The Q7 decision's screen never appears; a DIFFERENT question offering the confusable
    // label does. The old code spent the decision there and reported nothing missing.
    const lookalike = screenFor({ heading: "Where do you usually buy coffee beans?", options: Q3_OPTIONS });
    const { obs } = await walk(mod, env, {
      decisions: [decision("Q3", [], DOC.Q3), q7RouteDecision()],
      reads: [q3Screen(), q3Screen(), lookalike, lookalike, q8Screen(), q8Screen(), q8Screen()],
      maxSteps: 3,
    });

    assertEq(obs.unboundDecisions.length, 1, JSON.stringify(obs.unboundDecisions));
    assertEq(obs.unboundDecisions[0].question, "Q7");
    assert(Array.isArray(obs.unboundDecisions[0].wanted) && obs.unboundDecisions[0].wanted[0] === "Can't remember");
    assert(obs.bindingRefusalCount >= 1, `refusals were not counted: ${obs.bindingRefusalCount}`);
    const refused = obs.steps.flatMap((s) => s.bindingRefusals ?? []);
    assert(
      refused.some((r) => r.question === "Q7" && r.reason === "option-labels-only"),
      JSON.stringify(refused),
    );
  });
});

// ===========================================================================
// COUNTERWEIGHTS. A binder that refuses everything passes every test above.
// ===========================================================================
suite("D32 — COUNTERWEIGHTS: what must still bind", () => {
  test("THE LOAD-BEARING ONE: a screen the wording identifies binds even when it does NOT offer the answer", async () => {
    const mod = await worker();

    // The site dropped "Can't remember" from Q7. That IS the defect this product exists to
    // report — and it can only be reported if the decision still binds to the screen.
    const missing = screenFor({ heading: DOC.Q7, options: [["1", "Yes"], ["2", "No"]] });
    const bound = mod.driver.bindDecision(missing, [q7RouteDecision()], ["Q7"]);

    assertEq(bound.match?.decision.question, "Q7", `refused a screen its own wording names: ${JSON.stringify(bound.refusals)}`);
    assertEq(bound.refusals.length, 0);
  });

  test("…and end to end, the absent option is RECORDED rather than clicked at random", async () => {
    const mod = await worker();
    const env = testEnv();
    const missing = screenFor({ heading: DOC.Q7, options: [["1", "Yes"], ["2", "No"]] });

    const { obs } = await walk(mod, env, {
      decisions: [q7RouteDecision()],
      reads: [missing, missing, q8Screen(), q8Screen(), q8Screen()],
      maxSteps: 2,
    });

    assertEq(obs.steps[0].decisionQuestion, "Q7");
    assertEq(obs.steps[0].requestedButNotOffered.join("|"), "Can't remember");
  });

  test("a question the contract never worded still binds by the ids its controls carry", async () => {
    const mod = await worker();

    // Q9 has NO `facet: "question"` requirement in the real revision — there is no wording to
    // stamp. The markup arm is what keeps that decision drivable.
    const q9 = screenFor({
      heading: "How likely would you be to recommend the coffee brand you buy most often?",
      options: [["0", "0 - not at all likely"], ["10", "10 - extremely likely"]],
      id: "Q9",
    });
    const bound = mod.driver.bindDecision(q9, [decision("Q9", [], null)], ["Q9"]);

    assertEq(bound.match?.decision.question, "Q9");
    assertEq(bound.match.via, "markup:Q9");
  });

  test("a grid whose per-row names are `Q5_A` still binds Q5, by the control id prefix", async () => {
    const mod = await worker();

    const q5 = screenFor({ heading: "How much do you agree or disagree with each of the following?", options: [] });
    q5.controls = [control(0, "Q5_A", "Q5_A_1", "1", "Somewhat agree"), control(1, "Q5_B", "Q5_B_1", "1", "Somewhat agree")];
    const bound = mod.driver.bindDecision(q5, [decision("Q5", [], null)], ["Q5"]);

    assertEq(bound.match?.decision.question, "Q5");
    assertEq(bound.match.via, "markup:Q5");
  });

  test("wording and markup agreeing is a binding, and the evidence records both", async () => {
    const mod = await worker();
    const bound = mod.driver.bindDecision(screenFor({ heading: DOC.Q7, options: Q7_OPTIONS, id: "Q7" }), [q7RouteDecision()], ["Q7"]);

    assertEq(bound.match?.decision.question, "Q7");
    assert(/wording:/.test(bound.match.via) && /markup:Q7/.test(bound.match.via), bound.match.via);
    assert(/options:1/.test(bound.match.via), `option overlap is still recorded as corroboration: ${bound.match.via}`);
  });

  test("the two most similar questions in the document still bind to their OWN screens", async () => {
    const mod = await worker();

    // Q7 and Q8 share most of their words — Q8 opens "You said that in the past 3 months you
    // have tried a coffee product at home that was new to you". This is the hardest real pair
    // in the instrument, and it is where a margin rule that is too eager refuses everything.
    const remaining = [decision("Q8", [], DOC.Q8), q7RouteDecision()];
    const first = mod.driver.bindDecision(q7Screen(), remaining, ["Q7", "Q8"]);
    assertEq(first.match?.decision.question, "Q7", JSON.stringify(first.refusals));

    const second = mod.driver.bindDecision(q8Screen(), [decision("Q8", [], DOC.Q8)], ["Q7", "Q8"]);
    assertEq(second.match?.decision.question, "Q8", JSON.stringify(second.refusals));
  });
});

// ===========================================================================
suite("D32 — REFUSALS: named, counted, never a guess", () => {
  test("the words say one question and the controls say another: refuse and name both", async () => {
    const mod = await worker();

    // Q7's wording rendered on a screen whose form fields belong to Q8. One of the two
    // witnesses is wrong and the driver cannot tell which.
    const conflicted = screenFor({ heading: DOC.Q7, options: Q7_OPTIONS, id: "Q8" });
    const bound = mod.driver.bindDecision(conflicted, [q7RouteDecision()], ["Q7", "Q8"]);

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
    assertEq(bound.refusals[0].reason, "identity-conflict");
    assert(/Q8/.test(bound.refusals[0].detail) && /Q7/.test(bound.refusals[0].detail), bound.refusals[0].detail);
  });

  test("the screen names a question with no pending decision: refuse rather than spend the leftovers", async () => {
    const mod = await worker();

    // The Q3 screen, this time WITH its real markup, after Q3's decision has been used. It has
    // said what it is, and it is not Q7's — however familiar its options look.
    const bound = mod.driver.bindDecision(
      screenFor({ heading: DOC.Q3, options: Q3_OPTIONS, id: "Q3" }),
      [q7RouteDecision()],
      ["Q3", "Q7"],
    );

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
    assertEq(bound.refusals[0].reason, "screen-is-another-question");
  });

  test("two decisions describe the screen equally well: refuse both, and say so", async () => {
    const mod = await worker();

    // The same question sealed twice under two ids — a real extraction outcome (`S2` and
    // `S2_coffee` are one question in the live revision). At most one is this screen.
    const bound = mod.driver.bindDecision(
      screenFor({ heading: DOC.S2, options: S2_OPTIONS }),
      [decision("S2", [], DOC.S2), decision("S2_coffee", [], DOC.S2)],
      ["S2", "S2_coffee"],
    );

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
    assertEq(bound.refusals.length, 2);
    assert(bound.refusals.every((r) => r.reason === "identity-ambiguous"), JSON.stringify(bound.refusals));
  });

  test("a screen presenting TWO document ids in its markup is not identified by markup", async () => {
    const mod = await worker();

    // A leftover hidden control from another question. The union is fail-closed: with two ids
    // present, at most one is this screen's, so markup supplies nothing and — with no wording
    // either — nothing binds.
    const twoIds = screenFor({ heading: "Please answer the questions below.", options: [["1", "Yes"]], id: "Q7" });
    twoIds.controls.push(control(9, "Q8", "Q8_1", "1", "Yes"));
    const bound = mod.driver.bindDecision(twoIds, [decision("Q7", [], null)], ["Q7", "Q8"]);

    assertEq(bound.match, null, `bound anyway via ${bound.match?.via}`);
  });

  test("a screen nothing recognises binds nothing and refuses nothing — it is not an error", async () => {
    const mod = await worker();

    // The welcome screen. No decision wants anything here; the walk answers it by default and
    // the refusal ledger must stay empty, or every walk would report phantom limitations.
    const welcome = screenFor({ heading: "Thank you for taking part in this survey.", options: [] });
    const bound = mod.driver.bindDecision(welcome, [q7RouteDecision()], ["Q7"]);

    assertEq(bound.match, null);
    assertEq(bound.refusals.length, 0, JSON.stringify(bound.refusals));
  });
});

// ===========================================================================
// THE PLANNER HALF — where the wording comes from.
// ===========================================================================

const req = (scope, facet, quote) => ({
  requirementLineageId: `req_${scope}_${quote.slice(0, 6).replace(/\W/g, "")}`,
  requirementVersionId: `reqv_${scope}`,
  semanticFingerprint: "fp",
  scope,
  quantifier: "specific",
  selector: null,
  exceptions: [],
  facet,
  assertionStatus: "entailed",
  testability: "browser-observable",
  notBrowserObservableReason: null,
  sourceAtoms: [],
  composition: null,
  normativeStatement: quote,
  displayQuote: quote,
  retiredAt: null,
});

suite("D32 — the planner supplies the identity: wording resolution", () => {
  test("THE SIBLING SCOPE, MEASURED IN PRODUCTION: S2's wording lives under `question:S2_coffee`", async () => {
    const mod = await worker();

    // The live revision really is like this: `question:S2` carries three rows and none of them
    // is the question; the wording sits under `question:S2_coffee`. An exact-key lookup finds
    // nothing, and a prior investigation mis-reported this binding as broken for that reason.
    const index = mod.plan.buildQuestionWordingIndex({
      requirements: [
        req("question:S2", "validation", "An answer is required at S2."),
        req("question:S2_coffee", "question", DOC.S2),
      ],
    });

    const resolved = mod.plan.resolveQuestionWording(index, "S2");
    assertEq(resolved.wording?.text, DOC.S2, `via ${resolved.via}`);
    assertEq(resolved.via, "scope-sibling:question:S2_coffee");
  });

  test("…and the S2 decision it produces binds the S2 screen, whose heading is only the FIRST sentence", async () => {
    const mod = await worker();

    // The live site renders the document's second sentence as an instruction line BELOW the
    // heading. Scoring the heading alone put this at 0.556; scoring recall over the whole
    // screen puts it at 1.000. This test is that difference.
    const index = mod.plan.buildQuestionWordingIndex({ requirements: [req("question:S2_coffee", "question", DOC.S2)] });
    const paths = [{ decisions: [{ question: "S2", select: [], source: "default" }] }];
    mod.plan.stampQuestionWording(paths, index);

    const screen = screenFor({
      heading: "How often, if at all, do you drink coffee at home?",
      extra: "Please include any kind of coffee that you make or prepare yourself at home - brewed, instant, pods or capsules, hot or cold.",
      options: S2_OPTIONS,
    });
    const bound = mod.driver.bindDecision(screen, paths[0].decisions, ["S2"]);
    assertEq(bound.match?.decision.question, "S2", JSON.stringify(bound.refusals));
  });

  test("a sibling is a SEPARATOR relation: Q1 does not inherit Q10's wording, D does not inherit D1's", async () => {
    const mod = await worker();
    const index = mod.plan.buildQuestionWordingIndex({
      requirements: [
        req("question:Q10", "question", "How many cups of coffee do you drink in a typical day?"),
        req("question:D1", "question", DOC.D1),
      ],
    });

    assertEq(mod.plan.resolveQuestionWording(index, "Q1").wording, null);
    assertEq(mod.plan.resolveQuestionWording(index, "Q1").via, "no-wording-in-contract");
    assertEq(mod.plan.resolveQuestionWording(index, "D").wording, null);
    // The real relation still resolves.
    assertEq(mod.plan.resolveQuestionWording(index, "D1").wording?.text, DOC.D1);
  });

  test("two candidate siblings refuse rather than pick one", async () => {
    const mod = await worker();
    const index = mod.plan.buildQuestionWordingIndex({
      requirements: [
        req("question:S2_coffee", "question", DOC.S2),
        req("question:S2_tea", "question", "How often, if at all, do you drink tea at home in a typical week?"),
      ],
    });

    const resolved = mod.plan.resolveQuestionWording(index, "S2");
    assertEq(resolved.wording, null);
    assert(/^ambiguous-sibling-scopes:/.test(resolved.via), resolved.via);
  });

  test("PROGRAMMER INSTRUCTIONS ARE NOT WORDING: the question's own sentence wins over the rows beside it", async () => {
    const mod = await worker();

    // Every string here is from the live revision's `facet: "question"` rows. `ASK ALL.` and
    // `SINGLE CODE.` are filed under the same facet and the same scope as the question itself.
    // The instruction row is listed FIRST, so a resolver that keeps the first usable quote
    // picks it — and every screen matches an instruction equally, which is worse than no
    // signal at all.
    const index = mod.plan.buildQuestionWordingIndex({
      requirements: [
        req("question:Q3", "question", "ASK ALL."),
        req("question:Q3", "question", "SINGLE CODE. DO NOT ROTATE THIS LIST."),
        req("question:Q3", "question", DOC.Q3),
        req("question:Q3", "option-list", "A coffee shop or cafe"),
      ],
    });

    assertEq(mod.plan.resolveQuestionWording(index, "Q3").wording?.text, DOC.Q3);
  });

  test("option labels are never mistaken for a question's wording", async () => {
    const mod = await worker();

    // `question:Q2` in the live revision carries `option-list` rows reading "Keurig",
    // "Nespresso", "Nescafe Dolce Gusto". Reading those as wording would bind Q2's decision to
    // any screen that happens to offer that brand.
    const index = mod.plan.buildQuestionWordingIndex({
      requirements: [
        req("question:Q2", "option-list", "Nescafe Dolce Gusto and other pod machines"),
        req("question:Q2", "instruction", "Ask only of respondents who selected code 2 at Q1."),
      ],
    });

    assertEq(mod.plan.resolveQuestionWording(index, "Q2").wording, null);
  });

  test("stamping is ADDITIVE: it touches no existing field and moves no path signature", async () => {
    const mod = await worker();
    const index = mod.plan.buildQuestionWordingIndex({ requirements: [req("question:Q7", "question", DOC.Q7)] });

    const decisions = [{ question: "Q7", select: ["Can't remember"], source: "typed-case:fi_x", strategy: "s" }];
    const before = mod.plan.pathSignature(decisions, null);
    const result = mod.plan.stampQuestionWording([{ decisions }], index);

    assertEq(result.stamped, 1);
    assertEq(decisions[0].question_text, DOC.Q7);
    assertEq(decisions[0].select.join("|"), "Can't remember");
    assertEq(mod.plan.pathSignature(decisions, null), before, "wording must not be part of a path's identity");
  });

  test("a decision the contract cannot word is reported, not invented", async () => {
    const mod = await worker();
    const index = mod.plan.buildQuestionWordingIndex({ requirements: [req("question:Q7", "question", DOC.Q7)] });
    const result = mod.plan.stampQuestionWording([{ decisions: [{ question: "Q9", select: [], source: "d" }] }], index);

    assertEq(result.stamped, 0);
    assertEq(result.unresolved.length, 1);
    assertEq(result.unresolved[0].question, "Q9");
    assertEq(result.unresolved[0].via, "no-wording-in-contract");
  });
});

// ===========================================================================
suite("D32 — the planner stops emitting answers no option can ever match", () => {
  const routeCase = (id, target, answer) => ({
    facetInstanceId: id,
    requirementLineageId: `req_${id}`,
    requirementVersionId: `reqv_${id}`,
    caseVersionId: `cv_${id}`,
    floorCase: true,
    targetQuestionId: target,
    expansionCertificate: `cert_${id}`,
    case: {
      kind: "route",
      routeAnswer: answer,
      boundaryInput: null,
      configuration: null,
      expectedDestination: { questionId: "Q3", screen: null, terminal: null },
    },
    expectationGap: null,
    screen: target,
    label: id,
  });

  const base = () => ({
    id: "FLOOR-01",
    tier: 1,
    kind: "floor",
    intent: "cover",
    decisions: [
      { question: "Q1", select: [], source: "default" },
      { question: "Q2", select: [], source: "default" },
      // BARE-LETTER IDS ARE REAL. The live revision seals the rows of Q5's grid as `D` and `E`,
      // and an option label is free to contain those as ordinary words. They are here so the
      // "never eaten" test below is actually exposed to them.
      { question: "D", select: [], source: "default" },
      { question: "E", select: [], source: "default" },
    ],
    skipped_questions: [],
    terminated_at: null,
    witnesses: [],
    witness_notes: [],
    needs_repeats: [],
    steps: 2,
    signature: "sha256:base",
  });

  test("THE PRODUCTION ROWS: 'Code 2 at Q1' is a routing CONDITION, not something Q2 offers", async () => {
    const mod = await worker();

    // Both of these are verbatim from the sealed revision, on decisions for Q2. Left in
    // `select` they are clicked at nothing and then recorded in `requestedButNotOffered`,
    // which downstream reads as "the site is missing an option the document requires" — a
    // confident defect claim about a healthy survey.
    const cases = [
      routeCase("fi_0a7b1763978f04fc14a7", "Q2", { code: "2", label: "Code 2 at Q1" }),
      routeCase("fi_410e606955adaff5cb9f", "Q2", { code: "any_other", label: "Any other code at Q1 except 2" }),
    ];
    const result = mod.plan.materializeCasePaths([base()], cases, {
      req_fi_0a7b1763978f04fc14a7: "FLOOR-01",
      req_fi_410e606955adaff5cb9f: "FLOOR-01",
    });

    assertEq(result.routingConditionSelects.length, 2, JSON.stringify(result.routingConditionSelects));
    for (const caseId of ["fi_0a7b1763978f04fc14a7", "fi_410e606955adaff5cb9f"]) {
      const path = result.paths.find((p) => p.facet_instance_id === caseId);
      const d = path.decisions.find((x) => x.question === "Q2");
      assertEq(d.select.length, 0, `${caseId} still asks the driver to click ${JSON.stringify(d.select)}`);
      // The sealed stimulus is kept VERBATIM — the plan did not rewrite the contract.
      assert(/at Q1/.test(d.case_action.routeAnswer.label), JSON.stringify(d.case_action));
    }
    // Two cases on one question still produce two distinguishable walks.
    const sigs = new Set(result.paths.filter((p) => p.facet_instance_id).map((p) => p.signature));
    assertEq(sigs.size, 2);
  });

  test("A REAL ANSWER IS NEVER EATEN: a label is only a condition when it names another question BY NUMBER", async () => {
    const mod = await worker();

    // Bare-letter ids exist in the live revision (`D`, `E`, grid rows), and an option label is
    // free to contain those words. Only an identifier carrying a digit counts.
    const cases = [
      routeCase("fi_keeps_label", "Q2", { code: "1", label: "Keurig or another pod machine" }),
      routeCase("fi_keeps_letter", "Q2", { code: "2", label: "I agree with statement D and E" }),
    ];
    const result = mod.plan.materializeCasePaths([base()], cases, {
      req_fi_keeps_label: "FLOOR-01",
      req_fi_keeps_letter: "FLOOR-01",
    });

    assertEq(result.routingConditionSelects.length, 0, JSON.stringify(result.routingConditionSelects));
    const kept = result.paths.find((p) => p.facet_instance_id === "fi_keeps_label");
    assertEq(kept.decisions.find((d) => d.question === "Q2").select.join("|"), "Keurig or another pod machine");
  });

  test("a condition label does not silently vanish: it is returned, counted and warned about", async () => {
    const mod = await worker();
    const result = mod.plan.materializeCasePaths(
      [base()],
      [routeCase("fi_cond", "Q2", { code: "2", label: "Code 2 at Q1" })],
      { req_fi_cond: "FLOOR-01" },
    );

    assertEq(result.routingConditionSelects[0].facetInstanceId, "fi_cond");
    assert(
      result.warnings.some((w) => /routing\s+CONDITION/.test(w) && /fi_cond/.test(w)),
      JSON.stringify(result.warnings),
    );
  });
});

// ===========================================================================
suite("D32 — the plan NAMES what it could not do", () => {
  async function planned(mod, env, { facetInstances, requirements }) {
    const body = {
      schemaVersion: "v2-contract-revision/1.0.0",
      kind: "survey-qa-v2-contract-revision",
      documentRevisionId: "e".repeat(64),
      documentSha256: "e".repeat(64),
      sealedAt: "2026-08-08T00:00:00.000Z",
      requirements,
      facetInstances,
      contractSupplements: [],
      extraction: {
        passAHash: "sha256:aaa",
        passBHash: "sha256:bbb",
        sourceLedgerHash: "sha256:ccc",
        diffHash: "sha256:ddd",
        reviewMode: "high-risk-only",
        reviewedBy: "d32-fixture",
        reviewedAt: "2026-08-08T00:00:00.000Z",
        gates: passingGates(),
      },
    };
    const { contractRevisionId } = await mod.contractRevision.sealContract(env, body);
    const runId = mod.ids.mintRunId();
    return mod.plan.planStage(env, {
      runId,
      contractRevisionId,
      planRevisionId: "plan_d32limits1",
      surveyUrl: "https://survey-qa-target-t1-easy.arcreactor81.workers.dev/",
    });
  }

  const renderedCase = (id, target, lineage) => ({
    facetInstanceId: id,
    requirementLineageId: lineage,
    requirementVersionId: `reqv_${id}`,
    caseVersionId: `cv_${id}`,
    floorCase: true,
    targetQuestionId: target,
    expansionCertificate: `cert_${id}`,
    case: { kind: "rendered-state", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
    expectationGap: null,
    screen: target,
    label: id,
  });

  test("EVERY named limitation is emitted, INCLUDING at zero — 'we looked' must differ from 'nobody looked'", async () => {
    const mod = await worker();
    const env = testEnv();

    const requirements = [req("question:Q7", "question", DOC.Q7), req("question:Q3", "question", DOC.Q3)];
    const result = await planned(mod, env, {
      requirements,
      facetInstances: [renderedCase("fi_a", "Q7", requirements[0].requirementLineageId)],
    });

    // THE REGISTRY IS THE EXPECTATION, not a list copied beside it. A hand-written list here
    // says "these three were emitted" and goes quietly stale the moment a code is added — which
    // is how a NEW shortfall could ship reported at zero on the type and absent on every plan.
    // Comparing against `PLAN_LIMITATION_CODES` itself fails in BOTH directions: a code the
    // registry declares and `planStage` never emits, and a row `planStage` emits under a code
    // nothing declares.
    const declared = [...new Set(Object.values(mod.plan.PLAN_LIMITATION_CODES))].sort();
    const codes = result.limitations.map((l) => l.code).sort();
    assertEq(codes.join(","), declared.join(","));
    for (const l of result.limitations) {
      assert(typeof l.count === "number", JSON.stringify(l));
      assert(l.what.length > 40, `a limitation must say what it means: ${JSON.stringify(l)}`);
    }
    // Same block on the artifact a later stage re-reads, not only on the return value.
    assertEq(result.program.limitations.length, declared.length);
  });

  test("THE 48: cases assigned to no walk are named with their ids, not buried in a warnings array", async () => {
    const mod = await worker();
    const env = testEnv();

    // A case whose requirement no floor path witnesses. In the real run there were 48 of these
    // — a fifth of the sealed cases — and the only trace was one warning line each.
    const requirements = [req("question:Q7", "question", DOC.Q7)];
    const result = await planned(mod, env, {
      requirements,
      facetInstances: [renderedCase("fi_orphan", "Q7", "req_nothing_witnesses_this")],
    });

    const named = result.limitations.find((l) => l.code === mod.plan.PLAN_LIMITATION_CODES.unassignedCases);
    assertEq(named.count, result.program.unassignedCaseIds.length);
    assert(named.count > 0, "this fixture is supposed to strand a case; it did not");
    assert(named.caseIds.includes("fi_orphan"), JSON.stringify(named));
    assert(/assigned to NO walk/.test(named.what), named.what);
    // And it is loud in the prose channel too, at the FRONT.
    assert(
      result.program.warnings[0].startsWith(`LIMITATION ${mod.plan.PLAN_LIMITATION_CODES.unassignedCases}`),
      result.program.warnings[0],
    );
  });

  test("a program written before limitations existed reads as UNKNOWN, never as 'none'", async () => {
    const mod = await worker();
    const legacy = mod.plan.programLimitations({ kind: "v2-execution-program/2.0.0" });

    assertEq(legacy.length, 1);
    assertEq(legacy[0].code, "plan-predates-limitation-reporting");
  });
});
