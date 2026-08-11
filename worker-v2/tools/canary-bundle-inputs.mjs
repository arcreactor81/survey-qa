import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import ts from "./verified-typescript.mjs";
import {
  assertPrivateLocalPath,
  hardenPrivateLocalDirectory,
} from "./private-local-output.mjs";
import {
  CANARY_SOURCE_SNAPSHOT_SCHEMA_VERSION,
  verifyCanarySourceSnapshot,
} from "./canary-source-snapshot.mjs";

export const CANARY_BUNDLE_INPUTS_SCHEMA_VERSION =
  "survey-qa-canary-bundle-inputs/1.2.0";
export const CANARY_BUNDLE_PRECOMMIT_SCHEMA_VERSION =
  "survey-qa-canary-bundle-precommit/1.0.0";
export const CANARY_REVIEWED_BUNDLE_SCHEMA_VERSION =
  "survey-qa-canary-reviewed-bundle/1.2.0";

const MAX_METAFILE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const BUILTIN_PREFIX = "node-built-in-modules:";
const BUNDLE_INPUTS_MANIFEST_NAME = "bundle-inputs-manifest.json";
const REVIEWED_BUNDLE_MANIFEST_NAME = "reviewed-bundle-manifest.json";
const LOCKFILE_RELATIVE_PATH = "package-lock.json";
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MODULE_TYPES = new Set(["Text", "Data", "CompiledWasm", "ESModule", "CommonJS"]);
const SOURCE_MODULE_TYPES = new Set(["Text", "Data", "CompiledWasm"]);
const RUNTIME_EXTERNALS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`),
  "cloudflare:workers",
]);

export class CanaryBundleInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanaryBundleInputError";
    this.code = code;
  }
}

/**
 * Seal the exact candidate module graph discovered by a first, non-deployable build.
 *
 * The discovery build is deliberately not trusted as deploy output. It is used only to find the
 * dependency closure which must be byte-committed before a separate audited build. The sealed
 * package-lock from the source snapshot independently bounds every installed package root.
 * Relative metafile names are resolved only from the explicitly supplied Wrangler-config base;
 * falling back to the process cwd or bundle cwd would silently reinterpret the graph.
 */
export function freezeCanaryBundlePrecommit({
  destination,
  discoveryMetafilePath,
  snapshotDirectory,
  bundleWorkingDirectory,
  metafileBaseDirectory,
  dependencyRoot,
  repositoryRoot,
  buildArtifactDirectory,
  expectedSourceEntrypoint,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const context = prepareInputContext({
    snapshotDirectory,
    bundleWorkingDirectory,
    metafileBaseDirectory,
    dependencyRoot,
    repositoryRoot,
    buildArtifactDirectory,
    expectedSourceEntrypoint,
    assertPrivatePathImpl,
  });
  const discoveryMetafile = exactFileWithin(
    discoveryMetafilePath,
    context.artifacts,
    "DISCOVERY_METAFILE_INVALID",
  );
  assertPrivatePathImpl(discoveryMetafile, context.repository);
  const target = requireNewFilePath(
    destination,
    context.artifacts,
    "BUNDLE_PRECOMMIT",
  );
  const discovery = readMetafile(discoveryMetafile, "DISCOVERY_METAFILE_INVALID");
  const lockfile = readLockfileContract(context);
  const graph = inspectMetafileInputs(discovery.value, context, lockfile.packageRoots);
  const manifest = {
    schemaVersion: CANARY_BUNDLE_PRECOMMIT_SCHEMA_VERSION,
    sourceManifestSha256: context.snapshotVerification.manifestSha256,
    lockfilePath: LOCKFILE_RELATIVE_PATH,
    lockfileSha256: lockfile.sha256,
    discoveryMetafileSha256: discovery.sha256,
    sourceEntrypoint: context.expectedEntrypointRelative,
    builtins: graph.builtins,
    inputs: graph.inputs,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  writeExclusiveDurableFile(target, bytes, "BUNDLE_PRECOMMIT_WRITE_FAILED");
  assertPrivatePathImpl(target, context.repository);

  // Re-read every candidate after the durable commitment write. A dependency that changes while
  // the commitment is being made cannot become the baseline for the audited build by accident.
  const after = inspectMetafileInputs(discovery.value, context, lockfile.packageRoots);
  if (canonicalJson(after) !== canonicalJson(graph)) {
    throw new CanaryBundleInputError(
      "BUNDLE_PRECOMMIT_INPUT_CHANGED",
      "a source or dependency changed while the pre-build commitment was written",
    );
  }
  const persisted = parseBundlePrecommitManifest(
    readBoundedFile(target, MAX_METAFILE_BYTES, "BUNDLE_PRECOMMIT_INVALID"),
  );
  if (canonicalJson(persisted) !== canonicalJson(manifest)) {
    throw new CanaryBundleInputError(
      "BUNDLE_PRECOMMIT_WRITE_FAILED",
      "the persisted pre-build commitment differs from the reviewed bytes",
    );
  }
  return deepFreeze({
    path: target,
    manifest,
    manifestBytes: bytes,
    manifestSha256: sha256(bytes),
    inputCount: graph.inputs.length,
    dependencyInputCount: graph.inputs.filter((entry) => entry.kind === "dependency").length,
    builtinCount: graph.builtins.length,
  });
}

/**
 * Bind every local file Wrangler/esbuild says it consumed. Repository source must come from the
 * verified snapshot; third-party code may come only from the explicitly named node_modules root
 * and is hashed into this second manifest. Virtual inputs are refused except Node built-ins.
 * The same explicit metafile base resolves both input and output inventory names.
 */
export function verifyCanaryBundleInputs({
  metafilePath,
  bundlePrecommitPath,
  snapshotDirectory,
  bundleWorkingDirectory,
  metafileBaseDirectory,
  dependencyRoot,
  repositoryRoot,
  buildArtifactDirectory,
  bundleOutputDirectory,
  wranglerLogPath,
  expectedSourceEntrypoint,
  modulePolicy,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const context = prepareInputContext({
    snapshotDirectory,
    bundleWorkingDirectory,
    metafileBaseDirectory,
    dependencyRoot,
    repositoryRoot,
    buildArtifactDirectory,
    expectedSourceEntrypoint,
    assertPrivatePathImpl,
  });
  const output = exactDirectory(bundleOutputDirectory, "BUNDLE_OUTPUT_INVALID");
  requireStrictlyWithin(output, context.artifacts, "BUNDLE_OUTPUT_OUTSIDE_ARTIFACT_ROOT");
  const metafile = exactFileWithin(metafilePath, context.artifacts, "BUNDLE_METAFILE_INVALID");
  const precommitFile = exactFileWithin(
    bundlePrecommitPath,
    context.artifacts,
    "BUNDLE_PRECOMMIT_INVALID",
  );
  const log = exactFileWithin(wranglerLogPath, context.artifacts, "WRANGLER_LOG_INVALID");
  assertPrivatePathImpl(output, context.repository, { directory: true });
  assertPrivatePathImpl(metafile, context.repository);
  assertPrivatePathImpl(precommitFile, context.repository);
  assertPrivatePathImpl(log, context.repository);

  const precommitBytes = readBoundedFile(
    precommitFile,
    MAX_METAFILE_BYTES,
    "BUNDLE_PRECOMMIT_INVALID",
  );
  const precommit = parseBundlePrecommitManifest(precommitBytes);
  const lockfile = readLockfileContract(context);
  if (
    precommit.sourceManifestSha256 !== context.snapshotVerification.manifestSha256 ||
    precommit.lockfileSha256 !== lockfile.sha256 ||
    precommit.sourceEntrypoint !== context.expectedEntrypointRelative
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_PRECOMMIT_IDENTITY_MISMATCH",
      "the pre-build commitment is not bound to this source snapshot and lockfile",
    );
  }

  const auditedMetafile = readMetafile(metafile, "BUNDLE_METAFILE_INVALID");
  const graph = inspectMetafileInputs(auditedMetafile.value, context, lockfile.packageRoots);
  if (
    canonicalJson(graph.inputs) !== canonicalJson(precommit.inputs) ||
    canonicalJson(graph.builtins) !== canonicalJson(precommit.builtins)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_PRECOMMIT_GRAPH_MISMATCH",
      "the audited build consumed a different source, dependency, or builtin graph than was precommitted",
    );
  }
  const normalizedPolicy = normalizeBundleModulePolicy(modulePolicy);
  const sourceModules = inspectSourceModuleReferences(
    auditedMetafile.value,
    context,
    graph,
    normalizedPolicy.rules,
  );
  const outputGraph = inspectMetafileOutputs(
    auditedMetafile.value,
    context,
    output,
    graph,
    sourceModules,
  );

  // Hash the same dependency closure once more after output inspection. This catches ordinary
  // mutation during the audited build/verification window. It cannot defeat a privileged actor
  // that swaps bytes for Wrangler and restores them between observations; that residual race is
  // intentionally not claimed as provenance.
  const after = inspectMetafileInputs(auditedMetafile.value, context, lockfile.packageRoots);
  if (canonicalJson(after) !== canonicalJson(graph)) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUT_CHANGED_DURING_VERIFICATION",
      "a source or dependency changed while audited outputs were verified",
    );
  }

  const manifest = {
    schemaVersion: CANARY_BUNDLE_INPUTS_SCHEMA_VERSION,
    sourceManifestSha256: context.snapshotVerification.manifestSha256,
    lockfileSha256: lockfile.sha256,
    precommitSha256: sha256(precommitBytes),
    discoveryMetafileSha256: precommit.discoveryMetafileSha256,
    metafileSha256: auditedMetafile.sha256,
    sourceEntrypoint: context.expectedEntrypointRelative,
    builtins: graph.builtins,
    inputs: graph.inputs,
    modulePolicy: normalizedPolicy,
    modulePolicySha256: sha256(Buffer.from(canonicalJson(normalizedPolicy))),
    sourceModules,
    outputs: outputGraph.outputs,
    rawFiles: outputGraph.rawFiles,
    selection: outputGraph.selection,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  return deepFreeze({
    manifest,
    manifestBytes: bytes,
    manifestSha256: sha256(bytes),
    precommitManifestSha256: sha256(precommitBytes),
    inputCount: graph.inputs.length,
    dependencyInputCount: graph.inputs.filter((entry) => entry.kind === "dependency").length,
    builtinCount: graph.builtins.length,
    outputCount: outputGraph.outputs.length,
    rawFileCount: outputGraph.rawFiles.length,
  });
}

/**
 * Copy only the reviewed entry module and explicitly typed additional modules out of Wrangler's
 * raw output into a new private directory. Build by-products (README, sourcemaps, or unexpected
 * files) never enter the deploy boundary merely because Wrangler happened to emit them.
 */
export function freezeReviewedCanaryBundle({
  destination,
  modulePolicy,
  hardenDirectoryImpl = hardenPrivateLocalDirectory,
  assertPrivatePathImpl = assertPrivateLocalPath,
  ...bundleInputOptions
} = {}) {
  const verifiedInputs = verifyCanaryBundleInputs({
    ...bundleInputOptions,
    modulePolicy,
    assertPrivatePathImpl,
  });
  const repository = exactDirectory(bundleInputOptions.repositoryRoot, "REPOSITORY_ROOT_INVALID");
  const source = exactDirectory(bundleInputOptions.bundleOutputDirectory, "BUNDLE_OUTPUT_INVALID");
  const target = requireNewDirectory(destination, repository, "REVIEWED_BUNDLE");
  if (
    isWithinOrEqual(target, source) ||
    isWithinOrEqual(source, target) ||
    isWithinOrEqual(target, bundleInputOptions.snapshotDirectory) ||
    isWithinOrEqual(bundleInputOptions.snapshotDirectory, target)
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_BOUNDARY_OVERLAP",
      "the reviewed deploy bundle must be separate from raw output and the source snapshot",
    );
  }

  const selected = [
    { ...verifiedInputs.manifest.selection.entry, role: "entry" },
    ...verifiedInputs.manifest.selection.modules.map((module) => ({
      ...module,
      role: "additional-module",
    })),
  ];
  const sourceIdentities = selected.map((entry) => ({
    ...entry,
    ...regularFileIdentity(path.join(source, ...entry.path.split("/")), source, "REVIEWED_SOURCE_INVALID"),
  }));
  bindReviewedSelectionToOutputInventory(
    sourceIdentities,
    verifiedInputs.manifest,
    verifiedInputs.manifest.sourceEntrypoint,
  );
  for (const entry of sourceIdentities) {
    assertPrivatePathImpl(path.join(source, ...entry.path.split("/")), repository);
  }

  mkdirSync(target, { recursive: false, mode: 0o700 });
  hardenDirectoryImpl(target, repository);
  assertPrivatePathImpl(target, repository, { directory: true });
  for (const entry of sourceIdentities) {
    const sourcePath = path.join(source, ...entry.path.split("/"));
    const bytes = readBoundedFile(sourcePath, MAX_INPUT_BYTES, "REVIEWED_SOURCE_INVALID");
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new CanaryBundleInputError(
        "REVIEWED_SOURCE_CHANGED",
        "a selected Wrangler output changed while the reviewed bundle was frozen",
      );
    }
    const outputPath = path.join(target, ...entry.path.split("/"));
    mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    writeFileSync(outputPath, bytes, { flag: "wx", mode: 0o600 });
  }

  const inputsManifestPath = path.join(target, BUNDLE_INPUTS_MANIFEST_NAME);
  writeFileSync(inputsManifestPath, verifiedInputs.manifestBytes, { flag: "wx", mode: 0o600 });
  const manifest = {
    schemaVersion: CANARY_REVIEWED_BUNDLE_SCHEMA_VERSION,
    sourceManifestSha256: verifiedInputs.manifest.sourceManifestSha256,
    bundleInputsManifestSha256: verifiedInputs.manifestSha256,
    bundlePrecommitManifestSha256: verifiedInputs.manifest.precommitSha256,
    metafileSha256: verifiedInputs.manifest.metafileSha256,
    entry: identityProjection(sourceIdentities[0]),
    modules: sourceIdentities.slice(1).map(reviewedIdentityProjection),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const manifestPath = path.join(target, REVIEWED_BUNDLE_MANIFEST_NAME);
  writeFileSync(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });

  // Re-read both the raw selected bytes and the finished destination. This is the negative edge
  // that kills a mutation between selection and copy instead of merely attesting the first read.
  for (const entry of sourceIdentities) {
    const after = regularFileIdentity(
      path.join(source, ...entry.path.split("/")),
      source,
      "REVIEWED_SOURCE_INVALID",
    );
    if (after.bytes !== entry.bytes || after.sha256 !== entry.sha256) {
      throw new CanaryBundleInputError(
        "REVIEWED_SOURCE_CHANGED",
        "a selected Wrangler output changed while the reviewed bundle was frozen",
      );
    }
  }
  const rawAfter = inspectRawOutputInventory({
    outputRoot: source,
    outputs: verifiedInputs.manifest.outputs,
    selection: verifiedInputs.manifest.selection,
  });
  if (canonicalJson(rawAfter) !== canonicalJson(verifiedInputs.manifest.rawFiles)) {
    throw new CanaryBundleInputError(
      "BUNDLE_RAW_OUTPUT_CHANGED",
      "Wrangler's raw output changed while the reviewed bundle was frozen",
    );
  }
  const reviewed = verifyReviewedCanaryBundle({
    reviewedBundleDirectory: target,
    snapshotDirectory: bundleInputOptions.snapshotDirectory,
    repositoryRoot: repository,
    assertPrivatePathImpl,
  });
  return Object.freeze({
    ...reviewed,
    bundleInputs: verifiedInputs,
  });
}

/** Verify the exact no-bundle entry/module set and its linkage to the still-valid source snapshot. */
export function verifyReviewedCanaryBundle({
  reviewedBundleDirectory,
  snapshotDirectory,
  repositoryRoot,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_ROOT_INVALID");
  const target = exactDirectory(reviewedBundleDirectory, "REVIEWED_BUNDLE_INVALID");
  requireStrictlyWithin(target, repository, "REVIEWED_BUNDLE_OUTSIDE_REPOSITORY");
  assertPrivatePathImpl(target, repository, { directory: true });
  const snapshot = verifyCanarySourceSnapshot({
    snapshotDirectory,
    repositoryRoot: repository,
  });
  const manifestPath = exactFileWithin(
    path.join(target, REVIEWED_BUNDLE_MANIFEST_NAME),
    target,
    "REVIEWED_BUNDLE_MANIFEST_INVALID",
  );
  const inputsManifestPath = exactFileWithin(
    path.join(target, BUNDLE_INPUTS_MANIFEST_NAME),
    target,
    "BUNDLE_INPUTS_MANIFEST_INVALID",
  );
  assertPrivatePathImpl(manifestPath, repository);
  assertPrivatePathImpl(inputsManifestPath, repository);
  const manifestBytes = readBoundedFile(
    manifestPath,
    MAX_METAFILE_BYTES,
    "REVIEWED_BUNDLE_MANIFEST_INVALID",
  );
  const inputsManifestBytes = readBoundedFile(
    inputsManifestPath,
    MAX_METAFILE_BYTES,
    "BUNDLE_INPUTS_MANIFEST_INVALID",
  );
  const manifest = parseReviewedManifest(manifestBytes);
  const inputsManifest = parseBundleInputsManifest(inputsManifestBytes);
  if (
    manifest.sourceManifestSha256 !== snapshot.manifestSha256 ||
    inputsManifest.sourceManifestSha256 !== snapshot.manifestSha256 ||
    manifest.bundleInputsManifestSha256 !== sha256(inputsManifestBytes) ||
    manifest.bundlePrecommitManifestSha256 !== inputsManifest.precommitSha256 ||
    manifest.metafileSha256 !== inputsManifest.metafileSha256
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_IDENTITY_MISMATCH",
      "the reviewed bundle is not linked to its verified source/input manifests",
    );
  }

  const expectedFiles = new Set([
    REVIEWED_BUNDLE_MANIFEST_NAME,
    BUNDLE_INPUTS_MANIFEST_NAME,
    manifest.entry.path,
    ...manifest.modules.map((module) => module.path),
  ]);
  const actualFiles = inventoryRegularFiles(target);
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((relative) => !expectedFiles.has(relative))
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_FILE_SET_MISMATCH",
      "the reviewed deploy bundle contains a missing or unreviewed file",
    );
  }
  for (const entry of [manifest.entry, ...manifest.modules]) {
    assertPrivatePathImpl(path.join(target, ...entry.path.split("/")), repository);
    const actual = regularFileIdentity(
      path.join(target, ...entry.path.split("/")),
      target,
      "REVIEWED_BUNDLE_FILE_INVALID",
    );
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new CanaryBundleInputError(
        "REVIEWED_BUNDLE_FILE_CHANGED",
        "a reviewed deploy module no longer matches its manifest",
      );
    }
  }
  bindReviewedSelectionToOutputInventory(
    [
      { ...manifest.entry, role: "entry" },
      ...manifest.modules.map((module) => ({ ...module, role: "additional-module" })),
    ],
    inputsManifest,
    inputsManifest.sourceEntrypoint,
  );

  return Object.freeze({
    reviewedBundleDirectory: target,
    manifestPath,
    manifest: Object.freeze(manifest),
    manifestSha256: sha256(manifestBytes),
    sourceManifestSha256: snapshot.manifestSha256,
    bundleInputsManifestSha256: sha256(inputsManifestBytes),
    bundlePrecommitManifestSha256: inputsManifest.precommitSha256,
    bundleInputsManifest: Object.freeze(inputsManifest),
    entryPath: path.join(target, ...manifest.entry.path.split("/")),
    modules: Object.freeze(manifest.modules.map((module) => Object.freeze({ ...module }))),
  });
}

/**
 * Remove the ordinary write bit from every verified reviewed module/manifest and directory.
 *
 * This is a local accident barrier, not a substitute for byte verification: an approved local
 * owner can deliberately restore write access. Callers must therefore still invoke
 * `verifyReviewedCanaryBundle` immediately before every control-plane side effect.
 */
export function sealReviewedCanaryBundleReadOnly({
  reviewedBundleDirectory,
  snapshotDirectory,
  repositoryRoot,
  assertPrivatePathImpl = assertPrivateLocalPath,
} = {}) {
  const verified = verifyReviewedCanaryBundle({
    reviewedBundleDirectory,
    snapshotDirectory,
    repositoryRoot,
    assertPrivatePathImpl,
  });
  const files = inventoryRegularFiles(verified.reviewedBundleDirectory);
  const directories = new Set();
  for (const relative of files) {
    const segments = relative.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
    chmodSync(path.join(verified.reviewedBundleDirectory, ...segments), 0o400);
  }
  for (const relative of [...directories].sort((left, right) => right.length - left.length)) {
    chmodSync(path.join(verified.reviewedBundleDirectory, ...relative.split("/")), 0o500);
  }
  chmodSync(verified.reviewedBundleDirectory, 0o500);
  return verifyReviewedCanaryBundle({
    reviewedBundleDirectory: verified.reviewedBundleDirectory,
    snapshotDirectory,
    repositoryRoot,
    assertPrivatePathImpl,
  });
}

function prepareInputContext({
  snapshotDirectory,
  bundleWorkingDirectory,
  metafileBaseDirectory,
  dependencyRoot,
  repositoryRoot,
  buildArtifactDirectory,
  expectedSourceEntrypoint,
  assertPrivatePathImpl,
}) {
  const repository = exactDirectory(repositoryRoot, "REPOSITORY_ROOT_INVALID");
  const snapshot = exactDirectory(snapshotDirectory, "SNAPSHOT_INVALID");
  // The process cwd remains a separately checked snapshot boundary; Wrangler's metafile names
  // are not assumed to be relative to it.
  const working = exactDirectory(bundleWorkingDirectory, "BUNDLE_WORKDIR_INVALID");
  requireWithinOrEqual(working, snapshot, "BUNDLE_WORKDIR_OUTSIDE_SNAPSHOT");
  const metafileBase = exactDirectory(metafileBaseDirectory, "METAFILE_BASE_INVALID");
  requireWithinOrEqual(
    metafileBase,
    repository,
    "METAFILE_BASE_OUTSIDE_REPOSITORY",
  );
  const dependencies = exactDirectory(dependencyRoot, "DEPENDENCY_ROOT_INVALID");
  if (!samePath(dependencies, path.join(repository, "node_modules"))) {
    throw new CanaryBundleInputError(
      "DEPENDENCY_ROOT_MISMATCH",
      "bundle dependencies must use the explicit repository node_modules root",
    );
  }
  const artifacts = exactDirectory(buildArtifactDirectory, "BUILD_ARTIFACT_ROOT_INVALID");
  requireWithinOrEqual(artifacts, repository, "BUILD_ARTIFACT_ROOT_OUTSIDE_REPOSITORY");
  if (isWithinOrEqual(artifacts, snapshot) || isWithinOrEqual(snapshot, artifacts)) {
    throw new CanaryBundleInputError(
      "BUILD_ARTIFACT_ROOT_OVERLAPS_SNAPSHOT",
      "Wrangler output must not be written into or around the immutable source snapshot",
    );
  }
  assertPrivatePathImpl(artifacts, repository, { directory: true });
  const snapshotVerification = verifyCanarySourceSnapshot({
    snapshotDirectory: snapshot,
    repositoryRoot: repository,
  });
  assertPrivatePathImpl(snapshot, repository, { directory: true });
  assertPrivatePathImpl(snapshotVerification.manifestPath, repository);
  const sourceManifest = readJson(
    snapshotVerification.manifestPath,
    MAX_METAFILE_BYTES,
    "SOURCE_MANIFEST_INVALID",
  );
  if (
    !isRecord(sourceManifest) ||
    sourceManifest.schemaVersion !== CANARY_SOURCE_SNAPSHOT_SCHEMA_VERSION ||
    !Array.isArray(sourceManifest.entries)
  ) {
    throw new CanaryBundleInputError("SOURCE_MANIFEST_INVALID", "the verified source manifest is malformed");
  }
  const selected = new Map(sourceManifest.entries.map((entry) => [entry.path, entry]));
  const expectedEntrypoint = exactFileWithin(
    expectedSourceEntrypoint,
    snapshot,
    "BUNDLE_SOURCE_ENTRYPOINT_INVALID",
  );
  const expectedEntrypointRelative = portableRelative(snapshot, expectedEntrypoint);
  if (!selected.has(expectedEntrypointRelative)) {
    throw new CanaryBundleInputError(
      "BUNDLE_SOURCE_ENTRYPOINT_NOT_MANIFESTED",
      "the configured source entrypoint is absent from the sealed source manifest",
    );
  }
  return {
    repository,
    snapshot,
    working,
    metafileBase,
    dependencies,
    artifacts,
    snapshotVerification,
    selected,
    expectedEntrypoint,
    expectedEntrypointRelative,
  };
}

function readLockfileContract(context) {
  const expected = context.selected.get(LOCKFILE_RELATIVE_PATH);
  if (!expected) {
    throw new CanaryBundleInputError(
      "BUNDLE_LOCKFILE_NOT_MANIFESTED",
      "the source snapshot does not contain the required package lockfile",
    );
  }
  const lockfilePath = exactFileWithin(
    path.join(context.snapshot, LOCKFILE_RELATIVE_PATH),
    context.snapshot,
    "BUNDLE_LOCKFILE_INVALID",
  );
  const bytes = readBoundedFile(lockfilePath, MAX_METAFILE_BYTES, "BUNDLE_LOCKFILE_INVALID");
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new CanaryBundleInputError(
      "BUNDLE_LOCKFILE_CHANGED",
      "the package lockfile differs from its sealed source-manifest identity",
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError("BUNDLE_LOCKFILE_INVALID", "the package lockfile is not valid JSON");
  }
  if (
    !isRecord(value) ||
    ![2, 3].includes(value.lockfileVersion) ||
    !isRecord(value.packages)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_LOCKFILE_INVALID",
      "the package lockfile has no supported installed-package inventory",
    );
  }
  const packageRoots = [];
  for (const key of Object.keys(value.packages).sort()) {
    const portable = key.replaceAll("\\", "/");
    if (!portable.startsWith("node_modules/")) continue;
    const relative = portable.slice("node_modules/".length);
    if (
      relative.length === 0 ||
      path.posix.isAbsolute(relative) ||
      relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_LOCKFILE_INVALID",
        "the package lockfile contains an unsafe installed-package path",
      );
    }
    packageRoots.push(relative);
  }
  return { sha256: sha256(bytes), packageRoots };
}

function readMetafile(candidate, code) {
  const bytes = readBoundedFile(candidate, MAX_METAFILE_BYTES, code);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError(code, "the Wrangler bundle metafile is not valid JSON");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== ["inputs", "outputs"].join("\0") ||
    !isRecord(value.inputs) ||
    Object.keys(value.inputs).length === 0 ||
    !isRecord(value.outputs)
  ) {
    throw new CanaryBundleInputError(code, "the Wrangler bundle metafile has an open or empty input inventory");
  }
  return { bytes, sha256: sha256(bytes), value };
}

function inspectMetafileInputs(metafile, context, packageRoots) {
  const inputs = [];
  const builtins = [];
  const byInputName = new Map();
  const rewrittenExternalEdges = [];
  for (const inputName of Object.keys(metafile.inputs).sort()) {
    const descriptor = metafile.inputs[inputName];
    if (inputName.startsWith(BUILTIN_PREFIX)) {
      const name = inputName.slice(BUILTIN_PREFIX.length);
      if (!/^[a-z0-9_./-]+$/u.test(name)) {
        throw new CanaryBundleInputError("BUNDLE_VIRTUAL_INPUT_REFUSED", "the bundle contains an unknown virtual input");
      }
      const builtin = {
        name,
        metafileDescriptorSha256: sha256(Buffer.from(canonicalJson(normalizeInputDescriptor(descriptor)))),
      };
      builtins.push(builtin);
      byInputName.set(inputName, { kind: "builtin", path: name });
      continue;
    }
    if (
      inputName.includes("\0") ||
      inputName.startsWith("<") ||
      (!isFilesystemAbsoluteInput(inputName) && /^[a-z][a-z0-9+.-]*:/iu.test(inputName))
    ) {
      throw new CanaryBundleInputError("BUNDLE_VIRTUAL_INPUT_REFUSED", "the bundle contains an unbound virtual input");
    }
    const absolute = resolveMetafilePath(context.metafileBase, inputName);
    let entry;
    if (isWithinOrEqual(absolute, context.snapshot)) {
      const relative = portableRelative(context.snapshot, absolute);
      const expected = context.selected.get(relative);
      if (!expected) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_NOT_MANIFESTED",
          "Wrangler consumed a snapshot-local source file absent from the source manifest",
        );
      }
      const actual = regularFileIdentity(absolute, context.snapshot, "BUNDLE_SOURCE_INVALID");
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_CHANGED",
          "a source input changed after the source snapshot was verified",
        );
      }
      entry = { kind: "snapshot", path: relative, ...actual };
    } else if (isWithinOrEqual(absolute, context.dependencies)) {
      const relative = portableRelative(context.dependencies, absolute);
      const packageRoot = packageRootForDependency(relative, packageRoots);
      if (packageRoot === null) {
        throw new CanaryBundleInputError(
          "BUNDLE_DEPENDENCY_NOT_LOCKED",
          "Wrangler consumed a dependency outside the installed package roots declared by package-lock.json",
        );
      }
      entry = {
        kind: "dependency",
        path: relative,
        package: packageRoot,
        ...regularFileIdentity(absolute, context.dependencies, "BUNDLE_DEPENDENCY_INVALID"),
      };
    } else {
      throw new CanaryBundleInputError(
        "BUNDLE_INPUT_OUTSIDE_BOUNDARY",
        "Wrangler consumed a file outside the frozen snapshot and authorized dependency root",
      );
    }
    const normalizedDescriptor = normalizeInputDescriptor(descriptor, entry.bytes);
    for (const edge of normalizedDescriptor.imports) {
      if (edge.external === true && isStrictRelativeSpecifier(edge.path)) {
        rewrittenExternalEdges.push({
          importerKind: entry.kind,
          importerPath: entry.path,
          path: edge.path,
          kind: edge.kind,
          targetPath: resolveCollectorModuleTarget(edge.path),
        });
      }
    }
    entry.metafileDescriptorSha256 = sha256(Buffer.from(canonicalJson(normalizedDescriptor)));
    inputs.push(entry);
    byInputName.set(inputName, { kind: entry.kind, path: entry.path });
  }
  inputs.sort(compareKindPath);
  builtins.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(inputs.map((entry) => `${entry.kind}\0${entry.path}`)).size !== inputs.length) {
    throw new CanaryBundleInputError("BUNDLE_INPUT_AMBIGUOUS", "the metafile aliases one input through multiple names");
  }
  if (!inputs.some((entry) =>
    entry.kind === "snapshot" && entry.path === context.expectedEntrypointRelative)) {
    throw new CanaryBundleInputError(
      "BUNDLE_SOURCE_ENTRYPOINT_NOT_CONSUMED",
      "Wrangler's metafile does not prove that it consumed the configured snapshot entrypoint",
    );
  }
  const graph = { builtins, inputs };
  Object.defineProperty(graph, "byInputName", { value: byInputName, enumerable: false });
  Object.defineProperty(graph, "rewrittenExternalEdges", {
    value: rewrittenExternalEdges,
    enumerable: false,
  });
  return graph;
}

function normalizeInputDescriptor(value, expectedBytes) {
  const allowed = new Set(["bytes", "format", "imports"]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    (expectedBytes !== undefined && value.bytes !== expectedBytes) ||
    !Array.isArray(value.imports) ||
    (value.format !== undefined && !["cjs", "esm"].includes(value.format))
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_INPUT_INVALID",
      "a metafile input descriptor is open, malformed, or disagrees with the input bytes",
    );
  }
  const normalized = { bytes: value.bytes, imports: value.imports.map(normalizeImportDescriptor) };
  if (value.format !== undefined) normalized.format = value.format;
  return normalized;
}

function normalizeImportDescriptor(value) {
  const allowed = new Set(["external", "kind", "original", "path", "with"]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.length > 4_096 ||
    value.path.includes("\0") ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    value.kind.length > 100 ||
    (value.external !== undefined && typeof value.external !== "boolean") ||
    (value.original !== undefined && (typeof value.original !== "string" || value.original.length > 4_096)) ||
    (value.with !== undefined && (!isRecord(value.with) || Object.values(value.with).some((item) => typeof item !== "string")))
  ) {
    throw new CanaryBundleInputError("BUNDLE_METAFILE_GRAPH_INVALID", "a metafile import edge is malformed");
  }
  const normalized = { path: value.path, kind: value.kind };
  if (value.external !== undefined) normalized.external = value.external;
  if (value.original !== undefined) normalized.original = value.original;
  if (value.with !== undefined) normalized.with = Object.fromEntries(Object.entries(value.with).sort());
  return normalized;
}

export function normalizeBundleModulePolicy(value) {
  const expectedKeys = [
    "compatibilityFlags",
    "findAdditionalModules",
    "preserveFileNames",
    "rules",
  ].sort();
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    value.preserveFileNames !== false ||
    value.findAdditionalModules !== false ||
    !Array.isArray(value.compatibilityFlags) ||
    value.compatibilityFlags.length === 0 ||
    value.compatibilityFlags.some((flag) =>
      typeof flag !== "string" || !/^[a-z0-9_-]+$/u.test(flag)) ||
    new Set(value.compatibilityFlags).size !== value.compatibilityFlags.length ||
    !value.compatibilityFlags.includes("nodejs_compat")
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_MODULE_POLICY_INVALID",
      "the bundle module policy must explicitly disable filename preservation and filesystem discovery and bind nodejs_compat",
    );
  }
  return {
    preserveFileNames: false,
    findAdditionalModules: false,
    compatibilityFlags: [...value.compatibilityFlags],
    rules: normalizeSourceModuleRules(value.rules),
  };
}

function normalizeSourceModuleRules(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CanaryBundleInputError("BUNDLE_MODULE_RULES_INVALID", "bundle module rules must be a nonempty closed array");
  }
  const rules = [];
  const seenTypes = new Set();
  for (let ruleIndex = 0; ruleIndex < value.length; ruleIndex += 1) {
    const rule = value[ruleIndex];
    if (
      !isRecord(rule) ||
      Object.keys(rule).sort().join("\0") !== ["fallthrough", "globs", "type"].join("\0") ||
      !SOURCE_MODULE_TYPES.has(rule.type) ||
      rule.fallthrough !== false ||
      !Array.isArray(rule.globs) ||
      rule.globs.length === 0
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_MODULE_RULES_INVALID",
        "each bundle module rule must have one supported type, nonempty globs, and fail closed",
      );
    }
    if (seenTypes.has(rule.type)) {
      throw new CanaryBundleInputError(
        "BUNDLE_MODULE_RULE_TYPE_SHADOWED",
        "pinned Wrangler would shadow a later non-fallthrough rule of the same module type",
      );
    }
    seenTypes.add(rule.type);
    for (let globIndex = 0; globIndex < rule.globs.length; globIndex += 1) {
      const glob = rule.globs[globIndex];
      if (
        typeof glob !== "string" ||
        glob.length === 0 ||
        glob.length > 1_000 ||
        glob.includes("\\") ||
        glob.includes("\0") ||
        path.posix.isAbsolute(glob) ||
        /^[A-Za-z]:/u.test(glob) ||
        /^[a-z][a-z0-9+.-]*:/iu.test(glob) ||
        !/^[A-Za-z0-9._/*-]+$/u.test(glob) ||
        glob.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw new CanaryBundleInputError(
          "BUNDLE_MODULE_GLOB_UNSUPPORTED",
          "a module glob uses syntax outside the pinned Wrangler adapter's closed glob subset",
        );
      }
      rules.push({ type: rule.type, glob, ruleIndex, globIndex });
    }
  }
  if (new Set(rules.map((rule) => `${rule.type}\0${rule.glob}`)).size !== rules.length) {
    throw new CanaryBundleInputError("BUNDLE_MODULE_RULES_INVALID", "bundle module rules contain a duplicate selector");
  }
  return rules;
}

function inspectSourceModuleReferences(metafile, context, graph, rules) {
  const bySourcePath = new Map();
  const usedRules = new Set();
  for (const inputName of Object.keys(metafile.inputs).sort()) {
    const input = graph.byInputName.get(inputName);
    if (input?.kind !== "snapshot") continue;
    if (!/\.(?:[cm]?[jt]sx?)$/iu.test(input.path)) continue;
    const importerAbsolute = path.join(context.snapshot, ...input.path.split("/"));
    const importerBytes = readBoundedFile(importerAbsolute, MAX_INPUT_BYTES, "BUNDLE_SOURCE_MODULE_IMPORTER_INVALID");
    const references = literalSourceModuleImports(input.path, importerBytes.toString("utf8"));
    for (const reference of references) {
      const matchingRules = rules.filter((rule) =>
        pinnedBundleGlobMatches(rule.glob, reference.importSpecifier));
      if (matchingRules.length === 0) continue;
      if (!isStrictRelativeSpecifier(reference.importSpecifier)) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_SPECIFIER_UNSUPPORTED",
          "a module rule matched a non-relative source import which cannot be provenance-bound safely",
        );
      }
      if (reference.kind !== "import-statement" && reference.kind !== "require-call") {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_EDGE_UNSUPPORTED",
          "a local source module uses an unsupported import edge kind",
        );
      }
      const sourcePath = resolveSnapshotRuntimeTarget(input.path, reference.importSpecifier);
      const sourceManifestEntry = context.selected.get(sourcePath);
      if (sourceManifestEntry === undefined) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_NOT_MANIFESTED",
          "a local external source module is absent from the sealed source manifest",
        );
      }
      const sourceAbsolute = path.join(context.snapshot, ...sourcePath.split("/"));
      const identity = regularFileIdentity(sourceAbsolute, context.snapshot, "BUNDLE_SOURCE_MODULE_INVALID");
      if (identity.bytes !== sourceManifestEntry.bytes || identity.sha256 !== sourceManifestEntry.sha256) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_CHANGED",
          "a local external source module differs from its sealed source identity",
        );
      }
      if (matchingRules.length !== 1) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_RULE_AMBIGUOUS",
          "a local source module does not match exactly one closed Wrangler module rule",
        );
      }
      const rule = matchingRules[0];
      usedRules.add(`${rule.ruleIndex}\0${rule.globIndex}`);
      const prior = bySourcePath.get(sourcePath);
      if (prior === undefined) {
        bySourcePath.set(sourcePath, {
          sourcePath,
          ...identity,
          type: rule.type,
          ruleGlob: rule.glob,
          ruleIndex: rule.ruleIndex,
          globIndex: rule.globIndex,
          references: [reference],
        });
      } else {
        if (
          prior.bytes !== identity.bytes ||
          prior.sha256 !== identity.sha256 ||
          prior.type !== rule.type ||
          prior.ruleGlob !== rule.glob ||
          prior.ruleIndex !== rule.ruleIndex ||
          prior.globIndex !== rule.globIndex
        ) {
          throw new CanaryBundleInputError(
            "BUNDLE_SOURCE_MODULE_PROVENANCE_AMBIGUOUS",
            "one source module is classified inconsistently across import sites",
          );
        }
        prior.references.push(reference);
      }
    }
  }
  if (usedRules.size !== rules.length) {
    throw new CanaryBundleInputError(
      "BUNDLE_MODULE_RULE_UNCOVERED",
      "at least one declared source module rule was never exercised by the audited input graph",
    );
  }
  const modules = [...bySourcePath.values()];
  for (const module of modules) {
    module.references.sort((left, right) =>
      `${left.importerPath}\0${left.importSpecifier}\0${left.kind}`.localeCompare(
        `${right.importerPath}\0${right.importSpecifier}\0${right.kind}`,
      ));
  }
  return modules.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function inspectMetafileOutputs(metafile, context, outputRoot, graph, sourceModules) {
  const names = Object.keys(metafile.outputs).sort();
  if (names.length === 0) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_OUTPUTS_EMPTY",
      "the audited metafile has no output inventory",
    );
  }
  const outputs = [];
  const outputPaths = new Set();
  for (const outputName of names) {
    const absolute = resolveDeclaredMetafileOutput(context.metafileBase, outputName);
    requireStrictlyWithin(absolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_OUTSIDE_DIRECTORY");
    const relative = normalizeArtifactRelativePath(
      portableRelative(outputRoot, absolute),
      "BUNDLE_METAFILE_OUTPUT_INVALID",
    );
    if (outputPaths.has(relative.toLowerCase())) {
      throw new CanaryBundleInputError("BUNDLE_METAFILE_OUTPUT_AMBIGUOUS", "metafile outputs alias one path");
    }
    outputPaths.add(relative.toLowerCase());
    const identity = regularFileIdentity(absolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_INVALID");
    const descriptor = normalizeOutputDescriptor(
      metafile.outputs[outputName],
      identity.bytes,
      graph.byInputName,
      relative,
      outputRoot,
      context.metafileBase,
      sourceModules,
      graph.rewrittenExternalEdges,
    );
    outputs.push({ path: relative, ...identity, ...descriptor });
  }
  outputs.sort((left, right) => left.path.localeCompare(right.path));
  const declared = new Map(outputs.map((entry) => [entry.path, entry]));
  for (const entry of outputs) {
    if (entry.cssBundle !== undefined) {
      throw new CanaryBundleInputError(
        "BUNDLE_CSS_BUNDLE_UNSUPPORTED",
        "the pinned relocation adapter does not yet support emitted CSS bundle outputs",
      );
    }
    for (const edge of entry.imports) {
      if (edge.target === undefined) continue;
      const targetPath = path.join(outputRoot, ...edge.target.path.split("/"));
      const identity = regularFileIdentity(targetPath, outputRoot, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
      if (identity.bytes !== edge.target.bytes || identity.sha256 !== edge.target.sha256) {
        throw new CanaryBundleInputError("BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID", "an output import target changed");
      }
      if (edge.external !== true && !declared.has(edge.target.path)) {
        throw new CanaryBundleInputError(
          "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
          "a bundled output edge points to a file outside the metafile output inventory",
        );
      }
      if (edge.external === true && declared.has(edge.target.path)) {
        throw new CanaryBundleInputError(
          "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
          "an external local module aliases one declared metafile output",
        );
      }
    }
  }
  const rewrittenInputEdges = new Set(
    graph.rewrittenExternalEdges.map((edge) => `${edge.targetPath}\0${edge.kind}`),
  );
  const emittedLocalEdges = new Set(
    outputs.flatMap((output) => output.imports)
      .filter((edge) => edge.external === true && edge.target !== undefined)
      .map((edge) => `${edge.target.path}\0${edge.kind}`),
  );
  if (
    rewrittenInputEdges.size !== emittedLocalEdges.size ||
    [...rewrittenInputEdges].some((edge) => !emittedLocalEdges.has(edge))
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_EXTERNAL_MODULE_GRAPH_COVERAGE_MISMATCH",
      "rewritten local module edges differ between the audited input and output graphs",
    );
  }
  const externalByTarget = new Map(
    outputs.flatMap((output) => output.imports)
      .filter((edge) => edge.external === true && edge.target !== undefined)
      .map((edge) => [edge.target.path, edge.target]),
  );
  for (const rewritten of graph.rewrittenExternalEdges) {
    const emitted = externalByTarget.get(rewritten.targetPath);
    const source = sourceModules.find((module) => module.sourcePath === emitted?.sourcePath);
    if (
      rewritten.importerKind !== "snapshot" ||
      source === undefined ||
      !source.references.some((reference) =>
        reference.importerPath === rewritten.importerPath && reference.kind === rewritten.kind)
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_EXTERNAL_MODULE_IMPORTER_PROVENANCE_MISMATCH",
        "a rewritten input edge is not bound to an AST-proven sealed source import and emitted module",
      );
    }
  }
  const allEntrypoints = outputs.filter((entry) => entry.entryPoint !== undefined);
  if (
    allEntrypoints.length !== 1 ||
    allEntrypoints[0].entryPoint.kind !== "snapshot" ||
    allEntrypoints[0].entryPoint.path !== context.expectedEntrypointRelative
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_ENTRYPOINT_MISMATCH",
      "the audited output inventory does not contain exactly one total entrypoint bound to the expected source",
    );
  }
  const entryOutput = allEntrypoints[0];
  if (!/\.(?:m?js)$/u.test(entryOutput.path)) {
    throw new CanaryBundleInputError(
      "BUNDLE_ENTRY_OUTPUT_UNSUPPORTED",
      "the audited entry output is not a supported JavaScript module",
    );
  }
  if (entryOutput.path.includes("/")) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_NESTED_ENTRY_UNSUPPORTED",
      "pinned Wrangler no-bundle uploads the main by basename, so a nested entry would rebase its relative imports",
    );
  }
  const reachableOutputs = new Set();
  const externalModules = new Map();
  const pending = [entryOutput.path];
  while (pending.length > 0) {
    const currentPath = pending.shift();
    if (reachableOutputs.has(currentPath)) continue;
    const current = declared.get(currentPath);
    if (current === undefined) {
      throw new CanaryBundleInputError("BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID", "a reachable output is undeclared");
    }
    reachableOutputs.add(currentPath);
    for (const edge of current.imports) {
      if (edge.target === undefined) continue;
      if (edge.external === true) {
        if (edge.target.path === "README.md" || edge.target.path.endsWith(".map")) {
          throw new CanaryBundleInputError(
            "BUNDLE_EXTERNAL_MODULE_TARGET_RESERVED",
            "a local external module targets a reserved Wrangler by-product path",
          );
        }
        const prior = externalModules.get(edge.target.path);
        if (prior !== undefined && canonicalJson(prior) !== canonicalJson(edge.target)) {
          throw new CanaryBundleInputError(
            "BUNDLE_EXTERNAL_MODULE_AMBIGUOUS",
            "one emitted external module path has conflicting source provenance",
          );
        }
        externalModules.set(edge.target.path, edge.target);
      } else {
        pending.push(edge.target.path);
      }
    }
  }
  for (const reachablePath of reachableOutputs) {
    const sourceMap = declared.get(`${reachablePath}.map`);
    if (
      sourceMap === undefined ||
      sourceMap.entryPoint !== undefined ||
      sourceMap.cssBundle !== undefined ||
      sourceMap.imports.length !== 0 ||
      sourceMap.exports.length !== 0 ||
      sourceMap.inputContributions.length !== 0
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_SOURCE_MAP_MISSING_OR_OPEN",
        "each reachable JavaScript output must have one exact declared empty-descriptor source map",
      );
    }
  }
  const emittedSourcePaths = new Set(
    [...externalModules.values()].map((module) => module.sourcePath),
  );
  if (
    emittedSourcePaths.size !== sourceModules.length ||
    sourceModules.some((module) => !emittedSourcePaths.has(module.sourcePath))
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_SOURCE_MODULE_COVERAGE_INCOMPLETE",
      "the output graph does not account for every local source module discovered in the input graph",
    );
  }
  for (const output of outputs) {
    if (reachableOutputs.has(output.path)) {
      if (!/\.(?:m?js)$/u.test(output.path)) {
        throw new CanaryBundleInputError(
          "BUNDLE_REACHABLE_OUTPUT_UNSUPPORTED",
          "a reachable declared output is not a supported JavaScript chunk",
        );
      }
      continue;
    }
    const mappedOutput = output.path.endsWith(".map")
      ? declared.get(output.path.slice(0, -4))
      : undefined;
    if (
      mappedOutput === undefined ||
      !reachableOutputs.has(mappedOutput.path) ||
      !/\.(?:m?js)$/u.test(mappedOutput.path) ||
      output.entryPoint !== undefined ||
      output.cssBundle !== undefined ||
      output.imports.length !== 0 ||
      output.exports.length !== 0 ||
      output.inputContributions.length !== 0
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_METAFILE_ORPHAN_OUTPUT",
        "a declared output is neither reachable from the entry nor its exact empty-descriptor source map",
      );
    }
  }
  const modules = [
    ...[...reachableOutputs]
      .filter((candidate) => candidate !== entryOutput.path)
      .map((candidate) => {
        const output = declared.get(candidate);
        return {
          path: output.path,
          bytes: output.bytes,
          sha256: output.sha256,
          type: "ESModule",
          provenance: { kind: "metafile-output" },
        };
      }),
    ...[...externalModules.values()].map((module) => ({
      path: module.path,
      bytes: module.bytes,
      sha256: module.sha256,
      type: module.type,
      provenance: {
        kind: "snapshot-module-rule",
        sourcePath: module.sourcePath,
        sourceBytes: module.sourceBytes,
        sourceSha256: module.sourceSha256,
        ruleGlob: module.ruleGlob,
        ruleIndex: module.ruleIndex,
        globIndex: module.globIndex,
      },
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (new Set([entryOutput.path, ...modules.map((module) => module.path)]).size !== modules.length + 1) {
    throw new CanaryBundleInputError("BUNDLE_REVIEWED_SELECTION_AMBIGUOUS", "the graph-derived reviewed file set aliases a path");
  }
  const selection = {
    entry: { path: entryOutput.path, bytes: entryOutput.bytes, sha256: entryOutput.sha256 },
    modules,
  };
  const rawFiles = inspectRawOutputInventory({ outputRoot, outputs, selection });
  return { outputs, rawFiles, selection };
}

function normalizeOutputDescriptor(
  value,
  expectedBytes,
  inputNames,
  outputPath,
  outputRoot,
  metafileBase,
  sourceModules,
  rewrittenExternalEdges,
) {
  const allowed = new Set(["bytes", "cssBundle", "entryPoint", "exports", "imports", "inputs"]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes !== expectedBytes ||
    !Array.isArray(value.imports) ||
    !Array.isArray(value.exports) ||
    value.exports.some((entry) => typeof entry !== "string" || entry.length > 1_000) ||
    !isRecord(value.inputs)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_OUTPUT_INVALID",
      "a metafile output descriptor is open, malformed, or disagrees with output bytes",
    );
  }
  const contributions = [];
  for (const [inputName, contribution] of Object.entries(value.inputs).sort(([left], [right]) => left.localeCompare(right))) {
    const input = inputNames.get(inputName);
    if (
      input === undefined ||
      !isRecord(contribution) ||
      Object.keys(contribution).join("\0") !== "bytesInOutput" ||
      !Number.isSafeInteger(contribution.bytesInOutput) ||
      contribution.bytesInOutput < 0
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
        "an output contribution does not reference one audited input",
      );
    }
    contributions.push({ ...input, bytesInOutput: contribution.bytesInOutput });
  }
  const imports = value.imports.map((candidate) => {
    const edge = normalizeOutputImportDescriptor(candidate);
    if (edge.external === true) {
      if (!isStrictRelativeSpecifier(edge.path)) {
        if (!RUNTIME_EXTERNALS.has(edge.path)) {
          throw new CanaryBundleInputError(
            "BUNDLE_RUNTIME_EXTERNAL_UNSUPPORTED",
            "a runtime external is neither an exact Node builtin nor the closed Cloudflare runtime module",
          );
        }
        return edge;
      }
      if (edge.kind !== "import-statement" && edge.kind !== "require-call") {
        throw new CanaryBundleInputError(
          "BUNDLE_EXTERNAL_MODULE_EDGE_UNSUPPORTED",
          "a local emitted external module uses an unsupported edge kind",
        );
      }
      const targetRelative = resolveEmittedRuntimeTarget(outputPath, edge.path);
      if (!rewrittenExternalEdges.some((candidate) =>
        candidate.targetPath === targetRelative && candidate.kind === edge.kind)) {
        throw new CanaryBundleInputError(
          "BUNDLE_EXTERNAL_MODULE_GRAPH_UNBOUND",
          "an emitted local module edge is absent from the audited input graph",
        );
      }
      const targetAbsolute = path.join(outputRoot, ...targetRelative.split("/"));
      const identity = regularFileIdentity(targetAbsolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
      const candidates = sourceModules.filter((module) =>
        module.bytes === identity.bytes && module.sha256 === identity.sha256);
      if (candidates.length !== 1) {
        throw new CanaryBundleInputError(
          "BUNDLE_EXTERNAL_MODULE_PROVENANCE_AMBIGUOUS",
          "an emitted local module does not map by exact bytes to exactly one manifested source module",
        );
      }
      const source = candidates[0];
      return {
        ...edge,
        target: {
          path: targetRelative,
          ...identity,
          type: source.type,
          sourcePath: source.sourcePath,
          sourceBytes: source.bytes,
          sourceSha256: source.sha256,
          ruleGlob: source.ruleGlob,
          ruleIndex: source.ruleIndex,
          globIndex: source.globIndex,
        },
      };
    }
    const targetAbsolute = resolveDeclaredMetafileOutput(metafileBase, edge.path);
    requireStrictlyWithin(targetAbsolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
    const targetRelative = normalizeArtifactRelativePath(
      portableRelative(outputRoot, targetAbsolute),
      "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
    );
    const identity = regularFileIdentity(targetAbsolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
    return { ...edge, target: { path: targetRelative, ...identity } };
  });
  const normalized = {
    imports,
    exports: [...value.exports],
    inputContributions: contributions.sort(compareKindPath),
  };
  if (value.entryPoint !== undefined) {
    if (typeof value.entryPoint !== "string" || !inputNames.has(value.entryPoint)) {
      throw new CanaryBundleInputError(
        "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
        "an output entryPoint is not one audited metafile input",
      );
    }
    normalized.entryPoint = { ...inputNames.get(value.entryPoint) };
  }
  if (value.cssBundle !== undefined) {
    if (typeof value.cssBundle !== "string") {
      throw new CanaryBundleInputError("BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID", "an output cssBundle is malformed");
    }
    const cssAbsolute = resolveDeclaredMetafileOutput(metafileBase, value.cssBundle);
    requireStrictlyWithin(cssAbsolute, outputRoot, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
    normalized.cssBundle = normalizeArtifactRelativePath(
      portableRelative(outputRoot, cssAbsolute),
      "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
    );
  }
  return normalized;
}

function normalizeOutputImportDescriptor(value) {
  const allowed = new Set(["external", "kind", "path"]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.length > 4_096 ||
    value.path.includes("\0") ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    value.kind.length > 100 ||
    (value.external !== undefined && typeof value.external !== "boolean")
  ) {
    throw new CanaryBundleInputError("BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID", "an output import edge is open or malformed");
  }
  const normalized = { path: value.path, kind: value.kind };
  if (value.external !== undefined) normalized.external = value.external;
  return normalized;
}

function bindReviewedSelectionToOutputInventory(selected, inputsManifest, sourceEntrypoint) {
  if (!isRecord(inputsManifest?.selection) || !Array.isArray(inputsManifest.outputs)) {
    throw new CanaryBundleInputError("REVIEWED_OUTPUT_INVENTORY_INVALID", "reviewed outputs have no closed graph-derived selection");
  }
  const entry = selected.find((candidate) => candidate.role === "entry");
  const modules = selected
    .filter((candidate) => candidate.role === "additional-module")
    .map(reviewedSelectionProjection)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    entry === undefined ||
    canonicalJson(identityProjection(entry)) !== canonicalJson(inputsManifest.selection.entry) ||
    canonicalJson(modules) !== canonicalJson(inputsManifest.selection.modules)
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_SELECTION_NOT_AUDITED_GRAPH",
      "the reviewed deploy files differ from the exact graph-derived audited selection",
    );
  }
  const outputByPath = new Map(inputsManifest.outputs.map((output) => [output.path, output]));
  const entryOutput = outputByPath.get(entry.path);
  if (
    entryOutput?.entryPoint?.kind !== "snapshot" ||
    entryOutput.entryPoint.path !== sourceEntrypoint
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_ENTRY_NOT_AUDITED_OUTPUT",
      "the reviewed entry is not the unique audited output of the expected source entrypoint",
    );
  }
}

function inspectRawOutputInventory({ outputRoot, outputs, selection }) {
  if (!isRecord(selection) || !isRecord(selection.entry) || !Array.isArray(selection.modules)) {
    throw new CanaryBundleInputError("BUNDLE_RAW_INVENTORY_INVALID", "the graph-derived selection is malformed");
  }
  const roles = new Map([[selection.entry.path, "entry-output"]]);
  for (const module of selection.modules) {
    const role = module.provenance?.kind === "metafile-output"
      ? "reachable-esm-output"
      : "source-rule-module";
    if (roles.has(module.path)) {
      throw new CanaryBundleInputError("BUNDLE_RAW_INVENTORY_AMBIGUOUS", "one raw file has multiple deploy roles");
    }
    roles.set(module.path, role);
  }
  const outputByPath = new Map(outputs.map((output) => [output.path, output]));
  for (const output of outputs) {
    if (roles.has(output.path)) continue;
    const mapped = output.path.endsWith(".map")
      ? outputByPath.get(output.path.slice(0, -4))
      : undefined;
    if (
      mapped === undefined ||
      !roles.has(mapped.path) ||
      output.entryPoint !== undefined ||
      output.cssBundle !== undefined ||
      output.imports.length !== 0 ||
      output.exports.length !== 0 ||
      output.inputContributions.length !== 0
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_RAW_INVENTORY_UNCLASSIFIED",
        "a declared raw output has no exact deploy or source-map role",
      );
    }
    roles.set(output.path, "source-map-byproduct");
  }

  const expectedIdentity = new Map([
    [selection.entry.path, selection.entry],
    ...selection.modules.map((module) => [module.path, module]),
    ...outputs.map((output) => [output.path, output]),
  ]);
  const rawFiles = [];
  for (const relative of inventoryRegularFiles(outputRoot)) {
    const absolute = path.join(outputRoot, ...relative.split("/"));
    const identity = regularFileIdentity(absolute, outputRoot, "BUNDLE_RAW_FILE_INVALID");
    let role = roles.get(relative);
    if (role === undefined && relative === "README.md") {
      const bytes = readBoundedFile(absolute, 4_096, "BUNDLE_WRANGLER_README_INVALID");
      const text = bytes.toString("utf8");
      if (!/^This folder contains the built output assets for the worker "survey-qa-v2-visual-canary" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/u.test(text)) {
        throw new CanaryBundleInputError(
          "BUNDLE_WRANGLER_README_INVALID",
          "Wrangler's root README does not match the pinned canary dry-run template",
        );
      }
      role = "wrangler-readme-byproduct";
    }
    if (role === undefined) {
      throw new CanaryBundleInputError(
        "BUNDLE_RAW_INVENTORY_UNCLASSIFIED",
        "Wrangler emitted an unknown raw file which is not safe to omit or deploy",
      );
    }
    const expected = expectedIdentity.get(relative);
    if (
      expected !== undefined &&
      (expected.bytes !== identity.bytes || expected.sha256 !== identity.sha256)
    ) {
      throw new CanaryBundleInputError(
        "BUNDLE_RAW_FILE_IDENTITY_MISMATCH",
        "a raw output differs from its graph-bound identity",
      );
    }
    rawFiles.push({ path: relative, ...identity, role });
  }
  if ([...roles.keys()].some((relative) => !rawFiles.some((file) => file.path === relative))) {
    throw new CanaryBundleInputError("BUNDLE_RAW_INVENTORY_INCOMPLETE", "a classified raw output is missing from the census");
  }
  if (rawFiles.filter((file) => file.role === "wrangler-readme-byproduct").length !== 1) {
    throw new CanaryBundleInputError(
      "BUNDLE_WRANGLER_README_MISSING",
      "the pinned Wrangler raw output must contain exactly one classified root README",
    );
  }
  return rawFiles.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveDeclaredMetafileOutput(metafileBase, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_000 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("<") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
      "a metafile output name is not one canonical portable base-relative path",
    );
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((segment) => segment.length === 0)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID",
      "a metafile output name contains an alias or escapes its explicit base",
    );
  }
  return path.resolve(metafileBase, ...normalized.split("/"));
}

function isStrictRelativeSpecifier(value) {
  return typeof value === "string" && (value.startsWith("./") || value.startsWith("../"));
}

function assertCanonicalRuntimeSpecifier(fromPath, specifier, targetPath, code) {
  if (
    typeof specifier !== "string" ||
    !isStrictRelativeSpecifier(specifier) ||
    specifier.includes("\\") ||
    specifier.includes("\0") ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    /^[A-Za-z]:/u.test(specifier) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(specifier)
  ) {
    throw new CanaryBundleInputError(code, "a local module specifier is not strict portable ./ or ../ syntax");
  }
  let canonical = path.posix.relative(path.posix.dirname(fromPath), targetPath);
  if (canonical.length === 0) {
    throw new CanaryBundleInputError(code, "a local module specifier resolves to its emitting file");
  }
  if (!canonical.startsWith(".")) canonical = `./${canonical}`;
  if (canonical !== specifier) {
    throw new CanaryBundleInputError(code, "a local module specifier contains a non-canonical path alias");
  }
}

function resolveSnapshotRuntimeTarget(importerPath, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  const normalized = normalizeArtifactRelativePath(target, "BUNDLE_SOURCE_MODULE_PATH_INVALID");
  assertCanonicalRuntimeSpecifier(importerPath, specifier, normalized, "BUNDLE_SOURCE_MODULE_PATH_INVALID");
  return normalized;
}

function resolveEmittedRuntimeTarget(emitterPath, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(emitterPath), specifier));
  const normalized = normalizeArtifactRelativePath(target, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
  assertCanonicalRuntimeSpecifier(emitterPath, specifier, normalized, "BUNDLE_METAFILE_OUTPUT_GRAPH_INVALID");
  return normalized;
}

function resolveCollectorModuleTarget(specifier) {
  if (!specifier.startsWith("./")) {
    throw new CanaryBundleInputError(
      "BUNDLE_COLLECTOR_MODULE_PATH_UNSUPPORTED",
      "pinned Wrangler's rewritten input module name must be one root-relative ./ path",
    );
  }
  const target = normalizeArtifactRelativePath(
    specifier.slice(2),
    "BUNDLE_COLLECTOR_MODULE_PATH_UNSUPPORTED",
  );
  if (target.includes("/")) {
    throw new CanaryBundleInputError(
      "BUNDLE_COLLECTOR_MODULE_PATH_UNSUPPORTED",
      "pinned Wrangler's content-addressed collector module must remain at the raw output root",
    );
  }
  assertCanonicalRuntimeSpecifier("entry.js", specifier, target, "BUNDLE_COLLECTOR_MODULE_PATH_UNSUPPORTED");
  return target;
}

function pinnedBundleGlobMatches(glob, importSpecifier) {
  // Pinned Wrangler 4.106.0 uses glob-to-regexp 0.4.1 with default options in the bundling
  // onResolve hook. This closed subset deliberately supports literals, slash, and star runs only;
  // under those exact semantics every star run is `.*`, including across path separators.
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob[index] === "*") {
      while (glob[index + 1] === "*") index += 1;
      expression += ".*";
    } else {
      expression += glob[index].replace(/[\\^$+?.()|[\]{}]/gu, "\\$&");
    }
  }
  expression += "$";
  return new RegExp(expression, "u").test(importSpecifier);
}

function literalSourceModuleImports(importerPath, source) {
  const scriptKind = /\.[cm]?tsx$/iu.test(importerPath)
    ? ts.ScriptKind.TS
    : /\.[cm]?jsx$/iu.test(importerPath)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;
  const file = ts.createSourceFile(importerPath, source, ts.ScriptTarget.ESNext, true, scriptKind);
  if (file.parseDiagnostics.length > 0) {
    throw new CanaryBundleInputError(
      "BUNDLE_SOURCE_MODULE_IMPORTER_INVALID",
      "a consumed source importer cannot be parsed by the verified TypeScript parser",
    );
  }
  const imports = [];
  const add = (node, kind) => {
    if (!ts.isStringLiteralLike(node)) {
      throw new CanaryBundleInputError(
        "BUNDLE_SOURCE_MODULE_EDGE_UNSUPPORTED",
        "a consumed source importer contains a non-literal module specifier",
      );
    }
    imports.push({ importerPath, importSpecifier: node.text, kind });
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
      if (node.arguments.length !== 1) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_EDGE_UNSUPPORTED",
          "a consumed source importer contains an open dynamic import",
        );
      }
      add(node.arguments[0], "dynamic-import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      if (node.arguments.length !== 1) {
        throw new CanaryBundleInputError(
          "BUNDLE_SOURCE_MODULE_EDGE_UNSUPPORTED",
          "a consumed source importer contains an open require call",
        );
      }
      add(node.arguments[0], "require-call");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports.sort((left, right) =>
    `${left.importSpecifier}\0${left.kind}`.localeCompare(`${right.importSpecifier}\0${right.kind}`));
}

function reviewedSelectionProjection(entry) {
  return {
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    type: entry.type,
    provenance: structuredClone(entry.provenance),
  };
}

function reviewedIdentityProjection(entry) {
  return reviewedSelectionProjection(entry);
}

function packageRootForDependency(relative, packageRoots) {
  let selected = null;
  for (const root of packageRoots) {
    if (relative === root || relative.startsWith(`${root}/`)) {
      if (selected === null || root.length > selected.length) selected = root;
    }
  }
  return selected;
}

function compareKindPath(left, right) {
  return `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`);
}

function resolveMetafilePath(metafileBase, inputName) {
  const portable = inputName.replaceAll("/", path.sep);
  const resolved = path.isAbsolute(portable)
    ? path.resolve(portable)
    : path.resolve(metafileBase, portable);
  if (resolved === path.parse(resolved).root) {
    throw new CanaryBundleInputError("BUNDLE_INPUT_INVALID", "the bundle input resolves to a filesystem root");
  }
  return resolved;
}

function isFilesystemAbsoluteInput(inputName) {
  const native = inputName.replaceAll("/", path.sep);
  return path.isAbsolute(native) || /^[A-Za-z]:[\\/]/u.test(inputName);
}

function regularFileIdentity(candidate, trustedRoot, code) {
  requireUnlinkedPath(candidate, trustedRoot, code);
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    throw new CanaryBundleInputError(code, "a declared bundle input is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 0 || stat.size > MAX_INPUT_BYTES) {
    throw new CanaryBundleInputError(code, "a declared bundle input is not a bounded regular file");
  }
  const bytes = readBoundedFile(candidate, MAX_INPUT_BYTES, code);
  if (bytes.length !== stat.size) {
    throw new CanaryBundleInputError(code, "a bundle input changed while it was read");
  }
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function requireUnlinkedPath(candidate, trustedRoot, code) {
  const root = path.resolve(trustedRoot);
  requireWithinOrEqual(candidate, root, code);
  const relative = path.relative(root, path.resolve(candidate));
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new CanaryBundleInputError(code, "a bundle input path component is unavailable");
    }
    if (stat.isSymbolicLink()) {
      throw new CanaryBundleInputError(code, "bundle inputs must not traverse links or junctions");
    }
    let real;
    try {
      real = realpathSync.native(current);
    } catch {
      throw new CanaryBundleInputError(code, "a bundle input path component has no real path");
    }
    if (!samePath(real, current)) {
      throw new CanaryBundleInputError(code, "bundle inputs must resolve exactly without substitution");
    }
  }
}

function readJson(candidate, maximum, code) {
  const bytes = readBoundedFile(candidate, maximum, code);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle JSON file is malformed");
  }
}

function readBoundedFile(candidate, maximum, code) {
  let stat;
  try {
    stat = lstatSync(path.resolve(candidate));
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle file is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) {
    throw new CanaryBundleInputError(code, "a required bundle file is not a bounded regular file");
  }
  try {
    return readFileSync(path.resolve(candidate));
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle file could not be read");
  }
}

function exactDirectory(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CanaryBundleInputError(code, "a required bundle directory is missing");
  }
  const resolved = path.resolve(candidate);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CanaryBundleInputError(code, "a required bundle directory is not a real directory");
  }
  let real;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle directory has no real path");
  }
  if (!samePath(real, resolved)) {
    throw new CanaryBundleInputError(code, "a required bundle directory traverses a link or junction");
  }
  return real;
}

function exactFileWithin(candidate, root, code) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CanaryBundleInputError(code, "a required bundle file path is missing");
  }
  const resolved = path.resolve(candidate);
  requireStrictlyWithin(resolved, root, code);
  requireUnlinkedPath(resolved, root, code);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new CanaryBundleInputError(code, "a required bundle file is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CanaryBundleInputError(code, "a required bundle path is not a regular file");
  }
  return resolved;
}

function requireNewDirectory(candidate, root, label) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CanaryBundleInputError(`${label}_INVALID`, "a new bundle directory is required");
  }
  const resolved = path.resolve(candidate);
  requireStrictlyWithin(resolved, root, `${label}_OUTSIDE_REPOSITORY`);
  exactDirectory(path.dirname(resolved), `${label}_PARENT_INVALID`);
  try {
    lstatSync(resolved);
    throw new CanaryBundleInputError(`${label}_EXISTS`, "the reviewed bundle destination already exists");
  } catch (error) {
    if (error instanceof CanaryBundleInputError) throw error;
    if (error?.code !== "ENOENT") {
      throw new CanaryBundleInputError(`${label}_INVALID`, "the reviewed bundle destination cannot be inspected");
    }
  }
  return resolved;
}

function requireNewFilePath(candidate, root, label) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new CanaryBundleInputError(`${label}_INVALID`, "a new bundle evidence file is required");
  }
  const resolved = path.resolve(candidate);
  requireStrictlyWithin(resolved, root, `${label}_OUTSIDE_ARTIFACT_ROOT`);
  exactDirectory(path.dirname(resolved), `${label}_PARENT_INVALID`);
  try {
    lstatSync(resolved);
    throw new CanaryBundleInputError(`${label}_EXISTS`, "the bundle evidence file already exists");
  } catch (error) {
    if (error instanceof CanaryBundleInputError) throw error;
    if (error?.code !== "ENOENT") {
      throw new CanaryBundleInputError(`${label}_INVALID`, "the bundle evidence file cannot be inspected");
    }
  }
  return resolved;
}

function writeExclusiveDurableFile(candidate, bytes, code) {
  let descriptor;
  try {
    descriptor = openSync(candidate, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort descriptor close only */ }
    }
    throw new CanaryBundleInputError(code, "the bundle evidence file could not be written durably and exclusively");
  }
}

function normalizeAdditionalModules(value) {
  if (!Array.isArray(value)) {
    throw new CanaryBundleInputError("REVIEWED_MODULE_INVALID", "additional modules must be an array");
  }
  const normalized = value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join("\0") !== ["path", "type"].sort().join("\0")) {
      throw new CanaryBundleInputError(
        "REVIEWED_MODULE_INVALID",
        "each additional module must contain exactly path and type",
      );
    }
    if (!MODULE_TYPES.has(entry.type)) {
      throw new CanaryBundleInputError("REVIEWED_MODULE_INVALID", "an additional module has an unsupported type");
    }
    return {
      path: normalizeArtifactRelativePath(entry.path, "REVIEWED_MODULE_INVALID"),
      type: entry.type,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((entry) => entry.path)).size !== normalized.length) {
    throw new CanaryBundleInputError("REVIEWED_MODULE_INVALID", "additional module paths must be unique");
  }
  return normalized;
}

function normalizeArtifactRelativePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || value.includes("\\")) {
    throw new CanaryBundleInputError(code, "reviewed artifact paths must be portable relative paths");
  }
  const segments = value.split("/");
  if (
    path.posix.isAbsolute(value) ||
    segments.some((segment) =>
      segment === "." ||
      segment === ".." ||
      !SAFE_SEGMENT.test(segment))
  ) {
    throw new CanaryBundleInputError(code, "reviewed artifact paths contain an unsafe segment");
  }
  return value;
}

function identityProjection(entry) {
  const projected = {
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
  if (entry.role === "additional-module") projected.type = entry.type;
  return projected;
}

function parseBundlePrecommitManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError(
      "BUNDLE_PRECOMMIT_INVALID",
      "the pre-build dependency commitment is not valid JSON",
    );
  }
  const keys = [
    "builtins",
    "discoveryMetafileSha256",
    "inputs",
    "lockfilePath",
    "lockfileSha256",
    "schemaVersion",
    "sourceEntrypoint",
    "sourceManifestSha256",
  ].sort();
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== keys.join("\0") ||
    value.schemaVersion !== CANARY_BUNDLE_PRECOMMIT_SCHEMA_VERSION ||
    value.lockfilePath !== LOCKFILE_RELATIVE_PATH ||
    !HASH.test(value.lockfileSha256) ||
    !HASH.test(value.sourceManifestSha256) ||
    !HASH.test(value.discoveryMetafileSha256) ||
    typeof value.sourceEntrypoint !== "string"
  ) {
    throw new CanaryBundleInputError("BUNDLE_PRECOMMIT_INVALID", "the pre-build commitment has an open or malformed root");
  }
  validatePersistedGraph(value.inputs, value.builtins, "BUNDLE_PRECOMMIT_INVALID");
  return value;
}

function parseReviewedManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_MANIFEST_INVALID",
      "the reviewed bundle manifest is not valid JSON",
    );
  }
  const expectedRootKeys = [
    "bundleInputsManifestSha256",
    "bundlePrecommitManifestSha256",
    "entry",
    "metafileSha256",
    "modules",
    "schemaVersion",
    "sourceManifestSha256",
  ].sort();
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== expectedRootKeys.join("\0") ||
    value.schemaVersion !== CANARY_REVIEWED_BUNDLE_SCHEMA_VERSION ||
    !HASH.test(value.sourceManifestSha256) ||
    !HASH.test(value.bundleInputsManifestSha256) ||
    !HASH.test(value.bundlePrecommitManifestSha256) ||
    !HASH.test(value.metafileSha256) ||
    !Array.isArray(value.modules)
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_MANIFEST_INVALID",
      "the reviewed bundle manifest has an open or malformed root",
    );
  }
  const entry = normalizeReviewedIdentity(value.entry, false);
  const modules = value.modules.map((module) => normalizeReviewedIdentity(module, true));
  const sorted = [...modules].sort((left, right) => left.path.localeCompare(right.path));
  if (
    modules.length !== sorted.length ||
    modules.some((module, index) => JSON.stringify(module) !== JSON.stringify(sorted[index])) ||
    new Set([entry.path, ...modules.map((module) => module.path)]).size !== modules.length + 1
  ) {
    throw new CanaryBundleInputError(
      "REVIEWED_BUNDLE_MANIFEST_INVALID",
      "reviewed bundle entries must be sorted and unique",
    );
  }
  return {
    schemaVersion: value.schemaVersion,
    sourceManifestSha256: value.sourceManifestSha256,
    bundleInputsManifestSha256: value.bundleInputsManifestSha256,
    bundlePrecommitManifestSha256: value.bundlePrecommitManifestSha256,
    metafileSha256: value.metafileSha256,
    entry,
    modules,
  };
}

function normalizeReviewedIdentity(value, module, code = "REVIEWED_BUNDLE_MANIFEST_INVALID") {
  const expected = module
    ? ["bytes", "path", "provenance", "sha256", "type"]
    : ["bytes", "path", "sha256"];
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== expected.sort().join("\0") ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_INPUT_BYTES ||
    !HASH.test(value.sha256)
  ) {
    throw new CanaryBundleInputError(
      code,
      "the reviewed bundle manifest contains malformed file identity",
    );
  }
  const normalized = {
    path: normalizeArtifactRelativePath(value.path, code),
    bytes: value.bytes,
    sha256: value.sha256,
  };
  if (module) {
    if (!MODULE_TYPES.has(value.type)) {
      throw new CanaryBundleInputError(
        code,
        "the reviewed bundle manifest contains an unsupported module type",
      );
    }
    normalized.type = value.type;
    normalized.provenance = normalizeModuleProvenance(
      value.provenance,
      code,
    );
  }
  return normalized;
}

function parseBundleInputsManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the bundle-input manifest is not valid JSON",
    );
  }
  const keys = [
    "builtins",
    "discoveryMetafileSha256",
    "inputs",
    "lockfileSha256",
    "metafileSha256",
    "modulePolicy",
    "modulePolicySha256",
    "outputs",
    "precommitSha256",
    "rawFiles",
    "schemaVersion",
    "selection",
    "sourceModules",
    "sourceEntrypoint",
    "sourceManifestSha256",
  ].sort();
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== keys.join("\0") ||
    value.schemaVersion !== CANARY_BUNDLE_INPUTS_SCHEMA_VERSION ||
    !HASH.test(value.sourceManifestSha256) ||
    !HASH.test(value.lockfileSha256) ||
    !HASH.test(value.precommitSha256) ||
    !HASH.test(value.discoveryMetafileSha256) ||
    !HASH.test(value.metafileSha256) ||
    !HASH.test(value.modulePolicySha256) ||
    typeof value.sourceEntrypoint !== "string" ||
    !Array.isArray(value.outputs) ||
    value.outputs.length === 0 ||
    !Array.isArray(value.rawFiles) ||
    value.rawFiles.length === 0 ||
    !Array.isArray(value.sourceModules) ||
    !isRecord(value.selection)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the bundle-input manifest is malformed",
    );
  }
  validatePersistedGraph(value.inputs, value.builtins, "BUNDLE_INPUTS_MANIFEST_INVALID");
  const sourceEntrypoint = normalizeArtifactRelativePath(
    value.sourceEntrypoint,
    "BUNDLE_INPUTS_MANIFEST_INVALID",
  );
  // This parser can prove only structural membership. The canary adapter's semantic entry choice
  // is independently bound by the expected reviewed-manifest hash and final build-config
  // projection; inferring a filename convention here would hard-anchor the generic graph parser.
  if (!value.inputs.some((input) =>
    input.kind === "snapshot" && input.path === sourceEntrypoint)) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the persisted source entrypoint is absent from the consumed snapshot graph",
    );
  }
  validatePersistedModulePolicy(value.modulePolicy, value.modulePolicySha256);
  validatePersistedSourceModules(value.sourceModules, value.modulePolicy.rules);
  validatePersistedOutputs(value.outputs, value.inputs, sourceEntrypoint);
  validatePersistedSelection(value.selection, value.outputs, value.sourceModules);
  validatePersistedRawFiles(value.rawFiles, value.outputs, value.selection);
  return value;
}

function validatePersistedGraph(inputs, builtins, code) {
  if (!Array.isArray(inputs) || !Array.isArray(builtins)) {
    throw new CanaryBundleInputError(code, "the persisted bundle graph is not an array");
  }
  let prior = null;
  for (const entry of inputs) {
    const expectedKeys = entry?.kind === "dependency"
      ? ["bytes", "kind", "metafileDescriptorSha256", "package", "path", "sha256"]
      : ["bytes", "kind", "metafileDescriptorSha256", "path", "sha256"];
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      !["dependency", "snapshot"].includes(entry.kind) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > MAX_INPUT_BYTES ||
      !HASH.test(entry.sha256) ||
      !HASH.test(entry.metafileDescriptorSha256) ||
      (entry.kind === "dependency" && (typeof entry.package !== "string" || entry.package.length === 0))
    ) {
      throw new CanaryBundleInputError(code, "the persisted bundle input graph is malformed");
    }
    const order = `${entry.kind}\0${entry.path}`;
    if (prior !== null && order.localeCompare(prior) <= 0) {
      throw new CanaryBundleInputError(code, "the persisted bundle input graph is unsorted or duplicated");
    }
    prior = order;
  }
  prior = null;
  for (const entry of builtins) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== ["metafileDescriptorSha256", "name"].join("\0") ||
      typeof entry.name !== "string" ||
      !/^[a-z0-9_./-]+$/u.test(entry.name) ||
      !HASH.test(entry.metafileDescriptorSha256) ||
      (prior !== null && entry.name.localeCompare(prior) <= 0)
    ) {
      throw new CanaryBundleInputError(code, "the persisted builtin graph is malformed, unsorted, or duplicated");
    }
    prior = entry.name;
  }
}

function validatePersistedOutputs(outputs, inputs, sourceEntrypoint) {
  let prior = null;
  const seenCaseFoldedPaths = new Set();
  const inputKeys = new Set(inputs.map((input) => `${input.kind}\0${input.path}`));
  for (const output of outputs) {
    const allowed = new Set([
      "bytes",
      "cssBundle",
      "entryPoint",
      "exports",
      "imports",
      "inputContributions",
      "path",
      "sha256",
    ]);
    if (
      !isRecord(output) ||
      Object.keys(output).some((key) => !allowed.has(key)) ||
      typeof output.path !== "string" ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 1 ||
      output.bytes > MAX_INPUT_BYTES ||
      !HASH.test(output.sha256) ||
      !Array.isArray(output.imports) ||
      !Array.isArray(output.exports) ||
      output.exports.some((entry) => typeof entry !== "string" || entry.length > 1_000) ||
      !Array.isArray(output.inputContributions) ||
      (prior !== null && output.path.localeCompare(prior) <= 0)
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted output inventory is malformed");
    }
    normalizeArtifactRelativePath(output.path, "BUNDLE_INPUTS_MANIFEST_INVALID");
    const caseFoldedPath = output.path.toLowerCase();
    if (seenCaseFoldedPaths.has(caseFoldedPath)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "persisted outputs alias one path");
    }
    seenCaseFoldedPaths.add(caseFoldedPath);
    for (const edge of output.imports) validatePersistedOutputImport(edge);
    let priorContribution = null;
    for (const contribution of output.inputContributions) {
      if (
        !isRecord(contribution) ||
        Object.keys(contribution).sort().join("\0") !== ["bytesInOutput", "kind", "path"].join("\0") ||
        !["snapshot", "dependency"].includes(contribution.kind) ||
        typeof contribution.path !== "string" ||
        contribution.path.length === 0 ||
        !Number.isSafeInteger(contribution.bytesInOutput) ||
        contribution.bytesInOutput < 0 ||
        !inputKeys.has(`${contribution.kind}\0${contribution.path}`)
      ) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "an output contribution is malformed");
      }
      const contributionOrder = `${contribution.kind}\0${contribution.path}`;
      if (priorContribution !== null && contributionOrder.localeCompare(priorContribution) <= 0) {
        throw new CanaryBundleInputError(
          "BUNDLE_INPUTS_MANIFEST_INVALID",
          "persisted output contributions are unsorted or duplicated",
        );
      }
      priorContribution = contributionOrder;
    }
    if (
      output.entryPoint !== undefined &&
      (!isRecord(output.entryPoint) ||
        Object.keys(output.entryPoint).sort().join("\0") !== ["kind", "path"].join("\0") ||
        !["snapshot", "dependency"].includes(output.entryPoint.kind) ||
        typeof output.entryPoint.path !== "string" ||
        output.entryPoint.path.length === 0)
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "an output entrypoint is malformed");
    }
    if (output.cssBundle !== undefined) {
      throw new CanaryBundleInputError(
        "BUNDLE_INPUTS_MANIFEST_INVALID",
        "the persisted graph contains an unsupported CSS bundle output",
      );
    }
    prior = output.path;
  }
  if (outputs.filter((output) => output.entryPoint !== undefined).length !== 1) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted output graph does not have exactly one entrypoint");
  }
  const entry = outputs.find((output) => output.entryPoint !== undefined);
  if (entry.entryPoint.kind !== "snapshot" || entry.entryPoint.path !== sourceEntrypoint) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the persisted output entrypoint is not bound to the configured snapshot entrypoint",
    );
  }
}

function validatePersistedOutputImport(edge) {
  const allowed = new Set(["external", "kind", "path", "target"]);
  if (
    !isRecord(edge) ||
    Object.keys(edge).some((key) => !allowed.has(key)) ||
    typeof edge.path !== "string" ||
    edge.path.length === 0 ||
    typeof edge.kind !== "string" ||
    edge.kind.length === 0 ||
    (edge.external !== undefined && typeof edge.external !== "boolean")
  ) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a persisted output import edge is malformed");
  }
  if (edge.target === undefined) {
    if (edge.external !== true || !RUNTIME_EXTERNALS.has(edge.path) || isStrictRelativeSpecifier(edge.path)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "an output import without a target is not a closed runtime external");
    }
    return;
  }
  const externalKeys = [
    "bytes",
    "globIndex",
    "path",
    "ruleGlob",
    "ruleIndex",
    "sha256",
    "sourceBytes",
    "sourcePath",
    "sourceSha256",
    "type",
  ].sort();
  const ordinaryKeys = ["bytes", "path", "sha256"];
  const expectedKeys = edge.external === true ? externalKeys : ordinaryKeys;
  if (
    !isRecord(edge.target) ||
    Object.keys(edge.target).sort().join("\0") !== expectedKeys.join("\0") ||
    !Number.isSafeInteger(edge.target.bytes) ||
    edge.target.bytes < 1 ||
    edge.target.bytes > MAX_INPUT_BYTES ||
    !HASH.test(edge.target.sha256)
  ) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "an output import target is malformed");
  }
  normalizeArtifactRelativePath(edge.target.path, "BUNDLE_INPUTS_MANIFEST_INVALID");
  if (edge.external === true) {
    if (!isStrictRelativeSpecifier(edge.path)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a local external target has a non-relative specifier");
    }
    normalizeExternalTargetProvenance(edge.target, "BUNDLE_INPUTS_MANIFEST_INVALID");
  }
}

function validatePersistedModulePolicy(policy, expectedSha256) {
  const expectedKeys = ["compatibilityFlags", "findAdditionalModules", "preserveFileNames", "rules"].sort();
  if (
    !isRecord(policy) ||
    Object.keys(policy).sort().join("\0") !== expectedKeys.join("\0") ||
    policy.preserveFileNames !== false ||
    policy.findAdditionalModules !== false ||
    !Array.isArray(policy.compatibilityFlags) ||
    policy.compatibilityFlags.length === 0 ||
    policy.compatibilityFlags.some((flag) =>
      typeof flag !== "string" || !/^[a-z0-9_-]+$/u.test(flag)) ||
    !policy.compatibilityFlags.includes("nodejs_compat") ||
    new Set(policy.compatibilityFlags).size !== policy.compatibilityFlags.length ||
    !Array.isArray(policy.rules) ||
    policy.rules.length === 0 ||
    sha256(Buffer.from(canonicalJson(policy))) !== expectedSha256
  ) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted module policy is malformed or has changed");
  }
  const seenTypes = new Set();
  const seenSelectors = new Set();
  let priorRuleIndex = -1;
  let priorGlobIndex = -1;
  let currentType = null;
  for (let index = 0; index < policy.rules.length; index += 1) {
    const rule = policy.rules[index];
    if (
      !isRecord(rule) ||
      Object.keys(rule).sort().join("\0") !== ["glob", "globIndex", "ruleIndex", "type"].join("\0") ||
      !SOURCE_MODULE_TYPES.has(rule.type) ||
      typeof rule.glob !== "string" ||
      !Number.isSafeInteger(rule.ruleIndex) ||
      rule.ruleIndex < 0 ||
      !Number.isSafeInteger(rule.globIndex) ||
      rule.globIndex < 0 ||
      rule.glob.length === 0 ||
      rule.glob.length > 1_000 ||
      rule.glob.includes("\\") ||
      rule.glob.includes("\0") ||
      path.posix.isAbsolute(rule.glob) ||
      /^[A-Za-z]:/u.test(rule.glob) ||
      /^[a-z][a-z0-9+.-]*:/iu.test(rule.glob) ||
      !/^[A-Za-z0-9._/*-]+$/u.test(rule.glob) ||
      rule.glob.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a persisted module rule is malformed");
    }
    if (rule.ruleIndex === priorRuleIndex) {
      if (rule.globIndex !== priorGlobIndex + 1 || rule.type !== currentType) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "persisted module-rule indices are not contiguous");
      }
    } else {
      if (rule.ruleIndex !== priorRuleIndex + 1 || rule.globIndex !== 0 || seenTypes.has(rule.type)) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "persisted module rules are reordered or same-type shadowed");
      }
      seenTypes.add(rule.type);
      currentType = rule.type;
    }
    const selector = `${rule.type}\0${rule.glob}`;
    if (seenSelectors.has(selector)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "persisted module rules contain a duplicate selector");
    }
    seenSelectors.add(selector);
    priorRuleIndex = rule.ruleIndex;
    priorGlobIndex = rule.globIndex;
  }
}

function validatePersistedSourceModules(modules, rules) {
  let prior = null;
  for (const module of modules) {
    const expectedKeys = [
      "bytes",
      "globIndex",
      "references",
      "ruleGlob",
      "ruleIndex",
      "sha256",
      "sourcePath",
      "type",
    ].sort();
    if (
      !isRecord(module) ||
      Object.keys(module).sort().join("\0") !== expectedKeys.join("\0") ||
      !Number.isSafeInteger(module.bytes) ||
      module.bytes < 1 ||
      module.bytes > MAX_INPUT_BYTES ||
      !HASH.test(module.sha256) ||
      !SOURCE_MODULE_TYPES.has(module.type) ||
      typeof module.sourcePath !== "string" ||
      (prior !== null && module.sourcePath.localeCompare(prior) <= 0) ||
      !Array.isArray(module.references) ||
      module.references.length === 0
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a persisted source module is malformed or unsorted");
    }
    normalizeArtifactRelativePath(module.sourcePath, "BUNDLE_INPUTS_MANIFEST_INVALID");
    const rule = rules.find((candidate) =>
      candidate.ruleIndex === module.ruleIndex && candidate.globIndex === module.globIndex);
    if (rule?.type !== module.type || rule.glob !== module.ruleGlob) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a source module is not bound to its persisted rule");
    }
    let priorReference = null;
    for (const reference of module.references) {
      if (
        !isRecord(reference) ||
        Object.keys(reference).sort().join("\0") !== ["importSpecifier", "importerPath", "kind"].join("\0") ||
        typeof reference.importerPath !== "string" ||
        typeof reference.importSpecifier !== "string" ||
        !["import-statement", "require-call"].includes(reference.kind) ||
        !pinnedBundleGlobMatches(module.ruleGlob, reference.importSpecifier)
      ) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a source module reference is malformed");
      }
      normalizeArtifactRelativePath(reference.importerPath, "BUNDLE_INPUTS_MANIFEST_INVALID");
      const order = `${reference.importerPath}\0${reference.importSpecifier}\0${reference.kind}`;
      if (priorReference !== null && order.localeCompare(priorReference) <= 0) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "source module references are unsorted or duplicated");
      }
      priorReference = order;
    }
    prior = module.sourcePath;
  }
}

function validatePersistedSelection(selection, outputs, sourceModules) {
  if (
    !isRecord(selection) ||
    Object.keys(selection).sort().join("\0") !== ["entry", "modules"].join("\0") ||
    !Array.isArray(selection.modules)
  ) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted reviewed selection is malformed");
  }
  const entry = normalizeReviewedIdentity(selection.entry, false, "BUNDLE_INPUTS_MANIFEST_INVALID");
  const modules = selection.modules.map((module) =>
    normalizeReviewedIdentity(module, true, "BUNDLE_INPUTS_MANIFEST_INVALID"));
  if (
    canonicalJson(entry) !== canonicalJson(selection.entry) ||
    modules.some((module, index) => canonicalJson(module) !== canonicalJson(selection.modules[index])) ||
    modules.some((module, index) => index > 0 && module.path.localeCompare(modules[index - 1].path) <= 0) ||
    new Set([entry.path, ...modules.map((module) => module.path)]).size !== modules.length + 1
  ) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted reviewed selection is non-canonical");
  }
  const graphSelection = derivePersistedGraphSelection(outputs, sourceModules);
  if (
    canonicalJson(entry) !== canonicalJson(graphSelection.entry) ||
    canonicalJson(modules) !== canonicalJson(graphSelection.modules)
  ) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the persisted reviewed selection is not the complete reachable output graph",
    );
  }
}

function validatePersistedRawFiles(rawFiles, outputs, selection) {
  const allowedRoles = new Set([
    "entry-output",
    "reachable-esm-output",
    "source-map-byproduct",
    "source-rule-module",
    "wrangler-readme-byproduct",
  ]);
  const expected = new Map([
    [selection.entry.path, { ...selection.entry, role: "entry-output" }],
    ...selection.modules.map((module) => [module.path, {
      ...module,
      role: module.provenance.kind === "metafile-output"
        ? "reachable-esm-output"
        : "source-rule-module",
    }]),
  ]);
  const outputByPath = new Map(outputs.map((output) => [output.path, output]));
  for (const selectedPath of [selection.entry.path, ...selection.modules
    .filter((module) => module.provenance.kind === "metafile-output")
    .map((module) => module.path)]) {
    const mapOutput = outputByPath.get(`${selectedPath}.map`);
    if (mapOutput === undefined) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the raw census has no required source-map identity");
    }
    expected.set(mapOutput.path, { ...mapOutput, role: "source-map-byproduct" });
  }
  let prior = null;
  let readmeCount = 0;
  const seen = new Set();
  for (const file of rawFiles) {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join("\0") !== ["bytes", "path", "role", "sha256"].join("\0") ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_INPUT_BYTES ||
      !HASH.test(file.sha256) ||
      !allowedRoles.has(file.role) ||
      (prior !== null && file.path.localeCompare(prior) <= 0)
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted raw-file census is malformed or unsorted");
    }
    normalizeArtifactRelativePath(file.path, "BUNDLE_INPUTS_MANIFEST_INVALID");
    if (seen.has(file.path)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the raw census repeats one path");
    }
    seen.add(file.path);
    if (file.role === "wrangler-readme-byproduct") {
      if (file.path !== "README.md" || expected.has(file.path)) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the Wrangler README role aliases graph content");
      }
      readmeCount += 1;
    } else {
      const identity = expected.get(file.path);
      if (
        identity === undefined ||
        identity.role !== file.role ||
        identity.bytes !== file.bytes ||
        identity.sha256 !== file.sha256
      ) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a raw census role or identity differs from the graph");
      }
    }
    prior = file.path;
  }
  if (readmeCount !== 1 || [...expected.keys()].some((candidate) => !seen.has(candidate))) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the raw census silently omits a graph-bound file");
  }
}

function derivePersistedGraphSelection(outputs, sourceModules) {
  const outputByPath = new Map(outputs.map((output) => [output.path, output]));
  const entryOutputs = outputs.filter((output) => output.entryPoint !== undefined);
  if (entryOutputs.length !== 1) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted graph has no unique entry output");
  }
  const entryOutput = entryOutputs[0];
  if (!/\.(?:m?js)$/u.test(entryOutput.path) || entryOutput.path.includes("/")) {
    throw new CanaryBundleInputError(
      "BUNDLE_INPUTS_MANIFEST_INVALID",
      "the persisted entry is not one supported root JavaScript output",
    );
  }
  const reachable = new Set();
  const external = new Map();
  const pending = [entryOutput.path];
  while (pending.length > 0) {
    const currentPath = pending.shift();
    if (reachable.has(currentPath)) continue;
    const current = outputByPath.get(currentPath);
    if (current === undefined) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted graph reaches an undeclared output");
    }
    reachable.add(currentPath);
    if (!/\.(?:m?js)$/u.test(current.path)) {
      throw new CanaryBundleInputError(
        "BUNDLE_INPUTS_MANIFEST_INVALID",
        "the persisted graph reaches a non-JavaScript output",
      );
    }
    for (const edge of current.imports) {
      if (edge.target === undefined) continue;
      if (edge.external === true) {
        if (
          outputByPath.has(edge.target.path) ||
          edge.target.path === "README.md" ||
          edge.target.path.endsWith(".map")
        ) {
          throw new CanaryBundleInputError(
            "BUNDLE_INPUTS_MANIFEST_INVALID",
            "a persisted external target aliases a declared output or reserved Wrangler by-product",
          );
        }
        if (edge.kind !== "import-statement" && edge.kind !== "require-call") {
          throw new CanaryBundleInputError(
            "BUNDLE_INPUTS_MANIFEST_INVALID",
            "a persisted local external uses an unsupported edge kind",
          );
        }
        assertCanonicalRuntimeSpecifier(
          current.path,
          edge.path,
          edge.target.path,
          "BUNDLE_INPUTS_MANIFEST_INVALID",
        );
        const prior = external.get(edge.target.path);
        if (prior !== undefined && canonicalJson(prior) !== canonicalJson(edge.target)) {
          throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a persisted external target has conflicting identities");
        }
        external.set(edge.target.path, edge.target);
      } else {
        // `edge.path` is esbuild's metafile-base-relative name, not the emitted runtime
        // specifier. Without persisting that machine-local base, guessing a basename relation
        // would be unsound; exact target identity drives closure and the reviewed JS AST later
        // proves the emitter-relative runtime specifier.
        const targetOutput = outputByPath.get(edge.target.path);
        if (targetOutput === undefined) {
          throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a persisted chunk edge targets an undeclared output");
        }
        if (
          targetOutput.bytes !== edge.target.bytes ||
          targetOutput.sha256 !== edge.target.sha256
        ) {
          throw new CanaryBundleInputError(
            "BUNDLE_INPUTS_MANIFEST_INVALID",
            "a persisted chunk edge contradicts its declared output identity",
          );
        }
        pending.push(edge.target.path);
      }
    }
  }
  for (const reachablePath of reachable) {
    const sourceMap = outputByPath.get(`${reachablePath}.map`);
    if (
      sourceMap === undefined ||
      sourceMap.entryPoint !== undefined ||
      sourceMap.cssBundle !== undefined ||
      sourceMap.imports.length !== 0 ||
      sourceMap.exports.length !== 0 ||
      sourceMap.inputContributions.length !== 0
    ) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "a reachable output has no exact empty source map");
    }
  }
  for (const output of outputs) {
    if (reachable.has(output.path)) continue;
    const mappedPath = output.path.endsWith(".map") ? output.path.slice(0, -4) : null;
    if (mappedPath === null || !reachable.has(mappedPath)) {
      throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted output inventory contains an orphan output");
    }
  }
  const sourceByPath = new Map(sourceModules.map((source) => [source.sourcePath, source]));
  const usedSources = new Set();
  const modules = [
    ...[...reachable]
      .filter((candidate) => candidate !== entryOutput.path)
      .map((candidate) => {
        const output = outputByPath.get(candidate);
        return {
          path: output.path,
          bytes: output.bytes,
          sha256: output.sha256,
          type: "ESModule",
          provenance: { kind: "metafile-output" },
        };
      }),
    ...[...external.values()].map((target) => {
      const source = sourceByPath.get(target.sourcePath);
      if (
        source === undefined ||
        source.bytes !== target.sourceBytes ||
        source.sha256 !== target.sourceSha256 ||
        source.bytes !== target.bytes ||
        source.sha256 !== target.sha256 ||
        source.type !== target.type ||
        source.ruleGlob !== target.ruleGlob ||
        source.ruleIndex !== target.ruleIndex ||
        source.globIndex !== target.globIndex
      ) {
        throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "an external target lost exact source-rule/byte provenance");
      }
      usedSources.add(source.sourcePath);
      return {
        path: target.path,
        bytes: target.bytes,
        sha256: target.sha256,
        type: target.type,
        provenance: {
          kind: "snapshot-module-rule",
          sourcePath: target.sourcePath,
          sourceBytes: target.sourceBytes,
          sourceSha256: target.sourceSha256,
          ruleGlob: target.ruleGlob,
          ruleIndex: target.ruleIndex,
          globIndex: target.globIndex,
        },
      };
    }),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (usedSources.size !== sourceModules.length) {
    throw new CanaryBundleInputError("BUNDLE_INPUTS_MANIFEST_INVALID", "the persisted graph silently omits a source module");
  }
  return {
    entry: { path: entryOutput.path, bytes: entryOutput.bytes, sha256: entryOutput.sha256 },
    modules,
  };
}

function normalizeModuleProvenance(value, code) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new CanaryBundleInputError(code, "a reviewed module has no closed provenance");
  }
  if (value.kind === "metafile-output") {
    if (Object.keys(value).join("\0") !== "kind") {
      throw new CanaryBundleInputError(code, "a reviewed chunk provenance is open");
    }
    return { kind: "metafile-output" };
  }
  const expected = [
    "globIndex",
    "kind",
    "ruleGlob",
    "ruleIndex",
    "sourceBytes",
    "sourcePath",
    "sourceSha256",
  ].sort();
  if (
    value.kind !== "snapshot-module-rule" ||
    Object.keys(value).sort().join("\0") !== expected.join("\0")
  ) {
    throw new CanaryBundleInputError(code, "a reviewed external module provenance is open or unsupported");
  }
  normalizeExternalTargetProvenance(value, code);
  return { ...value };
}

function normalizeExternalTargetProvenance(value, code) {
  if (
    (value.type !== undefined && !SOURCE_MODULE_TYPES.has(value.type)) ||
    typeof value.sourcePath !== "string" ||
    !Number.isSafeInteger(value.sourceBytes) ||
    value.sourceBytes < 1 ||
    value.sourceBytes > MAX_INPUT_BYTES ||
    !HASH.test(value.sourceSha256) ||
    typeof value.ruleGlob !== "string" ||
    !Number.isSafeInteger(value.ruleIndex) ||
    value.ruleIndex < 0 ||
    !Number.isSafeInteger(value.globIndex) ||
    value.globIndex < 0
  ) {
    throw new CanaryBundleInputError(code, "external module source-rule provenance is malformed");
  }
  normalizeArtifactRelativePath(value.sourcePath, code);
}

function inventoryRegularFiles(directory) {
  const root = path.resolve(directory);
  const files = [];
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw new CanaryBundleInputError(
        "REVIEWED_BUNDLE_INVALID",
        "the reviewed bundle could not be enumerated",
      );
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = portableRelative(root, absolute);
      normalizeArtifactRelativePath(relative, "REVIEWED_BUNDLE_FILE_INVALID");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new CanaryBundleInputError(
          "REVIEWED_BUNDLE_FILE_INVALID",
          "the reviewed bundle must not contain links or junctions",
        );
      }
      let real;
      try {
        real = realpathSync.native(absolute);
      } catch {
        throw new CanaryBundleInputError(
          "REVIEWED_BUNDLE_FILE_INVALID",
          "a reviewed bundle path has no real path",
        );
      }
      if (!samePath(real, absolute)) {
        throw new CanaryBundleInputError(
          "REVIEWED_BUNDLE_FILE_INVALID",
          "the reviewed bundle path was substituted",
        );
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(relative);
      else {
        throw new CanaryBundleInputError(
          "REVIEWED_BUNDLE_FILE_INVALID",
          "the reviewed bundle contains a non-regular path",
        );
      }
    }
  };
  visit(root);
  return files.sort();
}

function portableRelative(root, candidate) {
  return path.relative(path.resolve(root), path.resolve(candidate)).split(path.sep).join("/");
}

function isWithinOrEqual(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireWithinOrEqual(candidate, root, code) {
  if (!isWithinOrEqual(candidate, root)) {
    throw new CanaryBundleInputError(code, "a bundle path is outside its trusted boundary");
  }
}

function requireStrictlyWithin(candidate, root, code) {
  if (samePath(candidate, root) || !isWithinOrEqual(candidate, root)) {
    throw new CanaryBundleInputError(code, "a bundle path is not a strict child of its trusted boundary");
  }
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
