/**
 * THE ITERATION-LOOP TOOLS, AND THE PROOF THEY CAN GO RED.
 *
 * `tools/runsum.mjs` (scoreboard) and `tools/runcheck.mjs` (invariants) are the two scripts
 * docs/ITERATION-LOOP.md §6 asks for. A checker that has never been seen to fail is decoration, so
 * the load-bearing half of this file is the NEGATIVE half: for every invariant I1–I7 there is a
 * deliberately corrupted copy of the run, in memory, and an assertion that THAT invariant — and, for
 * the isolable ones, only that invariant — turns FAIL.
 *
 * The committed run is never mutated: everything below deep-clones the JudgementRecord that
 * `pipeline/runs/synthetic-demo/` produces. Judging it costs ~0.8s and happens once for the file.
 *
 * NOTE it drives SYNTHETIC_RUN explicitly and NOT `SUBSTRATE_RUN`: in the owner's tree the latter
 * resolves to the blind-derived private run, and these assertions would then be about material the
 * evaluation boundary holds out.
 */

import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { HEALTHY_REASONS, REASON_VOCAB, REPO, flags, loadJudgement, summarize } from "../runsum.mjs";
import { runChecks } from "../runcheck.mjs";

const SYNTHETIC = path.join(REPO, "pipeline", "runs", "synthetic-demo");
const loaded = loadJudgement(SYNTHETIC);
const CLEAN = loaded.record;
const RUN_DIR = CLEAN.source?.runDir ?? SYNTHETIC;

const clone = () => JSON.parse(JSON.stringify(CLEAN));
const check = (rec, { runDir = RUN_DIR, ...extra } = {}) =>
  Object.fromEntries(runChecks(rec, runDir, extra).map((r) => [r.id, r]));
const BASELINE = check(CLEAN);
const refs = (r) => r.offenders.map((o) => String(o.ref));

/** Assert `id` went FAIL and every other invariant kept the status it had on the clean run. */
function onlyFailed(res, id, offender) {
  assertEq(res[id].status, "FAIL", `${id} should have gone red`);
  if (offender) assert(refs(res[id]).includes(offender), `${id} offenders ${JSON.stringify(refs(res[id]))} should name ${offender}`);
  for (const other of Object.keys(BASELINE)) {
    if (other === id) continue;
    assertEq(res[other].status, BASELINE[other].status, `${other} moved as collateral of the ${id} mutation`);
  }
}

const firstWhere = (rec, fn) => {
  const row = rec.results.find(fn);
  if (!row) throw new Error("no such row in the synthetic run");
  return row;
};

suite("runsum/runcheck — the clean synthetic run", () => {
  test("all seven invariants evaluate, none FAIL, none over an empty denominator", () => {
    const res = check(CLEAN);
    assertEq(Object.keys(res).length, 7, "I1..I7 must all be present");
    for (const r of Object.values(res)) {
      assert(r.status !== "FAIL", `${r.id} FAILED on the committed run: ${JSON.stringify(refs(r))}`);
      assert(!/^0 /.test(String(r.denominator)), `${r.id} passed over an EMPTY denominator (${r.denominator})`);
    }
  });

  test("I5 reports REVIEW, not PASS, because synthetic-demo's contract is bound but never sealed", () => {
    assertEq(BASELINE.I5.status, "REVIEW");
    assert(/no sealed contractRevisionId/i.test(BASELINE.I5.note ?? ""), BASELINE.I5.note);
  });

  test("REVIEW is a real tier: a sealed revision id turns I5 green", () => {
    const rec = clone();
    rec.binding.contractRevisionId = "cr_0000000000000000";
    assertEq(check(rec).I5.status, "PASS");
  });
});

suite("runcheck — each invariant, proven to go red", () => {
  test("I1 — a pass whose evidenceRefs are emptied", () => {
    const rec = clone();
    const row = firstWhere(rec, (r) => r.verdict === "pass" && r.evidenceRefs.length > 0);
    row.evidenceRefs = [];
    onlyFailed(check(rec), "I1", row.obligationId);
  });

  test("I2 — an exercised case demoted to not-assessed", () => {
    const rec = clone();
    const row = firstWhere(rec, (r) => r.coverage === "exercised" && r.verdict === "pass");
    row.verdict = "not-assessed";
    onlyFailed(check(rec), "I2", row.obligationId);
  });

  test("I3 — a case that was never reached handed a verdict", () => {
    const rec = clone();
    const row = firstWhere(rec, (r) => r.coverage === "not-reached");
    row.verdict = "pass";
    // given a citation too, so the failure isolates to I3 instead of also tripping I1
    row.evidenceRefs = [{ artifact: "MUTANT.json", sha256: "0".repeat(64), locators: [] }];
    onlyFailed(check(rec), "I3", row.obligationId);
  });

  test("I4a — the coverage counter inflated past the denominator", () => {
    const rec = clone();
    rec.counts.byCoverage.exercised += 1;
    onlyFailed(check(rec), "I4", "denominator");
  });

  test("I4b — THE SUM STILL ADDS UP but a row moved bucket (what a sum-to-total check cannot see)", () => {
    const rec = clone();
    firstWhere(rec, (r) => r.coverage === "exercised").coverage = "pending";
    const res = check(rec);
    onlyFailed(res, "I4", "byCoverage.exercised");
    assert(!refs(res.I4).includes("denominator"), "the Σ clause should still be satisfied — only the recount clause fires");
  });

  test("I5a — an obligation the signed contract never sealed", () => {
    const rec = clone();
    rec.results[0].obligationId = "SYN-NOT-IN-THE-CONTRACT";
    const res = check(rec);
    assertEq(res.I5.status, "FAIL");
    assert(/ORPHAN/.test(res.I5.offenders[0].why), res.I5.offenders[0].why);
  });

  test("I5b — the same obligation judged twice", () => {
    const rec = clone();
    const dup = JSON.parse(JSON.stringify(rec.results[0]));
    rec.results.push(dup);
    rec.counts.byCoverage[dup.coverage] += 1; // keep I4 green so the failure isolates to I5
    rec.denominator.obligations += 1;
    const res = check(rec);
    onlyFailed(res, "I5", dup.obligationId);
    assert(res.I5.offenders.some((o) => /DUPLICATE/.test(o.why)), JSON.stringify(res.I5.offenders));
  });

  test("I5c — nothing to check against FAILS, it does not skip", () => {
    const res = check(CLEAN, { runDir: path.join(tmpdir(), "no-such-run-dir-runcheck") });
    assertEq(res.I5.status, "FAIL");
    assert(/cannot evaluate/.test(res.I5.offenders[0].why), res.I5.offenders[0].why);
  });

  test("I6 — a reason code nobody wrote down", () => {
    const rec = clone();
    rec.results[0].reason = "MADE_UP_CODE";
    const res = check(rec);
    onlyFailed(res, "I6", "MADE_UP_CODE");
    assert(res.I6.offenders[0].why.includes(rec.results[0].obligationId), "the offender must name the obligations carrying the new code");
  });

  test("I6 drift — a code the engine knows that the frozen list has not caught up with", () => {
    const frozenVocab = REASON_VOCAB.filter((c) => c !== "INSUFFICIENT_SAMPLE");
    const res = check(CLEAN, { frozenVocab });
    assertEq(res.I6.status, "REVIEW", "an unfrozen-but-live code is a soft signal, not a build failure");
    assert(/INSUFFICIENT_SAMPLE/.test(res.I6.note ?? ""), res.I6.note);
  });

  test("I6 must NOT be checked against the live vocabulary — that is the check that cannot fail", () => {
    // assertReason() already guarantees every emitted code is in vocab.mjs, so widening the
    // vocabulary to include the fabrication silences I6. Asserted here so the frozen list is never
    // "simplified" back into a live import of vocab.mjs.
    // BOTH vocabularies are pinned: leaving `liveVocab` on its default would couple this assertion
    // to the engine's future, and the next legitimate REASON added to vocab.mjs would turn the
    // drift REVIEW into a hard suite failure — the opposite of the tier this file is defending.
    const rec = clone();
    rec.results[0].reason = "MADE_UP_CODE";
    const res = check(rec, { frozenVocab: [...REASON_VOCAB, "MADE_UP_CODE"], liveVocab: REASON_VOCAB });
    assertEq(res.I6.status, "PASS", "sanity: a vocabulary that always contains the code cannot fire");
  });

  for (const [name, mutate, offender] of [
    ["status claims attestable", (r) => { r.status = "attestable"; }, "status"],
    ["it does not say what could not be bound", (r) => { r.unbindableFields = []; }, "unbindableFields"],
    ["it claims to be certifiable", (r) => { r.certification.certifiable = true; }, "certifiable"],
    ["the rendering constraint stops forbidding current rendering", (r) => { r.renderingConstraint = "fine to publish"; }, "renderingConstraint"],
  ]) {
    test(`I7 — publishable=false but ${name}`, () => {
      const rec = clone();
      mutate(rec);
      onlyFailed(check(rec), "I7", offender);
    });
  }

  test("I7 — the other branch: publishable=true while still marked diagnostic-only", () => {
    const rec = clone();
    rec.publishable = true;
    onlyFailed(check(rec), "I7", "status");
  });

  test("I7 — report data beside the run claiming a current column from an unpublishable judgement", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runcheck-i7-"));
    copyFileSync(path.join(RUN_DIR, "run-record.json"), path.join(dir, "run-record.json"));
    writeFileSync(
      path.join(dir, "report-data.json"),
      JSON.stringify({ register: { publication: { hasCurrentResults: true, currentColumnId: "re-derived" } } }),
    );
    const res = check(CLEAN, { runDir: dir });
    assertEq(res.I7.status, "FAIL");
    assert(/renders current results/.test(res.I7.offenders[0].why), res.I7.offenders[0].why);
    assert(/report-data\.json/.test(String(res.I7.denominator)), "the clause must appear in the denominator once there is data to check");
  });
});

suite("runsum — the scoreboard", () => {
  test("every obligation gets exactly one row, and the cross-tab reconciles with byReason", () => {
    const s = summarize(CLEAN);
    assertEq(s.rows.length, CLEAN.results.length);
    assertEq(s.rows.length, CLEAN.denominator.obligations);
    for (const row of s.crosstab) {
      assertEq(row.total, CLEAN.counts.byReason[row.reason], `cross-tab total for ${row.reason}`);
      assertEq(Object.values(row.by).reduce((a, b) => a + b, 0), row.total, `cross-tab row ${row.reason} does not sum to its own total`);
    }
  });

  test("NEXT names the largest NON-HEALTHY bucket, not the largest bucket", () => {
    const s = summarize(CLEAN);
    const biggest = Object.entries(CLEAN.counts.byReason).sort((a, b) => b[1] - a[1])[0];
    assert(HEALTHY_REASONS.has(biggest[0]), `precondition: the biggest bucket on this run is healthy (${biggest[0]})`);
    assert(s.next && !HEALTHY_REASONS.has(s.next[0]), `NEXT picked ${JSON.stringify(s.next)}`);
    assertEq(s.next[1], Math.max(...s.actionable.map(([, n]) => n)), "NEXT must be the largest actionable bucket");
  });

  test("the table is SECTIONED BY REASON — rows of one code are never split apart", () => {
    const seen = new Set();
    let last = null;
    for (const r of summarize(CLEAN).rows) {
      if (r.reason !== last) {
        assert(!seen.has(r.reason), `${r.reason} appears in two sections — the group-by-reason rule is broken`);
        seen.add(r.reason);
        last = r.reason;
      }
    }
  });

  test("FLAGS fire: the withheld fail and the defect on the clean run, plus a fabricated evidence-free pass", () => {
    const clean = flags(summarize(CLEAN).rows);
    assert(clean.some((f) => /withheld/.test(f.msg)), "the withheld fail must surface");
    assert(clean.some((f) => /DEFECT/.test(f.msg)), "the defect claim must surface");

    const rec = clone();
    const row = firstWhere(rec, (r) => r.verdict === "pass" && r.evidenceRefs.length > 0);
    row.evidenceRefs = [];
    const dirty = flags(summarize(rec).rows);
    assert(dirty.some((f) => f.obl === row.obligationId && /0 evidenceRefs/.test(f.msg)), "the flag block did not notice an evidence-free pass");
    assertEq(dirty.length, clean.length + 1, "exactly one new flag");
  });
});
