import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticAlignmentSchema } from "../recall/conditional-field/semantic-alignment.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import {
  SourceSemanticInterpretationSchema, SourceSemanticOutcomeSchema, SourceSemanticReasoningResultSchema
} from "./source-semantic-interpretation.js";

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
  contract_version: BoundedLabelSchema
}).strict().readonly();

export const SourceSemanticWorkerWorkSchema = z.object({
  native_work: z.number().int().nonnegative(),
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
  budget: RequestBudgetSchema
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

export const SourceSemanticWorkerRequestSchema = z.discriminatedUnion("kind", [
  PrepareSourceRequestSchema, PrepareQueryRequestSchema, ReasonRequestSchema
]);

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema
};

export const SourceSemanticWorkerResultSchema = z.discriminatedUnion("kind", [
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
  }).strict().readonly()
]);

export type SourceSemanticCoverage = z.infer<typeof SourceSemanticCoverageSchema>;
export type SourceSemanticHandleDescriptor = z.infer<typeof SourceSemanticHandleDescriptorSchema>;
export type SourceSemanticWorkerWork = z.infer<typeof SourceSemanticWorkerWorkSchema>;
export type SourceSemanticWorkerRequest = z.infer<typeof SourceSemanticWorkerRequestSchema>;
export type SourceSemanticWorkerResult = z.infer<typeof SourceSemanticWorkerResultSchema>;
