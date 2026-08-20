import { isDeepStrictEqual } from "node:util";
import {
  PRODUCT_FORMATION_DEFAULTS,
  parseDefaultOnFlag,
  parseEnvBoolean,
  parseEnvOptionalNumber,
  resolveProductGardenProviderKind
} from "@do-soul/alaya-core";

export function assertProductFormationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  context: string
): void {
  if (!isDeepStrictEqual(
    resolveProductFormationIdentity(env),
    PRODUCT_FORMATION_DEFAULTS
  ) || hasConflictLlmConfig(env)) {
    throw new Error(`${context} differs from product formation defaults`);
  }
}

function resolveProductFormationIdentity(
  env: Readonly<Record<string, string | undefined>>
) {
  return Object.freeze({
    ingestReconciliationEnabled: parseDefaultOnFlag(
      env.ALAYA_INGEST_RECONCILIATION_ENABLED,
      "ALAYA_INGEST_RECONCILIATION_ENABLED"
    ),
    conflictDetectionEnabled: parseDefaultOnFlag(
      env.ALAYA_CONFLICT_DETECTION_ENABLED,
      "ALAYA_CONFLICT_DETECTION_ENABLED"
    ),
    conflictRuleEnabled: parseDefaultOnFlag(
      env.ALAYA_CONFLICT_RULE_ENABLED,
      "ALAYA_CONFLICT_RULE_ENABLED"
    ),
    gardenProviderKindWithoutSecret: parseGardenProviderKindWithoutSecret(
      env.ALAYA_GARDEN_PROVIDER_KIND
    ),
    retainUnroutedFacts: parseDefaultOnFlag(
      env.ALAYA_RETAIN_UNROUTED_FACTS,
      "ALAYA_RETAIN_UNROUTED_FACTS"
    ),
    fullTurnEvidence: parseDefaultOnFlag(
      env.ALAYA_EVIDENCE_FULL_TURN,
      "ALAYA_EVIDENCE_FULL_TURN"
    ),
    materializationConfidenceFloor: parseFormationNumber(
      env.ALAYA_MATERIALIZATION_CONF_FLOOR,
      "ALAYA_MATERIALIZATION_CONF_FLOOR",
      PRODUCT_FORMATION_DEFAULTS.materializationConfidenceFloor,
      (value) => value >= 0 && value <= 1
    ),
    edgeProducerLlmEnabled: parseEnvBoolean(
      env.ALAYA_EDGE_PRODUCER_LLM_ENABLED,
      "ALAYA_EDGE_PRODUCER_LLM_ENABLED"
    ),
    edgeClassifyHostWorker: parseDefaultOnFlag(
      env.ALAYA_EDGE_CLASSIFY_HOST_WORKER,
      "ALAYA_EDGE_CLASSIFY_HOST_WORKER"
    ),
    pathRelationCounterTtlMs: parseFormationNumber(
      env.ALAYA_PATHREL_COUNTER_TTL_MS,
      "ALAYA_PATHREL_COUNTER_TTL_MS",
      PRODUCT_FORMATION_DEFAULTS.pathRelationCounterTtlMs,
      (value) => value > 0
    )
  });
}

function parseGardenProviderKindWithoutSecret(raw: string | undefined) {
  const declared = raw?.trim();
  if (declared === undefined || declared === "") {
    return PRODUCT_FORMATION_DEFAULTS.gardenProviderKindWithoutSecret;
  }
  const resolved = resolveProductGardenProviderKind(declared, false);
  if (resolved !== declared) {
    throw new Error("ALAYA_GARDEN_PROVIDER_KIND is not a known garden provider kind");
  }
  return resolved;
}

function parseFormationNumber(
  raw: string | undefined,
  key: string,
  fallback: number,
  inRange: (value: number) => boolean
): number {
  if (raw === undefined) return fallback;
  const parsed = parseEnvOptionalNumber(raw, key);
  if (parsed === undefined || !inRange(parsed)) {
    throw new Error(`${key} must be a finite number in range`);
  }
  return parsed;
}

function hasConflictLlmConfig(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return hasNonempty(env.ALAYA_CONFLICT_LLM_PROVIDER_URL) ||
    hasNonempty(env.ALAYA_CONFLICT_LLM_API_KEY);
}

function hasNonempty(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0;
}
