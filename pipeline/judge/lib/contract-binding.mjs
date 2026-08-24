/**
 * judge/lib/contract-binding.mjs — D3 + D5. WHAT THE COMPILER IS ALLOWED TO SEE.
 *
 * THE HOLE THIS CLOSES (D3).
 *
 * `authority.mjs` binds three things per obligation: the id, the requirement
 * text and the source quote. The compiler consumes a FOURTH: `category`. Rule
 * `R-ROUTE-1` refuses to compile anything whose category is not
 * `branch-outcome`, so flipping one unsigned word in the local checklist decides
 * whether a routing rule is judged AT ALL — and the RunRecord's signature stays
 * perfectly valid, the authority stays `verified: true`, and the JudgementRecord
 * still binds. An attacker (or a careless edit) could silence any branch-outcome
 * obligation without leaving a mark on any integrity check.
 *
 * THE FIX. The compiler no longer sees the checklist obligation at all. It sees
 * a BOUND PROJECTION built here, whose every field is taken from the SIGNED
 * ContractRevision item:
 *
 *     id         <- item.itemId
 *     statement  <- item.requirement
 *     doc_quote  <- item.sourceAnchor.quote
 *     category   <- item.type            (the signed TYPED FACET)
 *
 * The projection is frozen and carries NOTHING ELSE, so a future rule that
 * reaches for `o.stimulus` or `o.confidence` gets `undefined` rather than an
 * unsigned value — the structural half of the guarantee. `COMPILED_FROM` lists
 * the fields a rule may read, and `assertProjectionShape` is exported so the
 * selftest can assert that the projection and that list stay in step.
 *
 * A field the signature does not carry is not silently replaced by the local
 * one: it is `null`, and the obligation is marked unbound. A rule keyed on a
 * null field cannot fire, so an unbound field FAILS CLOSED into
 * `NO_TYPED_EXPECTATION` instead of quietly compiling from unsigned input.
 *
 * WITHOUT a verified authority the run is already diagnostic-only and
 * unpublishable, so the projection falls back to the local values — but it says
 * so (`fieldsBound: false`), every consumed field is listed as unbound, and the
 * engine surfaces that on each result. Nothing that reaches a reader can present
 * an unbound compile as a bound one.
 *
 * ---------------------------------------------------------------------------
 * THE AMBIGUITY SET (D5).
 *
 * `authority.mjs` hard-codes `ambiguitiesSigned = false` and says out loud that
 * the ambiguity set comes from the unsigned checklist. That is honest, but two
 * things followed from it that are not:
 *
 *   1. `contractReviewed` reads `authority.ambiguitiesSigned`, so it could never
 *      be true — certification was unreachable by construction (D7);
 *   2. nothing required a signed ambiguity set before PUBLISHING, so an unsigned
 *      input still decided which verdicts were withheld and which were released.
 *
 * `bindAmbiguities` makes signed-ness a CHECKED FACT rather than a constant. The
 * carrier is the signed contract's own `assumptions[]` — the one place in the
 * attested RunRecord schema that can hold them — using the canonical token
 *
 *     ambiguity:<id>@<digest of the ambiguity's typed canonical form>
 *
 * The set is BOUND only when the tokens and the local ambiguities correspond
 * exactly, both ways: a local ambiguity with no token is unsigned, and a token
 * with no local ambiguity means the checklist DROPPED an ambiguity that the
 * signature says exists — which is the more dangerous direction, because a
 * dropped ambiguity releases a withheld result.
 *
 * The digest covers the typed locus as well as the readings, so an extraction
 * cannot sign "these two readings" and then hand the judge a different, narrower
 * `locus.fields` to suppress with.
 */

import { jcsHash } from '../../../scorer/src/lib/canonical.mjs';
import { REASON } from './vocab.mjs';
import { normLine } from './normalize.mjs';

export const CONTRACT_BINDING_VERSION = '1.0.0';

/**
 * The obligation fields the compiler is allowed to read. This list is part of
 * the compiler contract: adding a field to a rule without adding it here (and
 * finding a signed carrier for it) reintroduces D3.
 */
export const COMPILED_FROM = Object.freeze(['id', 'statement', 'doc_quote', 'category', 'typedCases']);

/** The signed carrier of each consumed field, for the record. */
export const SIGNED_CARRIER = Object.freeze({
  id: 'contract.items[].itemId',
  statement: 'contract.items[].requirement',
  doc_quote: 'contract.items[].sourceAnchor.quote',
  category: 'contract.items[].type',
  typedCases: 'revision.facetInstances[] (signed inside the revision digest)',
});

/**
 * @param {object} projection
 * @returns {string[]} keys present on the projection that no rule may read
 */
export function assertProjectionShape(projection) {
  const allowed = new Set([...COMPILED_FROM, 'fieldsBound', 'unboundFields', 'boundBy']);
  return Object.keys(projection).filter((k) => !allowed.has(k));
}

function freezeProjection(o) {
  return Object.freeze({
    id: o.id,
    statement: o.statement,
    doc_quote: o.doc_quote,
    category: o.category,
    typedCases: o.typedCases ?? null,
    fieldsBound: o.fieldsBound,
    unboundFields: Object.freeze(o.unboundFields),
    boundBy: o.boundBy,
  });
}

/**
 * Build the bound projection of every obligation the run will compile.
 *
 * @param {object} checklist
 * @param {object|null} authority the EvidenceAuthority (only a VERIFIED one may
 *   bind; an unverified one is treated as absent)
 * @returns {{byId:Map<string,object>, list:object[], allBound:boolean, findings:object[]}}
 */
export function bindObligations(checklist, authority) {
  const findings = [];
  const items = authority && authority.verified && authority.contractItems instanceof Map
    ? authority.contractItems
    : null;

  // Track 1 — typed FacetInstances from the sealed revision.
  const facetInstances = authority && authority.contractFacetInstances instanceof Map
    ? authority.contractFacetInstances
    : null;

  const list = [];
  for (const o of checklist.obligations || []) {
    if (!items) {
      list.push(freezeProjection({
        id: o.id,
        statement: o.statement ?? null,
        doc_quote: o.doc_quote ?? null,
        category: o.category ?? null,
        typedCases: null,
        fieldsBound: false,
        unboundFields: ['statement', 'doc_quote', 'category', 'typedCases'],
        boundBy: 'local-checklist(unsigned)',
      }));
      continue;
    }
    const it = items.get(o.id);
    if (!it) {
      // Cannot happen while `verified` holds (checklistBound requires a 1:1
      // correspondence), but a projection is built defensively rather than
      // throwing: the row must reach the report as unbound, not vanish.
      findings.push({ code: REASON.OBLIGATION_FIELDS_UNBOUND, obligationId: o.id, detail: `${o.id} has no signed ContractRevision item` });
      list.push(freezeProjection({
        id: o.id, statement: null, doc_quote: null, category: null,
        typedCases: null,
        fieldsBound: false, unboundFields: [...COMPILED_FROM].filter((f) => f !== 'id'),
        boundBy: 'none',
      }));
      continue;
    }
    const unbound = [];
    const statement = typeof it.requirement === 'string' ? it.requirement : (unbound.push('statement'), null);
    const quote = it.sourceAnchor && typeof it.sourceAnchor.quote === 'string'
      ? it.sourceAnchor.quote
      : (unbound.push('doc_quote'), null);
    const category = typeof it.type === 'string' && it.type.length ? it.type : (unbound.push('category'), null);

    // Track 1: attach sealed FacetInstance rows, frozen.
    // `typedCases` is not listed as unbound when absent, because absence is
    // legitimate: many requirements expand to zero floor cases (e.g. rendered-state
    // prose-only). Listing it as unbound would make `fieldsBound` false for every
    // obligation that simply has no typed case, which would fail closed the entire
    // compilation. Instead, `typedCases: null` means "no typed payload available"
    // and the compiler falls through to prose rules — the pre-existing behaviour.
    const cases = facetInstances ? (facetInstances.get(o.id) || null) : null;
    const typedCases = cases ? Object.freeze(cases.map((c) => Object.freeze({ ...c }))) : null;

    if (unbound.length) {
      findings.push({
        code: REASON.OBLIGATION_FIELDS_UNBOUND, obligationId: o.id,
        detail: `${o.id}: the signed contract item carries no ${unbound.join(', ')}; those fields compile to null (fail closed)`,
      });
    }
    list.push(freezeProjection({
      id: o.id, statement, doc_quote: quote, category,
      typedCases,
      fieldsBound: unbound.length === 0,
      unboundFields: unbound,
      boundBy: 'signed-contract-revision',
    }));
  }

  return {
    version: CONTRACT_BINDING_VERSION,
    byId: new Map(list.map((p) => [p.id, p])),
    list,
    allBound: !!items && list.every((p) => p.fieldsBound),
    signedSource: !!items,
    findings,
  };
}

// ---------------------------------------------------------------------------
// ambiguities
// ---------------------------------------------------------------------------

const TOKEN_RE = /^ambiguity:([^@\s]+)@(sha256:[0-9a-f]{64})$/;

/**
 * The typed canonical form of one ambiguity. The DIGEST covers the readings AND
 * the declared typed locus, so a declaration cannot be signed in one shape and
 * consumed in another.
 */
export function ambiguityCanonicalForm(amb) {
  const locus = amb.locus && typeof amb.locus === 'object' ? amb.locus : null;
  return {
    id: String(amb.id),
    affects: [...(amb.affects || [])].map(String).sort(),
    reading_a: normLine(amb.reading_a || ''),
    reading_b: normLine(amb.reading_b || ''),
    locus: locus
      ? {
        fields: [...new Set((locus.fields || []).map(String))].sort(),
        screens: [...new Set((locus.screens || []).map(String))].sort(),
        codes: [...new Set((locus.codes || []).map(String))].sort(),
      }
      : null,
  };
}

/** The token an extraction must place in `contract.assumptions[]` to sign one. */
export function ambiguityToken(amb) {
  return `ambiguity:${String(amb.id)}@${jcsHash(ambiguityCanonicalForm(amb))}`;
}

/**
 * Is the run's ambiguity set covered by the signature?
 *
 * @returns {{signed:boolean, perAmbiguity:Map<string,boolean>, findings:object[], detail:object}}
 */
export function bindAmbiguities(checklist, authority) {
  const local = checklist.ambiguities || [];
  const findings = [];
  const perAmbiguity = new Map();

  const assumptions = authority && authority.verified && Array.isArray(authority.contractAssumptions)
    ? authority.contractAssumptions
    : null;
  if (!assumptions) {
    for (const a of local) perAmbiguity.set(String(a.id), false);
    findings.push({
      code: REASON.AMBIGUITY_SET_UNSIGNED,
      detail: local.length
        ? `${local.length} extraction ambiguities come from the unsigned checklist; no verified signature covers them`
        : 'no verified signature covers the (empty) ambiguity set, so its emptiness is not an attested fact',
    });
    return { signed: false, perAmbiguity, findings, detail: { localAmbiguities: local.length, signedTokens: 0 } };
  }

  const tokens = new Map();
  for (const s of assumptions) {
    const m = TOKEN_RE.exec(String(s).trim());
    if (m) tokens.set(m[1], m[2]);
  }

  for (const a of local) {
    const id = String(a.id);
    const want = jcsHash(ambiguityCanonicalForm(a));
    const got = tokens.get(id) || null;
    const ok = got === want;
    perAmbiguity.set(id, ok);
    if (!ok) {
      findings.push({
        code: REASON.AMBIGUITY_SET_UNSIGNED, ambiguityId: id,
        detail: got === null
          ? `${id} is not covered by any signed assumption token`
          : `${id}'s typed form differs from the signed token (signed ${got}, local ${want})`,
      });
    }
  }
  // A signed token with no local ambiguity is the DANGEROUS direction: the
  // checklist dropped an ambiguity that the signature says exists, and a dropped
  // ambiguity releases a result that should have been withheld.
  const localIds = new Set(local.map((a) => String(a.id)));
  for (const id of tokens.keys()) {
    if (!localIds.has(id)) {
      findings.push({
        code: REASON.AMBIGUITY_SET_UNSIGNED, ambiguityId: id,
        detail: `${id} is signed into the contract but absent from the checklist being judged — a dropped ambiguity releases withheld results`,
      });
      perAmbiguity.set(id, false);
    }
  }

  const signed = findings.length === 0;
  return {
    signed,
    perAmbiguity,
    findings,
    detail: { localAmbiguities: local.length, signedTokens: tokens.size },
  };
}
