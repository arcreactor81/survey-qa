/**
 * judge/lib/scope-attest.mjs — D5 + D8. COMPLETENESS IS ATTESTED, NOT ASSERTED.
 *
 * The global and absence tripwires used to check that a `scope` object existed
 * and carried a non-zero count. The count itself was authored by the predicate
 * that wanted the pass. "I searched 812 captures and found nothing" was
 * therefore self-certifying: a predicate that searched 3 captures and wrote 812
 * passed the same tripwire.
 *
 * This module performs a SECOND, INDEPENDENT pass over the signed artifact set
 * — one fresh read per artifact, hash-checked against the attested RunRecord —
 * and rebuilds the population itself. A scope claim is then checked against a
 * population the claimant had no part in computing:
 *
 *   - the enumerated members must be EXACTLY the members that exist (no missing
 *     member, no invented one);
 *   - the declared digest must equal the digest of the independently rebuilt
 *     content;
 *   - counts must equal the independently counted population.
 *
 * The same check runs for satisfied-ABSENCE claims ("nothing anywhere matched")
 * and for violated-PRESENCE claims ("this option is missing / this screen was
 * shown out of base"), because a violation asserted from a partial scan is as
 * unsound as a pass asserted from one.
 *
 * ---------------------------------------------------------------------------
 * D8 — ONE DECLARATIVE POPULATION GRAMMAR.
 *
 * Four predicates used to attest their own universes: `route@1` published
 * `routeRowsConsidered`, `screen-conditional-presence@1` published
 * `occurrencesScanned`, `screen-universal@1` published `eligibleSessions`, and
 * `control-on-every-screen@1` published `capturesScanned`. Nothing rebuilt any
 * of them, so each of those numbers was the claimant's word. The defence that a
 * second implementation might merely disagree is not a closure: DISAGREEMENT
 * MUST FAIL CLOSED, which is exactly what a digest mismatch does here.
 *
 * A predicate no longer describes its population in prose. It DECLARES A FILTER
 * in a closed grammar, and this module — the scope authority — produces the
 * membership root:
 *
 *   claimKind                 members                       filter grammar
 *   ------------------------- ----------------------------- --------------------
 *   scoped-inventory          artifact#seq (captures)       screen, device, requires
 *   scoped-capture-set        artifact#seq                  screen(s), device, requires
 *   scoped-absence            artifact#seq                  screen(s), device, requires
 *   scoped-copy-search        artifact#seq                  screen(s)
 *   scoped-occurrence-set     artifact#seq                  screen, excludeBackNav
 *   scoped-eligible-sessions  artifact                      documentEligibility
 *   scoped-route-edges        artifact#from>to (edges)      question, identity, mode,
 *                                                           codes, labels, domainCodes
 *
 * `scoped-route-edges` is rebuilt with `proof.mjs`'s `route-edge` projection as
 * its admission oracle — authority-owned code that never saw the route table's
 * intermediate state. `scoped-eligible-sessions` is rebuilt from the DOCUMENT
 * MODEL (signed contract items), never from the survey's own progress control
 * (D9).
 *
 * A3b — ASYNC METHODS.
 *
 * index(), edges(), population(), attest() are now async because the store's
 * read() is async. The fresh:true sweeps mean the engine streams each session
 * up to ~3 times (~340 MB total R2 reads for the v100 run, all transient-
 * bounded). That bandwidth cost is acceptable — do NOT cache-defeat the fresh
 * semantics to save it. The "fresh" property is the entire point: re-verification
 * that reuses cached bytes is not re-verification.
 */

import { digestOf, inventorySetOf, PROOFS, controlCensusOfEvidence } from './proof.mjs';
import { REASON, PROOF_KIND } from './vocab.mjs';
import { EVIDENCE_CLASS } from './vocab.mjs';
import { captureSpineState, isSessionCandidate } from './evidence-store.mjs';
import { normLine } from './normalize.mjs';

export const SCOPE_ATTEST_VERSION = '2.0.0';

/** Scope kinds whose population this module can rebuild from the artifacts. */
export const ATTESTABLE_SCOPES = new Set([
  'scoped-inventory',
  'scoped-capture-set',
  'scoped-absence',
  'scoped-copy-search',
  // D8
  'scoped-occurrence-set',
  'scoped-eligible-sessions',
  'scoped-route-edges',
]);

const DESKTOP_MIN_WIDTH = 1000;
const BACKNAV_RE = /^(back hop|arrived back|mutated |reached the screen after)/i;
const MUTATION_RE = /^mutated\s+([A-Z0-9]+)\s+to\s+(\[.*\])\s*$/i;

/**
 * The complete control census of one capture. D10: a claim that a screen shows
 * something it must not has to cite the WHOLE census, because the extra control
 * may be a text input or a grid rather than an option. There is ONE spelling of
 * it, in `proof.mjs`, and every consumer imports that one.
 */
export const controlCensusOf = controlCensusOfEvidence;

export class ScopeAttestor {
  constructor(store, { documentModel = null } = {}) {
    this.store = store;
    this.documentModel = documentModel;
    this._index = null;
    this._edges = null;
  }

  /**
   * Independent re-read of every signed session artifact.
   *
   * A3b: async — the store's read() is async. Under the async source, only
   * session candidates are fetched (isSessionCandidate pre-filter). The fresh
   * re-read means each session is streamed once per index() call.
   */
  async index() {
    if (this._index) return this._index;
    /** @type {Map<string, Array<object>>} */
    const byScreen = new Map();
    const all = [];
    /** @type {Map<string, {artifact:string, screens:string[]}>} */
    const sessions = new Map();
    for (const name of this.store.listArtifacts()) {
      if (!/\.json$/i.test(name)) continue;
      // A3b — pre-filter: only fetch session candidates, same rule as loadSessions.
      if (!isSessionCandidate(name)) continue;
      const rec = await this.store.read(name, { fresh: true });
      if (!rec.ok || !rec.data) continue;
      if (rec.evidenceClass !== EVIDENCE_CLASS.PRIMARY_SESSION) continue;
      if (!captureSpineState(rec.data).wellFormed) continue;
      const screens = [];
      for (const e of rec.data.evidence) {
        const vp = e.viewport || null;
        const row = {
          artifact: name,
          seq: e.seq,
          screen: e.screen_id,
          device: vp && vp.width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile',
          hasInventory: (e.option_inventory || []).length > 0,
          hasGrid: Array.isArray(e.grid) && e.grid.length > 0 && Array.isArray(e.grid[0] && e.grid[0].rows) && e.grid[0].rows.length > 0,
          hasGridHeaders: Array.isArray(e.grid) && e.grid.length > 0 && Array.isArray(e.grid[0] && e.grid[0].headers),
          hasTextInput: Array.isArray(e.text_inputs) && e.text_inputs.length > 0,
          isBackNav: !!(e.action_taken && BACKNAV_RE.test(String(e.action_taken))),
          inventorySet: inventorySetOf(e),
          controlCensus: controlCensusOf(e),
        };
        if (!byScreen.has(e.screen_id)) byScreen.set(e.screen_id, []);
        byScreen.get(e.screen_id).push(row);
        all.push(row);
        screens.push(e.screen_id);
      }
      sessions.set(name, { artifact: name, screens });
    }
    this._index = { byScreen, all, sessions, screens: [...byScreen.keys()].sort() };
    return this._index;
  }

  // -------------------------------------------------------------------------
  // D8 — independent route-edge reconstruction
  // -------------------------------------------------------------------------

  /**
   * Rebuild every admissible forward edge from the signed artifacts, using the
   * `route-edge` proof projection as the admission oracle. The route table had
   * no part in this: the candidate claims are read straight out of the artifact
   * and each one must survive `PROOFS['route-edge']`.
   *
   * A3b: async — the store's read() is async.
   */
  async edges() {
    if (this._edges) return this._edges;
    const out = [];
    const proof = PROOFS[PROOF_KIND.ROUTE_EDGE];
    for (const name of this.store.listArtifacts()) {
      if (!/\.json$/i.test(name)) continue;
      // A3b — pre-filter: only fetch session candidates.
      if (!isSessionCandidate(name)) continue;
      const rec = await this.store.read(name, { fresh: true });
      if (!rec.ok || !rec.data) continue;
      if (rec.evidenceClass !== EVIDENCE_CLASS.PRIMARY_SESSION) continue;
      const data = rec.data;
      if (!captureSpineState(data).wellFormed) continue;
      const ev = data.evidence;
      const traceBySeq = new Map();
      const dup = new Set();
      for (const t of data.trace || []) {
        if (traceBySeq.has(t.seq)) dup.add(t.seq);
        traceBySeq.set(t.seq, t);
      }
      for (const s of dup) traceBySeq.delete(s);

      for (let i = 0; i < ev.length - 1; i += 1) {
        const from = ev[i];
        const to = ev[i + 1];
        const inv = from.option_inventory || [];
        const buttons = from.button_options || [];
        const codeOf = (label) => {
          const hit = [...inv, ...buttons].find((o) => normLine(o.label ?? o.text ?? '') === label);
          return hit && hit.value !== undefined && hit.value !== null ? String(hit.value) : null;
        };

        const candidates = [];
        const mut = MUTATION_RE.exec(String(from.action_taken || '').trim());
        if (mut) {
          let labels = [];
          try { labels = JSON.parse(mut[2]).map(normLine); } catch { labels = []; }
          candidates.push({ labels, source: 'post-mutation' });
        }
        const t = traceBySeq.get(from.seq) || null;
        if (t && t.applied) {
          const labels = (t.applied.clicked || []).filter((c) => c && c.label !== undefined).map((c) => normLine(c.label));
          candidates.push({ labels, source: 'forward-answer' });
        }

        for (const cand of candidates) {
          const claim = {
            fromSeq: from.seq,
            toSeq: to.seq,
            fromScreen: from.screen_id,
            toScreen: to.screen_id,
            answerLabels: cand.labels,
            answerCodes: cand.labels.map(codeOf),
            source: cand.source,
          };
          let r;
          try { r = proof(data, claim); } catch { r = { ok: false }; }
          if (!r.ok) continue;
          out.push({
            artifact: name,
            fromSeq: from.seq,
            toSeq: to.seq,
            question: from.screen_id,
            destination: to.screen_id,
            labels: cand.labels,
            codes: claim.answerCodes,
            source: cand.source,
          });
        }
      }
    }
    this._edges = out;
    return out;
  }

  // -------------------------------------------------------------------------
  // the declarative population grammar
  // -------------------------------------------------------------------------

  /**
   * The population a scope claim covers, rebuilt independently. The claim
   * declares WHICH members it looked at only through a reproducible filter —
   * never through a hand-written count.
   *
   * A3b: async — calls this.index() and this.edges() which are async.
   *
   * @returns {Promise<{ok:true, members:string[], rows:object[]}|{ok:false, reason:string, detail:any}>}
   */
  async population(scope) {
    const f = scope.filter || {};
    switch (scope.claimKind) {
      case 'scoped-eligible-sessions': return await this._eligibleSessions(scope);
      case 'scoped-route-edges': return await this._routeEdgePopulation(scope);
      case 'scoped-occurrence-set': {
        const idx = await this.index();
        const rows = (idx.byScreen.get(scope.screen) || []).filter((r) => (f.excludeBackNav ? !r.isBackNav : true));
        return { ok: true, members: rows.map((r) => `${r.artifact}#${r.seq}`).sort(), rows };
      }
      default: {
        const idx = await this.index();
        const screens = Array.isArray(scope.screens) ? scope.screens
          : (scope.screen && scope.screen !== '(any)' ? [scope.screen] : null);
        const base = screens ? screens.flatMap((s) => idx.byScreen.get(s) || []) : idx.all;
        const rows = base.filter((r) => {
          if (f.device && f.device !== 'any' && r.device !== f.device) return false;
          if (f.requires === 'inventory' && !r.hasInventory) return false;
          if (f.requires === 'grid' && !r.hasGrid) return false;
          if (f.requires === 'grid-headers' && !r.hasGridHeaders) return false;
          if (f.requires === 'text-input' && !r.hasTextInput) return false;
          return true;
        });
        return { ok: true, members: rows.map((r) => `${r.artifact}#${r.seq}`).sort(), rows };
      }
    }
  }

  /**
   * D9 — who was eligible, according to the DOCUMENT. A respondent who reached a
   * screen the signed contract names as a terminal COMPLETION screen, without
   * reaching one it names as a screen-out, completed the survey; that is a fact
   * about the walk and the document, and the survey's own progress control has
   * no part in it.
   *
   * A3b: async.
   */
  async _eligibleSessions(scope) {
    const f = scope.filter || {};
    if (f.documentEligibility === 'any-recorded-session') {
      // "the FIRST screen shown to every respondent" is a claim about every
      // session that exists, not about who completed. No document model is
      // needed, but the population is still rebuilt rather than counted by the
      // claimant.
      const idx = await this.index();
      const members = [...idx.sessions.keys()].sort();
      return { ok: true, members, rows: members.map((a) => idx.sessions.get(a)) };
    }
    const dm = this.documentModel;
    if (!dm || !dm.available) {
      return {
        ok: false, reason: REASON.ELIGIBILITY_NOT_DOCUMENT_DERIVED,
        detail: { why: dm ? dm.why : 'no document model was supplied to the scope authority' },
      };
    }
    const idx = await this.index();
    const completion = new Set(dm.completionScreens);
    const screenout = new Set(dm.screenoutScreens);
    const members = [];
    const rows = [];
    for (const [artifact, s] of idx.sessions) {
      const reached = new Set(s.screens);
      const completed = [...completion].some((c) => reached.has(c));
      const wasScreenedOut = [...screenout].some((c) => reached.has(c));
      if (completed && !wasScreenedOut) { members.push(artifact); rows.push({ artifact, screens: s.screens }); }
    }
    return { ok: true, members: members.sort(), rows };
  }

  /** D8 — the edges a routing rule considered, rebuilt from the artifacts. A3b: async. */
  async _routeEdgePopulation(scope) {
    const f = scope.filter || {};
    if (!f.question) return { ok: false, reason: REASON.POPULATION_NOT_RECONSTRUCTIBLE, detail: 'the route scope declares no question' };
    const mode = f.mode === 'exclude' ? 'exclude' : 'include';
    const identity = f.identity === 'label' ? 'label' : 'code';
    const codes = (f.codes || []).map(String);
    const labels = (f.labels || []).map(normLine);
    if (mode === 'exclude' && !Array.isArray(f.domainCodes)) {
      return { ok: false, reason: REASON.POPULATION_NOT_RECONSTRUCTIBLE, detail: 'an exclusion rule declares no sealed answer domain, so its complement is not a closed set' };
    }
    const complement = mode === 'exclude' ? f.domainCodes.map(String).filter((c) => !codes.includes(c)) : null;

    const allEdges = await this.edges();
    const rows = allEdges.filter((e) => {
      if (e.question !== f.question) return false;
      if (mode === 'include') {
        if (identity === 'code') return codes.length > 0 && e.codes.some((c) => c !== null && codes.includes(String(c)));
        return labels.length > 0 && e.labels.some((l) => labels.includes(l));
      }
      return e.codes.length > 0
        && e.codes.every((c) => c !== null)
        && e.codes.some((c) => complement.includes(String(c)))
        && !e.codes.some((c) => codes.includes(String(c)));
    });
    return { ok: true, members: rows.map((e) => `${e.artifact}#${e.fromSeq}>${e.toSeq}`).sort(), rows };
  }

  /**
   * A3b: async.
   * @param {object} scope the predicate's scope claim
   * @returns {Promise<{ok:boolean, reason?:string, detail?:any}>}
   */
  async attest(scope) {
    if (!scope || !scope.claimKind) {
      return { ok: false, reason: REASON.SCOPE_INCOMPLETE_FOR_CLAIM, detail: 'no scope claim supplied' };
    }
    if (!ATTESTABLE_SCOPES.has(scope.claimKind)) {
      return { ok: false, reason: REASON.SCOPE_INCOMPLETE_FOR_CLAIM, detail: `claimKind ${scope.claimKind} declares no attestable population` };
    }
    const pop = await this.population(scope);
    if (!pop.ok) return { ok: false, reason: pop.reason, detail: pop.detail };
    const contentDigest = scope.claimKind === 'scoped-inventory'
      ? (rows) => digestOf([...new Set(rows.flatMap((r) => r.inventorySet))].sort())
      : () => null;
    return this._compare(scope, pop, contentDigest);
  }

  _compare(scope, pop, contentDigest) {
    const actualMembers = pop.members;
    const actualDigest = digestOf(actualMembers);
    if (!scope.membersDigest) {
      return { ok: false, reason: REASON.SCOPE_INCOMPLETE_FOR_CLAIM, detail: 'the scope declares no member digest, so its completeness cannot be checked' };
    }
    if (scope.membersDigest !== actualDigest) {
      return {
        ok: false, reason: REASON.SCOPE_DIGEST_MISMATCH,
        detail: {
          claimKind: scope.claimKind,
          declaredMembers: scope.memberCount ?? null,
          independentlyCounted: actualMembers.length,
          note: 'the enumerated population is not the population the scope authority rebuilds from the signed artifacts',
        },
      };
    }
    if (scope.memberCount !== undefined && scope.memberCount !== actualMembers.length) {
      return { ok: false, reason: REASON.SCOPE_DIGEST_MISMATCH, detail: { declared: scope.memberCount, independentlyCounted: actualMembers.length } };
    }
    const cd = contentDigest(pop.rows);
    if (cd !== null && scope.contentDigest !== undefined && scope.contentDigest !== cd) {
      return { ok: false, reason: REASON.SCOPE_DIGEST_MISMATCH, detail: { declaredContentDigest: scope.contentDigest, independentDigest: cd } };
    }
    return { ok: true, independentlyCounted: actualMembers.length };
  }
}

/**
 * Build the declaration a predicate must attach to a scope claim.
 * `members` is the list of member ids the predicate actually enumerated, in the
 * grammar of its `claimKind`.
 */
export function declareScope(base, members, { contentSet = null } = {}) {
  const list = [...members].sort();
  return {
    ...base,
    memberCount: list.length,
    membersDigest: digestOf(list),
    ...(contentSet ? { contentDigest: digestOf([...new Set(contentSet)].sort()) } : {}),
  };
}

/** Member ids for a capture-shaped population. */
export const captureMembers = (captures) => captures.map((c) => `${c.artifact}#${c.seq}`);

export { normLine };
