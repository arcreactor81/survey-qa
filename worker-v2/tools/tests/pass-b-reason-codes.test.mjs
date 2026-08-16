/**
 * Reason-code de-duplication.
 *
 * Stage reason "UNIT_FAILURES" maps to "extraction-pass-b-unit-failures"; no
 * reason code in the emitted set matches /pass-([ab])-pass-\1/. The doubled
 * prefix is the cosmetic bug this test pins as fixed.
 */

import { assert, assertEq, loadWorker, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

suite("pass-B reason codes", () => {
  test("UNIT_FAILURES maps to extraction-pass-b-unit-failures without doubling", async () => {
    // mutation-anchor: reason-code-no-double-prefix
    const m = await mod();
    const result = { state: "not-evaluated", reason: "UNIT_FAILURES" };
    const refusal = m.workflow.extractionPassRefusal("b", result);
    assert(refusal !== null, "refusal must be produced for not-evaluated result");
    assertEq(refusal.reasonCode, "extraction-pass-b-unit-failures");
  });

  test("INCOMPLETE maps to extraction-pass-b-incomplete without doubling", async () => {
    const m = await mod();
    const result = { state: "not-evaluated", reason: "INCOMPLETE" };
    const refusal = m.workflow.extractionPassRefusal("b", result);
    assert(refusal !== null);
    assertEq(refusal.reasonCode, "extraction-pass-b-incomplete");
  });

  test("COMPLETION_ARTIFACT_INVALID maps to extraction-pass-a-completion-artifact-invalid", async () => {
    const m = await mod();
    const result = { state: "not-evaluated", reason: "COMPLETION_ARTIFACT_INVALID" };
    const refusal = m.workflow.extractionPassRefusal("a", result);
    assert(refusal !== null);
    assertEq(refusal.reasonCode, "extraction-pass-a-completion-artifact-invalid");
  });

  test("no emitted reason code has a doubled pass prefix", async () => {
    const m = await mod();
    const reasons = [
      "UNIT_FAILURES",
      "INCOMPLETE",
      "COMPLETION_ARTIFACT_INVALID",
      "SYNTHESIS_FAILURE",
      "WINDOW_FAILURES",
      "FAILURE_RATE_EXCEEDED",
    ];
    const doublePrefix = /pass-([ab])-pass-\1/;
    for (const reason of reasons) {
      for (const pass of ["a", "b"]) {
        const result = { state: "not-evaluated", reason };
        const refusal = m.workflow.extractionPassRefusal(pass, result);
        if (refusal) {
          assert(
            !doublePrefix.test(refusal.reasonCode),
            `reason code "${refusal.reasonCode}" has a doubled pass prefix`,
          );
        }
      }
    }
  });
});
