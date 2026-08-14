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
import { recordArchiveKey, recordKey } from "../../keys";
import { loadRunInputs } from "./run-inputs";
import { signingKeys } from "./run-inputs";
import { stageNotEvaluated, type StageResult } from "../gates";
import type { ContractRevision, ItemResult, RunClosure } from "../../types/record";
import { resolveTargetIdentity } from "../../store/target-build";
import { readRunChecklist } from "./checklist-store";
// The execution ledger's key and shape, imported rather than re-spelled: a second copy of a
// storage key is how two readers come to disagree about where the run's own state lives.
import { execProgressKey, type ExecProgress, type WalkRecord } from "./execute-batch";
import { loadProgram, probeCapabilityLimitations, type PlanLimitation } from "./plan";

// prettier-ignore
// @ts-ignore -- untyped ESM, shared with the offline pipeline
import { assembleRunRecordV2, deriveBlockers, recordHashOf, rejectModelDerivedVerdicts, rejectUnaccountedFailures, supersedeRunRecord, ASSEMBLER_ID, SUPERSEDER_ID } from "./assemble-record.mjs";
export { assembleRunRecordV2 };
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
  /** Blockers that prohibit whole-document/full-coverage credit even if every sealed case settled. */
  coverageBlockers: number;
  attempts: number;
  ambiguities: number;
  taxonomyGaps: number;
  /** 1 for the record the judge binds to; 2+ for a superseding revision. */
  revision: number;
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

/**
 * The exact probe-capability assessment for the execution program this run drove.
 *
 * `undefined` means this historical/test checkpoint names no plan. `null` means it names one
 * that could not be read. The record projector only emits capability blockers from an array;
 * the report already has a separate loud plan-unavailable state, while an absent plan on old
 * records must not be rewritten into a newly invented execution fact.
 */
async function executionProbeLimitations(
  env: Env,
  runId: string,
  planRevisionId: string | null | undefined,
): Promise<PlanLimitation[] | null | undefined> {
  if (!planRevisionId) return undefined;
  try {
    const program = await loadProgram(env, runId, planRevisionId);
    return program ? probeCapabilityLimitations(program.plan) : null;
  } catch {
    return null;
  }
}

/** Pure record projection seam exported so its fail-loud behaviour is mutation-testable. */
export const deriveRecordBlockers = deriveBlockers as (args: {
  revision: ContractRevision;
  walks: WalkRecord[] | null;
  itemResults: unknown[];
  observations: unknown[];
  evidence: unknown[];
  probeCapabilityLimitations?: PlanLimitation[] | null;
}) => Array<Record<string, unknown>>;

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
  const probeLimitations = await executionProbeLimitations(
    env,
    runId,
    inputs.checkpoint?.execution?.planRevisionId,
  );
  // THE AMBIGUITY READINGS. Only the extraction's own checklist carries them; a sealed
  // revision keeps ambiguities as digests. `null` here makes `readingsAvailable` false rather
  // than making an ambiguous document look unambiguous.
  const checklist = await readRunChecklist(env, runId);
  // WHAT WAS TESTED, RESOLVED HERE BECAUSE ONLY HERE CAN IT BE. The derived branch digests the
  // catalogue, which is async, so the synchronous assembler cannot do it — and the record used
  // to state `targetBuildId: null` while the report independently derived a `site-sha256:` id
  // from the same catalogue. Two answers to one question, and the signed one was the empty one.
  //
  // IT IS DELIBERATELY BELT AND BRACES. The run-level fix records the identity onto the ENVELOPE
  // before anything is derived (D40), which is the better place for it because a judgement binds
  // to it. This resolves the same precedence again at assembly, so a run that reached the
  // assembler WITHOUT that step having landed — a resumed instance, or one whose identity step
  // failed — still produces a record that can name what it tested. `run.targetBuildId` keeps the
  // RECORDED value untouched either way; only the sibling states the resolution.
  const targetIdentity = await resolveTargetIdentity({
    recorded: inputs.envelope?.input.targetBuildId ?? null,
    override: env.DEFAULT_TARGET_BUILD_ID ?? null,
    catalog: inputs.evidence,
  });
  const unsigned = assembleRunRecordV2({
    runId,
    envelope: inputs.envelope,
    revision: inputs.revision,
    contractHash: inputs.contractHash,
    observations: inputs.observations,
    evidence: inputs.evidence,
    itemResults,
    // CLAIMS, BLOCKERS, ATTEMPTS, AMBIGUITIES AND TAXONOMY GAPS ARE NOT PASSED. The assembler
    // derives all five from the itemResults, observations, evidence, walks, revision and
    // checklist above. This call site used to hand it `claims: []` and that is precisely what
    // got signed — and then handed it `attempts: []`, one field over, in the fix.
    walks,
    probeCapabilityLimitations: probeLimitations,
    checklist,
    targetIdentity,
    checkpoint: inputs.checkpoint,
    planHash: inputs.checkpoint?.execution?.planRevisionId ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
  }) as Record<string, unknown>;

  return await signAndStore(env, runId, unsigned, {
    requirements: itemResults.length,
    observations: inputs.observations.length,
    evidence: inputs.evidence.length,
    evaluatorId: ASSEMBLER_ID,
    inputHash: `${inputs.revision.contractRevisionId}|obs:${inputs.observations.length}|ev:${inputs.evidence.length}`,
  });
}

/**
 * SUPERSEDE THE RUN'S RECORD WITH ONE THAT KNOWS HOW THE RUN ENDED.
 *
 * ================= WHY THE FIRST RECORD CANNOT SIMPLY BE SIGNED LATER =================
 *
 * `mintJudgement` READS the record and binds its JudgementRecord to the record's own
 * `attestation.payloadHash`. A record that contained the judgement's outcome would therefore
 * have to contain a hash of itself. Signing later, or reordering the stages, does not remove
 * that circularity — it only breaks the binding. Revision 1 must be signed before the judge
 * runs, and that is correct.
 *
 * WHAT WAS ACTUALLY WRONG IS THAT NOTHING WAS SIGNED AFTERWARDS. Run 4 was signed at 02:28:03
 * and `mint-judgement` then failed with EVIDENCE_NAME_COLLISION at 02:29:57 — a fact that
 * existed only in stdout. Whoever verified that signature got cryptographic confidence in a
 * document that could not say the second opinion had never been obtained.
 *
 * So closure produces a NEW signed revision that names the hash it replaces. The prior bytes
 * are untouched and still addressable at their own content-addressed key, so the judgement's
 * binding to them still resolves. Supersede, never mutate.
 */
export async function supersedeRecord(
  env: Env,
  runId: string,
  closure: RunClosure,
  reason: string,
): Promise<StageResult<AssembledRecord>> {
  const stored = await env.EVIDENCE.get(recordKey(runId));
  if (!stored) {
    return stageNotEvaluated<AssembledRecord>(
      "NO_RUN_RECORD",
      `no RunRecord at ${recordKey(runId)}; a superseding revision replaces a record and there is none`,
    );
  }
  const prior = JSON.parse(await stored.text()) as Record<string, unknown>;

  // THE PROHIBITION IS RE-CHECKED ON EVERY WRITE, not only the first. A superseding revision is
  // as durable as the one it replaces and is what later readers will trust.
  const violation = rejectModelDerivedVerdicts(prior.itemResults);
  if (violation) return stageNotEvaluated<AssembledRecord>("MODEL_DERIVED_VERDICT", violation);

  const next = supersedeRunRecord(prior, { closure, reason }) as Record<string, unknown>;
  return await signAndStore(env, runId, next, {
    requirements: (prior.itemResults as unknown[] | undefined)?.length ?? 0,
    observations: (prior.observations as unknown[] | undefined)?.length ?? 0,
    evidence: (prior.evidence as unknown[] | undefined)?.length ?? 0,
    evaluatorId: SUPERSEDER_ID,
    inputHash: String(recordHashOf(prior)),
  });
}

/**
 * SIGN, REFUSE IF THE RECORD HIDES A FAILURE, ARCHIVE IMMUTABLY, THEN MOVE THE HEAD.
 *
 * The order matters in both directions. The GUARD runs on the fully assembled bytes and before
 * anything is stored, so a record that shows a clean survey over failing verdicts never reaches
 * storage at all. The ARCHIVE is written before the head pointer, so a crash between the two
 * leaves the new revision readable rather than lost — and never leaves the head pointing at
 * bytes no archive holds.
 */
async function signAndStore(
  env: Env,
  runId: string,
  unsigned: Record<string, unknown>,
  meta: {
    requirements: number;
    observations: number;
    evidence: number;
    evaluatorId: string;
    inputHash: string;
  },
): Promise<StageResult<AssembledRecord>> {
  const keys = signingKeys(env);
  const canSign = keys.recordKeyPem !== null && usablePrivateKey(keys.recordKeyPem);
  const record = canSign
    ? (signRecordWithProducerKey(unsigned, {
        privateKeyPem: keys.recordKeyPem,
        keyId: keys.recordKeyId,
        signedAt: new Date().toISOString(),
      }).record as Record<string, unknown>)
    : unsigned;

  // THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Refusing is loud — no record, so no
  // judgement and no closed axis — and a signed record showing a clean survey over failing
  // verdicts is the one thing worse than a run that produced nothing.
  const silent = rejectUnaccountedFailures(record);
  if (silent) return stageNotEvaluated<AssembledRecord>("UNACCOUNTED_FAILURES", silent);

  const hash = String(recordHashOf(record));
  const body = JSON.stringify(record);
  await env.EVIDENCE.put(recordArchiveKey(runId, hash), body, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.EVIDENCE.put(recordKey(runId), body, {
    httpMetadata: { contentType: "application/json" },
  });

  const revision = Number((record.recordRevision as { revision?: number } | undefined)?.revision ?? 1);
  return {
    state: "evaluated",
    value: {
      // ALWAYS THE REAL HASH, even unsigned. It used to be the literal string "unsigned" when
      // no key was configured, which was harmless when nothing consumed it and is not any more:
      // it is the archive key this revision was just written to, and the value a superseding
      // revision names as its predecessor. `signed` already carries the other fact.
      recordHash: hash,
      signed: canSign,
      requirements: meta.requirements,
      observations: meta.observations,
      evidence: meta.evidence,
      testComplete: !!(record.exploration as { testComplete?: boolean })?.testComplete,
      claims: (record.claims as unknown[] | undefined)?.length ?? 0,
      blockers: (record.blockers as unknown[] | undefined)?.length ?? 0,
      coverageBlockers: (record.blockers as Array<{ kind?: unknown }> | undefined)?.filter(
        (entry) => entry?.kind === "DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE",
      ).length ?? 0,
      attempts: (record.attempts as unknown[] | undefined)?.length ?? 0,
      ambiguities: (record.ambiguities as unknown[] | undefined)?.length ?? 0,
      taxonomyGaps: (record.taxonomyGaps as unknown[] | undefined)?.length ?? 0,
      revision,
    },
    proof: {
      evaluatorId: meta.evaluatorId,
      evaluatorVersion: meta.evaluatorId,
      inputHash: meta.inputHash,
      observedAt: new Date().toISOString(),
    },
  };
}
