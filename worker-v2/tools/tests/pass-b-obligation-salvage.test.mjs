/**
 * Pass-B per-obligation salvage at retry exhaustion.
 *
 * Modeled on grounding-degradation.test.mjs. Budget-exhausted semantic failure
 * whose raw output has valid dispositions/checklist and a mix of good and bad
 * obligations yields a degraded success artifact. Companion negative: incomplete
 * dispositions means salvage refused, chunk stays terminal.
 */

import { assert, assertEq, loadWorker, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation",
  "piping", "carry-forward", "calculation", "randomization", "loop", "instruction",
];

const TEXT = {
  b0001: "Alpha question must be answered.",
  b0002: "Beta question must be answered.",
};

function sourceBlock(blockId) {
  return {
    blockId,
    kind: "paragraph",
    text: TEXT[blockId],
    origin: "body",
    section: "Questions",
    coords: null,
    tableId: null,
    formatting: {},
    semanticSpans: [],
  };
}

suite("pass-B obligation salvage", async () => {
  const m = await mod();

  test("salvage keeps valid obligations and counts bad ones as limitations", async () => {
    // mutation-anchor: salvage-limitation-counting
    const blocks = [sourceBlock("b0001"), sourceBlock("b0002")];
    const raw = {
      chunk_id: "UNIT1",
      obligations: [
        // Good obligation.
        {
          id: "UNIT1-R1",
          construct: "question",
          scope: "question:b0001",
          quantifier: "every",
          selector: "b0001",
          exceptions: [],
          statement: "The question must be asked.",
          doc_quote: TEXT.b0001,
          block_ids: ["b0001"],
          evidence_quotes: [{ block_id: "b0001", quote: TEXT.b0001 }],
          browser_observable: "full",
          confidence: 0.9,
          expansion: null,
        },
        // Bad obligation: unknown expansion key.
        {
          id: "UNIT1-R2",
          construct: "question",
          scope: "question:b0002",
          quantifier: "every",
          selector: "b0002",
          exceptions: [],
          statement: "The question must be asked.",
          doc_quote: TEXT.b0002,
          block_ids: ["b0002"],
          evidence_quotes: [{ block_id: "b0002", quote: TEXT.b0002 }],
          browser_observable: "full",
          confidence: 0.9,
          expansion: { kind: "route", surprise: 1 },
        },
      ],
      block_dispositions: [
        { block_id: "b0001", disposition: "normative", reason: "Requirement." },
        { block_id: "b0002", disposition: "normative", reason: "Requirement." },
      ],
      construct_checklist: CONSTRUCTS.map((c) => ({
        construct: c,
        present: c === "question",
        block_ids: c === "question" ? ["b0001", "b0002"] : [],
      })),
      ambiguities: [],
      unverifiable_from_browser: [],
    };

    const result = m.passB.salvagePassBOutput(raw, "UNIT1", blocks, blocks);
    assert(result !== null, "salvage must succeed when dispositions and checklist are valid");
    assertEq(result.decoded.obligations.length, 1, "one obligation must survive");
    assertEq(result.decoded.obligations[0].id, "UNIT1-R1");
    assertEq(result.decoded.dispositions.length, 2, "all dispositions must survive");
    assertEq(result.decoded.constructs.length, CONSTRUCTS.length, "all construct classes must be present");
    assert(result.limitations.length >= 1, "at least one limitation must be counted");
    assertEq(result.limitations[0].rowKind, "obligation");
    assertEq(result.limitations[0].reason, "obligation-malformed");

    // Round-trip: the degraded model output re-decodes to the same obligations.
    const reDecoded = m.passB.decodePassBOutput(result.modelOutput, "UNIT1", blocks, blocks);
    assertEq(reDecoded.obligations.length, 1, "re-decode must produce the same obligation count");
    assertEq(reDecoded.obligations[0].id, "UNIT1-R1");
  });

  test("salvage refused when dispositions are incomplete", async () => {
    const blocks = [sourceBlock("b0001"), sourceBlock("b0002")];
    const raw = {
      chunk_id: "UNIT1",
      obligations: [{
        id: "UNIT1-R1",
        construct: "question",
        scope: "question:b0001",
        quantifier: "every",
        selector: "b0001",
        exceptions: [],
        statement: "The question must be asked.",
        doc_quote: TEXT.b0001,
        block_ids: ["b0001"],
        evidence_quotes: [{ block_id: "b0001", quote: TEXT.b0001 }],
        browser_observable: "full",
        confidence: 0.9,
        expansion: null,
      }],
      // Missing disposition for b0002.
      block_dispositions: [
        { block_id: "b0001", disposition: "normative", reason: "Requirement." },
      ],
      construct_checklist: CONSTRUCTS.map((c) => ({
        construct: c,
        present: c === "question",
        block_ids: c === "question" ? ["b0001"] : [],
      })),
      ambiguities: [],
      unverifiable_from_browser: [],
    };

    const result = m.passB.salvagePassBOutput(raw, "UNIT1", blocks, blocks);
    assertEq(result, null, "salvage must be refused when dispositions are incomplete");
  });
});
