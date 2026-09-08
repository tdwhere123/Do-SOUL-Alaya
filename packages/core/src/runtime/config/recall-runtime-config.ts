import { CORE_CONFIG_ENV_KEYS } from "./core-config-environment.js";
import { parseDefaultOnFlag } from "./env-value.js";

export interface RecallRuntimeConfig {
  readonly projectionsEnabled: boolean;
  readonly extraSynonymClusters: string | undefined;
}

export function parseRecallRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): RecallRuntimeConfig {
  const keys = CORE_CONFIG_ENV_KEYS.recall;
  return Object.freeze({
    projectionsEnabled: parseDefaultOnFlag(env[keys.projections], keys.projections),
    extraSynonymClusters: env[keys.extraSynonymClusters]
  });
}
