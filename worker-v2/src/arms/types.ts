/**
 * THE FIVE SLOT SIGNATURES.
 *
 * NO ARM NAME APPEARS IN THIS FILE, and none may. An arm is a manifest naming one
 * implementation per slot (evaluation/arms/manifests/*.json); it is never a branch. If a
 * future change wants `if (armId === "B")` anywhere outside `registry.ts`, the seam is in
 * the wrong place — see evaluation/arms/ARCHITECTURE.md §2 for where it should go instead.
 *
 * WIRING STATUS, stated because it is the difference between a seam and a promise:
 * only the `plan` slot is ROUTED through the registry today (one call site,
 * run-workflow.ts). The other four are DECLARED and typed, and their baseline behaviour is
 * reached by the same direct imports as before. Routing a slot whose alternatives do not
 * exist would be edits to working code buying nothing; ARCHITECTURE.md §9 says what each
 * unrouted slot would take.
 */

import type { Env } from "../types/env";
import type { PlanStageResult } from "../workflow/stages/plan";
import type { StructureModel } from "../structure/index.js";

export const SLOTS = ["ingest", "structure", "plan", "traverse", "judge"] as const;
export type SlotId = (typeof SLOTS)[number];

/** Slots whose implementation is actually selected by the manifest at runtime. */
export const WIRED_SLOTS: readonly SlotId[] = ["plan", "structure"];

/**
 * The `plan` slot — the only slot with a working non-baseline implementation in prospect,
 * and the only place arms C and C-R differ (PRE-REGISTRATION.md §5.6).
 *
 * Signature is EXACTLY `planStage`'s, on purpose: the seam is a swap of the producer of an
 * `ExecutionProgram`, and `execute-batch.ts` consumes that program by id and does not
 * change. Widening this signature to accommodate a hypothetical implementation would be
 * designing for code that does not exist.
 */
export interface PlanArgs {
  runId: string;
  contractRevisionId: string;
  planRevisionId: string;
  surveyUrl: string;
  /** Pinned per (surveyId, repeat) for `random-equal-size` only; null for every other id. */
  seed?: number | null;
}

export type PlanComponent = (env: Env, args: PlanArgs) => Promise<PlanStageResult>;

export interface StructureArgs {
  runId: string;
  contractRevisionId: string;
}

export type StructureComponent = (env: Env, args: StructureArgs) => Promise<StructureModel | null>;

/** What a manifest declares. Parsed, never trusted: `resolve.ts` validates every field. */
export interface ArmManifest {
  manifestVersion: string;
  armId: string;
  label?: string;
  workerName?: string;
  components: Record<SlotId, string>;
  /** §8.1 shared-ingestion control: identical across every arm, or the run does not happen. */
  sharedIngestRevision: string | null;
  seeds?: number[];
  declaredAttribution?: string[];
}

/**
 * Build identity, injected as `env.ARM_BUILD_IDENTITY` by evaluation/arms/build-all.mjs and
 * echoed on every finding and run record. ARCHITECTURE.md §5.
 */
export interface ArmBuildIdentity {
  armId: string;
  sourceSha: string;
  gitDirty: boolean;
  treeHash: string;
  manifestHash: string;
  componentSetHash: string;
  buildId: string;
  builtAt: string;
  components: Record<string, string>;
}

/** The frozen result of resolution. Computed once per run; nothing re-reads the manifest. */
export interface ResolvedArm {
  armId: string;
  manifest: ArmManifest;
  /** Recomputed HERE from what was actually resolved, then compared to the build's value. */
  componentSetHash: string;
  identity: ArmBuildIdentity | null;
  plan: PlanComponent;
  structure: StructureComponent;
}

export class ArmResolutionError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "ArmResolutionError";
  }
}
