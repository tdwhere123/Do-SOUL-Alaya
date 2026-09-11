import { RequestBudgetSchema, type RecallPolicy, type RequestBudget } from "@do-soul/alaya-protocol";
import type { BenchRecallOptions } from "../daemon/daemon-types.js";
import type { ConditionalFieldRequestFilters } from "../../runs/measurement/conditional-field-request-binding.js";

export function resolveBenchRequestBudget(options: BenchRecallOptions): RequestBudget {
  if (options.maxResults !== undefined && options.budget !== undefined
    && options.maxResults !== options.budget.page_budget) {
    throw new Error("maxResults conflicts with the explicit request budget page_budget");
  }
  return RequestBudgetSchema.parse(options.budget ?? {
    schema_version: 1, work_units: 10_000, memory_bytes: 1_000_000,
    page_budget: options.maxResults ?? 10, finalization_reserve: 100, min_envelope: 10
  });
}

export function benchRequestFilters(options: BenchRecallOptions, policy?: RecallPolicy): ConditionalFieldRequestFilters {
  const deterministic = policy?.coarse_filter.deterministic_match;
  const since = options.since ?? options.timeFilter?.since ?? undefined;
  const until = options.until ?? options.timeFilter?.until ?? undefined;
  return {
    ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }),
    ...(options.timeFilter?.field === undefined ? {} : { time_field: options.timeFilter.field }),
    ...(deterministic?.scope_filter === undefined ? {} : { authorized_scopes: deterministic.scope_filter }),
    ...(!deterministic?.dimension_filter?.length ? {} : { dimension_filter: deterministic.dimension_filter }),
    ...(!deterministic?.domain_tag_filter?.length ? {} : { domain_tag_filter: deterministic.domain_tag_filter }),
    ...(options.enumeration_policy === undefined ? {} : { enumeration_policy: options.enumeration_policy }),
    ...(options.result_kind_view === undefined ? {} : { result_kind_view: options.result_kind_view })
  };
}
