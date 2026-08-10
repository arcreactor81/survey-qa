/**
 * FINDING MAPPER — spike diff output -> the pre-registered normalised format.
 *
 * `evaluation/finding-schema.mjs` validates this and `evaluation/score.mjs` scores it; the
 * mapping table below is the only place Arm B decides what one of its structural
 * disagreements MEANS in the shared 16-class vocabulary (PRE-REGISTRATION.md §2.1).
 *
 * Four rules govern everything here.
 *
 * 1. ONE OBSERVABLE CONSEQUENCE PER FINDING (§5.5). Splitting is the adapter's job; an
 *    unsplit finding is credited to one defect and the other is a MISS with no partial
 *    credit. So the mapper splits and lets duplicates be REDUNDANT (which costs nothing)
 *    rather than merging and paying UNDER_SPLIT.
 *
 * 2. A CLASS OUTSIDE THE 16 IS NEVER FORCED INTO THE NEAREST TOKEN (§2.1). Arm B can
 *    observe an input-TYPE mismatch — a documented radio rendered as a dropdown — and the
 *    owner's vocabulary has no token for it. It is emitted as an `observation` naming the
 *    taxonomy gap, not squeezed into `wording`.
 *
 * 3. BASIS GATES CLAIM CLASS. If the document side of a comparison was inferred rather
 *    than stated (`ir.mjs`), the disagreement is an `observation`. Asserting a defect on
 *    an inferred expectation is a confident wrong answer, which CLAUDE.md ranks as worse
 *    than a loud limitation.
 *
 * 4. OBSERVATIONS ARE AGGREGATED. §4.3 flags an arm as `HEDGING` when its observation
 *    volume exceeds half the key's requirement estimate, and hedging earns no recall. So
 *    every downgrade of a given (guard, class) collapses into ONE observation that names
 *    the loci in prose, rather than one observation per suppressed finding.
 */

import { attributeBasis, edgeBasis } from "./leaks.mjs";

const END_TERMINATED = "END:terminated";
const END_COMPLETED = "END:completed";

const isEnd = (t) => String(t ?? "").startsWith("END:");

/** MIS-ROUTE -> (requirementClass, predicate), by what the two ends of the edge ARE. */
export function classifyRoute(documented, observed) {
  const d = String(documented ?? "");
  const o = String(observed ?? "");
  if (d === END_TERMINATED && !isEnd(o)) return ["terminate", "terminate-not-triggered"];
  if (d === END_TERMINATED && o === END_COMPLETED) return ["terminate", "terminate-not-triggered"];
  if (o === END_TERMINATED && d !== END_TERMINATED) return ["terminate", "terminate-triggered-unexpectedly"];
  if (d === END_COMPLETED && !isEnd(o)) return ["question-presence-order", "element-present-unexpected"];
  if (o === END_COMPLETED && !isEnd(d)) return ["question-presence-order", "element-absent"];
  return ["routing", "route-destination-differs"];
}

export function makeMapper({ ir, graphS, guards, surveyId }) {
  const findings = [];
  const downgrades = new Map(); // "guardId|class" -> {reason, loci:Set}
  const taxonomyGaps = [];
  let seq = 0;
  const seen = new Map();

  const nodeOf = (qid) => (ir?.questions || []).find((q) => q.id === qid) || null;

  const noteDowngrade = (guardId, cls, reason, locus) => {
    const k = `${guardId}|${cls}`;
    if (!downgrades.has(k)) downgrades.set(k, { guardId, cls, reason, loci: new Set() });
    downgrades.get(k).loci.add(locus);
  };

  /** Emit one defect, after the basis gate and the leak guards have had their say. */
  const defect = ({ location, requirementClass, predicate, subject, expected, actual, prose, evidence, guard }) => {
    if (guard) {
      if (guard.action === "downgrade") {
        noteDowngrade(guard.id ?? "guard", requirementClass, guard.reason, location);
        return null;
      }
      if (guard.action === "reclassify") {
        requirementClass = guard.requirementClass ?? requirementClass;
        predicate = guard.predicate ?? predicate;
        prose = `${prose} [${guard.reason}]`;
      }
    }
    const key = `${location}|${requirementClass}|${predicate}|${expected ?? ""}|${actual ?? ""}`;
    if (seen.has(key)) {
      seen.get(key).evidence.push(...(evidence || []));
      return null;
    }
    seq += 1;
    const f = {
      findingId: `B${seq}`,
      claimClass: "defect",
      requirementClass,
      location: { raw: String(location), scope: "question" },
      observable: { predicate, subject: String(subject ?? location), expected: String(expected ?? ""), actual: String(actual ?? "") },
      attribution: "graph", // the only value arm B may emit (§3.3); anything else invalidates the run
      evidence: evidence || [],
      prose,
      confidence: null,
    };
    findings.push(f);
    seen.set(key, f);
    return f;
  };

  const observation = ({ location = "survey", scope = "survey", prose, evidence = [] }) => {
    seq += 1;
    findings.push({
      findingId: `B${seq}`,
      claimClass: "observation",
      location: { raw: String(location), scope },
      attribution: "graph",
      evidence,
      prose,
      confidence: null,
    });
  };

  const blocker = ({ location = "survey", scope = "survey", prose, evidence = [] }) => {
    seq += 1;
    findings.push({
      findingId: `B${seq}`,
      claimClass: "blocker",
      location: { raw: String(location), scope },
      attribution: "graph",
      evidence,
      prose,
      confidence: null,
    });
  };

  // ══════════════════════════════════════════════════════════ LEVEL B (stateful) ══
  /**
   * Trace replay is the SOUND comparison — decidable everywhere, unlike edge arithmetic
   * (FINDINGS.md §3 measures only 92.5% of site edges as locally decidable, 73% on s6).
   * It is mapped first so that when level A produces the same disagreement, the level A
   * copy dedupes into this one and inherits its stateful evidence.
   */
  const fromLevelB = (levelB) => {
    for (const f of levelB.findings || []) {
      const at = f.at;
      const ev = [{ kind: "trace", ref: `${surveyId}:${f.kind}@${at}${f.classKey ? `:${f.classKey}` : ""}` }];
      switch (f.kind) {
        case "MIS-ROUTE": {
          const basis = edgeBasis(ir, at, f.documented);
          const [cls, pred] = classifyRoute(f.documented, f.observed);
          if (basis !== "stated") {
            noteDowngrade(
              "DOC-02", cls,
              `the document side of this edge is a fall-through inferred from document order, not a stated rule (basis: ${basis}); ` +
                "a disagreement is evidence about the inference as much as about the site",
              at,
            );
            break;
          }
          defect({
            location: at, requirementClass: cls, predicate: pred,
            subject: `${at} ${f.classKey}`, expected: f.documented, actual: f.observed,
            prose: `Answering ${at} with ${f.classKey} leads to ${f.observed}; the document routes it to ${f.documented}. Observed on ${f.count} replayed journey(s).`,
            evidence: ev,
          });
          break;
        }
        case "SITE-CONTINUES-PAST-DOCUMENT-END":
          defect({
            location: at, requirementClass: "terminate", predicate: "terminate-not-triggered",
            subject: at, expected: "the interview ends here", actual: `the site presented ${at}`,
            prose: `The document's interview has ended by this point, but the site continued and presented ${at}.`,
            evidence: ev,
          });
          break;
        case "WRONG-SCREEN":
          defect({
            location: f.documented, requirementClass: "question-presence-order", predicate: "element-absent",
            subject: f.documented, expected: f.documented, actual: f.observed,
            prose: `The document places ${f.documented} at this point in the route; the site presented ${f.observed} instead.`,
            evidence: ev,
          });
          break;
        case "SITE-ACCEPTS-INVALID-ANSWER":
          defect({
            location: at, requirementClass: "validation", predicate: "constraint-not-enforced",
            subject: `${at} ${f.classKey}`,
            expected: `rejected (${(f.documentedErrors || []).join(", ")})`, actual: "accepted",
            prose: `${at} accepted ${f.classKey}, which the document forbids (${(f.documentedErrors || []).join(", ")}).`,
            evidence: ev,
          });
          break;
        case "SITE-REJECTS-VALID-ANSWER":
          defect({
            location: at, requirementClass: "validation", predicate: "constraint-over-enforced",
            subject: `${at} ${f.classKey}`, expected: "accepted", actual: `rejected (${(f.siteErrors || []).join(", ")})`,
            prose: `${at} rejected ${f.classKey}, which the document permits. Site said: ${(f.siteErrors || []).join(" / ")}`,
            evidence: ev,
          });
          break;
        default:
          taxonomyGaps.push({ kind: f.kind, at });
      }
    }
  };

  // ═══════════════════════════════════════════════════ LEVEL A (edge arithmetic) ══
  const fromLevelA = (levelA) => {
    for (const r of levelA.rows || []) {
      const ev = [{ kind: "graph-edge", ref: `${surveyId}:${r.verdict}@${r.from}${r.classKey ? `:${r.classKey}` : ""}` }];
      switch (r.verdict) {
        case "UNDECIDABLE":
          break; // reported in the coverage residue, never as a finding
        case "MIS-ROUTE": {
          const basis = edgeBasis(ir, r.from, r.documented);
          const [cls, pred] = classifyRoute(r.documented, r.observed);
          if (basis !== "stated") {
            noteDowngrade("DOC-02", cls, "fall-through edge inferred from document order", r.from);
            break;
          }
          defect({
            location: r.from, requirementClass: cls, predicate: pred,
            subject: `${r.from} ${r.classKey}`, expected: r.documented, actual: r.observed,
            prose: `Answering ${r.from} with ${r.classKey} leads to ${r.observed}; the document routes it to ${r.documented}.`,
            evidence: ev,
          });
          break;
        }
        case "SITE-ACCEPTS-INVALID":
          defect({
            location: r.from, requirementClass: "validation", predicate: "constraint-not-enforced",
            subject: `${r.from} ${r.classKey}`,
            expected: `rejected (${(r.documentedErrors || []).join(", ")})`, actual: `accepted, advanced to ${r.observed}`,
            prose: `${r.from} accepted ${r.classKey}, which the document forbids (${(r.documentedErrors || []).join(", ")}).`,
            evidence: ev,
          });
          break;
        case "MISSING-NODE":
          defect({
            location: r.from, requirementClass: "question-presence-order", predicate: "element-absent",
            subject: r.from, expected: "presented on some route", actual: "never rendered",
            prose: `The document defines ${r.from}; no traversal ever reached a screen with that identifier.`,
            evidence: ev, guard: { ...guards.carryForwardAutoSkip(r.from), id: "L2" },
          });
          break;
        case "UNDOCUMENTED-NODE":
          defect({
            location: r.from, requirementClass: "question-presence-order", predicate: "element-present-unexpected",
            subject: r.from, expected: "not in the document", actual: "rendered by the site",
            prose: `The site presented a screen identified ${r.from}; the document does not define it.`,
            evidence: ev,
          });
          break;
        case "MISSING-OPTION": {
          const n = nodeOf(r.from);
          const carried = Boolean(n?.optionsFrom);
          defect({
            location: r.from,
            requirementClass: carried ? "carry-forward" : "option-list",
            predicate: carried ? "set-differs" : "option-absent",
            subject: `${r.from} option ${r.code}`, expected: `${r.code}: ${r.label ?? ""}`, actual: "not rendered",
            prose: `Option ${r.code}${r.label ? ` ("${r.label}")` : ""} is documented at ${r.from} and was never rendered.`,
            evidence: ev,
          });
          break;
        }
        case "UNDOCUMENTED-OPTION": {
          const basis = attributeBasis(ir, r.from, "options");
          if (basis !== "stated") {
            // The shared extraction's option knowledge is a LOWER BOUND (assumption
            // DOC-03): only codes that trigger a route are typed. "The site has an option
            // the document does not" is therefore not decidable from it.
            noteDowngrade(
              "DOC-03", "option-list",
              `the arm's option list for ${r.from} is a lower bound (basis: ${basis}) — it holds only the codes that trigger a documented route, ` +
                "so an option it does not contain is not evidence the document omits it",
              r.from,
            );
            break;
          }
          const n = nodeOf(r.from);
          const carried = Boolean(n?.optionsFrom);
          defect({
            location: r.from,
            requirementClass: carried ? "carry-forward" : "option-list",
            predicate: carried ? "set-differs" : "option-present-unexpected",
            subject: `${r.from} option ${r.code}`, expected: "not in the documented list", actual: `rendered as code ${r.code}`,
            prose: `${r.from} rendered option ${r.code}, which the document does not define.`,
            evidence: ev,
          });
          break;
        }
        default:
          taxonomyGaps.push({ kind: r.verdict, at: r.from });
      }
    }
  };

  // ═════════════════════════════════════════════ LEVEL C (node attributes) ══
  const fromLevelC = (levelC) => {
    for (const f of levelC.findings || []) {
      const at = f.at;
      const ev = [{ kind: "dom", ref: `${surveyId}:${f.kind}@${at}` }];
      switch (f.kind) {
        case "TEXT-MISMATCH": {
          if (attributeBasis(ir, at, "text") !== "stated") {
            noteDowngrade("BASIS", "wording", `the arm has no stated question text for ${at}, so wording is not comparable`, at);
            break;
          }
          defect({
            location: at, requirementClass: "wording", predicate: "text-differs",
            subject: `${at} question text`, expected: f.documented, actual: f.observed,
            prose: `${at} renders "${f.observed}"; the document says "${f.documented}".`,
            evidence: ev, guard: { ...guards.pipingBeforeText(f), id: "L1" },
          });
          break;
        }
        case "INSTRUCTION-MISSING":
        case "INSTRUCTION-MISMATCH": {
          if (attributeBasis(ir, at, "text") !== "stated") {
            noteDowngrade("BASIS", "wording", `no stated instruction text for ${at}`, at);
            break;
          }
          defect({
            location: at, requirementClass: "wording", predicate: "text-differs",
            subject: `${at} instruction`, expected: f.documented ?? "(an instruction)", actual: f.observed ?? "(nothing)",
            prose: f.kind === "INSTRUCTION-MISSING"
              ? `${at} does not show its documented instruction ("${f.documented}").`
              : `${at} instruction differs: site "${f.observed}" vs document "${f.documented}".`,
            evidence: ev,
          });
          break;
        }
        case "OPTION-MISSING": {
          const n = nodeOf(at);
          const carried = Boolean(n?.optionsFrom);
          defect({
            location: at, requirementClass: carried ? "carry-forward" : "option-list",
            predicate: carried ? "set-differs" : "option-absent",
            subject: `${at} option ${f.code}`, expected: `${f.code}: ${f.label ?? ""}`, actual: "not rendered",
            prose: `Option ${f.code}${f.label ? ` ("${f.label}")` : ""} is documented at ${at} and was not rendered.`,
            evidence: ev,
          });
          break;
        }
        case "OPTION-UNDOCUMENTED": {
          if (attributeBasis(ir, at, "options") !== "stated") {
            noteDowngrade("DOC-03", "option-list", `option list at ${at} is a lower bound`, at);
            break;
          }
          const n = nodeOf(at);
          const carried = Boolean(n?.optionsFrom);
          defect({
            location: at, requirementClass: carried ? "carry-forward" : "option-list",
            predicate: carried ? "set-differs" : "option-present-unexpected",
            subject: `${at} option ${f.code}`, expected: "not in the documented list", actual: `${f.code}: ${f.label ?? ""}`,
            prose: `${at} rendered option ${f.code}${f.label ? ` ("${f.label}")` : ""}, which the document does not define.`,
            evidence: ev,
          });
          break;
        }
        case "OPTION-LABEL-MISMATCH":
          defect({
            location: at, requirementClass: "option-list", predicate: "text-differs",
            subject: `${at} option ${f.code} label`, expected: f.documented, actual: f.observed,
            prose: `${at} option ${f.code} is labelled "${f.observed}"; the document says "${f.documented}".`,
            evidence: ev,
          });
          break;
        case "OPTION-ORDER-MISMATCH":
          defect({
            location: at, requirementClass: "option-order", predicate: "option-order-differs",
            subject: `${at} option order`, expected: (f.documented || []).join(","), actual: (f.observed || []).join(","),
            prose: `${at} renders options in order ${(f.observed || []).join(",")}; the document lists ${(f.documented || []).join(",")}.`,
            evidence: ev, guard: { ...guards.optionOrderComparable(at), id: "L3" },
          });
          break;
        case "ANCHOR-VIOLATION":
          defect({
            location: at, requirementClass: "randomisation-anchors", predicate: "anchor-moved",
            subject: `${at} anchored options`, expected: `anchored last: ${(f.anchors || []).join(",")}`,
            actual: `observed order ${(f.observedOrder || []).join(",")}`,
            prose: `${at} is documented to anchor option(s) ${(f.anchors || []).join(",")} last; the rendered order was ${(f.observedOrder || []).join(",")}.`,
            evidence: ev,
          });
          break;
        case "MIN-MISMATCH":
        case "MAX-MISMATCH": {
          const tighter = f.kind === "MIN-MISMATCH" ? f.observed > f.documented : f.observed < f.documented;
          defect({
            location: at, requirementClass: "validation",
            predicate: tighter ? "constraint-over-enforced" : "constraint-not-enforced",
            subject: `${at} ${f.kind === "MIN-MISMATCH" ? "minimum" : "maximum"}`, expected: f.documented, actual: f.observed,
            prose: `${at} advertises ${f.kind === "MIN-MISMATCH" ? "min" : "max"}=${f.observed}; the document says ${f.documented}.`,
            evidence: ev,
          });
          break;
        }
        case "ALLOCATION-ROWS-MISMATCH":
          defect({
            location: at, requirementClass: "option-list", predicate: "set-differs",
            subject: `${at} allocation rows`, expected: (f.documented || []).join(","), actual: (f.observed || []).join(","),
            prose: `${at} renders allocation rows ${(f.observed || []).join(",")}; the document lists ${(f.documented || []).join(",")}.`,
            evidence: ev,
          });
          break;
        case "ALLOCATION-ROW-LABEL-MISMATCH":
          defect({
            location: at, requirementClass: "option-list", predicate: "text-differs",
            subject: `${at} row ${f.row} label`, expected: f.documented, actual: f.observed,
            prose: `${at} row ${f.row} is labelled "${f.observed}"; the document says "${f.documented}".`,
            evidence: ev,
          });
          break;
        case "TYPE-MISMATCH":
          // §2.1: a class outside the 16 is NEVER forced into the nearest token.
          taxonomyGaps.push({ kind: f.kind, at, documented: f.documented, observed: f.observed });
          break;
        default:
          taxonomyGaps.push({ kind: f.kind, at });
      }
    }
  };

  // ═════════════════════════════════════ LEVEL C PROBES (behaviour, not render) ══
  const fromLevelCProbes = (probes) => {
    for (const f of probes || []) {
      const at = f.at;
      const ev = [{ kind: "trace", ref: `${surveyId}:${f.kind}@${at}${f.row ? `:${f.row}` : ""}` }];
      switch (f.kind) {
        case "ALLOCATION-TOTAL-NOT-ENFORCED":
          defect({
            location: at, requirementClass: "validation", predicate: "constraint-not-enforced",
            subject: `${at} allocation total`, expected: `sum must equal ${f.documentedTotal}`, actual: "any sum accepted",
            prose: `${at} accepted an allocation whose rows do not sum to the documented total of ${f.documentedTotal}.`,
            evidence: ev,
          });
          break;
        case "ALLOCATION-TOTAL-MISMATCH":
          defect({
            location: at, requirementClass: "validation", predicate: "constraint-over-enforced",
            subject: `${at} allocation total`, expected: f.documented, actual: f.observed,
            prose: `${at} enforces a total of ${f.observed}; the document specifies ${f.documented}.`,
            evidence: ev,
          });
          break;
        case "ROW-CAP-NOT-ENFORCED":
          defect({
            location: at, requirementClass: "validation", predicate: "constraint-not-enforced",
            subject: `${at} row ${f.row} cap`, expected: `<= ${f.documentedMax}`, actual: "no cap enforced (probed to the full total)",
            prose: `${at} row ${f.row} is documented with a maximum of ${f.documentedMax}; bisection found no cap.`,
            evidence: ev,
          });
          break;
        case "ROW-CAP-MISMATCH":
          defect({
            location: at, requirementClass: "validation",
            predicate: f.observed < f.documented ? "constraint-over-enforced" : "constraint-not-enforced",
            subject: `${at} row ${f.row} cap`, expected: f.documented, actual: f.observed,
            prose: `${at} row ${f.row} caps at ${f.observed}; the document says ${f.documented}.`,
            evidence: ev,
          });
          break;
        case "EXCLUSIVE-NOT-ENFORCED":
          defect({
            location: at, requirementClass: "exclusive-options", predicate: "exclusivity-not-enforced",
            subject: `${at} option ${f.code}`, expected: "not selectable alongside another option",
            actual: "accepted together with another option",
            prose: `${at} accepted exclusive option ${f.code}${f.label ? ` ("${f.label}")` : ""} together with another selection.`,
            evidence: ev,
          });
          break;
        default:
          taxonomyGaps.push({ kind: f.kind, at });
      }
    }
  };

  /** Collapse the aggregated downgrades into a handful of observations. */
  const emitDowngradeObservations = () => {
    for (const d of downgrades.values()) {
      const loci = [...d.loci].filter(Boolean).sort();
      observation({
        location: loci.length === 1 ? loci[0] : "survey",
        scope: loci.length === 1 ? "question" : "survey",
        prose:
          `${loci.length} structural difference(s) classed ${d.cls} at ${loci.length ? loci.join(", ") : "(no locus)"} were NOT asserted as defects. ` +
          `${d.reason} They are reported here so that "checked and could not decide" is distinguishable from "never looked".`,
        evidence: loci.slice(0, 8).map((l) => ({ kind: "graph-edge", ref: `${surveyId}:downgraded:${d.guardId}@${l}` })),
      });
    }
    if (taxonomyGaps.length) {
      const byKind = taxonomyGaps.reduce((a, g) => { a[g.kind] = (a[g.kind] || 0) + 1; return a; }, {});
      observation({
        prose:
          `TAXONOMY GAP: ${taxonomyGaps.length} structural disagreement(s) have no token in the 16-class requirement vocabulary and were ` +
          `NOT forced into the nearest one (PRE-REGISTRATION.md §2.1): ` +
          Object.entries(byKind).map(([k, n]) => `${k} ×${n}`).join(", ") +
          `. Loci: ${[...new Set(taxonomyGaps.map((g) => g.at))].join(", ")}.`,
        evidence: taxonomyGaps.slice(0, 8).map((g) => ({ kind: "dom", ref: `${surveyId}:${g.kind}@${g.at}` })),
      });
    }
  };

  return {
    findings,
    defect, observation, blocker,
    fromLevelA, fromLevelB, fromLevelC, fromLevelCProbes,
    emitDowngradeObservations,
    stats: () => ({
      defects: findings.filter((f) => f.claimClass === "defect").length,
      observations: findings.filter((f) => f.claimClass === "observation").length,
      blockers: findings.filter((f) => f.claimClass === "blocker").length,
      downgradedGroups: downgrades.size,
      downgradedLoci: [...downgrades.values()].reduce((a, d) => a + d.loci.size, 0),
      taxonomyGaps: taxonomyGaps.length,
    }),
  };
}
