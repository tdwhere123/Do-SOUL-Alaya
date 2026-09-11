import { assertRecallConsumerCompatibility } from "@do-soul/alaya-core";
import {
  ContinuationSchema,
  PayloadContinuationRequestSchema,
  QueryInterpretationProposalSchema,
  type RecallPolicy,
  type SoulMemorySearchRequest,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "./recall-usage-handlers.js";

export async function runProductionBoundRecall(input: Readonly<{
  readonly deps: RecallUsageHandlerDependencies;
  readonly request: SoulMemorySearchRequest;
  readonly context: RecallUsageToolCallContext;
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly policyOverride: RecallPolicy;
}>): Promise<Awaited<ReturnType<RecallUsageHandlerDependencies["recallService"]["recall"]>>> {
  assertRecallConsumerCompatibility(input.request);
  const timeFilter = buildRecallTimeFilter(input.request);
  return await input.deps.recallService.recall({
    defer_delivery: true,
    taskSurface: input.taskSurface,
    workspaceId: input.context.workspaceId,
    runId: input.context.runId,
    strategy: "chat",
    policyOverride: input.policyOverride,
    queryText: input.request.query,
    pageBudget: input.request.max_results,
    continuation: input.request.continuation === undefined || input.request.continuation === null
      ? null
      : ContinuationSchema.parse(input.request.continuation),
    ...(input.request.source_observed_at === undefined
      ? {}
      : { interpretationClock: input.request.source_observed_at }),
    ...(input.request.since === undefined || input.request.since === null
      ? {}
      : { since: input.request.since }),
    ...(input.request.until === undefined || input.request.until === null
      ? {}
      : { until: input.request.until }),
    ...(timeFilter === undefined ? {} : { timeFilter }),
    ...(input.request.host_context === undefined ? {} : { hostContext: input.request.host_context }),
    activeConstraintsCap: input.request.active_constraints_cap ?? null,
    enumeration_policy: input.request.enumeration_policy,
    result_kind_view: input.request.result_kind_view,
    ...(input.request.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: QueryInterpretationProposalSchema.parse(input.request.interpretation_proposal) }),
    ...(input.request.payload_continuation === undefined
      ? {}
      : { payload_continuation: PayloadContinuationRequestSchema.parse(input.request.payload_continuation) }),
    ...(input.request.cap_contracts === undefined ? {} : { cap_contracts: input.request.cap_contracts }),
    ...(input.request.claim_demands === undefined ? {} : { claim_demands: input.request.claim_demands }),
    ...(input.request.protocol_version === undefined ? {} : { protocol_version: input.request.protocol_version }),
    ...(input.request.supported_result_kinds === undefined
      ? {}
      : { supported_result_kinds: input.request.supported_result_kinds }),
    ...(input.request.supports_source_evidence === undefined
      ? {}
      : { supports_source_evidence: input.request.supports_source_evidence }),
    ...(input.request.supports_product_updates === undefined
      ? {}
      : { supports_product_updates: input.request.supports_product_updates })
  });
}

function buildRecallTimeFilter(request: SoulMemorySearchRequest) {
  if (
    request.since === undefined &&
    request.until === undefined &&
    request.time_field === undefined
  ) {
    return undefined;
  }
  return {
    since: request.since ?? null,
    until: request.until ?? null,
    ...(request.time_field === undefined ? {} : { field: request.time_field })
  } as const;
}
