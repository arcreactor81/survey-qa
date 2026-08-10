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
  "tools/tests/live-canary-deploy.test.mjs",
  "tools/tests/live-canary-remote-secret-audit.test.mjs",
  "tools/tests/live-canary-workflow-gate.test.mjs",
  "tools/tests/live-canary.test.mjs",
]);

/** These are relevant visual suites, but `node tools/test.mjs` owns their custom registry. */
export const CUSTOM_REGISTRY_VISUAL_EXCLUSIONS = Object.freeze([
  "tools/tests/d49-vision-reconcile.test.mjs",
]);

const MANIFEST_PATH = /^tools\/tests\/[A-Za-z0-9._-]+\.test\.mjs$/u;
const RELEVANT_TEST_NAME = /(?:vision|visual|canary|mistral)/iu;
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

  const allowed = new Set([...required, ...exclusions]);
  const testsDirectory = path.join(root, "tools", "tests");
  let directoryEntries;
  try {
    directoryEntries = readdirSync(testsDirectory, { withFileTypes: true });
  } catch {
    throw new VisualTestRunnerError(
      "TEST_DIRECTORY_UNAVAILABLE",
      "visual test directory is unavailable",
    );
  }
  const unregistered = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.mjs") &&
        RELEVANT_TEST_NAME.test(entry.name),
    )
    .map((entry) => `tools/tests/${entry.name}`)
    .filter((entry) => !allowed.has(entry))
    .sort();
  if (unregistered.length > 0) {
    throw new VisualTestRunnerError(
      "UNREGISTERED_RELEVANT_TEST",
      `relevant visual test is not classified in the closed manifest: ${unregistered.join(", ")}`,
    );
  }

  return resolvedRequired;
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
