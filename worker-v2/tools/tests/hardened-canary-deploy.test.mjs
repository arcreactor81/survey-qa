import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import * as esbuild from "esbuild";
import * as hardenedCanaryDeploy from "../hardened-canary-deploy.mjs";

import {
  CANARY_PROVIDER_MODELS,
  HARDENED_CANARY_CONTROL_FILES,
  buildHardenedWranglerCommandPlan,
  buildExpectedCanaryDynamicVars,
  buildReviewedCanaryBundleTwoPass,
  canaryProviderConfiguration,
  createDeploymentControlManifest,
  deployPreparedCanary,
  inspectDeploymentControlImportGraph,
  reviewedModulePolicyFromBuildConfig,
  selectUploadedCanaryVersionId,
  verifyDeploymentControlManifest,
} from "../hardened-canary-deploy.mjs";
import {
  REQUIRED_CANARY_REMOTE_BINDINGS,
  deriveCanaryDeploymentIdentity,
} from "../canary-post-deploy-attestation.mjs";
import {
  freezeCanarySourceSnapshot,
  verifyCanarySourceSnapshot,
} from "../canary-source-snapshot.mjs";
import { verifyReviewedCanaryBundle } from "../canary-bundle-inputs.mjs";
import { createCanarySigningBundle } from "../generate-live-canary-signing-bundle.mjs";
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
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HARDENED_CANARY_DEPLOY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hardened-canary-deploy.mjs",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTmpdir() {
  return realpathSync.native(tmpdir());
}

function wranglerEvidence(overrides = {}) {
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
    ...overrides,
  };
}

function pinnedWranglerDescriptor(root) {
  const packageRoot = path.resolve(root, "node_modules", "wrangler");
  const cliPath = path.join(packageRoot, "wrangler-dist", "cli.js");
  const typescriptPackageRoot = path.resolve(root, "node_modules", "typescript");
  return Object.freeze({
    command: process.execPath,
    argsPrefix: Object.freeze([cliPath]),
    version: EXPECTED_WRANGLER_VERSION,
    packageRoot,
    packageJsonPath: path.join(packageRoot, "package.json"),
    packageLockPath: path.resolve(root, "package-lock.json"),
    binPath: path.join(packageRoot, "bin", "wrangler.js"),
    cliPath,
    typescriptPackageRoot,
    typescriptPackageJsonPath: path.join(typescriptPackageRoot, "package.json"),
    typescriptEntrypointPath: path.join(typescriptPackageRoot, "lib", "typescript.js"),
    evidence: Object.freeze(wranglerEvidence()),
  });
}

function finalReplayFixture(t, {
  mutateConfig,
  mutateOutput,
  commandResult: suppliedCommandResult,
} = {}) {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-final-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "artifacts");
  const snapshotDirectory = path.join(root, "snapshot");
  const snapshotWorkerRoot = path.join(snapshotDirectory, "worker-v2");
  const reviewedBundleDirectory = path.join(root, "reviewed-bundle");
  mkdirSync(artifacts);
  mkdirSync(snapshotWorkerRoot, { recursive: true });
  mkdirSync(path.join(reviewedBundleDirectory, "modules"), { recursive: true });

  const entryBytes = Buffer.from("export default { fetch() { return new Response('ok'); } };\n", "utf8");
  const moduleBytes = Buffer.from(".survey-report { color: rgb(12 34 56); }\n", "utf8");
  const entry = {
    path: "index.js",
    bytes: entryBytes.length,
    sha256: sha256(entryBytes),
  };
  const module = {
    path: "modules/report.css",
    bytes: moduleBytes.length,
    sha256: sha256(moduleBytes),
    type: "Text",
  };
  writeFileSync(path.join(reviewedBundleDirectory, entry.path), entryBytes);
  writeFileSync(path.join(reviewedBundleDirectory, ...module.path.split("/")), moduleBytes);
  const reviewed = Object.freeze({
    reviewedBundleDirectory,
    manifestSha256: "8".repeat(64),
    manifest: Object.freeze({
      entry: Object.freeze(entry),
      modules: Object.freeze([Object.freeze(module)]),
    }),
    entryPath: path.join(reviewedBundleDirectory, entry.path),
    modules: Object.freeze([Object.freeze(module)]),
  });

  const config = {
    name: "survey-qa-v2-visual-canary",
    main: reviewed.entryPath.replaceAll("\\", "/"),
    base_dir: reviewedBundleDirectory.replaceAll("\\", "/"),
    no_bundle: true,
    find_additional_modules: true,
    preserve_file_names: false,
    rules: [{ type: "Text", globs: [module.path], fallthrough: false }],
  };
  if (typeof mutateConfig === "function") mutateConfig(config);
  const configBytes = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");
  const configPath = path.join(root, "wrangler.reviewed-deploy.json");
  writeFileSync(configPath, configBytes);
  const deployConfigIdentity = Object.freeze({
    path: configPath,
    bytes: configBytes.length,
    sha256: sha256(configBytes),
  });
  const pinnedWrangler = pinnedWranglerDescriptor(root);
  const phases = [];
  const spawns = [];
  let verificationCount = 0;
  const options = {
    repositoryRoot: root,
    buildArtifactDirectory: artifacts,
    snapshotDirectory,
    snapshotWorkerRoot,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    environment: { SAFE_SENTINEL: "retained-only-in-fixture" },
    verifyReplayInputs() {
      verificationCount += 1;
      return pinnedWrangler;
    },
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  };
  const dependencies = {
    phaseObserver(phase) {
      phases.push(phase);
    },
    verifyReviewedBundleImpl() {
      return reviewed;
    },
    buildPinnedDeployEnvironmentImpl(environment, logPath) {
      return { ...environment, FINAL_REPLAY_TEST_LOG: logPath };
    },
    spawnSyncImpl(command, args, spawnOptions) {
      spawns.push({ command, args: [...args], options: spawnOptions });
      if (suppliedCommandResult !== undefined) return suppliedCommandResult;
      const outputDirectory = args[args.indexOf("--outdir") + 1];
      mkdirSync(path.join(outputDirectory, "modules"), { recursive: true });
      writeFileSync(path.join(outputDirectory, entry.path), entryBytes);
      writeFileSync(path.join(outputDirectory, ...module.path.split("/")), moduleBytes);
      writeFileSync(
        path.join(outputDirectory, "README.md"),
        'This folder contains the built output assets for the worker "survey-qa-v2-visual-canary" generated at 2026-08-11T04:05:06.123Z.',
      );
      writeFileSync(spawnOptions.env.FINAL_REPLAY_TEST_LOG, "pinned wrangler replay fixture log\n");
      if (typeof mutateOutput === "function") {
        mutateOutput({ outputDirectory, entry, module, entryBytes, moduleBytes });
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return {
    root,
    artifacts,
    snapshotDirectory,
    snapshotWorkerRoot,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    phases,
    spawns,
    options,
    dependencies,
    get verificationCount() {
      return verificationCount;
    },
  };
}

function automaticReplayPreparationFixture(t) {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-replay-preparation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runRoot = path.join(root, "runs");
  const runDirectory = path.join(runRoot, "arm-a");
  const questionnairePath = path.join(root, "questionnaire.docx");
  const sourceFiles = {
    "package.json": '{"name":"hardened-replay-preparation-fixture","private":true}\n',
    "package-lock.json":
      '{"name":"hardened-replay-preparation-fixture","lockfileVersion":3,"packages":{"":{"name":"hardened-replay-preparation-fixture"}}}\n',
    "control.mjs": "export const fixtureControl = true;\n",
    "worker-v2/wrangler.jsonc": `${JSON.stringify({
      r2_buckets: [],
      vars: { JUDGEMENT_KEY_REGISTRY: JSON.stringify({ keys: {} }) },
    }, null, 2)}\n`,
    "worker-v2/tools/live-canary-worker.ts":
      'import reportCss from "../../pipeline/report/report.css";\nexport { reportCss };\nexport default {};\n',
    "worker-v2/public/index.html": "<!doctype html><title>fixture</title>\n",
    "pipeline/report/report.css": "body { color: black; }\n",
  };
  for (const [relative, contents] of Object.entries(sourceFiles)) {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  mkdirSync(path.join(root, "node_modules"));
  mkdirSync(runRoot);
  const questionnaireBytes = Buffer.from("fixture questionnaire bytes\n", "utf8");
  writeFileSync(questionnairePath, questionnaireBytes);

  const pinnedWrangler = pinnedWranglerDescriptor(root);
  const signingBundle = createCanarySigningBundle();
  const sourceSelectors = [
    "package.json",
    "package-lock.json",
    "worker-v2/wrangler.jsonc",
    "worker-v2/tools/live-canary-worker.ts",
    "worker-v2/public",
    "pipeline/report/report.css",
  ];
  const phases = [];
  const dryRuns = [];

  const spawnSyncImpl = (command, args, options) => {
    const outputDirectory = args[args.indexOf("--outdir") + 1];
    const configPath = args[args.indexOf("--config") + 1];
    const metafileIndex = args.indexOf("--metafile");
    const metafilePath = metafileIndex === -1 ? null : args[metafileIndex + 1];
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(options.env.WRANGLER_LOG_PATH, "sanitized fixture Wrangler log\n", "utf8");

    if (metafilePath !== null) {
      const sourceEntrypoint = path.join(
        runDirectory,
        "source-snapshot",
        "worker-v2",
        "tools",
        "live-canary-worker.ts",
      );
      const moduleName = "fixturehash-report.css";
      const moduleSpecifier = `./${moduleName}`;
      const entryBytes = Buffer.from(
        `import reportCss from ${JSON.stringify(moduleSpecifier)};\nexport { reportCss };\nexport default {};\n`,
        "utf8",
      );
      const mapBytes = Buffer.from("{}\n", "utf8");
      const moduleBytes = Buffer.from("body { color: black; }\n", "utf8");
      const entryPath = path.join(outputDirectory, "live-canary-worker.js");
      const mapPath = `${entryPath}.map`;
      writeFileSync(entryPath, entryBytes);
      writeFileSync(mapPath, mapBytes);
      writeFileSync(path.join(outputDirectory, moduleName), moduleBytes);
      writeFileSync(
        path.join(outputDirectory, "README.md"),
        'This folder contains the built output assets for the worker "survey-qa-v2-visual-canary" generated at 2026-08-11T04:05:06.123Z.',
        "utf8",
      );
      const sourceName = portableRelative(runDirectory, sourceEntrypoint);
      writeFileSync(metafilePath, `${JSON.stringify({
        inputs: {
          [sourceName]: {
            bytes: readFileSync(sourceEntrypoint).length,
            imports: [{ path: moduleSpecifier, kind: "import-statement", external: true }],
            format: "esm",
          },
        },
        outputs: {
          [portableRelative(runDirectory, mapPath)]: {
            imports: [],
            exports: [],
            inputs: {},
            bytes: mapBytes.length,
          },
          [portableRelative(runDirectory, entryPath)]: {
            imports: [{ path: moduleSpecifier, kind: "import-statement", external: true }],
            exports: ["default"],
            entryPoint: sourceName,
            inputs: { [sourceName]: { bytesInOutput: 1 } },
            bytes: entryBytes.length,
          },
        },
      })}\n`, "utf8");
    } else {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const reviewedEntry = path.resolve(config.main);
      writeFileSync(
        path.join(outputDirectory, path.basename(reviewedEntry)),
        readFileSync(reviewedEntry),
      );
      for (const rule of config.rules ?? []) {
        for (const relative of rule.globs ?? []) {
          const source = path.join(path.resolve(config.base_dir), ...relative.split("/"));
          const destination = path.join(outputDirectory, ...relative.split("/"));
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, readFileSync(source));
        }
      }
      writeFileSync(
        path.join(outputDirectory, "README.md"),
        `This folder contains the built output assets for the worker "${config.name}" generated at 2026-08-11T04:05:06.123Z.`,
        "utf8",
      );
    }

    dryRuns.push({ command, args: [...args], options });
    return { status: 0, stdout: "", stderr: "" };
  };

  const dependencies = {
    controlFiles: ["control.mjs"],
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
    freezeSourceSnapshotImpl(options) {
      return freezeCanarySourceSnapshot({ ...options, selectors: sourceSelectors });
    },
    sealSourceSnapshotImpl(options) {
      return verifyCanarySourceSnapshot(options);
    },
    sealReviewedBundleImpl(options) {
      return verifyReviewedCanaryBundle(options);
    },
    resolvePinnedWranglerCommandImpl() {
      return pinnedWrangler;
    },
    verifyPinnedWranglerCommandImpl() {
      return pinnedWrangler;
    },
    async loadSigningBundleImpl() {
      return signingBundle;
    },
    tokenFactory() {
      return "fixture-token-with-at-least-thirty-two-characters";
    },
    buildPhaseObserver(phase) {
      phases.push(phase);
    },
    spawnSyncImpl,
  };
  return {
    root,
    runRoot,
    runDirectory,
    questionnairePath,
    questionnaireSha256: sha256(questionnaireBytes),
    dependencies,
    phases,
    dryRuns,
  };
}

function portableRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function automaticReplayPreparationOptions(fx) {
  return {
    repositoryRoot: fx.root,
    runRoot: fx.runRoot,
    runDirectory: fx.runDirectory,
    provider: "workers-ai-gemma4",
    questionnairePath: fx.questionnairePath,
    expectedDocumentSha256: fx.questionnaireSha256,
    environment: {},
  };
}

async function importHardenedCanaryDeployMutant(t, label, find, replacement) {
  let source = readFileSync(HARDENED_CANARY_DEPLOY_PATH, "utf8").replaceAll("\r\n", "\n");
  const hits = source.split(find).length - 1;
  assert.equal(
    hits,
    1,
    `mutation anchor ${JSON.stringify(label)} matched ${hits} times; an unapplied mutant proves nothing`,
  );
  source = source.replace(find, replacement);
  const productionDirectory = path.dirname(HARDENED_CANARY_DEPLOY_PATH);
  source = source.replace(
    /(\bfrom\s+)(["'])(\.\.?\/[^"']+)\2/gu,
    (_match, prefix, quote, specifier) =>
      `${prefix}${quote}${pathToFileURL(path.resolve(productionDirectory, specifier)).href}${quote}`,
  );
  const mutantRoot = mkdtempSync(path.join(canonicalTmpdir(), "hardened-replay-wiring-mutant-"));
  t.after(() => rmSync(mutantRoot, { recursive: true, force: true }));
  const mutantPath = path.join(mutantRoot, `${label}.mjs`);
  writeFileSync(mutantPath, source, "utf8");
  return await import(pathToFileURL(mutantPath).href);
}

function identity() {
  return deriveCanaryDeploymentIdentity({
    accountId: "a".repeat(32),
    bundleInputsManifestSha256: "1".repeat(64),
    bundleMetafileSha256: "2".repeat(64),
    judgementPublicKeyId: "judgement-key",
    judgementPublicKeySha256: "3".repeat(64),
    model: CANARY_PROVIDER_MODELS["workers-ai-gemma4"],
    provider: "workers-ai-gemma4",
    providerConfigurationSha256: "4".repeat(64),
    providerPolicySha256: "5".repeat(64),
    questionnaireSha256: "6".repeat(64),
    recordPublicKeyId: "record-key",
    recordPublicKeySha256: "7".repeat(64),
    requiredBindings: [...REQUIRED_CANARY_REMOTE_BINDINGS],
    reviewedBundleManifestSha256: "8".repeat(64),
    sourceManifestSha256: "9".repeat(64),
    visualMaximumCalls: 1,
    visualMaximumUsd: "0.0263",
    workerName: "survey-qa-v2-visual-canary",
    wrangler: {
      ...wranglerEvidence(),
      version: EXPECTED_WRANGLER_VERSION,
    },
  });
}

function versionRecord({
  id,
  createdOn,
  tag = null,
  message = null,
} = {}) {
  return {
    id,
    metadata: { created_on: createdOn, source: "wrangler" },
    annotations: {
      ...(tag === null ? {} : { "workers/tag": tag }),
      ...(message === null ? {} : { "workers/message": message }),
    },
  };
}

function deploymentRecord({ id, createdOn, versionId }) {
  return {
    id,
    created_on: createdOn,
    source: "wrangler",
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function commandResult(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: "" };
}

function deploymentFixture(t) {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-canary-deploy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "wrangler.reviewed-deploy.json");
  const secretsFilePath = path.join(root, "canary-worker-secrets.json");
  const tokenPath = path.join(root, "canary-token.txt");
  const snapshotWorkerRoot = path.join(root, "snapshot-worker");
  const reviewedDirectory = path.join(root, "reviewed-bundle");
  mkdirSync(snapshotWorkerRoot);
  mkdirSync(reviewedDirectory);
  writeFileSync(configPath, "{}\n");
  const secretBytes = Buffer.from("{\"secret\":\"not-returned\"}\n");
  writeFileSync(secretsFilePath, secretBytes);
  const token = "super-secret-token-material-not-returned";
  const tokenBytes = Buffer.from(`${token}\n`);
  writeFileSync(tokenPath, tokenBytes);
  const expectedIdentity = identity();
  const pinnedWrangler = pinnedWranglerDescriptor(root);
  const prepared = {
    repositoryRoot: root,
    runDirectory: root,
    snapshot: { snapshotDirectory: path.join(root, "snapshot"), manifestSha256: "9".repeat(64) },
    reviewed: { reviewedBundleDirectory: reviewedDirectory, manifestSha256: "8".repeat(64) },
    control: { sha256: "7".repeat(64) },
    deploymentInputs: { sha256: "d".repeat(64) },
    assets: { sha256: "e".repeat(64) },
    identity: expectedIdentity,
    provider: expectedIdentity.provider,
    expectedDocumentSha256: expectedIdentity.questionnaireSha256,
    expectedDynamicVars: { CANARY_AUTH_SHA256: sha256(Buffer.from(token, "utf8")) },
    pinnedWrangler,
    deployConfigIdentity: { path: configPath, sha256: "f".repeat(64) },
    buildConfigIdentity: { path: path.join(root, "wrangler.snapshot-build.json"), sha256: "6".repeat(64) },
    tokenIdentity: { path: tokenPath, bytes: tokenBytes.length, sha256: sha256(tokenBytes) },
    secretIdentity: { path: secretsFilePath, bytes: secretBytes.length, sha256: sha256(secretBytes) },
    tokenPath,
    secretsFilePath,
    deployConfigPath: configPath,
    snapshotWorkerRoot,
    environment: { CLOUDFLARE_API_TOKEN: "must-not-survive", SAFE_SENTINEL: "drop-me" },
    assertPrivatePathImpl() {},
  };

  const oldVersion = versionRecord({
    id: OLD_VERSION_ID,
    createdOn: "2026-08-10T00:00:00.000Z",
  });
  const newVersion = versionRecord({
    id: NEW_VERSION_ID,
    createdOn: "2026-08-11T04:05:06.000Z",
    tag: expectedIdentity.versionTag,
    message: expectedIdentity.versionMessage,
  });
  const oldDeployment = deploymentRecord({
    id: OLD_DEPLOYMENT_ID,
    createdOn: "2026-08-10T00:00:01.000Z",
    versionId: OLD_VERSION_ID,
  });
  const newDeployment = deploymentRecord({
    id: NEW_DEPLOYMENT_ID,
    createdOn: "2026-08-11T04:05:07.000Z",
    versionId: NEW_VERSION_ID,
  });
  return { root, prepared, token, oldVersion, newVersion, oldDeployment, newDeployment };
}

function successfulDependencies(fx, overrides = {}) {
  let versionReads = 0;
  let deploymentReads = 0;
  const spawned = [];
  const dependencies = {
    verifyPreparedImpl() { return true; },
    phaseObserver() {},
    runWorkflowGateImpl() {
      return { queryCount: 22, logAudit: { sha256: "c".repeat(64) } };
    },
    spawnSyncImpl(command, args) {
      spawned.push({ command, args: [...args] });
      if (args.includes("upload") || args.includes("deploy")) return { status: 0, stdout: "RAW SUCCESS", stderr: "" };
      if (args.includes("secret")) {
        return commandResult([
          { name: "JUDGEMENT_SIGNING_KEY", type: "secret_text" },
          { name: "JUDGEMENT_SIGNING_KEY_ID", type: "secret_text" },
          { name: "RECORD_SIGNING_KEY", type: "secret_text" },
          { name: "RECORD_SIGNING_KEY_ID", type: "secret_text" },
        ]);
      }
      if (args.includes("versions")) {
        versionReads += 1;
        return commandResult(versionReads === 1 ? [fx.oldVersion] : [fx.oldVersion, fx.newVersion]);
      }
      if (args.includes("deployments")) {
        deploymentReads += 1;
        return commandResult(deploymentReads === 1
          ? [fx.oldDeployment]
          : [fx.oldDeployment, fx.newDeployment]);
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    async runRemoteGateImpl() {
      return { sanitized: true };
    },
    verifyControlLogImpl() {
      return { bytes: 10, sha256: "f".repeat(64) };
    },
    writePostDeployAuditImpl() {
      return { path: path.join(fx.root, "audit.json"), bytes: 10, sha256: "a".repeat(64) };
    },
    writeEligibilityImpl() {
      return { path: path.join(fx.root, "eligible.json"), bytes: 10, sha256: "b".repeat(64) };
    },
    ...overrides,
  };
  return { dependencies, spawned };
}

test("preparation exposes a mandatory final reviewed no-bundle replay gate", () => {
  assert.equal(
    typeof hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate,
    "function",
    "preparation has no production replay/census gate after the final deploy config is projected",
  );
});

test("preparation automatically retains the third dry-run and the default deploy verifier guards it", async (t) => {
  const fx = automaticReplayPreparationFixture(t);
  const prepared = await hardenedCanaryDeploy.prepareHardenedCanaryDeployment(
    automaticReplayPreparationOptions(fx),
    fx.dependencies,
  );

  assert.deepEqual(fx.phases, [
    "bundle-discovery-dry-run",
    "bundle-input-precommit",
    "bundle-audited-dry-run",
    "reviewed-bundle-freeze",
    "final-reviewed-no-bundle-replay",
  ]);
  assert.equal(fx.dryRuns.length, 3, "preparation must execute three distinct Wrangler dry-runs");
  for (const dryRun of fx.dryRuns) {
    assert.equal(dryRun.command, prepared.pinnedWrangler.command);
    assert.deepEqual(
      dryRun.args.slice(0, prepared.pinnedWrangler.argsPrefix.length),
      prepared.pinnedWrangler.argsPrefix,
    );
  }
  for (const dryRun of fx.dryRuns.slice(0, 2)) {
    assert.deepEqual(
      dryRun.args.slice(
        prepared.pinnedWrangler.argsPrefix.length,
        prepared.pinnedWrangler.argsPrefix.length + 3,
      ),
      ["deploy", "--dry-run", "--strict"],
    );
  }
  assert.deepEqual(
    fx.dryRuns[2].args.slice(
      prepared.pinnedWrangler.argsPrefix.length,
      prepared.pinnedWrangler.argsPrefix.length + 4,
    ),
    ["versions", "upload", "--dry-run", "--strict"],
    "the retained replay must exercise the same Wrangler handler as production upload",
  );
  assert.notEqual(fx.dryRuns[0].args.indexOf("--metafile"), -1);
  assert.notEqual(fx.dryRuns[1].args.indexOf("--metafile"), -1);
  assert.equal(fx.dryRuns[2].args.includes("--metafile"), false);
  assert.equal(
    path.resolve(fx.dryRuns[2].args[fx.dryRuns[2].args.indexOf("--config") + 1]),
    prepared.deployConfigIdentity.path,
  );
  assert.equal(
    path.resolve(fx.dryRuns[2].args[fx.dryRuns[2].args.indexOf("--outdir") + 1]),
    prepared.finalReplay.outputDirectory,
  );
  assert.equal(Object.hasOwn(prepared, "finalReplay"), true);
  assert.equal(Object.isFrozen(prepared.finalReplay), true);
  assert.equal(prepared.finalReplay.fileCount, 3);
  assert.equal(existsSync(prepared.finalReplay.manifestPath), true);
  const retainedManifest = JSON.parse(readFileSync(prepared.finalReplay.manifestPath, "utf8"));
  assert.deepEqual(retainedManifest.command, {
    argvShape: [
      "versions",
      "upload",
      "--dry-run",
      "--strict",
      "--outdir",
      "<output-directory>",
      "--config",
      "<reviewed-config>",
    ],
    handler: "versions-upload",
    metafile: false,
    secretsFile: false,
  });
  assert.deepEqual(
    retainedManifest.files.map((entry) => entry.role).sort(),
    ["additional-module", "entry", "wrangler-readme-byproduct"],
  );
  assert.equal(
    hardenedCanaryDeploy.verifyPreparedCanaryDeployment(prepared),
    prepared.pinnedWrangler,
    "the production default verifier must accept the retained baseline",
  );

  const replayEntryPath = path.join(
    prepared.finalReplay.outputDirectory,
    ...prepared.reviewed.manifest.entry.path.split("/"),
  );
  writeFileSync(replayEntryPath, "mutated replay output\n", "utf8");
  let workflowGateCalls = 0;
  const controlPlaneSpawns = [];
  await assert.rejects(
    hardenedCanaryDeploy.deployPreparedCanary(prepared, {
      runWorkflowGateImpl() {
        workflowGateCalls += 1;
        throw new Error("mutation escaped the default prepared-state verifier");
      },
      spawnSyncImpl(command, args) {
        controlPlaneSpawns.push({ command, args: [...args] });
        throw new Error("mutation reached a control-plane subprocess");
      },
    }),
    (error) => error.code === "FINAL_REPLAY_FILE_IDENTITY_MISMATCH",
    "mutation evidence: retained replay drift must fail through the default verifier before upload",
  );
  assert.equal(workflowGateCalls, 0, "replay drift reached the pre-upload workflow gate");
  assert.equal(controlPlaneSpawns.length, 0, "replay drift reached a Wrangler upload or remote read");
});

test("source mutation controls prove the orchestration test detects every missing replay wire", async (t) => {
  await t.test("removed preparation call is killed before a prepared record exists", async (subtest) => {
    const mutant = await importHardenedCanaryDeployMutant(
      subtest,
      "removed-prepare-call",
      "const finalReplay = runFinalReviewedNoBundleReplayGate({",
      "const finalReplay = (() => ({ replayWiringRemoved: true }))({",
    );
    const fx = automaticReplayPreparationFixture(subtest);
    await assert.rejects(
      mutant.prepareHardenedCanaryDeployment(
        automaticReplayPreparationOptions(fx),
        fx.dependencies,
      ),
      (error) => error.code === "FINAL_REPLAY_RECORD_INVALID",
    );
    assert.equal(fx.dryRuns.length, 2, "the preparation-call mutant must actually remove dry-run three");
  });

  await t.test("removed prepared-record retention is killed after dry-run three", async (subtest) => {
    const find = [
      "    deployConfigIdentity,",
      "    finalReplay,",
      "    tokenIdentity,",
      "    secretIdentity,",
      "    tokenPath,",
    ].join("\n");
    const replacement = [
      "    deployConfigIdentity,",
      "    tokenIdentity,",
      "    secretIdentity,",
      "    tokenPath,",
    ].join("\n");
    const mutant = await importHardenedCanaryDeployMutant(
      subtest,
      "removed-prepared-retention",
      find,
      replacement,
    );
    const fx = automaticReplayPreparationFixture(subtest);
    await assert.rejects(
      mutant.prepareHardenedCanaryDeployment(
        automaticReplayPreparationOptions(fx),
        fx.dependencies,
      ),
      (error) => error.code === "FINAL_REPLAY_RECORD_INVALID",
    );
    assert.equal(fx.dryRuns.length, 3, "the retention mutant must run but then discard dry-run three");
  });

  await t.test("removed default verification exposes replay drift at the workflow boundary", async (subtest) => {
    const find = [
      "  verifyFinalReviewedNoBundleReplayGate({",
      "    replay: finalReplay,",
      "    repositoryRoot,",
      '    buildArtifactDirectory: path.join(runDirectory, "wrangler-build"),',
      "    snapshotDirectory: snapshot.snapshotDirectory,",
      "    reviewed,",
      "    deployConfigIdentity,",
      "    pinnedWrangler,",
      "    assertPrivatePathImpl,",
      "  });",
    ].join("\n");
    const mutant = await importHardenedCanaryDeployMutant(
      subtest,
      "removed-default-verification",
      find,
      "  void finalReplay;",
    );
    const fx = automaticReplayPreparationFixture(subtest);
    const prepared = await mutant.prepareHardenedCanaryDeployment(
      automaticReplayPreparationOptions(fx),
      fx.dependencies,
    );
    const replayEntryPath = path.join(
      prepared.finalReplay.outputDirectory,
      ...prepared.reviewed.manifest.entry.path.split("/"),
    );
    writeFileSync(replayEntryPath, "mutated replay output\n", "utf8");
    let workflowGateCalls = 0;
    await assert.rejects(
      mutant.deployPreparedCanary(prepared, {
        runWorkflowGateImpl() {
          workflowGateCalls += 1;
          const error = new Error("verification mutant reached the workflow boundary");
          error.code = "MUTANT_REACHED_WORKFLOW_GATE";
          throw error;
        },
      }),
      (error) => error.code === "MUTANT_REACHED_WORKFLOW_GATE",
    );
    assert.equal(
      workflowGateCalls,
      1,
      "the verifier-removal mutant did not exercise the unsafe path the production test must kill",
    );
  });
});

test("final reviewed replay runs the exact third dry-run and persists a recomputable census", (t) => {
  const fx = finalReplayFixture(t);
  const replay = hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(
    fx.options,
    fx.dependencies,
  );
  assert.deepEqual(fx.phases, ["final-reviewed-no-bundle-replay"]);
  assert.equal(fx.spawns.length, 1);
  assert.equal(fx.spawns[0].command, fx.pinnedWrangler.command);
  assert.deepEqual(
    fx.spawns[0].args.slice(0, fx.pinnedWrangler.argsPrefix.length),
    fx.pinnedWrangler.argsPrefix,
  );
  assert.deepEqual(
    fx.spawns[0].args.slice(fx.pinnedWrangler.argsPrefix.length, fx.pinnedWrangler.argsPrefix.length + 4),
    ["versions", "upload", "--dry-run", "--strict"],
  );
  assert.equal(fx.spawns[0].args.includes("--metafile"), false);
  assert.equal(fx.spawns[0].args.includes("--secrets-file"), false);
  assert.equal(fx.spawns[0].options.cwd, fx.snapshotWorkerRoot);
  assert.ok(fx.verificationCount >= 3);
  assert.equal(replay.fileCount, 3);

  const persisted = JSON.parse(readFileSync(replay.manifestPath, "utf8"));
  assert.equal(
    persisted.schemaVersion,
    hardenedCanaryDeploy.HARDENED_CANARY_FINAL_REPLAY_SCHEMA,
  );
  assert.equal(persisted.deployConfigSha256, fx.deployConfigIdentity.sha256);
  assert.equal(
    persisted.reviewedBundleManifestSha256,
    fx.reviewed.manifestSha256,
  );
  assert.deepEqual(
    persisted.files.map((entry) => [entry.path, entry.role]).sort(),
    [
      ["README.md", "wrangler-readme-byproduct"],
      ["index.js", "entry"],
      ["modules/report.css", "additional-module"],
    ],
  );
  const verified = hardenedCanaryDeploy.verifyFinalReviewedNoBundleReplayGate({
    replay,
    repositoryRoot: fx.root,
    buildArtifactDirectory: fx.artifacts,
    snapshotDirectory: fx.snapshotDirectory,
    reviewed: fx.reviewed,
    deployConfigIdentity: fx.deployConfigIdentity,
    pinnedWrangler: fx.pinnedWrangler,
    assertPrivatePathImpl() {},
  }, {
    verifyReviewedBundleImpl: fx.dependencies.verifyReviewedBundleImpl,
  });
  assert.equal(verified.manifest.files.length, 3);
});

test("final reviewed replay rejects config, command, set, and byte mutations", async (t) => {
  await t.test("wrong module rule blocks the subprocess", (subtest) => {
    const fx = finalReplayFixture(subtest, {
      mutateConfig(config) {
        config.rules = [];
      },
    });
    assert.throws(
      () => hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(fx.options, fx.dependencies),
      (error) => error.code === "FINAL_REPLAY_CONFIG_MISMATCH",
    );
    assert.equal(fx.spawns.length, 0);
  });

  await t.test("nonzero pinned Wrangler result is terminal", (subtest) => {
    const fx = finalReplayFixture(subtest, {
      commandResult: { status: 1, stdout: "", stderr: "fixture failure" },
    });
    assert.throws(
      () => hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(fx.options, fx.dependencies),
      (error) => error.code === "FINAL_REPLAY_DRY_RUN_FAILED",
    );
    assert.equal(fx.spawns.length, 1);
    assert.equal(
      existsSync(path.join(fx.artifacts, "final-reviewed-replay-manifest.json")),
      false,
    );
  });

  await t.test("unknown source-map byproduct is counted and rejected", (subtest) => {
    const fx = finalReplayFixture(subtest, {
      mutateOutput({ outputDirectory }) {
        writeFileSync(path.join(outputDirectory, "index.js.map"), "{}\n");
      },
    });
    assert.throws(
      () => hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(fx.options, fx.dependencies),
      (error) => error.code === "FINAL_REPLAY_FILE_SET_MISMATCH",
    );
    assert.equal(
      existsSync(path.join(fx.artifacts, "final-reviewed-replay-manifest.json")),
      false,
    );
  });

  await t.test("missing reviewed module is counted and rejected", (subtest) => {
    const fx = finalReplayFixture(subtest, {
      mutateOutput({ outputDirectory, module }) {
        rmSync(path.join(outputDirectory, ...module.path.split("/")));
      },
    });
    assert.throws(
      () => hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(fx.options, fx.dependencies),
      (error) => error.code === "FINAL_REPLAY_FILE_SET_MISMATCH",
    );
  });

  await t.test("substituted reviewed module bytes are rejected", (subtest) => {
    const fx = finalReplayFixture(subtest, {
      mutateOutput({ outputDirectory, module }) {
        writeFileSync(
          path.join(outputDirectory, ...module.path.split("/")),
          ".survey-report { color: red; }\n",
        );
      },
    });
    assert.throws(
      () => hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(fx.options, fx.dependencies),
      (error) => error.code === "FINAL_REPLAY_FILE_IDENTITY_MISMATCH",
    );
  });
});

test("retained final replay drift is rejected before a later deploy side effect", (t) => {
  const fx = finalReplayFixture(t);
  const replay = hardenedCanaryDeploy.runFinalReviewedNoBundleReplayGate(
    fx.options,
    fx.dependencies,
  );
  writeFileSync(
    path.join(replay.outputDirectory, ...fx.reviewed.modules[0].path.split("/")),
    ".survey-report { color: red; }\n",
  );
  assert.throws(
    () => hardenedCanaryDeploy.verifyFinalReviewedNoBundleReplayGate({
      replay,
      repositoryRoot: fx.root,
      buildArtifactDirectory: fx.artifacts,
      snapshotDirectory: fx.snapshotDirectory,
      reviewed: fx.reviewed,
      deployConfigIdentity: fx.deployConfigIdentity,
      pinnedWrangler: fx.pinnedWrangler,
      assertPrivatePathImpl() {},
    }, {
      verifyReviewedBundleImpl: fx.dependencies.verifyReviewedBundleImpl,
    }),
    (error) => error.code === "FINAL_REPLAY_FILE_IDENTITY_MISMATCH",
  );
});

test("command plan uploads only the reviewed config and deploys the selected version at 100 percent", () => {
  const expectedIdentity = identity();
  const root = path.resolve(canonicalTmpdir(), "hardened-command-plan");
  const pinnedWrangler = pinnedWranglerDescriptor(root);
  const plan = buildHardenedWranglerCommandPlan({
    pinnedWrangler,
    configPath: path.join(root, "wrangler.reviewed.json"),
    secretsFilePath: path.join(root, "signing-secrets.json"),
    workerName: expectedIdentity.workerName,
    identity: expectedIdentity,
    uploadedVersionId: NEW_VERSION_ID,
  });
  assert.deepEqual(plan.upload.args.slice(1, 3), ["versions", "upload"]);
  assert.ok(plan.upload.args.includes("--strict"));
  assert.ok(plan.upload.args.includes("--secrets-file"));
  assert.equal(plan.upload.args.some((arg) => /(?:npx|\.cmd|\.ts)$/iu.test(arg)), false);
  assert.ok(plan.deploy.args.includes(`${NEW_VERSION_ID}@100%`));
  assert.ok(plan.deploy.args.includes("-y"));
  assert.equal(plan.deploy.args.some((arg) => arg === "--version-tag"), false);
});

test("command plan refuses missing, extra, or TypeScript-mutated pinned descriptors", () => {
  const expectedIdentity = identity();
  const root = path.resolve(canonicalTmpdir(), "hardened-command-plan-negative");
  const pinned = pinnedWranglerDescriptor(root);
  const { typescriptEntrypointPath: _missing, ...missing } = pinned;
  const candidates = [
    Object.freeze(missing),
    Object.freeze({ ...pinned, unreviewed: true }),
    Object.freeze({
      ...pinned,
      evidence: Object.freeze({
        ...pinned.evidence,
        typescriptPackageJsonSha256: "0".repeat(64),
      }),
    }),
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => buildHardenedWranglerCommandPlan({
        pinnedWrangler: candidate,
        configPath: path.join(root, "wrangler.reviewed.json"),
        secretsFilePath: path.join(root, "signing-secrets.json"),
        workerName: expectedIdentity.workerName,
        identity: expectedIdentity,
        uploadedVersionId: NEW_VERSION_ID,
      }),
      (error) => error.code === "WRANGLER_PIN_INVALID",
    );
  }
});

test("two-pass bundle build never promotes discovery output and fails closed by phase", (t) => {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-two-pass-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, "artifacts");
  mkdirSync(artifacts);
  const modulePolicy = {
    preserveFileNames: false,
    findAdditionalModules: false,
    compatibilityFlags: ["nodejs_compat"],
    rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
  };
  writeFileSync(path.join(root, "build.json"), `${JSON.stringify({
    preserve_file_names: false,
    find_additional_modules: false,
    compatibility_flags: ["nodejs_compat"],
    rules: modulePolicy.rules,
  })}\n`, "utf8");
  const pinnedWrangler = pinnedWranglerDescriptor(root);
  const phases = [];
  const spawns = [];
  let precommitOptions;
  let reviewedOptions;
  let verificationCount = 0;
  const result = buildReviewedCanaryBundleTwoPass({
    repositoryRoot: root,
    buildArtifactDirectory: artifacts,
    snapshotDirectory: path.join(root, "snapshot"),
    snapshotWorkerRoot: path.join(root, "snapshot", "worker-v2"),
    buildConfigPath: path.join(root, "build.json"),
    metafileBaseDirectory: root,
    reviewedDestination: path.join(root, "reviewed"),
    expectedSourceEntrypoint: path.join(root, "snapshot", "worker-v2", "tools", "live-canary-worker.ts"),
    modulePolicy,
    pinnedWrangler,
    environment: {},
    verifyBuildInputs() {
      verificationCount += 1;
      return pinnedWrangler;
    },
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  }, {
    phaseObserver(phase) { phases.push(phase); },
    buildPinnedDeployEnvironmentImpl() { return {}; },
    spawnSyncImpl(command, args) {
      spawns.push({ command, args: [...args] });
      return { status: 0, stdout: "", stderr: "" };
    },
    freezeBundlePrecommitImpl(options) {
      precommitOptions = options;
      return { path: options.destination, manifestSha256: "1".repeat(64) };
    },
    freezeReviewedBundleImpl(options) {
      reviewedOptions = options;
      return { reviewedBundleDirectory: options.destination, manifestSha256: "2".repeat(64) };
    },
  });

  assert.deepEqual(phases, [
    "bundle-discovery-dry-run",
    "bundle-input-precommit",
    "bundle-audited-dry-run",
    "reviewed-bundle-freeze",
  ]);
  assert.equal(spawns.length, 2);
  assert.ok(verificationCount >= 7);
  const discoveryOutput = spawns[0].args[spawns[0].args.indexOf("--outdir") + 1];
  const auditedOutput = spawns[1].args[spawns[1].args.indexOf("--outdir") + 1];
  const discoveryMetafile = spawns[0].args[spawns[0].args.indexOf("--metafile") + 1];
  const auditedMetafile = spawns[1].args[spawns[1].args.indexOf("--metafile") + 1];
  assert.notEqual(discoveryOutput, auditedOutput);
  assert.notEqual(discoveryMetafile, auditedMetafile);
  assert.equal(precommitOptions.discoveryMetafilePath, discoveryMetafile);
  assert.equal(precommitOptions.metafileBaseDirectory, root);
  assert.equal(reviewedOptions.bundleOutputDirectory, auditedOutput);
  assert.equal(reviewedOptions.metafilePath, auditedMetafile);
  assert.equal(reviewedOptions.metafileBaseDirectory, root);
  assert.notEqual(reviewedOptions.bundleOutputDirectory, discoveryOutput);
  assert.notEqual(reviewedOptions.metafilePath, discoveryMetafile);
  assert.equal(reviewedOptions.bundlePrecommitPath, precommitOptions.destination);
  assert.equal(result.reviewed.reviewedBundleDirectory, path.join(root, "reviewed"));

  assert.throws(
    () => buildReviewedCanaryBundleTwoPass({
      repositoryRoot: root,
      buildArtifactDirectory: artifacts,
      snapshotDirectory: path.join(root, "snapshot"),
      snapshotWorkerRoot: path.join(root, "snapshot", "worker-v2"),
      buildConfigPath: path.join(root, "build.json"),
      metafileBaseDirectory: root,
      reviewedDestination: path.join(root, "reviewed-policy-drift"),
      expectedSourceEntrypoint: path.join(root, "snapshot", "worker-v2", "tools", "live-canary-worker.ts"),
      modulePolicy: { ...modulePolicy, compatibilityFlags: ["nodejs_compat", "drifted"] },
      pinnedWrangler,
      environment: {},
      verifyBuildInputs() { return pinnedWrangler; },
      hardenDirectoryImpl() {},
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "BUILD_MODULE_POLICY_MISMATCH",
    "mutation evidence: a policy not derived from the exact Wrangler config must stay red",
  );

  let blockedSpawns = 0;
  let blockedFreezes = 0;
  assert.throws(() => buildReviewedCanaryBundleTwoPass({
    repositoryRoot: root,
    buildArtifactDirectory: artifacts,
    snapshotDirectory: path.join(root, "snapshot"),
    snapshotWorkerRoot: path.join(root, "snapshot", "worker-v2"),
    buildConfigPath: path.join(root, "build.json"),
    metafileBaseDirectory: root,
    reviewedDestination: path.join(root, "reviewed-blocked"),
    expectedSourceEntrypoint: path.join(root, "snapshot", "worker-v2", "tools", "live-canary-worker.ts"),
    modulePolicy,
    pinnedWrangler,
    environment: {},
    verifyBuildInputs() { return pinnedWrangler; },
    hardenDirectoryImpl() {},
    assertPrivatePathImpl() {},
  }, {
    phaseObserver(phase) {
      if (phase === "bundle-input-precommit") throw new Error("injected-precommit-stop");
    },
    buildPinnedDeployEnvironmentImpl() { return {}; },
    spawnSyncImpl() {
      blockedSpawns += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    freezeBundlePrecommitImpl() {
      blockedFreezes += 1;
      return { path: path.join(artifacts, "never.json") };
    },
  }), /injected-precommit-stop/u);
  assert.equal(blockedSpawns, 1);
  assert.equal(blockedFreezes, 0);
});

test("module policy explicitly disables filename preservation and ambient discovery", () => {
  assert.deepEqual(reviewedModulePolicyFromBuildConfig({
    preserve_file_names: false,
    find_additional_modules: false,
    compatibility_flags: ["nodejs_compat"],
    rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
  }), {
    preserveFileNames: false,
    findAdditionalModules: false,
    compatibilityFlags: ["nodejs_compat"],
    rules: [{ type: "Text", globs: ["**/report.css"], fallthrough: false }],
  });
  assert.throws(
    () => reviewedModulePolicyFromBuildConfig({
      preserve_file_names: true,
      find_additional_modules: false,
      compatibility_flags: ["nodejs_compat"],
      rules: [{ type: "Text", globs: ["**/*.css"], fallthrough: false }],
    }),
    (error) => error.code === "BUILD_MODULE_POLICY_INVALID",
  );
});

test("dynamic-var oracle is independent of the final config it judges", () => {
  const expectedIdentity = identity();
  const expected = buildExpectedCanaryDynamicVars({
    tokenSha256: "a".repeat(64),
    expectedDocumentSha256: expectedIdentity.questionnaireSha256,
    sourceManifestSha256: expectedIdentity.sourceManifestSha256,
    reviewed: {
      bundleInputsManifestSha256: expectedIdentity.bundleInputsManifestSha256,
      manifestSha256: expectedIdentity.reviewedBundleManifestSha256,
      manifest: { metafileSha256: expectedIdentity.bundleMetafileSha256 },
    },
    provider: expectedIdentity.provider,
    visualPolicy: {
      provider: expectedIdentity.provider,
      profile: "semantic-smoke-one-call",
      maximumCalls: "1",
      maximumUsd: expectedIdentity.visualMaximumUsd,
      maximumWaves: "100",
      timeoutMs: "120000",
      waveBudgetMs: "120000",
      sha256: expectedIdentity.providerPolicySha256,
    },
    judgementRegistryJson: "{\"schemaVersion\":\"test\",\"keys\":{}}",
    identity: expectedIdentity,
  });
  const finalConfig = { vars: structuredClone(expected) };
  finalConfig.vars.CANARY_AUTH_SHA256 = "f".repeat(64);
  finalConfig.vars.JUDGEMENT_KEY_REGISTRY = "{\"mutated\":true}";
  assert.equal(expected.CANARY_AUTH_SHA256, "a".repeat(64));
  assert.equal(expected.JUDGEMENT_KEY_REGISTRY, "{\"schemaVersion\":\"test\",\"keys\":{}}");
  assert.notDeepEqual(finalConfig.vars, expected);
  assert.ok(Object.isFrozen(expected));
});

test("deployer and runtime model specs hash one shared configuration for every canary provider", async (t) => {
  const output = mkdtempSync(path.join(canonicalTmpdir(), "hardened-provider-identity-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  await esbuild.build({
    entryPoints: [path.resolve(import.meta.dirname, "../../src/vision/providers/index.ts")],
    outfile: path.join(output, "providers.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const runtime = await import(pathToFileURL(path.join(output, "providers.js")).href);
  const gatewayId = "firstgateway";
  const cases = [
    ["workers-ai-gemma4", {}, await runtime.workersAiGemma4ModelSpec()],
    [
      "cloudflare-gateway-gemini",
      { CF_AIG_GATEWAY_ID: gatewayId },
      await runtime.cloudflareGatewayGeminiModelSpec(gatewayId),
    ],
    ["mistral-medium35-direct", {}, await runtime.mistralMedium35ModelSpec()],
  ];
  for (const [selector, vars, modelSpec] of cases) {
    const local = canaryProviderConfiguration({ vars }, selector);
    assert.equal(local.model, modelSpec.model, selector);
    assert.equal(local.configurationSha256, modelSpec.configurationSha256, selector);
  }
  assert.notEqual(
    canaryProviderConfiguration({ vars: { CF_AIG_GATEWAY_ID: "othergateway" } }, "cloudflare-gateway-gemini")
      .configurationSha256,
    cases[1][2].configurationSha256,
    "AI Gateway id is an inference-affecting identity member",
  );
});

test("deployment control manifest catches a changed orchestrator before any deploy operation", (t) => {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-control-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "private"));
  mkdirSync(path.join(root, "tools"));
  writeFileSync(path.join(root, "tools", "orchestrator.mjs"), "export const version = 1;\n");
  const manifest = createDeploymentControlManifest({
    repositoryRoot: root,
    outputFile: path.join(root, "private", "control.json"),
    controlFiles: ["tools/orchestrator.mjs"],
    assertPrivatePathImpl() {},
  });
  const verified = verifyDeploymentControlManifest({
    repositoryRoot: root,
    manifestPath: manifest.path,
    expectedManifestSha256: manifest.sha256,
    controlFiles: ["tools/orchestrator.mjs"],
    assertPrivatePathImpl() {},
  });
  assert.equal(verified.entryCount, 1);
  assert.equal(verified.importEdgeCount, 0);
  writeFileSync(path.join(root, "tools", "orchestrator.mjs"), "export const version = 2;\n");
  assert.throws(
    () => verifyDeploymentControlManifest({
      repositoryRoot: root,
      manifestPath: manifest.path,
      expectedManifestSha256: manifest.sha256,
      controlFiles: ["tools/orchestrator.mjs"],
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "CONTROL_FILE_DRIFT",
  );
});

test("control import closure covers the real graph and rejects unlisted imports and re-exports", (t) => {
  const realGraph = inspectDeploymentControlImportGraph({
    repositoryRoot: REPOSITORY_ROOT,
    controlFiles: HARDENED_CANARY_CONTROL_FILES,
  });
  assert.equal(realGraph.sourceCount, HARDENED_CANARY_CONTROL_FILES.length);
  assert.ok(realGraph.edgeCount >= HARDENED_CANARY_CONTROL_FILES.length);
  assert.equal(
    realGraph.edges.some((edge) =>
      edge.from === "worker-v2/tools/verified-typescript.mjs" &&
      edge.targetKind === "verified-pinned-toolchain"),
    true,
  );

  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-control-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "private"));
  mkdirSync(path.join(root, "tools"));
  writeFileSync(path.join(root, "tools", "helper.mjs"), "export const helper = true;\n");
  const orchestrator = path.join(root, "tools", "orchestrator.mjs");
  for (const [label, source] of [
    ["static import", 'import "./helper.mjs";\n'],
    ["re-export", 'export { helper } from "./helper.mjs";\n'],
    ["literal dynamic import", 'await import("./helper.mjs");\n'],
  ]) {
    writeFileSync(orchestrator, source);
    assert.throws(
      () => createDeploymentControlManifest({
        repositoryRoot: root,
        outputFile: path.join(root, "private", `${label.replaceAll(" ", "-")}.json`),
        controlFiles: ["tools/orchestrator.mjs"],
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === "CONTROL_IMPORT_UNBOUND",
      label,
    );
  }

  writeFileSync(orchestrator, 'import "./helper.mjs";\n');
  const closed = createDeploymentControlManifest({
    repositoryRoot: root,
    outputFile: path.join(root, "private", "closed.json"),
    controlFiles: ["tools/orchestrator.mjs", "tools/helper.mjs"],
    assertPrivatePathImpl() {},
  });
  assert.equal(closed.manifest.importGraph.edgeCount, 1);
  assert.equal(verifyDeploymentControlManifest({
    repositoryRoot: root,
    manifestPath: closed.path,
    expectedManifestSha256: closed.sha256,
    controlFiles: ["tools/orchestrator.mjs", "tools/helper.mjs"],
    assertPrivatePathImpl() {},
  }).importEdgeCount, 1);
});

test("control import closure refuses missing, extensionless, bare, URL, and nonliteral targets", (t) => {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-control-import-shapes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "private"));
  mkdirSync(path.join(root, "tools"));
  const orchestrator = path.join(root, "tools", "orchestrator.mjs");
  const cases = [
    ["missing", 'import "./missing.mjs";\n', "CONTROL_IMPORT_MISSING"],
    ["extensionless", 'import "./helper";\n', "CONTROL_IMPORT_SPECIFIER_INVALID"],
    ["bare", 'import "typescript";\n', "CONTROL_IMPORT_UNSAFE"],
    ["file URL", 'import "file:///tmp/helper.mjs";\n', "CONTROL_IMPORT_UNSAFE"],
    ["data URL", 'import "data:text/javascript,export default 1";\n', "CONTROL_IMPORT_UNSAFE"],
    ["nonliteral", 'const target = "./helper.mjs"; await import(target);\n', "CONTROL_DYNAMIC_IMPORT_UNBOUND"],
    ["direct require", 'require("./helper.mjs");\n', "CONTROL_COMMONJS_IMPORT_UNBOUND"],
    [
      "createRequire mutation",
      'import { createRequire } from "node:module"; const requireFromWorker = createRequire(import.meta.url); requireFromWorker("./helper.mjs");\n',
      "CONTROL_CREATE_REQUIRE_IMPORT_INVALID",
    ],
  ];
  for (const [label, source, code] of cases) {
    writeFileSync(orchestrator, source);
    assert.throws(
      () => createDeploymentControlManifest({
        repositoryRoot: root,
        outputFile: path.join(root, "private", `${label.replaceAll(" ", "-")}.json`),
        controlFiles: ["tools/orchestrator.mjs"],
        assertPrivatePathImpl() {},
      }),
      (error) => error.code === code,
      label,
    );
  }
});

test("the named createRequire seam rejects unknown package resolution", (t) => {
  const root = mkdtempSync(path.join(canonicalTmpdir(), "hardened-control-require-seam-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "private"), { recursive: true });
  mkdirSync(path.join(root, "worker-v2", "tools"), { recursive: true });
  const controlPath = path.join(root, "worker-v2", "tools", "pinned-wrangler-command.mjs");
  writeFileSync(controlPath, [
    'import { createRequire } from "node:module";',
    'import path from "node:path";',
    'const WORKER_ROOT = "worker-v2";',
    'const requireFromWorker = createRequire(path.join(WORKER_ROOT, "package.json"));',
    'requireFromWorker.resolve("./unreviewed-helper.mjs");',
    "",
  ].join("\n"));
  assert.throws(
    () => createDeploymentControlManifest({
      repositoryRoot: root,
      outputFile: path.join(root, "private", "unknown-resolution.json"),
      controlFiles: ["worker-v2/tools/pinned-wrangler-command.mjs"],
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "CONTROL_COMMONJS_RESOLVE_UNBOUND",
  );
  writeFileSync(controlPath, [
    'import { createRequire as cr } from "node:module";',
    'import path from "node:path";',
    'const WORKER_ROOT = "worker-v2";',
    'const requireFromWorker = cr(path.join(WORKER_ROOT, "package.json"));',
    'requireFromWorker.resolve("wrangler/package.json");',
    "",
  ].join("\n"));
  assert.throws(
    () => createDeploymentControlManifest({
      repositoryRoot: root,
      outputFile: path.join(root, "private", "aliased-create-require.json"),
      controlFiles: ["worker-v2/tools/pinned-wrangler-command.mjs"],
      assertPrivatePathImpl() {},
    }),
    (error) => error.code === "CONTROL_CREATE_REQUIRE_IMPORT_INVALID",
  );
});

test("upload selector refuses tag reuse, ambiguity, and identity drift", () => {
  const expectedIdentity = identity();
  const oldVersion = versionRecord({ id: OLD_VERSION_ID, createdOn: "2026-08-10T00:00:00.000Z" });
  const candidate = versionRecord({
    id: NEW_VERSION_ID,
    createdOn: "2026-08-11T04:05:06.000Z",
    tag: expectedIdentity.versionTag,
    message: expectedIdentity.versionMessage,
  });
  assert.equal(selectUploadedCanaryVersionId({
    beforeVersionsResult: commandResult([oldVersion]),
    afterUploadVersionsResult: commandResult([oldVersion, candidate]),
    identity: expectedIdentity,
  }), NEW_VERSION_ID);
  assert.throws(() => selectUploadedCanaryVersionId({
    beforeVersionsResult: commandResult([oldVersion]),
    afterUploadVersionsResult: commandResult([
      oldVersion,
      candidate,
      versionRecord({
        id: "55555555-5555-4555-8555-555555555555",
        createdOn: "2026-08-11T04:05:06.500Z",
      }),
    ]),
    identity: expectedIdentity,
  }), (error) => error.code === "UPLOAD_TRANSITION_AMBIGUOUS");
});

test("successful phase order is serial and returns no token or raw Wrangler output", async (t) => {
  const fx = deploymentFixture(t);
  const phases = [];
  const { dependencies, spawned } = successfulDependencies(fx, {
    phaseObserver(phase) { phases.push(phase); },
  });
  const result = await deployPreparedCanary(fx.prepared, dependencies);
  assert.deepEqual(phases, [
    "workflow-gate-before-upload",
    "capture-before-versions",
    "capture-before-deployments",
    "upload-reviewed-version",
    "capture-uploaded-version",
    "deploy-exact-version-100-percent",
    "capture-after-versions",
    "capture-after-deployments",
    "audit-remote-secret-names",
    "workflow-gate-after-deploy",
    "remote-pre-spend-gate",
    "write-private-post-deploy-audit",
    "mark-eligible",
  ]);
  assert.equal(result.eligibility.state, "eligible-for-separate-valid-one-call-runner");
  assert.equal(result.eligibility.workflowGateQueryCount, 44);
  assert.equal(result.eligibility.workflowGateBeforeUploadQueryCount, 22);
  assert.equal(result.eligibility.workflowGateAfterDeployQueryCount, 22);
  assert.deepEqual(result.eligibility.limitations.map((entry) => entry.code), [
    "NON_ATOMIC_WORKFLOW_QUIESCENCE",
    "ROLLOUT_OLD_VERSION_INGRESS_RACE",
    "PRIVILEGED_LOCAL_SWAP_RESTORE_RACE",
  ]);
  assert.equal(result.controlPlane.versionId, NEW_VERSION_ID);
  assert.ok(spawned.some((call) => call.args.includes(`${NEW_VERSION_ID}@100%`)));
  const retained = JSON.stringify(result);
  assert.equal(retained.includes(fx.token), false);
  assert.equal(retained.includes("RAW SUCCESS"), false);
});

test("every injected phase failure prevents all later operations", async (t) => {
  const expectedPhases = [
    "workflow-gate-before-upload",
    "capture-before-versions",
    "capture-before-deployments",
    "upload-reviewed-version",
    "capture-uploaded-version",
    "deploy-exact-version-100-percent",
    "capture-after-versions",
    "capture-after-deployments",
    "audit-remote-secret-names",
    "workflow-gate-after-deploy",
    "remote-pre-spend-gate",
    "write-private-post-deploy-audit",
    "mark-eligible",
  ];
  for (const [failureIndex, target] of expectedPhases.entries()) {
    const fx = deploymentFixture(t);
    const seen = [];
    const { dependencies } = successfulDependencies(fx, {
      phaseObserver(phase) {
        seen.push(phase);
        if (phase === target) throw new Error(`injected-${target}`);
      },
    });
    await assert.rejects(
      deployPreparedCanary(fx.prepared, dependencies),
      new RegExp(`injected-${target}`),
      target,
    );
    assert.deepEqual(seen, expectedPhases.slice(0, failureIndex + 1), target);
  }
});

test("workflow activity discovered after deployment prevents remote eligibility", async (t) => {
  const fx = deploymentFixture(t);
  let gateCalls = 0;
  let remoteGateCalls = 0;
  let auditWrites = 0;
  let eligibilityWrites = 0;
  const { dependencies } = successfulDependencies(fx, {
    runWorkflowGateImpl() {
      gateCalls += 1;
      if (gateCalls === 2) {
        const error = new Error("active workflow appeared after deployment");
        error.code = "ACTIVE_WORKFLOW_FOUND";
        throw error;
      }
      return { queryCount: 22, logAudit: { sha256: "c".repeat(64) } };
    },
    async runRemoteGateImpl() {
      remoteGateCalls += 1;
      return { sanitized: true };
    },
    writePostDeployAuditImpl() {
      auditWrites += 1;
      return { path: path.join(fx.root, "audit.json"), bytes: 10, sha256: "a".repeat(64) };
    },
    writeEligibilityImpl() {
      eligibilityWrites += 1;
      return { path: path.join(fx.root, "eligible.json"), bytes: 10, sha256: "b".repeat(64) };
    },
  });

  await assert.rejects(
    deployPreparedCanary(fx.prepared, dependencies),
    (error) => error.code === "ACTIVE_WORKFLOW_FOUND",
  );
  assert.equal(gateCalls, 2);
  assert.equal(remoteGateCalls, 0);
  assert.equal(auditWrites, 0);
  assert.equal(eligibilityWrites, 0);
});

test("post-freeze config or bundle drift is rejected before the upload Wrangler call", async (t) => {
  for (const kind of ["config", "bundle"]) {
    const fx = deploymentFixture(t);
    const watched = kind === "config"
      ? fx.prepared.deployConfigPath
      : path.join(fx.prepared.reviewed.reviewedBundleDirectory, "index.js");
    if (kind === "bundle") writeFileSync(watched, "reviewed-v1\n");
    const expected = sha256(readFileSync(watched));
    const { dependencies, spawned } = successfulDependencies(fx, {
      verifyPreparedImpl() {
        if (sha256(readFileSync(watched)) !== expected) throw new Error(`${kind}-drift`);
        return true;
      },
      phaseObserver(phase) {
        if (phase === "capture-before-deployments") writeFileSync(watched, `${kind}-mutated\n`);
      },
    });
    await assert.rejects(deployPreparedCanary(fx.prepared, dependencies), new RegExp(`${kind}-drift`));
    assert.equal(
      spawned.some((call) => call.args.includes("upload")),
      false,
      `${kind} drift reached Wrangler upload`,
    );
  }
});
