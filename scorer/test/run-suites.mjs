#!/usr/bin/env node
// run-suites.mjs — run every scorer-side test suite in one command.
//
//   node scorer/test/run-suites.mjs
//
// Suites, in order:
//   selftest.mjs          the 25 adversarial fixtures + conformance vectors
//   calibration-pins.mjs  frozen profile objects + threshold boundary fixtures
//   gate-coverage.mjs     one negative case per gate the mutation net exposed
//
// Exits non-zero if any suite fails. The mutation harness
// (scorer/test/mutation/) runs the same three plus the ground-truth and corpus
// suites; this script is the plain "did I break the scorer" entry point.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ["selftest.mjs", "calibration-pins.mjs", "gate-coverage.mjs"];

let failed = 0;
const lines = [];
for (const suite of SUITES) {
  const res = spawnSync(process.execPath, [path.join(HERE, suite)], { encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(out);
  const summary = out.split("\n").filter((l) => /^(SELFTEST|CALIBRATION-PINS|GATE-COVERAGE) /.test(l))[0] ?? "(no summary)";
  if (res.status !== 0) failed++;
  lines.push(`  ${res.status === 0 ? "PASS" : "FAIL"}  ${suite.padEnd(22)} ${summary}`);
}

console.log("\n=== scorer suites ===");
for (const l of lines) console.log(l);
if (failed > 0) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log("\nALL SCORER SUITES PASSED");
