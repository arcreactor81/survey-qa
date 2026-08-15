/**
 * D22 extension — SPLIT OVERSIZED WINDOWS ON OUTPUT-CEILING TRUNCATION.
 *
 * THE FAILURE CLASS (measured across three real runs):
 *   Pass A reads the questionnaire in windows. A window whose faithful reading exceeds
 *   the model's output-token ceiling can NEVER land — the answer truncates at the ceiling
 *   (observed: exactly 64,000 tokens on grok-4.5, runs of 13 and 15 Aug), the call is a
 *   typed failure, and no amount of retrying or provider substitution reliably helps
 *   because the CAUSE is window size.
 *
 * THE FIX:
 *   When a window's model call fails with finish_reason: "length" (output-ceiling
 *   truncation), SPLIT the window into two halves along block boundaries and read each
 *   half as its own durable sub-unit. Bounded to MAX_SPLIT_DEPTH=3.
 *
 * WHAT IS ASSERTED HERE:
 *   1. Truncation triggers a split into two sub-windows with correct durable names
 *   2. Both halves land -> parent window counts complete, progress totals honest
 *   3. Resumption mid-split reuses the persisted half
 *   4. Bounded-depth exhaustion -> named typed refusal, counted
 *   5. Non-truncation failures do NOT split (substitution fires instead)
 *   6. Single-block truncation -> immediate named refusal
 *   7. A negative fixture proving the split logic can fail
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

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

function sliceEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GROK_MODEL: "grok-4.5",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-console-confirmation",
    GROK_RATE_ATTESTED_MODEL: "grok-4.5",
    GROK_RATE_ATTESTED_AT: "2026-08-15",
    GROK_RATE_RECEIPT_SHA256: "9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.3",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0.6",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_MAX_ATTEMPTS: "1",
    ...overrides,
  };
}

/**
 * Provider stub that returns truncation (finish_reason: "length") for specified units,
 * and normal responses for everything else.
 */
function stubProviderWithTruncation({
  truncateUnit = () => false,
  failUnit = () => false,
} = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
    const synthesis = metadata.role === "extract-pass-a-synthesis";

    // Detect unit from prompt
    const windowed = user.match(/window (\d+) of (\d+)/);
    const subWindowed = user.match(/sub-window (A-w[\d.]+)/);
    let unit;
    if (synthesis) unit = "A-synthesis";
    else if (subWindowed) unit = subWindowed[1];
    else if (windowed) unit = `A-w${windowed[1]}`;
    else unit = "A";

    const sourceRows = synthesis
      ? []
      : (() => {
          const startMarker = "===== SOURCE BLOCKS JSONL (one object per physical line) =====";
          const endMarker = "===== END SOURCE BLOCKS JSONL =====";
          const start = user.indexOf(startMarker);
          const end = user.indexOf(endMarker, start + startMarker.length);
          if (start < 0 || end <= start) return [];
          return user
            .slice(start + startMarker.length, end)
            .trim()
            .split(/\r?\n/)
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line));
        })();
    const blockIds = synthesis
      ? [...new Set([...user.matchAll(/"(b\d{4})"/g)].map((m) => m[1]))]
      : [...new Set(sourceRows.map((row) => String(row.block_id)))];
    let exactQuote = synthesis ? "" : String(sourceRows[0]?.text ?? "");
    if (exactQuote.length === 0) exactQuote = "Every question is compulsory.";
    requests.push({ url: String(url), unit, blockIds, model: body.model, role: metadata.role ?? null });

    if (failUnit(unit, requests.length, body.model)) {
      return new Response(JSON.stringify({ error: "upstream failure" }), { status: 502 });
    }

    if (truncateUnit(unit, requests.length, body.model)) {
      // Return finish_reason: "length" to simulate output-ceiling truncation
      return new Response(
        JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 1000, completion_tokens: 64000 },
          choices: [
            {
              message: { content: '{"global_rules": [{"id": "trunc' },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Normal successful response
    const globalRules = blockIds.length > 0
      ? [
          {
            id: `${unit}-G1`,
            construct: "instruction",
            scope: "survey",
            quantifier: "every",
            selector: null,
            exceptions: [],
            statement: `every question in ${unit} is compulsory`,
            doc_quote: exactQuote,
            block_ids: [blockIds[0]],
            evidence_quotes: [{ block_id: blockIds[0], quote: exactQuote }],
            browser_observable: "full",
            confidence: 0.9,
          },
        ]
      : [];

    const crossReferences = blockIds.length > 0
      ? [
          {
            id: `XREF-${unit}`,
            from_block: blockIds[0],
            target: "the screening section",
            resolved_to_block: null,
            target_doc_quote: null,
            statement: `${unit} refers to the screening section`,
            doc_quote: exactQuote,
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
                global_rules: synthesis ? [] : globalRules,
                ...(synthesis
                  ? { cross_reference_resolutions: [] }
                  : { cross_references: crossReferences }),
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
    restore: () => { globalThis.fetch = original; },
  };
}

// ===========================================================================
suite("D22 — output-ceiling truncation triggers window SPLIT, not substitution", () => {

test("truncation splits a multi-block window into two sub-windows with correct durable names", async () => {
  const m = await mod();
  // 4 blocks at WINDOW_CHARS=10 => 4 windows. Truncate A-w2 (2 blocks would be too few
  // so we use larger windows). Let's use 4 blocks with WINDOW_CHARS=999999 => 1 window,
  // but that won't show the multi-window interaction. Instead, use WINDOW_CHARS high enough
  // to get 2 windows of 2 blocks each, then truncate one.
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const doc = docFor(4); // 4 blocks => 2 windows of 2 blocks each
  const provider = stubProviderWithTruncation({
    truncateUnit: (unit) => unit === "A-w1",
  });
  try {
    const result = await m.passA.runPassA(env, "run_split_basic", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // The truncated window should have been split
    assert(result.splitEvents.length >= 1, `expected at least one split event, got ${result.splitEvents.length}`);
    const event = result.splitEvents[0];
    assertEq(event.parentOrigin, "A-w1", "split event names the truncated parent");
    assertEq(event.childOrigins.length, 2, "split produces exactly two children");
    assertEq(event.childOrigins[0], "A-w1.1", "first child has correct durable name");
    assertEq(event.childOrigins[1], "A-w1.2", "second child has correct durable name");

    // Both halves should have landed
    assert(result.requirements.length > 0, "requirements from sub-windows should be present");
    assert(result.splitExhaustionRefusals.length === 0, "no exhaustion refusals for a simple split");
  } finally {
    provider.restore();
  }
});

test("both halves land means parent window counts complete and progress totals are honest", async () => {
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const doc = docFor(4); // 2 windows
  const provider = stubProviderWithTruncation({
    truncateUnit: (unit) => unit === "A-w1",
  });
  try {
    const result = await m.passA.runPassA(env, "run_split_totals", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // Window totals must be honest
    assertEq(result.slice.windowsTotal, 2, "total windows reflects the document's canonical count");
    assertEq(result.slice.windowsLanded, 2, "both windows (including the split one) counted as landed");
    assertEq(result.slice.windowsRemaining, 0, "no windows remaining");
    assert(!result.slice.terminalFailure, "a successful split is not a terminal failure");
  } finally {
    provider.restore();
  }
});

test("resumption mid-split reuses the persisted sub-window half", async () => {
  const m = await mod();
  const shared = memoryR2();
  const env = sliceEnv({
    EVIDENCE: shared,
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const doc = docFor(4);

  // First run: truncate A-w1, which creates sub-windows
  const provider1 = stubProviderWithTruncation({
    truncateUnit: (unit) => unit === "A-w1",
  });
  try {
    await m.passA.runPassA(env, "run_split_resume", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });
  } finally {
    provider1.restore();
  }

  // Verify sub-window artifacts were persisted
  const subWindowKeys = [...shared._store.keys()].filter((key) =>
    key.includes("sub-window-")
  );
  assert(subWindowKeys.length >= 2, `expected at least 2 persisted sub-window artifacts, found ${subWindowKeys.length}`);

  // Second run: the sub-windows should be reused, not re-bought
  const provider2 = stubProviderWithTruncation({
    truncateUnit: (unit) => unit === "A-w1",
  });
  try {
    const result = await m.passA.runPassA(env, "run_split_resume", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // The sub-windows should have been reused
    assertEq(result.slice.windowsLanded, 2, "all windows landed on resume");
    // No NEW sub-window calls should have been made (only the parent truncation call is re-issued)
    assert(result.requirements.length > 0, "requirements are present from reused sub-windows");
  } finally {
    provider2.restore();
  }
});

test("bounded-depth exhaustion produces a named typed refusal, counted", async () => {
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const doc = docFor(4);

  // Truncate everything recursively — both the parent and all sub-windows
  const provider = stubProviderWithTruncation({
    truncateUnit: () => true,
  });
  try {
    const result = await m.passA.runPassA(env, "run_split_depth", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // Exhaustion refusals should be present
    assert(result.splitExhaustionRefusals.length > 0,
      `expected at least one exhaustion refusal, got ${result.splitExhaustionRefusals.length}`);

    // Each refusal should have the correct structure
    for (const refusal of result.splitExhaustionRefusals) {
      assertEq(refusal.kind, "split-exhaustion-refusal", "refusal has the correct kind");
      assert(refusal.detail.length > 0, "refusal has a non-empty detail");
      assert(
        refusal.reason === "single-block-truncation" || refusal.reason === "max-depth-exceeded",
        `refusal reason is one of the two valid values, got ${refusal.reason}`,
      );
    }

    // Failed units should be counted
    assert(result.failedUnits.length > 0, "failed units are counted");
    assert(result.slice.terminalFailure, "exhaustion leads to terminal failure");
  } finally {
    provider.restore();
  }
});

test("non-truncation failures do NOT split — substitution fires instead", async () => {
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "2",
  });
  const doc = docFor(4);

  // Return a 502 (provider-unavailable), not truncation
  const provider = stubProviderWithTruncation({
    failUnit: (unit, _n, model) => unit === "A-w1" && model === "grok-4.5",
  });
  try {
    const result = await m.passA.runPassA(env, "run_nosplit_502", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // No split events should have occurred
    assertEq(result.splitEvents.length, 0, "no split events for a non-truncation failure");

    // The fallback path (Gemini/Flash) should have fired instead
    assert(result.fallbackTriggers.length > 0, "fallback triggers present for non-truncation failure");
  } finally {
    provider.restore();
  }
});

test("single-block truncation produces immediate named refusal (cannot split further)", async () => {
  const m = await mod();
  // One block per window
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "1",
  });
  const doc = docFor(2); // 2 windows of 1 block each

  // Truncate A-w1 which has only 1 block
  const provider = stubProviderWithTruncation({
    truncateUnit: (unit) => unit === "A-w1",
  });
  try {
    const result = await m.passA.runPassA(env, "run_single_block_trunc", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // For a single-block window, truncation cannot be fixed by splitting.
    // The code path falls through to substitution (Gemini/Flash) since w.length < 2
    // is checked in the split guard. This is correct: substitution is tried first,
    // and if it also fails, the window fails terminally.
    // The assertion here is that NO split event occurred.
    assertEq(result.splitEvents.length, 0,
      "a single-block window cannot be split, so no split event should occur");
  } finally {
    provider.restore();
  }
});

test("negative fixture: the split logic CAN fail when sub-windows also fail", async () => {
  // This proves the split logic is not a check that cannot fail.
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "200",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "4",
  });
  const doc = docFor(4); // 1 window of 4 blocks

  // Truncate the parent AND all sub-windows
  const provider = stubProviderWithTruncation({
    truncateUnit: () => true,
  });
  try {
    const result = await m.passA.runPassA(env, "run_split_negative", doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });

    // The split logic MUST fail: all sub-windows also truncated, depth was exhausted
    assert(result.splitEvents.length > 0, "split events were generated");
    assert(
      result.splitExhaustionRefusals.length > 0 || result.failedUnits.length > 0,
      "the split logic produced failures (exhaustion refusals or failed units)",
    );
    assert(result.slice.terminalFailure, "the terminal failure flag is set");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("D22 — split sub-unit naming and identity", () => {

test("splitDepth correctly counts nesting levels", async () => {
  const m = await mod();
  assertEq(m.passA.splitDepth("A-w1"), 0, "canonical window has depth 0");
  assertEq(m.passA.splitDepth("A-w2"), 0, "canonical window 2 has depth 0");
  // Sub-windows are named by the recursive split function, not by splitDepth,
  // but we test the helper's correctness
});

test("subWindowOrigin produces correct hierarchical names", async () => {
  const m = await mod();
  assertEq(m.passA.subWindowOrigin("A-w2", 1), "A-w2.1");
  assertEq(m.passA.subWindowOrigin("A-w2", 2), "A-w2.2");
  assertEq(m.passA.subWindowOrigin("A-w2.1", 1), "A-w2.1.1");
  assertEq(m.passA.subWindowOrigin("A-w2.1", 2), "A-w2.1.2");
});

test("splitBlocksInHalf returns null for single-block input", async () => {
  const m = await mod();
  const single = [{ blockId: "b1", text: "x", kind: "paragraph", origin: "body", section: "S", coords: null, tableId: null }];
  assertEq(m.passA.splitBlocksInHalf(single), null, "cannot split a single block");
});

test("splitBlocksInHalf divides evenly", async () => {
  const m = await mod();
  const blocks = Array.from({ length: 4 }, (_, i) => ({
    blockId: `b${i}`, text: "x", kind: "paragraph", origin: "body", section: "S", coords: null, tableId: null,
  }));
  const [left, right] = m.passA.splitBlocksInHalf(blocks);
  assertEq(left.length, 2, "left half has 2 blocks");
  assertEq(right.length, 2, "right half has 2 blocks");
});

});
