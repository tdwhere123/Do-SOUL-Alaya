import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../../harness/daemon.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnedTempRoot,
  externalTempRoot,
  finalizeOwnedTempRoot,
  type OwnedTempRoot
} from "./owned-temp-root.js";
import { throwLifecycleErrors } from "./errors.js";
import { restoreSnapshotToDataDir } from "../snapshot.js";
import {
  verifySnapshotArtifactIntegrity,
  type SnapshotArtifactIntegrity
} from "../snapshot/integrity.js";
import { resolveBenchEmbeddingProviderLabel } from "../runner-helpers.js";
import {
  resolveEmbeddingSupplementRuntimeProvenance,
  resolveLocalCrossEncoderRuntimeProvenance,
  type EmbeddingSupplementRuntimeProvenance,
  type LocalCrossEncoderRuntimeProvenance
} from "../provenance/local-onnx.js";
import {
  RECALL_PIPELINE_VERSION
} from "../../shared/version.js";
import {
  deriveSnapshotAttribution,
  type LongMemEvalSnapshotManifest
} from "../snapshot.js";
import { prepareRecallEvalRestoredDb } from "../snapshot/recall-eval-db.js";
import type { RecallEvalSnapshotBundle } from "../snapshot/recall-eval-loader.js";
import { restoreLegacySnapshotToDataDir } from "../snapshot/legacy-substrate.js";
import type { RecallEvalOptions } from "./recall-eval-contract.js";
import { readOptionalOnnxThreadCount } from "../../harness/strict-treatment-config.js";
import {
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults,
  type EffectiveRecallConfigIdentity,
  type EffectiveRecallOptions
} from "../provenance/effective-recall-config.js";
import type { BenchRecallWeightOverrides } from "../../harness/recall-weight-overrides.js";

export function recallEvalEmbeddingMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): BenchEmbeddingMode {
  const value = env.ALAYA_RECALL_EVAL_EMBEDDING?.trim().toLowerCase();
  if (value === undefined || value.length === 0 || value === "disabled") return "disabled";
  if (value === "env") return "env";
  throw new Error("ALAYA_RECALL_EVAL_EMBEDDING must be env or disabled");
}

export function recallEvalEmbeddingProviderKind(
  _env: Readonly<Record<string, string | undefined>> = process.env
): BenchEmbeddingProviderKind {
  return "local_onnx";
}

export function recallEvalEmbeddingProviderLabel(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return resolveBenchEmbeddingProviderLabel(
    recallEvalEmbeddingMode(env),
    env,
    recallEvalEmbeddingProviderKind(env)
  );
}

export interface RecallEvalRuntimeAttribution {
  readonly status: "attributed" | "legacy_unattributed";
  readonly gate_eligible: boolean;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
  readonly embedding_mode: BenchEmbeddingMode;
  readonly embedding_provider_kind: BenchEmbeddingProviderKind;
  readonly embedding_provider_label: string;
  readonly onnx_threads: number | null;
  readonly onnx_model_artifact_sha256: string | null;
  readonly embedding_supplement: EmbeddingSupplementRuntimeProvenance;
  readonly answer_rerank: LocalCrossEncoderRuntimeProvenance;
  readonly recall_config: EffectiveRecallConfigIdentity;
  readonly evaluation_slice?: Readonly<{
    offset: number;
    limit: number | null;
    evaluated_count: number;
    question_id_digest: string;
  }>;
  readonly hydration_binding?: Readonly<{
    dataset_sha256: string;
    source: "external_expected_sha256";
  }>;
  readonly snapshot_binding: Readonly<{
    commit_sha7: string | null;
    gate_sha256: string | null;
    worktree_state_sha256: string | null;
    extraction_cache_manifest_sha256: string | null;
    extraction_cache_requested_turns: number | null;
    extraction_cache_cached_turns: number | null;
    extraction_cache_coverage: number | null;
    dataset_sha256: string | null;
    question_id_digest: string | null;
    snapshot_manifest_sha256: string | null;
    producer_recall_pipeline_version: string;
    consumer_recall_pipeline_version: string;
    producer_schema_migration_version: number;
  }>;
}

type RecallEvalRuntimeIdentity = Pick<
  RecallEvalRuntimeAttribution,
  | "embedding_mode" | "embedding_provider_kind" | "embedding_provider_label"
  | "onnx_threads" | "onnx_model_artifact_sha256" | "embedding_supplement"
  | "answer_rerank" | "recall_config"
>;

export async function buildRecallEvalRuntimeAttribution(
  manifest: LongMemEvalSnapshotManifest,
  env: Readonly<Record<string, string | undefined>> = process.env,
  evaluatorBinding: Readonly<{
    snapshotManifestSha256?: string | null;
    datasetSha256?: string | null;
    recallOptions?: EffectiveRecallOptions;
    recallWeightOverrides?: BenchRecallWeightOverrides;
  }> = {}
): Promise<RecallEvalRuntimeAttribution> {
  const identity = await resolveRecallEvalRuntimeIdentity(
    env,
    evaluatorBinding.recallOptions ?? {
      maxResults: readRecallEvalMaxResults(env.ALAYA_RECALL_EVAL_MAX_RESULTS),
      conflictAwareness: true
    },
    evaluatorBinding.recallWeightOverrides
  );
  const snapshotAttribution = deriveSnapshotAttribution({
    artifactIntegrity: manifest.artifact_integrity,
    runProvenance: manifest.run_provenance,
    questionIdDigest: manifest.question_id_digest,
    datasetSha256: manifest.dataset_sha256,
    extractionProvenance: manifest.extraction_provenance
  });
  return {
    status: manifest.attribution?.status ?? "legacy_unattributed",
    gate_eligible: isRecallEvalRuntimeGateEligible(
      manifest, snapshotAttribution.gate_eligible
    ),
    node_version: process.version,
    platform: platform(),
    arch: arch(),
    ...identity,
    ...(evaluatorBinding.datasetSha256 === undefined || evaluatorBinding.datasetSha256 === null
      ? {}
      : { hydration_binding: {
          dataset_sha256: evaluatorBinding.datasetSha256,
          source: "external_expected_sha256" as const
        } }),
    snapshot_binding: buildRecallEvalSnapshotBinding(
      manifest,
      evaluatorBinding.snapshotManifestSha256 ?? null
    )
  };
}

async function resolveRecallEvalRuntimeIdentity(
  env: Readonly<Record<string, string | undefined>>,
  recallOptions: EffectiveRecallOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): Promise<RecallEvalRuntimeIdentity> {
  const embeddingMode = recallEvalEmbeddingMode(env);
  const providerKind = recallEvalEmbeddingProviderKind(env);
  const label = recallEvalEmbeddingProviderLabel(env);
  const [embeddingSupplement, answerRerank] = await Promise.all([
    resolveEmbeddingSupplementRuntimeProvenance(embeddingMode, providerKind, env, label),
    resolveLocalCrossEncoderRuntimeProvenance(env)
  ]);
  const onnxSha = embeddingSupplement.enabled &&
    embeddingSupplement.provider_kind === "local_onnx"
    ? embeddingSupplement.model_artifact_sha256
    : null;
  return {
    embedding_mode: embeddingMode,
    embedding_provider_kind: providerKind,
    embedding_provider_label: label,
    onnx_threads: readOptionalOnnxThreadCount(env.ALAYA_LOCAL_ONNX_THREADS),
    onnx_model_artifact_sha256: onnxSha,
    embedding_supplement: embeddingSupplement,
    answer_rerank: answerRerank,
    recall_config: buildEffectiveRecallConfigIdentity(
      env,
      recallOptions,
      recallWeightOverrides
    )
  };
}

function isRecallEvalRuntimeGateEligible(
  manifest: LongMemEvalSnapshotManifest,
  snapshotGateEligible: boolean
): boolean {
  return manifest.attribution?.status === "attributed" && snapshotGateEligible;
}

function buildRecallEvalSnapshotBinding(
  manifest: LongMemEvalSnapshotManifest,
  snapshotManifestSha256: string | null
): RecallEvalRuntimeAttribution["snapshot_binding"] {
  const provenance = manifest.run_provenance;
  const cache = provenance?.extraction_cache;
  return {
    commit_sha7: provenance?.code.commit_sha7 ?? null,
    gate_sha256: provenance?.code.gate_sha256 ?? null,
    worktree_state_sha256: provenance?.code.worktree_state_sha256 ?? null,
    extraction_cache_manifest_sha256: cache?.manifest_sha256 ?? null,
    extraction_cache_requested_turns: cache?.requested_turns ?? null,
    extraction_cache_cached_turns: cache?.cached_turns ?? null,
    extraction_cache_coverage: cache?.coverage ?? null,
    dataset_sha256: manifest.dataset_sha256 ?? null,
    question_id_digest: manifest.question_id_digest ?? null,
    snapshot_manifest_sha256: snapshotManifestSha256,
    producer_recall_pipeline_version: manifest.recall_pipeline_version,
    consumer_recall_pipeline_version: RECALL_PIPELINE_VERSION,
    producer_schema_migration_version: manifest.schema_migration_version
  };
}

export async function prepareRecallEvalDataDir(input: {
  readonly snapshotDbPath: string;
  readonly requestedRoot?: string;
  readonly artifactIntegrity?: SnapshotArtifactIntegrity;
  readonly validateRestoredDb?: (dbPath: string) => void;
  readonly restoreSnapshot?: (dataDirRoot: string) => void;
  readonly plannedRoot?: OwnedTempRoot;
}): Promise<OwnedTempRoot> {
  const root = input.plannedRoot ?? (input.requestedRoot === undefined
    ? await createOwnedTempRoot("alaya-recall-eval-")
    : externalTempRoot(input.requestedRoot));
  try {
    if (root.owned) await mkdir(root.path, { recursive: true });
    if (input.artifactIntegrity !== undefined) {
      await verifySnapshotArtifactIntegrity(input.snapshotDbPath, input.artifactIntegrity);
    }
    if (input.restoreSnapshot === undefined) {
      restoreSnapshotToDataDir({
        snapshotDbPath: input.snapshotDbPath,
        dataDirRoot: root.path
      });
    } else {
      input.restoreSnapshot(root.path);
    }
    input.validateRestoredDb?.(`${root.path}/alaya.db`);
    return root;
  } catch (error) {
    let cleanupError: unknown;
    try {
      await finalizeOwnedTempRoot(root, false);
    } catch (caught) {
      cleanupError = caught;
    }
    throwLifecycleErrors("recall-eval preparation failed", [error, cleanupError]);
    throw error;
  }
}

export async function prepareRecallEvalDataRoot(
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle,
  plannedRoot?: OwnedTempRoot
): Promise<OwnedTempRoot> {
  const { manifest } = bundle;
  return await prepareRecallEvalDataDir({
    snapshotDbPath: options.snapshotDbPath,
    requestedRoot: options.dataDirRoot,
    plannedRoot,
    ...(options.legacySnapshot === true
      ? { restoreSnapshot: (dataDirRoot: string) => restoreLegacySnapshotToDataDir({
          snapshotDbPath: options.snapshotDbPath,
          dataDirRoot,
          manifest
        }) }
      : { artifactIntegrity: manifest.artifact_integrity }),
    validateRestoredDb: (dbPath) => prepareRecallEvalRestoredDb({
      manifest,
      restoredDbPath: dbPath,
      legacySnapshot: options.legacySnapshot === true
    })
  });
}

export function planRecallEvalDataRoot(options: RecallEvalOptions): OwnedTempRoot {
  if (options.dataDirRoot !== undefined) return externalTempRoot(options.dataDirRoot);
  return Object.freeze({
    path: join(tmpdir(), `alaya-recall-eval-${randomUUID()}`),
    owned: true
  });
}
