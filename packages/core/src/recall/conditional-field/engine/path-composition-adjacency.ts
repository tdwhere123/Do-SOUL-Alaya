import { createHash } from "node:crypto";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  productEndpointId,
  type Derivation,
  type FacetVector,
  type ProductStateKey,
  type QueryInterpretation,
  type QueryProgram,
  type Transition
} from "@do-soul/alaya-protocol";
import type { HyperedgePremise } from "../reference/accepting-projection.js";
import { collectRelations, type QueryRelation } from "../query/compile-query.js";
import { STORED_RELATION_KIND } from "../query/ordinary-language.js";
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
  type BindingContextStore,
  type BoundSourceFacts
} from "./binding-environment.js";
import {
  inactiveResolution,
  relationMatches,
  relationPhysicalCandidates,
  admitRelationRow,
  type AdjacencyRow,
  type AdmittedRelationStrength,
  type NamedKindOverlay
} from "./path-matching.js";
import {
  pairDemandRegistered,
  routingDiscoveryEffect,
  type RegisteredDemands,
  type RoutingDiscovery
} from "./path-routing.js";
import {
  advancesFor,
  compileProgramAutomaton,
  type ProgramAutomaton
} from "./program-automaton.js";
import { advanceProducts, relationTransition } from "./local-advance.js";
import { runtimeProgram } from "./path-composition-seed.js";
import { composedFacetPathId, extendFacets, PathFacetLookup, type FacetIdentityIndex } from "./path-composition-facet.js";
import { claimEvidenceDemandForState } from "../index/claim-obligation.js";
import type { StateEndpointIndex } from "./state-endpoint-index.js";

export type { HyperedgePremise, HyperedgeCompletion, AdjacencyRow, NamedKindOverlay };
export { tryCompleteHyperedge };

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
  readonly relation_demand?: Readonly<{ readonly subject: string; readonly predicate: string }>;
  readonly source_fact_demand?: string;
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
    for (const candidate of relationPhysicalCandidates(kind)) expanded.add(candidate);
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
    readonly bindingContexts?: BindingContextStore;
    readonly interpretation: QueryInterpretation;
    readonly asOf: string;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly liveStateOffset?: number;
    // Present only for a row delta. Absence means the retained population.
    readonly joinRows?: readonly AdjacencyRow[];
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facets?: RetainedRows<FacetVector>;
    /** Identity index of exactly `facets`; absent callers build one per generator. */
    readonly facetIndex?: FacetIdentityIndex;
    readonly discoveries?: RetainedRows<RoutingDiscovery>;
    readonly physicalKinds?: readonly string[];
    /** Registry snapshot at cursor creation; registered demands are not emitted again, undefined suppresses nothing. */
    readonly registeredDemands?: RegisteredDemands;
    /** Exact completed row-delta population; its state and routing demands are already registered. */
    readonly settledStateEndpoints?: StateEndpointIndex;
    readonly compiledAutomaton?: ProgramAutomaton;
    /** Branch frontier. Absent callers keep writing the shared automaton. */
    readonly sequenceReachOwner?: object;
    readonly compiledPremises?: Map<QueryProgram, ProgramAutomaton>;
  }>;

export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathEffectCursor;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit: number): PathEffectCursor | undefined;
export function createAdjacencyEffectCursor(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput, memoryLimit = Number.MAX_SAFE_INTEGER): PathEffectCursor | undefined {
  const initialBytes = 8192 + 256 + joinRowTableBytes(input.joinRows);
  if (initialBytes > memoryLimit) return undefined;
  // A pending computation owns this immutable input version. Producers replace
  // versions; retaining their references needs no eager element traversal.
  const bindingContexts = input.bindingContexts?.fork(memoryLimit - initialBytes);
  return new PathEffectCursor(() => adjacencyEffectSteps(rows, { ...input, bindingContexts }), initialBytes, bindingContexts);
}

function claimDemandRegistered(
  registered: RegisteredDemands | undefined,
  claim: Readonly<{ subject: string; predicate: string }>
): boolean {
  return pairDemandRegistered(registered, claim.subject, claim.predicate) && registered?.sources.has(claim.subject) === true;
}

function joinRowTableBytes(rows: readonly AdjacencyRow[] | undefined): number {
  if (rows === undefined) return 0;
  // Pointer table only; row bodies stay on the retained population.
  return 64 + 8 * rows.length;
}

function* adjacencyEffectSteps(rows: Iterable<AdjacencyRow>, input: AdjacencyEffectsInput): PathComputation<void> {
  const runtime = runtimeProgram(input.interpretation.program);
  if (runtime === "empty") return;
  if (runtime === "epsilon") {
    for (let index = input.liveStateOffset ?? 0; index < input.liveStates.length; index += 1) {
      yield { kind: "work" };
      const claim = claimEvidenceDemandForState(input.liveStates.at(index)!, input.interpretation.view,
        input.bindingContexts);
      if (claim !== undefined && !claimDemandRegistered(input.registeredDemands, claim)) yield { kind: "effect", effect: {
        observation_id: `claim-demand:${claim.subject}:${claim.predicate}`,
        relation_demand: claim, source_fact_demand: claim.subject
      } };
    }
    return;
  }
  yield { kind: "work", retained_bytes: 256 };
  const automaton = input.compiledAutomaton ?? compileProgramAutomaton(runtime);
  const compiledPremises = input.compiledPremises ?? new Map<QueryProgram, ProgramAutomaton>();
  const coldPrograms = new Set<string>();
  const physicalKinds = new Set<string>();
  for (const kind of input.physicalKinds ?? []) {
    yield { kind: "work", retained_bytes: 64 + Buffer.byteLength(kind, "utf8") };
    physicalKinds.add(kind);
  }
  const statesByEndpoint = new Map<string, ProductStateKey[]>();
  // New states keep the live-state suffix against the full population.
  // A row delta joins every state in range with joinRows only.
  const joinedRows = input.joinRows ?? rows;
  const indexed = input.settledStateEndpoints;
  for (let index = indexed === undefined ? input.liveStateOffset ?? 0 : input.liveStates.length;
    index < input.liveStates.length; index += 1) {
    yield { kind: "work", retained_bytes: 64 };
    const from = input.liveStates.at(index)!;
    const endpoint = productEndpointId(from), bucket = statesByEndpoint.get(endpoint);
    for (const advance of automaton.advancesByState.get(from.program_state) ?? []) {
      yield { kind: "work" };
      for (const predicate of relationPhysicalCandidates(advance.relation.relation_kind)) {
        yield { kind: "work" };
        if (!physicalKinds.has(predicate) || !relationMatches(advance.relation.relation_kind, predicate)) continue;
        if (pairDemandRegistered(input.registeredDemands, endpoint, predicate)) continue;
        yield { kind: "effect", effect: { observation_id: `demand:${endpoint}:${predicate}`,
          relation_demand: { subject: endpoint, predicate } } };
      }
    }
    const claim = claimEvidenceDemandForState(from, input.interpretation.view, input.bindingContexts);
    if (claim !== undefined && !claimDemandRegistered(input.registeredDemands, claim)) yield { kind: "effect", effect: {
      observation_id: `claim-demand:${claim.subject}:${claim.predicate}`,
      relation_demand: claim,
      source_fact_demand: claim.subject
    } };
    // The cursor admits index storage before retaining references. Buckets keep
    // the immutable input order, including all hypotheses sharing an endpoint.
    yield { kind: "work", retained_bytes: bucket === undefined ? 128 + 2 * endpoint.length : 16 };
    if (bucket === undefined) statesByEndpoint.set(endpoint, [from]);
    else bucket.push(from);
    for (const advance of automaton.hyperedgeAdvances) {
      if (advance.from !== from.program_state) continue;
      // One focused premise reads the row delta. The others still read the retained population.
      for (const step of hyperedgeEffectSteps(rows, advance.hyperedge, {
        asOf: input.asOf,
        query_id: input.interpretation.query_id,
        liveStates: [from],
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        bindingContexts: input.bindingContexts,
        toProgramStates: advance.to,
        destinationAutomaton: automaton,
        observedStates: input.liveStates,
        physicalKinds: input.physicalKinds, physicalKindSet: physicalKinds, compiledPremises,
        coldPrograms,
        registeredDemands: input.registeredDemands,
        // The compiled automaton stays shared. A branch writes only its own frontier.
        reachOwner: input.sequenceReachOwner ?? input.compiledAutomaton ?? input.interpretation,
        ...(input.joinRows === undefined ? {} : { joinRows: input.joinRows })
      })) yield step.kind === "work" ? step : { kind: "effect", effect: attachHyperedgeFacet(step.effect) };
    }
  }
  yield { kind: "work", retained_bytes: 128 };
  const facetLookup = new PathFacetLookup(input.facets ?? [], input.facetIndex);
  for (const row of joinedRows) {
    if (row.validity === undefined) continue;
    if (inactiveResolution(row.resolutionKind)) continue;
    yield { kind: "work" };
    if (indexed !== undefined) yield { kind: "work" };
    for (const from of (indexed?.endpoints ?? statesByEndpoint).get(row.sourceObjectId) ?? []) {
      yield { kind: "work" };
      yield* effectsForLiveRow(automaton, row, from, {
        query_id: input.interpretation.query_id,
        overlay: input.overlay,
        sourceFacts: input.sourceFacts,
        bindingContexts: input.bindingContexts,
        facetLookup,
        liveStates: input.liveStates
      });
    }
  }
  const origins = new Set<string>();
  if (indexed === undefined) for (const state of input.liveStates) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(productEndpointId(state));
  }
  for (const discovery of input.discoveries ?? []) {
    yield { kind: "work", retained_bytes: 64 };
    origins.add(discovery.subject_id);
  }
  if (indexed === undefined && (input.physicalKinds?.length ?? 0) > 0) for (const origin of origins) {
    for (const [predicate, routing] of Object.entries(input.overlay)) {
      yield { kind: "work" };
      if (!routing.applicable || routing.role !== "routing_only") continue;
      if (pairDemandRegistered(input.registeredDemands, origin, predicate)) continue;
      yield { kind: "effect", effect: { observation_id: `routing-demand:${origin}:${predicate}`,
        relation_demand: { subject: origin, predicate } } };
    }
  }
  const emitted = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of joinedRows) {
      yield { kind: "work", retained_bytes: 128 };
      if (row.validity === undefined || inactiveResolution(row.resolutionKind)
        || !(origins.has(row.sourceObjectId) || indexed?.endpoints.has(row.sourceObjectId))
        || emitted.has(row.assertionId)) continue;
      for (const effect of routingDiscoveryEffect(row, input.overlay)) {
        emitted.add(row.assertionId);
        if (!origins.has(effect.discovery.subject_id) && !indexed?.endpoints.has(effect.discovery.subject_id)) {
          origins.add(effect.discovery.subject_id); grew = true;
        }
        yield { kind: "effect", effect };
      }
    }
  }
}

function* effectsForLiveRow(
  automaton: ProgramAutomaton,
  row: AdjacencyRow,
  from: ProductStateKey,
  input: Readonly<{
    readonly query_id: string;
    readonly overlay: NamedKindOverlay;
    readonly sourceFacts?: ReadonlyMap<string, BoundSourceFacts>;
    readonly facetLookup: PathFacetLookup;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly bindingContexts?: BindingContextStore;
  }>
): PathComputation<void> {
  if (from.target.kind !== "memory_entry" && from.interpretation_node === undefined) {
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
    readonly facetLookup: PathFacetLookup;
    readonly liveStates: RetainedRows<ProductStateKey>;
    readonly bindingContexts?: BindingContextStore;
  }>
): PathComputation<void> {
  const admitted = yield* admitRelationRow(advance.relation, from, row, input);
  if (admitted === undefined) return;
  const { binding: unifiedBinding, targetRevision, revisionId, strength } = admitted;
  for (const programState of advance.to) {
    yield { kind: "work" };
    const [product] = advanceProducts(automaton, { to: [programState] }, row, from, {
      binding: unifiedBinding,
      targetRevision
    }, { bindingContexts: input.bindingContexts, sourceFacts: input.sourceFacts });
    if (product === undefined) continue;
    yield* compiledEffects({ ...row, source_revision: revisionId },
      from, product.to, strength, "true", input.facetLookup);
  }
}

function* compiledEffects(
  row: AdjacencyRow,
  from: ProductStateKey,
  to: ProductStateKey,
  strength: AdmittedRelationStrength,
  decision: "true" | "unresolved",
  facetLookup: PathFacetLookup
): PathComputation<void> {
  const transition = relationTransition(row, from, to, strength);
  if (transition === undefined) return;
  const vectors = yield* extendFacets(facetLookup, from, to, `${from.program_state}:${to.program_state}:${row.predicate}`, strength.milligrades);
  const derivation = leafDerivation({
    derivation_id: `leaf:${row.assertionId}:${from.program_state}:${to.program_state}`,
    observation_id: row.assertionId,
    leaf_id: row.assertionId,
    association_milligrades: strength.milligrades,
    source_revision: row.source_revision
  });
  for (const [index, facet] of vectors.entries()) {
    yield { kind: "work", retention: "effect_payload",
      retained_bytes: 512 + Buffer.byteLength(JSON.stringify({ transition, derivation, facet }), "utf8") };
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

function attachHyperedgeFacet(effect: HyperedgeEffect): CompiledAdjacencyEffect {
  if (effect.unresolved_guard === true || effect.hyperedge === undefined) {
    return {
      observation_id: effect.observation_id,
      ...(effect.unresolved_guard === true ? { unresolved_guard: true } : {}),
      ...(effect.missing_measurement === true ? { missing_measurement: true } : {}),
      ...(effect.missing_target_revision === true ? { missing_target_revision: true } : {}),
      ...(effect.relation_demand === undefined ? {} : { relation_demand: effect.relation_demand }),
      ...(effect.source_fact_demand === undefined ? {} : { source_fact_demand: effect.source_fact_demand })
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
