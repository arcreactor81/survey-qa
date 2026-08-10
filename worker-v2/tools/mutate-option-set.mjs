/**
 * D45 MUTANTS — CAN THE OPTION-SET GUARDS ACTUALLY FAIL?
 *
 * This is the first NEW verdict-minting path in months, and its tests were written by the same
 * hand that wrote the predicate. `worker-v2` has repeatedly shipped checks structurally
 * incapable of failing (a boundary test that typed `<exactly 500 characters>` — 24 of them —
 * and reported PASS; a leak check over an empty denominator), so "24/24 passed" is not
 * evidence of anything until each guard has been broken and seen to redden its own test.
 *
 * ==================== THE TWO DIRECTIONS, AND THEY ARE NOT SYMMETRIC ====================
 *
 * FALSE-NEGATIVE mutants break the predicate's ability to CLAIM: the seeded `missing-option`
 * defect stops being reported. One test notices, loudly.
 *
 * FALSE-POSITIVE mutants break a guard that stops it accusing a HEALTHY survey — the
 * near-variant withhold, the read attestation, the group attribution, the scope-survey refusal
 * in the mint. These are the dangerous half: a predicate carrying any one of these breaks
 * passes every positive test in D45 and publishes a defect report about a working site. So
 * most of the mutants below are of that kind, and each names the test that must catch it.
 *
 * Every mutation is applied inside esbuild's load step (`testkit.mjs#mutantPlugin`) and NOTHING
 * is written under `src/**` — which is what makes it safe to mutate files while other agents
 * are editing the tree.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const VERIFY = "src/workflow/stages/verify-observations.ts";
const EXPAND = "src/extract/expand.ts";

const MUTANTS = [
  // =================================================================== the mint
  {
    name: "an option list scoped to the SURVEY is bound to a question anyway",
    breaks: "a fifth of real option rows name no question, and three different questions' option-1 rows all claim code 1",
    file: EXPAND,
    find: "  const questionId = questionOf(r);\n  if (!questionId) {",
    replace: "  const questionId = questionOf(r) ?? [...vocabulary.values()][0] ?? null;\n  if (!questionId) {",
    kills: ["REFUSED: a `scope: survey` option list is never bound to a question by proximity"],
  },
  {
    name: "the label is taken from the model's SENTENCE instead of the document's quote",
    breaks: "a paraphrased label compared against a screen is a fabricated defect with a document quote in front of it",
    file: EXPAND,
    find: "  const parsed = parseDocumentedOptions(r.displayQuote ?? \"\");",
    replace: "  const parsed = parseDocumentedOptions(r.normativeStatement ?? \"\");",
    kills: ["THE LABEL BYTES ARE THE DOCUMENT'S: three real extraction shapes all mint"],
  },
  {
    name: "the statement no longer has to corroborate the quote's label",
    breaks: "when the two readings of one row disagree, neither is a fact",
    file: EXPAND,
    find: "  const asserted = parsed.filter((o) => statementCorroborates(r.normativeStatement, o.label));",
    replace: "  const asserted = parsed.filter(() => true);",
    kills: ["REFUSED: a label the requirement's own STATEMENT does not carry is a disagreement, not a fact"],
  },
  {
    name: "a multi-sentence programmer note becomes a sealed answer-option label",
    breaks: "prose sealed as a label is hunted for on a screen, never found, and published as a missing option",
    file: EXPAND,
    find: "    if (/[.!?]\\s+\\S/.test(line) || /:$/.test(line)) continue;",
    replace: "    if (false) continue;",
    kills: [
      "REFUSED: PROSE the statement DOES quote must not become a sealed option label",
      "REFUSED: an ORDER rule and a SCALE header carry no option lines, and none is imagined",
    ],
  },
  {
    name: "a stated count the quote does not bear out still closes the set",
    breaks: "a closed set licenses an EXTRA-OPTION accusation, and a fragment of a list is not a closed set",
    file: EXPAND,
    find: "      exhaustive: asserted.length === parsed.length && statesAClosedSet(r.normativeStatement, parsed.length),",
    replace: "      exhaustive: true,",
    kills: ["THE CLOSED SET: `exactly N … and no others` needs the QUOTE to bear the count out"],
  },
  {
    name: "another question's options become this question's corroboration",
    breaks: "the sibling set licenses a code comparison, and a foreign question's codes license nothing",
    file: EXPAND,
    find: "      if (from === exclude.requirementVersionId) continue;",
    replace: "      if (false) continue;",
    kills: ["SIBLINGS are the other rows' options for the SAME question, and carry no claim"],
  },

  // ============================================================== the predicate
  {
    name: "a missing option stops being claimed at all",
    breaks: "the seeded missing-option defect is the thing this predicate exists to find",
    file: VERIFY,
    find: '        reason: VERIFIER_REASON.OPTION_MISSING,',
    replace: '        reason: VERIFIER_REASON.OPTION_SET_AS_DOCUMENTED,',
    kills: ["THE SEEDED DEFECT: s1-skip's flawed Q3 drops BIMZELX, and the run says so"],
  },
  {
    name: "a missing option is scored as a PASS",
    breaks: "a false pass CERTIFIES that there is no defect, which is the one thing this product sells",
    file: VERIFY,
    find: '        outcome: "violated",\n        reason: VERIFIER_REASON.OPTION_MISSING,',
    replace: '        outcome: "satisfied",\n        reason: VERIFIER_REASON.OPTION_MISSING,',
    kills: ["THE SEEDED DEFECT: s1-skip's flawed Q3 drops BIMZELX, and the run says so"],
  },
  {
    name: "THE FALSE-ACCUSATION MUTANT: a near-variant label is treated as a missing option",
    breaks: "a document and a site may word one option two ways; accusing that is the cardinal failure",
    file: VERIFY,
    find: "      const near = offered.filter((o) => nearVariantLabel(o.label, want.label));",
    replace: "      const near = offered.filter(() => false);",
    kills: [
      "NEVER ACCUSED: a site that WORDS an option differently is not accused of missing it",
      "NEVER ACCUSED: a site whose extra wording ADDS words ('Other (please specify)') is not accused",
    ],
  },
  {
    name: "a near match is allowed to MINT a label-mismatch accusation on its own",
    breaks: "similarity may withhold or gate an arm that already has an independent witness; it may never accuse alone",
    file: VERIFY,
    find: "        codeVocabularyLicensed(sealed.siblings, offered)",
    replace: "        true",
    kills: ["LABEL MISMATCH is claimable — but only once the site's CODES are shown to mean the same thing"],
  },
  {
    name: "an accusation no longer needs the capture to attest its own read",
    breaks: "absence is never 'none' — a degraded or silent read cannot support a claim about what is not there",
    file: VERIFY,
    find: "    const accusable = Array.isArray(limitations) && limitations.length === 0;",
    replace: "    const accusable = true;",
    kills: ["NEVER ACCUSED: a capture that did not attest its own read cannot support an absence claim"],
  },
  {
    name: "the first option group on a multi-question screen is assumed to be the target's",
    breaks: "comparing a document's options against another question's inventory accuses a healthy survey",
    file: VERIFY,
    find: "  if (groups.length === 1) return { group: groups[0]! };",
    replace: "  if (groups.length >= 1) return { group: groups[0]! };",
    kills: ["NEVER ACCUSED: a grid is not compared, and a screen hosting two groups is not guessed at"],
  },
  {
    name: "a grid's cells are compared against the document's option list",
    breaks: "the grid read is the one with a known silent column-shift defect behind it",
    file: VERIFY,
    find: "    if (screen.grid) {",
    replace: "    if (false) {",
    kills: ["NEVER ACCUSED: a grid is not compared, and a screen hosting two groups is not guessed at"],
  },
  {
    name: "an option present in the markup but hidden counts as offered",
    breaks: "'in the DOM' and 'offered to the respondent' are different claims",
    file: VERIFY,
    find: "        if (exact.some((o) => o.visible !== false && o.operable !== false)) continue;",
    replace: "        if (exact.length > 0) continue;",
    kills: ["A HIDDEN option is neither offered nor missing, and is not reported as either"],
  },
  {
    name: "an EXTRA option is claimed even when the document never closed the set",
    breaks: "a membership row never said the question offers nothing else",
    file: VERIFY,
    find: "    if (sealed.exhaustive) {",
    replace: "    if (true) {",
    kills: ["AN EXTRA OPTION is claimable ONLY when the document closes the set"],
  },
  {
    name: "an exhaustive PASS stops being an absence claim",
    breaks: "'…and nothing else' over a partial walk is not a fact",
    file: VERIFY,
    find: "      fromAbsence: sealed.exhaustive,",
    replace: "      fromAbsence: false,",
    kills: ["AN EXHAUSTIVE PASS is an absence claim, so a PARTIAL walk cannot support it"],
  },
  {
    name: "a screen that captured NO options is bound anyway, collapsing two distinct refusals",
    breaks: "'nothing was captured' and 'an inventory could not be attributed' call for different repairs",
    file: VERIFY,
    find: "      performed: (s) => (s.screenBefore?.optionGroups ?? []).some((g) => (g?.options?.length ?? 0) > 0),",
    replace: "      performed: () => true,",
    // NOTE: this stimulus is NOT what binds the case to its question — `stepsOnTargetQuestion`
    // (screen identity) is, and it runs first. An earlier version of this mutant named the
    // wrong-screen test as its guard and SURVIVED, because with identity still enforcing the
    // target the outcome did not move. What the stimulus actually decides is WHICH refusal is
    // reported when the target screen carries no options, which is what is guarded now.
    kills: ["A SCREEN WITH NO OPTIONS AT ALL is a different refusal from one whose groups cannot be attributed"],
  },
  {
    name: "a case whose payload was refused at expansion is decided anyway",
    breaks: "a refused mint carries no expectation, and an empty one must never reach a screen",
    file: VERIFY,
    find: "    if (!sealed || !Array.isArray(sealed.asserted) || sealed.asserted.length === 0) {",
    replace: "    if (false) {",
    kills: ["NEVER ACCUSED: a case whose payload was refused at expansion reaches no verdict"],
  },

  // ================================================================ the registry
  {
    name: "the registry opens for a SECOND kind at the same time",
    breaks: "opening the registry is a deliberate act, and this change was authorised for exactly one kind",
    file: VERIFY,
    find: '  "option-set": optionSetOffered,\n};',
    replace: '  "option-set": optionSetOffered,\n  copy: optionSetOffered,\n};',
    kills: [
      "THE REGISTRY: exactly route, boundary and option-set — nothing else acquired a predicate",
      "NO DRIFT: the expander's typed-kind set and the verifier's registry are set-EQUAL",
    ],
  },
  {
    name: "the expander's typed-kind set drifts from the registry",
    breaks: "a case counted as decidable that no predicate can reach is a ceiling nobody can trust",
    file: EXPAND,
    find: 'const KINDS_WITH_A_PREDICATE = new Set<FacetCase["kind"]>(["route", "boundary", "option-set"]);',
    replace: 'const KINDS_WITH_A_PREDICATE = new Set<FacetCase["kind"]>(["route", "boundary", "option-set", "copy"]);',
    kills: [
      "NO DRIFT: the expander's typed-kind set and the verifier's registry are set-EQUAL",
      "A KIND WITH NO PREDICATE IS STILL NEVER TYPED",
    ],
  },
];

await runMutantSuite({
  title: "D45 option-set mutants — can the option guards fail, in BOTH directions?",
  // No filter: several mutants reach beyond D45 (the registry ones move `d16`'s ceiling too),
  // and a baseline over a subset of the suite is not a baseline for them.
  filter: "",
  mutants: MUTANTS,
});
