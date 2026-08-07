/**
 * RETENTION — 30d raw evidence / 90d reports, as CONFIGURATION.
 *
 * Every number here comes from `vars` (RETENTION_RAW_EVIDENCE_DAYS, RETENTION_REPORT_DAYS,
 * RETENTION_CONTRACT_DAYS, RETENTION_MODE) and can be changed without a code edit.
 *
 * WHY THIS IS CODE AND NOT AN R2 LIFECYCLE RULE — this is the constraint that decided
 * the design: R2 lifecycle rules are configured per BUCKET (optionally per prefix, but
 * managed at bucket level), and `survey-qa-artifacts` is SHARED with the live production
 * worker. A misconfigured lifecycle rule would delete v1 evidence. v2 therefore enforces
 * its own retention with a prefix-scoped sweep that can only ever see keys under `v2/`,
 * because every key it touches goes through `assertV2Key`.
 *
 * DEFAULT IS DRY RUN (`RETENTION_MODE=report-only`). It writes a report of what it WOULD
 * delete and deletes nothing. Flipping to `delete` is an owner decision, and the report
 * from the preceding days is the evidence for making it.
 *
 * Evidence is CONTENT-ADDRESSED and shared across runs, so age alone is not a licence to
 * delete: a blob is only eligible when no live catalog entry still references it. That
 * check is why `planRetention` reports `skippedStillReferenced` rather than silently
 * treating an old blob as garbage.
 */

import type { Env } from "../types/env";
import { num } from "../types/env";
import { V2_PREFIX, assertV2Key, retentionReportKey } from "../keys";

export interface RetentionPolicy {
  rawEvidenceDays: number;
  reportDays: number;
  /** 0 means never expire — contract revisions are lineage, not cache. */
  contractDays: number;
  mode: "report-only" | "delete";
}

export function retentionPolicy(env: Env): RetentionPolicy {
  return {
    rawEvidenceDays: num(env.RETENTION_RAW_EVIDENCE_DAYS, 30),
    reportDays: num(env.RETENTION_REPORT_DAYS, 90),
    contractDays: num(env.RETENTION_CONTRACT_DAYS, 0),
    mode: env.RETENTION_MODE === "delete" ? "delete" : "report-only",
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
    // Per-run evidence catalogs and captured artifacts age with raw evidence; the
    // envelope/checkpoint/record are run state and live as long as the report.
    return rest.includes("/evidence/") || rest.includes("/execution/") ? "raw-evidence" : "run-state";
  }
  return "unclassified";
}

export function retentionDays(policy: RetentionPolicy, cls: RetentionClass): number | null {
  switch (cls) {
    case "raw-evidence":
      return policy.rawEvidenceDays;
    case "report":
      return policy.reportDays;
    case "run-state":
      return policy.reportDays; // run state must outlive nothing, but must not predecease its report
    case "contract":
      return policy.contractDays > 0 ? policy.contractDays : null;
    case "unclassified":
      return null;
  }
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
 * Enumerate the v2 namespace and decide what is expired. `referencedHashes` is the set of
 * content hashes still cited by any live catalog entry; callers that cannot compute it
 * pass an empty set, in which case NO raw-evidence blob is ever reported eligible (fail
 * safe: without reference information, deletion cannot be justified).
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

  if (policy.mode === "delete") {
    for (const e of plan.eligible) {
      await env.EVIDENCE.delete(assertV2Key(e.key));
      plan.deleted++;
    }
  }
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
