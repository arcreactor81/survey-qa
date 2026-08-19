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
import { ArtifactNameCollision, loadRunInputs, loadArtifactBytes, signingKeys, type RunInputs } from "./run-inputs";
import { stageNotEvaluated, type StageResult } from "../gates";
import type { ItemResult } from "../../types/record";

// @ts-ignore -- untyped ESM, shared with the offline pipeline
import { aggregate, rejectModelDerivedVerdicts, AGGREGATOR_ID } from "./assemble-record.mjs";
// @ts-ignore -- untyped ESM
import { judgeRunInIsolate, publicRegistryFor } from "./judge-runtime.mjs";
// @ts-ignore -- untyped ESM
import { checklistFromExtraction, checklistFromRevision } from "./checklist-projection.mjs";
import { runChecklistKey, readRunChecklist } from "./checklist-store";

export interface DerivedVerdicts {
  itemResults: ItemResult[];
  /** For the checkpoint's phase note; each is a sentence a report can print verbatim. */
  summary: { requirements: number; cases: number; byVerdict: Record<string, number> };
}

/**
 * (1) THE AGGREGATOR. Deterministic, model-free, and it derives its denominator from the
 * SEALED revision rather than from what happened to be observed.
 */
export async function deriveItemResults(env: Env, runId: string): Promise<StageResult<DerivedVerdicts>> {
  const inputs = await loadRunInputs(env, runId);
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

  return {
    state: "evaluated",
    value: {
      itemResults,
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

  // A catalogue whose basenames collide cannot be judged honestly: the mount would lose
  // evidence and the signed manifest would double-count it. Saying so is the right outcome;
  // judging the survivors would report a smaller evidence set as if it were the whole one.
  let artifacts: Array<{ name: string; bytes: Uint8Array }>;
  try {
    artifacts = await loadArtifactBytes(env, inputs.evidence);
  } catch (err) {
    if (err instanceof ArtifactNameCollision) {
      return stageNotEvaluated<MintedJudgement>("EVIDENCE_NAME_COLLISION", err.message);
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
    artifacts,
    keyRegistry,
    signer: keys.judgementKeyPem
      ? { privateKeyPem: keys.judgementKeyPem, keyId: keys.judgementKeyId, signedAt: new Date().toISOString() }
      : null,
  }) as { judged: JudgeOutput };

  await env.EVIDENCE.put(judgementKey(runId), JSON.stringify(judged.judgement), {
    httpMetadata: { contentType: "application/json" },
  });

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
      artifacts: artifacts.length,
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
