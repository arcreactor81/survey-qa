/**
 * Screen evidence API — bounded, paginated read-only projection of captured screen epochs.
 *
 * Discovery comes ONLY from the immutable walk artifact index. Every typed modality
 * (screenshot, extracted JSON, PDF, accessibility) is exact-bound to its catalog row. Raw
 * failure text, target URLs, and storage keys never serialize. Pagination advances over
 * walk+epoch cursor positions. The renderer remains network-free (all content behind the
 * evidence endpoint, which re-hashes on open).
 *
 * The deliberately-broken-binding test ("a mismatched catalog binding is a named limitation")
 * proves the test CAN fail: a modality that does not exactly match its catalog row produces a
 * named limitation, not a silent absence. Without this, a test suite that never mismatches
 * anything would trivially pass with a stub returning empty limitations.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { seedRun, testEnv, worker } from "./_helpers.mjs";

const PLAN_REVISION_ID = "plan_screen_evidence_01";
const AT = "2026-08-13T01:00:00.000Z";
const utf8 = new TextEncoder();

function captureFailure(kind, stepIndex = 0, slot = "before") {
  return {
    kind,
    detail: "test failure detail",
    count: 1,
    at: AT,
    stepIndex,
    slot,
  };
}

/**
 * Store one modality's evidence and return a valid ScreenArtifactRef that exactly matches
 * the catalog entry, so the endpoint's exact-binding predicates will pass.
 */
async function storeModality(mod, env, runId, kind, mediaType, bytes, pathId, attemptId, stepIndex, slot) {
  const catalogType = kind === "screen-json" ? "dom-excerpt"
    : kind === "screenshot" ? "screenshot"
    : kind === "accessibility" ? "state"
    : "other";
  const sourceEvidenceId = `EV-${pathId}-${stepIndex}-${slot}-${kind}`;
  const artifactRef = `captures/${stepIndex}-${slot}-${kind}`;
  const entry = await mod.evidence.putEvidence(env, {
    runId,
    bytes,
    mediaType,
    type: catalogType,
    sourceEvidenceId,
    artifactRef,
    attemptId,
    routeId: pathId,
    witnesses: [],
  });
  return {
    kind,
    evidenceId: entry.evidenceId,
    artifactRef: entry.artifactRef,
    sourceEvidenceId: entry.sourceEvidenceId,
    contentHash: entry.contentHash,
    mediaType: entry.mediaType,
    size: entry.size,
  };
}

async function buildEpoch(mod, env, runId, pathId, attemptId, stepIndex, slot, opts = {}) {
  const screenJsonRef = await storeModality(
    mod, env, runId, "screen-json", "application/json",
    utf8.encode(JSON.stringify({ q: `question-${stepIndex}` })),
    pathId, attemptId, stepIndex, slot,
  );
  const screenshotRef = opts.screenshotFailed ? null : await storeModality(
    mod, env, runId, "screenshot", "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, stepIndex]),
    pathId, attemptId, stepIndex, slot,
  );
  const accessibilityRef = opts.accessibilityFailed ? null : await storeModality(
    mod, env, runId, "accessibility", "application/json",
    utf8.encode(JSON.stringify({ role: "root", name: `ax-${stepIndex}` })),
    pathId, attemptId, stepIndex, slot,
  );
  const pdfRef = (opts.v1 || opts.pdfFailed) ? null : await storeModality(
    mod, env, runId, "rendered-pdf", "application/pdf",
    new Uint8Array([0x25, 0x50, 0x44, 0x46, stepIndex]),
    pathId, attemptId, stepIndex, slot,
  );

  const failures = [];
  const screenshot = screenshotRef
    ? { status: "captured", ref: screenshotRef }
    : { status: "failed", failure: captureFailure("screenshot-capture-failed", stepIndex, slot) };
  const accessibility = accessibilityRef
    ? { status: "captured", ref: accessibilityRef, completeness: "complete", limitations: [] }
    : { status: "failed", failure: captureFailure("accessibility-api-unavailable", stepIndex, slot) };

  if (!screenshotRef) failures.push(screenshot.failure);
  if (!accessibilityRef) failures.push(accessibility.failure);

  if (opts.v1) {
    return {
      kind: "v2-screen-capture-epoch/1.0.0",
      epochId: `epoch_${stepIndex}_${slot}`,
      stepIndex,
      slot,
      scope: { kind: "viewport", tileIndex: null, tileCount: null },
      startedAt: AT,
      endedAt: "2026-08-13T01:00:01.000Z",
      screenReadAt: AT,
      screenSignatureHash: "a".repeat(64),
      geometry: {
        source: "browser", width: 1280, height: 900,
        documentWidth: 1280, documentHeight: 2400,
        scrollX: 0, scrollY: 0, deviceScaleFactor: 1,
      },
      screenJson: screenJsonRef,
      screenshot,
      accessibility,
      captureFailures: failures,
      captureFailureCount: failures.reduce((s, f) => s + f.count, 0),
    };
  }

  const pdf = pdfRef
    ? { status: "captured", ref: pdfRef }
    : { status: "failed", failure: captureFailure("pdf-capture-timeout", stepIndex, slot) };
  if (!pdfRef) failures.push(pdf.failure);

  return {
    kind: "v2-screen-capture-epoch/1.1.0",
    epochId: `epoch_${stepIndex}_${slot}`,
    stepIndex,
    slot,
    scope: { kind: "viewport", tileIndex: null, tileCount: null },
    startedAt: AT,
    endedAt: "2026-08-13T01:00:01.000Z",
    screenReadAt: AT,
    screenSignatureHash: "a".repeat(64),
    geometry: {
      source: "browser", width: 1280, height: 900,
      documentWidth: 1280, documentHeight: 2400,
      scrollX: 0, scrollY: 0, deviceScaleFactor: 1,
    },
    screenJson: screenJsonRef,
    screenshot,
    pdf,
    accessibility,
    captureFailures: failures,
    captureFailureCount: failures.reduce((s, f) => s + f.count, 0),
  };
}

function observation(runId, pathId, attemptId, epochs) {
  const allFailures = epochs.flatMap((e) => e.captureFailures);
  const allEvidenceIds = [];
  for (const epoch of epochs) {
    allEvidenceIds.push(epoch.screenJson.evidenceId);
    if (epoch.screenshot.status === "captured") allEvidenceIds.push(epoch.screenshot.ref.evidenceId);
    if (epoch.accessibility?.status === "captured") allEvidenceIds.push(epoch.accessibility.ref.evidenceId);
    if (epoch.pdf?.status === "captured") allEvidenceIds.push(epoch.pdf.ref.evidenceId);
  }
  return {
    kind: "v2-path-observation/1.0.0",
    runId,
    pathId,
    tier: 1,
    attemptId,
    planRevisionId: PLAN_REVISION_ID,
    surveyUrl: "https://survey.example.test/s",
    startedAt: AT,
    endedAt: "2026-08-13T01:00:02.000Z",
    wallMs: 2000,
    plannedWitnesses: [],
    steps: [],
    outcome: "completed",
    outcomeDetail: null,
    ending: { kind: "completed", evidence: ["survey reached its end screen"] },
    shimmed: false,
    shimNote: null,
    loadFailure: null,
    unboundDecisions: [],
    bindingRefusalCount: 0,
    readerLimitations: [],
    readerLimitationCount: 0,
    navigatorDefaultAnswerCount: 0,
    evidenceIds: allEvidenceIds,
    viewport: { width: 1280, height: 900 },
    screenCaptures: epochs,
    screenCaptureCount: epochs.length,
    captureFailures: allFailures,
    captureFailureCount: allFailures.reduce((s, f) => s + f.count, 0),
    unfillableControls: [],
    unfillableControlCount: 0,
  };
}

function walkRow(pathId, attemptId) {
  return {
    pathId,
    tier: 1,
    attemptId,
    outcome: "completed",
    outcomeDetail: null,
    steps: 0,
    wallMs: 2000,
    shimmed: false,
    loadCrash: false,
    evidenceCount: 0,
    caseIds: [],
    exercised: false,
    plannedDecisions: 0,
    matchedDecisions: 0,
    constrainingDecisions: 0,
    matchedConstraining: 0,
    screensAdvanced: 0,
    blockedSteps: 0,
    ending: { kind: "completed", evidence: ["survey reached its end screen"] },
    unboundDecisions: [],
    bindingRefusalCount: 0,
    readerLimitations: [],
    readerLimitationCount: 0,
    at: AT,
  };
}

/**
 * Create a complete test bed with a seeded run, walk artifact entries, and an index.
 */
async function screenEvidenceBed({
  walkCount = 1,
  epochsPerWalk = 2,
  v1Epochs = false,
  pdfFailed = false,
  screenshotFailed = false,
  accessibilityFailed = false,
  withIndex = true,
  mutateScreenJsonHash = false,
} = {}) {
  const mod = await worker();
  const env = testEnv();
  const seeded = await seedRun(mod, env);
  const runId = seeded.runId;

  const walks = [];
  const catalogEntries = [];

  for (let w = 0; w < walkCount; w++) {
    const pathId = `path_screen_${w}`;
    const attemptId = `attempt_screen_${w}_${runId.slice(-8)}`;
    const epochs = [];
    for (let e = 0; e < epochsPerWalk; e++) {
      const epoch = await buildEpoch(mod, env, runId, pathId, attemptId, e, `slot_${e}`, {
        v1: v1Epochs, pdfFailed, screenshotFailed, accessibilityFailed,
      });
      epochs.push(epoch);
    }

    if (mutateScreenJsonHash && w === 0 && epochs.length > 0) {
      // Corrupt the first epoch's screen-json contentHash so the catalog binding fails.
      // This must be done BEFORE the observation bytes are serialized and validated.
      epochs[0].screenJson = { ...epochs[0].screenJson, contentHash: "b".repeat(64) };
    }

    const obs = observation(runId, pathId, attemptId, epochs);
    const obsBytes = utf8.encode(JSON.stringify(obs));

    // Only validate when we haven't mutated the hash -- a mutated hash is deliberately
    // invalid for the binding test, but the observation bytes ARE valid JSON structure.
    // The validator does not check cross-references to the catalog, only the envelope shape.
    mod.visualWork.validatePathObservationBytes(obsBytes);

    const artifactEntry = await mod.evidence.putEvidence(env, {
      runId,
      bytes: obsBytes,
      mediaType: "application/json",
      type: "state",
      sourceEvidenceId: `EV-${pathId}-observation`,
      artifactRef: `walks/${attemptId}.json`,
      attemptId,
      routeId: pathId,
      witnesses: [],
    });
    catalogEntries.push(artifactEntry);
    walks.push(walkRow(pathId, attemptId));
  }

  if (withIndex) {
    // Collect ALL catalog entries from the bucket -- the walk-artifact-index builder
    // needs them to resolve walk->artifact bindings.
    const allCatalogEntries = [];
    const listed = await env.EVIDENCE.list();
    for (const obj of listed.objects) {
      if (obj.key.startsWith(`v2/${runId}/catalog/`)) {
        const body = await (await env.EVIDENCE.get(obj.key)).text();
        allCatalogEntries.push(JSON.parse(body));
      }
    }
    const index = mod.walkArtifactIndex.buildWalkArtifactIndex({
      runId,
      planRevisionId: PLAN_REVISION_ID,
      walks,
      catalog: allCatalogEntries.length > 0 ? allCatalogEntries : catalogEntries,
    });
    await mod.walkArtifactIndex.putWalkArtifactIndex(
      env.EVIDENCE,
      mod.keys.walkArtifactIndexKey(runId),
      index,
    );
  }

  return { mod, env, runId, walks, catalogEntries };
}

async function getScreens(bed, query = "") {
  const url = `https://v2.invalid/api/v2/runs/${bed.runId}/screens${query}`;
  const response = await bed.mod.apiScreens.getScreens(
    new Request(url, { headers: { accept: "application/json" } }),
    bed.env,
    bed.runId,
  );
  return { response, body: await response.json() };
}

suite("screen evidence API: guard rails and modality binding", () => {
  test("a non-v2 run id is refused before any storage access", async () => {
    const mod = await worker();
    const env = testEnv();
    const response = await mod.apiScreens.getScreens(
      new Request("https://v2.invalid/api/v2/runs/legacy-run-000/screens"),
      env,
      "legacy-run-000",
    );
    assertEq(response.status, 404);
    const body = await response.json();
    assertEq(body.error.code, "NOT_A_V2_RUN");
  });

  test("an unsupported query parameter is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?unexpected=1");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_QUERY_INVALID");
  });

  test("limit=0 is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?limit=0");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_LIMIT_INVALID");
  });

  test("limit=21 is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?limit=21");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_LIMIT_INVALID");
  });

  test("limit=abc is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?limit=abc");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_LIMIT_INVALID");
  });

  test("a cursor with bad format is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?cursor=notacursor");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_CURSOR_INVALID");
  });

  test("a duplicate cursor parameter is refused", async () => {
    const bed = await screenEvidenceBed();
    const { response, body } = await getScreens(bed, "?cursor=0:0&cursor=0:1");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_CURSOR_INVALID");
  });

  test("a cursor past the last walk is refused", async () => {
    const bed = await screenEvidenceBed({ walkCount: 1 });
    const { response, body } = await getScreens(bed, "?cursor=5:0");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_CURSOR_INVALID");
  });
});

suite("screen evidence API: missing walk index -> unavailable with named limitation", () => {
  test("no walk index produces state unavailable with walk-artifact-index-missing limitation", async () => {
    const bed = await screenEvidenceBed({ withIndex: false });
    const { response, body } = await getScreens(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.schemaVersion, "survey-qa-screen-evidence-page/1.0.0");
    assertEq(body.state, "unavailable");
    assertEq(body.entries.length, 0);
    assertEq(body.nextCursor, null);
    assertEq(body.denominator, null);
    assert(body.indexLimitations.length > 0, "missing index must produce at least one named limitation");
    assertEq(body.indexLimitations[0].kind, "walk-artifact-index-missing");
  });
});

suite("screen evidence API: happy path with catalog-bound modalities", () => {
  test("a single walk with two v1.1 epochs returns catalog-bound modalities and zero raw content", async () => {
    const bed = await screenEvidenceBed({ walkCount: 1, epochsPerWalk: 2, v1Epochs: false });
    const { response, body } = await getScreens(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.schemaVersion, "survey-qa-screen-evidence-page/1.0.0");
    assertEq(body.state, "available");
    assertEq(body.runId, bed.runId);

    assert(body.denominator !== null, "denominator must be present");
    assertEq(body.denominator.walks, 1);

    const screens = body.entries.filter((e) => e.kind === "captured-screen");
    assertEq(screens.length, 2, "two captured-screen entries expected");

    for (const screen of screens) {
      assertEq(screen.extractedJson.status, "catalog-bound");
      assertEq(screen.extractedJson.verification, "on-content-request");
      assert(typeof screen.extractedJson.evidenceId === "string", "extractedJson must have evidenceId");
      assert(screen.extractedJson.href.startsWith("/api/v2/runs/"), "extractedJson href must be a relative API path");

      assertEq(screen.screenshot.status, "catalog-bound");
      assert(typeof screen.screenshot.evidenceId === "string", "screenshot must have evidenceId");

      assertEq(screen.pdf.status, "catalog-bound");
      assert(typeof screen.pdf.evidenceId === "string", "pdf must have evidenceId");

      assertEq(screen.accessibility.status, "catalog-bound");
      assert(typeof screen.accessibility.evidenceId === "string", "accessibility must have evidenceId");
    }

    // No raw-content leakage in the full body
    const serialized = JSON.stringify(body);
    assert(!serialized.includes("test failure detail"), "raw failure detail must not leak");
    assert(!serialized.includes("survey.example.test/s"), "survey URL must not leak into screen evidence");
  });

  test("a v1 epoch without PDF produces pdf status not-recorded with named limitation", async () => {
    const bed = await screenEvidenceBed({ walkCount: 1, epochsPerWalk: 1, v1Epochs: true });
    const { response, body } = await getScreens(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    const screen = body.entries.find((e) => e.kind === "captured-screen");
    assert(screen !== undefined, "should have a captured-screen entry");
    assertEq(screen.pdf.status, "not-recorded", "v1 epoch PDF should be not-recorded");
    assertEq(screen.pdf.reason, "pdf-not-recorded-by-reader");
  });
});

suite("screen evidence API: mismatched catalog binding -> named limitation, not silent absence", () => {
  test("a mismatched catalog binding produces a named limitation and the test can fail", async () => {
    // The screen JSON ref's contentHash is mutated to differ from the catalog entry.
    // The endpoint should report evidence-reference-catalog-mismatch, not silently omit it.
    const bed = await screenEvidenceBed({
      walkCount: 1,
      epochsPerWalk: 1,
      v1Epochs: false,
      mutateScreenJsonHash: true,
    });
    const { response, body } = await getScreens(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    const screen = body.entries.find((e) => e.kind === "captured-screen");
    assert(screen !== undefined, "should still have a captured-screen entry");
    // The extracted JSON modality should be unavailable due to the mismatch
    assertEq(
      screen.extractedJson.status,
      "unavailable",
      "mismatched catalog must make the modality unavailable, not silently absent",
    );

    // The limitations array must contain a named binding failure
    const bindingLimit = screen.limitations.find(
      (l) => l.kind === "evidence-reference-catalog-mismatch" || l.kind === "evidence-catalog-entry-missing",
    );
    assert(bindingLimit !== undefined, "limitations must include the named binding failure");
  });

  test("NEGATIVE: without hash mutation the same modality is catalog-bound", async () => {
    const bed = await screenEvidenceBed({
      walkCount: 1,
      epochsPerWalk: 1,
      v1Epochs: false,
      mutateScreenJsonHash: false,
    });
    const { response, body } = await getScreens(bed);
    assertEq(response.status, 200, JSON.stringify(body));
    const screen = body.entries.find((e) => e.kind === "captured-screen");
    assert(screen !== undefined, "should have a captured-screen entry");
    assertEq(
      screen.extractedJson.status,
      "catalog-bound",
      "without mismatch, the modality must be catalog-bound",
    );
  });
});

suite("screen evidence API: pagination across walks with cursor round-trip", () => {
  test("pagination with limit=1 iterates every entry with correct cursor advancement", async () => {
    const bed = await screenEvidenceBed({ walkCount: 2, epochsPerWalk: 2, v1Epochs: false });

    let { response, body } = await getScreens(bed, "?limit=1");
    assertEq(response.status, 200, JSON.stringify(body));
    assertEq(body.entries.length, 1, "first page should have 1 entry");

    const allEntries = [...body.entries];
    let cursor = body.nextCursor;
    let pages = 1;
    const MAX_PAGES = 20;

    while (cursor !== null && pages < MAX_PAGES) {
      ({ response, body } = await getScreens(bed, `?limit=1&cursor=${encodeURIComponent(cursor)}`));
      assertEq(response.status, 200, `page ${pages + 1} failed: ${JSON.stringify(body)}`);
      allEntries.push(...body.entries);
      cursor = body.nextCursor;
      pages++;
    }

    // Every entry must have a unique cursor
    const cursors = allEntries.map((e) => e.cursor);
    const uniqueCursors = new Set(cursors);
    assertEq(cursors.length, uniqueCursors.size, "every entry must have a unique cursor");

    // At least 4 captured-screen entries from 2 walks x 2 epochs
    const screens = allEntries.filter((e) => e.kind === "captured-screen");
    assert(screens.length >= 4, `expected at least 4 captured-screen entries, got ${screens.length}`);

    // Cursor positions must be strictly monotonic
    for (let i = 1; i < allEntries.length; i++) {
      const prev = allEntries[i - 1];
      const curr = allEntries[i];
      assert(
        curr.walkOrdinal > prev.walkOrdinal ||
          (curr.walkOrdinal === prev.walkOrdinal && curr.epochOrdinal > prev.epochOrdinal),
        `entries must be in strict cursor order: ${prev.cursor} -> ${curr.cursor}`,
      );
    }
  });

  test("requesting a cursor that names a valid walk but invalid epoch is refused", async () => {
    const bed = await screenEvidenceBed({ walkCount: 1, epochsPerWalk: 2 });
    const { response, body } = await getScreens(bed, "?cursor=0:999");
    assertEq(response.status, 400);
    assertEq(body.error.code, "SCREEN_EVIDENCE_CURSOR_INVALID");
  });
});
