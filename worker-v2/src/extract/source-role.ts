import type { SourceBlock } from "./types";

/**
 * Parser-origin facts carried through the existing string-valued `SourceAtom.role` field.
 * They are not new wire kinds: the reserved prefix distinguishes source authority from an
 * extraction model's free-form construct/facet name.
 */
export const NON_ANSWER_OPTION_SOURCE_ROLE = Object.freeze({
  COMBO_BOX_SUGGESTION: "source-origin:combo-box-suggestion",
  RUBY_READING: "source-origin:ruby-reading",
} as const);

/** Map only declared parser origins; ordinary source blocks retain their producer role. */
export function sourceAtomRole(block: Pick<SourceBlock, "origin"> | null | undefined, fallback: string): string {
  if (block?.origin === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;
  if (block?.origin.startsWith("ruby-reading")) return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;
  return fallback;
}

export const isNonAnswerOptionSourceRole = (role: string): boolean =>
  role === NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION ||
  role === NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;
