#!/usr/bin/env node
/**
 * ARM B — THE ENTRYPOINT.
 *
 *     (questionnaire.docx, surveyURL)  ->  normalised findings + cost telemetry
 *
 * Unattended. No per-survey configuration. If it needs hand-tuning per survey it is not
 * an arm, so every convention it relies on is declared in `ir.mjs`/`platform.mjs`,
 * CHECKED at runtime, and degraded to a named limitation when it does not hold.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF OPERATIONS IS ITSELF A DESIGN DECISION
 *
 *   1. PRE-FLIGHT the platform (one session, ~6 page evaluations, no answers).
 *      Cheap, and it fails before anything expensive runs. A site whose conventions do
 *      not match must not first burn a Grok + DeepSeek extraction to find that out.
 *   2. INGEST the document through the SHARED extraction (§8.1). Model calls happen here
 *      and only here.
 *   3. CRAWL the site. Zero model calls, by construction, and asserted at the end.
 *   4. ALIGN the two identifier namespaces before comparing anything (assumption DOC-01).
 *      Skipping this turns one namespace mismatch into dozens of false positives.
 *   5. COMPARE — level A edge arithmetic, level B stateful trace replay (with resync),
 *      level C node attributes, level C probes.
 *   6. MAP through the leak guards into the normalised format.
 *   7. COMPUTE coverage, and assert judgement cost is zero.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT "FAILS LOUDLY" MEANS HERE, CONCRETELY
 *
 * At every step where this arm cannot proceed — unrecognised platform, no ingestion
 * credentials, an IR that does not validate, two identifier namespaces with no overlap —
 * it emits `claimClass: "blocker"` findings and a `claimedUnits` list in which everything
 * is `blocked`. It never returns an empty finding list, because an empty finding list is
 * read as a clean bill of health, and that is the exact failure this project exists to
 * prevent (CLAUDE.md).
 */

import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { crawlSurvey } from "../crawl.mjs";
import { levelA, levelB, levelC, levelCProbes } from "../diff.mjs";
import { coverageResidue } from "../coverage.mjs";
import { makePageBridge } from "./page-bridge.mjs";
import { preflight, GENERIC_DOM_PROFILE } from "./platform.mjs";
import { chooseIngester, canonId } from "./ingest.mjs";
import { makeLeakGuards, edgeBasis, attributeBasis } from "./leaks.mjs";
import { makeMapper } from "./findings.mjs";
import { buildCoverageUnits, summariseUnits } from "./coverage-units.mjs";
import { ASSUMPTIONS, completeness } from "./ir.mjs";

const isBudgetError = (e) => Boolean(e && typeof e.limit === "string" && /budget exceeded/i.test(e.message || ""));

// ───────────────────────────────────────────────────── identifier alignment (DOC-01) ──

/**
 * Reconcile the document's question identifiers with the site's, by canonical form only.
 *
 * The rewrite is deliberately narrow — case and separator differences are the same node,
 * everything else is not. A looser rule would merge two questions into one, and a merged
 * node is a defect that can never be found. Every rewrite is reported.
 *
 * This also has to happen for a reason the schema forces: `coverage_honesty` (§4.5)
 * witnesses a unit's `location` against the HARNESS visit log, which reads the site's
 * `data-qid`. An arm that reported document spellings would show every coverage claim as
 * unwitnessed and could not pass a coverage gate no matter how well it worked.
 */
export function alignIdentifiers(ir, graphS) {
  const siteIds = Object.keys(graphS?.nodes || {});
  const siteByCanon = new Map(siteIds.map((s) => [canonId(s), s]));
  const docIds = (ir.questions || []).map((q) => q.id);

  const rename = new Map();
  const matched = [];
  const docOnly = [];
  for (const d of docIds) {
    const s = siteByCanon.get(canonId(d));
    if (!s) { docOnly.push(d); continue; }
    matched.push(d);
    if (s !== d) rename.set(d, s);
  }
  const siteOnly = siteIds.filter((s) => !docIds.some((d) => canonId(d) === canonId(s)));

  if (rename.size) applyRename(ir, rename);

  return {
    matched: matched.map((d) => rename.get(d) ?? d),
    renamed: [...rename.entries()].map(([from, to]) => ({ from, to })),
    documentOnly: docOnly,
    siteOnly,
    overlap: docIds.length ? matched.length / docIds.length : 0,
  };
}

function applyRename(ir, rename) {
  const m = (id) => rename.get(id) ?? id;
  const fixRef = (ref) => {
    const s = String(ref);
    const dot = s.indexOf(".");
    return dot === -1 ? m(s) : `${m(s.slice(0, dot))}${s.slice(dot)}`;
  };
  const fixCond = (c) => {
    if (!c || typeof c !== "object") return;
    if (c.op === "and" || c.op === "or") return (c.terms || []).forEach(fixCond);
    if (c.q !== undefined) c.q = fixRef(c.q);
  };
  for (const q of ir.questions || []) {
    q.id = m(q.id);
    for (const r of q.rules || []) { if (r.goto) r.goto = m(r.goto); fixCond(r.if); }
    if (q.optionsFrom?.q) q.optionsFrom.q = m(q.optionsFrom.q);
  }
  for (const l of ir.loops || []) {
    if (l.source) l.source = m(l.source);
    if (Array.isArray(l.block)) l.block = l.block.map(m);
  }
  for (const c of ir.computed || []) {
    if (c.expr?.refs) c.expr.refs = c.expr.refs.map(fixRef);
  }
}

// ───────────────────────────────────────────────────────────────────── the arm ──

/**
 * @param ctx  the adapter context from `evaluation/run-arm.mjs`:
 *             { surveyId, arm, baseUrl, docxPath, browser, model, budget, log }
 * @param opts { ingester, maxJourneys, entryPath, replayPath, recordExtractionTo, cacheDir }
 * @returns    { findings, claimedUnits, selfReportedCost, diagnostics }
 */
export async function runArmB(ctx, opts = {}) {
  const t0 = Date.now();
  const log = ctx.log || (() => {});
  const surveyId = ctx.surveyId;
  const counters = { gotos: 0, evaluates: 0 };
  const timings = {};

  // Cost accounting by PHASE. Arm B's whole selling point is that judgement is free; the
  // only way to say that as a measurement rather than an assertion is to count the calls
  // on each side of the seam and assert the judgement side is zero.
  const cost = {
    ingestion: { modelCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0, provider: null },
    judgement: { modelCalls: 0 },
    browser: { sessions: 0, gotos: 0, evaluates: 0, journeys: 0 },
    telemetryGaps: [],
  };
  let phase = "startup";
  const model = typeof ctx.model === "function"
    ? async (req) => { cost[phase === "ingestion" ? "ingestion" : "judgement"].modelCalls += 1; return ctx.model(req); }
    : null;

  const page = makePageBridge(ctx.browser, counters);
  const diagnostics = { assumptions: ASSUMPTIONS, profile: GENERIC_DOM_PROFILE.id };

  // ═══════════════════════════════════════════════ 1. PRE-FLIGHT ══
  phase = "preflight";
  const entryPath = opts.entryPath || "/index.html";
  const url = `${ctx.baseUrl}${entryPath.startsWith("/") ? "" : "/"}${entryPath}`;
  let pf;
  const tPre = Date.now();
  try {
    pf = await preflight(page, url, { log });
  } catch (e) {
    if (isBudgetError(e)) throw e;
    return failClosed({
      surveyId, reason: "PREFLIGHT_FAILED",
      prose:
        `Arm B could not complete its pre-flight on ${url}: ${e.message}. No comparison was performed and NOTHING about this survey ` +
        "has been checked. An empty finding list here would read as a clean bill of health; this blocker is the honest output.",
      cost, t0, counters, diagnostics,
    });
  }
  timings.preflightMs = Date.now() - tPre;
  diagnostics.preflight = { checks: pf.checks, blinding: { removedJsonIslands: pf.blinding.found.jsonScripts.length, removedGlobals: pf.blinding.found.globals.map((g) => g.name), clean: pf.blinding.clean }, profileMatched: pf.profile.matched };
  cost.browser.sessions += 1;

  if (!pf.ok) {
    return failClosed({
      surveyId, reason: "PLATFORM_ASSUMPTION_VIOLATED", preflight: pf,
      prose: null, cost, t0, counters, diagnostics,
    });
  }

  // ═══════════════════════════════════════════════ 2. INGEST ══
  phase = "ingestion";
  const ing = chooseIngester(opts.ingester);
  const tIng = Date.now();
  let ingested;
  try {
    ingested = await ing.run({
      docxPath: ctx.docxPath, surveyId, model, log,
      replayPath: opts.replayPath ?? process.env.SQA_ARM_B_REPLAY ?? null,
      cacheDir: opts.cacheDir,
    });
  } catch (e) {
    if (isBudgetError(e)) throw e;
    return failClosed({
      surveyId, reason: "INGESTION_FAILED",
      prose:
        `Arm B could not build Graph-D from ${basename(ctx.docxPath)} using the shared extraction (${ing.name}): ${e.message}. ` +
        "It will NOT substitute a private parser — PRE-REGISTRATION.md §8.1 makes shared ingestion load-bearing, and a different " +
        "parser would turn this experiment into a measurement of docx parsers reported as a measurement of architecture.",
      cost, t0, counters, diagnostics,
    });
  }
  timings.ingestionMs = Date.now() - tIng;
  diagnostics.ingestion = ingested.report;

  if (ingested.report?.cost) {
    cost.ingestion.tokensIn = ingested.report.cost.tokensIn;
    cost.ingestion.tokensOut = ingested.report.cost.tokensOut;
    cost.ingestion.usd = ingested.report.cost.usd;
    cost.ingestion.provider = ingested.report.provenance?.module ?? null;
    if (!cost.ingestion.modelCalls) cost.ingestion.modelCalls = ingested.report.cost.modelCalls;
  }
  if (ingested.report?.telemetryGap) cost.telemetryGaps.push(ingested.report.telemetryGap);

  if (!ingested.ir) {
    return failClosed({
      surveyId, reason: ingested.report?.blocked?.code || "NO_GRAPH_D",
      prose: ingested.report?.blocked?.detail
        || `Graph-D did not validate: ${(ingested.report?.irValidation?.errors || []).join("; ")}`,
      cost, t0, counters, diagnostics, extra: ingested.report,
    });
  }
  const ir = ingested.ir;
  if (opts.recordExtractionTo && ingested.extraction?.merged) {
    mkdirSync(dirname(opts.recordExtractionTo), { recursive: true });
    writeFileSync(opts.recordExtractionTo, JSON.stringify({ merged: ingested.extraction.merged, expansion: ingested.extraction.expansion, calls: ingested.extraction.calls }, null, 1));
  }

  // ═══════════════════════════════════════════════ 3. CRAWL ══
  phase = "crawl";
  const tCrawl = Date.now();
  let graphS = null;
  let budgetExhausted = false;
  try {
    graphS = await crawlSurvey(page, url, {
      surveyId,
      maxJourneys: opts.maxJourneys ?? Number(process.env.SQA_ARM_B_MAX_JOURNEYS ?? 1500),
      log,
    });
  } catch (e) {
    if (!isBudgetError(e)) {
      return failClosed({
        surveyId, reason: "CRAWL_FAILED",
        prose: `The site crawl aborted: ${e.message}. Graph-S is incomplete, so no comparison was performed.`,
        cost, t0, counters, diagnostics,
      });
    }
    budgetExhausted = true;
    log(`crawl stopped on budget: ${e.message}`);
  }
  timings.crawlMs = Date.now() - tCrawl;
  if (!graphS) {
    return failClosed({
      surveyId, reason: "BUDGET_BEFORE_ANY_GRAPH",
      prose: "The budget was exhausted before the crawler recovered any site graph, so nothing was compared.",
      cost, t0, counters, diagnostics,
    });
  }
  cost.browser.journeys = graphS.stats.journeys;
  diagnostics.crawl = {
    nodes: Object.keys(graphS.nodes).length, edges: graphS.edges.length, rejections: graphS.rejections.length,
    journeys: graphS.stats.journeys, budgetExhausted: graphS.stats.budgetExhausted || budgetExhausted,
    historyDependentEdges: graphS.historyDependentEdges.length, assumptions: graphS.assumptions,
  };

  // ═══════════════════════════════════════════════ 4. ALIGN (DOC-01) ══
  phase = "align";
  const align = alignIdentifiers(ir, graphS);
  diagnostics.alignment = align;
  if (align.matched.length === 0 && ir.questions.length && Object.keys(graphS.nodes).length) {
    return failClosed({
      surveyId, reason: "IDENTIFIER_NAMESPACE_MISMATCH",
      prose:
        `Not one of the ${ir.questions.length} question identifier(s) recovered from the document matches any of the ` +
        `${Object.keys(graphS.nodes).length} the site rendered. Document: ${ir.questions.slice(0, 6).map((q) => q.id).join(", ")}. ` +
        `Site: ${Object.keys(graphS.nodes).slice(0, 6).join(", ")}. Comparing them would report every documented question as absent ` +
        "and every rendered screen as undocumented — dozens of confident false positives from one namespace mismatch. " +
        "The arm asserts nothing instead (assumption DOC-01).",
      cost, t0, counters, diagnostics,
    });
  }

  // ═══════════════════════════════════════════════ 5. COMPARE ══
  phase = "compare";
  const tDiff = Date.now();
  const a = levelA(ir, graphS);
  const b = levelB(ir, graphS, { resync: true });
  const bNoResync = levelB(ir, graphS, { resync: false });
  const c = levelC(ir, graphS);
  const cp = levelCProbes(ir, graphS);
  timings.diffMs = Date.now() - tDiff;

  const { guards, report: leakReport } = makeLeakGuards(ir);
  guards.recordResync(b, bNoResync);

  // ═══════════════════════════════════════════════ 6. MAP ══
  const mapper = makeMapper({ ir, graphS, guards, surveyId });
  mapper.fromLevelB(b);
  mapper.fromLevelA(a);
  mapper.fromLevelC(c);
  mapper.fromLevelCProbes(cp);

  // L4 assertion: no routing/terminate defect may sit on an edge whose ANSWER the
  // document forbids. `diff.mjs` separates them; this is the check that it happened, and
  // it is written so that it CAN fail (CLAUDE.md: "beware the check that cannot fail").
  const inadmissible = new Set(
    (a.rows || []).filter((r) => r.verdict === "SITE-ACCEPTS-INVALID").map((r) => `${r.from}|${r.classKey}`),
  );
  const routingRaw = [
    ...(b.findings || []).filter((f) => f.kind === "MIS-ROUTE").map((f) => ({ at: f.at, classKey: f.classKey })),
    ...(a.rows || []).filter((r) => r.verdict === "MIS-ROUTE").map((r) => ({ at: r.from, classKey: r.classKey })),
  ];
  const l4 = guards.assertValidationSeparated(inadmissible, routingRaw);

  // ---- assumption + limitation observations ---------------------------------------
  for (const chk of pf.checks) {
    if (chk.verdict === "holds") continue;
    mapper.observation({
      prose:
        chk.verdict === "undetectable"
          ? `UNDETECTABLE ASSUMPTION ${chk.id} (${chk.name}): ${chk.statement} This cannot be checked from inside a browser session — ${chk.detail} ` +
            `Consequence if it is false: ${chk.failureMode}`
          : `ASSUMPTION ${chk.id} (${chk.name}) DOES NOT HOLD on this survey: ${chk.detail} Consequence: ${chk.failureMode}`,
      evidence: [{ kind: "dom", ref: `${surveyId}:assumption:${chk.id}` }],
    });
  }
  if (align.documentOnly.length || align.siteOnly.length || align.renamed.length) {
    mapper.observation({
      prose:
        `IDENTIFIER ALIGNMENT (assumption DOC-01): ${align.matched.length} of ${ir.questions.length} documented identifier(s) matched a rendered screen` +
        (align.renamed.length ? `; ${align.renamed.length} matched only after canonicalisation (${align.renamed.map((r) => `${r.from}->${r.to}`).join(", ")})` : "") +
        (align.documentOnly.length ? `; ${align.documentOnly.length} documented identifier(s) never appeared on the site (${align.documentOnly.join(", ")})` : "") +
        (align.siteOnly.length ? `; ${align.siteOnly.length} rendered screen(s) have no documented counterpart (${align.siteOnly.join(", ")})` : "") +
        ". Reported rather than asserted, because a partial namespace overlap is at least as likely to be an extraction gap as a site defect.",
      evidence: [{ kind: "graph-edge", ref: `${surveyId}:alignment` }],
    });
  }
  const comp = completeness(ir);
  const caveatCount = (ir.__caveats || []).length;
  if (caveatCount) {
    mapper.observation({
      prose:
        `COMPILED WITH STATED WEAKNESSES: ${caveatCount} routing datum/data compiled into Graph-D but carry an ` +
        "expectation gap the shared expander attached, by code: " +
        Object.entries(comp.caveatsByCode).map(([k, n]) => `${k} ×${n}`).join(", ") +
        ". Example: a destination that reads as a terminal state is typed, but no model-free predicate can tell one " +
        "terminal state from another — so a route that ends the interview is checkable, and WHICH ending it reaches is not.",
      evidence: [{ kind: "graph-edge", ref: `${surveyId}:ingestion-caveats` }],
    });
  }
  if (comp.requirementsUnresolved) {
    mapper.observation({
      prose:
        `INGESTION COMPLETENESS: ${comp.requirementsCompiled} of ${comp.requirementsIn} extracted requirement(s) became graph; ` +
        `${comp.requirementsUnresolved} did not, by reason: ` +
        Object.entries(comp.unresolvedByCode).map(([k, n]) => `${k} ×${n}`).join(", ") +
        ". Those requirements are NOT covered by anything this arm did, and coverage arithmetic below does not count them — " +
        "FINDINGS.md §6 records the failure mode this guards against: 'if extraction omits a requirement it is absent from the register, " +
        "absent from the checklist, and coverage arithmetic still reports 100%'.",
      evidence: [{ kind: "graph-edge", ref: `${surveyId}:ingestion-completeness` }],
    });
  }
  const undecidable = a.counts?.undecidable ?? 0;
  const residue = coverageResidue(ir);
  mapper.observation({
    prose:
      `COVERAGE RESIDUE — what traversal could not settle, enumerated rather than omitted: ` +
      `${undecidable} of ${(a.counts.agree + a.counts.misroute + undecidable)} observed site edges are not locally decidable ` +
      `(${((a.decidableShare || 0) * 100).toFixed(0)}% decidable); ` +
      `${graphS.historyDependentEdges.length} edge(s) proved history-dependent; ` +
      `${(graphS.assumptions || []).length} crawler assumption(s) recorded (e.g. numeric domains sampled, not proved); ` +
      `${residue.length} structural residue item(s): ` + [...new Set(residue.map((r) => r.kind))].join(", ") + ".",
    evidence: [{ kind: "graph-edge", ref: `${surveyId}:residue` }],
  });
  if (!l4.ok) {
    mapper.blocker({
      prose:
        `LEAK GUARD L4 FAILED: ${l4.violations.length} routing finding(s) sit on edges whose answer the document forbids ` +
        `(${l4.violations.join(", ")}). Validation is masquerading as routing (FINDINGS.md §3), so the routing findings in this run ` +
        "are not trustworthy and should not be scored as routing.",
      evidence: [{ kind: "graph-edge", ref: `${surveyId}:L4` }],
    });
  }
  for (const gap of cost.telemetryGaps) {
    mapper.observation({ prose: `COST TELEMETRY GAP: ${gap}`, evidence: [{ kind: "trace", ref: `${surveyId}:telemetry-gap` }] });
  }
  mapper.emitDowngradeObservations();

  // ═══════════════════════════════════════════════ 7. COVERAGE + COST ══
  phase = "coverage";
  const basisOf = (u) =>
    u.attribute ? attributeBasis(ir, u.node, u.aspect) : edgeBasis(ir, u.from, u.to);
  const claimedUnits = buildCoverageUnits({
    ir, graphS, findings: mapper.findings,
    budgetExhausted: budgetExhausted || graphS.stats.budgetExhausted,
    basisOf,
  });

  cost.browser.gotos = counters.gotos;
  cost.browser.evaluates = counters.evaluates;
  const wallClockMs = Date.now() - t0;

  // THE ASSERTION THAT MAKES THE HEADLINE CLAIM A MEASUREMENT.
  const judgementFree = cost.judgement.modelCalls === 0;
  if (!judgementFree) {
    mapper.blocker({
      prose:
        `ARM B INVARIANT BROKEN: ${cost.judgement.modelCalls} model call(s) were made outside ingestion. Arm B is defined as ` +
        "'no model at JUDGEMENT'; a run that used one is not arm B and its ablation contrast (C − B = what the model adds) is void.",
      evidence: [{ kind: "trace", ref: `${surveyId}:judgement-model-calls` }],
    });
  }

  diagnostics.leakGuards = leakReport();
  diagnostics.levels = {
    levelA: { counts: a.counts, decidableShare: a.decidableShare },
    levelB: { findings: b.findings.length, journeysReplayed: b.journeysReplayed, journeysClean: b.journeysClean, resyncsUsed: b.resyncsUsed, resyncFailures: b.resyncFailures },
    levelBFirstDivergenceOnly: bNoResync.findings.length,
    levelC: c.findings.length,
    levelCProbes: cp.length,
  };
  diagnostics.coverage = summariseUnits(claimedUnits);
  diagnostics.findingStats = mapper.stats();
  diagnostics.timings = { ...timings, wallClockMs };

  return {
    findings: mapper.findings,
    claimedUnits,
    selfReportedCost: {
      note:
        "Self-reported and NEVER scored (PRE-REGISTRATION.md §3.4). It exists so the report can show the delta between what the arm " +
        "believed it spent and what the harness observed.",
      ...cost,
      wallClockMs,
      judgementIsModelFree: judgementFree,
      judgementFreeEvidence:
        "Model calls are counted per phase at the ctx.model boundary. Steps 3-7 (crawl, align, compare, map, coverage) made " +
        `${cost.judgement.modelCalls} model call(s). Ingestion is a shared control and is counted separately.`,
    },
    diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────── fail-closed ──

/**
 * The shape of a run that could not proceed. Note what it is NOT: an empty finding list.
 * Every unit is `blocked`, and the blocker says which assumption failed and what the
 * consequence of proceeding would have been.
 */
function failClosed({ surveyId, reason, prose, preflight: pf, cost, t0, counters, diagnostics, extra }) {
  const findings = [];
  let n = 0;
  const push = (claimClass, p, ref) => {
    n += 1;
    findings.push({
      findingId: `B${n}`, claimClass,
      location: { raw: "survey", scope: "survey" },
      attribution: "graph",
      evidence: [{ kind: "dom", ref: `${surveyId}:${ref}` }],
      prose: p, confidence: null,
    });
  };

  if (pf) {
    for (const chk of pf.blockers) {
      push("blocker",
        `ASSUMPTION ${chk.id} (${chk.name}) DOES NOT HOLD, and it is load-bearing: ${chk.detail} ` +
        `Consequence of proceeding anyway: ${chk.failureMode} Arm B therefore asserted NOTHING about this survey. ` +
        "This is a limitation of the arm, not a statement that the survey is correct.",
        `blocker:${chk.id}`);
    }
    for (const chk of pf.limitations) {
      push("observation",
        chk.verdict === "undetectable"
          ? `UNDETECTABLE ASSUMPTION ${chk.id} (${chk.name}): ${chk.detail}`
          : `ASSUMPTION ${chk.id} (${chk.name}) does not hold: ${chk.detail} Consequence: ${chk.failureMode}`,
        `assumption:${chk.id}`);
    }
  }
  if (prose) push("blocker", prose, reason);
  if (!findings.length) push("blocker", `Arm B stopped: ${reason}.`, reason);

  return {
    findings,
    claimedUnits: [{
      unitId: "U-BLOCKED", location: "survey", status: "blocked", verdict: "not-assessed",
      note: `${reason}: nothing was compared, so nothing is claimed`,
    }],
    selfReportedCost: {
      ...cost,
      browser: { ...cost.browser, gotos: counters.gotos, evaluates: counters.evaluates },
      wallClockMs: Date.now() - t0,
      stoppedAt: reason,
      judgementIsModelFree: cost.judgement.modelCalls === 0,
    },
    diagnostics: { ...diagnostics, stoppedAt: reason, ...(extra ? { detail: extra } : {}) },
  };
}

// ────────────────────────────────────────────────────────────────────── CLI ──
/**
 * Standalone entrypoint, for driving one (docx, url) pair without the evaluation harness.
 * It builds the same `ctx` the harness would, using the spike's own CDP driver, so the
 * code path is identical — a CLI that took a different path would prove nothing about the
 * arm.
 *
 *   node graph-spike/arm/entry.mjs --docx <f.docx> --url http://host/index.html [--out r.json]
 *                                  [--ingester shared-extract|manifest] [--max-journeys N]
 */
async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--docx") args.docx = argv[++i];
    else if (t === "--url") args.url = argv[++i];
    else if (t === "--out") args.out = argv[++i];
    else if (t === "--ingester") args.ingester = argv[++i];
    else if (t === "--max-journeys") args.maxJourneys = Number(argv[++i]);
    else if (t === "--replay") args.replay = argv[++i];
    else if (t === "--record-extraction") args.record = argv[++i];
  }
  if (!args.docx || !args.url) {
    console.error(
      "usage: node graph-spike/arm/entry.mjs --docx <questionnaire.docx> --url <surveyURL>\n" +
        "                                     [--out <result.json>] [--ingester shared-extract|manifest]\n" +
        "                                     [--max-journeys N] [--replay <extraction.json>]\n" +
        "                                     [--record-extraction <path>]",
    );
    process.exit(2);
  }
  if (!existsSync(args.docx)) { console.error(`no such document: ${args.docx}`); process.exit(2); }

  const { launch } = await import("./driver.mjs");
  const driver = await launch();
  const events = [];
  const ctx = {
    surveyId: basename(dirname(resolve(args.docx))) || "survey",
    arm: "B",
    baseUrl: new URL(args.url).origin,
    docxPath: resolve(args.docx),
    browser: makeStandaloneBrowser(driver, events),
    model: null,
    budget: { caps: {}, check: () => {} },
    log: (...a) => { const m = a.join(" "); events.push(m); console.error(`  ${m}`); },
  };
  try {
    const r = await runArmB(ctx, {
      ingester: args.ingester, maxJourneys: args.maxJourneys,
      entryPath: new URL(args.url).pathname, replayPath: args.replay, recordExtractionTo: args.record,
    });
    const out = JSON.stringify(r, null, 2);
    if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, `${out}\n`); }
    else console.log(out);
    console.error(
      `\n${ctx.surveyId}: ${r.findings.filter((f) => f.claimClass === "defect").length} defect(s), ` +
        `${r.findings.filter((f) => f.claimClass === "observation").length} observation(s), ` +
        `${r.findings.filter((f) => f.claimClass === "blocker").length} blocker(s), ` +
        `${r.claimedUnits.length} coverage unit(s), ${(r.selfReportedCost.wallClockMs / 1000).toFixed(1)}s`,
    );
  } finally {
    await driver.close().catch(() => {});
  }
}

/**
 * A local stand-in for the harness browser, for CLI use. It keeps the SAME shape and the
 * same observe-after-every-action discipline, so the standalone path cannot accidentally
 * be cheaper or better-behaved than the scored one.
 */
function makeStandaloneBrowser(driver, events) {
  let visits = [];
  return {
    available: true,
    visitLog: visits,
    async goto(u) { await driver.goto(u); await this.observe(); },
    async observe() {
      const s = await driver.evaluate(function () {
        const el = document.querySelector("[data-qid]") || document.querySelector("[data-question-id]");
        return { qid: el?.getAttribute("data-qid") || el?.getAttribute("data-question-id") || null };
      });
      if (s?.qid) visits.push(s.qid);
      return s;
    },
    async act(fn) { const r = await driver.evaluate(fn); await this.observe(); return r; },
    async close() { events.push(`visit log: ${new Set(visits).size} distinct screens, ${visits.length} observations`); },
  };
}

if (process.argv[1] && process.argv[1].endsWith("entry.mjs")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
