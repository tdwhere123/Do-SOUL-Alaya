import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../../shared/schema-primitives.js";
import { Sha256DigestSchema } from "./common.js";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticHandleSchema, SourceSemanticSupportSchema
} from "../../garden/source-semantic-draft.js";

export const SOURCE_SEMANTIC_ALIGNMENT_CONTRACT = "source-semantic-alignment-v1" as const;
export const SOURCE_SEMANTIC_ALIGNMENT_RELATION = "contextual_equivalence" as const;

const Handle = SourceSemanticHandleSchema;

export const SourceSemanticQueryEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("referent"), variable: Handle }).strict().readonly(),
  z.object({ kind: z.literal("predicate"), alternative: z.number().int().nonnegative(), frame: Handle }).strict().readonly(),
  z.object({ kind: z.literal("slot"), alternative: z.number().int().nonnegative(), frame: Handle, slot: Handle }).strict().readonly()
]);

export const SourceSemanticSourceEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("referent"), referent: Handle }).strict().readonly(),
  z.object({ kind: z.literal("frame"), frame: Handle }).strict().readonly(),
  z.object({ kind: z.literal("slot"), frame: Handle, slot: Handle }).strict().readonly()
]);

export const SourceSemanticCorrespondenceSchema = z.object({
  relation: z.literal(SOURCE_SEMANTIC_ALIGNMENT_RELATION),
  query_endpoint: SourceSemanticQueryEndpointSchema,
  source_endpoint: SourceSemanticSourceEndpointSchema,
  query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
  source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly(),
  applicable_context: Handle.optional()
}).strict().readonly();

export const SourceSemanticAlignmentSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_ALIGNMENT_CONTRACT),
  h_id: Sha256DigestSchema,
  q_id: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  correspondences: z.array(SourceSemanticCorrespondenceSchema).max(256).readonly()
}).strict().superRefine((alignment, context) => {
  if (new TextEncoder().encode(JSON.stringify(alignment)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "source semantic alignment exceeds its byte bound" });
  }
}).readonly();

export type SourceSemanticQueryEndpoint = z.infer<typeof SourceSemanticQueryEndpointSchema>;
export type SourceSemanticSourceEndpoint = z.infer<typeof SourceSemanticSourceEndpointSchema>;
export type SourceSemanticCorrespondence = z.infer<typeof SourceSemanticCorrespondenceSchema>;
export type SourceSemanticAlignment = z.infer<typeof SourceSemanticAlignmentSchema>;
