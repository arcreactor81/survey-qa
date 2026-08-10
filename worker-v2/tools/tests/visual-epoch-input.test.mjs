/** Strict proof that a visual-work row cannot bypass exact catalog, bytes, or AX pairing. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-epoch-input-test-"));
const bundlePath = path.join(bundleDir, "visual-epoch-input.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as loader from ${p("src/vision/epoch-input.ts")};`,
      `export * as visualWork from ${p("src/store/visual-work.ts")};`,
      `export * as evidence from ${p("src/store/evidence.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as ids from ${p("src/ids.ts")};`,
      `export * as observe from ${p("src/vision/observe.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-epoch-input-test-entry.ts",
    loader: "ts",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const mod = await import(pathToFileURL(bundlePath).href);
const enc = new TextEncoder();
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const at = (second) => `2026-08-09T12:00:${String(second).padStart(2, "0")}.000Z`;

function png(width = 100, height = 80) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const geometry = () => ({
  width: 100,
  height: 80,
  deviceScaleFactor: 1,
  scrollX: 0,
  scrollY: 0,
  documentWidth: 100,
  documentHeight: 160,
  source: "browser",
});

const scope = () => ({ kind: "viewport", tileIndex: null, tileCount: null });

function ref(entry, kind) {
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

function failure(kind = "accessibility-api-unavailable") {
  return {
    kind,
    detail: `${kind} fixture`,
    count: 1,
    at: at(2),
    stepIndex: 0,
    slot: "before",
  };
}

function settleArtifactBytes(artifact) {
  for (let pass = 0; pass < 10; pass += 1) {
    const bytes = enc.encode(JSON.stringify(artifact));
    if (artifact.capture.serializedBytes === bytes.byteLength) return bytes;
    artifact.capture.serializedBytes = bytes.byteLength;
  }
  throw new Error("AX serializedBytes did not settle");
}

async function put(fx, { bytes, type, mediaType, sourceEvidenceId, artifactRef }) {
  return mod.evidence.putEvidence(fx.env, {
    runId: fx.runId,
    bytes,
    mediaType,
    type,
    attemptId: fx.attemptId,
    routeId: fx.pathId,
    sourceEvidenceId,
    artifactRef,
  });
}

async function fixture({ axFailed = false, pngWidth = 100, axMutation } = {}) {
  const runId = mod.ids.mintRunId(1_786_262_400_000);
  const fx = {
    runId,
    attemptId: "attempt-epoch-input",
    pathId: "path-epoch-input",
    env: { EVIDENCE: memoryR2() },
  };
  const screenEntry = await put(fx, {
    bytes: enc.encode(JSON.stringify({ visibleText: "DOM text is opaque here", controls: [] })),
    type: "dom-excerpt",
    mediaType: "application/json",
    sourceEvidenceId: "EV-screen",
    artifactRef: "observations/path/screen.json",
  });
  const screenshotEntry = await put(fx, {
    bytes: png(pngWidth, 80),
    type: "screenshot",
    mediaType: "image/png",
    sourceEvidenceId: "EV-screenshot",
    artifactRef: "observations/path/screen.png",
  });
  const screenRef = ref(screenEntry, "screen-json");
  const screenshotRef = ref(screenshotEntry, "screenshot");
  let accessibility;
  if (axFailed) {
    accessibility = { status: "failed", failure: failure() };
  } else {
    const artifact = {
      kind: "v2-accessibility-snapshot/1.0.0",
      epochId: "epoch-input-1",
      stepIndex: 0,
      slot: "before",
      scope: scope(),
      capturedAt: at(2),
      screenReadAt: at(1),
      screenSignatureHash: "a".repeat(64),
      geometry: geometry(),
      pairing: { screenJson: screenRef, screenshot: screenshotRef },
      capture: {
        interestingOnly: false,
        completeness: "complete",
        limitations: [],
        nodeCount: 2,
        maxDepthObserved: 1,
        serializedBytes: 0,
        limits: { maxNodes: 5_000, maxDepth: 64, maxValueChars: 16_384, maxSerializedBytes: 1_500_000 },
      },
      tree: {
        role: "WebArea",
        name: "Survey",
        children: [{ role: "radio", name: "Option A", checked: false, children: [] }],
      },
    };
    if (axMutation) axMutation(artifact);
    const accessibilityEntry = await put(fx, {
      bytes: settleArtifactBytes(artifact),
      type: "state",
      mediaType: "application/json",
      sourceEvidenceId: "EV-accessibility",
      artifactRef: "observations/path/screen.accessibility.json",
    });
    accessibility = {
      status: "captured",
      ref: ref(accessibilityEntry, "accessibility"),
      completeness: "complete",
      limitations: [],
    };
  }
  const row = {
    walkOrdinal: 0,
    pathId: fx.pathId,
    attemptId: fx.attemptId,
    walkArtifact: {
      evidenceId: "ev_walk_fixture",
      sourceEvidenceId: `EV-${fx.pathId}-observation`,
      artifactRef: "observations/path.json",
      contentHash: "b".repeat(64),
      mediaType: "application/json",
      size: 1,
      attemptId: fx.attemptId,
      routeId: fx.pathId,
    },
    epochOrdinal: 0,
    epochId: "epoch-input-1",
    stepIndex: 0,
    slot: "before",
    scope: scope(),
    startedAt: at(0),
    endedAt: at(3),
    screenReadAt: at(1),
    screenSignatureHash: "a".repeat(64),
    geometry: geometry(),
    screen: { status: "captured", ref: screenRef },
    screenshot: { status: "captured", ref: screenshotRef },
    accessibility,
    cacheInputIdentity: null,
    eligibility: "eligible",
    ambiguityKinds: [],
    limitationKinds: axFailed ? ["capture-failure:accessibility-api-unavailable"] : [],
  };
  row.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(row);
  return { ...fx, row };
}

const limitationKind = (result) => result.state === "ineligible" ? result.limitation.kind : null;

test("exact catalog and bytes produce pixel input plus typed AX, while screen JSON stays non-semantic", async () => {
  const fx = await fixture();
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(result.state, "loaded");
  assert.equal(result.input.capture.scope.kind, "viewport");
  assert.equal(result.input.geometry.screenshotPixelWidth, 100);
  assert.equal(result.input.geometry.screenshotPixelHeight, 80);
  assert.equal(result.screen.evidenceId, fx.row.screen.ref.evidenceId);
  assert.deepEqual(Object.keys(result.screen).sort(), ["contentSha256", "evidenceId"]);
  assert.equal(result.accessibility.value.tree.children[0].name, "Option A");
  assert.equal(result.input.accessibility.state, "captured");
  const recomputedPair = await mod.observe.computePairedEvidenceSha256({
    capture: result.input.capture,
    geometry: result.input.geometry,
    screen: { state: "captured", evidenceId: result.input.screen.evidenceId, contentSha256: result.input.screen.contentSha256 },
    accessibility: {
      state: "captured",
      evidenceId: result.input.accessibility.evidenceId,
      contentSha256: result.input.accessibility.contentSha256,
    },
  });
  assert.equal(result.input.pairedEvidenceSha256, recomputedPair);
});

test("an explicit failed AX capture stays named unavailable without inventing empty AX", async () => {
  const fx = await fixture({ axFailed: true });
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(result.state, "loaded");
  assert.equal(result.accessibility, null);
  assert.deepEqual(result.input.accessibility, {
    state: "unavailable",
    failure: { kind: "accessibility-api-unavailable", count: 1, detail: "accessibility-api-unavailable fixture" },
  });
});

test("a self-consistent swapped screen ref is rejected by the AX epoch pairing", async () => {
  const fx = await fixture();
  const alternate = await put(fx, {
    bytes: enc.encode(JSON.stringify({ visibleText: "different screen" })),
    type: "dom-excerpt",
    mediaType: "application/json",
    sourceEvidenceId: "EV-screen-alternate",
    artifactRef: "observations/path/screen-alternate.json",
  });
  fx.row.screen.ref = ref(alternate, "screen-json");
  fx.row.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(fx.row);
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(limitationKind(result), "accessibility-pair-mismatch");
});

test("attempt, route, media and type catalog mutations fail even when citation hashes still bind", async () => {
  const mutations = [
    (entry) => { entry.attemptId = "another-attempt"; },
    (entry) => { entry.routeId = "another-path"; },
    (entry) => { entry.mediaType = "application/octet-stream"; },
    (entry) => { entry.type = "other"; },
  ];
  for (const mutate of mutations) {
    const fx = await fixture();
    const key = mod.keys.evidenceCatalogKey(fx.runId, fx.row.screenshot.ref.evidenceId);
    const entry = JSON.parse(await (await fx.env.EVIDENCE.get(key)).text());
    mutate(entry);
    await fx.env.EVIDENCE.put(key, JSON.stringify(entry));
    const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
    assert.equal(limitationKind(result), "catalog-reference-mismatch");
  }
});

test("closed AX schema rejects unknown fields and malformed JSON instead of dropping AX", async () => {
  const unknown = await fixture({ axMutation: (artifact) => { artifact.tree.browserPrivateField = "forbidden"; } });
  const unknownResult = await mod.loader.loadVisualEpochInput(unknown.env, unknown.runId, unknown.row);
  assert.equal(limitationKind(unknownResult), "accessibility-schema-invalid");

  const malformed = await fixture();
  const oldRef = malformed.row.accessibility.ref;
  const malformedEntry = await put(malformed, {
    bytes: enc.encode("{not-json"),
    type: "state",
    mediaType: "application/json",
    sourceEvidenceId: "EV-accessibility-malformed",
    artifactRef: "observations/path/malformed.accessibility.json",
  });
  malformed.row.accessibility.ref = ref(malformedEntry, "accessibility");
  malformed.row.cacheInputIdentity = await mod.visualWork.computeCaptureInputIdentity(malformed.row);
  assert.notEqual(malformed.row.accessibility.ref.evidenceId, oldRef.evidenceId);
  const malformedResult = await mod.loader.loadVisualEpochInput(malformed.env, malformed.runId, malformed.row);
  assert.equal(limitationKind(malformedResult), "accessibility-json-malformed");
});

test("post-catalog byte corruption remains integrity failure, never explicit AX absence", async () => {
  const fx = await fixture();
  const hash = fx.row.accessibility.ref.contentHash;
  await fx.env.EVIDENCE.put(mod.keys.evidenceBlobKey(hash), enc.encode("damaged"));
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(limitationKind(result), "evidence-integrity-failure");
  assert.equal(result.state, "ineligible");
  assert.equal(result.limitation.channel, "accessibility");
});

test("PNG dimensions that disagree with measured viewport geometry fail before any visual call", async () => {
  const fx = await fixture({ pngWidth: 101 });
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(limitationKind(result), "screenshot-dimensions-mismatch");
});

test("missing explicit screenshot scope is a named manifest failure, not inferred as viewport", async () => {
  const fx = await fixture();
  delete fx.row.scope;
  const result = await mod.loader.loadVisualEpochInput(fx.env, fx.runId, fx.row);
  assert.equal(limitationKind(result), "manifest-row-malformed");
});
