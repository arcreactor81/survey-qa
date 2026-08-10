// mutate.mjs — the measurement that decides whether "the model proposes, the
// structure checks" is a real claim or a slogan.
//
// Method: take a KNOWN-CORRECT questionnaire graph, apply mutations of the
// kind an extraction model plausibly makes when reading prose ("IF Q2=2 SKIP
// TO Q5"), and record what fraction the self-consistency checks catch.
//
// Two guards against flattering numbers:
//  1. Every mutation is tested for BEHAVIOURAL OBSERVABILITY first — the
//     mutated graph is executed over the original's coverage journeys and its
//     full trace (routing + rendered node attributes + validation outcomes)
//     compared. A mutation that changes nothing observable is not a defect
//     and is excluded from the denominator.
//  2. "Caught" means a check fired on the mutated graph that did NOT fire on
//     the original. Checks that fire on the correct graph too are noise, not
//     detection.
import { runSelfChecks } from "./selfcheck.mjs";
import { createDRun } from "./compile-d.mjs";
import { edgeCoverageJourneys, valueOf } from "./coverage.mjs";

const clone = (x) => structuredClone(x);

// ------------------------------------------------------- observability ------
function traceFingerprint(manifest, journeys) {
  const out = [];
  for (const j of journeys) {
    const run = createDRun(manifest);
    const rec = [];
    for (const st of j.steps) {
      const cur = run.current();
      if (!cur) { rec.push("ENDED-EARLY"); break; }
      rec.push(JSON.stringify({
        q: cur.qid, t: cur.text, i: cur.instruction, ty: cur.type,
        o: cur.options.map((o) => [o.code, o.label, o.order]),
        mn: cur.min, mx: cur.max,
        r: (cur.rows || []).map((r) => [r.code, r.label, r.min ?? null, r.max ?? null]),
        a: cur.allocation ? [cur.allocation.total, cur.allocation.rowMin, cur.allocation.rowMax, cur.allocation.enforceTotal] : null,
        rz: cur.randomize ? [cur.randomize.mode, cur.randomize.anchorLastCodes] : null,
      }));
      let res;
      try { res = run.answer(valueOf(st.spec)); } catch (e) { rec.push("THROW:" + e.message); break; }
      rec.push(res.ok ? "->" + res.to : "REJ:" + res.errors.join(","));
      if (!res.ok) continue;
      if (String(res.to).startsWith("END:")) break;
    }
    out.push(rec.join("|"));
  }
  return out.join("\n");
}

// ---------------------------------------------------------- mutations -------
/** Each entry: {family, description, manifest} */
export function generateMutations(base, { perFamily = 3 } = {}) {
  const muts = [];
  const add = (family, description, fn) => {
    if (muts.filter((m) => m.family === family).length >= perFamily) return;
    const m = clone(base);
    let ok = true;
    try { ok = fn(m) !== false; } catch { ok = false; }
    if (ok) muts.push({ family, description, manifest: m });
  };

  const qs = base.questions;
  const ids = qs.map((q) => q.id);

  qs.forEach((q, qi) => {
    (q.rules || []).forEach((r, ri) => {
      if (r.goto) {
        const forward = ids.slice(qi + 1).filter((x) => x !== r.goto);
        if (forward.length) {
          add("goto-retargeted", `${q.id} rule ${ri + 1}: goto ${r.goto} -> ${forward[forward.length - 1]}`, (m) => {
            m.questions[qi].rules[ri].goto = forward[forward.length - 1];
          });
        }
        add("goto-hallucinated", `${q.id} rule ${ri + 1}: goto -> Q99 (id that does not exist)`, (m) => {
          m.questions[qi].rules[ri].goto = "Q99";
        });
        add("goto-backwards", `${q.id} rule ${ri + 1}: goto -> ${ids[0]} (backwards)`, (m) => {
          if (qi === 0) return false;
          m.questions[qi].rules[ri].goto = ids[0];
        });
        add("goto-self", `${q.id} rule ${ri + 1}: goto -> itself`, (m) => {
          m.questions[qi].rules[ri].goto = q.id;
        });
      }
      if (r.terminate) {
        add("terminate-dropped", `${q.id}: terminate rule ${ri + 1} not extracted`, (m) => {
          m.questions[qi].rules.splice(ri, 1);
        });
        add("terminate-becomes-skip", `${q.id} rule ${ri + 1}: terminate read as a skip`, (m) => {
          const target = ids[Math.min(qi + 2, ids.length - 1)];
          if (target === q.id) return false;
          delete m.questions[qi].rules[ri].terminate;
          m.questions[qi].rules[ri].goto = target;
        });
      }
      add("rule-dropped", `${q.id}: routing rule ${ri + 1} missed entirely`, (m) => {
        m.questions[qi].rules.splice(ri, 1);
      });
      const leaf = firstLeaf(r.if);
      if (leaf && typeof leaf.value === "number") {
        add("threshold-off-by-one", `${q.id} rule ${ri + 1}: ${leaf.op} ${leaf.value} -> ${leaf.value + 1}`, (m) => {
          setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.value = l.value + 1; });
        });
        add("threshold-wrong-value", `${q.id} rule ${ri + 1}: ${leaf.op} ${leaf.value} -> ${leaf.value - 2}`, (m) => {
          setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.value = l.value - 2; });
        });
        add("operator-boundary-flip", `${q.id} rule ${ri + 1}: ${leaf.op} -> strict/loose variant`, (m) => {
          const flip = { lt: "lte", lte: "lt", gt: "gte", gte: "gt" };
          setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { if (flip[l.op]) l.op = flip[l.op]; });
        });
        add("operator-direction-flip", `${q.id} rule ${ri + 1}: ${leaf.op} -> opposite direction`, (m) => {
          const flip = { lt: "gt", lte: "gte", gt: "lt", gte: "lte", eq: "ne", ne: "eq" };
          setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { if (flip[l.op]) l.op = flip[l.op]; });
        });
      }
      if (leaf && leaf.q !== undefined && !String(leaf.q).includes(".")) {
        const tq = qs.find((x) => x.id === String(leaf.q));
        const pool = (tq?.options || []).map((o) => o.code);
        if (pool.length > 1 && typeof leaf.value === "number" && pool.includes(leaf.value)) {
          const other = pool.find((c) => c !== leaf.value);
          add("condition-code-swapped-valid", `${q.id} rule ${ri + 1}: ${leaf.q}=${leaf.value} -> ${leaf.q}=${other}`, (m) => {
            setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.value = other; });
          });
          add("condition-code-not-in-list", `${q.id} rule ${ri + 1}: ${leaf.q}=${leaf.value} -> ${leaf.q}=77 (no such code)`, (m) => {
            setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.value = 77; });
          });
        }
        const earlier = ids.slice(0, qi).filter((x) => x !== String(leaf.q));
        if (earlier.length) {
          add("condition-question-swapped", `${q.id} rule ${ri + 1}: reads ${earlier[0]} instead of ${leaf.q}`, (m) => {
            setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.q = earlier[0]; });
          });
        }
        const later = ids.slice(qi + 1);
        if (later.length) {
          add("condition-forward-reference", `${q.id} rule ${ri + 1}: reads ${later[0]}, which comes later`, (m) => {
            setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.q = later[0]; });
          });
        }
        add("condition-unknown-question", `${q.id} rule ${ri + 1}: reads QZZ`, (m) => {
          setFirstLeaf(m.questions[qi].rules[ri].if, (l) => { l.q = "QZZ"; });
        });
      }
      if (r.if && (r.if.op === "and" || r.if.op === "or")) {
        add("and-or-flip", `${q.id} rule ${ri + 1}: ${r.if.op} -> ${r.if.op === "and" ? "or" : "and"}`, (m) => {
          m.questions[qi].rules[ri].if.op = r.if.op === "and" ? "or" : "and";
        });
      }
    });

    if ((q.rules || []).length >= 2) {
      add("rules-reordered", `${q.id}: rule order swapped (first-match-wins changes)`, (m) => {
        const rs = m.questions[qi].rules;
        [rs[0], rs[1]] = [rs[1], rs[0]];
      });
    }
    if ((q.rules || []).length >= 1) {
      add("unconditional-rule-inserted", `${q.id}: an unconditional skip inserted before the guarded rules`, (m) => {
        const target = ids[Math.min(qi + 2, ids.length - 1)];
        if (target === q.id) return false;
        m.questions[qi].rules.unshift({ goto: target });
      });
    }

    // option-list mutations
    if ((q.options || []).length > 1) {
      add("option-dropped", `${q.id}: option ${q.options[q.options.length - 1].code} missing from the extracted list`, (m) => {
        m.questions[qi].options.pop();
      });
      add("option-code-duplicated", `${q.id}: two options share code ${q.options[0].code}`, (m) => {
        m.questions[qi].options[1].code = m.questions[qi].options[0].code;
      });
      add("option-hallucinated", `${q.id}: an option that is not in the document`, (m) => {
        m.questions[qi].options.push({ code: 88, label: "Hallucinated option" });
      });
      add("option-label-wrong", `${q.id}: option ${q.options[0].code} label misread`, (m) => {
        m.questions[qi].options[0].label = m.questions[qi].options[0].label + " (misread)";
      });
      add("option-order-swapped", `${q.id}: first two options swapped`, (m) => {
        const o = m.questions[qi].options;
        [o[0], o[1]] = [o[1], o[0]];
      });
      if (q.options.some((o) => o.exclusive)) {
        add("exclusive-flag-dropped", `${q.id}: exclusive flag not extracted`, (m) => {
          for (const o of m.questions[qi].options) delete o.exclusive;
        });
      }
    }
    if (q.instruction) {
      add("instruction-dropped", `${q.id}: instruction "${q.instruction.slice(0, 30)}..." not extracted`, (m) => {
        delete m.questions[qi].instruction;
      });
    }
    if (q.randomize?.anchorLastCodes?.length) {
      add("anchor-dropped", `${q.id}: anchor-last not extracted`, (m) => {
        delete m.questions[qi].randomize.anchorLastCodes;
      });
      add("anchor-code-wrong", `${q.id}: anchors a code that is not in the list`, (m) => {
        m.questions[qi].randomize.anchorLastCodes = [12345];
      });
    }
    if (q.randomize) {
      add("randomize-dropped", `${q.id}: randomisation not extracted`, (m) => {
        delete m.questions[qi].randomize;
      });
    }
    if (q.optionsFrom) {
      add("carry-forward-source-wrong", `${q.id}: carry-forward source misread`, (m) => {
        const alt = qs.slice(0, qi).find((x) => x.type === "checkbox" && x.id !== q.optionsFrom.q);
        m.questions[qi].optionsFrom.q = alt ? alt.id : "QZZ";
      });
      add("carry-forward-dropped", `${q.id}: carry-forward read as a static list`, (m) => {
        const src = qs.find((x) => x.id === q.optionsFrom.q);
        m.questions[qi].options = clone(src?.options || []);
        delete m.questions[qi].optionsFrom;
      });
    }
    if (q.type === "allocation") {
      add("allocation-total-wrong", `${q.id}: constant-sum total misread`, (m) => {
        m.questions[qi].allocation.total = 10;
      });
      add("allocation-enforcement-dropped", `${q.id}: "must sum to N" read as guidance`, (m) => {
        m.questions[qi].allocation.enforceTotal = false;
      });
      const capped = (q.rows || []).findIndex((r) => r.max !== undefined);
      if (capped >= 0) {
        add("row-cap-dropped", `${q.id}: per-row cap on ${q.rows[capped].code} not extracted`, (m) => {
          delete m.questions[qi].rows[capped].max;
        });
        add("row-cap-wrong", `${q.id}: per-row cap on ${q.rows[capped].code} misread`, (m) => {
          m.questions[qi].rows[capped].max = 5;
        });
      }
      add("allocation-infeasible", `${q.id}: every row capped below what the total needs`, (m) => {
        for (const r of m.questions[qi].rows) r.max = 1;
      });
      add("allocation-row-dropped", `${q.id}: a row missing from the table`, (m) => {
        if ((m.questions[qi].rows || []).length < 3) return false;
        m.questions[qi].rows.pop();
      });
    }
    if ((q.type === "number" || q.type === "rating") && q.min !== undefined && q.max !== undefined) {
      add("numeric-bounds-wrong", `${q.id}: range misread`, (m) => {
        m.questions[qi].max = q.min + Math.max(1, Math.floor((q.max - q.min) / 4));
      });
      add("numeric-bounds-inverted", `${q.id}: min and max swapped`, (m) => {
        m.questions[qi].min = q.max; m.questions[qi].max = q.min;
      });
    }
    if (/\{[A-Za-z0-9_]+\}/.test(q.text)) {
      add("piping-token-broken", `${q.id}: piping token mangled`, (m) => {
        m.questions[qi].text = q.text.replace(/\{([A-Za-z0-9_]+)\}/, "{$1drug}");
      });
      add("piping-token-retargeted", `${q.id}: piping token points at a later question`, (m) => {
        const later = ids.slice(qi + 1)[0];
        if (!later) return false;
        m.questions[qi].text = q.text.replace(/\{([A-Za-z0-9_]+)\}/, "{" + later + "}");
      });
    }
    if (qi > 1 && qi < qs.length - 1) {
      add("question-dropped", `${q.id}: question missing from the extraction`, (m) => {
        if ((m.loops || []).some((l) => l.block.includes(q.id) || l.source === q.id)) return false;
        if (qs.some((x) => (x.rules || []).some((r) => r.goto === q.id))) return false;
        if (qs.some((x) => x.optionsFrom?.q === q.id)) return false;
        m.questions.splice(qi, 1);
      });
      add("question-id-duplicated", `${q.id}: id collides with ${ids[qi - 1]}`, (m) => {
        m.questions[qi].id = ids[qi - 1];
      });
      add("question-order-swapped", `${q.id} and ${ids[qi + 1]} extracted in the wrong order`, (m) => {
        const a = m.questions[qi], b = m.questions[qi + 1];
        if ((m.loops || []).some((l) => l.block.includes(a.id) || l.block.includes(b.id) || l.source === a.id || l.source === b.id)) return false;
        m.questions[qi] = b; m.questions[qi + 1] = a;
      });
      add("question-type-wrong", `${q.id}: ${q.type} read as the wrong control`, (m) => {
        if (q.type === "radio") { m.questions[qi].type = "checkbox"; }
        else if (q.type === "checkbox") { m.questions[qi].type = "radio"; }
        else if (q.type === "number") { m.questions[qi].type = "text"; }
        else return false;
      });
      add("question-text-wrong", `${q.id}: wording misread`, (m) => {
        m.questions[qi].text = q.text.replace(/\?$/, " (misread)?");
        if (m.questions[qi].text === q.text) m.questions[qi].text = q.text + " (misread)";
      });
    }
  });

  for (const [li, l] of (base.loops || []).entries()) {
    add("loop-max-wrong", `loop ${l.id}: max ${l.max} read as 1`, (m) => { m.loops[li].max = 1; });
    add("loop-max-dropped", `loop ${l.id}: max not extracted`, (m) => { delete m.loops[li].max; });
    add("loop-source-wrong", `loop ${l.id}: source misread`, (m) => { m.loops[li].source = "QZZ"; });
    add("loop-block-wrong", `loop ${l.id}: block extended past its end`, (m) => {
      const last = l.block[l.block.length - 1];
      const i = base.questions.findIndex((q) => q.id === last);
      const nxt = base.questions[i + 2];
      if (!nxt) return false;
      m.loops[li].block = l.block.concat([nxt.id]);
    });
    add("loop-dropped", `loop ${l.id}: loop instruction missed entirely`, (m) => { m.loops.splice(li, 1); });
  }

  for (const [ci, c] of (base.computed || []).entries()) {
    const refs = c.expr?.refs || [];
    if (refs.length) {
      const [qid, row] = String(refs[0]).split(".");
      const aq = base.questions.find((x) => x.id === qid);
      const other = (aq?.rows || []).find((r) => r.code !== row);
      if (other) {
        add("computed-ref-wrong-row", `computed ${c.id}: sums ${row} instead of ${other.code}`, (m) => {
          m.computed[ci].expr.refs[0] = `${qid}.${other.code}`;
        });
      }
      add("computed-ref-invalid", `computed ${c.id}: references a row that does not exist`, (m) => {
        m.computed[ci].expr.refs[0] = `${qid}.rZZ`;
      });
      add("computed-ref-extra-row", `computed ${c.id}: an extra row summed in`, (m) => {
        const extra = (aq?.rows || []).find((r) => r.code !== row);
        if (!extra) return false;
        m.computed[ci].expr.refs.push(`${qid}.${extra.code}`);
      });
    }
  }

  return muts;
}

function firstLeaf(cond) {
  if (!cond) return null;
  if (cond.op === "and" || cond.op === "or") {
    for (const t of cond.terms || []) { const l = firstLeaf(t); if (l) return l; }
    return null;
  }
  if (cond.op === "always") return null;
  return cond;
}
function setFirstLeaf(cond, fn) {
  if (!cond) return false;
  if (cond.op === "and" || cond.op === "or") {
    for (const t of cond.terms || []) if (setFirstLeaf(t, fn)) return true;
    return false;
  }
  if (cond.op === "always") return false;
  fn(cond);
  return true;
}

// ------------------------------------------------------------ measure -------
export function measureCatchRate(manifests, { perFamily = 3 } = {}) {
  const rows = [];
  for (const { id, manifest } of manifests) {
    const journeys = edgeCoverageJourneys(manifest);
    const baseTrace = traceFingerprint(manifest, journeys);
    const baseFindings = new Set(runSelfChecks(manifest).map((f) => f.code + "@" + f.at + "@" + f.message));
    for (const mut of generateMutations(manifest, { perFamily })) {
      let mutTrace = null, threw = null;
      try { mutTrace = traceFingerprint(mut.manifest, journeys); } catch (e) { threw = e.message; }
      const observable = threw !== null || mutTrace !== baseTrace;
      const findings = runSelfChecks(mut.manifest).filter((f) => !baseFindings.has(f.code + "@" + f.at + "@" + f.message));
      rows.push({
        survey: id,
        family: mut.family,
        description: mut.description,
        observable,
        crashes: threw,
        caught: findings.length > 0,
        codes: [...new Set(findings.map((f) => f.code))],
      });
    }
  }

  const obs = rows.filter((r) => r.observable);
  const byFamily = {};
  for (const r of obs) {
    byFamily[r.family] ??= { n: 0, caught: 0, codes: new Set() };
    byFamily[r.family].n++;
    if (r.caught) { byFamily[r.family].caught++; r.codes.forEach((c) => byFamily[r.family].codes.add(c)); }
  }
  const familyTable = Object.entries(byFamily)
    .map(([family, v]) => ({ family, n: v.n, caught: v.caught, rate: v.caught / v.n, codes: [...v.codes].sort() }))
    .sort((a, b) => a.rate - b.rate || a.family.localeCompare(b.family));

  return {
    total: rows.length,
    observable: obs.length,
    unobservable: rows.length - obs.length,
    caught: obs.filter((r) => r.caught).length,
    catchRate: obs.length ? obs.filter((r) => r.caught).length / obs.length : 0,
    familyTable,
    rows,
  };
}
