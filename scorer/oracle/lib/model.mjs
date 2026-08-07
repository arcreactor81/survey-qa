// model.mjs — the internal obligation representation (pure data helpers).
//
// An Obligation is a plain object:
//   { id, category, type, sourceRef, requirement, payload, contentHash }
// plus reachability fields attached after the walk:
//   { reachable, witnessPathIds }
//
// contentHash covers ONLY the semantic content (category, type, sourceRef,
// requirement, payload) — never reachability or witness paths — so that
// clean-vs-flawed diffs isolate manifest deltas from routing side effects.
//
// ID scheme (stable, deterministic, derived from source LOCATION + semantic
// signature, never from array indices):
//   full id      = "<surveyId>/<localId>"
//   question     = question:<qid>
//   rule         = rule:<qid>:instruction | rule:<qid>:range
//                | rule:<qid>:exclusive:<optionCode>
//                | rule:<qid>:carry-forward | rule:<qid>:piping:<token>
//                | rule:<qid>:randomize-order | rule:<qid>:randomize-anchor
//                | rule:<qid>:alloc-sum | rule:<qid>:alloc-bounds
//                | rule:<qid>:alloc-row:<rowCode>
//                | rule:loop:<loopId> | rule:calc:<computedId>
//   branch       = branch:<qid>:goto:<target>[#n]:taken
//                | branch:<qid>:terminate:<termId>[#n]:taken
//                | branch:<qid>:default
//   terminal     = terminal:terminate:<termId> | terminal:complete
// "#n" disambiguates the (corpus-unused) case of two rules on one question
// with the same outcome; a rule is identified by its OUTCOME signature, so a
// re-pointed goto is a removed+added obligation, while a re-thresholded
// condition is the same obligation with a different contentHash.
import { stableStringify, sha256OfString } from "./corpus.mjs";

export const CATEGORY_ORDER = { question: 0, rule: 1, branch: 2, terminal: 3 };

export function contentHash(ob) {
  return sha256OfString(
    stableStringify({
      category: ob.category,
      type: ob.type,
      sourceRef: ob.sourceRef,
      requirement: ob.requirement,
      payload: ob.payload,
    })
  ).slice(0, 12);
}

export function makeObligation({ surveyId, localId, category, type, sourceRef, requirement, payload }) {
  const ob = {
    id: `${surveyId}/${localId}`,
    localId,
    category,
    type,
    sourceRef,
    requirement,
    payload,
  };
  ob.contentHash = contentHash(ob);
  return ob;
}

function ruleOutcomeSig(rule) {
  return rule.terminate
    ? { kind: "terminate", key: String(rule.terminate) }
    : { kind: "goto", key: String(rule.goto) };
}

/** Local id of the "rule fired" branch edge for rules[idx] on question qid. */
export function takenEdgeLocalId(qid, rules, idx) {
  const sig = ruleOutcomeSig(rules[idx]);
  let occ = 0;
  for (let j = 0; j < idx; j++) {
    const s = ruleOutcomeSig(rules[j]);
    if (s.kind === sig.kind && s.key === sig.key) occ++;
  }
  return `branch:${qid}:${sig.kind}:${sig.key}${occ ? "#" + (occ + 1) : ""}:taken`;
}

export function defaultEdgeLocalId(qid) {
  return `branch:${qid}:default`;
}

export function sortObligations(list) {
  return [...list].sort((a, b) => {
    const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Diff two obligation maps (id -> obligation) BY CONTENT.
 * Returns { removed, added, modified } — modified entries carry both hashes.
 */
export function diffObligations(aMap, bMap) {
  const removed = [];
  const added = [];
  const modified = [];
  for (const [id, a] of aMap) {
    const b = bMap.get(id);
    if (!b) removed.push(id);
    else if (a.contentHash !== b.contentHash)
      modified.push({ id, fromHash: a.contentHash, toHash: b.contentHash });
  }
  for (const id of bMap.keys()) {
    if (!aMap.has(id)) added.push(id);
  }
  removed.sort();
  added.sort();
  modified.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { removed, added, modified };
}

export function toObligationMap(list) {
  const m = new Map();
  for (const ob of list) m.set(ob.id, ob);
  return m;
}
