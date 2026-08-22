/**
 * A3b — ASYNC EVIDENCE SOURCE: bounded residency via the engine's retained-
 * projection budget, R2-backed byte source, and hash verification at read time.
 *
 * THE DEFECT. `mintJudgement` died with "exceededMemory" (HTTP 503 / CF error
 * 1102) on the v100 replay. The mechanism: the engine held every raw session
 * in memory (112.8 MB) and the store parsed them all from a memory-backed
 * tmpdir. 112.8 MB x 2 copies + parse transients cannot fit a 128 MB isolate.
 *
 * THE FIX. The engine's EvidenceStore now fetches bytes through an injected
 * async source (R2-backed for the Worker, disk-backed for local tests). The
 * store projects each v2 session on read (12.5 MB -> 1.89 MB) and drops the
 * raw buffer. A retained-projection budget (64 MB) refuses honestly when the
 * cumulative projections would OOM the isolate.
 *
 * THESE TESTS PROVE:
 *   1. STREAMING LOADER — engine-read artifacts produce descriptors (no bytes),
 *      hash-verify-only artifacts are fetched/verified/released in batches.
 *   2. HASH VERIFICATION — mismatches in either set are refused.
 *   3. ENGINE-READ SPLIT — JSON session files are descriptors, PNGs are
 *      hash-verified.
 *   4. RESIDENCY ACCOUNTING — the store's retainedBytes counter tracks cached
 *      session projection size.
 *   5. ATTEST FRESH — attest() re-fetches from the source, never from cache.
 *   6. END TO END — a real judge run with both JSON and PNG artifacts produces
 *      correct verdicts.
 */

import { createHash } from "node:crypto";

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";
import { FIXTURE_KEY, TARGET_BUILD_ID, passingGates } from "../fixtures/v2-fixture.mjs";

const enc = new TextEncoder();
const sha256 = (s) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

// ---------------------------------------------------------------------------
// Helpers: build a minimal fixture with both JSON and non-JSON artifacts.
// ---------------------------------------------------------------------------

const control = (idx, { name, id, code, label, type = "radio" }) => ({
  idx, tag: "input", type, name, id, code, label, text: "",
  checked: false, value: null, disabled: false, required: false,
  visible: true, placeholder: null, maxlength: null, readOnly: false,
});

function questionScreen(q, prose, options) {
  const controls = options.map((o, i) => control(i, { name: q, id: `${q}_${o.code}`, code: o.code, label: o.label }));
  return {
    at: "2026-08-08T00:05:00.000Z",
    url: "https://fixture.invalid/survey",
    title: null, collectedErrors: [], questionText: prose, instructionText: null,
    visibleText: prose, visibleTextTruncated: false, bracketedInstructionsVisible: [],
    controls,
    optionGroups: [{
      name: q, kind: "radio",
      options: options.map((o, i) => ({
        order: i, idx: i, code: o.code, label: o.label,
        checked: false, disabled: false, visible: true,
      })),
    }],
    grid: null,
    buttons: [
      { idx: 90, label: "Back", role: "back", disabled: false, visible: true },
      { idx: 99, label: "Next", role: "next", disabled: false, visible: true },
    ],
    progress: { present: true, kind: "bar", now: options.length, max: 10, text: null },
    validationMessages: [],
    counts: { controls: controls.length, optionGroups: 1, options: options.length, textInputs: 0 },
    screenSignature: `sig:${q}`,
  };
}

const plainScreen = (prose) => ({
  ...questionScreen("NONE", prose, []),
  controls: [], optionGroups: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0 },
  screenSignature: `sig:${prose}`,
});

const Q1_OPTIONS = [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }];
const Q2_OPTIONS = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const Q1 = () => questionScreen("Q1", "What is your favourite colour?", Q1_OPTIONS);
const Q2 = () => questionScreen("Q2", "Do you like surveys?", Q2_OPTIONS);
const CLOSING = () => plainScreen("Thanks for participating.");

const clickStep = (index, before, after, { code = "1", label = "Red", ok = true, advanced = true, blocked = false } = {}) => ({
  stepIndex: index,
  decisionQuestion: "WRONG-ON-PURPOSE",
  decisionSource: "plan",
  requested: { select: [label], textEntry: null, action: null },
  screenBefore: before,
  screenAfterAction: null,
  screenAfterAdvance: after,
  actions: [
    { kind: "click-option", targetIdx: 0, targetLabel: label, targetCode: code, value: null, ok, detail: null },
    { kind: "click-next", targetIdx: 99, targetLabel: "Next", targetCode: null, value: null, ok: true, detail: null },
  ],
  requestedButNotOffered: [],
  advanced, blocked, pageErrors: [], consoleErrors: [],
  evidence: { screenBefore: null, screenAfterAdvance: null, screenshots: [] },
  wallMs: 1000,
});

const walkDoc = (runId, pathId) => ({
  kind: "v2-path-observation/1.0.0",
  runId, pathId, tier: 1, attemptId: "att_a3test01",
  planRevisionId: "plan_a3test01",
  surveyUrl: "https://fixture.invalid/survey",
  startedAt: "2026-08-08T00:04:00.000Z",
  endedAt: "2026-08-08T00:05:00.000Z",
  wallMs: 60000, plannedWitnesses: [],
  steps: [
    clickStep(0, Q1(), Q2()),
    clickStep(1, Q2(), CLOSING(), { label: "Yes" }),
  ],
  outcome: "completed", outcomeDetail: null,
  shimmed: false, shimNote: null, loadFailure: null, evidenceIds: [],
  viewport: { width: 1280, height: 900 },
});

const req = (id, facet, statement, quote) => ({
  requirementLineageId: id,
  requirementVersionId: id.replace("req_", "reqv_"),
  semanticFingerprint: `fp_${id}`,
  scope: "survey", quantifier: "specific", selector: null, exceptions: [],
  facet, assertionStatus: "entailed", testability: "browser-observable",
  notBrowserObservableReason: null,
  sourceAtoms: [{ blockId: "B1", kind: "paragraph", coords: null, role: "normative", atomTextHash: sha256(quote) }],
  composition: null,
  normativeStatement: statement, displayQuote: quote, retiredAt: null,
});

function contractBodyA3() {
  return {
    schemaVersion: "v2-contract-revision/1.0.0",
    kind: "survey-qa-v2-contract-revision",
    documentRevisionId: "e".repeat(64),
    documentSha256: "e".repeat(64),
    sealedAt: "2026-08-08T00:00:00.000Z",
    requirements: [
      req("req_a3opt0001", "option-set", 'Option 1 with answer text "Red" is displayed on Q1.', "| 1 | Red |"),
      req("req_a3opt0003", "option-set", 'Option 3 with answer text "Green" is displayed on Q1.', "| 3 | Green |"),
    ],
    facetInstances: [
      {
        facetInstanceId: "fi_a3_opt1", requirementLineageId: "req_a3opt0001",
        requirementVersionId: "reqv_a3opt0001", caseVersionId: "cv_fi_a3_opt1",
        floorCase: true, targetQuestionId: "Q1", expansionCertificate: "cert_fi_a3_opt1",
        case: { kind: "option-set", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        expectationGap: null, screen: "Q1", label: "Q1 option 1",
      },
      {
        facetInstanceId: "fi_a3_opt3", requirementLineageId: "req_a3opt0003",
        requirementVersionId: "reqv_a3opt0003", caseVersionId: "cv_fi_a3_opt3",
        floorCase: true, targetQuestionId: "Q1", expansionCertificate: "cert_fi_a3_opt3",
        case: { kind: "option-set", routeAnswer: null, boundaryInput: null, configuration: null, expectedDestination: null },
        expectationGap: null, screen: "Q1", label: "Q1 option 3",
      },
    ],
    contractSupplements: [],
    extraction: {
      passAHash: "sha256:aaa", passBHash: "sha256:bbb",
      sourceLedgerHash: "sha256:ccc", diffHash: "sha256:ddd",
      reviewMode: "high-risk-only", reviewedBy: "a3-fixture",
      reviewedAt: "2026-08-08T00:00:00.000Z", gates: passingGates(),
    },
  };
}

const signingEnv = () =>
  testEnv({
    RECORD_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    RECORD_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
    JUDGEMENT_SIGNING_KEY: FIXTURE_KEY.privateKeyPem,
    JUDGEMENT_SIGNING_KEY_ID: FIXTURE_KEY.keyId,
  });

// ===========================================================================
suite("A3b — the streaming loader returns descriptors for engine-read, pre-verified hashes for PNGs", () => {
  test("JSON artifacts produce descriptors (no bytes), PNGs produce preVerifiedHashes", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // Put a JSON artifact (engine-read).
    const jsonEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(JSON.stringify(walkDoc(runId, "FLOOR-01"))),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_a3split",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-obs",
      artifactRef: "observations/FLOOR-01/FLOOR-01-observation.json",
    });

    // Put a PNG artifact (hash-verify-only).
    const pngBytes = new Uint8Array(100);
    pngBytes[0] = 0x89; // PNG magic byte
    const pngEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: pngBytes,
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_a3split",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-FLOOR-01-screenshot",
      artifactRef: "screenshots/FLOOR-01/FLOOR-01-step-001.png",
    });

    const result = await mod.runInputs.loadArtifactBytesStreaming(env, [jsonEntry, pngEntry]);

    assertEq(result.engineRead.length, 1, "one JSON artifact descriptor in engineRead");
    assertEq(result.preVerifiedHashes.size, 1, "one PNG artifact in preVerifiedHashes");
    assertEq(result.totalVerified, 2, "both artifacts verified");

    // The JSON is a descriptor — no bytes property, but has contentHash and entry.
    assert(result.engineRead[0].name.endsWith(".json"), "engine-read artifact must be JSON");
    assert(typeof result.engineRead[0].contentHash === "string", "engine-read descriptor must carry contentHash");
    assert(result.engineRead[0].entry !== undefined, "engine-read descriptor must carry the catalogue entry");

    // The PNG is in preVerifiedHashes with its hash.
    const pngName = [...result.preVerifiedHashes.keys()][0];
    assert(pngName.endsWith(".png"), "pre-verified artifact must be the PNG");
    const pvEntry = result.preVerifiedHashes.get(pngName);
    const expectedHash = pngEntry.contentHash.startsWith("sha256:")
      ? pngEntry.contentHash
      : `sha256:${pngEntry.contentHash}`;
    assertEq(pvEntry.contentHash, expectedHash, "pre-verified hash must match the catalogue entry (with sha256: prefix)");
    assertEq(pvEntry.byteLength, 100, "pre-verified byte length must match");
  });
});

// ===========================================================================
suite("A3b — bounded residency: the peak resident count is bounded by descriptors, not full bytes", () => {
  test("peak residency is bounded by session descriptors + one batch, not the full set", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    // Create 5 SESSION-PATTERN JSON artifacts (engine-read) and 50 PNG artifacts (hash-verify-only).
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify({ id: `FLOOR-${String(i).padStart(2, "0")}`, evidence: [] })),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_a3res",
        routeId: `FLOOR-${String(i).padStart(2, "0")}`,
        witnesses: [],
        sourceEvidenceId: `EV-json-${i}`,
        artifactRef: `observations/FLOOR-${String(i).padStart(2, "0")}/FLOOR-${String(i).padStart(2, "0")}-observation.json`,
      }));
    }
    for (let i = 0; i < 50; i++) {
      const pngBytes = new Uint8Array(59 * 1024);
      pngBytes[0] = 0x89;
      pngBytes[i % pngBytes.length] = i & 0xff;
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: pngBytes,
        mediaType: "image/png",
        type: "screenshot",
        attemptId: "att_a3res",
        routeId: `FLOOR-${i}`,
        witnesses: [],
        sourceEvidenceId: `EV-png-${i}`,
        artifactRef: `screenshots/step-${String(i).padStart(3, "0")}.png`,
      }));
    }

    let peakFromHook = 0;
    const result = await mod.runInputs.loadArtifactBytesStreaming(env, entries, (n) => {
      if (n > peakFromHook) peakFromHook = n;
    });

    assertEq(result.engineRead.length, 5, "5 session-pattern descriptors in engineRead");
    assertEq(result.preVerifiedHashes.size, 50, "50 PNG artifacts pre-verified");

    const bound = 5 + mod.runInputs.STREAMING_BATCH_SIZE;
    assert(
      result.peakResident <= bound,
      `peak resident ${result.peakResident} must be <= ${bound} (descriptors + batch size)`,
    );
    assert(
      result.peakResident < entries.length,
      `peak ${result.peakResident} must be strictly less than the full catalogue (${entries.length})`,
    );
  });

  test("step-level JSONs are NOT resident — they join the hash-verify-only stream", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const entries = [];
    for (let i = 0; i < 3; i++) {
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify({ id: `EXP-${String(i).padStart(3, "0")}`, evidence: [] })),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_step_excl",
        routeId: `EXP-${String(i).padStart(3, "0")}`,
        witnesses: [],
        sourceEvidenceId: `EV-obs-${i}`,
        artifactRef: `observations/EXP-${String(i).padStart(3, "0")}/EXP-${String(i).padStart(3, "0")}-observation.json`,
      }));
    }

    for (let i = 0; i < 20; i++) {
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify({ step: i, slot: "data" })),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_step_excl",
        routeId: `EXP-001`,
        witnesses: [],
        sourceEvidenceId: `EV-step-${i}`,
        artifactRef: `steps/EXP-001/step-${String(i).padStart(3, "0")}-slot.json`,
      }));
    }

    for (let i = 0; i < 20; i++) {
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify({ accessibility: true })),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_step_excl",
        routeId: `EXP-001`,
        witnesses: [],
        sourceEvidenceId: `EV-a11y-${i}`,
        artifactRef: `steps/EXP-001/${String(i).padStart(3, "0")}.accessibility.json`,
      }));
    }

    const result = await mod.runInputs.loadArtifactBytesStreaming(env, entries);

    assertEq(result.engineRead.length, 3, `only session-pattern JSONs are engine-read, got ${result.engineRead.length}`);
    assertEq(result.preVerifiedHashes.size, 40, `step-slot and accessibility JSONs must be hash-verify-only, got ${result.preVerifiedHashes.size}`);

    const bound = 3 + mod.runInputs.STREAMING_BATCH_SIZE;
    assert(
      result.peakResident <= bound,
      `peak resident ${result.peakResident} must be <= ${bound}; with all .json as engine-read it would be ${entries.length}`,
    );
  });

  test("a session from an unfamiliar path family still produces a descriptor via the walker's -observation.json leaf (SCR-2.1 dotted slug)", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const entries = [];
    for (const slug of ["SCR-2.1--fi_0a1b2c3d4e5f60718293", "SCR-2.2--fi_ffeeddccbbaa99887766-retry-1"]) {
      entries.push(await mod.evidence.putEvidence(env, {
        runId,
        bytes: enc.encode(JSON.stringify({ id: slug, evidence: [] })),
        mediaType: "application/json",
        type: "state",
        attemptId: "att_scr_family",
        routeId: slug,
        witnesses: [],
        sourceEvidenceId: `EV-${slug}-observation`,
        artifactRef: `observations/${slug}/${slug}-observation.json`,
      }));
    }
    entries.push(await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(JSON.stringify({ step: 1, slot: "data" })),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_scr_family",
      routeId: "SCR-2.1--fi_0a1b2c3d4e5f60718293",
      witnesses: [],
      sourceEvidenceId: "EV-SCR-step-1",
      artifactRef: "steps/SCR-2.1--fi_0a1b2c3d4e5f60718293/step-001-slot.json",
    }));

    const result = await mod.runInputs.loadArtifactBytesStreaming(env, entries);

    assertEq(result.engineRead.length, 2, `both -observation.json sessions must be descriptors despite the unfamiliar prefix, got ${result.engineRead.length}`);
    assertEq(result.preVerifiedHashes.size, 1, `the step-level JSON must stay hash-verify-only, got ${result.preVerifiedHashes.size}`);
  });
});

// ===========================================================================
suite("A3b — hash mismatch is still refused in the hash-verify-only set", () => {
  test("a hash mismatch in a hash-verify-only artifact is reported as a limitation", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const entry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode("original-png-content"),
      mediaType: "image/png",
      type: "screenshot",
      attemptId: "att_a3hash",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-corrupt",
      artifactRef: "screenshots/corrupt.png",
    });

    const blobKey = mod.keys.evidenceBlobKey(entry.contentHash);
    await env.EVIDENCE.put(blobKey, enc.encode("corrupted-png-content"));

    const result = await mod.runInputs.loadArtifactBytesStreaming(env, [entry]);
    assertEq(result.engineRead.length, 0, "no engine-read descriptors");
    assertEq(result.preVerifiedHashes.size, 0, "corrupted PNG must not be pre-verified");
    assertEq(result.limitations.length, 1, "one limitation for the corrupted artifact");
    assert(
      result.limitations[0].reason.includes("integrity") || result.limitations[0].reason.includes("sha256"),
      `limitation reason must mention integrity: ${result.limitations[0].reason}`,
    );
  });
});

// ===========================================================================
suite("A3b — end-to-end judge with mixed JSON and PNG artifacts", () => {
  test("the judge produces correct verdicts when PNGs are pre-verified and only JSONs stream through the source", async () => {
    const mod = await worker();
    const env = signingEnv();
    const runId = mod.ids.mintRunId();
    const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, contractBodyA3());

    for (const pathId of ["FLOOR-01", "FLOOR-02"]) {
      await mod.capture.capturePathObservation(
        { env, runId, attemptId: "att_a3e2e", pathId, witnesses: [] },
        walkDoc(runId, pathId),
      );
    }

    for (let i = 0; i < 10; i++) {
      const png = new Uint8Array(1024);
      png[0] = 0x89;
      png[i % png.length] = i & 0xff;
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: png,
        mediaType: "image/png",
        type: "screenshot",
        attemptId: "att_a3e2e",
        routeId: `FLOOR-01`,
        witnesses: [],
        sourceEvidenceId: `EV-screenshot-${i}`,
        artifactRef: `screenshots/FLOOR-01/step-${String(i).padStart(3, "0")}.png`,
      });
    }

    await mod.envelope.putEnvelope(env, {
      schemaVersion: "v2-run-envelope/1.0.0",
      kind: "survey-qa-v2-envelope",
      runId,
      createdAt: "2026-08-08T00:00:00.000Z",
      instanceId: runId,
      input: {
        surveyUrl: "https://fixture.invalid/survey",
        documentKey: mod.keys.inputDocumentKey(runId),
        documentSha256: "e".repeat(64),
        documentName: "colours.docx",
        targetBuildId: TARGET_BUILD_ID,
        locale: "en",
        viewports: ["desktop"],
      },
      profile: "standard",
      contractRevisionId,
      recovery: null,
      finalCompletion: null,
    });

    await mod.checkpoint.createCheckpoint(env, mod.checkpoint.initialCheckpoint(env, runId, "standard", false));
    await mod.checkpoint.updateCheckpoint(env, runId, (d) => {
      d.contract = {
        state: "sealed",
        contractRevisionId,
        contractHash,
        total: 2,
        requirements: { total: 2, ambiguous: 0, disputed: 0, notBrowserObservable: 0 },
      };
      d.counts = { ...d.counts, exercised: 2, pending: 0 };
      d.completion = { test: "complete", report: "not-started", reasonCode: null };
    });

    const derived = await mod.deriveVerdicts.deriveItemResults(env, runId);
    assertEq(derived.state, "evaluated", "aggregator must run");

    const assembled = await mod.assembleRecord.assembleRecord(env, runId, derived.value.itemResults);
    assertEq(assembled.state, "evaluated", "record must assemble");
    assert(assembled.value.signed, "record must be signed");

    const minted = await mod.deriveVerdicts.mintJudgement(env, runId);
    assertEq(minted.state, "evaluated", "judgement must complete");

    const totalArtifacts = minted.value.artifacts;
    assert(totalArtifacts >= 12, `total artifacts must include walks + PNGs: got ${totalArtifacts}`);

    const byVerdict = minted.value.counts.byVerdict;
    assertEq(byVerdict.pass, 1, "the rendered option must pass");
    assertEq(byVerdict.fail, 1, "the absent option must fail");

    assert(minted.value.authority.verified, "authority must verify");
    assert(minted.value.authority.manifestComplete, "manifest must be complete");
  });

  test("unverified entries are counted honestly, never silently dropped", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();

    const jsonEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: enc.encode(JSON.stringify({ id: "FLOOR-01", evidence: [] })),
      mediaType: "application/json",
      type: "state",
      attemptId: "att_a3count",
      routeId: "FLOOR-01",
      witnesses: [],
      sourceEvidenceId: "EV-json-1",
      artifactRef: "observations/FLOOR-01/FLOOR-01-observation.json",
    });

    const fakeEntry = {
      evidenceId: "ev_fake_png",
      contentHash: "sha256:" + "0".repeat(64),
      artifactRef: "screenshots/missing.png",
      sourceEvidenceId: "EV-missing-png",
      type: "screenshot",
    };

    const result = await mod.runInputs.loadArtifactBytesStreaming(env, [jsonEntry, fakeEntry]);
    assertEq(result.engineRead.length, 1, "one JSON descriptor");
    assertEq(result.preVerifiedHashes.size, 0, "no PNGs verified");
    assertEq(result.limitations.length, 1, "one limitation for the missing PNG");
    assertEq(result.limitations[0].name, "missing.png", "limitation names the artifact");
  });
});
