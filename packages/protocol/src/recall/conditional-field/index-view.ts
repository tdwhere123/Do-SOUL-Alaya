import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  ConditionalFieldIdSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";
import { ClaimStateSchema } from "./support.js";

export const IndexRoleSchema = z.enum(["requested", "associated", "routing_only"]);

export const IndexEntrySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    object_id: ConditionalFieldIdSchema,
    hypothesis_id: ConditionalFieldIdSchema,
    output_binding: ConditionalFieldIdSchema,
    role: IndexRoleSchema,
    association_milligrades: MilligradeSchema,
    claim: ClaimStateSchema,
    explanation_ids: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const CompletenessStatusSchema = z.enum([
  "complete",
  "partial",
  "open",
  "unavailable",
  "resource_rejected",
  "interrupted",
  "exhausted_empty",
  "invalidated",
  "cancelled",
  "unknown",
  "not_applicable"
]);

export const CompletenessReportSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    logical_index: CompletenessStatusSchema,
    observed_coverage: CompletenessStatusSchema,
    transport: CompletenessStatusSchema,
    payload: CompletenessStatusSchema,
    representation: CompletenessStatusSchema
  })
  .strict()
  .readonly();

export const ContinuationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    continuation_id: ConditionalFieldIdSchema,
    query_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    result_version: ConditionalFieldIdSchema,
    expires_at: IsoDatetimeStringSchema,
    cursor: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const RepresentationDecisionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    policy: z.literal("construct_index_then_page_then_payload"),
    page_budget: NonNegativeIntSchema,
    identity_tie_break: z.literal("serialization")
  })
  .strict()
  .readonly();

export const InformationIndexSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    query_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    result_version: ConditionalFieldIdSchema,
    entries: z.array(IndexEntrySchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    completeness: CompletenessReportSchema,
    continuation: ContinuationSchema.nullable(),
    representation: RepresentationDecisionSchema
  })
  .strict()
  .readonly();

export type IndexRole = z.infer<typeof IndexRoleSchema>;
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export type CompletenessStatus = z.infer<typeof CompletenessStatusSchema>;
export type CompletenessReport = z.infer<typeof CompletenessReportSchema>;
export type Continuation = z.infer<typeof ContinuationSchema>;
export type RepresentationDecision = z.infer<typeof RepresentationDecisionSchema>;
export type InformationIndex = z.infer<typeof InformationIndexSchema>;
