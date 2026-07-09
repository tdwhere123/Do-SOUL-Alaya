import { scoreAbstentionQuestion } from "./abstention.js";

export interface LongMemEvalSidecarEntry {
  readonly objectId: string;
  readonly objectKind: "memory_entry" | "synthesis_capsule";
  readonly sessionId: string;
  readonly hasAnswer: boolean;
  readonly content?: string;
  readonly eventDate?: string;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
    readonly relevance_score: number;
    readonly abstention_confidence_score?: number | null;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}

export interface LongMemEvalHitScoringResult {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
}

export function resolveLongMemEvalHitVerdict(
  input: LongMemEvalHitScoringInput & { readonly isAbstention: boolean }
): LongMemEvalHitScoringResult {
  if (!input.isAbstention) {
    return scoreLongMemEvalRecallHits(input);
  }
  const abstention = scoreAbstentionQuestion({ results: input.results });
  const firstResult = input.results[0];
  return {
    hitAt1: abstention.correctAt1,
    hitAt5: abstention.correctAt5,
    hitAt10: abstention.correctAt10,
    firstTier:
      firstResult === undefined ? "cold" : inferTier(firstResult.relevance_score)
  };
}

export function scoreLongMemEvalRecallHits(
  input: LongMemEvalHitScoringInput
): LongMemEvalHitScoringResult {
  let hitAt1 = false;
  let hitAt5 = false;
  let hitAt10 = false;
  let firstTier: "hot" | "warm" | "cold" = "cold";

  for (let rank = 0; rank < input.results.length && rank < 10; rank++) {
    const pointer = input.results[rank];
    if (pointer === undefined) continue;
    if (rank === 0) {
      firstTier = inferTier(pointer.relevance_score);
    }
    if (!isLongMemEvalGoldEligibleResult(pointer)) {
      continue;
    }
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
    );
    const isHit =
      meta !== undefined &&
      meta.hasAnswer &&
      input.answerSessionIds.has(meta.sessionId);
    if (isHit) {
      if (rank === 0) hitAt1 = true;
      if (rank < 5) hitAt5 = true;
      hitAt10 = true;
    }
  }

  return { hitAt1, hitAt5, hitAt10, firstTier };
}

export function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_id?: string;
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

export function buildLongMemEvalSidecarKey(
  objectKind: LongMemEvalSidecarEntry["objectKind"],
  objectId: string
): string {
  return `${objectKind}:${objectId}`;
}

export function deriveLongMemEvalGoldMemoryIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter(
        (entry) =>
          entry.objectKind === "memory_entry" &&
          entry.hasAnswer &&
          answerSessionIds.has(entry.sessionId)
      )
      .map((entry) => entry.objectId)
  );
}

export function deriveLongMemEvalMemoryObjectIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter((entry) => entry.objectKind === "memory_entry")
      .map((entry) => entry.objectId)
  );
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}
