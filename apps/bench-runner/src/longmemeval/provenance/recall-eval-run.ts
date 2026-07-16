import type { RecallEvalRuntimeAttribution } from "../lifecycle/recall-eval-runtime.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot.js";
import { bindSnapshotRunProvenanceAuthority } from
  "../snapshot/run-provenance.js";
import type { SnapshotExtractionAuthority } from
  "../snapshot/extraction-authority.js";
import {
  buildLongMemEvalRunProvenance,
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "./run.js";

export async function buildRecallEvalRunProvenance(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly runtimeAttribution: RecallEvalRuntimeAttribution;
  readonly evaluatedCount: number;
  readonly offset: number;
  readonly limit: number | null;
  readonly commitSha7: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly computeExecutedDistIdentity?: () => Promise<unknown>;
  readonly extractionAuthority: SnapshotExtractionAuthority | null;
}): Promise<LongMemEvalRunProvenance> {
  const current = await buildCurrentRecallRunProvenance(input);
  const snapshotIdentity = resolveFullSnapshotIdentity(input);
  const extractionCache = resolveSnapshotExtractionCache(input);
  return LongMemEvalRunProvenanceSchema.parse({
    ...current,
    ...(snapshotIdentity === null ? {} : snapshotIdentity),
    recall_config: {
      ...current.recall_config,
      ...input.runtimeAttribution.recall_config
    },
    extraction_cache: extractionCache,
    ...(input.manifest.run_provenance?.seed_capabilities === undefined
      ? {}
      : { seed_capabilities: input.manifest.run_provenance.seed_capabilities }),
    question_manifest: input.manifest.run_provenance?.question_manifest ?? null
  });
}

function buildCurrentRecallRunProvenance(
  input: Parameters<typeof buildRecallEvalRunProvenance>[0]
) {
  return buildLongMemEvalRunProvenance({
    opts: {
      variant: input.manifest.variant as "longmemeval_oracle" | "longmemeval_s" | "longmemeval_m",
      historyRoot: "",
      embeddingMode: input.runtimeAttribution.embedding_mode,
      embeddingProviderKind: input.runtimeAttribution.embedding_provider_kind,
      offset: input.offset,
      ...(input.limit === null ? {} : { limit: input.limit })
    },
    evaluatedCount: input.evaluatedCount,
    commitSha7: input.commitSha7,
    embeddingProviderLabel: input.runtimeAttribution.embedding_provider_label,
    env: withoutExtractionCacheRoot(input.env),
    recallOptions: {
      maxResults: input.runtimeAttribution.recall_config.max_results,
      conflictAwareness: input.runtimeAttribution.recall_config.conflict_awareness
    },
    runtime: {
      nodeVersion: input.runtimeAttribution.node_version,
      platform: input.runtimeAttribution.platform,
      arch: input.runtimeAttribution.arch
    },
    ...(input.computeExecutedDistIdentity === undefined
      ? {}
      : { computeExecutedDistIdentity: input.computeExecutedDistIdentity })
  });
}

function resolveSnapshotExtractionCache(
  input: Parameters<typeof buildRecallEvalRunProvenance>[0]
) {
  const snapshotProvenance = input.manifest.run_provenance;
  return snapshotProvenance === undefined
    ? null
    : input.extractionAuthority === null
      ? snapshotProvenance.extraction_cache
      : bindSnapshotRunProvenanceAuthority(
          snapshotProvenance,
          input.extractionAuthority
        ).extraction_cache;
}

function resolveFullSnapshotIdentity(
  input: Parameters<typeof buildRecallEvalRunProvenance>[0]
): Pick<LongMemEvalRunProvenance, "dataset_sha256" | "selection"> | null {
  const provenance = input.manifest.run_provenance;
  const datasetSha = provenance?.dataset_sha256;
  const selection = provenance?.selection;
  const fullSnapshot = input.offset === 0 && input.limit === null &&
    input.evaluatedCount === input.manifest.question_count;
  if (!fullSnapshot || datasetSha === undefined || selection === undefined ||
      input.manifest.dataset_sha256 !== datasetSha ||
      selection.dataset_sha256 !== datasetSha ||
      selection.selected_count !== input.manifest.question_count ||
      selection.selected_id_digest !== input.manifest.question_id_digest) {
    return null;
  }
  return { dataset_sha256: datasetSha, selection };
}

export function isRecallEvalRunEvidenceEligible(input: {
  readonly runtimeAttribution: RecallEvalRuntimeAttribution;
  readonly provenance: LongMemEvalRunProvenance;
  readonly expectedQuestionIdDigest: string;
  readonly actualQuestionIdDigest: string;
  readonly evaluatedCount: number;
  readonly offset: number;
  readonly limit: number | null;
}): boolean {
  return input.runtimeAttribution.gate_eligible &&
    isLongMemEvalRunProvenanceGateEligible(input.provenance) &&
    input.expectedQuestionIdDigest === input.actualQuestionIdDigest &&
    input.provenance.execution.evaluated_count === input.evaluatedCount &&
    input.provenance.execution.offset === input.offset &&
    input.provenance.execution.limit === input.limit &&
    sameCurrentTreatment(
      input.runtimeAttribution,
      input.provenance.runtime,
      input.provenance.recall_config
    );
}

function sameCurrentTreatment(
  attribution: RecallEvalRuntimeAttribution,
  runtime: LongMemEvalRunProvenance["runtime"],
  recallConfig: LongMemEvalRunProvenance["recall_config"]
): boolean {
  return runtime.node_version === attribution.node_version &&
    runtime.platform === attribution.platform && runtime.arch === attribution.arch &&
    runtime.embedding_mode === attribution.embedding_mode &&
    runtime.embedding_provider_kind === attribution.embedding_provider_kind &&
    runtime.embedding_provider_label === attribution.embedding_provider_label &&
    runtime.onnx_threads === attribution.onnx_threads &&
    (runtime.onnx_model_artifact_sha256 ?? null) ===
      attribution.onnx_model_artifact_sha256 &&
    JSON.stringify(runtime.embedding_supplement) ===
      JSON.stringify(attribution.embedding_supplement) &&
    JSON.stringify(runtime.answer_rerank) === JSON.stringify(attribution.answer_rerank) &&
    recallConfig.schema_version === attribution.recall_config.schema_version &&
    recallConfig.max_results === attribution.recall_config.max_results &&
    recallConfig.conflict_awareness === attribution.recall_config.conflict_awareness &&
    recallConfig.effective_config_sha256 ===
      attribution.recall_config.effective_config_sha256;
}

function withoutExtractionCacheRoot(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  return { ...env, ALAYA_BENCH_EXTRACTION_CACHE_ROOT: undefined };
}
