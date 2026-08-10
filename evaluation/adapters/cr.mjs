/**
 * ARM C-R — HYBRID WITH RANDOMISED TRAVERSAL.  The control that could embarrass us.
 *
 * Requested by the owner as a first-class condition. Identical to Arm C in EVERY respect —
 * same graph extraction, same model, same prompts, same attribute-judging step, same budget
 * — except the principled traversal plan is replaced by a RANDOM SUBSET OF VALID
 * TRAVERSALS OF EQUAL SIZE.
 *
 * It isolates one question: is the benefit of the graph that coverage is PRINCIPLED, or
 * merely that the arm browses MORE?
 *
 * PRE-REGISTRATION.md §1.2, written before any result existed:
 *
 *   "If C does not beat C-R by more than the margin in §6.4, the graph's central claim —
 *    that principled, computed traversal is better than covering the same amount of ground
 *    arbitrarily — is DECORATIVE. We will write that sentence in the report."
 *
 * CONSTRUCTION RULES (§5.6), all load-bearing:
 *   - Size unit is DISTINCT NODE-VISITS, not path count. Paths vary in length; matching on
 *     path count would hand C-R more or fewer screens than C, and the control would be
 *     measuring budget rather than principle.
 *   - Draw uniformly from VALID, EXECUTABLE traversals. A random invalid path would just
 *     measure error handling.
 *   - Match C's node-visit count within +/- 10%. Outside that band the survey is excluded
 *     from the C-vs-C-R comparison only, and listed by ID.
 *   - The seed is pinned per (surveyId, repeat) and recorded in telemetry.
 *   - R = 3 SEEDS PER SURVEY. Random traversal is high-variance; comparing a deterministic
 *     condition against a single random draw would be indefensible. C-R is scored as the
 *     MEAN over seeds with the min-max range always printed, and a C-vs-C-R conclusion is
 *     not reported if C's score falls inside C-R's observed range.
 *
 * Everything downstream of path selection must be identical to Arm C. Import Arm C's
 * judging step rather than reimplementing it — a divergence there silently turns the
 * traversal control into an implementation comparison, which answers a different question
 * than the one being asked.
 */

export default {
  arm: "C-R",
  version: () => process.env.SQA_ARM_C_SHA || "UNPINNED", // same build as C, by construction
  declaredAttribution: ["graph", "model", "graph-located-model-judged"],
  declaredScope: {
    filesystem: ["<survey>/questionnaire.docx"],
    network: ["127.0.0.1:<served port>", "<model gateway, via ctx.model only>"],
  },

  async run(ctx) {
    if (!Number.isInteger(ctx.seed)) {
      throw new Error("C-R requires a pinned --seed; an unseeded random control is not reproducible (§5.6)");
    }
    throw new Error(
      "Arm C-R adapter not implemented. It must share Arm C's build and differ ONLY in path " +
        "selection; see PRE-REGISTRATION.md §5.6.",
    );
  },
};
