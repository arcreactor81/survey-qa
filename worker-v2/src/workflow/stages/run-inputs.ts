/**
 * EVERYTHING THE JUDGING STAGES READ, LOADED ONCE, FROM THE RUN'S OWN DURABLE STATE.
 *
 * Three stages need overlapping slices of the same run: the aggregator needs the sealed
 * revision and the observations, the assembler needs those plus the envelope and the
 * evidence catalogue, and the judge needs all of it plus the artifact BYTES. Loading them
 * separately in each stage would let two stages disagree about which revision the run
 * sealed — which is the disagreement `report/build.ts` already refuses to render over.
 *
 * The evidence bytes come back through `getVerifiedEvidence`, so every artifact handed to
 * the judge has already been re-hashed against the catalogue entry that names it. The judge
 * then hashes them AGAIN, against the SIGNED manifest in the record. That is not redundant:
 * the first check says storage did not corrupt the blob, the second says the blob is the one
 * the record committed to. They are different claims and both are wanted.
 */

import type { Env } from "../../types/env";
import { observationsKey } from "../../keys";
import { getEnvelope } from "../../store/envelope";
import { loadCheckpoint } from "../../store/checkpoint";
import { getContractRevision } from "../../store/contract-revision";
import { getVerifiedEvidence, listCatalog } from "../../store/evidence";
import type { ContractRevision, EvidenceCatalogEntry, Observation, RunEnvelopeV2 } from "../../types/record";
import type { RunCheckpoint } from "../../types/contracts";

export interface RunInputs {
  runId: string;
  envelope: RunEnvelopeV2 | null;
  checkpoint: RunCheckpoint | null;
  revision: ContractRevision | null;
  contractHash: string | null;
  observations: Observation[];
  evidence: EvidenceCatalogEntry[];
}

/** A reason the stage cannot proceed, phrased as the sentence the report will print. */
export type InputProblem = string;

export async function loadRunInputs(env: Env, runId: string): Promise<RunInputs> {
  const loaded = await loadCheckpoint(env, runId);
  const checkpoint = loaded?.checkpoint ?? null;
  const envelope = await getEnvelope(env, runId).catch(() => null);

  const contractRevisionId = checkpoint?.contract.contractRevisionId ?? envelope?.contractRevisionId ?? null;
  const contractHash = checkpoint?.contract.contractHash ?? null;
  const revision = contractRevisionId
    ? await getContractRevision(env, contractRevisionId, { contractHash })
    : null;

  return {
    runId,
    envelope,
    checkpoint,
    revision,
    contractHash,
    observations: await readObservations(env, runId),
    evidence: await listCatalog(env, runId),
  };
}

/**
 * The observations the execution stage committed.
 *
 * ABSENT IS EMPTY, AND EMPTY IS NOT AN ERROR — it is a run that observed nothing, which the
 * aggregator turns into `pending` cases and `incomplete` requirements. An unparseable
 * observations document IS an error, because silently reading it as "no observations" would
 * turn a corrupt file into a clean-looking incomplete run.
 */
async function readObservations(env: Env, runId: string): Promise<Observation[]> {
  const obj = await env.EVIDENCE.get(observationsKey(runId));
  if (!obj) return [];
  const text = await obj.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `the observations document for ${runId} is not parseable JSON (${err instanceof Error ? err.message : String(err)}); ` +
        `refusing to read a corrupt file as "this run observed nothing"`,
    );
  }
  if (Array.isArray(parsed)) return parsed as Observation[];
  const inner = (parsed as { observations?: unknown }).observations;
  return Array.isArray(inner) ? (inner as Observation[]) : [];
}

/** Fetch every catalogued artifact's bytes, keyed by the basename the record cites. */
export async function loadArtifactBytes(
  env: Env,
  evidence: EvidenceCatalogEntry[],
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const entry of evidence) {
    const ref = entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId;
    const { bytes } = await getVerifiedEvidence(env, entry);
    out.push({ name: String(ref).split("/").pop() ?? entry.evidenceId, bytes });
  }
  return out;
}

/**
 * SIGNING KEYS ARE CONFIGURATION AND THEY ARE OPTIONAL, LOUDLY.
 *
 * `RECORD_SIGNING_KEY` attests the RunRecord this Worker assembled; `JUDGEMENT_SIGNING_KEY`
 * attests the JudgementRecord the judge mints, and its key id must appear in the pinned
 * `JUDGEMENT_KEY_REGISTRY` or the Worker's own trust boundary will reject the result it
 * just produced — deliberately, because a producer that could certify itself by existing is
 * not a trust boundary.
 *
 * Missing keys never fail a run. They downgrade it: unsigned record ⇒ unverified authority
 * ⇒ diagnostic-only judgement ⇒ a report with no current-results column, saying why.
 */
export interface SigningKeys {
  recordKeyPem: string | null;
  recordKeyId: string;
  judgementKeyPem: string | null;
  judgementKeyId: string;
}

interface SigningEnv {
  RECORD_SIGNING_KEY?: string;
  RECORD_SIGNING_KEY_ID?: string;
  JUDGEMENT_SIGNING_KEY?: string;
  JUDGEMENT_SIGNING_KEY_ID?: string;
}

export function signingKeys(env: Env): SigningKeys {
  const e = env as unknown as SigningEnv;
  // PEM through a `--var` or a secret arrives with literal "\n" escapes as often as not.
  const pem = (v: string | undefined) => (v && v.includes("PRIVATE KEY") ? v.replace(/\\n/g, "\n") : null);
  return {
    recordKeyPem: pem(e.RECORD_SIGNING_KEY),
    recordKeyId: e.RECORD_SIGNING_KEY_ID ?? "v2-producer-key-1",
    judgementKeyPem: pem(e.JUDGEMENT_SIGNING_KEY),
    judgementKeyId: e.JUDGEMENT_SIGNING_KEY_ID ?? "v2-judge-key-1",
  };
}
