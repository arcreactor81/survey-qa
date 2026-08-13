/**
 * D50 SOURCE-ROLE MUTANTS — proof that visible DOCX metadata cannot enter option authority.
 *
 * Mutations are applied only inside esbuild; no source file is rewritten.
 *
 *   node tools/mutate-source-roles.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const ROLE = "src/extract/source-role.ts";
const MERGE = "src/extract/merge.ts";
const HUMAN = "src/contract/human-authored.ts";
const EXPAND = "src/extract/expand.ts";
const DOCX = "src/extract/docx-blocks.ts";

const PASSB = "src/extract/pass-b.ts";

const MODEL = "model merge: combo suggestions and ruby readings stay counted gaps and never become siblings";
const MAP = "structural mapper: declared subroles map; origin text alone never changes authority";
const HUMAN_PATH = "human exact-span path carries the same roles and produces the same named gaps";
// Finding B1 guards. They live HERE and not in mutate-docx-blocks.mjs because that harness
// runs under the "DOCX READER" filter, which never executes the D50 tests these mutants are
// killed by — a mutant whose named guard cannot run is a permanent SURVIVED, i.e. unprovable.
const COMBO_TABLE =
  "combo-box suggestions in a table cell stay origin-labelled, marked OPEN-NOT-EXHAUSTIVE, and are refused as an answer list";
const RUBY_TABLE = "ruby readings in a table cell stay origin-labelled and are refused as an answer list";
const CELL_BOUNDARY = "boundary: an empty cell still emits its suggestions; plain text and dropdowns in cells fold unchanged";
// Blocker 3 guards (Codex review of DOCX 1.3.0): row accounting requires kind === "table-cell".
const ROW_COMBO = "row accounting: a cited plain cell must NOT absorb an uncited combo suggestion in the same row";
const ROW_RUBY = "row accounting: a cited cell must NOT absorb an uncited ruby reading in the same row";
const ROW_SWEEP = "pass B's unaccounted sweep still buys a lifted block hosted in a cited row";

const MUTANTS = [
  {
    name: "combo authority regresses from a declared subrole to origin text",
    breaks:
      "a parser declaration is ignored while a stale or forged human-readable origin can acquire answer-option authority",
    file: ROLE,
    find:
      '  if (block?.sourceSubrole === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    replace:
      '  if (block?.origin === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    kills: [MAP],
  },
  {
    name: "ruby authority regresses from a declared subrole to an origin-text prefix",
    breaks:
      "human-readable provenance becomes executable authority, so a stale or forged ruby label can mint a reserved source role",
    file: ROLE,
    find:
      '  if (block?.sourceSubrole === "ruby-reading") return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;',
    replace:
      '  if (block?.origin.startsWith("ruby-reading")) return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;',
    kills: [MAP],
  },
  {
    name: "model merge stops carrying parser-origin authority",
    breaks: "the expander cannot refuse a source fact the merge erased",
    file: MERGE,
    find: "      const rawRole = sourceAtomRole(b, primary.construct);",
    replace: "      const rawRole = primary.construct;",
    kills: [MODEL],
  },
  {
    name: "human exact spans stop carrying parser-origin authority",
    breaks: "human authorship would become a bypass around the same deterministic guard",
    file: HUMAN,
    find: "      role: sourceAtomRole(held.block, authored.facet),",
    replace: "      role: authored.facet,",
    kills: [HUMAN_PATH],
  },
  {
    name: "the option-set mint ignores non-answer source roles",
    breaks: "short suggestion/reading text is sealed and sent to the answer-option predicate",
    file: EXPAND,
    find: "  if (refusedRoles.length > 0) {",
    replace: "  if (false) {",
    kills: [MODEL, HUMAN_PATH],
  },
  {
    name: "non-answer source roles enter sibling corroboration",
    breaks: "a combo/ruby label can license a code-keyed accusation in another option row",
    file: EXPAND,
    find: "    if (nonAnswerOptionSourceRoles(r).length > 0) continue;",
    replace: "    if (false) continue;",
    kills: [MODEL],
  },

  // ============================================================ finding B1: the table-cell fold
  {
    name: "table cells stop lifting structurally declared non-answer drafts",
    breaks:
      "a combo suggestion or ruby reading inside a table cell loses the structural branch that preserves its " +
      "declared source role, so the block is folded into ordinary cell text and may acquire answer authority",
    file: DOCX,
    find:
      "          if (d.sourceSubrole != null) {\n" +
      "            cellDrafts.push({\n" +
      "              ...d,\n" +
      '              kind: "paragraph",\n' +
      "              tableId,\n" +
      "              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },\n" +
      "            });\n" +
      "          }",
    replace:
      "          if (d.sourceSubrole != null && clean(d.text).length > 0) {\n" +
      "            parts.push(clean(d.text));\n" +
      "          }",
    kills: [COMBO_TABLE, RUBY_TABLE, CELL_BOUNDARY],
  },
  {
    name: "lifted table metadata loses its host-cell coordinates",
    breaks:
      "the parser still emits and authority-labels the block, but the merged SourceAtom can no longer identify " +
      "which table row and grid column hosted it",
    file: DOCX,
    find:
      '              kind: "paragraph",\n' +
      "              tableId,\n" +
      "              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },",
    replace:
      '              kind: "paragraph",\n' +
      "              tableId,\n" +
      "              coords: null,",
    kills: [COMBO_TABLE, RUBY_TABLE, CELL_BOUNDARY],
  },
  {
    name: "only table-cell kinds may start a table banner",
    breaks:
      "an empty first cell can emit a lifted suggestion before the annotation tells either model that a table began",
    file: DOCX,
    find: "    if (b.tableId !== null && b.tableId !== lastTable) {",
    replace: '    if (b.kind === "table-cell" && b.tableId !== lastTable) {',
    kills: [CELL_BOUNDARY],
  },
  {
    name: "lifted cell drafts are silently dropped on the non-empty-cell path",
    breaks: "the cell's own text survives but every table-hosted suggestion/reading disappears without a trace",
    file: DOCX,
    find:
      "      // Reading order mirrors the body path: the host cell's own text first, then its\n" +
      "      // origin-bearing drafts.\n" +
      "      out.push(...c.drafts);",
    replace:
      "      // Reading order mirrors the body path: the host cell's own text first, then its\n" +
      "      // origin-bearing drafts.\n" +
      "      void c.drafts;",
    kills: [COMBO_TABLE, RUBY_TABLE],
  },
  {
    name: "an empty cell's drafts are dropped with the cell",
    breaks: "a cell whose only content is a content control loses its suggestions in silence — the boundary the fix moved",
    file: DOCX,
    find:
      "        // A cell whose only content is a content control still owes its origin-bearing\n" +
      "        // drafts: skipping the empty cell must not silently drop the open suggestions.\n" +
      "        out.push(...c.drafts);\n" +
      "        continue;",
    replace:
      "        // A cell whose only content is a content control still owes its origin-bearing\n" +
      "        // drafts: skipping the empty cell must not silently drop the open suggestions.\n" +
      "        continue;",
    kills: [CELL_BOUNDARY],
  },

  // ================================================== blocker 3: row accounting absorbs lifted blocks
  // Single-LINE anchors on purpose: merge.ts is CRLF on disk while pass-b.ts is LF, so a
  // multi-line "\n" anchor silently fails to match one of them (BROKEN-ANCHOR, not a kill).
  {
    name: "the ledger row-accounts ANY block with tableId+coords (the pre-fix behaviour)",
    breaks:
      "an uncited combo suggestion or ruby reading in a cited row gains accountedVia and vanishes from " +
      "the ledger's unexplained list — a silent coverage hole behind an ordinary cited cell",
    file: MERGE,
    find:
      '    b.kind === "table-cell" && b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;',
    replace: "    b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;",
    kills: [ROW_COMBO, ROW_RUBY],
  },
  {
    name: "pass B's unaccounted sweep row-accounts ANY block with tableId+coords (the pre-fix behaviour)",
    breaks:
      "the sweep's unaccounted set drops every uncited lifted block whose host row is cited, so the one " +
      "call that would have finished the read is never issued and the block silently disappears",
    file: PASSB,
    find:
      '    b.kind === "table-cell" && b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;',
    replace: "    b.tableId !== null && b.coords !== null ? `${b.tableId}#r${b.coords.row}` : null;",
    kills: [ROW_SWEEP],
  },
];

await runMutantSuite({
  title: "D50 source-role mutants — can visible metadata acquire option authority?",
  filter: "D50",
  mutants: MUTANTS,
});
