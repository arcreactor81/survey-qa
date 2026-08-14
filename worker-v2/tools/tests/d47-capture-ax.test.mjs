/**
 * D47 — ONE SCREEN, THREE BOUND REPRESENTATIONS.
 *
 * The visual reader cannot safely reconcile a PNG, DOM projection and accessibility tree if
 * they are merely adjacent files. These tests exercise the real capture writer and real walk:
 * exact hashes/media types/epoch metadata pair them, Puppeteer's live `elementHandle()` never
 * reaches JSON, and every missing or truncated modality is named and counted.
 *
 * The negative page is the evidence this gate can fail: screenshot, geometry and AX capture all
 * fail independently while the screen JSON still lands. If any catch becomes silent, its exact
 * failure kind/count assertion goes red.
 */

import { assert, assertEq, suite, test } from "../testkit.mjs";
import { testEnv, worker } from "./_helpers.mjs";

const ATTEMPT_ID = "att_d47000000001";
const PATH_ID = "path_d47000000001";

const screen = () => ({
  at: "2026-08-09T12:00:00.000Z",
  url: "https://fixture.invalid/survey",
  title: "Q1",
  collectedErrors: [],
  questionText: "Which therapies are you aware of?",
  instructionText: "Select all that apply",
  visibleText: "Which therapies are you aware of? NURTEC Next",
  visibleTextTruncated: false,
  bracketedInstructionsVisible: [],
  controls: [],
  optionGroups: [],
  grid: null,
  buttons: [],
  progress: { present: false, kind: null, now: null, max: null, text: null },
  validationMessages: [],
  readerLimitations: [],
  counts: { controls: 0, optionGroups: 0, options: 0, textInputs: 0, valueInputs: 0 },
  // Deliberately 24 lowercase hex characters. A broken writer that copies capture content
  // directly into `epoch_${...}` would still pass the closed-format regex below; the exact
  // digest assertion must be what makes that raw-content leak counterexample fail.
  screenSignature: "2026080912000000deadbeef",
});

const geometry = {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1.25,
  scrollX: 17,
  scrollY: 240,
  documentWidth: 1280,
  documentHeight: 2600,
};

const axTree = () => ({
  role: "RootWebArea",
  name: "Survey",
  elementHandle() {
    throw new Error("a live browser handle must never be invoked or serialised");
  },
  browserPrivateField: "must-not-cross-the-boundary",
  children: [
    { role: "heading", name: "Which therapies are you aware of?", level: 1 },
    { role: "checkbox", name: "NURTEC", checked: false, required: true },
    { role: "button", name: "Next", disabled: false },
  ],
});

function goodPage(s = screen()) {
  const snapshotOptions = [];
  return {
    snapshotOptions,
    async goto() {},
    async evaluate(script) {
      if (typeof script === "string" && script.includes("screenSignature")) return s;
      if (typeof script === "string" && script.includes("documentWidth")) return geometry;
      return { ok: true };
    },
    async evaluateOnNewDocument() {},
    async $$() {
      return [];
    },
    async screenshot() {
      return new TextEncoder().encode("PNG-D47");
    },
    accessibility: {
      async snapshot(opts) {
        snapshotOptions.push(opts);
        return axTree();
      },
    },
    async setViewport() {},
    on() {},
    async close() {},
    async reload() {},
  };
}

const cap = (env, runId) => ({ env, runId, attemptId: ATTEMPT_ID, pathId: PATH_ID, witnesses: [] });

suite("D47 — screenshot, screen JSON and Chrome AX are one hash-bound epoch", () => {
  test("the real capture path stores typed refs, geometry and a handle-free full AX tree", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const rendered = screen();
    const page = goodPage(rendered);

    const epoch = await mod.driver.captureScreenEpoch(
      page,
      cap(env, runId),
      rendered,
      "before",
      3,
      { width: 1280, height: 900 },
    );

    assertEq(epoch.kind, "v2-screen-capture-epoch/1.0.0");
    assert(/^epoch_[a-f0-9]{24}$/.test(epoch.epochId), `epoch id is not opaque: ${epoch.epochId}`);
    const identityInputs = [
      runId,
      ATTEMPT_ID,
      PATH_ID,
      3,
      "before",
      rendered.at,
      rendered.screenSignature,
    ];
    const expectedDigest = await mod.hash.sha256Hex(JSON.stringify(identityInputs));
    assertEq(
      epoch.epochId,
      `epoch_${expectedDigest.slice(0, 24)}`,
      "epoch identity must be the reproducible SHA-256 binding of the canonical capture identity inputs",
    );
    const rawLeakCounterexample = `epoch_${rendered.screenSignature}`;
    assert(
      /^epoch_[a-f0-9]{24}$/.test(rawLeakCounterexample),
      "the leak counterexample must pass the format check or the exact digest check is vacuous",
    );
    assert(
      epoch.epochId !== rawLeakCounterexample,
      "a hex-valid capture signature crossed the epoch identity boundary without hashing",
    );
    assertEq(epoch.stepIndex, 3);
    assertEq(epoch.slot, "before");
    assertEq(epoch.scope.kind, "viewport");
    assertEq(epoch.scope.tileIndex, null);
    assertEq(epoch.screenReadAt, "2026-08-09T12:00:00.000Z");
    assertEq(epoch.geometry.deviceScaleFactor, 1.25);
    assertEq(epoch.geometry.scrollY, 240);
    assertEq(epoch.geometry.source, "browser");
    assertEq(epoch.captureFailureCount, 0, JSON.stringify(epoch.captureFailures));
    assertEq(epoch.screenshot.status, "captured");
    assertEq(epoch.accessibility.status, "captured");
    assertEq(epoch.accessibility.completeness, "complete");
    assertEq(page.snapshotOptions.length, 1);
    assertEq(page.snapshotOptions[0].interestingOnly, false, "a filtered AX tree cannot support absence claims");

    const refs = [epoch.screenJson, epoch.screenshot.ref, epoch.accessibility.ref];
    assertEq(new Set(refs.map((r) => r.evidenceId)).size, 3);
    assertEq(refs[0].mediaType, "application/json");
    assertEq(refs[1].mediaType, "image/png");
    assertEq(refs[2].mediaType, "application/json");
    for (const ref of refs) {
      assert(/^[a-f0-9]{64}$/.test(ref.contentHash), `missing exact sha256 on ${JSON.stringify(ref)}`);
      assert(ref.size > 0, `empty artifact ref ${JSON.stringify(ref)}`);
    }

    const entry = await mod.evidence.getCatalogEntry(env, runId, epoch.accessibility.ref.evidenceId);
    assert(entry, "the AX ref must resolve in the immutable catalogue");
    const verified = await mod.evidence.getVerifiedEvidence(env, entry);
    const artifact = JSON.parse(new TextDecoder().decode(verified.bytes));
    assertEq(artifact.kind, "v2-accessibility-snapshot/1.0.0");
    assertEq(artifact.epochId, epoch.epochId);
    assertEq(artifact.scope.kind, "viewport");
    assertEq(artifact.pairing.screenJson.contentHash, epoch.screenJson.contentHash);
    assertEq(artifact.pairing.screenshot.contentHash, epoch.screenshot.ref.contentHash);
    assertEq(artifact.capture.interestingOnly, false);
    assertEq(artifact.capture.serializedBytes, verified.bytes.byteLength);
    assertEq(artifact.tree.children[1].name, "NURTEC");
    assert(!("elementHandle" in artifact.tree), "live elementHandle crossed the evidence boundary");
    assert(!("browserPrivateField" in artifact.tree), "an unrecognised Puppeteer field crossed the allowlist");
  });

  test("node/depth/value caps produce named, counted truncation instead of a quietly shorter tree", async () => {
    const mod = await worker();
    const raw = {
      role: "root",
      name: "123456789",
      children: [
        { role: "one", children: [{ role: "too-deep" }] },
        { role: "over-node-budget" },
      ],
    };
    const out = mod.driver.sanitizeAccessibilitySnapshot(raw, { maxNodes: 2, maxDepth: 1, maxValueChars: 4 });
    assert(out.tree, out.error ?? "no sanitised tree");
    const byKind = new Map(out.limitations.map((l) => [l.kind, l.count]));
    assert((byKind.get("accessibility-snapshot-value-limit") ?? 0) > 0, JSON.stringify(out.limitations));
    assert((byKind.get("accessibility-snapshot-node-limit") ?? 0) > 0, JSON.stringify(out.limitations));
    // Run depth independently: the node cap above reaches first by design.
    const depth = mod.driver.sanitizeAccessibilitySnapshot(raw, { maxNodes: 10, maxDepth: 1, maxValueChars: 50 });
    assert(
      (depth.limitations.find((l) => l.kind === "accessibility-snapshot-depth-limit")?.count ?? 0) > 0,
      JSON.stringify(depth.limitations),
    );
  });

  test("failed geometry, PNG and AX are three explicit failures; screen JSON is not lost", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const page = {
      async evaluate() {
        throw new Error("geometry transport down");
      },
      async screenshot() {
        throw new Error("PNG transport down");
      },
      // accessibility is ABSENT on purpose — not a null/empty tree.
    };
    const epoch = await mod.driver.captureScreenEpoch(
      page,
      cap(env, runId),
      screen(),
      "blocked",
      4,
      { width: 1024, height: 768 },
    );

    assertEq(epoch.screenJson.kind, "screen-json");
    assertEq(epoch.geometry.source, "configured-fallback");
    assertEq(epoch.geometry.deviceScaleFactor, null);
    assertEq(epoch.screenshot.status, "failed");
    assertEq(epoch.accessibility.status, "failed");
    assertEq(epoch.captureFailureCount, 3, JSON.stringify(epoch.captureFailures));
    assertEq(
      epoch.captureFailures.map((f) => f.kind).sort().join(","),
      ["accessibility-api-unavailable", "capture-metadata-failed", "screenshot-capture-failed"].sort().join(","),
    );
    const catalog = await mod.evidence.listCatalog(env, runId);
    assertEq(catalog.length, 1, "only the successfully captured screen JSON should be catalogued");
  });
});

suite("D47 — the real walker preserves legacy ids and adds paired epochs", () => {
  test("a terminal screen carries before/final PNG+AX refs at both step and walk scope", async () => {
    const mod = await worker();
    const env = testEnv();
    const runId = mod.ids.mintRunId();
    const page = goodPage();
    const obs = await mod.driver.walkPath(
      page,
      { id: PATH_ID, decisions: [], witnesses: [] },
      {
        surveyUrl: "https://fixture.invalid/survey",
        runId,
        planRevisionId: "plan_d47test01",
        attemptId: ATTEMPT_ID,
        tier: 1,
        maxSteps: 1,
        deadline: Date.now() + 30_000,
        viewport: { width: 1280, height: 900 },
        applyHistoryShim: false,
        advanceTimeoutMs: 200,
      },
      cap(env, runId),
    );

    assertEq(obs.screenCaptureCount, 2, JSON.stringify(obs.screenCaptures));
    assertEq(new Set(obs.screenCaptures.map((epoch) => epoch.epochId)).size, 2, "slot must participate in opaque epoch identity");
    assertEq(obs.captureFailureCount, 0, JSON.stringify(obs.captureFailures));
    assertEq(obs.steps.length, 1);
    const evidence = obs.steps[0].evidence;
    assertEq(evidence.screenCaptures.length, 2);
    assertEq(evidence.screenshots.length, 2, "the legacy list remains and now names both exact screen epochs");
    assertEq(evidence.screenBefore, evidence.screenCaptures[0].screenJson.evidenceId);
    assertEq(evidence.screenAfterAdvance, evidence.screenCaptures[1].screenJson.evidenceId);
    assertEq(evidence.captureFailureCount, 0);
    assertEq(evidence.captureFailures.length, 0, "present-and-empty means this reader checked every modality");
  });
});
