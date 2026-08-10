// diff.mjs — the comparison. Three levels, deliberately separated so the
// soundness of each can be reported independently.
//
//   LEVEL A  edge-set arithmetic (the owner's proposal, taken literally):
//            an edge is (fromNode, answerClass) -> toNode. Compare the D set
//            and the S set. in D not S = missing route; in S not D =
//            undocumented route; same key different target = mis-route.
//            Requires predicting D's target from the LOCAL answer alone.
//            Every case where that is not possible is counted as
//            UNDECIDABLE and reported — that count is the honest measure of
//            how far pure edge arithmetic actually reaches.
//
//   LEVEL B  trace replay: every concrete journey the crawler executed is
//            replayed through the document-side interpreter with full state.
//            This is decidable everywhere and is the sound comparison.
//
//   LEVEL C  node-attribute comparison: at each replayed step, compare what
//            the document says the screen should contain with what the site
//            rendered. This is NOT edge arithmetic; it is the part of the
//            problem the graph does not cover on its own.
import { condRefs, evalCond, createDRun, expectedOptions, expectedValidation, condToText } from "./compile-d.mjs";

// ------------------------------------------------------------ helpers -------
export function specToValue(spec) {
  switch (spec.kind) {
    case "radio": return spec.code;
    case "rating": return spec.code !== undefined ? spec.code : spec.value;
    case "checkbox": return spec.codes;
    case "number": return spec.value;
    case "text": return spec.value;
    case "allocation": return spec.cells;
    default: return null;
  }
}

export function classKeyOf(spec) {
  switch (spec.kind) {
    case "radio": case "rating": return "code=" + (spec.code !== undefined ? spec.code : spec.value);
    case "checkbox": return "codes=[" + spec.codes.slice().sort((a, b) => a - b).join(",") + "]";
    case "number": return "n=" + spec.value;
    case "text": return "text";
    case "allocation": return "alloc=" + JSON.stringify(spec.cells);
    default: return "?";
  }
}

function qById(m, id) { return m.questions.find((q) => q.id === id) || null; }
function nextId(m, id) {
  const i = m.questions.findIndex((q) => q.id === id);
  return i >= 0 && i + 1 < m.questions.length ? m.questions[i + 1].id : "END:completed";
}
function loopOf(m, id) { return (m.loops || []).find((l) => l.block.includes(id)) || null; }

/** Are all data a condition needs available from this question's own answer? */
function condIsLocal(m, cond, qid) {
  const refs = [...condRefs(cond)];
  for (const r of refs) {
    if (r === qid) continue;
    if (r.startsWith("var:")) {
      const c = (m.computed || []).find((x) => x.id === r.slice(4));
      if (!c) return false;
      if ((c.expr?.refs || []).every((rr) => String(rr).split(".")[0] === qid)) continue;
      return false;
    }
    return false;
  }
  return true;
}

// ------------------------------------------------------------- LEVEL A ------
/**
 * Predict D's target for one answer at one node, using only that answer.
 * Returns {decidable, to?, reason?}
 */
export function localPredict(m, qid, value) {
  const q = qById(m, qid);
  if (!q) return { decidable: false, reason: "node not in D" };
  if (loopOf(m, qid)) return { decidable: false, reason: "node is inside a loop block (target depends on iteration state)" };
  const answers = { [qid]: value };
  for (const r of q.rules || []) {
    if (!condIsLocal(m, r.if, qid)) {
      return { decidable: false, reason: `rule ${r.goto || r.terminate} guarded by ${condToText(r.if)} which reads other questions` };
    }
    if (evalCond(m, answers, r.if)) {
      return { decidable: true, to: r.terminate ? "END:terminated" : r.goto, via: r.terminate ? "terminate" : "goto" };
    }
  }
  // fall through, skipping any immediately-following question whose
  // carry-forward list is empty (decidable only if its source is this node)
  let t = nextId(m, qid);
  for (let guard = 0; guard < 20; guard++) {
    if (String(t).startsWith("END:")) return { decidable: true, to: t, via: "fallthrough" };
    const tq = qById(m, t);
    if (loopOf(m, t)) return { decidable: false, reason: "fall-through lands on a loop block" };
    if (!tq?.optionsFrom) return { decidable: true, to: t, via: "fallthrough" };
    if (tq.optionsFrom.q !== qid) return { decidable: false, reason: `fall-through target ${t} carries forward from ${tq.optionsFrom.q}` };
    const opts = expectedOptions(m, tq, answers);
    if (opts.length) return { decidable: true, to: t, via: "fallthrough" };
    t = nextId(m, t);
  }
  return { decidable: false, reason: "fall-through did not settle" };
}

export function levelA(manifest, graphS) {
  const rows = [];
  const counts = { agree: 0, misroute: 0, undecidable: 0, sOnlyClass: 0, dOnlyClass: 0, acceptsInvalid: 0 };

  for (const e of graphS.edges) {
    // An edge whose ANSWER the document forbids is not a routing disagreement;
    // pure edge arithmetic cannot tell the two apart, so separate them here and
    // count how often it matters.
    const q = manifest.questions.find((x) => x.id === e.from);
    if (q && !q.optionsFrom) {
      const opts = (q.options || []).map((o, i) => ({ code: o.code, label: o.label, order: i, exclusive: !!o.exclusive }));
      const verr = expectedValidation(manifest, q, opts, specToValue(e.spec));
      if (verr.length) {
        counts.acceptsInvalid++;
        rows.push({ verdict: "SITE-ACCEPTS-INVALID", from: e.from, classKey: e.classKey, documentedErrors: verr, observed: e.to });
        continue;
      }
    }
    const p = localPredict(manifest, e.from, specToValue(e.spec));
    if (!p.decidable) {
      counts.undecidable++;
      rows.push({ verdict: "UNDECIDABLE", from: e.from, classKey: e.classKey, observed: e.to, reason: p.reason });
      continue;
    }
    if (p.to === e.to) { counts.agree++; continue; }
    counts.misroute++;
    rows.push({ verdict: "MIS-ROUTE", from: e.from, classKey: e.classKey, documented: p.to, observed: e.to, via: p.via });
  }

  // classes documented but never renderable on the site (missing option), and
  // classes rendered on the site that the document does not define
  for (const q of manifest.questions) {
    const sNode = graphS.nodes[q.id];
    if (!sNode) {
      rows.push({ verdict: "MISSING-NODE", from: q.id, reason: "documented question never rendered by the site" });
      counts.dOnlyClass++;
      continue;
    }
    if (!(q.options || []).length) continue;
    const sCodes = new Set();
    for (const v of sNode.renderVariants) for (const o of v.options || []) sCodes.add(o.code);
    for (const o of q.options || []) {
      if (!sCodes.has(o.code)) {
        counts.dOnlyClass++;
        rows.push({ verdict: "MISSING-OPTION", from: q.id, code: o.code, label: o.label, reason: "documented option never rendered" });
      }
    }
    const dCodes = new Set((q.options || []).map((o) => o.code));
    if (!q.optionsFrom) {
      for (const c of sCodes) {
        if (!dCodes.has(c)) {
          counts.sOnlyClass++;
          rows.push({ verdict: "UNDOCUMENTED-OPTION", from: q.id, code: c, reason: "site renders an option the document does not define" });
        }
      }
    }
  }

  // nodes the site rendered that the document does not contain
  for (const id of Object.keys(graphS.nodes)) {
    if (!qById(manifest, id)) rows.push({ verdict: "UNDOCUMENTED-NODE", from: id });
  }

  return { rows, counts, decidableShare: counts.agree + counts.misroute === 0 ? 0
    : (counts.agree + counts.misroute) / (counts.agree + counts.misroute + counts.undecidable) };
}

// ------------------------------------------------------------- LEVEL B ------
/**
 * @param resync  false = stop at the first divergence on each journey (the
 *                naive reading of "compare the traces"); true = record the
 *                divergence, force the document run onto the screen the site
 *                actually showed, and continue. Without resync, one early
 *                defect masks every later defect on the same route — that is a
 *                real and measured limitation, so both modes are reported.
 */
export function levelB(manifest, graphS, { resync = true } = {}) {
  const findings = new Map();
  let journeysReplayed = 0;
  let journeysClean = 0;
  let resyncsUsed = 0;
  let resyncFailures = 0;

  const add = (key, obj) => {
    const ex = findings.get(key);
    if (ex) { ex.count++; return; }
    findings.set(key, { count: 1, ...obj });
  };

  for (const j of graphS.journeys || []) {
    journeysReplayed++;
    const run = createDRun(manifest);
    let diverged = false;
    for (const st of j.steps) {
      const cur = run.current();
      if (!cur) {
        add(`end|${st.from}`, { kind: "SITE-CONTINUES-PAST-DOCUMENT-END", at: st.from });
        diverged = true; break;
      }
      if (cur.qid !== st.from) {
        add(`screen|${cur.qid}|${st.from}`, { kind: "WRONG-SCREEN", at: st.from, documented: cur.qid, observed: st.from });
        diverged = true;
        if (!resync || !run.seekTo(st.from)) { resyncFailures++; break; }
        resyncsUsed++;
      }
      const value = specToValue(st.spec);
      const res = run.answer(value);
      if (st.rejected && res.ok) {
        add(`overvalidate|${st.from}|${classKeyOf(st.spec)}`, {
          kind: "SITE-REJECTS-VALID-ANSWER", at: st.from, classKey: classKeyOf(st.spec), siteErrors: st.errors,
        });
        diverged = true; break;   // the site did not move; the traces cannot be realigned
      }
      if (!st.rejected && !res.ok) {
        add(`undervalidate|${st.from}|${res.errors.join(",")}`, {
          kind: "SITE-ACCEPTS-INVALID-ANSWER", at: st.from, classKey: classKeyOf(st.spec),
          documentedErrors: res.errors,
        });
        diverged = true;
        if (!resync) break;
        // the document rejected, so it never advanced; put it on the site's next screen
        if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) { resyncFailures++; break; }
        resyncsUsed++;
        continue;
      }
      if (st.rejected && !res.ok) continue;  // both reject: agree, screen unchanged
      if (res.to !== st.to) {
        add(`route|${st.from}|${classKeyOf(st.spec)}|${res.to}|${st.to}`, {
          kind: "MIS-ROUTE", at: st.from, classKey: classKeyOf(st.spec), documented: res.to, observed: st.to,
        });
        diverged = true;
        if (!resync) break;
        if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) { resyncFailures++; break; }
        resyncsUsed++;
      }
    }
    if (!diverged) journeysClean++;
  }
  return { findings: [...findings.values()], journeysReplayed, journeysClean, resyncsUsed, resyncFailures };
}

// ------------------------------------------------------------- LEVEL C ------
export function levelC(manifest, graphS) {
  const snapTable = graphS.snapshots || {};
  const findings = new Map();
  const add = (key, obj) => {
    const ex = findings.get(key);
    if (ex) { ex.count++; return; }
    findings.set(key, { count: 1, ...obj });
  };

  for (const j of graphS.journeys || []) {
    const run = createDRun(manifest);
    for (const st of j.steps) {
      const cur = run.current();
      if (!cur || cur.qid !== st.from) break;
      const obs = st.snapSig ? snapTable[st.snapSig] : null;
      if (obs) compareNode(manifest, cur, obs, add);
      const res = run.answer(specToValue(st.spec));
      if (st.rejected && !res.ok) continue;
      if (!res.ok || res.to !== st.to) break;
    }
  }
  return { findings: [...findings.values()] };
}

function compareNode(m, cur, obs, add) {
  const at = cur.qid;
  if (cur.text !== obs.text) {
    add(`text|${at}|${obs.text}`, { kind: "TEXT-MISMATCH", at, documented: cur.text, observed: obs.text });
  }
  const dInstr = cur.instruction ?? null;
  const oInstr = obs.instruction ?? null;
  if (dInstr !== oInstr) {
    add(`instr|${at}|${oInstr}`, { kind: dInstr && !oInstr ? "INSTRUCTION-MISSING" : "INSTRUCTION-MISMATCH", at, documented: dInstr, observed: oInstr });
  }
  const typeMap = { radio: "radio", checkbox: "checkbox", number: "number", text: "text", rating: "rating", allocation: "allocation" };
  if (typeMap[cur.type] !== obs.type) {
    add(`type|${at}`, { kind: "TYPE-MISMATCH", at, documented: cur.type, observed: obs.type });
  }
  if (cur.type === "radio" || cur.type === "checkbox") {
    const dCodes = cur.options.map((o) => o.code);
    const oCodes = (obs.options || []).map((o) => o.code);
    for (const c of dCodes) if (!oCodes.includes(c)) {
      add(`optmiss|${at}|${c}`, { kind: "OPTION-MISSING", at, code: c, label: cur.options.find((o) => o.code === c)?.label });
    }
    for (const c of oCodes) if (!dCodes.includes(c)) {
      add(`optextra|${at}|${c}`, { kind: "OPTION-UNDOCUMENTED", at, code: c, label: (obs.options || []).find((o) => o.code === c)?.label });
    }
    for (const d of cur.options) {
      const o = (obs.options || []).find((x) => x.code === d.code);
      if (o && o.label !== d.label) {
        add(`optlabel|${at}|${d.code}`, { kind: "OPTION-LABEL-MISMATCH", at, code: d.code, documented: d.label, observed: o.label });
      }
    }
    const rnd = cur.randomize;
    const oOrder = (obs.options || []).map((o) => o.code);
    if (!rnd) {
      if (JSON.stringify(oOrder) !== JSON.stringify(dCodes) && oOrder.length === dCodes.length) {
        add(`order|${at}`, { kind: "OPTION-ORDER-MISMATCH", at, documented: dCodes, observed: oOrder });
      }
    } else {
      const anchors = rnd.anchorLastCodes || [];
      const tail = oOrder.slice(oOrder.length - anchors.length);
      if (anchors.length && JSON.stringify(tail.slice().sort()) !== JSON.stringify(anchors.slice().sort())) {
        add(`anchor|${at}`, { kind: "ANCHOR-VIOLATION", at, anchors, observedOrder: oOrder });
      }
    }
  }
  if (cur.type === "number" || cur.type === "rating") {
    if (cur.min !== null && obs.min !== null && cur.min !== obs.min) add(`min|${at}`, { kind: "MIN-MISMATCH", at, documented: cur.min, observed: obs.min });
    if (cur.max !== null && obs.max !== null && cur.max !== obs.max) add(`max|${at}`, { kind: "MAX-MISMATCH", at, documented: cur.max, observed: obs.max });
  }
  if (cur.type === "allocation") {
    const dRows = cur.rows.map((r) => r.code);
    const oRows = (obs.rows || []).map((r) => r.code);
    if (JSON.stringify(dRows) !== JSON.stringify(oRows)) {
      add(`rows|${at}`, { kind: "ALLOCATION-ROWS-MISMATCH", at, documented: dRows, observed: oRows });
    }
    for (const r of cur.rows) {
      const o = (obs.rows || []).find((x) => x.code === r.code);
      if (o && o.label !== r.label) add(`rowlabel|${at}|${r.code}`, { kind: "ALLOCATION-ROW-LABEL-MISMATCH", at, row: r.code, documented: r.label, observed: o.label });
    }
  }
}

/** Node-attribute checks that need the crawler's PROBE results, not a render. */
export function levelCProbes(manifest, graphS) {
  const out = [];
  for (const q of manifest.questions) {
    const s = graphS.nodes[q.id];
    if (!s) continue;
    if (q.type === "allocation") {
      const alloc = q.allocation || {};
      if (alloc.enforceTotal !== false && s.enforcesTotal === false) {
        out.push({ kind: "ALLOCATION-TOTAL-NOT-ENFORCED", at: q.id, documentedTotal: alloc.total });
      }
      if (s.discoveredTotal !== undefined && alloc.total !== undefined && s.enforcesTotal && s.discoveredTotal !== alloc.total) {
        out.push({ kind: "ALLOCATION-TOTAL-MISMATCH", at: q.id, documented: alloc.total, observed: s.discoveredTotal });
      }
      for (const row of q.rows || []) {
        const docCap = row.max ?? alloc.rowMax ?? alloc.total;
        const hasCap = docCap !== undefined && docCap < (alloc.total ?? Infinity);
        const obsCap = (s.rowCaps || {})[row.code];
        if (hasCap && obsCap === undefined) {
          out.push({ kind: "ROW-CAP-NOT-ENFORCED", at: q.id, row: row.code, documentedMax: docCap });
        } else if (hasCap && obsCap !== undefined && obsCap !== docCap) {
          out.push({ kind: "ROW-CAP-MISMATCH", at: q.id, row: row.code, documented: docCap, observed: obsCap });
        }
      }
    }
    // exclusive-option enforcement: documented exclusive option must be
    // rejected when combined with another selection
    for (const o of q.options || []) {
      if (!o.exclusive) continue;
      const other = (q.options || []).find((x) => x.code !== o.code);
      if (!other) continue;
      const key = "codes=[" + [o.code, other.code].sort((a, b) => a - b).join(",") + "]";
      const rejected = (graphS.rejections || []).some((r) => r.from === q.id && r.classKey === key);
      const accepted = (graphS.edges || []).some((e) => e.from === q.id && e.classKey === key);
      if (accepted && !rejected) {
        out.push({ kind: "EXCLUSIVE-NOT-ENFORCED", at: q.id, code: o.code, label: o.label });
      }
    }
  }
  return out;
}
