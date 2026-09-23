import { z } from "zod";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";

export const SourceSemanticAccessPolicySchema = z.enum(["query-conditioned-v1", "canonical-v1"]);
const SourceSemanticAccessStoppingReasonSchema = z.enum([
  "budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"
]);
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
  stopping_reasons: z.array(SourceSemanticAccessStoppingReasonSchema).max(5).readonly()
}).strict().readonly().superRefine((access, ctx) => {
  for (const source of access.source_candidates) {
    if (source.body_bytes === null ? source.read_bytes !== 0 || source.complete
      : source.read_bytes > source.body_bytes || source.complete && source.read_bytes !== source.body_bytes) {
      ctx.addIssue({ code: "custom", message: "access source completeness contradicts its byte extent" });
    }
  }
  // Native traces omit all other observed rows, including earlier pages.
  if (access.trace.omitted_source_count !== access.observed_source_count - access.source_candidates.length
    || access.trace.omitted_interpretation_count !== access.observed_interpretation_count - access.interpretation_candidates.length) {
    ctx.addIssue({ code: "custom", message: "access trace omitted counts contradict its observed pool" });
  }
  if (access.trace.kind === "preparation_page"
    && (access.trace.source_offset + access.source_candidates.length > access.observed_source_count
      || access.trace.interpretation_offset + access.interpretation_candidates.length > access.observed_interpretation_count)) {
    ctx.addIssue({ code: "custom", message: "access preparation offsets exceed its observed pool" });
  }
});

export type SourceSemanticAccessPolicy = z.infer<typeof SourceSemanticAccessPolicySchema>;
export type SourceSemanticAccessSignal = z.infer<typeof SourceSemanticAccessSignalSchema>;
export type SourceSemanticAccessReceipt = z.infer<typeof SourceSemanticAccessReceiptSchema>;
