#!/usr/bin/env node
/** Mutation evidence for Grok 4.6 primary, Flash substitute, and Pro pass B. */

import { runMutantSuite } from "./mutate-runner.mjs";

const GROK = "src/llm/grok.ts";
const DEEPSEEK = "src/llm/deepseek.ts";
const PASS_A = "src/extract/pass-a.ts";
const STAGE = "src/workflow/stages/extract.ts";

const NORMAL = "normal extraction buys exact Grok 4.6 plus Pro and zero Flash requests";
const ELIGIBLE = "eligible quota/non-response/invalid-content failures activate exactly Flash";
const INELIGIBLE = "authentication and bad requests fail honestly and make zero Flash requests";
const UNBOUND_MODEL = "a missing or mismatched Grok response model cannot authorize Flash";
const RESTART = "restart after trigger persistence resumes Flash without retrying Grok";
const RATES = "Grok 4.6 rate/model attestation fails before any request";
const RATE_STAGE = "an unattested Grok rate is a named stage refusal with zero requests";
const INDEPENDENCE = "Flash plus Pro is retained but explicitly refused as independent corroboration";

await runMutantSuite({
  title: "PROVIDER ACTIVATION MUTANTS",
  filter: "PROVIDER ACTIVATION",
  mutants: [
    {
      name: "successful Grok speculatively activates Flash",
      breaks: "a normal two-provider run buys an unnecessary substitute and loses independence",
      file: PASS_A,
      find: "      if (fallbackTrigger !== null) {",
      replace: "      if (true) {",
      kills: [NORMAL],
    },
    {
      name: "authentication authorizes Flash",
      breaks: "a shared credential/configuration failure buys another provider request",
      file: GROK,
      find: '    error.failureKind === "rate-limited" ||',
      replace: '    error.failureKind === "authentication" ||',
      kills: [INELIGIBLE],
    },
    {
      name: "invalid structured output cannot activate Flash",
      breaks: "a bounded unusable Grok result is treated as terminal rather than continuity-eligible",
      file: GROK,
      find: '  if (error.failureKind === "invalid-content") {',
      replace: '  if (error.failureKind === "authentication") {',
      kills: [ELIGIBLE],
    },
    {
      name: "unbound Grok model identity authorizes Flash",
      breaks: "an alias, redirect, or missing model echo can authorize another provider purchase",
      file: GROK,
      find: '    return error.usage.usageSource !== "unverified-model-rate-ceiling";',
      replace: "    return true;",
      kills: [UNBOUND_MODEL],
    },
    {
      name: "trigger is not persisted before Flash",
      breaks: "a crash between the two purchases can rebuy Grok and erase fallback authority",
      file: PASS_A,
      find:
        "          await env.EVIDENCE.put(\n" +
        "            windowKey(runId, n),\n" +
        "            JSON.stringify({\n" +
        "              windowId: origin,\n" +
        "              windowNumber: n,\n" +
        "              blockIds,\n" +
        "              parserVersion,\n" +
        "              promptVersion: PROMPT_VERSION_A,\n" +
        "              providerRouteIdentity,\n" +
        '              status: "failed",',
      replace:
        "          if (false) await env.EVIDENCE.put(\n" +
        "            windowKey(runId, n),\n" +
        "            JSON.stringify({\n" +
        "              windowId: origin,\n" +
        "              windowNumber: n,\n" +
        "              blockIds,\n" +
        "              parserVersion,\n" +
        "              promptVersion: PROMPT_VERSION_A,\n" +
        "              providerRouteIdentity,\n" +
        '              status: "failed",',
      kills: [RESTART],
    },
    {
      name: "restart discards retained fallback trigger",
      breaks: "recovery retries Grok instead of continuing the already-authorized Flash leg",
      file: PASS_A,
      find:
        '    let fallbackTrigger = existing && existing.kind === "failed" ? existing.fallbackTrigger : null;',
      replace: "    let fallbackTrigger = null;",
      kills: [RESTART],
    },
    {
      name: "pass B selects Flash instead of Pro",
      breaks: "the ordinary route becomes Grok plus Flash while reporting Pro identity",
      file: DEEPSEEK,
      find: '  if (role === "grok-fallback") {',
      replace: '  if (role === "grok-fallback" || role === "pass-b") {',
      kills: [NORMAL],
    },
    {
      name: "Grok rate attestation accepts another model",
      breaks: "4.5 rates can be laundered into a paid 4.6 receipt",
      file: GROK,
      find: "  if (env.GROK_RATE_ATTESTED_MODEL !== model) {",
      replace: "  if (false) {",
      kills: [RATES],
    },
    {
      name: "Grok accepts an alias or redirect-prone model id",
      breaks: "response identity and configured price identity are no longer exact grok-4.6",
      file: GROK,
      find: "  if (model !== DEFAULT_GROK_MODEL) {",
      replace: "  if (false) {",
      kills: [RATES],
    },
    {
      name: "stage bypasses the pre-spend Grok rate gate",
      breaks: "an unattested release reaches the extraction call path instead of a named no-spend refusal",
      file: STAGE,
      find: "    await grokRateAttestation(env);",
      replace: "    // MUTANT: rate attestation bypassed",
      kills: [RATE_STAGE],
    },
    {
      name: "completed pass trusts an independence label without triggers",
      breaks: "a stored label can overrule the retained provider-route evidence",
      file: PASS_A,
      find: '  return row["providerIndependence"] === derived ? derived : null;',
      replace:
        '  return row["providerIndependence"] === "independent" || ' +
        'row["providerIndependence"] === "reduced-same-provider-fallback" ' +
        '? row["providerIndependence"] as PassAProviderIndependence : null;',
      kills: [NORMAL],
    },
    {
      name: "same-provider fallback can consolidate as independent",
      breaks: "Flash plus Pro can seal under the ordinary two-provider claim",
      file: STAGE,
      find: '  if (passA.providerIndependence === "reduced-same-provider-fallback") {',
      replace: "  if (false) {",
      kills: [INDEPENDENCE],
    },
  ],
});
