import { describe, expect, it } from "vitest";
import {
  PRODUCT_FORMATION_DEFAULTS,
  resolveProductEdgeClassifyHostWorker,
  resolveProductFormationEnabled,
  resolveProductFormationOptIn,
  resolveProductGardenProviderKind,
  resolveProductMaterializationConfidenceFloor,
  resolveProductPathRelationCounterTtlMs,
  resolveProductPathRelationThreshold
} from "../../shared/product-formation/defaults.js";

describe("product formation defaults", () => {
  it("keeps reconciliation and conflict detection enabled by default", () => {
    expect(PRODUCT_FORMATION_DEFAULTS).toMatchObject({
      ingestReconciliationEnabled: true,
      conflictDetectionEnabled: true,
      conflictRuleEnabled: true,
      gardenProviderKindWithoutSecret: "host_worker",
      retainUnroutedFacts: true,
      fullTurnEvidence: true,
      materializationConfidenceFloor: 0.5,
      edgeProducerLlmEnabled: false,
      edgeClassifyHostWorker: true,
      pathRelationCounterTtlMs: 86_400_000,
      pathRelationCoUsageThreshold: 3
    });
    expect(resolveProductFormationEnabled(undefined)).toBe(true);
    expect(resolveProductFormationEnabled("")).toBe(true);
    expect(resolveProductFormationEnabled("1")).toBe(true);
    expect(resolveProductFormationEnabled("false")).toBe(false);
    expect(resolveProductFormationEnabled("0")).toBe(false);
  });

  it("normalizes the remaining seed-time formation defaults", () => {
    expect(resolveProductFormationOptIn(undefined)).toBe(false);
    expect(resolveProductFormationOptIn("true")).toBe(true);
    expect(resolveProductEdgeClassifyHostWorker(undefined)).toBe(true);
    expect(resolveProductEdgeClassifyHostWorker("false")).toBe(false);
    expect(resolveProductMaterializationConfidenceFloor(undefined)).toBe(0.5);
    expect(resolveProductMaterializationConfidenceFloor("0.5")).toBe(0.5);
    expect(resolveProductMaterializationConfidenceFloor("invalid")).toBe(0.5);
    expect(resolveProductPathRelationCounterTtlMs(undefined)).toBe(86_400_000);
    expect(resolveProductPathRelationCounterTtlMs("86400000")).toBe(86_400_000);
    expect(resolveProductPathRelationThreshold(undefined)).toBe(3);
    expect(resolveProductPathRelationThreshold("3")).toBe(3);
  });

  it("uses host work without a secret and official compute with one", () => {
    expect(resolveProductGardenProviderKind(undefined, false)).toBe("host_worker");
    expect(resolveProductGardenProviderKind(undefined, true)).toBe("official_api");
    expect(resolveProductGardenProviderKind("local_heuristics", false))
      .toBe("local_heuristics");
    expect(resolveProductGardenProviderKind("not-a-provider", false))
      .toBe("host_worker");
  });
});
