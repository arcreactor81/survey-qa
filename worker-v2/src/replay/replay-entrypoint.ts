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
 *
 * KEY DESIGN DECISION: stages run against the SOURCE run id. The ReplayBucket
 * transparently redirects all writes from v2/runs/<source>/ to v2/runs/<replay>/
 * and all reads fall through from the replay prefix to the source prefix. This
 * avoids embedded-run-id mismatches in plans, evidence catalogue bindings, etc.
 */

import type { Env } from "../types/env";
import { scopeEvidenceEnv } from "../store/evidence-keyspace";
import { wrapReplayBucket } from "./replay-bucket";
import { judgementKey, recordKey } from "../keys";
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
  "seed",
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
    if (replayRunId === sourceRunId) {
      return new Response("replayRunId must differ from sourceRunId\n", { status: 400 });
    }
    if (!STAGES.includes(stage as StageName)) {
      return new Response(`Unknown stage: ${stage}. Valid: ${STAGES.join(", ")}\n`, { status: 400 });
    }

    // Build the fenced environment. Stages operate on the SOURCE run id.
    // The fence redirects writes from v2/runs/<source>/ to v2/runs/<replay>/
    // and reads fall through from replay prefix to source prefix.
    const fencedBucket = wrapReplayBucket(rawEnv.EVIDENCE, { sourceRunId, replayRunId });
    const env: Env = scopeEvidenceEnv({
      ...rawEnv,
      EVIDENCE: fencedBucket,
    });

    const startMs = Date.now();
    try {
      // ALL stages use the SOURCE run id. The fence handles write isolation.
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
  _replayRunId: string,
  stage: StageName,
): Promise<unknown> {
  // All stages use the SOURCE run id. The ReplayBucket fence handles
  // write isolation transparently.
  const runId = sourceRunId;
  switch (stage) {
    case "seed":
      // No seeding needed — stages read the source checkpoint directly.
      // The fence will redirect any writes to the replay prefix.
      return { seeded: true, note: "stages operate on source run id; fence redirects writes" };
    case "project-observations":
      return stageProjectObservations(env, runId);
    case "verify-observations":
      return stageVerifyObservations(env, runId);
    case "derive-verdicts":
      return stageDeriveVerdicts(env, runId);
    case "assemble-record":
      return stageAssembleRecord(env, runId);
    case "mint-judgement":
      return stageMintJudgement(env, runId);
    case "supersede-record":
      return stageSupersedeRecord(env, runId);
    case "report":
      return stageReport(env, runId);
    default:
      throw new Error(`unimplemented stage: ${stage}`);
  }
}

async function stageProjectObservations(env: Env, runId: string) {
  const result = await projectObservations(env, runId);
  return {
    state: result.state,
    value: result.state === "evaluated" ? result.value : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
    detail: result.state !== "evaluated" ? (result as { detail?: string }).detail : null,
  };
}

async function stageVerifyObservations(env: Env, runId: string) {
  const result = await verifyObservations(env, runId);
  return {
    state: result.state,
    value: result.state === "evaluated" ? result.value : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
  };
}

async function stageDeriveVerdicts(env: Env, runId: string) {
  const result = await deriveItemResults(env, runId);
  return {
    state: result.state,
    summary: result.state === "evaluated" ? result.value.summary : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
  };
}

async function stageAssembleRecord(env: Env, runId: string) {
  // Re-derive verdicts to get the item results (each stage is stateless).
  const derivation = await deriveItemResults(env, runId);
  if (derivation.state !== "evaluated") {
    return { state: "skipped", reason: "derive-verdicts did not evaluate" };
  }
  // Direct call — the full in-memory `itemResults` is available without crossing a
  // Workflow step boundary (the R2 persistence is for the step boundary path only).
  const result = await assembleRecord(env, runId, derivation.value.itemResults);
  return {
    state: result.state,
    value: result.state === "evaluated" ? result.value : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
  };
}

async function stageMintJudgement(env: Env, runId: string) {
  const result = await mintJudgement(env, runId);
  return {
    state: result.state,
    value: result.state === "evaluated" ? result.value : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
    detail: result.state !== "evaluated" ? (result as { detail?: string }).detail : null,
  };
}

async function stageSupersedeRecord(env: Env, runId: string) {
  // Check if a judgement was written during this replay.
  const judgementObj = await env.EVIDENCE.get(judgementKey(runId));
  const judgementMinted = !!judgementObj;

  // Check if there is an existing record to supersede.
  const recordObj = await env.EVIDENCE.get(recordKey(runId));
  if (!recordObj) {
    return { state: "skipped", reason: "no record to supersede" };
  }

  const closure: RunClosure = {
    judgement: judgementMinted
      ? { minted: true, status: "replay-attested", reasonCode: null, detail: null, boundRecordHash: "replay" }
      : { minted: false, status: null, reasonCode: "REPLAY_JUDGEMENT_ABSENT", detail: "judgement was not minted during replay", boundRecordHash: "replay" },
    testAxis: {
      closed: false,
      completion: "replay",
      reasonCode: null,
      blockers: ["replay run — test axis evaluation deferred"],
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
  return {
    state: result.state,
    value: result.state === "evaluated" ? result.value : null,
    reason: result.state !== "evaluated" ? (result as { reason?: string }).reason : null,
  };
}

async function stageReport(env: Env, runId: string) {
  const result = await buildAndStoreReport(env, runId);
  return result;
}
