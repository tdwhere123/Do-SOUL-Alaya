import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../../shared/schema-primitives.js";
import { Sha256DigestSchema } from "./common.js";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticHandleSchema, SourceSemanticSupportSchema
} from "../../garden/source-semantic-draft.js";

export const SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT = "source-semantic-correspondence-v3" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_RELATION = "contextual_equivalence" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_DESCRIPTOR_HANDLE = /^source([1-9][0-9]{0,2})$/u;

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

export const SourceSemanticEndpointCorrespondenceSchema = z.object({
  relation: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_RELATION),
  query_endpoint: SourceSemanticQueryEndpointSchema,
  source_endpoint: SourceSemanticSourceEndpointSchema,
  query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
  source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly(),
  applicable_context: Handle.optional()
}).strict().readonly();

const SourceSemanticCorrespondenceObjectSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT),
  source_interpretation_id: Sha256DigestSchema,
  query_semantics_id: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  correspondences: z.array(SourceSemanticEndpointCorrespondenceSchema).max(256).readonly(),
  domains: z.array(z.object({ query_domain: Handle, source_domain: Handle,
    query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
    source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly()
  }).strict().readonly()).max(64).readonly().optional(),
  membership_assumptions: z.array(z.object({ query_variable: Handle, source_domain: Handle,
    restrictions: z.array(Handle).max(16).readonly(), status: z.enum(["member", "excluded"]),
    query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
    description: z.string().min(1).max(1024)
  }).strict().readonly()).max(64).readonly().optional()
}).strict();

export const SourceSemanticCorrespondenceSchema = SourceSemanticCorrespondenceObjectSchema.superRefine((semantic_correspondence, context) => {
  if (new TextEncoder().encode(JSON.stringify(semantic_correspondence)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "source semantic correspondence exceeds its byte bound" });
  }
}).readonly();

export type SourceSemanticQueryEndpoint = z.infer<typeof SourceSemanticQueryEndpointSchema>;
export type SourceSemanticSourceEndpoint = z.infer<typeof SourceSemanticSourceEndpointSchema>;
export type SourceSemanticEndpointCorrespondence = z.infer<typeof SourceSemanticEndpointCorrespondenceSchema>;
export type SourceSemanticCorrespondence = z.infer<typeof SourceSemanticCorrespondenceSchema>;
