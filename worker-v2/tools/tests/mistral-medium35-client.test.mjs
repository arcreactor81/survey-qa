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
const bundleDir = mkdtempSync(path.join(tmpdir(), "mistral-medium35-client-test-"));

await esbuild.build({
  entryPoints: {
    mistral: path.join(WORKER_ROOT, "src/vision/providers/mistral-medium35.ts"),
    schema: path.join(WORKER_ROOT, "src/vision/schema.ts"),
    observe: path.join(WORKER_ROOT, "src/vision/observe.ts"),
  },
  outdir: bundleDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const mistral = await import(pathToFileURL(path.join(bundleDir, "mistral.js")).href);
const schema = await import(pathToFileURL(path.join(bundleDir, "schema.js")).href);
const observe = await import(pathToFileURL(path.join(bundleDir, "observe.js")).href);
const vision = { ...schema, ...observe };

after(() => rmSync(bundleDir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function png(width = 64, height = 48, byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
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
    callId: "mistral-visual-provider-test-call",
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

function chatResponse(overrides = {}) {
  return {
    id: "mistral-request-actual-1",
    object: "chat.completion",
    created: 1_786_294_800,
    model: mistral.MISTRAL_MEDIUM35_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(inventory()),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 54, total_tokens: 375 },
    ...overrides,
  };
}

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    ...init,
    headers,
  });
}

const noSignal = () => new AbortController().signal;

test("Mistral Medium 3.5 model spec seals the pinned provider, model, and transport", async () => {
  const first = await mistral.mistralMedium35ModelSpec();
  const second = await mistral.mistralMedium35ModelSpec();

  assert.deepEqual(first, second);
  assert.equal(first.provider, "mistral-api");
  assert.equal(first.model, "mistral-medium-3-5");
  assert.equal(first.transport, "mistral-chat-completions-v1-direct-fetch");
  assert.match(first.configurationSha256, /^[0-9a-f]{64}$/);
  assert.equal(mistral.MISTRAL_MEDIUM35_CONTEXT_TOKENS, 256_000);
  assert.equal(mistral.MISTRAL_MEDIUM35_MAX_COMPLETION_TOKENS, 2_048);
  assert.equal(mistral.MISTRAL_MEDIUM35_CONFIGURATION.request.structuredOutput.strict, true);
  assert.equal(mistral.MISTRAL_MEDIUM35_CONFIGURATION.request.transportPolicy.attempts, 1);
});

test("direct Mistral sends one private strict-schema visual request and records usage", async () => {
  const calls = [];
  let secretReads = 0;
  const secretValue = "mistral-test-key-never-log";
  const client = new mistral.MistralMedium35VisionClient(
    {
      async get() {
        secretReads++;
        return secretValue;
      },
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(chatResponse());
    },
  );

  assert.equal(secretReads, 0);
  const outcome = await client.observe(await request(), noSignal());

  assert.equal(secretReads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.signal.aborted, false);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${secretValue}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("accept"), "application/json");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "mistral-medium-3-5");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].text, vision.VISUAL_INVENTORY_PROMPT);
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.equal(typeof body.messages[0].content[1].image_url, "string");
  assert.match(body.messages[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "survey_qa_visual_inventory",
      schema: vision.VISUAL_RESPONSE_JSON_SCHEMA,
      strict: true,
    },
  });
  assert.equal(body.max_tokens, 2_048);
  assert.equal(body.n, 1);
  assert.equal(body.random_seed, 0);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.safe_prompt, false);
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  const wire = calls[0].init.body;
  assert.equal(wire.includes(secretValue), false);
  assert.equal(wire.includes("AX_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("DOM_SENTINEL_MUST_NOT_LEAVE"), false);
  assert.equal(wire.includes("EXPECTED_SENTINEL_MUST_NOT_LEAVE"), false);

  assert.deepEqual(outcome.content, inventory());
  assert.deepEqual(outcome.telemetry, {
    callId: "mistral-visual-provider-test-call",
    provider: "mistral-api",
    model: "mistral-medium-3-5",
    providerRequestId: "mistral-request-actual-1",
    gatewayLogId: null,
    inputTokens: 321,
    outputTokens: 54,
    costUsd: null,
    usageSource: "provider-reported",
    attempts: 1,
    latencyMs: outcome.telemetry.latencyMs,
  });
  assert.ok(Number.isFinite(outcome.telemetry.latencyMs));
  assert.ok(outcome.telemetry.latencyMs >= 0);
});

test("reported Mistral model drift remains visible to the observer", async () => {
  const client = new mistral.MistralMedium35VisionClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(chatResponse({ model: "mistral-medium-3-5-silent-alias" })),
  );

  const outcome = await client.observe(await request(), noSignal());
  assert.equal(outcome.telemetry.model, "mistral-medium-3-5-silent-alias");
});

test("adjustable reasoning chunks are discarded while final schema text remains evidence", async () => {
  const answer = JSON.stringify(inventory());
  const client = new mistral.MistralMedium35VisionClient(
    async () => "mistral-test-key-never-log",
    async () => jsonResponse(chatResponse({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: [{ type: "text", text: "PRIVATE_REASONING_MUST_NOT_BECOME_EVIDENCE" }],
              closed: true,
            },
            { type: "text", text: answer.slice(0, 40) },
            { type: "text", text: answer.slice(40) },
          ],
        },
        finish_reason: "stop",
      }],
    })),
  );

  const outcome = await client.observe(await request(), noSignal());
  assert.deepEqual(outcome.content, inventory());
  assert.equal(JSON.stringify(outcome).includes("PRIVATE_REASONING_MUST_NOT_BECOME_EVIDENCE"), false);
});

test("truncation and mutated usage receipts fail loudly instead of becoming short evidence", async () => {
  const mutations = [
    [
      "truncated completion",
      () => chatResponse({
        choices: [{
          index: 0,
          message: { role: "assistant", content: JSON.stringify(inventory()) },
          finish_reason: "length",
        }],
      }),
      /incomplete or malformed transport response/,
    ],
    [
      "usage total mismatch",
      () => chatResponse({
        usage: { prompt_tokens: 321, completion_tokens: 54, total_tokens: 374 },
      }),
      /malformed usage receipt/,
    ],
    [
      "missing receipt",
      () => {
        const response = chatResponse();
        delete response.usage;
        return response;
      },
      /malformed usage receipt/,
    ],
    [
      "extra choice despite n=1",
      () => {
        const response = chatResponse();
        response.choices.push(structuredClone(response.choices[0]));
        return response;
      },
      /malformed transport response/,
    ],
    [
      "thinking chunk after answer",
      () => chatResponse({
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: JSON.stringify(inventory()) },
              { type: "thinking", thinking: [] },
            ],
          },
          finish_reason: "stop",
        }],
      }),
      /incomplete or malformed transport response/,
    ],
    [
      "unsolicited tool call",
      () => chatResponse({
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(inventory()),
            tool_calls: [],
          },
          finish_reason: "stop",
        }],
      }),
      /incomplete or malformed transport response/,
    ],
  ];

  for (const [name, mutate, expected] of mutations) {
    let fetchCalls = 0;
    const client = new mistral.MistralMedium35VisionClient(
      async () => "mistral-test-key-never-log",
      async () => {
        fetchCalls++;
        return jsonResponse(mutate());
      },
    );
    await assert.rejects(client.observe(await request(), noSignal()), expected, name);
    assert.equal(fetchCalls, 1, name);
  }
});

test("provider failures and malformed envelopes are bounded, sanitized, and never retried", async () => {
  const privateText = "PRIVATE_MISTRAL_UPSTREAM_TEXT_MUST_NOT_LEAVE";
  const cases = [
    [
      "non-2xx",
      () => new Response(privateText, {
        status: 429,
        headers: { "content-type": "application/json", "content-length": "9999999" },
      }),
      /HTTP 429/,
    ],
    [
      "malformed JSON",
      () => jsonResponse(`{${privateText}`),
      /malformed response JSON/,
    ],
    [
      "wrong content type",
      () => new Response(privateText, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      /non-JSON transport response/,
    ],
    [
      "oversized success",
      () => new Response(privateText, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2097153" },
      }),
      /response exceeded its byte limit/,
    ],
  ];

  for (const [name, response, expected] of cases) {
    let fetchCalls = 0;
    const client = new mistral.MistralMedium35VisionClient(
      async () => "mistral-test-key-never-log",
      async () => {
        fetchCalls++;
        return response();
      },
    );
    await assert.rejects(client.observe(await request(), noSignal()), (error) => {
      assert.match(error.message, expected, name);
      assert.equal(error.message.includes(privateText), false, name);
      assert.equal("cause" in error, false, name);
      return true;
    });
    assert.equal(fetchCalls, 1, name);
  }
});

test("invalid credentials and request identities stop before a Mistral network attempt", async () => {
  let secretReads = 0;
  let fetchCalls = 0;
  const unavailable = new mistral.MistralMedium35VisionClient(
    {
      async get() {
        secretReads++;
        throw new Error("private secret store failure with mistral key");
      },
    },
    async () => {
      fetchCalls++;
      return jsonResponse(chatResponse());
    },
  );
  await assert.rejects(unavailable.observe(await request(), noSignal()), (error) => {
    assert.equal(error.message, "visual provider credential is unavailable");
    assert.equal(error.message.includes("mistral key"), false);
    return true;
  });
  assert.equal(secretReads, 1);
  assert.equal(fetchCalls, 0);

  secretReads = 0;
  const invalid = new mistral.MistralMedium35VisionClient(
    async () => {
      secretReads++;
      return "mistral-test-key-never-log";
    },
    async () => {
      fetchCalls++;
      return jsonResponse(chatResponse());
    },
  );
  const tampered = await request();
  tampered.screenshot.contentSha256 = "f".repeat(64);
  await assert.rejects(invalid.observe(tampered, noSignal()), /request contract mismatch/);
  assert.equal(secretReads, 0);
  assert.equal(fetchCalls, 0);
});

test("the documented 20 MB image boundary is enforced before secret access or fetch", async () => {
  const bytes = png(64, 48, 20_000_001);
  let secretReads = 0;
  let fetchCalls = 0;
  const client = new mistral.MistralMedium35VisionClient(
    async () => {
      secretReads++;
      return "mistral-test-key-never-log";
    },
    async () => {
      fetchCalls++;
      return jsonResponse(chatResponse());
    },
  );
  const oversized = await request({
    screenshot: {
      bytes,
      contentSha256: sha256(bytes),
      mediaType: "image/png",
      pixelWidth: 64,
      pixelHeight: 48,
    },
  });

  await assert.rejects(client.observe(oversized, noSignal()), /image byte limit/);
  assert.equal(secretReads, 0);
  assert.equal(fetchCalls, 0);
});

test("abort stops the single in-flight Mistral request and remains classifiable", async () => {
  let fetchCalls = 0;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const client = new mistral.MistralMedium35VisionClient(
    async () => "mistral-test-key-never-log",
    (_url, init) => {
      fetchCalls++;
      markFetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("private deadline detail", "AbortError")),
          { once: true },
        );
      });
    },
  );
  const controller = new AbortController();
  const pending = client.observe(await request(), controller.signal);
  await fetchStarted;
  controller.abort(new DOMException("deadline", "AbortError"));

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(fetchCalls, 1);
});
