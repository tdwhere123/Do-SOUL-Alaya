import { createHash } from "node:crypto";
import {
  KIND_PROJECTION_KIND_VALUE_LIMIT,
  KIND_PROJECTION_OPERATOR_ID,
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
      reason: classifyProposalRejection(input.value, parsed.error.issues)
    });
  }
  return bindKindProposal(
    parsed.data,
    input.evidence_graph,
    input.evidence_graph_digest
  );
}

function bindKindProposal(
  proposal: KindProjectionProposal,
  graph: OpenSemanticFactorGraph,
  evidenceGraphDigest: RecallFieldDigest
): KindProjection {
  const bound = graph.factors.some(
    (factor) => factor.factor_id === proposal.factor_id
  );
  if (!bound || proposal.evidence_graph_digest !== evidenceGraphDigest) {
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
    kind_values: kindValues,
    instance_of: instanceOfEdges(kindValues),
    rejection_reason: null
  });
}

function classifyProposalRejection(
  value: unknown,
  issues: readonly Readonly<{
    readonly message: string;
  }>[]
): KindProjectionRejectionReason {
  if (tooManyKindValues(value)) {
    return "kind_projection_invalid_kind_values_too_many";
  }
  if (issues.some((issue) => /semantic identity/iu.test(issue.message))) {
    return "kind_projection_invalid_identity";
  }
  return "kind_projection_invalid_shape";
}

function tooManyKindValues(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const kinds = (value as { readonly kind_values?: unknown }).kind_values;
  return Array.isArray(kinds) && kinds.length > KIND_PROJECTION_KIND_VALUE_LIMIT;
}

function unavailableCapture(evidenceGraphDigest: RecallFieldDigest): KindProjection {
  return createCapture({
    status: "unavailable",
    producer_operator_id: null,
    evidence_graph_digest: evidenceGraphDigest,
    factor_id: null,
    kind_values: [],
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
    kind_values: [],
    instance_of: [],
    rejection_reason: input.reason
  });
}

function instanceOfEdges(kindValues: readonly string[]) {
  return Object.freeze(kindValues.map((kind_identity) => Object.freeze({
    predicate: "instance_of" as const,
    kind_identity
  })));
}

function createCapture(
  fields: Omit<KindProjectionBody, "schema_version" | "operator_id">
): KindProjection {
  const body: KindProjectionBody = {
    schema_version: 1,
    operator_id: KIND_PROJECTION_OPERATOR_ID,
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
