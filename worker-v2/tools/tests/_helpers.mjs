/** Shared seeding for the regression suite: a complete, conforming v2 run in memory. */

import { loadWorker, memoryR2 } from "../testkit.mjs";
import { FIXTURE_REGISTRY, TARGET_BUILD_ID, contractBody, runRecordV2, signedJudgement } from "../fixtures/v2-fixture.mjs";

export async function worker() {
  const { mod } = await loadWorker();
  return mod;
}

export function testEnv(overrides = {}) {
  return {
    EVIDENCE: memoryR2(),
    JUDGEMENT_KEY_REGISTRY: FIXTURE_REGISTRY,
    // The fixture key is `trust: "fixture"`, honoured only when dev seeding is on. Tests
    // that need the production posture clear this explicitly.
    DEV_SEED: "enabled",
    V2_RUN_WORKFLOW: {
      async get() {
        throw new Error("instance.not_found");
      },
      async create() {},
    },
    ...overrides,
  };
}

/**
 * Seed one fully-formed v2 run: sealed contract revision, evidence, RunRecordV2,
 * envelope, and a checkpoint whose ledger reconciles.
 */
export async function seedRun(mod, env, opts = {}) {
  const runId = mod.ids.mintRunId();

  // `opts.contract` lets a test seal the shape the REAL workflow seals — which sets
  // `extraction.reviewedAt: null` — rather than only the reviewed fixture.
  const { contractRevisionId, contractHash } = await mod.contractRevision.sealContract(env, opts.contract ?? contractBody());

  const evidence = [];
  for (const [source, text, mediaType] of [
    ["EV-FIX-001.json", JSON.stringify({ screens: 12 }), "application/json"],
    ["EV-FIX-002.html", "<p>captured DOM</p>", "text/html"],
  ]) {
    evidence.push(
      await mod.evidence.putEvidence(env, {
        runId,
        bytes: new TextEncoder().encode(text),
        mediaType,
        type: "trace",
        sourceEvidenceId: source,
        witnesses: [],
      }),
    );
  }

  const record = runRecordV2({ runId, contractRevisionId, contractHash, evidence });
  await env.EVIDENCE.put(mod.keys.recordKey(runId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });

  await mod.envelope.putEnvelope(env, {
    schemaVersion: "v2-run-envelope/1.0.0",
    kind: "survey-qa-v2-envelope",
    runId,
    createdAt: "2026-08-02T00:00:00.000Z",
    instanceId: runId,
    input: {
      surveyUrl: "https://fixture.invalid/survey",
      documentKey: mod.keys.inputDocumentKey(runId),
      documentSha256: "a".repeat(64),
      documentName: "fixture.docx",
      targetBuildId: opts.targetBuildId === undefined ? TARGET_BUILD_ID : opts.targetBuildId,
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
    d.completion = { test: opts.testCompletion ?? "complete", report: "not-started", reasonCode: null };
  });

  return { runId, record, contractRevisionId, contractHash, evidence };
}

export async function putJudgement(mod, env, runId, judgementDoc) {
  await env.EVIDENCE.put(mod.keys.judgementKey(runId), JSON.stringify(judgementDoc), {
    httpMetadata: { contentType: "application/json" },
  });
}

export { signedJudgement, TARGET_BUILD_ID };
