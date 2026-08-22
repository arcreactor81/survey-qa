#!/usr/bin/env node
/**
 * A3 — EVIDENCE THAT THE MEMORY-SAFE JUDGING TESTS CAN FAIL.
 *
 *   node tools/mutate-a3-memory.mjs
 *
 * Four mutants, each reversing one specific guarantee:
 *
 *   1. ENGINE-READ FILTER WIDENED: `isEngineReadArtifact` returns true for ALL artifacts,
 *      so step-slot and accessibility JSONs stay resident alongside sessions. The peak-
 *      residency assertion must kill this — the peak rises because step JSONs are no
 *      longer hash-verify-only.
 *
 *   2. UNVERIFIED-COUNT ZEROED: the limitation array is cleared, so the count of unverified
 *      entries is always zero. The honest-counting test must kill this.
 *
 *   3. MANIFEST COMPUTED OVER UNFILTERED SET: the pre-verified hashes are not passed to the
 *      authority, so only disk-resident files are in the manifest check. The end-to-end test
 *      must kill this because the authority cannot verify the full set.
 *
 *   4. STEP-JSON EXCLUSION REMOVED: `isEngineReadArtifact` matches all `.json` (the old
 *      behaviour). The step-exclusion test must kill this because step-slot and accessibility
 *      JSONs would land in engineRead instead of hash-verify-only.
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
    name: "the engine-read filter is widened to all artifacts — everything stays resident",
    breaks:
      "without the narrowed filter, every artifact stays in the resident set and the peak " +
      "rises above the bounded ceiling, which is the OOM the fix exists to prevent",
    file: INPUTS,
    // The isEngineReadArtifact classification is the split point. Making it always return
    // true means every artifact goes to engineRead (the old behaviour) and nothing is
    // released via the hash-verify-only batch path.
    find: "function isEngineReadArtifact(name: string): boolean {\n  const b = name.split(\"/\").pop() ?? name;\n  // PRIMARY_SESSION pattern",
    replace: "function isEngineReadArtifact(name: string): boolean {\n  return true; // MUTANT: widened to all\n  const b = name.split(\"/\").pop() ?? name;\n  // PRIMARY_SESSION pattern",
    kills: ["peak residency is bounded by session-pattern JSONs + one batch, not the full set"],
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

  // ------------------------------------------------- step-JSON exclusion
  {
    name: "isEngineReadArtifact matches all .json — step-slot and accessibility JSONs are engine-read",
    breaks:
      "without the narrowed pattern, step-XXX-slot.json and .accessibility.json files land " +
      "in engineRead instead of hash-verify-only — the same OOM cliff as the original defect",
    file: INPUTS,
    // Revert to the old "all .json" behaviour by replacing the narrowed classifier.
    find: "function isEngineReadArtifact(name: string): boolean {\n  const b = name.split(\"/\").pop() ?? name;\n  // PRIMARY_SESSION pattern — from classifyArtifact (evidence-store.mjs)\n  if (/^(FLOOR|EXP|TD|T\\d)[-\\w]*\\.json$/i.test(b)) return true;\n  // PRIMARY_PROBE — potentially cited by answer-requirement predicates\n  if (b === \"_targeted.json\" || b === \"_scale-probes.json\") return true;\n  return false;\n}",
    replace: "function isEngineReadArtifact(name: string): boolean {\n  return /\\.json$/i.test(name);\n}",
    kills: ["step-level JSONs are NOT resident — they join the hash-verify-only stream"],
  },
];

await runMutantSuite({
  title: "A3 memory-safe judging mutants — can the bounded-residency tests still fail?",
  filter: "A3",
  mutants: MUTANTS,
});
