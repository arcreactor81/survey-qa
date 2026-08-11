import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANARY_ATTESTATION_PATH,
  CANARY_DEPLOYMENT_IDENTITY_SCHEMA,
  CANARY_POST_DEPLOY_AUDIT_SCHEMA,
  CANARY_REMOTE_ATTESTATION_SCHEMA,
  FORBIDDEN_DEPLOY_ENVIRONMENT_NAMES,
  INHERITED_DEPLOY_ENVIRONMENT_NAMES,
  LIVE_CANARY_AUTH_HEADER,
  REQUIRED_CANARY_REMOTE_BINDINGS,
  assertPinnedDeployEnvironment,
  buildPinnedDeployEnvironment,
  buildPostDeployReadPlan,
  canaryAttestationChallengeSha256,
  canaryDeploymentIdentityVars,
  deploymentIdentityFlags,
  deriveCanaryDeploymentIdentity,
  inspectControlPlaneTransition,
  inspectCurrentCanaryControlPlane,
  runCanaryPreSpendRemoteGate,
  runCurrentCanaryRuntimeAttestation,
  validateRemoteAttestation,
  writePrivatePostDeployAudit,
} from "../canary-post-deploy-attestation.mjs";
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

const OLD_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const OLD_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const NEW_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_CREATED_ON = "2026-08-11T04:05:06.000Z";
const DEPLOYMENT_CREATED_ON = "2026-08-11T04:05:07.000Z";
const DENIAL_BODY = "Not found\n";

function identityInput(overrides = {}) {
  return {
    accountId: "a".repeat(32),
    bundleInputsManifestSha256: "1".repeat(64),
    bundleMetafileSha256: "2".repeat(64),
    judgementPublicKeyId: "judgement-ed25519-test",
    judgementPublicKeySha256: "c".repeat(64),
    model: "model/test-vision-1",
    provider: "provider-test",
    providerConfigurationSha256: "4".repeat(64),
    providerPolicySha256: "5".repeat(64),
    questionnaireSha256: "6".repeat(64),
    recordPublicKeyId: "record-ed25519-test",
    recordPublicKeySha256: "d".repeat(64),
    requiredBindings: [...REQUIRED_CANARY_REMOTE_BINDINGS],
    reviewedBundleManifestSha256: "3".repeat(64),
    sourceManifestSha256: "7".repeat(64),
    visualMaximumCalls: 1,
    visualMaximumUsd: "0.25",
    workerName: "survey-qa-v2-visual-canary",
    wrangler: {
      arch: "x64",
      binSha256: "8".repeat(64),
      cliSha256: "a".repeat(64),
      entryCount: 420,
      nodeExecutableSha256: "b".repeat(64),
      nodeVersion: "v24.18.0",
      packageCount: 35,
      packageJsonSha256: "9".repeat(64),
      packageLockSha256: "e".repeat(64),
      platform: "win32",
      toolchainInventorySha256: "f".repeat(64),
      typescriptEntrypointSha256: "1".repeat(64),
      typescriptPackageJsonSha256: "2".repeat(64),
      typescriptVersion: EXPECTED_TYPESCRIPT_VERSION,
      version: "4.106.0",
    },
    ...overrides,
  };
}

function expectedIdentity(overrides = {}) {
  return deriveCanaryDeploymentIdentity(identityInput(overrides));
}

function pinnedWranglerDescriptor(root = path.resolve("E:\\survey-qa")) {
  const packageRoot = path.join(root, "node_modules", "wrangler");
  const cliPath = path.join(packageRoot, "wrangler-dist", "cli.js");
  const typescriptPackageRoot = path.join(root, "node_modules", "typescript");
  return Object.freeze({
    command: process.execPath,
    argsPrefix: Object.freeze([cliPath]),
    version: EXPECTED_WRANGLER_VERSION,
    packageRoot,
    packageJsonPath: path.join(packageRoot, "package.json"),
    packageLockPath: path.join(root, "package-lock.json"),
    binPath: path.join(packageRoot, "bin", "wrangler.js"),
    cliPath,
    typescriptPackageRoot,
    typescriptPackageJsonPath: path.join(typescriptPackageRoot, "package.json"),
    typescriptEntrypointPath: path.join(typescriptPackageRoot, "lib", "typescript.js"),
    evidence: Object.freeze({
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
    }),
  });
}

function versionRecord({
  id = NEW_VERSION_ID,
  createdOn = VERSION_CREATED_ON,
  source = "wrangler",
  tag = null,
  message = null,
} = {}) {
  return {
    id,
    metadata: { created_on: createdOn, source, author_email: "operator@example.invalid" },
    annotations: {
      ...(tag === null ? {} : { "workers/tag": tag }),
      ...(message === null ? {} : { "workers/message": message }),
    },
  };
}

function deploymentRecord({
  id = NEW_DEPLOYMENT_ID,
  createdOn = DEPLOYMENT_CREATED_ON,
  source = "wrangler",
  strategy = "percentage",
  versions = [{ version_id: NEW_VERSION_ID, percentage: 100 }],
} = {}) {
  return { id, created_on: createdOn, source, strategy, versions };
}

function commandResult(value, overrides = {}) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "", ...overrides };
}

function controlPlaneFixture(identity = expectedIdentity()) {
  return inspectControlPlaneTransition({
    beforeVersionsResult: commandResult([
      versionRecord({ id: OLD_VERSION_ID, createdOn: "2026-08-10T00:00:00.000Z" }),
    ]),
    beforeDeploymentsResult: commandResult([
      deploymentRecord({
        id: OLD_DEPLOYMENT_ID,
        createdOn: "2026-08-10T00:00:01.000Z",
        versions: [{ version_id: OLD_VERSION_ID, percentage: 100 }],
      }),
    ]),
    afterVersionsResult: commandResult([
      versionRecord({ id: OLD_VERSION_ID, createdOn: "2026-08-10T00:00:00.000Z" }),
      versionRecord({ tag: identity.versionTag, message: identity.versionMessage }),
    ]),
    afterDeploymentsResult: commandResult([
      deploymentRecord({
        id: OLD_DEPLOYMENT_ID,
        createdOn: "2026-08-10T00:00:01.000Z",
        versions: [{ version_id: OLD_VERSION_ID, percentage: 100 }],
      }),
      deploymentRecord(),
    ]),
    expectedIdentity: identity,
  });
}

function attestationFixture(identity = expectedIdentity(), controlPlane = controlPlaneFixture(identity)) {
  return {
    bindings: Object.fromEntries(REQUIRED_CANARY_REMOTE_BINDINGS.map((name) => [name, true])),
    build: {
      bundleInputsManifestSha256: identity.bundleInputsManifestSha256,
      bundleMetafileSha256: identity.bundleMetafileSha256,
      reviewedBundleManifestSha256: identity.reviewedBundleManifestSha256,
      sourceManifestSha256: identity.sourceManifestSha256,
    },
    documentSha256: identity.questionnaireSha256,
    identitySha256: identity.identitySha256,
    provider: {
      configurationSha256: identity.providerConfigurationSha256,
      maximumCalls: identity.visualMaximumCalls,
      maximumUsd: identity.visualMaximumUsd,
      model: identity.model,
      name: identity.provider,
      policySha256: identity.providerPolicySha256,
    },
    safety: {
      providerCalls: 0,
      providerCostUsd: "0",
      submissionClaimState: "unused",
      workflowInstancesCreated: 0,
    },
    schemaVersion: CANARY_REMOTE_ATTESTATION_SCHEMA,
    signers: {
      challengeSha256: canaryAttestationChallengeSha256(identity),
      judgementKeyId: identity.judgementPublicKeyId,
      judgementPublicKeySha256: identity.judgementPublicKeySha256,
      judgementVerified: true,
      recordKeyId: identity.recordPublicKeyId,
      recordPublicKeySha256: identity.recordPublicKeySha256,
      recordVerified: true,
    },
    workerVersion: {
      id: controlPlane.versionId,
      tag: identity.versionTag,
      timestamp: controlPlane.versionCreatedOn,
    },
  };
}

function errorCode(error) {
  return error?.code;
}

function responseAt(url, body, { status = 200, headers = {} } = {}) {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function denialResponse(url, overrides = {}) {
  return responseAt(url, overrides.body ?? DENIAL_BODY, {
    status: overrides.status ?? 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...overrides.headers,
    },
  });
}

function attestationResponse(url, value) {
  return responseAt(url, JSON.stringify(value), {
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

test("deployment identity is deterministic, closed, and binds every pre-spend digest and cap", () => {
  const identity = expectedIdentity();
  assert.equal(identity.schemaVersion, CANARY_DEPLOYMENT_IDENTITY_SCHEMA);
  assert.match(identity.identitySha256, /^[0-9a-f]{64}$/u);
  assert.equal(identity.versionTag, `sqac-${identity.identitySha256.slice(0, 24)}`);
  assert.deepEqual(deploymentIdentityFlags(identity), [
    "--tag",
    identity.versionTag,
    "--message",
    identity.versionMessage,
  ]);
  assert.ok(Object.isFrozen(identity));
  assert.notEqual(
    expectedIdentity({ bundleMetafileSha256: "a".repeat(64) }).identitySha256,
    identity.identitySha256,
  );
  assert.notEqual(
    expectedIdentity({ reviewedBundleManifestSha256: "e".repeat(64) }).identitySha256,
    identity.identitySha256,
    "the independently sealed reviewed-bundle manifest is an identity member",
  );
  assert.notEqual(
    expectedIdentity({ recordPublicKeySha256: "f".repeat(64) }).identitySha256,
    identity.identitySha256,
    "a signer-key byte change is not hidden behind a stable key id",
  );
  assert.notEqual(
    expectedIdentity({
      wrangler: { ...identityInput().wrangler, toolchainInventorySha256: "0".repeat(64) },
    }).identitySha256,
    identity.identitySha256,
    "the complete Wrangler dependency inventory enters the version identity",
  );
  assert.notEqual(
    expectedIdentity({
      wrangler: { ...identityInput().wrangler, typescriptEntrypointSha256: "0".repeat(64) },
    }).identitySha256,
    identity.identitySha256,
    "the executed TypeScript compiler bytes enter the version identity",
  );
  assert.throws(
    () => expectedIdentity({
      wrangler: { ...identityInput().wrangler, typescriptVersion: "5.9.4" },
    }),
    (error) => errorCode(error) === "IDENTITY_WRANGLER_INVALID",
  );
  assert.throws(
    () => deriveCanaryDeploymentIdentity({ ...identityInput(), unreviewed: true }),
    (error) => errorCode(error) === "IDENTITY_SCHEMA_DRIFT",
  );
  assert.throws(
    () => expectedIdentity({ visualMaximumCalls: 2 }),
    (error) => errorCode(error) === "IDENTITY_SPEND_CAP_INVALID",
  );
  assert.throws(
    () => expectedIdentity({ requiredBindings: REQUIRED_CANARY_REMOTE_BINDINGS.slice(1) }),
    (error) => errorCode(error) === "IDENTITY_BINDINGS_INVALID",
  );
  assert.deepEqual(canaryDeploymentIdentityVars(identity), {
    CANARY_BUNDLE_INPUTS_MANIFEST_SHA256: identity.bundleInputsManifestSha256,
    CANARY_BUNDLE_METAFILE_SHA256: identity.bundleMetafileSha256,
    CANARY_DEPLOYMENT_IDENTITY_SHA256: identity.identitySha256,
    CANARY_EXPECTED_DOCUMENT_SHA256: identity.questionnaireSha256,
    CANARY_REVIEWED_BUNDLE_MANIFEST_SHA256: identity.reviewedBundleManifestSha256,
    CANARY_SOURCE_MANIFEST_SHA256: identity.sourceManifestSha256,
    CANARY_VERSION_TAG: identity.versionTag,
    CANARY_VISUAL_POLICY_SHA256: identity.providerPolicySha256,
    VISUAL_MAX_CALLS: "1",
    VISUAL_MAX_USD: identity.visualMaximumUsd,
    VISUAL_PROVIDER: identity.provider,
  });
});

test("deployment environment starts from an explicit minimal allowlist and re-adds only exact pins", () => {
  const poison = { HARMLESS_SENTINEL: "must-be-dropped", TEMP: "E:\\survey-qa\\.tmp" };
  for (const [index, name] of FORBIDDEN_DEPLOY_ENVIRONMENT_NAMES.entries()) {
    poison[index % 2 === 0 ? name.toLowerCase() : alternatingCase(name)] = `poison-${index}`;
  }
  Object.assign(poison, {
    "WrAnGlEr_FUTURE_OVERRIDE": "poison",
    "CloudFlare_FUTURE_OVERRIDE": "poison",
    "Cf_Future": "poison",
    "npm_config_https_proxy": "poison",
    "NoDe_Future_Inject": "poison",
    "Ssl_Future_Trust": "poison",
    "vendor_proxy": "poison",
  });
  const logFile = path.resolve("E:\\survey-qa\\.tmp\\private-canary-attestation.log");
  const child = buildPinnedDeployEnvironment(poison, logFile);
  assert.equal(child.HARMLESS_SENTINEL, undefined);
  assert.equal(child.TEMP, "E:\\survey-qa\\.tmp");
  assert.ok(INHERITED_DEPLOY_ENVIRONMENT_NAMES.includes("TEMP"));
  assert.equal(child.WRANGLER_API_ENVIRONMENT, "production");
  assert.equal(child.CLOUDFLARE_COMPLIANCE_REGION, "public");
  assert.equal(child.WRANGLER_LOG_PATH, logFile);
  assert.ok(!Object.values(child).some((value) => typeof value === "string" && value.startsWith("poison")));
  assert.equal(assertPinnedDeployEnvironment(child, logFile), child);

  assert.throws(
    () => assertPinnedDeployEnvironment({ ...child, HARMLESS_SENTINEL: "poison" }, logFile),
    (error) => errorCode(error) === "ENVIRONMENT_NAME_NOT_ALLOWED",
  );
});

test("read plan uses exact Node plus one absolute Wrangler entrypoint and closed JSON commands", () => {
  const configPath = path.resolve("E:\\survey-qa\\.tmp\\canary-reviewed.json");
  const logFile = path.resolve("E:\\survey-qa\\.tmp\\canary-postdeploy.log");
  const pinnedWrangler = pinnedWranglerDescriptor();
  const cliPath = pinnedWrangler.cliPath;
  const plan = buildPostDeployReadPlan({
    pinnedWrangler,
    configPath,
    workerName: "survey-qa-v2-visual-canary",
    logFile,
    environment: { CLOUDFLARE_API_TOKEN: "must-not-survive", SAFE: "yes" },
  });
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.commands.length, 2);
  assert.deepEqual(plan.commands[0].args, [
    cliPath,
    "versions",
    "list",
    "--name",
    "survey-qa-v2-visual-canary",
    "--json",
    "--config",
    configPath,
  ]);
  assert.deepEqual(plan.commands[1].args.slice(0, 3), [cliPath, "deployments", "list"]);
  assert.equal(plan.environment.SAFE, undefined);
  assert.ok(!("CLOUDFLARE_API_TOKEN" in plan.environment));
  assert.ok(!plan.commands.flatMap((entry) => entry.args).includes("--env"));

  assert.throws(
    () => buildPostDeployReadPlan({
      pinnedWrangler: Object.freeze({ ...pinnedWrangler, command: "wrangler" }),
      configPath,
      workerName: "survey-qa-v2-visual-canary",
      logFile,
      environment: {},
    }),
    (error) => errorCode(error) === "WRANGLER_DESCRIPTOR_INVALID",
  );
});

test("control-plane transition proves one new tag-bound version and one 100-percent deployment", () => {
  const identity = expectedIdentity();
  const evidence = controlPlaneFixture(identity);
  assert.deepEqual(evidence, {
    schemaVersion: "survey-qa-canary-control-plane-attestation/1.0.0",
    accountId: identity.accountId,
    workerName: identity.workerName,
    identitySha256: identity.identitySha256,
    versionId: NEW_VERSION_ID,
    versionTag: identity.versionTag,
    versionCreatedOn: VERSION_CREATED_ON,
    deploymentId: NEW_DEPLOYMENT_ID,
    deploymentCreatedOn: DEPLOYMENT_CREATED_ON,
  });
});

test("current control-plane attestation requires the same latest 100-percent eligibility deployment", () => {
  const identity = expectedIdentity();
  const versions = [
    versionRecord({ id: OLD_VERSION_ID, createdOn: "2026-08-10T00:00:00.000Z" }),
    versionRecord({ tag: identity.versionTag, message: identity.versionMessage }),
  ];
  const deployments = [
    deploymentRecord({
      id: OLD_DEPLOYMENT_ID,
      createdOn: "2026-08-10T00:00:01.000Z",
      versions: [{ version_id: OLD_VERSION_ID, percentage: 100 }],
    }),
    deploymentRecord(),
  ];
  const current = inspectCurrentCanaryControlPlane({
    versionsResult: commandResult(versions),
    deploymentsResult: commandResult(deployments),
    expectedIdentity: identity,
    expectedVersionId: NEW_VERSION_ID,
    expectedDeploymentId: NEW_DEPLOYMENT_ID,
  });
  assert.equal(current.versionId, NEW_VERSION_ID);
  assert.equal(current.deploymentId, NEW_DEPLOYMENT_ID);

  assert.throws(() => inspectCurrentCanaryControlPlane({
    versionsResult: commandResult(versions),
    deploymentsResult: commandResult([...deployments, deploymentRecord({
      id: "55555555-5555-4555-8555-555555555555",
      createdOn: "2026-08-11T05:05:07.000Z",
    })]),
    expectedIdentity: identity,
    expectedVersionId: NEW_VERSION_ID,
    expectedDeploymentId: NEW_DEPLOYMENT_ID,
  }), (error) => error.code === "CURRENT_DEPLOYMENT_STALE");
});

test("control-plane reconciliation fails closed on tag reuse, ambiguity, drift, or split traffic", () => {
  const identity = expectedIdentity();
  const oldVersion = versionRecord({ id: OLD_VERSION_ID, createdOn: "2026-08-10T00:00:00.000Z" });
  const oldDeployment = deploymentRecord({
    id: OLD_DEPLOYMENT_ID,
    createdOn: "2026-08-10T00:00:01.000Z",
    versions: [{ version_id: OLD_VERSION_ID, percentage: 100 }],
  });
  const base = {
    beforeVersionsResult: commandResult([oldVersion]),
    beforeDeploymentsResult: commandResult([oldDeployment]),
    afterVersionsResult: commandResult([
      oldVersion,
      versionRecord({ tag: identity.versionTag, message: identity.versionMessage }),
    ]),
    afterDeploymentsResult: commandResult([oldDeployment, deploymentRecord()]),
    expectedIdentity: identity,
  };
  const cases = [
    [
      "VERSION_TAG_REUSED",
      { beforeVersionsResult: commandResult([
        oldVersion,
        versionRecord({ id: "55555555-5555-4555-8555-555555555555", tag: identity.versionTag }),
      ]) },
    ],
    [
      "VERSION_TRANSITION_AMBIGUOUS",
      { afterVersionsResult: commandResult([
        oldVersion,
        versionRecord({ tag: identity.versionTag, message: identity.versionMessage }),
        versionRecord({ id: "55555555-5555-4555-8555-555555555555" }),
      ]) },
    ],
    [
      "VERSION_IDENTITY_MISMATCH",
      { afterVersionsResult: commandResult([
        oldVersion,
        versionRecord({ tag: identity.versionTag, message: "wrong" }),
      ]) },
    ],
    [
      "DEPLOYMENT_TRAFFIC_MISMATCH",
      { afterDeploymentsResult: commandResult([
        oldDeployment,
        deploymentRecord({ versions: [
          { version_id: OLD_VERSION_ID, percentage: 10 },
          { version_id: NEW_VERSION_ID, percentage: 90 },
        ] }),
      ]) },
    ],
    ["VERSION_QUERY_OUTPUT_DRIFT", { afterVersionsResult: commandResult([], { stderr: "warning" }) }],
  ];
  for (const [code, override] of cases) {
    assert.throws(
      () => inspectControlPlaneTransition({ ...base, ...override }),
      (error) => errorCode(error) === code,
      code,
    );
  }
});

test("remote attestation closes version, build, provider, document, binding, signer, and unused-arm identity", () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const value = attestationFixture(identity, controlPlane);
  assert.deepEqual(validateRemoteAttestation(value, identity, controlPlane), value);

  const mutations = [
    ["REMOTE_VERSION_MISMATCH", (copy) => { copy.workerVersion.id = OLD_VERSION_ID; }],
    ["REMOTE_BUILD_MISMATCH", (copy) => { copy.build.bundleMetafileSha256 = "a".repeat(64); }],
    ["REMOTE_PROVIDER_MISMATCH", (copy) => { copy.provider.model = "other-model"; }],
    ["REMOTE_DOCUMENT_MISMATCH", (copy) => { copy.documentSha256 = "b".repeat(64); }],
    ["REMOTE_BINDING_MISSING", (copy) => { copy.bindings.BROWSER = false; }],
    ["REMOTE_SIGNER_MISMATCH", (copy) => { copy.signers.recordVerified = false; }],
    ["REMOTE_SPEND_DETECTED", (copy) => { copy.safety.providerCalls = 1; }],
    ["REMOTE_ATTESTATION_SCHEMA_DRIFT", (copy) => { copy.unreviewed = true; }],
  ];
  for (const [code, mutate] of mutations) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(
      () => validateRemoteAttestation(copy, identity, controlPlane),
      (error) => errorCode(error) === code,
      code,
    );
  }
});

test("current runtime repeat is exactly one authenticated GET and returns only closed hashes", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const attestation = attestationFixture(identity, controlPlane);
  const token = "runtime-repeat-token-material-that-is-long-enough";
  const calls = [];
  const result = await runCurrentCanaryRuntimeAttestation({
    baseUrl: "https://canary.example",
    authToken: token,
    expectedIdentity: identity,
    controlPlane,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return attestationResponse(url, attestation);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers[LIVE_CANARY_AUTH_HEADER], token);
  assert.equal(new URL(calls[0].url).pathname, CANARY_ATTESTATION_PATH);
  assert.equal(new URL(calls[0].url).searchParams.get("challenge"), canaryAttestationChallengeSha256(identity));
  assert.deepEqual(Object.keys(result).sort(), [
    "accountId", "deploymentId", "identitySha256", "remoteAttestationSha256", "schemaVersion",
    "unusedSafetySha256", "versionId", "workerName",
  ]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(calls.some(({ init }) => init.method === "POST"), false);
});

test("current runtime repeat rejects redirects, wrong version/identity, and used safety with zero POST", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const base = attestationFixture(identity, controlPlane);
  const cases = [
    ["redirect", null],
    ["identity", { ...base, identitySha256: "0".repeat(64) }],
    ["version", { ...base, workerVersion: { ...base.workerVersion, id: OLD_VERSION_ID } }],
    ["used", { ...base, safety: { ...base.safety, providerCalls: 1 } }],
  ];
  for (const [label, value] of cases) {
    let posts = 0;
    await assert.rejects(runCurrentCanaryRuntimeAttestation({
      baseUrl: "https://canary.example",
      authToken: "runtime-negative-token-material-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async (url, init) => {
        if (init.method === "POST") posts += 1;
        if (label === "redirect") return responseAt(url, "", { status: 302, headers: { location: "/other" } });
        return attestationResponse(url, value);
      },
    }), undefined, label);
    assert.equal(posts, 0, label);
  }
});

test("pre-spend remote gate performs only anonymous, attestation, and invalid probes and retains sanitized hashes", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const remote = attestationFixture(identity, controlPlane);
  const baseUrl = "https://canary.example.invalid";
  const healthUrl = `${baseUrl}/api/v2/health`;
  const attestationUrl = `${baseUrl}${CANARY_ATTESTATION_PATH}?challenge=${canaryAttestationChallengeSha256(identity)}`;
  const submissionUrl = `${baseUrl}/api/v2/runs`;
  const calls = [];
  const responses = [
    () => denialResponse(healthUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, remote),
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses[calls.length - 1]();
  };
  const token = "operator-only-token-that-is-long-enough";
  const audit = await runCanaryPreSpendRemoteGate({
    baseUrl,
    authToken: token,
    expectedIdentity: identity,
    controlPlane,
    fetchImpl,
  });
  assert.equal(audit.schemaVersion, CANARY_POST_DEPLOY_AUDIT_SCHEMA);
  assert.equal(calls.length, 7);
  assert.equal(new Headers(calls[0].init.headers).has(LIVE_CANARY_AUTH_HEADER), false);
  assert.equal(new Headers(calls[2].init.headers).has(LIVE_CANARY_AUTH_HEADER), false);
  assert.ok([1, 3, 4, 5, 6].every((index) =>
    new Headers(calls[index].init.headers).get(LIVE_CANARY_AUTH_HEADER) === token));
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "POST", "GET", "POST", "POST", "GET"]);
  assert.equal(calls[4].init.body.includes("documentBase64"), false, "malformed probe is not repaired");
  const mismatch = JSON.parse(calls[5].init.body);
  assert.notEqual(sha256(Buffer.from(mismatch.documentBase64, "base64")), identity.questionnaireSha256);
  assert.equal(JSON.stringify(audit).includes(token), false, "retained evidence contains no bearer");
  assert.ok(Object.values(audit).every((value) => typeof value !== "string" || !value.includes(DENIAL_BODY)));
});

test("anonymous denial and remote identity failures stop before any POST", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const baseUrl = "https://canary.example.invalid";
  const healthUrl = `${baseUrl}/api/v2/health`;
  const attestationUrl = `${baseUrl}${CANARY_ATTESTATION_PATH}?challenge=${canaryAttestationChallengeSha256(identity)}`;

  const anonymousCalls = [];
  await assert.rejects(
    runCanaryPreSpendRemoteGate({
      baseUrl,
      authToken: "operator-only-token-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async (url, init) => {
        anonymousCalls.push({ url, init });
        return responseAt(healthUrl, "healthy", { status: 200, headers: { "content-type": "text/plain" } });
      },
    }),
    (error) => errorCode(error) === "ANONYMOUS_DENIAL_FAILED",
  );
  assert.equal(anonymousCalls.length, 1);

  const wrong = attestationFixture(identity, controlPlane);
  wrong.build.bundleMetafileSha256 = "f".repeat(64);
  const identityCalls = [];
  await assert.rejects(
    runCanaryPreSpendRemoteGate({
      baseUrl,
      authToken: "operator-only-token-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async (url, init) => {
        identityCalls.push({ url, init });
        return identityCalls.length === 1
          ? denialResponse(healthUrl)
          : attestationResponse(attestationUrl, wrong);
      },
    }),
    (error) => errorCode(error) === "REMOTE_BUILD_MISMATCH",
  );
  assert.equal(identityCalls.length, 2);
  assert.equal(identityCalls.some((call) => call.init.method === "POST"), false);
});

test("anonymous denial is proved on the paid submission route, not inferred from health", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const remote = attestationFixture(identity, controlPlane);
  const baseUrl = "https://canary.example.invalid";
  const healthUrl = `${baseUrl}/api/v2/health`;
  const attestationUrl = `${baseUrl}${CANARY_ATTESTATION_PATH}?challenge=${canaryAttestationChallengeSha256(identity)}`;
  const submissionUrl = `${baseUrl}/api/v2/runs`;
  let calls = 0;
  await assert.rejects(
    runCanaryPreSpendRemoteGate({
      baseUrl,
      authToken: "operator-only-token-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async () => [
        denialResponse(healthUrl),
        attestationResponse(attestationUrl, remote),
        responseAt(submissionUrl, JSON.stringify({ runId: "route-bypass" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ][calls++] ,
    }),
    (error) => errorCode(error) === "ANONYMOUS_SUBMISSION_NOT_DENIED",
  );
  assert.equal(calls, 3);
});

test("malformed or mismatched acceptance and post-probe spend evidence fail closed", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const remote = attestationFixture(identity, controlPlane);
  const baseUrl = "https://canary.example.invalid";
  const healthUrl = `${baseUrl}/api/v2/health`;
  const attestationUrl = `${baseUrl}${CANARY_ATTESTATION_PATH}?challenge=${canaryAttestationChallengeSha256(identity)}`;
  const submissionUrl = `${baseUrl}/api/v2/runs`;

  const acceptedCalls = [];
  await assert.rejects(
    runCanaryPreSpendRemoteGate({
      baseUrl,
      authToken: "operator-only-token-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async (url, init) => {
        acceptedCalls.push({ url, init });
        if (acceptedCalls.length === 1) return denialResponse(healthUrl);
        if (acceptedCalls.length === 2) return attestationResponse(attestationUrl, remote);
        if (acceptedCalls.length === 3) return denialResponse(submissionUrl);
        if (acceptedCalls.length === 4) return attestationResponse(attestationUrl, remote);
        return responseAt(submissionUrl, JSON.stringify({ runId: "unexpected" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error) => errorCode(error) === "MALFORMED_SUBMISSION_NOT_DENIED",
  );
  assert.equal(acceptedCalls.length, 5, "mismatched probe is not attempted after malformed acceptance");

  const changed = structuredClone(remote);
  changed.safety.providerCalls = 1;
  const changedResponses = [
    () => denialResponse(healthUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, changed),
  ];
  let changedCalls = 0;
  await assert.rejects(
    runCanaryPreSpendRemoteGate({
      baseUrl,
      authToken: "operator-only-token-that-is-long-enough",
      expectedIdentity: identity,
      controlPlane,
      fetchImpl: async () => changedResponses[changedCalls++](),
    }),
    (error) => errorCode(error) === "REMOTE_SPEND_DETECTED",
  );
  assert.equal(changedCalls, 7);
});

test("sanitized audit writer is exclusive and re-verifies private parent and file", async () => {
  const identity = expectedIdentity();
  const controlPlane = controlPlaneFixture(identity);
  const remote = attestationFixture(identity, controlPlane);
  const baseUrl = "https://canary.example.invalid";
  const healthUrl = `${baseUrl}/api/v2/health`;
  const attestationUrl = `${baseUrl}${CANARY_ATTESTATION_PATH}?challenge=${canaryAttestationChallengeSha256(identity)}`;
  const submissionUrl = `${baseUrl}/api/v2/runs`;
  const responses = [
    () => denialResponse(healthUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, remote),
    () => denialResponse(submissionUrl),
    () => denialResponse(submissionUrl),
    () => attestationResponse(attestationUrl, remote),
  ];
  let index = 0;
  const audit = await runCanaryPreSpendRemoteGate({
    baseUrl,
    authToken: "operator-only-token-that-is-long-enough",
    expectedIdentity: identity,
    controlPlane,
    fetchImpl: async () => responses[index++](),
  });

  const root = mkdtempSync(path.join(tmpdir(), "canary-postdeploy-audit-"));
  const privateDirectory = path.join(root, "private");
  mkdirSync(privateDirectory);
  const outputFile = path.join(privateDirectory, "attestation.json");
  const checked = [];
  const written = writePrivatePostDeployAudit({
    audit,
    outputFile,
    repositoryRoot: root,
    assertPrivatePathImpl(target, repositoryRoot, options) {
      checked.push({ target, repositoryRoot, options });
    },
  });
  assert.equal(checked.length, 2);
  assert.deepEqual(checked[0].options, { directory: true });
  assert.equal(checked[1].target, outputFile);
  assert.equal(readFileSync(outputFile, "utf8"), `${stableJson(audit)}\n`);
  assert.equal(written.sha256, sha256(Buffer.from(readFileSync(outputFile))));
  assert.throws(
    () => writePrivatePostDeployAudit({
      audit,
      outputFile,
      repositoryRoot: root,
      assertPrivatePathImpl() {},
    }),
    (error) => errorCode(error) === "AUDIT_WRITE_FAILED",
  );

  assert.throws(
    () => writePrivatePostDeployAudit({
      audit: { ...audit, rawToken: "must-never-be-retained" },
      outputFile: path.join(privateDirectory, "bad.json"),
      repositoryRoot: root,
      assertPrivatePathImpl() {},
    }),
    (error) => errorCode(error) === "AUDIT_RECORD_INVALID",
  );
});

function alternatingCase(value) {
  return [...value].map((character, index) => index % 2 === 0 ? character.toLowerCase() : character.toUpperCase()).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
