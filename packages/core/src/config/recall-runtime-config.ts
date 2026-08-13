import { CORE_CONFIG_ENV_KEYS } from "./core-config-environment.js";

export interface RecallRuntimeConfig {
  readonly confRhoPath: number | undefined;
  readonly confRhoEvidence: number | undefined;
  readonly confWPath: number | undefined;
  readonly confEvidenceBeta: number | undefined;
  readonly confFloodCap: number | undefined;
  readonly confFloodCapTotal: number | undefined;
  readonly pathEmbModulation: string | undefined;
  readonly projectionsEnabled: boolean;
  readonly extraSynonymClusters: string | undefined;
  readonly finalAuthorityMaxHeadDrop: number | undefined;
}

function defaultOn(raw: string | undefined): boolean {
  return !/^(?:0|false|off|no|disabled)$/iu.test(raw ?? "on");
}

function readOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readOptionalNonNegativeSafeInt(
  raw: string | undefined,
  key: string
): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  const value = Number(normalized);
  if (!/^[0-9]+$/u.test(normalized) || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a non-negative safe integer`);
  }
  return value;
}

export function parseRecallRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): RecallRuntimeConfig {
  const keys = CORE_CONFIG_ENV_KEYS.recall;
  return Object.freeze({
    confRhoPath: readOptionalNumber(env[keys.confRhoPath]),
    confRhoEvidence: readOptionalNumber(env[keys.confRhoEvidence]),
    confWPath: readOptionalNumber(env[keys.confWPath]),
    confEvidenceBeta: readOptionalNumber(env[keys.confEvidenceBeta]),
    confFloodCap: readOptionalNumber(env[keys.confFloodCap]),
    confFloodCapTotal: readOptionalNumber(env[keys.confFloodCapTotal]),
    pathEmbModulation: env[keys.pathEmbModulation],
    projectionsEnabled: defaultOn(env[keys.projections]),
    extraSynonymClusters: env[keys.extraSynonymClusters],
    finalAuthorityMaxHeadDrop: readOptionalNonNegativeSafeInt(
      env[keys.finalAuthorityMaxHeadDrop],
      keys.finalAuthorityMaxHeadDrop
    )
  });
}
