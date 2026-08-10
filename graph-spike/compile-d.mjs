// compile-d.mjs — Graph-D: the routing graph the DOCUMENT says should exist.
//
// HONESTY NOTE (important, read before trusting any number in FINDINGS.md):
// for this prototype Graph-D is compiled from the branching corpus's own
// machine-readable manifest, NOT from questionnaire.docx prose. That is a
// deliberate isolation of variables: it tests the *graph* claim without
// entangling it with the *extraction* claim. A real pipeline needs an
// extraction step in front of this, and everything that step gets wrong
// flows straight through. Section 4 (mutation testing) is the stand-in for
// that missing step.
//
// The interpreter below is an INDEPENDENT reimplementation of the manifest
// semantics — it does not import engine.js. That matters: if my semantics
// and the site's semantics disagree, the clean-vs-clean diff will be
// non-empty and the disagreement shows up as a measured false positive
// rather than being hidden by shared code.

// ------------------------------------------------------------ symbolic ------
export function compileGraphD(manifest) {
  const qs = manifest.questions;
  const idx = new Map(qs.map((q, i) => [q.id, i]));
  const loops = manifest.loops || [];
  const loopOf = (qid) => loops.find((l) => l.block.includes(qid)) || null;

  const nodes = {};
  for (const q of qs) {
    nodes[q.id] = {
      id: q.id,
      order: idx.get(q.id),
      section: q.section,
      type: q.type,
      text: q.text,
      instruction: q.instruction ?? null,
      options: (q.options || []).map((o, i) => ({ code: o.code, label: o.label, order: i, exclusive: !!o.exclusive })),
      optionsFrom: q.optionsFrom || null,
      min: q.min ?? null,
      max: q.max ?? null,
      rows: q.rows || [],
      allocation: q.allocation || null,
      randomize: q.randomize || null,
      piping: [...String(q.text).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]),
      inLoop: loopOf(q.id)?.id ?? null,
      rules: (q.rules || []).map((r, i) => ({ index: i, if: r.if ?? null, goto: r.goto ?? null, terminate: r.terminate ?? null })),
    };
  }

  // Symbolic edges: one per rule, plus a fall-through edge per question.
  const edges = [];
  for (const q of qs) {
    const i = idx.get(q.id);
    const rules = q.rules || [];
    let unconditionalSeen = false;
    rules.forEach((r, ri) => {
      const to = r.terminate ? "END:terminated" : r.goto;
      edges.push({
        from: q.id,
        to,
        kind: r.terminate ? "terminate" : "goto",
        rule: ri,
        cond: r.if ?? { op: "always" },
        condText: condToText(r.if),
        terminateId: r.terminate ?? null,
      });
      if (!r.if || r.if.op === "always") unconditionalSeen = true;
    });
    // fall-through
    const loop = loopOf(q.id);
    let fallTo;
    if (loop && loop.block[loop.block.length - 1] === q.id) {
      // last question of a loop block: either another iteration or exit
      fallTo = loop.block[0];
      edges.push({
        from: q.id, to: fallTo, kind: "loop-back", rule: null,
        cond: { op: "loop-more", loop: loop.id },
        condText: `another item remains for loop ${loop.id}`,
      });
      const after = nextOutsideLoop(qs, idx, loop);
      edges.push({
        from: q.id, to: after, kind: "loop-exit", rule: null,
        cond: { op: "loop-done", loop: loop.id },
        condText: `no items remain for loop ${loop.id}`,
      });
    } else {
      fallTo = i + 1 < qs.length ? qs[i + 1].id : "END:completed";
      if (!unconditionalSeen) {
        edges.push({
          from: q.id, to: fallTo, kind: "fallthrough", rule: null,
          cond: { op: "no-rule-matched" }, condText: "no rule matched",
        });
      }
    }
  }

  return {
    surveyId: manifest.id,
    compiledFrom: "branching-corpus manifest (NOT docx prose) — see header",
    entry: qs[0]?.id ?? null,
    nodes,
    edges,
    loops: loops.map((l) => ({ ...l })),
    computed: (manifest.computed || []).map((c) => ({ ...c })),
  };
}

function nextOutsideLoop(qs, idx, loop) {
  const lastIdx = Math.max(...loop.block.map((b) => idx.get(b)));
  return lastIdx + 1 < qs.length ? qs[lastIdx + 1].id : "END:completed";
}

export function condToText(cond) {
  if (!cond) return "(always)";
  if (cond.op === "always") return "(always)";
  if (cond.op === "and" || cond.op === "or") {
    return "(" + (cond.terms || []).map(condToText).join(` ${cond.op.toUpperCase()} `) + ")";
  }
  const ref = cond.q !== undefined ? cond.q : `var:${cond.var}`;
  return `${ref} ${cond.op} ${JSON.stringify(cond.value)}`;
}

/** Every question id / computed var a condition depends on. */
export function condRefs(cond, out = new Set()) {
  if (!cond) return out;
  if (cond.op === "and" || cond.op === "or") {
    (cond.terms || []).forEach((t) => condRefs(t, out));
    return out;
  }
  if (cond.q !== undefined) out.add(String(cond.q).split(".")[0]);
  if (cond.var !== undefined) out.add("var:" + cond.var);
  return out;
}

// ---------------------------------------------------------- interpreter -----
// Independent reimplementation of the manifest's execution semantics.

function qById(m, id) { return m.questions.find((q) => q.id === id) || null; }

function refValue(answers, ref) {
  const dot = String(ref).indexOf(".");
  if (dot === -1) return answers[ref] === undefined ? null : answers[ref];
  const qid = String(ref).slice(0, dot);
  const row = String(ref).slice(dot + 1);
  const a = answers[qid];
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  return typeof a[row] === "number" ? a[row] : null;
}

function computedValue(m, answers, id) {
  const def = (m.computed || []).find((c) => c.id === id);
  if (!def || !def.expr || def.expr.op !== "sum") return null;
  let total = 0;
  for (const r of def.expr.refs || []) {
    const v = refValue(answers, r);
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    total += v;
  }
  return total;
}

export function evalCond(m, answers, cond) {
  if (!cond || cond.op === "always") return true;
  if (cond.op === "and") return (cond.terms || []).every((t) => evalCond(m, answers, t));
  if (cond.op === "or") return (cond.terms || []).some((t) => evalCond(m, answers, t));
  const v = cond.var !== undefined ? computedValue(m, answers, cond.var) : refValue(answers, cond.q);
  const isNum = typeof v === "number" && !Number.isNaN(v);
  const isArr = Array.isArray(v);
  switch (cond.op) {
    case "eq": return v !== null && v === cond.value;
    case "ne": return v !== null && v !== cond.value;
    case "lt": return isNum && v < cond.value;
    case "lte": return isNum && v <= cond.value;
    case "gt": return isNum && v > cond.value;
    case "gte": return isNum && v >= cond.value;
    case "includes": return isArr && v.includes(cond.value);
    case "notIncludes": return isArr && !v.includes(cond.value);
    case "countLt": return isArr && v.length < cond.value;
    case "countLte": return isArr && v.length <= cond.value;
    case "countGt": return isArr && v.length > cond.value;
    case "countGte": return isArr && v.length >= cond.value;
    case "countEq": return isArr && v.length === cond.value;
    default: return false;
  }
}

/** Option list a respondent should see. NOT randomized — order/anchoring is
 *  treated as a node ATTRIBUTE requirement, not part of routing. */
export function expectedOptions(m, q, answers) {
  if (!q.optionsFrom) return (q.options || []).map((o, i) => ({ code: o.code, label: o.label, order: i, exclusive: !!o.exclusive }));
  const src = qById(m, q.optionsFrom.q);
  const sel = answers[q.optionsFrom.q];
  const excl = q.optionsFrom.exclude || [];
  if (!src || !Array.isArray(sel)) return [];
  return (src.options || [])
    .filter((o) => sel.includes(o.code) && !excl.includes(o.code))
    .map((o, i) => ({ code: o.code, label: o.label, order: i }));
}

export function expectedText(m, answers, text, loopLabel) {
  return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, tok) => {
    if (tok === "LOOP") return loopLabel != null ? loopLabel : whole;
    const q = qById(m, tok);
    const v = answers[tok];
    if (!q || v === undefined || v === null) return whole;
    if (q.type === "radio") {
      const pool = q.optionsFrom ? (qById(m, q.optionsFrom.q)?.options || []) : (q.options || []);
      const o = pool.find((x) => x.code === v);
      return o ? o.label : String(v);
    }
    if (q.type === "checkbox") {
      return (q.options || []).filter((o) => Array.isArray(v) && v.includes(o.code)).map((o) => o.label).join(", ") || whole;
    }
    return String(v);
  });
}

export function expectedValidation(m, q, options, value) {
  const errs = [];
  const byCode = (c) => options.find((o) => o.code === c);
  // "unknown" = the document never says what control this screen uses. A document that
  // does not state a constraint cannot be violated, so the interpreter admits whatever
  // the site accepted rather than manufacturing "unsupported-type" on every answer and
  // collapsing the replay. Added for graph-spike/arm, where Graph-D is compiled from a
  // real questionnaire whose extraction carries no typed input type; no corpus manifest
  // ever produces this type, so existing behaviour is unchanged.
  if (q.type === "unknown") return errs;
  switch (q.type) {
    case "radio":
      if (typeof value !== "number" || !byCode(value)) errs.push("invalid-option");
      break;
    case "checkbox": {
      if (!Array.isArray(value) || !value.length) { errs.push("min-one-required"); break; }
      if (value.some((c) => !byCode(c))) { errs.push("invalid-option"); break; }
      if (value.length > 1) {
        const src = q.optionsFrom ? null : q;
        const ex = value.find((c) => (src?.options || []).find((o) => o.code === c && o.exclusive));
        if (ex !== undefined) errs.push("exclusive-violation:" + ex);
      }
      break;
    }
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) errs.push("not-a-number");
      else {
        if (!Number.isInteger(value)) errs.push("not-integer");
        if (q.min !== undefined && value < q.min) errs.push("below-min");
        if (q.max !== undefined && value > q.max) errs.push("above-max");
      }
      break;
    case "rating":
      if (typeof value !== "number" || !Number.isInteger(value) || value < q.min || value > q.max) errs.push("out-of-scale");
      break;
    case "text":
      if (typeof value !== "string" || !value.trim()) errs.push("empty-text");
      break;
    case "allocation": {
      const alloc = q.allocation || {};
      if (!value || typeof value !== "object" || Array.isArray(value)) { errs.push("missing-cells"); break; }
      let sum = 0; let allNum = true;
      for (const row of q.rows || []) {
        const cell = value[row.code];
        if (typeof cell !== "number" || Number.isNaN(cell)) { errs.push("missing-cell:" + row.code); allNum = false; continue; }
        if (!Number.isInteger(cell)) { errs.push("non-integer-cell:" + row.code); allNum = false; continue; }
        const lo = row.min ?? alloc.rowMin ?? 0;
        const hi = row.max ?? alloc.rowMax ?? alloc.total;
        if (cell < lo) errs.push("row-below-min:" + row.code);
        if (cell > hi) errs.push("row-above-max:" + row.code);
        sum += cell;
      }
      if (allNum && alloc.enforceTotal !== false && sum !== alloc.total) errs.push("total-mismatch:" + sum);
      break;
    }
    default: errs.push("unsupported-type");
  }
  return errs;
}

/**
 * A document-side respondent session. Mirrors the forward-only semantics the
 * document describes; used to replay concrete answer sequences observed on
 * the site and predict what the site should have shown.
 */
export function createDRun(manifest) {
  const m = manifest;
  const loops = m.loops || [];
  const loopOf = (qid) => loops.find((l) => l.block.includes(qid)) || null;

  const steps = [];
  const placed = new Set();
  for (const q of m.questions) {
    const l = loopOf(q.id);
    if (l) { if (!placed.has(l.id)) { placed.add(l.id); steps.push({ loop: l.id }); } continue; }
    steps.push({ qid: q.id });
  }

  const answers = {};
  const visited = [];
  let pos = 0;
  let terminated = null;
  let completed = false;

  function expand(i) {
    const l = loops.find((x) => x.id === steps[i].loop);
    if (!l) { steps.splice(i, 1); return; }
    const src = qById(m, l.source);
    const sel = answers[l.source];
    const excl = l.exclude || [];
    let items = [];
    if (src && Array.isArray(sel)) {
      items = (src.options || []).filter((o) => sel.includes(o.code) && !excl.includes(o.code)).map((o) => o.code);
    }
    if (l.max !== undefined) items = items.slice(0, l.max);
    const out = [];
    for (const it of items) for (const b of l.block) out.push({ qid: b, item: it, loopId: l.id });
    steps.splice(i, 1, ...out);
  }

  function itemLabel(step) {
    if (step.item === undefined || step.item === null) return null;
    const l = loops.find((x) => x.id === step.loopId);
    const src = l ? qById(m, l.source) : null;
    const o = src ? (src.options || []).find((x) => x.code === step.item) : null;
    return o ? o.label : String(step.item);
  }

  function current() {
    if (terminated || completed) return null;
    let guard = 0;
    while (pos < steps.length && guard++ < 2000) {
      if (steps[pos].loop) { expand(pos); continue; }
      const q = qById(m, steps[pos].qid);
      if (!q) throw new Error("unknown question " + steps[pos].qid);
      const opts = expectedOptions(m, q, answers);
      if ((q.type === "radio" || q.type === "checkbox") && q.optionsFrom && opts.length === 0) { pos++; continue; }
      const lbl = itemLabel(steps[pos]);
      return {
        qid: q.id,
        key: steps[pos].item !== undefined ? `${q.id}[${steps[pos].item}]` : q.id,
        def: q,
        type: q.type,
        text: expectedText(m, answers, q.text, lbl),
        instruction: q.instruction ? expectedText(m, answers, q.instruction, lbl) : null,
        options: opts,
        min: q.min ?? null,
        max: q.max ?? null,
        rows: q.rows || [],
        allocation: q.allocation || null,
        randomize: q.randomize || null,
      };
    }
    completed = true;
    return null;
  }

  function forwardIndex(target) {
    for (let s = pos + 1; s < steps.length; s++) {
      if (steps[s].qid === target) return s;
      if (steps[s].loop) {
        const l = loops.find((x) => x.id === steps[s].loop);
        if (l && l.block.includes(target)) return s;
      }
    }
    return -1;
  }

  function answer(value) {
    const cur = current();
    if (!cur) return { ok: false, errors: ["ended"], to: null };
    const errs = expectedValidation(m, cur.def, cur.options, value);
    if (errs.length) return { ok: false, errors: errs, to: null };
    answers[cur.key] = value;
    visited.push(cur.key);
    const rlist = cur.def.rules || [];
    for (let ri = 0; ri < rlist.length; ri++) {
      const r = rlist[ri];
      if (!evalCond(m, answers, r.if)) continue;
      if (r.terminate) { terminated = { id: r.terminate }; return { ok: true, errors: [], to: "END:terminated", rule: r, ruleIndex: ri }; }
      if (r.goto) {
        const t = forwardIndex(r.goto);
        if (t === -1) return { ok: false, errors: ["dangling-goto:" + r.goto], to: null };
        pos = t;
        const nxt = current();
        return { ok: true, errors: [], to: nxt ? nxt.qid : (terminated ? "END:terminated" : "END:completed"), rule: r, ruleIndex: ri };
      }
    }
    pos += 1;
    const nxt = current();
    return { ok: true, errors: [], to: nxt ? nxt.qid : "END:completed", rule: null, ruleIndex: null };
  }

  /**
   * Force the document-side run to a given screen. Used by the trace differ to
   * RESYNC after a divergence: without it, the first defect on a journey masks
   * every later one.
   */
  function seekTo(qid) {
    for (let s = pos; s < steps.length; s++) {
      if (steps[s].loop) { expand(s); s--; continue; }
      if (steps[s].qid === qid) {
        pos = s;
        // deliberately resume a run the document had ended, so that a defect
        // early on a route does not hide every defect after it
        terminated = null;
        completed = false;
        return true;
      }
    }
    return false;
  }

  return {
    current, answer, seekTo,
    get answers() { return answers; },
    get visited() { return visited; },
    get terminated() { return terminated; },
  };
}
