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

const MODEL = "model merge: combo suggestions and ruby readings stay counted gaps and never become siblings";
const MAP = "origin mapper: exact combo and every ruby-reading prefix map; lookalikes do not";
const HUMAN_PATH = "human exact-span path carries the same roles and produces the same named gaps";
// Finding B1 guards. They live HERE and not in mutate-docx-blocks.mjs because that harness
// runs under the "DOCX READER" filter, which never executes the D50 tests these mutants are
// killed by — a mutant whose named guard cannot run is a permanent SURVIVED, i.e. unprovable.
const COMBO_TABLE =
  "combo-box suggestions in a table cell stay origin-labelled, marked OPEN-NOT-EXHAUSTIVE, and are refused as an answer list";
const RUBY_TABLE = "ruby readings in a table cell stay origin-labelled and are refused as an answer list";
const CELL_BOUNDARY = "boundary: an empty cell still emits its suggestions; plain text and dropdowns in cells fold unchanged";

const MUTANTS = [
  {
    name: "the combo-box origin is no longer authority-labelled",
    breaks: "an open suggestion becomes indistinguishable from a closed document answer option",
    file: ROLE,
    find: '  if (block?.origin === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    replace: '  if (false) return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;',
    kills: [MAP, MODEL, HUMAN_PATH],
  },
  {
    name: "only the bare ruby origin maps, losing real origins that name their base",
    breaks: "the parser carries association text after the stable prefix, so exact equality silently drops the role",
    file: ROLE,
    find: '  if (block?.origin.startsWith("ruby-reading")) return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;',
    replace: '  if (block?.origin === "ruby-reading") return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;',
    kills: [MAP, MODEL, HUMAN_PATH],
  },
  {
    name: "model merge stops carrying parser-origin authority",
    breaks: "the expander cannot refuse a source fact the merge erased",
    file: MERGE,
    find: "        role: sourceAtomRole(b, primary.construct),",
    replace: "        role: primary.construct,",
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
    name: "table cells fold origin-bearing drafts back into plain cell text (the pre-1.2.0 behaviour)",
    breaks:
      "the EXACT shape that shipped: a combo suggestion or ruby reading inside a w:tc loses the origin " +
      "annotate()'s OPEN-NOT-EXHAUSTIVE marker and the OPTION_SET_SOURCE_NOT_AN_ANSWER_LIST refusal key on, " +
      "so an open suggestion list in a table can seal as an exhaustive answer set",
    file: DOCX,
    find:
      "          else if (d.origin !== origin) {\n" +
      "            // The draft remains a paragraph so its origin continues to control authority, but\n" +
      "            // its host cell is still exact source provenance. `rows.length + 1` is the current\n" +
      "            // one-based row because this row has not yet been appended to `rows`.\n" +
      "            cellDrafts.push({\n" +
      "              ...d,\n" +
      "              tableId,\n" +
      "              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },\n" +
      "            });\n" +
      "          }",
    replace: "          else if (d.origin !== origin && clean(d.text).length > 0) parts.push(clean(d.text));",
    kills: [COMBO_TABLE, RUBY_TABLE, CELL_BOUNDARY],
  },
  {
    name: "lifted table metadata loses its host-cell coordinates",
    breaks:
      "the parser still emits and authority-labels the block, but the merged SourceAtom can no longer identify " +
      "which table row and grid column hosted it",
    file: DOCX,
    find:
      "              tableId,\n" +
      "              coords: { row: rows.length + 1, col: gridCol, rowHeader: null, colHeader: null },",
    replace: "              tableId,\n" + "              coords: null,",
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
];

await runMutantSuite({
  title: "D50 source-role mutants — can visible metadata acquire option authority?",
  filter: "D50",
  mutants: MUTANTS,
});
