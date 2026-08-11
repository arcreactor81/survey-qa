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

// Minimal dispatcher manifest fixture. Since the review ledger-claims fix, verifyVisualTestManifest
// computes full runner closure against the literal FILES list in tools/test.mjs, so every fixture
// root carries one (fixtureRoot writes this default unless a test overrides it).
function dispatcherSource(entries = ["./tests/d49-vision-reconcile.test.mjs"]) {
  return [
    "// fixture dispatcher",
    "const FILES = [",
    ...entries.map((entry) => `  "${entry}",`),
    "];",
    "",
  ].join("\n");
}

test("closed production manifest includes both Mistral suites and no custom-registry suite", () => {
  assert.equal(REQUIRED_VISUAL_NODE_TESTS.length, 32);
  assert.equal(new Set(REQUIRED_VISUAL_NODE_TESTS).size, REQUIRED_VISUAL_NODE_TESTS.length);
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/mistral-medium35-client.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/mistral-ocr4-client.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/test-visual-runner.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/private-local-output.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/live-canary-remote-secret-audit.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/live-canary-workflow-gate.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/pinned-wrangler-command.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/canary-source-snapshot.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/canary-bundle-inputs.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/canary-post-deploy-attestation.test.mjs"));
  assert.ok(REQUIRED_VISUAL_NODE_TESTS.includes("tools/tests/hardened-canary-deploy.test.mjs"));
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

test("an orphan whose name matches no visual keyword is caught by the widened sweep", (t) => {
  // QA pin for review ledger-claims finding 1: pre-fix, the orphan sweep filtered candidates
  // with /(vision|visual|canary|mistral)/i BEFORE the membership check, so this exact fixture —
  // a gemini-named native test registered in neither manifest — passed verification and would
  // have been executed by no runner while both suites stayed green.
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/gemini-gateway-client.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-native.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) => error.code === "UNREGISTERED_RELEVANT_TEST" && /gemini-gateway-client/u.test(error.message),
  );
});

test("a nested semantic test with an unconventional suffix cannot sit outside both runners", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/future-provider/gemini-check.spec.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-native.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) =>
      error.code === "UNREGISTERED_RELEVANT_TEST" &&
      /future-provider\/gemini-check\.spec\.mjs/u.test(error.message),
  );
});

test("a nested semantic test can be explicitly owned by the native runner", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/future-provider/gemini-check.spec.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  });
  const resolved = verifyVisualTestManifest({
    workerRoot: root,
    requiredFiles: ["tools/tests/future-provider/gemini-check.spec.mjs"],
    customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
  });
  assert.deepEqual(resolved, [path.join(root, "tools", "tests", "future-provider", "gemini-check.spec.mjs")]);
});

test("a test claimed by both runners is a closure conflict, not a double execution", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  }, {
    dispatcher: dispatcherSource([
      "./tests/d49-vision-reconcile.test.mjs",
      "./tests/visual-native.test.mjs",
    ]),
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-native.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) => error.code === "DUAL_REGISTERED_TEST",
  );
});

test("a custom-registry exclusion the dispatcher does not run is refused as running nowhere", (t) => {
  const root = fixtureRoot(t, {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  }, {
    dispatcher: dispatcherSource(["./tests/unrelated-suite.test.mjs"]),
  });
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: root,
      requiredFiles: ["tools/tests/visual-native.test.mjs"],
      customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
    }),
    (error) => error.code === "EXCLUSION_NOT_DISPATCHED",
  );
});

test("a missing or unparseable dispatcher manifest refuses instead of shrinking the closure", (t) => {
  const files = {
    "tools/tests/visual-native.test.mjs": NATIVE_TEST,
    "tools/tests/d49-vision-reconcile.test.mjs": CUSTOM_TEST,
  };
  const options = {
    requiredFiles: ["tools/tests/visual-native.test.mjs"],
    customRegistryExclusions: ["tools/tests/d49-vision-reconcile.test.mjs"],
  };
  assert.throws(
    () => verifyVisualTestManifest({ workerRoot: fixtureRoot(t, files, { dispatcher: null }), ...options }),
    (error) => error.code === "DISPATCHER_MANIFEST_UNAVAILABLE",
  );
  assert.throws(
    () => verifyVisualTestManifest({ workerRoot: fixtureRoot(t, files, { dispatcher: "export {};\n" }), ...options }),
    (error) => error.code === "DISPATCHER_MANIFEST_UNPARSEABLE",
  );
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: fixtureRoot(t, files, {
        dispatcher: '// fixture\nconst FILES = [\n  "./tests/d49-vision-reconcile.test.mjs",\n  ...extraFiles,\n];\n',
      }),
      ...options,
    }),
    (error) => error.code === "DISPATCHER_MANIFEST_UNPARSEABLE",
  );
  assert.throws(
    () => verifyVisualTestManifest({
      workerRoot: fixtureRoot(t, files, {
        dispatcher: dispatcherSource([
          "./tests/d49-vision-reconcile.test.mjs",
          "./tests/d49-vision-reconcile.test.mjs",
        ]),
      }),
      ...options,
    }),
    (error) => error.code === "DISPATCHER_MANIFEST_DUPLICATE",
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

function fixtureRoot(t, files, { dispatcher = dispatcherSource() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "visual-test-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withDispatcher = dispatcher === null ? { ...files } : { "tools/test.mjs": dispatcher, ...files };
  for (const [relativePath, source] of Object.entries(withDispatcher)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source, "utf8");
  }
  return root;
}
