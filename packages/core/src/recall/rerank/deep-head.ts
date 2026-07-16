import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import type {
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import { readObservedUnitScore } from "../scoring/signals/observed-unit-score.js";
import { hasQueryEvidenceContribution } from "../scoring/query-evidence-support.js";

type DeepHeadSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "queryProbes"
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
  const embeddingObserved = candidates.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) !== null
  );
  if (embeddingObserved) {
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
  if (embedding === null) {
    return coldEmbeddingDeepHeadScore(candidate, supplementaryData);
  }
  const evidenceAgreement = evidenceAgreementSignal(candidate, supplementaryData);
  return probabilisticOr(embedding, evidenceAgreement);
}

// Emb-cold head: keep post-gate fused mass when an independent query lane
// supports the candidate. Prior-only path/graph/structural piles stay
// agreement-gated so content-disjoint co-recall edges cannot lead delivery.
function coldEmbeddingDeepHeadScore(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  if (hasQueryEvidenceContribution(
    candidate.fusion.fused_rank_contribution_per_stream,
    supplementaryData.queryProbes
  )) {
    return clamp01(candidate.fusion.fused_score);
  }
  return evidenceAgreementSignal(candidate, supplementaryData);
}

function embeddingSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number | null {
  const objectId = candidate.entry.object_id;
  const factor = readObservedUnitScore(candidate.effectiveFactors.embedding_similarity);
  if (factor !== null) return factor;
  if (!isWorkspaceMemoryCandidate(candidate)) return null;
  return readObservedUnitScore(supplementaryData.embeddingSimilarityScores[objectId]);
}

function evidenceAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const canUseMemorySignals = isWorkspaceMemoryCandidate(candidate);
  const objectId = candidate.entry.object_id;
  const evidence = clamp01(
    canUseMemorySignals ? supplementaryData.evidenceFtsRanks[objectId] ?? 0 : 0
  );
  const structural = clamp01(
    candidate.structuralScore ?? (
      canUseMemorySignals ? supplementaryData.structuralScores[objectId] ?? 0 : 0
    )
  );
  const source = clamp01(
    canUseMemorySignals ? supplementaryData.sourceProximityScores[objectId] ?? 0 : 0
  );
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
