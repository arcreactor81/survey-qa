// Stuck-run sweeper: the cron-driven half of the recovery plan. Every tick it
// (1) sweeps the O(active) `active/{runId}` marker set, probing each still-
// "processing" run against the Workflow engine's authoritative instance
// status, and (2) advances a small rolling audit over ALL runs as the safety
// net for any run whose marker write failed.
//
// Probe semantics were characterized live against the real runtime (Phase 0,
// 17 Jul 2026): RUN_WORKFLOW.get() on an unknown id REJECTS with an Error
// whose message carries the stable code "(instance.not_found)"; terminate()
// settles to "terminated" within seconds; restart() WORKS on a terminated
// instance (re-queues it). Transport errors look different and are NEVER
// treated as evidence.
//
// Recovery ladder (owner-locked decisions): claim via etag-guarded updateRun
// (claimId verified in the read-back) -> rung (a) restart() the existing
// instance -> rung (b) create a fresh `${runId}-r{n}` instance from params
// reconstructed out of the envelope (DOCX preflighted; target id persisted
// BEFORE create; ambiguous create outcomes re-probed and adopted) -> rung (c)
// honest failure carrying the engine's own error detail. One recovery attempt
// per run, regardless of age. `awaiting-claude` runs are exempt by
// construction: the sweeper only ever acts on status === "processing".

import {
  getRun,
  updateRun,
  activeMarkerKey,
  heartbeatKey,
  docxKey,
  runKey,
  type RunEnvelope,
} from "./store";
import type { Env } from "./types";
import type { RunParams } from "./workflow";

const MIN_AGE_MS = 15 * 60 * 1000; // ignore runs younger than this entirely
const STALL_MS = 45 * 60 * 1000; // heartbeat silence => stall candidate (45 min, owner decision 2)
const OBSERVATION_GAP_MS = 4 * 60 * 1000; // two stall/unknown observations must be cron-separated
const UNKNOWN_FLOOR_MS = 8 * 60 * 60 * 1000; // no action on NOT_FOUND evidence before 8h age
const UNKNOWN_STREAK_NEEDED = 2;
const RECOVERY_GRACE_MS = 30 * 60 * 1000; // an in-flight recovery is untouchable this long
const MAX_ATTEMPTS = 1; // owner decision: one automatic recovery attempt per run
const AUDIT_RUNS_PER_SWEEP = 8; // rolling-audit GET budget per tick
const AUDIT_CURSOR_KEY = "sweeper/audit-cursor.json";

interface ProbeResult {
  kind: "status" | "not_found" | "transport";
  status?: string;
  error?: { name?: string; message?: string } | null;
  detail?: string;
}

async function probeInstance(env: Env, instanceId: string): Promise<ProbeResult> {
  try {
    const inst = await env.RUN_WORKFLOW.get(instanceId);
    const st = await inst.status();
    return { kind: "status", status: st.status, error: st.error ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stable engine code observed live: "(instance.not_found) Instance not found".
    if (msg.includes("instance.not_found")) return { kind: "not_found", detail: msg };
    return { kind: "transport", detail: msg };
  }
}

async function readHeartbeat(
  env: Env,
  runId: string,
): Promise<{ at: string; note: string } | null> {
  try {
    const obj = await env.ARTIFACTS.get(heartbeatKey(runId));
    if (!obj) return null;
    const hb = (await obj.json()) as { at?: unknown; note?: unknown };
    if (typeof hb.at !== "string") return null;
    return { at: hb.at, note: typeof hb.note === "string" ? hb.note : "" };
  } catch {
    return null; // unreadable heartbeat is "no data", never evidence
  }
}

async function deleteMarker(env: Env, runId: string): Promise<void> {
  try {
    await env.ARTIFACTS.delete(activeMarkerKey(runId));
  } catch (err) {
    console.error(`sweeper: marker delete failed for ${runId}:`, err);
  }
}

/** Reconstruct the workflow params for a recreate from the persisted envelope. */
function paramsFromEnvelope(runId: string, envelope: RunEnvelope): RunParams {
  return {
    runId,
    surveyUrl: envelope.report.surveyUrl,
    docxName: envelope.report.docxName,
    seeded: envelope.seeded,
    lang: envelope.lang,
  };
}

/**
 * The recovery ladder for a run whose instance is confirmed dead (or gone).
 * `deadInstanceId` is the instance we probed; null means NOT_FOUND (rung (a)
 * impossible). `engineError` carries the errored instance's own error detail
 * for the honest-failure message.
 */
async function runLadder(
  env: Env,
  runId: string,
  reason: string,
  deadInstanceId: string | null,
  engineError: { name?: string; message?: string } | null,
  now: Date,
): Promise<string> {
  const claimId = crypto.randomUUID();
  const nowIso = now.toISOString();
  let exhausted = false;
  const claimed = await updateRun(env, runId, (envelope) => {
    if (envelope.status !== "processing") return false;
    const rec = envelope.recovery ?? {};
    // An unexpired lease means another sweep (or an overlapping tick) owns it.
    if (rec.leaseUntil && Date.parse(rec.leaseUntil) > now.getTime()) return false;
    if ((rec.attempt ?? 0) >= MAX_ATTEMPTS) {
      exhausted = true;
      return false;
    }
    const attempt = (rec.attempt ?? 0) + 1;
    envelope.recovery = {
      ...rec,
      claimId,
      phase: "claimed",
      leaseUntil: new Date(now.getTime() + RECOVERY_GRACE_MS).toISOString(),
      attempt,
      targetInstanceId: `${runId}-r${attempt}`, // persisted BEFORE create()
      startedAt: nowIso,
      reason,
    };
    return;
  });
  if (!claimed) return "gone";
  if (exhausted) {
    // Attempt already consumed and the run is dead again: honest failure.
    return honestFail(env, runId, reason, engineError, now, "recovery attempt exhausted");
  }
  if (claimed.recovery?.claimId !== claimId) return "lost-claim";
  const target = claimed.recovery.targetInstanceId ?? `${runId}-r1`;

  // Rung (a): engine-native restart of the existing (errored/terminated/stale-
  // complete) instance. Proven live for terminated instances.
  if (deadInstanceId) {
    try {
      const inst = await env.RUN_WORKFLOW.get(deadInstanceId);
      await (inst as unknown as { restart: () => Promise<void> }).restart();
      await updateRun(env, runId, (envelope) => {
        if (envelope.recovery?.claimId !== claimId) return false;
        envelope.recovery.phase = "restarting";
      });
      console.log(`sweeper: restarted instance ${deadInstanceId} for run ${runId} (${reason})`);
      return "restarted";
    } catch (err) {
      console.log(
        `sweeper: restart() unavailable for ${deadInstanceId} (${String(err).slice(0, 200)}); trying recreate`,
      );
    }
  }

  // Rung (b): recreate under the pre-persisted deterministic id. Preflight the
  // DOCX — without it a fresh pipeline cannot run and rung (c) is honest.
  const docx = await env.ARTIFACTS.get(docxKey(runId));
  if (docx === null) {
    return honestFail(env, runId, reason, engineError, now, "questionnaire artifact no longer exists");
  }
  try {
    await env.RUN_WORKFLOW.create({ id: target, params: paramsFromEnvelope(runId, claimed) });
    await updateRun(env, runId, (envelope) => {
      if (envelope.recovery?.claimId !== claimId) return false;
      envelope.recovery.phase = "recreating";
    });
    console.log(`sweeper: recreated run ${runId} as instance ${target} (${reason})`);
    return "recreated";
  } catch (err) {
    // Ambiguous create (thrown but possibly landed, or a crashed prior claim's
    // orphan): re-probe the target and ADOPT it if it exists in any live state.
    const probe = await probeInstance(env, target);
    if (probe.kind === "status" && probe.status && !["errored", "terminated"].includes(probe.status)) {
      await updateRun(env, runId, (envelope) => {
        if (envelope.recovery?.claimId !== claimId) return false;
        envelope.recovery.phase = "recreating";
      });
      console.log(`sweeper: adopted existing replacement ${target} for run ${runId}`);
      return "adopted";
    }
    return honestFail(
      env,
      runId,
      reason,
      engineError,
      now,
      `replacement create failed: ${String(err).slice(0, 200)}`,
    );
  }
}

async function honestFail(
  env: Env,
  runId: string,
  reason: string,
  engineError: { name?: string; message?: string } | null,
  now: Date,
  extra: string,
): Promise<string> {
  const engineDetail = engineError?.message
    ? ` Engine error: ${engineError.name ?? "Error"}: ${engineError.message}.`
    : "";
  await updateRun(env, runId, (envelope) => {
    if (envelope.status !== "processing") return false;
    envelope.status = "failed";
    envelope.error =
      `the analysis workflow stopped unexpectedly and automatic recovery was not possible ` +
      `(${reason}; ${extra}).${engineDetail}`;
    envelope.report.finishedAt = now.toISOString();
    envelope.recovery = { ...(envelope.recovery ?? {}), phase: "failed" };
  });
  await deleteMarker(env, runId);
  console.log(`sweeper: honestly failed run ${runId} (${reason}; ${extra})`);
  return "failed";
}

/**
 * Evaluate one run. Terminal/settled runs just get their marker cleaned.
 * Only status === "processing" is ever probed or acted on.
 */
export async function sweepRun(env: Env, runId: string, now: Date): Promise<string> {
  const envelope = await getRun(env, runId);
  if (!envelope) {
    await deleteMarker(env, runId);
    return "no-envelope";
  }
  if (envelope.status !== "processing") {
    await deleteMarker(env, runId); // complete / failed / awaiting-claude: not ours
    return "settled";
  }
  const startedMs = Date.parse(envelope.report.startedAt || "");
  if (!Number.isFinite(startedMs)) return "bad-startedAt";
  const ageMs = now.getTime() - startedMs;
  if (ageMs < MIN_AGE_MS) return "young";

  // An in-flight recovery holds a lease; hands off until it expires.
  const rec = envelope.recovery;
  if (rec?.leaseUntil && Date.parse(rec.leaseUntil) > now.getTime()) return "leased";

  // After a recreate, the authoritative instance is the replacement.
  const instanceId =
    rec?.phase === "recreating" && rec.targetInstanceId ? rec.targetInstanceId : runId;
  const probe = await probeInstance(env, instanceId);

  if (probe.kind === "transport") return "transport-error"; // never evidence

  if (probe.kind === "not_found") {
    // Definitive NOT_FOUND: slow-evidence protocol — two cron-separated
    // observations AND an 8h age floor before any action; then a genuine
    // recovery attempt (recreate) before honest failure. (Owner decision 4:
    // even very old runs get their one attempt.)
    let ready = false;
    await updateRun(env, runId, (env2) => {
      if (env2.status !== "processing") return false;
      const r = env2.recovery ?? {};
      const last = r.lastUnknownAt ? Date.parse(r.lastUnknownAt) : 0;
      if (now.getTime() - last < OBSERVATION_GAP_MS) {
        ready = (r.unknownStreak ?? 0) >= UNKNOWN_STREAK_NEEDED && ageMs >= UNKNOWN_FLOOR_MS;
        return false; // same-tick duplicate; don't advance the streak
      }
      r.unknownStreak = (r.unknownStreak ?? 0) + 1;
      r.lastUnknownAt = now.toISOString();
      env2.recovery = r;
      ready = r.unknownStreak >= UNKNOWN_STREAK_NEEDED && ageMs >= UNKNOWN_FLOOR_MS;
    });
    if (!ready) return "unknown-observed";
    // Final probe immediately before acting.
    const confirm = await probeInstance(env, instanceId);
    if (confirm.kind !== "not_found") return "unknown-recanted";
    return runLadder(env, runId, "workflow instance not found", null, null, now);
  }

  // probe.kind === "status"
  const st = probe.status ?? "unknown";
  if (st === "errored" || st === "terminated") {
    return runLadder(env, runId, `workflow instance ${st}`, instanceId, probe.error ?? null, now);
  }
  if (st === "complete") {
    // Engine finished but the envelope never left "processing" — finalize's
    // write demonstrably didn't land. Ladder: restart the instance so its
    // (idempotent, guard-protected) pipeline re-lands the result.
    return runLadder(env, runId, "instance complete but run never finalized", instanceId, null, now);
  }
  if (st === "paused") return "paused"; // operator territory — untouched
  if (["queued", "running", "waiting", "waitingForPause", "unknown"].includes(st)) {
    // Engine says alive: check for the running-but-hung class via heartbeat.
    const hb = await readHeartbeat(env, runId);
    const hbAt = hb ? Date.parse(hb.at) : startedMs; // no heartbeat yet: baseline = start
    const silenceMs = now.getTime() - (Number.isFinite(hbAt) ? hbAt : startedMs);
    const fingerprint = hb ? `${hb.at}|${hb.note}` : "none";
    if (silenceMs < STALL_MS) {
      // Healthy(ish): clear any stale evidence so old observations can't
      // combine with a much later stall into a false positive.
      if (rec?.stallValue || rec?.unknownStreak) {
        await updateRun(env, runId, (env2) => {
          if (env2.status !== "processing" || !env2.recovery) return false;
          delete env2.recovery.stallValue;
          delete env2.recovery.stallSeenAt;
          delete env2.recovery.unknownStreak;
          delete env2.recovery.lastUnknownAt;
        });
      }
      return "alive";
    }
    // Stall candidate: two-strike protocol on an UNCHANGED heartbeat.
    const prevValue = rec?.stallValue;
    const prevSeen = rec?.stallSeenAt ? Date.parse(rec.stallSeenAt) : 0;
    if (prevValue === fingerprint && now.getTime() - prevSeen >= OBSERVATION_GAP_MS) {
      // Confirmed stall: terminate, confirm, recover.
      try {
        const inst = await env.RUN_WORKFLOW.get(instanceId);
        await inst.terminate();
      } catch (err) {
        console.log(`sweeper: stall terminate failed for ${instanceId}: ${String(err).slice(0, 200)}`);
        return "stall-terminate-failed"; // try again next tick
      }
      // Let termination settle, then confirm before recovering.
      for (let i = 0; i < 8; i++) {
        const check = await probeInstance(env, instanceId);
        if (check.kind === "status" && check.status === "terminated") {
          return runLadder(
            env,
            runId,
            `instance hung (no progress for ${Math.round(silenceMs / 60000)} min; stopped at: ${hb?.note ?? "start"})`,
            instanceId,
            null,
            now,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return "stall-terminate-unsettled";
    }
    // First strike (or the heartbeat moved): record the observation.
    await updateRun(env, runId, (env2) => {
      if (env2.status !== "processing") return false;
      env2.recovery = { ...(env2.recovery ?? {}), stallValue: fingerprint, stallSeenAt: now.toISOString() };
    });
    return "stall-observed";
  }
  return `unhandled-status-${st}`;
}

/** One cron tick: marker sweep + rolling audit. Bounded work per invocation. */
export async function sweepActive(env: Env, now: Date): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};

  // 1. O(active) marker sweep. Paginate defensively; if a pathological number
  // of markers ever exceeds the per-tick bound, persist the cursor so the NEXT
  // tick resumes where this one stopped instead of starving the tail.
  let cursorState: { auditCursor?: string; activeCursor?: string } = {};
  try {
    const cur = await env.ARTIFACTS.get(AUDIT_CURSOR_KEY);
    if (cur) cursorState = (await cur.json()) as typeof cursorState;
  } catch {
    cursorState = {}; // unreadable cursor state: restart both scans from the top
  }
  let cursor: string | undefined = cursorState.activeCursor;
  const ids: string[] = [];
  do {
    const listed = await env.ARTIFACTS.list({ prefix: "active/", cursor, limit: 100 });
    for (const obj of listed.objects) ids.push(obj.key.slice("active/".length));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && ids.length < 1000);
  cursorState.activeCursor = cursor; // undefined when the listing was exhausted
  for (const id of ids) {
    try {
      outcomes[id] = await sweepRun(env, id, now);
    } catch (err) {
      outcomes[id] = `error: ${String(err).slice(0, 200)}`;
      console.error(`sweeper: sweepRun(${id}) threw:`, err);
    }
  }

  // 2. Rolling audit: a bounded page of ALL runs per tick, catching any
  // processing run whose marker write failed. The list limit EQUALS the
  // inspection budget so the persisted cursor never points past uninspected
  // prefixes (under prefix "runs/" + delimiter "/" every immediate child is a
  // run prefix, so a limit-N page yields at most N prefixes, all inspected).
  // Cursor persists across ticks; wraps to the start when exhausted.
  try {
    const listed = await env.ARTIFACTS.list({
      prefix: "runs/",
      delimiter: "/",
      cursor: cursorState.auditCursor,
      limit: AUDIT_RUNS_PER_SWEEP,
    });
    const prefixes = listed.delimitedPrefixes ?? [];
    for (const p of prefixes) {
      const id = p.slice("runs/".length).replace(/\/$/, "");
      if (!id || outcomes[id] !== undefined) continue; // already swept via marker
      try {
        const envx = await getRun(env, id);
        if (envx && envx.status === "processing") {
          // Marker was missing for a live run: restore it, then sweep.
          try {
            await env.ARTIFACTS.put(activeMarkerKey(id), new Uint8Array(0));
          } catch { /* marker restore is best-effort */ }
          outcomes[id] = `audit:${await sweepRun(env, id, now)}`;
        }
      } catch (err) {
        console.error(`sweeper: audit of ${id} threw:`, err);
      }
    }
    cursorState.auditCursor = listed.truncated ? listed.cursor : undefined; // undefined wraps
    await env.ARTIFACTS.put(AUDIT_CURSOR_KEY, JSON.stringify(cursorState), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    console.error("sweeper: rolling audit failed this tick:", err);
  }

  if (Object.keys(outcomes).length > 0) {
    console.log(`sweeper tick: ${JSON.stringify(outcomes)}`);
  }
  return outcomes;
}
