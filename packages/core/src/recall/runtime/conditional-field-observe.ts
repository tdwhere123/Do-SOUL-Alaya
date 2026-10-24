import { meterReaders } from "./observer-reader-budget.js";
import { nativeSourceReaders } from "./native-source-observer.js";
import { nominationScopes } from "./captured-recall-request.js";
import { observationSettled } from "./index-continuation.js";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
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
import { requiresStoredMeasurement } from "../conditional-field/observers/measure-stored.js";
import { resumePathEffects } from "./pending-path-effects.js";
import { bindEngineState } from "../conditional-field/engine/field-update.js";
import { ObservedRelations } from "../conditional-field/engine/observed-relations.js";
import { ObservationPairs, ObservationSubjects } from "../conditional-field/engine/observation-frontier.js";
import {
  applyObserverPage,
  createConditionalField,
  type FieldEngineState
} from "../conditional-field/engine/field-engine.js";
import { adjacencyKindsFor } from "../conditional-field/engine/path-composition-adjacency.js";
import { runtimeProgram, seedProgramStates } from "../conditional-field/engine/path-composition-seed.js";
import { compileProgramAutomaton, programAutomatonCost, ProgramAutomatonResourceError } from "../conditional-field/engine/program-automaton.js";
import { routingOverlayKinds } from "../conditional-field/engine/path-routing.js";
import { authorizedScopesMismatch, viewIdentityMaterial } from "../conditional-field/query/compile-query-identity.js";
import { stableStringify } from "../../shared/stable-stringify.js";
import { collectRelations } from "../conditional-field/query/compile-query.js";
import { ObservedSourceFacts } from "./observed-source-facts.js";
import { indexedIdentityWork } from "../conditional-field/engine/state-endpoint-index.js";
import {
  openResiduals,
  type SourceDomainCoverage
} from "./observe-field-residuals.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";
import { restoredFieldFootprint, restoredFieldRemainingMemory, stampRetainedFieldLevel } from "./request-cost-engine-snapshot.js";
import {
  RELATION_ROUTING,
  interruptObservedField,
  loadStoredRelationKinds,
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
  readonly source_id?: string;
  readonly access_hint?: string;
  readonly cancelled?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly resume_field?: FieldEngineState;
  readonly expected_source_revision?: string;
  readonly model_id?: string;
  readonly expected_model_id?: string;
  readonly cost?: RequestCostLedger;
  readonly on_reused_cost_owner?: (reused: FieldEngineState | undefined) => void;
}>;

const MAX_FINALIZATION_MEMORY_BYTES = 65_536;

export function observeField(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput
): FieldEngineState {
  const residuals = openResiduals(
    requiresStoredMeasurement(interpretation),
    interpretationNeedsGuardWork(interpretation),
    sourceDomainCoverageOf(interpretation, input)
  );
  let initial = startObservedField(interpretation, input, residuals);
  const initialWork = initial.remaining_exploration + initial.remaining_reserve;
  // Use the field's existing finalization reserve, not a second acquisition quota.
  const finalizationBytes = Math.min(initial.remaining_memory_bytes, MAX_FINALIZATION_MEMORY_BYTES,
    Math.max(0, Math.floor((input.budget.memory_bytes - input.budget.min_envelope) / 4)));
  initial = { ...initial, remaining_memory_bytes: initial.remaining_memory_bytes - finalizationBytes };
  if (interpretation.view.enumeration_policy === "native_query" && !input.cancelled
    && interpretation.view.result_kind_view !== "memory_only" && input.authorized_scopes !== undefined
    && input.readers.nominateSources !== undefined) {
    if (initial.native_sources === undefined) {
      const captured = input.readers.nominateSources?.({ workspaceId: input.workspace_id,
        query: input.query_text, authorizedScopes: nominationScopes(input.authorized_scopes),
        ...(input.source_id === undefined ? {} : { sourceId: input.source_id }),
        ...(input.access_hint === undefined ? {} : { hint: input.access_hint }),
        budget: { work_units: initial.remaining_exploration,
          memory_bytes: initial.remaining_memory_bytes } }) ?? null;
      const resources = captured?.result?.resources;
      const work = captured?.charged_by_caller ? 0 : resources?.work ?? 0;
      const bytes = captured?.charged_by_caller ? 0 : resources?.memory_bytes ?? 0;
      initial = { ...initial, native_sources: captured,
        native_source_retained_bytes: captured?.retained_bytes ?? resources?.memory_bytes ?? 0,
        remaining_exploration: initial.remaining_exploration - work,
        remaining_memory_bytes: initial.remaining_memory_bytes - bytes,
        admitted_allocation_bytes: initial.admitted_allocation_bytes + bytes };
      // Engine allocation deltas own these bytes. The acquisition receipt's mixed
      // work units cannot truthfully be relabelled as native visits or joins.
      input.cost?.add("observe", { budget_work: work, native_bytes: captured?.charged_by_caller ? 0 : resources?.native_bytes ?? 0 });
    }
    // An exhausted retained observation has no source-reader call left to make.
    // Rebuilding its frozen frontier would repay acquisition frames merely to
    // acknowledge an empty tail. Payload reads use their own original reader.
    if (input.resume_field === undefined || (!observationSettled(initial) && !retainedProjectionHasPriority(initial, input))) {
      const bridge = new SourceSemanticResourceLedger({ work_units: initial.remaining_exploration,
        memory_bytes: initial.remaining_memory_bytes });
      try {
        input = { ...input, readers: nativeSourceReaders(input.readers, initial.native_sources ?? null, bridge) };
      } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        input = { ...input, readers: { ...input.readers, sourceRoots: undefined, sourceTextHints: undefined,
          boundInterpretations: undefined } };
        initial = { ...initial, last_observer_status: "interrupted" };
      } finally {
        input.cost?.add("observe", { budget_work: bridge.spentWork });
        initial = { ...initial, remaining_exploration: Math.max(0, initial.remaining_exploration - bridge.spentWork),
          remaining_memory_bytes: bridge.bytes,
          admitted_allocation_bytes: initial.admitted_allocation_bytes + bridge.spentBytes };
      }
    }
  }
  const observed = observeWithinMemory(interpretation, input, initial);
  const incompleteNative = observed.native_sources !== undefined
    && (observed.native_sources === null || observed.native_sources.result?.completion !== "complete");
  const nativeStatus = observed.native_sources === null ? "unavailable" as const : "unknown" as const;
  // Preserve the unchanged residual reference: it participates in projection's
  // revision identity. Reallocating the same unknown frontier on every resume
  // would restart a settled membership scan and charge it again.
  const unchangedNative = observed.residuals.some(row => row.region_id === "native-source-membership"
    && row.status === nativeStatus);
  const completed = { ...observed, remaining_memory_bytes: observed.remaining_memory_bytes + finalizationBytes,
    ...(incompleteNative && !unchangedNative ? { residuals: [...observed.residuals.filter(row => row.region_id !== "native-source-membership"),
      { schema_version: 1 as const, region_id: "native-source-membership", kind: "source_domain" as const,
        status: nativeStatus, semantic_effects: ["membership" as const, "order" as const] }] } : {}) };
  input.cost?.addFieldBudgetWork(initialWork - completed.remaining_exploration - completed.remaining_reserve);
  return restoredFieldFootprint(completed) > input.budget.memory_bytes
    ? completed : stampRetainedFieldLevel(completed, input.budget.memory_bytes);
}

function retainedProjectionHasPriority(state: FieldEngineState, input: ObserveFieldInput): boolean {
  return input.resume_field !== undefined && input.budget.page_budget > 0
    && state.binding.kind === "bound" && state.projection_progress !== undefined
    && state.projection_progress.offset < state.binding.snapshot.values.length
    && state.pending_path_effects === undefined && state.remaining_work.length === 0;
}

function observeWithinMemory(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput,
  initial: FieldEngineState
): FieldEngineState {
  let state = initial;
  if (input.cancelled === true) return cancelledField(state);
  if (state.memory_exhausted) return interruptObservedField(state);
  // A resumed, solved frontier already owes projection. Spend this page on that
  // finite frontier before discovering another batch that would invalidate its
  // unfinished facet/grounding scan. Native cursors remain retained and resume
  // after the acknowledged projection frontier catches up.
  if (retainedProjectionHasPriority(state, input)) return state;
  const runtime = runtimeProgram(interpretation.program);
  if (runtime !== "empty" && runtime !== "epsilon" && state.compiled_automaton === undefined) {
    let compilation;
    try { compilation = programAutomatonCost(runtime); }
    catch (error) {
      if (!(error instanceof ProgramAutomatonResourceError)) throw error;
      return { ...interruptObservedField(state), memory_exhausted: true };
    }
    if (compilation.work_units > state.remaining_exploration
      || compilation.retained_bytes > state.remaining_memory_bytes) {
      return { ...interruptObservedField(state),
        memory_exhausted: compilation.retained_bytes > state.remaining_memory_bytes };
    }
    state = { ...state, compiled_automaton: compileProgramAutomaton(runtime),
      compiled_automaton_bytes: compilation.retained_bytes,
      admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + compilation.retained_bytes,
      remaining_exploration: state.remaining_exploration - compilation.work_units,
      remaining_memory_bytes: state.remaining_memory_bytes - compilation.retained_bytes };
    input.cost?.add("observe", { joins: compilation.work_units });
  }
  const seedUnitCost = 4 + seedProgramStates(interpretation.program, state.compiled_automaton).length
    * Math.max(1, interpretation.hypotheses.length) * indexedIdentityWork(state);
  let expectedRevision = input.expected_source_revision;
  if (expectedRevision === undefined && input.readers.snapshotPin !== undefined) {
    if (state.remaining_exploration < SNAPSHOT_PIN_NATIVE_WORK) return interruptObservedField(state);
    expectedRevision = input.readers.snapshotPin(input.workspace_id).source_revision;
    input.cost?.add("observe", { native_visits: SNAPSHOT_PIN_NATIVE_WORK });
    state = { ...state, remaining_exploration: state.remaining_exploration - SNAPSHOT_PIN_NATIVE_WORK };
  }
  const lease = activeLease(interpretation);
  if (state.pending_path_effects !== undefined) {
    const beforePathWork = state.remaining_exploration;
    state = resumePathEffects(state);
    input.cost?.add("adjacency", { joins: Math.max(0, beforePathWork - state.remaining_exploration) });
    if (state.pending_path_effects !== undefined || state.memory_exhausted) return state;
    if (state.last_observer_status === "interrupted") state = { ...state, last_observer_status: "open" };
  }
  const cursors = new Map<string, ObserverCursor>();
  const pairProgress = new ObservationPairs(state.pair_progress, state.pair_completed_count, state.pair_revision,
    state.pair_demands, state.pair_progress_bytes);
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
  let relationRows = state.observed_relations instanceof ObservedRelations ? state.observed_relations
    : state.observed_relations === undefined ? new ObservedRelations() : ObservedRelations.unindexed();
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
  if (pairProgress.hasOpenDemand()) state = reopenAdjacency(state);
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
    // Reuse only the identical interpretation and program; the resource-derived
    // delivery envelope is not interpretation identity.
    && stableStringify({ ...resumed.interpretation, view: viewIdentityMaterial(resumed.interpretation.view) })
      === stableStringify({ ...interpretation, view: viewIdentityMaterial(interpretation.view) })
    && !authorizedScopesMismatch(resumed.authorized_scopes, input.authorized_scopes)
    && resumed.observation_workspace_id === input.workspace_id
    && resumed.observation_query_text === input.query_text
    && resumed.observation_as_of === input.as_of
    && resumed.observation_source_revision === input.expected_source_revision) {
    input.on_reused_cost_owner?.(resumed);
    const exploration = Math.max(0, input.budget.work_units - input.budget.finalization_reserve);
    const restored: FieldEngineState = {
      ...resumed,
      interpretation,
      authorized_scopes: input.authorized_scopes,
      budget: input.budget,
      remaining_exploration: exploration,
      remaining_reserve: input.budget.finalization_reserve,
      remaining_memory_bytes: restoredFieldRemainingMemory(resumed, input.budget.memory_bytes),
      binding_contexts: resumed.binding_contexts?.snapshot(),
      memory_exhausted: false,
      last_observer_status: resumed.last_observer_status === "interrupted" ? "open" : resumed.last_observer_status,
      retention_rejected: undefined
    };
    if (restoredFieldFootprint(resumed) > input.budget.memory_bytes) {
      return { ...interruptObservedField(restored), memory_exhausted: true };
    }
    if (restored.binding.kind !== "bound" || restored.binding.solver_complete && restored.identity_spool.length === 0) return restored;
    const { binding, ...pending } = restored;
    return bindEngineState({ ...pending, proven_binding: binding });
  }
  input.on_reused_cost_owner?.(undefined);
  return { ...createConditionalField({
    interpretation,
    budget: input.budget,
    residuals,
    authorized_scopes: input.authorized_scopes
  }), observation_workspace_id: input.workspace_id,
    observation_query_text: input.query_text, observation_as_of: input.as_of,
    observation_source_revision: input.expected_source_revision };
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

function interpretationNeedsGuardWork(interpretation: QueryInterpretation): boolean {
  if (interpretation.source_guard !== undefined ||
    (interpretation.interpretation_proposal?.conditions?.length ?? 0) > 0) return true;
  return collectRelations(interpretation.program).some((relation) =>
    relation.guard.kind === "equality"
    || relation.guard.kind === "authorization"
    || relation.guard.kind === "source_bound_entity"
    || relation.guard.kind === "query_predicate"
    || relation.guard.kind === "interval_relation"
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
