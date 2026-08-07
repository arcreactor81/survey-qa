// seeded-map.mjs — maps every seeded error to the obligations it violates.
//
// Mechanical attribution, no hand-labeling: for each seeded error we apply
// ONLY that error's JSON patch to the clean manifest, re-derive the
// obligation set, and diff it against the clean set BY CONTENT
// (id + contentHash; reachability excluded). The union of all per-error
// deltas must equal the clean-vs-flawed diff exactly — any unattributed or
// conflicting delta is reported and fails the selfcheck.
//
// applyPatchOp is ported from test-suite/branching/validate.mjs (not
// exported there); semantics identical (RFC-6901 pointer with ~0/~1,
// replace/remove/add, no-op replace rejected).
import { stripAnswerKey, stableStringify, sha256OfString } from "./corpus.mjs";
import { deriveOracle } from "./derive.mjs";
import { diffObligations } from "./model.mjs";

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function applyPatchOp(doc, op) {
  const parts = op.path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const last = parts.pop();
  let parent = doc;
  for (const p of parts) {
    parent = Array.isArray(parent) ? parent[Number(p)] : parent[p];
    if (parent === undefined) throw new Error("bad pointer " + op.path);
  }
  const key = Array.isArray(parent) ? Number(last) : last;
  if (op.op === "replace") {
    if ((Array.isArray(parent) ? parent[key] : parent[key]) === undefined) throw new Error("replace target missing: " + op.path);
    if (deepEqual(parent[key], op.value)) throw new Error("no-op replace: " + op.path);
    parent[key] = structuredClone(op.value);
  } else if (op.op === "remove") {
    if (Array.isArray(parent)) {
      if (parent[key] === undefined) throw new Error("remove target missing: " + op.path);
      parent.splice(key, 1);
    } else {
      if (!(key in parent)) throw new Error("remove target missing: " + op.path);
      delete parent[key];
    }
  } else if (op.op === "add") {
    if (Array.isArray(parent)) parent.splice(key, 0, structuredClone(op.value));
    else {
      if (key in parent) throw new Error("add target exists: " + op.path);
      parent[key] = structuredClone(op.value);
    }
  } else throw new Error("unknown patch op: " + op.op);
}

function describeDelta(id, change, cleanSet, otherSet) {
  const out = { id, change };
  const cleanOb = cleanSet.obligationMap.get(id);
  const otherOb = otherSet.obligationMap.get(id);
  if (cleanOb) {
    out.cleanContentHash = cleanOb.contentHash;
    out.cleanRequirement = cleanOb.requirement;
  }
  if (otherOb) {
    out.flawedContentHash = otherOb.contentHash;
    out.flawedRequirement = otherOb.requirement;
  }
  return out;
}

/**
 * @param seededErrors — the raw seededErrors array from manifest.flawed.json.
 * Returns {
 *   perError: [{ id, category, location, description, expectedObservable,
 *                affectedObligations: [deltas] }],
 *   fullDiff, unionMatchesFullDiff, unattributedDeltas
 * }
 */
export function mapSeededErrors({ surveyId, cleanRaw, seededErrors, cleanSet, flawedSet }) {
  const perError = [];
  const unionRemoved = new Set();
  const unionAdded = new Set();
  const unionModified = new Map(); // id -> toHash

  for (const e of seededErrors || []) {
    const single = stripAnswerKey(structuredClone(cleanRaw));
    for (const op of e.patch) applyPatchOp(single, op);
    const singleSet = deriveOracle(single, {
      surveyId,
      variant: `single:${e.id}`,
      manifestPath: `derived:single-patch:${e.id}`,
      manifestSha256: sha256OfString(stableStringify(single)),
    });
    const d = diffObligations(cleanSet.obligationMap, singleSet.obligationMap);
    const affected = [
      ...d.removed.map((id) => describeDelta(id, "removed-in-flawed", cleanSet, singleSet)),
      ...d.modified.map((m) => describeDelta(m.id, "modified", cleanSet, singleSet)),
      ...d.added.map((id) => describeDelta(id, "added-in-flawed", cleanSet, singleSet)),
    ];
    for (const id of d.removed) unionRemoved.add(id);
    for (const id of d.added) unionAdded.add(id);
    for (const m of d.modified) unionModified.set(m.id, m.toHash);
    perError.push({
      id: e.id,
      category: e.category,
      location: e.location,
      description: e.description,
      expectedObservable: e.description,
      affectedObligations: affected,
    });
  }

  const fullDiff = diffObligations(cleanSet.obligationMap, flawedSet.obligationMap);
  const unattributed = [];
  for (const id of fullDiff.removed) if (!unionRemoved.has(id)) unattributed.push(`removed ${id} not attributed to any seeded error`);
  for (const id of fullDiff.added) if (!unionAdded.has(id)) unattributed.push(`added ${id} not attributed to any seeded error`);
  for (const m of fullDiff.modified) {
    if (!unionModified.has(m.id)) unattributed.push(`modified ${m.id} not attributed to any seeded error`);
    else if (unionModified.get(m.id) !== m.toHash)
      unattributed.push(`modified ${m.id}: single-patch hash ${unionModified.get(m.id)} != combined flawed hash ${m.toHash}`);
  }
  for (const id of unionRemoved) if (!fullDiff.removed.includes(id)) unattributed.push(`attributed removal ${id} absent from full clean/flawed diff`);
  for (const id of unionAdded) if (!fullDiff.added.includes(id)) unattributed.push(`attributed addition ${id} absent from full clean/flawed diff`);
  for (const id of unionModified.keys())
    if (!fullDiff.modified.some((m) => m.id === id)) unattributed.push(`attributed modification ${id} absent from full clean/flawed diff`);

  return {
    perError,
    fullDiff,
    unionMatchesFullDiff: unattributed.length === 0,
    unattributedDeltas: unattributed,
  };
}
