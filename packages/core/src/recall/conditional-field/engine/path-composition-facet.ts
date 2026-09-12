import { createHash } from "node:crypto";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FacetMode,
  type FacetVector,
  type ProductStateKey
} from "@do-soul/alaya-protocol";
import { evaluateFacetPredicate } from "../reference/accepting-projection.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { PathComputation } from "./path-effect-cursor.js";
import type { RetainedRows } from "./retained-sequence.js";

export function facetPathId(state: ProductStateKey): string {
  return createHash("sha256").update(productStateNodeId(state)).digest("hex");
}

export function composedFacetPathId(state: ProductStateKey, route: string): string {
  const identity = facetPathId(state);
  return `${identity}:${createHash("sha256").update(route).digest("hex")}`;
}

export function facetBelongsToOutput(pathId: string, state: ProductStateKey): boolean {
  const identity = facetPathId(state);
  return pathId === identity || pathId.startsWith(`${identity}:`);
}

export function retainSamePathVectors(
  vectors: readonly FacetVector[]
): readonly FacetVector[] {
  // Distinct path_id rows stay joint witnesses; coordinates are not max-merged.
  const byPath = new Map<string, FacetVector>();
  for (const vector of vectors) {
    if (!byPath.has(vector.path_id)) byPath.set(vector.path_id, vector);
  }
  return Object.freeze([...byPath.values()]);
}

export function samePathAccepts(
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  return evaluateFacetPredicate("same_path", retainSamePathVectors(vectors), threshold);
}

export function facetModeAccepts(
  mode: FacetMode,
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  return evaluateFacetPredicate(mode, retainSamePathVectors(vectors), threshold);
}

export function* extendFacets(
  priorFacets: RetainedRows<FacetVector>,
  from: ProductStateKey,
  to: ProductStateKey,
  route: string,
  milligrades: number
): PathComputation<readonly FacetVector[]> {
  const inherited: FacetVector[] = [];
  for (const vector of priorFacets) {
    if (facetBelongsToOutput(vector.path_id, from)) inherited.push(vector);
    yield { kind: "work" };
  }
  const obligation = { obligation_id: createHash("sha256").update(route).digest("hex"), domain_id: ASSOCIATION_DOMAIN_ID };
  if (inherited.length === 0) {
    return [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(to, route),
      obligations: [obligation],
      coordinates: [milligrades]
    }];
  }
  const joint = new Map<string, FacetVector>();
  for (const vector of inherited) {
    const obligations = [...vector.obligations ?? vector.coordinates.map((_, index) => ({
      obligation_id: `retained-coordinate:${index}`, domain_id: ASSOCIATION_DOMAIN_ID }))];
    const coordinates = [...vector.coordinates];
    const index = obligations.findIndex((item) => item.obligation_id === obligation.obligation_id && item.domain_id === obligation.domain_id);
    if (index < 0) { obligations.push(obligation); coordinates.push(milligrades); }
    else coordinates[index] = Math.min(coordinates[index]!, milligrades);
    const identity = JSON.stringify([obligations, coordinates]);
    joint.set(identity, { schema_version: 1, path_id: composedFacetPathId(to, identity), obligations, coordinates });
    yield { kind: "work", retained_bytes: Buffer.byteLength(identity, "utf8") + 128 };
  }
  return [...joint.values()];
}
