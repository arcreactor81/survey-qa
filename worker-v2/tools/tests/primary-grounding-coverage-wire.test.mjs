/**
 * A primary candidate rejected by exact source grounding receives no semantic authority,
 * but it must remain a counted document-coverage limitation through seal, record, and report.
 */

import { assert, assertEq, assertThrows, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { contractBody, runRecordV2 } from "../fixtures/v2-fixture.mjs";
import {
  PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_PREFIX,
  PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_KIND,
  SOURCE_GROUNDING_BLOCKER_KIND,
  contractPrimaryGroundingLimitations,
  primaryGroundingLimitationsSupplement,
  validatePassAPrimaryGroundingLimitations,
} from "../../shared/pass-a-grounding-limitations.mjs";
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

const singleRow = {
  kind: "pass-a-primary-candidate-ungrounded",
  unit: "A",
  rowKind: "global-rule",
  rowIndex: 1,
  sourceBlockIds: [],
  reason: "source-block-ownership-invalid",
};

const RAW_SENTINEL = "RAW_MODEL_OUTPUT_AND_SOURCE_QUOTE_MUST_NEVER_RENDER";

const multiRows = [
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w1",
    rowKind: "global-rule",
    rowIndex: 1,
    sourceBlockIds: [],
    reason: "source-block-ownership-invalid",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w1",
    rowKind: "ambiguity",
    rowIndex: 2,
    sourceBlockIds: ["b0001", "b0002", "b0003", "b0004", "b0005"],
    reason: "source-evidence-set-invalid",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w2",
    rowKind: "global-rule",
    rowIndex: 1,
    sourceBlockIds: ["b0101"],
    reason: "source-quote-not-exact",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w2",
    rowKind: "cross-reference",
    rowIndex: 2,
    sourceBlockIds: ["b0102"],
    reason: "grounded-row-linkage-incomplete",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w2",
    rowKind: "ambiguity",
    rowIndex: 3,
    sourceBlockIds: ["b0103"],
    reason: "source-quote-not-exact",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w2",
    rowKind: "unverifiable",
    rowIndex: 4,
    sourceBlockIds: ["b0104"],
    reason: "source-evidence-set-invalid",
  },
  {
    kind: "pass-a-primary-candidate-ungrounded",
    unit: "A-w2",
    rowKind: "unverifiable",
    rowIndex: 5,
    sourceBlockIds: ["b0105"],
    reason: "source-quote-not-exact",
  },
];

const crossWindowLimitation = {
  kind: "pass-a-cross-window-candidate-dependence",
  windowsTotal: 2,
  candidatesSynthesized: 2,
  candidatesUngrounded: 0,
  sourceEvidenceBlocks: 2,
  sourceEvidenceSpans: 2,
  synthesisAdditions: 0,
  detail: "The synthesis inspected nominated candidate spans, not unsupplied source text.",
};

const completedSlice = (windowsTotal) => ({
  done: true,
  windowsTotal,
  windowsLanded: windowsTotal,
  windowsIssued: 0,
  windowsRemaining: 0,
  terminalFailure: false,
  synthesisState: windowsTotal === 1 ? "not-required" : "ok",
  synthesisAttempts: windowsTotal === 1 ? 0 : 1,
  synthesisIssued: 0,
  deadlineHit: false,
});

const payload = (windowsTotal, rows, overrides = {}) => ({
  slice: completedSlice(windowsTotal),
  crossWindowLimitations: windowsTotal === 1 ? [] : [crossWindowLimitation],
  primaryGroundingLimitations: rows,
  ...overrides,
});

const historicalRevision = (passAHash) => ({
  schemaVersion: "v2-contract-revision/1.0.0",
  extraction: {
    passAHash,
    // Deployed pre-wire model revisions already carried this digest. Its presence cannot
    // distinguish them from the new lineage.
    reuseInputsHash: `sha256:${"1".repeat(64)}`,
  },
});

const currentRevision = (passAHash) => ({
  ...historicalRevision(passAHash),
  extraction: {
    ...historicalRevision(passAHash).extraction,
    primaryGroundingLimitationsVersion: PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_KIND,
  },
});

async function seal(mod, runId, passAPayload) {
  const env = testEnv();
  const body = JSON.stringify(passAPayload);
  const passAHash = `sha256:${await mod.hash.sha256Hex(body)}`;
  await env.EVIDENCE.put(mod.keys.extractionPassKey(runId, "a"), body);
  const supplements = await mod.crossWindowLimitations.passACrossWindowSupplementsForSeal(
    env,
    runId,
    passAHash,
  );
  return { env, passAHash, supplements };
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
    path: "primary-grounding-coverage-wire",
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

suite("Pass-A primary grounding limitations are durable", () => {
  test("the completion array is closed, ordered, metadata-only, and missing is not zero", async () => {
    assertEq(validatePassAPrimaryGroundingLimitations([singleRow]).length, 1);
    assertEq(validatePassAPrimaryGroundingLimitations(multiRows).length, multiRows.length);

    await assertThrows(
      () => validatePassAPrimaryGroundingLimitations([
        { ...singleRow, rawQuote: RAW_SENTINEL },
      ]),
      "expected exactly",
      "an undeclared quote/model-claim channel must fail closed",
    );
    await assertThrows(
      () => validatePassAPrimaryGroundingLimitations([
        { ...singleRow, sourceBlockIds: [RAW_SENTINEL] },
      ]),
      "internal Pass-A block identifiers",
      "raw model/source text must not be laundered into a public source-block identifier",
    );
    await assertThrows(
      () => validatePassAPrimaryGroundingLimitations([...multiRows].reverse()),
      "deterministic window/row order",
    );
    await assertThrows(
      () => validatePassAPrimaryGroundingLimitations([multiRows[0], multiRows[0]]),
      "duplicate or not in deterministic",
    );

    const mod = await worker();
    const env = testEnv();
    const missing = JSON.stringify(payload(1, [], { primaryGroundingLimitations: undefined }));
    const missingHash = `sha256:${await mod.hash.sha256Hex(missing)}`;
    await env.EVIDENCE.put(mod.keys.extractionPassKey("run_grounding_missing", "a"), missing);
    await assertThrows(
      () => mod.crossWindowLimitations.passACrossWindowSupplementsForSeal(
        env,
        "run_grounding_missing",
        missingHash,
      ),
      "primaryGroundingLimitations was not evaluated",
    );
  });

  test("one always-present supplement binds the exact Pass-A hash and rejects duplicate or foreign seals", async () => {
    const mod = await worker();
    const single = await seal(mod, "run_grounding_single", payload(1, []));
    assertEq(single.supplements.length, 1, "an evaluated zero still has a sealed marker");
    const empty = contractPrimaryGroundingLimitations(
      single.supplements,
      single.passAHash,
      currentRevision(single.passAHash),
    );
    assert(empty, "the evaluated-zero marker must remain distinguishable from historical absence");
    assertEq(empty.rows.length, 0);

    const multi = await seal(mod, "run_grounding_multi", payload(2, multiRows));
    assertEq(multi.supplements.length, 2, "existing cross-window plus new grounding marker");
    const sealed = contractPrimaryGroundingLimitations(
      multi.supplements,
      multi.passAHash,
      currentRevision(multi.passAHash),
    );
    assertEq(sealed.rows.length, multiRows.length);
    assertEq(sealed.passAHash, multi.passAHash);

    const marker = multi.supplements.find((value) =>
      value.startsWith(PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_PREFIX)
    );
    assert(marker, JSON.stringify(multi.supplements));
    assert(!marker.includes("rawQuote"), marker);
    await assertThrows(
      () => contractPrimaryGroundingLimitations(
        [marker, marker],
        multi.passAHash,
        currentRevision(multi.passAHash),
      ),
      "duplicate sealed grounding supplements",
    );
    await assertThrows(
      () => contractPrimaryGroundingLimitations(
        [marker],
        `sha256:${"f".repeat(64)}`,
        currentRevision(multi.passAHash),
      ),
      "exact Pass-A hash",
    );
    await assertThrows(
      () => contractPrimaryGroundingLimitations(
        [`${PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_PREFIX}{not-json`],
        multi.passAHash,
        currentRevision(multi.passAHash),
      ),
      "JSON is malformed",
    );

    assertEq(
      contractPrimaryGroundingLimitations(
        [],
        multi.passAHash,
        historicalRevision(multi.passAHash),
      ),
      null,
      "a deployed-style pre-wire model revision is positively historical even with reuseInputsHash",
    );
    await assertThrows(
      () => contractPrimaryGroundingLimitations(
        [],
        multi.passAHash,
        currentRevision(multi.passAHash),
      ),
      "missing its required grounding marker",
      "deleting only the marker from a new immutable lineage must fail closed",
    );
  });

  test("exact row counts block signed coverage and report certification for one or many windows", async () => {
    const mod = await worker();
    let multiProjectedBlocker = null;

    for (const scenario of [
      { name: "single", windowsTotal: 1, rows: [singleRow] },
      { name: "multi", windowsTotal: 2, rows: multiRows },
    ]) {
      const stored = await seal(
        mod,
        `run_grounding_record_${scenario.name}`,
        payload(scenario.windowsTotal, scenario.rows),
      );
      const revision = {
        ...contractBody(),
        contractRevisionId: `cr_grounding_${scenario.name}`,
        contractSupplements: stored.supplements,
        extraction: {
          ...contractBody().extraction,
          passAHash: stored.passAHash,
          primaryGroundingLimitationsVersion: PASS_A_PRIMARY_GROUNDING_SUPPLEMENT_KIND,
        },
      };
      const blockers = mod.assembleRecord.deriveRecordBlockers({
        revision,
        walks: [],
        itemResults: [],
        observations: [],
        evidence: [],
        probeCapabilityLimitations: [],
      });
      const source = blockers.find((row) => row.kind === SOURCE_GROUNDING_BLOCKER_KIND);
      assert(source, JSON.stringify(blockers));
      assertEq(source.count, scenario.rows.length, "blocker count is the exact omitted-row count");
      assert(source.detail.includes(stored.passAHash), source.detail);
      if (scenario.name === "single") {
        assert(source.detail.includes("Affected row metadata (all 1 retained row"), source.detail);
        assert(source.detail.includes("All 1 affected row is displayed."), source.detail);
      }

      const record = runRecordV2({
        runId: `v2r_grounding_${scenario.name}`,
        contractRevisionId: revision.contractRevisionId,
        contractHash: "sha256:contract",
        evidence: [],
      });
      record.blockers = blockers;
      const projected = mod.renderable.projectRunRecordV2(record, revision);
      const projectedBlocker = projected.findings.find(
        (row) => row.sourceBlockerKind === SOURCE_GROUNDING_BLOCKER_KIND,
      );
      assert(projectedBlocker, JSON.stringify(projected.findings));
      if (scenario.name === "multi") multiProjectedBlocker = projectedBlocker;
    }

    const healthy = renderedCertification([]);
    assertEq(healthy.view.register.certification.certifiable, true);
    const limited = renderedCertification([multiProjectedBlocker]);
    assertEq(limited.view.register.certification.certifiable, false);
    assert(limited.html.includes(SOURCE_GROUNDING_BLOCKER_KIND));
    assert(limited.html.includes("Affected row metadata (first 5 of 7 retained rows"), limited.html);
    assert(limited.html.includes("A-w1; global rule row 1; owned source block IDs: none"), limited.html);
    assert(limited.html.includes("A-w1; ambiguity row 2; owned source block IDs: b0001, b0002, b0003, b0004"), limited.html);
    assert(limited.html.includes("1 more source block ID retained for this row"), limited.html);
    assert(limited.html.includes("reason source-evidence-set-invalid"), limited.html);
    assert(limited.html.includes("A-w2; cross-reference row 2"), limited.html);
    assert(limited.html.includes("reason grounded-row-linkage-incomplete"), limited.html);
    assert(limited.html.includes("2 additional affected rows are retained in the sealed run record and are not displayed here."), limited.html);
    assert(!limited.html.includes("b0005"), "the bounded public source-id list must omit retained overflow ids");
    assert(!limited.html.includes("b0104"), "the bounded public row list must omit retained overflow rows");
    assert(!limited.html.includes(RAW_SENTINEL), "raw source/model text must never reach report HTML");

    // Semantic counterproof: deleting only the projected blocker flips the exact same
    // otherwise healthy report back to certifiable.
    await assertThrows(
      () => assertEq(healthy.view.register.certification.certifiable, false),
      "expected false, got true",
    );
  });
});
