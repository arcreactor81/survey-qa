# Completion-path audit — what breaks the first time a deep walk finishes

**Read-only scout, 19 August 2026.** Nothing in this document was applied. Every diff below is a
PROPOSAL. No source was edited, nothing was deployed, no run and no live link was touched.

**The question this answers.** A deep walk is about to reach the live survey's completion page for
the first time. The deliverable is the whole chain: walk completes → observations verified →
verdicts derived → record assembled → judgement minted → report published. That downstream half has
only ever processed stalled and screened-out walks. What breaks, refuses, or mislabels on the first
real completion?

**Headline.** The report **will publish**, and it **will be wrong about the one fact the run exists
to establish**. Publication is not gated on the test axis closing (`report/build.ts:702` only
downgrades `final` to `false`), so bytes will reach the customer. But the completion never survives
the trip: the walk's typed ending is dropped at the record boundary, the attempt that finished the
survey is recorded `ok: false`, and the run is labelled `partial-blocked / walks-blocked-by-site` —
an accusation against a customer's survey that behaved correctly.

**Counts.** 9 PROVEN blockers, 3 SPECULATIVE concerns. Shortlist of 5 changes in §4.

---

## 1. What "completed" requires, and what would misread a Confirmit completion page

### 1.1 The exact conditions

`classifyEnding` lives at `worker-v2/src/browser/driver.ts:4339-4515`. The ordering is the policy,
and `kind: "completed"` is the *sixth* thing tried. A walk earns it only by surviving all five
earlier arms:

| # | Gate | file:line | Passes only when |
|---|---|---|---|
| 0 | final screen exists | `driver.ts:4357` | `finalScreenOf(steps)` is non-null |
| 1 | termination-page-with-dead-control | `driver.ts:4405` | NOT (`advance && screenout && outcome==="blocked"`) |
| 2 | still offering a way on | `driver.ts:4416` | `nextButton(final) === null` |
| 3 | ran out of survey | `driver.ts:4430` | `outcome` is `"completed"` or `"no-advance-control"` |
| 4 | wording screen-out | `driver.ts:4457` | no `SCREENOUT_MARKERS` regex matched |
| 5 | structural screen-out | `driver.ts:4477` | NOT (`onlyBackVisible && answerable.length===0 && !completion && !progressFull`) |
| 6 | **finished** | `driver.ts:4491` | `completion || progressFull` |

The arm itself:

```ts
// driver.ts:4490-4502
  // ---- 3. finished ----
  if (completion || progressFull) {
    return {
      kind: "completed",
      evidence: [
        `no enabled control advances the final screen`,
        ...(completion ? [`the final screen says: "${completion}"`] : []),
        ...(progressFull ? [`the progress indicator reads ${final.progress.now}/${final.progress.max}`] : []),
        `${answerable.length} answerable control(s) remain on it`,
        ...provenance,
      ],
    };
  }
```

The two disjuncts:

```ts
// driver.ts:4223-4229
const COMPLETION_MARKERS: readonly RegExp[] = [
  /\bthank\s+you\s+for\s+(completing|taking\s+part|participating|your\s+time)\b/i,
  /\byour\s+responses?\s+(have|has)\s+been\s+(recorded|received|submitted|saved)\b/i,
  /\b(survey|questionnaire|interview)\s+(is\s+)?complete(d)?\b/i,
  /\byou\s+have\s+(now\s+)?completed\b/i,
  /\bsubmission\s+(received|complete)\b/i,
];
```

```ts
// driver.ts:4392-4397
  const progressFull =
    final.progress.present &&
    typeof final.progress.now === "number" &&
    typeof final.progress.max === "number" &&
    final.progress.max > 0 &&
    final.progress.now >= final.progress.max;
```

`progressFull` is documented as unreliable on exactly this platform family — `driver.ts:4335-4337`:
*"MEASURED on all four live SurveyJS instruments, the completion page reports `progress.now: null`."*
So in practice **`completion` (a wording match) is the only route to `kind: "completed"`.**

### 1.2 What the live instrument's end pages actually look like

The repo holds the measured text of this link's test-mode **termination** page — `worker-v2/tools/tests/d42-advance-control-and-endings.test.mjs:775`:

```
"For testing only:\nThank you for your willingness to participate. Due to the specific guidelines,
we have been given for this study, we are unable to accept your offer to participate in our
research.\n\nSurvey status: Terminated at S80"
```

and `driver.ts:4400-4404` records that the same page **renders a `">>"` the walker clicked twelve
times without the screen changing** (run `v2r_01m07qpwcjamfpcs89frs3syjs`, screen 15). So the
platform's END pages, in test mode, carry: a `For testing only:` banner, a `Survey status: <X>` line,
a forward control that does nothing, and (per `driver.ts:4244` and `worker-v2/tools/live-jump-walk.mjs:7`)
a `QUESTION SKIP MENU` `<select>` of question ids.

### 1.3 Concerns, rated

---

**C1 — PROVEN. A completion page wearing a dead forward control classifies `stalled`, not `completed`.**

Arm 1 (`driver.ts:4405-4414`) exists precisely to rescue a terminal page that renders an inert `">>"`,
and it fires **only for screen-outs**:

```ts
// driver.ts:4405
  if (advance && screenout && ctx.outcome === "blocked") {
```

There is no completion twin. A completion page with the same test-mode chrome — the shape this repo
has *measured* on the sibling END page — hits arm 2 at `driver.ts:4416` and returns
`kind: "stalled"`. The first completion is then indistinguishable from a walk that gave up.

This is not hypothetical inference about an unseen page: it is the *same test-mode template*, and the
repo's own comment at `driver.ts:4400-4404` establishes that this platform renders a dead forward
control on END pages. The asymmetry in the code is certain; only whether the completion page inherits
the chrome is inferred.

---

**C2 — PROVEN (code) / SPECULATIVE (wording). The screen-out lexicon beats completion unconditionally.**

Arm 4 (`driver.ts:4457-4468`) runs before arm 6 and has no tie-break. It even prints the completion
wording while overruling it:

```ts
// driver.ts:4464
        ...(completion ? [`it also carries completion wording ("${completion}") — screen-out pages usually thank you too, which is why that is not read as a completion`] : []),
```

The dangerous entry is `driver.ts:4208`:

```ts
  /\bthank\s+you\s+for\s+your\s+interest\b/i,
```

"Thank you for your interest in this survey" is ordinary completion-page wording across Confirmit,
Qualtrics and Decipher. If the live completion page carries it, the first completion is reported as a
**screen-out**, with a self-justifying evidence line explaining why the completion wording was
ignored. The code behaviour is certain; whether this link's page uses that phrase is SPECULATIVE — I
could not determine it statically and did not visit the link.

Same shape, lower probability: `driver.ts:4216` `/\b(unable|not\s+able)\s+to\s+accept\b/i`, whose
comment asserts completion pages "say 'received' or 'recorded', never 'accept'" — an assumption with
no measurement behind it.

---

**C3 — PROVEN. The completion lexicon is much narrower than the screen-out one, and the fallback is `screened-out`.**

Five regexes, and common real completion wordings fall outside all of them:

| Wording | Matches? | Why not |
|---|---|---|
| "Thank you for your participation." | **no** | `4224` has `participating`, not `participation` |
| "You have successfully completed the survey." | **no** | `4227` requires `you have (now )?completed` — no adverb slot |
| "Your answers have been saved." | **no** | `4225` requires `response`/`responses`, not `answers` |
| "This is the end of the survey." | **no** | no regex covers it |
| "Thank you for your feedback." | **no** | not in the list |
| "Survey status: Complete" (the banner line) | **no** | `4226` needs `survey (is )?complete` adjacent; `status: ` intervenes |

That last row matters most: the platform's own status stamp — the one line we *know* this link prints
on END pages — does not match. A non-matching completion page then falls to arm 5
(`driver.ts:4477-4488`), and if its only visible buttons are back controls it is classified
**`screened-out`** on structural grounds. Otherwise it is `unclassified` (`driver.ts:4505`), which
`verify-observations.ts:1793-1800` correctly refuses to credit.

Either way the completion is lost, and one of the two ways loses it *as an accusation*.

---

**C4 — PROVEN. The walker acts on the completion page before it is recognised as terminal, and the skip menu is not protected.**

Order of operations inside the step loop:

```ts
// driver.ts:4860 — answers are applied to EVERY screen, including the completion page
      () => applyAcrossQuestionRoots(page, before, decision, pathHints, stepVariant),
```
```ts
// driver.ts:4908-4909 — terminality is read from the POST-ACTION screen
    const navigation = resolveAdvanceControl(afterAction ?? before);
    const nb = navigation.kind === "unique" ? navigation.control : null;
```

`isPlatformNavigationWidget` (`driver.ts:4264`) has exactly **two** call sites — `driver.ts:4027`
(`advanceSignals`) and `driver.ts:4368` (`classifyEnding`'s `answerable` filter). It is **not**
consulted by `applyDecision`. The native-select navigator-default therefore treats the QUESTION SKIP
MENU as an ordinary question and selects its first usable option:

```ts
// driver.ts:3580-3601
    } else {
      const usable = c.options.filter(usableSelectOption);
      const already = usable.find((o) => o.selected);
      // A rerun must not dispatch input/change on a value already held by the page. ...
      if (already) continue;
      const pick = usable.length > 0 ? Math.min(variant, usable.length - 1) : -1;
      chosen = pick >= 0 ? usable[pick] : undefined;
      ...
      provenance = ... "navigator-default:first-usable-native-option";
    }
```

The comment at `3583-3584` confirms the actuation dispatches `input`/`change`. `live-jump-walk.mjs:208`
records that *"Some skip menus navigate on change; others need their form submitted."* If this one
navigates on change, the walker jumps off the completion page to a question screen, `afterAction` then
has a Next button, `nb` is non-null, and **the walk continues past the completion page and never
records it**. The completion page would be visited and then walked away from.

The code path is certain. Whether *this* menu navigates on change is the SPECULATIVE half — but the
repo's own tool had to handle both cases, so it is not a remote possibility.

---

**C5 — SPECULATIVE. Screened-out vs completed discrimination on the banner.**

The brief asks whether the two terminal kinds can be confused. On the wording available, the
discrimination *works in the screen-out direction*: `Survey status: Terminated at S80` matches
`driver.ts:4220` `/\bstatus[:\s]+terminated\b/i`, and `unable to accept` matches `driver.ts:4216`.
Neither fires on a completion banner. The failure direction is the opposite one — C1, C2 and C3, all
of which lose a completion — not a termination misread as a completion. That asymmetry is the
intended posture (`driver.ts:4194-4198`), and it is the right one; but it means the first completion
is the case the design is *least* prepared to recognise.

---

## 2. The run after a completed deep walk

### 2.1 What stops the run — the pending ledger does NOT loop forever

The 400+ pending cases do **not** keep the run executing. `selectWork`
(`execute-batch.ts:787-831`) is bounded independently of the case ledger: floor paths first
(`792-806`), then seeds (`808-814`), then exploration capped by `EXEC_MAX_EXPLORATION`
(`816-829`, budget read at `execute-batch.ts:1188`). When that list empties, `remaining === 0`,
`done` is true (`execute-batch.ts:1165`, `1838`), and the batch loop breaks at
`run-workflow.ts:1961-1964`. **No infinite-run path found.**

### 2.2 What the run will be labelled — and why it is wrong

Here is the chain, and it is the most damaging finding in this audit.

**Step 1.** Arm 1 of `classifyEnding` requires `ctx.outcome === "blocked"` to recognise the measured
Confirmit termination page (`driver.ts:4405`). So every screened-out probe that this system correctly
classifies **carries `outcome: "blocked"`**.

**Step 2.** That is exactly the set the run-level accusation keys off:

```ts
// execute-batch.ts:2096
const BLOCKING_OUTCOMES = new Set(["blocked", "blocked-after-probe"]);
```
```ts
// execute-batch.ts:2126-2128
export function hasBlockingEvidence(walks: readonly WalkRecord[]): boolean {
  return walks.some((w) => BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0);
}
```

**Step 3.** With work exhausted and cases still pending:

```ts
// execute-batch.ts:2143-2152
export function resolveStopReason(args: {...}): string | null {
  if (args.stopReason !== null) return args.stopReason;
  if (!args.done || args.pendingCases <= 0) return null;
  return hasBlockingEvidence(args.walks) ? EXEC_STOP_WALKS_BLOCKED_BY_SITE : EXEC_STOP_COVERAGE_SHORTFALL;
}
```

→ `"walks-blocked-by-site"`.

**Step 4.** The run label and the ledger:

```ts
// run-workflow.ts:1974-1982
            if (stopReason) {
              const bucket = stopBucket(stopReason);
              d.counts[bucket] += d.counts.pending;
              d.counts.pending = 0;
              setPhase(d, "executing", "stopped", stopReason);
              d.completion.test = stopCompletion(stopReason);
              d.completion.reasonCode = stopReason;
```

`stopBucket` (`run-workflow.ts:3427-3428`) and `stopCompletion` (`run-workflow.ts:3430-3431`) both key
off a `-cap` suffix, which `walks-blocked-by-site` lacks. Result:
**`counts.blocked += 400+`, `completion.test = "partial-blocked"`, `reasonCode = "walks-blocked-by-site"`.**

**Step 5.** The verdict layer inherits it:

```ts
// derive-verdicts.ts:98-111
function unreachedFromCursor(inputs: RunInputs): Record<string, string> {
  const cursor = inputs.checkpoint?.execution ?? null;
  const reason = inputs.checkpoint?.completion.reasonCode ?? null;
  if (!cursor || cursor.pendingCaseIds.length === 0) return {};
  const status =
    reason === "wall-clock-cap" ? "time-exhausted"
      : reason && reason.endsWith("-cap") ? "budget-exhausted"
        : reason ? "blocked" : "not-reached";
  return Object.fromEntries(cursor.pendingCaseIds.map((id) => [id, status]));
}
```

Every one of the 400+ never-attempted cases is written into the signed record as **`blocked`** —
"the site stopped us here" — when the truth is "we never went there".

**Step 6.** The axis refuses, correctly, but for a corrupted reason:

```ts
// run-workflow.ts:3344-3352
  const unsettled = (["blocked", "budget-exhausted", "time-exhausted", "not-reached"] as const)
    .map((b) => [b, cp.counts[b]] as const)
    .filter(([, n]) => n > 0);
  if (unsettled.length > 0) {
    blockers.push(
      `${unsettled.reduce((n, [, c]) => n + c, 0)} execution case(s) never reached a verdict ` +
        `(${unsettled.map(([b, n]) => `${b}: ${n}`).join(", ")})`,
    );
  }
```

The blocker sentence will read **"4xx execution case(s) never reached a verdict (blocked: 4xx)"** —
"blocked", not "not-reached". The axis then leaves `completion.test` at its already-terminal
`partial-blocked` (`run-workflow.ts:2367` guards against clobbering).

**This is the exact defect `resolveStopReason` was written to delete.** Its own comment
(`execute-batch.ts:2133-2139`) describes run `v2r_01kzfb6py8pbxznqv022p2qkhb` publishing
`walks-blocked-by-site` "against a healthy customer survey that had refused NOTHING — 41 of 46 walks
drove it to its terminal screen", and calls an unfounded accusation about a customer's site "the
worst-shaped [error] this pipeline can emit". The fix demanded *evidence*. Arm 1 of `classifyEnding`,
added later for a different purpose, now manufactures that evidence out of a termination page working
exactly as documented. **The gate is intact; its input became poisoned.**

### 2.3 Can a completed walk's run still die `step-timeout` / `instance-stalled` and bury the evidence?

Yes, and the window is real.

- `step-timeout` is not an executor code. It comes from `classifyFailure`
  (`run-workflow.ts:501`, `530-532`, `564`) recognising Cloudflare's *"Attempt failed due to internal
  workflows error"*. `instance-stalled` is written only by the cron sweeper (`sweeper.ts:476-487`).
  Neither appears in `EXEC_STOP_REASONS` (`execute-batch.ts:131-138`).
- **The burial window.** Screen artifacts are written *during* the walk (`browser/capture.ts`, called
  per screen), but the walk ROW enters the durable ledger only afterwards
  (`execute-batch.ts:968`, `1540`, `1618`, each followed by `saveProgress`). If the Workflow step is
  axed between the completion page being captured and `saveProgress` landing, the R2 objects for the
  completed walk exist and **no `WalkRecord` names them** — so `deriveAttempts`
  (`assemble-record.mjs:547`) emits no row and the record cannot see the completion at all.
- A deep walk is the longest single unit in the system, so it is the most likely thing to be inside
  that window when the 80-minute step axe (`BATCH_POLICY`, `run-workflow.ts:335`) falls.

I could not determine statically how wide that window is in wall-clock terms; it depends on R2 write
latency and where in the batch the completion lands.

---

## 3. Every fail-shut gate between observation and published report

For the first-completion run shape: **1 completed deep walk + several screened-out probes + ~400
never-run cases.**

---

### G1 — The typed ending never reaches the RunRecord *(PROVEN)*

**`worker-v2/src/workflow/stages/assemble-record.mjs:569-588`** and **`worker-v2/src/types/record.ts:786-814`**

`walkRecord` carries the ending onto the ledger row (`execute-batch.ts:2206`, deliberately, with a
comment about why there is no `??` default). `deriveAttempts` then drops it. A case-insensitive grep
for `ending` across `assemble-record.mjs` returns only matches inside the word *pending*, and
`AttemptRecordV2` (`types/record.ts:786-814`) has no ending field.

**What trips it:** every run. The one fact the deliverable is about — "this walk reached the
completion page" — exists in `progress.json` and in the path-observation artifact, and is absent from
the signed document the report renders from.

**Consequence:** the report has no way to say "completion reached". This is the single blocker that
makes the deliverable unachievable as the code stands.

**Fix:** carry the ending through the attempt projection.

```diff
--- a/worker-v2/src/types/record.ts
+++ b/worker-v2/src/types/record.ts
@@ -800,6 +800,16 @@ export interface AttemptRecordV2 {
   startedAt: string | null;
   endedAt: string | null;
   ok: boolean;
   stopReason: string | null;
+  /**
+   * HOW THE WALK ENDED, as the walker typed it from its own final screen. Optional because
+   * ledger rows written before endings were typed do not have one, and `null` must stay
+   * distinguishable from "we did not look". Never defaulted: absence is never a completion.
+   */
+  ending?: { kind: "completed" | "screened-out" | "stalled" | "unclassified"; evidence: string[] } | null;
   /** Catalogue entries stamped with this walk's route AND attempt. */
   evidenceIds: string[];
```

```diff
--- a/worker-v2/src/workflow/stages/assemble-record.mjs
+++ b/worker-v2/src/workflow/stages/assemble-record.mjs
@@ -580,6 +580,12 @@ export function deriveAttempts({ walks, evidence }) {
       // `ok` IS THE LEDGER'S OWN WORDS, NOT AN OPINION: the driver wrote `outcome` and
       // `loadCrash`, and a walk that crashed on load is not ok however it finished.
       ok: reachedAnEnding(w),
       stopReason: typeof w?.outcome === "string" ? w.outcome : null,
+      // CARRIED ONLY WHEN THE LEDGER HAS IT. A row from before endings were typed keeps the
+      // key absent, so `"ending" in attempt` still separates "no ending" from "not looked at".
+      ...(w && typeof w === "object" && w.ending !== undefined ? { ending: w.ending } : {}),
       evidenceIds: walkEvidenceIds(evidence, w),
```

---

### G2 — The attempt that finished the survey is recorded `ok: false` *(PROVEN)*

**`worker-v2/src/workflow/stages/assemble-record.mjs:583`**

```js
      ok: w?.outcome === "completed" && w?.loadCrash !== true,
```

`worker-v2/src/browser/types.ts:572-573` states the contradiction outright:

> `outcome`'s `"completed"`, meanwhile, means "the step loop exited under budget" — **a real
> thank-you page lands on `"no-advance-control"`, not on `"completed"`.**

So this line marks `ok: true` for walks that ran out of *plan* mid-survey and `ok: false` for the walk
that ran out of *survey*. The flag is inverted for precisely the case the deliverable is about. The
comment above it — "`ok` IS THE LEDGER'S OWN WORDS, NOT AN OPINION" — is true and is the reason
nobody caught it: it faithfully copies a field whose name is a false friend, which is the same
two-meanings-in-one-value defect that made `WalkEnding` necessary.

**Fix:** accept both terminal outcomes, and prefer the typed ending when present.

```diff
--- a/worker-v2/src/workflow/stages/assemble-record.mjs
+++ b/worker-v2/src/workflow/stages/assemble-record.mjs
@@ -593,6 +593,28 @@ const walkKey = (w) => JSON.stringify([w?.pathId ?? null, w?.attemptId ?? null]);
+/**
+ * DID THIS WALK REACH AN ENDING? — and NOT `outcome === "completed"`, which is the step
+ * loop's own budget bookkeeping. `browser/types.ts` states it: a real thank-you page lands on
+ * `"no-advance-control"`. Reading `outcome` alone marked the one walk that finished the survey
+ * `ok: false` and marked walks that ran out of PLAN mid-survey `ok: true`.
+ *
+ * The typed ending is preferred when the row carries one, because it is the field that was
+ * built to answer this question. A row without one falls back to the two terminal outcomes,
+ * which is the honest older reading and never a guess about which kind of ending it was.
+ */
+function reachedAnEnding(w) {
+  if (w?.loadCrash === true) return false;
+  const kind = w?.ending && typeof w.ending === "object" ? w.ending.kind : null;
+  if (kind === "completed" || kind === "screened-out") return true;
+  if (kind === "stalled" || kind === "unclassified") return false;
+  return w?.outcome === "completed" || w?.outcome === "no-advance-control";
+}
+
```

(The call site change is in the G1 diff above: `ok: reachedAnEnding(w)`.)

---

### G3 — The report reads a field the v2 record does not have, so every stop reason prints as "other" *(PROVEN)*

**`pipeline/report/lib/view-model.mjs:483`** against **`worker-v2/src/types/record.ts:803`**

```js
    const r = a?.stop?.reason ?? "other";
```

`AttemptRecordV2` has a **flat** `stopReason: string | null` (`types/record.ts:803`), written flat by
`deriveAttempts` (`assemble-record.mjs:584`). There is no `stop` object and no normalisation — I
grepped `render-v2-views.mjs` for `stopReason`/`attempts` and found none.

**What trips it:** every v2 run. `stopReasons` becomes `{ "other": N }`, and the report prints
(`view-model.mjs:524`):

> "No enforced limit was reached. Recorded attempt stop reasons: other ×N."

The completion walk's `no-advance-control` — the closest thing the record currently has to a
completion signal — is invisible.

**Fix:** read the field the record actually writes, keeping the legacy shape.

```diff
--- a/pipeline/report/lib/view-model.mjs
+++ b/pipeline/report/lib/view-model.mjs
@@ -480,7 +480,11 @@
   /* ---------------- completion: two independent outcomes ---------------- */
   const stopReasons = new Map();
   for (const a of attempts) {
-    const r = a?.stop?.reason ?? "other";
+    // v1 nested `stop.reason`; v2's AttemptRecordV2 writes a FLAT `stopReason`
+    // (worker-v2/src/types/record.ts). Reading only the nested one made every v2
+    // attempt count as "other" and hid the walker's own account of how it stopped.
+    const r = a?.stop?.reason ?? a?.stopReason ?? "other";
     stopReasons.set(r, (stopReasons.get(r) || 0) + 1);
   }
```

---

### G4 — A correct termination page manufactures the "site blocked us" accusation *(PROVEN)*

**`worker-v2/src/browser/driver.ts:4405`** → **`execute-batch.ts:2096`** → **`execute-batch.ts:2127`** → **`execute-batch.ts:2151`**

Chain in §2.2. `outcome: "blocked"` is *required* for arm 1 to recognise the measured termination
page, and `outcome: "blocked"` is *sufficient* for `hasBlockingEvidence`.

**What trips it:** any run containing a screened-out probe on this instrument — i.e. the exact
first-completion run shape.

**Fix:** a walk whose own typed ending is `screened-out` is not evidence that the site refused us; it
is evidence that we were correctly turned away.

```diff
--- a/worker-v2/src/workflow/stages/execute-batch.ts
+++ b/worker-v2/src/workflow/stages/execute-batch.ts
@@ -2125,7 +2125,20 @@
 /** Did anything in this run actually get refused? Absent evidence is NOT evidence. */
 export function hasBlockingEvidence(walks: readonly WalkRecord[]): boolean {
-  return walks.some((w) => BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0);
+  // A WALK THAT REACHED A TERMINAL PAGE DID NOT GET REFUSED, whatever its outcome says.
+  // `classifyEnding` arm 0 (driver.ts:4405) REQUIRES `outcome: "blocked"` to recognise the
+  // measured test-mode termination page — the survey rendering a dead ">>" beside its own
+  // "you do not qualify" wording. Counting that as blocking evidence lets a screener behaving
+  // exactly as documented produce `walks-blocked-by-site` about a healthy customer survey,
+  // which is the accusation this function exists to require evidence for.
+  const reachedTerminal = (w: WalkRecord): boolean => {
+    const kind = w.ending?.kind;
+    return kind === "completed" || kind === "screened-out";
+  };
+  return walks.some(
+    (w) => !reachedTerminal(w) && (BLOCKING_OUTCOMES.has(w.outcome) || (w.blockedSteps ?? 0) > 0),
+  );
 }
```

*Note the residual:* a walk that was genuinely blocked mid-survey AND happens to end `screened-out`
would stop counting. That is the withholding direction (it costs an accusation, never fabricates
one), which is the correct side to err on per CLAUDE.md.

---

### G5 — Never-run cases are labelled `blocked` rather than `not-reached` *(PROVEN)*

**`worker-v2/src/workflow/stages/derive-verdicts.ts:98-111`** and **`run-workflow.ts:3427-3428`**

Both map "any reason code that is not a `-cap`" to `blocked`. `walks-blocked-by-site`,
`coverage-shortfall-unexercised`, `no-executable-work` and `plan-missing` all land there. Only
`coverage-shortfall-unexercised` and `no-executable-work` are *ours*; calling them `blocked` puts
400+ cases in the signed record under a word that means the site stopped us.

**Fix:** name our own shortfall as ours.

```diff
--- a/worker-v2/src/workflow/stages/derive-verdicts.ts
+++ b/worker-v2/src/workflow/stages/derive-verdicts.ts
@@ -99,12 +99,22 @@ function unreachedFromCursor(inputs: RunInputs): Record<string, string> {
   const cursor = inputs.checkpoint?.execution ?? null;
   const reason = inputs.checkpoint?.completion.reasonCode ?? null;
   if (!cursor || cursor.pendingCaseIds.length === 0) return {};
+  // OUR SHORTFALL IS NOT THEIR REFUSAL. `blocked` in a signed record reads as "the site
+  // stopped us here"; these three codes mean "we never drove this case at all". Mapping them
+  // to `blocked` put hundreds of never-attempted cases into the record as site refusals.
+  const OUR_SHORTFALL = new Set([
+    "coverage-shortfall-unexercised",
+    "no-executable-work",
+    "batch-budget-exhausted",
+  ]);
   const status =
     reason === "wall-clock-cap"
       ? "time-exhausted"
       : reason && reason.endsWith("-cap")
         ? "budget-exhausted"
-        : reason
+        : reason && OUR_SHORTFALL.has(reason)
+          ? "not-reached"
+          : reason
           ? "blocked"
           : "not-reached";
   return Object.fromEntries(cursor.pendingCaseIds.map((id) => [id, status]));
```

---

### G6 — `EVIDENCE_NAME_COLLISION` is not fully closed: the history-shim double walk collides deterministically *(PROVEN)*

**`worker-v2/src/workflow/stages/run-inputs.ts:152-163`** (gate) · **`browser/capture.ts:78-85`** (naming) · **`execute-batch.ts:1374`, `1460`** (the collision)

The uniqueness key is the bare basename:

```ts
// run-inputs.ts:152-163
const byName = new Map<string, string[]>();
for (const entry of evidence) {
  const ref = String(entry.artifactRef ?? entry.sourceEvidenceId ?? entry.evidenceId);
  const name = ref.split("/").pop() ?? entry.evidenceId;
  ...
}
if (collisions.length > 0) throw new ArtifactNameCollision(collisions);
```

The task-#22 fix made re-attempts disjoint by threading an **attempt ORDINAL** (not `attemptId`) into
the ref:

```ts
// browser/capture.ts:78-85
const observationRef = (ctx: Pick<CaptureContext, "pathId" | "attemptOrdinal">, leaf: string): string => {
  const ordinal = ctx.attemptOrdinal ?? 0;
  const attemptLeaf = ordinal > 0 ? `retry-${ordinal}-${leaf}` : leaf;
  return `observations/${ctx.pathId}/${artifactSlug(ctx.pathId)}-${attemptLeaf}`;
};
```

It covers **committed** re-attempts only. Three holes remain:

1. **History-shim double walk — deterministic, not a race.** The crashed walk and the shimmed re-walk
   share one `CaptureContext` (`execute-batch.ts:1374` default `walkCap = cap`; re-walk at
   `execute-batch.ts:1460` `obs = await walkOnce(true)`; multilane equivalent at
   `multilane.ts:235-261`). `cap` is built at `execute-batch.ts:1357` and never recomputed after the
   crash row is pushed. Both walks end at `driver.ts:5472` `capturePathObservation(cap, obs)`,
   writing the same basename with different bytes (`shimmed: true`).
2. **Crash/replay between artifact write and `saveProgress`** — `BATCH_POLICY` retries once
   (`run-workflow.ts:335`); `priorAttemptsOfPath` (`execute-batch.ts:1356`) is recomputed from durable
   rows that lack the lost attempt, reproducing the same ordinal.
3. **Two lanes on one pathId in a wave** — `priorAttempts` snapshotted once per wave
   (`multilane.ts:327-329`). Latent today; nothing asserts the invariant.

**Consequence:** `derive-verdicts.ts:200-207` returns `EVIDENCE_NAME_COLLISION`, no judgement is
minted, and the report loses its entire re-derived column. Loud, not silent — but a single load-crash
on the long deep walk costs the deliverable.

**Fix (hole 1, the deterministic one):** give the shim re-walk its own ordinal.

```diff
--- a/worker-v2/src/workflow/stages/execute-batch.ts
+++ b/worker-v2/src/workflow/stages/execute-batch.ts
@@ -1455,7 +1455,17 @@
       if (obs.loadFailure && allowShim && !progress.shimRequired) {
         progress.walks.push(walkRecord(obs, caseIdsFor(item), NOT_ASSESSED, undefined, obs.observationEvidenceId));
         await saveProgress(env, progress);
-        obs = await walkOnce(true);
+        // A NEW ORDINAL FOR THE SHIMMED WALK. `observationRef` (browser/capture.ts) keys the
+        // artifact basename off pathId + attemptOrdinal and IGNORES attemptId, so re-using this
+        // walk's capture context writes the crashed walk's basenames a second time with different
+        // bytes — two catalogue entries, one basename, and `ArtifactNameCollision` costs the whole
+        // run its judgement. The crash row was just saved, so recomputing from durable rows is
+        // exactly the disjointness rule the committed-retry path already uses.
+        const shimOrdinal = progress.walks.filter((w) => w.pathId === item.path.id).length;
+        obs = await walkOnce(true, attemptId, { ...cap, attemptOrdinal: shimOrdinal });
       }
```

(`walkOnce`'s signature is `(shim, walkAttemptId = attemptId, walkCap = cap, ...)` —
`execute-batch.ts:1371-1376` — so the capture context is the **third** argument and `attemptId` must
be passed through explicitly. The multilane path at `multilane.ts:235-261` needs the same treatment.)

---

### G7 — Seed receipt refusals are recorded and then deliberately hidden *(PROVEN — task #18)*

**`worker-v2/src/workflow/stages/execute-batch.ts:1494-1505`** (recorded) ·
**`worker-v2/src/api/execution-activity-projection.ts:841`** (dropped) ·
**`worker-v2/tools/tests/execution-activity-api.test.mjs:18-36`, `:337-339`** (asserted secret)

A refused seed receipt blocks case closure — `applySeedAttemptCommit`
(`execute-batch.ts:679-681`) returns `closed: []`, so the case stays in `pendingCaseIds`, never
increments `counts.exercised`, and ends up in the 400+ that get relabelled `blocked` by G5. But
the *reason* goes nowhere: `parseSeedReceiptRefusals` returns `void`
(`execution-activity-projection.ts:1038`), the projection's return at `:841` omits it, and
`execution-activity-api.test.mjs` lists `RAW_SEED_REFUSAL_REASON` in its `SECRETS` array and asserts
it never appears in the serialised output.

Measured precedent: run `v2r_01m04jhrymz7wh490kq5jxke65`'s `progress.json` carries four refusals, all
`"retained step 0 is not the next planned history transition"`, `caseWitnessReceipts: 0`,
`counts.exercised: 0` — and none of that text appears in `record.json`, `checkpoint.json` or
`report-current.json`. Four refusals, zero legible.

This is a direct CLAUDE.md violation ("Fail loudly, never silently short" / "Report what was NOT
covered"). Status per `docs/LOOP-RUNBOOK.md:201-202`: open, explicitly deferred.

**Fix:** surface a counted, reason-coded summary. The privacy test is about *raw* reasons leaking to
an unauthenticated projection; a bucketed count is not the raw string.

```diff
--- a/worker-v2/src/workflow/stages/assemble-record.mjs
+++ b/worker-v2/src/workflow/stages/assemble-record.mjs
@@ -862,6 +862,20 @@
     refusals: arr(checkpoint.execution.seedExecution.refusals),
+    // WHY SEEDED CASES DID NOT CLOSE. A refused witness receipt keeps its case pending, and the
+    // case then lands in the never-reached bucket with no way for a reader to tell a case we
+    // never drove from one we drove and could not credit. Counted by reason, so the record says
+    // "4 seeded cases were not credited, all for the same reason" instead of saying nothing.
+    seedReceiptRefusalsByReason: Object.entries(
+      arr(progress?.seedReceiptRefusals).reduce((acc, row) => {
+        const reason = typeof row?.reason === "string" ? row.reason : "unstated";
+        acc[reason] = (acc[reason] ?? 0) + 1;
+        return acc;
+      }, {}),
+    ).map(([reason, count]) => ({ reason, count })),
```

---

### G8 — The test axis will never close, and the blocker sentence will name the wrong cause *(PROVEN, by design + G5)*

**`worker-v2/src/workflow/run-workflow.ts:3344-3352`**

With ~400 unsettled cases the axis cannot close, and that refusal is **correct** — a run that verified
a handful of cases has not tested a 400-case contract. Nothing here should be relaxed.

The defect is only the *wording*, inherited from G5: the sentence will say `blocked: 4xx` when it
should say `not-reached: 4xx`. Fixing G5 fixes this sentence with no change here.

**No diff proposed.** This gate should keep failing shut. It is the honest half of the report.

---

### G9 — Two readers disagree about which screen the walk ended on *(PROVEN, low frequency)*

**`worker-v2/src/workflow/stages/verify-observations.ts:1732-1738`** vs **`worker-v2/src/browser/driver.ts:4518-4522`**

```ts
// driver.ts:4518-4522
function finalScreenOf(steps: StepObservation[]): RenderedScreen | null {
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
  if (!last) return null;
  return last.screenAfterAdvance ?? last.screenAfterAction ?? last.screenBefore ?? null;
}
```
```ts
// verify-observations.ts:1732-1738
function finalScreenSignature(walk: PathObservation): string | null {
  const last = walk.steps.length > 0 ? walk.steps[walk.steps.length - 1] : undefined;
  if (!last) return null;
  const screen = last.screenAfterAdvance ?? last.screenBefore ?? null;
```

The verifier omits `screenAfterAction`. On the terminal `!nb` step (`driver.ts:4961-4995`)
`screenAfterAdvance` is always `null`, so the driver classifies from `screenAfterAction` when an
action occurred and the verifier compares `screenBefore`. Any action on the completion page — which
C4 shows is not only possible but likely, given the unprotected skip menu — makes the two signatures
differ and trips `TERMINAL_ENDING_NOT_BOUND_TO_DESTINATION`
(`verify-observations.ts:1823-1831`), costing the terminal-destination verdict.

This fails in the withholding direction, which is correct, but it will silently cost the one verdict
the first completion could earn.

**Fix:** align the two readers.

```diff
--- a/worker-v2/src/workflow/stages/verify-observations.ts
+++ b/worker-v2/src/workflow/stages/verify-observations.ts
@@ -1733,7 +1733,12 @@ function finalScreenSignature(walk: PathObservation): string | null {
   const last = walk.steps.length > 0 ? walk.steps[walk.steps.length - 1] : undefined;
   if (!last) return null;
-  const screen = last.screenAfterAdvance ?? last.screenBefore ?? null;
+  // THE SAME PRECEDENCE THE PRODUCER USED (driver.ts#finalScreenOf), INCLUDING
+  // `screenAfterAction`. On the terminal no-advance-control step `screenAfterAdvance` is
+  // always null, so omitting the post-action screen made this compare a DIFFERENT screen from
+  // the one the ending was classified from whenever the walker acted on the terminal page —
+  // and a mismatch here refuses the verdict, so the divergence was costing findings silently.
+  const screen = last.screenAfterAdvance ?? last.screenAfterAction ?? last.screenBefore ?? null;
   const sig = screen?.screenSignature;
```

---

### G10 — `classifyEnding` has no completion arm for a dead forward control *(PROVEN — this is C1 as a gate)*

**`worker-v2/src/browser/driver.ts:4405-4426`**

**Fix:** the symmetric arm, with the same evidence discipline.

```diff
--- a/worker-v2/src/browser/driver.ts
+++ b/worker-v2/src/browser/driver.ts
@@ -4412,6 +4412,26 @@
       ],
     };
   }
+  // ---- 0b. a COMPLETION page wearing a dead forward control ----
+  // The mirror of arm 0, and it is needed for the same measured reason. The test-mode chrome on
+  // this platform renders a ">>" on its END pages (run v2r_01m07qpwcjamfpcs89frs3syjs, screen 15,
+  // pressed twelve times without the screen changing) — and that chrome is not specific to the
+  // TERMINATION page. Without this arm a completion page carrying the same inert control falls to
+  // arm 1 and is typed `stalled`, which is the "we gave up" reading of a survey that finished.
+  //
+  // The same fence as arm 0 and no weaker: the control must have been MEASURED inert on this walk
+  // (`outcome: "blocked"`), and the screen-out lexicon has already been consulted above, so a page
+  // carrying both wordings is still a screen-out.
+  if (advance && completion && !screenout && ctx.outcome === "blocked") {
+    return {
+      kind: "completed",
+      evidence: [
+        `the final screen says: ${JSON.stringify(completion)}`,
+        `a forward control is rendered but this walk MEASURED it inert: outcome "blocked" — the screen never changed after pressing it`,
+        `no screen-out wording matched this page`,
+        ...provenance,
+      ],
+    };
+  }
   // ---- 1. the survey was still offering a way on ----
   if (advance) {
```

---

### G11 — The navigator-default can answer its way off the completion page *(PROVEN mechanism / SPECULATIVE trigger — this is C4 as a gate)*

**`worker-v2/src/browser/driver.ts:3580-3601`** (filler) · **`driver.ts:4264`** (guard, uncalled here) · **`driver.ts:4860`, `4908`** (order)

**Fix:** consult the guard the codebase already has, in the one place that actuates.

```diff
--- a/worker-v2/src/browser/driver.ts
+++ b/worker-v2/src/browser/driver.ts
@@ -3506,6 +3506,20 @@
   for (const c of nativeSelects) {
+    // NEVER ACTUATE PLATFORM NAVIGATION CHROME ON A NAVIGATOR-DEFAULT. `isPlatformNavigationWidget`
+    // already identifies a jump menu (a <select> of question ids); it was consulted by
+    // `advanceSignals` and by `classifyEnding` and by nothing that ACTS. So the filler treated the
+    // test link's QUESTION SKIP MENU as a question and selected its first option — dispatching
+    // `change`, which on some platforms navigates. On the completion page that walks the walker
+    // off the one screen the run exists to reach, before `resolveAdvanceControl` (line ~4908) has
+    // even looked at it. A PLANNED answer still actuates: a plan naming this control is a
+    // deliberate act, and only the invented default is withheld.
+    const plannedOwner = selectOwners.some((owner) => owner.controlIdxs.includes(c.idx));
+    if (!plannedOwner && isPlatformNavigationWidget(c, screen)) {
+      nameUnfillableControl(
+        c,
+        "unsupported-widget",
+        "native select is platform navigation chrome (a jump/skip menu), not a survey question; no navigator-default answer was invented for it",
+      );
+      continue;
+    }
     // A hidden native select MAY back a custom widget, an alternate responsive layout, or a
```

---

### Gates checked and found sound for this run shape

- **`rejectUnaccountedFailures`** (`assemble-record.mjs:993-1042`, called at
  `assemble-record.ts:278-279`) — the accounting is total by construction; a correct assembly cannot
  trip it. No first-completion risk.
- **`rejectModelDerivedVerdicts`** (`derive-verdicts.ts:66`, `assemble-record.ts:131`, `:231`) — no
  model runs on this path.
- **`decidePublication`** (`report/build.ts:775-822`) — allows publication in both states; it only
  refuses a *contradiction* between the judgement state and the page. Not a first-completion risk.
- **`selectWork`** (`execute-batch.ts:787-831`) — bounded; pending cases cannot loop the run.
- **`testAxisBlockers`** (`run-workflow.ts:3323-3392`) — refuses correctly; see G8.

### Can the report publish honestly? — the direct answer

**It can publish. It cannot yet be honest.**

Publication is not gated on the axis:

```ts
// report/build.ts:702
  const final = publication.kind === "attested-current" && cp?.completion.test === "complete";
```

`final` becomes `false` and the report still renders and publishes (`report/build.ts:704-733`). So
the "certification unknown / not final" state is reachable and is *not* a refusal — good.

What it cannot do, as the code stands, is say the three things the owner needs:

| The report must say | Can it? | Why not |
|---|---|---|
| "the walk reached the completion page" | **no** | G1 — the ending is not in the record; G2 — the attempt reads `ok: false`; G3 — its stop reason prints as "other" |
| "terminations were exercised" | **partly** | the screened-out probes are also endings dropped by G1; only their `outcome: "blocked"` survives, which reads as the site refusing us (G4) |
| "the remainder is named not-covered" | **no** | G5 — 400+ never-run cases are recorded as `blocked`, and the axis blocker sentence repeats it (G8) |

With G1, G2, G3, G4 and G5 shipped, all three become sayable and the report's "not final /
partial-incomplete" framing is then the *correct* and honest one.

---

## 4. Before the end-to-end run, ship these 5

Ordered by damage-to-effort. Efforts are for the change plus a test that can fail.

| # | Change | Gates | Why first | Effort |
|---|---|---|---|---|
| **1** | **Carry the typed ending into `AttemptRecordV2`, and fix `ok`** | G1, G2 | Without it the completion is unreportable *by construction* — the signed record has no field that can hold the fact, and the field that comes closest is inverted. Everything else on this list is a mislabel; this one is an absence. | **2–3 h** (`types/record.ts` field, `deriveAttempts` projection + `reachedAnEnding`, one fixture asserting a `no-advance-control` + `ending.kind: "completed"` row lands `ok: true` with the ending intact) |
| **2** | **Stop a correct termination page from producing `walks-blocked-by-site`** | G4, G5 | This is the accusation `resolveStopReason` was written to prevent, re-entering through a side door. It corrupts the run label, all 400+ case statuses, and the axis blocker sentence in one hop — and it is aimed at a customer's survey. | **2 h** (`hasBlockingEvidence` terminal-ending exemption; `OUR_SHORTFALL` set in `unreachedFromCursor`; a negative fixture proving a screened-out-only run no longer emits the accusation, and a positive one proving a genuinely blocked walk still does) |
| **3** | **Add the completion twin of `classifyEnding` arm 0, and widen `COMPLETION_MARKERS`** | G10, C1, C3 | If the completion page wears the test-mode `">>"`, or says "thank you for your participation", the walk is typed `stalled` or `screened-out` and items 1 and 2 have nothing to carry. Measured evidence for the control shape already exists in-repo. | **2–3 h** (arm 0b; add `participation`, `successfully completed`, `answers.*saved`, `end of the survey`, `status[:\s]+complete` to the lexicon; extend `tools/mutate-endings.mjs` so each new arm has a mutant that kills it) |
| **4** | **Do not let the navigator-default actuate platform navigation chrome** | G11, C4 | The cheapest catastrophic failure on the list: the walker answers the skip menu on the completion page and walks off it, and the run produces no completion at all. The guard already exists and is simply not called from the actuator. | **1–2 h** (one guard call in the native-select loop; a test that a screen whose only select is a skip menu produces zero `select-option` actions and a named unfillable) |
| **5** | **Give the history-shim re-walk its own attempt ordinal** | G6 | Deterministic, not a race: one load-crash on the long deep walk collides basenames and costs the entire run its judgement and its re-derived column. The deep walk is the most crash-exposed unit in the system. | **1–2 h** (sequential path at `execute-batch.ts:1460` and the multilane equivalent at `multilane.ts:235-261`; a test driving a crash-then-shim pair through `loadArtifactBytes` without a collision) |

**Total: roughly 8–12 hours.** Items 1 and 2 are the minimum for a report that is not actively
misleading; 3 and 4 are the minimum for the completion to be *reached and recognised* at all.

### Deliberately not on the list

- **G7 (seed receipt refusals, task #18)** — real, and a genuine CLAUDE.md "fail loudly" violation,
  but it degrades coverage *legibility*, not the completion headline. Ship after the run.
- **G8 (test axis refuses)** — working as designed. Do not touch it.
- **G9 (final-screen precedence)** — a one-line alignment worth taking with item 4, since item 4
  reduces how often it fires. On its own it costs one verdict, not the deliverable.

---

## 4b. Concurrent uncommitted work in `driver.ts` — read this before shipping §4

While this audit was being written, `worker-v2/src/browser/driver.ts` carried **187 uncommitted
insertions** in the working tree that were not present at the commit this audit started from
(`0f48649`). I did not write them, did not commit them, and left them untouched. They are the
forced-exposure-gate fix — measured live 19 Aug 2026, run `v2r_01m0dj2vcznwcw8krwxhyw5qan`, screen 42,
question C20, where the page rendered its `>>` with `visible: false` and printed *"You will be
allowed to proceed in 15 seconds"*, and the walk read the screen at that instant, concluded the
survey had ended, and stopped with 79% unreached.

**The change is sound and it helps.** It adds `withheldForwardControls` / `awaitForwardRelease`, waits
boundedly (2s poll, 30s ceiling) for a present-but-inoperable forward control to open, and — crucially
for this audit — **does not change `outcome`**, which stays `"no-advance-control"`. So the arm-3 gate
at `driver.ts:4430` still admits a completed walk. It also names the withheld control in
`outcomeDetail` and counts a `forward-control-withheld` reader limitation, which is exactly the
"fail loudly" posture.

**But it adds a new arm 3b to `classifyEnding`, and that arm makes finding C3 materially worse.**
The arm sits after the completion arm — correctly, and its comment says so — and returns:

```ts
  const withheldForward = withheldForwardControls(final);
  if (withheldForward.length > 0) {
    return {
      kind: "stalled",
      ...
```

`withheldForwardControls` selects buttons where `!b.visible || b.disabled` and the role is `next`, or
is neither `back` nor a symbolic-back glyph. Survey end-page templates very commonly ship a hidden or
disabled submit/next control. So:

- **Before this change:** a completion page whose wording misses all five `COMPLETION_MARKERS`
  (§1.3 C3 — "thank you for your participation", "you have successfully completed", "your answers
  have been saved", the platform's own "Survey status: Complete") fell through to arm 4 and was typed
  `unclassified`.
- **With this change:** if that same page carries any hidden or disabled non-back button, it is now
  typed **`stalled`** instead.

`stalled` is strictly worse than `unclassified` here. `unclassified` means "an ending I cannot name"
and `verify-observations.ts:1793-1800` treats it as an honest undecided. `stalled` asserts
*"this walk stopped BEFORE the ending"* — a positive claim that the survey was not finished — and
`verify-observations.ts:1802-1809` refuses it as `WALK_DID_NOT_REACH_AN_ENDING`. On the first
completion that would be a confident wrong answer, which is the cardinal failure.

**Consequences for the shortlist:**

1. **Shortlist item 3 (widen `COMPLETION_MARKERS`) is promoted.** It was the difference between
   `completed` and `unclassified`; with this change in the tree it is the difference between
   `completed` and `stalled`. It should ship *with* this work, not after it.
2. **Shortlist item 5's collision risk is unchanged**, but note the new 30s ceiling adds up to 30
   seconds per terminal screen on any walk ending on a page with a hidden button — including every
   screened-out probe. That widens the step-timeout burial window described in §2.3. Worth a glance
   at the batch budget arithmetic before launch.
3. **Nothing in §3's diffs conflicts with it.** G10's proposed arm 0b inserts before arm 1 and is
   independent of arm 3b; G11 touches `applyDecision`, which this change does not.

**This section is a snapshot of an uncommitted working tree and will go stale.** Whoever picks up
the shortlist should re-diff `driver.ts` first rather than trusting these line numbers.

---

## 5. What I could not determine statically

Stated rather than guessed, per the standing rules:

1. **The live completion page's exact wording and control set.** I did not visit the link. C1, C2 and
   C3 are rated on what the code does with each *possible* shape, plus the measured sibling
   (termination) page in `d42-advance-control-and-endings.test.mjs:775`. Whether the completion page
   inherits the `">>"`, whether it says "thank you for your interest", and whether its wording hits
   any `COMPLETION_MARKERS` regex are all unknown to me.
2. **Whether the QUESTION SKIP MENU navigates on `change`.** `live-jump-walk.mjs:208` says some do and
   some need a form submit; the tool handles both. Which this one is decides whether G11 is a
   catastrophe or a harmless invented answer.
3. **The width of the step-timeout burial window (§2.3).** Depends on R2 write latency and where in
   the batch the deep walk lands. I can show the ordering (artifacts during the walk, ledger row
   after) but not the probability.
4. **~~Whether the step cap is large enough~~ — RESOLVED, and it is fine.** `driver.ts:5390-5392`
   converts an over-cap walk to `outcome: "step-cap"` → `ending: stalled`, so a cap under the
   survey's length would make the completion page unreachable. The deployed value clears it:
   `wrangler.jsonc:190` sets `EXEC_MAX_STEPS_PER_PATH: "120"`, with the sizing argument in the
   comment beside it — *"120 clears the measured ~85-100-screen full traversal (59-screen screener +
   ~15 body questions at the measured 2-3 screens/question)"*. **One caveat worth knowing:** the code
   fallback is `40` (`execute-batch.ts:1207`), which would NOT clear this survey — so a deploy that
   loses the env var silently caps every deep walk at 40 screens and produces `step-cap` / `stalled`
   instead of a completion. Confirm the var is present in the environment the run launches under.
