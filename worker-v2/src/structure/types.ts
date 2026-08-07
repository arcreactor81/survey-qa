/**
 * THE ROUTING GRAPH — the document side of the D-vs-S edge-set comparison.
 *
 * Compiled deterministically from the SEALED contract revision. Zero model calls.
 * The graph is an OBLIGATION LEDGER: it states what edges the document says should
 * exist, which the site crawler then recovers and the diff compares.
 *
 * Design: graph-spike/FINDINGS.md §7 ("graph = obligation ledger and coverage
 * denominator") and document-processing-playbook.md §6 ("compile graph-D once, at
 * ingestion").
 */

export const STRUCTURE_MODEL_KIND = "survey-qa-structure-model/1.0.0" as const;

/** A node is one question the contract names, plus its known answer options. */
export interface StructureNode {
  /** The question id the contract uses — same as FacetInstance.targetQuestionId. */
  id: string;
  /** Position in the contract, for ordering. 1-based; 0 when unknown. */
  order: number;
  /**
   * The options the document enumerates for this question.
   * Built from all FacetInstances whose targetQuestionId matches this node.
   */
  options: Array<{
    code: string | null;
    label: string | null;
  }>;
  /** The question's primary category, from the first ScopedRequirement we find. */
  facet: string;
  /** Is this question itself a terminal destination? */
  terminal: boolean;
}

/**
 * ONE EDGE IS ONE ROUTING COMMITMENT.
 *
 * The document says: from question A, selecting answer X, the survey must go to B
 * (or terminate). Every edge is derived from a FacetInstance whose case.kind is
 * "route" or whose requirement facet is "terminate".
 *
 * The edge TRIGGER is the identity of the answer. The document-processing-playbook
 * §6.2b is the authority: "Where the document binds a code, the code IS the identity
 * of the answer and the label is corroboration only."
 */
export interface StructureEdge {
  /** The question this edge originates from. */
  from: string;
  /** Where this edge lands. A question id, or a terminal state. */
  to: string;
  kind: "route" | "terminate" | "fallthrough";
  /** The answer that triggers this edge. Primary on code, fallback on label. */
  trigger: {
    mode: "code" | "label" | "always";
    value: string;
  };
  /**
   * FacetInstance ids that define this edge. For audit: every edge can be traced
   * back to the sealed contract row that produced it.
   */
  sources: string[];
}

/**
 * The compiled document graph. An obligation ledger, not an observation.
 *
 * It says what MUST exist according to the document. The site crawler produces
 * a second graph of what DOES exist, and the diff is the comparison.
 *
 * The denominator is the SYMBOLIC EDGE SET: finite, computable, traversal-independent.
 */
export interface StructureModel {
  kind: typeof STRUCTURE_MODEL_KIND;
  compiledAt: string;
  contractRevisionId: string;
  contractHash: string | null;

  /** Nodes keyed by question id. */
  nodes: Record<string, StructureNode>;

  /** Every routing rule the document states, in document order. */
  edges: StructureEdge[];

  /** The denominator. The diff compares this against the site graph. */
  denominator: {
    nodeCount: number;
    edgeCount: number;
    /** Edges that terminate the survey. */
    terminalEdges: number;
    /** Edges whose destination is a named question. */
    routeEdges: number;
    /** Fallthrough edges (no explicit rule → next question in order). */
    fallthroughEdges: number;
  };
}
