import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  memoryProductStateKey,
  productSubjectId,
  retargetMemoryProduct,
  sourceProductStateKey,
  type Derivation,
  type FacetMode,
  type FacetVector,
  type ProductStateKey,
  type QueryInterpretation,
  type QueryProgram,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { collectRelations, type QueryRelation } from "../query/compile-query.js";
import {
  STORED_RELATION_KIND,
  SUPPORTED_RELATION_ALIASES
} from "../query/ordinary-language.js";
import { interpretQuery } from "../reference/interpret-query.js";
import {
  evaluateFacetPredicate,
  type HyperedgePremise
} from "../reference/accepting-projection.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  UNBOUND_BINDING,
  decideGuards,
  encodeBindingContext,
  parseBindingContext,
  unifyBinding,
  type BoundSourceFacts
} from "./binding-environment.js";
import { leafDerivation } from "./path-derivation.js";
import {
  hyperedgeEffects,
  tryCompleteHyperedge,
  type HyperedgeCompletion,
  type HyperedgeEffect
} from "./path-hyperedge.js";
import {
  inactiveResolution,
  relationMatches,
  relationStrength,
  unifyAdvance,
  type AdjacencyRow,
  type NamedKindOverlay
} from "./path-matching.js";
import {
  ACCEPTING_PROGRAM_STATE,
  START_PROGRAM_STATE,
  advancesFor,
  compileProgramAutomaton,
  type ProgramAutomaton
} from "./program-automaton.js";

export type { HyperedgePremise, HyperedgeCompletion, AdjacencyRow, NamedKindOverlay };
export { ACCEPTING_PROGRAM_STATE, START_PROGRAM_STATE, tryCompleteHyperedge };

const DEFAULT_PROGRAM_STATE = ACCEPTING_PROGRAM_STATE;
const DEFAULT_HYPOTHESIS = "h0";
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
  defaults: Partial<Omit<ProductStateKey, "schema_version" | "target">> & {
    readonly workspace_id?: string;
    readonly object_id?: string;
    readonly source_revision?: string;
  } = {}
): ProductStateKey {
  const workspaceId = defaults.workspace_id ?? observation.workspace_id;
  if (workspaceId === undefined) {
    throw new Error("product state requires workspace_id");
  }
  const programState = defaults.program_state ?? DEFAULT_PROGRAM_STATE;
  const hypothesisId = defaults.hypothesis_id ?? DEFAULT_HYPOTHESIS;
  const bindingContext = defaults.binding_context ?? UNBOUND_BINDING;
  const timeState = defaults.time_state ?? DEFAULT_TIME_STATE;
  const target = observation.target;
  if (target !== undefined && target.kind === "source_evidence") {
    return sourceProductStateKey({
      workspace_id: workspaceId,
      root_kind: target.root_kind,
      root_id: target.root_id,
      source_version: defaults.source_revision ?? target.source_version,
      content_digest: target.content_digest,
      evidence_object_id: target.evidence_object_id,
      program_state: programState,
      hypothesis_id: hypothesisId,
      binding_context: bindingContext,
      time_state: timeState
    });
  }
  return memoryProductStateKey({
    workspace_id: workspaceId,
    object_id: defaults.object_id ?? observation.object_id,
    source_revision: defaults.source_revision ?? observation.source_revision,
    program_state: programState,
    hypothesis_id: hypothesisId,
    binding_context: bindingContext,
    time_state: timeState
  });
}

export function observationIsGuaranteed(observation: TypedObservation): boolean {
  return observation.applicability.verdict === "true";
}

export function seedFromObservation(
  observation: TypedObservation,
  state: ProductStateKey
): SeedActivation | undefined {
  if (observation.applicability.verdict === "false") return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: observation.association_milligrades ?? MILLIGRADE_TOP
  };
}

export function timeStateFor(
  interpretation: QueryInterpretation,
  asOf: string
): string {
  if (interpretation.time_window !== undefined) return interpretation.time_window.end;
  if (interpretation.interpretation_clock !== undefined) return interpretation.interpretation_clock;
  return asOf.length > 0 ? asOf : DEFAULT_TIME_STATE;
}

export function hypothesisIdsFor(interpretation: QueryInterpretation): readonly string[] {
  if (interpretation.hypotheses.length === 0) return [DEFAULT_HYPOTHESIS];
  return interpretation.hypotheses.map((row) => row.hypothesis_id);
}

export function runtimeProgram(program: QueryProgram): QueryProgram | "empty" | "epsilon" {
  const interpreted = interpretQuery(program);
  if (interpreted.kind === "empty") return "empty";
  if (interpreted.kind === "epsilon") return "epsilon";
  if (interpreted.kind === "unsupported") return "empty";
  return program;
}

export function seedProgramStates(program: QueryProgram): readonly string[] {
  const runtime = runtimeProgram(program);
  if (runtime === "empty") return [];
  if (runtime === "epsilon") return [ACCEPTING_PROGRAM_STATE];
  return compileProgramAutomaton(runtime).start;
}

export function seedActivationsForObservation(
  observation: TypedObservation,
  interpretation: QueryInterpretation,
  asOf: string
): readonly SeedActivation[] {
  if (observation.applicability.verdict === "false") return [];
  const runtime = runtimeProgram(interpretation.program);
  const automaton = runtime === "empty" || runtime === "epsilon"
    ? undefined
    : compileProgramAutomaton(runtime);
  const states = runtime === "empty"
    ? []
    : runtime === "epsilon"
      ? [ACCEPTING_PROGRAM_STATE]
      : automaton?.start ?? [];
  if (states.length === 0) return [];
  const timeState = timeStateFor(interpretation, asOf);
  const seeds: SeedActivation[] = [];
  for (const programState of states) {
    for (const hypothesis of seedHypotheses(interpretation)) {
      const binding = seedBindingContext(
        automaton,
        observation.object_id,
        hypothesis.bindings,
        programState
      );
      if (binding === undefined) continue;
      const seed = seedFromObservation(observation, productStateFromObservation(observation, {
        program_state: programState,
        hypothesis_id: hypothesis.hypothesis_id,
        binding_context: binding,
        time_state: timeState
      }));
      if (seed !== undefined) seeds.push(seed);
    }
  }
  return Object.freeze(seeds);
}

export type CompiledAdjacencyEffect = Readonly<{
  readonly observation_id: string;
  readonly transition?: Transition;
  readonly facet?: FacetVector;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
  readonly derivation?: Derivation;
  readonly derivations?: readonly Derivation[];
  readonly missing_measurement?: boolean;
  readonly unresolved_guard?: boolean;
}>;

export function programRelationKinds(program: QueryProgram): readonly string[] {
  const runtime = runtimeProgram(program);
  if (runtime === "empty" || runtime === "epsilon") return [];
  return collectRelations(runtime).map((relation) => relation.relation_kind);
}

export function adjacencyKindsFor(
  program: QueryProgram,
  listed: readonly string[] = [],
  routingKinds: readonly string[] = []
): readonly string[] {
  const kinds = programRelationKinds(program);
  const expanded = new Set<string>();
  let openVocabulary = false;
  for (const kind of kinds) {
    if (kind === STORED_RELATION_KIND) openVocabulary = true;
    const aliases = SUPPORTED_RELATION_ALIASES[kind];
    if (aliases === undefined || aliases.length === 0) expanded.add(kind);
    else {
      for (const alias of aliases) expanded.add(alias);
    }
  }
  if (openVocabulary) {
    for (const kind of listed) expanded.add(kind);
  }
  for (const kind of routingKinds) expanded.add(kind);
  return [...expanded];
}

export function adjacencyEffectsForRows(
  rows: readonly AdjacencyRow[],
  input: Readonly<{
    readonly interpretation: QueryInterpretation;
    readonly asOf: string;
    readonly liveStates: readonly ProductStateKey[];
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: readonly FacetVector[];
  }>
): readonly CompiledAdjacencyEffect[] {
  const runtime = runtimeProgram(input.interpretation.program);
  if (runtime === "empty" || runtime === "epsilon") return [];
  const automaton = compileProgramAutomaton(runtime);
  const effects: CompiledAdjacencyEffect[] = [];
  for (const from of input.liveStates) {
    for (const advance of automaton.hyperedgeAdvances) {
      if (advance.from !== from.program_state) continue;
      effects.push(...hyperedgeEffects(rows, advance.hyperedge, {
        liveStates: [from],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        toProgramStates: advance.to
      }).map(attachHyperedgeFacet));
    }
  }
  for (const row of rows) {
    if (row.validity === undefined) continue;
    if (inactiveResolution(row.resolutionKind)) continue;
    for (const from of input.liveStates) {
      if (productSubjectId(from) !== row.sourceObjectId) continue;
      effects.push(...effectsForLiveRow(automaton, row, from, input));
    }
  }
  return Object.freeze(effects);
}

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

function effectsForLiveRow(
  automaton: ProgramAutomaton,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: readonly FacetVector[];
  }>
): readonly CompiledAdjacencyEffect[] {
  const matched = advancesFor(automaton, from.program_state, (relation) =>
    relationMatches(relation.relation_kind, row.predicate)
  );
  if (matched.length === 0) {
    return routingEffect(row, from, input.overlay);
  }
  const effects: CompiledAdjacencyEffect[] = [];
  for (const advance of matched) {
    effects.push(...effectsForAdvance(automaton, advance, row, from, input));
  }
  return effects;
}

function effectsForAdvance(
  automaton: ProgramAutomaton,
  advance: Readonly<{ readonly relation: QueryRelation; readonly to: readonly string[] }>,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: readonly FacetVector[];
  }>
): readonly CompiledAdjacencyEffect[] {
  const unified = unifyAdvance(from, advance.relation, row);
  if (unified === undefined) return [];
  const decision = decideGuards(
    [advance.relation.guard],
    unified.env,
    input.sourceFacts ?? new Map(),
    { sourceId: row.sourceObjectId, targetId: row.targetObjectId }
  );
  if (decision === "false") return [];
  if (decision === "unresolved") return [{
    observation_id: `guard:${row.assertionId}:${from.program_state}`,
    unresolved_guard: true
  }];
  const strength = relationStrength(advance.relation, input.overlay, row.predicate);
  if (strength === undefined) {
    return [{
      observation_id: `adjacency:${row.assertionId}:${from.hypothesis_id}:${from.program_state}`,
      missing_measurement: true
    }];
  }
  if (strength.milligrades <= advance.relation.threshold_milligrades) return [];
  const applicable = strength.applicable && decision === "true";
  const toStates = applicable ? advance.to : [from.program_state];
  const effects: CompiledAdjacencyEffect[] = [];
  for (const programState of toStates) {
    const binding = alignOutgoingBinding(
      unified.binding,
      row.targetObjectId,
      automaton,
      programState
    );
    if (binding === undefined) continue;
    const to = retargetMemoryProduct(from, {
      object_id: row.targetObjectId,
      program_state: programState,
      binding_context: binding
    });
    effects.push(...compiledEffects({ ...row, source_revision: row.source_revision ?? input.sourceFacts?.get(row.sourceObjectId)?.source_revision },
      from, to, strength, applicable, decision, input.facets ?? []));
  }
  return effects;
}

function routingEffect(
  row: AdjacencyRow,
  from: ProductStateKey,
  overlay: NamedKindOverlay
): readonly CompiledAdjacencyEffect[] {
  const routing = overlay[row.predicate];
  if (routing === undefined || routing.role !== "routing_only" || !routing.applicable) {
    return [];
  }
  return compiledEffects(row, from, retargetMemoryProduct(from, { object_id: row.targetObjectId }), routing, true, "true", []);
}

function compiledEffects(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: Readonly<{ readonly milligrades: number; readonly applicable: boolean }>,
  applicable: boolean,
  decision: "true" | "unresolved",
  priorFacets: readonly FacetVector[]
): readonly CompiledAdjacencyEffect[] {
  if (row.validity === undefined) return [];
  const transition: Transition = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: row.predicate,
    strength_milligrades: strength.milligrades,
    validity: row.validity,
    applicable
  };
  const vectors = extendFacets(priorFacets, from, to, row.predicate, strength.milligrades);
  const derivation = leafDerivation({
    derivation_id: `leaf:${row.assertionId}:${from.program_state}:${to.program_state}`,
    observation_id: row.assertionId,
    leaf_id: row.assertionId,
    association_milligrades: strength.milligrades,
    source_revision: row.source_revision
  });
  return vectors.map((facet, index) => ({
    observation_id: `adjacency:${row.assertionId}:${from.program_state}:${to.program_state}:${String(index)}`,
    transition,
    facet,
    derivation,
    derivations: [derivation],
    unresolved_guard: decision === "unresolved"
  }));
}

function extendFacets(
  priorFacets: readonly FacetVector[],
  from: ProductStateKey,
  to: ProductStateKey,
  route: string,
  milligrades: number
): readonly FacetVector[] {
  const inherited = priorFacets.filter((vector) => facetBelongsToOutput(vector.path_id, from));
  if (inherited.length === 0) {
    return [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(to, route),
      coordinates: [milligrades]
    }];
  }
  return inherited.map((vector) => ({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    path_id: composedFacetPathId(to, extendRoute(vector.path_id, from, route)),
    coordinates: [...vector.coordinates, milligrades]
  }));
}

function extendRoute(priorPathId: string, from: ProductStateKey, route: string): string {
  const identity = facetPathId(from);
  const prior = priorPathId.startsWith(`${identity}:`)
    ? priorPathId.slice(identity.length + 1)
    : route;
  return `${prior}+${route}`;
}

function seedHypotheses(interpretation: QueryInterpretation): readonly {
  readonly hypothesis_id: string;
  readonly bindings: QueryInterpretation["hypotheses"][number]["bindings"] | undefined;
}[] {
  if (interpretation.hypotheses.length === 0) {
    return [{ hypothesis_id: DEFAULT_HYPOTHESIS, bindings: undefined }];
  }
  return interpretation.hypotheses;
}

function seedBindingContext(
  automaton: ProgramAutomaton | undefined,
  objectId: string,
  hypothesisBindings: QueryInterpretation["hypotheses"][number]["bindings"] | undefined,
  programState: string
): string | undefined {
  const envSeed = new Map<string, string>();
  for (const binding of hypothesisBindings ?? []) envSeed.set(binding.variable, binding.value);
  let env = envSeed;
  for (const variable of automaton?.sourceVariables.get(programState) ?? []) {
    const next = unifyBinding(env, variable, objectId);
    if (next === undefined) return undefined;
    env = next;
  }
  return encodeBindingContext(env);
}

function alignOutgoingBinding(
  binding: string,
  objectId: string,
  automaton: ProgramAutomaton,
  programState: string
): string | undefined {
  let env = parseBindingContext(binding);
  env = new Map(env);
  for (const variable of automaton.localVariables.get(programState) ?? []) env.delete(variable);
  for (const advance of automaton.advances) {
    if (advance.from !== programState) continue;
    const sourceVar = advance.relation.source_variable;
    const bound = env.get(sourceVar);
    if (bound !== undefined && bound !== objectId) {
      return undefined;
    }
    const next = unifyBinding(env, sourceVar, objectId);
    if (next === undefined) return undefined;
    env = next;
  }
  return encodeBindingContext(env);
}

function attachHyperedgeFacet(effect: HyperedgeEffect): CompiledAdjacencyEffect {
  return {
    observation_id: effect.observation_id,
    hyperedge_premises: effect.hyperedge_premises,
    hyperedge: effect.hyperedge,
    derivation: effect.derivation,
    derivations: effect.derivations,
    facet: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(effect.hyperedge.to, effect.hyperedge.relation_kind),
      coordinates: [effect.hyperedge.strength_milligrades]
    }
  };
}
