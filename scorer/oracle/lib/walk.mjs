// walk.mjs — exhaustive branch walk, PORTED from test-suite/branching/
// validate.mjs (which does not export it and runs its whole check suite at
// import time, so importing was not an option).
//
// PORT CONTRACT: the enumeration logic (analyze / subsets / distribute /
// allocationCandidates / answerClassesFor / replay recursion, including the
// 20000-run cap) is copied VERBATIM from validate.mjs so the set of distinct
// routing paths is identical — selfcheck.mjs asserts path counts against
// corpus.json exactly as validate.mjs does. Do not "improve" the enumeration
// here; change validate.mjs first, then re-port.
//
// What this port ADDS (instrumentation only — it cannot change which paths
// are found): per distinct path, the visited sequence, the concrete answer
// vector (witness input), the outcome, and which branch edges fired. Edge
// attribution re-evaluates each question's rules with the SAME
// engine.evalCondition the engine itself uses (answer stored before rules
// run, first match wins), so it reproduces engine.answer()'s rule choice
// exactly.
import { engine } from "./corpus.mjs";
import { takenEdgeLocalId, defaultEdgeLocalId } from "./model.mjs";

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function questionById(manifest, qid) {
  return manifest.questions.find((q) => q.id === qid) || null;
}

// ---- verbatim from validate.mjs (answer-class analysis) --------------------
function collectConditions(manifest) {
  const out = [];
  const dig = (cond, qid) => {
    if (!cond) return;
    if (cond.op === "and" || cond.op === "or") (cond.terms || []).forEach((t) => dig(t, qid));
    else out.push({ cond, owner: qid });
  };
  for (const q of manifest.questions) for (const r of q.rules || []) dig(r.if, q.id);
  return out;
}

export function analyze(manifest) {
  const referencedQ = new Set();
  const thresholds = new Map(); // qid -> Set(values) for numeric answers
  const allocTargets = new Map(); // alloc qid -> [{refs:[rowCode...], value}]

  const noteAllocThreshold = (ref, value) => {
    const dot = ref.indexOf(".");
    if (dot === -1) return;
    const qid = ref.slice(0, dot);
    if (!allocTargets.has(qid)) allocTargets.set(qid, []);
    allocTargets.get(qid).push({ rows: [ref.slice(dot + 1)], value });
  };

  for (const { cond } of collectConditions(manifest)) {
    if (cond.q !== undefined) {
      const base = cond.q.split(".")[0];
      referencedQ.add(base);
      if (typeof cond.value === "number") {
        if (cond.q.includes(".")) {
          noteAllocThreshold(cond.q, cond.value);
        } else {
          if (!thresholds.has(base)) thresholds.set(base, new Set());
          thresholds.get(base).add(cond.value);
        }
      }
    }
    if (cond.var !== undefined) {
      const comp = (manifest.computed || []).find((x) => x.id === cond.var);
      if (comp && typeof cond.value === "number") {
        const refs = comp.expr?.refs || [];
        const byQ = new Map();
        for (const r of refs) {
          const dot = r.indexOf(".");
          if (dot === -1) continue;
          const qid = r.slice(0, dot);
          if (!byQ.has(qid)) byQ.set(qid, []);
          byQ.get(qid).push(r.slice(dot + 1));
        }
        for (const [qid, rows] of byQ) {
          referencedQ.add(qid);
          if (!allocTargets.has(qid)) allocTargets.set(qid, []);
          allocTargets.get(qid).push({ rows, value: cond.value });
        }
      }
    }
  }
  for (const loop of manifest.loops || []) referencedQ.add(loop.source);
  return { referencedQ, thresholds, allocTargets };
}

function subsets(codes) {
  const out = [];
  for (let mask = 1; mask < 1 << codes.length; mask++) {
    out.push(codes.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

/** Distribute `target` over `rows` (ordered) respecting each row's max. */
function distribute(rows, target, maxOf) {
  const out = {};
  let left = target;
  for (const r of rows) {
    const take = Math.min(left, maxOf(r));
    out[r] = take;
    left -= take;
  }
  return left === 0 ? out : null;
}

function allocationCandidates(manifest, q, analysis) {
  const alloc = q.allocation || {};
  const rows = (q.rows || []).map((r) => r.code);
  const maxOf = (code) => {
    const row = (q.rows || []).find((r) => r.code === code);
    return row?.max ?? alloc.rowMax ?? alloc.total;
  };
  const candidates = [];
  const push = (cells) => {
    if (!cells) return;
    const full = {};
    for (const r of rows) full[r] = cells[r] ?? 0;
    if (!candidates.some((c) => deepEqual(c, full))) candidates.push(full);
  };

  // Baselines: everything on the first row(s); even-ish split.
  push(distribute(rows, alloc.total, maxOf));
  const even = Math.floor(alloc.total / rows.length);
  const evenCells = {};
  let rem = alloc.total - even * rows.length;
  for (const r of rows) {
    evenCells[r] = Math.min(even, maxOf(r));
  }
  let sum = rows.reduce((s, r) => s + evenCells[r], 0);
  rem = alloc.total - sum;
  for (const r of rows) {
    if (rem <= 0) break;
    const room = maxOf(r) - evenCells[r];
    const add = Math.min(room, rem);
    evenCells[r] += add;
    rem -= add;
  }
  if (rem === 0) push(evenCells);

  // Threshold-directed candidates: for each derived/cell threshold, build one
  // allocation meeting it (sum(refs) = value) and one just missing it
  // (sum(refs) = value - 1), remainder spread over the other rows.
  for (const t of analysis.allocTargets.get(q.id) || []) {
    const others = rows.filter((r) => !t.rows.includes(r));
    for (const target of [t.value, Math.max(0, t.value - 1)]) {
      if (target > alloc.total) continue;
      const inRefs = distribute(t.rows, target, maxOf);
      const inOthers = distribute(others, alloc.total - target, maxOf);
      if (inRefs && inOthers) push({ ...inRefs, ...inOthers });
    }
  }
  return candidates;
}

export function answerClassesFor(manifest, cur, analysis) {
  const q = cur.question.def;
  const opts = cur.question.options;
  switch (q.type) {
    case "radio": {
      if (analysis.referencedQ.has(q.id)) return opts.map((o) => o.code);
      return [opts[0].code];
    }
    case "checkbox": {
      if (analysis.referencedQ.has(q.id)) {
        const exclusive = opts.filter((o) => o.exclusive).map((o) => o.code);
        const normal = opts.filter((o) => !o.exclusive).map((o) => o.code);
        return [...subsets(normal), ...exclusive.map((c) => [c])];
      }
      const first = opts.find((o) => !o.exclusive) || opts[0];
      return [[first.code]];
    }
    case "number":
    case "rating": {
      const th = analysis.thresholds.get(q.id);
      if (th && th.size) {
        const vals = new Set();
        for (const v of th) {
          for (const cand of [v - 1, v, v + 1]) {
            if (cand >= (q.min ?? -Infinity) && cand <= (q.max ?? Infinity)) vals.add(cand);
          }
        }
        return [...vals].sort((a, b) => a - b);
      }
      return [q.min ?? 0];
    }
    case "text":
      return ["Response text."];
    case "allocation":
      return allocationCandidates(manifest, q, analysis);
    default:
      throw new Error("no classes for type " + q.type);
  }
}

// ---- instrumentation (additive only) ---------------------------------------
/**
 * Recompute which branch edge fired at every answered step of a finished run,
 * using engine.evalCondition on the same answers-by-key map the engine built
 * (answer stored under cur.key BEFORE rules are evaluated; first match wins).
 */
function edgeLocalIdsForTrace(manifest, trace) {
  const answers = {};
  const hits = [];
  for (const step of trace) {
    answers[step.key] = step.value;
    const qdef = questionById(manifest, step.qid);
    const rules = (qdef && qdef.rules) || [];
    if (!rules.length) continue;
    let firedIdx = -1;
    for (let i = 0; i < rules.length; i++) {
      if (engine.evalCondition(manifest, answers, rules[i].if)) {
        firedIdx = i;
        break;
      }
    }
    hits.push(firedIdx === -1 ? defaultEdgeLocalId(step.qid) : takenEdgeLocalId(step.qid, rules, firedIdx));
  }
  return hits;
}

/**
 * Walk every routing path (identical enumeration to validate.mjs) and return
 * the distinct paths with witness data.
 *
 * Returns {
 *   runs,
 *   paths: [{ signature, visited, outcome, answers, edgeLocalIds }],  // sorted by signature
 *   reachedTerminates: Set, reachedQuestions: Set,                    // parity with validate.mjs
 * }
 */
export function walkAllPaths(manifest, label) {
  const analysis = analyze(manifest);
  const bySig = new Map();
  const reachedTerminates = new Set();
  const reachedQuestions = new Set();
  let runs = 0;

  function recordRun(run, trace) {
    const sig =
      run.state.visited.join(">") +
      "|" +
      (run.state.terminated ? "TERM:" + run.state.terminated.id : "COMPLETE");
    const edges = edgeLocalIdsForTrace(manifest, trace);
    let rec = bySig.get(sig);
    if (!rec) {
      rec = {
        signature: sig,
        visited: [...run.state.visited],
        outcome: run.state.terminated
          ? {
              kind: "terminate",
              terminateId: run.state.terminated.id,
              reason: run.state.terminated.reason,
              at: run.state.terminated.at,
            }
          : { kind: "complete" },
        answers: trace.map((t) => ({ key: t.key, qid: t.qid, value: t.value })),
        edgeSet: new Set(),
      };
      bySig.set(sig, rec);
    }
    // Edge hits are unioned across ALL runs sharing a signature (two runs can
    // share a visited sequence while exercising e.g. different boundary
    // values); the witness answer vector stays the first-seen run's.
    for (const e of edges) rec.edgeSet.add(e);
    if (run.state.terminated) reachedTerminates.add(run.state.terminated.id);
    for (const key of run.state.visited) reachedQuestions.add(key.replace(/\[.*$/, ""));
  }

  function replay(prefix) {
    const run = engine.createRun(manifest);
    runs++;
    if (runs > 20000) throw new Error(label + ": enumeration explosion (>20000 runs)");
    let i = 0;
    let cur;
    const answered = []; // every value given in THIS run, in order, so a
    // branch recursion replays single-class answers at the right positions
    const trace = [];
    while ((cur = run.current())) {
      let value;
      if (i < prefix.length) {
        value = prefix[i];
      } else {
        const classes = answerClassesFor(manifest, cur, analysis);
        if (!classes.length) throw new Error(`${label}: no answer classes for ${cur.key}`);
        if (classes.length > 1) {
          for (const c of classes) replay(answered.concat([c]));
          return;
        }
        value = classes[0];
      }
      const res = run.answer(value);
      if (!res.ok) {
        throw new Error(`${label}: engine rejected ${JSON.stringify(value)} at ${cur.key}: ${res.errors.join("; ")}`);
      }
      answered.push(value);
      trace.push({ key: cur.key, qid: cur.qid, value });
      i++;
      if (run.state.terminated) break;
    }
    recordRun(run, trace);
  }

  replay([]);

  const paths = [...bySig.values()]
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0))
    .map((rec) => ({
      signature: rec.signature,
      visited: rec.visited,
      outcome: rec.outcome,
      answers: rec.answers,
      edgeLocalIds: [...rec.edgeSet].sort(),
    }));
  return { runs, paths, reachedTerminates, reachedQuestions };
}
