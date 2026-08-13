#!/usr/bin/env node
/** Mutation evidence for the reviewed Grok 4.6 tier binding and max-tier flat ledger. */

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

const RATE_GATE_THEN_KEY = [
  "  try {",
  "    await grokRateAttestation(env);",
  "  } catch (err) {",
  "    return settled(stageNotEvaluated<PassSummary>(",
  '      "GROK_RATE_UNATTESTED",',
  '      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,',
  "    ));",
  "  }",
  "  // Validate the closed cost policy before Secrets Store get(). A missing or malformed",
  "  // price binding is a zero-I/O configuration refusal, not permission to touch a credential.",
  '  const credential = await credentialCheck(env, "grok");',
  "  if (credential) return settled(credential as StageResult<PassSummary>);",
].join("\n");

const KEY_THEN_RATE_GATE = [
  '  const credential = await credentialCheck(env, "grok");',
  "  if (credential) return settled(credential as StageResult<PassSummary>);",
  "  try {",
  "    await grokRateAttestation(env);",
  "  } catch (err) {",
  "    return settled(stageNotEvaluated<PassSummary>(",
  '      "GROK_RATE_UNATTESTED",',
  '      `${err instanceof Error ? err.message : String(err)}. No Grok request was issued.`,',
  "    ));",
  "  }",
  "  // MUTANT: credential was resolved before the rate policy",
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
        '  if (value === "owner-dashboard-copy" || value === "authenticated-xai-catalogue") return value;',
      replace: '  if (value !== undefined) return "owner-dashboard-copy";',
      kills: [REFUSE],
    },
    {
      name: "stage resolves the secret before validating pricing",
      breaks: "a malformed pricing policy performs credential I/O before its zero-I/O refusal",
      file: STAGE,
      find: RATE_GATE_THEN_KEY,
      replace: KEY_THEN_RATE_GATE,
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
  ],
});
