import { createHash, randomUUID } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  MemoryDimension,
  MILLIGRADE_TOP,
  ScopeClass,
  formatConditionalFieldDigest,
  type Continuation,
  type BoundedActiveConstraintsResult,
  type InformationIndex,
  type QueryInterpretation,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  compileConditionalFieldQuery,
  interpretationIdentity
} from "../conditional-field/query/compile-query.js";
import { interpretationCoverageFor } from "../conditional-field/reference/interpret-query.js";
import { type ObserverReaders } from "../conditional-field/observers/observe.js";
import { projectFieldDelta, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { captureEffectiveAsOf, normalizeQueryText } from "./recall-service-helpers.js";
import type { RecallResult } from "./recall-service-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { BoundedIndexPayload } from "./index-payload.js";
import { resumeIndexProjection, retainIndexDelivery } from "./index-continuation.js";
import type { ConditionalFieldExecutionReceipt } from "./conditional-field-execution-receipt.js";
import type { RecallExecutionContext, RecallExecutionParams } from "./recall-service-runner-types.js";
import { withRecallReadSnapshot } from "./recall-read-snapshot.js";
import { assertRecallZeroLiveExtraction } from "./zero-live-extraction.js";
import {
  RELATION_MILLIGRADES,
  emptyField,
  observeField
} from "./conditional-field-observe.js";
import { assessUnknownCause, rolesFrom } from "./semantic-attribution.js";
import { readRequestGovernance } from "./request-governance.js";
import { reserveSnapshotPinWork } from "./snapshot-pin-budget.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";

export type { RecallExecutionContext, RecallExecutionParams } from "./recall-service-runner-types.js";
export { RELATION_MILLIGRADES };

const RESULT_VERSION = "v1";
const DEFAULT_WORK_UNITS = 10_000;
const DEFAULT_MEMORY_BYTES = 1_000_000;
const DEFAULT_RESERVE = 100;
const DEFAULT_MIN_ENVELOPE = 10;
const CONTINUATION_MS = 5 * 60_000;
const FIELD_RESUME_MAX = 32;
// Process loss invalidates issued tokens; the parent pins one worker per snapshot lease.
const FIELD_RESUME = new Map<string, Readonly<{ state: FieldEngineState; token_digest: string }>>();
const INDEX_PREVIEWS = new WeakMap<InformationIndex, ReadonlyMap<string, string>>();
const INDEX_SOURCE_METADATA = new WeakMap<InformationIndex, Readonly<Record<string, RecallSourceMetadata>>>();
const FIELD_SOURCE_PINS = new WeakMap<FieldEngineState, string>();

export type ConditionalFieldRecallRequest = Readonly<{
  readonly requested_budget?: RequestBudget;
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: RequestBudget;
  readonly snapshot_id: string;
  readonly interpretation_clock: string;
  readonly as_of: string;
  readonly expires_at: string;
  readonly lifetime_now?: string;
  readonly readers: ObserverReaders;
  readonly since?: string;
  readonly until?: string;
  readonly time_field?: "created_at" | "last_used_at";
  readonly dimension_filter?: readonly string[];
  readonly domain_tag_filter?: readonly string[];
  readonly continuation?: Continuation | null;
  readonly cancelled?: boolean;
  readonly authorized_scopes?: readonly string[];
  readonly governance?: BoundedActiveConstraintsResult;
}>;

export type ConditionalFieldRecallResult = RecallResult & Readonly<{
  readonly index: InformationIndex;
  readonly provider_calls: 0;
  readonly garden_enqueue: 0;
}>;

export type ConditionalFieldRecallPortResult = Readonly<{
  readonly execution_receipt?: ConditionalFieldExecutionReceipt;
  readonly index: InformationIndex;
  readonly previews: Readonly<Record<string, string>>;
  readonly source_metadata?: Readonly<Record<string, RecallSourceMetadata>>;
}>;

export type ConditionalFieldRecallPort = Readonly<{
  recall(
    input: Omit<ConditionalFieldRecallRequest, "readers">
  ): Promise<InformationIndex | ConditionalFieldRecallPortResult>;
}>;

export async function executeRecall(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<ConditionalFieldRecallResult> {
  if (params.policyOverride?.scoring_weight_overrides !== undefined
    || params.policyOverride?.domain_weight_overrides !== undefined) {
    throw new TypeError("Recall scoring_weight_overrides and domain_weight_overrides are retired for conditional-field requests");
  }
  if (params.querySemanticFactorFormationCapture !== undefined
    || params.querySemanticFactorCompletenessReceipt !== undefined) {
    throw new TypeError("Recall query semantic factor capture and completeness receipt overrides are retired for conditional-field requests");
  }
  assertRecallZeroLiveExtraction();
  let previews = new Map<string, string>();
  let sourceMetadata: Readonly<Record<string, RecallSourceMetadata>> = {};
  let governance: BoundedActiveConstraintsResult | undefined;
  let executionReceipt: ConditionalFieldExecutionReceipt | undefined;
  const index = await withRecallReadSnapshot(context.readSnapshot, async () => {
    const port = fieldDeps(context).conditionalFieldPort;
    const sent = buildRecallRequest(context, params);
    const original = captureRequestSnapshot(sent, port === undefined);
    const governed = await readRequestGovernance(original, context.dependencies.activeConstraintsPort,
      params.activeConstraintsCap, port !== undefined);
    governance = governed.governance;
    const request = { ...original, snapshot_id: governance.binding.snapshot_id,
      budget: governed.budget, requested_budget: sent.budget, governance };
    if (port !== undefined) {
      const recalled = portIndexAndPreviews(await port.recall(withoutReaders(request)));
      previews = recalled.previews;
      sourceMetadata = recalled.source_metadata;
      executionReceipt = recalled.execution_receipt;
      return recalled.index;
    }
    const executed = runConditionalFieldRecallWithReceipt(request);
    const recalled = executed.index;
    executionReceipt = executed.execution_receipt;
    previews = captureIndexPreviews(recalled, request.readers, request.workspace_id);
    sourceMetadata = captureIndexSourceMetadata(recalled);
    return recalled;
  });
  return { ...encodeRecallResult(index, previews, governance, sourceMetadata), execution_receipt: executionReceipt };
}

export function runConditionalFieldRecall(input: ConditionalFieldRecallRequest): InformationIndex {
  return runConditionalFieldRecallWithReceipt(input).index;
}

export function runConditionalFieldRecallWithReceipt(input: ConditionalFieldRecallRequest): Readonly<{
  index: InformationIndex; execution_receipt: ConditionalFieldExecutionReceipt;
}> {
  const requestedBudget = input.requested_budget ?? input.budget;
  if (input.readers.snapshotPin !== undefined) {
    const reserved = reserveSnapshotPinWork(input.budget);
    input = { ...input, budget: reserved.budget };
  }
  const compileInput = {
    source: "ordinary" as const,
    text: input.query_text,
    snapshot_id: input.snapshot_id,
    budget: input.budget,
    interpretation_clock: input.interpretation_clock,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.time_field === undefined ? {} : { time_field: input.time_field }),
    ...(input.dimension_filter === undefined ? {} : { dimension_filter: input.dimension_filter }),
    ...(input.domain_tag_filter === undefined ? {} : { domain_tag_filter: input.domain_tag_filter }),
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes })
  };
  const interpretation = compileConditionalFieldQuery(compileInput);
  const executionReceipt: ConditionalFieldExecutionReceipt = {
    schema_version: 1, workspace_id: input.workspace_id, requested_budget: requestedBudget,
    compile_input: compileInput, query_id: interpretation.query_id,
    interpretation_id: interpretationIdentity({ interpretation_clock: input.interpretation_clock }),
    snapshot_id: input.snapshot_id, interpretation_clock: input.interpretation_clock
  };
  return { index: runCompiledConditionalFieldRecall(input, interpretation), execution_receipt: executionReceipt };
}

function runCompiledConditionalFieldRecall(
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation
): InformationIndex {
  if (continuationEpochMismatch(input.continuation, interpretation)
    || (input.continuation != null && (
      input.continuation.snapshot_id !== input.snapshot_id
      || Date.parse(input.continuation.expires_at) <= Date.parse(input.lifetime_now ?? new Date().toISOString())
    ))) {
    return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
  }
  if (interpretation.status === "resource_rejected" || interpretation.status === "malformed"
    || interpretation.status === "unsupported") {
    return projectFromField(emptyField(interpretation, input), input, interpretation);
  }
  const restored = restoreField(input.continuation, interpretation);
  if (input.continuation != null && restored === undefined) {
    return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
  }
  const pin = input.readers.snapshotPin?.(input.workspace_id);
  const currentPin = pin === undefined ? undefined : JSON.stringify([
    snapshotIdFromPin(input.workspace_id, pin), [...(input.readers.permittedTimelessPolicyIds?.() ?? [])].sort()
  ]);
  if (restored !== undefined && FIELD_SOURCE_PINS.get(restored) !== currentPin) {
    return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
  }
  const field = observeField(interpretation, {
    workspace_id: input.workspace_id,
    query_text: input.query_text,
    budget: input.budget,
    as_of: input.as_of,
    readers: input.readers,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    ...(restored === undefined ? {} : { resume_field: restored }),
    ...(pin === undefined ? {} : { expected_source_revision: pin.source_revision })
  });
  let retained = field;
  const projected = projectFromField(assessUnknownCause(field, input), input, interpretation, (next) => { retained = next; });
  const index = projected.entries.length === 0 && fieldProgress(retained) === fieldProgress(restored)
    && (restored !== undefined || input.budget.work_units <= 1)
    ? { ...projected, continuation: null } : projected;
  if (currentPin !== undefined) FIELD_SOURCE_PINS.set(retained, currentPin);
  rememberField(retained, index.continuation);
  return index;
}

function fieldProgress(state: FieldEngineState | undefined): string {
  return JSON.stringify([state?.observations.length ?? 0, state?.seeds.length ?? 0,
    state?.transitions.length ?? 0, state?.grounding_progress?.completed_work ?? 0,
    state?.resume_cursors ?? {}, state?.pair_progress ?? {}, state?.support_progress ?? {},
    state?.projection_progress?.offset ?? 0, state?.projection_progress?.delivered_entries ?? {}]);
}

function fieldResumeKey(queryId: string, snapshotId: string, interpretationId: string): string {
  return `${queryId}\0${snapshotId}\0${interpretationId}\0${RESULT_VERSION}`;
}

function rememberField(state: FieldEngineState, continuation: Continuation | null): void {
  const key = fieldResumeKey(
    state.query_id,
    state.snapshot_id,
    interpretationIdentity({ interpretation_clock: state.interpretation.interpretation_clock })
  );
  FIELD_RESUME.delete(key);
  if (continuation === null) return;
  FIELD_RESUME.set(key, { state, token_digest: continuationDigest(continuation) });
  while (FIELD_RESUME.size > FIELD_RESUME_MAX) {
    const oldest = FIELD_RESUME.keys().next().value;
    if (oldest === undefined) break;
    FIELD_RESUME.delete(oldest);
  }
}

function restoreField(
  continuation: ConditionalFieldRecallRequest["continuation"],
  interpretation: QueryInterpretation
): FieldEngineState | undefined {
  if (continuation === undefined || continuation === null) return undefined;
  const retained = FIELD_RESUME.get(fieldResumeKey(
    continuation.query_id,
    continuation.snapshot_id,
    continuation.interpretation_id
      ?? interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock })
  ));
  return retained?.token_digest === continuationDigest(continuation) ? retained.state : undefined;
}

function continuationDigest(continuation: Continuation): string {
  return createHash("sha256").update(JSON.stringify([continuation.schema_version, continuation.continuation_id,
    continuation.query_id, continuation.snapshot_id, continuation.result_version, continuation.expires_at,
    continuation.cursor, continuation.interpretation_id, continuation.interpretation_clock])).digest("hex");
}

function projectFromField(
  state: ReturnType<typeof observeField>,
  input: ConditionalFieldRecallRequest,
  interpretation: ReturnType<typeof compileConditionalFieldQuery>,
  retain?: (state: FieldEngineState) => void
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
  const ceilings = governanceManifestationCeilings(input.governance?.paths ?? []);
  const manifestationFor = (id: string) => input.governance === undefined ? "excerpt" as const
    : governanceManifestationFor(id, ceilings, input.governance.completeness === "complete"
      && !input.governance.temporal_uncertain);
  let retained = state;
  let projectionProgress = resumeIndexProjection(state, snapshot);
  const payload = new BoundedIndexPayload({ sourceFacts: state.source_facts,
    previewCache: state.preview_cache, readers: input.readers, workspaceId: input.workspace_id,
    remainingMemoryBytes: state.remaining_memory_bytes, manifestationFor });
  let index = annotatePublicIndex(InformationIndexSchema.parse(projectAcceptingIndex({
    snapshot,
    view: interpretation.view,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    budget: input.budget,
    projection_scan_offset: projectionProgress.offset,
    projection_generation: projectionProgress.generation,
    delivered_product_ids: new Set(Object.keys(projectionProgress.delivered_entries)),
    delivered_entry_revisions: projectionProgress.delivered_entries,
    on_projection_progress: (offset) => { projectionProgress = { ...projectionProgress, offset }; },
    roles: rolesFrom(state, RELATION_MILLIGRADES),
    claims: state.claims,
    claim_propositions: state.claim_propositions,
    transition_derivations: state.transition_derivations,
    source_facts: state.source_facts,
    grounding_progress: state.grounding_progress,
    remaining_memory_bytes: payload.remainingMemoryBytes,
    on_grounding_progress: (progress, retainedBytes) => {
      payload.remainingMemoryBytes = Math.max(0, payload.remainingMemoryBytes - retainedBytes);
      retained = { ...retained, grounding_progress: progress, remaining_memory_bytes: payload.remainingMemoryBytes };
      projectionProgress = resumeIndexProjection(retained, snapshot);
    },
    on_remaining_reserve: (remaining) => {
      retained = { ...retained, remaining_reserve: Math.min(state.remaining_reserve, remaining),
        remaining_exploration: Math.max(0, remaining - state.remaining_reserve) };
    },
    support: state.support,
    expires_at: input.expires_at,
    as_of: input.as_of,
    lifetime_now: input.lifetime_now,
    payload_work_per_entry: 5,
    // Entry admission reserves every payload work unit; missing source or retained-memory capacity cannot improve by replaying the same page.
    finalize_payload: (entries, allowance) => ({ ...payload.finalize(entries, allowance), retryable: false }),
    prior_continuation: input.continuation ?? null,
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: state.closure.observation },
      open_regions: state.residuals
    },
    resume_cursors: state.resume_cursors,
    interpretation_status: interpretation.status,
    remaining_reserve: state.remaining_exploration + state.remaining_reserve,
    interpretation_id: interpretationIdentity({
      interpretation_clock: interpretation.interpretation_clock
    }),
    ...(interpretation.interpretation_clock === undefined
      ? {}
      : { interpretation_clock: interpretation.interpretation_clock }),
    payload_generation: interpretation.snapshot_id,
    ...((state.derivations?.length ?? 0) === 0 ? {} : { derivations: state.derivations }),
    ...(state.support_work_status === undefined ? {} : { support_work_status: state.support_work_status }),
    ...(state.memory_exhausted || state.remaining_work.length > 0
      ? { resource_work: "open" as const }
      : {})
  })), interpretation);
  const delivery = retainIndexDelivery(projectionProgress, index.entries, state.projection_progress === undefined);
  if (delivery.bytes > payload.remainingMemoryBytes) index = { ...index, continuation: null };
  else {
    payload.remainingMemoryBytes -= delivery.bytes;
    retained = { ...retained, projection_progress: delivery.progress };
  }
  if (index.continuation !== null) index = { ...index,
    continuation: { ...index.continuation, continuation_id: randomUUID() } };
  INDEX_PREVIEWS.set(index, payload.previews);
  INDEX_SOURCE_METADATA.set(index, payload.sourceMetadata);
  retained = { ...retained, preview_cache: Object.fromEntries(payload.previews),
    remaining_memory_bytes: payload.remainingMemoryBytes };
  retain?.(retained);
  return index;
}

export function encodeRecallResult(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map(),
  governance?: BoundedActiveConstraintsResult,
  sourceMetadata: Readonly<Record<string, RecallSourceMetadata>> = {}
): ConditionalFieldRecallResult {
  const ceilings = governanceManifestationCeilings(governance?.paths ?? []);
  const excerpts = index.entries.map((entry) => previews.get(entry.object_id));
  const hydrated = excerpts.filter((excerpt) => excerpt !== undefined).length;
  const payload = index.entries.length === 0
    ? index.completeness.payload
    : hydrated === 0
      ? "omitted"
      : hydrated < index.entries.length
        ? "partial"
        : index.completeness.payload;
  const encodedIndex: InformationIndex = payload === index.completeness.payload
    ? index
    : {
      ...index,
      completeness: { ...index.completeness, payload }
    };
  const candidates = encodedIndex.entries.map((entry, offset) => {
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    return {
      object_id: entry.object_id,
      object_kind: "memory_entry" as const,
      activation_score: score,
      relevance_score: score,
      content_preview: excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW,
      token_estimate: previewTokenEstimate(excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW),
      manifestation: governance === undefined ? "excerpt" as const
        : governanceManifestationFor(entry.object_id, ceilings,
          governance.completeness === "complete" && !governance.temporal_uncertain),
      dimension: MemoryDimension.FACT,
      scope_class: ScopeClass.PROJECT,
      origin_plane: "workspace_local" as const,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      ...(sourceMetadata[entry.object_id]?.staged_warnings === undefined ? {} : {
        staged_warnings: sourceMetadata[entry.object_id]!.staged_warnings
      })
    };
  });
  return {
    candidates,
    source_metadata: sourceMetadata,
    synthesis: { status: "absent" },
    active_constraints: governance?.constraints ?? [],
    active_constraints_count: governance?.total_count ?? null,
    active_constraints_completeness: governance?.completeness ?? "incomplete",
    total_scanned: encodedIndex.entries.length,
    coarse_filter_count: encodedIndex.entries.length,
    fine_assessment_count: encodedIndex.entries.length,
    degradation_reason: null,
    working_projection: null,
    index: encodedIndex,
    provider_calls: 0,
    garden_enqueue: 0
  };
}

const PAYLOAD_OMITTED_PREVIEW = "[payload omitted]";

export function captureIndexPreviews(
  index: InformationIndex,
  _readers: ObserverReaders,
  _workspaceId: string
): Map<string, string> {
  return new Map(INDEX_PREVIEWS.get(index) ?? []);
}

export function captureIndexSourceMetadata(index: InformationIndex): Readonly<Record<string, RecallSourceMetadata>> {
  return INDEX_SOURCE_METADATA.get(index) ?? {};
}

function portIndexAndPreviews(
  recalled: InformationIndex | ConditionalFieldRecallPortResult
): Readonly<{ readonly index: InformationIndex; readonly previews: Map<string, string>;
  readonly source_metadata: Readonly<Record<string, RecallSourceMetadata>>;
  readonly execution_receipt?: ConditionalFieldExecutionReceipt }> {
  if ("previews" in recalled && "index" in recalled) {
    return {
      index: recalled.index,
      previews: new Map(Object.entries(recalled.previews)),
      source_metadata: recalled.source_metadata ?? {},
      execution_receipt: recalled.execution_receipt
    };
  }
  throw new TypeError("conditionalField.recall must return index and previews");
}

function interpretationIdOf(interpretation: QueryInterpretation): string {
  return interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock });
}

function continuationEpochMismatch(
  continuation: Continuation | null | undefined,
  interpretation: QueryInterpretation
): boolean {
  if (continuation === undefined || continuation === null) return false;
  if (continuation.interpretation_id === undefined) return true;
  return continuation.interpretation_id !== interpretationIdOf(interpretation);
}

function annotatePublicIndex(
  index: InformationIndex,
  interpretation: QueryInterpretation
): InformationIndex {
  const interpretationId = interpretationIdOf(interpretation);
  const coverage = interpretationCoverageFor(interpretation.status, interpretation);
  const completeness = index.completeness.interpretation_coverage === undefined
    ? { ...index.completeness, interpretation_coverage: coverage }
    : index.completeness;
  const continuation = index.continuation === null
    ? null
    : {
      ...index.continuation,
      interpretation_id: index.continuation.interpretation_id ?? interpretationId,
      interpretation_clock: index.continuation.interpretation_clock
        ?? interpretation.interpretation_clock
    };
  return { ...index, completeness, continuation, interpretation_id: interpretationId,
    as_of: interpretation.interpretation_clock };
}

function invalidatedPublicIndex(
  interpretation: QueryInterpretation,
  input: ConditionalFieldRecallRequest
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    entries: [],
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "invalidated",
      observed_coverage: "invalidated",
      interpretation_coverage: interpretationCoverageFor(interpretation.status, interpretation),
      transport: "invalidated",
      payload: "invalidated",
      representation: "invalidated"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: input.budget.page_budget,
      identity_tie_break: "serialization"
    }
  };
}

function previewTokenEstimate(preview: string): number {
  return Math.max(1, Buffer.byteLength(preview, "utf8"));
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
  const snapshotId = validSnapshot(params.snapshotDigest) ?? snapshotIdFromPin(params.workspaceId, undefined);
  const continued = extra.continuation;
  const clock = captureEffectiveAsOf(extra.interpretationClock
    ?? params.referenceTime
    ?? continued?.interpretation_clock
    ?? now, context.now);
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
    interpretation_clock: clock,
    as_of: clock,
    lifetime_now: now,
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
    ...(params.timeFilter?.field === undefined ? {} : { time_field: params.timeFilter.field }),
    continuation: extra.continuation ?? null,
    cancelled: extra.cancelled === true,
    ...(params.policyOverride?.coarse_filter.deterministic_match.scope_filter === undefined
      || params.policyOverride.coarse_filter.deterministic_match.scope_filter === null
      ? {}
      : {
        authorized_scopes: params.policyOverride.coarse_filter.deterministic_match.scope_filter
      }),
    ...nullableStringList(
      params.policyOverride?.coarse_filter.deterministic_match.dimension_filter,
      "dimension_filter"
    ),
    ...nullableStringList(
      params.policyOverride?.coarse_filter.deterministic_match.domain_tag_filter,
      "domain_tag_filter"
    )
  };
}

function nullableStringList(
  values: readonly string[] | null | undefined,
  key: "dimension_filter" | "domain_tag_filter"
): Partial<Pick<ConditionalFieldRecallRequest, "dimension_filter" | "domain_tag_filter">> {
  if (values === undefined || values === null || values.length === 0) return {};
  return { [key]: values };
}

export function snapshotIdFromPin(
  workspaceId: string,
  pin: Readonly<{ readonly source_revision: string; readonly applied_at?: string }> | undefined
): string {
  const revision = pin?.source_revision ?? "unpinned";
  const appliedAt = pin?.applied_at ?? "";
  return formatConditionalFieldDigest(
    createHash("sha256").update(`${workspaceId}\0${revision}\0${appliedAt}`, "utf8").digest("hex")
  );
}

function captureRequestSnapshot(
  request: ConditionalFieldRecallRequest,
  capture: boolean
): ConditionalFieldRecallRequest {
  if (!capture || request.cancelled || request.readers.snapshotPin === undefined) return request;
  const reserved = reserveSnapshotPinWork(request.budget);
  return { ...request, budget: reserved.budget,
    snapshot_id: reserved.permitted
      ? snapshotIdFromPin(request.workspace_id, request.readers.snapshotPin(request.workspace_id))
      : request.snapshot_id };
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
