/**
 * THE MEASURED LEAKS, AS GUARDS.
 *
 * `graph-spike/FINDINGS.md` §3 enumerates 13 places where the comparison and a competent
 * human disagree. Five of them were paid for the expensive way — by nearly producing
 * false positives on a clean-vs-clean control, or by hiding six of seven findings on a
 * flawed survey. This file turns each of those five into a NAMED, ACTIVE guard with a
 * reported status, so the arm does not rediscover them and a reviewer can see which ones
 * fired on a given run.
 *
 * Two properties every guard here has, on purpose:
 *
 *  1. A guard NEVER deletes a finding. It reclassifies it — `defect` becomes
 *     `observation` with the reason attached. CLAUDE.md: "Report what was NOT covered
 *     rather than omitting it silently." A suppressed finding that leaves no trace is the
 *     same failure as a missed one, one level up.
 *
 *  2. A guard reports whether it FIRED. "We checked and it did not apply" and "we never
 *     looked" must be distinguishable, and a guard that has never fired on any corpus is
 *     a guard nobody has evidence works.
 */

/** Basis of the DOCUMENT side of one outgoing edge: was this route stated, or inferred? */
export function edgeBasis(ir, fromQid, documentedTarget) {
  const q = (ir.questions || []).find((x) => x.id === fromQid);
  if (!q) return "unknown";
  for (const r of q.rules || []) {
    if (r.goto && r.goto === documentedTarget) return r.__basis ?? ir.__basis?.routing ?? "stated";
    if (r.terminate && String(documentedTarget).startsWith("END:")) return r.__basis ?? ir.__basis?.routing ?? "stated";
  }
  // No rule produced this target, so it is the fall-through — which the shared extraction
  // has no field for and which is therefore derived from document order (assumption
  // DOC-02). See ir.mjs.
  return ir.__basis?.fallThrough ?? "inferred";
}

/** Basis of one node attribute. Aspects: text | type | options | optionOrder | rules. */
export function attributeBasis(ir, qid, aspect) {
  const q = (ir.questions || []).find((x) => x.id === qid);
  if (q?.__basis?.[aspect]) return q.__basis[aspect];
  const map = { text: "questionText", type: "questionText", options: "optionSet", optionOrder: "optionOrder", rules: "routing" };
  return ir.__basis?.[map[aspect] ?? aspect] ?? "unknown";
}

const PIPE_TOKEN = /\{([A-Za-z0-9_]+)\}/;

export function makeLeakGuards(ir) {
  const state = {
    L1: { fired: 0, reclassified: 0 },
    L2: { fired: 0 },
    L3: { fired: 0 },
    L4: { fired: 0, checked: 0, violations: [] },
    L5: { hiddenByFirstDivergence: null, resyncsUsed: null, resyncFailures: null },
  };

  const guards = {
    /**
     * L1 — PIPING MUST BE RESOLVED BEFORE TEXT COMPARISON.
     * FINDINGS.md: "Piped question text differs literally from the template ({Q2} vs
     * OZEMPIC) — fires on EVERY piped question unless piping is resolved first."
     *
     * `compile-d.mjs#expectedText` resolves it when the IR knows the piping source. When
     * it does not (a real questionnaire whose extraction carries piping as prose), the
     * documented text still holds a literal token and comparing it would fire on every
     * piped screen. Three outcomes, and only one of them is a defect.
     */
    pipingBeforeText(finding) {
      const doc = finding.documented ?? "";
      const obs = finding.observed ?? "";
      const docHasToken = PIPE_TOKEN.test(String(doc));
      const obsHasToken = PIPE_TOKEN.test(String(obs));

      if (docHasToken) {
        state.L1.fired += 1;
        return {
          action: "downgrade",
          reason:
            "the document side still carries an unresolved piping token, so this difference is evidence about the extraction's piping " +
            "resolution at least as much as about the site. Reported as an observation rather than a wording defect (FINDINGS.md §3, leak 1).",
        };
      }
      if (obsHasToken) {
        state.L1.fired += 1;
        state.L1.reclassified += 1;
        return {
          action: "reclassify",
          requirementClass: "piping",
          predicate: "raw-code-displayed",
          reason: "the SITE rendered a literal piping token where the document resolves to a value",
        };
      }
      return { action: "keep" };
    },

    /**
     * L2 — AN EMPTY CARRY-FORWARD LIST LEGITIMATELY AUTO-SKIPS A NODE.
     * FINDINGS.md: "A carry-forward question whose list resolves empty is legitimately
     * auto-skipped; arithmetic sees a documented node never visited."
     */
    carryForwardAutoSkip(qid) {
      const q = (ir.questions || []).find((x) => x.id === qid);
      if (!q?.optionsFrom) return { action: "keep" };
      state.L2.fired += 1;
      return {
        action: "downgrade",
        reason:
          `${qid} carries its option list forward from ${q.optionsFrom.q}. A screen whose carried list resolves empty is skipped BY DESIGN, ` +
          "so 'documented question never rendered' is not evidence of a defect here (FINDINGS.md §3, leak 2).",
      };
    },

    /**
     * L3 — RANDOMISED OPTION ORDER DIFFERS BY DESIGN.
     * FINDINGS.md: "survivable only because the register knows randomisation is permitted
     * there. The fix is more requirement metadata, not more graph."
     *
     * When the register does NOT know — which is the real-document case, since the shared
     * extraction has no field for randomisation — order is not comparable from a single
     * deterministic session at all (assumption SITE-06), and asserting a defect would be
     * a coin flip dressed as a finding.
     */
    optionOrderComparable(qid) {
      const basis = attributeBasis(ir, qid, "optionOrder");
      const q = (ir.questions || []).find((x) => x.id === qid);
      if (basis === "stated" && !q?.randomize) return { action: "keep" };
      state.L3.fired += 1;
      return {
        action: "downgrade",
        reason:
          basis === "stated"
            ? `${qid} is documented as randomised, so a different order is compliant`
            : `the document side does not state whether ${qid}'s option order is fixed (basis: ${basis}), and one deterministic session ` +
              "renders one order — 'randomised' and 'fixed' are indistinguishable from this evidence (FINDINGS.md §3, leak 3; assumption SITE-06).",
      };
    },

    /**
     * L4 — VALIDATION MASQUERADES AS ROUTING.
     * FINDINGS.md: "on flawed s5, 22 site edges exist for answers the document forbids;
     * to arithmetic they are ordinary edges whose targets then look like mis-routes.
     * Separating them needs an admissibility test BEFORE the comparison."
     *
     * `diff.mjs` already runs the admissibility test first in both level A and level B.
     * This guard is the CHECK THAT IT ACTUALLY HAPPENED: it is an assertion over the
     * finished finding set, and it can fail. A gate that cannot fail is the repo's
     * documented recurring bug (CLAUDE.md, "beware the check that cannot fail").
     */
    assertValidationSeparated(inadmissibleEdges, routingFindings) {
      state.L4.checked = routingFindings.length;
      for (const f of routingFindings) {
        const key = `${f.at}|${f.classKey}`;
        if (inadmissibleEdges.has(key)) {
          state.L4.violations.push(key);
        }
      }
      state.L4.fired = state.L4.violations.length;
      return {
        ok: state.L4.violations.length === 0,
        inadmissibleEdges: inadmissibleEdges.size,
        routingFindingsChecked: routingFindings.length,
        violations: state.L4.violations,
      };
    },

    /**
     * L5 — FIRST DIVERGENCE MASKS THE REST.
     * FINDINGS.md: "stopping at the first divergence found 1 finding on flawed s6;
     * resyncing found 7. Two defects were entirely hidden behind an upstream terminate
     * defect."  The arm always resyncs; this records the size of what resync recovered,
     * so the guard carries its own evidence rather than a claim.
     */
    recordResync(levelBWithResync, levelBWithoutResync) {
      state.L5.hiddenByFirstDivergence = levelBWithResync.findings.length - levelBWithoutResync.findings.length;
      state.L5.resyncsUsed = levelBWithResync.resyncsUsed;
      state.L5.resyncFailures = levelBWithResync.resyncFailures;
      return state.L5;
    },
  };

  const report = () => [
    {
      id: "L1", name: "piping-resolved-before-text-comparison", status: "active",
      leak: "piped question text differs literally from the template unless piping is resolved first",
      firedTimes: state.L1.fired, reclassifiedToPiping: state.L1.reclassified,
    },
    {
      id: "L2", name: "empty-carry-forward-is-a-legitimate-auto-skip", status: "active",
      leak: "a carry-forward question whose list resolves empty is skipped by design; arithmetic sees a documented node never visited",
      firedTimes: state.L2.fired,
    },
    {
      id: "L3", name: "option-order-not-comparable-from-one-session", status: "active",
      leak: "randomised option order differs by design, and a single deterministic session cannot tell randomised from fixed",
      firedTimes: state.L3.fired,
    },
    {
      id: "L4", name: "validation-admissibility-tested-before-edge-comparison", status: "asserted",
      leak: "edges for answers the document forbids read as ordinary edges whose targets then look like mis-routes",
      inadmissibleEdgesSeparated: state.L4.checked, violations: state.L4.violations,
      assertionHolds: state.L4.violations.length === 0,
    },
    {
      id: "L5", name: "trace-comparison-resyncs-after-divergence", status: "active",
      leak: "stopping at the first divergence hid 6 of 7 findings on one survey",
      findingsRecoveredByResync: state.L5.hiddenByFirstDivergence,
      resyncsUsed: state.L5.resyncsUsed, resyncFailures: state.L5.resyncFailures,
    },
  ];

  return { guards, state, report };
}
