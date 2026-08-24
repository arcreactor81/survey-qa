#!/usr/bin/env node
/**
 * MUTATION AUDIT for D40 — the report-only sweeper, the cron-gap bound, and the target
 * identity a signed record binds to.
 *
 *   node tools/mutate-sweeper-identity.mjs
 *
 * WHY THIS EXISTS. Every guard added with D40 is a NEGATIVE ("no instance is created", "no run
 * is settled on this tick", "null is never written"), and a negative is the exact shape of
 * assertion that passes when the code under test never runs at all. Eight of those shipped in
 * this repo in one day. So each guard is re-run against a build in which the property it
 * claims to protect has been deliberately broken, and it must go RED — anything else means the
 * test proves nothing, whatever colour it is normally.
 *
 * The scoring is `tools/mutate-runner.mjs`'s: baseline-aware (only a test that was PASSING may
 * count as a kill), each mutant naming THE SPECIFIC test that must fail, and self-checked
 * against both a no-op mutation and a deliberately RED baseline before any result is believed.
 *
 * ============ ONE PROPERTY IS DELIBERATELY NOT SCORED HERE, AND WHY ============
 *
 * FIRST-WRITE-WINS on `envelope.input.targetBuildId` is enforced TWICE — once as an early
 * return on the read, and once again inside the compare-and-set, because between the read and
 * the write a resumed instance can record one. No single-point mutation can therefore break
 * it: remove either guard and the other still holds the property, so such a mutant is
 * equivalent and would be scored SURVIVED for a reason that has nothing to do with the test.
 * Redundant enforcement is the right design here and an honest note beats a mutant that scores
 * the wrong thing.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const SWEEPER = "src/sweeper.ts";
const TARGET_BUILD = "src/store/target-build.ts";
const WORKFLOW = "src/workflow/run-workflow.ts";
const RUNS = "src/api/runs.ts";

await runMutantSuite({
  title: "D40 — sweeper report-only, cron-gap bound, and the recorded target identity",
  // The D40 cases only. The baseline uses the same filter, and every `kills` below names a
  // test inside it, so a mutant is scored against exactly the guards it is meant to break.
  filter: "D40",
  mutants: [
    {
      name: "the restart/re-create rungs are re-enabled",
      breaks: "report-only recovery: the sweeper spends money and overwrites evidence unattended",
      file: SWEEPER,
      find: 'const RECOVERY_MODE = "report-only" as "report-only" | "re-create";',
      replace: 'const RECOVERY_MODE = "re-create" as "report-only" | "re-create";',
      kills: ["REPORT-ONLY: a dead run is SETTLED, and no instance is restarted or re-created"],
    },
    {
      name: "an operator's TERMINATION is handled as an errored instance again (the original defect)",
      breaks: "terminated vs errored: a human's decision is relabelled a fault and becomes recoverable",
      file: SWEEPER,
      find: "return settleTerminated(env, runId, envelope.instanceId);",
      replace:
        'return settle(env, runId, now, tick, { reasonCode: "workflow-errored", detail: "instance terminated", ' +
        'attempt: 0, fence: false, ladder: { reason: "workflow instance terminated", deadInstanceId: envelope.instanceId } });',
      kills: ["AN OPERATOR'S KILL IS A DECISION, NOT A FAULT — and it is recorded as its own thing"],
    },
    {
      name: "a PAUSED instance falls through to the stall path again",
      breaks: "operator territory: a deliberate pause is fenced out and recorded as a fault",
      file: SWEEPER,
      find: '  if (st === "paused") return "paused-operator-territory";',
      replace: "",
      kills: ["A PAUSE IS OPERATOR TERRITORY TOO — untouched, unfenced, and never failed"],
    },
    {
      name: "the cron-gap check always says the schedule is healthy",
      breaks: "the observe-only tick after an outage: 28 missed ticks come due at once",
      file: SWEEPER,
      find: "    maySettle: healthy,",
      replace: "    maySettle: true,",
      kills: ["THE BURST: the first tick after a cron outage settles NOTHING"],
    },
    {
      name: "the per-tick settlement budget is removed",
      breaks: "the bound that holds regardless of WHY many runs came due together",
      file: SWEEPER,
      find: "if (tick.budget.remaining <= 0) {",
      replace: "if (false) {",
      kills: ["THE BUDGET: even a healthy tick settles a bounded number of runs"],
    },
    {
      name: "a stall observation never expires (minimum separation, no maximum staleness)",
      breaks: "the actual burst mechanism: a 140-minute-old strike counts as a second look",
      file: SWEEPER,
      find: 'if (rec.stallValue !== fingerprint || freshness === "stale") {',
      replace: "if (rec.stallValue !== fingerprint) {",
      kills: [
        "STALE EVIDENCE IS RE-TAKEN, NOT COUNTED: an observation from before the outage is not a strike",
      ],
    },
    {
      name: "the settlement is written without fencing the original out",
      breaks: "a live original can overwrite the failure the sweeper just recorded",
      file: SWEEPER,
      find: "      await claimOwnership(env, runId, SWEEPER_FENCE_INSTANCE, epoch);",
      replace: "      void epoch;",
      kills: [
        "STALE EVIDENCE IS RE-TAKEN, NOT COUNTED: an observation from before the outage is not a strike",
      ],
    },
    {
      name: "the derived identity is computed and never persisted",
      breaks: "the whole point: assemble-record.mjs stamps the ENVELOPE, not a return value",
      file: TARGET_BUILD,
      find: "      e.input.targetBuildId = derived;",
      replace: "      void derived;",
      kills: [
        "THE DERIVED IDENTITY IS RECORDED ON THE ENVELOPE, which is what the record stamps from",
        // Named separately: this is the one that proves the SIGNED RECORD changed, not just a
        // field on an internal document.
        "THE SEAM: the assembled record's targetBuildId is the recorded id, not null and not a second answer",
      ],
    },
    {
      name: "an empty capture is allowed to record an identity",
      breaks: "null is never written: a run that saw nothing would become bindable",
      file: TARGET_BUILD,
      find: "    if (!derived) {",
      replace: "    if (false) {",
      kills: ["NULL IS NEVER WRITTEN: a run that captured nothing stays unbindable"],
    },
    {
      name: "only screenshots participate in the derivation",
      breaks: "the characterization test's own premise — proves it is not vacuous",
      file: TARGET_BUILD,
      find: "  const selected = catalog.filter((e) => OBSERVED_SCREEN_TYPES.has(e.type));",
      replace: '  const selected = catalog.filter((e) => e.type === "screenshot");',
      kills: ["CHARACTERIZATION, NOT A GUARD: the derived id is NOT stable across runs, and here is the reason"],
    },
    {
      name: "the workflow no longer records a target identity",
      breaks: "the wiring point: the envelope stays null and every signed record is silent again",
      file: WORKFLOW,
      // Re-anchored: PROJECTION_POLICY was added as step.do's second arg (drifted from pre-PROJECTION_POLICY source)
      find: '      await step.do("record-target-identity", PROJECTION_POLICY, async () => {\n        const identity = await ensureRecordedTargetIdentity(this.env, runId);',
      replace:
        '      await step.do("record-target-identity-removed", PROJECTION_POLICY, async () => {\n' +
        '        const identity = { outcome: "skipped", targetBuildId: null, note: "removed by mutation" };',
      kills: ["THE WIRING: the workflow records the identity BEFORE it derives or assembles anything"],
    },
    {
      name: "a blank DEFAULT_TARGET_BUILD_ID is recorded verbatim again",
      breaks: "blank configuration is not configuration: the record binds to whitespace",
      file: RUNS,
      find: 'targetBuildId: (env.DEFAULT_TARGET_BUILD_ID ?? "").trim() || null,',
      replace: "targetBuildId: env.DEFAULT_TARGET_BUILD_ID ?? null,",
      kills: [
        "BLANK CONFIGURATION IS NOT CONFIGURATION: a whitespace DEFAULT_TARGET_BUILD_ID records as null",
      ],
    },
  ],
});
