import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "vision-cost-bound-test-"));
const providersBundlePath = path.join(bundleDir, "providers.mjs");
const visionBundlePath = path.join(bundleDir, "vision.mjs");

await esbuild.build({
  entryPoints: {
    providers: path.join(WORKER_ROOT, "src/vision/providers/index.ts"),
    vision: path.join(WORKER_ROOT, "src/vision/index.ts"),
  },
  outdir: bundleDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const providers = await import(pathToFileURL(providersBundlePath).href);
const vision = await import(pathToFileURL(visionBundlePath).href);
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const request = {
  prompt: { text: "fixed prompt" },
  responseSchema: { jsonSchema: { type: "object", properties: { value: { type: "string" } } } },
};

test("Gemma admission ceiling uses the full documented context window, not an average screenshot", async () => {
  const model = await providers.workersAiGemma4ModelSpec();
  const bound = providers.maximumVisionCallCostUsd(request, model);
  assert.equal(bound.inputTokensUpperBound, 256_000);
  assert.equal(bound.outputTokensUpperBound, 2_048);
  assert.ok(bound.maximumCostUsd >= 0.0262144 && bound.maximumCostUsd - 0.0262144 <= 2e-12);
  assert.equal(bound.basis, "documented-context-window");
});

test("Gemini admission ceiling binds exact text/schema bytes, high-resolution image cap, and output cap", async () => {
  const model = await providers.cloudflareGatewayGeminiModelSpec("firstgateway");
  const bound = providers.maximumVisionCallCostUsd(request, model);
  const encoder = new TextEncoder();
  const exactTextBytes = encoder.encode(request.prompt.text).byteLength;
  // Property sorting changes order, not compact JSON byte length for this ASCII fixture.
  const exactSchemaBytes = encoder.encode(JSON.stringify(request.responseSchema.jsonSchema)).byteLength;
  assert.equal(
    bound.inputTokensUpperBound,
    exactTextBytes + exactSchemaBytes + providers.GEMINI_36_FLASH_HIGH_IMAGE_TOKENS + providers.GEMINI_36_FLASH_INPUT_OVERHEAD_TOKENS,
  );
  assert.equal(bound.outputTokensUpperBound, 2_048);
  assert.equal(bound.billingBasis, "cloudflare-unified-billing-credit-purchase");
  assert.equal(bound.billingMultiplier, 1.05);
  const rawInferenceUsd =
    (bound.inputTokensUpperBound * 1.5 + bound.outputTokensUpperBound * 7.5) / 1_000_000;
  assert.equal(
    bound.maximumCostUsd,
    Math.ceil(rawInferenceUsd * 1.05 * 1_000_000_000_000) / 1_000_000_000_000,
  );
  assert.equal(bound.basis, "exact-text-bytes-plus-documented-image-cap");
});

test("production Gateway prompt reserves the exact fee-inclusive billed-cash ceiling", async () => {
  const model = await providers.cloudflareGatewayGeminiModelSpec("firstgateway");
  const bound = providers.maximumVisionCallCostUsd({
    prompt: { text: vision.VISUAL_INVENTORY_PROMPT },
    responseSchema: { jsonSchema: vision.VISUAL_RESPONSE_JSON_SCHEMA },
  }, model);
  assert.equal(bound.inputTokensUpperBound, 12_308);
  assert.equal(bound.outputTokensUpperBound, 2_048);
  assert.equal(bound.maximumCostUsd, 0.0355131);
  assert.ok(bound.maximumCostUsd <= 0.0356, "one-call generated cap must cover billed cash");
  assert.ok(bound.maximumCostUsd * 100 <= 3.56, "full Gateway cap remains below the $5 external budget");
});

test("Mistral admission uses public rates and the full context even when the account entitlement is free", async () => {
  const model = await providers.mistralMedium35ModelSpec();
  const bound = providers.maximumVisionCallCostUsd(request, model);
  assert.equal(bound.inputTokensUpperBound, 256_000);
  assert.equal(bound.outputTokensUpperBound, 2_048);
  assert.equal(bound.maximumCostUsd, 0.39936);
  assert.equal(bound.basis, "documented-context-window");
  assert.equal(
    providers.configuredVisionCostUsd(
      { inputTokens: 2_000, outputTokens: 500, model: model.model },
      model,
    ),
    0.00675,
  );
});

test("configured post-call cost is exact only with token telemetry and unchanged model identity", async () => {
  const model = await providers.cloudflareGatewayGeminiModelSpec("firstgateway");
  assert.equal(
    providers.configuredVisionCostUsd({ inputTokens: 2_000, outputTokens: 500, model: model.model }, model),
    0.0070875,
  );
  const direct = await providers.geminiDirectModelSpec();
  assert.equal(
    providers.configuredVisionCostUsd({ inputTokens: 2_000, outputTokens: 500, model: direct.model }, direct),
    0.00675,
    "the Cloudflare credit-purchase fee applies only to Unified Billing",
  );
  assert.equal(
    providers.configuredVisionCostUsd({ inputTokens: null, outputTokens: 500, model: model.model }, model),
    null,
  );
  assert.equal(
    providers.configuredVisionCostUsd({ inputTokens: 2_000, outputTokens: 500, model: "substituted-model" }, model),
    null,
  );
});

test("an unpinned provider/model has no admission ceiling or configured charge", () => {
  const unknown = {
    provider: "unknown-provider",
    model: "unknown-model",
    transport: "unknown",
    configurationSha256: "d".repeat(64),
  };
  assert.throws(() => providers.maximumVisionCallCostUsd(request, unknown), /no pre-call visual cost ceiling/);
  assert.equal(providers.configuredVisionCostUsd({ inputTokens: 1, outputTokens: 1 }, unknown), null);
});
