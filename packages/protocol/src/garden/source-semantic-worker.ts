import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticAlignmentSchema } from "../recall/conditional-field/semantic-alignment.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { ContinuationSchema, InformationIndexSchema } from "../recall/conditional-field/index-view.js";
import {
  SourceSemanticInterpretationSchema, SourceSemanticOutcomeSchema, SourceSemanticReasoningResultSchema
} from "./source-semantic-interpretation.js";

/** Frozen first-baseline library delivery. Canonical identity order; occupancy is source-root, not H label. */
export const SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP = 32 as const;
export const SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET = 10 as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX = 5 as const;
export const SOURCE_SEMANTIC_LIBRARY_H_PAGE = 16 as const;
export const SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION = "source-semantic-library-v1" as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY = "source_gold_root_identity" as const;
export const SOURCE_SEMANTIC_LIBRARY_TIE_POLICY = "canonical_identity" as const;

export const SOURCE_SEMANTIC_COVERAGE_STATES = [
  "complete", "open", "truncated", "unexercised"
] as const;

export const SourceSemanticCoverageSchema = z.object({
  discovery: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  h: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  q: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  a: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  computation: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
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
  q: SourceSemanticQuerySchema.optional(),
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
  h_id: Sha256DigestSchema.optional(),
  q: SourceSemanticQuerySchema.optional(),
  a: SourceSemanticAlignmentSchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().superRefine((request, context) => {
  const leased = request.query_handle !== undefined && request.a !== undefined;
  const oneshot = request.h_id !== undefined && request.q !== undefined &&
    request.a !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    context.addIssue({
      code: "custom",
      message: "reason requires a query handle plus A, or one-shot H/Q/A"
    });
  }
}).readonly();

const RecallRequestSchema = z.object({
  kind: z.literal("recall"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  q: SourceSemanticQuerySchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  alignments: z.array(SourceSemanticAlignmentSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000),
  continuation: ContinuationSchema.optional()
}).strict().superRefine((request, context) => {
  const leased = request.query_handle !== undefined;
  const oneshot = request.q !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    context.addIssue({
      code: "custom",
      message: "recall requires a query handle, or original query plus Q"
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
  visited_h_pages: NonNegativeIntSchema,
  visited_h_descriptors: NonNegativeIntSchema,
  candidate_prefix: z.array(Sha256DigestSchema).max(64).readonly(),
  examined_h_ids: z.array(Sha256DigestSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly(),
  unexamined_h_count: NonNegativeIntSchema,
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
  h_id: Sha256DigestSchema.optional(),
  q_id: Sha256DigestSchema.optional(),
  a_id: Sha256DigestSchema.optional(),
  c_id: Sha256DigestSchema.optional()
}).strict().readonly();

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema
};

/** Complete conditions for one branch; an isolated H/Q/A/C, never a merged hypothesis. */
export const SourceSemanticLibraryProofSchema = SourceSemanticReasoningResultSchema.unwrap().extend({
  original_query: z.string().min(1).max(8192),
  interpretation: SourceSemanticInterpretationSchema,
  query: SourceSemanticQuerySchema,
  alignment: SourceSemanticAlignmentSchema,
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
    q_id: Sha256DigestSchema.optional(),
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
    alignment: SourceSemanticAlignmentSchema.optional(),
    context: SourceSemanticEvaluationContextSchema.optional(),
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("recall"),
    delivery_id: BoundedIdSchema,
    protocol_version: z.literal(1),
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
