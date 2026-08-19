import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../../../harness/daemon.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createOwnedTempRoot,
  externalTempRoot,
  finalizeOwnedTempRoot,
  type OwnedTempRoot
} from "../owned-temp-root.js";
import { throwLifecycleErrors } from "../errors.js";
import { restoreSnapshotToDataDir } from "../../snapshot/materialize.js";
import {
  verifySnapshotArtifactIntegrity,
  type SnapshotArtifactIntegrity
} from "../../snapshot/integrity.js";
import { resolveBenchEmbeddingProviderLabel } from "../../../longmemeval/runner/runner-helpers.js";
import {
  resolveEmbeddingSupplementRuntimeProvenance,
  resolveLocalCrossEncoderRuntimeProvenance,
  type EmbeddingSupplementRuntimeProvenance,
  type LocalCrossEncoderRuntimeProvenance
} from "../../provenance/embedding/local-onnx.js";
import {
  RECALL_PIPELINE_VERSION
} from "../../../shared/version.js";
import {
  deriveSnapshotAttribution,
  type LongMemEvalSnapshotManifest
} from "../../snapshot/materialize.js";
import { prepareRecallEvalRestoredDb } from "../../snapshot/recall-eval/recall-eval-db.js";
import type { RecallEvalSnapshotBundle } from "../../snapshot/recall-eval/recall-eval-loader.js";
import type { RecallEvalOptions } from "./recall-eval-contract.js";
import { readOptionalOnnxThreadCount } from "../../../harness/strict-treatment-config.js";
import {
  buildEffectiveRecallConfigIdentity,
  readRecallEvalMaxResults,
  type EffectiveRecallConfigIdentity,
  type EffectiveRecallOptions
} from "../../provenance/effective-recall-config.js";
import type { BenchRecallWeightOverrides } from "../../../harness/recall/recall-weight-overrides.js";
import {
  rebuildEvidenceSearchProjectionsOnWorkingCopy,
  type EvidenceSearchProjectionRebuildReport
} from "../../snapshot/recall-eval/evidence-search-projection-rebuild.js";
import {
  buildWarmDerivedSnapshotBinding,
  readWarmDerivedSnapshotReceipt,
  type WarmDerivedSnapshotBinding,
  type WarmDerivedSnapshotReceipt
} from "../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import { applyEmbeddingCacheOverlay } from
  "../../snapshot/recall-eval/embedding-cache-overlay/importer.js";
import type {
  EmbeddingCacheOverlayBinding,
  EmbeddingCacheOverlayExpectedSourceBinding
} from "../../snapshot/recall-eval/embedding-cache-overlay/contract.js";

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
  readonly query_semantic_factor_cache?: Readonly<{
    schema_version: 1 | 2;
    cache_content_sha256: string;
    compiler_operator_id: string;
    system_prompt_sha256: string;
    request_template_sha256: string;
    model_id: string;
    provider_url_sha256: string;
    source_set_sha256: string;
    entry_count: number;
    transport_routes?: readonly Readonly<{
      provider_url_sha256: string;
      model: string;
    }>[];
  }>;
  readonly embedding_cache_overlay?: EmbeddingCacheOverlayBinding;
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
    nonPromotableDerivedRebuild?: boolean;
    querySemanticFactorCache?: RecallEvalRuntimeAttribution["query_semantic_factor_cache"];
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
    seedExtractionPath: manifest.seed_extraction_path,
    extractionProvenance: manifest.extraction_provenance
  });
  return {
    status: manifest.attribution?.status === "attributed"
      ? "attributed"
      : "legacy_unattributed",
    gate_eligible: evaluatorBinding.nonPromotableDerivedRebuild === true
      ? false
      : isRecallEvalRuntimeGateEligible(manifest, snapshotAttribution.gate_eligible),
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
    ...(evaluatorBinding.querySemanticFactorCache === undefined
      ? {}
      : { query_semantic_factor_cache: evaluatorBinding.querySemanticFactorCache }),
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
  readonly validateRestoredDb?: (dbPath: string) => void | Promise<void>;
  readonly restoreSnapshot?: (dataDirRoot: string) => void;
  readonly plannedRoot?: OwnedTempRoot;
}): Promise<OwnedTempRoot> {
  const root = input.plannedRoot ?? (input.requestedRoot === undefined
    ? await createOwnedTempRoot("alaya-recall-eval-")
    : externalTempRoot(input.requestedRoot));
  try {
    await assertDistinctSnapshotRestorePaths(input.snapshotDbPath, root.path);
    if (root.owned) await mkdir(root.path, { recursive: true });
    if (input.artifactIntegrity !== undefined) {
      await verifySnapshotArtifactIntegrity(input.snapshotDbPath, input.artifactIntegrity);
    }
    if (input.restoreSnapshot === undefined) {
      restoreSnapshotToDataDir({
        snapshotDbPath: input.snapshotDbPath,
        dataDirRoot: root.path,
        ...(input.artifactIntegrity === undefined
          ? {}
          : { expectedSha256: input.artifactIntegrity.db_sha256 })
      });
    } else {
      input.restoreSnapshot(root.path);
    }
    await input.validateRestoredDb?.(`${root.path}/alaya.db`);
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

export async function assertDistinctSnapshotRestorePaths(
  snapshotDbPath: string,
  dataDirRoot: string
): Promise<void> {
  const [source, targetRoot] = await Promise.all([
    resolvePhysicalPath(snapshotDbPath),
    resolvePhysicalPath(dataDirRoot)
  ]);
  if (source !== join(targetRoot, "alaya.db")) return;
  throw new Error(
    "recall-eval source snapshot must differ from the restored data root alaya.db"
  );
}

async function resolvePhysicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(filePath);
    if (parent === filePath) return resolve(filePath);
    return join(await resolvePhysicalPath(parent), basename(filePath));
  }
}

export async function prepareRecallEvalDataRoot(
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle,
  plannedRoot?: OwnedTempRoot,
  embeddingCacheOverlayExpected?: EmbeddingCacheOverlayExpectedSourceBinding
): Promise<OwnedTempRoot & Readonly<{
  evidenceProjectionRebuild: EvidenceSearchProjectionRebuildReport | null;
  warmDerivedSnapshot: WarmDerivedSnapshotBinding | null;
  embeddingCacheOverlay: EmbeddingCacheOverlayBinding | null;
}>> {
  const { manifest } = bundle;
  const warmDerivedSnapshot = readWarmDerivedSnapshot(options, manifest);
  let evidenceProjectionRebuild: EvidenceSearchProjectionRebuildReport | null = null;
  let embeddingCacheOverlay: EmbeddingCacheOverlayBinding | null = null;
  const root = await prepareRecallEvalDataDir({
    ...buildRecallEvalRestoreInput(options, bundle, warmDerivedSnapshot),
    requestedRoot: options.dataDirRoot,
    plannedRoot,
    validateRestoredDb: async (dbPath) => {
      evidenceProjectionRebuild = await prepareRecallEvalWorkingDb(
        dbPath, options, bundle, warmDerivedSnapshot
      );
      if (options.embeddingCacheOverlayReceiptPath !== undefined) {
        if (embeddingCacheOverlayExpected === undefined) {
          throw new Error("embedding cache overlay runtime binding is missing");
        }
        embeddingCacheOverlay = await applyEmbeddingCacheOverlay({
          receiptPath: options.embeddingCacheOverlayReceiptPath,
          restoredDbPath: dbPath,
          expected: embeddingCacheOverlayExpected
        });
      }
    }
  });
  return Object.freeze({
    ...root,
    evidenceProjectionRebuild,
    warmDerivedSnapshot: warmDerivedSnapshot === null
      ? null
      : buildWarmDerivedSnapshotBinding(warmDerivedSnapshot),
    embeddingCacheOverlay
  });
}

function readWarmDerivedSnapshot(
  options: RecallEvalOptions,
  manifest: LongMemEvalSnapshotManifest
): WarmDerivedSnapshotReceipt | null {
  if (options.warmDerivedSnapshotReceiptPath === undefined) return null;
  const sourceSnapshotDbSha256 = manifest.artifact_integrity?.db_sha256;
  if (sourceSnapshotDbSha256 === undefined) {
    throw new Error("warm derived snapshot requires source DB artifact integrity");
  }
  return readWarmDerivedSnapshotReceipt({
    receiptPath: options.warmDerivedSnapshotReceiptPath,
    sourceSnapshotDbSha256,
    sourceSchemaVersion: manifest.schema_migration_version
  });
}

function buildRecallEvalRestoreInput(
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle,
  warm: WarmDerivedSnapshotReceipt | null
): Pick<Parameters<typeof prepareRecallEvalDataDir>[0],
  "snapshotDbPath" | "artifactIntegrity" | "restoreSnapshot"> {
  if (warm !== null) return {
    snapshotDbPath: warm.databasePath,
    restoreSnapshot: (dataDirRoot) => restoreSnapshotToDataDir({
      snapshotDbPath: warm.databasePath,
      dataDirRoot,
      expectedSha256: warm.databaseSha256
    })
  };
  if (options.legacySnapshot === true) {
    throw new Error("legacy snapshots are not supported");
  }
  return {
    snapshotDbPath: bundle.snapshotDbPath,
    artifactIntegrity: bundle.manifest.artifact_integrity
  };
}

async function prepareRecallEvalWorkingDb(
  dbPath: string,
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle,
  warm: WarmDerivedSnapshotReceipt | null
): Promise<EvidenceSearchProjectionRebuildReport | null> {
  prepareRecallEvalRestoredDb({
    manifest: bundle.manifest,
    restoredDbPath: dbPath,
    legacySnapshot: options.legacySnapshot === true,
    derivedEvidenceProjectionRebuild: options.derivedEvidenceProjectionRebuild === true,
    ...(warm === null ? {} : { warmDerivedSnapshot: warm })
  });
  if (options.derivedEvidenceProjectionRebuild !== true) {
    return warm?.rebuildReport ?? null;
  }
  return rebuildEvidenceSearchProjectionsOnWorkingCopy({
    workingDbPath: dbPath,
    ...(options.backfillMissingFactFrameFormations === true
      ? { backfillMissingFactFrameFormations: true }
      : {}),
    ...(options.factFrameRetrofitLedgerPath === undefined
      ? {}
      : { factFrameRetrofitLedgerPath: options.factFrameRetrofitLedgerPath }),
    ...(bundle.sourceExtractionSystemPromptSha256 === undefined
      ? {}
      : { sourceExtractionSystemPromptSha256: bundle.sourceExtractionSystemPromptSha256 })
  });
}

export function planRecallEvalDataRoot(options: RecallEvalOptions): OwnedTempRoot {
  if (options.dataDirRoot !== undefined) return externalTempRoot(options.dataDirRoot);
  return Object.freeze({
    path: join(tmpdir(), `alaya-recall-eval-${randomUUID()}`),
    owned: true
  });
}
