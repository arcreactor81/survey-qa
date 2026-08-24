/**
 * Pass-B per-obligation salvage at retry exhaustion.
 *
 * Modeled on grounding-degradation.test.mjs. Budget-exhausted semantic failure
 * whose raw output has valid dispositions/checklist and a mix of good and bad
 * obligations yields a degraded success artifact. Companion negative: incomplete
 * dispositions means salvage refused, chunk stays terminal.
 */

import { readFileSync } from "node:fs";
import { assert, assertEq, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

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

suite("pass-B obligation salvage", () => {
  test("salvage keeps valid obligations and counts bad ones as limitations", async () => {
    const m = await mod();
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
    const m = await mod();
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

/**
 * Integration test: salvage limitations must survive resume/reconstruction.
 *
 * runPassB writes limitations into the chunk artifact JSON when salvage fires.
 * reconstructPassBCompletedAuthority must read them back and aggregate them
 * into the completed authority. Before the fix, PersistedChunk had no
 * limitations field, readUnit did not read them, and the reconstructed
 * authority always returned limitations: [].
 */
function envForIntegration(overrides = {}) {
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

function extractBlockTexts(userMessage) {
  const texts = new Map();
  const patterns = [
    /===== YOUR SOURCE BLOCKS JSONL[^=]*=====\n([\s\S]*?)\n===== END YOUR SOURCE BLOCKS JSONL =====/,
    /===== UNACCOUNTED SOURCE BLOCKS JSONL =====\n([\s\S]*?)\n===== END UNACCOUNTED SOURCE BLOCKS JSONL =====/,
  ];
  for (const pattern of patterns) {
    const match = userMessage.match(pattern);
    if (match) {
      for (const line of match[1].split("\n").filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.block_id && parsed.text) texts.set(parsed.block_id, parsed.text);
        } catch { /* skip */ }
      }
    }
  }
  return texts;
}

function validPayloadForIntegration(unit, blockIds, textMap) {
  return {
    chunk_id: unit,
    obligations: blockIds.map((id, index) => {
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

function salvagePayloadForIntegration(unit, blockIds, textMap) {
  // Returns a payload where the first obligation is good but the second has
  // an unknown expansion key, triggering per-item salvage. Both obligations
  // reference the same first block so this works even with single-block chunks.
  const id = blockIds[0];
  const fullText = textMap.get(id) ?? `Block ${id}`;
  const quote = fullText.slice(0, Math.max(10, fullText.length));
  return {
    chunk_id: unit,
    obligations: [
      {
        id: `${unit}-R1`,
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
      },
      {
        id: `${unit}-R2`,
        construct: "question",
        scope: `question:${id}`,
        quantifier: "every",
        selector: id,
        exceptions: [],
        statement: "The question must also be displayed.",
        doc_quote: quote,
        block_ids: [id],
        evidence_quotes: [{ block_id: id, quote }],
        browser_observable: "full",
        confidence: 0.9,
        expansion: { kind: "route", surprise: 1 },
      },
    ],
    block_dispositions: blockIds.map((bid) => ({
      block_id: bid,
      disposition: "normative",
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

suite("pass-B salvage limitations survive reconstruction", () => {
  test("limitations written by salvage are read back by reconstructPassBCompletedAuthority", async () => {
    const m = await mod();
    const env = envForIntegration({ EXTRACT_CHUNK_MAX_ISSUES: "1" });
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const doc = m.docxBlocks.parseDocxBlocks(documentBytes, { documentSemanticsProfile: m.docxBlocks.DOCUMENT_SEMANTICS_NONE });
    const runId = m.ids.mintRunId();

    // Pass B stub: first chunk returns salvageable output (one bad obligation),
    // rest return valid output. Sweeps also valid.
    let callIndex = 0;
    const originalFetch = globalThis.fetch;
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

      // First chunk: return salvageable output (bad expansion on second obligation).
      if (callIndex === 1 && !isSweep) {
        return new Response(JSON.stringify({
          model: body.model,
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [{
            message: { content: JSON.stringify(salvagePayloadForIntegration(unit, blockIds, textMap)) },
            finish_reason: "stop",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      // All other chunks and sweeps succeed.
      return new Response(JSON.stringify({
        model: body.model,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{
          message: { content: JSON.stringify(validPayloadForIntegration(unit, blockIds, textMap)) },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    let passBResult;
    try {
      passBResult = await m.passB.runPassB(env, runId, doc, "questionnaire.docx");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The run must have completed and produced salvage limitations.
    assertEq(passBResult.slice.done, true, "pass B walk must complete");
    assert(
      passBResult.limitations.length > 0,
      "pass B result must contain salvage limitations from the first chunk",
    );
    const limitationsFromRun = passBResult.limitations;

    // Now reconstruct the authority from storage — this is the resume path.
    // runPassB writes chunk artifacts to R2 but does NOT write the pass-level
    // completion key, so reconstructPassBCompletedAuthority reads the per-chunk
    // artifacts directly.
    const authority = await m.passB.reconstructPassBCompletedAuthority(env, runId, doc, "questionnaire.docx");
    assertEq(authority.kind, "ok", "reconstruction must succeed");

    // THE LOAD-BEARING ASSERTION: limitations from salvage must survive reconstruction.
    // Before the fix, this was always [] because PersistedChunk had no limitations field
    // and readUnit did not read them back.
    assert(
      authority.value.limitations.length > 0,
      "reconstructed authority must contain limitations — before the fix this was always empty",
    );
    assertEq(
      authority.value.limitations.length,
      limitationsFromRun.length,
      "reconstructed limitation count must match the count from the live run",
    );
    // Verify the actual limitation shape survived.
    for (let i = 0; i < limitationsFromRun.length; i++) {
      assertEq(authority.value.limitations[i].unit, limitationsFromRun[i].unit);
      assertEq(authority.value.limitations[i].rowKind, limitationsFromRun[i].rowKind);
      assertEq(authority.value.limitations[i].reason, limitationsFromRun[i].reason);
    }
  });
});
