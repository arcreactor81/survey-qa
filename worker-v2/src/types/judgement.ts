/**
 * THE JUDGEMENT RECORD — the only document that may drive "current" results.
 *
 * The v2 pipeline's whole reason for existing is that the first run had one stage which
 * could see the document AND the evidence at once and wrote prose verdicts from both.
 * It wrote MATCHES_DOCUMENT while citing the artifact that disproved it, three times.
 * v2 deletes that stage: compilation is evidence-blind, predicates are document-blind,
 * and a verdict is a value in a closed enum derived from re-read artifacts.
 *
 * That is worthless if the OUTPUT of the derived-verdict engine is a plain JSON file the
 * report picks up by filename. Anyone able to drop a file — or to copy one run's bundle
 * over another run's — could publish green "re-derived" results, and removing the bundle
 * would silently revert the report to the very prose verdicts v2 exists to distrust.
 * So the derived verdicts travel as a RECORD that is:
 *
 *   1. SCHEMA-VALIDATED against a versioned kind (a legacy `verdicts.json` bundle is not
 *      a JudgementRecord and can never be mistaken for one);
 *   2. ATTESTED — Ed25519 over the sha-256 of the RFC 8785 canonical form of the record
 *      with `attestation` omitted, the identical algebra `scorer/src/lib/attest.mjs`
 *      applies to a RunRecord;
 *   3. BOUND to the run it judged: the RunRecord payload hash, the sealed contract
 *      revision id, the target build id, the evidence-manifest root, and the engine /
 *      compiler / predicate / ambiguity-policy versions that produced it.
 *
 * Absent, unvalidated, unattested or unbindable ⇒ the report may render it ONLY as a
 * clearly non-final operational diagnostic. It may never become current results, never
 * take pass styling, and never enter a headline count. Historical agent-authored prose
 * verdicts stay NEUTRAL — never publishable as current — in that state too.
 *
 * SHAPE PARITY IS DELIBERATE AND LOAD-BEARING. `pipeline/report/lib/judgement-record.mjs`
 * is the report side of this same contract, and these declarations mirror it field for
 * field. The Worker imports that module's validator and its `evidenceManifestRoot`
 * definition rather than re-deriving either (see store/judgement.ts) — a second
 * definition of "what a JudgementRecord is" is exactly the two-implementations-that-can-
 * disagree failure this project keeps deleting.
 */

/** Closed enum. A verdict outside it is a schema violation, not an unknown value. */
export type JudgementVerdict = "pass" | "fail" | "inconclusive" | "not-assessed";

export type JudgementCoverage =
  | "exercised"
  | "not-reached"
  | "proven-unreachable"
  | "blocked"
  | "budget-exhausted"
  | "time-exhausted"
  | "pending";

export interface JudgementResult {
  obligationId: string;
  verdict?: JudgementVerdict | null;
  coverage?: JudgementCoverage | null;
  /** Machine-readable derivation reason (POSITIVE_WITNESS, AMBIGUITY_PRECEDENCE, ...). */
  reason?: string | null;
  /** Artifact ids the predicate actually re-read. Never prose. */
  evidenceIds?: string[];
  [k: string]: unknown;
}

/**
 * Everything that makes this judgement THIS run's judgement.
 *
 * `runId` is optional in the shared schema and REQUIRED at the Worker boundary: a
 * judgement stored under a run's key must name that run, or an operator with write
 * access to one run's bundle could relabel another run's results by copying the object.
 * Requiring more than the shared schema is a strengthening, not a divergence — a record
 * the Worker accepts is always a record the shared validator accepts.
 */
export interface JudgementBinding {
  /** sha256:<hex> over the RFC 8785 canonical RunRecord with `attestation` omitted. */
  runRecordPayloadHash: string;
  contractRevisionId: string;
  /** Mixed-build results are invalid (merged-contract §0), so this is never optional. */
  targetBuildId: string;
  /** sha256:<hex> over the run's signed evidence catalogue. See store/judgement.ts. */
  evidenceManifestRoot: string;
  engineVersion: string;
  predicateVersion: string;
  runId?: string;
  /**
   * THESE THREE ARE MANDATORY AT THE WORKER BOUNDARY, NOT OPTIONAL.
   *
   * The shared schema lists them as optional, which was a hole in three directions:
   *
   *  - `contractRevisionHash` is the THIRD place a run's denominator identity is written
   *    down (the checkpoint and the RunRecord are the other two). Leaving it out meant a
   *    judgement could name the right revision ID beside altered revision BYTES and bind
   *    cleanly — the D4 shape, one layer up.
   *  - `compilerVersion` decides how a requirement became a predicate, and
   *    `ambiguityPolicyVersion` decides which verdicts were WITHHELD. A judgement that
   *    does not say which ambiguity policy suppressed a row is not reproducible: rerun it
   *    under a different policy and you get different withholding with the same binding.
   *
   * Requiring more than the shared validator is a strengthening, not a divergence: every
   * record the Worker accepts is still a record the shared validator accepts.
   */
  contractRevisionHash: string;
  compilerVersion: string;
  ambiguityPolicyVersion: string;
  resultPolicyVersion?: string;
}

/** Same block shape, algorithm and scope as the harness attestation on a RunRecord. */
export interface JudgementAttestation {
  algorithm: "Ed25519";
  canonicalization: "RFC8785";
  scope: "entire-record-excluding-attestation";
  keyId: string;
  signedAt: string;
  /** sha256:<hex> of the canonical record minus this block. */
  payloadHash: string;
  /** base64url, 64 bytes decoded. */
  signature: string;
}

export const JUDGEMENT_RECORD_KIND = "judgement-record" as const;
export const JUDGEMENT_RECORD_SCHEMA_PREFIX = "survey-qa-judgement-record/" as const;
export const JUDGEMENT_RECORD_SCHEMA = "survey-qa-judgement-record/1.0.0" as const;

export interface JudgementRecord {
  schemaVersion: string;
  kind: typeof JUDGEMENT_RECORD_KIND;
  generatedAt: string;
  binding: JudgementBinding;
  results: JudgementResult[];
  attestation: JudgementAttestation;
  /** Optional derived sidecars carried inside the signed record, never beside it. */
  routeTable?: unknown;
  counts?: unknown;
  certification?: unknown;
  ambiguityIndex?: unknown;
  summary?: unknown;
  [k: string]: unknown;
}

export interface JudgementProblem {
  code: string;
  message: string;
}

export interface BindingCheck {
  id: string;
  label: string;
  ok: boolean;
  expected: string | null;
  actual: string | null;
  detail: string | null;
}

export type JudgementAttestationState = "verified" | "invalid" | "unavailable" | "unsigned" | "absent";

/**
 * The tri-state the report consumes. There is no fourth value and no boolean: "we could
 * not check" must never collapse into either "fine" or "tampered".
 *
 *   absent    — no judgement document exists for this run.
 *   unusable  — one exists but is not schema-valid, not attested, or not bound to this
 *               run. It may be shown as a NON-FINAL OPERATIONAL DIAGNOSTIC only.
 *   attested  — schema-valid, signature verifies against a pinned key, every binding
 *               resolves against this run's durable state. Only this may be current.
 */
export interface JudgementLoad {
  state: "absent" | "unusable" | "attested";
  record: JudgementRecord | null;
  attestation: { state: JudgementAttestationState; reason: string };
  problems: JudgementProblem[];
  bindingChecks: BindingCheck[];
  /** Short line for logs, the checkpoint and the `x-judgement-state` response header. */
  summary: string;
}
