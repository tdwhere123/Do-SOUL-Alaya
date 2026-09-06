import type { DecisionPhaseCounters, GroundedObligation, TypedSupportEdge } from "./types.js";
import { compareIdentity } from "./types.js";

export const SUPPORT_EDGE_LIMIT = 512;
export const SUPPORT_WIDTH_LIMIT = 4;

function supportEdgeIdentity(edge: TypedSupportEdge, work?: DecisionPhaseCounters): string {
  return JSON.stringify({
    resultObjectId: edge.resultObjectId, workspaceId: edge.workspaceId ?? null,
    assignmentKey: edge.assignmentKey, predicate: edge.predicate,
    sourceObjectId: edge.sourceObjectId, targetObjectId: edge.targetObjectId,
    assertionId: edge.assertionId ?? null,
    evidenceRefs: edge.evidenceRefs === undefined ? null : [...edge.evidenceRefs].sort((a, b) => {
      if (work) work.comparisons += 1; return compareIdentity(a, b);
    })
  } satisfies Record<keyof TypedSupportEdge, unknown>);
}

// Backward reachability and a forward witness walk avoid enumerating edge tuples.
// Only the explicitly represented endpoint-path operator is implemented here.
export function supportWitness(
  obligation: GroundedObligation,
  edges: readonly TypedSupportEdge[],
  admitted: ReadonlySet<string>,
  work?: DecisionPhaseCounters
): readonly TypedSupportEdge[] | null {
  if (edges.length > SUPPORT_EDGE_LIMIT) throw new Error("support edge capacity exceeded");
  const predicates = obligation.requiredPredicates;
  if (predicates.length > SUPPORT_WIDTH_LIMIT) throw new Error("support width capacity exceeded");
  if (obligation.supportForm !== "endpoint_path" || predicates.length === 0) return null;
  const candidates = edges.filter((edge) => {
    if (work) work.rowVisits += 1;
    return admitted.has(edge.resultObjectId) && edge.assignmentKey === obligation.assignmentKey;
  }).sort((a, b) => {
    if (work) work.comparisons += 1;
    return compareIdentity(a.resultObjectId, b.resultObjectId) ||
      compareIdentity(supportEdgeIdentity(a, work), supportEdgeIdentity(b, work)) ||
      compareIdentity(JSON.stringify(a.evidenceRefs ?? null), JSON.stringify(b.evidenceRefs ?? null));
  });
  const layers: TypedSupportEdge[][] = [];
  let nextSubjects: Set<string> | null = null;
  for (let index = predicates.length - 1; index >= 0; index -= 1) {
    const reachable = candidates.filter((edge) => {
      if (work) work.rowVisits += 1;
      return edge.predicate === predicates[index] && (nextSubjects === null || nextSubjects.has(edge.targetObjectId));
    });
    layers[index] = reachable;
    nextSubjects = new Set(reachable.map((edge) => { if (work) work.rowVisits += 1; return edge.sourceObjectId; }));
  }
  const witness: TypedSupportEdge[] = [];
  let subject: string | null = null;
  for (const layer of layers) {
    const edge = layer.find((item) => { if (work) work.rowVisits += 1; return subject === null || item.sourceObjectId === subject; });
    if (!edge) return null;
    witness.push(edge);
    subject = edge.targetObjectId;
  }
  return Object.freeze(witness);
}


export class SelectionSupportIndex {
  private readonly buckets = new Map<GroundedObligation, readonly TypedSupportEdge[]>();
  public readonly formationWork: number;
  public readonly evaluationWork: number;

  public constructor(obligations: readonly GroundedObligation[], edges: readonly TypedSupportEdge[], work?: DecisionPhaseCounters) {
    if (edges.length > SUPPORT_EDGE_LIMIT || obligations.length > 64) throw new Error("support formation capacity exceeded");
    const byAssignment = new Map<string, TypedSupportEdge[]>();
    for (const edge of edges) {
      if (work) work.rowVisits += 1;
      const bucket = byAssignment.get(edge.assignmentKey) ?? [];
      bucket.push(edge);
      byAssignment.set(edge.assignmentKey, bucket);
    }
    let rows = 0;
    for (const obligation of obligations) {
      if (work) work.rowVisits += 1;
      if (obligation.requiredPredicates.length > SUPPORT_WIDTH_LIMIT) throw new Error("support width capacity exceeded");
      const bucket = Object.freeze((byAssignment.get(obligation.assignmentKey) ?? []).map((edge) => {
        if (work) work.rowVisits += 1; return edge;
      }));
      this.buckets.set(obligation, bucket);
      rows += bucket.length * (obligation.requiredPredicates.length + 3);
    }
    this.formationWork = edges.length + obligations.length + rows;
    // Filtering, ordering, reachability, and witness materialization all have a finite allowance.
    this.evaluationWork = rows * 12 + obligations.length;
  }

  public witness(obligation: GroundedObligation, selected: ReadonlySet<string>, work?: DecisionPhaseCounters): readonly TypedSupportEdge[] | null {
    return supportWitness(obligation, this.buckets.get(obligation) ?? [], selected, work);
  }
}
