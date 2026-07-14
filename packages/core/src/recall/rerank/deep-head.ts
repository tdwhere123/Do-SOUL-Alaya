import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import { compareFusedRecallCandidates } from "../delivery/fusion-delivery-scoring.js";
import type {
  RecallFusionStreamContributions,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";

/**
 * Gold's pre-deep fused rank p95 ≈ 16 and is within fused@30 for 100% of
 * scorable questions. Window is that coverage bound — not an R@5 knob.
 */
export const DEEP_HEAD_CANDIDATE_LIMIT = 30;

type DeepHeadSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "embeddingSimilarityScores"
  | "evidenceFtsRanks"
  | "structuralScores"
  | "sourceProximityScores"
>>;

/**
 * Prefer cross-encoder answer scores when present; otherwise score the fused
 * top-30 with cheap embedding + evidence-agreement signals (no CE path).
 */
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
  // Three tiers by what orthogonal signal exists anywhere in the fused head:
  // 1) emb-active → (2·emb+agreement)/3 (query-conditioned primary)
  // 2) emb-cold + agreement present somewhere → keep fused_score for
  //    query-supported candidates; agreement-gate conflict-only piles
  // 3) emb-cold + agreement-cold → empty map (fused order binds; no rescoring)
  const head = [...candidates]
    .sort(compareFusedRecallCandidates)
    .slice(0, DEEP_HEAD_CANDIDATE_LIMIT);
  const embeddingActive = head.some(
    (candidate) => embeddingSignal(candidate, supplementaryData) > 0
  );
  if (embeddingActive) {
    return new Map(
      head.map((candidate) => [
        candidate.fusion.candidate_key,
        lightweightDeepHeadScore(candidate, supplementaryData)
      ])
    );
  }
  // "Agreement present somewhere" = any head candidate has evidence∩structural
  // or evidence∩source proximity > 0. That unlocks tier 2 for the whole head.
  const agreementActive = head.some(
    (candidate) => evidenceAgreementSignal(candidate, supplementaryData) > 0
  );
  if (!agreementActive) {
    return new Map();
  }
  return new Map(
    head.map((candidate) => [
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
  // Two available signals without CE: emb is query-conditioned primary, agreement
  // is corroboration. Majority vote of the pair (2:1) — emb stays decisive while
  // agreement breaks near-ties without reintroducing shallow RRF ordinals.
  return clamp01((2 * embedding + evidenceAgreement) / 3);
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
  const structuralAgreement = agreementProduct(evidence, structural);
  const sourceAgreement = agreementProduct(evidence, source);
  return Math.max(evidence, structuralAgreement, sourceAgreement);
}

function agreementProduct(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(left * right) + Math.min(left, right) * 0.1);
}
