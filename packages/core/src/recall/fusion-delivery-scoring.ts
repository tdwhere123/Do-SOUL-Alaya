import type {
  MemoryEntry,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
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
  normalizeEvidenceText} from "./query-evidence-scoring.js";

const PATH_SUPPRESSION_RESIDUAL_FLOOR = 1e-4;
const EMBEDDING_PATH_MODULATION_GAIN = 0.25;
const RECALL_RRF_DEFAULT_K = 60;

export const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts",
  "evidence_structural_agreement", "source_proximity", "source_evidence_agreement", "subject_alignment",
  "structural", "existing_score", "embedding_similarity", "graph_expansion",
  "entity_seed", "path_expansion", "temporal_recency", "workspace_activation"
];

const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 3, trigram_fts: 1, synthesis_fts: 1, evidence_fts: 3,
  evidence_structural_agreement: 6, source_proximity: 1, source_evidence_agreement: 1, subject_alignment: 1,
  structural: 1, existing_score: 1, embedding_similarity: 1, graph_expansion: 3,
  entity_seed: 1, path_expansion: 3, temporal_recency: 0, workspace_activation: 0
});

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

type ResolvedRecallFusionWeights = Readonly<{
  readonly k: number;
  readonly weights: Readonly<Record<RecallFusionStream, number>>;
}>;

type PreliminaryFusionCandidate = Readonly<{
  readonly candidateKey: string;
  readonly objectId: string;
  readonly objectKind: RecallFusionBreakdown["object_kind"];
  readonly originPlane: RecallFusionBreakdown["origin_plane"];
  readonly entry: Readonly<MemoryEntry>;
  readonly effectiveScore: number;
  readonly perStreamRank: RecallFusionStreamRanks;
  readonly contributions: RecallFusionStreamContributions;
  readonly fusedScore: number;
}>;

export function buildRecallFusionDetails(params: Readonly<{
  readonly candidates: readonly RecallFusionCandidateInput[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
}>): ReadonlyMap<string, RecallFusionBreakdown> {
  const resolved = resolveRrfFusionWeights(params.policy);
  const ranksByStream = buildFusionRanksByStream(params.candidates, params.supplementaryData, params.nowIso);
  const prelim = buildPreliminaryFusionCandidates(params, resolved, ranksByStream);
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

function scoreRecallFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): number {
  if (candidate.objectKind === "synthesis_capsule") {
    return scoreSynthesisCapsuleFusionStream(candidate, stream, supplementaryData);
  }
  if (candidate.originPlane === "global") {
    return scoreGlobalFusionStream(candidate, stream, supplementaryData, nowIso);
  }
  return scoreWorkspaceLocalFusionStream(candidate, stream, supplementaryData, nowIso);
}

function buildFusionRanksByStream(
  candidates: readonly RecallFusionCandidateInput[],
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>> {
  const ranksByStream = new Map<RecallFusionStream, ReadonlyMap<string, number>>();
  for (const stream of RECALL_FUSION_STREAMS) {
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
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>
): readonly PreliminaryFusionCandidate[] {
  return params.candidates.map((candidate) =>
    buildPreliminaryFusionCandidate(candidate, params.supplementaryData, resolved, ranksByStream)
  );
}

function buildPreliminaryFusionCandidate(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>
): PreliminaryFusionCandidate {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const perStreamRank = buildEmptyFusionStreamRanks();
  const contributions = buildEmptyFusionStreamContributions();
  const fusedScore = accumulateFusionContributions(
    candidate,
    supplementaryData,
    resolved,
    ranksByStream,
    candidateKey,
    perStreamRank,
    contributions
  );
  return Object.freeze({
    candidateKey,
    objectId: candidate.entry.object_id,
    objectKind: candidate.objectKind ?? "memory_entry",
    originPlane: candidate.originPlane ?? "workspace_local",
    entry: candidate.entry,
    effectiveScore: candidate.effectiveScore,
    perStreamRank: Object.freeze(perStreamRank) as RecallFusionStreamRanks,
    contributions: Object.freeze(contributions) as RecallFusionStreamContributions,
    fusedScore
  });
}

function accumulateFusionContributions(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>
): number {
  let fusedScore = 0;
  for (const stream of RECALL_FUSION_STREAMS) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const contribution = resolveFusionContribution(
      candidate,
      supplementaryData,
      resolved,
      stream,
      rank
    );
    contributions[stream] = contribution;
    fusedScore += contribution;
  }
  return fusedScore;
}

function resolveFusionContribution(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  stream: RecallFusionStream,
  rank: number
): number {
  let contribution = resolved.weights[stream] / (resolved.k + rank);
  if (stream === "path_expansion" || stream === "graph_expansion") {
    const cos = clamp01(supplementaryData.embeddingSimilarityScores?.[candidate.entry.object_id] ?? 0.5);
    const modulation = 1 + EMBEDDING_PATH_MODULATION_GAIN * Math.max(0, 2 * cos - 1);
    contribution *= modulation;
  }
  return contribution;
}

function buildFusedRankByCandidateKey(
  prelim: readonly PreliminaryFusionCandidate[]
): ReadonlyMap<string, number> {
  const ranked = [...prelim].sort((left, right) => {
    const fusionDelta = right.fusedScore - left.fusedScore;
    if (fusionDelta !== 0) {
      return fusionDelta;
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
          fused_rank_contribution_per_stream: candidate.contributions
        })
      ] as const)
    )
  );
}

function scoreSynthesisCapsuleFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData
): number {
  return stream === "synthesis_fts" ? clamp01(supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0) : 0;
}

function scoreGlobalFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): number {
  switch (stream) {
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(candidate.structuralScore ?? 0);
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return clamp01(candidate.effectiveFactors.embedding_similarity ?? 0);
    case "temporal_recency":
      return scoreTemporalRecency(candidate.entry, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
    default:
      return 0;
  }
}

function scoreWorkspaceLocalFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): number {
  const objectId = candidate.entry.object_id;
  switch (stream) {
    case "lexical_fts":
      return clamp01(supplementaryData.ftsRanks[objectId] ?? 0);
    case "trigram_fts":
      return clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0);
    case "synthesis_fts":
      return 0;
    case "evidence_fts":
      return clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
    case "evidence_structural_agreement":
      return scoreEvidenceStructuralAgreement(candidate, supplementaryData);
    case "source_proximity":
      return clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
    case "source_evidence_agreement":
      return scoreSourceEvidenceAgreement(candidate, supplementaryData);
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0);
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return clamp01(candidate.effectiveFactors.embedding_similarity ?? 0);
    case "graph_expansion":
      return clamp01(Math.max(
        supplementaryData.graphExpansionScores[objectId] ?? 0,
        normalizeGraphSupport(supplementaryData.graphSupportCounts[objectId] ?? 0)
      ));
    case "entity_seed":
      return clamp01(supplementaryData.entitySeedScores[objectId] ?? 0);
    case "path_expansion":
      return clamp01(supplementaryData.pathExpansionScores[objectId] ?? 0);
    case "temporal_recency":
      return scoreTemporalRecency(candidate.entry, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
  }
}

function scoreEvidenceStructuralAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const structuralScore = clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0);
  if (evidenceScore <= 0 || structuralScore <= 0) {
    return 0;
  }
  return Math.sqrt(evidenceScore * structuralScore) + Math.min(evidenceScore, structuralScore) * 0.1;
}

function scoreSourceEvidenceAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const sourceScore = clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
  if (evidenceScore <= 0 || sourceScore <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(evidenceScore * sourceScore) + Math.min(evidenceScore, sourceScore) * 0.1);
}

function scoreSubjectAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!queryProbes.subject_hints.includes("self_reference")) return 0;
  const content = normalizeEvidenceText(entry.content);
  if (content.length === 0) return 0;
  const explicitSelf = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(content);
  const userFramed = /\b(?:the user|user|operator|principal)\b/iu.test(content);
  if (!explicitSelf && !userFramed) return 0;
  const genericAssistant =
    /\b(?:as an ai|i (?:do not|don't) have|i can help|here are|you can|you could|you should|there are many|some suggestions|popular (?:ones|options))\b/iu.test(content);
  const baseScore = explicitSelf ? 1 : 0.55;
  return clamp01(genericAssistant ? baseScore * 0.25 : baseScore);
}

export function compareFusedRecallCandidates(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  const fusionDelta = right.fusion.fused_score - left.fusion.fused_score;
  if (fusionDelta !== 0) {
    return fusionDelta;
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
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, null])) as Record<RecallFusionStream, number | null>;
}

function buildEmptyFusionStreamContributions(): Record<RecallFusionStream, number> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, 0])) as Record<RecallFusionStream, number>;
}

function resolveRrfFusionWeights(
  policy: Readonly<RecallPolicy>
): ResolvedRecallFusionWeights {
  const base = RECALL_FUSION_DEFAULT_WEIGHTS;
  const overrides = policy.scoring_weight_overrides?.fusion_weights;
  const kOverride = overrides?.RRF_K ?? overrides?.rrf_k;
  const k = typeof kOverride === "number" && Number.isFinite(kOverride) && kOverride > 0
    ? Math.trunc(kOverride)
    : RECALL_RRF_DEFAULT_K;
  const weights = Object.fromEntries(
    RECALL_FUSION_STREAMS.map((stream) => {
      const baseWeight = base[stream];
      return [stream, Math.max(0, overrides?.[stream] ?? baseWeight)];
    })
  ) as Record<RecallFusionStream, number>;
  return Object.freeze({
    k: Math.max(1, k),
    weights: Object.freeze(weights)
  });
}

function scoreTemporalRecency(entry: Readonly<MemoryEntry>, nowIso: string): number {
  const createdAtMs = Date.parse(entry.created_at);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);
  return clamp01(1 - ageDays / 30);
}
