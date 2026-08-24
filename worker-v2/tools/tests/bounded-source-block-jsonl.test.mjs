/** Registered proof for bounded model-input JSON construction before provider serialization. */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { suite, test } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const modulePath = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

const built = await esbuild.build({
  stdin: {
    contents: [
      `export * from ${modulePath("src/extract/bounded-source-block-jsonl.ts")};`,
      `export { encodeSourceBlocksJsonl, sourceBlockModelProjection } from ${modulePath("src/extract/docx-blocks.ts")};`,
    ].join("\n"),
    loader: "ts",
    resolveDir: WORKER_ROOT,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
});

const output = built.outputFiles?.[0]?.text;
if (output === undefined) throw new Error("esbuild produced no bounded-JSONL test module");
const mod = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

const baseBlock = (overrides = {}) => ({
  blockId: "b0001",
  kind: "paragraph",
  text: "ordinary source",
  origin: "body",
  sourceSubrole: null,
  section: null,
  coords: null,
  tableId: null,
  formatting: {
    runs: [],
    paragraphBackground: null,
    cellBackground: null,
    roleBoundarySplit: false,
    unresolvedBackground: [],
  },
  semanticSpans: [],
  ...overrides,
});

suite("BOUNDED MODEL-INPUT JSON - pre-serialization memory guard", () => {

test("normal JSONL is byte-identical to the canonical encoder", () => {
  const blocks = [
    baseBlock({
      text: "quotes and backslashes" + String.fromCharCode(34, 92, 13, 10, 937, 0xd83d, 0xde00, 0xd800),
      section: "Section with slash " + String.fromCharCode(92),
      tableId: "t1",
      coords: { row: 2, col: 3, rowHeader: "row header", colHeader: String.fromCharCode(0x5217) },
      sourceSubrole: "ruby-reading",
      semanticSpans: [{ role: "programming-logic", profile: "profile/1.0.0", runSpans: 2 }],
    }),
    baseBlock({ blockId: "b0002", kind: "heading", text: "Second", section: "Second" }),
  ];
  const expected = mod.encodeSourceBlocksJsonl(blocks);
  const projected = blocks.map((block) => JSON.stringify(mod.sourceBlockModelProjection(block))).join("\n");
  assert.equal(projected, expected, "the exported canonical projection drifted from the JSONL encoder");
  assert.deepEqual(Object.keys(mod.sourceBlockModelProjection(blocks[0])), [
    "block_id",
    "text",
    "kind",
    "origin",
    "section",
    "table_id",
    "coords",
    "source_subrole",
    "semantic_spans",
  ]);
  const expectedBytes = new TextEncoder().encode(expected).byteLength;
  const result = mod.buildBoundedSourceBlocksJsonl(blocks, expectedBytes);
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
  assert.equal(result.utf8Bytes, expectedBytes);
});

test("the canonical projection normalizes legacy optional model fields once", () => {
  const legacy = baseBlock();
  delete legacy.sourceSubrole;
  delete legacy.semanticSpans;
  const projection = mod.sourceBlockModelProjection(legacy);
  assert.equal(projection.source_subrole, null);
  assert.deepEqual(projection.semantic_spans, []);
  assert.equal(mod.encodeSourceBlocksJsonl([legacy]), JSON.stringify(projection));
});

test("canonical escaping can fail exactly after the raw lower bound passes", () => {
  const blocks = [baseBlock({ text: String.fromCharCode(92).repeat(4_096) })];
  const exact = mod.encodeSourceBlocksJsonl(blocks);
  const exactBytes = new TextEncoder().encode(exact).byteLength;
  const result = mod.buildBoundedSourceBlocksJsonl(blocks, exactBytes - 1);
  assert.equal(result.ok, false);
  assert.equal(result.phase, "canonical-row-bytes");
  assert.equal(result.provenUtf8ByteLowerBound, exactBytes);
  assert.equal("text" in result, false, "an oversized result exposed a partial JSONL prefix");
});

test("generic bounded JSON preserves exact canonical nested JSON and UTF-8 bytes", () => {
  const value = {
    v: 1,
    catalogue: [
      { id: "w1", text: "quote " + String.fromCharCode(34, 92, 937, 0xd83d, 0xde00) },
      { id: "w2", rows: [["a", null, true, 7]] },
    ],
  };
  const expected = JSON.stringify(value);
  const expectedBytes = new TextEncoder().encode(expected).byteLength;
  const result = mod.buildBoundedJsonText(value, expectedBytes);
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
  assert.equal(result.utf8Bytes, expectedBytes);
});

test("generic bounded JSON refuses a large nested value before JSON.stringify and returns no prefix", () => {
  const value = { catalogue: { windows: [{ candidates: [{ statement: "x".repeat(2_048) }] }] } };
  // Fail-capable bypass counterproof: deleting the raw lower-bound return reaches this
  // tripwire, so the test goes red instead of merely reasserting fields on a refusal object.
  const originalStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => {
    calls += 1;
    throw new Error("JSON.stringify tripwire");
  };
  try {
    const result = mod.buildBoundedJsonText(value, 128);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "raw-value-lower-bound");
    assert.equal(result.provenUtf8ByteLowerBound, 129);
    assert.equal("text" in result, false, "generic overflow returned a partial JSON prefix");
    assert.equal(calls, 0, "generic overflow reached JSON.stringify");
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("generic bounded JSON counts sparse and explicit-null array structure before JSON.stringify", () => {
  const values = [new Array(64), Array.from({ length: 64 }, () => null)];
  const originalStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => {
    calls += 1;
    throw new Error("JSON.stringify structural tripwire");
  };
  try {
    for (const value of values) {
      const result = mod.buildBoundedJsonText(value, 32);
      assert.equal(result.ok, false);
      assert.equal(result.phase, "raw-value-lower-bound");
      assert.equal(result.provenUtf8ByteLowerBound, 33);
      assert.equal("text" in result, false, "structural overflow returned a partial JSON prefix");
    }
    assert.equal(calls, 0, "sparse/null array structure reached JSON.stringify");
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("generic bounded JSON exact-count catches escaping expansion after raw preflight", () => {
  const value = { catalogue: [String.fromCharCode(92).repeat(2_048)] };
  const expected = JSON.stringify(value);
  const expectedBytes = new TextEncoder().encode(expected).byteLength;
  const result = mod.buildBoundedJsonText(value, expectedBytes - 1);
  assert.equal(result.ok, false);
  assert.equal(result.phase, "canonical-json-bytes");
  assert.equal(result.provenUtf8ByteLowerBound, expectedBytes);
  assert.equal("text" in result, false, "generic exact overflow returned a partial JSON prefix");
});

test("a 50 MiB text value is refused before JSON.stringify", () => {
  const hugeText = "x".repeat(50 * 1024 * 1024);
  // This tripwire is the semantic mutant: a guard that runs only after serialization dies here.
  const originalStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => {
    calls += 1;
    throw new Error("JSON.stringify tripwire");
  };
  try {
    const result = mod.buildBoundedSourceBlocksJsonl([baseBlock({ text: hugeText })], 450_000);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "raw-value-lower-bound");
    assert.equal(result.provenUtf8ByteLowerBound, 450_001);
    assert.equal("text" in result, false);
    assert.equal(calls, 0, "the hostile text reached JSON.stringify before refusal");
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("one repeated section exceeding 50 MiB in aggregate is refused before any row serialization", () => {
  const section = "s".repeat(1024 * 1024);
  const blocks = Array.from({ length: 51 }, (_, index) =>
    baseBlock({ blockId: `b${String(index + 1).padStart(4, "0")}`, section }),
  );
  const originalStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => {
    calls += 1;
    throw new Error("JSON.stringify tripwire");
  };
  try {
    const maxBytes = 50 * 1024 * 1024;
    const result = mod.buildBoundedSourceBlocksJsonl(blocks, maxBytes);
    assert.equal(result.ok, false);
    assert.equal(result.phase, "raw-value-lower-bound");
    assert.equal(result.provenUtf8ByteLowerBound, maxBytes + 1);
    assert.equal(calls, 0, "a repeated section reached per-row serialization before refusal");
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("the raw tripwire visits every string field in the canonical projection", () => {
  const huge = "z".repeat(2_048);
  const variants = [
    ["block_id", () => baseBlock({ blockId: huge })],
    ["text", () => baseBlock({ text: huge })],
    ["kind", () => baseBlock({ kind: huge })],
    ["origin", () => baseBlock({ origin: huge })],
    ["section", () => baseBlock({ section: huge })],
    ["table_id", () => baseBlock({ tableId: huge })],
    ["coords.rowHeader", () => baseBlock({ coords: { row: 1, col: 1, rowHeader: huge, colHeader: null } })],
    ["coords.colHeader", () => baseBlock({ coords: { row: 1, col: 1, rowHeader: null, colHeader: huge } })],
    ["source_subrole", () => baseBlock({ sourceSubrole: huge })],
    ["semantic_spans.role", () => baseBlock({ semanticSpans: [{ role: huge, profile: "p", runSpans: 1 }] })],
    ["semantic_spans.profile", () => baseBlock({ semanticSpans: [{ role: "programming-logic", profile: huge, runSpans: 1 }] })],
  ];
  const originalStringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = () => {
    calls += 1;
    throw new Error("JSON.stringify tripwire");
  };
  try {
    for (const [name, makeBlock] of variants) {
      const result = mod.buildBoundedSourceBlocksJsonl([makeBlock()], 1_000);
      assert.equal(result.ok, false, `${name} did not trip the raw lower bound`);
      assert.equal(result.phase, "raw-value-lower-bound", `${name} reached canonical serialization`);
    }
    const numericProjection = baseBlock({
      blockId: "",
      text: "",
      kind: "",
      origin: "",
      coords: { row: 0, col: 0, rowHeader: null, colHeader: null },
      semanticSpans: [{ role: "", profile: "", runSpans: 0 }],
    });
    const numericResult = mod.buildBoundedSourceBlocksJsonl([numericProjection], 2);
    assert.equal(numericResult.ok, false, "coords/semantic numeric fields were not visited");
    assert.equal(numericResult.phase, "raw-value-lower-bound");
    assert.equal(calls, 0, "an included string field bypassed the raw guard");
  } finally {
    JSON.stringify = originalStringify;
  }
});

test("large formatting evidence is not counted because the canonical encoder does not include it", () => {
  const block = baseBlock({
    formatting: {
      runs: [],
      paragraphBackground: null,
      cellBackground: null,
      roleBoundarySplit: false,
      unresolvedBackground: ["not-on-the-wire".repeat(1024 * 1024)],
    },
  });
  const expected = mod.encodeSourceBlocksJsonl([block]);
  const expectedBytes = new TextEncoder().encode(expected).byteLength;
  const result = mod.buildBoundedSourceBlocksJsonl([block], expectedBytes);
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
});

test("empty input succeeds at a zero-byte ceiling and invalid ceilings fail closed", () => {
  assert.deepEqual(mod.buildBoundedSourceBlocksJsonl([], 0), { ok: true, text: "", utf8Bytes: 0 });
  for (const invalid of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => mod.buildBoundedSourceBlocksJsonl([], invalid),
      /maxBytes must be a non-negative safe integer below Number\.MAX_SAFE_INTEGER/,
    );
  }
});
});
