import {
  MILLIGRADE_BOTTOM,
  type FacetMode,
  type FacetVector,
  type QueryFacetObligation
} from "@do-soul/alaya-protocol";

export function requiredFacetObligations(
  obligations: readonly QueryFacetObligation[] | undefined
): readonly QueryFacetObligation[] {
  return (obligations ?? []).filter((row) => row.requiredness === "required");
}

export function queryRequiresFacetMeasurement(
  obligations: readonly QueryFacetObligation[] | undefined
): boolean {
  return requiredFacetObligations(obligations).length > 0;
}

export function facetObligationsAccept(
  obligations: readonly QueryFacetObligation[] | undefined,
  vectors: readonly FacetVector[],
  mode: FacetMode
): boolean {
  const required = requiredFacetObligations(obligations);
  if (required.length === 0) return true;
  if (vectors.length === 0) return false;
  const named = vectors.map(namedGrades);
  if (mode === "independent") {
    return required.every((obligation) => named.some((grades) => satisfies(obligation, grades)));
  }
  return named.some((grades) => required.every((obligation) => satisfies(obligation, grades)));
}

function namedGrades(vector: FacetVector): ReadonlyMap<string, number> {
  const grades = new Map<string, number>();
  const named = vector.obligations;
  if (named === undefined) return grades;
  for (const [index, obligation] of named.entries()) {
    const key = obligationKey(obligation.obligation_id, obligation.domain_id);
    const value = vector.coordinates[index] ?? MILLIGRADE_BOTTOM;
    const prior = grades.get(key);
    grades.set(key, prior === undefined ? value : Math.min(prior, value));
  }
  return grades;
}

function satisfies(
  obligation: QueryFacetObligation,
  grades: ReadonlyMap<string, number>
): boolean {
  const value = grades.get(obligationKey(obligation.obligation_id, obligation.domain_id));
  if (value === undefined) return false;
  return value > obligation.threshold_milligrades;
}

function obligationKey(obligationId: string, domainId: string): string {
  return `${obligationId}\0${domainId}`;
}
