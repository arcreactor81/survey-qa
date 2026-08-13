#!/usr/bin/env node
/**
 * MUTATION EVIDENCE FOR D21 — the pass-B fan-out split across Workflow steps.
 *
 *   node tools/mutate-passb.mjs
 *
 * Each mutant below breaks ONE property `tools/tests/d21-passb-waves.test.mjs` claims to
 * guard, and NAMES the test that must newly fail. The kill criterion is the baseline-aware
 * one in `tools/mutate-runner.mjs`: a mutant counts as killed only when a test that was
 * PASSING before the mutation fails, and (because every mutant here declares `kills`) only
 * when THAT named test is among the new failures. "Something went red" is not evidence.
 *
 * Nothing under `src/**` is ever written: `testkit.mjs#mutantPlugin` rewrites the source
 * inside esbuild's load step, so an interrupted run leaves the working copy untouched.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PASS_B = "src/extract/pass-b.ts";
const STAGE = "src/workflow/stages/extract.ts";
const WORKFLOW = "src/workflow/run-workflow.ts";

/**
 * The one test name used by more than one mutant, bound ONCE. Test names are the join key of
 * the baseline-aware criterion: a `kills` entry naming a test that does not exist can never
 * become a NEW failure, so the mutant silently scores SURVIVED and reads as a real hole.
 * Binding it to a constant is what stops a rename drifting the two apart.
 */
const DERIVED_TIMEOUT = "the pass-B step timeout always exceeds its own wave budget by at least one whole PURCHASE";

await runMutantSuite({
  title: "D21 — pass B is sliced across steps, resumes what landed, and fails by name",
  // No filter: a baseline over a subset is not a baseline for a change that touches the
  // workflow's extraction branch, and collateral damage elsewhere is worth seeing.
  filter: "",
  mutants: [
    {
      name: "the fan-out goes back to ONE step",
      breaks:
        "every wave reuses a single step name, which is the pre-fix shape: one step whose one " +
        "timeout has to cover the whole chunk walk and the ledger sweep",
      file: WORKFLOW,
      find: "extract-pass-b-wave-${wave}",
      replace: "extract-pass-b-blocks",
      kills: ["(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure"],
    },
    {
      name: "the wave loop runs exactly one wave",
      breaks: "a document needing several waves is abandoned after the first",
      file: WORKFLOW,
      find: "wave < maxWaves",
      replace: "wave < 1",
      kills: ["(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure"],
    },
    {
      name: "the slice ignores its wall-clock budget",
      breaks:
        "a wave issues every remaining chunk regardless of the deadline — which is exactly the " +
        "unbounded step body the 480 s timeout used to kill mid-flight",
      file: PASS_B,
      find: "if (now() < deadlineAt) return true;",
      replace: "if (true) return true;",
      kills: ["a wave with NO budget at all still issues one call — the wave loop can never stall"],
    },
    {
      name: "the guaranteed-progress exemption is removed",
      breaks:
        "a slice whose deadline has already passed issues NOTHING, so the wave loop burns every " +
        "step it owns without moving a single chunk",
      file: PASS_B,
      find: "if (issued === 0) return true;",
      replace: "if (false) return true;",
      kills: ["a wave with NO budget at all still issues one call — the wave loop can never stall"],
    },
    {
      name: "persisted units are never read back",
      breaks: "every wave re-buys the whole document — the duplicate spend this design removes",
      file: PASS_B,
      find: "const obj = await env.EVIDENCE.get(key);",
      replace: "const obj = null;",
      kills: ["(b) a second wave over a finished pass buys NOTHING"],
    },
    {
      name: "a failing unit is re-bought without bound",
      breaks:
        "the per-unit purchase budget is ignored, so one chunk nobody can answer is bought once " +
        "per wave, per step retry, per recovery instance — the 21–24x billing storm",
      file: PASS_B,
      find: "if (existing.attempts < maxIssues) {",
      replace: "if (existing.attempts < 999999) {",
      kills: ["a chunk that keeps FAILING is re-bought a bounded number of times, not once per wave"],
    },
    {
      name: "the ledger sweep stops resuming",
      breaks: "sweep artifacts go back to being write-only, so every re-entry re-buys all of them",
      file: PASS_B,
      find: "const existing = await readSweep(env, runId, i, allowed);",
      replace: "const existing = null;",
      kills: ["(c) the ledger sweep resumes too — its calls used to be written and never read back"],
    },
    {
      name: "the step timeout drops the purchase term",
      breaks:
        "the step timeout no longer covers a call that is still in flight when the budget ends, " +
        "so the step axe can kill work that was already billed and not yet persisted",
      file: PASS_B,
      find: "return passBWaveBudgetMs(env) + passBCallCeilingMs(env) + PASS_B_STEP_SLACK_MS;",
      replace: "return passBWaveBudgetMs(env) + PASS_B_STEP_SLACK_MS;",
      kills: [DERIVED_TIMEOUT],
    },
    {
      name: "the purchase ceiling forgets that chat.ts retries inside ONE call",
      breaks:
        "one billed purchase can occupy EXTRACT_MAX_ATTEMPTS x LLM_TIMEOUT_MS of wall clock and " +
        "is charged for every attempt; a ceiling of one attempt lets the step axe fall on the " +
        "second one, which is exactly the billed-but-unpersisted call the invariant exists to " +
        "protect — and EXTRACT_MAX_ATTEMPTS is undeclared in wrangler.jsonc, so the LIVE value " +
        "is chat.ts's own default of 2",
      file: PASS_B,
      find: "return deepseekContinuityAttemptCeiling(env) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));",
      replace: "return Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));",
      kills: [DERIVED_TIMEOUT],
    },
    {
      name: "an unfinished pass is persisted and evaluated anyway",
      breaks:
        "consolidation merges a half-walked document as if it were whole and seals a denominator " +
        "over the chunks that happened to fit in one step — a silently shorter answer",
      file: STAGE,
      find: "if (!result.slice.done) {",
      replace: "if (false) {",
      kills: ["(a) the STAGE refuses to evaluate an unfinished pass, and evaluates the finished one"],
    },
    {
      name: "reused chunks are charged to the ledger again",
      breaks:
        "every wave re-counts every chunk it reused, walking a large document into CAP_MODEL_CALLS " +
        "on calls nobody ever made",
      file: STAGE,
      find: "await chargeUsage(env, runId, result.issuedCalls, fence);",
      replace: "await chargeUsage(env, runId, result.calls, fence);",
      kills: ["(a) the STAGE refuses to evaluate an unfinished pass, and evaluates the finished one"],
    },
    {
      name: "the exhausted-waves stop is skipped entirely",
      breaks:
        "a run whose block pass never finished falls through to consolidation and reports whatever " +
        "the gates happen to say, instead of naming the budget that stopped it",
      file: WORKFLOW,
      find: "if (passBUnfinished) {",
      replace: "if (false) {",
      kills: ["(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure"],
    },
    {
      name: "the named stop reports a PARTIAL instead of a failure",
      breaks:
        "a document that was never read all the way through is reported as a test that was cut " +
        "short — `partial-*` over zero exercised work is the overclaim this reason code exists to " +
        "delete",
      file: WORKFLOW,
      // NOTE: run-workflow.ts is CRLF on this tree, so a multi-line anchor must carry \r\n.
      // A \n-only anchor matches zero times and the harness reports BROKEN-ANCHOR — which is
      // correctly NOT scored as a kill.
      find: 'd.completion.test = "failed";\r\n              d.completion.reasonCode = EXTRACTION_WAVES_EXHAUSTED;',
      replace:
        'd.completion.test = "partial-blocked";\r\n              d.completion.reasonCode = EXTRACTION_WAVES_EXHAUSTED;',
      kills: ["(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure"],
    },
  ],
});
