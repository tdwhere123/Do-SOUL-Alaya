import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_ONNX_MODEL_ID, resolveLocalArtifactTreeSha256 } from "@do-soul/alaya-core";
// Compatibility for recall-eval/provenance tests; remove once their imports migrate to Core.
export { resolveLocalArtifactTreeSha256 } from "@do-soul/alaya-core";
import { resolveBenchEmbeddingSchemaVersion } from "../../../harness/daemon/handle/daemon-handle-ops-support.js";
import { warnRetiredLocalCrossEncoderTreatment } from
  "../../../harness/daemon/daemon-environment.js";

const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export type EmbeddingSupplementRuntimeProvenance =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      provider_kind: "local_onnx";
      effective_model_id: string;
      model_artifact_sha256: string;
      effective_schema_version: number;
      d2q_input: "raw_content" | "content_plus_hq";
    }>
  | Readonly<{
      enabled: true;
      provider_kind: "openai";
      effective_model_id: string;
      effective_schema_version: 1;
      d2q_input: "raw_content";
    }>;

export async function resolveEmbeddingSupplementRuntimeProvenance(
  embeddingMode: "disabled" | "env",
  providerKind: "openai" | "local_onnx",
  env: Readonly<Record<string, string | undefined>>,
  providerLabel?: string
): Promise<EmbeddingSupplementRuntimeProvenance> {
  if (embeddingMode === "disabled") return { enabled: false };
  if (providerKind === "openai") {
    return {
      enabled: true,
      provider_kind: "openai",
      effective_model_id:
        env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL,
      effective_schema_version: 1,
      d2q_input: "raw_content"
    };
  }
  const modelId =
    env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() ||
    localModelFromLabel(providerLabel) ||
    DEFAULT_LOCAL_ONNX_MODEL_ID;
  const cacheRoot = env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR?.trim() ||
    defaultLocalOnnxCacheDir(env);
  const schemaVersion = resolveBenchEmbeddingSchemaVersion("local_onnx", env);
  return {
    enabled: true,
    provider_kind: "local_onnx",
    effective_model_id: modelId,
    model_artifact_sha256: await resolveLocalArtifactTreeSha256(cacheRoot, modelId),
    effective_schema_version: schemaVersion,
    d2q_input: schemaVersion === 2 ? "content_plus_hq" : "raw_content"
  };
}

function localModelFromLabel(providerLabel: string | undefined): string | null {
  const prefix = "local_onnx:";
  return providerLabel?.startsWith(prefix) === true
    ? providerLabel.slice(prefix.length).trim() || null
    : null;
}

function defaultLocalOnnxCacheDir(
  env: Readonly<Record<string, string | undefined>>
): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "do-soul-alaya/models");
}

export type LocalCrossEncoderRuntimeProvenance = Readonly<{ enabled: false }>;

export async function resolveLocalCrossEncoderRuntimeProvenance(
  env: Readonly<Record<string, string | undefined>>
): Promise<LocalCrossEncoderRuntimeProvenance> {
  warnRetiredLocalCrossEncoderTreatment(env);
  return { enabled: false };
}
