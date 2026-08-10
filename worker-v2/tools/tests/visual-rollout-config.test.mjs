import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-rollout-config-test-"));
const bundlePath = path.join(bundleDir, "config.mjs");

await esbuild.build({
  entryPoints: [path.join(WORKER_ROOT, "src/vision/config.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const config = await import(pathToFileURL(bundlePath).href);
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const enabled = (overrides = {}) => ({
  VISUAL_SHADOW_ENABLED: "true",
  VISUAL_PROVIDER: "workers-ai-gemma4",
  VISUAL_MAX_CALLS: "6",
  VISUAL_MAX_USD: "0.05",
  VISUAL_TIMEOUT_MS: "60000",
  VISUAL_WAVE_BUDGET_MS: "180000",
  VISUAL_MAX_WAVES: "4",
  ...overrides,
});

test("unset and exact false are the only disabled postures and authorize zero purchases", () => {
  assert.deepEqual(config.visualShadowConfiguration({}), {
    schemaVersion: config.VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
    enabled: false,
    concurrency: 1,
  });
  assert.equal(config.visualShadowConfiguration({ VISUAL_SHADOW_ENABLED: "false" }).enabled, false);
  for (const spelling of ["TRUE", "False", "1", "yes", " true "]) {
    assert.throws(
      () => config.visualShadowConfiguration({ VISUAL_SHADOW_ENABLED: spelling }),
      /VISUAL_SHADOW_ENABLED/,
    );
  }
});

test("enabled rollout has explicit caps and concurrency is structurally one", () => {
  const parsed = config.visualShadowConfiguration(enabled());
  assert.deepEqual(parsed, {
    schemaVersion: config.VISUAL_ROLLOUT_CONFIGURATION_SCHEMA_VERSION,
    enabled: true,
    provider: "workers-ai-gemma4",
    maximumCalls: 6,
    maximumUsd: 0.05,
    timeoutMs: 60_000,
    waveBudgetMs: 180_000,
    maximumWaves: 4,
    concurrency: 1,
  });
  assert.equal(
    config.visualShadowStepTimeoutMs(parsed),
    parsed.waveBudgetMs + parsed.timeoutMs + config.VISUAL_SHADOW_STEP_SLACK_MS,
  );
  assert.throws(
    () => config.visualShadowStepTimeoutMs(config.visualShadowConfiguration({})),
    /disabled visual shadow work/,
  );
});

test("every paid field is required and invalid numeric spellings fail closed", () => {
  for (const name of [
    "VISUAL_PROVIDER",
    "VISUAL_MAX_CALLS",
    "VISUAL_MAX_USD",
    "VISUAL_TIMEOUT_MS",
    "VISUAL_WAVE_BUDGET_MS",
    "VISUAL_MAX_WAVES",
  ]) {
    const env = enabled();
    delete env[name];
    assert.throws(() => config.visualShadowConfiguration(env), new RegExp(name));
  }

  for (const value of ["", "-1", "+1", "1e2", "1.0", "01", "NaN"]) {
    assert.throws(
      () => config.visualShadowConfiguration(enabled({ VISUAL_MAX_CALLS: value })),
      /VISUAL_MAX_CALLS/,
    );
  }
  for (const value of ["0", "-0.01", "1e-2", ".05", "0.1234567890123", "Infinity"]) {
    assert.throws(
      () => config.visualShadowConfiguration(enabled({ VISUAL_MAX_USD: value })),
      /VISUAL_MAX_USD/,
    );
  }
});

test("unknown provider cannot fall back and disabled config cannot resolve a client", async () => {
  assert.throws(
    () => config.visualShadowConfiguration(enabled({ VISUAL_PROVIDER: "auto" })),
    /VISUAL_PROVIDER/,
  );
  await assert.rejects(
    config.resolveVisualProvider({}, config.visualShadowConfiguration({})),
    /VISUAL_SHADOW_ENABLED/,
  );
});

test("selected provider must have its exact binding and does not fall through", async () => {
  const gemma = config.visualShadowConfiguration(enabled());
  await assert.rejects(config.resolveVisualProvider({}, gemma), /AI binding/);

  const gateway = config.visualShadowConfiguration(
    enabled({ VISUAL_PROVIDER: "cloudflare-gateway-gemini" }),
  );
  await assert.rejects(config.resolveVisualProvider({}, gateway), /AI binding/);
  await assert.rejects(config.resolveVisualProvider({ AI: {} }, gateway), /CF_AIG_GATEWAY_ID/);

  const direct = config.visualShadowConfiguration(enabled({ VISUAL_PROVIDER: "gemini-direct" }));
  await assert.rejects(config.resolveVisualProvider({}, direct), /GEMINI_API_KEY/);

  const mistral = config.visualShadowConfiguration(
    enabled({ VISUAL_PROVIDER: "mistral-medium35-direct" }),
  );
  await assert.rejects(config.resolveVisualProvider({}, mistral), /MISTRAL_API_KEY/);
});

test("rollout fingerprint changes for each authorization-relevant field", async () => {
  const baseline = config.visualShadowConfiguration(enabled());
  const baselineHash = await config.visualShadowConfigurationSha256(baseline);
  assert.match(baselineHash, /^[0-9a-f]{64}$/);
  for (const override of [
    { VISUAL_PROVIDER: "gemini-direct" },
    { VISUAL_PROVIDER: "mistral-medium35-direct" },
    { VISUAL_MAX_CALLS: "7" },
    { VISUAL_MAX_USD: "0.06" },
    { VISUAL_TIMEOUT_MS: "61000" },
    { VISUAL_WAVE_BUDGET_MS: "181000" },
    { VISUAL_MAX_WAVES: "5" },
  ]) {
    const changed = config.visualShadowConfiguration(enabled(override));
    assert.notEqual(await config.visualShadowConfigurationSha256(changed), baselineHash);
  }
});

test("invalid rollout inputs have a stable non-secret fingerprint with no ambient bindings", async () => {
  const malformed = enabled({ VISUAL_MAX_USD: "Infinity" });
  const baseline = await config.visualShadowRawConfigurationSha256({
    ...malformed,
    GEMINI_API_KEY: "must-not-enter-the-fingerprint",
    MISTRAL_API_KEY: "must-not-enter-the-fingerprint-either",
    ANTHROPIC_API_KEY: "also-irrelevant",
  });
  assert.match(baseline, /^[0-9a-f]{64}$/);
  assert.equal(
    await config.visualShadowRawConfigurationSha256({
      ...malformed,
      GEMINI_API_KEY: "different-secret",
      CF_AIG_GATEWAY_ID: "different-ambient-binding",
    }),
    baseline,
  );
  for (const [name, value] of Object.entries({
    VISUAL_SHADOW_ENABLED: "TRUE",
    VISUAL_PROVIDER: "unknown-provider",
    VISUAL_MAX_CALLS: "7",
    VISUAL_MAX_USD: "NaN",
    VISUAL_TIMEOUT_MS: "61000",
    VISUAL_WAVE_BUDGET_MS: "181000",
    VISUAL_MAX_WAVES: "5",
  })) {
    assert.notEqual(
      await config.visualShadowRawConfigurationSha256({ ...malformed, [name]: value }),
      baseline,
      `raw fingerprint must bind ${name}`,
    );
  }
});
