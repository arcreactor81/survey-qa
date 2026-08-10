/**
 * judge/lib/facet-vocab.mjs — THE TWO TYPED VOCABULARIES, AND THE MAP BETWEEN THEM.
 *
 * ============================== THE DEFECT ==============================
 *
 * `R-ROUTE-1` in `compile.mjs` gated on one literal string:
 *
 *     if (o.category !== 'branch-outcome') return null;
 *
 * `o.category` is the SIGNED contract item type — `contract-binding.mjs` maps
 * `category <- contract.items[].type`, and `contractItemFromRequirement`
 * (`worker-v2/shared/v2-record.mjs`) sets that to the requirement's `facet`. No v2
 * revision has ever spelled a routing facet `branch-outcome`: the extraction's construct
 * vocabulary spells it `skip-rule` (pass B), `routing` (the fixtures and the producer's own
 * case table) or `terminate`. So the gate never opened, EVERY routing requirement compiled
 * to nothing, and every one of them landed `NO_TYPED_EXPECTATION` -> `not-assessed` in the
 * authoritative column — the column that exists to catch routing defects.
 *
 * ======================= WHY THE FIX IS ON THIS SIDE =======================
 *
 * There were two places to change and only one of them is honest.
 *
 * `requirements[].facet` is INSIDE the sealed digest: `semanticContractBody` hashes the
 * whole revision body, and the revision id IS that digest. Making the producer emit
 * `branch-outcome` would change the id and hash of every revision, and re-sealing a past
 * run changes what that run means. A sealed revision is a trust artifact; you do not edit
 * one to satisfy a consumer's spelling.
 *
 * `contract.items[].type` is a READ-TIME PROJECTION, built by `projectV2ToLegacy` AFTER
 * `authority.mjs` has recomputed the revision digest and verified it. Nothing hashes it.
 * But rewriting the facet THERE would rename the vocabulary for every consumer of the
 * projection — the register, the report, the published record — for the sake of one rule's
 * gate, and it would make the artifact print a word the signed revision does not contain.
 *
 * So neither side imitates the other. Both vocabularies are legitimate:
 * `branch-outcome` is the v1 CHECKLIST's category name (still emitted by
 * `pipeline/judge/selftest/fixtures/*`, still present in the t1-easy replay), and
 * `skip-rule` / `routing` / `terminate` are the v2 EXTRACTION's construct names. They are
 * unaligned, not in conflict. This module is the explicit, tested, documented alignment,
 * and it lives where the JUDGE reads.
 *
 * ==================== WHERE THE EQUIVALENCE CLASS COMES FROM ====================
 *
 * NOT invented here. `worker-v2/src/extract/expand.ts#FACET_TO_CASE_KIND` is the producer's
 * own classification — it decides which requirements get a `route` execution case sealed
 * into the revision at all — and it already lists exactly these four facets as `route`.
 * `worker-v2/tools/tests/d26-routing-facet.test.mjs` asserts SET EQUALITY between that
 * table's route class and this set, so the two halves cannot drift apart in silence. If the
 * producer ever widens its route class (`navigation` and `order` appear in the pass-A prompt
 * vocabulary and are NOT in it today), that test goes red and the widening becomes a
 * decision instead of an accident.
 *
 * Deliberately NOT wider than the producer. A facet the producer expands as
 * `rendered-state` has no sealed route case; compiling a route expectation for it would
 * judge a routing claim the run was never driven to exercise.
 */

export const FACET_VOCAB_VERSION = '1.0.0';

/**
 * Every signed contract item type that denotes a ROUTING commitment.
 *
 * `branch-outcome` stays in the set: it is the v1 checklist's spelling, it is what the
 * judge selftest fixtures and the t1-easy replay carry, and dropping it would silently stop
 * judging every v1 routing obligation while "fixing" v2.
 */
export const ROUTE_FACETS = Object.freeze([
  'branch-outcome',
  'routing',
  'skip-rule',
  'terminate',
]);

const ROUTE_SET = new Set(ROUTE_FACETS);

/**
 * Does this SIGNED item type denote a routing requirement?
 *
 * FAILS CLOSED, verbatim as the literal comparison did. `null` is what
 * `contract-binding.mjs` writes when the signature does not carry a type, and an unbound
 * type must not compile to a typed expectation — that is the D3 guarantee, and it is
 * preserved here by construction: `null`, `undefined` and any non-string are refused before
 * the set is consulted.
 *
 * No normalisation beyond `trim()`. Case-folding or de-hyphenating would let a facet the
 * document never wrote ("Branch Outcome", "branch_outcome") open the gate, and inventing
 * membership is the failure this module is the fix for.
 *
 * @param {unknown} type the signed `contract.items[].type`
 * @returns {boolean}
 */
export function isRouteFacet(type) {
  if (typeof type !== 'string') return false;
  return ROUTE_SET.has(type.trim());
}
