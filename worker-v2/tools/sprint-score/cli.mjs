#!/usr/bin/env node

import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCORE_SCHEMA_VERSION, SCORER_VERSION } from "./score.mjs";

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const RESULT_PROTOCOL = "sprint-score-child/1.0.0";
const CHILD_TIMEOUT_MS = 120_000;
const CLOSED_ERROR_CODES = new Set([
  "CLI_INPUT_ERROR",
  "SCORER_CHILD_ERROR",
  "SCORER_TIMEOUT",
  "INVALID_INPUT",
  "INVALID_ORACLE",
  "EMPTY_DENOMINATOR",
  "MISSING_RECORD",
  "INVALID_PROBE",
  "UNPROVEN_STAGE",
  "ORACLE_PROBE_FAILED",
  "INCONSISTENT_CLAIM_PIPELINE",
  "INTERNAL_ACCOUNTING_ERROR",
  "EMPTY_INPUT",
  "INVALID_SCORE",
]);
const STAGE_NAMES = [
  "eligible",
  "exactScreenReached",
  "uniquelyBound",
  "typedCaseEmitted",
  "decided",
  "strictClaimMatched",
];
const GAP_NAMES = ["eligibility", "coverage", "binding", "typedCaseEmission", "decision", "predicate", "detected"];

function usage() {
  return "usage: node worker-v2/tools/sprint-score/cli.mjs --records <run-records.json> --oracle <private-oracle.mjs> [--pretty]";
}

function parseArgs(argv) {
  const out = { records: null, oracle: null, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (arg !== "--records" && arg !== "--oracle") throw new Error(`unknown argument ${JSON.stringify(arg)}; ${usage()}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a path; ${usage()}`);
    const key = arg.slice(2);
    if (out[key] !== null) throw new Error(`${arg} may be supplied only once`);
    out[key] = argv[++i];
  }
  if (!out.records || !out.oracle) throw new Error(`both --records and --oracle are required; ${usage()}`);
  return out;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function normaliseRatio(value) {
  if (!object(value)) return null;
  const numerator = count(value.numerator);
  const denominator = count(value.denominator);
  if (numerator === null || denominator === null || numerator > denominator) return null;
  if (denominator === 0) {
    if (numerator !== 0 || value.rate !== null || value.status !== "no-denominator") return null;
    return { numerator, denominator, rate: null, status: "no-denominator" };
  }
  if (typeof value.rate !== "number" || !Number.isFinite(value.rate) || value.status !== "measured") return null;
  if (Math.abs(value.rate - numerator / denominator) > Number.EPSILON) return null;
  return { numerator, denominator, rate: value.rate, status: "measured" };
}

/**
 * Rebuild, do not forward, the child's aggregate. Even a compromised oracle can only make
 * this boundary emit the fixed vocabulary below plus non-negative counts and ratios.
 */
function normalisePublicSummary(value) {
  if (!object(value) || value.schemaVersion !== SCORE_SCHEMA_VERSION || value.scorerVersion !== SCORER_VERSION) {
    return null;
  }
  if (!object(value.scoreboards) || !object(value.stages) || !object(value.gaps) || !object(value.cleanControls)) {
    return null;
  }
  const endToEnd = normaliseRatio(value.scoreboards.endToEnd);
  const conditionalReached = normaliseRatio(value.scoreboards.conditionalReached);
  const conditionalReachedAndBound = normaliseRatio(value.scoreboards.conditionalReachedAndBound);
  if (!endToEnd || !conditionalReached || !conditionalReachedAndBound) return null;

  const stages = {};
  for (const name of STAGE_NAMES) {
    const row = value.stages[name];
    if (!object(row)) return null;
    const passed = count(row.passed);
    const failed = count(row.failed);
    const total = count(row.total);
    if (passed === null || failed === null || total === null || passed + failed !== total) return null;
    stages[name] = { passed, failed, total };
  }

  const gaps = {};
  for (const name of GAP_NAMES) {
    const valueCount = count(value.gaps[name]);
    if (valueCount === null) return null;
    gaps[name] = valueCount;
  }

  const controls = {};
  for (const name of ["total", "falsePositiveControls", "falsePositiveClaims", "cleanControls"]) {
    const valueCount = count(value.cleanControls[name]);
    if (valueCount === null) return null;
    controls[name] = valueCount;
  }
  if (controls.falsePositiveControls + controls.cleanControls !== controls.total) return null;

  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    scorerVersion: SCORER_VERSION,
    scoreboards: { endToEnd, conditionalReached, conditionalReachedAndBound },
    stages,
    gaps,
    cleanControls: controls,
  };
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function runIsolated(recordsPath, oraclePath) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [recordsPath, oraclePath], {
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    let packet = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CHILD_TIMEOUT_MS);
    timer.unref?.();

    child.on("message", (message) => {
      if (!object(message) || message.protocol !== RESULT_PROTOCOL || typeof message.ok !== "boolean") return;
      if (message.ok) {
        const summary = normalisePublicSummary(message.summary);
        if (summary) packet = { ok: true, summary };
        return;
      }
      const code = CLOSED_ERROR_CODES.has(message.code) ? message.code : "SCORER_CHILD_ERROR";
      packet = { ok: false, code };
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(codedError("SCORER_CHILD_ERROR"));
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) return reject(codedError("SCORER_TIMEOUT"));
      if (exitCode === 0 && packet?.ok) return resolve(packet.summary);
      return reject(codedError(packet?.ok === false ? packet.code : "SCORER_CHILD_ERROR"));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const recordsPath = path.resolve(args.records);
  const oraclePath = path.resolve(args.oracle);

  const summary = await runIsolated(recordsPath, oraclePath);
  process.stdout.write(`${JSON.stringify(summary, null, args.pretty ? 2 : 0)}\n`);
}

main().catch((error) => {
  // The module API preserves diagnostic detail for the independent holder. The aggregate
  // CLI is the boundary-safe surface: an oracle exception may contain a placement, so only
  // its closed error code is allowed to cross stdout/stderr.
  const code = CLOSED_ERROR_CODES.has(error?.code) ? error.code : "CLI_INPUT_ERROR";
  process.stderr.write(`sprint-score failed [${code}]\n`);
  process.exitCode = 1;
});
