#!/usr/bin/env node

/**
 * Deployment interlock for the isolated visual canary.
 *
 * Assumption (declared and checked): this operator adapter owns exactly the two Workflow
 * namespaces below. It intentionally does not derive the expected set from the candidate config;
 * otherwise a config that accidentally dropped one binding would also silently stop checking it.
 * Wrangler currently has no JSON output for `workflows instances list`, so filterable
 * nonterminal states are closed to its exact named empty sentence. `unknown` is a real Workflow
 * status but is not accepted by Wrangler's status filter; a second, paginated all-instance scan
 * therefore rejects unknown or contradictory nonterminal rows. A format change is a deployment
 * block, not an inference that an empty-looking table means no work.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CANARY_VISUAL_PROVIDERS,
  canaryVisualPolicy,
} from "./generate-live-canary-config.mjs";
import {
  EXPECTED_WRANGLER_VERSION,
  assertPinnedWranglerDescriptor as assertCompletePinnedWranglerDescriptor,
  resolvePinnedWranglerCommand,
} from "./pinned-wrangler-command.mjs";
import { assertPrivateLocalPath } from "./private-local-output.mjs";
import { verifyCanarySourceSnapshot } from "./canary-source-snapshot.mjs";
import { verifyReviewedCanaryBundle } from "./canary-bundle-inputs.mjs";

export { EXPECTED_WRANGLER_VERSION };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");
export const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
export const EXPECTED_CANARY_WORKER = "survey-qa-v2-visual-canary";
export const EXPECTED_CANARY_BUCKET = "survey-qa-artifacts-visual-canary";
export const EXPECTED_CLOUDFLARE_ACCOUNT_ID = "f0cbb2076e484454e6567789b9be85d8";
export const LEGACY_REMOTE_SECRET_AUDIT_DOCUMENT_BINDING_MODE =
  "legacy-remote-secret-audit-unbound";
export const EXPECTED_CANARY_VISUAL_PROVIDERS = CANARY_VISUAL_PROVIDERS;
export const EXPECTED_CANARY_WORKFLOW_BINDINGS = Object.freeze([
  Object.freeze({
    name: "survey-qa-v2-visual-canary-run",
    binding: "V2_RUN_WORKFLOW",
    class_name: "SurveyRunWorkflowV2",
  }),
  Object.freeze({
    name: "survey-qa-v2-visual-canary-shadow",
    binding: "V2_VISUAL_WORKFLOW",
    class_name: "SurveyVisualShadowWorkflowV1",
  }),
]);
export const EXPECTED_CANARY_WORKFLOWS = Object.freeze(
  EXPECTED_CANARY_WORKFLOW_BINDINGS.map((binding) => binding.name),
);
export const FILTERABLE_NONTERMINAL_STATUSES = Object.freeze([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);
export const ACTIVE_WORKFLOW_STATUSES = Object.freeze([
  ...FILTERABLE_NONTERMINAL_STATUSES,
  "unknown",
]);

const EXPECTED_COMPATIBILITY_DATE = "2026-06-01";
const EXPECTED_COMPATIBILITY_FLAGS = Object.freeze(["nodejs_compat"]);
const EXPECTED_SUBREQUEST_LIMIT = 100_000;
const EXPECTED_SECRET_STORE_ID = "55e6ce4174d645cfa68a6c27eef7847f";
const EXPECTED_SECRET_BINDINGS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
]);
const EXPECTED_STATIC_VARS = Object.freeze({
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
  CF_AIG_ACCOUNT_ID: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
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
  EXEC_ADVANCE_TIMEOUT_MS: "12000",
  EXEC_BATCH_MAX_ATTEMPTS: "4",
  EXEC_BATCH_MAX_MS: "3900000",
  EXEC_MAX_BATCHES: "200",
  EXEC_MAX_EXPLORATION: "0",
  EXEC_MAX_STEPS_PER_PATH: "80",
  EXEC_PER_CASE_TIMEOUT_MS: "1800000", // v38+: raised from 45s after first real walk measured 52-95s healthy walks
  EXEC_WALK_TIMEOUT_MS: "1800000",
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
const BUILD_DYNAMIC_VAR_NAMES = Object.freeze([
  "CANARY_AUTH_SHA256",
  "CANARY_EXPECTED_DOCUMENT_SHA256",
  "CANARY_SOURCE_MANIFEST_SHA256",
  "CANARY_VISUAL_POLICY_SHA256",
  "CANARY_VISUAL_PROFILE",
  "JUDGEMENT_KEY_REGISTRY",
  "VISUAL_MAX_CALLS",
  "VISUAL_MAX_USD",
  "VISUAL_MAX_WAVES",
  "VISUAL_PROVIDER",
  "VISUAL_SHADOW_ENABLED",
  "VISUAL_TIMEOUT_MS",
  "VISUAL_WAVE_BUDGET_MS",
]);
const REVIEWED_DYNAMIC_VAR_NAMES = Object.freeze([
  "CANARY_BUNDLE_INPUTS_MANIFEST_SHA256",
  "CANARY_BUNDLE_METAFILE_SHA256",
  "CANARY_DEPLOYMENT_IDENTITY_SHA256",
  "CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256",
  "CANARY_VERSION_TAG",
]);
export const EXPECTED_CANARY_DYNAMIC_VAR_NAMES = Object.freeze([
  ...BUILD_DYNAMIC_VAR_NAMES,
  ...REVIEWED_DYNAMIC_VAR_NAMES,
].sort());

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 100;
const WRANGLER_TIMEOUT_MS = 120_000;
const WRANGLER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_INHERITED_ENVIRONMENT = Object.freeze([
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_ENV",
]);

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export class WorkflowGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowGateError";
    this.code = code;
  }
}

export function assertPinnedWranglerDescriptor(value) {
  try {
    return assertCompletePinnedWranglerDescriptor(value);
  } catch {
    throw new WorkflowGateError(
      "WRANGLER_PIN_INVALID",
      "pinned Wrangler resolver returned an invalid closed descriptor",
    );
  }
}

export function parseArguments(argv) {
  const parsed = {
    config: null,
    logFile: null,
    expectedProvider: null,
    expectedDocumentSha256: null,
    sourceSnapshotDirectory: null,
    sourceManifestSha256: null,
    reviewedBundleDirectory: null,
    reviewedBundleManifestSha256: null,
    expectedDynamicVarsFile: null,
    help: false,
  };
  const valueFlags = new Set([
    "--config",
    "--log-file",
    "--expected-provider",
    "--expected-document-sha256",
    "--source-snapshot-directory",
    "--source-manifest-sha256",
    "--reviewed-bundle-directory",
    "--reviewed-bundle-manifest-sha256",
    "--expected-dynamic-vars-file",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw new WorkflowGateError("ARGUMENT_UNKNOWN", `unknown argument at position ${index + 1}`);
    }
    if (seen.has(flag)) {
      throw new WorkflowGateError("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    }
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new WorkflowGateError("ARGUMENT_MISSING", `${flag} requires a value`);
    }
    index += 1;
    if (flag === "--config") parsed.config = value;
    if (flag === "--log-file") parsed.logFile = value;
    if (flag === "--expected-provider") parsed.expectedProvider = value;
    if (flag === "--expected-document-sha256") parsed.expectedDocumentSha256 = value;
    if (flag === "--source-snapshot-directory") parsed.sourceSnapshotDirectory = value;
    if (flag === "--source-manifest-sha256") parsed.sourceManifestSha256 = value;
    if (flag === "--reviewed-bundle-directory") parsed.reviewedBundleDirectory = value;
    if (flag === "--reviewed-bundle-manifest-sha256") parsed.reviewedBundleManifestSha256 = value;
    if (flag === "--expected-dynamic-vars-file") parsed.expectedDynamicVarsFile = value;
  }
  if (parsed.help) return parsed;
  if (parsed.config === null) {
    throw new WorkflowGateError("ARGUMENT_MISSING", "--config is required");
  }
  if (parsed.logFile === null) {
    throw new WorkflowGateError("ARGUMENT_MISSING", "--log-file is required");
  }
  if (parsed.expectedProvider === null) {
    throw new WorkflowGateError("ARGUMENT_MISSING", "--expected-provider is required");
  }
  if (parsed.expectedDocumentSha256 === null) {
    throw new WorkflowGateError("ARGUMENT_MISSING", "--expected-document-sha256 is required");
  }
  for (const [name, flag] of [
    ["sourceSnapshotDirectory", "--source-snapshot-directory"],
    ["sourceManifestSha256", "--source-manifest-sha256"],
    ["reviewedBundleDirectory", "--reviewed-bundle-directory"],
    ["reviewedBundleManifestSha256", "--reviewed-bundle-manifest-sha256"],
    ["expectedDynamicVarsFile", "--expected-dynamic-vars-file"],
  ]) {
    if (parsed[name] === null) {
      throw new WorkflowGateError("ARGUMENT_MISSING", `${flag} is required`);
    }
  }
  parsed.expectedProvider = requireExpectedProvider(parsed.expectedProvider);
  parsed.expectedDocumentSha256 = requireExpectedDocumentSha256(parsed.expectedDocumentSha256);
  parsed.sourceManifestSha256 = requireSha256Argument(
    parsed.sourceManifestSha256,
    "--source-manifest-sha256",
  );
  parsed.reviewedBundleManifestSha256 = requireSha256Argument(
    parsed.reviewedBundleManifestSha256,
    "--reviewed-bundle-manifest-sha256",
  );
  return parsed;
}

export function readAndValidateCanaryConfig(configPath, {
  repositoryRoot = REPOSITORY_ROOT,
  expectedProvider,
  expectedDocumentSha256,
  documentBindingMode = "operator-bound",
  reviewedDeployment,
  expectedDynamicVars,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const provider = requireExpectedProvider(expectedProvider);
  const documentSha256 = resolveExpectedDocumentBinding(
    expectedDocumentSha256,
    documentBindingMode,
  );
  const resolved = requireExistingRegularFile(configPath, repositoryRoot, "CONFIG");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new WorkflowGateError("CONFIG_INVALID", "canary config is not strict readable JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowGateError("CONFIG_INVALID", "canary config root is not an object");
  }
  if (parsed.name !== EXPECTED_CANARY_WORKER) {
    throw new WorkflowGateError("CONFIG_WORKER_MISMATCH", "config does not name the isolated canary Worker");
  }
  if (parsed.account_id !== EXPECTED_CLOUDFLARE_ACCOUNT_ID) {
    throw new WorkflowGateError(
      "CONFIG_ACCOUNT_MISMATCH",
      "config does not bind the isolated canary Cloudflare account",
    );
  }
  if (parsed.compliance_region !== "public") {
    throw new WorkflowGateError(
      "CONFIG_CONTROL_PLANE_MISMATCH",
      "config does not bind the public production Cloudflare control plane",
    );
  }
  const deploymentLayout = resolveCanaryDeploymentLayout({
    config: parsed,
    repositoryRoot,
    reviewedDeployment,
    assertPrivatePathImpl,
  });
  const expectedMain = deploymentLayout.main;
  const exactReviewedPaths = reviewedDeployment !== undefined;
  if (
    typeof parsed.main !== "string" ||
    (exactReviewedPaths
      ? parsed.main !== expectedMain.replaceAll("\\", "/")
      : path.resolve(parsed.main) !== path.resolve(expectedMain))
  ) {
    throw new WorkflowGateError(
      "CONFIG_ENTRYPOINT_MISMATCH",
      "config does not use the isolated live-canary wrapper entrypoint",
    );
  }
  requireExistingRegularFile(expectedMain, repositoryRoot, "ENTRYPOINT");
  if (parsed.workers_dev !== true || parsed.preview_urls !== false || "routes" in parsed || "route" in parsed) {
    throw new WorkflowGateError(
      "CONFIG_PUBLICATION_SURFACE_MISMATCH",
      "config does not retain the closed workers.dev-only canary publication surface",
    );
  }
  const assets = parsed.assets;
  const expectedAssetsDirectory = deploymentLayout.assetsDirectory;
  if (
    assets === null ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    assets.binding !== "ASSETS" ||
    typeof assets.directory !== "string" ||
    (exactReviewedPaths
      ? assets.directory !== expectedAssetsDirectory.replaceAll("\\", "/")
      : path.resolve(assets.directory) !== path.resolve(expectedAssetsDirectory)) ||
    !sameStringArray(assets.run_worker_first, ["/api/v2/*", "/runs/*", "/v2/*"])
  ) {
    throw new WorkflowGateError(
      "CONFIG_ASSET_BOUNDARY_MISMATCH",
      "config does not run the canary wrapper first for every application route",
    );
  }
  const r2 = parsed.r2_buckets;
  if (
    !Array.isArray(r2) ||
    r2.length !== 1 ||
    r2[0] === null ||
    typeof r2[0] !== "object" ||
    Array.isArray(r2[0]) ||
    r2[0].binding !== "EVIDENCE" ||
    r2[0].bucket_name !== EXPECTED_CANARY_BUCKET
  ) {
    throw new WorkflowGateError(
      "CONFIG_STORAGE_BOUNDARY_MISMATCH",
      "config does not bind exactly the dedicated visual-canary R2 bucket",
    );
  }
  if (!Array.isArray(parsed.workflows)) {
    throw new WorkflowGateError("CONFIG_WORKFLOWS_INVALID", "config has no Workflow binding list");
  }
  const names = parsed.workflows.map((binding) =>
    binding !== null && typeof binding === "object" && !Array.isArray(binding)
      ? binding.name
      : null,
  );
  if (names.some((name) => typeof name !== "string" || !NAME_PATTERN.test(name))) {
    throw new WorkflowGateError("CONFIG_WORKFLOWS_INVALID", "config has an invalid Workflow name");
  }
  if (new Set(names).size !== names.length) {
    throw new WorkflowGateError("CONFIG_WORKFLOWS_DUPLICATE", "config repeats a Workflow name");
  }
  if (!sameStringSet(names, EXPECTED_CANARY_WORKFLOWS)) {
    throw new WorkflowGateError(
      "CONFIG_WORKFLOWS_MISMATCH",
      "config Workflow names differ from the closed isolated-canary set",
    );
  }
  for (const expected of EXPECTED_CANARY_WORKFLOW_BINDINGS) {
    const actual = parsed.workflows.find((binding) => binding?.name === expected.name);
    if (actual?.binding !== expected.binding || actual?.class_name !== expected.class_name) {
      throw new WorkflowGateError(
        "CONFIG_WORKFLOW_BINDING_MISMATCH",
        "config Workflow binding/class identities differ from the isolated canary contract",
      );
    }
  }
  if (Object.keys(parsed.vars ?? {}).some((name) => name.toUpperCase() === "DEV_SEED")) {
    throw new WorkflowGateError(
      "CONFIG_DEV_SEED_FORBIDDEN",
      "config vars must not carry DEV_SEED in any casing",
    );
  }
  if (
    parsed.version_metadata === null ||
    typeof parsed.version_metadata !== "object" ||
    Array.isArray(parsed.version_metadata) ||
    Object.keys(parsed.version_metadata).length !== 1 ||
    parsed.version_metadata.binding !== "CF_VERSION_METADATA"
  ) {
    throw new WorkflowGateError(
      "CONFIG_VERSION_METADATA_MISMATCH",
      "config must bind the closed canary Worker version-metadata identity",
    );
  }
  assertClosedCanaryPlatformConfig(parsed, reviewedDeployment !== undefined);
  const visualPolicy = assertExactOneCallVisualPolicy(parsed, provider);
  if (
    documentSha256 !== null &&
    parsed.vars.CANARY_EXPECTED_DOCUMENT_SHA256 !== documentSha256
  ) {
    throw new WorkflowGateError(
      "CONFIG_DOCUMENT_SHA256_MISMATCH",
      "config CANARY_EXPECTED_DOCUMENT_SHA256 does not match the operator-selected document",
    );
  }
  assertClosedCanaryVariables(parsed.vars, {
    reviewed: reviewedDeployment !== undefined,
    expectedDynamicVars,
  });
  const bytes = readFileSync(resolved);
  return {
    configPath: resolved,
    configSha256: createHash("sha256").update(bytes).digest("hex"),
    workflowNames: [...EXPECTED_CANARY_WORKFLOWS],
    visualPolicy,
    expectedDocumentSha256: documentSha256,
    deploymentIdentity: deploymentLayout.identity,
  };
}

function resolveCanaryDeploymentLayout({
  config,
  repositoryRoot,
  reviewedDeployment,
  assertPrivatePathImpl,
}) {
  if (reviewedDeployment === undefined) {
    return Object.freeze({
      main: path.join(repositoryRoot, "worker-v2", "tools", "live-canary-worker.ts"),
      assetsDirectory: path.join(repositoryRoot, "worker-v2", "public"),
      identity: Object.freeze({ mode: "legacy-mutable-source" }),
    });
  }
  const requiredKeys = [
    "expectedReviewedBundleManifestSha256",
    "expectedSourceManifestSha256",
    "reviewedBundleDirectory",
    "sourceSnapshotDirectory",
  ].sort();
  if (
    reviewedDeployment === null ||
    typeof reviewedDeployment !== "object" ||
    Array.isArray(reviewedDeployment) ||
    !sameStringArray(Object.keys(reviewedDeployment).sort(), requiredKeys)
  ) {
    throw new WorkflowGateError(
      "REVIEWED_DEPLOYMENT_INVALID",
      "reviewed deployment identity must contain exactly the four sealed-layout fields",
    );
  }
  const {
    expectedReviewedBundleManifestSha256,
    expectedSourceManifestSha256,
    reviewedBundleDirectory,
    sourceSnapshotDirectory,
  } = reviewedDeployment;
  if (
    !/^[a-f0-9]{64}$/u.test(expectedReviewedBundleManifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(expectedSourceManifestSha256)
  ) {
    throw new WorkflowGateError(
      "REVIEWED_DEPLOYMENT_HASH_INVALID",
      "reviewed deployment hashes must be exact lowercase SHA-256 values",
    );
  }

  let snapshot;
  let reviewed;
  try {
    snapshot = verifyCanarySourceSnapshot({
      snapshotDirectory: sourceSnapshotDirectory,
      repositoryRoot,
    });
    reviewed = verifyReviewedCanaryBundle({
      reviewedBundleDirectory,
      snapshotDirectory: snapshot.snapshotDirectory,
      repositoryRoot,
      assertPrivatePathImpl,
    });
  } catch (error) {
    throw new WorkflowGateError(
      "REVIEWED_DEPLOYMENT_UNVERIFIED",
      error instanceof Error ? error.message : "reviewed deployment could not be verified",
    );
  }
  if (
    snapshot.manifestSha256 !== expectedSourceManifestSha256 ||
    reviewed.manifestSha256 !== expectedReviewedBundleManifestSha256
  ) {
    throw new WorkflowGateError(
      "REVIEWED_DEPLOYMENT_HASH_MISMATCH",
      "reviewed deployment bytes do not match the independently selected identities",
    );
  }
  const expectedRules = independentlyGroupedReviewedRules(reviewed.modules);
  const vars = config.vars;
  if (
    config.no_bundle !== true ||
    config.find_additional_modules !== (reviewed.modules.length > 0) ||
    config.preserve_file_names !== false ||
    typeof config.base_dir !== "string" ||
    config.base_dir !== reviewed.reviewedBundleDirectory.replaceAll("\\", "/") ||
    JSON.stringify(config.rules) !== JSON.stringify(expectedRules) ||
    "build" in config ||
    "minify" in config ||
    "tsconfig" in config ||
    vars?.CANARY_SOURCE_MANIFEST_SHA256 !== snapshot.manifestSha256 ||
    vars?.CANARY_BUNDLE_INPUTS_MANIFEST_SHA256 !== reviewed.bundleInputsManifestSha256 ||
    vars?.CANARY_BUNDLE_METAFILE_SHA256 !== reviewed.manifest.metafileSha256 ||
    vars?.CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256 !== reviewed.manifestSha256
  ) {
    throw new WorkflowGateError(
      "REVIEWED_DEPLOYMENT_CONFIG_MISMATCH",
      "config does not consume exactly the reviewed no-bundle entry/module identity",
    );
  }
  return Object.freeze({
    main: reviewed.entryPath,
    assetsDirectory: path.join(snapshot.snapshotDirectory, "worker-v2", "public"),
    identity: Object.freeze({
      mode: "reviewed-no-bundle",
      sourceManifestSha256: snapshot.manifestSha256,
      bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
      bundleMetafileSha256: reviewed.manifest.metafileSha256,
      reviewedBundleManifestSha256: reviewed.manifestSha256,
    }),
  });
}

function independentlyGroupedReviewedRules(modules) {
  const grouped = new Map();
  for (const module of modules) {
    const globs = grouped.get(module.type) ?? [];
    globs.push(module.path);
    grouped.set(module.type, globs);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, globs]) => ({ type, globs: [...globs].sort(), fallthrough: false }));
}

export function assertWranglerVersion(result) {
  assertSuccessfulControlPlaneResult(result, "WRANGLER_VERSION_UNAVAILABLE", "Wrangler version could not be verified");
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).trim();
  if (output !== EXPECTED_WRANGLER_VERSION) {
    throw new WorkflowGateError(
      "WRANGLER_VERSION_MISMATCH",
      `deployment gate requires Wrangler ${EXPECTED_WRANGLER_VERSION}`,
    );
  }
}

export function assertWranglerAccount(result) {
  assertSuccessfulControlPlaneResult(result, "WRANGLER_ACCOUNT_UNAVAILABLE", "Cloudflare account identity could not be verified");
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const accountIds = [...new Set(output.match(/\b[a-f0-9]{32}\b/giu) ?? [])];
  if (accountIds.length !== 1 || accountIds[0].toLowerCase() !== EXPECTED_CLOUDFLARE_ACCOUNT_ID) {
    throw new WorkflowGateError(
      "WRANGLER_ACCOUNT_MISMATCH",
      "authenticated Cloudflare account does not match the isolated canary account",
    );
  }
}

export function assertWranglerReportedNoInstances(result, workflowName, status) {
  if (result === null || typeof result !== "object") {
    throw new WorkflowGateError("WRANGLER_RESULT_INVALID", `could not inspect ${status} ${workflowName}`);
  }
  if (result.error !== undefined) {
    throw new WorkflowGateError("WRANGLER_LAUNCH_FAILED", `could not enumerate ${status} ${workflowName}`);
  }
  if (result.status !== 0) {
    throw new WorkflowGateError("WRANGLER_QUERY_FAILED", `could not enumerate ${status} ${workflowName}`);
  }
  const output = stripAnsi(`${typeof result.stdout === "string" ? result.stdout : ""}\n${
    typeof result.stderr === "string" ? result.stderr : ""
  }`);
  const sentence = `There are no instances in workflow "${workflowName}".`;
  const occurrences = output.split(sentence).length - 1;
  if (occurrences !== 1) {
    throw new WorkflowGateError(
      "WRANGLER_EMPTY_PROOF_AMBIGUOUS",
      `Wrangler did not provide one exact empty proof for ${status} ${workflowName}`,
    );
  }
  return true;
}

export function inspectWranglerHistoryPage(result, workflowName, page, {
  pageSize = HISTORY_PAGE_SIZE,
} = {}) {
  if (result === null || typeof result !== "object") {
    throw new WorkflowGateError("WRANGLER_RESULT_INVALID", `could not inspect history page ${page} for ${workflowName}`);
  }
  if (result.error !== undefined) {
    throw new WorkflowGateError("WRANGLER_LAUNCH_FAILED", `could not enumerate history page ${page} for ${workflowName}`);
  }
  if (result.status !== 0) {
    throw new WorkflowGateError("WRANGLER_QUERY_FAILED", `could not enumerate history page ${page} for ${workflowName}`);
  }
  const output = stripAnsi(`${typeof result.stdout === "string" ? result.stdout : ""}\n${
    typeof result.stderr === "string" ? result.stderr : ""
  }`);
  const firstPageEmpty = `There are no instances in workflow "${workflowName}".`;
  const laterPageEmpty = `No instances found on page ${page}.`;
  const firstEmptyCount = output.split(firstPageEmpty).length - 1;
  const laterEmptyCount = output.split(laterPageEmpty).length - 1;
  if (firstEmptyCount === 1 && laterEmptyCount === 0 && page === 1) {
    return { rowCount: 0, complete: true };
  }
  if (laterEmptyCount === 1 && firstEmptyCount === 0 && page > 1) {
    return { rowCount: 0, complete: true };
  }
  if (firstEmptyCount !== 0 || laterEmptyCount !== 0) {
    throw new WorkflowGateError(
      "WRANGLER_HISTORY_PROOF_AMBIGUOUS",
      `Wrangler returned a contradictory empty history proof for page ${page} of ${workflowName}`,
    );
  }

  // These are Wrangler 4.106.0's display labels for every nonterminal/unknown state. The
  // filtered queries remain independently required; this all-instance pass catches an ignored
  // filter, an unfilterable `unknown`, and a later history page a page-1-only check would miss.
  if (/\b(?:Queued|Running|Paused|Waiting(?: for Pause)?|Unknown)\b/u.test(output)) {
    throw new WorkflowGateError(
      "WRANGLER_NONTERMINAL_INSTANCE_FOUND",
      `Wrangler reported a nonterminal or unknown instance on page ${page} of ${workflowName}`,
    );
  }
  const escapedPage = String(page).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const shown = [...output.matchAll(new RegExp(`Showing ([0-9]+) instances? from page ${escapedPage}:`, "gu"))];
  if (shown.length !== 1) {
    throw new WorkflowGateError(
      "WRANGLER_HISTORY_PROOF_AMBIGUOUS",
      `Wrangler did not provide one exact row count for page ${page} of ${workflowName}`,
    );
  }
  const rowCount = Number(shown[0][1]);
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > pageSize) {
    throw new WorkflowGateError(
      "WRANGLER_HISTORY_COUNT_INVALID",
      `Wrangler returned an invalid row count for page ${page} of ${workflowName}`,
    );
  }
  const terminalLabels = output.match(/\b(?:Completed|Errored|Terminated)\b/gu) ?? [];
  if (terminalLabels.length !== rowCount) {
    throw new WorkflowGateError(
      "WRANGLER_HISTORY_ROWS_INVALID",
      `Wrangler history rows do not match the declared count on page ${page} of ${workflowName}`,
    );
  }
  return { rowCount, complete: rowCount < pageSize };
}

export function runWorkflowGate({
  configPath,
  logFile,
  expectedProvider,
  expectedDocumentSha256,
  expectedDynamicVars,
  reviewedDeployment,
  repositoryRoot = REPOSITORY_ROOT,
  workerRoot = WORKER_ROOT,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  resolvePinnedWranglerCommandImpl = resolvePinnedWranglerCommand,
  assertPrivatePathImpl = assertPrivateLocalPath,
  verifyAuditLogImpl = verifyAuditLog,
} = {}) {
  if (expectedDynamicVars === undefined) {
    throw new WorkflowGateError(
      "EXPECTED_DYNAMIC_VARS_INVALID",
      "the live deployment gate requires independently constructed exact dynamic vars",
    );
  }
  const config = readAndValidateCanaryConfig(configPath, {
    repositoryRoot,
    expectedProvider,
    expectedDocumentSha256,
    expectedDynamicVars,
    reviewedDeployment,
    assertPrivatePathImpl,
  });
  const resolvedLogFile = requireNewFilePath(logFile, repositoryRoot, "LOG");
  assertPrivatePathImpl(config.configPath, repositoryRoot);
  assertPrivatePathImpl(path.dirname(resolvedLogFile), repositoryRoot, { directory: true });
  let wranglerCommand;
  try {
    wranglerCommand = assertPinnedWranglerDescriptor(resolvePinnedWranglerCommandImpl());
  } catch (error) {
    if (error instanceof WorkflowGateError) throw error;
    throw new WorkflowGateError(
      "WRANGLER_PIN_INVALID",
      "pinned Wrangler command could not be resolved",
    );
  }
  const childEnvironment = { ...environment };
  const forbiddenNames = new Set(FORBIDDEN_INHERITED_ENVIRONMENT.map((name) => name.toUpperCase()));
  for (const name of Object.keys(childEnvironment)) {
    if (forbiddenNames.has(name.toUpperCase())) delete childEnvironment[name];
  }
  Object.assign(childEnvironment, {
    WRANGLER_API_ENVIRONMENT: "production",
    CLOUDFLARE_COMPLIANCE_REGION: "public",
    WRANGLER_LOG_PATH: resolvedLogFile,
    WRANGLER_WRITE_LOGS: "true",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG: "log",
  });
  const childOptions = {
    cwd: workerRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: WRANGLER_TIMEOUT_MS,
    maxBuffer: WRANGLER_MAX_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  };
  const invokeWrangler = (args) => spawnSyncImpl(
    wranglerCommand.command,
    [...wranglerCommand.argsPrefix, ...args],
    childOptions,
  );
  let versionResult;
  let accountResult;
  try {
    versionResult = invokeWrangler(["--version"]);
    assertWranglerVersion(versionResult);
    accountResult = invokeWrangler(["whoami"]);
    assertWranglerAccount(accountResult);
  } catch (error) {
    if (error instanceof WorkflowGateError) throw error;
    throw new WorkflowGateError("WRANGLER_IDENTITY_UNAVAILABLE", "Wrangler identity preflight could not start");
  }
  const queries = [];
  for (const workflowName of EXPECTED_CANARY_WORKFLOWS) {
    for (const status of FILTERABLE_NONTERMINAL_STATUSES) {
      const args = [
        "workflows",
        "instances",
        "list",
        workflowName,
        "--status",
        status,
        "--page",
        "1",
        "--per-page",
        "100",
        "--config",
        config.configPath,
      ];
      let result;
      try {
        result = invokeWrangler(args);
      } catch {
        throw new WorkflowGateError("WRANGLER_LAUNCH_FAILED", `could not enumerate ${status} ${workflowName}`);
      }
      assertWranglerReportedNoInstances(result, workflowName, status);
      queries.push({ workflowName, status, state: "no-instances" });
    }

    let historyComplete = false;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const args = [
        "workflows",
        "instances",
        "list",
        workflowName,
        "--page",
        String(page),
        "--per-page",
        String(HISTORY_PAGE_SIZE),
        "--config",
        config.configPath,
      ];
      let result;
      try {
        result = invokeWrangler(args);
      } catch {
        throw new WorkflowGateError(
          "WRANGLER_LAUNCH_FAILED",
          `could not enumerate history page ${page} for ${workflowName}`,
        );
      }
      const inspection = inspectWranglerHistoryPage(result, workflowName, page);
      queries.push({
        workflowName,
        status: "all",
        page,
        rowCount: inspection.rowCount,
        state: "terminal-history-only",
      });
      if (inspection.complete) {
        historyComplete = true;
        break;
      }
    }
    if (!historyComplete) {
      throw new WorkflowGateError(
        "WRANGLER_HISTORY_LIMIT_EXCEEDED",
        `Workflow history for ${workflowName} exceeded the closed ${MAX_HISTORY_PAGES}-page audit limit`,
      );
    }
  }
  const logAudit = verifyAuditLogImpl(resolvedLogFile, repositoryRoot, assertPrivatePathImpl);
  return {
    workerName: EXPECTED_CANARY_WORKER,
    accountId: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    wranglerVersion: EXPECTED_WRANGLER_VERSION,
    wranglerPin: {
      ...structuredClone(wranglerCommand.evidence),
      version: wranglerCommand.version,
    },
    configSha256: config.configSha256,
    expectedDocumentSha256: config.expectedDocumentSha256,
    visualPolicy: config.visualPolicy,
    workflowNames: [...EXPECTED_CANARY_WORKFLOWS],
    statuses: [...ACTIVE_WORKFLOW_STATUSES],
    queryCount: queries.length,
    queries,
    logAudit,
  };
}

function requireExistingRegularFile(candidate, repositoryRoot, label) {
  const root = realpathSync(repositoryRoot);
  const resolved = path.resolve(candidate);
  requireWithinRoot(resolved, root, label);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new WorkflowGateError(`${label}_UNAVAILABLE`, `${label.toLowerCase()} path is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkflowGateError(`${label}_INVALID`, `${label.toLowerCase()} path is not a regular file`);
  }
  if (realpathSync(resolved) !== resolved) {
    throw new WorkflowGateError(`${label}_INVALID`, `${label.toLowerCase()} path does not resolve exactly`);
  }
  return resolved;
}

function requireNewFilePath(candidate, repositoryRoot, label) {
  const root = realpathSync(repositoryRoot);
  const resolved = path.resolve(candidate);
  requireWithinRoot(resolved, root, label);
  const parent = path.dirname(resolved);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    throw new WorkflowGateError(`${label}_PARENT_UNAVAILABLE`, `${label.toLowerCase()} parent is unavailable`);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    throw new WorkflowGateError(`${label}_PARENT_INVALID`, `${label.toLowerCase()} parent is not an exact regular directory`);
  }
  try {
    lstatSync(resolved);
    throw new WorkflowGateError(`${label}_EXISTS`, `${label.toLowerCase()} path already exists`);
  } catch (error) {
    if (error instanceof WorkflowGateError) throw error;
    if (error?.code !== "ENOENT") {
      throw new WorkflowGateError(`${label}_UNAVAILABLE`, `${label.toLowerCase()} path cannot be inspected`);
    }
  }
  return resolved;
}

function requireWithinRoot(candidate, root, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkflowGateError(`${label}_OUTSIDE_REPOSITORY`, `${label.toLowerCase()} path is outside the repository`);
  }
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameStringArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function requireExpectedProvider(value) {
  if (!EXPECTED_CANARY_VISUAL_PROVIDERS.includes(value)) {
    throw new WorkflowGateError(
      "EXPECTED_PROVIDER_INVALID",
      `--expected-provider must be one of ${EXPECTED_CANARY_VISUAL_PROVIDERS.join(", ")}`,
    );
  }
  return value;
}

function requireExpectedDocumentSha256(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkflowGateError(
      "EXPECTED_DOCUMENT_SHA256_INVALID",
      "--expected-document-sha256 must be exactly 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

function requireSha256Argument(value, flag) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkflowGateError(
      "ARGUMENT_SHA256_INVALID",
      `${flag} must be exactly 64 lowercase hexadecimal characters`,
    );
  }
  return value;
}

function resolveExpectedDocumentBinding(value, mode) {
  if (mode === "operator-bound") return requireExpectedDocumentSha256(value);
  if (
    mode === LEGACY_REMOTE_SECRET_AUDIT_DOCUMENT_BINDING_MODE &&
    value === undefined
  ) return null;
  throw new WorkflowGateError(
    "DOCUMENT_BINDING_MODE_INVALID",
    "document binding mode is not valid for this config inspection",
  );
}

function assertClosedCanaryPlatformConfig(config, reviewed) {
  const expectedTopLevel = [
    "account_id",
    "ai",
    "assets",
    "browser",
    "compatibility_date",
    "compatibility_flags",
    "compliance_region",
    "limits",
    "main",
    "name",
    "observability",
    "preview_urls",
    "r2_buckets",
    "rules",
    "secrets_store_secrets",
    "vars",
    "version_metadata",
    "workers_dev",
    "workflows",
    ...(reviewed
      ? ["base_dir", "find_additional_modules", "no_bundle", "preserve_file_names"]
      : []),
  ].sort();
  if (!sameStringArray(Object.keys(config).sort(), expectedTopLevel)) {
    throw new WorkflowGateError(
      "CONFIG_TOP_LEVEL_SCHEMA_MISMATCH",
      "config has a missing or unexpected top-level Cloudflare capability",
    );
  }
  if (
    config.compatibility_date !== EXPECTED_COMPATIBILITY_DATE ||
    !sameStringArray(config.compatibility_flags, EXPECTED_COMPATIBILITY_FLAGS)
  ) {
    throw new WorkflowGateError(
      "CONFIG_COMPATIBILITY_MISMATCH",
      "config compatibility date or flags differ from the closed canary runtime",
    );
  }
  if (JSON.stringify(config.browser) !== JSON.stringify({ binding: "BROWSER" })) {
    throw new WorkflowGateError(
      "CONFIG_BROWSER_BINDING_MISMATCH",
      "config browser binding is missing, remote-enabled, or open",
    );
  }
  if (JSON.stringify(config.ai) !== JSON.stringify({ binding: "AI" })) {
    throw new WorkflowGateError(
      "CONFIG_AI_BINDING_MISMATCH",
      "config AI binding is missing, remote-enabled, or open",
    );
  }
  if (JSON.stringify(config.limits) !== JSON.stringify({ subrequests: EXPECTED_SUBREQUEST_LIMIT })) {
    throw new WorkflowGateError(
      "CONFIG_LIMITS_MISMATCH",
      "config subrequest limit differs from the exact canary ceiling",
    );
  }
  if (JSON.stringify(config.observability) !== JSON.stringify({ enabled: true })) {
    throw new WorkflowGateError(
      "CONFIG_OBSERVABILITY_MISMATCH",
      "config observability posture differs from the closed canary contract",
    );
  }
  if (
    !isExactObject(config.assets, ["binding", "directory", "run_worker_first"]) ||
    !Array.isArray(config.r2_buckets) ||
    config.r2_buckets.some((binding) => !isExactObject(binding, ["binding", "bucket_name"])) ||
    !Array.isArray(config.workflows) ||
    config.workflows.some((binding) => !isExactObject(binding, ["binding", "class_name", "name"]))
  ) {
    throw new WorkflowGateError(
      "CONFIG_BINDING_SCHEMA_MISMATCH",
      "an assets, storage, or Workflow binding contains a missing or unexpected field",
    );
  }
  const expectedSecrets = EXPECTED_SECRET_BINDINGS.map((binding) => ({
    binding,
    store_id: EXPECTED_SECRET_STORE_ID,
    secret_name: binding,
  }));
  if (JSON.stringify(config.secrets_store_secrets) !== JSON.stringify(expectedSecrets)) {
    throw new WorkflowGateError(
      "CONFIG_SECRET_STORE_MISMATCH",
      "config Secrets Store identities differ from the exact canary binding set",
    );
  }
  if (!reviewed && JSON.stringify(config.rules) !== JSON.stringify([
    { type: "Text", globs: ["**/report.css"], fallthrough: false },
  ])) {
    throw new WorkflowGateError(
      "CONFIG_RULES_MISMATCH",
      "snapshot build rules differ from the one required text-module rule",
    );
  }
}

function assertClosedCanaryVariables(vars, { reviewed, expectedDynamicVars }) {
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
    throw new WorkflowGateError("CONFIG_VARS_INVALID", "config vars is not one closed object");
  }
  const reviewedNames = reviewed
    ? (expectedDynamicVars === undefined && vars.CANARY_DEPLOYMENT_IDENTITY_SHA256 === undefined
        ? REVIEWED_DYNAMIC_VAR_NAMES.filter((name) => name !== "CANARY_DEPLOYMENT_IDENTITY_SHA256")
        : REVIEWED_DYNAMIC_VAR_NAMES)
    : [];
  const dynamicNames = [...BUILD_DYNAMIC_VAR_NAMES, ...reviewedNames].sort();
  const expectedNames = [...Object.keys(EXPECTED_STATIC_VARS), ...dynamicNames].sort();
  if (!sameStringArray(Object.keys(vars).sort(), expectedNames)) {
    throw new WorkflowGateError(
      "CONFIG_VAR_SCHEMA_MISMATCH",
      "config vars has a missing or unexpected runtime capability",
    );
  }
  for (const [name, expected] of Object.entries(EXPECTED_STATIC_VARS)) {
    if (vars[name] !== expected) {
      throw new WorkflowGateError(
        "CONFIG_STATIC_VAR_MISMATCH",
        `config ${name} differs from the exact canary runtime policy`,
      );
    }
  }
  for (const name of dynamicNames.filter((candidate) => candidate.includes("SHA256"))) {
    if (typeof vars[name] !== "string" || !/^[a-f0-9]{64}$/u.test(vars[name])) {
      throw new WorkflowGateError(
        "CONFIG_DYNAMIC_VAR_INVALID",
        `config ${name} is not an exact lowercase SHA-256 value`,
      );
    }
  }
  assertJudgementRegistryShape(vars.JUDGEMENT_KEY_REGISTRY);
  if (expectedDynamicVars !== undefined) {
    if (
      expectedDynamicVars === null ||
      typeof expectedDynamicVars !== "object" ||
      Array.isArray(expectedDynamicVars) ||
      !sameStringArray(Object.keys(expectedDynamicVars).sort(), dynamicNames)
    ) {
      throw new WorkflowGateError(
        "EXPECTED_DYNAMIC_VARS_INVALID",
        "expected dynamic vars must contain exactly the closed build/deployment identity set",
      );
    }
    for (const name of dynamicNames) {
      if (typeof expectedDynamicVars[name] !== "string" || vars[name] !== expectedDynamicVars[name]) {
        throw new WorkflowGateError(
          "CONFIG_DYNAMIC_VAR_MISMATCH",
          `config ${name} differs from the independently selected dynamic identity`,
        );
      }
    }
  }
}

function assertJudgementRegistryShape(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 * 1024) {
    throw new WorkflowGateError("CONFIG_JUDGEMENT_REGISTRY_INVALID", "judgement registry is absent or unbounded");
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new WorkflowGateError("CONFIG_JUDGEMENT_REGISTRY_INVALID", "judgement registry is not valid JSON");
  }
  if (!isExactObject(registry, ["keys"]) || !isRecord(registry.keys) || Object.keys(registry.keys).length === 0) {
    throw new WorkflowGateError("CONFIG_JUDGEMENT_REGISTRY_INVALID", "judgement registry has no closed key set");
  }
  for (const [keyId, entry] of Object.entries(registry.keys)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(keyId) ||
      !isRecord(entry) ||
      !sameStringArray(Object.keys(entry).sort(), ["note", "publicKeySpki", "trust"]) ||
      typeof entry.publicKeySpki !== "string" ||
      entry.publicKeySpki.length === 0 ||
      !["fixture", "production"].includes(entry.trust) ||
      typeof entry.note !== "string"
    ) {
      throw new WorkflowGateError("CONFIG_JUDGEMENT_REGISTRY_INVALID", "judgement registry contains an open key entry");
    }
  }
}

function isExactObject(value, keys) {
  return isRecord(value) && sameStringArray(Object.keys(value).sort(), [...keys].sort());
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactOneCallVisualPolicy(config, expectedProvider) {
  const vars = config.vars;
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
    throw new WorkflowGateError(
      "CONFIG_VISUAL_POLICY_INVALID",
      "config has no visual policy vars object",
    );
  }

  // FIX (review canary-security, latent finding): DEV_SEED is the single switch that promotes
  // fixture-trust signing keys — the exact var generate-live-canary-config.mjs deletes from every
  // generated config (its vars deletion list is exactly DEV_SEED). The gate never asserted its
  // absence, so a hand-edited or stale config could clear this interlock with fixture trust
  // enabled. Fail closed on any casing: Worker var lookup is exact-case, but no casing of a
  // dev-seed-shaped key has a legitimate reading in a deployable canary config.
  for (const name of Object.keys(vars)) {
    if (name.toUpperCase() === "DEV_SEED") {
      throw new WorkflowGateError(
        "CONFIG_DEV_SEED_FORBIDDEN",
        "config vars must not carry DEV_SEED; fixture-trust signing keys are never deployable",
      );
    }
  }

  const expected = canaryVisualPolicy(expectedProvider, 1);
  if (
    expected.provider !== expectedProvider ||
    expected.maximumCalls !== "1" ||
    expected.profile !== "semantic-smoke-one-call"
  ) {
    throw new WorkflowGateError(
      "CANARY_VISUAL_POLICY_INVALID",
      "the shared canary policy generator no longer describes an exact one-call smoke profile",
    );
  }
  // The runtime resolver dispatches only on VISUAL_PROVIDER and has no fallback branch. Keep the
  // enable bit in this closed projection too: otherwise an apparently sealed provider policy
  // could be deployed inert and misreported as a provider smoke attempt.
  const fields = {
    VISUAL_SHADOW_ENABLED: "true",
    VISUAL_PROVIDER: expected.provider,
    VISUAL_MAX_CALLS: expected.maximumCalls,
    VISUAL_MAX_USD: expected.maximumUsd,
    VISUAL_TIMEOUT_MS: expected.timeoutMs,
    VISUAL_WAVE_BUDGET_MS: expected.waveBudgetMs,
    VISUAL_MAX_WAVES: expected.maximumWaves,
    CANARY_VISUAL_PROFILE: expected.profile,
    CANARY_VISUAL_POLICY_SHA256: expected.sha256,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (vars[name] !== value) {
      throw new WorkflowGateError(
        "CONFIG_VISUAL_POLICY_MISMATCH",
        `config ${name} does not match the exact one-call ${expectedProvider} canary policy`,
      );
    }
  }

  return Object.freeze({
    provider: expected.provider,
    profile: expected.profile,
    maximumCalls: expected.maximumCalls,
    maximumUsd: expected.maximumUsd,
    sha256: expected.sha256,
  });
}

function assertSuccessfulControlPlaneResult(result, code, message) {
  if (result === null || typeof result !== "object" || result.error !== undefined || result.status !== 0) {
    throw new WorkflowGateError(code, message);
  }
}

function readExpectedDynamicVarsFile(candidate, repositoryRoot, assertPrivatePathImpl) {
  const resolved = requireExistingRegularFile(candidate, repositoryRoot, "EXPECTED_DYNAMIC_VARS");
  assertPrivatePathImpl(resolved, repositoryRoot);
  const bytes = readFileSync(resolved);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new WorkflowGateError(
      "EXPECTED_DYNAMIC_VARS_INVALID",
      "expected dynamic vars file is empty or exceeds its closed byte limit",
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorkflowGateError(
      "EXPECTED_DYNAMIC_VARS_INVALID",
      "expected dynamic vars file is not strict JSON",
    );
  }
  return value;
}

export function verifyAuditLog(logFile, repositoryRoot, assertPrivatePathImpl = assertPrivateLocalPath) {
  const resolved = requireExistingRegularFile(logFile, repositoryRoot, "LOG");
  assertPrivatePathImpl(resolved, repositoryRoot);
  const bytes = readFileSync(resolved);
  if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
    throw new WorkflowGateError("LOG_INVALID", "Wrangler audit log is empty or exceeds the closed size limit");
  }
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function stripAnsi(value) {
  // Closed copy of the CSI/OSC forms Wrangler uses for color, links and warning formatting.
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function usage() {
  return [
    "Usage:",
    "  node tools/assert-no-active-canary-workflows.mjs --config <generated-canary.json> --log-file <new-log-path> \\",
    "    --expected-provider <workers-ai-gemma4|cloudflare-gateway-gemini|mistral-medium35-direct> \\",
    "    --expected-document-sha256 <64-lowercase-hex>",
    "    --source-snapshot-directory <sealed private snapshot> \\",
    "    --source-manifest-sha256 <64-lowercase-hex> \\",
    "    --reviewed-bundle-directory <sealed reviewed bundle> \\",
    "    --reviewed-bundle-manifest-sha256 <64-lowercase-hex> \\",
    "    --expected-dynamic-vars-file <private exact JSON>",
    "",
    "Read-only deployment interlock. It first pins the generated config to the operator-named",
    "document digest and one-call visual provider policy, then checks queued, running, paused,",
    "waiting, waitingForPause,",
    "and unfilterable unknown states for both isolated canary Workflow namespaces. Any policy drift,",
    "auth error, CLI format change, unknown state, or listed nonterminal instance fails closed. The",
    "log file must be a new path inside the repository.",
    "",
  ].join("\n");
}

export async function runCli(argv, dependencies = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) return { exitCode: 0, stdout: usage(), stderr: "" };
    const repositoryRoot = dependencies.repositoryRoot ?? REPOSITORY_ROOT;
    const assertPrivatePathImpl = dependencies.assertPrivatePathImpl ?? assertPrivateLocalPath;
    const expectedDynamicVars = readExpectedDynamicVarsFile(
      options.expectedDynamicVarsFile,
      repositoryRoot,
      assertPrivatePathImpl,
    );
    const audit = runWorkflowGate({
      ...dependencies,
      configPath: options.config,
      logFile: options.logFile,
      expectedProvider: options.expectedProvider,
      expectedDocumentSha256: options.expectedDocumentSha256,
      expectedDynamicVars,
      reviewedDeployment: {
        sourceSnapshotDirectory: path.resolve(options.sourceSnapshotDirectory),
        reviewedBundleDirectory: path.resolve(options.reviewedBundleDirectory),
        expectedSourceManifestSha256: options.sourceManifestSha256,
        expectedReviewedBundleManifestSha256: options.reviewedBundleManifestSha256,
      },
    });
    return { exitCode: 0, stdout: `${JSON.stringify(audit, null, 2)}\n`, stderr: "" };
  } catch (error) {
    const code = error instanceof WorkflowGateError ? error.code : "WORKFLOW_GATE_FAILED";
    const message = error instanceof Error ? error.message : "Workflow deployment interlock failed";
    return { exitCode: 1, stdout: "", stderr: `Workflow deployment interlock refused [${code}]: ${message}\n` };
  }
}

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
