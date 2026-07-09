import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  buildRecallCandidateDedupeKey,
  compareMemoryEntries
} from "../runtime/recall-service-helpers.js";
import {
  resolveFusionContribution as resolveAdaptiveFusionContribution,
  resolveRrfFusionWeights,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import {
  buildConformantAxisContext,
  compareConformantAxisRa,
  type ConformantAxisContext
} from "../scoring/conformant-fusion-scoring.js";
import {
  buildFloodFuelCoverageSummary,
  computeIntegratedFloodScore
} from "../scoring/integrated-flood-scoring.js";
import {
  activeFusionStreams,
  facetOverlapCountFor,
  RECALL_FUSION_DEFAULT_WEIGHTS
} from "./fusion-delivery-streams.js";
import type {
  RecallFusionCandidateInput,
  FusedRecallCandidateInput,
  PreliminaryFusionCandidate
} from "./fusion-delivery-scoring-candidate.js";
import { scoreRecallFusionStream } from "./fusion-delivery-scoring-streams.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData,
  IntegratedFloodCandidateDiagnostics
} from "../runtime/recall-service-types.js";

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
  const axisContext = buildConformantAxisContext({
    candidates: params.candidates.map((candidate) => ({
      candidateKey: buildRecallCandidateDedupeKey(candidate),
      candidate
    })),
    ranksByStream,
    resolved,
    supplementaryData: params.supplementaryData,
    nowIso: params.nowIso
  });
  const prelim = buildPreliminaryFusionCandidates(params, resolved, ranksByStream, axisContext);
  const fusedRankByCandidateKey = buildFusedRankByCandidateKey(prelim);
  return finalizeRecallFusionDetails(prelim, fusedRankByCandidateKey, params.supplementaryData);
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
        ? Math.min(
          breakdown.fused_score,
          Math.max(PATH_SUPPRESSION_RESIDUAL_FLOOR, breakdown.fused_score - delta)
        )
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

function buildPreliminaryFusionCandidates(
  params: Readonly<{
    readonly candidates: readonly RecallFusionCandidateInput[];
    readonly supplementaryData: RecallSupplementaryData;
  }>,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  axisContext: ConformantAxisContext
): readonly PreliminaryFusionCandidate[] {
  return params.candidates.map((candidate) =>
    buildPreliminaryFusionCandidate(candidate, params.supplementaryData, resolved, ranksByStream, axisContext)
  );
}

function buildPreliminaryFusionCandidate(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  axisContext: ConformantAxisContext
): PreliminaryFusionCandidate {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const perStreamRank = buildEmptyFusionStreamRanks();
  const contributions = buildEmptyFusionStreamContributions();
  const fused = scoreIntegratedFusionCandidate({
    candidate,
    supplementaryData,
    resolved,
    ranksByStream,
    candidateKey,
    perStreamRank,
    contributions,
    axisContext
  });
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
    fusedScore: fused.score,
    facetOverlapCount: facetOverlapCountFor(candidate.entry, supplementaryData.querySoughtFacets),
    floodPotential: fused.diagnostics,
    ...(axisRank !== undefined ? { axisRank } : {}),
    ...(axisRa !== undefined ? { axisRa } : {})
  });
}

function scoreIntegratedFusionCandidate(params: Readonly<{
  readonly candidate: RecallFusionCandidateInput;
  readonly supplementaryData: RecallSupplementaryData;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>;
  readonly candidateKey: string;
  readonly perStreamRank: Record<RecallFusionStream, number | null>;
  readonly contributions: Record<RecallFusionStream, number>;
  readonly axisContext: ConformantAxisContext;
}>): Readonly<{ readonly score: number; readonly diagnostics: IntegratedFloodCandidateDiagnostics }> {
  for (const stream of activeFusionStreams()) {
    const rank = params.ranksByStream.get(stream)?.get(params.candidateKey) ?? null;
    params.perStreamRank[stream] = rank;
    if (rank !== null) {
      params.contributions[stream] = resolveAdaptiveFusionContribution({
        candidate: params.candidate,
        supplementaryData: params.supplementaryData,
        resolved: params.resolved,
        stream,
        rank
      });
    }
  }
  const ra = params.axisContext.raByKey.get(params.candidateKey);
  return computeIntegratedFloodScore({
    entry: params.candidate.entry,
    axisInputs: {
      R_obj: ra?.object ?? 0,
      A_path: ra?.path ?? 0,
      B_evidence: ra?.evidence ?? 0
    },
    supplementaryData: params.supplementaryData
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
  fusedRankByCandidateKey: ReadonlyMap<string, number>,
  _supplementaryData: RecallSupplementaryData
): ReadonlyMap<string, RecallFusionBreakdown> {
  const fuelCoverage = buildFloodFuelCoverageSummary(
    prelim.map((candidate) => candidate.floodPotential).filter((row) => row !== undefined)
  );
  return Object.freeze(
    new Map(
      prelim.map((candidate) => [
        candidate.candidateKey,
        Object.freeze({
          candidate_key: candidate.candidateKey,
          object_id: candidate.objectId,
          object_kind: candidate.objectKind,
          origin_plane: candidate.originPlane,
          facet_overlap: candidate.facetOverlapCount,
          per_stream_rank: candidate.perStreamRank,
          fused_rank: fusedRankByCandidateKey.get(candidate.candidateKey) ?? Number.MAX_SAFE_INTEGER,
          fused_score: candidate.fusedScore,
          fused_rank_contribution_per_stream: candidate.contributions,
          ...(candidate.axisRank !== undefined ? { per_axis_rank: candidate.axisRank } : {}),
          ...(candidate.axisRa !== undefined ? { per_axis_contribution: candidate.axisRa } : {}),
          ...(candidate.floodPotential !== undefined ? { flood_potential: candidate.floodPotential } : {}),
          ...(prelim.length > 0 ? { flood_fuel_coverage: fuelCoverage } : {})
        })
      ] as const)
    )
  );
}


export function compareFusedRecallCandidates(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  const rankDelta = left.fusion.fused_rank - right.fusion.fused_rank;
  if (rankDelta !== 0) {
    return rankDelta;
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
    facet_overlap: 0,
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
