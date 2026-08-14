/**
 * RETENTION — permanent evidence, reports and run state.
 *
 * Deployment variables attest the permanent policy as 0/0/0 + `permanent`; any drift
 * is rejected before the audit lists or mutates storage.
 *
 * WHY THIS IS CODE AND NOT AN R2 LIFECYCLE RULE — this is the constraint that decided
 * the design: R2 lifecycle rules are configured per BUCKET (optionally per prefix, but
 * managed at bucket level), and `survey-qa-artifacts` is SHARED with the live production
 * worker. A misconfigured lifecycle rule would delete v1 evidence. v2 therefore enforces
 * its own retention with a prefix-scoped sweep that can only ever see keys under `v2/`,
 * because every key it touches goes through `assertV2Key`.
 *
 * The bounded sweep is audit-only. It has no delete call and age never creates an
 * eligible object. Storage pressure permits compression, never deletion or pruning.
 */

import type { Env } from "../types/env";
import { V2_PREFIX, assertV2Key, retentionReportKey } from "../keys";

export interface RetentionPolicy {
  rawEvidenceDays: number;
  reportDays: number;
  contractDays: number;
  mode: "permanent";
}

export function retentionPolicy(env: Env): RetentionPolicy {
  if (
    (env.RETENTION_RAW_EVIDENCE_DAYS ?? "0") !== "0" ||
    (env.RETENTION_REPORT_DAYS ?? "0") !== "0" ||
    (env.RETENTION_CONTRACT_DAYS ?? "0") !== "0" ||
    (env.RETENTION_MODE ?? "permanent") !== "permanent"
  ) {
    throw new Error("RETENTION_POLICY_INVALID: permanent retention requires 0/0/0 and mode=permanent");
  }
  return {
    rawEvidenceDays: 0,
    reportDays: 0,
    contractDays: 0,
    mode: "permanent",
  };
}

/** Which class a v2 key belongs to. Anything unclassified is NEVER deleted. */
export type RetentionClass = "raw-evidence" | "report" | "contract" | "run-state" | "unclassified";

export function classify(key: string): RetentionClass {
  assertV2Key(key);
  const rest = key.slice(V2_PREFIX.length);
  if (rest.startsWith("evidence/sha256/")) return "raw-evidence";
  if (rest.startsWith("reports/")) return "report";
  if (rest.startsWith("contracts/")) return "contract";
  if (rest.startsWith("runs/")) {
    // Classification remains useful in audit output even though every class is permanent.
    return rest.includes("/evidence/") || rest.includes("/execution/") ? "raw-evidence" : "run-state";
  }
  return "unclassified";
}

export function retentionDays(policy: RetentionPolicy, cls: RetentionClass): number | null {
  // Owner policy (14 Aug 2026): every real-link run is permanent, including failed
  // and partial runs. The configured ages remain visible in the audit report, but age
  // is never authority to delete any v2 object. Storage pressure permits compression,
  // never deletion or pruning.
  void policy;
  void cls;
  return null;
}

export interface RetentionPlan {
  ranAt: string;
  policy: RetentionPolicy;
  scanned: number;
  eligible: { key: string; cls: RetentionClass; ageDays: number; size: number }[];
  skippedStillReferenced: string[];
  bytesEligible: number;
  deleted: number;
}

/**
 * Enumerate the v2 namespace for a bounded audit. `referencedHashes` remains in the
 * stable call contract, but permanent policy makes every object ineligible by construction.
 */
export async function planRetention(
  env: Env,
  now: Date,
  referencedHashes: Set<string> | null,
  budget = 1000,
): Promise<RetentionPlan> {
  const policy = retentionPolicy(env);
  const plan: RetentionPlan = {
    ranAt: now.toISOString(),
    policy,
    scanned: 0,
    eligible: [],
    skippedStillReferenced: [],
    bytesEligible: 0,
    deleted: 0,
  };

  let cursor: string | undefined;
  while (plan.scanned < budget) {
    const page = await env.EVIDENCE.list({ prefix: V2_PREFIX, cursor, limit: 500 });
    for (const obj of page.objects) {
      plan.scanned++;
      const cls = classify(obj.key);
      const days = retentionDays(policy, cls);
      if (days === null) continue;
      const ageDays = (now.getTime() - obj.uploaded.getTime()) / 86_400_000;
      if (ageDays < days) continue;

      if (cls === "raw-evidence" && obj.key.includes("/evidence/sha256/")) {
        const hash = obj.key.slice(obj.key.lastIndexOf("/") + 1);
        if (referencedHashes === null || referencedHashes.has(hash)) {
          plan.skippedStillReferenced.push(obj.key);
          continue;
        }
      }
      plan.eligible.push({ key: obj.key, cls, ageDays: Math.round(ageDays * 10) / 10, size: obj.size });
      plan.bytesEligible += obj.size;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  // There is deliberately no delete path.
  return plan;
}

export async function writeRetentionReport(env: Env, plan: RetentionPlan): Promise<string> {
  const isoDay = plan.ranAt.slice(0, 10);
  const key = retentionReportKey(isoDay);
  await env.EVIDENCE.put(key, JSON.stringify(plan, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}
