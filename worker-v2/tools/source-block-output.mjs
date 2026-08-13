/**
 * Privacy-safe projection of parser provenance for operator-facing output.
 *
 * A DOCX comment's author and initials are review metadata, not source authority. The
 * production parser currently carries both inside `SourceBlock.origin` so its model prompt
 * can distinguish a comment from body copy. Operator catalogues do not need the identity,
 * and printing it to stdout makes a private reviewer name part of shell history, captured
 * logs, and any redirected artifact.
 *
 * This boundary keys on the parser's structural `comment-proposal` subrole, never the
 * display spelling. OPC relationships, rather than a filename or author-text convention,
 * establish that role; parser origin wording is therefore free to evolve without causing
 * reviewer identity to leak into terminal history.
 */

const RESOLUTION_RECORDED = "resolution recorded in the document but not read here";
const RESOLUTION_UNKNOWN = "resolution unknown";

export function isCommentProposalSourceBlock(block) {
  return block?.sourceSubrole === "comment-proposal";
}

export function operatorSafeSourceOrigin(block) {
  if (!isCommentProposalSourceBlock(block)) return block.origin;

  const resolution = block.origin.endsWith(RESOLUTION_RECORDED)
    ? RESOLUTION_RECORDED
    : block.origin.endsWith(RESOLUTION_UNKNOWN)
      ? RESOLUTION_UNKNOWN
      : "resolution state unavailable at this output boundary";
  return `comment — PROPOSAL, reviewer identity withheld; ${resolution}`;
}

export function operatorSourceBlock(block) {
  return {
    blockId: block.blockId,
    kind: block.kind,
    origin: operatorSafeSourceOrigin(block),
    section: block.section,
    coords: block.coords,
    utf16Length: block.text.length,
    text: block.text,
  };
}
