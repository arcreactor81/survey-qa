/**
 * A terminal extraction refusal has useful durable evidence before a RunRecord can exist.
 * Reporting that evidence is not permission to invent a denominator or QA result.
 *
 * The positive path crosses the real report/finalize tail and both normal report endpoints.
 * The negative path corrupts or removes the retained extraction receipt and proves that
 * publication fails with no pointer, no bytes claim, and reportAvailable=false.
 */

import { strToU8, zipSync } from "fflate";
import { assert, assertEq, fakeStep, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const REASON = "extraction-pass-a-reduced-provider-independence";
const WIRE_REASON = "extraction-model-input-wire-ceiling-exceeded";
const WIRE_PRIVATE_SENTINEL = "PRIVATE_WIRE_SOURCE_SENTINEL_DO_NOT_EXPOSE";
const WIRE_PUBLIC_DETAIL =
  "A document-reading unit exceeded the configured safe input limit; this refusal issued no new credential lookup or provider request.";

const oversizedWireDocx = () => zipSync({
  "word/document.xml": strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:r><w:t>Neutral questionnaire instruction. ${"x".repeat(450_100)} ${WIRE_PRIVATE_SENTINEL}</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  ),
}, { mtime: "2026-08-14T00:00:00.000Z" });

function wireCeilingEnv(secretReads) {
  const countedSecret = {
    async get() {
      secretReads.count += 1;
      return "fixture-secret-that-must-not-be-read";
    },
  };
  return testEnv({
    XAI_API_KEY: countedSecret,
    DEEPSEEK_API_KEY: countedSecret,
    GROK_MODEL: "grok-4.5",
    GROK_RATE_BINDING_SCHEMA: "survey-qa-grok-rate-binding/1.0.0",
    GROK_RATE_POLICY: "max-known-text-tier/1.0.0",
    GROK_RATE_SOURCE: "owner-console-confirmation",
    GROK_RATE_ATTESTED_MODEL: "grok-4.5",
    GROK_RATE_ATTESTED_AT: "2026-08-15",
    GROK_RATE_RECEIPT_SHA256: "9bc864b4e87925b6bc7d4426e3a074d6f5b7e5c8b582e1e91e0b257a2618289e",
    GROK_CONTEXT_WINDOW_TOKENS: "500000",
    GROK_INPUT_USD_PER_MTOK: "2",
    GROK_CACHED_INPUT_USD_PER_MTOK: "0.3",
    GROK_OUTPUT_USD_PER_MTOK: "6",
    GROK_LONG_CONTEXT_THRESHOLD_TOKENS: "200000",
    GROK_LONG_CONTEXT_INPUT_USD_PER_MTOK: "4",
    GROK_LONG_CONTEXT_CACHED_INPUT_USD_PER_MTOK: "0.6",
    GROK_LONG_CONTEXT_OUTPUT_USD_PER_MTOK: "12",
    GROK_MAX_INPUT_USD_PER_MTOK: "4",
    GROK_MAX_OUTPUT_USD_PER_MTOK: "12",
    DEEPSEEK_CONTEXT_WINDOW_TOKENS: "1000000",
    EXTRACT_MODEL_INPUT_MAX_BYTES: "450000",
    EXTRACT_MAX_OUTPUT_TOKENS: "32000",
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "100",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
    EXTRACT_MAX_ATTEMPTS: "2",
  });
}

async function refusalFixture(mod, evidenceState) {
  const env = testEnv();
  const runId = mod.ids.mintRunId();
  const eventId = `core-model-call/pass-a/${runId}/A-w1/issue-1/receipt-1`;
  const documentKey = mod.keys.inputDocumentKey(runId);
  const documentBytes = new TextEncoder().encode("neutral questionnaire bytes");
  const documentSha256 = await mod.hash.sha256Hex(documentBytes);
  await env.EVIDENCE.put(documentKey, documentBytes, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
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
  await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
  const fence = await mod.checkpoint.claimOwnership(env, runId, runId, 1);
  await mod.usage.pushModelUsageStrict(env, runId, fence, [
    mod.usage.modelUsage("grok-4.5", 12, 3, 0.000004, eventId),
  ]);
  await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
    mod.checkpoint.setPhase(draft, "extracting", "stopped", REASON);
    draft.contract = mod.contracts.unavailableContract();
    draft.completion.test = "failed";
    draft.completion.reasonCode = REASON;
    draft.error =
      "REDUCED_PROVIDER_INDEPENDENCE: one provider family supplied both extraction methods. " +
      "1 of 4 windows landed and 3 remain unread. No Pass-B purchase was authorized.";
    const reading = mod.documentReading.withCheckpointUsage(
      mod.documentReading.readingFromPrimary({
        done: false,
        windowsTotal: 4,
        windowsLanded: 1,
        windowsRemaining: 3,
        terminalFailure: true,
        synthesisState: "reduced-provider-independence",
      }, { state: "reading", updatedAt: draft.observedAt }),
      draft.usage,
    );
    draft.documentReading = mod.documentReading.stopDocumentReading(
      reading, REASON, draft.error, draft.observedAt,
    );
  }, { progressed: true, fence });

  const artifactKey = mod.keys.k("runs", runId, "extraction", "pass-a", "window-01.json");
  if (evidenceState === "valid" || evidenceState === "mismatch") {
    const retainedEventId = evidenceState === "mismatch" ? `${eventId}-different` : eventId;
    await env.EVIDENCE.put(artifactKey, JSON.stringify({
      windowId: "A-w1",
      windowNumber: 1,
      blockIds: ["block-neutral-1", "block-neutral-2"],
      usages: [{ eventId: retainedEventId }],
      routeReceipt: { selected: "deepseek-v4-flash", trigger: { grokUsageEventId: eventId } },
    }), { httpMetadata: { contentType: "application/json" } });
  } else if (evidenceState === "malformed") {
    await env.EVIDENCE.put(artifactKey, "{this-is-not-json", { httpMetadata: { contentType: "application/json" } });
  }
  return { env, runId, fence };
}

async function finalize(mod, fixture) {
  const workflow = new mod.workflow.SurveyRunWorkflowV2({}, fixture.env);
  return workflow.reportAndFinalize(fakeStep(), fixture.runId, fixture.fence);
}

suite("terminal extraction failure report — durable evidence, zero guessed QA claims", () => {
  test("a missing submitted DOCX stops before reuse/providers and still publishes an explicit missing-source report", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const documentKey = mod.keys.inputDocumentKey(runId);
    const documentSha256 = "a".repeat(64);
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
        documentName: "missing-questionnaire.docx",
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
    await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));

    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests += 1;
      throw new Error("a missing source must never reach a provider");
    };
    try {
      const step = fakeStep();
      await new mod.workflow.SurveyRunWorkflowV2({}, env).run({
        payload: {
          runId,
          surveyUrl: "https://fixture.invalid/survey",
          documentKey,
          documentSha256,
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      }, step);

      assertEq(providerRequests, 0, "source authority is checked before any model credential/request");
      assertEq(
        step.calls.filter((name) => name.startsWith("extract-pass-a-wave-")).length,
        1,
        "the reuse miss reaches one Pass-A authority step, whose byte guard refuses before its provider",
      );
      assert(step.calls.includes("report") && step.calls.includes("finalize"), "the named refusal still reaches reporting");
      const checkpoint = (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;
      assertEq(checkpoint.completion.reasonCode, "extraction-document-source-authority-invalid");
      assertEq(checkpoint.completion.test, "failed");
      assertEq(checkpoint.completion.report, "complete");
      assertEq(checkpoint.reportAvailable, true);

      const response = await mod.apiReport.getReportData(new Request("https://fixture.invalid/"), env, runId);
      assertEq(response.status, 200);
      const data = await response.json();
      assertEq(data.source.documentObjectAuthority, "missing");
      assertEq(data.source.storedBytes, null);
      assertEq(data.source.storedBytesAuthority, "missing");
      assert(data.limitations.some((row) => row.code === "document-source-object-missing" && row.count === 1));
      assertEq(data.coverage.executionCases.tested, 0);
      assertEq(data.qaResults.findings.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("oversized model input stays counted, makes no purchase, and keeps its exact safe reason on every public surface", async () => {
    const mod = await worker();
    const secretReads = { count: 0 };
    const env = wireCeilingEnv(secretReads);
    const runId = mod.ids.mintRunId();
    const documentKey = mod.keys.inputDocumentKey(runId);
    const documentBytes = oversizedWireDocx();
    const documentSha256 = await mod.hash.sha256Hex(documentBytes);
    const parsedDocument = mod.docxBlocks.parseDocxBlocks(documentBytes);
    assertEq(parsedDocument.blocks.length, 1, "the general wire fixture owns one source block");
    assert(
      parsedDocument.blocks[0].text.endsWith(WIRE_PRIVATE_SENTINEL),
      "the private sentinel is really present in parser-owned source text",
    );
    await env.EVIDENCE.put(documentKey, documentBytes, {
      httpMetadata: {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
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
        documentName: "oversized-neutral-questionnaire.docx",
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
    await mod.checkpoint.createCheckpoint(
      env,
      mod.checkpoint.initialCheckpoint(env, runId, "standard", false),
    );

    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests += 1;
      throw new Error("the wire ceiling must refuse before any provider request");
    };
    const step = fakeStep();
    try {
      await new mod.workflow.SurveyRunWorkflowV2({}, env).run({
        payload: {
          runId,
          surveyUrl: "https://fixture.invalid/survey",
          documentKey,
          documentSha256,
          profile: "standard",
          locale: "en",
          viewports: ["desktop"],
        },
      }, step);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assertEq(secretReads.count, 0, "the all-window barrier runs before either Secrets Store lookup");
    assertEq(providerRequests, 0, "the refusal issues no provider request");
    assertEq(
      step.calls.filter((name) => name.startsWith("extract-pass-a-wave-")).length,
      1,
      "one real Pass-A Workflow step reaches the guard",
    );
    assert(step.calls.includes("report") && step.calls.includes("finalize"));

    const checkpoint = (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(checkpoint.completion.reasonCode, WIRE_REASON);
    assertEq(checkpoint.completion.test, "failed");
    assertEq(checkpoint.completion.report, "complete");
    assertEq(checkpoint.reportAvailable, true);
    assertEq(checkpoint.contract.state, "unavailable", "oversize input never seals a contract");
    assertEq(checkpoint.usage.modelCalls.used, 0, "zero-purchase refusal keeps a zero-call ledger");
    assertEq(
      await env.EVIDENCE.get(mod.keys.recordKey(runId)),
      null,
      "no RunRecord or QA authority is fabricated",
    );

    const extraction = await env.EVIDENCE.list({
      prefix: mod.keys.k("runs", runId, "extraction"),
      limit: 100,
    });
    const windowKey = extraction.objects
      .map((entry) => entry.key)
      .find((key) => /\/pass-a\/window-01[.]json$/.test(key));
    assert(windowKey, "the zero-purchase refusal is a durable Pass-A unit artifact");
    const artifactText = await (await env.EVIDENCE.get(windowKey)).text();
    assert(!artifactText.includes(WIRE_PRIVATE_SENTINEL), "the durable refusal stores no source/body text");
    const artifact = JSON.parse(artifactText);
    assertEq(artifact.failureStage, "wire-ceiling");
    assertEq(artifact.attempts, 0);
    assertEq(artifact.usages.length, 0);
    assertEq(artifact.blockIds.length, 1, "the refused unit retains its exact source-block count");
    assert(String(artifact.detail).startsWith(WIRE_REASON + ":"));

    const statusResponse = await mod.apiRuns.getStatus(
      new Request("https://fixture.invalid/status"),
      env,
      runId,
    );
    assertEq(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    assert(!statusText.includes(WIRE_PRIVATE_SENTINEL), "private source/body text cannot cross status");
    const status = JSON.parse(statusText);
    assertEq(status.completion.reasonCode, WIRE_REASON);
    assertEq(status.documentReading.state, "stopped");
    assertEq(status.documentReading.failure.reasonCode, WIRE_REASON);
    assertEq(status.documentReading.failure.detail, WIRE_PUBLIC_DETAIL);
    assertEq(
      status.documentReading.lastDurableUnit.sourceContext,
      null,
      "public failure status withholds raw unit context; its counted limitation carries the safe census",
    );
    const statusWireLimitations = status.documentReading.limitations.filter(
      (entry) => entry.code === WIRE_REASON,
    );
    assertEq(statusWireLimitations.length, 1, "status exposes one exact counted wire limitation");
    assertEq(statusWireLimitations[0].count, 1);
    assert(statusWireLimitations[0].detail.includes("no new credential lookup or provider request"));

    const dataResponse = await mod.apiReport.getReportData(
      new Request("https://fixture.invalid/report-data"),
      env,
      runId,
    );
    assertEq(dataResponse.status, 200);
    const dataText = await dataResponse.text();
    assert(!dataText.includes(WIRE_PRIVATE_SENTINEL), "private source/body text cannot cross report JSON");
    const data = JSON.parse(dataText);
    assertEq(data.outcome.reasonCode, WIRE_REASON);
    assertEq(data.outcome.detail, WIRE_PUBLIC_DETAIL);
    assertEq(data.coverage.executionCases.tested, 0);
    assertEq(data.coverage.qaClaims.total, 0);
    assertEq(data.qaResults.findings.length, 0);
    assertEq(data.qaResults.verdicts.length, 0);
    assertEq(data.usage.modelCalls, 0);
    const reportWireLimitations = data.limitations.filter((entry) => entry.code === WIRE_REASON);
    assertEq(reportWireLimitations.length, 1, "report JSON exposes one exact counted wire limitation");
    assertEq(reportWireLimitations[0].count, 1);
    assert(reportWireLimitations[0].detail.includes("no new credential lookup or provider request"));

    const htmlResponse = await mod.apiReport.getReport(
      new Request("https://fixture.invalid/report"),
      env,
      runId,
    );
    assertEq(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert(!html.includes(WIRE_PRIVATE_SENTINEL), "private source/body text cannot cross report HTML");
    assert(html.includes(WIRE_REASON), "HTML keeps the exact machine reason");
    assert(html.includes(WIRE_PUBLIC_DETAIL), "HTML makes the no-new-request boundary explicit");
    assert(html.includes("No survey correctness claim was produced."));

    // Semantic counterproof: if the exact branch in extractionPassRefusal is removed, this
    // same otherwise-valid result becomes the old generic extraction-pass-a-* reason and
    // every exact public assertion above goes red.
    const exactRefusal = mod.workflow.extractionPassRefusal("a", {
      state: "not-evaluated",
      reason: WIRE_REASON,
      detail: WIRE_PRIVATE_SENTINEL,
    });
    const genericRefusal = mod.workflow.extractionPassRefusal("a", {
      state: "not-evaluated",
      reason: "PASS_A_WINDOW_FAILURES",
      detail: WIRE_PRIVATE_SENTINEL,
    });
    assertEq(exactRefusal.reasonCode, WIRE_REASON);
    assert(
      genericRefusal.reasonCode !== exactRefusal.reasonCode,
      "the wire refusal must remain distinguishable from a generic Pass-A failure",
    );
    assertEq(exactRefusal.detail, WIRE_PUBLIC_DETAIL);
    assert(!exactRefusal.detail.includes(WIRE_PRIVATE_SENTINEL));
  });

  test("named refusal publishes real HTML+JSON bytes and only then closes reporting complete", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "valid");
    assertEq(await fixture.env.EVIDENCE.get(mod.keys.recordKey(fixture.runId)), null, "the precondition is no RunRecord");

    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.test, "failed");
    assertEq(finalization.completion.report, "complete");
    assertEq(finalization.reportAvailable, true);

    const loaded = await mod.checkpoint.loadCheckpoint(fixture.env, fixture.runId);
    assertEq(loaded.checkpoint.completion.test, "failed", "reporting never closes or upgrades the test axis");
    assertEq(loaded.checkpoint.completion.reasonCode, REASON, "the named extraction cause survives reporting");
    assertEq(loaded.checkpoint.completion.report, "complete");
    assertEq(loaded.checkpoint.reportAvailable, true);

    const pointer = await mod.publish.readReportPointer(fixture.env, fixture.runId);
    assert(pointer, "reportAvailable requires an atomic current-report pointer");
    const rawPointerObject = await fixture.env.EVIDENCE.get(mod.keys.reportPointerKey(fixture.runId));
    assert(rawPointerObject, "the normal current.json pointer key must hold real bytes");
    const rawPointer = JSON.parse(await rawPointerObject.text());
    assertEq(rawPointer.buildId, pointer.buildId);
    assertEq(pointer.final, false);
    assertEq(pointer.judgement.state, "absent");
    const htmlObject = await fixture.env.EVIDENCE.get(pointer.artifacts.html.key);
    const dataObject = await fixture.env.EVIDENCE.get(pointer.artifacts.data.key);
    assert(htmlObject && dataObject, "both immutable artifacts named by the pointer must exist");
    const htmlBytes = new Uint8Array(await htmlObject.arrayBuffer());
    const dataBytes = new Uint8Array(await dataObject.arrayBuffer());
    assertEq(htmlBytes.byteLength, pointer.artifacts.html.bytes);
    assertEq(dataBytes.byteLength, pointer.artifacts.data.bytes);
    assertEq(await mod.hash.sha256Hex(htmlBytes), pointer.artifacts.html.sha256);
    assertEq(await mod.hash.sha256Hex(dataBytes), pointer.artifacts.data.sha256);

    const htmlResponse = await mod.apiReport.getReport(new Request("https://fixture.invalid/"), fixture.env, fixture.runId);
    assertEq(htmlResponse.status, 200);
    assertEq(htmlResponse.headers.get("x-report-final"), "false");
    const html = await htmlResponse.text();
    assert(html.includes("No survey correctness claim was produced."));
    assert(html.includes(REASON));
    assert(html.includes("<strong>1 of 4</strong>"));
    assert(html.includes("<strong>3</strong> were unread/not covered"));
    assert(html.includes("Artifacts for this run are permanent"));

    const dataResponse = await mod.apiReport.getReportData(new Request("https://fixture.invalid/"), fixture.env, fixture.runId);
    assertEq(dataResponse.status, 200);
    const data = await dataResponse.json();
    assertEq(data.kind, "survey-qa-v2-operational-failure-report");
    assertEq(data.reportClass, "operational-failure-no-qa-results");
    assertEq(data.source.documentSha256Authority, "declared-by-envelope-not-recomputed");
    assertEq(data.source.storedBytesAuthority, "r2-head-metadata");
    assertEq(data.coverage.executionCases.tested, 0);
    assertEq(data.coverage.executionCases.total, null);
    assertEq(data.coverage.executionCases.uncovered.state, "unknown");
    assertEq(data.coverage.executionCases.uncovered.count, null);
    assertEq(data.coverage.qaClaims.total, 0);
    assertEq(data.qaResults.findings.length, 0);
    assertEq(data.qaResults.verdicts.length, 0);
    assertEq(data.usage.modelCalls, 1);
    assertEq(data.usage.authority, "validated-checkpoint-usage-ledger");
    assert(!Object.hasOwn(data.usage, "events"), "raw model-call receipt detail is not a public report field");
    assert(!Object.hasOwn(data.usage, "checkpointTotals"), "the unprojected checkpoint ledger is not public");
    assertEq(data.documentReading.state, "stopped");
    assertEq(data.documentReading.primary.total, 4);
    assertEq(data.documentReading.primary.landed, 1);
    assertEq(data.documentReading.primary.remaining, 3);
    assertEq(data.documentReading.usage.modelCalls, 1);
    assertEq(data.documentReading.retention.artifacts, "permanent");
    assertEq(data.documentReading.lastDurableUnit.sourceContext, null);
    assertEq(data.extractionEvidence.total, 1);
    assertEq(data.extractionEvidence.inspected, 1);
    assert(data.extractionEvidence.receiptBinding.startsWith("complete:"));
    assert(data.limitations.some((entry) => entry.code === "contract-denominator-unavailable" && entry.count === 1));

    const envelope = await mod.envelope.getEnvelope(fixture.env, fixture.runId);
    assertEq(envelope.finalCompletion.report, "complete", "the durable envelope mirrors the real published outcome");
  });

  test("NEGATIVE: malformed reading progress publishes named unavailable, never fake zero progress", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "valid");
    await mod.checkpoint.updateCheckpoint(fixture.env, fixture.runId, (draft) => {
      draft.documentReading.primary.undeclaredShortcut = "must-not-pass";
    }, { progressed: true, fence: fixture.fence });

    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.report, "complete", "bad visibility metadata must not erase valid operational evidence");
    const dataResponse = await mod.apiReport.getReportData(
      new Request("https://fixture.invalid/report-data"), fixture.env, fixture.runId,
    );
    const data = await dataResponse.json();
    assertEq(data.documentReading.state, "unavailable");
    assertEq(data.documentReading.primary.total, null, "malformed 4 cannot remain a claimed denominator");
    assertEq(data.documentReading.primary.remaining, null, "unknown unread is not zero unread");
    assert(data.documentReading.limitations.some((entry) =>
      entry.code === "document-reading-progress-invalid" && entry.count === 1));
    const html = await (await mod.apiReport.getReport(
      new Request("https://fixture.invalid/report"), fixture.env, fixture.runId,
    )).text();
    assert(html.includes("Durable reading progress is unavailable. This is not zero progress"));
    assert(!html.includes("<strong>0 of 0</strong>"));
  });

  for (const [label, evidenceState, reasonCode] of [
    ["malformed retained artifact", "malformed", "failure-report-extraction-evidence-invalid"],
    ["paid usage with no retained artifact", "missing", "failure-report-extraction-evidence-missing"],
    ["artifact receipt not present in the charged ledger", "mismatch", "failure-report-extraction-usage-disagreement"],
  ]) {
    test(`NEGATIVE: ${label} fails honestly and publishes no pointer`, async () => {
      const mod = await worker();
      const fixture = await refusalFixture(mod, evidenceState);
      const finalization = await finalize(mod, fixture);
      assertEq(finalization.completion.test, "failed");
      assertEq(finalization.completion.report, "failed");
      assertEq(finalization.reportAvailable, false);
      const checkpoint = (await mod.checkpoint.loadCheckpoint(fixture.env, fixture.runId)).checkpoint;
      assertEq(checkpoint.completion.report, "failed");
      assertEq(checkpoint.reportAvailable, false);
      const reporting = checkpoint.phases.find((phase) => phase.name === "reporting");
      assertEq(reporting.reasonCode, reasonCode);
      assertEq(await mod.publish.readReportPointer(fixture.env, fixture.runId), null);
      const response = await mod.apiReport.getReport(new Request("https://fixture.invalid/"), fixture.env, fixture.runId);
      assertEq(response.status, 200);
      const operational = await response.json();
      assertEq(operational.state, "no-final-report");
      assertEq(operational.final, false);
    });
  }

  test("NEGATIVE: report-failed with no pointer never returns raw checkpoint error prose", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "malformed");
    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.report, "failed");
    assertEq(await mod.publish.readReportPointer(fixture.env, fixture.runId), null);
    const sentinel = "RAW_REPORT_FAILED_CHECKPOINT_SENTINEL_DO_NOT_EXPOSE";
    await mod.checkpoint.updateCheckpoint(fixture.env, fixture.runId, (draft) => {
      draft.error = sentinel;
      draft.failure = {
        step: "report",
        reasonCode: REASON,
        kind: "ModelCallError",
        message: sentinel,
        at: "2026-08-14T00:00:01.000Z",
      };
    }, { progressed: true, fence: fixture.fence });

    const response = await mod.apiReport.getReport(
      new Request("https://fixture.invalid/report"), fixture.env, fixture.runId,
    );
    assertEq(response.status, 200);
    const text = await response.text();
    assert(!text.includes(sentinel), "no-pointer fallback must never copy checkpoint error/failure prose");
    const operational = JSON.parse(text);
    const fixed = mod.documentReading.publicExtractionFailureDetail(REASON);
    assertEq(operational.state, "no-final-report");
    assertEq(operational.message, fixed);
    assertEq(operational.error, fixed);
  });

  test("NEGATIVE: a checkpoint with executed coverage cannot publish a zero-tested report", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "valid");
    await mod.checkpoint.updateCheckpoint(fixture.env, fixture.runId, (draft) => {
      draft.counts.exercised = 1;
    }, { progressed: true, fence: fixture.fence });

    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.test, "failed");
    assertEq(finalization.completion.report, "failed");
    assertEq(finalization.reportAvailable, false);
    const checkpoint = (await mod.checkpoint.loadCheckpoint(fixture.env, fixture.runId)).checkpoint;
    const reporting = checkpoint.phases.find((phase) => phase.name === "reporting");
    assertEq(reporting.reasonCode, "failure-report-not-authorized");
    assertEq(await mod.publish.readReportPointer(fixture.env, fixture.runId), null);
  });

  test("NEGATIVE: an unexpected zero bucket is not the exact coverage-bucket schema", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "valid");
    // The ordinary writer already rejects this. Corrupt the retained bytes directly to
    // prove the report's read-side guard cannot be bypassed by an old/hand-edited object.
    const checkpointKey = mod.keys.checkpointKey(fixture.runId);
    const checkpointObject = await fixture.env.EVIDENCE.get(checkpointKey);
    const corrupted = JSON.parse(await checkpointObject.text());
    corrupted.counts["invented-zero-bucket"] = 0;
    await fixture.env.EVIDENCE.put(checkpointKey, JSON.stringify(corrupted));

    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.report, "failed");
    assertEq(finalization.reportAvailable, false);
    const checkpoint = (await mod.checkpoint.loadCheckpoint(fixture.env, fixture.runId)).checkpoint;
    const reporting = checkpoint.phases.find((phase) => phase.name === "reporting");
    assertEq(reporting.reasonCode, "failure-report-not-authorized");
    assertEq(await mod.publish.readReportPointer(fixture.env, fixture.runId), null);
  });

  test("NEGATIVE: pre-existing execution activity cannot publish a zero-tested report", async () => {
    const mod = await worker();
    const fixture = await refusalFixture(mod, "valid");
    await mod.checkpoint.updateCheckpoint(fixture.env, fixture.runId, (draft) => {
      draft.usage.toolCalls.used = 1;
    }, { progressed: true, fence: fixture.fence });

    const finalization = await finalize(mod, fixture);
    assertEq(finalization.completion.report, "failed");
    assertEq(finalization.reportAvailable, false);
    const checkpoint = (await mod.checkpoint.loadCheckpoint(fixture.env, fixture.runId)).checkpoint;
    const reporting = checkpoint.phases.find((phase) => phase.name === "reporting");
    assertEq(reporting.reasonCode, "failure-report-not-authorized");
    assertEq(await mod.publish.readReportPointer(fixture.env, fixture.runId), null);
  });
});
