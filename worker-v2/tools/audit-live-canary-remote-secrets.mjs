#!/usr/bin/env node

/**
 * Read-only post-deploy audit for the isolated visual canary's Worker secrets.
 *
 * Assumption (declared and checked): Wrangler 4.106.0's `secret list --format json`
 * response is an array of closed `{ name, type }` records. The command returns names and
 * binding types only; it does not retrieve secret values. Any CLI, schema, identity, control
 * plane, or set drift fails closed, and raw command output is never printed or persisted by
 * this adapter. Only known-safe names, counts, and SHA-256 evidence leave the process.
 */

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  EXPECTED_CANARY_WORKER,
  EXPECTED_CANARY_VISUAL_PROVIDERS,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  EXPECTED_WRANGLER_VERSION,
  LEGACY_REMOTE_SECRET_AUDIT_DOCUMENT_BINDING_MODE,
  REPOSITORY_ROOT,
  WORKER_ROOT,
  assertWranglerAccount,
  assertWranglerVersion,
  readAndValidateCanaryConfig,
  verifyAuditLog as verifyWranglerAuditLog,
} from "./assert-no-active-canary-workflows.mjs";
import { buildPinnedDeployEnvironment } from "./canary-post-deploy-attestation.mjs";
import {
  assertPinnedWranglerDescriptor,
  resolvePinnedWranglerCommand,
  verifyPinnedWranglerCommand,
} from "./pinned-wrangler-command.mjs";
import { assertPrivateLocalPath } from "./private-local-output.mjs";

export const EXPECTED_SIGNER_SECRET_NAMES = Object.freeze([
  "JUDGEMENT_SIGNING_KEY",
  "JUDGEMENT_SIGNING_KEY_ID",
  "RECORD_SIGNING_KEY",
  "RECORD_SIGNING_KEY_ID",
]);

export const FORBIDDEN_INHERITED_CONTROL_PLANE_ENVIRONMENT = Object.freeze([
  // Direct Cloudflare credentials must not supersede the separately authenticated OAuth user.
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",

  // Account and API endpoint selectors must not redirect the read-only proof.
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_BASE_URL",
  "CLOUDFLARE_API_ENVIRONMENT",
  "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_COMPLIANCE_REGION",

  // Config/environment/name selectors must not replace the exact generated top-level profile.
  "CLOUDFLARE_ENV",
  "WRANGLER_ENV",
  "WRANGLER_CONFIG",
  "WRANGLER_CONFIG_PATH",
  "WRANGLER_CI_OVERRIDE_NAME",

  // OAuth endpoint/client overrides could move refresh authentication off the public endpoint.
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_CLIENT_ID",

  // Wrangler output redirection would make an empty stdout look like a valid observation gap.
  "WRANGLER_OUTPUT_FILE_DIRECTORY",
  "WRANGLER_OUTPUT_FILE_PATH",

  // These are re-added below with exact values; remove case variants first (critical on Windows).
  "WRANGLER_LOG_PATH",
  "WRANGLER_WRITE_LOGS",
  "WRANGLER_LOG_SANITIZE",
  "WRANGLER_LOG",
  "WRANGLER_SEND_METRICS",
  "WRANGLER_SEND_ERROR_REPORTS",
  "NO_COLOR",
  "FORCE_COLOR",
]);

const EXPECTED_SECRET_TYPE = "secret_text";
const WRANGLER_TIMEOUT_MS = 120_000;
const WRANGLER_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SECRET_JSON_BYTES = 64 * 1024;

export class RemoteSecretAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteSecretAuditError";
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
      throw new RemoteSecretAuditError("ARGUMENT_UNKNOWN", `unknown argument at position ${index + 1}`);
    }
    if (seen.has(flag)) {
      throw new RemoteSecretAuditError("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    }
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RemoteSecretAuditError("ARGUMENT_MISSING", `${flag} requires a value`);
    }
    index += 1;
    if (flag === "--config") parsed.config = value;
    if (flag === "--log-file") parsed.logFile = value;
    if (flag === "--expected-provider") parsed.expectedProvider = value;
  }
  if (parsed.help) return parsed;
  if (parsed.config === null) {
    throw new RemoteSecretAuditError("ARGUMENT_MISSING", "--config is required");
  }
  if (parsed.logFile === null) {
    throw new RemoteSecretAuditError("ARGUMENT_MISSING", "--log-file is required");
  }
  if (!EXPECTED_CANARY_VISUAL_PROVIDERS.includes(parsed.expectedProvider)) {
    throw new RemoteSecretAuditError(
      "EXPECTED_PROVIDER_INVALID",
      `--expected-provider must be one of ${EXPECTED_CANARY_VISUAL_PROVIDERS.join(", ")}`,
    );
  }
  return parsed;
}

/** Build the same minimal closed child environment as the hardened deploy path. */
export function buildPinnedControlPlaneEnvironment(environment, logFile) {
  try {
    return buildPinnedDeployEnvironment(environment, path.resolve(logFile));
  } catch {
    throw new RemoteSecretAuditError(
      "ENVIRONMENT_INVALID",
      "Wrangler child environment could not be reduced to the pinned deploy allowlist",
    );
  }
}

/** Validate one captured read-only response without ever returning its raw bytes. */
export function inspectRemoteSecretListResult(result) {
  if (result === null || typeof result !== "object") {
    throw new RemoteSecretAuditError(
      "WRANGLER_RESULT_INVALID",
      "Wrangler returned no inspectable remote-secret result",
    );
  }
  if (result.error !== undefined) {
    throw new RemoteSecretAuditError(
      "WRANGLER_LAUNCH_FAILED",
      "Wrangler remote-secret inspection could not start",
    );
  }
  if (result.status !== 0) {
    throw new RemoteSecretAuditError(
      "WRANGLER_SECRET_QUERY_FAILED",
      "Wrangler remote-secret inspection did not succeed",
    );
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new RemoteSecretAuditError(
      "WRANGLER_OUTPUT_DRIFT",
      "Wrangler remote-secret output is not decoded text",
    );
  }
  if (result.stderr.trim() !== "") {
    throw new RemoteSecretAuditError(
      "WRANGLER_OUTPUT_DRIFT",
      "Wrangler emitted unexpected diagnostic output while listing secrets",
    );
  }
  const outputBytes = Buffer.byteLength(result.stdout, "utf8");
  if (outputBytes === 0 || outputBytes > MAX_SECRET_JSON_BYTES) {
    throw new RemoteSecretAuditError(
      "WRANGLER_OUTPUT_DRIFT",
      "Wrangler remote-secret JSON is empty or exceeds the closed size limit",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new RemoteSecretAuditError(
      "WRANGLER_OUTPUT_DRIFT",
      "Wrangler remote-secret output is not one strict JSON value",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RemoteSecretAuditError(
      "WRANGLER_SECRET_SCHEMA_DRIFT",
      "Wrangler remote-secret JSON root is not an array",
    );
  }
  // JSON.parse intentionally accepts duplicate object keys. Wrangler's closed serializer never
  // emits them, so count the two literal property tokens as an independent fail-closed check.
  // The four accepted values contain neither token, avoiding a value-dependent false match.
  const literalNameKeyCount = result.stdout.match(/"name"\s*:/gu)?.length ?? 0;
  const literalTypeKeyCount = result.stdout.match(/"type"\s*:/gu)?.length ?? 0;
  if (literalNameKeyCount !== parsed.length || literalTypeKeyCount !== parsed.length) {
    throw new RemoteSecretAuditError(
      "WRANGLER_SECRET_SCHEMA_DRIFT",
      "Wrangler remote-secret JSON has duplicate or noncanonical record keys",
    );
  }

  const names = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RemoteSecretAuditError(
        "WRANGLER_SECRET_SCHEMA_DRIFT",
        "Wrangler remote-secret JSON contains a non-object record",
      );
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "type") {
      throw new RemoteSecretAuditError(
        "WRANGLER_SECRET_SCHEMA_DRIFT",
        "Wrangler remote-secret record fields changed from the closed name/type schema",
      );
    }
    if (typeof entry.name !== "string" || entry.type !== EXPECTED_SECRET_TYPE) {
      throw new RemoteSecretAuditError(
        "WRANGLER_SECRET_SCHEMA_DRIFT",
        "Wrangler remote-secret record values changed from the closed schema",
      );
    }
    names.push(entry.name);
  }

  if (new Set(names).size !== names.length) {
    throw new RemoteSecretAuditError(
      "WRANGLER_SECRET_DUPLICATE",
      "Wrangler reported a duplicate remote Worker secret name",
    );
  }
  const sortedNames = [...names].sort();
  if (!sameStringArray(sortedNames, EXPECTED_SIGNER_SECRET_NAMES)) {
    throw new RemoteSecretAuditError(
      "WRANGLER_SECRET_SET_MISMATCH",
      "remote Worker secret names differ from the closed four-signer-secret set",
    );
  }

  return {
    secretCount: sortedNames.length,
    secretNames: sortedNames,
    secretNamesSha256: sha256(JSON.stringify(sortedNames)),
    remoteResponseBytes: outputBytes,
    remoteResponseSha256: sha256(result.stdout),
  };
}

export function runRemoteSecretAudit({
  configPath,
  logFile,
  expectedProvider,
  repositoryRoot = REPOSITORY_ROOT,
  workerRoot = WORKER_ROOT,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  resolvePinnedWranglerCommandImpl = resolvePinnedWranglerCommand,
  verifyPinnedWranglerCommandImpl = verifyPinnedWranglerCommand,
  assertPinnedWranglerDescriptorImpl = assertPinnedWranglerDescriptor,
  buildPinnedControlPlaneEnvironmentImpl = buildPinnedControlPlaneEnvironment,
  assertPrivatePathImpl = assertPrivateLocalPath,
  verifyAuditLogImpl = verifyWranglerAuditLog,
} = {}) {
  // This is a post-deploy secret-name audit retained for pre-document-binding configs. It may
  // inspect those legacy configs, but it is not a deployment interlock: runWorkflowGate does
  // not expose this opt-out and requires an independent operator document hash.
  const config = readAndValidateCanaryConfig(configPath, {
    repositoryRoot,
    expectedProvider,
    documentBindingMode: LEGACY_REMOTE_SECRET_AUDIT_DOCUMENT_BINDING_MODE,
  });
  const resolvedLogFile = requireNewFilePath(logFile, repositoryRoot, "LOG");
  assertPrivatePathImpl(config.configPath, repositoryRoot);
  assertPrivatePathImpl(path.dirname(resolvedLogFile), repositoryRoot, { directory: true });

  let pinnedWrangler;
  try {
    pinnedWrangler = assertPinnedWranglerDescriptorImpl(resolvePinnedWranglerCommandImpl());
  } catch {
    throw new RemoteSecretAuditError(
      "WRANGLER_PIN_INVALID",
      "the complete repository-local Wrangler toolchain could not be verified",
    );
  }
  let childEnvironment;
  try {
    childEnvironment = buildPinnedControlPlaneEnvironmentImpl(environment, resolvedLogFile);
  } catch (error) {
    if (error instanceof RemoteSecretAuditError) throw error;
    throw new RemoteSecretAuditError(
      "ENVIRONMENT_INVALID",
      "Wrangler child environment could not be reduced to the pinned deploy allowlist",
    );
  }
  const childOptions = {
    cwd: workerRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: WRANGLER_TIMEOUT_MS,
    maxBuffer: WRANGLER_MAX_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  };
  const invokePinnedWrangler = (argumentsAfterPrefix) => {
    let current;
    try {
      current = assertPinnedWranglerDescriptorImpl(
        verifyPinnedWranglerCommandImpl(pinnedWrangler),
      );
    } catch {
      throw new RemoteSecretAuditError(
        "WRANGLER_PIN_INVALID",
        "the complete Wrangler toolchain changed before a remote-secret audit subprocess",
      );
    }
    return spawnSyncImpl(
      current.command,
      [...current.argsPrefix, ...argumentsAfterPrefix],
      childOptions,
    );
  };

  let versionResult;
  let accountResult;
  try {
    versionResult = invokePinnedWrangler(["--version"]);
    assertWranglerVersion(versionResult);
    accountResult = invokePinnedWrangler(["whoami"]);
    assertWranglerAccount(accountResult);
  } catch (error) {
    if (error instanceof RemoteSecretAuditError) throw error;
    if (error?.name === "WorkflowGateError") throw error;
    throw new RemoteSecretAuditError(
      "WRANGLER_IDENTITY_UNAVAILABLE",
      "Wrangler identity preflight could not start",
    );
  }

  const secretArguments = [
    "secret",
    "list",
    "--config",
    config.configPath,
    "--format",
    "json",
  ];
  let secretResult;
  try {
    secretResult = invokePinnedWrangler(secretArguments);
  } catch (error) {
    if (error instanceof RemoteSecretAuditError) throw error;
    throw new RemoteSecretAuditError(
      "WRANGLER_LAUNCH_FAILED",
      "Wrangler remote-secret inspection could not start",
    );
  }
  const secretAudit = inspectRemoteSecretListResult(secretResult);

  let logAudit;
  try {
    logAudit = verifyAuditLogImpl(resolvedLogFile, repositoryRoot, assertPrivatePathImpl);
  } catch {
    throw new RemoteSecretAuditError(
      "AUDIT_LOG_INVALID",
      "sanitized Wrangler audit evidence is unavailable or invalid",
    );
  }

  return {
    workerName: EXPECTED_CANARY_WORKER,
    accountId: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    controlPlane: "public-production",
    wranglerVersion: EXPECTED_WRANGLER_VERSION,
    configSha256: config.configSha256,
    visualProvider: config.visualPolicy.provider,
    visualPolicySha256: config.visualPolicy.sha256,
    ...secretAudit,
    logAudit,
  };
}

function requireNewFilePath(candidate, repositoryRoot, label) {
  const root = realpathSync(repositoryRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RemoteSecretAuditError(
      `${label}_OUTSIDE_REPOSITORY`,
      `${label.toLowerCase()} path is outside the repository`,
    );
  }
  const parent = path.dirname(resolved);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch {
    throw new RemoteSecretAuditError(
      `${label}_PARENT_UNAVAILABLE`,
      `${label.toLowerCase()} parent is unavailable`,
    );
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    throw new RemoteSecretAuditError(
      `${label}_PARENT_INVALID`,
      `${label.toLowerCase()} parent is not an exact regular directory`,
    );
  }
  try {
    lstatSync(resolved);
    throw new RemoteSecretAuditError(`${label}_EXISTS`, `${label.toLowerCase()} path already exists`);
  } catch (error) {
    if (error instanceof RemoteSecretAuditError) throw error;
    if (error?.code !== "ENOENT") {
      throw new RemoteSecretAuditError(
        `${label}_UNAVAILABLE`,
        `${label.toLowerCase()} path cannot be inspected`,
      );
    }
  }
  return resolved;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function usage() {
  return [
    "Usage:",
    "  node tools/audit-live-canary-remote-secrets.mjs --config <generated-canary.json> --log-file <new-log-path> \\",
    "    --expected-provider <workers-ai-gemma4|cloudflare-gateway-gemini|mistral-medium35-direct>",
    "",
    "Read-only post-deploy audit. It pins the isolated Worker, account, generated config, Wrangler",
    "version, and public production control plane, then runs exactly `wrangler secret list --format",
    "json`. It emits only the expected secret names and hashes; it never requests or prints values.",
    "The Wrangler log path must be new and inside a private repository directory.",
    "",
  ].join("\n");
}

export async function runCli(argv, dependencies = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) return { exitCode: 0, stdout: usage(), stderr: "" };
    const audit = runRemoteSecretAudit({
      ...dependencies,
      configPath: options.config,
      logFile: options.logFile,
      expectedProvider: options.expectedProvider,
    });
    return { exitCode: 0, stdout: `${JSON.stringify(audit, null, 2)}\n`, stderr: "" };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "REMOTE_SECRET_AUDIT_FAILED";
    const message =
      error instanceof RemoteSecretAuditError || error?.name === "WorkflowGateError"
        ? error.message
        : "remote-secret audit failed without safe diagnostic evidence";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Remote-secret audit refused [${code}]: ${message}\n`,
    };
  }
}

async function main() {
  // The standalone production path never accepts dependency overrides. Injection remains
  // available only to programmatic unit tests of runCli/runRemoteSecretAudit.
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
