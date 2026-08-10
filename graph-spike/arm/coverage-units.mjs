/**
 * COVERAGE UNITS — the arm's `coverage.claimedUnits`, and why they are computed.
 *
 * PRE-REGISTRATION.md §4.5 scores coverage HONESTY, not coverage:
 *
 *     claimed_exercised = { u : u.status === "exercised" }
 *     witnessed         = { u ∈ claimed_exercised : u.location ∈ harness_visit_log }
 *     coverage_honesty  = 1 − ( unwitnessed / claimed_exercised )
 *
 * and any condition below 1.0 has its coverage printed `UNWITNESSED-n` and cannot pass a
 * coverage gate. The harness owns the visit log; the arm cannot write it. So a unit's
 * `location` must be the identifier the HARNESS saw in the DOM (`data-qid`), not the one
 * the document used — which is why `alignIdentifiers` in entry.mjs runs before this does.
 *
 * The denominator is Graph-D's SYMBOLIC edge set plus the node-attribute register
 * (`graph-spike/coverage.mjs`, `graph-spike/attributes.mjs`): finite, computable and
 * traversal-independent, which is what makes coverage a number rather than a claim
 * (FINDINGS.md §5). The 11%/89% edge/attribute split from FINDINGS.md §6 shows up here
 * directly — most units are attributes, and on a real document most of THOSE are
 * `blocked`, because the shared extraction has no field to state them.
 *
 * THE RULE THAT KEEPS THIS HONEST: "evaluated" is not "verified". FINDINGS.md §6 —
 * "carry-forward at s3 Q2 counts as evaluated having sampled 9 of 31 upstream states. The
 * checklist ticks; the requirement is SAMPLED." Those units get verdict `inconclusive`,
 * never `pass`.
 */

import { symbolicEdgeIds } from "../coverage.mjs";
import { requirementRegister, registerCoverage } from "../attributes.mjs";
import { createDRun } from "../compile-d.mjs";
import { specToValue } from "../diff.mjs";

/** Which register item types a defect of a given requirement class would falsify. */
const CLASS_TOUCHES = {
  routing: ["skip-route", "terminate-route", "fall-through", "loop-back", "loop-exit"],
  terminate: ["terminate-route", "skip-route"],
  "question-presence-order": ["question-exists"],
  wording: ["question-text", "instruction"],
  "option-list": ["option-present", "option-label", "option-set-complete", "allocation-row-present", "allocation-row-label"],
  "option-order": ["option-order"],
  "scale-labels": ["option-label"],
  "randomisation-anchors": ["anchor-last", "randomisation-mode"],
  "exclusive-options": ["option-exclusive-enforced"],
  validation: ["min-bound", "max-bound", "allocation-total-enforced", "allocation-row-cap", "allocation-total"],
  piping: ["piping"],
  "carry-forward": ["carry-forward-contents"],
};

/**
 * Which symbolic edges the SITE traversal actually took. Lifted from `run-all.mjs`'s
 * `edgesExercisedBySite` so the arm's coverage arithmetic is the same arithmetic the
 * spike measured, not a re-derivation that could drift from it.
 */
export function edgesExercisedBySite(ir, graphS) {
  const taken = new Set();
  const loops = ir.loops || [];
  for (const j of graphS.journeys || []) {
    const run = createDRun(ir);
    for (const st of j.steps) {
      const cur = run.current();
      if (!cur || cur.qid !== st.from) { if (!cur || !run.seekTo(st.from)) break; }
      const res = run.answer(specToValue(st.spec));
      if (!res.ok) { if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) break; continue; }
      if (res.ruleIndex !== null && res.ruleIndex !== undefined) taken.add(`${st.from}#r${res.ruleIndex}`);
      else {
        const l = loops.find((x) => x.block.includes(st.from));
        if (l && l.block[l.block.length - 1] === st.from) taken.add(`${st.from}#${res.to === l.block[0] ? "loop-back" : "loop-exit"}`);
        else taken.add(`${st.from}#fall`);
      }
      if (res.to !== st.to) { if (String(st.to).startsWith("END:") || !run.seekTo(st.to)) break; }
    }
  }
  return taken;
}

/** Aspect of a register item, for the basis gate. */
function aspectOf(type) {
  if (["question-text", "instruction"].includes(type)) return "text";
  if (["option-present", "option-label", "option-set-complete", "carry-forward-contents"].includes(type)) return "options";
  if (["option-order", "anchor-last", "randomisation-mode"].includes(type)) return "optionOrder";
  if (["skip-route", "terminate-route", "fall-through", "loop-back", "loop-exit"].includes(type)) return "rules";
  if (type === "input-type") return "type";
  return null;
}

/** Units whose truth a single deterministic session can SAMPLE but never settle. */
const SAMPLED_ONLY = new Set(["carry-forward-contents", "randomisation-mode", "anchor-last", "loop-iteration-count", "option-order"]);

export function buildCoverageUnits({ ir, graphS, findings, budgetExhausted = false, blocked = false, basisOf }) {
  const units = [];
  const defectsAt = new Map();
  for (const f of findings) {
    if (f.claimClass !== "defect") continue;
    const loc = f.location.raw;
    if (!defectsAt.has(loc)) defectsAt.set(loc, []);
    defectsAt.get(loc).push(f);
  }
  const failsHere = (qid, types) => {
    const fs = defectsAt.get(qid) || [];
    return fs.some((f) => (CLASS_TOUCHES[f.requirementClass] || []).some((t) => types.includes(t)));
  };

  const push = (unitId, location, status, verdict, note) => {
    // Two-axis consistency, enforced by finding-schema.mjs: `exercised` requires a real
    // verdict, everything else requires `not-assessed`.
    if (status !== "exercised" && verdict !== "not-assessed") verdict = "not-assessed";
    if (status === "exercised" && verdict === "not-assessed") verdict = "inconclusive";
    units.push({ unitId, location, status, verdict, ...(note ? { note } : {}) });
  };

  if (blocked || !ir) {
    // Nothing was compared. Say so as a UNIT SET rather than as an empty list: an empty
    // claimedUnits array and a fully-blocked one are indistinguishable to a reader, and
    // one of them means "no problems" while the other means "no evidence".
    push("U-BLOCKED", "survey", "blocked", "not-assessed", "no Graph-D was produced; nothing was compared");
    return units;
  }

  const exercised = edgesExercisedBySite(ir, graphS);
  const visitedNodes = new Set(Object.keys(graphS.nodes || {}));

  // ---- edge units -------------------------------------------------------------------
  for (const e of symbolicEdgeIds(ir)) {
    const done = exercised.has(e.id);
    const basis = basisOf ? basisOf(e) : "stated";
    let status = done ? "exercised" : budgetExhausted ? "budget-exhausted" : "not-reached";
    let verdict = "not-assessed";
    let note = null;
    if (done) {
      if (failsHere(e.from, ["skip-route", "terminate-route", "fall-through", "loop-back", "loop-exit"])) verdict = "fail";
      else if (basis !== "stated") {
        verdict = "inconclusive";
        note = `traversed, but the document side of this edge is ${basis} (fall-through from document order), so agreement is weak evidence`;
      } else verdict = "pass";
    } else if (!visitedNodes.has(e.from)) {
      note = `${e.from} was never rendered, so this edge could not be attempted`;
    }
    push(`E:${e.id}`, e.from, status, verdict, note);
  }

  // ---- node-attribute units ---------------------------------------------------------
  const reg = registerCoverage(ir, graphS, exercised);
  const counters = new Map();
  for (const item of reg.items) {
    const n = (counters.get(`${item.node}:${item.type}`) || 0) + 1;
    counters.set(`${item.node}:${item.type}`, n);
    const unitId = `A:${item.node}:${item.type}:${n}`;

    /**
     * A COMPUTED VARIABLE IS NOT A SCREEN.
     *
     * `attributes.mjs` registers one `derived-value` item per computed variable, keyed by
     * the variable's id (`advancedShare`, `accessWeight`). Those ids can never appear in
     * the harness visit log, because the harness logs `data-qid` — so claiming them
     * `exercised` produced 4 UNWITNESSED units and dropped `coverage_honesty` to 0.9974,
     * which under §4.5 means this arm could not pass a coverage gate no matter how well it
     * worked. Found by running the harness's own honesty arithmetic against the smoke
     * output rather than by reasoning about it.
     *
     * The honest unit is: the variable is checked ONLY where it gates an edge that was
     * traversed. So it is located at the question whose rule reads it — a real screen the
     * harness can witness — and its verdict is `inconclusive`, never `pass`, because
     * traversing one edge that happens to depend on a sum does not verify the sum.
     */
    if (item.type === "derived-value") {
      const gatedBy = (ir.questions || []).find((q) =>
        (q.rules || []).some((r) => JSON.stringify(r.if || {}).includes(item.node)),
      );
      if (!gatedBy) {
        push(unitId, "survey", "blocked", "not-assessed",
          `computed value "${item.node}" gates no rule in Graph-D, so nothing this arm did could have exercised it`);
      } else if (!visitedNodes.has(gatedBy.id)) {
        push(unitId, gatedBy.id, "not-reached", "not-assessed", `the only screen whose routing reads "${item.node}" was never rendered`);
      } else {
        push(unitId, gatedBy.id, "exercised", "inconclusive",
          `checked only implicitly, wherever "${item.node}" gated a traversed edge at ${gatedBy.id}; ` +
          "traversing one such edge does not verify the computation");
      }
      continue;
    }
    const aspect = aspectOf(item.type);
    const basis = aspect && basisOf ? basisOf({ attribute: true, node: item.node, aspect }) : "stated";

    if (basis !== "stated" && basis !== undefined) {
      push(unitId, item.node, "blocked", "not-assessed",
        `the document side does not state this (basis: ${basis}); the arm records the requirement and declines to judge it`);
      continue;
    }
    if (!item.evaluated) {
      const status = /never reached/i.test(item.reason || "") ? "not-reached" : "blocked";
      push(unitId, item.node, status, "not-assessed", item.reason || null);
      continue;
    }
    const types = [item.type];
    const verdict = failsHere(item.node, types) ? "fail" : SAMPLED_ONLY.has(item.type) ? "inconclusive" : "pass";
    push(unitId, item.node, "exercised", verdict,
      SAMPLED_ONLY.has(item.type) ? item.reason || "sampled, not settled: one deterministic session cannot exhaust this requirement" : null);
  }

  return units;
}

/** Summary numbers for the arm's own report (never scored; §3.4). */
export function summariseUnits(units) {
  const by = (k) => units.reduce((a, u) => { a[u[k]] = (a[u[k]] || 0) + 1; return a; }, {});
  const exercised = units.filter((u) => u.status === "exercised");
  return {
    total: units.length,
    byStatus: by("status"),
    byVerdict: by("verdict"),
    exercisedShare: units.length ? exercised.length / units.length : 0,
    inconclusiveShare: exercised.length ? exercised.filter((u) => u.verdict === "inconclusive").length / exercised.length : 0,
  };
}
