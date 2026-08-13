/**
 * THE TEST AXIS MUST ALWAYS TERMINATE — pins review-run-workflow.md finding 1.
 *
 * THE FAILURE THIS PINS, on the code as it was. The contract-reuse adopted branch
 * (`else if (reuse.adopted)` in run-workflow.ts) skips both `phase-extracting` arms —
 * the only production writers of `completion.test = "running"` — and finalize's
 * never-closed backstop tested `completion.test === "running"` EXACTLY. So a
 * reuse-adopted run that hit a test-axis blocker (the verified trigger: `loadProgram`
 * returning null leaves `probeLimitations === null`, which `testAxisBlockers` turns into
 * a blocker `close-test-axis` refuses to close over) ended DURABLY with
 * `completion.test: "not-started"`, `reasonCode: null`, `error: null`, a built report and
 * no active marker. `isTerminalTest("not-started")` is false, so the run was neither
 * terminal nor sweepable — invisible to every resolver, a loud refusal turned silent.
 *
 * TWO HALVES, and the two primary tests each FAIL on the pre-fix code:
 *
 *   1. ADOPTION MARKS THE AXIS IN FLIGHT — `completion.test = "running"` inside the same
 *      durable write that adopts the sealed revision, as the sibling extract paths do.
 *   2. FINALIZE IS THE BELT: ANY non-terminal axis (`isTerminalTest` false — today that is
 *      "not-started" as well as "running") promotes to `failed` / `test-axis-never-closed`,
 *      so the NEXT branch that forgets to mark the axis still terminates loudly.
 *
 * The edge tests hold the boundary in both directions: the promotion must not widen into
 * clobbering a deliberate terminal state or a deliberate reasonCode — that would be the
 * same defect pointing the other way.
 */

import { assert, assertEq, fakeStep, suite, test } from "../testkit.mjs";
import { contractBody } from "../fixtures/v2-fixture.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

/** The literal reason string — the constant is module-local to run-workflow.ts. */
const NEVER_CLOSED = "test-axis-never-closed";

const load = async (mod, env, runId) => (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;

/** A fresh, pre-extraction run: checkpoint exists, nothing has happened yet. */
async function freshRun(mod, env) {
  const runId = mod.ids.mintRunId();
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  return runId;
}

/**
 * Index a sealed revision as reusable, exactly as a prior run of the same bytes would
 * have: sealed with `extraction.reuseInputsHash` bound to the inputs digest, then
 * recorded first-writer-wins. Every gate `adoptReusableContract` checks is satisfied
 * honestly — schema 1.0.0, matching documentSha256, digest that re-derives, non-empty
 * docxParserVersion, a revision that re-reads and re-hashes.
 */
async function seedAdoptableContract(mod, env) {
  const documentSha256 = "b".repeat(64);
  const documentSemanticsProfile = mod.docxBlocks.DOCUMENT_SEMANTICS_NONE;
  const inputs = {
    documentSha256,
    docxParserVersion: mod.docxBlocks.docxBlocksVersion(documentSemanticsProfile),
    documentSemanticsProfile,
    promptVersionA: mod.passA.PASS_A_VERSION,
    promptVersionB: mod.passB.PASS_B_VERSION,
    modelA: mod.grok.grokFlashRouteIdentity(env),
    modelB: mod.deepseek.deepseekPassBIdentity(env),
    mergeVersion: mod.merge.MERGE_VERSION,
    expanderVersion: mod.expand.EXPANDER_VERSION,
    locale: "en",
    viewports: ["desktop"],
    reviewMode: "high-risk-only",
    policyFingerprint: await mod.contractReuse.extractionPolicyFingerprint(env),
  };
  const digest = await mod.contractReuse.extractionInputsDigest(inputs);
  const body = contractBody({ documentSha256 });
  body.extraction.reuseInputsHash = `sha256:${digest}`;
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, body);
  await mod.contractReuse.recordReusableContract(env, digest, {
    contractRevisionId,
    contractHash,
    inputs,
    sealedByRunId: "v2r_priorrunfixture",
    sealedAt: "2026-08-10T00:00:00.000Z",
  });
  return { digest, contractRevisionId, contractHash };
}

suite("test axis closure: adoption marks the axis in flight", () => {
  test("PINS finding 1 (cause): a reuse-adopted run's completion.test is running, not not-started", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = await freshRun(mod, env);
    const { digest, contractRevisionId } = await seedAdoptableContract(mod, env);

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const reuse = await wf.adoptReusableContract(fakeStep(), runId, digest, undefined);

    // The fixture must genuinely adopt, or every assertion below is vacuous.
    assertEq(reuse.adopted, true, "the honestly-seeded index entry must adopt");
    assertEq(reuse.contractRevisionId, contractRevisionId, "and adopt the revision that was indexed");

    const cp = await load(mod, env, runId);
    assertEq(cp.contract.state, "sealed", "adoption seals the checkpoint's contract");
    // THE PINNED ASSERTION. Pre-fix, adoption wrote contract + counts + phase and never
    // touched `completion.test`, leaving it "not-started" — the state finalize's backstop
    // could not see and no resolver could ever terminate.
    assertEq(
      cp.completion.test,
      "running",
      "adoption must mark the test axis in flight in the same durable write — " +
        "a run whose axis says not-started while it executes is invisible to the never-closed backstop",
    );
    // Adoption is not a failure, and must not manufacture one.
    assertEq(cp.completion.reasonCode, null, "adopting is a healthy path — no reasonCode");
    assertEq(cp.error, null, "and no error");
  });

  test("a reuse MISS leaves the axis alone — the extract path owns that write", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = await freshRun(mod, env);
    // No index entry seeded: the lookup misses and the run falls through to extraction.

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const reuse = await wf.adoptReusableContract(fakeStep(), runId, "0".repeat(64), undefined);

    assertEq(reuse.adopted, false, "nothing was indexed, so nothing may be adopted");
    const cp = await load(mod, env, runId);
    assertEq(
      cp.completion.test,
      "not-started",
      "a miss writes nothing — `phase-extracting` marks the axis when extraction actually starts",
    );
    assertEq(cp.contract.state, "unavailable", "and the contract is untouched");
  });
});

suite("test axis closure: finalize is the belt for any non-terminal axis", () => {
  test("PINS finding 1 (consequence): finalize promotes a not-started axis to failed / test-axis-never-closed", async () => {
    const mod = await worker();
    const env = testEnv();
    // The exact durable state the reuse-adopted run reached finalize in: axis never marked,
    // never closed (close-test-axis had blockers, so it wrote nothing).
    const { runId } = await seedRun(mod, env, { testCompletion: "not-started" });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    const step = fakeStep();
    const out = await wf.reportAndFinalize(step, runId, undefined);

    // Pre-fix, `completion.test === "running"` was false for "not-started": the promotion
    // was skipped and the run ended durably non-terminal with reasonCode null — neither
    // terminal nor sweepable, invisible to every resolver.
    assertEq(out.completion.test, "failed", "the finalization result must be terminal");
    const cp = await load(mod, env, runId);
    assertEq(cp.completion.test, "failed", "an axis nobody closed is a FAILURE, not a silent open state");
    assertEq(cp.completion.reasonCode, NEVER_CLOSED, "and it is NAMED");
    assert(
      cp.completion.reasonCode !== null && mod.contracts.isTerminalTest(cp.completion.test),
      "the promoted state must be terminal by the same predicate every resolver uses",
    );
    assert(cp.error, "a reader must find a sentence explaining the failure");

    // The promotion reaches the read surface, not just the checkpoint.
    const envelope = await mod.envelope.getEnvelope(env, runId);
    assertEq(envelope.finalCompletion.test, "failed", "the envelope records the terminal axis");
  });

  test("a RUNNING axis still promotes — widening kept the original backstop", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.reportAndFinalize(fakeStep(), runId, undefined);

    const cp = await load(mod, env, runId);
    assertEq(cp.completion.test, "failed", "the pre-widening case must keep working");
    assertEq(cp.completion.reasonCode, NEVER_CLOSED);
  });

  test("a TERMINAL axis is untouched — the belt must not clobber a closed run", async () => {
    const mod = await worker();
    const env = testEnv();

    // A cleanly closed run stays complete with no reasonCode…
    const clean = await seedRun(mod, env, { testCompletion: "complete" });
    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.reportAndFinalize(fakeStep(), clean.runId, undefined);
    const cleanCp = await load(mod, env, clean.runId);
    assertEq(cleanCp.completion.test, "complete", "complete is terminal — the backstop must not fire");
    assertEq(cleanCp.completion.reasonCode, null, "and must not invent a reason");

    // …and a deliberate partial stop keeps BOTH its state and its reasonCode.
    const partial = await seedRun(mod, env, { testCompletion: "partial-blocked" });
    await mod.checkpoint.updateCheckpoint(env, partial.runId, (d) => {
      d.completion.reasonCode = "walks-blocked-by-site";
    });
    await wf.reportAndFinalize(fakeStep(), partial.runId, undefined);
    const partialCp = await load(mod, env, partial.runId);
    assertEq(partialCp.completion.test, "partial-blocked", "a deliberate partial ending is a settled outcome");
    assertEq(partialCp.completion.reasonCode, "walks-blocked-by-site", "with its own reason still on file");
  });

  test("promotion NAMES the gap without overwriting a reason already on file", async () => {
    const mod = await worker();
    const env = testEnv();
    // A non-terminal axis that nevertheless carries a deliberate reasonCode — the `??`
    // seam: the backstop must terminate the run but the earlier, more specific reason wins.
    const { runId } = await seedRun(mod, env, { testCompletion: "not-started" });
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.completion.reasonCode = "walks-blocked-by-site";
    });

    const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
    await wf.reportAndFinalize(fakeStep(), runId, undefined);

    const cp = await load(mod, env, runId);
    assertEq(cp.completion.test, "failed", "the run still terminates");
    assertEq(
      cp.completion.reasonCode,
      "walks-blocked-by-site",
      "the deliberate reason outranks the backstop's generic one — same rule as every other promotion",
    );
  });
});
