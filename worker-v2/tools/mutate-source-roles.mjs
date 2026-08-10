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

const MODEL = "model merge: combo suggestions and ruby readings stay counted gaps and never become siblings";
const MAP = "origin mapper: exact combo and every ruby-reading prefix map; lookalikes do not";
const HUMAN_PATH = "human exact-span path carries the same roles and produces the same named gaps";

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
];

await runMutantSuite({
  title: "D50 source-role mutants — can visible metadata acquire option authority?",
  filter: "D50",
  mutants: MUTANTS,
});
