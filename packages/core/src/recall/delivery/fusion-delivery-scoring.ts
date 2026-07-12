import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { compareMemoryEntries } from "../runtime/recall-service-helpers.js";
import {
  resolveRrfFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import {
  buildConformantAxisContext,
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
  KeyedRecallFusionCandidate,
  RecallFusionCandidateStreamSnapshot,
  PreliminaryFusionCandidate
} from "./fusion-delivery-scoring-candidate.js";
import {
  buildFusionCandidateStreamSnapshots,
  keyRecallFusionCandidates
} from "./fusion-delivery-scoring-snapshot.js";
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
  const keyedCandidates = keyRecallFusionCandidates(params.candidates);
  const ranksByStream = buildFusionRanksByStream(keyedCandidates, params.supplementaryData, params.nowIso);
  const streamSnapshots = buildFusionCandidateStreamSnapshots({
    candidates: keyedCandidates,
    ranksByStream,
    resolved,
    supplementaryData: params.supplementaryData
  });
  const axisContext = buildConformantAxisContext({
    candidates: streamSnapshots,
    ranksByStream,
    resolved,
    supplementaryData: params.supplementaryData,
    nowIso: params.nowIso
  });
  const prelim = buildPreliminaryFusionCandidates(streamSnapshots, params.supplementaryData, axisContext);
  const fusedRankByCandidateKey = buildFusedRankByCandidateKey(prelim);
  return finalizeRecallFusionDetails(prelim, fusedRankByCandidateKey, params.supplementaryData);
}

// invariant: path suppression changes the fused scalar before rank is derived.
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
    return left.breakdown.candidate_key.localeCompare(right.breakdown.candidate_key);
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
  candidates: readonly KeyedRecallFusionCandidate[],
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
  candidates: readonly KeyedRecallFusionCandidate[],
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): ReadonlyMap<string, number> {
  const scored = candidates
    .map(({ candidateKey, candidate }) => Object.freeze({
      candidateKey,
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
  candidates: readonly RecallFusionCandidateStreamSnapshot[],
  supplementaryData: RecallSupplementaryData,
  axisContext: ConformantAxisContext
): readonly PreliminaryFusionCandidate[] {
  return candidates.map((candidate) =>
    buildPreliminaryFusionCandidate(candidate, supplementaryData, axisContext)
  );
}

function buildPreliminaryFusionCandidate(
  snapshot: RecallFusionCandidateStreamSnapshot,
  supplementaryData: RecallSupplementaryData,
  axisContext: ConformantAxisContext
): PreliminaryFusionCandidate {
  const { candidateKey, candidate, perStreamRank, contributions } = snapshot;
  const fused = scoreIntegratedFusionCandidate({
    candidate,
    supplementaryData,
    candidateKey,
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
    perStreamRank,
    contributions,
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
  readonly candidateKey: string;
  readonly axisContext: ConformantAxisContext;
}>): Readonly<{ readonly score: number; readonly diagnostics: IntegratedFloodCandidateDiagnostics }> {
  const ra = params.axisContext.raByKey.get(params.candidateKey);
  const scored = computeIntegratedFloodScore({
    entry: params.candidate.entry,
    axisInputs: {
      R_obj: ra?.object ?? 0,
      A_path: ra?.path ?? 0,
      B_evidence: ra?.evidence ?? 0
    },
    supplementaryData: params.supplementaryData
  });
  const trace = params.axisContext.edgeTraceByKey.get(params.candidateKey);
  if (trace === undefined) {
    return scored;
  }
  return Object.freeze({
    score: scored.score,
    diagnostics: Object.freeze({
      ...scored.diagnostics,
      edge_traces: trace.traces,
      edge_trace_truncated_count: trace.truncatedCount
    })
  });
}

function buildFusedRankByCandidateKey(
  prelim: readonly PreliminaryFusionCandidate[]
): ReadonlyMap<string, number> {
  const ranked = [...prelim].sort((left, right) => {
    const fusionDelta = right.fusedScore - left.fusedScore;
    if (fusionDelta !== 0) {
      return fusionDelta;
    }
    return left.candidateKey.localeCompare(right.candidateKey);
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
  const fusionDelta = right.fusion.fused_score - left.fusion.fused_score;
  if (fusionDelta !== 0) {
    return fusionDelta;
  }
  return left.fusion.candidate_key.localeCompare(right.fusion.candidate_key);
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
