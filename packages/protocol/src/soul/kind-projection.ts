import { z } from "zod";

// Independent of the strict base OSF graph so a failed projection cannot
// reject a well-formed grounded graph. F3 routing only; never referent identity.
export const KIND_PROJECTION_SCHEMA_VERSION = 1 as const;
export const KIND_PROJECTION_OPERATOR_ID = "kind_projection_v1" as const;
export const KIND_PROJECTION_KIND_VALUE_LIMIT = 2 as const;

const CanonicalIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._:-]*$/u);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SemanticIdentitySchema = z.string().min(1).max(512).superRefine(
  (value, context) => {
    if (value !== canonicalKindIdentity(value)) {
      context.addIssue({
        code: "custom",
        message: "semantic identity must be canonical NFKC lowercase text"
      });
    }
  }
);

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
  "kind_projection_invalid_unbound_factor"
]);
export type KindProjectionStatus = z.infer<typeof KindProjectionStatusSchema>;
export type KindProjectionRejectionReason =
  z.infer<typeof KindProjectionRejectionReasonSchema>;

export const KindProjectionInstanceOfEdgeSchema = z.object({
  predicate: z.literal("instance_of"),
  kind_identity: SemanticIdentitySchema
}).strict().readonly();

export const KindProjectionProposalSchema = z.object({
  schema_version: z.literal(KIND_PROJECTION_SCHEMA_VERSION),
  producer_operator_id: CanonicalIdSchema,
  evidence_graph_digest: DigestSchema,
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
  readonly kind_values: readonly string[];
  readonly instance_of: readonly Readonly<{
    readonly predicate: "instance_of";
    readonly kind_identity: string;
  }>[];
  readonly rejection_reason: KindProjectionRejectionReason | null;
}>;

export const KindProjectionSchema = z.object({
  schema_version: z.literal(KIND_PROJECTION_SCHEMA_VERSION),
  operator_id: z.literal(KIND_PROJECTION_OPERATOR_ID),
  status: KindProjectionStatusSchema,
  producer_operator_id: CanonicalIdSchema.nullable(),
  evidence_graph_digest: DigestSchema.nullable(),
  factor_id: CanonicalIdSchema.nullable(),
  kind_values: z.array(SemanticIdentitySchema)
    .max(KIND_PROJECTION_KIND_VALUE_LIMIT)
    .readonly(),
  instance_of: z.array(KindProjectionInstanceOfEdgeSchema)
    .max(KIND_PROJECTION_KIND_VALUE_LIMIT)
    .readonly(),
  rejection_reason: KindProjectionRejectionReasonSchema.nullable(),
  projection_digest: DigestSchema
}).strict().superRefine(validateKindProjection).readonly();

export type KindProjectionInstanceOfEdge =
  z.infer<typeof KindProjectionInstanceOfEdgeSchema>;
export type KindProjectionProposal = z.infer<typeof KindProjectionProposalSchema>;
export type KindProjection = z.infer<typeof KindProjectionSchema>;
export type KindProjectionBody = Omit<KindProjection, "projection_digest">;

export function canonicalKindIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function kindProjectionPreimage(
  capture: Readonly<KindProjectionBody>
): string {
  return JSON.stringify([
    capture.schema_version,
    capture.operator_id,
    capture.status,
    capture.producer_operator_id,
    capture.evidence_graph_digest,
    capture.factor_id,
    capture.kind_values,
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
      message: "formed kind projection requires producer, graph digest, factor, kinds, and no rejection"
    });
  }
  if (!formed && (capture.kind_values.length > 0 || capture.instance_of.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "non-formed kind projection cannot contain kind values"
    });
  }
  if ((capture.status === "rejected") !== (capture.rejection_reason !== null)) {
    context.addIssue({
      code: "custom",
      message: "rejected kind projection requires a rejection reason"
    });
  }
  if (formed && !instanceOfMatchesKindValues(capture)) {
    context.addIssue({
      code: "custom",
      message: "instance_of edges must match kind values"
    });
  }
}

function formedProjectionComplete(capture: KindProjectionFields): boolean {
  return capture.producer_operator_id !== null &&
    capture.evidence_graph_digest !== null &&
    capture.factor_id !== null &&
    capture.kind_values.length > 0 &&
    capture.instance_of.length === capture.kind_values.length &&
    capture.rejection_reason === null;
}

function instanceOfMatchesKindValues(capture: KindProjectionFields): boolean {
  return capture.instance_of.every((edge, index) =>
    edge.predicate === "instance_of" &&
    edge.kind_identity === capture.kind_values[index]);
}
