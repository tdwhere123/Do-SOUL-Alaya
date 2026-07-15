import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import type {
  RecallFusionStreamContributions,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";

type DeepHeadSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "embeddingSimilarityScores"
  | "evidenceFtsRanks"
  | "structuralScores"
  | "sourceProximityScores"
>>;

/** Prefer cross-encoder scores when present; otherwise score the pruned waist. */
export function resolveDeepHeadScores(params: Readonly<{
  readonly candidates: readonly DeliverySelectionCandidate[];
  readonly answerRelevanceScores: ReadonlyMap<string, number>;
  readonly supplementaryData: DeepHeadSupplementary;
}>): ReadonlyMap<string, number> {
  if (params.answerRelevanceScores.size > 0) {
    return params.answerRelevanceScores;
  }
  return computeLightweightDeepHeadScores(params.candidates, params.supplementaryData);
}

export function computeLightweightDeepHeadScores(
  candidates: readonly DeliverySelectionCandidate[],
  supplementaryData: DeepHeadSupplementary
): ReadonlyMap<string, number> {
  const embeddingActive = candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) > 0
  );
  if (embeddingActive) {
    return new Map(
      candidates.map((candidate) => [
        candidate.fusion.candidate_key,
        lightweightDeepHeadScore(candidate, supplementaryData)
      ])
    );
  }
  const agreementActive = candidates.some(
    (candidate) => evidenceAgreementSignal(candidate, supplementaryData) > 0
  );
  if (!agreementActive) {
    return new Map();
  }
  return new Map(
    candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      coldEmbeddingDeepHeadScore(candidate, supplementaryData)
    ])
  );
}

function lightweightDeepHeadScore(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const embedding = embeddingSignal(candidate, supplementaryData);
  const evidenceAgreement = evidenceAgreementSignal(candidate, supplementaryData);
  return probabilisticOr(embedding, evidenceAgreement);
}

// Emb-cold head: keep post-gate fused mass for query-supported candidates so
// path/graph rescues with lexical foothold survive. Conflict-only piles
// (path/graph/structural with no lexical/emb ballot) stay agreement-gated so
// content-disjoint co-recall edges cannot lead delivery over lexical hits.
function coldEmbeddingDeepHeadScore(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  if (hasQuerySupportContribution(candidate.fusion.fused_rank_contribution_per_stream)) {
    return clamp01(candidate.fusion.fused_score);
  }
  return evidenceAgreementSignal(candidate, supplementaryData);
}

function hasQuerySupportContribution(
  contributions: Readonly<RecallFusionStreamContributions> | Readonly<Partial<Record<string, number>>>
): boolean {
  return (contributions.embedding_similarity ?? 0) > 0
    || (contributions.lexical_fts ?? 0) > 0
    || (contributions.trigram_fts ?? 0) > 0
    || (contributions.synthesis_fts ?? 0) > 0;
}

function embeddingSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const objectId = candidate.entry.object_id;
  return clamp01(
    candidate.effectiveFactors.embedding_similarity
      ?? supplementaryData.embeddingSimilarityScores[objectId]
      ?? 0
  );
}

function evidenceAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const objectId = candidate.entry.object_id;
  const evidence = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const structural = clamp01(
    candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0
  );
  const source = clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
  return Math.max(
    geometricAgreement(evidence, structural),
    geometricAgreement(evidence, source)
  );
}

function geometricAgreement(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(left * right));
}

function probabilisticOr(left: number, right: number): number {
  return clamp01(left + right - left * right);
}
