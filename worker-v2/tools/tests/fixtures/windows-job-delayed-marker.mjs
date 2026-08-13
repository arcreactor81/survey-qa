import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SELF_PATH = fileURLToPath(import.meta.url);
const PROCESS_START_UTC_MS = Date.now();
const ROOT_GONE_GRACE_MS = 2000;

function fail() {
  process.exit(2);
}

function absoluteFile(candidate) {
  return typeof candidate === "string" && path.isAbsolute(candidate) && candidate.indexOf("\0") < 0;
}

function positiveInteger(candidate) {
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return { alive: true, code: null };
  } catch (error) {
    return {
      alive: error?.code !== "ESRCH",
      code: typeof error?.code === "string" ? error.code : "UNKNOWN",
    };
  }
}

function readProcessIdentity(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !==
      JSON.stringify(["pid", "processStartUtcMs"]) ||
    positiveInteger(parsed.pid) === null ||
    positiveInteger(parsed.processStartUtcMs) === null ||
    parsed.processStartUtcMs > Date.now()
  ) {
    fail();
  }
  return parsed;
}

function persistSeveranceProof(severedPath, intermediatePid, grandchildIdentity) {
  if (!probeProcess(grandchildIdentity.pid).alive) fail();
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

function writeOnce(filePath, contents) {
  try {
    writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitWithReferencedHandleUntilTerminated() {
  return new Promise(() => {
    setInterval(() => {}, 1000);
  });
}

function spawnIntermediate(startedPath, forbiddenPath, delayText, watchedRootPid) {
  return spawn(
    process.execPath,
    [
      SELF_PATH,
      "intermediate",
      startedPath,
      forbiddenPath,
      delayText,
      String(watchedRootPid),
    ],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
}

async function runIntermediate(args) {
  const [startedPath, forbiddenPath, delayText, watchedRootText] = args;
  const delayMs = positiveInteger(delayText);
  const watchedRootPid = positiveInteger(watchedRootText);
  if (
    !absoluteFile(startedPath) ||
    !absoluteFile(forbiddenPath) ||
    delayMs === null ||
    watchedRootPid === null
  ) {
    fail();
  }
  const grandchild = spawn(
    process.execPath,
    [
      SELF_PATH,
      "grandchild",
      startedPath,
      forbiddenPath,
      String(delayMs),
      String(watchedRootPid),
    ],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  grandchild.unref();
  await waitForFile(startedPath, 30000);
}

async function runRoot(args) {
  const [startedPath, severedPath, forbiddenPath, rootIdentityPath, delayText] = args;
  const delayMs = positiveInteger(delayText);
  if (
    !absoluteFile(startedPath) ||
    !absoluteFile(severedPath) ||
    !absoluteFile(forbiddenPath) ||
    !absoluteFile(rootIdentityPath) ||
    delayMs === null
  ) {
    fail();
  }
  writeFileSync(
    rootIdentityPath,
    `${JSON.stringify({ pid: process.pid, processStartUtcMs: PROCESS_START_UTC_MS })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const intermediate = spawnIntermediate(
    startedPath,
    forbiddenPath,
    String(delayMs),
    process.ppid,
  );
  const intermediatePid = positiveInteger(intermediate.pid);
  if (intermediatePid === null) fail();
  const status = await new Promise((resolve, reject) => {
    intermediate.once("error", reject);
    intermediate.once("close", (code) => resolve(code));
  });
  if (status !== 0) fail();
  const grandchildIdentity = readProcessIdentity(startedPath);
  persistSeveranceProof(severedPath, intermediatePid, grandchildIdentity);
  await waitWithReferencedHandleUntilTerminated();
}

function runGrandchild(args) {
  const [startedPath, forbiddenPath, delayText, watchedRootText] = args;
  const delayMs = positiveInteger(delayText);
  const watchedRootPid = positiveInteger(watchedRootText);
  if (
    !absoluteFile(startedPath) ||
    !absoluteFile(forbiddenPath) ||
    delayMs === null ||
    watchedRootPid === null
  ) {
    fail();
  }

  writeFileSync(
    startedPath,
    `${JSON.stringify({ pid: process.pid, processStartUtcMs: PROCESS_START_UTC_MS })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  let forbiddenWritten = false;
  const writeForbidden = (reason, details = {}) => {
    if (forbiddenWritten) return;
    forbiddenWritten = true;
    writeOnce(
      forbiddenPath,
      `${JSON.stringify({
        pid: process.pid,
        processStartUtcMs: PROCESS_START_UTC_MS,
        wroteUtcMs: Date.now(),
        reason,
        ...details,
      })}\n`,
    );
  };
  setTimeout(() => writeForbidden("delay-expired"), delayMs);

  let rootGoneAt = null;
  let rootGoneProbeCode = null;
  setInterval(() => {
    const rootProbe = probeProcess(watchedRootPid);
    if (rootProbe.alive) {
      rootGoneAt = null;
      rootGoneProbeCode = null;
    } else if (rootGoneAt === null) {
      rootGoneAt = Date.now();
      rootGoneProbeCode = rootProbe.code;
    } else if (Date.now() - rootGoneAt >= ROOT_GONE_GRACE_MS) {
      writeForbidden("watched-root-absent", {
        watchedRootPid,
        rootGoneAtUtcMs: rootGoneAt,
        rootGoneProbeCode,
        finalProbeCode: rootProbe.code,
      });
    }
  }, 25);
}

const [role, ...roleArgs] = process.argv.slice(2);
if (role === "intermediate") await runIntermediate(roleArgs);
else if (role === "root") await runRoot(roleArgs);
else if (role === "grandchild") runGrandchild(roleArgs);
else fail();
