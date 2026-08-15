#!/usr/bin/env node

/**
 * Generate one auditable, isolated Wrangler config and one local-only authentication token.
 *
 * The production manifest is an input only for identities that must be derived from reviewed
 * source (for example, the judgement-key registry). Runtime capabilities and spend policy are an
 * explicit closed projection in `buildCanaryConfig`; unrelated production bindings or variables
 * cannot flow into the canary. The script refuses an existing output directory so an old
 * token/config cannot accidentally authorize a new run.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "./verified-typescript.mjs";
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
import { verifyCanarySourceSnapshot } from "./canary-source-snapshot.mjs";
import {
  normalizeBundleModulePolicy,
  verifyReviewedCanaryBundle,
} from "./canary-bundle-inputs.mjs";

const WORKER_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");
const ALLOWED_OUTPUT_ROOT = path.join(REPO_ROOT, ".test-tmp");
const SNAPSHOT_SOURCE_CONFIG_RELATIVE = "worker-v2/wrangler.jsonc";
const CANARY_JUDGEMENT_NOTE =
  "isolated live canary signer; injected only into generated canary config; reuse this signing bundle across semantic arms";
const VISUAL_POLICY_SCHEMA_VERSION = "survey-qa-live-canary-visual-policy/1.1.0";
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

export const CANARY_COMPATIBILITY_DATE = "2026-06-01";
export const CANARY_COMPATIBILITY_FLAGS = Object.freeze(["nodejs_compat"]);
export const CANARY_SUBREQUEST_LIMIT = 100_000;
export const CANARY_SECRET_STORE_ID = "55e6ce4174d645cfa68a6c27eef7847f";
export const CANARY_SECRET_BINDINGS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
]);

/**
 * Closed non-secret runtime policy for the isolated canary. Values are copied intentionally,
 * never inherited wholesale from the production config. Adding a runtime variable is therefore
 * a reviewed canary-capability change instead of an accidental side effect of a production edit.
 */
export const CANARY_STATIC_VARS = Object.freeze({
  AGGREGATOR_VERSION: "v2-aggregator/1.0.0",
  BROWSER_COMPAT_SHIMS: "auto",
  BROWSER_KEEP_ALIVE_MS: "600000",
  CAP_DEEP_MAX_USD: "2",
  CAP_MODEL_CALLS: "40",
  CAP_REPORT_RESERVE_FRACTION: "0.10",
  CAP_STANDARD_MAX_USD: "2",
  CAP_STANDARD_MIN_USD: "0.5",
  CAP_TOOL_CALLS: "1000",
  CAP_VERIFICATION_RESERVE_FRACTION: "0.15",
  CAP_WALL_CLOCK_MS: "14400000",
  CF_AIG_ACCOUNT_ID: LIVE_CANARY_ACCOUNT_ID,
  CF_AIG_GATEWAY_ID: "firstgateway",
  DEEPSEEK_INPUT_USD_PER_MTOK: "0.14",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  DEEPSEEK_CONTEXT_WINDOW_TOKENS: "1000000",
  DEEPSEEK_OUTPUT_USD_PER_MTOK: "0.28",
  DEEPSEEK_REASONING_EFFORT: "medium",
  DEEPSEEK_FALLBACK_MODE: "on-error",
  DEEPSEEK_FALLBACK_MODEL: "deepseek-v4-pro",
  DEEPSEEK_FALLBACK_REASONING_EFFORT: "medium",
  DEEPSEEK_FALLBACK_MAX_ATTEMPTS: "1",
  DEEPSEEK_FALLBACK_INPUT_USD_PER_MTOK: "0.435",
  DEEPSEEK_FALLBACK_OUTPUT_USD_PER_MTOK: "0.87",
  EXEC_ACQUIRE_TIMEOUT_MS: "45000",
  EXEC_ADVANCE_TIMEOUT_MS: "3500",
  EXEC_BATCH_MAX_ATTEMPTS: "4",
  EXEC_BATCH_MAX_MS: "120000",
  EXEC_MAX_BATCHES: "200",
  EXEC_MAX_EXPLORATION: "0",
  EXEC_MAX_STEPS_PER_PATH: "40",
  EXEC_WALK_TIMEOUT_MS: "150000",
  EXTRACTION_MODEL: "claude-sonnet-4-6",
  EXTRACT_BUDGET_FRACTION: "0.5",
  EXTRACT_CHUNK_CHARS: "3000",
  EXTRACT_CHUNK_CONCURRENCY: "5",
  EXTRACT_CHUNK_MAX_BLOCKS: "15",
  EXTRACT_CHUNK_MAX_ISSUES: "2",
  EXTRACT_MAX_ATTEMPTS: "2",
  EXTRACT_MODEL_INPUT_MAX_BYTES: "450000",
  EXTRACT_MAX_OUTPUT_TOKENS: "32000",
  EXTRACT_PASS_A_MAX_WAVES: "20",
  EXTRACT_PASS_A_WAVE_BUDGET_MS: "600000",
  EXTRACT_PASS_A_WINDOW_CHARS: "90000",
  EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
  EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  EXTRACT_PASS_A_SYNTHESIS_MAX_BYTES: "120000",
  EXTRACT_PASS_A_SYNTHESIS_MAX_ISSUES: "2",
  EXTRACT_PASS_B_MAX_WAVES: "40",
  EXTRACT_SWEEP_BLOCKS_PER_CALL: "40",
  EXTRACT_SWEEP_MAX_CALLS: "3",
  EXTRACT_WAVE_BUDGET_MS: "600000",
  // Intentionally no Grok rate fields: the canary must remain unable to buy grok-4.5
  // until an authenticated catalogue receipt is injected into a reviewed release config.
  GROK_MODEL: "grok-4.5",
  GROK_REASONING_EFFORT: "high",
  HUMAN_REVIEW_MODE: "high-risk-only",
  JUDGE_MODEL: "claude-sonnet-4-6",
  LLM_TIMEOUT_MS: "300000",
  MAX_DOCUMENT_BYTES: "26214400",
  MAX_HUMAN_REQUIREMENTS_BYTES: "1048576",
  MAX_LOCALE_LENGTH: "35",
  MAX_SUBMISSION_BYTES: "37748736",
  MAX_VIEWPORTS: "6",
  ORACLE_GAP_POLICY: "neutral-blocking",
  OUTBOUND_URL_POLICY: "block-private",
  RESULT_POLICY_VERSION: "v2-result-policy/1.0.0",
  RETENTION_CONTRACT_DAYS: "0",
  RETENTION_MODE: "permanent",
  RETENTION_RAW_EVIDENCE_DAYS: "0",
  RETENTION_REPORT_DAYS: "0",
  RETENTION_SCAN_BUDGET: "500",
  SESSION_MAX_AGE_MS: "480000",
  V2_PREFIX: "v2/",
  WORKERSAI_ENABLED: "false",
  WORKERSAI_VALIDATOR_MODEL: "@cf/openai/gpt-oss-120b",
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const options = parseArgs(args);
  const outputDir = checkedOutputDirectory(options.outputDir);
  const snapshot = verifyCanarySourceSnapshot({
    snapshotDirectory: options.sourceSnapshotDirectory,
    repositoryRoot: REPO_ROOT,
  });
  if (snapshot.manifestSha256 !== options.sourceManifestSha256) {
    throw new Error("source snapshot manifest SHA-256 does not match the operator-selected identity");
  }
  assertPrivateLocalPath(snapshot.snapshotDirectory, REPO_ROOT, { directory: true });
  assertPrivateLocalPath(snapshot.manifestPath, REPO_ROOT);
  if (pathsOverlap(outputDir, snapshot.snapshotDirectory)) {
    throw new Error("generated config output must be outside the immutable source snapshot");
  }
  const sourceConfigPath = path.join(
    snapshot.snapshotDirectory,
    ...SNAPSHOT_SOURCE_CONFIG_RELATIVE.split("/"),
  );
  const parsed = parseJsonc(await readFile(sourceConfigPath, "utf8"), sourceConfigPath);
  const sourceWorkerRoot = path.join(snapshot.snapshotDirectory, "worker-v2");
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
    expectedDocumentSha256: options.expectedDocumentSha256,
    sourceWorkerRoot,
    sourceManifestSha256: snapshot.manifestSha256,
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
        schemaVersion: "survey-qa-live-canary-config/1.1.0",
        generatedAt: new Date().toISOString(),
        workerName: LIVE_CANARY_WORKER_NAME,
        accountId: LIVE_CANARY_ACCOUNT_ID,
        origin: LIVE_CANARY_ORIGIN,
        provider: options.provider,
        maximumCalls: Number(config.vars.VISUAL_MAX_CALLS),
        maximumVisualUsd: Number(config.vars.VISUAL_MAX_USD),
        coreMaximumUsd: Number(config.vars.CAP_STANDARD_MAX_USD),
        visualPolicy,
        expectedDocumentSha256: config.vars.CANARY_EXPECTED_DOCUMENT_SHA256,
        sourceSnapshotDirectory: snapshot.snapshotDirectory,
        sourceManifestSha256: snapshot.manifestSha256,
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
  {
    provider,
    bucketName,
    tokenSha256,
    expectedDocumentSha256,
    sourceWorkerRoot,
    sourceManifestSha256,
    signingBundle,
    visualMaximumCalls,
  },
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
  if (!SHA256_HEX.test(tokenSha256)) throw new Error("invalid canary token digest");
  if (!SHA256_HEX.test(expectedDocumentSha256)) {
    throw new Error("expected document SHA-256 must be exactly 64 lowercase hexadecimal characters");
  }
  if (!SHA256_HEX.test(sourceManifestSha256)) {
    throw new Error("source manifest SHA-256 must be exactly 64 lowercase hexadecimal characters");
  }
  const deploymentWorkerRoot = requireExactSourceWorkerRoot(sourceWorkerRoot);

  // This is a positive projection, not a production-config clone. A newly added production
  // binding, route, trigger, queue, service, database, variable, or local-dev remote flag has no
  // path into the canary until it is named here and in the independent deployment gate.
  return {
    name: LIVE_CANARY_WORKER_NAME,
    account_id: LIVE_CANARY_ACCOUNT_ID,
    compliance_region: LIVE_CANARY_COMPLIANCE_REGION,
    main: path.join(deploymentWorkerRoot, "tools", "live-canary-worker.ts").replaceAll("\\", "/"),
    compatibility_date: CANARY_COMPATIBILITY_DATE,
    compatibility_flags: [...CANARY_COMPATIBILITY_FLAGS],
    rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: path.join(deploymentWorkerRoot, "public").replaceAll("\\", "/"),
      binding: "ASSETS",
      run_worker_first: ["/api/v2/*", "/runs/*", "/v2/*"],
    },
    browser: { binding: "BROWSER" },
    ai: { binding: "AI" },
    r2_buckets: [{ binding: "EVIDENCE", bucket_name: bucketName }],
    limits: { subrequests: CANARY_SUBREQUEST_LIMIT },
    workflows: [
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
    ],
    secrets_store_secrets: CANARY_SECRET_BINDINGS.map((binding) => ({
      binding,
      store_id: CANARY_SECRET_STORE_ID,
      secret_name: binding,
    })),
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ...CANARY_STATIC_VARS,
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
      CANARY_EXPECTED_DOCUMENT_SHA256: expectedDocumentSha256,
      CANARY_SOURCE_MANIFEST_SHA256: sourceManifestSha256,
      JUDGEMENT_KEY_REGISTRY: signingRegistry.registryJson,
    },
    observability: { enabled: true },
  };
}

/**
 * Project a snapshot-bound build config onto one already-reviewed plain-JavaScript bundle.
 * Wrangler receives `no_bundle` plus exact additional-module globs, so deployment cannot perform
 * a second source traversal or silently include a build by-product.
 */
export function buildReviewedCanaryDeployConfig(
  snapshotBuildConfig,
  {
    snapshotDirectory,
    reviewedBundleDirectory,
    expectedSourceManifestSha256,
    expectedReviewedBundleManifestSha256,
    repositoryRoot = REPO_ROOT,
    assertPrivatePathImpl,
  } = {},
) {
  if (!SHA256_HEX.test(expectedSourceManifestSha256)) {
    throw new Error("expected source manifest SHA-256 is invalid");
  }
  if (!SHA256_HEX.test(expectedReviewedBundleManifestSha256)) {
    throw new Error("expected reviewed bundle manifest SHA-256 is invalid");
  }
  const snapshot = verifyCanarySourceSnapshot({ snapshotDirectory, repositoryRoot });
  if (snapshot.manifestSha256 !== expectedSourceManifestSha256) {
    throw new Error("source snapshot does not match the expected manifest SHA-256");
  }
  const reviewed = verifyReviewedCanaryBundle({
    reviewedBundleDirectory,
    snapshotDirectory: snapshot.snapshotDirectory,
    repositoryRoot,
    ...(assertPrivatePathImpl === undefined ? {} : { assertPrivatePathImpl }),
  });
  if (reviewed.manifestSha256 !== expectedReviewedBundleManifestSha256) {
    throw new Error("reviewed bundle does not match the expected manifest SHA-256");
  }

  const expectedSnapshotWorkerRoot = path.join(snapshot.snapshotDirectory, "worker-v2");
  const expectedSourceEntrypoint = path.join(
    expectedSnapshotWorkerRoot,
    "tools",
    "live-canary-worker.ts",
  );
  const expectedAssetsDirectory = path.join(expectedSnapshotWorkerRoot, "public");
  if (
    !isRecord(snapshotBuildConfig) ||
    typeof snapshotBuildConfig.main !== "string" ||
    path.relative(path.resolve(snapshotBuildConfig.main), expectedSourceEntrypoint) !== "" ||
    snapshotBuildConfig.assets === null ||
    typeof snapshotBuildConfig.assets !== "object" ||
    Array.isArray(snapshotBuildConfig.assets) ||
    typeof snapshotBuildConfig.assets.directory !== "string" ||
    path.relative(path.resolve(snapshotBuildConfig.assets.directory), expectedAssetsDirectory) !== "" ||
    snapshotBuildConfig.vars?.CANARY_SOURCE_MANIFEST_SHA256 !== expectedSourceManifestSha256 ||
    reviewed.bundleInputsManifest.sourceEntrypoint !==
      "worker-v2/tools/live-canary-worker.ts"
  ) {
    throw new Error("build config or bundle inputs are not bound to the selected source snapshot");
  }
  if (snapshotBuildConfig.no_bundle === true || "build" in snapshotBuildConfig) {
    throw new Error("snapshot build config contains an unexpected pre-build or no-bundle override");
  }
  const buildModulePolicy = normalizedSnapshotBuildModulePolicy(snapshotBuildConfig);
  if (JSON.stringify(buildModulePolicy) !== JSON.stringify(reviewed.bundleInputsManifest.modulePolicy)) {
    throw new Error("snapshot build module policy differs from the audited bundle-input policy");
  }
  assertReviewedRuntimeGraph(reviewed);

  const config = structuredClone(snapshotBuildConfig);
  config.main = reviewed.entryPath.replaceAll("\\", "/");
  config.assets.directory = expectedAssetsDirectory.replaceAll("\\", "/");
  config.no_bundle = true;
  config.find_additional_modules = reviewed.modules.length > 0;
  config.base_dir = reviewed.reviewedBundleDirectory.replaceAll("\\", "/");
  config.preserve_file_names = false;
  config.rules = groupedReviewedModuleRules(reviewed.modules);
  delete config.minify;
  delete config.tsconfig;
  config.vars = {
    ...config.vars,
    CANARY_SOURCE_MANIFEST_SHA256: expectedSourceManifestSha256,
    CANARY_BUNDLE_INPUTS_MANIFEST_SHA256: reviewed.bundleInputsManifestSha256,
    CANARY_BUNDLE_METAFILE_SHA256: reviewed.manifest.metafileSha256,
    CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256: reviewed.manifestSha256,
  };
  return config;
}

function normalizedSnapshotBuildModulePolicy(config) {
  return normalizeBundleModulePolicy({
    preserveFileNames: config.preserve_file_names,
    findAdditionalModules: config.find_additional_modules,
    compatibilityFlags: config.compatibility_flags,
    rules: config.rules,
  });
}

function groupedReviewedModuleRules(modules) {
  const byType = new Map();
  for (const module of modules) {
    const paths = byType.get(module.type) ?? [];
    paths.push(module.path);
    byType.set(module.type, paths);
  }
  return [...byType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, globs]) => ({
      type,
      globs: [...globs].sort(),
      fallthrough: false,
    }));
}

function assertReviewedRuntimeGraph(reviewed) {
  const outputs = new Map(
    reviewed.bundleInputsManifest.outputs.map((output) => [output.path, output]),
  );
  const selected = new Map([
    [reviewed.manifest.entry.path, reviewed.manifest.entry],
    ...reviewed.modules.map((module) => [module.path, module]),
  ]);
  const javascriptPaths = [
    reviewed.manifest.entry.path,
    ...reviewed.modules
      .filter((module) => module.provenance.kind === "metafile-output")
      .map((module) => module.path),
  ];
  for (const modulePath of javascriptPaths) {
    const output = outputs.get(modulePath);
    const selectedIdentity = selected.get(modulePath);
    if (output === undefined || selectedIdentity === undefined) {
      throw new Error("reviewed JavaScript graph is incomplete");
    }
    const absolute = path.join(reviewed.reviewedBundleDirectory, ...modulePath.split("/"));
    const actualImports = literalModuleImports(readFileSync(absolute, "utf8"));
    const expectedImports = output.imports.map((edge) => {
      if (edge.target !== undefined && edge.external !== true) {
        let specifier = path.posix.relative(path.posix.dirname(modulePath), edge.target.path);
        if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        return { path: specifier, kind: edge.kind };
      }
      return { path: edge.path, kind: edge.kind };
    }).sort(compareModuleImport);
    if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) {
      throw new Error("reviewed JavaScript imports differ from the audited output graph");
    }
    for (const edge of output.imports) {
      if (edge.target === undefined) continue;
      const target = selected.get(edge.target.path);
      if (
        target === undefined ||
        target.bytes !== edge.target.bytes ||
        target.sha256 !== edge.target.sha256
      ) {
        throw new Error("a reviewed relative import does not resolve to one exact reviewed file");
      }
      const resolved = path.resolve(path.dirname(absolute), edge.external === true
        ? edge.path.replaceAll("/", path.sep)
        : path.posix.relative(path.posix.dirname(modulePath), edge.target.path).replaceAll("/", path.sep));
      const expected = path.join(reviewed.reviewedBundleDirectory, ...edge.target.path.split("/"));
      if (path.relative(resolved, expected) !== "") {
        throw new Error("a reviewed relative import escapes or aliases its reviewed target");
      }
    }
  }
}

function literalModuleImports(source) {
  const file = ts.createSourceFile("reviewed.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const imports = [];
  const add = (value, kind) => {
    if (!ts.isStringLiteralLike(value)) {
      throw new Error("reviewed JavaScript contains a non-literal module specifier");
    }
    imports.push({ path: value.text, kind });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, "import-statement");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, "import-statement");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1) throw new Error("reviewed JavaScript has an open dynamic import");
      add(node.arguments[0], "dynamic-import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      if (node.arguments.length !== 1) throw new Error("reviewed JavaScript has an open require call");
      add(node.arguments[0], "require-call");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports.sort(compareModuleImport);
}

function compareModuleImport(left, right) {
  return `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`);
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
        "--expected-document-sha256",
        "--source-snapshot-directory",
        "--source-manifest-sha256",
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
  const expectedDocumentSha256 = parsed.expected_document_sha256;
  const sourceSnapshotDirectory = parsed.source_snapshot_directory;
  const sourceManifestSha256 = parsed.source_manifest_sha256;
  const visualMaximumCalls = parsed.visual_maximum_calls === "1"
      ? 1
      : parsed.visual_maximum_calls === "100"
        ? 100
        : Number.NaN;
  if (
    typeof outputDir !== "string" ||
    typeof provider !== "string" ||
    typeof bucketName !== "string" ||
    typeof signingBundle !== "string" ||
    typeof expectedDocumentSha256 !== "string" ||
    !SHA256_HEX.test(expectedDocumentSha256) ||
    typeof sourceSnapshotDirectory !== "string" ||
    typeof sourceManifestSha256 !== "string" ||
    !SHA256_HEX.test(sourceManifestSha256)
  ) usage();
  if (!(provider in PROVIDERS)) usage();
  if (visualMaximumCalls !== 1 && visualMaximumCalls !== 100) usage();
  return {
    outputDir,
    provider,
    bucketName,
    signingBundle: path.resolve(signingBundle),
    expectedDocumentSha256,
    sourceSnapshotDirectory: path.resolve(sourceSnapshotDirectory),
    sourceManifestSha256,
    visualMaximumCalls,
  };
}

function usage() {
  process.stderr.write(
    "usage: node tools/generate-live-canary-config.mjs --output-dir <new .test-tmp child> " +
      "--provider <workers-ai-gemma4|cloudflare-gateway-gemini|mistral-medium35-direct> " +
      "--bucket-name <dedicated-r2-bucket> " +
      "--signing-bundle <.test-tmp child/canary-signing-bundle.json> " +
      "--expected-document-sha256 <64-lowercase-hex> " +
      "--source-snapshot-directory <verified private snapshot> " +
      "--source-manifest-sha256 <64-lowercase-hex> " +
      "--visual-maximum-calls <1|100>\n",
  );
  process.exit(2);
}

function requireExactSourceWorkerRoot(value) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error("source Worker root must be an explicit absolute directory");
  }
  const resolved = path.resolve(value);
  let stat;
  let real;
  try {
    stat = lstatSync(resolved);
    real = realpathSync.native(resolved);
  } catch {
    throw new Error("source Worker root is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(real, resolved) !== "") {
    throw new Error("source Worker root must be one exact unlinked directory");
  }
  return real;
}

function pathsOverlap(left, right) {
  const leftToRight = path.relative(path.resolve(left), path.resolve(right));
  const rightToLeft = path.relative(path.resolve(right), path.resolve(left));
  const isWithinOrEqual = (relative) =>
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return isWithinOrEqual(leftToRight) || isWithinOrEqual(rightToLeft);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
