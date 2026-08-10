/**
 * ARM C — HYBRID.  The destination (owner ruling, 2 Aug 2026).
 *
 * The graph supplies the coverage floor and the traversal plan; the model judges node
 * ATTRIBUTES a graph cannot express — question wording, option lists and their order,
 * scale labels, randomisation, validation.
 *
 * THE SEAM IS THE MEASUREMENT (§4.6). Every finding carries `attribution`:
 *   "graph"                       structure alone was sufficient
 *   "model"                       attribute judgement alone was sufficient
 *   "graph-located-model-judged"  the graph put the model at the node, the model called it
 *
 * That third value is the hybrid's whole reason to exist. Maturity gate M8 requires it to be
 * non-empty on the smoke surveys: a "hybrid" whose seam never fires is arm A or arm B
 * wearing a label, and scoring it as a hybrid would be the experiment measuring nothing.
 *
 * TO WIRE THIS UP
 *   1. Compile ctx.docxPath into the expected graph. SHARE THIS STEP WITH ARM B — §8.1's
 *      shared-ingestion control: if the arms use different document parsers, this
 *      experiment measures PARSERS and reports the result as ARCHITECTURE. The corpus
 *      deliberately plants requirements in footnotes, headers, comments and numbering.xml,
 *      so the difference would be large and entirely spurious.
 *   2. Derive the traversal plan. RECORD IT — Arm C-R needs its size to build an
 *      equal-size random control, and the unit is DISTINCT NODE-VISITS, not paths (§5.6).
 *   3. Walk it through ctx.browser.
 *   4. At each node, hand the model the observed attributes and the documented expectation;
 *      emit ONE finding per observable consequence (§5.5 — splitting is the adapter's job).
 */

export default {
  arm: "C",
  version: () => process.env.SQA_ARM_C_SHA || "UNPINNED",
  declaredAttribution: ["graph", "model", "graph-located-model-judged"],
  declaredScope: {
    filesystem: ["<survey>/questionnaire.docx"],
    network: ["127.0.0.1:<served port>", "<model gateway, via ctx.model only>"],
  },

  async run() {
    throw new Error(
      "Arm C adapter not implemented. It depends on Arm B's graph compiler; see " +
        "PRE-REGISTRATION.md §9.2 — an underbuilt graph half understates the hybrid.",
    );
  },
};
