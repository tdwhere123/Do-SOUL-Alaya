import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CompletenessReportSchema,
  ContinuationSchema,
  RecallTargetRefSchema,
  RequestBudgetSchema,
  SoulMemorySearchResponseSchema,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  ConditionalFieldExecutionReceiptSchema,
  ConditionalFieldRequestFiltersSchema,
  executionBindingMismatch,
  type ConditionalFieldRequestFilters
} from "./conditional-field-request-binding.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const usableSourceStates = new Set(["complete", "partial", "open", "exhausted_empty"]);
const Entry = z.object({
  object_id: z.string().optional(), target: RecallTargetRefSchema,
  hypothesis_id: z.string(), output_binding: z.string(),
  role: z.enum(["requested", "associated", "routing_only"]),
  association_milligrades: z.number().int().min(0).max(1000),
  claim: z.enum(["supported", "refuted", "conflict", "unknown"]),
  explanation_ids: z.array(z.string()).readonly(),
  program_state: z.string().min(1), time_state: z.string().min(1)
}).strict().readonly();
const ResultSlot = z.object({
  rank: z.number().int().positive(), object_id: z.string().optional(), object_kind: z.string(),
  target: RecallTargetRefSchema,
  index_entry_offset: z.number().int().nonnegative(),
  hypothesis_id: z.string(), output_binding: z.string(),
  program_state: z.string().min(1), time_state: z.string().min(1)
}).strict().readonly();
const UnavailableMetric = z.object({
  status: z.literal("unavailable"), value: z.null(), reason: z.string()
}).strict().readonly();

const ValidatedMeasurementBase = z.object({
  schema_version: z.literal(1), status: z.literal("validated"),
  contract: z.literal("conditional-field-delivered-slots-v1"),
  comparison: z.literal("non_equivalent_to_legacy_ranked_candidate_pool"),
  request: z.object({ query_text_sha256: Sha256,
    workspace_id: z.string().min(1), reference_time: z.string().min(1), snapshot_digest: z.string().nullable(),
    expected_index_snapshot_id: z.string().min(1), filters: ConditionalFieldRequestFiltersSchema,
    budget: RequestBudgetSchema, execution_receipt: ConditionalFieldExecutionReceiptSchema }).strict().readonly(),
  identity: z.object({ query_id: z.string(), snapshot_id: z.string(),
    interpretation_id: z.string().min(1), as_of: z.string().min(1),
    result_version: z.string() }).strict().readonly(),
  index_sha256: Sha256,
  completeness: CompletenessReportSchema,
  continuation: ContinuationSchema.nullable(),
  entries: z.array(Entry).readonly(),
  declared_explanation_ids: z.array(z.string()).readonly(),
  evaluated_slots: z.array(ResultSlot).readonly(),
  response_slots: z.array(ResultSlot).readonly(),
  response_slot_count: z.number().int().nonnegative(),
  provider_calls: z.literal(0), garden_enqueue: z.literal(0),
  metrics: z.object({
    index_entry_count: z.number().int().nonnegative(),
    distinct_object_count: z.number().int().nonnegative(),
    hypothesis_count: z.number().int().nonnegative(),
    output_binding_count: z.number().int().nonnegative(),
    declared_explanation_count: z.number().int().nonnegative(),
    explanation_reference_count: z.number().int().nonnegative(),
    resolved_explanation_reference_count: z.number().int().nonnegative(),
    association_min: z.number().nullable(), association_max: z.number().nullable(),
    latency_ms: z.number().finite().nonnegative().nullable(),
    work: UnavailableMetric, memory: UnavailableMetric,
    relationship_correctness: UnavailableMetric, explanation_correctness: UnavailableMetric,
    interpretation_correctness: UnavailableMetric, downstream_utilization: UnavailableMetric
  }).strict().readonly()
}).strict().readonly();

const ValidatedMeasurement = ValidatedMeasurementBase.superRefine((value, context) => {
  const receipt = value.request.execution_receipt;
  const mismatch = executionBindingMismatch(receipt, {
    queryText: receipt.compile_input.text, workspaceId: value.request.workspace_id,
    referenceTime: value.request.reference_time, requestBudget: value.request.budget,
    requestFilters: value.request.filters, expectedIndexSnapshotId: value.request.expected_index_snapshot_id
  });
  const continuation = value.continuation;
  const badIdentity = value.request.query_text_sha256 !== sha256(receipt.compile_input.text)
    || value.identity.query_id !== receipt.query_id || value.identity.snapshot_id !== receipt.snapshot_id
    || value.identity.interpretation_id !== receipt.interpretation_id || value.identity.as_of !== receipt.interpretation_clock;
  const badContinuation = continuation !== null && (continuation.query_id !== value.identity.query_id
    || continuation.snapshot_id !== value.identity.snapshot_id || continuation.result_version !== value.identity.result_version
    || continuation.interpretation_id !== value.identity.interpretation_id
    || continuation.interpretation_clock !== value.identity.as_of);
  const badSlots = value.response_slot_count !== value.entries.length
    || value.response_slots.length !== value.entries.length
    || value.evaluated_slots.length !== Math.min(10, value.response_slots.length)
    || value.response_slots.some((slot, offset) => {
      const entry = value.entries[offset];
      return entry === undefined || slot.rank !== offset + 1 || slot.index_entry_offset !== offset
        || slot.object_kind !== (entry.target.kind === "source_evidence" ? "source_evidence" : "memory_entry")
        || slot.object_id !== entry.object_id
        || slot.hypothesis_id !== entry.hypothesis_id || slot.output_binding !== entry.output_binding
        || slot.program_state !== entry.program_state || slot.time_state !== entry.time_state;
    }) || value.evaluated_slots.some((slot, offset) => JSON.stringify(slot) !== JSON.stringify(value.response_slots[offset]));
  const references = value.entries.flatMap((entry) => entry.explanation_ids);
  const explanations = new Set(value.declared_explanation_ids);
  const associations = value.entries.map((entry) => entry.association_milligrades);
  const metrics = value.metrics;
  const badMetrics = metrics.index_entry_count !== value.entries.length
    || metrics.distinct_object_count !== new Set(value.entries.map((entry) =>
      entry.object_id ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id)
    )).size
    || metrics.hypothesis_count !== new Set(value.entries.map((entry) => entry.hypothesis_id)).size
    || metrics.output_binding_count !== new Set(value.entries.map((entry) => entry.output_binding)).size
    || metrics.declared_explanation_count !== explanations.size
    || metrics.explanation_reference_count !== references.length
    || metrics.resolved_explanation_reference_count !== references.filter((id) => explanations.has(id)).length
    || metrics.association_min !== (associations.length === 0 ? null : Math.min(...associations))
    || metrics.association_max !== (associations.length === 0 ? null : Math.max(...associations));
  const badSource = !usableSourceStates.has(value.completeness.logical_index)
    || !usableSourceStates.has(value.completeness.observed_coverage)
    || value.entries.length > value.request.budget.page_budget;
  if (mismatch !== null || badIdentity || badContinuation || badSlots || badMetrics || badSource) {
    context.addIssue({ code: "custom", message: "archived conditional measurement request, identity or slot join is inconsistent" });
  }
});

export const ConditionalFieldMeasurementSchema = z.discriminatedUnion("status", [
  ValidatedMeasurement,
  z.object({ schema_version: z.literal(1), status: z.literal("invalid"),
    reason: z.enum(["invalid_response", "missing_zero_call_evidence", "missing_request_binding",
      "missing_request_budget", "request_budget_mismatch", "unusable_source_state",
      "snapshot_mismatch", "interpretation_clock_mismatch", "continuation_identity_mismatch",
      "result_index_mismatch", "evaluated_slot_mismatch"])
      .or(z.enum(["execution_receipt_invalid", "request_identity_mismatch"]))
  }).strict().readonly()
]);
export type ConditionalFieldMeasurement = z.infer<typeof ConditionalFieldMeasurementSchema>;

export function conditionalFieldDeliveryMatches(
  measurement: Extract<ConditionalFieldMeasurement, { status: "validated" }>,
  delivered: ConditionalMeasurementInput["deliveredResults"]
): boolean {
  return delivered.length === measurement.evaluated_slots.length
    && delivered.every((row, offset) => {
      const slot = measurement.evaluated_slots[offset];
      return slot !== undefined && row.rank === slot.rank && row.object_id === slot.object_id
        && (row.object_kind ?? "memory_entry") === slot.object_kind;
    });
}

export interface ConditionalMeasurementInput {
  readonly recallResult: unknown;
  readonly deliveredResults: readonly { readonly object_id?: string;
    readonly object_kind?: string | null; readonly rank: number; readonly relevance_score?: number }[];
  readonly queryText?: string;
  readonly workspaceId?: string;
  readonly requestFilters?: ConditionalFieldRequestFilters;
  readonly referenceTime?: string;
  readonly snapshotDigest?: string;
  readonly expectedIndexSnapshotId?: string;
  readonly requestBudget?: RequestBudget;
  readonly recallLatencyMs?: number;
}

export function measureConditionalFieldResponse(input: ConditionalMeasurementInput): ConditionalFieldMeasurement | null {
  if (!isRecord(input.recallResult) || !Object.hasOwn(input.recallResult, "index")) return null;
  const { provider_calls, garden_enqueue, request_budget, execution_receipt, diagnostics: _diagnostics, ...payload } = input.recallResult;
  const response = SoulMemorySearchResponseSchema.safeParse(payload);
  if (!response.success || response.data.index === undefined || response.data.protocol_version !== 1) {
    return invalid("invalid_response");
  }
  if (provider_calls !== 0 || garden_enqueue !== 0) return invalid("missing_zero_call_evidence");
  const execution = ConditionalFieldExecutionReceiptSchema.safeParse(execution_receipt);
  if (!execution.success) return invalid("execution_receipt_invalid");
  const mismatch = executionBindingMismatch(execution.data, input);
  if (mismatch !== null) return invalid(mismatch);
  const budget = RequestBudgetSchema.safeParse(request_budget);
  if (!budget.success) return invalid("missing_request_budget");
  const declaredBudget = input.requestBudget === undefined ? null : RequestBudgetSchema.safeParse(input.requestBudget);
  if (declaredBudget !== null && (!declaredBudget.success || JSON.stringify(declaredBudget.data) !== JSON.stringify(budget.data))) {
    return invalid("request_budget_mismatch");
  }
  const index = response.data.index;
  if (index.query_id !== execution.data.query_id || index.snapshot_id !== execution.data.snapshot_id
    || index.interpretation_id !== execution.data.interpretation_id || index.as_of !== execution.data.interpretation_clock) {
    return invalid("request_identity_mismatch");
  }
  if (index.representation.page_budget !== budget.data.page_budget) return invalid("request_budget_mismatch");
  if (!usableSourceStates.has(index.completeness.logical_index)
    || !usableSourceStates.has(index.completeness.observed_coverage)) return invalid("unusable_source_state");
  if (input.expectedIndexSnapshotId !== undefined && input.expectedIndexSnapshotId !== index.snapshot_id) return invalid("snapshot_mismatch");
  if (input.referenceTime !== undefined && (!Number.isFinite(Date.parse(input.referenceTime))
    || index.as_of !== new Date(input.referenceTime).toISOString())) {
    return invalid("interpretation_clock_mismatch");
  }
  const continuation = index.continuation;
  if (continuation !== null && (continuation.query_id !== index.query_id
    || continuation.snapshot_id !== index.snapshot_id || continuation.result_version !== index.result_version
    || continuation.interpretation_id !== index.interpretation_id
    || continuation.interpretation_clock !== index.as_of)) return invalid("continuation_identity_mismatch");
  if (response.data.results.length !== index.entries.length || index.entries.length > budget.data.page_budget) {
    return invalid("result_index_mismatch");
  }
  const slots = response.data.results.map((result, offset) => {
    const entry = index.entries[offset];
    if (entry === undefined || entry.object_id !== result.object_id
      || result.object_kind !== (entry.target.kind === "source_evidence" ? "source_evidence" : "memory_entry")
      || entry.hypothesis_id !== result.hypothesis_id || entry.output_binding !== result.output_binding
      || entry.program_state === undefined || entry.time_state === undefined
      || entry.program_state !== result.program_state || entry.time_state !== result.time_state) return null;
    return { rank: offset + 1, ...(result.object_id === undefined ? {} : { object_id: result.object_id }),
      object_kind: result.object_kind, target: entry.target,
      index_entry_offset: offset, hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding,
      program_state: entry.program_state, time_state: entry.time_state };
  });
  if (slots.some((slot) => slot === null)) return invalid("result_index_mismatch");
  if (input.deliveredResults.length !== Math.min(10, response.data.results.length)) return invalid("evaluated_slot_mismatch");
  const evaluated = [];
  for (const [offset, result] of input.deliveredResults.entries()) {
    const slot = slots[offset];
    if (slot == null || result.rank !== slot.rank || result.object_id !== slot.object_id
      || result.object_kind !== slot.object_kind) return invalid("evaluated_slot_mismatch");
    evaluated.push(slot);
  }
  const entries = index.entries.map(({ object_id, target, hypothesis_id, output_binding, role,
    association_milligrades, claim, explanation_ids, program_state, time_state }) => ({
    ...(object_id === undefined ? {} : { object_id }), target, hypothesis_id, output_binding, role,
    association_milligrades, claim, explanation_ids,
    program_state: program_state ?? null, time_state: time_state ?? null
  }));
  const explanations = new Set((index.explanations ?? []).map((entry) => entry.derivation_id));
  const references = entries.flatMap((entry) => entry.explanation_ids);
  const associations = entries.map((entry) => entry.association_milligrades);
  const validated = ValidatedMeasurement.safeParse({
    schema_version: 1, status: "validated", contract: "conditional-field-delivered-slots-v1",
    comparison: "non_equivalent_to_legacy_ranked_candidate_pool",
    request: { query_text_sha256: sha256(input.queryText!), workspace_id: input.workspaceId!,
      reference_time: execution.data.interpretation_clock,
      snapshot_digest: input.snapshotDigest ?? null, expected_index_snapshot_id: execution.data.snapshot_id,
      filters: input.requestFilters ?? {}, budget: budget.data, execution_receipt: execution.data },
    identity: { query_id: index.query_id, snapshot_id: index.snapshot_id,
      interpretation_id: index.interpretation_id ?? null, as_of: index.as_of ?? null, result_version: index.result_version },
    index_sha256: sha256(JSON.stringify(index)), completeness: index.completeness,
    continuation, entries, declared_explanation_ids: [...explanations],
    evaluated_slots: evaluated, response_slots: slots, response_slot_count: response.data.results.length,
    provider_calls, garden_enqueue,
    metrics: {
      index_entry_count: entries.length, distinct_object_count: new Set(entries.map((entry) =>
        entry.object_id ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id)
      )).size,
      hypothesis_count: new Set(entries.map((entry) => entry.hypothesis_id)).size,
      output_binding_count: new Set(entries.map((entry) => entry.output_binding)).size,
      declared_explanation_count: explanations.size, explanation_reference_count: references.length,
      resolved_explanation_reference_count: references.filter((id) => explanations.has(id)).length,
      association_min: associations.length === 0 ? null : Math.min(...associations),
      association_max: associations.length === 0 ? null : Math.max(...associations),
      latency_ms: input.recallLatencyMs ?? null,
      work: unavailable("response exposes no measured work receipt"),
      memory: unavailable("response exposes no measured memory receipt"),
      relationship_correctness: unavailable("independent relationship oracle not supplied"),
      explanation_correctness: unavailable("reference existence does not establish explanatory correctness"),
      interpretation_correctness: unavailable("independent interpretation oracle not supplied"),
      downstream_utilization: unavailable("consumer outcome not observed by the Recall response")
    }
  });
  return validated.success ? validated.data : invalid("invalid_response");
}

function invalid(reason: Extract<ConditionalFieldMeasurement, { status: "invalid" }>["reason"]): ConditionalFieldMeasurement {
  return { schema_version: 1, status: "invalid", reason };
}
function unavailable(reason: string) { return { status: "unavailable" as const, value: null, reason }; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
