/**
 * judge/lib/judgement-record.mjs — the judge's side of the ONE artifact that
 * may drive "current" results.
 *
 * THERE IS EXACTLY ONE DEFINITION OF THIS RECORD, AND IT IS NOT THIS FILE.
 * worker-v2 owns the type (`worker-v2/src/types/judgement.ts`) and
 * `pipeline/report/lib/judgement-record.mjs` is its JavaScript mirror, which
 * the Worker itself imports. This module PRODUCES that shape and validates
 * against that module's validator, read-only. A second spelling of
 * "JudgementRecord" is the two-implementations-that-disagree failure the whole
 * contract exists to delete — and the shared validator rejects variants by
 * name, so a divergence here would be caught downstream rather than silently
 * published.
 *
 * The record is:
 *   1. SCHEMA-VALIDATED against the shared kind + schemaVersion;
 *   2. ATTESTED — Ed25519 over the SHA-256 of the RFC 8785 canonical form with
 *      `attestation` omitted, using scorer/src/lib/attest.mjs + canonical.mjs
 *      (the hardened canonicalizer, imported, never reimplemented);
 *   3. BOUND to the RunRecord payload hash, the SEALED contract revision id,
 *      the target build id, the evidence-manifest root and the engine /
 *      compiler / predicate / ambiguity-policy versions.
 *
 * Absent or unbindable ⇒ `publishable: false` and `status: 'diagnostic-only'`.
 * The consumer is required to obey that flag, and this module refuses to sign
 * such a record at all: a signature on a diagnostic is precisely the
 * "attestation rescues a bad result" move AMENDMENT A forbids.
 */

import { signRecord, verifyAttestation, payloadHashOf } from '../../../scorer/src/lib/attest.mjs';
import { jcsHash } from '../../../scorer/src/lib/canonical.mjs';
import {
  JUDGEMENT_RECORD_SCHEMA,
  JUDGEMENT_RECORD_KIND,
  validateJudgementRecordShape,
  checkBinding,
} from '../../report/lib/judgement-record.mjs';

export { JUDGEMENT_RECORD_SCHEMA, JUDGEMENT_RECORD_KIND };

/** The shared contract's required binding fields. */
const REQUIRED_BINDING = [
  'runRecordPayloadHash',
  'contractRevisionId',
  'targetBuildId',
  'evidenceManifestRoot',
  'engineVersion',
  'predicateVersion',
];

/**
 * Build the record. It is `publishable` only when every required binding field
 * is present, the contract revision is SEALED, and the evidence authority that
 * produced those values verified.
 */
export function buildJudgementRecord({
  authority, versions, generatedAt, denominator, counts, certification, results, routeTable, ambiguityIndex, source,
  // Round 3. Three facts that are NOT implied by "the authority verified", and
  // each of which used to be missing from the publication gate:
  //   D2 the evidence this record describes was constructed by the production
  //      entry point FROM THIS AUTHORITY — not injected, not another run's;
  //   D3 every obligation field the compiler read was covered by the signature;
  //   D5 so was the ambiguity set that decides which verdicts are withheld.
  // A signature over a record that fails any of them attests a derivation whose
  // inputs the signature never covered.
  evidenceBinding = null,
  contractFieldsBound = null,
  ambiguitiesSigned = null,
}) {
  const binding = {
    runRecordPayloadHash: authority ? authority.runRecordPayloadHash : null,
    contractRevisionId: authority ? authority.contractRevisionId : null,
    targetBuildId: authority ? authority.targetBuildId : null,
    evidenceManifestRoot: authority ? authority.evidenceManifestRoot : null,
    engineVersion: versions.engineVersion,
    predicateVersion: versions.predicateVersion,
    // optional, per the shared contract
    runId: authority ? authority.runId ?? undefined : undefined,
    contractRevisionHash: authority ? authority.contractRevisionHash ?? undefined : undefined,
    compilerVersion: versions.compilerVersion,
    ambiguityPolicyVersion: versions.ambiguityPolicyVersion,
    resultPolicyVersion: versions.proofVersion,
  };
  for (const k of Object.keys(binding)) if (binding[k] === undefined) delete binding[k];

  const unbindableFields = REQUIRED_BINDING.filter((k) => typeof binding[k] !== 'string' || binding[k].length === 0);
  const authorityOk = !!(authority && authority.verified);
  const sealed = !!(authority && authority.contractSealed);
  // `evidenceBinding === null` means the caller did not compute it. That is
  // itself a failure to prove the binding, so it fails closed.
  const evidenceBound = !!(evidenceBinding && evidenceBinding.bound);
  const fieldsBound = contractFieldsBound === true;
  const ambSigned = ambiguitiesSigned === true;
  const publishable = unbindableFields.length === 0 && authorityOk && sealed
    && evidenceBound && fieldsBound && ambSigned;
  if (!authorityOk) unbindableFields.push('evidenceAuthority(unverified)');
  if (!sealed) unbindableFields.push('contractRevision(not sealed)');
  if (!evidenceBound) {
    unbindableFields.push(`evidence(not identity-bound to this authority${evidenceBinding && evidenceBinding.problems.length ? `: ${evidenceBinding.problems.join('; ')}` : ''})`);
  }
  if (!fieldsBound) unbindableFields.push('compiledFields(not covered by the signature)');
  if (!ambSigned) unbindableFields.push('ambiguitySet(not covered by the signature)');

  return {
    schemaVersion: JUDGEMENT_RECORD_SCHEMA,
    kind: JUDGEMENT_RECORD_KIND,
    generatedAt,
    status: publishable ? 'attestable' : 'diagnostic-only',
    publishable,
    // Spelled out so a renderer cannot mistake a diagnostic for a result set.
    renderingConstraint: publishable
      ? 'may drive current results once the attestation verifies and binds'
      : 'NON-FINAL OPERATIONAL DIAGNOSTIC — must not be rendered as current results; historical prose verdicts stay neutral',
    unbindableFields: publishable ? [] : unbindableFields,
    binding,
    source,
    denominator,
    counts,
    certification,
    results,
    routeTable,
    ambiguityIndex,
  };
}

/**
 * Validate against the SHARED validator. Before signing, the attestation block
 * is legitimately absent, so that one problem is filtered out — every other
 * problem the shared contract reports is honoured verbatim.
 */
export function validateJudgementRecord(rec, { unsigned = false } = {}) {
  const problems = validateJudgementRecordShape(rec)
    .filter((p) => !(unsigned && p.code === 'MISSING_ATTESTATION'));
  return { ok: problems.length === 0, errors: problems.map((p) => `${p.code}: ${p.message}`), problems };
}

/**
 * Attest the record. A record that is not publishable is NEVER signed.
 */
export function attestJudgementRecord(rec, { privateKeyPem, keyId, signedAt }) {
  if (!rec.publishable) {
    return { ok: false, code: 'NOT_BINDABLE', errors: [`unbindable: ${(rec.unbindableFields || []).join(', ') || 'authority unverified'}`], record: rec };
  }
  const draft = validateJudgementRecord(rec, { unsigned: true });
  if (!draft.ok) return { ok: false, code: 'SCHEMA_INVALID', errors: draft.errors, record: rec };

  const attestation = signRecord(rec, privateKeyPem, keyId, signedAt);
  const signed = { ...rec, attestation };
  const final = validateJudgementRecord(signed);
  if (!final.ok) return { ok: false, code: 'SCHEMA_INVALID', errors: final.errors, record: signed };
  return { ok: true, record: signed };
}

/**
 * Verify a JudgementRecord end to end: shared schema, signature, and — when the
 * RunRecord is supplied — every binding the shared contract requires, using the
 * shared `checkBinding` rather than a local re-derivation.
 */
export function verifyJudgementRecord(rec, keyRegistry, { runRecord = null, expect = {} } = {}) {
  const v = validateJudgementRecord(rec);
  if (!v.ok) return { ok: false, code: 'SCHEMA_INVALID', errors: v.errors };
  const sig = verifyAttestation(rec, keyRegistry);
  if (!sig.ok) return { ok: false, code: sig.code, errors: [sig.message] };

  const errors = [];
  for (const [k, want] of Object.entries(expect)) {
    if (rec.binding[k] !== want) errors.push(`binding.${k} is ${rec.binding[k]}, expected ${want}`);
  }
  let bindingChecks = null;
  if (runRecord) {
    bindingChecks = checkBinding(rec, runRecord);
    for (const c of bindingChecks.checks) {
      if (!c.ok) errors.push(`${c.label}: judgement says ${JSON.stringify(c.actual)}, the run resolves ${JSON.stringify(c.expected)}`);
    }
  }
  if (errors.length) return { ok: false, code: 'BINDING_MISMATCH', errors, bindingChecks };
  return { ok: true, payloadHash: payloadHashOf(rec), contentHash: jcsHash(rec), bindingChecks };
}
