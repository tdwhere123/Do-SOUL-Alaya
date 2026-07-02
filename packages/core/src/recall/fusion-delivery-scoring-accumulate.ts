import { classifyRecallIntent } from "./recall-query-plan.js";
import {
  bestEvidenceEnabled,
  cappedLexicalFloodSum,
  combineBestEvidenceFamilies,
  decorrelateFamily,
  embeddingGateEnabled,
  embeddingGateFloor,
  embeddingGateAppliesToIntent,
  floodGovernanceEnabled,
  gateSurfaceByEmbedding,
  isLexicalFamilyFloodStream,
  resolveBestEvidenceRelevance,
  resolveFloodFusionContribution,
  streamFamily,
  synthesisFusionEnabled,
  synthesisGateFloor,
  synthesisDecorrLambda,
  synthesisGovernanceEnabled,
  applySynthesisGovernance,
  synthesisIntentGated,
  type FloodStreamScores,
  type StreamFamily
} from "./flood-fusion-scoring.js";
import {
  evidenceMultEnabled,
  resolveConformantEvidenceBeta,
  resolveConformantPathWeight,
  type ConformantAxisContext
} from "./conformant-fusion-scoring.js";
import type { RecallFusionStream, RecallSupplementaryData } from "./recall-service-types.js";
import type { ResolvedRecallFusionWeights } from "./fusion-delivery-adaptive-scoring.js";
import { resolveFusionContribution as resolveAdaptiveFusionContribution } from "./fusion-delivery-adaptive-scoring.js";
import type { RecallFusionCandidateInput } from "./fusion-delivery-scoring-candidate.js";
import { activeFusionStreams } from "./fusion-delivery-streams.js";

export function accumulateFusionContributions(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>,
  embeddingPoolMax: number,
  axisContext: ConformantAxisContext | null
): number {
  if (axisContext !== null) {
    return accumulateConformantFusedScore(
      candidate, supplementaryData, resolved, ranksByStream, candidateKey, perStreamRank, contributions, axisContext
    );
  }
  if (synthesisFusionEnabled()) {
    return accumulateSynthesisFusedScore(
      candidate, supplementaryData, resolved, ranksByStream, candidateKey, perStreamRank, contributions, embeddingPoolMax
    );
  }
  if (scoresByStream !== null && bestEvidenceEnabled()) {
    return accumulateBestEvidenceFusedScore(
      candidate, supplementaryData, resolved, ranksByStream, scoresByStream, candidateKey, perStreamRank, contributions
    );
  }
  return accumulateDefaultFusedScore(
    candidate, supplementaryData, resolved, ranksByStream, scoresByStream, candidateKey, perStreamRank, contributions, embeddingPoolMax
  );
}

function accumulateConformantFusedScore(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>,
  axisContext: ConformantAxisContext
): number {
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank !== null) {
      contributions[stream] = resolveFusionContribution(candidate, supplementaryData, resolved, stream, rank);
    }
  }
  const ra = axisContext.raByKey.get(candidateKey);
  const composed = (ra?.object ?? 0) + resolveConformantPathWeight() * (ra?.path ?? 0);
  return evidenceMultEnabled()
    ? composed * (1 + resolveConformantEvidenceBeta() * (ra?.evidence ?? 0))
    : composed;
}

function accumulateDefaultFusedScore(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>,
  embeddingPoolMax: number
): number {
  const governance = scoresByStream !== null && floodGovernanceEnabled();
  const embedGateFloor =
    embeddingGateEnabled() && embeddingGateAppliesToIntent(classifyRecallIntent(supplementaryData.queryProbes))
      ? embeddingGateFloor()
      : null;
  let fusedScore = 0;
  let lexicalFamilySum = 0;
  let lexicalFamilyMax = 0;
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const rawContribution = scoresByStream === null
      ? resolveFusionContribution(candidate, supplementaryData, resolved, stream, rank)
      : resolveFloodContribution(candidate, supplementaryData, resolved, scoresByStream, stream, candidateKey);
    const contribution = embedGateFloor !== null && streamFamily(stream) === "lexical"
      ? gateSurfaceByEmbedding(rawContribution, candidate, embedGateFloor, embeddingPoolMax)
      : rawContribution;
    contributions[stream] = contribution;
    if (governance && isLexicalFamilyFloodStream(stream)) {
      lexicalFamilySum += contribution;
      lexicalFamilyMax = Math.max(lexicalFamilyMax, contribution);
    } else {
      fusedScore += contribution;
    }
  }
  return governance ? fusedScore + cappedLexicalFloodSum(lexicalFamilySum, lexicalFamilyMax) : fusedScore;
}

// invariant: best-evidence fusion takes max relevance within each family before noisy-OR across families.
function accumulateBestEvidenceFusedScore(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores>,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>
): number {
  const relevanceByStream = new Map<RecallFusionStream, number>();
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const streamScores = scoresByStream.get(stream);
    if (streamScores === undefined) {
      continue;
    }
    const relevance = resolveBestEvidenceRelevance({
      candidate,
      supplementaryData,
      resolved,
      stream,
      rawScore: streamScores.scoreByKey.get(candidateKey) ?? 0,
      streamMax: streamScores.max
    });
    contributions[stream] = relevance;
    if (relevance > 0) {
      relevanceByStream.set(stream, relevance);
    }
  }
  return combineBestEvidenceFamilies(relevanceByStream);
}

// invariant: synthesis fusion de-correlates per family and keeps non-gated intents additive.
function accumulateSynthesisFusedScore(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>,
  embeddingPoolMax: number
): number {
  const gated = synthesisIntentGated(classifyRecallIntent(supplementaryData.queryProbes));
  const byFamily = new Map<StreamFamily, number[]>();
  let additiveSum = 0;
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const contribution = resolveFusionContribution(candidate, supplementaryData, resolved, stream, rank);
    contributions[stream] = contribution;
    additiveSum += contribution;
    const family = streamFamily(stream);
    const bucket = byFamily.get(family);
    if (bucket === undefined) {
      byFamily.set(family, [contribution]);
    } else {
      bucket.push(contribution);
    }
  }
  return gated ? combineSynthesisAxes(byFamily, candidate, embeddingPoolMax) : additiveSum;
}

function combineSynthesisAxes(
  byFamily: ReadonlyMap<StreamFamily, readonly number[]>,
  candidate: RecallFusionCandidateInput,
  embeddingPoolMax: number
): number {
  const lambda = synthesisDecorrLambda();
  let surfaceMass = 0;
  let orthogonalMass = 0;
  for (const [family, familyContributions] of byFamily) {
    const decorrelated = decorrelateFamily(familyContributions, lambda);
    if (family === "lexical") {
      surfaceMass += gateSurfaceByEmbedding(decorrelated, candidate, synthesisGateFloor(), embeddingPoolMax);
    } else {
      orthogonalMass += decorrelated;
    }
  }
  const governedSurface = synthesisGovernanceEnabled()
    ? applySynthesisGovernance(surfaceMass, orthogonalMass)
    : surfaceMass;
  return governedSurface + orthogonalMass;
}

function resolveFloodContribution(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores>,
  stream: RecallFusionStream,
  candidateKey: string
): number {
  const streamScores = scoresByStream.get(stream);
  if (streamScores === undefined) {
    return 0;
  }
  return resolveFloodFusionContribution({
    candidate,
    supplementaryData,
    resolved,
    stream,
    rawScore: streamScores.scoreByKey.get(candidateKey) ?? 0,
    streamMax: streamScores.max
  });
}

function resolveFusionContribution(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  stream: RecallFusionStream,
  rank: number
): number {
  return resolveAdaptiveFusionContribution({
    candidate,
    supplementaryData,
    resolved,
    stream,
    rank
  });
}
