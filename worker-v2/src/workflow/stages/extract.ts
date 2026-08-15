/**
 * THE EXTRACTION STAGE — the Workflow's four extraction steps, for real.
 *
 * Until now `extract-pass-a-global`, `extract-pass-b-blocks`, `source-ledger` and
 * `extraction-diff` returned `not-evaluated`, the seal refused (correctly) to seal over
 * them, and every real submission died at `empty-contract`. This module is what those steps
 * now do:
 *
 *   pass A   whole-document, cross-cutting rules            (Grok)
 *   pass B   block-by-block against a construct checklist   (DeepSeek, chunked + persisted)
 *   ledger   every source block accounted for, or named as unaccounted
 *   diff     what each pass missed, what they read differently, what a browser cannot check
 *
 * TWO PASSES THAT DIFFER IN METHOD, NOT ONLY IN MODEL (owner ruling). Running one model
 * twice would agree with itself; the point of the second pass is that its READING STRATEGY
 * cannot make the first one's mistake.
 *
 * EVERY STEP RETURNS A SMALL SUMMARY AND WRITES ITS PAYLOAD TO R2. A Workflow step result
 * is durable state carried between steps; putting 119 requirements with verbatim quotes in
 * one is how a step result stops fitting. The payload lands under the run's extraction
 * prefix, and the next step reads it back by key.
 *
 * A STAGE THAT DID NOT RUN RETURNS `not-evaluated`, NOT AN EMPTY RESULT — `workflow/gates.ts`
 * explains why at length, and this module is the first code that has to honour it with real
 * work behind it.
 */

import type { Env } from "../../types/env";
import { num } from "../../types/env";
import { extractionDiffKey, extractionPassKey, k, sourceLedgerKey } from "../../keys";
import { canonicalJson, sha256Hex } from "../../store/hash";
import { type Fence } from "../../store/checkpoint";
import { pushModelUsageStrict, modelUsage } from "../../store/usage";
import {
  recordProviderSpend,
  type ProviderName,
} from "../../store/provider-spend-ledger";
import { docxBlocksVersion, parseDocxBlocks } from "../../extract/docx-blocks";
import {
  DOCUMENT_SEMANTICS_NONE,
  type DocumentSemanticsProfile,
} from "../../extract/document-semantics";
import { MissingCredential } from "../../llm/chat";
import { deepseekPassBIdentity } from "../../llm/deepseek";
import { grokFlashRouteIdentity, grokRateAttestation } from "../../llm/grok";
import { EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED } from "../../llm/extraction-wire";
import {
  runPassA,
  PASS_A_VERSION,
  reconstructPassACompletedAuthority,
  type CrossRef,
  type PassAProviderIndependence,
  type PassASlice,
  type PassASliceOptions,
} from "../../extract/pass-a";
import {
  runPassB,
  PASS_B_VERSION,
  passBCompletionProjection,
  passBCompletionShapeClosed,
  reconstructPassBCompletedAuthority,
  type PassBSlice,
  type PassBSliceOptions,
} from "../../extract/pass-b";
import { mergePasses, MERGE_VERSION, type ExtractionDiff, type SourceLedger } from "../../extract/merge";
import { expandFloor, EXPANDER_VERSION, type ExpansionCoverage, type ExpansionPreviewEntry } from "../../extract/expand";
import { CONSTRUCT_CLASSES, type CallUsage, type ParsedDocument, type PassResult } from "../../extract/types";
import { limitationsFromPassAPayload } from "../../../shared/cross-window-limitations.mjs";
import { primaryGroundingLimitationsFromPassAPayload } from "../../../shared/pass-a-grounding-limitations.mjs";
import type { FacetInstance, ScopedRequirement } from "../../types/record";
import { stageEvaluated, stageNotEvaluated, type GateProof, type StageResult } from "../gates";
import {
  publicExtractionFailureDetail,
  sourceContextForUnit,
  type DocumentReadingSourceContext,
  type DocumentReadingUnitStartObserver,
} from "../../observability/document-reading";

export const mergedKey = (runId: string) => k("runs", runId, "extraction", "merged.json");
export const previewKey = (runId: string) => k("runs", runId, "extraction", "expansion-preview.json");
export const extractionDocumentName = (documentKey: string, documentSha256: string): string =>
  `${documentKey.split("/").pop() ?? "questionnaire.docx"} ` +
  `(sha256 ${documentSha256.slice(0, 12)}…)`;

export interface PassSummary {
  hash: string;
  requirementCount: number;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failedUnits: number;
  provider: string;
  model: string;
  /** Null for pass B; pass A names whether the two-provider reading remained independent. */
  providerIndependence: PassAProviderIndependence | null;
}

export interface ConsolidationSummary {
  mergedHash: string;
  ledgerHash: string;
  diffHash: string;
  previewHash: string;
  requirementCount: number;
  executionCaseCount: number;
  unexplainedNormativeBlocks: number;
  unresolvableDisagreements: number;
  undispositionedConstructs: string[];
  unpreviewedRequirements: number;
  diffSummary: string[];
  /**
   * THE CEILING ON WHAT ANY VERIFIER CAN EVER DECIDE FOR THIS DOCUMENT.
   *
   * `executionCaseCount` counts what must be tested; this counts how many of those carry
   * an expectation a model-free predicate can decide at all, and names the reason for
   * every one that does not. Reported per run because an arm's verified count means
   * nothing without it: 30 of 220 against a ceiling of 30 is complete, and 30 of 220
   * against a ceiling of 180 is not, and the two are indistinguishable from the numerator.
   */
  expansionCoverage: ExpansionCoverage;
}

export interface MergedPayload {
  schemaVersion: "v2-extraction-merged/1.0.0" | "v2-extraction-merged/1.1.0" | "v2-extraction-merged/1.2.0";
  documentSha256: string;
  /** Exact completed-pass bytes whose strict unit authority this merge was derived from. */
  inputAuthority: { passAHash: string; passBHash: string };
  requirements: ScopedRequirement[];
  facetInstances: FacetInstance[];
  preview: ExpansionPreviewEntry[];
  diff: ExtractionDiff;
  ledger: SourceLedger;
  constructs: { dispositioned: string[]; undispositioned: string[] };
  versions: { parser?: string; passA: string; passB: string; merge: string; expander: string };
}

const proof = (evaluatorId: string, evaluatorVersion: string, inputHash: string): GateProof => ({
  evaluatorId,
  evaluatorVersion,
  inputHash,
  observedAt: new Date().toISOString(),
});

/** Public run/checkpoint reason code for a document object that no longer binds its envelope. */
export const DOCUMENT_SOURCE_AUTHORITY_INVALID = "extraction-document-source-authority-invalid";

export class DocumentSourceAuthorityFailure extends Error {
  constructor(readonly detail: string) {
    super(`${DOCUMENT_SOURCE_AUTHORITY_INVALID}: ${detail}`);
    this.name = DOCUMENT_SOURCE_AUTHORITY_INVALID;
  }
}

/** Convert only an intentional source-authority refusal; transient R2/runtime faults retry. */
export function documentSourceAuthorityDetail(error: unknown): string {
  if (error instanceof DocumentSourceAuthorityFailure) return error.message;
  throw error;
}

export interface VerifiedDocumentSource {
  doc: ParsedDocument;
  /** Lowercase SHA-256 of the exact R2 bytes that were parsed, without a scheme prefix. */
  rawSha256: string;
}

export interface VerifiedDocumentBytes {
  bytes: Uint8Array;
  rawSha256: string;
}

/**
 * Verify current source bytes without parsing them. Reuse adoption and final sealing need
 * byte authority but must not pay for an unnecessary ZIP parse.
 *
 * Hash BEFORE parse and compare against the durable envelope hash. Parsing can deliberately
 * ignore package parts, ZIP metadata and other non-semantic bytes; therefore equal parsed
 * blocks are not evidence that the stored source is still the submitted source.
 */
export async function verifyDocumentSourceBytes(
  env: Env,
  documentKey: string,
  expectedDocumentSha256: string,
): Promise<VerifiedDocumentBytes> {
  const expectedRawSha256 = expectedDocumentSha256.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(expectedRawSha256)) {
    throw new DocumentSourceAuthorityFailure(
      "the durable envelope document SHA-256 is missing or malformed; no source bytes were parsed",
    );
  }
  const obj = await env.EVIDENCE.get(documentKey);
  if (!obj) {
    throw new DocumentSourceAuthorityFailure(
      `the submitted document is missing from storage at ${documentKey}. Extraction has no source of truth to read, ` +
        `and an extraction with no document would produce a denominator out of nothing.`,
    );
  }
  const maxDocumentBytes = Math.max(1, num(env.MAX_DOCUMENT_BYTES, 25 * 1024 * 1024));
  if (obj.size > maxDocumentBytes) {
    throw new DocumentSourceAuthorityFailure(
      `the current document object is ${obj.size} bytes, above MAX_DOCUMENT_BYTES=${maxDocumentBytes}; ` +
        "it was refused before buffering or parsing",
    );
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actualRawSha256 = await sha256Hex(bytes);
  if (actualRawSha256 !== expectedRawSha256) {
    throw new DocumentSourceAuthorityFailure(
      `the current document bytes do not match the durable submitted source (expected sha256:${expectedRawSha256}, ` +
        `got sha256:${actualRawSha256}). No extraction, reuse, merge, or seal authority was granted.`,
    );
  }
  return { bytes, rawSha256: actualRawSha256 };
}

/** Verify exact current bytes, then parse those SAME bytes into addressable blocks. */
export async function loadDocument(
  env: Env,
  documentKey: string,
  expectedDocumentSha256: string,
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): Promise<VerifiedDocumentSource> {
  const verified = await verifyDocumentSourceBytes(
    env, documentKey, expectedDocumentSha256,
  );
  try {
    return {
      doc: parseDocxBlocks(verified.bytes, { documentSemanticsProfile }),
      rawSha256: verified.rawSha256,
    };
  } catch (error) {
    throw new DocumentSourceAuthorityFailure(
      `the hash-bound submitted DOCX could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Fold a pass's model-call telemetry into the run's usage ledger.
 *
 * ONE WRITER PER COUNTER. This used to increment `modelCalls.used` and `cost.usedUsd`
 * ITSELF and then call `pushUsage`, which increments exactly the same two counters for
 * every `model-call` event it appends — so every extraction call was counted twice and
 * CHARGED twice. A run therefore reached CAP_MODEL_CALLS and the extraction budget fraction
 * at half the real work, and the cost line described a run that never happened. Caught by
 * `tools/tests/d21-passb-waves.test.mjs`, which asserts the ledger against the number of
 * calls the transport stub actually saw.
 */
async function chargeUsage(env: Env, runId: string, calls: CallUsage[], fence: Fence): Promise<void> {
  if (calls.length === 0) return;
  await pushModelUsageStrict(
    env,
    runId,
    fence,
    calls.map((c) => modelUsage(c.model, c.inputTokens, c.outputTokens, c.costUsd, c.eventId)),
  );
  // RECORD each provider's spend into the cumulative cross-run ledger. This is
  // AFTER the per-run settlement above, using the SAME USD figure the run ledger
  // records. A ledger write failure becomes a named, counted limitation — loud,
  // never silent, never fatal to the run.
  const KNOWN: Set<string> = new Set(["grok", "deepseek", "gemini"]);
  for (const c of calls) {
    if (!KNOWN.has(c.provider)) continue;
    const result = await recordProviderSpend(env.EVIDENCE, {
      provider: c.provider as ProviderName,
      costUsd: c.costUsd,
      model: c.model,
      runId,
      eventId: c.eventId ?? c.callId,
    });
    if (result === null) {
      // Recording failed. This is a named limitation, not a fatal error.
      // The run continues with its per-run ledger intact. Log the failure
      // so it is visible in operational monitoring.
      console.error(
        `provider-spend-ledger: failed to record ${c.provider} spend ` +
          `$${c.costUsd} for run ${runId} event ${c.eventId ?? c.callId}`,
      );
    }
  }
}

const summarize = (result: PassResult, hash: string): PassSummary => ({
  hash,
  requirementCount: result.requirements.length,
  callCount: result.calls.length,
  inputTokens: result.calls.reduce((n, c) => n + c.inputTokens, 0),
  outputTokens: result.calls.reduce((n, c) => n + c.outputTokens, 0),
  costUsd: Math.round(result.calls.reduce((n, c) => n + c.costUsd, 0) * 1e6) / 1e6,
  failedUnits: result.failedUnits.length,
  provider: result.provider,
  model: result.model,
  providerIndependence:
    "providerIndependence" in result
      ? (result as PassResult & { providerIndependence: PassAProviderIndependence }).providerIndependence
      : null,
});

/**
 * PASS A — the whole-window walk, with no deadline.
 *
 * This is the shape the DEV extraction endpoint wants (a plain request has no Workflow step
 * around it to time out) and the shape every caller had before slicing. The Workflow uses
 * `stagePassASlice` instead.
 */
export async function stagePassA(
  env: Env,
  runId: string,
  documentKey: string,
  documentName: string,
  fence: Fence,
  documentSemanticsProfile: DocumentSemanticsProfile,
  expectedDocumentSha256: string,
): Promise<StageResult<PassSummary>> {
  const { result } = await stagePassASlice(
    env,
    runId,
    documentKey,
    documentName,
    fence,
    async () => {},
    {},
    documentSemanticsProfile,
    expectedDocumentSha256,
  );
  return result;
}

/** What one wave of pass A did, and whether the Workflow may stop making waves. */
export interface PassASliceOutcome {
  result: StageResult<PassSummary>;
  slice: PassASlice;
  /** Stop making waves even when unread windows remain; terminal is not the same as complete. */
  terminal: boolean;
  /** Exact durable failed unit when the slice retained one; never parsed from prose. */
  failedUnit?: PassResult["failedUnits"][number] | null;
  failedUnitSourceContext?: DocumentReadingSourceContext | null;
}

const PASS_A_COMPLETION_KEYS = [
  "parserVersion", "promptVersion", "pass", "provider", "model", "providerRouteIdentity",
  "providerIndependence", "routeReceipts", "fallbackTriggers", "requirements", "ambiguities",
  "unverifiable", "dispositions", "constructs", "failedUnits", "calls", "crossRefs",
  "crossWindowLimitations", "primaryGroundingLimitations", "slice", "issuedCalls", "accountingCalls",
] as const;

const passACompletionProjection = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of PASS_A_COMPLETION_KEYS) out[key] = value[key];
  return out;
};

const passACompletionShapeClosed = (value: Record<string, unknown>): boolean =>
  Object.keys(value).length === PASS_A_COMPLETION_KEYS.length &&
  PASS_A_COMPLETION_KEYS.every((key) => Object.hasOwn(value, key)) &&
  [
    "routeReceipts", "fallbackTriggers", "requirements", "ambiguities", "unverifiable",
    "dispositions", "constructs", "failedUnits", "calls", "crossRefs", "crossWindowLimitations",
    "primaryGroundingLimitations",
    "issuedCalls", "accountingCalls",
  ].every((key) => Array.isArray(value[key]));

export async function validatePassAContinuationAuthority(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  expectedPassAHash: string,
): Promise<StageResult<PassSummary>> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedPassAHash)) {
    return stageNotEvaluated<PassSummary>(
      "PASS_A_COMPLETION_ARTIFACT_INVALID",
      "PASS_A_COMPLETED_ARTIFACT_INVALID: a durable evaluated Pass-A hash is required before any continuation.",
    );
  }
  const obj = await env.EVIDENCE.get(extractionPassKey(runId, "a"));
  if (!obj) {
    return stageNotEvaluated<PassSummary>(
      "PASS_A_COMPLETION_ARTIFACT_INVALID",
      "PASS_A_COMPLETED_ARTIFACT_INVALID: durable Pass-A completion bytes are missing.",
    );
  }
  const actual = `sha256:${await sha256Hex(await obj.arrayBuffer())}`;
  if (actual !== expectedPassAHash) {
    return stageNotEvaluated<PassSummary>(
      "PASS_A_COMPLETION_ARTIFACT_INVALID",
      `PASS_A_COMPLETED_ARTIFACT_INVALID: durable Pass-A hash ${expectedPassAHash} no longer binds ` +
        `current bytes ${actual}. No Pass-B purchase is authorized.`,
    );
  }
  return await readPassPayload(
    env, runId, "a", doc.parserVersion ?? docxBlocksVersion(DOCUMENT_SEMANTICS_NONE), documentName, doc,
  ) ??
    stageNotEvaluated<PassSummary>(
      "PASS_A_COMPLETION_ARTIFACT_INVALID",
      "PASS_A_COMPLETED_ARTIFACT_INVALID: the retained completion bytes do not exactly match " +
        "current window/synthesis authority. No Pass-B purchase is authorized.",
    );
}

async function validatePassBCompletionAuthority(
  env: Env,
  runId: string,
  doc: ParsedDocument,
  documentName: string,
  expectedPassBHash: string,
): Promise<StageResult<PassSummary>> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedPassBHash)) {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      "PASS_B_COMPLETED_ARTIFACT_INVALID: a durable evaluated Pass-B hash is required before consolidation.",
    );
  }
  const obj = await env.EVIDENCE.get(extractionPassKey(runId, "b"));
  if (!obj) {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      "PASS_B_COMPLETED_ARTIFACT_INVALID: durable Pass-B completion bytes are missing.",
    );
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const actualHash = `sha256:${await sha256Hex(bytes)}`;
  if (actualHash !== expectedPassBHash) {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      `PASS_B_COMPLETED_ARTIFACT_INVALID: durable Pass-B hash ${expectedPassBHash} no longer binds ` +
        `current bytes ${actualHash}. Consolidation is not authorized.`,
    );
  }
  const authority = await reconstructPassBCompletedAuthority(env, runId, doc, documentName);
  if (authority.kind !== "ok") {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      publicExtractionFailureDetail("PASS_B_COMPLETION_ARTIFACT_INVALID"),
    );
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("root");
    parsed = value as Record<string, unknown>;
  } catch {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      "PASS_B_COMPLETED_ARTIFACT_INVALID: durable completion JSON is malformed.",
    );
  }
  const expected = JSON.parse(authority.body) as Record<string, unknown>;
  if (
    !passBCompletionShapeClosed(parsed) ||
    canonicalJson(passBCompletionProjection(parsed)) !== canonicalJson(passBCompletionProjection(expected))
  ) {
    return stageNotEvaluated(
      "PASS_B_COMPLETION_ARTIFACT_INVALID",
      "PASS_B_COMPLETED_ARTIFACT_INVALID: completion projection differs from strict unit reconstruction.",
    );
  }
  return stageEvaluated(
    { ...summarize(authority.value, authority.hash), costUsd: 0 },
    proof("extract-pass-b", PASS_B_VERSION, authority.hash),
  );
}

/**
 * ONE WAVE OF PASS A — bounded by a wall-clock budget, resumable per WINDOW, and honest
 * about being incomplete.
 *
 * THREE PROPERTIES THIS FUNCTION EXISTS TO HOLD, each closing a defect the pass-B fix
 * proved out and this pass still carried:
 *
 * 1. THE PASS PAYLOAD IS WRITTEN ONLY WHEN EVERY WINDOW IS ACCOUNTED FOR. `stageConsolidate`
 *    reads `extraction/pass-a.json` and merges whatever it finds with no way to tell a whole
 *    read from a partial one. A half-windowed document persisted under that key would seal a
 *    denominator over the windows that happened to fit in one step — and pass A's whole
 *    purpose is the survey-scoped rule that only ONE window may contain. So an unfinished
 *    wave returns `not-evaluated` and writes NOTHING under the pass key.
 *
 * 2. THE LEDGER IS CHARGED FOR CALLS THIS WAVE BOUGHT, NEVER FOR WINDOWS IT RECLAIMED.
 *    `chargeUsage` increments `modelCalls.used` per row, and a reclaimed window carries a row
 *    (with cost zeroed) so the payload keeps its telemetry.
 *
 * 3. THE EMPTY-PASS REFUSAL IS JUDGED ON A COMPLETE PASS ONLY. "No requirements and some
 *    unit failed" is a real refusal — but asserting it over a pass that has not finished
 *    reading would turn a budget boundary into a fatal error with the wrong name.
 */
export async function stagePassASlice(
  env: Env,
  runId: string,
  documentKey: string,
  documentName: string,
  fence: Fence,
  beat: (msg: string) => Promise<void>,
  options: PassASliceOptions,
  documentSemanticsProfile: DocumentSemanticsProfile,
  expectedDocumentSha256: string,
  onUnitStart?: DocumentReadingUnitStartObserver,
): Promise<PassASliceOutcome> {
  const settled = (result: StageResult<PassSummary>): PassASliceOutcome => ({
    result,
    // Nothing further can be done for this pass, so the wave loop must stop rather than
    // spend its whole step budget re-discovering the same missing credential.
    slice: {
      done: true, windowsTotal: 0, windowsLanded: 0, windowsIssued: 0,
      windowsRemaining: 0, terminalFailure: false, deadlineHit: false,
    },
    terminal: true,
  });

  // RESUME AT THE PASS, NOT ONLY AT THE WINDOW. If a previous attempt already landed the
  // whole payload, re-reading it is strictly better than re-walking the windows.
  const expectedParserVersion = docxBlocksVersion(documentSemanticsProfile);
  let doc: ParsedDocument;
  try {
    ({ doc } = await loadDocument(
      env, documentKey, expectedDocumentSha256, documentSemanticsProfile,
    ));
  } catch (error) {
    return {
      result: stageNotEvaluated<PassSummary>(
        DOCUMENT_SOURCE_AUTHORITY_INVALID,
        documentSourceAuthorityDetail(error),
      ),
      slice: {
        done: false,
        windowsTotal: 0,
        windowsLanded: 0,
        windowsIssued: 0,
        windowsRemaining: 0,
        terminalFailure: true,
        synthesisState: "waiting-for-windows",
        synthesisAttempts: 0,
        synthesisIssued: 0,
        deadlineHit: false,
      },
      terminal: true,
    };
  }
  const existingPassObject = await env.EVIDENCE.get(extractionPassKey(runId, "a"));
  const already = await readPassPayload(
    env, runId, "a", expectedParserVersion, documentName, doc,
  );
  if (already) {
    if (
      already.state === "evaluated" &&
      already.value.providerIndependence === "reduced-same-provider-fallback"
    ) {
      return settled(stageNotEvaluated<PassSummary>(
        "REDUCED_PROVIDER_INDEPENDENCE",
        "The retained completed Pass-A payload used DeepSeek Flash after a receipted Grok failure. " +
          "Pass B is DeepSeek Pro, so reusing that payload cannot restore provider-family independence. " +
          "No Pass-B purchase was authorized.",
      ));
    }
    return settled(already);
  }

  // A PRESENT current-version completion key that failed strict reconstruction is not a
  // cache miss. Rebuilding would overwrite paid authority and could launder deleted rows.
  if (existingPassObject) {
    const authority = await reconstructPassACompletedAuthority(env, runId, doc, documentName);
    const slice = authority.kind === "invalid" ? authority.slice : authority.value.slice;
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_A_COMPLETION_ARTIFACT_INVALID",
        publicExtractionFailureDetail("PASS_A_COMPLETION_ARTIFACT_INVALID"),
      ),
      slice,
      terminal: true,
    };
  }

  try {
    await grokRateAttestation(env);
  } catch (err) {
    return settled(stageNotEvaluated<PassSummary>(
      "GROK_RATE_UNATTESTED",
      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,
    ));
  }
  // `runPassA` serializes and checks every possible primary body before its provider client
  // resolves a secret; synthesis does the same once its retained candidate context exists.
  // A missing binding therefore surfaces only after the no-purchase wire boundary has run.
  let result: Awaited<ReturnType<typeof runPassA>>;
  try {
    result = await runPassA(env, runId, doc, documentName, beat, options, onUnitStart);
  } catch (error) {
    if (error instanceof MissingCredential) {
      return settled(missingCredentialResult("grok", error) as StageResult<PassSummary>);
    }
    throw error;
  }
  // THE LEDGER IS CHARGED FOR WHAT THIS WAVE BOUGHT, never for the windows it reclaimed —
  // those carry a telemetry row with cost zeroed so the payload keeps its provenance, and
  // charging them once per wave would walk a large document into CAP_MODEL_CALLS on calls
  // nobody ever made.
  await chargeUsage(env, runId, result.accountingCalls, fence);

  if (result.credentialRefusal !== undefined) {
    const first = result.failedUnits[0] ?? null;
    return {
      result: stageNotEvaluated<PassSummary>(
        result.credentialRefusal.reason,
        `${result.credentialRefusal.binding} is not available to this Worker after all eligible ` +
          `request bodies passed preflight. No new provider request was issued.`,
      ),
      slice: result.slice,
      terminal: true,
      failedUnit: first,
      failedUnitSourceContext: sourceContextForUnit(doc.blocks, first?.blockIds ?? []),
    };
  }

  if (result.providerIndependence === "reduced-same-provider-fallback") {
    // This authority is terminal even when later windows were intentionally left unread:
    // configured Pass B is already ineligible, so buying those windows cannot produce a
    // sealable run. Refuse before the ordinary incomplete-slice branch.
    return {
      result: stageNotEvaluated<PassSummary>(
        "REDUCED_PROVIDER_INDEPENDENCE",
        "Grok pass A landed a receipted DeepSeek Flash substitute. " +
        "Pass B is DeepSeek Pro, so buying it cannot restore the required provider-family independence. " +
        `The per-window evidence and charged usage are retained: ${result.slice.windowsLanded} of ` +
        `${result.slice.windowsTotal} window(s) landed and ${result.slice.windowsRemaining} remain unread. ` +
        "No final Pass-A payload was persisted and no Pass-B purchase was authorized.",
      ),
      slice: result.slice,
      terminal: true,
    };
  }

  if (result.slice.terminalFailure) {
    const first = result.failedUnits[0] ?? {
      unit: result.slice.synthesisState === "failed" ? "A-synthesis" : "A-unknown",
      blockIds: [],
      detail: "the terminal Pass-A unit did not retain a detailed failure row",
    };
    if (result.terminalReasonCode === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED) {
      return {
        result: stageNotEvaluated<PassSummary>(
          EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED,
          publicExtractionFailureDetail(EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED),
        ),
        slice: result.slice,
        terminal: true,
        failedUnit: first,
        failedUnitSourceContext: sourceContextForUnit(doc.blocks, first.blockIds),
      };
    }
    if (result.slice.synthesisState === "failed" || first.unit === "A-synthesis") {
      return {
        result: stageNotEvaluated<PassSummary>(
          "PASS_A_SYNTHESIS_FAILURE",
          publicExtractionFailureDetail("PASS_A_SYNTHESIS_FAILURE"),
        ),
        slice: result.slice,
        terminal: true,
        failedUnit: first,
        failedUnitSourceContext: sourceContextForUnit(doc.blocks, first.blockIds),
      };
    }
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_A_WINDOW_FAILURES",
        publicExtractionFailureDetail("PASS_A_WINDOW_FAILURES"),
      ),
      slice: result.slice,
      terminal: true,
      failedUnit: first,
      failedUnitSourceContext: sourceContextForUnit(doc.blocks, first.blockIds),
    };
  }

  const wholeDocumentRead = result.slice.done;
  if (!wholeDocumentRead) {
    const reconciliationPending =
      result.slice.windowsRemaining === 0 &&
      result.slice.synthesisState === "pending";
    const detail = reconciliationPending
      ? `pass A read all ${result.slice.windowsTotal} primary window(s), but the separately bounded ` +
        `cross-window reconciliation unit remains pending after this wave. No final pass-A payload is ` +
        `persisted until that unit lands; concatenated window-local answers cannot stand in for ` +
        `relationships whose evidence crosses a window boundary.`
      : `pass A has ${result.slice.windowsRemaining} of ${result.slice.windowsTotal} window(s) still owed after ` +
        `this wave. Nothing is persisted under the pass key until the whole document has been read: a partial ` +
        `pass A merged as if it were complete would claim the document contains no cross-cutting rule that only ` +
        `an unread window states.`;
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_A_INCOMPLETE",
        detail,
      ),
      slice: result.slice,
      terminal: false,
    };
  }

  if (result.failedUnits.length > 0) {
    throw new Error(publicExtractionFailureDetail("PASS_A_WINDOW_FAILURES"));
  }

  const authority = await reconstructPassACompletedAuthority(env, runId, doc, documentName);
  if (authority.kind === "invalid") {
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_A_COMPLETION_ARTIFACT_INVALID",
        publicExtractionFailureDetail("PASS_A_COMPLETION_ARTIFACT_INVALID"),
      ),
      slice: authority.slice,
      terminal: true,
    };
  }
  const payload = {
    parserVersion: doc.parserVersion,
    promptVersion: PASS_A_VERSION,
    ...authority.value,
  };
  const body = JSON.stringify(payload, null, 2);
  const passKey = extractionPassKey(runId, "a");
  const written = await env.EVIDENCE.put(passKey, body, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) {
    const existing = await env.EVIDENCE.get(passKey);
    if (existing === null || await existing.text() !== body) {
      return {
        result: stageNotEvaluated<PassSummary>(
          "PASS_A_COMPLETION_ARTIFACT_INVALID",
          "PASS_A_COMPLETED_ARTIFACT_IMMUTABLE: the completion key already exists with different bytes. " +
            "The existing authority was not overwritten and no Pass-B purchase was authorized.",
        ),
        slice: authority.value.slice,
        terminal: true,
      };
    }
  }
  const hash = `sha256:${await sha256Hex(body)}`;

  return {
    result: stageEvaluated(summarize(authority.value, hash), proof("extract-pass-a", PASS_A_VERSION, hash)),
    slice: authority.value.slice,
    terminal: true,
  };
}

/**
 * PASS B — chunked block walk, each chunk persisted the moment it returns.
 *
 * The whole fan-out, in one call, with no deadline. This is the shape the DEV extraction
 * endpoint wants (a plain request has no Workflow step around it to time out) and the shape
 * every caller had before slicing. The Workflow uses `stagePassBSlice` instead.
 */
export async function stagePassB(
  env: Env,
  runId: string,
  documentKey: string,
  documentName: string,
  fence: Fence,
  beat: (msg: string) => Promise<void>,
  documentSemanticsProfile: DocumentSemanticsProfile,
  expectedPassAHash: string,
  expectedDocumentSha256: string,
): Promise<StageResult<PassSummary>> {
  const { result } = await stagePassBSlice(
    env,
    runId,
    documentKey,
    documentName,
    fence,
    beat,
    {},
    documentSemanticsProfile,
    expectedPassAHash,
    expectedDocumentSha256,
  );
  return result;
}

/** What one wave of pass B did, and whether the Workflow may stop making waves. */
export interface PassBSliceOutcome {
  result: StageResult<PassSummary>;
  slice: PassBSlice;
  /** Exact durable failed unit when the slice retained one; never parsed from prose. */
  failedUnit?: PassResult["failedUnits"][number] | null;
  failedUnitSourceContext?: DocumentReadingSourceContext | null;
}

/**
 * ONE WAVE OF PASS B — bounded by a wall-clock budget, resumable, and honest about being
 * incomplete.
 *
 * TWO PROPERTIES THIS FUNCTION EXISTS TO HOLD, and each one closes a measured defect:
 *
 * 1. THE PASS PAYLOAD IS WRITTEN ONLY WHEN THE PASS IS FINISHED. `stageConsolidate` reads
 *    `extraction/pass-b.json` and merges whatever it finds without any way to tell a whole
 *    read from a partial one. A half-walked document persisted under that key would seal a
 *    denominator over the chunks that happened to fit in one step — a silently shorter
 *    answer, which is the exact failure the source ledger exists to make impossible. So an
 *    unfinished wave returns `not-evaluated` and writes NOTHING.
 *
 * 2. THE LEDGER IS CHARGED FOR CALLS THIS WAVE BOUGHT, NEVER FOR CHUNKS IT REUSED.
 *    `chargeUsage` increments `modelCalls.used` per row, and a reused chunk carries a row
 *    (with cost zeroed) so the payload keeps its telemetry. Charging those rows once per
 *    wave would walk a large document into CAP_MODEL_CALLS on calls nobody made.
 */
export async function stagePassBSlice(
  env: Env,
  runId: string,
  documentKey: string,
  documentName: string,
  fence: Fence,
  beat: (msg: string) => Promise<void>,
  options: PassBSliceOptions,
  documentSemanticsProfile: DocumentSemanticsProfile,
  expectedPassAHash: string,
  expectedDocumentSha256: string,
  onUnitStart?: DocumentReadingUnitStartObserver,
): Promise<PassBSliceOutcome> {
  const settled = (result: StageResult<PassSummary>): PassBSliceOutcome => ({
    result,
    // Nothing further can be done for this pass, so the wave loop must stop rather than
    // spend its whole step budget re-discovering the same missing credential.
    slice: {
      done: true,
      chunksTotal: 0,
      chunksLanded: 0,
      chunksIssued: 0,
      chunksRemaining: 0,
      sweepCallsIssued: 0,
      sweepRemaining: 0,
      terminalFailure: false,
      deadlineHit: false,
    },
  });

  // RESUME AT THE PASS, NOT ONLY AT THE CHUNK. Pass A has had this since it was written;
  // pass B did not, so a wave that re-entered after the pass had already finished re-read
  // every chunk from R2 and re-bought all three ledger-sweep calls at full price.
  const expectedParserVersion = docxBlocksVersion(documentSemanticsProfile);
  let doc: ParsedDocument;
  try {
    ({ doc } = await loadDocument(
      env, documentKey, expectedDocumentSha256, documentSemanticsProfile,
    ));
  } catch (error) {
    return {
      result: stageNotEvaluated<PassSummary>(
        DOCUMENT_SOURCE_AUTHORITY_INVALID,
        documentSourceAuthorityDetail(error),
      ),
      slice: {
        done: false,
        chunksTotal: 0,
        chunksLanded: 0,
        chunksIssued: 0,
        chunksRemaining: 0,
        sweepCallsIssued: 0,
        sweepRemaining: 0,
        terminalFailure: true,
        deadlineHit: false,
      },
    };
  }
  const passAAuthority = await validatePassAContinuationAuthority(
    env, runId, doc, documentName, expectedPassAHash,
  );
  if (passAAuthority.state !== "evaluated") return settled(passAAuthority);
  const existingPassObject = await env.EVIDENCE.get(extractionPassKey(runId, "b"));
  const already = await readPassPayload(env, runId, "b", expectedParserVersion, documentName, doc);
  if (already) return settled(already);
  if (existingPassObject) {
    const authority = await reconstructPassBCompletedAuthority(env, runId, doc, documentName);
    return {
      result: stageNotEvaluated(
        "PASS_B_COMPLETION_ARTIFACT_INVALID",
        publicExtractionFailureDetail("PASS_B_COMPLETION_ARTIFACT_INVALID"),
      ),
      slice: authority.kind === "invalid" ? authority.slice : authority.value.slice,
    };
  }

  let result: Awaited<ReturnType<typeof runPassB>>;
  try {
    result = await runPassB(env, runId, doc, documentName, beat, options, onUnitStart);
  } catch (error) {
    if (error instanceof MissingCredential) {
      return settled(missingCredentialResult("deepseek", error) as StageResult<PassSummary>);
    }
    throw error;
  }
  // Offer every persisted pass-B receipt to the checkpoint CAS. Stable event ids
  // make this exact across both crash windows: artifact-before-accounting settles
  // on restart, while accounting-before-step-commit dedupes on restart.
  await chargeUsage(env, runId, result.accountingCalls, fence);

  if (result.credentialRefusal !== undefined) {
    const first = result.failedUnits[0] ?? null;
    return {
      result: stageNotEvaluated<PassSummary>(
        result.credentialRefusal.reason,
        `${result.credentialRefusal.binding} is not available to this Worker after every ` +
          `canonical Pass-B request body passed preflight. No new provider request was issued.`,
      ),
      slice: result.slice,
      failedUnit: first,
      failedUnitSourceContext: sourceContextForUnit(doc.blocks, first?.blockIds ?? []),
    };
  }

  if (result.slice.terminalFailure || result.failedUnits.length > 0) {
    const reason = result.terminalReasonCode === EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED
      ? EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED
      : "PASS_B_UNIT_FAILURES";
    return {
      result: stageNotEvaluated<PassSummary>(
        reason,
        publicExtractionFailureDetail(reason),
      ),
      slice: result.slice,
      failedUnit: result.failedUnits[0] ?? null,
      failedUnitSourceContext: sourceContextForUnit(doc.blocks, result.failedUnits[0]?.blockIds ?? []),
    };
  }

  if (!result.slice.done) {
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_B_INCOMPLETE",
        `pass B has ${result.slice.chunksRemaining} of ${result.slice.chunksTotal} chunk(s) and ` +
          `${result.slice.sweepRemaining} ledger-sweep call(s) still owed after this wave. Nothing is persisted ` +
          `under the pass key until the walk is whole: a partial pass merged as if it were complete would seal a ` +
          `denominator over the chunks that happened to fit in one step.`,
      ),
      slice: result.slice,
    };
  }

  const authority = await reconstructPassBCompletedAuthority(env, runId, doc, documentName);
  if (authority.kind === "invalid") {
    return {
      result: stageNotEvaluated(
        "PASS_B_COMPLETION_ARTIFACT_INVALID",
        publicExtractionFailureDetail("PASS_B_COMPLETION_ARTIFACT_INVALID"),
      ),
      slice: authority.slice,
    };
  }
  const passKey = extractionPassKey(runId, "b");
  const written = await env.EVIDENCE.put(passKey, authority.body, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) {
    const existing = await env.EVIDENCE.get(passKey);
    if (existing === null || await existing.text() !== authority.body) {
      return {
        result: stageNotEvaluated(
          "PASS_B_COMPLETION_ARTIFACT_INVALID",
          "PASS_B_COMPLETED_ARTIFACT_IMMUTABLE: the completion key already exists with different bytes. " +
            "The existing authority was not overwritten.",
        ),
        slice: authority.value.slice,
      };
    }
  }
  return {
    result: stageEvaluated(
      summarize(authority.value, authority.hash),
      proof("extract-pass-b", PASS_B_VERSION, authority.hash),
    ),
    slice: authority.value.slice,
  };
}

/**
 * CONSOLIDATION — merge, diff, ledger and floor expansion, from the two passes' persisted
 * payloads. Deterministic: no model call happens here, so re-running it over the same two
 * payloads produces the same rows, the same ids and the same counts.
 */
export async function stageConsolidate(
  env: Env,
  runId: string,
  documentKey: string,
  documentSha256: string,
  locale: string,
  viewports: string[],
  documentSemanticsProfile: DocumentSemanticsProfile,
  documentName: string,
  expectedPassAHash: string,
  expectedPassBHash: string,
): Promise<StageResult<ConsolidationSummary>> {
  let source: VerifiedDocumentSource;
  try {
    source = await loadDocument(
      env, documentKey, documentSha256, documentSemanticsProfile,
    );
  } catch (error) {
    return stageNotEvaluated(
      DOCUMENT_SOURCE_AUTHORITY_INVALID,
      documentSourceAuthorityDetail(error),
    );
  }
  const { doc } = source;
  const continuation = await validatePassAContinuationAuthority(
    env, runId, doc, documentName, expectedPassAHash,
  );
  if (continuation.state !== "evaluated") {
    return stageNotEvaluated(continuation.reason, continuation.detail);
  }
  const passBContinuation = await validatePassBCompletionAuthority(
    env, runId, doc, documentName, expectedPassBHash,
  );
  if (passBContinuation.state !== "evaluated") {
    return stageNotEvaluated(passBContinuation.reason, passBContinuation.detail);
  }
  const passA = await readPass(env, runId, "a", doc.parserVersion, doc, documentName);
  const passB = await readPass(env, runId, "b", doc.parserVersion, doc, documentName);
  // A pass with no payload never ran. Consolidating over it would produce a ONE-pass
  // contract wearing a two-pass label — the exact claim the diff exists to make impossible
  // — so the merge does not happen and the gates are told why, in the words the report
  // will print. This is a refusal, not a crash: the run still ends with a report.
  const missing = [passA ? null : "A", passB ? null : "B"].filter(Boolean) as string[];
  if (!passA || !passB) {
    return stageNotEvaluated(
      "MISSING_PASS",
      `extraction pass ${missing.join(" and ")} left no payload, so there is nothing to consolidate. ` +
        `A contract sealed from one pass would claim an agreement that was never tested.`,
    );
  }
  if (passA.providerIndependence === "reduced-same-provider-fallback") {
    return stageNotEvaluated(
      "REDUCED_PROVIDER_INDEPENDENCE",
      "Grok pass A activated its receipted DeepSeek Flash substitute. Pass B is DeepSeek Pro, so both readings " +
        "came from one provider family. The extracted payloads are retained, but they cannot be presented as the " +
        "ordinary two-provider corroboration required to seal a contract.",
    );
  }
  const crossRefs = (passA.crossRefs ?? []) as CrossRef[];

  const { rows, requirements, diff, ledger } = await mergePasses(passA, passB, doc, crossRefs);
  const { facetInstances, preview, unpreviewed, coverage } = await expandFloor(
    rows.map((row) => ({
      requirement: row.requirement,
      expansion: row.raw.find((raw) => raw.expansion !== null)?.expansion ?? null,
    })),
    {
    locale,
    viewport: viewports[0] ?? null,
    },
  );

  const dispositioned = [...new Set(passB.constructs.map((c) => c.construct))];
  const undispositioned = CONSTRUCT_CLASSES.filter((c) => !dispositioned.includes(c));

  const merged: MergedPayload = {
    schemaVersion: "v2-extraction-merged/1.2.0",
    documentSha256: source.rawSha256,
    inputAuthority: { passAHash: expectedPassAHash, passBHash: expectedPassBHash },
    requirements,
    facetInstances,
    preview,
    diff,
    ledger,
    constructs: { dispositioned, undispositioned: [...undispositioned] },
    versions: {
      parser: doc.parserVersion,
      passA: PASS_A_VERSION,
      passB: PASS_B_VERSION,
      merge: MERGE_VERSION,
      expander: EXPANDER_VERSION,
    },
  };

  const mergedBody = JSON.stringify(merged, null, 2);
  const diffBody = JSON.stringify(diff, null, 2);
  const ledgerBody = JSON.stringify(ledger, null, 2);
  const previewBody = JSON.stringify({ expander: EXPANDER_VERSION, coverage, preview, unpreviewed }, null, 2);

  await env.EVIDENCE.put(mergedKey(runId), mergedBody, { httpMetadata: { contentType: "application/json" } });
  await env.EVIDENCE.put(extractionDiffKey(runId), diffBody, { httpMetadata: { contentType: "application/json" } });
  await env.EVIDENCE.put(sourceLedgerKey(runId), ledgerBody, { httpMetadata: { contentType: "application/json" } });
  await env.EVIDENCE.put(previewKey(runId), previewBody, { httpMetadata: { contentType: "application/json" } });

  const summary: ConsolidationSummary = {
    mergedHash: `sha256:${await sha256Hex(mergedBody)}`,
    ledgerHash: `sha256:${await sha256Hex(ledgerBody)}`,
    diffHash: `sha256:${await sha256Hex(diffBody)}`,
    previewHash: `sha256:${await sha256Hex(previewBody)}`,
    requirementCount: requirements.length,
    executionCaseCount: facetInstances.length,
    unexplainedNormativeBlocks: ledger.unexplainedNormativeBlocks,
    unresolvableDisagreements: diff.unresolvable.length,
    undispositionedConstructs: [...undispositioned],
    unpreviewedRequirements: unpreviewed.length,
    diffSummary: diff.summary,
    expansionCoverage: coverage,
  };
  return stageEvaluated(summary, proof("extract-consolidate", MERGE_VERSION, summary.mergedHash));
}

/**
 * The consolidated artifact no longer matches the bytes whose hash the durable
 * `source-ledger` step returned.
 *
 * This is deliberately distinct from "missing": a missing artifact means the step did
 * not leave its output behind, while a hash mismatch means something replaced that output
 * between approval and sealing. Treating both as null would hide the integrity failure as
 * an ordinary availability problem.
 */
export class MergedArtifactIntegrityFailure extends Error {
  constructor(readonly expectedHash: string, readonly actualHash: string) {
    super(
      `MERGED_ARTIFACT_HASH_MISMATCH: the merged extraction artifact changed after the durable ` +
        `source-ledger step approved it (expected ${expectedHash}, got ${actualHash}). Refusing to seal ` +
        `requirements or cases that the recorded ledger, diff and expansion preview did not evaluate.`,
    );
    this.name = "MergedArtifactIntegrityFailure";
  }
}

/**
 * The sealed contract's inputs, read back by the seal step.
 *
 * Production sealing supplies `expectedMergedHash`, which is the result of the completed
 * `source-ledger` Workflow step. The optional form remains for the developer inspection
 * endpoint, which reads the artifact but does not use this helper as an approval proof.
 */
export async function loadMerged(
  env: Env,
  runId: string,
  expectedMergedHash?: string,
): Promise<MergedPayload | null> {
  const obj = await env.EVIDENCE.get(mergedKey(runId));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (expectedMergedHash !== undefined) {
    const expected = `sha256:${expectedMergedHash.replace(/^sha256:/, "")}`;
    const actual = `sha256:${await sha256Hex(bytes)}`;
    if (actual !== expected) throw new MergedArtifactIntegrityFailure(expected, actual);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as MergedPayload;
}

export const EXTRACTION_SEAL_AUTHORITY_INVALID = "extraction-seal-authority-invalid";

export type ExtractionSealAuthority =
  | { kind: "ok"; merged: MergedPayload }
  | {
      kind: "invalid";
      reason: typeof EXTRACTION_SEAL_AUTHORITY_INVALID | typeof DOCUMENT_SOURCE_AUTHORITY_INVALID;
      detail: string;
    };

/**
 * Zero-purchase seal precondition.
 *
 * A cached Workflow source-ledger result cannot outlive mutation of a completed pass, any
 * of its unit artifacts, or the merged payload. Reconstruct both passes from their units,
 * bind their exact durable hashes, then require the merged bytes approved by the ledger to
 * name those same hashes. The seal consumes only the returned merged value.
 */
export async function validateExtractionSealAuthority(
  env: Env,
  runId: string,
  documentKey: string,
  documentSha256: string,
  documentSemanticsProfile: DocumentSemanticsProfile,
  documentName: string,
  expectedPassAHash: string,
  expectedPassBHash: string,
  expectedMergedHash: string,
): Promise<ExtractionSealAuthority> {
  const invalid = (
    detail: string,
    reason: typeof EXTRACTION_SEAL_AUTHORITY_INVALID | typeof DOCUMENT_SOURCE_AUTHORITY_INVALID =
      EXTRACTION_SEAL_AUTHORITY_INVALID,
  ): ExtractionSealAuthority => ({
    kind: "invalid",
    reason,
    detail: `${reason}: ${detail} No contract was sealed.`,
  });
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedMergedHash)) {
    return invalid("the durable source-ledger merged hash is missing or malformed.");
  }
  let source: VerifiedDocumentSource;
  try {
    source = await loadDocument(
      env, documentKey, documentSha256, documentSemanticsProfile,
    );
  } catch (error) {
    return invalid(
      documentSourceAuthorityDetail(error),
      DOCUMENT_SOURCE_AUTHORITY_INVALID,
    );
  }
  const { doc } = source;
  const passA = await validatePassAContinuationAuthority(
    env, runId, doc, documentName, expectedPassAHash,
  );
  if (passA.state !== "evaluated") return invalid(`${passA.reason}: ${passA.detail}`);
  const passB = await validatePassBCompletionAuthority(
    env, runId, doc, documentName, expectedPassBHash,
  );
  if (passB.state !== "evaluated") return invalid(`${passB.reason}: ${passB.detail}`);
  let merged: MergedPayload | null;
  try {
    merged = await loadMerged(env, runId, expectedMergedHash);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  if (merged === null) return invalid("the durable merged extraction payload is missing.");
  if (
    merged.documentSha256 !== source.rawSha256 ||
    typeof merged.inputAuthority !== "object" || merged.inputAuthority === null ||
    merged.inputAuthority.passAHash !== expectedPassAHash ||
    merged.inputAuthority.passBHash !== expectedPassBHash
  ) {
    return invalid(
      "the merged payload does not bind the current document and exact evaluated Pass-A/Pass-B hashes.",
    );
  }
  return { kind: "ok", merged };
}

/** A completed pass already in storage, re-summarized without a model call. */
async function readPassPayload(
  env: Env,
  runId: string,
  pass: "a" | "b",
  expectedParserVersion: string,
  documentName = "document.docx",
  parsedDocument?: ParsedDocument,
): Promise<StageResult<PassSummary> | null> {
  const obj = await env.EVIDENCE.get(extractionPassKey(runId, pass));
  if (!obj) return null;
  const body = await obj.text();
  try {
    const parsed = JSON.parse(body) as PassResult & {
      parserVersion?: unknown;
      promptVersion?: unknown;
      providerPlanIdentity?: unknown;
      providerRouteIdentity?: unknown;
      providerIndependence?: unknown;
    };
    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;
    if (parsed.parserVersion !== expectedParserVersion || parsed.promptVersion !== expectedPrompt) return null;
    if (pass === "a") {
      if (
        parsed.providerRouteIdentity !== grokFlashRouteIdentity(env) ||
        !passACompletionShapeClosed(parsed as unknown as Record<string, unknown>) ||
        !Array.isArray(parsed.failedUnits) || parsed.failedUnits.length > 0
      ) return null;
      if (!parsedDocument) return null;
      const doc = parsedDocument;
      const authority = await reconstructPassACompletedAuthority(env, runId, doc, documentName);
      if (authority.kind !== "ok") return null;
      const expected = {
        parserVersion: expectedParserVersion,
        promptVersion: PASS_A_VERSION,
        ...authority.value,
      } as unknown as Record<string, unknown>;
      if (
        canonicalJson(passACompletionProjection(parsed as unknown as Record<string, unknown>)) !==
        canonicalJson(passACompletionProjection(expected))
      ) return null;
      limitationsFromPassAPayload(parsed);
      primaryGroundingLimitationsFromPassAPayload(parsed);
    }
    if (pass === "b") {
      if (parsed.providerPlanIdentity !== deepseekPassBIdentity(env) || !parsedDocument) return null;
      const authority = await reconstructPassBCompletedAuthority(env, runId, parsedDocument, documentName);
      if (authority.kind !== "ok" || !passBCompletionShapeClosed(parsed as unknown as Record<string, unknown>)) {
        return null;
      }
      const expected = JSON.parse(authority.body) as Record<string, unknown>;
      if (
        canonicalJson(passBCompletionProjection(parsed as unknown as Record<string, unknown>)) !==
        canonicalJson(passBCompletionProjection(expected))
      ) return null;
    }
    if (!Array.isArray(parsed.requirements)) return null;
    const hash = `sha256:${await sha256Hex(body)}`;
    // costUsd is zeroed deliberately: this attempt did not spend it, and charging a run
    // twice for one call would make the cost line describe a run that never happened.
    return stageEvaluated(
      { ...summarize(parsed, hash), costUsd: 0 },
      proof(`extract-pass-${pass}`, pass === "a" ? PASS_A_VERSION : PASS_B_VERSION, hash),
    );
  } catch {
    return null;
  }
}

async function readPass(
  env: Env,
  runId: string,
  pass: "a" | "b",
  expectedParserVersion: string,
  parsedDocument?: ParsedDocument,
  documentName = "document.docx",
): Promise<(PassResult & {
  crossRefs?: CrossRef[];
  providerIndependence?: PassAProviderIndependence;
}) | null> {
  const obj = await env.EVIDENCE.get(extractionPassKey(runId, pass));
  if (!obj) return null;
  try {
    const parsed = JSON.parse(await obj.text()) as PassResult & {
      crossRefs?: CrossRef[];
      parserVersion?: unknown;
      promptVersion?: unknown;
      providerPlanIdentity?: unknown;
      providerRouteIdentity?: unknown;
      providerIndependence?: unknown;
    };
    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;
    if (parsed.parserVersion !== expectedParserVersion || parsed.promptVersion !== expectedPrompt) return null;
    if (pass === "a") {
      if (
        parsed.providerRouteIdentity !== grokFlashRouteIdentity(env) ||
        !passACompletionShapeClosed(parsed as unknown as Record<string, unknown>) ||
        !Array.isArray(parsed.failedUnits) || parsed.failedUnits.length > 0
      ) return null;
      if (!parsedDocument) return null;
      const doc = parsedDocument;
      const authority = await reconstructPassACompletedAuthority(env, runId, doc, documentName);
      if (authority.kind !== "ok") return null;
      const expected = {
        parserVersion: expectedParserVersion,
        promptVersion: PASS_A_VERSION,
        ...authority.value,
      } as unknown as Record<string, unknown>;
      if (
        canonicalJson(passACompletionProjection(parsed as unknown as Record<string, unknown>)) !==
        canonicalJson(passACompletionProjection(expected))
      ) return null;
      limitationsFromPassAPayload(parsed);
      primaryGroundingLimitationsFromPassAPayload(parsed);
    }
    if (pass === "b") {
      if (parsed.providerPlanIdentity !== deepseekPassBIdentity(env) || !parsedDocument) return null;
      const authority = await reconstructPassBCompletedAuthority(env, runId, parsedDocument, documentName);
      if (authority.kind !== "ok" || !passBCompletionShapeClosed(parsed as unknown as Record<string, unknown>)) {
        return null;
      }
      const expected = JSON.parse(authority.body) as Record<string, unknown>;
      if (
        canonicalJson(passBCompletionProjection(parsed as unknown as Record<string, unknown>)) !==
        canonicalJson(passBCompletionProjection(expected))
      ) return null;
    }
    if (!Array.isArray(parsed.requirements)) return null;
    return parsed as PassResult & {
      crossRefs?: CrossRef[];
      providerIndependence?: PassAProviderIndependence;
    };
  } catch {
    return null;
  }
}

/**
 * A MISSING CREDENTIAL IS A REPORTABLE STATE, NOT A CRASH.
 *
 * Retrying a pass twice because a binding is absent burns the retry budget and ends the run
 * in a stack trace with no report. `not-evaluated` carries no value in the successful
 * domain, so it cannot be misread as "this pass found nothing", and it falls through to the
 * seal gate — which refuses, names the gate, and lets the run report why.
 */
function missingCredentialResult(
  which: "grok" | "deepseek",
  error: MissingCredential,
): StageResult<never> {
  return stageNotEvaluated<never>(
    "NO_CREDENTIAL",
    `${error.binding} is not available to this Worker, so the ${which} extraction pass never ran. ` +
      `Extraction requires BOTH passes; one leg wearing a two-pass label is the failure the diff exists to expose.`,
  );
}

/** Budget guard: extraction must not spend the reserve set aside for verification/report. */
export function extractionBudgetExceeded(env: Env, usedUsd: number, maxUsd: number): boolean {
  return usedUsd >= maxUsd * num(env.EXTRACT_BUDGET_FRACTION, 0.5);
}
