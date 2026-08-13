#!/usr/bin/env node
/**
 * D51 mutation evidence: persisted extraction work is reusable only under the exact DOCX
 * parser and prompt semantics that produced it. Mutations are applied inside esbuild; source
 * files are never rewritten.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const PASS_A = "src/extract/pass-a.ts";
const PASS_B = "src/extract/pass-b.ts";
const STAGE = "src/workflow/stages/extract.ts";

await runMutantSuite({
  title: "D51 stale extraction artifacts — parser and prompt identity are load-bearing",
  filter: "D51",
  mutants: [
    {
      name: "pass A accepts a window from another parser or prompt",
      breaks: "stale success or terminal failure can suppress current pass-A work",
      file: PASS_A,
      find:
        '    if (parsed["parserVersion"] !== parserVersion || parsed["promptVersion"] !== PROMPT_VERSION_A) {\n' +
        "      return null;\n" +
        "    }",
      replace: "    if (false) {\n      return null;\n    }",
      kills: ["D51-a pass A rejects stale window success and terminal failure artifacts"],
    },
    {
      name: "pass B accepts a chunk or sweep from another parser or prompt",
      breaks: "stale obligations or retry counts can enter the current pass-B result",
      file: PASS_B,
      find:
        '    if (parsed["parserVersion"] !== parserVersion || parsed["promptVersion"] !== PROMPT_VERSION_B) {\n' +
        "      return null;\n" +
        "    }",
      replace: "    if (false) {\n      return null;\n    }",
      kills: ["D51-b pass B rejects stale chunk, sweep, and whole-pass artifacts and resets attempts"],
    },
    {
      name: "whole-pass early reuse ignores parser and prompt identity",
      breaks: "a completed stale pass can bypass document parsing and all current model work",
      file: STAGE,
      find:
        "  const body = await obj.text();\n" +
        "  try {\n" +
        "    const parsed = JSON.parse(body) as PassResult & {\n" +
        "      parserVersion?: unknown;\n" +
        "      promptVersion?: unknown;\n" +
        "      providerPlanIdentity?: unknown;\n" +
        "      providerRouteIdentity?: unknown;\n" +
        "      providerIndependence?: unknown;\n" +
        "    };\n" +
        '    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;\n' +
        "    if (parsed.parserVersion !== expectedParserVersion || parsed.promptVersion !== expectedPrompt) return null;",
      replace:
        "  const body = await obj.text();\n" +
        "  try {\n" +
        "    const parsed = JSON.parse(body) as PassResult & {\n" +
        "      parserVersion?: unknown;\n" +
        "      promptVersion?: unknown;\n" +
        "      providerPlanIdentity?: unknown;\n" +
        "      providerRouteIdentity?: unknown;\n" +
        "      providerIndependence?: unknown;\n" +
        "    };\n" +
        '    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;\n' +
        "    if (false) return null;",
      kills: [
        "D51-d whole-pass A stale payload cannot take early reuse",
        "D51-b pass B rejects stale chunk, sweep, and whole-pass artifacts and resets attempts",
      ],
    },
    {
      name: "consolidation merges stale pass payloads",
      breaks: "the source ledger can seal a denominator produced under another parser or prompt",
      file: STAGE,
      find:
        "    const parsed = JSON.parse(await obj.text()) as PassResult & {\n" +
        "      crossRefs?: CrossRef[];\n" +
        "      parserVersion?: unknown;\n" +
        "      promptVersion?: unknown;\n" +
        "      providerPlanIdentity?: unknown;\n" +
        "      providerRouteIdentity?: unknown;\n" +
        "      providerIndependence?: unknown;\n" +
        "    };\n" +
        '    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;\n' +
        "    if (parsed.parserVersion !== expectedParserVersion || parsed.promptVersion !== expectedPrompt) return null;",
      replace:
        "    const parsed = JSON.parse(await obj.text()) as PassResult & {\n" +
        "      crossRefs?: CrossRef[];\n" +
        "      parserVersion?: unknown;\n" +
        "      promptVersion?: unknown;\n" +
        "      providerPlanIdentity?: unknown;\n" +
        "      providerRouteIdentity?: unknown;\n" +
        "      providerIndependence?: unknown;\n" +
        "    };\n" +
        '    const expectedPrompt = pass === "a" ? PASS_A_VERSION : PASS_B_VERSION;\n' +
        "    if (false) return null;",
      kills: ["D51-e consolidation refuses stale pass A or pass B payloads"],
    },
  ],
});
