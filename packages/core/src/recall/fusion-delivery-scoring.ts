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
import {
  resolveFusionContribution as resolveAdaptiveFusionContribution,
  resolveRrfFusionWeights,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import {
  bestEvidenceEnabled,
  cappedLexicalFloodSum,
  combineBestEvidenceFamilies,
  decorrelateFamily,
  floodFusionEnabled,
  floodGovernanceEnabled,
  isLexicalFamilyFloodStream,
  resolveBestEvidenceRelevance,
  resolveFloodFusionContribution,
  streamFamily,
  synthesisFusionEnabled,
  synthesisGateFloor,
  synthesisDecorrLambda,
  synthesisIntentGated,
  type FloodStreamScores
} from "./flood-fusion-scoring.js";
import { classifyRecallIntent } from "./recall-query-plan.js";
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
import { scorePreferenceProfileAlignment } from "./preference-fusion-scoring.js";
import { scoreTemporalEventTime } from "./temporal-fusion-scoring.js";

const PATH_SUPPRESSION_RESIDUAL_FLOOR = 1e-4;

export const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts", "trigram_fts", "synthesis_fts", "evidence_fts",
  "evidence_structural_agreement", "source_proximity", "source_evidence_agreement", "subject_alignment",
  "structural", "existing_score", "embedding_similarity", "graph_expansion",
  "entity_seed", "path_expansion", "temporal_recency", "workspace_activation",
  "facet_overlap"
];

const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 3, trigram_fts: 1, synthesis_fts: 1, evidence_fts: 3,
  evidence_structural_agreement: 6, source_proximity: 1, source_evidence_agreement: 1, subject_alignment: 1,
  structural: 1, existing_score: 1, embedding_similarity: 12, graph_expansion: 3,
  entity_seed: 1, path_expansion: 3, temporal_recency: 0, workspace_activation: 0,
  facet_overlap: 4
});

// Opt-in (ALAYA_RECALL_FACET_OVERLAP): scores candidates by query-sought facet coverage. Off → stream excluded so breakdowns stay byte-identical.
export function facetOverlapEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_FACET_OVERLAP;
  return raw === "on" || raw === "1" || raw === "true";
}

// Slice mode (with FACET_OVERLAP on): facet-overlap count is the primary rank key, fused score breaks ties — slice-then-rank, not an additive vote.
function facetSliceEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_FACET_SLICE;
  return raw === "on" || raw === "1" || raw === "true";
}

function facetOverlapCountFor(
  entry: Readonly<MemoryEntry>,
  querySoughtFacets: readonly string[] | undefined
): number {
  if (querySoughtFacets === undefined || querySoughtFacets.length === 0) {
    return 0;
  }
  const sought = new Set(querySoughtFacets);
  const matched = new Set<string>();
  for (const tag of entry.facet_tags ?? []) {
    if (sought.has(tag.facet)) {
      matched.add(tag.facet);
    }
  }
  return matched.size;
}

export function activeFusionStreams(): readonly RecallFusionStream[] {
  return facetOverlapEnabled()
    ? RECALL_FUSION_STREAMS
    : RECALL_FUSION_STREAMS.filter((stream) => stream !== "facet_overlap");
}

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
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
  readonly facetOverlapCount: number;
}>;

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
  const prelim = buildPreliminaryFusionCandidates(params, resolved, ranksByStream, scoresByStream);
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
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null
): readonly PreliminaryFusionCandidate[] {
  return params.candidates.map((candidate) =>
    buildPreliminaryFusionCandidate(candidate, params.supplementaryData, resolved, ranksByStream, scoresByStream)
  );
}

function buildPreliminaryFusionCandidate(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null
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
    fusedScore,
    facetOverlapCount: facetSliceEnabled()
      ? facetOverlapCountFor(candidate.entry, supplementaryData.querySoughtFacets)
      : 0
  });
}

function accumulateFusionContributions(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  scoresByStream: ReadonlyMap<RecallFusionStream, FloodStreamScores> | null,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>
): number {
  if (synthesisFusionEnabled()) {
    return accumulateSynthesisFusedScore(
      candidate, supplementaryData, resolved, ranksByStream, candidateKey, perStreamRank, contributions
    );
  }
  if (scoresByStream !== null && bestEvidenceEnabled()) {
    return accumulateBestEvidenceFusedScore(
      candidate, supplementaryData, resolved, ranksByStream, scoresByStream, candidateKey, perStreamRank, contributions
    );
  }
  const governance = scoresByStream !== null && floodGovernanceEnabled();
  let fusedScore = 0;
  let lexicalFamilySum = 0;
  let lexicalFamilyMax = 0;
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const contribution = scoresByStream === null
      ? resolveFusionContribution(candidate, supplementaryData, resolved, stream, rank)
      : resolveFloodContribution(candidate, supplementaryData, resolved, scoresByStream, stream, candidateKey);
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

// Best-evidence combine: per-stream relevance (reliability·norm), grouped into families (max within),
// confidence-weighted noisy-OR across families. Lets a minority-strong lens surface without additive weight.
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

// Object-axis correction on the RRF cross-section: de-correlate the correlated lexical surface views
// into one relevance, then (for answer-relation intents) gate that surface relevance by embedding
// agreement. Non-gated intents return the plain additive RRF sum (byte-identical to the baseline path).
function accumulateSynthesisFusedScore(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  resolved: ResolvedRecallFusionWeights,
  ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>,
  candidateKey: string,
  perStreamRank: Record<RecallFusionStream, number | null>,
  contributions: Record<RecallFusionStream, number>
): number {
  const gated = synthesisIntentGated(classifyRecallIntent(supplementaryData.queryProbes));
  const lexicalContributions: number[] = [];
  let otherSum = 0;
  for (const stream of activeFusionStreams()) {
    const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
    perStreamRank[stream] = rank;
    if (rank === null) {
      continue;
    }
    const contribution = resolveFusionContribution(candidate, supplementaryData, resolved, stream, rank);
    contributions[stream] = contribution;
    if (streamFamily(stream) === "lexical") {
      lexicalContributions.push(contribution);
    } else {
      otherSum += contribution;
    }
  }
  if (!gated) {
    return lexicalContributions.reduce((sum, value) => sum + value, 0) + otherSum;
  }
  const decorrelatedLexical = decorrelateFamily(lexicalContributions, synthesisDecorrLambda());
  const embeddingSimilarity = candidate.effectiveFactors.embedding_similarity;
  const gatedLexical = typeof embeddingSimilarity === "number" && embeddingSimilarity > 0
    ? decorrelatedLexical * (synthesisGateFloor() + (1 - synthesisGateFloor()) * clamp01(embeddingSimilarity))
    : decorrelatedLexical;
  return gatedLexical + otherSum;
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
      return scoreTemporalEventTime(candidate.entry, nowIso);
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
      return candidate.sourceChannels?.includes("synthesis_child") === true
        ? clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0)
        : 0;
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
      return scoreTemporalEventTime(candidate.entry, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
    case "facet_overlap":
      return scoreFacetOverlap(candidate.entry, supplementaryData.querySoughtFacets);
  }
}

function scoreFacetOverlap(
  entry: Readonly<MemoryEntry>,
  querySoughtFacets: readonly string[] | undefined
): number {
  if (querySoughtFacets === undefined || querySoughtFacets.length === 0) {
    return 0;
  }
  const sought = new Set(querySoughtFacets);
  const matched = new Set<string>();
  for (const tag of entry.facet_tags ?? []) {
    if (sought.has(tag.facet)) {
      matched.add(tag.facet);
    }
  }
  return matched.size;
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
  const preferenceScore = scorePreferenceProfileAlignment(entry, queryProbes);
  if (!queryProbes.subject_hints.includes("self_reference")) return preferenceScore;
  const content = normalizeEvidenceText(entry.content);
  if (content.length === 0) return preferenceScore;
  const explicitSelf = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(content);
  const userFramed = /\b(?:the user|user|operator|principal)\b/iu.test(content);
  if (!explicitSelf && !userFramed) return preferenceScore;
  const genericAssistant =
    /\b(?:as an ai|i (?:do not|don't) have|i can help|here are|you can|you could|you should|there are many|some suggestions|popular (?:ones|options))\b/iu.test(content);
  const baseScore = explicitSelf ? 1 : 0.55;
  return Math.max(preferenceScore, clamp01(genericAssistant ? baseScore * 0.25 : baseScore));
}

export function compareFusedRecallCandidates(
  left: FusedRecallCandidateInput,
  right: FusedRecallCandidateInput
): number {
  if (facetSliceEnabled()) {
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
