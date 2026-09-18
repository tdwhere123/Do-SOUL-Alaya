import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticAlignmentSchema } from "../recall/conditional-field/semantic-alignment.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { SourceSemanticDraftSchema } from "../garden/source-semantic-draft.js";
import {
  SourceSemanticInterpretationSchema,
  SourceSemanticOutcomeSchema,
  SourceSemanticPublishedInterpretationSchema,
  SourceSemanticReasoningResultSchema
} from "../garden/source-semantic-interpretation.js";
import {
  SourceSemanticCoverageSchema,
  SourceSemanticHandleDescriptorSchema,
  SourceSemanticWorkerWorkSchema
} from "../garden/source-semantic-worker.js";

/** Public MCP/CLI host operations. Provider-free. invariant §25 additive minor. */
export const SOUL_INTERPRETATION_TOOL_NAME = "soul.interpretation" as const;

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema,
  provider_attempts: z.literal(0)
};

export const SoulInterpretationPrepareSourceRequestSchema = z.object({
  operation: z.literal("prepare_source"),
  source_id: BoundedIdSchema,
  budget: RequestBudgetSchema
}).strict().readonly();

export const SoulInterpretationProposeRequestSchema = z.object({
  operation: z.literal("propose"),
  source_handle: BoundedIdSchema,
  draft: SourceSemanticDraftSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema
}).strict().readonly();

export const SoulInterpretationPrepareQueryRequestSchema = z.object({
  operation: z.literal("prepare_query"),
  original_query: z.string().min(1).max(8192),
  q: SourceSemanticQuerySchema.optional(),
  source_handle: BoundedIdSchema.optional(),
  budget: RequestBudgetSchema
}).strict().readonly();

export const SoulInterpretationReasonRequestSchema = z.object({
  operation: z.literal("reason"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  h_id: Sha256DigestSchema.optional(),
  q: SourceSemanticQuerySchema.optional(),
  a: SourceSemanticAlignmentSchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().readonly();

export const SoulInterpretationRequestSchema = z.discriminatedUnion("operation", [
  SoulInterpretationPrepareSourceRequestSchema,
  SoulInterpretationProposeRequestSchema,
  SoulInterpretationPrepareQueryRequestSchema,
  SoulInterpretationReasonRequestSchema
]);

export const SoulInterpretationPrepareSourceResponseSchema = z.object({
  operation: z.literal("prepare_source"),
  source_handle: BoundedIdSchema.optional(),
  source_id: BoundedIdSchema.optional(),
  source_version: BoundedIdSchema.optional(),
  content_digest: Sha256DigestSchema.optional(),
  catalog: SourceReferenceCatalogSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationProposeResponseSchema = z.object({
  operation: z.literal("propose"),
  outcome: SourceSemanticOutcomeSchema,
  published: SourceSemanticPublishedInterpretationSchema.optional(),
  evidence_object_id: BoundedIdSchema.optional(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationPrepareQueryResponseSchema = z.object({
  operation: z.literal("prepare_query"),
  query_handle: BoundedIdSchema.optional(),
  q_id: Sha256DigestSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  candidates: z.array(SourceSemanticHandleDescriptorSchema).max(64).readonly(),
  truncated: z.boolean(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationReasonResponseSchema = z.object({
  operation: z.literal("reason"),
  result: SourceSemanticReasoningResultSchema.optional(),
  interpretation: SourceSemanticInterpretationSchema.optional(),
  query: SourceSemanticQuerySchema.optional(),
  alignment: SourceSemanticAlignmentSchema.optional(),
  context: SourceSemanticEvaluationContextSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationResponseSchema = z.discriminatedUnion("operation", [
  SoulInterpretationPrepareSourceResponseSchema,
  SoulInterpretationProposeResponseSchema,
  SoulInterpretationPrepareQueryResponseSchema,
  SoulInterpretationReasonResponseSchema
]);

export type SoulInterpretationRequest = z.infer<typeof SoulInterpretationRequestSchema>;
export type SoulInterpretationResponse = z.infer<typeof SoulInterpretationResponseSchema>;
export type SoulInterpretationPrepareSourceRequest = z.infer<typeof SoulInterpretationPrepareSourceRequestSchema>;
export type SoulInterpretationProposeRequest = z.infer<typeof SoulInterpretationProposeRequestSchema>;
export type SoulInterpretationPrepareQueryRequest = z.infer<typeof SoulInterpretationPrepareQueryRequestSchema>;
export type SoulInterpretationReasonRequest = z.infer<typeof SoulInterpretationReasonRequestSchema>;
