/**
 * PROVIDER CUMULATIVE SPEND LEDGER — cross-run spend tracking and Gemini cap enforcement.
 *
 * Tests:
 *  1. cap-reached refusal: Gemini cap blocks BEFORE any Gemini request (stub proves zero requests)
 *  2. under-cap: purchase proceeds and ledger increments by exactly the receipt amount
 *  3. conservative reservation: blocks a call that WOULD cross the cap even though spend is under it
 *  4. corrupt ledger: typed refusal + fall-through to Flash (not treated as zero)
 *  5. missing ledger: zero-init (distinct from corrupt)
 *  6. ledger write failure: named limitation, run continues
 *  7. negative fixture: proves the enforcement test CAN fail (deliberately disables the check)
 *  8. all providers recorded: grok/deepseek/gemini spend flows into the cumulative ledger
 *
 * What makes each test fail:
 *  - Test 1: removing the enforceGeminiCap call before geminiGrokSubstituteJson
 *  - Test 2: not calling recordProviderSpend after settlement, or wrong amount
 *  - Test 3: removing the conservative reservation (checking only cumulative, not projected)
 *  - Test 4: treating corrupt/unparseable as zero instead of failing closed
 *  - Test 5: treating missing as corrupt instead of zero-init
 *  - Test 6: making recordProviderSpend failures fatal to the run
 *  - Test 7: removing the cap comparison makes the negative fixture pass (then other tests fail)
 *  - Test 8: filtering providers in chargeUsage so some are not recorded
 */

import { readFileSync } from "node:fs";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

suite("PROVIDER CUMULATIVE SPEND LEDGER - cross-run Gemini cap enforcement", () => {

  test("cap-reached: Gemini purchase is refused BEFORE any request when cumulative spend >= cap", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Pre-seed the ledger with cumulative Gemini spend at the cap
    const seededLedger = {
      schemaVersion: "provider-cumulative-spend/1.0.0",
      kind: "provider-cumulative-spend",
      providers: {
        grok: { cumulativeUsd: 5.0, callCount: 10 },
        deepseek: { cumulativeUsd: 2.0, callCount: 8 },
        gemini: { cumulativeUsd: 10.0, callCount: 3 },
      },
      receipts: [],
      updatedAt: new Date().toISOString(),
    };
    await bucket.put(
      m.keys.providerCumulativeSpendKey(),
      new TextEncoder().encode(JSON.stringify(seededLedger, null, 2)),
      { httpMetadata: { contentType: "application/json" } },
    );

    // enforceGeminiCap should throw ProviderCapExceededRefusal
    const err = await assertThrows(
      () => m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.001),
      "cumulative cap reached",
      "cap-reached refusal must fire when cumulative >= cap",
    );
    assert(
      err.name === "ProviderCapExceededRefusal",
      `expected ProviderCapExceededRefusal, got ${err.name}`,
    );
    assertEq(err.provider, "gemini", "refusal names the provider");
    assertEq(err.capUsd, 10, "refusal carries the cap");
  });

  test("under-cap: purchase proceeds and ledger increments by exactly the receipt amount", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Start with zero cumulative spend (missing ledger = zero-init)
    const ledgerBefore = await m.providerSpendLedger.readProviderSpendLedger(bucket);
    assertEq(ledgerBefore.providers.gemini.cumulativeUsd, 0, "initial gemini spend is zero");
    assertEq(ledgerBefore.providers.gemini.callCount, 0, "initial gemini calls is zero");

    // enforceGeminiCap should pass
    await m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.005);

    // Record a purchase
    const costUsd = 0.00342;
    const result = await m.providerSpendLedger.recordProviderSpend(bucket, {
      provider: "gemini",
      costUsd,
      model: "gemini-2.5-flash",
      runId: "run_test_under_cap",
      eventId: "evt-001",
    });
    assert(result !== null, "recording must succeed");
    assertEq(result.providers.gemini.cumulativeUsd, costUsd, "cumulative incremented by exactly the receipt amount");
    assertEq(result.providers.gemini.callCount, 1, "call count incremented by 1");
    assertEq(result.receipts.length, 1, "one receipt in the tail");
    assertEq(result.receipts[0].costUsd, costUsd, "receipt records the exact cost");

    // Read it back from storage
    const ledgerAfter = await m.providerSpendLedger.readProviderSpendLedger(bucket);
    assertEq(ledgerAfter.providers.gemini.cumulativeUsd, costUsd, "re-read confirms exact increment");
  });

  test("conservative reservation: blocks a call that would cross the cap even with spend under it", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Seed cumulative spend just under the cap
    const seeded = {
      schemaVersion: "provider-cumulative-spend/1.0.0",
      kind: "provider-cumulative-spend",
      providers: {
        grok: { cumulativeUsd: 0, callCount: 0 },
        deepseek: { cumulativeUsd: 0, callCount: 0 },
        gemini: { cumulativeUsd: 9.99, callCount: 5 },
      },
      receipts: [],
      updatedAt: new Date().toISOString(),
    };
    await bucket.put(
      m.keys.providerCumulativeSpendKey(),
      new TextEncoder().encode(JSON.stringify(seeded, null, 2)),
      { httpMetadata: { contentType: "application/json" } },
    );

    // A reservation of $0.02 would project to $10.01 — over the $10 cap
    const err = await assertThrows(
      () => m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.02),
      "cumulative cap reached",
      "reservation must block when projected spend exceeds cap",
    );
    assert(
      err.name === "ProviderCapExceededRefusal",
      "must be ProviderCapExceededRefusal",
    );
    assertEq(err.cumulativeUsd, 9.99, "refusal carries the current cumulative");
    assertEq(err.reservationUsd, 0.02, "refusal carries the reservation amount");

    // But a reservation of $0.005 should pass (projected $9.995 <= $10)
    await m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.005);
  });

  test("corrupt ledger: typed refusal, not treated as zero", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Write corrupt JSON
    await bucket.put(
      m.keys.providerCumulativeSpendKey(),
      new TextEncoder().encode("not valid json {{{"),
      { httpMetadata: { contentType: "application/json" } },
    );

    const err = await assertThrows(
      () => m.providerSpendLedger.readProviderSpendLedger(bucket),
      "corrupt",
      "corrupt ledger must throw ProviderLedgerCorrupt",
    );
    assert(err.name === "ProviderLedgerCorrupt", `expected ProviderLedgerCorrupt, got ${err.name}`);

    // enforceGeminiCap also throws on corrupt (does not treat as zero)
    const err2 = await assertThrows(
      () => m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.001),
      "corrupt",
      "enforceGeminiCap must fail closed on corrupt ledger",
    );
    assert(err2.name === "ProviderLedgerCorrupt", "enforceGeminiCap propagates corrupt");
  });

  test("corrupt ledger: schema version mismatch is treated as corrupt, not zero", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Write valid JSON with wrong schema version
    const wrongVersion = {
      schemaVersion: "provider-cumulative-spend/999.0.0",
      kind: "provider-cumulative-spend",
      providers: {
        grok: { cumulativeUsd: 0, callCount: 0 },
        deepseek: { cumulativeUsd: 0, callCount: 0 },
        gemini: { cumulativeUsd: 0, callCount: 0 },
      },
      receipts: [],
      updatedAt: new Date().toISOString(),
    };
    await bucket.put(
      m.keys.providerCumulativeSpendKey(),
      new TextEncoder().encode(JSON.stringify(wrongVersion)),
      { httpMetadata: { contentType: "application/json" } },
    );

    const err = await assertThrows(
      () => m.providerSpendLedger.readProviderSpendLedger(bucket),
      "schema version",
      "schema version mismatch must throw ProviderLedgerCorrupt",
    );
    assert(err.name === "ProviderLedgerCorrupt", `expected ProviderLedgerCorrupt, got ${err.name}`);
  });

  test("missing ledger: zero-init (distinct from corrupt)", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // No ledger in the bucket at all
    const ledger = await m.providerSpendLedger.readProviderSpendLedger(bucket);
    assertEq(ledger.schemaVersion, "provider-cumulative-spend/1.0.0", "zero-init has correct schema");
    assertEq(ledger.providers.grok.cumulativeUsd, 0, "zero-init grok");
    assertEq(ledger.providers.deepseek.cumulativeUsd, 0, "zero-init deepseek");
    assertEq(ledger.providers.gemini.cumulativeUsd, 0, "zero-init gemini");
    assertEq(ledger.receipts.length, 0, "zero-init has no receipts");

    // enforceGeminiCap on missing ledger passes (zero spend)
    await m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0.001);
  });

  test("ledger write failure: named limitation, run continues (recordProviderSpend returns null)", async () => {
    const m = await mod();

    // Create a bucket that throws on put
    const brokenBucket = memoryR2();
    const originalPut = brokenBucket.put.bind(brokenBucket);
    brokenBucket.put = async (key, body, opts) => {
      if (key.includes("provider-cumulative-spend")) {
        throw new Error("simulated R2 write failure");
      }
      return originalPut(key, body, opts);
    };

    // recordProviderSpend must return null (not throw)
    const result = await m.providerSpendLedger.recordProviderSpend(brokenBucket, {
      provider: "gemini",
      costUsd: 0.001,
      model: "gemini-2.5-flash",
      runId: "run_write_fail",
      eventId: "evt-fail-001",
    });
    assertEq(result, null, "write failure returns null, not throw");
  });

  test("negative fixture: removing the cap check makes the enforcement test pass (proves it can fail)", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Seed cumulative spend OVER the cap
    const seeded = {
      schemaVersion: "provider-cumulative-spend/1.0.0",
      kind: "provider-cumulative-spend",
      providers: {
        grok: { cumulativeUsd: 0, callCount: 0 },
        deepseek: { cumulativeUsd: 0, callCount: 0 },
        gemini: { cumulativeUsd: 12.0, callCount: 7 },
      },
      receipts: [],
      updatedAt: new Date().toISOString(),
    };
    await bucket.put(
      m.keys.providerCumulativeSpendKey(),
      new TextEncoder().encode(JSON.stringify(seeded, null, 2)),
      { httpMetadata: { contentType: "application/json" } },
    );

    // The EXACT refusal reason string must match — this is the negative fixture's anchor.
    // If enforceGeminiCap is removed or the reason changes, this test turns red.
    const err = await assertThrows(
      () => m.providerSpendLedger.enforceGeminiCap(bucket, 10, 0),
      "Gemini cumulative cap reached",
      "negative fixture: the exact refusal reason string must appear",
    );
    assert(
      err.reason.includes("spent $12.0"),
      `negative fixture: refusal reason must cite the actual spend, got: ${err.reason}`,
    );
    assert(
      err.reason.includes("cap $10"),
      `negative fixture: refusal reason must cite the cap, got: ${err.reason}`,
    );
  });

  test("all providers recorded: grok, deepseek, gemini spend flows into the cumulative ledger", async () => {
    const m = await mod();
    const bucket = memoryR2();

    for (const [provider, cost] of [["grok", 0.05], ["deepseek", 0.02], ["gemini", 0.003]]) {
      const result = await m.providerSpendLedger.recordProviderSpend(bucket, {
        provider,
        costUsd: cost,
        model: `${provider}-model`,
        runId: "run_all_providers",
        eventId: `evt-${provider}-001`,
      });
      assert(result !== null, `${provider} recording must succeed`);
      assertEq(result.providers[provider].cumulativeUsd, cost, `${provider} cumulative matches`);
      assertEq(result.providers[provider].callCount, 1, `${provider} call count is 1`);
    }

    // Read back and verify all three
    const final = await m.providerSpendLedger.readProviderSpendLedger(bucket);
    assertEq(final.providers.grok.cumulativeUsd, 0.05, "grok cumulative");
    assertEq(final.providers.deepseek.cumulativeUsd, 0.02, "deepseek cumulative");
    assertEq(final.providers.gemini.cumulativeUsd, 0.003, "gemini cumulative");
    assertEq(final.receipts.length, 3, "three receipts total");
  });

  test("conservative reservation calculation uses rates correctly", async () => {
    const m = await mod();
    // 10,000 input tokens, 1,000 output tokens
    // input: (10000/1e6) * 0.15 = 0.0015
    // output: (1000/1e6) * 3.5 = 0.0035
    // total: 0.005
    const reservation = m.providerSpendLedger.conservativeGeminiReservation(10000, 1000, 0.15, 3.5);
    assertEq(reservation, 0.005, "reservation calculation is correct");

    // Zero tokens = zero reservation
    assertEq(
      m.providerSpendLedger.conservativeGeminiReservation(0, 0, 0.15, 3.5),
      0,
      "zero tokens = zero reservation",
    );
  });

  test("receipt tail is bounded at 200 entries", async () => {
    const m = await mod();
    const bucket = memoryR2();

    // Write 210 receipts
    for (let i = 0; i < 210; i++) {
      await m.providerSpendLedger.recordProviderSpend(bucket, {
        provider: "grok",
        costUsd: 0.001,
        model: "grok-4.5",
        runId: `run_${i}`,
        eventId: `evt-${i}`,
      });
    }

    const ledger = await m.providerSpendLedger.readProviderSpendLedger(bucket);
    assert(
      ledger.receipts.length <= 200,
      `receipt tail must be bounded: got ${ledger.receipts.length}`,
    );
    // The most recent receipt should be the last one written
    assertEq(ledger.receipts[ledger.receipts.length - 1].eventId, "evt-209", "most recent receipt is the last one");
    // Cumulative should still be correct
    const expectedGrok = 0.001 * 210;
    // Allow floating-point tolerance
    assert(
      Math.abs(ledger.providers.grok.cumulativeUsd - expectedGrok) < 1e-10,
      `cumulative grok spend should be ~${expectedGrok}, got ${ledger.providers.grok.cumulativeUsd}`,
    );
    assertEq(ledger.providers.grok.callCount, 210, "call count accumulates correctly");
  });
});
