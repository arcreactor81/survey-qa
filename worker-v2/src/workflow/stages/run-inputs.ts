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
import { evidenceBlobKey } from "../../keys";
import { sha256Hex } from "../../store/hash";
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

/**
 * WHETHER TO PAY FOR THE CATALOGUE.
 *
 * `listCatalog` is the most expensive thing this loader does by an order of magnitude: one
 * R2 LIST plus one R2 GET **per catalogue entry**, and a real run catalogues one entry per
 * screen read and per screenshot of every walk (1,707 for
 * v2r_01kzfb6py8pbxznqv022p2qkhb). A Worker invocation has a bounded subrequest budget and
 * Workflow steps SHARE it, so a stage that loads the catalogue it does not need is not
 * merely slow — it spends budget the stages after it still need.
 *
 * `catalog: false` therefore exists for the stages that only ever look artifacts up BY ID
 * (`getBoundCatalogEntry` is the keyed read, and it runs the same binding assertion
 * `listCatalog` runs). Stages that genuinely need the whole set — the assembler's signed
 * manifest, the judge's evidence mount — must keep the default and pay for it.
 *
 * It defaults to TRUE so that adding this option changed no existing caller's behaviour.
 */
export interface LoadRunInputsOptions {
  /** Load the full evidence catalogue. Default true; false yields `evidence: []`. */
  catalog?: boolean;
}

export async function loadRunInputs(
  env: Env,
  runId: string,
  opts: LoadRunInputsOptions = {},
): Promise<RunInputs> {
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
    // EMPTY BECAUSE IT WAS NOT ASKED FOR — NOT BECAUSE THE RUN HAS NO EVIDENCE. Any caller
    // that reads `evidence` must therefore not pass `catalog: false`; the two callers that
    // do read it (`derive-verdicts`, `assemble-record`) use the default.
    evidence: opts.catalog === false ? [] : await listCatalog(env, runId),
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

/**
 * Fetch every catalogued artifact's bytes, keyed by the basename the record cites.
 *
 * THE BASENAME IS THE IDENTITY, SO TWO ARTIFACTS MAY NOT SHARE ONE.
 *
 * `pipeline/judge/lib/authority.mjs` builds the signed allowlist with the same
 * `basename(artifactRef)` rule, so a colliding pair is not merely a mount problem — it
 * raises MANIFEST_DUPLICATE_ARTIFACT, clears `manifestComplete`, and leaves the authority
 * unverified, which means the run mints no judgement and the report shows no current
 * results. This loop used to hand the collision downstream in silence and let the mount
 * overwrite one walk's evidence with another's.
 *
 * `capture.ts` now emits unique basenames, so this is a guard against regression rather
 * than the primary fix. It is a REFUSAL and not a rename: renaming here would desynchronise
 * the mount from the signed catalogue, which names artifacts by the ref the record carries.
 */
export class ArtifactNameCollision extends Error {
  readonly collisions: Array<{ name: string; refs: string[] }>;
  constructor(collisions: Array<{ name: string; refs: string[] }>) {
    super(
      `the evidence catalogue names ${collisions.length} artifact(s) ambiguously: ` +
        collisions
          .map((c) => `${c.name} <- ${c.refs.join(", ")}`)
          .join(" | ") +
        `. A basename is the judge's whole identity for an artifact, so this would both ` +
        `overwrite evidence on the mount and duplicate entries in the signed manifest.`,
    );
    this.name = "ArtifactNameCollision";
    this.collisions = collisions;
  }
}

export interface LoadArtifactBytesResult {
  artifacts: Array<{ name: string; bytes: Uint8Array }>;
  /** How many duplicate catalogue rows were collapsed (retried steps record their captures twice). */
  duplicatesCollapsed: number;
  /**
   * HOW MANY CATALOGUE ROWS WERE SUPERSEDED BY A LIVE RECORDING.
   *
   * A retried Workflow step re-captures the same screens, so the catalogue may carry two
   * entries with the same (basename, artifactRef) but DIFFERENT contentHash values. v100's
   * dedupe only collapses identical triples. These entries differ in contentHash, so both
   * survive dedupe and the collision check fires.
   *
   * Resolution: fetch the stored blob for each competing contentHash, hash it, and keep
   * the entry whose hash matches — that is the LIVE recording. The rest are superseded
   * recordings of retried steps: their bytes may still exist in the CAS but the catalogue
   * row no longer names them for judging.
   *
   * null when no superseded recordings were found. Absence of this field is distinguishable
   * from zero: null means the resolution pass was never needed, 0 would mean it ran and
   * found nothing (which is a different fact about the catalogue's shape).
   */
  supersededRecordings: number | null;
  /**
   * Surfaced on MintedJudgement alongside duplicatesCollapsed. null when no superseded
   * recordings exist, so the report can distinguish "no retries" from "zero superseded."
   */
  supersededNote: string | null;
}

/**
 * DEDUPLICATE identical catalogue entries before the collision check.
 *
 * A Workflow step that retries re-records its captures, so the catalogue may contain N
 * entries whose (basename, artifactRef, contentHash) triple is byte-identical. Those are
 * ONE artifact recorded N times, not N ambiguous artifacts. Collapse them (keep one) and
 * count the collapse.
 *
 * A basename that maps to two DIFFERENT artifactRefs or two different contentHashes is a
 * TRUE collision — the refusal fires exactly as before.
 */
function deduplicateEvidence(evidence: EvidenceCatalogEntry[]): { deduped: EvidenceCatalogEntry[]; collapsed: number } {
  const seen = new Map<string, EvidenceCatalogEntry>();
  let collapsed = 0;
  for (const entry of evidence) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const dedupeKey = `${name}\0${ref}\0${entry.contentHash}`;
    if (seen.has(dedupeKey)) {
      collapsed += 1;
    } else {
      seen.set(dedupeKey, entry);
    }
  }
  return { deduped: [...seen.values()], collapsed };
}

/**
 * RESOLVE SUPERSEDED RECORDINGS — same (basename, artifactRef), different contentHash.
 *
 * A Workflow step retry re-captures the same screens with different pixel content, so the
 * catalogue carries two entries whose (basename, ref) pair is identical but whose contentHash
 * differs. v100's dedupe collapses identical triples; these survive it and the collision
 * check fires on what is actually a retried recording, not an ambiguous identity.
 *
 * Resolution: for each conflicting group, fetch the stored blob for each unique contentHash,
 * hash it, and keep the entry whose blob exists and verifies. That entry is the LIVE recording.
 * Entries whose blob is missing or whose stored bytes hash to something other than their
 * declared contentHash are SUPERSEDED — excluded from the mount and counted.
 *
 * If the stored bytes match NONE of the entries, this is a genuine integrity failure and the
 * existing collision error fires with extended detail naming the ref and the fact that the
 * stored object matches no signed recording.
 *
 * A basename that maps to two DIFFERENT refs keeps the existing refusal untouched — that is
 * a true collision (two different artifacts sharing a name), not a retry.
 *
 * SUBREQUEST COST: one R2 GET per conflicting ref per unique contentHash. In the worst
 * observed run (588 conflicting refs), that is at most 588 GETs when each ref has exactly
 * two competing hashes and the first one verifies. The step runs under the 10-minute
 * PROJECTION_POLICY. Bytes are hashed and discarded unless the entry is the live one that
 * will be mounted, in which case they are kept and reused for the mount to avoid a double
 * fetch.
 */
interface SupersededResolution {
  resolved: EvidenceCatalogEntry[];
  superseded: number;
  /** Bytes already fetched for live entries whose blob was verified during resolution. */
  prefetchedBytes: Map<string, Uint8Array>;
  /** Refs whose stored bytes matched no competing entry — a genuine integrity failure. */
  integrityFailures: Array<{ name: string; ref: string; triedHashes: string[] }>;
}

async function resolveSupersededRecordings(
  env: Env,
  deduped: EvidenceCatalogEntry[],
): Promise<SupersededResolution> {
  // Group entries by (basename, artifactRef).
  const groups = new Map<string, EvidenceCatalogEntry[]>();
  for (const entry of deduped) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const groupKey = `${name}\0${ref}`;
    const group = groups.get(groupKey);
    if (group) group.push(entry);
    else groups.set(groupKey, [entry]);
  }

  // Groups of size 1 have no conflict. Groups where all entries share the same contentHash
  // were already collapsed by deduplicateEvidence. Conflict groups have 2+ entries with
  // at least two distinct contentHash values AND the same artifactRef.
  const conflictGroups: Array<{ name: string; ref: string; entries: EvidenceCatalogEntry[] }> = [];
  for (const [groupKey, entries] of groups) {
    if (entries.length < 2) continue;
    const hashes = new Set(entries.map((e) => e.contentHash));
    if (hashes.size < 2) continue;
    // All entries in this group share the same ref (by construction of the groupKey).
    const refs = new Set(entries.map((e) => String(e.artifactRef ?? e.sourceEvidenceId ?? e.evidenceId)));
    if (refs.size > 1) continue; // different refs -> true collision, handled by the caller
    const parts = groupKey.split("\0");
    conflictGroups.push({ name: parts[0]!, ref: parts[1]!, entries });
  }

  if (conflictGroups.length === 0) {
    return { resolved: deduped, superseded: 0, prefetchedBytes: new Map(), integrityFailures: [] };
  }

  // Resolve each conflict group by fetching the stored blob and comparing hashes.
  const supersededIds = new Set<string>();
  const prefetchedBytes = new Map<string, Uint8Array>();
  const integrityFailures: SupersededResolution["integrityFailures"] = [];

  for (const group of conflictGroups) {
    const uniqueHashes = [...new Set(group.entries.map((e) => e.contentHash))];
    let liveEntry: EvidenceCatalogEntry | null = null;
    let liveBytes: Uint8Array | null = null;

    for (const hash of uniqueHashes) {
      const obj = await env.EVIDENCE.get(evidenceBlobKey(hash));
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const actualHash = await sha256Hex(bytes);
      if (actualHash === hash) {
        // This blob exists and verifies. The entry citing this hash is live.
        liveEntry = group.entries.find((e) => e.contentHash === hash) ?? null;
        liveBytes = bytes;
        break; // "Fetch the stored object ONCE" — stop at the first that verifies.
      }
    }

    if (!liveEntry) {
      // No blob matched any entry. Genuine integrity failure.
      integrityFailures.push({ name: group.name, ref: group.ref, triedHashes: uniqueHashes });
      continue;
    }

    // Keep the live entry, mark the rest as superseded.
    for (const entry of group.entries) {
      if (entry.evidenceId !== liveEntry.evidenceId) {
        supersededIds.add(entry.evidenceId);
      }
    }
    // Stash the bytes so the mount loop can reuse them instead of fetching twice.
    if (liveBytes) {
      prefetchedBytes.set(liveEntry.evidenceId, liveBytes);
    }
  }

  if (integrityFailures.length > 0) {
    // Convert integrity failures into a collision error with extended detail.
    const collisions = integrityFailures.map((f) => ({
      name: f.name,
      refs: [f.ref],
    }));
    throw new ArtifactNameCollision(
      collisions.map((c) => ({
        ...c,
        refs: [
          ...c.refs,
          `(stored bytes match none of ${integrityFailures.find((f) => f.name === c.name)?.triedHashes.length ?? 0} signed recording(s))`,
        ],
      })),
    );
  }

  const resolved = deduped.filter((e) => !supersededIds.has(e.evidenceId));
  return { resolved, superseded: supersededIds.size, prefetchedBytes, integrityFailures };
}

export async function loadArtifactBytes(
  env: Env,
  evidence: EvidenceCatalogEntry[],
): Promise<LoadArtifactBytesResult> {
  const { deduped, collapsed } = deduplicateEvidence(evidence);

  // SUPERSEDED RECORDING RESOLUTION: same (basename, artifactRef), different contentHash.
  // Runs AFTER dedupe (which removes identical triples) and BEFORE the collision check
  // (which refuses any basename with 2+ entries). A retried step's re-capture produces
  // entries that survive dedupe but are not true collisions — one is the live recording
  // and the rest are superseded.
  const {
    resolved,
    superseded,
    prefetchedBytes,
  } = await resolveSupersededRecordings(env, deduped);

  // The collision check now runs on the resolved list, which no longer contains superseded
  // entries. A basename mapping to two DIFFERENT refs keeps the existing refusal.
  const byName = new Map<string, string[]>();
  for (const entry of resolved) {
    const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
    const name = ref.split("/").pop() ?? entry.evidenceId;
    const refs = byName.get(name);
    if (refs) refs.push(ref);
    else byName.set(name, [ref]);
  }
  const collisions = [...byName.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([name, refs]) => ({ name, refs }));
  if (collisions.length > 0) throw new ArtifactNameCollision(collisions);

  const artifacts: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const entry of resolved) {
    const ref = entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId;
    // Reuse bytes that were already fetched and verified during superseded resolution,
    // avoiding a second R2 GET for the same blob.
    const cached = prefetchedBytes.get(entry.evidenceId);
    const bytes = cached ?? (await getVerifiedEvidence(env, entry)).bytes;
    artifacts.push({ name: String(ref).split("/").pop() ?? entry.evidenceId, bytes });
  }
  return {
    artifacts,
    duplicatesCollapsed: collapsed,
    supersededRecordings: superseded > 0 ? superseded : null,
    supersededNote: superseded > 0
      ? `${superseded} earlier recording(s) of retried steps were superseded by the bytes now in storage`
      : null,
  };
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
