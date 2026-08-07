// Evidence integrity vs sufficiency (threat-model §7).
//
// Integrity (per registry artifact):
//   - artifactRef must be run-scoped: "runs/<runId>/artifacts/<name>".
//     Any other run's scope => EVIDENCE_CROSS_RUN_REUSE (P0 policy: cross-run
//     reuse is forbidden).
//   - artifact bytes are RE-HASHED from --artifacts-dir and must match the
//     signed contentHash/byteLength => else EVIDENCE_HASH_MISMATCH; a missing
//     file is EVIDENCE_MISSING (a valid record signature never excuses
//     missing or modified artifact bytes, §10/§8).
//   - capture lineage (attemptId/actionId/stateId/capturedAt) must agree with
//     the attested execution events => else EVIDENCE_LINEAGE_MISMATCH.
//
// Sufficiency (per claim, pinned policy minimums) — every rule below is
// CLAIM-RELEVANT: an artifact only supports a claim about item X when the
// attempt that captured it was actually trying to exercise X. One screenshot
// may witness several items, but only those its capturing attempt targeted.
//   - exercised item: >=1 resolved attempt that TARGETS the item (its
//     targetItemIds contains it) + >=1 integrity-valid evidence whose
//     capture.attemptId is that same attempt.
//   - blocked / budget-exhausted / time-exhausted: an integrity-valid
//     blocker-packet. With attempts: the packet must come from a referenced
//     attempt that targets the item and that recorded a last valid state.
//     Without attempts (path never started): a run-level packet is accepted.
//   - proven-unreachable: an integrity-valid reachability-packet AND
//     agreement with private oracle reachability (else
//     REACHABILITY_FALSE_CLAIM: no coverage credit, item stays unassessed).
//   - asserted defect finding: NON-EMPTY attemptRefs, all resolving to
//     attempts that target at least one of the finding's items, plus >=1
//     integrity-valid evidence captured in one of those attempts. A defect
//     claim can never be supported by a free-floating run-level artifact.
//   - blocker finding: an integrity-valid blocker-packet from a referenced
//     attempt that recorded a last valid state (or a run-level packet when the
//     finding references no attempt at all).

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sha256OfBytes } from "./canonical.mjs";

export const EVIDENCE_POLICY_VERSION = "survey-qa-scorer-evidence-policy/1.1.0";

/** Statuses that require evidence to be credited/accounted (§7). */
export const EVIDENCE_REQUIRED_STATUSES = Object.freeze([
  "exercised",
  "blocked",
  "budget-exhausted",
  "time-exhausted",
  "proven-unreachable",
]);

function resolveArtifact(artifactRef, runId, artifactsDir) {
  const prefix = `runs/${runId}/artifacts/`;
  if (!artifactRef.startsWith(prefix)) {
    return { code: "EVIDENCE_CROSS_RUN_REUSE" };
  }
  const rel = artifactRef.slice(prefix.length);
  if (rel.length === 0 || rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
    return { code: "EVIDENCE_CROSS_RUN_REUSE" };
  }
  return { filePath: path.join(artifactsDir, rel) };
}

/**
 * Integrity assessment of every registry artifact.
 * Returns { status: Map(evidenceId -> {valid, code?}), errors: [{code,message}] }.
 */
export function assessArtifacts(run, artifactsDir, index) {
  const status = new Map();
  const errors = [];
  const runId = run.run.runId;

  for (const ev of run.evidence) {
    let verdict = { valid: true };

    const resolved = resolveArtifact(ev.artifactRef, runId, artifactsDir);
    if (resolved.code) {
      verdict = { valid: false, code: resolved.code };
      errors.push({
        code: resolved.code,
        message: `evidence ${ev.evidenceId}: artifactRef "${ev.artifactRef}" is not scoped to run ${runId}`,
      });
    } else if (!existsSync(resolved.filePath)) {
      verdict = { valid: false, code: "EVIDENCE_MISSING" };
      errors.push({
        code: "EVIDENCE_MISSING",
        message: `evidence ${ev.evidenceId}: artifact bytes not found for "${ev.artifactRef}"`,
      });
    } else {
      const bytes = readFileSync(resolved.filePath);
      const hash = sha256OfBytes(bytes);
      if (hash !== ev.contentHash || bytes.length !== ev.byteLength) {
        verdict = { valid: false, code: "EVIDENCE_HASH_MISMATCH" };
        errors.push({
          code: "EVIDENCE_HASH_MISMATCH",
          message: `evidence ${ev.evidenceId}: stored bytes (${hash}, ${bytes.length}B) do not match signed ${ev.contentHash}, ${ev.byteLength}B`,
        });
      }
    }

    // Redaction consistency (schema allows method null only when not-required).
    if (verdict.valid) {
      if (ev.redaction.status === "not-required" ? false : ev.redaction.method === null) {
        verdict = { valid: false, code: "EVIDENCE_LINEAGE_MISMATCH" };
        errors.push({
          code: "EVIDENCE_LINEAGE_MISMATCH",
          message: `evidence ${ev.evidenceId}: redaction status ${ev.redaction.status} without a method`,
        });
      }
    }

    // Capture lineage.
    if (verdict.valid) {
      const cap = ev.capture;
      const lineageFail = (msg) => {
        verdict = { valid: false, code: "EVIDENCE_LINEAGE_MISMATCH" };
        errors.push({ code: "EVIDENCE_LINEAGE_MISMATCH", message: `evidence ${ev.evidenceId}: ${msg}` });
      };
      if (cap.attemptId !== null && !index.attemptById.has(cap.attemptId)) {
        lineageFail(`capture attempt ${cap.attemptId} does not exist in this run`);
      } else {
        if (cap.actionId !== null) {
          const owner = index.actionToAttempt.get(cap.actionId);
          if (owner === undefined) lineageFail(`capture action ${cap.actionId} does not exist`);
          else if (cap.attemptId === null || owner !== cap.attemptId) {
            lineageFail(`capture action ${cap.actionId} belongs to attempt ${owner}, not ${cap.attemptId}`);
          }
        }
        if (verdict.valid && cap.stateId !== null) {
          const owner = index.stateToAttempt.get(cap.stateId);
          if (owner === undefined) lineageFail(`capture state ${cap.stateId} does not exist`);
          else if (cap.attemptId === null || owner !== cap.attemptId) {
            lineageFail(`capture state ${cap.stateId} belongs to attempt ${owner}, not ${cap.attemptId}`);
          }
        }
        if (verdict.valid && cap.attemptId !== null) {
          const attempt = index.attemptById.get(cap.attemptId);
          const at = Date.parse(ev.capturedAt);
          if (at < Date.parse(attempt.timestamps.startedAt) || at > Date.parse(attempt.timestamps.endedAt)) {
            lineageFail(`capturedAt ${ev.capturedAt} lies outside attempt ${cap.attemptId}'s window`);
          }
        }
      }
    }

    status.set(ev.evidenceId, verdict);
  }
  return { status, errors };
}

function validCitations(refs, artifactStatus, evidenceById) {
  const out = [];
  for (const r of refs) {
    const ev = evidenceById.get(r);
    if (!ev) continue; // unresolved ref already reported as EVIDENCE_MISSING
    const st = artifactStatus.get(r);
    if (st && st.valid) out.push(ev);
  }
  return out;
}

/**
 * Claim-level sufficiency. Returns:
 * {
 *   itemSufficient: Map(itemId -> boolean)   (for evidence-required statuses),
 *   findingSufficient: Map(findingId -> boolean),
 *   requiredClaims, sufficientClaims,
 *   errors, warnings
 * }
 */
export function assessClaims({ run, index, artifactStatus, itemToOracle, oracleById }) {
  const errors = [];
  const warnings = [];
  const itemSufficient = new Map();
  const findingSufficient = new Map();
  let requiredClaims = 0;
  let sufficientClaims = 0;

  // Claim relevance (§7.1): an attempt supports a claim about an item only
  // when the attempt was targeting that item.
  const attemptTargets = (attemptId) => {
    const a = index.attemptById.get(attemptId);
    return a ? new Set(a.targetItemIds) : new Set();
  };

  for (const [itemId, r] of index.resultByItemId) {
    if (!EVIDENCE_REQUIRED_STATUSES.includes(r.coverageStatus)) continue;
    requiredClaims++;
    let ok = false;
    const cited = validCitations(r.evidenceRefs, artifactStatus, index.evidenceById);
    const resolvedAttempts = r.attemptRefs.filter((a) => index.attemptById.has(a));
    const attemptSet = new Set(resolvedAttempts);
    // Only attempts that actually targeted this item can witness it.
    const relevantAttempts = new Set(
      resolvedAttempts.filter((a) => attemptTargets(a).has(itemId))
    );

    if (r.coverageStatus === "exercised") {
      ok =
        relevantAttempts.size > 0 &&
        cited.some((ev) => ev.capture.attemptId !== null && relevantAttempts.has(ev.capture.attemptId));
      if (!ok) {
        const irrelevant = attemptSet.size > 0 && relevantAttempts.size === 0;
        warnings.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: irrelevant
            ? `exercised item ${itemId} cites only attempts that never targeted it (claim-irrelevant evidence); no coverage credit`
            : `exercised item ${itemId} has no integrity-valid evidence captured in an attempt targeting it; no coverage credit`,
        });
      }
    } else if (["blocked", "budget-exhausted", "time-exhausted"].includes(r.coverageStatus)) {
      const packets = cited.filter((ev) => ev.type === "blocker-packet");
      if (attemptSet.size === 0) {
        // Nothing was attempted for this item: a run-level blocker packet is
        // the only thing that can exist, and it must not be attempt-scoped.
        ok = packets.some((ev) => ev.capture.attemptId === null);
      } else {
        ok = packets.some((ev) => {
          if (ev.capture.attemptId === null || !relevantAttempts.has(ev.capture.attemptId)) return false;
          const a = index.attemptById.get(ev.capture.attemptId);
          return a.stop.lastValidStateId !== null; // last valid state required
        });
      }
      if (!ok) {
        warnings.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: `${r.coverageStatus} item ${itemId} lacks an integrity-valid blocker packet from an attempt that targeted it with a last valid state`,
        });
      }
    } else if (r.coverageStatus === "proven-unreachable") {
      const packets = cited.filter((ev) => ev.type === "reachability-packet");
      const oracleId = itemToOracle.get(itemId);
      const obligation = oracleId ? oracleById.get(oracleId) : undefined;
      if (packets.length === 0) {
        ok = false;
        errors.push({
          code: "REACHABILITY_FALSE_CLAIM",
          message: `item ${itemId} claims proven-unreachable without an integrity-valid reachability packet`,
        });
      } else if (!obligation) {
        ok = false;
        warnings.push({
          code: "REACHABILITY_UNVERIFIED",
          message: `item ${itemId} claims proven-unreachable but matches no oracle obligation; no credit`,
        });
      } else if (obligation.reachability.status !== "unreachable") {
        ok = false;
        errors.push({
          code: "REACHABILITY_FALSE_CLAIM",
          message: `item ${itemId} claims proven-unreachable but oracle obligation ${oracleId} is reachable`,
        });
      } else {
        ok = true;
      }
    }

    itemSufficient.set(itemId, ok);
    if (ok) sufficientClaims++;
  }

  for (const f of run.findings) {
    if (f.kind !== "defect" && f.kind !== "blocker") continue;
    requiredClaims++;
    const cited = validCitations(f.evidenceRefs, artifactStatus, index.evidenceById);
    const resolvedAttempts = f.attemptRefs.filter((a) => index.attemptById.has(a));
    const attemptSet = new Set(resolvedAttempts);
    const itemRefs = new Set(f.itemRefs);
    // Attempts that were actually trying to exercise one of the claimed items.
    const relevantAttempts = new Set(
      resolvedAttempts.filter((a) => [...attemptTargets(a)].some((t) => itemRefs.has(t)))
    );
    let ok;
    let reason = "lacks integrity-valid supporting evidence";
    if (f.kind === "defect") {
      // A defect claim MUST be anchored to attempts that targeted its items,
      // and its evidence must come from those attempts. An empty attemptRefs
      // list can no longer be cured by citing any run-level artifact.
      if (attemptSet.size === 0) {
        ok = false;
        reason = "cites no attempt; a defect claim cannot rest on run-level artifacts";
      } else if (relevantAttempts.size === 0) {
        ok = false;
        reason = "cites only attempts that never targeted its items (claim-irrelevant)";
      } else {
        ok = cited.some((ev) => ev.capture.attemptId !== null && relevantAttempts.has(ev.capture.attemptId));
        if (!ok) reason = "has no integrity-valid evidence captured in an attempt targeting its items";
      }
    } else {
      const packets = cited.filter((ev) => ev.type === "blocker-packet");
      if (attemptSet.size === 0) {
        ok = packets.some((ev) => ev.capture.attemptId === null);
        if (!ok) reason = "lacks an integrity-valid run-level blocker packet";
      } else {
        ok = packets.some((ev) => {
          if (ev.capture.attemptId === null || !attemptSet.has(ev.capture.attemptId)) return false;
          const a = index.attemptById.get(ev.capture.attemptId);
          return a.stop.lastValidStateId !== null;
        });
        if (!ok) reason = "lacks a blocker packet plus last valid state from one of its attempts";
      }
    }
    if (!ok) {
      warnings.push({
        code: "EVIDENCE_INSUFFICIENT",
        message: `finding ${f.findingId} (${f.kind}) ${reason}; no credit`,
      });
    }
    findingSufficient.set(f.findingId, ok);
    if (ok) sufficientClaims++;
  }

  return { itemSufficient, findingSufficient, requiredClaims, sufficientClaims, errors, warnings };
}
