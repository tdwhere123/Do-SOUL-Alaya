import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  type CoverageRegion,
  type ObserverCursor,
  type QueryInterpretation,
  type SnapshotReadLease
} from "@do-soul/alaya-protocol";
import {
  startObserverCursor,
  type ObserverReaders,
  type SourceObserverPage
} from "../conditional-field/observers/observe.js";
import { hasMeasurementProducer } from "../conditional-field/observers/measure-stored.js";
import { resumePathEffects } from "./pending-path-effects.js";
import { bindEngineState } from "../conditional-field/engine/field-update.js";
import { ObservedRelations } from "../conditional-field/engine/observed-relations.js";
import { ObservationPairs, ObservationSubjects } from "../conditional-field/engine/observation-frontier.js";
import {
  applyObserverPage,
  createConditionalField,
  type FieldEngineState
} from "../conditional-field/engine/field-engine.js";
import {
  adjacencyKindsFor,
  hasOpenPairs,
  routingOverlayKinds,
  seedProgramStates
} from "../conditional-field/engine/path-composition.js";
import { collectRelations } from "../conditional-field/query/compile-query.js";
import { ObservedSourceFacts } from "./observed-source-facts.js";
import {
  openResiduals,
  type SourceDomainCoverage
} from "./observe-field-residuals.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";
import {
  RELATION_ROUTING,
  interruptObservedField,
  loadStoredRelationKinds,
  meterReaders,
  reopenAdjacency,
  runObservationRounds
} from "./conditional-field-observe-session.js";
export { RELATION_ROUTING, seedEffects } from "./conditional-field-observe-session.js";

export type ObserveFieldInput = Readonly<{
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: import("@do-soul/alaya-protocol").RequestBudget;
  readonly as_of: string;
  readonly readers: ObserverReaders;
  readonly authorized_scopes?: readonly string[] | null;
  readonly cancelled?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly resume_field?: FieldEngineState;
  readonly expected_source_revision?: string;
  readonly model_id?: string;
  readonly expected_model_id?: string;
  readonly cost?: RequestCostLedger;
}>;

const MAX_FINALIZATION_MEMORY_BYTES = 65_536;

export function observeField(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput
): FieldEngineState {
  const residuals = openResiduals(
    hasMeasurementProducer(input.readers),
    programNeedsGuardWork(interpretation.program),
    sourceDomainCoverageOf(interpretation, input)
  );
  const initial = startObservedField(interpretation, input, residuals);
  // Retained observations still need bytes for grounded explanations and serialized payloads.
  const finalizationBytes = Math.min(initial.remaining_memory_bytes, MAX_FINALIZATION_MEMORY_BYTES,
    Math.max(0, Math.floor((input.budget.memory_bytes - input.budget.min_envelope) / 4)));
  const observed = observeWithinMemory(interpretation, input, {
    ...initial, remaining_memory_bytes: initial.remaining_memory_bytes - finalizationBytes
  });
  return { ...observed, remaining_memory_bytes: observed.remaining_memory_bytes + finalizationBytes };
}

function observeWithinMemory(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput,
  initial: FieldEngineState
): FieldEngineState {
  let state = initial;
  const seedUnitCost = 4 + seedProgramStates(interpretation.program).length
    * Math.max(1, interpretation.hypotheses.length);
  if (input.cancelled === true) return cancelledField(state);
  let expectedRevision = input.expected_source_revision;
  if (expectedRevision === undefined && input.readers.snapshotPin !== undefined) {
    if (state.remaining_exploration < SNAPSHOT_PIN_NATIVE_WORK) return interruptObservedField(state);
    expectedRevision = input.readers.snapshotPin(input.workspace_id).source_revision;
    input.cost?.add("observe", { native_visits: SNAPSHOT_PIN_NATIVE_WORK });
    state = { ...state, remaining_exploration: state.remaining_exploration - SNAPSHOT_PIN_NATIVE_WORK };
  }
  const lease = activeLease(interpretation);
  if (state.pending_path_effects !== undefined) {
    state = resumePathEffects(state);
    if (state.pending_path_effects !== undefined || state.memory_exhausted) return state;
    if (state.last_observer_status === "interrupted") state = { ...state, last_observer_status: "open" };
  }
  const cursors = new Map<string, ObserverCursor>();
  const pairProgress = new ObservationPairs(state.pair_progress, state.pair_completed_count, state.pair_revision);
  for (const region of state.residuals) {
    const regionId = region.region_id;
    const position = input.resume_cursors?.[regionId] !== undefined ? input.resume_cursors[regionId] : state.resume_cursors[regionId];
    if (position === undefined) continue;
    const created = startObserverCursor({
      cursor_id: regionId,
      snapshot_id: interpretation.snapshot_id,
      query_id: interpretation.query_id,
      region_id: regionId
    });
    cursors.set(regionId, {
      ...created,
      position,
      committed_through: position
    });
  }
  const subjects = new ObservationSubjects(state.resume_subjects);
  let relationRows = state.observed_relations instanceof ObservedRelations ? state.observed_relations : new ObservedRelations();
  if (state.observed_relations !== undefined && !(state.observed_relations instanceof ObservedRelations)) {
    for (const row of state.observed_relations) relationRows = relationRows.with(row);
  }
  const observedAt: Record<string, string> = {};
  const sourceFacts = new ObservedSourceFacts(state.source_facts, state.source_fact_bytes);
  const memoryBox = { remaining: state.remaining_memory_bytes, cachedBytes: 0 };
  const sourceCache = new Map<string, SourceObserverPage>();
  const observedInput: ObserveFieldInput = {
    ...input,
    ...(expectedRevision === undefined ? {} : { expected_source_revision: expectedRevision }),
    readers: meterReaders(input.readers, memoryBox, sourceCache)
  };
  let unresolvedGuard = state.observation_gaps?.guards ?? false;
  let missingMeasurement = state.observation_gaps?.measurements ?? false;
  const storedKinds = loadStoredRelationKinds(
    interpretation.program,
    observedInput.readers,
    observedInput.workspace_id,
    state.remaining_exploration
  );
  if (storedKinds.charged > 0) {
    input.cost?.add("observe", { native_visits: storedKinds.charged });
    state = Object.freeze({
      ...state,
      remaining_exploration: Math.max(0, state.remaining_exploration - storedKinds.charged)
    });
  }
  const programKinds = adjacencyKindsFor(interpretation.program, storedKinds.kinds);
  const predicates = [...new Set([
    ...adjacencyKindsFor(
      interpretation.program,
      storedKinds.kinds,
      programKinds.length === 0 ? [] : routingOverlayKinds(RELATION_ROUTING)
    ),
    ...(interpretation.view.claim_demands ?? []).map((demand) => demand.proposition_kind)
  ])];
  if (hasOpenPairs(subjects, predicates, pairProgress, [], pairProgress.completed)) state = reopenAdjacency(state);
  return runObservationRounds({ state, interpretation, input: observedInput, lease, cursors, pairProgress,
    subjects, relationRows, observedAt, sourceFacts, memoryBox, predicates, seedUnitCost,
    storedKindsOpen: storedKinds.open, pairIndex: state.pair_scan_offset, unresolvedGuard, missingMeasurement,
    sourceFamilyUnavailable: false });
}

function startObservedField(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput,
  residuals: readonly CoverageRegion[]
): FieldEngineState {
  const resumed = input.resume_field;
  if (resumed !== undefined
    && resumed.query_id === interpretation.query_id
    && resumed.snapshot_id === interpretation.snapshot_id
    && (resumed.interpretation.interpretation_clock ?? "")
      === (interpretation.interpretation_clock ?? "")) {
    const exploration = Math.max(0, input.budget.work_units - input.budget.finalization_reserve);
    const restored: FieldEngineState = {
      ...resumed,
      interpretation,
      authorized_scopes: input.authorized_scopes,
      budget: input.budget,
      remaining_exploration: exploration,
      remaining_reserve: input.budget.finalization_reserve,
      remaining_memory_bytes: Math.max(0, input.budget.memory_bytes
        - (resumed.pending_path_effects?.retained_bytes ?? 0) - (resumed.binding_context_bytes ?? 0)),
      binding_contexts: resumed.binding_contexts?.snapshot(),
      memory_exhausted: false,
      last_observer_status: resumed.last_observer_status === "interrupted" ? "open" : resumed.last_observer_status,
      retention_rejected: undefined
    };
    if (restored.binding.kind !== "bound" || restored.binding.solver_complete && restored.identity_spool.length === 0) return restored;
    const { binding, ...pending } = restored;
    return bindEngineState({ ...pending, proven_binding: binding });
  }
  return createConditionalField({
    interpretation,
    budget: input.budget,
    residuals,
    authorized_scopes: input.authorized_scopes
  });
}

export function cancelledField(state: FieldEngineState): FieldEngineState {
  return applyObserverPage(state, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: state.query_id,
      snapshot_id: state.snapshot_id,
      cursor: startObserverCursor({
        cursor_id: "cancelled",
        snapshot_id: state.snapshot_id,
        query_id: state.query_id,
        region_id: "seed"
      }),
      observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "cancelled" },
      open_regions: state.residuals.map((region) => ({ ...region, status: "cancelled" as const }))
    },
    effects: []
  });
}

export function emptyField(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput
): FieldEngineState {
  return createConditionalField({
    interpretation,
    budget: input.budget,
    residuals: openResiduals(false, false, sourceDomainCoverageOf(interpretation, input)),
    authorized_scopes: input.authorized_scopes
  });
}

function sourceDomainCoverageOf(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput
): SourceDomainCoverage {
  return {
    resultKindView: interpretation.view.result_kind_view ?? "mixed",
    hasSourceReader: input.readers.sourceRoots !== undefined,
    hypothesisId: interpretation.hypotheses[0]?.hypothesis_id ?? "h0",
    programBranch: "accepting"
  };
}

function programNeedsGuardWork(program: QueryInterpretation["program"]): boolean {
  return collectRelations(program).some((relation) =>
    relation.guard.kind === "equality"
    || relation.guard.kind === "source_bound_entity"
    || (relation.guard.kind === "interval_relation" && relation.guard.time_scope === "associated")
  );
}

function activeLease(interpretation: QueryInterpretation): SnapshotReadLease {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    lease_id: "recall-lease",
    snapshot_id: interpretation.snapshot_id,
    query_id: interpretation.query_id,
    status: "active"
  };
}
