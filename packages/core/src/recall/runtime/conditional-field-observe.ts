import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  productSubjectId,
  type CoverageRegion,
  type IndexRole,
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
import { hasMeasurementProducer } from "../conditional-field/observers/measure-stored.js";
import { measurementEffectsFor, measurementIsMissing } from "./measurement-effects.js";
import {
  applyObserverPage,
  createConditionalField,
  proposeFieldWork,
  type FieldEngineState,
  type FieldObservationEffect
} from "../conditional-field/engine/field-engine.js";
import {
  adjacencyEffectsForRows,
  adjacencyKindsFor,
  hasOpenPairs,
  nextAdjacencyPair,
  overlayIsRoutingOnly,
  pairKey,
  programRelationKinds,
  routingOverlayKinds,
  seedProgramStates,
  seedActivationsForObservation
} from "../conditional-field/engine/path-composition.js";
import { STORED_RELATION_KIND } from "../conditional-field/query/ordinary-language.js";
import {
  type BoundSourceFacts
} from "../conditional-field/engine/binding-environment.js";
import { collectRelations } from "../conditional-field/query/compile-query.js";
import { recordObservedAt, recordSourceRootFacts } from "./observed-source-facts.js";
import {
  closeAdjacency,
  closeRegion,
  cursorOf,
  incompleteObserver,
  openResiduals,
  settleDiscoveryResidual,
  terminalObserver
} from "./observe-field-residuals.js";
export type ObserveFieldInput = Readonly<{
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: import("@do-soul/alaya-protocol").RequestBudget;
  readonly as_of: string;
  readonly readers: ObserverReaders;
  readonly authorized_scopes?: readonly string[];
  readonly cancelled?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly resume_field?: FieldEngineState;
  readonly expected_source_revision?: string;
  readonly model_id?: string;
  readonly expected_model_id?: string;
}>;

const MAX_OBSERVE_ROUNDS = 4_096;
const SEED_PAGE_SIZE = 32;
const ADJACENCY_PAGE_SIZE = 16;
const MAX_FINALIZATION_MEMORY_BYTES = 65_536;

export const RELATION_MILLIGRADES: Readonly<Record<string, Readonly<{
  readonly milligrades: number;
  readonly applicable: boolean;
  readonly role: IndexRole;
}>>> = Object.freeze({
  observed_log: { milligrades: 950, applicable: true, role: "associated" },
  config_via_log: { milligrades: 850, applicable: true, role: "associated" },
  config_direct: { milligrades: 800, applicable: true, role: "associated" },
  uses_service: { milligrades: 900, applicable: true, role: "routing_only" },
  service_history: { milligrades: 550, applicable: true, role: "associated" },
  unrelated: { milligrades: 1000, applicable: false, role: "associated" }
});

export function observeField(
  interpretation: QueryInterpretation,
  input: ObserveFieldInput
): FieldEngineState {
  const residuals = openResiduals(
    hasMeasurementProducer(input.readers),
    programNeedsGuardWork(interpretation.program)
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
    state = { ...state, remaining_exploration: state.remaining_exploration - SNAPSHOT_PIN_NATIVE_WORK };
  }
  const lease = activeLease(interpretation);
  const cursors = new Map<string, ObserverCursor>();
  const pairProgress = new Map<string, string | null>(Object.entries(state.pair_progress));
  const restoredCursors = {
    ...state.resume_cursors,
    ...(input.resume_cursors ?? {})
  };
  for (const [regionId, position] of Object.entries(restoredCursors)) {
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
  const subjects = new Set<string>([
    ...state.resume_subjects,
    ...state.seen_identities.map((row) => productSubjectId(row)),
    ...state.discoveries.map((row) => row.subject_id)
  ]);
  let relationRows: RelationObserverRow[] = [...(state.observed_relations ?? [])];
  const observedAt: Record<string, string> = {};
  const sourceFacts = new Map<string, BoundSourceFacts>(Object.entries(state.source_facts ?? {}));
  const memoryBox = { remaining: state.remaining_memory_bytes, cachedBytes: 0 };
  const sourceCache = new Map<string, SourceObserverPage>();
  const observedInput: ObserveFieldInput = {
    ...input,
    ...(expectedRevision === undefined ? {} : { expected_source_revision: expectedRevision }),
    readers: meterReaders(input.readers, memoryBox, sourceCache)
  };
  let pairIndex = 0;
  let unresolvedGuard = false;
  let missingMeasurement = false;
  const storedKinds = loadStoredRelationKinds(
    interpretation.program,
    observedInput.readers,
    observedInput.workspace_id,
    state.remaining_exploration
  );
  if (storedKinds.charged > 0) {
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
      programKinds.length === 0 ? [] : routingOverlayKinds(RELATION_MILLIGRADES)
    ),
    ...(interpretation.view.claim_demands ?? []).map((demand) => demand.proposition_kind)
  ])];
  for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
    memoryBox.remaining = Math.max(0, state.remaining_memory_bytes - memoryBox.cachedBytes);
    if (terminalObserver(state.last_observer_status)) break;
    const proposal = proposeFieldWork(state);
    if (proposal.actions.length === 0) break;
    for (const proposed of proposal.actions) {
      const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
      const seedRows = Math.min(SEED_PAGE_SIZE, Math.floor((state.remaining_exploration - pinWork - 1) / seedUnitCost));
      const adjacencyRows = Math.min(ADJACENCY_PAGE_SIZE, Math.floor((state.remaining_exploration - pinWork - 1) / seedUnitCost));
      const batchedRows = proposed.action === "seed" ? 4 * Math.max(0, seedRows)
        : proposed.action === "adjacency" ? 4 * Math.max(0, adjacencyRows)
        : 4;
      const action = { ...proposed, work_limit: Math.min(batchedRows + pinWork, state.remaining_exploration) };
      const minimum = (action.action === "seed" || action.action === "adjacency" ? 4 : 1) + pinWork;
      if (action.work_limit < minimum) {
        return interruptObservedField(state);
      }
      if (action.action === "seed") {
        const before = state;
        const observed = observeSeed(observedInput, interpretation, lease, action, cursors, observedAt);
        cursors.set(action.region_id, observed.page.cursor);
        const seedIds = observed.page.observations.map((row) => row.object_id);
        addSubjects(subjects, seedIds);
        recordObservedAt(observedInput, seedIds, observedAt, sourceFacts);
        recordSourceRootFacts(observedInput, observed.page.observations, sourceFacts);
        state = applyObserverPage(state, {
          page: observed.page,
          effects: seedEffects(observed.page.observations, interpretation, input.as_of),
          work: observed.work,
          resume_cursors: resumeCursors(cursors, pairProgress)
        });
        if (state.retention_rejected !== undefined || state.memory_exhausted) return state;
        state = retainObservedContext(before, state, sourceFacts, relationRows, subjects, pairProgress);
        if (state.memory_exhausted) return state;
        if (observed.page.outcome.status === "interrupted") return state;
        continue;
      }
      if (action.action === "measurement") {
        if (!hasMeasurementProducer(observedInput.readers)) {
          state = closeRegion(
            state,
            interpretation,
            action,
            cursors,
            missingMeasurement ? "unknown" : "exhausted"
          );
          continue;
        }
        const observed = observeMeasurement(observedInput, interpretation, lease, action, cursors);
        cursors.set(action.region_id, observed.page.cursor);
        const effects = measurementEffectsFor(observed);
        if (measurementIsMissing(effects)) missingMeasurement = true;
        state = applyObserverPage(state, {
          page: observed.page,
          effects,
          work: observed.work,
          resume_cursors: resumeCursors(cursors, pairProgress)
        });
        if (observed.page.outcome.status === "exhausted") {
          state = closeRegion(
            state,
            interpretation,
            action,
            cursors,
            missingMeasurement ? "unknown" : "exhausted"
          );
        }
        continue;
      }
      if (action.action === "relation") {
        state = closeRegion(
          state,
          interpretation,
          action,
          cursors,
          unresolvedGuard || missingMeasurement ? "unknown" : "exhausted"
        );
        continue;
      }
      if (incompleteObserver(state.last_observer_status)) {
        break;
      }
      const pair = nextAdjacencyPair(subjects, predicates, pairProgress, pairIndex, state.discoveries);
      pairIndex += 1;
      if (pair === undefined) {
        state = closeAdjacency(state, interpretation, action, cursors, storedKinds.open);
        continue;
      }
      const captured: RelationObserverRow[] = [];
      const observed = observeAdjacency(
        observedInput, interpretation, lease, action, cursors, pair, captured, pairProgress, observedAt, sourceFacts
      );
      cursors.set(action.region_id, observed.page.cursor);
      relationRows = mergeRelationRows(relationRows, captured);
      recordObservedAt(
        observedInput,
        captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]),
        observedAt,
        sourceFacts
      );
      const effects = transitionEffects(
        relationRows,
        interpretation,
        state.seen_identities,
        input.as_of,
        sourceFacts,
        state.facets,
        state.discoveries
      );
      if (effects.some((effect) => effect.unresolved_guard === true)) unresolvedGuard = true;
      if (effects.some((effect) => effect.missing_measurement === true)) missingMeasurement = true;
      for (const row of captured) {
        if (overlayIsRoutingOnly(RELATION_MILLIGRADES, row.predicate)) continue;
        addSubjects(subjects, [row.sourceObjectId, row.targetObjectId]);
      }
      addAgendaFromEffects(subjects, effects);
      const before = state;
      state = applyObserverPage(state, {
        page: maskAdjacencyExhaustion(
          observed.page,
          hasOpenPairs(subjects, predicates, pairProgress, state.discoveries)
        ),
        effects,
        work: observed.work,
        resume_cursors: resumeCursors(cursors, pairProgress)
      });
      if (state.retention_rejected !== undefined || state.memory_exhausted) return state;
      addSubjects(subjects, state.discoveries.map((row) => row.subject_id));
      addSubjects(subjects, state.seen_identities.map((row) => productSubjectId(row)));
      state = retainObservedContext(before, state, sourceFacts, relationRows, subjects, pairProgress);
      if (state.memory_exhausted) return state;
      if (observed.page.outcome.status === "interrupted") {
        if ((before.pair_progress[pairKey(pair.subject, pair.predicate)] ?? null) === observed.page.cursor.committed_through) return state;
        state = { ...state, last_observer_status: "open" };
      }
    }
  }
  return Object.freeze({
    ...settleDiscoveryResidual(
      state,
      interpretation,
      cursors,
      subjects,
      predicates,
      pairProgress
    ),
    pair_progress: Object.freeze(Object.fromEntries(pairProgress)),
    resume_subjects: Object.freeze([...subjects])
  });
}

function interruptObservedField(state: FieldEngineState): FieldEngineState {
  return { ...state, last_observer_status: "interrupted",
    closure: { ...state.closure, observation: "interrupted", requested_index: "open" },
    residuals: state.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
}

function retainObservedContext(
  before: FieldEngineState, state: FieldEngineState,
  facts: ReadonlyMap<string, BoundSourceFacts>, relations: readonly RelationObserverRow[],
  subjects: ReadonlySet<string>, pairProgress: ReadonlyMap<string, string | null>
): FieldEngineState {
  const source_facts = Object.fromEntries(facts);
  const bytes = Buffer.byteLength(JSON.stringify([source_facts, relations]), "utf8")
    - Buffer.byteLength(JSON.stringify([before.source_facts ?? {}, before.observed_relations ?? []]), "utf8");
  if (bytes > state.remaining_memory_bytes) return { ...before,
    remaining_exploration: state.remaining_exploration, memory_exhausted: true, last_observer_status: "interrupted",
    closure: { ...before.closure, observation: "interrupted", requested_index: "open" },
    residuals: before.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
  return { ...state, source_facts, observed_relations: relations, remaining_memory_bytes: state.remaining_memory_bytes - bytes,
    pair_progress: Object.fromEntries(pairProgress), resume_subjects: [...subjects] };
}

function mergeRelationRows(prior: readonly RelationObserverRow[], rows: readonly RelationObserverRow[]): RelationObserverRow[] {
  const merged = new Map(prior.map((row) => [row.assertionId, row]));
  for (const row of rows) {
    const previous = merged.get(row.assertionId);
    const receipts = new Map([...(previous?.evidenceReceipts ?? []), ...(row.evidenceReceipts ?? [])].map((receipt) => [receipt.evidenceId, receipt]));
    merged.set(row.assertionId, { ...row, evidenceRefs: [...new Set([...(previous?.evidenceRefs ?? []), ...(row.evidenceRefs ?? [])])],
      evidenceReceipts: [...receipts.values()] });
  }
  return [...merged.values()];
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
    return {
      ...resumed,
      interpretation,
      budget: input.budget,
      remaining_exploration: exploration,
      remaining_reserve: input.budget.finalization_reserve,
      remaining_memory_bytes: Math.max(0, input.budget.memory_bytes
        - (resumed.budget.memory_bytes - resumed.remaining_memory_bytes)),
      memory_exhausted: false,
      last_observer_status: resumed.last_observer_status === "interrupted" ? "open" : resumed.last_observer_status,
      retention_rejected: undefined
    };
  }
  return createConditionalField({ interpretation, budget: input.budget, residuals });
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
    residuals: openResiduals(false, false)
  });
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
  pairProgress: Map<string, string | null>,
  observedAt: Record<string, string>,
  sourceFacts: Map<string, BoundSourceFacts>
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

function loadStoredRelationKinds(
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

function seedEffects(
  observations: readonly TypedObservation[],
  interpretation: QueryInterpretation,
  asOf: string
): readonly FieldObservationEffect[] {
  return observations.flatMap((observation) =>
    seedActivationsForObservation(observation, interpretation, asOf).map((seed) => ({
      observation_id: `${observation.observation_id}:${seed.state.hypothesis_id}:${seed.state.program_state}`,
      seed
    }))
  );
}

function transitionEffects(
  rows: readonly RelationObserverRow[],
  interpretation: QueryInterpretation,
  liveStates: FieldEngineState["seen_identities"],
  asOf: string,
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  facets: FieldEngineState["facets"],
  discoveries: FieldEngineState["discoveries"]
): readonly FieldObservationEffect[] {
  return adjacencyEffectsForRows(rows, {
    interpretation,
    asOf,
    liveStates,
    overlay: RELATION_MILLIGRADES,
    sourceFacts,
    facets,
    discoveries
  });
}

function meterReaders(
  readers: ObserverReaders,
  memory: { remaining: number; cachedBytes: number },
  cache: Map<string, SourceObserverPage>
): ObserverReaders {
  const source = readers.source;
  if (source === undefined) return readers;
  return {
    ...readers,
    source: (args) => {
      const hit = cache.get(args.objectId);
      if (hit !== undefined) return { ...hit, rowsRead: 0, bytesRead: 0 };
      const byteLimit = Math.max(1, Math.min(65536, memory.remaining));
      const page = source({ ...args, byteLimit });
      memory.remaining = Math.max(0, memory.remaining - page.bytesRead);
      memory.cachedBytes += page.bytesRead;
      cache.set(args.objectId, page);
      return page;
    }
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

function addSubjects(subjects: Set<string>, ids: readonly string[]): void {
  for (const id of ids) subjects.add(id);
}

function addAgendaFromEffects(subjects: Set<string>, effects: readonly FieldObservationEffect[]): void {
  for (const effect of effects) {
    if (effect.discovery !== undefined) subjects.add(effect.discovery.subject_id);
    if (effect.transition !== undefined) {
      subjects.add(productSubjectId(effect.transition.from));
      subjects.add(productSubjectId(effect.transition.to));
    }
  }
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
  _pairProgress: Map<string, string | null>
): Readonly<Record<string, string | null>> {
  const resume: Record<string, string | null> = {};
  for (const [regionId, cursor] of cursors) resume[regionId] = cursor.committed_through;
  return resume;
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

