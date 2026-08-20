import { CORE_CONFIG_ENV_KEYS } from "./core-config-environment.js";
import {
  parseDefaultOnFlag,
  parseEnvOptionalNonNegativeSafeInt,
  parseEnvOptionalNumber
} from "./env-value.js";

export interface RecallRuntimeConfig {
  readonly confRhoPath: number | undefined;
  readonly confRhoEvidence: number | undefined;
  readonly confWPath: number | undefined;
  readonly confFloodCap: number | undefined;
  readonly confFloodCapTotal: number | undefined;
  readonly pathEmbModulation: string | undefined;
  readonly projectionsEnabled: boolean;
  readonly extraSynonymClusters: string | undefined;
  readonly finalAuthorityMaxHeadDrop: number | undefined;
}

export function parseRecallRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): RecallRuntimeConfig {
  const keys = CORE_CONFIG_ENV_KEYS.recall;
  return Object.freeze({
    confRhoPath: parseEnvOptionalNumber(env[keys.confRhoPath], keys.confRhoPath),
    confRhoEvidence: parseEnvOptionalNumber(env[keys.confRhoEvidence], keys.confRhoEvidence),
    confWPath: parseEnvOptionalNumber(env[keys.confWPath], keys.confWPath),
    confFloodCap: parseEnvOptionalNumber(env[keys.confFloodCap], keys.confFloodCap),
    confFloodCapTotal: parseEnvOptionalNumber(
      env[keys.confFloodCapTotal],
      keys.confFloodCapTotal
    ),
    pathEmbModulation: env[keys.pathEmbModulation],
    projectionsEnabled: parseDefaultOnFlag(env[keys.projections], keys.projections),
    extraSynonymClusters: env[keys.extraSynonymClusters],
    finalAuthorityMaxHeadDrop: parseEnvOptionalNonNegativeSafeInt(
      env[keys.finalAuthorityMaxHeadDrop],
      keys.finalAuthorityMaxHeadDrop
    )
  });
}
