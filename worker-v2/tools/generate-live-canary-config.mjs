#!/usr/bin/env node

/**
 * Generate one auditable, isolated Wrangler config and one local-only authentication token.
 *
 * The source config remains the production manifest, so every model, timeout, binding, and
 * compatibility flag stays visible in one place. This script changes only the identities and
 * bounded canary policy named in `buildCanaryConfig`. It refuses an existing output directory so
 * an old token/config cannot accidentally authorize a new run.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  LIVE_CANARY_BUCKET_NAME,
  LIVE_CANARY_ACCOUNT_ID,
  LIVE_CANARY_COMPLIANCE_REGION,
  LIVE_CANARY_ORIGIN,
  LIVE_CANARY_WORKER_NAME,
} from "./live-canary-contract.mjs";
import {
  CANARY_SIGNING_BUNDLE_SCHEMA_VERSION,
  canarySigningKeyId,
  canarySigningSecretsJson,
  loadCanarySigningBundle,
  parseCanarySigningBundle,
} from "./generate-live-canary-signing-bundle.mjs";
import { assertPrivateLocalPath, hardenPrivateLocalDirectory } from "./private-local-output.mjs";

const WORKER_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");
const ALLOWED_OUTPUT_ROOT = path.join(REPO_ROOT, ".test-tmp");
const SOURCE_CONFIG = path.join(WORKER_ROOT, "wrangler.jsonc");
const CANARY_JUDGEMENT_NOTE =
  "isolated live canary signer; injected only into generated canary config; reuse this signing bundle across semantic arms";
const VISUAL_POLICY_SCHEMA_VERSION = "survey-qa-live-canary-visual-policy/1.1.0";

const PROVIDERS = {
  // Provider and billed-cash ceilings are independent, serial hard stops. Gemini includes
  // Cloudflare Unified Billing's 5% credit-purchase fee in both profiles. Mistral is free under
  // the owner's research agreement, but the canary still meters its current public token rate
  // and stops at $5 if the account entitlement is absent or telemetry indicates unexpectedly
  // high use.
  "workers-ai-gemma4": {
    full: { maximumCalls: "100", maximumUsd: "2.63" },
    smoke: { maximumCalls: "1", maximumUsd: "0.0263" },
  },
  "cloudflare-gateway-gemini": {
    full: { maximumCalls: "100", maximumUsd: "3.56" },
    smoke: { maximumCalls: "1", maximumUsd: "0.0356" },
  },
  "mistral-medium35-direct": {
    full: { maximumCalls: "100", maximumUsd: "5" },
    smoke: { maximumCalls: "1", maximumUsd: "0.4" },
  },
};

/** Closed provider selectors shared by config generation, deploy gates, and result attribution. */
export const CANARY_VISUAL_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const options = parseArgs(args);
  const outputDir = checkedOutputDirectory(options.outputDir);
  const parsed = parseJsonc(await readFile(SOURCE_CONFIG, "utf8"), SOURCE_CONFIG);
  const signingBundle = await loadCanarySigningBundle(options.signingBundle);
  const signingSecrets = canarySigningSecretsJson(signingBundle);
  const signingRegistry = canaryJudgementRegistry(parsed, signingBundle);
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
  const visualPolicy = canaryVisualPolicy(options.provider, options.visualMaximumCalls);
  const config = buildCanaryConfig(parsed, {
    provider: options.provider,
    bucketName: options.bucketName,
    tokenSha256,
    signingBundle,
    visualMaximumCalls: options.visualMaximumCalls,
  });
  await mkdir(outputDir, { recursive: false });
  hardenPrivateLocalDirectory(outputDir, REPO_ROOT);

  const configPath = path.join(outputDir, "wrangler.live-canary.json");
  const tokenPath = path.join(outputDir, "canary-token.txt");
  // JSON is deliberate. The signing keys are multiline PEM values; projecting them back to a
  // line-oriented dotenv file can silently retain only the BEGIN line. Wrangler accepts JSON
  // secret files and JSON preserves the exact parsed newlines without a second quoting grammar.
  const secretsFilePath = path.join(outputDir, "canary-worker-secrets.json");
  const metadataPath = path.join(outputDir, "canary-metadata.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(secretsFilePath, signingSecrets, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        schemaVersion: "survey-qa-live-canary-config/1.0.0",
        generatedAt: new Date().toISOString(),
        workerName: LIVE_CANARY_WORKER_NAME,
        accountId: LIVE_CANARY_ACCOUNT_ID,
        origin: LIVE_CANARY_ORIGIN,
        provider: options.provider,
        maximumCalls: Number(config.vars.VISUAL_MAX_CALLS),
        maximumVisualUsd: Number(config.vars.VISUAL_MAX_USD),
        coreMaximumUsd: Number(config.vars.CAP_STANDARD_MAX_USD),
        visualPolicy,
        bucketName: options.bucketName,
        configPath,
        tokenPath,
        secretsFilePath,
        signingBundlePath: path.resolve(options.signingBundle),
        signing: {
          schemaVersion: CANARY_SIGNING_BUNDLE_SCHEMA_VERSION,
          registryMode: signingRegistry.mode,
          recordKeyId: signingBundle.record.keyId,
          judgementKeyId: signingBundle.judgement.keyId,
          judgementPublicKeySpkiSha256: signingBundle.judgement.publicKeySpkiSha256,
        },
        tokenSha256,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  assertPrivateLocalPath(tokenPath, REPO_ROOT);
  assertPrivateLocalPath(secretsFilePath, REPO_ROOT);

  process.stdout.write(
    `${JSON.stringify({
      configPath,
      tokenPath,
      secretsFilePath,
      metadataPath,
      workerName: LIVE_CANARY_WORKER_NAME,
      origin: LIVE_CANARY_ORIGIN,
      provider: options.provider,
      visualPolicy: visualPolicy.profile,
      recordKeyId: signingBundle.record.keyId,
      judgementKeyId: signingBundle.judgement.keyId,
    })}\n`,
  );
}

export function buildCanaryConfig(
  source,
  { provider, bucketName, tokenSha256, signingBundle, visualMaximumCalls },
) {
  const visualPolicy = canaryVisualPolicy(provider, visualMaximumCalls);
  const signingRegistry = canaryJudgementRegistry(source, signingBundle);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) throw new Error("invalid R2 bucket name");
  const sourceBucketNames = new Set(
    Array.isArray(source.r2_buckets)
      ? source.r2_buckets.map((binding) => binding?.bucket_name).filter((name) => typeof name === "string")
      : [],
  );
  if (bucketName !== LIVE_CANARY_BUCKET_NAME || sourceBucketNames.has(bucketName)) {
    throw new Error("R2 bucket must be the dedicated non-production visual-canary bucket");
  }
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error("invalid canary token digest");

  const config = structuredClone(source);
  delete config.$schema;
  delete config.routes;
  delete config.triggers;
  // Wrangler's top-level account selector is authoritative for deploys. Pin it independently of
  // the similarly named runtime var so an OAuth session spanning accounts cannot choose another.
  config.account_id = LIVE_CANARY_ACCOUNT_ID;
  config.compliance_region = LIVE_CANARY_COMPLIANCE_REGION;
  config.name = LIVE_CANARY_WORKER_NAME;
  config.main = path.join(WORKER_ROOT, "tools", "live-canary-worker.ts").replaceAll("\\", "/");
  config.workers_dev = true;
  config.preview_urls = false;
  if (config.assets && typeof config.assets === "object") {
    config.assets.directory = path.join(WORKER_ROOT, "public").replaceAll("\\", "/");
  }
  config.r2_buckets = [{ binding: "EVIDENCE", bucket_name: bucketName }];
  config.workflows = [
    {
      name: "survey-qa-v2-visual-canary-run",
      binding: "V2_RUN_WORKFLOW",
      class_name: "SurveyRunWorkflowV2",
    },
    {
      name: "survey-qa-v2-visual-canary-shadow",
      binding: "V2_VISUAL_WORKFLOW",
      class_name: "SurveyVisualShadowWorkflowV1",
    },
  ];
  config.vars = {
    ...config.vars,
    CF_AIG_ACCOUNT_ID: LIVE_CANARY_ACCOUNT_ID,
    V2_PREFIX: "v2/",
    EXEC_MAX_EXPLORATION: "0",
    CAP_STANDARD_MAX_USD: "2",
    CAP_STANDARD_MIN_USD: "0.5",
    CAP_MODEL_CALLS: "40",
    CAP_TOOL_CALLS: "1000",
    // Visual work starts only after the core report is final. Keep a bounded two-hour envelope
    // so a legitimate core run does not consume the visual channel's entire clock allowance.
    CAP_WALL_CLOCK_MS: "7200000",
    VISUAL_SHADOW_ENABLED: "true",
    VISUAL_PROVIDER: provider,
    VISUAL_MAX_CALLS: visualPolicy.maximumCalls,
    VISUAL_MAX_USD: visualPolicy.maximumUsd,
    VISUAL_TIMEOUT_MS: visualPolicy.timeoutMs,
    VISUAL_WAVE_BUDGET_MS: visualPolicy.waveBudgetMs,
    VISUAL_MAX_WAVES: visualPolicy.maximumWaves,
    CANARY_VISUAL_PROFILE: visualPolicy.profile,
    CANARY_VISUAL_POLICY_SHA256: visualPolicy.sha256,
    CANARY_AUTH_SHA256: tokenSha256,
    JUDGEMENT_KEY_REGISTRY: signingRegistry.registryJson,
  };
  // Fixture trust can only be enabled by DEV_SEED. Generated deployed configs erase it even if a
  // mutated source object attempts to carry it into this isolated projection.
  delete config.vars.DEV_SEED;
  return config;
}

/** The only accepted canary spend postures: the audited 100-call policy or one-call smoke. */
export function canaryVisualPolicy(provider, visualMaximumCalls) {
  const policies = PROVIDERS[provider];
  if (policies === undefined) throw new Error(`unsupported visual provider: ${provider}`);
  const calls = typeof visualMaximumCalls === "string"
    ? visualMaximumCalls === "1" || visualMaximumCalls === "100"
      ? Number(visualMaximumCalls)
      : Number.NaN
    : visualMaximumCalls;
  const selected = calls === 100 ? policies.full : calls === 1 ? policies.smoke : null;
  if (selected === null) {
    throw new Error("visual maximum calls must select the audited 100-call full or 1-call smoke profile");
  }
  const profile = calls === 1 ? "semantic-smoke-one-call" : "full";
  const fingerprintInput = {
    schemaVersion: VISUAL_POLICY_SCHEMA_VERSION,
    profile,
    provider,
    maximumCalls: selected.maximumCalls,
    maximumUsd: selected.maximumUsd,
    maximumWaves: "100",
    timeoutMs: "120000",
    waveBudgetMs: "120000",
  };
  return {
    ...fingerprintInput,
    sha256: createHash("sha256").update(JSON.stringify(fingerprintInput), "utf8").digest("hex"),
  };
}

/**
 * Bind the judgement private key to either a reviewed production registry entry or its exact
 * fingerprint-derived canary identity. Only the latter adds one public key to the generated
 * config; fixture and arbitrary identities never become production trust.
 */
export function canaryJudgementRegistry(source, signingBundle) {
  const bundle = parseCanarySigningBundle(JSON.stringify(signingBundle));
  const raw = source?.vars?.JUDGEMENT_KEY_REGISTRY;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 * 1024) {
    throw new Error("source JUDGEMENT_KEY_REGISTRY is absent or invalid");
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new Error("source JUDGEMENT_KEY_REGISTRY is not valid JSON");
  }
  if (
    typeof registry !== "object" ||
    registry === null ||
    Array.isArray(registry) ||
    typeof registry.keys !== "object" ||
    registry.keys === null ||
    Array.isArray(registry.keys)
  ) {
    throw new Error("source JUDGEMENT_KEY_REGISTRY has no keys object");
  }

  const signer = bundle.judgement;
  const existing = registry.keys[signer.keyId];
  if (existing !== undefined) {
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new Error("source judgement registry entry is invalid");
    }
    if (existing.trust !== "production") {
      throw new Error("fixture or non-production judgement signing keys are refused for live canaries");
    }
    if (existing.publicKeySpki !== signer.publicKeySpki) {
      throw new Error("judgement signing private key does not match its production registry public key");
    }
    return {
      mode: "source-production",
      registryJson: JSON.stringify(registry),
      judgementKeyId: signer.keyId,
    };
  }

  const expectedCanaryKeyId = canarySigningKeyId("judgement", signer.publicKeySpki);
  if (signer.keyId !== expectedCanaryKeyId) {
    throw new Error("unregistered judgement key id is not bound to its canary public-key fingerprint");
  }
  const generatedRegistry = structuredClone(registry);
  generatedRegistry.keys[signer.keyId] = {
    publicKeySpki: signer.publicKeySpki,
    trust: "production",
    note: CANARY_JUDGEMENT_NOTE,
  };
  return {
    mode: "isolated-canary-injected",
    registryJson: JSON.stringify(generatedRegistry),
    judgementKeyId: signer.keyId,
  };
}

function parseJsonc(text, sourcePath) {
  const result = ts.parseConfigFileTextToJson(sourcePath, text);
  if (result.error) {
    const detail = ts.flattenDiagnosticMessageText(result.error.messageText, "\n");
    throw new Error(`could not parse ${sourcePath}: ${detail}`);
  }
  return result.config;
}

function checkedOutputDirectory(value) {
  const resolved = path.resolve(value);
  const relative = path.relative(ALLOWED_OUTPUT_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`--output-dir must be a new child of ${ALLOWED_OUTPUT_ROOT}`);
  }
  return resolved;
}

function parseArgs(args) {
  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (
      ![
        "--output-dir",
        "--provider",
        "--bucket-name",
        "--signing-bundle",
        "--visual-maximum-calls",
      ].includes(name) ||
      value === undefined ||
      seen.has(name)
    ) usage();
    seen.add(name);
    parsed[name.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  const outputDir = parsed.output_dir;
  const provider = parsed.provider;
  const bucketName = parsed.bucket_name;
  const signingBundle = parsed.signing_bundle;
  const visualMaximumCalls = parsed.visual_maximum_calls === "1"
      ? 1
      : parsed.visual_maximum_calls === "100"
        ? 100
        : Number.NaN;
  if (
    typeof outputDir !== "string" ||
    typeof provider !== "string" ||
    typeof bucketName !== "string" ||
    typeof signingBundle !== "string"
  ) usage();
  if (!(provider in PROVIDERS)) usage();
  if (visualMaximumCalls !== 1 && visualMaximumCalls !== 100) usage();
  return {
    outputDir,
    provider,
    bucketName,
    signingBundle: path.resolve(signingBundle),
    visualMaximumCalls,
  };
}

function usage() {
  process.stderr.write(
    "usage: node tools/generate-live-canary-config.mjs --output-dir <new .test-tmp child> " +
      "--provider <workers-ai-gemma4|cloudflare-gateway-gemini|mistral-medium35-direct> " +
      "--bucket-name <dedicated-r2-bucket> " +
      "--signing-bundle <.test-tmp child/canary-signing-bundle.json> " +
      "--visual-maximum-calls <1|100>\n",
  );
  process.exit(2);
}
