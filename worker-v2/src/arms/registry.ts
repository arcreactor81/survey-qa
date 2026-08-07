/**
 * THE REGISTRY — the ONE place in the codebase where a component name binds to code.
 *
 * `catalogue.json` says which names exist and which of them have implementations. This file
 * supplies the implementations for WIRED slots and asserts, at module load, that the two
 * agree. A catalogue entry marked `implemented` with nothing behind it, or an implementation
 * for an id the catalogue calls `unimplemented`, is a load-time throw — because the failure
 * it prevents (an arm quietly running some other arm's component) is silent and produces a
 * plausible number.
 *
 * An `unimplemented` id RESOLVES (so a manifest is checkable and a deploy dry-run succeeds)
 * and THROWS WHEN INVOKED. It never falls back to the baseline. Falling back is the exact
 * silent-wrong-arm failure per-arm deployment exists to prevent.
 */

import catalogue from "./catalogue.json";
import { planStage } from "../workflow/stages/plan";
import { compileStructureModel } from "../structure/index.js";
import { getContractRevision } from "../store/contract-revision";
import { ArmResolutionError, SLOTS, WIRED_SLOTS, type PlanComponent, type SlotId, type StructureComponent } from "./types";

export const CATALOGUE_VERSION: string = (catalogue as any).catalogueVersion;

interface CatalogueImpl {
  status: "implemented" | "unimplemented";
  binds: string | null;
  note?: string;
  blocker?: string;
}
interface CatalogueSlot {
  signature: string;
  experimentalVariable: boolean;
  pinnedReason?: string;
  note?: string;
  implementations: Record<string, CatalogueImpl>;
}

const SLOT_CATALOGUE = (catalogue as any).slots as Record<SlotId, CatalogueSlot>;

/** An id the catalogue declares but nothing implements. Resolves; throws on invocation. */
function unimplemented(slot: SlotId, id: string): any {
  const blocker = SLOT_CATALOGUE[slot]?.implementations?.[id]?.blocker ?? "no blocker recorded";
  return async () => {
    throw new ArmResolutionError(
      "COMPONENT_UNIMPLEMENTED",
      `${slot}="${id}" is declared in the catalogue and has no implementation. ${blocker}`,
    );
  };
}

/**
 * Implementations for WIRED slots only. `plan` is the sole wired slot today
 * (types.ts#WIRED_SLOTS); the other four reach their baseline through the same direct
 * imports run-workflow.ts always used.
 */
const PLAN_IMPLEMENTATIONS: Record<string, PlanComponent> = {
  // The baseline. `planStage` ignores `seed`, which is correct: it is deterministic.
  "v2-two-tier": (env, args) =>
    planStage(env, {
      runId: args.runId,
      contractRevisionId: args.contractRevisionId,
      planRevisionId: args.planRevisionId,
      surveyUrl: args.surveyUrl,
    }),
};

const STRUCTURE_IMPLEMENTATIONS: Record<string, StructureComponent> = {
  "routing-graph": async (env, args) => {
    const revision = await getContractRevision(env, args.contractRevisionId);
    if (!revision) return null;
    return compileStructureModel(revision);
  },
  "none": async () => null,
};

// ---------------------------------------------------------------------------
// LOAD-TIME CONSISTENCY ASSERTION — the gate, and it can fail.
// Proven failable by evaluation/arms/verify.mjs --selftest, which mutates the catalogue
// three ways and requires each to throw.
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS_BY_SLOT: Partial<Record<SlotId, Record<string, PlanComponent | StructureComponent>>> = {
  plan: PLAN_IMPLEMENTATIONS,
  structure: STRUCTURE_IMPLEMENTATIONS,
};

for (const slot of SLOTS) {
  const entry = SLOT_CATALOGUE[slot];
  if (!entry) throw new ArmResolutionError("CATALOGUE_SLOT_MISSING", `catalogue.json has no slot "${slot}"`);
  if (!WIRED_SLOTS.includes(slot)) continue;

  const impls = IMPLEMENTATIONS_BY_SLOT[slot] ?? {};
  for (const [id, meta] of Object.entries(entry.implementations)) {
    const has = Object.prototype.hasOwnProperty.call(impls, id);
    if (meta.status === "implemented" && !has) {
      throw new ArmResolutionError(
        "CATALOGUE_DRIFT",
        `${slot}="${id}" is catalogued as implemented but the registry has no implementation for it`,
      );
    }
    if (meta.status === "unimplemented" && has) {
      throw new ArmResolutionError(
        "CATALOGUE_DRIFT",
        `${slot}="${id}" is catalogued as unimplemented but the registry supplies one — ` +
          "update the catalogue in the same change, or an arm will silently run code the manifest says does not exist",
      );
    }
  }
  for (const id of Object.keys(impls)) {
    if (!entry.implementations[id]) {
      throw new ArmResolutionError("CATALOGUE_DRIFT", `${slot}="${id}" is implemented but absent from catalogue.json`);
    }
  }
}

/**
 * VALIDATE a component name, for ANY slot. Unknown id -> throw. This is what every slot
 * gets, including the four that are not routed through the registry.
 *
 * SEPARATED FROM `componentFor` DELIBERATELY, and this separation is a bug fix, not a
 * refinement. The first version of this file had one function doing both jobs, so resolving
 * the BASELINE manifest — whose `ingest` is `v2-two-pass`, a component that exists as code
 * but is reached by direct import rather than through the registry — demanded a callable
 * that by design does not exist, and threw. That regressed four previously-green workflow
 * tests on the no-manifest path, which is the exact failure ARCHITECTURE.md §3.1 promises
 * cannot happen. "Named in the catalogue" and "bound to a callable here" are two different
 * questions and they now have two different functions.
 */
export function validateComponent(slot: SlotId, id: string): CatalogueImpl {
  const entry = SLOT_CATALOGUE[slot];
  const meta = entry?.implementations?.[id];
  if (!meta) {
    const known = Object.keys(entry?.implementations ?? {}).join(", ") || "(none)";
    throw new ArmResolutionError("UNRESOLVED_COMPONENT", `${slot}="${id}" is not in the catalogue. Known: ${known}`);
  }
  return meta;
}

/**
 * BIND a component to code. Only legal for a WIRED slot (types.ts#WIRED_SLOTS) — asking an
 * unwired slot for a callable is a programming error here, not a manifest error, and it says
 * so rather than blaming the manifest.
 *
 * Known-but-unimplemented -> a THROWING STUB, never a fallback to the baseline. A silent
 * fallback is the wrong-arm failure per-arm deployment exists to prevent.
 */
export function componentFor(slot: "plan", id: string): PlanComponent;
export function componentFor(slot: "structure", id: string): StructureComponent;
export function componentFor(slot: SlotId, id: string): PlanComponent | StructureComponent;
export function componentFor(slot: SlotId, id: string): PlanComponent | StructureComponent {
  const meta = validateComponent(slot, id);
  if (!WIRED_SLOTS.includes(slot)) {
    throw new ArmResolutionError(
      "SLOT_NOT_WIRED",
      `${slot} is not routed through the registry (types.ts#WIRED_SLOTS); its baseline is reached by direct import. ` +
        "Validate it with validateComponent() instead of asking it for a callable.",
    );
  }
  if (meta.status === "unimplemented") return unimplemented(slot, id);
  const impl = IMPLEMENTATIONS_BY_SLOT[slot]?.[id];
  if (!impl) {
    // Unreachable while the load-time assertion above holds — and that assertion covers
    // exactly the wired slots, which is exactly the set that reaches this line.
    throw new ArmResolutionError("UNRESOLVED_COMPONENT", `${slot}="${id}" catalogued as implemented but not bound`);
  }
  return impl;
}

/** What the catalogue says about an id — used by resolve() and by the harness verifier. */
export function catalogueEntry(slot: SlotId, id: string): CatalogueImpl | null {
  return SLOT_CATALOGUE[slot]?.implementations?.[id] ?? null;
}

export function slotIsExperimental(slot: SlotId): boolean {
  return Boolean(SLOT_CATALOGUE[slot]?.experimentalVariable);
}
