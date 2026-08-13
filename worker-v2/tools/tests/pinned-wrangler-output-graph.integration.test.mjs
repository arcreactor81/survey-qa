import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPinnedDeployEnvironment } from "../canary-post-deploy-attestation.mjs";
import {
  freezeCanaryBundlePrecommit,
  freezeReviewedCanaryBundle,
} from "../canary-bundle-inputs.mjs";
import { freezeCanarySourceSnapshot } from "../canary-source-snapshot.mjs";
import { buildReviewedCanaryDeployConfig } from "../generate-live-canary-config.mjs";
import {
  runFinalReviewedNoBundleReplayGate,
  verifyFinalReviewedNoBundleReplayGate,
} from "../hardened-canary-deploy.mjs";
import {
  EXPECTED_WRANGLER_VERSION,
  inspectPinnedWranglerPackage,
} from "../pinned-wrangler-command.mjs";
import {
  assertPrivateLocalPath,
  hardenPrivateLocalDirectory,
} from "../private-local-output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
const FIXTURE_BASE = path.join(WORKER_ROOT, ".test-tmp");
const FIXTURE_PREFIX = "pinned-wrangler-output-graph-";
const WRANGLER_PACKAGE_JSON = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "wrangler",
  "package.json",
);
const MAX_WRANGLER_OUTPUT_BYTES = 4 * 1024 * 1024;
const SOURCE_EXTERNAL_SPECIFIER = "../../../assets/report.css";
const PRODUCTION_SOURCE_EXTERNAL_SPECIFIER = "../../../pipeline/report/report.css";
const PRODUCTION_MODULE_POLICY = Object.freeze({
  preserveFileNames: false,
  findAdditionalModules: false,
  compatibilityFlags: Object.freeze(["nodejs_compat"]),
  rules: Object.freeze([
    Object.freeze({
      type: "Text",
      globs: Object.freeze(["**/report.css"]),
      fallthrough: false,
    }),
  ]),
});

let cachedPinnedWrangler;

test(
  "pinned Wrangler keeps a rewritten transitive Text module inside an explicit outdir",
  { timeout: 180_000 },
  (t) => {
    assert.equal(process.platform, "win32", "the checked-in Wrangler pin is a Windows adapter");
    assert.equal(process.arch, "x64", "the checked-in Wrangler pin is an x64 adapter");

    const pinnedWrangler = pinnedWranglerDescriptor();
    assert.equal(pinnedWrangler.version, EXPECTED_WRANGLER_VERSION);
    assert.equal(pinnedWrangler.version, "4.106.0");

    const roots = [];
    t.after(() => {
      for (const root of roots.reverse()) removeFixtureRoot(root);
    });

    const baseline = runPinnedBuild({
      pinnedWrangler,
      cssText: ".survey-report { color: rgb(12 34 56); }\n",
      roots,
    });
    const mutation = runPinnedBuild({
      pinnedWrangler,
      cssText: ".survey-report { color: rgb(12 34 57); }\n",
      roots,
    });

    assert.throws(
      () => assertSourceMapReleasePolicy(
        { upload_source_maps: true },
        baseline.releaseFiles,
      ),
      /must declare upload_source_maps as exact boolean false/u,
      "negative evidence: enabling source-map upload must fail the pinned release audit",
    );
    assert.throws(
      () => assertSourceMapReleasePolicy({}, baseline.releaseFiles),
      /must declare upload_source_maps as exact boolean false/u,
      "negative evidence: omitting source-map policy must fail the pinned release audit",
    );

    assert.notEqual(
      mutation.externalSpecifier,
      baseline.externalSpecifier,
      "a one-byte semantic input mutation must change the output-local content address",
    );
    assert.notEqual(mutation.cssSha1, baseline.cssSha1);
    assert.throws(
      () => assertContentAddress({
        modulePath: baseline.externalModulePath,
        sourcePath: baseline.cssSourcePath,
        expectedBytes: mutation.cssBytes,
      }),
      (error) => error?.code === "WRANGLER_TEXT_CONTENT_ADDRESS_MISMATCH",
      "negative evidence: substituted Text bytes must fail the content-address check",
    );
  },
);

test(
  "production freeze projects real pinned output into an exact replayable no-bundle upload",
  { timeout: 300_000 },
  (t) => {
    const roots = [];
    t.after(() => {
      for (const root of roots.reverse()) removeFixtureRoot(root);
    });
    runProductionReviewedReplay({
      pinnedWrangler: pinnedWranglerDescriptor(),
      roots,
    });
  },
);

function runProductionReviewedReplay({ pinnedWrangler, roots }) {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_BASE, FIXTURE_PREFIX));
  roots.push(root);
  hardenPrivateLocalDirectory(root, REPOSITORY_ROOT);
  assertPrivateLocalPath(root, REPOSITORY_ROOT, { directory: true });

  const liveEntryPath = path.join(root, "worker-v2", "tools", "live-canary-worker.ts");
  const liveTransitivePath = path.join(root, "worker-v2", "src", "report", "render.ts");
  const liveCssPath = path.join(root, "pipeline", "report", "report.css");
  const livePublicPath = path.join(root, "worker-v2", "public", "index.html");
  const packageJsonPath = path.join(root, "package.json");
  const packageLockPath = path.join(root, "package-lock.json");
  const dependencyRoot = path.join(root, "node_modules");
  const snapshotParent = path.join(root, "snapshots");
  const artifactRoot = path.join(root, "artifacts");
  mkdirSync(dependencyRoot, { recursive: true });
  mkdirSync(snapshotParent, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeNewFile(packageJsonPath, '{"name":"pinned-wrangler-reviewed-fixture","private":true}\n');
  writeNewFile(
    packageLockPath,
    '{"name":"pinned-wrangler-reviewed-fixture","lockfileVersion":3,"packages":{"":{"name":"pinned-wrangler-reviewed-fixture"}}}\n',
  );
  writeNewFile(liveEntryPath, [
    'import { reportCss } from "../src/report/render.ts";',
    "export default {",
    "  fetch() {",
    '    return new Response(reportCss, { headers: { "content-type": "text/css" } });',
    "  },",
    "};",
    "",
  ].join("\n"));
  writeNewFile(liveTransitivePath, [
    `import reportCss from ${JSON.stringify(PRODUCTION_SOURCE_EXTERNAL_SPECIFIER)};`,
    "export { reportCss };",
    "",
  ].join("\n"));
  writeNewFile(liveCssPath, ".reviewed-report { color: rgb(24 68 91); }\n");
  writeNewFile(livePublicPath, "<!doctype html><title>reviewed fixture</title>\n");

  const selectors = [
    "package.json",
    "package-lock.json",
    "worker-v2/src",
    "worker-v2/public",
    "worker-v2/tools/live-canary-worker.ts",
    "pipeline/report/report.css",
  ];
  const fixtureBoundaryAssertion = createFixtureBoundaryAssertion(root);
  const snapshot = freezeCanarySourceSnapshot({
    destination: path.join(snapshotParent, "source"),
    repositoryRoot: root,
    selectors,
    hardenDirectoryImpl: fixtureBoundaryAssertion,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  });
  const snapshotWorkerRoot = path.join(snapshot.snapshotDirectory, "worker-v2");
  const expectedSourceEntrypoint = path.join(
    snapshotWorkerRoot,
    "tools",
    "live-canary-worker.ts",
  );
  const snapshotBuildConfig = {
    name: "survey-qa-v2-visual-canary",
    main: expectedSourceEntrypoint,
    compatibility_date: "2026-08-01",
    compatibility_flags: [...PRODUCTION_MODULE_POLICY.compatibilityFlags],
    preserve_file_names: false,
    find_additional_modules: false,
    rules: PRODUCTION_MODULE_POLICY.rules.map((rule) => ({
      type: rule.type,
      globs: [...rule.globs],
      fallthrough: rule.fallthrough,
    })),
    assets: {
      directory: path.join(snapshotWorkerRoot, "public"),
      binding: "ASSETS",
    },
    vars: { CANARY_SOURCE_MANIFEST_SHA256: snapshot.manifestSha256 },
  };
  const snapshotBuildConfigPath = path.join(root, "snapshot-build.wrangler.jsonc");
  writeNewFile(snapshotBuildConfigPath, `${JSON.stringify(snapshotBuildConfig, null, 2)}\n`);

  const discovery = runPinnedDryRun({
    pinnedWrangler,
    root,
    cwd: snapshotWorkerRoot,
    configPath: snapshotBuildConfigPath,
    phaseDirectory: path.join(artifactRoot, "discovery"),
    includeMetafile: true,
  });
  const precommit = freezeCanaryBundlePrecommit({
    destination: path.join(artifactRoot, "bundle-precommit.json"),
    discoveryMetafilePath: discovery.metafilePath,
    snapshotDirectory: snapshot.snapshotDirectory,
    bundleWorkingDirectory: snapshotWorkerRoot,
    metafileBaseDirectory: root,
    dependencyRoot,
    repositoryRoot: root,
    buildArtifactDirectory: artifactRoot,
    expectedSourceEntrypoint,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  });
  assert.equal(precommit.manifest.sourceEntrypoint, "worker-v2/tools/live-canary-worker.ts");

  const audited = runPinnedDryRun({
    pinnedWrangler,
    root,
    cwd: snapshotWorkerRoot,
    configPath: snapshotBuildConfigPath,
    phaseDirectory: path.join(artifactRoot, "audited"),
    includeMetafile: true,
  });
  const reviewed = freezeReviewedCanaryBundle({
    destination: path.join(root, "reviewed-bundle"),
    modulePolicy: PRODUCTION_MODULE_POLICY,
    metafilePath: audited.metafilePath,
    bundlePrecommitPath: precommit.path,
    snapshotDirectory: snapshot.snapshotDirectory,
    bundleWorkingDirectory: snapshotWorkerRoot,
    metafileBaseDirectory: root,
    dependencyRoot,
    repositoryRoot: root,
    buildArtifactDirectory: artifactRoot,
    bundleOutputDirectory: audited.outputDirectory,
    wranglerLogPath: audited.logPath,
    expectedSourceEntrypoint,
    hardenDirectoryImpl: fixtureBoundaryAssertion,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  });
  assert.equal(reviewed.modules.length, 1);
  assert.equal(reviewed.modules[0].type, "Text");
  assert.equal(reviewed.manifest.entry.path.endsWith(".map"), false);
  assertReachableSourceMaps(reviewed.bundleInputsManifest);
  const reviewedFiles = [...inventoryFiles(reviewed.reviewedBundleDirectory)].sort();
  assert.deepEqual(reviewedFiles, [
    "bundle-inputs-manifest.json",
    reviewed.manifest.entry.path,
    reviewed.modules[0].path,
    "reviewed-bundle-manifest.json",
  ].sort());
  assert.equal(reviewedFiles.includes("README.md"), false);
  assert.equal(reviewedFiles.some((relative) => relative.endsWith(".map")), false);

  const projectionOptions = {
    snapshotDirectory: snapshot.snapshotDirectory,
    reviewedBundleDirectory: reviewed.reviewedBundleDirectory,
    expectedSourceManifestSha256: snapshot.manifestSha256,
    expectedReviewedBundleManifestSha256: reviewed.manifestSha256,
    repositoryRoot: root,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  };
  const missingSameTypeGlob = structuredClone(snapshotBuildConfig);
  assert.equal(missingSameTypeGlob.rules[0].type, "Text");
  missingSameTypeGlob.rules[0].globs = [];
  assert.throws(
    () => buildReviewedCanaryDeployConfig(missingSameTypeGlob, projectionOptions),
    (error) =>
      error?.code === "BUNDLE_MODULE_RULES_INVALID" ||
      /module policy differs/u.test(error?.message ?? ""),
    "mutation evidence: removing a same-type module glob must fail before the final dry-run",
  );

  const deployConfig = buildReviewedCanaryDeployConfig(
    snapshotBuildConfig,
    projectionOptions,
  );
  assert.equal(deployConfig.no_bundle, true);
  assert.equal(deployConfig.base_dir, reviewed.reviewedBundleDirectory.replaceAll("\\", "/"));
  assert.equal(deployConfig.main, reviewed.entryPath.replaceAll("\\", "/"));
  assert.equal(deployConfig.find_additional_modules, true);
  assert.equal(deployConfig.preserve_file_names, false);
  assert.deepEqual(deployConfig.rules, [{
    type: "Text",
    globs: [reviewed.modules[0].path],
    fallthrough: false,
  }]);
  const deployConfigPath = path.join(root, "reviewed-deploy.wrangler.jsonc");
  writeNewFile(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`);
  const replayToolState = path.join(root, "final-replay-tool-state");
  const replayScratch = path.join(replayToolState, "scratch");
  const replayUserProfile = path.join(replayToolState, "user-profile");
  const replayAppData = path.join(replayUserProfile, "AppData", "Roaming");
  const replayLocalAppData = path.join(replayUserProfile, "AppData", "Local");
  for (const directory of [
    replayScratch,
    replayAppData,
    replayLocalAppData,
  ]) mkdirSync(directory, { recursive: true });
  const deployConfigBytes = readFileSync(deployConfigPath);
  const deployConfigIdentity = Object.freeze({
    path: deployConfigPath,
    bytes: deployConfigBytes.length,
    sha256: sha256(deployConfigBytes),
  });
  const replayPhases = [];
  const replay = runFinalReviewedNoBundleReplayGate({
    repositoryRoot: root,
    buildArtifactDirectory: artifactRoot,
    snapshotDirectory: snapshot.snapshotDirectory,
    snapshotWorkerRoot,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    environment: {
      APPDATA: replayAppData,
      HOME: replayUserProfile,
      LOCALAPPDATA: replayLocalAppData,
      SystemRoot: "C:\\Windows",
      TEMP: replayScratch,
      TMP: replayScratch,
      USERPROFILE: replayUserProfile,
      WINDIR: "C:\\Windows",
    },
    verifyReplayInputs() {
      return pinnedWrangler;
    },
    hardenDirectoryImpl: fixtureBoundaryAssertion,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  }, {
    phaseObserver(phase) {
      replayPhases.push(phase);
    },
  });
  assert.deepEqual(replayPhases, ["final-reviewed-no-bundle-replay"]);
  assert.equal(replay.fileCount, reviewed.modules.length + 2);
  verifyFinalReviewedNoBundleReplayGate({
    replay,
    repositoryRoot: root,
    buildArtifactDirectory: artifactRoot,
    snapshotDirectory: snapshot.snapshotDirectory,
    reviewed,
    deployConfigIdentity,
    pinnedWrangler,
    assertPrivatePathImpl: fixtureBoundaryAssertion,
  });

  const expectedUploadFiles = [
    "README.md",
    reviewed.manifest.entry.path,
    ...reviewed.modules.map((module) => module.path),
  ].sort();
  const actualUploadFiles = [...inventoryFiles(replay.outputDirectory)].sort();
  assert.deepEqual(
    actualUploadFiles,
    expectedUploadFiles,
    "the no-bundle dry-run may contain only reviewed upload bytes plus Wrangler README.md",
  );
  assert.equal(actualUploadFiles.some((relative) => relative.endsWith(".map")), false);
  assert.equal(actualUploadFiles.some((relative) => relative.endsWith(".ts")), false);
  assert.equal(actualUploadFiles.includes("bundle-inputs-manifest.json"), false);
  assert.equal(actualUploadFiles.includes("reviewed-bundle-manifest.json"), false);

  for (const entry of [reviewed.manifest.entry, ...reviewed.modules]) {
    const reviewedPath = path.join(
      reviewed.reviewedBundleDirectory,
      ...entry.path.split("/"),
    );
    const replayPath = path.join(replay.outputDirectory, ...entry.path.split("/"));
    assert.deepEqual(readFileSync(replayPath), readFileSync(reviewedPath), entry.path);
    assert.equal(readFileSync(replayPath).length, entry.bytes, entry.path);
    assert.equal(sha256(readFileSync(replayPath)), entry.sha256, entry.path);
    if (Object.hasOwn(entry, "type")) {
      const matchingRules = deployConfig.rules.filter((rule) =>
        rule.type === entry.type && rule.globs.includes(entry.path));
      assert.equal(matchingRules.length, 1, `${entry.path} must have one exact type rule`);
    }
  }
  assertWranglerReadme(path.join(replay.outputDirectory, "README.md"));
}

function pinnedWranglerDescriptor() {
  if (cachedPinnedWrangler !== undefined) return cachedPinnedWrangler;
  cachedPinnedWrangler = inspectPinnedWranglerPackage(WRANGLER_PACKAGE_JSON, {
    trustedRoot: REPOSITORY_ROOT,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      execPath: process.execPath,
      execArgv: [],
      environment: {},
    },
  });
  assert.equal(cachedPinnedWrangler.version, EXPECTED_WRANGLER_VERSION);
  assert.equal(cachedPinnedWrangler.version, "4.106.0");
  return cachedPinnedWrangler;
}

function runPinnedDryRun({
  pinnedWrangler,
  root,
  cwd,
  configPath,
  phaseDirectory,
  includeMetafile,
}) {
  mkdirSync(phaseDirectory, { recursive: false });
  const outputDirectory = path.join(phaseDirectory, "explicit-outdir");
  const toolStateDirectory = path.join(phaseDirectory, "tool-state");
  const scratchDirectory = path.join(toolStateDirectory, "scratch");
  const userProfile = path.join(toolStateDirectory, "user-profile");
  const appData = path.join(userProfile, "AppData", "Roaming");
  const localAppData = path.join(userProfile, "AppData", "Local");
  const metafilePath = path.join(phaseDirectory, "wrangler-metafile.json");
  const logPath = path.join(phaseDirectory, "wrangler.log");
  for (const directory of [
    outputDirectory,
    scratchDirectory,
    appData,
    localAppData,
  ]) mkdirSync(directory, { recursive: true });
  assert.equal(inventoryFiles(outputDirectory).size, 0, "the dry-run outdir must start empty");

  const before = inventoryFiles(root);
  const childEnvironment = buildPinnedDeployEnvironment({
    APPDATA: appData,
    HOME: userProfile,
    LOCALAPPDATA: localAppData,
    SystemRoot: "C:\\Windows",
    TEMP: scratchDirectory,
    TMP: scratchDirectory,
    USERPROFILE: userProfile,
    WINDIR: "C:\\Windows",
  }, logPath);
  const args = [
    ...pinnedWrangler.argsPrefix,
    "deploy",
    "--dry-run",
    "--strict",
    "--outdir",
    outputDirectory,
  ];
  if (includeMetafile) args.push("--metafile", metafilePath);
  args.push("--config", configPath);
  const child = spawnSync(pinnedWrangler.command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_WRANGLER_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `Wrangler terminated by ${child.signal ?? "an unknown signal"}`);
  assert.equal(child.status, 0, boundedFailureText(child));
  assertRegularExactFile(logPath);
  if (includeMetafile) assertRegularExactFile(metafilePath);

  const after = inventoryFiles(root);
  const exactSiblingArtifacts = new Set([
    portableRelative(root, logPath),
    ...(includeMetafile ? [portableRelative(root, metafilePath)] : []),
  ]);
  for (const relative of [...after].filter((candidate) => !before.has(candidate))) {
    const absolute = path.resolve(root, ...relative.split("/"));
    assert.equal(
      exactSiblingArtifacts.has(relative) ||
        isWithin(absolute, outputDirectory) ||
        isWithin(absolute, toolStateDirectory),
      true,
      `pinned Wrangler materialized an undeclared dry-run file: ${relative}`,
    );
  }
  return {
    logPath,
    metafilePath: includeMetafile ? metafilePath : undefined,
    outputDirectory,
    toolStateDirectory,
  };
}

function createFixtureBoundaryAssertion(root) {
  return function assertFixtureBoundary(target, repositoryRoot, options = {}) {
    assert.equal(samePath(repositoryRoot, root), true, "fixture adapter repository mismatch");
    const resolved = path.resolve(target);
    assert.equal(isWithin(resolved, root), true, "fixture adapter path escaped its private root");
    const metadata = lstatSync(resolved);
    assert.equal(metadata.isSymbolicLink(), false, `fixture adapter refuses a link: ${resolved}`);
    const directory = options.directory ?? metadata.isDirectory();
    assert.equal(
      directory ? metadata.isDirectory() : metadata.isFile(),
      true,
      `fixture adapter path has the wrong type: ${resolved}`,
    );
    assert.equal(samePath(realpathSync(resolved), resolved), true, "fixture path is not exact");
  };
}

function writeNewFile(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
}

function assertWranglerReadme(readmePath) {
  assertRegularExactFile(readmePath);
  const bytes = readFileSync(readmePath);
  assert.ok(bytes.length > 1);
  assert.equal(bytes.at(-1), ".".charCodeAt(0));
  assert.notEqual(bytes.at(-1), "\n".charCodeAt(0));
  assert.notEqual(bytes.at(-1), "\r".charCodeAt(0));
  assert.match(
    bytes.toString("utf8"),
    /^This folder contains the built output assets for the worker "[a-z0-9-]+" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/u,
  );
}

function assertReachableSourceMaps(bundleInputsManifest) {
  const outputs = new Map(bundleInputsManifest.outputs.map((output) => [output.path, output]));
  const pending = [bundleInputsManifest.selection.entry.path];
  const reachable = new Set();
  while (pending.length > 0) {
    const outputPath = pending.shift();
    if (reachable.has(outputPath)) continue;
    const output = outputs.get(outputPath);
    assert.notEqual(output, undefined, `reachable output is undeclared: ${outputPath}`);
    reachable.add(outputPath);
    for (const edge of output.imports) {
      if (edge.external !== true && edge.target !== undefined) pending.push(edge.target.path);
    }
  }
  assert.ok(reachable.size > 0, "the source-map denominator cannot be empty");
  for (const outputPath of reachable) {
    assert.match(outputPath, /\.(?:m?js)$/u);
    const sourceMap = outputs.get(`${outputPath}.map`);
    assert.notEqual(sourceMap, undefined, `missing declared source map for ${outputPath}`);
    assert.equal(sourceMap.entryPoint, undefined);
    assert.equal(sourceMap.cssBundle, undefined);
    assert.deepEqual(sourceMap.imports, []);
    assert.deepEqual(sourceMap.exports, []);
    assert.deepEqual(sourceMap.inputContributions, []);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runPinnedBuild({ pinnedWrangler, cssText, roots }) {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_BASE, FIXTURE_PREFIX));
  roots.push(root);
  hardenPrivateLocalDirectory(root, REPOSITORY_ROOT);
  assertPrivateLocalPath(root, REPOSITORY_ROOT, { directory: true });

  const sourceRoot = path.join(root, "source");
  const entrySourcePath = path.join(sourceRoot, "worker", "tools", "index.ts");
  const transitiveSourcePath = path.join(sourceRoot, "worker", "src", "report", "render.ts");
  const cssSourcePath = path.join(sourceRoot, "assets", "report.css");
  // The depth is deliberate: if pinned Wrangler retained the source's ../../../ escape, the
  // resulting write would leave the outdir but stay inside this fixture root and its census.
  const artifactRoot = path.join(root, "artifacts", "build", "output");
  const outputDirectory = path.join(artifactRoot, "explicit-outdir");
  const metafilePath = path.join(artifactRoot, "wrangler-metafile.json");
  const logPath = path.join(artifactRoot, "wrangler.log");
  // Wrangler materializes local metrics state even when transmission is disabled. Keep it in
  // one separately censused tool-state sibling so the explicit outdir remains upload evidence.
  const toolStateDirectory = path.join(artifactRoot, "tool-state");
  const scratchDirectory = path.join(toolStateDirectory, "scratch");
  const userProfile = path.join(toolStateDirectory, "user-profile");
  const appData = path.join(userProfile, "AppData", "Roaming");
  const localAppData = path.join(userProfile, "AppData", "Local");
  const configPath = path.join(root, "wrangler.jsonc");

  for (const directory of [
    path.dirname(entrySourcePath),
    path.dirname(transitiveSourcePath),
    path.dirname(cssSourcePath),
    outputDirectory,
    scratchDirectory,
    appData,
    localAppData,
  ]) mkdirSync(directory, { recursive: true });

  writeFileSync(entrySourcePath, [
    'import { reportCss } from "../src/report/render.ts";',
    "export default {",
    "  fetch() {",
    '    return new Response(reportCss, { headers: { "content-type": "text/css" } });',
    "  },",
    "};",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });
  writeFileSync(transitiveSourcePath, [
    `import reportCss from ${JSON.stringify(SOURCE_EXTERNAL_SPECIFIER)};`,
    "export { reportCss };",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });
  const cssBytes = Buffer.from(cssText, "utf8");
  writeFileSync(cssSourcePath, cssBytes, { flag: "wx" });
  const wranglerConfig = {
    name: "survey-qa-pinned-wrangler-output-fixture",
    main: portableRelative(root, entrySourcePath),
    compatibility_date: "2026-08-01",
    upload_source_maps: false,
    preserve_file_names: false,
    rules: [
      { type: "Text", globs: ["**/*.css"], fallthrough: false },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  const before = inventoryFiles(root);
  const childEnvironment = buildPinnedDeployEnvironment({
    APPDATA: appData,
    HOME: userProfile,
    LOCALAPPDATA: localAppData,
    SystemRoot: "C:\\Windows",
    TEMP: scratchDirectory,
    TMP: scratchDirectory,
    USERPROFILE: userProfile,
    WINDIR: "C:\\Windows",
  }, logPath);
  const child = spawnSync(pinnedWrangler.command, [
    ...pinnedWrangler.argsPrefix,
    "deploy",
    "--dry-run",
    "--strict",
    "--outdir",
    outputDirectory,
    "--metafile",
    metafilePath,
    "--config",
    configPath,
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_WRANGLER_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `Wrangler terminated by ${child.signal ?? "an unknown signal"}`);
  assert.equal(child.status, 0, boundedFailureText(child));

  assertPrivateLocalPath(metafilePath, REPOSITORY_ROOT);
  if (fileExists(logPath)) assertPrivateLocalPath(logPath, REPOSITORY_ROOT);
  const after = inventoryFiles(root);
  const added = [...after].filter((relative) => !before.has(relative));
  assert.ok(added.length >= 2, "Wrangler must materialize a metafile and bundle output");
  const allowedSiblingArtifacts = new Set([
    portableRelative(root, metafilePath),
    portableRelative(root, logPath),
  ]);
  for (const relative of added) {
    const absolute = path.resolve(root, ...relative.split("/"));
    assert.equal(
      allowedSiblingArtifacts.has(relative) ||
        isWithin(absolute, outputDirectory) ||
        isWithin(absolute, toolStateDirectory),
      true,
      `Wrangler materialized an undeclared file outside the explicit outdir: ${relative}`,
    );
  }
  assert.equal(after.has(portableRelative(root, metafilePath)), true);

  const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
  assert.equal(isRecord(metafile.outputs), true, "Wrangler metafile must contain an output map");
  const readmePath = path.join(outputDirectory, "README.md");
  assertRegularExactFile(readmePath);
  const readmeBytes = readFileSync(readmePath);
  assert.ok(readmeBytes.length > 1);
  assert.equal(readmeBytes.at(-1), ".".charCodeAt(0));
  assert.notEqual(readmeBytes.at(-1), "\n".charCodeAt(0));
  assert.notEqual(readmeBytes.at(-1), "\r".charCodeAt(0));
  assert.match(
    readmeBytes.toString("utf8"),
    /^This folder contains the built output assets for the worker "survey-qa-pinned-wrangler-output-fixture" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/u,
  );
  assert.equal(
    Object.keys(metafile.outputs).some((outputName) =>
      samePath(resolveMetafilePath(root, outputName), readmePath)),
    false,
    "README.md is an output-local Wrangler byproduct, not a metafile-declared output",
  );
  const entryOutputs = Object.entries(metafile.outputs).filter(([, descriptor]) => {
    if (!isRecord(descriptor) || typeof descriptor.entryPoint !== "string") return false;
    return samePath(resolveMetafilePath(root, descriptor.entryPoint), entrySourcePath);
  });
  assert.equal(entryOutputs.length, 1, "the real metafile must identify exactly one source entrypoint");
  const [entryOutputName, entryDescriptor] = entryOutputs[0];
  const entryOutputPath = resolveMetafilePath(root, entryOutputName);
  assert.equal(isWithin(entryOutputPath, outputDirectory), true);
  assertRegularExactFile(entryOutputPath);
  const preservedEscapeTarget = path.resolve(
    path.dirname(entryOutputPath),
    ...SOURCE_EXTERNAL_SPECIFIER.split("/"),
  );
  assert.equal(isWithin(preservedEscapeTarget, root), true);
  assert.equal(isWithin(preservedEscapeTarget, outputDirectory), false);
  assert.equal(
    pathExists(preservedEscapeTarget),
    false,
    "the exact preserved-path counterfactual must not be materialized outside the outdir",
  );

  const localExternalEdges = Array.isArray(entryDescriptor.imports)
    ? entryDescriptor.imports.filter((edge) =>
      isRecord(edge) &&
      edge.external === true &&
      edge.kind === "import-statement" &&
      typeof edge.path === "string" &&
      edge.path.startsWith("."))
    : [];
  assert.equal(
    localExternalEdges.length,
    1,
    "the bundled entry must retain exactly one graph-visible external Text module",
  );
  const externalSpecifier = localExternalEdges[0].path;
  assert.match(externalSpecifier, /^\.\/[0-9a-f]{40}-[^/\\]+\.css$/u);
  assert.equal(externalSpecifier.includes("\\"), false);
  assert.notEqual(externalSpecifier, SOURCE_EXTERNAL_SPECIFIER);
  assert.deepEqual(Object.keys(localExternalEdges[0]).sort(), ["external", "kind", "path"]);
  assert.equal(
    Object.hasOwn(localExternalEdges[0], "original"),
    false,
    "the output edge records runtime resolution, not source provenance",
  );

  assert.equal(isRecord(metafile.inputs), true, "Wrangler metafile must contain an input map");
  const transitiveInputs = Object.entries(metafile.inputs).filter(([inputName]) =>
    samePath(resolveMetafilePath(root, inputName), transitiveSourcePath));
  assert.equal(transitiveInputs.length, 1, "the transitive source must have one input descriptor");
  const [, transitiveDescriptor] = transitiveInputs[0];
  const rewrittenInputEdges = Array.isArray(transitiveDescriptor.imports)
    ? transitiveDescriptor.imports.filter((edge) =>
      isRecord(edge) &&
      edge.external === true &&
      edge.kind === "import-statement" &&
      edge.path === externalSpecifier)
    : [];
  assert.equal(
    rewrittenInputEdges.length,
    1,
    "the identified transitive input must point to the same rewritten external module",
  );
  assert.deepEqual(Object.keys(rewrittenInputEdges[0]).sort(), ["external", "kind", "path"]);
  assert.equal(
    Object.hasOwn(rewrittenInputEdges[0], "original"),
    false,
    "pinned Wrangler does not retain the source-relative spelling in the input edge",
  );
  const externalModulePath = path.resolve(
    path.dirname(entryOutputPath),
    ...externalSpecifier.split("/"),
  );
  assert.equal(
    isWithin(externalModulePath, outputDirectory),
    true,
    "the rewritten external edge must resolve inside the explicit outdir",
  );
  assertRegularExactFile(externalModulePath);
  assert.deepEqual(readFileSync(externalModulePath), cssBytes);
  assert.equal(
    readFileSync(entryOutputPath, "utf8").includes(SOURCE_EXTERNAL_SPECIFIER),
    false,
    "the dangerous source-relative escape must not survive in emitted JavaScript",
  );
  const cssSha1 = assertContentAddress({
    modulePath: externalModulePath,
    sourcePath: cssSourcePath,
    expectedBytes: cssBytes,
  });

  const expectedReleaseFiles = [
    "README.md",
    portableRelative(outputDirectory, entryOutputPath),
    portableRelative(outputDirectory, externalModulePath),
  ].sort();
  assert.deepEqual(
    [...inventoryFiles(outputDirectory)].sort(),
    expectedReleaseFiles,
    "upload_source_maps:false must emit exactly the local JS/README/hashed-CSS audit set",
  );
  assertSourceMapReleasePolicy(wranglerConfig, expectedReleaseFiles);

  const versionsOutputDirectory = path.join(artifactRoot, "versions-upload-outdir");
  mkdirSync(versionsOutputDirectory, { recursive: false });
  const versionsChild = spawnSync(pinnedWrangler.command, [
    ...pinnedWrangler.argsPrefix,
    "versions",
    "upload",
    "--dry-run",
    "--strict",
    "--outdir",
    versionsOutputDirectory,
    "--config",
    configPath,
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: MAX_WRANGLER_OUTPUT_BYTES,
    killSignal: "SIGTERM",
    env: childEnvironment,
  });
  assert.equal(versionsChild.error, undefined, versionsChild.error?.message);
  assert.equal(
    versionsChild.signal,
    null,
    `Wrangler versions upload terminated by ${versionsChild.signal ?? "an unknown signal"}`,
  );
  assert.equal(versionsChild.status, 0, boundedFailureText(versionsChild));
  const versionsFiles = [...inventoryFiles(versionsOutputDirectory)].sort();
  assert.deepEqual(
    versionsFiles,
    expectedReleaseFiles,
    "upload_source_maps:false must give deploy and versions-upload identical fresh censuses",
  );
  assertSourceMapReleasePolicy(wranglerConfig, versionsFiles);
  assertWranglerReadme(path.join(versionsOutputDirectory, "README.md"));
  for (const relative of expectedReleaseFiles.filter((candidate) => candidate !== "README.md")) {
    assert.deepEqual(
      readFileSync(path.join(versionsOutputDirectory, ...relative.split("/"))),
      readFileSync(path.join(outputDirectory, ...relative.split("/"))),
      relative,
    );
  }

  for (const relative of added) {
    const absolute = path.resolve(root, ...relative.split("/"));
    assertPrivateLocalPath(absolute, REPOSITORY_ROOT);
  }
  return {
    cssBytes,
    cssSha1,
    cssSourcePath,
    externalModulePath,
    externalSpecifier,
    releaseFiles: expectedReleaseFiles,
  };
}

function assertSourceMapReleasePolicy(config, files) {
  if (!Object.hasOwn(config, "upload_source_maps") || config.upload_source_maps !== false) {
    throw new Error("release config must declare upload_source_maps as exact boolean false");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("release output census must be nonempty");
  }
  if (files.some((relative) => relative.endsWith(".map"))) {
    throw new Error("release output census must contain zero source maps");
  }
}

function assertContentAddress({ modulePath, sourcePath, expectedBytes }) {
  const digest = createHash("sha1").update(expectedBytes).digest("hex");
  const expectedName = `${digest}-${path.basename(sourcePath)}`;
  if (
    path.basename(modulePath) !== expectedName ||
    !readFileSync(modulePath).equals(expectedBytes)
  ) {
    const error = new Error("Wrangler Text module does not match its source-derived content address");
    error.code = "WRANGLER_TEXT_CONTENT_ADDRESS_MISMATCH";
    throw error;
  }
  return digest;
}

function inventoryFiles(root) {
  const files = new Set();
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = lstatSync(absolute);
      assert.equal(metadata.isSymbolicLink(), false, `fixture contains a link: ${absolute}`);
      if (metadata.isDirectory()) {
        pending.push(absolute);
      } else {
        assert.equal(metadata.isFile(), true, `fixture contains a non-regular path: ${absolute}`);
        files.add(portableRelative(root, absolute));
      }
    }
  }
  return files;
}

function resolveMetafilePath(baseDirectory, value) {
  assert.equal(typeof value, "string");
  assert.notEqual(value.length, 0);
  assert.equal(value.includes("\\"), false, `metafile path is not portable: ${value}`);
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(baseDirectory, ...value.split("/"));
}

function assertRegularExactFile(file) {
  const metadata = lstatSync(file);
  assert.equal(metadata.isFile(), true, `expected a regular file: ${file}`);
  assert.equal(metadata.isSymbolicLink(), false, `expected no symbolic link: ${file}`);
  assert.equal(samePath(realpathSync(file), file), true, `file path is not canonical: ${file}`);
}

function portableRelative(from, to) {
  const relative = path.relative(path.resolve(from), path.resolve(to));
  assert.notEqual(relative, "");
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
  return relative.split(path.sep).join("/");
}

function isWithin(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fileExists(file) {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function pathExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function boundedFailureText(child) {
  return `${child.stderr ?? ""}\n${child.stdout ?? ""}`.slice(0, 8_192);
}

function removeFixtureRoot(root) {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(FIXTURE_BASE), resolved);
  assert.equal(path.basename(resolved).startsWith(FIXTURE_PREFIX), true);
  assert.equal(relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relative), false);
  const metadata = lstatSync(resolved);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(samePath(realpathSync(resolved), resolved), true);
  assertLinkFreeRemovalTree(resolved);
  rmSync(resolved, { recursive: true, force: false });
}

function assertLinkFreeRemovalTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryMetadata = lstatSync(directory);
    assert.equal(directoryMetadata.isDirectory(), true, `cleanup target is not a directory: ${directory}`);
    assert.equal(directoryMetadata.isSymbolicLink(), false, `cleanup target is linked: ${directory}`);
    assert.equal(samePath(realpathSync(directory), directory), true, `cleanup directory is not exact: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = lstatSync(absolute);
      assert.equal(metadata.isSymbolicLink(), false, `cleanup refuses a linked child: ${absolute}`);
      if (metadata.isDirectory()) pending.push(absolute);
    }
  }
}
