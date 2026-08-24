#!/usr/bin/env node
/**
 * Fail-capable semantic mutant for the quarantined CUA adapter.
 *
 * This suite is intentionally outside tools/test.mjs, so it cannot use runMutantSuite directly.
 * Its local verdict therefore carries the same invariants: exact unmutated baseline, exact named
 * NEW failure, refused anchors and incomplete runs never credited, plus no-op and deliberately
 * red-baseline self-checks. It runs only dedicated local node:test files, never network I/O, and
 * the CUA test's esbuild hook applies every source patch in memory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runContainedNodeSubject,
  WINDOWS_JOB_CONTAINMENT_SCOPE,
} from "./mutate-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TEST = "tools/tests/openai-computer-use.test.mjs";
const HARNESS_TEST = "tools/tests/openai-computer-use-mutant-harness.test.mjs";
const FILE = "src/browser/openai-computer-use.ts";
const FIND = 'if (response.model !== model) throw new ComputerUseProtocolError("Responses API response model identity does not match the requested model");';
const REPLACE = 'if (false && response.model !== model) throw new ComputerUseProtocolError("Responses API response model identity does not match the requested model");';
const EXPECTED_KILL = "model identity mismatch fails closed";
const SUMMARY_FIELDS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
export const CUA_MUTATION_RESULT_SCHEMA = "survey-qa-mutation-result/1.0.0";
export const CUA_MUTATION_SELECTOR = "cua-model-identity-exact-named-guard";
const CUA_MUTANTS = Object.freeze([
  Object.freeze({
    name: "exact response model identity guard",
    file: FILE,
    find: FIND,
    replace: REPLACE,
    kills: Object.freeze([EXPECTED_KILL]),
  }),
]);
const RELEASE_RESULT_KEYS = Object.freeze([
  "schema",
  "selector",
  "denominator",
  "mutantsTotal",
  "mutantsKilled",
  "selfChecksPassed",
]);

/**
 * Close the machine-readable release result over this harness's custom one-mutant selector.
 * Only a fully killed denominator with both semantic self-checks may be represented as success;
 * callers cannot add an attested-looking field or borrow the shared exact-union identity.
 */
export function closeCuaMutationReleaseResult(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("CUA mutation release result must be an object");
  }
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [...RELEASE_RESULT_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("CUA mutation release result has unknown or missing properties");
  }
  const expected = {
    schema: CUA_MUTATION_RESULT_SCHEMA,
    selector: CUA_MUTATION_SELECTOR,
    denominator: CUA_MUTANTS.length,
    mutantsTotal: CUA_MUTANTS.length,
    mutantsKilled: CUA_MUTANTS.length,
    selfChecksPassed: 2,
  };
  for (const key of RELEASE_RESULT_KEYS) {
    if (candidate[key] !== expected[key]) {
      throw new TypeError(`CUA mutation release result has invalid ${key}`);
    }
  }
  return Object.freeze(expected);
}

export function formatCuaMutationReleaseResult(candidate) {
  return `MUTATION_RESULT ${JSON.stringify(closeCuaMutationReleaseResult(candidate))}`;
}

function exactlyOneInt(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, "gm"))];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

/**
 * Parse the pinned node:test TAP reporter conservatively. `completed` means one coherent final
 * plan and every summary counter, not merely that the child returned a status. Exported so the
 * dedicated harness test can prove rejection paths without spawning or mutating production code.
 */
export function parseTapRun(output, exitStatus) {
  const raw = String(output ?? "");
  const planMatches = [...raw.matchAll(/^1\.\.(\d+)\r?$/gm)];
  const durationMatches = [...raw.matchAll(/^# duration_ms (\d+(?:\.\d+)?)\r?$/gm)];
  const headerMatches = [...raw.matchAll(/^TAP version 13\r?$/gm)];
  const summary = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, exactlyOneInt(raw, field)]));
  const failing = [...raw.matchAll(/^not ok \d+ - (.+?)\r?$/gm)].map((match) => match[1]);
  const resultLines = [...raw.matchAll(/^(?:not )?ok (\d+) - .+?\r?$/gm)];
  const plan = planMatches.length === 1 ? Number(planMatches[0][1]) : null;
  const countersPresent = SUMMARY_FIELDS.every((field) => summary[field] !== null);
  const terminalCountsCoherent = countersPresent
    && summary.cancelled === 0
    && summary.skipped === 0
    && summary.todo === 0
    && summary.tests === summary.pass + summary.fail
    && summary.fail === failing.length;
  const resultNumbers = resultLines.map((match) => Number(match[1]));
  const resultSetCoherent = plan !== null
    && resultNumbers.length === plan
    && new Set(resultNumbers).size === plan
    && resultNumbers.every((number, index) => number === index + 1);
  const statusCoherent = summary.fail === 0 ? exitStatus === 0 : exitStatus === 1;

  return {
    output: raw,
    exitStatus,
    failing,
    anchorRejected: /(?:Error:\s*)?mutant patch matched \d+ times/.test(raw),
    completed: headerMatches.length === 1
      && planMatches.length === 1
      && durationMatches.length === 1
      && countersPresent
      && plan === summary.tests
      && terminalCountsCoherent
      && resultSetCoherent
      && statusCoherent,
    passed: countersPresent ? summary.pass : null,
    total: countersPresent ? summary.tests : null,
  };
}

/** Bind scoreable TAP completion to the shared supervisor's closed containment receipt. */
export function parseContainedTapRun(child) {
  const output = `${child?.stdout ?? ""}${child?.stderr ?? ""}`;
  const parsed = parseTapRun(output, child?.status);
  const containmentCompleted = child?.completed === true
    && child?.error === null
    && child?.signal === null
    && child?.timedOut === false
    && (child?.status === 0 || child?.status === 1)
    && child?.supervisorStatus === 0
    && child?.finalActiveProcesses === 0
    && child?.containmentScope === WINDOWS_JOB_CONTAINMENT_SCOPE;
  return {
    ...parsed,
    completed: parsed.completed && containmentCompleted,
    containmentCompleted,
  };
}

const difference = (left, right) => left.filter((name) => !right.includes(name));

/** Pure verdict used identically by self-checks and the real semantic mutant. */
export function judgeCuaMutant(result, baselineFailing, expectedKills = []) {
  if (result.anchorRejected) {
    return {
      status: "BROKEN-ANCHOR",
      killed: false,
      newFailures: [],
      note: "the in-memory patch did not match exactly once; no mutation was executed",
    };
  }
  if (!result.completed) {
    return {
      status: "NO-RUN",
      killed: false,
      newFailures: [],
      note: "node:test did not emit one coherent completed TAP summary",
    };
  }

  const newFailures = difference(result.failing, baselineFailing);
  const missed = difference(expectedKills, newFailures);
  if (expectedKills.length > 0) {
    return missed.length === 0
      ? { status: "killed", killed: true, newFailures, note: null }
      : {
          status: "SURVIVED",
          killed: false,
          newFailures,
          note: `the exact named guard did not newly fail: ${missed.join(" | ")}`,
        };
  }
  return newFailures.length > 0
    ? { status: "killed", killed: true, newFailures, note: null }
    : { status: "SURVIVED", killed: false, newFailures, note: "no new failures" };
}

/**
 * The second self-check is earned only by re-running an exact, nonempty red set which contains
 * at least one failure absent from the original baseline. This makes `selfChecksPassed: 2`
 * computed evidence, not a label attached to any two failed child processes.
 */
export function redBaselineSelfCheckPassed({ baselineFailing, red, repeated, repeatedVerdict }) {
  const arrays = [baselineFailing, red?.failing, repeated?.failing];
  if (arrays.some((value) => !Array.isArray(value))) return false;
  if (
    !red.completed || red.anchorRejected ||
    !repeated.completed || repeated.anchorRejected ||
    red.failing.length === 0 ||
    arrays.some((names) => names.some((name) => typeof name !== "string" || name.length === 0)) ||
    arrays.some((names) => new Set(names).size !== names.length)
  ) return false;
  const addsNewFailure = red.failing.some((name) => !baselineFailing.includes(name));
  const exactRepeatedSet = red.failing.length === repeated.failing.length
    && red.failing.every((name, index) => repeated.failing[index] === name);
  return addsNewFailure
    && exactRepeatedSet
    && repeatedVerdict?.killed === false
    && Array.isArray(repeatedVerdict.newFailures)
    && repeatedVerdict.newFailures.length === 0;
}

async function runTest(testFile, mutant = null) {
  const subjectPath = path.resolve(ROOT, ...testFile.split("/"));
  const child = await runContainedNodeSubject({
    subjectPath,
    arguments: ["--test", "--test-reporter=tap", subjectPath],
    timeoutMs: 120_000,
    mutant,
  });
  return { child, result: parseContainedTapRun(child) };
}

function fatal(message, run = null) {
  console.error(`CUA MUTANT FATAL: ${message}`);
  if (run?.child?.error) console.error(run.child.error);
  if (run?.result?.output) console.error(run.result.output);
  return 2;
}

export async function main() {
  let selfChecksPassed = 0;
  const harness = await runTest(HARNESS_TEST);
  if (!harness.result.completed || harness.result.failing.length !== 0) {
    return fatal("the mutation harness's dedicated fail-capable tests did not pass", harness);
  }

  const baseline = await runTest(TEST);
  if (!baseline.result.completed) return fatal("the unmutated CUA suite did not complete", baseline);
  if (baseline.result.failing.includes(EXPECTED_KILL)) {
    return fatal(`the exact guard test was already red at baseline: ${EXPECTED_KILL}`, baseline);
  }
  console.log(`CUA MUTANTS baseline: ${baseline.result.passed}/${baseline.result.total} passed; ${baseline.result.failing.length} already red`);

  const noop = await runTest(TEST, { ...CUA_MUTANTS[0], replace: FIND });
  const noopVerdict = judgeCuaMutant(noop.result, baseline.result.failing);
  if (noop.result.anchorRejected || !noop.result.completed || noopVerdict.killed) {
    return fatal(`no-op self-check failed (${noopVerdict.status}): ${noopVerdict.note}`, noop);
  }
  selfChecksPassed += 1;
  console.log("CUA MUTANTS self-check 1/2: no-op scored NOT killed over the recorded baseline");

  // Deliberately make the suite red, then re-apply the identical mutation relative to that red
  // baseline. An "any failure means killed" regression cannot pass this check.
  const red = await runTest(TEST, CUA_MUTANTS[0]);
  const realVerdict = judgeCuaMutant(red.result, baseline.result.failing, [EXPECTED_KILL]);
  if (!realVerdict.killed) {
    const description = `${realVerdict.status}: ${realVerdict.note ?? "exact guard did not fail"}`;
    return fatal(`semantic mutant was NOT killed (${description})`, red);
  }
  const redAgain = await runTest(TEST, CUA_MUTANTS[0]);
  const redAgainVerdict = judgeCuaMutant(redAgain.result, red.result.failing);
  if (!redBaselineSelfCheckPassed({
    baselineFailing: baseline.result.failing,
    red: red.result,
    repeated: redAgain.result,
    repeatedVerdict: redAgainVerdict,
  })) {
    return fatal(
      `red-baseline self-check failed (${redAgainVerdict.status}); repeated mutation did not preserve the exact red baseline`,
      redAgain,
    );
  }
  selfChecksPassed += 1;
  console.log(`CUA MUTANTS self-check 2/2: repeated mutant scored NOT killed over an identical red baseline (${red.result.failing.length} failing)`);
  const mutantsTotal = CUA_MUTANTS.length;
  const mutantsKilled = Number(realVerdict.killed);
  console.log(`CUA MUTANTS: ${mutantsKilled}/${mutantsTotal} killed by exact named test: ${EXPECTED_KILL}`);
  console.log(formatCuaMutationReleaseResult({
    schema: CUA_MUTATION_RESULT_SCHEMA,
    selector: CUA_MUTATION_SELECTOR,
    denominator: CUA_MUTANTS.length,
    mutantsTotal,
    mutantsKilled,
    selfChecksPassed,
  }));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`CUA MUTANT FATAL: supervised child execution failed (${error?.code ?? error?.message ?? "unknown"})`);
    process.exitCode = 2;
  }
}
