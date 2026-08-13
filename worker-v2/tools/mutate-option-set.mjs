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
    // Re-anchored for 1.5.0+: the mint destructures the accounted parse of the same quote.
    find: "  const { options: parsed, unparsedLines } = parseDocumentedOptionsAccounted(r.displayQuote ?? \"\");",
    replace: "  const { options: parsed, unparsedLines } = parseDocumentedOptionsAccounted(r.normativeStatement ?? \"\");",
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
    // Re-anchored for 1.5.0+: the prose guard records the drop instead of silently continuing.
    find:
      "    if (MULTI_SENTENCE_LINE.test(line) || line.normalize(\"NFKC\").endsWith(\":\")) {\n" +
      "      unparsedLines.push(line);\n" +
      "      continue;\n" +
      "    }",
    replace: "    if (false) {\n      unparsedLines.push(line);\n      continue;\n    }",
    kills: [
      "REFUSED: PROSE the statement DOES quote must not become a sealed option label",
      "REFUSED: an ORDER rule and a SCALE header carry no option lines, and none is imagined",
      "FIX A1/NORTH STAR: Unicode sentence boundaries are prose, not answer labels",
      "FIX A1/NORTH STAR: a compatibility-equivalent non-ASCII colon remains an unread header shape",
    ],
  },
  {
    name: "the prose guard regresses to ASCII sentence terminators",
    breaks:
      "Japanese, Arabic and other scripts use sentence terminals outside `.?!`; treating their instructions " +
      "as labels creates a missing-option accusation from prose",
    file: EXPAND,
    find: "const MULTI_SENTENCE_LINE = /\\p{Sentence_Terminal}(?:\\s+\\S|(?=\\p{L}))/u;",
    replace: "const MULTI_SENTENCE_LINE = /[.!?]\\s+\\S/;",
    kills: ["FIX A1/NORTH STAR: Unicode sentence boundaries are prose, not answer labels"],
  },
  {
    name: "the header guard recognizes only the ASCII colon",
    breaks:
      "compatibility-equivalent punctuation must not decide whether a line silently becomes an answer option",
    file: EXPAND,
    find: 'line.normalize("NFKC").endsWith(":")',
    replace: '/:$/.test(line)',
    kills: ["FIX A1/NORTH STAR: a compatibility-equivalent non-ASCII colon remains an unread header shape"],
  },
  {
    name: "a bracket-shaped document line is silently declared to be an instruction",
    breaks:
      "syntax alone cannot distinguish an authoring marker like [ROTATE] from a respondent-visible " +
      "label like [None]; dropping it can close a short set and accuse a compliant survey of an extra option",
    file: EXPAND,
    find:
      "    if (/^\\[.*\\]$/u.test(sourceText)) {\n" +
      "      unparsedLines.push(sourceText);\n" +
      "      continue;\n" +
      "    }",
    replace: "    if (/^\\[.*\\]$/u.test(sourceText)) continue;",
    kills: ["FIX A1/NORTH STAR: a pure bracketed line is ambiguous without source-role evidence and blocks closure"],
  },
  {
    name: "an arbitrary trailing bracket suffix is silently stripped as a programmer marker",
    breaks:
      "the display quote carries no per-suffix role; removing `[EXCLUSIVE]` or `[NONE]` by shape alone can " +
      "shorten and close the document's option set",
    file: EXPAND,
    find:
      "    if (TRAILING_MARKER.test(sourceText)) {\n" +
      "      unparsedLines.push(sourceText);\n" +
      "      continue;\n" +
      "    }\n" +
      "    const line = sourceText;",
    replace: "    const line = sourceText.replace(TRAILING_MARKER, \"\").trim();",
    kills: ["FIX A1/NORTH STAR: a trailing bracket suffix is not stripped without source-role evidence"],
  },
  {
    name: "a semicolon is guessed to be an option delimiter without source-boundary provenance",
    breaks:
      "a semicolon can live inside one visible label; splitting it can certify a site that incorrectly renders " +
      "the two halves as separate answer choices",
    file: EXPAND,
    find: "    .split(/\\n+/)",
    replace: "    .split(/[\\n;]+/)",
    kills: ["FIX A1/NORTH STAR: a semicolon with no delimiter provenance is counted, never split into options"],
  },
  {
    name: "distinct duplicate-label occurrences silently collapse by normalized label",
    breaks:
      "two source occurrences with different codes may be two answer choices; a payload with no multiplicity " +
      "semantics cannot discard one and still call the case fully typed",
    file: EXPAND,
    find:
      "    const previous = seen.get(key);\n" +
      "    if (previous) {\n" +
      "      // An exact repeated semantic occurrence is idempotent stitching. A different code or\n" +
      "      // source line under the same normalized label may be two distinct answer choices; this\n" +
      "      // payload has no multiplicity semantics, so collapsing them would silently shorten it.\n" +
      "      if (previous.code !== code || previous.line !== line) unparsedLines.push(line);\n" +
      "      continue;\n" +
      "    }\n" +
      "    seen.set(key, { code, line });",
    replace: "    if (seen.has(key)) continue;\n    seen.set(key, { code, line });",
    kills: ["FIX A1/NORTH STAR: distinct duplicate-label occurrences never collapse into one typed option"],
  },
  {
    name: "Unicode option labels regress to an ASCII-only letter test",
    breaks:
      "a questionnaire written in Japanese, Arabic, Hindi or another non-Latin script is ordinary input, " +
      "not punctuation and not an unread document",
    file: EXPAND,
    find: "    if (!/[\\p{L}\\p{N}]/u.test(label)) {",
    replace: "    if (!/[a-z0-9]/i.test(label)) {",
    kills: ["FIX A1/NORTH STAR: Unicode letters are ordinary option labels, not ASCII-shaped punctuation"],
  },
  {
    name: "a symbol-only option candidate is silently discarded",
    breaks:
      "stars, checkmarks and emoji can be respondent-visible scale labels; without source-role evidence their " +
      "loss must block closure rather than shorten the document inventory",
    file: EXPAND,
    find:
      "    if (!/[\\p{L}\\p{N}]/u.test(label)) {\n" +
      "      unparsedLines.push(line);\n" +
      "      continue;\n" +
      "    }",
    replace: "    if (!/[\\p{L}\\p{N}]/u.test(label)) continue;",
    kills: ["FIX A1/NORTH STAR: a symbol-only candidate is counted unread rather than silently shortening a set"],
  },
  {
    name: "a stated count the quote does not bear out still closes the set",
    breaks: "a closed set licenses an EXTRA-OPTION accusation, and a fragment of a list is not a closed set",
    file: EXPAND,
    // 1.8.0 refuses unread lines before this expression; this still proves that an ordinary
    // fragment whose stated count is unsupported cannot close.
    find: "  if (parsed < 2 || asserted !== parsed || !countAgrees) {",
    replace: "  if (false) {",
    kills: ["THE CLOSED SET: `exactly N … and no others` needs the QUOTE to bear the count out"],
  },
  {
    // 1.9.0 (owner-approved softening, 11 Aug): the pre-1.9.0 expression, reinstated verbatim.
    name: "the 1.9.0 word-shape rule reverts: any capture is read as a count clause",
    breaks:
      "'exactly the following ANSWER options and no others' captures a word where a number is expected; " +
      "reading the failed NUMBER_WORD lookup as a count disagreement refuses closure on the domain's most " +
      "canonical closure phrasings and kills the extra-option arm on those questions",
    file: EXPAND,
    find: "  const countAgrees = n === null || n === parsed;",
    replace: "  const countAgrees = n === null ? stated === null : n === parsed;",
    kills: [
      "SOFTENED 1.9.0: 'exactly the following answer options and no others' closes a fully-parsed corroborated set",
      "SOFTENED 1.9.0: 'only the following answer options' closes a fully-parsed corroborated set",
    ],
  },
  {
    name: "the numeric-mismatch refusal is deleted: a stated count that disagrees still closes",
    breaks:
      "a set the document counts at five and the quote bears out at four is not closed; closing it licenses " +
      "an extra-option accusation against a site rendering the option the document lists",
    file: EXPAND,
    find: "  const countAgrees = n === null || n === parsed;",
    replace: "  const countAgrees = true;",
    kills: ["UNCHANGED 1.9.0: a stated count that DISAGREES with the parsed options still refuses closure"],
  },
  {
    name: "closure coverage is falsely attested as established when the compiler did not evaluate it",
    breaks:
      "membership and closure are separate claims; exhaustive=false must say whether the document left the set " +
      "open or the compiler lacked a language-neutral closure proof",
    file: EXPAND,
    find:
      '        status: "not-evaluated",\n' +
      "        code: OPTION_SET_CLOSURE_ASSESSMENT.NOT_EVALUATED,",
    replace:
      '        status: "established",\n' +
      "        code: OPTION_SET_CLOSURE_ASSESSMENT.ESTABLISHED,",
    kills: ["FIX A1/NORTH STAR: unproven closure has explicit computed coverage while membership stays typed"],
  },
  {
    name: "the full-line refusal is deleted: readable fragments become executable membership",
    breaks:
      "a quote line killed by the prose/header/length filters vanishes silently and the remaining label can " +
      "mint OPTION_MISSING even though coverage no longer records the partial read",
    file: EXPAND,
    find: "  if (unparsedLines.length > 0) {",
    replace: "  if (false) {",
    kills: [
      "FIX A1 (review-extract finding 1): a numeral-free closure over a DROPPED quote line must not close the set",
      "FIX A1: 'Other (please specify):' killed by the header guard cannot seal a closed set",
      "FIX A1 seam: a partial quote is untyped end-to-end and cannot accuse from its readable fragment",
    ],
  },
  {
    name: "a case carries both a taxonomy gap and an executable option payload",
    breaks:
      "coverage calls the case untyped while the verifier ignores expectationGap and can mint OPTION_MISSING " +
      "from the payload beside it",
    file: EXPAND,
    find:
      "    return {\n      optionSet: null,\n      expectationGap: gap(\n" +
      "        EXPECTATION_GAP.OPTION_SET_QUOTE_LINE_UNPARSED,",
    replace:
      "    return {\n      optionSet: { asserted, siblings: siblingsFor(questionId, r), exhaustive: false },\n" +
      "      expectationGap: gap(\n        EXPECTATION_GAP.OPTION_SET_QUOTE_LINE_UNPARSED,",
    kills: ["FIX A1 seam: a partial quote is untyped end-to-end and cannot accuse from its readable fragment"],
  },
  {
    name: "readable fragments of an untyped partial quote re-enter sibling authority",
    breaks:
      "a case refused as untyped can still widen another case's documented union or license its code comparison",
    file: EXPAND,
    find: "    if (unparsedLines.length > 0) continue;",
    replace: "    if (false) continue;",
    kills: ["FIX A1 seam: a partial quote is untyped end-to-end and cannot accuse from its readable fragment"],
  },
  {
    name: "an explicit-negative option is minted as required positive membership",
    breaks:
      "a survey correctly omitting the option the document forbids is accused of OPTION_MISSING — the proposition is inverted",
    file: EXPAND,
    find: '  if (r.assertionStatus === "explicit-negative") {',
    replace: "  if (false) {",
    kills: ["FIX A3: an explicit-negative option is never positive assertion or sibling authority"],
  },
  {
    name: "an explicit-negative option re-enters positive sibling authority",
    breaks:
      "a forbidden label can mask a forbidden extra option or license a code-keyed accusation in another positive case",
    file: EXPAND,
    find: '    if (r.assertionStatus !== "entailed") continue;',
    replace: "    if (!constrainsMatching(r.assertionStatus)) continue;",
    kills: ["FIX A3: an explicit-negative option is never positive assertion or sibling authority"],
  },
  {
    name: "another question's options become this question's corroboration",
    breaks: "the sibling set licenses a code comparison, and a foreign question's codes license nothing",
    file: EXPAND,
    find: "      if (from === exclude.requirementVersionId) continue;",
    replace: "      if (false) continue;",
    kills: ["SIBLINGS are the other rows' options for the SAME question, and carry no claim"],
  },
  {
    name: "a DISPUTED row's options re-enter the sibling inventory",
    breaks:
      "a borrowed sibling widens the verifier's `documented` union — masking a real extra-option defect as " +
      "documented — and can witness a code-vocabulary licence off evidence the expander refused to seal (1.5.0)",
    file: EXPAND,
    find: '    if (r.assertionStatus !== "entailed") continue;',
    replace: "    if (false) continue;",
    kills: ["FIX A2 (review-extract finding 3): a DISPUTED row's options never enter a sibling inventory"],
  },
  {
    name: "a question-AMBIGUOUS row's options re-enter the sibling inventory",
    breaks:
      "options whose owning question has two readings corroborate a question they may not belong to, " +
      "borrowing evidence the expander itself refused as OPTION_SET_QUESTION_AMBIGUOUS (1.5.0)",
    file: EXPAND,
    find: "    if (namesAnotherQuestion(r, q, vocabulary).length > 0) continue;",
    replace: "    if (false) continue;",
    kills: ["FIX A2: a question-AMBIGUOUS row's options never enter a sibling inventory"],
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
    // RE-ANCHORED for 1.7.0 (FIX C1): the sole-group early return this mutant used to widen
    // (`groups.length === 1` -> `>= 1`) was DELETED — the same property ("the first group is
    // assumed to be the target's") is reinstated by bypassing the attribution filter outright.
    // Kills updated for 1.8.0: the mutant's unconditional return sits BEFORE clause (ii), so
    // it also hands the consent group to a textarea-rendered target.
    name: "the first option group on the screen is assumed to be the target's",
    breaks: "comparing a document's options against another question's inventory accuses a healthy survey",
    file: VERIFY,
    // Re-anchored for 1.8.1: acceptance carries its provenance; the mutant hands the first
    // group back AS IF name-attributed, so every arm (extra included) treats it as the target's.
    find: '  if (named.length === 1) return { group: named[0]!, attribution: "named" };',
    replace: '  if (groups.length >= 1) return { group: groups[0]!, attribution: "named" };',
    kills: [
      "NEVER ACCUSED: a grid is not compared, and a screen hosting two groups is not guessed at",
      "FIX C1: the consent-checkbox case — a sole unrelated group beside a free-text target refuses",
    ],
  },
  {
    // FIX C1 guard 1: the pre-1.7.0 sole-group early return, reinstated verbatim in front of
    // the attribution filter AND clause (ii)'s exclusions. This is the exact original bug: one
    // group, believed unexamined — no only-answerable test, no "(unnamed)" carve-out. Each of
    // the three named tests pins one exclusion the unconditional return bypasses.
    name: "a SOLE option group is handed back with no attribution check (pre-1.7.0)",
    breaks:
      "a target rendered as a <select> contributes no option group, so the sole group the screen does carry — " +
      "a consent checkbox, another question's radios — inherits the comparison and a healthy survey is accused",
    file: VERIFY,
    find: "  const named = groups.filter((g) => {",
    // "attribution: named" is the faithful rendering of the original bug: the sole group was
    // believed to be the target's outright, so every arm — the extra arm included — ran on it.
    replace:
      '  if (groups.length === 1) return { group: groups[0]!, attribution: "named" };\n  const named = groups.filter((g) => {',
    kills: [
      "FIX C1: the consent-checkbox case — a sole unrelated group beside a free-text target refuses",
      "FIX C1 respin: a sole '(unnamed)' group is refused — never satisfied, never violated",
      "FIX C1 respin boundary: a sole 'answer' group beside an answerable text input refuses",
    ],
  },
  {
    // W4 extended the verifier from refusing all target-native-select inventories to comparing
    // a fully attested one. Mutating the old refusal in `targetOptionGroup` became equivalent:
    // `targetOptionInventory` now intercepts every attributed select before that code can run.
    // Break the live dispatch instead. The guards pin BOTH useful directions (a current select
    // can verify or contradict) and the conservative boundary (an older, unattested select is
    // still named insufficient rather than borrowing a neighbouring option group).
    name: "an attributed native-select inventory stops reaching the verifier",
    breaks:
      "a fully attested target dropdown is a first-class inventory; silently falling back to group-only refusal " +
      "loses both verified coverage and real missing-option findings",
    file: VERIFY,
    find: "  if (targetSelects.length === 1) {\n    const control = targetSelects[0]!;",
    replace: "  if (false) {\n    const control = targetSelects[0]!;",
    kills: [
      "a complete current native-select inventory verifies and its HTML placeholder is not an extra",
      "a fully attested dropdown missing a documented option produces the real OPTION_MISSING claim",
      "FIX C1: a target rendered as a <select> never inherits another control's inventory",
    ],
  },
  {
    // FIX C1 respin guard 1 (1.8.0): the "(unnamed)" carve-out is deleted from the
    // only-answerable clause. "(unnamed)" is page-script's MERGE KEY (`c.name || '(unnamed)'`)
    // — unnamed radios from SEVERAL questions collapse under it, so a sole "(unnamed)" group
    // may be a fusion no single question owns, and accepting it can certify or accuse the
    // target off an inventory that is not its own.
    name: "the '(unnamed)' merge key is accepted by the only-answerable clause",
    breaks: "a fused inventory of several unnamed questions can certify or accuse the target",
    file: VERIFY,
    find: '  if (groups.length === 1 && groups[0]!.name !== "(unnamed)") {',
    replace: "  if (groups.length === 1) {",
    kills: ["FIX C1 respin: a sole '(unnamed)' group is refused — never satisfied, never violated"],
  },
  {
    // FIX C1 respin guard 2 (1.8.0): clause (ii) stops requiring the sole group to be the
    // screen's ONLY answerable thing — the borrowed-inventory shapes 1.7.0 closed reopen,
    // because with a second candidate rendering on screen "the sole group is the target's"
    // is a guess again.
    name: "the only-answerable clause accepts a sole group beside another answerable control",
    breaks:
      "a screen carrying a text entry (or any other candidate rendering) beside an unattributed sole group can " +
      "have that group's inventory read as the target's — the exact borrowed-comparison FIX C1 exists to refuse",
    file: VERIFY,
    find: '    if (otherAnswerable.length === 0) return { group: groups[0]!, attribution: "only-answerable" };',
    replace: '    if (true) return { group: groups[0]!, attribution: "only-answerable" };',
    kills: ["FIX C1 respin boundary: a sole 'answer' group beside an answerable text input refuses"],
  },
  {
    // 1.8.1 guard (Codex review BLOCKER 1): the clause-(ii) licence gate on the offered-extra
    // arm is deleted — the pre-1.8.1 arm, verbatim. `page-script.ts` merges radio/checkbox
    // controls into groups by NAME alone, so a target and a consent question sharing one
    // control name fuse into ONE group; an exhaustive target then accuses the fused-in
    // consent option as an undocumented offer — the confident false accusation 1.8.1 closes.
    name: "the offered-extra arm is re-licensed under the only-answerable clause (pre-1.8.1)",
    breaks:
      "a sole group accepted only as the screen's one answerable thing may be a NAME-FUSION of two questions; " +
      "accusing its extra entries reads the other fused question's option as the target's undocumented offer",
    file: VERIFY,
    find: '        if (attributed.attribution !== "named") {',
    replace: "        if (false) {",
    kills: ["FIX 1.8.1: a fused target+consent group under one name never mints the extra-option accusation"],
  },
  {
    // FIX C2 guard: the extra arm's offered-vs-present split is deleted — the pre-1.7.0 arm.
    name: "a hidden extra option is accused as an undocumented offer (pre-1.7.0)",
    breaks:
      "'offered to the respondent' and 'present in the DOM' are different claims — the membership arm refuses the " +
      "conflation and the extra arm ran it in the accusing direction, naming hidden sentinel radios as defects",
    file: VERIFY,
    find: "      const extraOffered = extra.filter((o) => o.visible !== false && o.operable !== false);",
    replace: "      const extraOffered = extra;",
    kills: [
      "FIX C2: a hidden 'no answer' sentinel with an empty label is not an undocumented offer",
      "FIX C2: a display:none alternate-layout option is not an undocumented offer either",
      "FIX C2 edge: a genuinely offered extra still accuses, and quotes only what is reachable",
    ],
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
    find:
      "      performed: (s) =>\n" +
      "        (s.screenBefore?.optionGroups ?? []).some((g) => (g?.options?.length ?? 0) > 0) ||\n" +
      "        (s.screenBefore?.controls ?? []).some(\n" +
      "          (c) => (c?.tag === \"select\" || c?.type === \"select\") && Array.isArray(c.options),\n" +
      "        ),",
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
