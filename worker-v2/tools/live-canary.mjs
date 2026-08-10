#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  DEFAULT_ACCESS_ENV_FILE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  collectLiveCanary,
  executeLiveCanary,
  LiveCanaryError,
  probeLiveCanary,
} from "./live-canary-core.mjs";
import { CANARY_VISUAL_PROVIDERS } from "./generate-live-canary-config.mjs";

export function parseArguments(argv) {
  const result = {
    mode: null,
    baseUrl: null,
    envFile: null,
    canaryTokenFile: null,
    runId: null,
    surveyUrl: null,
    docx: null,
    outputDir: null,
    expectVisual: "either",
    expectedVisualProvider: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    help: false,
  };
  const valueFlags = new Set([
    "--base-url",
    "--env-file",
    "--canary-token-file",
    "--run-id",
    "--survey-url",
    "--docx",
    "--output-dir",
    "--expect-visual",
    "--expected-visual-provider",
    "--poll-interval-ms",
    "--poll-timeout-ms",
    "--request-timeout-ms",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      continue;
    }
    if (flag === "--probe-only" || flag === "--execute" || flag === "--collect") {
      if (result.mode !== null) throw new LiveCanaryError("ARGUMENT_CONFLICT", "choose exactly one of --probe-only, --execute, or --collect");
      result.mode = flag === "--probe-only" ? "probe-only" : flag === "--execute" ? "execute" : "collect";
      continue;
    }
    // Do not interpolate an unknown argv value into the error: it may itself be a secret a
    // caller mistakenly tried to pass. Credential values are never valid CLI arguments.
    if (!valueFlags.has(flag)) throw new LiveCanaryError("ARGUMENT_UNKNOWN", `unknown argument at position ${index + 1}`);
    if (seen.has(flag)) throw new LiveCanaryError("ARGUMENT_DUPLICATE", `${flag} may be supplied only once`);
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new LiveCanaryError("ARGUMENT_MISSING", `${flag} requires a value`);
    index += 1;
    if (flag === "--base-url") result.baseUrl = value;
    if (flag === "--env-file") result.envFile = value;
    if (flag === "--canary-token-file") result.canaryTokenFile = value;
    if (flag === "--run-id") result.runId = value;
    if (flag === "--survey-url") result.surveyUrl = value;
    if (flag === "--docx") result.docx = value;
    if (flag === "--output-dir") result.outputDir = value;
    if (flag === "--expect-visual") result.expectVisual = value;
    if (flag === "--expected-visual-provider") result.expectedVisualProvider = value;
    if (flag === "--poll-interval-ms") result.pollIntervalMs = decimalInteger(value, flag);
    if (flag === "--poll-timeout-ms") result.pollTimeoutMs = decimalInteger(value, flag);
    if (flag === "--request-timeout-ms") result.requestTimeoutMs = decimalInteger(value, flag);
  }
  if (result.help) return result;
  if (result.mode === null) throw new LiveCanaryError("ARGUMENT_MISSING", "choose exactly one of --probe-only, --execute, or --collect");
  if (result.baseUrl === null) throw new LiveCanaryError("ARGUMENT_MISSING", "--base-url is required");
  if (
    result.expectedVisualProvider !== null &&
    !CANARY_VISUAL_PROVIDERS.includes(result.expectedVisualProvider)
  ) {
    throw new LiveCanaryError(
      "ARGUMENT_INVALID",
      `--expected-visual-provider must be one of ${CANARY_VISUAL_PROVIDERS.join(", ")}`,
    );
  }
  if (result.envFile !== null && result.canaryTokenFile !== null) {
    throw new LiveCanaryError("AUTH_MODE_CONFLICT", "choose either --env-file or --canary-token-file, not both");
  }
  if (result.mode === "execute") {
    for (const [flag, value] of [
      ["--survey-url", result.surveyUrl],
      ["--docx", result.docx],
      ["--output-dir", result.outputDir],
    ]) {
      if (value === null) throw new LiveCanaryError("ARGUMENT_MISSING", `${flag} is required with --execute`);
    }
    if (result.runId !== null) throw new LiveCanaryError("ARGUMENT_CONFLICT", "--run-id is valid only with --collect");
  }
  if (result.mode === "collect") {
    for (const [flag, value] of [
      ["--run-id", result.runId],
      ["--output-dir", result.outputDir],
    ]) {
      if (value === null) throw new LiveCanaryError("ARGUMENT_MISSING", `${flag} is required with --collect`);
    }
    if (result.envFile === null && result.canaryTokenFile === null) {
      throw new LiveCanaryError("ARGUMENT_MISSING", "--collect requires exactly one of --env-file or --canary-token-file");
    }
    if (result.surveyUrl !== null || result.docx !== null) {
      throw new LiveCanaryError("ARGUMENT_CONFLICT", "--collect does not accept survey or document submission input");
    }
  }
  if (result.mode === "probe-only" && result.runId !== null) {
    throw new LiveCanaryError("ARGUMENT_CONFLICT", "--run-id is valid only with --collect");
  }
  if (result.mode !== "probe-only" && result.expectVisual === "enabled") {
    if (result.expectedVisualProvider === null) {
      throw new LiveCanaryError(
        "ARGUMENT_MISSING",
        "--expected-visual-provider is required when --expect-visual is enabled",
      );
    }
  } else if (result.mode !== "probe-only" && result.expectedVisualProvider !== null) {
    throw new LiveCanaryError(
      "ARGUMENT_CONFLICT",
      "--expected-visual-provider is valid only when --expect-visual is enabled",
    );
  }
  return result;
}

export async function runCli(argv, dependencies = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) return { exitCode: 0, stdout: usage(), stderr: "" };
    const summary = options.mode === "probe-only"
      ? await probeLiveCanary(options, dependencies)
      : options.mode === "collect"
        ? await collectLiveCanary(options, dependencies)
        : await executeLiveCanary(options, dependencies);
    return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: "" };
  } catch (error) {
    const code = error instanceof LiveCanaryError ? error.code : "CANARY_FAILED";
    const message = error instanceof Error ? error.message : "canary operation failed";
    return { exitCode: 1, stdout: "", stderr: `live canary refused [${code}]: ${message}\n` };
  }
}

export function usage() {
  return [
    "Usage:",
    `  node tools/live-canary.mjs --probe-only --base-url <origin> [--env-file ${DEFAULT_ACCESS_ENV_FILE}]`,
    "  node tools/live-canary.mjs --probe-only --base-url <origin> --canary-token-file <path>",
    "  node tools/live-canary.mjs --execute --base-url <origin> (--env-file <path> | --canary-token-file <path>) --survey-url <https-url> --docx <questionnaire.docx> --output-dir <empty-dir> [options]",
    "  node tools/live-canary.mjs --collect --run-id <v2-run-id> --base-url <origin> (--env-file <path> | --canary-token-file <path>) --output-dir <empty-dir> [options]",
    "",
    "Authentication is loaded only from a file inside this Node process:",
    "  --env-file expects CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.",
    "  --canary-token-file sends its opaque value as X-Survey-QA-Canary-Token.",
    "  If neither is supplied, the gitignored worker-v2/.dev.vars Access file is used.",
    "  Credential values are not accepted in argv and are never printed.",
    "",
    "Execution options:",
    "  --expect-visual enabled|disabled|either",
    `  --expected-visual-provider ${CANARY_VISUAL_PROVIDERS.join("|")} (required when visual is enabled)`,
    `  --poll-interval-ms N   default ${DEFAULT_POLL_INTERVAL_MS}`,
    `  --poll-timeout-ms N    default ${DEFAULT_POLL_TIMEOUT_MS}`,
    `  --request-timeout-ms N default ${DEFAULT_REQUEST_TIMEOUT_MS} (${DEFAULT_REQUEST_TIMEOUT_MS / 1_000} s per HTTP request)`,
    "",
    "--execute submits one paid pipeline run. Probe mode only calls GET /api/v2/health.",
    "--collect is GET-only recovery for an existing run; it cannot submit, resubmit, or call a model.",
    "The output directory must be empty and is never overwritten.",
    "",
  ].join("\n");
}

function decimalInteger(value, flag) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new LiveCanaryError("ARGUMENT_INVALID", `${flag} must be a positive base-10 integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new LiveCanaryError("ARGUMENT_INVALID", `${flag} is outside the safe integer range`);
  return parsed;
}

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
