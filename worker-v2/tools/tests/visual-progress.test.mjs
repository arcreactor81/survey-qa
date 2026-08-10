/** Mutation-proven tests for fenced, replay-safe visual wave progress. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { canonicalize } from "../../../scorer/src/lib/canonical.mjs";
import { memoryR2 } from "../testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../..");
const bundleDir = mkdtempSync(path.join(tmpdir(), "visual-progress-test-"));
const bundlePath = path.join(bundleDir, "visual-progress.mjs");
const p = (relative) => JSON.stringify(path.join(WORKER_ROOT, relative).replace(/\\/g, "/"));

await esbuild.build({
  stdin: {
    contents: [
      `export * as progress from ${p("src/store/visual-progress.ts")};`,
      `export * as keys from ${p("src/keys.ts")};`,
      `export * as hash from ${p("src/store/hash.ts")};`,
    ].join("\n"),
    resolveDir: WORKER_ROOT,
    sourcefile: "visual-progress-test-entry.ts",
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
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const encoder = new TextEncoder();
const RUN_ID = "v2r_00000000000000000000000000";
const PLAN_ID = "plan_visual_progress_fixture";
const WORK_SHA = "a".repeat(64);
const FINALIZED_AT = "2026-08-09T14:00:00.000Z";
const owner1 = { instanceId: "workflow-primary", epoch: 1 };
const owner2 = { instanceId: "workflow-recovery-2", epoch: 2 };
const canonicalBytes = (value) => encoder.encode(canonicalize(value));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function countedR2() {
  const base = memoryR2();
  let gets = 0;
  return {
    bucket: {
      ...base,
      async get(key) {
        gets += 1;
        return base.get(key);
      },
    },
    getCount: () => gets,
  };
}

async function setCheckpoint(bucket, ownership) {
  await bucket.put(
    mod.keys.checkpointKey(RUN_ID),
    JSON.stringify({
      schemaVersion: "v2-checkpoint/1.0.0",
      kind: "survey-qa-v2-checkpoint",
      ownership: { ...ownership, claimedAt: FINALIZED_AT },
    }),
  );
}

function configuration(overrides = {}) {
  return {
    schemaVersion: "survey-qa-visual-rollout-configuration/1.0.0",
    enabled: true,
    provider: "workers-ai-gemma4",
    maximumCalls: 20,
    maximumUsd: 0.05,
    timeoutMs: 60_000,
    waveBudgetMs: 180_000,
    maximumWaves: 100,
    concurrency: 1,
    ...overrides,
  };
}

async function initializeFixture({ denominatorItemCount = 12, ownership = owner1, config = configuration() } = {}) {
  const counted = countedR2();
  await setCheckpoint(counted.bucket, ownership);
  const rolloutSha256 = await mod.hash.canonicalHash(config);
  const input = {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    visualWorkManifestSha256: WORK_SHA,
    denominatorItemCount,
    rollout: { state: "valid", configuration: config },
    inference: {
      provider: "workers-ai",
      model: "@cf/google/gemma-4-26b-a4b-it",
      transport: "workers-ai-binding",
      configurationSha256: "b".repeat(64),
      prompt: { version: "visual-observer/1", sha256: "c".repeat(64) },
      responseSchema: { version: "visual-observation/1", sha256: "d".repeat(64) },
    },
    authorization: {
      state: "authorized",
      rolloutConfigurationSha256: rolloutSha256,
      maximumVisualCalls: config.maximumCalls,
      maximumVisualUsd: config.maximumUsd,
    },
    ownership,
    coverageFinalizedAt: FINALIZED_AT,
  };
  const initialized = await mod.progress.initializeVisualProgress({ EVIDENCE: counted.bucket }, input);
  return { ...counted, env: { EVIDENCE: counted.bucket }, input, initialized };
}

function item(denominatorOrdinal, disposition = "input-ineligible", detail = "mechanically ineligible capture") {
  return {
    denominatorOrdinal,
    workItemSha256: (denominatorOrdinal % 10).toString().repeat(64),
    disposition,
    detail,
    success: null,
  };
}

function appendInput(head, items, purchaseChannelAfter = head.state.purchaseChannel) {
  return {
    expected: mod.progress.visualProgressExpectation(head),
    cursor: mod.progress.visualProgressCursor(head),
    waveOrdinal: head.state.completedWaveCount,
    startDenominatorOrdinal: head.state.nextDenominatorOrdinal,
    items,
    purchaseChannelAfter,
  };
}

async function appendOne(fixture, head, disposition = "input-ineligible", detail = "mechanically ineligible capture") {
  const ordinal = head.state.nextDenominatorOrdinal;
  return mod.progress.appendVisualProgressWave(fixture.env, appendInput(head, [item(ordinal, disposition, detail)]));
}

test("initialization seals full non-secret authority and is replay-stable", async () => {
  const fixture = await initializeFixture();
  const { initialized } = fixture;
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.head.state.completedWaveCount, 0);
  assert.equal(initialized.head.state.coverageFinalizedAt, FINALIZED_AT);
  assert.equal(initialized.head.authority.inference.model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(initialized.head.authority.authorization.maximumVisualCalls, 20);
  assert.match(initialized.head.pointer.authoritySeal.key, /\/authority\/sha256\/[0-9a-f]{64}\/authority\.json$/);

  const replay = await mod.progress.initializeVisualProgress(fixture.env, {
    ...fixture.input,
    coverageFinalizedAt: "2026-08-09T15:00:00.000Z",
  });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.head.state.coverageFinalizedAt, FINALIZED_AT, "the fixed winner owns finalizedAt");
});

test("authority object/hash disagreement and omitted fields fail", async () => {
  const fixture = await initializeFixture();
  const mutated = structuredClone(fixture.initialized.head.authority);
  mutated.inference.model = "different-model";
  await assert.rejects(mod.progress.validateVisualProgressAuthoritySeal(mutated), /does not hash the sealed inference/);

  const omitted = structuredClone(fixture.initialized.head.authority);
  delete omitted.authorization;
  await assert.rejects(mod.progress.validateVisualProgressAuthoritySeal(omitted), /missing field "authorization"/);
});

test("append is contiguous, immediate replay is idempotent, and a fork/gap is refused", async () => {
  const fixture = await initializeFixture();
  const head0 = fixture.initialized.head;
  const request = appendInput(head0, [item(0)]);
  const first = await mod.progress.appendVisualProgressWave(fixture.env, request);
  assert.equal(first.status, "appended");
  assert.equal(first.head.state.nextDenominatorOrdinal, 1);
  const replay = await mod.progress.appendVisualProgressWave(fixture.env, request);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.shardRef.contentSha256, first.shardRef.contentSha256);

  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, { ...request, items: [item(0, "provider-unavailable", "different")] }),
    /fork refused/,
  );
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, { ...request, waveOrdinal: 2 }),
    /wave ordinal does not equal/,
  );
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, {
      ...appendInput(first.head, [item(2)]),
      startDenominatorOrdinal: 2,
    }),
    /denominator cursor|contiguous ordinal/,
  );
});

test("exact work/config/fence drift is fatal before another append", async () => {
  const fixture = await initializeFixture();
  const base = appendInput(fixture.initialized.head, [item(0)]);
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, {
      ...base,
      expected: { ...base.expected, visualWorkManifestSha256: "e".repeat(64) },
    }),
    /work-identity drift|visualWorkManifestSha256 drift/,
  );
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, {
      ...base,
      expected: { ...base.expected, configurationFingerprintSha256: "f".repeat(64) },
    }),
    /configurationFingerprintSha256 drift/,
  );
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, {
      ...base,
      expected: { ...base.expected, ownership: owner2 },
    }),
    { name: "OwnershipLost" },
  );
});

test("higher live checkpoint fence adopts actual prior owner across deploy config drift", async () => {
  const fixture = await initializeFixture();
  const first = await appendOne(fixture, fixture.initialized.head);
  const oldExpectation = mod.progress.visualProgressExpectation(first.head);
  const oldAuthorityHash = first.head.pointer.authoritySeal.contentSha256;

  await setCheckpoint(fixture.bucket, owner2);
  const changedConfig = configuration({ maximumWaves: 77, maximumCalls: 9 });
  const changedSha = await mod.hash.canonicalHash(changedConfig);
  const recovered = await mod.progress.initializeVisualProgress(fixture.env, {
    ...fixture.input,
    rollout: { state: "valid", configuration: changedConfig },
    authorization: {
      state: "authorized",
      rolloutConfigurationSha256: changedSha,
      maximumVisualCalls: changedConfig.maximumCalls,
      maximumVisualUsd: changedConfig.maximumUsd,
    },
    ownership: owner2,
  });
  assert.equal(recovered.status, "adopted");
  assert.deepEqual(recovered.head.pointer.ownership, owner2);
  assert.equal(recovered.head.pointer.authoritySeal.contentSha256, oldAuthorityHash, "old sealed authority is preserved");
  assert.equal(recovered.head.authority.rollout.configuration.maximumWaves, 100);
  assert.equal(recovered.head.state.nextDenominatorOrdinal, 1);
  assert.equal(recovered.head.state.coverageFinalizedAt, FINALIZED_AT);
  const audited = await mod.progress.readVisualProgress(
    fixture.bucket,
    mod.progress.visualProgressExpectation(recovered.head),
  );
  assert.equal(audited.items.length, 1, "full history audit must accept a real ownership-only adoption");

  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, {
      expected: oldExpectation,
      cursor: mod.progress.visualProgressCursor(first.head),
      waveOrdinal: 1,
      startDenominatorOrdinal: 1,
      items: [item(1)],
      purchaseChannelAfter: first.head.state.purchaseChannel,
    }),
    { name: "OwnershipLost" },
  );
});

test("same/lower conflicting takeover cannot replace the actual pointer owner", async () => {
  const fixture = await initializeFixture();
  await setCheckpoint(fixture.bucket, owner2);
  const adopted = await mod.progress.adoptVisualProgressOwnership(fixture.env, {
    expected: {
      runId: RUN_ID,
      planRevisionId: PLAN_ID,
      visualWorkManifestSha256: WORK_SHA,
      denominatorItemCount: 12,
    },
    newOwnership: owner2,
  });
  assert.equal(adopted.status, "adopted");

  const sameEpochOther = { instanceId: "forged-same-epoch", epoch: 2 };
  await setCheckpoint(fixture.bucket, sameEpochOther);
  await assert.rejects(
    mod.progress.adoptVisualProgressOwnership(fixture.env, {
      expected: {
        runId: RUN_ID,
        planRevisionId: PLAN_ID,
        visualWorkManifestSha256: WORK_SHA,
        denominatorItemCount: 12,
      },
      newOwnership: sameEpochOther,
    }),
    /strictly above/,
  );
});

test("durable exhaustion survives takeover, seals remainder disposition, and cannot reopen", async () => {
  const fixture = await initializeFixture({ denominatorItemCount: 4 });
  const detail = "strict visual admission cap reached; no later purchase is authorized";
  const exhausted = {
    state: "exhausted",
    originatingStop: {
      code: "usage-admission-cap",
      detail,
      waveOrdinal: 0,
      denominatorOrdinal: 0,
      remainderDisposition: "budget-not-authorized",
    },
  };
  const stopped = await mod.progress.appendVisualProgressWave(
    fixture.env,
    appendInput(fixture.initialized.head, [item(0, "budget-not-authorized", detail)], exhausted),
  );
  assert.equal(stopped.head.state.purchaseChannel.state, "exhausted");

  await setCheckpoint(fixture.bucket, owner2);
  const adopted = await mod.progress.adoptVisualProgressOwnership(fixture.env, {
    expected: {
      runId: RUN_ID,
      planRevisionId: PLAN_ID,
      visualWorkManifestSha256: WORK_SHA,
      denominatorItemCount: 4,
    },
    newOwnership: owner2,
  });
  assert.equal(adopted.head.state.purchaseChannel.state, "exhausted");
  await assert.rejects(
    mod.progress.appendVisualProgressWave(
      fixture.env,
      appendInput(adopted.head, [item(1, "budget-not-authorized", detail)], {
        state: "open",
        originatingBlocker: null,
      }),
    ),
    /cannot reopen|cannot change origin/,
  );
  const closed = await mod.progress.appendVisualProgressWave(
    fixture.env,
    appendInput(adopted.head, [item(1, "budget-not-authorized", detail)]),
  );
  assert.equal(closed.head.state.nextDenominatorOrdinal, 2);
});

test("bounded shards reject an unbounded mechanical wave", async () => {
  const fixture = await initializeFixture({ denominatorItemCount: 25_000 });
  const tooMany = Array.from(
    { length: mod.progress.VISUAL_PROGRESS_MAX_ITEMS_PER_WAVE + 1 },
    (_, ordinal) => item(ordinal),
  );
  await assert.rejects(
    mod.progress.appendVisualProgressWave(fixture.env, appendInput(fixture.initialized.head, tooMany)),
    /at most 20000/,
  );
});

test("write-path R2 reads remain constant as wave history grows", async () => {
  const fixture = await initializeFixture({ denominatorItemCount: 8 });
  let head = fixture.initialized.head;
  const readDeltas = [];
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    const before = fixture.getCount();
    const appended = await appendOne(fixture, head);
    readDeltas.push(fixture.getCount() - before);
    head = appended.head;
  }
  assert.deepEqual(new Set(readDeltas).size, 1, `append read counts grew with history: ${readDeltas.join(",")}`);
  assert.ok(readDeltas[0] <= 10, `constant path unexpectedly used ${readDeltas[0]} reads`);

  const full = await mod.progress.readVisualProgress(fixture.bucket, mod.progress.visualProgressExpectation(head));
  assert.equal(full.items.length, 6);
  assert.deepEqual(full.items.map((entry) => entry.denominatorOrdinal), [0, 1, 2, 3, 4, 5]);
});

async function mutateTail(fixture, head, mutateWave, mutateState = () => {}) {
  const oldWaveObject = await fixture.bucket.get(head.state.tailWave.key);
  const wave = JSON.parse(await oldWaveObject.text());
  mutateWave(wave);
  const waveBytes = canonicalBytes(wave);
  const waveHash = sha256(waveBytes);
  const waveRef = {
    key: mod.progress.visualProgressWaveKey(RUN_ID, wave.waveOrdinal, waveHash),
    contentSha256: waveHash,
    waveOrdinal: wave.waveOrdinal,
    startDenominatorOrdinal: wave.startDenominatorOrdinal,
    endDenominatorOrdinalExclusive: wave.endDenominatorOrdinalExclusive,
  };
  await fixture.bucket.put(waveRef.key, waveBytes);

  const state = structuredClone(head.state);
  state.tailWave = waveRef;
  state.nextDenominatorOrdinal = wave.endDenominatorOrdinalExclusive;
  await mutateState(state, { wave, waveRef });
  const stateBytes = canonicalBytes(state);
  const stateHash = sha256(stateBytes);
  const stateRef = {
    key: mod.progress.visualProgressStateKey(RUN_ID, stateHash),
    contentSha256: stateHash,
    stateRevision: state.stateRevision,
  };
  await fixture.bucket.put(stateRef.key, stateBytes);
  const pointer = { ...head.pointer, state: stateRef };
  await fixture.bucket.put(mod.progress.visualProgressPointerKey(RUN_ID), canonicalBytes(pointer));
}

test("full audit reader rejects shard reorder/omission and denominator gaps", async () => {
  const reorder = await initializeFixture({ denominatorItemCount: 4 });
  const r1 = await appendOne(reorder, reorder.initialized.head);
  const r2 = await appendOne(reorder, r1.head);
  await mutateTail(reorder, r2.head, (wave) => {
    wave.previousWave = null;
  });
  const reorderedHead = await mod.progress.readVisualProgressHeadByIdentity(reorder.bucket, {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    visualWorkManifestSha256: WORK_SHA,
    denominatorItemCount: 4,
  });
  await assert.rejects(
    mod.progress.readVisualProgress(reorder.bucket, mod.progress.visualProgressExpectation(reorderedHead)),
    /ended before completedWaveCount|omitted or reordered/,
  );

  const gap = await initializeFixture({ denominatorItemCount: 4 });
  const g1 = await appendOne(gap, gap.initialized.head);
  const g2 = await appendOne(gap, g1.head);
  await mutateTail(gap, g2.head, (wave) => {
    wave.startDenominatorOrdinal = 2;
    wave.endDenominatorOrdinalExclusive = 3;
    wave.items[0].denominatorOrdinal = 2;
  });
  const gapHead = await mod.progress.readVisualProgressHeadByIdentity(gap.bucket, {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    visualWorkManifestSha256: WORK_SHA,
    denominatorItemCount: 4,
  });
  await assert.rejects(
    mod.progress.readVisualProgress(gap.bucket, mod.progress.visualProgressExpectation(gapHead)),
    /denominator cursor has a gap|wave cursor does not exactly derive the successor state/,
  );
});

test("full audit reader rejects a cursor reset whose immutable predecessor is missing", async () => {
  const fixture = await initializeFixture({ denominatorItemCount: 4 });
  const first = await appendOne(fixture, fixture.initialized.head);
  const missingSha256 = "e".repeat(64);
  const reset = structuredClone(first.head.state);
  reset.stateRevision = first.head.state.stateRevision + 1;
  reset.previousState = {
    key: mod.progress.visualProgressStateKey(RUN_ID, missingSha256),
    contentSha256: missingSha256,
    stateRevision: first.head.state.stateRevision,
  };
  reset.completedWaveCount = 0;
  reset.nextDenominatorOrdinal = 0;
  reset.tailWave = null;
  reset.shardChainSha256 = fixture.initialized.head.state.shardChainSha256;
  reset.purchaseChannel = fixture.initialized.head.state.purchaseChannel;
  const resetBytes = canonicalBytes(reset);
  const resetSha256 = sha256(resetBytes);
  const resetRef = {
    key: mod.progress.visualProgressStateKey(RUN_ID, resetSha256),
    contentSha256: resetSha256,
    stateRevision: reset.stateRevision,
  };
  await fixture.bucket.put(resetRef.key, resetBytes);
  await fixture.bucket.put(
    mod.progress.visualProgressPointerKey(RUN_ID),
    canonicalBytes({ ...first.head.pointer, state: resetRef }),
  );

  const resetHead = await mod.progress.readVisualProgressHeadByIdentity(fixture.bucket, {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    visualWorkManifestSha256: WORK_SHA,
    denominatorItemCount: 4,
  });
  assert.equal(resetHead.state.nextDenominatorOrdinal, 0, "the mutation must be locally well formed");
  await assert.rejects(
    mod.progress.readVisualProgress(fixture.bucket, mod.progress.visualProgressExpectation(resetHead)),
    /referenced immutable object is missing/,
  );
});

test("full audit reader rejects a wave whose predecessor ref does not bind state history", async () => {
  const fixture = await initializeFixture({ denominatorItemCount: 4 });
  const first = await appendOne(fixture, fixture.initialized.head);
  const second = await appendOne(fixture, first.head);
  const missingSha256 = "f".repeat(64);
  await mutateTail(
    fixture,
    second.head,
    (wave) => {
      wave.previousState = {
        key: mod.progress.visualProgressStateKey(RUN_ID, missingSha256),
        contentSha256: missingSha256,
        stateRevision: wave.previousState.stateRevision,
      };
    },
    async (state, { wave, waveRef }) => {
      state.shardChainSha256 = await mod.hash.canonicalHash({
        kind: "survey-qa-visual-progress-chain-link",
        previousChainSha256: wave.previousChainSha256,
        shard: waveRef,
      });
    },
  );
  const mutatedHead = await mod.progress.readVisualProgressHeadByIdentity(fixture.bucket, {
    runId: RUN_ID,
    planRevisionId: PLAN_ID,
    visualWorkManifestSha256: WORK_SHA,
    denominatorItemCount: 4,
  });
  await assert.rejects(
    mod.progress.readVisualProgress(fixture.bucket, mod.progress.visualProgressExpectation(mutatedHead)),
    /wave predecessor state does not exactly bind the state history/,
  );
});

test("content-address and closed-schema mutations cannot be hidden behind the fixed pointer", async () => {
  const fixture = await initializeFixture();
  const first = await appendOne(fixture, fixture.initialized.head);
  const stored = await fixture.bucket.get(first.head.stateRef.key);
  const state = JSON.parse(await stored.text());
  delete state.modelFingerprintSha256;
  await fixture.bucket.put(first.head.stateRef.key, canonicalBytes(state));
  await assert.rejects(
    mod.progress.readVisualProgressHeadByIdentity(fixture.bucket, {
      runId: RUN_ID,
      planRevisionId: PLAN_ID,
      visualWorkManifestSha256: WORK_SHA,
      denominatorItemCount: 12,
    }),
    /content hash does not match|missing field/,
  );
});
