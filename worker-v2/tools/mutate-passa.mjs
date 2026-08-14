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
const BOUNDED_RETRY = "a pass-A window that keeps FAILING is re-bought a bounded number of times, not once per wave";
const FALLBACK_STOP = "a receipted Flash result stops later pass-A purchases immediately";
const XREFS = "(c) CROSS-REFERENCES survive a resume — pass A's one output with no pass-B analogue";
const DERIVED_TIMEOUT = "the pass-A step timeout always exceeds its own wave budget by at least one whole PURCHASE";
const HALF_READ = "(a) the STAGE refuses to evaluate an unfinished pass A, and evaluates the finished one";
const BLOCK_LIMIT = "dense pass-A windows stop at the exact block limit while the character limit stays independent";
const FAILURE_REPORTS = "an UNCAUGHT step failure still produces a report — the failure path used to produce none";

const STRICT_PRIMARY = "strictly malformed primary schemas terminalize without a second purchase";
const PRIMARY_GROUNDING =
  "row-local primary grounding failures are retained and counted without gaining authority";
const TYPED_ROW_QUARANTINE =
  "typed primary relational and evidence failures quarantine rows while the tail and synthesis continue";
const SURVIVING_XREF_HANDLE =
  "withholding an earlier xref preserves the surviving source handle through synthesis";
const RAW_SEMANTIC_FAILURE =
  "strict semantic failure retains exact raw output and corrupt authority is never retried";
const UNPROVEN_TARGET =
  "an unproven primary target is downgraded to one unresolved question without trusting its statement";
const RAW_PRIMARY = "retained primary typed projection is re-decoded from raw output and cannot be laundered";
const PRIMARY_LAUNDER = "primary paid success cannot be relabeled as retryable semantic failure";
const SYNTHESIS_INVALID = "malformed or ungrounded synthesis rows terminalize and are never re-bought";
const PRIMARY_LATE_WIRE =
  "late Pass-A overflow blocks A-w1 before secrets and replay remains zero-call";
const SYNTHESIS_WIRE =
  "synthesis bounds aggregate retention, rejects unsafe cap, and counts full refused unit";
const SYNTHESIS_RETAINED = "corrupt or incoherent retained synthesis authority terminalizes with zero new fetch";
const SYNTHESIS_CROSS_ISSUE = "a fallback route receipt cannot bind its trigger and selected leg across different issues";
const SYNTHESIS_SEPARATE_WAVE = "a relation split across windows is added once and resolves the qualified primary xref";
const FALLBACK_CHAIN = "fallback retry authority rejects a missing Flash issue, extra Grok purchase, and ineligible trigger";
const DOCUMENT_SOURCE_BYTES =
  "byte-different DOCX with identical parsed blocks is refused before Pass A buys anything";
const HISTORICAL_PROGRESS_OWNERSHIP =
  "counterproof: historical wrong canonical block ownership fails closed instead of guessing partial progress";
const PRIMARY_PERSIST_RETRY =
  "a before-commit write failure retries only immutable artifact bytes, never the model";
const PRIMARY_PERSIST_EXHAUSTION =
  "exhausted success storage stops the real stage, charges once, and Workflow re-entry buys nothing";
const PRIMARY_EXACT_PREDECESSOR =
  "a current-identity corrupt occupant cannot be overwritten by a paid Flash result";
const PRIMARY_PREDECESSOR_HISTORY =
  "a fallback-authority write retries identical bytes before Flash and never retries Grok";
const SYNTHESIS_TRANSITION_HISTORY =
  "synthesis fallback/retry transitions archive exact predecessors and accept an after-commit final target";
const SYNTHESIS_EXACT_PREDECESSOR =
  "a different valid synthesis CAS winner is never overwritten and exact losing paid bytes survive";
const SYNTHESIS_RAW_SEMANTIC =
  "strict synthesis semantic failure retains exact raw output and re-decodes it on reclaim";

await runMutantSuite({
  title: "D22 — pass A is sliced across steps, resumes what landed, and fails by name",
  // No filter: a baseline over a subset is not a baseline for a change that touches the
  // workflow's extraction branch, and collateral damage elsewhere is worth seeing.
  filter: "",
  mutants: [
    {
      name: "historical progress ignores exact canonical window ownership",
      breaks:
        "a stale paid artifact from another source window can inflate the public accounted count " +
        "even though it grants no semantic extraction authority",
      file: PASS_A,
      find: "blockIds.some((id, blockIndex) =>",
      replace: "false && blockIds.some((id, blockIndex) =>",
      kills: [HISTORICAL_PROGRESS_OWNERSHIP],
    },
    {
      name: "document source authority trusts parsed equivalence instead of exact current bytes",
      breaks:
        "a replacement DOCX with identical parsed blocks can inherit the envelope hash and authorize " +
        "provider purchases, consolidation, reuse, and sealing for bytes that were never submitted",
      file: STAGE,
      find: "if (actualRawSha256 !== expectedRawSha256) {",
      replace: "if (false) {",
      kills: [DOCUMENT_SOURCE_BYTES],
    },
    {
      name: "the pass-A block ceiling is off by one",
      breaks:
        "a dense 101-block document remains one oversized unit even though the configured ceiling is 100",
      file: PASS_A,
      find: "const reachesBlockLimit = current.length >= blockLimit;",
      replace: "const reachesBlockLimit = current.length > blockLimit;",
      kills: [BLOCK_LIMIT],
    },
    {
      name: "the all-window primary wire refusal no longer blocks earlier purchases",
      breaks:
        "the all-window preflight finds a late refusal but the ordered walk still reads credentials " +
        "and buys an earlier missing or retryable unit",
      file: PASS_A,
      find: "if (pendingPrimaryWireFailure !== null) {",
      replace: "if (false) {",
      kills: [PRIMARY_LATE_WIRE],
    },
    {
      name: "a retained late primary wire refusal is ignored on safe-cap replay",
      breaks:
        "after configuration drift makes the current body fit, a retained terminal late-window " +
        "refusal no longer blocks an earlier missing unit from reading credentials or buying again",
      file: PASS_A,
      find: 'if (retained?.kind === "failed" && retained.terminal && retained.wireCeiling) {',
      replace: "if (false) {",
      kills: [PRIMARY_LATE_WIRE],
    },
    // Do not mutate the dynamic Workflow step name to a constant here. The supervisor rejects
    // duplicate step identifiers before the D22 assertions can run, so that shape can only yield
    // NO-RUN/SUPERVISOR_RECEIPT_INVALID rather than fail-capable product evidence. The live
    // one-wave regression below exercises the same abandoned-window failure through the normal
    // workflow path and must be killed by the named D22 assertion.
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
      find:
        "  artifactKey: string,\n" +
        "): Promise<PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null> {\n" +
        "  const obj = await env.EVIDENCE.get(artifactKey);",
      replace:
        "  artifactKey: string,\n" +
        "): Promise<PersistedWindow | FailedWindowArtifact | InvalidWindowArtifact | null> {\n" +
        "  const obj = null;",
      kills: [RESUME_FREE],
    },
    {
      name: "a paid primary artifact gets no same-byte in-process storage retry",
      breaks:
        "a transient before-commit write failure turns one valid paid answer into a terminal stop " +
        "instead of retrying only its already-serialized immutable bytes",
      file: PASS_A,
      find: "storageAttempt <= PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS;",
      replace: "storageAttempt < PASS_A_PRIMARY_ARTIFACT_PERSIST_ATTEMPTS;",
      kills: [PRIMARY_PERSIST_RETRY],
    },
    {
      name: "paid primary persistence exhaustion discards its exact conflict artifact",
      breaks:
        "the canonical write can exhaust after a paid answer while the healthy append-only " +
        "conflict namespace is never asked to retain the exact serialized target and receipt",
      file: PASS_A,
      find: "    const conflictKey = await persistPrimaryWindowCasConflict(env, runId, n, serialized);",
      replace: '    const conflictKey = "fixture-conflict-retention-skipped";',
      kills: [PRIMARY_PERSIST_EXHAUSTION],
    },
    {
      name: "a paid primary replacement ignores the exact predecessor etag",
      breaks:
        "a concurrent newer window artifact is overwritten by the losing paid Flash result, " +
        "erasing retained authority and hiding the CAS loser receipt",
      file: PASS_A,
      find: '            : { etagMatches: expected.etag },',
      replace: "            : undefined,",
      kills: [PRIMARY_EXACT_PREDECESSOR],
    },
    {
      name: "a paid primary replacement discards its exact predecessor history",
      breaks:
        "a fallback-authorized receipt disappears when the canonical window key advances to " +
        "the paid Flash result",
      file: PASS_A,
      find: "      await persistPrimaryWindowHistory(env, runId, n, expected.bodyText);",
      replace: "      void expected.bodyText;",
      kills: [PRIMARY_PREDECESSOR_HISTORY],
    },
    {
      name: "a paid synthesis replacement ignores the exact predecessor etag",
      breaks:
        "a different retained synthesis authority is overwritten by the losing paid result, " +
        "erasing canonical bytes and hiding the CAS loser receipt",
      file: PASS_A,
      find: "          : { etagMatches: synthesisExpected.etag },",
      replace: "          : undefined,",
      kills: [SYNTHESIS_EXACT_PREDECESSOR],
    },
    {
      name: "a paid synthesis replacement discards its exact predecessor history",
      breaks:
        "fallback and retry receipts disappear when the canonical synthesis key advances",
      file: PASS_A,
      find: "      await persistPassASynthesisHistory(env, runId, synthesisExpected.bodyText);",
      replace: "      void synthesisExpected.bodyText;",
      kills: [SYNTHESIS_TRANSITION_HISTORY],
    },
    {
      name: "a strict synthesis failure drops its rejected raw model output",
      breaks:
        "the terminal synthesis record names a decoder failure but discards the paid answer " +
        "needed to reproduce it after live access ends",
      file: PASS_A,
      find: "          ...(semanticFailure ? { modelOutput: rawModelOutput } : {}),",
      replace: "          ...{},",
      kills: [SYNTHESIS_RAW_SEMANTIC],
    },
    {
      name: "retained synthesis semantic failure is not replayed through the strict decoder",
      breaks:
        "a valid or laundered raw synthesis output can retain a false semantic-failure label " +
        "without the current decoder proving the rejection",
      file: PASS_A,
      find: "        if (semanticReplayDetail === null) {",
      replace: "        if (false) {",
      kills: [SYNTHESIS_RAW_SEMANTIC],
    },
    {
      name: "success-artifact persistence exhaustion escapes into Workflow retry",
      breaks:
        "a paid valid answer whose immutable bytes cannot be stored throws across the step boundary, " +
        "allowing Workflow retry to buy the same model answer again",
      file: PASS_A,
      find:
        "if (err instanceof PassAPrimaryPersistenceError) {\n" +
        "        const detail = err.message.slice(0, 400);",
      replace:
        "if (err instanceof PassAPrimaryPersistenceError) {\n" +
        "        throw err;\n" +
        "        const detail = err.message.slice(0, 400);",
      kills: [PRIMARY_PERSIST_EXHAUSTION],
    },
    {
      name: "the retained issue ceiling is ignored on artifact reclaim",
      breaks:
        "the per-window purchase budget is ignored, so one window nobody can answer is bought " +
        "once per wave, per step retry, per recovery instance — the 21–24x billing storm, on the " +
        "most expensive call in the system",
      file: PASS_A,
      find: "const maxIssues = Math.max(1, num(env.EXTRACT_PASS_A_WINDOW_MAX_ISSUES, 2));",
      replace: "const maxIssues = 999999;",
      kills: [BOUNDED_RETRY],
    },
    {
      name: "a shared nonretryable primary failure is not durable across Workflow retry",
      breaks:
        "a provider authentication or invalid-request failure stops the first stage invocation but its " +
        "artifact is resumable, so recovery purchases the same doomed call again",
      file: PASS_A,
      find:
        "const durableTerminal =\n" +
        "        !(err instanceof ModelCallError) || nonRetryablePrimaryFailure || attempts >= maxIssues;",
      replace:
        "const durableTerminal =\n" +
        "        !(err instanceof ModelCallError) || attempts >= maxIssues;",
      kills: ["a retained nonretryable Pass-A failure is never re-bought after the stage boundary"],
    },
    {
      name: "the window artifact is written without its cross-references",
      breaks:
        "a resumed pass publishes a SHORTER diff than the pass that paid for it, with nothing " +
        "anywhere saying so — the silent-shortening class, reachable only through pass A",
      file: PASS_A,
      find: "...landedWindow,",
      replace: "...landedWindow, crossRefs: [],",
      kills: [XREFS],
    },
    {
      name: "typed primary bytes are trusted instead of re-derived from raw model authority",
      breaks: "a retained typed projection can be shortened independently of the paid raw answer",
      file: PASS_A,
      find: "if (canonicalJson(typedStored) !== canonicalJson(typedDecoded)) {",
      replace: "if (false) {",
      kills: [RAW_PRIMARY],
    },
    {
      name: "primary output row keys are no longer closed",
      breaks: "unknown authority-bearing fields can be silently ignored by coercion",
      file: PASS_A,
      find: "function strictPrimaryKeys(raw: Record<string, unknown>, allowed: readonly string[], row: string): void {",
      replace: "function strictPrimaryKeys(raw: Record<string, unknown>, allowed: readonly string[], row: string): void { if (row) return;",
      kills: [STRICT_PRIMARY],
    },
    {
      name: "a primary evidence quote need not occur in its cited source block",
      breaks: "a hallucinated per-block span is accepted as source provenance",
      file: PASS_A,
      find: "if (item.quote.length === 0 || !block?.text.includes(item.quote)) {",
      replace: "if (item.quote.length === 0) {",
      kills: [PRIMARY_GROUNDING],
    },
    {
      name: "primary grounding limitations disappear from the aggregate count",
      breaks:
        "rejected model rows stay absent from authority but the result reports zero withheld rows, " +
        "making inspected coverage indistinguishable from never inspected",
      file: PASS_A,
      find: "const absorb = (unit: PersistedWindow): void => {",
      replace:
        "const absorb = (unit: PersistedWindow): void => { unit.primaryGroundingLimitations = [];",
      kills: [PRIMARY_GROUNDING],
    },
    {
      name: "a rejected primary row is laundered into the accepted projection",
      breaks:
        "a row that failed exact document grounding is returned as if it had grounded, so its " +
        "claim can enter synthesis and merged contract authority",
      file: PASS_A,
      find: "if (!(error instanceof PassAPrimaryGroundingError)) throw error;",
      replace:
        "if (error instanceof PassAPrimaryGroundingError) return [{ row, sourceIndex: index }]; " +
        "if (!(error instanceof PassAPrimaryGroundingError)) throw error;",
      kills: [PRIMARY_GROUNDING],
    },
    {
      name: "a none-observable primary rule needs no grounded unverifiable companion",
      breaks:
        "a hidden document mandate gains requirement and synthesis authority even though no separately " +
        "grounded row explains that the browser cannot verify it",
      file: PASS_A,
      find: "if (linked) return [row];",
      replace: "if (true) return [row];",
      kills: [TYPED_ROW_QUARANTINE],
    },
    {
      name: "an unresolved primary cross-reference may carry a target quote",
      breaks:
        "contradictory target evidence is retained as a valid unresolved row instead of becoming a " +
        "counted row-local source-evidence limitation",
      file: PASS_A,
      find: "} else if (row.targetDocQuote !== null && row.targetDocQuote !== undefined) {",
      replace: "} else if (false) {",
      kills: [TYPED_ROW_QUARANTINE],
    },
    {
      name: "typed empty or duplicate primary block ids terminalize the whole window",
      breaks:
        "a structurally decodable evidence-set error stops valid siblings and the unread document tail " +
        "instead of withholding and counting only that row",
      file: PASS_A,
      find: 'if (value.some((id) => typeof id !== "string" || id.trim().length === 0)) {',
      replace:
        'if (value.length === 0 || new Set(value).size !== value.length || ' +
        'value.some((id) => typeof id !== "string" || id.trim().length === 0)) {',
      kills: [TYPED_ROW_QUARANTINE],
    },
    {
      name: "a surviving cross-reference is reindexed after an earlier row is withheld",
      breaks:
        "synthesis receives a newly packed handle instead of the paid source-row ordinal, so a valid " +
        "resolution can bind another row or fail after the original row 1 was rejected",
      file: PASS_A,
      find: "row.sourceXrefHandle!,",
      replace: "`A-w${n}:x:001`,",
      kills: [SURVIVING_XREF_HANDLE],
    },
    {
      name: "a strict semantic failure drops its rejected raw model output",
      breaks:
        "the terminal record names a decoder failure but discards the paid answer needed to reproduce " +
        "it after live access ends",
      file: PASS_A,
      find: "modelOutput: err instanceof ModelCallError ? null : rawModelOutput,",
      replace: "modelOutput: null,",
      kills: [RAW_SEMANTIC_FAILURE],
    },
    {
      name: "a resolved primary cross-reference need not quote its target",
      breaks: "a local target is marked resolved without exact evidence from that target block",
      file: PASS_A,
      find: "if (targetQuote.length === 0 || !exactTarget.text.includes(targetQuote)) {",
      replace: "if (targetQuote.length === 0) {",
      kills: [UNPROVEN_TARGET],
    },
    {
      name: "an unproven target keeps the model's target-derived statement",
      breaks:
        "a resolution whose target evidence failed is labelled with the very target-derived claim " +
        "that the grounding check refused, laundering an unproved claim into the unresolved register",
      file: PASS_A,
      find: "statement: PASS_A_UNPROVEN_TARGET_STATEMENT,",
      replace: "statement: row.statement,",
      kills: [UNPROVEN_TARGET],
    },
    {
      name: "a failed primary artifact may retain an ok provider receipt",
      breaks: "a paid success can be relabeled as retryable semantic failure",
      file: PASS_A,
      find: "(usages as CallUsage[]).some((usage) => usage.status === 'ok') ||",
      replace: "false ||",
      kills: [PRIMARY_LAUNDER],
    },
    {
      name: "synthesis purchases after its bounded catalogue refuses",
      breaks:
        "an aggregate candidate catalogue proven larger than its cap falls through to credentials " +
        "and a provider purchase with no complete retained synthesis input",
      file: PASS_A,
      find: "if (context.wireFailureDetail !== null) {",
      replace: "if (false) {",
      kills: [SYNTHESIS_WIRE],
    },
    {
      name: "synthesis can be bought in the same wave as the final primary window",
      breaks: "one Workflow step may contain two full purchases under a one-purchase timeout",
      file: PASS_A,
      find: "if (!options.issueAuthorized) {",
      replace: "if (false) {",
      kills: [SYNTHESIS_SEPARATE_WAVE],
    },
    {
      name: "synthesis may cite a real but unsupplied source span",
      breaks: "output gains authority from text absent from the bounded provider wire",
      file: PASS_A,
      find: "!context.evidenceBlockIds.has(blockId) || !context.evidenceSpanKeys.has(spanKey) ||",
      replace: "!context.evidenceBlockIds.has(blockId) || false ||",
      kills: [SYNTHESIS_INVALID],
    },
    {
      name: "a failed synthesis artifact may retain an ok provider receipt",
      breaks: "a synthesis success can be laundered into retryable failed state",
      file: PASS_A,
      find: '(usages as CallUsage[]).some((usage) => usage.status === "ok") ||',
      replace: "false ||",
      kills: [SYNTHESIS_RETAINED],
    },
    {
      name: "a Flash route can bind its Grok trigger from another issue",
      breaks: "independent purchase issues can be spliced into one fallback route",
      file: PASS_A,
      find: 'if (!completeFlashIssues) return "fallback chain has a missing or duplicate Flash issue";',
      replace: 'if (false) return "fallback chain has a missing or duplicate Flash issue";',
      kills: [SYNTHESIS_CROSS_ISSUE],
    },
    {
      name: "a fallback chain may contain another Grok purchase",
      breaks: "one trigger can hide an independently purchased intervening Grok leg",
      file: PASS_A,
      find: 'if (grokUsages.length !== 1) return "fallback chain contains an extra Grok purchase";',
      replace: 'if (false) return "fallback chain contains an extra Grok purchase";',
      kills: [FALLBACK_CHAIN],
    },
    {
      name: "an unverified invalid-content receipt may authorize Flash",
      breaks: "a response with no established Grok model identity can be forged into fallback authority",
      file: PASS_A,
      find: 'bound.usageSource === "unverified-model-rate-ceiling"',
      replace: "false",
      kills: [FALLBACK_CHAIN],
    },
    {
      name: "a null-trigger provider failure may be relabeled retryable",
      breaks: "a writer-terminal provider refusal can be changed into authority for another Grok purchase",
      file: PASS_A,
      find: `(failureStage === 'provider' && fallbackTrigger === null && parsed["terminal"] !== true) ||`,
      replace: "false ||",
      kills: [PRIMARY_LAUNDER],
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
        "  // nobody ever made.\r\n" +
        "  await chargeUsage(env, runId, result.accountingCalls, fence);",
      replace:
        "  // nobody ever made.\r\n" +
        "  await chargeUsage(env, runId, result.calls, fence);",
      kills: [HALF_READ],
    },
    {
      name: "a receipted Flash result does not stop later pass-A windows",
      breaks:
        "once Pass A lands Flash, configured DeepSeek Pro Pass B can no longer restore provider-family " +
        "independence, so later Grok windows are pure spend with no sealable outcome",
      file: PASS_A,
      find: "if (routeReceipt.trigger !== null) {",
      replace: "if (false) {",
      kills: [FALLBACK_STOP],
    },
    {
      name: "a reclaimed Flash result does not stop later pass-A windows",
      breaks:
        "a Workflow retry reclaims the Flash window but resumes buying the unread tail even though " +
        "provider-family independence is already irreversibly reduced",
      file: PASS_A,
      find:
        "if (existing.routeReceipt.trigger !== null) {\n" +
        "        remaining += windows.length - (i + 1);",
      replace:
        "if (false) {\n" +
        "        remaining += windows.length - (i + 1);",
      kills: [FALLBACK_STOP],
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
