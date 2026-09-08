import { z } from "zod";
import { RequestBudgetSchema, type RequestBudget } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";

const Id = z.string().min(1);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Clock = z.iso.datetime();
const Filters = {
  since: Clock.optional(), until: Clock.optional(),
  time_field: z.enum(["created_at", "last_used_at"]).optional(),
  dimension_filter: z.array(Id).readonly().optional(),
  domain_tag_filter: z.array(Id).readonly().optional(),
  authorized_scopes: z.array(Id).readonly().optional()
};

export const ConditionalFieldRequestFiltersSchema = z.object(Filters).strict().readonly();

export const ConditionalFieldExecutionReceiptSchema = z.object({
  schema_version: z.literal(1), workspace_id: Id, requested_budget: RequestBudgetSchema,
  compile_input: z.object({ source: z.literal("ordinary"), text: z.string(),
    snapshot_id: Digest, budget: RequestBudgetSchema, interpretation_clock: Clock, ...Filters
  }).strict().readonly(),
  query_id: Id, interpretation_id: Id, snapshot_id: Digest, interpretation_clock: Clock
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
    authorized_scopes: input.authorized_scopes };
  return normalizedFilters(actual) === normalizedFilters(expected.requestFilters ?? {}) ? null : "request_identity_mismatch";
}

function normalizedFilters(filters: ConditionalFieldRequestFilters): string {
  return JSON.stringify({
    since: filters.since, until: filters.until, time_field: filters.time_field,
    dimension_filter: filters.dimension_filter === undefined ? undefined : [...filters.dimension_filter].sort(),
    domain_tag_filter: filters.domain_tag_filter === undefined ? undefined : [...filters.domain_tag_filter].sort(),
    authorized_scopes: filters.authorized_scopes === undefined ? undefined : [...filters.authorized_scopes].sort()
  });
}

export function sameBudget(left: RequestBudget, right: RequestBudget): boolean {
  const parsed = RequestBudgetSchema.safeParse(right);
  return parsed.success && JSON.stringify(left) === JSON.stringify(parsed.data);
}
