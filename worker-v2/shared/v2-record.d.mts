/**
 * Types for the shared v2 projection. The IMPLEMENTATION is `v2-record.mjs` — pure ESM,
 * so `pipeline/judge/lib/authority.mjs` (plain node) and the Worker's TypeScript can both
 * import the same file. This declaration exists so the Worker's call sites are type-checked
 * rather than `@ts-ignore`d into `any`, which is how a projection drifts from its consumer
 * without anything noticing.
 */

import type { ContractRevision, FacetInstance, ItemResult, RunRecordV2 } from "../src/types/record";

export const V2_RUN_RECORD_KIND: "survey-qa-v2-run-record";
export const V2_CONTRACT_REVISION_KIND: "survey-qa-v2-contract-revision";
export const V2_PROJECTION_VERSION: string;
export const CONTRACT_REVISION_ID_RE: RegExp;
export const REQUIRED_CONTRACT_GATES: readonly string[];
export const REQUIRED_HUMAN_CONTRACT_GATES: readonly string[];

export function isRunRecordV2(record: unknown): record is RunRecordV2;
export function isContractRevisionV2(revision: unknown): revision is ContractRevision;
export function withSha256Prefix(hex: string | null | undefined): string | null;

export function semanticContractBody(body: unknown): unknown;
export function contractRevisionIdFromDigest(hex: string): string;
export function contractHashFromDigest(hex: string): string;
export function contractGateFailures(gates: unknown): string[];
export function contractApprovalFailures(revision: unknown): string[];

export function contractItemFromRequirement(requirement: unknown): Record<string, unknown>;
export function liveRequirements(revision: unknown): unknown[];
export function caseLedgerRowFromFacetInstance(facetInstance: FacetInstance): Record<string, unknown>;
export function caseLedgerRows(revision: unknown): Array<Record<string, unknown>>;
export function legacyEvidenceEntry(entry: unknown): Record<string, unknown>;
export function coverageOf(result: ItemResult): string;

export class ContractRevisionMismatch extends Error {
  constructor(recordId: string | null, revisionId: string | null);
}

export function projectV2ToLegacy(record: RunRecordV2, revision: ContractRevision): Record<string, unknown>;
