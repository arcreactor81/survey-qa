/**
 * PHASE: assemble-record — write the run's own signed account of itself.
 *
 * The RunRecord is the document everything downstream binds to: the report renders it, the
 * judge re-derives verdicts FROM it, and the JudgementRecord's binding names its payload
 * hash. So it is assembled from the run's DURABLE STATE — the sealed revision, the
 * envelope, the observations, the evidence catalogue, the checkpoint's usage ledger — and
 * from nothing that a stage merely believes.
 *
 * ATTESTATION PROVES PROVENANCE, NOT TRUTH. A signature here says these bytes are the ones
 * this Worker assembled and have not moved since. It does not say the verdicts are right;
 * that is what the independent judgement is for. With no signing key configured the record
 * is written UNSIGNED rather than not written — an unsigned record still renders a report,
 * it simply cannot support a trusted second column, and the page says which.
 */

import type { Env } from "../../types/env";
import { recordKey } from "../../keys";
import { loadRunInputs } from "./run-inputs";
import { signingKeys } from "./run-inputs";
import { stageNotEvaluated, type StageResult } from "../gates";
import type { ItemResult } from "../../types/record";
// The execution ledger's key and shape, imported rather than re-spelled: a second copy of a
// storage key is how two readers come to disagree about where the run's own state lives.
import { execProgressKey, type ExecProgress, type WalkRecord } from "./execute-batch";

// @ts-ignore -- untyped ESM, shared with the offline pipeline
import { assembleRunRecordV2, rejectModelDerivedVerdicts, ASSEMBLER_ID } from "./assemble-record.mjs";
// @ts-ignore -- untyped ESM
import { signRecordWithProducerKey, usablePrivateKey } from "./judge-runtime.mjs";

export interface AssembledRecord {
  recordHash: string;
  signed: boolean;
  requirements: number;
  observations: number;
  evidence: number;
  testComplete: boolean;
  /** Surfaced on the stage result so a run's findings are countable without re-reading R2. */
  claims: number;
  blockers: number;
}

/**
 * The run's own execution ledger, or NULL — never an empty ledger standing in for a missing
 * one.
 *
 * `execute-batch.ts#loadProgress` deliberately returns an EMPTY progress for a missing or
 * unparseable object, because the executor's next action is the same either way: start from
 * nothing. The assembler's need is the opposite one. "No walk crashed" and "we cannot say
 * whether a walk crashed" are different sentences for a reader of a signed record, and
 * collapsing them is how a run that never wrote a ledger would read as a run whose target
 * loaded fine. So this reads the same durable key and keeps the distinction.
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

export async function assembleRecord(
  env: Env,
  runId: string,
  itemResults: ItemResult[],
): Promise<StageResult<AssembledRecord>> {
  const inputs = await loadRunInputs(env, runId);
  if (!inputs.revision || !inputs.contractHash) {
    return stageNotEvaluated<AssembledRecord>(
      "NO_SEALED_CONTRACT",
      "a RunRecord references a sealed contract revision by id and hash; this run has none, so there is " +
        "nothing for the record to be a record OF",
    );
  }

  // THE PROHIBITION IS RE-CHECKED AT THE WRITE BOUNDARY, not only where the verdicts were
  // produced. A record is durable and is what every later reader trusts; the last chance to
  // refuse a model-authored verdict is here.
  const violation = rejectModelDerivedVerdicts(itemResults);
  if (violation) return stageNotEvaluated<AssembledRecord>("MODEL_DERIVED_VERDICT", violation);

  const startedAt = inputs.envelope?.createdAt ?? new Date().toISOString();
  // ONE extra R2 GET, not a LIST. `run-inputs.ts` explains why the catalogue is the expensive
  // load; this is a single keyed read and the only source of the run's load-crash facts.
  const walks = await executionWalks(env, runId);
  const unsigned = assembleRunRecordV2({
    runId,
    envelope: inputs.envelope,
    revision: inputs.revision,
    contractHash: inputs.contractHash,
    observations: inputs.observations,
    evidence: inputs.evidence,
    itemResults,
    attempts: [],
    // CLAIMS AND BLOCKERS ARE NOT PASSED. The assembler derives both from the itemResults,
    // observations, evidence and walks above — see `deriveClaims` / `deriveBlockers`. This
    // call site used to hand it `claims: []` and that is precisely what got signed.
    walks,
    checkpoint: inputs.checkpoint,
    planHash: inputs.checkpoint?.execution?.planRevisionId ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
  }) as Record<string, unknown>;

  const keys = signingKeys(env);
  const canSign = keys.recordKeyPem !== null && usablePrivateKey(keys.recordKeyPem);
  const record = canSign
    ? (signRecordWithProducerKey(unsigned, {
        privateKeyPem: keys.recordKeyPem,
        keyId: keys.recordKeyId,
        signedAt: new Date().toISOString(),
      }).record as Record<string, unknown>)
    : unsigned;

  await env.EVIDENCE.put(recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });

  const attestation = record.attestation as { payloadHash?: string } | null;
  return {
    state: "evaluated",
    value: {
      recordHash: attestation?.payloadHash ?? "unsigned",
      signed: canSign,
      requirements: itemResults.length,
      observations: inputs.observations.length,
      evidence: inputs.evidence.length,
      testComplete: !!(record.exploration as { testComplete?: boolean })?.testComplete,
      claims: (record.claims as unknown[] | undefined)?.length ?? 0,
      blockers: (record.blockers as unknown[] | undefined)?.length ?? 0,
    },
    proof: {
      evaluatorId: ASSEMBLER_ID,
      evaluatorVersion: ASSEMBLER_ID,
      inputHash: `${inputs.revision.contractRevisionId}|obs:${inputs.observations.length}|ev:${inputs.evidence.length}`,
      observedAt: new Date().toISOString(),
    },
  };
}
