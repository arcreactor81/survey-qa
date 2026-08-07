/**
 * judge/lib/ambiguity.mjs — AMBIGUITY PRECEDENCE, DEPENDENCY-AWARE.
 *
 * The first run's one penalized false positive happened because the extractor
 * had ALREADY recorded `AMB-B2A-02` against `OBL-B2A-03` and the judging step
 * failed the obligation flat anyway. So precedence is not a heuristic and not a
 * severity discount: it is a gate that runs BEFORE a verdict may be an
 * assertion.
 *
 * D4 — TWO THINGS WERE WRONG WITH THE OLD GATE.
 *
 * 1. IT WAS CALLER-DISABLEABLE. `precedenceFor(id, index, policy)` read
 *    `policy.blockFail` / `policy.blockPass`, and `judgeRun` forwarded whatever
 *    the caller passed. `judgeRun({policy:{}})` turned BOTH halves of the
 *    "hard rule" off — a supposedly non-negotiable gate with a documented
 *    bypass. There is now exactly ONE policy, it is frozen, and no argument
 *    reaches it. Passing one is an error, not an override.
 *
 * 2. IT WAS OBLIGATION-WIDE. Any ambiguity attached to an obligation suppressed
 *    the entire derivation, even when the two readings disagreed about
 *    something the predicate never looks at. AMB-GEN-03 ("which two screens are
 *    the closing screens") suppressed "the welcome screen must not display a
 *    back button" — a predicate that reads exactly one screen, WELCOME, about
 *    which both readings agree.
 *
 * THE RULE (GPT's Tier-1 ruling, accepted; it supersedes the earlier
 * "never suppress the last covering obligation" proposal, which was rejected
 * because redundancy cannot resolve genuine document ambiguity):
 *
 *     An ambiguity suppresses a result ONLY when the competing readings would
 *     alter a field THAT PREDICATE ACTUALLY CONSUMES.
 *
 * So a genuinely outcome-relevant ambiguity withholds even when it is the sole
 * covering obligation, and an irrelevant wording ambiguity suppresses nothing.
 *
 * Deciding relevance deterministically, with no model call:
 *   - each expectation kind declares the typed fields its predicate consumes
 *     (CONSUMED_FIELDS below — this is a property of the code, not of prose);
 *   - each ambiguity is projected into a TYPED LOCUS by extracting the typed
 *     tokens of each reading (screens, codes, controls, quantifiers, quoted
 *     copy, positional and modality words) and taking the SET DIFFERENCE. What
 *     the two readings say identically cannot be what they disagree about;
 *   - the locus is mapped onto expectation fields and intersected with the
 *     consumed set.
 *
 * Fail-closed where it matters: if NEITHER reading yields any typed signal, the
 * locus is `unresolved` and the ambiguity suppresses (we cannot show
 * irrelevance). If both readings yield signals and those signals are identical,
 * the locus is `wording-only` and it suppresses nothing.
 *
 * N4 — A DECLARED LOCUS MAY ONLY ADD, SIGNED OR NOT.
 *
 * The signed branch used to return the extraction's declaration verbatim, on the
 * grounds that the signature covers it. But THE PRODUCER BEING GRADED IS THE
 * SIGNER, so a signature authenticates the declaration without establishing
 * anything about its content: re-signing `locus: { fields: [] }` released every
 * withheld verdict and still published. Three rules replace it, and they hold
 * for signed and unsigned declarations alike:
 *
 *   1. a declaration is UNIONED with the derived locus, never substituted for
 *      it, so it can only ever make an ambiguity MORE relevant;
 *   2. an empty or absent field set FAILS CLOSED — it is the absence of a claim,
 *      not evidence of irrelevance, and it is treated as maximally relevant;
 *   3. the only release path is positive evidence: `wording-only`, which means
 *      both readings carried typed content and that content was identical.
 */

import { normLine } from './normalize.mjs';

export const AMBIGUITY_POLICY_VERSION = '2.0.0';

/**
 * THE ONLY POLICY. Frozen, versioned, and not reachable from any public API.
 */
export const LOCKED_POLICY = Object.freeze({
  policyId: 'ambiguity-precedence/locked@2',
  blockFail: true,
  blockPass: true,
  scope: 'dependency-aware',
});

/** Back-compatible name; it is the same frozen object. */
export const DEFAULT_POLICY = LOCKED_POLICY;

/**
 * The typed fields each predicate actually reads. Adding a field here without
 * the predicate consuming it makes suppression too eager; omitting one the
 * predicate does consume makes it too lax — so this table is part of the
 * predicate contract and moves with it.
 */
export const CONSUMED_FIELDS = Object.freeze({
  // D5 (round 3): `route` also consumes the ORDER of a two-hop consequence
  // ("...then continue to X" — `exp.sequence`, checked by `checkSequence`) and
  // the POLARITY of `mustNotShow` ("...skipping Q2"). Readings that disagree
  // about either of those disagree about the verdict, and the table omitted
  // both, so such an ambiguity used to be declared irrelevant.
  'route': ['question', 'codes', 'labels', 'destination', 'mustNotShow', 'answerDomain', 'sequence', 'order', 'ordering', 'polarity'],
  // "displayed ONLY to X" is a polarity + quantifier claim as much as a code
  // claim: a reading that turns "only" into "at least" changes the verdict
  // without changing any screen or code.
  'screen-conditional-presence': ['screen', 'question', 'codes', 'labels', 'answerDomain', 'polarity', 'quantifier'],
  'screen-universal': ['screen', 'screenScope', 'quantifier', 'eligibilityScope'],
  'first-screen': ['screen', 'screenScope', 'eligibilityScope'],
  'option-present': ['screen', 'codes', 'labels', 'position'],
  'option-set-exact': ['screen', 'labels'],
  'option-order-fixed': ['screen', 'order', 'position'],
  'option-order-randomized': ['screen', 'codes', 'position', 'order'],
  'grid-row-present': ['screen', 'labels'],
  'grid-headers-exact': ['screen', 'labels', 'order'],
  'grid-row-order-randomized': ['screen', 'order'],
  'text-present': ['screen', 'copy'],
  'text-forbidden': ['copy', 'screenScope'],
  'no-instruction-leak': ['copy', 'screenScope'],
  'one-question-per-screen': ['screen', 'screenScope', 'quantifier'],
  'control-on-every-screen': ['control', 'screenScope', 'quantifier'],
  'control-absent-on-screen': ['control', 'screen'],
  'screen-controls-only': ['screen', 'control', 'labels'],
  'selection-mode': ['screen', 'modality'],
  'input-maxlength': ['screen', 'quantity'],
  'input-attribute': ['screen', 'modality'],
  'answer-requirement': ['screen', 'modality', 'quantifier'],
  // "one statement AT A TIME" is a claim about presentation multiplicity, so
  // this predicate's threshold (rows > 1) consumes the modality/quantifier
  // sense directly — AMB-B2A-02's two readings ("a separate screen per
  // statement" vs "one page that swaps content") disagree about exactly that,
  // and therefore about whether a DOM row count is the right observable.
  'mobile-single-statement': ['screen', 'device', 'quantity', 'modality', 'quantifier'],
  'desktop-grid': ['screen', 'device', 'modality'],
});

const SCREEN_TOKEN_RE = /\b(S\d|Q\d+|D\d+)\b/gi;
const SCREEN_WORD = [
  [/welcome screen/i, 'WELCOME'],
  [/screen[-‑\s]?out screen/i, 'SCREENOUT'],
  [/closing screen|thank[-\s]?you screen|completion screen|final screen/i, 'CLOSING'],
];

const KEYWORD_SIGNALS = [
  { field: 'position', re: /\b(bottom|top|last|final|first|position|printed position|anchor(?:ed)?)\b/i },
  { field: 'order', re: /\b(order|rotate|randomi[sz]e[d]?|sequence|reverse)\b/i },
  { field: 'quantifier', re: /\b(every|all|each|any|only|except|excluding|including|some|both)\b/i },
  { field: 'modality', re: /\b(must|may|optional|required|compulsory|mandatory|prevent|allow|single|multiple)\b/i },
  { field: 'control', re: /\b(progress bar|back button|next button|continue button|submit button)\b/i },
  { field: 'device', re: /\b(mobile|phone|desktop|tablet|viewport)\b/i },
  { field: 'quantity', re: /\b(\d+)\s*(characters|statements|rows|options|screens|questions)\b/i },
  // Who is in scope, and in what order things happen: the two things a
  // "does it apply here at all" ambiguity actually turns on.
  { field: 'eligibilityScope', re: /\b(routing|route[sd]?|eligibility|eligible|screening|screened|screen[-\s]?out|qualif\w*|terminat\w*|base)\b/i },
  { field: 'ordering', re: /\b(before|after|precede[sd]?|preceding|prior|subsequent|first|then)\b/i },
  { field: 'polarity', re: /\b(not|never|no|cannot|without|except|regardless|guarantee[sd]?)\b/i },
];

/** Which expectation fields a keyword signal can disturb. */
const SIGNAL_TO_FIELDS = Object.freeze({
  eligibilityScope: ['eligibilityScope', 'screenScope', 'answerDomain'],
  // D5: a disagreement about what happens BEFORE/AFTER what is a disagreement
  // about a two-hop route consequence, so it must reach `sequence` as well.
  ordering: ['order', 'ordering', 'sequence', 'screenScope'],
  polarity: ['modality', 'quantifier', 'polarity', 'mustNotShow'],
  position: ['position', 'order'],
  quantifier: ['quantifier', 'screenScope', 'answerDomain'],
});

/** The typed content of ONE reading. */
function readingSignals(text) {
  const t = normLine(text || '');
  if (!t) return null;
  const sig = { screens: new Set(), codes: new Set(), copy: new Set(), keywords: new Map() };
  for (const m of t.match(SCREEN_TOKEN_RE) || []) sig.screens.add(m.toUpperCase());
  for (const [re, name] of SCREEN_WORD) if (re.test(t)) sig.screens.add(name);
  for (const m of t.match(/\bcodes?\s+\d+/gi) || []) for (const n of m.match(/\d+/g)) sig.codes.add(n);
  for (const m of t.match(/"([^"]+)"/g) || []) sig.copy.add(normLine(m.slice(1, -1)));
  for (const k of KEYWORD_SIGNALS) {
    const hits = t.match(new RegExp(k.re.source, 'gi')) || [];
    if (hits.length) sig.keywords.set(k.field, [...new Set(hits.map((h) => h.toLowerCase()))].sort().join('|'));
  }
  const empty = sig.screens.size === 0 && sig.codes.size === 0 && sig.copy.size === 0 && sig.keywords.size === 0;
  return empty ? null : sig;
}

const setDiff = (a, b) => [...new Set([...[...a].filter((x) => !b.has(x)), ...[...b].filter((x) => !a.has(x))])];

/**
 * Project an ambiguity onto a TYPED LOCUS.
 * @returns {{state:'typed'|'wording-only'|'unresolved', fields:string[], screens:string[], codes:string[], detail:object}}
 */
export function ambiguityLocus(amb, { signed = false } = {}) {
  // N4 — A SIGNATURE IS AUTHENTICATION, NOT EVIDENCE OF IRRELEVANCE.
  //
  // This function used to return a signed declaration VERBATIM, on the reasoning
  // that "the signature covers it, so it may narrow". The party that signs the
  // ambiguity set is the party whose run is being graded, so that reasoning
  // makes the producer the judge of which of its own ambiguities matter: a
  // re-signed `locus: { fields: [] }` released all 11 withheld verdicts
  // (pass 89->98, fail 4->6, inconclusive 15->4) and still published. Round 3
  // caught the TAMPERED version of this — the token digest covers the locus, so
  // an edit after signing unsigns the set — but a producer that simply re-signs
  // the narrowed locus was never refused.
  //
  // The rule is now the same one for signed and unsigned declarations: a
  // declaration may only ADD to the mechanically derived locus. Signing buys
  // authenticity and the certification credit that goes with it (below); it does
  // not buy the power to declare a disagreement immaterial.
  const hasLocusBlock = !!(amb.locus && typeof amb.locus === 'object');
  const declared = hasLocusBlock && Array.isArray(amb.locus.fields) ? amb.locus : null;
  const derived = deriveLocus(amb);
  if (!hasLocusBlock) return derived;

  // An unresolved derivation cannot be repaired by a declaration: no reading
  // carried typed content, so nothing can demonstrate irrelevance.
  if (derived.state === 'unresolved') {
    return { ...derived, source: `derived(unresolved)+${signed ? 'signed' : 'unsigned'}-declaration-ignored`, evidence: 'heuristic-derived' };
  }

  // AN EMPTY OR ABSENT FIELD SET FAILS CLOSED.
  //
  // `fields: []` is not a claim that the readings agree — it is the ABSENCE of a
  // claim about what they disagree about, and releasing a withheld verdict
  // requires positive evidence of irrelevance. Treated as maximally relevant, so
  // the narrowing attack now suppresses MORE than the honest path rather than
  // less. (`wording-only` remains the one release path, and it is positive
  // evidence: both readings carried typed content and it was identical.)
  const declaredFields = declared ? [...new Set(declared.fields.map(String))].filter((f) => f.length) : [];
  if (!declaredFields.length) {
    return {
      state: 'unresolved',
      fields: [],
      screens: [...new Set([...(derived.screens || []), ...((declared && declared.screens) || [])])],
      codes: [...new Set([...(derived.codes || []), ...((declared && declared.codes) || [])])],
      source: `declared-by-extraction(${signed ? 'signed' : 'unsigned'}, EMPTY locus — failed closed)`,
      evidence: 'fail-closed',
      detail: {
        note: 'the declaration names no field the readings disagree about; an empty locus is the absence of a claim, not evidence of irrelevance, so this ambiguity suppresses everything it touches',
        derived: derived.fields,
      },
    };
  }

  const fields = [...new Set([...derived.fields, ...declaredFields])].sort();
  return {
    state: fields.length ? 'typed' : 'wording-only',
    fields,
    screens: [...new Set([...(derived.screens || []), ...(declared.screens || [])])],
    codes: [...new Set([...(derived.codes || []), ...(declared.codes || [])])],
    source: `derived + ${signed ? 'signed' : 'unsigned'}-declaration (union; a declaration may only add)`,
    // The union is a SUPERSET of the declared locus and its screen set, and both
    // relevance rules are monotone in those (a wider locus can only make an
    // ambiguity more relevant). So an irrelevance decision taken on the union
    // implies the same decision on the signed typed locus alone, and a SIGNED
    // declaration still earns the `signed-typed` evidence class that
    // `contractReviewed` requires. An unsigned one does not.
    evidence: signed ? 'signed-typed' : 'heuristic-derived',
    declaredFields,
    derivedFields: derived.fields,
    detail: derived.detail,
  };
}

function deriveLocus(amb) {
  const a = readingSignals(amb.reading_a);
  const b = readingSignals(amb.reading_b);
  if (!a || !b) {
    return {
      state: 'unresolved', fields: [], screens: [], codes: [], source: 'derived', evidence: 'heuristic-derived',
      detail: { note: 'at least one reading carries no typed content, so irrelevance cannot be demonstrated' },
    };
  }
  const fields = new Set();
  const screens = setDiff(a.screens, b.screens);
  const codes = setDiff(a.codes, b.codes);
  const copy = setDiff(a.copy, b.copy);
  if (screens.length) { fields.add('screen'); fields.add('screenScope'); fields.add('destination'); fields.add('question'); }
  if (codes.length) { fields.add('codes'); fields.add('answerDomain'); }
  if (copy.length) { fields.add('copy'); fields.add('labels'); }
  for (const k of KEYWORD_SIGNALS) {
    if ((a.keywords.get(k.field) || null) !== (b.keywords.get(k.field) || null)) {
      fields.add(k.field);
      for (const f of SIGNAL_TO_FIELDS[k.field] || []) fields.add(f);
    }
  }

  return {
    state: fields.size ? 'typed' : 'wording-only',
    fields: [...fields].sort(),
    screens, codes,
    source: 'derived',
    // D5: named honestly. This projection is token-based, not a typed
    // alternatives structure; it is reported per ambiguity and per relevance
    // decision, it blocks `contractReviewed`, and it blocks publication.
    evidence: 'heuristic-derived',
    detail: { copyDiff: copy },
  };
}

/**
 * Does this locus touch a field THIS expectation's predicate consumes?
 * @returns {{relevant:boolean, why:string, overlap:string[]}}
 */
export function locusTouchesExpectation(locus, expectation) {
  if (!expectation) return { relevant: true, why: 'no typed expectation to test relevance against', overlap: [] };
  if (locus.state === 'unresolved') return { relevant: true, why: 'ambiguity locus unresolved — fail closed', overlap: [] };
  if (locus.state === 'wording-only') return { relevant: false, why: 'the two readings carry identical typed content', overlap: [] };
  const consumed = CONSUMED_FIELDS[expectation.kind] || null;
  if (!consumed) return { relevant: true, why: `no consumed-field declaration for ${expectation.kind} — fail closed`, overlap: [] };
  const overlap = locus.fields.filter((f) => consumed.includes(f));
  if (!overlap.length) {
    return { relevant: false, why: `the readings differ about ${locus.fields.join(', ')}, none of which ${expectation.kind} consumes`, overlap: [] };
  }
  // A screen-valued locus is only relevant to a screen-pinned predicate when
  // the disputed screen IS the one the predicate reads. "Which screens are the
  // closing screens" does not touch a rule pinned to WELCOME.
  const screenPinned = overlap.length === 1 && overlap[0] === 'screen' && expectation.screen;
  if (screenPinned && locus.screens.length && !locus.screens.includes(String(expectation.screen).toUpperCase())) {
    return { relevant: false, why: `the disputed screens (${locus.screens.join(', ')}) are not ${expectation.screen}`, overlap: [] };
  }
  return { relevant: true, why: `the readings differ about ${overlap.join(', ')}, which ${expectation.kind} consumes`, overlap };
}

export function buildAmbiguityIndex(checklist, compiled, { binding = null } = {}) {
  /** obligationId -> [{ambiguityId, strength, locus, relevance}] */
  const index = new Map();
  const integrity = [];
  const known = new Set(checklist.obligations.map((o) => o.id));
  const loci = {};
  const suppressed = [];
  const signedOf = (id) => !!(binding && binding.perAmbiguity && binding.perAmbiguity.get(String(id)) === true);

  const add = (oblId, amb, strength, note) => {
    const locus = loci[amb.id];
    const expectation = compiled.has(oblId) ? compiled.get(oblId).expectation : null;
    const relevance = locusTouchesExpectation(locus, expectation);
    const entry = {
      ambiguityId: amb.id, strength, note,
      locus: { state: locus.state, fields: locus.fields, screens: locus.screens, codes: locus.codes, source: locus.source, evidence: locus.evidence || 'heuristic-derived' },
      relevance,
      // D5: an irrelevance decision taken on HEURISTIC evidence is a decision to
      // release a result that would otherwise be withheld, and it is recorded as
      // such on the row rather than disappearing into a boolean.
      evidenceClass: locus.evidence || 'heuristic-derived',
      signed: signedOf(amb.id),
    };
    if (!index.has(oblId)) index.set(oblId, []);
    index.get(oblId).push(entry);
    if (!relevance.relevant) {
      suppressed.push({ obligationId: oblId, ambiguityId: amb.id, why: relevance.why, evidenceClass: entry.evidenceClass, signed: entry.signed });
    }
  };

  for (const amb of checklist.ambiguities || []) {
    loci[amb.id] = ambiguityLocus(amb, { signed: signedOf(amb.id) });
    if (loci[amb.id].state === 'unresolved') {
      integrity.push({
        code: 'AMBIGUITY_LOCUS_UNRESOLVED', ambiguityId: amb.id,
        // N4: an empty DECLARED locus reaches this state too, and it is a
        // different fact from "neither reading carries typed content". Both
        // block every obligation they touch; the finding says which one it was.
        detail: loci[amb.id].detail && loci[amb.id].detail.note
          ? `${loci[amb.id].detail.note}; this ambiguity blocks every obligation it touches`
          : 'the two readings yield no typed content to compare; this ambiguity blocks every obligation it touches',
        evidence: loci[amb.id].evidence || 'heuristic-derived',
      });
    }
    for (const ref of amb.affects || []) {
      if (known.has(ref)) { add(ref, amb, 'full', null); continue; }
      // malformed reference — repair conservatively
      const token = normLine(ref).toUpperCase();
      const matches = [];
      if (/^(S\d|Q\d+|D\d+)$/.test(token)) {
        for (const [oblId, { expectation }] of compiled) {
          if (expectation && expectation.screen === token) matches.push(oblId);
        }
      }
      integrity.push({
        code: 'UNRESOLVED_AMBIGUITY_REFERENCE',
        ambiguityId: amb.id,
        reference: ref,
        repairedTo: matches,
        detail: matches.length
          ? `"${ref}" is not an obligation id; repaired to the ${matches.length} obligation(s) scoped to screen ${token}, applied as fail-blocking only AND still subject to the dependency test`
          : `"${ref}" is not an obligation id and could not be repaired; no obligation is protected by ${amb.id}`,
      });
      // The bare-screen repair no longer sprays suppression across every facet
      // of that screen: each repaired target still has to fail the dependency
      // test before anything is withheld.
      for (const m of matches) add(m, amb, 'fail-blocking-only', `repaired from malformed reference "${ref}"`);
    }
  }

  const heuristicDeclines = suppressed.filter((s) => s.evidenceClass !== 'signed-typed');
  if (heuristicDeclines.length) {
    integrity.push({
      code: 'AMBIGUITY_RELEVANCE_HEURISTIC',
      detail: `${heuristicDeclines.length} suppression(s) were declined as irrelevant on a token-derived locus rather than a signed typed one; the run may not be certified as contract-reviewed on that basis`,
      obligations: [...new Set(heuristicDeclines.map((s) => s.obligationId))].slice(0, 50),
    });
  }

  return {
    version: AMBIGUITY_POLICY_VERSION,
    policy: LOCKED_POLICY,
    index,
    integrity,
    obligationsTouched: index.size,
    loci,
    binding: binding ? { signed: binding.signed, ...(binding.detail || {}) } : { signed: false },
    heuristicDeclines: heuristicDeclines.length,
    suppressionsDeclinedAsIrrelevant: suppressed,
    ambiguities: (checklist.ambiguities || []).map((a) => ({
      id: a.id, affects: a.affects, why: a.why_ambiguous, locus: loci[a.id],
    })),
  };
}

/**
 * @param {string} obligationId
 * @param {object} ambIndex
 * @returns {{blocksFail:boolean, blocksPass:boolean, ambiguities:string[], entries:Array}}
 *
 * NOTE: there is deliberately no policy parameter. The gate is either hard or
 * it is decoration; a caller-supplied policy made it decoration.
 */
export function precedenceFor(obligationId, ambIndex, ...rest) {
  if (rest.length) {
    throw new Error('precedenceFor takes no policy argument: ambiguity precedence is a locked gate (LOCKED_POLICY)');
  }
  const hits = ambIndex.index.get(obligationId) || [];
  const relevant = hits.filter((h) => h.relevance && h.relevance.relevant);
  if (!relevant.length) {
    return {
      blocksFail: false, blocksPass: false, ambiguities: [],
      entries: hits, declinedAsIrrelevant: hits.map((h) => ({ ambiguityId: h.ambiguityId, why: h.relevance ? h.relevance.why : null })),
      policy: LOCKED_POLICY.policyId,
    };
  }
  const full = relevant.filter((h) => h.strength === 'full');
  return {
    blocksFail: LOCKED_POLICY.blockFail,
    blocksPass: LOCKED_POLICY.blockPass && full.length > 0,
    ambiguities: relevant.map((h) => h.ambiguityId),
    entries: relevant,
    declinedAsIrrelevant: hits.filter((h) => !(h.relevance && h.relevance.relevant))
      .map((h) => ({ ambiguityId: h.ambiguityId, why: h.relevance ? h.relevance.why : null })),
    policy: LOCKED_POLICY.policyId,
  };
}
