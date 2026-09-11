import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  QueryViewSchema,
  formatConditionalFieldDigest,
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
import { type ObserverReaders } from "../conditional-field/observers/observe.js";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { projectFromField, annotatePublicIndex, invalidatedPublicIndex } from "./recall-field-projection.js";
import {
  captureEffectiveAsOf,
  normalizeQueryText,
  nullableTime,
  validSnapshot
} from "./recall-service-helpers.js";
import type { RecallResult } from "./recall-service-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import {
  bindIssuedDeliveryId,
  fieldResumeKey,
  issuedDeliveryIdOf,
  prepareFieldCommit,
  preparedDeliveryId,
  invalidateFieldDelivery,
  restoreField
} from "./index-continuation.js";
import {
  captureIndexPreviews,
  captureIndexSourceMetadata,
  issueRetainedIndex,
  stageIndexSourceValidation,
  stageIndexField,
  pendingIssuedDeliveryOf
} from "./recall-index-commit.js";
import type { ConditionalFieldExecutionReceipt } from "./conditional-field-execution-receipt.js";
import { startRequestCost, type RequestCostLedger } from "./request-cost-ledger.js";
import { retainedFieldLevels, thisRequestObservedWork } from "./request-cost-engine-snapshot.js";
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
import { assessUnknownCause } from "./semantic-attribution.js";
import { readRequestGovernance } from "./request-governance.js";
import { reserveSnapshotPinWork } from "./snapshot-pin-budget.js";
import { encodeRecallResult } from "./recall-result-encoding.js";
import {
  assertRecallConsumerCompatibility,
  recallConsumerViewIdentity
} from "./recall-consumer-compatibility.js";

export type {
  ConditionalFieldRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "./recall-service-runner-types.js";
export { RELATION_MILLIGRADES };

const DEFAULT_WORK_UNITS = 10_000;
const DEFAULT_MEMORY_BYTES = 1_000_000;
const DEFAULT_RESERVE = 100;
const DEFAULT_MIN_ENVELOPE = 10;
const CONTINUATION_MS = 5 * 60_000;
const FIELD_SOURCE_PINS = new WeakMap<FieldEngineState, string>();

export type ConditionalFieldRecallResult = RecallResult & Readonly<{
  readonly index: InformationIndex;
  readonly provider_calls: 0;
  readonly garden_enqueue: 0;
  readonly issued_delivery_id?: string;
  readonly acknowledge_delivery?: (index: InformationIndex, previews: ReadonlyMap<string, string>) => Promise<void>;
  readonly discard_delivery?: () => Promise<void>;
}>;

export type ConditionalFieldRecallPortResult = Readonly<{
  readonly execution_receipt?: ConditionalFieldExecutionReceipt;
  readonly index: InformationIndex;
  readonly previews: Readonly<Record<string, string>>;
  readonly source_metadata?: Readonly<Record<string, RecallSourceMetadata>>;
  readonly issued_delivery_id?: string;
  readonly preparation_id?: string;
}>;

export type ConditionalFieldRecallPort = Readonly<{
  acknowledge?(preparationId: string, index: InformationIndex, previews: ReadonlyMap<string, string>): Promise<ConditionalFieldExecutionReceipt | void>;
  discard?(preparationId: string): Promise<void>;
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
  let issueDeferred: ReturnType<typeof runConditionalFieldRecallWithReceipt>["issue"];
  let preparedId: string | undefined;
  let acknowledge: ConditionalFieldRecallResult["acknowledge_delivery"];
  let discard: ConditionalFieldRecallResult["discard_delivery"];
  try {
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
        const response = await port.recall(withoutReaders(request));
        const recalled = portIndexAndPreviews(response);
        preparedId = response.issued_delivery_id;
        if (response.preparation_id !== undefined) {
          const preparationId = response.preparation_id;
          if (port.acknowledge === undefined || port.discard === undefined) throw new Error("Recall delivery acknowledgment port missing");
          acknowledge = async (issued, captured) => {
            const settled = await port.acknowledge!(preparationId, issued, captured);
            if (settled !== undefined && executionReceipt !== undefined) Object.assign(executionReceipt, settled);
          };
          discard = async () => { await port.discard!(preparationId); };
        }
        previews = recalled.previews;
        sourceMetadata = recalled.source_metadata;
        executionReceipt = recalled.execution_receipt;
        return recalled.index;
      }
      const executed = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
      const recalled = executed.index;
      executionReceipt = executed.execution_receipt;
      issueDeferred = executed.issue;
      preparedId = executed.delivery_id;
      previews = captureIndexPreviews(recalled, request.readers, request.workspace_id);
      sourceMetadata = captureIndexSourceMetadata(recalled);
      return recalled;
    }, params.continuation?.continuation_id);
    const encoded = encodeRecallResult(index, previews, governance, sourceMetadata);
    acknowledge ??= async (issued, captured) => { issueDeferred?.({ index: issued, previews: captured, metadata: sourceMetadata }); };
    if (!params.defer_delivery) await acknowledge(encoded.index, previews);
    const issuedDeliveryId = preparedId ?? issuedDeliveryIdOf(index);
    return {
      ...encoded,
      execution_receipt: executionReceipt,
      ...(params.defer_delivery ? { acknowledge_delivery: acknowledge, discard_delivery: discard ?? (async () => {}) } : {}),
      ...(issuedDeliveryId === undefined ? {} : { issued_delivery_id: issuedDeliveryId })
    };
  } catch (error) {
    try { await discard?.(); } catch { /* Preserve the original delivery failure. */ }
    throw error;
  }
}

export function runConditionalFieldRecall(input: ConditionalFieldRecallRequest): InformationIndex {
  return runConditionalFieldRecallWithReceipt(input).index;
}

export function runConditionalFieldRecallWithReceipt(
  input: ConditionalFieldRecallRequest,
  options?: Readonly<{ readonly issue?: "now" | "defer" }>
): Readonly<{
  readonly index: InformationIndex;
  readonly execution_receipt: ConditionalFieldExecutionReceipt;
  readonly delivery_id?: string;
  readonly issue?: (issued: Readonly<{
    readonly index: InformationIndex;
    readonly previews: ReadonlyMap<string, string>;
    readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
  }>) => string | undefined;
}> {
  const cost = startRequestCost();
  const requestedBudget = input.requested_budget ?? input.budget;
  if (input.readers.snapshotPin !== undefined) {
    const reserved = reserveSnapshotPinWork(reserveSnapshotPinWork(input.budget).budget);
    input = { ...input, budget: options?.issue === "defer" ? reserveSnapshotPinWork(reserved.budget).budget : reserved.budget };
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
  const execution_receipt = {
    schema_version: 1 as const, workspace_id: input.workspace_id, requested_budget: requestedBudget,
    compile_input: compileInput, query_id: interpretation.query_id,
    interpretation_id: interpretationIdentity({ interpretation_clock: input.interpretation_clock }),
    snapshot_id: input.snapshot_id, interpretation_clock: input.interpretation_clock,
    actual: cost.snapshot()
  };
  if ((options?.issue ?? "now") === "defer") {
    const pending = pendingIssuedDeliveryOf(index);
    const delivery_id = pending === undefined ? issuedDeliveryIdOf(index) : preparedDeliveryId(pending.request_digest, index);
    return { index, execution_receipt, delivery_id, issue: (issued) => {
      try { return issueRetainedIndex(index, issued); }
      finally { Object.assign(execution_receipt, { actual: cost.snapshot() }); }
    } };
  }
  issueRetainedIndex(index);
  Object.assign(execution_receipt, { actual: cost.snapshot() });
  return { index, execution_receipt };
}


function runCompiledConditionalFieldRecall(
  input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation,
  cost: RequestCostLedger
): InformationIndex {
  if (input.authorized_scopes === undefined
    || continuationEpochMismatch(input.continuation, interpretation, input.authorized_scopes)
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
  if (pin !== undefined) cost.add("observe", { native_visits: SNAPSHOT_PIN_NATIVE_WORK });
  const currentPin = pin === undefined ? undefined : JSON.stringify([
    snapshotIdFromPin(input.workspace_id, pin), [...(input.readers.permittedTimelessPolicyIds?.() ?? [])].sort()
  ]);
  if (restored !== undefined && FIELD_SOURCE_PINS.get(restored) !== currentPin) {
    invalidateFieldDelivery(fieldResumeKey(restored.query_id, restored.snapshot_id,
      interpretationIdentity({ interpretation_clock: restored.interpretation.interpretation_clock })));
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
  // Max-min bind runs inside observe; lifetime solver_completed_work is not this request's solve work.
  cost.add("observe", thisRequestObservedWork(restored, field, input.budget.memory_bytes));
  let retained = field;
  const index = projectFromField(assessUnknownCause(field, input), input, interpretation, (next) => { retained = next; }, cost, restored);
  stageIndexSourceValidation(index, () => {
    const latest = input.readers.snapshotPin?.(input.workspace_id);
    if (latest !== undefined) cost.add("index", { native_visits: SNAPSHOT_PIN_NATIVE_WORK });
    const latestPin = latest === undefined ? undefined : JSON.stringify([
      snapshotIdFromPin(input.workspace_id, latest), [...(input.readers.permittedTimelessPolicyIds?.() ?? [])].sort()
    ]);
    if (latestPin !== currentPin) {
      invalidateFieldDelivery(fieldResumeKey(retained.query_id, retained.snapshot_id,
        interpretationIdentity({ interpretation_clock: retained.interpretation.interpretation_clock })));
      throw new Error("Recall source generation changed before delivery");
    }
  });
  if (currentPin !== undefined) FIELD_SOURCE_PINS.set(retained, currentPin);
  // Keep resume under the request token so a last page (response continuation
  // null) can still replay the same issued delivery_id.
  if (pendingIssuedDeliveryOf(index) !== undefined) {
    stageIndexField(index, prepareFieldCommit(retained, index.continuation ?? input.continuation ?? null));
  }
  cost.recordRetainedLevels(retainedFieldLevels(retained, input.budget.memory_bytes));
  return index;
}


export { encodeRecallResult } from "./recall-result-encoding.js";

export { captureIndexPreviews, captureIndexSourceMetadata };

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
  authorizedScopes?: readonly string[] | null
): boolean {
  if (continuation === undefined || continuation === null) return false;
  if (continuation.interpretation_id === undefined) return true;
  if (continuation.interpretation_id !== interpretationIdOf(interpretation)) return true;
  return continuationViewMismatch(continuation, interpretation.view, authorizedScopes);
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
  const scopeFilter = (params.policyOverride ?? context.buildDefaultPolicy(
    params.strategy, params.taskSurface.runtime_id, now
  )).coarse_filter.deterministic_match.scope_filter;
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
    ...(scopeFilter === undefined ? {} : { authorized_scopes: scopeFilter }),
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
