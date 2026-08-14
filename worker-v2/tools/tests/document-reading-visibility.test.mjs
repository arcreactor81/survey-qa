/**
 * The watch page may say only what durable extraction units prove. These tests pin the
 * closed status contract and include counterexamples that would otherwise turn corrupt
 * arithmetic or an undeclared field into plausible-looking progress.
 */

import { strToU8, zipSync } from "fflate";
import { assert, assertEq, assertThrows, fakeStep, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const AT = "2026-08-14T04:32:10.000Z";
const HISTORICAL_PROMPT = "v2-extract-pass-a/1.6.0";
const HISTORICAL_DETAIL_SENTINEL = "RAW_HISTORICAL_PASS_A_DETAIL_DO_NOT_EXPOSE";
const HISTORICAL_REASON = "extraction-pass-a-pass-a-window-failures";

const neutralElevenWindowDocx = () => zipSync({
  "word/document.xml": strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      Array.from({ length: 33 }, (_, index) =>
        `<w:p><w:r><w:t>Neutral questionnaire source block ${String(index + 1).padStart(2, "0")}</w:t></w:r></w:p>`,
      ).join("") +
      `</w:body></w:document>`,
  ),
}, { mtime: AT });

function historicalUsage(runId, windowNumber, status = "ok") {
  const unit = `A-w${windowNumber}`;
  return {
    eventId: `core-model-call/pass-a/${runId}/${unit}/issue-1/receipt-1`,
    callId: `call_a_${windowNumber}`,
    role: `extract-pass-a-w${windowNumber}`,
    provider: "grok",
    model: "grok-4.6",
    status,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.001,
    latencyMs: 25,
    attempts: 1,
    usageSource: "provider-reported",
  };
}

function historicalWindowIdentity(mod, env, doc, runId, windowNumber, promptVersion) {
  return {
    windowId: `A-w${windowNumber}`,
    windowNumber,
    blockIds: doc.blocks
      .slice((windowNumber - 1) * 3, windowNumber * 3)
      .map((block) => block.blockId),
    parserVersion: doc.parserVersion,
    promptVersion,
    providerRouteIdentity: mod.grok.grokFlashRouteIdentity(env),
    windowPolicyIdentity: "pass-a-window-policy/1.1.0|chars:999999|blocks:3|max-issues:2",
  };
}

function historicalSuccess(mod, env, doc, runId, windowNumber, promptVersion) {
  return {
    ...historicalWindowIdentity(mod, env, doc, runId, windowNumber, promptVersion),
    attempts: 1,
    modelOutput: {
      global_rules: [],
      cross_references: [],
      ambiguities: [],
      unverifiable_from_browser: [],
    },
    kind: "ok",
    globalRules: [],
    crossRefs: [],
    ambiguities: [],
    unverifiable: [],
    primaryGroundingLimitations: [],
    usages: [historicalUsage(runId, windowNumber)],
    routeReceipt: { selected: "grok-4.6", trigger: null },
  };
}

function historicalTerminalFailure(mod, env, doc, runId, windowNumber, promptVersion) {
  return {
    ...historicalWindowIdentity(mod, env, doc, runId, windowNumber, promptVersion),
    status: "failed",
    attempts: 1,
    usages: [historicalUsage(runId, windowNumber, "parse-failed")],
    fallbackTrigger: null,
    terminal: true,
    failureStage: "semantic-output",
    detail: HISTORICAL_DETAIL_SENTINEL,
    modelOutput: {
      global_rules: "malformed-terminal-fixture",
      cross_references: [],
      ambiguities: [],
      unverifiable_from_browser: [],
    },
  };
}

async function historicalReadingFixture(mod, { promptVersion, mutate = null }) {
  const env = testEnv({
    EXTRACT_PASS_A_WINDOW_CHARS: "999999",
    EXTRACT_PASS_A_WINDOW_MAX_BLOCKS: "3",
    EXTRACT_PASS_A_WINDOW_MAX_ISSUES: "2",
  });
  const documentBytes = neutralElevenWindowDocx();
  const documentSha256 = await mod.hash.sha256Hex(documentBytes);
  const documentKey = "fixtures/neutral-eleven-window-questionnaire.docx";
  const seeded = await seedRun(mod, env, { documentKey, documentSha256 });
  await env.EVIDENCE.put(documentKey, documentBytes, {
    httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  });
  const doc = mod.docxBlocks.parseDocxBlocks(documentBytes);
  assertEq(doc.blocks.length, 33, "33 neutral blocks form exactly 11 three-block windows");

  const artifacts = new Map([
    [1, historicalSuccess(mod, env, doc, seeded.runId, 1, promptVersion)],
    [2, historicalSuccess(mod, env, doc, seeded.runId, 2, promptVersion)],
    [3, historicalTerminalFailure(mod, env, doc, seeded.runId, 3, promptVersion)],
  ]);
  if (mutate) mutate({ artifacts, doc, runId: seeded.runId });
  for (const [windowNumber, artifact] of artifacts) {
    await env.EVIDENCE.put(
      mod.keys.k(
        "runs", seeded.runId, "extraction", "pass-a",
        `window-${String(windowNumber).padStart(2, "0")}.json`,
      ),
      JSON.stringify(artifact),
      { httpMetadata: { contentType: "application/json" } },
    );
  }
  await mod.checkpoint.updateCheckpoint(env, seeded.runId, (draft) => {
    mod.checkpoint.setPhase(draft, "extracting", "stopped", HISTORICAL_REASON);
    mod.checkpoint.setPhase(draft, "reporting", "complete");
    draft.phase = "reporting";
    draft.completion.test = "failed";
    draft.completion.report = "complete";
    draft.completion.reasonCode = HISTORICAL_REASON;
    draft.error = HISTORICAL_DETAIL_SENTINEL;
  }, { progressed: true });

  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("a read-only historical status request must not call a model provider");
  };
  try {
    const response = await mod.apiRuns.getStatus(
      new Request(`https://fixture.invalid/api/v2/runs/${seeded.runId}/status`),
      env,
      seeded.runId,
    );
    const text = await response.text();
    return { response, text, body: JSON.parse(text), providerRequests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function usage() {
  return { modelCalls: { used: 3 }, cost: { usedUsd: 0.548308 } };
}

function stoppedProgress(mod) {
  const sourceContext = mod.documentReading.sourceContextForUnit([
    { blockId: "b0201", kind: "heading", text: "Participant cohort" },
    { blockId: "b0202", kind: "paragraph", text: "Use the cohort answer from the questionnaire." },
  ], ["b0201", "b0202"]);
  return mod.documentReading.withCheckpointUsage(
    mod.documentReading.readingFromPrimary({
      done: false,
      windowsTotal: 11,
      windowsLanded: 3,
      windowsRemaining: 8,
      terminalFailure: true,
      synthesisState: "waiting-for-windows",
    }, {
      state: "stopped",
      failedUnit: { unit: "A-w3", detail: "target_doc_quote is absent or not exact" },
      sourceContext,
      reasonCode: "PASS_A_WINDOW_OUTPUT_UNGROUNDED",
      updatedAt: AT,
    }),
    usage(),
  );
}

suite("durable questionnaire-reading visibility", () => {
  test("3 of 11, A-w3, 8 unread, usage and permanent retention reach status", async () => {
    const mod = await worker();
    const env = testEnv();
    const { cp } = await (async () => {
      const seeded = await seedRun(mod, env);
      const loaded = await mod.checkpoint.loadCheckpoint(env, seeded.runId);
      return { cp: loaded.checkpoint };
    })();
    cp.documentReading = stoppedProgress(mod);

    const status = mod.contracts.projectStatus(cp, AT);
    const reading = status.documentReading;
    assert(reading, "an explicitly stored reading must be projected");
    assertEq(reading.state, "stopped");
    assertEq(reading.stage, "primary-windows");
    assertEq(reading.primary.total, 11);
    assertEq(reading.primary.landed, 3);
    assertEq(reading.primary.remaining, 8);
    assertEq(reading.lastDurableUnit.name, "A-w3");
    assertEq(reading.failure.unit, "A-w3");
    assertEq(reading.failure.reasonCode, "PASS_A_WINDOW_OUTPUT_UNGROUNDED");
    assertEq(reading.failure.detail, "A document-reading result failed exact source grounding.");
    assertEq(reading.usage.authority, "checkpoint-usage-ledger");
    assertEq(reading.usage.modelCalls, 3);
    assertEq(reading.usage.costUsd, 0.548308);
    assertEq(reading.retention.artifacts, "permanent");
    assertEq(reading.retention.runIsolation, "dedicated-run-id");
    // Public status currently withholds document text/block identifiers. This assertion
    // fails if an internal source excerpt accidentally crosses the status boundary.
    assertEq(reading.lastDurableUnit.sourceContext, null);
  });

  test("counterproof: unreconciled primary arithmetic becomes named unavailable, not zero", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    const corrupt = structuredClone(stoppedProgress(mod));
    corrupt.primary.remaining = 7;
    cp.documentReading = corrupt;

    const reading = mod.contracts.projectStatus(cp, AT).documentReading;
    assertEq(reading.state, "unavailable");
    assertEq(reading.primary.total, null, "corrupt 11 must not remain a claimed denominator");
    assertEq(reading.primary.remaining, null, "unknown unread is not zero unread");
    assert(reading.limitations.some((row) => row.code === "document-reading-progress-invalid" && row.count === 1));
  });

  test("semantic mutant counterproof: an undeclared nested field closes the whole shape", async () => {
    const mod = await worker();
    const progress = structuredClone(stoppedProgress(mod));
    progress.primary.corpusShortcut = "qcohort";
    const projected = mod.documentReading.projectDocumentReadingProgress(progress);
    assertEq(projected.state, "unavailable");
    assertEq(projected.primary.total, null);
    assert(
      projected.limitations[0].detail.includes("does not reconcile"),
      "an extra field must be detected by the closed primary schema",
    );
  });

  test("malformed reading cannot reopen raw extraction error, failure or heartbeat prose", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const sentinel = "RAW_MALFORMED_READING_CHECKPOINT_SENTINEL_DO_NOT_EXPOSE";
    const reasonCode = "extraction-pass-b-pass-b-unit-failures";
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (draft) => {
      const corrupt = structuredClone(stoppedProgress(mod));
      corrupt.primary.undeclaredProviderField = sentinel;
      draft.documentReading = corrupt;
      mod.checkpoint.setPhase(draft, "extracting", "stopped", reasonCode);
      draft.completion.test = "failed";
      draft.completion.report = "failed";
      draft.completion.reasonCode = reasonCode;
      draft.error = sentinel;
      draft.failure = {
        step: "extract-pass-b-wave-1",
        reasonCode,
        kind: "ModelCallError",
        message: sentinel,
        at: AT,
      };
    }, { progressed: true });
    await mod.checkpoint.beat(env, seeded.runId, sentinel, "extract-b-refused");

    const response = await mod.apiRuns.getStatus(
      new Request(`https://fixture.invalid/api/v2/runs/${seeded.runId}/status`),
      env,
      seeded.runId,
    );
    const text = await response.text();
    assert(!text.includes(sentinel), "malformed reading must not make raw checkpoint prose public");
    const status = JSON.parse(text);
    const fixed = mod.documentReading.publicExtractionFailureDetail(reasonCode);
    assertEq(status.documentReading.state, "unavailable");
    assertEq(status.error, fixed);
    assertEq(status.failure.message, fixed);
    assertEq(status.heartbeatNote, fixed);
  });

  test("a legacy stopped-extraction workflow error is public-safe without reclassifying other workflow errors", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    const sentinel = "RAW_LEGACY_EXTRACTION_WORKFLOW_ERROR_DO_NOT_EXPOSE";
    const cp = (await mod.checkpoint.loadCheckpoint(env, seeded.runId)).checkpoint;
    mod.checkpoint.setPhase(cp, "extracting", "stopped", "workflow-error");
    cp.completion.test = "failed";
    cp.completion.report = "failed";
    cp.completion.reasonCode = "workflow-error";
    cp.error = sentinel;
    cp.failure = {
      step: "extract-pass-a-wave-1",
      reasonCode: "workflow-error",
      kind: "Error",
      message: sentinel,
      at: AT,
    };

    const status = mod.contracts.projectStatus(cp, AT, sentinel);
    const fixed = mod.documentReading.publicExtractionFailureDetail("workflow-error");
    assert(!JSON.stringify(status).includes(sentinel));
    assertEq(status.error, fixed);
    assertEq(status.failure.message, fixed);
    assertEq(status.heartbeatNote, fixed);

    const other = structuredClone(cp);
    other.phases = other.phases.filter((phase) => phase.name !== "extracting");
    mod.checkpoint.setPhase(other, "verifying", "stopped", "workflow-error");
    other.error = "ordinary verification workflow error";
    other.failure.message = "ordinary verification workflow error";
    const otherStatus = mod.contracts.projectStatus(other, AT, null);
    assertEq(otherStatus.error, "ordinary verification workflow error");
    assertEq(otherStatus.failure.message, "ordinary verification workflow error");
  });

  test("a cached replay cannot regress landed progress while naming the unit now inspected", async () => {
    const mod = await worker();
    const prior = stoppedProgress(mod);
    const event = {
      stage: "primary-windows",
      unit: {
        kind: "window",
        name: "A-w1",
        ordinal: 1,
        total: 11,
        sourceContext: null,
      },
      primary: {
        total: 11,
        landed: 0,
        remaining: 11,
        synthesisState: "waiting-for-windows",
      },
      secondary: null,
    };
    const next = mod.documentReading.readingAtUnitStart(prior, event, usage(), AT);
    assertEq(next.state, "reading");
    assertEq(next.currentUnit.name, "A-w1");
    assertEq(next.primary.landed, 3, "reclaim inspection must not move 3 durable windows back to zero");
    assertEq(next.primary.remaining, 8);
    assertEq(next.lastDurableUnit.name, "A-w3");
  });

  test("Pass-B churn follows durable authorization order while preserving peak observed concurrency", async () => {
    const mod = await worker();
    let progress = mod.documentReading.withCheckpointUsage(
      mod.documentReading.readingFromPrimary({
        done: true,
        windowsTotal: 2,
        windowsLanded: 2,
        windowsRemaining: 0,
        terminalFailure: false,
        synthesisState: "ok",
      }, { state: "reading", updatedAt: AT }),
      usage(),
    );
    const start = (ordinal, concurrentUnitsInFlight) => ({
      stage: "secondary-chunks",
      unit: {
        kind: "chunk",
        name: `C0${ordinal}-block-${ordinal}`,
        ordinal,
        total: 5,
        sourceContext: null,
      },
      primary: null,
      secondary: { total: 5, landed: 0, remaining: 5, sweepRemaining: null },
      concurrentUnitsInFlight,
    });
    progress = mod.documentReading.readingAtUnitStart(progress, start(1, 1), usage(), AT);
    progress = mod.documentReading.readingAtUnitStart(progress, start(2, 2), usage(), AT);
    progress = mod.documentReading.readingAtUnitStart(progress, start(3, 3), usage(), AT);
    assertEq(progress.currentUnit.name, "C03-block-3", "the singular field is the latest start, not the only active unit");
    const limitation = progress.limitations.find((entry) =>
      entry.code === "concurrent-reading-units-not-individually-listed");
    assert(limitation, "concurrent scheduling must be named rather than hidden");
    assertEq(limitation.count, 2, "two other units were exactly observed in flight at the third start");

    progress = mod.documentReading.readingAtUnitStart(progress, start(4, 2), usage(), AT);
    assertEq(progress.currentUnit.name, "C04-block-4", "a genuine later start wins even after peak concurrency falls");
    assertEq(progress.limitations.find((entry) => entry.code === limitation.code).count, 2);

    progress = mod.documentReading.readingAtUnitStart(progress, start(2, 2), usage(), AT);
    assertEq(progress.currentUnit.name, "C02-block-2",
      "a replay callback that commits later is truthfully the next authorized start");
    assertEq(progress.limitations.find((entry) => entry.code === limitation.code).count, 2);
  });

  test("source preview is exact-bound, bounded and null when any block id is unbound", async () => {
    const mod = await worker();
    const blocks = [
      { blockId: "b1", kind: "heading", text: "Cohort setup" },
      { blockId: "b2", kind: "paragraph", text: "Continue at https://private.invalid/path" },
    ];
    const context = mod.documentReading.sourceContextForUnit(blocks, ["b1", "b2"]);
    assertEq(context.blockCount, 2);
    assertEq(context.firstBlockId, "b1");
    assertEq(context.lastBlockId, "b2");
    assertEq(context.label, "Cohort setup");
    assert(context.preview.includes("Cohort setup"));
    assert(context.preview.includes("[url]"), "raw URLs must not survive bounded source copy");
    assert(!context.preview.includes("private.invalid"));
    assertEq(mod.documentReading.sourceContextForUnit(blocks, ["b1", "missing"]), null);
  });

  test("the real status endpoint serves the optional object and a legacy run stays byte-compatible", async () => {
    const mod = await worker();
    const env = testEnv();
    const seeded = await seedRun(mod, env);
    await mod.checkpoint.updateCheckpoint(env, seeded.runId, (draft) => {
      draft.documentReading = stoppedProgress(mod);
    }, { progressed: true });
    const response = await mod.apiRuns.getStatus(
      new Request(`https://fixture.invalid/api/v2/runs/${seeded.runId}/status`),
      env,
      seeded.runId,
    );
    assertEq(response.status, 200);
    const body = await response.json();
    assertEq(body.documentReading.primary.landed, 3);
    assertEq(body.documentReading.failure.unit, "A-w3");
    assert(response.headers.get("etag"), "a status snapshot must remain cacheable by revision");

    const legacyEnv = testEnv();
    const legacy = await seedRun(mod, legacyEnv);
    const legacyResponse = await mod.apiRuns.getStatus(
      new Request(`https://fixture.invalid/api/v2/runs/${legacy.runId}/status`),
      legacyEnv,
      legacy.runId,
    );
    const legacyBody = await legacyResponse.json();
    assert(!Object.hasOwn(legacyBody, "documentReading"), "no stored/extraction facts means the optional field stays omitted");
  });

  test("a stopped extraction reconstructs after reporting while a later test failure does not", async () => {
    const mod = await worker();
    const stoppedEnv = testEnv();
    const stopped = await seedRun(mod, stoppedEnv);
    await mod.checkpoint.updateCheckpoint(stoppedEnv, stopped.runId, (draft) => {
      mod.checkpoint.setPhase(draft, "extracting", "stopped", "PASS_A_WINDOW_FAILURES");
      mod.checkpoint.setPhase(draft, "reporting", "complete");
      draft.phase = "reporting";
      draft.completion.test = "failed";
      draft.completion.report = "complete";
      draft.completion.reasonCode = "PASS_A_WINDOW_FAILURES";
    }, { progressed: true });
    const stoppedResponse = await mod.apiRuns.getStatus(
      new Request("https://fixture.invalid/api/v2/runs/" + stopped.runId + "/status"),
      stoppedEnv,
      stopped.runId,
    );
    const stoppedBody = await stoppedResponse.json();
    assertEq(stoppedResponse.status, 200);
    assertEq(
      stoppedBody.documentReading.state,
      "unavailable",
      "a terminal extraction remains visible after the workflow advances to reporting",
    );
    assert(
      stoppedBody.documentReading.limitations.some(
        (entry) => entry.code === "document-reading-partition-unavailable",
      ),
      "missing legacy artifacts are named rather than silently omitting the reading card",
    );

    const laterEnv = testEnv();
    const later = await seedRun(mod, laterEnv);
    await mod.checkpoint.updateCheckpoint(laterEnv, later.runId, (draft) => {
      mod.checkpoint.setPhase(draft, "extracting", "complete");
      mod.checkpoint.setPhase(draft, "reporting", "complete");
      draft.phase = "reporting";
      draft.completion.test = "failed";
      draft.completion.report = "complete";
      draft.completion.reasonCode = "execution-test-failed";
    }, { progressed: true });
    const laterResponse = await mod.apiRuns.getStatus(
      new Request("https://fixture.invalid/api/v2/runs/" + later.runId + "/status"),
      laterEnv,
      later.runId,
    );
    const laterBody = await laterResponse.json();
    assert(
      !Object.hasOwn(laterBody, "documentReading"),
      "a later browser-test failure must not be relabeled as a document-reading failure",
    );
  });

  test("historical stale-prompt artifacts surface retained 3/11 progress without semantic reuse", async () => {
    const mod = await worker();
    const result = await historicalReadingFixture(mod, { promptVersion: HISTORICAL_PROMPT });
    assertEq(result.response.status, 200);
    assertEq(result.providerRequests, 0, "status reconstruction is read-only and cannot rebuy a document read");
    assert(!result.text.includes(HISTORICAL_DETAIL_SENTINEL), "retained raw failure prose cannot cross status");
    const reading = result.body.documentReading;
    assertEq(reading.state, "stopped");
    assertEq(reading.primary.total, 11);
    assertEq(reading.primary.landed, 3);
    assertEq(reading.primary.remaining, 8);
    assertEq(reading.lastDurableUnit.name, "A-w3");
    assertEq(reading.failure.unit, "A-w3");
    assert(
      reading.limitations.some((entry) =>
        entry.code === mod.passA.PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE &&
        entry.count === 1),
      "metadata-only historical progress must carry its named observability limitation",
    );
  });

  for (const [label, mutate] of [
    [
      "gap before the terminal artifact",
      ({ artifacts }) => { artifacts.delete(2); },
    ],
    [
      "wrong canonical block ownership",
      ({ artifacts, doc }) => { artifacts.get(2).blockIds[1] = doc.blocks[20].blockId; },
    ],
    [
      "ordered interior block swap",
      ({ artifacts }) => {
        const ids = artifacts.get(2).blockIds;
        [ids[1], ids[2]] = [ids[2], ids[1]];
      },
    ],
    [
      "receipt owned by a foreign run",
      ({ artifacts }) => {
        artifacts.get(2).usages[0].eventId =
          "core-model-call/pass-a/run_foreign/A-w2/issue-1/receipt-1";
      },
    ],
    [
      "receipt owned by a foreign window",
      ({ artifacts, runId }) => {
        artifacts.get(2).usages[0].eventId =
          `core-model-call/pass-a/${runId}/A-w9/issue-1/receipt-1`;
      },
    ],
  ]) {
    test(`counterproof: historical ${label} fails closed instead of guessing partial progress`, async () => {
      const mod = await worker();
      const result = await historicalReadingFixture(mod, { promptVersion: HISTORICAL_PROMPT, mutate });
      assertEq(result.response.status, 200);
      assertEq(result.providerRequests, 0);
      assert(!result.text.includes(HISTORICAL_DETAIL_SENTINEL));
      const reading = result.body.documentReading;
      assertEq(reading.state, "unavailable");
      assertEq(reading.primary.total, null, "an invalid census cannot retain the tempting denominator 11");
      assertEq(
        reading.primary.landed,
        0,
        "the unavailable contract's zero sentinel carries no progress authority from rows before corruption",
      );
      assertEq(reading.primary.remaining, null, "unknown unread work is not zero or an inferred remainder");
      assert(
        !reading.limitations.some((entry) =>
          entry.code === mod.passA.PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE),
        "the positive historical census limitation cannot bless an invalid census",
      );
    });
  }

  test("current-prompt terminal authority remains on the strict reconstruction path", async () => {
    const mod = await worker();
    const result = await historicalReadingFixture(mod, { promptVersion: mod.passA.PASS_A_VERSION });
    assertEq(result.response.status, 200);
    assertEq(result.providerRequests, 0);
    assert(!result.text.includes(HISTORICAL_DETAIL_SENTINEL));
    const reading = result.body.documentReading;
    assertEq(reading.state, "stopped");
    assertEq(reading.primary.total, 11);
    assertEq(reading.primary.landed, 3);
    assertEq(reading.primary.remaining, 8);
    assertEq(reading.failure.unit, "A-w3");
    assert(
      !reading.limitations.some((entry) =>
        entry.code === mod.passA.PASS_A_HISTORICAL_PROGRESS_CENSUS_LIMITATION_CODE),
      "current-identity strict evidence must not be relabeled as a legacy metadata census",
    );
  });

  test("INTEGRATED CRASH: a durable current unit is stopped and named before any artifact exists", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const documentKey = mod.keys.inputDocumentKey(runId);
    const documentBytes = new TextEncoder().encode("neutral questionnaire bytes");
    const documentSha256 = await mod.hash.sha256Hex(documentBytes);
    await env.EVIDENCE.put(documentKey, documentBytes, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
    await mod.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: AT,
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
    await mod.checkpoint.updateCheckpoint(env, runId, (draft) => {
      mod.checkpoint.setPhase(draft, "extracting", "active");
      const base = mod.documentReading.withCheckpointUsage(
        mod.documentReading.readingFromPrimary({
          done: false,
          windowsTotal: 11,
          windowsLanded: 0,
          windowsRemaining: 11,
          terminalFailure: false,
          synthesisState: "waiting-for-windows",
        }, { state: "reading", updatedAt: draft.observedAt }),
        draft.usage,
      );
      draft.documentReading = mod.documentReading.readingAtUnitStart(base, {
        stage: "primary-windows",
        unit: { kind: "window", name: "A-w1", ordinal: 1, total: 11, sourceContext: null },
        primary: {
          total: 11,
          landed: 0,
          remaining: 11,
          synthesisState: "waiting-for-windows",
        },
        secondary: null,
      }, draft.usage, draft.observedAt);
    }, { progressed: true });

    const sentinel = "RAW_PROVIDER_BODY_SENTINEL_DO_NOT_EXPOSE";
    const crash = `provider failed with body ${sentinel}`;
    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    globalThis.fetch = async () => {
      providerRequests += 1;
      throw new Error("the crash fixture must not buy or rebuy a provider call");
    };
    try {
      await assertThrows(
        () => new mod.workflow.SurveyRunWorkflowV2({}, env).run({
          payload: {
            runId,
            surveyUrl: "https://fixture.invalid/survey",
            documentKey,
            documentSha256,
            profile: "standard",
            locale: "en",
            viewports: ["desktop"],
          },
        }, fakeStep({ throwOn: { "resume-durable-state": new Error(crash) } })),
        crash,
        "the original workflow crash must still propagate to the engine",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const extraction = await env.EVIDENCE.list({
      prefix: mod.keys.k("runs", runId, "extraction"),
      limit: 100,
    });
    assertEq(extraction.objects.length, 0, "the fixture really crashes before an extraction artifact lands");
    assertEq(providerRequests, 0, "failure reporting cannot buy or rebuy a document read");
    const checkpoint = (await mod.checkpoint.loadCheckpoint(env, runId)).checkpoint;
    assertEq(checkpoint.documentReading.state, "stopped", "the top-level failure commit must end reading");
    assertEq(checkpoint.documentReading.currentUnit, null, "a terminal run cannot retain an active unit");
    assertEq(checkpoint.documentReading.failure.unit, "A-w1", "the exact in-flight serial unit survives as the failed unit");
    assertEq(checkpoint.documentReading.failure.reasonCode, "extraction-unit-crashed");
    assertEq(checkpoint.documentReading.primary.landed, 0, "selected A-w1 is not falsely credited as landed");
    assertEq(checkpoint.documentReading.primary.remaining, 11);
    assertEq(checkpoint.completion.reasonCode, "extraction-unit-crashed");
    assertEq(checkpoint.completion.report, "complete", "the named extraction crash must publish an operational report");
    assertEq(checkpoint.reportAvailable, true);

    const statusResponse = await mod.apiRuns.getStatus(new Request("https://fixture.invalid/status"), env, runId);
    const statusText = await statusResponse.text();
    assert(!statusText.includes(sentinel), "raw provider bodies must not cross the status wire");
    const status = JSON.parse(statusText);
    assertEq(status.documentReading.failure.unit, "A-w1");
    assertEq(status.documentReading.failure.detail,
      "A document-reading unit stopped because its workflow step failed before a durable result landed.");

    const dataResponse = await mod.apiReport.getReportData(new Request("https://fixture.invalid/report-data"), env, runId);
    const dataText = await dataResponse.text();
    assert(!dataText.includes(sentinel), "raw provider bodies must not cross report-data JSON");
    const data = JSON.parse(dataText);
    assertEq(data.documentReading.failure.unit, "A-w1");
    assertEq(data.documentReading.primary.remaining, 11);
    const htmlResponse = await mod.apiReport.getReport(new Request("https://fixture.invalid/report"), env, runId);
    const html = await htmlResponse.text();
    assert(!html.includes(sentinel), "raw provider bodies must not cross failure-report HTML");
    assert(html.includes("<strong>11</strong> were unread/not covered"));
  });
});
