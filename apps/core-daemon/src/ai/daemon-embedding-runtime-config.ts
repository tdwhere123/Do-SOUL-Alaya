import type { ResolveSecretError } from "../secrets/index.js";
import { resolveSecretRef } from "../secrets/index.js";
import {
  readConfigEnvValue,
  readNonEmptyEnv
} from "../runtime/index.js";

export type EmbeddingProviderKind = "openai" | "local_onnx";

export interface EmbeddingRuntimeConfig {
  readonly embeddingApiKey: string | null;
  readonly configuredEmbeddingModel: string | null;
  readonly configuredEmbeddingProviderUrl: string | null;
  readonly embeddingProviderKind: EmbeddingProviderKind;
  readonly localEmbeddingCacheDir: string | null;
  readonly localEmbeddingModel: string | null;
  readonly localAnswerRerankEnabled: boolean;
  readonly localAnswerRerankCacheDir: string | null;
  readonly localAnswerRerankModel: string | null;
  readonly embeddingSupplementEnabled: boolean;
  readonly recallPolicyEmbeddingEnabled: boolean;
  readonly d2qEnabled: boolean;
}

export function readEmbeddingRuntimeConfig(
  configEnv: ReadonlyMap<string, string>,
  warn: (message: string, meta: Record<string, unknown>) => void
): EmbeddingRuntimeConfig {
  const providerKind = resolveEmbeddingProviderKind(readExplicitEmbeddingProvider(configEnv));
  const embeddingEnabled = readEmbeddingSupplementEnabled(configEnv, providerKind);
  const secretRef = readConfigEnvValue(configEnv, "ALAYA_OPENAI_SECRET_REF");
  return {
    embeddingApiKey: providerKind === "openai"
      ? resolveOptionalEmbeddingApiKey(secretRef, warn)
      : null,
    configuredEmbeddingModel: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "OPENAI_EMBEDDING_MODEL")
    ),
    configuredEmbeddingProviderUrl: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "OPENAI_EMBEDDING_PROVIDER_URL")
    ),
    embeddingProviderKind: providerKind,
    localEmbeddingCacheDir: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR")
    ),
    localEmbeddingModel: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "ALAYA_LOCAL_EMBEDDING_MODEL")
    ),
    localAnswerRerankEnabled: readStrictBooleanConfig(
      configEnv,
      "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
    ),
    localAnswerRerankCacheDir: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR")
    ),
    localAnswerRerankModel: readNonEmptyEnv(
      readConfigEnvValue(configEnv, "ALAYA_LOCAL_CROSS_ENCODER_MODEL")
    ),
    embeddingSupplementEnabled: embeddingEnabled,
    recallPolicyEmbeddingEnabled: embeddingEnabled,
    d2qEnabled: readStrictBooleanConfig(configEnv, "ALAYA_RECALL_D2Q")
  };
}

export function isD2qActive(config: EmbeddingRuntimeConfig): boolean {
  return config.d2qEnabled && config.embeddingProviderKind === "local_onnx";
}

function readEmbeddingSupplementEnabled(
  configEnv: ReadonlyMap<string, string>,
  providerKind: EmbeddingProviderKind
): boolean {
  const raw = readNonEmptyEnv(
    readConfigEnvValue(configEnv, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT")
  );
  if (raw === null) return providerKind === "local_onnx";
  return parseBooleanValue(raw, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT");
}

function readStrictBooleanConfig(
  configEnv: ReadonlyMap<string, string>,
  name: string
): boolean {
  const raw = readNonEmptyEnv(readConfigEnvValue(configEnv, name));
  return raw === null ? false : parseBooleanValue(raw, name);
}

function parseBooleanValue(raw: string, name: string): boolean {
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0 when set.`);
}

function readExplicitEmbeddingProvider(
  configEnv: ReadonlyMap<string, string>
): EmbeddingProviderKind | null {
  const raw = readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_EMBEDDING_PROVIDER"));
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (normalized === "openai" || normalized === "local_onnx") return normalized;
  throw new Error("ALAYA_EMBEDDING_PROVIDER must be openai or local_onnx when set.");
}

function resolveEmbeddingProviderKind(
  explicitProvider: EmbeddingProviderKind | null
): EmbeddingProviderKind {
  return explicitProvider ?? "local_onnx";
}

function resolveOptionalEmbeddingApiKey(
  rawSecretRef: string | undefined,
  warn: (message: string, meta: Record<string, unknown>) => void
): string | null {
  if (rawSecretRef === undefined || rawSecretRef.trim().length === 0) return null;
  const resolved = resolveSecretRef(rawSecretRef);
  if (!("kind" in resolved)) return resolved.value;
  if (resolved.kind === "malformed" || resolved.kind === "empty") {
    throw new Error(formatEmbeddingSecretResolutionError(resolved));
  }
  warn("embedding provider unavailable; falling back to keyword recall", {
    reason: resolved.kind,
    secret_ref_source: describeSecretRefSource(resolved)
  });
  return null;
}

function describeSecretRefSource(error: ResolveSecretError): string {
  switch (error.kind) {
    case "env_missing":
      return `env:${error.var_name}`;
    case "file_missing":
    case "file_unreadable":
      return "file";
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `keychain:${error.service}:${error.account}`;
    case "malformed":
    case "empty":
      return "invalid";
  }
}

function formatEmbeddingSecretResolutionError(error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `ALAYA_OPENAI_SECRET_REF: ${error.ref} -> ${error.reason}`;
    case "empty":
      return `ALAYA_OPENAI_SECRET_REF: ${error.ref} -> ${error.origin} secret is empty`;
    default:
      return "ALAYA_OPENAI_SECRET_REF is unavailable";
  }
}
