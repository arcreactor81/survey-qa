#!/usr/bin/env node

import { executeLiveBakeoff } from "./live-bakeoff-core.mjs";
import { LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS, LIVE_BAKEOFF_DEFAULT_MAX_CALLS } from "./live-contract.mjs";

const SAFE_STOPS = new Set([
  "planned-calls-complete",
  "precall-cost-reservation-exceeds-ceiling",
  "cost-ceiling-reached",
]);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const summary = await executeLiveBakeoff(options);
    process.stdout.write(`${JSON.stringify({
      runId: summary.runId,
      stoppedReason: summary.stoppedReason,
      claimedAttemptCount: summary.claimedAttemptCount,
      completedResultCount: summary.completedResultCount,
      recordedPredictionCount: summary.recordedPredictionCount,
      knownCostUsd: summary.knownCostUsd,
      globalCostCeilingUsd: summary.globalCostCeilingUsd,
      outputFiles: summary.outputFiles,
    }, null, 2)}\n`);
    if (!SAFE_STOPS.has(summary.stoppedReason)) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown local bake-off error";
  process.stderr.write(`live bake-off refused: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const result = { endpoint: null, outputDir: null, maxCalls: LIVE_BAKEOFF_DEFAULT_MAX_CALLS, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      continue;
    }
    if (!["--endpoint", "--output-dir", "--max-calls"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--endpoint") result.endpoint = value;
    if (flag === "--output-dir") result.outputDir = value;
    if (flag === "--max-calls") {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--max-calls must be a positive integer");
      result.maxCalls = Number(value);
    }
  }
  if (!result.help && result.endpoint === null) throw new Error("--endpoint is required");
  if (!result.help && result.outputDir === null) throw new Error("--output-dir is required");
  return result;
}

function usage() {
  return [
    "Usage:",
    "  node tools/vision-eval/live-bakeoff.mjs --endpoint http://127.0.0.1:8788/invoke --output-dir <empty-directory> [--max-calls N]",
    "",
    `N defaults to ${LIVE_BAKEOFF_DEFAULT_MAX_CALLS} and may not exceed ${LIVE_BAKEOFF_ABSOLUTE_MAX_CALLS}.`,
    "Use all 6 calls for the complete three-fixture × two-model matrix; the $0.05 pre-call ceiling may stop earlier explicitly.",
    "This client accepts only a credential-free loopback HTTP endpoint.",
    "",
  ].join("\n");
}
