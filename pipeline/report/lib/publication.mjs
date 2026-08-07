// The publication gate, the four trust statements, and operational blockers.
//
// Design authority: docs/ui-report-redesign.md AMENDMENT A.
//
// AMENDMENT A, the single trust killer: "a green `Pass` whose linked artifact
// visibly proves failure. The first such click destroys confidence in every
// other row. Therefore: no current `Pass` may receive pass styling or enter
// headline counts until its cited typed observation satisfies the named
// decision predicate. If evidence contradicts the verdict, final-report
// publication FAILS CLOSED or the row becomes `Judgment pending`. Attestation
// cannot rescue it."
//
// Everything in this module is deterministic and reads only fields the judging
// stage already publishes. Nothing here infers, scores, or asks a model.
//
// D11: it reads those fields — it does not BELIEVE the summary ones. The
// aggregate `attestation.allVerified` and the structural soundness of the proof
// are recomputed here from the individual attestations, using the shared
// implementation in judgement-record.mjs, so that a producer regression that
// emits `supportingWitnesses: [{}]` beside `allVerified: true` cannot publish a
// pass even if it somehow reaches this function.

import { recomputeWitnessAttestation, validateResultProof } from "./judgement-record.mjs";

/* ------------------------------------------------------------------ *
 * The publication gate                                                *
 * ------------------------------------------------------------------ */

export const PUBLICATION_GATE_VERSION = "survey-qa-publication-gate/1.0.0";

/**
 * The four conditions a current PASS must satisfy before it may be published
 * as a pass. They are checked in a fixed order so the reported reason is
 * stable, and each one names what a reader would have to click to see it.
 */
export const PASS_GATE_CONDITIONS = [
  {
    id: "cited-observation",
    label: "A typed observation is cited",
    why: "A pass with nothing to click is not auditable, and the first run's false passes were exactly this shape.",
  },
  {
    id: "named-predicate",
    label: "A named decision predicate ran and is satisfied",
    why: "The verdict must come from a predicate over the observation, not from prose about it.",
  },
  {
    id: "witnesses-reverified",
    label: "Every cited witness re-verified against a fresh read of its artifact",
    why: "Attestation proves provenance, not truth. The bytes must still say what the verdict says they say.",
  },
  {
    id: "no-contradicting-evidence",
    label: "No counter-witness contradicts the pass",
    why: "A pass whose own evidence set contains a counter-witness is the trust killer this gate exists to stop.",
  },
  {
    id: "proof-well-formed",
    label: "The proof is structurally sound and its own summary is true",
    why:
      "A witness with no artifact, locator or hash pins nothing; an attestation set that does not correspond to the cited witnesses attests something else; and an `allVerified: true` that is false of its own entries is a signed misstatement. None of those can be rescued by a signature.",
  },
];

/**
 * @param {object|null} judged a JudgementRecord result entry
 * @returns {{publishable: boolean, failed: string[], reason: string|null, conditions: object[]}}
 */
export function evaluatePassPublication(judged) {
  const results = [];
  const supporting = Array.isArray(judged?.supportingWitnesses) ? judged.supportingWitnesses : [];
  const counter = Array.isArray(judged?.counterWitnesses) ? judged.counterWitnesses : [];
  const evidenceRefs = Array.isArray(judged?.evidenceRefs) ? judged.evidenceRefs : [];

  const cited = supporting.length > 0 || evidenceRefs.length > 0;
  results.push({
    id: "cited-observation",
    ok: cited,
    detail: cited
      ? `${supporting.length} supporting witness(es) and ${evidenceRefs.length} evidence reference(s) are cited.`
      : "This pass cites no typed observation at all.",
  });

  const predicateOk = Boolean(judged?.predicateId) && judged?.predicateOutcome === "satisfied";
  results.push({
    id: "named-predicate",
    ok: predicateOk,
    detail: judged?.predicateId
      ? `Predicate ${judged.predicateId} reported ${JSON.stringify(judged?.predicateOutcome ?? null)}.`
      : "No named decision predicate is recorded for this result.",
  });

  // RECOMPUTED from the individual attestations, never read off the summary
  // field. `[].every(...)` is true, which is how a claim citing nothing at all
  // once reported itself fully re-verified.
  const att = recomputeWitnessAttestation(judged);
  const reverified = att.allVerified;
  results.push({
    id: "witnesses-reverified",
    ok: reverified,
    detail: reverified
      ? `Every cited witness was re-read from its artifact bytes and re-verified (${att.ok} of ${att.total}, recomputed from the individual attestations).`
      : att.falsified
        ? `The record claims every witness re-verified, but only ${att.ok} of ${att.total} individual attestation(s) say so. The aggregate claim is false of its own contents.`
        : att.total === 0
          ? "No per-witness re-verification is recorded at all, so nothing states that any cited byte still says what the verdict says it says."
          : `${att.total - att.ok} of ${att.total} cited witness(es) did not re-verify against a fresh read of the artifact.`,
  });

  const noCounter = counter.length === 0;
  results.push({
    id: "no-contradicting-evidence",
    ok: noCounter,
    detail: noCounter
      ? "No counter-witness is attached to this result."
      : `${counter.length} counter-witness(es) are attached to a result recorded as a pass.`,
  });

  const proofProblems = validateResultProof(judged, "this result");
  results.push({
    id: "proof-well-formed",
    ok: proofProblems.length === 0,
    detail: proofProblems.length
      ? proofProblems.map((p) => p.message).join(" ")
      : "Every cited witness names an artifact, a locator and a hash; each one has exactly one attestation of the same bytes; and the aggregate re-verification claim is true of those attestations.",
    problems: proofProblems,
  });

  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  const byId = new Map(PASS_GATE_CONDITIONS.map((c) => [c.id, c]));
  return {
    publishable: failed.length === 0,
    failed,
    reason: failed.length
      ? failed
          .map((id) => {
            const c = byId.get(id);
            const r = results.find((x) => x.id === id);
            return `${c.label}: no. ${r.detail}`;
          })
          .join(" ")
      : null,
    conditions: results.map((r) => ({ ...r, ...byId.get(r.id) })),
  };
}

/* ------------------------------------------------------------------ *
 * The four trust statements                                           *
 * ------------------------------------------------------------------ *
 * AMENDMENT A: "Four SEPARATE trust statements — never one green 'Verified':
 * Record signature: valid (integrity only, not correctness) · Evidence files:
 * hash-verified · Contract review: sealed/reviewed · Result review:
 * complete/partial/not run · policy version · N changed. A generic green badge
 * beside a wrong pass count is actively misleading."
 */
export function buildTrustStatements({ attestation, evidenceAudit, evidenceCount, revision, resultReview }) {
  const audits = [...(evidenceAudit?.values?.() ?? [])];
  const verified = audits.filter((a) => a.state === "verified").length;
  const mismatched = audits.filter((a) => a.state === "mismatch").length;
  const missing = audits.filter((a) => a.state === "missing").length;

  const evidenceState = !audits.length
    ? "not-checked"
    : mismatched > 0
      ? "invalid"
      : verified === evidenceCount && verified > 0
        ? "verified"
        : "partial";

  return [
    {
      id: "record-signature",
      label: "Record signature",
      state: attestation.state === "verified" ? "valid" : attestation.state === "invalid" ? "invalid" : "unchecked",
      tone: attestation.state === "verified" ? "ok" : attestation.state === "invalid" ? "bad" : "warn",
      value:
        attestation.state === "verified"
          ? "valid"
          : attestation.state === "invalid"
            ? "invalid"
            : "not checked",
      scope: "Integrity only. It proves the record was not altered after signing. It says nothing about whether any verdict in it is correct.",
      detail: attestation.reason ?? null,
    },
    {
      id: "evidence-files",
      label: "Evidence files",
      state: evidenceState,
      tone: evidenceState === "verified" ? "ok" : evidenceState === "invalid" ? "bad" : "warn",
      value:
        evidenceState === "not-checked"
          ? "not re-hashed in this render"
          : evidenceState === "invalid"
            ? `${mismatched} artifact(s) do not match the signed hash`
            : `${verified} of ${evidenceCount} hash-verified${missing ? `, ${missing} absent` : ""}`,
      scope: "Whether the stored bytes still hash to the value the signed catalogue records. It is not a statement about what the bytes mean.",
      detail: null,
    },
    {
      id: "contract-review",
      // Sealed and human-reviewed are separate facts (see sealedContractRevision). A
      // sealed-but-unreviewed revision is neither "sealed" (which would over-claim a
      // review) nor "not-sealed" (which would deny a revision identity that exists).
      label: "Contract review",
      state: !revision.sealed ? "not-sealed" : revision.humanReviewed === false ? "sealed-unreviewed" : "sealed",
      tone: revision.sealed && revision.humanReviewed !== false ? "ok" : "warn",
      value: !revision.sealed
        ? "no sealed revision — the denominator has not been through review"
        : `sealed revision ${revision.revisionId ?? "(unnamed)"}${revision.sealedAt ? ` · ${revision.sealedAt}` : ""}${
            revision.humanReviewed === false ? " · gate-approved, NOT human-reviewed" : ""
          }`,
      // THREE FACTS, NOT ONE. Sealing can be automated — the §0 gate sealer
      // mints an immutable, content-addressed revision id with no human in the
      // loop — so "a human sealed it" was a false description of what this
      // statement reports. Sealed (an identity exists), humanReviewed (a person
      // read the extraction) and certified (the results were cleared) are three
      // separate facts, and this axis reports the first two.
      scope:
        "Two facts, kept apart: whether an immutable contract revision identity exists (sealing, which may be automated), and whether a human reviewed the extraction it carries. A contract hash identifies bytes; it is neither a seal nor a review, and a seal is not a review.",
      detail: revision.why ?? null,
    },
    {
      id: "result-review",
      label: "Result review",
      state: resultReview.state,
      tone: resultReview.state === "complete" ? "ok" : resultReview.state === "not-run" ? "warn" : "warn",
      value: resultReview.headline,
      scope:
        "Whether an independent stage re-derived every verdict from the artifacts, and what result policy it used. This is the axis that decides whether the numbers on this page are current.",
      detail: resultReview.policyVersion ?? null,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Operational blockers (D8)                                           *
 * ------------------------------------------------------------------ *
 * AMENDMENT A: "DIV-001 gets a permanent top-level lane — 'Critical
 * operational blocker outside the document-derived denominator'. It must not
 * be buried because the expert answer key omitted it."
 *
 * D8: a report that says "no certification blocker remains" while the survey
 * does not open in an unmodified browser is lying by omission. Operational
 * blockers are certification blockers.
 *
 * The rule is deterministic and evidence-backed — nothing is inferred from
 * prose severity alone:
 *   (a) any finding of kind `blocker`; or
 *   (b) any CRITICAL finding that the record's own disclosed harness
 *       modification names as the reason the target had to be modified.
 * (b) is not a guess: the record itself states that the run was only possible
 * because of that finding.
 */
export function collectOperationalBlockers({ findings = [], runContext = {} }) {
  const mod = runContext?.disclosedModification ?? null;
  const modText = mod ? [mod.what, mod.why, mod.scope, mod.consequence].filter(Boolean).join(" \n ") : "";

  const out = [];
  for (const f of findings) {
    const namedByModification =
      Boolean(mod) && typeof f.findingId === "string" && f.findingId.length > 0 && modText.includes(f.findingId);
    const isBlockerKind = f.kind === "blocker";
    const isCriticalOperational = f.severity === "critical" && namedByModification;
    if (!isBlockerKind && !isCriticalOperational) continue;
    out.push({
      findingId: f.findingId,
      kind: f.kind,
      severity: f.severity ?? null,
      category: f.category ?? null,
      summary: f.summary ?? "",
      expected: f.expected ?? null,
      observed: f.observed ?? null,
      itemRefs: Array.isArray(f.itemRefs) ? f.itemRefs : [],
      evidenceRefs: Array.isArray(f.evidenceRefs) ? f.evidenceRefs : [],
      basis: isCriticalOperational
        ? "Critical, and the record's own disclosed harness modification names this finding as the reason the target could not be run unmodified."
        : "Recorded by the run as a blocker.",
      outsideDenominator: isCriticalOperational,
      conditionsEveryResult: isCriticalOperational,
    });
  }

  // Deterministic order: the ones that condition every other result first.
  out.sort((a, b) => (b.conditionsEveryResult ? 1 : 0) - (a.conditionsEveryResult ? 1 : 0) || String(a.findingId).localeCompare(String(b.findingId)));

  return {
    entries: out,
    present: out.length > 0,
    conditioning: out.filter((x) => x.conditionsEveryResult),
    disclosedModification: mod,
    rule:
      "An operational blocker is a finding of kind `blocker`, or a critical finding that the record's disclosed harness modification names as the reason the target could not be run unmodified. Operational blockers are certification blockers even when they sit outside the document-derived denominator.",
  };
}
