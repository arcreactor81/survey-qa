// JudgementRecord — the ONLY thing that may drive "current" results.
//
// Cross-cutting contract (all three v2 tracks depend on this, do not diverge):
//   A JudgementRecord must be (1) schema-validated, (2) attested with Ed25519
//   over the RFC 8785 canonical payload digest — reusing the HARDENED
//   canonicalizer in scorer/src/lib/canonical.mjs via scorer/src/lib/attest.mjs,
//   never a local reimplementation — and (3) BOUND to:
//       · the RunRecord payload hash
//       · the sealed contract revision id
//       · the target build id
//       · the evidence-manifest root
//       · the engine / compiler / predicate / ambiguity-policy versions
//   Absent or unbindable ⇒ the report may render it ONLY as a clearly
//   non-final OPERATIONAL DIAGNOSTIC. It may never become current results,
//   never take pass styling, and never enter a headline count.
//
// This module is the report's boundary. It is deliberately fail-closed: every
// negative outcome is `diagnostic`, and every reason is carried in `problems`
// so the page can print WHY rather than silently degrading.
//
// Read-only imports from scorer/ are intentional: the attestation algebra has
// exactly one implementation in this repo and this file is not allowed to be a
// second one.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

import { verifyAttestation, payloadHashOf, loadKeyRegistry } from "../../../scorer/src/lib/attest.mjs";
import { jcsHash } from "../../../scorer/src/lib/canonical.mjs";

export const JUDGEMENT_RECORD_SCHEMA = "survey-qa-judgement-record/1.0.0";
export const JUDGEMENT_RECORD_KIND = "judgement-record";

/**
 * EXACT schema allowlist. Prefix acceptance ("starts with
 * survey-qa-judgement-record/") let ANY future or invented minor version
 * through a validator written for 1.0.0 — a consumer accepting a schema it has
 * never seen is accepting a record it cannot claim to understand. A new version
 * is added here deliberately, after the reader is taught to read it.
 */
export const SUPPORTED_JUDGEMENT_RECORD_SCHEMAS = Object.freeze(["survey-qa-judgement-record/1.0.0"]);

/**
 * The producer versions this reader knows how to interpret. `binding.*Version`
 * used to be checked for non-emptiness only, so a record produced by an engine
 * whose vocabulary this report has never seen bound cleanly and drove current
 * results. Presence is not comprehension.
 *
 * 2.0.0 is the current judge (`pipeline/judge/lib/vocab.mjs` ENGINE_VERSION and
 * the sibling `*_VERSION` constants). 1.0.0 is the earlier engine whose output
 * this reader still renders.
 */
export const SUPPORTED_BINDING_VERSIONS = Object.freeze({
  engineVersion: Object.freeze(["1.0.0", "2.0.0"]),
  predicateVersion: Object.freeze(["1.0.0", "2.0.0"]),
  compilerVersion: Object.freeze(["1.0.0", "2.0.0"]),
  ambiguityPolicyVersion: Object.freeze(["1.0.0", "2.0.0"]),
  resultPolicyVersion: Object.freeze(["1.0.0", "2.0.0"]),
});

/* ------------------------------------------------------------------ *
 * The evidence-manifest root                                          *
 * ------------------------------------------------------------------ *
 * A single hash over the SIGNED evidence catalogue of a RunRecord. Both the
 * judge (when it mints a JudgementRecord) and the report (when it binds one)
 * must compute it the same way, so the definition is stated here in full and
 * exported rather than left implicit:
 *
 *   jcsHash({
 *     kind: "evidence-manifest",
 *     version: 1,
 *     runId: <RunRecord.run.runId>,
 *     entries: [ { evidenceId, contentHash, artifactRef, byteLength } ... ]
 *   })
 *
 * `entries` is sorted by evidenceId (UTF-16 code-unit order, the same ordering
 * RFC 8785 uses for object keys). Missing scalars normalize to null so the
 * hash is defined for partial catalogues instead of throwing.
 */
export function evidenceManifestRoot(record) {
  const entries = (Array.isArray(record?.evidence) ? record.evidence : [])
    .map((e) => ({
      evidenceId: e?.evidenceId ?? null,
      contentHash: e?.contentHash ?? null,
      artifactRef: e?.artifactRef ?? null,
      byteLength: typeof e?.byteLength === "number" ? e.byteLength : null,
    }))
    .sort((a, b) => String(a.evidenceId).localeCompare(String(b.evidenceId)));
  return jcsHash({
    kind: "evidence-manifest",
    version: 1,
    runId: record?.run?.runId ?? null,
    entries,
  });
}

/* ------------------------------------------------------------------ *
 * The sealed contract revision                                        *
 * ------------------------------------------------------------------ *
 * §0 of the merged contract: `DocumentRevision → ExtractionCandidate →
 * sealed ContractRevision → RunRecord/Observations → derived table cells`.
 *
 * A hash is NOT a revision identity. `sealed@<contractHash>` fabricates a
 * review that never happened, which is exactly what D9 flagged. A revision
 * identity exists only when the record carries a reviewed/sealed
 * ContractRevision block; otherwise this returns { sealed: false } and the
 * report must say so in words.
 */
export function sealedContractRevision(record) {
  const candidates = [
    record?.contract?.revision,
    record?.contract?.contractRevision,
    record?.run?.contractRevision,
  ].filter((x) => x && typeof x === "object");

  if (!candidates.length) {
    return {
      sealed: false,
      humanReviewed: false,
      revisionId: null,
      revisionHash: null,
      reviewState: "absent",
      why:
        "This record carries no ContractRevision block, so there is no reviewed or sealed revision identity. " +
        "The contract hash below identifies bytes; it is not evidence that a human sealed anything.",
      contractHash: record?.run?.contractHash ?? null,
    };
  }
  const rev = candidates[0];
  const reviewState = String(rev.reviewState ?? (rev.sealed === true ? "sealed" : "unreviewed"));
  // SEALING AND HUMAN REVIEW ARE TWO FACTS, NOT ONE.
  //
  // A v2 ContractRevision is sealed by `sealContract`: write-once under its own
  // content-derived id, and only after all four §0 approval gates PASS carrying proofs.
  // That is a real revision identity whether or not a human has since reviewed the
  // extraction, and `reviewState: "sealed-unreviewed"` — which every real v2 run emits,
  // because the workflow seals with `reviewedAt: null` — used to be read as NOT SEALED.
  // The page then told the reader "this run was executed against an unreviewed contract,
  // identified only by its hash" about a run whose contract the Worker had sealed and
  // whose revision id it could name. That is a false statement about the run, so the two
  // facts are now reported separately: `sealed` (an immutable revision identity exists)
  // and `humanReviewed` (a person signed off on the extraction). Neither is inferred from
  // the other, and `why` carries the caveat when they differ.
  const humanReviewed = reviewState === "sealed" || reviewState === "reviewed" || rev.reviewed === true;
  const sealed = humanReviewed || reviewState === "sealed-unreviewed" || rev.sealed === true;
  return {
    sealed,
    humanReviewed,
    revisionId: rev.contractRevisionId ?? rev.revisionId ?? null,
    revisionHash: rev.contractRevisionHash ?? rev.revisionHash ?? null,
    reviewState,
    sealedAt: rev.sealedAt ?? null,
    sealedBy: rev.sealedBy ?? null,
    why: humanReviewed
      ? null
      : sealed
        ? "The contract revision is SEALED — immutable, content-addressed, and admitted only after every §0 approval gate passed with a proof — but no human has reviewed the extraction it carries. The denominator has an identity; it has not had a reviewer's eyes on it."
        : `The record carries a ContractRevision whose review state is "${reviewState}". Only a sealed or reviewed revision may name a current result.`,
    contractHash: record?.run?.contractHash ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Schema validation                                                   *
 * ------------------------------------------------------------------ */

const REQUIRED_BINDING_FIELDS = [
  "runRecordPayloadHash",
  "contractRevisionId",
  "targetBuildId",
  "evidenceManifestRoot",
  "engineVersion",
  "predicateVersion",
];

const OPTIONAL_BINDING_FIELDS = ["runId", "contractRevisionHash", "compilerVersion", "ambiguityPolicyVersion", "resultPolicyVersion"];

const VERDICT_ENUM = new Set(["pass", "fail", "inconclusive", "not-assessed"]);
const COVERAGE_ENUM = new Set([
  "exercised",
  "not-reached",
  "proven-unreachable",
  "blocked",
  "budget-exhausted",
  "time-exhausted",
  "pending",
]);
/** judge/lib/vocab.mjs OUTCOME + DISPOSITION. Closed, and mirrored here on purpose. */
const OUTCOME_ENUM = new Set(["satisfied", "violated", "insufficient", "no-observation", "error"]);
const DISPOSITION_ENUM = new Set(["defect", "query", "ambiguity", "out-of-scope", "none"]);

/* ------------------------------------------------------------------ *
 * The proof, validated in full (D11)                                  *
 * ------------------------------------------------------------------ *
 * Validation used to stop at obligation id, verdict and coverage. Everything a
 * verdict actually RESTS on — the predicate that decided it, the shape of each
 * cited witness, the per-witness attestations, whether those attestations even
 * correspond to the cited witnesses, and whether the record's own aggregate
 * `allVerified` is TRUE OF ITS OWN CONTENTS — was taken on the record's word.
 * A signed row carrying `supportingWitnesses: [{}]` and
 * `attestation: { allVerified: true }` therefore satisfied every check and
 * could become a published PASS after any producer regression. A signature over
 * a falsehood is a signature over a falsehood.
 *
 * These rules were written against what the REAL judge emits
 * (`pipeline/judge/lib/engine.mjs` judgeObligation → publicWitness + attestAll,
 * exercised end to end by `pipeline/report/make-acceptance-artifact.mjs`), NOT
 * against a hand-authored fixture. Two shapes the real producer uses and a
 * hand-made fixture got wrong are accommodated deliberately:
 *   · the attested witness carries `expected`, the public witness carries
 *     `value` — the same fact under two names, so neither is required;
 *   · the artifact digest sits BESIDE the attestation entry (`entry.sha256`),
 *     not inside its nested witness — so both placements are read.
 * Neither is a proof property, and rejecting one spelling would have been the
 * same fixture-shaped mistake in the opposite direction.
 */

const SHA256_RE = /^(?:sha256:)?[0-9a-f]{64}$/;
const normSha = (v) => (typeof v === "string" ? v.replace(/^sha256:/, "").toLowerCase() : null);

/**
 * The identity of a cited witness, independent of which projection carries it.
 *
 * `seq` is deliberately NOT part of the key. The real judge emits the same
 * witness under two projections with two different seq values: `publicWitness`
 * derives `seq: w.seq ?? w.toSeq` (so a route-edge witness reports its landing
 * capture, e.g. 4) while `attestAll` keeps the raw `seq: w.seq ?? null` (null
 * for that same route-edge witness, which is identified by fromSeq/toSeq).
 * Both are honest projections of ONE witness, so a key including seq reports a
 * bijection failure on correct output — which is exactly what a validator
 * written against a hand-made fixture would have shipped. Caught by running
 * the real judge (make-acceptance-artifact.mjs), not by reading.
 */
function witnessKey(w) {
  if (!w || typeof w !== "object") return " invalid";
  return [String(w.artifact ?? ""), String(w.locator ?? ""), String(w.session ?? "")].join(" ");
}

const multiset = (list) => {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};

const sameMultiset = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  return true;
};

/**
 * Recompute the aggregate re-verification claim from the individual
 * attestations. NEVER read `attestation.allVerified` and believe it.
 *
 * The empty collection is NOT verified: `[].every(...)` is `true`, which is how
 * a claim citing nothing at all once reported itself fully re-verified.
 *
 * @returns {{total:number, ok:number, allVerified:boolean, claimed:boolean|null, falsified:boolean}}
 */
export function recomputeWitnessAttestation(judged) {
  const att = judged?.attestation ?? null;
  const positive = Array.isArray(att?.positive) ? att.positive : [];
  const counter = Array.isArray(att?.counter) ? att.counter : [];
  const entries = [...positive, ...counter];
  const ok = entries.filter((e) => e && e.ok === true).length;
  const allVerified = entries.length > 0 && ok === entries.length;
  const claimed = att && typeof att.allVerified === "boolean" ? att.allVerified : null;
  return {
    total: entries.length,
    ok,
    allVerified,
    claimed,
    // Only an OVER-claim is a falsification. A producer that reports itself
    // unverified when its entries all passed is being conservative about its
    // own output, and a consumer never overrules that direction.
    falsified: claimed === true && allVerified === false,
  };
}

/**
 * Validate one result's proof in full. Returns problem objects; empty means the
 * proof is structurally sound. This never repairs and never coerces.
 */
/**
 * WHICH proof problems impeach the whole record, and which demote one row.
 *
 * A fabricated or incoherent PROOF — a witness pinning no bytes, an attestation
 * set that does not correspond to the cited witnesses, an aggregate
 * `allVerified` that is false of its own entries, a status word from a
 * vocabulary this contract does not contain — is a statement the SIGNER made
 * about its own contents that is not true. Nothing else in that record can be
 * taken on the strength of the same signature, so the record becomes a
 * diagnostic and drives no current result.
 *
 * An incoherent VERDICT/PREDICATE pair is different. It is exactly the case
 * AMENDMENT A designed the per-row publication gate for: "the row becomes
 * Judgment pending". Blanking the whole page tells a reader less than naming
 * the row, so this is enforced at ROW level — the row can never publish as a
 * pass, never enters a headline count, and is listed as a certification
 * blocker.
 */
const ROW_LEVEL_PROOF_CODES = new Set(["PREDICATE_IDENTITY_MISSING", "PREDICATE_OUTCOME_CONTRADICTS_VERDICT"]);

/** The subset of proof problems that impeach the producer, not just the row. */
export function recordLevelProofProblems(problems) {
  return problems.filter((p) => !ROW_LEVEL_PROOF_CODES.has(p.code));
}

export function validateResultProof(result, label = "result") {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  if (!result || typeof result !== "object") {
    bad("BAD_RESULT", `${label} is not an object.`);
    return problems;
  }

  /* --- identity: a verdict and a coverage are both REQUIRED ------------- */
  // Absent and out-of-enum are different producer faults and are named
  // differently: one stage forgot to write the field, the other wrote a word
  // from a vocabulary this report does not share.
  if (result.verdict === undefined || result.verdict === null) {
    bad("MISSING_VERDICT", `${label} carries no verdict. A result with no verdict axis cannot be placed on the page.`);
  } else if (!VERDICT_ENUM.has(result.verdict)) {
    bad("BAD_VERDICT", `${label} carries verdict ${JSON.stringify(result.verdict)}, which is outside the closed enum.`);
  }
  if (result.coverage === undefined || result.coverage === null) {
    bad("MISSING_COVERAGE", `${label} carries no coverage. Verdict and coverage are two axes and neither substitutes for the other.`);
  } else if (!COVERAGE_ENUM.has(result.coverage)) {
    bad("BAD_COVERAGE", `${label} carries coverage ${JSON.stringify(result.coverage)}, which is outside the closed enum.`);
  }
  if (result.disposition !== undefined && result.disposition !== null && !DISPOSITION_ENUM.has(result.disposition)) {
    bad("BAD_DISPOSITION", `${label} carries disposition ${JSON.stringify(result.disposition)}, which is outside the closed enum.`);
  }

  /* --- predicate identity and outcome ----------------------------------- */
  if (result.predicateOutcome !== undefined && result.predicateOutcome !== null && !OUTCOME_ENUM.has(result.predicateOutcome)) {
    bad("BAD_PREDICATE_OUTCOME", `${label} carries predicateOutcome ${JSON.stringify(result.predicateOutcome)}, which is outside the closed enum.`);
  }
  const asserting = result.verdict === "pass" || result.verdict === "fail";
  if (asserting) {
    if (typeof result.predicateId !== "string" || !result.predicateId.length) {
      bad(
        "PREDICATE_IDENTITY_MISSING",
        `${label} asserts ${result.verdict} with no named decision predicate. A verdict that cannot name the predicate that produced it is prose about evidence, not a derivation from it.`
      );
    }
    const wanted = result.verdict === "pass" ? "satisfied" : "violated";
    if (result.predicateOutcome !== wanted) {
      bad(
        "PREDICATE_OUTCOME_CONTRADICTS_VERDICT",
        `${label} is recorded ${result.verdict} while its named predicate reported ${JSON.stringify(
          result.predicateOutcome ?? null
        )}; a ${result.verdict} requires ${wanted}.`
      );
    }
  }

  /* --- witness structure ------------------------------------------------- */
  const checkWitnesses = (list, kind) => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      bad("BAD_WITNESS_COLLECTION", `${label}.${kind}Witnesses is not an array.`);
      return [];
    }
    list.forEach((w, i) => {
      const at = `${label}.${kind}Witnesses[${i}]`;
      if (!w || typeof w !== "object" || Array.isArray(w)) {
        bad("MALFORMED_WITNESS", `${at} is not a witness object.`);
        return;
      }
      if (typeof w.artifact !== "string" || !w.artifact.length) {
        bad("MALFORMED_WITNESS", `${at} names no artifact, so nothing can be re-read to check it.`);
      }
      if (typeof w.locator !== "string" || !w.locator.length) {
        bad("MALFORMED_WITNESS", `${at} carries no locator, so there is no place in the artifact to look.`);
      }
      if (typeof w.sha256 !== "string" || !SHA256_RE.test(w.sha256)) {
        bad("MALFORMED_WITNESS", `${at} carries no usable sha256 (${JSON.stringify(w.sha256 ?? null)}); an unhashed citation pins no bytes.`);
      }
    });
    return list;
  };
  const supporting = checkWitnesses(result.supportingWitnesses, "supporting");
  const counter = checkWitnesses(result.counterWitnesses, "counter");

  /* --- individual attestations and their bijection with the witnesses ---- */
  const att = result.attestation;
  if (att === undefined || att === null) {
    // Legal only for a result that cites nothing at all.
    if (supporting.length || counter.length) {
      bad("MISSING_RESULT_ATTESTATION", `${label} cites ${supporting.length + counter.length} witness(es) with no attestation block, so nothing records whether any of them re-verified.`);
    }
  } else if (typeof att !== "object" || Array.isArray(att)) {
    bad("MISSING_RESULT_ATTESTATION", `${label}.attestation is not an object.`);
  } else {
    const pos = Array.isArray(att.positive) ? att.positive : null;
    const ctr = Array.isArray(att.counter) ? att.counter : null;
    if (pos === null || ctr === null) {
      bad("MISSING_RESULT_ATTESTATION", `${label}.attestation must carry positive[] and counter[] arrays of per-witness attestations.`);
    } else {
      const pair = [
        ["positive", pos, supporting],
        ["counter", ctr, counter],
      ];
      for (const [name, entries, witnesses] of pair) {
        if (entries.length !== witnesses.length) {
          bad(
            "ATTESTATION_WITNESS_MISMATCH",
            `${label}.attestation.${name} holds ${entries.length} attestation(s) for ${witnesses.length} cited ${name} witness(es). Every cited witness must have exactly one attestation and no attestation may stand for a witness that was never cited.`
          );
          continue;
        }
        const cited = multiset(witnesses.map(witnessKey));
        const attested = multiset(entries.map((e) => witnessKey(e?.witness)));
        if (!sameMultiset(cited, attested)) {
          bad(
            "ATTESTATION_WITNESS_MISMATCH",
            `${label}.attestation.${name} does not attest the ${name} witnesses this result cites: the attested (artifact, locator, session, seq) set differs from the cited one.`
          );
        }
        entries.forEach((e, i) => {
          const at = `${label}.attestation.${name}[${i}]`;
          if (!e || typeof e !== "object") {
            bad("MALFORMED_ATTESTATION", `${at} is not an attestation object.`);
            return;
          }
          if (typeof e.ok !== "boolean") {
            bad("MALFORMED_ATTESTATION", `${at}.ok is ${JSON.stringify(e.ok ?? null)}; a re-verification outcome must be a boolean.`);
          }
          const digest = normSha(e.sha256 ?? e.witness?.sha256 ?? null);
          if (!digest) {
            // A FAILED re-verification legitimately has no digest: the point is
            // that those bytes could not be read or did not match. Only a
            // SUCCESSFUL attestation must name what it verified.
            if (e.ok === true) {
              bad("MALFORMED_ATTESTATION", `${at} reports ok with no artifact digest, so it does not say WHICH bytes re-verified.`);
            }
            return;
          }
          const w = witnesses[i];
          const wd = normSha(w?.sha256 ?? null);
          if (wd && digest !== wd) {
            bad(
              "ATTESTATION_HASH_MISMATCH",
              `${at} attests sha256 ${digest} while the cited witness names ${wd}. The attestation is of different bytes than the citation.`
            );
          }
        });
      }
      if (att.witnessCount !== undefined && att.witnessCount !== pos.length + ctr.length) {
        bad(
          "ATTESTATION_COUNT_MISMATCH",
          `${label}.attestation.witnessCount says ${JSON.stringify(att.witnessCount)} but ${pos.length + ctr.length} attestation(s) are present.`
        );
      }
      const recomputed = recomputeWitnessAttestation(result);
      if (recomputed.falsified) {
        bad(
          "ATTESTATION_AGGREGATE_FALSIFIED",
          `${label}.attestation.allVerified claims true, but recomputing it from the ${recomputed.total} individual attestation(s) gives false (${recomputed.ok} of ${recomputed.total} ok). A signed record that misreports its own re-verification is not evidence of re-verification.`
        );
      }
    }
  }

  /* --- cited evidence must actually be catalogued on the result ---------- */
  if (result.evidenceRefs !== undefined && result.evidenceRefs !== null) {
    if (!Array.isArray(result.evidenceRefs)) {
      bad("BAD_EVIDENCE_REFS", `${label}.evidenceRefs is not an array.`);
    } else {
      const named = new Set();
      result.evidenceRefs.forEach((r, i) => {
        if (!r || typeof r !== "object" || typeof r.artifact !== "string" || !r.artifact.length) {
          bad("BAD_EVIDENCE_REFS", `${label}.evidenceRefs[${i}] names no artifact.`);
          return;
        }
        named.add(r.artifact);
        if (r.sha256 !== undefined && r.sha256 !== null && (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256))) {
          bad("BAD_EVIDENCE_REFS", `${label}.evidenceRefs[${i}] (${r.artifact}) carries an unusable sha256.`);
        }
      });
      for (const w of [...supporting, ...counter]) {
        if (typeof w?.artifact === "string" && w.artifact.length && !named.has(w.artifact)) {
          bad(
            "WITNESS_ARTIFACT_UNLISTED",
            `${label} cites witness artifact ${w.artifact}, which does not appear in its own evidenceRefs. A reader following the citations would never reach it.`
          );
        }
      }
    }
  }

  return problems;
}

/**
 * Structural validation of a candidate JudgementRecord. Returns a list of
 * problem objects; an empty list means the shape is legal. This never repairs
 * and never coerces.
 */
export function validateJudgementRecordShape(candidate) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    bad("NOT_AN_OBJECT", "The supplied judgement document is not a JSON object.");
    return problems;
  }
  // A near-miss shape is far more likely to be a producer that drifted from the
  // shared contract than a hostile file, and "NOT_A_JUDGEMENT_RECORD" is a
  // useless thing to tell that producer. Name the divergence instead.
  const looksLikeVariant =
    candidate.kind === "JudgementRecord" ||
    (typeof candidate.schemaVersion === "string" && /^survey-qa[.]judgement-record\//.test(candidate.schemaVersion));

  if (candidate.kind !== JUDGEMENT_RECORD_KIND) {
    bad(
      looksLikeVariant ? "JUDGEMENT_RECORD_SHAPE_DIVERGENCE" : "NOT_A_JUDGEMENT_RECORD",
      looksLikeVariant
        ? `This document is a JudgementRecord VARIANT, not the shared contract: it declares kind ${JSON.stringify(
            candidate.kind ?? null
          )} / schemaVersion ${JSON.stringify(candidate.schemaVersion ?? null)}, and the contract (owned by worker-v2, mirrored by ` +
          `pipeline/report/lib/judgement-record.mjs) requires kind "${JUDGEMENT_RECORD_KIND}" and schemaVersion "${JUDGEMENT_RECORD_SCHEMA}". ` +
          "Two spellings of the same record is the two-implementations-that-disagree failure this contract exists to delete, so this is rejected rather than accepted by alias. The producing stage must emit the shared shape."
        : `kind is ${JSON.stringify(candidate.kind ?? null)}; a JudgementRecord must declare kind "${JUDGEMENT_RECORD_KIND}". ` +
          "A legacy derived-verdict bundle is not a JudgementRecord."
    );
  }
  // EXACT, not prefix. A schemaVersion this reader has never been taught is a
  // record this reader cannot claim to have validated.
  if (!SUPPORTED_JUDGEMENT_RECORD_SCHEMAS.includes(candidate.schemaVersion)) {
    if (!looksLikeVariant) {
      bad(
        "UNSUPPORTED_SCHEMA_VERSION",
        `schemaVersion ${JSON.stringify(candidate.schemaVersion ?? null)} is not one this reader validates. Supported: ${SUPPORTED_JUDGEMENT_RECORD_SCHEMAS.join(
          ", "
        )}. Accepting an unknown version by prefix would mean publishing a record whose meaning has not been read.`
      );
    }
  }

  // A producer that declares its own output unpublishable is obeyed, always.
  // Nothing downstream may overrule the stage that knows why it could not bind.
  if (candidate.publishable === false) {
    bad(
      "PRODUCER_DECLARED_UNPUBLISHABLE",
      `The producing stage marked this record unpublishable${
        Array.isArray(candidate.unbindableFields) && candidate.unbindableFields.length
          ? ` (unbindable: ${candidate.unbindableFields.join(", ")})`
          : ""
      }. A consumer never overrules that.`
    );
  } else if (candidate.publishable !== true) {
    // ...and a producer that never declared publishability has not cleared its
    // own record either. Silence is not consent: `buildJudgementRecord` always
    // states this, so its absence means the record did not come from a producer
    // that performed the check.
    bad(
      "PRODUCER_STATUS_ABSENT",
      `The record carries no producer publishability declaration (publishable is ${JSON.stringify(
        candidate.publishable ?? null
      )}). Only a producer that has checked its own bindings may state that its output is publishable, and a consumer may not assume it on the producer's behalf.`
    );
  }
  if (candidate.publishable === true && candidate.status !== undefined && candidate.status !== "attestable") {
    bad(
      "PRODUCER_STATUS_CONTRADICTORY",
      `The record declares publishable: true while status is ${JSON.stringify(candidate.status)}. A record cannot be simultaneously publishable and a non-final diagnostic.`
    );
  }
  if (typeof candidate.generatedAt !== "string") {
    bad("MISSING_GENERATED_AT", "generatedAt is required and must be an ISO 8601 string.");
  }

  const b = candidate.binding;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    bad("MISSING_BINDING", "binding is required: an unbound judgement cannot be attributed to a run.");
  } else {
    for (const f of REQUIRED_BINDING_FIELDS) {
      if (typeof b[f] !== "string" || !b[f].length) {
        bad("MISSING_BINDING_FIELD", `binding.${f} is required and must be a non-empty string.`);
      }
    }
    for (const f of OPTIONAL_BINDING_FIELDS) {
      if (b[f] !== undefined && typeof b[f] !== "string") {
        bad("BAD_BINDING_FIELD", `binding.${f}, when present, must be a string.`);
      }
    }
    // Version fields were checked for NON-EMPTINESS only, which let a record
    // produced by an engine this reader has never seen bind cleanly and drive
    // current results. Presence is not comprehension.
    for (const [f, allowed] of Object.entries(SUPPORTED_BINDING_VERSIONS)) {
      const v = b[f];
      if (v === undefined) continue;
      if (typeof v !== "string" || !allowed.includes(v)) {
        bad(
          "UNSUPPORTED_PRODUCER_VERSION",
          `binding.${f} is ${JSON.stringify(v ?? null)}; this reader interprets ${f} ${allowed.join(
            " / "
          )} only. A version outside that set names a vocabulary the report has not been taught to read, and rendering it would be a guess.`
        );
      }
    }
  }

  if (!Array.isArray(candidate.results)) {
    bad("MISSING_RESULTS", "results[] is required.");
  } else {
    const seen = new Set();
    // A structurally broken producer can break EVERY row. Reporting 119 x N
    // problems buries the one line a reader needs, so the proof problems are
    // capped and the overflow is counted.
    const PROOF_PROBLEM_CAP = 25;
    let proofProblems = 0;
    let proofRows = 0;
    candidate.results.forEach((r, i) => {
      if (!r || typeof r !== "object") {
        bad("BAD_RESULT", `results[${i}] is not an object.`);
        return;
      }
      if (typeof r.obligationId !== "string" || !r.obligationId.length) {
        bad("BAD_RESULT", `results[${i}].obligationId is required.`);
        return;
      }
      if (seen.has(r.obligationId)) {
        bad("DUPLICATE_RESULT", `results[] contains more than one entry for ${r.obligationId}.`);
      }
      seen.add(r.obligationId);

      // THE PROOF ITSELF (D11), not just its label.
      // Only RECORD-level proof problems impeach the record here; row-level
      // ones are enforced by the per-row publication gate (see
      // recordLevelProofProblems).
      const proof = recordLevelProofProblems(validateResultProof(r, `results[${i}] (${r.obligationId})`));
      if (!proof.length) return;
      proofRows += 1;
      for (const p of proof) {
        proofProblems += 1;
        if (proofProblems <= PROOF_PROBLEM_CAP) problems.push(p);
      }
    });
    if (proofProblems > PROOF_PROBLEM_CAP) {
      bad(
        "RESULT_PROOF_INVALID",
        `${proofProblems} proof problems across ${proofRows} result(s); the first ${PROOF_PROBLEM_CAP} are listed above. A producer this far out of contract cannot be trusted row by row.`
      );
    }
  }

  const att = candidate.attestation;
  if (!att || typeof att !== "object") {
    bad("MISSING_ATTESTATION", "attestation is required: an unsigned judgement can never be current results.");
  } else {
    if (att.algorithm !== "Ed25519") bad("BAD_ATTESTATION", `attestation.algorithm ${JSON.stringify(att.algorithm ?? null)} is not Ed25519.`);
    if (att.canonicalization !== "RFC8785") bad("BAD_ATTESTATION", `attestation.canonicalization ${JSON.stringify(att.canonicalization ?? null)} is not RFC8785.`);
    if (att.scope !== "entire-record-excluding-attestation") {
      bad("BAD_ATTESTATION", `attestation.scope ${JSON.stringify(att.scope ?? null)} is not entire-record-excluding-attestation.`);
    }
    for (const f of ["keyId", "payloadHash", "signature"]) {
      if (typeof att[f] !== "string" || !att[f].length) bad("BAD_ATTESTATION", `attestation.${f} is required.`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Binding                                                             *
 * ------------------------------------------------------------------ */

/**
 * Check every binding the cross-cutting contract requires. Each check is
 * reported individually so the page can name the one that failed instead of
 * saying "unbindable".
 */
export function checkBinding(candidate, record) {
  const checks = [];
  const b = candidate?.binding ?? {};
  const run = record?.run ?? {};
  const revision = sealedContractRevision(record);

  const add = (id, label, ok, expected, actual, detail) =>
    checks.push({ id, label, ok, expected: expected ?? null, actual: actual ?? null, detail: detail ?? null });

  let expectedPayloadHash = null;
  try {
    expectedPayloadHash = payloadHashOf(record);
  } catch (e) {
    add("run-payload-hash", "RunRecord payload hash", false, null, b.runRecordPayloadHash ?? null, `The RunRecord could not be canonicalized: ${e.message}`);
  }
  if (expectedPayloadHash !== null) {
    add(
      "run-payload-hash",
      "RunRecord payload hash",
      b.runRecordPayloadHash === expectedPayloadHash,
      expectedPayloadHash,
      b.runRecordPayloadHash ?? null,
      "The judgement must name the exact signed run payload it re-read. A mismatch means it judged a different record."
    );
  }

  if (b.runId !== undefined) {
    add("run-id", "Run ID", b.runId === (run.runId ?? null), run.runId ?? null, b.runId ?? null, null);
  }

  add(
    "target-build",
    "Target build id",
    b.targetBuildId === (run.target?.buildId ?? null),
    run.target?.buildId ?? null,
    b.targetBuildId ?? null,
    "Mixed-build results are invalid; a judgement of a different build can never be this run's current result."
  );

  add(
    "evidence-manifest",
    "Evidence-manifest root",
    b.evidenceManifestRoot === evidenceManifestRoot(record),
    evidenceManifestRoot(record),
    b.evidenceManifestRoot ?? null,
    "A hash over the signed evidence catalogue. A mismatch means the judgement read a different evidence set."
  );

  add(
    "contract-revision",
    "Sealed contract revision",
    Boolean(revision.sealed) && revision.revisionId !== null && b.contractRevisionId === revision.revisionId,
    revision.revisionId,
    b.contractRevisionId ?? null,
    revision.sealed
      ? "The judgement must name the sealed ContractRevision it judged against."
      : revision.why
  );

  if (revision.revisionHash) {
    add(
      "contract-revision-hash",
      "Sealed contract revision hash",
      b.contractRevisionHash === revision.revisionHash,
      revision.revisionHash,
      b.contractRevisionHash ?? null,
      null
    );
  }

  for (const [id, field, label] of [
    ["engine-version", "engineVersion", "Engine version"],
    ["predicate-version", "predicateVersion", "Predicate version"],
  ]) {
    add(id, label, typeof b[field] === "string" && b[field].length > 0, "a non-empty version string", b[field] ?? null, null);
  }

  return { checks, revision, allOk: checks.every((c) => c.ok) };
}

/* ------------------------------------------------------------------ *
 * The boundary                                                        *
 * ------------------------------------------------------------------ */

/**
 * Decide what a supplied judgement document may drive.
 *
 * @returns {{
 *   state: "trusted"|"diagnostic"|"absent",
 *   verdicts: object|null,     the results payload the register may project
 *   problems: Array<{code,message}>,
 *   binding: object|null,
 *   attestation: {state:string, reason:string},
 *   revision: object,
 *   legacyBundle: boolean
 * }}
 */
export function evaluateJudgement({ judgement, record, keyRegistry = null, registryPath = null }) {
  const revision = sealedContractRevision(record);
  if (!judgement) {
    return {
      state: "absent",
      verdicts: null,
      problems: [],
      binding: null,
      attestation: { state: "absent", reason: "No judgement document was supplied for this run." },
      revision,
      legacyBundle: false,
      source: null,
    };
  }

  const doc = judgement.judgementRecord ?? null;
  const legacy = judgement.verdicts ?? null;
  const problems = [];

  if (!doc) {
    problems.push({
      code: "NO_JUDGEMENT_RECORD",
      message:
        "The judging stage supplied a derived-verdict bundle, not a JudgementRecord. A bundle carries no schema identity, " +
        "no signature and no binding to this run, so nothing in it can be a current result. It is rendered below as an " +
        "operational diagnostic only.",
    });
    return {
      state: legacy ? "diagnostic" : "absent",
      verdicts: legacy,
      problems,
      binding: null,
      attestation: { state: "unsigned", reason: "A derived-verdict bundle carries no attestation block." },
      revision,
      legacyBundle: Boolean(legacy),
      source: judgement.path ?? null,
    };
  }

  problems.push(...validateJudgementRecordShape(doc).map((p) => ({ code: p.code, message: p.message })));

  // Attestation. Fail-closed: no pinned registry means UNVERIFIED, which is not
  // trusted — "we could not check" never becomes "it is fine".
  let attestation;
  if (!keyRegistry) {
    attestation = {
      state: "unavailable",
      reason: `No pinned key registry was available${registryPath ? ` (${registryPath})` : ""}, so the judgement signature was not checked.`,
    };
    problems.push({ code: "JUDGEMENT_SIGNATURE_UNCHECKED", message: attestation.reason });
  } else {
    const v = verifyAttestation(doc, keyRegistry);
    attestation = v.ok
      ? { state: "verified", reason: "Ed25519 signature verifies over the RFC 8785 canonical payload digest of this JudgementRecord." }
      : { state: "invalid", reason: v.message };
    if (!v.ok) problems.push({ code: "JUDGEMENT_SIGNATURE_INVALID", message: v.message });
  }

  const binding = checkBinding(doc, record);
  for (const c of binding.checks) {
    if (c.ok) continue;
    problems.push({
      code: "JUDGEMENT_BINDING_FAILED",
      message: `${c.label} does not bind: the judgement says ${JSON.stringify(c.actual)} and this run resolves ${JSON.stringify(
        c.expected
      )}.${c.detail ? ` ${c.detail}` : ""}`,
    });
  }

  const trusted = problems.length === 0;
  return {
    state: trusted ? "trusted" : "diagnostic",
    verdicts: doc,
    problems,
    binding,
    attestation,
    revision,
    legacyBundle: false,
    source: judgement.path ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Loading                                                             *
 * ------------------------------------------------------------------ */

function readJsonIfPresent(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Load whatever the judging stage left on disk. Accepts a directory (the judge
 * replay layout) or a single file. A `judgement-record.json` in the directory —
 * or a single file that declares itself a JudgementRecord — is the record; the
 * legacy verdicts/route-table/delta/summary files are carried alongside so the
 * report can still render them as a diagnostic.
 */
export function loadJudgementBundle(spec) {
  if (!spec) return null;
  const p = path.resolve(spec);
  if (!existsSync(p)) throw new Error(`judgement bundle ${p} does not exist`);
  const isDir = statSync(p).isDirectory();

  if (!isDir) {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed?.kind === JUDGEMENT_RECORD_KIND) {
      return { judgementRecord: parsed, verdicts: null, routeTable: parsed.routeTable ?? null, delta: null, summary: null, path: p };
    }
    return { judgementRecord: null, verdicts: parsed, routeTable: null, delta: null, summary: null, path: p };
  }

  const rec = readJsonIfPresent(path.join(p, "judgement-record.json"));
  const verdicts = readJsonIfPresent(path.join(p, "verdicts.json"));
  const routeTable = readJsonIfPresent(path.join(p, "route-table.json"));
  const delta = readJsonIfPresent(path.join(p, "delta-vs-original.json"));
  const summary = readJsonIfPresent(path.join(p, "summary.json"));
  if (!rec && !verdicts) throw new Error(`no judgement-record.json or verdicts.json found in ${p}`);
  return {
    judgementRecord: rec,
    verdicts,
    routeTable: rec?.routeTable ?? routeTable,
    delta,
    summary,
    path: p,
  };
}

/** Convenience for callers that already have a registry path. */
export function registryFor(keysPath) {
  if (!keysPath || !existsSync(keysPath)) return null;
  try {
    return loadKeyRegistry(keysPath);
  } catch {
    return null;
  }
}
