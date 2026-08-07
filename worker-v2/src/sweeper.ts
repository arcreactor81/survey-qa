/**
 * v2 STUCK-RUN SWEEPER — the recovery pattern from src/sweeper.ts, carried forward with
 * its hard-won runtime facts intact and re-pointed at the v2 namespace.
 *
 * WHAT IS CARRIED FORWARD (these were characterized against the live runtime on 17 Jul
 * 2026 and are not re-derivable from documentation):
 *   - `WORKFLOW.get()` on an unknown id REJECTS with an Error whose message carries the
 *     stable code "(instance.not_found)". A transport error looks different and is NEVER
 *     treated as evidence of anything.
 *   - `restart()` works on a terminated instance and re-queues it — so rung (a) is cheap.
 *   - Claim-then-verify: claim via an etag-guarded update, then READ BACK and check the
 *     claimId, because two cron ticks can overlap.
 *   - Two-strike protocol with cron separation before acting on a stall, and an 8-hour
 *     floor before NOT_FOUND is believed.
 *   - The target instance id is persisted BEFORE create(), so an ambiguous create outcome
 *     can be re-probed and ADOPTED instead of spawning a second worker on the same run.
 *   - One automatic recovery attempt per run.
 *
 * WHAT CHANGES FOR V2, and why:
 *   - It enumerates `v2/active/`, holds `V2_RUN_WORKFLOW`, and every key goes through the
 *     v2 key minter. A v1 sweeper physically cannot probe a v2 instance and vice versa —
 *     they hold different Workflow bindings pointing at differently-named Workflows.
 *   - Liveness is judged on TWO signals, not one: the heartbeat AND the checkpoint's
 *     `lastProgressAt`. v1 could only see the heartbeat, so a process that was beating
 *     while making no progress looked healthy. A heartbeat is not progress.
 *   - It also runs the prefix-scoped retention sweep, in report-only mode by default.
 */

import type { Env } from "./types/env";
import { num } from "./types/env";
import { activeMarkerKey, k } from "./keys";
import { recoveryInstanceId } from "./ids";
import { getEnvelope, updateEnvelope } from "./store/envelope";
import { claimOwnership, loadCheckpoint, readHeartbeat, updateCheckpoint } from "./store/checkpoint";
import { planRetention, writeRetentionReport } from "./store/retention";
import { isTerminalTest } from "./types/contracts";
import type { RunParamsV2 } from "./workflow/run-workflow";

const MIN_AGE_MS = 15 * 60 * 1000;
/** No heartbeat AND no durable progress for this long: the instance is gone. */
const SILENT_MS = 45 * 60 * 1000;
/**
 * NO DURABLE PROGRESS for this long is a stall EVEN IF THE HEARTBEAT IS FRESH.
 *
 * The old test was `now - max(lastBeat, lastProgress) < STALL_MS => healthy`, which is
 * exactly the failure this worker's own §3.3 warns about ("a heartbeat is not progress"):
 * an instance stuck in a retry loop, or spinning on a page that never advances, beats
 * happily forever and the max() hides indefinitely stale durable progress behind it. The
 * two ages are now assessed SEPARATELY — a fresh heartbeat with a two-hour-old checkpoint
 * is a stall with a liveness signal, which is a different and more urgent thing than
 * silence.
 */
const NO_PROGRESS_MS = 90 * 60 * 1000;
const OBSERVATION_GAP_MS = 4 * 60 * 1000;
const UNKNOWN_FLOOR_MS = 8 * 60 * 60 * 1000;
const UNKNOWN_STREAK_NEEDED = 2;
const RECOVERY_GRACE_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 1;
const ACTIVE_PER_SWEEP = 25;

interface ProbeResult {
  kind: "status" | "not_found" | "transport";
  status?: string;
  error?: { name?: string; message?: string } | null;
  detail?: string;
}

async function probeInstance(env: Env, instanceId: string): Promise<ProbeResult> {
  try {
    const inst = await env.V2_RUN_WORKFLOW.get(instanceId);
    const st = await inst.status();
    return { kind: "status", status: String(st.status), error: (st.error as ProbeResult["error"]) ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("instance.not_found")) return { kind: "not_found", detail: msg.slice(0, 300) };
    // Anything else is a transport/platform problem. Never evidence about the run.
    return { kind: "transport", detail: msg.slice(0, 300) };
  }
}

/** One sweep tick: recover stuck runs, then advance the retention sweep. */
export async function sweep(env: Env, now: Date): Promise<Record<string, unknown>> {
  const results: Record<string, string> = {};
  let cursor: string | undefined;
  let seen = 0;

  do {
    const page = await env.EVIDENCE.list({ prefix: k("active") + "/", cursor, limit: ACTIVE_PER_SWEEP });
    for (const obj of page.objects) {
      if (seen >= ACTIVE_PER_SWEEP) break;
      seen++;
      const runId = obj.key.slice(obj.key.lastIndexOf("/") + 1);
      try {
        results[runId] = await sweepRun(env, runId, now);
      } catch (err) {
        results[runId] = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    cursor = page.truncated && seen < ACTIVE_PER_SWEEP ? page.cursor : undefined;
  } while (cursor);

  // Retention: report-only unless RETENTION_MODE=delete. `null` referenced-hash set means
  // no content-addressed blob is ever reported eligible — fail safe by construction.
  let retention: unknown = null;
  try {
    const plan = await planRetention(env, now, null, num(env.RETENTION_SCAN_BUDGET, 500));
    const key = await writeRetentionReport(env, plan);
    retention = { mode: plan.policy.mode, scanned: plan.scanned, eligible: plan.eligible.length, deleted: plan.deleted, report: key };
  } catch (err) {
    retention = { error: err instanceof Error ? err.message : String(err) };
  }

  return { swept: seen, results, retention };
}

export async function sweepRun(env: Env, runId: string, now: Date): Promise<string> {
  const envelope = await getEnvelope(env, runId);
  if (!envelope) {
    await env.EVIDENCE.delete(activeMarkerKey(runId));
    return "no-envelope-marker-cleared";
  }

  const loaded = await loadCheckpoint(env, runId);
  if (!loaded) return "no-checkpoint";
  const cp = loaded.checkpoint;

  // Terminal runs are never acted on. v1's equivalent guard was `status === "processing"`;
  // v2 asks the completion axis, which is the field that actually means "still going".
  if (isTerminalTest(cp.completion.test)) {
    await env.EVIDENCE.delete(activeMarkerKey(runId));
    return `terminal:${cp.completion.test}`;
  }

  const ageMs = now.getTime() - Date.parse(envelope.createdAt);
  if (ageMs < MIN_AGE_MS) return "too-young";

  const rec = envelope.recovery ?? {};
  if (rec.leaseUntil && Date.parse(rec.leaseUntil) > now.getTime()) return "recovery-in-flight";

  // EXHAUSTED RECOVERY IS TERMINAL, NOT A PERMANENT SHRUG.
  //
  // This used to `return "attempts-exhausted"` on every tick, forever: the run stayed
  // non-terminal, kept its `active/` marker, kept being enumerated by every sweep, and
  // kept showing as an in-progress test to every reader — while nothing was ever going to
  // move it again. One automatic attempt is the policy; the consequence of spending it
  // without success is a FAILED run, and saying so is the whole point of the two-axis
  // model. The grace window is honoured first so a replacement that is still starting up
  // is not declared dead.
  if ((rec.attempt ?? 0) >= MAX_ATTEMPTS && rec.phase !== "failed") {
    const since = rec.startedAt ? Date.parse(rec.startedAt) : 0;
    if (since && now.getTime() - since < RECOVERY_GRACE_MS) return "attempts-exhausted-in-grace";
    const beat = await readHeartbeat(env, runId);
    const beatAge = beat ? now.getTime() - Date.parse(beat.at) : Number.POSITIVE_INFINITY;
    const progressAge = now.getTime() - Date.parse(cp.lastProgressAt);
    if (beatAge < SILENT_MS && progressAge < NO_PROGRESS_MS) return "attempts-exhausted-but-progressing";
    return failRun(
      env,
      runId,
      `automatic recovery is exhausted (${rec.attempt ?? 0} of ${MAX_ATTEMPTS} attempt(s) used) and the ` +
        `replacement made no durable progress for ${Math.round(progressAge / 60000)} minute(s). ` +
        `Last recovery reason: ${rec.reason ?? "unknown"}.`,
    );
  }

  const probe = await probeInstance(env, envelope.instanceId);
  if (probe.kind === "transport") return "transport-error"; // never evidence

  if (probe.kind === "not_found") {
    if (ageMs < UNKNOWN_FLOOR_MS) return "unknown-below-floor";
    const streak = (rec.unknownStreak ?? 0) + 1;
    const lastAt = rec.lastUnknownAt ? Date.parse(rec.lastUnknownAt) : 0;
    if (lastAt && now.getTime() - lastAt < OBSERVATION_GAP_MS) return "unknown-not-cron-separated";
    await updateEnvelope(env, runId, (e) => {
      e.recovery = { ...(e.recovery ?? {}), unknownStreak: streak, lastUnknownAt: now.toISOString() };
    });
    if (streak < UNKNOWN_STREAK_NEEDED) return `unknown-streak-${streak}`;
    return runLadder(env, runId, "instance not found", null, now);
  }

  const st = probe.status ?? "unknown";
  if (st === "errored" || st === "terminated") {
    return runLadder(env, runId, `workflow instance ${st}`, envelope.instanceId, now);
  }

  // Running, but is it PROGRESSING? TWO AGES, ASSESSED SEPARATELY (§3.3).
  //
  //   beatAge     — how long since the instance said anything at all (liveness).
  //   progressAge — how long since a COMMITTED artifact or state change (progress).
  //
  // Taking max() of the two, as this used to, means a healthy heartbeat can mask durable
  // progress that stopped hours ago. They answer different questions and each gets its own
  // threshold and its own name in the return value, so an operator reading a sweep log can
  // tell "gone" from "stuck but alive".
  const hb = await readHeartbeat(env, runId);
  const beatAge = hb ? now.getTime() - Date.parse(hb.at) : Number.POSITIVE_INFINITY;
  const progressAge = now.getTime() - Date.parse(cp.lastProgressAt);

  const silent = beatAge >= SILENT_MS && progressAge >= SILENT_MS;
  const stalledButBeating = beatAge < SILENT_MS && progressAge >= NO_PROGRESS_MS;
  if (!silent && !stalledButBeating) return "healthy";
  const diagnosis = silent
    ? `silent (no heartbeat for ${Math.round(beatAge / 60000)}m, no progress for ${Math.round(progressAge / 60000)}m)`
    : `beating but not progressing (heartbeat ${Math.round(beatAge / 60000)}m old, progress ${Math.round(progressAge / 60000)}m old)`;

  // Two-strike protocol: the same fingerprint must be observed twice, cron-separated,
  // before a beating-but-idle run is treated as stalled.
  const fingerprint = `${hb?.fingerprint ?? "none"}|${cp.revision}`;
  if (rec.stallValue !== fingerprint) {
    await updateEnvelope(env, runId, (e) => {
      e.recovery = { ...(e.recovery ?? {}), stallValue: fingerprint, stallSeenAt: now.toISOString() };
    });
    return "stall-strike-1";
  }
  const seenAt = rec.stallSeenAt ? Date.parse(rec.stallSeenAt) : 0;
  if (now.getTime() - seenAt < OBSERVATION_GAP_MS) return "stall-not-cron-separated";

  return runLadder(env, runId, `stalled: ${diagnosis}`, envelope.instanceId, now);
}

/**
 * The ladder: claim (etag-guarded, verified by read-back) → (a) restart the existing
 * instance → (b) create a deterministic replacement `${runId}-r{n}`, id persisted BEFORE
 * create so an ambiguous outcome can be adopted → (c) honest failure.
 */
async function runLadder(
  env: Env,
  runId: string,
  reason: string,
  deadInstanceId: string | null,
  now: Date,
): Promise<string> {
  const claimId = crypto.randomUUID();
  const attempt = 1;
  const target = recoveryInstanceId(runId, attempt);

  const claimed = await updateEnvelope(env, runId, (e) => {
    const r = e.recovery ?? {};
    if (r.leaseUntil && Date.parse(r.leaseUntil) > now.getTime()) return false;
    if ((r.attempt ?? 0) >= MAX_ATTEMPTS) return false;
    e.recovery = {
      ...r,
      claimId,
      phase: "claimed",
      leaseUntil: new Date(now.getTime() + RECOVERY_GRACE_MS).toISOString(),
      attempt,
      targetInstanceId: target, // persisted BEFORE create()
      startedAt: now.toISOString(),
      reason,
    };
  });
  // Verify the claim actually landed as ours — a concurrent tick may have won.
  if (!claimed || claimed.recovery?.claimId !== claimId) return "claim-lost";

  await updateCheckpoint(env, runId, (d) => {
    d.recovery = { active: true, attempt, reason };
  });

  // Rung (a): engine-native restart.
  //
  // NOT epoch-fenced, and deliberately so: `restart()` re-queues the SAME instance id, so
  // the replacement and the "original" are the same worker and the same epoch. There is
  // nothing to fence against — but note the limit honestly: this rung is only taken for an
  // instance the engine itself reports as `errored` or `terminated`, i.e. one the platform
  // says is not running. Rung (b), which creates a genuinely second worker, IS fenced.
  if (deadInstanceId) {
    try {
      const inst = await env.V2_RUN_WORKFLOW.get(deadInstanceId);
      await (inst as unknown as { restart: () => Promise<void> }).restart();
      await updateEnvelope(env, runId, (e) => {
        if (e.recovery) e.recovery.phase = "restarting";
      });
      return "restarted";
    } catch (err) {
      console.log(`v2 sweeper: restart() unavailable for ${deadInstanceId} (${String(err).slice(0, 160)}); recreating`);
    }
  }

  // Rung (b): recreate from params reconstructed out of the envelope.
  const envelope = await getEnvelope(env, runId);
  if (!envelope) return "envelope-vanished";

  // FENCE THE ORIGINAL BEFORE THE REPLACEMENT EXISTS.
  //
  // Every rung of this ladder acts on EVIDENCE that the original is gone — NOT_FOUND,
  // `errored`, or no progress for 45 minutes — and none of it is proof. An original that is
  // actually alive and mid-batch would, without this, keep driving a real browser through
  // the same survey while its replacement did the same: submissions performed twice, usage
  // double-counted, two cursors overwriting each other.
  //
  // Bumping the ownership epoch to the replacement's — and pre-registering the
  // replacement's deterministic instance id, so its own claim is idempotent — makes the
  // original's very next checkpoint write fail with OwnershipLost, which it treats as
  // "stop, someone else owns this run". The fence is taken BEFORE `create()` because the
  // dangerous window is the one where both exist.
  try {
    await claimOwnership(env, runId, target, attempt);
  } catch (err) {
    return `fence-failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const params: RunParamsV2 = {
    runId,
    surveyUrl: envelope.input.surveyUrl,
    documentKey: envelope.input.documentKey,
    documentSha256: envelope.input.documentSha256,
    profile: envelope.profile,
    locale: envelope.input.locale,
    viewports: envelope.input.viewports,
    recoveryAttempt: attempt,
  };
  // Preflight: recreating a run whose input document is gone just burns the one attempt.
  const doc = await env.EVIDENCE.head(envelope.input.documentKey);
  if (!doc) return failRun(env, runId, "input document missing; cannot recreate");

  try {
    await env.V2_RUN_WORKFLOW.create({ id: target, params });
    await updateEnvelope(env, runId, (e) => {
      e.instanceId = target;
      if (e.recovery) e.recovery.phase = "recreating";
    });
    return "recreated";
  } catch (err) {
    // Ambiguous create: re-probe the target and ADOPT it if it exists in any live state,
    // rather than assuming failure and creating a second worker on the same run.
    const probe = await probeInstance(env, target);
    if (probe.kind === "status" && probe.status && !["errored", "terminated"].includes(probe.status)) {
      await updateEnvelope(env, runId, (e) => {
        e.instanceId = target;
        if (e.recovery) e.recovery.phase = "recreating";
      });
      return "adopted-ambiguous-create";
    }
    return failRun(env, runId, `recreate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Rung (c): honest failure carrying the engine's own detail. */
async function failRun(env: Env, runId: string, detail: string): Promise<string> {
  await updateEnvelope(env, runId, (e) => {
    if (e.recovery) e.recovery.phase = "failed";
    e.finalCompletion = { test: "failed", report: "not-started" };
  });
  await updateCheckpoint(env, runId, (d) => {
    d.completion.test = "failed";
    d.completion.reasonCode = "recovery-exhausted";
    d.error = detail;
    d.recovery = { active: false, attempt: MAX_ATTEMPTS, reason: detail };
    for (const p of d.phases) if (p.state === "active") p.state = "stopped";
  }, { progressed: true });
  await env.EVIDENCE.delete(activeMarkerKey(runId));
  return `failed: ${detail}`;
}
