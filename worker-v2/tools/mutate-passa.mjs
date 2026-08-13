#!/usr/bin/env node
/**
 * MUTATION EVIDENCE FOR D22 — the pass-A window walk split across Workflow steps.
 *
 *   node tools/mutate-passa.mjs
 *
 * Each mutant below breaks ONE property `tools/tests/d22-passa-waves.test.mjs` claims to
 * guard, and NAMES the test that must newly fail. The kill criterion is the baseline-aware
 * one in `tools/mutate-runner.mjs`: a mutant counts as killed only when a test that was
 * PASSING before the mutation fails, and (because every mutant here declares `kills`) only
 * when THAT named test is among the new failures. "Something went red" is not evidence.
 *
 * ANCHORS ARE DELIBERATELY SINGLE-LINE. The tree carries mixed line endings — pass-a.ts is
 * now LF, run-workflow.ts and stages/extract.ts are CRLF with LF insertions — and a
 * multi-line anchor would depend on which. A single line cannot be broken by an ending, and
 * an anchor that no longer matches exactly once is reported BROKEN-ANCHOR, never a kill.
 *
 * Several anchors are also single-line because the two passes now share phrasing:
 * `if (!result.slice.done)` and `await chargeUsage(env, runId, result.issuedCalls, fence)`
 * each appear in BOTH stages, so pass A's copies are bound to their own named locals
 * (`wholeDocumentRead`, `purchased`) — the mutation cannot be aimed at pass A otherwise.
 *
 * Nothing under `src/**` is ever written: `testkit.mjs#mutantPlugin` rewrites the source
 * inside esbuild's load step, so an interrupted run leaves the working copy untouched.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PASS_A = "src/extract/pass-a.ts";
const STAGE = "src/workflow/stages/extract.ts";
const WORKFLOW = "src/workflow/run-workflow.ts";

const WAVES_NAMED_STOP = "(a) pass A occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure";
const NO_STALL = "a pass-A wave with NO budget at all still issues one call — the wave loop can never stall";
const RESUME_FREE = "(b) a second wave over a finished pass-A buys NOTHING";
const BOUNDED = "a pass-A window that keeps FAILING is re-bought a bounded number of times, not once per wave";
const XREFS = "(c) CROSS-REFERENCES survive a resume — pass A's one output with no pass-B analogue";
const DERIVED_TIMEOUT = "the pass-A step timeout always exceeds its own wave budget by at least one whole PURCHASE";
const HALF_READ = "(a) the STAGE refuses to evaluate an unfinished pass A, and evaluates the finished one";
const BLOCK_LIMIT = "dense pass-A windows stop at the exact block limit while the character limit stays independent";
const FAILURE_REPORTS = "an UNCAUGHT step failure still produces a report — the failure path used to produce none";

await runMutantSuite({
  title: "D22 — pass A is sliced across steps, resumes what landed, and fails by name",
  // No filter: a baseline over a subset is not a baseline for a change that touches the
  // workflow's extraction branch, and collateral damage elsewhere is worth seeing.
  filter: "",
  mutants: [
    {
      name: "the pass-A block ceiling is off by one",
      breaks:
        "a dense 251-block document remains one oversized unit even though the configured ceiling is 250",
      file: PASS_A,
      find: "const reachesBlockLimit = current.length >= blockLimit;",
      replace: "const reachesBlockLimit = current.length > blockLimit;",
      kills: [BLOCK_LIMIT],
    },
    {
      name: "the window walk goes back to ONE step",
      breaks:
        "every wave reuses a single step name, which is the pre-fix shape: one step whose one " +
        "timeout has to cover every serial 90 KB window in the document",
      file: WORKFLOW,
      find: "extract-pass-a-wave-${wave}",
      replace: "extract-pass-a-global",
      kills: [WAVES_NAMED_STOP],
    },
    {
      name: "the pass-A wave loop runs exactly one wave",
      breaks: "a document needing several windows is abandoned after the first",
      file: WORKFLOW,
      find: "wave < maxPassAWaves",
      replace: "wave < 1",
      kills: [WAVES_NAMED_STOP],
    },
    {
      name: "the slice ignores its wall-clock budget",
      breaks:
        "a wave issues every remaining window regardless of the deadline — the unbounded step " +
        "body the 480 s timeout used to kill mid-flight, at 90 KB a call",
      file: PASS_A,
      find: "if (now() < deadlineAt) return true;",
      replace: "if (true) return true;",
      kills: [NO_STALL],
    },
    {
      name: "the guaranteed-progress exemption is removed",
      breaks:
        "a slice whose deadline has already passed issues NOTHING, so the wave loop burns every " +
        "step it owns without moving a single window",
      file: PASS_A,
      find: "if (issued === 0) return true;",
      replace: "if (false) return true;",
      kills: [NO_STALL],
    },
    {
      name: "persisted windows are never read back",
      breaks: "every wave re-buys the whole document — the duplicate spend this design removes",
      file: PASS_A,
      find: "const obj = await env.EVIDENCE.get(windowKey(runId, n));",
      replace: "const obj = null;",
      kills: [RESUME_FREE],
    },
    {
      name: "a failing window is re-bought without bound",
      breaks:
        "the per-window purchase budget is ignored, so one window nobody can answer is bought " +
        "once per wave, per step retry, per recovery instance — the 21–24x billing storm, on the " +
        "most expensive call in the system",
      file: PASS_A,
      find:
        'if (existing && existing.kind === "failed" && existing.attempts >= maxIssues && !pendingFlash) {',
      replace:
        'if (existing && existing.kind === "failed" && existing.attempts >= 999999 && !pendingFlash) {',
      kills: [BOUNDED],
    },
    {
      name: "the window artifact is written without its cross-references",
      breaks:
        "a resumed pass publishes a SHORTER diff than the pass that paid for it, with nothing " +
        "anywhere saying so — the silent-shortening class, reachable only through pass A",
      file: PASS_A,
      find: "crossRefs: windowXrefs,",
      replace: "crossRefs: [],",
      kills: [XREFS],
    },
    {
      name: "the window artifact's cross-references are never read back",
      breaks: "the other half of the same round trip: they are stored and then dropped on reclaim",
      file: PASS_A,
      find: 'crossRefs: (parsed["crossRefs"] ?? []) as CrossRef[],',
      replace: "crossRefs: [] as CrossRef[],",
      kills: [XREFS],
    },
    {
      name: "the step timeout drops the purchase term",
      breaks:
        "the step timeout no longer covers a call that is still in flight when the budget ends, " +
        "so the step axe can kill work that was already billed and not yet persisted",
      file: PASS_A,
      find: "return passAWaveBudgetMs(env) + passACallCeilingMs(env) + PASS_A_STEP_SLACK_MS;",
      replace: "return passAWaveBudgetMs(env) + PASS_A_STEP_SLACK_MS;",
      kills: [DERIVED_TIMEOUT],
    },
    {
      name: "the purchase ceiling forgets that chat.ts retries inside ONE call",
      breaks:
        "one billed purchase can occupy EXTRACT_MAX_ATTEMPTS x LLM_TIMEOUT_MS of wall clock and " +
        "is charged for every attempt; a ceiling of one attempt lets the step axe fall on the " +
        "second one, which is exactly the billed-but-unpersisted call the invariant exists to " +
        "protect",
      file: PASS_A,
      find:
        "return 2 * Math.max(1, num(env.EXTRACT_MAX_ATTEMPTS, 2)) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));",
      replace: "return 2 * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));",
      kills: [DERIVED_TIMEOUT],
    },
    {
      name: "an unfinished pass A is persisted and evaluated anyway",
      breaks:
        "consolidation merges a half-read document as if it were whole and seals a denominator " +
        "over the windows that happened to fit in one step — and pass A's whole purpose is the " +
        "survey-scoped rule that only an unread window may state",
      file: STAGE,
      find: "if (!wholeDocumentRead) {",
      replace: "if (false) {",
      kills: [HALF_READ],
    },
    {
      name: "reclaimed windows are charged to the ledger again",
      breaks:
        "every wave re-counts every window it reclaimed, walking a large document into " +
        "CAP_MODEL_CALLS on calls nobody ever made",
      file: STAGE,
      find:
        "await chargeUsage(env, runId, result.accountingCalls, fence);\n\r\n" +
        "  const wholeDocumentRead = result.slice.done;",
      replace:
        "await chargeUsage(env, runId, result.calls, fence);\n\r\n" +
        "  const wholeDocumentRead = result.slice.done;",
      kills: [HALF_READ],
    },
    {
      name: "the exhausted-waves stop is skipped entirely",
      breaks:
        "a run whose whole-document pass never finished falls through to the block pass and " +
        "consolidation, instead of naming the budget that stopped it",
      file: WORKFLOW,
      find: "if (passAUnfinished) {",
      replace: "if (false) {",
      kills: [WAVES_NAMED_STOP],
    },
    {
      name: "the named stop reports a PARTIAL instead of a failure",
      breaks:
        "a document that was never read all the way through is reported as a test that was cut " +
        "short — `partial-*` over zero exercised work is the overclaim this reason code exists to " +
        "delete",
      file: WORKFLOW,
      find: "d.completion.reasonCode = EXTRACTION_PASS_A_WAVES_EXHAUSTED;",
      replace:
        'd.completion.reasonCode = EXTRACTION_PASS_A_WAVES_EXHAUSTED; d.completion.test = "partial-blocked";',
      kills: [WAVES_NAMED_STOP],
    },
    {
      name: "the uncaught-failure path stops reporting again",
      breaks:
        "a step that throws produces a run with an error on file and NO report to explain it — " +
        "the least legible ending the system can produce, and the one a reader most needs",
      file: WORKFLOW,
      find: "await this.reportAndFinalize(step, runId, reportingFence);",
      replace: "void reportingFence;",
      kills: [FAILURE_REPORTS],
    },
  ],
});
