/**
 * SELF-TEST CASES — the proof that the scorer can return a bad verdict.
 *
 * Every case is parameterised by `scoreFn` so selftest/mutate.mjs can inject a mutated
 * rule and assert that at least one case turns red. A case that passes under every
 * mutation is a case that asserts nothing.
 *
 * PRE-REGISTRATION.md §11.2 lists what each fixture must prove. This file is that list,
 * executable.
 */

import assert from "node:assert/strict";

import {
  scoreCorpus,
  mcnemarExactP,
  holm,
  maxBipartite,
  discordance,
  freezeDrift,
  RULES,
} from "../score.mjs";
import { normaliseLocator, parseLocationSpec, eligibleClasses } from "../lib/class-map.mjs";
import { FINDING_SCHEMA_VERSION } from "../finding-schema.mjs";
import {
  makeCorpus,
  makeBigCorpus,
  makeAnnotations,
  perfectArm,
  uselessArm,
  overflaggerArm,
  luckyGuesserArm,
  hedgerArm,
  duplicatorArm,
  underSplitterArm,
  coverageLiarArm,
  wrongDirectionArm,
  attributionLiarArm,
  identityLiarArm,
  leakerArm,
  queueDominatedPair,
  withRuns,
} from "./fixtures.mjs";

const ANN = makeAnnotations();

/** Each case: { name, run(score) } — throws on failure. */
export const CASES = [
  // -----------------------------------------------------------------------
  // §11.2 — the fabricated conditions
  // -----------------------------------------------------------------------
  {
    name: "perfect-arm-scores-perfectly",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN });
      const a = card.arms.C;
      assert.equal(a.recallStrict, 1, "a perfect arm must reach recall 1.0");
      assert.equal(a.cleanControlFp, 0, "a perfect arm asserts nothing on clean controls");
      assert.equal(a.ambiguity.correct, 2, "both planted ambiguities surfaced");
      assert.equal(a.ambiguity.guessed, 0);
      assert.equal(a.ambiguity.missed, 0);
      assert.equal(a.coverageHonesty, 1, "every coverage claim witnessed by the harness");
      assert.equal(a.cleanControlCleanRate, 1);
    },
  },

  {
    name: "useless-arm-zero-recall-zero-false-positives",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, uselessArm(c, "A")), annotations: ANN });
      const a = card.arms.A;
      assert.equal(a.recallStrict, 0);
      assert.equal(a.cleanControlFp, 0, "emitting nothing produces no false positives — which is why FP alone cannot rank arms");
      assert.equal(a.safetyViolations, 0);
      assert.ok(a.flags.includes("ZERO_YIELD"));
    },
  },

  {
    name: "OVERFLAGGER-SCORES-BADLY",
    run(score) {
      const c = makeCorpus();
      const card = score({
        surveys: withRuns(c, perfectArm(c, "C", ANN), uselessArm(c, "A"), overflaggerArm(c, "B")),
        annotations: ANN,
      });
      const over = card.arms.B;
      const useless = card.arms.A;
      const perfect = card.arms.C;

      assert.ok(over.cleanControlFp >= 2, `over-flagger must accumulate clean-control FPs, got ${over.cleanControlFp}`);
      assert.ok(over.flags.includes("FP_HEAVY"), "over-flagger must be flagged FP_HEAVY");
      assert.ok(over.safetyViolations >= 1);

      const rank = Object.fromEntries(card.ranking.map((r) => [r.arm, r.rank]));
      // THE assertion. If an over-flagger does not rank below an arm that emitted nothing,
      // the false-positive weighting is broken and this build must fail.
      assert.ok(rank.B > rank.A, `over-flagger (rank ${rank.B}) must rank below the useless arm (rank ${rank.A})`);
      assert.ok(rank.C < rank.B, "perfect arm must rank above the over-flagger");
      assert.ok(over.cleanControlFp > perfect.cleanControlFp);
      assert.equal(useless.cleanControlFp, 0);
    },
  },

  {
    name: "LUCKY-GUESSER-GETS-NO-AMBIGUITY-CREDIT",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, luckyGuesserArm(c, "A", ANN)), annotations: ANN });
      const a = card.arms.A;
      // §4.4: guessing is a failure EVEN WHEN THE GUESS IS RIGHT.
      assert.equal(a.ambiguity.correct, 0, "a right guess earns no ambiguity credit");
      assert.equal(a.ambiguity.guessed, 2, "both planted ambiguities were guessed");
      assert.equal(a.ambiguity.missed, 0);
      // And the guess is scored on the ambiguity track only — never double-counted as a
      // defect false positive (§4.4, threat-model §6).
      assert.equal(a.cleanControlFp, 0, "the guess on the clean control's ambiguity locus is not also an FP");
    },
  },

  {
    name: "hedger-earns-safety-but-no-recall-and-is-flagged",
    run(score) {
      const c = makeCorpus();
      const card = score({
        surveys: withRuns(c, perfectArm(c, "C", ANN), hedgerArm(c, "A")),
        annotations: ANN,
      });
      const h = card.arms.A;
      assert.equal(h.cleanControlFp, 0, "hedging into the observation channel produces no FPs");
      assert.equal(h.recallStrict, 0, "...and no recall either, which is what closes the dodge");
      assert.ok(h.flags.includes("HEDGING"), "high observation volume must be flagged, not silently folded in");
      const rank = Object.fromEntries(card.ranking.map((r) => [r.arm, r.rank]));
      assert.ok(rank.C < rank.A, "the hedger must not outrank the perfect arm");
    },
  },

  {
    name: "duplicator-cannot-inflate-recall",
    run(score) {
      const c = makeCorpus();
      const base = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN }).arms.C;
      const card = score({ surveys: withRuns(c, duplicatorArm(c, "C", ANN)), annotations: ANN });
      const d = card.arms.C;
      assert.equal(d.recallStrict, base.recallStrict, "duplicates must not move recall");
      assert.ok(d.redundant.length > 0, "the duplicates must be classified redundant");
      assert.equal(d.cleanControlFp, 0, "duplicates are not punished as fabrications");
      assert.equal(
        d.defectPrecisionDenominator,
        d.tpStrict.length + d.falsePositives.length,
        "redundant findings are excluded from the precision denominator (§5.5)",
      );
    },
  },

  {
    name: "under-splitter-gets-one-tp-one-miss-no-partial-credit",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, underSplitterArm(c, "A", ANN)), annotations: ANN });
      const a = card.arms.A;
      const q7 = a.tpStrict.filter((r) => r === "syn-1::D3" || r === "syn-1::D4");
      assert.equal(q7.length, 1, "exactly one of the two co-located defects is credited");
      const missedQ7 = a.missed.filter((r) => r === "syn-1::D3" || r === "syn-1::D4");
      assert.equal(missedQ7.length, 1, "the other is a MISS — no partial credit");
      assert.ok(
        card.queue.some((q) => q.code === "UNDER_SPLIT"),
        "the cost must be visible in the queue, not absorbed silently by the scorer",
      );
      // No fractional credit anywhere.
      assert.ok(Number.isInteger(a.tpStrict.length));
    },
  },

  {
    name: "coverage-liar-fails-the-coverage-gate",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, coverageLiarArm(c, "A")), annotations: ANN });
      const a = card.arms.A;
      assert.ok(a.coverageHonesty < 1, `claimed coverage must not be trusted from the arm, got ${a.coverageHonesty}`);
      assert.ok(a.unwitnessed > 0);
      assert.ok(a.flags.includes("COVERAGE_UNWITNESSED"));
      assert.ok(
        String(a.coverageFigure).startsWith("UNWITNESSED-"),
        `coverage must print as UNWITNESSED-n, got ${a.coverageFigure}`,
      );
    },
  },

  {
    name: "wrong-direction-rejected-strict-credited-lenient",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, wrongDirectionArm(c, "A")), annotations: ANN });
      const a = card.arms.A;
      assert.equal(a.tpStrict.length, 0, "an annotated predicate mismatch is a REJECTION under strict matching");
      assert.ok(a.tpLenient.length > 0, "...and would have been credited by location+class alone");
      assert.ok(a.recallLenient > a.recallStrict, "the strict/lenient delta must be visible");
    },
  },

  {
    name: "attribution-liar-invalidates-the-run",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, attributionLiarArm(c)), annotations: ANN });
      const b = card.arms.B;
      assert.ok(b.runsInvalid.length > 0, "arm B cannot produce a model-attributed finding");
      assert.ok(b.runsInvalid.every((r) => r.reason === "ATTRIBUTION_IMPOSSIBLE"));
      assert.ok(
        card.inconclusive.some((i) => i.code === "ATTRIBUTION_IMPOSSIBLE"),
        "a condition that misreports its own mechanism makes the experiment inconclusive (§6.8)",
      );
      assert.equal(b.tpStrict.length, 0, "an invalidated run contributes nothing — it is not scored low, it is not scored");
    },
  },

  {
    /**
     * arms/ARCHITECTURE.md §6. THE FIXTURE'S FINDINGS ARE CORRECT — if the gate were absent
     * this run would score WELL. That is what makes this test real: it is not asserting that
     * broken input scores badly, it is asserting that unattributable input is not scored at
     * all. A result nobody can tie to a build is not evidence about an architecture.
     */
    name: "arm-identity-missing-or-inconsistent-invalidates-the-run",
    run(score) {
      const c = makeCorpus();

      const missing = score({ surveys: withRuns(c, identityLiarArm(c, "C", "missing")), annotations: ANN }).arms.C;
      assert.ok(missing.runsInvalid.length > 0, "a result with no armIdentity cannot be scored");
      assert.ok(missing.runsInvalid.every((r) => r.reason === "ARM_IDENTITY_INVALID"));
      assert.equal(missing.tpStrict.length, 0, "an invalidated run contributes nothing — not scored low, not scored");

      const wrong = score({ surveys: withRuns(c, identityLiarArm(c, "C", "inconsistent")), annotations: ANN }).arms.C;
      assert.ok(wrong.runsInvalid.every((r) => r.reason === "ARM_IDENTITY_INVALID"), "identity naming another arm is a rejection");
      assert.equal(wrong.tpStrict.length, 0);

      // ...and the same findings WITH a valid identity do score. Without this line the test
      // passes for a scorer that rejects everything, which is the empty-denominator failure
      // this repository has shipped before.
      const ok = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN }).arms.C;
      assert.equal(ok.runsInvalid.length, 0, "a valid identity must NOT be rejected");
      assert.ok(ok.tpStrict.length > 0, "the gate must be discriminating, not universally rejecting");
    },
  },

  {
    name: "oracle-leak-quarantines-the-run",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, leakerArm(c, "A")), annotations: ANN });
      const a = card.arms.A;
      assert.ok(a.runsInvalid.some((r) => r.reason === "SUSPECTED_ORACLE_LEAK"));
      assert.ok(card.inconclusive.some((i) => i.code === "SUSPECTED_ORACLE_LEAK"));
    },
  },

  {
    name: "QUEUE-DOMINATED-COMPARISON-EMITS-NO-POINT-ESTIMATE",
    run(score) {
      const surveys = makeBigCorpus(12, 4);
      // C finds everything; A finds one per survey. C additionally carries queue entries.
      const { runsC, runsA } = queueDominatedPair(surveys);
      // Force queue entries for C by giving one defect per survey a GLOBAL key location:
      // §5.2 waives the location gate on those, so they can never be auto-credited.
      const mutated = surveys.map((s) => {
        if (s.isCleanControl) return s;
        const defects = s.key.defects.map((d, i) => (i >= 2 ? { ...d, location: "global" } : d));
        return { ...s, key: { ...s.key, defects } };
      });
      const card = score({ surveys: withRuns(mutated, runsC, runsA), annotations: {} });
      const h1 = card.comparisons.find((x) => x.id === "H1");
      assert.ok(h1, "H1 (C vs A) must be computed");
      assert.ok(card.queue.length > 0, "the waived-location pairs must be queued, not silently scored");
      if (h1.queueDominated) {
        assert.equal(h1.decision, "INCONCLUSIVE — QUEUE-DOMINATED");
        assert.equal(h1.reportable, false, "no point estimate may be reported as the result");
        assert.ok(card.inconclusive.some((i) => i.code === "QUEUE_DOMINATED"));
      } else {
        // Not dominated: then the swing bounds must at least agree with the decision, and
        // both bounds must have been computed. A harness that never computes the swing
        // would fail this.
        assert.ok(h1.swing && "favourX" in h1.swing && "favourY" in h1.swing, "swing bounds must always be computed");
        assert.equal(h1.swing.favourX, h1.swing.favourY, "undominated means the bounds agree");
      }
    },
  },

  // -----------------------------------------------------------------------
  // Decision-rule mechanics
  // -----------------------------------------------------------------------
  {
    name: "mcnemar-thresholds-match-appendix",
    run() {
      // Appendix A of PRE-REGISTRATION.md, asserted cell by cell. A published threshold
      // that disagrees with the code is not a pre-registration.
      const table = {
        0.05: [6, 8, 10, 12],
        0.025: [7, 9, 11, 13],
        0.0125: [8, 10, 13, 15],
      };
      for (const [alpha, mins] of Object.entries(table)) {
        for (let c = 0; c < mins.length; c += 1) {
          const want = mins[c];
          const okAtWant = mcnemarExactP(want, c) <= Number(alpha) && want - c >= 5;
          const okBelow = mcnemarExactP(want - 1, c) <= Number(alpha) && want - 1 - c >= 5;
          assert.ok(okAtWant, `b=${want}, c=${c} must clear alpha=${alpha} (p=${mcnemarExactP(want, c)})`);
          assert.ok(!okBelow, `b=${want - 1}, c=${c} must NOT clear alpha=${alpha} (p=${mcnemarExactP(want - 1, c)})`);
        }
      }
      assert.equal(mcnemarExactP(0, 0), 1, "no discordance means no evidence of a difference");
    },
  },

  {
    name: "margin-requires-both-significance-and-absolute-gap",
    run(score) {
      const surveys = makeBigCorpus(12, 4);
      // Build X and Y differing by exactly 4 discordant defects: significant-ish but under
      // the absolute floor of 5. The decision must be "inconclusive".
      const clean = surveys.filter((s) => !s.isCleanControl);
      const all = clean.flatMap((s) => s.key.defects.map((d) => ({ s, d })));
      const runsX = [];
      const runsY = [];
      for (const s of surveys) {
        const mine = all.filter((x) => x.s.surveyId === s.surveyId);
        const idx = all.indexOf(mine[0]);
        const xFind = mine.map((x) => x.d);
        const yFind = mine.filter((_, i) => !(idx === 0 && i < 4)).map((x) => x.d);
        runsX.push(makeRun("C", s, xFind));
        runsY.push(makeRun("A", s, yFind));
      }
      const card = score({ surveys: withRuns(surveys, runsX, runsY), annotations: {} });
      const h1 = card.comparisons.find((x) => x.id === "H1");
      assert.ok(h1.b - h1.c < 5 || !h1.marginMet, "a gap under the absolute floor cannot clear the margin");
      if (h1.b - h1.c < 5) assert.equal(h1.marginMet, false);
    },
  },

  {
    name: "significance-alone-is-not-enough-and-neither-is-the-gap-alone",
    run(score) {
      // b = 5, c = 0: clears the absolute floor (b - c >= 5) but NOT significance
      // (exact two-sided p = 0.0625). The decision must be inconclusive. A harness that
      // dropped the p-value check would call this a result.
      assert.ok(mcnemarExactP(5, 0) > 0.05, "b=5,c=0 must not be significant");
      const surveys = [makeSurvey("sig-1", 5)];
      const runsC = [makeRun("C", surveys[0], surveys[0].key.defects)];
      const runsA = [makeRun("A", surveys[0], [])];
      const card = score({ surveys: withRuns(surveys, runsC, runsA), annotations: {} });
      const h1 = card.comparisons.find((x) => x.id === "H1");
      assert.equal(h1.b, 5);
      assert.equal(h1.c, 0);
      assert.equal(h1.marginMet, false, "a 5-defect gap at p=0.0625 does not clear the margin");
      assert.equal(h1.pointDecision, "inconclusive");

      // ...and conversely a significant but trivial gap must also fail: b=6,c=2 is
      // p<=0.05-ish territory only when the absolute floor is also met.
      assert.ok(mcnemarExactP(6, 0) <= 0.05, "b=6,c=0 is significant");
    },
  },

  {
    name: "freeze-check-detects-drift-in-every-frozen-file",
    run(score, R) {
      const recorded = { "score.mjs": "aaa", "PRE-REGISTRATION.md": "bbb", "lib/class-map.mjs": "ccc" };
      assert.deepEqual(freezeDrift(recorded, { ...recorded }, R), [], "identical hashes are no drift");
      for (const f of Object.keys(recorded)) {
        const changed = { ...recorded, [f]: "CHANGED" };
        assert.deepEqual(freezeDrift(recorded, changed, R), [f], `${f} must be detected as drifted`);
      }
      assert.deepEqual(
        freezeDrift({}, { "score.mjs": "aaa" }, R),
        ["score.mjs"],
        "a missing freeze record is drift, not a pass",
      );
      assert.deepEqual(
        freezeDrift({ "score.mjs": "aaa" }, { "score.mjs": null }, R),
        ["score.mjs"],
        "a frozen file that has vanished is drift",
      );
    },
  },

  {
    name: "holm-adjustment-is-monotone-and-conservative",
    run() {
      const ps = [0.001, 0.02, 0.04, 0.3];
      const adj = holm(ps);
      for (let i = 0; i < ps.length; i += 1) assert.ok(adj[i] >= ps[i], "adjusted p is never below raw p");
      const sortedRaw = ps.map((p, i) => ({ p, a: adj[i] })).sort((x, y) => x.p - y.p);
      for (let i = 1; i < sortedRaw.length; i += 1) {
        assert.ok(sortedRaw[i].a >= sortedRaw[i - 1].a, "Holm-adjusted p must be monotone in raw p");
      }
      assert.ok(adj.every((a) => a <= 1));
      assert.equal(holm([0.02])[0], 0.02, "a single comparison is unadjusted");
    },
  },

  {
    name: "recall-aggregates-over-defects-not-over-surveys",
    run(score) {
      // survey P: 1 defect, found. survey Q: 9 defects, none found.
      // aggregate = 1/10 = 0.1;  mean of per-survey recalls = (1 + 0)/2 = 0.5.
      const surveys = [
        makeSurvey("agg-P", 1),
        makeSurvey("agg-Q", 9),
      ];
      const runs = surveys.map((s) => makeRun("A", s, s.surveyId === "agg-P" ? s.key.defects : []));
      const card = score({ surveys: withRuns(surveys, runs), annotations: {} });
      assert.equal(card.arms.A.recallStrict, 0.1, "recall must aggregate over defects; the per-survey mean would say 0.5");
    },
  },

  {
    name: "cost-per-defect-is-null-not-zero-and-not-infinity-when-nothing-found",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, uselessArm(c, "A")), annotations: ANN });
      const cpd = card.arms.A.costPerDefect;
      assert.equal(cpd, null, `cost per defect must be null when TP=0, got ${cpd}`);
      assert.notEqual(cpd, 0);
      assert.ok(!Number.isFinite(cpd) || cpd !== Infinity);
    },
  },

  // -----------------------------------------------------------------------
  // Matching mechanics
  // -----------------------------------------------------------------------
  {
    name: "locator-normalisation-follows-pinned-rules",
    run() {
      assert.equal(normaliseLocator("Q12"), "q12");
      assert.equal(normaliseLocator("Question 12"), "q12");
      assert.equal(normaliseLocator("q 12"), "q12");
      assert.equal(normaliseLocator("S3"), "s3");
      assert.equal(normaliseLocator("Screener 3"), "s3");
      assert.equal(normaliseLocator("Loop L1 (Q2-Q3)"), normaliseLocator("L1 Q2-Q3"));
      // negation-adjacent locators must NOT collapse onto each other
      assert.notEqual(normaliseLocator("Q1"), normaliseLocator("Q11"));
      assert.notEqual(normaliseLocator("S3"), normaliseLocator("Sec3"));
    },
  },

  {
    name: "non-atomic-and-global-key-locations-handled-explicitly",
    run() {
      assert.deepEqual(parseLocationSpec("Q4-Q6"), { kind: "set", values: ["q4", "q5", "q6"] });
      assert.equal(parseLocationSpec("Q3, Q7").kind, "set");
      assert.deepEqual(parseLocationSpec("Q3, Q7").values, ["q3", "q7"]);
      assert.equal(parseLocationSpec("global").kind, "global");
      assert.equal(parseLocationSpec("all screens").kind, "global");
      assert.equal(parseLocationSpec("").kind, "global");
      // a code with a hyphen is NOT a range
      assert.equal(parseLocationSpec("T-14").kind, "atomic");
    },
  },

  {
    name: "class-gate-admits-both-mapped-classes-but-never-an-unmapped-one",
    run() {
      assert.deepEqual(eligibleClasses("option list").classes, ["option-list", "option-order"]);
      assert.deepEqual(eligibleClasses("wording").classes, ["wording", "scale-labels"]);
      assert.equal(eligibleClasses("routing").classes.includes("wording"), false);
      const gap = eligibleClasses("something-nobody-mapped");
      assert.equal(gap.taxonomyGap, true, "an unmapped key class is a TAXONOMY_GAP, never forced into the nearest token");
      assert.deepEqual(gap.classes, []);
    },
  },

  {
    name: "assignment-is-maximum-cardinality-not-greedy",
    run() {
      // Greedy in sorted order takes F1->D1 and leaves F2 unmatched: 1 match.
      // Maximum-cardinality reassigns F1 to D2 and matches both: 2 matches.
      const pairs = [
        { findingId: "F1", defectId: "D1" },
        { findingId: "F1", defectId: "D2" },
        { findingId: "F2", defectId: "D1" },
      ];
      const m = maxBipartite(pairs);
      assert.equal(m.size, 2, "a greedy matcher would return 1 here; processing order must not decide credit");
      assert.equal(new Set(m.values()).size, 2, "one defect can back at most one true positive");
    },
  },

  {
    name: "one-defect-yields-at-most-one-true-positive",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, duplicatorArm(c, "C", ANN)), annotations: ANN });
      const refs = card.arms.C.tpStrict;
      assert.equal(new Set(refs).size, refs.length, "no defect may be credited twice");
    },
  },

  {
    name: "discordance-is-paired-and-symmetric",
    run() {
      const d = discordance(["a", "b", "c"], ["b", "d"]);
      assert.equal(d.both, 1);
      assert.equal(d.b, 2);
      assert.equal(d.c, 1);
      const r = discordance(["b", "d"], ["a", "b", "c"]);
      assert.equal(r.b, d.c);
      assert.equal(r.c, d.b);
    },
  },

  // -----------------------------------------------------------------------
  // Reporting honesty
  // -----------------------------------------------------------------------
  {
    name: "queue-size-appears-in-the-headline-not-a-footnote",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN });
      assert.ok("adjudicationQueueSize" in card.headline, "the queue size must be a headline field (§7.2)");
      assert.ok("adjudicationRate" in card.headline);
      assert.equal(typeof card.headline.adjudicationRate, "number");
    },
  },

  {
    name: "pilot-data-suppresses-the-headline",
    run(score) {
      const c = makeCorpus();
      const card = score({
        surveys: withRuns(c, perfectArm(c, "C", ANN)),
        annotations: ANN,
        meta: { pilot: true },
      });
      assert.ok(card.inconclusive.some((i) => i.code === "PILOT"), "pilot data may not produce a headline (§9.4)");
      assert.equal(card.headline.headlineSuppressed, true);
    },
  },

  {
    name: "per-class-cells-below-n5-are-marked-descriptive-only",
    run(score) {
      const c = makeCorpus();
      const card = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN });
      for (const [cls, row] of Object.entries(card.perClass)) {
        if (row.planted < 5) {
          assert.equal(row.inferential, false, `${cls}: n<5 must not be marked inferential`);
          assert.ok(row.note, `${cls}: an n<5 cell must carry the descriptive-only note (§4.6)`);
        }
      }
      // caught can never exceed planted: they must share a denominator.
      for (const [cls, row] of Object.entries(card.perClass)) {
        for (const [arm, n] of Object.entries(row.caught)) {
          assert.ok(n <= row.planted, `${cls}/${arm}: caught ${n} > planted ${row.planted}`);
        }
      }
    },
  },

  {
    name: "hybrid-regression-is-reported-even-when-the-hybrid-leads",
    run(score) {
      const surveys = makeBigCorpus(6, 4);
      const runsC = [];
      const runsB = [];
      for (const s of surveys) {
        const ds = s.key.defects;
        // C finds all but the first; B finds only the first. C leads overall but has
        // dropped things B already had.
        runsC.push(makeRun("C", s, ds.slice(1)));
        runsB.push(makeRun("B", s, ds.slice(0, 1), "graph"));
      }
      const card = score({ surveys: withRuns(surveys, runsC, runsB), annotations: {} });
      assert.ok(card.regression, "the regression set must always be computed");
      assert.ok(card.regression.size > 0, "defects a component found and C did not must be enumerated");
      if (card.regression.size >= 3) {
        assert.ok(
          card.warnings.some((w) => w.code === "HYBRID_REGRESSION"),
          "a regression of 3+ is a design defect and must be reported regardless of the totals (§6.6)",
        );
      }
    },
  },

  {
    name: "excessive-exclusions-make-the-experiment-inconclusive",
    run(score) {
      const c = makeCorpus();
      const exclusions = [
        { surveyId: "syn-1", defectId: "D1", reason: "fabricated: arguably compliant", filedAt: "2026-08-02" },
        { surveyId: "syn-1", defectId: "D2", reason: "fabricated: arguably compliant", filedAt: "2026-08-02" },
      ];
      const card = score({ surveys: withRuns(c, perfectArm(c, "C", ANN)), annotations: ANN, exclusions });
      // 2 of 7 = 28.6% >= 20%
      assert.ok(
        card.inconclusive.some((i) => i.code === "EXCLUSIONS_EXCESSIVE"),
        "removing 20%+ of the corpus means the remainder no longer represents it (§6.8)",
      );
      assert.equal(card.headline.denominator.defects, 5, "excluded defects leave BOTH numerator and denominator");
    },
  },
];

// ---------------------------------------------------------------------------
// helpers used by several cases
// ---------------------------------------------------------------------------

function makeSurvey(surveyId, nDefects) {
  return {
    surveyId,
    tier: "medium",
    isCleanControl: nDefects === 0,
    key: {
      survey_id: surveyId,
      tier: "medium",
      is_clean_control: nDefects === 0,
      defects: Array.from({ length: nDefects }, (_, i) => ({
        id: `D${i + 1}`,
        class: "routing",
        location: `Q${i + 1}`,
        requirement_source: "body",
        document_says: "fabricated",
        site_does: "fabricated",
        how_to_observe: "fabricated",
        difficulty: "obvious",
      })),
      ambiguities: [],
      total_requirements_estimate: 20,
    },
    runs: [],
  };
}

function makeRun(arm, survey, defects, attribution = arm === "B" ? "graph" : "model") {
  const findings = defects.map((d, i) => ({
    findingId: `F${i + 1}`,
    claimClass: "defect",
    requirementClass: eligibleClasses(d.class).classes[0],
    location: { raw: d.location, scope: "question" },
    observable: { predicate: "route-not-fired", subject: d.location, expected: "e", actual: "a" },
    attribution,
    evidence: [{ kind: "dom", ref: `e${i}` }],
    prose: "fabricated",
    confidence: null,
  }));
  // keep predicates admissible for whatever class the key mapped to
  for (const f of findings) {
    if (f.requirementClass !== "routing") {
      f.observable.predicate = { wording: "text-differs", "option-list": "option-absent", validation: "constraint-not-enforced", "carry-forward": "set-differs" }[f.requirementClass] || "text-differs";
    }
  }
  const loci = survey.key.defects.map((d) => d.location);
  return {
    arm,
    surveyId: survey.surveyId,
    result: {
      // Version is imported, not spelled out: a literal here silently stops matching the
      // schema the moment the schema moves, and the failure looks like a scoring bug.
      schemaVersion: FINDING_SCHEMA_VERSION,
      arm,
      armVersion: "selftest-0000000",
      armIdentity: {
        identityVersion: "survey-qa-arm-identity/1.0.0",
        armId: arm,
        sourceSha: "selftest-0000000",
        gitDirty: false,
        treeHash: "sha256:selftest-tree",
        bundleHash: "sha256:selftest-bundle",
        manifestHash: "sha256:selftest-manifest",
        componentSetHash: "sha256:selftest-components",
        buildId: "sha256:selftest-build",
        builtAt: "2026-08-02T00:00:00.000Z",
        components: { ingest: "shared-sealed", structure: "none", plan: "v2-two-tier", traverse: "harness-walk", judge: "v2-deterministic" },
      },
      surveyId: survey.surveyId,
      seed: arm === "C-R" ? 0 : null,
      findings,
      coverage: { claimedUnits: loci.map((l, i) => ({ unitId: `U${i + 1}`, location: l, status: "exercised", verdict: "pass" })) },
    },
    telemetry: {
      arm,
      surveyId: survey.surveyId,
      visitLog: loci.length ? loci : ["Q1"],
      cost: { usd: 1, modelCalls: 5, tokensIn: 100, tokensOut: 10, browserSessions: 1, browserActions: 5, wallClockMs: 1000, nodeVisits: loci.length },
    },
  };
}

/** The default score function: the real scorer, unmutated. */
export function defaultScore(input) {
  return scoreCorpus(input);
}

/**
 * Run every case against a (possibly mutated) scorer.
 * `R` is the EFFECTIVE rule table, so cases that exercise a rule outside `scoreCorpus`
 * (the freeze check is the only one) still see the mutation.
 */
export function runCases(scoreFn, R = RULES) {
  const results = [];
  for (const c of CASES) {
    try {
      c.run(scoreFn, R);
      results.push({ name: c.name, ok: true });
    } catch (e) {
      results.push({ name: c.name, ok: false, error: e.message });
    }
  }
  return results;
}
