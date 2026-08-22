#!/usr/bin/env node
/**
 * A3 — EVIDENCE THAT THE MEMORY-SAFE JUDGING TESTS CAN FAIL.
 *
 *   node tools/mutate-a3-memory.mjs
 *
 * Three mutants, each reversing one specific guarantee:
 *
 *   1. RELEASE-STEP REMOVED: the streaming loader's hash-verify-only artifacts are
 *      accumulated in engineRead instead of being released. The peak-residency assertion
 *      must kill this — the peak rises to the full catalogue size.
 *
 *   2. UNVERIFIED-COUNT ZEROED: the limitation array is cleared, so the count of unverified
 *      entries is always zero. The honest-counting test must kill this.
 *
 *   3. MANIFEST COMPUTED OVER UNFILTERED SET: the pre-verified hashes are not passed to the
 *      authority, so only disk-resident files are in the manifest check. The end-to-end test
 *      must kill this because the authority cannot verify the full set.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`).
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const INPUTS = "src/workflow/stages/run-inputs.ts";
const VERDICTS = "src/workflow/stages/derive-verdicts.ts";

const MUTANTS = [
  // ------------------------------------------------- bounded residency
  {
    name: "the release step is removed — hash-verify-only artifacts are accumulated in engineRead",
    breaks:
      "without the split, every artifact stays in the resident set and the peak equals the " +
      "full catalogue size, which is the OOM the fix exists to prevent",
    file: INPUTS,
    // The isEngineReadArtifact classification is the split point. Making it always return
    // true means every artifact goes to engineRead (the old behaviour) and nothing is
    // released via the hash-verify-only batch path.
    find: "function isEngineReadArtifact(name: string): boolean {\n  return /\\.json$/i.test(name);\n}",
    replace: "function isEngineReadArtifact(name: string): boolean {\n  return true;\n}",
    kills: ["peak residency is bounded by engine-read + one batch, not the full set"],
  },

  // ------------------------------------------------- honest counting
  {
    name: "the limitation array is cleared — unverified count is always zero",
    breaks:
      "the count of entries that could not be loaded is always zero, so the report cannot " +
      "say which evidence was not verified",
    file: INPUTS,
    find: "    limitations,\n  };\n}\n\n/**\n * SIGNING KEYS ARE CONFIGURATION",
    replace: "    limitations: [],\n  };\n}\n\n/**\n * SIGNING KEYS ARE CONFIGURATION",
    kills: ["unverified entries are counted honestly, never silently dropped"],
  },

  // ------------------------------------------------- manifest coverage
  {
    name: "pre-verified hashes are not passed to the judge — only disk files are in the manifest",
    breaks:
      "without the pre-verified hashes the authority sees only JSON files on disk and reports " +
      "every PNG as CITED_ARTIFACT_MISSING, clearing manifestComplete",
    file: VERDICTS,
    find: "    preVerifiedArtifacts: streamResult.preVerifiedHashes,",
    replace: "    preVerifiedArtifacts: null,",
    kills: ["the judge produces correct verdicts when PNGs are pre-verified and only JSONs are on disk"],
  },
];

await runMutantSuite({
  title: "A3 memory-safe judging mutants — can the bounded-residency tests still fail?",
  filter: "A3",
  mutants: MUTANTS,
});
