/**
 * P0 honesty blockers: every case below is a place the harness could otherwise report work it
 * did not safely perform. The counterexamples are platform-neutral DOM/ledger shapes.
 * Evidence these checks can fail: tools/mutate-p0-honesty-blockers.mjs.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const button = (idx, label, role = "next", extra = {}) => ({
  idx, label, role, roleVia: `text:${label}`, disabled: false, visible: true, ...extra,
});

const screen = (overrides = {}) => ({
  at: "2026-08-13T00:00:00.000Z",
  url: "https://fixture.invalid/survey",
  title: null,
  collectedErrors: [],
  questionText: "Question?",
  instructionText: null,
  visibleText: "Question?",
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  questionRoots: [],
  grid: null,
  readerLimitations: [],
  buttons: [button(0, "Next")],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0, readerLimitations: 0 },
  selectStateSignature: "",
  historyLength: 1,
  screenSignature: "same-template",
  ...overrides,
});

function fakePage(reads) {
  const queue = [...reads];
  let last = reads[0];
  const clicks = [];
  return {
    clicks,
    async goto() {},
    async evaluate(script) {
      if (typeof script === "string" && script.includes("screenSignature")) {
        if (queue.length > 0) last = queue.shift();
        return last;
      }
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$(selector) {
      return Array.from({ length: 16 }, (_, index) => ({
        async click() { clicks.push({ selector, index }); },
        async type() {},
        async focus() {},
      }));
    },
    async screenshot() { throw new Error("fixture has no PNG"); },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

async function walk(mod, reads, decisions = [], advanceTimeoutMs = 40) {
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const page = fakePage(reads);
  const obs = await mod.driver.walkPath(
    page,
    { id: "path_p0_honesty", decisions, witnesses: [] },
    {
      surveyUrl: "https://fixture.invalid/survey",
      runId,
      planRevisionId: "plan_p0_honesty",
      attemptId: "att_p0_honesty",
      tier: 1,
      maxSteps: 1,
      deadline: Date.now() + 30_000,
      viewport: { width: 1280, height: 900 },
      applyHistoryShim: false,
      advanceTimeoutMs,
    },
    { env, runId, attemptId: "att_p0_honesty", pathId: "path_p0_honesty", witnesses: [] },
  );
  return { obs, page };
}

suite("P0 honesty blockers - disjoint question ownership", () => {
  test("two scoped question roots traverse by default and still bind nothing and earn nothing", async () => {
    const mod = await worker();
    const roots = [
      { via: "fieldset", label: "Q1?", controlIdxs: [0, 1] },
      { via: "fieldset", label: "Q2?", controlIdxs: [2, 3] },
    ];
    const s = screen({
      questionRoots: roots,
      readerLimitations: [{
        kind: "multi-question-screen-actuation-unsupported",
        detail: "two disjoint roots",
        count: 2,
      }],
      controls: [
        { idx: 0, tag: "input", type: "radio", name: "q1", id: null, code: "y", label: "Yes", text: "", checked: false, value: "y", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
        { idx: 1, tag: "input", type: "radio", name: "q1", id: null, code: "n", label: "No", text: "", checked: false, value: "n", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
        { idx: 2, tag: "input", type: "radio", name: "q2", id: null, code: "a", label: "A", text: "", checked: false, value: "a", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
        { idx: 3, tag: "input", type: "radio", name: "q2", id: null, code: "b", label: "B", text: "", checked: false, value: "b", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
      ],
      optionGroups: [
        { name: "q1", kind: "radio", options: [
          { order: 0, idx: 0, code: "y", label: "Yes", checked: false, disabled: false, visible: true, operable: true },
          { order: 1, idx: 1, code: "n", label: "No", checked: false, disabled: false, visible: true, operable: true },
        ] },
        { name: "q2", kind: "radio", options: [
          { order: 0, idx: 2, code: "a", label: "A", checked: false, disabled: false, visible: true, operable: true },
          { order: 1, idx: 3, code: "b", label: "B", checked: false, disabled: false, visible: true, operable: true },
        ] },
      ],
    });
    const decision = { question: "Q1", question_text: "Q1?", select: ["Yes"] };
    const { obs } = await walk(mod, [s], [decision]);
    // THE CONTRACT SINCE 19 AUG (run v2r_01m0dcadeay20nhmh5wap22dag, screen 75): scoped
    // roots TRAVERSE with per-root navigator defaults instead of ending the walk — but the
    // honesty core is unchanged and pinned here: no planned decision binds, the sealed
    // decision is not consumed, no coverage is earned, and the limitation still travels.
    assert(obs.outcome !== "multi-question-screen-actuation-unsupported",
      "scoped roots no longer end the walk");
    assertEq(obs.steps[0].decisionQuestion, null, "no planned decision binds on a multi-root screen");
    assertEq(obs.unboundDecisions.length, 1, "the sealed decision is NOT consumed by the traversal");
    const rootAActed = obs.steps[0].actions.some((a) => a.kind === "click-option" && (a.targetIdx === 0 || a.targetIdx === 1));
    const rootBActed = obs.steps[0].actions.some((a) => a.kind === "click-option" && (a.targetIdx === 2 || a.targetIdx === 3));
    assert(rootAActed && rootBActed, `both roots take a default: ${JSON.stringify(obs.steps[0].actions.map((a) => a.targetIdx))}`);
    assert(
      obs.steps[0].actions.some((a) => a.kind === "click-option" && String(a.detail ?? "").startsWith("navigator-default")),
      "traversal fillers carry the invented-answer label",
    );
    assertEq(mod.executeBatch.assessExercised(obs, [decision]).exercised, false, "traversal earns no coverage");
    assert(
      (obs.readerLimitations ?? []).some((l) => l.kind === "multi-question-screen-actuation-unsupported"),
      "the standing limitation still travels",
    );
  });

  test("roots WITHOUT scoped control indexes still stop before binding, defaults, or coverage", async () => {
    const mod = await worker();
    const s = screen({
      questionRoots: [
        { via: "fieldset", label: "Q1?" },
        { via: "fieldset", label: "Q2?" },
      ],
      readerLimitations: [{
        kind: "multi-question-screen-actuation-unsupported",
        detail: "two disjoint roots",
        count: 2,
      }],
      controls: [
        { idx: 0, tag: "input", type: "radio", name: "q1", id: null, code: "y", label: "Yes", text: "", checked: false, value: "y", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
        { idx: 1, tag: "input", type: "radio", name: "q2", id: null, code: "a", label: "A", text: "", checked: false, value: "a", disabled: false, required: false, visible: true, operable: true, placeholder: null, maxlength: null, readOnly: false },
      ],
    });
    const decision = { question: "Q1", question_text: "Q1?", select: ["Yes"] };
    const { obs, page } = await walk(mod, [s], [decision]);
    assertEq(obs.outcome, "multi-question-screen-actuation-unsupported");
    assertEq(obs.steps[0].actions.length, 0, JSON.stringify(obs.steps[0].actions));
    assertEq(page.clicks.length, 0, JSON.stringify(page.clicks));
    assertEq(obs.unboundDecisions.length, 1);
    assertEq(obs.navigatorDefaultAnswerCount, 0);
    assertEq(mod.executeBatch.assessExercised(obs, [decision]).exercised, false);
  });

  test("duplicate/nested labels over one owner collapse, while two ARIA groups remain two", async () => {
    const mod = await worker();
    const collapse = (0, eval)(mod.pageScript.COLLAPSE_QUESTION_ROOTS_SRC);
    const one = collapse([
      { via: "question-container", label: "Page heading", controlIdxs: [0, 1] },
      { via: "fieldset", label: "Legend", controlIdxs: [0, 1] },
    ]);
    assertEq(one.length, 1, JSON.stringify(one));
    const two = collapse([
      { via: "aria-group", label: "A", controlIdxs: [0, 1] },
      { via: "aria-group", label: "B", controlIdxs: [2, 3] },
      { via: "question-container", label: "wrapper", controlIdxs: [0, 1, 2, 3] },
    ]);
    assertEq(two.length, 2, JSON.stringify(two));
  });
});

suite("P0 honesty blockers - occurrence-aware advancement", () => {
  test("identical template with delayed numeric progress is advanced and names its proof", async () => {
    const mod = await worker();
    const p1 = screen({ progress: { present: true, kind: "progress", now: 1, max: 3, text: "1/3" } });
    const samePoll = structuredClone(p1);
    const p2 = screen({ progress: { present: true, kind: "progress", now: 2, max: 3, text: "2/3" } });
    const { obs } = await walk(mod, [p1, p1, samePoll, p2], [], 500);
    assertEq(obs.steps[0].advanced, true, JSON.stringify(obs.steps[0]));
    const receipt = obs.steps[0].actions.find((row) => row.kind === "click-next");
    assert(/advance-proof:progress-value-increased/.test(receipt?.detail ?? ""), JSON.stringify(receipt));
  });

  test("URL and history changes prove occurrence movement; answer-only state never does", async () => {
    const mod = await worker();
    const base = screen({ url: "https://fixture.invalid/roster/1", historyLength: 4, selectStateSignature: "answer-a" });
    assertEq(mod.driver.advanceSignals(base, { ...base, url: "https://fixture.invalid/roster/2" }).join(","), "url-changed");
    assertEq(mod.driver.advanceSignals(base, { ...base, historyLength: 5 }).join(","), "history-length-changed");
    assertEq(mod.driver.advanceSignals(base, { ...base, selectStateSignature: "answer-b" }).length, 0);
    assertEq(mod.driver.advanceSignals(base, structuredClone(base)).length, 0);
  });
});

suite("P0 honesty blockers - native choice ownership", () => {
  test("type, exact name, form owner and unnamed singleton identity define groups without key collisions", async () => {
    const mod = await worker();
    const group = (0, eval)(mod.pageScript.GROUP_NATIVE_CHOICES_SRC);
    const rows = group([
      { idx: 0, type: "radio", name: "x", formOwner: 0 },
      { idx: 1, type: "radio", name: "x", formOwner: 0 },
      { idx: 2, type: "radio", name: "x", formOwner: 1 },
      { idx: 3, type: "checkbox", name: "x", formOwner: 0 },
      { idx: 4, type: "radio", name: null, formOwner: 0 },
      { idx: 5, type: "radio", name: null, formOwner: 0 },
      { idx: 6, type: "radio", name: "a|b", formOwner: 2 },
      { idx: 7, type: "radio", name: "a", formOwner: 2 },
    ]);
    assertEq(rows.length, 7, JSON.stringify(rows));
    assertEq(rows[0].controlIdxs.join(","), "0,1");
    assertEq(rows.filter((row) => row.identity.name === null).length, 2);
    assertEq(rows.filter((row) => row.identity.type === "checkbox").length, 1);
    assertEq(rows.filter((row) => row.identity.name === "x" && row.identity.type === "radio").length, 2);
  });

  test("a retained choice from a same-name foreign form cannot satisfy the owning group receipt", async () => {
    const mod = await worker();
    const group = { identity: { type: "radio", name: "x", formOwner: 0, unnamedControlIdx: null } };
    const exact = { idx: 1, type: "radio", name: "x", formOwner: 0, unnamedControlIdx: null, checked: true, checkedGroupIdxs: [1] };
    const foreign = { ...exact, formOwner: 1 };
    assertEq(mod.driver.exactChoiceReadback(1, "radio", exact, group), true);
    assertEq(mod.driver.exactChoiceReadback(1, "radio", foreign, group), false);
  });
});

suite("P0 honesty blockers - forward control ambiguity", () => {
  test("two visible enabled forward controls are named and neither is clicked", async () => {
    const mod = await worker();
    const s = screen({ buttons: [button(0, "Continue"), button(1, "Submit")] });
    const { obs, page } = await walk(mod, [s]);
    assertEq(obs.outcome, "navigation-forward-ambiguous");
    assertEq(page.clicks.length, 0, JSON.stringify(page.clicks));
    assertEq(obs.steps[0].blockedReason, "navigation-forward-ambiguous");
    assertEq(obs.readerLimitationCount, 2);
    assertEq(mod.executeBatch.assessExercised(obs, []).exercised, false);
  });

  test("one explicit Next beats Back/unrelated/hidden duplicates, but two explicit Next never use DOM order", async () => {
    const mod = await worker();
    const unique = mod.driver.resolveAdvanceControl(screen({ buttons: [
      button(0, "Back", "back"),
      button(1, "Next", "next"),
      button(2, "Help", "other"),
      button(3, "Next duplicate", "next", { visible: false }),
    ] }));
    assertEq(unique.kind, "unique");
    assertEq(unique.control.idx, 1);
    const ambiguous = mod.driver.resolveAdvanceControl(screen({ buttons: [button(7, "Next"), button(2, "Submit")] }));
    assertEq(ambiguous.kind, "ambiguous");
    assertEq(ambiguous.candidates.length, 2);
  });

  test("forward ambiguity revealed after answers prevents the forward click", async () => {
    const mod = await worker();
    const before = screen({ buttons: [button(0, "Continue")] });
    const afterAction = screen({ buttons: [button(0, "Continue"), button(1, "Submit")] });
    const { obs, page } = await walk(mod, [before, afterAction]);
    assertEq(obs.outcome, "navigation-forward-ambiguous");
    assertEq((obs.steps[0].actions ?? []).filter((row) => row.kind === "click-next").length, 0);
    assertEq(page.clicks.length, 0, JSON.stringify(page.clicks));
  });
});

suite("P0 honesty blockers - durable progress corruption", () => {
  const valid = (runId = "v2r_progress", planRevisionId = "plan_progress") => ({
    kind: "v2-execution-progress/1.0.0",
    runId,
    planRevisionId,
    walks: [],
    floorDone: [],
    explorationDone: [],
    shimRequired: false,
    shimEvidence: null,
    totalSteps: 0,
    totalEvidence: 0,
  });

  test("only a missing object becomes empty; malformed bytes are named and never overwritten", async () => {
    const mod = await worker();
    const env = testEnv();
    const missing = await mod.executeBatch.loadProgress(env, "v2r_missing", "plan_missing");
    assertEq(missing.walks.length, 0);
    const key = mod.executeBatch.execProgressKey("v2r_corrupt");
    await env.EVIDENCE.put(key, "{not json");
    const puts = env.EVIDENCE._log.filter((row) => row.op === "put").length;
    await assertThrows(
      () => mod.executeBatch.loadProgress(env, "v2r_corrupt", "plan_corrupt"),
      "execution-progress-corrupt",
    );
    assertEq(env.EVIDENCE._log.filter((row) => row.op === "put").length, puts, "corrupt bytes were overwritten");
  });

  test("wrong kind/run/plan and row-total contradictions all fail closed", async () => {
    const mod = await worker();
    const base = valid();
    for (const [label, value] of [
      ["kind", { ...base, kind: "other" }],
      ["run", { ...base, runId: "v2r_other" }],
      ["plan", { ...base, planRevisionId: "plan_other" }],
      ["total", {
        ...base,
        walks: [{ pathId: "p", attemptId: "a", tier: 1, caseIds: [], steps: 1, evidenceCount: 2 }],
        totalSteps: 0,
        totalEvidence: 2,
      }],
    ]) {
      await assertThrows(() => mod.executeBatch.decodeProgress(value, base.runId, base.planRevisionId), "execution-progress-corrupt", label);
    }
  });
});
