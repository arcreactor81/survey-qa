/**
 * ADAPTER TEMPLATE — how a condition plugs into the evaluation harness.
 *
 * Copy this file, fill in `run(ctx)`, point `--adapter` at it. That is the whole contract.
 *
 * THE RULE THAT MAKES THE EXPERIMENT WORK: everything your arm does to the site goes
 * through `ctx.browser`, and every model call goes through `ctx.model`. Not because the
 * harness cannot be reached around — it can — but because the harness's visit log and
 * token counts are what `coverage_honesty` (PRE-REGISTRATION.md §4.5) is computed from.
 * An arm that drives its own browser is self-attesting its own coverage, which is the
 * exact failure this whole experiment exists to detect. Maturity gate M3 checks that your
 * telemetry reconciles; an arm whose visit log is empty while its findings are not has
 * reached around the interface and is not ready to be scored.
 *
 * WHAT YOU GET (`ctx`)
 *   ctx.surveyId    string
 *   ctx.arm         "A" | "B" | "C" | "C-R"
 *   ctx.seed        integer for C-R, null otherwise (§5.6 — pin it, record it)
 *   ctx.baseUrl     http://127.0.0.1:<port>  — the served site
 *   ctx.docxPath    absolute path to questionnaire.docx
 *                   THIS IS THE ONLY CORPUS FILE YOU GET. `truth/` is never passed and
 *                   `declaredScope.filesystem` is checked for it before you are invoked.
 *   ctx.browser     { available, goto(path), observe(), act(fn), close() }
 *                   `observe()` returns { qid, url, title, html } AND appends qid to the
 *                   harness visit log. You cannot add or suppress a visit.
 *   ctx.model       async (request) => response   — proxied, so tokens are counted here
 *   ctx.budget      { caps, check() }  — call check() in your own loops; the browser and
 *                   model wrappers already call it, and it throws BudgetExceeded
 *   ctx.log         (...args) => void — goes into telemetry.events
 *
 * WHAT YOU RETURN
 *   { findings: Finding[], claimedUnits: CoverageUnit[], selfReportedCost?: object }
 *
 *   Finding and CoverageUnit shapes: see `evaluation/finding-schema.mjs`. The runner
 *   validates before writing; schema errors exit non-zero rather than producing a file
 *   that looks scoreable.
 *
 * THREE THINGS THAT WILL COST YOU IF YOU GET THEM WRONG
 *
 *  1. ONE OBSERVABLE CONSEQUENCE PER FINDING. Splitting is YOUR job. A single finding
 *     covering two defects is credited to one of them, the other is a miss, and the cost
 *     shows up as UNDER_SPLIT in the adjudication queue (§5.5). No partial credit.
 *
 *  2. `attribution` IS REQUIRED FROM v1.0.0 AND IS NOT RETROFITTABLE (§3.3).
 *       "graph"  — derivable from structure alone (edge sets, node inventory, reachability)
 *       "model"  — required attribute judgement (wording, option semantics, labels)
 *       "graph-located-model-judged" — THE SEAM: the graph put the model at the node, the
 *                 model made the call. If this bucket is empty for arm C, the hybrid is not
 *                 hybridising and the seam table will say so.
 *     Arm A may only emit "model"; arm B may only emit "graph". Violating that invalidates
 *     the RUN, not the finding — a condition that misreports its own mechanism cannot be
 *     trusted about the seam.
 *
 *  3. IF THE DOCUMENT DOES NOT RESOLVE A CASE, SAY SO — do not guess.
 *     Emit `claimClass: "ambiguity"` with >= 2 named readings. §4.4: a determinate verdict
 *     at a planted-ambiguity locus is a FAILURE EVEN IF THE GUESS IS RIGHT. Hedging is not
 *     free either: an ambiguity assertion at a locus that carries a real defect counts as a
 *     miss for that defect (AMBIGUITY_SHIELD), and high observation volume is flagged
 *     HEDGING.
 */

export default {
  arm: "TEMPLATE",

  /** Pinned before any corpus survey runs (maturity gate M4). A commit SHA, not a label. */
  version: () => "UNPINNED",

  /** Must match what the arm can actually produce; the scorer enforces impossibility. */
  declaredAttribution: ["model"],

  /**
   * Declared, and checked by the runner before invocation. `truth/` in here is a hard stop.
   * A declaration is not a sandbox — it makes a violation a stated lie rather than an
   * accident, which in a single-owner project is the strongest control available (§8.5).
   */
  declaredScope: {
    filesystem: ["<survey>/questionnaire.docx"],
    network: ["127.0.0.1:<served port>"],
  },

  async run(ctx) {
    ctx.log("template adapter: nothing to do");
    return { findings: [], claimedUnits: [] };
  },
};
