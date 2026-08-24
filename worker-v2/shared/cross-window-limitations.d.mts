export const PASS_A_CROSS_WINDOW_LIMITATION_KIND: "pass-a-cross-window-candidate-dependence";
export const CROSS_WINDOW_DISCOVERY_BLOCKER_KIND: "DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE";
export const CROSS_WINDOW_LIMITATION_SUPPLEMENT_PREFIX: string;

export interface PassACrossWindowLimitationWire {
  kind: typeof PASS_A_CROSS_WINDOW_LIMITATION_KIND;
  windowsTotal: number;
  candidatesSynthesized: number;
  candidatesUngrounded: number;
  sourceEvidenceBlocks: number;
  sourceEvidenceSpans: number;
  synthesisAdditions: number;
  detail: string;
}

export interface SealedPassACrossWindowLimitation extends PassACrossWindowLimitationWire {
  passAHash: string;
}

export function validatePassACrossWindowLimitation(value: unknown): PassACrossWindowLimitationWire;
export function limitationsFromPassAPayload(payload: unknown): PassACrossWindowLimitationWire[];
export function crossWindowLimitationSupplement(value: unknown, passAHash: string): string;
export function parseCrossWindowLimitationSupplement(value: unknown): SealedPassACrossWindowLimitation | null;
export function contractCrossWindowLimitations(
  supplements: unknown,
  expectedPassAHash: string | null,
): SealedPassACrossWindowLimitation[];
export function crossWindowLimitationDetail(value: unknown): string;
/** The same limitation in the reader's words, for customer copy. Never replaces the above. */
export function crossWindowLimitationPlainDetail(value: unknown): string;
