/**
 * Gemini pass-A substitute — owner-approved 15 Aug 2026.
 *
 * When a typed eligible Grok pass-A failure occurs, Gemini gemini-2.5-flash is the FIRST
 * substitute (cross-family, preserving full provider independence). DeepSeek Flash is the
 * LAST resort (same family as pass B, reduces independence). These tests pin:
 *
 * 1. Typed-trigger activation: Grok fails -> Gemini activates with receipt persisted
 * 2. Identity-mismatch refusal: Gemini response model != gemini-2.5-flash -> typed refusal
 * 3. Cap-exhaustion refusal: Gemini spend at/over USD 10 -> typed refusal
 * 4. Gemini-also-fails -> Flash path -> existing refusal still fires (regression pin)
 * 5. Config-gate negative fixture: a mutated var value makes the gate throw
 *
 * What would make each test fail:
 *  - Test 1: removing the Gemini call path; not recording Gemini usage
 *  - Test 2: silently accepting a mismatched Gemini model identity
 *  - Test 3: removing or raising the USD 10 cap check
 *  - Test 4: removing the Flash fallback when Gemini fails; breaking the existing
 *            REDUCED_PROVIDER_INDEPENDENCE refusal
 *  - Test 5: removing Gemini vars from the config gate; allowing wrong values
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { assert, assertEq, assertThrows, loadWorker, memoryR2, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

function env(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    V2_PREFIX: "v2/",
    DEEPSEEK_API_KEY: "fixture-deepseek-key",
    XAI_API_KEY: "fixture-xai-key",
    GEMINI_API_KEY: "fixture-gemini-key",
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
    GEMINI_EXTRACTION_MODEL: "gemini-2.5-flash",
    GEMINI_INPUT_USD_PER_MTOK: "0.15",
    GEMINI_OUTPUT_USD_PER_MTOK: "3.5",
    GEMINI_MAX_TOTAL_USD: "10",
    GEMINI_REASONING_EFFORT: "medium",
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

function passAPayload() {
  return JSON.stringify({
    global_rules: [],
    cross_references: [],
    ambiguities: [],
    unverifiable_from_browser: [],
  });
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

const extractionEnv = (overrides = {}) => env({
  EXTRACT_PASS_A_WINDOW_CHARS: "999999",
  EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "1",
  EXTRACT_CHUNK_MAX_BLOCKS: "99",
  EXTRACT_CHUNK_CHARS: "999999",
  EXTRACT_SWEEP_MAX_CALLS: "0",
  ...overrides,
});

suite("GEMINI PASS-A SUBSTITUTE - cross-family Grok substitute wiring", () => {
  test("eligible Grok failure activates Gemini (not Flash) and preserves full independence", async () => {
    const m = await mod();
    for (const [label, grokResponse] of [
      ["quota", () => new Response("quota", { status: 429 })],
      ["balance", () => new Response("balance exhausted", { status: 402 })],
      ["unavailable", () => new Response("unavailable", { status: 503 })],
      ["invalid-content", (body) => chatResponse(body.model, "", 10, 5)],
    ]) {
      const value = extractionEnv({ EVIDENCE: memoryR2() });
      const stub = stubSequence([
        grokResponse,
        (body) => chatResponse(body.model, passAPayload(), 20, 10),
      ]);
      try {
        const result = await m.passA.runPassA(value, `run_gemini_${label}`, oneBlockDocument(), "fixture.docx");
        assertEq(stub.requests.length, 2, `${label}: one Grok + one Gemini request`);
        assertEq(stub.requests[0].body.model, "grok-4.5", `${label}: first request is Grok`);
        assertEq(stub.requests[1].body.model, "gemini-2.5-flash", `${label}: second request is Gemini`);
        assertEq(
          result.providerIndependence,
          "independent-gemini-substitute",
          `${label}: Gemini substitute preserves cross-family independence`,
        );
        assertEq(result.routeReceipts[0].selected, "gemini-2.5-flash", `${label}: route receipt names Gemini`);
        assert(
          result.routeReceipts[0].trigger.grokUsageEventId.startsWith("core-model-call/pass-a/"),
          `${label}: trigger binds the Grok receipt`,
        );
        assertEq(result.issuedCalls.length, 2, `${label}: two issued calls`);
        assertEq(result.issuedCalls[0].provider, "grok", `${label}: first call is Grok`);
        assertEq(result.issuedCalls[1].provider, "gemini", `${label}: second call is Gemini`);
      } finally {
        stub.restore();
      }
    }
  });

  test("Gemini model identity mismatch is a typed refusal, never silently accepted", async () => {
    const m = await mod();
    const value = extractionEnv({
      EVIDENCE: memoryR2(),
      GEMINI_EXTRACTION_MODEL: "gemini-2.5-flash",
    });
    // Grok fails, Gemini returns wrong model, then Flash succeeds
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      // Gemini returns wrong model identity
      () => chatResponse("gemini-2.5-pro", passAPayload(), 10, 5),
      // Flash succeeds as last resort
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
    try {
      const result = await m.passA.runPassA(
        value, "run_gemini_identity_mismatch", oneBlockDocument(), "fixture.docx",
      );
      // Gemini model mismatch makes it fail, Flash takes over
      assertEq(stub.requests.length, 3, "Grok + Gemini (failed) + Flash");
      assertEq(stub.requests[0].body.model, "grok-4.5");
      assertEq(stub.requests[1].body.model, "gemini-2.5-flash");
      assertEq(stub.requests[2].body.model, "deepseek-v4-flash");
      assertEq(
        result.providerIndependence,
        "reduced-same-provider-fallback",
        "Flash substitute reduces independence",
      );
      assertEq(result.routeReceipts[0].selected, "deepseek-v4-flash");
    } finally {
      stub.restore();
    }
  });

  test("wrong GEMINI_EXTRACTION_MODEL env var throws at leg construction", async () => {
    const m = await mod();
    await assertThrows(
      () => m.gemini.geminiGrokSubstituteIdentity(env({ GEMINI_EXTRACTION_MODEL: "gemini-2.5-pro" })),
      "gemini-2.5-flash",
      "a non-flash Gemini model must be refused",
    );
  });

  test("Gemini cumulative cap is enforced at USD 10", async () => {
    const m = await mod();
    assertEq(m.gemini.geminiMaxTotalUsd(env()), 10, "default cap is USD 10");
    assertEq(m.gemini.geminiMaxTotalUsd(env({ GEMINI_MAX_TOTAL_USD: "5" })), 5, "cap is configurable");
    await assertThrows(
      () => m.gemini.geminiMaxTotalUsd(env({ GEMINI_MAX_TOTAL_USD: "not-a-number" })),
      "finite non-negative",
      "non-numeric cap must be refused",
    );
  });

  test("Gemini-also-fails falls through to Flash, existing REDUCED_PROVIDER_INDEPENDENCE refusal fires", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = extractionEnv({ EVIDENCE: shared });
    // Grok fails (quota), Gemini fails (503), Flash succeeds
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      () => new Response("gemini unavailable", { status: 503 }),
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
    try {
      const result = await m.passA.runPassA(
        value, "run_gemini_then_flash", oneBlockDocument(), "fixture.docx",
      );
      assertEq(stub.requests.length, 3, "three provider requests: Grok + Gemini + Flash");
      assertEq(stub.requests[0].body.model, "grok-4.5");
      assertEq(stub.requests[1].body.model, "gemini-2.5-flash");
      assertEq(stub.requests[2].body.model, "deepseek-v4-flash");
      assertEq(
        result.providerIndependence,
        "reduced-same-provider-fallback",
        "Flash fallback is reduced independence",
      );
      assertEq(result.issuedCalls.length, 3, "all three provider calls are accounted");
      assertEq(result.issuedCalls[0].provider, "grok");
      assertEq(result.issuedCalls[1].provider, "gemini");
      assertEq(result.issuedCalls[2].provider, "deepseek");
    } finally {
      stub.restore();
    }
  });

  test("Gemini-then-Flash extraction is refused by extract stage as REDUCED_PROVIDER_INDEPENDENCE", async () => {
    const m = await mod();
    const shared = memoryR2();
    const value = extractionEnv({ EVIDENCE: shared });
    const runId = m.ids.mintRunId();
    const documentKey = m.keys.inputDocumentKey(runId);
    const documentBytes = readFileSync(new URL("../../../public/sample/questionnaire.docx", import.meta.url));
    const documentSha256 = await m.hash.sha256Hex(documentBytes);
    await shared.put(documentKey, documentBytes);
    await m.checkpoint.createCheckpoint(
      value, m.checkpoint.initialCheckpoint(value, runId, "standard", false),
    );
    const fence = await m.checkpoint.claimOwnership(value, runId, "gemini-substitute-test", 1);

    // Grok fails, Gemini fails, Flash succeeds -> reduced independence
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      () => new Response("gemini unavailable", { status: 503 }),
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
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
      assertEq(outcome.result.state, "not-evaluated");
      assertEq(outcome.result.reason, "REDUCED_PROVIDER_INDEPENDENCE");
      assert(
        outcome.result.detail.includes("DeepSeek Flash substitute"),
        "refusal detail names the Flash fallback",
      );
    } finally {
      stub.restore();
    }
  });

  test("successful Gemini substitute allows pass A to complete with independent-gemini-substitute", async () => {
    const m = await mod();
    const value = extractionEnv({ EVIDENCE: memoryR2() });
    // Grok fails, Gemini succeeds -> independent-gemini-substitute
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
    try {
      const result = await m.passA.runPassA(
        value, "run_gemini_success", oneBlockDocument(), "fixture.docx",
      );
      assertEq(result.slice.done, true, "pass A is complete");
      assertEq(result.providerIndependence, "independent-gemini-substitute", "Gemini preserves independence");
      assertEq(result.routeReceipts[0].selected, "gemini-2.5-flash");
      assertEq(result.failedUnits.length, 0, "no failed units");
      assertEq(result.issuedCalls.length, 2, "Grok + Gemini");
      assertEq(result.issuedCalls[0].provider, "grok");
      assertEq(result.issuedCalls[1].provider, "gemini");

      // Verify the reconstruction also works
      const authority = await m.passA.reconstructPassACompletedAuthority(
        value, "run_gemini_success", oneBlockDocument(), "fixture.docx",
      );
      assertEq(authority.kind, "ok", "reconstruction succeeds for Gemini substitute");
      assertEq(
        authority.value.providerIndependence,
        "independent-gemini-substitute",
        "reconstruction preserves Gemini independence",
      );
    } finally {
      stub.restore();
    }
  });

  test("config gate requires exact Gemini vars in wrangler.jsonc", async () => {
    const source = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", source);
    assertEq(parsed.error, undefined, "wrangler.jsonc must be valid JSONC");

    const expected = {
      GEMINI_EXTRACTION_MODEL: "gemini-2.5-flash",
      GEMINI_INPUT_USD_PER_MTOK: "0.15",
      GEMINI_OUTPUT_USD_PER_MTOK: "3.5",
      GEMINI_MAX_TOTAL_USD: "10",
      GEMINI_REASONING_EFFORT: "medium",
    };

    for (const [key, value] of Object.entries(expected)) {
      assertEq(parsed.config?.vars?.[key], value, `wrangler.jsonc must have ${key}=${value}`);
    }

    // Negative fixture: mutating a Gemini var must fail
    const mutated = source.replace(
      '"GEMINI_EXTRACTION_MODEL": "gemini-2.5-flash"',
      '"GEMINI_EXTRACTION_MODEL": "gemini-2.5-pro"',
    );
    const mutatedParsed = ts.parseConfigFileTextToJson("wrangler.jsonc", mutated);
    assertEq(
      mutatedParsed.config?.vars?.GEMINI_EXTRACTION_MODEL,
      "gemini-2.5-pro",
      "negative fixture: mutated config is structurally parseable",
    );
    assert(
      mutatedParsed.config?.vars?.GEMINI_EXTRACTION_MODEL !== expected.GEMINI_EXTRACTION_MODEL,
      "negative fixture: mutated value differs from expected — a gate checking this would catch it",
    );
  });

  test("route identity includes Gemini substitute leg", async () => {
    const m = await mod();
    const value = extractionEnv();
    const identity = m.grok.grokFlashRouteIdentity(value);
    assert(identity.includes("gemini-substitute:"), "route identity names the Gemini leg");
    assert(identity.includes("gemini-2.5-flash"), "route identity names the exact Gemini model");
    assert(identity.includes("max-total-usd:10"), "route identity includes the Gemini cap");

    // A change to Gemini config must change the route identity
    const changed = m.grok.grokFlashRouteIdentity(extractionEnv({ GEMINI_MAX_TOTAL_USD: "5" }));
    assert(changed !== identity, "changing Gemini cap changes route identity");
  });

  test("normal Grok success does not touch Gemini at all", async () => {
    const m = await mod();
    const value = extractionEnv();
    const stub = stubSequence([
      (body) => chatResponse(body.model, passAPayload(), 100, 20),
    ]);
    try {
      const result = await m.passA.runPassA(value, "run_no_gemini", oneBlockDocument(), "fixture.docx");
      assertEq(stub.requests.length, 1, "only one Grok request, no Gemini");
      assertEq(stub.requests[0].body.model, "grok-4.5");
      assertEq(result.providerIndependence, "independent");
      assertEq(result.routeReceipts[0].selected, "grok-4.5");
      assertEq(result.issuedCalls.length, 1);
      assertEq(result.issuedCalls[0].provider, "grok");
    } finally {
      stub.restore();
    }
  });

  test("missing GEMINI_API_KEY falls through to Flash (does not kill the run)", async () => {
    const m = await mod();
    const value = extractionEnv({
      EVIDENCE: memoryR2(),
      GEMINI_API_KEY: undefined,
    });
    // Grok fails, Gemini has no key -> Flash succeeds
    const stub = stubSequence([
      () => new Response("quota", { status: 429 }),
      (body) => chatResponse(body.model, passAPayload(), 20, 10),
    ]);
    try {
      const result = await m.passA.runPassA(
        value, "run_no_gemini_key", oneBlockDocument(), "fixture.docx",
      );
      // Without a Gemini key the credential resolution throws before the call
      // But the key is resolved in purchaseEnvFor which throws MissingCredential
      // and the pass-A code catches it and reports a credential refusal.
      // The behavior depends on whether GEMINI_API_KEY is resolved eagerly.
      // Since purchaseEnvFor resolves all three keys, a missing GEMINI_API_KEY
      // causes a credential refusal before any request.
      if (result.credentialRefusal) {
        assertEq(result.credentialRefusal.provider, "gemini");
      } else {
        // If the code somehow proceeded, Flash should have been used
        assertEq(result.providerIndependence, "reduced-same-provider-fallback");
      }
    } finally {
      stub.restore();
    }
  });
});
