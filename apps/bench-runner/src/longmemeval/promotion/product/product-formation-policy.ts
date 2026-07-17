import { isDeepStrictEqual } from "node:util";
import {
  PRODUCT_FORMATION_DEFAULTS,
  resolveProductEdgeClassifyHostWorker,
  resolveProductFormationEnabled,
  resolveProductFormationOptIn,
  resolveProductMaterializationConfidenceFloor,
  resolveProductPathRelationCounterTtlMs,
  resolveProductPathRelationThreshold,
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

export function resolveProductFormationIdentity(
  env: Readonly<Record<string, string | undefined>>
) {
  return Object.freeze({
    ingestReconciliationEnabled: resolveProductFormationEnabled(
      env.ALAYA_INGEST_RECONCILIATION_ENABLED
    ),
    conflictDetectionEnabled: resolveProductFormationEnabled(
      env.ALAYA_CONFLICT_DETECTION_ENABLED
    ),
    conflictRuleEnabled: resolveProductFormationEnabled(
      env.ALAYA_CONFLICT_RULE_ENABLED
    ),
    gardenProviderKindWithoutSecret: resolveProductGardenProviderKind(
      env.ALAYA_GARDEN_PROVIDER_KIND,
      false
    ),
    retainUnroutedFacts: resolveProductFormationEnabled(env.ALAYA_RETAIN_UNROUTED_FACTS),
    fullTurnEvidence: resolveProductFormationEnabled(env.ALAYA_EVIDENCE_FULL_TURN),
    materializationConfidenceFloor: resolveProductMaterializationConfidenceFloor(
      env.ALAYA_MATERIALIZATION_CONF_FLOOR
    ),
    edgeProducerLlmEnabled: resolveProductFormationOptIn(
      env.ALAYA_EDGE_PRODUCER_LLM_ENABLED
    ),
    edgeClassifyHostWorker: resolveProductEdgeClassifyHostWorker(
      env.ALAYA_EDGE_CLASSIFY_HOST_WORKER
    ),
    pathRelationCounterTtlMs: resolveProductPathRelationCounterTtlMs(
      env.ALAYA_PATHREL_COUNTER_TTL_MS
    ),
    pathRelationCoUsageThreshold: resolveProductPathRelationThreshold(
      env.ALAYA_PATHREL_CO_USAGE_THRESHOLD
    )
  });
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
