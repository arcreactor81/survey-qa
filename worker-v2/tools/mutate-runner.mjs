/**
 * THE MUTATION HARNESS ITSELF — and the reason it is a separate file.
 *
 * A mutation run answers one question: "if I break the behaviour this test guards, does THAT
 * test fail?" Everything here exists to stop that question being answered dishonestly.
 *
 * ==================== THE DEFECT THIS FILE WAS WRITTEN TO CLOSE ====================
 *
 * The previous harness scored a mutant as KILLED if the output contained ANY `FAIL` line.
 * On 5 Aug the suite had 22 pre-existing failures. Under that rule every mutant — including
 * one that changes nothing at all — was scored killed, and the harness reported a clean
 * sweep over a suite that was proving nothing. A mutation harness that cannot fail is the
 * same class of defect as the tests it is supposed to be auditing, one level up.
 *
 * So the kill criterion here is BASELINE-AWARE and NAMED:
 *
 *   1. The suite is run UNMUTATED first and the exact set of failing test names is recorded.
 *   2. A mutant is killed only by a test that is NOT in that set — a NEW failure.
 *   3. A mutant declaring `kills` is killed only when THAT NAMED TEST is among the new
 *      failures. "Something, somewhere went red" is not proof that a specific guard works;
 *      a mutation broad enough to fail the whole suite would otherwise score as a kill of
 *      every property at once.
 *
 * And the rule is enforced against the harness itself: before any real mutant runs, a NO-OP
 * mutant (find === replace, a rewrite that changes nothing) is scored by the same code path.
 * It MUST come back not-killed. If a no-op ever scores as killed, the criterion has regressed
 * and this exits non-zero WITHOUT running the real mutants, because their results would be
 * meaningless. That self-check is the thing that stops 5 Aug from happening twice.
 *
 * ==================== WHAT IS NEVER WRITTEN TO DISK ====================
 *
 * Nothing under `src/**`. `testkit.mjs#mutantPlugin` rewrites the source inside esbuild's
 * load step, so an interrupted run cannot leave a mutated working copy behind — which matters
 * in a tree other agents are editing, and is what makes it safe to mutate files this session
 * is forbidden to edit.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "..");

const FAIL_LINE = /^ {2}FAIL {2}(.+)$/gm;
const SUMMARY = /^(\d+)\/(\d+) passed, (\d+) failed$/m;

/**
 * Run the REAL suite once, optionally under a mutation. Returns what the caller needs to
 * judge a mutant and nothing it could mistake for a verdict.
 */
function runSuite({ filter = "", mutant = null } = {}) {
  const env = { ...process.env };
  delete env.MUTANT_FILE;
  delete env.MUTANT_FIND;
  delete env.MUTANT_REPLACE;
  if (mutant) {
    env.MUTANT_FILE = mutant.file;
    env.MUTANT_FIND = mutant.find;
    env.MUTANT_REPLACE = mutant.replace;
  }

  const run = spawnSync(process.execPath, [path.join(HERE, "test.mjs"), ...(filter ? [filter] : [])], {
    cwd: WORKER_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const failing = [...out.matchAll(FAIL_LINE)].map((m) => m[1].trim());
  const summary = out.match(SUMMARY);

  return {
    out,
    status: run.status,
    failing,
    // A run with no summary line never finished — the bundle threw, node crashed, the anchor
    // was rejected. It is NOT a run with zero failures, and must never be read as one.
    completed: summary !== null,
    passed: summary ? Number(summary[1]) : null,
    total: summary ? Number(summary[2]) : null,
    // The mutant plugin refuses an anchor that matches zero or several times. That is not a
    // kill: the mutation never ran, so the suite proved nothing about it.
    anchorRejected: /mutant patch matched/.test(out),
  };
}

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

/**
 * Judge one mutant against the recorded baseline. Pure, so the criterion is one function
 * that both the self-check and the real mutants go through — a self-check exercising a
 * different code path from the thing it certifies would certify nothing.
 */
function judge(mutant, result, baselineFailing) {
  if (result.anchorRejected) {
    return {
      status: "BROKEN-ANCHOR",
      killed: false,
      newFailures: [],
      note:
        "the anchor no longer matches exactly once — the source moved under this harness " +
        "(another agent editing, or a real drift). Re-read the file and re-anchor; this is NOT a kill.",
    };
  }
  if (!result.completed) {
    return {
      status: "NO-RUN",
      killed: false,
      newFailures: [],
      note: "the suite never produced a summary line, so this mutant was never actually scored",
    };
  }

  const newFailures = setDiff(result.failing, baselineFailing);
  const expected = mutant.kills ?? [];
  const missed = setDiff(expected, newFailures);

  if (expected.length > 0) {
    if (missed.length === 0) return { status: "killed", killed: true, newFailures, note: null };
    return {
      status: "SURVIVED",
      killed: false,
      newFailures,
      note:
        `the named guard test did NOT newly fail: ${missed.join(" | ")}` +
        (newFailures.length > 0 ? ` (other tests did: ${newFailures.join(" | ")})` : ""),
    };
  }

  if (newFailures.length > 0) return { status: "killed", killed: true, newFailures, note: null };
  return { status: "SURVIVED", killed: false, newFailures, note: `untested property: ${mutant.breaks}` };
}

/**
 * @param title  what this mutant set is auditing, for the header
 * @param filter substring passed to test.mjs; "" runs everything. The BASELINE uses the same
 *               filter, because a baseline over a different set of tests is not a baseline.
 * @param mutants [{ name, breaks, file, find, replace, kills: [exact test names] }]
 */
export async function runMutantSuite({ title, filter = "", mutants }) {
  const w = process.stdout;
  w.write(`${title}\n${"=".repeat(title.length)}\n\n`);
  w.write(`kill criterion: BASELINE-AWARE — a mutant is killed only by a test that was PASSING\n`);
  w.write(`before the mutation, and (where declared) only by the NAMED test that guards it.\n\n`);

  // ---- 1. BASELINE -------------------------------------------------------
  const baseline = runSuite({ filter });
  if (!baseline.completed) {
    w.write(`FATAL: the unmutated suite did not complete. Nothing can be scored against it.\n`);
    w.write(baseline.out.split("\n").slice(-25).join("\n"));
    process.exit(2);
  }
  w.write(`baseline (unmutated): ${baseline.passed}/${baseline.total} passed, ${baseline.failing.length} failed\n`);
  for (const f of baseline.failing) w.write(`  already red: ${f}\n`);
  w.write("\n");

  // A mutant whose guard test is ALREADY failing can never be proven — its target cannot
  // become a NEW failure. Say so rather than scoring it.
  const unprovable = [];
  for (const m of mutants) {
    const clash = (m.kills ?? []).filter((k) => baseline.failing.includes(k));
    if (clash.length > 0) unprovable.push({ mutant: m, clash });
  }

  // ---- 2. THE HARNESS'S OWN SELF-CHECK -----------------------------------
  // A rewrite that changes nothing must score NOT killed. This is the exact case the old
  // "any FAIL line" criterion got wrong, so it runs before anything else and is fatal.
  const noop = mutants[0];
  const selfCheck = runSuite({ filter, mutant: { file: noop.file, find: noop.find, replace: noop.find } });
  const selfVerdict = judge({ ...noop, kills: undefined, breaks: "nothing — this is a no-op" }, selfCheck, baseline.failing);
  if (selfVerdict.killed) {
    w.write(
      `FATAL SELF-CHECK: a NO-OP mutation (find === replace) scored as KILLED.\n` +
        `The kill criterion is broken, so every result below would be meaningless.\n` +
        `new failures attributed to a mutation that changed nothing: ${selfVerdict.newFailures.join(" | ")}\n`,
    );
    process.exit(2);
  }
  if (selfCheck.anchorRejected || !selfCheck.completed) {
    w.write(`FATAL SELF-CHECK: the no-op run did not complete cleanly (${selfVerdict.status}). ${selfVerdict.note}\n`);
    process.exit(2);
  }
  w.write(`self-check 1/2: a no-op mutation scored NOT killed over the real baseline.\n`);

  // ---- 2b. THE SELF-CHECK THAT ACTUALLY DISCRIMINATES ---------------------
  // Self-check 1 passes under the OLD broken criterion too, whenever the suite is green: with
  // no FAIL lines at all, "any FAIL line" and "a NEW FAIL line" agree. It therefore proves
  // nothing on its own, and a harness that stopped there would be repeating the original sin
  // one level up.
  //
  // This one reproduces the 5 Aug condition exactly. It makes the baseline RED by applying a
  // real mutant, then applies THE SAME MUTANT AGAIN. Relative to that red baseline nothing has
  // changed, so the correct answer is NOT killed — while the old "any FAIL line" rule would
  // say killed, because FAIL lines are plainly present. Only a baseline-aware criterion can
  // tell those apart, so this is the check that fails if the rule ever regresses.
  const probe = mutants.find((m) => m.find !== m.replace) ?? mutants[0];
  const red = runSuite({ filter, mutant: probe });
  if (!red.completed || red.anchorRejected || red.failing.length === 0) {
    w.write(
      `self-check 2/2 SKIPPED: the probe mutant ("${probe.name}") produced no red baseline ` +
        `(${red.anchorRejected ? "anchor rejected" : !red.completed ? "run did not complete" : "no failures"}), ` +
        `so the red-baseline criterion could not be exercised. Results below are still baseline-aware, ` +
        `but this run did not PROVE the criterion discriminates.\n\n`,
    );
  } else {
    const again = runSuite({ filter, mutant: probe });
    const againVerdict = judge(
      { ...probe, kills: undefined, breaks: "nothing, relative to a RED baseline" },
      again,
      red.failing,
    );
    if (againVerdict.killed) {
      w.write(
        `FATAL SELF-CHECK: re-applying an ALREADY-APPLIED mutation scored as KILLED against a red\n` +
          `baseline of ${red.failing.length} failing test(s). That is the 5 Aug defect: failures that were\n` +
          `already there are being counted as this mutant's kills. Every result below would be fiction.\n` +
          `wrongly attributed: ${againVerdict.newFailures.join(" | ")}\n`,
      );
      process.exit(2);
    }
    w.write(
      `self-check 2/2: over a deliberately RED baseline (${red.failing.length} failing), re-applying the same\n` +
        `            mutation scored NOT killed — pre-existing failures are not counted as kills.\n\n`,
    );
  }

  // ---- 3. THE REAL MUTANTS -----------------------------------------------
  const results = [];
  for (const m of mutants) {
    const blocked = unprovable.find((u) => u.mutant === m);
    if (blocked) {
      w.write(`  UNPROVABLE  ${m.name}\n              guard test already red at baseline: ${blocked.clash.join(" | ")}\n`);
      results.push({ mutant: m, verdict: { status: "UNPROVABLE", killed: false, newFailures: [], note: "baseline red" } });
      continue;
    }
    const result = runSuite({ filter, mutant: m });
    const verdict = judge(m, result, baseline.failing);
    results.push({ mutant: m, verdict });

    if (verdict.killed) {
      w.write(`  killed      ${m.name}\n              by: ${verdict.newFailures.join("\n                  ")}\n`);
    } else {
      w.write(`  ${verdict.status.padEnd(10)}  ${m.name}\n              ${verdict.note}\n`);
    }
  }

  const bad = results.filter((r) => !r.verdict.killed);
  w.write(`\n${results.length - bad.length}/${results.length} mutants killed`);
  w.write(bad.length > 0 ? `, ${bad.length} NOT killed\n` : `\n`);
  for (const b of bad) w.write(`  NOT KILLED: ${b.mutant.name} — ${b.verdict.status}\n`);

  process.exit(bad.length === 0 ? 0 : 1);
}
