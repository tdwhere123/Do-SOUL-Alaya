import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  InformationIndexSchema,
  RequestBudgetSchema,
  SoulMemorySearchResponseSchema,
  type InformationIndex,
  type MemorySearchResult,
  type RecallPolicy,
  type RequestBudget,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { encodeIndexResults, frameEncodedIndex, sourceMetadataForRecallResult } from "@do-soul/alaya/recall/index-response";

type BenchRecallServiceResult = Awaited<
  ReturnType<AlayaDaemonRuntime["services"]["recallService"]["recall"]>
>;

export function validateBenchRecallIndex(result: BenchRecallServiceResult, budget?: RequestBudget): InformationIndex {
  const index = InformationIndexSchema.parse(result.index);
  if (result.provider_calls !== 0 || result.garden_enqueue !== 0) {
    throw new Error("conditional field Recall requires observed zero provider calls and Garden enqueue");
  }
  if (budget !== undefined && index.representation.page_budget !== budget.page_budget) {
    throw new Error("conditional field Recall response page budget differs from the sent request");
  }
  return index;
}

export function encodeBenchRecallResults(
  result: BenchRecallServiceResult,
  policy: RecallPolicy,
  requestBudget?: RequestBudget
): readonly MemorySearchResult[] {
  const index = validateBenchRecallIndex(result, requestBudget);
  const previews = new Map(result.candidates.map((candidate) =>
    [candidate.object_id, candidate.content_preview] as const));
  const metadata = sourceMetadataForRecallResult(result);
  return encodeIndexResults(index, previews, policy.fine_assessment.budgets.max_total_tokens, metadata);
}

export function buildBenchRecallResponse(
  deliveryId: string,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult,
  requestBudget: RequestBudget
): SoulMemorySearchResponse & {
  readonly diagnostics?: unknown;
  readonly provider_calls: 0;
  readonly garden_enqueue: 0;
  readonly request_budget: RequestBudget;
} {
  const budget = RequestBudgetSchema.parse(requestBudget);
  const index = frameEncodedIndex(validateBenchRecallIndex(recallResult, budget), results);
  const response = SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    index,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    active_constraints_completeness: recallResult.active_constraints_completeness,
    total_count: results.length,
    strategy_mix: {
      deterministic_match: true,
      precomputed_rank: false,
      semantic_supplement: false,
      graph_support: false,
      path_plasticity: false,
      global_recall: false
    },
    degradation_reason: recallResult.degradation_reason
  });
  return {
    ...response,
    provider_calls: recallResult.provider_calls,
    garden_enqueue: recallResult.garden_enqueue,
    request_budget: budget,
    ...(recallResult.diagnostics === undefined ? {} : { diagnostics: recallResult.diagnostics })
  };
}
