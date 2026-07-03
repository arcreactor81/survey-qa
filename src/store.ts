import type { Env, RunReport } from "./types";

export interface RunEnvelope {
  status: "processing" | "awaiting-claude" | "complete" | "failed";
  seeded: boolean;
  lang?: string; // questionnaire/survey language (default "en")
  error?: string;
  report: RunReport;
}

export const runKey = (id: string) => `runs/${id}/run.json`;
export const shotKey = (id: string, i: number) => `runs/${id}/shot-${i}.png`;
export const pagePdfKey = (id: string, i: number) => `runs/${id}/page-${i}.pdf`;
export const docxKey = (id: string) => `runs/${id}/questionnaire.docx`;

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
