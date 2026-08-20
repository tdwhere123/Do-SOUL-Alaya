import { scoreAbstentionQuestion } from "../../bench/diagnostics/abstention.js";
import { attachAbstentionConfidenceScore } from "../../bench/diagnostics/abstention-confidence.js";
import {
  buildObjectIdentityKey,
  readRecallDiagnostics
} from "../../bench/diagnostics/schema/diagnostics-private.js";
import {
  isLongMemEvalGoldSource,
  type LongMemEvalSourceRound
} from "../../bench/provenance/source-rounds.js";

export interface LongMemEvalSidecarEntry {
  readonly objectId: string;
  readonly objectKind:
    | "memory_entry"
    | "evidence_capsule"
    | "synthesis_capsule";
  readonly sessionId: string;
  readonly hasAnswer: boolean;
  readonly sourceRounds?: readonly LongMemEvalSourceRound[];
  readonly content?: string;
  readonly eventDate?: string;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
    readonly relevance_score: number;
    readonly fused_score?: number | null;
    readonly abstention_confidence_score?: number | null;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
  /** Optional raw recall payload so fused_score can be joined from diagnostics. */
  readonly recallResult?: unknown;
  readonly embeddingMode?: "disabled" | "env";
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
  const results = enrichAbstentionConfidence(
    joinFusedScoresOntoResults(input.results, input.recallResult, input.embeddingMode)
  );
  const abstention = scoreAbstentionQuestion({ results });
  const firstResult = results[0];
  return {
    hitAt1: abstention.hitAt1,
    hitAt5: abstention.hitAt5,
    hitAt10: abstention.hitAt10,
    firstTier:
      firstResult === undefined ? "cold" : inferTier(firstResult.relevance_score)
  };
}

/**
 * Join candidate fused_score onto delivered pointers when the pointer itself
 * lacks it. Used before abstention confidence so the producer sees fusion.
 */
export function joinFusedScoresOntoResults<
  T extends {
    readonly object_id: string;
    readonly object_kind?: string | null;
    readonly fused_score?: number | null;
  }
>(
  results: readonly T[],
  recallResult: unknown,
  embeddingMode: "disabled" | "env" = "env"
): readonly (T & { readonly fused_score: number | null })[] {
  const diagnostics =
    recallResult === undefined
      ? null
      : readRecallDiagnostics(recallResult, embeddingMode);
  return results.map((result) => {
    if (result.fused_score !== undefined && result.fused_score !== null) {
      return { ...result, fused_score: result.fused_score };
    }
    const objectKind = result.object_kind ?? "memory_entry";
    const candidate = diagnostics?.candidatesByObjectIdentity.get(
      buildObjectIdentityKey(objectKind, result.object_id)
    );
    return {
      ...result,
      fused_score: candidate?.fusedScore ?? result.fused_score ?? null
    };
  });
}

/**
 * Prefer an explicit confidence channel; otherwise derive from fused_score
 * ranking dominance. Never falls back to relevance_score.
 */
export function enrichAbstentionConfidence<
  T extends {
    readonly relevance_score: number;
    readonly fused_score?: number | null;
    readonly abstention_confidence_score?: number | null;
  }
>(results: readonly T[]): readonly T[] {
  return attachAbstentionConfidenceScore(results);
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
    const objectKind = resolveLongMemEvalGoldObjectKind(pointer.object_kind);
    if (objectKind === null) {
      continue;
    }
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey(objectKind, pointer.object_id)
    );
    const isHit = meta !== undefined &&
      isLongMemEvalGoldSource(meta, input.answerSessionIds);
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
  return resolveLongMemEvalGoldObjectKind(result.object_kind) !== null;
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
          isLongMemEvalGoldSource(entry, answerSessionIds)
      )
      .map((entry) => entry.objectId)
  );
}

export function deriveLongMemEvalGoldEvidenceIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return deriveGoldIds(sidecar, answerSessionIds, "evidence_capsule");
}

export function deriveLongMemEvalGoldObjectIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionIds),
      ...deriveLongMemEvalGoldEvidenceIds(sidecar, answerSessionIds)
    ])
  ]);
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

function deriveGoldIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>,
  objectKind: "memory_entry" | "evidence_capsule"
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter((entry) =>
        entry.objectKind === objectKind &&
        isLongMemEvalGoldSource(entry, answerSessionIds))
      .map((entry) => entry.objectId)
  );
}

export function resolveLongMemEvalGoldObjectKind(
  objectKind: string | null | undefined
): "memory_entry" | "evidence_capsule" | null {
  const resolved = objectKind ?? "memory_entry";
  return resolved === "memory_entry" || resolved === "evidence_capsule"
    ? resolved
    : null;
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}
