import type {
  MemoryEntry,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { rerankTopN, type RerankCandidate } from "./recall-feature-rerank.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import {
  buildRecallCandidateDedupeKey,
  clamp01,
  compareMemoryEntries,
  normalizeActivationScore,
  normalizeGraphSupport
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "./recall-service-types.js";
import {
  normalizeEvidenceText,
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "./query-evidence-scoring.js";

const STRONG_LEXICAL_DELIVERY_RANK = 0.9;

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

export function prioritizeStrongLexicalDeliveryWindowCandidates<T extends FusedRecallCandidateInput>(
  rankedCandidates: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  const deliveryWindowSize = Math.min(Math.max(0, maxEntries), rankedCandidates.length);
  if (deliveryWindowSize <= 1) {
    return rankedCandidates;
  }

  const deliveryWindow = rankedCandidates.slice(0, deliveryWindowSize);
  if (!deliveryWindow.some((candidate) => isStrongLexicalCandidate(candidate, supplementaryData))) {
    return rankedCandidates;
  }

  if (!deliveryWindow.some((candidate) => isSourceProximityLocalOnlyCandidate(candidate))) {
    return rankedCandidates;
  }

  const reorderedWindow: T[] = [];
  const deferredSourceLocalOnly: T[] = [];
  for (const candidate of deliveryWindow) {
    if (isSourceProximityLocalOnlyCandidate(candidate)) {
      deferredSourceLocalOnly.push(candidate);
      continue;
    }
    reorderedWindow.push(candidate);
    if (isStrongLexicalCandidate(candidate, supplementaryData) && deferredSourceLocalOnly.length > 0) {
      reorderedWindow.push(...deferredSourceLocalOnly);
      deferredSourceLocalOnly.length = 0;
      continue;
    }
  }
  reorderedWindow.push(...deferredSourceLocalOnly);

  return Object.freeze([
    ...reorderedWindow,
    ...rankedCandidates.slice(deliveryWindowSize)
  ]);
}

export function applyFeatureRerank<T extends FusedRecallCandidateInput>(
  rankedCandidates: readonly T[],
  supplementaryData: RecallSupplementaryData
): readonly T[] {
  const rerankInputs: readonly RerankCandidate<T>[] = rankedCandidates.map((candidate) => {
    const gist = supplementaryData.evidenceGistsByMemoryId[candidate.entry.object_id];
    const hasGist = typeof gist === "string" && gist.length > 0;
    return Object.freeze({
      item: candidate,
      fusionScore: candidate.fusion.fused_score,
      text: Object.freeze({
        content: candidate.entry.content,
        hasEvidenceLexicalHit:
          (supplementaryData.evidenceFtsRanks[candidate.entry.object_id] ?? 0) > 0 ||
          (candidate.objectKind === "synthesis_capsule" &&
            (supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0) > 0),
        ...(hasGist ? { evidenceGist: gist } : {})
      })
    });
  });
  return rerankTopN(supplementaryData.queryProbes, rerankInputs);
}

function isStrongLexicalCandidate(
  candidate: FusedRecallCandidateInput,
  supplementaryData: RecallSupplementaryData
): boolean {
  const rank = candidate.objectKind === "synthesis_capsule"
    ? supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0
    : supplementaryData.ftsRanks[candidate.entry.object_id] ?? 0;
  return clamp01(rank) >= STRONG_LEXICAL_DELIVERY_RANK;
}

function isSourceProximityLocalOnlyCandidate(candidate: FusedRecallCandidateInput): boolean {
  const ranks = candidate.fusion.per_stream_rank;
  return (
    ranks.source_proximity !== null &&
    ranks.lexical_fts === null &&
    ranks.synthesis_fts === null &&
    ranks.evidence_fts === null &&
    ranks.evidence_structural_agreement === null &&
    ranks.source_evidence_agreement === null &&
    ranks.embedding_similarity === null &&
    ranks.graph_expansion === null &&
    ranks.path_expansion === null
  );
}
