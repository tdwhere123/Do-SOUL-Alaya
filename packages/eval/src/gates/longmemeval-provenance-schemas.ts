import { z } from "zod";
import { LongMemEvalSelectionContractIdentitySchema } from
  "../schema/longmemeval-selection-contract.js";
import {
  LongMemEvalArtifactDescriptorSchema,
  LongMemEvalExtractionSummarySchema
} from "./longmemeval-authority-schemas.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const CodeIdentitySchema = z.object({
  commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  gate_sha256: Sha256Schema,
  gate_contract_path: z.string().min(1),
  worktree_state_sha256: Sha256Schema,
  worktree_clean: z.literal(true),
  executed_dist: z.object({
    algorithm: z.literal("sha256-reachable-path-file-sha256-v1"),
    sha256: Sha256Schema,
    file_count: z.number().int().positive()
  }).strict()
}).passthrough();

const RuntimeSchema = z.object({
  node_version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  embedding_mode: z.enum(["disabled", "env"]),
  embedding_provider_kind: z.enum(["openai", "local_onnx"]),
  embedding_provider_label: z.string().min(1),
  onnx_threads: z.number().int().min(1).max(64).nullable(),
  onnx_model_artifact_sha256: Sha256Schema.optional(),
  embedding_supplement: z.unknown().optional(),
  answer_rerank: z.unknown().optional(),
  paired_env: z.record(z.string(), z.string())
}).passthrough();

const ExecutionSchema = z.object({
  protocol: z.literal("sequential"),
  concurrency: z.literal(1),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  evaluated_count: z.number().int().nonnegative()
}).passthrough();

const RecallConfigSchema = z.object({
  conf_slice_compatibility: z.boolean(),
  schema_version: z.literal(2),
  max_results: z.number().int().positive(),
  conflict_awareness: z.boolean(),
  effective_config_sha256: Sha256Schema
}).passthrough();

export const SingleRunProvenanceBindingSchema = z.object({
  schema_version: z.literal(1),
  dataset_sha256: Sha256Schema,
  selection: LongMemEvalSelectionContractIdentitySchema,
  code: CodeIdentitySchema,
  extraction_cache: LongMemEvalExtractionSummarySchema,
  runtime: RuntimeSchema,
  execution: ExecutionSchema,
  recall_config: RecallConfigSchema,
  seed_capabilities: z.object({
    facet_tags_enabled: z.boolean()
  }).strict().optional(),
  question_manifest: z.unknown().nullable()
}).passthrough();

const MergedShardSchema = z.object({
  shard_index: z.number().int().nonnegative(),
  source_slug: z.string().min(1),
  filename: z.string().min(1),
  sha256: Sha256Schema,
  extraction_authority_ref_filename: z.string().min(1).nullable().optional(),
  extraction_authority_ref_sha256: Sha256Schema.nullable().optional(),
  execution: ExecutionSchema
}).passthrough();

export const MergedRunProvenanceBindingSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_sharded_run_provenance"),
  gate_eligible: z.literal(true),
  requested_concurrency: z.number().int().min(1).max(32),
  effective_concurrency: z.number().int().min(1).max(32),
  evaluated_count: z.number().int().nonnegative(),
  executed_dist: z.object({ sha256: Sha256Schema }).passthrough(),
  selection_contract: LongMemEvalSelectionContractIdentitySchema,
  extraction_authority: LongMemEvalArtifactDescriptorSchema.nullable(),
  fanout_authority: LongMemEvalArtifactDescriptorSchema.nullable(),
  shards: z.array(MergedShardSchema).min(1).max(32)
}).passthrough().superRefine((value, context) => {
  if (value.effective_concurrency !== value.shards.length ||
      value.requested_concurrency < value.effective_concurrency) {
    context.addIssue({
      code: "custom",
      message: "merged concurrency differs from persisted shard plan"
    });
  }
  if (value.shards.some((shard, index) => shard.shard_index !== index)) {
    context.addIssue({
      code: "custom",
      message: "merged shard indices differ from canonical shard order"
    });
  }
});

export const RunProvenanceBindingSchema = z.union([
  SingleRunProvenanceBindingSchema,
  MergedRunProvenanceBindingSchema
]);

export type SingleRunProvenanceBinding = z.infer<
  typeof SingleRunProvenanceBindingSchema
>;
export type MergedRunProvenanceBinding = z.infer<
  typeof MergedRunProvenanceBindingSchema
>;
export type RunProvenanceBinding = z.infer<typeof RunProvenanceBindingSchema>;
