import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type CompletenessStatus,
  type CoverageRegion,
  type Derivation,
  type FacetVector,
  type FieldSnapshot,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { completenessForInterpretationStatus } from "../reference/interpret-query.js";
import { aggregateObserverStatus } from "../reference/accepting-projection.js";
import {
  bindMaxMinField,
  productStateNodeId,
  type BindMaxMinResult
} from "../reference/bind-max-min.js";
import type { FairWorkRegion } from "../reference/schedule-fair-work.js";
import { recoveredBindingSnapshot } from "./binding-environment.js";
import { joinDerivation, mergeDerivations } from "./path-derivation.js";
import {
  collectIdentities,
  mergeSeeds,
  mergeTransitions,
  observationIsGuaranteed,
  productStateFromObservation,
  retainSamePathVectors,
  seedFromObservation,
  transitionKey,
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
  let reserve = charged.remaining_reserve;
  const paid = paySolver(exploration, reserve, remainingWork);
  exploration = paid.exploration;
  reserve = paid.reserve;
  const binding = paid.ok
    ? annotateBounds(
      bindMaxMinField({
        query_id: charged.query_id,
        snapshot_id: charged.snapshot_id,
        seeds: charged.seeds,
        transitions: charged.transitions,
        budget: charged.budget,
        facets: charged.facets
      }),
      guaranteedValues(charged),
      charged.residuals
    )
    : emptyBoundSnapshot(charged);
  const next: FieldEngineState = {
    ...charged,
    remaining_exploration: exploration,
    remaining_reserve: reserve,
    remaining_work: Object.freeze(remainingWork),
    identity_spool: Object.freeze([]),
    recovered_bindings: recoveredBindingSnapshot(
      charged.seen_identities.map((identity) => identity.binding_context)
    ),
    binding,
    closure: closureFacts(charged, paid.ok ? "fixed_point" : "open")
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
  const derivations = [...state.derivations];
  const transitionDerivations = { ...state.transition_derivations };
  let remainingExploration = state.remaining_exploration;
  let remainingMemory = state.remaining_memory_bytes;
  let memoryExhausted = state.memory_exhausted;
  const remainingWork: RemainingWork[] = [...state.remaining_work];
  const quota = {
    remaining: remainingMemory,
    exhausted: memoryExhausted,
    remainingWork,
    retained: new Set([...state.observations, ...state.seeds, ...state.transitions, ...state.facets, ...state.derivations]
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
    seeds,
    guaranteedSeeds,
    transitions,
    guaranteedTransitions,
    facets,
    derivations,
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
  const mergedTransitions = mergeTransitions(transitions);
  const mergedSeeds = mergeSeeds(seeds);
  const { binding: _binding, closure: _closure, ...rest } = state;
  return {
    ...rest,
    remaining_exploration: remainingExploration,
    remaining_memory_bytes: remainingMemory,
    memory_exhausted: memoryExhausted,
    remaining_work: remainingWork,
    observations: Object.freeze(observations),
    seeds: mergedSeeds,
    guaranteed_seeds: mergeSeeds(guaranteedSeeds),
    transitions: mergedTransitions,
    guaranteed_transitions: mergeTransitions(guaranteedTransitions),
    facets: retainSamePathVectors(facets),
    derivations: mergeDerivations(derivations),
    transition_derivations: Object.freeze(transitionDerivations),
    seen_identities: collectIdentities(mergedSeeds, mergedTransitions, state.seen_identities),
    residuals: memoryExhausted
      ? interruptOpenResiduals(mergeResiduals(state.residuals, consumption.page))
      : mergeResiduals(state.residuals, consumption.page),
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

function absorbEffects(
  consumption: ObserverConsumption,
  priorIds: ReadonlySet<string>,
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  facets: FacetVector[],
  derivations: Derivation[],
  transitionDerivations: Record<string, string>,
  remainingExploration: number,
  remainingWork: RemainingWork[],
  quota: MemoryQuota
): number {
  let exploration = remainingExploration;
  for (const effect of consumption.effects ?? []) {
    if (priorIds.has(effect.observation_id)) continue;
    if (effect.seed !== undefined && retainPayload(effect.seed, quota)) {
      seeds.push(effect.seed);
      guaranteedSeeds.push(effect.seed);
    }
    if (effect.transition !== undefined && retainPayload(effect.transition, quota)) {
      transitions.push(effect.transition);
      if (effect.transition.applicable) guaranteedTransitions.push(effect.transition);
      rememberTransitionDerivation(effect, effect.transition, derivations, transitionDerivations);
    }
    if (effect.facet !== undefined && retainPayload(effect.facet, quota)) facets.push(effect.facet);
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

function paySolver(
  exploration: number,
  reserve: number,
  remainingWork: RemainingWork[]
): { exploration: number; reserve: number; ok: boolean } {
  if (exploration >= 1) return { exploration: exploration - 1, reserve, ok: true };
  if (reserve >= 1) return { exploration, reserve: reserve - 1, ok: true };
  remainingWork.push({ kind: "relaxation", units: 1 });
  return { exploration, reserve, ok: false };
}

function emptyBoundSnapshot(state: BindableState): BindMaxMinResult {
  const snapshot: FieldSnapshot = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: state.snapshot_id,
    query_id: state.query_id,
    seeds: state.seeds,
    values: [],
    retained_transitions: state.transitions,
    facets: state.facets
  };
  return { kind: "bound", values: new Map(), snapshot };
}

function interruptOpenResiduals(residuals: readonly CoverageRegion[]): readonly CoverageRegion[] {
  return Object.freeze(residuals.map((region) => {
    if (region.status !== "open" && region.status !== "interrupted") return region;
    return { ...region, status: "interrupted" as const };
  }));
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
