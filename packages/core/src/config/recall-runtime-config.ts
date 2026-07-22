import {
  CORE_CONFIG_ENV_KEYS,
  CORE_CONFIG_ENV_PREFIXES
} from "./core-config-environment.js";

export interface RecallRuntimeConfig {
  readonly facetSlice: string | undefined;
  readonly confRhoPath: number | undefined;
  readonly confRhoEvidence: number | undefined;
  readonly confWPath: number | undefined;
  readonly confEvidenceBeta: number | undefined;
  readonly confFloodCap: number | undefined;
  readonly confFloodCapTotal: number | undefined;
  readonly confSliceCompatibility: boolean;
  readonly pathEmbModulation: string | undefined;
  readonly projectionsEnabled: boolean;
  readonly lexicalDecorr: string | undefined;
  readonly intentV2: boolean;
  readonly extraSynonymClusters: string | undefined;
  readonly sessionRoute: boolean;
  readonly finalAuthorityMaxHeadDrop: number | undefined;
  readonly coarseFilterSemanticFlags: Readonly<Record<string, string | undefined>>;
}

function flagEnabled(raw: string | undefined): boolean {
  return raw === "on" || raw === "1" || raw === "true";
}

function defaultOn(raw: string | undefined): boolean {
  return !/^(?:0|false|off|no)$/iu.test(raw ?? "on");
}

function yesEnabled(raw: string | undefined): boolean {
  return /^(?:1|true|on|yes)$/iu.test(raw ?? "");
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

function collectPrefixedEnv(
  env: Readonly<Record<string, string | undefined>>,
  prefix: string
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      out[key] = value;
    }
  }
  return Object.freeze(out);
}

function collectRecallSemanticEnv(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...collectPrefixedEnv(env, CORE_CONFIG_ENV_PREFIXES.recallSemantic),
    ALAYA_RECALL_ANCHOR_LANE: env.ALAYA_RECALL_ANCHOR_LANE,
    ALAYA_RECALL_SUBQUERY: env.ALAYA_RECALL_SUBQUERY
  });
}

export function parseRecallRuntimeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>
): RecallRuntimeConfig {
  const keys = CORE_CONFIG_ENV_KEYS.recall;
  return Object.freeze({
    facetSlice: env[keys.facetSlice],
    confRhoPath: readOptionalNumber(env[keys.confRhoPath]),
    confRhoEvidence: readOptionalNumber(env[keys.confRhoEvidence]),
    confWPath: readOptionalNumber(env[keys.confWPath]),
    confEvidenceBeta: readOptionalNumber(env[keys.confEvidenceBeta]),
    confFloodCap: readOptionalNumber(env[keys.confFloodCap]),
    confFloodCapTotal: readOptionalNumber(env[keys.confFloodCapTotal]),
    confSliceCompatibility: flagEnabled(env[keys.confSliceCompatibility]),
    pathEmbModulation: env[keys.pathEmbModulation],
    projectionsEnabled: defaultOn(env[keys.projections]),
    lexicalDecorr: env[keys.lexicalDecorr],
    intentV2: /^(?:1|true|on|yes)$/iu.test(env[keys.intentV2] ?? ""),
    extraSynonymClusters: env[keys.extraSynonymClusters],
    sessionRoute: yesEnabled(env[keys.sessionRoute]),
    finalAuthorityMaxHeadDrop: readOptionalNonNegativeSafeInt(
      env[keys.finalAuthorityMaxHeadDrop],
      keys.finalAuthorityMaxHeadDrop
    ),
    coarseFilterSemanticFlags: collectRecallSemanticEnv(env)
  });
}
