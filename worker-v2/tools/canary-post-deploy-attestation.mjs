/**
 * Local-only contracts for attesting one isolated visual-canary deployment before spend.
 *
 * This module deliberately performs no Cloudflare operation by itself. A deployment wrapper
 * supplies captured Wrangler JSON and an injected fetch implementation. Raw control-plane output,
 * authentication tokens, response bodies, and secret values never enter the retained audit.
 *
 * Declared remote assumptions (all detected and refused when absent):
 * - Wrangler 4.106.0 `versions list --json` returns an array of version records;
 * - Wrangler 4.106.0 `deployments list --json` returns an array of deployment records;
 * - the canary exposes an authenticated, closed-schema attestation endpoint backed by Cloudflare's
 *   version-metadata binding;
 * - invalid canary submissions leave the attested arm safety counters exactly unused.
 *
 * There is intentionally no whole-config or whole-identity digest stored inside the config being
 * hashed: that would be a self-reference, not evidence. Instead the runtime echoes the separately
 * sealed source, bundle-input, metafile, and reviewed-bundle constituent digests. The unique
 * version tag binds the resulting closed identity tuple to the control-plane and runtime version.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertPrivateLocalPath } from "./private-local-output.mjs";
import {
  EXPECTED_TYPESCRIPT_VERSION,
  assertPinnedWranglerDescriptor,
} from "./pinned-wrangler-command.mjs";

export const CANARY_DEPLOYMENT_IDENTITY_SCHEMA =
  "survey-qa-canary-deployment-identity/1.2.0";
export const CANARY_REMOTE_ATTESTATION_SCHEMA =
  "survey-qa-canary-remote-attestation/1.0.0";
export const CANARY_POST_DEPLOY_AUDIT_SCHEMA =
  "survey-qa-canary-post-deploy-audit/1.0.0";
export const CANARY_ATTESTATION_PATH = "/api/v2/canary-attestation";
export const LIVE_CANARY_AUTH_HEADER = "x-survey-qa-canary-token";

const IDENTITY_DOMAIN = "survey-qa-canary-deployment-identity/3\0";
const CHALLENGE_DOMAIN = "survey-qa-canary-attestation-fixed-challenge/1\0";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/u;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,99}$/u;
const SAFE_MODEL = /^[A-Za-z0-9@][A-Za-z0-9._:/+\-]{0,199}$/u;
const SAFE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_CONTROL_PLANE_JSON_BYTES = 1024 * 1024;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const MAX_DENIAL_BYTES = 1024;
const MAX_AUDIT_BYTES = 64 * 1024;

const IDENTITY_INPUT_KEYS = Object.freeze([
  "accountId",
  "bundleInputsManifestSha256",
  "bundleMetafileSha256",
  "judgementPublicKeyId",
  "judgementPublicKeySha256",
  "model",
  "provider",
  "providerConfigurationSha256",
  "providerPolicySha256",
  "questionnaireSha256",
  "recordPublicKeyId",
  "recordPublicKeySha256",
  "requiredBindings",
  "reviewedBundleManifestSha256",
  "sourceManifestSha256",
  "visualMaximumCalls",
  "visualMaximumUsd",
  "workerName",
  "wrangler",
]);
const WRANGLER_KEYS = Object.freeze([
  "arch",
  "binSha256",
  "cliSha256",
  "entryCount",
  "nodeExecutableSha256",
  "nodeVersion",
  "packageCount",
  "packageJsonSha256",
  "packageLockSha256",
  "platform",
  "toolchainInventorySha256",
  "typescriptEntrypointSha256",
  "typescriptPackageJsonSha256",
  "typescriptVersion",
  "version",
]);
const REMOTE_ATTESTATION_KEYS = Object.freeze([
  "bindings",
  "build",
  "documentSha256",
  "identitySha256",
  "provider",
  "safety",
  "schemaVersion",
  "signers",
  "workerVersion",
]);
const REMOTE_BUILD_KEYS = Object.freeze([
  "bundleInputsManifestSha256",
  "bundleMetafileSha256",
  "reviewedBundleManifestSha256",
  "sourceManifestSha256",
]);
const REMOTE_PROVIDER_KEYS = Object.freeze([
  "configurationSha256",
  "maximumCalls",
  "maximumUsd",
  "model",
  "name",
  "policySha256",
]);
const REMOTE_SAFETY_KEYS = Object.freeze([
  "providerCalls",
  "providerCostUsd",
  "submissionClaimState",
  "workflowInstancesCreated",
]);
const REMOTE_SIGNER_KEYS = Object.freeze([
  "challengeSha256",
  "judgementKeyId",
  "judgementPublicKeySha256",
  "judgementVerified",
  "recordKeyId",
  "recordPublicKeySha256",
  "recordVerified",
]);
const REMOTE_VERSION_KEYS = Object.freeze(["id", "tag", "timestamp"]);

/**
 * Independently closed binding denominator for the isolated canary adapter. The runtime endpoint
 * must report presence for this exact set; it may not derive the expected set from its own env.
 */
export const REQUIRED_CANARY_REMOTE_BINDINGS = Object.freeze([
  "AI",
  "ANTHROPIC_API_KEY",
  "ASSETS",
  "BROWSER",
  "CF_VERSION_METADATA",
  "DEEPSEEK_API_KEY",
  "EVIDENCE",
  "GEMINI_API_KEY",
  "JUDGEMENT_SIGNING_KEY",
  "JUDGEMENT_SIGNING_KEY_ID",
  "MISTRAL_API_KEY",
  "RECORD_SIGNING_KEY",
  "RECORD_SIGNING_KEY_ID",
  "V2_RUN_WORKFLOW",
  "V2_VISUAL_WORKFLOW",
  "XAI_API_KEY",
]);

/**
 * Known environment names which can redirect credentials, control plane, config, output, TLS,
 * proxying, or Node execution. Prefix filtering below additionally removes future Wrangler,
 * Cloudflare, npm, Node, SSL, and proxy spellings case-insensitively.
 */
export const FORBIDDEN_DEPLOY_ENVIRONMENT_NAMES = Object.freeze([
  "ALL_PROXY",
  "BROWSER",
  "CF_API_BASE_URL",
  "CF_API_KEY",
  "CF_API_TOKEN",
  "CF_ACCOUNT_ID",
  "CF_EMAIL",
  "CI",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CLOUDFLARE_API_ENVIRONMENT",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
  "CLOUDFLARE_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ENV",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_COLOR",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
  "WRANGLER_CI_OVERRIDE_NAME",
  "WRANGLER_CLIENT_ID",
  "WRANGLER_COMPLIANCE_REGION",
  "WRANGLER_CONFIG",
  "WRANGLER_CONFIG_PATH",
  "WRANGLER_ENV",
  "WRANGLER_LOG",
  "WRANGLER_LOG_PATH",
  "WRANGLER_LOG_SANITIZE",
  "WRANGLER_OUTPUT_FILE_DIRECTORY",
  "WRANGLER_OUTPUT_FILE_PATH",
  "WRANGLER_PROFILE",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_SEND_ERROR_REPORTS",
  "WRANGLER_SEND_METRICS",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_WRITE_LOGS",
]);

const FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze([
  "CF_",
  "CLOUDFLARE_",
  "NODE_",
  "NPM_CONFIG_",
  "SSL_",
  "WRANGLER_",
]);
const FORBIDDEN_ENVIRONMENT_SUFFIXES = Object.freeze(["_PROXY"]);
/**
 * Minimal OS/user-location context Wrangler needs for persisted OAuth and temporary files.
 * Everything else from the parent process is dropped, including PATH, provider/AWS credentials,
 * proxies, Node/npm injection flags, and future Cloudflare/Wrangler overrides.
 */
export const INHERITED_DEPLOY_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);
const PINNED_ENVIRONMENT = Object.freeze({
  CLOUDFLARE_COMPLIANCE_REGION: "public",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  WRANGLER_API_ENVIRONMENT: "production",
  WRANGLER_LOG: "log",
  WRANGLER_LOG_SANITIZE: "true",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "true",
});

export class CanaryPostDeployAttestationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanaryPostDeployAttestationError";
    this.code = code;
  }
}

/** Build the immutable identity whose digest is carried by tag, config, and remote endpoint. */
export function deriveCanaryDeploymentIdentity(input) {
  requireRecord(input, "IDENTITY_INVALID", "deployment identity input must be one object");
  requireExactKeys(input, IDENTITY_INPUT_KEYS, "IDENTITY_SCHEMA_DRIFT");
  requirePattern(input.accountId, ACCOUNT_ID, "IDENTITY_ACCOUNT_INVALID");
  requirePattern(input.workerName, WORKER_NAME, "IDENTITY_WORKER_INVALID");
  for (const key of [
    "bundleInputsManifestSha256",
    "bundleMetafileSha256",
    "providerConfigurationSha256",
    "providerPolicySha256",
    "questionnaireSha256",
    "reviewedBundleManifestSha256",
    "sourceManifestSha256",
  ]) {
    requirePattern(input[key], SHA256_HEX, "IDENTITY_DIGEST_INVALID");
  }
  requirePattern(input.provider, SAFE_PROVIDER, "IDENTITY_PROVIDER_INVALID");
  requirePattern(input.model, SAFE_MODEL, "IDENTITY_MODEL_INVALID");
  requirePattern(input.recordPublicKeyId, SAFE_ID, "IDENTITY_SIGNER_INVALID");
  requirePattern(input.judgementPublicKeyId, SAFE_ID, "IDENTITY_SIGNER_INVALID");
  requirePattern(input.recordPublicKeySha256, SHA256_HEX, "IDENTITY_SIGNER_INVALID");
  requirePattern(input.judgementPublicKeySha256, SHA256_HEX, "IDENTITY_SIGNER_INVALID");
  if (input.recordPublicKeyId === input.judgementPublicKeyId) {
    refuse("IDENTITY_SIGNER_INVALID", "record and judgement signer key ids must be distinct");
  }
  if (input.visualMaximumCalls !== 1) {
    refuse("IDENTITY_SPEND_CAP_INVALID", "pre-spend attestation is restricted to a one-call canary arm");
  }
  requirePattern(input.visualMaximumUsd, SAFE_DECIMAL, "IDENTITY_SPEND_CAP_INVALID");
  if (Number(input.visualMaximumUsd) <= 0) {
    refuse("IDENTITY_SPEND_CAP_INVALID", "visual maximum USD must be positive");
  }
  requireExactStringArray(
    input.requiredBindings,
    REQUIRED_CANARY_REMOTE_BINDINGS,
    "IDENTITY_BINDINGS_INVALID",
  );
  requireRecord(input.wrangler, "IDENTITY_WRANGLER_INVALID", "Wrangler identity is missing");
  requireExactKeys(input.wrangler, WRANGLER_KEYS, "IDENTITY_WRANGLER_INVALID");
  requirePattern(input.wrangler.version, /^4\.[0-9]+\.[0-9]+$/u, "IDENTITY_WRANGLER_INVALID");
  for (const key of [
    "packageJsonSha256",
    "binSha256",
    "cliSha256",
    "packageLockSha256",
    "toolchainInventorySha256",
    "nodeExecutableSha256",
    "typescriptEntrypointSha256",
    "typescriptPackageJsonSha256",
  ]) requirePattern(input.wrangler[key], SHA256_HEX, "IDENTITY_WRANGLER_INVALID");
  if (
    input.wrangler.platform !== "win32" ||
    input.wrangler.arch !== "x64" ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(input.wrangler.nodeVersion) ||
    input.wrangler.typescriptVersion !== EXPECTED_TYPESCRIPT_VERSION ||
    !Number.isSafeInteger(input.wrangler.packageCount) ||
    input.wrangler.packageCount <= 0 ||
    !Number.isSafeInteger(input.wrangler.entryCount) ||
    input.wrangler.entryCount <= 0
  ) {
    refuse("IDENTITY_WRANGLER_INVALID", "Wrangler toolchain inventory identity is malformed");
  }

  const base = deepFreeze(structuredClone(input));
  const identitySha256 = sha256(`${IDENTITY_DOMAIN}${canonicalJson(base)}`);
  return deepFreeze({
    schemaVersion: CANARY_DEPLOYMENT_IDENTITY_SCHEMA,
    ...base,
    identitySha256,
    versionTag: `sqac-${identitySha256.slice(0, 24)}`,
    versionMessage: `survey-qa canary identity sha256:${identitySha256}`,
  });
}

/** The exact tag/message arguments a separate deploy wrapper must add to its reviewed upload. */
export function deploymentIdentityFlags(identity) {
  const expected = assertDerivedIdentity(identity);
  return Object.freeze([
    "--tag",
    expected.versionTag,
    "--message",
    expected.versionMessage,
  ]);
}

/** Fixed, build-bound selector for the closed remote attestation endpoint. */
export function canaryAttestationChallengeSha256(identity) {
  const expected = assertDerivedIdentity(identity);
  return sha256(`${CHALLENGE_DOMAIN}${expected.identitySha256}`);
}

/** Exact non-secret vars the reviewed upload adds for the runtime attestation seam. */
export function canaryDeploymentIdentityVars(identity) {
  const expected = assertDerivedIdentity(identity);
  return deepFreeze({
    CANARY_BUNDLE_INPUTS_MANIFEST_SHA256: expected.bundleInputsManifestSha256,
    CANARY_BUNDLE_METAFILE_SHA256: expected.bundleMetafileSha256,
    CANARY_DEPLOYMENT_IDENTITY_SHA256: expected.identitySha256,
    CANARY_EXPECTED_DOCUMENT_SHA256: expected.questionnaireSha256,
    CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256: expected.reviewedBundleManifestSha256,
    CANARY_SOURCE_MANIFEST_SHA256: expected.sourceManifestSha256,
    CANARY_VISUAL_POLICY_SHA256: expected.providerPolicySha256,
    CANARY_VERSION_TAG: expected.versionTag,
    VISUAL_MAX_CALLS: String(expected.visualMaximumCalls),
    VISUAL_MAX_USD: expected.visualMaximumUsd,
    VISUAL_PROVIDER: expected.provider,
  });
}

/**
 * Construct a new child environment from a minimal explicit allowlist, then add exact pins.
 * This returns data only; it never spawns Wrangler.
 */
export function buildPinnedDeployEnvironment(environment, logFile) {
  requireRecord(environment, "ENVIRONMENT_INVALID", "parent environment must be one object");
  requireAbsolutePath(logFile, "LOG_PATH_INVALID");
  const inheritedNames = new Map(
    INHERITED_DEPLOY_ENVIRONMENT_NAMES.map((name) => [name.toUpperCase(), name]),
  );
  const child = {};
  for (const [name, value] of Object.entries(environment)) {
    const canonical = inheritedNames.get(name.toUpperCase());
    if (canonical === undefined || typeof value !== "string") continue;
    if (value.length === 0 || value.length > 32_768 || value.includes("\0")) {
      refuse("ENVIRONMENT_VALUE_INVALID", "an allowlisted inherited environment value is malformed");
    }
    if (child[canonical] !== undefined && child[canonical] !== value) {
      refuse("ENVIRONMENT_VALUE_AMBIGUOUS", "an allowlisted environment name occurs with conflicting casing");
    }
    child[canonical] = value;
  }
  Object.assign(child, PINNED_ENVIRONMENT, { WRANGLER_LOG_PATH: path.resolve(logFile) });
  assertPinnedDeployEnvironment(child, path.resolve(logFile));
  return child;
}

export function assertPinnedDeployEnvironment(environment, logFile) {
  requireRecord(environment, "ENVIRONMENT_INVALID", "child environment must be one object");
  const expectedLog = path.resolve(logFile);
  const allowed = new Set([
    ...INHERITED_DEPLOY_ENVIRONMENT_NAMES,
    ...Object.keys(PINNED_ENVIRONMENT),
    "WRANGLER_LOG_PATH",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (!allowed.has(name)) {
      refuse("ENVIRONMENT_NAME_NOT_ALLOWED", "the Wrangler child environment contains an unapproved name");
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) {
      refuse("ENVIRONMENT_VALUE_INVALID", "the Wrangler child environment contains a malformed value");
    }
  }
  for (const [name, value] of Object.entries(PINNED_ENVIRONMENT)) {
    if (environment[name] !== value) {
      refuse("ENVIRONMENT_PIN_MISSING", "a pinned Wrangler environment value is absent or changed");
    }
  }
  if (environment.WRANGLER_LOG_PATH !== expectedLog) {
    refuse("ENVIRONMENT_PIN_MISSING", "Wrangler log path is not the exact private audit path");
  }
  return environment;
}

/**
 * Construct exact, read-only post-deploy commands. The descriptor must already be the validated
 * local Node + pinned Wrangler entrypoint; PATH, npx, shell, env/config/profile flags are absent.
 */
export function buildPostDeployReadPlan({
  pinnedWrangler,
  configPath,
  workerName,
  logFile,
  environment,
}) {
  requirePinnedWranglerDescriptor(pinnedWrangler);
  requireAbsoluteRegularPathShape(configPath, "CONFIG_PATH_INVALID");
  requireAbsolutePath(logFile, "LOG_PATH_INVALID");
  requirePattern(workerName, WORKER_NAME, "WORKER_NAME_INVALID");
  const childEnvironment = buildPinnedDeployEnvironment(environment, logFile);
  const command = pinnedWrangler.command;
  const prefix = [...pinnedWrangler.argsPrefix];
  const common = ["--name", workerName, "--json", "--config", path.resolve(configPath)];
  return deepFreeze({
    schemaVersion: "survey-qa-canary-post-deploy-read-plan/1.0.0",
    workerName,
    command,
    environment: childEnvironment,
    commands: [
      { kind: "versions", command, args: [...prefix, "versions", "list", ...common] },
      { kind: "deployments", command, args: [...prefix, "deployments", "list", ...common] },
    ],
  });
}

/** Reconcile one new tag-bound version and one new 100%-traffic deployment. */
export function inspectControlPlaneTransition({
  beforeVersionsResult,
  beforeDeploymentsResult,
  afterVersionsResult,
  afterDeploymentsResult,
  expectedIdentity,
}) {
  const identity = assertDerivedIdentity(expectedIdentity);
  const beforeVersions = inspectVersionsResult(beforeVersionsResult);
  const afterVersions = inspectVersionsResult(afterVersionsResult);
  const beforeDeployments = inspectDeploymentsResult(beforeDeploymentsResult);
  const afterDeployments = inspectDeploymentsResult(afterDeploymentsResult);

  if (beforeVersions.some((entry) => entry.tag === identity.versionTag)) {
    refuse("VERSION_TAG_REUSED", "the candidate version tag already existed before deployment");
  }
  const beforeVersionIds = new Set(beforeVersions.map((entry) => entry.id));
  const newVersions = afterVersions.filter((entry) => !beforeVersionIds.has(entry.id));
  if (newVersions.length !== 1) {
    refuse("VERSION_TRANSITION_AMBIGUOUS", "post-deploy version history does not contain exactly one new version");
  }
  const version = newVersions[0];
  if (
    version.tag !== identity.versionTag ||
    version.message !== identity.versionMessage ||
    version.source !== "wrangler"
  ) {
    refuse("VERSION_IDENTITY_MISMATCH", "new Cloudflare version is not bound to the expected deployment identity");
  }
  if (afterVersions.filter((entry) => entry.tag === identity.versionTag).length !== 1) {
    refuse("VERSION_TAG_AMBIGUOUS", "expected version tag does not identify exactly one remote version");
  }

  const beforeDeploymentIds = new Set(beforeDeployments.map((entry) => entry.id));
  const newDeployments = afterDeployments.filter((entry) => !beforeDeploymentIds.has(entry.id));
  if (newDeployments.length !== 1) {
    refuse(
      "DEPLOYMENT_TRANSITION_AMBIGUOUS",
      "post-deploy deployment history does not contain exactly one new deployment",
    );
  }
  const deployment = newDeployments[0];
  const latest = [...afterDeployments].sort((left, right) => right.createdOn.localeCompare(left.createdOn))[0];
  if (latest?.id !== deployment.id) {
    refuse("DEPLOYMENT_NOT_LATEST", "the newly observed deployment is not the latest remote deployment");
  }
  if (
    deployment.source !== "wrangler" ||
    deployment.strategy !== "percentage" ||
    deployment.versions.length !== 1 ||
    deployment.versions[0].versionId !== version.id ||
    deployment.versions[0].percentage !== 100
  ) {
    refuse("DEPLOYMENT_TRAFFIC_MISMATCH", "new deployment does not serve exactly the expected version at 100 percent");
  }
  if (deployment.createdOn < version.createdOn) {
    refuse("DEPLOYMENT_TIME_INVALID", "deployment predates the version it claims to serve");
  }

  return deepFreeze({
    schemaVersion: "survey-qa-canary-control-plane-attestation/1.0.0",
    accountId: identity.accountId,
    workerName: identity.workerName,
    identitySha256: identity.identitySha256,
    versionId: version.id,
    versionTag: version.tag,
    versionCreatedOn: version.createdOn,
    deploymentId: deployment.id,
    deploymentCreatedOn: deployment.createdOn,
  });
}

/**
 * Re-attest the currently served deployment without relying on a remembered before/after diff.
 * This is the one-call runner's last control-plane identity check: the eligibility marker names
 * one exact version and deployment, and the latest deployment must still serve only that version
 * at 100 percent. A newer upload which is not serving traffic is harmless; a newer deployment is
 * not.
 */
export function inspectCurrentCanaryControlPlane({
  versionsResult,
  deploymentsResult,
  expectedIdentity,
  expectedVersionId,
  expectedDeploymentId,
}) {
  const identity = assertDerivedIdentity(expectedIdentity);
  requirePattern(expectedVersionId, UUID, "CURRENT_VERSION_ID_INVALID");
  requirePattern(expectedDeploymentId, UUID, "CURRENT_DEPLOYMENT_ID_INVALID");
  const versionId = expectedVersionId.toLowerCase();
  const deploymentId = expectedDeploymentId.toLowerCase();
  const versions = inspectVersionsResult(versionsResult);
  const deployments = inspectDeploymentsResult(deploymentsResult);

  const matchingVersions = versions.filter((entry) => entry.id === versionId);
  if (matchingVersions.length !== 1) {
    refuse("CURRENT_VERSION_MISSING", "the eligibility-bound Worker version is not in recent version history");
  }
  const version = matchingVersions[0];
  if (
    version.tag !== identity.versionTag ||
    version.message !== identity.versionMessage ||
    version.source !== "wrangler" ||
    versions.filter((entry) => entry.tag === identity.versionTag).length !== 1
  ) {
    refuse("CURRENT_VERSION_IDENTITY_MISMATCH", "the current version no longer has the eligibility-bound identity");
  }

  const matchingDeployments = deployments.filter((entry) => entry.id === deploymentId);
  if (matchingDeployments.length !== 1) {
    refuse("CURRENT_DEPLOYMENT_MISSING", "the eligibility-bound deployment is not in recent deployment history");
  }
  const deployment = matchingDeployments[0];
  const latest = [...deployments].sort((left, right) => right.createdOn.localeCompare(left.createdOn))[0];
  if (latest?.id !== deployment.id) {
    refuse("CURRENT_DEPLOYMENT_STALE", "a newer Worker deployment superseded the eligibility marker");
  }
  if (
    deployment.source !== "wrangler" ||
    deployment.strategy !== "percentage" ||
    deployment.versions.length !== 1 ||
    deployment.versions[0].versionId !== version.id ||
    deployment.versions[0].percentage !== 100
  ) {
    refuse("CURRENT_DEPLOYMENT_TRAFFIC_MISMATCH", "current traffic is not 100 percent on the eligibility-bound version");
  }
  if (deployment.createdOn < version.createdOn) {
    refuse("CURRENT_DEPLOYMENT_TIME_INVALID", "the current deployment predates its bound version");
  }

  return deepFreeze({
    schemaVersion: "survey-qa-canary-control-plane-attestation/1.0.0",
    accountId: identity.accountId,
    workerName: identity.workerName,
    identitySha256: identity.identitySha256,
    versionId: version.id,
    versionTag: version.tag,
    versionCreatedOn: version.createdOn,
    deploymentId: deployment.id,
    deploymentCreatedOn: deployment.createdOn,
  });
}

/** Validate the canary-only authenticated endpoint against local and control-plane identity. */
export function validateRemoteAttestation(value, expectedIdentity, controlPlane) {
  const identity = assertDerivedIdentity(expectedIdentity);
  requireControlPlaneAttestation(controlPlane, identity);
  requireRecord(value, "REMOTE_ATTESTATION_INVALID", "remote attestation must be one object");
  requireExactKeys(value, REMOTE_ATTESTATION_KEYS, "REMOTE_ATTESTATION_SCHEMA_DRIFT");
  if (value.schemaVersion !== CANARY_REMOTE_ATTESTATION_SCHEMA) {
    refuse("REMOTE_ATTESTATION_SCHEMA_DRIFT", "remote attestation schema version is unknown");
  }
  if (value.identitySha256 !== identity.identitySha256) {
    refuse("REMOTE_IDENTITY_MISMATCH", "remote deployment identity digest differs from local identity");
  }

  requireRecord(value.workerVersion, "REMOTE_VERSION_INVALID", "remote Worker version evidence is missing");
  requireExactKeys(value.workerVersion, REMOTE_VERSION_KEYS, "REMOTE_VERSION_INVALID");
  if (
    value.workerVersion.id !== controlPlane.versionId ||
    value.workerVersion.tag !== identity.versionTag ||
    value.workerVersion.timestamp !== controlPlane.versionCreatedOn
  ) {
    refuse("REMOTE_VERSION_MISMATCH", "runtime version metadata differs from the control-plane version");
  }

  requireRecord(value.build, "REMOTE_BUILD_INVALID", "remote build evidence is missing");
  requireExactKeys(value.build, REMOTE_BUILD_KEYS, "REMOTE_BUILD_INVALID");
  const expectedBuild = {
    bundleInputsManifestSha256: identity.bundleInputsManifestSha256,
    bundleMetafileSha256: identity.bundleMetafileSha256,
    reviewedBundleManifestSha256: identity.reviewedBundleManifestSha256,
    sourceManifestSha256: identity.sourceManifestSha256,
  };
  if (canonicalJson(value.build) !== canonicalJson(expectedBuild)) {
    refuse("REMOTE_BUILD_MISMATCH", "remote build identity differs from the reviewed local build");
  }

  requireRecord(value.provider, "REMOTE_PROVIDER_INVALID", "remote provider evidence is missing");
  requireExactKeys(value.provider, REMOTE_PROVIDER_KEYS, "REMOTE_PROVIDER_INVALID");
  const expectedProvider = {
    configurationSha256: identity.providerConfigurationSha256,
    maximumCalls: identity.visualMaximumCalls,
    maximumUsd: identity.visualMaximumUsd,
    model: identity.model,
    name: identity.provider,
    policySha256: identity.providerPolicySha256,
  };
  if (canonicalJson(value.provider) !== canonicalJson(expectedProvider)) {
    refuse("REMOTE_PROVIDER_MISMATCH", "remote provider/model/policy/cap identity differs from the reviewed arm");
  }
  if (value.documentSha256 !== identity.questionnaireSha256) {
    refuse("REMOTE_DOCUMENT_MISMATCH", "remote expected questionnaire digest differs from the operator digest");
  }

  requireRecord(value.bindings, "REMOTE_BINDINGS_INVALID", "remote binding-presence evidence is missing");
  requireExactKeys(value.bindings, REQUIRED_CANARY_REMOTE_BINDINGS, "REMOTE_BINDINGS_INVALID");
  if (REQUIRED_CANARY_REMOTE_BINDINGS.some((name) => value.bindings[name] !== true)) {
    refuse("REMOTE_BINDING_MISSING", "one or more independently required canary bindings are unavailable");
  }

  requireRecord(value.signers, "REMOTE_SIGNERS_INVALID", "remote signer self-check evidence is missing");
  requireExactKeys(value.signers, REMOTE_SIGNER_KEYS, "REMOTE_SIGNERS_INVALID");
  const expectedChallenge = canaryAttestationChallengeSha256(identity);
  if (
    value.signers.challengeSha256 !== expectedChallenge ||
    value.signers.recordKeyId !== identity.recordPublicKeyId ||
    value.signers.judgementKeyId !== identity.judgementPublicKeyId ||
    value.signers.recordPublicKeySha256 !== identity.recordPublicKeySha256 ||
    value.signers.judgementPublicKeySha256 !== identity.judgementPublicKeySha256 ||
    value.signers.recordVerified !== true ||
    value.signers.judgementVerified !== true
  ) {
    refuse("REMOTE_SIGNER_MISMATCH", "remote fixed-challenge signer self-check did not verify exactly");
  }

  requireUnusedSafety(value.safety);
  return deepFreeze(structuredClone(value));
}

/**
 * Run the only credential-bearing pre-spend network sequence. A valid submission is intentionally
 * absent: every POST here must be rejected by the wrapper before claim, Workflow, or provider use.
 */
export async function runCanaryPreSpendRemoteGate({
  baseUrl,
  authToken,
  expectedIdentity,
  controlPlane,
  fetchImpl = fetch,
}) {
  const identity = assertDerivedIdentity(expectedIdentity);
  requireControlPlaneAttestation(controlPlane, identity);
  const origin = requireHttpsOrigin(baseUrl);
  if (typeof authToken !== "string" || authToken.length < 32 || authToken.length > 256) {
    refuse("AUTH_TOKEN_INVALID", "canary authentication token has an invalid length");
  }
  if (typeof fetchImpl !== "function") refuse("FETCH_INVALID", "fetch implementation is unavailable");

  const healthUrl = new URL("/api/v2/health", origin).href;
  const attestationTarget = new URL(CANARY_ATTESTATION_PATH, origin);
  attestationTarget.searchParams.set("challenge", canaryAttestationChallengeSha256(identity));
  const attestationUrl = attestationTarget.href;
  const submissionUrl = new URL("/api/v2/runs", origin).href;

  const anonymous = await fetchChecked(fetchImpl, healthUrl, {
    method: "GET",
    headers: { accept: "text/plain" },
    redirect: "error",
  });
  const anonymousDenial = await inspectClosedDenial(anonymous, healthUrl, "ANONYMOUS_DENIAL_FAILED");

  const beforeResponse = await fetchChecked(fetchImpl, attestationUrl, {
    method: "GET",
    headers: { accept: "application/json", [LIVE_CANARY_AUTH_HEADER]: authToken },
    redirect: "error",
  });
  const beforeValue = await readAttestationResponse(beforeResponse, attestationUrl);
  const before = validateRemoteAttestation(beforeValue, identity, controlPlane);

  const anonymousSubmissionResponse = await fetchChecked(fetchImpl, submissionUrl, {
    method: "POST",
    headers: { accept: "text/plain", "content-type": "application/json" },
    body: "{}",
    redirect: "error",
  });
  const anonymousSubmissionDenial = await inspectClosedDenial(
    anonymousSubmissionResponse,
    submissionUrl,
    "ANONYMOUS_SUBMISSION_NOT_DENIED",
  );
  const afterAnonymousResponse = await fetchChecked(fetchImpl, attestationUrl, {
    method: "GET",
    headers: { accept: "application/json", [LIVE_CANARY_AUTH_HEADER]: authToken },
    redirect: "error",
  });
  const afterAnonymousValue = await readAttestationResponse(afterAnonymousResponse, attestationUrl);
  const afterAnonymous = validateRemoteAttestation(afterAnonymousValue, identity, controlPlane);
  if (canonicalJson(before) !== canonicalJson(afterAnonymous)) {
    refuse("REMOTE_ATTESTATION_CHANGED", "anonymous paid-route denial changed remote identity or unused-arm evidence");
  }

  const malformedBody = JSON.stringify({ schemaVersion: "deliberately-not-a-canary-submission" });
  const malformedResponse = await fetchChecked(fetchImpl, submissionUrl, {
    method: "POST",
    headers: {
      accept: "text/plain",
      "content-type": "application/json",
      [LIVE_CANARY_AUTH_HEADER]: authToken,
    },
    body: malformedBody,
    redirect: "error",
  });
  const malformedDenial = await inspectClosedDenial(
    malformedResponse,
    submissionUrl,
    "MALFORMED_SUBMISSION_NOT_DENIED",
  );

  const mismatchedBody = mismatchedDocumentSubmission(identity.questionnaireSha256);
  const mismatchedResponse = await fetchChecked(fetchImpl, submissionUrl, {
    method: "POST",
    headers: {
      accept: "text/plain",
      "content-type": "application/json",
      [LIVE_CANARY_AUTH_HEADER]: authToken,
    },
    body: mismatchedBody.serialized,
    redirect: "error",
  });
  const mismatchedDenial = await inspectClosedDenial(
    mismatchedResponse,
    submissionUrl,
    "MISMATCHED_DOCUMENT_NOT_DENIED",
  );

  const afterResponse = await fetchChecked(fetchImpl, attestationUrl, {
    method: "GET",
    headers: { accept: "application/json", [LIVE_CANARY_AUTH_HEADER]: authToken },
    redirect: "error",
  });
  const afterValue = await readAttestationResponse(afterResponse, attestationUrl);
  const after = validateRemoteAttestation(afterValue, identity, controlPlane);
  if (canonicalJson(before) !== canonicalJson(after)) {
    refuse("REMOTE_ATTESTATION_CHANGED", "invalid probes changed the remote identity or unused-arm evidence");
  }

  const attestationSha256 = sha256(canonicalJson(after));
  return deepFreeze({
    schemaVersion: CANARY_POST_DEPLOY_AUDIT_SCHEMA,
    accountId: identity.accountId,
    workerName: identity.workerName,
    identitySha256: identity.identitySha256,
    versionId: controlPlane.versionId,
    versionTag: controlPlane.versionTag,
    versionCreatedOn: controlPlane.versionCreatedOn,
    deploymentId: controlPlane.deploymentId,
    deploymentCreatedOn: controlPlane.deploymentCreatedOn,
    anonymousDenialSha256: anonymousDenial.sha256,
    anonymousSubmissionDenialSha256: anonymousSubmissionDenial.sha256,
    malformedDenialSha256: malformedDenial.sha256,
    mismatchedDenialSha256: mismatchedDenial.sha256,
    mismatchedProbeDocumentSha256: mismatchedBody.documentSha256,
    remoteAttestationSha256: attestationSha256,
    unusedSafetySha256: sha256(canonicalJson(after.safety)),
  });
}

/**
 * GET-only repeat attestation for the final one-call handoff. Deployment already proved all
 * denial probes; the runner needs only the currently served version identity and an unused arm,
 * without adding any extra POST to a run advertised as exactly one POST total.
 */
export async function runCurrentCanaryRuntimeAttestation({
  baseUrl,
  authToken,
  expectedIdentity,
  controlPlane,
  fetchImpl = fetch,
}) {
  const identity = assertDerivedIdentity(expectedIdentity);
  requireControlPlaneAttestation(controlPlane, identity);
  const origin = requireHttpsOrigin(baseUrl);
  if (typeof authToken !== "string" || authToken.length < 32 || authToken.length > 256) {
    refuse("AUTH_TOKEN_INVALID", "canary authentication token has an invalid length");
  }
  if (typeof fetchImpl !== "function") refuse("FETCH_INVALID", "fetch implementation is unavailable");
  const target = new URL(CANARY_ATTESTATION_PATH, origin);
  target.searchParams.set("challenge", canaryAttestationChallengeSha256(identity));
  const response = await fetchChecked(fetchImpl, target.href, {
    method: "GET",
    headers: { accept: "application/json", [LIVE_CANARY_AUTH_HEADER]: authToken },
    redirect: "error",
  });
  const value = await readAttestationResponse(response, target.href);
  const attestation = validateRemoteAttestation(value, identity, controlPlane);
  return deepFreeze({
    schemaVersion: "survey-qa-canary-current-runtime-attestation/1.0.0",
    accountId: identity.accountId,
    workerName: identity.workerName,
    identitySha256: identity.identitySha256,
    versionId: controlPlane.versionId,
    deploymentId: controlPlane.deploymentId,
    remoteAttestationSha256: sha256(canonicalJson(attestation)),
    unusedSafetySha256: sha256(canonicalJson(attestation.safety)),
  });
}

/** Write only the validated, closed audit record to a new file under an ACL-private directory. */
export function writePrivatePostDeployAudit({
  audit,
  outputFile,
  repositoryRoot,
  assertPrivatePathImpl = assertPrivateLocalPath,
}) {
  requireAuditRecord(audit);
  requireAbsolutePath(outputFile, "AUDIT_PATH_INVALID");
  requireAbsolutePath(repositoryRoot, "REPOSITORY_PATH_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/u.test(path.basename(outputFile))) {
    refuse("AUDIT_PATH_INVALID", "audit filename is not a closed safe JSON name");
  }
  const parent = path.dirname(path.resolve(outputFile));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    refuse("AUDIT_PATH_INVALID", "audit parent must be one exact real directory");
  }
  assertPrivatePathImpl(parent, path.resolve(repositoryRoot), { directory: true });
  const bytes = Buffer.from(`${canonicalJson(audit)}\n`, "utf8");
  if (bytes.length <= 0 || bytes.length > MAX_AUDIT_BYTES) {
    refuse("AUDIT_RECORD_INVALID", "sanitized audit is empty or exceeds its closed byte limit");
  }
  let descriptor;
  try {
    descriptor = openSync(path.resolve(outputFile), "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch {
    refuse("AUDIT_WRITE_FAILED", "sanitized audit file could not be created exclusively");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertPrivatePathImpl(path.resolve(outputFile), path.resolve(repositoryRoot));
  return deepFreeze({
    path: path.resolve(outputFile),
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

function inspectVersionsResult(result) {
  const value = inspectJsonCommandResult(result, "VERSION_QUERY");
  if (!Array.isArray(value) || value.length > 10) {
    refuse("VERSION_SCHEMA_DRIFT", "Wrangler version JSON is not the closed recent-version array");
  }
  const seen = new Set();
  return value.map((entry) => {
    requireRecord(entry, "VERSION_SCHEMA_DRIFT", "Wrangler version record is malformed");
    requirePattern(entry.id, UUID, "VERSION_SCHEMA_DRIFT");
    if (seen.has(entry.id)) refuse("VERSION_SCHEMA_DRIFT", "Wrangler version history contains duplicate ids");
    seen.add(entry.id);
    requireRecord(entry.metadata, "VERSION_SCHEMA_DRIFT", "Wrangler version metadata is missing");
    requirePattern(entry.metadata.created_on, ISO_TIMESTAMP, "VERSION_SCHEMA_DRIFT");
    if (typeof entry.metadata.source !== "string") {
      refuse("VERSION_SCHEMA_DRIFT", "Wrangler version source is missing");
    }
    const annotations = entry.annotations === undefined ? {} : entry.annotations;
    requireRecord(annotations, "VERSION_SCHEMA_DRIFT", "Wrangler version annotations are malformed");
    const tag = annotations["workers/tag"] ?? null;
    const message = annotations["workers/message"] ?? null;
    if (tag !== null && typeof tag !== "string") refuse("VERSION_SCHEMA_DRIFT", "version tag is malformed");
    if (message !== null && typeof message !== "string") {
      refuse("VERSION_SCHEMA_DRIFT", "version message is malformed");
    }
    return {
      id: entry.id.toLowerCase(),
      createdOn: entry.metadata.created_on,
      source: entry.metadata.source,
      tag,
      message,
    };
  });
}

function inspectDeploymentsResult(result) {
  const value = inspectJsonCommandResult(result, "DEPLOYMENT_QUERY");
  if (!Array.isArray(value) || value.length > 10) {
    refuse("DEPLOYMENT_SCHEMA_DRIFT", "Wrangler deployment JSON is not the closed recent-deployment array");
  }
  const seen = new Set();
  return value.map((entry) => {
    requireRecord(entry, "DEPLOYMENT_SCHEMA_DRIFT", "Wrangler deployment record is malformed");
    requirePattern(entry.id, UUID, "DEPLOYMENT_SCHEMA_DRIFT");
    if (seen.has(entry.id)) refuse("DEPLOYMENT_SCHEMA_DRIFT", "deployment history contains duplicate ids");
    seen.add(entry.id);
    requirePattern(entry.created_on, ISO_TIMESTAMP, "DEPLOYMENT_SCHEMA_DRIFT");
    if (typeof entry.source !== "string" || typeof entry.strategy !== "string" || !Array.isArray(entry.versions)) {
      refuse("DEPLOYMENT_SCHEMA_DRIFT", "deployment source, strategy, or traffic is malformed");
    }
    const versionIds = new Set();
    const versions = entry.versions.map((traffic) => {
      requireRecord(traffic, "DEPLOYMENT_SCHEMA_DRIFT", "deployment traffic record is malformed");
      requirePattern(traffic.version_id, UUID, "DEPLOYMENT_SCHEMA_DRIFT");
      if (versionIds.has(traffic.version_id)) {
        refuse("DEPLOYMENT_SCHEMA_DRIFT", "deployment contains duplicate version traffic records");
      }
      versionIds.add(traffic.version_id);
      if (typeof traffic.percentage !== "number" || !Number.isFinite(traffic.percentage)) {
        refuse("DEPLOYMENT_SCHEMA_DRIFT", "deployment traffic percentage is malformed");
      }
      return { versionId: traffic.version_id.toLowerCase(), percentage: traffic.percentage };
    });
    return {
      id: entry.id.toLowerCase(),
      createdOn: entry.created_on,
      source: entry.source,
      strategy: entry.strategy,
      versions,
    };
  });
}

function inspectJsonCommandResult(result, prefix) {
  requireRecord(result, `${prefix}_RESULT_INVALID`, "Wrangler returned no inspectable result");
  if (result.error !== undefined || result.status !== 0) {
    refuse(`${prefix}_FAILED`, "Wrangler read-only control-plane query did not succeed");
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stderr.trim() !== "") {
    refuse(`${prefix}_OUTPUT_DRIFT`, "Wrangler control-plane query emitted unexpected output");
  }
  const size = Buffer.byteLength(result.stdout, "utf8");
  if (size <= 0 || size > MAX_CONTROL_PLANE_JSON_BYTES) {
    refuse(`${prefix}_OUTPUT_DRIFT`, "Wrangler JSON is empty or exceeds its closed byte limit");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    refuse(`${prefix}_OUTPUT_DRIFT`, "Wrangler output is not one JSON value");
  }
}

async function fetchChecked(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch {
    refuse("REMOTE_FETCH_FAILED", "remote pre-spend request failed without trusted response evidence");
  }
}

async function readAttestationResponse(response, expectedUrl) {
  requireResponseIdentity(response, expectedUrl, "REMOTE_ATTESTATION_HTTP_INVALID");
  if (response.status !== 200) {
    refuse("REMOTE_ATTESTATION_HTTP_INVALID", "authenticated attestation endpoint did not return HTTP 200");
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers.get("content-type") ?? "")) {
    refuse("REMOTE_ATTESTATION_HTTP_INVALID", "attestation endpoint did not return deterministic JSON");
  }
  if ((response.headers.get("cache-control") ?? "").toLowerCase() !== "no-store") {
    refuse("REMOTE_ATTESTATION_HTTP_INVALID", "attestation response is not marked no-store");
  }
  const text = await readBoundedResponseText(response, MAX_ATTESTATION_BYTES, "REMOTE_ATTESTATION_BODY_INVALID");
  try {
    return JSON.parse(text);
  } catch {
    refuse("REMOTE_ATTESTATION_BODY_INVALID", "attestation response is not one JSON value");
  }
}

async function inspectClosedDenial(response, expectedUrl, code) {
  requireResponseIdentity(response, expectedUrl, code);
  if (
    response.status !== 404 ||
    (response.headers.get("content-type") ?? "").toLowerCase() !== "text/plain; charset=utf-8" ||
    (response.headers.get("cache-control") ?? "").toLowerCase() !== "no-store" ||
    (response.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff" ||
    response.headers.has("location") ||
    response.headers.has("set-cookie") ||
    response.headers.has("www-authenticate")
  ) {
    refuse(code, "request did not receive the exact closed canary denial envelope");
  }
  const text = await readBoundedResponseText(response, MAX_DENIAL_BYTES, code);
  if (text !== "Not found\n") refuse(code, "request did not receive the exact closed canary denial body");
  return { sha256: sha256(text) };
}

function requireResponseIdentity(response, expectedUrl, code) {
  if (
    response === null ||
    typeof response !== "object" ||
    typeof response.status !== "number" ||
    response.headers === undefined ||
    typeof response.headers.get !== "function" ||
    response.url !== expectedUrl ||
    response.redirected === true
  ) {
    refuse(code, "remote response identity is missing, redirected, or ambiguous");
  }
}

async function readBoundedResponseText(response, maximumBytes, code) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBytes) {
      refuse(code, "remote response declared an invalid or excessive byte length");
    }
  }
  if (response.body === null || typeof response.body.getReader !== "function") {
    refuse(code, "remote response body is unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) refuse(code, "remote response stream returned invalid bytes");
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        refuse(code, "remote response exceeded its closed byte limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CanaryPostDeployAttestationError) throw error;
    refuse(code, "remote response body could not be read completely");
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse(code, "remote response body is not valid UTF-8");
  }
}

function mismatchedDocumentSubmission(expectedSha256) {
  const candidates = [
    Buffer.from("survey-qa mismatch probe A\n", "utf8"),
    Buffer.from("survey-qa mismatch probe B\n", "utf8"),
  ];
  const bytes = candidates.find((candidate) => sha256(candidate) !== expectedSha256);
  if (bytes === undefined) refuse("MISMATCH_PROBE_INVALID", "could not construct a provably mismatched document probe");
  const documentSha256 = sha256(bytes);
  const body = {
    contractSource: "extract",
    documentBase64: bytes.toString("base64"),
    documentName: "mismatched-document-probe.bin",
    locale: "en",
    profile: "standard",
    surveyUrl: "https://mismatch-probe.invalid/survey",
    viewports: ["desktop"],
  };
  return { documentSha256, serialized: JSON.stringify(body) };
}

function requireUnusedSafety(value) {
  requireRecord(value, "REMOTE_SAFETY_INVALID", "remote unused-arm evidence is missing");
  requireExactKeys(value, REMOTE_SAFETY_KEYS, "REMOTE_SAFETY_INVALID");
  if (
    value.providerCalls !== 0 ||
    value.providerCostUsd !== "0" ||
    value.submissionClaimState !== "unused" ||
    value.workflowInstancesCreated !== 0
  ) {
    refuse("REMOTE_SPEND_DETECTED", "remote arm is not provably unused before the paid submission");
  }
}

function requireAuditRecord(value) {
  requireRecord(value, "AUDIT_RECORD_INVALID", "post-deploy audit must be one object");
  const keys = [
    "accountId",
    "anonymousDenialSha256",
    "anonymousSubmissionDenialSha256",
    "deploymentCreatedOn",
    "deploymentId",
    "identitySha256",
    "malformedDenialSha256",
    "mismatchedDenialSha256",
    "mismatchedProbeDocumentSha256",
    "remoteAttestationSha256",
    "schemaVersion",
    "unusedSafetySha256",
    "versionCreatedOn",
    "versionId",
    "versionTag",
    "workerName",
  ];
  requireExactKeys(value, keys, "AUDIT_RECORD_INVALID");
  if (value.schemaVersion !== CANARY_POST_DEPLOY_AUDIT_SCHEMA) {
    refuse("AUDIT_RECORD_INVALID", "post-deploy audit schema version is unknown");
  }
  requirePattern(value.accountId, ACCOUNT_ID, "AUDIT_RECORD_INVALID");
  requirePattern(value.workerName, WORKER_NAME, "AUDIT_RECORD_INVALID");
  requirePattern(value.versionId, UUID, "AUDIT_RECORD_INVALID");
  requirePattern(value.deploymentId, UUID, "AUDIT_RECORD_INVALID");
  requirePattern(value.versionCreatedOn, ISO_TIMESTAMP, "AUDIT_RECORD_INVALID");
  requirePattern(value.deploymentCreatedOn, ISO_TIMESTAMP, "AUDIT_RECORD_INVALID");
  for (const key of [
    "anonymousDenialSha256",
    "anonymousSubmissionDenialSha256",
    "identitySha256",
    "malformedDenialSha256",
    "mismatchedDenialSha256",
    "mismatchedProbeDocumentSha256",
    "remoteAttestationSha256",
    "unusedSafetySha256",
  ]) requirePattern(value[key], SHA256_HEX, "AUDIT_RECORD_INVALID");
  requirePattern(value.versionTag, /^sqac-[0-9a-f]{24}$/u, "AUDIT_RECORD_INVALID");
}

function assertDerivedIdentity(value) {
  requireRecord(value, "IDENTITY_INVALID", "derived deployment identity is missing");
  const expected = deriveCanaryDeploymentIdentity(
    Object.fromEntries(IDENTITY_INPUT_KEYS.map((key) => [key, value[key]])),
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    refuse("IDENTITY_INVALID", "derived deployment identity is incomplete or has been changed");
  }
  return value;
}

function requireControlPlaneAttestation(value, identity) {
  requireRecord(value, "CONTROL_PLANE_INVALID", "control-plane attestation is missing");
  const keys = [
    "accountId",
    "deploymentCreatedOn",
    "deploymentId",
    "identitySha256",
    "schemaVersion",
    "versionCreatedOn",
    "versionId",
    "versionTag",
    "workerName",
  ];
  requireExactKeys(value, keys, "CONTROL_PLANE_INVALID");
  if (
    value.schemaVersion !== "survey-qa-canary-control-plane-attestation/1.0.0" ||
    value.accountId !== identity.accountId ||
    value.workerName !== identity.workerName ||
    value.identitySha256 !== identity.identitySha256 ||
    value.versionTag !== identity.versionTag
  ) refuse("CONTROL_PLANE_INVALID", "control-plane attestation does not bind the expected identity");
  requirePattern(value.versionId, UUID, "CONTROL_PLANE_INVALID");
  requirePattern(value.deploymentId, UUID, "CONTROL_PLANE_INVALID");
  requirePattern(value.versionCreatedOn, ISO_TIMESTAMP, "CONTROL_PLANE_INVALID");
  requirePattern(value.deploymentCreatedOn, ISO_TIMESTAMP, "CONTROL_PLANE_INVALID");
}

function requirePinnedWranglerDescriptor(value) {
  try {
    assertPinnedWranglerDescriptor(value);
  } catch {
    refuse("WRANGLER_DESCRIPTOR_INVALID", "control-plane plan requires exact Node and one absolute Wrangler entrypoint");
  }
}

function requireHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    refuse("BASE_URL_INVALID", "canary base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) refuse("BASE_URL_INVALID", "canary base URL must be one credential-free HTTPS origin");
  return parsed.origin;
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    refuse(code, "path must be exact and absolute");
  }
}

function requireAbsoluteRegularPathShape(value, code) {
  requireAbsolutePath(value, code);
  if (!/\.jsonc?$/iu.test(value)) refuse(code, "config path must name one JSON/JSONC file");
}

function requireRecord(value, code, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(code, message);
}

function requireExactKeys(value, expectedKeys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    refuse(code, "object has a missing, extra, or renamed field");
  }
}

function requireExactStringArray(value, expected, code) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) refuse(code, "string-array denominator differs from the independent closed set");
}

function requirePattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) refuse(code, "value has an invalid format");
}

function refuse(code, message) {
  throw new CanaryPostDeployAttestationError(code, message);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
