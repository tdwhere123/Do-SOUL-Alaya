import { type Transition } from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { RetainedRows } from "./retained-sequence.js";

export type { HyperedgePremise, HyperedgeCompletion, AdjacencyRow, NamedKindOverlay } from "./path-composition-adjacency.js";
export { ACCEPTING_PROGRAM_STATE, START_PROGRAM_STATE } from "./program-automaton.js";
export { tryCompleteHyperedge } from "./path-hyperedge.js";
export {
  overlayIsRoutingOnly,
  routingDiscoveryEffect,
  routingOverlayKinds,
  mergeDiscoveries,
  pairKey,
  nextAdjacencyPair,
  hasOpenPairs,
  type RoutingDiscovery
} from "./path-routing.js";
export {
  serialMin,
  alternativeMax,
  productStateFromObservation,
  observationIsGuaranteed,
  queryAdmitsGuaranteedSeed,
  seedFromObservation,
  timeStateFor,
  hypothesisIdsFor,
  runtimeProgram,
  seedProgramStates,
  seedActivationsForObservation,
  mergeSeeds,
  collectIdentities
} from "./path-composition-seed.js";
export {
  type CompiledAdjacencyEffect,
  type AdjacencyEffectsInput,
  programRelationKinds,
  adjacencyKindsFor,
  adjacencyEffectsForRows,
  createAdjacencyEffectCursor
} from "./path-composition-adjacency.js";
export {
  facetPathId,
  composedFacetPathId,
  facetBelongsToOutput,
  retainSamePathVectors,
  samePathAccepts,
  facetModeAccepts
} from "./path-composition-facet.js";

export function mergeTransitions(
  transitions: RetainedRows<Transition>,
  incoming: readonly Transition[] = []
): readonly Transition[] {
  if (incoming.length === 0) return uniqueByTransitionKey(transitions);
  const batch = uniqueByTransitionKey(incoming);
  const kept = transitions.filter((row) => !batch.some((next) =>
    row.instance_id !== undefined && next.instance_id === row.instance_id
    && row.revision_id !== undefined && next.revision_id !== undefined
    && next.revision_id !== row.revision_id && ruleIdentity(next) === ruleIdentity(row)
  ));
  return uniqueByTransitionKey([...kept, ...batch]);
}

function uniqueByTransitionKey(rows: RetainedRows<Transition>): readonly Transition[] {
  const unique = new Map<string, Transition>();
  for (const row of rows) {
    const key = transitionKey(row);
    if (!unique.has(key)) unique.set(key, row);
  }
  return Object.freeze([...unique.values()]);
}

export function ruleIdentity(transition: Transition): string {
  return [
    productStateNodeId(transition.from),
    productStateNodeId(transition.to),
    transition.relation_kind,
    transition.instance_id ?? ""
  ].join("\0");
}

export function transitionKey(transition: Transition): string {
  return [
    ruleIdentity(transition),
    String(transition.strength_milligrades),
    String(transition.applicable),
    transition.revision_id ?? "",
    JSON.stringify(transition.validity)
  ].join("\0");
}
