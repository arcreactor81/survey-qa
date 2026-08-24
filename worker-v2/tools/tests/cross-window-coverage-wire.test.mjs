/**
 * Candidate-only Pass-A reconciliation is useful evidence, but it is not whole-document
 * discovery. This test binds that counted ceiling to exact Pass-A bytes and follows it
 * through the sealed revision, signed-record blocker, test-axis gate, and report.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { contractBody, runRecordV2 } from "../fixtures/v2-fixture.mjs";
import {
  CROSS_WINDOW_DISCOVERY_BLOCKER_KIND,
  contractCrossWindowLimitations,
  crossWindowLimitationSupplement,
  limitationsFromPassAPayload,
} from "../../shared/cross-window-limitations.mjs";
import { evaluateJudgement } from "../../../pipeline/report/lib/judgement-record.mjs";
import { buildReportView } from "../../../pipeline/report/lib/view-model.mjs";
import { renderReportHtml } from "../../../pipeline/report/lib/render-html.mjs";
import {
  KEY_REGISTRY,
  makeItem,
  makeItemResult,
  makeJudged,
  makeJudgementRecord,
  makeRunRecord,
} from "../../../pipeline/report/test/helpers.mjs";

const limitation = {
  kind: "pass-a-cross-window-candidate-dependence",
  windowsTotal: 3,
  candidatesSynthesized: 2,
  candidatesUngrounded: 0,
  sourceEvidenceBlocks: 2,
  sourceEvidenceSpans: 3,
  synthesisAdditions: 1,
  detail:
    "Cross-window reconciliation inspected nominated candidate quote spans, not unsupplied source text.",
};

const completedSlice = (windowsTotal, synthesisState) => ({
  done: true,
  windowsTotal,
  windowsLanded: windowsTotal,
  windowsIssued: 0,
  windowsRemaining: 0,
  terminalFailure: false,
  synthesisState,
  synthesisAttempts: synthesisState === "ok" ? 1 : 0,
  synthesisIssued: 0,
  deadlineHit: false,
});

const multiwindowPayload = (overrides = {}) => ({
  slice: completedSlice(3, "ok"),
  crossWindowLimitations: [limitation],
  primaryGroundingLimitations: [],
  ...overrides,
});

async function storedSupplements(mod, payload, runId) {
  const env = testEnv();
  const body = JSON.stringify(payload);
  const hash = `sha256:${await mod.hash.sha256Hex(body)}`;
  await env.EVIDENCE.put(mod.keys.extractionPassKey(runId, "a"), body);
  return {
    env,
    hash,
    supplements: await mod.crossWindowLimitations.passACrossWindowSupplementsForSeal(
      env,
      runId,
      hash,
    ),
  };
}

function renderedCertification(findings) {
  const record = makeRunRecord({
    items: [makeItem("OBL-1")],
    itemResults: [makeItemResult("OBL-1")],
    findings,
    sealedRevision: true,
  });
  const judgementRecord = makeJudgementRecord(record, [makeJudged("OBL-1")]);
  const judgement = {
    judgementRecord,
    verdicts: null,
    routeTable: null,
    delta: null,
    summary: null,
    path: "cross-window-coverage-wire",
  };
  const trust = evaluateJudgement({
    judgement,
    record,
    keyRegistry: KEY_REGISTRY,
    registryPath: "test",
  });
  const view = buildReportView({
    record,
    attestation: { state: "verified", reason: "test", registryPath: "test" },
    options: {
      judgement,
      judgementTrust: trust,
      generatedAt: "2026-08-14T00:00:00.000Z",
      evidenceAudit: new Map(),
    },
  });
  return { view, html: renderReportHtml(view, { css: "/* test */" }) };
}

suite("Pass-A cross-window discovery ceiling is durable", () => {
  test("retained completion is exact; missing limitation and incomplete primary counts refuse", async () => {
    assertEq(limitationsFromPassAPayload(multiwindowPayload()).length, 1);
    assertEq(
      limitationsFromPassAPayload({
        slice: completedSlice(1, "not-required"),
        crossWindowLimitations: [],
        primaryGroundingLimitations: [],
      }).length,
      0,
      "a completed single-window pass is the explicit zero-limitation control",
    );

    await assertThrows(
      () => limitationsFromPassAPayload(multiwindowPayload({ crossWindowLimitations: [] })),
      "require one matching counted limitation",
    );
    await assertThrows(
      () => limitationsFromPassAPayload(multiwindowPayload({
        slice: { ...completedSlice(3, "ok"), done: false, windowsLanded: 2, windowsRemaining: 1 },
      })),
      "not an exact successful completion",
    );

    const mod = await worker();
    const env = testEnv();
    const incomplete = JSON.stringify(multiwindowPayload({
      slice: { ...completedSlice(3, "ok"), done: false, windowsLanded: 2, windowsRemaining: 1 },
    }));
    const hash = `sha256:${await mod.hash.sha256Hex(incomplete)}`;
    await env.EVIDENCE.put(mod.keys.extractionPassKey("run_incomplete", "a"), incomplete);
    await assertThrows(
      () => mod.crossWindowLimitations.passACrossWindowSupplementsForSeal(
        env,
        "run_incomplete",
        hash,
      ),
      "not an exact successful completion",
      "the pre-Pass-B keyed read must reject an incomplete retained payload",
    );

    const retainedBase = {
      parserVersion: mod.docxBlocks.DOCX_BLOCKS_VERSION,
      promptVersion: mod.passA.PASS_A_VERSION,
      provider: "xai",
      model: "fixture",
      providerRouteIdentity: mod.grok.grokFlashRouteIdentity(env),
      providerIndependence: "independent",
      requirements: [],
      failedUnits: [],
      calls: [],
      fallbackTriggers: [],
      routeReceipts: [],
    };
    const summaryOnly = JSON.stringify({ ...retainedBase, ...multiwindowPayload() });
    await env.EVIDENCE.put(mod.keys.extractionPassKey("run_reuse_good", "a"), summaryOnly);
    const sourceFree = await mod.extractStage.stagePassASlice(
      env,
      "run_reuse_good",
      "missing-document-proves-summary-alone-is-not-authority",
      "fixture.docx",
      { epoch: 1, instanceId: "reuse-test" },
      async () => {},
      { budgetMs: 1 },
      mod.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      "0".repeat(64),
    );
    assertEq(sourceFree.result.state, "not-evaluated");
    assertEq(sourceFree.result.reason, "extraction-document-source-authority-invalid");
    assert(
      sourceFree.result.detail.includes("submitted document is missing"),
      "even well-shaped completion metadata must be reconstructed against exact source and paid units",
    );
    assertEq(
      await (await env.EVIDENCE.get(mod.keys.extractionPassKey("run_reuse_good", "a"))).text(),
      summaryOnly,
      "source-free inspection never overwrites the occupied completion key",
    );

    await env.EVIDENCE.put(
      mod.keys.extractionPassKey("run_reuse_bad", "a"),
      JSON.stringify({ ...retainedBase, ...multiwindowPayload({ crossWindowLimitations: [] }) }),
    );
    const malformedSourceFree = await mod.extractStage.stagePassASlice(
      env,
      "run_reuse_bad",
      "missing-document-proves-reuse-was-refused",
      "fixture.docx",
      { epoch: 1, instanceId: "reuse-test" },
      async () => {},
      { budgetMs: 1 },
      mod.docxBlocks.DOCUMENT_SEMANTICS_NONE,
      "0".repeat(64),
    );
    assertEq(malformedSourceFree.result.state, "not-evaluated");
    assertEq(malformedSourceFree.result.reason, "extraction-document-source-authority-invalid");
    assert(
      malformedSourceFree.result.detail.includes("submitted document is missing"),
      "malformed retained Pass-A bytes must not be accepted as a completed pass",
    );
  });

  test("the supplement binds exact Pass-A bytes and malformed or replaced bytes refuse", async () => {
    const mod = await worker();
    const stored = await storedSupplements(mod, multiwindowPayload(), "run_bound");
    assertEq(stored.supplements.length, 2);
    const sealed = contractCrossWindowLimitations(stored.supplements, stored.hash)[0];
    assertEq(sealed.passAHash, stored.hash);
    assertEq(sealed.sourceEvidenceSpans, 3);

    await stored.env.EVIDENCE.put(
      mod.keys.extractionPassKey("run_bound", "a"),
      JSON.stringify(multiwindowPayload({ crossWindowLimitations: [{ ...limitation, sourceEvidenceSpans: 4 }] })),
    );
    await assertThrows(
      () => mod.crossWindowLimitations.passACrossWindowSupplementsForSeal(
        stored.env,
        "run_bound",
        stored.hash,
      ),
      "hash mismatch",
      "replacing the Pass-A bytes after durable validation cannot reach seal",
    );

    const healthy = await storedSupplements(
      mod,
      {
        slice: completedSlice(1, "not-required"),
        crossWindowLimitations: [],
        primaryGroundingLimitations: [],
      },
      "run_single",
    );
    assertEq(healthy.supplements.length, 1);
  });

  test("sealed limitation becomes a counted blocker, blocks the test axis, and renders uncertifiable", async () => {
    const mod = await worker();
    const passAHash = `sha256:${"a".repeat(64)}`;
    const supplement = crossWindowLimitationSupplement(limitation, passAHash);
    const revision = {
      ...contractBody(),
      contractRevisionId: "cr_limited",
      contractSupplements: [supplement],
      extraction: { ...contractBody().extraction, passAHash },
    };
    const blockers = mod.assembleRecord.deriveRecordBlockers({
      revision,
      walks: [],
      itemResults: [],
      observations: [],
      evidence: [],
      probeCapabilityLimitations: [],
    });
    const coverage = blockers.find((row) => row.kind === CROSS_WINDOW_DISCOVERY_BLOCKER_KIND);
    assert(coverage, JSON.stringify(blockers));
    assertEq(coverage.count, 2);
    assert(coverage.detail.includes("3 nominated exact quote span(s)"), coverage.detail);
    assert(coverage.detail.includes(passAHash), coverage.detail);

    const record = runRecordV2({
      runId: "v2r_limited",
      contractRevisionId: "cr_limited",
      contractHash: "sha256:contract",
      evidence: [],
    });
    record.blockers = blockers;
    const projected = mod.renderable.projectRunRecordV2(record, revision);
    const projectedBlocker = projected.findings.find(
      (row) => row.sourceBlockerKind === CROSS_WINDOW_DISCOVERY_BLOCKER_KIND,
    );
    assert(projectedBlocker, JSON.stringify(projected.findings));
    assertEq(projected.contract.assumptions[0], supplement, "the exact Pass-A hash bridge reaches export");

    const checkpoint = {
      contract: {
        state: "sealed",
        total: 1,
        contractRevisionId: "cr_limited",
        contractHash: "sha256:contract",
        requirements: { total: 1, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
      },
      counts: {
        exercised: 1,
        "not-reached": 0,
        "proven-unreachable": 0,
        blocked: 0,
        "budget-exhausted": 0,
        "time-exhausted": 0,
        pending: 0,
      },
      phases: [{ name: "adjudicating", state: "complete", observedAt: null, reasonCode: null }],
    };
    const evaluated = { state: "evaluated", value: {}, proof: {} };
    const axis = mod.workflow.testAxisBlockers(
      checkpoint,
      evaluated,
      { state: "evaluated", value: { coverageBlockers: 1 }, proof: {} },
    );
    assert(
      axis.some((row) =>
        row.includes("1 sealed document coverage limitation(s)") &&
        row.includes("RunRecord blocker list")),
      JSON.stringify(axis),
    );
    const missingCount = mod.workflow.testAxisBlockers(
      checkpoint,
      evaluated,
      { state: "evaluated", value: {}, proof: {} },
    );
    assert(missingCount.some((row) => row.includes("was not evaluated")), JSON.stringify(missingCount));
    assertEq(
      mod.workflow.testAxisBlockers(
        checkpoint,
        evaluated,
        { state: "evaluated", value: { coverageBlockers: 0 }, proof: {} },
      ).length,
      0,
      "an explicitly computed zero remains closable",
    );

    const healthyReport = renderedCertification([]);
    assertEq(healthyReport.view.register.certification.certifiable, true);
    const limitedReport = renderedCertification([projectedBlocker]);
    assertEq(limitedReport.view.register.certification.certifiable, false);
    assert(
      limitedReport.view.register.certification.blockers.some(
        (row) => row.ref === coverage.blockerId && row.kind === "operational-blocker",
      ),
      JSON.stringify(limitedReport.view.register.certification.blockers),
    );
    assert(limitedReport.html.includes(CROSS_WINDOW_DISCOVERY_BLOCKER_KIND));
    assert(limitedReport.html.includes(passAHash), "the rendered blocker retains exact Pass-A provenance");

    // Semantic counterproof: deleting the projected blocker makes the exact same otherwise
    // healthy report certifiable, so the assertion above is capable of failing on that mutant.
    await assertThrows(
      () => assertEq(healthyReport.view.register.certification.certifiable, false),
      "expected false, got true",
    );
  });
});
