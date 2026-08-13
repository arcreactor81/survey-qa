/**
 * D22 — THE SAME DEFECT CLASS AS D21, ON THE GROK LEG.
 *
 * ============================ THE DEFECT ============================
 *
 * `EXTRACT_POLICY` gave `extract-pass-a-global` a timeout of 8 minutes (480 s), and the
 * WHOLE window walk lived inside it. Pass A splits a document larger than
 * EXTRACT_PASS_A_WINDOW_CHARS (90 000) into SERIAL windows and issues one call per window,
 * each bounded only by LLM_TIMEOUT_MS (300 s) — so TWO windows is already 600 s against a
 * 480 s step, and a ~360 KB questionnaire is four. Worse, NOTHING was persisted per window:
 * the pass wrote one payload at the very end, so a step timeout killed windows that had
 * already been BILLED and the retry bought every one of them again.
 *
 * IT DOES NOT BITE THE FIXTURE, WHICH IS WHY IT NEEDED CLOSING. The sample questionnaire is
 * ~4 000 characters of source: ONE window, one call, comfortably inside 480 s. The cliff is
 * a property of the CLIENT'S document, not of ours, and "it passes our corpus" is exactly
 * the answer CLAUDE.md's north star forbids.
 *
 * ============================ WHAT IS ASSERTED HERE ============================
 *
 * (a) A walk larger than one step's budget FINISHES ACROSS STEPS, or stops with a NAMED
 *     reason. It never truncates: an unfinished pass persists no pass payload, so the
 *     consolidation that reads that key can never merge a half-read document as if it were
 *     whole — and pass A's entire purpose is the survey-scoped rule that only ONE window may
 *     state, so a partial pass A is the most dangerous partial in the system.
 * (b) A retry never re-issues a window that already landed, and a window that keeps FAILING
 *     is re-bought a bounded number of times across the whole run, not once per wave.
 * (c) Resume is COMPLETE, not merely cheap — including `crossRefs`, pass A's one output with
 *     no pass-B analogue, which a window artifact that dropped them would silently shorten.
 * (d) The step timeout is DERIVED and always covers its own budget plus one whole PURCHASE —
 *     where a purchase is EXTRACT_MAX_ATTEMPTS attempts, because `llm/chat.ts` retries inside
 *     one call and bills for every attempt.
 *
 * Every property here is mutation-proved by `tools/mutate-passa.mjs`, which uses the
 * baseline-aware criterion in `tools/mutate-runner.mjs`.
 */

import { assert, assertEq, assertThrows, fakeStep, loadWorker, memoryR2, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const mod = async () => (await loadWorker()).mod;

// ---------------------------------------------------------------------------
// A synthetic document. Blocks are paragraphs, so with EXTRACT_PASS_A_WINDOW_CHARS=10 the
// splitter produces exactly one window per block and the arithmetic below is exact rather
// than approximate.
// ---------------------------------------------------------------------------

function docFor(n) {
  const blocks = Array.from({ length: n }, (_, i) => ({
    blockId: `b${String(i + 1).padStart(4, "0")}`,
    kind: "paragraph",
    text: `Q${i + 1}. Ask the respondent question ${i + 1}. Every question is compulsory.`,
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
  }));
  return {
    blocks,
    annotatedText: blocks.map((b) => `[${b.blockId}] ${b.text}`).join("\n"),
    counts: { paragraphs: n, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
    coverage: {
      archiveParts: 1,
      partsRead: ["word/document.xml"],
      partsSkipped: [],
      images: 0,
      imagesWithAltText: 0,
      unresolvedFieldCodes: 0,
      symbolRuns: 0,
      autoNumberedParagraphs: 0,
      problems: [],
    },
  };
}

/**
 * Stand in for the provider at the TRANSPORT boundary — `globalThis.fetch` — so everything
 * between the stage and the wire (llm/chat.ts's attempt loop, truncation handling, usage
 * accounting, the coercion layer) is the real code.
 *
 * WINDOW IDENTITY COMES FROM THE PROMPT. `userMessageA` writes "window 2 of 5 (…)" into the
 * windowed variant and says "the ENTIRE document" when there is only one — there is no chunk
 * id to key on the way pass B has. Without this the bounded-re-buy property could not be
 * measured at all, because every window would look like the same call.
 */
function stubProvider({ failUnit = () => false, emitRules = true, emitCrossRefs = true } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const windowed = user.match(/window (\d+) of (\d+)/);
    const unit = windowed ? `A-w${windowed[1]}` : "A";
    const blockIds = [...new Set([...user.matchAll(/\[(b\d{4})\]/g)].map((m) => m[1]))];
    requests.push({ url: String(url), unit, blockIds, model: body.model });

    if (failUnit(unit, requests.length)) {
      return new Response("upstream exploded", { status: 502 });
    }

    // ONE CROSS-CUTTING RULE PER WINDOW, citing that window's blocks. Pass A reads
    // `global_rules`, and a stub that returned none would trip the stage's empty-pass refusal
    // instead of exercising the property under test.
    const globalRules =
      emitRules && blockIds.length > 0
        ? [
            {
              id: `${unit}-G1`,
              construct: "instruction",
              scope: "survey",
              quantifier: "every",
              selector: null,
              exceptions: [],
              statement: `every question in ${unit} is compulsory`,
              doc_quote: "Every question is compulsory.",
              block_ids: blockIds,
              browser_observable: "full",
              confidence: 0.9,
            },
          ]
        : [];

    const crossReferences =
      emitCrossRefs && blockIds.length > 0
        ? [
            {
              id: `XREF-${unit}`,
              from_block: blockIds[0],
              target: "the screening section",
              resolved_to_block: null,
              statement: `${unit} refers to the screening section`,
            },
          ]
        : [];

    return new Response(
      JSON.stringify({
        model: body.model,
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                global_rules: globalRules,
                cross_references: crossReferences,
                ambiguities: [],
                unverifiable_from_browser: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    requests,
    unitsCalled: () => requests.map((r) => r.unit),
    countFor: (unit) => requests.filter((r) => r.unit === unit).length,
    reset: () => {
      requests.length = 0;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** One window per block, one purchase per call: exact arithmetic, no provider retries. */
function sliceEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    // Gateway config is part of the production posture: llm/chat.ts refuses a direct,
    // unmetered provider call without it. Tests stub globalThis.fetch, so they exercise
    // the same gateway URL production builds.
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GROK_MODEL: "grok-4.6",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-dashboard-copy",
    GROK_RATE_ATTESTED_MODEL: "grok-4.6",
    GROK_RATE_ATTESTED_AT: "2026-08-13",
    GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_MAX_ATTEMPTS: "1",
    ...overrides,
  };
}

/** Drive slices until the pass reports done, or give up loudly rather than hang. */
async function driveToDone(m, env, runId, doc, budgetMs, cap = 40) {
  const waves = [];
  for (let i = 0; i < cap; i++) {
    const out = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, { budgetMs });
    waves.push(out);
    if (out.slice.done) return { waves, last: out };
  }
  throw new Error(`pass A never reported done after ${cap} wave(s) — the wave loop does not terminate`);
}

// ===========================================================================
suite("D22 — a window walk bigger than one step's budget is spread across steps", () => {

test("(a) six windows that cannot fit one wave are finished ACROSS waves, and nothing is dropped", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(6);
    const { waves, last } = await driveToDone(m, env, "run_d22_across", doc, 0);

    // THE STRUCTURAL CLAIM: one wave could not do it, several waves could.
    assert(waves.length > 1, `the walk must need more than one wave at a zero budget, took ${waves.length}`);
    assertEq(last.slice.done, true, "the last wave reports the pass finished");
    assertEq(last.slice.windowsRemaining, 0, "no window is left owing a call");
    assertEq(last.slice.windowsLanded, 6, "every window landed");
    assertEq(last.slice.windowsTotal, 6, "and the total is the document's, not the wave's");

    // AND IT DID NOT SILENTLY TRUNCATE: every block of the document is covered by exactly one
    // window, bought exactly once, and every one of them is cited.
    assertEq(provider.requests.length, 6, `one purchase per window, got ${provider.unitsCalled().join(",")}`);
    assertEq(new Set(provider.unitsCalled()).size, 6, "six DISTINCT windows were bought");
    const cited = new Set(last.requirements.flatMap((r) => r.blockIds));
    assertEq(cited.size, 6, "every source block is cited by a cross-cutting rule");
    assertEq(last.crossRefs.length, 6, "every window's cross-references reached the result");
  } finally {
    provider.restore();
  }
});

test("a pass-A wave with NO budget at all still issues one call — the wave loop can never stall", async () => {
  // The exemption that makes the wave count a bound on the DOCUMENT rather than on luck.
  // Without it a slice whose deadline has already passed issues NOTHING, reports `done:
  // false`, and the workflow burns every step it owns without moving a single window.
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const first = await m.passA.runPassA(env, "run_d22_progress", docFor(3), "synthetic.docx", undefined, {
      budgetMs: 0,
    });
    assert(first.slice.windowsIssued >= 1, `a wave must always buy at least one window, bought ${first.slice.windowsIssued}`);
    assertEq(first.slice.done, false, "three windows cannot be done after a single-call wave");
    assert(first.slice.windowsRemaining > 0, "the wave must report the work it deferred");
    assertEq(provider.requests.length, first.slice.windowsIssued, "issued count matches the calls actually made");
  } finally {
    provider.restore();
  }
});

test("a generous budget still does the whole walk in ONE wave — slicing is not serialization", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const out = await m.passA.runPassA(env, "run_d22_onewave", docFor(6), "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });
    assertEq(out.slice.done, true, "a wave with real budget finishes the document");
    assertEq(out.slice.windowsIssued, 6, "all six windows bought inside one wave");
    assertEq(out.slice.deadlineHit, false, "and it never hit its deadline");
  } finally {
    provider.restore();
  }
});

test("a document that fits ONE window is still one call — the fixture's shape is unchanged", async () => {
  // The regression guard for the small case. Slicing must not turn the common
  // single-window read into anything other than exactly one purchase with no window label.
  const m = await mod();
  const env = sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "90000" });
  const provider = stubProvider();
  try {
    const out = await m.passA.runPassA(env, "run_d22_single", docFor(6), "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });
    assertEq(out.slice.windowsTotal, 1, "six small blocks are one window at the production setting");
    assertEq(provider.requests.length, 1, "one window is one call");
    assertEq(provider.unitsCalled()[0], "A", "and it is told it is reading the ENTIRE document");
    assertEq(out.slice.done, true, "and the pass is done in a single wave");
  } finally {
    provider.restore();
  }
});

test("dense pass-A windows stop at the exact block limit while the character limit stays independent", async () => {
  const m = await mod();
  const { readFileSync } = await import("node:fs");
  const releaseConfig = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert(
    releaseConfig.includes('"EXTRACT_PASS_A_WINDOW_MAX_BLOCKS": "250"'),
    "the reviewed production config must declare the same 250-block ceiling the runtime defaults to",
  );
  const cases = [
    {
      label: "exactly the default 250-block boundary",
      env: sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" }),
      document: docFor(250),
      expectedBlockCounts: [250],
    },
    {
      label: "one block beyond the default boundary",
      env: sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" }),
      document: docFor(251),
      expectedBlockCounts: [250, 1],
    },
    {
      label: "the character bound fires below the block bound",
      env: sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "10", EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "250" }),
      document: docFor(2),
      expectedBlockCounts: [1, 1],
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const provider = stubProvider();
    try {
      const result = await m.passA.runPassA(
        fixture.env,
        "run_d22_dense_boundary_" + index,
        fixture.document,
        "synthetic.docx",
      );
      const actualBlockCounts = provider.requests.map((request) => request.blockIds.length);
      assertEq(actualBlockCounts.join(","), fixture.expectedBlockCounts.join(","), fixture.label);
      assertEq(result.slice.windowsTotal, fixture.expectedBlockCounts.length, fixture.label + ": window count");
      assertEq(
        provider.requests.flatMap((request) => request.blockIds).join(","),
        fixture.document.blocks.map((block) => block.blockId).join(","),
        fixture.label + ": every block remains present exactly once and in document order",
      );
    } finally {
      provider.restore();
    }
  }
});

});

// ===========================================================================
suite("D22 — a retry never re-buys a window that already landed", () => {

test("(b) a second wave over a finished pass-A buys NOTHING", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(4);
    const runId = "run_d22_resume";
    const { last: first } = await driveToDone(m, env, runId, doc, 0);
    assertEq(provider.requests.length, 4, "the first pass bought four windows");

    provider.reset();
    const again = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });

    // THE ASSERTION THIS TEST EXISTS FOR.
    assertEq(provider.requests.length, 0, `a re-entered pass must buy nothing, bought ${provider.unitsCalled().join(",")}`);
    assertEq(again.slice.windowsIssued, 0, "the slice reports zero windows issued");
    assertEq(again.slice.done, true, "and it is done immediately");
    assertEq(again.issuedCalls.length, 0, "nothing is charged to the run's ledger");

    // RESUME IS NOT JUST 'CHEAP', IT IS COMPLETE.
    assertEq(again.requirements.length, first.requirements.length, "reclaimed rules are all there");
    assertEq(again.calls.length, 4, "the telemetry rows survive for the payload");
    assert(
      again.calls.every((c) => c.costUsd === 0),
      "a reclaimed window costs nothing — charging it again would describe a run that never happened",
    );
  } finally {
    provider.restore();
  }
});

test("(b) a HALF-finished pass-A re-issues only the windows that never landed", async () => {
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(5);
    const runId = "run_d22_partial";
    const first = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 0 });
    const boughtFirst = new Set(provider.unitsCalled());
    assertEq(first.slice.done, false, "one call cannot finish five windows");

    provider.reset();
    const rest = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });
    const boughtAgain = provider.unitsCalled();

    assertEq(rest.slice.done, true, "the second wave finishes the rest");
    for (const unit of boughtAgain) {
      assert(!boughtFirst.has(unit), `window ${unit} landed in wave 0 and must never be bought again`);
    }
    assertEq(boughtAgain.length, 5 - boughtFirst.size, "exactly the windows that had not landed were bought");
  } finally {
    provider.restore();
  }
});

test("changing the block limit refuses persisted windows whose exact block sets changed", async () => {
  const m = await mod();
  const shared = memoryR2();
  const runId = "run_d22_block_policy_repartition";
  const document = docFor(5);
  const firstEnv = sliceEnv({
    EVIDENCE: shared,
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const provider = stubProvider();
  try {
    const first = await m.passA.runPassA(firstEnv, runId, document, "synthetic.docx");
    assertEq(first.slice.windowsTotal, 3, "the first policy creates 2,2,1 block windows");
    assertEq(provider.requests.map((request) => request.blockIds.length).join(","), "2,2,1");

    provider.reset();
    const repartitioned = await m.passA.runPassA(
      { ...firstEnv, EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "3" },
      runId,
      document,
      "synthetic.docx",
    );
    assertEq(repartitioned.slice.windowsTotal, 2, "the changed policy creates 3,2 block windows");
    assertEq(
      provider.requests.map((request) => request.blockIds.length).join(","),
      "3,2",
      "neither differently-owned artifact is adopted under the new partition",
    );
  } finally {
    provider.restore();
  }
});

test("the pass-A block window policy changes cross-run contract reuse identity", async () => {
  const m = await mod();
  const at250 = await m.contractReuse.extractionPolicyFingerprint(
    sliceEnv({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "250" }),
  );
  const at251 = await m.contractReuse.extractionPolicyFingerprint(
    sliceEnv({ EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "251" }),
  );
  assert(at250 !== at251, "a changed block partition must miss cross-run reuse, never adopt an old denominator");
  assert(
    m.contractReuse.EXTRACTION_POLICY_KEYS.includes("EXTRACT_PASS_A_WINDOW_MAX_BLOCKS"),
    "the new output-affecting knob must remain in the explicit reuse-policy census",
  );
});

test("(c) CROSS-REFERENCES survive a resume — pass A's one output with no pass-B analogue", async () => {
  // A window artifact that persisted rules but dropped cross-references would let a resumed
  // run publish a SHORTER diff than the run that paid for it, with nothing anywhere saying so.
  // That is the silent-shortening class the source ledger exists to make impossible, and it
  // is reachable ONLY through pass A, because pass B has no such field.
  const m = await mod();
  const env = sliceEnv();
  const provider = stubProvider();
  try {
    const doc = docFor(4);
    const runId = "run_d22_xrefs";
    const { last: whole } = await driveToDone(m, env, runId, doc, 0);
    assertEq(whole.crossRefs.length, 4, "the paid-for walk found one cross-reference per window");

    provider.reset();
    const reclaimed = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, { budgetMs: 600_000 });
    assertEq(provider.requests.length, 0, "the resumed pass bought nothing");
    assertEq(
      reclaimed.crossRefs.length,
      whole.crossRefs.length,
      "a resumed pass carries EVERY cross-reference the paid-for one did",
    );
    assertEq(
      reclaimed.crossRefs.map((x) => x.id).join(","),
      whole.crossRefs.map((x) => x.id).join(","),
      "the same cross-references, in the same document order",
    );
    assert(
      reclaimed.crossRefs.every((x) => x.statement.length > 0),
      "and they carry their statements, not empty husks",
    );
  } finally {
    provider.restore();
  }
});

test("a pass-A window that keeps FAILING is re-bought a bounded number of times, not once per wave", async () => {
  // The pass-B gateway trace showed a single chunk id billed 21–24 times during a recovery
  // storm. A pass-A window is a 90 KB purchase, so the same unbounded re-issue costs more per
  // repeat. The attempt count lives in the window's own artifact, so waves, step retries and
  // recovery instances share ONE budget instead of each starting a fresh one.
  const m = await mod();
  const env = sliceEnv({ EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2" });
  const doomed = "A-w2";
  const provider = stubProvider({ failUnit: (unit) => unit === doomed });
  try {
    const doc = docFor(3);
    const { last } = await driveToDone(m, env, "run_d22_bounded", doc, 0);

    assertEq(
      provider.countFor(doomed),
      3,
      `the failing window may buy Grok once and bounded Flash twice, was bought ${provider.countFor(doomed)}`,
    );
    const doomedRequests = provider.requests.filter((request) => request.unit === doomed);
    assertEq(doomedRequests.filter((request) => request.model === "grok-4.6").length, 1,
      "a retained trigger prevents Grok from being re-bought across waves");
    assertEq(doomedRequests.filter((request) => request.model === "deepseek-v4-flash").length, 2,
      "only the bounded substitute retry budget is spent after Grok authorizes fallback");
    assertEq(last.slice.done, true, "the pass still terminates rather than looping on a window nobody can answer");
    assert(
      last.failedUnits.some((f) => f.unit === doomed),
      "the failure is NAMED as a failed unit, never reported as a window that found nothing",
    );
    assert(
      last.failedUnits.find((f) => f.unit === doomed).blockIds.includes("b0002"),
      "and it names the blocks nobody read",
    );
    // The windows around it are unaffected: a bounded failure is not a poisoned pass.
    assertEq(provider.countFor("A-w1"), 1, "a healthy window is still bought exactly once");
    assertEq(provider.countFor("A-w3"), 1, "including the one after the failure");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("D22 — the pass-A step timeout is DERIVED so the axe cannot fall on a paid-for call", () => {

test("the pass-A step timeout always exceeds its own wave budget by at least one whole PURCHASE", async () => {
  // THE INVARIANT. A wave stops ISSUING at its budget but never abandons a call already in
  // flight, so the step around it must be allowed to live for the budget PLUS a whole
  // purchase. Anything less and the step axe kills work that was already billed and not yet
  // persisted — the duplicate spend this design removes.
  //
  // A PURCHASE IS NOT AN ATTEMPT. `llm/chat.ts` loops up to EXTRACT_MAX_ATTEMPTS times inside
  // ONE `grokJson` call, gives every attempt its own `AbortSignal.timeout(LLM_TIMEOUT_MS)`,
  // and accrues token usage across all of them — so at the default of 2 a single billed call
  // can occupy 600 s, and a step timeout that budgeted 300 s for it would still be killing
  // work that was paid for.
  const m = await mod();
  const cases = [
    {},
    { EXTRACT_PASS_A_WAVE_BUDGET_MS: "0" },
    { EXTRACT_PASS_A_WAVE_BUDGET_MS: "60000", LLM_TIMEOUT_MS: "300000" },
    { EXTRACT_PASS_A_WAVE_BUDGET_MS: "1800000", LLM_TIMEOUT_MS: "600000", EXTRACT_MAX_ATTEMPTS: "3" },
    {
      EXTRACT_PASS_A_WAVE_BUDGET_MS: "not-a-number",
      LLM_TIMEOUT_MS: "not-a-number",
      EXTRACT_MAX_ATTEMPTS: "not-a-number",
    },
    { EXTRACT_PASS_A_WAVE_BUDGET_MS: "-5000", EXTRACT_MAX_ATTEMPTS: "-1" },
    { EXTRACT_MAX_ATTEMPTS: "0" },
    { LLM_TIMEOUT_MS: "0" },
  ];
  for (const env of cases) {
    const budget = m.passA.passAWaveBudgetMs(env);
    const ceiling = m.passA.passACallCeilingMs(env);
    const timeout = m.passA.passAStepTimeoutMs(env);
    // Each eligible logical unit may occupy the bounded Grok purchase and then the bounded
    // Flash substitute purchase, so the step must cover both before either receipt can be lost.
    const attempts = Math.max(1, m.env.num(env.EXTRACT_MAX_ATTEMPTS, 2));
    const attemptMs = Math.max(0, m.env.num(env.LLM_TIMEOUT_MS, 300_000));

    assert(budget >= 0, `the wave budget must never be negative for ${JSON.stringify(env)}, got ${budget}`);
    assertEq(
      ceiling,
      2 * attempts * attemptMs,
      `the purchase ceiling must cover bounded Grok plus Flash attempts for ${JSON.stringify(env)}`,
    );
    assert(
      ceiling >= attemptMs,
      `the purchase ceiling ${ceiling} must cover at least one whole attempt ${attemptMs} for ${JSON.stringify(env)}`,
    );
    assert(
      timeout >= budget + ceiling,
      `step timeout ${timeout} must cover budget ${budget} + one purchase ${ceiling} for ${JSON.stringify(env)}`,
    );
    assert(timeout > budget, `step timeout ${timeout} must strictly exceed the budget ${budget}`);
  }

  // And the DEFAULT posture must clear the 480 s ceiling that the single-step shape imposed,
  // with a whole purchase of room to spare.
  assert(
    m.passA.passAStepTimeoutMs({}) > 480_000 + m.passA.passACallCeilingMs({}),
    `the default step timeout (${m.passA.passAStepTimeoutMs({})} ms) must be well clear of the 480 s ceiling`,
  );
});

});

// ===========================================================================
suite("D22 — an unfinished pass A persists NOTHING, so consolidation cannot merge half a read", () => {

async function stageBed(overrides = {}) {
  const m = await mod();
  const env = sliceEnv(overrides);
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  return { m, env, runId, fence };
}

async function seedSampleDocument(m, env, runId) {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("../testkit.mjs");
  const bytes = readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx"));
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, bytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  return documentKey;
}

test("(a) the STAGE refuses to evaluate an unfinished pass A, and evaluates the finished one", async () => {
  // EXTRACT_PASS_A_WINDOW_CHARS is dropped to 1 000 so the SAMPLE document becomes five
  // windows. At the production 90 000 it is one window — which is precisely why this defect
  // was invisible until someone looked, and why the fixture is used here with the knob turned
  // rather than replaced with a bigger fixture nobody has.
  const { m, env, runId, fence } = await stageBed({ EXTRACT_PASS_A_WINDOW_CHARS: "1000" });
  const provider = stubProvider();
  try {
    const documentKey = await seedSampleDocument(m, env, runId);
    const beat = async () => {};
    const first = await m.extractStage.stagePassASlice(env, runId, documentKey, "questionnaire.docx", fence, beat, {
      budgetMs: 0,
    });

    // THE SILENT-TRUNCATION GUARD. `stageConsolidate` reads the pass key and merges whatever
    // it finds, with no way to tell a whole read from a partial one.
    assertEq(first.slice.done, false, "a zero-budget wave over a five-window document cannot finish it");
    assertEq(first.result.state, "not-evaluated", "an unfinished pass is NOT an evaluated pass");
    assertEq(first.result.reason, "PASS_A_INCOMPLETE", "and it says which incompleteness");
    assertEq(
      await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "a")),
      null,
      "NOTHING is persisted under the pass key while the window walk is incomplete",
    );

    // Now finish it, and the same seam evaluates and persists exactly once.
    let waves = 1;
    let out = first;
    while (!out.slice.done && waves < 60) {
      out = await m.extractStage.stagePassASlice(env, runId, documentKey, "questionnaire.docx", fence, beat, {
        budgetMs: 0,
      });
      waves += 1;
    }
    assertEq(out.slice.done, true, `the pass finished across ${waves} wave(s)`);
    assert(waves > 1, "and it genuinely needed more than one");
    assertEq(out.result.state, "evaluated", "a finished pass IS evaluated");
    assert(
      (await env.EVIDENCE.get(m.keys.extractionPassKey(runId, "a"))) !== null,
      "and only now is the pass payload persisted",
    );

    // THE LEDGER COUNTS PURCHASES, NOT ROWS. Reclaimed windows carry telemetry into the
    // payload with cost zeroed; charging those once per wave would walk a large document into
    // CAP_MODEL_CALLS on calls nobody ever made.
    const cp = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(
      cp.usage.modelCalls.used,
      provider.requests.length,
      `the run is charged for the ${provider.requests.length} call(s) it bought, not for every reclaim`,
    );
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("D22 — the workflow makes as many pass-A wave steps as the document needs, then names the stop", () => {

async function workflowBed(m, env) {
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("../testkit.mjs");
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx")));
  await m.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-07T00:00:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey",
      documentKey,
      documentSha256: "c".repeat(64),
      documentName: "questionnaire.docx",
      targetBuildId: null,
      locale: "en",
      viewports: ["desktop"],
    },
    profile: "standard",
    contractRevisionId: null,
    recovery: null,
    finalCompletion: null,
  });
  return { runId, documentKey };
}

test("(a) pass A occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure", async () => {
  // The end-to-end shape. With a zero wave budget every wave buys one window, so a five-window
  // document needs more waves than the cap allows — which is the case that used to die as a
  // bare step timeout with a generic `workflow-error`.
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "1000",
    EXTRACT_PASS_A_WAVE_BUDGET_MS: "0",
    EXTRACT_PASS_A_MAX_WAVES: "3",
  });
  const provider = stubProvider();
  try {
    const { runId, documentKey } = await workflowBed(m, env);
    const step = fakeStep();
    const wf = new m.workflow.SurveyRunWorkflowV2({}, env);
    await wf.run(
      {
        payload: {
          runId,
          surveyUrl: "https://fixture.invalid/survey",
          documentKey,
          documentSha256: "c".repeat(64),
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      },
      step,
    );

    // ONE STEP PER WAVE, AND THE NAMES PROVE IT. The old code had exactly one
    // `extract-pass-a-global` step whose single timeout had to cover the whole window walk.
    const waveSteps = step.calls.filter((n) => n.startsWith("extract-pass-a-wave-"));
    assertEq(waveSteps.length, 3, `pass A must occupy one step per wave, got ${JSON.stringify(step.calls)}`);
    assertEq(new Set(waveSteps).size, 3, "each wave is its OWN checkpointed step, not a retry of one step");
    assert(
      step.calls.includes("stop-extract-pass-a-waves-exhausted"),
      "the exhaustion checkpoint mutation must itself be a durable Workflow step",
    );
    assert(
      !step.calls.includes("extract-pass-a-global"),
      "the single all-or-nothing extraction step is gone, not merely renamed alongside",
    );
    // AND THE RUN STOPS THERE. Pass B must not be entered over a half-read document.
    assertEq(
      step.calls.filter((n) => n.startsWith("extract-pass-b-wave-")).length,
      0,
      "the block pass never runs over a document pass A has not finished reading",
    );

    const cp = (await m.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    // A NAMED BUDGET REASON — never a `partial-*` over a document that was never read.
    assertEq(cp.completion.reasonCode, "extraction-pass-a-waves-exhausted", "the stop names itself");
    assertEq(cp.completion.test, "failed", "nothing was tested, so this is a failure");
    assert(
      !String(cp.completion.test).startsWith("partial"),
      "a half-read document must never be reported as a partial TEST — nothing was exercised",
    );
    assertEq(cp.contract.state, "unavailable", "and no contract was sealed over half a read");
    assert(
      /window\(s\)/.test(String(cp.error)) && /EXTRACT_PASS_A_MAX_WAVES/.test(String(cp.error)),
      `the error must say how much work is owed and which knob governs it, got: ${cp.error}`,
    );
    // AND IT STILL REPORTS: a named stop is a reportable outcome, not a 404.
    const reporting = cp.phases.find((p) => p.name === "reporting");
    assert(reporting && reporting.state !== "not-started", "a named stop still falls through to reporting");
  } finally {
    provider.restore();
  }
});

test("a replacement instance re-runs NO pass-A wave step — resume is by contract, not by re-extraction", async () => {
  // D13 asserts this property too. It used to assert it against `extract-pass-a-global` — a
  // step name the wave work renamed — so it passed no matter what the workflow did; it has
  // since been re-anchored to the live `extract-pass-a-wave-` naming (d13-recovery.test.mjs)
  // and can go red again. This is the wave-suite-side guard of the same property, kept
  // alongside the rest of the slicing evidence rather than only in the recovery suite.
  const m = await worker();
  const env = testEnv();
  const seeded = await seedRun(m, env, { testCompletion: "running" });
  await m.checkpoint.claimOwnership(env, seeded.runId, seeded.runId, 0);

  const step = fakeStep();
  const wf = new m.workflow.SurveyRunWorkflowV2({}, env);
  await wf.run(
    {
      payload: {
        runId: seeded.runId,
        surveyUrl: "https://fixture.invalid/s",
        documentKey: "k",
        documentSha256: "a".repeat(64),
        profile: "standard",
        locale: "en",
        viewports: ["desktop"],
        recoveryAttempt: 1,
      },
    },
    step,
  );

  assert(step.calls.includes("resume-sealed-contract"), `steps: ${step.calls.join(", ")}`);
  assertEq(
    step.calls.filter((n) => n.startsWith("extract-pass-a-wave-")).length,
    0,
    `a replacement must never re-run the whole-document pass, steps: ${step.calls.join(", ")}`,
  );
});

test("an UNCAUGHT step failure still produces a report — the failure path used to produce none", async () => {
  // Commitment 5 says a partial run is a reportable outcome, and every deliberate stop honours
  // it. The uncaught path did not: `record-failure` rethrew and `reportAndFinalize` was never
  // reached, so the one ending a reader most needs explained produced nothing to read and
  // `GET .../report` 404'd.
  const m = await worker();
  const env = testEnv();
  const seeded = await seedRun(m, env, { testCompletion: "running" });

  const step = fakeStep({ throwOn: { "resume-durable-state": new Error("simulated step failure") } });
  const wf = new m.workflow.SurveyRunWorkflowV2({}, env);
  await assertThrows(
    () =>
      wf.run(
        {
          payload: {
            runId: seeded.runId,
            surveyUrl: "https://fixture.invalid/s",
            documentKey: "k",
            documentSha256: "a".repeat(64),
            profile: "standard",
            locale: "en",
            viewports: ["desktop"],
          },
        },
        step,
      ),
    "simulated step failure",
    "the ORIGINAL error must still propagate — reporting explains a failure, it does not swallow one",
  );

  assert(step.calls.includes("record-failure"), `the failure is recorded: ${step.calls.join(", ")}`);
  assert(step.calls.includes("report"), `and reporting is REACHED: ${step.calls.join(", ")}`);
  assert(step.calls.includes("finalize"), `and the run is finalized: ${step.calls.join(", ")}`);

  const cp = (await m.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
  const reporting = cp.phases.find((p) => p.name === "reporting");
  assert(reporting && reporting.state !== "not-started", "the reporting phase was actually entered");
  assertEq(cp.completion.test, "failed", "the run is failed");
  assertEq(cp.completion.reasonCode, "workflow-error", "and it keeps the uncaught-failure reason code");
});

});

// ===========================================================================
// D51 — parser/prompt-versioned resume artifacts. Kept here so the existing D22
// registration exercises it without adding another test-loader seam.
// ===========================================================================

suite("D51 — pass A artifact versions", () => {

const d51WindowKey = (m, runId) =>
  m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");

async function d51Put(env, key, value) {
  await env.EVIDENCE.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

async function d51Read(env, key) {
  const obj = await env.EVIDENCE.get(key);
  assert(obj !== null, `expected D51 artifact at ${key}`);
  return JSON.parse(await obj.text());
}

function d51AssertVersions(m, value, promptVersion, label) {
  assertEq(value.parserVersion, m.docxBlocks.DOCX_BLOCKS_VERSION, `${label} parser version`);
  assertEq(value.promptVersion, promptVersion, `${label} prompt version`);
}

test("D51-a pass A rejects stale window success and terminal failure artifacts", async () => {
  const m = await mod();
  const document = docFor(1);

  // A stale SUCCESS must be bought again, not accepted because its old answer happens to
  // have the current JSON shape.
  {
    const env = sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "999999", EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2" });
    const runId = "run_d51_a_success";
    await d51Put(env, d51WindowKey(m, runId), {
      windowId: "A",
      windowNumber: 1,
      blockIds: ["b0001"],
      parserVersion: "stale-parser/0",
      promptVersion: m.passA.PASS_A_VERSION,
      providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
      globalRules: [{ id: "A-STALE" }],
      crossRefs: [],
      ambiguities: [],
      unverifiable: [],
      usages: [],
      routeReceipt: { selected: "grok-4.6", trigger: null },
    });
    const provider = stubProvider();
    try {
      const result = await m.passA.runPassA(env, runId, document, "synthetic.docx");
      assertEq(provider.requests.length, 1, "stale pass-A success is re-issued");
      assert(result.requirements.some((row) => row.id === "A-G1"), "the current prompt's result replaces stale output");
      d51AssertVersions(m, await d51Read(env, d51WindowKey(m, runId)), m.passA.PASS_A_VERSION, "fresh window success");
    } finally {
      provider.restore();
    }
  }

  // A terminal failure belongs to the parser+prompt pair that produced it. A new prompt
  // starts at attempt one; inheriting 99 would suppress the first current-version call.
  {
    const env = sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "999999", EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2" });
    const runId = "run_d51_a_failure";
    await d51Put(env, d51WindowKey(m, runId), {
      windowId: "A",
      windowNumber: 1,
      blockIds: ["b0001"],
      parserVersion: m.docxBlocks.DOCX_BLOCKS_VERSION,
      promptVersion: "stale-prompt/0",
      providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
      status: "failed",
      attempts: 99,
      usages: [],
      fallbackTrigger: null,
      detail: "the old prompt exhausted its budget",
    });
    const provider = stubProvider({ failUnit: () => true });
    try {
      await m.passA.runPassA(env, runId, document, "synthetic.docx");
      const fresh = await d51Read(env, d51WindowKey(m, runId));
      // The normal topology buys Grok 4.6 first. Its eligible 502 then authorizes exactly
      // one Flash fallback; the stale terminal artifact must not suppress either current
      // route leg or leak its old 99-attempt ceiling into this prompt version.
      assertEq(provider.requests.length, 2, "stale terminal failure cannot suppress the current Grok then Flash route");
      assertEq(
        provider.requests.map((request) => request.model).join(","),
        "grok-4.6,deepseek-v4-flash",
        "the reissued current route is exact Grok 4.6 followed by the eligible Flash fallback",
      );
      assertEq(fresh.attempts, 1, "the current pass-A version restarts attempts at one");
      d51AssertVersions(m, fresh, m.passA.PASS_A_VERSION, "fresh window failure");
    } finally {
      provider.restore();
    }
  }
});

test("D51-d whole-pass A stale payload cannot take early reuse", async () => {
  const m = await mod();
  const env = sliceEnv({ EXTRACT_PASS_A_WINDOW_CHARS: "999999" });
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);

  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("../testkit.mjs");
  const documentKey = m.keys.inputDocumentKey(runId);
  await env.EVIDENCE.put(documentKey, readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx")));
  await d51Put(env, m.keys.extractionPassKey(runId, "a"), {
    // Discriminating fixture: every provider-route dimension is current and internally
    // coherent, so only the stale parser can make this payload ineligible. Provider-route
    // mismatches retain their own counterweights in provider-continuity.test.mjs.
    parserVersion: "stale-parser/0",
    promptVersion: m.passA.PASS_A_VERSION,
    providerRouteIdentity: m.grok.grokFlashRouteIdentity(env),
    providerIndependence: "independent",
    pass: "A",
    provider: "grok",
    model: "grok-4.6",
    requirements: [],
    ambiguities: [],
    unverifiable: [],
    dispositions: [],
    constructs: [],
    failedUnits: [],
    calls: [],
    crossRefs: [],
    fallbackTriggers: [],
    routeReceipts: [],
  });

  const provider = stubProvider();
  try {
    const outcome = await m.extractStage.stagePassASlice(
      env,
      runId,
      documentKey,
      "questionnaire.docx",
      fence,
      async () => {},
      {},
    );
    assertEq(outcome.result.state, "evaluated", "the current whole pass completes");
    assert(provider.requests.length > 0, "the stale whole-pass payload does not suppress current model work");
    d51AssertVersions(
      m,
      await d51Read(env, m.keys.extractionPassKey(runId, "a")),
      m.passA.PASS_A_VERSION,
      "fresh whole pass A",
    );
  } finally {
    provider.restore();
  }
});

});
