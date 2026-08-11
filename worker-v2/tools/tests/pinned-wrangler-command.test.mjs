import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPECTED_NODE_EXECUTABLE_SHA256,
  EXPECTED_NODE_TEST_RUNNER_CONTEXT,
  EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256,
  EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT,
  EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256,
  EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256_SET,
  EXPECTED_NODE_TEST_RUNNER_SERIAL_EXEC_ARGV_SHA256,
  EXPECTED_NODE_TEST_RUNNER_VECTORS,
  EXPECTED_NODE_VERSION,
  EXPECTED_PACKAGE_LOCK_SHA256,
  EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
  EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
  EXPECTED_TYPESCRIPT_VERSION,
  EXPECTED_WRANGLER_ARCH,
  EXPECTED_WRANGLER_BIN_DECLARATION,
  EXPECTED_WRANGLER_BIN_SHA256,
  EXPECTED_WRANGLER_CLI_SHA256,
  EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
  EXPECTED_WRANGLER_PLATFORM,
  EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
  EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
  EXPECTED_WRANGLER_VERSION,
  PINNED_WRANGLER_TOOLCHAIN_SCHEMA,
  assertPinnedTypeScriptImportRuntime,
  assertPinnedWranglerRuntime,
  derivePinnedWranglerToolchainInventory,
  inspectPinnedWranglerPackage,
} from "../pinned-wrangler-command.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../../..");
const WORKER_ROOT = path.join(REPOSITORY_ROOT, "worker-v2");
const PINNED_MODULE = path.join(WORKER_ROOT, "tools", "pinned-wrangler-command.mjs");
const VERIFIED_TYPESCRIPT_MODULE = path.join(WORKER_ROOT, "tools", "verified-typescript.mjs");
const SOURCE_PACKAGE_JSON = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "package.json");
const SOURCE_CLI = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "wrangler-dist", "cli.js");
const SOURCE_TYPESCRIPT_ENTRYPOINT = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "typescript",
  "lib",
  "typescript.js",
);
const FIXTURE_BASE = path.join(WORKER_ROOT, ".test-tmp");
const TEMP_NAME_PREFIX = "survey-qa-pinned-toolchain-";
const CLEAN_RUNTIME = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  execPath: process.execPath,
  execArgv: Object.freeze([]),
  environment: Object.freeze({}),
});

let fixture;
let sourceInventory;

before(() => {
  assert.equal(process.platform, EXPECTED_WRANGLER_PLATFORM);
  assert.equal(process.arch, EXPECTED_WRANGLER_ARCH);
  assert.equal(process.version, EXPECTED_NODE_VERSION);
  mkdirSync(FIXTURE_BASE, { recursive: true });
  sourceInventory = derivePinnedWranglerToolchainInventory({
    repositoryRoot: REPOSITORY_ROOT,
    packageJsonPath: SOURCE_PACKAGE_JSON,
    nodeExecutablePath: process.execPath,
    runtime: CLEAN_RUNTIME,
  });
  fixture = makeExactToolchainFixture(sourceInventory);
});

after(() => {
  if (!fixture) return;
  const resolved = path.resolve(fixture.root);
  const relative = path.relative(path.resolve(FIXTURE_BASE), resolved);
  assert.equal(path.basename(resolved).startsWith(TEMP_NAME_PREFIX), true);
  assert.equal(relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relative), false);
  rmSync(resolved, { recursive: true, force: false });
});

test("the checked-in Windows x64 inventory covers Wrangler and the executed TypeScript package", () => {
  assert.equal(sourceInventory.manifest.schemaVersion, PINNED_WRANGLER_TOOLCHAIN_SCHEMA);
  assert.equal(sourceInventory.inventorySha256, EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256);
  assert.equal(sourceInventory.packageLockSha256, EXPECTED_PACKAGE_LOCK_SHA256);
  assert.equal(sourceInventory.nodeExecutableSha256, EXPECTED_NODE_EXECUTABLE_SHA256);
  assert.equal(sourceInventory.packageCount, EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT);
  assert.equal(sourceInventory.entryCount, 1927);
  assert.equal(sourceInventory.totalBytes, 193_996_898);
  assert.deepEqual(sourceInventory.manifest.roots, [
    "node_modules/wrangler",
    "node_modules/typescript",
  ]);

  const locations = new Set(sourceInventory.manifest.packages.map((entry) => entry.location));
  for (const required of [
    "node_modules/wrangler",
    "node_modules/esbuild",
    "node_modules/@esbuild/win32-x64",
    "node_modules/workerd",
    "node_modules/@cloudflare/workerd-windows-64",
    "node_modules/sharp",
    "node_modules/@img/sharp-win32-x64",
    "node_modules/typescript",
  ]) assert.equal(locations.has(required), true, required);
  assert.equal(locations.has("node_modules/fsevents"), false, "Darwin-only optional package");

  const wrangler = sourceInventory.manifest.packages.find((entry) => entry.name === "wrangler");
  assert.ok(wrangler);
  assert.ok(wrangler.entries.some((entry) => entry.path === "wrangler-dist/cli.js" && entry.type === "file"));
  assert.ok(wrangler.entries.some((entry) => entry.path === "templates/" && entry.type === "directory"));

  const typescript = sourceInventory.manifest.packages.find((entry) => entry.name === "typescript");
  assert.ok(typescript);
  assert.equal(typescript.version, EXPECTED_TYPESCRIPT_VERSION);
  assert.equal(typescript.entries.length, 147);
  assert.equal(
    typescript.entries
      .filter((entry) => entry.type === "file")
      .reduce((sum, entry) => sum + entry.bytes, 0),
    23_625_066,
  );
  assert.ok(typescript.entries.some((entry) =>
    entry.path === "lib/typescript.js" &&
    entry.type === "file" &&
    entry.sha256 === EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256));
  assert.ok(typescript.entries.some((entry) =>
    entry.path === "package.json" &&
    entry.type === "file" &&
    entry.sha256 === EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256));
});

test("an exact installation copy resolves direct-to-CLI and retains compatibility evidence", () => {
  const descriptor = inspectFixture();
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.argsPrefix, [descriptor.cliPath]);
  assert.notEqual(descriptor.cliPath, descriptor.binPath);
  assert.equal(descriptor.cliPath, path.join(fixture.packageRoot, "wrangler-dist", "cli.js"));
  assert.equal(descriptor.version, EXPECTED_WRANGLER_VERSION);
  assert.equal(
    descriptor.typescriptPackageRoot,
    path.join(fixture.root, "node_modules", "typescript"),
  );
  assert.equal(
    descriptor.typescriptPackageJsonPath,
    path.join(descriptor.typescriptPackageRoot, "package.json"),
  );
  assert.equal(
    descriptor.typescriptEntrypointPath,
    path.join(descriptor.typescriptPackageRoot, "lib", "typescript.js"),
  );
  assert.deepEqual(EXPECTED_WRANGLER_BIN_DECLARATION, {
    "cf-wrangler": "./bin/cf-wrangler.js",
    wrangler: "./bin/wrangler.js",
    wrangler2: "./bin/wrangler.js",
  });
  assert.deepEqual(descriptor.evidence, {
    packageJsonSha256: EXPECTED_WRANGLER_PACKAGE_JSON_SHA256,
    binSha256: EXPECTED_WRANGLER_BIN_SHA256,
    cliSha256: EXPECTED_WRANGLER_CLI_SHA256,
    typescriptPackageJsonSha256: EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256,
    typescriptEntrypointSha256: EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256,
    packageLockSha256: EXPECTED_PACKAGE_LOCK_SHA256,
    toolchainInventorySha256: EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256,
    nodeExecutableSha256: EXPECTED_NODE_EXECUTABLE_SHA256,
    platform: EXPECTED_WRANGLER_PLATFORM,
    arch: EXPECTED_WRANGLER_ARCH,
    nodeVersion: EXPECTED_NODE_VERSION,
    typescriptVersion: EXPECTED_TYPESCRIPT_VERSION,
    packageCount: EXPECTED_WRANGLER_TOOLCHAIN_PACKAGE_COUNT,
    entryCount: 1927,
  });
  assert.equal(lstatSync(descriptor.cliPath).isFile(), true);
  assert.equal(lstatSync(descriptor.cliPath).isSymbolicLink(), false);
  assert.equal(JSON.stringify(descriptor).includes("npx"), false);
  assert.equal(JSON.stringify(descriptor).includes(".cmd"), false);
});

test("the direct verified CLI launches offline without the thin bin or ambient Node options", () => {
  const descriptor = inspectFixture();
  const child = spawnSync(descriptor.command, [...descriptor.argsPrefix, "--version"], {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: cleanChildEnvironment({
      ...process.env,
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
    }),
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout.trim(), EXPECTED_WRANGLER_VERSION);
});

test("production resolution and immediate reverification succeed only from a plain Node launch", () => {
  const helper = path.join(fixture.root, "verify-production-resolver.mjs");
  writeFileSync(
    helper,
    [
      `import { resolvePinnedWranglerCommand, verifyPinnedWranglerCommand } from ${JSON.stringify(pathToFileURL(PINNED_MODULE).href)};`,
      "const selected = resolvePinnedWranglerCommand();",
      "const verified = verifyPinnedWranglerCommand(selected);",
      "console.log(JSON.stringify({ argsPrefix: verified.argsPrefix, cliPath: verified.cliPath, evidence: verified.evidence }));",
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawnSync(process.execPath, [helper], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: cleanChildEnvironment(process.env),
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.deepEqual(value.argsPrefix, [value.cliPath]);
  assert.equal(value.cliPath, SOURCE_CLI);
  assert.equal(value.evidence.toolchainInventorySha256, EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256);
  assert.equal(value.evidence.typescriptVersion, EXPECTED_TYPESCRIPT_VERSION);
});

test("substituted Wrangler, TypeScript package/JavaScript, and native bytes fail closed", () => {
  for (const relative of [
    "node_modules/wrangler/wrangler-dist/cli.js",
    "node_modules/kleur/index.js",
    "node_modules/typescript/package.json",
    "node_modules/typescript/lib/typescript.js",
    "node_modules/@esbuild/win32-x64/esbuild.exe",
    "node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe",
  ]) {
    const target = fixturePath(relative);
    const original = readFileSync(target);
    const mutated = relative.endsWith("/package.json")
      ? Buffer.concat([original, Buffer.from("\n", "utf8")])
      : Buffer.from(original);
    if (!relative.endsWith("/package.json")) {
      mutated[Math.min(32, mutated.length - 1)] ^= 0xff;
    }
    try {
      writeFileSync(target, mutated);
      assertPinnedError(() => inspectFixture(), "WRANGLER_TOOLCHAIN_INVENTORY_DRIFT", relative);
    } finally {
      writeFileSync(target, original);
    }
  }
});

test("the shared compiler loader verifies first and imports only the exact pinned entrypoint", () => {
  const helper = path.join(fixture.root, "verify-typescript-loader.mjs");
  writeFileSync(
    helper,
    [
      `import ts, { VERIFIED_TYPESCRIPT_ENTRYPOINT_PATH, VERIFIED_TYPESCRIPT_TOOLCHAIN_EVIDENCE } from ${JSON.stringify(pathToFileURL(VERIFIED_TYPESCRIPT_MODULE).href)};`,
      "console.log(JSON.stringify({ version: ts.version, entrypoint: VERIFIED_TYPESCRIPT_ENTRYPOINT_PATH, evidence: VERIFIED_TYPESCRIPT_TOOLCHAIN_EVIDENCE }));",
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawnSync(process.execPath, [helper], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: cleanChildEnvironment(process.env),
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.version, EXPECTED_TYPESCRIPT_VERSION);
  assert.equal(value.entrypoint, SOURCE_TYPESCRIPT_ENTRYPOINT);
  assert.equal(value.evidence.typescriptPackageJsonSha256, EXPECTED_TYPESCRIPT_PACKAGE_JSON_SHA256);
  assert.equal(value.evidence.typescriptEntrypointSha256, EXPECTED_TYPESCRIPT_ENTRYPOINT_SHA256);
  assert.equal(value.evidence.toolchainInventorySha256, EXPECTED_WRANGLER_TOOLCHAIN_INVENTORY_SHA256);
});

test("missing and extra inventory inputs both fail closed", () => {
  const missing = fixturePath("node_modules/kleur/readme.md");
  const original = readFileSync(missing);
  try {
    unlinkSync(missing);
    assertPinnedError(() => inspectFixture(), "WRANGLER_TOOLCHAIN_INVENTORY_DRIFT", "missing file");
  } finally {
    writeFileSync(missing, original);
  }

  const extra = fixturePath("node_modules/wrangler/wrangler-dist/unreviewed-extra.js");
  try {
    writeFileSync(extra, "throw new Error('unreviewed');\n", { encoding: "utf8", flag: "wx" });
    assertPinnedError(() => inspectFixture(), "WRANGLER_TOOLCHAIN_INVENTORY_DRIFT", "extra file");
  } finally {
    unlinkSync(extra);
  }
});

test("package-directory junctions and hard-linked toolchain files fail with a named link error", () => {
  const packageDirectory = fixturePath("node_modules/path-to-regexp");
  const replacementDirectory = fixturePath("node_modules/path-to-regexp-reviewed-bytes");
  renameSync(packageDirectory, replacementDirectory);
  try {
    symlinkSync(replacementDirectory, packageDirectory, "junction");
    assertPinnedError(() => inspectFixture(), "WRANGLER_TOOLCHAIN_LINKED", "package junction");
  } finally {
    try {
      unlinkSync(packageDirectory);
    } finally {
      renameSync(replacementDirectory, packageDirectory);
    }
  }

  const hardLink = fixturePath("node_modules/kleur/colors.js");
  const source = path.join(REPOSITORY_ROOT, "node_modules", "kleur", "colors.js");
  unlinkSync(hardLink);
  try {
    linkSync(source, hardLink);
    assertPinnedError(() => inspectFixture(), "WRANGLER_TOOLCHAIN_LINKED", "hard-linked file");
  } finally {
    unlinkSync(hardLink);
    copyFileSync(source, hardLink);
  }
});

test("lockfile drift fails independently of package name/version declarations", () => {
  const lockPath = path.join(fixture.root, "package-lock.json");
  const original = readFileSync(lockPath);
  try {
    writeFileSync(lockPath, Buffer.concat([original, Buffer.from("\n", "utf8")]));
    assertPinnedError(() => inspectFixture(), "WRANGLER_LOCKFILE_SUBSTITUTED", "lockfile bytes");
  } finally {
    writeFileSync(lockPath, original);
  }
});

test("ambient Node injection and unsupported platforms fail before inventory work", () => {
  assert.equal(EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256, EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256);
  assert.deepEqual(EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_SHA256_SET, [
    EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256,
    EXPECTED_NODE_TEST_RUNNER_SERIAL_EXEC_ARGV_SHA256,
  ]);
  assert.deepEqual(EXPECTED_NODE_TEST_RUNNER_VECTORS, [
    {
      id: "direct-node-test",
      parentInvocation: "node --test",
      context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
      execArgvCount: EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT,
      testConcurrencyFlag: "--test-concurrency=0",
      execArgvSha256: EXPECTED_NODE_TEST_RUNNER_DIRECT_EXEC_ARGV_SHA256,
    },
    {
      id: "visual-manifest-serial",
      parentInvocation: "node --test --test-concurrency=1",
      context: EXPECTED_NODE_TEST_RUNNER_CONTEXT,
      execArgvCount: EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT,
      testConcurrencyFlag: "--test-concurrency=1",
      execArgvSha256: EXPECTED_NODE_TEST_RUNNER_SERIAL_EXEC_ARGV_SHA256,
    },
  ]);
  assert.equal(Object.isFrozen(EXPECTED_NODE_TEST_RUNNER_VECTORS), true);
  assert.equal(EXPECTED_NODE_TEST_RUNNER_VECTORS.every((vector) => Object.isFrozen(vector)), true);
  assert.equal(process.env.NODE_TEST_CONTEXT, EXPECTED_NODE_TEST_RUNNER_CONTEXT);
  assert.equal(process.execArgv.length, EXPECTED_NODE_TEST_RUNNER_EXEC_ARGV_COUNT);
  const currentExecArgvSha256 = sha256(Buffer.from(JSON.stringify(process.execArgv), "utf8"));
  const currentVector = EXPECTED_NODE_TEST_RUNNER_VECTORS.find(
    (vector) => vector.execArgvSha256 === currentExecArgvSha256,
  );
  assert.notEqual(currentVector, undefined, "the executing test child must be one reviewed vector");
  assert.equal(process.execArgv.filter((value) => value === currentVector.testConcurrencyFlag).length, 1);

  const exactVectors = EXPECTED_NODE_TEST_RUNNER_VECTORS.map((vector) => {
    const execArgv = replaceTestConcurrencyFlag(process.execArgv, vector.testConcurrencyFlag);
    assert.equal(execArgv.length, vector.execArgvCount, `${vector.id} argument count`);
    assert.equal(
      sha256(Buffer.from(JSON.stringify(execArgv), "utf8")),
      vector.execArgvSha256,
      `${vector.id} full argument vector`,
    );
    return { vector, execArgv };
  });

  for (const { vector, execArgv } of exactVectors) {
    const exactTestRunnerRuntime = {
      ...CLEAN_RUNTIME,
      execArgv,
      environment: { NODE_TEST_CONTEXT: vector.context },
    };
    assert.equal(assertPinnedTypeScriptImportRuntime(exactTestRunnerRuntime), true, vector.id);
    assertPinnedError(
      () => assertPinnedWranglerRuntime(exactTestRunnerRuntime),
      "NODE_EXEC_ARGV_FORBIDDEN",
      `${vector.id}: production command resolution stays strict under node:test`,
    );

    const alteredExecArgv = [...execArgv];
    const timeoutIndex = alteredExecArgv.indexOf("--test-timeout=0");
    assert.notEqual(timeoutIndex, -1, `${vector.id}: exact timeout flag is present`);
    alteredExecArgv[timeoutIndex] = "--test-timeout=1";
    assertPinnedError(
      () => assertPinnedTypeScriptImportRuntime({ ...exactTestRunnerRuntime, execArgv: alteredExecArgv }),
      "NODE_EXEC_ARGV_FORBIDDEN",
      `${vector.id}: one altered flag`,
    );
    assertPinnedError(
      () => assertPinnedTypeScriptImportRuntime({ ...exactTestRunnerRuntime, environment: {} }),
      "NODE_EXEC_ARGV_FORBIDDEN",
      `${vector.id}: missing exact Node test context`,
    );
    assertPinnedError(
      () => assertPinnedTypeScriptImportRuntime({
        ...exactTestRunnerRuntime,
        environment: {
          NODE_TEST_CONTEXT: vector.context,
          NoDe_OpTiOnS: "--import=unreviewed.js",
        },
      }),
      "NODE_OPTIONS_FORBIDDEN",
      `${vector.id}: NODE_OPTIONS`,
    );
  }

  assertPinnedError(
    () => assertPinnedTypeScriptImportRuntime({
      ...CLEAN_RUNTIME,
      execArgv: [...exactVectors[0].execArgv, "--import=unreviewed.js"],
      environment: { NODE_TEST_CONTEXT: EXPECTED_NODE_TEST_RUNNER_CONTEXT },
    }),
    "NODE_EXEC_ARGV_FORBIDDEN",
    "test-runner vector with one arbitrary argument",
  );
  assertPinnedError(
    () => assertPinnedWranglerRuntime({ ...CLEAN_RUNTIME, execArgv: ["--require", "unreviewed.js"] }),
    "NODE_EXEC_ARGV_FORBIDDEN",
    "process.execArgv",
  );
  assertPinnedError(
    () => assertPinnedWranglerRuntime({ ...CLEAN_RUNTIME, environment: { NoDe_OpTiOnS: "--import=unreviewed.js" } }),
    "NODE_OPTIONS_FORBIDDEN",
    "NODE_OPTIONS case-insensitive",
  );
  assertPinnedError(
    () => assertPinnedWranglerRuntime({ ...CLEAN_RUNTIME, platform: "linux" }),
    "WRANGLER_PLATFORM_UNSUPPORTED",
    "platform adapter",
  );
  assertPinnedError(
    () => assertPinnedWranglerRuntime({ ...CLEAN_RUNTIME, arch: "arm64" }),
    "WRANGLER_PLATFORM_UNSUPPORTED",
    "architecture adapter",
  );
});

function replaceTestConcurrencyFlag(execArgv, replacement) {
  const indices = execArgv
    .map((value, index) => /^--test-concurrency=\d+$/u.test(value) ? index : -1)
    .filter((index) => index !== -1);
  assert.equal(indices.length, 1, "Node test child must expose exactly one concurrency flag");
  const replaced = [...execArgv];
  replaced[indices[0]] = replacement;
  return replaced;
}

function inspectFixture() {
  return inspectPinnedWranglerPackage(fixture.packageJsonPath, {
    trustedRoot: fixture.root,
    runtime: CLEAN_RUNTIME,
  });
}

function makeExactToolchainFixture(inventory) {
  const root = mkdtempSync(path.join(FIXTURE_BASE, TEMP_NAME_PREFIX));
  copyFileSync(path.join(REPOSITORY_ROOT, "package-lock.json"), path.join(root, "package-lock.json"));
  for (const packageEntry of inventory.manifest.packages) {
    const source = path.join(REPOSITORY_ROOT, ...packageEntry.location.split("/"));
    const destination = path.join(root, ...packageEntry.location.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: true });
  }
  const packageRoot = path.join(root, "node_modules", "wrangler");
  return {
    root,
    packageRoot,
    packageJsonPath: path.join(packageRoot, "package.json"),
  };
}

function fixturePath(relative) {
  const candidate = path.resolve(fixture.root, ...relative.split("/"));
  const boundary = path.relative(fixture.root, candidate);
  assert.notEqual(boundary, "");
  assert.equal(boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary), false);
  return candidate;
}

function cleanChildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS"),
  );
}

function assertPinnedError(operation, code, label) {
  assert.throws(
    operation,
    (error) => error?.name === "PinnedWranglerError" && error.code === code,
    label,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
