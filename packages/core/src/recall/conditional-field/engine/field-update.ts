import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type CompletenessStatus,
  type CoverageRegion,
  type FacetVector,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { completenessForInterpretationStatus } from "../reference/interpret-query.js";
import {
  bindMaxMinField,
  productStateNodeId,
  type BindMaxMinResult
} from "../reference/bind-max-min.js";
import type { FairWorkRegion } from "../reference/schedule-fair-work.js";
import {
  collectIdentities,
  mergeSeeds,
  mergeTransitions,
  observationIsGuaranteed,
  productStateFromObservation,
  retainSamePathVectors,
  seedFromObservation,
  tryCompleteHyperedge
} from "./path-composition.js";
import type {
  BindableState,
  FieldClosureFacts,
  FieldEngineState,
  FieldObservationEffect,
  ObserverConsumption,
  RemainingWork
} from "./field-engine.js";

export const IDENTITY_BYTES = 256;

export const KIND_PRIORITY: Readonly<Record<CoverageRegion["kind"], number>> = {
  seed: 0,
  adjacency: 1,
  guard: 2,
  binding: 3
};

export const ACTION_BY_KIND: Readonly<Record<CoverageRegion["kind"], "seed" | "adjacency" | "relation" | "measurement">> = {
  seed: "seed",
  adjacency: "adjacency",
  guard: "relation",
  binding: "measurement"
};

export function bindEngineState(state: BindableState): FieldEngineState {
  const charged = chargeIdentities(state);
  const remainingWork = [...charged.remaining_work];
  let exploration = charged.remaining_exploration;
  if (exploration < 1) remainingWork.push({ kind: "relaxation", units: 1 });
  else exploration -= 1;
  const spooled = new Set(charged.identity_spool.map((identity) => productStateNodeId(identity)));
  const liveSeeds = charged.seeds.filter((seed) => !spooled.has(productStateNodeId(seed.state)));
  const liveTransitions = charged.transitions.filter((transition) =>
    !spooled.has(productStateNodeId(transition.from))
    && !spooled.has(productStateNodeId(transition.to))
  );
  const binding = annotateBounds(
    bindMaxMinField({
      query_id: charged.query_id,
      snapshot_id: charged.snapshot_id,
      seeds: liveSeeds,
      transitions: liveTransitions,
      budget: charged.budget,
      facets: charged.facets
    }),
    guaranteedValues(charged),
    charged.residuals
  );
  const next: FieldEngineState = {
    ...charged,
    remaining_exploration: exploration,
    remaining_work: Object.freeze(remainingWork),
    binding,
    closure: closureFacts(charged, binding.kind === "bound" ? "fixed_point" : "open")
  };
  return Object.freeze(next);
}

export function absorbObservations(
  state: FieldEngineState,
  consumption: ObserverConsumption
): BindableState {
  const priorIds = new Set(state.observations.map((row) => row.observation_id));
  const observations = [...state.observations];
  const seeds = [...state.seeds];
  const guaranteedSeeds = [...state.guaranteed_seeds];
  const transitions = [...state.transitions];
  const guaranteedTransitions = [...state.guaranteed_transitions];
  const facets = [...state.facets];
  let remainingExploration = state.remaining_exploration;
  const remainingWork: RemainingWork[] = [...state.remaining_work];
  const effectSeedIds = new Set(
    (consumption.effects ?? []).flatMap((effect) => effect.seed === undefined ? [] : [effect.observation_id])
  );
  absorbPageObservations(
    consumption.page.observations,
    priorIds,
    observations,
    seeds,
    guaranteedSeeds,
    effectSeedIds
  );
  remainingExploration = absorbEffects(
    consumption,
    priorIds,
    seeds,
    guaranteedSeeds,
    transitions,
    guaranteedTransitions,
    facets,
    remainingExploration,
    remainingWork
  );
  const workUnits = consumption.work?.work_units ?? 0;
  if (workUnits > remainingExploration) remainingWork.push({ kind: "state_create", units: workUnits - remainingExploration });
  remainingExploration = Math.max(0, remainingExploration - workUnits);
  const mergedTransitions = mergeTransitions(transitions);
  const mergedSeeds = pruneAssociatedSeeds(mergeSeeds(seeds), mergedTransitions);
  const { binding: _binding, closure: _closure, ...rest } = state;
  return {
    ...rest,
    remaining_exploration: remainingExploration,
    remaining_work: remainingWork,
    observations: Object.freeze(observations),
    seeds: mergedSeeds,
    guaranteed_seeds: pruneAssociatedSeeds(mergeSeeds(guaranteedSeeds), mergedTransitions),
    transitions: mergedTransitions,
    guaranteed_transitions: mergeTransitions(guaranteedTransitions),
    facets: retainSamePathVectors(facets),
    seen_identities: collectIdentities(mergedSeeds, mergedTransitions, state.seen_identities),
    residuals: mergeResiduals(state.residuals, consumption.page),
    last_observer_status: consumption.page.outcome.status,
    resume_cursors: consumption.resume_cursors ?? state.resume_cursors
  };
}

export function defaultOpenResiduals(): readonly CoverageRegion[] {
  return Object.freeze([
    openRegion("seed", "seed"),
    openRegion("adjacency", "adjacency"),
    openRegion("guard", "guard"),
    openRegion("binding", "binding")
  ]);
}

export function residualWorkRegions(residuals: readonly CoverageRegion[]): FairWorkRegion[] {
  return residuals
    .filter((region) => region.status === "open" || region.status === "interrupted")
    .map((region) => ({
      id: region.region_id,
      priority: KIND_PRIORITY[region.kind],
      finite: true,
      work: 1
    }));
}

function absorbPageObservations(
  pageObservations: readonly TypedObservation[],
  priorIds: ReadonlySet<string>,
  observations: TypedObservation[],
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  effectSeedIds: ReadonlySet<string> = new Set()
): void {
  for (const observation of pageObservations) {
    if (priorIds.has(observation.observation_id)) continue;
    observations.push(observation);
    if (effectSeedIds.has(observation.observation_id)) continue;
    if (observation.association_milligrades === undefined) continue;
    const seed = seedFromObservation(observation, productStateFromObservation(observation));
    if (seed === undefined) continue;
    seeds.push(seed);
    if (observationIsGuaranteed(observation)) guaranteedSeeds.push(seed);
  }
}

function absorbEffects(
  consumption: ObserverConsumption,
  priorIds: ReadonlySet<string>,
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  facets: FacetVector[],
  remainingExploration: number,
  remainingWork: RemainingWork[]
): number {
  let exploration = remainingExploration;
  for (const effect of consumption.effects ?? []) {
    if (priorIds.has(effect.observation_id)) continue;
    if (effect.seed !== undefined) {
      seeds.push(effect.seed);
      guaranteedSeeds.push(effect.seed);
    }
    if (effect.transition !== undefined) {
      transitions.push(effect.transition);
      if (effect.transition.applicable) guaranteedTransitions.push(effect.transition);
    }
    if (effect.facet !== undefined) facets.push(effect.facet);
    exploration = absorbHyperedge(effect, transitions, guaranteedTransitions, exploration, remainingWork);
  }
  return exploration;
}

function absorbHyperedge(
  effect: FieldObservationEffect,
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  exploration: number,
  remainingWork: RemainingWork[]
): number {
  if (effect.hyperedge === undefined || effect.hyperedge_premises === undefined) return exploration;
  if (exploration < 1) remainingWork.push({ kind: "join", units: 1 });
  else exploration -= 1;
  const completed = tryCompleteHyperedge(effect.hyperedge_premises, effect.hyperedge);
  if (completed !== undefined) {
    transitions.push(completed);
    guaranteedTransitions.push(completed);
  }
  return exploration;
}

function chargeIdentities(state: BindableState): BindableState {
  const charged = new Set(state.charged_identity_ids);
  const spool = [...state.identity_spool];
  let memory = state.remaining_memory_bytes;
  let exploration = state.remaining_exploration;
  const remainingWork = [...state.remaining_work];
  let exhausted = state.memory_exhausted;
  for (const identity of state.seen_identities) {
    const chargedState = chargeOneIdentity(
      identity, charged, spool, memory, exploration, remainingWork, exhausted
    );
    memory = chargedState.memory;
    exploration = chargedState.exploration;
    exhausted = chargedState.exhausted;
  }
  return {
    ...state,
    remaining_exploration: exploration,
    remaining_memory_bytes: memory,
    memory_exhausted: exhausted,
    identity_spool: Object.freeze(spool),
    charged_identity_ids: Object.freeze([...charged]),
    remaining_work: remainingWork
  };
}

function chargeOneIdentity(
  identity: ProductStateKey,
  charged: Set<string>,
  spool: ProductStateKey[],
  memory: number,
  exploration: number,
  remainingWork: RemainingWork[],
  exhausted: boolean
): { memory: number; exploration: number; exhausted: boolean } {
  const nodeId = productStateNodeId(identity);
  if (charged.has(nodeId)) {
    return { memory, exploration, exhausted };
  }
  charged.add(nodeId);
  let nextExploration = exploration;
  if (nextExploration < 1) remainingWork.push({ kind: "state_create", units: 1 });
  else nextExploration -= 1;
  if (memory < IDENTITY_BYTES) {
    spool.push(identity);
    return { memory, exploration: nextExploration, exhausted: true };
  }
  return { memory: memory - IDENTITY_BYTES, exploration: nextExploration, exhausted };
}

function guaranteedValues(state: BindableState): ReadonlyMap<string, number> {
  const bound = bindMaxMinField({
    query_id: state.query_id,
    snapshot_id: state.snapshot_id,
    seeds: state.guaranteed_seeds,
    transitions: state.guaranteed_transitions,
    budget: state.budget
  });
  if (bound.kind !== "bound") return new Map();
  const values = new Map<string, number>();
  for (const value of bound.snapshot.values) {
    values.set(productStateNodeId(value.state), value.milligrades);
  }
  return values;
}

function annotateBounds(
  binding: BindMaxMinResult,
  guaranteed: ReadonlyMap<string, number>,
  residuals: readonly CoverageRegion[]
): BindMaxMinResult {
  if (binding.kind !== "bound") return binding;
  const residualHigh = residualUpper(residuals);
  const open = residuals.some((region) => region.status === "open" || region.status === "interrupted");
  const values = binding.snapshot.values.map((value) => {
    const low = guaranteed.get(productStateNodeId(value.state)) ?? MILLIGRADE_BOTTOM;
    const high = open ? Math.max(value.milligrades, residualHigh) : value.milligrades;
    return { ...value, low_milligrades: low, high_milligrades: high };
  });
  return {
    kind: "bound",
    values: binding.values,
    snapshot: { ...binding.snapshot, values }
  };
}

function residualUpper(residuals: readonly CoverageRegion[]): number {
  let upper = MILLIGRADE_BOTTOM;
  for (const region of residuals) {
    if (region.status !== "open" && region.status !== "interrupted") continue;
    const bound = region.conservative_bound_milligrades ?? region.high_milligrades;
    if (bound === undefined) return MILLIGRADE_TOP;
    if (bound > upper) upper = bound;
  }
  return upper;
}

function pruneAssociatedSeeds(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[]
): readonly SeedActivation[] {
  // Lexical TOP on a path target would outrank the stored bottleneck.
  const associated = new Set(
    transitions
      .filter((transition) => transition.applicable && transition.from.object_id !== transition.to.object_id)
      .map((transition) => transition.to.object_id)
  );
  return Object.freeze(seeds.filter((seed) => !associated.has(seed.state.object_id)));
}

function mergeResiduals(
  current: readonly CoverageRegion[],
  page: ObserverPage
): readonly CoverageRegion[] {
  const byId = new Map(current.map((region) => [region.region_id, region]));
  const focused = page.cursor.region_id;
  const focusedOpen = page.open_regions.find((region) => region.region_id === focused);
  const existing = byId.get(focused);
  if (existing !== undefined) {
    byId.set(focused, {
      ...existing,
      ...focusedOpen,
      region_id: existing.region_id,
      kind: existing.kind,
      status: focusedOpen?.status ?? page.outcome.status
    });
  } else if (focusedOpen !== undefined) {
    byId.set(focused, focusedOpen);
  }
  for (const region of page.open_regions) {
    if (!byId.has(region.region_id)) byId.set(region.region_id, region);
  }
  return Object.freeze([...byId.values()]);
}

function closureFacts(
  state: BindableState,
  propagation: FieldClosureFacts["propagation"]
): FieldClosureFacts {
  const observation = observationClosure(state);
  return {
    propagation,
    observation,
    requested_index: requestedIndexClosure(state, observation)
  };
}

function observationClosure(state: BindableState): ObserverStatus {
  if (state.last_observer_status === "unavailable") return "unavailable";
  if (state.last_observer_status === "cancelled") return "cancelled";
  if (state.last_observer_status === "unknown") return "unknown";
  if (state.last_observer_status === "not_applicable") return "not_applicable";
  if (state.last_observer_status === "invalidated") return "invalidated";
  if (state.last_observer_status === "interrupted") return "interrupted";
  if (state.residuals.some((region) => region.status === "open" || region.status === "interrupted")) {
    return "open";
  }
  if (state.last_observer_status === "exhausted") return "exhausted";
  return "open";
}

function requestedIndexClosure(
  state: BindableState,
  observation: ObserverStatus
): CompletenessStatus {
  const admission = completenessForInterpretationStatus(state.interpretation.status);
  if (admission !== undefined) return admission.logical_index;
  if (observation === "unavailable") return "unavailable";
  if (observation === "cancelled" || observation === "unknown" || observation === "not_applicable") {
    return "open";
  }
  if (observation === "invalidated") return "invalidated";
  if (observation === "exhausted") return "complete";
  return "open";
}

function openRegion(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open",
    conservative_bound_milligrades: MILLIGRADE_TOP
  };
}
