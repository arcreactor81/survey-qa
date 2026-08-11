import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTIVE_WORKFLOW_STATUSES,
  EXPECTED_CANARY_WORKFLOWS,
  FILTERABLE_NONTERMINAL_STATUSES,
} from "../assert-no-active-canary-workflows.mjs";
import {
  REQUIRED_CANARY_REMOTE_BINDINGS,
  deriveCanaryDeploymentIdentity,
  inspectCurrentCanaryControlPlane,
} from "../canary-post-deploy-attestation.mjs";
import {
  CANARY_PROVIDER_MODELS,
  HARDENED_CANARY_ELIGIBILITY_SCHEMA,
} from "../hardened-canary-deploy.mjs";
import { canaryVisualPolicy } from "../generate-live-canary-config.mjs";
import {
  captureOneCallRunnerEnvironment,
  runEligibleOneCall,
  validateEligibilityRecord,
} from "../hardened-one-call-runner.mjs";
import {
  LIVE_CANARY_IDENTITY_HEADER,
  LIVE_CANARY_MAXIMUM_USD_HEADER,
  LIVE_CANARY_ORIGIN,
  LIVE_CANARY_POLICY_HEADER,
  LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER,
  LIVE_CANARY_PROVIDER_HEADER,
  LIVE_CANARY_VERSION_ID_HEADER,
} from "../live-canary-contract.mjs";
import {
  EXPECTED_NODE_EXECUTABLE_SHA256,
  EXPECTED_NODE_VERSION,
  EXPECTED_PACKAGE_LOCK_SHA256,
  EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
  EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
  EXPECTED_TYPESCRIPT_VERSION,
  EXPECTED_WRANGLER_ARCH,
  EXPECTED_WRANGLER_BIN_SHA256,
  EXPECTED_WRANGLER_CLI_SHA256,
  EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
  EXPECTED_WRANGLER_PLATFORM,
  EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
  EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
  EXPECTED_WRANGLER_VERSION,
} from "../pinned-wrangler-command.mjs";

const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const SURVEY_URL = "https://survey-qa-testbench.arcreactor81.workers.dev/oncology/en";
const TOKEN = "fixture-canary-token-material-1234567890";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wrangler() {
  return {
    arch: EXPECTED_WRANGLER_ARCH,
    binSha256: EXPECTED_WRANGLER_BIN_SHA256,
    cliSha256: EXPECTED_WRANGLER_CLI_SHA256,
    entryCount: 1780,
    nodeExecutableSha256: EXPECTED_NODE_EXECUTABLE_SHA256,
    nodeVersion: EXPECTED_NODE_VERSION,
    packageCount: EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
    packageJsonSha256: EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
    packageLockSha256: EXPECTED_PACKAGE_LOCK_SHA256,
    platform: EXPECTED_WRANGLER_PLATFORM,
    toolchainInventorySha256: EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
    typescriptEntrypointSha256: EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
    typescriptPackageJsonSha256: EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
    typescriptVersion: EXPECTED_TYPESCRIPT_VERSION,
    version: EXPECTED_WRANGLER_VERSION,
  };
}

function identity() {
  return deriveCanaryDeploymentIdentity({
    accountId: "f0cbb2076e484454e6567789b9be85d8",
    bundleInputsManifestSha256: "1".repeat(64),
    bundleMetafileSha256: "2".repeat(64),
    judgementPublicKeyId: "canary-judgement-test",
    judgementPublicKeySha256: "3".repeat(64),
    model: CANARY_PROVIDER_MODELS["workers-ai-gemma4"],
    provider: "workers-ai-gemma4",
    providerConfigurationSha256: "4".repeat(64),
    providerPolicySha256: "5".repeat(64),
    questionnaireSha256: "6".repeat(64),
    recordPublicKeyId: "canary-record-test",
    recordPublicKeySha256: "7".repeat(64),
    requiredBindings: [...REQUIRED_CANARY_REMOTE_BINDINGS],
    reviewedBundleManifestSha256: "8".repeat(64),
    sourceManifestSha256: "9".repeat(64),
    visualMaximumCalls: 1,
    visualMaximumUsd: "0.0263",
    workerName: "survey-qa-v2-visual-canary",
    wrangler: wrangler(),
  });
}

const LIMITATIONS = [{
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
}];

function eligibility(overrides = {}) {
  const id = identity();
  return {
    schemaVersion: HARDENED_CANARY_ELIGIBILITY_SCHEMA,
    state: "eligible-for-separate-valid-one-call-runner",
    accountId: id.accountId,
    workerName: id.workerName,
    provider: id.provider,
    model: id.model,
    identitySha256: id.identitySha256,
    questionnaireSha256: id.questionnaireSha256,
    sourceManifestSha256: id.sourceManifestSha256,
    reviewedBundleManifestSha256: id.reviewedBundleManifestSha256,
    bundleInputsManifestSha256: id.bundleInputsManifestSha256,
    bundleMetafileSha256: id.bundleMetafileSha256,
    deploymentInputsManifestSha256: "a".repeat(64),
    assetsManifestSha256: "b".repeat(64),
    controlManifestSha256: "c".repeat(64),
    snapshotBuildConfigSha256: "d".repeat(64),
    deployConfigSha256: "e".repeat(64),
    tokenSha256: sha256(TOKEN),
    tokenFileSha256: "0".repeat(64),
    secretFileSha256: "1".repeat(64),
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    versionTag: id.versionTag,
    workflowGateQueryCount: 44,
    workflowGateBeforeUploadQueryCount: 22,
    workflowGateAfterDeployQueryCount: 22,
    workflowGateBeforeUploadLogSha256: "2".repeat(64),
    workflowGateAfterDeployLogSha256: "3".repeat(64),
    controlPlaneLogSha256: "4".repeat(64),
    remoteSecretCount: 4,
    remoteSecretNamesSha256: "5".repeat(64),
    postDeployAuditSha256: "6".repeat(64),
    limitations: structuredClone(LIMITATIONS),
    ...overrides,
  };
}

function stateFixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "hardened-one-call-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const eligible = validateEligibilityRecord(eligibility(overrides.eligibility));
  const id = identity();
  const packageRoot = path.join(root, "node_modules", "wrangler");
  const cliPath = path.join(packageRoot, "wrangler-dist", "cli.js");
  const typescriptPackageRoot = path.join(root, "node_modules", "typescript");
  const pinned = Object.freeze({
    command: process.execPath,
    argsPrefix: Object.freeze([cliPath]),
    packageRoot,
    packageJsonPath: path.join(packageRoot, "package.json"),
    packageLockPath: path.join(root, "package-lock.json"),
    binPath: path.join(packageRoot, "bin", "wrangler.js"),
    cliPath,
    typescriptPackageRoot,
    typescriptPackageJsonPath: path.join(typescriptPackageRoot, "package.json"),
    typescriptEntrypointPath: path.join(typescriptPackageRoot, "lib", "typescript.js"),
    evidence: Object.freeze(Object.fromEntries(Object.entries(wrangler()).filter(([key]) => key !== "version"))),
    version: EXPECTED_WRANGLER_VERSION,
  });
  return Object.freeze({
    repositoryRoot: root,
    runDirectory: root,
    eligibility: eligible,
    eligibilitySha256: sha256(JSON.stringify(eligible)),
    identity: id,
    expectedDynamicVars: { fixture: "closed" },
    environment: captureOneCallRunnerEnvironment(process.env, root),
    pinnedWrangler: pinned,
    questionnaire: { path: path.join(root, "questionnaire.docx"), bytes: 1234, sha256: id.questionnaireSha256 },
    signingBundlePublicIdentity: {
      judgementKeyId: id.judgementPublicKeyId,
      judgementPublicKeySha256: id.judgementPublicKeySha256,
      recordKeyId: id.recordPublicKeyId,
      recordPublicKeySha256: id.recordPublicKeySha256,
    },
    paths: {
      config: path.join(root, "wrangler.reviewed-deploy.json"),
      questionnaire: path.join(root, "questionnaire.docx"),
      reviewedBundle: path.join(root, "reviewed-bundle"),
      snapshot: path.join(root, "source-snapshot"),
      token: path.join(root, "canary-token.txt"),
    },
    assertPrivatePathImpl() {},
  });
}

function closedGateResult(state) {
  const policy = canaryVisualPolicy(state.eligibility.provider, 1);
  const queries = [];
  for (const workflowName of EXPECTED_CANARY_WORKFLOWS) {
    for (const status of FILTERABLE_NONTERMINAL_STATUSES) {
      queries.push({ workflowName, status, state: "no-instances" });
    }
    queries.push({ workflowName, status: "all", page: 1, rowCount: 0, state: "terminal-history-only" });
  }
  return {
    accountId: state.identity.accountId,
    configSha256: state.eligibility.deployConfigSha256,
    expectedDocumentSha256: state.questionnaire.sha256,
    logAudit: { bytes: 100, sha256: "7".repeat(64) },
    queries,
    queryCount: queries.length,
    statuses: [...ACTIVE_WORKFLOW_STATUSES],
    visualPolicy: {
      provider: policy.provider,
      profile: policy.profile,
      maximumCalls: policy.maximumCalls,
      maximumUsd: policy.maximumUsd,
      sha256: policy.sha256,
    },
    workerName: state.identity.workerName,
    workflowNames: [...EXPECTED_CANARY_WORKFLOWS],
    wranglerPin: {
      ...state.pinnedWrangler.evidence,
      version: state.pinnedWrangler.version,
    },
    wranglerVersion: EXPECTED_WRANGLER_VERSION,
  };
}

function currentRuntimeAudit(state) {
  return {
    schemaVersion: "survey-qa-canary-current-runtime-attestation/1.0.0",
    accountId: state.identity.accountId,
    workerName: state.identity.workerName,
    identitySha256: state.identity.identitySha256,
    versionId: state.eligibility.versionId,
    deploymentId: state.eligibility.deploymentId,
    remoteAttestationSha256: "a".repeat(64),
    unusedSafetySha256: "b".repeat(64),
  };
}

function submissionRuntimeIdentity(state) {
  return {
    identitySha256: state.identity.identitySha256,
    versionId: state.eligibility.versionId,
    provider: state.identity.provider,
    policySha256: state.identity.providerPolicySha256,
    providerConfigurationSha256: state.identity.providerConfigurationSha256,
    maximumUsd: state.identity.visualMaximumUsd,
  };
}

function paidSubmissionHeaders(state, overrides = {}) {
  return {
    accept: "application/json",
    "content-type": "application/json; charset=utf-8",
    [LIVE_CANARY_IDENTITY_HEADER]: state.identity.identitySha256,
    [LIVE_CANARY_VERSION_ID_HEADER]: state.eligibility.versionId,
    [LIVE_CANARY_PROVIDER_HEADER]: state.identity.provider,
    [LIVE_CANARY_POLICY_HEADER]: state.identity.providerPolicySha256,
    [LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER]: state.identity.providerConfigurationSha256,
    [LIVE_CANARY_MAXIMUM_USD_HEADER]: state.identity.visualMaximumUsd,
    "x-survey-qa-canary-token": TOKEN,
    ...overrides,
  };
}

function successfulDependencies(state, overrides = {}) {
  let paidPosts = 0;
  const dependencies = {
    inspectLocalInputsImpl: async () => state,
    reinspectLocalInputsImpl: async () => state,
    hardenDirectoryImpl() {},
    runCurrentControlPlaneImpl: async () => ({
      identitySha256: state.identity.identitySha256,
      versionId: VERSION_ID,
      deploymentId: DEPLOYMENT_ID,
    }),
    runRemoteGateImpl: async () => currentRuntimeAudit(state),
    runWorkflowGateImpl: () => closedGateResult(state),
    fetchImpl: async (_input, init) => {
      if (String(init?.method).toUpperCase() === "POST") paidPosts += 1;
      return new Response(JSON.stringify({ runId: "v2r_00000000000000000000000000" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
    executeImpl: async (options, injected) => {
      const body = JSON.stringify({ fixture: true });
      await injected.beforeSubmission({
        authenticationKind: "canary-token",
        authenticationCredentialSha256: state.eligibility.tokenSha256,
        baseUrl: LIVE_CANARY_ORIGIN,
        documentBytes: state.questionnaire.bytes,
        documentSha256: state.questionnaire.sha256,
        submissionRuntimeIdentity: submissionRuntimeIdentity(state),
        submissionBodySha256: sha256(body),
        surveyUrl: new URL(options.surveyUrl).href,
      });
      await injected.fetchImpl(new URL("/api/v2/runs", LIVE_CANARY_ORIGIN), {
        method: "POST",
        body,
        headers: paidSubmissionHeaders(state),
        redirect: "manual",
      });
      return { runId: "v2r_00000000000000000000000000", outcome: "passed" };
    },
    ...overrides,
  };
  return { dependencies, paidPosts: () => paidPosts };
}

test("one eligibility claim reaches exactly one valid POST after the final Workflow gate", async (t) => {
  const state = stateFixture(t);
  const order = [];
  const { dependencies, paidPosts } = successfulDependencies(state, {
    runCurrentControlPlaneImpl: async () => { order.push("current-deployment"); return {
      identitySha256: state.identity.identitySha256,
      versionId: state.eligibility.versionId,
      deploymentId: state.eligibility.deploymentId,
    }; },
    runRemoteGateImpl: async () => { order.push("runtime-attestation"); return currentRuntimeAudit(state); },
    runWorkflowGateImpl: () => { order.push("workflow-gate"); return closedGateResult(state); },
    fetchImpl: async (_input, init) => { order.push("valid-post"); return new Response("{}", { status: 202 }); },
  });
  const result = await runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies);
  assert.equal(result.paidSubmissionAttempts, 1);
  assert.deepEqual(order, ["current-deployment", "runtime-attestation", "workflow-gate", "valid-post"]);
  assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-claim.json")), true);
  assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-audit.json")), true);
  assert.equal(paidPosts(), 0, "the overridden fetch records order instead of the default counter");
});

for (const [label, code] of [
  ["active Workflow", "ACTIVE_WORKFLOW_FOUND"],
  ["Workflow gate failure", "WRANGLER_QUERY_FAILED"],
]) {
  test(`${label} permanently consumes the claim and prevents the valid POST`, async (t) => {
    const state = stateFixture(t);
    const { dependencies, paidPosts } = successfulDependencies(state, {
      runWorkflowGateImpl() { const error = new Error(label); error.code = code; throw error; },
    });
    await assert.rejects(
      runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
      (error) => error.code === code,
    );
    assert.equal(paidPosts(), 0);
    assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-claim.json")), true);
    assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-audit.json")), true);
  });
}

test("stale or wrong current version/deployment identity prevents spend", async (t) => {
  const state = stateFixture(t);
  const { dependencies, paidPosts } = successfulDependencies(state, {
    runCurrentControlPlaneImpl() {
      return inspectCurrentCanaryControlPlane({
        versionsResult: { status: 0, stderr: "", stdout: JSON.stringify([{
          id: VERSION_ID,
          metadata: { created_on: "2026-08-11T04:05:06.000Z", source: "wrangler" },
          annotations: {
            "workers/tag": state.identity.versionTag,
            "workers/message": state.identity.versionMessage,
          },
        }]) },
        deploymentsResult: { status: 0, stderr: "", stdout: JSON.stringify([{
          id: "55555555-5555-4555-8555-555555555555",
          created_on: "2026-08-11T05:00:00.000Z",
          source: "wrangler",
          strategy: "percentage",
          versions: [{ version_id: VERSION_ID, percentage: 100 }],
        }]) },
        expectedIdentity: state.identity,
        expectedVersionId: VERSION_ID,
        expectedDeploymentId: DEPLOYMENT_ID,
      });
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "CURRENT_DEPLOYMENT_MISSING",
  );
  assert.equal(paidPosts(), 0);
});

test("wrong document or token at the core pre-POST seam prevents spend before claim", async (t) => {
  for (const axis of ["document", "token"]) {
    const state = stateFixture(t);
    const { dependencies, paidPosts } = successfulDependencies(state, {
      executeImpl: async (options, injected) => {
        await injected.beforeSubmission({
          authenticationKind: "canary-token",
          authenticationCredentialSha256: axis === "token" ? "0".repeat(64) : state.eligibility.tokenSha256,
          baseUrl: LIVE_CANARY_ORIGIN,
          documentBytes: state.questionnaire.bytes,
          documentSha256: axis === "document" ? "0".repeat(64) : state.questionnaire.sha256,
          submissionRuntimeIdentity: submissionRuntimeIdentity(state),
          submissionBodySha256: "8".repeat(64),
          surveyUrl: new URL(options.surveyUrl).href,
        });
      },
    });
    await assert.rejects(
      runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
      (error) => error.code === "SUBMISSION_CONTEXT_MISMATCH",
      axis,
    );
    assert.equal(paidPosts(), 0, axis);
    assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-claim.json")), false, axis);
  }
});

test("mutated eligibility/provider and local config/token/control drift all prevent spend", async (t) => {
  const mutations = [
    ["unknown eligibility field", () => ({ ...eligibility(), unbound: true }), "ELIGIBILITY_SCHEMA_DRIFT"],
    ["wrong provider", () => ({ ...eligibility(), provider: "cloudflare-gateway-gemini" }), "ELIGIBILITY_INVALID"],
  ];
  for (const [label, mutate, code] of mutations) {
    let paid = 0;
    await assert.rejects(
      runEligibleOneCall({ runDirectory: "unused", surveyUrl: SURVEY_URL }, {
        inspectLocalInputsImpl: async () => { validateEligibilityRecord(mutate()); },
        fetchImpl: async () => { paid += 1; },
      }),
      (error) => error.code === code,
      label,
    );
    assert.equal(paid, 0, label);
  }

  for (const [label, code] of [
    ["config", "DEPLOY_CONFIG_MISMATCH"],
    ["token file", "TOKEN_FILE_MISMATCH"],
    ["runner/core control bytes", "CONTROL_FILE_DRIFT"],
  ]) {
    let paid = 0;
    await assert.rejects(
      runEligibleOneCall({ runDirectory: "unused", surveyUrl: SURVEY_URL }, {
        inspectLocalInputsImpl: async () => { const error = new Error(`${label} mutated`); error.code = code; throw error; },
        fetchImpl: async () => { paid += 1; },
      }),
      (error) => error.code === code,
      label,
    );
    assert.equal(paid, 0, label);
  }
});

test("control/core drift after initial inspection is caught inside the pre-POST hook", async (t) => {
  const state = stateFixture(t);
  let inspections = 0;
  const { dependencies, paidPosts } = successfulDependencies(state, {
    reinspectLocalInputsImpl: async () => {
      inspections += 1;
      const error = new Error("live-canary-core.mjs changed after eligibility");
      error.code = "CONTROL_FILE_DRIFT";
      throw error;
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "CONTROL_FILE_DRIFT",
  );
  assert.equal(inspections, 1);
  assert.equal(paidPosts(), 0);
  assert.equal(existsSync(path.join(state.runDirectory, "one-call-runner-claim.json")), true);
});

test("an executor cannot POST directly without invoking the eligibility hook", async (t) => {
  const state = stateFixture(t);
  const { dependencies, paidPosts } = successfulDependencies(state, {
    executeImpl: async (_options, injected) => {
      await injected.fetchImpl(new URL("/api/v2/runs", LIVE_CANARY_ORIGIN), {
        method: "POST",
        body: "{}",
        headers: paidSubmissionHeaders(state),
        redirect: "manual",
      });
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "PAID_POST_GATE_INCOMPLETE",
  );
  assert.equal(paidPosts(), 0);
});

test("actual POST body, authentication, and runtime version must equal the hash-only claim", async (t) => {
  for (const axis of ["body", "auth", "version-id", "extra-header"]) {
    const state = stateFixture(t);
    const { dependencies, paidPosts } = successfulDependencies(state, {
      executeImpl: async (options, injected) => {
        const claimedBody = JSON.stringify({ claimed: true });
        await injected.beforeSubmission({
          authenticationKind: "canary-token",
          authenticationCredentialSha256: state.eligibility.tokenSha256,
          baseUrl: LIVE_CANARY_ORIGIN,
          documentBytes: state.questionnaire.bytes,
          documentSha256: state.questionnaire.sha256,
          submissionRuntimeIdentity: submissionRuntimeIdentity(state),
          submissionBodySha256: sha256(claimedBody),
          surveyUrl: new URL(options.surveyUrl).href,
        });
        await injected.fetchImpl(new URL("/api/v2/runs", LIVE_CANARY_ORIGIN), {
          method: "POST",
          body: axis === "body" ? JSON.stringify({ changed: true }) : claimedBody,
          headers: paidSubmissionHeaders(state, {
            ...(axis === "auth" ? { "x-survey-qa-canary-token": `${TOKEN}-changed` } : {}),
            ...(axis === "version-id" ? {
              [LIVE_CANARY_VERSION_ID_HEADER]: "33333333-3333-4333-8333-333333333333",
            } : {}),
            ...(axis === "extra-header" ? { authorization: "Bearer unreviewed" } : {}),
          }),
          redirect: "manual",
        });
      },
    });
    await assert.rejects(
      runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
      (error) => error.code === (axis === "body" ? "PAID_POST_BODY_MISMATCH" : "PAID_POST_AUTH_MISMATCH"),
      axis,
    );
    assert.equal(paidPosts(), 0, axis);
  }
});

test("a second valid POST is refused before a second underlying request", async (t) => {
  const state = stateFixture(t);
  const { dependencies, paidPosts } = successfulDependencies(state, {
    executeImpl: async (options, injected) => {
      const body = JSON.stringify({ fixture: true });
      await injected.beforeSubmission({
        authenticationKind: "canary-token",
        authenticationCredentialSha256: state.eligibility.tokenSha256,
        baseUrl: LIVE_CANARY_ORIGIN,
        documentBytes: state.questionnaire.bytes,
        documentSha256: state.questionnaire.sha256,
        submissionRuntimeIdentity: submissionRuntimeIdentity(state),
        submissionBodySha256: sha256(body),
        surveyUrl: new URL(options.surveyUrl).href,
      });
      const init = {
        method: "POST",
        body,
        headers: paidSubmissionHeaders(state),
        redirect: "manual",
      };
      await injected.fetchImpl(new URL("/api/v2/runs", LIVE_CANARY_ORIGIN), init);
      await injected.fetchImpl(new URL("/api/v2/runs", LIVE_CANARY_ORIGIN), init);
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "MULTIPLE_PAID_SUBMISSIONS_REFUSED",
  );
  assert.equal(paidPosts(), 1, "the second attempt never reached the underlying transport");
});

test("an existing claim prevents all remote gates and paid POSTs", async (t) => {
  const state = stateFixture(t);
  writeFileSync(path.join(state.runDirectory, "one-call-runner-claim.json"), "already claimed\n");
  let remoteGates = 0;
  const { dependencies, paidPosts } = successfulDependencies(state, {
    runCurrentControlPlaneImpl: async () => { remoteGates += 1; },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "ONE_CALL_ALREADY_CLAIMED",
  );
  assert.equal(remoteGates, 0);
  assert.equal(paidPosts(), 0);
});

test("ambient credentials, proxies, Node injection, and control vars cannot enter the runner", async (t) => {
  const state = stateFixture(t);
  const hostile = {
    ...process.env,
    GEMINI_API_KEY: "must-not-survive",
    HTTPS_PROXY: "https://redirect.invalid",
    NODE_OPTIONS: "--require=unreviewed",
    WRANGLER_CONFIG: "unreviewed.json",
    CF_API_TOKEN: "must-not-survive",
  };
  const captured = captureOneCallRunnerEnvironment(hostile, state.runDirectory);
  for (const name of ["GEMINI_API_KEY", "HTTPS_PROXY", "NODE_OPTIONS", "WRANGLER_CONFIG", "CF_API_TOKEN", "PATH"]) {
    assert.equal(name in captured, false, name);
  }
  const poisonedState = Object.freeze({ ...state, environment: Object.freeze({ ...captured, NODE_OPTIONS: "--require=unreviewed" }) });
  let paid = 0;
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL, environment: hostile }, {
      inspectLocalInputsImpl: async () => poisonedState,
      fetchImpl: async () => { paid += 1; },
    }),
    (error) => error.code === "RUNNER_ENVIRONMENT_DRIFT",
  );
  assert.equal(paid, 0);
});

test("config/control mutation between final Workflow queries prevents the POST", async (t) => {
  const state = stateFixture(t);
  let synchronousChecks = 0;
  let subprocesses = 0;
  const { dependencies, paidPosts } = successfulDependencies(state, {
    verifyPinnedWranglerCommandImpl: () => state.pinnedWrangler,
    reverifySynchronousImpl: () => {
      synchronousChecks += 1;
      if (synchronousChecks === 2) {
        const error = new Error("config changed between paginated queries");
        error.code = "DEPLOY_CONFIG_DRIFT";
        throw error;
      }
      return true;
    },
    spawnSyncImpl: () => { subprocesses += 1; return { status: 0, stdout: "", stderr: "" }; },
    runWorkflowGateImpl: (gate) => {
      gate.spawnSyncImpl(state.pinnedWrangler.command, [...state.pinnedWrangler.argsPrefix, "query-1"], {
        env: gate.environment,
      });
      gate.spawnSyncImpl(state.pinnedWrangler.command, [...state.pinnedWrangler.argsPrefix, "query-2"], {
        env: gate.environment,
      });
      return { queryCount: 2, logAudit: { sha256: "7".repeat(64) } };
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "DEPLOY_CONFIG_DRIFT",
  );
  assert.equal(synchronousChecks, 2);
  assert.equal(subprocesses, 1);
  assert.equal(paidPosts(), 0);
});

test("empty or incomplete final Workflow evidence cannot arm the paid POST", async (t) => {
  for (const result of [{}, { ...closedGateResult(stateFixture(t)), queries: [], queryCount: 0 }]) {
    const state = stateFixture(t);
    const { dependencies, paidPosts } = successfulDependencies(state, {
      runWorkflowGateImpl: () => result,
    });
    await assert.rejects(
      runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
      (error) => ["FINAL_WORKFLOW_GATE_SCHEMA_DRIFT", "FINAL_WORKFLOW_GATE_INVALID", "FINAL_WORKFLOW_GATE_COVERAGE_GAP"].includes(error.code),
    );
    assert.equal(paidPosts(), 0);
  }
});

test("empty or identity-mismatched current-runtime audit cannot reach the final gate or POST", async (t) => {
  for (const mutate of [
    () => ({}),
    (state) => ({ ...currentRuntimeAudit(state), identitySha256: "0".repeat(64) }),
  ]) {
    const state = stateFixture(t);
    let finalGates = 0;
    const { dependencies, paidPosts } = successfulDependencies(state, {
      runRemoteGateImpl: async () => mutate(state),
      runWorkflowGateImpl: () => { finalGates += 1; return closedGateResult(state); },
    });
    await assert.rejects(
      runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
      (error) => ["CURRENT_RUNTIME_AUDIT_SCHEMA_DRIFT", "CURRENT_RUNTIME_AUDIT_INVALID"].includes(error.code),
    );
    assert.equal(finalGates, 0);
    assert.equal(paidPosts(), 0);
  }
});

test("no GET or other request may intervene after the final gate is armed", async (t) => {
  const state = stateFixture(t);
  const { dependencies, paidPosts } = successfulDependencies(state, {
    executeImpl: async (options, injected) => {
      const body = JSON.stringify({ fixture: true });
      await injected.beforeSubmission({
        authenticationKind: "canary-token",
        authenticationCredentialSha256: state.eligibility.tokenSha256,
        baseUrl: LIVE_CANARY_ORIGIN,
        documentBytes: state.questionnaire.bytes,
        documentSha256: state.questionnaire.sha256,
        submissionRuntimeIdentity: submissionRuntimeIdentity(state),
        submissionBodySha256: sha256(body),
        surveyUrl: new URL(options.surveyUrl).href,
      });
      await injected.fetchImpl(new URL("/api/v2/health", LIVE_CANARY_ORIGIN), {
        method: "GET",
        redirect: "manual",
      });
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => error.code === "FINAL_GATE_INTERVENING_REQUEST",
  );
  assert.equal(paidPosts(), 0);
});

test("credential text is redacted from the sanitized failure audit surface", async (t) => {
  const state = stateFixture(t);
  const { dependencies, paidPosts } = successfulDependencies(state, {
    runWorkflowGateImpl() {
      const error = new Error(`gate failed with ${TOKEN}`);
      error.code = "WRANGLER_QUERY_FAILED";
      throw error;
    },
  });
  await assert.rejects(
    runEligibleOneCall({ runDirectory: state.runDirectory, surveyUrl: SURVEY_URL }, dependencies),
    (error) => !error.message.includes(TOKEN),
  );
  assert.equal(paidPosts(), 0);
});
