/**
 * THE MUTATION HARNESS ITSELF — and the reason it is a separate file.
 *
 * A mutation run answers one question: "if I break the behaviour this test guards, does THAT
 * test fail?" Everything here exists to stop that question being answered dishonestly.
 *
 * ==================== THE DEFECT THIS FILE WAS WRITTEN TO CLOSE ====================
 *
 * The previous harness scored a mutant as KILLED if the output contained ANY `FAIL` line.
 * On 5 Aug the suite had 22 pre-existing failures. Under that rule every mutant — including
 * one that changes nothing at all — was scored killed, and the harness reported a clean
 * sweep over a suite that was proving nothing. A mutation harness that cannot fail is the
 * same class of defect as the tests it is supposed to be auditing, one level up.
 *
 * So the kill criterion here is BASELINE-AWARE and NAMED:
 *
 *   1. The suite is run UNMUTATED first and the exact set of failing test names is recorded.
 *   2. A mutant is killed only by a test that is NOT in that set — a NEW failure.
 *   3. A mutant declaring `kills` is killed only when THAT NAMED TEST is among the new
 *      failures. "Something, somewhere went red" is not proof that a specific guard works;
 *      a mutation broad enough to fail the whole suite would otherwise score as a kill of
 *      every property at once.
 *
 * And the rule is enforced against the harness itself: before any real mutant runs, a NO-OP
 * mutant (find === replace, a rewrite that changes nothing) is scored by the same code path.
 * It MUST come back not-killed. If a no-op ever scores as killed, the criterion has regressed
 * and this exits non-zero WITHOUT running the real mutants, because their results would be
 * meaningless. That self-check is the thing that stops 5 Aug from happening twice.
 *
 * ==================== WHAT IS NEVER WRITTEN TO DISK ====================
 *
 * Nothing under `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside esbuild's
 * load step, so an interrupted run cannot leave a mutated working copy behind — which matters
 * in a tree other agents are editing, and is what makes it safe to mutate files this session
 * is forbidden to edit.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");
const SUPERVISOR_PATH = path.join(HERE, "windows-job-supervisor.ps1");
const SUPERVISOR_DRAIN_GRACE_MS = 30_000;
const SUPERVISOR_STARTUP_GRACE_MS = 120_000;
const SUPERVISOR_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SUPERVISOR_CLOSE_GRACE_MS = 5_000;
const SUPERVISOR_KILL_RETRY_MS = 250;
const DIAGNOSTIC_TRANSCRIPT_LIMIT_BYTES = 64 * 1024;
const SUPERVISOR_ERROR_MESSAGE_LIMIT = 2048;
const CUA_CONTAINED_SUBJECTS = Object.freeze([
  path.join(WORKER_ROOT, "tools", "tests", "openai-computer-use.test.mjs"),
  path.join(WORKER_ROOT, "tools", "tests", "openai-computer-use-mutant-harness.test.mjs"),
]);
const TEST_ONLY_OUTPUT_FLOOD_SUBJECT = path.join(
  WORKER_ROOT,
  "tools",
  "tests",
  "fixtures",
  "windows-job-output-flood.mjs",
);

const FAIL_LINE = /^ {2}FAIL {2}(.+)$/gm;
const SUMMARY = /^(\d+)\/(\d+) passed, (\d+) failed$/gm;
export const EXACT_TEST_NAMES_STDIN_FLAG = "--exact-test-names-stdin";
export const DEFAULT_MUTATION_CHILD_TIMEOUT_MS = 120_000;
export const MAX_MUTATION_CHILD_TIMEOUT_MS = 600_000;
export const MUTATION_TRANSCRIPT_LIMIT_BYTES = 67_108_864;
export const WINDOWS_JOB_CONTAINMENT_SCOPE =
  "win32-job-membership; brokered process creation outside job inheritance is excluded";
const SUPERVISOR_RECEIPT_LIMIT_BYTES = 64 * 1024;
const SUPERVISOR_RECEIPT_PROPERTIES = Object.freeze([
  "schema", "requestSha256", "requestPinnedThroughRun", "executablePath",
  "executableSha256", "executableSha256After", "subjectPath", "subjectSha256",
  "subjectSha256After", "workingDirectory", "argumentCount", "executableArgumentCount",
  "timeoutMs", "innerTimeoutMs", "drainGraceMs", "transcriptLimitBytes",
  "transcriptLimitExceeded", "completionIssue", "startedUtc", "endedUtc", "durationMs",
  "timedOut", "exitCode", "launchErrorType", "postRunErrorType", "processId",
  "initialActiveProcesses", "finalActiveProcesses", "jobAssigned", "processResumed",
  "assignmentBeforeResume", "membershipVerified", "containmentScope", "terminationIssued",
  "handlesClosed", "abiValidated", "pointerSize", "inputPinsHeldThroughRun",
  "emptyStdinPipe", "outputHashesCapturedBeforeClose", "stdoutLog", "stdoutBytes",
  "stdoutSha256", "stdoutSha256After", "stderrLog", "stderrBytes", "stderrSha256",
  "stderrSha256After", "attestation",
]);
const SUPERVISOR_RECEIPT_STRING_PROPERTIES = Object.freeze([
  "schema", "requestSha256", "executablePath", "executableSha256",
  "executableSha256After", "subjectPath", "subjectSha256", "subjectSha256After",
  "workingDirectory", "startedUtc", "endedUtc", "containmentScope", "stdoutLog",
  "stderrLog",
]);
const SUPERVISOR_RECEIPT_BOOLEAN_PROPERTIES = Object.freeze([
  "requestPinnedThroughRun", "transcriptLimitExceeded", "timedOut", "jobAssigned",
  "processResumed", "assignmentBeforeResume", "membershipVerified", "terminationIssued",
  "handlesClosed", "abiValidated", "inputPinsHeldThroughRun", "emptyStdinPipe",
  "outputHashesCapturedBeforeClose",
]);
const SUPERVISOR_RECEIPT_INTEGER_PROPERTIES = Object.freeze([
  "argumentCount", "executableArgumentCount", "timeoutMs", "drainGraceMs",
  "transcriptLimitBytes", "durationMs", "pointerSize",
]);
const SUPERVISOR_RECEIPT_NULLABLE_STRING_PROPERTIES = Object.freeze([
  "completionIssue", "launchErrorType", "postRunErrorType", "stdoutSha256",
  "stdoutSha256After", "stderrSha256", "stderrSha256After",
]);
const SUPERVISOR_RECEIPT_NULLABLE_INTEGER_PROPERTIES = Object.freeze([
  "innerTimeoutMs", "exitCode", "processId", "initialActiveProcesses",
  "finalActiveProcesses", "stdoutBytes", "stderrBytes",
]);

export class TestSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TestSelectionError";
    this.code = code;
  }
}

export function resolveMutationChildTimeout(raw = process.env.MUTATION_CHILD_TIMEOUT_MS) {
  if (raw === undefined) return DEFAULT_MUTATION_CHILD_TIMEOUT_MS;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) {
    throw new TestSelectionError(
      "MUTATION_CHILD_TIMEOUT_INVALID",
      "MUTATION_CHILD_TIMEOUT_MS must be a positive base-10 integer",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MUTATION_CHILD_TIMEOUT_MS) {
    throw new TestSelectionError(
      "MUTATION_CHILD_TIMEOUT_INVALID",
      `MUTATION_CHILD_TIMEOUT_MS must not exceed ${MAX_MUTATION_CHILD_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export function classifySuiteProcess(run) {
  const stdout = `${run?.stdout ?? ""}`;
  const stderr = `${run?.stderr ?? ""}`;
  const out = `${stdout}${stderr}`;
  const failing = [...stdout.matchAll(FAIL_LINE), ...stderr.matchAll(FAIL_LINE)]
    .map((match) => match[1].trim());
  const summaries = [...stdout.matchAll(SUMMARY), ...stderr.matchAll(SUMMARY)];
  const summary = summaries.length === 1 ? summaries[0] : null;
  const childError = run?.error !== undefined && run?.error !== null;
  const errorCode = typeof run?.error?.code === "string" ? run.error.code : null;
  const errorName = typeof run?.error?.name === "string" ? run.error.name : null;
  const errorMessage =
    errorName === "MutationSupervisorError" && typeof run?.error?.message === "string"
      ? run.error.message
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .slice(0, SUPERVISOR_ERROR_MESSAGE_LIMIT)
      : null;
  const errorProperty =
    typeof run?.error?.property === "string" &&
    /^[A-Za-z][A-Za-z0-9]*$/u.test(run.error.property)
      ? run.error.property
      : null;
  const signal = typeof run?.signal === "string" ? run.signal : null;
  const status = Number.isInteger(run?.status) ? run.status : null;
  const passed = summary === null ? null : Number(summary[1]);
  const total = summary === null ? null : Number(summary[2]);
  const failed = summary === null ? null : Number(summary[3]);
  const summaryCoherent =
    summary !== null &&
    Number.isSafeInteger(passed) &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(failed) &&
    total > 0 &&
    passed + failed === total;
  const failingCountCoherent =
    summaryCoherent &&
    failing.length === failed &&
    failing.every((name) => name.length > 0) &&
    new Set(failing).size === failing.length;
  const statusCoherent =
    summaryCoherent &&
    ((failed === 0 && status === 0) || (failed > 0 && status === 1));
  let completionIssue = null;
  if (childError) completionIssue = "CHILD_ERROR";
  else if (signal !== null) completionIssue = "CHILD_SIGNAL";
  else if (summaries.length !== 1) completionIssue = "SUMMARY_COUNT";
  else if (!summaryCoherent) completionIssue = "SUMMARY_INVALID";
  else if (!failingCountCoherent) completionIssue = "FAIL_LINE_COUNT_MISMATCH";
  else if (!statusCoherent) completionIssue = "EXIT_STATUS_MISMATCH";
  return {
    out,
    status,
    signal,
    childError,
    errorCode,
    errorName,
    errorMessage,
    errorProperty,
    timedOut: errorCode === "ETIMEDOUT",
    failing,
    completed: completionIssue === null,
    completionIssue,
    summaryCount: summaries.length,
    summaryCoherent,
    failingCountCoherent,
    statusCoherent,
    passed,
    total,
    failed,
    anchorRejected: /mutant patch matched/u.test(out),
  };
}

function validateExactNames(names, label) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new TestSelectionError("EXACT_TEST_NAMES_EMPTY", `${label} must be a nonempty array`);
  }
  const seen = new Set();
  const validated = [];
  for (const [index, name] of names.entries()) {
    if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
      throw new TestSelectionError(
        "EXACT_TEST_NAME_INVALID",
        `${label}[${index}] must be a nonempty exact string with no surrounding whitespace`,
      );
    }
    if (seen.has(name)) {
      throw new TestSelectionError(
        "EXACT_TEST_NAME_DUPLICATE",
        `${label} contains a duplicate exact test name: ${name}`,
      );
    }
    seen.add(name);
    validated.push(name);
  }
  return validated;
}

/** Derive the stable first-seen union of every semantic guard named by every mutant. */
export function deriveExactKillNames(mutants) {
  if (!Array.isArray(mutants) || mutants.length === 0) {
    throw new TestSelectionError("MUTANTS_EMPTY", "mutation suite must declare at least one mutant");
  }
  const union = [];
  const seen = new Set();
  for (const [mutantIndex, mutant] of mutants.entries()) {
    if (mutant === null || typeof mutant !== "object" || Array.isArray(mutant)) {
      throw new TestSelectionError(
        "MUTANT_INVALID",
        `mutants[${mutantIndex}] must be an object`,
      );
    }
    const kills = mutant.kills;
    if (!Array.isArray(kills) || kills.length === 0) {
      throw new TestSelectionError(
        "MUTANT_KILLS_EMPTY",
        `mutant ${JSON.stringify(mutant.name ?? mutantIndex)} must declare at least one exact kill name`,
      );
    }
    for (const [killIndex, kill] of kills.entries()) {
      if (typeof kill !== "string" || kill.length === 0 || kill !== kill.trim()) {
        throw new TestSelectionError(
          "MUTANT_KILL_INVALID",
          `mutants[${mutantIndex}].kills[${killIndex}] must be a nonempty exact string with no surrounding whitespace`,
        );
      }
      if (!seen.has(kill)) {
        seen.add(kill);
        union.push(kill);
      }
    }
  }
  return validateExactNames(union, "derived exact kill union");
}

/** Parse the dispatcher's backwards-compatible substring mode or its closed exact-name mode. */
export function parseTestSelection(argv, exactNamesJson = "") {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TestSelectionError("TEST_SELECTOR_ARGS_INVALID", "test selector arguments must be strings");
  }
  if (argv.length === 0) return { mode: "substring", filter: "" };
  if (argv.length === 1 && argv[0] === EXACT_TEST_NAMES_STDIN_FLAG) {
    let parsed;
    try {
      parsed = JSON.parse(exactNamesJson);
    } catch {
      throw new TestSelectionError(
        "EXACT_TEST_NAMES_JSON_INVALID",
        "exact test-name stdin must be one valid JSON array",
      );
    }
    return { mode: "exact", names: validateExactNames(parsed, "exact test-name selector") };
  }
  if (argv.length === 1 && !argv[0].startsWith("--")) {
    return { mode: "substring", filter: argv[0] };
  }
  throw new TestSelectionError(
    "TEST_SELECTOR_ARGS_INVALID",
    `usage: test.mjs [substring-filter] | ${EXACT_TEST_NAMES_STDIN_FLAG}`,
  );
}

/** Select a nonempty denominator and prove each exact requested name resolves once. */
export function selectRegistryCases(registry, selection) {
  if (!Array.isArray(registry)) {
    throw new TestSelectionError("TEST_REGISTRY_INVALID", "test registry must be an array");
  }
  for (const [index, candidate] of registry.entries()) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.suite !== "string" ||
      typeof candidate.name !== "string"
    ) {
      throw new TestSelectionError(
        "TEST_REGISTRY_ENTRY_INVALID",
        `test registry entry ${index} has no exact suite/name identity`,
      );
    }
  }

  let selected;
  if (selection?.mode === "substring") {
    if (typeof selection.filter !== "string") {
      throw new TestSelectionError("SUBSTRING_FILTER_INVALID", "substring filter must be a string");
    }
    const folded = selection.filter.toLowerCase();
    selected = registry.filter((candidate) =>
      !folded || `${candidate.suite} ${candidate.name}`.toLowerCase().includes(folded));
  } else if (selection?.mode === "exact") {
    const names = validateExactNames(selection.names, "exact test-name selector");
    selected = names.map((name) => {
      const matches = registry.filter((candidate) => candidate.name === name);
      if (matches.length === 0) {
        throw new TestSelectionError(
          "EXACT_TEST_NAME_MISSING",
          `exact test name is not registered: ${name}`,
        );
      }
      if (matches.length !== 1) {
        throw new TestSelectionError(
          "EXACT_TEST_NAME_AMBIGUOUS",
          `exact test name resolves to ${matches.length} registered cases: ${name}`,
        );
      }
      return matches[0];
    });
  } else {
    throw new TestSelectionError("TEST_SELECTION_INVALID", "test selection mode is invalid");
  }

  if (selected.length === 0) {
    throw new TestSelectionError(
      "TEST_DENOMINATOR_EMPTY",
      "test selection resolved to an empty denominator",
    );
  }
  return selected;
}

function mutationError(code, message) {
  const error = new Error(message);
  error.name = "MutationSupervisorError";
  error.code = code;
  return error;
}

function boundedSupervisorControlDiagnostic(supervisor) {
  const combined = `${supervisor?.stderr ?? ""}\n${supervisor?.stdout ?? ""}`
    .replace(/[^\u0009\u000a\u000d\u0020-\u007e]/gu, "?")
    .trim();
  return combined.length === 0
    ? "no bounded control output"
    : combined.slice(-SUPERVISOR_ERROR_MESSAGE_LIMIT);
}

function resolvePowerShellPath() {
  if (process.platform !== "win32") {
    throw mutationError(
      "WINDOWS_JOB_SUPERVISOR_REQUIRED",
      "mutation execution requires Windows Job Objects",
    );
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !path.isAbsolute(systemRoot)) {
    throw mutationError("SYSTEM_ROOT_INVALID", "SystemRoot is unavailable or not absolute");
  }
  const candidate = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(candidate)) {
    throw mutationError("POWERSHELL_NOT_FOUND", `pinned Windows PowerShell is absent: ${candidate}`);
  }
  return candidate;
}

function normalizeEnvironmentDelta(mutant, additionalEnvironment) {
  if (
    additionalEnvironment === null ||
    typeof additionalEnvironment !== "object" ||
    Array.isArray(additionalEnvironment)
  ) {
    throw mutationError(
      "MUTATION_ENVIRONMENT_INVALID",
      "additional mutation environment must be an object",
    );
  }
  const set = Object.create(null);
  const seen = new Set();
  const add = (name, value, label) => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.includes("=") ||
      name.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw mutationError("MUTATION_ENVIRONMENT_INVALID", `${label} is not a valid environment entry`);
    }
    const folded = name.toUpperCase();
    if (seen.has(folded)) {
      throw mutationError(
        "MUTATION_ENVIRONMENT_DUPLICATE",
        `mutation environment repeats ${name} case-insensitively`,
      );
    }
    seen.add(folded);
    set[name] = value;
  };
  for (const [name, value] of Object.entries(additionalEnvironment)) {
    add(name, value, `additionalEnvironment.${name}`);
  }
  if (mutant !== null) {
    if (typeof mutant !== "object" || Array.isArray(mutant)) {
      throw mutationError("MUTANT_INVALID", "mutation execution mutant must be an object");
    }
    add("MUTANT_FILE", mutant.file, "mutant.file");
    add("MUTANT_FIND", mutant.find, "mutant.find");
    add("MUTANT_REPLACE", mutant.replace, "mutant.replace");
  }
  const remove = ["MUTANT_FILE", "MUTANT_FIND", "MUTANT_REPLACE"]
    .filter((name) => !seen.has(name));
  return { set, remove };
}

function spawnSupervisor(command, args, watchdogMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: WORKER_ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        error,
        stdout: "",
        stderr: "",
        watchdogFired: false,
        outputOverflow: false,
        terminationReason: null,
        killAttempts: 0,
        lastKillReturned: null,
        lastKillError: null,
      });
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputOverflow = false;
    let watchdogFired = false;
    let settled = false;
    let launchError = null;
    let terminationReason = null;
    let killAttempts = 0;
    let lastKillReturned = null;
    let lastKillError = null;
    let killRetry = null;
    let closeGrace = null;

    const attemptExactSupervisorKill = () => {
      killAttempts += 1;
      try {
        lastKillReturned = child.kill();
        lastKillError = null;
      } catch (error) {
        lastKillReturned = false;
        lastKillError = String(error?.code ?? error?.message ?? error).slice(
          0,
          SUPERVISOR_ERROR_MESSAGE_LIMIT,
        );
      }
    };
    const beginSupervisorTermination = (reason) => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      attemptExactSupervisorKill();
      killRetry = setInterval(attemptExactSupervisorKill, SUPERVISOR_KILL_RETRY_MS);
      closeGrace = setTimeout(() => {
        clearInterval(killRetry);
        const fatal = JSON.stringify({
          schema: "survey-qa-mutation-supervisor-fatal/1.0.0",
          completionIssue: "SUPERVISOR_CLOSE_GRACE_EXPIRED",
          reason: terminationReason,
          killAttempts,
          lastKillReturned,
          lastKillError,
          closeGraceMs: SUPERVISOR_CLOSE_GRACE_MS,
        });
        writeSync(2, `${fatal}\n`);
        process.abort();
      }, SUPERVISOR_CLOSE_GRACE_MS);
    };
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= SUPERVISOR_OUTPUT_LIMIT_BYTES) target.push(chunk);
      else if (!outputOverflow) {
        outputOverflow = true;
        beginSupervisorTermination("CONTROL_OUTPUT_LIMIT_EXCEEDED");
      }
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      launchError = error;
    });
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      beginSupervisorTermination("SUPERVISOR_WATCHDOG_TIMEOUT");
    }, watchdogMs);
    watchdog.unref();
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (killRetry !== null) clearInterval(killRetry);
      if (closeGrace !== null) clearTimeout(closeGrace);
      resolve({
        status,
        signal,
        error: launchError,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        watchdogFired,
        outputOverflow,
        terminationReason,
        killAttempts,
        lastKillReturned,
        lastKillError,
      });
    });
  });
}

function readAndHashClosedTranscript(filePath, expectedBytes, expectedHash, label) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      expectedBytes > MUTATION_TRANSCRIPT_LIMIT_BYTES) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_LIMIT_INVALID", `${label} size exceeds read bound`);
  }
  const hasher = createHash("sha256");
  const bytes = Buffer.allocUnsafe(expectedBytes);
  const descriptor = openSync(filePath, "r");
  try {
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        Math.min(64 * 1024, expectedBytes - offset),
        offset,
      );
      if (count <= 0) {
        throw mutationError("SUPERVISOR_TRANSCRIPT_SHORT_READ", "transcript ended during hashing");
      }
      hasher.update(bytes.subarray(offset, offset + count));
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, expectedBytes) !== 0) {
      throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", `${label} grew during read`);
    }
    const finalSize = fstatSync(descriptor).size;
    if (finalSize !== expectedBytes) {
      throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", `${label} size changed during read`);
    }
  } finally {
    closeSync(descriptor);
  }
  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/u.test(expectedHash) ||
      hasher.digest("hex") !== expectedHash) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_HASH_MISMATCH", `${label} hash differs from receipt`);
  }
  return bytes.toString("utf8");
}

function hashClosedTranscript(filePath, expectedBytes, expectedHash, label) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      expectedBytes > MUTATION_TRANSCRIPT_LIMIT_BYTES) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_LIMIT_INVALID", `${label} size exceeds hash bound`);
  }
  const descriptor = openSync(filePath, "r");
  const hasher = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, expectedBytes - offset),
        offset,
      );
      if (count <= 0) {
        throw mutationError("SUPERVISOR_TRANSCRIPT_SHORT_READ", `${label} ended during hashing`);
      }
      hasher.update(chunk.subarray(0, count));
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, expectedBytes) !== 0 ||
        fstatSync(descriptor).size !== expectedBytes) {
      throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", `${label} changed during hashing`);
    }
  } finally {
    closeSync(descriptor);
  }
  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/u.test(expectedHash) ||
      hasher.digest("hex") !== expectedHash) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_HASH_MISMATCH", `${label} hash differs from receipt`);
  }
}

function readClosedTranscript(filePath, expectedBytes, expectedHash, label) {
  if (!existsSync(filePath)) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_MISSING", `${label} transcript is absent`);
  }
  const size = statSync(filePath).size;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || size !== expectedBytes) {
    throw mutationError(
      "SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH",
      `${label} transcript size differs from its receipt`,
    );
  }
  return readAndHashClosedTranscript(filePath, expectedBytes, expectedHash, label);
}

function validateClosedTranscriptMetadata(receipt, stdoutPath, stderrPath) {
  const sizes = [receipt.stdoutBytes, receipt.stderrBytes];
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", "receipt transcript sizes are invalid");
  }
  const actual = [statSync(stdoutPath).size, statSync(stderrPath).size];
  if (actual[0] !== sizes[0] || actual[1] !== sizes[1]) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", "transcript size differs from receipt");
  }
  const combined = actual[0] + actual[1];
  if (!Number.isSafeInteger(combined)) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_SIZE_MISMATCH", "combined transcript size is invalid");
  }
  if (!receipt.transcriptLimitExceeded && combined > MUTATION_TRANSCRIPT_LIMIT_BYTES) {
    throw mutationError("SUPERVISOR_TRANSCRIPT_LIMIT_INVALID", "completed transcripts exceed limit");
  }
  if (receipt.transcriptLimitExceeded && combined !== MUTATION_TRANSCRIPT_LIMIT_BYTES) {
    throw mutationError(
      "SUPERVISOR_TRANSCRIPT_LIMIT_INVALID",
      "bounded limit result must contain exactly the captured-byte budget",
    );
  }
  return combined;
}

let nodeExecutableSha256 = null;

function hashStableFile(filePath, label) {
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw mutationError("SUPERVISOR_INPUT_HASH_FAILED", `${label} is not a regular file`);
    }
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, offset);
      if (count === 0) break;
      hasher.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw mutationError("SUPERVISOR_INPUT_HASH_FAILED", `${label} changed during hashing`);
    }
    return hasher.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function trustedNodeExecutableSha256() {
  nodeExecutableSha256 ??= hashStableFile(process.execPath, "Node executable");
  return nodeExecutableSha256;
}

function readBoundedDiagnosticTranscript(filePath) {
  if (!existsSync(filePath)) return "";
  const descriptor = openSync(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(DIAGNOSTIC_TRANSCRIPT_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return bytes.subarray(0, offset).toString("utf8");
      offset += count;
    }
    return `[diagnostic transcript omitted: exceeds ${DIAGNOSTIC_TRANSCRIPT_LIMIT_BYTES} bytes]`;
  } finally {
    closeSync(descriptor);
  }
}

function parseBoundedUniqueJson(text, label) {
  let index = 0;
  let nodes = 0;
  const bad = (message = "is not strict JSON") => {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", `${label} ${message}`);
  };
  const whitespace = () => {
    while (/^[\u0020\u000a\u000d\u0009]$/u.test(text[index] ?? "")) index += 1;
  };
  const string = () => {
    if (text[index++] !== '"') bad();
    let output = "";
    for (;;) {
      const character = text[index++];
      if (character === undefined) bad();
      if (character.charCodeAt(0) === 34) return output;
      if (character.charCodeAt(0) === 92) {
        const escape = text[index++];
        const escapes = { "/": "/", b: String.fromCharCode(8), f: String.fromCharCode(12), n: String.fromCharCode(10), r: String.fromCharCode(13), t: String.fromCharCode(9) };
        escapes[String.fromCharCode(34)] = String.fromCharCode(34);
        escapes[String.fromCharCode(92)] = String.fromCharCode(92);
        if (escape === "u") {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) bad();
          output += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else if (escape !== undefined && Object.hasOwn(escapes, escape)) {
          output += escapes[escape];
        } else bad();
      } else {
        if (character < " ") bad();
        output += character;
      }
      if (output.length > 32768) bad("contains an oversized string");
    }
  };
  const number = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) bad();
    if (/[.eE]/u.test(match[0])) bad("contains a non-integer JSON number");
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isSafeInteger(parsed)) bad("contains an out-of-range JSON integer");
    return parsed;
  };
  const value = (depth) => {
    if (++nodes > 512 || depth > 8) bad("exceeds structural bounds");
    whitespace();
    const character = text[index];
    if (character === "{") return object(depth + 1);
    if (character === "[") return array(depth + 1);
    if (character === '"') return string();
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    if (character === "-" || (character >= "0" && character <= "9")) return number();
    return bad();
  };
  const object = (depth) => {
    index += 1;
    whitespace();
    const output = Object.create(null);
    const keys = new Set();
    if (text[index] === "}") { index += 1; return output; }
    for (;;) {
      whitespace();
      const key = string();
      if (keys.has(key)) bad("contains duplicate JSON keys");
      keys.add(key);
      if (keys.size > 64) bad("contains too many object keys");
      whitespace();
      if (text[index++] !== ":") bad();
      output[key] = value(depth);
      whitespace();
      const next = text[index++];
      if (next === "}") return output;
      if (next !== ",") bad();
    }
  };
  const array = (depth) => {
    index += 1;
    whitespace();
    const output = [];
    if (text[index] === "]") { index += 1; return output; }
    for (;;) {
      output.push(value(depth));
      if (output.length > 64) bad("contains an oversized array");
      whitespace();
      const next = text[index++];
      if (next === "]") return output;
      if (next !== ",") bad();
    }
  };
  const parsed = value(0);
  whitespace();
  if (index !== text.length) bad("has trailing content");
  return parsed;
}

function assertSupervisorReceiptPrimitiveTypes(receipt) {
  const invalid = (property, type) => {
    const error = mutationError(
      "SUPERVISOR_RECEIPT_INVALID",
      `supervisor receipt ${property} must be ${type}`,
    );
    error.property = property;
    throw error;
  };
  for (const property of SUPERVISOR_RECEIPT_STRING_PROPERTIES) {
    if (typeof receipt[property] !== "string") invalid(property, "a JSON string");
  }
  for (const property of SUPERVISOR_RECEIPT_BOOLEAN_PROPERTIES) {
    if (typeof receipt[property] !== "boolean") invalid(property, "a JSON boolean");
  }
  for (const property of SUPERVISOR_RECEIPT_INTEGER_PROPERTIES) {
    if (!Number.isSafeInteger(receipt[property]) ||
        receipt[property] < -2_147_483_648 || receipt[property] > 2_147_483_647) {
      invalid(property, "an Int32 JSON integer");
    }
  }
  for (const property of SUPERVISOR_RECEIPT_NULLABLE_STRING_PROPERTIES) {
    if (receipt[property] !== null && typeof receipt[property] !== "string") {
      invalid(property, "null or a JSON string");
    }
  }
  for (const property of SUPERVISOR_RECEIPT_NULLABLE_INTEGER_PROPERTIES) {
    if (receipt[property] !== null &&
        (!Number.isSafeInteger(receipt[property]) ||
         receipt[property] < -2_147_483_648 || receipt[property] > 2_147_483_647)) {
      invalid(property, "null or an Int32 JSON integer");
    }
  }
  if (receipt.attestation !== null &&
      (typeof receipt.attestation !== "object" || Array.isArray(receipt.attestation))) {
    invalid("attestation", "null or a JSON object");
  }
}

export function decodeSupervisorReceiptBytes(input) {
  if (!(input instanceof Uint8Array)) {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", "receipt bytes must be a Uint8Array");
  }
  if (input.byteLength < 1 || input.byteLength > SUPERVISOR_RECEIPT_LIMIT_BYTES) {
    throw mutationError("SUPERVISOR_RECEIPT_TOO_LARGE", "supervisor receipt exceeds 64 KiB");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", "receipt is not strict UTF-8");
  }
  const receipt = parseBoundedUniqueJson(text, "supervisor receipt");
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", "supervisor receipt is not an object");
  }
  const actual = Object.keys(receipt).sort();
  const expected = [...SUPERVISOR_RECEIPT_PROPERTIES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", "receipt has unknown or missing properties");
  }
  assertSupervisorReceiptPrimitiveTypes(receipt);
  return receipt;
}

function readStrictSupervisorReceipt(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const initialSize = fstatSync(descriptor).size;
    if (!Number.isSafeInteger(initialSize) || initialSize < 1 ||
        initialSize > SUPERVISOR_RECEIPT_LIMIT_BYTES) {
      throw mutationError("SUPERVISOR_RECEIPT_TOO_LARGE", "supervisor receipt exceeds 64 KiB");
    }
    const bytes = Buffer.allocUnsafe(initialSize);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw mutationError("SUPERVISOR_RECEIPT_INVALID", "receipt ended early");
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, bytes.length) !== 0 ||
        fstatSync(descriptor).size !== initialSize) {
      throw mutationError("SUPERVISOR_RECEIPT_INVALID", "receipt changed during read");
    }
    return decodeSupervisorReceiptBytes(bytes);
  } finally {
    closeSync(descriptor);
  }
}

export function validateSupervisorReceiptCoherence(receipt, supervisorStatus, expected) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.schema !== "survey-qa-windows-job-supervisor-receipt/1.0.0"
  ) {
    throw mutationError("SUPERVISOR_RECEIPT_INVALID", "supervisor receipt schema is invalid");
  }
  const requiredTruth = [
    "requestPinnedThroughRun",
    "jobAssigned",
    "processResumed",
    "assignmentBeforeResume",
    "membershipVerified",
    "handlesClosed",
    "abiValidated",
    "inputPinsHeldThroughRun",
  ];
  const mismatch = (property) => {
    const error = mutationError(
      "SUPERVISOR_RECEIPT_PROPERTY_MISMATCH",
      `supervisor receipt invariant failed: ${property}`,
    );
    error.property = property;
    throw error;
  };
  for (const property of requiredTruth) {
    if (receipt[property] !== true) mismatch(property);
  }
  const exactBindings = [
    ["requestSha256", expected.requestSha256],
    ["executablePath", process.execPath],
    ["subjectPath", expected.request.subjectPath],
    ["workingDirectory", WORKER_ROOT],
    ["argumentCount", expected.request.arguments.length],
    ["executableArgumentCount", expected.request.executableArguments.length],
    ["timeoutMs", expected.request.timeoutMs],
    ["innerTimeoutMs", null],
    ["drainGraceMs", SUPERVISOR_DRAIN_GRACE_MS],
    ["stdoutLog", path.basename(expected.request.stdoutPath)],
    ["stderrLog", path.basename(expected.request.stderrPath)],
  ];
  for (const [property, value] of exactBindings) {
    if (receipt[property] !== value) mismatch(property);
  }
  if (receipt.attestation !== null) mismatch("attestation");
  if (receipt.executableSha256 !== expected.executableSha256) mismatch("executableSha256");
  if (receipt.subjectSha256 !== expected.subjectSha256) mismatch("subjectSha256");
  if (receipt.transcriptLimitBytes !== MUTATION_TRANSCRIPT_LIMIT_BYTES) {
    mismatch("transcriptLimitBytes");
  }
  if (receipt.emptyStdinPipe !== (expected.request.stdinPath === null)) mismatch("emptyStdinPipe");
  if (receipt.finalActiveProcesses !== 0) mismatch("finalActiveProcesses");
  if (receipt.initialActiveProcesses !== 1) mismatch("initialActiveProcesses");
  if (!Number.isInteger(receipt.processId) || receipt.processId <= 0) mismatch("processId");
  if (receipt.pointerSize !== 8) mismatch("pointerSize");
  if (receipt.durationMs < 0 ||
      receipt.durationMs > expected.request.timeoutMs + SUPERVISOR_DRAIN_GRACE_MS +
        SUPERVISOR_STARTUP_GRACE_MS) {
    mismatch("durationMs");
  }
  const exactUtcTimestamp = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u.exec(value);
    if (match === null) return false;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
      hour <= 23 && minute <= 59 && second <= 59;
  };
  if (!exactUtcTimestamp(receipt.startedUtc)) {
    mismatch("startedUtc");
  }
  if (!exactUtcTimestamp(receipt.endedUtc)) {
    mismatch("endedUtc");
  }
  if (receipt.endedUtc < receipt.startedUtc) mismatch("endedUtc");
  if (receipt.stdoutBytes === null || receipt.stdoutBytes < 0) mismatch("stdoutBytes");
  if (receipt.stderrBytes === null || receipt.stderrBytes < 0) mismatch("stderrBytes");
  if (receipt.containmentScope !== WINDOWS_JOB_CONTAINMENT_SCOPE) mismatch("containmentScope");
  if (receipt.executableSha256 !== receipt.executableSha256After) {
    mismatch("executableSha256After");
  }
  if (receipt.subjectSha256 !== receipt.subjectSha256After) mismatch("subjectSha256After");
  if (receipt.stdoutSha256 !== receipt.stdoutSha256After) mismatch("stdoutSha256After");
  if (receipt.stderrSha256 !== receipt.stderrSha256After) mismatch("stderrSha256After");
  if (receipt.postRunErrorType !== null) mismatch("postRunErrorType");
  if (receipt.transcriptLimitExceeded === true) {
    if (
      receipt.completionIssue !== "TRANSCRIPT_LIMIT_EXCEEDED" ||
      receipt.timedOut !== false ||
      receipt.terminationIssued !== true ||
      receipt.launchErrorType !== null ||
      receipt.exitCode !== 125 ||
      supervisorStatus !== 125
    ) {
      throw mutationError(
        "SUPERVISOR_TRANSCRIPT_LIMIT_INCOHERENT",
        "transcript-limit receipt lacks termination evidence or exit 125",
      );
    }
    if (
      receipt.outputHashesCapturedBeforeClose !== true ||
      typeof receipt.stdoutSha256 !== "string" ||
      receipt.stdoutSha256 !== receipt.stdoutSha256After ||
      typeof receipt.stderrSha256 !== "string" ||
      receipt.stderrSha256 !== receipt.stderrSha256After
    ) {
      throw mutationError(
        "SUPERVISOR_TRANSCRIPT_LIMIT_INCOHERENT",
        "transcript-limit receipt lacks capped-log ownership hashes",
      );
    }
    return "transcript-limit";
  }
  if (receipt.outputHashesCapturedBeforeClose !== true) {
    mismatch("outputHashesCapturedBeforeClose");
  }
  if (receipt.transcriptLimitExceeded !== false) mismatch("transcriptLimitExceeded");
  if (receipt.completionIssue !== null) mismatch("completionIssue");
  if (receipt.timedOut === true) {
    if (supervisorStatus !== 124 || receipt.exitCode !== 124 ||
        receipt.terminationIssued !== true || receipt.completionIssue !== null ||
        receipt.launchErrorType !== null) {
      throw mutationError(
        "SUPERVISOR_TIMEOUT_INCOHERENT",
        "timed-out supervisor receipt lacks termination evidence or exit 124",
      );
    }
    return "timeout";
  }
  if (receipt.timedOut !== false) mismatch("timedOut");
  if (receipt.terminationIssued !== false) mismatch("terminationIssued");
  if (receipt.launchErrorType !== null) mismatch("launchErrorType");
  if (!Number.isInteger(receipt.exitCode) || supervisorStatus !== receipt.exitCode) {
    mismatch("exitCode");
  }
  return "completed";
}

/**
 * Run the real selected suite once inside an atomically assigned Windows Job. The method is
 * asynchronous because returning before the job reaches ActiveProcesses=0 would let a timed-out
 * grandchild contaminate the next mutant.
 */
export async function runSuite({
  exactTestNames,
  timeoutMs,
  mutant = null,
  additionalEnvironment = {},
  _containedNodeSubject = null,
} = {}) {
  const names = _containedNodeSubject === null
    ? validateExactNames(exactTestNames, "mutation exact test names")
    : null;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MUTATION_CHILD_TIMEOUT_MS) {
    throw mutationError(
      "MUTATION_CHILD_TIMEOUT_INVALID",
      `mutation child timeout must be 1..${MAX_MUTATION_CHILD_TIMEOUT_MS}`,
    );
  }
  const environment = normalizeEnvironmentDelta(mutant, additionalEnvironment);
  const runRoot = mkdtempSync(path.join(os.tmpdir(), "survey-qa-mutation-child-"));
  const stdinPath = _containedNodeSubject === null
    ? path.join(runRoot, "exact-test-names.json")
    : null;
  const stdoutPath = path.join(runRoot, "stdout.log");
  const stderrPath = path.join(runRoot, "stderr.log");
  const receiptPath = path.join(runRoot, "receipt.json");
  const requestPath = path.join(runRoot, "request.json");
  const testPath = _containedNodeSubject?.subjectPath ?? path.join(HERE, "test.mjs");
  let supervisor = null;
  let receipt = null;
  let stdout = "";
  let stderr = "";
  let executionError = null;

  try {
    if (stdinPath !== null) {
      writeFileSync(stdinPath, `${JSON.stringify(names)}\n`, { encoding: "utf8", flag: "wx" });
    }
    const executableSha256 = trustedNodeExecutableSha256();
    const subjectSha256 = hashStableFile(testPath, "contained subject");
    const request = {
      schema: "survey-qa-windows-job-supervisor-request/1.0.0",
      executablePath: process.execPath,
      subjectPath: testPath,
      executableArguments: _containedNodeSubject?.executableArguments ?? [],
      arguments: _containedNodeSubject?.subjectArguments ?? [EXACT_TEST_NAMES_STDIN_FLAG],
      workingDirectory: WORKER_ROOT,
      subjectBoundaryPath: WORKER_ROOT,
      ioBoundaryPath: runRoot,
      stdinPath,
      stdoutPath,
      stderrPath,
      receiptPath,
      timeoutMs,
      innerTimeoutMs: null,
      drainGraceMs: SUPERVISOR_DRAIN_GRACE_MS,
      transcriptLimitBytes: MUTATION_TRANSCRIPT_LIMIT_BYTES,
      environment,
      attestation: null,
    };
    const requestText = JSON.stringify(request);
    const requestSha256 = createHash("sha256").update(requestText, "utf8").digest("hex");
    writeFileSync(requestPath, requestText, { encoding: "utf8", flag: "wx" });
    const powershell = resolvePowerShellPath();
    supervisor = await spawnSupervisor(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SUPERVISOR_PATH,
        "-RequestPath",
        requestPath,
        "-TrustedExecutablePath",
        process.execPath,
        "-TrustedSubjectBoundaryPath",
        WORKER_ROOT,
        "-TrustedIoBoundaryPath",
        runRoot,
      ],
      timeoutMs + SUPERVISOR_DRAIN_GRACE_MS + SUPERVISOR_STARTUP_GRACE_MS,
    );

    if (supervisor.watchdogFired) {
      throw mutationError(
        "SUPERVISOR_WATCHDOG_TIMEOUT",
        "Windows Job supervisor exceeded child timeout, drain grace, and startup grace",
      );
    }
    if (supervisor.outputOverflow) {
      throw mutationError(
        "SUPERVISOR_OUTPUT_OVERFLOW",
        "Windows Job supervisor control output exceeded its closed limit",
      );
    }
    if (supervisor.error !== null) throw supervisor.error;
    if (!existsSync(receiptPath)) {
      throw mutationError(
        "SUPERVISOR_RECEIPT_MISSING",
        `Windows Job supervisor emitted no receipt (exit ${String(supervisor.status)}): ` +
          boundedSupervisorControlDiagnostic(supervisor),
      );
    }
    receipt = readStrictSupervisorReceipt(receiptPath);
    const receiptState = validateSupervisorReceiptCoherence(
      receipt,
      supervisor.status,
      { request, requestSha256, executableSha256, subjectSha256 },
    );
    validateClosedTranscriptMetadata(receipt, stdoutPath, stderrPath);
    if (receiptState === "transcript-limit") {
      hashClosedTranscript(stdoutPath, receipt.stdoutBytes, receipt.stdoutSha256, "stdout");
      hashClosedTranscript(stderrPath, receipt.stderrBytes, receipt.stderrSha256, "stderr");
      throw mutationError(
        "TRANSCRIPT_LIMIT_EXCEEDED",
        "contained test process exceeded the combined transcript limit",
      );
    }
    stdout = readClosedTranscript(
      stdoutPath,
      receipt.stdoutBytes,
      receipt.stdoutSha256,
      "stdout",
    );
    stderr = readClosedTranscript(
      stderrPath,
      receipt.stderrBytes,
      receipt.stderrSha256,
      "stderr",
    );
    if (receipt.timedOut) {
      executionError = mutationError("ETIMEDOUT", "contained test process exceeded its timeout");
    }
  } catch (error) {
    executionError =
      error instanceof Error
        ? error
        : mutationError("SUPERVISOR_UNKNOWN_ERROR", String(error));
    if (stdout === "") stdout = readBoundedDiagnosticTranscript(stdoutPath);
    if (stderr === "") stderr = readBoundedDiagnosticTranscript(stderrPath);
  }

  const receiptEvidence = receipt === null ? null : Object.freeze({
    transcriptLimitBytes: receipt.transcriptLimitBytes,
    transcriptLimitExceeded: receipt.transcriptLimitExceeded,
    completionIssue: receipt.completionIssue,
    timedOut: receipt.timedOut,
    terminationIssued: receipt.terminationIssued,
    finalActiveProcesses: receipt.finalActiveProcesses,
    handlesClosed: receipt.handlesClosed,
    outputHashesCapturedBeforeClose: receipt.outputHashesCapturedBeforeClose,
    stdoutBytes: receipt.stdoutBytes,
    stderrBytes: receipt.stderrBytes,
    stdoutSha256: receipt.stdoutSha256,
    stdoutSha256After: receipt.stdoutSha256After,
    stderrSha256: receipt.stderrSha256,
    stderrSha256After: receipt.stderrSha256After,
  });

  let cleanupError = null;
  try {
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    cleanupError = mutationError(
      "SUPERVISOR_EVIDENCE_CLEANUP_FAILED",
      `closed child evidence could not be removed: ${error?.code ?? error?.message ?? "unknown"}`,
    );
  }
  if (cleanupError !== null) executionError ??= cleanupError;

  const processLike = {
    stdout,
    stderr,
    status:
      executionError === null && receipt !== null && Number.isInteger(receipt.exitCode)
        ? receipt.exitCode
        : null,
    signal: supervisor?.signal ?? null,
    error: executionError,
  };
  return {
    ...classifySuiteProcess(processLike),
    stdout,
    stderr,
    status: processLike.status,
    signal: processLike.signal,
    error: executionError,
    timeoutMs,
    supervisorStatus: supervisor?.status ?? null,
    containmentScope: receipt?.containmentScope ?? null,
    finalActiveProcesses: receipt?.finalActiveProcesses ?? null,
    receiptEvidence,
  };
}

export async function runContainedNodeSubject({ subjectPath, arguments: nodeArguments, timeoutMs, mutant = null } = {}) {
  if (typeof subjectPath !== "string" || !path.isAbsolute(subjectPath)) {
    throw mutationError("CONTAINED_SUBJECT_INVALID", "contained subject must be an absolute path");
  }
  const resolvedSubject = path.resolve(subjectPath);
  const allowedSubject = CUA_CONTAINED_SUBJECTS.find((candidate) =>
    candidate.toLowerCase() === resolvedSubject.toLowerCase());
  const isTestOnlyOutputFlood =
    resolvedSubject.toLowerCase() === TEST_ONLY_OUTPUT_FLOOD_SUBJECT.toLowerCase() &&
    resolvedSubject === TEST_ONLY_OUTPUT_FLOOD_SUBJECT;
  if ((allowedSubject === undefined || resolvedSubject !== allowedSubject) &&
      !isTestOnlyOutputFlood) {
    throw mutationError("CONTAINED_SUBJECT_UNTRUSTED", "contained subject is not allowlisted");
  }
  const expectedArguments = isTestOnlyOutputFlood
    ? [resolvedSubject]
    : ["--test", "--test-reporter=tap", resolvedSubject];
  if (!Array.isArray(nodeArguments) ||
      JSON.stringify(nodeArguments) !== JSON.stringify(expectedArguments)) {
    throw mutationError("CONTAINED_ARGUMENTS_UNTRUSTED", "contained Node TAP arguments differ");
  }
  const result = await runSuite({
    timeoutMs,
    mutant,
    additionalEnvironment: {},
    _containedNodeSubject: {
      subjectPath: resolvedSubject,
      executableArguments: isTestOnlyOutputFlood ? [] : expectedArguments.slice(0, 2),
      subjectArguments: [],
    },
  });
  const containedCompleted =
    result.error === null &&
    Number.isInteger(result.status) &&
    (result.status === 0 || result.status === 1) &&
    result.signal === null &&
    result.supervisorStatus === result.status &&
    result.finalActiveProcesses === 0;
  return Object.freeze({
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
    error: result.error,
    timedOut: result.timedOut,
    completed: containedCompleted,
    completionIssue: containedCompleted
      ? null
      : result.errorCode ?? result.completionIssue ?? "CONTAINED_PROCESS_INCOHERENT",
    errorCode: result.errorCode,
    supervisorStatus: result.supervisorStatus,
    containmentScope: result.containmentScope,
    finalActiveProcesses: result.finalActiveProcesses,
    receiptEvidence: result.receiptEvidence,
  });
}

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

export function evaluateRedBaselineSelfCheck({ baselineFailing, red, again }) {
  const canonical = (values) =>
    Array.isArray(values) && values.every((value) => typeof value === "string") &&
    new Set(values).size === values.length;
  if (!red?.completed) return { passed: false, issue: "RED_RUN_INCOMPLETE" };
  if (red.anchorRejected) return { passed: false, issue: "RED_ANCHOR_REJECTED" };
  if (!canonical(baselineFailing) || !canonical(red.failing) || red.failing.length === 0) {
    return { passed: false, issue: "RED_FAILURE_SET_INVALID" };
  }
  if (setDiff(red.failing, baselineFailing).length === 0) {
    return { passed: false, issue: "RED_HAS_NO_NEW_FAILURE" };
  }
  if (!again?.completed) return { passed: false, issue: "REAPPLY_RUN_INCOMPLETE" };
  if (again.anchorRejected) return { passed: false, issue: "REAPPLY_ANCHOR_REJECTED" };
  if (!canonical(again.failing)) return { passed: false, issue: "REAPPLY_FAILURE_SET_INVALID" };
  const left = [...red.failing].sort();
  const right = [...again.failing].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    return { passed: false, issue: "REAPPLY_FAILURE_SET_CHANGED" };
  }
  return { passed: true, issue: null };
}

/**
 * Judge one mutant against the recorded baseline. Pure, so the criterion is one function
 * that both the self-check and the real mutants go through — a self-check exercising a
 * different code path from the thing it certifies would certify nothing.
 */
export function judge(mutant, result, baselineFailing) {
  if (result.anchorRejected && result.completed) {
    return {
      status: "BROKEN-ANCHOR",
      killed: false,
      newFailures: [],
      note:
        "the anchor no longer matches exactly once — the source moved under this harness " +
        "(another agent editing, or a real drift). Re-read the file and re-anchor; this is NOT a kill.",
    };
  }
  if (!result.completed) {
    const note = result.timedOut
      ? `the suite exceeded its ${result.timeoutMs} ms child timeout and was never scored`
      : result.errorCode
        ? `the suite child failed to launch or complete (${result.errorCode})`
        : result.signal
          ? `the suite child terminated by ${result.signal} and was never scored`
          : result.completionIssue === "SUMMARY_COUNT"
            ? `the suite produced ${result.summaryCount} summary lines instead of exactly one`
            : result.completionIssue === "SUMMARY_INVALID"
              ? "the suite summary had an empty or arithmetically invalid denominator"
              : result.completionIssue === "FAIL_LINE_COUNT_MISMATCH"
                ? `the suite summary reported ${result.failed} failures but emitted ${result.failing.length} named FAIL lines`
                : result.completionIssue === "EXIT_STATUS_MISMATCH"
                  ? `the suite exit status ${String(result.status)} contradicted its reported failure count`
                  : "the suite did not produce a coherent scoreable result";
    return {
      status: "NO-RUN",
      killed: false,
      newFailures: [],
      note,
    };
  }

  const newFailures = setDiff(result.failing, baselineFailing);
  const expected = mutant.kills ?? [];
  const missed = setDiff(expected, newFailures);

  if (expected.length > 0) {
    if (missed.length === 0) return { status: "killed", killed: true, newFailures, note: null };
    return {
      status: "SURVIVED",
      killed: false,
      newFailures,
      note:
        `the named guard test did NOT newly fail: ${missed.join(" | ")}` +
        (newFailures.length > 0 ? ` (other tests did: ${newFailures.join(" | ")})` : ""),
    };
  }

  if (newFailures.length > 0) return { status: "killed", killed: true, newFailures, note: null };
  return { status: "SURVIVED", killed: false, newFailures, note: `untested property: ${mutant.breaks}` };
}

/**
 * @param title  what this mutant set is auditing, for the header
 * @param filter legacy human-readable filter metadata retained for existing harness declarations;
 *               execution always uses the exact union of every mutant's declared `kills`.
 * @param mutants [{ name, breaks, file, find, replace, kills: [exact test names] }]
 */
export async function runMutantSuite({ title, filter = "", mutants }) {
  const w = process.stdout;
  let exactTestNames;
  let childTimeoutMs;
  try {
    exactTestNames = deriveExactKillNames(mutants);
    childTimeoutMs = resolveMutationChildTimeout();
  } catch (error) {
    w.write(`FATAL: mutation guard selection is invalid: ${error?.message ?? "unknown error"}\n`);
    process.exit(2);
  }
  w.write(`${title}\n${"=".repeat(title.length)}\n\n`);
  w.write(`kill criterion: BASELINE-AWARE — a mutant is killed only by a test that was PASSING\n`);
  w.write(`before the mutation, and (where declared) only by the NAMED test that guards it.\n\n`);
  w.write(`selected denominator: ${exactTestNames.length} exact declared kill name(s)\n`);
  w.write(`per-child timeout: ${childTimeoutMs} ms\n`);
  if (filter) w.write(`legacy substring metadata (not used for selection): ${filter}\n`);
  w.write("\n");

  // ---- 1. BASELINE -------------------------------------------------------
  const baseline = await runSuite({ exactTestNames, timeoutMs: childTimeoutMs });
  if (!baseline.completed) {
    w.write(`FATAL: the unmutated suite did not complete. Nothing can be scored against it.\n`);
    w.write(baseline.out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  w.write(`baseline (unmutated): ${baseline.passed}/${baseline.total} passed, ${baseline.failing.length} failed\n`);
  for (const f of baseline.failing) w.write(`  already red: ${f}\n`);
  w.write("\n");

  // A mutant whose guard test is ALREADY failing can never be proven — its target cannot
  // become a NEW failure. Say so rather than scoring it.
  const unprovable = [];
  for (const m of mutants) {
    const clash = (m.kills ?? []).filter((k) => baseline.failing.includes(k));
    if (clash.length > 0) unprovable.push({ mutant: m, clash });
  }

  // ---- 2. THE HARNESS'S OWN SELF-CHECK -----------------------------------
  // A rewrite that changes nothing must score NOT killed. This is the exact case the old
  // "any FAIL line" criterion got wrong, so it runs before anything else and is fatal.
  const noop = mutants[0];
  const selfCheck = await runSuite({
    exactTestNames,
    timeoutMs: childTimeoutMs,
    mutant: { file: noop.file, find: noop.find, replace: noop.find },
  });
  const selfVerdict = judge({ ...noop, kills: undefined, breaks: "nothing — this is a no-op" }, selfCheck, baseline.failing);
  if (selfVerdict.killed) {
    w.write(
      `FATAL SELF-CHECK: a NO-OP mutation (find === replace) scored as KILLED.\n` +
        `The kill criterion is broken, so every result below would be meaningless.\n` +
        `new failures attributed to a mutation that changed nothing: ${selfVerdict.newFailures.join(" | ")}\n`,
    );
    process.exit(2);
  }
  if (selfCheck.anchorRejected || !selfCheck.completed) {
    w.write(`FATAL SELF-CHECK: the no-op run did not complete cleanly (${selfVerdict.status}). ${selfVerdict.note}\n`);
    process.exit(2);
  }
  w.write(`self-check 1/2: a no-op mutation scored NOT killed over the real baseline.\n`);

  // ---- 2b. THE SELF-CHECK THAT ACTUALLY DISCRIMINATES ---------------------
  // Self-check 1 passes under the OLD broken criterion too, whenever the suite is green: with
  // no FAIL lines at all, "any FAIL line" and "a NEW FAIL line" agree. It therefore proves
  // nothing on its own, and a harness that stopped there would be repeating the original sin
  // one level up.
  //
  // This one reproduces the 5 Aug condition exactly. It makes the baseline RED by applying a
  // real mutant, then applies THE SAME MUTANT AGAIN. Relative to that red baseline nothing has
  // changed, so the correct answer is NOT killed — while the old "any FAIL line" rule would
  // say killed, because FAIL lines are plainly present. Only a baseline-aware criterion can
  // tell those apart, so this is the check that fails if the rule ever regresses.
  const probe = mutants.find((m) => m.find !== m.replace) ?? mutants[0];
  const red = await runSuite({ exactTestNames, timeoutMs: childTimeoutMs, mutant: probe });
  if (!red.completed || red.anchorRejected || red.failing.length === 0 ||
      setDiff(red.failing, baseline.failing).length === 0) {
    w.write(
      `FATAL SELF-CHECK: the probe mutant ("${probe.name}") did not produce a completed, ` +
        `anchor-accepted red baseline with a failure new to the original baseline.\n`,
    );
    process.exit(2);
  } else {
    const again = await runSuite({ exactTestNames, timeoutMs: childTimeoutMs, mutant: probe });
    const againVerdict = judge(
      { ...probe, kills: undefined, breaks: "nothing, relative to a RED baseline" },
      again,
      red.failing,
    );
    const redBaselineCheck = evaluateRedBaselineSelfCheck({
      baselineFailing: baseline.failing,
      red,
      again,
    });
    if (!redBaselineCheck.passed) {
      w.write(`FATAL SELF-CHECK: red-baseline discrimination failed (${redBaselineCheck.issue}).\n`);
      process.exit(2);
    }
    if (!again.completed || again.anchorRejected) {
      w.write(
        `FATAL SELF-CHECK: re-applying the red-baseline probe did not complete cleanly ` +
          `(${againVerdict.status}). ${againVerdict.note}\n`,
      );
      process.exit(2);
    }
    if (againVerdict.killed) {
      w.write(
        `FATAL SELF-CHECK: re-applying an ALREADY-APPLIED mutation scored as KILLED against a red\n` +
          `baseline of ${red.failing.length} failing test(s). That is the 5 Aug defect: failures that were\n` +
          `already there are being counted as this mutant's kills. Every result below would be fiction.\n` +
          `wrongly attributed: ${againVerdict.newFailures.join(" | ")}\n`,
      );
      process.exit(2);
    }
    w.write(
      `self-check 2/2: over a deliberately RED baseline (${red.failing.length} failing), re-applying the same\n` +
        `            mutation scored NOT killed — pre-existing failures are not counted as kills.\n\n`,
    );
  }

  // ---- 3. THE REAL MUTANTS -----------------------------------------------
  const results = [];
  for (const m of mutants) {
    const blocked = unprovable.find((u) => u.mutant === m);
    if (blocked) {
      w.write(`  UNPROVABLE  ${m.name}\n              guard test already red at baseline: ${blocked.clash.join(" | ")}\n`);
      results.push({ mutant: m, verdict: { status: "UNPROVABLE", killed: false, newFailures: [], note: "baseline red" } });
      continue;
    }
    const result = await runSuite({ exactTestNames, timeoutMs: childTimeoutMs, mutant: m });
    const verdict = judge(m, result, baseline.failing);
    results.push({ mutant: m, verdict });

    if (verdict.killed) {
      w.write(`  killed      ${m.name}\n              by: ${verdict.newFailures.join("\n                  ")}\n`);
    } else {
      w.write(`  ${verdict.status.padEnd(10)}  ${m.name}\n              ${verdict.note}\n`);
    }
  }

  const bad = results.filter((r) => !r.verdict.killed);
  w.write(`\n${results.length - bad.length}/${results.length} mutants killed`);
  w.write(bad.length > 0 ? `, ${bad.length} NOT killed\n` : `\n`);
  for (const b of bad) w.write(`  NOT KILLED: ${b.mutant.name} — ${b.verdict.status}\n`);

  if (bad.length === 0) {
    w.write(
      `MUTATION_RESULT ${JSON.stringify({
        schema: "survey-qa-mutation-result/1.0.0",
        selector: "exact-union-of-declared-kills",
        denominator: exactTestNames.length,
        mutantsTotal: results.length,
        mutantsKilled: results.length,
        selfChecksPassed: 2,
      })}\n`,
    );
  }
  process.exit(bad.length === 0 ? 0 : 1);
}
