/**
 * Pass-B semantic retry: a semantic failure on purchase 1 is retried, not terminal.
 *
 * Validates: (1) first-attempt semantic failure yields terminal: false; (2) the
 * unit is re-issued on the next wave; (3) a valid second answer lands as ok; (4)
 * the retry request body contains the echoed PASS_B_OUTPUT_INVALID detail; (5)
 * the request passed wire preflight (guards the B2 ordering trap).
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
        try { const parsed = JSON.parse(line); if (parsed.block_id && parsed.text) texts.set(parsed.block_id, parsed.text); } catch { /* skip */ }
      }
    }
  }
  return texts;
}

function validPayload(unit, blockIds, textMap) {
  const cited = blockIds;
  return {
    chunk_id: unit,
    obligations: blockIds.map((id, index) => {
      const fullText = (textMap && textMap.get(id)) || `Block ${id} must be answered.`;
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
      disposition: "normative",
      reason: "States a requirement.",
    })),
    construct_checklist: CONSTRUCTS.map((c) => ({
      construct: c,
      present: c === "question" && cited.length > 0,
      block_ids: c === "question" ? cited : [],
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
    EXTRACT_CHUNK_MAX_ISSUES: "2",
    EXTRACT_SWEEP_MAX_CALLS: "0",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
    EXTRACT_PASS_A_WINDOW_CHARS: "99999999",
    ...overrides,
  };
}

async function sourceBed(m) {
  const env = envFor();
  const runId = m.ids.mintRunId();
  await m.checkpoint.createCheckpoint(env, m.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await m.checkpoint.claimOwnership(env, runId, runId, 0);
  const documentKey = m.keys.inputDocumentKey(runId);
  const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
  const documentSha256 = await m.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes);
  return { env, runId, documentKey, documentBytes, documentSha256, fence };
}

async function passABed(m) {
  const bed = await sourceBed(m);
  const { env, runId, documentKey, documentSha256, fence } = bed;
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

suite("pass-B semantic retry", () => {
  test("semantic failure on attempt 1 yields terminal: false and retry with echoed error", async () => {
    // mutation-anchor: semantic-failure-not-instantly-terminal
    const m = await mod();
    const bed = await passABed(m);
    const { env, runId, documentKey, documentSha256, fence, passAHash } = bed;

    let callCount = 0;
    const capturedBodies = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      const user = String(body.messages[1].content);
      capturedBodies.push(user);
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

      if (callCount === 1 && !isSweep) {
        // First attempt: return invalid output (missing required field).
        return new Response(JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [{
            message: { content: JSON.stringify({ chunk_id: unit, invalid: true }) },
            finish_reason: "stop",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Second attempt and sweeps: valid output.
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
      // Wave 1: first attempt fails semantically.
      const wave1 = await m.extractStage.stagePassBSlice(
        env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );
      // The slice must NOT be done and NOT be terminal (it has remaining work).
      assertEq(wave1.result.state, "not-evaluated", "wave 1 should not evaluate yet");
      assert(wave1.slice.chunksRemaining > 0, "failed chunk should count as remaining");

      // Read the stored chunk artifact: must be terminal: false.
      const chunkKey = m.keys.k("runs", runId, "extraction", "pass-b", "chunk-01.json");
      const artifact1Obj = await env.EVIDENCE.get(chunkKey);
      assert(artifact1Obj !== null, "chunk artifact must exist after wave 1");
      const artifact1 = JSON.parse(await artifact1Obj.text());
      assertEq(artifact1.status, "failed");
      assertEq(artifact1.terminal, false, "semantic failure must not be terminal on first attempt");
      assertEq(artifact1.attempts, 1);

      // Wave 2: retry should succeed.
      const wave2 = await m.extractStage.stagePassBSlice(
        env, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );
      assertEq(wave2.result.state, "evaluated", "wave 2 should evaluate with the valid retry");

      // Verify the retry included the echoed error.
      assert(capturedBodies.length >= 2, "at least 2 calls must have been made");
      const retryBody = capturedBodies[capturedBodies.length - 1];
      assert(
        retryBody.includes("PREVIOUS ATTEMPT REJECTED"),
        "retry request must echo the rejection reason",
      );
      assert(
        retryBody.includes("PASS_B_OUTPUT_INVALID"),
        "retry request must contain the validator error",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
