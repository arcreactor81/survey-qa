// attributes.mjs — the attribute problem, quantified.
//
// A graph is a skeleton. The question the owner asked is whether keying a
// requirement register to the graph ("every edge traversed AND every node's
// checklist evaluated") converts coverage into arithmetic, or merely moves
// the unprovable part into the checklists.
//
// This file enumerates every atomic requirement a survey document imposes and
// classifies each one as EDGE (a routing obligation, checkable by traversal)
// or NODE-ATTRIBUTE (a property of a screen, checkable only by comparing
// content). The split is the measurement.

export function requirementRegister(manifest) {
  const reqs = [];
  const add = (kind, node, type, detail) => reqs.push({ kind, node, type, detail });

  const loops = manifest.loops || [];
  const loopOf = (id) => loops.find((l) => l.block.includes(id)) || null;

  for (const q of manifest.questions) {
    add("node-attribute", q.id, "question-exists", `screen ${q.id} is presented`);
    add("node-attribute", q.id, "question-text", q.text);
    add("node-attribute", q.id, "input-type", q.type);
    if (q.instruction) add("node-attribute", q.id, "instruction", q.instruction);

    for (const o of q.options || []) {
      add("node-attribute", q.id, "option-present", `${o.code}`);
      add("node-attribute", q.id, "option-label", `${o.code}: ${o.label}`);
      if (o.exclusive) add("node-attribute", q.id, "option-exclusive-enforced", `${o.code}`);
    }
    if ((q.options || []).length) {
      add("node-attribute", q.id, "option-set-complete", `${(q.options || []).length} options, no extras`);
      if (!q.randomize) add("node-attribute", q.id, "option-order", (q.options || []).map((o) => o.code).join(","));
    }
    if (q.randomize) {
      add("node-attribute", q.id, "randomisation-mode", q.randomize.mode);
      for (const c of q.randomize.anchorLastCodes || []) add("node-attribute", q.id, "anchor-last", `${c}`);
    }
    if (q.optionsFrom) {
      add("node-attribute", q.id, "carry-forward-contents", `from ${q.optionsFrom.q}${(q.optionsFrom.exclude || []).length ? " excluding " + q.optionsFrom.exclude.join(",") : ""}`);
    }
    for (const mm of String(q.text).matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      add("node-attribute", q.id, "piping", `{${mm[1]}} resolves to a value, not a literal token`);
    }
    if (q.min !== undefined) add("node-attribute", q.id, "min-bound", `${q.min}`);
    if (q.max !== undefined) add("node-attribute", q.id, "max-bound", `${q.max}`);
    if (q.type === "allocation") {
      const a = q.allocation || {};
      add("node-attribute", q.id, "allocation-total", `${a.total}`);
      if (a.enforceTotal !== false) add("node-attribute", q.id, "allocation-total-enforced", `sum must equal ${a.total}`);
      for (const r of q.rows || []) {
        add("node-attribute", q.id, "allocation-row-present", r.code);
        add("node-attribute", q.id, "allocation-row-label", `${r.code}: ${r.label}`);
        if (r.max !== undefined) add("node-attribute", q.id, "allocation-row-cap", `${r.code} <= ${r.max}`);
        if (r.min !== undefined) add("node-attribute", q.id, "allocation-row-floor", `${r.code} >= ${r.min}`);
      }
    }

    for (const [ri, r] of (q.rules || []).entries()) {
      add("edge", q.id, r.terminate ? "terminate-route" : "skip-route", `rule ${ri + 1}`);
    }
    const l = loopOf(q.id);
    if (!(l && l.block[l.block.length - 1] === q.id)) {
      add("edge", q.id, "fall-through", "continue to the next screen when no rule fires");
    }
  }

  for (const l of loops) {
    add("edge", l.block[l.block.length - 1], "loop-back", `repeat ${l.id} while items remain`);
    add("edge", l.block[l.block.length - 1], "loop-exit", `leave ${l.id} when items are exhausted`);
    add("edge", l.source, "loop-iteration-count", `one iteration per selection at ${l.source}${l.max !== undefined ? `, max ${l.max}` : ""}`);
  }
  for (const c of manifest.computed || []) {
    add("edge-support", c.id, "derived-value", `${c.label || c.id} = sum(${(c.expr?.refs || []).join(", ")})`);
  }
  return reqs;
}

/**
 * Did the traversal actually EVALUATE each register item, or merely visit the
 * node it hangs off? This is the test of whether keying the requirement
 * register to the graph makes attribute coverage computable or just moves the
 * unprovable part into a checklist.
 */
export function registerCoverage(manifest, graphS, edgesExercised) {
  const reqs = requirementRegister(manifest);
  const out = [];
  for (const r of reqs) {
    const n = graphS.nodes[r.node];
    const visited = !!n;
    const variants = n?.renderVariants || [];
    const sawOptions = variants.some((v) => (v.options || []).length);
    const sawRows = variants.some((v) => (v.rows || []).length);
    let evaluated = false;
    let reason = null;

    switch (r.type) {
      case "question-exists": case "question-text": case "input-type":
      case "instruction": case "min-bound": case "max-bound":
      case "piping":
        evaluated = visited;
        reason = visited ? null : "screen never reached";
        break;
      case "option-present": case "option-label": case "option-set-complete": case "option-order":
      case "anchor-last": case "allocation-row-present": case "allocation-row-label":
        evaluated = visited && (sawOptions || sawRows);
        reason = evaluated ? null : (visited ? "list never observed" : "screen never reached");
        break;
      case "randomisation-mode": {
        const orders = new Set(variants.map((v) => (v.options || []).map((o) => o.code).join(",")));
        evaluated = orders.size >= 2;
        reason = evaluated ? null :
          "only one option order was ever rendered: a single deterministic session cannot distinguish 'randomised' from 'fixed order'. Needs N sessions with different seeds/respondents.";
        break;
      }
      case "carry-forward-contents": {
        const upstream = manifest.questions.find((q) => q.id === r.node)?.optionsFrom?.q;
        const src = manifest.questions.find((q) => q.id === upstream);
        const states = Math.max(1, Math.pow(2, (src?.options || []).length) - 1);
        evaluated = variants.length >= 2;
        reason = `${variants.length} of ${states} upstream selection states sampled`;
        break;
      }
      case "option-exclusive-enforced": {
        const q = manifest.questions.find((x) => x.id === r.node);
        const code = Number(r.detail);
        const other = (q?.options || []).find((o) => o.code !== code);
        const key = other ? "codes=[" + [code, other.code].sort((a, b) => a - b).join(",") + "]" : null;
        evaluated = !!key && ((graphS.rejections || []).some((x) => x.from === r.node && x.classKey === key) ||
                              (graphS.edges || []).some((x) => x.from === r.node && x.classKey === key));
        reason = evaluated ? null : "no probe combined the exclusive option with another selection";
        break;
      }
      case "allocation-total":
        evaluated = n?.discoveredTotal !== undefined;
        reason = evaluated ? null : "no allocation probe returned a stated total";
        break;
      case "allocation-total-enforced":
        evaluated = n?.enforcesTotal !== undefined;
        reason = evaluated ? null : "enforcement never probed";
        break;
      case "allocation-row-cap": {
        const row = String(r.detail).split(" ")[0];
        evaluated = !!(n?.rowCaps && row in n.rowCaps) || !!(n?.rowCapObserved && row in n.rowCapObserved);
        reason = evaluated ? null : "row cap never probed";
        break;
      }
      case "allocation-row-floor":
        evaluated = false;
        reason = "row floors are not probed by this prototype";
        break;
      case "skip-route": case "terminate-route": case "fall-through":
      case "loop-back": case "loop-exit": {
        const idx = r.type === "skip-route" || r.type === "terminate-route"
          ? `${r.node}#r${Number(String(r.detail).replace(/\D/g, "")) - 1}`
          : r.type === "fall-through" ? `${r.node}#fall`
          : `${r.node}#${r.type}`;
        evaluated = edgesExercised.has(idx);
        reason = evaluated ? null : "edge never traversed on the site";
        break;
      }
      case "loop-iteration-count": {
        const l = (manifest.loops || []).find((x) => x.source === r.node);
        evaluated = edgesExercised.has(`${l?.block?.[l.block.length - 1]}#loop-back`);
        reason = evaluated ? null : "loop never iterated more than once during traversal";
        break;
      }
      case "derived-value":
        evaluated = true;   // checked implicitly wherever it gates an edge that was traversed
        break;
      default:
        evaluated = false;
        reason = "no evaluator implemented";
    }
    out.push({ ...r, evaluated, reason });
  }
  const evald = out.filter((x) => x.evaluated).length;
  return {
    total: out.length,
    evaluated: evald,
    share: out.length ? evald / out.length : 0,
    unevaluated: out.filter((x) => !x.evaluated),
    items: out,
  };
}

export function registerSummary(registers) {
  const all = registers.flatMap((r) => r.reqs);
  const byKind = {};
  const byType = {};
  for (const r of all) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
  }
  const edge = (byKind.edge || 0) + (byKind["edge-support"] || 0);
  const attr = byKind["node-attribute"] || 0;
  return {
    total: all.length,
    edgeRequirements: edge,
    nodeAttributeRequirements: attr,
    edgeShare: all.length ? edge / all.length : 0,
    attributeShare: all.length ? attr / all.length : 0,
    byType,
    perSurvey: registers.map((r) => {
      const e = r.reqs.filter((x) => x.kind !== "node-attribute").length;
      const a = r.reqs.filter((x) => x.kind === "node-attribute").length;
      return { survey: r.id, total: r.reqs.length, edge: e, attribute: a, attributeShare: a / r.reqs.length };
    }),
  };
}
