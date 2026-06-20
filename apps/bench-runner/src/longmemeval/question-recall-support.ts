import type { BenchReportContextUsageInput } from "../harness/daemon.js";
import type {
  DiagnosticRecallResultInput,
  DiagnosticScoreFactors
} from "./diagnostics-types.js";
import {
  buildLongMemEvalSidecarKey,
  isLongMemEvalGoldEligibleResult,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import { truncateExcerpt } from "./multiturn-helpers.js";

export function buildDeliveredResults(
  results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
    readonly relevance_score: number;
    readonly score_factors?: unknown;
  }[]
): readonly DiagnosticRecallResultInput[] {
  return results.slice(0, 10).map((pointer, index) => ({
    object_id: pointer.object_id,
    object_kind: pointer.object_kind,
    rank: index + 1,
    relevance_score: pointer.relevance_score,
    score_factors: normalizeDiagnosticScoreFactors(pointer.score_factors)
  }));
}

function normalizeDiagnosticScoreFactors(
  value: unknown
): DiagnosticScoreFactors | null {
  if (value === null || value === undefined) {
    return null;
  }
  return isDiagnosticScoreFactorRecord(value) ? value : null;
}

function isDiagnosticScoreFactorRecord(
  value: unknown
): value is DiagnosticScoreFactors {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectDeliveredGoldObjectIds(input: {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}): readonly string[] {
  const usedGoldObjectIds: string[] = [];
  for (let rank = 0; rank < input.results.length && rank < 10; rank += 1) {
    const pointer = input.results[rank];
    if (pointer === undefined || !isLongMemEvalGoldEligibleResult(pointer)) continue;
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
    );
    if (meta !== undefined && meta.hasAnswer && input.answerSessionIds.has(meta.sessionId)) {
      usedGoldObjectIds.push(pointer.object_id);
    }
  }
  return usedGoldObjectIds;
}

export function buildGoldUsageReport(input: {
  readonly deliveryId: string;
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
  }[];
  readonly usedGoldObjectIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
  readonly successReason: string;
  readonly failureReason: string;
}): BenchReportContextUsageInput {
  const usedSet = new Set(input.usedGoldObjectIds);
  const usageState = input.usedGoldObjectIds.length > 0 ? "used" : "skipped";
  return {
    deliveryId: input.deliveryId,
    usageState,
    ...(input.usedGoldObjectIds.length === 0
      ? {}
      : { usedObjectIds: [...input.usedGoldObjectIds] }),
    deliveredObjects: input.results.slice(0, 10).map((pointer) => ({
      objectId: pointer.object_id,
      objectKind: pointer.object_kind ?? "memory_entry",
      usageStatus:
        isLongMemEvalGoldEligibleResult(pointer) && usedSet.has(pointer.object_id)
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
    reason: usageState === "used" ? input.successReason : input.failureReason
  };
}
