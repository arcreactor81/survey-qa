#!/usr/bin/env node
/**
 * EVIDENCE THAT THE COMMITTED-EVIDENCE FILTER'S TESTS CAN FAIL.
 *
 *   node tools/mutate-committed-evidence.mjs
 *
 * Each mutant below REVERTS one specific guarantee to the shape it would have if nobody
 * had implemented it, and asserts that THE NAMED TEST WHICH GUARDS IT newly fails.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), so the working copy is never touched and an interrupted
 * mutation run leaves nothing behind.
 *
 * THE FOUR PROPERTIES UNDER MUTATION:
 *
 *   1. The filter drops uncommitted-attempt rows.
 *      Mutant: keep ALL rows regardless of attemptId -> committed/uncommitted distinction
 *      is gone, so the "committed-attempt rows are kept, uncommitted rows are dropped"
 *      test newly fails.
 *
 *   2. The document-side exemption (attemptId === null rows are kept).
 *      Mutant: treat null attemptId as uncommitted (drop it) -> the exemption test fails.
 *
 *   3. The missing-ledger loud refusal (throws MissingWalkLedgerError).
 *      Mutant: return all evidence instead of throwing -> the missing-ledger test fails.
 *
 *   4. The drop counts are correct (droppedOrphans, droppedByRef, sentence).
 *      Mutant: zero out droppedOrphans count in the return -> the counts test fails.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const FILTER = "src/store/committed-evidence.ts";

const MUTANTS = [
  // ---------------------------------------------------------------- PROPERTY 1
  // The filter must drop uncommitted-attempt rows. Mutant: keep everything.
  {
    name: "the filter keeps uncommitted-attempt rows instead of dropping them",
    breaks: "evidence from killed attempts would contaminate the signed record",
    file: FILTER,
    find: "    if (committedAttemptIds.has(row.attemptId)) {\n      kept.push(row);\n      continue;\n    }",
    replace: "    if (true) {\n      kept.push(row);\n      continue;\n    }",
    kills: ["committed-attempt rows are kept, uncommitted rows are dropped"],
  },

  // ---------------------------------------------------------------- PROPERTY 2
  // Document-side evidence (attemptId === null) must be exempt.
  // Mutant: drop the null-attemptId exemption, treating doc evidence as uncommitted.
  {
    name: "document-side evidence is no longer exempt — null attemptId is treated as uncommitted",
    breaks: "extraction artefacts and source material would be dropped from the record",
    file: FILTER,
    find: "    if (row.attemptId == null) {\n      kept.push(row);\n      documentSideCount++;\n      continue;\n    }",
    replace: "    // mutant: exemption removed, null attemptId falls through to the uncommitted path",
    kills: ["document-side evidence (attemptId === null) is exempt and always kept"],
  },

  // ---------------------------------------------------------------- PROPERTY 3
  // A missing ledger must throw, not silently pass everything through.
  // Mutant: return all evidence unfiltered instead of throwing.
  {
    name: "a missing ledger silently passes everything through instead of refusing",
    breaks: "the signed record could carry orphan rows from runs whose ledger was lost",
    file: FILTER,
    find: "  if (walks == null) {\n    throw new MissingWalkLedgerError();\n  }",
    replace: `  if (walks == null) {\n    return {\n      kept: evidence,\n      droppedOrphans: [],\n      droppedByRef: [],\n      sentence: "filter bypassed: no walk ledger",\n    };\n  }`,
    kills: ["missing ledger (null) = loud refusal, never silent pass-through"],
  },

  // ---------------------------------------------------------------- PROPERTY 4
  // The drop counts must be correct. Mutant: zero out the orphan count.
  {
    name: "the drop count is zeroed — the sentence lies about how many rows were excluded",
    breaks: "a reader of the record cannot tell whether filtering happened",
    file: FILTER,
    find: "    `${droppedOrphans.length} evidence rows from uncommitted attempts excluded${refDetail}; ` +",
    replace: "    `${0} evidence rows from uncommitted attempts excluded${refDetail}; ` +",
    kills: ["counts and sentence are correct and present"],
  },
];

await runMutantSuite({
  title: "committed-evidence filter (A1)",
  mutants: MUTANTS,
  testFilter: "committed-evidence filter",
});
