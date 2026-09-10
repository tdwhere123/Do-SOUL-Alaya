import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  type CompletenessStatus,
  type CoverageRegion,
  type Derivation,
  type FacetVector,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { completenessForInterpretationStatus } from "../reference/interpret-query.js";
import { aggregateObserverStatus } from "../reference/accepting-projection.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { bindChargedField } from "./field-solve.js";
import type { FairWorkRegion } from "../reference/schedule-fair-work.js";
import { recoveredBindingSnapshot } from "./binding-environment.js";
import { joinDerivation, mergeDerivations } from "./path-derivation.js";
import { repairSupportAfterRuleRevision } from "./dependency-equations.js";
import {
  collectIdentities,
  mergeDiscoveries,
  mergeSeeds,
  mergeTransitions,
  observationIsGuaranteed,
  productStateFromObservation,
  retainSamePathVectors,
  seedFromObservation,
  transitionKey,
  tryCompleteHyperedge
} from "./path-composition.js";
import type { RoutingDiscovery } from "./path-routing.js";
import type {
  BindableState,
  FieldClosureFacts,
  FieldEngineState,
  FieldMeasurement,
  FieldObservationEffect,
  ObserverConsumption,
  RemainingWork
} from "./field-engine.js";

export const KIND_PRIORITY: Readonly<Record<CoverageRegion["kind"], number>> = {
  seed: 0,
  adjacency: 1,
  discovery: 1,
  guard: 2,
  binding: 3
};

export const ACTION_BY_KIND: Readonly<Record<CoverageRegion["kind"], "seed" | "adjacency" | "relation" | "measurement">> = {
  seed: "seed",
  adjacency: "adjacency",
  discovery: "adjacency",
  guard: "relation",
  binding: "measurement"
};

export function bindEngineState(state: BindableState): FieldEngineState {
  const charged = chargeIdentities(state);
  const remainingWork = [...charged.remaining_work];
  const bound = bindChargedField(charged, remainingWork);
  const { proven_binding: _proven, ...chargedRest } = charged;
  const next: FieldEngineState = {
    ...chargedRest,
    remaining_exploration: bound.exploration,
    remaining_reserve: bound.reserve,
    remaining_work: Object.freeze(
      bound.complete
        ? remainingWork.filter((row) => row.kind !== "relaxation")
        : remainingWork
    ),
    identity_spool: Object.freeze([]),
    recovered_bindings: recoveredBindingSnapshot(
      charged.seen_identities.map((identity) => identity.binding_context)
    ),
    binding: bound.binding,
    closure: closureFacts(charged, bound.complete && bound.binding.kind === "bound" ? "fixed_point" : "open")
  };
  return Object.freeze(next);
}

export function absorbObservations(
  state: FieldEngineState,
  consumption: ObserverConsumption
): BindableState {
  const priorIds = new Set(state.observations.map((row) => row.observation_id));
  const observations = [...state.observations];
  const measurements = [...state.measurements];
  const seeds = [...state.seeds];
  const guaranteedSeeds = [...state.guaranteed_seeds];
  const transitions = [...state.transitions];
  const guaranteedTransitions = [...state.guaranteed_transitions];
  const facets = [...state.facets];
  const derivations = [...state.derivations];
  const discoveries = [...state.discoveries];
  const transitionDerivations = { ...state.transition_derivations };
  let remainingExploration = state.remaining_exploration;
  let remainingMemory = state.remaining_memory_bytes;
  let memoryExhausted = state.memory_exhausted;
  const remainingWork: RemainingWork[] = [...state.remaining_work];
  const quota = {
    remaining: remainingMemory,
    exhausted: memoryExhausted,
    remainingWork,
    retained: new Set([...state.observations, ...state.seeds, ...state.transitions, ...state.facets, ...state.derivations, ...state.discoveries]
      .map((value) => JSON.stringify(value)))
  };
  const effectSeedIds = new Set(
    (consumption.effects ?? []).flatMap((effect) => effect.seed === undefined ? [] : [effect.observation_id])
  );
  absorbPageObservations(
    consumption.page.observations,
    priorIds,
    observations,
    seeds,
    guaranteedSeeds,
    effectSeedIds,
    quota
  );
  remainingExploration = absorbEffects(
    consumption,
    priorIds,
    measurements,
    seeds,
    guaranteedSeeds,
    transitions,
    guaranteedTransitions,
    facets,
    derivations,
    discoveries,
    transitionDerivations,
    remainingExploration,
    remainingWork,
    quota
  );
  remainingMemory = quota.remaining;
  memoryExhausted = quota.exhausted;
  const workUnits = consumption.work?.work_units ?? 0;
  if (workUnits > remainingExploration) remainingWork.push({ kind: "state_create", units: workUnits - remainingExploration });
  remainingExploration = Math.max(0, remainingExploration - workUnits);
  const mergedTransitions = mergeTransitions(
    state.transitions,
    transitions.slice(state.transitions.length)
  );
  const mergedSeeds = mergeSeeds(seeds);
  const mergedDiscoveries = mergeDiscoveries(discoveries);
  const absorbedNewDiscoveries = mergedDiscoveries.length > state.discoveries.length;
  const { binding, closure: _closure, ...rest } = state;
  const residuals = memoryExhausted
    ? interruptOpenResiduals(mergeResiduals(state.residuals, consumption.page))
    : mergeResiduals(state.residuals, consumption.page);
  return {
    ...rest,
    proven_binding: binding,
    remaining_exploration: remainingExploration,
    remaining_memory_bytes: remainingMemory,
    memory_exhausted: memoryExhausted,
    remaining_work: remainingWork,
    observations: Object.freeze(observations),
    measurements: Object.freeze(measurements),
    seeds: mergedSeeds,
    guaranteed_seeds: mergeSeeds(guaranteedSeeds),
    transitions: mergedTransitions,
    guaranteed_transitions: mergeTransitions(mergedTransitions.filter((row) => row.applicable)),
    facets: retainSamePathVectors(facets),
    derivations: mergeDerivations(derivations),
    discoveries: mergedDiscoveries,
    transition_derivations: Object.freeze(transitionDerivations),
    support: repairSupportAfterRuleRevision({
      priorTransitions: state.transitions,
      nextTransitions: mergedTransitions,
      seeds: mergedSeeds,
      support: state.support
    }),
    seen_identities: collectIdentities(mergedSeeds, mergedTransitions, state.seen_identities),
    residuals: admitDiscoveryResidual(residuals, mergedDiscoveries, memoryExhausted, absorbedNewDiscoveries),
    last_observer_status: memoryExhausted ? "interrupted" : consumption.page.outcome.status,
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
    .filter((region) => region.kind !== "discovery")
    .filter((region) => region.status === "open" || region.status === "interrupted")
    .map((region) => ({
      id: region.region_id,
      priority: KIND_PRIORITY[region.kind],
      finite: true,
      work: 1
    }));
}

type MemoryQuota = {
  remaining: number;
  exhausted: boolean;
  remainingWork: RemainingWork[];
  retained: Set<string>;
};

function absorbPageObservations(
  pageObservations: readonly TypedObservation[],
  priorIds: ReadonlySet<string>,
  observations: TypedObservation[],
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  effectSeedIds: ReadonlySet<string>,
  quota: MemoryQuota
): void {
  let pinnedModel = observations.find((row) => row.model_id !== undefined)?.model_id;
  for (const observation of pageObservations) {
    if (priorIds.has(observation.observation_id)) continue;
    if (pinnedModel !== undefined
      && observation.model_id !== undefined
      && observation.model_id !== pinnedModel) {
      quota.remainingWork.push({ kind: "provenance", units: 1 });
      continue;
    }
    if (!retainPayload(observation, quota)) continue;
    observations.push(observation);
    if (pinnedModel === undefined) pinnedModel = observation.model_id;
    if (effectSeedIds.has(observation.observation_id)) continue;
    if (observation.association_milligrades === undefined) continue;
    const seed = seedFromObservation(observation, productStateFromObservation(observation));
    if (seed === undefined) continue;
    if (!retainPayload(seed, quota)) continue;
    seeds.push(seed);
    if (observationIsGuaranteed(observation)) guaranteedSeeds.push(seed);
  }
}

function absorbMeasurement(
  effect: FieldObservationEffect,
  measurements: FieldMeasurement[],
  retainedIds: Set<string>,
  quota: MemoryQuota
): void {
  if (effect.raw_measurement === undefined || retainedIds.has(effect.observation_id)) return;
  const row: FieldMeasurement = {
    observation_id: effect.observation_id,
    raw: effect.raw_measurement,
    cap: effect.projected_cap ?? { status: "inapplicable" }
  };
  if (!retainPayload(row, quota)) return;
  retainedIds.add(row.observation_id);
  measurements.push(row);
}

function absorbEffects(
  consumption: ObserverConsumption,
  priorIds: ReadonlySet<string>,
  measurements: FieldMeasurement[],
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  facets: FacetVector[],
  derivations: Derivation[],
  discoveries: RoutingDiscovery[],
  transitionDerivations: Record<string, string>,
  remainingExploration: number,
  remainingWork: RemainingWork[],
  quota: MemoryQuota
): number {
  let exploration = remainingExploration;
  const retainedMeasurementIds = new Set(measurements.map((row) => row.observation_id));
  for (const effect of consumption.effects ?? []) {
    if (priorIds.has(effect.observation_id)) continue;
    absorbMeasurement(effect, measurements, retainedMeasurementIds, quota);
    if (effect.seed !== undefined && retainPayload(effect.seed, quota)) {
      seeds.push(effect.seed);
      if (effectSeedIsGuaranteed(effect, consumption.page.observations)) {
        guaranteedSeeds.push(effect.seed);
      }
    }
    if (effect.transition !== undefined && retainPayload(effect.transition, quota)) {
      transitions.push(effect.transition);
      if (effect.transition.applicable) guaranteedTransitions.push(effect.transition);
      rememberTransitionDerivation(effect, effect.transition, derivations, transitionDerivations);
    }
    if (effect.facet !== undefined && retainPayload(effect.facet, quota)) facets.push(effect.facet);
    if (effect.discovery !== undefined && retainPayload(effect.discovery, quota)) {
      discoveries.push(effect.discovery);
    }
    for (const derivation of effect.derivations ?? (effect.derivation === undefined ? [] : [effect.derivation])) {
      if (retainPayload(derivation, quota)) derivations.push(derivation);
    }
    exploration = absorbHyperedge(
      effect,
      transitions,
      guaranteedTransitions,
      derivations,
      transitionDerivations,
      exploration,
      remainingWork
    );
  }
  return exploration;
}

function absorbHyperedge(
  effect: FieldObservationEffect,
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  derivations: Derivation[],
  transitionDerivations: Record<string, string>,
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
    rememberTransitionDerivation(effect, completed, derivations, transitionDerivations);
  }
  return exploration;
}

function rememberTransitionDerivation(
  effect: FieldObservationEffect,
  transition: Transition,
  derivations: Derivation[],
  transitionDerivations: Record<string, string>
): void {
  if (effect.derivation === undefined) return;
  derivations.push(effect.derivation);
  const key = transitionKey(transition);
  const prior = derivations.find((node) => node.derivation_id === transitionDerivations[key]);
  if (prior?.derivation_id === effect.derivation.derivation_id || prior?.children.includes(effect.derivation.derivation_id)) return;
  const alternatives = prior?.kind === "or"
    ? prior.children.flatMap((id) => derivations.find((node) => node.derivation_id === id) ?? []) : prior === undefined ? [] : [prior];
  const root = joinDerivation("or", [...alternatives, effect.derivation]);
  derivations.push(root);
  transitionDerivations[key] = root.derivation_id;
}

function chargeIdentities(state: BindableState): BindableState {
  const charged = new Set(state.charged_identity_ids);
  let memory = state.remaining_memory_bytes;
  let exploration = state.remaining_exploration;
  const remainingWork = [...state.remaining_work];
  let exhausted = state.memory_exhausted;
  const keptIdentities: ProductStateKey[] = [];
  for (const identity of state.seen_identities) {
    const nodeId = productStateNodeId(identity);
    if (charged.has(nodeId)) {
      keptIdentities.push(identity);
      continue;
    }
    const cost = payloadBytes(identity);
    if (exploration >= 1) exploration -= 1;
    else remainingWork.push({ kind: "state_create", units: 1 });
    if (memory < cost) {
      exhausted = true;
      remainingWork.push({ kind: "state_create", units: 1 });
      continue;
    }
    memory -= cost;
    charged.add(nodeId);
    keptIdentities.push(identity);
  }
  const keptIds = new Set(keptIdentities.map((identity) => productStateNodeId(identity)));
  return {
    ...state,
    remaining_exploration: exploration,
    remaining_memory_bytes: memory,
    memory_exhausted: exhausted,
    identity_spool: Object.freeze([]),
    charged_identity_ids: Object.freeze([...charged]),
    seen_identities: Object.freeze(keptIdentities),
    seeds: Object.freeze(state.seeds.filter((seed) => keptIds.has(productStateNodeId(seed.state)))),
    guaranteed_seeds: Object.freeze(
      state.guaranteed_seeds.filter((seed) => keptIds.has(productStateNodeId(seed.state)))
    ),
    transitions: Object.freeze(state.transitions.filter((transition) =>
      keptIds.has(productStateNodeId(transition.from))
      && keptIds.has(productStateNodeId(transition.to))
    )),
    guaranteed_transitions: Object.freeze(state.guaranteed_transitions.filter((transition) =>
      keptIds.has(productStateNodeId(transition.from))
      && keptIds.has(productStateNodeId(transition.to))
    )),
    remaining_work: remainingWork
  };
}

function retainPayload(value: unknown, quota: MemoryQuota): boolean {
  const serialized = JSON.stringify(value);
  if (quota.retained.has(serialized)) return true;
  const cost = Buffer.byteLength(serialized, "utf8");
  if (quota.remaining < cost) {
    quota.exhausted = true;
    quota.remainingWork.push({ kind: "state_create", units: 1 });
    return false;
  }
  quota.remaining -= cost;
  quota.retained.add(serialized);
  return true;
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function effectSeedIsGuaranteed(
  effect: FieldObservationEffect,
  observations: readonly TypedObservation[]
): boolean {
  if (effect.missing_measurement === true) return false;
  if (effect.admitted_seed !== true) return false;
  const observation = relatedObservation(effect.observation_id, observations);
  if (observation === undefined || !observationIsGuaranteed(observation)) return false;
  return true;
}

function relatedObservation(
  effectObservationId: string,
  observations: readonly TypedObservation[]
): TypedObservation | undefined {
  const exact = observations.find((row) => row.observation_id === effectObservationId);
  if (exact !== undefined) return exact;
  return observations.find((row) => effectObservationId.startsWith(`${row.observation_id}:`));
}

function interruptOpenResiduals(residuals: readonly CoverageRegion[]): readonly CoverageRegion[] {
  return Object.freeze(residuals.map((region) => {
    if (region.status !== "open" && region.status !== "interrupted") return region;
    return { ...region, status: "interrupted" as const };
  }));
}

function admitDiscoveryResidual(
  residuals: readonly CoverageRegion[],
  discoveries: readonly RoutingDiscovery[],
  memoryExhausted: boolean,
  absorbedNew: boolean
): readonly CoverageRegion[] {
  if (discoveries.length === 0) return residuals;
  const status = memoryExhausted ? "interrupted" as const : "open" as const;
  let found = false;
  const next = residuals.map((region) => {
    if (region.kind !== "discovery") return region;
    found = true;
    return absorbedNew && region.status === "exhausted" ? { ...region, status } : region;
  });
  if (!found) next.push({ ...openRegion("discovery", "discovery"), status });
  return Object.freeze(next);
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

export function closureFacts(
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
  return aggregateObserverStatus(state.memory_exhausted ? "interrupted" : state.last_observer_status, state.residuals);
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
  if (observation === "exhausted") {
    if (state.support_work_status === "open") return "open";
    if (state.remaining_work.some((item) => item.kind === "provenance" || item.kind === "join")) {
      return "open";
    }
    return "complete";
  }
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
