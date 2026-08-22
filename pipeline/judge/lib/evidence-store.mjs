/**
 * judge/lib/evidence-store.mjs — the only door to the run's artifacts.
 *
 * Three jobs now, all of them defences against the failure this engine exists
 * to fix:
 *
 *  1. RE-READ AT JUDGEMENT TIME. Every artifact is read through this store's
 *     async byte source. Nothing in the judge may take a fact from an earlier
 *     stage's summary (`observations.json`, `_analysis.json`, the rendered
 *     report).
 *
 *  2. THE SIGNED AUTHORITY DECIDES WHAT AN ARTIFACT IS (D1). The expected
 *     content hash comes from the Ed25519-attested RunRecord's evidence
 *     catalogue, NOT from the source. Previously the hash was learned from the
 *     artifact on first read, so a file replaced before the judge ran simply
 *     supplied its own new expected hash and re-verified against itself. Now a
 *     substituted or unlisted artifact fails on FIRST contact.
 *
 *  3. INDEPENDENT ATTESTATION VIA CLOSED PROOF PROJECTIONS (D5). Every witness
 *     names a projection from `proof.mjs`; `attest()` re-fetches the artifact
 *     uncached through the source, and recomputes the WHOLE claim — not just
 *     the one field the predicate chose to expose.
 *
 * A3b — ASYNC BYTE SOURCE.
 *
 * The store fetches artifact bytes through an injected async source rather than
 * reading them from disk. This lets the worker supply an R2-backed source that
 * streams one session at a time, so a 128 MB isolate never needs to hold
 * 112.8 MB of raw session data simultaneously.
 *
 * The source interface is intentionally simple — it is dumb transport:
 *   { names(): string[], fetch(name): Promise<Uint8Array|null> }
 *
 * The STORE does all verification: signed-manifest membership, hash of fetched
 * bytes vs the SIGNED contentHash, byteLength check, JSON parse, projection,
 * shape classification. The source never invents, verifies, or modifies bytes.
 *
 * RESIDENCY RULE: for PRIMARY_SESSION records the cache stores the rec with
 * data = the PROJECTION (v2-path-observation or native v1 evidence[]) and must
 * NOT retain the raw buffer or the full pre-projection parse. The store tracks
 * cumulative retained JSON-length and throws EngineRetainedBudgetExceeded if
 * it exceeds RETAINED_PROJECTION_BUDGET.
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

/**
 * A3b — RETAINED PROJECTION BUDGET EXCEEDED.
 *
 * The store tracks cumulative retained JSON-length of all cached PRIMARY_SESSION
 * projections. When the total exceeds RETAINED_PROJECTION_BUDGET the isolate
 * cannot safely proceed: the projections alone would consume most of the 128 MB
 * heap.
 *
 * Math from the v100 census:
 *   35 sessions x projectPathObservation = ~18 MB total projection
 *   64 MB budget gives ~3.5x headroom for future runs with more/larger sessions
 *   128 MB isolate - 64 MB projections = 64 MB for engine structures, route
 *   table, census, scope attestor, compiled obligations, and GC overhead
 */
export class EngineRetainedBudgetExceeded extends Error {
  constructor(retainedBytes, budget) {
    super(
      `the engine's cached session projections total ${(retainedBytes / (1024 * 1024)).toFixed(1)} MB, ` +
      `which exceeds the ${(budget / (1024 * 1024)).toFixed(0)} MB retained-projection budget. ` +
      `The isolate cannot safely hold this much data alongside the engine's working structures.`,
    );
    this.name = 'EngineRetainedBudgetExceeded';
    this.retainedBytes = retainedBytes;
    this.budget = budget;
  }
}

/**
 * A3b — SINGLE ARTIFACT TOO LARGE TO PARSE.
 *
 * A single engine-read artifact whose signed byteLength exceeds 32 MB would
 * produce a JSON.parse transient that, combined with the retained projections,
 * cannot fit in a 128 MB isolate.
 *
 * Math: JSON.parse of a 32 MB buffer creates ~32 MB of JS objects + the 32 MB
 * buffer itself = ~64 MB transient. With ~18 MB of retained projections and
 * ~40 MB of engine structures, 64 MB transient leaves ~6 MB of headroom.
 * Above 32 MB the transient alone could OOM the isolate.
 */
export class SingleArtifactTooLarge extends Error {
  constructor(name, byteLength, limit) {
    super(
      `artifact ${name} is ${(byteLength / (1024 * 1024)).toFixed(1)} MB ` +
      `(signed byteLength), which exceeds the ${(limit / (1024 * 1024)).toFixed(0)} MB ` +
      `single-artifact limit. The parse transient of a file this large could not ` +
      `fit beside the retained projections in a 128 MB isolate.`,
    );
    this.name = 'SingleArtifactTooLarge';
    this.artifactName = name;
    this.byteLength = byteLength;
    this.limit = limit;
  }
}

/**
 * A3b — RETAINED PROJECTION BUDGET.
 *
 * Census math (v100 run, 9,340 catalogue entries):
 *   35 true session files: 112.8 MB raw
 *   projectPathObservation on all 35: ~18 MB total
 *   One largest session: 12.5 MB raw -> 1.89 MB projected
 *
 * 64 MB gives ~3.5x headroom over the measured 18 MB, leaving 64 MB of the
 * 128 MB isolate for the engine's route table, census, scope attestor, compiled
 * obligations, proof projections, and GC overhead.
 */
export const RETAINED_PROJECTION_BUDGET = 64 * 1024 * 1024;

/**
 * A3b — SINGLE-ARTIFACT BYTE LIMIT.
 *
 * Any engine-read artifact whose signed byteLength exceeds this limit is refused
 * before fetching. See SingleArtifactTooLarge for the math.
 */
export const SINGLE_ARTIFACT_BYTE_LIMIT = 32 * 1024 * 1024;

export { resolvePath };
/** Back-compatible alias: the field-projection registry used by `capture-field`. */
export const PROJECTIONS = FIELD_PROJECTIONS;

const DERIVED_SUMMARIES = new Set(['_analysis.json', '_textdiff.json', '_run-summary.json']);
export const PRIMARY_PROBES = new Set(['_targeted.json', '_scale-probes.json']);

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

function sha256hex(buf) {
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

/**
 * A3b — IS THIS NAME A SESSION CANDIDATE?
 *
 * The pre-filter for loadSessions and ScopeAttestor: under the async source,
 * only candidates whose name matches this predicate are actually FETCHED. Names
 * outside this set are listed in the manifest (the authority's word on what
 * exists) and counted as "listed, hash-verified upstream, not engine-read" — a
 * named, visible category, not silence.
 *
 * The filter is INCLUSIVE: it admits any .json file that COULD be a session,
 * and excludes only the files it can positively identify as NON-sessions:
 *   - images (.png, .jpg)
 *   - derived summaries (_analysis.json, _textdiff.json, _run-summary.json)
 *   - step captures: files matching step-NNN-* pattern or ending in
 *     .accessibility.json (walker step artifacts, not sessions)
 *
 * A file the filter cannot classify (e.g. SELF-01.json in a test fixture)
 * is fetched and classified by shape. That is the honest default: an
 * unfamiliar name that turns out to be a session must not be lost behind a
 * pattern that was too narrow. The bandwidth cost of fetching a non-session
 * .json is small compared to losing a session.
 */
export function isSessionCandidate(name) {
  const b = basename(name);
  // Non-JSON files are never sessions.
  if (!/\.json$/i.test(b)) return false;
  // Derived summaries are never sessions.
  if (DERIVED_SUMMARIES.has(b)) return false;
  // Step-level capture files. The walker's real leaf names carry the step
  // marker MID-NAME after the pathId slug — `FLOOR-01--fi_x-step-020-before.json`,
  // `...-retry-1-step-010-before.json` — so the marker must match anywhere,
  // not only at the start. Checked against the real v100 catalogue: an
  // anchored-only `^step-` admitted 2,330 step captures (73.6 MB raw) into
  // the session sweep, where each would have been fetched, parsed, and cached
  // — the OOM this module exists to prevent, reborn. The anchored form is
  // kept for leaves that ARE the whole basename (`step-000-slot.json`).
  if (/^step-\d+-/i.test(b)) return false;
  if (/-step-\d+-/i.test(b)) return false;
  if (/\.accessibility\.json$/i.test(b)) return false;
  // Everything else could be a session — the engine will classify by shape.
  return true;
}

/**
 * A3b — DISK-BACKED BYTE SOURCE.
 *
 * Wraps the synchronous readFileSync behaviour for the LOCAL pipeline and every
 * selftest. The fetch() method returns a Buffer wrapped in a resolved Promise,
 * so the store's async read() works identically on disk and over R2.
 *
 * Includes the full confinement check from the previous _confine() method:
 * symlink escapes, path traversal, and non-file entries are all refused.
 */
export function diskSource(artifactsDir) {
  const resolvedDir = resolve(artifactsDir);
  return {
    names() {
      if (!existsSync(resolvedDir)) return [];
      return readdirSync(resolvedDir).filter((f) => {
        try { return statSync(join(resolvedDir, f)).isFile(); } catch { return false; }
      });
    },
    async fetch(name) {
      const p = resolve(join(resolvedDir, name));
      if (p !== join(resolvedDir, name)) return null;
      if (!(p === resolvedDir || p.startsWith(resolvedDir + sep))) return null;
      if (resolve(p, '..') !== resolvedDir) return null;
      if (!existsSync(p)) return null;
      try {
        const real = realpathSync(p);
        const realDir = realpathSync(resolvedDir);
        if (resolve(real, '..') !== realDir) return null;
        if (!statSync(real).isFile()) return null;
      } catch { return null; }
      return readFileSync(p);
    },
  };
}

export class EvidenceStore {
  /**
   * @param {string} runDir absolute path to the frozen run directory (read-only)
   * @param {object} [opts]
   * @param {import('./authority.mjs').EvidenceAuthority} [opts.authority] the signed allowlist
   * @param {string[]} [opts.screenIdVocabulary] the SEALED question ids a v2 walk's screens
   *   may name themselves with. Only the v2 projection uses it (`v2-observation.mjs`); a v1
   *   artifact carries its own `screen_id` and is untouched.
   * @param {{names():string[], fetch(name:string):Promise<Uint8Array|null>}} [opts.source]
   *   An async byte source. When null (the default) a disk-backed source is created from
   *   runDir/artifactsSubdir. The worker injects an R2-backed source.
   */
  constructor(runDir, { artifactsSubdir = 'artifacts', authority = null, screenIdVocabulary = [], source = null } = {}) {
    // N2 — THE STORE MAY ONLY OPEN THE DIRECTORY ITS AUTHORITY DESCRIBES.
    //
    // Structural half of the runDir fix: even constructed directly, a store
    // cannot pair a verified authority with a different evidence source. The
    // engine refuses the same combination one level up; this makes the refusal
    // a property of the object rather than of one call path.
    //
    // When an injected source is provided (R2-backed), the checkEvidenceSource
    // call still runs against runDir to validate the authority binding, but the
    // source handles the actual byte retrieval.
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
    this._source = source || diskSource(this.artifactsDir);
    this._cache = new Map(); // name -> record
    this._reads = 0;
    /** A3b — cumulative JSON-length of cached PRIMARY_SESSION projection data. */
    this._retainedBytes = 0;
    this.integrity = [];
  }

  get readCount() { return this._reads; }

  /** A3b — cumulative retained projection size in bytes (approximate JSON length). */
  get retainedBytes() { return this._retainedBytes; }

  /** True when reads are checked against an Ed25519-attested catalogue. */
  get authoritative() { return !!(this.authority && this.authority.verified); }

  listArtifacts() {
    // The SIGNED catalogue is the artifact list when one is available: a file
    // dropped into the directory after signing must not become an input.
    if (this.authoritative) return [...this.authority.manifest.keys()].sort();
    return this._source.names();
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

  /**
   * Read an artifact through the async byte source. `fresh:true` bypasses the
   * cache — used by attest() so re-verification cannot be satisfied by a cached
   * parse.
   *
   * A3b: this method is async. It fetches bytes through this._source.fetch(),
   * which returns a Promise. The internal order and guarantees are unchanged:
   *   1. signed-manifest membership check (before any fetch)
   *   2. single-artifact size check (before any fetch)
   *   3. fetch bytes through the source
   *   4. hash of fetched bytes vs the SIGNED contentHash
   *   5. byteLength check
   *   6. JSON parse
   *   7. projectPathObservation for v2-path-observation docs
   *   8. shape classification / promotion via captureSpineState
   *
   * CRITICAL RESIDENCY RULE: for PRIMARY_SESSION records the cache stores the
   * rec with data = the PROJECTION and must NOT retain the raw buffer or the
   * full pre-projection parse (references are dropped so they are collectable).
   */
  async read(ref, { fresh = false } = {}) {
    const { name, fragment, traversal } = EvidenceStore.normalizeRef(ref);
    if (traversal) {
      return {
        ok: false, name, path: null, evidenceClass: EVIDENCE_CLASS.UNKNOWN,
        reason: REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT, sha256: null, data: null, fragment,
      };
    }
    if (!fresh && this._cache.has(name)) return { ...this._cache.get(name), fragment };

    // The signed catalogue decides membership BEFORE the bytes are trusted.
    const signed = this.authority ? this.authority.manifest.get(name) || null : null;
    if (this.authoritative && !signed) {
      const rec = {
        ok: false, name, path: null, evidenceClass: classifyArtifact(name),
        reason: REASON.ARTIFACT_NOT_IN_SIGNED_MANIFEST, sha256: null, data: null,
      };
      if (!fresh) this._cache.set(name, rec);
      return { ...rec, fragment };
    }

    // A3b — SINGLE-ARTIFACT SIZE CHECK. Done before fetching to avoid wasting
    // bandwidth and transient memory on an artifact the isolate cannot parse.
    const evidenceClass = classifyArtifact(name);
    if (signed && signed.byteLength !== null && signed.byteLength > SINGLE_ARTIFACT_BYTE_LIMIT) {
      throw new SingleArtifactTooLarge(name, signed.byteLength, SINGLE_ARTIFACT_BYTE_LIMIT);
    }

    // Fetch bytes through the async source.
    const buf = await this._source.fetch(name);
    if (buf === null) {
      const rec = { ok: false, name, path: null, evidenceClass, reason: REASON.CITED_ARTIFACT_MISSING, sha256: null, data: null };
      if (!fresh) this._cache.set(name, rec);
      return { ...rec, fragment };
    }
    this._reads += 1;
    const digest = sha256hex(buf);

    // D1: the EXPECTED hash comes from the signature, never from the file.
    // N2: and a disagreement RAISES. Returning it made the artifact skippable,
    // and a skipped artifact is a defect that quietly stops being reported.
    if (signed) {
      if (signed.contentHash !== `sha256:${digest}`) {
        const detail = `fetched sha256:${digest}, signed ${signed.contentHash}`;
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
      // Use TextDecoder for Uint8Array compatibility (R2 source returns Uint8Array,
      // disk source returns Buffer which is also Uint8Array).
      try {
        const text = typeof buf.toString === 'function' && buf instanceof Buffer
          ? buf.toString('utf8')
          : new TextDecoder().decode(buf);
        data = JSON.parse(text);
      } catch (e) { parseError = e.message; }
    }

    // A v2 PathObservation IS a capture spine; it is written in a different vocabulary.
    // The projection happens HERE — after the signed-hash check, before classification —
    // for two reasons that leave no other option:
    //   - the bytes must keep hashing to the SIGNED contentHash, so no stage
    //     upstream of this store may rewrite them;
    //   - `attest()` re-fetches the artifact uncached and runs the proof projection over
    //     `rec.data`, so the predicates and the re-verification must see the SAME view or
    //     every witness locator (`evidence[3].screen_id`) fails to resolve.
    // `sha256` below is still the digest of the fetched bytes, never of the projection.
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

    // RESIDENCY ACCOUNTING: track the cumulative retained size of EVERYTHING the
    // cache keeps parsed data for — sessions (projections) AND any other cached
    // .json read (cited artifacts, probes, files the shape check declined to
    // promote). Counting only sessions would leave a class of retention the
    // budget cannot see: a sweep filter defect or a cite-heavy run could fill
    // the cache with unaccounted parses and OOM below a "respected" budget.
    // The raw buffer `buf` goes out of scope here; only `data` is retained.
    if (!fresh && data) {
      const jsonLen = JSON.stringify(data).length;
      this._retainedBytes += jsonLen;
      if (this._retainedBytes > RETAINED_PROJECTION_BUDGET) {
        throw new EngineRetainedBudgetExceeded(this._retainedBytes, RETAINED_PROJECTION_BUDGET);
      }
    }

    const rec = {
      ok: parseError === null,
      name, path: null, evidenceClass: cls,
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
   * SYNCHRONOUS, CACHE-ONLY read — for the predicates, which are sync functions.
   *
   * WHY THIS EXISTS. When read() went async (A3b), two predicates that read the
   * targeted-probe artifact mid-flight (`mobileSingleStatement`, `desktopGrid` in
   * predicates.mjs) kept calling it synchronously: the returned Promise's `.ok`
   * is undefined, so both quietly concluded "no observation" and two t1
   * obligations moved off the pinned v1 baseline (pass 89 -> 88) — caught by
   * d1-acceptance, not by any engine selftest. Silent Promise-as-record is the
   * exact silent-wrongness class this repo bans.
   *
   * The contract: `buildContext` (engine.mjs) awaits a real read() of every
   * PRIMARY_PROBE artifact present in the manifest BEFORE any predicate runs,
   * so by predicate time a probe is either in the cache (returned here with all
   * of read()'s verification already applied) or genuinely absent from the run
   * (an honest CITED_ARTIFACT_MISSING). This method NEVER fetches: a sync fetch
   * cannot verify, and an unverified byte must not reach a predicate.
   */
  readCached(ref) {
    const { name, fragment, traversal } = EvidenceStore.normalizeRef(ref);
    if (traversal) {
      return {
        ok: false, name, path: null, evidenceClass: EVIDENCE_CLASS.UNKNOWN,
        reason: REASON.ARTIFACT_OUTSIDE_EVIDENCE_ROOT, sha256: null, data: null, fragment,
      };
    }
    if (this._cache.has(name)) return { ...this._cache.get(name), fragment };
    return {
      ok: false, name, path: null, evidenceClass: classifyArtifact(name),
      reason: REASON.CITED_ARTIFACT_MISSING, sha256: null, data: null, fragment,
    };
  }

  /**
   * Independently re-verify a witness by recomputing its PROOF PROJECTION from
   * a fresh, uncached re-fetch of the signed artifact through the source.
   *
   * A3b: this method is async. It fetches fresh bytes through the source,
   * re-hashes against the signed catalogue, re-projects, and evaluates the
   * proof projection. The "fresh and uncached" property is preserved: the bytes
   * come from the source (fresh), never from the main cache (uncached).
   *
   * @returns {Promise<{ok:boolean, reason?:string, observed?:any, sha256?:string, proofKind?:string}>}
   */
  async attest(witness) {
    const rec = await this.read(witness.artifact, { fresh: true });
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
