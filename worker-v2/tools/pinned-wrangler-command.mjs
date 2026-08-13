import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cloudflare deployment-toolchain adapter.
 *
 * This pin is intentionally installation- and platform-shaped: Windows x64, the repository's
 * npm-lockfile layout, and the exact Node 24 executable installed on the reviewed machine. It is
 * not a portable Wrangler detector. A different OS, CPU, Node build, lockfile, package layout, or
 * dependency tree must receive a separately reviewed adapter and checked-in inventory hash. The
 * denominator intentionally includes both Wrangler's production closure and the root TypeScript
 * compiler package executed by the canary control programs; package-lock bytes alone do not attest
 * the installed compiler bytes.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const REPOSITORY_ROOT = path.resolve(WORKER_ROOT, "..");
const LOCAL_PACKAGE_LOCK = path.join(REPOSITORY_ROOT, "package-lock.json");
const LOCAL_PACKAGE_JSON = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "package.json");
const LOCAL_TYPESCRIPT_PACKAGE_JSON = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "typescript",
  "package.json",
);
const LOCAL_TYPESCRIPT_ENTRYPOINT = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "typescript",
  "lib",
  "typescript.js",
);
const requireFromWorker = createRequire(path.join(WORKER_ROOT, "package.json"));

export const PINNED_WRANGLER_TOOLCHAIN_SCHEMA =
  "survey-qa-pinned-deployment-toolchain/windows-x64/1.1.0";
export const EXPECTED_WRANGLER_PLATFORM = "win32";
export const EXPECTED_WRANGLER_ARCH = "x64";
export const EXPECTED_NODE_VERSION = "v24.18.0";
export const EXPECTED_NODE_EXECUTABLE_SHA256 =
  "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de";
export const EXPECTED_NODE_TEST_RUNNER_CONTEXT = "child-v8";
export const EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT = 23;
export const EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_EXEC_ARGV_COUNT = 25;
export const EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256 =
  "4b07dbf6a928cc41b38408c4ba66ddb24de4b734274ce03f7e207df756eeec98";
export const EXPECTED_NODE_TEST_RUNNER_SERIAL_EXEC_ARGV_SHA256 =
  "e08ebfd6e96f60193ed7c886b14517320be5546b38b4364915da7f9a8758b3c7";
export const EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_DIRECT_EXEC_ARGV_SHA256 =
  "2b7f156a2556c7a60ae59a554cdb2bfb94a9fbcbcf037cefe687a319b0d3bbd7";
export const EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_SERIAL_EXEC_ARGV_SHA256 =
  "244d4d08e28016f93c80cb015f42518f749fbf8487cf86b75d89412519205773";
export const EXPECTED_NODE_TEST_RUNNER_VECTORS = Object.freeze([
  Object.freeze({
    id: "direct-node-test",
    parentInvocation: "node --test",
    context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
    execArgvCount: EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT,
    testConcurrencyFlag: "--test-concurrency=0",
    testForceExitCount: 0,
    execArgvSha256: EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256,
  }),
  Object.freeze({
    id: "visual-manifest-serial",
    parentInvocation: "node --test --test-concurrency=1",
    context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
    execArgvCount: EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT,
    testConcurrencyFlag: "--test-concurrency=1",
    testForceExitCount: 0,
    execArgvSha256: EXPECTED_NODE_TEST_RUNNER_SERIAL_EXEC_ARGV_SHA256,
  }),
  Object.freeze({
    id: "direct-node-test-force-exit",
    parentInvocation: "node --test --test-force-exit",
    context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
    execArgvCount: EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_EXEC_ARGV_COUNT,
    testConcurrencyFlag: "--test-concurrency=0",
    testForceExitCount: 2,
    execArgvSha256: EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_DIRECT_EXEC_ARGV_SHA256,
  }),
  Object.freeze({
    id: "visual-manifest-serial-force-exit",
    parentInvocation: "node --test --test-concurrency=1 --test-force-exit",
    context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
    execArgvCount: EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_EXEC_ARGV_COUNT,
    testConcurrencyFlag: "--test-concurrency=1",
    testForceExitCount: 2,
    execArgvSha256: EXPECTED_NODE_TEST_RUNNER_FORCE_EXIT_SERIAL_EXEC_ARGV_SHA256,
  }),
]);
// Backward-compatible aliases for existing audit readers. The named vector descriptors above are
// the authority and prevent the default runner hash from being mistaken for the serial one.
export const EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256 =
  EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256;
export const EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256_SET = Object.freeze([
  ...EXPECTED_NODE_TEST_RUNNER_VECTORS.map((vector) => vector.execArgvSha256),
]);
export const EXPECTED_PACKAGE_LOCK_SHA256 =
  "4da58287634272865b3b32a45129f9c135a7ac2c36a98f229609f4ff194aabf2";
export const EXPECTED_WRANGLER_VERSION = "4.106.0";
export const EXPECTED_WRANGLER_PACKAGE_JSON_SHA256 =
  "f8649c300b9e1402fc86cac6629fdfc305919cd490627cf718b3805c3e4a8c9a";
export const EXPECTED_WRANGLER_BIN_SHA256 =
  "72d02815cbffc9ad14e1667188296e7126e13f0d90bfbb6046db8e6c4b6ff39a";
export const EXPECTED_WRANGLER_CLI_SHA256 =
  "e95c51afe405114b4da0fd62f08d1d55d2ef04ca81745f686f3ea9cd28db3a8e";
export const EXPECTED_TYPESCRIPT_VERSION = "5.9.3";
export const EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256 =
  "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6";
export const EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256 =
  "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
// Generated from derivePinnedWranglerToolchainInventory() over the exact lockfile/tree above.
// Updating this value is a security review action, never an automatic install-time operation.
export const EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256 =
  "3c9a6a367bd88ac56cd5d57e663250c3a4b9a8d6148e5fc15182c5f77222aa40";
export const EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT = 35;
export const EXPECTED_WRANGLER_BIN_DECLARATION = Object.freeze({
  "cf-wrangler": "./bin/cf-wrangler.js",
  wrangler: "./bin/wrangler.js",
  wrangler2: "./bin/wrangler.js",
});

export const PINNED_WRANGLER_DESCRIPTOR_KEYS = Object.freeze([
  "argsPrefix",
  "binPath",
  "cliPath",
  "command",
  "evidence",
  "packageJsonPath",
  "packageLockPath",
  "packageRoot",
  "typescriptEntrypointPath",
  "typescriptPackageJsonPath",
  "typescriptPackageRoot",
  "version",
]);
export const PINNED_WRANGLER_EVIDENCE_KEYS = Object.freeze([
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
]);

const WRANGLER_LOCK_LOCATION = "node_modules/wrangler";
const WRANGLER_CLI_RELATIVE_PATH = "wrangler-dist/cli.js";
const TYPESCRIPT_LOCK_LOCATION = "node_modules/typescript";
const TYPESCRIPT_ENTRYPOINT_RELATIVE_PATH = "lib/typescript.js";
const MAX_PACKAGE_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_TOOLCHAIN_PACKAGE_COUNT = 256;
const MAX_TOOLCHAIN_ENTRY_COUNT = 20_000;
const MAX_TOOLCHAIN_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOOLCHAIN_TOTAL_BYTES = 1024 * 1024 * 1024;

export class PinnedWranglerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinnedWranglerError";
    this.code = code;
  }
}

/** Resolve the one production installation. No test-controlled expected identity enters this path. */
export function resolvePinnedWranglerCommand() {
  const runtime = currentRuntime();
  assertPinnedWranglerRuntime(runtime);
  return resolveInstalledToolchain(runtime);
}

/**
 * Resolve the same installation before importing TypeScript. This has one narrow accommodation
 * for Node 24.18.0's exact built-in test-child execArgv vector, because ESM dependencies execute
 * before a node:test body can inject a parser. Production command selection remains strict and
 * still calls resolvePinnedWranglerCommand(), which rejects every non-empty execArgv vector.
 */
export function resolvePinnedTypeScriptToolchain() {
  const runtime = currentRuntime();
  assertPinnedTypeScriptImportRuntime(runtime);
  return resolveInstalledToolchain(runtime);
}

function resolveInstalledToolchain(runtime) {
  let resolvedPackageJson;
  let resolvedTypeScriptPackageJson;
  let resolvedTypeScriptEntrypoint;
  try {
    resolvedPackageJson = requireFromWorker.resolve("wrangler/package.json");
  } catch {
    refuse("WRANGLER_PACKAGE_UNAVAILABLE", "the repository-local Wrangler package could not be resolved");
  }
  try {
    resolvedTypeScriptPackageJson = requireFromWorker.resolve("typescript/package.json");
    resolvedTypeScriptEntrypoint = requireFromWorker.resolve("typescript");
  } catch {
    refuse("TYPESCRIPT_PACKAGE_UNAVAILABLE", "the repository-local TypeScript package could not be resolved");
  }
  if (!samePath(resolvedPackageJson, LOCAL_PACKAGE_JSON)) {
    refuse(
      "WRANGLER_PACKAGE_SUBSTITUTED",
      "Wrangler resolved somewhere other than the repository-local pinned package",
    );
  }
  if (
    !samePath(resolvedTypeScriptPackageJson, LOCAL_TYPESCRIPT_PACKAGE_JSON) ||
    !samePath(resolvedTypeScriptEntrypoint, LOCAL_TYPESCRIPT_ENTRYPOINT)
  ) {
    refuse(
      "TYPESCRIPT_PACKAGE_SUBSTITUTED",
      "TypeScript resolved somewhere other than the repository-local pinned package",
    );
  }
  const descriptor = inspectPinnedWranglerPackageWithValidatedRuntime(LOCAL_PACKAGE_JSON, {
    trustedRoot: REPOSITORY_ROOT,
    runtime,
  });
  if (
    !samePath(descriptor.typescriptPackageJsonPath, resolvedTypeScriptPackageJson) ||
    !samePath(descriptor.typescriptEntrypointPath, resolvedTypeScriptEntrypoint)
  ) {
    refuse("TYPESCRIPT_PACKAGE_SUBSTITUTED", "resolved TypeScript paths differ from reviewed paths");
  }
  return descriptor;
}

/**
 * Recompute the complete installation identity and compare it with a descriptor captured earlier.
 * Call this immediately before every spawn; a successful earlier check is never an attestation of
 * bytes read later by Node or Wrangler.
 */
export function verifyPinnedWranglerCommand(expectedDescriptor) {
  const expected = assertPinnedWranglerDescriptor(expectedDescriptor);
  const actual = resolvePinnedWranglerCommand();
  if (canonicalize(descriptorIdentity(actual)) !== canonicalize(descriptorIdentity(expected))) {
    refuse("WRANGLER_TOOLCHAIN_DRIFT", "the pinned Wrangler toolchain changed after it was selected");
  }
  return actual;
}

/** Validate the complete immutable descriptor shared by every deployment control-plane gate. */
export function assertPinnedWranglerDescriptor(value) {
  if (
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    canonicalize(Object.keys(value).sort()) !== canonicalize(PINNED_WRANGLER_DESCRIPTOR_KEYS) ||
    value.command !== process.execPath ||
    value.version !== EXPECTED_WRANGLER_VERSION ||
    !Array.isArray(value.argsPrefix) ||
    !Object.isFrozen(value.argsPrefix) ||
    value.argsPrefix.length !== 1 ||
    !samePath(value.argsPrefix[0] ?? "", value.cliPath ?? "")
  ) {
    refuse("WRANGLER_DESCRIPTOR_INVALID", "pinned Wrangler descriptor is malformed");
  }
  for (const candidate of [
    value.packageRoot,
    value.packageJsonPath,
    value.packageLockPath,
    value.binPath,
    value.cliPath,
    value.typescriptPackageRoot,
    value.typescriptPackageJsonPath,
    value.typescriptEntrypointPath,
  ]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
      refuse("WRANGLER_DESCRIPTOR_INVALID", "pinned Wrangler descriptor paths are not exact and absolute");
    }
  }
  const repositoryRoot = path.dirname(path.dirname(value.packageRoot));
  if (
    !samePath(value.packageJsonPath, path.join(value.packageRoot, "package.json")) ||
    !samePath(value.binPath, path.join(value.packageRoot, "bin", "wrangler.js")) ||
    !samePath(value.cliPath, path.join(value.packageRoot, ...WRANGLER_CLI_RELATIVE_PATH.split("/"))) ||
    !samePath(value.packageLockPath, path.join(repositoryRoot, "package-lock.json")) ||
    !samePath(value.typescriptPackageRoot, path.join(repositoryRoot, ...TYPESCRIPT_LOCK_LOCATION.split("/"))) ||
    !samePath(value.typescriptPackageJsonPath, path.join(value.typescriptPackageRoot, "package.json")) ||
    !samePath(
      value.typescriptEntrypointPath,
      path.join(value.typescriptPackageRoot, ...TYPESCRIPT_ENTRYPOINT_RELATIVE_PATH.split("/")),
    )
  ) {
    refuse("WRANGLER_DESCRIPTOR_INVALID", "pinned Wrangler descriptor paths are incoherent");
  }
  const evidence = value.evidence;
  if (
    !isRecord(evidence) ||
    !Object.isFrozen(evidence) ||
    canonicalize(Object.keys(evidence).sort()) !== canonicalize(PINNED_WRANGLER_EVIDENCE_KEYS) ||
    evidence.packageJsonSha256 !== EXPECTED_WRANGLER_PACKAGE_JSON_SHA256 ||
    evidence.binSha256 !== EXPECTED_WRANGLER_BIN_SHA256 ||
    evidence.cliSha256 !== EXPECTED_WRANGLER_CLI_SHA256 ||
    evidence.packageLockSha256 !== EXPECTED_PACKAGE_LOCK_SHA256 ||
    evidence.toolchainInventorySha256 !== EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256 ||
    evidence.nodeExecutableSha256 !== EXPECTED_NODE_EXECUTABLE_SHA256 ||
    evidence.typescriptPackageJsonSha256 !== EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256 ||
    evidence.typescriptEntrypointSha256 !== EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256 ||
    evidence.platform !== EXPECTED_WRANGLER_PLATFORM ||
    evidence.arch !== EXPECTED_WRANGLER_ARCH ||
    evidence.nodeVersion !== EXPECTED_NODE_VERSION ||
    evidence.typescriptVersion !== EXPECTED_TYPESCRIPT_VERSION ||
    evidence.packageCount !== EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT ||
    !Number.isSafeInteger(evidence.entryCount) ||
    evidence.entryCount <= 0
  ) {
    refuse("WRANGLER_DESCRIPTOR_INVALID", "pinned Wrangler evidence is not the exact reviewed toolchain");
  }
  return value;
}

/**
 * Validate an exact-layout copy of the reviewed installation. Exported for mutation fixtures;
 * expected hashes remain module constants and cannot be supplied by the caller.
 */
export function inspectPinnedWranglerPackage(packageJsonPath, {
  trustedRoot,
  runtime = currentRuntime(),
} = {}) {
  assertPinnedWranglerRuntime(runtime);
  return inspectPinnedWranglerPackageWithValidatedRuntime(packageJsonPath, {
    trustedRoot,
    runtime,
  });
}

function inspectPinnedWranglerPackageWithValidatedRuntime(packageJsonPath, {
  trustedRoot,
  runtime,
}) {
  if (typeof packageJsonPath !== "string" || packageJsonPath.length === 0) {
    refuse("WRANGLER_PACKAGE_PATH_INVALID", "Wrangler package.json path must be a non-empty string");
  }
  if (typeof trustedRoot !== "string" || trustedRoot.length === 0) {
    refuse("WRANGLER_TRUST_ROOT_INVALID", "Wrangler trust root must be a non-empty string");
  }

  const root = requireCanonicalDirectory(trustedRoot, "WRANGLER_TRUST_ROOT_INVALID");
  const manifestPath = path.resolve(packageJsonPath);
  requireWithin(manifestPath, root, "WRANGLER_PACKAGE_OUTSIDE_TRUST_ROOT");
  const expectedManifestPath = path.join(root, ...WRANGLER_LOCK_LOCATION.split("/"), "package.json");
  if (!samePath(manifestPath, expectedManifestPath)) {
    refuse(
      "WRANGLER_PACKAGE_PATH_INVALID",
      "Wrangler package.json is not at the pinned npm-lockfile location",
    );
  }

  const derived = derivePinnedWranglerToolchainInventory({
    repositoryRoot: root,
    packageJsonPath: manifestPath,
    nodeExecutablePath: runtime.execPath,
    runtime,
  });
  if (derived.packageLockSha256 !== EXPECTED_PACKAGE_LOCK_SHA256) {
    refuse("WRANGLER_LOCKFILE_SUBSTITUTED", "package-lock.json bytes do not match the reviewed lockfile");
  }
  if (derived.packageCount !== EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT) {
    refuse("WRANGLER_TOOLCHAIN_PACKAGE_DRIFT", "deployment dependency closure has an unexpected package count");
  }
  if (derived.inventorySha256 !== EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256) {
    refuse("WRANGLER_TOOLCHAIN_INVENTORY_DRIFT", "deployment toolchain files differ from the reviewed inventory");
  }

  const packageRoot = path.dirname(manifestPath);
  const binPath = path.join(packageRoot, "bin", "wrangler.js");
  const cliPath = path.join(packageRoot, ...WRANGLER_CLI_RELATIVE_PATH.split("/"));
  const typescriptPackageRoot = path.join(root, ...TYPESCRIPT_LOCK_LOCATION.split("/"));
  const typescriptPackageJsonPath = path.join(typescriptPackageRoot, "package.json");
  const typescriptEntrypointPath = path.join(
    typescriptPackageRoot,
    ...TYPESCRIPT_ENTRYPOINT_RELATIVE_PATH.split("/"),
  );
  const packageJsonSha256 = sha256(readBoundedRegularFile(
    manifestPath,
    root,
    MAX_PACKAGE_JSON_BYTES,
    "WRANGLER_PACKAGE_UNAVAILABLE",
  ));
  const binSha256 = sha256(readBoundedRegularFile(
    binPath,
    root,
    MAX_TOOLCHAIN_FILE_BYTES,
    "WRANGLER_BIN_UNAVAILABLE",
  ));
  const cliSha256 = sha256(readBoundedRegularFile(
    cliPath,
    root,
    MAX_TOOLCHAIN_FILE_BYTES,
    "WRANGLER_CLI_UNAVAILABLE",
  ));
  const typescriptPackageJsonSha256 = sha256(readBoundedRegularFile(
    typescriptPackageJsonPath,
    root,
    MAX_PACKAGE_JSON_BYTES,
    "TYPESCRIPT_PACKAGE_UNAVAILABLE",
  ));
  const typescriptEntrypointSha256 = sha256(readBoundedRegularFile(
    typescriptEntrypointPath,
    root,
    MAX_TOOLCHAIN_FILE_BYTES,
    "TYPESCRIPT_ENTRYPOINT_UNAVAILABLE",
  ));
  if (packageJsonSha256 !== EXPECTED_WRANGLER_PACKAGE_JSON_SHA256) {
    refuse("WRANGLER_PACKAGE_SUBSTITUTED", "Wrangler package.json bytes do not match the pin");
  }
  if (binSha256 !== EXPECTED_WRANGLER_BIN_SHA256) {
    refuse("WRANGLER_BIN_SUBSTITUTED", "Wrangler compatibility bin bytes do not match the pin");
  }
  if (cliSha256 !== EXPECTED_WRANGLER_CLI_SHA256) {
    refuse("WRANGLER_CLI_SUBSTITUTED", "the directly executed Wrangler CLI bytes do not match the pin");
  }
  if (typescriptPackageJsonSha256 !== EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256) {
    refuse("TYPESCRIPT_PACKAGE_SUBSTITUTED", "TypeScript package.json bytes do not match the pin");
  }
  if (typescriptEntrypointSha256 !== EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256) {
    refuse("TYPESCRIPT_ENTRYPOINT_SUBSTITUTED", "TypeScript entrypoint bytes do not match the pin");
  }

  const packageManifest = parsePackageJson(readFileSync(manifestPath), "WRANGLER_MANIFEST_MALFORMED");
  if (packageManifest.name !== "wrangler") {
    refuse("WRANGLER_PACKAGE_SUBSTITUTED", "resolved package does not declare the exact Wrangler name");
  }
  if (packageManifest.version !== EXPECTED_WRANGLER_VERSION) {
    refuse("WRANGLER_VERSION_MISMATCH", `deployment tooling requires Wrangler ${EXPECTED_WRANGLER_VERSION}`);
  }
  if (!hasExactBinDeclaration(packageManifest.bin)) {
    refuse("WRANGLER_BIN_DECLARATION_MISMATCH", "Wrangler package.json has a non-exact bin declaration");
  }
  if (packageManifest.main !== WRANGLER_CLI_RELATIVE_PATH) {
    refuse("WRANGLER_CLI_DECLARATION_MISMATCH", "Wrangler package.json does not declare the pinned direct CLI");
  }

  const typescriptManifest = parsePackageJson(
    readFileSync(typescriptPackageJsonPath),
    "TYPESCRIPT_MANIFEST_MALFORMED",
  );
  if (typescriptManifest.name !== "typescript") {
    refuse("TYPESCRIPT_PACKAGE_SUBSTITUTED", "resolved compiler does not declare the exact TypeScript name");
  }
  if (typescriptManifest.version !== EXPECTED_TYPESCRIPT_VERSION) {
    refuse(
      "TYPESCRIPT_VERSION_MISMATCH",
      `deployment tooling requires TypeScript ${EXPECTED_TYPESCRIPT_VERSION}`,
    );
  }
  if (typescriptManifest.main !== `./${TYPESCRIPT_ENTRYPOINT_RELATIVE_PATH}`) {
    refuse(
      "TYPESCRIPT_ENTRYPOINT_DECLARATION_MISMATCH",
      "TypeScript package.json does not declare the pinned compiler entrypoint",
    );
  }

  const evidence = Object.freeze({
    packageJsonSha256,
    binSha256,
    cliSha256,
    typescriptPackageJsonSha256,
    typescriptEntrypointSha256,
    packageLockSha256: derived.packageLockSha256,
    toolchainInventorySha256: derived.inventorySha256,
    nodeExecutableSha256: derived.nodeExecutableSha256,
    platform: EXPECTED_WRANGLER_PLATFORM,
    arch: EXPECTED_WRANGLER_ARCH,
    nodeVersion: EXPECTED_NODE_VERSION,
    typescriptVersion: EXPECTED_TYPESCRIPT_VERSION,
    packageCount: derived.packageCount,
    entryCount: derived.entryCount,
  });
  return Object.freeze({
    command: runtime.execPath,
    argsPrefix: Object.freeze([cliPath]),
    version: EXPECTED_WRANGLER_VERSION,
    packageRoot,
    packageJsonPath: manifestPath,
    packageLockPath: path.join(root, "package-lock.json"),
    binPath,
    cliPath,
    typescriptPackageRoot,
    typescriptPackageJsonPath,
    typescriptEntrypointPath,
    evidence,
  });
}

/** Derive the canonical closed inventory. This does not decide whether the result is trusted. */
export function derivePinnedWranglerToolchainInventory({
  repositoryRoot,
  packageJsonPath,
  nodeExecutablePath,
  runtime = currentRuntime(),
} = {}) {
  assertPinnedPlatform(runtime);
  const root = requireCanonicalDirectory(repositoryRoot, "WRANGLER_TRUST_ROOT_INVALID");
  const lockPath = path.join(root, "package-lock.json");
  const lockBytes = readBoundedRegularFile(
    lockPath,
    root,
    MAX_PACKAGE_LOCK_BYTES,
    "WRANGLER_LOCKFILE_UNAVAILABLE",
  );
  const packageLockSha256 = sha256(lockBytes);
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString("utf8"));
  } catch {
    refuse("WRANGLER_LOCKFILE_MALFORMED", "package-lock.json is not valid JSON");
  }
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages)) {
    refuse("WRANGLER_LOCKFILE_MALFORMED", "package-lock.json is not the required npm lockfile v3 shape");
  }

  const expectedPackageJsonPath = path.join(root, ...WRANGLER_LOCK_LOCATION.split("/"), "package.json");
  if (!samePath(packageJsonPath, expectedPackageJsonPath)) {
    refuse("WRANGLER_PACKAGE_PATH_INVALID", "Wrangler package path differs from the lockfile root");
  }

  const toolchainRoots = Object.freeze([
    WRANGLER_LOCK_LOCATION,
    TYPESCRIPT_LOCK_LOCATION,
  ]);
  const packageLocations = resolveProductionClosure(
    lock.packages,
    root,
    toolchainRoots,
    runtime,
  );
  if (packageLocations.length > MAX_TOOLCHAIN_PACKAGE_COUNT) {
    refuse("WRANGLER_TOOLCHAIN_TOO_LARGE", "deployment dependency closure exceeds the package limit");
  }

  let entryCount = 0;
  let totalBytes = 0;
  const packages = packageLocations.map((location) => {
    const lockEntry = lock.packages[location];
    if (!isRecord(lockEntry) || typeof lockEntry.version !== "string") {
      refuse("WRANGLER_LOCKFILE_MALFORMED", "a resolved Wrangler package lacks a locked version");
    }
    const packageRoot = path.join(root, ...location.split("/"));
    requireCanonicalDirectory(packageRoot, "WRANGLER_TOOLCHAIN_LINKED");
    const manifestBytes = readBoundedRegularFile(
      path.join(packageRoot, "package.json"),
      root,
      MAX_PACKAGE_JSON_BYTES,
      "WRANGLER_DEPENDENCY_MANIFEST_UNAVAILABLE",
    );
    const manifest = parsePackageJson(manifestBytes, "WRANGLER_DEPENDENCY_MANIFEST_MALFORMED");
    const expectedName = packageNameFromLocation(location);
    if (manifest.name !== expectedName || manifest.version !== lockEntry.version) {
      refuse(
        "WRANGLER_DEPENDENCY_IDENTITY_MISMATCH",
        "an installed Wrangler dependency differs from its locked name/version",
      );
    }
    const inventoried = inventoryPackage(packageRoot, root);
    entryCount += inventoried.entryCount;
    totalBytes += inventoried.totalBytes;
    if (entryCount > MAX_TOOLCHAIN_ENTRY_COUNT || totalBytes > MAX_TOOLCHAIN_TOTAL_BYTES) {
      refuse("WRANGLER_TOOLCHAIN_TOO_LARGE", "Wrangler toolchain exceeds its closed inventory bounds");
    }
    return {
      location: toPosix(location),
      name: expectedName,
      version: lockEntry.version,
      integrity: typeof lockEntry.integrity === "string" ? lockEntry.integrity : null,
      entries: inventoried.entries,
    };
  });

  const nodePath = path.resolve(nodeExecutablePath);
  const nodeBytes = readBoundedExactRegularFile(
    nodePath,
    MAX_TOOLCHAIN_FILE_BYTES,
    "NODE_EXECUTABLE_UNAVAILABLE",
  );
  const nodeExecutableSha256 = sha256(nodeBytes);
  if (nodeExecutableSha256 !== EXPECTED_NODE_EXECUTABLE_SHA256) {
    refuse("NODE_EXECUTABLE_SUBSTITUTED", "Node executable bytes do not match the reviewed Windows x64 runtime");
  }
  if (runtime.nodeVersion !== EXPECTED_NODE_VERSION) {
    refuse("NODE_VERSION_UNSUPPORTED", `deployment tooling requires exact Node ${EXPECTED_NODE_VERSION}`);
  }

  const manifest = {
    schemaVersion: PINNED_WRANGLER_TOOLCHAIN_SCHEMA,
    packageLockSha256,
    roots: [...toolchainRoots],
    node: {
      platform: runtime.platform,
      arch: runtime.arch,
      version: runtime.nodeVersion,
      executableSha256: nodeExecutableSha256,
    },
    packages,
  };
  return Object.freeze({
    manifest: deepFreeze(manifest),
    inventorySha256: sha256(Buffer.from(canonicalize(manifest), "utf8")),
    packageLockSha256,
    nodeExecutableSha256,
    packageCount: packages.length,
    entryCount,
    totalBytes,
  });
}

/** Explicitly reject ambient Node code-injection channels before selecting any deploy command. */
export function assertPinnedWranglerRuntime(runtime = currentRuntime()) {
  assertPinnedRuntimeEnvelope(runtime);
  if (runtime.execArgv.length !== 0) {
    refuse("NODE_EXEC_ARGV_FORBIDDEN", "ambient Node execArgv is forbidden for pinned deployment tooling");
  }
  return true;
}

/**
 * Permit only the reviewed Node 24.18.0 child vectors from direct `node --test` and the visual
 * manifest's `node --test --test-concurrency=1`. They differ only in Node's generated
 * `--test-concurrency` entry, but the full 23-entry vector, context, and entry count are pinned.
 */
export function assertPinnedTypeScriptImportRuntime(runtime = currentRuntime()) {
  assertPinnedRuntimeEnvelope(runtime);
  if (runtime.execArgv.length === 0) return true;
  const testContext = Object.entries(runtime.environment)
    .filter(([name]) => name.toUpperCase() === "NODE_TEST_CONTEXT")
    .map(([, value]) => value);
  const execArgvSha256 = sha256(Buffer.from(JSON.stringify(runtime.execArgv), "utf8"));
  const reviewedVector = EXPECTED_NODE_TEST_RUNNER_VECTORS.find((vector) =>
    testContext.length === 1 &&
    testContext[0] === vector.context &&
    runtime.execArgv.length === vector.execArgvCount &&
    runtime.execArgv.filter((value) => value === vector.testConcurrencyFlag).length === 1 &&
    runtime.execArgv.filter((value) => value === "--test-force-exit").length === vector.testForceExitCount &&
    execArgvSha256 === vector.execArgvSha256
  );
  if (reviewedVector === undefined) {
    refuse(
      "NODE_EXEC_ARGV_FORBIDDEN",
      "ambient Node execArgv is neither empty nor the exact reviewed Node test-child vector",
    );
  }
  return true;
}

function assertPinnedRuntimeEnvelope(runtime) {
  assertPinnedPlatform(runtime);
  if (!Array.isArray(runtime.execArgv) || runtime.execArgv.some((value) => typeof value !== "string")) {
    refuse("NODE_EXEC_ARGV_INVALID", "ambient Node execArgv is malformed");
  }
  if (!isRecord(runtime.environment)) {
    refuse("NODE_ENVIRONMENT_INVALID", "ambient deployment environment is unavailable");
  }
  for (const name of Object.keys(runtime.environment)) {
    if (name.toUpperCase() === "NODE_OPTIONS") {
      refuse("NODE_OPTIONS_FORBIDDEN", "ambient NODE_OPTIONS is forbidden for pinned deployment tooling");
    }
  }
}

function assertPinnedPlatform(runtime) {
  if (!isRecord(runtime)) refuse("WRANGLER_RUNTIME_INVALID", "deployment runtime identity is unavailable");
  if (runtime.platform !== EXPECTED_WRANGLER_PLATFORM || runtime.arch !== EXPECTED_WRANGLER_ARCH) {
    refuse(
      "WRANGLER_PLATFORM_UNSUPPORTED",
      "this reviewed Wrangler toolchain adapter supports only Windows x64",
    );
  }
  if (typeof runtime.execPath !== "string" || !path.isAbsolute(runtime.execPath)) {
    refuse("NODE_EXECUTABLE_UNAVAILABLE", "Node executable path is not absolute");
  }
}

function currentRuntime() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    execPath: process.execPath,
    execArgv: [...process.execArgv],
    environment: process.env,
  };
}

function resolveProductionClosure(packages, repositoryRoot, startLocations, runtime) {
  if (
    !Array.isArray(startLocations) ||
    startLocations.length === 0 ||
    startLocations.some((location) => typeof location !== "string" || !isRecord(packages[location]))
  ) {
    refuse("WRANGLER_LOCKFILE_MALFORMED", "package-lock.json lacks a required deployment-toolchain root");
  }
  const pending = [...startLocations];
  const seen = new Set();
  while (pending.length > 0) {
    const location = pending.shift();
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = packages[location];
    if (!isRecord(entry)) refuse("WRANGLER_LOCKFILE_MALFORMED", "dependency closure references no lock entry");
    for (const name of Object.keys(isRecord(entry.dependencies) ? entry.dependencies : {}).sort()) {
      const resolved = resolveLockedDependency(packages, repositoryRoot, location, name);
      if (resolved === null) {
        refuse("WRANGLER_DEPENDENCY_MISSING", `required locked dependency is absent: ${name}`);
      }
      pending.push(resolved);
    }
    for (const name of Object.keys(isRecord(entry.optionalDependencies) ? entry.optionalDependencies : {}).sort()) {
      const locked = resolveLockedDependency(packages, repositoryRoot, location, name, { requireInstalled: false });
      if (locked === null) continue;
      const optional = packages[locked];
      if (!matchesPlatform(optional, runtime)) continue;
      const installed = path.join(repositoryRoot, ...locked.split("/"));
      if (!pathExistsAsDirectoryOrLink(installed)) {
        refuse(
          "WRANGLER_OPTIONAL_DEPENDENCY_MISSING",
          `platform-compatible locked optional dependency is absent: ${name}`,
        );
      }
      pending.push(locked);
    }
    if (seen.size + pending.length > MAX_TOOLCHAIN_PACKAGE_COUNT * 2) {
      refuse("WRANGLER_TOOLCHAIN_TOO_LARGE", "Wrangler dependency closure does not converge within bounds");
    }
  }
  return [...seen].sort();
}

function resolveLockedDependency(packages, repositoryRoot, fromLocation, name, { requireInstalled = true } = {}) {
  let current = path.join(repositoryRoot, ...fromLocation.split("/"));
  for (;;) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    const relative = toPosix(path.relative(repositoryRoot, candidate));
    if (isRecord(packages[relative])) {
      if (!requireInstalled || pathExistsAsDirectoryOrLink(candidate)) return relative;
    }
    if (samePath(current, repositoryRoot)) break;
    const parent = path.dirname(current);
    if (samePath(parent, current)) break;
    current = parent;
  }
  return null;
}

function matchesPlatform(entry, runtime) {
  if (!isRecord(entry)) return false;
  return matchesConstraint(entry.os, runtime.platform) && matchesConstraint(entry.cpu, runtime.arch);
}

function matchesConstraint(value, actual) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    refuse("WRANGLER_LOCKFILE_MALFORMED", "package platform constraint is malformed");
  }
  const denied = new Set(value.filter((item) => item.startsWith("!")).map((item) => item.slice(1)));
  if (denied.has(actual)) return false;
  const allowed = value.filter((item) => !item.startsWith("!"));
  return allowed.length === 0 || allowed.includes(actual);
}

function inventoryPackage(packageRoot, repositoryRoot) {
  const entries = [];
  let totalBytes = 0;
  const walk = (directory, relativeDirectory) => {
    let names;
    try {
      // Default Array#sort is locale-independent UTF-16 code-unit order. Do not use
      // localeCompare here: this hash must survive a different Windows UI locale.
      names = readdirSync(directory).sort();
    } catch {
      refuse("WRANGLER_TOOLCHAIN_UNREADABLE", "a Wrangler toolchain directory could not be read");
    }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        refuse("WRANGLER_TOOLCHAIN_UNREADABLE", "a Wrangler toolchain entry disappeared during inventory");
      }
      if (stat.isSymbolicLink()) {
        refuse("WRANGLER_TOOLCHAIN_LINKED", "Wrangler toolchain must not contain links or junctions");
      }
      requireExactRealPath(absolute, "WRANGLER_TOOLCHAIN_LINKED");
      if (stat.isDirectory()) {
        entries.push({ path: `${toPosix(relative)}/`, type: "directory" });
        walk(absolute, toPosix(relative));
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) {
          refuse("WRANGLER_TOOLCHAIN_LINKED", "Wrangler toolchain must not contain hard-linked files");
        }
        if (stat.size < 0 || stat.size > MAX_TOOLCHAIN_FILE_BYTES) {
          refuse("WRANGLER_TOOLCHAIN_FILE_INVALID", "Wrangler toolchain file has an invalid byte length");
        }
        const bytes = readBoundedRegularFile(
          absolute,
          repositoryRoot,
          MAX_TOOLCHAIN_FILE_BYTES,
          "WRANGLER_TOOLCHAIN_UNREADABLE",
          { allowEmpty: true },
        );
        totalBytes += bytes.length;
        entries.push({ path: toPosix(relative), type: "file", bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        refuse("WRANGLER_TOOLCHAIN_SPECIAL_FILE", "Wrangler toolchain contains a non-file entry");
      }
      if (entries.length > MAX_TOOLCHAIN_ENTRY_COUNT) {
        refuse("WRANGLER_TOOLCHAIN_TOO_LARGE", "one Wrangler package exceeds the entry limit");
      }
    }
  };
  walk(packageRoot, "");
  return { entries, entryCount: entries.length, totalBytes };
}

function readBoundedRegularFile(candidate, trustedRoot, maximumBytes, code, { allowEmpty = false } = {}) {
  const resolved = path.resolve(candidate);
  requireWithinOrEqual(resolved, trustedRoot, `${code}_OUTSIDE_ROOT`);
  requireExactRegularFile(resolved, code, "WRANGLER_TOOLCHAIN_LINKED");
  return readBoundedBytes(resolved, maximumBytes, code, { allowEmpty });
}

function readBoundedExactRegularFile(candidate, maximumBytes, code) {
  const resolved = path.resolve(candidate);
  requireExactRegularFile(resolved, code, "NODE_EXECUTABLE_LINKED");
  return readBoundedBytes(resolved, maximumBytes, code);
}

function readBoundedBytes(candidate, maximumBytes, code, { allowEmpty = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(candidate);
  } catch {
    refuse(code, "required pinned-toolchain file could not be read");
  }
  if ((!allowEmpty && bytes.length === 0) || bytes.length > maximumBytes) {
    refuse(code, "required pinned-toolchain file has an invalid byte length");
  }
  return bytes;
}

function requireExactRegularFile(candidate, unavailableCode, linkedCode) {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    refuse(unavailableCode, "required pinned-toolchain file is unavailable");
  }
  if (stat.isSymbolicLink()) refuse(linkedCode, "required pinned-toolchain file is linked");
  if (!stat.isFile()) refuse(unavailableCode, "required pinned-toolchain path is not a regular file");
  if (stat.nlink !== 1) refuse(linkedCode, "required pinned-toolchain file is hard-linked");
  requireExactRealPath(candidate, linkedCode);
}

function requireCanonicalDirectory(candidate, code) {
  const resolved = path.resolve(candidate);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    refuse(code, "required pinned-toolchain directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    refuse(code, "required pinned-toolchain directory is not a real directory");
  }
  requireExactRealPath(resolved, code);
  return resolved;
}

function requireExactRealPath(candidate, code) {
  let real;
  try {
    real = realpathSync.native(candidate);
  } catch {
    refuse(code, "required pinned-toolchain path has no real path");
  }
  if (!samePath(candidate, real)) {
    refuse(code, "required pinned-toolchain path traverses a link, junction, or substitution");
  }
}

function descriptorIdentity(value) {
  return {
    command: value.command,
    argsPrefix: value.argsPrefix,
    version: value.version,
    packageRoot: value.packageRoot,
    packageJsonPath: value.packageJsonPath,
    packageLockPath: value.packageLockPath,
    binPath: value.binPath,
    cliPath: value.cliPath,
    typescriptPackageRoot: value.typescriptPackageRoot,
    typescriptPackageJsonPath: value.typescriptPackageJsonPath,
    typescriptEntrypointPath: value.typescriptEntrypointPath,
    evidence: value.evidence,
  };
}

function parsePackageJson(bytes, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_PACKAGE_JSON_BYTES) {
    refuse(code, "package manifest has an invalid byte length");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(code, "package manifest is not valid JSON");
  }
  if (!isRecord(value)) refuse(code, "package manifest must contain one JSON object");
  return value;
}

function packageNameFromLocation(location) {
  const segments = toPosix(location).split("/");
  const lastNodeModules = segments.lastIndexOf("node_modules");
  const tail = segments.slice(lastNodeModules + 1);
  if (lastNodeModules < 0 || tail.length < 1 || tail.length > 2) {
    refuse("WRANGLER_LOCKFILE_MALFORMED", "locked dependency has an invalid npm package location");
  }
  return tail[0].startsWith("@") ? `${tail[0]}/${tail[1] ?? ""}` : tail[0];
}

function hasExactBinDeclaration(value) {
  if (!isRecord(value)) return false;
  return canonicalize(value) === canonicalize(EXPECTED_WRANGLER_BIN_DECLARATION);
}

function pathExistsAsDirectoryOrLink(candidate) {
  try {
    const stat = lstatSync(candidate);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function requireWithin(candidate, root, code) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse(code, "required pinned-toolchain path is outside its trusted root");
  }
}

function requireWithinOrEqual(candidate, root, code) {
  if (samePath(candidate, root)) return;
  requireWithin(candidate, root, code);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function refuse(code, message) {
  throw new PinnedWranglerError(code, message);
}
