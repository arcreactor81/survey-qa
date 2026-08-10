// coverage.mjs — coverage as arithmetic instead of attestation.
//
// The denominator is the SYMBOLIC edge set of Graph-D: for every question,
// one edge per routing rule plus one fall-through (or loop-back / loop-exit
// for the last question of a loop block). That set is finite, computable and
// independent of any traversal, which is exactly what makes coverage a
// number rather than a claim.
//
// What this file also makes explicit: the residue. Edge coverage is not path
// coverage, and node coverage is not attribute coverage. Both gaps are
// enumerated rather than glossed.
import { compileGraphD, createDRun, condRefs } from "./compile-d.mjs";

const TEXT_ANSWER = "coverage probe";

/** Answer classes for a resolved D screen (mirrors the crawler's policy). */
export function classesForD(cur, thresholds = new Map()) {
  const out = [];
  if (cur.type === "radio") for (const o of cur.options) out.push({ kind: "radio", code: o.code, key: "code=" + o.code });
  else if (cur.type === "rating") {
    const vals = new Set([cur.min, cur.max, Math.round((cur.min + cur.max) / 2)]);
    for (const t of thresholds.get(cur.qid) || []) { vals.add(t - 1); vals.add(t); vals.add(t + 1); }
    for (const v of [...vals].filter((v) => v >= cur.min && v <= cur.max).sort((a, b) => a - b)) {
      out.push({ kind: "rating", code: v, key: "code=" + v });
    }
  } else if (cur.type === "checkbox") {
    const codes = cur.options.map((o) => o.code);
    for (const c of codes) out.push({ kind: "checkbox", codes: [c], key: "codes=[" + c + "]" });
    for (let k = 2; k <= codes.length; k++) {
      const sub = codes.slice(0, k);
      out.push({ kind: "checkbox", codes: sub, key: "codes=[" + sub.slice().sort((a, b) => a - b).join(",") + "]" });
    }
  } else if (cur.type === "number") {
    const lo = cur.min ?? 0, hi = cur.max ?? 100;
    const vals = new Set([lo, hi, lo + Math.round((hi - lo) / 2)]);
    for (const t of thresholds.get(cur.qid) || []) { vals.add(t - 1); vals.add(t); vals.add(t + 1); }
    for (const v of [...vals].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b)) {
      out.push({ kind: "number", value: v, key: "n=" + v });
    }
  } else if (cur.type === "text") {
    out.push({ kind: "text", value: TEXT_ANSWER, key: "text" });
  } else if (cur.type === "allocation") {
    const rows = cur.rows.map((r) => r.code);
    const total = cur.allocation?.total ?? 100;
    const caps = Object.fromEntries(cur.rows.map((r) => [r.code, r.max ?? cur.allocation?.rowMax ?? total]));
    const mk = (heavy, amount) => {
      const cells = {}; rows.forEach((r) => (cells[r] = 0));
      let rest = total;
      const give = Math.min(amount, caps[heavy]);
      cells[heavy] = give; rest -= give;
      for (const r of rows.filter((x) => x !== heavy)) {
        const g = Math.min(rest, caps[r]);
        cells[r] = g; rest -= g;
      }
      if (rest > 0) return null;
      return { kind: "allocation", cells, key: "alloc=" + JSON.stringify(cells) };
    };
    const even = {}; rows.forEach((r) => (even[r] = Math.floor(total / rows.length)));
    even[rows[0]] += total - Object.values(even).reduce((a, b) => a + b, 0);
    if (rows.every((r) => even[r] <= caps[r])) out.push({ kind: "allocation", cells: even, key: "alloc=" + JSON.stringify(even) });
    for (const r of rows) {
      for (const amt of [0, Math.floor(total / 2), total]) {
        const s = mk(r, amt);
        if (s && !out.some((o) => o.key === s.key)) out.push(s);
      }
    }
  }
  return out;
}

export function valueOf(spec) {
  switch (spec.kind) {
    case "radio": case "rating": return spec.code;
    case "checkbox": return spec.codes;
    case "number": return spec.value;
    case "text": return spec.value;
    case "allocation": return spec.cells;
    default: return null;
  }
}

/** Numeric thresholds mentioned anywhere in the manifest, per question. */
export function thresholdMap(manifest) {
  const map = new Map();
  const add = (qid, v) => { if (!map.has(qid)) map.set(qid, new Set()); map.get(qid).add(v); };
  const dig = (cond) => {
    if (!cond) return;
    if (cond.op === "and" || cond.op === "or") return (cond.terms || []).forEach(dig);
    if (cond.q !== undefined && typeof cond.value === "number" && !String(cond.q).includes(".")) add(String(cond.q), cond.value);
  };
  for (const q of manifest.questions) for (const r of q.rules || []) dig(r.if);
  return map;
}

/** Symbolic edge id taken at one answered step. */
function edgeIdOf(manifest, qid, res, toId) {
  if (res.ruleIndex !== null && res.ruleIndex !== undefined) return `${qid}#r${res.ruleIndex}`;
  const loop = (manifest.loops || []).find((l) => l.block.includes(qid));
  if (loop && loop.block[loop.block.length - 1] === qid) {
    return toId === loop.block[0] ? `${qid}#loop-back` : `${qid}#loop-exit`;
  }
  return `${qid}#fall`;
}

export function symbolicEdgeIds(manifest) {
  const g = compileGraphD(manifest);
  const ids = [];
  for (const e of g.edges) {
    if (e.rule !== null && e.rule !== undefined) ids.push({ id: `${e.from}#r${e.rule}`, from: e.from, to: e.to, cond: e.condText, kind: e.kind });
    else if (e.kind === "loop-back") ids.push({ id: `${e.from}#loop-back`, from: e.from, to: e.to, cond: e.condText, kind: e.kind });
    else if (e.kind === "loop-exit") ids.push({ id: `${e.from}#loop-exit`, from: e.from, to: e.to, cond: e.condText, kind: e.kind });
    else ids.push({ id: `${e.from}#fall`, from: e.from, to: e.to, cond: e.condText, kind: e.kind });
  }
  return ids;
}

/** Run one document-side journey under a chooser policy. */
export function runD(manifest, chooser, thresholds) {
  const run = createDRun(manifest);
  const steps = [];
  const edgesTaken = new Set();
  const nodesVisited = new Set();
  const rejected = new Set();
  for (let guard = 0; guard < 400; guard++) {
    const cur = run.current();
    if (!cur) return { steps, edgesTaken, nodesVisited, rejected, ending: run.terminated ? "END:terminated" : "END:completed" };
    nodesVisited.add(cur.qid);
    const classes = classesForD(cur, thresholds).filter((c) => !rejected.has(cur.qid + "|" + c.key));
    const spec = chooser(cur, classes, steps);
    if (!spec) return { steps, edgesTaken, nodesVisited, rejected, ending: "no-class" };
    const res = run.answer(valueOf(spec));
    if (!res.ok) {
      rejected.add(cur.qid + "|" + spec.key);
      steps.push({ qid: cur.qid, spec, rejected: true, errors: res.errors });
      continue;
    }
    const eid = edgeIdOf(manifest, cur.qid, res, res.to);
    edgesTaken.add(eid);
    steps.push({ qid: cur.qid, spec, to: res.to, edge: eid });
    if (String(res.to).startsWith("END:")) return { steps, edgesTaken, nodesVisited, rejected, ending: res.to };
  }
  return { steps, edgesTaken, nodesVisited, rejected, ending: "guard" };
}

/**
 * Build a journey set aiming at full symbolic edge coverage. Frontier-based:
 * keeps a prefix that is known to reach each question, then replays that
 * prefix and takes an as-yet-unexercised answer class. Terminating first
 * options (screeners!) make "answer everything with option 1" reach almost
 * nothing, so a naive generator silently under-covers — this one does not.
 */
export function edgeCoverageJourneys(manifest, { cap = 600 } = {}) {
  const thresholds = thresholdMap(manifest);
  const journeys = [];
  const reach = new Map();     // qid -> shortest prefix of specs
  const pending = new Map();   // qid -> Set(classKey)
  const used = new Set();      // "qid|key" already exercised or rejected
  const seenSeq = new Set();

  const register = (cur) => {
    const cls = classesForD(cur, thresholds);
    if (!pending.has(cur.qid)) pending.set(cur.qid, new Map());
    for (const s of cls) if (!used.has(cur.qid + "|" + s.key)) pending.get(cur.qid).set(s.key, s);
    return cls;
  };

  const record = (r) => {
    const sig = JSON.stringify(r.steps.map((s) => [s.qid, s.spec.key]));
    let prefix = [];
    for (const st of r.steps) {
      if (!reach.has(st.qid) || reach.get(st.qid).length > prefix.length) reach.set(st.qid, prefix.slice());
      used.add(st.qid + "|" + st.spec.key);
      pending.get(st.qid)?.delete(st.spec.key);
      if (!st.rejected) prefix = prefix.concat([st.spec]);
    }
    if (seenSeq.has(sig)) return false;
    seenSeq.add(sig);
    journeys.push(r);
    return true;
  };

  const runWithPrefix = (prefix) => {
    let i = 0;
    return runD(manifest, (cur, cls) => {
      register(cur);
      if (i < prefix.length) {
        const want = prefix[i++];
        const m = cls.find((c) => c.key === want.key);
        if (m) return m;
        return cls[0] || null;
      }
      const p = pending.get(cur.qid);
      if (p) for (const c of cls) if (p.has(c.key)) return c;
      return cls[0] || null;
    }, thresholds);
  };

  record(runWithPrefix([]));
  let guard = 0;
  while (journeys.length < cap && guard++ < cap * 3) {
    let target = null, key = null, spec = null;
    for (const [qid, map] of pending) {
      if (map.size && reach.has(qid)) { target = qid; [key, spec] = [...map][0]; break; }
    }
    if (!target) break;
    const before = used.size;
    record(runWithPrefix(reach.get(target).concat([spec])));
    if (used.size === before) { pending.get(target).delete(key); used.add(target + "|" + key); }
  }
  // a little extra state variety for history-sensitive rules
  record(runD(manifest, (c, cls) => cls[cls.length - 1] || null, thresholds));
  record(runD(manifest, (c, cls, steps) => cls[steps.length % 2 === 0 ? 0 : cls.length - 1] || null, thresholds));
  return journeys.slice(0, cap);
}

export function coverageReport(manifest, journeys) {
  const all = symbolicEdgeIds(manifest);
  const covered = new Set();
  const nodes = new Set();
  for (const j of journeys) {
    for (const e of j.edgesTaken) covered.add(e);
    for (const n of j.nodesVisited) nodes.add(n);
  }
  const uncovered = all.filter((e) => !covered.has(e.id));
  const allNodes = manifest.questions.map((q) => q.id);
  const uncoveredNodes = allNodes.filter((n) => !nodes.has(n));

  // minimal-ish journey set: greedy set cover over the covered edges
  const remaining = new Set([...covered]);
  const chosen = [];
  const pool = journeys.map((j, i) => ({ i, set: new Set([...j.edgesTaken]) }));
  while (remaining.size) {
    let best = null, bestGain = 0;
    for (const p of pool) {
      const gain = [...p.set].filter((e) => remaining.has(e)).length;
      if (gain > bestGain) { bestGain = gain; best = p; }
    }
    if (!best) break;
    chosen.push(best.i);
    for (const e of best.set) remaining.delete(e);
  }

  return {
    symbolicEdges: all.length,
    edgesCovered: covered.size,
    edgeCoverage: all.length ? covered.size / all.length : 1,
    uncoveredEdges: uncovered,
    nodes: allNodes.length,
    nodesCovered: nodes.size,
    nodeCoverage: allNodes.length ? nodes.size / allNodes.length : 1,
    uncoveredNodes,
    journeysGenerated: journeys.length,
    minimalJourneySet: chosen.length,
    minimalJourneyIndices: chosen,
  };
}

/**
 * What edge coverage CANNOT reach. Enumerated from the graph, so a report can
 * state the residue explicitly instead of silently omitting it.
 */
export function coverageResidue(manifest) {
  const residue = [];
  const byId = new Map(manifest.questions.map((q) => [q.id, q]));
  for (const q of manifest.questions) {
    for (const [ri, r] of (q.rules || []).entries()) {
      const refs = [...condRefs(r.if)].filter((x) => x !== q.id);
      if (refs.length) {
        residue.push({
          kind: "state-dependent-edge",
          edge: `${q.id}#r${ri}`,
          dependsOn: refs,
          note: "traversing this edge once proves nothing about the other states of " + refs.join(", ") +
                "; the same edge can behave differently on a different history",
        });
      }
    }
    if (q.optionsFrom) {
      residue.push({
        kind: "state-dependent-node-content",
        node: q.id,
        dependsOn: [q.optionsFrom.q],
        note: `option list is carried forward from ${q.optionsFrom.q}; edge coverage visits this node, it does not check the list under every upstream selection (2^n states)`,
      });
    }
    if (q.type === "allocation") {
      residue.push({
        kind: "continuous-answer-domain",
        node: q.id,
        note: "allocation answers are a lattice of distributions; a finite probe set cannot cover it, only sample it",
      });
    }
    if (q.type === "number" && q.min !== undefined && q.max !== undefined) {
      residue.push({
        kind: "sampled-numeric-domain",
        node: q.id,
        domain: [q.min, q.max],
        note: `${q.max - q.min + 1} distinct answers collapse into the probed classes; an undocumented gate between probes is invisible`,
      });
    }
  }
  for (const l of manifest.loops || []) {
    const src = byId.get(l.source);
    const n = (src?.options || []).length;
    residue.push({
      kind: "loop-iteration-count",
      loop: l.id,
      note: `loop over ${l.source} (${n} options, max ${l.max ?? "unbounded"}): the loop-back edge is one edge but ` +
            `${Math.pow(2, n)} source subsets produce different iteration counts and different piped content`,
    });
  }
  residue.push({
    kind: "accumulated-state-rules",
    note: "quotas, per-cell counters, carry-forward contents and anything that only misbehaves after N respondents or after a specific multi-select are invisible to single-journey edge traversal by construction",
  });
  return residue;
}
