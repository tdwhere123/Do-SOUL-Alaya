import { createHash } from "node:crypto";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FacetMode,
  type FacetVector,
  type ProductStateKey
} from "@do-soul/alaya-protocol";
import { evaluateFacetPredicate } from "./facet-predicates.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { PathComputation } from "./path-effect-cursor.js";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";

export function facetPathId(state: ProductStateKey): string {
  return createHash("sha256").update(productStateNodeId(state)).digest("hex");
}

export function composedFacetPathId(state: ProductStateKey, route: string): string {
  const identity = facetPathId(state);
  return `${identity}:${createHash("sha256").update(route).digest("hex")}`;
}

export function facetBelongsToOutput(pathId: string, state: ProductStateKey): boolean {
  return facetIdentityOf(pathId) === facetPathId(state);
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

/** Facets grouped by the state identity their path_id starts with, in retained order. */
export type FacetIdentityIndex = PersistentStringMap<RetainedSequence<FacetVector>>;

const NO_FACETS = RetainedSequence.empty<FacetVector>();

/** A path_id is the state identity alone or the identity, a colon and a route digest. */
export function facetIdentityOf(pathId: string): string {
  const cut = pathId.indexOf(":");
  return cut < 0 ? pathId : pathId.slice(0, cut);
}

export function facetIdentityEntryBytes(index: FacetIdentityIndex, vector: FacetVector): number {
  const identity = facetIdentityOf(vector.path_id);
  return index.has(identity) ? 16 : 96 + 2 * identity.length + 16;
}

export function withFacetIdentity(index: FacetIdentityIndex, vector: FacetVector): FacetIdentityIndex {
  const identity = facetIdentityOf(vector.path_id);
  return index.with(identity, (index.get(identity) ?? NO_FACETS).append(vector));
}

export function indexFacetsByIdentity(facets: Iterable<FacetVector>): FacetIdentityIndex {
  let index: FacetIdentityIndex = new PersistentStringMap();
  for (const vector of facets) index = withFacetIdentity(index, vector);
  return index;
}

/** One generator owns the lookup for its immutable facet input version. */
export class PathFacetLookup {
  private index: FacetIdentityIndex | undefined;
  public constructor(private readonly facets: RetainedRows<FacetVector>, supplied?: FacetIdentityIndex) {
    this.index = supplied;
  }

  public *forState(state: ProductStateKey): PathComputation<RetainedRows<FacetVector>> {
    yield { kind: "work" };
    if (this.index === undefined) {
      // A caller without a state-owned index pays for one build per generator.
      let built: FacetIdentityIndex = new PersistentStringMap();
      for (let position = 0; position < this.facets.length; position += 1) {
        const vector = this.facets.at(position)!;
        yield { kind: "work", retained_bytes: facetIdentityEntryBytes(built, vector) };
        built = withFacetIdentity(built, vector);
      }
      this.index = built;
    }
    return this.index.get(facetPathId(state)) ?? NO_FACETS;
  }
}

export function* extendFacets(
  lookup: PathFacetLookup,
  from: ProductStateKey,
  to: ProductStateKey,
  route: string,
  milligrades: number
): PathComputation<readonly FacetVector[]> {
  const inherited = yield* lookup.forState(from);
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
