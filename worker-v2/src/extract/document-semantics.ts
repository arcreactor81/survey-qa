/**
 * Closed, durable document-format semantics selected for one run.
 *
 * Formatting evidence is always retained. `none/1.0.0` is the safe default because grey
 * shading has no universal respondent/programming meaning. The shop profile is an explicit
 * authoring convention: only a run that declares it may derive programming roles from grey.
 */
export const DOCUMENT_SEMANTICS_NONE = "none/1.0.0" as const;
export const GREY_PROGRAMMING_PROFILE = "shop-direct-grey-programming/1.0.0" as const;

export const DOCUMENT_SEMANTICS_PROFILES = [
  DOCUMENT_SEMANTICS_NONE,
  GREY_PROGRAMMING_PROFILE,
] as const;

export type DocumentSemanticsProfile = (typeof DOCUMENT_SEMANTICS_PROFILES)[number];

export function isDocumentSemanticsProfile(value: unknown): value is DocumentSemanticsProfile {
  return typeof value === "string" && (DOCUMENT_SEMANTICS_PROFILES as readonly string[]).includes(value);
}
/** Legacy absence means neutral; every other unknown spelling is refused. */
export function normalizeDocumentSemanticsProfile(value: unknown): DocumentSemanticsProfile {
  if (value === undefined) return DOCUMENT_SEMANTICS_NONE;
  if (isDocumentSemanticsProfile(value)) return value;
  throw new Error(
    `unsupported documentSemanticsProfile ${JSON.stringify(value)}; expected one of ` +
      DOCUMENT_SEMANTICS_PROFILES.map((profile) => JSON.stringify(profile)).join(", "),
  );
}
