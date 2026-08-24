/**
 * COMPLETION LABELS — the run's ending names the ACTUAL cause.
 *
 * Three independently testable fixes:
 *
 *   1. STEP-TIMEOUT RECOGNITION. Cloudflare's opaque "Attempt failed due to internal
 *      workflows error" used to land as `workflow-error`. Five real runs died this way and
 *      a reader could not tell "the platform killed the step" from "there is a bug".
 *      `classifyFailure` now returns `step-timeout` for that sentence.
 *
 *   2. FAILURE-REPORT-WITH-DISAGREEMENT. Run v2r_01m0933y… had 402 failed extraction
 *      units, mismatched usage receipts, and the report generator REFUSED to publish — the
 *      reader got 404, which is silence. The report now generates WITH a named disagreement
 *      limitation instead of refusing.
 *
 *   3. DEV-DRIVE TARGETING. `targetQuestionId` was hardcoded null; a dev walk could not
 *      target a question. The dev-drive request now accepts an optional `targetQuestionId`,
 *      validates it against the sealed contract, and threads it to the walker.
 *
 * Evidence each can fail: the mutation anchors are in `classifyFailure` (STEP_TIMEOUT_PHRASES),
 * `failure.ts` (usageDisagreement path), and `dev-drive.ts` (targetQuestionId validation).
 */

import { assert, assertEq, fakeStep, memoryR2, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

// ============================================================================
// 1. classifyFailure: step-timeout recognition
// ============================================================================

suite("classifyFailure — step-timeout is a named cause, not an unknown crash", () => {
  test("the exact Cloudflare step-timeout sentence is classified as step-timeout", async () => {
    const mod = await worker();
    const result = mod.workflow.classifyFailure(
      "WorkflowInternalError: Attempt failed due to internal workflows error",
    );
    assertEq(result, "step-timeout", "the platform's opaque sentence must be recognised");
  });

  test("case-insensitive match: mixed case still classifies", async () => {
    const mod = await worker();
    const result = mod.workflow.classifyFailure(
      "attempt FAILED due to internal workflows error",
    );
    assertEq(result, "step-timeout", "case sensitivity must not break recognition");
  });

  test("an Error object wrapping the platform sentence is classified", async () => {
    const mod = await worker();
    const err = new Error("Attempt failed due to internal workflows error");
    err.name = "WorkflowInternalError";
    const result = mod.workflow.classifyFailure(err);
    assertEq(result, "step-timeout", "Error objects must be unwrapped and classified");
  });

  test("subrequest limit is still classified correctly (not displaced)", async () => {
    const mod = await worker();
    assertEq(
      mod.workflow.classifyFailure("Too many API requests by single Worker invocation."),
      "subrequest-limit-exceeded",
      "subrequest classification must not be displaced by step-timeout",
    );
  });

  test("planning-refused is still classified correctly (not displaced)", async () => {
    const mod = await worker();
    assertEq(
      mod.workflow.classifyFailure("planning refused duplicate sealed facetInstanceId fi_abc"),
      "planning-refused",
      "planning-refused classification must not be displaced by step-timeout",
    );
  });

  test("an unrecognised error still returns null", async () => {
    const mod = await worker();
    assertEq(
      mod.workflow.classifyFailure("some completely unknown error"),
      null,
      "unrecognised errors must still return null (workflow-error fallback)",
    );
  });

  test("step-timeout on the checkpoint sets the correct reasonCode (fixture checkpoint)", async () => {
    const mod = await worker();
    const env = testEnv();
    const { runId } = await seedRun(mod, env, { testCompletion: "running" });
    const { step } = instrumented(mod, env, runId);

    // Simulate the step-timeout death that the platform produces.
    let threw;
    try {
      await step.do("execute-batch-3", { retries: { limit: 0 } }, async () => {
        throw new Error("Attempt failed due to internal workflows error");
      });
    } catch (e) {
      threw = e;
    }
    assert(threw, "the step must propagate the error");

    const cp = await load(mod, env, runId);
    assert(cp.failure, "the cause must be recorded on the checkpoint");
    assertEq(cp.failure.step, "execute-batch-3", "the step name is recorded");
    assertEq(cp.failure.reasonCode, "step-timeout", "step-timeout, not workflow-error");
  });
});

// ============================================================================
// 2. Failure report with usage disagreement
// ============================================================================

suite("failure report generates WITH disagreement note instead of refusing", () => {
  test("mismatched receipts produce a report with a named limitation, not a refusal", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const documentKey = mod.keys.inputDocumentKey(runId);
    const documentBytes = new TextEncoder().encode("neutral questionnaire bytes");
    const documentSha256 = await mod.hash.sha256Hex(documentBytes);
    const eventId = `core-model-call/pass-a/${runId}/A-w1/issue-1/receipt-1`;

    // Envelope
    await mod.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: "2026-08-14T00:00:00.000Z",
      instanceId: runId,
      input: {
        surveyUrl: "https://fixture.invalid/survey",
        documentKey,
        documentSha256,
        documentName: "neutral-questionnaire.docx",
        targetBuildId: null,
        locale: "en",
        viewports: ["desktop"],
        contractSource: { mode: "extract" },
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    });

    // Source document
    await env.EVIDENCE.put(documentKey, documentBytes, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });

    // Checkpoint: terminal extraction failure
    await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const fence = await mod.checkpoint.claimOwnership(env, runId, runId, 1);
    await mod.usage.pushModelUsageStrict(env, runId, fence, [
      mod.usage.modelUsage("grok-4.5", 12, 3, 0.000004, eventId),
    ]);
    const REASON = "extraction-pass-a-reduced-provider-independence";
    await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
      mod.checkpoint.setPhase(draft, "extracting", "stopped", REASON);
      draft.contract = mod.contracts.unavailableContract();
      draft.completion.test = "failed";
      draft.completion.report = "building";
      draft.completion.reasonCode = REASON;
      draft.error = "REDUCED_PROVIDER_INDEPENDENCE: test fixture";
    }, { progressed: true, fence });

    // Extraction artifact with a DIFFERENT eventId — creating the disagreement
    const artifactKey = mod.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    await env.EVIDENCE.put(artifactKey, JSON.stringify({
      windowId: "A-w1",
      windowNumber: 1,
      blockIds: ["block-neutral-1"],
      usages: [{ eventId: `${eventId}-DIFFERENT` }],
    }), { httpMetadata: { contentType: "application/json" } });

    // Build the failure report — this used to REFUSE with failure-report-extraction-usage-disagreement
    const result = await mod.failureReport.buildAndStoreTerminalFailureReport(env, runId);

    assert(result.ok, `expected ok=true, got ${JSON.stringify(result)}`);
    assertEq(result.summary.certification, "operational-failure-no-qa-results");
    assertEq(result.summary.findings, 0, "zero QA findings");

    // Read the report pointer and then the data behind it
    const pointerKey = mod.keys.reportPointerKey(runId);
    const pointerObj = await env.EVIDENCE.get(pointerKey);
    assert(pointerObj, "report pointer must be published");
    const pointer = JSON.parse(await pointerObj.text());
    assert(pointer.buildId, "report pointer must carry a buildId");

    const dataKey = mod.keys.reportVersionDataKey(runId, pointer.buildId);
    const dataObj = await env.EVIDENCE.get(dataKey);
    assert(dataObj, "report data JSON must exist");
    const reportData = JSON.parse(await dataObj.text());

    const disagreementLimitation = reportData.limitations.find(
      (l) => l.code === "extraction-usage-disagreement",
    );
    assert(
      disagreementLimitation,
      "the report must carry a named extraction-usage-disagreement limitation",
    );
    assert(
      disagreementLimitation.detail.includes("paid receipt(s) missing from artifacts"),
      "the limitation detail must name the direction of the mismatch",
    );
    assert(
      reportData.extractionEvidence.receiptBinding.startsWith("disagreement:"),
      `receiptBinding must say disagreement, got: ${reportData.extractionEvidence.receiptBinding}`,
    );
  });

  test("matched receipts still produce a complete binding (no regression)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const documentKey = mod.keys.inputDocumentKey(runId);
    const documentBytes = new TextEncoder().encode("neutral questionnaire bytes");
    const documentSha256 = await mod.hash.sha256Hex(documentBytes);
    const eventId = `core-model-call/pass-a/${runId}/A-w1/issue-1/receipt-1`;

    await mod.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: "2026-08-14T00:00:00.000Z",
      instanceId: runId,
      input: {
        surveyUrl: "https://fixture.invalid/survey",
        documentKey,
        documentSha256,
        documentName: "neutral-questionnaire.docx",
        targetBuildId: null,
        locale: "en",
        viewports: ["desktop"],
        contractSource: { mode: "extract" },
      },
      profile: "standard",
      contractRevisionId: null,
      recovery: null,
      finalCompletion: null,
    });
    await env.EVIDENCE.put(documentKey, documentBytes, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
    await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
    const fence = await mod.checkpoint.claimOwnership(env, runId, runId, 1);
    await mod.usage.pushModelUsageStrict(env, runId, fence, [
      mod.usage.modelUsage("grok-4.5", 12, 3, 0.000004, eventId),
    ]);
    const REASON = "extraction-pass-a-reduced-provider-independence";
    await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
      mod.checkpoint.setPhase(draft, "extracting", "stopped", REASON);
      draft.contract = mod.contracts.unavailableContract();
      draft.completion.test = "failed";
      draft.completion.report = "building";
      draft.completion.reasonCode = REASON;
      draft.error = "REDUCED_PROVIDER_INDEPENDENCE: test fixture";
    }, { progressed: true, fence });

    // Extraction artifact with the SAME eventId — no disagreement
    const artifactKey = mod.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
    await env.EVIDENCE.put(artifactKey, JSON.stringify({
      windowId: "A-w1",
      windowNumber: 1,
      blockIds: ["block-neutral-1"],
      usages: [{ eventId }],
    }), { httpMetadata: { contentType: "application/json" } });

    const result = await mod.failureReport.buildAndStoreTerminalFailureReport(env, runId);
    assert(result.ok, "matched receipts must still produce a report");
    // No disagreement limitation
    const pointerKey = mod.keys.reportPointerKey(runId);
    const pointerObj = await env.EVIDENCE.get(pointerKey);
    assert(pointerObj, "matched receipts must publish a report pointer");
    const pointer = JSON.parse(await pointerObj.text());
    const dataKey = mod.keys.reportVersionDataKey(runId, pointer.buildId);
    const reportData = JSON.parse(await (await env.EVIDENCE.get(dataKey)).text());
    const disagreementLimitation = reportData.limitations.find(
      (l) => l.code === "extraction-usage-disagreement",
    );
    assertEq(
      disagreementLimitation,
      undefined,
      "matched receipts must NOT carry a disagreement limitation",
    );
    assert(
      reportData.extractionEvidence.receiptBinding.startsWith("complete:"),
      `receiptBinding must say complete, got: ${reportData.extractionEvidence.receiptBinding}`,
    );
  });
});

// ============================================================================
// 3. Dev-drive targetQuestionId
// ============================================================================

suite("dev-drive accepts and validates targetQuestionId", () => {
  test("targetQuestionId is wired to facet instances and appears in the response", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = {
      surveyUrl: "https://fixture.invalid/s",
      targetQuestionId: "Q7",
      checklist: {
        obligations: [
          { id: "OBL-1", statement: "Question 7 must show options A and B", target_question_id: "Q7" },
        ],
      },
    };
    const req = new Request("https://fixture.invalid/api/v2/dev/drive", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    const response = await mod.devDrive.devDrive(req, env);
    assertEq(response.status, 202, `expected 202, got ${response.status}`);
    const result = await response.json();
    assertEq(result.targetQuestionId, "Q7", "response must echo the accepted targetQuestionId");
    assert(result.runId, "response must include a runId");
    assert(result.contractRevisionId, "response must include a contractRevisionId");

    // Verify the sealed contract carries the targetQuestionId
    const revision = await mod.contractRevision.getContractRevision(env, result.contractRevisionId);
    const fi = revision.facetInstances.find((fi) => fi.requirementLineageId === "OBL-1");
    assert(fi, "facet instance for OBL-1 must exist in the sealed contract");
    assertEq(fi.targetQuestionId, "Q7", "targetQuestionId must be threaded to the facet instance");
  });

  test("request-level targetQuestionId applies to obligations that do not name their own", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = {
      surveyUrl: "https://fixture.invalid/s",
      targetQuestionId: "Q5",
      checklist: {
        obligations: [
          { id: "OBL-A", statement: "global target" },
          { id: "OBL-B", statement: "own target", target_question_id: "Q9" },
        ],
      },
    };
    const req = new Request("https://fixture.invalid/api/v2/dev/drive", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    const response = await mod.devDrive.devDrive(req, env);
    assertEq(response.status, 202);
    const result = await response.json();

    const revision = await mod.contractRevision.getContractRevision(env, result.contractRevisionId);
    const fiA = revision.facetInstances.find((fi) => fi.requirementLineageId === "OBL-A");
    const fiB = revision.facetInstances.find((fi) => fi.requirementLineageId === "OBL-B");
    assertEq(fiA.targetQuestionId, "Q5", "obligation without its own target gets the request-level one");
    assertEq(fiB.targetQuestionId, "Q9", "obligation with its own target keeps it");
  });

  test("targetQuestionId not in any obligation is rejected with 400", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = {
      surveyUrl: "https://fixture.invalid/s",
      targetQuestionId: "Q999-NONEXISTENT",
      checklist: {
        obligations: [
          { id: "OBL-X", statement: "targets Q1 only", target_question_id: "Q1" },
        ],
      },
    };
    const req = new Request("https://fixture.invalid/api/v2/dev/drive", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    const response = await mod.devDrive.devDrive(req, env);
    assertEq(response.status, 400, "a targetQuestionId not in any FacetInstance must be rejected");
    const result = await response.json();
    assert(
      result.error.includes("Q999-NONEXISTENT"),
      "the error message must name the rejected targetQuestionId",
    );
  });

  test("omitting targetQuestionId keeps null (backwards compatibility)", async () => {
    const mod = await worker();
    const env = testEnv();
    const body = {
      surveyUrl: "https://fixture.invalid/s",
      checklist: {
        obligations: [
          { id: "OBL-Z", statement: "no target" },
        ],
      },
    };
    const req = new Request("https://fixture.invalid/api/v2/dev/drive", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    const response = await mod.devDrive.devDrive(req, env);
    assertEq(response.status, 202);
    const result = await response.json();
    assertEq(result.targetQuestionId, undefined, "response must NOT include targetQuestionId when not provided");

    const revision = await mod.contractRevision.getContractRevision(env, result.contractRevisionId);
    const fi = revision.facetInstances.find((fi) => fi.requirementLineageId === "OBL-Z");
    assertEq(fi.targetQuestionId, null, "targetQuestionId stays null when not provided");
  });

  test("DEV_SEED must be enabled for dev-drive to respond", async () => {
    const mod = await worker();
    const env = testEnv({ DEV_SEED: "disabled" });
    const req = new Request("https://fixture.invalid/api/v2/dev/drive", {
      method: "POST",
      body: JSON.stringify({ surveyUrl: "https://fixture.invalid/s", checklist: { obligations: [{ id: "X", statement: "s" }] } }),
      headers: { "content-type": "application/json" },
    });
    const response = await mod.devDrive.devDrive(req, env);
    assertEq(response.status, 404, "dev-drive must 404 when DEV_SEED is not enabled");
  });
});

// ============================================================================
// Helpers
// ============================================================================

function instrumented(mod, env, runId) {
  const wf = new mod.workflow.SurveyRunWorkflowV2({}, env);
  const raw = fakeStep();
  return { wf, raw, step: wf.instrumentSteps(raw, runId) };
}

const load = async (mod, env, runId) =>
  (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;
