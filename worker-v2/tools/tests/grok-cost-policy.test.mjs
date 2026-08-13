/**
 * Grok 4.6 rate binding and flat-ledger ceiling.
 *
 * The production transport has one input/output rate pair, while the reviewed owner
 * dashboard has a higher tier above 200k tokens. The only safe flat policy is therefore
 * max(base,long) on each charged axis. Missing or internally inconsistent evidence must
 * stop before Secrets Store get() and before fetch.
 *
 * Mutation evidence: tools/mutate-grok-cost-policy.mjs.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

function ownerRateEnv(overrides = {}, reads = { secretGets: 0 }) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    CF_AIG_ACCOUNT_ID: "fixture-account",
    CF_AIG_GATEWAY_ID: "fixture-gateway",
    XAI_API_KEY: {
      async get() {
        reads.secretGets += 1;
        return "fixture-xai-key";
      },
    },
    GROK_MODEL: "grok-4.6",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-dashboard-copy",
    GROK_RATE_ATTESTED_MODEL: "grok-4.6",
    GROK_RATE_ATTESTED_AT: "2026-08-13",
    GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    EXTRACT_MAX_ATTEMPTS: "1",
    ...overrides,
  };
}

const EXACT_RELEASE_GROK_CONFIG = Object.freeze({
  GROK_MODEL: "grok-4.6",
  GROK_REASONING_EFFORT: "high",
  GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
  GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
  GROK_RATE_SOURCE: "owner-dashboard-copy",
  GROK_RATE_ATTESTED_MODEL: "grok-4.6",
  GROK_RATE_ATTESTED_AT: "2026-08-13",
  GROK_RATE_RECEIPT_SHA256: "be9305eacc767d81d123ca1cada22a89ca04f191f9dfe60c925106dfccde57b5",
  GROK_CONTEXT_WINDOW_TOKENS: "500000",
  GROK_INPUT_USD_PER_MTOK: "2",
  GROK_CACHED_INPUT_USD_PER_MTOK: "0.5",
  GROK_OUTPUT_USD_PER_MTOK: "6",
  GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
  GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
  GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1",
  GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
  GROK_MAX_INPUT_USD_PER_MTOK: "4",
  GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
});

function requireExactReleaseGrokConfig(source) {
  const found = new Map();
  for (const line of source.split(String.fromCharCode(10))) {
    const match = line.match(/^[ 	]*"([A-Z][A-Z0-9_]*)"[ 	]*:[ 	]*"([^"]*)"[ 	]*,?([ 	]*[/][/].*)?$/);
    if (match === null) continue;
    const [, key, value] = match;
    if (found.has(key)) throw new Error("duplicate active config field " + key);
    found.set(key, value);
  }
  for (const [key, expected] of Object.entries(EXACT_RELEASE_GROK_CONFIG)) {
    if (!found.has(key)) throw new Error(key + " is not an active config string");
    const actual = found.get(key);
    if (actual !== expected) {
      throw new Error(key + " must equal " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
  }
  return Object.fromEntries(
    Object.keys(EXACT_RELEASE_GROK_CONFIG).map((key) => [key, found.get(key)]),
  );
}

suite("GROK COST POLICY - reviewed tiers and conservative flat ledger", () => {
  test("release config atomically activates the exact owner receipt and 4/12 ceiling", async () => {
    const source = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", source);
    assertEq(parsed.error, undefined, "wrangler.jsonc must remain structurally valid JSONC");
    for (const [key, expected] of Object.entries(EXACT_RELEASE_GROK_CONFIG)) {
      assertEq(parsed.config?.vars?.[key], expected, "structural config value " + key);
    }
    const active = requireExactReleaseGrokConfig(source);
    assertEq(Object.keys(active).length, Object.keys(EXACT_RELEASE_GROK_CONFIG).length);

    const missing = source.replace(
      '    "GROK_RATE_SOURCE": "owner-dashboard-copy",' + String.fromCharCode(10),
      "",
    );
    await assertThrows(
      () => requireExactReleaseGrokConfig(missing),
      "GROK_RATE_SOURCE",
      "negative fixture: deleting one atomic binding must fail",
    );

    const underpriced = source.replace(
      '    "GROK_MAX_INPUT_USD_PER_MTOK": "4",',
      '    "GROK_MAX_INPUT_USD_PER_MTOK": "2",',
    );
    await assertThrows(
      () => requireExactReleaseGrokConfig(underpriced),
      "GROK_MAX_INPUT_USD_PER_MTOK",
      "negative fixture: lowering the flat ceiling must fail",
    );
  });

  test("exact owner dashboard tiers derive and expose the 4/12 max-known ceiling", async () => {
    const m = await mod();
    const reads = { secretGets: 0 };
    const value = ownerRateEnv({}, reads);
    const rate = await m.grok.grokRateAttestation(value);
    assertEq(rate.schema, "survey-qa-grok-rate-binding/1.0.0");
    assertEq(rate.source, "owner-dashboard-copy");
    assertEq(rate.observedAt, "2026-08-13");
    assertEq(rate.contextWindowTokens, 500000);
    assertEq(rate.base.inputUsdPerMTok, 2);
    assertEq(rate.base.cachedInputUsdPerMTok, 0.5);
    assertEq(rate.base.outputUsdPerMTok, 6);
    assertEq(rate.longContext.thresholdTokens, 200000);
    assertEq(rate.longContext.inputUsdPerMTok, 4);
    assertEq(rate.longContext.cachedInputUsdPerMTok, 1);
    assertEq(rate.longContext.outputUsdPerMTok, 12);
    assertEq(rate.inputUsdPerMTok, 4);
    assertEq(rate.outputUsdPerMTok, 12);
    assertEq(reads.secretGets, 0, "pure policy validation must not touch Secrets Store");

    const spec = await m.grok.grokSpec(value);
    assertEq(spec.inputUsdPerMTok, 4);
    assertEq(spec.outputUsdPerMTok, 12);
    assertEq(reads.secretGets, 1, "a valid policy may resolve the key exactly once");
  });

  test("a real chat receipt is charged at 4/12 even below the 200k threshold", async () => {
    const m = await mod();
    const reads = { secretGets: 0 };
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({
        model: "grok-4.6",
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await m.grok.grokJson(ownerRateEnv({}, reads), {
        system: "Return JSON.",
        user: "Return one object.",
        maxTokens: 500,
        maxAttempts: 1,
        role: "grok-cost-policy-fixture",
        callId: "grok_cost_fixture",
      });
      assertEq(requests, 1);
      assertEq(reads.secretGets, 1);
      assertEq(result.usage.costUsd, 0.01);
      assertEq(result.usage.usageSource, "provider-reported");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("missing malformed zero and under-ceiling bindings refuse before key or fetch", async () => {
    const m = await mod();
    const hostile = [
      { GROK_MODEL: "grok-4.5", GROK_RATE_ATTESTED_MODEL: "grok-4.5" },
      { GROK_RATE_BINDING_SCHEMA: undefined },
      { GROK_RATE_POLICY: undefined },
      { GROK_RATE_SOURCE: "dashboard-probably" },
      { GROK_RATE_ATTESTED_AT: "2026-08-13T00:00:00.000Z" },
      { GROK_RATE_RECEIPT_SHA256: "0".repeat(64) },
      { GROK_RATE_RECEIPT_SHA256: "b".repeat(64) },
      { GROK_CONTEXT_WINDOW_TOKENS: "0" },
      { GROK_INPUT_USD_PER_MTOK: "0" },
      { GROK_CACHED_INPUT_USD_PER_MTOK: undefined },
      { GROK_OUTPUT_USD_PER_MTOK: "6.0" },
      { GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "500000" },
      { GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: " 4" },
      { GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0" },
      { GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: undefined },
      { GROK_MAX_INPUT_USD_PER_MTOK: "2" },
      { GROK_MAX_OUTPUT_USD_PER_MTOK: "6" },
      {
        GROK_RATE_SOURCE: "authenticated-xai-catalogue",
        GROK_RATE_ATTESTED_AT: "2026-08-13",
      },
    ];
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("invalid policy reached network");
    };
    try {
      for (const override of hostile) {
        const reads = { secretGets: 0 };
        await assertThrows(() => m.grok.grokSpec(ownerRateEnv(override, reads)));
        assertEq(reads.secretGets, 0, "invalid policy touched Secrets Store: " + JSON.stringify(override));
      }
      assertEq(requests, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a self-consistent receipt digest still cannot understate max base or long tier", async () => {
    const m = await mod();
    const validText = m.grok.grokRateReceiptCanonicalText(ownerRateEnv());
    const validFlat = '"flatLedger":{"policy":"max-known-text-tier/1.0.0","inputText":4,"outputText":12}';
    const underpricedFlat = '"flatLedger":{"policy":"max-known-text-tier/1.0.0","inputText":2,"outputText":12}';
    const underpricedText = validText.replace(validFlat, underpricedFlat);
    assert(underpricedText !== validText, "fixture must alter the canonical flat-ledger tier");
    const reads = { secretGets: 0 };
    const value = ownerRateEnv({
      GROK_MAX_INPUT_USD_PER_MTOK: "2",
      GROK_RATE_RECEIPT_SHA256: createHash("sha256").update(underpricedText, "utf8").digest("hex"),
    }, reads);
    await assertThrows(() => m.grok.grokSpec(value), "maximum known text tier");
    assertEq(reads.secretGets, 0);
  });

  test("authenticated catalogue source requires its own timestamp shape", async () => {
    const m = await mod();
    const value = ownerRateEnv({
      GROK_RATE_SOURCE: "authenticated-xai-catalogue",
      GROK_RATE_ATTESTED_AT: "2026-08-13T00:00:00.000Z",
      GROK_RATE_RECEIPT_SHA256: "b".repeat(64),
    });
    value.GROK_RATE_RECEIPT_SHA256 = createHash("sha256")
      .update(m.grok.grokRateReceiptCanonicalText(value), "utf8")
      .digest("hex");
    const rate = await m.grok.grokRateAttestation(value);
    assertEq(rate.source, "authenticated-xai-catalogue");
    assertEq(rate.observedAt, "2026-08-13T00:00:00.000Z");
  });

  test("integrated pass-A stage rejects bad pricing before Secrets Store and fetch", async () => {
    const m = await mod();
    const reads = { secretGets: 0 };
    const value = ownerRateEnv({ GROK_MAX_INPUT_USD_PER_MTOK: "2" }, reads);
    const runId = "run_grok_cost_gate";
    const documentKey = m.keys.inputDocumentKey(runId);
    const bytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    await value.EVIDENCE.put(documentKey, bytes);
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("invalid stage policy reached network");
    };
    try {
      const outcome = await m.extractStage.stagePassASlice(
        value,
        runId,
        documentKey,
        "questionnaire.docx",
        { instanceId: "fixture", epoch: 1 },
        async () => {},
        {},
      );
      assertEq(outcome.result.state, "not-evaluated");
      assertEq(outcome.result.reason, "GROK_RATE_UNATTESTED");
      assert(outcome.result.detail.includes("No Grok request was issued"));
      assertEq(reads.secretGets, 0);
      assertEq(requests, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("source receipt tiers threshold and max all invalidate route and contract reuse identity", async () => {
    const m = await mod();
    const base = ownerRateEnv();
    const route = m.grok.grokFlashRouteIdentity(base);
    const policy = await m.contractReuse.extractionPolicyFingerprint(base);
    const variants = [
      { GROK_RATE_SOURCE: "authenticated-xai-catalogue" },
      { GROK_RATE_ATTESTED_AT: "2026-08-14" },
      { GROK_RATE_RECEIPT_SHA256: "b".repeat(64) },
      { GROK_CONTEXT_WINDOW_TOKENS: "499999" },
      { GROK_INPUT_USD_PER_MTOK: "3" },
      { GROK_CACHED_INPUT_USD_PER_MTOK: "0.6" },
      { GROK_OUTPUT_USD_PER_MTOK: "7" },
      { GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "199999" },
      { GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "5" },
      { GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "1.1" },
      { GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "13" },
      { GROK_MAX_INPUT_USD_PER_MTOK: "5" },
      { GROK_MAX_OUTPUT_USD_PER_MTOK: "13" },
    ];
    for (const override of variants) {
      const changed = ownerRateEnv(override);
      assert(m.grok.grokFlashRouteIdentity(changed) !== route, "route identity ignored " + Object.keys(override)[0]);
      assert(
        await m.contractReuse.extractionPolicyFingerprint(changed) !== policy,
        "reuse identity ignored " + Object.keys(override)[0],
      );
    }
  });
});
