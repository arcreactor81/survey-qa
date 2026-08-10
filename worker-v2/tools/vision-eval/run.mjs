#!/usr/bin/env node
import {
  evaluateSuite,
  loadEvaluatorProvenance,
  loadFixtures,
  loadPredictionRecords,
  DEFAULT_MANIFEST_PATH,
} from "./suite.mjs";

function usage() {
  return [
    "Usage:",
    "  node worker-v2/tools/vision-eval/run.mjs --predictions <records.json> [options]",
    "",
    "Options:",
    `  --manifest <path>         Public fixture manifest (default: ${DEFAULT_MANIFEST_PATH})`,
    "  --evaluator-provenance <path>  Separately obtained evaluator receipt manifest required for admission",
    "  --max-latency-ms <n>      Optional per-fixture latency ceiling",
    "  --max-cost-usd <n>        Optional per-fixture cost ceiling",
    "  --compact                  Emit compact JSON instead of indented JSON",
  ].join("\n");
}

function parseFiniteNonNegative(raw, flag) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a finite non-negative number`);
  return value;
}

function parseArguments(argv) {
  const args = { manifest: DEFAULT_MANIFEST_PATH, compact: false, policy: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--compact") {
      args.compact = true;
    } else if (flag === "--predictions") {
      args.predictions = argv[++index];
    } else if (flag === "--manifest") {
      args.manifest = argv[++index];
    } else if (flag === "--evaluator-provenance") {
      args.evaluatorProvenance = argv[++index];
    } else if (flag === "--max-latency-ms") {
      args.policy.maxLatencyMs = parseFiniteNonNegative(argv[++index], flag);
    } else if (flag === "--max-cost-usd") {
      args.policy.maxCostUsd = parseFiniteNonNegative(argv[++index], flag);
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.help && !args.predictions) throw new Error("--predictions is required");
  return args;
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  try {
    const [fixtures, records, evaluatorProvenance] = await Promise.all([
      loadFixtures(args.manifest),
      loadPredictionRecords(args.predictions),
      args.evaluatorProvenance ? loadEvaluatorProvenance(args.evaluatorProvenance) : Promise.resolve(null),
    ]);
    const report = await evaluateSuite(fixtures, records, args.policy, evaluatorProvenance);
    console.log(JSON.stringify(report, null, args.compact ? 0 : 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 2;
  }
}

await main();
