/**
 * Compile a StructureModel from the SEALED contract revision.
 *
 * Deterministic, model-free. Runs at ingestion time (the document-processing-playbook
 * §6 recommendation: "compile graph-D once, at ingestion, as a first-class artifact")
 * and at planning time (so the executor has a reachability map).
 *
 * The compiler reads exactly two things from the sealed contract:
 *   1. FacetInstances with typed cases — the specific routing rules the extractor
 *      materialized (routeAnswer + expectedDestination, boundary inputs).
 *   2. ScopedRequirements — for the question category and human-readable context.
 *
 * What it DOES NOT do: query any model, read the document, or look at the site.
 * Everything it emits comes verbatim from the sealed contract.
 */

import type { ContractRevision, FacetInstance, ScopedRequirement } from "../types/record";
import type { StructureEdge, StructureModel, StructureNode } from "./types";
import { STRUCTURE_MODEL_KIND } from "./types";

/**
 * Edge identity: a canonical string so we can deduplicate edges that emerge from
 * different facet instances but describe the same routing commitment.
 */
function edgeCanon(from: string, trigger: StructureEdge["trigger"], to: string): string {
  return `${from}\x00${trigger.mode}\x00${trigger.value}\x00${to}`;
}

/** RouteAnswer + ExpectedDestination → a concrete edge. */
interface ResolvedEdge {
  from: string;
  to: string;
  kind: "route" | "terminate";
  trigger: StructureEdge["trigger"];
  source: string; // facetInstanceId
}

function resolveEdges(instances: FacetInstance[]): ResolvedEdge[] {
  const edges: ResolvedEdge[] = [];
  const seen = new Set<string>();

  for (const fi of instances) {
    const c = fi.case;
    const from = fi.targetQuestionId;
    if (!from) continue;

    // ---- ROUTE ----
    if (c.kind === "route" && c.routeAnswer) {
      const code = c.routeAnswer.code;
      const label = c.routeAnswer.label;
      const dest = c.expectedDestination;
      if (!code && !label) continue;

      let to: string;
      let kind: "route" | "terminate";

      if (dest && dest.terminal) {
        to = `TERMINATE:${dest.terminal}`;
        kind = "terminate";
      } else if (dest && dest.questionId) {
        to = dest.questionId;
        kind = "route";
      } else if (dest && dest.screen) {
        to = dest.screen;
        kind = "route";
      } else {
        // A route with no destination bound — the expander left it as an expectation
        // gap. The edge exists (the document says there IS a route) but cannot be
        // resolved to a destination. Record it as an edge to an unknown target.
        to = "UNBOUND";
        kind = "route";
      }

      const trigger = code
        ? { mode: "code" as const, value: code }
        : { mode: "label" as const, value: label! };

      const canon = edgeCanon(from, trigger, to);
      if (seen.has(canon)) {
        // Same edge from a different facet instance — append the source id, don't
        // create a duplicate edge. The diff dedupes across facetInstances.
        const existing = edges.find((e) => edgeCanon(e.from, e.trigger, e.to) === canon);
        if (existing) existing.source = `${existing.source},${fi.facetInstanceId}`;
        continue;
      }

      seen.add(canon);
      edges.push({ from, to, kind, trigger, source: fi.facetInstanceId });
    }

  }

  return edges;
}

/**
 * Collect all unique (code, label) option pairs from the route answers attached to
 * a given question.
 */
function collectOptions(instances: FacetInstance[], questionId: string): StructureNode["options"] {
  const seen = new Set<string>();
  const opts: StructureNode["options"] = [];
  for (const fi of instances) {
    if (fi.targetQuestionId !== questionId) continue;
    const ra = fi.case.routeAnswer;
    if (!ra) continue;
    const key = `${ra.code ?? "\x00"}|${ra.label ?? "\x00"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push({ code: ra.code, label: ra.label });
  }
  return opts;
}

/**
 * Build a human-ordered sequence of question ids from the contract.
 *
 * Order is determined by first-mention across the signed items, same logic as
 * `pipeline/judge/lib/document-model.mjs#screenOrder`.
 */
function buildOrder(requirements: ScopedRequirement[], instances: FacetInstance[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (qid: string | null | undefined): void => {
    const normalized = qid?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    order.push(normalized);
  };

  // Structured scope is the document-order source. Unlike a prose regex, this works
  // for any identifier the extractor sealed and does not infer ids from incidental text.
  for (const requirement of requirements) {
    const prefix = "question:";
    if (requirement.scope.startsWith(prefix)) add(requirement.scope.slice(prefix.length));
  }

  for (const fi of instances) {
    add(fi.targetQuestionId);
  }

  // A question may only be named as a destination and have no facet instance of its
  // own. It is still a graph node; omitting it would leave a dangling route edge.
  for (const fi of instances) {
    const destination = fi.case.expectedDestination;
    if (destination?.terminal) continue;
    add(destination?.questionId ?? destination?.screen);
  }

  return order;
}

/**
 * Is this question a terminal destination? True if any edge from anywhere targets
 * a terminal state and names this question as the source.
 */
function isTerminalQuestion(instances: FacetInstance[], edges: ResolvedEdge[], questionId: string): boolean {
  const questionEdges = edges.filter((e) => e.from === questionId);
  if (questionEdges.length === 0) {
    return instances.some(
      (fi) =>
        fi.targetQuestionId === questionId &&
        fi.case.expectedDestination?.terminal !== null &&
        fi.case.expectedDestination?.terminal !== undefined,
    );
  }
  return !questionEdges.some((e) => e.kind !== "terminate" && e.to !== "UNBOUND");
}

/**
 * COMPILE THE DOCUMENT GRAPH from a sealed contract revision.
 *
 * Returns null only when the revision has no questions to graph (empty contract).
 */
export function compileStructureModel(revision: ContractRevision): StructureModel | null {
  const instances = revision.facetInstances ?? [];
  const requirements = revision.requirements ?? [];

  // ---- edges (the primary data) ----
  const edges = resolveEdges(instances);

  // ---- nodes ----
  const order = buildOrder(requirements, instances);
  const nodes: Record<string, StructureNode> = {};
  const keyedRequirements = new Map(requirements.map((r) => [r.requirementLineageId, r]));

  for (let i = 0; i < order.length; i++) {
    const qid = order[i]!;
    // Find the first scoped requirement that references this question.
    const scoped = requirements.find((r) => r.scope === `question:${qid}`);
    let facet = scoped?.facet ?? "unknown";
    for (const fi of instances) {
      if (fi.targetQuestionId === qid) {
        const r = keyedRequirements.get(fi.requirementLineageId);
        if (r) {
          facet = r.facet;
          break;
        }
      }
    }

    nodes[qid] = {
      id: qid,
      order: i + 1,
      options: collectOptions(instances, qid),
      facet,
      terminal: isTerminalQuestion(instances, edges, qid),
    };
  }

  // ---- add nodes for terminal destinations ----
  for (const e of edges) {
    if (e.to.startsWith("TERMINATE:") && !nodes[e.to]) {
      nodes[e.to] = {
        id: e.to,
        order: order.length + 1,
        options: [],
        facet: "terminate",
        terminal: true,
      };
    }
  }

  if (Object.keys(nodes).length === 0) return null;

  // ---- fallthrough edges ----
  // Between consecutive questions in order, if no explicit edge exists for ANY answer,
  // add a fallthrough edge. This is the graph-spike's "default fallthrough" behavior.
  const fallthroughEdges: StructureEdge[] = [];
  const seenEdgeSet = new Set(
    edges.map((e) => edgeCanon(e.from, e.trigger, e.to)),
  );

  for (let i = 0; i < order.length - 1; i++) {
    const from = order[i]!;
    const to = order[i + 1]!;
    // If no explicit edge from `from` → `to` exists, and `from` is not a terminal,
    // add a fallthrough
    const hasExplicit = edges.some((e) => e.from === from && e.to === to);
    if (!hasExplicit && !nodes[from]?.terminal) {
      const trigger = { mode: "always" as const, value: "default" };
      const canon = edgeCanon(from, trigger, to);
      if (!seenEdgeSet.has(canon)) {
        seenEdgeSet.add(canon);
        fallthroughEdges.push({
          from,
          to,
          kind: "fallthrough",
          trigger,
          sources: [],
        });
      }
    }
  }

  // ---- the full edge set ----
  const allEdges: StructureEdge[] = [
    ...edges.map(
      (e): StructureEdge => ({
        from: e.from,
        to: e.to,
        kind: e.kind,
        trigger: e.trigger,
        sources: e.source.split(",").filter(Boolean),
      }),
    ),
    ...fallthroughEdges,
  ];

  return {
    kind: STRUCTURE_MODEL_KIND,
    compiledAt: new Date().toISOString(),
    contractRevisionId: revision.contractRevisionId,
    contractHash: revision.documentSha256,
    nodes,
    edges: allEdges,
    denominator: {
      nodeCount: Object.keys(nodes).length,
      edgeCount: allEdges.length,
      terminalEdges: allEdges.filter((e) => e.kind === "terminate").length,
      routeEdges: allEdges.filter((e) => e.kind === "route").length,
      fallthroughEdges: fallthroughEdges.length,
    },
  };
}
