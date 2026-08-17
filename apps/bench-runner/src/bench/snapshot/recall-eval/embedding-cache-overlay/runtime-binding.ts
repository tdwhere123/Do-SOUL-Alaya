import { LOCAL_ONNX_EMBEDDING_DIMENSIONS } from "@do-soul/alaya-core";
import type { EmbeddingSupplementRuntimeProvenance } from
  "../../../provenance/embedding/local-onnx.js";
import type { LongMemEvalSnapshotManifest } from "../../materialize.js";
import type { EmbeddingCacheOverlayExpectedSourceBinding } from "./contract.js";

export function buildExpectedEmbeddingCacheOverlayBinding(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly snapshotManifestSha256: string | null;
  readonly embeddingSupplement: EmbeddingSupplementRuntimeProvenance;
}): EmbeddingCacheOverlayExpectedSourceBinding {
  const snapshotDbSha256 = input.manifest.artifact_integrity?.db_sha256;
  if (snapshotDbSha256 === undefined || input.snapshotManifestSha256 === null) {
    throw new Error("embedding cache overlay requires current snapshot artifact integrity");
  }
  const supplement = input.embeddingSupplement;
  if (!supplement.enabled) {
    throw new Error("embedding cache overlay requires embedding supplement mode");
  }
  return Object.freeze({
    source_snapshot_db_sha256: snapshotDbSha256,
    source_snapshot_manifest_sha256: input.snapshotManifestSha256,
    source_schema_version: input.manifest.schema_migration_version,
    recall_pipeline_version: input.manifest.recall_pipeline_version,
    vector_space: Object.freeze({
      provider_kind: supplement.provider_kind,
      model_id: supplement.effective_model_id,
      schema_version: supplement.effective_schema_version,
      ...(supplement.provider_kind === "local_onnx"
        ? {
            dimensions: LOCAL_ONNX_EMBEDDING_DIMENSIONS,
            model_artifact_sha256: supplement.model_artifact_sha256
          }
        : { model_artifact_sha256: null }),
      d2q_input: supplement.d2q_input
    })
  });
}
