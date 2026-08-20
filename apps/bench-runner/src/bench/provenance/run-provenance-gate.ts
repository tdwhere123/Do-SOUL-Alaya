import {
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../extraction/cache/extraction-cache-manifest.js";
import {
  containsExtractionFillQuestionWindow,
  hasCompleteExtractionFillAuthority,
  hasCompleteExtractionFillSummary
} from "../extraction/fill/fill-authority.js";
import { readOptionalTreatmentBoolean } from "../../harness/strict-treatment-config.js";
import { EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION } from "./effective-recall-config.js";
import { WORKTREE_STATE_ALGORITHM_HEAD_LF } from "@do-soul/alaya-eval";
import {
  runProvenanceSha256Schema,
  type LongMemEvalRunProvenance
} from "./run-provenance-schema.js";

export function isLongMemEvalRunProvenanceGateEligible(
  provenance: LongMemEvalRunProvenance
): boolean {
  const cache = provenance.extraction_cache;
  return cache !== null &&
    cache.schema_version === EXTRACTION_CACHE_MANIFEST_VERSION &&
    hasCompleteExtractionFillAuthority(cache) &&
    isLongMemEvalRunProvenanceSummaryGateEligible(provenance);
}

export function isLongMemEvalRunProvenanceSummaryGateEligible(
  provenance: LongMemEvalRunProvenance
): boolean {
  const cache = provenance.extraction_cache;
  return provenance.code.commit_sha !== undefined &&
    provenance.code.commit_sha.startsWith(provenance.code.commit_sha7) &&
    provenance.code.gate_contract_path !== undefined &&
    provenance.code.worktree_clean === true &&
    provenance.code.worktree_state_algorithm === WORKTREE_STATE_ALGORITHM_HEAD_LF &&
    provenance.code.gate_sha256 !== null &&
    provenance.code.worktree_state_sha256 !== null &&
    provenance.code.executed_dist !== null && cache !== null &&
    cache.schema_version === EXTRACTION_CACHE_MANIFEST_VERSION &&
    hasCompleteExtractionFillSummary(cache) &&
    containsExtractionFillQuestionWindow(cache, provenance.execution.offset, provenance.execution.evaluated_count) &&
    hasCurrentDatasetBinding(provenance) &&
    hasCurrentRecallConfigIdentity(provenance.recall_config) &&
    hasRequiredEmbeddingArtifact(provenance.runtime) &&
    hasConsistentEmbeddingSupplementProvenance(provenance.runtime) &&
    hasConsistentAnswerRerankProvenance(provenance.runtime);
}

function hasCurrentDatasetBinding(
  provenance: LongMemEvalRunProvenance
): boolean {
  const revision = provenance.extraction_cache?.dataset_revision;
  const datasetSha = provenance.dataset_sha256;
  const selection = provenance.selection;
  const manifestSha = provenance.question_manifest?.dataset_sha256;
  return datasetSha !== undefined && selection !== undefined &&
    revision === datasetSha && selection.dataset_sha256 === datasetSha &&
    selection.selected_count === provenance.execution.evaluated_count &&
    (manifestSha === undefined || manifestSha === datasetSha) &&
    runProvenanceSha256Schema.safeParse(revision).success;
}

function hasCurrentRecallConfigIdentity(
  config: LongMemEvalRunProvenance["recall_config"]
): boolean {
  return config.schema_version === EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION &&
    config.max_results !== undefined &&
    config.conflict_awareness !== undefined &&
    config.effective_config_sha256 !== undefined;
}

function hasRequiredEmbeddingArtifact(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const supplement = runtime.embedding_supplement;
  if (supplement?.enabled === true && supplement.provider_kind === "local_onnx") {
    return runtime.onnx_model_artifact_sha256 === supplement.model_artifact_sha256;
  }
  return runtime.onnx_model_artifact_sha256 === undefined;
}

function hasConsistentEmbeddingSupplementProvenance(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const pairedEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  );
  const d2qEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_RECALL_D2Q,
    "ALAYA_RECALL_D2Q"
  );
  const identity = runtime.embedding_supplement;
  if (identity === undefined) return false;
  if (pairedEnabled !== null && pairedEnabled !== identity.enabled) return false;
  if (identity.enabled !== (runtime.embedding_mode === "env")) return false;
  if (!identity.enabled) return true;
  if (identity.provider_kind !== runtime.embedding_provider_kind) return false;
  if (!runtime.embedding_provider_label.endsWith(`:${identity.effective_model_id}`)) return false;
  if (identity.provider_kind === "openai") return identity.d2q_input === "raw_content";
  return identity.d2q_input === (d2qEnabled === true ? "content_plus_hq" : "raw_content") &&
    runtime.onnx_model_artifact_sha256 === identity.model_artifact_sha256 &&
    (runtime.paired_env.ALAYA_LOCAL_EMBEDDING_MODEL === undefined ||
      runtime.paired_env.ALAYA_LOCAL_EMBEDDING_MODEL === identity.effective_model_id);
}

function hasConsistentAnswerRerankProvenance(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const pairedEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  );
  return runtime.answer_rerank?.enabled === false && pairedEnabled === null;
}
