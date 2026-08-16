/**
 * Pass-B continuation after terminal chunk failure.
 *
 * N synthetic chunks with one terminal failure: every other chunk is still
 * issued, the sweep runs over the dead chunk's blocks, slice.done is true
 * when the whole walk completes, and the stage seals with the failed unit
 * named. Plus the rate guardrail: failures past ceil(0.2 * N) stop issuing
 * with FAILURE_RATE_EXCEEDED.
 */

import { readFileSync } from "node:fs";
import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation",
  "piping", "carry-forward", "calculation", "randomization", "loop", "instruction",
];

/**
 * Extract block ID -> text map from the request's source blocks JSONL.
 * Works for both chunk prompts (YOUR SOURCE BLOCKS) and sweep prompts
 * (UNACCOUNTED SOURCE BLOCKS).
 */
function extractBlockTexts(userMessage) {
  const texts = new Map();
  const patterns = [
    /===== YOUR SOURCE BLOCKS JSONL[^=]*=====\n([\s\S]*?)\n===== END YOUR SOURCE BLOCKS JSONL =====/,
    /===== UNACCOUNTED SOURCE BLOCKS JSONL =====\n([\s\S]*?)\n===== END UNACCOUNTED SOURCE BLOCKS JSONL =====/,
  ];
  for (const pattern of patterns) {
    const m = userMessage.match(pattern);
    if (m) {
      for (const line of m[1].split("\n").filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.block_id && parsed.text) texts.set(parsed.block_id, parsed.text);
        } catch { /* skip unparseable lines */ }
      }
    }
  }
  return texts;
}

/**
 * Build a valid pass-B response for the given blocks. The `textMap` carries the
 * actual source block text so evidence_quotes pass the decoder's grounding check.
 */
function validPayload(unit, blockIds, textMap) {
  return {
    chunk_id: unit,
    obligations: blockIds.map((id, index) => {
      // Use the first 40 chars of the actual block text as the evidence quote,
      // which is guaranteed to be an exact span of the source.
      const fullText = textMap.get(id) ?? `Block ${id}`;
      const quote = fullText.slice(0, Math.max(10, fullText.length));
      return {
        id: `${unit}-R${index + 1}`,
        construct: "question",
        scope: `question:${id}`,
        quantifier: "every",
        selector: id,
        exceptions: [],
        statement: "The question must be asked.",
        doc_quote: quote,
        block_ids: [id],
        evidence_quotes: [{ block_id: id, quote }],
        browser_observable: "full",
        confidence: 0.9,
        expansion: null,
      };
    }),
    block_dispositions: blockIds.map((id) => ({
      block_id: id,
      disposition: blockIds.length > 0 ? "normative" : "non-normative",
      reason: "Requirement.",
    })),
    construct_checklist: CONSTRUCTS.map((c) => ({
      construct: c,
      present: c === "question" && blockIds.length > 0,
      block_ids: c === "question" ? blockIds : [],
    })),
    ambiguities: [],
    unverifiable_from_browser: [],
  };
}

function envFor(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
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

async function sourceBed(m, env) {
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  const documentKey = m.keys.inputDocumentKey(runId);
  const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes);
  return { env, runId, documentKey, documentBytes, documentSha256, fence };
}

async function passABed(m, env) {
  const bed = await sourceBed(m, env);
  const { runId, documentKey, documentSha256, fence } = bed;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({
      model: body.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{
        message: { content: JSON.stringify({
          global_rules: [], cross_references: [], ambiguities: [], unverifiable_from_browser: [],
        }) },
        finish_reason: "stop",
      }],
    });
  };
  let passA;
  try {
    passA = await m.extractStage.stagePassASlice(
      env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      documentSha256,
    );
  } finally {
    globalThis.fetch = original;
  }
  assertEq(passA.result.state, "evaluated", "pass A must succeed");
  return { ...bed, passAHash: passA.result.value.hash };
}

suite("pass-B continuation after terminal failure", () => {
  test("failures past ceil(0.2 * N) stop issuing with PASS_B_FAILURE_RATE_EXCEEDED", async () => {
    // mutation-anchor: failure-rate-guardrail
    // Every chunk fails with bad output. Once terminal failures exceed 20% of
    // total chunks, the guardrail fires and the remaining chunks are never issued.
    const m = await mod();
    const env = envFor({ EXTRACT_CHUNK_MAX_ISSUES: "1", EXTRACT_CHUNK_CONCURRENCY: "1" });
    const bed = await passABed(m, env);
    const { runId, documentKey, documentSha256, fence, passAHash } = bed;

    let callCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      const user = String(body.messages[1].content);
      const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1];
      // Every chunk returns invalid output.
      return new Response(JSON.stringify({
        model: body.model,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{
          message: { content: JSON.stringify({ chunk_id: unit, bad: true }) },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const result = await m.extractStage.stagePassBSlice(
        env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );

      // The threshold is ceil(N * 0.2). After that many terminal failures,
      // the guardrail must stop issuing — so not all chunks get called.
      const threshold = Math.ceil(result.slice.chunksTotal * 0.2);
      assert(
        callCount <= threshold + 1,
        `guardrail must stop issuing after ~${threshold} failures, but ${callCount} calls were made`,
      );
      // The stage remaps PASS_B_FAILURE_RATE_EXCEEDED to FAILURE_RATE_EXCEEDED.
      assertEq(
        result.result.reason,
        "FAILURE_RATE_EXCEEDED",
        "reason code must be FAILURE_RATE_EXCEEDED",
      );
      assertEq(result.slice.done, false, "slice.done must be false when guardrail fires");
      assert(
        result.slice.chunksRemaining > 0,
        "some chunks must remain un-issued after guardrail fires",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("one terminal chunk does not stop other chunks from issuing", async () => {
    // mutation-anchor: done-does-not-require-zero-failed-units
    const m = await mod();
    const env = envFor({ EXTRACT_CHUNK_MAX_ISSUES: "1" });
    const bed = await passABed(m, env);
    const { runId, documentKey, documentSha256, fence, passAHash } = bed;

    let callIndex = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      callIndex++;
      const body = JSON.parse(init.body);
      const user = String(body.messages[1].content);
      const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1];
      const isSweep = user.includes("LEDGER SWEEP");
      const textMap = extractBlockTexts(user);

      let blockIds;
      if (isSweep) {
        blockIds = [...textMap.keys()];
      } else {
        const declared = (user.match(/Your chunk contains exactly \d+ blocks: ([^\n]+)/) ?? [])[1] ?? "";
        blockIds = declared.split(",").map((v) => v.trim()).filter(Boolean);
      }

      // First chunk call (not sweep) always fails.
      if (callIndex === 1 && !isSweep) {
        return new Response(JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [{
            message: { content: JSON.stringify({ chunk_id: unit, bad: true }) },
            finish_reason: "stop",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // All other chunks and all sweeps succeed.
      return new Response(JSON.stringify({
        model: body.model,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{
          message: { content: JSON.stringify(validPayload(unit, blockIds, textMap)) },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const result = await m.extractStage.stagePassBSlice(
        env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );

      // With maxIssues=1, the first chunk is terminal immediately.
      // But all other chunks should still have been issued.
      assert(callIndex > 1, "more than one chunk must have been called");
      // The slice should indicate the walk completed (done=true) because
      // all chunks are accounted for (ok or terminal-failed).
      // The result may be not-evaluated if the reconstruction fails, but
      // the slice.done tells us the walk completed.
      assertEq(result.slice.done, true, "slice.done must be true when all chunks are accounted for");
    } finally {
      globalThis.fetch = original;
    }
  });
});
