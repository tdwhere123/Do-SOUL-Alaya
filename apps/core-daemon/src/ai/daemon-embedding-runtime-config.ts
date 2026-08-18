import { parseEnvBoolean } from "@do-soul/alaya-core";
import type { EmbeddingProviderKind } from "@do-soul/alaya-protocol";
import type { ResolveSecretError } from "../secrets/index.js";
import { resolveSecretRef } from "../secrets/index.js";
import { DAEMON_ONLY_CONFIG_ENV_KEYS } from "../runtime/config/daemon-config-environment.js";
import {
  readConfigEnvValue,
  readNonEmptyEnv
} from "../runtime/daemon/lifecycle/daemon-runtime-support.js";

export type { EmbeddingProviderKind };

export const LOCAL_CROSS_ENCODER_RERANK_REMOVED_ERROR =
  "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK is set, but local cross-encoder rerank was removed. Unset the flag; it no longer changes ranking.";

const EMBEDDING_KEYS = DAEMON_ONLY_CONFIG_ENV_KEYS.embedding;

export interface EffectiveEmbeddingPosture {
  readonly providerKind: EmbeddingProviderKind;
  readonly embeddingSupplementEnabled: boolean;
  readonly providerWasExplicit: boolean;
}

export interface EmbeddingRuntimeConfig {
  readonly embeddingApiKey: string | null;
  readonly configuredEmbeddingModel: string | null;
  readonly configuredEmbeddingProviderUrl: string | null;
  readonly embeddingProviderKind: EmbeddingProviderKind;
  readonly localEmbeddingCacheDir: string | null;
  readonly localEmbeddingModel: string | null;
  readonly embeddingSupplementEnabled: boolean;
  readonly recallPolicyEmbeddingEnabled: boolean;
  readonly d2qEnabled: boolean;
}

export function resolveEffectiveEmbeddingPosture(
  read: (key: string) => string | undefined
): EffectiveEmbeddingPosture {
  const explicit = readExplicitEmbeddingProviderKind(readNonEmptyEnv(read(EMBEDDING_KEYS.provider)));
  const providerKind = explicit ?? "local_onnx";
  const supplementRaw = readNonEmptyEnv(read(EMBEDDING_KEYS.supplement));
  return Object.freeze({
    providerKind,
    providerWasExplicit: explicit !== null,
    embeddingSupplementEnabled: supplementRaw === null
      ? providerKind === "local_onnx"
      : parseEnvBoolean(supplementRaw, EMBEDDING_KEYS.supplement)
  });
}

export function readEmbeddingRuntimeConfig(
  configEnv: ReadonlyMap<string, string>,
  warn: (message: string, meta: Record<string, unknown>) => void
): EmbeddingRuntimeConfig {
  refuseRetiredLocalCrossEncoderRerank(configEnv);
  const posture = resolveEffectiveEmbeddingPosture((key) => readConfigEnvValue(configEnv, key));
  warn("effective embedding runtime", {
    provider_kind: posture.providerKind,
    embedding_supplement_enabled: posture.embeddingSupplementEnabled
  });
  const secretRef = readConfigEnvValue(configEnv, EMBEDDING_KEYS.openaiSecretRef);
  return {
    embeddingApiKey: posture.providerKind === "openai"
      ? resolveOpenAiEmbeddingApiKey(secretRef, posture)
      : null,
    configuredEmbeddingModel: readNonEmptyEnv(
      readConfigEnvValue(configEnv, EMBEDDING_KEYS.openaiModel)
    ),
    configuredEmbeddingProviderUrl: readNonEmptyEnv(
      readConfigEnvValue(configEnv, EMBEDDING_KEYS.openaiProviderUrl)
    ),
    embeddingProviderKind: posture.providerKind,
    localEmbeddingCacheDir: readNonEmptyEnv(
      readConfigEnvValue(configEnv, EMBEDDING_KEYS.localCacheDir)
    ),
    localEmbeddingModel: readNonEmptyEnv(
      readConfigEnvValue(configEnv, EMBEDDING_KEYS.localModel)
    ),
    embeddingSupplementEnabled: posture.embeddingSupplementEnabled,
    recallPolicyEmbeddingEnabled: posture.embeddingSupplementEnabled,
    d2qEnabled: parseEnvBoolean(
      readNonEmptyEnv(readConfigEnvValue(configEnv, EMBEDDING_KEYS.d2q)) ?? undefined,
      EMBEDDING_KEYS.d2q
    )
  };
}

function refuseRetiredLocalCrossEncoderRerank(
  configEnv: ReadonlyMap<string, string>
): void {
  const raw = readNonEmptyEnv(
    readConfigEnvValue(configEnv, EMBEDDING_KEYS.localCrossEncoderRerank)
  );
  if (raw === null) return;
  const normalized = raw.toLowerCase();
  if (normalized === "false" || normalized === "0") return;
  throw new Error(LOCAL_CROSS_ENCODER_RERANK_REMOVED_ERROR);
}

export function isD2qActive(config: EmbeddingRuntimeConfig): boolean {
  return config.d2qEnabled && config.embeddingProviderKind === "local_onnx";
}

function readExplicitEmbeddingProviderKind(
  raw: string | null
): EmbeddingProviderKind | null {
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (normalized === "openai" || normalized === "local_onnx") return normalized;
  throw new Error("ALAYA_EMBEDDING_PROVIDER must be openai or local_onnx when set.");
}

function resolveOpenAiEmbeddingApiKey(
  rawSecretRef: string | undefined,
  posture: EffectiveEmbeddingPosture
): string | null {
  if (rawSecretRef === undefined || rawSecretRef.trim().length === 0) {
    if (posture.providerWasExplicit && posture.embeddingSupplementEnabled) {
      throw new Error(
        "ALAYA_EMBEDDING_PROVIDER=openai requires a resolvable ALAYA_OPENAI_SECRET_REF"
      );
    }
    return null;
  }
  const resolved = resolveSecretRef(rawSecretRef);
  if (!("kind" in resolved)) return resolved.value;
  throw new Error(formatEmbeddingSecretResolutionError(resolved));
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
