/**
 * judge/lib/authority.mjs — D1. THE SIGNED EVIDENCE AUTHORITY.
 *
 * Before this module existed the judge learned an artifact's hash FROM THE
 * ARTIFACT during its first read, so `attest()` could only detect a change
 * BETWEEN its own two reads. Replacing `EXP-049.json` before the judge ran was
 * undetectable: the substituted file supplied its own expected hash, every
 * witness re-verified against it, and the run still reported `allVerified`.
 *
 * The fix is that the judge no longer trusts the filesystem at all. The
 * authority for "which artifacts exist and what is in them" is the Ed25519
 * attested RunRecord:
 *
 *   1. the RunRecord's harness attestation is verified with the SHARED
 *      implementation (scorer/src/lib/attest.mjs + canonical.mjs — imported
 *      read-only, never reimplemented here);
 *   2. `record.contract` is hashed with the same RFC 8785 canonicalizer and
 *      must equal `record.run.contractHash` — the ContractRevision is thereby
 *      pinned INSIDE the signature;
 *   3. the local checklist is checked against that signed ContractRevision
 *      item-by-item (id set, requirement text, source quote). A checklist that
 *      does not reproduce the signed contract cannot drive a judgement;
 *   4. `record.evidence[]` becomes an EXACT allowlist: name -> contentHash +
 *      byteLength. Missing, extra, duplicate and mismatched artifacts are all
 *      hard findings — not warnings;
 *   5. every subsequent read is checked against that signed hash, so a
 *      substituted artifact fails on FIRST contact rather than agreeing with
 *      itself.
 *
 * Absent or unbindable authority does not silently degrade: `verified` stays
 * false, the run is diagnostic-only, and no JudgementRecord may be minted.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';

import { verifyAttestation, resolveKeyRegistry, payloadHashOf } from '../../../scorer/src/lib/attest.mjs';
import { jcsHash } from '../../../scorer/src/lib/canonical.mjs';
// The evidence-manifest root and the sealed-revision rule are part of the
// CROSS-CUTTING contract, so they are imported from its shared module rather
// than re-derived here. Two definitions of "which evidence set was judged"
// would defeat the binding they exist to provide.
import { evidenceManifestRoot, sealedContractRevision } from '../../report/lib/judgement-record.mjs';
import { bindAmbiguities } from './contract-binding.mjs';
// D1. THE v2 PROJECTION IS SHARED WITH THE WORKER, NOT REDEFINED HERE.
//
// Until this import the judge could only read the LEGACY harness record: nested
// `run.runId` / `run.contractHash` / `run.target`, an EMBEDDED `contract.items[]`
// and evidence entries carrying `artifactRef` + `byteLength`. A genuine
// RunRecordV2 has a top-level `runId`, `run.targetBuildId`,
// `run.documentSha256`, a REFERENCED sealed ContractRevision, and evidence
// entries with bare-hex `contentHash` + `size`. Every binding therefore failed
// on a correct v2 record — a real run could not mint a trusted judgement at all
// — and the only artifact that traversed the whole path was a hand-authored
// hybrid carrying both spellings at once. That is why every "acceptance" suite
// was green while acceptance was in fact impossible.
//
// `worker-v2/shared/v2-record.mjs` is pure ESM (no node/Worker-specific
// imports) and is the SAME module `worker-v2/src/report/renderable.ts`
// projects with. One mapping, two consumers.
import {
  contractApprovalFailures,
  contractHashFromDigest,
  contractRevisionIdFromDigest,
  isRunRecordV2,
  projectV2ToLegacy,
  semanticContractBody,
} from '../../../worker-v2/shared/v2-record.mjs';

export const AUTHORITY_VERSION = '2.0.0';

const sha256Of = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/* ------------------------------------------------------------------ *
 * N2 — THE AUTHORITY NAMES THE EVIDENCE SOURCE IT VERIFIED            *
 * ------------------------------------------------------------------ *
 *
 * Everything below this module verified — the manifest, every artifact hash,
 * the byte lengths — was verified against ONE directory on disk. Nothing
 * recorded WHICH directory, so the verified authority was a free-floating
 * token: `judgeRun({ runDir: B, authority: authorityOf(A) })` read run B's
 * artifacts, silently dropped the ones whose bytes disagreed with run A's
 * signed hashes, and minted a signed record bound to run A with two of A's four
 * genuine fails downgraded to inconclusive.
 *
 * An authority therefore carries the evidence source it describes, and the
 * engine refuses to judge any other one. The identity is the CANONICAL
 * (symlink- and case-resolved) artifacts directory, so two spellings of the
 * same directory bind and two directories never do.
 */

/** Canonical, comparable form of a directory path. */
export function canonicalDir(p) {
  const abs = resolve(String(p ?? ''));
  try {
    return realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    return abs; // a path that does not exist is compared by its resolved form
  }
}

/** The evidence source an authority describes / a judgement is asked to read. */
export function evidenceSourceOf(runDir, artifactsSubdir = 'artifacts') {
  return Object.freeze({
    runDir: canonicalDir(runDir),
    artifactsDir: canonicalDir(join(String(runDir ?? ''), artifactsSubdir)),
    artifactsSubdir,
  });
}

/**
 * Does `authority` describe the evidence source at `runDir`?
 *
 * An UNVERIFIED authority binds nothing at all (the run is already
 * diagnostic-only), so it is reported as `ok:true, checked:false`. A VERIFIED
 * authority that names no source fails closed: it cannot prove it describes
 * this directory, and "cannot prove" is a refusal, not a warning.
 *
 * @returns {{ok:boolean, checked:boolean, why:string|null, expected:object|null, actual:object}}
 */
export function checkEvidenceSource(authority, runDir, { artifactsSubdir = 'artifacts' } = {}) {
  const actual = evidenceSourceOf(runDir, artifactsSubdir);
  if (!authority || authority.verified !== true) {
    return { ok: true, checked: false, why: null, expected: authority ? authority.evidenceSource || null : null, actual };
  }
  const expected = authority.evidenceSource || null;
  if (!expected) {
    return {
      ok: false,
      checked: true,
      why: 'the verified authority does not name the evidence source it was verified against, so it cannot be shown to describe this run directory',
      expected: null,
      actual,
    };
  }
  if (expected.artifactsDir !== actual.artifactsDir || expected.runDir !== actual.runDir) {
    return {
      ok: false,
      checked: true,
      why: `this authority was verified against ${expected.runDir} (artifacts ${expected.artifactsDir}); it is being asked to judge ${actual.runDir} (artifacts ${actual.artifactsDir})`,
      expected,
      actual,
    };
  }
  return { ok: true, checked: true, why: null, expected, actual };
}

/**
 * @typedef {object} EvidenceAuthority
 * @property {boolean} verified            record signature + contract binding + manifest all clean
 * @property {string|null} runId
 * @property {string|null} runRecordPayloadHash
 * @property {string|null} contractRevisionId
 * @property {string|null} contractHash
 * @property {string|null} targetBuildId
 * @property {string|null} targetBuildHash
 * @property {string|null} evidenceManifestRoot
 * @property {Map<string,{contentHash:string,byteLength:number,evidenceId:string,type:string}>} manifest
 * @property {Array<{code:string,detail:string,artifact?:string}>} findings
 */

/** An unverified authority. Everything downstream fails closed against it. */
export function nullAuthority(reasonCode, detail) {
  return {
    version: AUTHORITY_VERSION,
    verified: false,
    signatureVerified: false,
    contractBound: false,
    contractSealed: false,
    contractReviewState: 'absent',
    manifestComplete: false,
    checklistBound: false,
    runId: null,
    runRecordPayloadHash: null,
    contractRevisionId: null,
    contractRevisionHash: null,
    contractHash: null,
    targetBuildId: null,
    targetBuildHash: null,
    documentHash: null,
    evidenceManifestRoot: null,
    manifest: new Map(),
    // N2: an unverified authority describes no evidence source, and nothing may
    // be judged against it that could publish.
    evidenceSource: null,
    findings: [{ code: reasonCode, detail }],
    ambiguitiesSigned: false,
    ambiguityBinding: { signed: false, perAmbiguity: new Map(), findings: [], detail: { localAmbiguities: null, signedTokens: 0 } },
    contractItems: new Map(),
    contractAssumptions: null,
  };
}

/** Re-exported so callers do not grow a second definition of the root. */
export { evidenceManifestRoot };

/**
 * Load and verify the run's signed authority.
 *
 * @param {object} o
 * @param {string} o.runDir
 * @param {object} o.checklist          the local checklist that will be compiled
 * @param {string} [o.runRecordPath]    defaults to <runDir>/run-record.json
 * @param {string} [o.keyRegistryPath]  pinned Ed25519 public-key registry
 * @param {boolean} [o.allowFixtureKeys] explicit opt-in to a registry that
 *        declares `"testOnly": true`. The fixture registry's private half is
 *        published, so it is refused as a trust anchor without this (or
 *        SURVEY_QA_ALLOW_FIXTURE_KEYS=1). There is deliberately no default
 *        registry path: absent one, the run stays diagnostic-only.
 * @param {string} [o.artifactsSubdir]
 * @param {string} [o.contractRevisionPath] the sealed v2 ContractRevision this
 *        record REFERENCES. v2 runs do not embed their denominator (§0), so it
 *        has to be resolvable; defaults to <runDir>/contract-revision.json and
 *        then <runDir>/contracts/<contractRevisionId>.json — the filesystem
 *        analogue of the Worker's `v2/contracts/<id>.json`.
 * @returns {EvidenceAuthority}
 */
export function loadEvidenceAuthority({
  runDir,
  checklist,
  runRecordPath,
  keyRegistryPath,
  allowFixtureKeys = false,
  artifactsSubdir = 'artifacts',
  contractRevisionPath = null,
}) {
  const recPath = runRecordPath || join(runDir, 'run-record.json');
  if (!existsSync(recPath)) {
    return nullAuthority('RUN_RECORD_MISSING', `no signed RunRecord at ${recPath}`);
  }
  if (!keyRegistryPath || !existsSync(keyRegistryPath)) {
    return nullAuthority('KEY_REGISTRY_MISSING',
      'no pinned Ed25519 key registry supplied; a RunRecord cannot be authenticated without one');
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recPath, 'utf8'));
  } catch (e) {
    return nullAuthority('RUN_RECORD_UNPARSEABLE', `${recPath}: ${e.message}`);
  }

  // A TEST key is never a trust anchor by accident. The fixture registry ships
  // its own private half, so pointing at it must be a deliberate, named act.
  const anchor = resolveKeyRegistry({ keysPath: keyRegistryPath, allowFixtureKeys });
  if (!anchor.ok) {
    return nullAuthority(anchor.code, anchor.message);
  }
  const registry = anchor.registry;

  // --- 1. Ed25519 over the RFC 8785 canonical form (shared implementation) --
  const sig = verifyAttestation(record, registry);
  if (!sig.ok) {
    return nullAuthority('RUN_RECORD_ATTESTATION_INVALID', sig.message);
  }
  const payloadHash = payloadHashOf(record);

  const findings = [];

  // --- 2. the ContractRevision the judgement will be bound to ---------------
  //
  // TWO RECORD SHAPES, ONE RULE: the contract a record names must be the
  // contract those bytes hash to. Where they DIFFER is only where the bytes
  // live — v1 embeds the contract inside the signature, v2 references a sealed
  // revision by an id that IS its own digest — so each shape is bound the way
  // its own integrity guarantee is expressed, and both end at the same
  // legacy-shaped `view` that every check below reads.
  let contractBound = false;
  /** The legacy-shaped view. For v1 that is the record itself. */
  let view = record;
  if (isRunRecordV2(record)) {
    const v2 = bindV2Contract({ runDir, record, contractRevisionPath, findings });
    contractBound = v2.contractBound;
    // A v2 record whose revision cannot be resolved or does not re-derive has NO
    // denominator, so it gets an empty view: every downstream check fails closed
    // rather than falling back to something the record supplied about itself.
    view = v2.view || { run: {}, contract: null, evidence: [] };
  } else if (!record.contract || typeof record.contract !== 'object') {
    findings.push({ code: 'CONTRACT_REVISION_MISSING', detail: 'the signed record carries no contract block' });
  } else {
    const recomputed = jcsHash(record.contract);
    if (recomputed !== (record.run || {}).contractHash) {
      findings.push({
        code: 'CONTRACT_HASH_MISMATCH',
        detail: `run.contractHash ${(record.run || {}).contractHash} but the signed contract canonicalizes to ${recomputed}`,
      });
    } else {
      contractBound = true;
    }
  }
  const run = view.run || {};
  // A content hash identifies BYTES. The identity a judgement must bind to is
  // the SEALED ContractRevision — the reviewed thing — and the shared contract
  // module owns that rule.
  const revision = sealedContractRevision(view);
  if (!revision.sealed) {
    findings.push({ code: 'CONTRACT_REVISION_UNSEALED', detail: revision.why || 'no sealed ContractRevision on this record' });
  }

  // --- 3. the local checklist must reproduce the signed ContractRevision ----
  const checklistCheck = bindChecklist(checklist, view.contract);
  for (const f of checklistCheck.findings) findings.push(f);

  // --- 4. the signed evidence catalogue as an EXACT allowlist ---------------
  const manifest = new Map();
  const seen = new Set();
  for (const e of view.evidence || []) {
    const name = basename(String(e.artifactRef || ''));
    if (!name) {
      findings.push({ code: 'MANIFEST_ENTRY_MALFORMED', detail: `evidence ${e.evidenceId} has no artifactRef` });
      continue;
    }
    if (seen.has(name)) {
      findings.push({ code: 'MANIFEST_DUPLICATE_ARTIFACT', artifact: name, detail: `${name} appears more than once in the signed catalogue` });
      continue;
    }
    seen.add(name);
    if (typeof e.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.contentHash)) {
      findings.push({ code: 'MANIFEST_ENTRY_MALFORMED', artifact: name, detail: `${name} has no usable contentHash` });
      continue;
    }
    manifest.set(name, {
      contentHash: e.contentHash,
      byteLength: Number.isFinite(e.byteLength) ? e.byteLength : null,
      evidenceId: e.evidenceId || null,
      type: e.type || null,
    });
  }

  const artifactsDir = join(runDir, artifactsSubdir);
  const onDisk = existsSync(artifactsDir)
    ? readdirSync(artifactsDir).filter((f) => statSync(join(artifactsDir, f)).isFile())
    : [];
  for (const f of onDisk) {
    if (!manifest.has(f)) {
      findings.push({ code: 'ARTIFACT_NOT_IN_SIGNED_MANIFEST', artifact: f, detail: `${f} is present on disk but absent from the signed catalogue` });
    }
  }
  for (const [name, entry] of manifest.entries()) {
    if (!onDisk.includes(name)) {
      findings.push({ code: 'CITED_ARTIFACT_MISSING', artifact: name, detail: `${name} is in the signed catalogue but missing on disk` });
      continue;
    }
    // Verify the WHOLE allowlist up front. Checking lazily, at first citation,
    // means a substituted artifact that no predicate happens to cite never gets
    // noticed — and the run still reports a verified authority.
    const buf = readFileSync(join(artifactsDir, name));
    const digest = sha256Of(buf);
    if (digest !== entry.contentHash) {
      findings.push({ code: 'ARTIFACT_HASH_MISMATCH', artifact: name, detail: `${name} is sha256 ${digest} on disk, ${entry.contentHash} in the signed catalogue` });
    } else if (entry.byteLength !== null && entry.byteLength !== buf.length) {
      findings.push({ code: 'ARTIFACT_HASH_MISMATCH', artifact: name, detail: `${name} is ${buf.length} bytes on disk, ${entry.byteLength} in the signed catalogue` });
    }
  }

  const manifestComplete = !findings.some((f) => [
    'ARTIFACT_NOT_IN_SIGNED_MANIFEST', 'CITED_ARTIFACT_MISSING',
    'MANIFEST_DUPLICATE_ARTIFACT', 'MANIFEST_ENTRY_MALFORMED', 'ARTIFACT_HASH_MISMATCH',
  ].includes(f.code));

  // D5 (round 3) — ambiguity signing is a CHECKED FACT, not a constant.
  //
  // This used to be `const ambiguitiesSigned = false;` with an unconditional
  // finding. Two things followed from the constant that should not have: the
  // `contractReviewed` certification facet reads it, so certification was
  // unreachable by construction; and because nothing else consumed it, an
  // unsigned ambiguity set still decided which verdicts were withheld and which
  // were released. The carrier and the digest rule live in
  // `contract-binding.mjs` (the judge side), so this loader keeps doing exactly
  // one job: reporting what the signature covers.
  const ambBinding = bindAmbiguities(checklist, {
    verified: true,
    contractAssumptions: Array.isArray(view.contract && view.contract.assumptions)
      ? view.contract.assumptions : null,
  });
  const ambiguitiesSigned = ambBinding.signed;
  for (const f of ambBinding.findings) findings.push(f);

  const verified = contractBound && manifestComplete && checklistCheck.bound;

  return {
    version: AUTHORITY_VERSION,
    verified,
    signatureVerified: true,
    contractBound,
    contractSealed: !!revision.sealed,
    contractReviewState: revision.reviewState,
    manifestComplete,
    checklistBound: checklistCheck.bound,
    runId: run.runId || null,
    runRecordPayloadHash: payloadHash,
    contractRevisionId: revision.revisionId,
    contractRevisionHash: revision.revisionHash,
    contractHash: run.contractHash || null,
    targetBuildId: run.target ? run.target.buildId || null : null,
    targetBuildHash: run.target ? run.target.buildHash || null : null,
    documentHash: run.documentHash || null,
    // The SHARED definition, so the judge and the report cannot disagree about
    // which evidence set a judgement was derived from.
    evidenceManifestRoot: evidenceManifestRoot(record),
    // N2: WHICH directory every hash above was checked against. The engine
    // refuses to derive verdicts from any other one.
    evidenceSource: evidenceSourceOf(runDir, artifactsSubdir),
    manifest,
    findings,
    ambiguitiesSigned,
    ambiguityBinding: ambBinding,
    contractItems: checklistCheck.items,
    // D3: the compiler is fed a projection of these signed items and nothing
    // else, so the judge never needs the unsigned checklist for a field a rule
    // reads. See contract-binding.mjs.
    contractAssumptions: Array.isArray(view.contract && view.contract.assumptions)
      ? view.contract.assumptions : null,
    /** Which record shape produced this authority. Diagnostic, never a gate. */
    recordShape: isRunRecordV2(record) ? 'run-record/2' : 'run-record/1',
  };
}

/* ------------------------------------------------------------------ *
 * v2: the referenced sealed ContractRevision                          *
 * ------------------------------------------------------------------ */

/**
 * Resolve, RE-DERIVE and bind the sealed ContractRevision a RunRecordV2 names.
 *
 * A v2 record carries `contract: { contractRevisionId, contractHash }` and
 * nothing else: §0 forbids a run from carrying its own denominator, so the
 * requirement rows live in a separately sealed, content-addressed revision. The
 * integrity guarantee is therefore NOT "it is inside the signature" but "the id
 * IS the sha-256 of the semantic body", and it only holds if somebody
 * recomputes it. Nobody did — the Worker's reader checked the id's SHAPE and
 * the object's `kind` and returned it (D4) — so this recomputes it here as
 * well, on the same shared definition the Worker seals with.
 *
 * `sealedAt`, `extraction.reviewedAt` and gate-proof `observedAt` are excluded
 * from identity (see shared/v2-record.mjs#semanticContractBody), so two runs of
 * the same unchanged document resolve the SAME revision.
 */
function bindV2Contract({ runDir, record, contractRevisionPath, findings }) {
  const named = record.contract || {};
  const namedId = typeof named.contractRevisionId === 'string' ? named.contractRevisionId : null;
  const namedHash = typeof named.contractHash === 'string' ? named.contractHash : null;
  if (!namedId || !namedHash) {
    findings.push({
      code: 'CONTRACT_REVISION_MISSING',
      detail: 'this RunRecordV2 names no contractRevisionId/contractHash, so it references no sealed denominator',
    });
    return { contractBound: false, view: null };
  }

  const candidates = [
    contractRevisionPath ? resolve(contractRevisionPath) : null,
    join(runDir, 'contract-revision.json'),
    join(runDir, 'contracts', `${namedId}.json`),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p)) || null;
  if (!found) {
    findings.push({
      code: 'CONTRACT_REVISION_MISSING',
      detail: `the record references sealed contract revision ${namedId}, and none of [${candidates.join(', ')}] exists`,
    });
    return { contractBound: false, view: null };
  }

  let revisionDoc;
  try {
    revisionDoc = JSON.parse(readFileSync(found, 'utf8'));
  } catch (e) {
    findings.push({ code: 'CONTRACT_REVISION_UNPARSEABLE', detail: `${found}: ${e.message}` });
    return { contractBound: false, view: null };
  }

  let digest;
  try {
    digest = String(jcsHash(semanticContractBody(revisionDoc))).replace(/^sha256:/, '');
  } catch (e) {
    findings.push({ code: 'CONTRACT_REVISION_UNPARSEABLE', detail: `${found} cannot be canonicalized: ${e.message}` });
    return { contractBound: false, view: null };
  }
  const recomputedId = contractRevisionIdFromDigest(digest);
  const recomputedHash = contractHashFromDigest(digest);

  let ok = true;
  if (recomputedId !== namedId) {
    findings.push({
      code: 'CONTRACT_REVISION_TAMPERED',
      detail: `the record names revision ${namedId}; the bytes at ${found} canonicalize to ${recomputedId}. ` +
        'A revision id IS the digest of its semantic body, so these are not the contract this run was executed against.',
    });
    ok = false;
  }
  if (revisionDoc.contractRevisionId !== namedId) {
    findings.push({
      code: 'CONTRACT_REVISION_TAMPERED',
      detail: `the stored revision names itself ${JSON.stringify(revisionDoc.contractRevisionId ?? null)}, not ${namedId}`,
    });
    ok = false;
  }
  if (recomputedHash !== namedHash) {
    findings.push({
      code: 'CONTRACT_HASH_MISMATCH',
      detail: `record.contract.contractHash ${namedHash} but the sealed revision canonicalizes to ${recomputedHash}`,
    });
    ok = false;
  }
  // A revision whose §0 approval gates do not pass could never have been sealed;
  // if it is on disk in that state it did not come from the sealer. `not-evaluated`
  // is not a passing gate and a `pass` with no proof is a fabricated one.
  const gateFailures = contractApprovalFailures(revisionDoc);
  if (gateFailures.length) {
    findings.push({
      code: 'CONTRACT_REVISION_UNSEALED',
      detail: `the referenced revision's §0 approval gates do not pass [${gateFailures.join(', ')}], so it was never sealable`,
    });
    ok = false;
  }
  if (!ok) return { contractBound: false, view: null };

  let view;
  try {
    view = projectV2ToLegacy(record, revisionDoc);
  } catch (e) {
    findings.push({ code: 'CONTRACT_REVISION_TAMPERED', detail: `the v2 projection refused this pair: ${e.message}` });
    return { contractBound: false, view: null };
  }
  return { contractBound: true, view };
}

/** Every obligation compiled must be an item of the signed ContractRevision. */
function bindChecklist(checklist, contract) {
  const findings = [];
  const items = new Map();
  if (!contract || !Array.isArray(contract.items)) {
    return { bound: false, items, findings: [{ code: 'CONTRACT_REVISION_MISSING', detail: 'signed contract has no items[]' }] };
  }
  for (const it of contract.items) {
    if (items.has(it.itemId)) {
      findings.push({ code: 'CONTRACT_DUPLICATE_ITEM', detail: `${it.itemId} appears twice in the signed contract` });
      continue;
    }
    items.set(it.itemId, it);
  }
  const oblIds = new Set();
  for (const o of checklist.obligations || []) {
    if (oblIds.has(o.id)) {
      findings.push({ code: 'CHECKLIST_DUPLICATE_OBLIGATION', detail: `${o.id} appears twice in the checklist` });
    }
    oblIds.add(o.id);
    const it = items.get(o.id);
    if (!it) {
      findings.push({ code: 'OBLIGATION_NOT_IN_SIGNED_CONTRACT', detail: `${o.id} is not an item of the signed ContractRevision` });
      continue;
    }
    if (String(it.requirement) !== String(o.statement)) {
      findings.push({ code: 'OBLIGATION_TEXT_DRIFT', detail: `${o.id} statement differs from the signed contract requirement` });
    }
    // THE SOURCE ANCHOR, BOUND BY DIGEST WHERE THE REVISION CARRIES ONE.
    //
    // A legacy contract item holds the verbatim source quote and is compared
    // character for character. A sealed v2 ScopedRequirement deliberately does
    // NOT carry source text — `SourceAtom` holds `atomTextHash`, because the
    // merged contract (§A2) gives the stitched display quote ZERO identity
    // weight — so the projection publishes those digests as
    // `sourceAnchor.quoteHashes` and the checklist quote is bound to them.
    // That is stronger than the string compare it replaces: it pins the
    // checklist to the exact source atom the sealed revision names, and it
    // cannot be satisfied by a quote that merely renders the same.
    const anchor = it.sourceAnchor;
    const quoteHash = anchor && typeof anchor.quoteHash === 'string' && anchor.quoteHash.length
      ? anchor.quoteHash
      : null;
    const quoteHashes = anchor && Array.isArray(anchor.quoteHashes)
      ? anchor.quoteHashes.filter((h) => typeof h === 'string' && h.length > 0)
      : [];
    if (quoteHash || quoteHashes.length) {
      const localDigest = sha256Of(Buffer.from(String(o.doc_quote ?? ''), 'utf8'));
      if (quoteHash ? localDigest !== quoteHash : !quoteHashes.includes(localDigest)) {
        findings.push({
          code: 'OBLIGATION_QUOTE_DRIFT',
          detail: quoteHash
            ? `${o.id} doc_quote digests to ${localDigest}, not the sealed stitched-quote digest ${quoteHash}`
            : `${o.id} doc_quote digests to ${localDigest}, which is not among the sealed source atoms [${quoteHashes.join(', ')}]`,
        });
      }
    } else {
      const signedQuote = anchor ? anchor.quote : undefined;
      if (signedQuote !== undefined && String(signedQuote) !== String(o.doc_quote ?? '')) {
        findings.push({ code: 'OBLIGATION_QUOTE_DRIFT', detail: `${o.id} doc_quote differs from the signed source anchor` });
      }
    }
  }
  for (const id of items.keys()) {
    if (!oblIds.has(id)) {
      findings.push({ code: 'CONTRACT_ITEM_NOT_JUDGED', detail: `${id} is in the signed contract but absent from the checklist being judged` });
    }
  }
  return { bound: findings.length === 0, items, findings };
}

export { sha256Of, bindChecklist };
