import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  MemoryDimension,
  MILLIGRADE_TOP,
  ScopeClass,
  formatConditionalFieldDigest,
  type Continuation,
  type InformationIndex,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { type ObserverReaders } from "../conditional-field/observers/observe.js";
import { projectFieldDelta } from "../conditional-field/engine/field-engine.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { normalizeQueryText } from "./recall-service-helpers.js";
import type { RecallResult } from "./recall-service-types.js";
import type { RecallExecutionContext, RecallExecutionParams } from "./recall-service-runner-types.js";
import { withRecallReadSnapshot } from "./recall-read-snapshot.js";
import { assertRecallZeroLiveExtraction } from "./zero-live-extraction.js";
import {
  RELATION_MILLIGRADES,
  assessUnknownCause,
  emptyField,
  observeField,
  rolesFrom
} from "./conditional-field-observe.js";

export type { RecallExecutionContext, RecallExecutionParams, PreparedRecallRequest } from "./recall-service-runner-types.js";
export { RELATION_MILLIGRADES };

const RESULT_VERSION = "v1";
const DEFAULT_WORK_UNITS = 10_000;
const DEFAULT_MEMORY_BYTES = 1_000_000;
const DEFAULT_RESERVE = 100;
const DEFAULT_MIN_ENVELOPE = 10;
const CONTINUATION_MS = 5 * 60_000;

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

function projectFromField(
  state: ReturnType<typeof observeField>,
  input: ConditionalFieldRecallRequest,
  interpretation: ReturnType<typeof compileConditionalFieldQuery>
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
  const snapshotId = pinnedSnapshotId(params, fieldDeps(context));
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

function pinnedSnapshotId(
  params: RecallExecutionParams,
  deps: ReturnType<typeof fieldDeps>
): string {
  const supplied = validSnapshot(params.snapshotDigest);
  if (supplied !== undefined) return supplied;
  const pin = deps.observerReaders?.snapshotPin?.(params.workspaceId);
  const revision = pin?.source_revision ?? "unpinned";
  const appliedAt = pin?.applied_at ?? "";
  return formatConditionalFieldDigest(
    createHash("sha256").update(`${params.workspaceId}\0${revision}\0${appliedAt}`, "utf8").digest("hex")
  );
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

function validSnapshot(value: string | undefined): string | undefined {
  return value !== undefined && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function nullableTime(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}
