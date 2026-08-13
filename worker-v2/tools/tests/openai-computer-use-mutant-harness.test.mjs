import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CUA_MUTATION_RESULT_SCHEMA,
  CUA_MUTATION_SELECTOR,
  closeCuaMutationReleaseResult,
  formatCuaMutationReleaseResult,
  judgeCuaMutant,
  parseContainedTapRun,
  parseTapRun,
  redBaselineSelfCheckPassed,
} from "../mutate-openai-computer-use.mjs";
import { WINDOWS_JOB_CONTAINMENT_SCOPE } from "../mutate-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_SOURCE = readFileSync(path.resolve(HERE, "../mutate-openai-computer-use.mjs"), "utf8");

function tap({ passed = [], failed = [], includeSummary = true, extra = "" } = {}) {
  const names = [...passed, ...failed];
  const results = names.map((name, index) => {
    const ok = index < passed.length;
    return `${ok ? "ok" : "not ok"} ${index + 1} - ${name}`;
  });
  const summary = includeSummary
    ? [
        `1..${names.length}`,
        `# tests ${names.length}`,
        "# suites 0",
        `# pass ${passed.length}`,
        `# fail ${failed.length}`,
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "# duration_ms 1",
      ]
    : [];
  return ["TAP version 13", ...results, ...summary, extra].filter(Boolean).join("\n");
}

test("CUA mutant harness credits only the exact named failure newly added to a completed baseline", () => {
  const baseline = parseTapRun(tap({ failed: ["already red"] }), 1);
  const exact = parseTapRun(tap({ failed: ["already red", "exact guard"] }), 1);
  const collateral = parseTapRun(tap({ failed: ["already red", "some other guard"] }), 1);

  assert.equal(baseline.completed, true);
  assert.equal(judgeCuaMutant(exact, baseline.failing, ["exact guard"]).killed, true);
  assert.deepEqual(judgeCuaMutant(exact, baseline.failing, ["exact guard"]).newFailures, ["exact guard"]);
  assert.deepEqual(judgeCuaMutant(collateral, baseline.failing, ["exact guard"]), {
    status: "SURVIVED",
    killed: false,
    newFailures: ["some other guard"],
    note: "the exact named guard did not newly fail: exact guard",
  });
});

test("CUA mutant harness rejects no-op credit over a deliberately red baseline", () => {
  const red = parseTapRun(tap({ failed: ["pre-existing failure"] }), 1);
  const sameRedAgain = parseTapRun(tap({ failed: ["pre-existing failure"] }), 1);
  assert.deepEqual(judgeCuaMutant(sameRedAgain, red.failing), {
    status: "SURVIVED",
    killed: false,
    newFailures: [],
    note: "no new failures",
  });
});

test("CUA mutant harness never credits an ambiguous or missing mutation anchor", () => {
  const rejected = parseTapRun(tap({ failed: ["exact guard"], extra: "Error: mutant patch matched 0 times" }), 1);
  assert.equal(rejected.completed, true);
  assert.equal(rejected.anchorRejected, true);
  assert.deepEqual(judgeCuaMutant(rejected, [], ["exact guard"]), {
    status: "BROKEN-ANCHOR",
    killed: false,
    newFailures: [],
    note: "the in-memory patch did not match exactly once; no mutation was executed",
  });
});

test("CUA mutant harness never credits a failure from a run without a completed summary", () => {
  const crashed = parseTapRun(tap({ failed: ["exact guard"], includeSummary: false }), 1);
  assert.equal(crashed.completed, false);
  assert.deepEqual(judgeCuaMutant(crashed, [], ["exact guard"]), {
    status: "NO-RUN",
    killed: false,
    newFailures: [],
    note: "node:test did not emit one coherent completed TAP summary",
  });
});

test("CUA mutant harness refuses contradictory or duplicated completion summaries", () => {
  const contradictory = tap({ passed: ["green"] }).replace("# pass 1", "# pass 0");
  const duplicated = `${tap({ passed: ["green"] })}\n# tests 1`;
  const crashedAfterSummary = tap({ failed: ["red"] });
  assert.equal(parseTapRun(contradictory, 0).completed, false);
  assert.equal(parseTapRun(duplicated, 0).completed, false);
  assert.equal(parseTapRun(crashedAfterSummary, 2).completed, false);
});

test("CUA red-baseline self-check requires a new nonempty failure and exact repeated set", () => {
  const baselineFailing = ["already red"];
  const red = parseTapRun(tap({ failed: ["already red", "exact guard"] }), 1);
  const repeated = parseTapRun(tap({ failed: ["already red", "exact guard"] }), 1);
  const verdict = judgeCuaMutant(repeated, red.failing);
  assert.equal(redBaselineSelfCheckPassed({ baselineFailing, red, repeated, repeatedVerdict: verdict }), true);

  const emptyRed = parseTapRun(tap({ passed: ["green"] }), 0);
  assert.equal(redBaselineSelfCheckPassed({
    baselineFailing: [],
    red: emptyRed,
    repeated: emptyRed,
    repeatedVerdict: judgeCuaMutant(emptyRed, []),
  }), false);

  const onlyPreExisting = parseTapRun(tap({ failed: ["already red"] }), 1);
  assert.equal(redBaselineSelfCheckPassed({
    baselineFailing,
    red: onlyPreExisting,
    repeated: onlyPreExisting,
    repeatedVerdict: judgeCuaMutant(onlyPreExisting, onlyPreExisting.failing),
  }), false);

  const changed = parseTapRun(tap({ failed: ["already red", "different guard"] }), 1);
  assert.equal(redBaselineSelfCheckPassed({
    baselineFailing,
    red,
    repeated: changed,
    repeatedVerdict: judgeCuaMutant(changed, red.failing),
  }), false);
});

test("CUA release result is closed over the custom one-mutant selector and two proved self-checks", () => {
  const candidate = {
    schema: CUA_MUTATION_RESULT_SCHEMA,
    selector: CUA_MUTATION_SELECTOR,
    denominator: 1,
    mutantsTotal: 1,
    mutantsKilled: 1,
    selfChecksPassed: 2,
  };
  assert.deepEqual(closeCuaMutationReleaseResult(candidate), candidate);
  assert.equal(
    formatCuaMutationReleaseResult(candidate),
    `MUTATION_RESULT ${JSON.stringify(candidate)}`,
  );
  for (const mutation of [
    { ...candidate, selector: "exact-union-of-declared-kills" },
    { ...candidate, denominator: 0 },
    { ...candidate, mutantsTotal: 0 },
    { ...candidate, mutantsKilled: 0 },
    { ...candidate, selfChecksPassed: 1 },
    { ...candidate, passed: true },
  ]) {
    assert.throws(() => closeCuaMutationReleaseResult(mutation), TypeError);
  }
});

test("CUA mutation children use only the shared contained-node supervisor primitive", () => {
  assert.match(HARNESS_SOURCE, /\brunContainedNodeSubject,\s*[\s\S]*?from "\.\/mutate-runner\.mjs";/u);
  assert.match(HARNESS_SOURCE, /await runContainedNodeSubject\(\{/u);
  assert.doesNotMatch(HARNESS_SOURCE, /node:child_process|\bspawnSync\b|\bspawn\s*\(/u);
});

test("CUA TAP scoring is inseparable from a completed zero-process Job receipt", () => {
  const stdout = tap({ passed: ["green"] });
  const contained = {
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: null,
    timedOut: false,
    completed: true,
    supervisorStatus: 0,
    finalActiveProcesses: 0,
    containmentScope: WINDOWS_JOB_CONTAINMENT_SCOPE,
  };
  assert.equal(parseContainedTapRun(contained).completed, true);
  for (const mutation of [
    { ...contained, completed: false },
    { ...contained, error: new Error("synthetic") },
    { ...contained, signal: "SIGTERM" },
    { ...contained, timedOut: true },
    { ...contained, supervisorStatus: 1 },
    { ...contained, finalActiveProcesses: 1 },
    { ...contained, containmentScope: "uncontained" },
  ]) {
    const result = parseContainedTapRun(mutation);
    assert.equal(result.containmentCompleted, false);
    assert.equal(result.completed, false);
  }
});
