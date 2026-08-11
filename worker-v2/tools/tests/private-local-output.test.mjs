import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PINNED_WINDOWS_POWERSHELL,
  WINDOWS_ACL_CHILD_ENVIRONMENT_KEYS,
  assertPrivateLocalPath,
  assertWindowsAclChildEnvironment,
  buildWindowsAclChildEnvironment,
  hardenPrivateLocalDirectory,
  resolvePinnedWindowsPowerShellExecutable,
  runWindowsAcl,
} from "../private-local-output.mjs";

function fixture(t) {
  const repositoryRoot = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "survey-qa-private-output-")),
  );
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const target = path.join(repositoryRoot, "private");
  mkdirSync(target);
  return { repositoryRoot, target };
}

function fakeStat(overrides = {}) {
  return {
    dev: 17,
    ino: 23,
    size: PINNED_WINDOWS_POWERSHELL.executableBytes,
    nlink: PINNED_WINDOWS_POWERSHELL.expectedHardLinkCount,
    mtimeMs: 31,
    ctimeMs: 37,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

test("reviewed Windows x64 PowerShell path, bytes, and system-hardlink identity resolve exactly", () => {
  const descriptor = resolvePinnedWindowsPowerShellExecutable();
  assert.deepEqual(descriptor, PINNED_WINDOWS_POWERSHELL);
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(descriptor.executablePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(descriptor.executableBytes, 454_656);
  assert.equal(descriptor.executableSha256, "7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5");
  assert.equal(descriptor.expectedHardLinkCount, 2);
  assert.equal(descriptor.reviewedFileVersion, "10.0.26100.8875");
});

test("path, platform, link, size, byte, and concurrent-identity mutations all fail closed", async (t) => {
  const pathMutations = [
    ["platform", { runtime: { platform: "linux", arch: "x64" } }, "WINDOWS_POWERSHELL_PLATFORM_UNSUPPORTED"],
    ["architecture", { runtime: { platform: "win32", arch: "arm64" } }, "WINDOWS_POWERSHELL_PLATFORM_UNSUPPORTED"],
    ["absolute path", { executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell-mutant.exe" }, "WINDOWS_POWERSHELL_PATH_SUBSTITUTED"],
  ];
  for (const [label, options, code] of pathMutations) {
    await t.test(label, () => {
      let filesystemReads = 0;
      assert.throws(
        () => resolvePinnedWindowsPowerShellExecutable({
          ...options,
          lstatSyncImpl() {
            filesystemReads += 1;
            return fakeStat();
          },
        }),
        (error) => error.code === code,
      );
      assert.equal(filesystemReads, 0);
    });
  }

  await t.test("reparse point", () => {
    let byteReads = 0;
    assert.throws(
      () => resolvePinnedWindowsPowerShellExecutable({
        lstatSyncImpl: () => fakeStat({ isSymbolicLink: () => true }),
        realpathSyncImpl: () => PINNED_WINDOWS_POWERSHELL.executablePath,
        readFileSyncImpl() {
          byteReads += 1;
          return Buffer.alloc(PINNED_WINDOWS_POWERSHELL.executableBytes);
        },
      }),
      (error) => error.code === "WINDOWS_POWERSHELL_LINKED",
    );
    assert.equal(byteReads, 0);
  });

  await t.test("unexpected hardlink count", () => {
    let byteReads = 0;
    assert.throws(
      () => resolvePinnedWindowsPowerShellExecutable({
        lstatSyncImpl: () => fakeStat({ nlink: 1 }),
        realpathSyncImpl: () => PINNED_WINDOWS_POWERSHELL.executablePath,
        readFileSyncImpl() {
          byteReads += 1;
          return Buffer.alloc(PINNED_WINDOWS_POWERSHELL.executableBytes);
        },
      }),
      (error) => error.code === "WINDOWS_POWERSHELL_LINK_COUNT_DRIFT",
    );
    assert.equal(byteReads, 0);
  });

  await t.test("oversized executable is rejected before allocation", () => {
    let byteReads = 0;
    assert.throws(
      () => resolvePinnedWindowsPowerShellExecutable({
        lstatSyncImpl: () => fakeStat({ size: PINNED_WINDOWS_POWERSHELL.executableBytes + 1 }),
        realpathSyncImpl: () => PINNED_WINDOWS_POWERSHELL.executablePath,
        readFileSyncImpl() {
          byteReads += 1;
          return Buffer.alloc(1);
        },
      }),
      (error) => error.code === "WINDOWS_POWERSHELL_BYTES_MISMATCH",
    );
    assert.equal(byteReads, 0);
  });

  await t.test("mutated bytes", () => {
    const mutated = Buffer.from(readFileSync(PINNED_WINDOWS_POWERSHELL.executablePath));
    mutated[0] ^= 0xff;
    assert.throws(
      () => resolvePinnedWindowsPowerShellExecutable({ readFileSyncImpl: () => mutated }),
      (error) => error.code === "WINDOWS_POWERSHELL_BYTES_MISMATCH",
    );
  });

  await t.test("identity changed during read", () => {
    let statCalls = 0;
    const bytes = readFileSync(PINNED_WINDOWS_POWERSHELL.executablePath);
    assert.throws(
      () => resolvePinnedWindowsPowerShellExecutable({
        lstatSyncImpl() {
          statCalls += 1;
          return fakeStat(statCalls === 2 ? { mtimeMs: 41 } : {});
        },
        realpathSyncImpl: () => PINNED_WINDOWS_POWERSHELL.executablePath,
        readFileSyncImpl: () => bytes,
      }),
      (error) => error.code === "WINDOWS_POWERSHELL_CHANGED_DURING_READ",
    );
  });
});

test("ACL child environment is an exact eight-key object with no inherited executable selectors", () => {
  const repositoryRoot = path.resolve("E:\\survey-qa");
  const target = path.join(repositoryRoot, "worker-v2");
  const environment = buildWindowsAclChildEnvironment(target, repositoryRoot);
  assert.deepEqual(Object.keys(environment).sort(), WINDOWS_ACL_CHILD_ENVIRONMENT_KEYS);
  assert.deepEqual(environment, {
    PATH: "",
    PSModulePath: "",
    SURVEY_QA_ACL_REPOSITORY: repositoryRoot,
    SURVEY_QA_ACL_TARGET: target,
    SystemRoot: "C:\\Windows",
    TEMP: repositoryRoot,
    TMP: repositoryRoot,
    WINDIR: "C:\\Windows",
  });
  assert.ok(Object.isFrozen(environment));
  assert.equal("NODE_OPTIONS" in environment, false);
  assert.equal("PATHEXT" in environment, false);
  assert.equal("ComSpec" in environment, false);
});

test("every executable-selector, path, or extra child-environment mutation is rejected", () => {
  const repositoryRoot = path.resolve("E:\\survey-qa");
  const target = path.join(repositoryRoot, "worker-v2");
  const expected = buildWindowsAclChildEnvironment(target, repositoryRoot);
  const mutations = [
    ["PATH", { ...expected, PATH: "C:\\fixture-poison" }],
    ["PSModulePath", { ...expected, PSModulePath: "C:\\fixture-module-poison" }],
    ["SystemRoot", { ...expected, SystemRoot: "D:\\Windows" }],
    ["WINDIR", { ...expected, WINDIR: "D:\\Windows" }],
    ["TEMP", { ...expected, TEMP: repositoryRoot }],
    ["target", { ...expected, SURVEY_QA_ACL_TARGET: repositoryRoot }],
    ["extra NODE_OPTIONS", { ...expected, NODE_OPTIONS: "--import=fixture-poison.mjs" }],
  ];
  // TEMP equals repositoryRoot for this target, so make that mutation genuinely distinct.
  mutations[4][1].TEMP = path.join(repositoryRoot, ".test-tmp");
  for (const [label, environment] of mutations) {
    assert.throws(
      () => assertWindowsAclChildEnvironment(environment, { target, repositoryRoot }),
      (error) => error.code === "WINDOWS_ACL_ENVIRONMENT_INVALID",
      label,
    );
  }
});

test("descriptor and child-environment substitution stop before ACL output can be trusted", (t) => {
  const { repositoryRoot, target } = fixture(t);
  let spawnCount = 0;
  const spawnSyncImpl = () => {
    spawnCount += 1;
    return { status: 0, stdout: "{\"forged\":true}", stderr: "" };
  };

  assert.throws(
    () => runWindowsAcl("fixture", target, repositoryRoot, {
      resolvePinnedWindowsPowerShellExecutableImpl: () => Object.freeze({
        ...PINNED_WINDOWS_POWERSHELL,
        executablePath: "C:\\fixture\\powershell.exe",
      }),
      spawnSyncImpl,
    }),
    (error) => error.code === "WINDOWS_POWERSHELL_DESCRIPTOR_INVALID",
  );
  assert.equal(spawnCount, 0);

  const expectedEnvironment = buildWindowsAclChildEnvironment(target, repositoryRoot);
  assert.throws(
    () => runWindowsAcl("fixture", target, repositoryRoot, {
      resolvePinnedWindowsPowerShellExecutableImpl: () => PINNED_WINDOWS_POWERSHELL,
      buildWindowsAclChildEnvironmentImpl: () => ({
        ...expectedEnvironment,
        PATH: "C:\\fixture-npx-poison",
      }),
      spawnSyncImpl,
    }),
    (error) => error.code === "WINDOWS_ACL_ENVIRONMENT_INVALID",
  );
  assert.equal(spawnCount, 0);
});

test("verified command uses the exact executable, encoded program, and closed environment", (t) => {
  const { repositoryRoot, target } = fixture(t);
  let resolveCount = 0;
  const result = runWindowsAcl("fixture-program", target, repositoryRoot, {
    resolvePinnedWindowsPowerShellExecutableImpl() {
      resolveCount += 1;
      return PINNED_WINDOWS_POWERSHELL;
    },
    spawnSyncImpl(command, args, options) {
      assert.equal(command, PINNED_WINDOWS_POWERSHELL.executablePath);
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.equal(Buffer.from(args[4], "base64").toString("utf16le"), "fixture-program");
      assertWindowsAclChildEnvironment(options.env, { target, repositoryRoot });
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.timeout, 20_000);
      return { status: 0, stdout: "{\"verified\":true}\n", stderr: "" };
    },
  });
  assert.deepEqual(result, { verified: true });
  assert.equal(resolveCount, 2);
});

test("full Windows ACL harden and unfiltered reinspection pass with empty PATH and PSModulePath", (t) => {
  const { repositoryRoot, target } = fixture(t);
  hardenPrivateLocalDirectory(target, repositoryRoot);
  assertPrivateLocalPath(target, repositoryRoot, { directory: true });
  const child = path.join(target, "evidence.json");
  writeFileSync(child, "{}\n", "utf8");
  assertPrivateLocalPath(child, repositoryRoot);
});
