import { z } from "zod";
import { RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID } from
  "./query-osf-semantic-completeness.js";

export const QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID =
  "query_fact_frame_osf_facet_receipt_v1" as const;
export const MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID =
  "model_query_obligation_facet_fallback_v1" as const;

export const QUERY_OBLIGATION_FACET_IDS = [
  "predicate",
  "subject",
  "answer_variable",
  "type_constraint",
  "time",
  "answer_operator"
] as const;
export const QUERY_OBLIGATION_FACET_STATUSES = [
  "formed",
  "ambiguous",
  "unavailable",
  "ineligible",
  "rejected"
] as const;
export const QUERY_OBLIGATION_FACET_CONSTRAINT_CLASSES = [
  "hard_constraint",
  "soft_constraint",
  "answer_shape"
] as const;
export const QUERY_OBLIGATION_FACET_PRODUCER_KINDS = [
  "rule_based",
  "model_fallback",
  "absent"
] as const;
export const QUERY_OBLIGATION_FACET_REASONS = [
  "not_requested",
  "no_parse",
  "missing_osf_layout",
  "capture_unavailable",
  "query_ineligible",
  "ambiguous_wh",
  "capture_mismatch",
  "multiple_frames",
  "model_fallback_rule_based_impersonation"
] as const;

export const QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS = {
  predicate: "hard_constraint",
  subject: "hard_constraint",
  answer_variable: "answer_shape",
  type_constraint: "answer_shape",
  time: "soft_constraint",
  answer_operator: "answer_shape"
} as const;

export type QueryObligationFacetId = typeof QUERY_OBLIGATION_FACET_IDS[number];
export type QueryObligationFacetStatus =
  typeof QUERY_OBLIGATION_FACET_STATUSES[number];
export type QueryObligationFacetConstraintClass =
  typeof QUERY_OBLIGATION_FACET_CONSTRAINT_CLASSES[number];
export type QueryObligationFacetProducerKind =
  typeof QUERY_OBLIGATION_FACET_PRODUCER_KINDS[number];
export type QueryObligationFacetReason =
  typeof QUERY_OBLIGATION_FACET_REASONS[number];

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SourceSpanSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().positive()
]);

type FacetFields = {
  facet_id: QueryObligationFacetId;
  status: QueryObligationFacetStatus;
  constraint_class: QueryObligationFacetConstraintClass;
  producer_kind: QueryObligationFacetProducerKind;
  producer_operator_id: string | null;
  surface: string | null;
  source_span: readonly [number, number] | null;
  reason: QueryObligationFacetReason | null;
};

export const QueryObligationFacetSchema = z.object({
  facet_id: z.enum(QUERY_OBLIGATION_FACET_IDS),
  status: z.enum(QUERY_OBLIGATION_FACET_STATUSES),
  constraint_class: z.enum(QUERY_OBLIGATION_FACET_CONSTRAINT_CLASSES),
  producer_kind: z.enum(QUERY_OBLIGATION_FACET_PRODUCER_KINDS),
  producer_operator_id: z.string().min(1).nullable(),
  surface: z.string().min(1).nullable(),
  source_span: SourceSpanSchema.nullable(),
  reason: z.enum(QUERY_OBLIGATION_FACET_REASONS).nullable()
}).strict().superRefine(validateFacetProducerIdentity).readonly();

export const QueryFactFrameOsfFacetReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID),
  query_digest: DigestSchema,
  fact_frame_producer_operator_id: z.string().min(1).nullable(),
  fact_frame_capture_digest: DigestSchema,
  certified_obligation_digest: DigestSchema.nullable(),
  facets: z.array(QueryObligationFacetSchema).length(6).readonly(),
  receipt_digest: DigestSchema
}).strict().superRefine(validateFacetReceipt).readonly();

export type QueryObligationFacet = z.infer<typeof QueryObligationFacetSchema>;
export type QueryFactFrameOsfFacetReceipt =
  z.infer<typeof QueryFactFrameOsfFacetReceiptSchema>;

export function queryFactFrameOsfFacetReceiptPreimage(value: Omit<
  QueryFactFrameOsfFacetReceipt, "receipt_digest"
>): string {
  return JSON.stringify({
    schema_version: value.schema_version,
    operator_id: value.operator_id,
    query_digest: value.query_digest,
    fact_frame_producer_operator_id: value.fact_frame_producer_operator_id,
    fact_frame_capture_digest: value.fact_frame_capture_digest,
    certified_obligation_digest: value.certified_obligation_digest,
    facets: value.facets
  });
}

function validateFacetProducerIdentity(
  facet: FacetFields,
  context: z.RefinementCtx
): void {
  const formed = facet.status === "formed";
  const impersonating = facet.producer_kind === "model_fallback" &&
    facet.producer_operator_id === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;
  if (impersonating) {
    context.addIssue({
      code: "custom",
      message: "model fallback cannot impersonate the rule-based producer"
    });
    return;
  }
  if (facet.constraint_class !==
      QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[facet.facet_id]) {
    context.addIssue({
      code: "custom",
      message: "query obligation facet constraint class does not match facet id"
    });
  }
  if (formed) {
    validateFormedFacet(facet, context);
    return;
  }
  if (facet.status === "ambiguous") {
    validateAmbiguousFacet(facet, context);
    return;
  }
  if (facet.producer_kind !== "absent" || facet.producer_operator_id !== null ||
      facet.surface !== null || facet.source_span !== null) {
    context.addIssue({
      code: "custom",
      message: "non-formed query obligation facet cannot carry a slot"
    });
  }
}

function validateFormedFacet(
  facet: FacetFields,
  context: z.RefinementCtx
): void {
  if (facet.producer_kind === "absent" || facet.producer_operator_id === null ||
      facet.surface === null || facet.source_span === null) {
    context.addIssue({
      code: "custom",
      message: "formed query obligation facet is missing producer or span"
    });
  }
  if (facet.producer_kind === "rule_based" &&
      facet.producer_operator_id !== RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) {
    context.addIssue({
      code: "custom",
      message: "rule-based facet producer identity mismatch"
    });
  }
}

function validateAmbiguousFacet(
  facet: FacetFields,
  context: z.RefinementCtx
): void {
  if (facet.producer_kind === "model_fallback") {
    context.addIssue({
      code: "custom",
      message: "model fallback cannot mark a facet ambiguous"
    });
  }
}

function validateFacetReceipt(
  value: {
    fact_frame_producer_operator_id: string | null;
    certified_obligation_digest: string | null;
    facets: readonly FacetFields[];
  },
  context: z.RefinementCtx
): void {
  const ids = value.facets.map((facet) => facet.facet_id);
  if (new Set(ids).size !== QUERY_OBLIGATION_FACET_IDS.length ||
      QUERY_OBLIGATION_FACET_IDS.some((id, index) => ids[index] !== id)) {
    context.addIssue({
      code: "custom",
      message: "query obligation facet receipt must list each facet once in order"
    });
  }
  const modelFilled = value.facets.some((facet) =>
    facet.producer_kind === "model_fallback");
  if (modelFilled && value.certified_obligation_digest !== null) {
    context.addIssue({
      code: "custom",
      message: "model fallback cannot certify a complete query obligation"
    });
  }
  if (value.certified_obligation_digest === null) return;
  if (value.fact_frame_producer_operator_id !==
      RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) {
    context.addIssue({
      code: "custom",
      message: "certified facet receipt requires the rule-based producer"
    });
  }
  const required = ["predicate", "subject", "answer_variable"] as const;
  if (required.some((id) => {
    const facet = value.facets.find((entry) => entry.facet_id === id);
    return facet?.status !== "formed" || facet.producer_kind !== "rule_based";
  })) {
    context.addIssue({
      code: "custom",
      message: "certified facet receipt is missing rule-based hard slots"
    });
  }
}
