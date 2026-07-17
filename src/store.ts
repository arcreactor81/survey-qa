import type { Env, RunReport } from "./types";

/**
 * Recovery bookkeeping for the stuck-run sweeper (src/sweeper.ts). All fields
 * optional and additive — envelopes written before this field existed parse
 * unchanged. The sweeper is the only writer; claims are serialized through
 * updateRun's etag guard plus the claimId check.
 */
export interface RunRecovery {
  claimId?: string; // unique per claim; verified in the post-claim read-back
  phase?: "claimed" | "restarting" | "recreating" | "failed";
  leaseUntil?: string; // ISO — while in the future, other sweeps keep hands off
  attempt?: number; // recovery attempts consumed (hard cap in sweeper)
  targetInstanceId?: string; // deterministic replacement id, persisted BEFORE create()
  startedAt?: string; // when recovery began
  reason?: string; // probe classification that triggered it
  unknownStreak?: number; // consecutive cron-separated definitive-NOT_FOUND observations
  lastUnknownAt?: string; // when the streak last advanced (enforces cron separation)
  stallValue?: string; // heartbeat fingerprint at last stall observation
  stallSeenAt?: string; // when that observation was recorded (two-strike protocol)
}

export interface RunEnvelope {
  status: "processing" | "awaiting-claude" | "complete" | "failed";
  seeded: boolean;
  lang?: string; // questionnaire/survey language (default "en")
  error?: string;
  recovery?: RunRecovery;
  report: RunReport;
}

export const runKey = (id: string) => `runs/${id}/run.json`;
export const shotKey = (id: string, i: number) => `runs/${id}/shot-${i}.png`;
export const pagePdfKey = (id: string, i: number) => `runs/${id}/page-${i}.pdf`;
export const docxKey = (id: string) => `runs/${id}/questionnaire.docx`;
/** Zero-byte sentinel marking a run the sweeper should watch (O(active) sweeps). */
export const activeMarkerKey = (id: string) => `active/${id}`;
/** Small JSON progress heartbeat written by the workflow; read by the sweeper. */
export const heartbeatKey = (id: string) => `runs/${id}/heartbeat.json`;

/**
 * Best-effort progress heartbeat. Written from INSIDE step closures (replay-safe:
 * completed steps return cached results and never re-execute, so a crash-looping
 * instance cannot self-refresh its own liveness) and from per-page compare-loop
 * callbacks. Failures are swallowed — a heartbeat must never fail a run.
 */
export async function beat(env: Env, id: string, note: string): Promise<void> {
  try {
    await env.ARTIFACTS.put(
      heartbeatKey(id),
      JSON.stringify({ at: new Date().toISOString(), note }),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch (err) {
    console.error(`heartbeat write failed for run ${id} (${note}):`, err);
  }
}

export async function getRun(env: Env, id: string): Promise<RunEnvelope | null> {
  const obj = await env.ARTIFACTS.get(runKey(id));
  return obj ? ((await obj.json()) as RunEnvelope) : null;
}

/**
 * Unconditional put. Correct for the FIRST write of a run (there is no prior
 * state to preserve) — e.g. the initial "processing" envelope, or overwriting
 * it with "failed" when the workflow never started. For any
 * getRun -> mutate -> putRun sequence that races another writer, use updateRun
 * below instead: a bare putRun there is last-writer-wins and can silently drop
 * a concurrent writer's findings/status.
 */
export async function putRun(env: Env, id: string, envelope: RunEnvelope): Promise<void> {
  await env.ARTIFACTS.put(runKey(id), JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Optimistic-concurrency read-modify-write for a run envelope. Reads the
 * current envelope, hands it to `mutate`, and conditionally writes it back
 * guarded by the R2 object's etag ({ onlyIf: { etagMatches } }). R2 returns
 * null (it does NOT throw) when the precondition fails — meaning another writer
 * updated the object between our read and write — so we re-read and re-apply
 * the mutation. This closes the finalize-retry-vs-runner-POST race that a bare
 * getRun -> mutate -> putRun would lose (last-writer-wins).
 *
 * `mutate` may return `false` to abort the write (e.g. the envelope is already
 * terminal and must not be clobbered); in that case the current, unmodified
 * envelope is returned without a write. Returns null when the run does not
 * exist. In the uncontended common case (single writer — the demo path) the
 * first attempt's precondition holds and this behaves like getRun + putRun.
 */
export async function updateRun(
  env: Env,
  id: string,
  mutate: (envelope: RunEnvelope) => boolean | void,
): Promise<RunEnvelope | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const obj = await env.ARTIFACTS.get(runKey(id));
    if (!obj) return null;
    const envelope = (await obj.json()) as RunEnvelope;
    const proceed = mutate(envelope);
    if (proceed === false) return envelope; // mutator opted out — no write
    const written = await env.ARTIFACTS.put(runKey(id), JSON.stringify(envelope), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: obj.etag },
    });
    if (written !== null) return envelope; // our write won the race
    // Precondition failed: a concurrent writer changed run.json. Re-read and
    // re-apply the mutation against the fresh state.
  }
  throw new Error(`updateRun: persistent write contention on ${runKey(id)} (exhausted retries)`);
}
