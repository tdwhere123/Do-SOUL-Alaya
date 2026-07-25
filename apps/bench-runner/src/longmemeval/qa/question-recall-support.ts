import type { BenchReportContextUsageInput } from "../../harness/daemon.js";
import type {
  DiagnosticRecallResultInput,
  DiagnosticScoreFactors
} from "../diagnostics/schema/diagnostics-types.js";
import {
  buildLongMemEvalSidecarKey,
  isLongMemEvalGoldEligibleResult,
  resolveLongMemEvalGoldObjectKind,
  type LongMemEvalSidecarEntry
} from "../runner/runner-helpers.js";
import type { LongMemEvalGoldObjectIdentity } from
  "../diagnostics/gold-object-identities.js";
import { isLongMemEvalGoldSource } from "../provenance/source-rounds.js";
import { truncateExcerpt } from "../multiturn/multiturn-helpers.js";

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

export function collectDeliveredGoldObjectIdentities(input: {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}): readonly LongMemEvalGoldObjectIdentity[] {
  const usedGoldObjectIdentities: LongMemEvalGoldObjectIdentity[] = [];
  for (let rank = 0; rank < input.results.length && rank < 10; rank += 1) {
    const pointer = input.results[rank];
    if (pointer === undefined || !isLongMemEvalGoldEligibleResult(pointer)) continue;
    const objectKind = resolveLongMemEvalGoldObjectKind(pointer.object_kind);
    if (objectKind === null) continue;
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey(objectKind, pointer.object_id)
    );
    if (meta !== undefined && isLongMemEvalGoldSource(meta, input.answerSessionIds)) {
      usedGoldObjectIdentities.push({ objectId: pointer.object_id, objectKind });
    }
  }
  return usedGoldObjectIdentities;
}

export function buildGoldUsageReport(input: {
  readonly deliveryId: string;
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
  }[];
  readonly usedGoldObjectIdentities: readonly LongMemEvalGoldObjectIdentity[];
  readonly turnIndex: number;
  readonly questionText: string;
  readonly successReason: string;
  readonly failureReason: string;
}): BenchReportContextUsageInput {
  const usedIdentityKeys = new Set(
    input.usedGoldObjectIdentities.map((identity) =>
      buildLongMemEvalSidecarKey(identity.objectKind, identity.objectId))
  );
  const usedObjectIds = input.usedGoldObjectIdentities.map(
    (identity) => identity.objectId
  );
  const usageState = usedObjectIds.length > 0 ? "used" : "skipped";
  return {
    deliveryId: input.deliveryId,
    usageState,
    ...(usedObjectIds.length === 0
      ? {}
      : { usedObjectIds }),
    deliveredObjects: input.results.slice(0, 10).map((pointer) => ({
      objectId: pointer.object_id,
      objectKind: pointer.object_kind ?? "memory_entry",
      usageStatus: isUsedGoldPointer(pointer, usedIdentityKeys)
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

function isUsedGoldPointer(
  pointer: Readonly<{
    readonly object_id: string;
    readonly object_kind?: string | null;
  }>,
  usedIdentityKeys: ReadonlySet<string>
): boolean {
  const objectKind = resolveLongMemEvalGoldObjectKind(pointer.object_kind);
  return objectKind !== null &&
    usedIdentityKeys.has(buildLongMemEvalSidecarKey(objectKind, pointer.object_id));
}
