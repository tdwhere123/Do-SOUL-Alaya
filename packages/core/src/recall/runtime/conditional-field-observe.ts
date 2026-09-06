import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  type CoverageRegion,
  type IndexRole,
  type ObserverCursor,
  type ObserverStatus,
  type QueryInterpretation,
  type SeedActivation,
  type SnapshotReadLease,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { collectRelations } from "../conditional-field/query/compile-query.js";
import {
  observeConditionalField,
  startObserverCursor,
  type ObserverReaders,
  type RelationObserverRow
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
  COMMON_CAUSE_PROPOSITION_KIND,
  assessEvidence,
  type EvidenceObservation
} from "../conditional-field/evidence/assess-support.js";
export type ObserveFieldInput = Readonly<{
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: import("@do-soul/alaya-protocol").RequestBudget;
  readonly as_of: string;
  readonly readers: ObserverReaders;
  readonly authorized_scopes?: readonly string[];
  readonly cancelled?: boolean;
}>;

const MAX_OBSERVE_ROUNDS = 4_096;
const NATIVE_PAGE = 32;
const OPEN_VALIDITY = { kind: "open" as const, valid_from: "1970-01-01T00:00:00.000Z" };
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
  const residuals = openResiduals(input.readers.embeddingIds !== undefined);
  let state = createConditionalField({ interpretation, budget: input.budget, residuals });
  if (input.cancelled === true) return cancelledField(state);
  const lease = activeLease(interpretation);
  const cursors = new Map<string, ObserverCursor>();
  const pairProgress = new Map<string, string | null>();
  const subjects = new Set<string>();
  const observedAt: Record<string, string> = {};
  let pairIndex = 0;
  for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
    if (terminalObserver(state.last_observer_status)) break;
    const proposal = proposeFieldWork(state);
    if (proposal.actions.length === 0) break;
    for (const action of proposal.actions) {
      if (action.action === "seed") {
        const observed = observeSeed(input, interpretation, lease, action, cursors, observedAt);
        const seedIds = observed.page.observations.map((row) => row.object_id);
        addSubjects(subjects, seedIds);
        recordObservedAt(input, seedIds, observedAt);
        state = applyObserverPage(state, {
          page: observed.page,
          effects: seedEffects(observed.page.observations)
        });
        continue;
      }
      if (action.action === "measurement") {
        if (input.readers.embeddingIds === undefined) {
          state = closeRegion(state, interpretation, action, cursors, "exhausted");
          continue;
        }
        const observed = observeMeasurement(input, interpretation, lease, action, cursors);
        state = applyObserverPage(state, { page: observed.page, effects: [] });
        continue;
      }
      if (action.action === "relation") {
        state = closeRegion(state, interpretation, action, cursors, "exhausted");
        continue;
      }
      if (incompleteObserver(state.last_observer_status)) {
        break;
      }
      const predicates = adjacencyPredicates(interpretation, input.readers, input.workspace_id, subjects);
      const pair = nextAdjacencyPair(subjects, predicates, pairProgress, pairIndex);
      pairIndex += 1;
      if (pair === undefined) {
        state = closeAdjacency(state, interpretation, action, cursors);
        continue;
      }
      const captured: RelationObserverRow[] = [];
      const observed = observeAdjacency(
        input, interpretation, lease, action, cursors, pair, captured, pairProgress, observedAt
      );
      addSubjects(subjects, captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]));
      state = applyObserverPage(state, {
        page: maskAdjacencyExhaustion(observed.page, hasOpenPairs(subjects, predicates, pairProgress)),
        effects: transitionEffects(captured)
      });
    }
  }
  return state;
}

export function assessUnknownCause(
  state: FieldEngineState,
  input: ObserveFieldInput
): FieldEngineState {
  const assessed = assessEvidence({
    query_id: state.query_id,
    snapshot_id: state.snapshot_id,
    source_revision: state.snapshot_id,
    hypothesis_id: "h0",
    binding_context: "default",
    time_state: "as_of",
    jurisdiction: "workspace",
    as_of: input.as_of,
    permitted_timeless_policy_ids: new Set(),
    observations: evidenceObservationsFrom(state, input),
    propositions: [{
      proposition: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        proposition_id: "common-cause",
        kind: COMMON_CAUSE_PROPOSITION_KIND,
        arguments: ["r", "h"]
      },
      templates: [{ witness_id: "shared-root", premises: ["shared_root_cause"], cost: 100 }]
    }],
    work_limit: Math.max(1, state.remaining_reserve)
  });
  return applyEvidenceEffect(state, { support: assessed.records });
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
    residuals: openResiduals(false)
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
    action: nativeAction(action),
    cursor: cursorOf(cursors, interpretation, action.region_id),
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: input.readers,
    seed_query: input.query_text,
    authorized_scopes: input.authorized_scopes,
    object_observed_at: observedAt,
    page_limit: NATIVE_PAGE
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
    action: nativeAction(action),
    cursor: cursorOf(cursors, interpretation, action.region_id),
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: input.readers,
    page_limit: NATIVE_PAGE
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
  observedAt: Record<string, string>
) {
  const key = pairKey(pair.subject, pair.predicate);
  const cursor = {
    ...cursorOf(cursors, interpretation, action.region_id),
    committed_through: pairProgress.get(key) ?? null
  };
  const observed = observeConditionalField({
    lease,
    action: nativeAction(action),
    cursor,
    query: interpretation,
    workspace_id: input.workspace_id,
    readers: capturingReaders(input.readers, captured),
    relation_subject: pair.subject,
    relation_kind: pair.predicate,
    authorized_scopes: input.authorized_scopes,
    object_observed_at: observedAt,
    page_limit: NATIVE_PAGE
  });
  pairProgress.set(key, observed.page.cursor.committed_through);
  if (observed.page.outcome.status === "exhausted") pairProgress.set(`${key}:done`, "1");
  recordObservedAt(
    input,
    captured.flatMap((row) => [row.sourceObjectId, row.targetObjectId]),
    observedAt
  );
  return observed;
}

function closeAdjacency(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>
): FieldEngineState {
  if (incompleteObserver(state.last_observer_status)) return state;
  return closeRegion(state, interpretation, action, cursors, "exhausted");
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

function adjacencyPredicates(
  interpretation: QueryInterpretation,
  readers: ObserverReaders,
  workspaceId: string,
  subjects: ReadonlySet<string>
): readonly string[] {
  const kinds = new Set([
    ...collectRelations(interpretation.program).map((relation) => relation.relation_kind),
    ...Object.keys(RELATION_MILLIGRADES)
  ]);
  const listed = readers.relationKinds;
  if (listed !== undefined) {
    for (const kind of listed({ workspaceId, subject: null })) kinds.add(kind);
    for (const subject of subjects) {
      for (const kind of listed({ workspaceId, subject })) kinds.add(kind);
    }
  }
  return [...kinds];
}

function recordObservedAt(
  input: ObserveFieldInput,
  objectIds: readonly string[],
  observedAt: Record<string, string>
): void {
  const source = input.readers.source;
  if (source === undefined) return;
  for (const objectId of objectIds) {
    if (observedAt[objectId] !== undefined) continue;
    const page = source({ workspaceId: input.workspace_id, objectId });
    const instant = page.row?.observed_at;
    if (instant !== undefined) observedAt[objectId] = instant;
  }
}

function seedEffects(
  observations: readonly TypedObservation[]
): readonly FieldObservationEffect[] {
  return observations.flatMap((observation) => {
    if (observation.applicability.verdict === "false") return [];
    const seed: SeedActivation = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      state: productKey(observation.object_id),
      milligrades: MILLIGRADE_TOP
    };
    return [{ observation_id: observation.observation_id, seed }];
  });
}

function transitionEffects(rows: readonly RelationObserverRow[]): readonly FieldObservationEffect[] {
  return rows.map((row) => {
    const assigned = RELATION_MILLIGRADES[row.predicate] ?? {
      milligrades: 500,
      applicable: true,
      role: "associated" as const
    };
    const transition: Transition = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      from: productKey(row.sourceObjectId),
      to: productKey(row.targetObjectId),
      relation_kind: row.predicate,
      strength_milligrades: assigned.milligrades,
      validity: OPEN_VALIDITY,
      applicable: assigned.applicable
    };
    return {
      observation_id: `adjacency:${row.assertionId}`,
      transition,
      facet: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        path_id: row.assertionId,
        coordinates: [assigned.milligrades]
      }
    };
  });
}

function evidenceObservationsFrom(
  state: FieldEngineState,
  input: ObserveFieldInput
): readonly EvidenceObservation[] {
  return state.observations.map((observation) => ({
    observation_id: observation.observation_id,
    evidence_id: observation.observation_id,
    source_id: observation.object_id,
    source_revision: state.snapshot_id,
    query_id: state.query_id,
    snapshot_id: state.snapshot_id,
    hypothesis_id: "h0",
    binding_context: "default",
    time_state: "as_of",
    jurisdiction: "workspace",
    premise_id: observation.object_id,
    proposition_id: COMMON_CAUSE_PROPOSITION_KIND,
    polarity: "supports",
    access: "eligible",
    validity: OPEN_VALIDITY,
    as_of: input.as_of,
    lineage_id: observation.source_revision,
    independence_key: observation.observation_id,
    association_milligrades: observation.association_milligrades ?? MILLIGRADE_TOP,
    cost: 1
  }));
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

function nativeAction(
  action: ReturnType<typeof proposeFieldWork>["actions"][number]
): ReturnType<typeof proposeFieldWork>["actions"][number] {
  return { ...action, work_limit: Math.min(512, Math.max(action.work_limit, NATIVE_PAGE)) };
}

function openResiduals(includeBinding: boolean): readonly CoverageRegion[] {
  const residuals: CoverageRegion[] = [
    residual("seed", "seed"),
    residual("adjacency", "adjacency")
  ];
  if (includeBinding) residuals.push(residual("binding", "binding"));
  return residuals;
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

function productKey(objectId: string) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: objectId,
    program_state: "accepting",
    hypothesis_id: "h0",
    binding_context: "default",
    time_state: "as_of"
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
