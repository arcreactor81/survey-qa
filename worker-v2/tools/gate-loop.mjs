#!/usr/bin/env node
/**
 * tools/gate-loop.mjs — one gate attempt, one artifact, one diff.
 *
 *   node tools/gate-loop.mjs --source-run <id> --replay-run <id> \
 *     [--worker-url <url>] [--token <token>] [--attempt-dir <dir>]
 *
 * THE LOOP DOCTRINE THIS IMPLEMENTS (owner, 23 Aug 2026): the bench harness is
 * the verdict, and every attempt must leave ONE machine-readable report that the
 * next attempt is diffed against — replacing per-attempt log archaeology
 * (chunk logs, wrangler tail, R2 spelunking) with a single artifact.
 *
 * What it does:
 *   1. Drives every tail stage in order over HTTP (each stage call is bounded
 *      by the same 10-minute ceiling prod Workflow steps get).
 *   2. Extracts the facts that decide the gate: verify counts, record hash and
 *      signature, the judge's authority flags AND its named findings (grouped
 *      by code), judgement status, report bytes and hasCurrentResults.
 *   3. Writes <attempt-dir>/<replay-run>.json and diffs it against the most
 *      recent previous attempt in that directory.
 *   4. Exits 0 ONLY when the gate criteria hold: every stage ok, judgement
 *      attested, report built with current results. Anything less is exit 1 —
 *      this harness must be able to fail.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_STAGES, driveStage } from "./replay-driver.mjs";

const { values } = parseArgs({
  options: {
    "source-run": { type: "string" },
    "replay-run": { type: "string" },
    "worker-url": { type: "string" },
    token: { type: "string" },
    "attempt-dir": { type: "string" },
  },
  strict: true,
});

const sourceRunId = values["source-run"];
const replayRunId = values["replay-run"];
const workerUrl = values["worker-url"] || process.env.REPLAY_WORKER_URL;
const token = values.token || process.env.REPLAY_TOKEN;
const attemptDir = values["attempt-dir"] || "../.local-private/gate-attempts";

if (!sourceRunId || !replayRunId || !workerUrl || !token) {
  console.error("usage: gate-loop.mjs --source-run <id> --replay-run <id> --worker-url <url> --token <t>");
  process.exit(1);
}
if (replayRunId === sourceRunId) {
  console.error("ERROR: --replay-run must differ from --source-run");
  process.exit(1);
}

/** Pull the gate-deciding facts out of a stage's response body. */
function extractFacts(stage, body) {
  const v = body?.detail?.value ?? body?.detail ?? null;
  if (!v) return null;
  switch (stage) {
    case "verify-observations":
      return { observations: v.observations, verified: v.verified, contradicted: v.contradicted, insufficient: v.insufficient };
    case "assemble-record":
      return { recordHash: v.recordHash, signed: v.signed, evidence: v.evidence, revision: v.revision };
    case "mint-judgement": {
      const findingsByCode = {};
      for (const f of v.authority?.findings ?? []) {
        findingsByCode[f.code] = (findingsByCode[f.code] ?? 0) + 1;
      }
      return {
        status: v.status,
        attested: v.attested,
        authority: {
          verified: v.authority?.verified,
          signatureVerified: v.authority?.signatureVerified,
          contractBound: v.authority?.contractBound,
          manifestComplete: v.authority?.manifestComplete,
          checklistBound: v.authority?.checklistBound,
        },
        findingsByCode,
        findingSamples: (v.authority?.findings ?? []).slice(0, 3).map((f) => `${f.code}: ${String(f.detail).slice(0, 140)}`),
        checklistSource: v.checklistSource,
        artifacts: v.artifacts,
        duplicatesCollapsed: v.duplicatesCollapsed,
        supersededRecordings: v.supersededRecordings,
        byVerdict: v.counts?.byVerdict ?? null,
      };
    }
    case "report":
      return {
        built: v.ok ?? null,
        bytes: v.bytes ?? null,
        buildId: v.summary?.buildId ?? null,
        hasCurrentResults: v.summary?.hasCurrentResults ?? null,
        attestation: v.summary?.attestation ?? null,
        judgementState: v.summary?.judgementState ?? null,
      };
    default:
      return null;
  }
}

const attempt = {
  sourceRunId,
  replayRunId,
  startedAt: new Date().toISOString(),
  stages: {},
  gate: { pass: false, reasons: [] },
};

console.log(`\n=== GATE ATTEMPT: ${sourceRunId} -> ${replayRunId} ===\n`);

for (const stage of ALL_STAGES) {
  process.stdout.write(`  ${stage.padEnd(28)}`);
  const r = await driveStage({ workerUrl, token, sourceRunId, replayRunId, stage });
  const facts = r.result === "ok" ? extractFacts(stage, r.body) : null;
  attempt.stages[stage] = {
    result: r.result,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage ?? null,
    facts,
  };
  console.log(`${r.result.toUpperCase().padEnd(6)} ${(r.durationMs / 1000).toFixed(1)}s${r.errorMessage ? `  ${r.errorMessage.slice(0, 100)}` : ""}`);
  if (facts) {
    for (const [k, val] of Object.entries(facts)) {
      if (val !== null && typeof val === "object") console.log(`      ${k}: ${JSON.stringify(val)}`);
      else if (val !== null) console.log(`      ${k}: ${val}`);
    }
  }
}

// THE GATE CRITERIA — Gate A's own words: an ATTESTED judgement and a
// results-bearing report. Every stage green is necessary but not sufficient.
const failures = Object.entries(attempt.stages).filter(([, s]) => s.result !== "ok");
if (failures.length > 0) attempt.gate.reasons.push(`stage failures: ${failures.map(([n]) => n).join(", ")}`);
const mint = attempt.stages["mint-judgement"]?.facts;
if (!mint?.attested) attempt.gate.reasons.push(`judgement not attested (status=${mint?.status ?? "unknown"})`);
const rep = attempt.stages["report"]?.facts;
if (rep?.hasCurrentResults !== true) attempt.gate.reasons.push("report has no current results");
attempt.gate.pass = attempt.gate.reasons.length === 0;
attempt.finishedAt = new Date().toISOString();

// One artifact per attempt, plus a diff against the previous one.
mkdirSync(attemptDir, { recursive: true });
const outPath = join(attemptDir, `${replayRunId}.json`);
let previous = null;
try {
  const others = readdirSync(attemptDir)
    .filter((f) => f.endsWith(".json") && f !== `${replayRunId}.json`)
    .map((f) => ({ f, m: statSync(join(attemptDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (others.length > 0) previous = { name: others[0].f, data: JSON.parse(readFileSync(join(attemptDir, others[0].f), "utf8")) };
} catch { /* first attempt in a fresh directory */ }
writeFileSync(outPath, JSON.stringify(attempt, null, 2));

console.log(`\n=== GATE: ${attempt.gate.pass ? "PASS" : "FAIL"} ===`);
for (const reason of attempt.gate.reasons) console.log(`  - ${reason}`);
console.log(`\nattempt report: ${outPath}`);

if (previous) {
  console.log(`\n=== DIFF vs ${previous.name} ===`);
  for (const stage of ALL_STAGES) {
    const now = attempt.stages[stage];
    const then = previous.data.stages?.[stage];
    if (!then) continue;
    if (now.result !== then.result) console.log(`  ${stage}: ${then.result} -> ${now.result}`);
    const nowFacts = JSON.stringify(now.facts ?? null);
    const thenFacts = JSON.stringify(then.facts ?? null);
    if (nowFacts !== thenFacts && (now.facts || then.facts)) {
      console.log(`  ${stage} facts changed:`);
      console.log(`    was: ${thenFacts?.slice(0, 300)}`);
      console.log(`    now: ${nowFacts?.slice(0, 300)}`);
    }
  }
}

process.exit(attempt.gate.pass ? 0 : 1);
