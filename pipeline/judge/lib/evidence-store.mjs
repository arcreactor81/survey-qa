/**
 * judge/lib/evidence-store.mjs — the only door to the run's artifacts.
 *
 * Three jobs now, all of them defences against the failure this engine exists
 * to fix:
 *
 *  1. RE-READ AT JUDGEMENT TIME. Every artifact is read from disk by this
 *     store. Nothing in the judge may take a fact from an earlier stage's
 *     summary (`observations.json`, `_analysis.json`, the rendered report).
 *
 *  2. THE SIGNED AUTHORITY DECIDES WHAT AN ARTIFACT IS (D1). The expected
 *     content hash comes from the Ed25519-attested RunRecord's evidence
 *     catalogue, NOT from the file. Previously the hash was learned from the
 *     artifact on first read, so a file replaced before the judge ran simply
 *     supplied its own new expected hash and re-verified against itself. Now a
 *     substituted or unlisted artifact fails on FIRST contact.
 *
 *  3. INDEPENDENT ATTESTATION VIA CLOSED PROOF PROJECTIONS (D5). Every witness
 *     names a projection from `proof.mjs`; `attest()` opens the artifact again,
 *     uncached, and recomputes the WHOLE claim — not just the one field the
 *     predicate chose to expose.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve, sep } from 'node:path';
import { EVIDENCE_CLASS, REASON, PROOF_KIND } from './vocab.mjs';
import { resolvePath } from './locator.mjs';
import { PROOFS, FIELD_PROJECTIONS } from './proof.mjs';
import { checkEvidenceSource } from './authority.mjs';
import { isV2PathObservation, projectPathObservation } from './v2-observation.mjs';

/**
 * N2 — A HASH FAILURE IS RAISED, NEVER RETURNED.
 *
 * `read()` used to return `{ok:false, reason:ARTIFACT_HASH_MISMATCH}` for an
 * artifact whose bytes disagree with the signed catalogue, and every caller
 * treated a not-ok record as "skip this one": `loadSessions` quarantined it and
 * moved on. So pointing a verified authority at a different run directory did
 * not fail — it silently REMOVED the disagreeing evidence, and two obligations
 * that fail on the real run came out `inconclusive` on a record that still
 * signed. Skipping is what converted real failures into inconclusives, so the
 * mismatch is now thrown: it is an integrity failure of the whole run, and the
 * only honest response is to refuse, not to judge a smaller evidence set.
 */
export class EvidenceIntegrityError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EvidenceIntegrityError';
    this.code = code;
    Object.assign(this, detail);
  }
}

export { resolvePath };
/** Back-compatible alias: the field-projection registry used by `capture-field`. */
export const PROJECTIONS = FIELD_PROJECTIONS;

const DERIVED_SUMMARIES = new Set(['_analysis.json', '_textdiff.json', '_run-summary.json']);
const PRIMARY_PROBES = new Set(['_targeted.json', '_scale-probes.json']);

/** Classes that may never carry a machine verdict. */
const NON_PRIMARY_CLASSES = new Set([
  EVIDENCE_CLASS.IMAGE,
  EVIDENCE_CLASS.DERIVED_SUMMARY,
  EVIDENCE_CLASS.UNKNOWN,
]);

const CLASS_REFUSAL = {
  [EVIDENCE_CLASS.IMAGE]: REASON.IMAGE_ONLY_EVIDENCE,
  [EVIDENCE_CLASS.DERIVED_SUMMARY]: REASON.DERIVED_SUMMARY_CITED_AS_PRIMARY,
  [EVIDENCE_CLASS.UNKNOWN]: REASON.UNKNOWN_ARTIFACT_CLASS_CITED,
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function classifyArtifact(name) {
  const b = basename(name);
  if (/\.png$/i.test(b) || /\.jpe?g$/i.test(b)) return EVIDENCE_CLASS.IMAGE;
  if (DERIVED_SUMMARIES.has(b)) return EVIDENCE_CLASS.DERIVED_SUMMARY;
  if (PRIMARY_PROBES.has(b)) return EVIDENCE_CLASS.PRIMARY_PROBE;
  if (/^(FLOOR|EXP|TD|T\d)[-\w]*\.json$/i.test(b)) return EVIDENCE_CLASS.PRIMARY_SESSION;
  if (/\.json$/i.test(b)) return EVIDENCE_CLASS.UNKNOWN;
  return EVIDENCE_CLASS.UNKNOWN;
}

export class EvidenceStore {
  /**
   * @param {string} runDir absolute path to the frozen run directory (read-only)
   * @param {object} [opts]
   * @param {import('./authority.mjs').EvidenceAuthority} [opts.authority] the signed allowlist
   */
  /**
   * @param {string[]} [opts.screenIdVocabulary] the SEALED question ids a v2 walk's screens
   *   may name themselves with. Only the v2 projection uses it (`v2-observation.mjs`); a v1
   *   artifact carries its own `screen_id` and is untouched.
   */
  constructor(runDir, { artifactsSubdir = 'artifacts', authority = null, screenIdVocabulary = [] } = {}) {
    // N2 — THE STORE MAY ONLY OPEN THE DIRECTORY ITS AUTHORITY DESCRIBES.
    //
    // Structural half of the runDir fix: even constructed directly, a store
    // cannot pair a verified authority with a different evidence source. The
    // engine refuses the same combination one level up; this makes the refusal
    // a property of the object rather than of one call path.
    const src = checkEvidenceSource(authority, runDir, { artifactsSubdir });
    if (!src.ok) {
      throw new EvidenceIntegrityError(
        'EVIDENCE_SOURCE_NOT_BOUND_TO_AUTHORITY',
        `refusing to read evidence that the verified authority does not describe: ${src.why}`,
        { expected: src.expected, actual: src.actual },
      );
    }
    this.runDir = runDir;
    this.artifactsDir = resolve(join(runDir, artifactsSubdir));
    /** Canonical identity of the directory this store reads. */
    this.evidenceSource = src.actual;
    this.authority = authority;
    this.screenIdVocabulary = Array.isArray(screenIdVocabulary) ? screenIdVocabulary : [];
    this._cache = new Map(); // name -> record
    this._reads = 0;
    this.integrity = [];
  }

  get readCount() { return this._reads; }

  /** True when reads are checked against an Ed25519-attested catalogue. */
  get authoritative() { return !!(this.authority && this.authority.verified); }

  listArtifacts() {
    // The SIGNED catalogue is the artifact list when one is available: a file
    // dropped into the directory after signing must not become an input.
    if (this.authoritative) return [...this.authority.manifest.keys()].sort();
    if (!existsSync(this.artifactsDir)) return [];
    return readdirSync(this.artifactsDir).filter((f) => statSync(join(this.artifactsDir, f)).isFile());
  }

  /**
   * Normalize any citation form ("artifacts/EXP-049.json#routes", "EXP-049")
   * to a bare filename. Traversal is rejected outright rather than stripped:
   * `../../etc/passwd` and `a/../../b` must not resolve to anything.
   */
  static normalizeRef(ref) {
    let r = String(ref).trim();
    const hash = r.includes('#') ? r.slice(r.indexOf('#') + 1) : null;
    r = hash === null ? r : r.slice(0, r.indexOf('#'));
    r = r.replace(/^\.?[\\/]*/, '').replace(/^artifacts[\\/]/, '');
    if (r && !/\.[a-z0-9]+$/i.test(r)) r = `${r}.json`;
    // A reference is a bare artifact NAME. Anything with a path separator, a
    // parent segment, a drive letter or a NUL is malformed.
    const traversal = r.length === 0
      || /[\\/]/.test(r)
      || r === '.' || r === '..'
      || /^[a-zA-Z]:/.test(r)
      || r.includes('\0');
    return { name: r, fragment: hash, traversal };
  }

  /** Is `name` a plain file directly inside artifactsDir (no symlink escape)? */
  _confine(name) {
    const p = resolve(join(this.artifactsDir, name));
    if (p !== join(this.artifactsDir, name)) return null;
    if (!(p === this.artifactsDir || p.startsWith(this.artifactsDir + sep))) return null;
    if (resolve(p, '..') !== this.artifactsDir) return null;
    if (!existsSync(p)) return p; // missing is a different (reported) condition
    try {
      const real = realpathSync(p);
      const realDir = realpathSync(this.artifactsDir);
      if (resolve(real, '..') !== realDir) return null; // symlink out of the root
      if (!statSync(real).isFile()) return null;
    } catch { return null; }
    return p;
  }

  /**
   * Read an artifact from disk. `fresh:true` bypasses the cache — used by
   * attest() so re-verification cannot be satisfied by a cached parse.
   */
  read(ref, { fresh = false } = {}) {
    const { name, fragment, traversal } = EvidenceStore.normalizeRef(ref);
    if (traversal) {
      return {
        ok: false, name, path: null, evidenceClass: EVIDENCE_CLASS.UNKNOWN,
        reason: REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT, sha256: null, data: null, fragment,
      };
    }
    if (!fresh && this._cache.has(name)) return { ...this._cache.get(name), fragment };

    const path = this._confine(name);
    if (path === null) {
      const rec = {
        ok: false, name, path: null, evidenceClass: EVIDENCE_CLASS.UNKNOWN,
        reason: REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT, sha256: null, data: null,
      };
      if (!fresh) this._cache.set(name, rec);
      return { ...rec, fragment };
    }

    // The signed catalogue decides membership BEFORE the bytes are trusted.
    const signed = this.authority ? this.authority.manifest.get(name) || null : null;
    if (this.authoritative && !signed) {
      const rec = {
        ok: false, name, path, evidenceClass: classifyArtifact(name),
        reason: REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST, sha256: null, data: null,
      };
      if (!fresh) this._cache.set(name, rec);
      return { ...rec, fragment };
    }

    const evidenceClass = classifyArtifact(name);
    if (!existsSync(path)) {
      const rec = { ok: false, name, path, evidenceClass, reason: REASON.CITED_ARTIFACT_MISSING, sha256: null, data: null };
      if (!fresh) this._cache.set(name, rec);
      return { ...rec, fragment };
    }
    const buf = readFileSync(path);
    this._reads += 1;
    const digest = sha256(buf);

    // D1: the EXPECTED hash comes from the signature, never from the file.
    // N2: and a disagreement RAISES. Returning it made the artifact skippable,
    // and a skipped artifact is a defect that quietly stops being reported.
    if (signed) {
      if (signed.contentHash !== `sha256:${digest}`) {
        const detail = `on disk sha256:${digest}, signed ${signed.contentHash}`;
        this.integrity.push({ code: REASON.ARTIFACT_HASH_MISMATCH, artifact: name, detail });
        throw new EvidenceIntegrityError(
          REASON.ARTIFACT_HASH_MISMATCH,
          `${name} does not match the signed evidence catalogue: ${detail}`,
          { artifact: name, observedHash: `sha256:${digest}`, signedHash: signed.contentHash },
        );
      }
      if (signed.byteLength !== null && signed.byteLength !== buf.length) {
        const detail = `byteLength ${buf.length} != signed ${signed.byteLength}`;
        this.integrity.push({ code: REASON.ARTIFACT_HASH_MISMATCH, artifact: name, detail });
        throw new EvidenceIntegrityError(
          REASON.ARTIFACT_HASH_MISMATCH,
          `${name} does not match the signed evidence catalogue: ${detail}`,
          { artifact: name, observedBytes: buf.length, signedBytes: signed.byteLength },
        );
      }
    }

    let data = null;
    let parseError = null;
    if (/\.json$/i.test(name)) {
      try { data = JSON.parse(buf.toString('utf8')); } catch (e) { parseError = e.message; }
    }

    // A v2 PathObservation IS a capture spine; it is written in a different vocabulary.
    // The projection happens HERE — after the signed-hash check, before classification —
    // for two reasons that leave no other option:
    //   - the bytes on disk must keep hashing to the SIGNED contentHash, so no stage
    //     upstream of this store may rewrite them;
    //   - `attest()` re-opens the artifact uncached and runs the proof projection over
    //     `rec.data`, so the predicates and the re-verification must see the SAME view or
    //     every witness locator (`evidence[3].screen_id`) fails to resolve.
    // `sha256` below is still the digest of the bytes on disk, never of the projection.
    let adapted = null;
    if (isV2PathObservation(data)) {
      data = projectPathObservation(data, { screenIdVocabulary: this.screenIdVocabulary });
      adapted = 'v2-path-observation/1.0.0';
    }

    // Classification is by SHAPE first, filename second. Promotion to
    // PRIMARY_SESSION additionally requires a well-formed capture spine (D7):
    // unique, ordered, consecutive seq values. A gap-free spine is what every
    // edge in the route table is built on, so a spine that is not gap-free may
    // not be promoted to the class that carries verdicts.
    let cls = evidenceClass;
    if (cls !== EVIDENCE_CLASS.DERIVED_SUMMARY && cls !== EVIDENCE_CLASS.IMAGE && data) {
      const spine = captureSpineState(data);
      if (spine.wellFormed) cls = EVIDENCE_CLASS.PRIMARY_SESSION;
      else if (spine.looksLikeSession) cls = EVIDENCE_CLASS.UNKNOWN;
    }
    const rec = {
      ok: parseError === null,
      name, path, evidenceClass: cls,
      sha256: digest,
      signedHash: signed ? signed.contentHash : null,
      hashAuthority: signed ? 'signed-run-record' : 'unattested-local-read',
      bytes: buf.length,
      data,
      /** Non-null when `data` is a PROJECTION of the artifact rather than its literal JSON. */
      adapted,
      reason: parseError ? 'parse-error' : null,
      parseError,
    };
    if (!fresh) this._cache.set(name, rec);
    return { ...rec, fragment };
  }

  /**
   * Independently re-verify a witness by recomputing its PROOF PROJECTION from
   * a fresh, uncached read of the signed artifact.
   *
   * @returns {{ok:boolean, reason?:string, observed?:any, sha256?:string, proofKind?:string}}
   */
  attest(witness) {
    const rec = this.read(witness.artifact, { fresh: true });
    if (!rec.ok) {
      const reason = rec.reason === REASON.CITED_ARTIFACT_MISSING ? REASON.CITED_ARTIFACT_MISSING
        : rec.reason === REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST ? REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST
          : rec.reason === REASON.ARTIFACT_HASH_MISMATCH ? REASON.ARTIFACT_HASH_MISMATCH
            : rec.reason === REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT ? REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT
              : REASON.WITNESS_REREAD_FAILED;
      return { ok: false, reason, sha256: rec.sha256 ?? null };
    }
    // A witness may pin a hash; it must agree with the signed one as well.
    if (witness.sha256 && witness.sha256 !== rec.sha256) {
      return { ok: false, reason: REASON.WITNESS_REREAD_FAILED, observed: rec.sha256, sha256: rec.sha256 };
    }
    // Only PRIMARY evidence may machine-support a claim. Images, derived
    // summaries and unclassifiable JSON are all refused — the last two used to
    // sail through because only images were checked.
    if (NON_PRIMARY_CLASSES.has(rec.evidenceClass)) {
      return { ok: false, reason: CLASS_REFUSAL[rec.evidenceClass], sha256: rec.sha256, evidenceClass: rec.evidenceClass };
    }

    const kind = witness.proofKind || (witness.proof && witness.proof.kind) || PROOF_KIND.CAPTURE_FIELD;
    const proof = PROOFS[kind];
    if (!proof) return { ok: false, reason: REASON.PROOF_PROJECTION_MISSING, sha256: rec.sha256, proofKind: kind };

    const claim = kind === PROOF_KIND.CAPTURE_FIELD
      ? { locator: witness.locator, derive: witness.derive, ...('equals' in witness ? { equals: witness.equals } : {}) }
      : (witness.proof && witness.proof.claim) || null;
    if (!claim) return { ok: false, reason: REASON.PROOF_PROJECTION_MISSING, sha256: rec.sha256, proofKind: kind };

    let r;
    try { r = proof(rec.data, claim); } catch (e) {
      return { ok: false, reason: REASON.PROOF_PROJECTION_FAILED, sha256: rec.sha256, proofKind: kind, observed: String(e && e.message ? e.message : e) };
    }
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, observed: r.observed, sha256: rec.sha256, proofKind: kind };
    return { ok: true, observed: r.observed, sha256: rec.sha256, proofKind: kind };
  }
}

/**
 * D7: is `data` a well-formed capture spine? Unique, ordered and CONSECUTIVE
 * seq values, each with a screen id. `looksLikeSession` distinguishes "this is
 * a broken session" from "this is not a session at all".
 */
export function captureSpineState(data) {
  const ev = data && Array.isArray(data.evidence) ? data.evidence : null;
  if (!ev || ev.length === 0) return { wellFormed: false, looksLikeSession: false, problems: [] };
  const problems = [];
  let looksLikeSession = true;
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < ev.length; i += 1) {
    const e = ev[i];
    if (!e || typeof e.screen_id !== 'string' || !Number.isFinite(e.seq)) {
      looksLikeSession = i > 0; // a first bad entry means it is not a spine at all
      problems.push({ code: 'CAPTURE_INDEX_MALFORMED', index: i, detail: 'entry has no screen_id / finite seq' });
      return { wellFormed: false, looksLikeSession, problems };
    }
    if (seen.has(e.seq)) problems.push({ code: 'CAPTURE_INDEX_DUPLICATE', index: i, seq: e.seq, detail: `seq ${e.seq} appears more than once` });
    seen.add(e.seq);
    if (prev !== null) {
      if (e.seq <= prev) problems.push({ code: 'CAPTURE_INDEX_NOT_MONOTONIC', index: i, seq: e.seq, detail: `seq ${e.seq} follows ${prev}` });
      else if (e.seq !== prev + 1) problems.push({ code: 'CAPTURE_INDEX_NOT_CONSECUTIVE', index: i, seq: e.seq, detail: `seq jumps ${prev} -> ${e.seq}; the spine is not gap-free` });
    }
    prev = e.seq;
  }
  return { wellFormed: problems.length === 0, looksLikeSession, problems };
}
