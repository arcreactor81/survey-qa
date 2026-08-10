/**
 * ARM A — MODEL-ONLY.  Ablation role: the hybrid minus the graph.
 *
 * An LLM navigates the site, decides what to test, and reports findings. Coverage is
 * ATTESTED by the model, which is precisely the property under test: `coverage_honesty`
 * (PRE-REGISTRATION.md §4.5) compares what this arm CLAIMS it covered against the harness's
 * own visit log. This is the arm expected to be able to diverge.
 *
 * TO WIRE THIS UP
 *   The v2 pipeline has no local "run one survey" entrypoint today — the one real run on
 *   1 Aug was driven by a script that is not in the repo (docs/STATE-OF-PLAY.md §5). The
 *   dev routes (`POST /api/v2/dev/extract` / `dev/drive` / `dev/judge`, DEV_SEED-gated) are
 *   the closest thing, but their browser execution goes through the Cloudflare BROWSER
 *   binding, which cannot reach a 127.0.0.1 URL. So Arm A needs a local driver path before
 *   maturity gate M1 can pass. That is a build task, not a harness task.
 *
 *   When it exists: extract obligations from ctx.docxPath, plan, drive ctx.browser, and map
 *   each asserted defect onto the normalised format. Attribution is always "model".
 */

export default {
  arm: "A",
  version: () => process.env.SQA_ARM_A_SHA || "UNPINNED",
  declaredAttribution: ["model"],
  declaredScope: {
    filesystem: ["<survey>/questionnaire.docx"],
    network: ["127.0.0.1:<served port>", "<model gateway, via ctx.model only>"],
  },

  async run() {
    throw new Error(
      "Arm A adapter not implemented. See adapters/_template.mjs for the contract, and " +
        "PRE-REGISTRATION.md §9.3 for the maturity gates this arm must clear before a scored run.",
    );
  },
};
