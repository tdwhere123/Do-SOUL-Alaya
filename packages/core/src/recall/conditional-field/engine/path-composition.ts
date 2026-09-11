import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ASSOCIATION_DOMAIN_ID,
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
import {
  identitySeedGrade,
  isHardIdentityContractId
} from "../cap-contract.js";
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
  hyperedgeEffectSteps,
  tryCompleteHyperedge,
  type HyperedgeCompletion,
  type HyperedgeEffect
} from "./path-hyperedge.js";
import { PathEffectCursor, type PathComputation } from "./path-effect-cursor.js";
import type { RetainedRows } from "./retained-sequence.js";
import {
  inactiveResolution,
  observedTargetRevision,
  relationMatches,
  relationStrength,
  unifyAdvance,
  type AdjacencyRow,
  type AdmittedRelationStrength,
  type NamedKindOverlay
} from "./path-matching.js";
import {
  routingDiscoveryEffect,
  type RoutingDiscovery
} from "./path-routing.js";
import {
  ACCEPTING_PROGRAM_STATE,
  START_PROGRAM_STATE,
  advancesFor,
  compileProgramAutomaton,
  type ProgramAutomaton
} from "./program-automaton.js";

export type { HyperedgePremise, HyperedgeCompletion, AdjacencyRow, NamedKindOverlay };
export { ACCEPTING_PROGRAM_STATE, START_PROGRAM_STATE, tryCompleteHyperedge };
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

export function queryAdmitsGuaranteedSeed(interpretation: QueryInterpretation): boolean {
  return runtimeProgram(interpretation.program) !== "empty";
}

export function seedFromObservation(
  observation: TypedObservation,
  state: ProductStateKey
): SeedActivation | undefined {
  if (observation.applicability.verdict !== "true") return undefined;
  if (observation.association_milligrades === undefined) return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: observation.association_milligrades
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
  if (observation.applicability.verdict !== "true") return [];
  if (!queryAdmitsGuaranteedSeed(interpretation)) return [];
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
      const state = productStateFromObservation(observation, {
        program_state: programState,
        hypothesis_id: hypothesis.hypothesis_id,
        binding_context: binding,
        time_state: timeState
      });
      const seed = observation.association_milligrades === undefined
        ? identitySeedGrade(state)
        : seedFromObservation(observation, state);
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
  readonly missing_target_revision?: boolean;
  readonly discovery?: RoutingDiscovery;
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
  rows: Iterable<AdjacencyRow>,
  input: AdjacencyEffectsInput
): readonly CompiledAdjacencyEffect[] {
  const effects: CompiledAdjacencyEffect[] = [];
  for (const step of adjacencyEffectSteps(rows, input)) if (step.kind === "effect") effects.push(step.effect);
  return effects;
}

export type AdjacencyEffectsInput = Readonly<{
    readonly interpretation: QueryInterpretation;
    readonly asOf: string;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly liveStateOffset?: number;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly discoveries?: RetainedRows<RoutingDiscovery>;
  }>;

export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathEffectCursor;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit: number): PathEffectCursor | undefined;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit = Number.MAX_SAFE_INTEGER): PathEffectCursor | undefined {
  const initialBytes = 8192 + 256;
  if (initialBytes > memoryLimit) return undefined;
  // A pending computation owns this immutable input version. Producers replace
  // versions; retaining their references needs no eager element traversal.
  return new PathEffectCursor(adjacencyEffectSteps(rows, input), initialBytes);
}

function* adjacencyEffectSteps(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathComputation<void> {
  const runtime = runtimeProgram(input.interpretation.program);
  if (runtime === "empty" || runtime === "epsilon") return;
  yield { kind: "work", retained_bytes: 1024 + Buffer.byteLength(JSON.stringify(runtime), "utf8") * 8 };
  const automaton = compileProgramAutomaton(runtime);
  for (let index = input.liveStateOffset ?? 0; index < input.liveStates.length; index += 1) {
    yield { kind: "work", retained_bytes: 64 };
    const from = input.liveStates.at(index)!;
    for (const advance of automaton.hyperedgeAdvances) {
      if (advance.from !== from.program_state) continue;
      for (const step of hyperedgeEffectSteps(rows, advance.hyperedge, {
        query_id: input.interpretation.query_id,
        liveStates: [from],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        toProgramStates: advance.to,
        observedStates: input.liveStates
      })) yield step.kind === "work" ? step : { kind: "effect", effect: attachHyperedgeFacet(step.effect) };
    }
  }
  for (const row of rows) {
    if (row.validity === undefined) continue;
    if (inactiveResolution(row.resolutionKind)) continue;
    for (let index = input.liveStateOffset ?? 0; index < input.liveStates.length; index += 1) {
      yield { kind: "work" };
      const from = input.liveStates.at(index)!;
      if (productSubjectId(from) !== row.sourceObjectId) continue;
      yield* effectsForLiveRow(automaton, row, from, {
        query_id: input.interpretation.query_id,
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        facets: input.facets,
        liveStates: input.liveStates
      });
    }
  }
  const origins = new Set<string>();
  for (const state of input.liveStates) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(productSubjectId(state));
  }
  for (const discovery of input.discoveries ?? []) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(discovery.subject_id);
  }
  const emitted = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      yield { kind: "work", retained_bytes: 128 };
      if (row.validity === undefined || inactiveResolution(row.resolutionKind)
        || !origins.has(row.sourceObjectId) || emitted.has(row.assertionId)) continue;
      for (const effect of routingDiscoveryEffect(row, input.overlay)) {
        emitted.add(row.assertionId);
        if (!origins.has(effect.discovery.subject_id)) { origins.add(effect.discovery.subject_id); grew = true; }
        yield { kind: "effect", effect };
      }
    }
  }
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
    if (prior === undefined) {
      best.set(nodeId, seed);
      continue;
    }
    if ((prior.cap_contract_id ?? "") === (seed.cap_contract_id ?? "")) {
      if (seed.milligrades > prior.milligrades) best.set(nodeId, seed);
      continue;
    }
    if (isHardIdentityContractId(prior.cap_contract_id) && !isHardIdentityContractId(seed.cap_contract_id)) {
      best.set(nodeId, seed);
    }
  }
  return Object.freeze(sortSeeds([...best.values()]));
}

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

function* effectsForLiveRow(
  automaton: ProgramAutomaton,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly liveStates: RetainedRows<ProductStateKey>;
  }>
): PathComputation<void> {
  if (from.target.kind !== "memory_entry") {
    // Terminal evidence product: never retarget into a memory Transition.
    for (const effect of routingDiscoveryEffect(row, input.overlay)) yield { kind: "effect", effect };
    return;
  }
  const matched = advancesFor(automaton, from.program_state, (relation) =>
    relationMatches(relation.relation_kind, row.predicate)
  );
  if (matched.length === 0) {
    // Overlay routing_only nominates physical work. Copying program_state
    // would mint an unadmitted product.
    for (const effect of routingDiscoveryEffect(row, input.overlay)) yield { kind: "effect", effect };
    return;
  }
  for (const advance of matched) {
    yield { kind: "work" };
    yield* effectsForAdvance(automaton, advance, row, from, input);
  }
}

function* effectsForAdvance(
  automaton: ProgramAutomaton,
  advance: Readonly<{ readonly relation: QueryRelation; readonly to: readonly string[] }>,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    readonly liveStates: RetainedRows<ProductStateKey>;
  }>
): PathComputation<void> {
  const declared = input.overlay[row.predicate] ?? input.overlay[advance.relation.relation_kind];
  if (declared?.applicable === false) return;
  const unified = unifyAdvance(from, advance.relation, row);
  if (unified === undefined) return;
  const decision = decideGuards(
    [advance.relation.guard],
    unified.env,
    input.sourceFacts ?? new Map(),
    { sourceId: row.sourceObjectId, targetId: row.targetObjectId }
  );
  if (decision === "false") return;
  if (decision === "unresolved") { yield { kind: "effect", effect: {
    observation_id: `guard:${row.assertionId}:${from.program_state}`,
    unresolved_guard: true
  } }; return; }
  const targetRevision = observedTargetRevision(
    row.targetObjectId,
    input.sourceFacts,
    input.liveStates
  );
  if (targetRevision === undefined) {
    yield { kind: "effect", effect: {
      observation_id: `revision:${row.assertionId}:${from.program_state}`,
      unresolved_guard: true,
      missing_target_revision: true
    } }; return;
  }
  const revisionId = relationRevisionId(row, from, input.sourceFacts);
  const strength = relationStrength(advance.relation, input.overlay, row.predicate, {
    query_id: input.query_id,
    instance_id: row.assertionId,
    revision_id: revisionId,
    hypothesis_id: from.hypothesis_id,
    binding: unified.binding,
    time_state: from.time_state
  });
  if (strength === undefined) {
    yield { kind: "effect", effect: {
      observation_id: `adjacency:${row.assertionId}:${from.hypothesis_id}:${from.program_state}`,
      missing_measurement: true
    } }; return;
  }
  if (strength.milligrades <= advance.relation.threshold_milligrades) return;
  for (const programState of advance.to) {
    yield { kind: "work" };
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
      binding_context: binding,
      source_revision: targetRevision
    });
    yield* compiledEffects({ ...row, source_revision: revisionId },
      from, to, strength, decision, input.facets ?? []);
  }
}

function relationRevisionId(
  row: AdjacencyRow,
  from: ProductStateKey,
  sourceFacts: ReadonlyMap<string, BoundSourceFacts> | undefined
): string | undefined {
  if (row.source_revision !== undefined && row.source_revision.length > 0) return row.source_revision;
  const fact = sourceFacts?.get(row.sourceObjectId)?.source_revision;
  if (fact !== undefined && fact.length > 0) return fact;
  return from.target.kind === "memory_entry" ? from.target.source_revision : undefined;
}

function* compiledEffects(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: AdmittedRelationStrength,
  decision: "true" | "unresolved",
  priorFacets: RetainedRows<FacetVector>
): PathComputation<void> {
  if (row.validity === undefined) return;
  const transition: Transition = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from,
    to,
    relation_kind: row.predicate,
    instance_id: strength.instance_id,
    revision_id: strength.revision_id,
    transfer_id: strength.transfer_id,
    transfer_version: strength.transfer_version,
    strength_milligrades: strength.milligrades,
    validity: row.validity,
    applicable: true,
    cap_contract_id: strength.cap_contract_id
  };
  const vectors = yield* extendFacets(priorFacets, from, to, `${from.program_state}:${to.program_state}:${row.predicate}`, strength.milligrades);
  const derivation = leafDerivation({
    derivation_id: `leaf:${row.assertionId}:${from.program_state}:${to.program_state}`,
    observation_id: row.assertionId,
    leaf_id: row.assertionId,
    association_milligrades: strength.milligrades,
    source_revision: row.source_revision
  });
  for (const [index, facet] of vectors.entries()) {
    yield { kind: "work", retained_bytes: 512 + Buffer.byteLength(JSON.stringify({ transition, derivation, facet }), "utf8") };
    yield { kind: "effect", effect: {
    observation_id: `adjacency:${row.assertionId}:${from.program_state}:${to.program_state}:${String(index)}`,
    transition,
    facet,
    derivation,
    derivations: [derivation],
    unresolved_guard: decision === "unresolved"
    } };
  }
}

function* extendFacets(
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
  if (effect.unresolved_guard === true || effect.hyperedge === undefined) {
    return {
      observation_id: effect.observation_id,
      unresolved_guard: true,
      ...(effect.missing_target_revision === true ? { missing_target_revision: true } : {})
    };
  }
  return {
    observation_id: effect.observation_id,
    hyperedge_premises: effect.hyperedge_premises,
    hyperedge: effect.hyperedge,
    derivation: effect.derivation,
    derivations: effect.derivations,
    facet: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(effect.hyperedge.to, effect.hyperedge.relation_kind),
      obligations: [{ obligation_id: createHash("sha256").update(`${effect.hyperedge.from.program_state}:${effect.hyperedge.to.program_state}`).digest("hex"),
        domain_id: ASSOCIATION_DOMAIN_ID }],
      coordinates: [effect.hyperedge.strength_milligrades]
    }
  };
}
