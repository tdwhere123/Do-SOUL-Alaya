import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CompletenessReportSchema,
  ContinuationSchema,
  RequestBudgetSchema,
  SoulMemorySearchResponseSchema,
  type RequestBudget
} from "@do-soul/alaya-protocol";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Entry = z.object({
  object_id: z.string(), hypothesis_id: z.string(), output_binding: z.string(),
  role: z.enum(["requested", "associated", "routing_only"]),
  association_milligrades: z.number().int().min(0).max(1000),
  claim: z.enum(["supported", "refuted", "conflict", "unknown"]),
  explanation_ids: z.array(z.string()).readonly(),
  program_state: z.string().nullable(), time_state: z.string().nullable()
}).strict().readonly();
const ResultSlot = z.object({
  rank: z.number().int().positive(), object_id: z.string(), object_kind: z.string(),
  index_entry_offset: z.number().int().nonnegative(),
  hypothesis_id: z.string(), output_binding: z.string()
}).strict().readonly();
const UnavailableMetric = z.object({
  status: z.literal("unavailable"), value: z.null(), reason: z.string()
}).strict().readonly();

const ValidatedMeasurement = z.object({
  schema_version: z.literal(1), status: z.literal("validated"),
  contract: z.literal("conditional-field-delivered-slots-v1"),
  comparison: z.literal("non_equivalent_to_legacy_ranked_candidate_pool"),
  request: z.object({ query_text_sha256: Sha256,
    reference_time: z.string().nullable(), snapshot_digest: z.string().nullable(),
    expected_index_snapshot_id: z.string().nullable(),
    budget: RequestBudgetSchema }).strict().readonly(),
  identity: z.object({ query_id: z.string(), snapshot_id: z.string(),
    interpretation_id: z.string().nullable(), as_of: z.string().nullable(),
    result_version: z.string() }).strict().readonly(),
  index_sha256: Sha256,
  completeness: CompletenessReportSchema,
  continuation: ContinuationSchema.nullable(),
  entries: z.array(Entry).readonly(),
  evaluated_slots: z.array(ResultSlot).readonly(),
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

export const ConditionalFieldMeasurementSchema = z.discriminatedUnion("status", [
  ValidatedMeasurement,
  z.object({ schema_version: z.literal(1), status: z.literal("invalid"),
    reason: z.enum(["invalid_response", "missing_zero_call_evidence", "missing_request_binding",
      "missing_request_budget", "request_budget_mismatch", "unusable_source_state",
      "snapshot_mismatch", "interpretation_clock_mismatch", "continuation_identity_mismatch",
      "result_index_mismatch", "evaluated_slot_mismatch"])
  }).strict().readonly()
]);
export type ConditionalFieldMeasurement = z.infer<typeof ConditionalFieldMeasurementSchema>;

export interface ConditionalMeasurementInput {
  readonly recallResult: unknown;
  readonly deliveredResults: readonly { readonly object_id: string;
    readonly object_kind?: string | null; readonly rank: number }[];
  readonly queryText?: string;
  readonly referenceTime?: string;
  readonly snapshotDigest?: string;
  readonly expectedIndexSnapshotId?: string;
  readonly requestBudget?: RequestBudget;
  readonly recallLatencyMs?: number;
}

export function measureConditionalFieldResponse(input: ConditionalMeasurementInput): ConditionalFieldMeasurement | null {
  if (!isRecord(input.recallResult) || !Object.hasOwn(input.recallResult, "index")) return null;
  const { provider_calls, garden_enqueue, request_budget, diagnostics: _diagnostics, ...payload } = input.recallResult;
  const response = SoulMemorySearchResponseSchema.safeParse(payload);
  if (!response.success || response.data.index === undefined || response.data.protocol_version !== 1) {
    return invalid("invalid_response");
  }
  if (provider_calls !== 0 || garden_enqueue !== 0) return invalid("missing_zero_call_evidence");
  if (input.queryText === undefined) return invalid("missing_request_binding");
  const budget = RequestBudgetSchema.safeParse(request_budget ?? input.requestBudget);
  if (!budget.success) return invalid("missing_request_budget");
  const declaredBudget = input.requestBudget === undefined ? null : RequestBudgetSchema.safeParse(input.requestBudget);
  if (declaredBudget !== null && (!declaredBudget.success || JSON.stringify(declaredBudget.data) !== JSON.stringify(budget.data))) {
    return invalid("request_budget_mismatch");
  }
  const index = response.data.index;
  if (index.representation.page_budget !== budget.data.page_budget) return invalid("request_budget_mismatch");
  const usableSourceStates = new Set(["complete", "partial", "open", "exhausted_empty"]);
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
    || continuation.interpretation_id !== index.interpretation_id)) return invalid("continuation_identity_mismatch");
  const slots = response.data.results.map((result, offset) => {
    const entry = index.entries[offset];
    if (entry === undefined || entry.object_id !== result.object_id
      || entry.hypothesis_id !== result.hypothesis_id || entry.output_binding !== result.output_binding) return null;
    return { rank: offset + 1, object_id: result.object_id, object_kind: result.object_kind,
      index_entry_offset: offset, hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding };
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
  const entries = index.entries.map(({ object_id, hypothesis_id, output_binding, role,
    association_milligrades, claim, explanation_ids, program_state, time_state }) => ({
    object_id, hypothesis_id, output_binding, role, association_milligrades, claim, explanation_ids,
    program_state: program_state ?? null, time_state: time_state ?? null
  }));
  const explanations = new Set((index.explanations ?? []).map((entry) => entry.derivation_id));
  const references = entries.flatMap((entry) => entry.explanation_ids);
  const associations = entries.map((entry) => entry.association_milligrades);
  return ValidatedMeasurement.parse({
    schema_version: 1, status: "validated", contract: "conditional-field-delivered-slots-v1",
    comparison: "non_equivalent_to_legacy_ranked_candidate_pool",
    request: { query_text_sha256: sha256(input.queryText), reference_time: input.referenceTime ?? null,
      snapshot_digest: input.snapshotDigest ?? null, expected_index_snapshot_id: input.expectedIndexSnapshotId ?? null,
      budget: budget.data },
    identity: { query_id: index.query_id, snapshot_id: index.snapshot_id,
      interpretation_id: index.interpretation_id ?? null, as_of: index.as_of ?? null, result_version: index.result_version },
    index_sha256: sha256(JSON.stringify(index)), completeness: index.completeness,
    continuation, entries, evaluated_slots: evaluated, response_slot_count: response.data.results.length,
    provider_calls, garden_enqueue,
    metrics: {
      index_entry_count: entries.length, distinct_object_count: new Set(entries.map((entry) => entry.object_id)).size,
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
}

function invalid(reason: Extract<ConditionalFieldMeasurement, { status: "invalid" }>["reason"]): ConditionalFieldMeasurement {
  return { schema_version: 1, status: "invalid", reason };
}
function unavailable(reason: string) { return { status: "unavailable" as const, value: null, reason }; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
