import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  InformationIndexSchema,
  indexEntryCacheKey,
  RequestBudgetSchema,
  SoulMemorySearchResponseSchema,
  sameRecallTarget,
  type InformationIndex,
  type MemorySearchResult,
  type RecallPolicy,
  type RequestBudget,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { encodeIndexResults, frameEncodedIndex, sourceMetadataForRecallResult } from "@do-soul/alaya/recall/index-response";
import { ConditionalFieldExecutionReceiptSchema, executionBindingMismatch,
  type ExpectedConditionalFieldRequest, type ConditionalFieldExecutionBinding
} from "../../../runs/measurement/conditional-field-request-binding.js";

type BenchRecallServiceResult = Awaited<
  ReturnType<AlayaDaemonRuntime["services"]["recallService"]["recall"]>
>;

export function validateBenchRecallIndex(result: BenchRecallServiceResult, budget?: RequestBudget,
  expected?: ExpectedConditionalFieldRequest): InformationIndex {
  const index = InformationIndexSchema.parse(result.index);
  const receipt = ConditionalFieldExecutionReceiptSchema.parse(result.execution_receipt);
  if (index.query_id !== receipt.query_id || index.snapshot_id !== receipt.snapshot_id
    || index.interpretation_id !== receipt.interpretation_id || index.as_of !== receipt.interpretation_clock) {
    throw new Error("conditional field index contradicts executed request identity");
  }
  if (expected !== undefined && executionBindingMismatch(receipt, expected) !== null) {
    throw new Error("conditional field execution differs from the invoked request");
  }
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
  requestBudget?: RequestBudget,
  expected?: ExpectedConditionalFieldRequest
): readonly MemorySearchResult[] {
  const index = validateBenchRecallIndex(result, requestBudget, expected);
  const previews = new Map(index.entries.flatMap((entry) => {
    const candidate = result.candidates.find((row) =>
      (entry.object_id !== undefined && row.object_id === entry.object_id)
      || (row.target !== undefined && sameRecallTarget(row.target, entry.target)));
    return candidate === undefined ? [] : [[indexEntryCacheKey(entry), candidate.content_preview] as const];
  }));
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
  readonly execution_receipt: ConditionalFieldExecutionBinding;
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
    degradation_reason: recallResult.degradation_reason
  });
  return {
    ...response,
    provider_calls: recallResult.provider_calls,
    garden_enqueue: recallResult.garden_enqueue,
    request_budget: budget,
    execution_receipt: ConditionalFieldExecutionReceiptSchema.parse(recallResult.execution_receipt),
    ...(recallResult.diagnostics === undefined ? {} : { diagnostics: recallResult.diagnostics })
  };
}
