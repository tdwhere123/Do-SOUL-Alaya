import { z } from "zod";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";

export const SourceSemanticAccessPolicySchema = z.enum(["query-conditioned-v1", "canonical-v1"]);
/** Task-local navigation text; it cannot supply query semantics or durable source meaning. */
export const SourceSemanticAccessHintSchema = z.string().min(1).max(1024)
  .refine(value => value.trim().length > 0, "access hint must contain text");

export function refineSourceSemanticAccessHint(input: Readonly<{
  access_hint?: string; access_policy?: z.infer<typeof SourceSemanticAccessPolicySchema>; source_handle?: string;
}>, context: z.RefinementCtx): void {
  if (input.access_hint !== undefined && (input.source_handle !== undefined || input.access_policy === "canonical-v1")) {
    context.addIssue({ code: "custom", path: ["access_hint"],
      message: "access hint requires query-conditioned preparation without a source handle" });
  }
}
/** An explicit native read extent belongs to a current source tuple, not to its rank or text. */
export const SourceSemanticPreviewExtentsSchema = z.array(z.object({
  source_id: BoundedIdSchema, source_version: BoundedIdSchema, record_id: Sha256DigestSchema,
  byte_extent: z.number().int().min(1).max(4096)
}).strict().readonly()).min(1).max(64).readonly().superRefine((rows, ctx) => {
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (ids.has(row.source_id)) ctx.addIssue({ code: "custom", path: [index], message: "duplicate source preview tuple" });
    ids.add(row.source_id);
  }
});
export type SourceSemanticPreviewExtents = z.infer<typeof SourceSemanticPreviewExtentsSchema>;
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
  source_preview_extents: SourceSemanticPreviewExtentsSchema.optional(),
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
    const extent = access.source_preview_extents?.find(row => row.source_id === source.source_id);
    if (access.source_preview_extents !== undefined &&
        (extent?.record_id !== source.record_id || source.read_bytes > extent.byte_extent)) {
      ctx.addIssue({ code: "custom", message: "access observation exceeds bound source preview extent" });
    }
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
