import { rmSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import {
  LocalOnnxEmbeddingClient,
  type EmbeddingProviderPort
} from "@do-soul/alaya-core";
import {
  StorageDatabase,
  readSchemaMigrationLedger
} from "@do-soul/alaya-storage";
import { sha256File } from "../../integrity.js";
import { snapshotManifestPath } from "../../materialize.js";
import { readRegularFileNoFollow, sha256Buffer } from "../../bound-file.js";
import { MAX_SNAPSHOT_MANIFEST_BYTES } from "../../artifact-limits.js";
import type {
  EmbeddingCacheOverlayBinding,
  EmbeddingCacheOverlaySourceBinding
} from "./contract.js";
import {
  reserveStagingFile,
  resolveOverlayOutputPaths
} from "./overlay-schema.js";
import { populateOverlayFromSnapshot } from "./sidecar-store.js";
import { sealEmbeddingCacheOverlay } from "./writer.js";

export async function emitEmbeddingCacheOverlay(input: {
  readonly snapshotDbPath: string;
  readonly receiptPath: string;
  readonly provider: EmbeddingProviderPort;
  readonly source: EmbeddingCacheOverlaySourceBinding;
  readonly now?: () => string;
}): Promise<EmbeddingCacheOverlayBinding> {
  assertEmitSource(input);
  if (input.source.vector_space.d2q_input !== "raw_content") {
    throw new Error("embedding cache overlay emit requires raw_content d2q input");
  }
  const paths = resolveOverlayOutputPaths(input.receiptPath);
  reserveStagingFile(paths.stagingPath);
  const snapshot = openReadonlySnapshot(input.snapshotDbPath);
  try {
    const counts = await populateOverlayFromSnapshot({
      snapshot,
      overlayPath: paths.stagingPath,
      provider: input.provider,
      source: input.source,
      ...(input.now === undefined ? {} : { now: input.now })
    });
    return await sealEmbeddingCacheOverlay({
      stagingPath: paths.stagingPath,
      receiptPath: paths.receiptPath,
      overlayPath: paths.overlayPath,
      source: input.source,
      memoryEmbeddingCount: counts.memory,
      evidenceEmbeddingCount: counts.evidence
    });
  } catch (error) {
    rmSync(paths.stagingPath, { force: true });
    rmSync(`${paths.stagingPath}-wal`, { force: true });
    rmSync(`${paths.stagingPath}-shm`, { force: true });
    throw error;
  } finally {
    snapshot.close();
  }
}

export async function bindOverlaySourceFromSnapshot(input: {
  readonly snapshotDbPath: string;
  readonly provider: Pick<
    EmbeddingProviderPort,
    "providerKind" | "modelId" | "schemaVersion"
  >;
  readonly dimensions: number;
  readonly modelArtifactSha256: string | null;
}): Promise<EmbeddingCacheOverlaySourceBinding> {
  const manifestBytes = readRegularFileNoFollow(
    snapshotManifestPath(input.snapshotDbPath),
    MAX_SNAPSHOT_MANIFEST_BYTES
  );
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as {
    readonly schema_migration_version?: number;
    readonly recall_pipeline_version?: string;
    readonly artifact_integrity?: { readonly db_sha256?: string };
  };
  const dbSha256 = manifest.artifact_integrity?.db_sha256;
  const schemaVersion = manifest.schema_migration_version;
  const pipelineVersion = manifest.recall_pipeline_version;
  if (dbSha256 === undefined || schemaVersion === undefined || pipelineVersion === undefined) {
    throw new Error("embedding cache overlay emit requires current snapshot artifact integrity");
  }
  if (await sha256File(input.snapshotDbPath) !== dbSha256) {
    throw new Error("embedding cache overlay emit snapshot DB SHA-256 mismatch");
  }
  if (readSchemaMigrationLedger(input.snapshotDbPath).at(-1) !== schemaVersion) {
    throw new Error("embedding cache overlay emit snapshot schema binding mismatch");
  }
  return Object.freeze({
    source_snapshot_db_sha256: dbSha256,
    source_snapshot_manifest_sha256: sha256Buffer(manifestBytes),
    source_schema_version: schemaVersion,
    recall_pipeline_version: pipelineVersion,
    vector_space: Object.freeze({
      provider_kind: input.provider.providerKind,
      model_id: input.provider.modelId,
      schema_version: input.provider.schemaVersion,
      dimensions: input.dimensions,
      d2q_input: "raw_content" as const,
      model_artifact_sha256: input.modelArtifactSha256
    })
  });
}

export function createProductOverlayEmbeddingProvider(
  env: Readonly<Record<string, string | undefined>> = process.env
): LocalOnnxEmbeddingClient {
  const cacheDir = env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR?.trim() || null;
  const modelId = env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim();
  return new LocalOnnxEmbeddingClient({
    cacheDir,
    ...(modelId === undefined || modelId.length === 0 ? {} : { modelId })
  });
}

function assertEmitSource(input: {
  readonly snapshotDbPath: string;
  readonly source: EmbeddingCacheOverlaySourceBinding;
}): void {
  const actual = readSchemaMigrationLedger(input.snapshotDbPath).at(-1);
  if (actual !== input.source.source_schema_version) {
    throw new Error("embedding cache overlay emit snapshot schema binding mismatch");
  }
}

function openReadonlySnapshot(path: string): StorageDatabase {
  const connection = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true
  });
  connection.pragma("query_only = ON");
  return new StorageDatabase(path, connection);
}
