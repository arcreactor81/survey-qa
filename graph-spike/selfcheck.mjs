// selfcheck.mjs — every self-consistency check a compiled questionnaire graph
// admits, WITHOUT reference to the live site. This is the "the model proposes,
// the structure checks" claim: if an extraction model builds the graph, how
// much of what it can plausibly get wrong does the graph's own internal
// coherence catch?
//
// Each check returns zero or more findings {code, severity, at, message}.
// Codes are stable so mutate.mjs can report which check caught which mutation.
import { condRefs, condToText } from "./compile-d.mjs";

export const CHECK_CATALOGUE = [
  ["C01", "dangling-goto", "a rule's goto target is not a question in the graph"],
  ["C02", "backward-goto", "a goto points at an earlier question in a forward-only instrument"],
  ["C03", "self-goto", "a rule routes a question to itself"],
  ["C04", "unreachable-node", "no answer assignment can reach this question"],
  ["C05", "unreachable-terminate", "a terminate rule whose guard can never be satisfied"],
  ["C06", "no-completion-path", "no path through the graph reaches normal completion"],
  ["C07", "goto-into-loop-block", "a goto lands inside a loop block from outside"],
  ["C08", "loop-malformed", "loop source missing/not multi-select/after its block, or block not contiguous"],
  ["C09", "loop-unbounded", "loop has no max and its source list is unbounded"],
  ["C10", "cycle-outside-loop", "goto edges form a cycle that is not a declared loop"],
  ["C11", "condition-code-not-in-options", "a routing condition cites an answer code absent from that question's option list"],
  ["C12", "condition-operator-type-mismatch", "operator is impossible for the referenced question's type"],
  ["C13", "condition-forward-reference", "a condition reads a question that comes later"],
  ["C14", "condition-unknown-reference", "a condition reads a question or computed variable that does not exist"],
  ["C15", "computed-ref-invalid", "a computed variable references a cell that does not exist"],
  ["C16", "duplicate-option-code", "an option list contains the same code twice"],
  ["C17", "duplicate-question-id", "two questions share an id"],
  ["C18", "empty-option-list", "a choice question has no options and no carry-forward source"],
  ["C19", "exclusive-in-single-select", "an exclusive flag on a single-select question"],
  ["C20", "anchor-code-missing", "randomisation anchors a code that is not in the option list"],
  ["C21", "carry-forward-invalid", "optionsFrom source missing, not multi-select, later, or excludes an unknown code"],
  ["C22", "piping-unresolvable", "a piping token names a question that does not exist or comes later; {LOOP} outside a loop"],
  ["C23", "allocation-infeasible", "row minima sum above the total, or row maxima sum below it"],
  ["C24", "threshold-unreachable-given-caps", "a numeric/derived threshold can never be met given the answer domain or row caps"],
  ["C25", "numeric-gate-outside-domain", "a gate on a numeric question lies outside that question's min/max"],
  ["C26", "shadowed-rule", "an earlier rule's guard subsumes a later rule's, so the later rule is dead"],
  ["C27", "rule-after-unconditional", "rules follow an unconditional rule and can never fire"],
  ["C28", "duplicate-rule-guard", "two rules on one question share a guard but route differently"],
  ["C29", "rule-malformed", "a rule has neither or both of goto/terminate"],
  ["C30", "rule-inside-loop-block", "a question inside a loop block carries routing rules"],
  ["C31", "numeric-domain-inverted", "min > max on a numeric or rating question"],
  ["C32", "orphan-terminate-id", "a terminate id declared in the register is produced by no rule"],
  ["C33", "unreferenced-computed", "a computed variable is defined but never used"],
  ["C34", "option-label-duplicate", "two options in one list carry the same label"],
];

const CODE_INFO = Object.fromEntries(CHECK_CATALOGUE.map(([c, n, d]) => [c, { name: n, desc: d }]));

export function runSelfChecks(manifest) {
  const F = [];
  const push = (code, at, message, extra = {}) => F.push({ code, name: CODE_INFO[code].name, at, message, ...extra });

  const qs = manifest.questions || [];
  const idx = new Map();
  qs.forEach((q, i) => { if (!idx.has(q.id)) idx.set(q.id, i); });
  const byId = new Map(qs.map((q) => [q.id, q]));
  const loops = manifest.loops || [];
  const computed = manifest.computed || [];
  const loopOf = (id) => loops.find((l) => l.block.includes(id)) || null;

  // C17 duplicate ids
  const seen = new Set();
  for (const q of qs) {
    if (seen.has(q.id)) push("C17", q.id, `question id ${q.id} appears more than once`);
    seen.add(q.id);
  }

  for (const q of qs) {
    const i = idx.get(q.id);

    // C16 / C34 option list coherence
    const codes = (q.options || []).map((o) => o.code);
    const dupCodes = codes.filter((c, k) => codes.indexOf(c) !== k);
    for (const c of new Set(dupCodes)) push("C16", q.id, `option code ${c} appears more than once`);
    const labels = (q.options || []).map((o) => o.label);
    for (const l of new Set(labels.filter((x, k) => labels.indexOf(x) !== k))) {
      push("C34", q.id, `option label "${l}" appears more than once`);
    }

    // C18 empty option list
    if ((q.type === "radio" || q.type === "checkbox") && !(q.options || []).length && !q.optionsFrom) {
      push("C18", q.id, `${q.type} question has no options`);
    }
    // C19 exclusive on a single-select
    if (q.type === "radio" && (q.options || []).some((o) => o.exclusive)) {
      push("C19", q.id, "exclusive option on a single-select question");
    }
    // C31 inverted numeric domain
    if ((q.type === "number" || q.type === "rating") && q.min !== undefined && q.max !== undefined && q.min > q.max) {
      push("C31", q.id, `min ${q.min} > max ${q.max}`);
    }
    // C20 anchors
    for (const c of q.randomize?.anchorLastCodes || []) {
      if (!codes.includes(c)) push("C20", q.id, `randomisation anchors code ${c}, which is not in the option list`);
    }
    if (q.randomize && !["shuffle", "rotate"].includes(q.randomize.mode)) {
      push("C20", q.id, `unknown randomisation mode "${q.randomize.mode}"`);
    }
    // C21 carry-forward
    if (q.optionsFrom) {
      const src = byId.get(q.optionsFrom.q);
      if (!src) push("C21", q.id, `carry-forward source ${q.optionsFrom.q} does not exist`);
      else {
        if (src.type !== "checkbox") push("C21", q.id, `carry-forward source ${src.id} is ${src.type}, not multi-select`);
        if (idx.get(src.id) >= i) push("C21", q.id, `carry-forward source ${src.id} does not precede ${q.id}`);
        for (const c of q.optionsFrom.exclude || []) {
          if (!(src.options || []).some((o) => o.code === c)) push("C21", q.id, `carry-forward excludes code ${c}, absent from ${src.id}`);
        }
      }
    }
    // C22 piping
    for (const src of [q.text, q.instruction]) {
      for (const mm of String(src || "").matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
        const tok = mm[1];
        if (tok === "LOOP") {
          if (!loopOf(q.id)) push("C22", q.id, "{LOOP} token outside any loop block");
          continue;
        }
        if (!byId.has(tok)) push("C22", q.id, `piping token {${tok}} names no question`);
        else if (idx.get(tok) >= i) push("C22", q.id, `piping token {${tok}} refers to a question at or after ${q.id}`);
      }
    }
    // C23 allocation feasibility
    if (q.type === "allocation") {
      const a = q.allocation || {};
      let lo = 0, hi = 0;
      for (const r of q.rows || []) {
        lo += r.min ?? a.rowMin ?? 0;
        hi += r.max ?? a.rowMax ?? a.total ?? 0;
      }
      if (a.total !== undefined && (lo > a.total || hi < a.total)) {
        push("C23", q.id, `total ${a.total} not achievable: row minima sum ${lo}, row maxima sum ${hi}`);
      }
      if (!(q.rows || []).length) push("C23", q.id, "allocation question has no rows");
    }
    // C30 rules inside a loop block
    if (loopOf(q.id) && (q.rules || []).length) {
      push("C30", q.id, `question is inside loop ${loopOf(q.id).id} but carries routing rules`);
    }

    // rules
    const rules = q.rules || [];
    let unconditionalAt = -1;
    rules.forEach((r, ri) => {
      const where = `${q.id} rule ${ri + 1}`;
      // C29 malformed
      if (!!r.goto === !!r.terminate) push("C29", q.id, `${where}: must have exactly one of goto/terminate`);
      // C01/C02/C03/C07 target
      if (r.goto) {
        if (!byId.has(r.goto)) push("C01", q.id, `${where}: goto ${r.goto} is not a question in the graph`);
        else {
          if (r.goto === q.id) push("C03", q.id, `${where}: routes to itself`);
          else if (idx.get(r.goto) < i) push("C02", q.id, `${where}: goto ${r.goto} points backwards`);
          const tl = loopOf(r.goto);
          if (tl && !loopOf(q.id)) push("C07", q.id, `${where}: goto ${r.goto} lands inside loop ${tl.id}`);
        }
      }
      // C13/C14/C11/C12 condition coherence
      for (const ref of condRefs(r.if)) {
        if (ref.startsWith("var:")) {
          const v = ref.slice(4);
          if (!computed.some((c) => c.id === v)) push("C14", q.id, `${where}: unknown computed variable ${v}`);
          continue;
        }
        if (!byId.has(ref)) { push("C14", q.id, `${where}: condition reads unknown question ${ref}`); continue; }
        if (idx.get(ref) > i) push("C13", q.id, `${where}: condition reads ${ref}, which comes later`);
      }
      for (const leaf of leaves(r.if)) {
        if (leaf.q === undefined) continue;
        const base = String(leaf.q).split(".")[0];
        const tq = byId.get(base);
        if (!tq) continue;
        const codedOps = ["eq", "ne", "includes", "notIncludes"];
        if ((tq.type === "radio" || tq.type === "checkbox") && codedOps.includes(leaf.op) && typeof leaf.value === "number") {
          const src = tq.optionsFrom ? byId.get(tq.optionsFrom.q) : tq;
          const pool = (src?.options || []).map((o) => o.code);
          if (pool.length && !pool.includes(leaf.value)) {
            push("C11", q.id, `${where}: condition cites code ${leaf.value}, absent from ${base}'s option list [${pool.join(",")}]`);
          }
        }
        const numericOps = ["lt", "lte", "gt", "gte"];
        const countOps = ["countLt", "countLte", "countGt", "countGte", "countEq"];
        const setOps = ["includes", "notIncludes"];
        if (numericOps.includes(leaf.op) && !String(leaf.q).includes(".") && !["number", "rating"].includes(tq.type)) {
          push("C12", q.id, `${where}: numeric operator ${leaf.op} on ${tq.type} question ${base}`);
        }
        if ((countOps.includes(leaf.op) || setOps.includes(leaf.op)) && tq.type !== "checkbox") {
          push("C12", q.id, `${where}: set/count operator ${leaf.op} on ${tq.type} question ${base}`);
        }
        // C25 gate outside domain
        if (numericOps.includes(leaf.op) && ["number", "rating"].includes(tq.type) && typeof leaf.value === "number") {
          const lo = tq.min, hi = tq.max;
          if (lo !== undefined && hi !== undefined) {
            const never =
              (leaf.op === "lt" && leaf.value <= lo) || (leaf.op === "lte" && leaf.value < lo) ||
              (leaf.op === "gt" && leaf.value >= hi) || (leaf.op === "gte" && leaf.value > hi);
            const always =
              (leaf.op === "lt" && leaf.value > hi) || (leaf.op === "lte" && leaf.value >= hi) ||
              (leaf.op === "gt" && leaf.value < lo) || (leaf.op === "gte" && leaf.value <= lo);
            if (never) push("C25", q.id, `${where}: guard ${condToText(leaf)} can never be true (domain ${lo}..${hi})`);
            else if (always) push("C25", q.id, `${where}: guard ${condToText(leaf)} is always true (domain ${lo}..${hi})`);
          }
        }
        // C24 derived threshold unreachable given row caps
        if (leaf.var !== undefined && typeof leaf.value === "number") {
          const c = computed.find((x) => x.id === leaf.var);
          if (c && c.expr?.op === "sum") {
            let maxSum = 0, ok = true;
            for (const ref of c.expr.refs || []) {
              const [qid, row] = String(ref).split(".");
              const aq = byId.get(qid);
              if (!aq || aq.type !== "allocation") { ok = false; break; }
              const rw = (aq.rows || []).find((r2) => r2.code === row);
              if (!rw) { ok = false; break; }
              maxSum += rw.max ?? aq.allocation?.rowMax ?? aq.allocation?.total ?? 0;
            }
            if (ok) {
              if ((leaf.op === "gte" && leaf.value > maxSum) || (leaf.op === "gt" && leaf.value >= maxSum)) {
                push("C24", q.id, `${where}: ${leaf.var} can never reach ${leaf.value} (max ${maxSum} given row caps)`);
              }
              if ((leaf.op === "lt" && leaf.value > maxSum) || (leaf.op === "lte" && leaf.value >= maxSum)) {
                push("C24", q.id, `${where}: ${leaf.var} < ${leaf.value} is always true (max ${maxSum} given row caps)`);
              }
            }
          }
        }
      }
      // C27 rules after an unconditional rule
      if (unconditionalAt >= 0) push("C27", q.id, `${where}: unreachable, rule ${unconditionalAt + 1} is unconditional`);
      if (!r.if || r.if.op === "always") unconditionalAt = ri;
      // C28 duplicate guards
      for (let rj = 0; rj < ri; rj++) {
        const other = rules[rj];
        if (JSON.stringify(other.if ?? null) === JSON.stringify(r.if ?? null)) {
          const sameTarget = (other.goto ?? other.terminate) === (r.goto ?? r.terminate);
          if (!sameTarget) push("C28", q.id, `${where}: same guard as rule ${rj + 1} but a different target`);
          else push("C26", q.id, `${where}: identical to rule ${rj + 1} and therefore dead`);
        }
      }
      // C26 simple subsumption on the same numeric ref (eg lt 20 before lt 10)
      for (let rj = 0; rj < ri; rj++) {
        const a = leaves(rules[rj].if), b = leaves(r.if);
        if (a.length !== 1 || b.length !== 1) continue;
        if (subsumes(a[0], b[0])) push("C26", q.id, `${where}: guard ${condToText(b[0])} is subsumed by earlier rule ${rj + 1} (${condToText(a[0])}) and is dead`);
      }
    });
  }

  // C15 computed refs / C33 unused computed
  const usedVars = new Set();
  for (const q of qs) for (const r of q.rules || []) for (const ref of condRefs(r.if)) if (ref.startsWith("var:")) usedVars.add(ref.slice(4));
  for (const c of computed) {
    for (const ref of c.expr?.refs || []) {
      const [qid, row] = String(ref).split(".");
      const aq = byId.get(qid);
      if (!aq) { push("C15", c.id, `computed ${c.id} references unknown question ${qid}`); continue; }
      if (row === undefined) { if (!["number", "rating"].includes(aq.type)) push("C15", c.id, `computed ${c.id} sums non-numeric question ${qid}`); continue; }
      if (aq.type !== "allocation") { push("C15", c.id, `computed ${c.id} references a row of ${qid}, which is ${aq.type}`); continue; }
      if (!(aq.rows || []).some((r2) => r2.code === row)) push("C15", c.id, `computed ${c.id} references row ${row}, absent from ${qid}`);
    }
    if (!usedVars.has(c.id)) push("C33", c.id, `computed variable ${c.id} is never used in any rule`);
  }

  // C08/C09 loops
  for (const l of loops) {
    const src = byId.get(l.source);
    if (!src) push("C08", l.id, `loop source ${l.source} does not exist`);
    else if (src.type !== "checkbox") push("C08", l.id, `loop source ${l.source} is ${src.type}, not multi-select`);
    const bIdx = (l.block || []).map((b) => idx.get(b));
    if (!l.block?.length || bIdx.some((x) => x === undefined)) push("C08", l.id, "loop block references unknown questions");
    else {
      if (src && idx.get(l.source) >= Math.min(...bIdx)) push("C08", l.id, "loop source does not precede its block");
      const sorted = [...bIdx].sort((a, b) => a - b);
      if (JSON.stringify(bIdx) !== JSON.stringify(sorted) || !sorted.every((v, k) => k === 0 || v === sorted[k - 1] + 1)) {
        push("C08", l.id, "loop block is not contiguous / in order");
      }
    }
    if (l.max !== undefined && l.max < 1) push("C08", l.id, `loop max ${l.max} < 1`);
    if (l.max === undefined) push("C09", l.id, "loop has no max: iteration count is bounded only by the source option list");
    for (const c of l.exclude || []) {
      if (src && !(src.options || []).some((o) => o.code === c)) push("C08", l.id, `loop excludes code ${c}, absent from ${l.source}`);
    }
  }

  // C04 / C05 / C06 / C10 — reachability over the symbolic graph
  const reach = symbolicReachability(manifest);
  for (const q of qs) if (!reach.nodes.has(q.id)) push("C04", q.id, "no route reaches this question");
  if (!reach.completion) push("C06", "(graph)", "no path reaches normal completion");
  for (const t of reach.deadTerminates) push("C05", t.at, `terminate "${t.id}" is unreachable: ${t.why}`);
  for (const c of reach.cycles) push("C10", c.join(" -> "), "goto edges form a cycle outside any declared loop");

  // C32 orphan terminate ids from an explicit register, if the document carries one
  const register = manifest.terminateRegister || manifest.terminates;
  if (Array.isArray(register)) {
    const produced = new Set();
    for (const q of qs) for (const r of q.rules || []) if (r.terminate) produced.add(r.terminate);
    for (const t of register) if (!produced.has(t.id ?? t)) push("C32", String(t.id ?? t), "terminate id in the register is produced by no rule");
  }

  return F;
}

function leaves(cond, out = []) {
  if (!cond) return out;
  if (cond.op === "and" || cond.op === "or") { (cond.terms || []).forEach((t) => leaves(t, out)); return out; }
  if (cond.op === "always") return out;
  out.push(cond);
  return out;
}

/** Does guard `a` imply guard `b` (so a later rule guarded by b is dead)? */
function subsumes(a, b) {
  if (a.q === undefined || b.q === undefined || a.q !== b.q) return false;
  if (typeof a.value !== "number" || typeof b.value !== "number") return false;
  const lt = ["lt", "lte"], gt = ["gt", "gte"];
  if (lt.includes(a.op) && lt.includes(b.op)) {
    const aHi = a.op === "lt" ? a.value - 1 : a.value;
    const bHi = b.op === "lt" ? b.value - 1 : b.value;
    return aHi >= bHi;
  }
  if (gt.includes(a.op) && gt.includes(b.op)) {
    const aLo = a.op === "gt" ? a.value + 1 : a.value;
    const bLo = b.op === "gt" ? b.value + 1 : b.value;
    return aLo <= bLo;
  }
  if (a.op === "eq" && b.op === "eq") return a.value === b.value;
  return false;
}

/**
 * Symbolic reachability over the routing graph. Optimistic: an edge is
 * traversable unless its guard is *provably* unsatisfiable in isolation.
 * That is deliberate — it makes C04/C05 sound in the direction that matters
 * (we never claim something is reachable when it is not... we claim it is
 * reachable when it might not be, so C04 under-reports rather than
 * over-reports).
 */
function symbolicReachability(manifest) {
  const qs = manifest.questions || [];
  const idx = new Map(qs.map((q, i) => [q.id, i]));
  const byId = new Map(qs.map((q) => [q.id, q]));
  const loops = manifest.loops || [];
  const loopOf = (id) => loops.find((l) => l.block.includes(id)) || null;

  const succ = new Map();
  const deadTerminates = [];
  for (const q of qs) {
    const out = [];
    let unconditional = false;
    for (const r of q.rules || []) {
      const sat = guardSatisfiable(manifest, byId, r.if);
      if (r.terminate) {
        if (!sat.ok) deadTerminates.push({ id: r.terminate, at: q.id, why: sat.why });
        else out.push("END:terminated");
      } else if (r.goto) {
        if (sat.ok) out.push(r.goto);
      }
      if ((!r.if || r.if.op === "always") && sat.ok) unconditional = true;
    }
    if (!unconditional) {
      const l = loopOf(q.id);
      if (l && l.block[l.block.length - 1] === q.id) {
        out.push(l.block[0]);
        const last = Math.max(...l.block.map((b) => idx.get(b)));
        out.push(last + 1 < qs.length ? qs[last + 1].id : "END:completed");
      } else {
        const i = idx.get(q.id);
        out.push(i + 1 < qs.length ? qs[i + 1].id : "END:completed");
      }
    }
    succ.set(q.id, out);
  }

  const start = qs[0]?.id;
  const nodes = new Set();
  let completion = false;
  const stack = start ? [start] : [];
  while (stack.length) {
    const n = stack.pop();
    if (String(n).startsWith("END:")) { if (n === "END:completed") completion = true; continue; }
    if (nodes.has(n)) continue;
    nodes.add(n);
    for (const s of succ.get(n) || []) {
      if (s === "END:completed") completion = true;
      stack.push(s);
    }
  }

  // cycles among goto edges that are not declared loops
  const cycles = [];
  const colour = new Map();
  const path = [];
  const declaredBack = new Set();
  for (const l of loops) declaredBack.add(l.block[l.block.length - 1] + "->" + l.block[0]);
  const dfs = (n) => {
    if (String(n).startsWith("END:")) return;
    if (colour.get(n) === 1) {
      const at = path.indexOf(n);
      const cyc = path.slice(at).concat([n]);
      const isDeclared = cyc.length >= 2 && declaredBack.has(cyc[cyc.length - 2] + "->" + n);
      if (!isDeclared) cycles.push(cyc);
      return;
    }
    if (colour.get(n) === 2) return;
    colour.set(n, 1); path.push(n);
    for (const s of succ.get(n) || []) dfs(s);
    path.pop(); colour.set(n, 2);
  };
  if (start) dfs(start);

  return { nodes, completion, deadTerminates, cycles };
}

function guardSatisfiable(manifest, byId, cond) {
  if (!cond || cond.op === "always") return { ok: true };
  if (cond.op === "and") {
    for (const t of cond.terms || []) { const r = guardSatisfiable(manifest, byId, t); if (!r.ok) return r; }
    return { ok: true };
  }
  if (cond.op === "or") {
    const rs = (cond.terms || []).map((t) => guardSatisfiable(manifest, byId, t));
    return rs.some((r) => r.ok) ? { ok: true } : { ok: false, why: "every disjunct is unsatisfiable" };
  }
  if (cond.q !== undefined) {
    const base = String(cond.q).split(".")[0];
    const q = byId.get(base);
    if (!q) return { ok: false, why: `references unknown question ${base}` };
    if ((q.type === "radio" || q.type === "checkbox") && ["eq", "includes"].includes(cond.op)) {
      const src = q.optionsFrom ? byId.get(q.optionsFrom.q) : q;
      const pool = (src?.options || []).map((o) => o.code);
      if (pool.length && !pool.includes(cond.value)) return { ok: false, why: `code ${cond.value} is not in ${base}'s option list` };
    }
    if (["number", "rating"].includes(q.type) && typeof cond.value === "number" && q.min !== undefined && q.max !== undefined) {
      if (cond.op === "lt" && cond.value <= q.min) return { ok: false, why: `< ${cond.value} is outside ${base}'s domain ${q.min}..${q.max}` };
      if (cond.op === "lte" && cond.value < q.min) return { ok: false, why: `<= ${cond.value} is outside ${base}'s domain` };
      if (cond.op === "gt" && cond.value >= q.max) return { ok: false, why: `> ${cond.value} is outside ${base}'s domain` };
      if (cond.op === "gte" && cond.value > q.max) return { ok: false, why: `>= ${cond.value} is outside ${base}'s domain` };
    }
  }
  return { ok: true };
}

/**
 * Self-consistency checks that apply to a graph RECOVERED FROM A SITE, with
 * no document at all. Much thinner than the document-side set, because a live
 * site cannot have a dangling goto — it either shows a screen or it does not.
 */
export function runSiteSelfChecks(graphS) {
  const F = [];
  const push = (code, at, message) => F.push({ code, at, message });
  for (const [id, n] of Object.entries(graphS.nodes || {})) {
    for (const v of n.renderVariants || []) {
      const tok = /\{[A-Za-z0-9_]+\}/.exec(v.text || "");
      if (tok) push("S01", id, `unresolved template token ${tok[0]} rendered as literal text`);
      const itok = /\{[A-Za-z0-9_]+\}/.exec(v.instruction || "");
      if (itok) push("S01", id, `unresolved template token ${itok[0]} in the instruction`);
      const codes = (v.options || []).map((o) => o.code);
      for (const c of new Set(codes.filter((x, i) => codes.indexOf(x) !== i))) {
        push("S02", id, `rendered option code ${c} appears twice`);
      }
      const labels = (v.options || []).map((o) => o.label);
      for (const l of new Set(labels.filter((x, i) => labels.indexOf(x) !== i))) {
        push("S03", id, `rendered option label "${l}" appears twice`);
      }
      if ((n.type === "radio" || n.type === "checkbox") && !(v.options || []).length) {
        push("S04", id, "choice screen rendered with no options");
      }
    }
    const outs = (graphS.edges || []).filter((e) => e.from === id);
    if (!outs.length) push("S05", id, "screen has no observed outgoing transition (dead end)");
  }
  if (!(graphS.endings || []).includes("END:completed")) push("S06", "(graph)", "no traversal reached normal completion");
  return F;
}

export function summariseChecks(findings) {
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] || 0) + 1;
  return byCode;
}
