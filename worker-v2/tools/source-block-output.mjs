/**
 * Privacy-safe projection of parser provenance for operator-facing output.
 *
 * A DOCX comment's author and initials are review metadata, not source authority. The
 * production parser currently carries both inside `SourceBlock.origin` so its model prompt
 * can distinguish a comment from body copy. Operator catalogues do not need the identity,
 * and printing it to stdout makes a private reviewer name part of shell history, captured
 * logs, and any redirected artifact.
 *
 * This boundary deliberately recognizes the parser's declared `comment by ...` spelling.
 * `source-block-output-privacy.test.mjs` builds a real comment-bearing DOCX and drives the
 * real parser + CLI, so a parser spelling change makes the sentinel identity reappear and
 * fails the gate. Once recognized, no substring copied from the identity-bearing value
 * survives the projection.
 */

const COMMENT_PREFIX = "comment by ";
const RESOLUTION_RECORDED = "resolution recorded in the document but not read here";
const RESOLUTION_UNKNOWN = "resolution unknown";

export function isIdentityBearingCommentOrigin(origin) {
  return typeof origin === "string" && origin.startsWith(COMMENT_PREFIX);
}

export function operatorSafeSourceOrigin(origin) {
  if (!isIdentityBearingCommentOrigin(origin)) return origin;

  const resolution = origin.endsWith(RESOLUTION_RECORDED)
    ? RESOLUTION_RECORDED
    : origin.endsWith(RESOLUTION_UNKNOWN)
      ? RESOLUTION_UNKNOWN
      : "resolution state unavailable at this output boundary";
  return `comment — PROPOSAL, reviewer identity withheld; ${resolution}`;
}

export function operatorSourceBlock(block) {
  return {
    blockId: block.blockId,
    kind: block.kind,
    origin: operatorSafeSourceOrigin(block.origin),
    section: block.section,
    coords: block.coords,
    utf16Length: block.text.length,
    text: block.text,
  };
}
