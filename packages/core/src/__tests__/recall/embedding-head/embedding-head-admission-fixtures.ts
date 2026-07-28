import {
  MemoryDimension,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  type FineAssessmentCandidate,
  selectFineAssessmentCandidates
} from "../../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import {
  createCandidate as createBaseCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";

type SelectionOverrides = Readonly<{
  readonly answerRerankedCandidateKeys?: readonly string[];
  readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
  readonly maxEntries?: number;
  readonly maxTotalTokens?: number;
  readonly perDimensionLimits?: Readonly<Record<string, number>>;
  readonly queryText?: string | null;
  readonly tokenEstimate?: (content: string) => number;
}>;

export function runSelection(
  candidates: readonly FineAssessmentCandidate[],
  overrides: SelectionOverrides = {}
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: overrides.maxEntries ?? 2,
        max_total_tokens: overrides.maxTotalTokens ?? 100,
        per_dimension_limits: overrides.perDimensionLimits ?? null
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(overrides.queryText ?? null),
      embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
      evidenceGistsByMemoryId: Object.fromEntries(
        candidates.map((candidate) => [candidate.entry.object_id, candidate.entry.object_id])
      )
    }),
    tokenEstimator: { estimate: overrides.tokenEstimate ?? (() => 5) },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: relevanceMap(candidates),
    coverageRelevanceByCandidateKey: relevanceMap(candidates),
    answerRelevanceRankByCandidateKey: new Map(
      (overrides.answerRerankedCandidateKeys ?? []).map((key, index) => [key, index + 1])
    )
  });
}

export function createCandidate(
  objectId: string,
  fusedScore: number
): FineAssessmentCandidate {
  const candidate = createBaseCandidate(objectId);
  return {
    ...candidate,
    effectiveScore: fusedScore,
    fusion: {
      ...candidate.fusion,
      fused_rank: Math.round((1 - fusedScore) * 100) + 1,
      fused_score: fusedScore
    }
  };
}

export function withFusionRanks(
  candidate: FineAssessmentCandidate,
  embeddingRank: number,
  queryRanks: Readonly<Record<string, number>> = {}
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        embedding_similarity: embeddingRank,
        ...queryRanks
      }
    }
  };
}

export function withDimension(
  candidate: FineAssessmentCandidate,
  dimension: MemoryDimension
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, dimension } };
}

export function withEntry(
  candidate: FineAssessmentCandidate,
  overrides: Partial<MemoryEntry>
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, ...overrides } };
}

export function withCandidateKey(
  candidate: FineAssessmentCandidate,
  candidateKey: string
): FineAssessmentCandidate {
  return {
    ...candidate,
    originPlane: "global",
    fusion: { ...candidate.fusion, candidate_key: candidateKey }
  };
}

function relevanceMap(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}
