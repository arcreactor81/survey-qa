#!/usr/bin/env node
/**
 * tools/replay.mjs — drive a replay of the judging tail against a scratch worker.
 *
 *   node tools/replay.mjs --source-run <id> --replay-run <id> [--worker-url <url>] [--token <token>]
 *
 * Drives each stage of the judging tail in sequence via HTTP POST to the replay
 * scratch worker, printing a stage-by-stage outcome table. The worker must be
 * deployed with `wrangler deploy --config wrangler.replay.jsonc`.
 *
 * Environment variables:
 *   REPLAY_WORKER_URL  — base URL of the deployed replay worker (or --worker-url)
 *   REPLAY_TOKEN       — bearer token for auth (or --token)
 */

import { parseArgs } from "node:util";
import { ALL_STAGES, driveStage } from "./replay-driver.mjs";

const { values } = parseArgs({
  options: {
    "source-run": { type: "string" },
    "replay-run": { type: "string" },
    "worker-url": { type: "string" },
    token: { type: "string" },
    // Comma-separated subset of stages to run, in the canonical order (e.g.
    // "seed,project-observations" or "mint-judgement,supersede-record,report").
    // A full tail is ~12 minutes, which straddles this environment's background-task
    // kill ceiling; chunking keeps each invocation inside a foreground timeout.
    stages: { type: "string" },
  },
  strict: true,
});

const sourceRunId = values["source-run"];
const replayRunId = values["replay-run"];
const workerUrl = values["worker-url"] || process.env.REPLAY_WORKER_URL;
const token = values.token || process.env.REPLAY_TOKEN;

if (!sourceRunId || !replayRunId) {
  console.error("Usage: node tools/replay.mjs --source-run <id> --replay-run <id>");
  console.error("  --worker-url <url>  or  REPLAY_WORKER_URL env var");
  console.error("  --token <token>     or  REPLAY_TOKEN env var");
  process.exit(1);
}

if (replayRunId === sourceRunId) {
  console.error("ERROR: --replay-run must differ from --source-run");
  process.exit(1);
}

if (!workerUrl) {
  console.error("ERROR: no worker URL. Set REPLAY_WORKER_URL or pass --worker-url");
  process.exit(1);
}

if (!token) {
  console.error("ERROR: no token. Set REPLAY_TOKEN or pass --token");
  process.exit(1);
}

let STAGES = ALL_STAGES;
if (values.stages) {
  const requested = values.stages.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((s) => !ALL_STAGES.includes(s));
  if (unknown.length > 0) {
    console.error(`ERROR: unknown stage(s): ${unknown.join(", ")}`);
    console.error(`Valid stages: ${ALL_STAGES.join(", ")}`);
    process.exit(1);
  }
  // Preserve canonical order regardless of how the subset was written.
  STAGES = ALL_STAGES.filter((s) => requested.includes(s));
}

const results = [];
let anyError = false;

console.log(`\n=== REPLAY: ${sourceRunId} -> ${replayRunId} ===\n`);
console.log(`Worker: ${workerUrl}`);
console.log(`Stages: ${STAGES.length}\n`);

for (const stage of STAGES) {
  process.stdout.write(`  ${stage.padEnd(28)} `);

  {
    // The wire call lives in replay-driver.mjs, shared with gate-loop.mjs — one
    // driver, one timeout policy, so the two tools cannot drift apart.
    const driven = await driveStage({ workerUrl, token, sourceRunId, replayRunId, stage });
    const { durationMs } = driven;
    const body = driven.body ?? {};
    const durationStr = `${(durationMs / 1000).toFixed(1)}s`;

    if (driven.result === "ok") {
      console.log(`OK    ${durationStr}`);
      results.push({
        stage,
        result: "ok",
        durationMs,
        detail: body.detail ?? null,
      });

      // Print extra detail for key stages.
      if (stage === "mint-judgement" && body.detail?.value) {
        const v = body.detail.value;
        console.log(`    authority: verified=${v.authority?.verified} manifest=${v.authority?.manifestComplete}`);
        console.log(`    attested=${v.attested} artifacts=${v.artifacts} supersededRecordings=${v.supersededRecordings}`);
        console.log(`    status=${v.status}`);
      }
      if (stage === "verify-observations" && body.detail?.value) {
        const v = body.detail.value;
        console.log(`    observations=${v.observations} verified=${v.verified} contradicted=${v.contradicted} insufficient=${v.insufficient}`);
      }
      if (stage === "report" && body.detail) {
        const d = body.detail;
        if (d.ok) {
          console.log(`    report built: ${d.summary?.buildId ?? "?"}, bytes=${d.bytes ?? "?"}`);
          console.log(`    hasCurrentResults=${d.summary?.hasCurrentResults ?? "?"}`);
        } else {
          console.log(`    report NOT built: ${d.reasonCode ?? "unknown"}`);
        }
      }
    } else if (driven.result === "error") {
      const reason = driven.errorMessage ?? "unknown error";
      console.log(`FAIL  ${durationStr}  ${reason.slice(0, 120)}`);
      results.push({
        stage,
        result: "error",
        durationMs,
        errorName: body.errorName ?? null,
        errorMessage: reason,
      });
      anyError = true;
    } else {
      const msg = driven.errorMessage ?? "unknown crash";
      console.log(`CRASH ${durationStr}  ${msg.slice(0, 120)}`);
      results.push({
        stage,
        result: "crash",
        durationMs,
        errorMessage: msg,
      });
      anyError = true;
    }
  }
}

// Summary table.
console.log("\n=== SUMMARY ===\n");
console.log("Stage".padEnd(28) + "Result".padEnd(8) + "Duration");
console.log("-".repeat(50));
for (const r of results) {
  const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
  const status = r.result === "ok" ? "OK" : r.result === "error" ? "FAIL" : "CRASH";
  console.log(`${r.stage.padEnd(28)}${status.padEnd(8)}${dur}`);
}

// Machine-readable JSON summary.
const summary = {
  sourceRunId,
  replayRunId,
  timestamp: new Date().toISOString(),
  stages: results,
  allPassed: !anyError,
};
console.log("\n=== JSON SUMMARY ===\n");
console.log(JSON.stringify(summary, null, 2));

process.exit(anyError ? 1 : 0);
