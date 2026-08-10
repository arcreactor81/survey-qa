/**
 * INGESTION — where Graph-D comes from.
 *
 * Two ingesters, and the difference between them is the honest hard part of this arm.
 *
 * ┌──────────────────┬────────────────────────────────────────┬─────────────────────────┐
 * │ ingester         │ source                                 │ admissible in a scored  │
 * │                  │                                        │ run?                    │
 * ├──────────────────┼────────────────────────────────────────┼─────────────────────────┤
 * │ `shared-extract` │ questionnaire.docx -> worker-v2/src/   │ YES. This is the arm.   │
 * │  (DEFAULT)       │ extract (Grok pass A + DeepSeek pass B) │                         │
 * │ `manifest`       │ the corpus's own machine-readable      │ NO. Corpus-privileged;  │
 * │                  │ manifest.json sitting next to the docx │ refuses unless opted in │
 * └──────────────────┴────────────────────────────────────────┴─────────────────────────┘
 *
 * `manifest` exists for exactly one purpose and it is a scientific one: it holds the
 * document side FIXED so a smoke run measures what the ARM INTERFACE costs, not what the
 * extractor costs. Without it, "the score dropped" would be uninterpretable — interface
 * or ingestion, no way to tell. With it, the two are separable. It is refused by default,
 * announces itself in the run's provenance, and any output produced with it carries
 * `admissibleInScoredRun: false`.
 *
 * FINDINGS.md §2 is the reason the default is the other way round:
 *
 *     "A deterministic docx parser also recovered 703/703 requirements with 0 spurious.
 *      DO NOT QUOTE THAT NUMBER. The corpus .docx files are GENERATED from the manifests,
 *      so the parser is inverting a renderer. […] The useful signal is negative:
 *      comparison is not the hard part; EXTRACTION is."
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  loadSharedExtraction, nodeEnvForExtraction, credentialsAvailable, readDocxBytes,
  withProxiedModelTraffic,
} from "./extract-bridge.mjs";
import { emptyIR, unresolved, caveat, UNRESOLVED_CODES, validateIR, completeness } from "./ir.mjs";

// ───────────────────────────────────────────────────────────── id canonicalisation ──
/**
 * Canonical form of a question identifier, used ONLY to decide whether two spellings are
 * the same node. Deliberately narrow: case and separator differences are the same node;
 * anything else is not. A looser rule here would silently merge two questions, and a
 * merged node is a defect that can never be found.
 */
export function canonId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).normalize("NFKC").trim().replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return s || null;
}

/** Does this string look like a question identifier rather than prose? */
export function looksLikeQuestionId(raw) {
  return typeof raw === "string" && /^[A-Za-z]{1,4}\s*\d{1,3}[a-z]?$/.test(raw.trim());
}

const TERMINAL_TO_END = { screenout: "END:terminated", quota: "END:terminated", complete: "END:completed" };

// ═══════════════════════════════════════════════════════ INGESTER 1: the real one ══

/**
 * Graph-D from a real `.docx`, via the shared extraction.
 *
 * @returns {{ ir, extraction, report }}
 */
export async function ingestSharedExtract({
  docxPath,
  surveyId,
  model = null,            // ctx.model, so ingestion tokens land in HARNESS telemetry
  log = () => {},
  replayPath = null,       // a previously recorded extraction, for cost-free re-runs
  cacheDir = null,
} = {}) {
  const provenance = {
    ingester: "shared-extract",
    module: "worker-v2/src/extract (pass A: Grok whole-document, pass B: DeepSeek block-by-block)",
    surveyId,
    documentPath: docxPath,
    admissibleInScoredRun: true,
    sharedIngestionControl: "PRE-REGISTRATION.md §8.1 — every arm must use this same module",
  };

  const { module: X, fingerprint } = await loadSharedExtraction({ outDir: cacheDir });
  provenance.bundleFingerprint = fingerprint;

  // ---- 1. the deterministic half: archive -> source blocks -------------------------
  // This part involves NO model and is where the document's own coverage report comes
  // from ("there are 4 footnotes I could not read" — CLAUDE.md).
  const doc = X.parseDocxBlocks(readDocxBytes(docxPath));
  log(
    `ingest: ${doc.blocks.length} source blocks from ${basename(docxPath)} ` +
      `(${doc.coverage.archiveParts} archive parts, ${doc.coverage.partsSkipped.length} skipped, ` +
      `${doc.coverage.problems.length} problem(s) reported by the parser)`,
  );

  // ---- 2. the model half -----------------------------------------------------------
  let merged = null;
  let expansion = null;
  let calls = [];
  let telemetryGap = null;
  let modelPasses = null;

  if (replayPath) {
    const rec = JSON.parse(readFileSync(replayPath, "utf8"));
    merged = rec.merged;
    expansion = rec.expansion;
    calls = rec.calls || [];
    provenance.replayedFrom = replayPath;
    log(`ingest: REPLAYED a recorded extraction from ${basename(replayPath)} — no model calls made`);
  } else {
    const creds = credentialsAvailable();
    if (!creds.both) {
      // Fail LOUDLY. Not "fall back to a regex parser", which would break the shared
      // ingestion control and produce a number nobody could interpret.
      return {
        ir: null,
        extraction: { doc, blocked: true },
        report: {
          provenance,
          blocked: {
            code: "INGESTION_UNAVAILABLE",
            detail:
              `the shared extraction needs ${creds.missing.join(" and ")}, which are held in the Cloudflare ` +
              "Secrets Store and are not present in this process. Arm B will NOT substitute a private parser: " +
              "PRE-REGISTRATION.md §8.1 makes shared ingestion load-bearing, and a different parser would make " +
              "this experiment a measurement of docx parsers reported as a measurement of architecture. " +
              "Supply the keys as environment variables, or pass --replay with a recorded extraction.",
          },
          documentCoverage: doc.coverage,
        },
      };
    }

    const env = nodeEnvForExtraction();
    const runId = `armb_${surveyId}_${Date.now().toString(36)}`;
    X.resetDrops?.();

    const proxied = await withProxiedModelTraffic(model, async () => {
      const passA = await X.runPassA(env, doc, basename(docxPath));
      log(`ingest: pass A (${passA.model}) -> ${passA.requirements.length} global rules, ${passA.failedUnits.length} failed unit(s)`);
      const passB = await X.runPassB(env, runId, doc, basename(docxPath), async (m) => log(`  ${m}`));
      log(`ingest: pass B (${passB.model}) -> ${passB.requirements.length} obligations, ${passB.failedUnits.length} failed unit(s)`);
      const m = await X.mergePasses(passA, passB, doc, passA.crossRefs || []);
      const e = await X.expandFloor(m.rows, { locale: "en", viewport: null });
      return { passA, passB, merged: m, expansion: e };
    });

    modelPasses = proxied.result;
    merged = modelPasses.merged;
    expansion = modelPasses.expansion;
    calls = [...modelPasses.passA.calls, ...modelPasses.passB.calls];
    telemetryGap = proxied.telemetryGap;
  }

  const ir = compileIRFromLedger({ surveyId, provenance, merged, expansion, doc });
  const v = validateIR(ir);

  return {
    ir: v.ok ? ir : null,
    extraction: { doc, merged, expansion, calls, modelPasses },
    report: {
      provenance,
      irValidation: v,
      documentCoverage: doc.coverage,
      completeness: completeness(ir),
      telemetryGap,
      cost: {
        modelCalls: calls.length,
        tokensIn: calls.reduce((a, c) => a + (c.inputTokens || 0), 0),
        tokensOut: calls.reduce((a, c) => a + (c.outputTokens || 0), 0),
        usd: calls.reduce((a, c) => a + (c.costUsd || 0), 0),
      },
      extractionDiff: merged?.diff
        ? {
            counts: merged.diff.counts,
            ambiguities: (merged.diff.ambiguities || []).length,
            unresolvedCrossReferences: (merged.diff.unresolvedCrossReferences || []).length,
          }
        : null,
    },
  };
}

/**
 * THE COMPILER: merged requirement ledger -> Graph-D IR.
 *
 * Everything this function CANNOT do is recorded rather than guessed. The shared
 * extraction's schema (see `ir.mjs` header) carries exactly one typed routing structure —
 * `expansion.route_answers[] = {code, label, destination}` hung off a requirement whose
 * `scope` is `question:<id>`. There is no field for a condition operator, for a condition
 * that reads another question, for fall-through, for question order, or for a full option
 * list. So:
 *
 *   - an edge is emitted only when BOTH the source id and the destination resolve;
 *   - the condition is always `<source> == <code>`, because that is the only condition
 *     the schema can express — a rule the document states differently is recorded as
 *     CONDITION_NOT_EXPRESSIBLE, never approximated;
 *   - option lists are a LOWER BOUND (only the codes that trigger routes), so
 *     `option-absent` stays decidable and `option-present-unexpected` does not;
 *   - question order comes from block order, basis `inferred`, and every fall-through
 *     edge inherits that basis.
 */
export function compileIRFromLedger({ surveyId, provenance, merged, expansion, doc }) {
  const ir = emptyIR({ ...provenance, surveyId });
  ir.__basis = {
    questionSet: "inferred",     // ids mined from `scope`, which the extractor defaults silently
    questionOrder: "inferred",   // block order
    fallThrough: "inferred",     // no field exists for it
    optionSet: "lower-bound",    // only route-triggering codes
    optionOrder: "unknown",
    questionText: "unknown",     // prose only; no typed question text
    routing: "stated",           // typed route_answers
    validation: "partial",       // only max_length / min_selections / max_selections
  };

  const rows = merged?.rows || [];
  const facets = expansion?.facetInstances || [];
  ir.__accounting.requirementsIn = rows.length;

  // ---- block order, for question order --------------------------------------------
  const blockIndex = new Map((doc?.blocks || []).map((b, i) => [b.blockId, i]));
  const firstBlockOf = (row) => {
    let best = Infinity;
    for (const a of row.requirement?.sourceAtoms || []) {
      const i = blockIndex.get(a.blockId);
      if (i !== undefined && i < best) best = i;
    }
    return best;
  };

  // ---- pass 1: which nodes exist ---------------------------------------------------
  /** canonical id -> { display, order, rows[] } */
  const nodes = new Map();
  const noteNode = (rawId, order, row) => {
    const c = canonId(rawId);
    if (!c) return null;
    if (!nodes.has(c)) nodes.set(c, { canon: c, display: String(rawId).trim(), order, rows: [] });
    const n = nodes.get(c);
    if (order < n.order) n.order = order;
    if (row) n.rows.push(row);
    return n;
  };

  const scopeQid = (r) => {
    const m = /^question:(.+)$/i.exec(String(r?.scope ?? ""));
    return m ? m[1].trim() : null;
  };

  for (const row of rows) {
    const order = firstBlockOf(row);
    const qid = scopeQid(row.requirement);
    if (qid) noteNode(qid, order, row);
  }
  // Destinations name nodes too — a question can be routed TO without any requirement
  // being scoped to it, and dropping it would produce a dangling goto that kills replay.
  for (const f of facets) {
    const dest = f?.case?.expectedDestination?.questionId;
    if (dest && looksLikeQuestionId(dest)) noteNode(dest, Infinity, null);
  }

  const ordered = [...nodes.values()].sort((a, b) => (a.order - b.order) || a.canon.localeCompare(b.canon));

  // ---- pass 2: the routing edges ---------------------------------------------------
  /** canon source id -> rules[] */
  const rulesBySource = new Map();
  for (const f of facets) {
    if (f?.case?.kind !== "route") continue;
    const src = canonId(f.targetQuestionId);
    if (!src) {
      unresolved(ir, "NO_QUESTION_SCOPE", `route case ${f.facetInstanceId} has no question scope`, f.requirementLineageId);
      continue;
    }
    const answer = f.case.routeAnswer;
    const dest = f.case.expectedDestination;
    if (!answer || !dest) {
      // The shared expander already did this reasoning and attached its own verdict:
      // `expectationGap` says WHY a destination did not bind (not stated / names several
      // questions / relative phrase / terminal). Re-deriving a reason here would be a
      // second opinion nobody asked for, and would drift from the code
      // `verify-observations.ts` uses for the same condition. So its code and its sentence
      // are carried through verbatim.
      const g = f.expectationGap;
      unresolved(
        ir,
        g?.code ?? "ROUTE_WITHOUT_EXPANSION",
        g?.detail
          ?? `route case at ${f.targetQuestionId} carries no typed answer/destination pair — the rule exists in prose only`,
        f.requirementLineageId,
      );
      continue;
    }
    const code = answer.code === null || answer.code === undefined ? null : Number(String(answer.code).trim());
    if (code === null || Number.isNaN(code)) {
      unresolved(
        ir, "ROUTE_ANSWER_NOT_A_CODE",
        `route at ${f.targetQuestionId} is triggered by "${answer.label ?? answer.code}" with no numeric code; ` +
          "the site answer class cannot be constructed without inventing one",
        f.requirementLineageId,
      );
      continue;
    }
    let to = null;
    if (dest.terminal) {
      to = TERMINAL_TO_END[dest.terminal] ?? "END:terminated";
      if (f.expectationGap) caveat(ir, f.expectationGap.code, f.expectationGap.detail, f.requirementLineageId);
    } else if (dest.questionId && nodes.has(canonId(dest.questionId))) {
      to = canonId(dest.questionId);
      if (f.expectationGap) caveat(ir, f.expectationGap.code, f.expectationGap.detail, f.requirementLineageId);
    }
    if (!to) {
      unresolved(
        ir, "DESTINATION_UNRESOLVED",
        `route at ${f.targetQuestionId} code ${code} lands on "${dest.questionId ?? dest.screen ?? "(nothing)"}", ` +
          "which is neither a known question id nor a recognised terminal",
        f.requirementLineageId,
      );
      continue;
    }
    if (!rulesBySource.has(src)) rulesBySource.set(src, []);
    rulesBySource.get(src).push(
      to.startsWith("END:")
        ? { if: { q: src, op: "eq", value: code }, terminate: `terminate-${src}-${code}`, __basis: "stated", __lineage: f.requirementLineageId }
        : { if: { q: src, op: "eq", value: code }, goto: to, __basis: "stated", __lineage: f.requirementLineageId },
    );
    // The option that triggers a route is an option the document states exists.
    const n = nodes.get(src);
    if (n) {
      n.optionCodes ??= new Map();
      if (!n.optionCodes.has(code)) n.optionCodes.set(code, answer.label ?? null);
    }
    ir.__accounting.requirementsCompiled += 1;
  }

  // ---- pass 3: everything the IR cannot carry, counted -----------------------------
  const compiledLineages = new Set(facets.filter((f) => f?.case?.kind === "route").map((f) => f.requirementLineageId));
  for (const row of rows) {
    const r = row.requirement;
    if (compiledLineages.has(r.requirementLineageId)) continue;
    const facet = String(r.facet || "").toLowerCase();
    if (/skip|route|branch|terminate|navigation/.test(facet)) {
      unresolved(ir, "ROUTE_WITHOUT_EXPANSION", `${facet} requirement with no typed expansion: "${trim(r.normativeStatement)}"`, r.requirementLineageId);
    } else {
      unresolved(
        ir, "CONSTRUCT_NOT_GRAPH_SHAPED",
        `${facet || "unclassified"} requirement is a node attribute the graph cannot express: "${trim(r.normativeStatement)}"`,
        r.requirementLineageId,
      );
    }
  }

  // ---- pass 4: emit the IR questions ------------------------------------------------
  for (const n of ordered) {
    const opts = [...(n.optionCodes || new Map()).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([code, label]) => ({ code, label: label ?? null }));
    ir.questions.push({
      id: n.canon,
      section: null,
      // "unknown" is honoured by compile-d.mjs: no documented input type means no
      // documented validation and no documented option semantics, so the interpreter
      // admits whatever the site accepted rather than manufacturing a violation.
      type: "unknown",
      text: null,
      instruction: null,
      options: opts,
      rules: rulesBySource.get(n.canon) || [],
      __display: n.display,
      __basis: {
        text: "unknown",
        type: "unknown",
        options: opts.length ? "lower-bound" : "unknown",
        optionOrder: "unknown",
        order: "inferred",
        rules: (rulesBySource.get(n.canon) || []).length ? "stated" : "unknown",
      },
    });
  }

  ir.title = null;
  return ir;
}

const trim = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 140);

// ══════════════════════════════════════════ INGESTER 2: the corpus-privileged one ══

/**
 * Graph-D from the branching corpus's own `manifest.json`.
 *
 * REFUSED unless explicitly opted in, because it is not an extraction: it is the
 * generator's own input, sitting next to a `.docx` that was rendered FROM it. Using it
 * measures the graph machinery with the extraction problem held at zero — which is
 * exactly what a smoke run comparing the ARM INTERFACE against `run-all.mjs` needs, and
 * exactly what a scored run must never do.
 */
export function ingestManifest({ docxPath, surveyId, allow = false, log = () => {} } = {}) {
  if (!allow) {
    throw new Error(
      "the `manifest` ingester is corpus-privileged and refuses to run unless explicitly allowed " +
        "(SQA_ARM_B_INGEST=manifest, or {allow:true}). It reads the generator's own input, not the document.",
    );
  }
  const dir = dirname(docxPath);
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Error(`no manifest.json beside ${docxPath}; this ingester only works on the branching corpus`);
  const m = JSON.parse(readFileSync(path, "utf8"));

  const ir = emptyIR({
    ingester: "manifest",
    module: "the corpus's own machine-readable manifest",
    surveyId: surveyId ?? m.id,
    documentPath: docxPath,
    manifestPath: path,
    admissibleInScoredRun: false,
    whyNotAdmissible:
      "the corpus .docx is GENERATED from this file (FINDINGS.md §2), so a score obtained this way is an upper bound on a machine-generated document and says nothing about a real questionnaire",
  });
  Object.assign(ir, {
    id: m.id,
    title: m.title ?? null,
    questions: m.questions,
    loops: m.loops || [],
    computed: m.computed || [],
  });
  ir.__basis = {
    questionSet: "stated", questionOrder: "stated", fallThrough: "stated",
    optionSet: "stated", optionOrder: "stated", questionText: "stated",
    routing: "stated", validation: "stated",
  };
  const n = m.questions.length;
  ir.__accounting = { requirementsIn: n, requirementsCompiled: n, requirementsUnresolved: 0 };
  log(`ingest: manifest ingester (CORPUS-PRIVILEGED) -> ${n} questions, ${(m.loops || []).length} loop(s)`);

  const v = validateIR(ir);
  return {
    ir: v.ok ? ir : null,
    extraction: null,
    report: { provenance: ir.__provenance, irValidation: v, completeness: completeness(ir), documentCoverage: null, cost: { modelCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 } },
  };
}

// ─────────────────────────────────────────────────────────────────── selection ──

export function chooseIngester(name) {
  const n = (name || process.env.SQA_ARM_B_INGEST || "shared-extract").toLowerCase();
  if (n === "manifest") return { name: "manifest", run: (o) => ingestManifest({ ...o, allow: true }) };
  if (n === "shared-extract") return { name: "shared-extract", run: (o) => ingestSharedExtract(o) };
  throw new Error(`unknown ingester "${n}" (expected shared-extract | manifest)`);
}
