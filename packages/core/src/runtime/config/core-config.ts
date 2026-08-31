import { StorageTier } from "@do-soul/alaya-protocol";
import { parseRecallRuntimeConfigFromEnv, type RecallRuntimeConfig } from "./recall-runtime-config.js";
import { CORE_CONFIG_ENV_KEYS } from "./core-config-environment.js";
import { parseEnvOptionalNumber } from "./env-value.js";

export interface EmbeddingRuntimeConfig {
  readonly backfillConcurrency: number | undefined;
  readonly recallTiersRaw: string | undefined;
  readonly workspaceScanCap: number | undefined;
}

export interface PathGraphRuntimeConfig {
  readonly pathrelContentStrength: string | undefined;
}

export interface CoreConfig {
  readonly recall: RecallRuntimeConfig;
  readonly embedding: EmbeddingRuntimeConfig;
  readonly pathGraph: PathGraphRuntimeConfig;
}

const VALID_EMBEDDING_TIERS: readonly StorageTier[] = [
  StorageTier.HOT,
  StorageTier.WARM,
  StorageTier.COLD
];

const DEFAULT_EMBEDDING_RECALL_TIERS: readonly StorageTier[] = [StorageTier.HOT, StorageTier.WARM];

function readOptionalPositiveInt(raw: string | undefined, key: string): number | undefined {
  const value = parseEnvOptionalNumber(raw, key);
  if (value === undefined) return undefined;
  if (value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return Math.floor(value);
}

export function parseCoreConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): CoreConfig {
  const embeddingKeys = CORE_CONFIG_ENV_KEYS.embedding;
  return Object.freeze({
    recall: parseRecallRuntimeConfigFromEnv(env),
    embedding: Object.freeze({
      backfillConcurrency: readOptionalPositiveInt(
        env[embeddingKeys.backfillConcurrency],
        embeddingKeys.backfillConcurrency
      ),
      recallTiersRaw: env[embeddingKeys.recallTiers],
      workspaceScanCap: readOptionalPositiveInt(
        env[embeddingKeys.workspaceScanCap],
        embeddingKeys.workspaceScanCap
      )
    }),
    pathGraph: Object.freeze({
      pathrelContentStrength: env[CORE_CONFIG_ENV_KEYS.pathGraph.contentStrength]
    })
  });
}

export function resolvePathRelContentStrengthEnabledFromConfig(
  config: PathGraphRuntimeConfig
): boolean {
  const raw = config.pathrelContentStrength;
  return raw === "on" || raw === "1" || raw === "true";
}

export function resolveEmbeddingRecallTiersFromConfig(
  config: EmbeddingRuntimeConfig
): readonly StorageTier[] {
  const raw = config.recallTiersRaw;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EMBEDDING_RECALL_TIERS;
  }
  const parsed = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token): token is StorageTier => VALID_EMBEDDING_TIERS.includes(token as StorageTier));
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_EMBEDDING_RECALL_TIERS;
}
