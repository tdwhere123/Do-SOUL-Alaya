import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  type ObserverCursor,
  type QueryInterpretation,
  type SnapshotReadLease,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  observeConditionalField,
  startObserverCursor,
  type ObserverReaders,
  type RelationObserverRow
} from "../conditional-field/observers/observe.js";
import { sourceFamilySettled } from "../conditional-field/observers/source-root-observe.js";
import { hasMeasurementProducer, requiresStoredMeasurement } from "../conditional-field/observers/measure-stored.js";
import { measurementEffectsFor, measurementIsMissing } from "./measurement-effects.js";
import { resumePathEffects } from "./pending-path-effects.js";
import { BindingContextStore, BindingContextResourceError } from "../conditional-field/engine/binding-environment.js";
import { ObservedRelations, relationPageJoinRows, retainRelationPage } from "../conditional-field/engine/observed-relations.js";
import { ObservationPairs, ObservationSubjects, SourceFactDemands } from "../conditional-field/engine/observation-frontier.js";
import {
  applyObserverPage,
  proposeFieldWork,
  type FieldEngineState,
  type FieldObservationEffect
} from "../conditional-field/engine/field-engine.js";
import { programRelationKinds } from "../conditional-field/engine/path-composition-adjacency.js";
import { seedActivationsForObservation } from "../conditional-field/engine/path-composition-seed.js";
import { overlayIsRoutingOnly, pairKey } from "../conditional-field/engine/path-routing.js";
import { STORED_RELATION_KIND } from "../conditional-field/query/ordinary-language.js";
import { ObservedSourceFacts, recordObservedAt, recordSourceRootFacts, retainSourceFact } from "./observed-source-facts.js";
import { sourceFactEligible } from "../conditional-field/observers/observation-admission.js";
import {
  closeAdjacency,
  closeRegion,
  cursorOf,
  incompleteObserver,
  settleDiscoveryResidual,
  settleSourceDomainResidual,
  terminalObserver,
  type SourceDomainCoverage
} from "./observe-field-residuals.js";
import type { ObserveFieldInput } from "./conditional-field-observe.js";
import type { RequestCostPhase } from "./request-cost-ledger.js";
import { CoreError } from "../../shared/errors.js";

const MAX_OBSERVE_ROUNDS = 4_096;
const SEED_PAGE_SIZE = 32;
const ADJACENCY_PAGE_SIZE = 16;
export const RELATION_ROUTING = Object.freeze({
  observed_log: { applicable: true, role: "associated" },
  config_via_log: { applicable: true, role: "associated" },
  config_direct: { applicable: true, role: "associated" },
  uses_service: { applicable: true, role: "routing_only" },
  service_history: { applicable: true, role: "associated" },
  unrelated: { applicable: false, role: "associated" }
});

type ObservationAction = ReturnType<typeof proposeFieldWork>["actions"][number];
export type ObservationSession = {
  state: FieldEngineState; interpretation: QueryInterpretation; input: ObserveFieldInput; lease: SnapshotReadLease;
  cursors: Map<string, ObserverCursor>; pairProgress: ObservationPairs; subjects: ObservationSubjects;
  relationRows: ObservedRelations; observedAt: Record<string, string>; sourceFacts: ObservedSourceFacts;
  memoryBox: { remaining: number; cachedBytes: number }; predicates: readonly string[]; seedUnitCost: number;
  storedKindsOpen: boolean; pairIndex: number; unresolvedGuard: boolean; missingMeasurement: boolean;
  sourceFamilyUnavailable: boolean;
};

export function runObservationRounds(session: ObservationSession): FieldEngineState {
  const { input, interpretation, memoryBox } = session;
  for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
    memoryBox.remaining = Math.max(0, session.state.remaining_memory_bytes - memoryBox.cachedBytes);
    const seedFirst = session.state.pending_path_effects === undefined && session.state.pair_demands.size === 0
      && session.state.residuals.some((region) => region.kind === "seed"
        && (region.status === "open" || region.status === "interrupted"));
    if (!seedFirst && refreshPathFrontier(session)) return session.state;
    if (consumeBoundSourceFact(session)) {
      if (session.state.last_observer_status === "interrupted" || terminalObserver(session.state.last_observer_status)) return session.state;
      continue;
    }
    if (terminalObserver(session.state.last_observer_status)) break;
    const proposal = proposeFieldWork(session.state);
    if (proposal.actions.length === 0) break;
    for (const proposed of proposal.actions) {
      const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
      const capacity = Math.floor((session.state.remaining_exploration - pinWork - 1) / session.seedUnitCost);
      const batchedRows = proposed.action === "seed" ? 4 * Math.max(0, Math.min(SEED_PAGE_SIZE, capacity))
        : proposed.action === "adjacency" ? 4 * Math.max(0, Math.min(ADJACENCY_PAGE_SIZE, capacity))
        : Math.max(4096, ...interpretation.interpretation_proposal?.stored_cosine_admission?.obligations.map((row) => row.dimensions + 10) ?? []);
      const action = { ...proposed, work_limit: Math.min(batchedRows + pinWork, session.state.remaining_exploration) };
      const minimum = (action.action === "seed" || action.action === "adjacency" ? 4 : 1) + pinWork;
      if (action.work_limit < minimum) return interruptObservedField(session.state);
      if (action.action === "seed") {
        if (phaseTime(session, "seed", () => consumeSeedPage(session, action))) return session.state;
      } else if (action.action === "measurement") {
        if (phaseTime(session, "measurement", () => consumeMeasurementPage(session, action))) return session.state;
      } else if (action.action === "relation") {
        // Later seed and adjacency pages can still introduce unresolved guards.
        // Their absence is conclusive only after those producers have settled.
        if (session.state.pending_path_effects !== undefined || session.state.residuals.some((region) =>
          (region.kind === "seed" || region.kind === "adjacency" || region.kind === "binding") &&
          (region.status === "open" || region.status === "interrupted"))) continue;
        session.state = closeRegion(session.state, interpretation, action, session.cursors,
          session.unresolvedGuard || session.missingMeasurement || (session.state.unresolved_seed_count ?? 0) > 0
            ? "unknown" : "exhausted");
      } else {
        if (incompleteObserver(session.state.last_observer_status)) break;
        if (phaseTime(session, "adjacency", () => consumeAdjacencyPage(session, action))) return session.state;
      }
    }
  }
  const settled = settleSourceDomainResidual(
    settleDiscoveryResidual(session.state, interpretation, session.cursors,
      session.pairProgress),
    interpretation, session.cursors, sourceDomainSettleCoverage(session));
  return Object.freeze({ ...settled,
    pair_progress: session.pairProgress.snapshot, pair_completed_count: session.pairProgress.completed,
    pair_revision: session.pairProgress.revision, pair_progress_bytes: session.pairProgress.bytes,
    pair_scan_offset: session.pairIndex,
    pair_demands: session.pairProgress.demanded, resume_subjects: session.subjects.snapshot });
}

function consumeSeedPage(session: ObservationSession, action: ObservationAction): boolean {
  const { input, interpretation, lease, cursors, pairProgress, subjects, observedAt, sourceFacts } = session;
  const before = session.state;
  const observed = observeSeed(input, interpretation, lease, action, cursors, observedAt);
  recordObserverWork(session, "seed", observed);
  cursors.set(action.region_id, observed.page.cursor);
  const seedIds = observed.page.observations.filter((row) => row.target?.kind !== "source_evidence" &&
    row.applicability.verdict !== "false").map((row) => row.object_id);
  addSubjects(subjects, seedIds);
  recordObservedAt(input, seedIds, observedAt, sourceFacts);
  recordSourceRootFacts(observed.source_roots ?? [], observed.page.observations, sourceFacts);
  if (input.readers.sourceRoots !== undefined
    && observed.page.outcome.status === "unavailable"
    && !sourceFamilySettled(observed.page.cursor.committed_through)) {
    session.sourceFamilyUnavailable = true;
  }
  const bindingContexts = forkBindingContexts(session.state);
  let effects: readonly FieldObservationEffect[];
  try { effects = seedEffects(observed.page.observations, interpretation, input.as_of, bindingContexts,
    session.state.compiled_automaton); }
  catch (error) { return rejectBindingResource(session, error); }
  session.state = applyObserverPage({ ...retainBindingContexts(session.state, bindingContexts), resume_subjects: subjects.snapshot }, { page: observed.page,
    effects, work: observed.work,
    resume_cursors: resumeCursors(cursors, pairProgress) });
  if (session.state.retention_rejected !== undefined || session.state.memory_exhausted) return true;
  subjects.snapshot = session.state.resume_subjects;
  session.state = retainObservedContext(before, session.state, sourceFacts, session.relationRows, subjects, pairProgress);
  if (session.state.memory_exhausted) return true;
  if (pairProgress.hasOpenDemand()) {
    session.state = reopenAdjacency(session.state);
  }
  if (refreshPathFrontier(session)) return true;
  if (observed.page.outcome.status !== "interrupted") return false;
  if (observed.page.cursor.committed_through === (before.resume_cursors[action.region_id] ?? null)) return true;
  session.state = { ...session.state, last_observer_status: "open" };
  return false;
}

function refreshPathFrontier(session: ObservationSession): boolean {
  const { state, interpretation, input, relationRows, sourceFacts } = session;
  const frontier = state.path_effect_frontier;
  if (frontier !== undefined && frontier.identities === state.seen_identities.length
    && frontier.facets === state.facets && frontier.discoveries === state.discoveries.length
    && frontier.sourceFacts === state.source_facts) return false;
  const factPopulationChanged = frontier !== undefined && frontier.sourceFacts !== state.source_facts;
  const rechecking = factPopulationChanged ? { ...state, residuals: state.residuals.map((region) =>
    region.kind === "guard" && (region.status === "unknown" || region.status === "exhausted")
      ? { ...region, status: "open" as const } : region) } : state;
  const region = state.residuals.find((entry) => entry.kind === "adjacency");
  const regionId = region?.region_id ?? "adjacency";
  const cursor = session.cursors.get(regionId) ?? startObserverCursor({ cursor_id: regionId,
    query_id: interpretation.query_id, snapshot_id: interpretation.snapshot_id, region_id: regionId });
  const beforeWork = state.remaining_exploration;
  session.state = resumePathEffects({ ...rechecking, pending_path_effects: { input: { rows: relationRows, options: {
    interpretation, asOf: input.as_of, liveStates: state.seen_identities,
    liveStateOffset: frontier === undefined || frontier.facets !== state.facets
      || frontier.sourceFacts !== state.source_facts
      || (state.observation_gaps?.guards === true && state.seen_identities.length > frontier.identities) ? 0 : frontier.identities,
    overlay: RELATION_ROUTING, sourceFacts: sourceFacts.snapshot, facets: state.facets, discoveries: state.discoveries,
    bindingContexts: state.binding_contexts, physicalKinds: session.predicates,
    compiledAutomaton: state.compiled_automaton } },
    offset: 0, retained_bytes: 0, page: { schema_version: 1, query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id, cursor, observations: [], outcome: { schema_version: 1, status: "open" },
      open_regions: [{ schema_version: 1, region_id: regionId, kind: "adjacency", status: "open" }] } } });
  input.cost?.add("adjacency", { joins: Math.max(0, beforeWork - session.state.remaining_exploration) });
  session.subjects.snapshot = session.state.resume_subjects;
  session.pairProgress.demanded = session.state.pair_demands;
  session.unresolvedGuard = session.state.observation_gaps?.guards === true;
  session.missingMeasurement ||= session.state.observation_gaps?.measurements === true;
  return session.state.pending_path_effects !== undefined || session.state.memory_exhausted;
}

function consumeMeasurementPage(session: ObservationSession, action: ObservationAction): boolean {
  const { input, interpretation, lease, cursors, pairProgress } = session;
  if (!requiresStoredMeasurement(interpretation)) {
    session.state = closeRegion(session.state, interpretation, action, cursors, "exhausted");
    return false;
  }
  if (!hasMeasurementProducer(input.readers)) {
    session.missingMeasurement = true;
    session.state = closeRegion(session.state, interpretation, action, cursors, "unknown");
    return false;
  }
  const observed = observeMeasurement(input, interpretation, lease, action, cursors);
  recordObserverWork(session, "measurement", observed);
  cursors.set(action.region_id, observed.page.cursor);
  const bindingContexts = forkBindingContexts(session.state);
  let effects: readonly FieldObservationEffect[];
  try { effects = measurementEffectsFor(observed, interpretation, input.as_of, session.state.measurements,
    bindingContexts, session.state.compiled_automaton); }
  catch (error) { return rejectBindingResource(session, error); }
  session.missingMeasurement ||= measurementIsMissing(effects);
  session.state = applyObserverPage(retainBindingContexts(session.state, bindingContexts), { page: observed.page, effects, work: observed.work,
    resume_cursors: resumeCursors(cursors, pairProgress) });
  if (session.missingMeasurement) session.state = { ...session.state,
    observation_gaps: { guards: session.unresolvedGuard, measurements: true } };
  if (observed.page.outcome.status === "interrupted") return true;
  if (observed.page.outcome.status === "exhausted") session.state = closeRegion(session.state, interpretation,
    action, cursors, session.missingMeasurement ? "unknown" : "exhausted");
  return false;
}

function consumeAdjacencyPage(session: ObservationSession, action: ObservationAction): boolean {
  const { input, interpretation, lease, cursors, pairProgress, subjects, observedAt, sourceFacts } = session;
  const minimum = 4 + (input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK);
  const scanned = pairProgress.nextDemand(session.pairIndex,
    Math.max(0, session.state.remaining_exploration - minimum));
  const separator = scanned.key?.indexOf("\0") ?? -1;
  const pair = separator < 0 ? undefined : { subject: scanned.key!.slice(0, separator), predicate: scanned.key!.slice(separator + 1) };
  session.pairIndex = scanned.next;
  if (scanned.work > 0) session.input.cost?.add("adjacency", { joins: scanned.work });
  session.state = { ...session.state, pair_scan_offset: scanned.next,
    remaining_exploration: session.state.remaining_exploration - scanned.work };
  action = { ...action, work_limit: Math.min(action.work_limit, session.state.remaining_exploration) };
  if (pair === undefined) {
    if (pairProgress.hasOpenDemand()) {
      session.state = interruptObservedField(session.state); return true;
    }
    session.state = closeAdjacency(session.state, interpretation, action, cursors, session.storedKindsOpen);
    return false;
  }
  const captured: RelationObserverRow[] = [];
  const factsBefore = sourceFacts.snapshot;
  const observed = observeAdjacency(input, interpretation, lease, action, cursors, pair, captured, pairProgress, observedAt, sourceFacts);
  recordObserverWork(session, "adjacency", observed);
  cursors.set(action.region_id, observed.page.cursor);
  const completedPair = new ObservationPairs(pairProgress.snapshot, pairProgress.completed,
    pairProgress.revision, pairProgress.demanded, pairProgress.bytes);
  const key = pairKey(pair.subject, pair.predicate);
  completedPair.set(key, observed.page.cursor.committed_through);
  if (observed.page.outcome.status === "exhausted") completedPair.set(`${key}:done`, "1");
  if (captured.length === 0) {
    const pairBytes = completedPair.bytes - pairProgress.bytes;
    if (pairBytes > session.state.remaining_memory_bytes) {
      session.state = { ...interruptObservedField(session.state), memory_exhausted: true,
        remaining_exploration: Math.max(0, session.state.remaining_exploration - observed.work.work_units) };
      return true;
    }
    const before = session.state;
    session.state = applyObserverPage({ ...before, pair_progress: completedPair.snapshot,
      pair_completed_count: completedPair.completed, pair_revision: completedPair.revision,
      pair_progress_bytes: completedPair.bytes,
      admitted_allocation_bytes: (before.admitted_allocation_bytes ?? 0) + pairBytes,
      remaining_memory_bytes: session.state.remaining_memory_bytes - pairBytes }, {
      page: maskAdjacencyExhaustion(observed.page, completedPair.hasOpenDemand()),
      work: observed.work, resume_cursors: resumeCursors(cursors, completedPair) });
    if (session.state.retention_rejected !== undefined || session.state.memory_exhausted) {
      const rejected = session.state;
      session.state = { ...interruptObservedField(before),
        remaining_exploration: rejected.remaining_exploration,
        remaining_reserve: rejected.remaining_reserve,
        memory_exhausted: rejected.memory_exhausted,
        retention_rejected: rejected.retention_rejected };
      return true;
    }
    pairProgress.snapshot = completedPair.snapshot;
    pairProgress.completed = completedPair.completed;
    pairProgress.revision = completedPair.revision;
    pairProgress.bytes = completedPair.bytes;
    return observed.page.outcome.status === "interrupted";
  }
  const retained = retainRelationPage(session.relationRows, captured);
  session.relationRows = retained.population;
  recordObservedAt(input, captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]), observedAt, sourceFacts);
  // A new endpoint fact must be visible to retained rows. The continuation
  // still clears joinRows so new states meet the full population.
  const joinRows = relationPageJoinRows(retained.population, retained.changed, sourceFacts.snapshot !== factsBefore);
  for (const row of captured) if (!overlayIsRoutingOnly(RELATION_ROUTING, row.predicate)) {
    addSubjects(subjects, [row.sourceObjectId, row.targetObjectId]);
  }
  const before = session.state;
  session.state = { ...session.state, remaining_exploration: Math.max(0, session.state.remaining_exploration - observed.work.work_units),
    pending_path_effects: { input: { rows: session.relationRows, options: {
      interpretation, asOf: input.as_of, liveStates: session.state.seen_identities, overlay: RELATION_ROUTING,
      sourceFacts: sourceFacts.snapshot, facets: session.state.facets, discoveries: session.state.discoveries,
      physicalKinds: session.predicates, compiledAutomaton: session.state.compiled_automaton,
      bindingContexts: session.state.binding_contexts,
      ...(joinRows === undefined ? {} : { joinRows }) } },
      offset: 0, retained_bytes: 0,
      page: maskAdjacencyExhaustion(observed.page, completedPair.hasOpenDemand()) },
    resume_cursors: resumeCursors(cursors, completedPair) };
  session.state = retainObservedContext(before, session.state, sourceFacts, session.relationRows, subjects, completedPair);
  if (session.state.memory_exhausted) return true;
  pairProgress.snapshot = completedPair.snapshot;
  pairProgress.completed = completedPair.completed;
  pairProgress.revision = completedPair.revision;
  pairProgress.bytes = completedPair.bytes;
  const beforePathWork = session.state.remaining_exploration;
  session.state = resumePathEffects(session.state);
  input.cost?.add("adjacency", { joins: Math.max(0, beforePathWork - session.state.remaining_exploration) });
  pairProgress.demanded = session.state.pair_demands;
  session.unresolvedGuard = session.state.observation_gaps?.guards === true;
  session.missingMeasurement ||= session.state.observation_gaps?.measurements === true;
  if (session.state.pending_path_effects !== undefined || session.state.memory_exhausted) return true;
  subjects.snapshot = session.state.resume_subjects;
  if (pairProgress.hasOpenDemand()) session.state = reopenAdjacency(session.state);
  if (observed.page.outcome.status === "interrupted") {
    if ((before.pair_progress.get(pairKey(pair.subject, pair.predicate)) ?? null) === observed.page.cursor.committed_through) return true;
    session.state = { ...session.state, last_observer_status: "open" };
  }
  return false;
}

export function interruptObservedField(state: FieldEngineState): FieldEngineState {
  return { ...state, last_observer_status: "interrupted",
    closure: { ...state.closure, observation: "interrupted", requested_index: "open" },
    residuals: state.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
}

export function reopenAdjacency(state: FieldEngineState): FieldEngineState {
  return { ...state, last_observer_status: "open", residuals: state.residuals.map((region) =>
    (region.kind === "adjacency" || region.kind === "discovery") && region.status === "exhausted"
      ? { ...region, status: "open" } : region) };
}

function retainObservedContext(
  before: FieldEngineState, state: FieldEngineState,
  facts: ObservedSourceFacts, relations: ObservedRelations,
  subjects: ObservationSubjects, pairProgress: ObservationPairs
): FieldEngineState {
  const relationBytes = relations.bytes;
  const bytes = facts.bytes - (before.source_fact_bytes ?? 0) + relationBytes - (before.observed_relation_bytes ?? 0)
    + pairProgress.bytes - before.pair_progress_bytes;
  if (bytes > state.remaining_memory_bytes) return { ...before,
    remaining_exploration: state.remaining_exploration, memory_exhausted: true, last_observer_status: "interrupted",
    closure: { ...before.closure, observation: "interrupted", requested_index: "open" },
    residuals: before.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
  return { ...state, source_facts: facts.snapshot, source_fact_bytes: facts.bytes,
    observed_relations: relations, observed_relation_bytes: relationBytes,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + Math.max(0, bytes),
    remaining_memory_bytes: state.remaining_memory_bytes - bytes,
    pair_progress: pairProgress.snapshot, pair_completed_count: pairProgress.completed,
    pair_revision: pairProgress.revision, pair_progress_bytes: pairProgress.bytes,
    resume_subjects: subjects.snapshot };
}


function observeSeed(
  input: ObserveFieldInput,
  interpretation: QueryInterpretation,
  lease: SnapshotReadLease,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>,
  observedAt: Record<string, string>
) {
  return observeConditionalField({
    lease,
    action,
    cursor: cursorOf(cursors, interpretation, action.region_id),
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: input.readers,
    seed_query: input.query_text,
    page_limit: observerPageLimit(SEED_PAGE_SIZE, action.work_limit, input),
    authorized_scopes: input.authorized_scopes,
    object_observed_at: observedAt,
    as_of: input.as_of,
    ...pinExpectation(input)
  });
}

function observeMeasurement(
  input: ObserveFieldInput,
  interpretation: QueryInterpretation,
  lease: SnapshotReadLease,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>
) {
  return observeConditionalField({
    lease,
    action,
    cursor: cursorOf(cursors, interpretation, action.region_id),
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: input.readers,
    seed_query: input.query_text,
    as_of: input.as_of,
    authorized_scopes: input.authorized_scopes,
    ...pinExpectation(input)
  });
}

function observeAdjacency(
  input: ObserveFieldInput,
  interpretation: QueryInterpretation,
  lease: SnapshotReadLease,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>,
  pair: Readonly<{ readonly subject: string; readonly predicate: string }>,
  captured: RelationObserverRow[],
  pairProgress: ObservationPairs,
  observedAt: Record<string, string>,
  sourceFacts: ObservedSourceFacts
) {
  const key = pairKey(pair.subject, pair.predicate);
  const cursor = {
    ...cursorOf(cursors, interpretation, action.region_id),
    committed_through: pairProgress.get(key) ?? null
  };
  const observed = observeConditionalField({
    lease,
    action,
    cursor,
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: capturingReaders(input.readers, captured),
    relation_subject: pair.subject,
    page_limit: observerPageLimit(ADJACENCY_PAGE_SIZE, action.work_limit, input),
    relation_kind: pair.predicate,
    authorized_scopes: input.authorized_scopes,
    object_observed_at: observedAt,
    as_of: input.as_of,
    ...pinExpectation(input)
  });
  const kept = new Set(observed.page.observations.map((row) => row.observation_id));
  const eligible = captured.filter((row) => kept.has(`${action.region_id}:${row.assertionId}`));
  captured.length = 0;
  captured.push(...eligible);
  recordObservedAt(
    input,
    captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]),
    observedAt,
    sourceFacts
  );
  return observed;
}

export function loadStoredRelationKinds(
  program: QueryInterpretation["program"],
  readers: ObserverReaders,
  workspaceId: string,
  remainingExploration: number
): Readonly<{ readonly kinds: readonly string[]; readonly charged: number; readonly open: boolean }> {
  if (!programRelationKinds(program).includes(STORED_RELATION_KIND)) {
    return { kinds: [], charged: 0, open: false };
  }
  const listed = readers.relationKinds;
  if (listed === undefined) return { kinds: [], charged: 0, open: true };
  if (remainingExploration < 1) return { kinds: [], charged: 0, open: true };
  const limit = Math.min(32, remainingExploration);
  const kinds = listed({ workspaceId, subject: null, limit });
  return { kinds, charged: Math.min(limit, kinds.length + 1), open: kinds.length === limit };
}

export function seedEffects(
  observations: readonly TypedObservation[],
  interpretation: QueryInterpretation,
  asOf: string,
  bindingContexts?: BindingContextStore,
  compiled?: FieldEngineState["compiled_automaton"]
): readonly FieldObservationEffect[] {
  return observations.flatMap((observation) =>
    seedActivationsForObservation(observation, interpretation, asOf, bindingContexts, compiled).map((seed) => ({
      observation_id: `${observation.observation_id}:${seed.state.hypothesis_id}:${seed.state.program_state}`,
      seed,
      admitted_seed: true as const
    }))
  );
}

function forkBindingContexts(state: FieldEngineState): BindingContextStore {
  return state.binding_contexts?.fork(state.remaining_memory_bytes) ?? new BindingContextStore(state.remaining_memory_bytes);
}

function retainBindingContexts(state: FieldEngineState, owner: BindingContextStore): FieldEngineState {
  const added = owner.bytes - (state.binding_contexts?.bytes ?? 0);
  return { ...state, binding_contexts: owner.snapshot(), binding_context_bytes: owner.bytes,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + Math.max(0, added),
    remaining_memory_bytes: state.remaining_memory_bytes - added };
}

function rejectBindingResource(session: ObservationSession, error: unknown): true {
  if (!(error instanceof BindingContextResourceError)) throw error;
  session.state = { ...interruptObservedField(session.state), memory_exhausted: true, retention_rejected: "memory" };
  return true;
}


function capturingReaders(
  readers: ObserverReaders,
  captured: RelationObserverRow[]
): ObserverReaders {
  const relation = readers.relation;
  if (relation === undefined) return readers;
  return {
    ...readers,
    relation: (input) => {
      const page = relation(input);
      captured.push(...page.observations);
      return page;
    }
  };
}

function maskAdjacencyExhaustion(
  page: ReturnType<typeof observeConditionalField>["page"],
  stillOpen: boolean
): ReturnType<typeof observeConditionalField>["page"] {
  if (!stillOpen || page.outcome.status !== "exhausted") return page;
  return {
    ...page,
    outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
    open_regions: page.open_regions.map((region) =>
      region.kind === "adjacency" ? { ...region, status: "open" as const } : region)
  };
}

function addSubjects(subjects: ObservationSubjects, ids: readonly string[]): void {
  for (const id of ids) subjects.add(id);
}

function phaseTime<T>(session: ObservationSession, phase: RequestCostPhase, run: () => T): T {
  return session.input.cost?.time(phase, run) ?? run();
}

function recordObserverWork(
  session: ObservationSession,
  phase: RequestCostPhase,
  observed: ReturnType<typeof observeConditionalField>
): void {
  session.input.cost?.add(phase, {
    native_visits: observed.work.native_visits,
    native_rows: observed.page.observations.length,
    native_bytes: observed.work.bytes_read
  });
}

function observerPageLimit(
  pageSize: number,
  workLimit: number,
  input: ObserveFieldInput
): number {
  const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
  return Math.min(pageSize, Math.floor((workLimit - pinWork) / 4));
}

function pinExpectation(input: ObserveFieldInput): Readonly<{
  readonly expected_source_revision?: string;
  readonly model_id?: string;
  readonly expected_model_id?: string;
}> {
  const revision = input.expected_source_revision;
  return {
    ...(revision === undefined ? {} : { expected_source_revision: revision }),
    ...(input.model_id === undefined ? {} : { model_id: input.model_id }),
    ...(input.expected_model_id === undefined ? {} : { expected_model_id: input.expected_model_id })
  };
}

function resumeCursors(
  cursors: Map<string, ObserverCursor>,
  _pairProgress: ObservationPairs
): Readonly<Record<string, string | null>> {
  const resume: Record<string, string | null> = {};
  for (const [regionId, cursor] of cursors) resume[regionId] = cursor.committed_through;
  return resume;
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

export function sourceDomainSettleCoverage(session: ObservationSession): SourceDomainCoverage {
  const coverage = sourceDomainCoverageOf(session.interpretation, session.input);
  // Memory-seed exhaustion is not source-domain coverage.
  if (coverage.hasSourceReader !== true) return coverage;
  const seed = session.state.residuals.find((region) => region.kind === "seed");
  const cursor = seed === undefined
    ? undefined
    : session.cursors.get(seed.region_id) ?? session.cursors.get(seed.cursor_id ?? seed.region_id);
  const settled = sourceFamilySettled(cursor?.committed_through);
  return {
    ...coverage,
    truncated: !settled,
    unavailable: session.sourceFamilyUnavailable
      || (seed?.status === "unavailable" && !settled),
    settled
  };
}

function consumeBoundSourceFact(session: ObservationSession): boolean {
  const { input } = session;
  const demands = new SourceFactDemands(session.state.source_fact_demands,
    session.state.source_fact_pending_count, session.state.source_fact_scan_offset,
    session.state.source_fact_demand_bytes);
  if (!demands.hasPending()) return false;
  const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
  // One indexed lookup and the maximum one-row source read must both fit before
  // invoking the reader. A completed fact can use less, but never more.
  const readReserve = 3 + pinWork;
  if (session.state.remaining_exploration < 1 + readReserve) {
    session.state = interruptObservedField(session.state);
    return true;
  }
  const pending = demands.nextPending(session.state.remaining_exploration - readReserve);
  input.cost?.add("observe", { joins: pending.work });
  session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - pending.work,
    source_fact_scan_offset: pending.index ?? pending.next };
  if (pending.key === undefined) {
    session.state = interruptObservedField(session.state);
    return true;
  }
  const objectId = pending.key;
  if (session.sourceFacts.has(objectId)) {
    demands.complete(objectId);
    input.cost?.add("observe", { joins: 1 });
    session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - 1,
      source_fact_demands: demands.snapshot, source_fact_pending_count: demands.pending,
      source_fact_scan_offset: pending.next };
    return true;
  }
  const pin = input.readers.snapshotPin?.(input.workspace_id);
  if (pinWork > 0) {
    input.cost?.add("observe", { native_visits: pinWork });
    session.state = { ...session.state, remaining_exploration: session.state.remaining_exploration - pinWork };
  }
  if (pin !== undefined && input.expected_source_revision !== undefined
    && pin.source_revision !== input.expected_source_revision) {
    session.state = applyObserverPage(session.state, { page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: session.interpretation.query_id, snapshot_id: session.interpretation.snapshot_id,
      cursor: cursorOf(session.cursors, session.interpretation, "adjacency"), observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "invalidated" },
      open_regions: session.state.residuals.map((region) => ({ ...region, status: "invalidated" as const }))
    }, effects: [] });
    return true;
  }
  const page = input.readers.source?.({ workspaceId: input.workspace_id, objectId });
  if (page !== undefined && (!Number.isSafeInteger(page.rowsRead) || page.rowsRead < 0 || page.rowsRead > 1)) {
    throw new CoreError("OBLIGATION_VIOLATION", "source reader must report at most one row for one object");
  }
  const work = 2 + (page?.rowsRead ?? 0);
  input.cost?.add("observe", { native_visits: (page === undefined ? 0 : 1) + (page?.rowsRead ?? 0),
    native_rows: page?.rowsRead ?? 0, native_bytes: page?.bytesRead ?? 0 });
  const charged = { ...session.state, remaining_exploration: session.state.remaining_exploration - work };
  if (page?.resourceLimited === true) {
    session.state = interruptObservedField(charged);
    return true;
  }
  const sourceFacts = new ObservedSourceFacts(session.sourceFacts.snapshot, session.sourceFacts.bytes);
  if (page?.unavailable !== true && page?.row !== null && page?.row !== undefined
    && sourceFactEligible(page.row, input.authorized_scopes, input.as_of)) {
    retainSourceFact(sourceFacts, objectId, page.row, input.workspace_id, session.observedAt);
  }
  const retainedBytes = sourceFacts.bytes - session.sourceFacts.bytes;
  if (retainedBytes > charged.remaining_memory_bytes) {
    session.state = { ...interruptObservedField(charged), memory_exhausted: true };
    return true;
  }
  demands.complete(objectId);
  session.sourceFacts = sourceFacts;
  session.state = { ...charged,
    remaining_memory_bytes: charged.remaining_memory_bytes - retainedBytes,
    admitted_allocation_bytes: (charged.admitted_allocation_bytes ?? 0) + retainedBytes,
    source_facts: sourceFacts.snapshot, source_fact_bytes: sourceFacts.bytes,
    source_fact_demands: demands.snapshot, source_fact_pending_count: demands.pending,
    source_fact_scan_offset: pending.next };
  return true;
}
