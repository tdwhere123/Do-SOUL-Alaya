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
  type RelationObserverRow,
  type SourceObserverPage
} from "../conditional-field/observers/observe.js";
import { sourceFamilySettled } from "../conditional-field/observers/source-root-observe.js";
import { hasMeasurementProducer } from "../conditional-field/observers/measure-stored.js";
import { measurementEffectsFor, measurementIsMissing } from "./measurement-effects.js";
import { resumePathEffects } from "./pending-path-effects.js";
import { BindingContextStore, BindingContextResourceError } from "../conditional-field/engine/binding-environment.js";
import { ObservedRelations } from "../conditional-field/engine/observed-relations.js";
import { ObservationPairs, ObservationSubjects } from "../conditional-field/engine/observation-frontier.js";
import { scanAdjacencyPairs } from "../conditional-field/engine/path-routing.js";
import {
  applyObserverPage,
  proposeFieldWork,
  type FieldEngineState,
  type FieldObservationEffect
} from "../conditional-field/engine/field-engine.js";
import {
  hasOpenPairs,
  overlayIsRoutingOnly,
  pairKey,
  programRelationKinds,
  seedActivationsForObservation
} from "../conditional-field/engine/path-composition.js";
import { STORED_RELATION_KIND } from "../conditional-field/query/ordinary-language.js";
import { ObservedSourceFacts, recordObservedAt, recordSourceRootFacts } from "./observed-source-facts.js";
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
    if (refreshPathFrontier(session)) return session.state;
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
        session.state = closeRegion(session.state, interpretation, action, session.cursors,
          session.unresolvedGuard || session.missingMeasurement ? "unknown" : "exhausted");
      } else {
        if (incompleteObserver(session.state.last_observer_status)) break;
        if (phaseTime(session, "adjacency", () => consumeAdjacencyPage(session, action))) return session.state;
      }
    }
  }
  const settled = settleSourceDomainResidual(
    settleDiscoveryResidual(session.state, interpretation, session.cursors,
      session.subjects, session.predicates, session.pairProgress),
    interpretation, session.cursors, sourceDomainSettleCoverage(session));
  return Object.freeze({ ...settled,
    pair_progress: session.pairProgress.snapshot, pair_completed_count: session.pairProgress.completed,
    pair_revision: session.pairProgress.revision, pair_scan_offset: session.pairIndex, resume_subjects: session.subjects.snapshot });
}

function consumeSeedPage(session: ObservationSession, action: ObservationAction): boolean {
  const { input, interpretation, lease, cursors, pairProgress, subjects, observedAt, sourceFacts } = session;
  const before = session.state;
  const observed = observeSeed(input, interpretation, lease, action, cursors, observedAt);
  recordObserverWork(session, "seed", observed);
  cursors.set(action.region_id, observed.page.cursor);
  const seedIds = observed.page.observations.filter((row) => row.target?.kind !== "source_evidence").map((row) => row.object_id);
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
  try { effects = seedEffects(observed.page.observations, interpretation, input.as_of, bindingContexts); }
  catch (error) { return rejectBindingResource(session, error); }
  session.state = applyObserverPage({ ...retainBindingContexts(session.state, bindingContexts), resume_subjects: subjects.snapshot }, { page: observed.page,
    effects, work: observed.work,
    resume_cursors: resumeCursors(cursors, pairProgress) });
  if (session.state.retention_rejected !== undefined || session.state.memory_exhausted) return true;
  subjects.snapshot = session.state.resume_subjects;
  session.state = retainObservedContext(before, session.state, sourceFacts, session.relationRows, subjects, pairProgress);
  if (session.state.memory_exhausted) return true;
  if (refreshPathFrontier(session)) return true;
  if (observed.page.outcome.status !== "interrupted") return false;
  if (observed.page.cursor.committed_through === (before.resume_cursors[action.region_id] ?? null)) return true;
  session.state = { ...session.state, last_observer_status: "open" };
  return false;
}

function refreshPathFrontier(session: ObservationSession): boolean {
  const { state, interpretation, input, relationRows, sourceFacts } = session;
  const frontier = state.path_effect_frontier;
  if (relationRows.length === 0 || frontier !== undefined && frontier.identities === state.seen_identities.length
    && frontier.facets === state.facets && frontier.discoveries === state.discoveries.length) return false;
  const region = state.residuals.find((entry) => entry.kind === "adjacency");
  const regionId = region?.region_id ?? "adjacency";
  const cursor = session.cursors.get(regionId) ?? startObserverCursor({ cursor_id: regionId,
    query_id: interpretation.query_id, snapshot_id: interpretation.snapshot_id, region_id: regionId });
  session.state = resumePathEffects({ ...state, pending_path_effects: { input: { rows: relationRows, options: {
    interpretation, asOf: input.as_of, liveStates: state.seen_identities,
    liveStateOffset: frontier === undefined || frontier.facets !== state.facets ? 0 : frontier.identities,
    overlay: RELATION_ROUTING, sourceFacts: sourceFacts.snapshot, facets: state.facets, discoveries: state.discoveries,
    bindingContexts: state.binding_contexts } },
    offset: 0, retained_bytes: 0, page: { schema_version: 1, query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id, cursor, observations: [], outcome: { schema_version: 1, status: "open" },
      open_regions: [{ schema_version: 1, region_id: regionId, kind: "adjacency", status: "open" }] } } });
  session.subjects.snapshot = session.state.resume_subjects;
  session.unresolvedGuard ||= session.state.observation_gaps?.guards === true;
  session.missingMeasurement ||= session.state.observation_gaps?.measurements === true;
  return session.state.pending_path_effects !== undefined || session.state.memory_exhausted;
}

function consumeMeasurementPage(session: ObservationSession, action: ObservationAction): boolean {
  const { input, interpretation, lease, cursors, pairProgress } = session;
  if (!hasMeasurementProducer(input.readers)) {
    session.state = closeRegion(session.state, interpretation, action, cursors, session.missingMeasurement ? "unknown" : "exhausted");
    return false;
  }
  const observed = observeMeasurement(input, interpretation, lease, action, cursors);
  recordObserverWork(session, "measurement", observed);
  cursors.set(action.region_id, observed.page.cursor);
  const bindingContexts = forkBindingContexts(session.state);
  let effects: readonly FieldObservationEffect[];
  try { effects = measurementEffectsFor(observed, interpretation, input.as_of, session.state.measurements, bindingContexts); }
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
  const { input, interpretation, lease, cursors, pairProgress, subjects, predicates, observedAt, sourceFacts } = session;
  const minimum = 4 + (input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK);
  const scanned = scanAdjacencyPairs(subjects, predicates, pairProgress, session.pairIndex,
    Math.max(0, session.state.remaining_exploration - minimum));
  const pair = scanned.pair;
  session.pairIndex = scanned.next;
  if (scanned.work > 0) session.input.cost?.add("adjacency", { joins: scanned.work });
  session.state = { ...session.state, pair_scan_offset: scanned.next,
    remaining_exploration: session.state.remaining_exploration - scanned.work };
  action = { ...action, work_limit: Math.min(action.work_limit, session.state.remaining_exploration) };
  if (pair === undefined) {
    if (hasOpenPairs(subjects, predicates, pairProgress, [], pairProgress.completed)) {
      session.state = interruptObservedField(session.state); return true;
    }
    session.state = closeAdjacency(session.state, interpretation, action, cursors, session.storedKindsOpen);
    return false;
  }
  const captured: RelationObserverRow[] = [];
  const observed = observeAdjacency(input, interpretation, lease, action, cursors, pair, captured, pairProgress, observedAt, sourceFacts);
  recordObserverWork(session, "adjacency", observed);
  cursors.set(action.region_id, observed.page.cursor);
  if (captured.length === 0) {
    session.state = applyObserverPage({ ...session.state, pair_progress: pairProgress.snapshot,
      pair_completed_count: pairProgress.completed, pair_revision: pairProgress.revision }, {
      page: maskAdjacencyExhaustion(observed.page, hasOpenPairs(subjects, predicates, pairProgress, [], pairProgress.completed)),
      work: observed.work, resume_cursors: resumeCursors(cursors, pairProgress) });
    return observed.page.outcome.status === "interrupted";
  }
  for (const row of captured) session.relationRows = session.relationRows.with(row);
  recordObservedAt(input, captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]), observedAt, sourceFacts);
  for (const row of captured) if (!overlayIsRoutingOnly(RELATION_ROUTING, row.predicate)) {
    addSubjects(subjects, [row.sourceObjectId, row.targetObjectId]);
  }
  const before = session.state;
  session.state = { ...session.state, remaining_exploration: Math.max(0, session.state.remaining_exploration - observed.work.work_units),
    pending_path_effects: { input: { rows: session.relationRows, options: {
      interpretation, asOf: input.as_of, liveStates: session.state.seen_identities, overlay: RELATION_ROUTING,
      sourceFacts: sourceFacts.snapshot, facets: session.state.facets, discoveries: session.state.discoveries,
      bindingContexts: session.state.binding_contexts } },
      offset: 0, retained_bytes: 0,
      page: maskAdjacencyExhaustion(observed.page, hasOpenPairs(subjects, predicates, pairProgress, [], pairProgress.completed)) },
    resume_cursors: resumeCursors(cursors, pairProgress) };
  session.state = retainObservedContext(before, session.state, sourceFacts, session.relationRows, subjects, pairProgress);
  if (session.state.memory_exhausted) return true;
  session.state = resumePathEffects(session.state);
  session.unresolvedGuard ||= session.state.observation_gaps?.guards === true;
  session.missingMeasurement ||= session.state.observation_gaps?.measurements === true;
  if (session.state.pending_path_effects !== undefined || session.state.memory_exhausted) return true;
  subjects.snapshot = session.state.resume_subjects;
  if (hasOpenPairs(subjects, predicates, pairProgress, [], pairProgress.completed)) session.state = reopenAdjacency(session.state);
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
  const bytes = facts.bytes - (before.source_fact_bytes ?? 0) + relationBytes - (before.observed_relation_bytes ?? 0);
  if (bytes > state.remaining_memory_bytes) return { ...before,
    remaining_exploration: state.remaining_exploration, memory_exhausted: true, last_observer_status: "interrupted",
    closure: { ...before.closure, observation: "interrupted", requested_index: "open" },
    residuals: before.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
  return { ...state, source_facts: facts.snapshot, source_fact_bytes: facts.bytes,
    observed_relations: relations, observed_relation_bytes: relationBytes, remaining_memory_bytes: state.remaining_memory_bytes - bytes,
    pair_progress: pairProgress.snapshot, pair_completed_count: pairProgress.completed, pair_revision: pairProgress.revision,
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
  pairProgress.set(key, observed.page.cursor.committed_through);
  if (observed.page.outcome.status === "exhausted") pairProgress.set(`${key}:done`, "1");
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
  bindingContexts?: BindingContextStore
): readonly FieldObservationEffect[] {
  return observations.flatMap((observation) =>
    seedActivationsForObservation(observation, interpretation, asOf, bindingContexts).map((seed) => ({
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
  return { ...state, binding_contexts: owner.snapshot(), binding_context_bytes: owner.bytes,
    remaining_memory_bytes: state.remaining_memory_bytes - owner.bytes + (state.binding_contexts?.bytes ?? 0) };
}

function rejectBindingResource(session: ObservationSession, error: unknown): true {
  if (!(error instanceof BindingContextResourceError)) throw error;
  session.state = { ...interruptObservedField(session.state), memory_exhausted: true, retention_rejected: "memory" };
  return true;
}

export function meterReaders(
  readers: ObserverReaders,
  memory: { remaining: number; cachedBytes: number },
  cache: Map<string, SourceObserverPage>
): ObserverReaders {
  const source = readers.source;
  return {
    ...readers,
    ...(readers.embeddingIds === undefined ? {} : {
      embeddingIds: (args: Parameters<NonNullable<ObserverReaders["embeddingIds"]>>[0]) => {
        const page = readers.embeddingIds!({ ...args, byteLimit: memory.remaining });
        memory.remaining = Math.max(0, memory.remaining - page.metadataUtf8Bytes);
        return page;
      }
    }),
    ...(readers.measureStoredPair === undefined ? {} : {
      measureStoredPair: (args: Parameters<NonNullable<ObserverReaders["measureStoredPair"]>>[0]) => {
        const page = readers.measureStoredPair!({ ...args, byteLimit: Math.min(args.byteLimit ?? 137472, memory.remaining) });
        memory.remaining = Math.max(0, memory.remaining - page.bytesRead);
        return page;
      }
    }),
    ...(source === undefined ? {} : { source: (args: Parameters<NonNullable<ObserverReaders["source"]>>[0]) => {
      const hit = cache.get(args.objectId);
      if (hit !== undefined) return { ...hit, rowsRead: 0, bytesRead: 0 };
      const byteLimit = Math.min(args.byteLimit ?? 65536, 65536, memory.remaining);
      if (byteLimit < 1) return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      const page = source({ ...args, byteLimit });
      memory.remaining = Math.max(0, memory.remaining - page.bytesRead);
      memory.cachedBytes += page.bytesRead;
      cache.set(args.objectId, page);
      return page;
    } }),
    ...(readers.sourceRoots === undefined ? {} : {
      sourceRoots: (args: Parameters<NonNullable<ObserverReaders["sourceRoots"]>>[0]) => {
        const byteLimit = Math.min(args.byteLimit ?? 65536, 65536,
          memory.remaining - (readers.sourceRootMetadataByteLimit ?? 0));
        if (byteLimit < 1) return { rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
          truncated: true, committedThrough: args.afterCursor, resourceLimited: true };
        const physicalBytes = readers.sourceRootChunkByteLimit ?? byteLimit;
        const limit = Math.min(args.limit, Math.floor(memory.remaining / (physicalBytes + (readers.sourceRootMetadataByteLimit ?? 0))));
        const page = readers.sourceRoots!({ ...args, byteLimit, nativeByteLimit: memory.remaining,
          limit, nativeLimit: Math.min(args.nativeLimit, limit) });
        const bytes = page.bytesRead + (page.metadataBytes ?? 0);
        memory.remaining = Math.max(0, memory.remaining - bytes);
        return page;
      }
    })
  };
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

