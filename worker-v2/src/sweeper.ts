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
 *
 * ============ WHAT A FORENSIC REVIEW FOUND, AND WHAT IS NOW TRUE (8 Aug 2026) ============
 *
 * The recovery ladder was not merely imperfect, it was DESTRUCTIVE. In one afternoon it
 * erased a run's forensic record by restarting it, re-spent money on a run already known to
 * be dead, resurrected a run an operator had deliberately terminated (which the operator then
 * had to terminate a second time), and — after a silent 140-minute cron outage in the middle
 * of an incident — burst all of that at once because a 140-minute-old observation trivially
 * satisfies a four-minute separation rule.
 *
 * Three changes, each answering one of those:
 *
 *   1. THE LADDER IS REPORT-ONLY (`RECOVERY_MODE`). The sweeper still probes, still records,
 *      and still SETTLES a dead run as failed so it stops being invisible — but it creates no
 *      Workflow instance and restarts none. A restart re-runs a pipeline whose evidence is
 *      already written; a recreate spends money on a target nobody has re-examined. Both are
 *      decisions this sweeper has repeatedly got wrong, so they are an operator's to make
 *      until the rung is redesigned. Nothing was deleted: flip `RECOVERY_MODE` and the ladder
 *      is exactly as it was, which is what makes the guard test provable by mutation.
 *
 *   2. `terminated` IS NOT `errored`. They were one branch. An operator kill is a DECISION;
 *      an errored instance is a FAULT. A decision is honoured and settled on the spot with its
 *      own reason code, never recovered and never re-probed into something else — see
 *      `settleTerminated` for why settling immediately (rather than leaving it) matters.
 *
 *   3. A CRON GAP IS ITSELF A HAZARD, AND IT IS BOUNDED. The two-strike protocol had a
 *      MINIMUM separation and no MAXIMUM staleness, so every stale observation in the store
 *      came due simultaneously the moment cron resumed. Observations now expire, the first
 *      tick after a gap is observe-only, and every tick has a settlement budget.
 */

import type { Env } from "./types/env";
import { num } from "./types/env";
import { activeMarkerKey, k, sweeperTickKey } from "./keys";
import { recoveryInstanceId } from "./ids";
import { getEnvelope, updateEnvelope } from "./store/envelope";
import { claimOwnership, loadCheckpoint, readHeartbeat, updateCheckpoint } from "./store/checkpoint";
import { planRetention, writeRetentionReport } from "./store/retention";
import { isTerminalTest } from "./types/contracts";
import type { RunParamsV2 } from "./workflow/run-workflow";
import { normalizeDocumentSemanticsProfile } from "./extract/document-semantics";

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

/**
 * THE RESTART RUNG IS REPORT-ONLY UNTIL IT IS REDESIGNED. (Owner instruction, 8 Aug 2026.)
 *
 * `"report-only"` — probe, record, and settle a dead run as failed. NO `restart()`, NO
 * `create()`, NO ownership claim taken in order to hand a run to a replacement. The run is
 * still VISIBLE and still marked failed; what stops is the sweeper deciding, unattended, to
 * spend money and overwrite evidence on the strength of indirect signals.
 *
 * `"re-create"` — the historical ladder, kept intact and reachable so the redesign has
 * something to restore and so the guard test can be proved by flipping this one word. It is
 * not env-driven on purpose: re-enabling a rung that resurrected an operator's deliberate
 * kill should be a code change someone reviews, not a variable someone sets at 3am.
 *
 * The `as` widening is load-bearing: without it TypeScript narrows this to a literal type and
 * the comparison below becomes a compile error rather than a switch.
 */
const RECOVERY_MODE = "report-only" as "report-only" | "re-create";

/**
 * ============================ THE CRON-GAP BOUND ============================
 *
 * Cron runs every five minutes (`wrangler.jsonc` triggers). On 8 Aug it went silent for 140
 * minutes — 28 missed ticks — during an
 * incident, and when it came back the sweeper acted on everything at once. That was not bad
 * luck, it was the direct consequence of a protocol with a MINIMUM observation separation
 * (`OBSERVATION_GAP_MS`) and NO MAXIMUM. `now - stallSeenAt >= 4 minutes` is satisfied by an
 * observation from four minutes ago and equally by one from four hours ago, so every run
 * carrying a stale first strike became instantly actionable, simultaneously, on evidence
 * nobody had re-checked since before the outage.
 *
 * Three bounds, and each one alone is insufficient:
 *
 *   - OBSERVATIONS EXPIRE. A strike older than `OBSERVATION_MAX_AGE_MS` is not a strike; it
 *     is re-taken as a fresh first strike. This is the one that actually defuses the stored
 *     backlog: after a gap, everything is at strike 1 again, so nothing can settle until it
 *     has been observed twice by the RESUMED cron.
 *   - THE FIRST TICK AFTER A GAP IS OBSERVE-ONLY. Even a run whose evidence is legitimately
 *     fresh is not settled on the tick that discovers the outage, because the outage is
 *     itself unexplained and a sweeper that has been blind for two hours should look before
 *     it acts.
 *   - EVERY TICK HAS A SETTLEMENT BUDGET. A bound that depends on evidence ageing correctly
 *     is a bound that fails when the clock or the store misbehaves; `SETTLEMENTS_PER_TICK`
 *     holds regardless of why many runs came due together. Runs over budget are observed and
 *     reported, and come back next tick.
 */
const CRON_PERIOD_MS = 5 * 60 * 1000;
/** Longer than this since the last tick means ticks were MISSED, not merely late. */
const CRON_GAP_MS = 3 * CRON_PERIOD_MS;
/** An observation older than this is stale evidence: re-taken, never acted on. */
const OBSERVATION_MAX_AGE_MS = 6 * CRON_PERIOD_MS;
/** State-changing settlements one tick may perform. */
const SETTLEMENTS_PER_TICK = 3;

/**
 * The instance id the sweeper claims when it fences a run it is about to declare dead. It is
 * deliberately NOT a Workflow instance id: nothing is created, and a reader that tries to
 * probe it gets `instance.not_found`, which is the truth — no instance owns this run any more.
 */
const SWEEPER_FENCE_INSTANCE = "sweeper:report-only";

/** Per-tick state passed down to `sweepRun`, so the bound lives at the tick and not per-run. */
export interface SweepTick {
  /** False on the first tick after a cron gap (and on the very first tick ever). */
  maySettle: boolean;
  /** Mutated as settlements are spent. */
  budget: { remaining: number };
  /** Why this tick is or is not permitted to settle — reported, never inferred by a reader. */
  note: string;
}

/**
 * The permissive tick, for a direct caller (a test, an operator tool) that is not driving a
 * cron schedule. It still carries a budget: "someone called this by hand" is not a reason for
 * an unbounded number of state changes.
 */
export const openTick = (): SweepTick => ({
  maySettle: true,
  budget: { remaining: SETTLEMENTS_PER_TICK },
  note: "direct invocation: no cron-gap history to bound against",
});

interface TickRecord {
  at: string;
  gapMs: number | null;
  maySettle: boolean;
  note: string;
}

/**
 * Read the previous tick, decide whether this one may settle, and write this tick down. The
 * record is written BEFORE the sweep so a tick that dies mid-way still moves the clock — the
 * alternative is a crash loop in which every tick believes it follows an outage.
 */
async function openSweepTick(env: Env, now: Date): Promise<SweepTick> {
  let previousAt: number | null = null;
  try {
    const obj = await env.EVIDENCE.get(sweeperTickKey());
    if (obj) {
      const prev = (await obj.json()) as Partial<TickRecord>;
      const parsed = typeof prev.at === "string" ? Date.parse(prev.at) : NaN;
      if (Number.isFinite(parsed)) previousAt = parsed;
    }
  } catch {
    previousAt = null; // unreadable tick state is "we do not know", which is a gap
  }

  const gapMs = previousAt === null ? null : now.getTime() - previousAt;
  // A NEGATIVE gap is a clock that moved backwards; treat it as unknown rather than as a
  // healthy zero, because "the clock is wrong" is not a licence to act.
  const healthy = gapMs !== null && gapMs >= 0 && gapMs <= CRON_GAP_MS;
  const tick: SweepTick = {
    maySettle: healthy,
    budget: { remaining: SETTLEMENTS_PER_TICK },
    note: healthy
      ? `cron healthy: ${Math.round((gapMs ?? 0) / 1000)}s since the last tick`
      : gapMs === null
        ? "no previous tick on record: this tick observes and records, and settles nothing"
        : `cron gap of ${Math.round(gapMs / 60000)} minute(s) (expected <= ${CRON_GAP_MS / 60000}): ` +
          `this tick observes and records, and settles nothing`,
  };

  try {
    const record: TickRecord = { at: now.toISOString(), gapMs, maySettle: tick.maySettle, note: tick.note };
    await env.EVIDENCE.put(sweeperTickKey(), JSON.stringify(record), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  } catch (err) {
    console.error("v2 sweeper: could not record this tick:", err);
  }
  return tick;
}

/**
 * Is a recorded observation still evidence? An observation must be OLD ENOUGH to be a second
 * cron-separated look and YOUNG ENOUGH not to predate a gap nobody explained.
 */
function usableObservation(atIso: string | undefined, now: Date): "fresh" | "usable" | "stale" {
  const at = atIso ? Date.parse(atIso) : NaN;
  if (!Number.isFinite(at)) return "stale";
  const age = now.getTime() - at;
  if (age < 0 || age > OBSERVATION_MAX_AGE_MS) return "stale";
  return age >= OBSERVATION_GAP_MS ? "usable" : "fresh";
}

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

/** One sweep tick: OBSERVE stuck runs (and settle the dead ones), then advance retention. */
export async function sweep(env: Env, now: Date): Promise<Record<string, unknown>> {
  const results: Record<string, string> = {};
  let cursor: string | undefined;
  let seen = 0;

  // The gap bound is taken ONCE, at the tick, and handed down. Deciding it per run would let
  // a long sweep drift across the boundary and settle some runs but not others.
  const tick = await openSweepTick(env, now);

  do {
    const page = await env.EVIDENCE.list({ prefix: k("active") + "/", cursor, limit: ACTIVE_PER_SWEEP });
    for (const obj of page.objects) {
      if (seen >= ACTIVE_PER_SWEEP) break;
      seen++;
      const runId = obj.key.slice(obj.key.lastIndexOf("/") + 1);
      try {
        results[runId] = await sweepRun(env, runId, now, tick);
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

  return {
    swept: seen,
    results,
    retention,
    // The tick's own posture is REPORTED, not left to be inferred from the absence of
    // action. "Nothing was settled" and "nothing needed settling" are different sentences.
    tick: {
      mode: RECOVERY_MODE,
      maySettle: tick.maySettle,
      settlementsLeft: tick.budget.remaining,
      note: tick.note,
    },
  };
}

export async function sweepRun(
  env: Env,
  runId: string,
  now: Date,
  tick: SweepTick = openTick(),
): Promise<string> {
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
    return settle(env, runId, now, tick, {
      reasonCode: "recovery-exhausted",
      detail:
        `automatic recovery is exhausted (${rec.attempt ?? 0} of ${MAX_ATTEMPTS} attempt(s) used) and the ` +
        `replacement made no durable progress for ${Math.round(progressAge / 60000)} minute(s). ` +
        `Last recovery reason: ${rec.reason ?? "unknown"}.`,
      attempt: rec.attempt ?? MAX_ATTEMPTS,
      // The engine has not been asked; a replacement that is silent may still exist.
      fence: true,
    });
  }

  const probe = await probeInstance(env, envelope.instanceId);
  if (probe.kind === "transport") return "transport-error"; // never evidence

  const st = probe.kind === "status" ? (probe.status ?? "unknown") : "";

  // AN OPERATOR KILL IS A DECISION, NOT A FAULT — AND IT IS SETTLED ON SIGHT.
  //
  // This used to share a branch with `errored`, so the sweeper's answer to "a human
  // deliberately stopped this run" was to restart it. It is now its own branch, before
  // everything else, and it is honoured rather than diagnosed: no ladder, no strike protocol,
  // no age floor, and its own reason code so a reader can tell an operator's decision from a
  // crash forever afterwards.
  //
  // WHY IT SETTLES IMMEDIATELY, INCLUDING ON AN OBSERVE-ONLY TICK. Recording a termination is
  // not a judgement call the sweeper could get wrong — the engine is reporting what an
  // operator did, and the run is already stopped. Deferring it is what is dangerous: Workflow
  // instances are retained for a bounded time, so an unrecorded termination becomes
  // `instance.not_found` later, and the NOT_FOUND branch below would then re-label the
  // operator's deliberate kill as a fault of unknown cause. The decision has to be written
  // down while the engine is still willing to say it.
  if (st === "terminated") {
    return settleTerminated(env, runId, envelope.instanceId);
  }

  // A PAUSE IS THE SAME KIND OF THING, AND IT IS LEFT ALONE.
  //
  // v1 had `if (st === "paused") return "paused"` with the comment "operator territory —
  // untouched"; the v2 carry-forward dropped the branch and nothing noticed, because a paused
  // instance looks identical to a hung one from here: it does not beat and it does not commit
  // progress. So after 45 minutes of an operator's deliberate pause this sweeper would take
  // its two strikes, FENCE THE INSTANCE OUT, and record the run as failed — relabelling a
  // decision as a fault, which is the exact defect the `terminated` split above exists to
  // close. A pause is resumable by the person who took it and is not the sweeper's to end.
  if (st === "paused") return "paused-operator-territory";

  if (probe.kind === "not_found") {
    if (ageMs < UNKNOWN_FLOOR_MS) return "unknown-below-floor";
    // STALE EVIDENCE IS NOT EVIDENCE (the cron-gap bound). A streak whose last observation
    // predates the staleness window is discarded and re-taken from one, so a backlog that
    // accumulated while cron was silent cannot come due all at once when it resumes.
    const freshness = usableObservation(rec.lastUnknownAt, now);
    if (freshness === "fresh") return "unknown-not-cron-separated";
    const streak = freshness === "stale" ? 1 : (rec.unknownStreak ?? 0) + 1;
    await updateEnvelope(env, runId, (e) => {
      e.recovery = { ...(e.recovery ?? {}), unknownStreak: streak, lastUnknownAt: now.toISOString() };
    });
    if (streak < UNKNOWN_STREAK_NEEDED) {
      return freshness === "stale" ? "unknown-streak-1-evidence-expired" : `unknown-streak-${streak}`;
    }
    return settle(env, runId, now, tick, {
      reasonCode: "instance-not-found",
      detail:
        `the Workflow engine no longer knows this run's instance (${envelope.instanceId}), observed ` +
        `${UNKNOWN_STREAK_NEEDED} times across separate sweeps and ${Math.round(ageMs / 3600000)} hour(s) after ` +
        `the run started.`,
      attempt: rec.attempt ?? 0,
      // NOT_FOUND is the engine forgetting, not the engine declaring death: an original could
      // in principle still be executing. Fence before recording a verdict it must not undo.
      fence: true,
      ladder: { reason: "instance not found", deadInstanceId: null },
    });
  }

  if (st === "errored") {
    return settle(env, runId, now, tick, {
      reasonCode: "workflow-errored",
      detail:
        `the Workflow engine reports instance ${envelope.instanceId} as errored.` +
        (probe.error?.message ? ` Engine error: ${probe.error.name ?? "Error"}: ${probe.error.message}.` : ""),
      attempt: rec.attempt ?? 0,
      // The engine has declared this instance dead, so there is nothing left to fence out.
      fence: false,
      ladder: { reason: "workflow instance errored", deadInstanceId: envelope.instanceId },
    });
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

  // Two-strike protocol: the same fingerprint must be observed twice, cron-separated AND
  // recently, before a beating-but-idle run is treated as stalled.
  const fingerprint = `${hb?.fingerprint ?? "none"}|${cp.revision}`;
  const freshness = usableObservation(rec.stallSeenAt, now);
  if (rec.stallValue !== fingerprint || freshness === "stale") {
    await updateEnvelope(env, runId, (e) => {
      e.recovery = { ...(e.recovery ?? {}), stallValue: fingerprint, stallSeenAt: now.toISOString() };
    });
    // NAMED SEPARATELY, because the two mean different things to an operator reading a log:
    // one is "the run changed", the other is "our own evidence had gone stale, so we started
    // over" — which is exactly what happens on the tick after a cron outage.
    return freshness === "stale" && rec.stallValue === fingerprint
      ? "stall-strike-1-evidence-expired"
      : "stall-strike-1";
  }
  if (freshness === "fresh") return "stall-not-cron-separated";

  return settle(env, runId, now, tick, {
    reasonCode: "instance-stalled",
    detail:
      `the run stopped making durable progress and was observed twice, on separate sweeps, in the same ` +
      `state: ${diagnosis}. The last thing it said it was doing was "${hb?.note ?? "nothing since it started"}".`,
    attempt: rec.attempt ?? 0,
    // A stalled run is one the ENGINE still reports as running. Everything above is
    // indirect evidence, so the original must be fenced out before a verdict is written
    // that it would otherwise be free to overwrite.
    fence: true,
    ladder: { reason: `stalled: ${diagnosis}`, deadInstanceId: envelope.instanceId },
  });
}

// ---------------------------------------------------------------------------
// SETTLEMENT — what the sweeper does INSTEAD of recovering
// ---------------------------------------------------------------------------

interface Settlement {
  /** Machine code, in `completion.reasonCode`'s vocabulary. */
  reasonCode: string;
  /** The sentence a reader gets. Written by the sweeper from what it actually observed. */
  detail: string;
  /** Recovery attempts already spent on this run. NOT invented — nothing is attempted here. */
  attempt: number;
  /**
   * Take the ownership epoch before writing. Required whenever the engine has NOT itself
   * declared the instance dead, because an original that is actually alive would otherwise
   * keep writing checkpoints over a run this sweeper just recorded as failed.
   */
  fence: boolean;
  /**
   * The recovery this case WOULD have attempted under `RECOVERY_MODE: "re-create"`, and the
   * only route by which `runLadder` is still reachable. Absent means "this case never
   * laddered, even historically" — the exhausted-attempts branch, which always went straight
   * to an honest failure.
   */
  ladder?: { reason: string; deadInstanceId: string | null };
}

/**
 * Settle a run the sweeper believes is dead — the ONLY state change the report-only sweeper
 * makes to a run, and the one the owner explicitly asked to keep: "a run that died silently
 * must still be visible and still be marked failed".
 *
 * Everything about it is bounded. It costs one settlement from the tick's budget; it does not
 * happen at all on the first tick after a cron gap; and when the engine has not declared the
 * instance dead it fences first and REFUSES TO SETTLE if the fence cannot be taken — a verdict
 * a live original can overwrite is worse than no verdict, because it would be believed.
 */
async function settle(env: Env, runId: string, now: Date, tick: SweepTick, s: Settlement): Promise<string> {
  // THE ONE SWITCH. Under `"re-create"` every case that historically laddered ladders again,
  // from the same evidence and with the same arguments; under `"report-only"` — the shipped
  // value — the ladder is unreachable and the sweeper settles instead. Nothing else in this
  // file reads `RECOVERY_MODE`, so there is exactly one thing to review when it changes.
  if (RECOVERY_MODE === "re-create" && s.ladder) {
    return runLadder(env, runId, s.ladder.reason, s.ladder.deadInstanceId, now);
  }

  if (!tick.maySettle) return `observed-not-settled (${s.reasonCode}): ${tick.note}`;
  if (tick.budget.remaining <= 0) {
    return `observed-not-settled (${s.reasonCode}): this tick's settlement budget of ${SETTLEMENTS_PER_TICK} is spent`;
  }

  if (s.fence) {
    try {
      const loaded = await loadCheckpoint(env, runId);
      const epoch = (loaded?.checkpoint.ownership?.epoch ?? 0) + 1;
      await claimOwnership(env, runId, SWEEPER_FENCE_INSTANCE, epoch);
    } catch (err) {
      return `fence-failed (${s.reasonCode}): ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  tick.budget.remaining -= 1;
  const detail =
    `${s.detail} Automatic recovery was NOT attempted: the sweeper's restart and re-create rungs are ` +
    `report-only pending redesign, so restarting or re-running this run is an operator decision.`;
  return failRun(env, runId, detail, s.reasonCode, s.attempt);
}

/**
 * An operator terminated this run. Record the decision as the decision it was.
 *
 * It is deliberately NOT routed through `settle`: there is no budget to spend and no tick to
 * defer to, because nothing is being decided here. The engine is reporting a human's action
 * on a run that has already stopped, and the only failure mode available is failing to write
 * it down — see the call site for why writing it down late is the same as losing it.
 */
async function settleTerminated(env: Env, runId: string, instanceId: string): Promise<string> {
  return failRun(
    env,
    runId,
    `an operator terminated this run's Workflow instance (${instanceId}). A termination is a decision, not a ` +
      `fault: the run is closed exactly as it was found, nothing was recovered, and nothing will be. Start a ` +
      `new run if the work is still wanted.`,
    "operator-terminated",
    0,
  );
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
  let documentSemanticsProfile;
  try {
    documentSemanticsProfile = normalizeDocumentSemanticsProfile(envelope.input.documentSemanticsProfile);
  } catch (err) {
    return failRun(
      env,
      runId,
      `persisted document-semantics profile is invalid; cannot recreate: ${err instanceof Error ? err.message : String(err)}`,
      "workflow-input-invalid",
      attempt,
    );
  }

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
    documentSemanticsProfile,
    contractSource: envelope.input.contractSource ?? { mode: "extract" },
    recoveryAttempt: attempt,
  };
  // Preflight: recreating a run whose input document is gone just burns the one attempt.
  const doc = await env.EVIDENCE.head(envelope.input.documentKey);
  if (!doc) return failRun(env, runId, "input document missing; cannot recreate", "recovery-exhausted", attempt);
  if (envelope.input.contractSource?.mode === "human-authored") {
    const authored = await env.EVIDENCE.head(envelope.input.contractSource.humanRequirementsKey);
    if (!authored) {
      return failRun(env, runId, "human requirements input missing; cannot recreate", "recovery-exhausted", attempt);
    }
  }

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
    return failRun(
      env,
      runId,
      `recreate failed: ${err instanceof Error ? err.message : String(err)}`,
      "recovery-exhausted",
      attempt,
    );
  }
}

/**
 * Write the run down as failed, with the code that says WHICH KIND of ending this was, and
 * stop sweeping it.
 *
 * THE REASON CODE IS A PARAMETER, NOT A CONSTANT. It was hardcoded to `recovery-exhausted`,
 * so every ending this sweeper produced — an engine crash, an instance the engine had
 * forgotten, a hang, and an operator's deliberate termination — arrived at a reader wearing
 * the same label, and the one that most needed to be distinguishable (a human's decision) was
 * the least distinguishable of all.
 *
 * `attempt` is likewise passed rather than assumed: writing `attempt: MAX_ATTEMPTS` on a run
 * where nothing was ever attempted is a false statement about what this service did, and in
 * report-only mode nothing IS attempted.
 */
async function failRun(
  env: Env,
  runId: string,
  detail: string,
  reasonCode: string,
  attempt: number,
): Promise<string> {
  await updateEnvelope(env, runId, (e) => {
    if (e.recovery) e.recovery.phase = "failed";
    e.finalCompletion = { test: "failed", report: "not-started" };
  });
  await updateCheckpoint(env, runId, (d) => {
    d.completion.test = "failed";
    d.completion.reasonCode = reasonCode;
    d.error = detail;
    d.failure = {
      step: "sweeper",
      reasonCode,
      kind: "sweeper-observation",
      message: detail,
      at: new Date().toISOString(),
    };
    d.recovery = { active: false, attempt, reason: detail };
    for (const p of d.phases) if (p.state === "active") p.state = "stopped";
  }, { progressed: true });
  await env.EVIDENCE.delete(activeMarkerKey(runId));
  return `failed:${reasonCode}: ${detail}`;
}
