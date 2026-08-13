/**
 * W6 GREY-PROGRAMMING MUTANTS -- rejected shortcuts, run against the real seam.
 *
 * The formatting parser is neutral. A named shop profile maps only direct, proven grey
 * evidence to programming provenance. These mutants prove the suite rejects tempting
 * shortcuts: treating every colour/theme as grey, losing table backgrounds, hiding the
 * assumption on unaffected documents, stripping route evidence, guessing a repeated span,
 * or returning to the old fixed-name Relationship parser.
 *
 * Mutations are applied by the esbuild loader and never written under src/**.
 *
 *   node tools/mutate-grey-programming-logic.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const DOCX = "src/extract/docx-blocks.ts";
const MERGE = "src/extract/merge.ts";
const EXPAND = "src/extract/expand.ts";
const SOURCE_ROLE = "src/extract/source-role.ts";

const MIXED = "mixed runs preserve byte order; strict grey classifies and coloured highlight counterweights";
const CELL = "grey cell fill classifies consent logic; theme/style backgrounds are named but not guessed";
const DIRECT_FILL = "explicit non-grey run shading counterweights grey paragraph and cell ancestors";
const NOTES = "footnotes and endnotes preserve selected semantics; comment formatting loss is named";
const NEUTRAL = "neutral is the default: grey stays respondent-eligible, named, and identity-separated";
const CACHE = "whole-pass cache cannot cross document-semantics profiles";
const OPTION = "option merge excludes exact grey bytes with counts; route merge retains them";
const CLOSED = "non-grey marker remains unread and non-exact programming subtraction fails closed";
const RELS = "package relationship resolves an arbitrary main-part name across serialization shapes";
const AUX = "relationship-discovered auxiliary parts keep exact identity, subroles, and unreadable references";
const SPECIFICITY = "more-specific unresolved paragraph and run formatting cannot inherit a grey cell";

const MUTANTS = [
  {
    name: "legacy parser default silently opts into shop semantics",
    breaks: "an unseen questionnaire loses grey respondent-facing bytes without an explicit run declaration",
    file: DOCX,
    find: "  options: ParseDocxBlocksOptions = {},",
    replace: "  options: ParseDocxBlocksOptions = { documentSemanticsProfile: GREY_PROGRAMMING_PROFILE },",
    kills: [NEUTRAL],
  },
  {
    name: "parser identity drops the declared semantics profile",
    breaks: "neutral and shop documents can reuse the same persisted model work",
    file: DOCX,
    find: "  `${DOCX_BLOCKS_BASE_VERSION}+profile=${profile}`;",
    replace: "  `${DOCX_BLOCKS_BASE_VERSION}`;",
    kills: [NEUTRAL, CACHE],
  },
  {
    name: "neutral grey evidence is silently unreported",
    breaks: "the parser keeps bytes but fails to name that a present convention was deliberately left unclassified",
    file: DOCX,
    find: "  if (documentSemanticsProfile === DOCUMENT_SEMANTICS_NONE && greyEvidenceRuns > 0) {",
    replace: "  if (false) {",
    kills: [NEUTRAL],
  },
  {
    name: "achromatic fill classification accepts every six-digit colour",
    breaks: "red, black and white formatting become programming instructions under a rule that claims to mean grey",
    file: DOCX,
    find: "  return r === g && g === b && r > 0 && r < 255;",
    replace: "  return /^[0-9a-f]{6}$/i.test(value);",
    kills: [MIXED],
  },
  {
    name: "direct lightGray and darkGray highlights are ignored",
    breaks: "the strongest direct run evidence remains visible but loses its programming provenance",
    file: DOCX,
    find: '  if (highlight !== null) return highlight === "lightgray" || highlight === "darkgray";',
    replace: "  if (highlight !== null) return false;",
    kills: [MIXED],
  },
  {
    name: "a coloured direct highlight no longer counterweights a grey ancestor",
    breaks: "respondent-facing coloured text inside a grey paragraph or cell is silently reclassified as programming",
    file: DOCX,
    find: '  if (highlight !== null) return highlight === "lightgray" || highlight === "darkgray";',
    replace: '  if (highlight !== null && (highlight === "lightgray" || highlight === "darkgray")) return true;',
    kills: [MIXED, CELL],
  },
  {
    name: "an explicit non-grey run fill falls through to a grey ancestor",
    breaks: "direct red/black/white respondent copy is reclassified by less-specific paragraph or cell shading",
    file: DOCX,
    find: "    return explicitAchromaticGrey(run.shadingFill);",
    replace: "    return explicitAchromaticGrey(run.shadingFill) || backgroundGreyProgramming(paragraphBackground) || backgroundGreyProgramming(cellBackground);",
    kills: [DIRECT_FILL],
  },
  {
    name: "theme-resolved and nil shading are accepted as direct grey",
    breaks: "unresolved/non-rendered shading silently becomes programming provenance",
    file: DOCX,
    find: '    if (run.themeFill !== null || (run.shadingVal?.trim().toLowerCase() ?? null) === "nil") return false;',
    replace: "    if (false) return false;",
    kills: [DIRECT_FILL],
  },
  {
    name: "note parsing drops the selected document-semantics profile",
    breaks: "grey note instructions lose their role or are reinterpreted differently from the body",
    file: DOCX,
    find: '    const drafts = scanBody(m[2] ?? "", s, coverage, origin, documentSemanticsProfile, origin)',
    replace: '    const drafts = scanBody(m[2] ?? "", s, coverage, origin, DOCUMENT_SEMANTICS_NONE, origin)',
    kills: [NOTES],
  },
  {
    name: "auxiliary tables reuse body-local table ids",
    breaks: "a cited body row can falsely account an uncited footnote/endnote row",
    file: DOCX,
    find: "    const tableId = tableNamespace === null ? `t${tableN}` : `${tableNamespace}:t${tableN}`;",
    replace: "    const tableId = `t${tableN}`;",
    kills: [NOTES],
  },
  {
    name: "programming annotation drops auxiliary origin",
    breaks: "the extraction model sees note logic without knowing it came from a footnote/endnote",
    file: DOCX,
    find: "        `[${b.blockId}] ${describe(b)}[programming logic; profile=${GREY_PROGRAMMING_PROFILE}; direct-grey-runs=${spans}: ${inlineText}]`,",
    replace: "        `[${b.blockId}] [programming logic; profile=${GREY_PROGRAMMING_PROFILE}; direct-grey-runs=${spans}: ${inlineText}]`,",
    kills: [NOTES],
  },
  {
    name: "namespaced single-quoted separator notes become content",
    breaks: "Word's separator pseudo-note is emitted as a questionnaire instruction",
    file: DOCX,
    find: "    const noteType = xmlAttribute(attrs, \"type\")?.trim().toLowerCase() ?? null;",
    replace: "    const noteType = null;",
    kills: [NOTES],
  },
  {
    name: "declared empty notes disappear from the denominator",
    breaks: "an unreadable footnote is silently omitted instead of retained as a counted placeholder",
    file: DOCX,
    find: "    if (drafts.length === 0) {",
    replace: "    if (false) {",
    kills: [NOTES],
  },
  {
    name: "Word comments lose their named formatting limitation",
    breaks: "proposal formatting disappears without a counted limitation",
    file: DOCX,
    find: "    if (comments.length > 0) {",
    replace: "    if (false) {",
    kills: [NOTES],
  },
  {
    name: "source atoms reuse the stitched display quote hash",
    breaks: "each source atom cryptographically claims bytes belonging to a different projected quote",
    file: MERGE,
    find: "        atomTextHash: `sha256:${await sha256Hex(b.text)}`,",
    replace: "        atomTextHash: `sha256:${quoteHash}`,",
    kills: [OPTION, NOTES],
  },
  {
    name: "table-cell background evidence is not propagated into paragraph runs",
    breaks: "the retained F2F2F2 programming cells, including the consent case, become ordinary answer text",
    file: DOCX,
    find: "          ...paragraphDrafts(paraMatch[1], s, coverage, origin, cellBackground, documentSemanticsProfile),",
    replace: "          ...paragraphDrafts(paraMatch[1], s, coverage, origin, null, documentSemanticsProfile),",
    kills: [CELL],
  },
  {
    name: "paragraph background evidence is ignored",
    breaks: "direct F2F2F2 paragraph shading no longer derives programming provenance",
    file: DOCX,
    find: "  if (paragraphBackground !== null) return backgroundGreyProgramming(paragraphBackground);",
    replace: "  if (paragraphBackground !== null) return false;",
    kills: [MIXED],
  },
  {
    name: "an unresolved theme fill is guessed to be grey",
    breaks: "theme resolution the parser did not perform is converted into confident programming provenance",
    file: DOCX,
    find: "  if (background === null || background.themeFill !== null) return false;",
    replace: "  if (background === null) return false;",
    kills: [DIRECT_FILL],
  },
  {
    name: "package style inheritance is silently treated as resolved",
    breaks: "direct evidence remains neutral but a style/default background the parser never read is no longer named",
    file: DOCX,
    find: '    ...(partNames.includes("word/styles.xml") ? ["style-inheritance:word/styles.xml"] : []),',
    replace: "    ...[],",
    kills: [CELL],
  },
  {
    name: "mixed-role table cells disappear from the physical non-empty denominator",
    breaks: "lifting programming/ordinary pieces makes a visibly populated cell count as empty in table coverage",
    file: DOCX,
    find: "        clean(cell.text).length > 0 || cell.drafts.some((draft) => clean(draft.text).length > 0),",
    replace: "        clean(cell.text).length > 0,",
    kills: [CELL],
  },
  {
    name: "the shop profile is reported even when it changed no block",
    breaks: "every neutral questionnaire claims a material grey-profile assumption, flooding coverage with a non-event",
    file: DOCX,
    find: "  if (programmingBlocks.length > 0) {",
    replace: "  if (true) {",
    kills: [MIXED],
  },
  {
    name: "exact raw programming bytes are not subtracted from option quotes",
    breaks: "a programming instruction remains eligible to become a respondent option label",
    file: MERGE,
    find: "    } else if (exactOccurrenceCount(quote, block.text) === 1) {",
    replace: "    } else if (false) {",
    kills: [OPTION],
  },
  {
    name: "overlapping source occurrences are miscounted as one exact occurrence",
    breaks: "AA inside AAA is guessed removable even though two exact source-span positions exist",
    file: MERGE,
    find: "    at += 1;",
    replace: "    at += needle.length;",
    kills: [CLOSED],
  },
  {
    name: "option-only projection is applied to route requirements too",
    breaks: "normative routing and termination evidence is removed from the very requirement that needs it",
    file: MERGE,
    find: '  if (primary.construct !== "option-list" && primary.construct !== "option-set") {',
    replace: "  if (false) {",
    kills: [OPTION],
  },
  {
    name: "ambiguous repeated programming bytes fail open",
    breaks: "when exact subtraction cannot be proven, the expander guesses an option set instead of naming the limitation",
    file: EXPAND,
    find: "  if (unresolvedProgramming.length > 0) {",
    replace: "  if (false) {",
    kills: [CLOSED],
  },
  {
    name: "exact programming exclusions are not counted",
    breaks: "the output performs a material semantic subtraction but its coverage denominator says zero source atoms",
    file: EXPAND,
    find: "        programmingLogicOptionExclusions.sourceAtoms += excluded.sourceAtoms;",
    replace: "        programmingLogicOptionExclusions.sourceAtoms += 0;",
    kills: [OPTION],
  },
  {
    name: "relative auxiliary targets are resolved from the package root",
    breaks: "an arbitrary main-part directory points at the wrong annotation/header bytes",
    file: DOCX,
    find: '  const base = absolute || sourcePart === null ? [] : sourcePart.split("/").slice(0, -1);',
    replace: "  const base: string[] = [];",
    kills: [AUX],
  },
  {
    name: "main-part auxiliary relationships are ignored",
    breaks: "renamed note, comment, header and footer parts silently disappear",
    file: DOCX,
    find: "  const auxiliary = mainRelationships.relationships",
    replace: "  const auxiliary = ([] as PackageRelationship[])",
    kills: [AUX],
  },
  {
    name: "broken auxiliary relationship target is treated as readable",
    breaks: "a referenced missing part is not reported as a counted relationship failure",
    file: DOCX,
    find: "    if (!raw) {",
    replace: "    if (!raw && false) {",
    kills: [AUX],
  },
  {
    name: "referenced annotations without readable declarations disappear",
    breaks: "body references to missing notes/comments no longer create denominator placeholders",
    file: DOCX,
    find: '  for (const kind of ["footnote", "endnote", "comment"] as const) {',
    replace: '  for (const kind of [] as Array<"footnote" | "endnote" | "comment">) {',
    kills: [AUX],
  },
  {
    name: "self-closing note declarations are ignored",
    breaks: "a declared empty note vanishes instead of producing an unreadable placeholder",
    file: DOCX,
    find: '    `<${p}${element}(?=[\\\\s/>])([^>]*?)(?:\\\\/>|>([\\\\s\\\\S]*?)<\\\\/${p}${element}>)`,',
    replace: '    `<${p}${element}(?=[\\\\s>])([^>]*)>([\\\\s\\\\S]*?)<\\\\/${p}${element}>`,',
    kills: [AUX],
  },
  {
    name: "self-closing comment declarations are ignored",
    breaks: "a declared empty proposal vanishes instead of producing an unreadable placeholder",
    file: DOCX,
    find: '    `<${p}comment(?=[\\\\s/>])([^>]*?)(?:\\\\/>|>([\\\\s\\\\S]*?)<\\\\/${p}comment>)`,',
    replace: '    `<${p}comment(?=[\\\\s>])([^>]*)>([\\\\s\\\\S]*?)<\\\\/${p}comment>`,',
    kills: [AUX],
  },
  {
    name: "part identity is removed from auxiliary origins",
    breaks: "two header tables can collide and source provenance no longer names exact package bytes",
    file: DOCX,
    find: '    const origin = `${kind} [part=${relationship.target}]`;',
    replace: '    const origin = `${kind}`;',
    kills: [AUX],
  },
  {
    name: "structural source subroles are stripped at the parser boundary",
    breaks: "decorated auxiliary combo/image blocks lose their downstream non-answer authority",
    file: DOCX,
    find: "      sourceSubrole: b.sourceSubrole ?? null,",
    replace: "      sourceSubrole: null,",
    kills: [AUX],
  },
  {
    name: "combo suggestions use decorated origin text instead of structural subrole",
    breaks: "an auxiliary combo suggestion is eligible to seal as an exhaustive option list",
    file: SOURCE_ROLE,
    find: '  if (block?.sourceSubrole === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    replace: '  if (false) return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    kills: [AUX],
  },
  {
    name: "image alt loses its non-answer structural role",
    breaks: "alternative text can be reinterpreted as a respondent answer label",
    file: SOURCE_ROLE,
    find: '  if (block?.sourceSubrole === "image-alt") return NON_ANSWER_OPTION_SOURCE_ROLE.IMAGE_ALT;',
    replace: '  if (false) return NON_ANSWER_OPTION_SOURCE_ROLE.IMAGE_ALT;',
    kills: [AUX],
  },
  {
    name: "named run style falls through to grey ancestors",
    breaks: "unresolved styled respondent text inherits cell programming semantics",
    file: DOCX,
    find: "  if (run.runStyle !== null) return false;",
    replace: "  if (false) return false;",
    kills: [SPECIFICITY],
  },
  {
    name: "empty direct run shading falls through to grey ancestors",
    breaks: "a present but unresolved higher-specificity declaration is ignored",
    file: DOCX,
    find: "  if (run.shadingPresent === true || run.shadingFill !== null || run.shadingVal != null || run.themeFill !== null) {",
    replace: "  if (run.shadingFill !== null || run.shadingVal != null || run.themeFill !== null) {",
    kills: [SPECIFICITY],
  },
  {
    name: "named paragraph style falls through to grey cell",
    breaks: "unresolved paragraph style is overridden by a less-specific cell fill",
    file: DOCX,
    find: "  if (run.paragraphStyle !== null) return false;",
    replace: "  if (false) return false;",
    kills: [SPECIFICITY],
  },
  {
    name: "non-grey paragraph shading falls through to grey cell",
    breaks: "red/theme/nil paragraph declarations are overridden by lower cell formatting",
    file: DOCX,
    find: "  if (paragraphBackground !== null) return backgroundGreyProgramming(paragraphBackground);",
    replace: "  if (paragraphBackground !== null && backgroundGreyProgramming(paragraphBackground)) return true;",
    kills: [SPECIFICITY],
  },

  {
    name: "package relationships require an unprefixed fixed serialization",
    breaks: "a valid package whose main part is named through a namespace-prefixed Relationship becomes unreadable",
    file: DOCX,
    find: "    const re = /<(?:[A-Za-z_][\\w.-]*:)?Relationship(?=[\\s/>])[^>]*\\/?>/gi;",
    replace: "    const re = /<Relationship(?=[\\s/>])[^>]*\\/?>/gi;",
    kills: [RELS],
  },
];

await runMutantSuite({
  title: "W6 GREY-PROGRAMMING MUTANTS -- provenance, exclusion, retention and package discovery",
  filter: "W6",
  mutants: MUTANTS,
});
