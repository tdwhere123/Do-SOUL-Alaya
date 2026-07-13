import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import { resolveBenchEmbeddingSchemaVersion } from "../../harness/daemon-handle-ops-support.js";
import { readOptionalTreatmentBoolean } from "../../harness/strict-treatment-config.js";

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

async function collectArtifactFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8"))
  );
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("local ONNX artifact tree must not contain symbolic links");
    }
    if (entry.isDirectory()) files.push(...await collectArtifactFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export type LocalCrossEncoderRuntimeProvenance =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      provider_kind: "local_onnx_cross_encoder";
      effective_model_id: string;
      model_artifact_sha256: string;
    }>;

export async function resolveLocalCrossEncoderRuntimeProvenance(
  env: Readonly<Record<string, string | undefined>>
): Promise<LocalCrossEncoderRuntimeProvenance> {
  const enabled = readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  ) === true;
  if (!enabled) return { enabled: false };
  const cacheRoot = requireCrossEncoderEnv(env, "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR");
  const modelId = requireCrossEncoderEnv(env, "ALAYA_LOCAL_CROSS_ENCODER_MODEL");
  return {
    enabled: true,
    provider_kind: "local_onnx_cross_encoder",
    effective_model_id: modelId,
    model_artifact_sha256: await resolveLocalArtifactTreeSha256(cacheRoot, modelId)
  };
}

export async function resolveLocalArtifactTreeSha256(
  cacheRoot: string,
  modelId: string
): Promise<string> {
  const suffix = modelId.trim();
  if (
    suffix.length === 0 ||
    isAbsolute(suffix) ||
    suffix.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new Error("local ONNX model id must stay within the cache root");
  const modelRoot = resolve(cacheRoot, suffix);
  let files: readonly string[];
  try {
    const [cacheReal, modelReal, modelMetadata] = await Promise.all([
      realpath(cacheRoot),
      realpath(modelRoot),
      lstat(modelRoot)
    ]);
    const fromCache = relative(cacheReal, modelReal);
    if (modelMetadata.isSymbolicLink() || fromCache.startsWith("..") || isAbsolute(fromCache)) {
      throw new Error("local ONNX artifact root escapes the cache root");
    }
    files = await collectArtifactFiles(modelRoot);
  } catch {
    throw new Error("local ONNX artifact tree is missing or unreadable");
  }
  if (files.length === 0) {
    throw new Error("local ONNX artifact tree is missing or unreadable");
  }
  const hash = createHash("sha256");
  hash.update("alaya-local-onnx-tree-v1\0", "utf8");
  for (const file of files) {
    const relativePath = Buffer.from(relative(modelRoot, file), "utf8");
    const metadata = await stat(file);
    updateFrame(hash, relativePath);
    updateUint64(hash, metadata.size);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  return hash.digest("hex");
}

function requireCrossEncoderEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR" | "ALAYA_LOCAL_CROSS_ENCODER_MODEL"
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when local cross-encoder reranking is enabled`);
  return value;
}

function updateFrame(hash: ReturnType<typeof createHash>, value: Buffer): void {
  updateUint64(hash, value.byteLength);
  hash.update(value);
}

function updateUint64(hash: ReturnType<typeof createHash>, value: number): void {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  hash.update(frame);
}
