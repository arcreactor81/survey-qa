/**
 * passOnly:"B" guard in devExtract.
 *
 * The dev-extract route's passOnly:"B" mode exists to run ONLY DeepSeek pass B
 * against an EXISTING Grok pass-A authority. Before this guard, the route called
 * stagePassA unconditionally — buying Grok calls against a nearly-exhausted,
 * owner-capped budget when the caller intended a DeepSeek-only run.
 *
 * Test (a) FAILS on the code before the guard: stagePassA is called
 *   unconditionally, falls through to runPassA, and makes Grok calls — the
 *   fetch interceptor counts them and the "zero calls" assertion breaks.
 *
 * Test (b) proves the happy path: with a staged persisted evaluated pass-A
 *   authority, the guard allows through, stagePassA reuses the artifact at zero
 *   Grok cost, and pass B starts with DeepSeek.
 *
 * STREAMING NOTE. devExtract returns ndjson over a TransformStream. In Node,
 * `wait: true` deadlocks (write backpressure vs. read after await), so the tests
 * leave wait at its default (false) and read the response body concurrently with
 * the work — exactly what an HTTP client does.
 */

import { readFileSync } from "node:fs";
import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation",
  "piping", "carry-forward", "calculation", "randomization", "loop", "instruction",
];

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    DEV_SEED: "enabled",
    V2_PREFIX: "v2/",
    DEEPSEEK_API_KEY: "test-deepseek-key",
    DEEPSEEK_FALLBACK_MODE: "disabled",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: "test-xai-key",
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
    EXTRACT_CHUNK_MAX_BLOCKS: "1",
    EXTRACT_CHUNK_CHARS: "1000",
    EXTRACT_CHUNK_CONCURRENCY: "1",
    EXTRACT_MAX_ATTEMPTS: "1",
    EXTRACT_CHUNK_MAX_ISSUES: "1",
    EXTRACT_SWEEP_MAX_CALLS: "3",
    EXTRACT_SWEEP_BLOCKS_PER_CALL: "40",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
    EXTRACT_PASS_A_WINDOW_CHARS: "99999999",
    ...overrides,
  };
}

/** Read the sample questionnaire once. */
const sampleDocxBytes = readFileSync(
  new URL("../../../public/sample/questionnaire.docx", import.meta.url),
);
const sampleDocxBase64 = Buffer.from(sampleDocxBytes).toString("base64");

/** Parse ndjson lines from a streaming dev-extract response. */
function parseNdjsonLines(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

suite("passOnly:B guard", () => {
  /**
   * (a) passOnly:"B" with no runId MUST refuse before any provider/credential call.
   *
   * ON THE CODE BEFORE THE GUARD, this test FAILS: stagePassA is called
   * unconditionally, falls through to runPassA, and makes Grok calls — the
   * fetch interceptor counts them and the "zero calls" assertion breaks.
   */
  test("passOnly:B with no runId refuses before any provider call", async () => {
    const m = await mod();
    const env = envFor();

    let fetchCallCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      // Return a shape that does not crash the caller, but is never reached
      // on the guarded code path.
      return new Response(
        JSON.stringify({ error: "test: should not have been called" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const req = new Request("https://test.invalid/api/v2/dev/extract", {
        method: "POST",
        body: JSON.stringify({
          documentBase64: sampleDocxBase64,
          passOnly: "B",
          // no runId — a fresh run has no pass-A artifact
          // wait defaults to false — reading the response body drives the work
        }),
      });
      const response = await m.devExtractRoute.devExtract(req, env);
      // Reading the body concurrently drives the TransformStream work to completion.
      const text = await response.text();
      const lines = parseNdjsonLines(text);
      const resultEvent = lines.find((l) => l.event === "result");
      assert(resultEvent, "the stream must contain a result event");
      assertEq(
        resultEvent.result.mode,
        "pass-B-only-refused",
        "mode must be pass-B-only-refused",
      );
      assert(
        typeof resultEvent.result.reason === "string" &&
          resultEvent.result.reason.length > 0,
        "reason must name what was missing",
      );
      assertEq(
        fetchCallCount,
        0,
        "zero provider calls must have been made — the guard must refuse before any fetch",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * (b) passOnly:"B" with a staged persisted evaluated pass-A authority
   * proceeds into pass B without any Grok purchase.
   *
   * Setup: run pass A against the sample document with a Grok stub to produce
   * a real persisted pass-A artifact. Then call devExtract with passOnly:"B"
   * and the runId. The guard sees the artifact, allows through; stagePassA
   * reuses it at zero Grok cost; stagePassB starts DeepSeek calls.
   */
  test("passOnly:B with staged pass-A authority proceeds without Grok purchase", async () => {
    const m = await mod();
    const env = envFor();
    const documentSha256 = await m.hash.sha256Hex(sampleDocxBytes);

    // ── Step 1: create a run and produce a real pass-A artifact ──────────

    const runId = m.ids.mintRunId();
    const documentKey = m.keys.inputDocumentKey(runId);
    await env.EVIDENCE.put(documentKey, sampleDocxBytes);
    await m.checkpoint.createCheckpoint(
      env,
      m.checkpoint.initialCheckpoint(env, runId, "standard", false),
    );
    const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);

    // Write the envelope so devExtract's resume path can validate the document.
    await m.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: new Date().toISOString(),
      instanceId: runId,
      input: {
        surveyUrl: "https://example.invalid/not-executed",
        documentKey,
        documentSha256,
        documentName: "questionnaire.docx",
        targetBuildId: null,
        locale: "en",
        viewports: ["desktop"],
        documentSemanticsProfile: m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    });

    // Run pass A with a Grok stub.
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({
        model: body.model,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                global_rules: [],
                cross_references: [],
                ambiguities: [],
                unverifiable_from_browser: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    };
    let passA;
    try {
      passA = await m.extractStage.stagePassASlice(
        env,
        runId,
        documentKey,
        "questionnaire.docx",
        fence,
        async () => {},
        {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
        documentSha256,
      );
    } finally {
      globalThis.fetch = original;
    }
    assertEq(passA.result.state, "evaluated", "pass A must produce an evaluated artifact");

    // ── Step 2: call devExtract with passOnly:"B" ───────────────────────

    let grokCalls = 0;
    let deepseekCalls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const model = String(body.model ?? "");
      if (model.startsWith("grok")) {
        grokCalls++;
        return new Response(
          JSON.stringify({ error: "should not call Grok" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      deepseekCalls++;
      // Minimal DeepSeek response. Pass B decodes it; it may fail (empty
      // obligations), but the test cares only about Grok-vs-DeepSeek counts.
      const user = String(body.messages?.[1]?.content ?? "");
      const unit =
        (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1] ?? "B-1";
      return Response.json({
        model: body.model,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                chunk_id: unit,
                obligations: [],
                block_dispositions: [],
                construct_checklist: CONSTRUCTS.map((c) => ({
                  construct: c,
                  present: false,
                  block_ids: [],
                })),
                ambiguities: [],
                unverifiable_from_browser: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    };

    try {
      const req = new Request("https://test.invalid/api/v2/dev/extract", {
        method: "POST",
        body: JSON.stringify({
          documentBase64: sampleDocxBase64,
          runId,
          passOnly: "B",
          // wait defaults to false
        }),
      });
      const response = await m.devExtractRoute.devExtract(req, env);
      // Read the streaming body — this drives the work to completion.
      const text = await response.text();
      // The response body may contain the error from devExtract's resume
      // validation (a JSON object, not ndjson) when envelope/document validation
      // fails. In that case, parse it directly.
      let lines;
      try {
        lines = parseNdjsonLines(text);
      } catch {
        // Not ndjson — might be a direct error response
        const directResult = JSON.parse(text);
        throw new Error(
          `devExtract returned a direct error instead of ndjson: ${JSON.stringify(directResult)}`,
        );
      }

      // DEBUG: print all events so a failure is diagnosable
      const events = lines.map((l) => l.event ?? "?").join(", ");
      const resultEvent = lines.find((l) => l.event === "result");
      const resultDetail = resultEvent
        ? JSON.stringify(resultEvent.result?.mode ?? resultEvent.result?.error ?? "unknown")
        : "no-result-event";

      assertEq(
        grokCalls,
        0,
        `zero Grok calls when pass-A authority is already persisted (events: ${events}, result: ${resultDetail})`,
      );
      assert(
        deepseekCalls > 0,
        `at least one DeepSeek call must have been made — pass B must have started (events: ${events}, result: ${resultDetail})`,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
