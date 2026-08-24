/**
 * LOCAL-DEV STAGE DRIVER — run the judging stages against a run that already has state.
 *
 * `POST /api/v2/dev/judge` runs, in order, exactly the four things the Workflow runs:
 *
 *     verify-observations → derive-verdicts → assemble-record → mint-judgement → report
 *
 * and returns each stage's real result. It is the same functions, in the same isolate, over
 * the same R2 state — not a re-implementation and not a mock. What it skips is the Workflow
 * ENGINE: the checkpointing, the fence, the retry policies. That is deliberate, and it is
 * the honest limit of what this endpoint proves.
 *
 * WHY IT EXISTS (historical, and still useful). It was written while extraction, planning and
 * execution were stubs: a real submission then sealed a zero-case contract and stopped at
 * `empty-contract` long before adjudication, so waiting for those stages to land before finding
 * out whether the judge could run inside a Worker at all would have been the expensive order to
 * do this in. Seeding a run with the REAL artifacts of a REAL previous run and driving the
 * judging stages over them answered that question with real bytes.
 *
 * THOSE STAGES ARE BUILT NOW and the Workflow runs all of them, so this is no longer the only
 * way to reach adjudication. It is kept as a fast, deterministic way to exercise the judging
 * stages over fixed inputs without paying for extraction and a browser walk.
 *
 * OFF UNLESS `DEV_SEED` IS EXACTLY "enabled", which `wrangler.jsonc` cannot set — the same
 * gate `api/devseed.ts` uses. On a deployed build this route 404s indistinguishably from an
 * unknown path.
 */

import type { Env } from "../types/env";
import { fail, json, readJson } from "./http";
import { isV2RunId } from "../ids";
import { devSeedEnabled } from "./devseed";
import { verifyObservations } from "../workflow/stages/verify-observations";
import { deriveItemResults, mintJudgement } from "../workflow/stages/derive-verdicts";
import { assembleRecord } from "../workflow/stages/assemble-record";
import { buildAndStoreReport } from "../report/build";

export async function devJudge(req: Request, env: Env): Promise<Response> {
  if (!devSeedEnabled(env)) return fail(404, "NOT_FOUND", "unknown endpoint /api/v2/dev/judge");

  const body = await readJson<{ runId?: string }>(req);
  const runId = body?.runId ?? "";
  if (!isV2RunId(runId)) return fail(400, "INVALID_RUN_ID", `${runId} is not a v2 run id`);

  const started = Date.now();
  const stages: Record<string, unknown> = {};

  const verified = await verifyObservations(env, runId);
  stages.verify = summarize(verified);

  const derived = await deriveItemResults(env, runId);
  // The ItemResults themselves go into the RECORD, not into this response: 119 of them is
  // a page of JSON nobody reads, and the record is where they are meant to be inspected.
  stages.derive =
    derived.state === "evaluated" ? { state: derived.state, value: derived.value.summary } : summarize(derived);
  if (derived.state !== "evaluated") {
    return json({ runId, ok: false, stoppedAt: "derive-verdicts", stages, ms: Date.now() - started }, { status: 200 });
  }

  // Direct call — the full in-memory `itemResults` is available without crossing a
  // Workflow step boundary (the R2 persistence is for the step boundary path only).
  const assembled = await assembleRecord(env, runId, derived.value.itemResults);
  stages.assemble = summarize(assembled);
  if (assembled.state !== "evaluated") {
    return json({ runId, ok: false, stoppedAt: "assemble-record", stages, ms: Date.now() - started }, { status: 200 });
  }

  const judged = await mintJudgement(env, runId);
  stages.judge = summarize(judged);

  // The report is built LAST and on both branches, because a run whose judgement could not
  // be minted is still a reportable outcome — it reports one column instead of two.
  const report = await buildAndStoreReport(env, runId);
  stages.report = report;

  return json(
    {
      runId,
      ok: judged.state === "evaluated" && report.ok === true,
      stages,
      ms: Date.now() - started,
      watchUrl: `/runs/${runId}`,
      reportUrl: `/api/v2/runs/${runId}/report`,
    },
    { status: 200 },
  );
}

/** A StageResult, flattened. `not-evaluated` keeps its reason — that is the useful half. */
function summarize(result: { state: string; value?: unknown; reason?: string; detail?: string }): unknown {
  return result.state === "evaluated"
    ? { state: result.state, value: result.value }
    : { state: result.state, reason: result.reason, detail: result.detail };
}
