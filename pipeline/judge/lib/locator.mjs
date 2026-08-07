/**
 * judge/lib/locator.mjs — the restricted locator grammar.
 *
 * Split out of evidence-store.mjs so the proof projections can use it without
 * a cycle. `resolvePath` is TOTAL: a malformed or hostile path returns
 * `{ok:false}` rather than throwing or reaching a prototype.
 *
 *   evidence[10].screen_id
 *   trace[9].applied.clicked[0].label
 *   mobile_Q5.grid_rows
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function resolvePath(root, path) {
  const tokens = String(path).match(/[^.[\]]+|\[\d+\]/g);
  if (!tokens) return { ok: false, value: undefined };
  let cur = root;
  for (const raw of tokens) {
    if (cur === null || cur === undefined) return { ok: false, value: undefined };
    const m = /^\[(\d+)\]$/.exec(raw);
    if (m) {
      const i = Number(m[1]);
      if (!Array.isArray(cur) || i >= cur.length) return { ok: false, value: undefined };
      cur = cur[i];
    } else {
      const key = raw.trim();
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, value: undefined };
      if (typeof cur !== 'object') return { ok: false, value: undefined };
      // OWN properties only: an inherited member is not evidence.
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { ok: false, value: undefined };
      cur = cur[key];
    }
  }
  return { ok: true, value: cur };
}
