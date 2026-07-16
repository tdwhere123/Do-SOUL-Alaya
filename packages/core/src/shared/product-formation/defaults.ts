import type { RuntimeGardenProviderKind } from "@do-soul/alaya-protocol";
import {
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  PATH_RELATION_PROPOSE_THRESHOLD
} from "../../path-graph/edge-proposals/path-relation-proposal-service-shared.js";

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
  pathRelationCounterTtlMs: PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  pathRelationCoUsageThreshold: PATH_RELATION_PROPOSE_THRESHOLD
});

export function resolveProductFormationEnabled(
  value: string | undefined,
  defaultValue = true
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return defaultValue;
  return normalized !== "0" && normalized !== "false";
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
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function resolveProductEdgeClassifyHostWorker(
  value: string | undefined
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return PRODUCT_FORMATION_DEFAULTS.edgeClassifyHostWorker;
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

export function resolveProductPathRelationThreshold(
  value: string | undefined
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : PRODUCT_FORMATION_DEFAULTS.pathRelationCoUsageThreshold;
}
