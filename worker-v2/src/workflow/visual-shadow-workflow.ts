/**
 * INDEPENDENT VISUAL SHADOW WORKFLOW ENVELOPE.
 *
 * The core run launches this Workflow and continues to verification; it never awaits visual
 * waves. That is a resource boundary, not just a TypeScript data-flow boundary: screenshot
 * inference, R2 verification, retries, and persisted step state consume this instance's limits
 * rather than the verifier/report instance's limits.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { loadCheckpoint, type Fence } from "../store/checkpoint";
import { writeVisualLaunchMarker, type VisualLaunchExpected } from "../store/visual-launch";
import { OwnershipLost } from "../types/contracts";
import type { Env } from "../types/env";
import { scopeEvidenceEnv } from "../store/evidence-keyspace";
import { runVisualShadowWorkflow, type VisualShadowWorkflowResult } from "./stages/visual-shadow";

const VISUAL_LAUNCH_POLICY = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "3 minutes",
} as const;

export interface VisualShadowWorkflowParams {
  runId: string;
  planRevisionId: string;
  fence: Fence;
}

export type VisualShadowLaunchResult =
  | { state: "accepted"; workflowInstanceId: string; created: boolean }
  | { state: "launch-unresolved"; workflowInstanceId: string };

/** One stable instance per core ownership epoch. Launch reconciles this ID before any create. */
export function visualShadowWorkflowInstanceId(runId: string, fence: Fence): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 70) {
    throw new Error("visual shadow workflow run id is outside the internal instance-id envelope");
  }
  if (
    typeof fence !== "object" ||
    fence === null ||
    typeof fence.instanceId !== "string" ||
    fence.instanceId.length === 0 ||
    !Number.isSafeInteger(fence.epoch) ||
    fence.epoch < 0
  ) {
    throw new Error("visual shadow workflow fence is invalid");
  }
  const id = `${runId}-visual-e${fence.epoch}`;
  if (id.length > 100) throw new Error("visual shadow workflow instance id exceeds 100 characters");
  return id;
}

/**
 * Launch and return immediately after the child instance is accepted. A visual binding/control
 * plane failure is contained and named in the return value; OwnershipLost still stops the stale
 * core instance. No paid visual operation is performed here.
 */
export async function launchVisualShadowWorkflow(input: {
  env: Env;
  step: WorkflowStep;
  runId: string;
  planRevisionId: string;
  fence: Fence;
}): Promise<VisualShadowLaunchResult> {
  const workflowInstanceId = visualShadowWorkflowInstanceId(input.runId, input.fence);
  const marker = (state: VisualLaunchExpected["state"]): VisualLaunchExpected => ({
    state,
    runId: input.runId,
    planRevisionId: input.planRevisionId,
    workflowInstanceId,
    ownership: { ...input.fence },
  });
  try {
    return await input.step.do(
      "launch-visual-shadow-child-v1",
      VISUAL_LAUNCH_POLICY,
      async (): Promise<Extract<VisualShadowLaunchResult, { state: "accepted" }>> => {
        await assertCurrentOwner(input.env, input.runId, input.fence);
        await writeVisualLaunchMarker(input.env.EVIDENCE, marker("intent"));
        // Cloudflare rejects both create() and createBatch() when a caller-supplied ID already
        // exists. Reconcile the stable ID before create and again after any create exception:
        // the second probe closes the lost-success-response race without ever forking a child.
        const created = await ensureVisualShadowWorkflowInstance(
          input.env.V2_VISUAL_WORKFLOW,
          workflowInstanceId,
          {
            runId: input.runId,
            planRevisionId: input.planRevisionId,
            fence: { ...input.fence },
          },
        );
        await writeVisualLaunchMarker(input.env.EVIDENCE, marker("accepted"));
        return { state: "accepted", workflowInstanceId, created };
      },
    );
  } catch (error) {
    if (error instanceof OwnershipLost) throw error;
    // Never serialize the binding error: provider/control-plane errors may contain internal
    // endpoints. The stable state is explicit; the launch-receipt store supplies durability.
    console.error(`visual shadow child launch unresolved for ${input.runId}`);
    try {
      await input.step.do(
        "record-visual-shadow-launch-unresolved-v1",
        VISUAL_LAUNCH_POLICY,
        async () => {
          await assertCurrentOwner(input.env, input.runId, input.fence);
          await writeVisualLaunchMarker(input.env.EVIDENCE, marker("unresolved"));
        },
      );
    } catch (markerError) {
      if (markerError instanceof OwnershipLost) throw markerError;
      console.error(`visual shadow launch limitation receipt could not be stored for ${input.runId}`);
    }
    return { state: "launch-unresolved", workflowInstanceId };
  }
}

type VisualWorkflowProbe =
  | { state: "exists" }
  | { state: "absent" }
  | { state: "unresolved"; error: unknown };

/**
 * Stable-ID create/get/status reconciliation. A transport failure is not evidence of absence,
 * so it never authorizes create; an existing terminal instance is still a successful prior
 * acceptance and is never replaced implicitly.
 */
export async function ensureVisualShadowWorkflowInstance(
  workflow: Env["V2_VISUAL_WORKFLOW"],
  workflowInstanceId: string,
  params: VisualShadowWorkflowParams,
): Promise<boolean> {
  const before = await probeVisualWorkflowInstance(workflow, workflowInstanceId);
  if (before.state === "exists") return false;
  if (before.state === "unresolved") throw before.error;
  try {
    await workflow.create({ id: workflowInstanceId, params });
    return true;
  } catch (createError) {
    const after = await probeVisualWorkflowInstance(workflow, workflowInstanceId);
    if (after.state === "exists") return false;
    if (after.state === "unresolved") throw after.error;
    throw createError;
  }
}

async function probeVisualWorkflowInstance(
  workflow: Env["V2_VISUAL_WORKFLOW"],
  workflowInstanceId: string,
): Promise<VisualWorkflowProbe> {
  try {
    const instance = await workflow.get(workflowInstanceId);
    await instance.status();
    return { state: "exists" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("instance.not_found")
      ? { state: "absent" }
      : { state: "unresolved", error };
  }
}

/** A separate Workflow instance with its own step/subrequest/CPU/state envelope. */
export class SurveyVisualShadowWorkflowV1 extends WorkflowEntrypoint<Env, VisualShadowWorkflowParams> {
  constructor(ctx: ExecutionContext, env: Env) {
    // The child is a separate Workflow invocation and therefore needs its own boundary.
    super(ctx, scopeEvidenceEnv(env));
  }

  async run(
    event: WorkflowEvent<VisualShadowWorkflowParams>,
    step: WorkflowStep,
  ): Promise<VisualShadowWorkflowResult> {
    const params = normalizeParams(event.payload);
    const workflowInstanceId = visualShadowWorkflowInstanceId(params.runId, params.fence);
    await step.do("visual-shadow-child-start-v1", VISUAL_LAUNCH_POLICY, async () => {
      await assertCurrentOwner(this.env, params.runId, params.fence);
      await writeVisualLaunchMarker(this.env.EVIDENCE, {
        state: "started",
        runId: params.runId,
        planRevisionId: params.planRevisionId,
        workflowInstanceId,
        ownership: { ...params.fence },
      });
    });
    return runVisualShadowWorkflow({
      env: this.env,
      step,
      runId: params.runId,
      planRevisionId: params.planRevisionId,
      fence: params.fence,
    });
  }
}

function normalizeParams(value: VisualShadowWorkflowParams): VisualShadowWorkflowParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("visual shadow workflow payload is invalid");
  }
  const keys = Object.keys(value).sort().join("\u0000");
  if (keys !== ["fence", "planRevisionId", "runId"].sort().join("\u0000")) {
    throw new Error("visual shadow workflow payload has missing or unknown fields");
  }
  const runId = value.runId;
  const planRevisionId = value.planRevisionId;
  if (typeof planRevisionId !== "string" || planRevisionId.length === 0 || planRevisionId.length > 300) {
    throw new Error("visual shadow workflow plan revision id is invalid");
  }
  visualShadowWorkflowInstanceId(runId, value.fence);
  return { runId, planRevisionId, fence: { ...value.fence } };
}

async function assertCurrentOwner(env: Env, runId: string, fence: Fence): Promise<void> {
  const loaded = await loadCheckpoint(env, runId);
  const current = loaded?.checkpoint.ownership ?? null;
  if (current === null || current.instanceId !== fence.instanceId || current.epoch !== fence.epoch) {
    throw new OwnershipLost(runId, fence, current);
  }
}
