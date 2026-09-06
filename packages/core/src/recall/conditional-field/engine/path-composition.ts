import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type FacetMode,
  type FacetVector,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import {
  evaluateFacetPredicate,
  joinHyperedgeAnd,
  type HyperedgePremise
} from "../reference/accepting-projection.js";
import { productStateNodeId } from "../reference/bind-max-min.js";

export type { HyperedgePremise };

export type HyperedgeCompletion = Readonly<{
  readonly from: ProductStateKey;
  readonly to: ProductStateKey;
  readonly relation_kind: string;
  readonly strength_milligrades: number;
  readonly validity: Transition["validity"];
}>;

const DEFAULT_PROGRAM_STATE = "accepting";
const DEFAULT_HYPOTHESIS = "h0";
const DEFAULT_BINDING = "default";
const DEFAULT_TIME_STATE = "as_of";

export function serialMin(grades: readonly number[]): number {
  if (grades.length === 0) return MILLIGRADE_BOTTOM;
  let grade = MILLIGRADE_TOP;
  for (const value of grades) {
    if (value < grade) grade = value;
  }
  return grade;
}

export function alternativeMax(grades: readonly number[]): number {
  if (grades.length === 0) return MILLIGRADE_BOTTOM;
  let grade = MILLIGRADE_BOTTOM;
  for (const value of grades) {
    if (value > grade) grade = value;
  }
  return grade;
}

export function productStateFromObservation(
  observation: TypedObservation,
  defaults: Partial<Omit<ProductStateKey, "schema_version" | "object_id">> = {}
): ProductStateKey {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: observation.object_id,
    program_state: defaults.program_state ?? DEFAULT_PROGRAM_STATE,
    hypothesis_id: defaults.hypothesis_id ?? DEFAULT_HYPOTHESIS,
    binding_context: defaults.binding_context ?? DEFAULT_BINDING,
    time_state: defaults.time_state ?? DEFAULT_TIME_STATE
  };
}

export function observationIsGuaranteed(observation: TypedObservation): boolean {
  return observation.applicability.verdict === "true";
}

export function seedFromObservation(
  observation: TypedObservation,
  state: ProductStateKey
): SeedActivation | undefined {
  if (observation.applicability.verdict === "false") return undefined;
  if (observation.association_milligrades === undefined) return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: observation.association_milligrades
  };
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

export function tryCompleteHyperedge(
  premises: readonly HyperedgePremise[],
  completion: HyperedgeCompletion
): Transition | undefined {
  if (!joinHyperedgeAnd(premises)) return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from: completion.from,
    to: completion.to,
    relation_kind: completion.relation_kind,
    strength_milligrades: completion.strength_milligrades,
    validity: completion.validity,
    applicable: true
  };
}

export function mergeSeeds(seeds: readonly SeedActivation[]): readonly SeedActivation[] {
  const best = new Map<string, SeedActivation>();
  for (const seed of seeds) {
    const nodeId = productStateNodeId(seed.state);
    const prior = best.get(nodeId);
    if (prior === undefined || seed.milligrades > prior.milligrades) best.set(nodeId, seed);
  }
  return Object.freeze(sortSeeds([...best.values()]));
}

export function mergeTransitions(
  transitions: readonly Transition[]
): readonly Transition[] {
  const unique = new Map<string, Transition>();
  for (const transition of transitions) {
    const key = transitionKey(transition);
    if (!unique.has(key)) unique.set(key, transition);
  }
  return Object.freeze([...unique.values()]);
}

export function collectIdentities(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[],
  prior: readonly ProductStateKey[] = []
): readonly ProductStateKey[] {
  const keys = new Map<string, ProductStateKey>();
  for (const state of prior) keys.set(productStateNodeId(state), state);
  for (const seed of seeds) keys.set(productStateNodeId(seed.state), seed.state);
  for (const transition of transitions) {
    keys.set(productStateNodeId(transition.from), transition.from);
    keys.set(productStateNodeId(transition.to), transition.to);
  }
  return Object.freeze(sortStates([...keys.values()]));
}

export function transitionKey(transition: Transition): string {
  return [
    productStateNodeId(transition.from),
    productStateNodeId(transition.to),
    transition.relation_kind,
    String(transition.strength_milligrades),
    String(transition.applicable)
  ].join("\0");
}

function sortSeeds(seeds: readonly SeedActivation[]): SeedActivation[] {
  return [...seeds].sort((left, right) =>
    compareText(productStateNodeId(left.state), productStateNodeId(right.state))
  );
}

function sortStates(states: readonly ProductStateKey[]): ProductStateKey[] {
  return [...states].sort((left, right) =>
    compareText(productStateNodeId(left), productStateNodeId(right))
  );
}
