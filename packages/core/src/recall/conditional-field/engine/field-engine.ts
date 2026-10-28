import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClaimState,
  type CompletenessStatus,
  type CoverageRegion,
  type Derivation,
  type FacetVector,
  type FieldValue,
  type IndexRole,
  type ObserverAction,
  type ObserverPage,
  type ObserverStatus,
  type ProjectedCap,
  type RawMeasurement,
  type ProductStateKey,
  type Proposition,
  type QueryInterpretation,
  type RequestBudget,
  type SeedActivation,
  type SupportRecord,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import type { PendingPathEffects } from "./path-effect-cursor.js";
import { BindingContextStore, BindingContextResourceError, parseBindingContext } from "./binding-environment.js";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";
import type { ProductEvidenceCursor } from "../evidence/product-evidence.js";
import {
  completenessForInterpretationStatus,
  interpretQuery
} from "../reference/interpret-query.js";
import {
  admitRequestBudget,
  productStateNodeId,
  resourceRejectedCompleteness,
  type BindMaxMinResult
} from "../reference/bind-max-min.js";
import {
  scheduleFairWork,
  type FairWorkRegion
} from "../reference/schedule-fair-work.js";
import { type AdjacencyEffectsInput, type HyperedgeCompletion, type HyperedgePremise } from "./path-composition-adjacency.js";
import type { StateEndpointIndex } from "./state-endpoint-index.js";
import { facetBelongsToOutput, retainSamePathVectors } from "./path-composition-facet.js";
import { collectIdentities, mergeSeeds } from "./path-composition-seed.js";
import { mergeTransitions, transitionKey } from "./path-composition.js";
import { dropSequenceReachAssertion, forkSequenceReachOwner, transferSequenceReachCharge } from "./sequence-reach.js";
import type { RoutingDiscovery } from "./path-routing.js";
import { derivationForest, evaluateDerivation, reviseDerivations } from "./path-derivation.js";
import type { BoundSourceFacts } from "./binding-environment.js";
import type { GroundingProgress } from "./output-derivations.js";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { FieldGraphAdditions } from "./field-graph-preparation.js";
import { facetIdentityIndexOf, type FieldRetentionIndex } from "./field-retention-index.js";
import {
  affectedSubjectsOf,
  productSccs,
  productsTouchedByLeaf,
  reviseSccSupport,
  sccMembersOf,
  seedTouchesLeaf
} from "./dependency-equations.js";
import {
  ACTION_BY_KIND,
  absorbObservations,
  bindEngineState,
  closureFacts,
  defaultOpenResiduals,
  isPhysicalRegionKind,
  residualWorkRegions
} from "./field-update.js";

export type FieldMeasurement = Readonly<{
  readonly observation_id: string;
  readonly raw: RawMeasurement;
  readonly cap: ProjectedCap;
}>;

export type FieldObservationEffect = Readonly<{
  readonly observation_id: string;
  readonly missing_measurement?: boolean;
  readonly raw_measurement?: RawMeasurement;
  readonly projected_cap?: ProjectedCap;
  readonly admitted_seed?: boolean;
  readonly unresolved_guard?: boolean;
  readonly missing_target_revision?: boolean;
  readonly seed?: SeedActivation;
  readonly transition?: Transition;
  readonly facet?: FacetVector;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
  readonly derivation?: Derivation;
  readonly derivations?: readonly Derivation[];
  readonly discovery?: RoutingDiscovery;
}>;

export type ObserverWorkUnits = Readonly<{
  readonly work_units: number;
}>;

export type ObserverConsumption = Readonly<{
  readonly binding_contexts?: BindingContextStore;
  readonly page: ObserverPage;
  readonly effects?: readonly FieldObservationEffect[];
  readonly work?: ObserverWorkUnits;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
}>;

export type EvidenceEffect = Readonly<{
  readonly support: readonly SupportRecord[];
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly work_status?: "complete" | "open";
}>;

export type FieldClosureFacts = Readonly<{
  readonly propagation: "open" | "fixed_point";
  readonly observation: ObserverStatus;
  readonly requested_index: CompletenessStatus;
}>;

export type RemainingWork = Readonly<{
  readonly kind: "state_create" | "join" | "relaxation" | "provenance" | "projection" | "observe";
  readonly units: number;
}>;

export type CreateFieldInput = Readonly<{
  readonly binding_contexts?: BindingContextStore;
  readonly interpretation: QueryInterpretation;
  readonly authorized_scopes?: readonly string[] | null;
  readonly budget: RequestBudget;
  readonly roles?: ReadonlyMap<string, IndexRole>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly seeds?: readonly SeedActivation[];
  readonly transitions?: readonly Transition[];
  readonly facets?: readonly FacetVector[];
  readonly derivations?: readonly Derivation[];
  readonly support?: readonly SupportRecord[];
  readonly residuals?: readonly CoverageRegion[];
  readonly extra_work_regions?: readonly FairWorkRegion[];
}>;

export type FieldEngineState = Readonly<{
  /** undefined is unobserved; null is an absent native discovery capability. */
  readonly native_sources?: import("../observers/observe-ports.js").NativeSourceNomination | null;
  readonly native_source_retained_bytes?: number;
  readonly binding_contexts?: BindingContextStore;
  readonly binding_context_bytes?: number;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly epoch: number;
  readonly interpretation: QueryInterpretation;
  readonly authorized_scopes?: readonly string[] | null;
  readonly observation_workspace_id?: string;
  readonly observation_query_text?: string;
  readonly observation_as_of?: string;
  readonly observation_source_revision?: string;
  readonly budget: RequestBudget;
  readonly remaining_exploration: number;
  readonly solver_completed_work?: number;
  readonly remaining_reserve: number;
  readonly remaining_memory_bytes: number;
  /** Cumulative admitted logical allocation; releases do not erase a request's charge. */
  readonly admitted_allocation_bytes: number;
  /** Full accounted level at a completed phase, including projection-owned retention. */
  readonly accounted_retained_bytes?: number;
  /** Conservative allocation charges retained across forks and resets in this epoch. */
  readonly solver_retained_bytes?: number;
  readonly memory_exhausted: boolean;
  readonly retention_rejected?: "memory" | "work";
  readonly seen_identities: RetainedRows<ProductStateKey>;
  readonly identity_index?: PersistentStringMap<ProductStateKey>;
  readonly ordered_identities?: PersistentStringMap<ProductStateKey>;
  /** Offset of each node id in `seen_identities`; kept with `identity_index`. */
  readonly identity_positions?: PersistentStringMap<number>;
  readonly state_endpoint_index?: StateEndpointIndex;
  readonly retained_index?: FieldRetentionIndex;
  readonly identity_spool: RetainedRows<ProductStateKey>;
  readonly observations: RetainedRows<TypedObservation>;
  readonly measurements: RetainedRows<FieldMeasurement>;
  readonly observed_relations?: import("./observed-relations.js").ObservedRelationRows;
  readonly observation_gaps?: Readonly<{ guards: boolean; measurements: boolean }>;
  readonly unresolved_seed_count?: number;
  readonly pending_path_effects?: PendingPathEffects;
  readonly compiled_automaton?: import("./program-automaton.js").ProgramAutomaton;
  readonly compiled_automaton_bytes?: number;
  readonly sequence_reach_bytes?: number;
  /** Branch-private sequence frontier. Copies must not share one automaton cache. */
  readonly sequence_reach_owner?: object;
  readonly path_effect_frontier?: Readonly<{ identities: number; facets: RetainedRows<FacetVector>; discoveries: number;
    sourceFacts?: PersistentStringMap<BoundSourceFacts>;
    demand_context?: Pick<AdjacencyEffectsInput, "interpretation" | "overlay" | "physicalKinds"> }>;
  readonly source_facts?: PersistentStringMap<BoundSourceFacts>;
  readonly source_fact_bytes?: number;
  readonly observed_relation_bytes?: number;
  readonly grounding_progress?: GroundingProgress;
  /** Semantic input versions captured with grounding progress; adapter arrays are page-local copies. */
  readonly grounding_input_references?: readonly unknown[];
  readonly explanation_progress?: import("../index/explanation-delivery.js").ExplanationDelivery;
  readonly explanation_completed_work?: number;
  readonly projection_progress?: Readonly<{
    readonly revision: string;
    readonly input_references: readonly unknown[];
    readonly generation: number;
    readonly offset: number;
    readonly delivered_entries: Readonly<Record<string, string>>;
    readonly delivered_products?: Readonly<Record<string, import("../index/product-component-diff.js").ProductComponentState>>;
    readonly facet_offset?: number;
    readonly facet_index?: import("../index/facet-visit-accounting.js").FacetVisitIndex;
  }>;
  readonly preview_cache?: Readonly<Record<string, string>>;
  readonly support_progress?: Readonly<Record<string, { readonly cursor: ProductEvidenceCursor; readonly complete: boolean }>>;
  readonly support_scan_offset?: number;
  readonly support_completed_work?: number;
  readonly support_dependency_revision?: string;
  readonly support_dependency_references?: readonly unknown[];
  readonly support_dependencies?: Readonly<Record<string, readonly string[]>>;
  readonly withdrawn_leaves?: readonly string[];
  readonly support_retained_bytes?: number;
  readonly claim_propositions?: ReadonlyMap<string, Proposition>;
  readonly seeds: RetainedRows<SeedActivation>;
  readonly guaranteed_seeds: RetainedRows<SeedActivation>;
  readonly transitions: RetainedRows<Transition>;
  readonly guaranteed_transitions: RetainedRows<Transition>;
  readonly facets: RetainedRows<FacetVector>;
  readonly derivations: RetainedRows<Derivation>;
  readonly transition_derivations: PersistentStringMap<string>;
  readonly support: readonly SupportRecord[];
  readonly residuals: readonly CoverageRegion[];
  readonly extra_work_regions: readonly FairWorkRegion[];
  readonly binding: BindMaxMinResult;
  readonly claims: ReadonlyMap<string, ClaimState>;
  readonly roles: ReadonlyMap<string, IndexRole>;
  readonly remaining_work: readonly RemainingWork[];
  readonly last_observer_status: ObserverStatus | undefined;
  readonly resume_cursors: Readonly<Record<string, string | null>>;
  readonly pair_progress: PersistentStringMap<string | null>;
  readonly pair_demands: PersistentStringMap<true>;
  readonly pair_demand_bytes: number;
  readonly pair_progress_bytes: number;
  readonly source_fact_demands: PersistentStringMap<"pending" | "done">;
  readonly source_fact_demand_bytes: number;
  readonly source_fact_pending_count: number;
  readonly source_fact_scan_offset: number;
  readonly pair_completed_count: number;
  readonly pair_revision: number;
  readonly pair_scan_offset: number;
  readonly resume_subjects: PersistentStringMap<true>;
  readonly discoveries: RetainedRows<RoutingDiscovery>;
  readonly support_work_status?: "complete" | "open";
  readonly closure: FieldClosureFacts;
}>;

export type BindableState = Omit<FieldEngineState, "binding" | "closure"> & {
  readonly proven_binding?: BindMaxMinResult;
  readonly binding_delta?: Readonly<{ possible: FieldGraphAdditions; guaranteed: FieldGraphAdditions; reset?: boolean }>;
};

export type WorkProposal = Readonly<{
  readonly actions: readonly ObserverAction[];
  readonly remainingReserve: number;
  readonly starvedFinite: boolean;
}>;

export type FieldDelta = Readonly<{
  readonly accepted_states: readonly FieldValue[];
  readonly residuals: readonly CoverageRegion[];
  readonly closure: FieldClosureFacts;
}>;

export function createConditionalField(input: CreateFieldInput): FieldEngineState {
  const interpretation = input.interpretation;
  const seeds = mergeSeeds(input.seeds ?? []);
  const transitions = mergeTransitions(input.transitions ?? []);
  const identities = collectIdentities(seeds, transitions);
  const bindingContexts = input.binding_contexts?.fork() ?? new BindingContextStore(input.budget.memory_bytes);
  if (bindingContexts.bytes > input.budget.memory_bytes) throw new BindingContextResourceError("binding context memory exhausted");
  for (const identity of identities) parseBindingContext(identity.binding_context, bindingContexts);
  const residuals = input.residuals ?? defaultOpenResiduals();
  const rejected = admitField(interpretation, input.budget);
  if (rejected !== undefined) {
    return rejectedField(input, identities, residuals, rejected);
  }
  return bindEngineState({
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    epoch: 1,
    interpretation,
    authorized_scopes: input.authorized_scopes,
    budget: input.budget,
    remaining_exploration: input.budget.work_units - input.budget.finalization_reserve,
    remaining_reserve: input.budget.finalization_reserve,
    remaining_memory_bytes: input.budget.memory_bytes - bindingContexts.bytes,
    admitted_allocation_bytes: bindingContexts.bytes,
    binding_contexts: bindingContexts.snapshot(),
    binding_context_bytes: bindingContexts.bytes,
    memory_exhausted: false,
    seen_identities: RetainedSequence.from(identities),
    identity_spool: [],
    observations: [],
    measurements: [],
    seeds,
    guaranteed_seeds: seeds,
    transitions,
    guaranteed_transitions: transitions.filter((transition) => transition.applicable),
    facets: retainSamePathVectors(input.facets ?? []),
    derivations: input.derivations ?? [],
    transition_derivations: new PersistentStringMap(),
    support: input.support ?? [],
    residuals,
    extra_work_regions: input.extra_work_regions ?? [],
    claims: input.claims ?? new Map(),
    roles: input.roles ?? new Map(),
    remaining_work: [],
    last_observer_status: undefined,
    resume_cursors: {},
    pair_progress: new PersistentStringMap(), pair_demands: new PersistentStringMap(), pair_demand_bytes: 0,
    pair_progress_bytes: 0,
    source_fact_demands: new PersistentStringMap(), source_fact_demand_bytes: 0,
    source_fact_pending_count: 0, source_fact_scan_offset: 0,
    pair_completed_count: 0, pair_revision: 0, pair_scan_offset: 0,
    resume_subjects: new PersistentStringMap(),
    discoveries: []
  });
}

export function applyObserverPage(
  state: FieldEngineState,
  consumption: ObserverConsumption
): FieldEngineState {
  const page = consumption.page;
  if (page.query_id !== state.query_id || page.snapshot_id !== state.snapshot_id) {
    return reviseEpoch(state, consumption);
  }
  const bindingContexts = consumption.binding_contexts?.snapshot() ?? state.binding_contexts;
  if (consumption.binding_contexts !== undefined && state.binding_contexts !== undefined
    && !consumption.binding_contexts.extends(state.binding_contexts)) {
    throw new BindingContextResourceError("binding recovery must extend the current field owner");
  }
  const bindingBytes = (bindingContexts?.bytes ?? 0) - (state.binding_contexts?.bytes ?? 0);
  if (bindingBytes < 0) throw new BindingContextResourceError("binding recovery owner cannot shrink an active field");
  if (bindingBytes > state.remaining_memory_bytes) return { ...state, memory_exhausted: true, retention_rejected: "memory" };
  for (const effect of consumption.effects ?? []) {
    const edge = effect.transition ?? effect.hyperedge;
    for (const identity of [effect.seed?.state, edge?.from, edge?.to]) {
      if (identity !== undefined) parseBindingContext(identity.binding_context, bindingContexts);
    }
  }
  const observedWork = consumption.work?.work_units ?? 0;
  const reserved = { ...state, binding_contexts: bindingContexts,
    binding_context_bytes: (state.binding_context_bytes ?? 0) + bindingBytes,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + bindingBytes,
    remaining_memory_bytes: state.remaining_memory_bytes - bindingBytes,
    remaining_exploration: Math.max(0, state.remaining_exploration - observedWork) };
  const candidate = bindEngineState(absorbObservations(reserved, { ...consumption, work: { work_units: 0 } }));
  const workRejected = observedWork > state.remaining_exploration
    || retentionWorkUnits(candidate.remaining_work) > retentionWorkUnits(state.remaining_work);
  if (!candidate.memory_exhausted && !workRejected) return { ...candidate, retention_rejected: undefined };
  return Object.freeze({
    ...state,
    remaining_exploration: candidate.remaining_exploration,
    remaining_reserve: candidate.remaining_reserve,
    memory_exhausted: candidate.memory_exhausted,
    retention_rejected: candidate.memory_exhausted ? "memory" : "work",
    last_observer_status: "interrupted",
    residuals: state.residuals.map((region) => region.status === "exhausted" ? region : { ...region, status: "interrupted" as const }),
    closure: { ...state.closure, observation: "interrupted" as const, requested_index: "interrupted" as const }
  });
}

export function withdrawDerivationLeaves(
  state: FieldEngineState,
  withdrawnLeafId: string
): FieldEngineState {
  const nodeIds = [
    ...state.seeds.map((seed) => productStateNodeId(seed.state)),
    ...state.transitions.flatMap((transition) => [
      productStateNodeId(transition.from),
      productStateNodeId(transition.to)
    ])
  ];
  const edges = state.transitions.flatMap((transition) => transition.applicable
    ? [{ from: productStateNodeId(transition.from), to: productStateNodeId(transition.to) }]
    : []);
  const touched = productsTouchedByLeaf({
    withdrawnLeafId,
    seeds: state.seeds,
    transitions: state.transitions,
    derivations: state.derivations,
    transition_derivations: state.transition_derivations
  });
  const affected = sccMembersOf(productSccs(nodeIds, edges), touched);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) if (affected.has(edge.from) && !affected.has(edge.to)) {
      affected.add(edge.to);
      changed = true;
    }
  }
  const subjects = affectedSubjectsOf(state.seeds, state.transitions, affected);
  const revised = reviseDerivations(state.derivations, withdrawnLeafId);
  const derivations = revised.derivations;
  const forest = derivationForest(derivations);
  const grades = new Map(derivations.flatMap((row) => row.association_milligrades === undefined ? [] :
    row.leaf_ids.map((id) => [id, row.association_milligrades!] as const)));
  const seeds = state.seeds.filter((seed) => !seedTouchesLeaf(seed, withdrawnLeafId));
  const guaranteedSeeds = state.guaranteed_seeds.filter((seed) => !seedTouchesLeaf(seed, withdrawnLeafId));
  const retained = state.transitions.filter((transition) => {
    const derivationId = state.transition_derivations.get(transitionKey(transition));
    if (derivationId === undefined) {
      return !leafTouchesTransition(transition, withdrawnLeafId);
    }
    return revised.roots.get(derivationId) !== undefined;
  });
  let transitionRoots = new PersistentStringMap<string>();
  const transitions = retained.map((transition) => {
    const root = revised.roots.get(state.transition_derivations.get(transitionKey(transition)) ?? "");
    const grade = root === undefined ? undefined : evaluateDerivation(forest, root, grades);
    const next = grade === undefined ? transition : { ...transition, strength_milligrades: grade };
    if (root !== undefined) transitionRoots = transitionRoots.with(transitionKey(next), root);
    return next;
  });
  const { binding: _binding, closure: _closure, ...rest } = state;
  const affectedClaims = new Set(Object.entries(state.support_dependencies ?? {})
    .filter(([, leaves]) => leaves.includes(withdrawnLeafId)).map(([key]) => key));
  const withdrawnPropositions = new Set([...affectedClaims].flatMap((key) => {
    const proposition = state.claim_propositions?.get(key);
    return proposition === undefined ? [] : [proposition.proposition_id];
  }));
  const support = reviseSccSupport(state.support, withdrawnLeafId, affected, subjects)
    .filter((record) => !withdrawnPropositions.has(record.proposition_id));
  const claims = new Map(state.claims);
  const propositions = new Map(state.claim_propositions);
  const survivingPropositions = new Set(support.map((row) => row.proposition_id));
  for (const record of state.support) if (!survivingPropositions.has(record.proposition_id)) {
    claims.delete(record.proposition_id);
    propositions.delete(record.proposition_id);
  }
  for (const key of [...affected, ...subjects, ...affectedClaims]) {
    claims.delete(key);
    propositions.delete(key);
  }
  const affectedStates = state.seen_identities.filter((key) => affected.has(productStateNodeId(key)));
  // Field transitions are filtered above. The sequence frontier is forked first so a sibling keeps its copy.
  const sequenceOwner = forkSequenceReachOwner(state.sequence_reach_owner ?? state.compiled_automaton);
  dropSequenceReachAssertion(sequenceOwner, withdrawnLeafId);
  const sequenceCharge = transferSequenceReachCharge(state, sequenceOwner);
  const proofBytes = (state.grounding_progress?.retained_bytes ?? 0) + (state.explanation_progress?.retainedBytes ?? 0);
  const sequenceBalance = sequenceReachBalance(state, sequenceCharge);
  const withdrawn = bindEngineState({
    ...rest,
    sequence_reach_owner: sequenceOwner,
    ...sequenceBalance,
    remaining_memory_bytes: (sequenceBalance.remaining_memory_bytes ?? state.remaining_memory_bytes) + proofBytes,
    ...(state.accounted_retained_bytes === undefined ? {} : {
      accounted_retained_bytes: Math.max(0, state.accounted_retained_bytes + sequenceCharge.delta - proofBytes)
    }),
    retained_index: undefined,
    claims,
    claim_propositions: propositions,
    facets: state.facets.filter((facet) => !affectedStates.some((key) => facetBelongsToOutput(facet.path_id, key))),
    grounding_progress: undefined,
    explanation_progress: undefined,
    projection_progress: undefined,
    preview_cache: undefined,
    support_progress: undefined,
    support_dependency_revision: undefined,
    support_dependencies: Object.fromEntries(Object.entries(state.support_dependencies ?? {}).filter(([key]) => !affectedClaims.has(key))),
    withdrawn_leaves: [...new Set([...(state.withdrawn_leaves ?? []), withdrawnLeafId])],
    observed_relations: [...state.observed_relations ?? []].filter((row) => row.assertionId !== withdrawnLeafId).map((row) => ({ ...row,
      evidenceRefs: row.evidenceRefs?.filter((id) => id !== withdrawnLeafId),
      evidenceReceipts: row.evidenceReceipts?.filter((receipt) => receipt.evidenceId !== withdrawnLeafId && receipt.eventId !== withdrawnLeafId) })),
    seeds: mergeSeeds(seeds),
    guaranteed_seeds: mergeSeeds(guaranteedSeeds),
    derivations,
    transitions: mergeTransitions(transitions),
    guaranteed_transitions: mergeTransitions(transitions.filter((transition) => transition.applicable)),
    transition_derivations: transitionRoots,
    support
  });
  const listedRelation = [...state.observed_relations ?? []].some((row) => row.assertionId === withdrawnLeafId);
  const oweScan = (state.sequence_reach_bytes ?? 0) > 0 && !listedRelation;
  return rebuildPendingPathEffects(withdrawn, state.pending_path_effects, oweScan);
}

// A withdrawal invalidates a pass that already read the old population. The open pending
// still holds that population; a finished frontier does not hold a path-effect input.
function rebuildPendingPathEffects(
  state: FieldEngineState,
  pending: FieldEngineState["pending_path_effects"],
  oweScan: boolean
): FieldEngineState {
  if (pending === undefined) {
    // Listed relation withdrawals stay on the derivation graph. A charged sequence
    // pass whose rows were not retained has no path-effect input left to restart.
    if (!oweScan || state.path_effect_frontier === undefined) return state;
    return markUnexecutedRebuild({ ...state, path_effect_frontier: undefined });
  }
  const withdrawnIds = new Set(state.withdrawn_leaves ?? []);
  const { joinRows: _joinRows, sequenceReachOwner: _sequenceReachOwner, liveStateOffset: _liveStateOffset,
    settledStateEndpoints: _settledStateEndpoints, ...options } = pending.input.options;
  return markUnexecutedRebuild({
    ...state,
    path_effect_frontier: undefined,
    pending_path_effects: {
      offset: 0,
      retained_bytes: 0,
      page: { ...pending.page, observations: [] },
      input: {
        rows: [...pending.input.rows].filter((row) => !withdrawnIds.has(row.assertionId)),
        options: {
          ...options,
          liveStateOffset: 0,
          liveStates: state.seen_identities,
          facets: state.facets,
          facetIndex: facetIdentityIndexOf(state),
          discoveries: state.discoveries,
          bindingContexts: state.binding_contexts,
          ...(state.compiled_automaton === undefined ? {} : { compiledAutomaton: state.compiled_automaton })
        }
      }
    },
    remaining_memory_bytes: state.remaining_memory_bytes + pending.retained_bytes + (pending.preparation?.retained_bytes ?? 0)
  });
}

function markUnexecutedRebuild(state: FieldEngineState): FieldEngineState {
  const remaining_work = state.remaining_work.some((row) => row.kind === "observe")
    ? state.remaining_work
    : Object.freeze([...state.remaining_work, { kind: "observe" as const, units: 1 }]);
  // Solver fixed_point is numeric. It must not present this pass as exhausted.
  const open = { ...state, remaining_work, last_observer_status: "open" as const };
  return Object.freeze({ ...open, closure: closureFacts(open, state.closure.propagation) });
}

function sequenceReachBalance(
  state: FieldEngineState,
  charge: Readonly<{ sequence_reach_bytes: number; delta: number }>
): Partial<Pick<FieldEngineState, "sequence_reach_bytes" | "remaining_memory_bytes" | "admitted_allocation_bytes">> {
  if (charge.sequence_reach_bytes === 0 && state.sequence_reach_bytes === undefined && charge.delta === 0) return {};
  return {
    sequence_reach_bytes: charge.sequence_reach_bytes,
    remaining_memory_bytes: state.remaining_memory_bytes - charge.delta,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + Math.max(0, charge.delta)
  };
}

function leafTouchesTransition(transition: Transition, withdrawnLeafId: string): boolean {
  // Subject-id equality would revoke every hypothesis/binding/time of the same object.
  return transition.relation_kind === withdrawnLeafId
    || productStateNodeId(transition.from) === withdrawnLeafId
    || productStateNodeId(transition.to) === withdrawnLeafId;
}

export function applyEvidenceEffect(
  state: FieldEngineState,
  effect: EvidenceEffect
): FieldEngineState {
  const supportById = effect.support.length === 0 ? undefined
    : new Map(state.support.map((record) => [record.proposition_id, record]));
  let supportChanged = false;
  for (const record of effect.support) {
    if (supportById!.get(record.proposition_id) !== record) supportChanged = true;
    supportById!.set(record.proposition_id, record);
  }
  let claims = state.claims;
  if (effect.claims !== undefined) {
    for (const [objectId, claim] of effect.claims) if (claims.get(objectId) !== claim) {
      if (claims === state.claims) claims = new Map(state.claims);
      (claims as Map<string, ClaimState>).set(objectId, claim);
    }
  }
  const next = {
    ...state,
    support: supportChanged ? Object.freeze([...supportById!.values()]) : state.support,
    claims,
    ...(effect.work_status === undefined ? {} : { support_work_status: effect.work_status })
  };
  return Object.freeze({ ...next, closure: closureFacts(next, state.closure.propagation) });
}

export function proposeFieldWork(state: FieldEngineState): WorkProposal {
  if (state.memory_exhausted || state.remaining_memory_bytes < 1) {
    return {
      actions: Object.freeze([]),
      remainingReserve: state.remaining_reserve,
      starvedFinite: true
    };
  }
  const extra = state.extra_work_regions;
  const scheduled = scheduleFairWork({
    regions: [...residualWorkRegions(state.residuals), ...extra],
    explorationBudget: state.remaining_exploration,
    finalizationReserve: state.remaining_reserve,
    totalWork: state.remaining_exploration + state.remaining_reserve
  });
  const residualById = new Map(state.residuals.map((region) => [region.region_id, region]));
  const actions: ObserverAction[] = [];
  for (const id of scheduled.served) {
    const residual = residualById.get(id);
    if (residual === undefined) continue;
    if (!isPhysicalRegionKind(residual.kind)) continue;
    if (residual.status !== "open" && residual.status !== "interrupted") continue;
    actions.push({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: ACTION_BY_KIND[residual.kind],
      region_id: residual.region_id,
      work_limit: 1
    });
  }
  return {
    actions: Object.freeze(actions),
    remainingReserve: scheduled.remainingReserve,
    starvedFinite: scheduled.starvedFinite
  };
}

export function projectFieldDelta(state: FieldEngineState): FieldDelta {
  const values = state.binding.kind === "bound" ? state.binding.snapshot.values : [];
  return {
    accepted_states: Object.freeze(values.filter((value) => value.accepting)),
    residuals: state.residuals,
    closure: state.closure
  };
}

function retentionWorkUnits(work: readonly RemainingWork[]): number {
  let units = 0;
  for (const row of work) {
    if (row.kind === "relaxation") continue;
    units += row.units;
  }
  return units;
}

function admitField(
  interpretation: QueryInterpretation,
  budget: RequestBudget
): BindMaxMinResult | undefined {
  if (admitRequestBudget(budget) === "resource_rejected") {
    return { kind: "resource_rejected", completeness: resourceRejectedCompleteness() };
  }
  if (interpretQuery(interpretation.program).kind === "unsupported") {
    return {
      kind: "resource_rejected",
      completeness: completenessForInterpretationStatus("unsupported") ?? resourceRejectedCompleteness()
    };
  }
  const statusCompleteness = completenessForInterpretationStatus(interpretation.status);
  if (statusCompleteness !== undefined) {
    return { kind: "resource_rejected", completeness: statusCompleteness };
  }
  return undefined;
}

function rejectedField(
  input: CreateFieldInput,
  identities: readonly ProductStateKey[],
  residuals: readonly CoverageRegion[],
  binding: BindMaxMinResult
): FieldEngineState {
  const interpretation = input.interpretation;
  const state: FieldEngineState = {
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    epoch: 1,
    interpretation,
    authorized_scopes: input.authorized_scopes,
    budget: input.budget,
    remaining_exploration: 0,
    // A depleted request retains its declared reserve in identity metadata, but
    // rejection cannot recreate work that admission has already spent.
    remaining_reserve: Math.min(input.budget.finalization_reserve, input.budget.work_units),
    remaining_memory_bytes: input.budget.memory_bytes,
    admitted_allocation_bytes: 0,
    memory_exhausted: false,
    seen_identities: RetainedSequence.from(identities),
    identity_spool: [],
    observations: [],
    measurements: [],
    seeds: mergeSeeds(input.seeds ?? []),
    guaranteed_seeds: mergeSeeds(input.seeds ?? []),
    transitions: mergeTransitions(input.transitions ?? []),
    guaranteed_transitions: mergeTransitions(input.transitions ?? []),
    facets: retainSamePathVectors(input.facets ?? []),
    derivations: input.derivations ?? [],
    transition_derivations: new PersistentStringMap(),
    support: input.support ?? [],
    residuals,
    extra_work_regions: input.extra_work_regions ?? [],
    binding,
    claims: input.claims ?? new Map(),
    roles: input.roles ?? new Map(),
    remaining_work: [],
    last_observer_status: undefined,
    resume_cursors: {},
    pair_progress: new PersistentStringMap(), pair_demands: new PersistentStringMap(), pair_demand_bytes: 0,
    pair_progress_bytes: 0,
    source_fact_demands: new PersistentStringMap(), source_fact_demand_bytes: 0,
    source_fact_pending_count: 0, source_fact_scan_offset: 0,
    pair_completed_count: 0, pair_revision: 0, pair_scan_offset: 0,
    resume_subjects: new PersistentStringMap(),
    discoveries: [],
    closure: {
      propagation: "open",
      observation: "open",
      requested_index: binding.kind === "resource_rejected"
        ? binding.completeness.logical_index
        : "open"
    }
  };
  return Object.freeze(state);
}

function reviseEpoch(
  state: FieldEngineState,
  consumption: ObserverConsumption
): FieldEngineState {
  const page = consumption.page;
  const next = applyObserverPage(
    createConditionalField({
      interpretation: {
        ...state.interpretation,
        query_id: page.query_id,
        snapshot_id: page.snapshot_id
      },
      budget: state.budget,
      roles: state.roles,
      extra_work_regions: state.extra_work_regions
    }),
    consumption
  );
  const revised: FieldEngineState = {
    ...next,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + (next.admitted_allocation_bytes ?? 0),
    epoch: state.epoch + 1,
    closure: {
      propagation: next.closure.propagation,
      observation: next.closure.observation,
      requested_index: next.closure.requested_index === "resource_rejected"
        ? "resource_rejected"
        : "invalidated"
    }
  };
  return Object.freeze(revised);
}
