import type { EmbeddingRecallSupplementResult } from
  "../../../embedding-recall/embedding-recall-service.js";
import type { RecallSupplementaryData } from
  "../../runtime/recall-service-types.js";
import { clamp01 } from "../../runtime/recall-service-helpers.js";

export function withEmbeddingSimilarityScores(
  supplementaryData: RecallSupplementaryData,
  hintsByObjectId: EmbeddingRecallSupplementResult["similarityHintsByObjectId"],
  injectedSimilarityScores: Readonly<Record<string, number>>,
  poolRescoreScores: Readonly<Record<string, number>> = {},
  evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number> =
    supplementaryData.evidenceSemanticScoresByCandidateKey,
  evidenceSemanticWinnersByCandidateKey =
    supplementaryData.evidenceSemanticWinnersByCandidateKey
): RecallSupplementaryData {
  const attributedWinners = evidenceSemanticWinnersByCandidateKey?.size === 0
    ? undefined
    : evidenceSemanticWinnersByCandidateKey;
  const merged = mergeEmbeddingScores(
    hintsByObjectId,
    injectedSimilarityScores,
    poolRescoreScores
  );
  if (
    merged.size === 0 &&
    evidenceSemanticScoresByCandidateKey.size === 0 &&
    attributedWinners === undefined
  ) {
    return supplementaryData;
  }

  return Object.freeze({
    ...supplementaryData,
    embeddingSimilarityScores: merged.size === 0
      ? supplementaryData.embeddingSimilarityScores
      : Object.freeze(Object.fromEntries(merged)),
    evidenceSemanticScoresByCandidateKey: new Map(evidenceSemanticScoresByCandidateKey),
    ...(attributedWinners === undefined ? {} : {
      evidenceSemanticWinnersByCandidateKey: new Map(attributedWinners)
    })
  });
}

function mergeEmbeddingScores(
  hintsByObjectId: EmbeddingRecallSupplementResult["similarityHintsByObjectId"],
  injectedSimilarityScores: Readonly<Record<string, number>>,
  poolRescoreScores: Readonly<Record<string, number>>
): ReadonlyMap<string, number> {
  const merged = new Map<string, number>();
  for (const [objectId, hint] of Object.entries(hintsByObjectId)) {
    mergeObservedEmbeddingScore(merged, objectId, hint.normalized_similarity);
  }
  for (const [objectId, rawScore] of Object.entries(injectedSimilarityScores)) {
    mergeObservedEmbeddingScore(merged, objectId, rawScore);
  }
  for (const [objectId, rawScore] of Object.entries(poolRescoreScores)) {
    mergeObservedEmbeddingScore(merged, objectId, rawScore);
  }
  return merged;
}

function mergeObservedEmbeddingScore(
  scores: Map<string, number>,
  objectId: string,
  rawScore: number
): void {
  if (!Number.isFinite(rawScore)) return;
  const score = clamp01(rawScore);
  scores.set(objectId, Math.max(scores.get(objectId) ?? 0, score));
}
