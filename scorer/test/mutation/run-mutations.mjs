#!/usr/bin/env node
// run-mutations.mjs — CLI for the mutation safety net (audit finding 11).
//
//   node scorer/test/mutation/run-mutations.mjs                 # full run
//   node scorer/test/mutation/run-mutations.mjs --verify        # catalogue only
//   node scorer/test/mutation/run-mutations.mjs --list
//   node scorer/test/mutation/run-mutations.mjs --only SRC-EV   # id prefix
//   node scorer/test/mutation/run-mutations.mjs --suite corpus  # repeatable
//   node scorer/test/mutation/run-mutations.mjs --full          # all suites per mutant
//   node scorer/test/mutation/run-mutations.mjs --out report.json
//
// Exit codes:
//   0  every mutant matched its declared expectation
//   1  at least one mutant with expectation "killed" survived, or a mutant
//      declared "survives-by-design" was killed, or the catalogue has drifted
//   2  the unmutated baseline is not green (nothing can be measured)
//
// Reproducible: mutants run in id order, one at a time, in a scratch copy.
// The report contains no timestamps and no absolute paths.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SUITES,
  SUITES,
  HERE,
  loadCatalogue,
  verifyCatalogue,
  prepareScratch,
  defaultScratchRoot,
  runBaseline,
  runMutant,
  summarize,
} from "./lib/harness.mjs";

function parseArgs(argv) {
  const opts = { suites: [], only: [], full: false, verify: false, list: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify") opts.verify = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--suite") opts.suites.push(argv[++i]);
    else if (a === "--only") opts.only.push(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--scratch") opts.scratch = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const catalogue = await loadCatalogue();

if (opts.list) {
  for (const m of catalogue.mutants) {
    console.log(`${m.id.padEnd(22)} ${m.file.padEnd(38)} ${m.gate ?? ""}`);
  }
  console.log(`\n${catalogue.mutants.length} mutants`);
  process.exit(0);
}

/* ---- catalogue drift check (always runs; it is the harness's own test) ---- */

const drift = verifyCatalogue(catalogue);
if (drift.length > 0) {
  console.error("CATALOGUE DRIFT — the tree no longer matches the mutant catalogue:");
  for (const d of drift) console.error("  - " + d);
  console.error(
    "\nA mutant whose target text has moved is measuring nothing. Update mutants.json\n" +
      "in the same commit as the source change."
  );
  process.exit(1);
}
console.log(`catalogue ok: ${catalogue.mutants.length} mutants, all find-strings unique in-tree`);
if (opts.verify) process.exit(0);

/* ------------------------------ selection -------------------------------- */

const selected = catalogue.mutants.filter(
  (m) => opts.only.length === 0 || opts.only.some((p) => m.id.startsWith(p))
);
if (selected.length === 0) {
  console.error(`no mutants match --only ${opts.only.join(",")}`);
  process.exit(1);
}
const suiteNames = opts.suites.length > 0 ? opts.suites : DEFAULT_SUITES;
for (const s of suiteNames) {
  if (!SUITES[s]) {
    console.error(`unknown suite ${s}; known: ${Object.keys(SUITES).join(", ")}`);
    process.exit(1);
  }
}

/* -------------------------------- baseline -------------------------------- */

const scratchRoot = opts.scratch ?? defaultScratchRoot();
console.log(`preparing scratch tree under ${path.basename(scratchRoot)}/tree ...`);
const tree = prepareScratch(scratchRoot);

console.log(`baseline: running ${suiteNames.join(", ")} unmutated ...`);
const baseline = runBaseline(tree, suiteNames);
for (const r of baseline.runs) {
  console.log(
    `  ${r.exitCode === 0 ? "GREEN" : "RED  "} ${r.suite.padEnd(18)} exit=${r.exitCode} ${r.summary ?? ""}` +
      (r.enforcing ? "" : "   [non-enforcing: always exits 0]")
  );
}
if (!baseline.ok) {
  console.error("\nBASELINE NOT GREEN — mutation results would be meaningless.");
  process.exit(2);
}
const baselineSummaries = Object.fromEntries(baseline.runs.map((r) => [r.suite, r.summary]));

/* --------------------------------- run ------------------------------------ */

const results = [];
for (const m of selected) {
  const r = runMutant(tree, m, suiteNames, { full: opts.full, baselineSummaries });
  results.push(r);
  const mark = r.status === "killed" ? "KILLED  " : r.status === "survived" ? "SURVIVED" : "ERROR   ";
  const extra =
    r.status === "killed"
      ? `by ${r.killedBy}`
      : r.status === "survived" && r.detectedByNonEnforcing.length
        ? `(detected but not enforced by ${r.detectedByNonEnforcing.join(", ")})`
        : r.status === "error"
          ? r.reason
          : "";
  console.log(`  ${mark} ${m.id.padEnd(22)} ${extra}`);
}

const summary = summarize(results, catalogue);

console.log("\n=== per-module kill rate ===");
for (const [mod, s] of Object.entries(summary.perModule).sort()) {
  console.log(`  ${mod.padEnd(44)} ${String(s.killed).padStart(2)}/${String(s.total).padEnd(2)}`);
}
console.log(
  `\nMUTATION ${JSON.stringify({
    mutants: summary.total,
    killed: summary.killed,
    survived: summary.survived,
    errored: summary.errored,
    killRate: summary.killRate,
    inScopeMutants: summary.inScopeMutants,
    inScopeKillRate: summary.inScopeKillRate,
    equivalentMutants: summary.equivalentMutants,
    openKnownGaps: summary.openKnownGaps.length,
  })}`
);

if (summary.openKnownGaps.length > 0) {
  console.log("\nOPEN KNOWN GAPS (real guards nothing kills yet; each says what it would take):");
  for (const id of summary.openKnownGaps) {
    const m = catalogue.mutants.find((x) => x.id === id);
    console.log(`  - ${id}  ${m.file}\n      gate: ${m.gate}\n      ${m.rationale}`);
  }
}
if (summary.closedKnownGaps.length > 0) {
  console.log(
    "\nKNOWN GAPS NOW CLOSED (retire them: change expectation to \"killed\"): " +
      summary.closedKnownGaps.join(", ")
  );
}

if (summary.unexpectedSurvivors.length > 0) {
  console.error("\nUNEXPECTED SURVIVORS (declared expectation: killed):");
  for (const id of summary.unexpectedSurvivors) {
    const m = catalogue.mutants.find((x) => x.id === id);
    console.error(`  - ${id}  ${m.file}  ${m.gate ?? ""}\n      ${m.rationale}`);
  }
}
if (summary.unexpectedKills.length > 0) {
  console.error("\nUNEXPECTED KILLS (declared expectation: survives-by-design):");
  for (const id of summary.unexpectedKills) console.error(`  - ${id}`);
}

const declaredSurvivors = catalogue.mutants.filter((m) => m.expectation === "survives-by-design");
if (declaredSurvivors.length > 0) {
  console.log("\nDECLARED SURVIVORS (behaviour genuinely does not matter; documented, not tested):");
  for (const m of declaredSurvivors) console.log(`  - ${m.id}: ${m.rationale}`);
}

if (opts.out) {
  const outPath = path.resolve(opts.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        catalogueVersion: catalogue.catalogueVersion,
        suites: suiteNames,
        baseline: baseline.runs.map(({ suite, exitCode, summary: s, enforcing }) => ({
          suite,
          exitCode,
          summary: s,
          enforcing,
        })),
        summary,
        results,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`\nreport written to ${opts.out}`);
}

process.exit(summary.unexpectedSurvivors.length + summary.unexpectedKills.length > 0 ? 1 : 0);
