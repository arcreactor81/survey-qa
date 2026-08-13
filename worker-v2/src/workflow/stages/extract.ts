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
import { sha256Hex } from "../../store/hash";
import { type Fence } from "../../store/checkpoint";
import { pushModelUsageStrict, modelUsage } from "../../store/usage";
import { docxBlocksVersion, parseDocxBlocks } from "../../extract/docx-blocks";
import {
  DOCUMENT_SEMANTICS_NONE,
  type DocumentSemanticsProfile,
} from "../../extract/document-semantics";
import { keyFor, MissingCredential } from "../../llm/chat";
import { deepseekPassBIdentity } from "../../llm/deepseek";
import { grokFlashRouteIdentity, grokRateAttestation } from "../../llm/grok";
import {
  runPassA,
  PASS_A_VERSION,
  validatePassAProviderState,
  type CrossRef,
  type PassAProviderIndependence,
  type PassASlice,
  type PassASliceOptions,
} from "../../extract/pass-a";
import { runPassB, PASS_B_VERSION, type PassBSlice, type PassBSliceOptions } from "../../extract/pass-b";
import { mergePasses, MERGE_VERSION, type ExtractionDiff, type SourceLedger } from "../../extract/merge";
import { expandFloor, EXPANDER_VERSION, type ExpansionCoverage, type ExpansionPreviewEntry } from "../../extract/expand";
import { resetDrops } from "../../extract/coerce";
import { CONSTRUCT_CLASSES, type CallUsage, type ParsedDocument, type PassResult } from "../../extract/types";
import type { FacetInstance, ScopedRequirement } from "../../types/record";
import { stageEvaluated, stageNotEvaluated, type GateProof, type StageResult } from "../gates";

export const mergedKey = (runId: string) => k("runs", runId, "extraction", "merged.json");
export const previewKey = (runId: string) => k("runs", runId, "extraction", "expansion-preview.json");

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
  schemaVersion: "v2-extraction-merged/1.0.0" | "v2-extraction-merged/1.1.0";
  documentSha256: string;
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

/** Read the submitted .docx from R2 and parse it into addressable blocks. */
export async function loadDocument(
  env: Env,
  documentKey: string,
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): Promise<ParsedDocument> {
  const obj = await env.EVIDENCE.get(documentKey);
  if (!obj) {
    throw new Error(
      `the submitted document is missing from storage at ${documentKey}. Extraction has no source of truth to read, ` +
        `and an extraction with no document would produce a denominator out of nothing.`,
    );
  }
  return parseDocxBlocks(await obj.arrayBuffer(), { documentSemanticsProfile });
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
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
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
  );
  return result;
}

/** What one wave of pass A did, and whether the Workflow may stop making waves. */
export interface PassASliceOutcome {
  result: StageResult<PassSummary>;
  slice: PassASlice;
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
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): Promise<PassASliceOutcome> {
  const settled = (result: StageResult<PassSummary>): PassASliceOutcome => ({
    result,
    // Nothing further can be done for this pass, so the wave loop must stop rather than
    // spend its whole step budget re-discovering the same missing credential.
    slice: { done: true, windowsTotal: 0, windowsLanded: 0, windowsIssued: 0, windowsRemaining: 0, deadlineHit: false },
  });

  // RESUME AT THE PASS, NOT ONLY AT THE WINDOW. If a previous attempt already landed the
  // whole payload, re-reading it is strictly better than re-walking the windows.
  const expectedParserVersion = docxBlocksVersion(documentSemanticsProfile);
  const already = await readPassPayload(env, runId, "a", expectedParserVersion);
  if (already) return settled(already);

  resetDrops();
  const doc = await loadDocument(env, documentKey, documentSemanticsProfile);
  try {
    await grokRateAttestation(env);
  } catch (err) {
    return settled(stageNotEvaluated<PassSummary>(
      "GROK_RATE_UNATTESTED",
      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,
    ));
  }
  // Validate the closed cost policy before Secrets Store get(). A missing or malformed
  // price binding is a zero-I/O configuration refusal, not permission to touch a credential.
  const credential = await credentialCheck(env, "grok");
  if (credential) return settled(credential as StageResult<PassSummary>);

  const result = await runPassA(env, runId, doc, documentName, beat, options);
  // THE LEDGER IS CHARGED FOR WHAT THIS WAVE BOUGHT, never for the windows it reclaimed —
  // those carry a telemetry row with cost zeroed so the payload keeps its provenance, and
  // charging them once per wave would walk a large document into CAP_MODEL_CALLS on calls
  // nobody ever made.
  await chargeUsage(env, runId, result.accountingCalls, fence);

  const wholeDocumentRead = result.slice.done;
  if (!wholeDocumentRead) {
    return {
      result: stageNotEvaluated<PassSummary>(
        "PASS_A_INCOMPLETE",
        `pass A has ${result.slice.windowsRemaining} of ${result.slice.windowsTotal} window(s) still owed after ` +
          `this wave. Nothing is persisted under the pass key until the whole document has been read: a partial ` +
          `pass A merged as if it were complete would claim the document contains no cross-cutting rule that only ` +
          `an unread window states.`,
      ),
      slice: result.slice,
    };
  }

  if (result.failedUnits.length > 0) {
    const first = result.failedUnits[0]!;
    const failedBlockIds = [...new Set(result.failedUnits.flatMap((unit) => unit.blockIds))];
    const blockSample = failedBlockIds.slice(0, 5);
    throw new Error(
      `PASS_A_WINDOW_FAILURES: extraction pass A could not complete a trustworthy whole-document reading because ` +
        `${result.failedUnits.length} of ${result.slice.windowsTotal} window(s) failed, covering ` +
        `${failedBlockIds.length} source block(s). Failed block sample: ${blockSample.join(', ') || 'none'}. ` +
        `First failure: ${first.unit} — ${first.detail.slice(0, 400)}. The ${result.requirements.length} ` +
        `requirement(s) returned by successful windows cannot substitute for source blocks that were not read. ` +
        `No final pass-A payload was persisted or evaluated.`,
    );
  }

  if (result.providerIndependence === "reduced-same-provider-fallback") {
    throw new Error(
      "REDUCED_PROVIDER_INDEPENDENCE: Grok pass A activated its receipted DeepSeek Flash substitute. " +
        "Pass B is DeepSeek Pro, so buying it cannot restore the required provider-family independence. " +
        "The per-window Pass-A evidence and charged usage are retained, but no final Pass-A payload was " +
        "persisted and no Pass-B purchase was authorized.",
    );
  }

  const payload = { parserVersion: doc.parserVersion, promptVersion: PASS_A_VERSION, ...result };
  const body = JSON.stringify(payload, null, 2);
  await env.EVIDENCE.put(extractionPassKey(runId, "a"), body, {
    httpMetadata: { contentType: "application/json" },
  });
  const hash = `sha256:${await sha256Hex(body)}`;

  return {
    result: stageEvaluated(summarize(result, hash), proof("extract-pass-a", PASS_A_VERSION, hash)),
    slice: result.slice,
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
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
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
  );
  return result;
}

/** What one wave of pass B did, and whether the Workflow may stop making waves. */
export interface PassBSliceOutcome {
  result: StageResult<PassSummary>;
  slice: PassBSlice;
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
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
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
      deadlineHit: false,
    },
  });

  // RESUME AT THE PASS, NOT ONLY AT THE CHUNK. Pass A has had this since it was written;
  // pass B did not, so a wave that re-entered after the pass had already finished re-read
  // every chunk from R2 and re-bought all three ledger-sweep calls at full price.
  const expectedParserVersion = docxBlocksVersion(documentSemanticsProfile);
  const already = await readPassPayload(env, runId, "b", expectedParserVersion);
  if (already) return settled(already);

  resetDrops();
  const doc = await loadDocument(env, documentKey, documentSemanticsProfile);
  const credential = await credentialCheck(env, "deepseek");
  if (credential) return settled(credential as StageResult<PassSummary>);

  const result = await runPassB(env, runId, doc, documentName, beat, options);
  // Offer every persisted pass-B receipt to the checkpoint CAS. Stable event ids
  // make this exact across both crash windows: artifact-before-accounting settles
  // on restart, while accounting-before-step-commit dedupes on restart.
  await chargeUsage(env, runId, result.accountingCalls, fence);

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

  const payload = { parserVersion: doc.parserVersion, promptVersion: PASS_B_VERSION, ...result };
  const body = JSON.stringify(payload, null, 2);
  await env.EVIDENCE.put(extractionPassKey(runId, "b"), body, {
    httpMetadata: { contentType: "application/json" },
  });
  const hash = `sha256:${await sha256Hex(body)}`;

  if (result.requirements.length === 0 && result.failedUnits.length === result.calls.length + result.failedUnits.length) {
    throw new Error(
      `extraction pass B produced no requirements and every chunk failed: ` +
        `${result.failedUnits[0]?.detail ?? "no chunk returned"}.`,
    );
  }
  return { result: stageEvaluated(summarize(result, hash), proof("extract-pass-b", PASS_B_VERSION, hash)), slice: result.slice };
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
  documentSemanticsProfile: DocumentSemanticsProfile = DOCUMENT_SEMANTICS_NONE,
): Promise<StageResult<ConsolidationSummary>> {
  const doc = await loadDocument(env, documentKey, documentSemanticsProfile);
  const passA = await readPass(env, runId, "a", doc.parserVersion);
  const passB = await readPass(env, runId, "b", doc.parserVersion);
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
    schemaVersion: "v2-extraction-merged/1.1.0",
    documentSha256,
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

/** A completed pass already in storage, re-summarized without a model call. */
async function readPassPayload(
  env: Env,
  runId: string,
  pass: "a" | "b",
  expectedParserVersion: string,
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
    if (pass === "a" && (
      parsed.providerRouteIdentity !== grokFlashRouteIdentity(env) ||
      validatePassAProviderState(parsed) === null ||
      !Array.isArray(parsed.failedUnits) ||
      parsed.failedUnits.length > 0
    )) return null;
    if (pass === "b" && parsed.providerPlanIdentity !== deepseekPassBIdentity(env)) return null;
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
    if (pass === "a" && (
      parsed.providerRouteIdentity !== grokFlashRouteIdentity(env) ||
      validatePassAProviderState(parsed) === null ||
      !Array.isArray(parsed.failedUnits) ||
      parsed.failedUnits.length > 0
    )) return null;
    if (pass === "b" && parsed.providerPlanIdentity !== deepseekPassBIdentity(env)) return null;
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
async function credentialCheck(env: Env, which: "grok" | "deepseek"): Promise<StageResult<never> | null> {
  try {
    await keyFor(env, which);
    return null;
  } catch (err) {
    if (err instanceof MissingCredential) {
      return stageNotEvaluated<never>(
        "NO_CREDENTIAL",
        `${err.binding} is not available to this Worker, so the ${which} extraction pass never ran. ` +
          `Extraction requires BOTH passes; one leg wearing a two-pass label is the failure the diff exists to expose.`,
      );
    }
    throw err;
  }
}

/** Budget guard: extraction must not spend the reserve set aside for verification/report. */
export function extractionBudgetExceeded(env: Env, usedUsd: number, maxUsd: number): boolean {
  return usedUsd >= maxUsd * num(env.EXTRACT_BUDGET_FRACTION, 0.5);
}
