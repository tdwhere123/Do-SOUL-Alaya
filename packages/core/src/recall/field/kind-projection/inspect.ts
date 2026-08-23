import { createHash } from "node:crypto";
import {
  KIND_PROJECTION_AUTHORITY,
  KIND_PROJECTION_OPERATOR_ID,
  KIND_PROJECTION_SCHEMA_VERSION,
  KindProjectionProposalSchema,
  KindProjectionSchema,
  kindProjectionPreimage,
  type KindProjection,
  type KindProjectionBody,
  type KindProjectionProposal,
  type KindProjectionRejectionReason,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import type { RecallFieldDigest } from "../field-identity.js";

// Bind after an independent parse so malformed kinds cannot reject the base graph.
export function inspectKindProjection(input: Readonly<{
  readonly value: unknown;
  readonly evidence_graph: OpenSemanticFactorGraph;
  readonly evidence_graph_digest: RecallFieldDigest;
}>): KindProjection {
  if (input.value === undefined || input.value === null) {
    return unavailableCapture(input.evidence_graph_digest);
  }
  const parsed = KindProjectionProposalSchema.safeParse(input.value);
  if (!parsed.success) {
    return rejectedCapture({
      evidence_graph_digest: input.evidence_graph_digest,
      factor_id: null,
      producer_operator_id: null,
      reason: classifyProposalRejection(parsed.error.issues)
    });
  }
  return bindKindProposal(
    parsed.data,
    input.evidence_graph,
    input.evidence_graph_digest
  );
}

export function rejectDuplicateFactorProjections(
  projections: readonly KindProjection[]
): readonly KindProjection[] {
  const duplicateKeys = duplicateFormedFactorKeys(projections);
  return Object.freeze(projections.map((projection) => {
    const digest = projection.evidence_graph_digest;
    if (digest === null || !shouldRejectDuplicate(projection, duplicateKeys)) {
      return projection;
    }
    return rejectedCapture({
      evidence_graph_digest: digest,
      factor_id: projection.factor_id,
      producer_operator_id: projection.producer_operator_id,
      reason: "kind_projection_invalid_duplicate_factor"
    });
  }));
}

function duplicateFormedFactorKeys(
  projections: readonly KindProjection[]
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const projection of projections) {
    const key = formedFactorKey(projection);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key));
}

function shouldRejectDuplicate(
  projection: KindProjection,
  duplicateKeys: ReadonlySet<string>
): boolean {
  const key = formedFactorKey(projection);
  return key !== null &&
    projection.evidence_graph_digest !== null &&
    duplicateKeys.has(key);
}

function formedFactorKey(projection: KindProjection): string | null {
  if (projection.status !== "formed" ||
      projection.factor_id === null ||
      projection.evidence_graph_digest === null) {
    return null;
  }
  return `${projection.evidence_graph_digest}\0${projection.factor_id}`;
}

function bindKindProposal(
  proposal: KindProjectionProposal,
  graph: OpenSemanticFactorGraph,
  evidenceGraphDigest: RecallFieldDigest
): KindProjection {
  if (proposal.evidence_graph_digest !== evidenceGraphDigest) {
    return rejectedCapture({
      evidence_graph_digest: proposal.evidence_graph_digest,
      factor_id: proposal.factor_id,
      producer_operator_id: proposal.producer_operator_id,
      reason: "kind_projection_invalid_graph_digest"
    });
  }
  if (!graph.factors.some((factor) => factor.factor_id === proposal.factor_id)) {
    return rejectedCapture({
      evidence_graph_digest: proposal.evidence_graph_digest,
      factor_id: proposal.factor_id,
      producer_operator_id: proposal.producer_operator_id,
      reason: "kind_projection_invalid_unbound_factor"
    });
  }
  const kindValues = Object.freeze([...proposal.kind_values].sort(compareText));
  return createCapture({
    status: "formed",
    producer_operator_id: proposal.producer_operator_id,
    evidence_graph_digest: proposal.evidence_graph_digest,
    factor_id: proposal.factor_id,
    instance_of: instanceOfEdges(proposal.factor_id, kindValues),
    rejection_reason: null
  });
}

function classifyProposalRejection(
  issues: readonly Readonly<{
    readonly code: string;
    readonly path: readonly PropertyKey[];
  }>[]
): KindProjectionRejectionReason {
  if (issues.some((issue) =>
    issue.path[0] === "kind_values" && issue.code === "too_big")) {
    return "kind_projection_invalid_kind_values_too_many";
  }
  if (issues.some((issue) =>
    issue.path[0] === "kind_values" &&
    issue.path.length > 1 &&
    issue.code === "custom")) {
    return "kind_projection_invalid_identity";
  }
  return "kind_projection_invalid_shape";
}

function unavailableCapture(evidenceGraphDigest: RecallFieldDigest): KindProjection {
  return createCapture({
    status: "unavailable",
    producer_operator_id: null,
    evidence_graph_digest: evidenceGraphDigest,
    factor_id: null,
    instance_of: [],
    rejection_reason: null
  });
}

function rejectedCapture(input: Readonly<{
  readonly evidence_graph_digest: string;
  readonly factor_id: string | null;
  readonly producer_operator_id: string | null;
  readonly reason: KindProjectionRejectionReason;
}>): KindProjection {
  return createCapture({
    status: "rejected",
    producer_operator_id: input.producer_operator_id,
    evidence_graph_digest: input.evidence_graph_digest,
    factor_id: input.factor_id,
    instance_of: [],
    rejection_reason: input.reason
  });
}

function instanceOfEdges(factorId: string, kindValues: readonly string[]) {
  return Object.freeze(kindValues.map((kind_identity) => Object.freeze({
    subject_factor_id: factorId,
    predicate: "instance_of" as const,
    kind_identity
  })));
}

function createCapture(
  fields: Omit<KindProjectionBody, "schema_version" | "operator_id" | "authority">
): KindProjection {
  const body: KindProjectionBody = {
    schema_version: KIND_PROJECTION_SCHEMA_VERSION,
    operator_id: KIND_PROJECTION_OPERATOR_ID,
    authority: KIND_PROJECTION_AUTHORITY,
    ...fields
  };
  return KindProjectionSchema.parse(Object.freeze({
    ...body,
    projection_digest: `sha256:${sha256(kindProjectionPreimage(body))}`
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
