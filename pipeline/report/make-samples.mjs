#!/usr/bin/env node
// Regenerates every sample in pipeline/report/samples/ from the REAL signed
// integration records, then regenerates the derived UI fixtures.
//
//   node make-samples.mjs
//
// The render timestamp is pinned so re-running produces byte-identical output.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const GENERATED_AT = "2026-08-01T22:30:00Z";

const run = (args) => execFileSync(process.execPath, args, { stdio: "inherit" });

for (const variant of ["clean", "flawed"]) {
  run([
    path.join(HERE, "render-report.mjs"),
    path.join(ROOT, "scorer", "integration", "runs", variant, "run-record.json"),
    path.join(ROOT, "scorer", "integration", "results", `${variant}-scorecard.json`),
    "-o",
    path.join(HERE, "samples", `${variant}-report.html`),
    "--artifacts-dir",
    path.join(ROOT, "scorer", "integration", "artifacts", `RUN-INT-S1-${variant.toUpperCase()}`),
    "--generated-at",
    GENERATED_AT,
  ]);
}

// A real record rendered with no scorecard and no artifacts directory, to prove
// the honest degraded states (no corpus appendix, evidence metadata only).
run([
  path.join(HERE, "render-report.mjs"),
  path.join(ROOT, "scorer", "integration", "runs", "flawed", "run-record.json"),
  "-o",
  path.join(HERE, "samples", "flawed-report-no-scorecard.html"),
  "--generated-at",
  GENERATED_AT,
]);

/* ------------------------------------------------------------------ *
 * The first real end-to-end run, rendered twice.
 *
 * BEFORE: the register built from the signed RunRecord alone — one run column,
 * the verdicts the run wrote about its own evidence.
 * AFTER: the same record plus the derived-verdict bundle — a second, separately
 * identified column, and the delta between them. The columns are never merged.
 * ------------------------------------------------------------------ */
const T1 = path.join(ROOT, "pipeline", "runs", "t1-easy");
const REPLAY = path.join(ROOT, "pipeline", "judge", "replay");

run([
  path.join(HERE, "render-report.mjs"),
  path.join(T1, "run-record.json"),
  "-o",
  path.join(HERE, "samples", "t1-easy-as-run.html"),
  "--artifacts-dir",
  path.join(T1, "artifacts"),
  "--generated-at",
  GENERATED_AT,
]);

run([
  path.join(HERE, "render-report.mjs"),
  path.join(T1, "run-record.json"),
  "-o",
  path.join(HERE, "samples", "t1-easy-register.html"),
  "--artifacts-dir",
  path.join(T1, "artifacts"),
  "--judgement",
  REPLAY,
  "--flag-lanes",
  path.join(HERE, "samples", "t1-easy.flag-lanes.json"),
  "--generated-at",
  GENERATED_AT,
]);

/* ------------------------------------------------------------------ *
 * THE ACCEPTANCE SAMPLE — the same real run, judged by the REAL judge
 * into a signed, fully bound JudgementRecord, rendered as CURRENT RESULTS.
 *
 * This is the sample the previous rounds could not produce. 
 * above renders the legacy replay bundle, which is correctly refused and shown
 * as an operational diagnostic; this one renders a record the report TRUSTS.
 * Nothing in it is hand-authored — see make-acceptance-artifact.mjs for the one
 * input change (sealing the frozen run contract) and why it is not a fixture.
 * ------------------------------------------------------------------ */
run([path.join(HERE, "make-acceptance-artifact.mjs")]);
run([
  path.join(HERE, "render-report.mjs"),
  path.join(HERE, "samples", "acceptance", "sealed.run-record.json"),
  "-o",
  path.join(HERE, "samples", "t1-easy-current-results.html"),
  "--artifacts-dir",
  path.join(T1, "artifacts"),
  "--judgement",
  path.join(HERE, "samples", "acceptance", "judgement-record.json"),
  "--flag-lanes",
  path.join(HERE, "samples", "t1-easy.flag-lanes.json"),
  "--generated-at",
  GENERATED_AT,
]);

run([path.join(HERE, "make-fixtures.mjs")]);
run([path.join(HERE, "check-contrast.mjs")]);
