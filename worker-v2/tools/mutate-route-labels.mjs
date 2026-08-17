/**
 * EVIDENCE THAT THE PER-ANSWER ROUTING LABEL GUARDS CAN FAIL.
 *
 * Each mutant re-opens one way the per-answer routing label or the anchor-artifact
 * cleaning could quietly break, and the named guard test must go red for it.
 *
 *   node tools/mutate-route-labels.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PLAN = "src/workflow/stages/plan.ts";
const PROMPTS = "src/extract/prompts.ts";
const CLEANER = "src/extract/anchor-cleaner.ts";

await runMutantSuite({
  title: "Per-answer route labels and anchor cleaning — can the guards fail?",
  filter: "route-label",
  mutants: [
    {
      name: "sealedRouteDestinations stops reading terminate facets",
      breaks:
        "the typed route source's terminate channel. A terminate facet instance with a " +
        "verbatim label would no longer become an avoid_labels entry, so the walker would " +
        "click documented screen-out answers",
      file: PLAN,
      find: '    if (facet === "terminate") out.push({ question, label, kind: "terminate" });',
      replace: '    if (false && facet === "terminate") out.push({ question, label, kind: "terminate" });',
      kills: [
        "extracts terminate destinations with verbatim labels",
        "terminate routes become avoid entries",
      ],
    },
    {
      name: "sealedRouteDestinations stops reading skip-rule facets",
      breaks:
        "the typed route source's continue channel. A skip-rule facet instance with a " +
        "verbatim label would no longer become a prefer_labels entry, so the walker would " +
        "get no positive steering",
      file: PLAN,
      find: '    else if (facet === "skip-rule") out.push({ question, label, kind: "continue" });',
      replace: '    else if (false && facet === "skip-rule") out.push({ question, label, kind: "continue" });',
      kills: [
        "extracts continue destinations with verbatim labels",
        "continue routes become prefer entries",
      ],
    },
    {
      name: "the anchor cleaner stops matching the rendering vocabulary",
      breaks:
        "the anchor cleaning path. Rendering artifacts like [ANCHOR BELOW] would pass " +
        "through into route labels, polluting the option text the walker tries to match",
      file: CLEANER,
      find: "    if (words.every((w) => RENDERING_ARTIFACT_VOCAB.has(w))) {",
      replace: "    if (false) {",
      kills: [
        "strips a single [ANCHOR BELOW] marker and counts it",
        "strips multiple rendering artifacts and counts each",
        "cleaning a polluted label produces the original option text",
      ],
    },
    {
      name: "the anchor cleaner stops counting removals",
      breaks:
        "the loud-counting contract. Removed artifacts would not be counted, violating " +
        "the house rule that every removal is visible",
      file: CLEANER,
      find: "      removed.push(match);",
      replace: "      // (counting dropped by mutant)",
      kills: [
        "strips a single [ANCHOR BELOW] marker and counts it",
        "strips multiple rendering artifacts and counts each",
      ],
    },
    {
      name: "pass B prompt version is not bumped (stale artifacts reused)",
      breaks:
        "the version gate. A pass-B artifact persisted under the old version would be " +
        "reused even though the prompt now asks for per-answer routing decomposition",
      file: PROMPTS,
      find: 'export const PROMPT_VERSION_B = "v2-extract-pass-b/1.7.0";',
      replace: 'export const PROMPT_VERSION_B = "v2-extract-pass-b/1.6.0";',
      kills: ["pass B prompt version is 1.7.0"],
    },
  ],
});
