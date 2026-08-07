/**
 * RESOLVE — env.ARM_MANIFEST (a pinned JSON string) -> a frozen ResolvedArm, or a throw.
 *
 * ONE VARIABLE, read ONCE per run. The mechanism is deliberately the one
 * `JUDGEMENT_KEY_REGISTRY` already uses in worker-v2/wrangler.jsonc: a JSON string in
 * config, so certifying a new arm is a reviewed edit to a config file and can never be
 * something a request supplies.
 *
 * THREE PROPERTIES, ALL LOAD-BEARING
 *
 *  1. ABSENT MANIFEST -> BASELINE, which is byte-for-byte today's behaviour. survey-qa-v2
 *     carries no ARM_MANIFEST and therefore does not change. That is what makes this seam
 *     reversible: delete src/arms/ and one call site and the pipeline is what it was.
 *
 *  2. AN UNRESOLVABLE COMPONENT THROWS. It never falls back. A deployed arm-B Worker naming
 *     a `structure` implementation that does not exist must fail loudly on its first run,
 *     not quietly run arm A's pipeline under arm B's name.
 *
 *  3. THE COMPONENT SET IS HASHED TWICE — once at build from the manifest
 *     (evaluation/arms/identity.mjs), once HERE from what was actually resolved — and the
 *     two must agree. That is the check that catches a manifest which does not describe
 *     what the arm ran.
 *
 *     ITS LIMIT, STATED: this compares the resolved slot->id map and the catalogue's binding
 *     strings. It cannot witness that a bound module's CONTENT is unchanged — nothing
 *     running inside a bundle can hash its own sources. `treeHash`, computed at build over
 *     the exact file set bundled, is what covers that, and parity on it is checked across
 *     arms by evaluation/arms/verify.mjs. Neither check subsumes the other.
 */

import type { Env } from "../types/env";
import { componentFor, catalogueEntry, validateComponent } from "./registry";
import {
  ArmResolutionError,
  SLOTS,
  type ArmBuildIdentity,
  type ArmManifest,
  type ResolvedArm,
  type SlotId,
} from "./types";

/**
 * The baseline, inline. `evaluation/arms/manifests/baseline.json` is the same object;
 * verify.mjs asserts they have not drifted (BASELINE_DRIFT), because two copies of a
 * default is exactly how a default quietly becomes two different defaults.
 */
export const BASELINE_MANIFEST: ArmManifest = Object.freeze({
  manifestVersion: "survey-qa-arm-manifest/1.0.0",
  armId: "BASELINE",
  label: "worker-v2 as deployed — not an experimental condition",
  workerName: "survey-qa-v2",
  components: Object.freeze({
    ingest: "v2-two-pass",
    structure: "none",
    plan: "v2-two-tier",
    traverse: "v2-execute-batch",
    judge: "v2-deterministic",
  }) as Record<SlotId, string>,
  sharedIngestRevision: null,
  declaredAttribution: [],
});

export const MANIFEST_VERSION = "survey-qa-arm-manifest/1.0.0";

/**
 * The canonical form the component-set hash is taken over. Defined ONCE, here, and
 * reimplemented identically in evaluation/arms/identity.mjs — with a cross-check
 * (HASH_ALGO_DRIFT) that the two produce the same digest for the same manifest, because a
 * hash computed two ways by two files is a comparison that silently stops comparing.
 */
export function canonicalComponentSet(components: Record<SlotId, string>): string {
  return JSON.stringify(SLOTS.map((s) => [s, components[s], catalogueEntry(s, components[s])?.binds ?? null]));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseManifest(raw: string): ArmManifest {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new ArmResolutionError("MANIFEST_UNPARSEABLE", String((e as Error).message));
  }
  if (typeof m !== "object" || m === null) throw new ArmResolutionError("MANIFEST_UNPARSEABLE", "not an object");
  const man = m as Partial<ArmManifest>;

  if (man.manifestVersion !== MANIFEST_VERSION) {
    throw new ArmResolutionError(
      "MANIFEST_VERSION_MISMATCH",
      `expected ${MANIFEST_VERSION}, got ${String(man.manifestVersion)}`,
    );
  }
  if (typeof man.armId !== "string" || !man.armId) {
    throw new ArmResolutionError("MANIFEST_INVALID", "armId is required");
  }
  if (typeof man.components !== "object" || man.components === null) {
    throw new ArmResolutionError("MANIFEST_INVALID", "components is required");
  }
  // FAIL-CLOSED ON BOTH SIDES: every slot named, and no slot named that does not exist.
  // A manifest silently missing a slot would inherit a default nobody declared.
  for (const slot of SLOTS) {
    if (typeof (man.components as Record<string, unknown>)[slot] !== "string") {
      throw new ArmResolutionError("SLOT_MISSING", `components.${slot} is required`);
    }
  }
  for (const k of Object.keys(man.components)) {
    if (!SLOTS.includes(k as SlotId)) throw new ArmResolutionError("SLOT_UNKNOWN", `components.${k} is not a slot`);
  }
  if (man.sharedIngestRevision !== null && typeof man.sharedIngestRevision !== "string") {
    throw new ArmResolutionError("MANIFEST_INVALID", "sharedIngestRevision must be a string or null");
  }
  return man as ArmManifest;
}

function parseIdentity(raw: string | undefined, armId: string): ArmBuildIdentity | null {
  if (!raw) return null;
  let id: ArmBuildIdentity;
  try {
    id = JSON.parse(raw) as ArmBuildIdentity;
  } catch (e) {
    throw new ArmResolutionError("IDENTITY_UNPARSEABLE", String((e as Error).message));
  }
  for (const f of ["armId", "sourceSha", "treeHash", "manifestHash", "componentSetHash", "buildId"] as const) {
    if (typeof id[f] !== "string" || !id[f]) {
      throw new ArmResolutionError("IDENTITY_INCOMPLETE", `armIdentity.${f} is required`);
    }
  }
  if (id.armId !== armId) {
    throw new ArmResolutionError(
      "IDENTITY_INCONSISTENT",
      `build identity says arm "${id.armId}" but the manifest says "${armId}"`,
    );
  }
  return id;
}

/**
 * Resolve once, at the top of a run. The returned object is frozen and nothing downstream
 * re-reads the manifest, so no two stages of one run can disagree about which arm they are.
 */
export async function resolveArm(env: Env): Promise<ResolvedArm> {
  const manifest = env.ARM_MANIFEST ? parseManifest(env.ARM_MANIFEST) : BASELINE_MANIFEST;
  const identity = parseIdentity(env.ARM_BUILD_IDENTITY, manifest.armId);

  // VALIDATE every slot — including the four not routed through the registry — so a
  // manifest naming a component that does not exist fails HERE, at the top of the run,
  // rather than at the stage that would have used it.
  //
  // Validation is not binding. An unwired slot has no callable by design (its baseline is
  // reached by direct import), and demanding one is what regressed the no-manifest baseline
  // path: `ingest="v2-two-pass"` exists as code, is catalogued as implemented, and has no
  // registry entry — correctly. `validateComponent` asks the question that actually matters
  // for every slot ("is this a component the catalogue knows?") and UNRESOLVED_COMPONENT
  // stays fatal for a real arm naming a real mistake.
  for (const slot of SLOTS) validateComponent(slot, manifest.components[slot]);

  const componentSetHash = `sha256:${await sha256Hex(canonicalComponentSet(manifest.components))}`;

  if (identity && identity.componentSetHash !== componentSetHash) {
    throw new ArmResolutionError(
      "MANIFEST_MISMATCH",
      `build recorded componentSetHash ${identity.componentSetHash}, runtime resolved ${componentSetHash} — ` +
        "the manifest does not describe what this build loaded",
    );
  }

  return Object.freeze({
    armId: manifest.armId,
    manifest,
    componentSetHash,
    identity,
    plan: componentFor("plan", manifest.components.plan),
    structure: componentFor("structure", manifest.components.structure),
  });
}
