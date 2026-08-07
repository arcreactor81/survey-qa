import type { StructureEdge, StructureModel } from "./types";

export interface EdgeCoverageResult {
  denominator: number;
  traversed: number;
  untouched: number;
  edges: Array<{
    from: string;
    to: string;
    trigger: string;
    traversed: boolean;
    exercisedSources: string[];
  }>;
}

export function computeEdgeCoverage(
  model: StructureModel,
  exercisedFacetIds: Set<string>,
): EdgeCoverageResult {
  const edges = model.edges.map((edge: StructureEdge) => {
    const exercisedSources = edge.sources.filter((sid) =>
      exercisedFacetIds.has(sid),
    );
    const traversed = exercisedSources.length > 0;
    return {
      from: edge.from,
      to: edge.to,
      trigger: `${edge.trigger.mode}:${edge.trigger.value}`,
      traversed,
      exercisedSources,
    };
  });

  const traversed = edges.filter((e) => e.traversed).length;
  const untouched = edges.length - traversed;

  return {
    denominator: edges.length,
    traversed,
    untouched,
    edges,
  };
}
