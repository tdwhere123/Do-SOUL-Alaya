import { isAbsolute } from "node:path";
import { z } from "zod";
import { SourceIndexConfigurationSchema, SourceEmbeddingRepresentationSchema } from "@do-soul/alaya-protocol";

/** Binding and cached-local execution schema authority. This module is a dependency
 * leaf so compiled contract and execution modules can initialize in either import order. */
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const CachedLocalSourceExecutionSchema = z.object({
  cache_root: z.string().min(1).refine(isAbsolute, "explicit absolute model cache required"),
  model_id: z.string().min(1),
  representation: SourceEmbeddingRepresentationSchema.optional()
}).strict();
export const IndexBindingSchema = z.object({
  configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int().nonnegative(), generation_id: z.string(),
  source_epoch: z.number().int().nonnegative(), status: z.enum(["ready", "partial", "valid_empty"]),
  enumeration_complete: z.boolean(), target_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative()
}).strict();
export const SemanticChainSourceIndexBindingSchema = CachedLocalSourceExecutionSchema.extend({
  kind: z.literal("cached_local"), index: IndexBindingSchema,
  preparation_path: z.string().min(1), preparation_identity: Digest
}).strict();
export type SemanticChainSourceIndexBinding = z.infer<typeof SemanticChainSourceIndexBindingSchema>;
