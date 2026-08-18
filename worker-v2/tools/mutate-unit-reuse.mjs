#!/usr/bin/env node
/**
 * MUTATION EVIDENCE FOR CROSS-RUN EXTRACTION UNIT REUSE.
 *
 *   node tools/mutate-unit-reuse.mjs
 *
 * Each mutant breaks ONE property that `tools/tests/unit-reuse.test.mjs` claims to guard.
 * The kill criterion is the baseline-aware one in `tools/mutate-runner.mjs`: a mutant
 * counts as killed only when a test that was PASSING before the mutation fails, and only
 * when THAT named test is among the new failures.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const UNIT_REUSE = "src/store/unit-reuse.ts";
const PASS_B = "src/extract/pass-b.ts";

await runMutantSuite({
  title: "cross-run extraction unit reuse",
  filter: "CROSS-RUN UNIT REUSE",
  mutants: [
  // --- identity field dropped from digest ---
  {
    name: "unitKind dropped from identity digest",
    breaks: "two different unit kinds (chunk vs sweep) with the same request hash would collide",
    file: UNIT_REUSE,
    find: '    `kind:${fields.unitKind}`, // mutation-anchor: unit-reuse-identity-kind',
    replace: '    `kind:pass-b-chunk`, // mutation-anchor: unit-reuse-identity-kind',
    kills: ["different unitKind produces a different digest"],
  },
  {
    name: "requestHash dropped from identity digest",
    breaks: "two units with different model inputs would collide",
    file: UNIT_REUSE,
    find: '    `request:${fields.requestHash}`, // mutation-anchor: unit-reuse-identity-request',
    replace: '    `request:fixed`, // mutation-anchor: unit-reuse-identity-request',
    kills: ["different requestHash produces a different digest"],
  },
  {
    name: "decoderIdentity dropped from identity digest",
    breaks: "a decoder version change would adopt a unit decoded under a stale schema",
    file: UNIT_REUSE,
    find: '    `decoder:${fields.decoderIdentity}`, // mutation-anchor: unit-reuse-identity-decoder',
    replace: '    `decoder:fixed`, // mutation-anchor: unit-reuse-identity-decoder',
    kills: ["different decoderIdentity produces a different digest"],
  },
  {
    name: "providerPlanIdentity dropped from identity digest",
    breaks: "a rate change would adopt a unit whose cost records reference a different plan",
    file: UNIT_REUSE,
    find: '    `provider:${fields.providerPlanIdentity}`, // mutation-anchor: unit-reuse-identity-provider',
    replace: '    `provider:fixed`, // mutation-anchor: unit-reuse-identity-provider',
    kills: ["different providerPlanIdentity produces a different digest"],
  },
  {
    name: "promptVersion dropped from identity digest",
    breaks: "a prompt change would adopt a unit extracted under a stale prompt",
    file: UNIT_REUSE,
    find: '    `prompt:${fields.promptVersion}`, // mutation-anchor: unit-reuse-identity-prompt',
    replace: '    `prompt:fixed`, // mutation-anchor: unit-reuse-identity-prompt',
    kills: ["different promptVersion produces a different digest"],
  },
  {
    name: "parserVersion dropped from identity digest",
    breaks: "a parser change would adopt a unit from a stale parse",
    file: UNIT_REUSE,
    find: '    `parser:${fields.parserVersion}`, // mutation-anchor: unit-reuse-identity-parser',
    replace: '    `parser:fixed`, // mutation-anchor: unit-reuse-identity-parser',
    kills: ["different parserVersion produces a different digest"],
  },
  // --- collision paranoia ---
  {
    name: "identity field mismatch check skipped (collision paranoia disabled)",
    breaks: "a digest collision or corrupt index entry would be silently adopted",
    file: UNIT_REUSE,
    find: '    return null; // mutation-anchor: unit-reuse-identity-mismatch-refused',
    replace: '    void 0; // mutation-anchor: unit-reuse-identity-mismatch-refused',
    kills: ["lookupReusableUnit returns null on identity field mismatch (collision paranoia)"],
  },
  // --- validation skipped on adoption ---
  {
    name: "adopted payload revalidation skipped",
    breaks: "a stored model output that fails the current decoder would be adopted silently",
    file: PASS_B,
    find: '          decoded = decodePassBOutput(stored.modelOutput, chunk.id, chunk.blocks, evidenceBlocks); // mutation-anchor: unit-reuse-revalidation',
    replace: '          decoded = { obligations: [], dispositions: [], constructs: [], ambiguities: [], unverifiable: [] }; // mutation-anchor: unit-reuse-revalidation',
    kills: ["chunk bought in run 1 is adopted in run 2 with zero-cost provenance"],
  },
  // --- store-on-success removed ---
  {
    name: "storeCompletedUnit guard made unconditionally false",
    breaks: "no cross-run unit is stored, so the next run cannot adopt and must buy fresh",
    file: PASS_B,
    find: '      const admitted = chunkWireChecks.get(chunk.n); // mutation-anchor: unit-reuse-store-guard',
    replace: '      const admitted = null; // mutation-anchor: unit-reuse-store-guard',
    kills: ["chunk bought in run 1 is adopted in run 2 with zero-cost provenance"],
  },
],
});
