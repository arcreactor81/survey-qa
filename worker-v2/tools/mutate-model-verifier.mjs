#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D59 MODEL VERIFIER LANE TESTS CAN FAIL.
 *
 *   node tools/mutate-model-verifier.mjs
 *
 * Two mutants, each targeting one load-bearing guard:
 *
 *   1. THE FAIL GUARD DROPPED — the model verifier's outcome type constraint is removed,
 *      allowing `violated` to be returned. The test asserting the lane can never emit fail
 *      must newly fail.
 *
 *   2. THE NAMED-INSUFFICIENT DEMOTION DROPPED — the catch block that demotes a model-call
 *      failure to `insufficient` is removed, letting the error propagate. The test asserting
 *      model-call failure demotes to named insufficient must newly fail.
 *
 * NOTHING IS WRITTEN TO `src/**`. The rewrite happens inside esbuild's load step
 * (`testkit.mjs#mutantPlugin`), so a crash cannot leave a mutated working copy behind.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const MODEL_VERIFIER = "src/workflow/stages/model-verifier.ts";

const MUTANTS = [
  // ---------------------------------------------------------------- fail guard
  {
    name: "the fail guard is dropped — unrecognized model responses become violated",
    breaks: "the model lane must never emit fail/violated/contradicted",
    file: MODEL_VERIFIER,
    find: '  // Everything else — including explicit "INSUFFICIENT", garbled output, empty string —\n' +
      '  // maps to insufficient. The fail-closed direction.\n' +
      '  return { decision: "insufficient", flag };',
    replace: '  // MUTANT: fail guard dropped — unrecognized responses become violated\n' +
      '  return { decision: "violated", flag };',
    kills: [
      "the lane can never emit fail — unknown model response maps to insufficient",
    ],
  },

  // --------------------------------------------------------- named insufficient demotion
  {
    name: "the named-insufficient demotion is dropped — model failures propagate",
    breaks: "model-call failure must demote to named insufficient, not propagate",
    file: MODEL_VERIFIER,
    find:
      "  } catch (err) {\n" +
      "    // MODEL CALL FAILED — demote to named insufficient with the reason code.\n" +
      "    // The error detail is included for diagnostics but carries no verdict weight.\n" +
      "    const errMsg = err instanceof Error ? err.message : String(err);\n" +
      "    return modelInsufficient(\n" +
      "      VERIFIER_REASON.MODEL_CALL_FAILED,\n" +
      "      `model call to ${COPY_MODEL_ID} failed: ${errMsg.slice(0, 200)}`,\n" +
      "      COPY_MODEL_ID,\n" +
      "      hash,\n" +
      "      evidenceIds,\n" +
      "    );\n" +
      "  }",
    replace:
      "  } catch (err) {\n" +
      "    // MUTANT: demotion removed — errors propagate\n" +
      "    throw err;\n" +
      "  }",
    kills: [
      "model-call failure demotes to named insufficient",
    ],
  },
];

await runMutantSuite({
  title: "D59 model verifier lane v1 — fail guard and demotion guard",
  mutants: MUTANTS,
});
