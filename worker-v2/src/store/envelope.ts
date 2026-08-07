/**
 * Run envelope persistence. Same etag-guarded CAS discipline as the checkpoint, for the
 * same reason (prod's `updateRun`), but a different object: the envelope carries the
 * run's IDENTITY and RECOVERY bookkeeping, the checkpoint carries its LIVE STATE.
 *
 * Splitting them is deliberate. In v1 they were one document, so the sweeper's recovery
 * claim and the workflow's progress write contended on the same object every few seconds.
 * Here the sweeper only ever writes the envelope and the workflow only ever writes the
 * checkpoint, so the CAS retry path is rare rather than routine.
 */

import type { Env } from "../types/env";
import { ENVELOPE_KIND, type RunEnvelopeV2 } from "../types/record";
import { envelopeKey, activeMarkerKey } from "../keys";
import { assertV2RunId } from "../ids";

export class NotAV2Envelope extends Error {
  constructor(runId: string) {
    super(`envelope for ${runId} is missing the "${ENVELOPE_KIND}" discriminator; refusing to interpret it`);
    this.name = "NotAV2Envelope";
  }
}

export async function getEnvelope(env: Env, runId: string): Promise<RunEnvelopeV2 | null> {
  assertV2RunId(runId);
  const obj = await env.EVIDENCE.get(envelopeKey(runId));
  if (!obj) return null;
  const parsed = JSON.parse(await obj.text()) as RunEnvelopeV2;
  // Prod parses run.json with a bare cast. v2 checks, so that a foreign or corrupted
  // document produces a loud error instead of a plausible-looking run.
  if (parsed.kind !== ENVELOPE_KIND) throw new NotAV2Envelope(runId);
  return parsed;
}

export async function putEnvelope(env: Env, envelope: RunEnvelopeV2): Promise<void> {
  await env.EVIDENCE.put(envelopeKey(envelope.runId), JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function updateEnvelope(
  env: Env,
  runId: string,
  mutate: (envelope: RunEnvelopeV2) => boolean | void,
): Promise<RunEnvelopeV2 | null> {
  assertV2RunId(runId);
  const key = envelopeKey(runId);
  for (let attempt = 0; attempt < 6; attempt++) {
    const obj = await env.EVIDENCE.get(key);
    if (!obj) return null;
    const envelope = JSON.parse(await obj.text()) as RunEnvelopeV2;
    if (envelope.kind !== ENVELOPE_KIND) throw new NotAV2Envelope(runId);
    if (mutate(envelope) === false) return envelope;
    const written = await env.EVIDENCE.put(key, JSON.stringify(envelope), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: obj.etag },
    });
    if (written !== null) return envelope;
  }
  throw new Error(`updateEnvelope: persistent write contention on ${key}`);
}

/** Zero-byte marker so the v2 sweeper is O(active runs), not O(all runs). */
export async function markActive(env: Env, runId: string): Promise<void> {
  await env.EVIDENCE.put(activeMarkerKey(runId), "");
}

export async function clearActive(env: Env, runId: string): Promise<void> {
  await env.EVIDENCE.delete(activeMarkerKey(runId));
}
