import {
  canonicalKindIdentity,
  type KindProjection,
  type OpenSemanticFactor,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import { inspectKindProjection } from "./inspect.js";

export const KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID =
  "kind_constraint_alignment_v1" as const;

export type KindConstraintAlignmentStatus =
  | "formed"
  | "rejected"
  | "unavailable"
  | "ineligible";

export type KindConstraintAlignmentBinding = Readonly<{
  readonly variable_id: string;
  readonly factor_id: string;
  readonly answer_identity: string;
  readonly kind_identity: string;
  readonly projection_digest: string;
}>;

export type KindConstraintAlignmentReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID;
  readonly status: KindConstraintAlignmentStatus;
  readonly answer_variable_id: string;
  readonly answer_kind_constraint: string;
  readonly evidence_graph_digest: RecallFieldDigest;
  readonly alignments: readonly KindConstraintAlignmentBinding[];
  readonly projections: readonly KindProjection[];
  readonly receipt_digest: RecallFieldDigest;
}>;

export function materializeKindConstraintAlignment(input: Readonly<{
  readonly answer_variable_id: string;
  readonly answer_kind_constraint: string;
  readonly evidence_graph: OpenSemanticFactorGraph;
  readonly kind_projections?: readonly unknown[];
}>): KindConstraintAlignmentReceipt {
  const evidenceGraphDigest = digestRecallFieldIdentity(input.evidence_graph);
  const constraint = canonicalKindIdentity(input.answer_kind_constraint);
  const payloads = input.kind_projections;
  const provided = payloads !== undefined && payloads.length > 0;
  const projections = provided
    ? payloads.map((value) => inspectKindProjection({
      value,
      evidence_graph: input.evidence_graph,
      evidence_graph_digest: evidenceGraphDigest
    }))
    : [];
  const alignments = collectAlignments(
    projections,
    input.evidence_graph,
    constraint,
    input.answer_variable_id
  );
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID,
    status: classifyAlignmentStatus(provided, projections, alignments.length),
    answer_variable_id: input.answer_variable_id,
    answer_kind_constraint: constraint,
    evidence_graph_digest: evidenceGraphDigest,
    alignments: Object.freeze(alignments),
    projections: Object.freeze(projections)
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

function collectAlignments(
  projections: readonly KindProjection[],
  graph: OpenSemanticFactorGraph,
  constraint: string,
  variableId: string
): KindConstraintAlignmentBinding[] {
  // Shared kinds are routing, not a merge key across instance factors.
  const factors = new Map(
    graph.factors.map((factor) => [factor.factor_id, factor])
  );
  const alignments: KindConstraintAlignmentBinding[] = [];
  for (const projection of projections) {
    const binding = alignmentBinding(projection, factors, constraint, variableId);
    if (binding !== null) alignments.push(binding);
  }
  return alignments.sort((left, right) => compareText(left.factor_id, right.factor_id));
}

function alignmentBinding(
  projection: KindProjection,
  factors: ReadonlyMap<string, OpenSemanticFactor>,
  constraint: string,
  variableId: string
): KindConstraintAlignmentBinding | null {
  if (projection.status !== "formed" || projection.factor_id === null) return null;
  if (!projection.kind_values.includes(constraint)) return null;
  const factor = factors.get(projection.factor_id);
  if (factor === undefined) return null;
  return Object.freeze({
    variable_id: variableId,
    factor_id: projection.factor_id,
    answer_identity: factor.semantic_identity,
    kind_identity: constraint,
    projection_digest: projection.projection_digest
  });
}

function classifyAlignmentStatus(
  provided: boolean,
  projections: readonly KindProjection[],
  alignmentCount: number
): KindConstraintAlignmentStatus {
  if (alignmentCount > 0) return "formed";
  if (!provided) return "unavailable";
  if (projections.some((projection) => projection.status === "rejected")) {
    return "rejected";
  }
  if (projections.some((projection) =>
    projection.status === "formed" || projection.status === "ineligible")) {
    return "ineligible";
  }
  return "unavailable";
}
