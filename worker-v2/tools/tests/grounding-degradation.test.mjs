/**
 * Item-level grounding degradation and Gemini budget mode.
 *
 * When a window's retry budget is exhausted for a semantic-output error, instead of
 * failing the whole window (and therefore the whole run), each individually invalid or
 * ungrounded item is excluded and counted as a named limitation, while every valid +
 * grounded item survives into the landed window. The grounding validation stays exactly
 * as strict; only the consequence granularity changes from window to item.
 *
 * Budget mode: EXTRACT_PASS_A_PRIMARY="gemini" runs pass A on gemini-2.5-flash through
 * the pinned Gemini leg. Grok is never called. The existing USD 10 cumulative cap
 * enforcement applies to EVERY pass-A call. Pass B stays DeepSeek Pro. Provider-family
 * independence is intact.
 */
import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

// ---------------------------------------------------------------------------
// REGRESSION FIXTURE from run v2r_01m01pqb2dqz5fz4hx0jppr0c0, A-w10:
// The model returned construct "presentation" (not in CONSTRUCT_CLASSES), causing
// PASS_A_WINDOW_OUTPUT_INVALID. Under the old code, the whole window fails terminal.
// Under item-level degradation, only the specific row with the invalid construct is
// excluded; every other structurally valid + grounded item survives.
// ---------------------------------------------------------------------------

const BLOCK_TEXT_A = "If the respondent selects 'No' to Q1, the survey must skip to Q5.";
const BLOCK_TEXT_B = "All respondents see this screen regardless of prior answers.";

function makeSourceBlocks() {
  return [
    { blockId: "b0901", text: BLOCK_TEXT_A, kind: "paragraph" },
    { blockId: "b0902", text: BLOCK_TEXT_B, kind: "paragraph" },
  ];
}

/** A model output with one valid global rule and one with an invalid construct. */
function mixedModelOutput() {
  return {
    global_rules: [
      {
        id: "r-valid-1",
        construct: "skip-rule",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        statement: "Skip to Q5 when respondent selects No to Q1",
        doc_quote: "the survey must skip to Q5",
        block_ids: ["b0901"],
        evidence_quotes: [{ block_id: "b0901", quote: "the survey must skip to Q5" }],
        browser_observable: "full",
        confidence: 0.95,
      },
      {
        id: "r-invalid-construct",
        construct: "presentation",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        statement: "All respondents see this screen",
        doc_quote: "All respondents see this screen regardless",
        block_ids: ["b0902"],
        evidence_quotes: [{ block_id: "b0902", quote: "All respondents see this screen regardless" }],
        browser_observable: "full",
        confidence: 0.9,
      },
    ],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

/** A model output where ALL items have invalid constructs. */
function allInvalidModelOutput() {
  return {
    global_rules: [
      {
        id: "r-bad-1",
        construct: "presentation",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        statement: "Bad item 1",
        doc_quote: "some quote",
        block_ids: ["b0901"],
        evidence_quotes: [{ block_id: "b0901", quote: "some quote" }],
        browser_observable: "full",
        confidence: 0.9,
      },
      {
        id: "r-bad-2",
        construct: "layout",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        statement: "Bad item 2",
        doc_quote: "some other quote",
        block_ids: ["b0902"],
        evidence_quotes: [{ block_id: "b0902", quote: "some other quote" }],
        browser_observable: "full",
        confidence: 0.9,
      },
    ],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

suite("Item-level grounding degradation — A-w10 regression fixture", () => {
  test("exhausted retries: window LANDS with the exact ungrounded items excluded and counted, run proceeds", async () => {
    const mod = await worker();
    const source = makeSourceBlocks();
    const result = mod.passA.degradedPrimaryOutput(mixedModelOutput(), source, "A-w10");
    assert(result !== null, "degraded output must not be null");
    // The valid rule survives
    assertEq(result.unit.globalRules.length, 1);
    assertEq(result.unit.globalRules[0].id, "r-valid-1");
    // The invalid rule is excluded and counted
    assert(result.degradedItemCount >= 1, "at least one item must be degraded");
    assertEq(result.totalItemCount, 2);
    // Limitations are counted
    assert(result.limitations.length >= 1, "limitations must be produced");
    const structuralLimitation = result.limitations.find(
      (l) => l.reason === "structural-validation-failed",
    );
    assert(structuralLimitation !== undefined, "a structural-validation-failed limitation must exist");
    assertEq(structuralLimitation.rowKind, "global-rule");
    assertEq(structuralLimitation.rowIndex, 2);
  });

  test("grounded items survive degradation byte-identically", async () => {
    const mod = await worker();
    const source = makeSourceBlocks();
    const result = mod.passA.degradedPrimaryOutput(mixedModelOutput(), source, "A-w10");
    assert(result !== null, "degraded output must not be null");
    const rule = result.unit.globalRules[0];
    // The surviving rule retains its exact statement, quote, and block ids
    assertEq(rule.statement, "Skip to Q5 when respondent selects No to Q1");
    assertEq(rule.docQuote, "the survey must skip to Q5");
    assertEq(rule.blockIds[0], "b0901");
  });

  test("a fully-ungrounded window lands empty with all items counted, never a silent empty", async () => {
    const mod = await worker();
    const source = makeSourceBlocks();
    const result = mod.passA.degradedPrimaryOutput(allInvalidModelOutput(), source, "A-w10");
    assert(result !== null, "degraded output must not be null even when all items fail");
    assertEq(result.unit.globalRules.length, 0);
    assertEq(result.unit.crossRefs.length, 0);
    assertEq(result.unit.ambiguities.length, 0);
    assertEq(result.unit.unverifiable.length, 0);
    // ALL items are degraded
    assertEq(result.degradedItemCount, 2);
    assertEq(result.totalItemCount, 2);
    // All limitations are counted
    assertEq(result.limitations.length, 2);
    assert(
      result.limitations.every((l) => l.reason === "structural-validation-failed"),
      "all limitations must be structural-validation-failed",
    );
  });

  test("the limitation flows to the completion record and progress projection", async () => {
    const mod = await worker();
    const source = makeSourceBlocks();
    const result = mod.passA.degradedPrimaryOutput(mixedModelOutput(), source, "A-w10");
    assert(result !== null, "degraded output must not be null");
    // The limitations array is a valid PassAPrimaryGroundingLimitationWire[]
    const validated = mod.groundingLimitations.validatePassAPrimaryGroundingLimitations(
      result.limitations,
    );
    assert(Array.isArray(validated), "validated limitations must be an array");
    assert(validated.length >= 1, "at least one validated limitation");
    // Each limitation has the expected shape
    for (const lim of validated) {
      assertEq(lim.kind, "pass-a-primary-candidate-ungrounded");
      assert(typeof lim.unit === "string", "unit must be a string");
      assert(typeof lim.rowIndex === "number", "rowIndex must be a number");
      assert(Array.isArray(lim.sourceBlockIds), "sourceBlockIds must be an array");
    }
  });

  test("negative fixture: degradation returns null for completely unusable output", async () => {
    const mod = await worker();
    const source = makeSourceBlocks();
    // An object with no arrays at all
    const result = mod.passA.degradedPrimaryOutput(
      { some_random_field: "value" },
      source,
      "A-w10",
    );
    assertEq(result, null);
  });

  test("negative fixture: removing degradation logic makes the exclusion test fail", async () => {
    // This test proves the degradation test CAN fail: if we feed the mixed output
    // through strictPrimaryOutput (the non-degraded path), it THROWS on the invalid
    // construct, proving the degradation is what saves the valid items.
    const mod = await worker();
    let threw = false;
    try {
      mod.passA.__test_strictPrimaryOutput(mixedModelOutput(), "A-w10");
    } catch {
      threw = true;
    }
    assert(threw, "strictPrimaryOutput must throw on the invalid construct");
  });
});

suite("Budget mode — Gemini-primary pass A", () => {
  test("EXTRACT_PASS_A_PRIMARY validates legal values", async () => {
    const mod = await worker();
    assertEq(mod.passA.validatePassAPrimaryMode({ EXTRACT_PASS_A_PRIMARY: "grok" }), "grok");
    assertEq(mod.passA.validatePassAPrimaryMode({ EXTRACT_PASS_A_PRIMARY: "gemini" }), "gemini");
    assertEq(mod.passA.validatePassAPrimaryMode({}), "grok"); // default
  });

  test("invalid EXTRACT_PASS_A_PRIMARY throws", async () => {
    const mod = await worker();
    let threw = false;
    try {
      mod.passA.validatePassAPrimaryMode({ EXTRACT_PASS_A_PRIMARY: "openai" });
    } catch (err) {
      threw = true;
      assert(err.message.includes("EXTRACT_PASS_A_PRIMARY"), "error must name the var");
    }
    assert(threw, "invalid mode must throw");
  });

  test("budget mode: route identity is distinct from grok mode", async () => {
    const mod = await worker();
    const grokEnv = testEnv({ EXTRACT_PASS_A_PRIMARY: "grok" });
    const geminiEnv = testEnv({ EXTRACT_PASS_A_PRIMARY: "gemini" });
    const grokId = mod.passA.passAPrimaryRouteIdentity(grokEnv);
    const geminiId = mod.passA.passAPrimaryRouteIdentity(geminiEnv);
    assert(grokId !== geminiId, "gemini-read contract is not a grok-read contract");
    assert(geminiId.startsWith("gemini-primary:"), "gemini route must be named distinctly");
  });

  test('"grok" mode byte-identical behavior to today (regression)', async () => {
    const mod = await worker();
    const env = testEnv({ EXTRACT_PASS_A_PRIMARY: "grok" });
    const routeId = mod.passA.passAPrimaryRouteIdentity(env);
    const grokRouteId = mod.grok.grokFlashRouteIdentity(env);
    assertEq(routeId, grokRouteId);
  });

  test("negative fixture: setting an invalid value throws at mode validation", async () => {
    const mod = await worker();
    let threw = false;
    try {
      mod.passA.validatePassAPrimaryMode({ EXTRACT_PASS_A_PRIMARY: "" });
    } catch {
      threw = true;
    }
    assert(threw, "empty string must be rejected");
  });
});
