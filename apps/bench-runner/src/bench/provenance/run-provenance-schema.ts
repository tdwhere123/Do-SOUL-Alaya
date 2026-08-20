import { z } from "zod";
import { SelectionContractIdentitySchema } from "./contract/selection-contract-schema.js";
import { WorktreeStateAlgorithmSchema } from "@do-soul/alaya-eval";
import { EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION } from "./effective-recall-config.js";
import { ExtractionCacheIdentitySchema } from "./identity/extraction-cache-identity.js";
import { SourceAssertionSupplementBindingSchema } from
  "../extraction/cache/semantic-supplement/source-assertion-supplement.js";

export const runProvenanceSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const PrefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ExecutedDistIdentitySchema = z.object({
  algorithm: z.literal("sha256-reachable-path-file-sha256-v1"),
  sha256: runProvenanceSha256Schema,
  file_count: z.number().int().positive()
}).strict();
const AnswerRerankRuntimeProvenanceSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    provider_kind: z.literal("local_onnx_cross_encoder"),
    effective_model_id: z.string().min(1),
    model_artifact_sha256: runProvenanceSha256Schema
  }).strict()
]);
const EmbeddingSupplementRuntimeProvenanceSchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("local_onnx"),
    effective_model_id: z.string().min(1), model_artifact_sha256: runProvenanceSha256Schema,
    effective_schema_version: z.number().int().positive(),
    d2q_input: z.enum(["raw_content", "content_plus_hq"])
  }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("openai"),
    effective_model_id: z.string().min(1), effective_schema_version: z.literal(1),
    d2q_input: z.literal("raw_content")
  }).strict()
]);
const QuerySemanticFactorCacheIdentitySchema = z.object({
  schema_version: z.literal(3),
  cache_content_sha256: PrefixedSha256Schema,
  compiler_operator_id: z.string().min(1),
  system_prompt_sha256: PrefixedSha256Schema,
  request_template_sha256: PrefixedSha256Schema,
  model_id: z.string().min(1),
  provider_url_sha256: PrefixedSha256Schema,
  source_set_sha256: PrefixedSha256Schema,
  entry_count: z.number().int().nonnegative(),
  transport_routes: z.array(z.object({
    provider_url_sha256: PrefixedSha256Schema,
    model: z.string().min(1)
  }).strict().readonly()).readonly().optional()
}).strict().readonly();
const EmbeddingCacheOverlayBindingSchema = z.object({
  receipt_sha256: runProvenanceSha256Schema,
  overlay_sha256: runProvenanceSha256Schema,
  source_snapshot_db_sha256: runProvenanceSha256Schema,
  source_snapshot_manifest_sha256: runProvenanceSha256Schema,
  source_schema_version: z.number().int().positive(),
  recall_pipeline_version: z.string().min(1),
  memory_embedding_count: z.number().int().nonnegative(),
  evidence_embedding_count: z.number().int().nonnegative(),
  vector_space: z.object({
    provider_kind: z.string().min(1), model_id: z.string().min(1),
    schema_version: z.number().int().positive(), dimensions: z.number().int().positive(),
    d2q_input: z.enum(["raw_content", "content_plus_hq"]),
    model_artifact_sha256: runProvenanceSha256Schema.nullable()
  }).strict()
}).strict();

export const LongMemEvalRunProvenanceSchema = z.object({
  schema_version: z.literal(1),
  dataset_sha256: runProvenanceSha256Schema.optional(),
  selection: SelectionContractIdentitySchema.optional(),
  code: z.object({
    commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
    gate_sha256: runProvenanceSha256Schema.nullable(),
    gate_contract_path: z.string().min(1).optional(),
    worktree_state_sha256: runProvenanceSha256Schema.nullable(),
    worktree_state_algorithm: WorktreeStateAlgorithmSchema.optional(),
    worktree_clean: z.boolean().optional(),
    executed_dist: ExecutedDistIdentitySchema.nullable().default(null)
  }).strict(),
  extraction_cache: ExtractionCacheIdentitySchema.nullable(),
  semantic_supplement: SourceAssertionSupplementBindingSchema.optional(),
  runtime: z.object({
    node_version: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    embedding_mode: z.enum(["disabled", "env"]),
    embedding_provider_kind: z.enum(["openai", "local_onnx"]),
    embedding_provider_label: z.string().min(1),
    onnx_threads: z.number().int().min(1).max(64).nullable(),
    onnx_model_artifact_sha256: runProvenanceSha256Schema.optional(),
    embedding_supplement: EmbeddingSupplementRuntimeProvenanceSchema.optional(),
    answer_rerank: AnswerRerankRuntimeProvenanceSchema.optional(),
    query_semantic_factor_cache: QuerySemanticFactorCacheIdentitySchema.optional(),
    embedding_cache_overlay: EmbeddingCacheOverlayBindingSchema.optional(),
    reconciliation_basis: z.enum(["rule_only", "garden_llm"]).optional(),
    paired_env: z.record(z.string(), z.string()),
    cjk_segmentation: z.object({
      core_status: z.enum(["uninitialized", "loading", "ready", "unavailable"]),
      storage_status: z.enum(["uninitialized", "loading", "ready", "unavailable"]),
      warnings: z.array(z.string())
    }).strict().optional()
  }).strict(),
  execution: z.object({
    protocol: z.literal("sequential"),
    concurrency: z.literal(1),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    evaluated_count: z.number().int().nonnegative()
  }).strict(),
  recall_config: z.object({
    conf_slice_compatibility: z.boolean(),
    schema_version: z.union([
      z.literal(1),
      z.literal(EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION)
    ]).optional(),
    max_results: z.number().int().min(1).max(1_000).optional(),
    conflict_awareness: z.boolean().optional(),
    effective_config_sha256: runProvenanceSha256Schema.optional()
  }).strict(),
  seed_capabilities: z.object({
    facet_tags_enabled: z.boolean()
  }).strict().optional(),
  question_manifest: z.object({
    schema_version: z.literal(1),
    variant: z.enum(["longmemeval_oracle", "longmemeval_s", "longmemeval_m"]),
    dataset_sha256: runProvenanceSha256Schema,
    algorithm_version: z.string().min(1),
    target_count: z.number().int().positive(),
    selected_id_digest: runProvenanceSha256Schema,
    file_sha256: runProvenanceSha256Schema
  }).strict().nullable()
}).strict();

export type LongMemEvalRunProvenance = z.infer<typeof LongMemEvalRunProvenanceSchema>;
