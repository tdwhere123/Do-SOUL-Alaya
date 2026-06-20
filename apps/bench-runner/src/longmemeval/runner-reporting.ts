import {
  MemoryGraphEdgeType,
  mapRelationKindToGraphEdgeType
} from "@do-soul/alaya-protocol";
import type {
  BenchDaemonHandle,
  BenchRecallOptions,
  BenchReportContextUsageInput
} from "../harness/daemon.js";
import type { BenchSimulateReportMode } from "@do-soul/alaya-eval";
import type { LongMemEvalReportSideEffectSnapshot } from "./diagnostics.js";
import { monotonicElapsedMs, monotonicNowNs } from "../shared/monotonic.js";
import { isLongMemEvalGoldEligibleResult } from "./runner-scoring.js";

export interface LongMemEvalReportSimulationStats {
  readonly reportsAttempted: number;
  readonly reportsUsed: number;
  readonly reportsSkipped: number;
  readonly usedObjectCount: number;
}

export type LongMemEvalBenchRecallResult = Awaited<
  ReturnType<BenchDaemonHandle["recall"]>
>;

export interface LongMemEvalRecallCycleResult {
  readonly scoredRecallResult: LongMemEvalBenchRecallResult;
  readonly scoredRecallLatencyMs: number;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
}

export async function runLongMemEvalRecallCycle(input: {
  readonly daemon: Pick<BenchDaemonHandle, "recall" | "reportContextUsage">;
  readonly query: string;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): Promise<LongMemEvalRecallCycleResult> {
  if (input.simulateReport === "none") {
    const recallStart = monotonicNowNs();
    const scoredRecallResult = await input.daemon.recall(
      input.query,
      input.recallOptions
    );
    return {
      scoredRecallResult,
      scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
      reportUsageStats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const preReportRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  const reportUsage = buildLongMemEvalReportContextUsage({
    simulateReport: input.simulateReport,
    deliveryId: preReportRecallResult.delivery_id,
    results: preReportRecallResult.results,
    goldMemoryIds: input.goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });
  if (reportUsage.reportInput !== null) {
    await input.daemon.reportContextUsage(reportUsage.reportInput);
  }

  const recallStart = monotonicNowNs();
  const scoredRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  return {
    scoredRecallResult,
    scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
    reportUsageStats: reportUsage.stats
  };
}

export async function readLongMemEvalReportSideEffectSnapshot(
  questionId: string,
  daemon: Pick<BenchDaemonHandle, "runtime">,
  workspaceId: string
): Promise<LongMemEvalReportSideEffectSnapshot> {
  const status = await daemon.runtime.services.graphHealthService.getStatus(
    workspaceId
  );
  const byKind: Record<string, number> = Object.fromEntries(
    Object.values(MemoryGraphEdgeType).map((edgeType) => [edgeType, 0])
  );
  for (const [kind, count] of Object.entries(status.path_relations_by_kind)) {
    const edgeType = mapRelationKindToGraphEdgeType(kind);
    const relationCount = typeof count === "number" ? count : 0;
    byKind[edgeType] = (byKind[edgeType] ?? 0) + relationCount;
  }
  return {
    question_id: questionId,
    workspace_id: status.workspace_id,
    memory_graph_edges_total: status.path_relations_total,
    memory_graph_edges_by_type: byKind,
    recalls_edge_count: byKind.recalls ?? 0,
    path_relations_total: status.path_relations_total,
    latest_path_event_at: status.latest_path_event_at,
    warnings: status.warnings
  };
}

type LongMemEvalDeliveredResult = {
  readonly object_id: string;
  readonly object_kind?: string;
};

// Returns null for simulate modes that do not report context usage (the caller
// then short-circuits to an empty report).
function selectReportedUsedObjectIds(
  simulateReport: BenchSimulateReportMode,
  deliveredMemoryResults: readonly LongMemEvalDeliveredResult[],
  deliveredGoldIds: readonly string[],
  goldIds: ReadonlySet<string>
): string[] | null {
  if (simulateReport === "gold-only") {
    return [...deliveredGoldIds];
  }
  if (simulateReport === "mixed") {
    if (deliveredGoldIds.length > 0) {
      const firstNonGold = deliveredMemoryResults.find(
        (result) => !goldIds.has(result.object_id)
      );
      return firstNonGold === undefined
        ? [...deliveredGoldIds]
        : [...deliveredGoldIds, firstNonGold.object_id];
    }
    return deliveredMemoryResults[0] === undefined
      ? []
      : [deliveredMemoryResults[0].object_id];
  }
  if (simulateReport === "always-used") {
    return deliveredMemoryResults[0] === undefined
      ? []
      : [deliveredMemoryResults[0].object_id];
  }
  return null;
}

function buildReportInput(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly deliveredResults: readonly LongMemEvalDeliveredResult[];
  readonly safeUsedObjectIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): BenchReportContextUsageInput {
  const usedSet = new Set(input.safeUsedObjectIds);
  const usageState = input.safeUsedObjectIds.length > 0 ? "used" : "skipped";
  return {
    deliveryId: input.deliveryId,
    usageState,
    ...(input.safeUsedObjectIds.length === 0
      ? {}
      : { usedObjectIds: [...input.safeUsedObjectIds] }),
    deliveredObjects: input.deliveredResults.map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      usageStatus:
        isLongMemEvalGoldEligibleResult(result) &&
        usedSet.has(result.object_id)
          ? "used"
          : "skipped"
    })),
    turnIndex: input.turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: truncateExcerpt(input.questionText)
        }
      ]
    },
    reason:
      usageState === "used"
        ? `LongMemEval simulate_report=${input.simulateReport}: reported delivered object usage.`
        : `LongMemEval simulate_report=${input.simulateReport}: no delivered object selected.`
  };
}

export function buildLongMemEvalReportContextUsage(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly results: readonly LongMemEvalDeliveredResult[];
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): {
  readonly reportInput: BenchReportContextUsageInput | null;
  readonly stats: LongMemEvalReportSimulationStats;
} {
  const deliveredResults = input.results.slice(0, 10);
  const deliveredMemoryResults = deliveredResults.filter(isLongMemEvalGoldEligibleResult);
  const deliveredMemoryIds = new Set(
    deliveredMemoryResults.map((result) => result.object_id)
  );
  const goldIds = new Set(input.goldMemoryIds);
  const deliveredGoldIds = deliveredMemoryResults
    .map((result) => result.object_id)
    .filter((objectId) => goldIds.has(objectId));

  const usedObjectIds = selectReportedUsedObjectIds(
    input.simulateReport,
    deliveredMemoryResults,
    deliveredGoldIds,
    goldIds
  );
  if (usedObjectIds === null) {
    return {
      reportInput: null,
      stats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const safeUsedObjectIds = usedObjectIds.filter((objectId) =>
    deliveredMemoryIds.has(objectId)
  );
  const usageState = safeUsedObjectIds.length > 0 ? "used" : "skipped";
  const reportInput = buildReportInput({
    simulateReport: input.simulateReport,
    deliveryId: input.deliveryId,
    deliveredResults,
    safeUsedObjectIds,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });

  return {
    reportInput,
    stats: {
      reportsAttempted: 1,
      reportsUsed: usageState === "used" ? 1 : 0,
      reportsSkipped: usageState === "skipped" ? 1 : 0,
      usedObjectCount: safeUsedObjectIds.length
    }
  };
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}
