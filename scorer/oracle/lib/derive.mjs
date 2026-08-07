// derive.mjs — manifest -> ground-truth ObligationSet (internal repr).
//
// Taxonomy (aligned with docs/llm-led-architecture-proposal.md §3; each fact
// lives in exactly ONE obligation so clean/flawed content diffs are minimal
// and attributable):
//   question  — every question that can appear (identity, text, type, option
//               and row PRESENTATION lists; constraints live in rule obligations)
//   rule      — non-branch obligations: instructions, numeric ranges,
//               exclusive options, carry-forward lists, piping tokens,
//               randomization order + anchors, allocation sum/bounds/row caps,
//               loop definitions, computed variables
//   branch    — every branch EDGE: each rule's fired outcome (goto/terminate
//               taken) plus the question's default continue edge (all
//               conditional rules false). An unconditional rule always fires,
//               so no default edge (and no trailing edges) is emitted after it.
//   terminal  — every distinct terminate state + normal completion
// Reachability: attached from the exhaustive walk (walk.mjs, identical
// enumeration to validate.mjs) as witness path ids per obligation.
import { engine, describe, stripAnswerKey } from "./corpus.mjs";
import { makeObligation, takenEdgeLocalId, defaultEdgeLocalId, sortObligations, toObligationMap } from "./model.mjs";
import { walkAllPaths } from "./walk.mjs";

const TOKEN_RE = /\{([A-Za-z0-9_]+)\}/g;

function questionIndex(manifest, qid) {
  return manifest.questions.findIndex((q) => q.id === qid);
}

function loopForQuestion(manifest, qid) {
  return (manifest.loops || []).find((l) => l.block.includes(qid)) || null;
}

function optionLabel(q, code) {
  const opt = (q.options || []).find((o) => o.code === code);
  return opt ? opt.label : null;
}

function isUnconditional(rule) {
  return !rule.if || rule.if.op === "always";
}

/**
 * Derive the full obligation set for one manifest.
 * `manifestRaw` may carry the answer key (flawed variants); the derivation
 * always works on the stripped core so clean and flawed are comparable.
 */
export function deriveOracle(manifestRaw, { surveyId, variant, manifestPath, manifestSha256 }) {
  const manifest = stripAnswerKey(structuredClone(manifestRaw));
  const notes = [];
  const obligations = [];
  const add = (spec) => {
    const ob = makeObligation({ surveyId, ...spec });
    obligations.push(ob);
    return ob;
  };

  // ------------------------------------------------------------ questions --
  for (const q of manifest.questions) {
    const loop = loopForQuestion(manifest, q.id);
    const payload = {
      qid: q.id,
      section: q.section ?? null,
      qtype: q.type,
      text: q.text,
    };
    if (q.optionsFrom && q.options) {
      notes.push(`${q.id}: both options and optionsFrom present (engine uses optionsFrom); question payload keeps the static list`);
    }
    if (q.optionsFrom && !q.options) {
      payload.optionsMode = "carried-forward";
    } else if (q.options) {
      payload.optionsMode = "static";
      payload.options = q.options.map((o) => {
        const out = { code: o.code, label: o.label };
        if (o.exclusive) out.exclusive = true;
        return out;
      });
    }
    if (q.type === "allocation") {
      payload.rows = (q.rows || []).map((r) => ({ code: r.code, label: r.label }));
    }
    if (loop) payload.loopContext = { loopId: loop.id };
    add({
      localId: `question:${q.id}`,
      category: "question",
      type: "question",
      sourceRef: { qid: q.id },
      requirement: `${q.id}. ${describe.docText(manifest, q)}`,
      payload,
    });

    // -------------------------------------------------- non-branch rules ---
    if (q.instruction !== undefined) {
      add({
        localId: `rule:${q.id}:instruction`,
        category: "rule",
        type: "instruction",
        sourceRef: { qid: q.id },
        requirement: `[INSTRUCTION: ${q.instruction}]`,
        payload: { qid: q.id, text: q.instruction },
      });
    }

    if ((q.type === "number" || q.type === "rating") && (q.min !== undefined || q.max !== undefined)) {
      const bounds =
        q.min !== undefined && q.max !== undefined
          ? `BETWEEN ${q.min} AND ${q.max}`
          : q.min !== undefined
            ? `AT LEAST ${q.min}`
            : `AT MOST ${q.max}`;
      add({
        localId: `rule:${q.id}:range`,
        category: "rule",
        type: "validation-range",
        sourceRef: { qid: q.id },
        requirement: `${q.id}: ANSWER MUST BE A WHOLE NUMBER ${bounds}.`,
        payload: { qid: q.id, qtype: q.type, min: q.min ?? null, max: q.max ?? null, integer: true },
      });
    }

    for (const o of q.options || []) {
      if (o.exclusive) {
        add({
          localId: `rule:${q.id}:exclusive:${o.code}`,
          category: "rule",
          type: "validation-exclusive-option",
          sourceRef: { qid: q.id, optionCode: o.code },
          requirement: `${q.id}: '${String(o.label).toUpperCase()}' CANNOT BE COMBINED WITH OTHER SELECTIONS.`,
          payload: { qid: q.id, code: o.code, label: o.label },
        });
      }
    }

    if (q.optionsFrom) {
      const src = manifest.questions[questionIndex(manifest, q.optionsFrom.q)] || null;
      add({
        localId: `rule:${q.id}:carry-forward`,
        category: "rule",
        type: "carry-forward",
        sourceRef: { qid: q.id, sourceQid: q.optionsFrom.q },
        requirement: describe.optionsFromToText(manifest, q),
        payload: {
          qid: q.id,
          sourceQid: q.optionsFrom.q,
          exclude: q.optionsFrom.exclude || [],
          excludeLabels: (q.optionsFrom.exclude || []).map((c) => (src ? optionLabel(src, c) : null)),
        },
      });
    }

    // Piping: one obligation per RESOLVABLE token in text/instruction.
    const seenTokens = new Map(); // token -> fields it appears in
    for (const [field, s] of [["text", q.text], ["instruction", q.instruction]]) {
      if (typeof s !== "string") continue;
      for (const m of s.matchAll(TOKEN_RE)) {
        const token = m[1];
        if (!seenTokens.has(token)) seenTokens.set(token, []);
        seenTokens.get(token).push(field);
      }
    }
    const resolvableTokens = new Set();
    for (const [token, fields] of seenTokens) {
      if (token === "LOOP") {
        if (loop) {
          resolvableTokens.add(token);
          add({
            localId: `rule:${q.id}:piping:LOOP`,
            category: "rule",
            type: "piping",
            sourceRef: { qid: q.id, token: "LOOP", loopId: loop.id },
            requirement: `${q.id}: PIPE THE CURRENT ${loop.id} ITEM INTO THE ${fields.join(" AND ")}.`,
            payload: { qid: q.id, token: "LOOP", kind: "loop-item", loopId: loop.id, appearsIn: fields },
          });
        } else {
          notes.push(`${q.id}: {LOOP} token outside any loop block renders literally`);
        }
        continue;
      }
      const si = questionIndex(manifest, token);
      if (si !== -1 && si < questionIndex(manifest, q.id)) {
        resolvableTokens.add(token);
        add({
          localId: `rule:${q.id}:piping:${token}`,
          category: "rule",
          type: "piping",
          sourceRef: { qid: q.id, token, sourceQid: token },
          requirement: `${q.id}: PIPE THE ${token} SELECTION INTO THE ${fields.join(" AND ")}.`,
          payload: {
            qid: q.id,
            token,
            kind: "question-answer",
            sourceQid: token,
            appearsIn: fields,
            declaredNote: q.piping && q.piping.source === token ? q.piping.note ?? null : null,
          },
        });
      } else {
        notes.push(`${q.id}: piping token {${token}} does not resolve to an earlier question — the engine renders it literally`);
      }
    }
    if (q.piping && !resolvableTokens.has(q.piping.source)) {
      notes.push(`${q.id}: declared piping source ${q.piping.source} has no matching resolvable token in the question text`);
    }

    if (q.randomize) {
      const fakeOrderQ = { id: q.id, randomize: { mode: q.randomize.mode } };
      add({
        localId: `rule:${q.id}:randomize-order`,
        category: "rule",
        type: "randomize-order",
        sourceRef: { qid: q.id },
        requirement: describe.randomizeToText(manifest, fakeOrderQ),
        payload: {
          qid: q.id,
          mode: q.randomize.mode,
          // Deterministic per (seed, qid): the exact order the page renders.
          expectedOrderForSeed: q.options ? engine.resolveOptions(manifest, q, {}).map((o) => o.code) : null,
        },
      });
      if ((q.randomize.anchorLastCodes || []).length) {
        const labels = q.randomize.anchorLastCodes.map((c) => optionLabel(q, c));
        add({
          localId: `rule:${q.id}:randomize-anchor`,
          category: "rule",
          type: "randomize-anchor",
          sourceRef: { qid: q.id },
          requirement: `PROGRAMMER: ALWAYS KEEP ${labels.map((l) => `'${String(l).toUpperCase()}'`).join(", ")} LAST AT ${q.id}.`,
          payload: { qid: q.id, anchorLastCodes: q.randomize.anchorLastCodes, anchorLabels: labels },
        });
      }
    }

    if (q.type === "allocation") {
      const alloc = q.allocation || {};
      const lines = describe.allocationLines(q);
      if (alloc.enforceTotal !== false) {
        add({
          localId: `rule:${q.id}:alloc-sum`,
          category: "rule",
          type: "validation-allocation-sum",
          sourceRef: { qid: q.id },
          requirement: lines[0],
          payload: { qid: q.id, total: alloc.total },
        });
      }
      add({
        localId: `rule:${q.id}:alloc-bounds`,
        category: "rule",
        type: "validation-allocation-bounds",
        sourceRef: { qid: q.id },
        requirement: lines[1],
        payload: {
          qid: q.id,
          rowMin: alloc.rowMin ?? 0,
          rowMax: alloc.rowMax ?? alloc.total,
          integer: true,
          appliesToRows: (q.rows || []).map((r) => r.code),
        },
      });
      for (const row of q.rows || []) {
        if (row.min === undefined && row.max === undefined) continue;
        const line = lines.find((l) => l.startsWith(`ROW ${row.code} `));
        add({
          localId: `rule:${q.id}:alloc-row:${row.code}`,
          category: "rule",
          type: "validation-allocation-row",
          sourceRef: { qid: q.id, rowCode: row.code },
          requirement: line,
          payload: { qid: q.id, rowCode: row.code, label: row.label, min: row.min ?? null, max: row.max ?? null },
        });
      }
    }

    // ------------------------------------------------------ branch edges ---
    const rules = q.rules || [];
    const uncond = rules.findIndex(isUnconditional);
    const lastEmitted = uncond === -1 ? rules.length - 1 : uncond;
    if (uncond !== -1 && uncond < rules.length - 1) {
      notes.push(`${q.id}: rules after the unconditional rule ${uncond + 1} are unreachable and carry no obligations`);
    }
    for (let ri = 0; ri <= lastEmitted; ri++) {
      const rule = rules[ri];
      const conditionText = rule.if ? describe.conditionToText(manifest, rule.if) : "ALWAYS";
      const payload = {
        qid: q.id,
        kind: rule.terminate ? "terminate" : "goto",
        condition: rule.if ?? null,
        conditionText,
        evaluationOrder: ri + 1,
      };
      if (rule.terminate) {
        payload.terminateId = rule.terminate;
        payload.reason = rule.reason ?? null;
      } else {
        payload.target = rule.goto;
      }
      add({
        localId: takenEdgeLocalId(q.id, rules, ri),
        category: "branch",
        type: rule.terminate ? "terminate-taken" : "goto-taken",
        sourceRef: rule.terminate
          ? { qid: q.id, rule: { kind: "terminate", terminateId: rule.terminate } }
          : { qid: q.id, rule: { kind: "goto", target: rule.goto } },
        requirement: describe.ruleToText(manifest, rule),
        payload,
      });
    }
    if (rules.length > 0 && uncond === -1) {
      const qi = questionIndex(manifest, q.id);
      const next = qi + 1 < manifest.questions.length ? manifest.questions[qi + 1].id : "END";
      const nextLoop = next !== "END" ? loopForQuestion(manifest, next) : null;
      add({
        localId: defaultEdgeLocalId(q.id),
        category: "branch",
        type: "default-continue",
        sourceRef: { qid: q.id },
        requirement: `AFTER ${q.id}, IF NO SKIP/TERMINATE CONDITION APPLIES, CONTINUE TO ${next}${nextLoop ? ` (FIRST ITERATION OF LOOP ${nextLoop.id})` : ""}.`,
        payload: {
          qid: q.id,
          nextQid: next,
          viaLoopId: nextLoop ? nextLoop.id : null,
          negates: rules.map((r) => describe.conditionToText(manifest, r.if)),
        },
      });
    }
  }

  // ------------------------------------------------------ loops, computed --
  for (const loop of manifest.loops || []) {
    const src = manifest.questions[questionIndex(manifest, loop.source)] || null;
    add({
      localId: `rule:loop:${loop.id}`,
      category: "rule",
      type: "loop",
      sourceRef: { loopId: loop.id, sourceQid: loop.source },
      requirement: describe.loopToText(manifest, loop),
      payload: {
        loopId: loop.id,
        sourceQid: loop.source,
        exclude: loop.exclude || [],
        excludeLabels: (loop.exclude || []).map((c) => (src ? optionLabel(src, c) : null)),
        block: loop.block,
        max: loop.max ?? null,
      },
    });
  }
  for (const comp of manifest.computed || []) {
    add({
      localId: `rule:calc:${comp.id}`,
      category: "rule",
      type: "computed-value",
      sourceRef: { computedId: comp.id },
      requirement: describe.computedToText(manifest, comp),
      payload: {
        computedId: comp.id,
        label: comp.label ?? null,
        expr: comp.expr,
        refsText: (comp.expr?.refs || []).map((r) => describe.refToText(manifest, r)),
      },
    });
  }

  // ------------------------------------------------------------ terminals --
  const terminates = new Map(); // termId -> {reasons:Set, firedFrom:Set}
  for (const q of manifest.questions) {
    for (const r of q.rules || []) {
      if (!r.terminate) continue;
      if (!terminates.has(r.terminate)) terminates.set(r.terminate, { reasons: new Set(), firedFrom: new Set() });
      const t = terminates.get(r.terminate);
      if (r.reason) t.reasons.add(r.reason);
      t.firedFrom.add(q.id);
    }
  }
  for (const [termId, t] of terminates) {
    add({
      localId: `terminal:terminate:${termId}`,
      category: "terminal",
      type: "terminate-state",
      sourceRef: { terminateId: termId },
      requirement: `TERMINATION STATE '${termId}'${t.reasons.size ? ": " + [...t.reasons].sort().join(" / ") : ""}`,
      payload: { terminateId: termId, reasons: [...t.reasons].sort(), firedFromQids: [...t.firedFrom].sort() },
    });
  }
  add({
    localId: "terminal:complete",
    category: "terminal",
    type: "complete-state",
    sourceRef: { state: "complete" },
    requirement: "SURVEY REACHES THE NORMAL COMPLETION SCREEN.",
    payload: { state: "complete" },
  });

  // -------------------------------------------------------- walk + attach --
  const walk = walkAllPaths(manifest, `${surveyId} ${variant}`);
  const paths = walk.paths.map((p, i) => ({ pathId: `p${String(i + 1).padStart(3, "0")}`, ...p }));

  const visitMap = new Map(); // qid -> [pathId]
  const edgeMap = new Map(); // edgeLocalId -> [pathId]
  const outcomeMap = new Map(); // "terminate:<id>" | "complete" -> [pathId]
  for (const p of paths) {
    const qids = new Set(p.visited.map((k) => k.replace(/\[.*$/, "")));
    for (const qid of qids) {
      if (!visitMap.has(qid)) visitMap.set(qid, []);
      visitMap.get(qid).push(p.pathId);
    }
    for (const e of p.edgeLocalIds) {
      if (!edgeMap.has(e)) edgeMap.set(e, []);
      edgeMap.get(e).push(p.pathId);
    }
    const ok = p.outcome.kind === "terminate" ? `terminate:${p.outcome.terminateId}` : "complete";
    if (!outcomeMap.has(ok)) outcomeMap.set(ok, []);
    outcomeMap.get(ok).push(p.pathId);
  }

  // Owners of each computed var (questions whose rules reference it).
  const calcOwners = new Map();
  for (const q of manifest.questions) {
    for (const r of q.rules || []) {
      const dig = (c) => {
        if (!c) return;
        if (c.op === "and" || c.op === "or") (c.terms || []).forEach(dig);
        else if (c.var !== undefined) {
          if (!calcOwners.has(c.var)) calcOwners.set(c.var, new Set());
          calcOwners.get(c.var).add(q.id);
        }
      };
      dig(r.if);
    }
  }

  const problems = [];
  for (const ob of obligations) {
    let witnesses = [];
    switch (ob.category) {
      case "question":
        witnesses = visitMap.get(ob.payload.qid) || [];
        break;
      case "rule": {
        if (ob.type === "loop") {
          const set = new Set();
          for (const qid of ob.payload.block) for (const pid of visitMap.get(qid) || []) set.add(pid);
          witnesses = [...set].sort();
        } else if (ob.type === "computed-value") {
          const owners = calcOwners.get(ob.payload.computedId) || new Set();
          const set = new Set();
          for (const qid of owners) for (const pid of visitMap.get(qid) || []) set.add(pid);
          witnesses = [...set].sort();
          if (owners.size === 0) notes.push(`computed ${ob.payload.computedId} is never referenced by any rule`);
        } else {
          witnesses = visitMap.get(ob.payload.qid) || [];
        }
        break;
      }
      case "branch":
        witnesses = edgeMap.get(ob.localId) || [];
        break;
      case "terminal":
        witnesses =
          ob.type === "complete-state"
            ? outcomeMap.get("complete") || []
            : outcomeMap.get(`terminate:${ob.payload.terminateId}`) || [];
        break;
    }
    ob.reachable = witnesses.length > 0;
    ob.witnessPathIds = witnesses;
  }

  // Cross-checks: the walk must not hit edges/questions the taxonomy missed.
  const derivedEdgeIds = new Set(obligations.filter((o) => o.category === "branch").map((o) => o.localId));
  for (const e of edgeMap.keys()) {
    if (!derivedEdgeIds.has(e)) problems.push(`walk hit branch edge ${e} that derivation did not emit`);
  }
  const derivedQids = new Set(manifest.questions.map((q) => q.id));
  for (const qid of walk.reachedQuestions) {
    if (!derivedQids.has(qid)) problems.push(`walk visited unknown question ${qid}`);
  }

  const sorted = sortObligations(obligations);
  return {
    surveyId,
    variant,
    manifestPath,
    manifestSha256,
    title: manifest.title,
    seed: manifest.seed ?? null,
    questionCount: manifest.questions.length,
    obligations: sorted,
    obligationMap: toObligationMap(sorted),
    paths,
    walkRuns: walk.runs,
    notes,
    problems,
  };
}
