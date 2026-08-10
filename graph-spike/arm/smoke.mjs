#!/usr/bin/env node
/**
 * SMOKE RUN — the open `test-suite/branching/` corpus, driven THROUGH the arm interface.
 *
 * The question this answers is narrow and it is the one the brief asks:
 *
 *     Does Arm B still find what `graph-spike/run-all.mjs` found, now that the same
 *     machinery is driven through `evaluation/run-arm.mjs`, a harness-owned browser, the
 *     leak guards, the basis gate, and the normalised finding format?
 *
 * IF THE SCORE DROPS THIS FILE SAYS SO AND WHY. A drop is a real finding about the
 * interface — the guards deliberately downgrade some findings to observations, and a
 * downgrade shows up here as a miss. Hiding that by loosening a guard would be the exact
 * post-hoc shaping PRE-REGISTRATION.md §0 exists to prevent.
 *
 * WHY IT RUNS WITH THE `manifest` INGESTER BY DEFAULT: to make the comparison mean
 * anything, the document side must be held FIXED at what `run-all.mjs` used. Otherwise
 * "the score dropped" is uninterpretable — interface or extraction, no way to tell. The
 * manifest ingester is corpus-privileged and stamps `admissibleInScoredRun: false`; use
 * `--ingester shared-extract` for the real thing, which needs XAI_API_KEY and
 * DEEPSEEK_API_KEY.
 *
 *   node graph-spike/arm/smoke.mjs [--ingester manifest|shared-extract] [--surveys s1,s2]
 *                                  [--max-journeys N] [--out <file>]
 *
 * NOT the blind corpus. `test-suite/blind/**` is never opened here.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runArm } from "../../evaluation/run-arm.mjs";
import armB from "../../evaluation/adapters/b.mjs";
import * as driver from "./driver.mjs";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = resolve(HERE, "..", "..");
const CORPUS = join(REPO, "test-suite", "branching");
const OUT_DIR = join(HERE, "out");

const SURVEYS = ["s1-skip", "s2-screener", "s3-multiselect-piping", "s4-nested-rotation", "s5-allocation", "s6-kitchen-sink"];

/**
 * Seeded-defect category -> the requirement classes a correct finding may carry.
 *
 * This is the same discipline `run-all.mjs` used and for the same reason, stated there:
 * attribution is by an explicit category->detector mapping, NOT by location matching,
 * because several seeded defects share a question (s3 Q3 carries both a broken piping
 * token and an inverted branch) and location matching lets one defect take credit for
 * another's detection.
 */
const CATEGORY_CLASSES = {
  "wrong-skip-target": ["routing", "question-presence-order"],
  "terminate-not-enforced": ["terminate"],
  "wrong-threshold": ["terminate", "routing"],
  "boundary-off-by-one": ["terminate", "routing"],
  "wrong-branch-threshold": ["routing"],
  "inverted-branch": ["routing"],
  "wrong-calc-source": ["routing"],
  "loop-truncated": ["routing", "question-presence-order", "terminate"],
  "missing-option": ["option-list"],
  "missing-instruction": ["wording"],
  "broken-piping": ["piping", "wording"],
  "carry-forward-broken": ["carry-forward", "option-list"],
  "rotation-anchor-violation": ["randomisation-anchors", "option-order"],
  "allocation-sum-not-validated": ["validation"],
  "row-cap-removed": ["validation"],
};

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Stage one corpus survey in the layout `run-arm.mjs` requires:
 *   <dir>/questionnaire.docx   the document, and the ONLY corpus file the arm gets
 *   <dir>/site/engine.js       the page's own runtime
 *   <dir>/site/s/index.html    the page  (its `../engine.js` then resolves correctly)
 *
 * The page bytes are copied unmodified. Rewriting the script tag so the file could sit at
 * the site root would mean the arm was measured against a page nobody ships.
 */
function stage(surveyId, variant, root) {
  const dir = join(root, `${surveyId}.${variant}`);
  mkdirSync(join(dir, "site", "s"), { recursive: true });
  copyFileSync(join(CORPUS, surveyId, "questionnaire.docx"), join(dir, "questionnaire.docx"));
  copyFileSync(join(CORPUS, "engine.js"), join(dir, "site", "engine.js"));
  copyFileSync(join(CORPUS, surveyId, `${variant}.html`), join(dir, "site", "s", "index.html"));
  // Only read by the corpus-privileged ingester, and only when it is explicitly enabled.
  copyFileSync(join(CORPUS, surveyId, "manifest.json"), join(dir, "manifest.json"));
  return dir;
}

/** Question ids a seeded defect touches, resolved through the flawed manifest's patch pointers. */
function lociOf(cleanManifest, flawedManifest, errId) {
  const flawedErr = (flawedManifest.seededErrors || []).find((e) => e.id === errId);
  const locs = new Set();
  for (const p of flawedErr?.patch || []) {
    const parts = String(p.path).split("/").slice(1);
    if (parts[0] === "questions") {
      const q = cleanManifest.questions[Number(parts[1])];
      if (q) locs.add(q.id);
    } else if (parts[0] === "loops") {
      const l = cleanManifest.loops?.[Number(parts[1])];
      for (const b of l?.block || []) locs.add(b);
    } else if (parts[0] === "computed") {
      const c = cleanManifest.computed?.[Number(parts[1])];
      for (const q of cleanManifest.questions) {
        for (const r of q.rules || []) if (JSON.stringify(r.if || {}).includes(c?.id)) locs.add(q.id);
      }
    }
  }
  return locs;
}

async function main(argv) {
  const args = { ingester: "manifest", surveys: SURVEYS, maxJourneys: 1500 };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--ingester") args.ingester = argv[++i];
    else if (t === "--surveys") args.surveys = argv[++i].split(",").map((s) => SURVEYS.find((x) => x.startsWith(s)) || s);
    else if (t === "--max-journeys") args.maxJourneys = Number(argv[++i]);
    else if (t === "--out") args.out = argv[++i];
    else if (t === "--keep") args.keep = true;
  }

  process.env.SQA_ARM_B_INGEST = args.ingester;
  process.env.SQA_ARM_B_ENTRY = "/s/index.html";
  process.env.SQA_ARM_B_MAX_JOURNEYS = String(args.maxJourneys);
  process.env.SQA_ARM_B_SHA = process.env.SQA_ARM_B_SHA || "smoke-unpinned";

  const staging = join(tmpdir(), `arm-b-smoke-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const corpus = readJson(join(CORPUS, "corpus.json"));
  const caps = readJson(join(REPO, "evaluation", "budget.json")).caps;

  const results = {};
  const t0 = Date.now();
  try {
    for (const s of args.surveys) {
      for (const variant of ["index", "flawed"]) {
        const dir = stage(s, variant, staging);
        process.stderr.write(`\n── ${s}/${variant} (${args.ingester}) ─────────────────────────\n`);
        const r = await runArm({
          arm: "B",
          surveyDir: dir,
          outDir: join(OUT_DIR, "results", args.ingester),
          adapter: armB,
          driver,
          modelProxy: null,
          caps,
          pricing: {},
          seed: undefined,
          // Same resolution the CLI would use, third branch (`adapter.identity()`):
          // schema 1.1.0 rejects a result that cannot name its build, and the smoke run
          // must exercise the real validation rather than a relaxed copy of it.
          armIdentity: armB.identity(),
        });
        results[`${s}/${variant}`] = {
          findings: r.result.findings,
          claimedUnits: r.result.coverage.claimedUnits,
          selfReportedCost: r.result.selfReportedCost,
          telemetry: {
            visitedScreens: r.telemetry.cost.nodeVisits,
            browserActions: r.telemetry.cost.browserActions,
            browserSessions: r.telemetry.cost.browserSessions,
            modelCalls: r.telemetry.cost.modelCalls,
            wallClockMs: r.telemetry.cost.wallClockMs,
            stopReason: r.telemetry.stopReason,
          },
          schemaOk: r.validation.ok,
          schemaErrors: r.validation.errors,
          diagnostics: lastDiagnostics(r.telemetry),
        };
        const d = results[`${s}/${variant}`];
        process.stderr.write(
          `   ${d.findings.filter((f) => f.claimClass === "defect").length} defect · ` +
            `${d.findings.filter((f) => f.claimClass === "observation").length} obs · ` +
            `${d.findings.filter((f) => f.claimClass === "blocker").length} blocker · ` +
            `${d.claimedUnits.length} units · ${d.telemetry.visitedScreens} screens · ` +
            `${(d.telemetry.wallClockMs / 1000).toFixed(0)}s · schema ${d.schemaOk ? "OK" : "ERRORS"}\n`,
        );
      }
    }
  } finally {
    if (!args.keep) rmSync(staging, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────── score against the key ──
  const table = [];
  for (const entry of corpus.surveys) {
    if (!args.surveys.includes(entry.id)) continue;
    const clean = readJson(join(CORPUS, entry.id, "manifest.json"));
    const flawed = readJson(join(CORPUS, entry.id, "manifest.flawed.json"));
    const res = results[`${entry.id}/flawed`];
    if (!res) continue;
    for (const err of entry.seededErrors) {
      const loci = lociOf(clean, flawed, err.id);
      const admissible = CATEGORY_CLASSES[err.category] || [];
      const matched = res.findings.filter(
        (f) => f.claimClass === "defect" && loci.has(f.location.raw) && admissible.includes(f.requirementClass),
      );
      const nearby = res.findings.filter((f) => f.claimClass === "defect" && loci.has(f.location.raw));
      const downgraded = res.findings.filter(
        (f) => f.claimClass === "observation" && [...loci].some((l) => String(f.prose).includes(l)),
      );
      table.push({
        id: err.id, survey: entry.id, category: err.category, loci: [...loci],
        admissibleClasses: admissible,
        detected: matched.length > 0,
        matched: matched.map((f) => `${f.requirementClass}/${f.observable.predicate}@${f.location.raw}`),
        otherFindingsAtLocus: nearby.filter((f) => !matched.includes(f)).map((f) => `${f.requirementClass}/${f.observable.predicate}`),
        downgradedToObservation: downgraded.length > 0 ? downgraded.map((f) => f.prose.slice(0, 160)) : null,
      });
    }
  }

  // False positives: any defect assertion on a CLEAN page is a false positive by
  // construction — the clean pages carry no seeded defects.
  const fps = {};
  for (const s of args.surveys) {
    const res = results[`${s}/index`];
    if (!res) continue;
    fps[s] = res.findings
      .filter((f) => f.claimClass === "defect")
      .map((f) => `${f.requirementClass}/${f.observable.predicate}@${f.location.raw} exp=${f.observable.expected} act=${f.observable.actual}`);
  }

  // ────────────────────────────────────────────── compare with the spike baseline ──
  const spikePath = join(HERE, "..", "out", "seeded-defect-table.json");
  let vsSpike = null;
  if (existsSync(spikePath)) {
    const spike = readJson(spikePath);
    const spikeDetected = new Set(spike.filter((r) => r.verdict !== "NOT DETECTED").map((r) => r.id));
    const armDetected = new Set(table.filter((r) => r.detected).map((r) => r.id));
    vsSpike = {
      spikeBaseline: `${spikeDetected.size}/${spike.length} detected by graph-spike/run-all.mjs`,
      armThroughInterface: `${armDetected.size}/${table.length} detected through the arm interface`,
      lostByTheInterface: [...spikeDetected].filter((id) => table.some((t) => t.id === id) && !armDetected.has(id)),
      gainedByTheInterface: [...armDetected].filter((id) => !spikeDetected.has(id)),
      spikeCleanFalsePositives: Object.fromEntries(spike.map((r) => [r.id, r.cleanPageFalsePositives]).filter(([, n]) => n > 0)),
    };
  }

  const summary = {
    generated: new Date().toISOString(),
    ingester: args.ingester,
    admissibleInScoredRun: args.ingester !== "manifest",
    surveys: args.surveys,
    wallClockMs: Date.now() - t0,
    seededDefects: {
      total: table.length,
      detected: table.filter((r) => r.detected).length,
      missed: table.filter((r) => !r.detected).map((r) => ({ id: r.id, category: r.category, loci: r.loci, downgraded: Boolean(r.downgradedToObservation), other: r.otherFindingsAtLocus })),
      table,
    },
    falsePositivesOnCleanPages: {
      total: Object.values(fps).reduce((a, x) => a + x.length, 0),
      bySurvey: fps,
    },
    schema: {
      allValid: Object.values(results).every((r) => r.schemaOk),
      errors: Object.entries(results).filter(([, r]) => !r.schemaOk).map(([k, r]) => ({ run: k, errors: r.schemaErrors })),
    },
    coverage: Object.fromEntries(
      Object.entries(results).map(([k, r]) => {
        const byStatus = r.claimedUnits.reduce((a, u) => { a[u.status] = (a[u.status] || 0) + 1; return a; }, {});
        const claimedExercised = r.claimedUnits.filter((u) => u.status === "exercised");
        return [k, {
          units: r.claimedUnits.length, byStatus,
          exercised: claimedExercised.length,
          harnessVisitedScreens: r.telemetry.visitedScreens,
        }];
      }),
    ),
    cost: Object.fromEntries(
      Object.entries(results).map(([k, r]) => [k, {
        harnessObservedModelCalls: r.telemetry.modelCalls,
        armReportedIngestionCalls: r.selfReportedCost?.ingestion?.modelCalls ?? null,
        armReportedJudgementCalls: r.selfReportedCost?.judgement?.modelCalls ?? null,
        judgementIsModelFree: r.selfReportedCost?.judgementIsModelFree ?? null,
        browserSessions: r.telemetry.browserSessions,
        browserActions: r.telemetry.browserActions,
        wallClockMs: r.telemetry.wallClockMs,
      }]),
    ),
    vsSpike,
  };

  const outPath = args.out || join(OUT_DIR, `smoke-${args.ingester}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ summary, results }, null, 1)}\n`);

  // ─────────────────────────────────────────────────────────────────── the report ──
  console.log(`\n${"═".repeat(78)}`);
  console.log(`ARM B SMOKE — ${args.ingester} ingester${args.ingester === "manifest" ? "  (CORPUS-PRIVILEGED, not admissible in a scored run)" : ""}`);
  console.log("═".repeat(78));
  console.log(`seeded defects detected : ${summary.seededDefects.detected}/${summary.seededDefects.total}`);
  console.log(`false positives (clean) : ${summary.falsePositivesOnCleanPages.total}`);
  console.log(`schema valid            : ${summary.schema.allValid ? "yes, all runs" : "NO — " + JSON.stringify(summary.schema.errors).slice(0, 300)}`);
  if (vsSpike) {
    console.log(`spike baseline          : ${vsSpike.spikeBaseline}`);
    console.log(`through the interface   : ${vsSpike.armThroughInterface}`);
    if (vsSpike.lostByTheInterface.length) console.log(`LOST BY THE INTERFACE   : ${vsSpike.lostByTheInterface.join(", ")}`);
  }
  if (summary.seededDefects.missed.length) {
    console.log("\nMISSED:");
    for (const m of summary.seededDefects.missed) {
      console.log(`  ${m.id} (${m.category}) at ${m.loci.join(",")}${m.downgraded ? "  [downgraded to an observation by a leak guard]" : ""}` +
        (m.other?.length ? `  other findings here: ${m.other.join(", ")}` : ""));
    }
  }
  for (const [s, list] of Object.entries(fps)) {
    if (list.length) { console.log(`\nFALSE POSITIVES on clean ${s}:`); for (const f of list) console.log(`  ${f}`); }
  }
  console.log(`\nwrote ${outPath}`);
}

/** The arm logs its diagnostics through ctx.log, which the harness records in telemetry. */
function lastDiagnostics(telemetry) {
  for (let i = (telemetry.events || []).length - 1; i >= 0; i -= 1) {
    const m = telemetry.events[i].msg || "";
    if (m.startsWith("arm B diagnostics: ")) {
      try { return JSON.parse(m.slice("arm B diagnostics: ".length)); } catch { return null; }
    }
  }
  return null;
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
