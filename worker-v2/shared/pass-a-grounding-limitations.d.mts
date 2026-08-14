export const PASS_A_PRIMARY_GROUNDING_LIMITATION_KIND: "pass-a-primary-candidate-ungrounded";
export const PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_KIND: "pass-a-primary-grounding-limitations/1.0.0";
export const SOURCE_GROUNDING_BLOCKER_KIND: "DOCUMENT_SOURCE_GROUNDING_INCOMPLETE";
export const PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_PREFIX: string;

export type PassAPrimaryGroundingRowKind =
  | "global-rule"
  | "cross-reference"
  | "ambiguity"
  | "unverifiable";

export type PassAPrimaryGroundingReason =
  | "source-block-ownership-invalid"
  | "source-quote-not-exact"
  | "source-evidence-set-invalid"
  | "grounded-row-linkage-incomplete";

export interface PassAPrimaryGroundingLimitationWire {
  kind: typeof PASS_A_PRIMARY_GROUNDING_LIMITATION_KIND;
  /** Runtime codec closes this to A or A-w<positive>; string keeps producer origins composable. */
  unit: string;
  rowKind: PassAPrimaryGroundingRowKind;
  rowIndex: number;
  sourceBlockIds: string[];
  reason: PassAPrimaryGroundingReason;
}

export interface SealedPassAPrimaryGroundingLimitations {
  kind: typeof PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_KIND;
  passAHash: string;
  rows: PassAPrimaryGroundingLimitationWire[];
}

export function validatePassAPrimaryGroundingLimitation(
  value: unknown,
): PassAPrimaryGroundingLimitationWire;
export function validatePassAPrimaryGroundingLimitations(
  value: unknown,
): PassAPrimaryGroundingLimitationWire[];
export function primaryGroundingLimitationsFromPassAPayload(
  payload: unknown,
): PassAPrimaryGroundingLimitationWire[];
export function primaryGroundingLimitationsSupplement(value: unknown, passAHash: string): string;
export function parsePrimaryGroundingLimitationsSupplement(
  value: unknown,
): SealedPassAPrimaryGroundingLimitations | null;
export function primaryGroundingMarkerRequiredForRevision(revision: unknown): boolean;
export function contractPrimaryGroundingLimitations(
  supplements: unknown,
  expectedPassAHash: string | null,
  revision: unknown,
): SealedPassAPrimaryGroundingLimitations | null;
export function primaryGroundingLimitationDetail(value: unknown): string;
