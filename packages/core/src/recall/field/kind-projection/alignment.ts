import {
  KIND_PROJECTION_AUTHORITY,
  normalizeSemanticIdentity,
  type KindProjection,
  type KindProjectionStatus,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import {
  inspectKindProjection,
  rejectDuplicateFactorProjections
} from "./inspect.js";

export const KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID =
  "kind_constraint_alignment_v1" as const;

export type KindConstraintResultBinding = Readonly<{
  readonly variable_id: string;
  readonly semantic_identity: string;
  readonly evidence_factor_id: string;
}>;

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
  readonly authority: typeof KIND_PROJECTION_AUTHORITY;
  readonly status: KindProjectionStatus;
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
  readonly result_variable_ids: readonly string[];
  readonly result_bindings: readonly KindConstraintResultBinding[];
  readonly evidence_graph: OpenSemanticFactorGraph;
  readonly kind_projections?: readonly unknown[];
}>): KindConstraintAlignmentReceipt {
  const evidenceGraphDigest = digestRecallFieldIdentity(input.evidence_graph);
  const constraint = normalizeSemanticIdentity(input.answer_kind_constraint);
  const payloads = input.kind_projections;
  const provided = payloads !== undefined && payloads.length > 0;
  const projections = inspectPayloads(
    payloads, input.evidence_graph, evidenceGraphDigest
  );
  const listed = input.result_variable_ids.includes(input.answer_variable_id);
  const alignments = listed
    ? collectAlignments(
      projections,
      input.result_bindings,
      constraint,
      input.answer_variable_id
    )
    : [];
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID,
    authority: KIND_PROJECTION_AUTHORITY,
    status: classifyAlignmentStatus({
      provided,
      listed,
      projections,
      alignmentCount: alignments.length
    }),
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

function inspectPayloads(
  payloads: readonly unknown[] | undefined,
  evidenceGraph: OpenSemanticFactorGraph,
  evidenceGraphDigest: RecallFieldDigest
): readonly KindProjection[] {
  if (payloads === undefined || payloads.length === 0) return [];
  return rejectDuplicateFactorProjections(payloads.map((value) => inspectKindProjection({
    value,
    evidence_graph: evidenceGraph,
    evidence_graph_digest: evidenceGraphDigest
  })));
}

function collectAlignments(
  projections: readonly KindProjection[],
  resultBindings: readonly KindConstraintResultBinding[],
  constraint: string,
  variableId: string
): KindConstraintAlignmentBinding[] {
  // Filter OSF result bindings; a kind payload cannot mint an answer.
  const formed = formedProjectionsByFactor(projections);
  const alignments: KindConstraintAlignmentBinding[] = [];
  for (const binding of resultBindings) {
    if (binding.variable_id !== variableId) continue;
    const aligned = filterBinding(binding, formed.get(binding.evidence_factor_id), constraint);
    if (aligned !== null) alignments.push(aligned);
  }
  return alignments.sort((left, right) => compareText(left.factor_id, right.factor_id));
}

function formedProjectionsByFactor(
  projections: readonly KindProjection[]
): ReadonlyMap<string, KindProjection> {
  const formed = new Map<string, KindProjection>();
  for (const projection of projections) {
    if (projection.status !== "formed" || projection.factor_id === null) continue;
    formed.set(projection.factor_id, projection);
  }
  return formed;
}

function filterBinding(
  binding: KindConstraintResultBinding,
  projection: KindProjection | undefined,
  constraint: string
): KindConstraintAlignmentBinding | null {
  if (projection === undefined) return null;
  const edge = projection.instance_of.find((item) =>
    item.subject_factor_id === binding.evidence_factor_id &&
    item.predicate === "instance_of" &&
    item.kind_identity === constraint);
  if (edge === undefined) return null;
  return Object.freeze({
    variable_id: binding.variable_id,
    factor_id: binding.evidence_factor_id,
    answer_identity: binding.semantic_identity,
    kind_identity: edge.kind_identity,
    projection_digest: projection.projection_digest
  });
}

function classifyAlignmentStatus(input: Readonly<{
  readonly provided: boolean;
  readonly listed: boolean;
  readonly projections: readonly KindProjection[];
  readonly alignmentCount: number;
}>): KindProjectionStatus {
  if (input.alignmentCount > 0) return "formed";
  if (!input.listed) return "ineligible";
  if (!input.provided) return "unavailable";
  if (input.projections.some((projection) => projection.status === "formed")) {
    return "ineligible";
  }
  if (input.projections.some((projection) => projection.status === "rejected")) {
    return "rejected";
  }
  if (input.projections.some((projection) => projection.status === "ineligible")) {
    return "ineligible";
  }
  return "unavailable";
}
