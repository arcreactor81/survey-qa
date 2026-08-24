/**
 * tools/replay-driver.mjs — the one place a replay stage is driven over HTTP.
 *
 * Shared by `replay.mjs` (interactive stage runs) and `gate-loop.mjs` (whole-tail
 * attempts with an attempt report). One driver, one timeout policy, one wire shape —
 * two tools disagreeing about how to call the bench was the next copy-drift waiting
 * to happen after the fence-test incident.
 */

export const ALL_STAGES = [
  "seed",
  "project-observations",
  "verify-observations",
  "derive-verdicts",
  "assemble-record",
  "mint-judgement",
  "supersede-record",
  "report",
];

/**
 * Drive one stage on the bench worker. Returns { result, durationMs, body | errorMessage }.
 *
 * Node's fetch (undici) has its OWN headers/body timeouts of 300s that fire BEFORE the
 * AbortSignal — measured: a stage reported "crash: fetch failed" at 305s while it completed
 * fine on the worker. The per-request dispatcher raises those to the same 10-minute ceiling
 * the AbortSignal (and the prod Workflow step policy) uses.
 */
export async function driveStage({ workerUrl, token, sourceRunId, replayRunId, stage }) {
  const startMs = Date.now();
  try {
    const { Agent } = await import("undici");
    const dispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });
    const res = await fetch(`${workerUrl}/api/replay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sourceRunId, replayRunId, stage }),
      signal: AbortSignal.timeout(600_000),
      dispatcher,
    });
    const body = await res.json();
    const durationMs = body.durationMs ?? Date.now() - startMs;
    if (res.ok && body.result === "ok") {
      return { result: "ok", durationMs, body };
    }
    return {
      result: "error",
      durationMs,
      body,
      errorMessage: (body.errorMessage || body.errorName || "unknown error").slice(0, 500),
    };
  } catch (err) {
    return {
      result: "crash",
      durationMs: Date.now() - startMs,
      body: null,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}
