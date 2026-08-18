#!/usr/bin/env node
/** Mutation evidence for the reviewed Grok 4.5 tier binding and max-tier flat ledger. */

import { runMutantSuite } from "./mutate-runner.mjs";

const GROK = "src/llm/grok.ts";
const STAGE = "src/workflow/stages/extract.ts";
const REUSE = "src/store/contract-reuse.ts";

const DERIVE = "exact owner dashboard tiers derive and expose the 4/12 max-known ceiling";
const CHARGE = "a real chat receipt is charged at 4/12 even below the 200k threshold";
const REFUSE = "missing malformed zero and under-ceiling bindings refuse before key or fetch";
const MAX = "a self-consistent receipt digest still cannot understate max base or long tier";
const ORDER = "integrated pass-A stage rejects bad pricing before Secrets Store and fetch";
const IDENTITY = "source receipt tiers threshold and max all invalidate route and contract reuse identity";

const RATE_GATE_THEN_PASS_A = [
  "  try {",
  "    await grokRateAttestation(env);",
  "  } catch (err) {",
  "    return settled(stageNotEvaluated<PassSummary>(",
  '      "GROK_RATE_UNATTESTED",',
  '      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,',
  "    ));",
  "  }",
  "  // `runPassA` serializes and checks every possible primary body before its provider client",
  "  // resolves a secret; synthesis does the same once its retained candidate context exists.",
  "  // A missing binding therefore surfaces only after the no-purchase wire boundary has run.",
  "  let result: Awaited<ReturnType<typeof runPassA>>;",
  "  try {",
  "    result = await runPassA(env, runId, doc, documentName, beat, options, onUnitStart);",
  "  } catch (error) {",
  "    if (error instanceof MissingCredential) {",
  '      return settled(missingCredentialResult("grok", error) as StageResult<PassSummary>);',
  "    }",
  "    throw error;",
  "  }",
].join("\n");

const PASS_A_THEN_RATE_GATE = [
  "  // MUTANT: Pass A may resolve its purchase credentials before the rate policy gate.",
  "  let result: Awaited<ReturnType<typeof runPassA>>;",
  "  try {",
  "    result = await runPassA(env, runId, doc, documentName, beat, options, onUnitStart);",
  "  } catch (error) {",
  "    if (error instanceof MissingCredential) {",
  '      return settled(missingCredentialResult("grok", error) as StageResult<PassSummary>);',
  "    }",
  "    throw error;",
  "  }",
  "  try {",
  "    await grokRateAttestation(env);",
  "  } catch (err) {",
  "    return settled(stageNotEvaluated<PassSummary>(",
  '      "GROK_RATE_UNATTESTED",',
  '      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,',
  "    ));",
  "  }",
].join("\n");

await runMutantSuite({
  title: "GROK COST POLICY MUTANTS",
  filter: "GROK COST POLICY",
  mutants: [
    {
      name: "flat input ledger selects the base tier",
      breaks: "a long-context purchase can be reserved and settled at half its known input price",
      file: GROK,
      find: "    : longInput.ticksPerToken;",
      replace: "    : baseInput.ticksPerToken;",
      kills: [DERIVE],
    },
    {
      name: "declared max tier is not checked against derived max",
      breaks: "reviewed base/long prices can coexist with a lower configured ledger ceiling",
      file: GROK,
      find: "  if (actual.ticksPerToken !== expected) {",
      replace: "  if (false) {",
      kills: [MAX],
    },
    {
      name: "receipt digest is accepted without recomputing canonical bytes",
      breaks: "a reviewed digest can be mixed with different model or pricing fields",
      file: GROK,
      find: "  if (actual !== rate.receiptSha256) {",
      replace: "  if (false) {",
      kills: [REFUSE],
    },
    {
      name: "transport receives the base input rate",
      breaks: "the validator derives a ceiling but the actual cost seam silently ignores it",
      file: GROK,
      find: "    inputUsdPerMTok: rate.inputUsdPerMTok,",
      replace: "    inputUsdPerMTok: rate.base.inputUsdPerMTok,",
      kills: [CHARGE],
    },
    {
      name: "unknown evidence sources are laundered as owner copies",
      breaks: "an unreviewed source label can activate paid calls",
      file: GROK,
      find:
        '  if (value === "owner-dashboard-copy" || value === "owner-console-confirmation" || value === "authenticated-xai-catalogue") return value;',
      replace: '  if (value !== undefined) return "owner-console-confirmation";',
      kills: [REFUSE],
    },
    {
      name: "stage resolves the secret before validating pricing",
      breaks: "a malformed pricing policy performs credential I/O before its zero-I/O refusal",
      file: STAGE,
      find: RATE_GATE_THEN_PASS_A,
      replace: PASS_A_THEN_RATE_GATE,
      kills: [ORDER],
    },
    {
      name: "route identity omits evidence source",
      breaks: "a dashboard copy and an authenticated catalogue receipt can reclaim one another",
      file: GROK,
      find: '    `rate-source:${env.GROK_RATE_SOURCE ?? "<unattested>"}`,',
      replace: '    `rate-source:<ignored>`,',
      kills: [IDENTITY],
    },
    {
      name: "contract reuse omits long-context threshold",
      breaks: "a contract can be adopted across different tier boundaries",
      file: REUSE,
      find: '  "GROK_LONG_CONTEXT_THRESHOLD_TOKENS",',
      replace: "",
      kills: [IDENTITY],
    },

    // -----------------------------------------------------------------------
    // COST BOOKING MUTANTS — evidence the cost-booking fix can fail
    // -----------------------------------------------------------------------

    {
      name: "zero-booking applied to timeouts too (widens non-billing to all errors)",
      breaks: "a timeout still books the conservative ceiling",
      file: "src/llm/chat.ts",
      find: "  return status === 401 || status === 402 || status === 403;",
      replace: "  return status === 401 || status === 402 || status === 403 || status === 408 || status >= 500;",
      kills: ["HTTP 503 still books the conservative ceiling (negative control, server error)"],
    },
    {
      name: "replay provenance dropped (usageSource marker removed from replay events)",
      breaks: "a replayed usage event carries usageSource marker",
      file: "src/store/usage.ts",
      find: '      ...(usageSource === undefined ? {} : { usageSource }),',
      replace: '      // MUTANT: usageSource stripped from events',
      kills: ["replayed usage event has usageSource 'reused-prior-artifact', costUsd 0, originalCostUsd preserved"],
    },
    {
      name: "replay booked at current rates again (replay validation removed)",
      breaks: "budget gate correctly ignores replay costs",
      file: "src/store/usage.ts",
      find: '    if (usageSource === "reused-prior-artifact" && event.costUsd !== 0) {',
      replace: '    if (false) {',
      kills: ["replay event with non-zero costUsd is rejected"],
    },
  ],
});
