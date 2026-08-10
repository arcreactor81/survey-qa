/**
 * contract.mjs — load + normalise the coverage contract (the checklist) that the
 * extraction stage produces.
 *
 * The planner is a PURE FUNCTION of the contract. It never reads the site, never
 * reads the answer key, and (in the normal path) never reads the questionnaire.
 * The contract is the run's fixed DENOMINATOR: nothing downstream may add to it.
 *
 * Accepted input shapes (the extractor is chunked, so several are plausible):
 *   A. { obligations, ambiguities, unverifiable_from_browser }        merged chunk
 *   B. { chunks: [ {chunk_id, obligations, ...}, ... ] }              chunk envelope
 *   C. [ {chunk_id, obligations, ...}, ... ]                          bare chunk array
 *   D. null / missing / { obligations: null }                         EXTRACTION FAILED
 *
 * Shape D is not an error to swallow. It is recorded as a blocking condition and
 * the caller decides whether to fall back to a provisional contract.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const CONTRACT_KIND = 'coverage-contract/extractor-v1';

/**
 * Canonicalise a JSON value without depending on object insertion order.
 *
 * Contracts cross a persisted-artifact boundary as JSON, so values outside the JSON data model
 * are refused rather than silently stringified into a different value. Array order is retained:
 * order within a stimulus or other row field can change what the planner does.
 */
function canonicalJsonValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`contract hash: ${path} is not a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) throw new TypeError(`contract hash: ${path}.${key} is undefined, not JSON`);
      out[key] = canonicalJsonValue(child, `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`contract hash: ${path} contains non-JSON ${typeof value}`);
}

/** A denominator collection is a set of rows; row order is not contract semantics. */
function canonicalRows(rows, path) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row, index) => {
      const value = canonicalJsonValue(row, `${path}[${index}]`);
      return { value, key: JSON.stringify(value) };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ value }) => value);
}

/**
 * Stable semantic hash so the plan is pinned to the exact denominator it planned against.
 *
 * `contractHash` itself and acquisition provenance are deliberately absent. Every field of
 * every obligation, ambiguity and browser-unverifiable row is retained. In particular, two
 * contracts that reuse an id but change its statement, stimulus or expected observation are
 * different contracts and must trigger a re-plan.
 */
export function hashContract(c) {
  const canon = JSON.stringify(canonicalJsonValue({
    obligations: canonicalRows(c?.obligations, '$.obligations'),
    ambiguities: canonicalRows(c?.ambiguities, '$.ambiguities'),
    unverifiable_from_browser: canonicalRows(c?.unverifiable_from_browser, '$.unverifiable_from_browser'),
  }));
  return 'sha256:' + createHash('sha256').update(canon).digest('hex');
}

function isNonEmptyArray(x) {
  return Array.isArray(x) && x.length > 0;
}

/**
 * Load and normalise. Never throws on a bad/absent contract — returns a report.
 * @returns {{ok:boolean, contract:object, warnings:string[], blockers:object[]}}
 */
export function loadContract(path) {
  const warnings = [];
  const blockers = [];

  if (!path || !existsSync(path)) {
    blockers.push({
      code: 'CONTRACT_MISSING',
      severity: 'blocking',
      detail: `No checklist at ${path}. The extraction stage produced no coverage contract.`,
      consequence:
        'The run has no denominator. Coverage cannot be expressed as a fraction of anything, and extraction accuracy cannot be scored.',
    });
    return { ok: false, contract: emptyContract(), warnings, blockers };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    blockers.push({
      code: 'CONTRACT_UNPARSEABLE',
      severity: 'blocking',
      detail: `${path} is not valid JSON: ${e.message}`,
      consequence: 'Same as CONTRACT_MISSING: no denominator.',
    });
    return { ok: false, contract: emptyContract(), warnings, blockers };
  }

  if (raw === null) {
    blockers.push({
      code: 'CONTRACT_NULL',
      severity: 'blocking',
      detail: `${path} contains literal null. The extraction stage ran and returned nothing.`,
      consequence: 'No denominator. A null contract is an extraction failure, not an empty survey.',
    });
    return { ok: false, contract: emptyContract(), warnings, blockers };
  }

  // Fold shapes B and C into shape A.
  let chunks;
  if (Array.isArray(raw)) chunks = raw;
  else if (isNonEmptyArray(raw.chunks)) chunks = raw.chunks;
  else chunks = [raw];

  const contract = emptyContract();
  const seen = new Set();
  for (const ch of chunks) {
    if (!ch || typeof ch !== 'object') continue;
    for (const key of ['obligations', 'ambiguities', 'unverifiable_from_browser']) {
      const arr = ch[key];
      if (arr == null) continue;
      if (!Array.isArray(arr)) {
        warnings.push(`chunk ${ch.chunk_id ?? '?'}: "${key}" is ${typeof arr}, expected array — ignored.`);
        continue;
      }
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const id = item.id || `${key}:${contract[key].length}`;
        const dedupeKey = `${key}::${id}`;
        if (seen.has(dedupeKey)) {
          warnings.push(`duplicate ${key} id "${id}" — kept first, dropped duplicate.`);
          continue;
        }
        seen.add(dedupeKey);
        contract[key].push({ ...item, id, chunk_id: item.chunk_id ?? ch.chunk_id ?? null });
      }
    }
  }

  if (contract.obligations.length === 0) {
    blockers.push({
      code: 'CONTRACT_EMPTY',
      severity: 'blocking',
      detail: `${path} parsed but carries zero obligations.`,
      consequence:
        'A zero-length denominator makes any coverage figure vacuously 100%. Treated as extraction failure.',
    });
    return { ok: false, contract, warnings, blockers };
  }

  // Field-level hygiene. Missing fields degrade planning precision but are not fatal.
  for (const o of contract.obligations) {
    if (!o.category) warnings.push(`obligation ${o.id}: no category — witness mode defaulted to "observe".`);
    if (o.stimulus == null) warnings.push(`obligation ${o.id}: no stimulus — treated as reachable from any path.`);
    else if (!Array.isArray(o.stimulus)) warnings.push(`obligation ${o.id}: stimulus is not an array — ignored.`);
    if (!o.expected_observable) warnings.push(`obligation ${o.id}: no expected_observable — verification will be weak.`);
  }

  contract.provenance = {
    kind: CONTRACT_KIND,
    source: path,
    denominatorAuthority: 'extraction',
    chunkCount: chunks.length,
  };
  contract.contractHash = hashContract(contract);
  return { ok: true, contract, warnings, blockers };
}

export function emptyContract() {
  return {
    obligations: [],
    ambiguities: [],
    unverifiable_from_browser: [],
    provenance: { kind: CONTRACT_KIND, source: null, denominatorAuthority: 'none', chunkCount: 0 },
    contractHash: null,
  };
}
