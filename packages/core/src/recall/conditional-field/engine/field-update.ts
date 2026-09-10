import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  PHYSICAL_COVERAGE_REGION_KINDS,
  productSubjectId,
  type CompletenessStatus,
  type CoverageRegion,
  type Derivation,
  type FacetVector,
  type ObserverPage,
  type ObserverStatus,
  type PhysicalCoverageRegionKind,
  type ProductStateKey,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { completenessForInterpretationStatus } from "../reference/interpret-query.js";
import { aggregateObserverStatus } from "../reference/accepting-projection.js";
import { classifyResidualInfluence } from "../index/completeness.js";
import { productStateNodeId, productIndexOrderKey } from "../reference/bind-max-min.js";
import { bindChargedField } from "./field-solve.js";
import type { FairWorkRegion } from "../reference/schedule-fair-work.js";
import { joinDerivation } from "./path-derivation.js";
import { localLeafIds, traceDerivationForest } from "./derivation-provenance.js";
import { repairSupportAfterRuleRevision } from "./dependency-equations.js";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { indexFieldRetention, mergeSeedAdditions, newTransitionAdditions } from "./field-retention-index.js";
import { RetainedRowDraft, RetainedSequence, type RetainedRows } from "./retained-sequence.js";
import {
  collectIdentities,
  mergeTransitions,
  observationIsGuaranteed,
  productStateFromObservation,
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

export const KIND_PRIORITY: Readonly<Record<PhysicalCoverageRegionKind, number>> = {
  seed: 0,
  adjacency: 1,
  discovery: 1,
  guard: 2,
  binding: 3
};

export const ACTION_BY_KIND: Readonly<Record<PhysicalCoverageRegionKind, "seed" | "adjacency" | "relation" | "measurement">> = {
  seed: "seed",
  adjacency: "adjacency",
  discovery: "adjacency",
  guard: "relation",
  binding: "measurement"
};

export function isPhysicalRegionKind(kind: CoverageRegion["kind"]): kind is PhysicalCoverageRegionKind {
  return (PHYSICAL_COVERAGE_REGION_KINDS as readonly string[]).includes(kind);
}

export function bindEngineState(state: BindableState): FieldEngineState {
  const charged = chargeIdentities(state);
  const remainingWork = [...charged.remaining_work];
  const bound = bindChargedField(charged, remainingWork);
  const { proven_binding: _proven, binding_delta: _delta, ...chargedRest } = charged;
  const retainedIndex = charged.retained_index ?? indexFieldRetention(charged);
  const next: FieldEngineState = {
    ...chargedRest,
    ...retainedIndex.rows,
    solver_completed_work: (state.solver_completed_work ?? 0) + (bound.binding.kind === "bound" ? bound.binding.solver_steps : 0),
    remaining_exploration: bound.exploration,
    remaining_reserve: bound.reserve,
    remaining_work: Object.freeze(
      bound.complete
        ? remainingWork.filter((row) => row.kind !== "relaxation")
        : remainingWork
    ),
    retained_index: retainedIndex,
    binding: bound.binding,
    closure: closureFacts(charged, bound.complete && bound.binding.kind === "bound" ? "fixed_point" : "open")
  };
  return Object.freeze(next);
}

export function absorbObservations(
  state: FieldEngineState,
  consumption: ObserverConsumption
): BindableState {
  const index = state.retained_index ?? indexFieldRetention(state);
  if (consumption.page.observations.length === 0 && (consumption.effects?.length ?? 0) === 0) {
    const { binding, closure: _closure, ...rest } = state;
    return { ...rest, proven_binding: binding, binding_delta: { reset: false,
      possible: { seeds: [], transitions: [] }, guaranteed: { seeds: [], transitions: [] } },
      residuals: mergeResiduals(state.residuals, consumption.page), last_observer_status: consumption.page.outcome.status,
      resume_cursors: consumption.resume_cursors ?? state.resume_cursors };
  }
  const priorIds = index.observations;
  const observations = new RetainedRowDraft(RetainedSequence.from(index.rows.observations));
  const measurements: FieldMeasurement[] = [];
  const seeds: SeedActivation[] = [];
  const guaranteedSeeds: SeedActivation[] = [];
  const transitions: Transition[] = [];
  const guaranteedTransitions: Transition[] = [];
  const facets: FacetVector[] = [];
  const derivations: Derivation[] = [];
  const discoveries: RoutingDiscovery[] = [];
  let remainingExploration = state.remaining_exploration;
  let remainingMemory = state.remaining_memory_bytes;
  let memoryExhausted = state.memory_exhausted;
  const remainingWork: RemainingWork[] = [...state.remaining_work];
  const quota = {
    remaining: remainingMemory,
    exhausted: memoryExhausted,
    remainingWork,
    retained: index.payloads,
    observationOffsets: index.observations,
    measurementIds: index.measurements,
    derivationRows: index.derivations,
    transitionRoots: state.transition_derivations,
    facetIds: index.facets,
    discoveryIds: index.discoveries,
    withdrawn: new Set(state.withdrawn_leaves ?? [])
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
    remainingExploration,
    remainingWork,
    quota
  );
  remainingMemory = quota.remaining;
  memoryExhausted = quota.exhausted;
  const workUnits = consumption.work?.work_units ?? 0;
  if (workUnits > remainingExploration) remainingWork.push({ kind: "state_create", units: workUnits - remainingExploration });
  remainingExploration = Math.max(0, remainingExploration - workUnits);
  const transitionDelta = newTransitionAdditions(transitions, index);
  const mergedTransitions = transitionDelta.reset ? mergeTransitions(state.transitions, transitionDelta.additions)
    : RetainedSequence.from(index.rows.transitions).concat(transitionDelta.additions);
  const seedDelta = mergeSeedAdditions(index.rows.seeds, seeds, index.seeds);
  const guaranteedDelta = mergeSeedAdditions(index.rows.guaranteed_seeds, guaranteedSeeds, index.guaranteedSeeds);
  const mergedSeeds = seedDelta.rows;
  const mergedDiscoveries = RetainedSequence.from(index.rows.discoveries).concat(discoveries);
  const absorbedNewDiscoveries = discoveries.length > 0;
  const rows = { observations: observations.rows, measurements: RetainedSequence.from(index.rows.measurements).concat(measurements),
    seeds: mergedSeeds, guaranteed_seeds: guaranteedDelta.rows, transitions: mergedTransitions,
    guaranteed_transitions: transitionDelta.reset ? mergedTransitions.filter((row) => row.applicable)
      : RetainedSequence.from(index.rows.guaranteed_transitions).concat(transitionDelta.additions.filter((row) => row.applicable)),
    facets: RetainedSequence.from(index.rows.facets).concat(facets), derivations: RetainedSequence.from(index.rows.derivations).concat(derivations),
    discoveries: mergedDiscoveries };
  const { binding, closure: _closure, ...rest } = state;
  const residuals = memoryExhausted
    ? interruptOpenResiduals(mergeResiduals(state.residuals, consumption.page))
    : mergeResiduals(state.residuals, consumption.page);
  return {
    ...rest,
    retained_index: transitionDelta.reset ? undefined : { ...index, rows, payloads: quota.retained,
      observations: quota.observationOffsets, measurements: quota.measurementIds, derivations: quota.derivationRows,
      facets: quota.facetIds, discoveries: quota.discoveryIds, seeds: seedDelta.offsets, guaranteedSeeds: guaranteedDelta.offsets,
      transitions: transitionDelta.keys, ruleRevisions: transitionDelta.revisions },
    binding_delta: { reset: transitionDelta.reset,
      possible: { seeds: seedDelta.additions, transitions: transitionDelta.additions },
      guaranteed: { seeds: guaranteedDelta.additions, transitions: transitionDelta.additions.filter((row) => row.applicable) } },
    proven_binding: binding,
    remaining_exploration: remainingExploration,
    remaining_memory_bytes: remainingMemory,
    memory_exhausted: memoryExhausted,
    remaining_work: remainingWork,
    ...rows,
    transition_derivations: quota.transitionRoots,
    support: transitionDelta.reset ? repairSupportAfterRuleRevision({
      priorTransitions: state.transitions,
      nextTransitions: mergedTransitions,
      seeds: mergedSeeds,
      support: state.support
    }) : state.support,
    seen_identities: state.seen_identities,
    identity_spool: RetainedSequence.from(state.identity_spool).concat(collectIdentities(seedDelta.additions, transitionDelta.additions)),
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
    .filter((region): region is CoverageRegion & { kind: PhysicalCoverageRegionKind } =>
      isPhysicalRegionKind(region.kind) && region.kind !== "discovery")
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
  retained: PersistentStringMap<true>;
  observationOffsets: PersistentStringMap<number>;
  measurementIds: PersistentStringMap<true>;
  derivationRows: PersistentStringMap<Derivation>;
  transitionRoots: PersistentStringMap<string>;
  facetIds: PersistentStringMap<true>;
  discoveryIds: PersistentStringMap<true>;
  withdrawn: ReadonlySet<string>;
};

function absorbPageObservations(
  pageObservations: readonly TypedObservation[],
  priorIds: Readonly<{ has(key: string): boolean }>,
  observations: RetainedRowDraft<TypedObservation>,
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  effectSeedIds: ReadonlySet<string>,
  quota: MemoryQuota
): void {
  for (const observation of pageObservations) {
    const priorOffset = quota.observationOffsets.get(observation.observation_id) ?? -1;
    const prior = priorOffset < 0 ? undefined : observations.at(priorOffset);
    if (prior !== undefined && (prior.source_revision !== observation.source_revision
      || prior.applicability.verdict === "true" || observation.applicability.verdict !== "true")) continue;
    if (!retainPayload(observation, quota)) continue;
    if (priorOffset < 0) {
      quota.observationOffsets = quota.observationOffsets.with(observation.observation_id, observations.length);
      observations.push(observation);
    }
    else observations.replace(priorOffset, observation);
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
  quota: MemoryQuota
): void {
  if (effect.raw_measurement === undefined || quota.measurementIds.has(effect.observation_id)) return;
  const row: FieldMeasurement = {
    observation_id: effect.observation_id,
    raw: effect.raw_measurement,
    cap: effect.projected_cap ?? { status: "inapplicable" }
  };
  if (!retainPayload(row, quota)) return;
  quota.measurementIds = quota.measurementIds.with(row.observation_id, true);
  measurements.push(row);
}

function absorbEffects(
  consumption: ObserverConsumption,
  priorIds: Readonly<{ has(key: string): boolean }>,
  measurements: FieldMeasurement[],
  seeds: SeedActivation[],
  guaranteedSeeds: SeedActivation[],
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  facets: FacetVector[],
  derivations: Derivation[],
  discoveries: RoutingDiscovery[],
  remainingExploration: number,
  remainingWork: RemainingWork[],
  quota: MemoryQuota
): number {
  let exploration = remainingExploration;
  for (const effect of consumption.effects ?? []) {
    if (priorIds.has(effect.observation_id)) continue;
    if (effect.derivation !== undefined && quota.withdrawn.size > 0) {
      const additions = new Map((effect.derivations ?? [effect.derivation]).map((row) => [row.derivation_id, row]));
      const traced = traceDerivationForest({ roots: [effect.derivation.derivation_id], forest: {
        get: (id) => additions.get(id) ?? quota.derivationRows.get(id) } });
      if (!traced.complete || [...localLeafIds(traced.traversal)].some((id) => quota.withdrawn.has(id))) continue;
    }
    absorbMeasurement(effect, measurements, quota);
    if (effect.seed !== undefined && retainPayload(effect.seed, quota)) {
      seeds.push(effect.seed);
      if (effectSeedIsGuaranteed(effect, consumption.page.observations)) {
        guaranteedSeeds.push(effect.seed);
      }
    }
    if (effect.transition !== undefined && retainPayload(effect.transition, quota)) {
      const transition = effect.transition.instance_id === undefined && effect.derivation !== undefined
        ? { ...effect.transition, instance_id: effect.derivation.observation_ids[0] ?? effect.derivation.derivation_id }
        : effect.transition;
      transitions.push(transition);
      if (transition.applicable) guaranteedTransitions.push(transition);
      rememberTransitionDerivation(effect, transition, derivations, quota);
    }
    if (effect.facet !== undefined && !quota.facetIds.has(effect.facet.path_id) && retainPayload(effect.facet, quota)) {
      facets.push(effect.facet); quota.facetIds = quota.facetIds.with(effect.facet.path_id, true);
    }
    if (effect.discovery !== undefined && !quota.discoveryIds.has(effect.discovery.assertion_id) && retainPayload(effect.discovery, quota)) {
      discoveries.push(effect.discovery);
      quota.discoveryIds = quota.discoveryIds.with(effect.discovery.assertion_id, true);
    }
    for (const derivation of effect.derivations ?? (effect.derivation === undefined ? [] : [effect.derivation])) {
      if (retainPayload(derivation, quota)) retainDerivation(derivation, derivations, quota);
    }
    exploration = absorbHyperedge(
      effect,
      transitions,
      guaranteedTransitions,
      derivations,
      exploration,
      remainingWork,
      quota
    );
  }
  return exploration;
}

function absorbHyperedge(
  effect: FieldObservationEffect,
  transitions: Transition[],
  guaranteedTransitions: Transition[],
  derivations: Derivation[],
  exploration: number,
  remainingWork: RemainingWork[],
  quota: MemoryQuota
): number {
  if (effect.hyperedge === undefined || effect.hyperedge_premises === undefined) return exploration;
  if (exploration < 1) remainingWork.push({ kind: "join", units: 1 });
  else exploration -= 1;
  const completed = tryCompleteHyperedge(effect.hyperedge_premises, effect.hyperedge);
  if (completed !== undefined) {
    transitions.push(completed);
    guaranteedTransitions.push(completed);
    rememberTransitionDerivation(effect, completed, derivations, quota);
  }
  return exploration;
}

function rememberTransitionDerivation(
  effect: FieldObservationEffect,
  transition: Transition,
  derivations: Derivation[],
  quota: MemoryQuota
): void {
  if (effect.derivation === undefined) return;
  const key = transitionKey(transition);
  const receipt = ["transition-proof", key, effect.derivation.derivation_id];
  if (quota.retained.has(JSON.stringify(receipt))) return;
  if (!retainPayload(receipt, quota)) return;
  retainDerivation(effect.derivation, derivations, quota);
  const prior = quota.derivationRows.get(quota.transitionRoots.get(key) ?? "");
  if (prior?.derivation_id === effect.derivation.derivation_id || prior?.children.includes(effect.derivation.derivation_id)) return;
  const alternatives = prior === undefined ? [] : [prior];
  const root = joinDerivation("or", [...alternatives, effect.derivation]);
  retainDerivation(root, derivations, quota);
  quota.transitionRoots = quota.transitionRoots.with(key, root.derivation_id);
}

function retainDerivation(row: Derivation, derivations: Derivation[], quota: MemoryQuota): void {
  if (quota.derivationRows.has(row.derivation_id)) return;
  quota.derivationRows = quota.derivationRows.with(row.derivation_id, row);
  derivations.push(row);
}

function chargeIdentities(state: BindableState): BindableState {
  if (state.identity_index !== undefined && state.identity_spool.length === 0) return state;
  let charged = state.identity_index ?? new PersistentStringMap<ProductStateKey>();
  let ordered = state.ordered_identities ?? new PersistentStringMap<ProductStateKey>();
  let subjects = state.resume_subjects;
  let memory = state.remaining_memory_bytes;
  let exploration = state.remaining_exploration;
  const remainingWork = [...state.remaining_work];
  let exhausted = state.memory_exhausted;
  const incoming = state.identity_index === undefined ? state.seen_identities : state.identity_spool;
  let keptIdentities = state.identity_index === undefined ? RetainedSequence.empty<ProductStateKey>() : RetainedSequence.from(state.seen_identities);
  let processed = 0;
  for (const identity of incoming) {
    if (exploration < 1) { remainingWork.push({ kind: "state_create", units: 1 }); break; }
    const nodeId = productStateNodeId(identity);
    if (charged.has(nodeId)) {
      processed += 1;
      continue;
    }
    const cost = payloadBytes(identity);
    exploration -= 1;
    if (memory < cost) {
      exhausted = true;
      remainingWork.push({ kind: "state_create", units: 1 });
      break;
    }
    memory -= cost;
    charged = charged.with(nodeId, identity);
    ordered = ordered.with(productIndexOrderKey(identity), identity);
    subjects = subjects.with(productSubjectId(identity), true);
    keptIdentities = keptIdentities.append(identity);
    processed += 1;
  }
  const pending = incoming.slice(processed);
  return {
    ...state,
    remaining_exploration: pending.length > 0 ? 0 : exploration,
    remaining_reserve: pending.length > 0 ? 0 : state.remaining_reserve,
    remaining_memory_bytes: memory,
    memory_exhausted: exhausted,
    identity_spool: exhausted ? [] : pending,
    identity_index: charged,
    ordered_identities: ordered,
    resume_subjects: subjects,
    ...(exhausted ? { seeds: [], guaranteed_seeds: [], transitions: [], guaranteed_transitions: [], facets: [], derivations: [] } : {}),
    seen_identities: keptIdentities,
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
  quota.retained = quota.retained.with(serialized, true);
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
  discoveries: RetainedRows<RoutingDiscovery>,
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
  // A semantic domain outside the requested view must not override active observer progress.
  const applicable = state.residuals.filter((region) =>
    isPhysicalRegionKind(region.kind) || region.status !== "not_applicable");
  return aggregateObserverStatus(state.memory_exhausted ? "interrupted" : state.last_observer_status, applicable);
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
    if (state.residuals.some((region) => classifyResidualInfluence(region, {}, "membership") !== "irrelevant")) {
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
    conservative_bound_milligrades: MILLIGRADE_TOP,
    cursor_id: id,
    coverage_role: kind === "discovery" ? "optional_accelerator" : "required"
  };
}
