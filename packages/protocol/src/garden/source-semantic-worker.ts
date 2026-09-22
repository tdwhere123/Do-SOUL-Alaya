import { z } from "zod";
import { SourceRecordIdentitySchema } from "../recall/field-contract/source-span.js";
import { BoundedIdSchema, BoundedLabelSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticCorrespondenceSchema } from "../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { ContinuationSchema, InformationIndexSchema } from "../recall/conditional-field/index-view.js";
import {
  SourceSemanticInterpretationSchema, SourceSemanticOutcomeSchema, SourceSemanticReasoningResultSchema
} from "./source-semantic-interpretation.js";

/** Frozen first-baseline library delivery. Canonical identity order; occupancy is source-root, not a source-interpretation label. */
export const SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP = 32 as const;
export const SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET = 10 as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX = 5 as const;
export const SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE = 16 as const;
export const SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION = "source-semantic-library-v2" as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY = "source_gold_root_identity" as const;
export const SOURCE_SEMANTIC_LIBRARY_TIE_POLICY = "canonical_identity" as const;

export const SOURCE_SEMANTIC_COVERAGE_STATES = [
  "complete", "open", "truncated", "unexercised"
] as const;

export const SourceSemanticCoverageSchema = z.object({
  discovery: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  source_interpretation: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  query_semantics: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  semantic_correspondence: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  conditional_computation: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  payload: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES)
}).strict().readonly();

export const SourceSemanticHandleDescriptorSchema = z.object({
  interpretation_id: Sha256DigestSchema,
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  interpretation: SourceSemanticInterpretationSchema.optional()
}).strict().readonly();

export const SourceSemanticWorkerWorkSchema = z.object({
  native_work: z.number().int().nonnegative(),
  logical_work: z.number().int().nonnegative().optional(),
  native_bytes: z.number().int().nonnegative(),
  logical_memory_bytes: z.number().int().nonnegative(),
  rss_bytes: z.number().int().nonnegative()
}).strict().readonly();

const PrepareSourceRequestSchema = z.object({
  kind: z.literal("prepare_source"),
  source_id: BoundedIdSchema,
  budget: RequestBudgetSchema
}).strict().readonly();

const PrepareQueryRequestSchema = z.object({
  kind: z.literal("prepare_query"),
  original_query: z.string().min(1).max(8192),
  query_semantics: SourceSemanticQuerySchema.optional(),
  source_handle: BoundedIdSchema.optional(),
  continuation_handle: BoundedIdSchema.optional(),
  budget: RequestBudgetSchema
}).strict().readonly();

const ValidateSourceRequestSchema = z.object({
  kind: z.literal("validate_source"), source_handle: BoundedIdSchema, budget: RequestBudgetSchema
}).strict().readonly();

const ReasonRequestSchema = z.object({
  kind: z.literal("reason"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().superRefine((request, context) => {
  const leased = request.query_handle !== undefined && request.semantic_correspondence !== undefined;
  const oneshot = request.source_interpretation_id !== undefined && request.query_semantics !== undefined &&
    request.semantic_correspondence !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    context.addIssue({
      code: "custom",
      message: "reason requires a query handle plus semantic correspondence, or one-shot source interpretation, query semantics, and semantic correspondence"
    });
  }
}).readonly();

const RecallRequestSchema = z.object({
  kind: z.literal("recall"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  semantic_correspondences: z.array(SourceSemanticCorrespondenceSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000),
  continuation: ContinuationSchema.optional()
}).strict().superRefine((request, context) => {
  const leased = request.query_handle !== undefined;
  const oneshot = request.query_semantics !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    context.addIssue({
      code: "custom",
      message: "recall requires a query handle, or original query plus query semantics"
    });
  }
}).readonly();

export const SourceSemanticWorkerRequestSchema = z.discriminatedUnion("kind", [
  PrepareSourceRequestSchema, ValidateSourceRequestSchema, PrepareQueryRequestSchema, ReasonRequestSchema,
  RecallRequestSchema
]);

export const SourceSemanticLibraryDiscoverySchema = z.object({
  eligible_source_count: NonNegativeIntSchema,
  visited_source_pages: NonNegativeIntSchema,
  visited_source_interpretation_pages: NonNegativeIntSchema,
  visited_source_interpretation_descriptors: NonNegativeIntSchema,
  candidate_prefix: z.array(Sha256DigestSchema).max(64).readonly(),
  examined_source_interpretation_ids: z.array(Sha256DigestSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly(),
  unexamined_source_interpretation_count: NonNegativeIntSchema,
  omitted_duplicate_bindings: NonNegativeIntSchema,
  examination_cap: z.literal(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP),
  open_residuals: z.boolean(),
  truncated: z.boolean()
}).strict().readonly();

export const SourceSemanticLibraryOrderSchema = z.object({
  enumeration_policy: z.literal("canonical"),
  tie_policy: z.literal(SOURCE_SEMANTIC_LIBRARY_TIE_POLICY),
  occupancy: z.literal(SOURCE_SEMANTIC_LIBRARY_OCCUPANCY),
  occupancy_prefix: z.literal(SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX),
  page_budget: z.literal(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET)
}).strict().readonly();

export const SourceSemanticLibrarySlotQualifierSchema = z.object({
  index: NonNegativeIntSchema,
  evidence_kind: z.enum(["semantic_proof", "source_evidence"]),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics_id: Sha256DigestSchema.optional(),
  semantic_correspondence_id: Sha256DigestSchema.optional(),
  conditional_computation_id: Sha256DigestSchema.optional()
}).strict().readonly();

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema
};

/** Complete conditions for one branch; an isolated source interpretation, query semantics, semantic correspondence, and conditional computation. */
export const SourceSemanticLibraryProofSchema = SourceSemanticReasoningResultSchema.unwrap().extend({
  original_query: z.string().min(1).max(8192),
  source_record: SourceRecordIdentitySchema,
  interpretation: SourceSemanticInterpretationSchema,
  query: SourceSemanticQuerySchema,
  semantic_correspondence: SourceSemanticCorrespondenceSchema,
  context: SourceSemanticEvaluationContextSchema
}).strict().readonly();
export type SourceSemanticLibraryProof = z.infer<typeof SourceSemanticLibraryProofSchema>;

export const SourceSemanticWorkerResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("validate_source"), source_id: BoundedIdSchema, source_version: BoundedIdSchema,
    content_digest: Sha256DigestSchema, source: z.string().max(65536), catalog: SourceReferenceCatalogSchema,
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("prepare_source"),
    source_handle: BoundedIdSchema,
    source_id: BoundedIdSchema,
    source_version: BoundedIdSchema,
    content_digest: Sha256DigestSchema,
    catalog: SourceReferenceCatalogSchema,
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("prepare_query"),
    query_handle: BoundedIdSchema.optional(),
    continuation_handle: BoundedIdSchema.optional(),
    query_semantics_id: Sha256DigestSchema.optional(),
    outcome: SourceSemanticOutcomeSchema.optional(),
    candidates: z.array(SourceSemanticHandleDescriptorSchema).max(64).readonly(),
    truncated: z.boolean(),
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("reason"),
    result: SourceSemanticReasoningResultSchema,
    interpretation: SourceSemanticInterpretationSchema.optional(),
    query: SourceSemanticQuerySchema.optional(),
    semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
    context: SourceSemanticEvaluationContextSchema.optional(),
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("recall"),
    delivery_id: BoundedIdSchema,
    protocol_version: z.literal(2),
    total_count: NonNegativeIntSchema,
    index: InformationIndexSchema,
    page_purpose: z.literal("membership"),
    discovery: SourceSemanticLibraryDiscoverySchema,
    order: SourceSemanticLibraryOrderSchema,
    slot_qualifiers: z.array(SourceSemanticLibrarySlotQualifierSchema).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).readonly(),
    proofs: z.array(SourceSemanticLibraryProofSchema).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).readonly().optional(),
    request_budget: RequestBudgetSchema.optional(),
    previews: z.record(z.string().min(1).max(16384), z.string().max(65536)).optional(),
    ...CoverageWork
  }).strict().readonly()
]);

export type SourceSemanticCoverage = z.infer<typeof SourceSemanticCoverageSchema>;
export type SourceSemanticHandleDescriptor = z.infer<typeof SourceSemanticHandleDescriptorSchema>;
export type SourceSemanticWorkerWork = z.infer<typeof SourceSemanticWorkerWorkSchema>;
export type SourceSemanticWorkerRequest = z.infer<typeof SourceSemanticWorkerRequestSchema>;
export type SourceSemanticWorkerResult = z.infer<typeof SourceSemanticWorkerResultSchema>;
export type SourceSemanticLibraryDiscovery = z.infer<typeof SourceSemanticLibraryDiscoverySchema>;
export type SourceSemanticLibraryOrder = z.infer<typeof SourceSemanticLibraryOrderSchema>;
export type SourceSemanticLibrarySlotQualifier = z.infer<typeof SourceSemanticLibrarySlotQualifierSchema>;
