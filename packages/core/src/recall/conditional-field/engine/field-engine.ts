import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type ClaimState,
  type CompletenessStatus,
  type CoverageRegion,
  type FacetVector,
  type FieldValue,
  type IndexRole,
  type ObserverAction,
  type ObserverPage,
  type ObserverStatus,
  type ProductStateKey,
  type QueryInterpretation,
  type RequestBudget,
  type SeedActivation,
  type SupportRecord,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  completenessForInterpretationStatus,
  interpretQuery
} from "../reference/interpret-query.js";
import {
  admitRequestBudget,
  resourceRejectedCompleteness,
  type BindMaxMinResult
} from "../reference/bind-max-min.js";
import {
  scheduleFairWork,
  type FairWorkRegion
} from "../reference/schedule-fair-work.js";
import {
  collectIdentities,
  mergeSeeds,
  mergeTransitions,
  retainSamePathVectors,
  type HyperedgeCompletion,
  type HyperedgePremise
} from "./path-composition.js";
import {
  ACTION_BY_KIND,
  absorbObservations,
  bindEngineState,
  defaultOpenResiduals,
  residualWorkRegions
} from "./field-update.js";

export type FieldObservationEffect = Readonly<{
  readonly observation_id: string;
  readonly seed?: SeedActivation;
  readonly transition?: Transition;
  readonly facet?: FacetVector;
  readonly hyperedge_premises?: readonly HyperedgePremise[];
  readonly hyperedge?: HyperedgeCompletion;
}>;

export type ObserverWorkUnits = Readonly<{
  readonly work_units: number;
}>;

export type ObserverConsumption = Readonly<{
  readonly page: ObserverPage;
  readonly effects?: readonly FieldObservationEffect[];
  readonly work?: ObserverWorkUnits;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
}>;

export type EvidenceEffect = Readonly<{
  readonly support: readonly SupportRecord[];
  readonly claims?: ReadonlyMap<string, ClaimState>;
}>;

export type FieldClosureFacts = Readonly<{
  readonly propagation: "open" | "fixed_point";
  readonly observation: ObserverStatus;
  readonly requested_index: CompletenessStatus;
}>;

export type RemainingWork = Readonly<{
  readonly kind: "state_create" | "join" | "relaxation" | "provenance" | "projection";
  readonly units: number;
}>;

export type CreateFieldInput = Readonly<{
  readonly interpretation: QueryInterpretation;
  readonly budget: RequestBudget;
  readonly roles?: ReadonlyMap<string, IndexRole>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly seeds?: readonly SeedActivation[];
  readonly transitions?: readonly Transition[];
  readonly facets?: readonly FacetVector[];
  readonly support?: readonly SupportRecord[];
  readonly residuals?: readonly CoverageRegion[];
  readonly extra_work_regions?: readonly FairWorkRegion[];
}>;

export type FieldEngineState = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly epoch: number;
  readonly interpretation: QueryInterpretation;
  readonly budget: RequestBudget;
  readonly remaining_exploration: number;
  readonly remaining_reserve: number;
  readonly remaining_memory_bytes: number;
  readonly memory_exhausted: boolean;
  readonly seen_identities: readonly ProductStateKey[];
  readonly identity_spool: readonly ProductStateKey[];
  readonly charged_identity_ids: readonly string[];
  readonly observations: readonly TypedObservation[];
  readonly seeds: readonly SeedActivation[];
  readonly guaranteed_seeds: readonly SeedActivation[];
  readonly transitions: readonly Transition[];
  readonly guaranteed_transitions: readonly Transition[];
  readonly facets: readonly FacetVector[];
  readonly support: readonly SupportRecord[];
  readonly residuals: readonly CoverageRegion[];
  readonly extra_work_regions: readonly FairWorkRegion[];
  readonly binding: BindMaxMinResult;
  readonly claims: ReadonlyMap<string, ClaimState>;
  readonly roles: ReadonlyMap<string, IndexRole>;
  readonly remaining_work: readonly RemainingWork[];
  readonly last_observer_status: ObserverStatus | undefined;
  readonly resume_cursors: Readonly<Record<string, string | null>>;
  readonly closure: FieldClosureFacts;
}>;

export type BindableState = Omit<FieldEngineState, "binding" | "closure">;

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
    budget: input.budget,
    remaining_exploration: input.budget.work_units - input.budget.finalization_reserve,
    remaining_reserve: input.budget.finalization_reserve,
    remaining_memory_bytes: input.budget.memory_bytes,
    memory_exhausted: false,
    seen_identities: identities,
    identity_spool: [],
    charged_identity_ids: [],
    observations: [],
    seeds,
    guaranteed_seeds: seeds,
    transitions,
    guaranteed_transitions: transitions.filter((transition) => transition.applicable),
    facets: retainSamePathVectors(input.facets ?? []),
    support: input.support ?? [],
    residuals,
    extra_work_regions: input.extra_work_regions ?? [],
    claims: input.claims ?? new Map(),
    roles: input.roles ?? new Map(),
    remaining_work: [],
    last_observer_status: undefined,
    resume_cursors: {}
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
  return bindEngineState(absorbObservations(state, consumption));
}

export function applyEvidenceEffect(
  state: FieldEngineState,
  effect: EvidenceEffect
): FieldEngineState {
  const supportById = new Map(state.support.map((record) => [record.proposition_id, record]));
  for (const record of effect.support) supportById.set(record.proposition_id, record);
  const claims = new Map(state.claims);
  if (effect.claims !== undefined) {
    for (const [objectId, claim] of effect.claims) claims.set(objectId, claim);
  }
  const { binding: _binding, closure: _closure, ...rest } = state;
  return bindEngineState({
    ...rest,
    support: Object.freeze([...supportById.values()]),
    claims
  });
}

export function proposeFieldWork(state: FieldEngineState): WorkProposal {
  const extra = state.memory_exhausted
    ? state.extra_work_regions.filter((region) => region.finite)
    : state.extra_work_regions;
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
    budget: input.budget,
    remaining_exploration: 0,
    remaining_reserve: input.budget.finalization_reserve,
    remaining_memory_bytes: input.budget.memory_bytes,
    memory_exhausted: false,
    seen_identities: identities,
    identity_spool: [],
    charged_identity_ids: [],
    observations: [],
    seeds: mergeSeeds(input.seeds ?? []),
    guaranteed_seeds: mergeSeeds(input.seeds ?? []),
    transitions: mergeTransitions(input.transitions ?? []),
    guaranteed_transitions: mergeTransitions(input.transitions ?? []),
    facets: retainSamePathVectors(input.facets ?? []),
    support: input.support ?? [],
    residuals,
    extra_work_regions: input.extra_work_regions ?? [],
    binding,
    claims: input.claims ?? new Map(),
    roles: input.roles ?? new Map(),
    remaining_work: [],
    last_observer_status: undefined,
    resume_cursors: {},
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
