import { join } from "node:path";
import { z } from "zod";
import { loadDatasetWindowWithIdentity } from "../../datasets/longmemeval/ingestion/fetch.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { SemanticChainConfigSchema, chainIdentity, readChainArtifact } from "../semantic-chain/contract.js";
import { SemanticProposalWorksetSchema } from "../semantic-proposal/workset.js";
import { NativeSemanticRouteSchema, SourceCacheFreezeSchema } from "./native-arm.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const LongMemEvalSemanticConfigSchema = z.object({
  data_dir: z.string().min(1), pinned_meta_root: z.string().min(1), dataset_sha256: Digest,
  dataset_question_count: z.number().int().positive(), question_ids: z.array(z.string().min(1)).min(1).max(500),
  stage: z.enum(["development", "formal"]).optional(),
  previously_exposed_question_ids: z.array(z.string().min(1)).max(500).optional(),
  model: z.string().min(1), request_profile: z.string().refine(isExtractionRequestProfile),
  query_cache_root: z.string().min(1), recorded_at: z.string().datetime(), producer_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  ...SemanticChainConfigSchema.pick({ budget: true, output_byte_limit: true, max_output_tokens: true }).shape
}).strict();
export type LongMemEvalSemanticConfig = z.infer<typeof LongMemEvalSemanticConfigSchema>;
export const LongMemEvalNativeSemanticConfigSchema = LongMemEvalSemanticConfigSchema.extend({
  arm: z.literal("native_semantic"), workspace_prefix: z.string().min(1),
  source_cache_roots: z.array(z.string().min(1)), correspondence_cache_root: z.string().min(1),
  source_publication_associations: z.array(z.object({ source_id: z.string(), source_version: z.string(),
    generation_key: Digest, request_digest: Digest }).strict()),
  ...SemanticChainConfigSchema.pick({ discovery_page_cap: true, correspondence_pair_cap: true, authorized_scopes: true }).shape
}).strict();
export const LongMemEvalExperimentConfigSchema = z.union([LongMemEvalSemanticConfigSchema, LongMemEvalNativeSemanticConfigSchema]);
const InventoryRow = z.object({ index: z.number().int().nonnegative(), question_id: z.string(),
  cohort: z.enum(["answerable", "abstention"]) }).strict();
const SourceManifest = z.object({ source_id: z.string(), source_version: z.string(), content_digest: z.string(),
  corpus_digest: z.string(), session_id: z.string(), session_index: z.number(), round_index: z.number(),
  source_observed_at: z.string(), roles: z.array(z.enum(["user", "assistant"])) }).strict();
export const LongMemEvalSemanticFreezeSchema = z.object({
  contract: z.literal("longmemeval-semantic-development-v2"), config: LongMemEvalSemanticConfigSchema,
  implementation_revision: z.string(), metric: z.literal("session-bearing-source-round-mixed-any-at-5"),
  order_policy: z.literal("native_canonical_source_root_order"), mechanism: z.literal("source_only_interpretation_and_correspondence_not_exercised"),
  exposure: z.enum(["development_exposed", "formal_with_recorded_development_exposure"]), inventory: z.array(InventoryRow),
  selected: z.array(InventoryRow.extend({ question: z.string(), question_date: z.string(), interpretation_clock: z.string().datetime(),
    query_key: Digest, source_manifest: z.array(SourceManifest) }).strict()),
  query_workset: SemanticProposalWorksetSchema
}).strict();
export const LongMemEvalNativeSemanticFreezeSchema = LongMemEvalSemanticFreezeSchema.extend({
  contract: z.literal("longmemeval-native-semantic-v1"), config: LongMemEvalNativeSemanticConfigSchema,
  metric: z.literal("source-bearing-union-first-exposure-any-at-k-v1"),
  mechanism: z.literal("native_source_interpretation_and_semantic_correspondence"),
  native_route: NativeSemanticRouteSchema, source_caches: z.array(SourceCacheFreezeSchema)
}).strict();
export const LongMemEvalExperimentFreezeSchema = z.discriminatedUnion("contract", [LongMemEvalSemanticFreezeSchema, LongMemEvalNativeSemanticFreezeSchema]);
export type LongMemEvalSemanticFreeze = z.infer<typeof LongMemEvalExperimentFreezeSchema>;

export function readLongMemEvalSemanticFreeze(root: string): LongMemEvalSemanticFreeze {
  const frozen = LongMemEvalExperimentFreezeSchema.parse(readChainArtifact(join(root, "freeze.json")));
  if (readCurrentExtractionAuthorityRevision() !== frozen.implementation_revision) throw new Error("frozen implementation changed");
  return frozen;
}

export async function loadFrozenLongMemEvalDataset(config: LongMemEvalSemanticConfig) {
  const loaded = await loadDatasetWindowWithIdentity("longmemeval_s", {
    dataDir: config.data_dir, pinnedMetaRoot: config.pinned_meta_root, offset: 0
  });
  if (loaded.sha256 !== config.dataset_sha256 || loaded.datasetQuestionCount !== config.dataset_question_count) {
    throw new Error("LongMemEval dataset differs from the frozen original identity");
  }
  return loaded;
}

export function assertLongMemEvalSemanticRows(frozen: Pick<LongMemEvalSemanticFreeze, "selected">, rows: readonly { question_id: string }[]): void {
  const expected = frozen.selected.map((row) => row.question_id).sort();
  const actual = rows.map((row) => row.question_id).sort();
  if (new Set(expected).size !== expected.length || chainIdentity(expected) !== chainIdentity(actual)) {
    throw new Error("development result requires exact selected question denominator");
  }
}
