import type { SeedFuelInventory } from "./seed-fuel-inventory.js";

export interface SeedFuelInventoryKpi {
  readonly objects_total: number;
  readonly evidence_refs_total: number;
  readonly facet_anchors_total: number;
  readonly path_candidates_total: number;
  readonly support_bearing_candidates: number;
}

export function toSeedFuelInventoryKpi(
  inventory: SeedFuelInventory
): SeedFuelInventoryKpi {
  return {
    objects_total: inventory.objects_total,
    evidence_refs_total: inventory.evidence_refs_total,
    facet_anchors_total: inventory.facet_anchors_total,
    path_candidates_total: inventory.path_candidates_total,
    support_bearing_candidates: inventory.support_bearing_candidates
  };
}
