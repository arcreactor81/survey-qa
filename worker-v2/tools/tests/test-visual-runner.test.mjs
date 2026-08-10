import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CUSTOM_REGISTRY_VISUAL_EXCLUSIONS,
  REQUIRED_VISUAL_NODE_TESTS,
  runVisualVerification,
  verifyVisualTestManifest,
} from "../test-visual.mjs";

const NATIVE_TEST = `import test from "node:test";\ntest("fixture", () => {});\n`;
const CUSTOM_TEST = `import { suite, test } from "../testkit.mjs";\nsuite("fixture", () => test("case", () => {}));\n`;

test("closed production manifest includes both Mistral suites and no custom-registry suite", () => {
  assert.equal(REQUIRED_VISUAL_NODE_TESTS.length, 25);
  assert.equal(new Set(REQUIRED_VISUAL_NODE_TESTS).size, REQUIRED_VISUAL_NODE_TESTS.length);
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/mistral-medium35-client.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/mistral-ocr4-client.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/test-visual-runner.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/live-canary-remote-secret-audit.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/live-canary-workflow-gate.test.mjs"));
  assert.equal(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/d49-vision-reconcile.test.mjs"), false);
  assert.deepEqual(CUSTOM_REGISTRY_VISUAL_EXCLUSIONS, [
    "tools/tests/d49-vision-reconcile.test.mjs",
  ]);
  assert.equal(verifyVisualTestManifest().length, REQUIRED_VISUAL_NODE_TESTS.length);
});

test("manifest accepts native node:test while keeping the custom registry explicitly separate", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  const resolved = verifyVisualTestManifest({
    workerRoot: root,
    requiredFiles: ["tools/tests/visual-native.test.mjs"],
    customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
  });
  assert.deepEqual(resolved, [path.join(root, "tools", "tests", "visual-native.test.mjs")]);
});

test("missing required file makes the manifest fail before spawning Node", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-missing.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) => error.code === "REQUIRED_FILE_MISSING",
  );
});

test("custom-registry file cannot masquerade as a native node:test gate", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/vision-custom.test.mjs": CUSTOM_TEST,
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/vision-custom.test.mjs"],
      customRegistryExclusions: [],
    }),
    (error) => error.code === "CUSTOM_REGISTRY_IN_NODE_MANIFEST",
  );
});

test("new relevant native test must be classified instead of being silently orphaned", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/vision-unregistered.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-native.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) => error.code === "UNREGISTERED_RELEVANT_TEST",
  );
});

test("child nonzero exit is forwarded exactly by the shared runner", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  const processLike = { execPath: "fixture-node", exitCode: null };
  const calls = [];
  const errors = [];
  const exitCode = runVisualVerification({
    workerRoot: root,
    requiredFiles: ["tools/tests/visual-native.test.mjs"],
    customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    processLike,
    stderr: { write: (value) => errors.push(value) },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 7, signal: null };
    },
  });

  assert.equal(exitCode, 7);
  assert.equal(processLike.exitCode, 7);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fixture-node");
  assert.deepEqual(calls[0].args, [
    "--test",
    "--test-concurrency=1",
    path.join("tools", "tests", "visual-native.test.mjs"),
  ]);
  assert.deepEqual(calls[0].options, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
});

test("a thrown child-process launch error fails closed", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
  });
  const processLike = { execPath: "fixture-node", exitCode: null };
  const errors = [];
  const exitCode = runVisualVerification({
    workerRoot: root,
    requiredFiles: ["tools/tests/visual-native.test.mjs"],
    customRegistryExclusions: [],
    processLike,
    stderr: { write: (value) => errors.push(value) },
    spawnSyncImpl() {
      throw new Error("synthetic launch failure");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(processLike.exitCode, 1);
  assert.match(errors.join(""), /synthetic launch failure/u);
});

function fixtureRoot(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "visual-test-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source, "utf8");
  }
  return root;
}
