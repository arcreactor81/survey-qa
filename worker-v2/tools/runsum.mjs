#!/usr/bin/env node
/**
 * runsum.mjs — the one-screen scoreboard for ONE run. (pa-policy's `audit.py` + `audit_summary.py`.)
 *
 *   node worker-v2/tools/runsum.mjs                       # the synthetic demo run
 *   node worker-v2/tools/runsum.mjs <runDir|judgeOutDir>   # any run, or an already-judged out dir
 *   node worker-v2/tools/runsum.mjs <dir> --rows 0 --json
 *
 * WHAT IT DOES NOT DO: it does not compute anything the judge already computed. `counts.byVerdict`,
 * `counts.byCoverage`, `counts.byDisposition` and `counts.byReason` are printed from the
 * JudgementRecord verbatim. The two things this adds are the two halves pa-policy's audit had that
 * turn counts into action: a `reason × coverage` cross-tab, and one line per obligation.
 *
 * THE RULE THAT MATTERS MOST: group by REASON CODE, never by row. `INSUFFICIENT_SAMPLE 14` is one
 * predicate bug, not fourteen problems. So the per-obligation table is *sectioned by reason*, in the
 * same order as the reason counter, and the largest non-healthy bucket is marked `>>` and restated as
 * a NEXT line. "Healthy" is POSITIVE_WITNESS / COMPLETE_POSITIVE_INVENTORY — docs/ITERATION-LOOP.md §5
 * defines a green run as one whose byReason is mostly those two, so they are never "the next fix".
 *
 * LANE B ONLY. This reads `JudgementRecord.results[]` — the independent re-derivation — never
 * `itemResults[]`, which is the run's own account of itself.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const JUDGE = path.join(REPO, "pipeline", "judge", "judge.mjs");
/** The checked-in TEST-ONLY registry. Named in the header so it can never masquerade as attested. */
export const FIXTURE_REGISTRY = path.join(REPO, "scorer", "fixtures", "keys", "registry.json");

/** docs/ITERATION-LOOP.md §5 — a green run's byReason is mostly these. They are never "next". */
export const HEALTHY_REASONS = new Set(["POSITIVE_WITNESS", "COMPLETE_POSITIVE_INVENTORY"]);
/** Coverage values that assert the case was never reached. Note `pending` is deliberately NOT here. */
export const UNREACHED_COVERAGE = new Set(["not-reached", "blocked", "proven-unreachable"]);

export const REASON_VOCAB = JSON.parse(
  readFileSync(path.join(HERE, "fixtures", "reason-vocab.json"), "utf8"),
).codes;

/**
 * Get a JudgementRecord for `target`, cheaply.
 *
 * A directory that already holds `judgement-record.json` is read as-is — that is the cheap partial
 * rerun the loop depends on (re-judge once, re-read the scoreboard as often as you like). A run
 * directory is judged by spawning the REAL CLI into a fresh mkdtemp, never into the shared default
 * `pipeline/judge/out/<name>`: several agents work this tree at once.
 */
export function loadJudgement(target, { keyRegistry = FIXTURE_REGISTRY, fixtureKeys = true } = {}) {
  const dir = path.resolve(target ?? defaultRun());
  if (existsSync(path.join(dir, "judgement-record.json"))) {
    return { record: read(path.join(dir, "judgement-record.json")), from: "cached", dir };
  }
  if (!existsSync(path.join(dir, "checklist.json"))) {
    throw new Error(`${dir} is neither a run directory (needs checklist.json) nor a judge out dir (needs judgement-record.json)`);
  }
  const out = mkdtempSync(path.join(tmpdir(), "runsum-"));
  const args = [JUDGE, dir, "--out", out, "--json"];
  if (keyRegistry) args.push("--key-registry", keyRegistry);
  if (fixtureKeys) args.push("--fixture-keys");
  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`judge.mjs exited ${res.status}\n${res.stderr ?? ""}`);
  return { record: read(path.join(out, "judgement-record.json")), from: "judged", dir, judgeOut: out };
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The public stand-in run. NOT `SUBSTRATE_RUN` — that resolves to the blind-derived private run. */
function defaultRun() {
  return path.join(REPO, "pipeline", "runs", "synthetic-demo");
}

/**
 * `facetInstanceId` — the CASE — is carried by the v2 contract revision, not by a JudgementRecord
 * result. Where the run record exposes it we print it; where it does not we print `—` AND say so in
 * the header, because a silently blank column reads as "no cases" rather than "not recorded".
 */
export function caseIndex(runDir) {
  const p = path.join(runDir ?? "", "run-record.json");
  if (!runDir || !existsSync(p)) return null;
  const rec = read(p);
  const map = new Map();
  for (const it of rec.itemResults ?? []) {
    const fi = it.facetInstanceId ?? it.facetResults?.find((f) => f.facetInstanceId)?.facetInstanceId ?? null;
    if (fi) map.set(it.itemId, fi);
  }
  return map.size ? map : null;
}

/** Everything the screen needs, derived ONLY from what the judge already decided. */
export function summarize(record, { cases = null } = {}) {
  const results = record.results ?? [];
  const byReason = record.counts?.byReason ?? {};
  const reasons = Object.entries(byReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const actionable = reasons.filter(([r]) => !HEALTHY_REASONS.has(r));
  const coverageKeys = Object.keys(record.counts?.byCoverage ?? {});

  const crosstab = reasons.map(([reason, total]) => {
    const row = { reason, total, healthy: HEALTHY_REASONS.has(reason), by: {} };
    for (const k of coverageKeys) row.by[k] = 0;
    for (const r of results) if (r.reason === reason) row.by[r.coverage] = (row.by[r.coverage] ?? 0) + 1;
    return row;
  });

  const order = new Map(reasons.map(([r], i) => [r, HEALTHY_REASONS.has(r) ? 1000 + i : i]));
  const rows = results
    .map((r) => ({
      obl: r.obligationId,
      case: cases?.get(r.obligationId) ?? null,
      verdict: r.verdict,
      coverage: r.coverage,
      reason: r.reason,
      ev: (r.evidenceRefs ?? []).length,
      raw: r,
    }))
    .sort((a, b) => (order.get(a.reason) ?? 999) - (order.get(b.reason) ?? 999) || a.obl.localeCompare(b.obl));

  return { reasons, actionable, crosstab, rows, next: actionable[0] ?? null };
}

/** Soft, per-row signals. Not a gate — `runcheck.mjs` is the gate; this ranks rows for a human. */
export function flags(rows) {
  const out = [];
  const add = (obl, msg) => out.push({ obl, msg });
  for (const { obl, verdict, coverage, ev, reason, raw } of rows) {
    if ((verdict === "pass" || verdict === "fail") && ev === 0) add(obl, `${verdict} with 0 evidenceRefs`);
    if (verdict === "inconclusive" && ev === 0) add(obl, "inconclusive with 0 evidenceRefs");
    if (coverage === "exercised" && verdict === "not-assessed") add(obl, "exercised but not-assessed (invariant I2)");
    if (UNREACHED_COVERAGE.has(coverage) && verdict !== "not-assessed") add(obl, `verdict=${verdict} but coverage=${coverage} (invariant I3)`);
    if (raw.withheld) add(obl, `withheld: would have been ${raw.withheld.wouldHaveBeen}, blocked by ${(raw.withheld.blockedBy ?? []).join(", ")}`);
    if (raw.disposition === "defect") add(obl, `DEFECT claimed — ${reason}`);
    if ((raw.compiledFieldsUnbound ?? []).length) add(obl, `compiled fields not covered by the signature: ${raw.compiledFieldsUnbound.join(", ")}`);
    if (raw.pathConsistency === "mixed") add(obl, "path consistency MIXED — the same answer took different routes");
    if (!REASON_VOCAB.includes(reason)) add(obl, `reason ${reason} is not in the frozen vocabulary (invariant I6)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------

function render(record, { dir, from }, { limit }) {
  const cases = caseIndex(record.source?.runDir ?? dir);
  const s = summarize(record, { cases });
  const c = record.counts ?? {};
  const L = [];
  const kv = (k, v) => L.push(`${k.padEnd(15)}${v}`);
  const counter = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("  ·  ");

  L.push(`==== RUN ${record.binding?.runId ?? "(unnamed)"} ${"=".repeat(Math.max(0, 58 - String(record.binding?.runId ?? "").length))}`);
  kv("revision", record.binding?.contractRevisionId ?? "(unsealed — this record carries no ContractRevision)");
  kv("denominator", `${record.denominator?.obligations ?? s.rows.length} obligations   (${s.rows.length} results)`);
  kv("status", `${record.status}   publishable=${record.publishable}`);
  if (!record.publishable) kv("unbindable", (record.unbindableFields ?? []).join("; ") || "(none stated)");
  kv("judgement", from === "cached" ? `read from ${dir}` : `judged from ${dir} (fixture keys — TEST-ONLY, not attested)`);
  if (!cases) kv("cases", "— not recorded on this run shape (no facetInstanceId in the run record); the case column reads '—'");
  L.push("");

  L.push(`VERDICT        ${counter(c.byVerdict)}`);
  L.push(`COVERAGE       ${counter(c.byCoverage)}`);
  L.push(`DISPOSITION    ${counter(c.byDisposition)}`);
  L.push("");

  L.push("REASON — group by CODE, not by row. The marked bucket is the next thing to fix.");
  for (const [reason, n] of s.reasons) {
    const mark = s.next && reason === s.next[0] ? ">>" : HEALTHY_REASONS.has(reason) ? " ·" : "  ";
    L.push(`  ${mark} ${String(n).padStart(4)}  ${reason}${HEALTHY_REASONS.has(reason) ? "   (healthy)" : ""}`);
  }
  L.push(s.next
    ? `  NEXT: ${s.next[0]} ×${s.next[1]} — largest non-healthy bucket, ${s.actionable.length} non-healthy code(s) in all`
    : "  NEXT: nothing — every reason code in this run is a healthy one");
  L.push("");

  const cov = Object.keys(c.byCoverage ?? {});
  L.push(`REASON × COVERAGE`);
  L.push(`  ${"reason".padEnd(36)}${cov.map((k) => k.padStart(13)).join("")}${"total".padStart(8)}`);
  for (const r of s.crosstab) {
    L.push(`  ${r.reason.padEnd(36)}${cov.map((k) => String(r.by[k] ?? 0).padStart(13)).join("")}${String(r.total).padStart(8)}`);
  }
  L.push("");

  L.push(`OBLIGATIONS (sectioned by reason, largest non-healthy first)`);
  L.push(`  ${"obl".padEnd(22)}${"case".padEnd(14)}${"verdict".padEnd(15)}${"coverage".padEnd(12)}${"reason".padEnd(36)}ev`);
  const shown = limit > 0 ? s.rows.slice(0, limit) : s.rows;
  let section = null;
  for (const r of shown) {
    if (r.reason !== section) { section = r.reason; L.push(`  ── ${section}`); }
    L.push(`  ${r.obl.padEnd(22)}${(r.case ?? "—").padEnd(14)}${r.verdict.padEnd(15)}${r.coverage.padEnd(12)}${r.reason.padEnd(36)}${r.ev}`);
  }
  if (shown.length < s.rows.length) L.push(`  … ${s.rows.length - shown.length} more (--rows 0 for all)`);
  L.push("");

  const f = flags(s.rows);
  L.push(`==== FLAGS ==== ${f.length} on ${new Set(f.map((x) => x.obl)).size} obligation(s)`);
  for (const x of f) L.push(`  ${x.obl.padEnd(22)}${x.msg}`);
  if (!f.length) L.push("  (none)");
  return { text: L.join("\n"), summary: s, flags: f };
}

if (path.resolve(process.argv[1] ?? "").toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const argv = process.argv.slice(2);
  const at = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
  const target = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--rows");
  const loaded = loadJudgement(target);
  const r = render(loaded.record, loaded, { limit: Number(at("--rows", "40")) });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ counts: loaded.record.counts, crosstab: r.summary.crosstab, next: r.summary.next, rows: r.summary.rows.map(({ raw, ...x }) => x), flags: r.flags }, null, 2));
  } else {
    console.log(r.text);
  }
}

export { render };
