#!/usr/bin/env node

/**
 * Closed deploy -> one-paid-call handoff for the isolated visual canary.
 *
 * The eligibility marker is not authority by itself. This runner re-derives the deployment
 * identity from sealed source/build/signer/toolchain artifacts, checks the current 100%-traffic
 * Cloudflare deployment and unused runtime attestation, then runs the complete paginated
 * Workflow quiescence gate as the final action before exactly one valid POST. An exclusive claim
 * is permanently consumed before those remote checks, so concurrent or ambiguous retries fail.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "./verified-typescript.mjs";

import { canonicalize } from "../../scorer/src/lib/canonical.mjs";
import {
  CLOUDFLARE_GATEWAY_GEMINI_MODEL,
  MISTRAL_MEDIUM35_MODEL,
  WORKERS_AI_GEMMA4_MODEL,
  canaryVisualProviderConfiguration,
} from "../shared/visual-provider-config.mjs";
import {
  EXPECTED_CANARY_DYNAMIC_VAR_NAMES,
  EXPECTED_CANARY_WORKER,
  EXPECTED_CANARY_WORKFLOWS,
  EXPECTED_CLOUDFLARE_ACCOUNT_ID,
  ACTIVE_WORKFLOW_STATUSES,
  FILTERABLE_NONTERMINAL_STATUSES,
  readAndValidateCanaryConfig,
  runWorkflowGate,
  verifyAuditLog,
} from "./assert-no-active-canary-workflows.mjs";
import { EXPECTED_SIGNER_SECRET_NAMES } from "./audit-live-canary-remote-secrets.mjs";
import { verifyReviewedCanaryBundle } from "./canary-bundle-inputs.mjs";
import {
  REQUIRED_CANARY_REMOTE_BINDINGS,
  buildPinnedDeployEnvironment,
  buildPostDeployReadPlan,
  deriveCanaryDeploymentIdentity,
  inspectCurrentCanaryControlPlane,
  runCurrentCanaryRuntimeAttestation,
} from "./canary-post-deploy-attestation.mjs";
import { verifyCanarySourceSnapshot } from "./canary-source-snapshot.mjs";
import {
  CANARY_STATIC_VARS,
  canaryJudgementRegistry,
  canaryVisualPolicy,
} from "./generate-live-canary-config.mjs";
import {
  canarySigningSecretsJson,
  loadCanarySigningBundle,
} from "./generate-live-canary-signing-bundle.mjs";
import {
  CANARY_PROVIDER_MODELS,
  HARDENED_CANARY_ASSETS_MANIFEST_SCHEMA,
  HARDENED_CANARY_CONTROL_FILES,
  HARDENED_CANARY_DEPLOYMENT_INPUTS_SCHEMA,
  HARDENED_CANARY_ELIGIBILITY_SCHEMA,
  HARDENED_CANARY_RUN_ROOT,
  REPOSITORY_ROOT,
  buildExpectedCanaryDynamicVars,
  verifyCanaryAssetsManifest,
  verifyDeploymentControlManifest,
} from "./hardened-canary-deploy.mjs";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LiveCanaryError,
  executeLiveCanary,
  loadCanaryToken,
} from "./live-canary-core.mjs";
import {
  LIVE_CANARY_IDENTITY_HEADER,
  LIVE_CANARY_MAXIMUM_USD_HEADER,
  LIVE_CANARY_ORIGIN,
  LIVE_CANARY_POLICY_HEADER,
  LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER,
  LIVE_CANARY_PROVIDER_HEADER,
  LIVE_CANARY_VERSION_ID_HEADER,
} from "./live-canary-contract.mjs";
import {
  assertPinnedWranglerDescriptor,
  resolvePinnedWranglerCommand,
  verifyPinnedWranglerCommand,
} from "./pinned-wrangler-command.mjs";
import {
  assertPrivateLocalPath,
  hardenPrivateLocalDirectory,
} from "./private-local-output.mjs";

export const HARDENED_ONE_CALL_CLAIM_SCHEMA = "survey-qa-hardened-one-call-claim/1.0.0";
export const HARDENED_ONE_CALL_AUDIT_SCHEMA = "survey-qa-hardened-one-call-audit/1.0.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SAFE_RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CONTROL_MANIFEST_FILE = "deployment-control-manifest.json";
const ASSETS_MANIFEST_FILE = "assets-manifest.json";
const DEPLOYMENT_INPUTS_FILE = "deployment-inputs-manifest.json";
const BUILD_CONFIG_FILE = "wrangler.snapshot-build.json";
const DEPLOY_CONFIG_FILE = "wrangler.reviewed-deploy.json";
const TOKEN_FILE = "canary-token.txt";
const SECRET_FILE = "canary-worker-secrets.json";
const ELIGIBILITY_FILE = "eligible-for-one-call-runner.json";
const POST_DEPLOY_AUDIT_FILE = "post-deploy-pre-spend-audit.json";
const CLAIM_FILE = "one-call-runner-claim.json";
const RUNNER_AUDIT_FILE = "one-call-runner-audit.json";
const RESULT_DIRECTORY = "one-call-result";
const CONTROL_PLANE_LOG = "wrangler-one-call-control-plane.log";
const WORKFLOW_GATE_LOG = "wrangler-one-call-workflow-gate.log";
const AUTH_TOKEN = Symbol("auth-token");

const PROVIDER_MODELS = Object.freeze({
  "workers-ai-gemma4": WORKERS_AI_GEMMA4_MODEL,
  "cloudflare-gateway-gemini": CLOUDFLARE_GATEWAY_GEMINI_MODEL,
  "mistral-medium35-direct": MISTRAL_MEDIUM35_MODEL,
});

const ELIGIBILITY_KEYS = Object.freeze([
  "accountId",
  "assetsManifestSha256",
  "bundleInputsManifestSha256",
  "bundleMetafileSha256",
  "controlManifestSha256",
  "controlPlaneLogSha256",
  "deployConfigSha256",
  "deploymentId",
  "deploymentInputsManifestSha256",
  "identitySha256",
  "limitations",
  "model",
  "postDeployAuditSha256",
  "provider",
  "questionnaireSha256",
  "remoteSecretCount",
  "remoteSecretNamesSha256",
  "reviewedBundleManifestSha256",
  "schemaVersion",
  "secretFileSha256",
  "snapshotBuildConfigSha256",
  "sourceManifestSha256",
  "state",
  "tokenFileSha256",
  "tokenSha256",
  "versionId",
  "versionTag",
  "workerName",
  "workflowGateAfterDeployLogSha256",
  "workflowGateAfterDeployQueryCount",
  "workflowGateBeforeUploadLogSha256",
  "workflowGateBeforeUploadQueryCount",
  "workflowGateQueryCount",
].sort());

const EXPECTED_LIMITATIONS = Object.freeze([{
  code: "NON_ATOMIC_WORKFLOW_QUIESCENCE",
  description:
    "Workflow inactivity is a point-in-time observation; the separate valid-one-call runner must repeat the complete workflow gate immediately before model spend.",
}, {
  code: "ROLLOUT_OLD_VERSION_INGRESS_RACE",
  description:
    "The fresh token closes old ingress only after the new version receives traffic; a request reaching the prior version during the 100-percent transition is not atomically excluded.",
}, {
  code: "PRIVILEGED_LOCAL_SWAP_RESTORE_RACE",
  description:
    "Precommit and post-build hashing detect ordinary dependency drift but cannot prove bytes against a privileged actor that swaps and restores a dependency exactly around Wrangler reads.",
}]);

export class HardenedOneCallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HardenedOneCallError";
    this.code = code;
  }
}

/** Capture only the explicit OS/user-location allowlist; ambient credentials never survive. */
export function captureOneCallRunnerEnvironment(environment, runDirectory) {
  return Object.freeze(buildPinnedDeployEnvironment(
    environment,
    path.join(path.resolve(runDirectory), "environment-context.not-created.log"),
  ));
}

/** Read and independently reconcile every local input named by the eligibility marker. */
export async function inspectEligibleOneCallInputs(options = {}, dependencies = {}) {
  const repositoryRoot = exactDirectory(options.repositoryRoot ?? REPOSITORY_ROOT, "REPOSITORY_INVALID");
  const runRoot = exactDirectory(options.runRoot ?? HARDENED_CANARY_RUN_ROOT, "RUN_ROOT_INVALID");
  const runDirectory = exactRunDirectory(options.runDirectory, runRoot);
  const assertPrivatePathImpl = dependencies.assertPrivatePathImpl ?? assertPrivateLocalPath;
  assertPrivatePathImpl(runDirectory, repositoryRoot, { directory: true });

  const eligibilityIdentity = readCanonicalJson(
    path.join(runDirectory, ELIGIBILITY_FILE),
    repositoryRoot,
    "ELIGIBILITY",
    assertPrivatePathImpl,
  );
  const eligibility = validateEligibilityRecord(eligibilityIdentity.value);
  const paths = Object.freeze({
    assets: path.join(runDirectory, ASSETS_MANIFEST_FILE),
    buildConfig: path.join(runDirectory, BUILD_CONFIG_FILE),
    config: path.join(runDirectory, DEPLOY_CONFIG_FILE),
    control: path.join(runDirectory, CONTROL_MANIFEST_FILE),
    deploymentInputs: path.join(runDirectory, DEPLOYMENT_INPUTS_FILE),
    postDeployAudit: path.join(runDirectory, POST_DEPLOY_AUDIT_FILE),
    questionnaire: exactRegularFile(options.questionnairePath, "QUESTIONNAIRE_INVALID"),
    reviewedBundle: path.join(runDirectory, "reviewed-bundle"),
    signingBundle: exactRegularFile(options.signingBundlePath, "SIGNING_BUNDLE_INVALID"),
    snapshot: path.join(runDirectory, "source-snapshot"),
    token: path.join(runDirectory, TOKEN_FILE),
    secrets: path.join(runDirectory, SECRET_FILE),
  });

  const snapshot = verifyCanarySourceSnapshot({ snapshotDirectory: paths.snapshot, repositoryRoot });
  const reviewed = verifyReviewedCanaryBundle({
    reviewedBundleDirectory: paths.reviewedBundle,
    snapshotDirectory: paths.snapshot,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  if (
    snapshot.manifestSha256 !== eligibility.sourceManifestSha256 ||
    reviewed.manifestSha256 !== eligibility.reviewedBundleManifestSha256 ||
    reviewed.bundleInputsManifestSha256 !== eligibility.bundleInputsManifestSha256 ||
    reviewed.manifest.metafileSha256 !== eligibility.bundleMetafileSha256
  ) refuse("ELIGIBILITY_BUILD_MISMATCH", "eligibility does not identify the verified source/reviewed build");

  verifyDeploymentControlManifest({
    repositoryRoot,
    manifestPath: paths.control,
    expectedManifestSha256: eligibility.controlManifestSha256,
    controlFiles: HARDENED_CANARY_CONTROL_FILES,
    assertPrivatePathImpl,
  });
  verifyCanaryAssetsManifest({
    snapshotDirectory: paths.snapshot,
    sourceManifestSha256: snapshot.manifestSha256,
    assetsManifestPath: paths.assets,
    expectedAssetsManifestSha256: eligibility.assetsManifestSha256,
    repositoryRoot,
    assertPrivatePathImpl,
  });

  const questionnaire = fileIdentity(paths.questionnaire, path.dirname(paths.questionnaire), "QUESTIONNAIRE_INVALID");
  if (questionnaire.sha256 !== eligibility.questionnaireSha256) {
    refuse("QUESTIONNAIRE_SHA256_MISMATCH", "questionnaire bytes differ from the eligibility-bound document");
  }
  const tokenFile = fileIdentity(paths.token, repositoryRoot, "TOKEN_FILE_INVALID");
  if (tokenFile.sha256 !== eligibility.tokenFileSha256) {
    refuse("TOKEN_FILE_MISMATCH", "canary token file differs from the eligibility marker");
  }
  const token = await (dependencies.loadCanaryTokenImpl ?? loadCanaryToken)(paths.token);
  if (
    sha256(Buffer.from(token, "utf8")) !== eligibility.tokenSha256 ||
    !readFileSync(paths.token).equals(Buffer.from(`${token}\n`, "utf8"))
  ) refuse("TOKEN_IDENTITY_MISMATCH", "canary token bytes do not match the eligibility-bound authentication identity");

  const signingBundle = await (dependencies.loadSigningBundleImpl ?? loadCanarySigningBundle)(paths.signingBundle);
  const expectedSecrets = Buffer.from(canarySigningSecretsJson(signingBundle), "utf8");
  const secretBytes = readBoundedFile(paths.secrets, repositoryRoot, "SECRET_FILE_INVALID");
  if (
    sha256(secretBytes) !== eligibility.secretFileSha256 ||
    !secretBytes.equals(expectedSecrets)
  ) refuse("SIGNING_SECRET_MISMATCH", "Worker signing secrets do not match the independently verified signing bundle");

  const pinnedWrangler = (dependencies.resolvePinnedWranglerCommandImpl ?? resolvePinnedWranglerCommand)();
  const wrangler = wranglerIdentity(pinnedWrangler);
  const policy = canaryVisualPolicy(eligibility.provider, 1);
  const providerConfiguration = canaryVisualProviderConfiguration(eligibility.provider, {
    gatewayId: CANARY_STATIC_VARS.CF_AIG_GATEWAY_ID,
  });
  const providerConfigurationSha256 = sha256(Buffer.from(canonicalize(providerConfiguration), "utf8"));
  if (
    PROVIDER_MODELS[eligibility.provider] !== eligibility.model ||
    CANARY_PROVIDER_MODELS[eligibility.provider] !== eligibility.model ||
    providerConfiguration.model !== eligibility.model
  ) refuse("PROVIDER_MODEL_MISMATCH", "provider/model identity is not the shared runtime adapter selection");

  const sourceConfig = parseJsonc(
    path.join(paths.snapshot, "worker-v2", "wrangler.jsonc"),
    repositoryRoot,
  );
  const judgementRegistry = canaryJudgementRegistry(sourceConfig, signingBundle);
  const identity = deriveCanaryDeploymentIdentity({
    accountId: EXPECTED_CLOUDFLARE_ACCOUNT_ID,
    bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
    bundleMetafileSha256: reviewed.manifest.metafileSha256,
    judgementPublicKeyId: signingBundle.judgement.keyId,
    judgementPublicKeySha256: signingBundle.judgement.publicKeySpkiSha256,
    model: eligibility.model,
    provider: eligibility.provider,
    providerConfigurationSha256,
    providerPolicySha256: policy.sha256,
    questionnaireSha256: questionnaire.sha256,
    recordPublicKeyId: signingBundle.record.keyId,
    recordPublicKeySha256: signingBundle.record.publicKeySpkiSha256,
    requiredBindings: [...REQUIRED_CANARY_REMOTE_BINDINGS],
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    sourceManifestSha256: snapshot.manifestSha256,
    visualMaximumCalls: 1,
    visualMaximumUsd: policy.maximumUsd,
    workerName: EXPECTED_CANARY_WORKER,
    wrangler,
  });
  assertEligibilityIdentity(eligibility, identity);

  const expectedDynamicVars = buildExpectedCanaryDynamicVars({
    tokenSha256: eligibility.tokenSha256,
    expectedDocumentSha256: questionnaire.sha256,
    sourceManifestSha256: snapshot.manifestSha256,
    reviewed,
    provider: eligibility.provider,
    visualPolicy: policy,
    judgementRegistryJson: judgementRegistry.registryJson,
    identity,
  });
  if (canonicalize(Object.keys(expectedDynamicVars).sort()) !== canonicalize([...EXPECTED_CANARY_DYNAMIC_VAR_NAMES])) {
    refuse("DYNAMIC_VAR_SCHEMA_DRIFT", "independently derived dynamic vars have an open denominator");
  }

  const configIdentity = fileIdentity(paths.config, repositoryRoot, "DEPLOY_CONFIG_INVALID");
  if (configIdentity.sha256 !== eligibility.deployConfigSha256) {
    refuse("DEPLOY_CONFIG_MISMATCH", "deploy config bytes differ from the eligibility marker");
  }
  readAndValidateCanaryConfig(paths.config, {
    repositoryRoot,
    expectedProvider: eligibility.provider,
    expectedDocumentSha256: questionnaire.sha256,
    expectedDynamicVars,
    reviewedDeployment: {
      sourceSnapshotDirectory: paths.snapshot,
      reviewedBundleDirectory: paths.reviewedBundle,
      expectedSourceManifestSha256: snapshot.manifestSha256,
      expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    },
    assertPrivatePathImpl,
  });

  const buildConfig = fileIdentity(paths.buildConfig, repositoryRoot, "BUILD_CONFIG_INVALID");
  if (buildConfig.sha256 !== eligibility.snapshotBuildConfigSha256) {
    refuse("BUILD_CONFIG_MISMATCH", "snapshot build config differs from the eligibility marker");
  }
  const deploymentInputsIdentity = readCanonicalJson(
    paths.deploymentInputs,
    repositoryRoot,
    "DEPLOYMENT_INPUTS",
    assertPrivatePathImpl,
  );
  if (deploymentInputsIdentity.sha256 !== eligibility.deploymentInputsManifestSha256) {
    refuse("DEPLOYMENT_INPUTS_MISMATCH", "deployment-input bytes differ from the eligibility marker");
  }
  const expectedDeploymentInputs = {
    schemaVersion: HARDENED_CANARY_DEPLOYMENT_INPUTS_SCHEMA,
    assetsManifestSha256: eligibility.assetsManifestSha256,
    bundleInputsManifestSha256: reviewed.bundleInputsManifestSha256,
    bundleMetafileSha256: reviewed.manifest.metafileSha256,
    controlManifestSha256: eligibility.controlManifestSha256,
    provider: {
      configurationSha256: providerConfigurationSha256,
      maximumCalls: 1,
      maximumUsd: policy.maximumUsd,
      model: eligibility.model,
      name: eligibility.provider,
      policySha256: policy.sha256,
    },
    questionnaireSha256: questionnaire.sha256,
    reviewedBundleManifestSha256: reviewed.manifestSha256,
    signers: {
      judgementKeyId: signingBundle.judgement.keyId,
      judgementPublicKeySha256: signingBundle.judgement.publicKeySpkiSha256,
      recordKeyId: signingBundle.record.keyId,
      recordPublicKeySha256: signingBundle.record.publicKeySpkiSha256,
    },
    snapshotBuildConfigSha256: buildConfig.sha256,
    sourceManifestSha256: snapshot.manifestSha256,
    wrangler,
  };
  if (canonicalize(deploymentInputsIdentity.value) !== canonicalize(expectedDeploymentInputs)) {
    refuse("DEPLOYMENT_INPUTS_IDENTITY_MISMATCH", "deployment-input manifest does not match independently derived artifacts");
  }

  verifyBoundAuditFiles(runDirectory, repositoryRoot, eligibility, identity, assertPrivatePathImpl);
  const publicState = {
    repositoryRoot,
    runDirectory,
    eligibility,
    eligibilitySha256: eligibilityIdentity.sha256,
    identity,
    expectedDynamicVars,
    environment: captureOneCallRunnerEnvironment(options.environment ?? process.env, runDirectory),
    pinnedWrangler,
    questionnaire,
    signingBundlePublicIdentity: {
      judgementKeyId: signingBundle.judgement.keyId,
      judgementPublicKeySha256: signingBundle.judgement.publicKeySpkiSha256,
      recordKeyId: signingBundle.record.keyId,
      recordPublicKeySha256: signingBundle.record.publicKeySpkiSha256,
    },
    paths,
    assertPrivatePathImpl,
  };
  Object.defineProperty(publicState, AUTH_TOKEN, { value: token, enumerable: false });
  return Object.freeze(publicState);
}

/** Exact eligibility schema; mutations are refused before a claim or network operation. */
export function validateEligibilityRecord(value) {
  exactObject(value, ELIGIBILITY_KEYS, "ELIGIBILITY_SCHEMA_DRIFT");
  if (
    value.schemaVersion !== HARDENED_CANARY_ELIGIBILITY_SCHEMA ||
    value.state !== "eligible-for-separate-valid-one-call-runner" ||
    value.accountId !== EXPECTED_CLOUDFLARE_ACCOUNT_ID ||
    value.workerName !== EXPECTED_CANARY_WORKER ||
    !(value.provider in PROVIDER_MODELS) ||
    value.model !== PROVIDER_MODELS[value.provider] ||
    !UUID.test(value.versionId ?? "") ||
    !UUID.test(value.deploymentId ?? "") ||
    value.versionTag !== `sqac-${String(value.identitySha256).slice(0, 24)}` ||
    value.remoteSecretCount !== EXPECTED_SIGNER_SECRET_NAMES.length ||
    canonicalize(value.limitations) !== canonicalize(EXPECTED_LIMITATIONS)
  ) refuse("ELIGIBILITY_INVALID", "eligibility marker is stale, malformed, or not a closed one-call arm");
  for (const key of ELIGIBILITY_KEYS.filter((key) => key.endsWith("Sha256"))) requireSha256(value[key], "ELIGIBILITY_DIGEST_INVALID");
  for (const key of [
    "workflowGateQueryCount",
    "workflowGateBeforeUploadQueryCount",
    "workflowGateAfterDeployQueryCount",
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
      refuse("ELIGIBILITY_WORKFLOW_GATE_INVALID", "eligibility has no positive Workflow gate denominator");
    }
  }
  if (
    value.workflowGateQueryCount !==
      value.workflowGateBeforeUploadQueryCount + value.workflowGateAfterDeployQueryCount ||
    value.workflowGateBeforeUploadQueryCount < FILTERABLE_NONTERMINAL_STATUSES.length * 2 + 2 ||
    value.workflowGateAfterDeployQueryCount < FILTERABLE_NONTERMINAL_STATUSES.length * 2 + 2
  ) refuse("ELIGIBILITY_WORKFLOW_GATE_INVALID", "eligibility Workflow gate coverage is incomplete");
  return Object.freeze(structuredClone(value));
}

/** Execute one claimed run. No dependency may bypass the final beforeSubmission interlock. */
export async function runEligibleOneCall(options = {}, dependencies = {}) {
  const inspectImpl = dependencies.inspectLocalInputsImpl ?? inspectEligibleOneCallInputs;
  const initial = await inspectImpl(options, dependencies);
  const capturedEnvironment = captureOneCallRunnerEnvironment(
    options.environment ?? process.env,
    initial.runDirectory,
  );
  if (canonicalize(initial.environment) !== canonicalize(capturedEnvironment)) {
    refuse("RUNNER_ENVIRONMENT_DRIFT", "local inspection did not retain the minimal pinned runner environment");
  }
  const initialFingerprint = localStateFingerprint(initial);
  const surveyUrl = normalizedSurveyUrl(options.surveyUrl);
  const outputDirectory = path.join(initial.runDirectory, RESULT_DIRECTORY);
  requireAbsent(outputDirectory, "RESULT_DIRECTORY_EXISTS");
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  (dependencies.hardenDirectoryImpl ?? hardenPrivateLocalDirectory)(outputDirectory, initial.repositoryRoot);
  initial.assertPrivatePathImpl(outputDirectory, initial.repositoryRoot, { directory: true });

  let paidSubmissionAttempts = 0;
  let hookCalls = 0;
  let claimIdentity = null;
  let finalWorkflowGate = null;
  let currentControlPlane = null;
  let repeatedRemoteAudit = null;
  let claimedSubmissionBodySha256 = null;
  let finalGateArmed = false;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") refuse("FETCH_UNAVAILABLE", "a fetch implementation is required");
  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== LIVE_CANARY_ORIGIN || url.username || url.password) {
      refuse("RUNNER_NETWORK_TARGET_REFUSED", "one-call execution attempted an unreviewed network origin");
    }
    if (finalGateArmed && !(method === "POST" && url.pathname === "/api/v2/runs" && !url.search)) {
      refuse("FINAL_GATE_INTERVENING_REQUEST", "no request may intervene between the final Workflow gate and the claimed POST");
    }
    if (method === "POST") {
      if (url.pathname !== "/api/v2/runs" || url.search || init.redirect !== "manual") {
        refuse("RUNNER_PAID_ROUTE_REFUSED", "one-call execution attempted an unreviewed POST shape");
      }
      if (
        hookCalls !== 1 ||
        claimIdentity === null ||
        currentControlPlane === null ||
        repeatedRemoteAudit === null ||
        finalWorkflowGate === null
      ) refuse("PAID_POST_GATE_INCOMPLETE", "valid POST was attempted before every eligibility gate completed");
      if (
        claimedSubmissionBodySha256 === null ||
        finalWorkflowGate === null ||
        typeof init.body !== "string" ||
        sha256(Buffer.from(init.body, "utf8")) !== claimedSubmissionBodySha256
      ) refuse("PAID_POST_BODY_MISMATCH", "actual paid POST bytes differ from the claimed submission body");
      const headers = new Headers(init.headers ?? {});
      const headerEntries = [...headers.entries()];
      const expectedHeaderNames = [
        "accept",
        "content-type",
        LIVE_CANARY_IDENTITY_HEADER,
        LIVE_CANARY_MAXIMUM_USD_HEADER,
        LIVE_CANARY_POLICY_HEADER,
        LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER,
        LIVE_CANARY_PROVIDER_HEADER,
        LIVE_CANARY_VERSION_ID_HEADER,
        "x-survey-qa-canary-token",
      ].sort();
      if (
        canonicalize(headerEntries.map(([name]) => name).sort()) !== canonicalize(expectedHeaderNames) ||
        headers.get("accept") !== "application/json" ||
        headers.get("content-type") !== "application/json; charset=utf-8" ||
        headers.get(LIVE_CANARY_IDENTITY_HEADER) !== initial.identity.identitySha256 ||
        headers.get(LIVE_CANARY_VERSION_ID_HEADER) !== initial.eligibility.versionId ||
        headers.get(LIVE_CANARY_PROVIDER_HEADER) !== initial.identity.provider ||
        headers.get(LIVE_CANARY_POLICY_HEADER) !== initial.identity.providerPolicySha256 ||
        headers.get(LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER) !==
          initial.identity.providerConfigurationSha256 ||
        headers.get(LIVE_CANARY_MAXIMUM_USD_HEADER) !== initial.identity.visualMaximumUsd ||
        sha256(Buffer.from(headers.get("x-survey-qa-canary-token") ?? "", "utf8")) !==
          initial.eligibility.tokenSha256
      ) refuse("PAID_POST_AUTH_MISMATCH", "actual paid POST headers do not carry only the eligibility-bound canary credential");
      paidSubmissionAttempts += 1;
      if (paidSubmissionAttempts !== 1) {
        refuse("MULTIPLE_PAID_SUBMISSIONS_REFUSED", "the runner permits exactly one valid submission attempt");
      }
      finalGateArmed = false;
    } else if (method !== "GET") {
      refuse("RUNNER_METHOD_REFUSED", "one-call execution attempted an unreviewed HTTP method");
    }
    return await fetchImpl(input, init);
  };

  const reinspect = async () => {
    const current = await (dependencies.reinspectLocalInputsImpl ?? inspectImpl)(options, dependencies);
    if (localStateFingerprint(current) !== initialFingerprint) {
      refuse("LOCAL_ELIGIBILITY_DRIFT", "eligibility-bound local artifacts changed during the one-call handoff");
    }
    return current;
  };

  const beforeSubmission = async (context) => {
    hookCalls += 1;
    if (hookCalls !== 1) refuse("SUBMISSION_GATE_REENTERED", "the final one-call interlock was invoked more than once");
    assertSubmissionContext(context, initial, surveyUrl);
    const claim = {
      schemaVersion: HARDENED_ONE_CALL_CLAIM_SCHEMA,
      state: "permanently-claimed",
      authenticationSha256: context.authenticationCredentialSha256,
      baseUrl: LIVE_CANARY_ORIGIN,
      deploymentId: initial.eligibility.deploymentId,
      documentSha256: context.documentSha256,
      eligibilitySha256: initial.eligibilitySha256,
      identitySha256: initial.identity.identitySha256,
      model: initial.eligibility.model,
      provider: initial.eligibility.provider,
      submissionBodySha256: context.submissionBodySha256,
      surveyUrlSha256: sha256(Buffer.from(surveyUrl, "utf8")),
      versionId: initial.eligibility.versionId,
    };
    claimIdentity = (dependencies.writeClaimImpl ?? writeCanonicalExclusive)({
      value: claim,
      outputFile: path.join(initial.runDirectory, CLAIM_FILE),
      repositoryRoot: initial.repositoryRoot,
      assertPrivatePathImpl: initial.assertPrivatePathImpl,
    });
    claimedSubmissionBodySha256 = context.submissionBodySha256;

    let current = await reinspect();
    currentControlPlane = await (dependencies.runCurrentControlPlaneImpl ?? runCurrentControlPlane)(current, dependencies);
    current = await reinspect();
    repeatedRemoteAudit = await (dependencies.runRemoteGateImpl ?? runCurrentCanaryRuntimeAttestation)({
      baseUrl: LIVE_CANARY_ORIGIN,
      authToken: current[AUTH_TOKEN],
      expectedIdentity: current.identity,
      controlPlane: currentControlPlane,
      fetchImpl: dependencies.preSpendFetchImpl ?? globalThis.fetch,
    });
    repeatedRemoteAudit = assertClosedCurrentRuntimeAudit(
      repeatedRemoteAudit,
      current,
      currentControlPlane,
    );
    current = await reinspect();
    const workflowLogFile = path.join(current.runDirectory, WORKFLOW_GATE_LOG);
    const workflowEnvironment = buildPinnedDeployEnvironment(current.environment, workflowLogFile);
    const underlyingSpawnSync = dependencies.spawnSyncImpl ?? spawnSync;
    const guardedWorkflowSpawn = (command, args, spawnOptions) => {
      (dependencies.reverifySynchronousImpl ?? reverifySynchronousRunnerState)(current, dependencies);
      const pinned = (dependencies.verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand)(
        current.pinnedWrangler,
      );
      if (
        command !== pinned.command ||
        canonicalize(args.slice(0, pinned.argsPrefix.length)) !== canonicalize(pinned.argsPrefix) ||
        canonicalize(spawnOptions?.env) !== canonicalize(workflowEnvironment)
      ) refuse("WORKFLOW_GATE_COMMAND_DRIFT", "final Workflow gate attempted an unpinned command or environment");
      return underlyingSpawnSync(command, args, spawnOptions);
    };
    finalWorkflowGate = (dependencies.runWorkflowGateImpl ?? runWorkflowGate)({
      configPath: current.paths.config,
      logFile: workflowLogFile,
      expectedProvider: current.eligibility.provider,
      expectedDocumentSha256: current.questionnaire.sha256,
      expectedDynamicVars: current.expectedDynamicVars,
      reviewedDeployment: {
        sourceSnapshotDirectory: current.paths.snapshot,
        reviewedBundleDirectory: current.paths.reviewedBundle,
        expectedSourceManifestSha256: current.identity.sourceManifestSha256,
        expectedReviewedBundleManifestSha256: current.identity.reviewedBundleManifestSha256,
      },
      repositoryRoot: current.repositoryRoot,
      workerRoot: WORKER_ROOT,
      environment: workflowEnvironment,
      spawnSyncImpl: guardedWorkflowSpawn,
      resolvePinnedWranglerCommandImpl: () => (
        dependencies.verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand
      )(current.pinnedWrangler),
      assertPrivatePathImpl: current.assertPrivatePathImpl,
      verifyAuditLogImpl: dependencies.verifyWorkflowLogImpl ?? verifyAuditLog,
    });
    finalWorkflowGate = assertClosedFinalWorkflowGate(finalWorkflowGate, current);
    finalGateArmed = true;
    // Deliberately no file write, query, attestation, or local re-verification after this line.
    // executeLiveCanary issues the already-built valid POST as soon as this hook returns.
  };

  let summary = null;
  let failure = null;
  try {
    summary = await (dependencies.executeImpl ?? executeLiveCanary)({
      baseUrl: LIVE_CANARY_ORIGIN,
      canaryTokenFile: initial.paths.token,
      surveyUrl,
      docx: initial.paths.questionnaire,
      expectedDocumentSha256: initial.questionnaire.sha256,
      outputDir: outputDirectory,
      expectVisual: "enabled",
      expectedVisualProvider: initial.eligibility.provider,
      submissionRuntimeIdentity: {
        identitySha256: initial.identity.identitySha256,
        versionId: initial.eligibility.versionId,
        provider: initial.identity.provider,
        policySha256: initial.identity.providerPolicySha256,
        providerConfigurationSha256: initial.identity.providerConfigurationSha256,
        maximumUsd: initial.identity.visualMaximumUsd,
      },
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }, {
      beforeSubmission,
      fetchImpl: guardedFetch,
      sleep: dependencies.sleep,
      nowMs: dependencies.nowMs,
    });
    if (hookCalls !== 1 || paidSubmissionAttempts !== 1) {
      refuse("ONE_CALL_NOT_EXERCISED", "execution returned without exactly one gated valid submission attempt");
    }
  } catch (error) {
    failure = normalizedFailure(error, initial[AUTH_TOKEN]);
  }

  const summaryPath = path.join(outputDirectory, "canary-summary.json");
  const summaryIdentity = existsSync(summaryPath)
    ? fileIdentity(summaryPath, initial.repositoryRoot, "RUNNER_SUMMARY_INVALID")
    : null;
  const audit = {
    schemaVersion: HARDENED_ONE_CALL_AUDIT_SCHEMA,
    state: failure === null ? "completed" : "failed",
    eligibilitySha256: initial.eligibilitySha256,
    identitySha256: initial.identity.identitySha256,
    provider: initial.eligibility.provider,
    model: initial.eligibility.model,
    questionnaireSha256: initial.questionnaire.sha256,
    versionId: initial.eligibility.versionId,
    deploymentId: initial.eligibility.deploymentId,
    claimSha256: claimIdentity?.sha256 ?? null,
    currentControlPlaneIdentitySha256: currentControlPlane?.identitySha256 ?? null,
    repeatedRemoteAttestationSha256: repeatedRemoteAudit === null
      ? null
      : sha256(Buffer.from(canonicalize(repeatedRemoteAudit), "utf8")),
    finalWorkflowGateQueryCount: finalWorkflowGate?.queryCount ?? null,
    finalWorkflowGateLogSha256: finalWorkflowGate?.logAudit?.sha256 ?? null,
    paidSubmissionAttempts,
    result: summary === null ? null : {
      runId: summary.runId,
      outcome: summary.outcome,
      directory: RESULT_DIRECTORY,
      summaryFile: summaryIdentity === null ? null : "canary-summary.json",
      summarySha256: summaryIdentity?.sha256 ?? null,
    },
    failure,
  };
  const auditIdentity = (dependencies.writeAuditImpl ?? writeCanonicalExclusive)({
    value: audit,
    outputFile: path.join(initial.runDirectory, RUNNER_AUDIT_FILE),
    repositoryRoot: initial.repositoryRoot,
    assertPrivatePathImpl: initial.assertPrivatePathImpl,
  });
  const publicResult = Object.freeze({
    schemaVersion: HARDENED_ONE_CALL_AUDIT_SCHEMA,
    state: audit.state,
    auditFile: auditIdentity.path,
    auditSha256: auditIdentity.sha256,
    resultDirectory: summary === null ? null : outputDirectory,
    runId: summary?.runId ?? null,
    outcome: summary?.outcome ?? null,
    paidSubmissionAttempts,
    failure,
  });
  if (failure !== null) throw new HardenedOneCallError(failure.code, failure.message);
  return publicResult;
}

/** Read-only current-version/deployment reconciliation; raw Wrangler JSON is never returned. */
export function runCurrentControlPlane(state, dependencies = {}) {
  const logFile = path.join(state.runDirectory, CONTROL_PLANE_LOG);
  requireAbsent(logFile, "CONTROL_PLANE_LOG_EXISTS");
  const plan = buildPostDeployReadPlan({
    pinnedWrangler: state.pinnedWrangler,
    configPath: state.paths.config,
    workerName: EXPECTED_CANARY_WORKER,
    logFile,
    environment: state.environment,
  });
  const results = {};
  for (const command of plan.commands) {
    (dependencies.reverifySynchronousImpl ?? reverifySynchronousRunnerState)(state, dependencies);
    (dependencies.verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand)(state.pinnedWrangler);
    results[command.kind] = (dependencies.spawnSyncImpl ?? spawnSync)(command.command, command.args, {
      cwd: WORKER_ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: "SIGTERM",
      env: plan.environment,
    });
  }
  const controlPlane = inspectCurrentCanaryControlPlane({
    versionsResult: results.versions,
    deploymentsResult: results.deployments,
    expectedIdentity: state.identity,
    expectedVersionId: state.eligibility.versionId,
    expectedDeploymentId: state.eligibility.deploymentId,
  });
  const logAudit = (dependencies.verifyControlPlaneLogImpl ?? verifyAuditLog)(
    logFile,
    state.repositoryRoot,
    state.assertPrivatePathImpl,
  );
  return Object.freeze({ ...controlPlane, controlPlaneLogSha256: logAudit.sha256 });
}

/**
 * Synchronous byte/identity check used immediately before every Wrangler subprocess in the final
 * gate. It intentionally repeats the expensive source and reviewed-bundle proofs: a successful
 * first query is not evidence for bytes consumed by the next query.
 */
export function reverifySynchronousRunnerState(state, dependencies = {}) {
  if (!isRecord(state) || !isRecord(state.paths) || !isRecord(state.eligibility)) {
    refuse("LOCAL_STATE_INVALID", "no eligibility-bound state is available for synchronous re-verification");
  }
  const eligibilityIdentity = readCanonicalJson(
    path.join(state.runDirectory, ELIGIBILITY_FILE),
    state.repositoryRoot,
    "ELIGIBILITY",
    state.assertPrivatePathImpl,
  );
  if (eligibilityIdentity.sha256 !== state.eligibilitySha256) {
    refuse("ELIGIBILITY_DRIFT", "eligibility bytes changed during the final gate");
  }
  validateEligibilityRecord(eligibilityIdentity.value);
  const snapshot = verifyCanarySourceSnapshot({
    snapshotDirectory: state.paths.snapshot,
    repositoryRoot: state.repositoryRoot,
  });
  const reviewed = verifyReviewedCanaryBundle({
    reviewedBundleDirectory: state.paths.reviewedBundle,
    snapshotDirectory: state.paths.snapshot,
    repositoryRoot: state.repositoryRoot,
    assertPrivatePathImpl: state.assertPrivatePathImpl,
  });
  if (
    snapshot.manifestSha256 !== state.identity.sourceManifestSha256 ||
    reviewed.manifestSha256 !== state.identity.reviewedBundleManifestSha256 ||
    reviewed.bundleInputsManifestSha256 !== state.identity.bundleInputsManifestSha256 ||
    reviewed.manifest.metafileSha256 !== state.identity.bundleMetafileSha256
  ) refuse("REVIEWED_BUILD_DRIFT", "source or reviewed bundle changed during the final gate");
  verifyDeploymentControlManifest({
    repositoryRoot: state.repositoryRoot,
    manifestPath: state.paths.control,
    expectedManifestSha256: state.eligibility.controlManifestSha256,
    controlFiles: HARDENED_CANARY_CONTROL_FILES,
    assertPrivatePathImpl: state.assertPrivatePathImpl,
  });
  verifyCanaryAssetsManifest({
    snapshotDirectory: state.paths.snapshot,
    sourceManifestSha256: state.identity.sourceManifestSha256,
    assetsManifestPath: state.paths.assets,
    expectedAssetsManifestSha256: state.eligibility.assetsManifestSha256,
    repositoryRoot: state.repositoryRoot,
    assertPrivatePathImpl: state.assertPrivatePathImpl,
  });
  for (const [candidate, expected, code] of [
    [state.paths.config, state.eligibility.deployConfigSha256, "DEPLOY_CONFIG_DRIFT"],
    [state.paths.buildConfig, state.eligibility.snapshotBuildConfigSha256, "BUILD_CONFIG_DRIFT"],
    [state.paths.deploymentInputs, state.eligibility.deploymentInputsManifestSha256, "DEPLOYMENT_INPUTS_DRIFT"],
    [state.paths.questionnaire, state.eligibility.questionnaireSha256, "QUESTIONNAIRE_DRIFT"],
    [state.paths.token, state.eligibility.tokenFileSha256, "TOKEN_FILE_DRIFT"],
    [state.paths.secrets, state.eligibility.secretFileSha256, "SECRET_FILE_DRIFT"],
    [state.paths.postDeployAudit, state.eligibility.postDeployAuditSha256, "POST_DEPLOY_AUDIT_DRIFT"],
  ]) assertFileSha256(candidate, expected, state.repositoryRoot, code, state.assertPrivatePathImpl);
  readAndValidateCanaryConfig(state.paths.config, {
    repositoryRoot: state.repositoryRoot,
    expectedProvider: state.eligibility.provider,
    expectedDocumentSha256: state.questionnaire.sha256,
    expectedDynamicVars: state.expectedDynamicVars,
    reviewedDeployment: {
      sourceSnapshotDirectory: state.paths.snapshot,
      reviewedBundleDirectory: state.paths.reviewedBundle,
      expectedSourceManifestSha256: state.identity.sourceManifestSha256,
      expectedReviewedBundleManifestSha256: state.identity.reviewedBundleManifestSha256,
    },
    assertPrivatePathImpl: state.assertPrivatePathImpl,
  });
  (dependencies.verifyPinnedWranglerCommandImpl ?? verifyPinnedWranglerCommand)(state.pinnedWrangler);
  return true;
}

/** Validate the complete query denominator returned by the final paginated Workflow gate. */
export function assertClosedFinalWorkflowGate(value, state) {
  exactObject(value, [
    "accountId",
    "configSha256",
    "expectedDocumentSha256",
    "logAudit",
    "queries",
    "queryCount",
    "statuses",
    "visualPolicy",
    "workerName",
    "workflowNames",
    "wranglerPin",
    "wranglerVersion",
  ].sort(), "FINAL_WORKFLOW_GATE_SCHEMA_DRIFT");
  const expectedPolicy = canaryVisualPolicy(state.eligibility.provider, 1);
  const expectedVisualPolicy = {
    provider: expectedPolicy.provider,
    profile: expectedPolicy.profile,
    maximumCalls: expectedPolicy.maximumCalls,
    maximumUsd: expectedPolicy.maximumUsd,
    sha256: expectedPolicy.sha256,
  };
  if (
    value.accountId !== EXPECTED_CLOUDFLARE_ACCOUNT_ID ||
    value.workerName !== EXPECTED_CANARY_WORKER ||
    value.wranglerVersion !== "4.106.0" ||
    value.configSha256 !== state.eligibility.deployConfigSha256 ||
    value.expectedDocumentSha256 !== state.questionnaire.sha256 ||
    canonicalize(value.workflowNames) !== canonicalize([...EXPECTED_CANARY_WORKFLOWS]) ||
    canonicalize(value.statuses) !== canonicalize([...ACTIVE_WORKFLOW_STATUSES]) ||
    canonicalize(value.visualPolicy) !== canonicalize(expectedVisualPolicy) ||
    !isRecord(value.wranglerPin) ||
    canonicalize(value.wranglerPin) !== canonicalize(wranglerIdentity(state.pinnedWrangler)) ||
    !isRecord(value.logAudit) ||
    canonicalize(Object.keys(value.logAudit).sort()) !== canonicalize(["bytes", "sha256"]) ||
    !Number.isSafeInteger(value.logAudit.bytes) ||
    value.logAudit.bytes <= 0 ||
    !SHA256_HEX.test(value.logAudit.sha256 ?? "") ||
    !Array.isArray(value.queries) ||
    !Number.isSafeInteger(value.queryCount) ||
    value.queryCount !== value.queries.length
  ) refuse("FINAL_WORKFLOW_GATE_INVALID", "final Workflow gate identity or denominator is incomplete");

  const used = new Set();
  for (const workflowName of EXPECTED_CANARY_WORKFLOWS) {
    for (const status of FILTERABLE_NONTERMINAL_STATUSES) {
      const matches = value.queries.filter((query) =>
        isRecord(query) &&
        query.workflowName === workflowName &&
        query.status === status &&
        query.state === "no-instances"
      );
      if (matches.length !== 1 || Object.keys(matches[0]).sort().join("\0") !== ["state", "status", "workflowName"].join("\0")) {
        refuse("FINAL_WORKFLOW_GATE_COVERAGE_GAP", "a filtered nonterminal Workflow query is missing or duplicated");
      }
      used.add(matches[0]);
    }
    const history = value.queries.filter((query) =>
      isRecord(query) && query.workflowName === workflowName && query.status === "all"
    ).sort((left, right) => left.page - right.page);
    if (history.length === 0) refuse("FINAL_WORKFLOW_GATE_COVERAGE_GAP", "Workflow terminal history was not enumerated");
    for (let index = 0; index < history.length; index += 1) {
      const query = history[index];
      if (
        Object.keys(query).sort().join("\0") !== ["page", "rowCount", "state", "status", "workflowName"].join("\0") ||
        query.page !== index + 1 ||
        query.state !== "terminal-history-only" ||
        !Number.isSafeInteger(query.rowCount) ||
        query.rowCount < 0 ||
        query.rowCount > 100 ||
        (index < history.length - 1 && query.rowCount !== 100) ||
        (index === history.length - 1 && query.rowCount >= 100)
      ) refuse("FINAL_WORKFLOW_GATE_COVERAGE_GAP", "Workflow history pages are not complete and contiguous");
      used.add(query);
    }
  }
  if (used.size !== value.queries.length) {
    refuse("FINAL_WORKFLOW_GATE_COVERAGE_GAP", "final Workflow gate returned unknown or duplicate query evidence");
  }
  return Object.freeze(structuredClone(value));
}

export function assertClosedCurrentRuntimeAudit(value, state, controlPlane) {
  exactObject(value, [
    "accountId",
    "deploymentId",
    "identitySha256",
    "remoteAttestationSha256",
    "schemaVersion",
    "unusedSafetySha256",
    "versionId",
    "workerName",
  ].sort(), "CURRENT_RUNTIME_AUDIT_SCHEMA_DRIFT");
  if (
    value.schemaVersion !== "survey-qa-canary-current-runtime-attestation/1.0.0" ||
    value.accountId !== state.identity.accountId ||
    value.workerName !== state.identity.workerName ||
    value.identitySha256 !== state.identity.identitySha256 ||
    value.versionId !== state.eligibility.versionId ||
    value.deploymentId !== state.eligibility.deploymentId ||
    controlPlane.identitySha256 !== value.identitySha256 ||
    controlPlane.versionId !== value.versionId ||
    controlPlane.deploymentId !== value.deploymentId ||
    !SHA256_HEX.test(value.remoteAttestationSha256 ?? "") ||
    !SHA256_HEX.test(value.unusedSafetySha256 ?? "")
  ) refuse("CURRENT_RUNTIME_AUDIT_INVALID", "current runtime attestation is incomplete or not eligibility-bound");
  return Object.freeze(structuredClone(value));
}

export function parseHardenedOneCallArguments(argv) {
  const values = new Map();
  let confirmed = false;
  const valueFlags = new Set([
    "--run-directory",
    "--questionnaire",
    "--signing-bundle",
    "--survey-url",
    "--poll-interval-ms",
    "--poll-timeout-ms",
    "--request-timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-live-one-call") {
      if (confirmed) refuse("ARGUMENT_DUPLICATE", "confirmation flag may be supplied only once");
      confirmed = true;
      continue;
    }
    if (!valueFlags.has(flag)) refuse("ARGUMENT_UNKNOWN", `unknown argument at position ${index + 1}`);
    if (values.has(flag)) refuse("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) refuse("ARGUMENT_MISSING", `${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  if (!confirmed) refuse("LIVE_CONFIRMATION_REQUIRED", "--confirm-live-one-call is required");
  for (const flag of ["--run-directory", "--questionnaire", "--signing-bundle", "--survey-url"]) {
    if (!values.has(flag)) refuse("ARGUMENT_MISSING", `${flag} is required`);
  }
  const result = {
    runDirectory: values.get("--run-directory"),
    questionnairePath: values.get("--questionnaire"),
    signingBundlePath: values.get("--signing-bundle"),
    surveyUrl: values.get("--survey-url"),
  };
  for (const [flag, name] of [
    ["--poll-interval-ms", "pollIntervalMs"],
    ["--poll-timeout-ms", "pollTimeoutMs"],
    ["--request-timeout-ms", "requestTimeoutMs"],
  ]) {
    if (values.has(flag)) result[name] = decimalInteger(values.get(flag), flag);
  }
  return Object.freeze(result);
}

export async function runCli(argv, dependencies = {}) {
  try {
    const result = await runEligibleOneCall(parseHardenedOneCallArguments(argv), dependencies);
    return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
  } catch (error) {
    const failure = normalizedFailure(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `hardened one-call runner refused [${failure.code}]: ${failure.message}\n`,
    };
  }
}

function assertSubmissionContext(context, state, surveyUrl) {
  if (
    !isRecord(context) ||
    context.authenticationKind !== "canary-token" ||
    context.authenticationCredentialSha256 !== state.eligibility.tokenSha256 ||
    context.baseUrl !== LIVE_CANARY_ORIGIN ||
    context.documentSha256 !== state.questionnaire.sha256 ||
    context.documentBytes !== state.questionnaire.bytes ||
    context.surveyUrl !== surveyUrl ||
    canonicalize(context.submissionRuntimeIdentity) !== canonicalize({
      identitySha256: state.identity.identitySha256,
      versionId: state.eligibility.versionId,
      provider: state.identity.provider,
      policySha256: state.identity.providerPolicySha256,
      providerConfigurationSha256: state.identity.providerConfigurationSha256,
      maximumUsd: state.identity.visualMaximumUsd,
    }) ||
    !SHA256_HEX.test(context.submissionBodySha256 ?? "")
  ) refuse("SUBMISSION_CONTEXT_MISMATCH", "the pending POST is not bound to the eligible token/document/origin/survey");
}

function verifyBoundAuditFiles(runDirectory, repositoryRoot, eligibility, identity, assertPrivatePathImpl) {
  for (const [name, expected] of [
    ["wrangler-control-plane.log", eligibility.controlPlaneLogSha256],
    ["wrangler-workflow-gate-before-upload.log", eligibility.workflowGateBeforeUploadLogSha256],
    ["wrangler-workflow-gate-after-deploy.log", eligibility.workflowGateAfterDeployLogSha256],
  ]) assertFileSha256(path.join(runDirectory, name), expected, repositoryRoot, "ELIGIBILITY_AUDIT_LOG_MISMATCH", assertPrivatePathImpl);
  const audit = readCanonicalJson(
    path.join(runDirectory, POST_DEPLOY_AUDIT_FILE),
    repositoryRoot,
    "POST_DEPLOY_AUDIT",
    assertPrivatePathImpl,
  );
  if (audit.sha256 !== eligibility.postDeployAuditSha256) {
    refuse("POST_DEPLOY_AUDIT_MISMATCH", "post-deploy audit bytes differ from eligibility");
  }
  exactObject(audit.value, [
    "accountId", "anonymousDenialSha256", "anonymousSubmissionDenialSha256",
    "deploymentCreatedOn", "deploymentId", "identitySha256", "malformedDenialSha256",
    "mismatchedDenialSha256", "mismatchedProbeDocumentSha256", "remoteAttestationSha256",
    "schemaVersion", "unusedSafetySha256", "versionCreatedOn", "versionId", "versionTag",
    "workerName",
  ].sort(), "POST_DEPLOY_AUDIT_SCHEMA_DRIFT");
  if (
    audit.value.schemaVersion !== "survey-qa-canary-post-deploy-audit/1.0.0" ||
    audit.value.accountId !== identity.accountId ||
    audit.value.workerName !== identity.workerName ||
    audit.value.identitySha256 !== identity.identitySha256 ||
    audit.value.versionId !== eligibility.versionId ||
    audit.value.deploymentId !== eligibility.deploymentId ||
    audit.value.versionTag !== eligibility.versionTag
  ) refuse("POST_DEPLOY_AUDIT_IDENTITY_MISMATCH", "post-deploy audit is not bound to eligibility");
  validateEligibilityAuditDigests(audit.value);
}

function assertEligibilityIdentity(eligibility, identity) {
  const expected = {
    accountId: identity.accountId,
    workerName: identity.workerName,
    provider: identity.provider,
    model: identity.model,
    identitySha256: identity.identitySha256,
    questionnaireSha256: identity.questionnaireSha256,
    sourceManifestSha256: identity.sourceManifestSha256,
    reviewedBundleManifestSha256: identity.reviewedBundleManifestSha256,
    bundleInputsManifestSha256: identity.bundleInputsManifestSha256,
    bundleMetafileSha256: identity.bundleMetafileSha256,
    versionTag: identity.versionTag,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (eligibility[key] !== value) refuse("ELIGIBILITY_IDENTITY_MISMATCH", "eligibility differs from independently derived deployment identity");
  }
}

function localStateFingerprint(state) {
  if (!isRecord(state) || !isRecord(state.eligibility) || !isRecord(state.identity)) {
    refuse("LOCAL_STATE_INVALID", "local eligibility inspection returned no closed state");
  }
  return canonicalize({
    eligibilitySha256: state.eligibilitySha256,
    identitySha256: state.identity.identitySha256,
    environment: state.environment,
    expectedDynamicVars: state.expectedDynamicVars,
    questionnaire: state.questionnaire,
    paths: state.paths,
    signingBundlePublicIdentity: state.signingBundlePublicIdentity,
    wrangler: wranglerIdentity(state.pinnedWrangler),
  });
}

function validateEligibilityAuditDigests(value) {
  for (const key of [
    "anonymousDenialSha256", "anonymousSubmissionDenialSha256", "malformedDenialSha256",
    "mismatchedDenialSha256", "mismatchedProbeDocumentSha256", "remoteAttestationSha256",
    "unusedSafetySha256",
  ]) requireSha256(value[key], "POST_DEPLOY_AUDIT_DIGEST_INVALID");
}

function parseJsonc(candidate, repositoryRoot) {
  const bytes = readBoundedFile(candidate, repositoryRoot, "SOURCE_CONFIG_INVALID");
  const parsed = ts.parseConfigFileTextToJson(candidate, bytes.toString("utf8"));
  if (parsed.error || !isRecord(parsed.config)) refuse("SOURCE_CONFIG_INVALID", "snapshot Wrangler config is invalid JSONC");
  return parsed.config;
}

function readCanonicalJson(candidate, repositoryRoot, label, assertPrivatePathImpl) {
  const bytes = readBoundedFile(candidate, repositoryRoot, `${label}_INVALID`);
  assertPrivatePathImpl(path.resolve(candidate), repositoryRoot);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { refuse(`${label}_INVALID`, `${label.toLowerCase()} is not JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalize(value)}\n`, "utf8"))) {
    refuse(`${label}_NONCANONICAL`, `${label.toLowerCase()} is not canonical JSON`);
  }
  return Object.freeze({ value, bytes: bytes.length, sha256: sha256(bytes) });
}

function writeCanonicalExclusive({ value, outputFile, repositoryRoot, assertPrivatePathImpl }) {
  const bytes = Buffer.from(`${canonicalize(value)}\n`, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) refuse("PRIVATE_OUTPUT_INVALID", "runner output is empty or too large");
  const output = path.resolve(outputFile);
  requireWithin(output, repositoryRoot, "PRIVATE_OUTPUT_OUTSIDE_REPOSITORY");
  assertPrivatePathImpl(path.dirname(output), repositoryRoot, { directory: true });
  let descriptor;
  try {
    descriptor = openSync(output, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === "EEXIST") refuse("ONE_CALL_ALREADY_CLAIMED", "this eligibility marker was already claimed or audited");
    refuse("PRIVATE_OUTPUT_WRITE_FAILED", "runner audit output could not be created exclusively");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertPrivatePathImpl(output, repositoryRoot);
  return Object.freeze({ path: output, bytes: bytes.length, sha256: sha256(bytes) });
}

function fileIdentity(candidate, trustedRoot, code) {
  const bytes = readBoundedFile(candidate, trustedRoot, code);
  return Object.freeze({ path: path.resolve(candidate), bytes: bytes.length, sha256: sha256(bytes) });
}

function assertFileSha256(candidate, expected, trustedRoot, code, assertPrivatePathImpl = assertPrivateLocalPath) {
  requireSha256(expected, code);
  const actual = fileIdentity(candidate, trustedRoot, code);
  assertPrivatePathImpl(actual.path, trustedRoot);
  if (actual.sha256 !== expected) refuse(code, "an eligibility-bound file changed");
  return actual;
}

function readBoundedFile(candidate, trustedRoot, code) {
  const file = exactRegularFile(candidate, code);
  requireWithin(file, trustedRoot, code);
  const bytes = readFileSync(file);
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) refuse(code, "required file is empty or too large");
  return bytes;
}

function exactRegularFile(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) refuse(code, "required file path is missing");
  const resolved = path.resolve(candidate);
  let stat;
  try { stat = lstatSync(resolved); } catch { refuse(code, "required file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync.native(resolved) !== resolved) {
    refuse(code, "required path is not one exact regular file");
  }
  return resolved;
}

function exactDirectory(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) refuse(code, "required directory is missing");
  const resolved = path.resolve(candidate);
  let stat;
  try { stat = lstatSync(resolved); } catch { refuse(code, "required directory is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(resolved) !== resolved) {
    refuse(code, "required path is not one exact directory");
  }
  return resolved;
}

function exactRunDirectory(candidate, runRoot) {
  const run = exactDirectory(candidate, "RUN_DIRECTORY_INVALID");
  if (path.dirname(run) !== path.resolve(runRoot) || !SAFE_RUN_NAME.test(path.basename(run))) {
    refuse("RUN_DIRECTORY_INVALID", "run directory must be one safe direct child of the private run root");
  }
  return run;
}

function requireWithin(candidate, root, code) {
  const resolved = path.resolve(candidate);
  const trusted = path.resolve(root);
  const relative = path.relative(trusted, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    if (relative !== "") refuse(code, "path escapes its trusted root");
  }
}

function requireAbsent(candidate, code) {
  try { lstatSync(candidate); refuse(code, "one-call output path already exists"); } catch (error) {
    if (error instanceof HardenedOneCallError) throw error;
    if (error?.code !== "ENOENT") refuse(code, "one-call output path cannot be inspected");
  }
}

function normalizedSurveyUrl(value) {
  let url;
  try { url = new URL(value); } catch { refuse("SURVEY_URL_INVALID", "survey URL must be absolute HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    refuse("SURVEY_URL_INVALID", "survey URL must be credential-free HTTPS without a fragment");
  }
  return url.href;
}

function wranglerIdentity(value) {
  try {
    assertPinnedWranglerDescriptor(value);
  } catch {
    refuse("WRANGLER_IDENTITY_INVALID", "pinned Wrangler identity is unavailable");
  }
  return Object.freeze({ ...structuredClone(value.evidence), version: value.version });
}

function exactObject(value, keys, code) {
  if (!isRecord(value) || canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) {
    refuse(code, "object schema has missing or unknown fields");
  }
}

function requireSha256(value, code) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) refuse(code, "expected one lowercase SHA-256 digest");
  return value;
}

function decimalInteger(value, flag) {
  if (!/^[1-9][0-9]*$/u.test(value)) refuse("ARGUMENT_INVALID", `${flag} must be a positive decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) refuse("ARGUMENT_INVALID", `${flag} exceeds the safe integer range`);
  return parsed;
}

function normalizedFailure(error, secret = "") {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,100}$/u.test(error.code)
    ? error.code
    : error instanceof LiveCanaryError ? error.code : "ONE_CALL_RUNNER_FAILED";
  // Only messages authored by this runner or the already-redacting live client are safe to
  // retain. Wrangler/fetch/injected dependency diagnostics are untrusted and may echo a secret.
  let message = error instanceof HardenedOneCallError || error instanceof LiveCanaryError
    ? error.message
    : "one-call gate or execution failed";
  if (secret) message = message.split(secret).join("[REDACTED]");
  message = message.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 500) || "one-call runner failed";
  return Object.freeze({ code, message });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function refuse(code, message) {
  throw new HardenedOneCallError(code, message);
}

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
