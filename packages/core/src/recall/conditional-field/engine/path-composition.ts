import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
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
import {
  collectRelations,
  type QueryRelation
} from "../query/compile-query.js";
import {
  STORED_RELATION_KIND,
  SUPPORTED_RELATION_ALIASES
} from "../query/ordinary-language.js";
import { interpretQuery } from "../reference/interpret-query.js";
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

export const ACCEPTING_PROGRAM_STATE = "accepting";
export const START_PROGRAM_STATE = "start";
const DEFAULT_PROGRAM_STATE = ACCEPTING_PROGRAM_STATE;
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
  return interpreted.program;
}

export function seedProgramStates(program: QueryProgram): readonly string[] {
  const runtime = runtimeProgram(program);
  if (runtime === "empty") return [];
  if (runtime === "epsilon") return [ACCEPTING_PROGRAM_STATE];
  return seedStatesFor(runtime);
}

export function seedActivationsForObservation(
  observation: TypedObservation,
  interpretation: QueryInterpretation,
  asOf: string
): readonly SeedActivation[] {
  if (observation.applicability.verdict === "false") return [];
  const states = seedProgramStates(interpretation.program);
  if (states.length === 0) return [];
  const timeState = timeStateFor(interpretation, asOf);
  const seeds: SeedActivation[] = [];
  for (const programState of states) {
    for (const hypothesisId of hypothesisIdsFor(interpretation)) {
      const seed = seedFromObservation(observation, {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        object_id: observation.object_id,
        program_state: programState,
        hypothesis_id: hypothesisId,
        binding_context: DEFAULT_BINDING,
        time_state: timeState
      });
      if (seed !== undefined) seeds.push(seed);
    }
  }
  return Object.freeze(seeds);
}

export type AdjacencyRow = Readonly<{
  readonly assertionId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly predicate: string;
  readonly validity?: Transition["validity"];
  readonly resolutionKind?: string | null;
}>;

export type NamedKindOverlay = Readonly<Record<string, Readonly<{
  readonly milligrades: number;
  readonly applicable: boolean;
  readonly role?: string;
}>>>;

export type CompiledAdjacencyEffect = Readonly<{
  readonly observation_id: string;
  readonly transition?: Transition;
  readonly facet?: FacetVector;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
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
  }>
): readonly CompiledAdjacencyEffect[] {
  const runtime = runtimeProgram(input.interpretation.program);
  if (runtime === "empty" || runtime === "epsilon") return [];
  if (runtime.kind === "hyperedge") {
    return hyperedgeEffects(rows, runtime, input);
  }
  const effects: CompiledAdjacencyEffect[] = [];
  for (const row of rows) {
    if (row.validity === undefined) continue;
    if (inactiveResolution(row.resolutionKind)) continue;
    for (const from of input.liveStates) {
      if (from.object_id !== row.sourceObjectId) continue;
      const effect = effectForLiveRow(runtime, row, from, input.overlay);
      if (effect !== undefined) effects.push(effect);
    }
  }
  return Object.freeze(effects);
}

export function facetPathId(state: ProductStateKey): string {
  const packed = `${state.object_id}:${state.hypothesis_id}:${state.binding_context}`;
  return packed.length <= 256 ? packed : packed.slice(0, 256);
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

function seedStatesFor(program: QueryProgram): readonly string[] {
  switch (program.kind) {
    case "epsilon":
      return [ACCEPTING_PROGRAM_STATE];
    case "empty":
      return [];
    case "relation":
      return [START_PROGRAM_STATE];
    case "sequence":
      return ["seq.0"];
    case "alternative": {
      const states: string[] = [];
      for (const [index, option] of program.options.entries()) {
        for (const inner of seedStatesFor(option)) {
          states.push(inner === ACCEPTING_PROGRAM_STATE ? ACCEPTING_PROGRAM_STATE : `alt.${String(index)}`);
        }
      }
      return states;
    }
    case "hyperedge":
      return [START_PROGRAM_STATE];
    case "repeat":
    case "closure":
      return seedStatesFor(program.body);
  }
}

function effectForLiveRow(
  runtime: QueryProgram,
  row: AdjacencyRow,
  from: ProductStateKey,
  overlay: NamedKindOverlay
): CompiledAdjacencyEffect | undefined {
  const matched = matchAdvance(runtime, from.program_state, row.predicate);
  if (matched !== undefined) {
    const strength = overlay[row.predicate] ?? relationStrength(matched.relation, overlay);
    if (strength === undefined) return undefined;
    const applicable = matched.applicable && strength.applicable && matched.relation.guard.verdict !== "false";
    return compiledEffect(row, from, {
      ...from,
      object_id: row.targetObjectId,
      program_state: applicable ? matched.toProgramState : from.program_state
    }, strength, applicable);
  }
  const routing = overlay[row.predicate];
  if (routing === undefined || routing.role !== "routing_only" || !routing.applicable) {
    return undefined;
  }
  return compiledEffect(row, from, {
    ...from,
    object_id: row.targetObjectId
  }, routing, true);
}

function compiledEffect(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: Readonly<{ readonly milligrades: number; readonly applicable: boolean }>,
  applicable: boolean
): CompiledAdjacencyEffect | undefined {
  if (row.validity === undefined) return undefined;
  return {
    observation_id: `adjacency:${row.assertionId}:${from.hypothesis_id}:${from.program_state}`,
    transition: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      from,
      to,
      relation_kind: row.predicate,
      strength_milligrades: strength.milligrades,
      validity: row.validity,
      applicable
    },
    facet: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: facetPathId(to),
      coordinates: [strength.milligrades]
    }
  };
}

type AdvanceMatch = Readonly<{
  readonly toProgramState: string;
  readonly relation: QueryRelation;
  readonly applicable: boolean;
}>;

function matchAdvance(
  program: QueryProgram,
  fromState: string,
  relationKind: string
): AdvanceMatch | undefined {
  switch (program.kind) {
    case "relation": {
      if (fromState !== START_PROGRAM_STATE) return undefined;
      if (!relationMatches(program.relation_kind, relationKind)) return undefined;
      return {
        toProgramState: ACCEPTING_PROGRAM_STATE,
        relation: program,
        applicable: program.guard.verdict !== "false"
      };
    }
    case "sequence": {
      const index = sequenceIndex(fromState);
      if (index === undefined || index >= program.steps.length) return undefined;
      const step = program.steps[index];
      if (step === undefined) return undefined;
      const innerFrom = step.kind === "alternative" || step.kind === "sequence" ? fromState : stepStart(step);
      const inner = matchAdvance(step, innerFrom, relationKind);
      if (inner === undefined) return undefined;
      if (!inner.applicable) {
        return { ...inner, toProgramState: fromState };
      }
      const completed = inner.toProgramState === ACCEPTING_PROGRAM_STATE;
      if (!completed) return inner;
      const last = index === program.steps.length - 1;
      return {
        ...inner,
        toProgramState: last ? ACCEPTING_PROGRAM_STATE : `seq.${String(index + 1)}`
      };
    }
    case "alternative": {
      const optionIndex = alternativeIndex(fromState);
      if (optionIndex !== undefined) {
        const option = program.options[optionIndex];
        if (option === undefined) return undefined;
        const inner = matchAdvance(option, stepStart(option), relationKind);
        if (inner === undefined) return undefined;
        if (!inner.applicable) return { ...inner, toProgramState: fromState };
        return inner.toProgramState === ACCEPTING_PROGRAM_STATE
          ? { ...inner, toProgramState: ACCEPTING_PROGRAM_STATE }
          : inner;
      }
      if (fromState.startsWith("seq.")) {
        for (const option of program.options) {
          const inner = matchAdvance(option, stepStart(option), relationKind);
          if (inner !== undefined) {
            if (!inner.applicable) return { ...inner, toProgramState: fromState };
            return inner.toProgramState === ACCEPTING_PROGRAM_STATE
              ? { ...inner, toProgramState: ACCEPTING_PROGRAM_STATE }
              : inner;
          }
        }
      }
      return undefined;
    }
    case "repeat":
    case "closure":
      return matchAdvance(program.body, fromState, relationKind);
    default:
      return undefined;
  }
}

function relationMatches(programKind: string, storedPredicate: string): boolean {
  if (programKind === storedPredicate) return true;
  if (programKind === STORED_RELATION_KIND) return false;
  return (SUPPORTED_RELATION_ALIASES[programKind] ?? []).includes(storedPredicate);
}

function stepStart(program: QueryProgram): string {
  if (program.kind === "relation") return START_PROGRAM_STATE;
  if (program.kind === "sequence") return "seq.0";
  if (program.kind === "alternative") return "alt.0";
  if (program.kind === "epsilon") return ACCEPTING_PROGRAM_STATE;
  return START_PROGRAM_STATE;
}

function sequenceIndex(state: string): number | undefined {
  if (state === START_PROGRAM_STATE) return 0;
  const matched = /^seq\.(\d+)$/u.exec(state);
  return matched === null ? undefined : Number(matched[1]);
}

function alternativeIndex(state: string): number | undefined {
  const matched = /^alt\.(\d+)$/u.exec(state);
  return matched === null ? undefined : Number(matched[1]);
}

function relationStrength(
  relation: QueryRelation,
  overlay: NamedKindOverlay
): Readonly<{ readonly milligrades: number; readonly applicable: boolean }> | undefined {
  const named = overlay[relation.relation_kind];
  if (named !== undefined) return named;
  if (relation.threshold_milligrades > 0) {
    return { milligrades: relation.threshold_milligrades, applicable: true };
  }
  return { milligrades: MILLIGRADE_TOP, applicable: true };
}

function inactiveResolution(kind: string | null | undefined): boolean {
  return kind === "retracted" || kind === "expired" || kind === "contradicted";
}

function hyperedgeEffects(
  rows: readonly AdjacencyRow[],
  program: Extract<QueryProgram, { readonly kind: "hyperedge" }>,
  input: Readonly<{
    readonly interpretation: QueryInterpretation;
    readonly asOf: string;
    readonly liveStates: readonly ProductStateKey[];
    readonly overlay: NamedKindOverlay;
  }>
): readonly CompiledAdjacencyEffect[] {
  const premises = program.premises;
  const kinds = premises.flatMap((premise) => collectRelations(premise).map((row) => row.relation_kind));
  const effects: CompiledAdjacencyEffect[] = [];
  for (const from of input.liveStates) {
    if (from.program_state !== START_PROGRAM_STATE) continue;
    const present = kinds.map((kind) => rows.some((row) =>
      row.predicate === kind
      && row.sourceObjectId === from.object_id
      && row.validity !== undefined
      && !inactiveResolution(row.resolutionKind)
    ));
    const hyperedgePremises = present.map((isPresent) => ({
      hypothesis_id: from.hypothesis_id,
      binding_context: from.binding_context,
      time_state: from.time_state,
      present: isPresent
    }));
    const firstKind = kinds[0] ?? program.join;
    const overlay = input.overlay[firstKind];
    const milligrades = overlay?.milligrades ?? MILLIGRADE_TOP;
    const matching = rows.find((row) => row.predicate === firstKind && row.sourceObjectId === from.object_id);
    const targetId = matching?.targetObjectId ?? from.object_id;
    const validity = matching?.validity;
    if (validity === undefined) continue;
    const to: ProductStateKey = {
      ...from,
      object_id: targetId,
      program_state: ACCEPTING_PROGRAM_STATE
    };
    effects.push({
      observation_id: `hyperedge:${from.object_id}:${from.hypothesis_id}`,
      hyperedge_premises: hyperedgePremises,
      hyperedge: {
        from,
        to,
        relation_kind: firstKind,
        strength_milligrades: milligrades,
        validity
      }
    });
  }
  return Object.freeze(effects);
}
