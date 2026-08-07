// harness.mjs — reusable mutation-testing harness for the P0 measuring
// apparatus (audit finding 11).
//
// WHAT IT DOES
//   1. Copies the parts of the tree the suites need into a scratch directory
//      (never mutates the working tree; node_modules is linked, not copied).
//   2. Applies ONE named mutation from the catalogue — a single exact-string
//      replacement expressing a small semantic change (flip a comparison,
//      weaken a floor, drop a guard, early-return, off-by-one, && -> ||).
//   3. Runs the target suites in the scratch tree.
//   4. Records the mutant as KILLED when at least one ENFORCING suite exits
//      non-zero, SURVIVED otherwise.
//   5. Restores the file and moves on.
//
// KILL CRITERION — deliberately conservative. A suite kills a mutant only when
// its PROCESS EXITS NON-ZERO, because that is the only signal CI acts on. A
// suite that prints a difference but exits 0 (scorer/integration is exactly
// this) is recorded as `detected` but NOT as a kill, and its kills are reported
// separately. Reporting a golden-output diff as a kill would inflate the number
// the audit is trying to make honest.
//
// DETERMINISM
//   - mutants run in catalogue order, one at a time, no concurrency;
//   - suites run with a pinned cwd, a scrubbed environment (TZ=UTC, LANG=C,
//     NO_COLOR=1) and no wall-clock injection beyond what the suites already do;
//   - the copy walks directory entries in sorted order;
//   - the report contains no timestamps or absolute paths.
//
// The harness itself is a test: `--verify` fails when the catalogue has drifted
// from the source (a `find` string that no longer occurs exactly once), so a
// gate that is renamed or deleted cannot silently drop out of the net.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // scorer/test/mutation
export const REPO = path.resolve(HERE, "..", "..", "..");

/** Suites the harness can run. `enforcing` = a non-zero exit is a real CI failure. */
export const SUITES = Object.freeze({
  selftest: {
    script: "scorer/test/selftest.mjs",
    enforcing: true,
    summaryRe: /^SELFTEST .*$/m,
  },
  "calibration-pins": {
    script: "scorer/test/calibration-pins.mjs",
    enforcing: true,
    summaryRe: /^CALIBRATION-PINS .*$/m,
  },
  "gate-coverage": {
    script: "scorer/test/gate-coverage.mjs",
    enforcing: true,
    summaryRe: /^GATE-COVERAGE .*$/m,
  },
  "oracle-selfcheck": {
    script: "scorer/oracle/selfcheck.mjs",
    enforcing: true,
    summaryRe: /^\d+ checks, \d+ failures$/m,
  },
  "oracle-records": {
    script: "scorer/oracle/validate-oracle-records.mjs",
    enforcing: true,
    summaryRe: /^\d+ records, .*$/m,
  },
  corpus: {
    script: "test-suite/branching/validate.mjs",
    enforcing: true,
    summaryRe: /^\d+ checks, \d+ failures$/m,
  },
  // NON-ENFORCING: verify-integration.mjs always exits 0 (see its last line),
  // so it can never fail CI. Kept in the harness because its RESULT line does
  // change, which is worth reporting — but never counted as a kill.
  integration: {
    script: "scorer/integration/verify-integration.mjs",
    enforcing: false,
    summaryRe: /^RESULT: .*$/m,
  },
});

export const DEFAULT_SUITES = [
  "selftest",
  "calibration-pins",
  "gate-coverage",
  "oracle-selfcheck",
  "oracle-records",
  "corpus",
];

/* ------------------------------ scratch tree ----------------------------- */

// Copied because the suites read them. test-suite/blind is deliberately absent:
// a blind-corpus workflow owns it and it must never be read.
const COPY_PATHS = ["scorer", "test-suite/branching", "package.json"];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".work"]);

function copyTree(src, dest) {
  const st = lstatSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src, { withFileTypes: true })
      .map((d) => d.name)
      .sort();
    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      copyTree(path.join(src, name), path.join(dest, name));
    }
  } else {
    cpSync(src, dest);
  }
}

export function defaultScratchRoot() {
  return (
    process.env.SURVEYQA_MUTATION_SCRATCH ??
    path.join(os.tmpdir(), "survey-qa-mutation")
  );
}

/** Build (or rebuild) the scratch copy. Returns the tree root. */
export function prepareScratch(scratchRoot) {
  const tree = path.join(scratchRoot, "tree");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  for (const rel of COPY_PATHS) {
    const src = path.join(REPO, rel);
    if (!existsSync(src)) throw new Error(`scratch copy source missing: ${rel}`);
    copyTree(src, path.join(tree, rel));
  }
  // node_modules is linked, not copied (138 MB). Junction on Windows needs no
  // privileges; a plain symlink is used elsewhere. Copy is the last resort.
  const link = path.join(tree, "node_modules");
  const target = path.join(REPO, "node_modules");
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    cpSync(target, link, { recursive: true });
  }
  return tree;
}

/* -------------------------------- catalogue ------------------------------ */

export async function loadCatalogue(cataloguePath = path.join(HERE, "mutants.mjs")) {
  const mod = await import(pathToFileURL(cataloguePath).href);
  const raw = { ...mod.default, mutants: [...mod.default.mutants] };
  const seen = new Set();
  for (const m of raw.mutants) {
    for (const k of ["id", "file", "find", "expectation", "rationale"]) {
      if (typeof m[k] !== "string" || m[k].length === 0) {
        throw new Error(`mutant ${m.id ?? "?"}: missing field "${k}"`);
      }
    }
    // `replace` may be the empty string: deleting a line IS a mutation.
    if (typeof m.replace !== "string") {
      throw new Error(`mutant ${m.id}: "replace" must be a string`);
    }
    if (m.find === m.replace) throw new Error(`mutant ${m.id}: find === replace (no-op)`);
    if (!["killed", "survives-by-design", "known-gap"].includes(m.expectation)) {
      throw new Error(
        `mutant ${m.id}: expectation must be "killed", "survives-by-design" or "known-gap"`
      );
    }
    if (seen.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
    seen.add(m.id);
  }
  raw.mutants.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return raw;
}

/**
 * Check every mutant's `find` string occurs EXACTLY ONCE in its target file.
 * This is what makes the catalogue a test of its own: a renamed or deleted gate
 * shows up here instead of silently ceasing to be measured.
 */
export function verifyCatalogue(catalogue, root = REPO) {
  const problems = [];
  for (const m of catalogue.mutants) {
    const abs = path.join(root, m.file);
    if (!existsSync(abs)) {
      problems.push(`${m.id}: target file ${m.file} does not exist`);
      continue;
    }
    const text = readFileSync(abs, "utf8");
    const n = countOccurrences(text, m.find);
    if (n !== 1) {
      problems.push(
        `${m.id}: find string occurs ${n} times in ${m.file} (must be exactly 1) -- catalogue has drifted from the source`
      );
    }
  }
  return problems;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) return n;
    n++;
    i = j + needle.length;
  }
}

/* --------------------------------- running -------------------------------- */

const CHILD_ENV = {
  ...process.env,
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
};

export function runSuite(tree, suiteName, timeoutMs = 180000) {
  const suite = SUITES[suiteName];
  if (!suite) throw new Error(`unknown suite ${suiteName}`);
  const res = spawnSync(process.execPath, [path.join(tree, suite.script)], {
    cwd: tree,
    env: CHILD_ENV,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const m = suite.summaryRe ? out.match(suite.summaryRe) : null;
  return {
    suite: suiteName,
    enforcing: suite.enforcing,
    exitCode: res.status === null ? -1 : res.status,
    timedOut: res.status === null,
    summary: m ? m[0].trim() : null,
  };
}

/** Baseline: every enforcing suite must be green on the unmutated scratch tree. */
export function runBaseline(tree, suiteNames) {
  const runs = suiteNames.map((s) => runSuite(tree, s));
  const broken = runs.filter((r) => r.enforcing && r.exitCode !== 0);
  return { runs, ok: broken.length === 0, broken };
}

export function applyMutant(tree, mutant) {
  const abs = path.join(tree, mutant.file);
  const original = readFileSync(abs, "utf8");
  const n = countOccurrences(original, mutant.find);
  if (n !== 1) {
    return { ok: false, reason: `find string occurs ${n} times (must be exactly 1)`, restore: () => {} };
  }
  writeFileSync(abs, original.replace(mutant.find, mutant.replace));
  return { ok: true, restore: () => writeFileSync(abs, original) };
}

/**
 * Run one mutant against `suiteNames`. Short-circuits on the first ENFORCING
 * kill unless `full` is set (full = complete per-suite attribution, slower).
 */
export function runMutant(tree, mutant, suiteNames, { full = false, baselineSummaries = {} } = {}) {
  const applied = applyMutant(tree, mutant);
  if (!applied.ok) {
    return { id: mutant.id, status: "error", reason: applied.reason, suites: [] };
  }
  const suiteResults = [];
  let killedBy = null;
  let detectedBy = [];
  try {
    for (const name of suiteNames) {
      const r = runSuite(tree, name);
      r.summaryChanged =
        baselineSummaries[name] !== undefined && r.summary !== baselineSummaries[name];
      suiteResults.push(r);
      if (r.enforcing && r.exitCode !== 0) {
        killedBy = killedBy ?? name;
        if (!full) break;
      } else if (!r.enforcing && r.summaryChanged) {
        detectedBy.push(name);
      }
    }
  } finally {
    applied.restore();
  }
  return {
    id: mutant.id,
    file: mutant.file,
    module: path.posix.join(...mutant.file.split(/[\\/]/)),
    gate: mutant.gate ?? null,
    expectation: mutant.expectation,
    status: killedBy ? "killed" : "survived",
    killedBy,
    detectedByNonEnforcing: detectedBy,
    suites: suiteResults.map((r) => ({
      suite: r.suite,
      exitCode: r.exitCode,
      enforcing: r.enforcing,
      summary: r.summary,
      summaryChanged: r.summaryChanged ?? false,
    })),
  };
}

export function summarize(results, catalogue) {
  const byId = new Map(catalogue.mutants.map((m) => [m.id, m]));
  const killed = results.filter((r) => r.status === "killed");
  const survived = results.filter((r) => r.status === "survived");
  const errored = results.filter((r) => r.status === "error");
  const scored = results.filter((r) => r.status !== "error");
  const perModule = {};
  for (const r of scored) {
    const key = r.module;
    perModule[key] = perModule[key] ?? { total: 0, killed: 0 };
    perModule[key].total++;
    if (r.status === "killed") perModule[key].killed++;
  }
  const unexpectedSurvivors = survived.filter((r) => byId.get(r.id)?.expectation === "killed");
  const unexpectedKills = killed.filter((r) => byId.get(r.id)?.expectation === "survives-by-design");
  const openGaps = survived.filter((r) => byId.get(r.id)?.expectation === "known-gap");
  const closedGaps = killed.filter((r) => byId.get(r.id)?.expectation === "known-gap");
  const equivalents = results.filter((r) => byId.get(r.id)?.expectation === "survives-by-design");
  // Headline rate over mutants that SHOULD be caught. Mutants documented as
  // equivalent (survives-by-design) are excluded from the denominator; open
  // known gaps are NOT — they still count against the net.
  const inScope = scored.filter((r) => byId.get(r.id)?.expectation !== "survives-by-design");
  const inScopeKilled = inScope.filter((r) => r.status === "killed");
  return {
    total: results.length,
    scored: scored.length,
    killed: killed.length,
    survived: survived.length,
    errored: errored.length,
    killRate: scored.length === 0 ? null : Number((killed.length / scored.length).toFixed(4)),
    inScopeMutants: inScope.length,
    inScopeKilled: inScopeKilled.length,
    inScopeKillRate: inScope.length === 0 ? null : Number((inScopeKilled.length / inScope.length).toFixed(4)),
    equivalentMutants: equivalents.length,
    perModule,
    unexpectedSurvivors: unexpectedSurvivors.map((r) => r.id).sort(),
    unexpectedKills: unexpectedKills.map((r) => r.id).sort(),
    openKnownGaps: openGaps.map((r) => r.id).sort(),
    closedKnownGaps: closedGaps.map((r) => r.id).sort(),
  };
}
