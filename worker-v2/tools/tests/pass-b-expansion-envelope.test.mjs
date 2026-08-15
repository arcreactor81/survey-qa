/**
 * Expansion envelope normalization for pass-B decoder 1.2.0.
 *
 * Three real failure shapes from run v2r_01m03e7d11nz3zepea4rjqehda reproduced
 * synthetically: kind-only, per-kind fields only, and all-five-keys with null
 * route_answers. All must decode after the normalization change. Negative
 * anchors that must still reject: unknown key, invalid kind, non-array non-null
 * route_answers, min_selections > max_selections.
 */

import { assert, assertEq, assertThrows, loadWorker, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation",
  "piping", "carry-forward", "calculation", "randomization", "loop", "instruction",
];

const TEXT = { b0001: "Alpha question must be answered." };

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

function fullPayload(unit, blockIds, expansionValue) {
  return {
    chunk_id: unit,
    obligations: blockIds.map((id, index) => ({
      id: `${unit}-R${index + 1}`,
      construct: "question",
      scope: `question:${id}`,
      quantifier: "every",
      selector: id,
      exceptions: [],
      statement: "The question must be asked.",
      doc_quote: TEXT[id],
      block_ids: [id],
      evidence_quotes: [{ block_id: id, quote: TEXT[id] }],
      browser_observable: "full",
      confidence: 0.9,
      expansion: expansionValue,
    })),
    block_dispositions: blockIds.map((id) => ({
      block_id: id,
      disposition: "normative",
      reason: "States a requirement.",
    })),
    construct_checklist: CONSTRUCTS.map((c) => ({
      construct: c,
      present: c === "question",
      block_ids: c === "question" ? blockIds : [],
    })),
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

suite("pass-B expansion envelope normalization", () => {
  // --- POSITIVE: shapes that must now decode ---

  test("kind-only expansion (the C02 shape) decodes after normalization", async () => {
    // mutation-anchor: expansion-unknown-key-rejection
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], { kind: "configuration" });
    const decoded = m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]);
    assertEq(decoded.obligations[0].expansion.kind, "configuration");
    assertEq(decoded.obligations[0].expansion.routeAnswers.length, 0);
    assertEq(decoded.obligations[0].expansion.maxLength, null);
  });

  test("per-kind route fields (the C08 route shape) decode after normalization", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "route",
      route_answers: [{ code: "1", label: "No", destination: "END" }],
    });
    const decoded = m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]);
    assertEq(decoded.obligations[0].expansion.kind, "route");
    assertEq(decoded.obligations[0].expansion.routeAnswers.length, 1);
    assertEq(decoded.obligations[0].expansion.maxLength, null);
  });

  test("per-kind boundary fields (the C08 boundary shape) decode after normalization", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "boundary",
      min_selections: 1,
      max_selections: 1,
    });
    const decoded = m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]);
    assertEq(decoded.obligations[0].expansion.kind, "boundary");
    assertEq(decoded.obligations[0].expansion.routeAnswers.length, 0);
    assertEq(decoded.obligations[0].expansion.minSelections, 1);
    assertEq(decoded.obligations[0].expansion.maxSelections, 1);
  });

  test("all five keys with route_answers: null (the C09 shape) decode after normalization", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "option-set",
      route_answers: null,
      max_length: null,
      min_selections: null,
      max_selections: null,
    });
    const decoded = m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]);
    assertEq(decoded.obligations[0].expansion.kind, "option-set");
    assertEq(decoded.obligations[0].expansion.routeAnswers.length, 0);
  });

  // --- NEGATIVE: shapes that must still throw ---

  test("unknown key in expansion still rejects", async () => {
    // mutation-anchor: expansion-unknown-key-rejection
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "route",
      surprise: 1,
    });
    assertThrows(
      () => m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]),
      "unknown field",
    );
  });

  test("invalid kind still rejects", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], { kind: "fabricated" });
    assertThrows(
      () => m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]),
      "closed expansion kind",
    );
  });

  test("non-array non-null route_answers still rejects", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "route",
      route_answers: "TERMINATE",
    });
    assertThrows(
      () => m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]),
      "must be an array",
    );
  });

  test("min_selections > max_selections still rejects", async () => {
    const m = await mod();
    const raw = fullPayload("UNIT1", ["b0001"], {
      kind: "boundary",
      min_selections: 5,
      max_selections: 2,
    });
    assertThrows(
      () => m.passB.decodePassBOutput(raw, "UNIT1", [sourceBlock("b0001")]),
      "min_selections exceeds max_selections",
    );
  });
});
