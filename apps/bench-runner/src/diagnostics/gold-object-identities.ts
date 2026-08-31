import type { LongMemEvalQuestionDiagnostic } from "./schema/diagnostics-types.js";

export type LongMemEvalGoldObjectKind = "memory_entry" | "evidence_capsule";

export interface LongMemEvalGoldObjectIdentity {
  readonly objectId: string;
  readonly objectKind: LongMemEvalGoldObjectKind;
}

export function buildGoldObjectIdentities(input: Readonly<{
  readonly goldMemoryIds: readonly string[];
  readonly goldEvidenceIds?: readonly string[];
}>): readonly LongMemEvalGoldObjectIdentity[] {
  return [
    ...unique(input.goldMemoryIds).map((objectId) => ({
      objectId,
      objectKind: "memory_entry" as const
    })),
    ...unique(input.goldEvidenceIds ?? []).map((objectId) => ({
      objectId,
      objectKind: "evidence_capsule" as const
    }))
  ];
}

export function buildGoldObjectIds(input: Readonly<{
  readonly goldMemoryIds: readonly string[];
  readonly goldEvidenceIds?: readonly string[];
  readonly goldObjectIds?: readonly string[];
}>): readonly string[] {
  return input.goldObjectIds === undefined
    ? unique([...input.goldMemoryIds, ...(input.goldEvidenceIds ?? [])])
    : unique(input.goldObjectIds);
}

export function readGoldObjectIds(
  question: Pick<
    LongMemEvalQuestionDiagnostic,
    "gold_memory_ids" | "gold_evidence_ids" | "gold_object_ids"
  >
): readonly string[] {
  return question.gold_object_ids ??
    unique([...question.gold_memory_ids, ...(question.gold_evidence_ids ?? [])]);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
