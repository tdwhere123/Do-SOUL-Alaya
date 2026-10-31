import { AlayaError, SourceSemanticCorrespondencePreparationOptionsSchema } from "@do-soul/alaya-protocol";
import { join } from "node:path";
import { z } from "zod";
import { loadDatasetWindowWithIdentity } from "../../datasets/longmemeval/ingestion/fetch.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { SemanticChainConfigSchema, chainIdentity, readChainArtifact } from "../recall-measurement/contract.js";
import { SemanticProposalWorksetSchema } from "../semantic-cache/workset.js";
import { NATIVE_SEMANTIC_ROUTE, NativeSemanticRouteSchema } from "./native-arm.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const LongMemEvalSemanticConfigSchema = z.object({
  data_dir: z.string().min(1), pinned_meta_root: z.string().min(1), dataset_sha256: Digest,
  dataset_question_count: z.number().int().positive(), question_ids: z.array(z.string().min(1)).min(1).max(500),
  stage: z.enum(["development", "formal"]).optional(),
  previously_exposed_question_ids: z.array(z.string().min(1)).max(500).optional(),
  provider_url: SemanticProposalWorksetSchema.shape.provider_url,
  model: z.string().min(1), request_profile: z.string().refine(isExtractionRequestProfile),
  query_cache_root: z.string().min(1), recorded_at: z.string().datetime(), producer_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  budget: SemanticChainConfigSchema.shape.budget,
  output_byte_limit: SemanticChainConfigSchema.shape.output_byte_limit,
  max_output_tokens: SemanticChainConfigSchema.shape.max_output_tokens
}).strict();
export type LongMemEvalSemanticConfig = z.infer<typeof LongMemEvalSemanticConfigSchema>;
export const LongMemEvalNativeSemanticConfigSchema = LongMemEvalSemanticConfigSchema.extend({
  arm: z.literal("native_semantic"), workspace_prefix: z.string().min(1),
  correspondence_cache_root: z.string().min(1),
  discovery_page_cap: SemanticChainConfigSchema.shape.discovery_page_cap,
  correspondence_pair_cap: SemanticChainConfigSchema.shape.correspondence_pair_cap,
  authorized_scopes: SemanticChainConfigSchema.shape.authorized_scopes,
  correspondence_demand: SemanticChainConfigSchema.shape.correspondence_demand,
  correspondence_cap: SemanticChainConfigSchema.shape.correspondence_cap
}).strict().superRefine((config, context) => {
  const parsed = SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({
    correspondence_demand: config.correspondence_demand, correspondence_cap: config.correspondence_cap
  });
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
const LongMemEvalExperimentConfigSchema = z.union([LongMemEvalSemanticConfigSchema, LongMemEvalNativeSemanticConfigSchema]);
const InventoryRow = z.object({ index: z.number().int().nonnegative(), question_id: z.string(),
  cohort: z.enum(["answerable", "abstention"]) }).strict();
const SourceManifest = z.object({ source_id: z.string(), source_version: z.string(), content_digest: z.string(),
  corpus_digest: z.string(), session_id: z.string(), session_index: z.number(), round_index: z.number(),
  source_observed_at: z.string(), roles: z.array(z.enum(["user", "assistant"])) }).strict();
export const LongMemEvalSemanticFreezeSchema = z.object({
  contract: z.literal("longmemeval-semantic-development-v3"), config: LongMemEvalSemanticConfigSchema,
  implementation_revision: z.string(), metric: z.literal("session-bearing-source-round-mixed-any-at-5"),
  order_policy: z.literal("native_canonical_source_root_order"), mechanism: z.literal("source_only_interpretation_and_correspondence_not_exercised"),
  exposure: z.enum(["development_exposed", "formal_with_recorded_development_exposure"]), inventory: z.array(InventoryRow),
  selected: z.array(InventoryRow.extend({ question: z.string(), question_date: z.string(), interpretation_clock: z.string().datetime(),
    query_key: Digest, source_manifest: z.array(SourceManifest) }).strict()),
  query_workset: SemanticProposalWorksetSchema
}).strict();
export const LongMemEvalNativeSemanticFreezeSchema = LongMemEvalSemanticFreezeSchema.extend({
  contract: z.literal("longmemeval-native-semantic-v3"), config: LongMemEvalNativeSemanticConfigSchema,
  metric: z.literal("source-bearing-union-first-exposure-any-at-k-v1"),
  order_policy: z.literal(NATIVE_SEMANTIC_ROUTE.order.enumeration_policy),
  mechanism: z.literal("native_source_interpretation_and_semantic_correspondence"),
  native_route: NativeSemanticRouteSchema
}).strict();
const LongMemEvalExperimentFreezeSchema = z.discriminatedUnion("contract", [LongMemEvalSemanticFreezeSchema, LongMemEvalNativeSemanticFreezeSchema]);
export type LongMemEvalSemanticFreeze = z.infer<typeof LongMemEvalExperimentFreezeSchema>;

// Passive source interpretation caches do not feed native recall; historical inputs are refused, not ignored.
const RETIRED_SOURCE_CACHE_FIELDS = ["source_cache_roots", "source_publication_associations", "source_caches"] as const;
function refuseRetiredSourceCacheFields(value: unknown, label: string): void {
  const records = [value, isRecord(value) ? value.config : undefined].filter(isRecord);
  const retired = RETIRED_SOURCE_CACHE_FIELDS.filter(field => records.some(record => field in record));
  if (retired.length > 0) {
    throw new AlayaError("VALIDATION", `${label} uses the retired source interpretation cache format (${retired.join(", ")}); use a new experiment freeze`);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseLongMemEvalExperimentConfig(value: unknown) {
  refuseRetiredSourceCacheFields(value, "LongMemEval experiment config");
  return LongMemEvalExperimentConfigSchema.parse(value);
}
export function parseLongMemEvalExperimentFreeze(value: unknown): LongMemEvalSemanticFreeze {
  refuseRetiredSourceCacheFields(value, "LongMemEval experiment freeze");
  return LongMemEvalExperimentFreezeSchema.parse(value);
}

export function longMemEvalFreezePath(root: string): string { return join(root, "freeze.json"); }

export function readLongMemEvalSemanticFreeze(root: string): LongMemEvalSemanticFreeze {
  const frozen = parseLongMemEvalExperimentFreeze(readChainArtifact(longMemEvalFreezePath(root)));
  if (readCurrentExtractionAuthorityRevision() !== frozen.implementation_revision) throw new AlayaError("CONFLICT", "frozen implementation changed");
  return frozen;
}

export async function loadFrozenLongMemEvalDataset(config: LongMemEvalSemanticConfig) {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: config.data_dir, pinnedMetaRoot: config.pinned_meta_root, offset: 0
  });
  if (loaded.sha256 !== config.dataset_sha256 || loaded.datasetQuestionCount !== config.dataset_question_count) {
    throw new AlayaError("CONFLICT", "LongMemEval dataset differs from the frozen original identity");
  }
  return loaded;
}

export function assertLongMemEvalSemanticRows(frozen: Pick<LongMemEvalSemanticFreeze, "selected">, rows: readonly { question_id: string }[]): void {
  const expected = frozen.selected.map((row) => row.question_id).sort();
  const actual = rows.map((row) => row.question_id).sort();
  if (new Set(expected).size !== expected.length || chainIdentity(expected) !== chainIdentity(actual)) {
    throw new AlayaError("CONFLICT", "development result requires exact selected question denominator");
  }
}
