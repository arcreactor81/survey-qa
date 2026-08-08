#!/usr/bin/env node
/**
 * runcheck.mjs — named deterministic invariants over ONE run. (pa-policy's `validate_submission.py`.)
 *
 *   node worker-v2/tools/runcheck.mjs                      # the synthetic demo run
 *   node worker-v2/tools/runcheck.mjs <runDir|judgeOutDir>
 *
 * Seconds, no LLM. Each invariant prints PASS / FAIL / REVIEW with the offending obligation ids.
 *
 * THREE TIERS, kept from pa-policy:
 *   FAIL    hard breakage — the run cannot mean what it says. Exit code 1.
 *   REVIEW  a soft signal that ranks rows for a human without failing the build. Exit code 0.
 *   PASS    the property held, over a NON-EMPTY denominator (each invariant reports its own).
 *
 * ON "THE CHECK THAT CANNOT FAIL" (CLAUDE.md rule 2). Three deliberate choices here:
 *   - I4 does not merely add the counter up; it RECOUNTS the rows and compares. A counter that has
 *     drifted from the rows it summarises is exactly what a sum-to-total check cannot see.
 *   - I5 FAILS rather than skips when there is no signed contract to pin the denominator to. An
 *     unevaluable I5 exiting green is the empty-denominator gate this repo has shipped before.
 *   - I6 checks against a FROZEN list (tools/fixtures/reason-vocab.json), not against
 *     pipeline/judge/lib/vocab.mjs. `assertReason` already guarantees membership of the live
 *     vocabulary, so checking the live one can never fire. The frozen one fires the moment a new
 *     failure mode arrives.
 * Every invariant below is proven to go red in tools/tests/runtools.test.mjs.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REASON_VOCAB, UNREACHED_COVERAGE, loadJudgement } from "./runsum.mjs";
import { REASON } from "../../pipeline/judge/lib/vocab.mjs";

const bad = (offenders, denominator, note = null) => ({ status: offenders.length ? "FAIL" : "PASS", offenders, denominator, note });

/**
 * ctx: { record, runDir }. Every check is pure over ctx, which is what makes the negative
 * fixtures cheap — the test mutates a plain object, no corrupted run directory on disk.
 */
export const INVARIANTS = [
  {
    id: "I1",
    name: "a decided verdict cites at least one artifact",
    detail: "verdict ∈ {pass, fail} ⇒ evidenceRefs.length ≥ 1",
    check({ record }) {
      const scope = (record.results ?? []).filter((r) => r.verdict === "pass" || r.verdict === "fail");
      return bad(
        scope.filter((r) => (r.evidenceRefs ?? []).length === 0).map((r) => ({ ref: r.obligationId, why: `${r.verdict} with 0 evidenceRefs` })),
        `${scope.length} decided verdict(s)`,
      );
    },
  },
  {
    id: "I2",
    name: "an exercised case was assessed",
    detail: "coverage = exercised ⇒ verdict ≠ not-assessed",
    check({ record }) {
      const scope = (record.results ?? []).filter((r) => r.coverage === "exercised");
      return bad(
        scope.filter((r) => r.verdict === "not-assessed").map((r) => ({ ref: r.obligationId, why: `exercised but not-assessed (${r.reason})` })),
        `${scope.length} exercised case(s)`,
      );
    },
  },
  {
    id: "I3",
    name: "a case that was never reached carries no verdict",
    detail: "coverage ∈ {not-reached, blocked, proven-unreachable} ⇒ verdict = not-assessed",
    check({ record }) {
      // `pending` is deliberately absent from that set: pending means "not run yet", which is a
      // different claim from "the walk proved it could not be reached".
      const scope = (record.results ?? []).filter((r) => UNREACHED_COVERAGE.has(r.coverage));
      return bad(
        scope.filter((r) => r.verdict !== "not-assessed").map((r) => ({ ref: r.obligationId, why: `coverage=${r.coverage} but verdict=${r.verdict}` })),
        `${scope.length} unreached case(s)`,
      );
    },
  },
  {
    id: "I4",
    name: "the coverage counter accounts for every obligation",
    detail: "Σ byCoverage == denominator.obligations, and byCoverage == a recount of results[]",
    check({ record }) {
      const counter = record.counts?.byCoverage ?? {};
      const total = Object.values(counter).reduce((a, b) => a + b, 0);
      const denom = record.denominator?.obligations ?? null;
      const recount = {};
      for (const r of record.results ?? []) recount[r.coverage] = (recount[r.coverage] ?? 0) + 1;
      const offenders = [];
      if (denom === null) offenders.push({ ref: "denominator", why: "the record states no denominator.obligations" });
      else if (total !== denom) offenders.push({ ref: "denominator", why: `Σ byCoverage = ${total} but denominator.obligations = ${denom}` });
      for (const k of new Set([...Object.keys(counter), ...Object.keys(recount)])) {
        if ((counter[k] ?? 0) !== (recount[k] ?? 0)) {
          offenders.push({ ref: `byCoverage.${k}`, why: `counter says ${counter[k] ?? 0}, results[] contains ${recount[k] ?? 0}` });
        }
      }
      return bad(offenders, `${(record.results ?? []).length} result row(s), ${Object.keys(counter).length} coverage bucket(s)`);
    },
  },
  {
    id: "I5",
    name: "every obligation is one the contract sealed",
    detail: "obligationIds ⊆ signed contract items · no duplicates · no orphans",
    check({ record, runDir }) {
      const p = path.join(runDir ?? "", "run-record.json");
      // NOT a skip. If the denominator cannot be pinned to a signed contract there is nothing to
      // check it against, and a green I5 over nothing is worse than a red one.
      if (!runDir || !existsSync(p)) {
        return { status: "FAIL", offenders: [{ ref: "run-record", why: `cannot evaluate: no signed run record at ${p || "(unknown run dir)"}` }], denominator: "0 contract items", note: null };
      }
      const items = (JSON.parse(readFileSync(p, "utf8")).contract?.items ?? []).map((i) => i.itemId);
      if (!items.length) {
        return { status: "FAIL", offenders: [{ ref: "run-record", why: "the signed contract carries no items — an empty denominator, not a clean run" }], denominator: "0 contract items", note: null };
      }
      const sealed = new Set(items);
      const seen = new Set();
      const offenders = [];
      for (const r of record.results ?? []) {
        if (!sealed.has(r.obligationId)) offenders.push({ ref: r.obligationId, why: "ORPHAN — judged but not in the signed contract" });
        if (seen.has(r.obligationId)) offenders.push({ ref: r.obligationId, why: "DUPLICATE — judged more than once" });
        seen.add(r.obligationId);
      }
      const res = bad(offenders, `${sealed.size} sealed item(s) vs ${(record.results ?? []).length} judged`);
      // Soft tier: a contract that is BOUND by a signature but never SEALED as a reviewed revision
      // is a weaker anchor than the invariant's name implies, and the reader should know which
      // one they got.
      if (res.status === "PASS" && !record.binding?.contractRevisionId) {
        return { ...res, status: "REVIEW", note: "checked against the signed run-record contract; this record has NO sealed contractRevisionId, so the anchor is bound-but-unreviewed" };
      }
      return res;
    },
  },
  {
    id: "I6",
    name: "no reason code arrived silently",
    detail: "every reason ∈ tools/fixtures/reason-vocab.json (frozen), which is why it can fire",
    // `frozenVocab`/`liveVocab` are injectable so the drift tier has a negative fixture; they
    // default to the checked-in list and the engine's own enumeration.
    check({ record, frozenVocab = REASON_VOCAB, liveVocab = Object.values(REASON) }) {
      const frozen = new Set(frozenVocab);
      const used = new Set((record.results ?? []).map((r) => r.reason).filter(Boolean));
      const offenders = [...used].filter((r) => !frozen.has(r)).map((r) => ({
        ref: r,
        why: `not in the frozen vocabulary — a new failure mode arrived; obligations: ${(record.results ?? []).filter((x) => x.reason === r).map((x) => x.obligationId).join(", ")}`,
      }));
      const res = bad(offenders, `${used.size} distinct code(s) in use, ${frozen.size} frozen`);
      if (res.status !== "PASS") return res;
      const drift = liveVocab.filter((r) => !frozen.has(r));
      return drift.length
        ? { ...res, status: "REVIEW", note: `vocab.mjs has drifted ahead of the frozen list by ${drift.length} code(s): ${drift.join(", ")} — freeze them before a run emits one` }
        : res;
    },
  },
  {
    id: "I7",
    name: "an unpublishable judgement is not presented as a result",
    detail: "publishable = false ⇒ diagnostic-only, unbindable fields stated, not certifiable, no current column",
    check({ record, runDir }) {
      const offenders = [];
      const clauses = [];
      if (record.publishable === false) {
        clauses.push("status", "unbindableFields", "certifiable", "renderingConstraint");
        if (record.status !== "diagnostic-only") offenders.push({ ref: "status", why: `publishable=false but status=${record.status}` });
        if (!(record.unbindableFields ?? []).length) offenders.push({ ref: "unbindableFields", why: "publishable=false but the record does not say what could not be bound" });
        if (record.certification?.certifiable !== false) offenders.push({ ref: "certifiable", why: `publishable=false but certifiable=${record.certification?.certifiable}` });
        if (!String(record.renderingConstraint ?? "").includes("must not be rendered as current results")) {
          offenders.push({ ref: "renderingConstraint", why: `publishable=false but the constraint does not forbid current rendering: ${JSON.stringify(record.renderingConstraint)}` });
        }
      } else {
        clauses.push("status", "unbindableFields");
        if (record.status !== "attestable") offenders.push({ ref: "status", why: `publishable=true but status=${record.status}` });
        if ((record.unbindableFields ?? []).length) offenders.push({ ref: "unbindableFields", why: `publishable=true but ${record.unbindableFields.length} field(s) are unbindable` });
      }
      // The consumer half: any report data sitting beside the run must not claim a current column.
      const sibling = ["report-data.json", "register.json"].map((f) => path.join(runDir ?? ".", f)).find((f) => existsSync(f));
      if (sibling) {
        clauses.push(path.basename(sibling));
        const pub = JSON.parse(readFileSync(sibling, "utf8")).register?.publication ?? JSON.parse(readFileSync(sibling, "utf8")).publication ?? {};
        if (record.publishable === false && (pub.hasCurrentResults === true || pub.currentColumnId)) {
          offenders.push({ ref: path.basename(sibling), why: `renders current results (${pub.currentColumnId}) from an unpublishable judgement` });
        }
      }
      return bad(offenders, `${clauses.length} clause(s): ${clauses.join(", ")}${sibling ? "" : " — no report data beside this run, so the consumer clause had nothing to check"}`);
    },
  },
];

export function runChecks(record, runDir, extra = {}) {
  return INVARIANTS.map((inv) => ({ ...inv, ...inv.check({ record, runDir, ...extra }) }));
}

if (path.resolve(process.argv[1] ?? "").toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const loaded = loadJudgement(target);
  const runDir = loaded.record.source?.runDir ?? loaded.dir;
  const results = runChecks(loaded.record, runDir);

  console.log(`==== RUNCHECK ${loaded.record.binding?.runId ?? "(unnamed)"} — ${runDir}\n`);
  for (const r of results) {
    console.log(`${r.status.padEnd(7)}${r.id}  ${r.name}`);
    console.log(`             ${r.detail}`);
    console.log(`             over ${r.denominator}`);
    if (r.note) console.log(`             REVIEW: ${r.note}`);
    for (const o of r.offenders) console.log(`             ${String(o.ref).padEnd(24)}${o.why}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  const review = results.filter((r) => r.status === "REVIEW");
  console.log(`\n${results.length - failed.length - review.length} PASS · ${review.length} REVIEW · ${failed.length} FAIL${failed.length ? `  →  ${failed.map((r) => r.id).join(", ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
