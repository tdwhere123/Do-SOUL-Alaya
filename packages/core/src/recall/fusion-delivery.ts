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

const STRONG_LEXICAL_DELIVERY_RANK = 0.85;
const PATH_SUPPRESSION_RESIDUAL_FLOOR = 1e-4;
const EMBEDDING_PATH_MODULATION_GAIN = 0.25;
const RECALL_RRF_DEFAULT_K = 60;

export const RECALL_FUSION_STREAMS: readonly RecallFusionStream[] = [
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "entity_seed",
  "path_expansion",
  "temporal_recency",
  "workspace_activation"
];

const RECALL_FUSION_DEFAULT_WEIGHTS: Readonly<Record<RecallFusionStream, number>> = Object.freeze({
  lexical_fts: 3,
  trigram_fts: 1,
  synthesis_fts: 1,
  evidence_fts: 3,
  evidence_structural_agreement: 6,
  source_proximity: 1,
  source_evidence_agreement: 1,
  subject_alignment: 1,
  structural: 1,
  existing_score: 1,
  embedding_similarity: 1,
  graph_expansion: 3,
  entity_seed: 1,
  path_expansion: 3,
  temporal_recency: 0,
  workspace_activation: 0
});

const SYNTHESIS_ANCHOR_BONUS = 0.1;

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

export function buildRecallFusionDetails(params: Readonly<{
  readonly candidates: readonly RecallFusionCandidateInput[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly nowIso: string;
}>): ReadonlyMap<string, RecallFusionBreakdown> {
  const resolved = resolveRrfFusionWeights(params.policy);
  const ranksByStream = new Map<RecallFusionStream, ReadonlyMap<string, number>>();

  for (const stream of RECALL_FUSION_STREAMS) {
    const scored = params.candidates
      .map((candidate) => Object.freeze({
        candidateKey: buildRecallCandidateDedupeKey(candidate),
        objectId: candidate.entry.object_id,
        entry: candidate.entry,
        score: scoreRecallFusionStream(candidate, stream, params.supplementaryData, params.nowIso)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      );
    ranksByStream.set(
      stream,
      Object.freeze(new Map(scored.map((candidate, index) => [candidate.candidateKey, index + 1] as const)))
    );
  }

  const prelim = params.candidates.map((candidate) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const perStreamRank = buildEmptyFusionStreamRanks();
    const contributions = buildEmptyFusionStreamContributions();
    let fusedScore = 0;
    for (const stream of RECALL_FUSION_STREAMS) {
      const rank = ranksByStream.get(stream)?.get(candidateKey) ?? null;
      perStreamRank[stream] = rank;
      if (rank !== null) {
        let contribution = resolved.weights[stream] / (resolved.k + rank);
        // invariant: embedding path modulation is boost-only; missing or neutral cosine leaves graph/path fusion byte-identical.
        if (stream === "path_expansion" || stream === "graph_expansion") {
          // invariant: modulation reuses the precomputed query cosine and never starts a model pass.
          const cos = clamp01(params.supplementaryData.embeddingSimilarityScores?.[candidate.entry.object_id] ?? 0.5);
          const m = 1 + EMBEDDING_PATH_MODULATION_GAIN * Math.max(0, 2 * cos - 1);
          contribution *= m;
        }
        contributions[stream] = contribution;
        fusedScore += contribution;
      }
    }
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
  });

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
  const fusedRankByCandidateKey = new Map(ranked.map((candidate, index) => [candidate.candidateKey, index + 1] as const));

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

// invariant: path suppression demotes fused_score and re-ranks without adding diagnostics keys or dropping positive-score candidates.
// see also: packages/core/src/recall/recall-service.ts:collectNegativePathSuppressions,
// packages/core/src/recall/path-relations.ts:scorePathRelationSuppression,
// apps/bench-runner/src/harness/recall-diagnostics-schema.ts:BenchRecallDiagnosticsSchema.
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
    // invariant: demote, never erase. Floor the residual at
    // PATH_SUPPRESSION_RESIDUAL_FLOOR only for candidates whose pre-suppression
    // fused_score was already positive, so a fully-suppressed memory stays a
    // tail candidate. Candidates already at 0 are not lifted.
    const fusedScore =
      delta > 0 && breakdown.fused_score > 0
        ? Math.max(PATH_SUPPRESSION_RESIDUAL_FLOOR, breakdown.fused_score - delta)
        : breakdown.fused_score;
    return { breakdown, fusedScore };
  });
  // invariant: equal suppressed scores keep original fused_rank ordering.
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
  const objectId = candidate.entry.object_id;
  const isGlobalCandidate = candidate.originPlane === "global";
  // invariant: synthesis_capsule candidates score ONLY on synthesis_fts —
  // their dimension/source_kind/created_at are faked pseudo-memory_entry
  // fields, so any other stream is fail-closed for them here.
  // see also: packages/core/src/recall/recall-candidate-builder.ts:buildSynthesisCoarseRecallCandidate
  if (candidate.objectKind === "synthesis_capsule") {
    return stream === "synthesis_fts"
      ? clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0)
      : 0;
  }
  switch (stream) {
    case "lexical_fts":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.ftsRanks[objectId] ?? 0);
    case "trigram_fts":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0);
    case "synthesis_fts":
      return 0;
    case "evidence_fts":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
    case "evidence_structural_agreement":
      if (isGlobalCandidate) {
        return 0;
      }
      return scoreEvidenceStructuralAgreement(candidate, supplementaryData);
    case "source_proximity":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
    case "source_evidence_agreement":
      if (isGlobalCandidate) {
        return 0;
      }
      return scoreSourceEvidenceAgreement(candidate, supplementaryData);
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(
        candidate.structuralScore ?? (isGlobalCandidate ? 0 : supplementaryData.structuralScores[objectId] ?? 0)
      );
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return clamp01(candidate.effectiveFactors.embedding_similarity ?? 0);
    case "graph_expansion":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(Math.max(
        supplementaryData.graphExpansionScores[objectId] ?? 0,
        normalizeGraphSupport(supplementaryData.graphSupportCounts[objectId] ?? 0)
      ));
    case "entity_seed":
      if (isGlobalCandidate) {
        return 0;
      }
      return clamp01(supplementaryData.entitySeedScores[objectId] ?? 0);
    case "path_expansion":
      if (isGlobalCandidate) {
        return 0;
      }
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
  if (!queryProbes.subject_hints.includes("self_reference")) {
    return 0;
  }

  const content = normalizeEvidenceText(entry.content);
  if (content.length === 0) {
    return 0;
  }

  const explicitSelf = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(content);
  const userFramed = /\b(?:the user|user|operator|principal)\b/iu.test(content);
  if (!explicitSelf && !userFramed) {
    return 0;
  }

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

// invariant: synthesis reserve spends bounded tail slots only on capsules whose evidence_refs are uncovered by the delivery window.
const SYNTHESIS_DELIVERY_RESERVE = 2;
// invariant: covered capsules share evidence_refs with a memory_entry already in the natural top-K delivery window.
const SYNTHESIS_COVERAGE_WINDOW = 5;

export function selectUncoveredSynthesisCapsules<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  maxEntries: number
): readonly T[] {
  const synthesisCandidates = deliveryOrdered.filter(
    (candidate) => candidate.objectKind === "synthesis_capsule"
  );
  if (synthesisCandidates.length === 0) {
    return Object.freeze([]);
  }
  const coverageWindow = Math.min(maxEntries, SYNTHESIS_COVERAGE_WINDOW);
  const coveredEvidenceRefs = new Set<string>();
  for (const candidate of deliveryOrdered.slice(0, coverageWindow)) {
    if (candidate.objectKind === "synthesis_capsule") {
      continue;
    }
    for (const ref of candidate.entry.evidence_refs) {
      coveredEvidenceRefs.add(ref);
    }
  }
  return Object.freeze(
    synthesisCandidates.filter(
      (capsule) => !capsule.entry.evidence_refs.some((ref) => coveredEvidenceRefs.has(ref))
    )
  );
}

// invariant: synthesis tail count is visible so structural reserve cannot overrun the same delivery tail.
export function synthesisReserveCount(
  deliveryOrdered: readonly FusedRecallCandidateInput[],
  maxEntries: number
): number {
  if (maxEntries <= 1) {
    return 0;
  }
  const uncoveredCount = selectUncoveredSynthesisCapsules(deliveryOrdered, maxEntries).length;
  if (uncoveredCount === 0) {
    return 0;
  }
  return Math.max(0, Math.min(SYNTHESIS_DELIVERY_RESERVE, uncoveredCount, maxEntries - 1));
}

export function reserveSynthesisDeliverySlots<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  if (maxEntries <= 1) {
    return deliveryOrdered;
  }
  const uncoveredCapsules = selectUncoveredSynthesisCapsules(deliveryOrdered, maxEntries);
  if (uncoveredCapsules.length === 0) {
    return deliveryOrdered;
  }
  const reserveCount = synthesisReserveCount(deliveryOrdered, maxEntries);
  if (reserveCount <= 0) {
    return deliveryOrdered;
  }
  // invariant: synthesis anchor bonus prefers capsules overlapping evidence_refs from graph/path-reached members.
  const pathReachedEvidenceRefs = new Set<string>();
  for (const candidate of deliveryOrdered) {
    if (
      candidate.objectKind !== "synthesis_capsule" &&
      structuralFusionContribution(candidate) > 0
    ) {
      for (const ref of candidate.entry.evidence_refs) {
        pathReachedEvidenceRefs.add(ref);
      }
    }
  }
  const synthesisAnchorBonus = (capsule: T): number =>
    capsule.entry.evidence_refs.some((ref) => pathReachedEvidenceRefs.has(ref))
      ? SYNTHESIS_ANCHOR_BONUS
      : 0;
  const reservedSynthesis = [...uncoveredCapsules]
    .sort((left, right) => {
      const leftRank =
        (supplementaryData.synthesisFtsRanks[left.entry.object_id] ?? 0) + synthesisAnchorBonus(left);
      const rightRank =
        (supplementaryData.synthesisFtsRanks[right.entry.object_id] ?? 0) + synthesisAnchorBonus(right);
      return rightRank - leftRank !== 0
        ? rightRank - leftRank
        : compareMemoryEntries(left.entry, right.entry);
    })
    .slice(0, reserveCount);
  const reservedKeys = new Set(
    reservedSynthesis.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const rest = deliveryOrdered.filter(
    (candidate) => !reservedKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
  const headCount = Math.max(0, maxEntries - reserveCount);
  return Object.freeze([
    ...rest.slice(0, headCount),
    ...reservedSynthesis,
    ...rest.slice(headCount)
  ]);
}

// invariant: structural streams are only graph/path topology reach; generic structuralScore and entity/evidence terms are excluded.
// see also: packages/core/src/recall/fusion-delivery.ts:reserveStructuralDeliverySlots.
const STRUCTURAL_FUSION_STREAMS: ReadonlySet<RecallFusionStream> = new Set([
  "graph_expansion",
  "path_expansion"
]);

// invariant: lexical-lane streams are the content/evidence signals compared against graph/path topology dominance.
const LEXICAL_LANE_FUSION_STREAMS: ReadonlySet<RecallFusionStream> = new Set([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "embedding_similarity",
  "entity_seed"
]);

// invariant: structural contribution reads frozen per-stream RRF terms, not raw connectivity.
function structuralFusionContribution(candidate: FusedRecallCandidateInput): number {
  const contributions = candidate.fusion.fused_rank_contribution_per_stream;
  let total = 0;
  for (const stream of STRUCTURAL_FUSION_STREAMS) {
    total += contributions[stream];
  }
  return total;
}

// invariant: structural reserve mirrors path suppression by subtracting the target suppression delta before dominance checks.
function suppressedStructuralFusionContribution(
  candidate: FusedRecallCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const structural = structuralFusionContribution(candidate);
  const suppression = supplementaryData.pathSuppressionScores[candidate.entry.object_id] ?? 0;
  if (suppression <= 0) {
    return structural;
  }
  return Math.max(0, structural - suppression);
}

function lexicalLaneFusionContribution(candidate: FusedRecallCandidateInput): number {
  const contributions = candidate.fusion.fused_rank_contribution_per_stream;
  let total = 0;
  for (const stream of LEXICAL_LANE_FUSION_STREAMS) {
    total += contributions[stream];
  }
  return total;
}

// invariant: structural reserve gives bounded tail presence to graph/path-dominated candidates that lost the flat delivery cut.
const STRUCTURAL_DELIVERY_RESERVE = 2;

// invariant: structural rescue relevance is gold-blind; generic structural candidates need lexical/evidence relevance unless earned co_recalled fan-in applies.
// see also: packages/core/src/recall/query-evidence-scoring.ts:scoreQueryEvidenceMatch,
// packages/core/src/recall/query-evidence-scoring.ts:scoreEvidenceAnchorMatch,
// packages/core/src/recall/fusion-delivery.ts:isStructuralRescueCandidate.
function structuralRescueRelevanceSignal(
  candidate: FusedRecallCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const lexicalLane = lexicalLaneFusionContribution(candidate);
  if (lexicalLane > 0) {
    return lexicalLane;
  }
  const queryEvidenceRefs = new Set<string>(supplementaryData.queryProbes.evidence_refs);
  return (
    scoreQueryEvidenceMatch(candidate.entry, supplementaryData.queryProbes) +
    0.5 * scoreEvidenceAnchorMatch(candidate.entry, queryEvidenceRefs)
  );
}

export function isStructuralRescueCandidate(
  candidate: FusedRecallCandidateInput,
  supplementaryData: RecallSupplementaryData
): boolean {
  if (candidate.objectKind === "synthesis_capsule") {
    return false;
  }
  // invariant: suppression-adjusted topology contribution must remain positive before rescue.
  const structural = suppressedStructuralFusionContribution(candidate, supplementaryData);
  if (structural <= 0) {
    return false;
  }
  if (structural <= lexicalLaneFusionContribution(candidate)) {
    return false;
  }
  // invariant: earned co_recalled fan-in is the only zero-relevance structural rescue exemption.
  if (candidate.reachedViaEarnedCoRecalledFanin === true) {
    return true;
  }
  return structuralRescueRelevanceSignal(candidate, supplementaryData) > 0;
}

// invariant: structural reserve inserts above the synthesis tail and caps combined reserve slots at maxEntries - 1.
export function reserveStructuralDeliverySlots<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number,
  reservedTailCount: number
): readonly T[] {
  if (maxEntries <= 1) {
    return deliveryOrdered;
  }
  const naturalWindowSize = Math.min(maxEntries, deliveryOrdered.length);
  const inWindowKeys = new Set(
    deliveryOrdered
      .slice(0, naturalWindowSize)
      .map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const buriedStructural = deliveryOrdered.filter(
    (candidate) =>
      isStructuralRescueCandidate(candidate, supplementaryData) &&
      !inWindowKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
  if (buriedStructural.length === 0) {
    return deliveryOrdered;
  }
  const reserveBudget = maxEntries - 1 - Math.max(0, reservedTailCount);
  const reserveCount = Math.min(
    STRUCTURAL_DELIVERY_RESERVE,
    buriedStructural.length,
    reserveBudget
  );
  if (reserveCount <= 0) {
    return deliveryOrdered;
  }
  const reservedStructural = [...buriedStructural]
    .sort((left, right) => {
      const strengthDelta =
        suppressedStructuralFusionContribution(right, supplementaryData) -
        suppressedStructuralFusionContribution(left, supplementaryData);
      return strengthDelta !== 0
        ? strengthDelta
        : compareMemoryEntries(left.entry, right.entry);
    })
    .slice(0, reserveCount);
  const reservedKeys = new Set(
    reservedStructural.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  // invariant: preserve the synthesis tail block while inserting structural rows above it.
  const synthesisTailStart = Math.max(0, naturalWindowSize - Math.max(0, reservedTailCount));
  const synthesisTailBlock = deliveryOrdered.slice(synthesisTailStart, naturalWindowSize);
  const synthesisTailKeys = new Set(
    synthesisTailBlock.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const aboveBlock = deliveryOrdered.filter((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    return !reservedKeys.has(key) && !synthesisTailKeys.has(key);
  });
  // invariant: reserveCount cap preserves at least one pure-fusion head slot.
  const headCount = Math.max(0, maxEntries - Math.max(0, reservedTailCount) - reserveCount);
  return Object.freeze([
    ...aboveBlock.slice(0, headCount),
    ...reservedStructural,
    ...synthesisTailBlock,
    ...aboveBlock.slice(headCount)
  ]);
}

const SESSION_COVERAGE_BAND_ENV = "ALAYA_RECALL_SESSION_COVERAGE_BAND";
const DEFAULT_SESSION_COVERAGE_BAND = 0.1;

// Fraction of the head candidate's fused_score within which a lower-ranked,
// not-yet-represented session may be promoted ahead of it. 0 disables the
// rerank. Env-tunable so a bench sweep can calibrate against per-gold rank data.
function resolveSessionCoverageBand(): number {
  const raw = process.env[SESSION_COVERAGE_BAND_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SESSION_COVERAGE_BAND;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SESSION_COVERAGE_BAND;
}

function sessionCoverageKey(
  candidate: Readonly<FusedRecallCandidateInput>
): string {
  return candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>";
}

// invariant: reorders ONLY inside the top-K delivery window, so the delivered
// set is unchanged — only its order, which moves the @K-scored slots. A
// candidate whose session is already represented yields to the next
// not-yet-represented session candidate whose fused_score is within `band` of
// it; strong head hits (far outside the band) are never demoted. No-op when the
// window is single-session (e.g. one run_id, null surfaces) so default recall
// stays byte-identical.
export function applySessionCoverageRerank<T extends FusedRecallCandidateInput>(
  ordered: readonly T[],
  maxEntries: number
): readonly T[] {
  const band = resolveSessionCoverageBand();
  if (band <= 0 || maxEntries <= 1 || ordered.length <= 1) {
    return ordered;
  }
  const windowSize = Math.min(maxEntries, ordered.length);
  const window = ordered.slice(0, windowSize);
  if (new Set(window.map(sessionCoverageKey)).size <= 1) {
    return ordered;
  }
  const remaining = [...window];
  const rest = ordered.slice(windowSize);
  const result: T[] = [];
  const represented = new Set<string>();
  while (remaining.length > 0) {
    const head = remaining[0];
    if (head === undefined) {
      break;
    }
    const headKey = sessionCoverageKey(head);
    if (represented.has(headKey)) {
      const headScore = head.fusion.fused_score;
      const tolerance = band * Math.abs(headScore);
      const altIndex = remaining.findIndex(
        (candidate, index) =>
          index > 0 &&
          !represented.has(sessionCoverageKey(candidate)) &&
          headScore - candidate.fusion.fused_score <= tolerance
      );
      if (altIndex !== -1) {
        const alt = remaining[altIndex];
        if (alt !== undefined) {
          remaining.splice(altIndex, 1);
          result.push(alt);
          represented.add(sessionCoverageKey(alt));
          continue;
        }
      }
    }
    result.push(head);
    represented.add(headKey);
    remaining.shift();
  }
  return Object.freeze([...result, ...rest]);
}

// @internal test seam for delivery-reserve boundary contracts.
// see also: packages/core/src/__tests__/recall/recall-durable-fanin-delivery.test.ts.
export const recallDeliveryReserveTestInternals = Object.freeze({
  selectUncoveredSynthesisCapsules,
  reserveSynthesisDeliverySlots,
  reserveStructuralDeliverySlots,
  synthesisReserveCount,
  buildEmptyRecallFusionBreakdown,
  isStructuralRescueCandidate,
  applySessionCoverageRerank
});

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
