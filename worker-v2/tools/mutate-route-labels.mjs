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
      name: "sealedRouteDestinations stops reading bound terminals",
      breaks:
        "the destination-first terminate channel: a route whose OWN binding says terminal " +
        "would no longer become an avoid_labels entry, so the walker would click documented " +
        "screen-out answers whenever the requirement facet happens not to say terminate",
      file: PLAN,
      // Re-anchored after D1 added `code` to the route-destination rows.
      find: '    if (dest?.terminal) out.push({ question, label, code, kind: "terminate" });',
      replace: '    if (false) out.push({ question, label, code, kind: "terminate" });',
      kills: ["a route with its OWN bound terminal is a terminate whatever its requirement facet says"],
    },
    {
      name: "sealedRouteDestinations stops reading bound continue destinations",
      breaks:
        "the typed route source's continue channel. A route bound to a named question would " +
        "no longer become a prefer_labels entry, so the walker would get no positive steering",
      file: PLAN,
      // Re-anchored after D1 added `code` to the route-destination rows.
      find: '    else if (nonEmpty(dest?.questionId ?? null)) out.push({ question, label, code, kind: "continue" });',
      replace: '    else if (false) out.push({ question, label, code, kind: "continue" });',
      kills: [
        "extracts continue destinations with verbatim labels",
        "continue routes become prefer entries",
      ],
    },
    {
      name: "the facet-terminate fallback is dropped (label-only terminates stop avoiding)",
      breaks:
        "the conservative arm for terminate facets whose rows carry no binding — the old " +
        "contract shape. Their labels stop joining avoid_labels and the walker clicks them",
      file: PLAN,
      find: '    else if (facetByLineage.get(fi.requirementLineageId) === "terminate") {',
      replace: '    else if (false) {',
      kills: [
        "extracts terminate destinations with verbatim labels",
        "terminate routes become avoid entries",
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
      name: "the TERMINATE keyword family is forgotten again (bracketed terminates go unbound)",
      breaks:
        "the v2r_01m0cjew… class at its root: '[TERMINATE IMMEDIATELY]' reads as no terminal " +
        "state, every such route lands ROUTE_DESTINATION_NOT_BOUND, and the planner is one " +
        "typing slip away from preferring documented terminations",
      file: "src/extract/expand.ts",
      find: '  if (/terminat|disqualif|not\\s+eligible|unable\\s+to\\s+accept/i.test(dest)) return "screenout";',
      replace: "  // (terminate family dropped by mutant)",
      kills: ["bracketed and adorned terminate phrases bind as the screenout terminal"],
    },
    {
      name: "unbound routes steer positively again (unparsed reads as documented continue)",
      breaks:
        "the honesty rule that walked run v2r_01m0cjew… into a documented termination: a row " +
        "whose destination the binder could not read must never become a prefer label",
      file: PLAN,
      // Re-anchored after D1 added `code` to the route-destination rows.
      find: '    else if (nonEmpty(dest?.questionId ?? null)) out.push({ question, label, code, kind: "continue" });',
      replace: '    else if (true) out.push({ question, label, code, kind: "continue" });',
      kills: ["typed mining: facet terminate => terminate, skip-rule => continue, anything else skipped"],
    },
    {
      name: "the option-fact join is dropped (section-scoped routing tables lose their owner)",
      breaks:
        "the run v2r_01m0cy89mz80nf4g3z32j7f8sx class: a routing table scoped to a SECTION " +
        "carries no targetQuestionId, so every typed route row is dropped and the walker " +
        "picks among documented terminations by lottery",
      file: PLAN,
      find: "      if (owners && owners.size === 1) question = [...owners][0]!;",
      replace: "      if (false) question = [...owners!][0]!;",
      kills: ["THE MEASURED ORPHANED TABLE: a section-scoped route row joins its question through the sealed option facts"],
    },
    {
      name: "an ambiguous label owner is guessed instead of refused",
      breaks:
        "the refusal arm of the join: a label two questions both assert would be stamped " +
        "onto whichever owner iteration order happens to yield, steering answers on the " +
        "wrong question",
      file: PLAN,
      find: "      if (owners && owners.size === 1) question = [...owners][0]!;",
      replace: "      if (owners && owners.size >= 1) question = [...owners][0]!;",
      kills: ["counterproof: a label two questions both assert is REFUSED an owner, never guessed"],
    },
    {
      name: "the section-title join is dropped (later table chunks lose their owner again)",
      breaks:
        "the run v2r_01m0d1qf7baq2g9evn8mkje28n class: an option-set chunk that is itself " +
        "section-scoped leaves its rows without a label join, and only the section title's " +
        "validated leading id can own them",
      file: PLAN,
      find: "    if (!question) question = sectionScopeOwner(fi.requirementLineageId);",
      replace: "    if (false) question = sectionScopeOwner(fi.requirementLineageId);",
      kills: ["THE SECOND ORPHANING: a section title leading with a KNOWN question id owns its rows"],
    },
    {
      name: "the section token skips its bound-instance validation",
      breaks:
        "the guard that keeps the convention honest: any section title starting with an " +
        "id-shaped token would mint an owner, including questions nothing ever bound",
      file: PLAN,
      find: "    return token && boundQuestions.has(token) ? token : null;",
      replace: "    return token ? token : null;",
      kills: ["counterproof: a section token NO bound instance targets is refused, and prose titles never match"],
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
