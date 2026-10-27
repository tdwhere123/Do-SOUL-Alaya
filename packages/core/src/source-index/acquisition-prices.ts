import type { SourceIndexQueryVector, SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";

// Capacity quotations and executed debits share these logical vector prices.
export const VECTOR_COST = Object.freeze({ validation_per_dimension: 2, lookup_work: 1,
  replacement_work: 1, replacement_bytes: 128, key_bytes_per_character: 4,
  ordering_work: 1, ordering_bytes: 64, ordering_reference_bytes: 8,
  comparison_work: 1, rank_work: 1, rank_bytes: 128 });

export function acquisitionResultEnvelopeCost(maxRoots: number): SourceSemanticResourceBudget {
  return { work_units: 1, memory_bytes: 2048 + 8 * maxRoots };
}
export function acquisitionNavigationDigestCost(navigation: string): SourceSemanticResourceBudget {
  return { work_units: navigation.length, memory_bytes: 0 };
}
export function acquisitionQueryBindingCost(): SourceSemanticResourceBudget {
  return { work_units: 1, memory_bytes: 256 };
}
export function acquisitionQueryVectorNormCost(dimensions: number): SourceSemanticResourceBudget {
  return { work_units: 3 * dimensions, memory_bytes: 4 * dimensions };
}
export function acquisitionQueryVectorCaptureCost(vector: SourceIndexQueryVector): SourceSemanticResourceBudget {
  if (vector.status !== "available") return { work_units: 0, memory_bytes: 0 };
  const binding = acquisitionQueryBindingCost();
  const norm = acquisitionQueryVectorNormCost(vector.profile.dimensions);
  return { work_units: binding.work_units + norm.work_units, memory_bytes: binding.memory_bytes + norm.memory_bytes };
}
