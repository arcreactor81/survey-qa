/**
 * DeepSeek provider continuity for pass B.
 *
 * Flash and Pro are two model legs behind ONE provider and ONE block-walk method.
 * These tests pin the distinction that matters:
 * - a failed primary purchase may buy one explicit fallback purchase;
 * - both purchases keep their own actual-model/cost receipts;
 * - a plan change or malformed receipt invalidates persisted work;
 * - none of this can replace or impersonate the independent Grok pass A.
 *
 * Mutation evidence: tools/mutate-provider-continuity.mjs.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

function env(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
    XAI_API_KEY: "fixture-xai-key",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    EXTRACT_MAX_ATTEMPTS: "1",
    DEEPSEEK_FALLBACK_MAX_ATTEMPTS: "1",
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
    ...overrides,
  };
}

function opts(overrides = {}) {
  return {
    system: "Return JSON.",
    user: "Return one JSON object.",
    maxTokens: 1000,
    maxAttempts: 1,
    role: "extract-pass-b-fixture",
    callId: "call_b_fixture",
    ...overrides,
  };
}

function chatResponse(model, content, promptTokens, completionTokens) {
  return new Response(JSON.stringify({
    model,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    choices: [{ message: { content }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function stubSequence(responders) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const responder = responders[requests.length - 1];
    if (!responder) throw new Error(`unexpected provider request ${requests.length}`);
    return responder(body, requests.length);
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

function oneBlockDocument() {
  const block = {
    blockId: "b0001",
    kind: "paragraph",
    text: "Q1. Ask whether the respondent agrees. SINGLE CODE.",
    origin: "body",
    section: "Questions",
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
  };
  return {
    blocks: [block],
    annotatedText: `[b0001] ${block.text}`,
    counts: { paragraphs: 1, tableCells: 0, footnotes: 0, headings: 0, listItems: 0 },
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

const CONSTRUCTS = [
  "question", "option-list", "skip-rule", "terminate", "validation", "piping",
  "carry-forward", "calculation", "randomization", "loop", "instruction",
];

function passBPayload(body) {
  const user = String(body.messages[1].content);
  const unit = (user.match(/Your chunk id for this call is: (\S+)/) ?? [])[1] ?? "C01-b0001";
  const declared = (user.match(/Your chunk contains exactly \d+ blocks: ([^\n]+)/) ?? [])[1] ?? "b0001";
  const blockIds = declared.split(",").map((value) => value.trim()).filter(Boolean);
  return JSON.stringify({
    chunk_id: unit,
    obligations: [],
    block_dispositions: blockIds.map((block_id) => ({
      block_id,
      disposition: "non-normative",
      reason: "valid empty control for provider transport/receipt tests",
    })),
    construct_checklist: CONSTRUCTS.map((construct) => ({
      construct,
      present: false,
      block_ids: [],
    })),
    ambiguities: [],
    unverifiable_from_browser: [],
  });
}

function passAPayload() {
  return JSON.stringify({
    global_rules: [],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  });
}

async function completePassA(m, value, runId, documentKey, documentSha256, fence) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return chatResponse(body.model, passAPayload(), 100, 50);
  };
  try {
    const outcome = await m.extractStage.stagePassASlice(
      value,
      runId,
      documentKey,
      "questionnaire.docx",
      fence,
      async () => {},
      {},
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      documentSha256,
    );
    assertEq(outcome.result.state, "evaluated", "fixture Pass A must be canonical retained authority");
    return outcome.result.value.hash;
  } finally {
    globalThis.fetch = original;
  }
}

function approx(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

async function settle(m, value, runId, fence, calls) {
  await m.usage.pushModelUsageStrict(
    value,
    runId,
    fence,
    calls.map((row) =>
      m.usage.modelUsage(row.model, row.inputTokens, row.outputTokens, row.costUsd, row.eventId)),
  );
}

suite("PROVIDER CONTINUITY - explicit DeepSeek Flash/Pro legs", () => {
  test("default plan is Flash primary and Pro fallback under one DeepSeek provider", async () => {
    const m = await mod();
    const plan = m.deepseek.deepseekContinuityPlan(env());
    assertEq(plan.provider, "deepseek");
    assertEq(plan.primary.model, "deepseek-v4-flash");
    assertEq(plan.fallback.model, "deepseek-v4-pro");
    assertEq(plan.fallback.maxAttempts, 1);
    assert(m.deepseek.deepseekContinuityIdentity(env()).includes("fallback:deepseek-v4-pro"));
  });

  test("a failed Flash purchase falls back once to Pro and both actual-model cost receipts survive", async () => {
    const m = await mod();
    const stub = stubSequence([
      (body) => chatResponse(body.model, "", 1000, 500),
      (body) => chatResponse(body.model, JSON.stringify({ ok: true }), 2000, 1000),
    ]);
    try {
      const result = await m.deepseek.deepseekJsonWithContinuity(env(), opts());
      assertEq(stub.requests.length, 2);
      assertEq(stub.requests[0].body.model, "deepseek-v4-flash");
      assertEq(stub.requests[1].body.model, "deepseek-v4-pro");
      assertEq(result.fallbackUsed, true);
      assertEq(result.issuedCalls.length, 2);
      assertEq(result.issuedCalls[0].status, "error");
      assertEq(result.issuedCalls[0].model, "deepseek-v4-flash");
      assertEq(result.issuedCalls[0].callId, "call_b_fixture");
      assertEq(result.issuedCalls[1].status, "ok");
      assertEq(result.issuedCalls[1].model, "deepseek-v4-pro");
      assertEq(result.issuedCalls[1].callId, "call_b_fixture:fallback");
      approx(result.issuedCalls[0].costUsd, 0.0011, "Flash official-rate cost");
      approx(result.issuedCalls[1].costUsd, 0.0066, "Pro official-rate cost");
      assert(result.issuedCalls.every((row) => row.provider === "deepseek"),
        "Flash+Pro must not be projected as two independent providers");
    } finally {
      stub.restore();
    }
  });

  test("a successful Flash call never speculatively buys Pro", async () => {
    const m = await mod();
    const stub = stubSequence([
      (body) => chatResponse(body.model, JSON.stringify({ ok: true }), 10, 5),
    ]);
    try {
      const result = await m.deepseek.deepseekJsonWithContinuity(env(), opts());
      assertEq(stub.requests.length, 1);
      assertEq(result.fallbackUsed, false);
      assertEq(result.issuedCalls.length, 1);
      assertEq(result.issuedCalls[0].model, "deepseek-v4-flash");
    } finally {
      stub.restore();
    }
  });

  test("a response must attest the exact requested model under the stored plan", async () => {
    const m = await mod();
    const flashOnlySpec = await m.deepseek.deepseekSpec(env({ DEEPSEEK_FALLBACK_MODE: "disabled" }));
    assertEq(flashOnlySpec.unboundModelRateCeiling.inputUsdPerMTok, 1.32,
      "unbound identity uses the maximum checked DeepSeek input rate even with fallback disabled");
    assertEq(flashOnlySpec.unboundModelRateCeiling.outputUsdPerMTok, 3.96,
      "unbound identity uses the maximum checked DeepSeek output rate even with fallback disabled");
    for (const [label, primaryReportedModel] of [
      ["different", "deepseek-v4-pro"],
      ["missing", undefined],
    ]) {
      const stub = stubSequence([
        () => chatResponse(primaryReportedModel, JSON.stringify({ wrongModel: true }), 100, 50),
        (body) => chatResponse(body.model, JSON.stringify({ ok: true }), 20, 10),
      ]);
      try {
        const result = await m.deepseek.deepseekJsonWithContinuity(env(), opts());
        assertEq(result.fallbackUsed, true, `the ${label} primary model identity is not accepted`);
        assertEq(stub.requests.length, 2);
        assertEq(result.issuedCalls.length, 2);
        assertEq(result.issuedCalls[0].status, "error");
        assert(result.issuedCalls[0].model.startsWith("unverified-model:requested="),
          "the failed receipt must not claim an actual model identity it could not verify");
        assertEq(result.issuedCalls[0].usageSource, "unverified-model-rate-ceiling");
        assertEq(result.issuedCalls[0].outputTokens, 1000);
        approx(
          result.issuedCalls[0].costUsd,
          (result.issuedCalls[0].inputTokens / 1e6) * 1.32 +
            (result.issuedCalls[0].outputTokens / 1e6) * 3.96,
          "unverified model purchase uses the maximum checked/configured DeepSeek rates",
        );
        assert(result.issuedCalls[0].detail.includes("response model identity mismatch"));
        assertEq(result.issuedCalls[1].model, "deepseek-v4-pro");
        assertEq(result.value.ok, true);
      } finally {
        stub.restore();
      }
    }
  });

  test("when both legs fail the error still carries two paid receipts", async () => {
    const m = await mod();
    const stub = stubSequence([
      (body) => chatResponse(body.model, "", 100, 20),
      (body) => chatResponse(body.model, "", 200, 40),
    ]);
    try {
      const error = await assertThrows(
        () => m.deepseek.deepseekJsonWithContinuity(env(), opts()),
        "primary and fallback failed",
      );
      assert(error instanceof m.deepseek.DeepseekContinuityError);
      assertEq(error.issuedCalls.length, 2);
      assertEq(error.issuedCalls[0].model, "deepseek-v4-flash");
      assertEq(error.issuedCalls[1].model, "deepseek-v4-pro");
      assert(error.issuedCalls.every((row) => row.costUsd > 0),
        "failed paid output must not disappear from cost accounting");
    } finally {
      stub.restore();
    }
  });

  test("auth, balance and invalid-request failures never buy a doomed Pro call", async () => {
    const m = await mod();
    // Definitive non-billing statuses (401/402/403) book zero; others keep the ceiling.
    const NON_BILLING = new Set([401, 402, 403]);
    for (const [status, kind] of [
      [400, "invalid-request"],
      [401, "authentication"],
      [402, "insufficient-balance"],
      [403, "authentication"],
      [422, "invalid-request"],
    ]) {
      const stub = stubSequence([
        () => new Response(`fixture HTTP ${status}`, { status }),
      ]);
      try {
        const error = await assertThrows(
          () => m.deepseek.deepseekJsonWithContinuity(
            env({ EXTRACT_MAX_ATTEMPTS: "3" }),
            opts({ maxAttempts: 3 }),
          ),
          `HTTP ${status}`,
        );
        assert(error instanceof m.deepseek.DeepseekContinuityError);
        assertEq(error.failureKind, kind, `HTTP ${status} taxonomy`);
        assertEq(error.fallbackAttempted, false, `HTTP ${status} must not buy Pro`);
        assertEq(error.issuedCalls.length, 1, `HTTP ${status} keeps only the actual Flash receipt`);
        assertEq(error.issuedCalls[0].attempts, 1, `HTTP ${status} stops primary retries immediately`);
        if (NON_BILLING.has(status)) {
          // Definitive pre-generation refusal: zero tokens, zero cost, named source
          assertEq(error.issuedCalls[0].usageSource, "rejected-before-generation",
            `HTTP ${status} must be rejected-before-generation`);
          assertEq(error.issuedCalls[0].inputTokens, 0, `HTTP ${status} books zero input tokens`);
          assertEq(error.issuedCalls[0].outputTokens, 0, `HTTP ${status} books zero output tokens`);
          assertEq(error.issuedCalls[0].costUsd, 0, `HTTP ${status} books zero cost`);
        } else {
          // Ambiguous status: conservative ceiling still applies
          assertEq(error.issuedCalls[0].usageSource, "conservative-ceiling",
            `HTTP ${status} must use conservative ceiling`);
          assert(error.issuedCalls[0].inputTokens > 0,
            `HTTP ${status} unknown input is charged at the request-byte ceiling`);
          assertEq(error.issuedCalls[0].outputTokens, 1000,
            `HTTP ${status} unknown output is charged at max_tokens`);
          assert(error.issuedCalls[0].costUsd > 0,
            `HTTP ${status} missing provider usage is never serialized as free spend`);
        }
        assertEq(stub.requests.length, 1, `HTTP ${status} made exactly one provider request`);
      } finally {
        stub.restore();
      }
    }
  });

  test("rate limiting and provider 5xx explicitly remain fallback-eligible", async () => {
    const m = await mod();
    for (const [status, expectedKind] of [
      [408, "timeout-or-network"],
      [429, "rate-limited"],
      [503, "provider-unavailable"],
    ]) {
      const stub = stubSequence([
        () => new Response(`fixture HTTP ${status}`, { status }),
        (body) => chatResponse(body.model, JSON.stringify({ ok: true }), 20, 10),
      ]);
      try {
        const result = await m.deepseek.deepseekJsonWithContinuity(env(), opts());
        assertEq(result.fallbackUsed, true, `HTTP ${status} should permit Pro continuity`);
        assertEq(stub.requests.length, 2);
        assertEq(result.issuedCalls.length, 2);
        assertEq(result.issuedCalls[0].detail.includes(`HTTP ${status}`), true);
        const classified = new m.chat.ModelCallError("fixture", result.issuedCalls[0], expectedKind, status);
        assertEq(m.deepseek.deepseekFallbackEligible(classified), true);
      } finally {
        stub.restore();
      }
    }
  });

  test("only the exact local deadline rejection is adaptive size evidence", async () => {
    const m = await mod();
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEq(signal.aborted, true);
    assertEq(m.chat.isLocalDeadlineExpiry(signal.reason, signal), true);
    assertEq(
      m.chat.isLocalDeadlineExpiry(new TypeError("network failed after the timer fired"), signal),
      false,
      "an expired timer does not relabel an unrelated network failure",
    );
    assertEq(m.chat.isLocalDeadlineExpiry(signal.reason, null), false);

    const httpTimeout = new m.chat.ModelCallError(
      "fixture HTTP 408",
      { callId: "c", role: "r", provider: "grok", model: "grok-4.5", status: "error",
        inputTokens: 1, outputTokens: 1, costUsd: 1, latencyMs: 1, attempts: 1 },
      "timeout-or-network",
      408,
      "http-status",
    );
    assertEq(httpTimeout.failureCause, "http-status", "HTTP 408 is not local workload-size evidence");
  });

  test("chat transport carries exact deadline, network-race, and HTTP causes", async () => {
    const m = await mod();
    const cases = [
      {
        label: "local deadline",
        responder: (_body, _n, init) => new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(() => reject(new Error("deadline fixture did not abort")), 100);
          init.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          }, { once: true });
        }),
        expected: "local-deadline",
      },
      {
        label: "network after deadline",
        responder: (_body, _n, init) => new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(() => reject(new Error("network-race fixture did not abort")), 100);
          init.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(new TypeError("fixture network race"));
          }, { once: true });
        }),
        expected: "network",
      },
      {
        label: "HTTP 408",
        responder: () => new Response("fixture timeout", { status: 408 }),
        expected: "http-status",
      },
    ];
    for (const row of cases) {
      const original = globalThis.fetch;
      globalThis.fetch = async (_url, init) => row.responder(null, 1, init);
      try {
        const error = await assertThrows(
          () => m.chat.chatJson(
            {
              provider: "grok",
              model: "grok-4.5",
              gatewaySuffix: "/v1",
              directBaseUrl: "https://fixture.invalid",
              apiKey: "fixture",
              inputUsdPerMTok: 1,
              outputUsdPerMTok: 1,
              extraBody: {},
            },
            env(),
            opts({ role: "typed-cause-fixture", timeoutMs: 1, maxAttempts: 1 }),
          ),
          "",
        );
        assert(error instanceof m.chat.ModelCallError, row.label);
        assertEq(error.failureCause, row.expected, row.label);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  test("mixed transport failures stay mixed in either attempt order", async () => {
    const m = await mod();
    const localDeadline = (_body, _n, init) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("deadline fixture did not abort")), 100);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    });
    const network = () => { throw new TypeError("fixture network failure"); };
    for (const [label, responders] of [
      ["deadline then network", [localDeadline, network]],
      ["network then deadline", [network, localDeadline]],
    ]) {
      const original = globalThis.fetch;
      let request = 0;
      globalThis.fetch = async (_url, init) => responders[request++]?.(null, request, init);
      try {
        const error = await assertThrows(
          () => m.chat.chatJson(
            {
              provider: "grok", model: "grok-4.5", gatewaySuffix: "/v1",
              directBaseUrl: "https://fixture.invalid", apiKey: "fixture",
              inputUsdPerMTok: 1, outputUsdPerMTok: 1, extraBody: {},
            },
            env(),
            opts({ role: "mixed-cause-fixture", timeoutMs: 1, maxAttempts: 2 }),
          ),
          "",
        );
        assert(error instanceof m.chat.ModelCallError, label);
        assertEq(error.failureCause, "mixed", label);
        assertEq(request, 2, label + ": both attempt causes were exercised");
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  test("invalid fallback rates fail before the primary can spend", async () => {
    const m = await mod();
    const stub = stubSequence([]);
    try {
      await assertThrows(
        () => m.deepseek.deepseekJsonWithContinuity(
          env({ DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK: "1.32" }),
          opts(),
        ),
        "must be configured together",
      );
      assertEq(stub.requests.length, 0, "configuration must be validated before a paid call");
    } finally {
      stub.restore();
    }
  });

  test("a caller cannot execute an attempt count different from the stored plan identity", async () => {
    const m = await mod();
    const stub = stubSequence([]);
    try {
      await assertThrows(
        () => m.deepseek.deepseekJsonWithContinuity(
          env({ EXTRACT_MAX_ATTEMPTS: "2" }),
          opts({ maxAttempts: 1 }),
        ),
        "must match the continuity plan",
      );
      assertEq(stub.requests.length, 0, "attempt identity mismatch must fail before spend");
    } finally {
      stub.restore();
    }
  });

  test("dormant continuity remains bounded while ordinary pass B budgets only its Pro leg", async () => {
    const m = await mod();
    const bounded = env({
      EXTRACT_MAX_ATTEMPTS: "3",
      DEEPSEEK_FALLBACK_MAX_ATTEMPTS: "999",
      LLM_TIMEOUT_MS: "1000",
    });
    const plan = m.deepseek.deepseekContinuityPlan(bounded);
    assertEq(plan.primary.maxAttempts, 3);
    assertEq(plan.fallback.maxAttempts, 2);
    assertEq(m.deepseek.deepseekContinuityAttemptCeiling(bounded), 5);
    assertEq(m.passB.passBCallCeilingMs(bounded), 3000);
  });

  test("pass-B reuses only artifacts from the exact same continuity plan", async () => {
    const m = await mod();
    const shared = memoryR2();
    const base = env({
      EVIDENCE: shared,
      EXTRACT_CHUNK_MAX_BLOCKS: "1",
      EXTRACT_CHUNK_CHARS: "10",
      EXTRACT_SWEEP_MAX_CALLS: "0",
    });
    const stub = stubSequence([
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
    ]);
    try {
      const first = await m.passB.runPassB(base, "run_plan_bound", oneBlockDocument(), "fixture.docx");
      assertEq(first.slice.done, true);
      assertEq(stub.requests.length, 1);
      const same = await m.passB.runPassB(base, "run_plan_bound", oneBlockDocument(), "fixture.docx");
      assertEq(stub.requests.length, 1, "same-plan artifact should be reclaimed without a purchase");
      assertEq(same.calls.length, 1);
      assertEq(same.calls[0].costUsd, 0);

      const changedPlan = { ...base, DEEPSEEK_FALLBACK_REASONING_EFFORT: "high" };
      const changed = await m.passB.runPassB(changedPlan, "run_plan_bound", oneBlockDocument(), "fixture.docx");
      assertEq(changed.slice.done, true);
      assertEq(stub.requests.length, 2, "a changed fallback plan must invalidate the old chunk");
      assert(changed.providerPlanIdentity.includes("reasoning:high"));
    } finally {
      stub.restore();
    }
  });

  test("a missing usage array is terminal current-key corruption, never a silently trusted or re-bought artifact", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = env({
      EVIDENCE: shared,
      EXTRACT_CHUNK_MAX_BLOCKS: "1",
      EXTRACT_CHUNK_CHARS: "10",
      EXTRACT_SWEEP_MAX_CALLS: "0",
    });
    const stub = stubSequence([
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
    ]);
    try {
      await m.passB.runPassB(value, "run_receipt_bound", oneBlockDocument(), "fixture.docx");
      const key = m.keys.k("runs", "run_receipt_bound", "extraction", "pass-b", "chunk-01.json");
      const artifact = await (await shared.get(key)).json();
      assertEq(artifact.providerPlanIdentity, m.deepseek.deepseekPassBIdentity(value));
      assertEq(artifact.usages.length, 1);
      delete artifact.usages;
      await shared.put(key, JSON.stringify(artifact));

      const resumed = await m.passB.runPassB(
        value, "run_receipt_bound", oneBlockDocument(), "fixture.docx",
      );
      assertEq(stub.requests.length, 1, "malformed exact-key authority must not be overwritten or re-bought");
      assertEq(resumed.slice.terminalFailure, true);
      assert(resumed.failedUnits[0].detail.includes("PASS_B_UNIT_ARTIFACT_INVALID"));
    } finally {
      stub.restore();
    }
  });

  test("a failed ordinary pass-B unit retains its exact Pro receipt", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = env({
      EVIDENCE: shared,
      EXTRACT_CHUNK_MAX_BLOCKS: "1",
      EXTRACT_CHUNK_CHARS: "10",
      EXTRACT_CHUNK_MAX_ISSUES: "1",
      EXTRACT_SWEEP_MAX_CALLS: "0",
    });
    const stub = stubSequence([
      (body) => chatResponse(body.model, "", 100, 20),
    ]);
    try {
      const result = await m.passB.runPassB(value, "run_failed_receipts", oneBlockDocument(), "fixture.docx");
      // B4: the walk completes even with terminal failed units. The failed unit's blocks
      // remain unresolved and ride the payload as named limitations.
      assertEq(result.slice.done, true, "B4: the walk completes despite a terminally failed chunk");
      assertEq(result.slice.terminalFailure, true, "terminal failure is accounted rather than retried forever");
      assertEq(result.issuedCalls.length, 1);
      const key = m.keys.k("runs", "run_failed_receipts", "extraction", "pass-b", "chunk-01.json");
      const artifact = await (await shared.get(key)).json();
      assertEq(artifact.status, "failed");
      assertEq(artifact.usages.length, 1);
      assertEq(artifact.usages[0].model, "deepseek-v4-pro");
      assert(artifact.usages.every((row) => row.costUsd > 0),
        "known token usage on failed purchases must persist as nonzero cost");
    } finally {
      stub.restore();
    }
  });

  test("failed Pro receipts survive a later bounded retry instead of disappearing on reclaim", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = env({
      EVIDENCE: shared,
      EXTRACT_CHUNK_MAX_BLOCKS: "1",
      EXTRACT_CHUNK_CHARS: "10",
      EXTRACT_CHUNK_MAX_ISSUES: "2",
      EXTRACT_SWEEP_MAX_CALLS: "0",
    });
    const stub = stubSequence([
      (body) => chatResponse(body.model, "", 100, 20),
      (body) => chatResponse(body.model, "", 300, 60),
    ]);
    try {
      const first = await m.passB.runPassB(value, "run_retry_receipts", oneBlockDocument(), "fixture.docx");
      assertEq(first.slice.done, false);
      assertEq(first.issuedCalls.length, 1);
      const second = await m.passB.runPassB(value, "run_retry_receipts", oneBlockDocument(), "fixture.docx");
      // B4: done=true even with terminal failures (no sweep, no remaining chunks).
      assertEq(second.slice.done, true);
      assertEq(second.slice.terminalFailure, true);
      assertEq(second.issuedCalls.length, 1, "only the new retry purchase is charged this wave");
      assertEq(second.calls.length, 2, "prior receipt remains visible as zero-cost reclaimed provenance");
      assertEq(second.calls.filter((row) => row.costUsd === 0).length, 1);

      const key = m.keys.k("runs", "run_retry_receipts", "extraction", "pass-b", "chunk-01.json");
      const artifact = await (await shared.get(key)).json();
      assertEq(artifact.usages.length, 2, "both waves' Pro receipts survive in the terminal artifact");
      assert(artifact.usages.every((row) => row.costUsd > 0),
        "stored original receipts retain their actual calculated costs");
    } finally {
      stub.restore();
    }
  });

  test("artifact-before-accounting and accounting-before-step-commit both settle exactly once", async () => {
    const m = await mod();
    for (const chargedBeforeResume of [false, true]) {
      const value = env({
        EXTRACT_CHUNK_MAX_BLOCKS: "1",
        EXTRACT_CHUNK_CHARS: "10",
        EXTRACT_SWEEP_MAX_CALLS: "0",
      });
      const runId = m.ids.mintRunId();
      await m.checkpoint.createCheckpoint(
        value,
        m.checkpoint.initialCheckpoint(value, runId, "standard", false),
      );
      const fence = await m.checkpoint.claimOwnership(value, runId, "provider-continuity-test", 1);
      const stub = stubSequence([
        (body) => chatResponse(body.model, passBPayload(body), 100, 50),
      ]);
      try {
        const landed = await m.passB.runPassB(value, runId, oneBlockDocument(), "fixture.docx");
        assertEq(landed.issuedCalls.length, 1);
        assertEq(landed.accountingCalls.length, 1);
        assert(landed.accountingCalls[0].eventId.startsWith("core-model-call/pass-b/"));

        // false: crash after artifact write, before accounting.
        // true: accounting commits, then the Workflow step result is lost.
        if (chargedBeforeResume) await settle(m, value, runId, fence, landed.accountingCalls);

        const resumed = await m.passB.runPassB(value, runId, oneBlockDocument(), "fixture.docx");
        assertEq(stub.requests.length, 1, "restart reclaims the artifact instead of buying again");
        assertEq(resumed.issuedCalls.length, 0);
        assertEq(resumed.accountingCalls.length, 1, "restart re-offers the persisted receipt for settlement");
        await settle(m, value, runId, fence, resumed.accountingCalls);

        const checkpoint = (await m.checkpoint.loadCheckpoint(value, runId)).checkpoint;
        const modelEvents = checkpoint.usage.events.filter((row) => row.kind === "model-call");
        assertEq(checkpoint.usage.modelCalls.used, 1, "the paid call is counted exactly once");
        assertEq(modelEvents.length, 1, "the stable settlement id is stored exactly once");
        assertEq(modelEvents[0].eventId, landed.accountingCalls[0].eventId);
        assert(checkpoint.usage.cost.usedUsd > 0, "the exact paid receipt cannot become zero in either crash window");
      } finally {
        stub.restore();
      }
    }
  });

  test("the pass-B stage settles a pre-existing unaccounted artifact before evaluating it", async () => {
    const m = await mod();
    const value = env({
      EXTRACT_CHUNK_MAX_BLOCKS: "99999",
      EXTRACT_CHUNK_CHARS: "99999999",
      EXTRACT_SWEEP_MAX_CALLS: "0",
    });
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(
      value,
      m.checkpoint.initialCheckpoint(value, runId, "standard", false),
    );
    const fence = await m.checkpoint.claimOwnership(value, runId, "provider-continuity-test", 1);
    const documentKey = m.keys.inputDocumentKey(runId);
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    await value.EVIDENCE.put(documentKey, documentBytes);
    const { doc: document } = await m.extractStage.loadDocument(
      value, documentKey, documentSha256, m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
    );
    const passAHash = await completePassA(m, value, runId, documentKey, documentSha256, fence);
    const stub = stubSequence([
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
    ]);
    try {
      // Simulate a process death after the unit artifact commits but before stage accounting.
      const before = (await m.checkpoint.loadCheckpoint(value, runId)).checkpoint;
      const baselineCalls = before.usage.modelCalls.used;
      assertEq(
        before.usage.events.filter((row) => row.eventId.startsWith(`core-model-call/pass-b/${runId}/`)).length,
        0,
        "canonical Pass A leaves no Pass-B settlement behind",
      );
      const landed = await m.passB.runPassB(value, runId, document, "questionnaire.docx");
      assertEq(landed.slice.done, true);
      assertEq(landed.issuedCalls.length, 1);
      assertEq(
        (await m.checkpoint.loadCheckpoint(value, runId)).checkpoint.usage.modelCalls.used,
        baselineCalls,
        "the landed Pass-B artifact is not charged before the stage resumes",
      );

      const resumed = await m.extractStage.stagePassBSlice(
        value,
        runId,
        documentKey,
        "questionnaire.docx",
        fence,
        async () => {},
        {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
        passAHash,
        documentSha256,
      );
      assertEq(resumed.result.state, "evaluated");
      assertEq(stub.requests.length, 1, "the stage reclaims rather than re-buys the landed unit");
      const checkpoint = (await m.checkpoint.loadCheckpoint(value, runId)).checkpoint;
      assertEq(checkpoint.usage.modelCalls.used, baselineCalls + 1, "stage settled exactly one pre-existing Pass-B receipt");
      assertEq(
        checkpoint.usage.events.filter((row) => row.eventId.startsWith(`core-model-call/pass-b/${runId}/`)).length,
        1,
        "the exact retained Pass-B receipt is settled once",
      );
      assert(checkpoint.usage.cost.usedUsd > 0);
    } finally {
      stub.restore();
    }
  });

  test("replaying a settlement id with different cost facts fails loudly", async () => {
    const m = await mod();
    const value = env();
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(
      value,
      m.checkpoint.initialCheckpoint(value, runId, "standard", false),
    );
    const fence = await m.checkpoint.claimOwnership(value, runId, "provider-continuity-test", 1);
    const eventId = `core-model-call/pass-b/${runId}/C01/issue-1/receipt-1`;
    await m.usage.pushModelUsageStrict(value, runId, fence, [
      m.usage.modelUsage("deepseek-v4-flash", 10, 5, 0.001, eventId),
    ]);
    await assertThrows(
      () => m.usage.pushModelUsageStrict(value, runId, fence, [
        m.usage.modelUsage("deepseek-v4-flash", 10, 5, 0.002, eventId),
      ]),
      "already settled with different",
    );
    const checkpoint = (await m.checkpoint.loadCheckpoint(value, runId)).checkpoint;
    assertEq(checkpoint.usage.modelCalls.used, 1);
    assertEq(checkpoint.usage.cost.usedUsd, 0.001);
  });

  test("a completed pass-B payload is reusable only under its stored continuity identity", async () => {
    const m = await mod();
    const shared = memoryR2();
    const base = env({
      EVIDENCE: shared,
      EXTRACT_CHUNK_MAX_BLOCKS: "99999",
      EXTRACT_CHUNK_CHARS: "99999999",
      EXTRACT_SWEEP_MAX_CALLS: "0",
      EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "999999",
      EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    });
    const runId = m.ids.mintRunId();
    await m.checkpoint.createCheckpoint(base, m.checkpoint.initialCheckpoint(base, runId, "standard", false));
    const fence = await m.checkpoint.claimOwnership(base, runId, "provider-continuity-test", 1);
    const documentKey = m.keys.inputDocumentKey(runId);
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    await shared.put(documentKey, documentBytes);
    const passAHash = await completePassA(m, base, runId, documentKey, documentSha256, fence);
    const purchase = stubSequence([
      (body) => chatResponse(body.model, passBPayload(body), 100, 50),
    ]);
    let completed;
    try {
      completed = await m.extractStage.stagePassBSlice(
        base, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );
      assertEq(completed.result.state, "evaluated", "canonical Pass B completes under the stored plan");
      assertEq(purchase.requests.length, 1, "the canonical completion bought exactly one unit");
    } finally {
      purchase.restore();
    }
    const retainedBody = await (await shared.get(m.keys.extractionPassKey(runId, "b"))).text();

    const replay = stubSequence([]);
    try {
      const same = await m.extractStage.stagePassBSlice(
        base, runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );
      assertEq(same.result.state, "evaluated", "same-plan completed payload is reclaimed");
      assertEq(replay.requests.length, 0, "same-plan completion costs nothing");

      const changed = await m.extractStage.stagePassBSlice(
        { ...base, DEEPSEEK_FALLBACK_REASONING_EFFORT: "high" },
        runId, documentKey, "questionnaire.docx", fence, async () => {}, {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE, passAHash, documentSha256,
      );
      assertEq(changed.result.state, "not-evaluated");
      assertEq(changed.result.reason, "COMPLETION_ARTIFACT_INVALID");
      assertEq(replay.requests.length, 0, "changed-plan occupied authority is refused without a re-buy");
      assertEq(
        await (await shared.get(m.keys.extractionPassKey(runId, "b"))).text(),
        retainedBody,
        "changed-plan refusal does not overwrite completed bytes",
      );
    } finally {
      replay.restore();
    }
  });

  test("contract reuse fingerprint changes with fallback policy and deployed rates are exact", async () => {
    const m = await mod();
    const a = await m.contractReuse.extractionPolicyFingerprint(env());
    const b = await m.contractReuse.extractionPolicyFingerprint(env({ DEEPSEEK_FALLBACK_MODE: "disabled" }));
    const c = await m.contractReuse.extractionPolicyFingerprint(
      env({ DEEPSEEK_FALLBACK_REASONING_EFFORT: "high" }),
    );
    assert(a !== b, "fallback enablement must change cross-run reuse identity");
    assert(a !== c, "fallback reasoning effort must change cross-run reuse identity");

    const exactReleasePolicy = [
      ["DEEPSEEK_MODEL", "deepseek-v4-flash"],
      ["DEEPSEEK_INPUT_USD_PER_MTOK", "0.44"],
      ["DEEPSEEK_OUTPUT_USD_PER_MTOK", "1.32"],
      ["DEEPSEEK_FALLBACK_MODEL", "deepseek-v4-pro"],
      ["DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK", "1.32"],
      ["DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK", "3.96"],
      ["CAP_STANDARD_MAX_USD", "15"],
    ];
    const requireExactReleasePolicy = (source) => {
      for (const [key, expected] of exactReleasePolicy) {
        assert(source.includes(`"${key}": "${expected}"`), `${key} must be pinned to ${expected}`);
      }
    };
    const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    requireExactReleasePolicy(config);

    const hostile = config.replace(
      '"CAP_STANDARD_MAX_USD": "15"',
      '"CAP_STANDARD_MAX_USD": "30"',
    );
    let refusal = "";
    try {
      requireExactReleasePolicy(hostile);
    } catch (error) {
      refusal = String(error);
    }
    assert(
      refusal.includes("CAP_STANDARD_MAX_USD"),
      "negative fixture: a config restoring the legacy thirty-dollar ceiling must fail the release gate",
    );
  });
});

suite("PROVIDER ACTIVATION - Grok 4.5 + Pro, Flash only behind a retained trigger", () => {
  const extractionEnv = (overrides = {}) => env({
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1",
    EXTRACT_CHUNK_MAX_BLOCKS: "99",
    EXTRACT_CHUNK_CHARS: "999999",
    EXTRACT_SWEEP_MAX_CALLS: "0",
    ...overrides,
  });

  test("normal extraction buys exact Grok 4.5 plus Pro and zero Flash requests", async () => {
    const m = await mod();
    const value = extractionEnv();
    const stub = stubSequence([
      (body) => chatResponse(body.model, passAPayload(), 100, 20),
      (body) => chatResponse(body.model, passBPayload(body), 200, 40),
    ]);
    try {
      const passA = await m.passA.runPassA(value, "run_normal_route", oneBlockDocument(), "fixture.docx");
      const passB = await m.passB.runPassB(value, "run_normal_route", oneBlockDocument(), "fixture.docx");
      assertEq(stub.requests.length, 2);
      assertEq(stub.requests[0].body.model, "grok-4.5");
      assertEq(stub.requests[1].body.model, "deepseek-v4-pro");
      assertEq(stub.requests.filter((request) => request.body.model === "deepseek-v4-flash").length, 0);
      assertEq(passA.providerIndependence, "independent");
      assertEq(m.passA.validatePassAProviderState(passA), "independent");
      assertEq(m.passA.validatePassAProviderState({
        ...passA,
        providerIndependence: "reduced-same-provider-fallback",
      }), null, "a stored independence label cannot override its trigger denominator");
      assertEq(passA.routeReceipts[0].selected, "grok-4.5");
      assertEq(passB.model, m.deepseek.deepseekPassBIdentity(value));
      approx(passA.issuedCalls[0].costUsd, 0.00064, "Grok conservative max-tier cost receipt");
      approx(passB.issuedCalls[0].costUsd, 0.0004224, "exact Pro receipt");
    } finally {
      stub.restore();
    }
  });

  test("eligible quota/non-response/invalid-content failures activate exactly Flash", async () => {
    const m = await mod();
    for (const [label, first] of [
      ["quota", () => new Response("quota", { status: 429 })],
      ["balance", () => new Response("balance exhausted", { status: 402 })],
      ["non-response", () => new Response("unavailable", { status: 503 })],
      ["invalid-content", (body) => chatResponse(body.model, "", 10, 5)],
    ]) {
      const value = extractionEnv({ EVIDENCE: memoryR2() });
      const stub = stubSequence([
        first,
        (body) => chatResponse(body.model, passAPayload(), 20, 10),
      ]);
      try {
        const result = await m.passA.runPassA(value, `run_eligible_${label}`, oneBlockDocument(), "fixture.docx");
        assertEq(stub.requests.length, 2, `${label} makes one Grok and one Flash request`);
        assertEq(stub.requests[0].body.model, "grok-4.5");
        assertEq(stub.requests[1].body.model, "deepseek-v4-flash");
        assertEq(result.providerIndependence, "reduced-same-provider-fallback");
        assertEq(m.passA.validatePassAProviderState(result), "reduced-same-provider-fallback");
        assertEq(result.routeReceipts[0].selected, "deepseek-v4-flash");
        assert(result.routeReceipts[0].trigger.grokUsageEventId.startsWith("core-model-call/pass-a/"));
        assertEq(result.issuedCalls.length, 2);
        assertEq(result.issuedCalls[0].provider, "grok");
        assertEq(result.issuedCalls[1].provider, "deepseek");
      } finally {
        stub.restore();
      }
    }
  });

  test("authentication and bad requests fail honestly and make zero Flash requests", async () => {
    const m = await mod();
    for (const status of [400, 401, 403, 422]) {
      const value = extractionEnv({ EVIDENCE: memoryR2() });
      const stub = stubSequence([() => new Response(`fixture ${status}`, { status })]);
      try {
        const result = await m.passA.runPassA(value, `run_ineligible_${status}`, oneBlockDocument(), "fixture.docx");
        assertEq(stub.requests.length, 1, `HTTP ${status} must not activate Flash`);
        assertEq(stub.requests[0].body.model, "grok-4.5");
        assertEq(result.routeReceipts.length, 0);
        assertEq(result.failedUnits.length, 1);
        const key = m.keys.k("runs", `run_ineligible_${status}`, "extraction", "pass-a", "window-01.json");
        const artifact = await (await value.EVIDENCE.get(key)).json();
        assertEq(artifact.fallbackTrigger, null);
        assertEq(artifact.usages.length, 1);
      } finally {
        stub.restore();
      }
    }
  });

  test("a missing or mismatched Grok response model cannot authorize Flash", async () => {
    const m = await mod();
    for (const reportedModel of [undefined, "grok-4.5-latest", "grok-4.6"]) {
      const value = extractionEnv({ EVIDENCE: memoryR2() });
      const stub = stubSequence([
        () => chatResponse(reportedModel, passAPayload(), 10, 5),
      ]);
      try {
        const result = await m.passA.runPassA(
          value,
          `run_unbound_model_${String(reportedModel)}`,
          oneBlockDocument(),
          "fixture.docx",
        );
        assertEq(stub.requests.length, 1, "an unbound model identity cannot buy Flash");
        assertEq(result.routeReceipts.length, 0);
        assertEq(result.failedUnits.length, 1);
        assertEq(result.issuedCalls[0].usageSource, "unverified-model-rate-ceiling");
        const key = m.keys.k(
          "runs",
          `run_unbound_model_${String(reportedModel)}`,
          "extraction",
          "pass-a",
          "window-01.json",
        );
        const artifact = await (await value.EVIDENCE.get(key)).json();
        assertEq(artifact.failureStage, "provider", "unbound identity remains an honest provider failure");
        assertEq(artifact.terminal, true, "unbound identity cannot leave pending fallback authority");
        assertEq(artifact.fallbackTrigger, null, "unbound identity mints no fallback trigger");
        assertEq(artifact.usages.length, 1, "the paid unbound Grok attempt remains visible exactly once");
        assertEq(artifact.usages[0].provider, "grok");
        assertEq(artifact.usages[0].status, "error");
        assertEq(artifact.usages[0].usageSource, "unverified-model-rate-ceiling");
      } finally {
        stub.restore();
      }
    }
  });

  test("restart after trigger persistence resumes Flash without retrying Grok", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = extractionEnv({
      EVIDENCE: shared,
      EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    });
    const originalPut = shared.put.bind(shared);
    let injectCrash = true;
    shared.put = async (key, body, options) => {
      await originalPut(key, body, options);
      if (injectCrash && String(key).endsWith("pass-a/window-01.json")) {
        const parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
        if (parsed.fallbackTrigger && parsed.usages?.length === 1) {
          injectCrash = false;
          throw new Error("fixture crash after trigger persistence");
        }
      }
    };
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
    try {
      const first = await m.passA.runPassA(value, "run_restart_trigger", oneBlockDocument(), "fixture.docx");
      assertEq(first.failedUnits.length, 1);
      assertEq(stub.requests.length, 1, "the injected crash happens before Flash");
      const resumed = await m.passA.runPassA(value, "run_restart_trigger", oneBlockDocument(), "fixture.docx");
      assertEq(stub.requests.length, 2, "restart buys only the pending Flash request");
      assertEq(stub.requests[0].body.model, "grok-4.5");
      assertEq(stub.requests[1].body.model, "deepseek-v4-flash");
      assertEq(resumed.routeReceipts[0].selected, "deepseek-v4-flash");
      assertEq(resumed.accountingCalls.length, 2);
      assertEq(new Set(resumed.accountingCalls.map((row) => row.eventId)).size, 2);
      const key = m.keys.k("runs", "run_restart_trigger", "extraction", "pass-a", "window-01.json");
      const artifact = await (await shared.get(key)).json();
      assertEq(artifact.usages[0].eventId.includes("issue-1/receipt-1"), true);
      assertEq(artifact.usages[1].eventId.includes("issue-1/receipt-2"), true);
    } finally {
      stub.restore();
    }
  });

  test("Grok 4.5 rate/model attestation fails before any request", async () => {
    const m = await mod();
    const alias = "grok-4.5-latest";
    const ownerReceipt = m.grok.grokRateReceiptCanonicalText(extractionEnv());
    const aliasReceipt = ownerReceipt.replace('"model":"grok-4.5"', '"model":"grok-4.5-latest"');
    assert(aliasReceipt !== ownerReceipt, "alias fixture must alter canonical model identity");
    const aliasDigest = createHash("sha256").update(aliasReceipt, "utf8").digest("hex");
    for (const override of [
      { GROK_RATE_ATTESTED_MODEL: "grok-4.6" },
      { GROK_RATE_ATTESTED_AT: "" },
      { GROK_INPUT_USD_PER_MTOK: undefined },
      {
        GROK_MODEL: alias,
        GROK_RATE_ATTESTED_MODEL: alias,
        GROK_RATE_RECEIPT_SHA256: aliasDigest,
      },
    ]) {
      const stub = stubSequence([]);
      try {
        await assertThrows(
          () => m.grok.grokSpec(extractionEnv(override)),
        );
        assertEq(stub.requests.length, 0);
      } finally {
        stub.restore();
      }
    }
  });

  test("an unattested Grok rate is a named stage refusal with zero requests", async () => {
    const m = await mod();
    const value = extractionEnv({
      GROK_RATE_ATTESTED_MODEL: undefined,
      GROK_RATE_ATTESTED_AT: undefined,
      GROK_INPUT_USD_PER_MTOK: undefined,
      GROK_OUTPUT_USD_PER_MTOK: undefined,
    });
    const runId = "run_unattested_rate";
    const documentKey = m.keys.inputDocumentKey(runId);
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    await value.EVIDENCE.put(documentKey, documentBytes);
    const stub = stubSequence([]);
    try {
      const outcome = await m.extractStage.stagePassASlice(
        value,
        runId,
        documentKey,
        "questionnaire.docx",
        { instanceId: "fixture", epoch: 1 },
        async () => {},
        {},
        m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
        documentSha256,
      );
      assertEq(outcome.result.state, "not-evaluated");
      assertEq(outcome.result.reason, "GROK_RATE_UNATTESTED");
      assert(outcome.result.detail.includes("No Grok request was issued"));
      assertEq(stub.requests.length, 0);
    } finally {
      stub.restore();
    }
  });

  test("a summary-only Flash plus Pro payload is immutable invalid authority", async () => {
    const m = await mod();
    const value = extractionEnv();
    const runId = "run_reduced_independence";
    const documentKey = m.keys.inputDocumentKey(runId);
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    await value.EVIDENCE.put(documentKey, documentBytes);
    const { doc: document } = await m.extractStage.loadDocument(
      value, documentKey, documentSha256, m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
    );
    const grokEventId = `core-model-call/pass-a/${runId}/A/issue-1/receipt-1`;
    const trigger = {
      kind: m.passA.GROK_FALLBACK_TRIGGER_VERSION,
      failureKind: "rate-limited",
      httpStatus: 429,
      grokModel: "grok-4.5",
      grokUsageEventId: grokEventId,
      detail: "fixture quota trigger",
    };
    const calls = [
      {
        eventId: grokEventId, callId: "call_a_1", role: "extract-pass-a", provider: "grok",
        model: "grok-4.5", status: "error", inputTokens: 10, outputTokens: 10,
        costUsd: 0.00018, latencyMs: 0, attempts: 1, usageSource: "conservative-ceiling",
      },
      {
        eventId: `core-model-call/pass-a/${runId}/A/issue-1/receipt-2`,
        callId: "call_a_1:grok-fallback", role: "extract-pass-a", provider: "deepseek",
        model: "deepseek-v4-flash", status: "ok", inputTokens: 10, outputTokens: 5,
        costUsd: 0.0000028, latencyMs: 1, attempts: 1, usageSource: "provider-reported",
      },
    ];
    const passABody = JSON.stringify({
      parserVersion: document.parserVersion,
      promptVersion: m.passA.PASS_A_VERSION,
      providerRouteIdentity: m.grok.grokFlashRouteIdentity(value),
      providerIndependence: "reduced-same-provider-fallback",
      pass: "A",
      provider: "grok-primary/deepseek-flash-fallback",
      model: "grok-4.5",
      requirements: [], ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
      failedUnits: [], calls, crossRefs: [],
      routeReceipts: [{ selected: "deepseek-v4-flash", trigger }],
      fallbackTriggers: [trigger],
    });
    await value.EVIDENCE.put(m.keys.extractionPassKey(runId, "a"), passABody);
    await value.EVIDENCE.put(m.keys.extractionPassKey(runId, "b"), JSON.stringify({
      parserVersion: document.parserVersion,
      promptVersion: m.passB.PASS_B_VERSION,
      providerPlanIdentity: m.deepseek.deepseekPassBIdentity(value),
      pass: "B",
      provider: "deepseek",
      model: m.deepseek.deepseekPassBIdentity(value),
      requirements: [], ambiguities: [], unverifiable: [], dispositions: [], constructs: [],
      failedUnits: [], calls: [],
    }));
    const result = await m.extractStage.stageConsolidate(
      value,
      runId,
      documentKey,
      documentSha256,
      "en",
      ["desktop"],
      m.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      "questionnaire.docx",
      `sha256:${await m.hash.sha256Hex(passABody)}`,
      `sha256:${"0".repeat(64)}`,
    );
    assertEq(result.state, "not-evaluated");
    assertEq(result.reason, "COMPLETION_ARTIFACT_INVALID");
    assert(result.detail.includes("PASS_A_COMPLETED_ARTIFACT_INVALID"));
  });
});
