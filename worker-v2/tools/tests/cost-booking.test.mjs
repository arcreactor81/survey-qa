/**
 * COST BOOKING — replayed units book zero, rejected-before-generation books zero,
 * timeouts keep the conservative ceiling.
 *
 * The measured defect: a fully-cached run re-booked persisted artifacts at their
 * original cost, inflating usedUsd and tripping the extraction budget gate over
 * money nobody spent. A 402 Insufficient Balance rejection (provably zero billing)
 * was booked at the conservative ceiling (32k output tokens at max rates).
 *
 * What each test proves:
 *  1. A replayed usage event carries usageSource "reused-prior-artifact", costUsd 0,
 *     and originalCostUsd preserving the original charge.
 *  2. The budget gate passes a fully-replayed extraction that would previously trip.
 *  3. A 402 books zero with usageSource "rejected-before-generation".
 *  4. A TIMEOUT still books the conservative ceiling (negative control).
 *  5. pushModelUsageStrict accepts replay events over existing live events without
 *     costUsd mismatch.
 *  6. pushModelUsageStrict validates replay events: costUsd must be 0, originalCostUsd
 *     required.
 *
 * Mutation evidence: tools/mutate-grok-cost-policy.mjs (cost-booking mutants appended).
 */

import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

/** Create a fresh run with a checkpoint and ownership fence, ready for usage tests. */
async function setupRun(m, overrides = {}) {
  const bucket = memoryR2();
  const env = { EVIDENCE: bucket, V2_PREFIX: "v2/", CAP_STANDARD_MAX_USD: "30", ...overrides };
  const runId = m.ids.mintRunId();
  const cp = m.checkpoint.initialCheckpoint(env, runId, "standard", false);
  await m.checkpoint.createCheckpoint(env, cp);
  const fence = await m.checkpoint.claimOwnership(env, runId, "inst-1", 1);
  return { bucket, env, runId, fence };
}

suite("COST BOOKING — replay provenance", () => {

  test("replayed usage event has usageSource 'reused-prior-artifact', costUsd 0, originalCostUsd preserved", async () => {
    const m = await mod();
    const { env, runId, fence } = await setupRun(m);

    // Push a live event first
    const liveEvent = m.usage.modelUsage("grok-4.5", 1000, 500, 0.05, "evt-live-1");
    await m.usage.pushModelUsageStrict(env, runId, fence, [liveEvent]);

    // Verify live event was charged
    let loaded = await m.checkpoint.loadCheckpoint(env, runId);
    assertEq(loaded.checkpoint.usage.cost.usedUsd > 0, true, "live event must charge");
    const liveUsd = loaded.checkpoint.usage.cost.usedUsd;

    // Now push a replay event
    const replayEvent = m.usage.modelUsage(
      "grok-4.5", 2000, 1000, 0, "evt-replay-1",
      "reused-prior-artifact", 0.10,
    );
    await m.usage.pushModelUsageStrict(env, runId, fence, [replayEvent]);

    // Verify replay event was added but did NOT increase usedUsd
    loaded = await m.checkpoint.loadCheckpoint(env, runId);
    assertEq(loaded.checkpoint.usage.cost.usedUsd, liveUsd, "replay must not increase usedUsd");
    assertEq(loaded.checkpoint.usage.modelCalls.used, 2, "replay still counts as a model call");

    // Verify the replay event carries provenance
    const replayStored = loaded.checkpoint.usage.events.find(e => e.eventId === "evt-replay-1");
    assert(replayStored, "replay event must be stored");
    assertEq(replayStored.costUsd, 0, "replay costUsd must be 0");
    assertEq(replayStored.usageSource, "reused-prior-artifact", "replay usageSource must be 'reused-prior-artifact'");
    assertEq(replayStored.originalCostUsd, 0.10, "replay originalCostUsd must preserve the original charge");
  });

  test("budget gate passes a fully-replayed extraction", async () => {
    const m = await mod();
    const { env, runId, fence } = await setupRun(m, { CAP_STANDARD_MAX_USD: "10" });

    // Push 5 replay events that would have cost $1 each originally
    const events = Array.from({ length: 5 }, (_, i) =>
      m.usage.modelUsage("grok-4.5", 50000, 30000, 0, `evt-replay-budget-${i}`,
        "reused-prior-artifact", 1.0),
    );
    await m.usage.pushModelUsageStrict(env, runId, fence, events);

    const loaded = await m.checkpoint.loadCheckpoint(env, runId);
    // $5 original cost would exceed extraction fraction ($10 * 0.5 = $5), but replays book $0
    assertEq(loaded.checkpoint.usage.cost.usedUsd, 0, "fully-replayed extraction must have $0 spend");

    // extractionBudgetExceeded should NOT fire
    const exceeded = m.extractStage.extractionBudgetExceeded(
      { EXTRACT_BUDGET_FRACTION: "0.5" },
      loaded.checkpoint.usage.cost.usedUsd,
      loaded.checkpoint.usage.cost.maxUsd,
    );
    assertEq(exceeded, false, "budget gate must pass for fully-replayed extraction");
  });

  test("replay event re-offered over existing live event accepts silently", async () => {
    const m = await mod();
    const { env, runId, fence } = await setupRun(m);

    // Push original live event
    const liveEvent = m.usage.modelUsage("grok-4.5", 1000, 500, 0.05, "evt-dedup-1");
    await m.usage.pushModelUsageStrict(env, runId, fence, [liveEvent]);

    let loaded = await m.checkpoint.loadCheckpoint(env, runId);
    const afterLive = loaded.checkpoint.usage.cost.usedUsd;

    // Re-offer the same eventId as a replay (costUsd: 0, which differs from original 0.05)
    const replayEvent = m.usage.modelUsage(
      "grok-4.5", 1000, 500, 0, "evt-dedup-1",
      "reused-prior-artifact", 0.05,
    );
    // This must NOT throw despite costUsd mismatch, because the replay flag allows it
    await m.usage.pushModelUsageStrict(env, runId, fence, [replayEvent]);

    loaded = await m.checkpoint.loadCheckpoint(env, runId);
    assertEq(loaded.checkpoint.usage.cost.usedUsd, afterLive, "deduped replay must not change usedUsd");
    assertEq(loaded.checkpoint.usage.modelCalls.used, 1, "deduped replay must not increment model calls");
  });

  test("replay event with non-zero costUsd is rejected", async () => {
    const m = await mod();
    const { env, runId, fence } = await setupRun(m);

    const badReplay = {
      kind: "model-call",
      eventId: "evt-bad-replay",
      model: "grok-4.5",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,  // non-zero for a replay -> must be rejected
      at: new Date().toISOString(),
      usageSource: "reused-prior-artifact",
      originalCostUsd: 0.05,
    };
    await assertThrows(
      () => m.usage.pushModelUsageStrict(env, runId, fence, [badReplay]),
      "replay events must book zero",
      "non-zero costUsd replay event must be rejected",
    );
  });
});

suite("COST BOOKING — rejected before generation", () => {

  test("HTTP 402 books zero tokens and cost with usageSource 'rejected-before-generation'", async () => {
    const m = await mod();

    // Stub fetch to return 402
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Insufficient balance" } }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
    try {
      const spec = {
        provider: "deepseek",
        model: "deepseek-chat",
        gatewaySuffix: "",
        directBaseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        inputUsdPerMTok: 2,
        outputUsdPerMTok: 8,
        extraBody: {},
      };
      const env = {
        CF_AIG_ACCOUNT_ID: "",
        CF_AIG_GATEWAY_ID: "",
        ALLOW_DIRECT_LLM_BASE_URL: "true",
        LLM_TIMEOUT_MS: "5000",
      };
      const opts = {
        system: "test", user: "test", maxTokens: 32000,
        role: "test-role", callId: "call_402_test", maxAttempts: 1,
      };

      let caught;
      try {
        await m.chat.chatJson(spec, env, opts);
      } catch (err) {
        caught = err;
      }
      assert(caught, "chatJson must throw on 402");
      assert(caught.usage, "error must carry usage");
      assertEq(caught.usage.inputTokens, 0, "402 must book zero input tokens");
      assertEq(caught.usage.outputTokens, 0, "402 must book zero output tokens");
      assertEq(caught.usage.costUsd, 0, "402 must book zero cost");
      assertEq(caught.usage.usageSource, "rejected-before-generation",
        "402 usageSource must be 'rejected-before-generation'");
      assert(caught.usage.detail.includes("rejected before generation"),
        "402 detail must name the rejection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("TIMEOUT still books the conservative ceiling (negative control)", async () => {
    const m = await mod();

    // Stub fetch to timeout
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      // Wait longer than the timeout to trigger AbortError
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60000);
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal.reason);
          });
        }
      });
      return new Response("", { status: 200 });
    };
    try {
      const spec = {
        provider: "deepseek",
        model: "deepseek-chat",
        gatewaySuffix: "",
        directBaseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        inputUsdPerMTok: 2,
        outputUsdPerMTok: 8,
        extraBody: {},
      };
      const env = {
        CF_AIG_ACCOUNT_ID: "",
        CF_AIG_GATEWAY_ID: "",
        ALLOW_DIRECT_LLM_BASE_URL: "true",
        LLM_TIMEOUT_MS: "100",
      };
      const opts = {
        system: "test", user: "test", maxTokens: 32000,
        role: "test-role", callId: "call_timeout_test", maxAttempts: 1,
        timeoutMs: 100,
      };

      let caught;
      try {
        await m.chat.chatJson(spec, env, opts);
      } catch (err) {
        caught = err;
      }
      assert(caught, "chatJson must throw on timeout");
      assert(caught.usage, "error must carry usage");
      assert(caught.usage.inputTokens > 0, "timeout must book conservative ceiling input tokens (not zero)");
      assert(caught.usage.outputTokens > 0, "timeout must book conservative ceiling output tokens (not zero)");
      assert(caught.usage.costUsd > 0, "timeout must book conservative ceiling cost (not zero)");
      assertEq(caught.usage.usageSource, "conservative-ceiling",
        "timeout usageSource must be 'conservative-ceiling'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP 503 still books the conservative ceiling (negative control, server error)", async () => {
    const m = await mod();

    // A 503 is ambiguous: the server may have started generation before failing.
    // The conservative ceiling must still apply.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Service temporarily unavailable" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    try {
      const spec = {
        provider: "deepseek",
        model: "deepseek-chat",
        gatewaySuffix: "",
        directBaseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        inputUsdPerMTok: 2,
        outputUsdPerMTok: 8,
        extraBody: {},
      };
      const env = {
        CF_AIG_ACCOUNT_ID: "",
        CF_AIG_GATEWAY_ID: "",
        ALLOW_DIRECT_LLM_BASE_URL: "true",
        LLM_TIMEOUT_MS: "5000",
      };
      const opts = {
        system: "test", user: "test", maxTokens: 32000,
        role: "test-role", callId: "call_503_test", maxAttempts: 1,
      };

      let caught;
      try {
        await m.chat.chatJson(spec, env, opts);
      } catch (err) {
        caught = err;
      }
      assert(caught, "chatJson must throw on 503");
      assert(caught.usage, "error must carry usage");
      assert(caught.usage.inputTokens > 0, "503 must book conservative ceiling input tokens (not zero)");
      assert(caught.usage.outputTokens > 0, "503 must book conservative ceiling output tokens (not zero)");
      assert(caught.usage.costUsd > 0, "503 must book conservative ceiling cost (not zero)");
      assertEq(caught.usage.usageSource, "conservative-ceiling",
        "503 usageSource must be 'conservative-ceiling'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP 401 also books zero (definitive non-billing)", async () => {
    const m = await mod();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Unauthorized" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    try {
      const spec = {
        provider: "grok",
        model: "grok-4.5",
        gatewaySuffix: "/v1",
        directBaseUrl: "https://api.x.ai/v1",
        apiKey: "test-key",
        inputUsdPerMTok: 4,
        outputUsdPerMTok: 12,
        extraBody: {},
      };
      const env = {
        CF_AIG_ACCOUNT_ID: "",
        CF_AIG_GATEWAY_ID: "",
        ALLOW_DIRECT_LLM_BASE_URL: "true",
        LLM_TIMEOUT_MS: "5000",
      };
      const opts = {
        system: "test", user: "test", maxTokens: 32000,
        role: "test-role", callId: "call_401_test", maxAttempts: 1,
      };

      let caught;
      try {
        await m.chat.chatJson(spec, env, opts);
      } catch (err) {
        caught = err;
      }
      assert(caught, "chatJson must throw on 401");
      assertEq(caught.usage.inputTokens, 0, "401 must book zero input tokens");
      assertEq(caught.usage.outputTokens, 0, "401 must book zero output tokens");
      assertEq(caught.usage.costUsd, 0, "401 must book zero cost");
      assertEq(caught.usage.usageSource, "rejected-before-generation",
        "401 usageSource must be 'rejected-before-generation'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
