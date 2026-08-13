import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "openai-cua-test-"));
await esbuild.build({
  entryPoints: { cua: path.join(ROOT, "src/browser/openai-computer-use.ts") },
  outdir: temp,
  bundle: true,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "cua-semantic-mutant",
    setup(build) {
      build.onLoad({ filter: /openai-computer-use\.ts$/ }, async (args) => {
        let source = readFileSync(args.path, "utf8");
        const mutantFile = process.env.MUTANT_FILE?.replaceAll("\\", "/");
        const relative = path.relative(ROOT, args.path).replaceAll("\\", "/");
        if (mutantFile && mutantFile === relative) {
          const find = process.env.MUTANT_FIND ?? "";
          const replace = process.env.MUTANT_REPLACE ?? "";
          const count = source.split(find).length - 1;
          if (!find || count !== 1) throw new Error("mutant patch matched " + count + " times");
          source = source.replace(find, replace);
        }
        return { contents: source, loader: "ts" };
      });
    },
  }],
  target: "node22",
  logLevel: "silent",
});
const cua = await import(pathToFileURL(path.join(temp, "cua.js")).href);

function policy(overrides = {}) {
  return {
    model: "gpt-5.6-luna",
    store: true,
    allowedOrigins: ["http://127.0.0.1:4173"],
    maxTurns: 2,
    maxActions: 8,
    maxWallClockMs: 30_000,
    maxCostUsd: 1,
    maxInputTokensPerTurn: 1_000,
    maxOutputTokensPerTurn: 1_000,
    maxTaskChars: 2_000,
    maxScreenshotBytes: 1_000_000,
    maxScreenshotWidth: 4_000,
    maxScreenshotHeight: 4_000,
    maxTextChars: 1_000,
    maxCoordinate: 4_000,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 6, computerToolCallUsd: 0.01 },
    ...overrides,
  };
}

function harness({ gate = async () => ({ allow: true }), egress = async () => {}, screenshot = new Uint8Array([137, 80, 78, 71]) } = {}) {
  const actions = [];
  const screenshots = [];
  return {
    actions,
    screenshots,
    async currentUrl() { return "http://127.0.0.1:4173/synthetic"; },
    async execute(action) { actions.push(action); },
    async captureScreenshot() { screenshots.push(screenshot); return { bytes: screenshot, width: 2, height: 2 }; },
    async safetyGate(context) { return gate(context); },
    async assertActionAllowed(action) { await egress(action); },
    async acknowledgeSafetyChecks() { return []; },
  };
}

function response(id, output, usage = { input_tokens: 100, output_tokens: 20 }) {
  return new Response(JSON.stringify({ id, model: "gpt-5.6-luna", status: "completed", output, usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("published reference rates are explicit and never substitute for caller policy", () => {
  assert.deepEqual(cua.COMPUTER_USE_MODEL_RATES, {
    "gpt-5.6-luna": { input: 1, output: 6 },
    "gpt-5.6-terra": { input: 2.5, output: 15 },
  });
  assert.notEqual(policy().pricing, cua.COMPUTER_USE_MODEL_RATES["gpt-5.6-luna"]);
});

test("provider credentials can be sent only to the exact official Responses endpoint", () => {
  assert.equal(cua.OPENAI_RESPONSES_ENDPOINT, "https://api.openai.com/v1/responses");
  assert.throws(
    () => new cua.OpenAIComputerUseAdapter({
      apiKey: "test-key-opaque",
      fetchImpl: async () => response("unused", []),
      endpoint: "https://proxy.example.test/v1/responses",
    }),
    /exact official Responses endpoint/,
  );
});

test("Luna mocked loop binds exact response/call ids, executes actions, and hashes the sent screenshot", async () => {
  const requests = [];
  const queue = [
    response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "click", x: 10, y: 20, button: "left", modifiers: [] }] }]),
    response("resp-2", [{ type: "message", content: [{ type: "output_text", text: "done" }] }]),
  ];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return queue.shift();
  };
  const h = harness();
  const adapter = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl });
  const result = await adapter.run("Inspect the local synthetic page.", policy(), h);

  assert.equal(result.status, "completed");
  assert.deepEqual(h.actions, [{ type: "click", x: 10, y: 20, button: "left", modifiers: [] }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "gpt-5.6-luna");
  assert.equal(requests[0].tools[0].type, "computer");
  assert.equal(requests[1].previous_response_id, "resp-1");
  assert.equal(requests[1].input[0].call_id, "call-1");
  assert.equal(requests[1].input[0].output.type, "computer_screenshot");
  assert.equal(requests[1].input[0].output.receipt_id, undefined);
  assert.equal(h.screenshots.length, 2);
  assert.equal(result.screenshotReceipts.length, 2);
  assert.equal(result.usage.computerToolCostUsd, 0.01);
  assert.equal(result.actionReceipts[0].action.textSha256, undefined);
});

test("tool charge is per computer call, not per UI action", async () => {
  const queue = [
    response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "click", x: 1, y: 2, button: "left", modifiers: [] }, { type: "wait" }] }]),
    response("resp-2", []),
  ];
  const h = harness();
  const result = await new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => queue.shift() })
    .run("Do two safe local actions.", policy({ maxCostUsd: 0.6, maxTurns: 2, maxInputTokensPerTurn: 100, maxOutputTokensPerTurn: 100 }), h);
  assert.equal(result.usage.actions, 2);
  assert.equal(result.usage.computerToolCostUsd, 0.01);
});

test("screenshot action captures once and receipts hash the exact sent bytes", async () => {
  const requests = [];
  const queue = [
    response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "screenshot" }] }]),
    response("resp-2", []),
  ];
  const h = harness({ screenshot: new Uint8Array([1, 2, 3]) });
  const result = await new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return queue.shift(); },
  }).run("Capture the local page.", policy(), h);
  assert.equal(h.screenshots.length, 1);
  assert.equal(result.actionReceipts[0].screenshotReceiptId, result.screenshotReceipts[0].id);
  assert.match(requests[1].input[0].output.image_url, /^data:image\/png;base64,AQID$/);
});

test("screenshot actions preserve their exact batch position", async () => {
  const requests = [];
  const queue = [
    response("resp-1", [{
      type: "computer_call",
      status: "completed",
      call_id: "call-1",
      actions: [
        { type: "screenshot" },
        { type: "click", x: 1, y: 2, button: "left", modifiers: [] },
      ],
    }]),
    response("resp-2", []),
  ];
  let state = 1;
  const h = harness();
  h.execute = async (action) => { h.actions.push(action); state = 2; };
  h.captureScreenshot = async () => {
    const shot = new Uint8Array([state]);
    h.screenshots.push(shot);
    return { bytes: shot, width: 1, height: 1 };
  };
  const result = await new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return queue.shift(); },
  }).run("Preserve screenshot ordering.", policy(), h);

  assert.equal(h.screenshots.length, 3);
  assert.equal(result.screenshotReceipts.length, 3);
  assert.equal(result.actionReceipts[0].screenshotReceiptId, result.screenshotReceipts[0].id);
  assert.equal(result.actionReceipts[1].screenshotReceiptId, result.screenshotReceipts[2].id);
  assert.match(requests[1].input[0].output.image_url, /^data:image\/png;base64,Ag==$/);
});

test("missing usage fails closed before any UI actuation", async () => {
  const h = harness();
  const adapter = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "click", x: 1, y: 2, button: "left", modifiers: [] }] }], {}),
  });
  await assert.rejects(() => adapter.run("Do not act without usage.", policy(), h), cua.ComputerUseUsageUnavailableError);
  assert.equal(h.actions.length, 0);
});

test("prompt-injection safety gate denies and records the attempted action", async () => {
  const h = harness({ gate: async () => ({ allow: false, reason: "page-prompt-injection" }) });
  const adapter = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "type", text: "secret" }] }]),
  });
  const result = await adapter.run("Read only.", policy(), h);
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "safety-gate:page-prompt-injection");
  assert.equal(h.actions.length, 0);
  assert.equal(result.actionReceipts[0].approved, false);
});

test("egress gate runs before execution and blocks an unsafe navigation action", async () => {
  const h = harness({ egress: async () => { throw new Error("origin-egress-blocked"); } });
  const adapter = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "click", x: 1, y: 2, button: "left", modifiers: [] }] }]),
  });
  await assert.rejects(() => adapter.run("Stay local.", policy(), h), /origin-egress-blocked/);
  assert.equal(h.actions.length, 0);
});

test("mutation: unsupported action and oversized type are refused", async () => {
  const unsupported = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "right_click", x: 1, y: 2 }] }]),
  });
  await assert.rejects(() => unsupported.run("No unsupported actions.", policy(), harness()), cua.ComputerUseProtocolError);
  const oversized = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "type", text: "123456" }] }]),
  });
  await assert.rejects(() => oversized.run("Bound text.", policy({ maxTextChars: 5 }), harness()), cua.ComputerUsePolicyError);
});

test("mutation: oversized screenshot dimensions are refused", async () => {
  const adapter = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [{ type: "screenshot" }] }]),
  });
  const h = harness();
  h.captureScreenshot = async () => ({ bytes: new Uint8Array([1]), width: 5000, height: 2 });
  await assert.rejects(() => adapter.run("Bound screenshot.", policy(), h), cua.ComputerUsePolicyError);
});

test("official move and exact mouse schema execute while malformed button/modifier is refused", async () => {
  const seen = [];
  const h = harness();
  const adapter = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return seen.length === 1
      ? response("resp-1", [{ type: "computer_call", status: "completed", call_id: "call-1", actions: [
        { type: "move", x: 3, y: 4 }, { type: "click", x: 5, y: 6, button: "right", modifiers: ["shift", "control"] },
      ] }])
      : response("resp-2", []);
  }});
  await adapter.run("Use exact actions.", policy(), h);
  assert.deepEqual(h.actions, [
    { type: "move", x: 3, y: 4 },
    { type: "click", x: 5, y: 6, button: "right", modifiers: ["shift", "control"] },
  ]);
  const malformed = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("bad", [{ type: "computer_call", status: "completed", call_id: "c", actions: [{ type: "click", x: 1, y: 2, button: "middle", modifiers: [] }] }]) });
  await assert.rejects(() => malformed.run("Reject this.", policy(), harness()), cua.ComputerUseProtocolError);
});

test("response and computer-call status are required, and multiple calls fail closed", async () => {
  const noResponseStatus = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => new Response(JSON.stringify({ id: "r", output: [] }), { status: 200 }) });
  await assert.rejects(() => noResponseStatus.run("status", policy(), harness()), cua.ComputerUseProtocolError);
  const noCallStatus = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", [{ type: "computer_call", call_id: "c", actions: [] }]) });
  await assert.rejects(() => noCallStatus.run("status", policy(), harness()), cua.ComputerUseProtocolError);
  const many = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", [
    { type: "computer_call", status: "completed", call_id: "c1", actions: [] },
    { type: "computer_call", status: "completed", call_id: "c2", actions: [] },
  ]) });
  await assert.rejects(() => many.run("one call", policy(), harness()), cua.ComputerUseProtocolError);
});

test("pending safety checks require exact acknowledgement and echo the original check objects", async () => {
  const check = { id: "safety-1", code: "external_side_effect", message: "Confirm" };
  const requests = [];
  const h = harness();
  h.acknowledgeSafetyChecks = async (checks) => { assert.deepEqual(checks, [check]); return ["safety-1"]; };
  const queue = [
    response("r1", [{ type: "computer_call", status: "completed", call_id: "c1", pending_safety_checks: [check], actions: [{ type: "wait" }] }]),
    response("r2", []),
  ];
  const result = await new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async (_u, init) => { requests.push(JSON.parse(init.body)); return queue.shift(); } }).run("ack explicitly", policy(), h);
  assert.deepEqual(requests[1].input[0].acknowledged_safety_checks, [check]);
  assert.equal(result.usage.computerCalls, 1);
  const noAck = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", [{ type: "computer_call", status: "completed", call_id: "c", pending_safety_checks: [check], actions: [{ type: "wait" }] }]) });
  await assert.rejects(() => noAck.run("never auto ack", policy(), harness()), cua.ComputerUseProtocolError);
});

test("batch preflight enforces the full action budget before execution", async () => {
  const h = harness();
  const adapter = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", [{ type: "computer_call", status: "completed", call_id: "c", actions: [{ type: "wait" }, { type: "wait" }] }]) });
  const result = await adapter.run("two actions", policy({ maxActions: 1 }), h);
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "action-budget-exceeded");
  assert.equal(h.actions.length, 0);
});

test("per-turn ceilings and maxTaskChars reject oversized model responses and tasks", async () => {
  const oversizedUsage = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", [], { input_tokens: 101, output_tokens: 1 }) });
  await assert.rejects(() => oversizedUsage.run("small", policy({ maxInputTokensPerTurn: 100 }), harness()), cua.ComputerUseUsageUnavailableError);
  const adapter = new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async () => response("r", []) });
  await assert.rejects(() => adapter.run("123456", policy({ maxTaskChars: 5 }), harness()), cua.ComputerUsePolicyError);
});

test("store:false uses output history and never sends previous_response_id", async () => {
  const requests = [];
  const queue = [
    response("r1", [{ type: "computer_call", status: "completed", call_id: "c1", actions: [{ type: "wait" }] }]),
    response("r2", []),
  ];
  const h = harness();
  await new cua.OpenAIComputerUseAdapter({ apiKey: "test-key-opaque", fetchImpl: async (_u, init) => { requests.push(JSON.parse(init.body)); return queue.shift(); } }).run("private history", policy({ store: false }), h);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].previous_response_id, undefined);
  assert.equal(requests[1].store, false);
  assert.equal(requests[1].previous_response_id, undefined);
  assert.ok(requests[1].input.some((item) => item.type === "computer_call"));
});

test("GA optional mouse fields and drag tuple variants normalize without guessing", async () => {
  const queue = [
    response("r1", [{
      type: "computer_call",
      status: "completed",
      call_id: "c1",
      actions: [
        { type: "click", x: 3, y: 4 },
        { type: "drag", path: [[5, 6], { x: 7, y: 8 }], keys: ["SHIFT"] },
      ],
    }]),
    response("r2", []),
  ];
  const h = harness();
  await new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => queue.shift(),
  }).run("Normalize GA fields.", policy(), h);
  assert.deepEqual(h.actions, [
    { type: "click", x: 3, y: 4, button: "left", modifiers: [] },
    { type: "drag", path: [{ x: 5, y: 6 }, { x: 7, y: 8 }], modifiers: ["shift"] },
  ]);
});

test("store:false replays the original task and every output item, including encrypted reasoning", async () => {
  const requests = [];
  const queue = [
    response("r1", [
      { type: "reasoning", encrypted_content: "opaque-reasoning" },
      { type: "computer_call", status: "completed", call_id: "c1", actions: [{ type: "wait" }] },
    ]),
    response("r2", []),
  ];
  await new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return queue.shift(); },
  }).run("retain this exact task", policy({ store: false }), harness());
  const replay = requests[1].input;
  assert.equal(replay.some((item) => item.role === "user" && item.content.includes("retain this exact task")), true);
  assert.equal(replay.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque-reasoning"), true);
  assert.equal(replay.some((item) => item.type === "computer_call" && item.call_id === "c1"), true);
});

test("each batched action receives a fresh approval screenshot binding", async () => {
  const seen = [];
  const queue = [
    response("r1", [{
      type: "computer_call",
      status: "completed",
      call_id: "c1",
      actions: [{ type: "wait" }, { type: "wait" }],
    }]),
  ];
  const h = harness({
    gate: async (context) => { seen.push(context.screenshotReceiptId); return { allow: seen.length === 1 }; },
  });
  const result = await new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => queue.shift(),
  }).run("stop before stale second action", policy(), h);
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "safety-gate-denied");
  assert.equal(new Set(seen).size, 2);
  assert.equal(h.actions.length, 1);
});

test("mutants: model identity and response envelope bounds fail closed", async () => {
  const mismatch = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => new Response(JSON.stringify({ id: "r", model: "gpt-5.6-terra", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }),
  });
  await assert.rejects(() => mismatch.run("identity", policy(), harness()), cua.ComputerUseProtocolError);
  const oversized = new cua.OpenAIComputerUseAdapter({
    apiKey: "test-key-opaque",
    fetchImpl: async () => response("r", [{ type: "message", content: [{ type: "output_text", text: "too much" }] }]),
  });
  await assert.rejects(() => oversized.run("bound", policy({ maxOutputItemsPerResponse: 0.5 })), cua.ComputerUsePolicyError);
});