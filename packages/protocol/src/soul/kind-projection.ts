import { z } from "zod";
import { FieldContractDigestSchema } from "./field-contract/canonical-identity.js";
import {
  CanonicalIdSchema,
  SemanticIdentitySchema
} from "./open-semantic-factor-graph.js";

// Independent of the strict base OSF graph so a failed projection cannot
// reject a well-formed grounded graph. F3 routing only; never referent identity.
export const KIND_PROJECTION_SCHEMA_VERSION = 1 as const;
export const KIND_PROJECTION_OPERATOR_ID = "kind_projection_v1" as const;
export const KIND_PROJECTION_KIND_VALUE_LIMIT = 2 as const;
export const KIND_PROJECTION_AUTHORITY = "proposed_routing_only" as const;

export const KindProjectionStatusSchema = z.enum([
  "formed",
  "rejected",
  "unavailable",
  "ineligible"
]);
export const KindProjectionRejectionReasonSchema = z.enum([
  "kind_projection_invalid_shape",
  "kind_projection_invalid_identity",
  "kind_projection_invalid_kind_values_too_many",
  "kind_projection_invalid_unbound_factor",
  "kind_projection_invalid_graph_digest",
  "kind_projection_invalid_duplicate_factor"
]);
export type KindProjectionStatus = z.infer<typeof KindProjectionStatusSchema>;
export type KindProjectionRejectionReason =
  z.infer<typeof KindProjectionRejectionReasonSchema>;

export const KindProjectionInstanceOfEdgeSchema = z.object({
  subject_factor_id: CanonicalIdSchema,
  predicate: z.literal("instance_of"),
  kind_identity: SemanticIdentitySchema
}).strict().readonly();

export const KindProjectionProposalSchema = z.object({
  schema_version: z.literal(KIND_PROJECTION_SCHEMA_VERSION),
  producer_operator_id: CanonicalIdSchema,
  evidence_graph_digest: FieldContractDigestSchema,
  factor_id: CanonicalIdSchema,
  kind_values: z.array(SemanticIdentitySchema)
    .min(1)
    .max(KIND_PROJECTION_KIND_VALUE_LIMIT)
    .readonly()
}).strict().superRefine((proposal, context) => {
  if (new Set(proposal.kind_values).size !== proposal.kind_values.length) {
    context.addIssue({
      code: "custom",
      path: ["kind_values"],
      message: "kind values must be unique"
    });
  }
}).readonly();

type KindProjectionFields = Readonly<{
  readonly status: KindProjectionStatus;
  readonly producer_operator_id: string | null;
  readonly evidence_graph_digest: string | null;
  readonly factor_id: string | null;
  readonly instance_of: readonly Readonly<{
    readonly subject_factor_id: string;
    readonly predicate: "instance_of";
    readonly kind_identity: string;
  }>[];
  readonly rejection_reason: KindProjectionRejectionReason | null;
}>;

export const KindProjectionSchema = z.object({
  schema_version: z.literal(KIND_PROJECTION_SCHEMA_VERSION),
  operator_id: z.literal(KIND_PROJECTION_OPERATOR_ID),
  authority: z.literal(KIND_PROJECTION_AUTHORITY),
  status: KindProjectionStatusSchema,
  producer_operator_id: CanonicalIdSchema.nullable(),
  evidence_graph_digest: FieldContractDigestSchema.nullable(),
  factor_id: CanonicalIdSchema.nullable(),
  instance_of: z.array(KindProjectionInstanceOfEdgeSchema)
    .max(KIND_PROJECTION_KIND_VALUE_LIMIT)
    .readonly(),
  rejection_reason: KindProjectionRejectionReasonSchema.nullable(),
  projection_digest: FieldContractDigestSchema
}).strict().superRefine(validateKindProjection).readonly();

export type KindProjectionInstanceOfEdge =
  z.infer<typeof KindProjectionInstanceOfEdgeSchema>;
export type KindProjectionProposal = z.infer<typeof KindProjectionProposalSchema>;
export type KindProjection = z.infer<typeof KindProjectionSchema>;
export type KindProjectionBody = Omit<KindProjection, "projection_digest">;

export function kindProjectionPreimage(
  capture: Readonly<KindProjectionBody>
): string {
  return JSON.stringify([
    capture.schema_version,
    capture.operator_id,
    capture.authority,
    capture.status,
    capture.producer_operator_id,
    capture.evidence_graph_digest,
    capture.factor_id,
    capture.instance_of,
    capture.rejection_reason
  ]);
}

export function verifyKindProjection(
  value: unknown,
  sha256: (preimage: string) => string
): KindProjection {
  const capture = KindProjectionSchema.parse(value);
  const { projection_digest: _digest, ...body } = capture;
  const expected = `sha256:${sha256(kindProjectionPreimage(body))}`;
  if (capture.projection_digest !== expected) {
    throw new Error("kind projection digest mismatch");
  }
  return capture;
}

function validateKindProjection(
  capture: KindProjectionFields,
  context: z.RefinementCtx
): void {
  const formed = capture.status === "formed";
  if (formed !== formedProjectionComplete(capture)) {
    context.addIssue({
      code: "custom",
      message: "formed kind projection requires producer, graph digest, factor, instance_of, and no rejection"
    });
  }
  if (!formed && capture.instance_of.length > 0) {
    context.addIssue({
      code: "custom",
      message: "non-formed kind projection cannot contain instance_of edges"
    });
  }
  if ((capture.status === "rejected") !== (capture.rejection_reason !== null)) {
    context.addIssue({
      code: "custom",
      message: "rejected kind projection requires a rejection reason"
    });
  }
  if (formed && !instanceOfMatchesFactor(capture)) {
    context.addIssue({
      code: "custom",
      message: "instance_of edges must bind the projection factor with unique kinds"
    });
  }
}

function formedProjectionComplete(capture: KindProjectionFields): boolean {
  return capture.producer_operator_id !== null &&
    capture.evidence_graph_digest !== null &&
    capture.factor_id !== null &&
    capture.instance_of.length > 0 &&
    capture.rejection_reason === null;
}

function instanceOfMatchesFactor(capture: KindProjectionFields): boolean {
  const kinds = capture.instance_of.map((edge) => edge.kind_identity);
  return capture.factor_id !== null &&
    new Set(kinds).size === capture.instance_of.length &&
    capture.instance_of.every((edge) =>
      edge.subject_factor_id === capture.factor_id &&
      edge.predicate === "instance_of");
}
