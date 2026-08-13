#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(HERE, "..");

/**
 * Closed manifest of native node:test gates for visual capture, provider transport, durable
 * accounting, rollout configuration, and the isolated canary. A filename discovery glob is not
 * sufficient: custom-registry files also end in `.test.mjs` and Node would call an import-only
 * custom suite a passing test file without executing its registered cases.
 */
export const REQUIRED_VISUAL_NODE_TESTS = Object.freeze([
  "tools/tests/test-visual-runner.test.mjs",
  // Quarantined local computer-use transport/actuation adapter. Despite this runner's
  // historical name, its mutual-closure check owns every native node:test suite.
  "tools/tests/openai-computer-use.test.mjs",
  // Fail-capable audit of the dedicated CUA mutation harness itself. Keeping this beside the
  // quarantined adapter makes the five meta-tests part of the same closed release manifest.
  "tools/tests/openai-computer-use-mutant-harness.test.mjs",
  "tools/tests/vision-provider-clients.test.mjs",
  "tools/tests/mistral-medium35-client.test.mjs",
  "tools/tests/mistral-ocr4-client.test.mjs",
  "tools/tests/vision-cost-bound.test.mjs",
  "tools/tests/vision-durable-client.test.mjs",
  "tools/tests/vision-store.test.mjs",
  "tools/tests/visual-observation.test.mjs",
  "tools/tests/visual-epoch-input.test.mjs",
  "tools/tests/visual-epoch-processor.test.mjs",
  "tools/tests/visual-work.test.mjs",
  "tools/tests/visual-progress.test.mjs",
  "tools/tests/visual-shadow-workflow.test.mjs",
  "tools/tests/visual-usage-strict.test.mjs",
  "tools/tests/visual-status.test.mjs",
  "tools/tests/visual-status-api.test.mjs",
  "tools/tests/visual-coverage.test.mjs",
  "tools/tests/visual-coverage-closure.test.mjs",
  "tools/tests/walk-artifact-index.test.mjs",
  "tools/tests/visual-rollout-config.test.mjs",
  "tools/tests/visual-deploy-config-audit.test.mjs",
  "tools/tests/private-local-output.test.mjs",
  "tools/tests/live-canary-deploy.test.mjs",
  "tools/tests/live-canary-remote-secret-audit.test.mjs",
  "tools/tests/live-canary-workflow-gate.test.mjs",
  "tools/tests/live-canary.test.mjs",
  "tools/tests/pinned-wrangler-command.test.mjs",
  "tools/tests/pinned-wrangler-output-graph.integration.test.mjs",
  "tools/tests/canary-source-snapshot.test.mjs",
  "tools/tests/canary-bundle-inputs.test.mjs",
  "tools/tests/canary-post-deploy-attestation.test.mjs",
  "tools/tests/hardened-canary-deploy.test.mjs",
  "tools/tests/hardened-one-call-runner.test.mjs",
]);

/** These are relevant visual suites, but `node tools/test.mjs` owns their custom registry. */
export const CUSTOM_REGISTRY_VISUAL_EXCLUSIONS = Object.freeze([
  "tools/tests/d49-vision-reconcile.test.mjs",
]);

const MANIFEST_PATH = /^tools\/tests\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs$/u;
// FIX (review ledger-claims finding 1): the orphan sweep used to pre-filter candidate filenames
// with /(vision|visual|canary|mistral)/i, so a future gemini-*.test.mjs or ocr4-*.test.mjs was
// executed by NO runner and both suites stayed green. The sweep now computes full mutual runner
// closure over tools/tests instead: every *.test.mjs must be owned by exactly one runner —
// either this manifest (REQUIRED + custom-registry exclusions) or the dispatcher's literal FILES
// list in tools/test.mjs, which is parsed fail-closed below.
const DISPATCHER_MANIFEST_RELATIVE = "tools/test.mjs";
const DISPATCHER_ENTRY_LINE = /^"(\.\/tests\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs)",?$/u;
const NODE_TEST_IMPORT = /\bfrom\s+["']node:test["']|\bimport\s+["']node:test["']/u;
const CUSTOM_REGISTRY_IMPORT =
  /^[ \t]*import[ \t]*\{[^}]*\b(?:suite|test)\b[^}]*\}[ \t]*from[ \t]*["'][^"'\r\n]*testkit\.mjs["']/mu;

export class VisualTestRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VisualTestRunnerError";
    this.code = code;
  }
}

export function verifyVisualTestManifest({
  workerRoot = WORKER_ROOT,
  requiredFiles = REQUIRED_VISUAL_NODE_TESTS,
  customRegistryExclusions = CUSTOM_REGISTRY_VISUAL_EXCLUSIONS,
} = {}) {
  const root = path.resolve(workerRoot);
  const required = normalizeUniqueManifest(requiredFiles, "required");
  const exclusions = normalizeUniqueManifest(
    customRegistryExclusions,
    "custom-registry exclusion",
    { allowEmpty: true },
  );
  const overlap = required.find((entry) => exclusions.includes(entry));
  if (overlap !== undefined) {
    throw new VisualTestRunnerError(
      "MANIFEST_CLASSIFICATION_CONFLICT",
      `visual test is both required and excluded: ${overlap}`,
    );
  }

  const resolvedRequired = required.map((entry) => {
    const inspected = inspectManifestFile(root, entry, "required");
    if (inspected.customRegistry) {
      throw new VisualTestRunnerError(
        "CUSTOM_REGISTRY_IN_NODE_MANIFEST",
        `custom-registry test cannot be executed by node --test: ${entry}`,
      );
    }
    if (!inspected.nodeTest) {
      throw new VisualTestRunnerError(
        "REQUIRED_NOT_NODE_TEST",
        `required visual test does not import node:test: ${entry}`,
      );
    }
    return inspected.absolutePath;
  });

  for (const entry of exclusions) {
    const inspected = inspectManifestFile(root, entry, "custom-registry exclusion");
    if (!inspected.customRegistry || inspected.nodeTest) {
      throw new VisualTestRunnerError(
        "STALE_CUSTOM_REGISTRY_EXCLUSION",
        `visual exclusion is not exclusively a custom-registry test: ${entry}`,
      );
    }
  }

  // Full mutual runner closure (see the FIX note at DISPATCHER_MANIFEST_RELATIVE). The literal
  // rule "exactly one of dispatcher FILES or this manifest" cannot hold verbatim: the
  // custom-registry exclusions are BY DESIGN files the dispatcher runs (they are visual-relevant
  // but testkit-registered), so the declared overlap is exactly the exclusion list and every
  // exclusion must actually be dispatched — otherwise the excluded file runs nowhere.
  const dispatched = new Set(readDispatcherManifest(root));
  const undispatchedExclusion = exclusions.find((entry) => !dispatched.has(entry));
  if (undispatchedExclusion !== undefined) {
    throw new VisualTestRunnerError(
      "EXCLUSION_NOT_DISPATCHED",
      `custom-registry exclusion is not in the dispatcher FILES manifest, so it would run under no runner: ${undispatchedExclusion}`,
    );
  }
  const dualRegistered = required.find((entry) => dispatched.has(entry));
  if (dualRegistered !== undefined) {
    throw new VisualTestRunnerError(
      "DUAL_REGISTERED_TEST",
      `test is claimed by both the dispatcher FILES manifest and the required visual manifest: ${dualRegistered}`,
    );
  }

  const allowed = new Set([...required, ...exclusions]);
  const unregistered = discoverSemanticTestModules(root)
    .filter((entry) => !allowed.has(entry) && !dispatched.has(entry))
    .sort();
  if (unregistered.length > 0) {
    // Code name kept from the name-filtered era for grep continuity; every test file in
    // tools/tests is now relevant — there is no name filter any more.
    throw new VisualTestRunnerError(
      "UNREGISTERED_RELEVANT_TEST",
      `test file is owned by no runner (neither dispatcher FILES nor the visual manifest): ${unregistered.join(", ")}`,
    );
  }

  return resolvedRequired;
}

/**
 * Recursively enumerate executable test modules by what they import, not by a filename keyword
 * or `.test.mjs` suffix. A nested `gemini-check.spec.mjs` is just as capable of containing a
 * real node:test suite as a top-level visual test. Links are refused rather than traversed: a
 * linked subtree makes the denominator mutable outside the repository path being checked.
 */
export function discoverSemanticTestModules(workerRoot) {
  const root = path.resolve(workerRoot);
  const testsDirectory = path.join(root, "tools", "tests");
  const discovered = [];

  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new VisualTestRunnerError(
        "TEST_DIRECTORY_UNAVAILABLE",
        "visual test directory or one of its nested directories is unavailable",
      );
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      let stat;
      try {
        stat = lstatSync(absolutePath);
      } catch {
        throw new VisualTestRunnerError(
          "TEST_PATH_UNAVAILABLE",
          "a path beneath the visual test directory could not be inspected",
        );
      }
      if (stat.isSymbolicLink()) {
        throw new VisualTestRunnerError(
          "TEST_PATH_LINKED",
          "the visual test directory must not contain symbolic links or junctions",
        );
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile() || !entry.name.endsWith(".mjs")) continue;

      let source;
      try {
        source = readFileSync(absolutePath, "utf8");
      } catch {
        throw new VisualTestRunnerError(
          "TEST_FILE_UNREADABLE",
          "a JavaScript module beneath the visual test directory could not be read",
        );
      }
      if (!NODE_TEST_IMPORT.test(source) && !CUSTOM_REGISTRY_IMPORT.test(source)) continue;
      const relative = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!MANIFEST_PATH.test(relative)) {
        throw new VisualTestRunnerError(
          "DISCOVERED_TEST_PATH_INVALID",
          "a semantically identified test module has a path the runners cannot name safely",
        );
      }
      discovered.push(relative);
    }
  };

  visit(testsDirectory);
  return discovered.sort();
}

/**
 * Parse the dispatcher's literal FILES manifest without importing tools/test.mjs (importing it
 * would execute the whole custom-registry suite and process.exit). The parse is fail-closed: a
 * missing file, a missing literal, an entry line that is not exactly one quoted
 * "./tests/<safe-relative-name>.mjs" string, an empty list, or a duplicate all refuse with a named code
 * rather than silently shrinking the closure set.
 */
export function readDispatcherManifest(workerRoot) {
  const dispatcherPath = path.join(path.resolve(workerRoot), "tools", "test.mjs");
  let source;
  try {
    source = readFileSync(dispatcherPath, "utf8");
  } catch {
    throw new VisualTestRunnerError(
      "DISPATCHER_MANIFEST_UNAVAILABLE",
      `${DISPATCHER_MANIFEST_RELATIVE} could not be read for runner-closure verification`,
    );
  }
  const literal = source.match(/const FILES = \[([\s\S]*?)^\];/mu);
  if (literal === null) {
    throw new VisualTestRunnerError(
      "DISPATCHER_MANIFEST_UNPARSEABLE",
      `${DISPATCHER_MANIFEST_RELATIVE} no longer contains the literal FILES manifest`,
    );
  }
  const entries = [];
  for (const rawLine of literal[1].split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    const match = DISPATCHER_ENTRY_LINE.exec(line);
    if (match === null) {
      throw new VisualTestRunnerError(
        "DISPATCHER_MANIFEST_UNPARSEABLE",
        `${DISPATCHER_MANIFEST_RELATIVE} FILES manifest has an unrecognized line; runner closure cannot be proven`,
      );
    }
    entries.push(`tools/tests/${match[1].slice("./tests/".length)}`);
  }
  if (entries.length === 0) {
    throw new VisualTestRunnerError(
      "DISPATCHER_MANIFEST_UNPARSEABLE",
      `${DISPATCHER_MANIFEST_RELATIVE} FILES manifest is empty`,
    );
  }
  if (new Set(entries).size !== entries.length) {
    throw new VisualTestRunnerError(
      "DISPATCHER_MANIFEST_DUPLICATE",
      `${DISPATCHER_MANIFEST_RELATIVE} FILES manifest contains duplicates`,
    );
  }
  return entries;
}

export function runVisualVerification({
  workerRoot = WORKER_ROOT,
  requiredFiles = REQUIRED_VISUAL_NODE_TESTS,
  customRegistryExclusions = CUSTOM_REGISTRY_VISUAL_EXCLUSIONS,
  spawnSyncImpl = spawnSync,
  processLike = process,
  stderr = process.stderr,
} = {}) {
  let resolvedFiles;
  try {
    resolvedFiles = verifyVisualTestManifest({
      workerRoot,
      requiredFiles,
      customRegistryExclusions,
    });
  } catch (error) {
    stderr.write(`visual verification manifest failed: ${safeErrorMessage(error)}\n`);
    processLike.exitCode = 1;
    return 1;
  }

  const root = path.resolve(workerRoot);
  const childArguments = [
    "--test",
    "--test-concurrency=1",
    // A completed isolated node:test file can otherwise retain a referenced helper handle
    // (esbuild's long-lived service is the observed case) and prevent the parent from ever
    // advancing to the rest of this closed manifest. Node still waits for every registered
    // test and after-hook before force-exit applies; this closes process lifecycle only.
    "--test-force-exit",
    ...resolvedFiles.map((absolutePath) => path.relative(root, absolutePath)),
  ];
  let child;
  try {
    child = spawnSyncImpl(processLike.execPath, childArguments, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (error) {
    stderr.write(`visual verification could not start: ${safeErrorMessage(error)}\n`);
    processLike.exitCode = 1;
    return 1;
  }

  let exitCode = 1;
  if (child.error !== undefined) {
    stderr.write(`visual verification could not start: ${safeErrorMessage(child.error)}\n`);
  } else if (Number.isInteger(child.status) && child.status >= 0) {
    exitCode = child.status;
  } else {
    const signal = typeof child.signal === "string" ? child.signal : "unknown signal";
    stderr.write(`visual verification terminated without an exit code (${signal})\n`);
  }
  processLike.exitCode = exitCode;
  return exitCode;
}

function inspectManifestFile(root, entry, classification) {
  const absolutePath = resolveManifestEntry(root, entry);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    throw new VisualTestRunnerError(
      "REQUIRED_FILE_MISSING",
      `${classification} file is absent: ${entry}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new VisualTestRunnerError(
      "REQUIRED_FILE_INVALID",
      `${classification} path is not a regular file: ${entry}`,
    );
  }

  let source;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    throw new VisualTestRunnerError(
      "REQUIRED_FILE_UNREADABLE",
      `${classification} file is unreadable: ${entry}`,
    );
  }
  return {
    absolutePath,
    nodeTest: NODE_TEST_IMPORT.test(source),
    customRegistry: CUSTOM_REGISTRY_IMPORT.test(source),
  };
}

function normalizeUniqueManifest(entries, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0)) {
    throw new VisualTestRunnerError("MANIFEST_EMPTY", `${label} manifest is empty`);
  }
  const normalized = entries.map((entry) => normalizeManifestEntry(entry, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new VisualTestRunnerError("MANIFEST_DUPLICATE", `${label} manifest contains duplicates`);
  }
  return normalized;
}

function normalizeManifestEntry(value, label) {
  if (typeof value !== "string") {
    throw new VisualTestRunnerError("MANIFEST_PATH_INVALID", `${label} path is not a string`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (!MANIFEST_PATH.test(normalized)) {
    throw new VisualTestRunnerError("MANIFEST_PATH_INVALID", `${label} path is invalid: ${value}`);
  }
  return normalized;
}

function resolveManifestEntry(root, entry) {
  const absolutePath = path.resolve(root, ...entry.split("/"));
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VisualTestRunnerError("MANIFEST_PATH_INVALID", `manifest path escapes root: ${entry}`);
  }
  return absolutePath;
}

function safeErrorMessage(error) {
  if (error instanceof VisualTestRunnerError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "unknown runner failure";
}

function isDirectExecution() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) runVisualVerification();
