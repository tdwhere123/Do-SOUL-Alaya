import { createHash, randomUUID } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  MemoryDimension,
  MILLIGRADE_TOP,
  QueryViewSchema,
  ScopeClass,
  formatConditionalFieldDigest,
  indexEntryCacheKey,
  indexEntryObjectKind,
  indexMemoryObjectId,
  type Continuation,
  type BoundedActiveConstraintsResult,
  type InformationIndex,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import {
  compileConditionalFieldQuery,
  continuationViewMismatch,
  interpretationIdentity
} from "../conditional-field/query/compile-query.js";
import { interpretationCoverageFor } from "../conditional-field/reference/interpret-query.js";
import { type ObserverReaders } from "../conditional-field/observers/observe.js";
import { projectFieldDelta, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { orderedProjectionValues } from "../conditional-field/engine/field-solve.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import { fieldProgressFingerprint } from "../conditional-field/index/facet-visit-accounting.js";
import {
  captureEffectiveAsOf,
  normalizeQueryText,
  nullableTime,
  previewTokenEstimate,
  validSnapshot
} from "./recall-service-helpers.js";
import type { RecallResult } from "./recall-service-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { BoundedIndexPayload } from "./index-payload.js";
import {
  bindIssuedDeliveryId,
  continuationDigest,
  evictIssuedDeliveries,
  fieldResumeKey,
  issuedDeliveryIdOf,
  issuedDeliveryRevoked,
  rememberField,
  rememberIssuedDelivery,
  replayIssuedDelivery,
  replayIssuedIndex,
  restoreField,
  resumeIndexProjection,
  retainCommittedRevisions,
  mergeCommittedRevisions
} from "./index-continuation.js";
import type { ConditionalFieldExecutionReceipt } from "./conditional-field-execution-receipt.js";
import { startRequestCost, type RequestCostLedger } from "./request-cost-ledger.js";
import type {
  ConditionalFieldRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "./recall-service-runner-types.js";
import { withRecallReadSnapshot } from "./recall-read-snapshot.js";
import { assertRecallZeroLiveExtraction } from "./zero-live-extraction.js";
import {
  RELATION_ROUTING as RELATION_MILLIGRADES,
  emptyField,
  observeField
} from "./conditional-field-observe.js";
import { assessUnknownCause, rolesFrom } from "./semantic-attribution.js";
import { readRequestGovernance } from "./request-governance.js";
import { reserveSnapshotPinWork } from "./snapshot-pin-budget.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "./governance-manifestation.js";
import {
  assertRecallConsumerCompatibility,
  continuationConsumerIdentity,
  recallConsumerViewIdentity
} from "./recall-consumer-compatibility.js";

export type {
  ConditionalFieldRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "./recall-service-runner-types.js";
export { RELATION_MILLIGRADES };

const RESULT_VERSION = "v1";
const DEFAULT_WORK_UNITS = 10_000;
const DEFAULT_MEMORY_BYTES = 1_000_000;
const DEFAULT_RESERVE = 100;
const DEFAULT_MIN_ENVELOPE = 10;
const CONTINUATION_MS = 5 * 60_000;
const INDEX_PREVIEWS = new WeakMap<InformationIndex, ReadonlyMap<string, string>>();
const INDEX_SOURCE_METADATA = new WeakMap<InformationIndex, Readonly<Record<string, RecallSourceMetadata>>>();
const FIELD_SOURCE_PINS = new WeakMap<FieldEngineState, string>();
const ISSUED_SURFACES = new Map<string, Readonly<{
  readonly previews: ReadonlyMap<string, string>;
  readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
}>>();

export type ConditionalFieldRecallResult = RecallResult & Readonly<{
  readonly index: InformationIndex;
  readonly provider_calls: 0;
  readonly garden_enqueue: 0;
  readonly issued_delivery_id?: string;
}>;

export type ConditionalFieldRecallPortResult = Readonly<{
  readonly execution_receipt?: ConditionalFieldExecutionReceipt;
  readonly index: InformationIndex;
  readonly previews: Readonly<Record<string, string>>;
  readonly source_metadata?: Readonly<Record<string, RecallSourceMetadata>>;
  readonly issued_delivery_id?: string;
}>;

export type ConditionalFieldRecallPort = Readonly<{
  recall(
    input: Omit<ConditionalFieldRecallRequest, "readers">
  ): Promise<ConditionalFieldRecallPortResult>;
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
    assertRecallConsumerCompatibility(sent);
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
  const issuedDeliveryId = issuedDeliveryIdOf(index);
  return {
    ...encodeRecallResult(index, previews, governance, sourceMetadata),
    execution_receipt: executionReceipt,
    ...(issuedDeliveryId === undefined ? {} : { issued_delivery_id: issuedDeliveryId })
  };
}

export function runConditionalFieldRecall(input: ConditionalFieldRecallRequest): InformationIndex {
  return runConditionalFieldRecallWithReceipt(input).index;
}

export function runConditionalFieldRecallWithReceipt(input: ConditionalFieldRecallRequest): Readonly<{
  index: InformationIndex; execution_receipt: ConditionalFieldExecutionReceipt;
}> {
  const cost = startRequestCost();
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
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    view: QueryViewSchema.parse({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      requested_roles: ["requested", "associated"],
      enumeration_policy: input.enumeration_policy ?? "canonical",
      result_kind_view: input.result_kind_view ?? "mixed",
      ...(input.cap_contracts === undefined ? {} : { cap_contracts: input.cap_contracts }),
      ...(input.claim_demands === undefined ? {} : { claim_demands: input.claim_demands }),
      ...recallConsumerViewIdentity(input)
    }),
    ...(input.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: input.interpretation_proposal })
  };
  const interpretation = cost.time("compile", () => compileConditionalFieldQuery(compileInput));
  const index = runCompiledConditionalFieldRecall(input, interpretation, cost);
  cost.markAfterProjection();
  return { index, execution_receipt: {
    schema_version: 1, workspace_id: input.workspace_id, requested_budget: requestedBudget,
    compile_input: compileInput, query_id: interpretation.query_id,
    interpretation_id: interpretationIdentity({ interpretation_clock: input.interpretation_clock }),
    snapshot_id: input.snapshot_id, interpretation_clock: input.interpretation_clock,
    actual: cost.snapshot()
  } };
}

function runCompiledConditionalFieldRecall(
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation,
  cost: RequestCostLedger
): InformationIndex {
  if (continuationEpochMismatch(input.continuation, interpretation, input.authorized_scopes)
    || (input.continuation != null && (
      input.continuation.snapshot_id !== input.snapshot_id
      || Date.parse(input.continuation.expires_at) <= Date.parse(input.lifetime_now ?? new Date().toISOString())
    ))) {
    return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
  }
  if (interpretation.status === "resource_rejected" || interpretation.status === "malformed"
    || interpretation.status === "unsupported") {
    return projectFromField(emptyField(interpretation, input), input, interpretation, undefined, cost);
  }
  const restored = restoreField(
    input.continuation,
    interpretation.interpretation_clock,
    interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock })
  );
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
  const field = cost.time("observe", () => observeField(interpretation, {
    workspace_id: input.workspace_id,
    query_text: input.query_text,
    budget: input.budget,
    as_of: input.as_of,
    readers: input.readers,
    cost,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
    ...(restored === undefined ? {} : { resume_field: restored }),
    ...(pin === undefined ? {} : { expected_source_revision: pin.source_revision })
  }));
  cost.add("solve", { relaxations: field.solver_completed_work ?? 0 });
  cost.add("observe", { pending_work: field.remaining_work.reduce((sum, row) => sum + row.units, 0),
    state_creates: field.seen_identities.length,
    charged_retained_bytes: Math.max(0, input.budget.memory_bytes - field.remaining_memory_bytes) });
  let retained = field;
  const projected = projectFromField(assessUnknownCause(field, input), input, interpretation, (next) => { retained = next; }, cost);
  const unserviceable = input.budget.work_units <= 1 && projected.entries.length === 0;
  const noProgress = projected.entries.length === 0
    && fieldProgressFingerprint(retained) === fieldProgressFingerprint(restored);
  // Incomplete facet index is truncated-open, not a settled empty certificate.
  const index = unserviceable || (noProgress && restored !== undefined && observationSettled(retained)
    && !facetIndexStillOpen(retained))
    ? { ...projected, continuation: null } : projected;
  if (currentPin !== undefined) FIELD_SOURCE_PINS.set(retained, currentPin);
  // Keep resume under the request token so a last page (response continuation
  // null) can still replay the same issued delivery_id.
  rememberField(retained, index.continuation ?? input.continuation ?? null);
  return index;
}

function observationSettled(state: FieldEngineState): boolean {
  return state.pending_path_effects === undefined
    && state.last_observer_status !== "interrupted"
    && state.last_observer_status !== "open"
    && !state.memory_exhausted
    && (state.remaining_work.length === 0);
}

function facetIndexStillOpen(state: FieldEngineState): boolean {
  const facets = state.binding.kind === "bound" ? state.binding.snapshot.facets : state.facets;
  return facets.length > 0 && state.projection_progress?.facet_index?.complete !== true;
}

function projectFromField(
  state: ReturnType<typeof observeField>,
  input: ConditionalFieldRecallRequest,
  interpretation: ReturnType<typeof compileConditionalFieldQuery>,
  retain: ((state: FieldEngineState) => void) | undefined,
  cost: RequestCostLedger
): InformationIndex {
  const delta = projectFieldDelta(state);
  const snapshot = state.binding.kind === "bound"
    ? state.binding.snapshot
    : {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      snapshot_id: state.snapshot_id,
      query_id: state.query_id,
      seeds: [...state.seeds],
      values: [...delta.accepted_states],
      retained_transitions: [...state.transitions],
      facets: [...state.facets]
    };
  const ceilings = governanceManifestationCeilings(input.governance?.paths ?? []);
  const manifestationFor = (id: string) => input.governance === undefined ? "excerpt" as const
    : governanceManifestationFor(id, ceilings, input.governance.completeness === "complete"
      && !input.governance.temporal_uncertain);
  let retained = state;
  let projectionProgress = resumeIndexProjection(state, snapshot);
  const queryKey = fieldResumeKey(
    interpretation.query_id,
    interpretation.snapshot_id,
    interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock })
  );
  const requestDigest = input.continuation == null ? "root" : continuationDigest(input.continuation);
  if (input.continuation == null) {
    for (const digest of evictIssuedDeliveries(queryKey)) ISSUED_SURFACES.delete(digest);
  }
  const issued = input.continuation == null ? undefined : replayIssuedDelivery(requestDigest);
  if (issued !== undefined) {
    const eligible = new Set(snapshot.values
      .filter((value) => value.accepting)
      .map((value) => productStateNodeId(value.state)));
    if (issuedDeliveryRevoked(issued, eligible)) {
      return annotatePublicIndex(invalidatedPublicIndex(interpretation, input), interpretation);
    }
    const replayed = replayIssuedIndex(issued);
    const surface = ISSUED_SURFACES.get(requestDigest);
    INDEX_PREVIEWS.set(replayed, surface?.previews ?? new Map());
    INDEX_SOURCE_METADATA.set(replayed, surface?.metadata ?? {});
    retain?.(retained);
    return replayed;
  }
  const payload = new BoundedIndexPayload({ sourceFacts: state.source_facts,
    previewCache: state.preview_cache, readers: input.readers, workspaceId: input.workspace_id,
    remainingMemoryBytes: state.remaining_memory_bytes, manifestationFor,
    ...(input.payload_continuation === undefined
      ? {}
      : { payloadContinuation: input.payload_continuation }) });
  let index = annotatePublicIndex(InformationIndexSchema.parse(cost.time("index", () => projectAcceptingIndex({
    snapshot,
    ordered_values: orderedProjectionValues(state),
    view: interpretation.view,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: RESULT_VERSION,
    budget: input.budget,
    cost,
    projection_scan_offset: projectionProgress.offset,
    projection_generation: projectionProgress.generation,
    projection_facet_offset: projectionProgress.facet_offset,
    projection_facet_index: projectionProgress.facet_index,
    delivered_product_ids: new Set(Object.keys(projectionProgress.delivered_entries)),
    delivered_entry_revisions: projectionProgress.delivered_entries,
    on_projection_progress: (offset, facet) => {
      projectionProgress = { ...projectionProgress, offset,
        ...(facet === undefined ? {} : { facet_offset: facet.scan_offset, facet_index: facet.index }) };
    },
    explanation_progress: state.explanation_progress,
    on_explanation_progress: (progress, retainedBytes, work) => {
      payload.remainingMemoryBytes = Math.max(0, payload.remainingMemoryBytes - retainedBytes);
      retained = { ...retained, explanation_progress: progress,
        explanation_completed_work: (retained.explanation_completed_work ?? 0) + work,
        remaining_memory_bytes: payload.remainingMemoryBytes };
    },
    roles: rolesFrom(state),
    claims: state.claims,
    claim_propositions: state.claim_propositions,
    transition_derivations: state.transition_derivations,
    grounding_progress: state.grounding_progress,
    remaining_memory_bytes: payload.remainingMemoryBytes,
    grounding_transitions: [...state.transitions],
    grounding_seeds: [...state.seeds],
    grounding_derivations: [...state.derivations],
    projection_facets: [...state.facets],
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
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    payload_work_per_entry: 5,
    // Truncated source chunks stay retryable so payload_continuation can fetch the next offset.
    finalize_payload: (entries, allowance) => cost.time("payload", () => {
      const result = payload.finalize(entries, allowance);
      const work = payload.takeNativeWork();
      cost.add("payload", { native_visits: work.native_visits, native_bytes: work.native_bytes,
        charged_retained_bytes: work.native_bytes, native_rows: entries.length });
      return result;
    }),
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
    ...((state.derivations?.length ?? 0) === 0 ? {} : { derivations: [...state.derivations] }),
    ...(state.support_work_status === undefined ? {} : { support_work_status: state.support_work_status }),
    ...(state.memory_exhausted || state.remaining_work.length > 0
      ? { resource_work: "open" as const }
      : {})
  }))), interpretation);
  const committed = index.completeness.logical_index === "invalidated"
    ? projectionProgress.delivered_entries
    : index.continuation?.emitted_revisions
      ?? mergeCommittedRevisions(projectionProgress.delivered_entries, index.entries);
  const delivery = retainCommittedRevisions(
    projectionProgress,
    committed,
    state.projection_progress === undefined
  );
  if (delivery.bytes > payload.remainingMemoryBytes) index = { ...index, continuation: null };
  else {
    payload.remainingMemoryBytes -= delivery.bytes;
    retained = { ...retained, projection_progress: delivery.progress };
  }
  if (index.continuation !== null) index = { ...index,
    continuation: { ...index.continuation, continuation_id: randomUUID() } };
  index = payload.applyDeliveredSpans(index);
  INDEX_PREVIEWS.set(index, payload.previews);
  INDEX_SOURCE_METADATA.set(index, payload.sourceMetadata);
  if (input.continuation != null && index.completeness.logical_index !== "invalidated"
    && retained.projection_progress === delivery.progress) {
    rememberIssuedDelivery({ query_key: queryKey, request_digest: requestDigest, index });
    ISSUED_SURFACES.set(requestDigest, {
      previews: payload.previews,
      metadata: payload.sourceMetadata
    });
  }
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
  const excerpts = index.entries.map((entry) => encodedPreview(previews, entry));
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
    const objectId = indexMemoryObjectId(entry);
    const cacheKey = indexEntryCacheKey(entry);
    const metadata = sourceMetadata[cacheKey] ?? (objectId === undefined ? undefined : sourceMetadata[objectId]);
    const kind = indexEntryObjectKind(entry);
    return {
      ...(objectId === undefined ? {} : { object_id: objectId }),
      object_kind: kind,
      target: entry.target,
      activation_score: score,
      relevance_score: score,
      content_preview: excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW,
      token_estimate: previewTokenEstimate(excerpts[offset] ?? PAYLOAD_OMITTED_PREVIEW),
      manifestation: governance === undefined || objectId === undefined ? "excerpt" as const
        : governanceManifestationFor(objectId, ceilings,
          governance.completeness === "complete" && !governance.temporal_uncertain),
      ...candidatePlaneAttributes(kind, metadata),
      origin_plane: "workspace_local" as const,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      ...(metadata?.staged_warnings === undefined ? {} : {
        staged_warnings: metadata.staged_warnings
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

function encodedPreview(
  previews: ReadonlyMap<string, string>,
  entry: InformationIndex["entries"][number]
): string | undefined {
  const cacheKey = indexEntryCacheKey(entry);
  const hit = previews.get(cacheKey);
  if (hit !== undefined) return hit;
  if (entry.target.kind === "memory_entry") return undefined;
  const objectId = indexMemoryObjectId(entry);
  return objectId === undefined ? undefined : previews.get(objectId);
}

function candidatePlaneAttributes(
  kind: ReturnType<typeof indexEntryObjectKind>,
  metadata: RecallSourceMetadata | undefined
): Pick<RecallSourceMetadata, "dimension" | "scope_class"> {
  if (kind === "source_evidence") {
    return {
      ...(metadata?.dimension === undefined ? {} : { dimension: metadata.dimension }),
      ...(metadata?.scope_class === undefined ? {} : { scope_class: metadata.scope_class })
    };
  }
  return {
    dimension: metadata?.dimension ?? MemoryDimension.FACT,
    scope_class: metadata?.scope_class ?? ScopeClass.PROJECT
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
  recalled: ConditionalFieldRecallPortResult
): Readonly<{ readonly index: InformationIndex; readonly previews: Map<string, string>;
  readonly source_metadata: Readonly<Record<string, RecallSourceMetadata>>;
  readonly execution_receipt?: ConditionalFieldExecutionReceipt }> {
  if (recalled.issued_delivery_id !== undefined) {
    bindIssuedDeliveryId(recalled.index, recalled.issued_delivery_id);
  }
  return {
    index: recalled.index,
    previews: new Map(Object.entries(recalled.previews)),
    source_metadata: recalled.source_metadata ?? {},
    execution_receipt: recalled.execution_receipt
  };
}

function interpretationIdOf(interpretation: QueryInterpretation): string {
  return interpretationIdentity({ interpretation_clock: interpretation.interpretation_clock });
}

function continuationEpochMismatch(
  continuation: Continuation | null | undefined,
  interpretation: QueryInterpretation,
  authorizedScopes?: readonly string[]
): boolean {
  if (continuation === undefined || continuation === null) return false;
  if (continuation.interpretation_id === undefined) return true;
  if (continuation.interpretation_id !== interpretationIdOf(interpretation)) return true;
  return continuationViewMismatch(continuation, interpretation.view, authorizedScopes);
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
        ?? interpretation.interpretation_clock,
      enumeration_policy: index.continuation.enumeration_policy
        ?? interpretation.view.enumeration_policy,
      result_kind_view: index.continuation.result_kind_view
        ?? interpretation.view.result_kind_view,
      ...(index.continuation.authorized_scopes === undefined ? {} : {
        authorized_scopes: index.continuation.authorized_scopes
      }),
      ...(index.continuation.cap_contracts === undefined && interpretation.view.cap_contracts === undefined
        ? {}
        : { cap_contracts: index.continuation.cap_contracts ?? interpretation.view.cap_contracts }),
      ...(index.continuation.claim_demands === undefined && interpretation.view.claim_demands === undefined
        ? {}
        : { claim_demands: index.continuation.claim_demands ?? interpretation.view.claim_demands }),
      ...continuationConsumerIdentity(index.continuation, interpretation.view)
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
    ),
    ...(extra.enumeration_policy === undefined ? {} : { enumeration_policy: extra.enumeration_policy }),
    ...(extra.result_kind_view === undefined ? {} : { result_kind_view: extra.result_kind_view }),
    ...(extra.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: extra.interpretation_proposal }),
    ...(extra.payload_continuation === undefined ? {} : { payload_continuation: extra.payload_continuation }),
    ...(extra.cap_contracts === undefined ? {} : { cap_contracts: extra.cap_contracts }),
    ...(extra.claim_demands === undefined ? {} : { claim_demands: extra.claim_demands }),
    ...recallConsumerViewIdentity(extra),
    ...(extra.supports_source_evidence === undefined
      ? {}
      : { supports_source_evidence: extra.supports_source_evidence }),
    ...(extra.supports_product_updates === undefined
      ? {}
      : { supports_product_updates: extra.supports_product_updates })
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


