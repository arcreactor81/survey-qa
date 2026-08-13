/** xAI model-rate attestation: exact source, exact identity, bounded closed receipt. */
import { assertEq, assertThrows, loadWorker, suite, test } from "../testkit.mjs";
import { buildConfig, buildOperatorRequest, collectSanitisedReceipt, emitSanitisedReceiptText, parseSanitisedReceiptText, RATE_ATTESTATION_OPERATOR_METHOD, RATE_ATTESTATION_OPERATOR_PATH } from "../grok-rate-attestation.mjs";
const mod = async () => (await loadWorker()).mod.grokRateAttestation;
const workerMod = async () => (await loadWorker()).mod.grokRateAttestationWorker;
const AT = "2026-08-13T01:02:03.456Z";
const secret = (value = "fixture-key-123") => ({ XAI_API_KEY: { async get() { return value; } } });
function catalogue(overrides = {}) { return { id: "grok-4.6", object: "model", owned_by: "xai", created: 1, fingerprint: "fp_fixture", version: "1.0", aliases: ["grok-4.6-canonical"], input_modalities: ["text", "image"], output_modalities: ["text"], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, prompt_image_token_price: 12500, completion_text_token_price: 25000, prompt_text_token_price_long_context: 25000, cached_prompt_text_token_price_long_context: 0, completion_text_token_price_long_context: 50000, long_context_threshold: 200000, search_price: 0, ...overrides }; }
function responseWithUrl(body, url) { const response = new Response(body, { status: 200, headers: { "content-type": "application/json" } }); Object.defineProperty(response, "url", { value: url }); return response; }
async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function withTimingSafeEqual(run) { const subtle = crypto.subtle, hadOwn = Object.hasOwn(subtle, "timingSafeEqual"), prior = subtle.timingSafeEqual; if (typeof prior !== "function") Object.defineProperty(subtle, "timingSafeEqual", { configurable: true, value: (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]) }); try { return await run(); } finally { if (hadOwn) Object.defineProperty(subtle, "timingSafeEqual", { configurable: true, value: prior }); else delete subtle.timingSafeEqual; } }
suite("GROK RATE ATTESTATION", () => {
  test("fixed exact-model catalogue becomes a sanitised tick-exact receipt", async () => {
    const m = await mod(), receipt = m.parseGrokRateCatalogue(JSON.stringify(catalogue()), AT);
    assertEq(receipt.request.origin, "https://api.x.ai"); assertEq(receipt.request.path, "/v1/language-models/grok-4.6");
    assertEq(receipt.model.id, "grok-4.6"); assertEq(receipt.pricing.base.inputTextUsdPerMtok, "1.25");
    assertEq(receipt.pricing.base.cachedInputTextUsdPerMtok, "0.2"); assertEq(receipt.pricing.longContext.effectiveRates.cachedInputTextUsdPerMtok, "0.2"); assertEq(receipt.pricing.longContext.effectiveRates.outputTextUsdPerMtok, "5"); assertEq(receipt.model.aliases[0], "grok-4.6-canonical");
  });
  test("fixed request has one exact GET, redirect error, and never lets a caller select a model", async () => {
    const m = await mod(), calls = [];
    const receipt = await m.attestGrokRate(secret(), async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(catalogue()), { status: 200, headers: { "content-type": "application/json" } }); }, AT);
    assertEq(calls.length, 1); assertEq(calls[0].url, "https://api.x.ai/v1/language-models/grok-4.6"); assertEq(calls[0].init.method, "GET"); assertEq(calls[0].init.redirect, "error"); assertEq(receipt.model.ownedBy, "xai");
  });
  test("aliases, redirects, unknown keys, duplicate keys, and wrong identity fail closed", async () => {
    const m = await mod();
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue(JSON.stringify(catalogue({ aliases: ["grok-latest", "grok-latest"] })), AT)), "RATE_CATALOGUE_SCHEMA_INVALID");
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue(JSON.stringify(catalogue({ id: "grok-4.5" })), AT)), "RATE_CATALOGUE_IDENTITY_INVALID");
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue(JSON.stringify(catalogue({ unreviewed_price: 1 })), AT)), "RATE_CATALOGUE_SCHEMA_INVALID");
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue('{"id":"grok-4.6","id":"grok-4.6"}', AT)), "RATE_CATALOGUE_JSON_INVALID");
    await assertThrows(() => m.attestGrokRate(secret(), async () => responseWithUrl(JSON.stringify(catalogue()), "https://evil.invalid"), AT), "RATE_CATALOGUE_REDIRECTED");
  });
  test("malformed, noninteger, contradictory, non-JSON, and oversized catalogue responses cannot make a receipt", async () => {
    const m = await mod();
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue(JSON.stringify(catalogue({ prompt_text_token_price: 1.2 })), AT)), "RATE_CATALOGUE_PRICE_INVALID");
    await assertThrows(() => Promise.resolve(m.parseGrokRateCatalogue(JSON.stringify(catalogue({ long_context_threshold: 0 })), AT)), "RATE_CATALOGUE_LONG_CONTEXT_INVALID");
    const fallback = m.parseGrokRateCatalogue(JSON.stringify(catalogue({ prompt_text_token_price_long_context: 0, cached_prompt_text_token_price_long_context: 0, completion_text_token_price_long_context: 0, long_context_threshold: 200000 })), AT); assertEq(fallback.pricing.longContext.effectiveRates.inputTextUsdPerMtok, "1.25"); assertEq(fallback.pricing.longContext.limitation, "LONG_CONTEXT_COSTING_REQUIRED");
    await assertThrows(() => m.attestGrokRate(secret(), async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }), AT), "RATE_CATALOGUE_CONTENT_TYPE_INVALID");
    await assertThrows(() => m.attestGrokRate(secret(), async () => new Response("x".repeat(m.MAX_CATALOGUE_BYTES + 1), { status: 200, headers: { "content-type": "application/json" } }), AT), "RATE_CATALOGUE_BODY_INVALID");
  });
  test("tick conversion stays exact without a floating-price shortcut", async () => { const m = await mod(); assertEq(m.ticksPerTokenToUsdPerMtok(1), "0.0001"); assertEq(m.ticksPerTokenToUsdPerMtok(12500), "1.25"); assertEq(m.ticksPerTokenToUsdPerMtok(25000), "2.5"); });
  test("only the asynchronous Secrets Store binding may authorize the fixed request", async () => { const m = await mod(); await assertThrows(() => m.attestGrokRate({ XAI_API_KEY: "literal-key-rejected" }, async () => { throw new Error("must not fetch"); }, AT), "XAI_KEY_UNAVAILABLE"); await assertThrows(() => m.attestGrokRate({ XAI_API_KEY: { async get() { throw new Error("no"); } } }, async () => { throw new Error("must not fetch"); }, AT), "XAI_KEY_UNAVAILABLE"); });
  test("temporary operator config is v2-only, no-route, no-state, and binds only the existing xAI secret", () => {
    const config = buildConfig("a".repeat(64));
    assertEq(config.name, "survey-qa-v2-rate-attestation"); assertEq(config.workers_dev, false); assertEq(config.preview_urls, false);
    assertEq("routes" in config, false); assertEq("workflows" in config, false); assertEq("r2_buckets" in config, false); assertEq("assets" in config, false);
    assertEq(JSON.stringify(config.secrets_store_secrets), JSON.stringify([{ binding: "XAI_API_KEY", store_id: "55e6ce4174d645cfa68a6c27eef7847f", secret_name: "XAI_API_KEY" }]));
    assertEq(config.observability.enabled, false);
  });
  test("collector and worker share one authenticated bodyless GET protocol", async () => withTimingSafeEqual(async () => {
    const m = await mod(), worker = await workerMod(), token = "operator_token_fixture_abcdefghijklmnopqrstuvwxyz", output = [], calls = [];
    const request = buildOperatorRequest(8797, token);
    assertEq(RATE_ATTESTATION_OPERATOR_METHOD, "GET"); assertEq(RATE_ATTESTATION_OPERATOR_PATH, "/__operator/grok-rate-attestation");
    assertEq(request.method, worker.RATE_ATTESTATION_OPERATOR_METHOD); assertEq(new URL(request.url).pathname, worker.RATE_ATTESTATION_OPERATOR_PATH);
    assertEq(request.body, null); assertEq(request.headers.get("content-length"), null); assertEq(request.headers.get("transfer-encoding"), null);
    const receipt = m.parseGrokRateCatalogue(JSON.stringify(catalogue()), AT);
    const collected = await collectSanitisedReceipt(8797, token, async (operatorRequest) => worker.handleRateAttestationRequest(operatorRequest, { ...secret(), RATE_ATTESTATION_OPERATOR_TOKEN_SHA256: await sha256(token) }, async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(catalogue()), { status: 200, headers: { "content-type": "application/json" } }); }, AT), (chunk) => output.push(chunk));
    assertEq(collected.model.id, receipt.model.id); assertEq(calls.length, 1); assertEq(output.length, 1);
  }));
  test("operator protocol refuses POST, query aliases, wrong auth, body streams, and framing headers before provider access", async () => withTimingSafeEqual(async () => {
    const worker = await workerMod(), token = "operator_token_fixture_abcdefghijklmnopqrstuvwxyz", digest = await sha256(token), env = { ...secret(), RATE_ATTESTATION_OPERATOR_TOKEN_SHA256: digest }; let providerCalls = 0;
    const provider = async () => { providerCalls += 1; return new Response(JSON.stringify(catalogue()), { status: 200, headers: { "content-type": "application/json" } }); };
    const headers = new Headers({ "x-survey-qa-rate-attestation-token": token });
    const rejected = [
      new Request("http://127.0.0.1:8797/__operator/grok-rate-attestation", { method: "POST", headers }),
      new Request("http://127.0.0.1:8797/__operator/grok-rate-attestation?model=grok-4.5", { headers }),
      new Request("http://127.0.0.1:8797/__operator/grok-rate-attestation", { headers: { "x-survey-qa-rate-attestation-token": `${token}x` } }),
    ];
    for (const request of rejected) assertEq((await worker.handleRateAttestationRequest(request, env, provider, AT)).status, 404);
    const raw = (extraHeaders, body) => ({ method: "GET", url: "http://127.0.0.1:8797/__operator/grok-rate-attestation", headers: new Headers({ "x-survey-qa-rate-attestation-token": token, ...extraHeaders }), body });
    for (const request of [raw({}, new ReadableStream()), raw({ "content-length": "0" }, null), raw({ "transfer-encoding": "chunked" }, null)]) {
      const response = await worker.handleRateAttestationRequest(request, env, provider, AT); assertEq(response.status, 400); assertEq(await response.text(), '{"error":"REQUEST_BODY_FORBIDDEN"}');
    }
    assertEq(providerCalls, 0);
    await assertThrows(() => collectSanitisedReceipt(8797, token, async () => new Response('{"error":"REQUEST_BODY_FORBIDDEN"}', { status: 400, headers: { "content-type": "application/json" } }), () => { throw new Error("must not emit"); }), "REQUEST_BODY_FORBIDDEN");
  }));
  test("collector refuses duplicate and unknown nested receipt fields before it can print them", async () => {
    const m = await mod(), receipt = m.parseGrokRateCatalogue(JSON.stringify(catalogue()), AT), text = JSON.stringify(receipt);
    await assertThrows(() => Promise.resolve(parseSanitisedReceiptText(text.replace('{', '{"schemaVersion":"evil",'))), "duplicate JSON keys");
    const unknown = JSON.parse(text); unknown.model.unreviewed = "x";
    await assertThrows(() => Promise.resolve(parseSanitisedReceiptText(JSON.stringify(unknown))), "nested fields are invalid");
  });
  test("collector rejects same-allowed duplicate keys at every receipt nesting level and emits no bytes", async () => {
    const m = await mod(), text = JSON.stringify(m.parseGrokRateCatalogue(JSON.stringify(catalogue()), AT));
    const malicious = [
      text.replace('"request":{"method":"GET"', '"request":{"method":"GET","method":"GET"'),
      text.replace('"model":{"id":"grok-4.6"', '"model":{"id":"grok-4.6","id":"grok-4.6"'),
      text.replace('"pricing":{"unit":"usd-ticks-per-token"', '"pricing":{"unit":"usd-ticks-per-token","unit":"usd-ticks-per-token"'),
      text.replace('"longContext":{"thresholdTokens":', '"longContext":{"thresholdTokens":200000,"thresholdTokens":'),
    ];
    for (const attack of malicious) { const output = []; await assertThrows(() => Promise.resolve(emitSanitisedReceiptText(attack, (chunk) => output.push(chunk))), "duplicate JSON keys"); assertEq(output.length, 0); }
  });
  test("collector refuses altered price, request, pricing unit/search, and long-tier raw facts", async () => {
    const m = await mod(), receipt = m.parseGrokRateCatalogue(JSON.stringify(catalogue()), AT), bad = (change) => { const x = JSON.parse(JSON.stringify(receipt)); change(x); return assertThrows(() => Promise.resolve(parseSanitisedReceiptText(JSON.stringify(x))), "invalid"); };
    await bad((x) => { x.pricing.base.inputTextUsdPerMtok = "0"; });
    await bad((x) => { x.request.method = "POST"; }); await bad((x) => { x.pricing.unit = "usd"; }); await bad((x) => { x.pricing.searchTicksPerSearch = -1; }); await bad((x) => { x.pricing.longContext.rawTextRates.inputTextTicksPerToken = -1; });
  });
});
