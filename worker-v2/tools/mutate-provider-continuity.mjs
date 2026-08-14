#!/usr/bin/env node
/** Mutation evidence for explicit, same-provider DeepSeek continuity. */

import { runMutantSuite } from "./mutate-runner.mjs";

const CLIENT = "src/llm/deepseek.ts";
const CHAT = "src/llm/chat.ts";
const PASS_B = "src/extract/pass-b.ts";
const REUSE = "src/store/contract-reuse.ts";
const STAGE = "src/workflow/stages/extract.ts";
const USAGE = "src/store/usage.ts";

const PLAN = "default plan is Flash primary and Pro fallback under one DeepSeek provider";
const RECEIPTS = "a failed Flash purchase falls back once to Pro and both actual-model cost receipts survive";
const MODEL_BINDING = "a response must attest the exact requested model under the stored plan";
const PREFLIGHT = "invalid fallback rates fail before the primary can spend";
const ATTEMPT_IDENTITY = "a caller cannot execute an attempt count different from the stored plan identity";
const TAXONOMY = "auth, balance and invalid-request failures never buy a doomed Pro call";
const AVAILABILITY = "rate limiting and provider 5xx explicitly remain fallback-eligible";
const BOUNDS = "dormant continuity remains bounded while ordinary pass B budgets only its Pro leg";
const ARTIFACT = "pass-B reuses only artifacts from the exact same continuity plan";
const TELEMETRY = "a missing usage array is terminal current-key corruption, never a silently trusted or re-bought artifact";
const RETAINED = "failed Pro receipts survive a later bounded retry instead of disappearing on reclaim";
const CRASH = "artifact-before-accounting and accounting-before-step-commit both settle exactly once";
const STAGE_SETTLEMENT = "the pass-B stage settles a pre-existing unaccounted artifact before evaluating it";
const COLLISION = "replaying a settlement id with different cost facts fails loudly";
const COMPLETE = "a completed pass-B payload is reusable only under its stored continuity identity";
const CROSS_RUN = "contract reuse fingerprint changes with fallback policy and deployed rates are exact";

await runMutantSuite({
  title: "PROVIDER CONTINUITY MUTANTS",
  filter: "PROVIDER CONTINUITY",
  mutants: [
    {
      name: "fallback collapses onto primary",
      breaks: "Flash retries itself while the surface claims a Pro continuity leg",
      file: CLIENT,
      find: 'export const DEFAULT_DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-pro";',
      replace: 'export const DEFAULT_DEEPSEEK_FALLBACK_MODEL = "deepseek-v4-flash";',
      kills: [PLAN],
    },
    {
      name: "Pro output billed at Flash rate",
      breaks: "the fallback cost ledger under-reports the actual model purchase",
      file: CLIENT,
      find: '"deepseek-v4-pro": { inputUsdPerMTok: 0.435, outputUsdPerMTok: 0.87 },',
      replace: '"deepseek-v4-pro": { inputUsdPerMTok: 0.435, outputUsdPerMTok: 0.28 },',
      kills: [RECEIPTS],
    },
    {
      name: "failed primary receipt disappears",
      breaks: "a paid failed Flash purchase is folded out when Pro succeeds",
      file: CLIENT,
      find: "issuedCalls: [err.usage, fallback.usage],",
      replace: "issuedCalls: [fallback.usage],",
      kills: [RECEIPTS],
    },
    {
      name: "reported model can replace requested price identity",
      breaks: "a response from another model is persisted while cost still uses the requested model's rate",
      file: CHAT,
      find: "if (reportedModel !== spec.model) {",
      replace: "if (false && reportedModel !== spec.model) {",
      kills: [MODEL_BINDING],
    },
    {
      name: "unverified model falls back to requested Flash rate",
      breaks: "a missing or mismatched model identity can create cost headroom under a cheaper requested SKU",
      file: CLIENT,
      find:
        "  const unboundModelRateCeiling = deepseekUnboundModelRateCeiling(\n" +
        "    env,\n" +
        "    [primarySpec, ...(fallbackSpec ? [fallbackSpec] : [])],\n" +
        "  );",
      replace:
        "  const unboundModelRateCeiling = { inputUsdPerMTok: primarySpec.inputUsdPerMTok, " +
        "outputUsdPerMTok: primarySpec.outputUsdPerMTok };",
      kills: [MODEL_BINDING],
    },
    {
      name: "fallback price validation happens after spend",
      breaks: "a bad Pro price table can let Flash spend before the logical unit refuses",
      file: CLIENT,
      find: "const fallbackSpec = plan.fallback ? await specForLeg(env, plan.fallback, apiKey) : null;",
      replace: "const fallbackSpec = null;",
      kills: [PREFLIGHT],
    },
    {
      name: "nonrecoverable errors buy Pro",
      breaks: "auth, balance and invalid request failures double a doomed purchase",
      file: CLIENT,
      find: "if (!fallbackSpec || !plan.fallback || !deepseekFallbackEligible(err)) {",
      replace: "if (!fallbackSpec || !plan.fallback) {",
      kills: [TAXONOMY],
    },
    {
      name: "primary retries nonrecoverable HTTP",
      breaks: "one invalid credential or request is purchased repeatedly before fallback policy sees it",
      file: CHAT,
      find: "if (attempt === maxAttempts || !retryableFailure(lastFailureKind)) break;",
      replace: "if (attempt === maxAttempts) break;",
      kills: [TAXONOMY],
    },
    {
      name: "missing input usage becomes zero",
      breaks: "an unreceipted paid attempt creates input-cost headroom",
      file: CHAT,
      find: "inputTokens += unknownInputTokenCeiling;",
      replace: "inputTokens += 0;",
      kills: [TAXONOMY],
    },
    {
      name: "missing output usage becomes zero",
      breaks: "an unreceipted paid attempt creates output-cost headroom",
      file: CHAT,
      find: "outputTokens += unknownOutputTokenCeiling;",
      replace: "outputTokens += 0;",
      kills: [TAXONOMY],
    },
    {
      name: "rate limiting no longer falls back",
      breaks: "an explicitly recoverable availability failure loses the continuity leg",
      file: CLIENT,
      find: '    error.failureKind === "rate-limited" ||',
      replace: '    error.failureKind === "authentication" ||',
      kills: [AVAILABILITY],
    },
    {
      name: "fallback retry cap removed",
      breaks: "one bad knob expands one logical unit into an unbounded Pro retry storm",
      file: CLIENT,
      find: "maxAttempts: Math.min(2, Math.max(1, Math.floor(num(env.DEEPSEEK_FALLBACK_MAX_ATTEMPTS, 1)))),",
      replace: "maxAttempts: Math.max(1, Math.floor(num(env.DEEPSEEK_FALLBACK_MAX_ATTEMPTS, 1))),",
      kills: [BOUNDS],
    },
    {
      name: "caller overrides primary attempt identity",
      breaks: "stored plan identity and executed retry count diverge",
      file: CLIENT,
      find:
        "  if (\n" +
        "    opts.maxAttempts !== undefined &&\n" +
        "    Math.max(1, Math.floor(opts.maxAttempts)) !== plan.primary.maxAttempts\n" +
        "  ) {",
      replace:
        "  if (\n" +
        "    false &&\n" +
        "    Math.max(1, Math.floor(opts.maxAttempts)) !== plan.primary.maxAttempts\n" +
        "  ) {",
      kills: [ATTEMPT_IDENTITY],
    },
    {
      name: "timeout forgets fallback attempts",
      breaks: "the Workflow step axe can kill a paid fallback before it is persisted",
      file: CLIENT,
      find: "return plan.primary.maxAttempts + (plan.fallback?.maxAttempts ?? 0);",
      replace: "return plan.primary.maxAttempts;",
      kills: [BOUNDS],
    },
    {
      name: "artifact ignores provider plan",
      breaks: "a chunk produced under another model plan is silently reused",
      file: PASS_B,
      find: 'if (parsed["providerPlanIdentity"] !== deepseekPassBIdentity(env)) return null;',
      replace: "if (false) return null;",
      kills: [ARTIFACT],
    },
    {
      name: "a missing artifact usage receipt becomes a cache miss",
      breaks: "malformed exact-key paid authority can be overwritten and re-bought",
      file: PASS_B,
      find:
        "    if (\n" +
        "      usages === null || !usages.every(isCallUsage) ||\n" +
        "      !Number.isSafeInteger(attempts) || (attempts as number) < 0\n" +
        '    ) return invalid("attempts/usages are malformed");',
      replace:
        "    if (usages === null) return null;\n" +
        "    if (\n" +
        "      !usages.every(isCallUsage) ||\n" +
        "      !Number.isSafeInteger(attempts) || (attempts as number) < 0\n" +
        '    ) return invalid("attempts/usages are malformed");',
      kills: [TELEMETRY],
    },
    {
      name: "prior failed receipts are not carried forward",
      breaks: "a later retry overwrites the earlier paid receipt chain",
      file: PASS_B,
      find: '          status: "failed",\n          attempts,\n          usages: [...priorUsages, ...failureUsages],',
      replace: '          status: "failed",\n          attempts,\n          usages: failureUsages,',
      kills: [RETAINED],
    },
    {
      name: "restart settles only newly issued calls",
      breaks: "artifact-before-accounting permanently loses its paid receipt",
      file: STAGE,
      find:
        "  // Offer every persisted pass-B receipt to the checkpoint CAS. Stable event ids\n" +
        "  // make this exact across both crash windows: artifact-before-accounting settles\n" +
        "  // on restart, while accounting-before-step-commit dedupes on restart.\n" +
        "  await chargeUsage(env, runId, result.accountingCalls, fence);",
      replace:
        "  // MUTANT: settle only what this invocation issued.\n" +
        "  await chargeUsage(env, runId, result.issuedCalls, fence);",
      kills: [STAGE_SETTLEMENT],
    },
    {
      name: "settlement replay increments again",
      breaks: "accounting-before-step-commit double charges on restart",
      file: USAGE,
      find: "            continue;\n          }\n        }\n        draft.usage.events.push(event);",
      replace: "          }\n        }\n        draft.usage.events.push(event);",
      kills: [CRASH],
    },
    {
      name: "settlement collision is accepted",
      breaks: "one stable id can be replayed with different cost facts",
      file: USAGE,
      find: '              invalid(\n                "modelEvents.eventId",',
      replace: "              false && invalid(\n                \"modelEvents.eventId\",",
      kills: [COLLISION],
    },
    {
      name: "completed pass identity omits output-affecting reasoning policy",
      breaks: "a completed payload and its units can be reused under a different pass-B request shape",
      file: CLIENT,
      find: '    `reasoning:${leg.reasoningEffort}`,',
      replace: "    // MUTANT: output-affecting reasoning policy omitted from provider-plan identity",
      kills: [COMPLETE],
    },
    {
      name: "fallback mode omitted from contract reuse",
      breaks: "cross-run reuse cannot distinguish continuity enabled from disabled",
      file: REUSE,
      find: '  "DEEPSEEK_FALLBACK_MODE",\n',
      replace: "",
      kills: [CROSS_RUN],
    },
  ],
});
