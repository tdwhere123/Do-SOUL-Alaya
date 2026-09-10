import { z } from "zod";
import {
  EnumerationPolicySchema,
  QueryInterpretationProposalSchema,
  QueryViewSchema,
  RequestBudgetSchema,
  ResultKindViewSchema,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";

const Id = z.string().min(1);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Clock = z.iso.datetime();
const Filters = {
  since: Clock.optional(), until: Clock.optional(),
  time_field: z.enum(["created_at", "last_used_at"]).optional(),
  dimension_filter: z.array(Id).readonly().optional(),
  domain_tag_filter: z.array(Id).readonly().optional(),
  authorized_scopes: z.array(Id).readonly().optional(),
  enumeration_policy: EnumerationPolicySchema.optional(),
  result_kind_view: ResultKindViewSchema.optional()
};

export const ConditionalFieldRequestFiltersSchema = z.object(Filters).strict().readonly();

const NonNegInt = z.number().int().nonnegative();
const NonNegMs = z.number().finite().nonnegative();
// Nested `actual` is the core ledger snapshot. Sibling `worker` is instrumentation pages.
// Root visits/bytes/rss stay optional worker wire fields and are never nested actual.
const PhaseCost = z.object({
  exclusive_ms: NonNegMs, inclusive_ms: NonNegMs,
  native_visits: NonNegInt, native_rows: NonNegInt, native_bytes: NonNegInt,
  charged_retained_bytes: NonNegInt, joins: NonNegInt, relaxations: NonNegInt,
  state_creates: NonNegInt, pending_work: NonNegInt, cache_hits: NonNegInt, cache_misses: NonNegInt
}).strict().readonly();
const ActualReceipt = z.object({
  native_visits: NonNegInt, native_rows: NonNegInt, native_bytes: NonNegInt,
  charged_retained_bytes: NonNegInt,
  phases: z.object({
    compile: PhaseCost, observe: PhaseCost, seed: PhaseCost, adjacency: PhaseCost,
    measurement: PhaseCost, solve: PhaseCost, index: PhaseCost, payload: PhaseCost
  }).strict().readonly(),
  rss: z.object({
    method: z.literal("process.memoryUsage().rss"),
    start_bytes: NonNegInt, after_projection_bytes: NonNegInt
  }).strict().readonly()
}).strict().readonly();
const WorkerReceipt = z.object({
  native_visits: NonNegInt,
  bytes_read: NonNegInt,
  row_visits: NonNegInt,
  elapsed_ms: z.number().finite().nonnegative(),
  rss_bytes: NonNegInt,
  rss_sampling_method: z.literal("process.memoryUsage().rss")
}).strict().readonly();

export const ConditionalFieldExecutionReceiptSchema = z.object({
  schema_version: z.literal(1), workspace_id: Id, requested_budget: RequestBudgetSchema,
  compile_input: z.object({ source: z.literal("ordinary"), text: z.string(),
    snapshot_id: Digest, budget: RequestBudgetSchema, interpretation_clock: Clock, ...Filters,
    view: QueryViewSchema.optional(),
    interpretation_proposal: QueryInterpretationProposalSchema.optional()
  }).strict().readonly(),
  query_id: Id, interpretation_id: Id, snapshot_id: Digest, interpretation_clock: Clock,
  native_visits: NonNegInt.optional(),
  bytes_read: NonNegInt.optional(),
  row_visits: NonNegInt.optional(),
  elapsed_ms: z.number().finite().nonnegative().optional(),
  rss_bytes: NonNegInt.optional(),
  rss_sampling_method: z.literal("process.memoryUsage().rss").optional(),
  worker: WorkerReceipt.optional(),
  actual: ActualReceipt.optional()
}).strict().readonly().superRefine((receipt, context) => {
  const compiled = compileConditionalFieldQuery(receipt.compile_input);
  const expectedInterpretation = interpretationIdentity({ interpretation_clock: receipt.compile_input.interpretation_clock });
  const requested = receipt.requested_budget;
  const executed = receipt.compile_input.budget;
  if (compiled.query_id !== receipt.query_id || receipt.snapshot_id !== receipt.compile_input.snapshot_id
    || receipt.interpretation_id !== expectedInterpretation
    || receipt.interpretation_clock !== receipt.compile_input.interpretation_clock
    || executed.work_units > requested.work_units || executed.memory_bytes > requested.memory_bytes
    || executed.page_budget !== requested.page_budget || executed.finalization_reserve !== requested.finalization_reserve
    || executed.min_envelope !== requested.min_envelope) {
    context.addIssue({ code: "custom", message: "execution receipt contradicts the canonical request compiler" });
  }
});

export type ConditionalFieldExecutionBinding = z.infer<typeof ConditionalFieldExecutionReceiptSchema>;
export type ConditionalFieldRequestFilters = z.infer<typeof ConditionalFieldRequestFiltersSchema>;

export interface ExpectedConditionalFieldRequest {
  readonly queryText?: string;
  readonly workspaceId?: string;
  readonly referenceTime?: string;
  readonly requestBudget?: RequestBudget;
  readonly requestFilters?: ConditionalFieldRequestFilters;
  readonly expectedIndexSnapshotId?: string;
}

export function executionBindingMismatch(
  receipt: ConditionalFieldExecutionBinding,
  expected: ExpectedConditionalFieldRequest
): "missing_request_binding" | "request_identity_mismatch" | "request_budget_mismatch"
  | "snapshot_mismatch" | "interpretation_clock_mismatch" | null {
  if (expected.queryText === undefined || expected.workspaceId === undefined
    || expected.referenceTime === undefined || expected.requestBudget === undefined) return "missing_request_binding";
  if (receipt.compile_input.text !== expected.queryText || receipt.workspace_id !== expected.workspaceId) {
    return "request_identity_mismatch";
  }
  if (!Number.isFinite(Date.parse(expected.referenceTime))
    || receipt.interpretation_clock !== new Date(expected.referenceTime).toISOString()) return "interpretation_clock_mismatch";
  if (!sameBudget(receipt.requested_budget, expected.requestBudget)) return "request_budget_mismatch";
  if (expected.expectedIndexSnapshotId !== undefined && receipt.snapshot_id !== expected.expectedIndexSnapshotId) return "snapshot_mismatch";
  const input = receipt.compile_input;
  const actual = { since: input.since, until: input.until, time_field: input.time_field,
    dimension_filter: input.dimension_filter, domain_tag_filter: input.domain_tag_filter,
    authorized_scopes: input.authorized_scopes,
    enumeration_policy: input.view?.enumeration_policy ?? input.enumeration_policy,
    result_kind_view: input.view?.result_kind_view ?? input.result_kind_view };
  return normalizedFilters(actual) === normalizedFilters(expected.requestFilters ?? {}) ? null : "request_identity_mismatch";
}

function normalizedFilters(filters: ConditionalFieldRequestFilters): string {
  return JSON.stringify({
    since: filters.since, until: filters.until, time_field: filters.time_field,
    dimension_filter: filters.dimension_filter === undefined ? undefined : [...filters.dimension_filter].sort(),
    domain_tag_filter: filters.domain_tag_filter === undefined ? undefined : [...filters.domain_tag_filter].sort(),
    authorized_scopes: filters.authorized_scopes === undefined ? undefined : [...filters.authorized_scopes].sort(),
    enumeration_policy: filters.enumeration_policy ?? "canonical",
    result_kind_view: filters.result_kind_view ?? "mixed"
  });
}

export function sameBudget(left: RequestBudget, right: RequestBudget): boolean {
  const parsed = RequestBudgetSchema.safeParse(right);
  return parsed.success && JSON.stringify(left) === JSON.stringify(parsed.data);
}
