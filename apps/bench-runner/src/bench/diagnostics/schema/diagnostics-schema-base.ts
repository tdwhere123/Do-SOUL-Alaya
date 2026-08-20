import { z } from "zod";
import {
  RecallCandidateAnswerFeaturesSchema,
  RecallEvidenceProjectionMatchReceiptSchema
} from "../../../harness/recall/recall-diagnostics-schema.js";
import { DELIVERY_MISS_DROP_REASONS } from "../miss/delivery-miss-taxonomy.js";
import {
  RecallFloodEdgeTraceV1Schema as DiagnosticFloodEdgeTraceV1Schema,
  RecallH1FuelCoverageSchemaShape as DiagnosticH1FuelCoverageSchemaShape,
  RecallH1MaxProductSchema as DiagnosticH1MaxProductSchema,
  RecallH1OverlaySchema as DiagnosticH1OverlaySchema,
  validateRecallH1FloodOverlayRelationship
} from "../../../harness/recall/h1/recall-h1-diagnostics-schema.js";
export { LongMemEvalQuestionMeasurementAxesSchema } from "../schema/measurement-axes-schema.js";

export const BenchEmbeddingProviderStateSchema = z.enum([
  "provider_returned",
  "provider_pending",
  "provider_failed",
  "provider_not_requested",
  "query_embedding_unusable",
  "unknown"
]);

export const DeliveryMissDropReasonSchema = z.enum(DELIVERY_MISS_DROP_REASONS);

const DiagnosticAdmissionAttemptSchema = z.object({
  pass: z.literal("final_selector"),
  selection_order: z.number().int().positive(),
  admitted: z.boolean(),
  dropped_reason: z.string().min(1).nullable()
}).strict().readonly();

export const DiagnosticAdmissionAttemptsSchema = z.array(
  DiagnosticAdmissionAttemptSchema
).readonly();

export const DiagnosticEvidenceProjectionMatchesSchema = z.array(
  RecallEvidenceProjectionMatchReceiptSchema
).readonly();

export const DiagnosticStreamRanksSchema = z
  .record(z.string(), z.number().nullable())
  .readonly();

export const DiagnosticStreamContributionsSchema = z
  .record(z.string(), z.number())
  .readonly();

export const DiagnosticAxisRanksSchema = z
  .record(z.string(), z.number().nullable())
  .readonly();

export const DiagnosticAxisContributionsSchema = z
  .record(z.string(), z.number())
  .readonly();

export {
  RecallFloodEdgeTraceV1Schema as DiagnosticFloodEdgeTraceV1Schema
} from "../../../harness/recall/h1/recall-h1-diagnostics-schema.js";

export const DiagnosticFloodPotentialSchema = z
  .object({
    R_obj: z.number(),
    Slice: z.number(),
    A_path: z.number(),
    B_evidence: z.number(),
    E_direct: z.number(),
    omega: z.number(),
    Flood: z.number(),
    lambda: z.number(),
    beta: z.number(),
    final_score: z.number(),
    slice_status: z.string(),
    path_status: z.string(),
    evidence_status: z.string(),
    e_direct_status: z.string(),
    fuel_verified: z.boolean(),
    edge_traces: z.array(DiagnosticFloodEdgeTraceV1Schema).max(16).readonly().optional(),
    edge_trace_truncated_count: z.number().int().nonnegative().optional(),
    score_mode: z.literal("rrf_seeded_h1_max_product").optional(),
    h1_max_product: DiagnosticH1MaxProductSchema.optional(),
    h1_overlay: DiagnosticH1OverlaySchema.optional()
  })
  .strict()
  .superRefine(validateRecallH1FloodOverlayRelationship)
  .readonly();

export const DiagnosticFloodFuelCoverageSchema = z
  .object({
    candidates_total: z.number().int().nonnegative(),
    cold_start_count: z.number().int().nonnegative(),
    fuel_verified_count: z.number().int().nonnegative(),
    slice_active_count: z.number().int().nonnegative(),
    path_active_count: z.number().int().nonnegative(),
    evidence_active_count: z.number().int().nonnegative(),
    ...DiagnosticH1FuelCoverageSchemaShape
  })
  .readonly();

export const DiagnosticScoreFactorsSchema = z.record(z.string(), z.unknown()).readonly();

export const DiagnosticQueryProbesSchema = z
  .object({
    normalized_query: z.string().nullable().optional(),
    subject_hints: z.array(z.string()).readonly().optional(),
    object_ids: z.array(z.string()).readonly().optional(),
    evidence_refs: z.array(z.string()).readonly().optional(),
    run_ids: z.array(z.string()).readonly().optional(),
    surface_ids: z.array(z.string()).readonly().optional(),
    file_paths: z.array(z.string()).readonly().optional(),
    command_names: z.array(z.string()).readonly().optional(),
    package_names: z.array(z.string()).readonly().optional(),
    task_refs: z.array(z.string()).readonly().optional(),
    dimensions: z.array(z.string()).readonly().optional(),
    scope_classes: z.array(z.string()).readonly().optional(),
    domain_tags: z.array(z.string()).readonly().optional(),
    lexical_terms: z.array(z.string()).readonly().optional(),
    expanded_terms: z.array(z.string()).readonly().optional(),
    phrases: z.array(z.string()).readonly().optional(),
    char_ngrams: z.array(z.string()).readonly().optional(),
    date_terms: z.array(z.string()).readonly().optional()
  })
  .strict()
  .readonly();

export const DiagnosticCandidateAnswerFeaturesSchema =
  RecallCandidateAnswerFeaturesSchema;

export const LongMemEvalMissTaxonomySchema = z.enum([
  "candidate_absent",
  "materialization_drop",
  "fine_assessment_drop",
  "budget_drop",
  "delivery_order_drop",
  "answer_set_coverage_drop",
  "evaluation_or_gold_issue"
]);
