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
const PASS_B_DECODER = "src/extract/pass-b-decode.ts";
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
      find: "if (!existing.terminal && existing.attempts < maxIssues) {",
      replace: "if (true) {",
      kills: ["a chunk that keeps FAILING is re-bought a bounded number of times, not once per wave"],
    },
    {
      name: "the ledger sweep stops resuming",
      breaks: "sweep artifacts go back to being write-only, so every re-entry re-buys all of them",
      file: PASS_B,
      find: "const existing = await readSweep(env, runId, i, slice, sweepEvidenceBlocks, parserVersion);",
      replace: "const existing = null;",
      kills: ["(c) the ledger sweep resumes too — its calls used to be written and never read back"],
    },
    {
      name: "strict array decoding silently filters a malformed row",
      breaks:
        "a provider array containing one valid row and one malformed row is shortened to the valid prefix, " +
        "turning unread evidence into apparent success",
      file: PASS_B_DECODER,
      find: 'obligations: rows(root["obligations"], "obligations").map((raw, index) =>',
      replace:
        'obligations: rows(root["obligations"], "obligations")' +
        '.filter((raw) => Object.hasOwn(raw, "statement")).map((raw, index) =>',
      kills: [
        "a malformed second row terminalizes the whole chunk, keeps its paid receipt, and never sweeps or shortens",
      ],
    },
    {
      name: "per-block evidence quotes are no longer grounded in source bytes",
      breaks: "invented quotes can support an obligation merely by naming an allowed block id",
      file: PASS_B_DECODER,
      find: "if (!source.text.includes(quote)) fail(`${rowLabel}.quote is not an exact span of source block ${blockId}`);",
      replace: "if (false) fail(`${rowLabel}.quote is not an exact span of source block ${blockId}`);",
      kills: [
        "multi-block obligations, ambiguities, and unverifiable rows require exact per-block quotes",
      ],
    },
    {
      name: "none-observable obligations no longer require an unverifiable evidence row",
      breaks: "the output can claim browser impossibility without a counted mandate and exact source overlap",
      file: PASS_B_DECODER,
      find: "if (!linked) {",
      replace: "if (false) {",
      kills: [
        "none-observable obligations require an exact overlapping unverifiable row; full needs none",
      ],
    },
    {
      name: "a terminal chunk failure is forgotten before the sweep",
      breaks: "the later sweep can launder a decoder failure after its named failed-unit row is dropped",
      file: PASS_B,
      find: "failedUnits.push({ unit: chunk.id, blockIds, detail });",
      replace: "terminalFailure = false;",
      kills: [
        "a malformed second row terminalizes the whole chunk, keeps its paid receipt, and never sweeps or shortens",
      ],
    },
    {
      name: "typed-array corruption becomes a cache miss",
      breaks: "a retained exact-key success can be overwritten by a new purchase",
      file: PASS_B,
      find: 'return invalid("persisted typed arrays do not exactly reconstruct from raw model output");',
      replace: "return null;",
      kills: [
        "mutating a retained successful unit invalidates reconstruction with zero fetches",
      ],
    },
    {
      name: "current-key decoder corruption becomes a cache miss",
      breaks: "malformed retained raw output authorizes an overwrite and a second provider purchase",
      file: PASS_B,
      find: 'return invalid(error instanceof Error ? error.message : "artifact JSON is unreadable");',
      replace: "return null;",
      kills: [
        "corrupt current-key success is terminal on resume and causes zero provider fetches",
      ],
    },
    {
      name: "receipt role binding is bypassed",
      breaks: "a paid receipt from another logical unit can be replayed as this chunk's authority",
      file: PASS_B,
      find: 'usage.role !== `extract-pass-b-${unitId}` ||',
      replace: 'false ||',
      kills: [
        "a current-key receipt with the wrong role is terminal and never authorizes a replacement call",
      ],
    },
    {
      name: "completion hash is detached from exact reconstructed bytes",
      breaks: "the completion can carry a hash that does not name the deterministic Pass-B body",
      file: PASS_B,
      find: "hash: `sha256:${await sha256Hex(body)}`,",
      replace: 'hash: `sha256:${"0".repeat(64)}`,',
      kills: [
        "completed reconstruction is zero-purchase, byte-stable, closed, and returns its exact hash",
      ],
    },
    {
      name: "Pass B starts even though durable Pass-A authority was refused",
      breaks:
        "a missing, replaced, or non-reconstructable Pass-A completion no longer stops the independent " +
        "Pass-B provider purchase at the stage boundary",
      file: STAGE,
      find: 'if (passAAuthority.state !== "evaluated") return settled(passAAuthority);',
      replace: 'if (false) return settled(passAAuthority);',
      kills: ["a changed completed Pass-A hash blocks Pass B before any provider request"],
    },
    {
      name: "an occupied invalid Pass-B completion is treated as rebuildable cache",
      breaks:
        "immutable current-key completion authority is bypassed, so paid units can be re-run and an old " +
        "whole-pass key can be laundered or overwritten",
      file: STAGE,
      find:
        'const already = await readPassPayload(env, runId, "b", expectedParserVersion, documentName, doc);\n' +
        '  if (already) return settled(already);\n' +
        '  if (existingPassObject) {',
      replace:
        'const already = await readPassPayload(env, runId, "b", expectedParserVersion, documentName, doc);\n' +
        '  if (already) return settled(already);\n' +
        '  if (false && existingPassObject) {',
      kills: ["D51-b pass B rejects stale chunk, sweep, and whole-pass artifacts and resets attempts"],
    },
    {
      name: "consolidation ignores the durable Pass-A hash",
      breaks:
        "source-ledger output can be rebuilt over Pass-A bytes other than the exact completion returned by " +
        "the durable Pass-A step",
      file: STAGE,
      find: "if (actual !== expectedPassAHash) {",
      replace: "if (false) {",
      kills: ["integrated consolidation requires the exact durable A and B completion hashes"],
    },
    {
      name: "consolidation ignores the durable Pass-B hash",
      breaks:
        "source-ledger output can be rebuilt over Pass-B bytes other than the exact completion returned by " +
        "the durable Pass-B step",
      file: STAGE,
      find: "if (actualHash !== expectedPassBHash) {",
      replace: "if (false) {",
      kills: ["integrated consolidation requires the exact durable A and B completion hashes"],
    },
    {
      name: "consolidation skips Pass-B unit reconstruction authority",
      breaks:
        "a whole-pass summary whose retained unit was changed after completion can reach merge without the " +
        "zero-purchase unit reconstruction check",
      file: STAGE,
      find:
        '  const passBContinuation = await validatePassBCompletionAuthority(\n' +
        '    env, runId, doc, documentName, expectedPassBHash,\n' +
        '  );\n' +
        '  if (passBContinuation.state !== "evaluated") {',
      replace:
        '  const passBContinuation = await validatePassBCompletionAuthority(\n' +
        '    env, runId, doc, documentName, expectedPassBHash,\n' +
        '  );\n' +
        '  if (false) {',
      kills: [
        "a retained Pass-B unit mutation blocks integrated consolidation with zero re-buy or partial output",
      ],
    },
    {
      name: "seal trusts cached source-ledger after a Pass-B unit changes",
      breaks:
        "the final write boundary no longer reconstructs current Pass-B units, so cached Workflow state can " +
        "seal a denominator after its paid source authority was replaced",
      file: STAGE,
      find: 'if (passB.state !== "evaluated") return invalid(`${passB.reason}: ${passB.detail}`);',
      replace: 'if (false) return invalid(`${passB.reason}: ${passB.detail}`);',
      kills: [
        "cached source-ledger state cannot authorize seal after a retained Pass-B unit mutation",
      ],
    },
    {
      name: "seal ignores the merged payload's Pass-B input binding",
      breaks:
        "even byte-hash-approved merged output can name a different Pass-B completion than the exact one " +
        "being sealed",
      file: STAGE,
      find: "merged.inputAuthority.passBHash !== expectedPassBHash",
      replace: "false",
      kills: ["seal authority rejects merged bytes that do not bind the exact A and B inputs"],
    },
    {
      name: "Workflow seals without invoking the final extraction authority check",
      breaks:
        "the zero-purchase helper remains unit-tested but production no longer calls it before sealContract, " +
        "so a same-count merged replacement reaches the immutable contract revision",
      file: WORKFLOW,
      find:
        "const sealAuthority = await validateExtractionSealAuthority(\n" +
        "            this.env,\n" +
        "            runId,",
      replace:
        "const sealAuthority = { kind: \ok\, merged: await loadMerged(this.env, runId) };\n" +
        "          void validateExtractionSealAuthority;\n" +
        "          void (\n" +
        "            this.env,\n" +
        "            runId,",
      kills: ["(c) WORKFLOW seal is bound to the source-ledger step's merged artifact hash"],
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
      find: "return deepseekPassBAttemptCeiling(env) * Math.max(0, num(env.LLM_TIMEOUT_MS, 300_000));",
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
      find:
        "await chargeUsage(env, runId, result.accountingCalls, fence);\n\n" +
        "  if (result.slice.terminalFailure || result.failedUnits.length > 0) {",
      replace:
        "await chargeUsage(env, runId, result.calls, fence);\n\n" +
        "  if (result.slice.terminalFailure || result.failedUnits.length > 0) {",
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
      // Keep both lines in the anchor: `completion.test = "failed"` occurs at other named
      // extraction stops, while this exact reason-code pair is the pass-B exhaustion seam.
      find: 'd.completion.test = "failed";\n                d.completion.reasonCode = EXTRACTION_WAVES_EXHAUSTED;',
      replace:
        'd.completion.test = "partial-blocked";\n                d.completion.reasonCode = EXTRACTION_WAVES_EXHAUSTED;',
      kills: ["(a) pass B occupies MULTIPLE distinct workflow steps, and exhausting them is a NAMED failure"],
    },
  ],
});
