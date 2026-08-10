#!/usr/bin/env node
/**
 * MUTATION HARNESS — the layer the repo's existing scorer lacks.
 *
 * scorer/docs/threat-model.md §11 says it plainly about the existing suite: "Passing this
 * suite means each listed threat produces its required output today; it does not mean a
 * regression in these gates would be caught." A measured sweep put that scorer's kill rate
 * at ~45%, with 16 gates individually deletable while all 285 assertions stayed green.
 *
 * So this harness ships WITH the self-tests rather than after them. It breaks one
 * load-bearing rule at a time and asserts at least one self-test turns red. A surviving
 * mutant is a gate nothing tests, and it is NAMED in the output rather than averaged away.
 *
 * `node evaluation/selftest/mutate.mjs` — exits non-zero if any mutant survives.
 */

import { scoreCorpus, RULES } from "../score.mjs";
import { runCases } from "./cases.mjs";

/**
 * Each mutation breaks exactly one rule, in the direction someone would plausibly break it
 * by accident or by wishful thinking. The comment on each says what it would let through.
 */
const MUTATIONS = {
  // §4.4 — the counter-intuitive rule, and the one most likely to be quietly softened.
  "ambiguity-guess-counts-as-correct": {
    scoreAmbiguityOutcome(kind) {
      if (kind === "surfaced" || kind === "guessed") return { correct: 1, guessed: 0, missed: 0 };
      return { correct: 0, guessed: 0, missed: 1 };
    },
  },

  // §4.3 — an over-flagger becomes free.
  "fp-weight-zero": {
    isFalsePositive() {
      return false;
    },
  },

  // §4.1 — the softer number becomes the headline.
  "lenient-matching-as-default": {
    aggregateRecall(tp, n) {
      return n === 0 ? null : Math.min(1, (tp * 1.5) / n);
    },
  },

  // §5.5 — duplicates start inflating recall.
  "duplicate-findings-inflate-recall": {
    classifyDuplicate() {
      return "true-positive";
    },
  },

  // §5.5 — half a defect becomes a unit.
  "under-split-awards-partial-credit": {
    underSplitCredit() {
      return { tpPerFinding: 2, partialCredit: 0.5 };
    },
  },

  // §4.5 — the arm's own coverage claim is believed.
  "coverage-claim-trusted-from-arm": {
    coverageClaimWitnessed() {
      return true;
    },
  },

  // §6.4 — the absolute floor disappears; noise becomes a result.
  "mcnemar-margin-dropped": {
    margin({ b, c }) {
      return b > c;
    },
  },

  // §6.4 — significance disappears; any gap wins.
  "mcnemar-significance-dropped": {
    margin({ b, c }) {
      return b - c >= 5;
    },
  },

  // §7.3 — the strongest anti-fudge rule in the document, switched off.
  "swing-check-disabled": {
    swingDominates() {
      return false;
    },
  },

  // arms/ARCHITECTURE.md §6 — a result nobody can tie to a build gets scored anyway, and
  // the number it produces reads exactly like evidence about an architecture. This is the
  // mutation that proves the identity gate is enforced rather than merely written down.
  "arm-identity-check-bypassed": {
    rejectOnArmIdentity() {
      return false;
    },
  },

  // §4.7 — a zero-detection arm becomes infinitely cheap.
  "cost-per-defect-zero-when-no-tp": {
    costPerDefect(usd, tp) {
      if (usd === null || usd === undefined) return null;
      return tp ? usd / tp : 0;
    },
  },

  // §8.2 — the freeze becomes advisory.
  "freeze-hash-check-bypassed": {
    freezeCheck() {
      return true;
    },
  },
};

/**
 * Some mutations are structural rather than rule-swaps: they change how the scorer is
 * called or what it is given. Kept separate so the report can say which is which.
 */
const STRUCTURAL_MUTATIONS = {
  // §4.1 — the mean of per-survey recalls instead of the aggregate over defects.
  "per-survey-mean-instead-of-aggregate-recall": (input) => {
    const card = scoreCorpus(input);
    for (const arm of Object.values(card.arms)) {
      const perSurvey = [];
      for (const s of input.surveys || []) {
        const n = (s.key?.defects || []).length;
        if (!n) continue;
        const found = arm.tpStrict.filter((r) => r.startsWith(`${s.surveyId}::`)).length;
        perSurvey.push(found / n);
      }
      arm.recallStrict = perSurvey.length ? perSurvey.reduce((a, b) => a + b, 0) / perSurvey.length : null;
    }
    return card;
  },

  // §3.3 — an arm may claim any mechanism it likes; the seam table becomes fiction.
  "attribution-constraint-dropped": (input) => {
    const stripped = {
      ...input,
      surveys: (input.surveys || []).map((s) => ({
        ...s,
        runs: (s.runs || []).map((r) => ({
          ...r,
          result: {
            ...r.result,
            findings: (r.result.findings || []).map((f) => ({ ...f, attribution: "unattributed" })),
          },
        })),
      })),
    };
    return scoreCorpus(stripped);
  },

  // §4.3 — clean controls stop mattering at all.
  "clean-control-fp-ignored": (input) => {
    const card = scoreCorpus(input);
    for (const arm of Object.values(card.arms)) {
      arm.cleanControlFp = 0;
      arm.flags = arm.flags.filter((f) => f !== "FP_HEAVY");
      arm.safetyViolations = arm.flags.filter((f) =>
        ["FP_HEAVY", "HEDGING", "COVERAGE_UNWITNESSED", "RUNS_INVALID"].includes(f),
      ).length;
    }
    card.ranking = Object.values(card.arms)
      .slice()
      .sort(
        (x, y) =>
          x.safetyViolations - y.safetyViolations ||
          (y.recallStrict ?? 0) - (x.recallStrict ?? 0) ||
          x.arm.localeCompare(y.arm),
      )
      .map((a, i) => ({ rank: i + 1, arm: a.arm, safetyViolations: a.safetyViolations, recallStrict: a.recallStrict }));
    return card;
  },

  // §5.5 — queued items get silently scored as matches instead of going to review.
  "queue-items-silently-scored-as-matches": (input) => {
    const card = scoreCorpus(input);
    for (const q of card.queue) {
      if (!q.arm || !q.candidateDefectIds?.length) continue;
      const arm = card.arms[q.arm];
      if (!arm) continue;
      for (const d of q.candidateDefectIds) {
        const ref = `${q.surveyId}::${d}`;
        if (!arm.tpStrict.includes(ref)) arm.tpStrict.push(ref);
        arm.missed = arm.missed.filter((m) => m !== ref);
      }
    }
    card.queue = [];
    card.headline.adjudicationQueueSize = 0;
    card.headline.adjudicationRate = 0;
    card.inconclusive = card.inconclusive.filter((i) => i.code !== "QUEUE_DOMINATED");
    for (const c of card.comparisons) {
      c.queueDominated = false;
      c.decision = c.pointDecision;
      c.reportable = true;
    }
    return card;
  },
};

// ---------------------------------------------------------------------------

const baseline = runCases((input) => scoreCorpus(input));
const baselineFailed = baseline.filter((r) => !r.ok);
if (baselineFailed.length) {
  console.log("BASELINE IS RED — fix the self-tests before measuring mutants.\n");
  for (const f of baselineFailed) console.log(`  FAIL ${f.name}: ${f.error}`);
  console.log(`\nMUTATION 0/0 (baseline red)`);
  process.exit(1);
}

const rows = [];

for (const [name, mutations] of Object.entries(MUTATIONS)) {
  // The effective rule table is passed to the cases too, so a rule exercised OUTSIDE
  // scoreCorpus (the freeze check) still sees its mutation. Without this, such a rule
  // would look protected while being reachable by nothing.
  const results = runCases((input) => scoreCorpus(input, { mutations }), { ...RULES, ...mutations });
  const killedBy = results.filter((r) => !r.ok).map((r) => r.name);
  rows.push({ name, kind: "rule", killed: killedBy.length > 0, killedBy });
}

for (const [name, fn] of Object.entries(STRUCTURAL_MUTATIONS)) {
  const results = runCases(fn);
  const killedBy = results.filter((r) => !r.ok).map((r) => r.name);
  rows.push({ name, kind: "structural", killed: killedBy.length > 0, killedBy });
}

const survivors = rows.filter((r) => !r.killed);
const killRate = rows.length ? (rows.length - survivors.length) / rows.length : 0;

console.log("mutation                                            kind        result   killed by");
for (const r of rows) {
  console.log(
    `${r.name.padEnd(50)}${r.kind.padEnd(12)}${(r.killed ? "KILLED" : "SURVIVED").padEnd(9)}` +
      `${r.killedBy.slice(0, 2).join(", ")}${r.killedBy.length > 2 ? ` (+${r.killedBy.length - 2})` : ""}`,
  );
}

console.log(`\nMUTATION ${rows.length - survivors.length}/${rows.length} killed — kill rate ${(killRate * 100).toFixed(0)}%`);

if (survivors.length) {
  console.log("\nSURVIVING MUTANTS — these are gates nothing in this suite enforces.");
  console.log("They are NAMED here rather than averaged away, and they must be named in the");
  console.log("final report as limits on what the self-tests prove:");
  for (const s of survivors) console.log(`  - ${s.name}`);
  process.exit(1);
}
process.exit(0);
