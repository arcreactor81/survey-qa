import type { StructureEdge, StructureModel } from "./types";

/**
 * Three-valued edge verdict: every StructureEdge is classified into exactly one of
 * these after comparing the document's obligation ledger against what the site
 * crawler actually observed.
 *
 * The four "not matched" cases come from document-processing-playbook.md §6.2c;
 * "matched" is the pass case (D ∩ S, not D ∖ S) — the edge was exercised and the
 * observed destination agreed with the document.
 */
export type EdgeVerdict = "matched" | "defect" | "not-reached" | "proven-unreachable" | "blocked" | "inconclusive";

export interface RouteDiffResult {
  /** Per-edge verdicts, keyed by the edge's canonical identity. */
  edges: Record<string, {
    edge: StructureEdge;
    verdict: EdgeVerdict;
    /** The observed destination, when the edge was attempted. */
    observedDestination?: string;
  }>;
  summary: {
    total: number;
    matched: number;
    defect: number;
    notReached: number;
    provenUnreachable: number;
    blocked: number;
    inconclusive: number;
  };
}

function edgeCanon(from: string, trigger: string, to: string): string {
  return `${from}\x00${trigger}\x00${to}`;
}

export function diffRoutes(
  model: StructureModel,
  exercisedFacetIds: Set<string>,
  observedRoutes: Map<string, string>,
  blockers: Set<string>,
): RouteDiffResult {
  const result: RouteDiffResult["edges"] = {};

  for (const edge of model.edges) {
    const canon = edgeCanon(edge.from, edge.trigger.value, edge.to);
    let verdict: EdgeVerdict;
    let observedDestination: string | undefined;

    if (edge.kind === "fallthrough") {
      verdict = "inconclusive";
    } else if (edge.sources.some((sid) => blockers.has(sid))) {
      verdict = "blocked";
    } else if (!edge.sources.some((sid) => exercisedFacetIds.has(sid))) {
      verdict = "not-reached";
    } else {
      const exercisedSources = edge.sources.filter((sid) => exercisedFacetIds.has(sid));
      let matched = false;
      let defect = false;

      for (const sid of exercisedSources) {
        const observed = observedRoutes.get(sid);
        if (observed === undefined) continue;
        observedDestination = observed;
        if (observed === edge.to) {
          matched = true;
        } else {
          defect = true;
        }
      }

      if (matched && !defect) {
        verdict = "matched";
      } else if (defect) {
        verdict = "defect";
      } else {
        verdict = "proven-unreachable";
      }
    }

    result[canon] = { edge, verdict, observedDestination };
  }

  const count = (v: EdgeVerdict) =>
    Object.values(result).filter((r) => r.verdict === v).length;

  return {
    edges: result,
    summary: {
      total: model.edges.length,
      matched: count("matched"),
      defect: count("defect"),
      notReached: count("not-reached"),
      provenUnreachable: count("proven-unreachable"),
      blocked: count("blocked"),
      inconclusive: count("inconclusive"),
    },
  };
}
