#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D59 MODEL VERIFIER LANE TESTS CAN FAIL.
 *
 *   node tools/mutate-model-verifier.mjs
 *
 * Three mutants, each targeting one load-bearing guard:
 *
 *   1. THE FAIL GUARD DROPPED — the model verifier's outcome type constraint is removed,
 *      allowing `violated` to be returned. The test asserting the lane can never emit fail
 *      must newly fail.
 *
 *   2. THE NAMED-INSUFFICIENT DEMOTION DROPPED — the catch block that demotes a model-call
 *      failure to `insufficient` is removed, letting the error propagate. The test asserting
 *      model-call failure demotes to named insufficient must newly fail.
 *
 *   3. THE TARGET-SCREEN GUARD DROPPED — the guard that returns insufficient when the
 *      target question is not on any screen is removed, letting the code call the model with
 *      the first available screen regardless. The test asserting the model is never called
 *      with a wrong screen must newly fail.
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
      "    // MODEL CALL FAILED — push usage for the failed call (it still consumed compute),\n" +
      "    // then demote to named insufficient with the reason code.\n" +
      "    await pushWorkersAIUsage(env, runId, fence, hash);\n" +
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

  // --------------------------------------------------------- target-screen guard
  {
    name: "the target-screen guard is dropped — model called with arbitrary screen when target not found",
    breaks: "known targetQ with no matching screen must never call the model",
    file: MODEL_VERIFIER,
    find:
      "    if (targetMatchScreenTexts.length === 0) {\n" +
      "      // FAIL-CLOSED: no screen mentions the target question. Returning insufficient\n" +
      "      // rather than comparing against an arbitrary screen that might share common\n" +
      "      // header/instruction text with the requirement.\n" +
      "      return modelInsufficient(\n" +
      "        VERIFIER_REASON.MODEL_COPY_TARGET_SCREEN_NOT_FOUND,\n" +
      "        `target question ${targetQ} not found in any of ${allScreenTexts.length} screen(s)`,\n" +
      "        COPY_MODEL_ID,\n" +
      '        "",\n' +
      "        evidenceIds,\n" +
      "      );\n" +
      "    }\n" +
      "    return callModelForScreen(env, runId, fence, targetMatchScreenTexts[0]!, requirementText, evidenceIds);",
    replace:
      "    // MUTANT: target-screen guard dropped — call with first available screen regardless\n" +
      "    const screenToUse = targetMatchScreenTexts.length > 0 ? targetMatchScreenTexts[0]! : allScreenTexts[0]!;\n" +
      "    return callModelForScreen(env, runId, fence, screenToUse, requirementText, evidenceIds);",
    kills: [
      "known targetQ with no matching screen => insufficient MODEL_COPY_TARGET_SCREEN_NOT_FOUND, model not invoked",
    ],
  },
];

await runMutantSuite({
  title: "D59 model verifier lane v1 — fail guard, demotion guard, and target-screen guard",
  mutants: MUTANTS,
});
