/**
 * THE RUN'S CHECKLIST — the extraction stage's own obligation set, kept for the judge.
 *
 * The sealed ContractRevision is the denominator, but it is not sufficient input for the
 * judging engine: it seals ambiguities as TOKENS (digests), and the engine's withholding
 * policy needs the two competing READINGS behind each token. A digest cannot be un-hashed,
 * so if extraction does not keep its checklist, no later stage can reconstruct one that
 * withholds anything.
 *
 * This is therefore a CONTRACT BETWEEN STAGES, stated here because the judging side is what
 * breaks without it: the extraction stage writes its checklist to `v2/runs/<id>/checklist.json`
 * with the shape `pipeline/judge/lib/compile.mjs` compiles — `{ obligations[], ambiguities[],
 * unverifiable_from_browser[] }`. When it is absent the judging stage falls back to
 * projecting one from the sealed revision and REPORTS that it did, along with the fact that
 * the ambiguity policy had nothing to act on.
 *
 * The key is minted through `k()` like every other v2 key, so it cannot escape the `v2/`
 * namespace even though it is defined outside `keys.ts`.
 */

import type { Env } from "../../types/env";
import { k } from "../../keys";

export const runChecklistKey = (runId: string) => k("runs", runId, "checklist.json");

/** Absent or unparseable ⇒ null. The caller projects a fallback and says so. */
export async function readRunChecklist(env: Env, runId: string): Promise<unknown | null> {
  const obj = await env.EVIDENCE.get(runChecklistKey(runId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

export async function writeRunChecklist(env: Env, runId: string, checklist: unknown): Promise<void> {
  await env.EVIDENCE.put(runChecklistKey(runId), JSON.stringify(checklist), {
    httpMetadata: { contentType: "application/json" },
  });
}
