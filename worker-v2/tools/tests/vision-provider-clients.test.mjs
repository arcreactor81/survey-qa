import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "vision-provider-clients-test-"));

await esbuild.build({
  entryPoints: {
    providers: path.join(WORKER_ROOT, "src/vision/providers/index.ts"),
    vision: path.join(WORKER_ROOT, "src/vision/index.ts"),
  },
  outdir: bundleDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const providers = await import(pathToFileURL(path.join(bundleDir, "providers.js")).href);
const vision = await import(pathToFileURL(path.join(bundleDir, "vision.js")).href);

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function png(width = 64, height = 48) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

async function request(overrides = {}) {
  const bytes = png();
  return {
    callId: "visual-provider-test-call",
    inferenceCacheKey: `visual-inference/sha256/${"a".repeat(64)}`,
    screenshot: {
      bytes,
      contentSha256: sha256(bytes),
      mediaType: "image/png",
      pixelWidth: 64,
      pixelHeight: 48,
    },
    prompt: {
      version: vision.VISUAL_PROMPT_VERSION,
      sha256: await vision.visualPromptSha256(),
      text: vision.VISUAL_INVENTORY_PROMPT,
    },
    responseSchema: {
      version: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
      sha256: await vision.visualResponseSchemaSha256(),
      jsonSchema: vision.VISUAL_RESPONSE_JSON_SCHEMA,
    },
    // Runtime-only adversarial fields prove adapters construct, rather than spread, payloads.
    accessibility: { sentinel: "AX_SENTINEL_MUST_NOT_LEAVE" },
    dom: { sentinel: "DOM_SENTINEL_MUST_NOT_LEAVE" },
    expectation: "EXPECTED_SENTINEL_MUST_NOT_LEAVE",
    ...overrides,
  };
}

function inventory() {
  return {
    schemaVersion: vision.VISUAL_RESPONSE_SCHEMA_VERSION,
    questionRegions: [],
    optionGroups: [],
    controls: [],
    messages: [],
    visualLimitations: [],
  };
}

function chatResponse(model, content = JSON.stringify(inventory())) {
  return {
    id: "provider-request-actual-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 321, completion_tokens: 54, total_tokens: 375 },
  };
}

function interactionResponse(model, outputText = JSON.stringify(inventory())) {
  return {
    id: "gemini-interaction-actual-1",
    object: "interaction",
    model,
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: outputText }] }],
    usage: { total_input_tokens: 258, total_output_tokens: 23, total_thought_tokens: 49, total_tokens: 330 },
  };
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { ...init, headers });
}

const noSignal = () => new AbortController().signal;

test("provider model specs seal exact transport settings and gateway identity", async () => {
  const workers = await providers.workersAiGemma4ModelSpec();
  const direct = await providers.geminiDirectModelSpec();
  const gatewayA = await providers.cloudflareGatewayGeminiModelSpec("firstgateway");
  const gatewayB = await providers.cloudflareGatewayGeminiModelSpec("secondgateway");

  for (const spec of [workers, direct, gatewayA, gatewayB]) {
    assert.match(spec.configurationSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(workers.model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(direct.model, "gemini-3.6-flash");
  assert.equal(gatewayA.model, "google-ai-studio/gemini-3.6-flash");
  assert.notEqual(workers.configurationSha256, direct.configurationSha256);
  assert.notEqual(direct.configurationSha256, gatewayA.configurationSha256);
  assert.notEqual(gatewayA.configurationSha256, gatewayB.configurationSha256);
  assert.throws(
    () => providers.cloudflareGatewayGeminiConfiguration("../../wrong gateway"),
    /Gateway id is unavailable or malformed/,
  );
});

test("Workers AI Gemma sends one native text-plus-image request and reports only actual usage", async () => {
  const calls = [];
  const ai = {
    aiGatewayLogId: null,
    async run(model, payload, options) {
      calls.push({ model, payload, options });
      return chatResponse(providers.WORKERS_AI_GEMMA4_MODEL);
    },
  };
  const client = new providers.WorkersAiGemma4VisionClient(ai);
  const observedRequest = await request();
  const outcome = await client.observe(observedRequest, noSignal());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, providers.WORKERS_AI_GEMMA4_MODEL);
  assert.equal("gateway" in calls[0].options, false);
  assert.deepEqual(calls[0].options.tags, ["survey-qa:visual"]);
  assert.equal(calls[0].payload.store, false);
  assert.equal(calls[0].payload.stream, false);
  assert.equal(calls[0].payload.n, 1);
  assert.equal(calls[0].payload.max_completion_tokens, 2_048);
  assert.deepEqual(calls[0].payload.chat_template_kwargs, { enable_thinking: false });
  assert.equal("reasoning_effort" in calls[0].payload, false);
  assert.equal("image" in calls[0].payload, false, "Gemma must not receive an undocumented top-level image field");
  assert.deepEqual(calls[0].payload.messages, [{
    role: "user",
    content: [
      { type: "text", text: vision.VISUAL_INVENTORY_PROMPT },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from(observedRequest.screenshot.bytes).toString("base64")}`,
          detail: "high",
        },
      },
    ],
  }], "typed multimodal parts and their text-then-image order are inference identity");
  assert.equal("response_format" in calls[0].payload, false);
  assert.equal("image_url" in calls[0].payload.messages[0], false);
  assert.equal(providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.api, "workers-ai-native-binding");
  assert.equal(
    providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.payloadShape,
    "chat-completions-multimodal-message-content",
  );
  assert.deepEqual(providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.message, {
    role: "user",
    contentPartOrder: ["text", "image_url"],
    image: { field: "image_url.url", mediaType: "image/png", encoding: "data-url", detail: "high" },
  });
  assert.equal(
    providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.structuredOutput.requestResponseFormat,
    false,
  );
  assert.deepEqual(providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.structuredOutput, {
    requestResponseFormat: false,
    mode: "prompted-json",
    validation: "observer-closed-schema",
    acceptedBindingResponse: "chat-completion-object",
    requiredFinishReason: "stop",
    unattributedTextResponse: "reject",
  });
  assert.deepEqual(providers.WORKERS_AI_GEMMA4_CONFIGURATION.request.generation, {
    chatTemplateKwargs: { enableThinking: false },
    maxCompletionTokens: 2_048,
    n: 1,
    seed: 0,
    store: false,
    stream: false,
    temperature: 0,
  });
  const wire = JSON.stringify(calls[0].payload);
  assert.equal(wire.includes("AX_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("DOM_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("EXPECTED_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.deepEqual(outcome.content, inventory());
  assert.equal(outcome.telemetry.model, providers.WORKERS_AI_GEMMA4_MODEL);
  assert.equal(outcome.telemetry.providerRequestId, "provider-request-actual-1");
  assert.equal(outcome.telemetry.inputTokens, 321);
  assert.equal(outcome.telemetry.outputTokens, 54);
  assert.equal(outcome.telemetry.costUsd, null);
  assert.equal(outcome.telemetry.usageSource, "provider-reported");
  assert.equal(outcome.telemetry.attempts, 1);
});

test("Cloudflare keyless Gemini disables Gateway logging/cache/retries in the paid call", async () => {
  const calls = [];
  const ai = {
    aiGatewayLogId: null,
    async run(model, payload, options) {
      calls.push({ model, payload, options });
      return chatResponse(providers.CLOUDFLARE_GATEWAY_GEMINI_MODEL);
    },
  };
  const { client, modelSpec } = await providers.createCloudflareGatewayGeminiProvider(ai, "firstgateway");
  const outcome = await client.observe(await request(), noSignal());

  assert.equal(modelSpec.model, "google-ai-studio/gemini-3.6-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "google-ai-studio/gemini-3.6-flash");
  assert.deepEqual(calls[0].options.gateway, {
    id: "firstgateway",
    collectLog: false,
    retries: { maxAttempts: 1 },
    skipCache: true,
  });
  assert.equal(calls[0].payload.store, false);
  assert.equal(calls[0].payload.response_format.json_schema.strict, true);
  assert.match(calls[0].payload.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  const wire = JSON.stringify(calls[0].payload);
  assert.equal(wire.includes("AX_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("DOM_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("EXPECTED_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.deepEqual(outcome.content, inventory());
  assert.equal(outcome.telemetry.costUsd, null);
  assert.equal(outcome.telemetry.attempts, 1);
});

test("Cloudflare keyless Gemini rejects every non-final or alternate completion surface with safe telemetry", async () => {
  const cases = [
    ["truncated", (response) => { response.choices[0].finish_reason = "length"; }],
    ["content filtered", (response) => { response.choices[0].finish_reason = "content_filter"; }],
    ["multiple choices", (response) => { response.choices.push(structuredClone(response.choices[0])); }],
    ["wrong index", (response) => { response.choices[0].index = 1; }],
    ["wrong role", (response) => { response.choices[0].message.role = "tool"; }],
    ["tool call", (response) => { response.choices[0].message.tool_calls = [{ private: "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE" }]; }],
    ["function call", (response) => { response.choices[0].message.function_call = { private: "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE" }; }],
    ["refusal", (response) => { response.choices[0].message.refusal = "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"; }],
    ["choice text", (response) => { response.choices[0].text = "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"; }],
    ["message audio", (response) => { response.choices[0].message.audio = { transcript: "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE" }; }],
    ["non-null logprobs", (response) => { response.choices[0].logprobs = { content: "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE" }; }],
  ];

  for (const [label, mutate] of cases) {
    let calls = 0;
    const response = chatResponse(
      providers.CLOUDFLARE_GATEWAY_GEMINI_MODEL,
      "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE",
    );
    mutate(response);
    const client = new providers.CloudflareGatewayGeminiVisionClient({
      aiGatewayLogId: null,
      async run() {
        calls += 1;
        return response;
      },
    }, "firstgateway");

    await assert.rejects(client.observe(await request(), noSignal()), (error) => {
      assert.equal(error.name, "VisionProviderUnavailableError", label);
      assert.equal(error.telemetry.callId, "visual-provider-test-call", label);
      assert.equal(error.telemetry.provider, providers.CLOUDFLARE_GATEWAY_GEMINI_PROVIDER, label);
      assert.equal(error.telemetry.model, providers.CLOUDFLARE_GATEWAY_GEMINI_MODEL, label);
      assert.equal(error.telemetry.providerRequestId, "provider-request-actual-1", label);
      assert.equal(error.telemetry.inputTokens, 321, label);
      assert.equal(error.telemetry.outputTokens, 54, label);
      assert.equal(error.telemetry.usageSource, "provider-reported", label);
      assert.equal(error.telemetry.attempts, 1, label);
      assert.equal(error.telemetry.costUsd, null, label);
      assert.equal(Number.isFinite(error.telemetry.latencyMs), true, label);
      assert.equal(`${String(error)}\n${JSON.stringify(error)}`.includes("PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"), false, label);
      assert.equal("cause" in error, false, label);
      return true;
    });
    assert.equal(calls, 1, label);
  }
});

test("Cloudflare keyless Gemini requires a complete internally consistent usage receipt", async () => {
  for (const mutate of [
    (response) => { delete response.usage.total_tokens; },
    (response) => { response.usage.total_tokens += 1; },
    (response) => { response.usage.prompt_tokens = -1; },
  ]) {
    const response = chatResponse(providers.CLOUDFLARE_GATEWAY_GEMINI_MODEL);
    mutate(response);
    const client = new providers.CloudflareGatewayGeminiVisionClient({
      aiGatewayLogId: null,
      async run() { return response; },
    }, "firstgateway");
    await assert.rejects(client.observe(await request(), noSignal()), (error) => {
      assert.equal(error.telemetry.model, providers.CLOUDFLARE_GATEWAY_GEMINI_MODEL);
      assert.equal(error.telemetry.providerRequestId, "provider-request-actual-1");
      assert.equal(error.telemetry.inputTokens, null);
      assert.equal(error.telemetry.outputTokens, null);
      assert.equal(error.telemetry.usageSource, "unavailable");
      return true;
    });
  }
});

test("direct Gemini resolves the injected secret lazily and sends a private v1 Interaction", async () => {
  const calls = [];
  let secretReads = 0;
  const secretValue = "gemini-test-key-never-log";
  const client = new providers.GeminiDirectVisionClient(
    {
      async get() {
        secretReads++;
        return secretValue;
      },
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(interactionResponse(providers.GEMINI_36_FLASH_MODEL));
    },
  );
  assert.equal(secretReads, 0);
  const outcome = await client.observe(await request(), noSignal());

  assert.equal(secretReads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1/interactions");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-goog-api-key"), secretValue);
  assert.equal(headers.has("authorization"), false);
  assert.equal([...headers.keys()].some((name) => name.startsWith("cf-aig-")), false);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gemini-3.6-flash");
  assert.equal(body.store, false);
  assert.equal(body.background, false);
  assert.equal(body.stream, false);
  assert.equal(body.input[0].text, vision.VISUAL_INVENTORY_PROMPT);
  assert.equal(body.input[1].type, "image");
  assert.equal(body.input[1].mime_type, "image/png");
  assert.equal(body.input[1].resolution, "high");
  assert.equal(body.response_format.mime_type, "application/json");
  assert.equal(body.generation_config.thinking_level, "low");
  const wire = calls[0].init.body;
  assert.equal(wire.includes(secretValue), false);
  assert.equal(wire.includes("AX_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("DOM_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("EXPECTED_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.deepEqual(outcome.content, inventory());
  assert.equal(outcome.telemetry.model, "gemini-3.6-flash");
  assert.equal(outcome.telemetry.providerRequestId, "gemini-interaction-actual-1");
  assert.equal(outcome.telemetry.inputTokens, 258);
  assert.equal(outcome.telemetry.outputTokens, 72, "billable output must include generated and thought tokens");
  assert.equal(outcome.telemetry.costUsd, null);
  assert.equal(outcome.telemetry.attempts, 1);
});

test("reported model drift is preserved for the observer instead of being laundered", async () => {
  const workers = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    async run() { return chatResponse("@cf/google/gemma-4-silent-alias"); },
  });
  const gateway = new providers.CloudflareGatewayGeminiVisionClient({
    aiGatewayLogId: null,
    async run() { return chatResponse("google-ai-studio/gemini-3.6-flash-002"); },
  }, "firstgateway");
  const direct = new providers.GeminiDirectVisionClient(
    async () => "gemini-test-key-never-log",
    async () => jsonResponse(interactionResponse("gemini-3.6-flash-002")),
  );

  assert.equal((await workers.observe(await request(), noSignal())).telemetry.model, "@cf/google/gemma-4-silent-alias");
  assert.equal((await gateway.observe(await request(), noSignal())).telemetry.model, "google-ai-studio/gemini-3.6-flash-002");
  assert.equal((await direct.observe(await request(), noSignal())).telemetry.model, "gemini-3.6-flash-002");
});

test("model-authored malformed JSON is returned untouched for observer validation", async () => {
  const workers = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    async run() { return chatResponse(providers.WORKERS_AI_GEMMA4_MODEL, "{not valid json"); },
  });
  const direct = new providers.GeminiDirectVisionClient(
    async () => "gemini-test-key-never-log",
    async () => jsonResponse(interactionResponse(providers.GEMINI_36_FLASH_MODEL, "{not valid json")),
  );
  const workerOutcome = await workers.observe(await request(), noSignal());
  assert.equal(workerOutcome.content, "{not valid json");
  assert.equal(vision.validateModelVisualInventory(workerOutcome.content).ok, false);
  assert.equal((await direct.observe(await request(), noSignal())).content, "{not valid json");
});

test("Workers AI binding failures expose only a closed safe category/code", async () => {
  const cases = [
    ["InferenceUpstreamError", "inference-upstream", "VisionProviderUnavailableError"],
    ["AiInternalError", "ai-internal", "VisionProviderUnavailableError"],
    ["TimeoutError", "binding-timeout", "TimeoutError"],
    ["AbortError", "binding-abort", "AbortError"],
    ["PrivateProviderFailure", "unclassified-binding-failure", "VisionProviderUnavailableError"],
  ];

  for (const [name, expectedCode, expectedPublicName] of cases) {
    let calls = 0;
    const client = new providers.WorkersAiGemma4VisionClient({
      aiGatewayLogId: null,
      async run() {
        calls++;
        const error = new Error("PRIVATE_PROVIDER_MESSAGE_MUST_NOT_LEAVE");
        error.name = name;
        error.privateField = "PRIVATE_PROVIDER_FIELD_MUST_NOT_LEAVE";
        throw error;
      },
    });

    await assert.rejects(client.observe(await request(), noSignal()), (error) => {
      assert.equal(error.name, expectedPublicName);
      assert.equal(error.providerFailureCategory, providers.WORKERS_AI_GEMMA4_FAILURE_CATEGORY);
      assert.equal(error.providerFailureCode, expectedCode);
      assert.equal(error.providerFailurePhase, "binding");
      assert.equal(error.providerCallAttempted, true);
      assert.equal(error.telemetry, null);
      const publicFailure = JSON.stringify({
        name: error.name,
        message: error.message,
        category: error.providerFailureCategory,
        code: error.providerFailureCode,
        phase: error.providerFailurePhase,
        attempted: error.providerCallAttempted,
      });
      assert.equal(publicFailure.includes("PRIVATE_PROVIDER_MESSAGE_MUST_NOT_LEAVE"), false);
      assert.equal(publicFailure.includes("PRIVATE_PROVIDER_FIELD_MUST_NOT_LEAVE"), false);
      assert.equal("cause" in error, false);
      assert.equal("privateField" in error, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Workers AI rejects unattributed, truncated, filtered, tool, and malformed completion responses", async () => {
  const withResponseMutation = (mutate) => {
    const response = chatResponse(providers.WORKERS_AI_GEMMA4_MODEL, "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE");
    mutate(response);
    return response;
  };
  const cases = [
    {
      label: "unattributed top-level string",
      response: "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE",
      expectedCode: "response-unattributed-text",
      expectedTelemetry: false,
    },
    {
      label: "malformed choices envelope",
      response: withResponseMutation((response) => { response.choices = "PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"; }),
      expectedCode: "response-envelope-invalid",
      expectedTelemetry: true,
    },
    {
      label: "throwing response accessor",
      response: withResponseMutation((response) => {
        Object.defineProperty(response, "choices", {
          get() { throw new Error("PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"); },
        });
      }),
      expectedCode: "response-envelope-invalid",
      expectedTelemetry: true,
    },
    {
      label: "null content",
      response: withResponseMutation((response) => { response.choices[0].message.content = null; }),
      expectedCode: "response-content-invalid",
      expectedTelemetry: true,
    },
    {
      label: "truncated completion",
      response: withResponseMutation((response) => { response.choices[0].finish_reason = "length"; }),
      expectedCode: "response-finish-length",
      expectedTelemetry: true,
    },
    {
      label: "content-filtered completion",
      response: withResponseMutation((response) => { response.choices[0].finish_reason = "content_filter"; }),
      expectedCode: "response-finish-content-filter",
      expectedTelemetry: true,
    },
    {
      label: "tool-call completion",
      response: withResponseMutation((response) => { response.choices[0].finish_reason = "tool_calls"; }),
      expectedCode: "response-finish-tool-calls",
      expectedTelemetry: true,
    },
    {
      label: "legacy function-call completion",
      response: withResponseMutation((response) => { response.choices[0].finish_reason = "function_call"; }),
      expectedCode: "response-finish-function-call",
      expectedTelemetry: true,
    },
    {
      label: "unknown finish reason",
      response: withResponseMutation((response) => {
        response.choices[0].finish_reason = "PRIVATE_FINISH_REASON_MUST_NOT_LEAVE";
      }),
      expectedCode: "response-finish-invalid",
      expectedTelemetry: true,
    },
  ];

  for (const fixture of cases) {
    let calls = 0;
    const client = new providers.WorkersAiGemma4VisionClient({
      aiGatewayLogId: null,
      async run() {
        calls++;
        return fixture.response;
      },
    });

    await assert.rejects(client.observe(await request(), noSignal()), (error) => {
      assert.equal(error.providerFailureCategory, providers.WORKERS_AI_GEMMA4_FAILURE_CATEGORY, fixture.label);
      assert.equal(error.providerFailureCode, fixture.expectedCode, fixture.label);
      assert.equal(error.providerFailurePhase, "response", fixture.label);
      assert.equal(error.providerCallAttempted, true, fixture.label);
      if (fixture.expectedTelemetry) {
        assert.equal(error.telemetry.callId, "visual-provider-test-call", fixture.label);
        assert.equal(error.telemetry.provider, providers.WORKERS_AI_GEMMA4_PROVIDER, fixture.label);
        assert.equal(error.telemetry.model, providers.WORKERS_AI_GEMMA4_MODEL, fixture.label);
        assert.equal(error.telemetry.providerRequestId, "provider-request-actual-1", fixture.label);
        assert.equal(error.telemetry.inputTokens, 321, fixture.label);
        assert.equal(error.telemetry.outputTokens, 54, fixture.label);
        assert.equal(error.telemetry.usageSource, "provider-reported", fixture.label);
        assert.equal(error.telemetry.attempts, 1, fixture.label);
        assert.equal(error.telemetry.costUsd, null, fixture.label);
        assert.equal(Number.isFinite(error.telemetry.latencyMs), true, fixture.label);
      } else {
        assert.equal(error.telemetry, null, fixture.label);
      }
      const exposed = `${String(error)}\n${JSON.stringify(error)}`;
      assert.equal(exposed.includes("PRIVATE_MODEL_TEXT_MUST_NOT_LEAVE"), false, fixture.label);
      assert.equal(exposed.includes("PRIVATE_FINISH_REASON_MUST_NOT_LEAVE"), false, fixture.label);
      assert.equal("cause" in error, false, fixture.label);
      return true;
    });
    assert.equal(calls, 1, fixture.label);
  }
});

test("malformed provider envelopes fail closed without exposing provider text", async () => {
  const workers = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    async run() {
      return {
        id: "provider-request-malformed-1",
        model: providers.WORKERS_AI_GEMMA4_MODEL,
        choices: "private-provider-text",
        usage: { prompt_tokens: 321, completion_tokens: 54 },
      };
    },
  });
  const gateway = new providers.CloudflareGatewayGeminiVisionClient({
    aiGatewayLogId: null,
    async run() { return { choices: "private-provider-text" }; },
  }, "firstgateway");
  const direct = new providers.GeminiDirectVisionClient(
    async () => "gemini-test-key-never-log",
    async () => jsonResponse("{private-provider-text"),
  );

  await assert.rejects(workers.observe(await request(), noSignal()), (error) => {
    assert.equal(error.message.includes("private-provider-text"), false);
    assert.equal(JSON.stringify(error).includes("private-provider-text"), false);
    assert.equal(error.providerFailureCode, "response-envelope-invalid");
    assert.equal(error.providerFailurePhase, "response");
    assert.equal(error.providerCallAttempted, true);
    assert.equal(error.telemetry.providerRequestId, "provider-request-malformed-1");
    assert.equal(error.telemetry.inputTokens, 321);
    assert.equal(error.telemetry.outputTokens, 54);
    return true;
  });
  await assert.rejects(gateway.observe(await request(), noSignal()), (error) => {
    assert.equal(error.message.includes("private-provider-text"), false);
    return true;
  });
  await assert.rejects(direct.observe(await request(), noSignal()), (error) => {
    assert.equal(error.message.includes("private-provider-text"), false);
    return true;
  });
});

test("an unavailable Secrets Store value prevents any Gemini network attempt", async () => {
  let fetchCalls = 0;
  const client = new providers.GeminiDirectVisionClient(
    {
      async get() { throw new Error("underlying failure contains gemini-private-key"); },
    },
    async () => {
      fetchCalls++;
      return jsonResponse({});
    },
  );
  await assert.rejects(client.observe(await request(), noSignal()), (error) => {
    assert.equal(error.message, "visual provider credential is unavailable");
    assert.equal(error.message.includes("gemini-private-key"), false);
    return true;
  });
  assert.equal(fetchCalls, 0);
});

test("abort and timeout signals stop after one attempt and remain classifiable", async () => {
  let workerCalls = 0;
  let markWorkerStarted;
  const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
  const workers = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    run(_model, _payload, options) {
      workerCalls++;
      markWorkerStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  const workerController = new AbortController();
  const workerPending = workers.observe(await request(), workerController.signal);
  await workerStarted;
  workerController.abort(new DOMException("deadline", "AbortError"));
  await assert.rejects(workerPending, (error) => error.name === "AbortError");
  assert.equal(workerCalls, 1);

  let fetchCalls = 0;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const direct = new providers.GeminiDirectVisionClient(
    async () => "gemini-test-key-never-log",
    (_url, init) => {
      fetchCalls++;
      markFetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  );
  const directController = new AbortController();
  const directPending = direct.observe(await request(), directController.signal);
  await fetchStarted;
  directController.abort(new DOMException("deadline", "AbortError"));
  await assert.rejects(directPending, (error) => error.name === "AbortError");
  assert.equal(fetchCalls, 1);

  const timeout = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    async run() {
      const error = new Error("provider timeout detail");
      error.name = "TimeoutError";
      throw error;
    },
  });
  await assert.rejects(timeout.observe(await request(), noSignal()), (error) => {
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.message.includes("provider timeout detail"), false);
    assert.equal(error.providerFailureCode, "binding-timeout");
    assert.equal(error.providerFailurePhase, "binding");
    assert.equal(error.providerCallAttempted, true);
    assert.equal(error.telemetry, null);
    return true;
  });
});

test("non-2xx Gemini errors are bounded, sanitized, and never retried", async () => {
  let fetchCalls = 0;
  const client = new providers.GeminiDirectVisionClient(
    async () => "gemini-test-key-never-log",
    async () => {
      fetchCalls++;
      return new Response("PRIVATE_UPSTREAM_ERROR_BODY", {
        status: 429,
        headers: { "content-type": "application/json", "content-length": "9999999" },
      });
    },
  );
  await assert.rejects(client.observe(await request(), noSignal()), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes("PRIVATE_UPSTREAM_ERROR_BODY"), false);
    return true;
  });
  assert.equal(fetchCalls, 1);
});

test("tampered screenshot or schema identity is rejected before a paid call", async () => {
  let calls = 0;
  const client = new providers.WorkersAiGemma4VisionClient({
    aiGatewayLogId: null,
    async run() {
      calls++;
      return chatResponse(providers.WORKERS_AI_GEMMA4_MODEL);
    },
  });
  const tampered = await request();
  tampered.screenshot.contentSha256 = "f".repeat(64);
  await assert.rejects(client.observe(tampered, noSignal()), (error) => {
    assert.equal(error.name, "VisionProviderUnavailableError");
    assert.equal(error.providerFailureCategory, providers.WORKERS_AI_GEMMA4_FAILURE_CATEGORY);
    assert.equal(error.providerFailureCode, "request-contract-invalid");
    assert.equal(error.providerFailurePhase, "preflight");
    assert.equal(error.providerCallAttempted, false);
    assert.equal(error.telemetry, null);
    return true;
  });
  assert.equal(calls, 0);
});
