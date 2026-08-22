/**
 * survey-qa-replay entrypoint.
 *
 * A SCRATCH WORKER that replays the judging tail of an archived production run.
 * It hard-refuses unless REPLAY_ENABLED is exactly "true" — a var that is absent
 * from every prod/arm config. Protected by a REPLAY_TOKEN secret.
 *
 * EXECUTION SHAPE: HTTP-triggered stage invocations, one stage per request.
 * Each stage runs within its own budget (the same 10-minute ceilings prod uses).
 * If a stage dies on budget, THAT IS A FINDING to report, not to patch around.
 */

import type { Env } from "../types/env";
import { scopeEvidenceEnv } from "../store/evidence-keyspace";
import { wrapReplayBucket, rewriteCheckpointForReplay } from "./replay-bucket";
import { checkpointKey, envelopeKey, judgementKey } from "../keys";
import { projectObservations } from "../workflow/stages/project-observations";
import { verifyObservations } from "../workflow/stages/verify-observations";
import { deriveItemResults, mintJudgement } from "../workflow/stages/derive-verdicts";
import { assembleRecord, supersedeRecord } from "../workflow/stages/assemble-record";
import { buildAndStoreReport } from "../report/build";
import type { RunClosure } from "../types/record";

// Re-export nothing — this worker has no Workflows.

interface ReplayRequest {
  sourceRunId: string;
  replayRunId: string;
  stage: string;
}

/** The stages of the judging tail, in order. */
const STAGES = [
  "seed-checkpoint",
  "project-observations",
  "verify-observations",
  "derive-verdicts",
  "assemble-record",
  "mint-judgement",
  "supersede-record",
  "report",
] as const;

type StageName = (typeof STAGES)[number];

export default {
  async fetch(req: Request, rawEnv: Env, _ctx: ExecutionContext): Promise<Response> {
    // HARD REFUSAL without REPLAY_ENABLED.
    if ((rawEnv as unknown as Record<string, string>).REPLAY_ENABLED !== "true") {
      return new Response(
        "This worker requires REPLAY_ENABLED=true. It is absent from every production config.\n",
        { status: 403 },
      );
    }

    // Token auth.
    const token = (rawEnv as unknown as Record<string, string>).REPLAY_TOKEN;
    if (!token) {
      return new Response("REPLAY_TOKEN secret is not configured.\n", { status: 500 });
    }
    const authHeader = req.headers.get("authorization");
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return new Response("Unauthorized\n", { status: 401 });
    }

    const url = new URL(req.url);
    if (url.pathname !== "/api/replay" || req.method !== "POST") {
      return new Response("POST /api/replay\n", { status: 404 });
    }

    let body: ReplayRequest;
    try {
      body = (await req.json()) as ReplayRequest;
    } catch {
      return new Response("Invalid JSON body\n", { status: 400 });
    }

    const { sourceRunId, replayRunId, stage } = body;
    if (!sourceRunId || !replayRunId || !stage) {
      return new Response("Missing sourceRunId, replayRunId, or stage\n", { status: 400 });
    }
    if (!replayRunId.startsWith("replay-")) {
      return new Response("replayRunId must start with 'replay-'\n", { status: 400 });
    }
    if (!STAGES.includes(stage as StageName)) {
      return new Response(`Unknown stage: ${stage}. Valid: ${STAGES.join(", ")}\n`, { status: 400 });
    }

    // Build the fenced environment.
    const fencedBucket = wrapReplayBucket(rawEnv.EVIDENCE, { sourceRunId, replayRunId });
    const env: Env = scopeEvidenceEnv({
      ...rawEnv,
      EVIDENCE: fencedBucket,
    });

    const startMs = Date.now();
    try {
      const result = await runStage(env, sourceRunId, replayRunId, stage as StageName);
      const durationMs = Date.now() - startMs;
      return Response.json({
        stage,
        result: "ok",
        durationMs,
        detail: result,
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "unknown";
      return Response.json(
        {
          stage,
          result: "error",
          durationMs,
          errorName: name,
          errorMessage: message.slice(0, 2000),
        },
        { status: 500 },
      );
    }
  },
};

async function runStage(
  env: Env,
  sourceRunId: string,
  replayRunId: string,
  stage: StageName,
): Promise<unknown> {
  switch (stage) {
    case "seed-checkpoint":
      return seedCheckpoint(env, sourceRunId, replayRunId);
    case "project-observations":
      return stageProjectObservations(env, replayRunId);
    case "verify-observations":
      return stageVerifyObservations(env, replayRunId);
    case "derive-verdicts":
      return stageDeriveVerdicts(env, replayRunId);
    case "assemble-record":
      return stageAssembleRecord(env, replayRunId);
    case "mint-judgement":
      return stageMintJudgement(env, replayRunId);
    case "supersede-record":
      return stageSupersedeRecord(env, replayRunId);
    case "report":
      return stageReport(env, replayRunId);
    default:
      throw new Error(`unimplemented stage: ${stage}`);
  }
}

/**
 * SEED: copy the source run's checkpoint and envelope into the replay prefix,
 * rewriting runId fields. This is the one setup step before the tail stages.
 */
async function seedCheckpoint(
  env: Env,
  sourceRunId: string,
  replayRunId: string,
): Promise<{ seeded: boolean; checkpointRevision: number }> {
  // Read the source checkpoint from the UNDERLYING bucket (not the fenced one,
  // which would try replay prefix first). The fenced bucket's get() does try
  // the replay prefix first, then falls back to the real key. Since we haven't
  // written anything yet, it'll fall through to the source.
  const cpObj = await env.EVIDENCE.get(checkpointKey(sourceRunId));
  if (!cpObj) throw new Error(`source checkpoint not found: ${checkpointKey(sourceRunId)}`);
  const cpText = await cpObj.text();

  // Rewrite runId references.
  const rewritten = rewriteCheckpointForReplay(cpText, sourceRunId, replayRunId);

  // Write to the replay prefix. The fenced bucket rewrites the key.
  await env.EVIDENCE.put(checkpointKey(replayRunId), rewritten, {
    httpMetadata: { contentType: "application/json" },
  });

  // Copy the envelope too.
  const envObj = await env.EVIDENCE.get(envelopeKey(sourceRunId));
  if (envObj) {
    const envText = await envObj.text();
    const rewrittenEnv = envText.replaceAll(sourceRunId, replayRunId);
    await env.EVIDENCE.put(envelopeKey(replayRunId), rewrittenEnv, {
      httpMetadata: { contentType: "application/json" },
    });
  }

  const parsed = JSON.parse(rewritten);
  return { seeded: true, checkpointRevision: parsed.revision ?? 0 };
}

async function stageProjectObservations(env: Env, runId: string) {
  const result = await projectObservations(env, runId);
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageVerifyObservations(env: Env, runId: string) {
  const result = await verifyObservations(env, runId);
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageDeriveVerdicts(env: Env, runId: string) {
  const result = await deriveItemResults(env, runId);
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageAssembleRecord(env: Env, runId: string) {
  // Need to load the derived verdicts first.
  const derivation = await deriveItemResults(env, runId);
  if (derivation.state !== "evaluated") {
    return { state: "skipped", reason: "derive-verdicts did not evaluate" };
  }
  const result = await assembleRecord(env, runId, derivation.value.itemResults);
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageMintJudgement(env: Env, runId: string) {
  const result = await mintJudgement(env, runId);
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageSupersedeRecord(env: Env, runId: string) {
  // Read judgement outcome from what was written.
  const judgementObj = await env.EVIDENCE.get(judgementKey(runId));
  const judgementMinted = !!judgementObj;

  const closure: RunClosure = {
    judgement: judgementMinted
      ? { minted: true, status: "replay", reasonCode: null, detail: null, boundRecordHash: "replay" }
      : { minted: false, status: null, reasonCode: "REPLAY_NO_JUDGEMENT", detail: "judgement not minted during replay", boundRecordHash: "replay" },
    testAxis: {
      closed: false,
      completion: "replay",
      reasonCode: null,
      blockers: ["replay run — test axis not evaluated"],
    },
    closedAt: new Date().toISOString(),
    derivedBy: "v2-replay-closure/1.0.0",
  };
  const result = await supersedeRecord(
    env,
    runId,
    closure,
    "replay superseding revision with judgement outcome",
  );
  return { state: result.state, value: result.state === "evaluated" ? result.value : null, reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null };
}

async function stageReport(env: Env, runId: string) {
  const result = await buildAndStoreReport(env, runId);
  return result;
}
