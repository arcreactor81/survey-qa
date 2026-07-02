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
 * CONCURRENCY NOTE (known limitation): this is an unconditional put, so every
 * getRun -> mutate -> putRun sequence (findings submission in index.ts, the
 * workflow finalize/catch writes) is last-writer-wins. Two overlapping writers
 * — e.g. a duplicate runner POST, or a workflow finalize retry racing the
 * runner — can silently drop the other's findings/status update. Acceptable
 * for the single-user demo where the runner is invoked once, serially, after
 * the walk completes (and a lost submission can simply be re-POSTed).
 *
 * Production fix (deliberately not done here to keep getRun/putRun signatures
 * stable): have getRun also return the R2 object's httpEtag and pass it to
 * put() via { onlyIf: { etagMatches } }; R2 returns null (it does not throw)
 * when the precondition fails, so on null re-read, re-apply the mutation, and
 * retry.
 */
export async function putRun(env: Env, id: string, envelope: RunEnvelope): Promise<void> {
  await env.ARTIFACTS.put(runKey(id), JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
}
