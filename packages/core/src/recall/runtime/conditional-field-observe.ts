import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  isPathActiveForRecall,
  type CoverageRegion,
  type IndexRole,
  type ObserverCursor,
  type ObserverStatus,
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
import {
  applyEvidenceEffect,
  applyObserverPage,
  createConditionalField,
  proposeFieldWork,
  type FieldEngineState,
  type FieldObservationEffect
} from "../conditional-field/engine/field-engine.js";
import {
  adjacencyEffectsForRows,
  adjacencyKindsFor,
  programRelationKinds,
  seedActivationsForObservation
} from "../conditional-field/engine/path-composition.js";
import { STORED_RELATION_KIND } from "../conditional-field/query/ordinary-language.js";
import {
  UNBOUND_BINDING,
  type BoundSourceFacts
} from "../conditional-field/engine/binding-environment.js";
import { collectRelations } from "../conditional-field/query/compile-query.js";
import {
  assessEvidence,
  observationsFromOwners
} from "../conditional-field/evidence/assess-support.js";
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
const INCOMPLETE_OBSERVER: ReadonlySet<ObserverStatus> = new Set([
  "cancelled",
  "unavailable",
  "interrupted",
  "unknown",
  "not_applicable",
  "invalidated"
]);

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
    input.readers.embeddingIds !== undefined,
    programNeedsGuardWork(interpretation.program)
  );
  let state = startObservedField(interpretation, input, residuals);
  if (input.cancelled === true) return cancelledField(state);
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
  const subjects = new Set<string>(state.resume_subjects);
  const relationRows: RelationObserverRow[] = [];
  const observedAt: Record<string, string> = {};
  const sourceFacts = new Map<string, BoundSourceFacts>();
  const memoryBox = { remaining: state.remaining_memory_bytes };
  const sourceCache = new Map<string, SourceObserverPage>();
  const observedInput: ObserveFieldInput = {
    ...input,
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
  for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
    memoryBox.remaining = state.remaining_memory_bytes;
    if (terminalObserver(state.last_observer_status)) break;
    const proposal = proposeFieldWork(state);
    if (proposal.actions.length === 0) break;
    for (const action of proposal.actions) {
      if (action.action === "seed") {
        const observed = observeSeed(observedInput, interpretation, lease, action, cursors, observedAt);
        cursors.set(action.region_id, observed.page.cursor);
        const seedIds = observed.page.observations.map((row) => row.object_id);
        addSubjects(subjects, seedIds);
        recordObservedAt(observedInput, seedIds, observedAt, sourceFacts);
        state = applyObserverPage(state, {
          page: observed.page,
          effects: seedEffects(observed.page.observations, interpretation, input.as_of),
          work: observed.work,
          resume_cursors: resumeCursors(cursors, pairProgress)
        });
        continue;
      }
      if (action.action === "measurement") {
        if (observedInput.readers.embeddingIds === undefined) {
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
        state = applyObserverPage(state, {
          page: observed.page,
          effects: [],
          work: observed.work,
          resume_cursors: resumeCursors(cursors, pairProgress)
        });
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
      const predicates = adjacencyKindsFor(interpretation.program, storedKinds.kinds);
      const pair = nextAdjacencyPair(subjects, predicates, pairProgress, pairIndex);
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
      relationRows.push(...captured);
      addSubjects(subjects, captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]));
      recordObservedAt(
        observedInput,
        captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]),
        observedAt,
        sourceFacts
      );
      state = applyObserverPage(state, {
        page: maskAdjacencyExhaustion(observed.page, hasOpenPairs(subjects, predicates, pairProgress)),
        effects: (() => {
          const effects = transitionEffects(
            relationRows,
            interpretation,
            state.seen_identities,
            input.as_of,
            sourceFacts,
            state.facets
          );
          if (effects.some((effect) => effect.unresolved_guard === true)) unresolvedGuard = true;
          if (effects.some((effect) => effect.missing_measurement === true)) missingMeasurement = true;
          return effects;
        })(),
        work: observed.work,
        resume_cursors: resumeCursors(cursors, pairProgress)
      });
    }
  }
  return Object.freeze({
    ...state,
    pair_progress: Object.freeze(Object.fromEntries(pairProgress)),
    resume_subjects: Object.freeze([...subjects])
  });
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
      remaining_exploration: resumed.remaining_exploration + exploration,
      remaining_reserve: input.budget.finalization_reserve,
      remaining_memory_bytes: Math.max(resumed.remaining_memory_bytes, input.budget.memory_bytes),
      memory_exhausted: false
    };
  }
  return createConditionalField({ interpretation, budget: input.budget, residuals });
}

export function assessUnknownCause(
  state: FieldEngineState,
  input: ObserveFieldInput
): FieldEngineState {
  if (state.remaining_reserve < 1) {
    return applyEvidenceEffect(state, { support: state.support, work_status: "open" });
  }
  const assertions = assertionReadsFrom(state, input);
  const hypothesisId = state.interpretation.hypotheses[0]?.hypothesis_id ?? "h0";
  const timeState = state.interpretation.time_window?.end ?? input.as_of;
  const context = {
    query_id: state.query_id,
    snapshot_id: state.snapshot_id,
    source_revision: state.snapshot_id,
    hypothesis_id: hypothesisId,
    binding_context: UNBOUND_BINDING,
    time_state: timeState,
    jurisdiction: "workspace",
    as_of: input.as_of,
    permitted_timeless_policy_ids: new Set<string>(),
    assertions,
    claims: [] as const,
    access: new Map()
  };
  const observations = observationsFromOwners(context).filter((row) =>
    isPathActiveForRecall(row.path_lifecycle)
  );
  const propositions = assertions.map((assertion) => ({
    proposition: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      proposition_id: assertion.assertion_id,
      kind: assertion.relation_kind,
      arguments: [assertion.assertion_id]
    },
    templates: assertion.evidence_receipts.map((receipt) => ({
      witness_id: receipt.evidence_id,
      premises: [
        assertion.anchors.source_anchor.object_id,
        assertion.anchors.target_anchor.object_id
      ],
      cost: 1
    }))
  }));
  const assessed = assessEvidence({
    ...context,
    observations,
    propositions,
    work_limit: state.remaining_reserve
  });
  const claims = new Map<string, (typeof assessed.records)[number]["claim"]>();
  for (const [index, record] of assessed.records.entries()) {
    const targetId = assertions[index]?.anchors.target_anchor.object_id;
    if (targetId !== undefined) claims.set(targetId, record.claim);
    claims.set(record.proposition_id, record.claim);
  }
  return applyEvidenceEffect(state, {
    support: assessed.records,
    claims,
    work_status: assessed.work_status
  });
}

export function rolesFrom(state: FieldEngineState): ReadonlyMap<string, IndexRole> {
  const roles = new Map<string, IndexRole>();
  for (const identity of state.seen_identities) roles.set(identity.object_id, "associated");
  for (const seed of state.seeds) roles.set(seed.state.object_id, "requested");
  for (const transition of state.transitions) {
    if (RELATION_MILLIGRADES[transition.relation_kind]?.role === "routing_only"
      && roles.get(transition.to.object_id) !== "requested") {
      roles.set(transition.to.object_id, "routing_only");
    }
  }
  return roles;
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

function closeAdjacency(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>,
  kindsOpen: boolean
): FieldEngineState {
  if (incompleteObserver(state.last_observer_status)) return state;
  return closeRegion(state, interpretation, action, cursors, kindsOpen ? "open" : "exhausted");
}

function closeRegion(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>,
  status: ObserverStatus
): FieldEngineState {
  const kind = action.action === "seed"
    ? "seed"
    : action.action === "measurement"
      ? "binding"
      : "adjacency";
  return applyObserverPage(state, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id,
      cursor: cursorOf(cursors, interpretation, action.region_id),
      observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status },
      open_regions: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        region_id: action.region_id,
        kind,
        status
      }]
    },
    effects: []
  });
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
  return {
    kinds: listed({ workspaceId, subject: null }),
    charged: 1,
    open: false
  };
}

function recordObservedAt(
  input: ObserveFieldInput,
  objectIds: readonly string[],
  observedAt: Record<string, string>,
  sourceFacts: Map<string, BoundSourceFacts>
): void {
  const source = input.readers.source;
  if (source === undefined) return;
  for (const objectId of objectIds) {
    if (sourceFacts.has(objectId)) continue;
    const page = source({ workspaceId: input.workspace_id, objectId });
    const row = page.row;
    if (row === null) continue;
    sourceFacts.set(objectId, {
      object_id: row.object_id,
      ...((row.observed_at ?? row.created_at) === undefined ? {} : { observed_at: row.observed_at ?? row.created_at }),
      ...(row.created_at === undefined ? {} : { created_at: row.created_at }),
      ...(row.last_used_at === undefined ? {} : { last_used_at: row.last_used_at }),
      ...(row.dimension === undefined ? {} : { dimension: row.dimension }),
      ...(row.domain_tags === undefined ? {} : { domain_tags: row.domain_tags }),
      ...(row.scope_class === undefined ? {} : { scope_class: row.scope_class })
    });
    const instant = row.observed_at ?? row.created_at;
    if (instant !== undefined) observedAt[objectId] = instant;
  }
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
  facets: FieldEngineState["facets"]
): readonly FieldObservationEffect[] {
  return adjacencyEffectsForRows(rows, {
    interpretation,
    asOf,
    liveStates,
    overlay: RELATION_MILLIGRADES,
    sourceFacts,
    facets
  });
}

function assertionReadsFrom(
  state: FieldEngineState,
  input: ObserveFieldInput
) {
  const relation = input.readers.relation;
  if (relation === undefined || state.remaining_reserve < 1) return [];
  const kinds = adjacencyKindsFor(state.interpretation.program);
  const subjects = new Set(state.seen_identities.map((identity) => identity.object_id));
  const assertions = [];
  let allowance = state.remaining_reserve;
  const cap = Math.min(512, Math.max(1, Math.min(input.budget.page_budget, allowance)));
  for (const subject of subjects) {
    for (const predicate of kinds) {
      if (allowance < 1) return assertions;
      allowance -= 1;
      const page = relation({
        workspaceId: input.workspace_id,
        subject,
        predicate,
        limit: cap,
        nativeLimit: cap,
        afterAssertionId: null
      });
      for (const row of page.observations) {
        const validity = row.validity;
        if (validity === undefined) continue;
        const occurredAt = row.occurred_at
          ?? (validity.kind === "timeless" ? input.as_of : validity.valid_from);
        assertions.push({
          assertion_id: row.assertionId,
          relation_kind: row.predicate,
          evidence_receipts: (row.evidenceRefs ?? []).map((evidenceId) => ({
            evidence_id: evidenceId,
            source_event_anchor: {
              event_id: row.source_event_id ?? row.assertionId,
              event_type: "relation.evidence",
              occurred_at: occurredAt
            }
          })),
          anchors: {
            source_anchor: { kind: "object" as const, object_id: row.sourceObjectId },
            target_anchor: { kind: "object" as const, object_id: row.targetObjectId }
          },
          validity
        });
      }
    }
  }
  return assertions;
}

function meterReaders(
  readers: ObserverReaders,
  memory: { remaining: number },
  cache: Map<string, SourceObserverPage>
): ObserverReaders {
  const source = readers.source;
  if (source === undefined) return readers;
  return {
    ...readers,
    source: (args) => {
      const hit = cache.get(args.objectId);
      if (hit !== undefined) return hit;
      const byteLimit = Math.max(1, Math.min(65536, memory.remaining));
      const page = source({ ...args, byteLimit });
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

function cursorOf(
  cursors: Map<string, ObserverCursor>,
  interpretation: QueryInterpretation,
  regionId: string
): ObserverCursor {
  const existing = cursors.get(regionId);
  if (existing !== undefined) return existing;
  const created = startObserverCursor({
    cursor_id: regionId,
    snapshot_id: interpretation.snapshot_id,
    query_id: interpretation.query_id,
    region_id: regionId
  });
  cursors.set(regionId, created);
  return created;
}

function nextAdjacencyPair(
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: Map<string, string | null>,
  pairIndex: number
): Readonly<{ readonly subject: string; readonly predicate: string }> | undefined {
  const subjectList = [...subjects];
  if (subjectList.length === 0 || predicates.length === 0) return undefined;
  const total = subjectList.length * predicates.length;
  for (let offset = 0; offset < total; offset += 1) {
    const index = (pairIndex + offset) % total;
    const subject = subjectList[Math.floor(index / predicates.length)]!;
    const predicate = predicates[index % predicates.length]!;
    if (!pairProgress.has(`${pairKey(subject, predicate)}:done`)) {
      return { subject, predicate };
    }
  }
  return undefined;
}

function hasOpenPairs(
  subjects: ReadonlySet<string>,
  predicates: readonly string[],
  pairProgress: Map<string, string | null>
): boolean {
  return nextAdjacencyPair(subjects, predicates, pairProgress, 0) !== undefined;
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

function pairKey(subject: string, predicate: string): string {
  return `${subject}\0${predicate}`;
}

function pinExpectation(input: ObserveFieldInput): Readonly<{
  readonly expected_source_revision?: string;
  readonly model_id?: string;
  readonly expected_model_id?: string;
}> {
  const revision = input.expected_source_revision
    ?? input.readers.snapshotPin?.(input.workspace_id)?.source_revision;
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

function openResiduals(includeBinding: boolean, includeGuard: boolean): readonly CoverageRegion[] {
  const residuals: CoverageRegion[] = [
    residual("seed", "seed"),
    residual("adjacency", "adjacency")
  ];
  if (includeGuard) residuals.push(residual("guard", "guard"));
  if (includeBinding) residuals.push(residual("binding", "binding"));
  return residuals;
}

function programNeedsGuardWork(program: QueryInterpretation["program"]): boolean {
  return collectRelations(program).some((relation) =>
    relation.guard.kind === "equality"
    || relation.guard.kind === "source_bound_entity"
    || (relation.guard.kind === "interval_relation" && relation.guard.time_scope === "associated")
  );
}

function residual(id: string, kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: id,
    kind,
    status: "open"
  };
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

function incompleteObserver(status: ObserverStatus | undefined): boolean {
  return status !== undefined && INCOMPLETE_OBSERVER.has(status);
}

function terminalObserver(status: ObserverStatus | undefined): boolean {
  return status === "cancelled"
    || status === "unavailable"
    || status === "unknown"
    || status === "not_applicable"
    || status === "invalidated";
}
