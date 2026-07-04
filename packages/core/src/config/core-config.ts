import { StorageTier } from "@do-soul/alaya-protocol";
import { parseRecallRuntimeConfigFromEnv, type RecallRuntimeConfig } from "./recall-runtime-config.js";

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

function readOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function parseCoreConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): CoreConfig {
  return Object.freeze({
    recall: parseRecallRuntimeConfigFromEnv(env),
    embedding: Object.freeze({
      backfillConcurrency: readOptionalPositiveInt(env.ALAYA_EMBEDDING_BACKFILL_CONCURRENCY),
      recallTiersRaw: env.ALAYA_EMBEDDING_RECALL_TIERS,
      workspaceScanCap: readOptionalPositiveInt(env.ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP)
    }),
    pathGraph: Object.freeze({
      pathrelContentStrength: env.ALAYA_PATHREL_CONTENT_STRENGTH
    })
  });
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
