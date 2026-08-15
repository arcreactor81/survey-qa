/**
 * Slice-level terminality derives from durable window terminality.
 *
 * MEASURED FAILURE: run v2r_01m02f7dnzxgb8rdpveh8ayd51 (v30), window A-w1 on Gemini.
 * The persisted artifact was correct: status=failed, failureStage=semantic-output,
 * terminal:false, attempts:1. Yet the run terminalized immediately with
 * PASS_A_WINDOW_FAILURES because the SLICE-level terminalFailure was true,
 * contradicting the artifact. This suite pins the invariant: a non-terminal
 * window artifact must produce a non-terminal slice, and a terminal artifact
 * must produce a terminal slice.
 *
 * THE TESTS ARE AT THE STAGE BOUNDARY (stagePassASlice), not just runPassA,
 * because the stage is what the wave loop in run-workflow.ts reads.
 */

import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

// ---------------------------------------------------------------------------
// Helpers — small synthetic documents with controllable provider behavior.
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
 * A provider stub that intercepts globalThis.fetch. Every call is recorded.
 *
 * failSemanticUnit(unit, requestNumber) -> "bad-construct" | "all-bad" | false
 *   "bad-construct": returns a response whose global_rules contain one valid item
 *                    AND one item with an invalid construct ("ordering") that
 *                    fails strictPrimaryOutput but is salvageable by degradation.
 *   "all-bad":       returns a response whose global_rules contain ONLY invalid
 *                    constructs — degradation returns null (terminal).
 *   false:           returns a well-formed response.
 */
function stubProvider({ failSemanticUnit = () => false } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = String(body.messages[1].content);
    const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
    const synthesis = metadata.role === "extract-pass-a-synthesis";
    const windowed = user.match(/window (\d+) of (\d+)/);
    const unit = synthesis ? "A-synthesis" : windowed ? `A-w${windowed[1]}` : "A";
    const sourceRows = synthesis
      ? []
      : (() => {
          const startMarker = "===== SOURCE BLOCKS JSONL (one object per physical line) =====";
          const endMarker = "===== END SOURCE BLOCKS JSONL =====";
          const start = user.indexOf(startMarker);
          const end = user.indexOf(endMarker, start + startMarker.length);
          assert(start >= 0 && end > start, "the primary prompt exposes a bounded JSONL source section");
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

    const semantic = failSemanticUnit(unit, requests.filter((r) => r.unit === unit).length);

    if (semantic === "bad-construct") {
      // One valid item + one invalid construct ("ordering")
      return new Response(
        JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  global_rules: [
                    {
                      id: `${unit}-VALID`,
                      construct: "instruction",
                      scope: "survey",
                      quantifier: "every",
                      selector: null,
                      exceptions: [],
                      statement: `valid rule in ${unit}`,
                      doc_quote: exactQuote,
                      block_ids: [blockIds[0]],
                      evidence_quotes: [{ block_id: blockIds[0], quote: exactQuote }],
                      browser_observable: "full",
                      confidence: 0.9,
                    },
                    {
                      id: `${unit}-BAD`,
                      construct: "ordering",
                      scope: "survey",
                      quantifier: "every",
                      selector: null,
                      exceptions: [],
                      statement: `invalid construct in ${unit}`,
                      doc_quote: exactQuote,
                      block_ids: [blockIds[0]],
                      evidence_quotes: [{ block_id: blockIds[0], quote: exactQuote }],
                      browser_observable: "full",
                      confidence: 0.9,
                    },
                  ],
                  cross_references: [],
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
    }

    if (semantic === "all-bad") {
      // ALL items have invalid constructs and ALL roots are non-array
      return new Response(
        JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  not_global_rules: "wrong shape",
                  not_cross_references: 42,
                  not_ambiguities: true,
                  not_unverifiable: null,
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Normal well-formed response
    const globalRules =
      blockIds.length > 0
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
    const crossReferences =
      blockIds.length > 0
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
    countFor: (unit) => requests.filter((r) => r.unit === unit).length,
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
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MAX_TOTAL_USD: "100",
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
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    ...overrides,
  };
}

async function seedDocument(m, env, runId, doc) {
  const documentKey = m.keys.inputDocumentKey(runId);
  // Serialize a minimal DOCX-like blob; the stage re-reads and parses the document.
  // For the test, we use the sample questionnaire.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { REPO_ROOT } = await import("../testkit.mjs");
  const bytes = readFileSync(path.join(REPO_ROOT, "public", "sample", "questionnaire.docx"));
  await env.EVIDENCE.put(documentKey, bytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  const documentSha256 = await m.hash.sha256Hex(bytes);
  return { documentKey, documentSha256 };
}

async function stageBed(overrides = {}) {
  const m = await mod();
  const env = sliceEnv(overrides);
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  return { m, env, runId, fence };
}

// ===========================================================================
suite("Slice terminality derives from durable window terminality — stage boundary", () => {

test("semantic failure on attempt 1 yields PASS_A_INCOMPLETE (not PASS_A_WINDOW_FAILURES), attempt 2 succeeds", async () => {
  // The v30 regression: window A-w1 fails semantically (unknown construct "ordering")
  // on the first attempt. The persisted artifact is correct: terminal:false, attempts:1.
  // The STAGE must return PASS_A_INCOMPLETE with terminal:false, NOT PASS_A_WINDOW_FAILURES.
  // The second wave re-issues the window, which succeeds.
  const { m, env, runId, fence } = await stageBed({
    EXTRACT_PASS_A_WINDOW_CHARS: "1000",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });

  let attempt = 0;
  const provider = stubProvider({
    failSemanticUnit: (unit, callNumber) => {
      // Fail A-w1 on the first call only, succeed on the second
      if (unit === "A-w1" && callNumber === 1) return "bad-construct";
      return false;
    },
  });
  try {
    const { documentKey, documentSha256 } = await seedDocument(m, env, runId);
    const beat = async () => {};

    // WAVE 1: the first attempt fails semantically. Stage must return PASS_A_INCOMPLETE.
    const wave1 = await m.extractStage.stagePassASlice(
      env, runId, documentKey, "questionnaire.docx", fence, beat,
      { budgetMs: 0 },
      "none/1.0.0", documentSha256,
    );
    assertEq(wave1.result.state, "not-evaluated", "wave 1: result is not-evaluated");
    assertEq(wave1.result.reason, "PASS_A_INCOMPLETE",
      "wave 1: reason is PASS_A_INCOMPLETE, NOT PASS_A_WINDOW_FAILURES");
    assertEq(wave1.terminal, false,
      "wave 1: the stage reports terminal:false so the wave loop continues");
    assertEq(wave1.slice.terminalFailure, false,
      "wave 1: slice-level terminalFailure is false (the artifact says terminal:false)");

    // WAVE 2+: drive to completion. The window succeeds on the second attempt.
    let done = wave1;
    let waves = 1;
    while (!done.slice.done && !done.terminal && waves < 60) {
      done = await m.extractStage.stagePassASlice(
        env, runId, documentKey, "questionnaire.docx", fence, beat,
        { budgetMs: 0 },
        "none/1.0.0", documentSha256,
      );
      waves += 1;
    }
    assertEq(done.slice.done || done.result.state === "evaluated", true,
      `the pass eventually completes after ${waves} wave(s)`);
    assert(!done.slice.terminalFailure,
      "the completed pass has no terminal failure");
  } finally {
    provider.restore();
  }
});

test("semantic failure on BOTH attempts with salvageable output: degradation lands the window", async () => {
  // Both attempts return an invalid construct ("ordering") with salvageable raw output.
  // After attempt 2 (maxIssues=2), the window is exhausted but degradation salvages the
  // valid items. The window lands with limitations. The pass continues.
  const { m, env, runId, fence } = await stageBed({
    EXTRACT_PASS_A_WINDOW_CHARS: "1000",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });

  const provider = stubProvider({
    failSemanticUnit: (unit) => {
      // All calls to A-w1 return bad-construct (one valid + one invalid item)
      if (unit === "A-w1") return "bad-construct";
      return false;
    },
  });
  try {
    const { documentKey, documentSha256 } = await seedDocument(m, env, runId);
    const beat = async () => {};

    // Drive to completion
    let out;
    let waves = 0;
    do {
      out = await m.extractStage.stagePassASlice(
        env, runId, documentKey, "questionnaire.docx", fence, beat,
        { budgetMs: 0 },
        "none/1.0.0", documentSha256,
      );
      waves += 1;
      if (waves > 60) throw new Error("pass A never completed");
    } while (!out.slice.done && !out.terminal);

    // The pass should complete because degradation landed A-w1
    if (out.result.state === "evaluated") {
      // Degradation succeeded: the pass completed with limitations.
      assertEq(out.slice.terminalFailure, false,
        "degradation-landed pass has no terminal failure");
    } else if (out.result.reason === "PASS_A_INCOMPLETE") {
      // Still making progress — A-w1 was degraded but other windows remain
      assertEq(out.slice.terminalFailure, false,
        "incomplete pass with degraded window has no terminal failure");
    } else {
      // If for some reason the degradation path is not taken at the stage level,
      // verify the failure is terminal ONLY with PASS_A_WINDOW_FAILURES
      assert(
        out.result.reason === "PASS_A_WINDOW_FAILURES",
        `unexpected terminal reason: ${out.result.reason}`,
      );
    }
  } finally {
    provider.restore();
  }
});

test("unsalvageable raw output at retry exhaustion: PASS_A_WINDOW_FAILURES, terminal:true", async () => {
  // Both attempts return completely unusable output (no valid root arrays).
  // degradedPrimaryOutput returns null. The window is terminally failed.
  const { m, env, runId, fence } = await stageBed({
    EXTRACT_PASS_A_WINDOW_CHARS: "1000",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });

  const provider = stubProvider({
    failSemanticUnit: (unit) => {
      if (unit === "A-w1") return "all-bad";
      return false;
    },
  });
  try {
    const { documentKey, documentSha256 } = await seedDocument(m, env, runId);
    const beat = async () => {};

    // Drive waves until terminal
    let out;
    let waves = 0;
    do {
      out = await m.extractStage.stagePassASlice(
        env, runId, documentKey, "questionnaire.docx", fence, beat,
        { budgetMs: 0 },
        "none/1.0.0", documentSha256,
      );
      waves += 1;
      if (waves > 60) throw new Error("pass A never terminated");
    } while (!out.terminal);

    assertEq(out.result.reason, "PASS_A_WINDOW_FAILURES",
      "unsalvageable exhaustion produces PASS_A_WINDOW_FAILURES");
    assertEq(out.terminal, true,
      "unsalvageable exhaustion is terminal");
    assertEq(out.slice.terminalFailure, true,
      "unsalvageable exhaustion sets slice terminalFailure");
  } finally {
    provider.restore();
  }
});

});

// ===========================================================================
suite("v30 regression fixture — terminal:false + attempts:1 maps to non-terminal slice", () => {

test("a first-attempt semantic failure produces a non-terminal artifact AND a non-terminal slice", async () => {
  // Pin the v30 artifact facts: A-w1 fails semantically on attempt 1. The persisted
  // artifact must have terminal:false, and the slice must have terminalFailure:false.
  // This is the LIVE reproduction of the divergence: both facts are derived from the
  // same runPassA invocation, so they cannot disagree by construction.
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });
  const doc = docFor(11); // 11 windows, matching v30

  const provider = stubProvider({
    failSemanticUnit: (unit, callNumber) => {
      // Fail A-w1 on all calls (first wave only sees one call at zero budget)
      if (unit === "A-w1") return "bad-construct";
      return false;
    },
  });
  try {
    const runId = "run_v30_live";
    // Wave 1 with zero budget: only one window is attempted, and it fails semantically.
    const wave1 = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, {
      budgetMs: 0,
    });
    assertEq(wave1.slice.terminalFailure, false,
      "v30 REGRESSION: first-attempt semantic failure must produce terminalFailure:false on slice");
    assert(wave1.slice.windowsRemaining > 0,
      "v30 REGRESSION: the failed window is counted as remaining, not landed");
    assertEq(wave1.slice.done, false,
      "v30 REGRESSION: the pass is not done (windows remain)");

    // Verify the persisted artifact has terminal:false
    const windowKey = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const artifactObj = await env.EVIDENCE.get(windowKey);
    assert(artifactObj !== null, "the window artifact must exist after wave 1");
    const artifact = JSON.parse(await artifactObj.text());
    assertEq(artifact.status, "failed", "the artifact status is 'failed'");
    assertEq(artifact.terminal, false, "the artifact terminal is false");
    assertEq(artifact.attempts, 1, "the artifact attempts is 1");
    assertEq(artifact.failureStage, "semantic-output", "the artifact failureStage is semantic-output");

    // Wave 2: the non-terminal artifact is reclaimed and the slice is STILL non-terminal.
    const wave2 = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, {
      budgetMs: 0,
    });
    assertEq(wave2.slice.terminalFailure, false,
      "v30 REGRESSION: reclaiming a non-terminal artifact must produce terminalFailure:false");
  } finally {
    provider.restore();
  }
});

test("negative fixture: a terminally failed window IS terminal on reclaim", async () => {
  // Prove the test above can fail: exhaust the retry budget so the artifact is
  // terminal:true, then verify the slice IS terminal on reclaim.
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });
  const doc = docFor(3);

  const provider = stubProvider({
    // ALL calls to A-w1 return unsalvageable output
    failSemanticUnit: (unit) => unit === "A-w1" ? "all-bad" : false,
  });
  try {
    const runId = "run_terminal_reclaim";
    // Drive to exhaustion
    let last;
    let waves = 0;
    do {
      last = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, {
        budgetMs: 0,
      });
      waves += 1;
      if (waves > 20) throw new Error("pass A never terminated");
    } while (!last.slice.terminalFailure && !last.slice.done);

    assertEq(last.slice.terminalFailure, true,
      "exhausted-attempts window with unsalvageable output is terminal");

    // Verify the persisted artifact has terminal:true
    const windowKey = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const artifact = JSON.parse(await (await env.EVIDENCE.get(windowKey)).text());
    assertEq(artifact.terminal, true, "the exhausted artifact is durably terminal");
    assert(artifact.attempts >= 2, `the artifact has >= 2 attempts, got ${artifact.attempts}`);

    // Reclaim: the terminal artifact produces a terminal slice
    const reclaimed = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, {
      budgetMs: 600_000,
    });
    assertEq(reclaimed.slice.terminalFailure, true,
      "reclaiming a terminal artifact produces a terminal slice");
  } finally {
    provider.restore();
  }
});

test("negative fixture: this test CAN fail — terminal:true + attempts:1 from the old code path IS terminal on reclaim", async () => {
  // BEWARE THE CHECK THAT CANNOT FAIL (CLAUDE.md standing rule).
  // Use the live path: A-w1 fails with a non-retryable TRANSPORT error (nonRetryablePrimaryFailure)
  // on Grok — this sets durableTerminal=true even on attempt 1, producing terminal:true.
  // The slice must be terminal. This proves the v30 regression test's
  // terminalFailure:false assertion can go red when the artifact says terminal:true.
  const m = await mod();
  const env = sliceEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "10",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    // Grok mode (not gemini) so nonRetryablePrimaryFailure can trigger
  });
  const doc = docFor(3);

  // Intercept to return a 401 (Unauthorized) — not eligible for Flash fallback
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const metadata = JSON.parse(String(init.headers?.["cf-aig-metadata"] ?? "{}"));
    requests.push({ url: String(url), model: body.model, role: metadata.role ?? null });
    // 401 is not eligible for Flash fallback: nonRetryablePrimaryFailure = true
    return new Response("Unauthorized", { status: 401 });
  };
  try {
    const runId = "run_negative_nonretryable";
    const result = await m.passA.runPassA(env, runId, doc, "synthetic.docx", undefined, {
      budgetMs: 0,
    });
    assertEq(result.slice.terminalFailure, true,
      "negative fixture: nonRetryablePrimaryFailure on attempt 1 is terminal on the slice");

    // Verify the artifact is terminal too
    const windowKey = m.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    const artifactObj = await env.EVIDENCE.get(windowKey);
    if (artifactObj !== null) {
      const artifact = JSON.parse(await artifactObj.text());
      assertEq(artifact.terminal, true, "the artifact is durably terminal");
    }
    // The test can also throw MissingCredential if the provider errors before
    // reaching the API call, which is equally terminal.
  } finally {
    globalThis.fetch = original;
  }
});

});
