import { createHash } from "node:crypto";
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
  "deepseek-v4-nonthinking-v1",
  "mimo-v2.5-nonthinking-v1"
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

export const LongMemEvalSupplementalSourceShardWireSchema = z.object({
  cache_key: Sha256Schema,
  raw_json_sha256: Sha256Schema
}).strict().readonly();

const SupplementalSourceReceiptExtensionBaseSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval-extraction-supplemental-source-extension"),
  source_binding: LongMemEvalSupplementalSourceProvenanceBindingWireSchema,
  target_binding: LongMemEvalSupplementalSourceProvenanceBindingWireSchema,
  source_shard_count: z.number().int().positive(),
  source_key_set_sha256: Sha256Schema,
  source_content_sha256: Sha256Schema,
  added_shard_count: z.number().int().positive(),
  added_key_set_sha256: Sha256Schema,
  added_content_sha256: Sha256Schema,
  target_shard_count: z.number().int().positive(),
  target_key_set_sha256: Sha256Schema,
  target_content_sha256: Sha256Schema,
  source_shards: z.array(LongMemEvalSupplementalSourceShardWireSchema).min(1).readonly(),
  added_shards: z.array(LongMemEvalSupplementalSourceShardWireSchema).min(1).readonly(),
  extension_sha256: Sha256Schema
}).strict();

export const LongMemEvalSupplementalSourceReceiptExtensionWireSchema =
  SupplementalSourceReceiptExtensionBaseSchema.readonly()
    .superRefine(refineSupplementalSourceReceiptExtension);
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
  policy_version: z.literal("longmemeval-product-default-v2"),
  code: LongMemEvalPromotionCodeWireSchema,
  source_selection: LongMemEvalSelectionContractIdentitySchema,
  next_selection: LongMemEvalSelectionContractIdentitySchema,
  matrix_authorization_sha256: Sha256Schema,
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
    target_cache: LongMemEvalExpansionTargetCacheWireSchema,
    supplemental_source_receipt_extension:
      LongMemEvalSupplementalSourceReceiptExtensionWireSchema.optional()
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
export type LongMemEvalSupplementalSourceShardWire = z.infer<
  typeof LongMemEvalSupplementalSourceShardWireSchema
>;
export type LongMemEvalSupplementalSourceReceiptExtensionWire = z.infer<
  typeof LongMemEvalSupplementalSourceReceiptExtensionWireSchema
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

export function buildLongMemEvalSupplementalSourceReceiptExtension(input: {
  readonly source_binding: z.infer<
    typeof LongMemEvalSupplementalSourceProvenanceBindingWireSchema
  >;
  readonly target_binding: z.infer<
    typeof LongMemEvalSupplementalSourceProvenanceBindingWireSchema
  >;
  readonly source_shards: readonly LongMemEvalSupplementalSourceShardWire[];
  readonly added_shards: readonly LongMemEvalSupplementalSourceShardWire[];
}): LongMemEvalSupplementalSourceReceiptExtensionWire {
  const sourceShards = sortSupplementalShards(input.source_shards);
  const addedShards = sortSupplementalShards(input.added_shards);
  const source = supplementalShardSummary(sourceShards);
  const added = supplementalShardSummary(addedShards);
  const target = supplementalShardSummary([...sourceShards, ...addedShards]);
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-supplemental-source-extension" as const,
    source_binding: input.source_binding,
    target_binding: input.target_binding,
    source_shard_count: source.shard_count,
    source_key_set_sha256: source.key_set_sha256,
    source_content_sha256: source.content_sha256,
    added_shard_count: added.shard_count,
    added_key_set_sha256: added.key_set_sha256,
    added_content_sha256: added.content_sha256,
    target_shard_count: target.shard_count,
    target_key_set_sha256: target.key_set_sha256,
    target_content_sha256: target.content_sha256,
    source_shards: sourceShards,
    added_shards: addedShards
  };
  return LongMemEvalSupplementalSourceReceiptExtensionWireSchema.parse({
    ...unsigned,
    extension_sha256: sha256Canonical(unsigned)
  });
}

export function assertLongMemEvalSupplementalSourceReceiptExtension(
  value: unknown
): LongMemEvalSupplementalSourceReceiptExtensionWire {
  return LongMemEvalSupplementalSourceReceiptExtensionWireSchema.parse(value);
}

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

function refineSupplementalSourceReceiptExtension(
  value: z.infer<typeof SupplementalSourceReceiptExtensionBaseSchema>,
  context: z.RefinementCtx
): void {
  const source = supplementalShardSummary(value.source_shards);
  const added = supplementalShardSummary(value.added_shards);
  const target = supplementalShardSummary([
    ...value.source_shards,
    ...value.added_shards
  ]);
  const sourceKeys = new Set(value.source_shards.map((shard) => shard.cache_key));
  const duplicateSource = sourceKeys.size !== value.source_shards.length;
  const duplicateAdded = new Set(value.added_shards.map((shard) => shard.cache_key))
    .size !== value.added_shards.length;
  const overlap = value.added_shards.some((shard) => sourceKeys.has(shard.cache_key));
  const { extension_sha256: _digest, ...unsigned } = value;
  if (duplicateSource || duplicateAdded || overlap ||
      !sameSupplementalSummary(value, "source", source) ||
      !sameSupplementalSummary(value, "added", added) ||
      !sameSupplementalSummary(value, "target", target) ||
      !sameBindingSummary(value.source_binding, source) ||
      !sameBindingSummary(value.target_binding, target) ||
      value.source_binding.physical_provider_url !==
        value.target_binding.physical_provider_url ||
      value.source_binding.physical_model !== value.target_binding.physical_model ||
      value.extension_sha256 !== sha256Canonical(unsigned)) {
    context.addIssue({
      code: "custom",
      message: "supplemental source receipt extension is invalid"
    });
  }
}

function supplementalShardSummary(
  shards: readonly z.infer<typeof LongMemEvalSupplementalSourceShardWireSchema>[]
) {
  const sorted = sortSupplementalShards(shards);
  return {
    shard_count: sorted.length,
    key_set_sha256: sha256Text(sorted.map((shard) => shard.cache_key).join("\n")),
    content_sha256: sha256Text(sorted.map((shard) =>
      `${shard.cache_key}\0${shard.raw_json_sha256}`
    ).join("\n"))
  };
}

function sortSupplementalShards(
  shards: readonly z.infer<typeof LongMemEvalSupplementalSourceShardWireSchema>[]
): readonly LongMemEvalSupplementalSourceShardWire[] {
  return [...shards].sort((left, right) =>
    left.cache_key.localeCompare(right.cache_key)
  );
}

function sameSupplementalSummary(
  value: z.infer<typeof SupplementalSourceReceiptExtensionBaseSchema>,
  prefix: "source" | "added" | "target",
  summary: ReturnType<typeof supplementalShardSummary>
): boolean {
  return value[`${prefix}_shard_count`] === summary.shard_count &&
    value[`${prefix}_key_set_sha256`] === summary.key_set_sha256 &&
    value[`${prefix}_content_sha256`] === summary.content_sha256;
}

function sameBindingSummary(
  binding: z.infer<typeof LongMemEvalSupplementalSourceProvenanceBindingWireSchema>,
  summary: ReturnType<typeof supplementalShardSummary>
): boolean {
  return binding.shard_count === summary.shard_count &&
    binding.key_set_sha256 === summary.key_set_sha256;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
