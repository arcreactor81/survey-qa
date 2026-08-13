import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertEq,
  suite,
  test,
} from "../testkit.mjs";
import {
  DEFAULT_MUTATION_CHILD_TIMEOUT_MS,
  EXACT_TEST_NAMES_STDIN_FLAG,
  MAX_MUTATION_CHILD_TIMEOUT_MS,
  WINDOWS_JOB_CONTAINMENT_SCOPE,
  classifySuiteProcess,
  decodeSupervisorReceiptBytes,
  deriveExactKillNames,
  judge,
  parseTestSelection,
  resolveMutationChildTimeout,
  evaluateRedBaselineSelfCheck,
  runContainedNodeSubject,
  runSuite,
  selectRegistryCases,
  validateSupervisorReceiptCoherence,
} from "../mutate-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = fileURLToPath(import.meta.url);
const TOOLS = path.resolve(HERE, "..");
const WORKER_ROOT = path.resolve(TOOLS, "..");
const DEPLOY_PATH = path.join(WORKER_ROOT, "DEPLOY.md");
const SUPERVISOR_PATH = path.join(TOOLS, "windows-job-supervisor.ps1");
const DELAYED_MARKER_FIXTURE = path.join(
  HERE,
  "fixtures",
  "windows-job-delayed-marker.mjs",
);
const NESTED_RUNNER_FIXTURE = path.join(
  HERE,
  "fixtures",
  "windows-job-nested-runner.mjs",
);
const STDIN_EOF_FIXTURE = path.join(
  HERE,
  "fixtures",
  "windows-job-stdin-eof.mjs",
);
const OUTPUT_FLOOD_FIXTURE = path.join(
  HERE,
  "fixtures",
  "windows-job-output-flood.mjs",
);

function expectCode(fn, expectedCode) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught !== null, `expected ${expectedCode} to throw`);
  assertEq(caught.code, expectedCode, "wrong refusal code");
}

function expectThrow(fn, pattern) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught !== null, "expected operation to throw");
  assert(pattern.test(String(caught?.message ?? caught)), "unexpected refusal message");
}

function validRunnerReceiptFixture() {
  const emptySha256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const requestSha256 = "a".repeat(64);
  const executableSha256 = "b".repeat(64);
  const subjectSha256 = "c".repeat(64);
  const request = {
    subjectPath: STDIN_EOF_FIXTURE,
    arguments: [],
    executableArguments: [],
    stdinPath: null,
    stdoutPath: path.join(WORKER_ROOT, "stdout.log"),
    stderrPath: path.join(WORKER_ROOT, "stderr.log"),
    timeoutMs: 5000,
  };
  return {
    expected: { request, requestSha256, executableSha256, subjectSha256 },
    receipt: {
      schema: "survey-qa-windows-job-supervisor-receipt/1.0.0",
      requestSha256,
      requestPinnedThroughRun: true,
      executablePath: process.execPath,
      executableSha256,
      executableSha256After: executableSha256,
      subjectPath: request.subjectPath,
      subjectSha256,
      subjectSha256After: subjectSha256,
      workingDirectory: WORKER_ROOT,
      argumentCount: 0,
      executableArgumentCount: 0,
      timeoutMs: request.timeoutMs,
      innerTimeoutMs: null,
      drainGraceMs: 30000,
      transcriptLimitBytes: 67108864,
      transcriptLimitExceeded: false,
      completionIssue: null,
      startedUtc: "2026-08-13T00:00:00.0000000Z",
      endedUtc: "2026-08-13T00:00:00.0010000Z",
      durationMs: 1,
      timedOut: false,
      exitCode: 0,
      launchErrorType: null,
      postRunErrorType: null,
      processId: 1,
      initialActiveProcesses: 1,
      finalActiveProcesses: 0,
      jobAssigned: true,
      processResumed: true,
      assignmentBeforeResume: true,
      membershipVerified: true,
      containmentScope: WINDOWS_JOB_CONTAINMENT_SCOPE,
      terminationIssued: false,
      handlesClosed: true,
      abiValidated: true,
      pointerSize: 8,
      inputPinsHeldThroughRun: true,
      emptyStdinPipe: true,
      outputHashesCapturedBeforeClose: true,
      stdoutLog: path.basename(request.stdoutPath),
      stdoutBytes: 0,
      stdoutSha256: emptySha256,
      stdoutSha256After: emptySha256,
      stderrLog: path.basename(request.stderrPath),
      stderrBytes: 0,
      stderrSha256: emptySha256,
      stderrSha256After: emptySha256,
      attestation: null,
    },
  };
}

function parsePowerShellArray(source, variable) {
  const marker = "$" + variable + " = @(";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0 || source.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error(`missing or duplicate literal ${variable} array`);
  }
  const contentStart = source.indexOf("\n", markerIndex + marker.length);
  const contentEnd = contentStart < 0 ? -1 : source.indexOf("\n)", contentStart + 1);
  if (contentStart < 0 || contentEnd < 0) {
    throw new Error(`unterminated literal ${variable} array`);
  }
  const block = source.slice(contentStart + 1, contentEnd);
  const entries = [];
  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const entry = /^"([A-Za-z0-9._-]+\.mjs)",?$/u.exec(line);
    if (entry === null) throw new Error(`invalid ${variable} entry: ${line}`);
    entries.push(entry[1]);
  }
  if (entries.length === 0) throw new Error(`${variable} is empty`);
  if (new Set(entries).size !== entries.length) throw new Error(`${variable} contains duplicates`);
  return entries;
}

function deployJsonValidationFunctions(source) {
  const start = source.indexOf("function Read-CanonicalClosedJson {");
  const end = source.indexOf("\n$MutationWatchdogProperties = @(", start);
  if (start < 0 || end <= start) {
    throw new Error("DEPLOY canonical JSON validation function block is missing");
  }
  return source.slice(start, end);
}

function assertSameSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  }
}

const RUNBOOK_EXECUTION_TOKENS = Object.freeze([
  "$MutationTimeoutMs = 7200000",
  "$MutationChildTimeoutMs = 120000",
  "$MutationDrainGraceMs = 30000",
  "$MutationSupervisorStartupGraceMs = 120000",
  "$MutationTranscriptLimitBytes = 67108864",
  "$MutationSupervisorWatchdogMs",
  "windows-job-supervisor.ps1",
  "$SupervisorStartInfo.FileName = $PowerShellResolved",
  "$SupervisorStartInfo.CreateNoWindow = $true",
  "$SupervisorStartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden",
  "$SupervisorProcess.WaitForExit([int] $MutationSupervisorWatchdogMs)",
  "$SupervisorProcess.Kill()",
  "$SupervisorProcess.WaitForExit($MutationDrainGraceMs)",
  "$SupervisorKillAttempted -and $SupervisorExitedAfterKill -ne $true",
  "survey-qa-mutation-supervisor-watchdog/1.0.0",
  "watchdogFired = $SupervisorWatchdogFired",
  "$PersistedWatchdog.processStartTimeUtc -cne $SupervisorStartTimeUtc",
  "$PersistedWatchdog.exitedWithinBound -ne $true",
  "$PersistedWatchdog.watchdogFired -ne $false",
  "$PersistedWatchdog.killAttempted -ne $false",
  "$PersistedWatchdog.controlError -ne $null",
  "' -TrustedExecutablePath '",
  "ConvertTo-PowerShellSingleQuotedLiteral $NodeResolved",
  "' -TrustedSubjectBoundaryPath '",
  "ConvertTo-PowerShellSingleQuotedLiteral $V2",
  "' -TrustedIoBoundaryPath '",
  "' -TrustedSelector '",
  "cua-model-identity-exact-named-guard",
  "ConvertTo-PowerShellSingleQuotedLiteral $MutationEvidence",
  "survey-qa-windows-job-supervisor-receipt/1.0.0",
  "harnessSha256",
  "innerTimeoutMs",
  "durationMs",
  "timedOut",
  "exitCode",
  "stdoutSha256",
  "stderrSha256",
  "$Receipt.timedOut -ne $false",
  "$Receipt.exitCode -ne $SupervisorExit",
  "$Receipt.terminationIssued -ne $false",
  "$Receipt.processId -le 0",
  "$Receipt.durationMs -lt 0",
  "assignmentBeforeResume",
  "membershipVerified",
  "outputHashesCapturedBeforeClose",
  "$Receipt.transcriptLimitExceeded -ne $false",
  "Read-CanonicalClosedJson",
  "MUTATION_RESULT ",
  "$ResultMutantsKilled -ne $ResultMutantsTotal",
  "$Receipt.finalActiveProcesses -ne 0",
]);

const SUPERVISOR_EXECUTION_TOKENS = Object.freeze([
  "PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D",
  "InitializeProcThreadAttributeList(IntPtr.Zero, 2",
  "UpdateProcThreadAttribute(JOB_LIST)",
  "CREATE_SUSPENDED",
  "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  "IsProcessInJob",
  "ResumeThread(process.hThread)",
  "TerminateJobObject(job, 124)",
  "DrainTerminatedJob",
  "QueryActiveProcesses",
  "OutputHashesCapturedBeforeClose",
  "CreatePipe(out readPipe, out writePipe",
  "$StdinPathForNative = if ($null -eq $StdinPath)",
  "String.IsNullOrEmpty(stdinPath)",
  "CloseEmptyStdinWriteBeforeCreate",
  "result.EmptyStdinPipe = true",
  "HashOpenOutputPath",
  "GetFileSizeEx",
  "CreateCapturedOutputPipe",
  "SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0)",
  "OpenOwnedNewOutput",
  "CloseParentOutputWriteBeforeResume",
  "TranscriptCaptureState",
  "lock (gate)",
  "uint accepted = (uint)Math.Min((long)readBytes, remaining)",
  "if (accepted < readBytes) overflow = true",
  "WriteAll(context.OutputHandle, buffer, accepted, context.Label)",
  "StartCaptureThread",
  "JoinCaptureThreads",
  "new Thread(new ParameterizedThreadStart(CapturePipe))",
  "actualCombinedBytes > transcriptLimitBytes",
  "result.CompletionIssue = " + String.fromCharCode(34) +
    "TRANSCRIPT_LIMIT_EXCEEDED" + String.fromCharCode(34),
  "result.OutputHashesCapturedBeforeClose = true",
  "if ($Result.TranscriptLimitExceeded) { exit 125 }",
  "$TrustedSelector",
  "executableArguments",
  "FileShare.ReadWrite",
  'CloseChecked(job, "job"',
  "REQUEST_JSON_DUPLICATE_KEY",
  "trustedExecutablePath",
  "containmentScope",
]);
const RUNNER_EXECUTION_TOKENS = Object.freeze([
  "SUPERVISOR_CLOSE_GRACE_MS = 5_000",
  "lastKillReturned = child.kill()",
  "beginSupervisorTermination",
  "process.abort()",
  "MUTATION_TRANSCRIPT_LIMIT_BYTES = 67_108_864",
  "readAndHashClosedTranscript",
  "fstatSync(descriptor).size",
  "readStrictSupervisorReceipt",
  "parseBoundedUniqueJson",
  "evaluateRedBaselineSelfCheck",
  "selfChecksPassed: 2",
  "runContainedNodeSubject",
  "CONTAINED_ARGUMENTS_UNTRUSTED",
  "boundedSupervisorControlDiagnostic",
]);
const REFERENCED_WAIT_DECLARATION =
  ["function waitWith", "ReferencedHandleUntilTerminated()"].join("");
const REFERENCED_WAIT_INTERVAL = ["setInterval(", "() => {}, 1000);"].join("");
const HANDLE_FREE_UNRESOLVED_WAIT = ["await new Promise(", "() => {});"].join("");
const SEVERANCE_CALL =
  ["persistSeveranceProof(severedPath, intermediatePid, ", "grandchildIdentity);"].join("");
const SEVERANCE_CLOSE = ['once("cl', 'ose"'].join("");
const SEVERANCE_WRITE = ["writeFileSync(", "\n    severedPath,"].join("");

function auditRunbookExecution(source) {
  for (const token of RUNBOOK_EXECUTION_TOKENS) {
    if (!source.includes(token)) throw new Error(`runbook mutation execution is missing ${token}`);
  }
  if (source.includes("& powershell.exe")) {
    throw new Error("runbook reintroduced an unbounded mutation supervisor invocation");
  }
}

function auditSupervisorExecution(source) {
  for (const token of SUPERVISOR_EXECUTION_TOKENS) {
    if (!source.includes(token)) throw new Error(`supervisor execution is missing ${token}`);
  }
  if (source.includes("AssignProcessToJobObject(")) {
    throw new Error("supervisor reintroduced post-create job assignment");
  }
  const handleListStart = source.indexOf("handleList = Marshal.AllocHGlobal(IntPtr.Size * 3)");
  const handleListEnd = source.indexOf("UpdateProcThreadAttribute(HANDLE_LIST)", handleListStart);
  const handleList = source.slice(handleListStart, handleListEnd);
  if (
    handleListStart < 0 ||
    handleListEnd <= handleListStart ||
    !handleList.includes("stdoutPipeWriteHandle") ||
    !handleList.includes("stderrPipeWriteHandle") ||
    ["stdinPipeWriteHandle", "stdoutPipeReadHandle", "stderrPipeReadHandle",
      "stdoutHandle", "stderrHandle"].some((name) => handleList.includes(name))
  ) {
    throw new Error("supervisor HANDLE_LIST is not the exact stdin-read/output-write set");
  }
}

function auditRunnerExecution(source) {
  for (const token of RUNNER_EXECUTION_TOKENS) {
    if (!source.includes(token)) throw new Error(`mutation runner is missing ${token}`);
  }
  if (source.includes("self-check 2/2 SKIPPED")) {
    throw new Error("mutation runner permits an unproved second self-check");
  }
  if (source.includes('sha256File(filePath)') ||
      source.includes('readFileSync(filePath, "utf8")')) {
    throw new Error("mutation runner reintroduced an unbounded transcript read");
  }
}

function auditReferencedTerminationWait(source, label) {
  if (
    source.split(REFERENCED_WAIT_DECLARATION).length !== 2 ||
    source.split(REFERENCED_WAIT_INTERVAL).length !== 2
  ) {
    throw new Error(`${label} is missing exactly one referenced termination wait`);
  }
  if (source.includes(HANDLE_FREE_UNRESOLVED_WAIT)) {
    throw new Error(`${label} reintroduced a handle-free unresolved promise`);
  }
}

function auditSeveranceObserver({
  source,
  label,
  observerStart,
  observerEnd,
  helperEnd,
  aliveToken,
}) {
  const observerStartIndex = source.indexOf(observerStart);
  const observerEndIndex = source.indexOf(observerEnd, observerStartIndex + observerStart.length);
  const helperStartIndex = source.indexOf("function persistSeveranceProof(");
  const helperEndIndex = source.indexOf(helperEnd, helperStartIndex + 1);
  if (
    observerStartIndex < 0 ||
    observerEndIndex <= observerStartIndex ||
    helperStartIndex < 0 ||
    helperEndIndex <= helperStartIndex
  ) {
    throw new Error(`${label} severance observer/helper boundary is missing`);
  }
  const observer = source.slice(observerStartIndex, observerEndIndex);
  const closeIndex = observer.indexOf(SEVERANCE_CLOSE);
  const callIndex = observer.indexOf(SEVERANCE_CALL);
  if (closeIndex < 0 || callIndex <= closeIndex) {
    throw new Error(`${label} can persist severance before intermediate close`);
  }
  const helper = source.slice(helperStartIndex, helperEndIndex);
  const aliveIndex = helper.indexOf(aliveToken);
  const writeIndex = helper.indexOf(SEVERANCE_WRITE);
  if (aliveIndex < 0 || writeIndex <= aliveIndex) {
    throw new Error(`${label} can persist severance without a live grandchild PID proof`);
  }
}

function waitWithReferencedHandleUntilTerminated() {
  return new Promise(() => {
    setInterval(() => {}, 1000);
  });
}

function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  return path.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function supervisorRequest({
  root,
  subjectPath,
  subjectArguments = [],
  timeoutMs = 5000,
  innerTimeoutMs = null,
  environment = { set: {}, remove: [] },
}) {
  return {
    schema: "survey-qa-windows-job-supervisor-request/1.0.0",
    executablePath: process.execPath,
    subjectPath,
    executableArguments: [],
    arguments: subjectArguments,
    workingDirectory: WORKER_ROOT,
    subjectBoundaryPath: WORKER_ROOT,
    ioBoundaryPath: root,
    stdinPath: null,
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    receiptPath: path.join(root, "receipt.json"),
    timeoutMs,
    innerTimeoutMs,
    drainGraceMs: 5000,
    transcriptLimitBytes: 67_108_864,
    environment,
    attestation: null,
  };
}

function supervisorArgs(root, requestPath, trustedSelector = "none") {
  return [
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
    root,
    "-TrustedSelector",
    trustedSelector,
  ];
}

function runSupervisor(request, { rawRequest, trustedSelector = "none" } = {}) {
  const root = request.ioBoundaryPath;
  const requestPath = path.join(root, "request.json");
  writeFileSync(requestPath, rawRequest ?? JSON.stringify(request), {
    encoding: "utf8",
    flag: "wx",
  });
  const run = spawnSync(powershellPath(), supervisorArgs(root, requestPath, trustedSelector), {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    timeout: request.timeoutMs + request.drainGraceMs + 120000,
    windowsHide: true,
  });
  return {
    ...run,
    receipt: existsSync(request.receiptPath)
      ? JSON.parse(readFileSync(request.receiptPath, "utf8"))
      : null,
  };
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function boundedFileSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false };
  try {
    const bytes = readFileSync(filePath);
    return {
      exists: true,
      length: bytes.length,
      firstUtf8: bytes.subarray(0, 2048).toString("utf8"),
      lastUtf8: bytes.subarray(Math.max(0, bytes.length - 2048)).toString("utf8"),
    };
  } catch (error) {
    return { exists: true, readError: String(error?.code ?? error?.message ?? error) };
  }
}

async function waitForFileWhileProcessRuns(filePath, child, timeoutMs, diagnostic) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `process closed before ${filePath}: ${JSON.stringify({
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          ...diagnostic(),
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for ${filePath}: ${JSON.stringify({
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      ...diagnostic(),
    })}`,
  );
}

function readProcessIdentity(filePath, label) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${label} identity must be an object`,
  );
  assertEq(
    JSON.stringify(Object.keys(parsed).sort()),
    JSON.stringify(["pid", "processStartUtcMs"]),
    `${label} identity has unknown or missing fields`,
  );
  assert(
    Number.isSafeInteger(parsed.pid) && parsed.pid > 0,
    `${label} identity PID must be a canonical positive integer`,
  );
  assert(
    Number.isSafeInteger(parsed.processStartUtcMs) &&
      parsed.processStartUtcMs > 0 &&
      parsed.processStartUtcMs <= Date.now(),
    `${label} processStartUtcMs must be a canonical past UTC epoch`,
  );
  return parsed;
}

function processIdExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function persistSeveranceProof(severedPath, intermediatePid, grandchildIdentity) {
  if (!processIdExists(grandchildIdentity.pid)) {
    throw new Error(
      `grandchild PID was absent after intermediate close: ${JSON.stringify(grandchildIdentity)}`,
    );
  }
  writeFileSync(
    severedPath,
    `${JSON.stringify({
      intermediatePid,
      grandchildPid: grandchildIdentity.pid,
      observedUtcMs: Date.now(),
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function readSeveranceProof(filePath, grandchildIdentity, label) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${label} severance proof must be an object`,
  );
  assertEq(
    JSON.stringify(Object.keys(parsed).sort()),
    JSON.stringify(["grandchildPid", "intermediatePid", "observedUtcMs"]),
    `${label} severance proof has unknown or missing fields`,
  );
  assert(
    Number.isSafeInteger(parsed.intermediatePid) && parsed.intermediatePid > 0,
    `${label} intermediate PID must be a canonical positive integer`,
  );
  assertEq(parsed.grandchildPid, grandchildIdentity.pid, `${label} grandchild PID mismatch`);
  assert(
    Number.isSafeInteger(parsed.observedUtcMs) &&
      parsed.observedUtcMs >= grandchildIdentity.processStartUtcMs &&
      parsed.observedUtcMs <= Date.now(),
    `${label} observedUtcMs is invalid`,
  );
  return parsed;
}

function markerSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false, length: 0, firstBytesHex: "" };
  const bytes = readFileSync(filePath);
  return {
    exists: true,
    length: bytes.length,
    firstBytesHex: bytes.subarray(0, 256).toString("hex"),
    firstBytesUtf8: bytes.subarray(0, 256).toString("utf8"),
  };
}

async function assertMarkerRemainsAbsent(filePath, durationMs, label) {
  const deadline = Date.now() + durationMs;
  while (true) {
    const snapshot = markerSnapshot(filePath);
    assert(!snapshot.exists, `${label}: ${JSON.stringify(snapshot)}`);
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite("MUTATION EXECUTION CONTRACT — exact guards and closed release census", () => {
  test("declared kills form one stable exact union and malformed guards refuse", () => {
    const union = deriveExactKillNames([
      { name: "one", kills: ["alpha", "shared"] },
      { name: "two", kills: ["shared", "beta"] },
    ]);
    assertEq(JSON.stringify(union), JSON.stringify(["alpha", "shared", "beta"]));

    expectCode(() => deriveExactKillNames([]), "MUTANTS_EMPTY");
    expectCode(() => deriveExactKillNames([{ name: "none" }]), "MUTANT_KILLS_EMPTY");
    expectCode(
      () => deriveExactKillNames([{ name: "blank", kills: [" alpha"] }]),
      "MUTANT_KILL_INVALID",
    );
  });

  test("exact selector rejects duplicate, missing, ambiguous, and empty names", () => {
    const parsed = parseTestSelection(
      [EXACT_TEST_NAMES_STDIN_FLAG],
      JSON.stringify(["beta", "alpha"]),
    );
    assertEq(parsed.mode, "exact");
    assertEq(JSON.stringify(parsed.names), JSON.stringify(["beta", "alpha"]));

    expectCode(
      () => parseTestSelection([EXACT_TEST_NAMES_STDIN_FLAG], JSON.stringify(["alpha", "alpha"])),
      "EXACT_TEST_NAME_DUPLICATE",
    );
    expectCode(
      () => parseTestSelection([EXACT_TEST_NAMES_STDIN_FLAG], "[]"),
      "EXACT_TEST_NAMES_EMPTY",
    );
    expectCode(
      () => parseTestSelection([EXACT_TEST_NAMES_STDIN_FLAG], "not-json"),
      "EXACT_TEST_NAMES_JSON_INVALID",
    );

    const registry = [
      { suite: "suite one", name: "alpha", fn() {} },
      { suite: "suite two", name: "beta", fn() {} },
    ];
    const selected = selectRegistryCases(registry, parsed);
    assertEq(JSON.stringify(selected.map((entry) => entry.name)), JSON.stringify(["beta", "alpha"]));
    expectCode(
      () => selectRegistryCases(registry, { mode: "exact", names: ["missing"] }),
      "EXACT_TEST_NAME_MISSING",
    );
    expectCode(
      () => selectRegistryCases(
        [...registry, { suite: "suite three", name: "alpha", fn() {} }],
        { mode: "exact", names: ["alpha"] },
      ),
      "EXACT_TEST_NAME_AMBIGUOUS",
    );
  });

  test("legacy substring selection remains available but cannot pass on zero cases", () => {
    assertEq(parseTestSelection([]).filter, "");
    const parsed = parseTestSelection(["TWO"]);
    assertEq(parsed.mode, "substring");
    const registry = [
      { suite: "suite one", name: "alpha", fn() {} },
      { suite: "suite two", name: "beta", fn() {} },
    ];
    const selected = selectRegistryCases(registry, parsed);
    assertEq(selected.length, 1);
    assertEq(selected[0].name, "beta");
    expectCode(
      () => selectRegistryCases(registry, { mode: "substring", filter: "absent" }),
      "TEST_DENOMINATOR_EMPTY",
    );
    expectCode(() => parseTestSelection(["a", "b"]), "TEST_SELECTOR_ARGS_INVALID");
  });

  test("child timeout is bounded and a timed-out summary is still NO-RUN", () => {
    assertEq(resolveMutationChildTimeout(undefined), DEFAULT_MUTATION_CHILD_TIMEOUT_MS);
    assertEq(resolveMutationChildTimeout("1"), 1);
    assertEq(
      resolveMutationChildTimeout(String(MAX_MUTATION_CHILD_TIMEOUT_MS)),
      MAX_MUTATION_CHILD_TIMEOUT_MS,
    );
    for (const invalid of ["0", "-1", "1.5", "NaN", String(MAX_MUTATION_CHILD_TIMEOUT_MS + 1)]) {
      expectCode(() => resolveMutationChildTimeout(invalid), "MUTATION_CHILD_TIMEOUT_INVALID");
    }

    const healthy = classifySuiteProcess({
      stdout: "1/1 passed, 0 failed\n",
      stderr: "",
      status: 0,
      signal: null,
    });
    assert(healthy.completed, "healthy summary must complete");
    const timedOut = classifySuiteProcess({
      stdout: "1/1 passed, 0 failed\n",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: { code: "ETIMEDOUT" },
    });
    assertEq(timedOut.timedOut, true);
    assertEq(timedOut.completed, false, "a summary emitted before a hang cannot certify completion");
    assertEq(timedOut.errorCode, "ETIMEDOUT");
    assertEq(timedOut.signal, "SIGTERM");

    const crashAfterSummary = classifySuiteProcess({
      stdout: "1/1 passed, 0 failed\n",
      stderr: "",
      status: 2,
      signal: null,
    });
    assertEq(crashAfterSummary.completed, false, "a crash after a summary cannot be scored");
    assertEq(crashAfterSummary.completionIssue, "EXIT_STATUS_MISMATCH");

    const duplicateSummary = classifySuiteProcess({
      stdout: "1/1 passed, 0 failed\n1/1 passed, 0 failed\n",
      stderr: "",
      status: 0,
      signal: null,
    });
    assertEq(duplicateSummary.completed, false, "duplicate summaries cannot be scored");
    assertEq(duplicateSummary.summaryCount, 2);
    assertEq(duplicateSummary.completionIssue, "SUMMARY_COUNT");

    const unnamedFailure = classifySuiteProcess({
      stdout: "0/1 passed, 1 failed\n",
      stderr: "",
      status: 1,
      signal: null,
    });
    assertEq(unnamedFailure.completed, false, "every reported failure needs one named FAIL line");
    assertEq(unnamedFailure.completionIssue, "FAIL_LINE_COUNT_MISMATCH");

    const healthyRed = classifySuiteProcess({
      stdout: "  FAIL  guarded\n0/1 passed, 1 failed\n",
      stderr: "",
      status: 1,
      signal: null,
    });
    assertEq(healthyRed.completed, true, "one named failure plus status 1 is coherent");

    const untypedChildError = classifySuiteProcess({
      stdout: "1/1 passed, 0 failed\n",
      stderr: "",
      status: 0,
      signal: null,
      error: {},
    });
    assertEq(untypedChildError.completed, false, "any child error makes the transcript NO-RUN");
    assertEq(untypedChildError.completionIssue, "CHILD_ERROR");

    const crossStreamSummary = classifySuiteProcess({
      stdout: "1/1 passed, ",
      stderr: "0 failed\n",
      status: 0,
      signal: null,
    });
    assertEq(crossStreamSummary.completed, false, "stream boundaries cannot synthesize a summary");

    const timeoutWithAnchorText = classifySuiteProcess({
      stdout: "mutant patch matched 0 times\n1/1 passed, 0 failed\n",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: { code: "ETIMEDOUT" },
    });
    const timeoutVerdict = judge(
      { kills: ["guarded"], breaks: "nothing" },
      { ...timeoutWithAnchorText, timeoutMs: 10 },
      [],
    );
    assertEq(timeoutVerdict.status, "NO-RUN", "child failure outranks anchor diagnostics");
  });

  test("red-baseline self-check requires a new failure and an exact repeated set", () => {
    const completed = (failing) => ({ completed: true, anchorRejected: false, failing });
    assertEq(
      evaluateRedBaselineSelfCheck({
        baselineFailing: [],
        red: completed(["guard"]),
        again: completed(["guard"]),
      }).passed,
      true,
    );
    const negatives = [
      { red: { completed: false, anchorRejected: false, failing: [] }, again: completed([]) },
      { red: { completed: true, anchorRejected: true, failing: ["guard"] }, again: completed(["guard"]) },
      { red: completed([]), again: completed([]) },
      { red: completed(["already"]), again: completed(["already"]), baselineFailing: ["already"] },
      { red: completed(["guard"]), again: completed([]) },
      { red: completed(["guard"]), again: completed(["different"]) },
    ];
    for (const candidate of negatives) {
      assertEq(
        evaluateRedBaselineSelfCheck({ baselineFailing: [], ...candidate }).passed,
        false,
      );
    }
    const runner = readFileSync(path.join(TOOLS, "mutate-runner.mjs"), "utf8");
    assert(!runner.includes("self-check 2/2 SKIPPED"), "self-check 2/2 can still skip");
    assert(runner.includes("selfChecksPassed: 2"), "structured result lacks both self-checks");
  });

  test("bounded receipt decoder refuses hostile JSON and coherence forgeries", () => {
    const { expected, receipt } = validRunnerReceiptFixture();
    const encode = (value) => Buffer.from(JSON.stringify(value), "utf8");
    const decoded = decodeSupervisorReceiptBytes(encode(receipt));
    assertEq(validateSupervisorReceiptCoherence(decoded, 0, expected), "completed");

    expectCode(() => decodeSupervisorReceiptBytes(Buffer.alloc(65537, 0x20)),
      "SUPERVISOR_RECEIPT_TOO_LARGE");
    const duplicate = JSON.stringify(receipt).replace(
      '"schema":',
      '"schema":"duplicate","schema":',
    );
    expectCode(() => decodeSupervisorReceiptBytes(Buffer.from(duplicate)),
      "SUPERVISOR_RECEIPT_INVALID");
    expectCode(() => decodeSupervisorReceiptBytes(encode({ ...receipt, unknown: null })),
      "SUPERVISOR_RECEIPT_INVALID");
    const missing = { ...receipt };
    delete missing.schema;
    expectCode(() => decodeSupervisorReceiptBytes(encode(missing)),
      "SUPERVISOR_RECEIPT_INVALID");
    expectCode(() => decodeSupervisorReceiptBytes(Buffer.from([0xc3, 0x28])),
      "SUPERVISOR_RECEIPT_INVALID");

    for (const hostile of [
      { ...receipt, requestPinnedThroughRun: "true" },
      { ...receipt, schema: true },
      { ...receipt, timeoutMs: null },
    ]) {
      expectCode(() => decodeSupervisorReceiptBytes(encode(hostile)),
        "SUPERVISOR_RECEIPT_INVALID");
    }
    for (const token of ["5000.0", "5e3"]) {
      const hostile = JSON.stringify(receipt).replace('"timeoutMs":5000', `"timeoutMs":${token}`);
      expectCode(() => decodeSupervisorReceiptBytes(Buffer.from(hostile)),
        "SUPERVISOR_RECEIPT_INVALID");
    }

    const coherenceNegatives = [
      [{ ...receipt, requestSha256: "d".repeat(64) }, "requestSha256"],
      [{ ...receipt, executableSha256: "d".repeat(64), executableSha256After: "d".repeat(64) },
        "executableSha256"],
      [{ ...receipt, subjectSha256: "d".repeat(64), subjectSha256After: "d".repeat(64) },
        "subjectSha256"],
      [{ ...receipt, startedUtc: "not-a-timestamp" }, "startedUtc"],
      [{ ...receipt, startedUtc: "2026-02-31T00:00:00.0000000Z" }, "startedUtc"],
      [{ ...receipt, startedUtc: "2026-08-13T00:00:01.0000000Z" }, "endedUtc"],
      [{ ...receipt, durationMs: 200000 }, "durationMs"],
      [{ ...receipt, terminationIssued: true }, "terminationIssued"],
    ];
    for (const [hostile, property] of coherenceNegatives) {
      let caught = null;
      try {
        validateSupervisorReceiptCoherence(
          decodeSupervisorReceiptBytes(encode(hostile)),
          0,
          expected,
        );
      } catch (error) {
        caught = error;
      }
      assertEq(caught?.code, "SUPERVISOR_RECEIPT_PROPERTY_MISMATCH");
      assertEq(caught?.property, property);
    }
  });

  test("release manifests account set-equal for all 42 mutation-pattern files", () => {
    const deploy = readFileSync(DEPLOY_PATH, "utf8");
    const harnesses = parsePowerShellArray(deploy, "MutationHarnesses");
    const libraries = parsePowerShellArray(deploy, "MutationLibraries");
    const discovered = readdirSync(TOOLS)
      .filter((name) => /^mutate-[A-Za-z0-9._-]+\.mjs$/u.test(name))
      .sort();

    assertEq(harnesses.length, 41, "all actual harnesses remain mandatory");
    assertEq(libraries.length, 1, "only the shared runner is library-only");
    assertEq(libraries[0], "mutate-runner.mjs");
    assert(!harnesses.includes("mutate-runner.mjs"), "library cannot pass as a harness");
    assertSameSet([...harnesses, ...libraries], discovered, "declared mutation census");

    const removed = deploy.replace(/^\s*"mutate-allocation\.mjs",\r?\n/mu, "");
    expectThrow(() => {
      const mutated = [
        ...parsePowerShellArray(removed, "MutationHarnesses"),
        ...parsePowerShellArray(removed, "MutationLibraries"),
      ];
      assertSameSet(mutated, discovered, "mutated mutation census");
    }, /differs/u);
  });

  test("release harness loop requires bounded durable per-script evidence", () => {
    const deploy = readFileSync(DEPLOY_PATH, "utf8");
    auditRunbookExecution(deploy);
    for (const token of RUNBOOK_EXECUTION_TOKENS) {
      const mutant = deploy.replaceAll(token, "");
      assert(mutant !== deploy, `runbook fixture is missing mutation token ${token}`);
      expectThrow(() => auditRunbookExecution(mutant), /missing/u);
    }
    expectThrow(
      () => auditRunbookExecution(deploy + "\n& powershell.exe\n"),
      /unbounded/u,
    );
  });

  test("DEPLOY canonical watchdog types reject string booleans and decimal numbers", () => {
    const deploy = readFileSync(DEPLOY_PATH, "utf8");
    const functions = deployJsonValidationFunctions(deploy);
    const root = mkdtempSync(path.join(os.tmpdir(), "deploy-json-types-"));
    try {
      const jsonPath = path.join(root, "watchdog.json").replaceAll("'", "''");
      const script = `$ErrorActionPreference = "Stop"\n${functions}\n` + String.raw`
$Expected = @(
  "schema", "harness", "processHostPath", "startAttemptUtc", "processStarted",
  "processId", "processStartTimeUtc", "waitTimeoutMs", "outerTimeoutMs", "innerTimeoutMs",
  "drainGraceMs", "startupGraceMs", "transcriptLimitBytes", "exitedWithinBound",
  "watchdogFired", "killReason", "killAttempted", "killSucceeded", "killError",
  "exitedAfterKill", "exitCode", "controlError", "endedUtc")
function New-Watchdog([object] $ProcessStarted, [object] $WaitTimeoutMs) {
  return [ordered]@{
    schema = "survey-qa-mutation-supervisor-watchdog/1.0.0"
    harness = "mutate-example.mjs"
    processHostPath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    startAttemptUtc = "2026-08-13T00:00:00.0000000Z"
    processStarted = $ProcessStarted
    processId = 1
    processStartTimeUtc = "2026-08-13T00:00:00.0000000Z"
    waitTimeoutMs = $WaitTimeoutMs
    outerTimeoutMs = 7200000
    innerTimeoutMs = 120000
    drainGraceMs = 30000
    startupGraceMs = 120000
    transcriptLimitBytes = 67108864
    exitedWithinBound = $true
    watchdogFired = $false
    killReason = $null
    killAttempted = $false
    killSucceeded = $false
    killError = $null
    exitedAfterKill = $null
    exitCode = 0
    controlError = $null
    endedUtc = "2026-08-13T00:00:01.0000000Z"
  }
}
function Write-Canonical([object] $Value, [string] $PathValue, [bool] $DecimalToken) {
  $Text = (($Value | ConvertTo-Json -Depth 4) + [Environment]::NewLine)
  if ($DecimalToken) {
    $Mutated = $Text.Replace('"waitTimeoutMs":  7350000', '"waitTimeoutMs":  7350000.0')
    if ($Mutated -ceq $Text) { throw "decimal hostile token anchor did not match" }
    $Text = $Mutated
  }
  $Bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  [IO.File]::WriteAllBytes($PathValue, $Bytes)
}
$Cases = @(
  [pscustomobject]@{ value = (New-Watchdog "true" 7350000); decimal = $false; expected = "JSON boolean" },
  [pscustomobject]@{ value = (New-Watchdog $true 7350000); decimal = $true; expected = "JSON integer" }
)
foreach ($Case in $Cases) {
  Write-Canonical $Case.value '${jsonPath}' $Case.decimal
  $Parsed = Read-CanonicalClosedJson '${jsonPath}' $Expected 4 "mutation watchdog"
  $Caught = $null
  try { Assert-MutationWatchdogTypes $Parsed } catch { $Caught = $_.Exception.Message }
  if ($null -eq $Caught -or -not $Caught.Contains($Case.expected)) {
    throw ("hostile canonical type was accepted or misclassified: " + $Case.expected + "; " + $Caught)
  }
}
`;
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const run = spawnSync(
        powershellPath(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { cwd: WORKER_ROOT, encoding: "utf8", timeout: 20000, windowsHide: true },
      );
      assertEq(
        run.status,
        0,
        `DEPLOY type negatives failed: stderr=${JSON.stringify(run.stderr)}; ` +
          `stdout=${JSON.stringify(run.stdout)}; error=${String(run.error ?? "none")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows supervisor contract is creation-atomic and every token is fail-capable", () => {
    const supervisor = readFileSync(SUPERVISOR_PATH, "utf8");
    const runner = readFileSync(path.join(TOOLS, "mutate-runner.mjs"), "utf8");
    const contract = readFileSync(CONTRACT_PATH, "utf8");
    const delayedMarker = readFileSync(DELAYED_MARKER_FIXTURE, "utf8");
    auditSupervisorExecution(supervisor);
    auditRunnerExecution(runner);
    auditReferencedTerminationWait(contract, "mutation contract");
    auditReferencedTerminationWait(delayedMarker, "delayed marker fixture");
    const severanceAudits = [
      {
        source: contract,
        label: "mutation contract",
        observerStart: 'test("hostile supervised timeout spawns a child that must not escape"',
        observerEnd: "\n  });\n});",
        helperEnd: "\nfunction readSeveranceProof(",
        aliveToken: "if (!processIdExists(grandchildIdentity.pid))",
      },
      {
        source: delayedMarker,
        label: "delayed marker fixture",
        observerStart: "async function runRoot(",
        observerEnd: "\nfunction runGrandchild(",
        helperEnd: "\nfunction writeOnce(",
        aliveToken: "if (!probeProcess(grandchildIdentity.pid).alive) fail();",
      },
    ];
    for (const audit of severanceAudits) auditSeveranceObserver(audit);
    for (const token of SUPERVISOR_EXECUTION_TOKENS) {
      const mutant = supervisor.replaceAll(token, "");
      assert(mutant !== supervisor, `supervisor fixture is missing mutation token ${token}`);
      expectThrow(() => auditSupervisorExecution(mutant), /missing|post-create/u);
    }
    for (const token of RUNNER_EXECUTION_TOKENS) {
      const mutant = runner.replaceAll(token, "");
      assert(mutant !== runner, `runner fixture is missing mutation token ${token}`);
      expectThrow(() => auditRunnerExecution(mutant), /missing|unbounded|unproved/u);
    }
    const postCreateAssignmentMutant =
      supervisor + "\n// AssignProcessToJobObject(job, process)\n";
    expectThrow(() => auditSupervisorExecution(postCreateAssignmentMutant), /post-create/u);
    const inheritedWriteEndMutant = supervisor.replace(
      "Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderrPipeWriteHandle);",
      "Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderrPipeWriteHandle);\n" +
        "Marshal.WriteIntPtr(handleList, 3 * IntPtr.Size, stdinPipeWriteHandle);",
    );
    expectThrow(
      () => auditSupervisorExecution(inheritedWriteEndMutant),
        /exact stdin-read\/output-write set/u,
    );
    for (const [label, source] of [
      ["mutation contract", contract],
      ["delayed marker fixture", delayedMarker],
    ]) {
      const missingHandleMutant = source.replace(REFERENCED_WAIT_INTERVAL, "");
      expectThrow(
        () => auditReferencedTerminationWait(missingHandleMutant, label),
        /referenced termination wait/u,
      );
      const barePromiseMutant = source + "\n" + HANDLE_FREE_UNRESOLVED_WAIT + "\n";
      expectThrow(
        () => auditReferencedTerminationWait(barePromiseMutant, label),
        /handle-free unresolved promise/u,
      );
    }
    for (const audit of severanceAudits) {
      const noAliveMutant = audit.source.replace(audit.aliveToken, "");
      expectThrow(
        () => auditSeveranceObserver({ ...audit, source: noAliveMutant }),
        /without a live grandchild PID proof/u,
      );
      const movedCallMutant = audit.source
        .replace(SEVERANCE_CALL, "")
        .replace(SEVERANCE_CLOSE, SEVERANCE_CALL + "\n" + SEVERANCE_CLOSE);
      expectThrow(
        () => auditSeveranceObserver({ ...audit, source: movedCallMutant }),
        /before intermediate close/u,
      );
    }
  });

  test("strict request refuses duplicate keys and request-authorized trust roots", () => {
    const duplicateRoot = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-duplicate-"));
    try {
      const request = supervisorRequest({
        root: duplicateRoot,
        subjectPath: DELAYED_MARKER_FIXTURE,
        subjectArguments: [
          path.join(duplicateRoot, "started.txt"),
          path.join(duplicateRoot, "forbidden.txt"),
          "10",
        ],
      });
      const raw = JSON.stringify(request).replace(
        '"timeoutMs":5000',
        '"timeoutMs":5000,"timeoutMs":1',
      );
      const run = runSupervisor(request, { rawRequest: raw });
      assert(run.status !== 0, "duplicate JSON keys must fail");
      assert(
        /REQUEST_JSON_DUPLICATE_KEY/u.test(`${run.stderr}${run.stdout}`),
        `duplicate refusal output: status=${run.status}; error=${run.error ?? "none"}; ` +
          `stderr=${JSON.stringify(run.stderr)}; stdout=${JSON.stringify(run.stdout)}`,
      );
      assertEq(run.receipt, null, "preflight schema refusal must never actuate");
      assert(!existsSync(path.join(duplicateRoot, "started.txt")), "duplicate request actuated");
    } finally {
      rmSync(duplicateRoot, { recursive: true, force: true });
    }

    const hostileTypeCases = [
      ["schema-boolean", (request) => JSON.stringify({ ...request, schema: true }),
        /REQUEST_SCHEMA_INVALID/u, "none"],
      ["schema-value-case", (request) => JSON.stringify({
        ...request,
        schema: "Survey-qa-windows-job-supervisor-request/1.0.0",
      }), /REQUEST_SCHEMA_INVALID/u, "none"],
      ["root-key-case", (request) => JSON.stringify(request).replace('"schema":', '"Schema":'),
        /REQUEST_SCHEMA_INVALID/u, "none"],
      ["boolean-path", (request) => JSON.stringify({ ...request, executablePath: true }),
        /REQUEST_SCHEMA_INVALID/u, "none"],
      ["environment-key-case", (request) => JSON.stringify(request).replace(
        '"environment":{"set":',
        '"environment":{"Set":',
      ), /REQUEST_SCHEMA_INVALID/u, "none"],
      ["timeout-decimal", (request) => JSON.stringify(request).replace(
        '"timeoutMs":5000',
        '"timeoutMs":5000.0',
      ), /TIMEOUT_INVALID/u, "none"],
      ["timeout-exponent", (request) => JSON.stringify(request).replace(
        '"timeoutMs":5000',
        '"timeoutMs":5e3',
      ), /TIMEOUT_INVALID/u, "none"],
      ["attestation-key-case", (request) => JSON.stringify({
        ...request,
        attestation: {
          Head: "a".repeat(40),
          v2Tree: "b".repeat(40),
          harness: path.basename(request.subjectPath),
          harnessSha256: "c".repeat(64),
          selector: "exact-union-of-declared-kills",
        },
      }), /REQUEST_SCHEMA_INVALID/u, "exact-union-of-declared-kills"],
    ];
    for (const [label, rawFactory, refusalPattern, trustedSelector] of hostileTypeCases) {
      const root = mkdtempSync(path.join(os.tmpdir(), `job-supervisor-${label}-`));
      try {
        const started = path.join(root, "started.txt");
        const request = supervisorRequest({
          root,
          subjectPath: DELAYED_MARKER_FIXTURE,
          subjectArguments: [
            "grandchild",
            started,
            path.join(root, "forbidden.txt"),
            "10000",
            String(process.pid),
          ],
        });
        const run = runSupervisor(request, {
          rawRequest: rawFactory(request),
          trustedSelector,
        });
        assert(run.status !== 0, `${label} hostile request must fail`);
        assert(
          refusalPattern.test(`${run.stderr}${run.stdout}`),
          `${label} refusal output: status=${run.status}; stderr=${JSON.stringify(run.stderr)}; ` +
            `stdout=${JSON.stringify(run.stdout)}`,
        );
        assertEq(run.receipt, null, `${label} refusal must precede receipt creation`);
        assert(!existsSync(started), `${label} hostile request actuated its subject`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const trustRoot = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-trust-"));
    try {
      const request = supervisorRequest({
        root: trustRoot,
        subjectPath: DELAYED_MARKER_FIXTURE,
        subjectArguments: [
          path.join(trustRoot, "started.txt"),
          path.join(trustRoot, "forbidden.txt"),
          "10",
        ],
      });
      request.executablePath = powershellPath();
      const run = runSupervisor(request);
      assert(run.status !== 0, "request cannot replace the trusted executable");
      assert(
        /TRUSTED_PATH_MISMATCH/u.test(`${run.stderr}${run.stdout}`),
        `trust refusal output: status=${run.status}; error=${run.error ?? "none"}; ` +
          `stderr=${JSON.stringify(run.stderr)}; stdout=${JSON.stringify(run.stdout)}`,
      );
      assert(!existsSync(path.join(trustRoot, "started.txt")), "untrusted executable actuated");
    } finally {
      rmSync(trustRoot, { recursive: true, force: true });
    }

    const emptyStdinRoot = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-empty-stdin-"));
    try {
      const started = path.join(emptyStdinRoot, "started.txt");
      const request = supervisorRequest({
        root: emptyStdinRoot,
        subjectPath: DELAYED_MARKER_FIXTURE,
        subjectArguments: [
          "grandchild",
          started,
          path.join(emptyStdinRoot, "forbidden.txt"),
          "60000",
          String(process.pid),
        ],
      });
      request.stdinPath = "";
      const run = runSupervisor(request);
      assert(run.status !== 0, "caller-forged empty stdin sentinel must fail");
      assert(/REQUEST_SCHEMA_INVALID/u.test(`${run.stderr}${run.stdout}`));
      assertEq(run.receipt, null, "empty stdinPath refusal must occur before actuation");
      assert(!existsSync(started), "empty stdinPath request actuated");
    } finally {
      rmSync(emptyStdinRoot, { recursive: true, force: true });
    }
  });

  test("null stdin is an explicit inherited EOF pipe", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-stdin-eof-"));
    try {
      const request = supervisorRequest({
        root,
        subjectPath: STDIN_EOF_FIXTURE,
        timeoutMs: 10000,
      });
      const run = runSupervisor(request);
      assertEq(
        run.status,
        0,
        `null-stdin supervisor failed: stderr=${JSON.stringify(run.stderr)}; ` +
          `stdout=${JSON.stringify(run.stdout)}; receipt=${JSON.stringify(run.receipt)}`,
      );
      assertEq(run.receipt.emptyStdinPipe, true);
      assertEq(run.receipt.finalActiveProcesses, 0);
      assertEq(run.receipt.handlesClosed, true);
      assertEq(run.receipt.outputHashesCapturedBeforeClose, true);
      const output = JSON.parse(readFileSync(request.stdoutPath, "utf8"));
      assertEq(JSON.stringify(output), JSON.stringify({ bytes: 0, ended: true }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("combined transcript threshold terminates a post-root descendant at a hashed hard cap", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-output-limit-"));
    try {
      const request = supervisorRequest({
        root,
        subjectPath: OUTPUT_FLOOD_FIXTURE,
        timeoutMs: 30000,
      });
      const run = runSupervisor(request);
      assertEq(
        run.status,
        125,
        `output-limit supervisor failed: stderr=${JSON.stringify(run.stderr)}; ` +
          `stdout=${JSON.stringify(run.stdout)}; receipt=${JSON.stringify(run.receipt)}`,
      );
      assert(run.receipt !== null, "output-limit supervisor emitted no receipt");
      assertEq(run.receipt.transcriptLimitBytes, 67_108_864);
      assertEq(run.receipt.transcriptLimitExceeded, true);
      assertEq(run.receipt.completionIssue, "TRANSCRIPT_LIMIT_EXCEEDED");
      assertEq(run.receipt.timedOut, false);
      assertEq(run.receipt.terminationIssued, true);
      assertEq(run.receipt.finalActiveProcesses, 0);
      assertEq(run.receipt.handlesClosed, true);
      assertEq(run.receipt.outputHashesCapturedBeforeClose, true);
      assertEq(run.receipt.stdoutSha256After, run.receipt.stdoutSha256);
      assertEq(run.receipt.stderrSha256After, run.receipt.stderrSha256);
      assert(/^[0-9a-f]{64}$/u.test(run.receipt.stdoutSha256));
      assert(/^[0-9a-f]{64}$/u.test(run.receipt.stderrSha256));
      const combined = run.receipt.stdoutBytes + run.receipt.stderrBytes;
      assertEq(combined, request.transcriptLimitBytes,
        "pipe-drained logs must stop at the exact combined byte budget");
      assertEq(statSync(request.stdoutPath).size, run.receipt.stdoutBytes);
      assertEq(statSync(request.stderrPath).size, run.receipt.stderrBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hard transcript cap distinguishes exact boundary, one extra byte, and dual streams", () => {
    const cases = [
      { mode: "exact-cap", status: 0, exceeded: false, terminated: false, dual: false },
      { mode: "cap-plus-one", status: 125, exceeded: true, terminated: true, dual: false },
      { mode: "dual-flood", status: 125, exceeded: true, terminated: true, dual: true },
    ];
    for (const candidate of cases) {
      const root = mkdtempSync(path.join(os.tmpdir(), `job-supervisor-${candidate.mode}-`));
      try {
        const request = supervisorRequest({
          root,
          subjectPath: OUTPUT_FLOOD_FIXTURE,
          subjectArguments: [candidate.mode],
          timeoutMs: 30000,
        });
        const run = runSupervisor(request);
        assertEq(
          run.status,
          candidate.status,
          `${candidate.mode} failed: stderr=${JSON.stringify(run.stderr)}; ` +
            `stdout=${JSON.stringify(run.stdout)}; receipt=${JSON.stringify(run.receipt)}`,
        );
        assert(run.receipt !== null, `${candidate.mode} emitted no receipt`);
        assertEq(run.receipt.transcriptLimitExceeded, candidate.exceeded);
        assertEq(run.receipt.terminationIssued, candidate.terminated);
        assertEq(run.receipt.finalActiveProcesses, 0);
        assertEq(run.receipt.handlesClosed, true);
        assertEq(run.receipt.outputHashesCapturedBeforeClose, true);
        assertEq(run.receipt.stdoutSha256After, run.receipt.stdoutSha256);
        assertEq(run.receipt.stderrSha256After, run.receipt.stderrSha256);
        assert(/^[0-9a-f]{64}$/u.test(run.receipt.stdoutSha256));
        assert(/^[0-9a-f]{64}$/u.test(run.receipt.stderrSha256));
        const combined = run.receipt.stdoutBytes + run.receipt.stderrBytes;
        assertEq(combined, 67_108_864, `${candidate.mode} captured byte count differs`);
        assertEq(statSync(request.stdoutPath).size, run.receipt.stdoutBytes);
        assertEq(statSync(request.stderrPath).size, run.receipt.stderrBytes);
        if (candidate.dual) {
          assert(run.receipt.stdoutBytes > 0, "dual-stream fixture did not capture stdout");
          assert(run.receipt.stderrBytes > 0, "dual-stream fixture did not capture stderr");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("runner rejects an allowlisted flood with bounded diagnostics and closed receipt", async () => {
    const result = await runContainedNodeSubject({
      subjectPath: OUTPUT_FLOOD_FIXTURE,
      arguments: [OUTPUT_FLOOD_FIXTURE],
      timeoutMs: 30000,
    });
    assertEq(result.completed, false);
    assertEq(result.errorCode, "TRANSCRIPT_LIMIT_EXCEEDED");
    assertEq(result.completionIssue, "TRANSCRIPT_LIMIT_EXCEEDED");
    assertEq(result.supervisorStatus, 125);
    assertEq(result.finalActiveProcesses, 0);
    assertEq(result.containmentScope, WINDOWS_JOB_CONTAINMENT_SCOPE);
    assertEq(
      result.stdout,
      "[diagnostic transcript omitted: exceeds 65536 bytes]",
      "runner must not read the oversized stdout transcript",
    );
    assert(result.stderr.length <= 65536, "stderr diagnostic exceeded its bound");
    const evidence = result.receiptEvidence;
    assert(evidence !== null, "runner omitted transcript-limit receipt evidence");
    assertEq(evidence.transcriptLimitBytes, 67108864);
    assertEq(evidence.transcriptLimitExceeded, true);
    assertEq(evidence.completionIssue, "TRANSCRIPT_LIMIT_EXCEEDED");
    assertEq(evidence.timedOut, false);
    assertEq(evidence.terminationIssued, true);
    assertEq(evidence.finalActiveProcesses, 0);
    assertEq(evidence.handlesClosed, true);
    assertEq(evidence.outputHashesCapturedBeforeClose, true);
    assertEq(evidence.stdoutBytes + evidence.stderrBytes, 67108864,
      "runner must expose exactly the hard-captured byte budget");
    assertEq(evidence.stdoutSha256After, evidence.stdoutSha256);
    assertEq(evidence.stderrSha256After, evidence.stderrSha256);
    assert(/^[0-9a-f]{64}$/u.test(evidence.stdoutSha256));
    assert(/^[0-9a-f]{64}$/u.test(evidence.stderrSha256));
  });

  test("inner runSuite timeout returns only after a hostile grandchild is absent", async () => {
    const markerRoot = mkdtempSync(path.join(os.tmpdir(), "mutation-inner-timeout-"));
    try {
      const started = path.join(markerRoot, "started.txt");
      const severed = path.join(markerRoot, "severed.txt");
      const forbidden = path.join(markerRoot, "forbidden.txt");
      const exactName = "hostile supervised timeout spawns a child that must not escape";
      const result = await runSuite({
        exactTestNames: [exactName],
        timeoutMs: 10_000,
        additionalEnvironment: {
          JOB_SUPERVISOR_FIXTURE_PATH: DELAYED_MARKER_FIXTURE,
          JOB_SUPERVISOR_STARTED_PATH: started,
          JOB_SUPERVISOR_SEVERED_PATH: severed,
          JOB_SUPERVISOR_FORBIDDEN_PATH: forbidden,
        },
      });
      const startedAtReturn = existsSync(started);
      const severedAtReturn = existsSync(severed);
      const forbiddenAtReturn = markerSnapshot(forbidden);
      let grandchildIdentity = null;
      let severanceProof = null;
      let grandchildIdentityError = null;
      if (startedAtReturn) {
        try {
          grandchildIdentity = readProcessIdentity(started, "grandchild");
          if (severedAtReturn) {
            severanceProof = readSeveranceProof(severed, grandchildIdentity, "hostile");
          }
        } catch (error) {
          grandchildIdentityError = String(error?.message ?? error);
        }
      }
      const grandchildPidAliveAtReturn =
        grandchildIdentity === null ? null : processIdExists(grandchildIdentity.pid);
      const tail = (value) =>
        typeof value === "string" ? value.slice(-2000) : String(value ?? "");
      const hostileDiagnostic = JSON.stringify({
        timedOut: result.timedOut,
        completed: result.completed,
        completionIssue: result.completionIssue,
        errorCode: result.errorCode,
        errorName: result.errorName,
        errorMessage: result.errorMessage,
        errorProperty: result.errorProperty,
        supervisorStatus: result.supervisorStatus,
        finalActiveProcesses: result.finalActiveProcesses,
        containmentScope: result.containmentScope,
        startedAtReturn,
        severedAtReturn,
        forbiddenAtReturn,
        grandchildIdentity,
        severanceProof,
        grandchildIdentityError,
        grandchildPidAliveAtReturn,
        outTail: tail(result.out),
      });
      assertEq(
        result.timedOut,
        true,
        `hostile inner suite must be classified as ETIMEDOUT: ${hostileDiagnostic}`,
      );
      assertEq(result.completed, false, "timed-out suite cannot be scoreable");
      assertEq(result.finalActiveProcesses, 0, "runSuite returned with a live job member");
      assertEq(result.containmentScope, WINDOWS_JOB_CONTAINMENT_SCOPE);
      assert(startedAtReturn, "hostile grandchild never started, denominator unexercised");
      assert(
        severedAtReturn,
        "hostile grandchild was not proven alive after its intermediate parent exited",
      );
      assert(grandchildIdentity !== null, `invalid grandchild identity: ${grandchildIdentityError}`);
      assert(severanceProof !== null, `invalid severance proof: ${grandchildIdentityError}`);
      assert(
        !grandchildPidAliveAtReturn,
        `grandchild PID remained alive after runSuite returned: ${JSON.stringify(grandchildIdentity)}`,
      );
      assert(
        !forbiddenAtReturn.exists,
        `grandchild wrote during containment return: ${JSON.stringify(forbiddenAtReturn)}`,
      );
      await assertMarkerRemainsAbsent(
        forbidden,
        3000,
        "grandchild escaped after runSuite returned",
      );
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  test("supervisor death closes the job and nested job execution completes", async () => {
    const deathRoot = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-death-"));
    try {
      const started = path.join(deathRoot, "started.txt");
      const severed = path.join(deathRoot, "severed.txt");
      const forbidden = path.join(deathRoot, "forbidden.txt");
      const rootIdentityPath = path.join(deathRoot, "root-identity.json");
      const request = supervisorRequest({
        root: deathRoot,
        subjectPath: DELAYED_MARKER_FIXTURE,
        subjectArguments: ["root", started, severed, forbidden, rootIdentityPath, "60000"],
        timeoutMs: 60000,
      });
      const requestPath = path.join(deathRoot, "request.json");
      writeFileSync(requestPath, JSON.stringify(request), { encoding: "utf8", flag: "wx" });
      const supervisor = spawn(
        powershellPath(),
        supervisorArgs(deathRoot, requestPath),
        { cwd: WORKER_ROOT, windowsHide: true, stdio: "ignore" },
      );
      const supervisorIdentity = {
        pid: supervisor.pid,
        observedStartedUtcMs: Date.now(),
      };
      assert(
        Number.isSafeInteger(supervisorIdentity.pid) && supervisorIdentity.pid > 0,
        "spawned supervisor has no canonical positive PID",
      );
      await waitForFileWhileProcessRuns(severed, supervisor, 30000, () => ({
        started: boundedFileSnapshot(started),
        rootIdentity: boundedFileSnapshot(rootIdentityPath),
        forbidden: boundedFileSnapshot(forbidden),
        stdout: boundedFileSnapshot(request.stdoutPath),
        stderr: boundedFileSnapshot(request.stderrPath),
        receipt: boundedFileSnapshot(request.receiptPath),
      }));
      assert(existsSync(started), "supervisor-death grandchild never started");
      assert(existsSync(rootIdentityPath), "supervisor-death root identity is absent");
      const rootIdentity = readProcessIdentity(rootIdentityPath, "supervisor-death root");
      const grandchildIdentity = readProcessIdentity(started, "supervisor-death grandchild");
      readSeveranceProof(severed, grandchildIdentity, "supervisor-death");
      assert(
        processIdExists(rootIdentity.pid),
        `supervisor-death root was not alive before kill: ${JSON.stringify(rootIdentity)}`,
      );
      assert(
        processIdExists(grandchildIdentity.pid),
        `supervisor-death grandchild was not alive before kill: ${JSON.stringify(grandchildIdentity)}`,
      );
      const supervisorPid = supervisorIdentity.pid;
      assertEq(supervisor.kill(), true, "failed to issue exact supervisor termination");
      await new Promise((resolve, reject) => {
        supervisor.once("error", reject);
        supervisor.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert(
        !processIdExists(supervisorPid),
        `terminated supervisor PID remained alive after close: ${JSON.stringify(supervisorIdentity)}`,
      );
      assert(
        !processIdExists(rootIdentity.pid),
        `KILL_ON_JOB_CLOSE left root PID alive: ${JSON.stringify(rootIdentity)}`,
      );
      assert(
        !processIdExists(grandchildIdentity.pid),
        `KILL_ON_JOB_CLOSE left grandchild PID alive: ${JSON.stringify(grandchildIdentity)}`,
      );
      const forbiddenAtClose = markerSnapshot(forbidden);
      assert(
        !forbiddenAtClose.exists,
        `grandchild wrote during supervisor-death containment: ${JSON.stringify(forbiddenAtClose)}`,
      );
      await assertMarkerRemainsAbsent(
        forbidden,
        3000,
        "KILL_ON_JOB_CLOSE did not contain supervisor death",
      );
    } finally {
      rmSync(deathRoot, { recursive: true, force: true });
    }

    const nestedRoot = mkdtempSync(path.join(os.tmpdir(), "job-supervisor-nested-"));
    try {
      const exactName = "declared kills form one stable exact union and malformed guards refuse";
      const request = supervisorRequest({
        root: nestedRoot,
        subjectPath: NESTED_RUNNER_FIXTURE,
        subjectArguments: [exactName, "120000"],
        timeoutMs: 180000,
        innerTimeoutMs: 120000,
      });
      const run = runSupervisor(request);
      assertEq(run.status, 0, `nested job supervisor failed: ${run.stderr}`);
      assertEq(run.receipt.finalActiveProcesses, 0);
      assertEq(run.receipt.membershipVerified, true);
      const output = readFileSync(request.stdoutPath, "utf8").trim();
      const nested = JSON.parse(output);
      assertEq(nested.completed, true);
      assertEq(nested.finalActiveProcesses, 0);
      assertEq(nested.containmentScope, WINDOWS_JOB_CONTAINMENT_SCOPE);
    } finally {
      rmSync(nestedRoot, { recursive: true, force: true });
    }
  });

  test("hostile supervised timeout spawns a child that must not escape", async () => {
    const fixturePath = process.env.JOB_SUPERVISOR_FIXTURE_PATH;
    const startedPath = process.env.JOB_SUPERVISOR_STARTED_PATH;
    const severedPath = process.env.JOB_SUPERVISOR_SEVERED_PATH;
    const forbiddenPath = process.env.JOB_SUPERVISOR_FORBIDDEN_PATH;
    if (
      typeof fixturePath !== "string" ||
      typeof startedPath !== "string" ||
      typeof severedPath !== "string" ||
      typeof forbiddenPath !== "string"
    ) {
      return;
    }
    const child = spawn(
      process.execPath,
      [
        fixturePath,
        "intermediate",
        startedPath,
        forbiddenPath,
        "60000",
        String(process.pid),
      ],
      { cwd: WORKER_ROOT, windowsHide: true, stdio: "ignore" },
    );
    const intermediatePid = child.pid;
    assert(
      Number.isSafeInteger(intermediatePid) && intermediatePid > 0,
      "hostile intermediate has no canonical positive PID",
    );
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    assertEq(status, 0, "hostile intermediate did not exit cleanly");
    assert(existsSync(startedPath), "hostile grandchild start proof is absent");
    const grandchildIdentity = readProcessIdentity(startedPath, "hostile grandchild");
    persistSeveranceProof(severedPath, intermediatePid, grandchildIdentity);
    await waitWithReferencedHandleUntilTerminated();
  });
});
