import {
  parseEnvBoolean,
  parseEnvOptionalBoolean,
  type RuntimeGardenProviderKind
} from "@do-soul/alaya-protocol";
import { PATH_RELATION_COUNTER_DEFAULT_TTL_MS } from
  "../../relations/edge-proposals/path-relation-proposal-service-shared.js";

const GARDEN_PROVIDER_KINDS = new Set<RuntimeGardenProviderKind>([
  "official_api",
  "local_heuristics",
  "host_worker"
]);

export const PRODUCT_FORMATION_DEFAULTS = Object.freeze({
  ingestReconciliationEnabled: true,
  conflictDetectionEnabled: true,
  conflictRuleEnabled: true,
  gardenProviderKindWithoutSecret: "host_worker" as const,
  retainUnroutedFacts: true,
  fullTurnEvidence: true,
  materializationConfidenceFloor: 0.5,
  edgeProducerLlmEnabled: false,
  edgeClassifyHostWorker: true,
  pathRelationCounterTtlMs: PATH_RELATION_COUNTER_DEFAULT_TTL_MS
});

export function resolveProductFormationEnabled(
  value: string | undefined,
  defaultValue = true
): boolean {
  return parseEnvBoolean(value, "product formation flag", defaultValue);
}

export function resolveProductGardenProviderKind(
  declaredValue: string | null | undefined,
  hasSecret: boolean
): RuntimeGardenProviderKind {
  const normalized = declaredValue?.trim();
  if (GARDEN_PROVIDER_KINDS.has(normalized as RuntimeGardenProviderKind)) {
    return normalized as RuntimeGardenProviderKind;
  }
  return hasSecret ? "official_api" : PRODUCT_FORMATION_DEFAULTS.gardenProviderKindWithoutSecret;
}

export function resolveProductFormationOptIn(value: string | undefined): boolean {
  return parseEnvBoolean(value, "product formation opt-in");
}

export function resolveProductEdgeClassifyHostWorker(
  value: string | undefined
): boolean {
  return parseEnvOptionalBoolean(value, "ALAYA_EDGE_CLASSIFY_HOST_WORKER")
    ?? PRODUCT_FORMATION_DEFAULTS.edgeClassifyHostWorker;
}

export function resolveProductMaterializationConfidenceFloor(
  value: string | undefined
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : PRODUCT_FORMATION_DEFAULTS.materializationConfidenceFloor;
}

export function resolveProductPathRelationCounterTtlMs(
  value: string | undefined
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : PRODUCT_FORMATION_DEFAULTS.pathRelationCounterTtlMs;
}
