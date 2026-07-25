import {
  MemoryGraphEdgeType,
  mapRelationKindToGraphEdgeType
} from "@do-soul/alaya-protocol";
import type {
  BenchDaemonHandle,
  BenchRecallOptions,
  BenchReportContextUsageInput
} from "../../harness/daemon.js";
import type { BenchSimulateReportMode } from "@do-soul/alaya-eval";
import type { LongMemEvalReportSideEffectSnapshot } from "../diagnostics.js";
import { monotonicElapsedMs, monotonicNowNs } from "../../shared/monotonic.js";
import type { LongMemEvalGoldObjectIdentity } from
  "../diagnostics/gold-object-identities.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalGoldObjectKind
} from "./runner-scoring.js";

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

interface LongMemEvalRecallCycleInput {
  readonly daemon: Pick<BenchDaemonHandle, "recall" | "reportContextUsage">;
  readonly query: string;
  readonly recallOptions: BenchRecallOptions;
  readonly referenceTime: string;
  readonly simulateReport: BenchSimulateReportMode;
  readonly goldObjectIdentities: readonly LongMemEvalGoldObjectIdentity[];
  readonly turnIndex: number;
  readonly questionText: string;
}

export async function runLongMemEvalRecallCycle(
  input: LongMemEvalRecallCycleInput
): Promise<LongMemEvalRecallCycleResult> {
  const recallOptions = { ...input.recallOptions, referenceTime: input.referenceTime };
  if (input.simulateReport === "none") {
    return runUnreportedRecallCycle(input, recallOptions);
  }
  return runReportedRecallCycle(input, recallOptions);
}

async function runReportedRecallCycle(
  input: LongMemEvalRecallCycleInput,
  recallOptions: BenchRecallOptions
): Promise<LongMemEvalRecallCycleResult> {
  const preReportRecallResult = await input.daemon.recall(
    input.query,
    recallOptions
  );
  const reportUsage = buildLongMemEvalReportContextUsage({
    simulateReport: input.simulateReport,
    deliveryId: preReportRecallResult.delivery_id,
    results: preReportRecallResult.results,
    goldObjectIdentities: input.goldObjectIdentities,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });
  if (reportUsage.reportInput !== null) {
    await input.daemon.reportContextUsage(reportUsage.reportInput);
  }

  const recallStart = monotonicNowNs();
  const scoredRecallResult = await input.daemon.recall(
    input.query,
    recallOptions
  );
  return {
    scoredRecallResult,
    scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
    reportUsageStats: reportUsage.stats
  };
}

async function runUnreportedRecallCycle(
  input: LongMemEvalRecallCycleInput,
  recallOptions: BenchRecallOptions
): Promise<LongMemEvalRecallCycleResult> {
  const recallStart = monotonicNowNs();
  const scoredRecallResult = await input.daemon.recall(input.query, recallOptions);
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

interface LongMemEvalReportContextUsageInput {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly results: readonly LongMemEvalDeliveredResult[];
  readonly goldObjectIdentities: readonly LongMemEvalGoldObjectIdentity[];
  readonly turnIndex: number;
  readonly questionText: string;
}

interface ReportUsageCandidates {
  readonly deliveredResults: readonly LongMemEvalDeliveredResult[];
  readonly eligibleDeliveredResults: readonly LongMemEvalDeliveredResult[];
  readonly eligibleDeliveredIdentityKeys: ReadonlySet<string>;
  readonly goldIdentityKeys: ReadonlySet<string>;
  readonly deliveredGoldResults: readonly LongMemEvalDeliveredResult[];
}

interface LongMemEvalReportContextUsage {
  readonly reportInput: BenchReportContextUsageInput | null;
  readonly stats: LongMemEvalReportSimulationStats;
}

// Returns null for simulate modes that do not report context usage (the caller
// then short-circuits to an empty report).
function selectReportedUsedObjects(
  simulateReport: BenchSimulateReportMode,
  eligibleDeliveredResults: readonly LongMemEvalDeliveredResult[],
  deliveredGoldResults: readonly LongMemEvalDeliveredResult[],
  goldIdentityKeys: ReadonlySet<string>
): LongMemEvalDeliveredResult[] | null {
  if (simulateReport === "gold-only") {
    return [...deliveredGoldResults];
  }
  if (simulateReport === "mixed") {
    if (deliveredGoldResults.length > 0) {
      const firstNonGold = eligibleDeliveredResults.find(
        (result) => !goldIdentityKeys.has(requireEligibleIdentityKey(result))
      );
      return firstNonGold === undefined
        ? [...deliveredGoldResults]
        : [...deliveredGoldResults, firstNonGold];
    }
    return eligibleDeliveredResults[0] === undefined
      ? []
      : [eligibleDeliveredResults[0]];
  }
  if (simulateReport === "always-used") {
    return eligibleDeliveredResults[0] === undefined
      ? []
      : [eligibleDeliveredResults[0]];
  }
  return null;
}

function buildReportInput(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly deliveredResults: readonly LongMemEvalDeliveredResult[];
  readonly safeUsedObjects: readonly LongMemEvalDeliveredResult[];
  readonly turnIndex: number;
  readonly questionText: string;
}): BenchReportContextUsageInput {
  const usedIdentityKeys = new Set(
    input.safeUsedObjects.map(requireEligibleIdentityKey)
  );
  const usedObjectIds = input.safeUsedObjects.map((result) => result.object_id);
  const usageState = usedObjectIds.length > 0 ? "used" : "skipped";
  return {
    deliveryId: input.deliveryId,
    usageState,
    ...(usedObjectIds.length === 0
      ? {}
      : { usedObjectIds }),
    deliveredObjects: input.deliveredResults.map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      usageStatus:
        eligibleIdentityKey(result) !== null &&
        usedIdentityKeys.has(requireEligibleIdentityKey(result))
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

export function buildLongMemEvalReportContextUsage(
  input: LongMemEvalReportContextUsageInput
): LongMemEvalReportContextUsage {
  const candidates = collectReportUsageCandidates(input);
  const usedObjects = selectReportedUsedObjects(
    input.simulateReport,
    candidates.eligibleDeliveredResults,
    candidates.deliveredGoldResults,
    candidates.goldIdentityKeys
  );
  if (usedObjects === null) {
    return buildNoReportContextUsage();
  }
  return buildReportedContextUsage(input, candidates, usedObjects);
}

function collectReportUsageCandidates(
  input: LongMemEvalReportContextUsageInput
): ReportUsageCandidates {
  const deliveredResults = input.results.slice(0, 10);
  const eligibleDeliveredResults = deliveredResults.filter(
    (result) => eligibleIdentityKey(result) !== null
  );
  const eligibleDeliveredIdentityKeys = new Set(
    eligibleDeliveredResults.map(requireEligibleIdentityKey)
  );
  const goldIdentityKeys = new Set(
    input.goldObjectIdentities.map((identity) =>
      buildLongMemEvalSidecarKey(identity.objectKind, identity.objectId))
  );
  const deliveredGoldResults = eligibleDeliveredResults.filter((result) =>
    goldIdentityKeys.has(requireEligibleIdentityKey(result))
  );
  return {
    deliveredResults,
    eligibleDeliveredResults,
    eligibleDeliveredIdentityKeys,
    goldIdentityKeys,
    deliveredGoldResults
  };
}

function buildNoReportContextUsage(): LongMemEvalReportContextUsage {
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

function buildReportedContextUsage(
  input: LongMemEvalReportContextUsageInput,
  candidates: ReportUsageCandidates,
  usedObjects: readonly LongMemEvalDeliveredResult[]
): LongMemEvalReportContextUsage {
  const safeUsedObjects = usedObjects.filter((result) =>
    candidates.eligibleDeliveredIdentityKeys.has(requireEligibleIdentityKey(result))
  );
  const usageState = safeUsedObjects.length > 0 ? "used" : "skipped";
  const reportInput = buildReportInput({
    simulateReport: input.simulateReport,
    deliveryId: input.deliveryId,
    deliveredResults: candidates.deliveredResults,
    safeUsedObjects,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });

  return {
    reportInput,
    stats: {
      reportsAttempted: 1,
      reportsUsed: usageState === "used" ? 1 : 0,
      reportsSkipped: usageState === "skipped" ? 1 : 0,
      usedObjectCount: safeUsedObjects.length
    }
  };
}

function eligibleIdentityKey(result: LongMemEvalDeliveredResult): string | null {
  const objectKind = resolveLongMemEvalGoldObjectKind(result.object_kind);
  return objectKind === null
    ? null
    : buildLongMemEvalSidecarKey(objectKind, result.object_id);
}

function requireEligibleIdentityKey(result: LongMemEvalDeliveredResult): string {
  const key = eligibleIdentityKey(result);
  if (key === null) {
    throw new Error("ineligible LongMemEval object reached report selection");
  }
  return key;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}
