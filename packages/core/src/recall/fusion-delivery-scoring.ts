import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  buildRecallCandidateDedupeKey,
  clamp01,
  compareMemoryEntries
} from "./recall-service-helpers.js";
import {
  resolveRrfFusionWeights,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import {
  bestEvidenceEnabled,
  floodFusionEnabled,
  type FloodStreamScores
} from "./flood-fusion-scoring.js";
import {
  buildConformantAxisContext,
  compareConformantAxisRa,
  flatBaselineEnabled,
  fourAxisAssemblyEnabled,
  type ConformantAxisContext
} from "./conformant-fusion-scoring.js";
import {
  activeFusionStreams,
  facetOverlapCountFor,
  facetSliceEnabled,
  RECALL_FUSION_DEFAULT_WEIGHTS
} from "./fusion-delivery-streams.js";
import type {
  RecallFusionCandidateInput,
  FusedRecallCandidateInput,
  PreliminaryFusionCandidate
} from "./fusion-delivery-scoring-candidate.js";
import { scoreRecallFusionStream } from "./fusion-delivery-scoring-streams.js";
import { accumulateFusionContributions } from "./fusion-delivery-scoring-accumulate.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "./recall-service-types.js";

export { flatBaselineEnabled, fourAxisAssemblyEnabled };
export {
  activeFusionStreams,
  facetOverlapEnabled,
  RECALL_FUSION_STREAMS
} from "./fusion-delivery-streams.js";

const PATH_SUPPRESSION_RESIDUAL_FLOOR = 1e-4;

export function buildRecallFusionDetails(params: Readonly<{
  readonly candidates: readonly RecallFusionCandidateInput[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
}>): ReadonlyMap<string, RecallFusionBreakdown> {
  const resolved = resolveRrfFusionWeights({
    policy: params.policy,
    queryProbes: params.supplementaryData.queryProbes,
    streams: activeFusionStreams(),
    baseWeights: RECALL_FUSION_DEFAULT_WEIGHTS
  });
  const ranksByStream = buildFusionRanksByStream(params.candidates, params.supplementaryData, params.nowIso);
  const scoresByStream = floodFusionEnabled() || bestEvidenceEnabled()
    ? buildFusionScoresByStream(params.candidates, params.supplementaryData, params.nowIso)
    : null;
  const embeddingPoolMax = params.candidates.reduce(
    (max, candidate) => Math.max(max, clamp01(candidate.effectiveFactors.embedding_similarity ?? 0)),
    0
  );
  const axisContext = fourAxisAssemblyEnabled()
    ? buildConformantAxisContext({
        candidates: params.candidates.map((candidate) => ({
          candidateKey: buildRecallCandidateDedupeKey(candidate),
          candidate
        })),
        ranksByStream,
        resolved,
        supplementaryData: params.supplementaryData
      })
    : null;
  const prelim = buildPreliminaryFusionCandidates(params, resolved, ranksByStream, scoresByStream, embeddingPoolMax, axisContext);
  const fusedRankByCandidateKey = buildFusedRankByCandidateKey(prelim);
  return finalizeRecallFusionDetails(prelim, fusedRankByCandidateKey);
}

// Path suppression only demotes fused_score and recomputes rank order.
export function applyPathSuppressionToFusionScores(
  fusionByCandidateKey: ReadonlyMap<string, RecallFusionBreakdown>,
  suppressionScores: Readonly<Record<string, number>>
): ReadonlyMap<string, RecallFusionBreakdown> {
  const hasAnySuppression = Object.values(suppressionScores).some((delta) => delta > 0);
  if (!hasAnySuppression) {
    return fusionByCandidateKey;
  }
  const adjusted = [...fusionByCandidateKey.values()].map((breakdown) => {
    const delta = suppressionScores[breakdown.object_id] ?? 0;
    const fusedScore =
      delta > 0 && breakdown.fused_score > 0
        ? Math.max(PATH_SUPPRESSION_RESIDUAL_FLOOR, breakdown.fused_score - delta)
        : breakdown.fused_score;
    return { breakdown, fusedScore };
  });
  const ranked = [...adjusted].sort((left, right) => {
    const delta = right.fusedScore - left.fusedScore;
    if (delta !== 0) {
      return delta;
    }
    return left.breakdown.fused_rank - right.breakdown.fused_rank;
  });
  const suppressedRankByKey = new Map(
    ranked.map((entry, index) => [entry.breakdown.candidate_key, index + 1] as const)
  );
  return Object.freeze(
    new Map(
      adjusted.map((entry) => [
        entry.breakdown.candidate_key,
        Object.freeze({
          ...entry.breakdown,
          fused_rank: suppressedRankByKey.get(entry.breakdown.candidate_key) ?? entry.breakdown.fused_rank,
          fused_score: entry.fusedScore
        })
      ] as const)
    )
  );
}


function buildFusionRanksByStream(
  candidates: readonly RecallFusionCandidateInput[],
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>> {
  const ranksByStream = new Map<RecallFusionStream, ReadonlyMap<string, number>>();
  for (const stream of activeFusionStreams()) {
    ranksByStream.set(
      stream,
      buildFusionRanksForStream(candidates, stream, supplementaryData, nowIso)
    );
  }
  return ranksByStream;
}

function buildFusionRanksForStream(
  candidates: readonly RecallFusionCandidateInput[],
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): ReadonlyMap<string, number> {
  const scored = candidates
    .map((candidate) => Object.freeze({
      candidateKey: buildRecallCandidateDedupeKey(candidate),
      entry: candidate.entry,
      score: scoreRecallFusionStream(candidate, stream, supplementaryData, nowIso)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    );
  return Object.freeze(new Map(scored.map((candidate, index) => [candidate.candidateKey, index + 1] as const)));
}

function buildFusionScoresByStream(
  candidates: readonly RecallFusionCandidateInput[],
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): ReadonlyMap<RecallFusionStream, FloodStreamScores> {
  const scoresByStream = new Map<RecallFusionStream, FloodStreamScores>();
  for (const stream of activeFusionStreams()) {
    scoresByStream.set(stream, buildFusionScoresForStream(candidates, stream, supplementaryData, nowIso));
  }
  return scoresByStream;
}

function buildFusionScoresForStream(
  candidates: readonly RecallFusionCandidateInput[],
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): FloodStreamScores {
  const scoreByKey = new Map<string, number>();
  let max = 0;
  for (const candidate of candidates) {
    const score = scoreRecallFusionStream(candidate, stream, supplementaryData, nowIso);
    if (score > 0) {
      scoreByKey.set(buildRecallCandidateDedupeKey(candidate), score);
      if (score > max) {
        max = score;
      }
    }
  }
  return Object.freeze({ scoreByKey: Object.freeze(scoreByKey), max });
}

function buildPreliminaryFusionCandidates(
  params: Readonly<{
    readonly candidates: readonly RecallFusionCandidateInput[];
    readonly supplementaryData: RecallSupplementaryData;
  }>,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null,
  embeddingPoolMax: number,
  axisContext: ConformantAxisContext | null
): readonly PreliminaryFusionCandidate[] {
  return params.candidates.map((candidate) =>
    buildPreliminaryFusionCandidate(candidate, params.supplementaryData, resolved, ranksByStream, scoresByStream, embeddingPoolMax, axisContext)
  );
}

function buildPreliminaryFusionCandidate(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null,
  embeddingPoolMax: number,
  axisContext: ConformantAxisContext | null
): PreliminaryFusionCandidate {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const perStreamRank = buildEmptyFusionStreamRanks();
  const contributions = buildEmptyFusionStreamContributions();
  const fusedScore = accumulateFusionContributions(
    candidate,
    supplementaryData,
    resolved,
    ranksByStream,
    scoresByStream,
    candidateKey,
    perStreamRank,
    contributions,
    embeddingPoolMax,
    axisContext
  );
  const axisRank = axisContext?.axisRankByKey.get(candidateKey);
  const axisRa = axisContext?.raByKey.get(candidateKey);
  return Object.freeze({
    candidateKey,
    objectId: candidate.entry.object_id,
    objectKind: candidate.objectKind ?? "memory_entry",
    originPlane: candidate.originPlane ?? "workspace_local",
    entry: candidate.entry,
    effectiveScore: candidate.effectiveScore,
    perStreamRank: Object.freeze(perStreamRank) as RecallFusionStreamRanks,
    contributions: Object.freeze(contributions) as RecallFusionStreamContributions,
    fusedScore,
    // Four-axis assembly supersedes the facet slice (mutually exclusive ordering).
    facetOverlapCount: facetSliceEnabled() && !fourAxisAssemblyEnabled()
      ? facetOverlapCountFor(candidate.entry, supplementaryData.querySoughtFacets)
      : 0,
    ...(axisRank !== undefined ? { axisRank } : {}),
    ...(axisRa !== undefined ? { axisRa } : {})
  });
}


function buildFusedRankByCandidateKey(
  prelim: readonly PreliminaryFusionCandidate[]
): ReadonlyMap<string, number> {
  const ranked = [...prelim].sort((left, right) => {
    const facetDelta = right.facetOverlapCount - left.facetOverlapCount;
    if (facetDelta !== 0) {
      return facetDelta;
    }
    const fusionDelta = right.fusedScore - left.fusedScore;
    if (fusionDelta !== 0) {
      return fusionDelta;
    }
    const axisDelta = compareConformantAxisRa(left.axisRa, right.axisRa);
    if (axisDelta !== 0) {
      return axisDelta;
    }
    const effectiveDelta = right.effectiveScore - left.effectiveScore;
    if (effectiveDelta !== 0) {
      return effectiveDelta;
    }
    return compareMemoryEntries(left.entry, right.entry);
  });
  return new Map(ranked.map((candidate, index) => [candidate.candidateKey, index + 1] as const));
}

function finalizeRecallFusionDetails(
  prelim: readonly PreliminaryFusionCandidate[],
  fusedRankByCandidateKey: ReadonlyMap<string, number>
): ReadonlyMap<string, RecallFusionBreakdown> {
  return Object.freeze(
    new Map(
      prelim.map((candidate) => [
        candidate.candidateKey,
        Object.freeze({
          candidate_key: candidate.candidateKey,
          object_id: candidate.objectId,
          object_kind: candidate.objectKind,
          origin_plane: candidate.originPlane,
          per_stream_rank: candidate.perStreamRank,
          fused_rank: fusedRankByCandidateKey.get(candidate.candidateKey) ?? Number.MAX_SAFE_INTEGER,
          fused_score: candidate.fusedScore,
          fused_rank_contribution_per_stream: candidate.contributions,
          ...(candidate.axisRank !== undefined ? { per_axis_rank: candidate.axisRank } : {}),
          ...(candidate.axisRa !== undefined ? { per_axis_contribution: candidate.axisRa } : {})
        })
      ] as const)
    )
  );
}


export function compareFusedRecallCandidates(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  if (facetSliceEnabled() && !fourAxisAssemblyEnabled()) {
    // fused_rank already carries the slice; follow it so delivery (not just diagnostics) is sliced.
    const rankDelta = left.fusion.fused_rank - right.fusion.fused_rank;
    if (rankDelta !== 0) {
      return rankDelta;
    }
  }
  const fusionDelta = right.fusion.fused_score - left.fusion.fused_score;
  if (fusionDelta !== 0) {
    return fusionDelta;
  }
  const axisDelta = compareConformantAxisRa(left.fusion.per_axis_contribution, right.fusion.per_axis_contribution);
  if (axisDelta !== 0) {
    return axisDelta;
  }
  const effectiveDelta = right.effectiveScore - left.effectiveScore;
  if (effectiveDelta !== 0) {
    return effectiveDelta;
  }
  return compareMemoryEntries(left.entry, right.entry);
}

export function buildEmptyRecallFusionBreakdown(objectId: string): Readonly<RecallFusionBreakdown> {
  return Object.freeze({
    candidate_key: `workspace_local:memory_entry:${objectId}`,
    object_id: objectId,
    object_kind: "memory_entry",
    origin_plane: "workspace_local",
    per_stream_rank: Object.freeze(buildEmptyFusionStreamRanks()) as RecallFusionStreamRanks,
    fused_rank: Number.MAX_SAFE_INTEGER,
    fused_score: 0,
    fused_rank_contribution_per_stream: Object.freeze(buildEmptyFusionStreamContributions()) as RecallFusionStreamContributions
  });
}

function buildEmptyFusionStreamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(activeFusionStreams().map((stream) => [stream, null])) as Record<RecallFusionStream, number | null>;
}

function buildEmptyFusionStreamContributions(): Record<RecallFusionStream, number> {
  return Object.fromEntries(activeFusionStreams().map((stream) => [stream, 0])) as Record<RecallFusionStream, number>;
}
export { scoreTemporalFusion } from "./fusion-delivery-scoring-streams.js";
