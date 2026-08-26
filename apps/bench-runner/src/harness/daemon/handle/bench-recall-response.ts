import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import {
  SoulMemorySearchResponseSchema,
  type MemorySearchResult,
  type RecallPolicy,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { buildBenchRecallStrategyMix } from "../daemon-support.js";
import { resolveBenchRecallDegradationReason } from "./daemon-handle-ops-support.js";

type BenchRecallServiceResult = Awaited<
  ReturnType<AlayaDaemonRuntime["services"]["recallService"]["recall"]>
>;

export function buildBenchRecallResponse(
  deliveryId: string,
  results: readonly MemorySearchResult[],
  recallResult: BenchRecallServiceResult,
  policy: RecallPolicy
): SoulMemorySearchResponse & { readonly diagnostics?: unknown } {
  const response = SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    total_count: results.length,
    strategy_mix: buildBenchRecallStrategyMix(policy, results),
    degradation_reason: resolveBenchRecallDegradationReason(
      results, recallResult.degradation_reason
    ),
    ...(recallResult.delivery_path === undefined ? {} : {
      delivery_path: recallResult.delivery_path
    }),
    ...(recallResult.ranking_authority === undefined ? {} : {
      ranking_authority: recallResult.ranking_authority
    }),
    ...(recallResult.capture_identity === undefined ? {} : {
      capture_identity: recallResult.capture_identity
    }),
    ...(recallResult.capture_execution === undefined ? {} : {
      capture_execution: recallResult.capture_execution
    })
  });
  return recallResult.diagnostics === undefined
    ? response
    : { ...response, diagnostics: recallResult.diagnostics };
}
