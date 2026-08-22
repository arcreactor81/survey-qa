/**
 * PHASE: adjudicating — the two derivations, neither of which may call a model.
 *
 * There are TWO, and conflating them is how the first run shipped a wrong verdict:
 *
 *   1. AGGREGATION (`deriveItemResults`) turns this run's own observations into ItemResults
 *      over the sealed denominator. It is arithmetic over a tri-state verifier decision.
 *      Its output goes INTO the RunRecord — it is the run's own account of itself.
 *
 *   2. JUDGEMENT (`mintJudgement`) is the INDEPENDENT re-derivation. It runs
 *      `pipeline/judge/` over the SIGNED record and the artifact bytes, recomputes every
 *      verdict from the evidence, re-reads each cited artifact a second uncached time, and
 *      mints an attested JudgementRecord. It is the report's "re-derived" column and the
 *      only thing allowed to drive CURRENT results.
 *
 * (2) must run after the record exists, because the record is its input: it binds to the
 * record's payload hash, its sealed contract revision, its target build and its evidence
 * manifest root. So the workflow order is aggregate → assemble → judge, which is the same
 * order the offline acceptance chain runs in.
 *
 * NO MODEL CALL IS PERMITTED IN EITHER. `rejectModelDerivedVerdicts` makes the prohibition
 * mechanical for (1); (2) cannot call one because the judging engine has no network.
 */

import type { Env } from "../../types/env";
import { unsettledBucketFor } from "../../types/contracts";
import { judgementKey, recordKey } from "../../keys";
import { getContractRevision } from "../../store/contract-revision";
import { ArtifactNameCollision, EngineReadBudgetExceeded, loadRunInputs, loadArtifactBytesStreaming, signingKeys, type RunInputs, type StreamingArtifactResult } from "./run-inputs";
import { stageNotEvaluated, type StageResult } from "../gates";
import { itemResultsKey } from "../../keys";
import { sha256Hex } from "../../store/hash";
import type { ItemResult } from "../../types/record";
import { filterCommittedEvidence, MissingWalkLedgerError, type CommittedEvidenceResult } from "../../store/committed-evidence";
// The execution ledger's key and shape — the committed-evidence filter needs the walk
// records and the R2 key to load them. Imported from execute-batch rather than re-spelled.
import { execProgressKey, type ExecProgress, type WalkRecord } from "./execute-batch";

// @ts-ignore -- untyped ESM, shared with the offline pipeline
import { aggregate, rejectModelDerivedVerdicts, AGGREGATOR_ID } from "./assemble-record.mjs";
// @ts-ignore -- untyped ESM
import { judgeRunInIsolate, publicRegistryFor } from "./judge-runtime.mjs";
// @ts-ignore -- untyped ESM
import { checklistFromExtraction, checklistFromRevision } from "./checklist-projection.mjs";
import { runChecklistKey, readRunChecklist } from "./checklist-store";

/**
 * The walk ledger for the committed-evidence filter, loaded the same way assemble-record
 * loads it — one keyed R2 GET, same key, same shape.
 *
 * WHY DUPLICATED. The assembler's `executionWalks` is a private function (not exported),
 * and rightly so — assemble-record.ts owns the record's walk facts. The judge needs the
 * same ledger for a DIFFERENT reason: to filter evidence before mounting it. A shared
 * helper would couple two stages whose independence is the point, so the read is restated
 * once here with the same semantics: null means "missing or unreadable", and the committed-
 * evidence filter refuses loudly on null.
 */
async function executionWalks(env: Env, runId: string): Promise<WalkRecord[] | null> {
  const obj = await env.EVIDENCE.get(execProgressKey(runId));
  if (!obj) return null;
  try {
    const progress = (await obj.json()) as ExecProgress;
    return progress?.kind === "v2-execution-progress/1.0.0" && Array.isArray(progress.walks)
      ? progress.walks
      : null;
  } catch {
    return null;
  }
}

export interface DerivedVerdicts {
  /**
   * THE FULL ITEM RESULTS ARRAY.
   *
   * Direct callers (tests, dev endpoints, replay) receive this in memory. The Workflow
   * step body STRIPS this field before returning through `step.do` so the step state
   * carries only the summary (the platform per-step state cap is 1 MiB; with 588
   * requirements the full ItemResult[] array was several hundred KB). The array is also
   * persisted to R2 at `itemResultsKey(runId)` so the assembler step can load it without
   * receiving it through the Workflow boundary.
   */
  itemResults: ItemResult[];
  /** Content hash of the persisted itemResults JSON for verification. */
  itemResultsHash: string;
  /** For the checkpoint's phase note; each is a sentence a report can print verbatim. */
  summary: { requirements: number; cases: number; byVerdict: Record<string, number> };
}

/**
 * THE WORKFLOW-SAFE SUBSET of DerivedVerdicts that fits within the 1 MiB step state cap.
 *
 * `step.do("derive-verdicts", ...)` returns this through the Workflow boundary instead of
 * the full `DerivedVerdicts`. The assembler loads the full itemResults from R2 via
 * `loadDerivedItemResults(env, runId)`.
 */
export interface DerivedVerdictsSummary {
  itemResultsHash: string;
  summary: DerivedVerdicts["summary"];
}

/**
 * Strip the full itemResults array from a stage result, keeping only the summary.
 * The result type changes from StageResult<DerivedVerdicts> to StageResult<DerivedVerdictsSummary>
 * so the Workflow step state stays small.
 */
export function summarizeDerivedVerdicts(
  result: StageResult<DerivedVerdicts>,
): StageResult<DerivedVerdictsSummary> {
  if (result.state !== "evaluated") return result;
  const { itemResults: _stripped, ...rest } = result.value;
  return { ...result, value: rest };
}

/**
 * LOAD THE PERSISTED ITEM RESULTS from R2.
 *
 * This is the read path for the assembler (and any consumer that receives only the
 * summary through the Workflow step boundary). The derive-verdicts step persists the
 * full array to `itemResultsKey(runId)` before returning.
 * Returns null when the key is absent (old runs that pre-date this change).
 */
export async function loadDerivedItemResults(env: Env, runId: string): Promise<ItemResult[] | null> {
  const obj = await env.EVIDENCE.get(itemResultsKey(runId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as ItemResult[];
}

/**
 * (1) THE AGGREGATOR. Deterministic, model-free, and it derives its denominator from the
 * SEALED revision rather than from what happened to be observed.
 */
export async function deriveItemResults(env: Env, runId: string): Promise<StageResult<DerivedVerdicts>> {
  // THE AGGREGATOR NEVER READS THE EVIDENCE CATALOGUE. Its job is arithmetic over a
  // tri-state verifier decision and a sealed denominator — `observations` and `revision`,
  // nothing more. Loading the catalogue cost 19 minutes across three attempts on the real
  // v100 run (9 340 entries, ~5 minutes per fetch, all three fetches discarded — bench-
  // measured 22 Aug receipt). `catalog: false` is the fix: `loadRunInputs` returns
  // `evidence: []` and never touches R2's evidence prefix.
  const inputs = await loadRunInputs(env, runId, { catalog: false });
  if (!inputs.revision) {
    return stageNotEvaluated<DerivedVerdicts>(
      "NO_SEALED_CONTRACT",
      "no sealed contract revision resolved for this run, so there is no denominator to aggregate over",
    );
  }

  const unreachedStatus = unreachedFromCursor(inputs);
  const itemResults = aggregate({
    revision: inputs.revision,
    observations: inputs.observations,
    unreachedStatus,
  }) as ItemResult[];

  const violation = rejectModelDerivedVerdicts(itemResults);
  if (violation) {
    return stageNotEvaluated<DerivedVerdicts>("MODEL_DERIVED_VERDICT", violation);
  }

  const byVerdict: Record<string, number> = {};
  for (const r of itemResults) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;

  // PERSIST THE FULL ARRAY TO R2 so the Workflow step state carries only the summary.
  // The platform per-step state cap is 1 MiB; with 588 requirements the full
  // ItemResult[] was several hundred KB. The assembler loads from R2 via
  // `loadDerivedItemResults(env, runId)` instead of receiving it through the boundary.
  const serialized = JSON.stringify(itemResults);
  const itemResultsHash = await sha256Hex(serialized);
  await env.EVIDENCE.put(itemResultsKey(runId), serialized, {
    httpMetadata: { contentType: "application/json" },
  });

  return {
    state: "evaluated",
    value: {
      itemResults,
      itemResultsHash,
      summary: {
        requirements: itemResults.length,
        cases: itemResults.reduce((n, r) => n + r.facetResults.length, 0),
        byVerdict,
      },
    },
    proof: {
      evaluatorId: AGGREGATOR_ID,
      evaluatorVersion: AGGREGATOR_ID,
      inputHash: `observations:${inputs.observations.length}|cases:${inputs.revision.facetInstances.length}`,
      observedAt: new Date().toISOString(),
    },
  };
}

/**
 * Cases the execution cursor never reached, mapped to the terminal status the run's stop
 * reason names. A case that was never driven is `not-reached`, not `pending`: pending means
 * "still owed an observation", and a stopped run owes nothing.
 */
function unreachedFromCursor(inputs: RunInputs): Record<string, string> {
  const cursor = inputs.checkpoint?.execution ?? null;
  const reason = inputs.checkpoint?.completion.reasonCode ?? null;
  if (!cursor || cursor.pendingCaseIds.length === 0) return {};
  // OUR SHORTFALL IS NOT THEIR REFUSAL. This read "any reason code that is not a `-cap`" as
  // `blocked`, which in a signed record means "the site stopped us here" — so a run that
  // stopped on `coverage-shortfall-unexercised` wrote hundreds of cases we NEVER DROVE into
  // the record as refusals by the customer's survey. `unsettledBucketFor` (types/contracts.ts)
  // holds the mapping once, shared with the checkpoint's own `stopBucket`, so the record and
  // the run's blocker sentence cannot say different things about the same cases.
  const status = unsettledBucketFor(reason);
  return Object.fromEntries(cursor.pendingCaseIds.map((id) => [id, status]));
}

export interface MintedJudgement {
  status: string;
  publishable: boolean;
  attested: boolean;
  counts: unknown;
  authority: {
    verified: boolean;
    signatureVerified: boolean;
    contractBound: boolean;
    manifestComplete: boolean;
    checklistBound: boolean;
    findings: unknown;
  };
  checklistSource: "extraction" | "revision-projection";
  ambiguitiesAvailable: boolean;
  artifacts: number;
  /** How many identical catalogue rows were collapsed before judging (retried steps record twice). */
  duplicatesCollapsed: number;
  /**
   * How many catalogue rows were superseded by a live recording of a retried step.
   * null when no superseded recordings were found — distinguishable from zero.
   */
  supersededRecordings: number | null;
  /** Plain sentence surfaced on the report alongside duplicatesCollapsed. */
  supersededNote: string | null;
  /**
   * EVIDENCE ENTRIES THAT COULD NOT BE LOADED — named limitations carried to the report.
   * Zero means every entry loaded successfully.
   */
  evidenceLimitations: number;
}

/**
 * (2) THE JUDGE. Runs IN THIS ISOLATE over the run's signed record and its verified
 * artifact bytes, and writes the JudgementRecord to `v2/runs/<id>/judgement.json` — the key
 * `report/build.ts` already reads, through `store/judgement.ts`'s four demoting gates.
 *
 * WHAT IS STORED IS THE JUDGEMENT RECORD ALONE, not the whole engine output. The report
 * path's trust boundary validates a JudgementRecord: shape, attestation against the PINNED
 * registry, and a binding recomputed from the Worker's own durable state. Storing the
 * engine's full bundle would put a document the boundary cannot validate at the key the
 * boundary reads.
 *
 * The Worker does NOT trust what it just wrote. `loadJudgement` re-checks the signature
 * against `JUDGEMENT_KEY_REGISTRY` on the way out, and if this run's judgement key is not
 * pinned there the judgement is `unusable` and the report shows one column. That is the
 * intended posture, not a gap: a producer that certifies itself has certified nothing.
 */
export async function mintJudgement(env: Env, runId: string): Promise<StageResult<MintedJudgement>> {
  const inputs = await loadRunInputs(env, runId);
  if (!inputs.revision) {
    return stageNotEvaluated<MintedJudgement>(
      "NO_SEALED_CONTRACT",
      "no sealed contract revision resolved for this run, so no judgement can be bound to one",
    );
  }

  const stored = await env.EVIDENCE.get(recordKey(runId));
  if (!stored) {
    return stageNotEvaluated<MintedJudgement>(
      "NO_RUN_RECORD",
      `no RunRecord at ${recordKey(runId)} — the judge re-derives verdicts FROM a record and there is none`,
    );
  }
  const record = JSON.parse(await stored.text()) as Record<string, unknown>;

  // The record's own revision must be the one this run sealed. `getContractRevision`
  // re-hashes the stored bytes, so a revision altered under its key fails here rather than
  // producing a judgement against a denominator nobody sealed.
  const namedRevisionId = (record.contract as { contractRevisionId?: string } | undefined)?.contractRevisionId ?? null;
  if (namedRevisionId && namedRevisionId !== inputs.revision.contractRevisionId) {
    return stageNotEvaluated<MintedJudgement>(
      "CONTRACT_REVISION_DISAGREEMENT",
      `the stored RunRecord names ${namedRevisionId} and the checkpoint sealed ${inputs.revision.contractRevisionId}`,
    );
  }
  const revision = await getContractRevision(env, inputs.revision.contractRevisionId, {
    contractHash: inputs.contractHash,
  });
  if (!revision) {
    return stageNotEvaluated<MintedJudgement>(
      "CONTRACT_REVISION_MISSING",
      `the sealed revision ${inputs.revision.contractRevisionId} did not re-read from storage`,
    );
  }

  // THE CHECKLIST THE JUDGE COMPILES. Extraction's own is preferred because only it carries
  // the ambiguity READINGS the withholding policy needs; the projection is the honest
  // fallback and says what it lost.
  const fromExtraction = checklistFromExtraction(await readRunChecklist(env, runId));
  const checklist =
    fromExtraction ??
    checklistFromRevision(revision, {
      target: inputs.envelope?.input.surveyUrl ?? null,
      sourceDocument: inputs.envelope?.input.documentName ?? null,
    });

  // -----------------------------------------------------------------------
  // THE COMMITTED-ATTEMPT EVIDENCE FILTER — applied on the judge side too, so the judge's
  // mount contains exactly the same evidence the signed record was built from. Without this
  // the judge would re-inherit orphan rows from killed attempts and either collide on them
  // (the v99/v100 defect) or judge evidence the record does not carry.
  //
  // The walk ledger is loaded the same way assemble-record loads it: one keyed R2 GET.
  // A missing ledger makes the filter REFUSE LOUDLY (throw MissingWalkLedgerError). The
  // caller catches that refusal and degrades to unfiltered evidence with a log — the
  // record was already assembled with the filter's output (or its own degradation), so
  // the judge using unfiltered evidence when the ledger is missing is an honest fallback,
  // not a silent pass-through.
  // -----------------------------------------------------------------------
  const walks = await executionWalks(env, runId);
  let evidenceFilter: CommittedEvidenceResult;
  try {
    evidenceFilter = filterCommittedEvidence(inputs.evidence, walks);
  } catch (err) {
    if (err instanceof MissingWalkLedgerError) {
      console.error(
        `mint-judgement: ${runId} — committed-evidence filter refused: ${err.message}`,
      );
      evidenceFilter = {
        kept: inputs.evidence,
        droppedOrphans: [],
        droppedByRef: [],
        sentence: "committed-evidence filter could not run: walk ledger unavailable. Evidence passed unfiltered.",
      };
    } else {
      throw err;
    }
  }
  const committedEvidence = evidenceFilter.kept;
  if (evidenceFilter.droppedOrphans.length > 0) {
    console.log(
      `mint-judgement: ${runId} — ${evidenceFilter.sentence}`,
    );
  }

  // A3 — MEMORY-SAFE JUDGING: use the streaming loader to bound residency.
  //
  // The streaming loader splits artifacts into engine-read (JSON, written to tmpdir) and
  // hash-verify-only (PNGs, etc., hashed and released). This bounds the memory footprint:
  // instead of ~530MB of blobs in a single array, only the ~60-200MB of observation JSONs
  // stays resident, and the ~9,000 step PNGs are verified in 24-entry batches.
  //
  // A catalogue whose basenames collide cannot be judged honestly: the mount would lose
  // evidence and the signed manifest would double-count it. Saying so is the right outcome;
  // judging the survivors would report a smaller evidence set as if it were the whole one.
  let streamResult: StreamingArtifactResult;
  try {
    streamResult = await loadArtifactBytesStreaming(env, committedEvidence);
    // Surface limitations as log so they are visible in Workflow step output,
    // but do NOT block the judging — the run proceeds with the artifacts it has.
    if (streamResult.limitations.length > 0) {
      console.log(
        `v2 ${runId}: ${streamResult.limitations.length} evidence limitation(s): ` +
          streamResult.limitations.slice(0, 5).map((l) => l.reason).join("; ") +
          (streamResult.limitations.length > 5 ? ` (and ${streamResult.limitations.length - 5} more)` : ""),
      );
    }
  } catch (err) {
    if (err instanceof ArtifactNameCollision) {
      return stageNotEvaluated<MintedJudgement>("EVIDENCE_NAME_COLLISION", err.message);
    }
    if (err instanceof EngineReadBudgetExceeded) {
      return stageNotEvaluated<MintedJudgement>("ENGINE_READ_BUDGET_EXCEEDED", err.message);
    }
    throw err;
  }
  const keys = signingKeys(env);
  // THE REGISTRY IS DERIVED FROM THE WORKER'S OWN KEY, NOT READ OFF THE RECORD.
  // A registry carried inside the document whose signature it checks is circular — whoever
  // can alter the record can alter the registry with it. Deriving the public key from the
  // private key this Worker holds is the one form of the check that the record cannot
  // influence. No key configured ⇒ null ⇒ the judge reports `signatureVerified: false`.
  const keyRegistry = keys.recordKeyPem
    ? publicRegistryFor(keys.recordKeyPem, keys.recordKeyId)
    : null;

  const { judged } = judgeRunInIsolate({
    runId,
    checklist,
    record,
    revision,
    // A3: only engine-read artifacts (JSON) go to the tmpdir mount.
    artifacts: streamResult.engineRead,
    keyRegistry,
    signer: keys.judgementKeyPem
      ? { privateKeyPem: keys.judgementKeyPem, keyId: keys.judgementKeyId, signedAt: new Date().toISOString() }
      : null,
    // A3: pre-verified hashes for artifacts NOT written to tmpdir. The authority uses
    // these so `manifestComplete` covers the full evidence set.
    preVerifiedArtifacts: streamResult.preVerifiedHashes,
  }) as { judged: JudgeOutput };

  await env.EVIDENCE.put(judgementKey(runId), JSON.stringify(judged.judgement), {
    httpMetadata: { contentType: "application/json" },
  });

  const totalArtifacts = streamResult.engineRead.length + streamResult.preVerifiedHashes.size;
  return {
    state: "evaluated",
    value: {
      status: judged.status,
      publishable: !!judged.publishable,
      attested: !!judged.judgement?.attestation,
      counts: judged.counts,
      authority: {
        verified: !!judged.authority?.verified,
        signatureVerified: !!judged.authority?.signatureVerified,
        contractBound: !!judged.authority?.contractBound,
        manifestComplete: !!judged.authority?.manifestComplete,
        checklistBound: !!judged.authority?.checklistBound,
        findings: judged.authority?.findings ?? null,
      },
      checklistSource: fromExtraction ? "extraction" : "revision-projection",
      ambiguitiesAvailable: !!checklist.ambiguitiesAvailable,
      artifacts: totalArtifacts,
      // A retried step records its captures twice; identical rows are collapsed before the
      // collision check. Zero when the catalogue had no duplicates.
      duplicatesCollapsed: streamResult.duplicatesCollapsed,
      // Superseded recordings: same (basename, ref), different hash — resolved by verifying
      // which blob exists in storage. null when no superseded recordings were found.
      supersededRecordings: streamResult.supersededRecordings,
      supersededNote: streamResult.supersededNote,
      evidenceLimitations: streamResult.limitations.length,
    },
    proof: {
      evaluatorId: "pipeline/judge",
      evaluatorVersion: String(judged.judgement?.binding?.engineVersion ?? "unknown"),
      inputHash: String((record.attestation as { payloadHash?: string } | null)?.payloadHash ?? "unsigned-record"),
      observedAt: new Date().toISOString(),
    },
  };
}

interface JudgeOutput {
  status: string;
  publishable: boolean;
  counts: unknown;
  judgement: { attestation?: unknown; binding?: { engineVersion?: string } };
  authority?: {
    verified?: boolean;
    signatureVerified?: boolean;
    contractBound?: boolean;
    manifestComplete?: boolean;
    checklistBound?: boolean;
    findings?: unknown;
  };
}

export { runChecklistKey };
