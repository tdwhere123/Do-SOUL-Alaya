import { z } from "zod";
import { LongMemEvalSelectionContractIdentitySchema } from
  "../schema/longmemeval-selection-contract.js";
import { canonicalJson } from "./canonical-json.js";

export const LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME =
  "longmemeval-extraction-authority.json";
export const LONGMEMEVAL_EXTRACTION_AUTHORITY_REF_FILENAME =
  "longmemeval-extraction-authority-ref.json";
export const LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME =
  "longmemeval-fanout-authority.json";
export const MAX_LONGMEMEVAL_EXTRACTION_AUTHORITY_BYTES = 64 * 1024 * 1024;
export const LONGMEMEVAL_EXTRACTION_REQUEST_PROFILES = [
  "provider-default-v1",
  "deepseek-v4-nonthinking-v1"
] as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ExtractionRequestProfileSchema = z.enum(
  LONGMEMEVAL_EXTRACTION_REQUEST_PROFILES
);
const SupplementalSourceBindingBaseSchema = z.object({
  kind: z.literal("longmemeval-extraction-supplemental-source"),
  receipt_sha256: Sha256Schema,
  shard_count: z.number().int().positive(),
  key_set_sha256: Sha256Schema,
  physical_model: z.string().min(1)
}).strict();

export const LongMemEvalSupplementalSourceManifestBindingWireSchema =
  SupplementalSourceBindingBaseSchema.extend({
    physical_provider_url: z.string().min(1)
  }).strict().readonly();

export const LongMemEvalSupplementalSourceProvenanceBindingWireSchema =
  SupplementalSourceBindingBaseSchema.extend({
    physical_provider_url: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  }).strict().readonly();
export const LongMemEvalContentClosureIndexSchema = z.record(
  Sha256Schema,
  z.tuple([
    Sha256Schema,
    z.number().int().nonnegative(),
    z.number().int().nonnegative()
  ]).readonly()
);

export const LongMemEvalMatrixTreatmentWireSchema = z.object({
  embedding_supplement: z.boolean(),
  answer_rerank: z.boolean()
}).strict().readonly();

export const LongMemEvalPromotionCodeWireSchema = z.object({
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
  worktree_state_sha256: Sha256Schema,
  executed_dist: z.object({
    algorithm: z.literal("sha256-reachable-path-file-sha256-v1"),
    sha256: Sha256Schema,
    file_count: z.number().int().positive()
  }).strict().readonly()
}).strict().readonly();

const ProductDefaultSchema = z.object({
  cell: z.literal("B"),
  treatment: LongMemEvalMatrixTreatmentWireSchema,
  bundle_sha256: Sha256Schema
}).strict().readonly();

const PromotionIdentityBaseSchema = z.object({
  contract_sha256: Sha256Schema,
  policy_version: z.literal("longmemeval-product-default-v1"),
  code: LongMemEvalPromotionCodeWireSchema,
  source_selection: LongMemEvalSelectionContractIdentitySchema,
  next_selection: LongMemEvalSelectionContractIdentitySchema,
  matrix_sha256: Sha256Schema,
  product_default: ProductDefaultSchema
}).strict();

const PromotionIdentitySchema = PromotionIdentityBaseSchema.readonly()
  .superRefine(assertPromotionProgression);

const SourceSnapshotSchema = z.object({
  db_path: z.string().min(1),
  manifest_sha256: Sha256Schema,
  db_sha256: Sha256Schema,
  sidecar_sha256: Sha256Schema
}).strict().readonly();

export const LongMemEvalExpansionSourceCacheWireSchema = z.object({
  manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  model_family: z.string().min(1),
  request_profile: ExtractionRequestProfileSchema,
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: Sha256Schema,
  window_offset: z.literal(0),
  window_limit: z.literal(100),
  expected_turns: z.number().int().positive(),
  expected_key_set_sha256: Sha256Schema,
  content_closure_sha256: Sha256Schema,
  supplemental_source_binding_sha256: Sha256Schema.optional()
}).strict().readonly();

const TargetCacheBaseSchema = z.object({
  extraction_model: z.string().min(1),
  model_family: z.string().min(1),
  request_profile: ExtractionRequestProfileSchema,
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: Sha256Schema,
  window_offset: z.literal(0),
  window_limit: z.literal(500),
  expected_turns: z.number().int().positive(),
  expected_key_set_sha256: Sha256Schema,
  supplemental_source_binding_sha256: Sha256Schema.optional()
}).strict();

export const LongMemEvalExpansionTargetCacheWireSchema =
  TargetCacheBaseSchema.extend({
    content_closure_sha256: Sha256Schema
  }).strict().readonly();

export const LongMemEvalExpansionSourceAnchorWireSchema =
  PromotionIdentityBaseSchema.extend({
    schema_version: z.literal(1),
    kind: z.literal("longmemeval_100_to_500_source_anchor"),
    source_snapshot: SourceSnapshotSchema,
    source_cache: LongMemEvalExpansionSourceCacheWireSchema,
    target_cache: TargetCacheBaseSchema.readonly()
  }).strict().readonly().superRefine(assertPromotionProgression);

export const LongMemEvalExpansionLineageWireSchema =
  PromotionIdentityBaseSchema.extend({
    schema_version: z.literal(1),
    kind: z.literal("longmemeval_100_to_500_expansion"),
    source_snapshot: SourceSnapshotSchema,
    source_cache: LongMemEvalExpansionSourceCacheWireSchema,
    target_cache: LongMemEvalExpansionTargetCacheWireSchema
  }).strict().readonly().superRefine(assertPromotionProgression);

const ExtractionSummaryBaseSchema = z.object({
  schema_version: z.literal(3),
  manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  model_family: z.string().min(1),
  request_profile: ExtractionRequestProfileSchema,
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: Sha256Schema,
  requested_turns: z.number().int().nonnegative(),
  cached_turns: z.number().int().nonnegative(),
  coverage: z.literal(1),
  storage: z.enum(["git-tracked", "archive"]).optional(),
  archive_url: z.string().min(1).optional(),
  archive_sha256: Sha256Schema.optional(),
  built_at: z.string().min(1).optional(),
  builder: z.string().min(1).optional(),
  fill_status: z.literal("complete"),
  window_offset: z.number().int().nonnegative(),
  window_limit: z.number().int().nonnegative(),
  expected_turns: z.number().int().nonnegative(),
  expected_key_set_sha256: Sha256Schema,
  content_closure_sha256: Sha256Schema,
  expansion_source_anchor: LongMemEvalExpansionSourceAnchorWireSchema.optional(),
  expansion_lineage: LongMemEvalExpansionLineageWireSchema.optional()
}).passthrough();

export const LongMemEvalExtractionSummarySchema =
  ExtractionSummaryBaseSchema.extend({
    supplemental_source_receipt:
      LongMemEvalSupplementalSourceProvenanceBindingWireSchema.optional()
  }).passthrough().readonly();

export const LongMemEvalFullExtractionCacheSchema =
  ExtractionSummaryBaseSchema.extend({
    supplemental_source_receipt:
      LongMemEvalSupplementalSourceProvenanceBindingWireSchema.optional(),
    content_closure_index: LongMemEvalContentClosureIndexSchema
  }).passthrough().readonly();

export const LongMemEvalExtractionAuthoritySchema = z.object({
  schema_version: z.literal(1),
  source_manifest_schema_version: z.literal(3),
  source_manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  model_family: z.string().min(1),
  request_profile: ExtractionRequestProfileSchema,
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: Sha256Schema,
  requested_turns: z.number().int().nonnegative(),
  cached_turns: z.number().int().nonnegative(),
  coverage: z.literal(1),
  fill_status: z.literal("complete"),
  window_offset: z.number().int().nonnegative(),
  window_limit: z.number().int().nonnegative(),
  expected_turns: z.number().int().nonnegative(),
  expected_key_set_sha256: Sha256Schema,
  content_closure_sha256: Sha256Schema,
  content_closure_index: LongMemEvalContentClosureIndexSchema,
  supplemental_source_binding_sha256: Sha256Schema.optional(),
  expansion_source_anchor_sha256: Sha256Schema.optional(),
  expansion_lineage_sha256: Sha256Schema.optional()
}).strict().readonly();

const ArtifactDescriptorBaseSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  bytes: z.number().int().positive()
}).strict();

export const LongMemEvalArtifactDescriptorSchema =
  ArtifactDescriptorBaseSchema.readonly();

export const LongMemEvalFanoutPlanSchema = z.object({
  shard_index: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive()
}).strict().readonly();

export const LongMemEvalFanoutAuthoritySchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_parent_fanout_authority"),
  run_nonce: z.string().uuid(),
  promotion: PromotionIdentitySchema,
  dataset: z.object({
    variant: z.literal("longmemeval_s"),
    sha256: Sha256Schema
  }).strict().readonly(),
  cache: z.object({
    extraction_authority: LongMemEvalArtifactDescriptorSchema,
    source_manifest_sha256: Sha256Schema,
    content_closure_sha256: Sha256Schema,
    expansion_source_anchor_sha256: Sha256Schema,
    expansion_lineage_sha256: Sha256Schema
  }).strict().readonly(),
  code: LongMemEvalPromotionCodeWireSchema,
  requested_concurrency: z.number().int().min(2).max(32),
  effective_concurrency: z.number().int().min(2).max(32),
  plans: z.array(LongMemEvalFanoutPlanSchema).min(2).max(32).readonly()
}).strict().readonly().superRefine((value, context) => {
  if (!hasExactFanoutPlan(value) ||
      value.dataset.sha256 !== value.promotion.next_selection.dataset_sha256 ||
      canonicalJson(value.code) !== canonicalJson(value.promotion.code)) {
    context.addIssue({
      code: "custom",
      message: "fanout authority must bind exact [0,500) and promotion identity"
    });
  }
});

const FanoutReferenceDescriptorSchema = ArtifactDescriptorBaseSchema.extend({
  run_nonce: z.string().uuid()
}).strict().readonly();

export const LongMemEvalShardAuthorityReferenceSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal("longmemeval_extraction_authority_ref"),
  authority: LongMemEvalArtifactDescriptorSchema,
  fanout: FanoutReferenceDescriptorSchema,
  plan: LongMemEvalFanoutPlanSchema,
  source_manifest_sha256: Sha256Schema
}).strict().readonly();

export type LongMemEvalExtractionSummary = z.infer<
  typeof LongMemEvalExtractionSummarySchema
>;
export type LongMemEvalMatrixTreatmentWire = z.infer<
  typeof LongMemEvalMatrixTreatmentWireSchema
>;
export type LongMemEvalPromotionCodeWire = z.infer<
  typeof LongMemEvalPromotionCodeWireSchema
>;
export type LongMemEvalExpansionSourceAnchorWire = z.infer<
  typeof LongMemEvalExpansionSourceAnchorWireSchema
>;
export type LongMemEvalExpansionLineageWire = z.infer<
  typeof LongMemEvalExpansionLineageWireSchema
>;
export type LongMemEvalExtractionAuthority = z.infer<
  typeof LongMemEvalExtractionAuthoritySchema
>;
export type LongMemEvalArtifactDescriptor = z.infer<
  typeof LongMemEvalArtifactDescriptorSchema
>;
export type LongMemEvalFanoutPlan = z.infer<typeof LongMemEvalFanoutPlanSchema>;
export type LongMemEvalFanoutAuthority = z.infer<
  typeof LongMemEvalFanoutAuthoritySchema
>;
export type LongMemEvalShardAuthorityReference = z.infer<
  typeof LongMemEvalShardAuthorityReferenceSchema
>;

function assertPromotionProgression(
  value: z.infer<typeof PromotionIdentityBaseSchema>,
  context: z.RefinementCtx
): void {
  if (value.source_selection.selected_count !== 100 ||
      value.next_selection.selected_count !== 500 ||
      value.source_selection.dataset_sha256 !== value.next_selection.dataset_sha256 ||
      value.product_default.treatment.embedding_supplement !== true ||
      value.product_default.treatment.answer_rerank !== false) {
    context.addIssue({
      code: "custom",
      message: "promotion must bind canonical 100Q to product-B 500Q"
    });
  }
}

function hasExactFanoutPlan(
  value: z.infer<typeof LongMemEvalFanoutAuthoritySchema>
): boolean {
  if (value.requested_concurrency !== value.effective_concurrency ||
      value.plans.length !== value.effective_concurrency) return false;
  let cursor = 0;
  for (const [index, plan] of value.plans.entries()) {
    if (plan.shard_index !== index || plan.offset !== cursor) return false;
    cursor += plan.limit;
  }
  return cursor === 500;
}
