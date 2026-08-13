import type { SourceBlock } from "./types";

/**
 * Parser-origin facts carried through the existing string-valued `SourceAtom.role` field.
 * They are not new wire kinds: the reserved prefix distinguishes source authority from an
 * extraction model's free-form construct/facet name.
 */
export const NON_ANSWER_OPTION_SOURCE_ROLE = Object.freeze({
  COMBO_BOX_SUGGESTION: "source-origin:combo-box-suggestion",
  RUBY_READING: "source-origin:ruby-reading",
  IMAGE_ALT: "source-origin:image-alt",
  COMMENT_PROPOSAL: "source-origin:comment-proposal",
} as const);

export const PROGRAMMING_LOGIC_SOURCE_ROLE_PREFIX = "source-origin:programming-logic" as const;
const EXACT_OPTION_EXCLUSION = "option-exclusion=exact";

type RoleBlock = Pick<SourceBlock, "origin"> & Partial<Pick<SourceBlock, "semanticSpans" | "sourceSubrole">>;

/** Map only declared parser origins; ordinary source blocks retain their producer role. */
export function sourceAtomRole(block: RoleBlock | null | undefined, fallback: string): string {
  const programming = block?.semanticSpans?.filter((span) => span.role === "programming-logic") ?? [];
  if (programming.length > 0) {
    const runSpans = programming.reduce((count, span) => count + span.runSpans, 0);
    const profile = programming[0]!.profile;
    return `${PROGRAMMING_LOGIC_SOURCE_ROLE_PREFIX};profile=${profile};run-spans=${runSpans}`;
  }
  if (block?.sourceSubrole === "combo-box-suggestion") return NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION;
  if (block?.sourceSubrole === "ruby-reading") return NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING;
  if (block?.sourceSubrole === "image-alt") return NON_ANSWER_OPTION_SOURCE_ROLE.IMAGE_ALT;
  if (block?.sourceSubrole === "comment-proposal") return NON_ANSWER_OPTION_SOURCE_ROLE.COMMENT_PROPOSAL;
  return fallback;
}

export const isProgrammingLogicSourceRole = (role: string): boolean =>
  role === PROGRAMMING_LOGIC_SOURCE_ROLE_PREFIX || role.startsWith(`${PROGRAMMING_LOGIC_SOURCE_ROLE_PREFIX};`);

export const programmingLogicRunSpans = (role: string): number => {
  if (!isProgrammingLogicSourceRole(role)) return 0;
  const parsed = /(?:^|;)run-spans=(\d+)(?:;|$)/.exec(role)?.[1];
  return parsed && Number.isSafeInteger(Number(parsed)) ? Number(parsed) : 1;
};

export const withExactProgrammingLogicOptionExclusion = (role: string): string =>
  isProgrammingLogicSourceRole(role) && !role.includes(`;${EXACT_OPTION_EXCLUSION}`)
    ? `${role};${EXACT_OPTION_EXCLUSION}`
    : role;

export const isExactlyExcludedProgrammingLogicSourceRole = (role: string): boolean =>
  isProgrammingLogicSourceRole(role) && role.split(";").includes(EXACT_OPTION_EXCLUSION);

export const isNonAnswerOptionSourceRole = (role: string): boolean =>
  role === NON_ANSWER_OPTION_SOURCE_ROLE.COMBO_BOX_SUGGESTION ||
  role === NON_ANSWER_OPTION_SOURCE_ROLE.RUBY_READING ||
  role === NON_ANSWER_OPTION_SOURCE_ROLE.IMAGE_ALT ||
  role === NON_ANSWER_OPTION_SOURCE_ROLE.COMMENT_PROPOSAL;
