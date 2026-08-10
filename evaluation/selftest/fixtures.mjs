/**
 * SELF-TEST FIXTURES — entirely fabricated.
 *
 * No answer key from `test-suite/blind/` is read, imported, or referenced here or anywhere
 * else in `evaluation/selftest/`. These surveys, defects and ambiguities were invented for
 * the tests. The blind corpus is untouched by the suite that proves the scorer works.
 */

import { eligibleClasses, CLASS_PREDICATES } from "../lib/class-map.mjs";
import { FINDING_SCHEMA_VERSION } from "../finding-schema.mjs";

const def = (id, cls, location) => ({
  id,
  class: cls,
  location,
  requirement_source: "body",
  document_says: `fabricated: ${location} should behave one way`,
  site_does: `fabricated: ${location} behaves another way`,
  how_to_observe: `fabricated: reach ${location} and look`,
  difficulty: "obvious",
});

const amb = (id, location) => ({
  id,
  location,
  why_unresolvable: "fabricated: the document does not resolve this case",
  expected_system_behaviour: "surface as a question to the user",
  wrong_behaviours: ["report as defect", "silently assume one reading"],
});

/**
 * The base corpus: 2 defective surveys (7 defects, 2 of them co-located at one locus so
 * Tier 2 / Tier 3 / UNDER_SPLIT are exercised), 2 clean controls, 2 ambiguities.
 */
export function makeCorpus() {
  return [
    {
      surveyId: "syn-1",
      tier: "medium",
      isCleanControl: false,
      key: {
        survey_id: "syn-1",
        tier: "medium",
        is_clean_control: false,
        defects: [
          def("D1", "routing", "Q3"),
          def("D2", "wording", "Q5"),
          def("D3", "option list", "Q7"), // co-located with D4 on purpose
          def("D4", "option list", "Q7"),
        ],
        ambiguities: [amb("A1", "Q9")],
        total_requirements_estimate: 20,
      },
      runs: [],
    },
    {
      surveyId: "syn-2",
      tier: "hard",
      isCleanControl: false,
      key: {
        survey_id: "syn-2",
        tier: "hard",
        is_clean_control: false,
        defects: [def("D1", "validation", "Q2"), def("D2", "carry-forward", "Q4"), def("D3", "routing", "Q6")],
        ambiguities: [],
        total_requirements_estimate: 16,
      },
      runs: [],
    },
    {
      surveyId: "syn-3",
      tier: "ultra",
      isCleanControl: true,
      key: {
        survey_id: "syn-3",
        tier: "ultra",
        is_clean_control: true,
        defects: [],
        ambiguities: [amb("A1", "Q6")],
        total_requirements_estimate: 14,
      },
      runs: [],
    },
    {
      surveyId: "syn-4",
      tier: "easy",
      isCleanControl: true,
      key: {
        survey_id: "syn-4",
        tier: "easy",
        is_clean_control: true,
        defects: [],
        ambiguities: [],
        total_requirements_estimate: 12,
      },
      runs: [],
    },
  ];
}

/** Annotations that disambiguate the co-located pair (§5.4 Tier 3). */
export function makeAnnotations() {
  return {
    "syn-1::D3": { predicate: "option-absent", authoredAt: "2026-08-02T00:00:00Z" },
    "syn-1::D4": { predicate: "option-order-differs", authoredAt: "2026-08-02T00:00:00Z" },
  };
}

/** A larger corpus for the decision-rule tests, where n matters. */
export function makeBigCorpus(nSurveys = 12, defectsPer = 4) {
  const surveys = [];
  for (let s = 1; s <= nSurveys; s += 1) {
    const clean = s > nSurveys - 3;
    const defects = clean
      ? []
      : Array.from({ length: defectsPer }, (_, i) => def(`D${i + 1}`, "routing", `Q${i + 1}`));
    surveys.push({
      surveyId: `big-${String(s).padStart(2, "0")}`,
      tier: "medium",
      isCleanControl: clean,
      key: {
        survey_id: `big-${s}`,
        tier: "medium",
        is_clean_control: clean,
        defects,
        ambiguities: [],
        total_requirements_estimate: 30,
      },
      runs: [],
    });
  }
  return surveys;
}

// ---------------------------------------------------------------------------
// Fabricated conditions
// ---------------------------------------------------------------------------

const ALL_LOCI = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"];

/**
 * A well-formed build identity (arms/ARCHITECTURE.md §5). Every fabricated condition carries
 * one, so that the identity gate is not what any OTHER self-test is measuring — a fixture
 * that fails for two reasons proves neither.
 */
function identity(arm, over = {}) {
  return {
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
    ...over,
  };
}

function shell(arm, surveyId, findings, claimedUnits, extra = {}) {
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    arm,
    armVersion: "selftest-0000000",
    armIdentity: identity(arm),
    surveyId,
    seed: arm === "C-R" ? 0 : null,
    findings,
    coverage: { claimedUnits },
    selfReportedCost: { note: "recorded, never scored" },
    ...extra,
  };
}

function telemetry(arm, surveyId, visitLog, cost = {}) {
  return {
    arm,
    surveyId,
    visitLog,
    cost: {
      usd: 1,
      modelCalls: 10,
      tokensIn: 1000,
      tokensOut: 100,
      browserSessions: 1,
      browserActions: 20,
      wallClockMs: 60000,
      nodeVisits: visitLog.length,
      ...cost,
    },
    budgetExhausted: false,
    timeExhausted: false,
  };
}

function unit(id, location, status = "exercised", verdict = "pass") {
  return { unitId: id, location, status, verdict };
}

function defectFinding(id, location, requirementClass, predicate, attribution = "model", prose = "fabricated finding") {
  return {
    findingId: id,
    claimClass: "defect",
    requirementClass,
    location: { raw: location, scope: "question" },
    observable: { predicate, subject: location, expected: "documented behaviour", actual: "observed behaviour" },
    attribution,
    evidence: [{ kind: "dom", ref: `${id}-e1` }],
    prose,
    confidence: null,
  };
}

function ambiguityFinding(id, location, attribution = "model") {
  return {
    findingId: id,
    claimClass: "ambiguity",
    location: { raw: location, scope: "question" },
    readings: ["reading one", "reading two"],
    attribution,
    evidence: [{ kind: "dom", ref: `${id}-e1` }],
    prose: "the document does not resolve this; which reading applies?",
    confidence: null,
  };
}

function observationFinding(id, location, attribution = "model") {
  return {
    findingId: id,
    claimClass: "observation",
    location: { raw: location, scope: "question" },
    attribution,
    evidence: [{ kind: "dom", ref: `${id}-e1` }],
    prose: "noticed something; not asserting anything about it",
    confidence: null,
  };
}

/** The class + predicate a correct finding for this key defect would carry. */
function correctFacets(d, annotations, surveyId) {
  const ann = annotations?.[`${surveyId}::${d.id}`];
  if (ann) {
    const cls = eligibleClasses(d.class).classes.find((c) => CLASS_PREDICATES[c].includes(ann.predicate));
    return { requirementClass: cls, predicate: ann.predicate };
  }
  const cls = eligibleClasses(d.class).classes[0];
  return { requirementClass: cls, predicate: CLASS_PREDICATES[cls][0] };
}

/** Everything right: one correct finding per defect, ambiguities surfaced, clean controls silent. */
export function perfectArm(surveys, arm = "C", annotations = makeAnnotations()) {
  return surveys.map((s) => {
    const findings = [];
    let n = 0;
    for (const d of s.key.defects) {
      const { requirementClass, predicate } = correctFacets(d, annotations, s.surveyId);
      findings.push(
        defectFinding(`F${++n}`, d.location, requirementClass, predicate, arm === "B" ? "graph" : "model"),
      );
    }
    for (const a of s.key.ambiguities) {
      findings.push(ambiguityFinding(`F${++n}`, a.location, arm === "B" ? "graph" : "model"));
    }
    const loci = [...new Set([...s.key.defects.map((d) => d.location), ...s.key.ambiguities.map((a) => a.location)])];
    const units = loci.map((l, i) => unit(`U${i + 1}`, l));
    return {
      arm,
      surveyId: s.surveyId,
      result: shell(arm, s.surveyId, findings, units),
      telemetry: telemetry(arm, s.surveyId, loci.length ? loci : ["Q1"]),
    };
  });
}

/** Nothing at all. Scores 0 recall and 0 false positives — which is the point. */
export function uselessArm(surveys, arm = "A") {
  return surveys.map((s) => ({
    arm,
    surveyId: s.surveyId,
    result: shell(arm, s.surveyId, [], []),
    telemetry: telemetry(arm, s.surveyId, []),
  }));
}

/** A defect at every locus of every survey, clean controls included. Must score BADLY. */
export function overflaggerArm(surveys, arm = "B") {
  return surveys.map((s) => {
    const findings = ALL_LOCI.map((l, i) =>
      defectFinding(`F${i + 1}`, l, "routing", "route-not-fired", arm === "B" ? "graph" : "model"),
    );
    return {
      arm,
      surveyId: s.surveyId,
      result: shell(arm, s.surveyId, findings, ALL_LOCI.map((l, i) => unit(`U${i + 1}`, l))),
      telemetry: telemetry(arm, s.surveyId, ALL_LOCI),
    };
  });
}

/**
 * Guesses every planted ambiguity as a determinate defect — and every guess is RIGHT.
 * §4.4 says this scores exactly as a wrong guess would. This fixture is the proof.
 */
export function luckyGuesserArm(surveys, arm = "A", annotations = makeAnnotations()) {
  const base = perfectArm(surveys, arm, annotations);
  return base.map((r, i) => {
    const s = surveys[i];
    const findings = r.result.findings.filter((f) => f.claimClass !== "ambiguity");
    let n = findings.length;
    for (const a of s.key.ambiguities) {
      // A determinate defect claim at the ambiguity locus, whose content happens to be
      // exactly what the site does.
      findings.push(
        defectFinding(`G${++n}`, a.location, "wording", "text-differs", "model", "the correct reading is clearly the second one"),
      );
    }
    return { ...r, result: { ...r.result, findings } };
  });
}

/** Everything hedged into the observation channel: FP 0, recall 0, HEDGING flagged. */
export function hedgerArm(surveys, arm = "A") {
  return surveys.map((s) => {
    const findings = ALL_LOCI.slice(0, 12).map((l, i) => observationFinding(`F${i + 1}`, l));
    // ALL_LOCI has 10 entries; pad to 12 so the volume clears 0.5 x estimate everywhere.
    while (findings.length < 12) findings.push(observationFinding(`F${findings.length + 1}`, `Q${findings.length + 1}`));
    return {
      arm,
      surveyId: s.surveyId,
      result: shell(arm, s.surveyId, findings, []),
      telemetry: telemetry(arm, s.surveyId, ALL_LOCI),
    };
  });
}

/** Two valid findings per defect. Recall unchanged, precision denominator reduced, no FP. */
export function duplicatorArm(surveys, arm = "A", annotations = makeAnnotations()) {
  return perfectArm(surveys, arm, annotations).map((r) => {
    const dupes = r.result.findings
      .filter((f) => f.claimClass === "defect")
      .map((f) => ({ ...f, findingId: `${f.findingId}b` }));
    return { ...r, result: { ...r.result, findings: [...r.result.findings, ...dupes] } };
  });
}

/** One finding covering two co-located defects. Exactly 1 TP, 1 miss, UNDER_SPLIT queued. */
export function underSplitterArm(surveys, arm = "A", annotations = makeAnnotations()) {
  return perfectArm(surveys, arm, annotations).map((r, i) => {
    const s = surveys[i];
    if (s.surveyId !== "syn-1") return r;
    // Drop the second of the two Q7 findings: one report now covers both defects.
    const q7 = r.result.findings.filter((f) => f.claimClass === "defect" && f.location.raw === "Q7");
    const drop = new Set(q7.slice(1).map((f) => f.findingId));
    return { ...r, result: { ...r.result, findings: r.result.findings.filter((f) => !drop.has(f.findingId)) } };
  });
}

/** Claims everything exercised; the harness saw two screens. */
export function coverageLiarArm(surveys, arm = "A") {
  return surveys.map((s) => ({
    arm,
    surveyId: s.surveyId,
    result: shell(arm, s.surveyId, [], ALL_LOCI.map((l, i) => unit(`U${i + 1}`, l))),
    telemetry: telemetry(arm, s.surveyId, ["Q1", "Q2"]),
  }));
}

/** Right location, right class, OPPOSITE consequence, with an annotation present. */
export function wrongDirectionArm(surveys, arm = "A") {
  return surveys.map((s) => {
    const findings = [];
    let n = 0;
    for (const d of s.key.defects) {
      if (d.location !== "Q7") continue;
      // annotated D3 = option-absent, D4 = option-order-differs; assert the other one
      findings.push(defectFinding(`F${++n}`, "Q7", "option-list", "option-present-unexpected"));
      break;
    }
    return {
      arm,
      surveyId: s.surveyId,
      result: shell(arm, s.surveyId, findings, [unit("U1", "Q7")]),
      telemetry: telemetry(arm, s.surveyId, ["Q7"]),
    };
  });
}

/** Arm B claiming a finding came from the model. Impossible by construction (§3.3). */
export function attributionLiarArm(surveys) {
  return surveys.map((s) => ({
    arm: "B",
    surveyId: s.surveyId,
    result: shell("B", s.surveyId, [defectFinding("F1", "Q3", "routing", "route-not-fired", "model")], [unit("U1", "Q3")]),
    telemetry: telemetry("B", s.surveyId, ["Q3"]),
  }));
}

/**
 * IDENTITY-LIAR — two shapes of broken build identity, both of which would otherwise score
 * normally and produce a perfectly plausible recall number for an arm nobody can identify.
 *
 *   "missing"      the result carries no armIdentity at all
 *   "inconsistent" the identity names a DIFFERENT arm than the result does
 *
 * The findings themselves are CORRECT. That is the point: if this fixture scored, it would
 * score well. arms/ARCHITECTURE.md §6.
 */
export function identityLiarArm(surveys, arm = "C", shape = "missing") {
  return surveys.map((s) => {
    const findings = s.isCleanControl
      ? []
      : s.key.defects.map((d, i) => {
          const { requirementClass, predicate } = correctFacets(d, null, s.surveyId);
          return defectFinding(`F${i + 1}`, d.location, requirementClass, predicate, "graph");
        });
    const loci = s.key.defects.map((d) => d.location);
    const result = shell(arm, s.surveyId, findings, loci.map((l, i) => unit(`U${i + 1}`, l)));
    if (shape === "missing") delete result.armIdentity;
    else result.armIdentity = { ...result.armIdentity, armId: arm === "C" ? "B" : "C" };
    return { arm, surveyId: s.surveyId, result, telemetry: telemetry(arm, s.surveyId, loci) };
  });
}

/** Prose carrying a key-minted defect ID. Blindness compromised (§8.4). */
export function leakerArm(surveys, arm = "A") {
  return surveys.map((s) => ({
    arm,
    surveyId: s.surveyId,
    result: shell(
      arm,
      s.surveyId,
      [defectFinding("F1", "Q3", "routing", "route-not-fired", "model", "this is planted defect D1 from the key")],
      [unit("U1", "Q3")],
    ),
    telemetry: telemetry(arm, s.surveyId, ["Q3"]),
  }));
}

/**
 * A pair whose comparison flips under swing: X leads by 3 outright (not enough), plus 6
 * queued candidates that would carry it past the margin if resolved its way.
 */
export function queueDominatedPair(surveys) {
  const runsC = [];
  const runsA = [];
  for (const s of surveys) {
    if (s.isCleanControl) {
      runsC.push({ arm: "C", surveyId: s.surveyId, result: shell("C", s.surveyId, [], []), telemetry: telemetry("C", s.surveyId, []) });
      runsA.push({ arm: "A", surveyId: s.surveyId, result: shell("A", s.surveyId, [], []), telemetry: telemetry("A", s.surveyId, []) });
      continue;
    }
    const defects = s.key.defects;
    const cFindings = [];
    const aFindings = [];
    let n = 0;
    defects.forEach((d, i) => {
      const { requirementClass, predicate } = correctFacets(d, null, s.surveyId);
      // C finds every defect outright.
      cFindings.push(defectFinding(`F${++n}`, d.location, requirementClass, predicate, "graph"));
      // A finds only the first of each survey's defects.
      if (i === 0) aFindings.push(defectFinding(`A${i + 1}`, d.location, requirementClass, predicate, "model"));
    });
    // C additionally asserts at a GLOBAL-location defect it cannot be auto-credited for —
    // these are the queue entries that drive the swing.
    const loci = defects.map((d) => d.location);
    runsC.push({
      arm: "C",
      surveyId: s.surveyId,
      result: shell("C", s.surveyId, cFindings, loci.map((l, i) => unit(`U${i + 1}`, l))),
      telemetry: telemetry("C", s.surveyId, loci),
    });
    runsA.push({
      arm: "A",
      surveyId: s.surveyId,
      result: shell("A", s.surveyId, aFindings, loci.slice(0, 1).map((l, i) => unit(`U${i + 1}`, l))),
      telemetry: telemetry("A", s.surveyId, loci),
    });
  }
  return { runsC, runsA };
}

/** Attach runs to a corpus copy. */
export function withRuns(surveys, ...runSets) {
  const copy = surveys.map((s) => ({ ...s, runs: [] }));
  const index = new Map(copy.map((s) => [s.surveyId, s]));
  for (const runs of runSets) {
    for (const r of runs) {
      const s = index.get(r.surveyId);
      if (s) s.runs.push({ arm: r.arm, seed: r.result.seed ?? null, result: r.result, telemetry: r.telemetry });
    }
  }
  return copy;
}
