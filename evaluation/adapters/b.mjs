/**
 * ARM B — GRAPH-ONLY.  Ablation role: the hybrid minus the model.
 *
 * The questionnaire compiles to a routing graph; the site is crawled into a second graph;
 * traversal is exhaustive by construction and comparison is edge-set arithmetic plus
 * stateful trace replay. Coverage is COMPUTED rather than attested, and JUDGEMENT USES NO
 * MODEL — a claim this arm makes as a measurement (`selfReportedCost.judgement.modelCalls`
 * is asserted to be zero, and a run that broke the invariant emits a blocker saying so).
 *
 * IMPLEMENTATION lives in `graph-spike/arm/`:
 *   entry.mjs           the entrypoint — (docx, url) -> findings + cost telemetry
 *   platform.mjs        the declared platform conventions and the pre-flight that CHECKS them
 *   ingest.mjs          Graph-D from a real .docx via worker-v2/src/extract (§8.1 shared control)
 *   leaks.mjs           the five leaks FINDINGS.md §3 already measured, as active guards
 *   findings.mjs        spike diff output -> this repo's normalised finding format
 *   coverage-units.mjs  symbolic edge set + requirement register -> claimedUnits
 *
 * WHAT THIS ARM DOES NOT DO, STATED HERE SO IT IS NOT DISCOVERED IN THE SCORING:
 *   The shared extraction's schema carries exactly one typed routing structure —
 *   `route_answers[] = {code, label, destination}` on a `question:<id>`-scoped
 *   requirement. It has NO field for a condition operator, a cross-question condition,
 *   fall-through, question order, a full option list, option order, scale labels,
 *   randomisation, piping sources, carry-forward sources, or loops. So on a real
 *   questionnaire Arm B can assert `routing`, `terminate`, `question-presence-order` and
 *   `validation`, and structurally cannot assert most of the attribute classes.
 *   PRE-REGISTRATION.md §4.6 predicts exactly that split (`PREDICTED_OWNER`), which makes
 *   this a test of the prediction rather than a bug in the arm.
 *
 * `attribution` is always "graph"; the scorer invalidates the run otherwise (§3.3).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runArmB } from "../../graph-spike/arm/entry.mjs";
import { buildIdentity, treeHash, loadJson } from "../arms/identity.mjs";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVAL = join(HERE, "..");
const REPO = join(EVAL, "..");

/**
 * BUILD IDENTITY (schema 1.1.0 / arms/ARCHITECTURE.md §5).
 *
 * `run-arm.mjs` resolves identity from --identity, then the build record, then here. It
 * refuses to synthesise one, on the grounds that a placeholder identity is worse than
 * none. So this must be TRUE, not merely well-formed:
 *
 *  - `treeHash` is computed over the files this arm actually loads — `graph-spike/`
 *    (crawl, diff, compile-d, coverage, attributes, and everything under `arm/`) plus this
 *    adapter. That is the parity statement `sourceSha` cannot make on an untracked tree.
 *  - `bundleHash` says `local-node:no-bundle` because THERE IS NO BUNDLE. Arm B currently
 *    runs as local Node modules under `run-arm.mjs`; it has not been packaged for a
 *    Worker. Emitting a plausible-looking hash there would be exactly the fabrication §5
 *    exists to prevent. Deployment is a separate workstream; the arm is built so it CAN be
 *    deployed, and this field says truthfully that it has not been.
 *  - `gitDirty` is read, not assumed.
 */
function armIdentity() {
  const manifest = loadJson(join(EVAL, "arms", "manifests", "arm-b.json"));
  const catalogue = loadJson(join(REPO, "worker-v2", "src", "arms", "catalogue.json"));
  let sourceSha = "UNKNOWN";
  let gitDirty = true;
  try {
    sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
    gitDirty = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).trim().length > 0;
  } catch { /* not a git checkout; the fields say so rather than lying */ }

  const tree = treeHash([
    { dir: join(REPO, "graph-spike"), base: REPO },
    { dir: join(EVAL, "adapters"), base: REPO },
  ]);

  return buildIdentity({
    armId: "B",
    manifest,
    catalogue,
    sourceSha,
    gitDirty,
    tree: tree.hash,
    bundle: "local-node:no-bundle",
    builtAt: new Date().toISOString(),
  });
}

export default {
  arm: "B",

  version: () => process.env.SQA_ARM_B_SHA || "UNPINNED",

  identity: armIdentity,

  declaredAttribution: ["graph"],

  declaredScope: {
    filesystem: [
      "<survey>/questionnaire.docx",
      // Read-only, and only when SQA_ARM_B_INGEST=manifest — the corpus-privileged
      // ingester used for interface-parity smoke runs. It refuses to load otherwise and
      // stamps `admissibleInScoredRun: false` on anything it produces. Declared here
      // rather than left implicit: a declaration is not a sandbox, but it makes a
      // violation a stated lie instead of an accident (§8.5).
      "<survey>/manifest.json  [ONLY under SQA_ARM_B_INGEST=manifest; NOT admissible in a scored run]",
    ],
    network: [
      "127.0.0.1:<served port>",
      // Ingestion only. Suppressed when a model proxy is wired, in which case the calls
      // go through ctx.model and the harness counts them.
      "api.x.ai and api.deepseek.com  [ingestion pass A/B only; no judgement call is ever made]",
    ],
  },

  async run(ctx) {
    const r = await runArmB(ctx, {
      ingester: process.env.SQA_ARM_B_INGEST,
      maxJourneys: process.env.SQA_ARM_B_MAX_JOURNEYS ? Number(process.env.SQA_ARM_B_MAX_JOURNEYS) : undefined,
      replayPath: process.env.SQA_ARM_B_REPLAY || null,
      // The landing page inside `<survey>/site/`. Defaults to /index.html; corpora that
      // nest their pages set it rather than being special-cased in code.
      entryPath: process.env.SQA_ARM_B_ENTRY || undefined,
    });
    // `diagnostics` is deliberately NOT returned to the runner: the normalised result
    // schema is closed, and an extra top-level field is a schema error rather than a
    // shrug. It is logged instead, so it lands in the harness-owned telemetry events.
    ctx.log(`arm B diagnostics: ${JSON.stringify(r.diagnostics)}`);
    return { findings: r.findings, claimedUnits: r.claimedUnits, selfReportedCost: r.selfReportedCost };
  },
};
