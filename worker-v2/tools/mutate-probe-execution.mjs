#!/usr/bin/env node
/**
 * Evidence that D52 can fail. Mutations happen inside esbuild only; no source file is rewritten.
 *
 *   node tools/mutate-probe-execution.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

await runMutantSuite({
  title: "D52 probe-execution truth mutants",
  filter: "D52",
  mutants: [
    {
      name: "the mandatory back-navigation flag is ignored",
      breaks: "a path can request back-navigation without carrying a separate action payload",
      file: "src/workflow/stages/plan.ts",
      find:
        "  const backNavigation =\n" +
        "    p.requires_back_navigation === true ||\n" +
        "    (Array.isArray(back) ? back.length > 0 : back !== undefined && back !== null && back !== false);",
      replace: "  const backNavigation = false;",
      kills: ["BACK-NAVIGATION WITHOUT A PAYLOAD IS STILL COUNTED — the mandatory flag is an action request"],
    },
    {
      name: "a repeated-session instruction is treated as one ordinary walk",
      breaks: "repeats greater than one remain named insufficient evidence",
      file: "src/workflow/stages/plan.ts",
      find:
        "  const repeatedSessions =\n" +
        "    repeats !== undefined &&\n" +
        "    !(typeof repeats === \"number\" && Number.isFinite(repeats) && Number.isInteger(repeats) && repeats === 1);",
      replace: "  const repeatedSessions = false;",
      kills: ["REPEATED SESSIONS STAY INSUFFICIENT — one walk is not a five-session randomization experiment"],
    },
    {
      name: "work selection admits every unsupported probe",
      breaks: "the executor must not hand ignored action fields to walkPath",
      file: "src/workflow/stages/plan.ts",
      find: "  return !probeExecutionRequirements(path).unsupported;",
      replace: "  return true;",
      kills: ["WORK SELECTION CONSUMES THE CAPABILITY CHECK — unsupported paths never enter walkPath"],
    },
    {
      name: "the workflow closure gate drops required capability limitations",
      breaks: "settled cases alone cannot close an axis with required unexecuted probes",
      file: "src/workflow/run-workflow.ts",
      find: "    for (const limitation of requiredProbeCapabilityLimitations(probeLimitations)) {",
      replace: "    for (const limitation of []) {",
      kills: ["WORKFLOW CLOSURE FAILS LOUDLY even when every sealed case already has a verdict"],
    },
    {
      name: "the signed record drops planned probes that have no attempt receipt",
      breaks: "the record must count work the execution adapter could not perform",
      file: "src/workflow/stages/assemble-record.mjs",
      find:
        "  for (const limitation of Array.isArray(probeCapabilityLimitations) ? probeCapabilityLimitations : []) {",
      replace: "  for (const limitation of []) {",
      kills: ["SIGNED RECORD GETS A COUNTED BLOCKER, not a fabricated attempt row"],
    },
  ],
});

