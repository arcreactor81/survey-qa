/**
 * A RunRecordV2 fixture built STRICTLY to the v2 schema, plus the sealed ContractRevision
 * it references, its evidence, and a correctly attested JudgementRecord bound to it.
 *
 * WHY IT IS BUILT HERE AND NOT COPIED FROM A RUN. Every fixture the smoke suite had was
 * the legacy t1-easy harness record, which happens to satisfy the shared renderer's
 * expectations by accident of history. That is precisely why a conforming RunRecordV2
 * could not traverse the report path without anything failing (D12): nothing had ever
 * constructed one. This module constructs one from the type declarations, so it fails
 * whenever the schema and the report path drift apart again.
 *
 * The signing key is the committed test-only fixture keypair. Its public half is pinned
 * in wrangler.jsonc with `trust: "fixture"`, which the Worker honours ONLY when DEV_SEED
 * is enabled — so the same fixture cannot certify anything on a deployed build.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { signRecord } from "../../../scorer/src/lib/attest.mjs";
import { payloadHashOf } from "../../../scorer/src/lib/attest.mjs";
import { evidenceManifestRoot } from "../../../pipeline/report/lib/judgement-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_KEY = JSON.parse(readFileSync(path.join(HERE, "judgement-fixture-key.json"), "utf8"));

export const FIXTURE_REGISTRY = JSON.stringify({
  keys: {
    [FIXTURE_KEY.keyId]: { publicKeySpki: FIXTURE_KEY.publicKeySpki, trust: "fixture" },
  },
});

/** The same registry, but claiming production trust — used to prove the trust gate works. */
export const FIXTURE_REGISTRY_AS_PRODUCTION = JSON.stringify({
  keys: {
    [FIXTURE_KEY.keyId]: { publicKeySpki: FIXTURE_KEY.publicKeySpki, trust: "production" },
  },
});

export const TARGET_BUILD_ID = "build-2026-08-02-a1b2c3";

const proof = (id) => ({
  evaluatorId: id,
  evaluatorVersion: "1.0.0-fixture",
  inputHash: `sha256:${createHash("sha256").update(id).digest("hex")}`,
  observedAt: "2026-08-02T00:00:00.000Z",
});

/** Four §0 approval gates, each PASSING and each carrying a proof. */
export function passingGates() {
  return {
    zeroUnexplainedNormativeBlocks: { state: "pass", proof: proof("source-ledger"), detail: "unexplained normative blocks: 0" },
    allConstructClassesDispositioned: { state: "pass", proof: proof("construct-checklist") },
    allScopedExpansionsPreviewed: { state: "pass", proof: proof("expansion-previewer") },
    noUnresolvedHighRiskDisagreement: { state: "pass", proof: proof("extraction-diff"), detail: "high-risk disagreements: 0" },
  };
}

export function contractBody({ documentSha256 = "a".repeat(64), sealedAt = "2026-08-02T00:00:00.000Z" } = {}) {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: documentSha256,
    documentSha256,
    sealedAt,
    requirements: [
      {
        requirementLineageId: "req_fixture000001",
        requirementVersionId: "reqv_fixture000001",
        semanticFingerprint: "fp_one_question_per_screen",
        scope: "survey",
        quantifier: "every",
        selector: null,
        exceptions: [],
        facet: "rendered-state",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [
          { blockId: "B1", kind: "paragraph", coords: null, role: "instruction", atomTextHash: "sha256:deadbeef" },
        ],
        composition: null,
        // The normative sentence and the document's own copy are DIFFERENT STRINGS here on
        // purpose: a fixture where they coincide cannot distinguish a projection that reads
        // the right field from one that reads either.
        normativeStatement: "Every screen must display exactly one question.",
        displayQuote: "Show one question per screen.",
        retiredAt: null,
      },
      {
        requirementLineageId: "req_fixture000002",
        requirementVersionId: "reqv_fixture000002",
        semanticFingerprint: "fp_q7_routes_to_q9",
        scope: "question:Q7",
        quantifier: "specific",
        selector: "Q7",
        exceptions: [],
        facet: "routing",
        assertionStatus: "entailed",
        testability: "browser-observable",
        notBrowserObservableReason: null,
        sourceAtoms: [
          {
            blockId: "T2",
            kind: "table-cell",
            coords: { row: 3, col: 2, rowHeader: "Q7", colHeader: "Go to" },
            role: "routing",
            atomTextHash: "sha256:cafebabe",
          },
        ],
        composition: null,
        normativeStatement: "When Q7 is answered \"Can't remember\", the survey must route to Q9.",
        displayQuote: "If Q7 = 'Can't remember', go to Q9.",
        retiredAt: null,
      },
    ],
    facetInstances: [
      {
        facetInstanceId: "fi_fixture01",
        requirementLineageId: "req_fixture000001",
        requirementVersionId: "reqv_fixture000001",
        caseVersionId: "cv_fixture01",
        floorCase: true,
        targetQuestionId: "Q1",
        expansionCertificate: "cert_fixture01",
        case: {
          kind: "rendered-state",
          routeAnswer: null,
          boundaryInput: null,
          configuration: null,
          expectedDestination: null,
        },
        expectationGap: null,
        screen: null,
        label: null,
      },
      {
        facetInstanceId: "fi_fixture02",
        requirementLineageId: "req_fixture000002",
        requirementVersionId: "reqv_fixture000002",
        caseVersionId: "cv_fixture02",
        floorCase: true,
        targetQuestionId: "Q7",
        expansionCertificate: "cert_fixture02",
        case: {
          kind: "route",
          routeAnswer: null,
          boundaryInput: null,
          configuration: null,
          expectedDestination: null,
        },
        expectationGap: null,
        screen: null,
        label: null,
      },
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa",
      passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc",
      diffHash: "sha256:ddd",
      reviewMode: "high-risk-only",
      reviewedBy: "fixture-reviewer",
      reviewedAt: "2026-08-02T00:00:00.000Z",
      gates: passingGates(),
    },
  };
}

/** A RunRecordV2 with every field the v2 type declares. */
export function runRecordV2({ runId, contractRevisionId, contractHash, evidence = [], documentSha256 = "a".repeat(64) }) {
  return {
    schemaVersion: "run-record/2.0.0",
    kind: "survey-qa-v2-run-record",
    runId,
    contract: { contractRevisionId, contractHash },
    run: {
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T00:20:00.000Z",
      surveyUrl: "https://fixture.invalid/survey",
      documentSha256,
      targetBuildId: TARGET_BUILD_ID,
      locale: "en",
      viewports: ["desktop"],
    },
    attempts: [
      {
        attemptId: "att_fixture01",
        pathId: "FLOOR-01",
        pathLabel: "floor walk",
        attemptNumber: 1,
        retryOfAttemptId: null,
        retryReason: null,
        targetCaseIds: ["fi_fixture01", "fi_fixture02"],
        startedAt: "2026-08-02T00:01:00.000Z",
        endedAt: "2026-08-02T00:09:00.000Z",
        ok: true,
        stopReason: null,
        evidenceIds: evidence.map((e) => e.evidenceId),
      },
    ],
    observations: [
      {
        observationId: "obs_fixture01",
        facetInstanceId: "fi_fixture01",
        attemptId: "att_fixture01",
        routeId: "route-a",
        observedAt: "2026-08-02T00:02:00.000Z",
        payloadKind: "rendered-state",
        payload: { screens: 12, maxQuestionsPerScreen: 1 },
        completeness: "complete-scoped-inventory",
        evidenceIds: evidence.map((e) => e.evidenceId),
        verifier: { decision: "verified", evidenceIds: evidence.map((e) => e.evidenceId), verifierVersion: "v2-verifier/1.0.0" },
        attestation: { producedBy: "executor", producerVersion: "1.0.0", payloadHash: "sha256:0011" },
      },
      {
        observationId: "obs_fixture02",
        facetInstanceId: "fi_fixture02",
        attemptId: "att_fixture01",
        routeId: "route-b",
        observedAt: "2026-08-02T00:05:00.000Z",
        payloadKind: "routing",
        payload: { from: "Q7", answer: "Can't remember", observedNext: "Q8" },
        completeness: "complete-scoped-inventory",
        evidenceIds: evidence.map((e) => e.evidenceId),
        verifier: { decision: "contradicted", evidenceIds: evidence.map((e) => e.evidenceId), verifierVersion: "v2-verifier/1.0.0" },
        attestation: { producedBy: "executor", producerVersion: "1.0.0", payloadHash: "sha256:0012" },
      },
    ],
    claims: [
      {
        claimId: "clm_fixture01",
        claimClass: "defect",
        claimType: "routing-mismatch",
        normativeRef: { requirementLineageId: "req_fixture000002", requirementVersionId: "reqv_fixture000002" },
        observationRefs: ["obs_fixture02"],
        prose: "Q7 = 'Can't remember' lands on Q8; the document requires Q9.",
      },
    ],
    ambiguities: [],
    taxonomyGaps: [],
    blockers: [],
    itemResults: [
      {
        requirementLineageId: "req_fixture000001",
        requirementVersionId: "reqv_fixture000001",
        facetResults: [{ facetInstanceId: "fi_fixture01", routeId: "route-a", status: "pass", observationIds: ["obs_fixture01"] }],
        verdict: "pass",
        pathConsistency: "consistent",
        divergenceSet: [],
        derivedBy: "v2-aggregator/1.0.0",
        resultPolicyVersion: "v2-result-policy/1.0.0",
      },
      {
        requirementLineageId: "req_fixture000002",
        requirementVersionId: "reqv_fixture000002",
        facetResults: [{ facetInstanceId: "fi_fixture02", routeId: "route-b", status: "fail", observationIds: ["obs_fixture02"] }],
        verdict: "fail",
        pathConsistency: "consistent",
        divergenceSet: [],
        derivedBy: "v2-aggregator/1.0.0",
        resultPolicyVersion: "v2-result-policy/1.0.0",
      },
    ],
    exploration: { planHash: "sha256:plan", perKindCounts: { routing: 1 }, testComplete: true },
    evidence,
    resources: {
      modelCalls: [
        {
          callId: "MC-01",
          role: "extractor",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          promptVersion: "extractor@1",
          promptHash: "sha256:prompt",
          status: "ok",
          inputTokens: 1200,
          outputTokens: 340,
          cachedInputTokens: 0,
          costUsd: 0.12,
        },
      ],
      toolVersions: [{ name: "puppeteer", version: "1.1.0", note: null }],
      totals: { costUsd: 0.12, modelCalls: 1, toolCalls: 8, wallClockMs: 1_200_000, tokens: { input: 1200, output: 340 } },
      limits: { maxUsd: 30, maxModelCalls: 400, maxToolCalls: 4000, maxWallClockMs: 3_600_000 },
    },
    versions: {
      aggregator: "v2-aggregator/1.0.0",
      resultPolicy: "v2-result-policy/1.0.0",
      normalizer: "v2-normalizer/1.0.0",
      projection: "v2-projection/1.0.0",
      registry: "v2-registry/1.0.0",
    },
    attestation: null,
  };
}

/**
 * CITED, RE-VERIFIED WITNESSES — what makes the fixture's pass a REAL pass.
 *
 * AMENDMENT A's publication gate refuses to publish a pass that cites no typed
 * observation, names no satisfied predicate, or rests on a witness that did not
 * re-verify. A judgement whose results are bare `{obligationId, verdict}` therefore
 * renders as UNSUPPORTED/JUDGMENT_PENDING — correctly. That is fine for proving the gate,
 * and useless for proving the SUCCESS path, which is the thing nothing was testing: every
 * suite proved a component refuses bad input and none proved one accepts good input.
 *
 * These witnesses cite the run's own evidence catalogue by artifact id and content hash,
 * so the fixture pass clears the gate for the reason a real pass would.
 */
export function judgedResults(record) {
  const ev = record?.evidence ?? [];
  // A citation with no usable digest pins no bytes, and the shared validator now says so
  // (MALFORMED_WITNESS / BAD_EVIDENCE_REFS). v2 stores bare hex, so the prefix is added
  // here rather than a placeholder being invented: a witness whose evidence entry has no
  // hash is left WITHOUT one, and the record is correctly refused.
  const digest = (e) => {
    const h = e?.contentHash;
    return typeof h === "string" && h.length > 0 ? (h.startsWith("sha256:") ? h : `sha256:${h}`) : null;
  };
  const wit = (e, note, value) => ({
    artifact: e?.sourceEvidenceId ?? e?.evidenceId ?? "EV-FIX-001.json",
    sha256: digest(e),
    session: "S-1",
    seq: 1,
    locator: "evidence[0]",
    value: [value],
    note,
  });
  const supporting = wit(ev[0], "one question was rendered per screen in every capture", "screens: 12");
  const counter = wit(ev[1], "Q7 = 'Can't remember' landed on Q8, not Q9", "observedNext: Q8");
  return [
    {
      obligationId: "req_fixture000001",
      verdict: "pass",
      coverage: "exercised",
      reason: "POSITIVE_WITNESS",
      predicateId: "rendered-state@1",
      predicateOutcome: "satisfied",
      expectation: { kind: "rendered-state", screen: null },
      evidenceRefs: [{ artifact: supporting.artifact, sha256: supporting.sha256, locators: [supporting.locator] }],
      supportingWitnesses: [supporting],
      counterWitnesses: [],
      attestation: { allVerified: true, positive: [{ witness: supporting, ok: true, reason: null }], counter: [] },
    },
    {
      obligationId: "req_fixture000002",
      verdict: "fail",
      coverage: "exercised",
      reason: "ROUTE_SKIPPED_SCREEN_SHOWN",
      predicateId: "routing@1",
      predicateOutcome: "violated",
      expectation: { kind: "routing", question: "Q7", destination: "Q9" },
      evidenceRefs: [{ artifact: counter.artifact, sha256: counter.sha256, locators: [counter.locator] }],
      supportingWitnesses: [],
      counterWitnesses: [counter],
      attestation: { allVerified: true, positive: [], counter: [{ witness: counter, ok: true, reason: null }] },
    },
  ];
}

/**
 * A JudgementRecord bound to a specific run and signed with the fixture key. `overrides`
 * lets a test break exactly one binding and prove the boundary refuses it.
 */
export function signedJudgement({
  runId,
  record,
  contractRevisionId,
  /**
   * The SEMANTIC hash `sealContract` returned for that revision. Mandatory at the Worker
   * boundary (D4): a revision id names bytes, and a judgement bound to the id alone is
   * bound to nothing that was re-checked. Callers pass the value the real sealer produced
   * — it is never typed in by hand here.
   */
  contractHash = null,
  targetBuildId = TARGET_BUILD_ID,
  overrides = {},
  bindingOverrides = {},
}) {
  const body = {
    schemaVersion: "survey-qa-judgement-record/1.0.0",
    kind: "judgement-record",
    generatedAt: "2026-08-02T00:30:00.000Z",
    // The producer's OWN declaration that it checked its bindings. `buildJudgementRecord`
    // always states this; silence means the record did not come from a producer that
    // performed the check, and the shared validator refuses it (PRODUCER_STATUS_ABSENT).
    // `status` must agree — publishable and diagnostic-only are not simultaneously true.
    publishable: true,
    status: "attestable",
    unbindableFields: [],
    binding: {
      runId,
      runRecordPayloadHash: payloadHashOf(record),
      contractRevisionId,
      contractRevisionHash: contractHash,
      targetBuildId,
      evidenceManifestRoot: evidenceManifestRoot(record),
      engineVersion: "1.0.0",
      compilerVersion: "1.0.0",
      predicateVersion: "1.0.0",
      ambiguityPolicyVersion: "1.0.0",
      // A version the reader can INTERPRET, not merely a non-empty string. The shared
      // validator pins the vocabulary set (SUPPORTED_BINDING_VERSIONS); a product-prefixed
      // string like "v2-result-policy/1.0.0" names a vocabulary it was never taught.
      resultPolicyVersion: "1.0.0",
      ...bindingOverrides,
    },
    results: judgedResults(record),
    engineVersion: "1.0.0",
    compilerVersion: "1.0.0",
    predicateVersion: "1.0.0",
    ambiguityPolicyVersion: "1.0.0",
    routeTable: { rows: [] },
    counts: { byVerdict: { pass: 1, fail: 1, inconclusive: 0, "not-assessed": 0 } },
    certification: { certifiable: false, blockers: [{ obligationId: "req_fixture000002" }] },
    ...overrides,
  };
  const attestation = signRecord(body, FIXTURE_KEY.privateKeyPem, FIXTURE_KEY.keyId, "2026-08-02T00:30:01.000Z");
  return { ...body, attestation };
}
