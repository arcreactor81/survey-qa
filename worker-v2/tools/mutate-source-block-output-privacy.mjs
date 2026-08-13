/**
 * Privacy-boundary mutant: redaction may depend only on parser-established comment provenance.
 *
 *   node tools/mutate-source-block-output-privacy.mjs
 */
import { runMutantSuite } from "./mutate-runner.mjs";

await runMutantSuite({
  title: "operator source-block privacy mutants",
  filter: "operator source-block privacy boundary",
  mutants: [{
    name: "the structural comment-proposal guard is removed",
    breaks: "reviewer names and initials from any relationship-backed comment return to operator stdout",
    file: "tools/source-block-output.mjs",
    find: "  if (!isCommentProposalSourceBlock(block)) return block.origin;",
    replace: "  if (false) return block.origin;",
    kills: [
      "only the structural comment role redacts; a non-comment origin lookalike remains verbatim",
    ],
  }],
});
