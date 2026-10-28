import { isAbsolute } from "node:path";
import { z } from "zod";
import { SourceIndexConfigurationSchema, SourceEmbeddingRepresentationSchema, SourceIndexLexicalRepresentationSchema,
  SourceIndexWindowingSchema } from "@do-soul/alaya-protocol";

/** Binding and cached-local execution schema authority. This module is a dependency
 * leaf so compiled contract and execution modules can initialize in either import order. */
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const LocalEmbeddingSelectionSchema = z.object({
  cache_root: z.string().min(1).refine(isAbsolute, "explicit absolute model cache required"),
  model_id: z.string().min(1)
}).strict();
const MemoryEmbeddingSelectionSchema = LocalEmbeddingSelectionSchema.extend({
  artifact_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();
const CachedLocalSourceExecution = LocalEmbeddingSelectionSchema.extend({
  source_scope: z.literal("separate").optional(),
  artifact_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  memory: MemoryEmbeddingSelectionSchema.optional(),
  memory_warmup: z.literal("eager").optional(),
  representation: SourceEmbeddingRepresentationSchema.optional(),
  windowing: SourceIndexWindowingSchema.optional(),
  lexical: SourceIndexLexicalRepresentationSchema.optional()
}).strict();
const validExecution = (value: z.infer<typeof CachedLocalSourceExecution>) => value.source_scope === "separate"
  ? value.memory !== undefined && value.artifact_digest !== undefined : value.memory === undefined;
export const CachedLocalSourceExecutionSchema = CachedLocalSourceExecution.refine(validExecution,
  "separate Source execution requires a Memory selection and expected artifact digest");
export const IndexBindingSchema = z.object({
  configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int().nonnegative(), generation_id: z.string(),
  source_epoch: z.number().int().nonnegative(), status: z.enum(["ready", "partial", "valid_empty"]),
  enumeration_complete: z.boolean(), target_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative()
}).strict();
export const SemanticChainSourceIndexBindingSchema = CachedLocalSourceExecution.extend({
  kind: z.literal("cached_local"), index: IndexBindingSchema,
  preparation_path: z.string().min(1), preparation_identity: Digest
}).strict().refine(validExecution, "separate Source execution requires a Memory selection and expected artifact digest");
export type SemanticChainSourceIndexBinding = z.infer<typeof SemanticChainSourceIndexBindingSchema>;
