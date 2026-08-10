// run-all.mjs — the whole experiment. Writes JSON artefacts to out/.
//
//   1. crawl every clean and flawed page with a real headless browser (Graph-S)
//   2. compile Graph-D from each clean manifest
//   3. diff:  D(clean) vs S(clean)   -> false positives
//             D(clean) vs S(flawed)  -> the seeded defects
//   4. self-consistency checks + extraction-mutation catch rate
//   5. coverage arithmetic + residue
//   6. requirement register: edge vs node-attribute split
//   7. seeded-defect table
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./serve.mjs";
import { launch } from "./cdp.mjs";
import { crawlSurvey } from "./crawl.mjs";
import { compileGraphD, createDRun } from "./compile-d.mjs";
import { levelA, levelB, levelC, levelCProbes, specToValue } from "./diff.mjs";
import { runSelfChecks, runSiteSelfChecks } from "./selfcheck.mjs";
import { measureCatchRate } from "./mutate.mjs";
import { edgeCoverageJourneys, coverageReport, coverageResidue } from "./coverage.mjs";
import { requirementRegister, registerSummary, registerCoverage } from "./attributes.mjs";

const CORPUS = "E:/survey-qa/test-suite/branching";
const OUT = "E:/survey-qa/graph-spike/out";
const SURVEYS = ["s1-skip", "s2-screener", "s3-multiselect-piping", "s4-nested-rotation", "s5-allocation", "s6-kitchen-sink"];
mkdirSync(OUT, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const corpus = readJson(join(CORPUS, "corpus.json"));

const manifests = Object.fromEntries(SURVEYS.map((s) => [s, readJson(join(CORPUS, s, "manifest.json"))]));
const flawedManifests = Object.fromEntries(SURVEYS.map((s) => [s, readJson(join(CORPUS, s, "manifest.flawed.json"))]));

// ---------------------------------------------------------------- crawl -----
const srv = await serve(CORPUS);
const chrome = await launch();
const page = await chrome.newPage();
const graphs = {};
const t0 = Date.now();
try {
  for (const s of SURVEYS) {
    for (const variant of ["index", "flawed"]) {
      const t = Date.now();
      const g = await crawlSurvey(page, `${srv.base}/${s}/${variant}.html`, { surveyId: s, maxJourneys: 1500 });
      graphs[`${s}/${variant}`] = g;
      console.log(`crawled ${s}/${variant}: ${Object.keys(g.nodes).length} nodes, ${g.edges.length} edges, ${g.stats.journeys} journeys, ${((Date.now() - t) / 1000).toFixed(1)}s`);
      writeFileSync(join(OUT, `graph-S.${s}.${variant}.json`), JSON.stringify(g, null, 1));
    }
  }
} finally {
  await chrome.close();
  await srv.close();
}
console.log(`crawling done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// -------------------------------------------------------------- graph D -----
const graphsD = {};
for (const s of SURVEYS) {
  graphsD[s] = compileGraphD(manifests[s]);
  writeFileSync(join(OUT, `graph-D.${s}.json`), JSON.stringify(graphsD[s], null, 1));
}

// ----------------------------------------------------------------- diff -----
const diffs = {};
for (const s of SURVEYS) {
  for (const variant of ["index", "flawed"]) {
    const g = graphs[`${s}/${variant}`];
    const a = levelA(manifests[s], g);
    const b = levelB(manifests[s], g, { resync: true });
    const bNoResync = levelB(manifests[s], g, { resync: false });
    const c = levelC(manifests[s], g);
    const cp = levelCProbes(manifests[s], g);
    const sSelf = runSiteSelfChecks(g);
    diffs[`${s}/${variant}`] = { levelA: a, levelB: b, levelBNoResync: bNoResync, levelC: c, levelCProbes: cp, siteSelfChecks: sSelf };
  }
}
writeFileSync(join(OUT, "diffs.json"), JSON.stringify(diffs, null, 1));

// ------------------------------------------------------- self-consistency ---
const selfChecks = {};
for (const s of SURVEYS) {
  selfChecks[s] = {
    clean: runSelfChecks(manifests[s]),
    flawedManifest: runSelfChecks(flawedManifests[s]),
  };
}
writeFileSync(join(OUT, "selfchecks.json"), JSON.stringify(selfChecks, null, 1));

const mutation = measureCatchRate(SURVEYS.map((id) => ({ id, manifest: manifests[id] })), { perFamily: 3 });
writeFileSync(join(OUT, "mutation-catch-rate.json"), JSON.stringify(mutation, null, 1));

// -------------------------------------------------------------- coverage ----
const coverage = {};
for (const s of SURVEYS) {
  const js = edgeCoverageJourneys(manifests[s]);
  coverage[s] = { ...coverageReport(manifests[s], js), residue: coverageResidue(manifests[s]) };
}
writeFileSync(join(OUT, "coverage.json"), JSON.stringify(coverage, null, 1));

// ---------------------------------------------------- requirement register --
const registers = SURVEYS.map((id) => ({ id, reqs: requirementRegister(manifests[id]) }));
const regSummary = registerSummary(registers);

// Which register items did the SITE traversal actually evaluate?
function edgesExercisedBySite(manifest, graphS) {
  const taken = new Set();
  const loops = manifest.loops || [];
  for (const j of graphS.journeys || []) {
    const run = createDRun(manifest);
    for (const st of j.steps) {
      const cur = run.current();
      if (!cur || cur.qid !== st.from) { if (!cur || !run.seekTo(st.from)) break; }
      const res = run.answer(specToValue(st.spec));
      if (!res.ok) { if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) break; continue; }
      if (res.ruleIndex !== null && res.ruleIndex !== undefined) taken.add(`${st.from}#r${res.ruleIndex}`);
      else {
        const l = loops.find((x) => x.block.includes(st.from));
        if (l && l.block[l.block.length - 1] === st.from) taken.add(`${st.from}#${res.to === l.block[0] ? "loop-back" : "loop-exit"}`);
        else taken.add(`${st.from}#fall`);
      }
      if (res.to !== st.to) { if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) break; }
    }
  }
  return taken;
}
const registerEval = {};
for (const s of SURVEYS) {
  const g = graphs[`${s}/index`];
  registerEval[s] = registerCoverage(manifests[s], g, edgesExercisedBySite(manifests[s], g));
}
const regEvalTotals = SURVEYS.reduce((a, s) => ({
  total: a.total + registerEval[s].total, evaluated: a.evaluated + registerEval[s].evaluated,
}), { total: 0, evaluated: 0 });
writeFileSync(join(OUT, "requirement-register.json"), JSON.stringify({
  summary: regSummary,
  evaluationCoverage: {
    ...regEvalTotals, share: regEvalTotals.evaluated / regEvalTotals.total,
    perSurvey: Object.fromEntries(SURVEYS.map((s) => [s, { total: registerEval[s].total, evaluated: registerEval[s].evaluated, share: registerEval[s].share }])),
    unevaluatedByType: Object.entries(SURVEYS.flatMap((s) => registerEval[s].unevaluated).reduce((a, r) => { a[r.type] = (a[r.type] || 0) + 1; return a; }, {})),
    unevaluatedReasons: [...new Set(SURVEYS.flatMap((s) => registerEval[s].unevaluated.map((r) => `${r.type}: ${r.reason}`)))],
  },
  registers, registerEval,
}, null, 1));

// -------------------------------------------------------- seeded defects ----
function pointerQid(manifest, path) {
  const parts = String(path).split("/").slice(1);
  if (parts[0] === "questions") {
    const q = manifest.questions[Number(parts[1])];
    return q ? q.id : null;
  }
  if (parts[0] === "loops") return "LOOP:" + (manifest.loops?.[Number(parts[1])]?.id ?? parts[1]);
  if (parts[0] === "computed") return "COMPUTED:" + (manifest.computed?.[Number(parts[1])]?.id ?? parts[1]);
  return null;
}

// Which finding kinds legitimately DETECT each seeded-defect category. Stated
// explicitly rather than inferred from location alone, because several seeded
// defects share a question with another seeded defect (s3 Q3 carries both a
// broken piping token and an inverted branch) and location matching would let
// one defect take credit for the other's detection.
const DETECTOR_FOR = {
  "wrong-skip-target":            { channel: "edge-diff", kinds: ["MIS-ROUTE", "WRONG-SCREEN"] },
  "terminate-not-enforced":       { channel: "edge-diff", kinds: ["MIS-ROUTE", "SITE-CONTINUES-PAST-DOCUMENT-END"] },
  "wrong-threshold":              { channel: "edge-diff", kinds: ["MIS-ROUTE"] },
  "boundary-off-by-one":          { channel: "edge-diff", kinds: ["MIS-ROUTE"] },
  "wrong-branch-threshold":       { channel: "edge-diff", kinds: ["MIS-ROUTE"] },
  "inverted-branch":              { channel: "edge-diff", kinds: ["MIS-ROUTE"] },
  "wrong-calc-source":            { channel: "edge-diff", kinds: ["MIS-ROUTE"] },
  "loop-truncated":               { channel: "edge-diff", kinds: ["MIS-ROUTE", "WRONG-SCREEN", "SITE-CONTINUES-PAST-DOCUMENT-END"] },
  "missing-option":               { channel: "node-attribute", kinds: ["OPTION-MISSING", "MISSING-OPTION"] },
  "missing-instruction":          { channel: "node-attribute", kinds: ["INSTRUCTION-MISSING", "INSTRUCTION-MISMATCH"] },
  "broken-piping":                { channel: "node-attribute", kinds: ["TEXT-MISMATCH"], siteSelfCheck: ["S01"] },
  "carry-forward-broken":         { channel: "node-attribute", kinds: ["OPTION-UNDOCUMENTED", "OPTION-MISSING"] },
  "rotation-anchor-violation":    { channel: "node-attribute", kinds: ["ANCHOR-VIOLATION"] },
  // both allocation defects live on the same question, so the kind alone is not
  // enough — the documented violation must match the defect too
  "allocation-sum-not-validated": { channel: "validation-probe", kinds: ["ALLOCATION-TOTAL-NOT-ENFORCED", "SITE-ACCEPTS-INVALID-ANSWER"], errorSubstring: "total-mismatch" },
  "row-cap-removed":              { channel: "validation-probe", kinds: ["ROW-CAP-NOT-ENFORCED", "SITE-ACCEPTS-INVALID-ANSWER"], errorSubstring: "row-above-max" },
};

const seededTable = [];
for (const entry of corpus.surveys) {
  const s = entry.id;
  const clean = manifests[s];
  const d = diffs[`${s}/flawed`];
  const dClean = diffs[`${s}/index`];
  for (const err of entry.seededErrors) {
    const flawedErr = (flawedManifests[s].seededErrors || []).find((e) => e.id === err.id);
    const locs = new Set((flawedErr?.patch || []).map((p) => pointerQid(clean, p.path)).filter(Boolean));
    const qLocs = new Set([...locs].filter((x) => !x.startsWith("LOOP:") && !x.startsWith("COMPUTED:")));
    for (const l of locs) {
      if (l.startsWith("LOOP:")) {
        const loop = clean.loops.find((x) => x.id === l.slice(5));
        for (const b of loop?.block || []) qLocs.add(b);
      }
      if (l.startsWith("COMPUTED:")) {
        for (const q of clean.questions) {
          for (const r of q.rules || []) if (JSON.stringify(r.if || {}).includes(l.slice(9))) qLocs.add(q.id);
        }
      }
    }

    const spec = DETECTOR_FOR[err.category] || { channel: "?", kinds: [] };
    // ONLY the node the finding is *about* counts. Matching on the finding's
    // target node instead would let a defect at S3 take credit for detecting a
    // different defect at S4.
    const atMatch = (f) => qLocs.has(f.at) || qLocs.has(f.from);
    const kindMatch = (f) => {
      if (!spec.kinds.includes(f.kind || f.verdict)) return false;
      if (spec.errorSubstring && (f.kind === "SITE-ACCEPTS-INVALID-ANSWER" || f.verdict === "SITE-ACCEPTS-INVALID")) {
        return (f.documentedErrors || []).some((e) => String(e).includes(spec.errorSubstring));
      }
      return true;
    };

    const pool = (dd) => [
      ...dd.levelB.findings,
      ...dd.levelA.rows.filter((r) => r.verdict === "MIS-ROUTE" || r.verdict === "MISSING-OPTION" || r.verdict === "UNDOCUMENTED-OPTION" || r.verdict === "SITE-ACCEPTS-INVALID"),
      ...dd.levelC.findings,
      ...dd.levelCProbes,
    ];
    const matched = pool(d).filter((f) => atMatch(f) && kindMatch(f));
    const fp = pool(dClean).filter((f) => atMatch(f) && kindMatch(f));
    const selfConsD = runSelfChecks(flawedManifests[s]).filter((f) => qLocs.has(f.at));
    const selfConsS = d.siteSelfChecks.filter((f) => qLocs.has(f.at) && (spec.siteSelfCheck || []).includes(f.code));

    let verdict;
    if (matched.length && !fp.length) {
      verdict = spec.channel === "edge-diff" ? "graph diff (edge arithmetic)"
        : spec.channel === "validation-probe" ? "validation-behaviour probe"
        : "node-attribute comparison";
    } else if (selfConsD.length || selfConsS.length) {
      verdict = "self-consistency check only";
    } else {
      verdict = "NOT DETECTED";
    }

    seededTable.push({
      id: err.id, survey: s, category: err.category, location: err.location,
      description: err.description,
      locations: [...qLocs],
      expectedChannel: spec.channel,
      verdict,
      matchedFindings: matched.map((f) => `${f.kind || f.verdict}@${f.at || f.from}${f.classKey ? " " + f.classKey : ""}${f.documented !== undefined ? ` doc=${f.documented}` : ""}${f.observed !== undefined ? ` site=${f.observed}` : ""}`),
      selfConsistencyFindings: [...selfConsD.map((f) => "D:" + f.code + " " + f.message), ...selfConsS.map((f) => "S:" + f.code + " " + f.message)],
      cleanPageFalsePositives: fp.length,
    });
  }
}
writeFileSync(join(OUT, "seeded-defect-table.json"), JSON.stringify(seededTable, null, 1));

// ------------------------------------------------------------- summary ------
const summary = {
  generated: new Date().toISOString(),
  crawl: Object.fromEntries(Object.entries(graphs).map(([k, g]) => [k, {
    nodes: Object.keys(g.nodes).length, edges: g.edges.length, rejections: g.rejections.length,
    journeys: g.stats.journeys, budgetExhausted: g.stats.budgetExhausted,
    historyDependentEdges: g.historyDependentEdges.length, assumptions: g.assumptions.length,
  }])),
  falsePositivesOnCleanPages: Object.fromEntries(SURVEYS.map((s) => [s, {
    levelA_misroute: diffs[`${s}/index`].levelA.rows.filter((r) => r.verdict === "MIS-ROUTE").length,
    levelA_undecidable: diffs[`${s}/index`].levelA.counts.undecidable,
    levelA_decidableShare: diffs[`${s}/index`].levelA.decidableShare,
    levelA_otherRows: diffs[`${s}/index`].levelA.rows.filter((r) => r.verdict !== "MIS-ROUTE").map((r) => r.verdict + ":" + r.from),
    levelB_findings: diffs[`${s}/index`].levelB.findings.length,
    levelB_journeysClean: `${diffs[`${s}/index`].levelB.journeysClean}/${diffs[`${s}/index`].levelB.journeysReplayed}`,
    levelC_findings: diffs[`${s}/index`].levelC.findings.map((f) => f.kind + "@" + f.at),
    levelCProbes: diffs[`${s}/index`].levelCProbes.map((f) => f.kind + "@" + f.at),
    siteSelfChecks: diffs[`${s}/index`].siteSelfChecks.map((f) => f.code + "@" + f.at),
  }])),
  flawedPageFindings: Object.fromEntries(SURVEYS.map((s) => [s, {
    levelA_misroute: diffs[`${s}/flawed`].levelA.rows.filter((r) => r.verdict === "MIS-ROUTE").length,
    levelA_counts: diffs[`${s}/flawed`].levelA.counts,
    levelA_rows: [...new Set(diffs[`${s}/flawed`].levelA.rows.filter((r) => r.verdict !== "UNDECIDABLE").map((r) => r.verdict + "@" + r.from + (r.code !== undefined ? ":" + r.code : "")))],
    levelB: diffs[`${s}/flawed`].levelB.findings.map((f) => `${f.kind}@${f.at || ""} ${f.classKey || ""} doc=${f.documented ?? ""} site=${f.observed ?? ""}`),
    levelB_firstDivergenceOnly: diffs[`${s}/flawed`].levelBNoResync.findings.length,
    levelB_withResync: diffs[`${s}/flawed`].levelB.findings.length,
    levelC: diffs[`${s}/flawed`].levelC.findings.map((f) => `${f.kind}@${f.at}`),
    levelCProbes: diffs[`${s}/flawed`].levelCProbes.map((f) => `${f.kind}@${f.at}`),
    siteSelfChecks: diffs[`${s}/flawed`].siteSelfChecks.map((f) => `${f.code}@${f.at}`),
  }])),
  selfConsistency: {
    cleanManifestFindings: Object.fromEntries(SURVEYS.map((s) => [s, selfChecks[s].clean.length])),
    flawedManifestFindings: Object.fromEntries(SURVEYS.map((s) => [s, selfChecks[s].flawedManifest.map((f) => f.code + " " + f.message)])),
  },
  mutation: {
    total: mutation.total, observable: mutation.observable, unobservable: mutation.unobservable,
    caught: mutation.caught, catchRate: mutation.catchRate, familyTable: mutation.familyTable,
  },
  coverage: Object.fromEntries(SURVEYS.map((s) => [s, {
    symbolicEdges: coverage[s].symbolicEdges, edgeCoverage: coverage[s].edgeCoverage,
    nodeCoverage: coverage[s].nodeCoverage, journeysGenerated: coverage[s].journeysGenerated,
    minimalJourneySet: coverage[s].minimalJourneySet, residueItems: coverage[s].residue.length,
  }])),
  requirementRegister: regSummary,
  requirementEvaluationCoverage: { ...regEvalTotals, share: regEvalTotals.evaluated / regEvalTotals.total },
  seededDefects: {
    total: seededTable.length,
    byVerdict: seededTable.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {}),
    table: seededTable.map((r) => ({ id: r.id, category: r.category, verdict: r.verdict })),
  },
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.seededDefects, null, 1));
console.log("false positives (clean pages):", JSON.stringify(summary.falsePositivesOnCleanPages, null, 1));
console.log("wrote", OUT);
