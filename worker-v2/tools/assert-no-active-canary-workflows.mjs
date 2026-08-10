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
import { assertPrivateLocalPath } from "./private-local-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");
export const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
export const EXPECTED_CANARY_WORKER = "survey-qa-v2-visual-canary";
export const EXPECTED_CANARY_BUCKET = "survey-qa-artifacts-visual-canary";
export const EXPECTED_CLOUDFLARE_ACCOUNT_ID = "f0cbb2076e484454e6567789b9be85d8";
export const EXPECTED_WRANGLER_VERSION = "4.106.0";
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

export function parseArguments(argv) {
  const parsed = { config: null, logFile: null, expectedProvider: null, help: false };
  const valueFlags = new Set(["--config", "--log-file", "--expected-provider"]);
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
  parsed.expectedProvider = requireExpectedProvider(parsed.expectedProvider);
  return parsed;
}

export function readAndValidateCanaryConfig(configPath, {
  repositoryRoot = REPOSITORY_ROOT,
  expectedProvider,
} = {}) {
  const provider = requireExpectedProvider(expectedProvider);
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
  const expectedMain = path.join(repositoryRoot, "worker-v2", "tools", "live-canary-worker.ts");
  if (typeof parsed.main !== "string" || path.resolve(parsed.main) !== path.resolve(expectedMain)) {
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
  const expectedAssetsDirectory = path.join(repositoryRoot, "worker-v2", "public");
  if (
    assets === null ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    assets.binding !== "ASSETS" ||
    typeof assets.directory !== "string" ||
    path.resolve(assets.directory) !== path.resolve(expectedAssetsDirectory) ||
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
  const visualPolicy = assertExactOneCallVisualPolicy(parsed, provider);
  const bytes = readFileSync(resolved);
  return {
    configPath: resolved,
    configSha256: createHash("sha256").update(bytes).digest("hex"),
    workflowNames: [...EXPECTED_CANARY_WORKFLOWS],
    visualPolicy,
  };
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
  repositoryRoot = REPOSITORY_ROOT,
  workerRoot = WORKER_ROOT,
  environment = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  assertPrivatePathImpl = assertPrivateLocalPath,
  verifyAuditLogImpl = verifyAuditLog,
} = {}) {
  const config = readAndValidateCanaryConfig(configPath, { repositoryRoot, expectedProvider });
  const resolvedLogFile = requireNewFilePath(logFile, repositoryRoot, "LOG");
  assertPrivatePathImpl(config.configPath, repositoryRoot);
  assertPrivatePathImpl(path.dirname(resolvedLogFile), repositoryRoot, { directory: true });
  const npxCommand = platform === "win32" ? "npx.cmd" : "npx";
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
  let versionResult;
  let accountResult;
  try {
    versionResult = spawnSyncImpl(npxCommand, ["--no-install", "wrangler", "--version"], childOptions);
    assertWranglerVersion(versionResult);
    accountResult = spawnSyncImpl(npxCommand, ["--no-install", "wrangler", "whoami"], childOptions);
    assertWranglerAccount(accountResult);
  } catch (error) {
    if (error instanceof WorkflowGateError) throw error;
    throw new WorkflowGateError("WRANGLER_IDENTITY_UNAVAILABLE", "Wrangler identity preflight could not start");
  }
  const queries = [];
  for (const workflowName of EXPECTED_CANARY_WORKFLOWS) {
    for (const status of FILTERABLE_NONTERMINAL_STATUSES) {
      const args = [
        "--no-install",
        "wrangler",
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
        result = spawnSyncImpl(npxCommand, args, childOptions);
      } catch {
        throw new WorkflowGateError("WRANGLER_LAUNCH_FAILED", `could not enumerate ${status} ${workflowName}`);
      }
      assertWranglerReportedNoInstances(result, workflowName, status);
      queries.push({ workflowName, status, state: "no-instances" });
    }

    let historyComplete = false;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const args = [
        "--no-install",
        "wrangler",
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
        result = spawnSyncImpl(npxCommand, args, childOptions);
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
    configSha256: config.configSha256,
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

function assertExactOneCallVisualPolicy(config, expectedProvider) {
  const vars = config.vars;
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
    throw new WorkflowGateError(
      "CONFIG_VISUAL_POLICY_INVALID",
      "config has no visual policy vars object",
    );
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
    "    --expected-provider <workers-ai-gemma4|cloudflare-gateway-gemini|mistral-medium35-direct>",
    "",
    "Read-only deployment interlock. It first pins the generated config to the explicitly named",
    "one-call visual provider policy, then checks queued, running, paused, waiting, waitingForPause,",
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
    const audit = runWorkflowGate({
      ...dependencies,
      configPath: options.config,
      logFile: options.logFile,
      expectedProvider: options.expectedProvider,
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
