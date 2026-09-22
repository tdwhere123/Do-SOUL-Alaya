import { z } from "zod";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";

export const SourceSemanticAccessPolicySchema = z.enum(["query-conditioned-v1", "canonical-v1"]);
export const SourceSemanticAccessSignalSchema = z.object({
  source_text_score: z.number().min(0).max(1).nullable(),
  interpretation_reading_score: z.number().min(0).max(1),
  reading: z.object({ query_alternative: NonNegativeIntSchema, query_frame: BoundedIdSchema,
    source_frame: BoundedIdSchema }).strict().readonly().optional()
}).strict().readonly();

/** Access scores are local lexical observations, never assertion or proof grades. Array order is the frozen access order. */
export const SourceSemanticAccessReceiptSchema = z.object({
  contract: z.literal("source-semantic-access-v1"),
  policy: SourceSemanticAccessPolicySchema,
  input_id: Sha256DigestSchema,
  pool_id: Sha256DigestSchema,
  observed_source_count: NonNegativeIntSchema,
  observed_interpretation_count: NonNegativeIntSchema,
  source_candidates: z.array(z.object({
    source_id: BoundedIdSchema, record_id: Sha256DigestSchema,
    read_bytes: NonNegativeIntSchema, body_bytes: NonNegativeIntSchema.nullable(), complete: z.boolean(),
    signal: SourceSemanticAccessSignalSchema
  }).strict().readonly()).max(64).readonly(),
  interpretation_candidates: z.array(z.object({
    interpretation_id: Sha256DigestSchema, record_id: Sha256DigestSchema,
    signal: SourceSemanticAccessSignalSchema
  }).strict().readonly()).max(64).readonly(),
  trace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preparation_page"), source_offset: NonNegativeIntSchema,
      interpretation_offset: NonNegativeIntSchema, omitted_source_count: NonNegativeIntSchema,
      omitted_interpretation_count: NonNegativeIntSchema }).strict().readonly(),
    z.object({ kind: z.literal("library_selection"), omitted_source_count: NonNegativeIntSchema,
      omitted_interpretation_count: NonNegativeIntSchema }).strict().readonly()
  ]),
  unvisited_sources: z.boolean(),
  unvisited_interpretations: z.boolean(),
  stopping_reasons: z.array(z.enum(["budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"])).max(5).readonly()
}).strict().readonly();

export type SourceSemanticAccessPolicy = z.infer<typeof SourceSemanticAccessPolicySchema>;
export type SourceSemanticAccessSignal = z.infer<typeof SourceSemanticAccessSignalSchema>;
export type SourceSemanticAccessReceipt = z.infer<typeof SourceSemanticAccessReceiptSchema>;
