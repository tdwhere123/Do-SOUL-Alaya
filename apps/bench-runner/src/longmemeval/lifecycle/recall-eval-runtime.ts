import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "../../harness/daemon.js";
import { arch, platform } from "node:os";
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
import { resolveLocalOnnxArtifactSha256 } from "../provenance/local-onnx.js";
import { resolveBenchCommitSha7 } from "../../shared/version.js";
import {
  deriveSnapshotAttribution,
  type LongMemEvalSnapshotManifest
} from "../snapshot.js";

export function recallEvalEmbeddingMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): BenchEmbeddingMode {
  return env.ALAYA_RECALL_EVAL_EMBEDDING === "env" ? "env" : "disabled";
}

export function recallEvalEmbeddingProviderKind(
  env: Readonly<Record<string, string | undefined>> = process.env
): BenchEmbeddingProviderKind {
  return recallEvalEmbeddingMode(env) === "env" ? "local_onnx" : "openai";
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
  }>;
}

export async function buildRecallEvalRuntimeAttribution(
  manifest: LongMemEvalSnapshotManifest,
  env: Readonly<Record<string, string | undefined>> = process.env,
  currentCommitSha7 = resolveBenchCommitSha7(env)
): Promise<RecallEvalRuntimeAttribution> {
  const label = recallEvalEmbeddingProviderLabel(env);
  const onnxSha = await resolveLocalOnnxArtifactSha256(label, env);
  const embeddingMode = recallEvalEmbeddingMode(env);
  const providerKind = recallEvalEmbeddingProviderKind(env);
  const onnxThreads = readOnnxThreads(env.ALAYA_LOCAL_ONNX_THREADS);
  const archivedRuntime = manifest.run_provenance?.runtime;
  const snapshotAttribution = deriveSnapshotAttribution({
    artifactIntegrity: manifest.artifact_integrity,
    runProvenance: manifest.run_provenance,
    questionIdDigest: manifest.question_id_digest,
    datasetSha256: manifest.dataset_sha256,
    extractionProvenance: manifest.extraction_provenance
  });
  const gateEligible = Boolean(
    snapshotAttribution.gate_eligible &&
    archivedRuntime !== undefined &&
    hasCurrentSnapshotCodeBinding(manifest, env, currentCommitSha7) &&
    archivedRuntime.node_version === process.version &&
    archivedRuntime.platform === platform() &&
    archivedRuntime.arch === arch() &&
    archivedRuntime.embedding_mode === embeddingMode &&
    archivedRuntime.embedding_provider_kind === providerKind &&
    archivedRuntime.embedding_provider_label === label &&
    archivedRuntime.onnx_threads === onnxThreads &&
    archivedRuntime.onnx_model_artifact_sha256 !== undefined &&
    archivedRuntime.onnx_model_artifact_sha256 === onnxSha
  );
  return {
    status: manifest.attribution?.status ?? "legacy_unattributed",
    gate_eligible: gateEligible,
    node_version: process.version,
    platform: platform(),
    arch: arch(),
    embedding_mode: embeddingMode,
    embedding_provider_kind: providerKind,
    embedding_provider_label: label,
    onnx_threads: onnxThreads,
    onnx_model_artifact_sha256: onnxSha ?? null,
    snapshot_binding: buildRecallEvalSnapshotBinding(manifest)
  };
}

function buildRecallEvalSnapshotBinding(
  manifest: LongMemEvalSnapshotManifest
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
    question_id_digest: manifest.question_id_digest ?? null
  };
}

function hasCurrentSnapshotCodeBinding(
  manifest: LongMemEvalSnapshotManifest,
  env: Readonly<Record<string, string | undefined>>,
  currentCommitSha7: string
): boolean {
  const code = manifest.run_provenance?.code;
  return Boolean(
    code !== undefined &&
    code.commit_sha7 === currentCommitSha7 &&
    code.gate_sha256 !== null &&
    code.gate_sha256 === readSha(env.ALAYA_BENCH_GATE_SHA256) &&
    code.worktree_state_sha256 !== null &&
    code.worktree_state_sha256 === readSha(env.ALAYA_BENCH_WORKTREE_STATE_SHA256)
  );
}

function readSha(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function readOnnxThreads(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function prepareRecallEvalDataDir(input: {
  readonly snapshotDbPath: string;
  readonly requestedRoot?: string;
  readonly artifactIntegrity?: SnapshotArtifactIntegrity;
  readonly validateRestoredDb?: (dbPath: string) => void;
}): Promise<OwnedTempRoot> {
  const root = input.requestedRoot === undefined
    ? await createOwnedTempRoot("alaya-recall-eval-")
    : externalTempRoot(input.requestedRoot);
  try {
    if (input.artifactIntegrity !== undefined) {
      await verifySnapshotArtifactIntegrity(input.snapshotDbPath, input.artifactIntegrity);
    }
    restoreSnapshotToDataDir({
      snapshotDbPath: input.snapshotDbPath,
      dataDirRoot: root.path
    });
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
