import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  MemoryDimension,
  MILLIGRADE_TOP,
  ScopeClass,
  formatConditionalFieldDigest,
  type Continuation,
  type CoverageRegion,
  type IndexRole,
  type InformationIndex,
  type ObserverCursor,
  type QueryInterpretation,
  type RequestBudget,
  type SeedActivation,
  type SnapshotReadLease,
  type Transition
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
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
  projectFieldDelta,
  proposeFieldWork,
  type FieldEngineState,
  type FieldObservationEffect
} from "../conditional-field/engine/field-engine.js";
import {
  COMMON_CAUSE_PROPOSITION_KIND,
  assessEvidence
} from "../conditional-field/evidence/assess-support.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { normalizeQueryText } from "./recall-service-helpers.js";
import type { RecallResult } from "./recall-service-types.js";
import type { RecallExecutionContext, RecallExecutionParams } from "./recall-service-runner-types.js";
import { withRecallReadSnapshot } from "./recall-read-snapshot.js";
import { assertRecallZeroLiveExtraction } from "./zero-live-extraction.js";

export type { RecallExecutionContext, RecallExecutionParams, PreparedRecallRequest } from "./recall-service-runner-types.js";

const RESULT_VERSION = "v1";
const DEFAULT_WORK_UNITS = 10_000;
const DEFAULT_MEMORY_BYTES = 1_000_000;
const DEFAULT_RESERVE = 100;
const DEFAULT_MIN_ENVELOPE = 10;
const CONTINUATION_MS = 5 * 60_000;
const MAX_OBSERVE_ROUNDS = 4_096;
const NATIVE_PAGE = 32;
const OPEN_VALIDITY = { kind: "open" as const, valid_from: "1970-01-01T00:00:00.000Z" };

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

export type ConditionalFieldRecallRequest = Readonly<{
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: RequestBudget;
  readonly snapshot_id: string;
  readonly interpretation_clock: string;
  readonly as_of: string;
  readonly expires_at: string;
  readonly readers: ObserverReaders;
  readonly since?: string;
  readonly until?: string;
  readonly continuation?: Continuation | null;
  readonly cancelled?: boolean;
  readonly authorized_scopes?: readonly string[];
}>;

export type ConditionalFieldRecallResult = RecallResult & Readonly<{
  readonly index: InformationIndex;
  readonly provider_calls: 0;
  readonly garden_enqueue: 0;
}>;

export type ConditionalFieldRecallPort = Readonly<{
  recall(input: Omit<ConditionalFieldRecallRequest, "readers">): Promise<InformationIndex>;
}>;

export async function executeRecall(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<ConditionalFieldRecallResult> {
  assertRecallZeroLiveExtraction();
  const request = buildRecallRequest(context, params);
  const index = await withRecallReadSnapshot(context.readSnapshot, async () => {
    const port = fieldDeps(context).conditionalFieldPort;
    if (port !== undefined) return await port.recall(withoutReaders(request));
    return runConditionalFieldRecall(request);
  });
  return encodeRecallResult(index);
}

export function runConditionalFieldRecall(input: ConditionalFieldRecallRequest): InformationIndex {
  const interpretation = compileConditionalFieldQuery({
    source: "ordinary",
    text: input.query_text,
    snapshot_id: input.snapshot_id,
    budget: input.budget,
    interpretation_clock: input.interpretation_clock,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until })
  });
  if (interpretation.status === "resource_rejected" || interpretation.status === "malformed"
    || interpretation.status === "unsupported") {
    return projectFromField(emptyField(interpretation, input), input, interpretation);
  }
  const field = observeField(interpretation, input);
  return projectFromField(assessUnknownCause(field, input), input, interpretation);
}

function observeField(
  interpretation: QueryInterpretation,
  input: ConditionalFieldRecallRequest
): FieldEngineState {
  const residuals = openResiduals(input.readers.embeddingIds !== undefined);
  let state = createConditionalField({ interpretation, budget: input.budget, residuals });
  if (input.cancelled === true) return cancelledField(state);
  const lease = activeLease(interpretation);
  const cursors = new Map<string, ObserverCursor>();
  const pairProgress = new Map<string, string | null>();
  const subjects = new Set<string>();
  const predicates = Object.keys(RELATION_MILLIGRADES);
  let pairIndex = 0;
  for (let round = 0; round < MAX_OBSERVE_ROUNDS; round += 1) {
    const proposal = proposeFieldWork(state);
    if (proposal.actions.length === 0) break;
    for (const action of proposal.actions) {
      if (action.action === "seed") {
        const observed = observeSeed(input, interpretation, lease, action, cursors);
        addSubjects(subjects, observed.page.observations.map((row) => row.object_id));
        state = applyObserverPage(state, {
          page: observed.page,
          effects: seedEffects(observed.page.observations)
        });
        continue;
      }
      if (action.action === "measurement") {
        const observed = observeMeasurement(input, interpretation, lease, action, cursors);
        state = applyObserverPage(state, { page: observed.page, effects: [] });
        continue;
      }
      const pair = nextAdjacencyPair(subjects, predicates, pairProgress, pairIndex);
      pairIndex += 1;
      if (pair === undefined) {
        state = closeAdjacency(state, interpretation, action, cursors);
        continue;
      }
      const captured: RelationObserverRow[] = [];
      const observed = observeAdjacency(
        input, interpretation, lease, action, cursors, pair, captured, pairProgress
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

function observeSeed(
  input: ConditionalFieldRecallRequest,
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
    seed_query: input.query_text,
    authorized_scopes: input.authorized_scopes,
    page_limit: NATIVE_PAGE
  });
}

function observeMeasurement(
  input: ConditionalFieldRecallRequest,
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
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation,
  lease: SnapshotReadLease,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>,
  pair: Readonly<{ readonly subject: string; readonly predicate: string }>,
  captured: RelationObserverRow[],
  pairProgress: Map<string, string | null>
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
    page_limit: NATIVE_PAGE
  });
  pairProgress.set(key, observed.page.cursor.committed_through);
  if (observed.page.outcome.status === "exhausted") pairProgress.set(`${key}:done`, "1");
  return observed;
}

function closeAdjacency(
  state: FieldEngineState,
  interpretation: QueryInterpretation,
  action: ReturnType<typeof proposeFieldWork>["actions"][number],
  cursors: Map<string, ObserverCursor>
): FieldEngineState {
  return applyObserverPage(state, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: interpretation.query_id,
      snapshot_id: interpretation.snapshot_id,
      cursor: cursorOf(cursors, interpretation, action.region_id),
      observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
      open_regions: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        region_id: action.region_id,
        kind: "adjacency",
        status: "exhausted"
      }]
    },
    effects: []
  });
}

function assessUnknownCause(
  state: FieldEngineState,
  input: ConditionalFieldRecallRequest
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
    observations: [],
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
  const claims = new Map<string, "unknown">(
    state.seen_identities.map((identity) => [identity.object_id, "unknown"])
  );
  return applyEvidenceEffect(state, { support: assessed.records, claims });
}

function projectFromField(
  state: FieldEngineState,
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation
): InformationIndex {
  const delta = projectFieldDelta(state);
  const snapshot = state.binding.kind === "bound"
    ? state.binding.snapshot
    : {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      snapshot_id: state.snapshot_id,
      query_id: state.query_id,
      seeds: state.seeds,
      values: delta.accepted_states,
      retained_transitions: state.transitions,
      facets: state.facets
    };
  return InformationIndexSchema.parse(projectAcceptingIndex({
    snapshot,
    view: interpretation.view,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    budget: input.budget,
    roles: rolesFrom(state),
    claims: state.claims,
    support: state.support,
    expires_at: input.expires_at,
    as_of: input.as_of,
    prior_continuation: input.continuation ?? null,
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: state.closure.observation },
      open_regions: state.residuals
    },
    interpretation_status: interpretation.status === "resolved" || interpretation.status === "partial"
      || interpretation.status === "hypotheses"
      ? undefined
      : interpretation.status
  }));
}

export function encodeRecallResult(index: InformationIndex): ConditionalFieldRecallResult {
  const candidates = index.entries.map((entry) => {
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    return {
      object_id: entry.object_id,
      object_kind: "memory_entry" as const,
      activation_score: score,
      relevance_score: score,
      content_preview: `${entry.role} ${entry.claim} ${entry.association_milligrades}`,
      token_estimate: 1,
      manifestation: "excerpt" as const,
      dimension: MemoryDimension.FACT,
      scope_class: ScopeClass.PROJECT,
      origin_plane: "workspace_local" as const,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`
    };
  });
  return {
    candidates,
    synthesis: { status: "absent" },
    active_constraints: [],
    active_constraints_count: 0,
    total_scanned: index.entries.length,
    coarse_filter_count: index.entries.length,
    fine_assessment_count: index.entries.length,
    degradation_reason: null,
    working_projection: null,
    index,
    provider_calls: 0,
    garden_enqueue: 0
  };
}

function buildRecallRequest(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): ConditionalFieldRecallRequest {
  const extra = params as RecallExecutionParams & Partial<ConditionalFieldRecallRequest> & {
    readonly pageBudget?: number;
    readonly queryText?: string;
    readonly interpretationClock?: string;
  };
  const now = context.now();
  const queryText = extra.queryText ?? normalizeQueryText(params.taskSurface.display_name) ?? "";
  const pageBudget = extra.pageBudget
    ?? extra.budget?.page_budget
    ?? params.policyOverride?.fine_assessment.budgets.max_entries
    ?? 30;
  const snapshotId = validSnapshot(params.snapshotDigest)
    ?? formatConditionalFieldDigest(
      createHash("sha256").update(`${params.workspaceId}\0${params.referenceTime ?? now}`, "utf8").digest("hex")
    );
  return {
    workspace_id: params.workspaceId,
    query_text: queryText,
    budget: extra.budget ?? {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      work_units: DEFAULT_WORK_UNITS,
      memory_bytes: DEFAULT_MEMORY_BYTES,
      page_budget: pageBudget,
      finalization_reserve: DEFAULT_RESERVE,
      min_envelope: DEFAULT_MIN_ENVELOPE
    },
    snapshot_id: snapshotId,
    interpretation_clock: extra.interpretationClock ?? params.referenceTime ?? now,
    as_of: now,
    expires_at: new Date(Date.parse(now) + CONTINUATION_MS).toISOString(),
    readers: fieldDeps(context).observerReaders ?? {},
    ...(nullableTime(params.timeFilter?.since) === undefined
      ? {}
      : { since: nullableTime(params.timeFilter?.since) }),
    ...(nullableTime(params.timeFilter?.until) === undefined
      ? {}
      : { until: nullableTime(params.timeFilter?.until) }),
    ...(extra.since === undefined ? {} : { since: extra.since }),
    ...(extra.until === undefined ? {} : { until: extra.until }),
    continuation: extra.continuation ?? null,
    cancelled: extra.cancelled === true,
    ...(params.policyOverride?.coarse_filter.deterministic_match.scope_filter === undefined
      || params.policyOverride.coarse_filter.deterministic_match.scope_filter === null
      ? {}
      : {
        authorized_scopes: params.policyOverride.coarse_filter.deterministic_match.scope_filter
      })
  };
}

function fieldDeps(context: RecallExecutionContext): Readonly<{
  readonly observerReaders?: ObserverReaders;
  readonly conditionalFieldPort?: ConditionalFieldRecallPort;
}> {
  return context.dependencies as typeof context.dependencies & {
    readonly observerReaders?: ObserverReaders;
    readonly conditionalFieldPort?: ConditionalFieldRecallPort;
  };
}

function withoutReaders(
  input: ConditionalFieldRecallRequest
): Omit<ConditionalFieldRecallRequest, "readers"> {
  const { readers: _readers, ...rest } = input;
  return rest;
}

function emptyField(
  interpretation: QueryInterpretation,
  input: ConditionalFieldRecallRequest
): FieldEngineState {
  return createConditionalField({
    interpretation,
    budget: input.budget,
    residuals: openResiduals(false)
  });
}

function cancelledField(state: FieldEngineState): FieldEngineState {
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

function rolesFrom(state: FieldEngineState): ReadonlyMap<string, IndexRole> {
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

function seedEffects(
  observations: FieldEngineState["observations"]
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
    return { observation_id: `adjacency:${row.assertionId}`, transition };
  });
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
  // Engine schedules one residual; native pages must be wide enough to emit identities.
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

function validSnapshot(value: string | undefined): string | undefined {
  return value !== undefined && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function nullableTime(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}
