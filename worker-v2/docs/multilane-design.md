# Multi-lane execution design

## What this adds

Today the executor walks planned cases one at a time: `executeBatch` opens one
browser session and drives each work item sequentially through `walkPath`. This
change adds multi-lane execution: several planned cases walked at the same time,
each lane in its own browser session. The purpose (owner requirement):
termination routes must be exercised deliberately, one lane per planned route,
including routes the document says terminate, so every terminate is proven to
fire on the site, in parallel with the survive-to-the-end lane.

## Config surface

| Variable | Default | Meaning |
|---|---|---|
| `EXEC_LANES` | `"1"` | How many browser sessions to run at the same time. Clamped to `[1, 4]`. When `1`, behavior is byte-identical to today's sequential path. |

Hard ceiling: 4 (even if `EXEC_LANES` asks for more). The clamp is logged
loudly at batch start. The ceiling exists because Cloudflare Browser Rendering
enforces max 120 concurrent browsers per account with a max launch rate of 1
browser per second. Conserving headroom for other runs sharing the account is
the binding constraint.

## Lane model

A "lane" is one self-contained browser session walking one planned path. Lanes
are created from the existing `selectWork` output; the multi-lane code does not
invent new planner logic.

### Lane assignment

`selectWork(program, progress, maxExploration)` already returns a `WorkItem[]`
list. Multi-lane divides this work list into groups of up to `EXEC_LANES` items
(the "wave"). Each wave runs its lanes concurrently. The next wave starts only
after all lanes in the current wave finish.

Within a wave, each lane is independent: its own browser session, its own
`walkPath` call, its own per-case timeout, its own evidence artifacts.

### What stays sequential

1. **Session acquisition** is staggered. Lanes launch 1500ms apart (measured
   from the start of the previous lane's `puppeteer.launch`). This respects
   Cloudflare's documented 1-browser-per-second rate limit with a safety margin.
2. **Checkpoint writes** are sequential. After all lanes in a wave complete,
   progress and checkpoint updates happen one lane at a time, in lane order. The
   checkpoint mutation closure needs exclusive access to the cursor.
3. **The screenout pivot retry loop** is sequential within a lane (unchanged
   from today).

### What runs in parallel

1. Browser launch (staggered, not simultaneous).
2. `walkPath` invocations — each lane navigates the survey independently.
3. Evidence capture — each lane writes its own evidence with collision-free names.

## Scheduling: stagger, cap, deadline math

### Launch stagger

Lanes are launched sequentially with a minimum 1500ms gap between launches.
The stagger is a `setTimeout` delay, measured from the start of the previous
lane's launch, not its completion.

### Lane cap

```
const requestedLanes = num(env.EXEC_LANES, 1);
const effectiveLanes = Math.min(Math.max(1, requestedLanes), 4);
if (effectiveLanes !== requestedLanes) {
  console.log(`v2 exec: EXEC_LANES=${requestedLanes} clamped to ${effectiveLanes}`);
}
```

### Deadline math

Each lane computes its walk deadline from the same `walkDeadlineFor` math used
today. The batch deadline is shared across all lanes. Each lane's walk gets:

```
walkDeadlineFor(batchDeadline, Date.now(), EXEC_BATCH_MAX_MS, perCaseTimeoutMs)
```

No budget ladder values are changed. The batch envelope is the same 67-minute
step timeout, and each lane's walk fits inside that envelope.

### Wave overflow

If the work list is larger than one wave of `effectiveLanes`, the remaining
items are walked in subsequent waves within the same batch, or deferred to the
next batch. Items that cannot fit are left in the work list and processed by the
next `execute-batch` step. They are never silently dropped: the existing
`leftoverReason` plumbing reports them.

## Failure isolation

Each lane runs inside its own `try/finally` block. Specific guarantees:

1. **A lane crash does not kill sibling lanes.** Each lane's `Promise` is
   settled independently. A rejected lane is recorded as an error outcome; other
   lanes continue.
2. **Every lane retires its own browser session.** The `finally` block calls
   `retireSession(handle)` for each lane's handle. A lane that crashes still
   closes its browser.
3. **A wedged session in one lane does not hang others.** Each lane's browser
   calls are bounded by `withTimeout`. A timeout in lane N produces a named
   `per-case-timeout` or `browser-hung` outcome for that lane only.

Implementation: `Promise.allSettled` is used for the wave, so a rejected lane
does not short-circuit others.

## Evidence naming

Today, evidence is keyed by `(runId, attemptId, pathId)` with an optional
`attemptOrdinal` for re-attempts. Each lane already gets a unique `attemptId`
from `mintAttemptId()`, and path ids are unique across the plan. Therefore:

- Lane evidence names are collision-free by construction: distinct `attemptId`
  values produce distinct evidence keys.
- The `CaptureContext` per lane carries its own `attemptId` and `pathId`.
- `attemptOrdinal` is set from `priorAttemptsOfPath`, which counts rows in
  `progress.walks` for that path — these rows are written sequentially after all
  lanes complete, so the ordinal is consistent.

No new naming scheme is needed. The existing `attemptOrdinal` mechanism handles
the multi-lane case because lanes walk different paths, not the same path twice.

## Flag-off equivalence

When `EXEC_LANES` is `"1"` or absent:

- The code path is structurally identical to today's sequential loop.
- The lane array has exactly one element.
- No `Promise.allSettled` wrapper is needed (single lane runs directly).
- No stagger delay is applied.
- The existing test suite passes without modification.

## Named limitations

1. **The planner does not yet emit explicit terminate-route cases.** Multi-lane
   execution walks whatever the plan provides. If the plan does not place
   termination routes in separate paths, the lanes do not exercise them
   separately. This is a planner gap, not a multi-lane gap. When the planner
   adds explicit terminate-route paths, they will automatically be assigned to
   separate lanes.
2. **Lane count is capped at 4.** The Cloudflare account limit is 120 browsers.
   At 4 concurrent, a run uses 3.3% of the account's capacity. Higher
   concurrency would need measured evidence of account headroom.
3. **No cross-lane coordination.** Each lane is fully independent. Two lanes
   cannot cooperate to exercise a multi-step scenario that requires seeing
   another lane's effect. That requires a different architecture (session
   coordination) and is out of scope.
4. **Pivot retries stay per-lane, sequential.** The bounded screen-out retry
   loop is lane-local. A pivot in lane 1 does not affect lane 2.
5. **Seed alternatives in multi-lane.** Seed alternatives use a checkpoint
   reservation protocol (write reservation before walk, commit after). In
   multi-lane mode, seed alternatives are walked one at a time to preserve
   reservation ordering. This is enforced by placing seed work items in their
   own sequential sub-loop after the parallel wave, not in a concurrent lane.
