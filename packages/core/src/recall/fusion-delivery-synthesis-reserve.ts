import type {
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallCandidateDedupeKey,
  compareMemoryEntries} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "./recall-service-types.js";
import {
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "./query-evidence-scoring.js";

const SYNTHESIS_ANCHOR_BONUS = 0.15;

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

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
  const pathReachedEvidenceRefs = collectPathReachedEvidenceRefs(deliveryOrdered);
  const reservedSynthesis = rankReservedSynthesisCandidates(
    uncoveredCapsules,
    supplementaryData,
    pathReachedEvidenceRefs
  ).slice(0, reserveCount);
  return spliceReservedDeliveryTail(deliveryOrdered, reservedSynthesis, maxEntries, reserveCount);
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
  const buriedStructural = collectBuriedStructuralCandidates(
    deliveryOrdered,
    supplementaryData,
    naturalWindowSize
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
  const reservedStructural = rankReservedStructuralCandidates(
    buriedStructural,
    supplementaryData
  ).slice(0, reserveCount);
  return spliceReservedStructuralCandidates(
    deliveryOrdered,
    reservedStructural,
    maxEntries,
    naturalWindowSize,
    reservedTailCount,
    reserveCount
  );
}

function collectPathReachedEvidenceRefs(
  deliveryOrdered: readonly FusedRecallCandidateInput[]
): ReadonlySet<string> {
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
  return pathReachedEvidenceRefs;
}

function rankReservedSynthesisCandidates<T extends FusedRecallCandidateInput>(
  uncoveredCapsules: readonly T[],
  supplementaryData: RecallSupplementaryData,
  pathReachedEvidenceRefs: ReadonlySet<string>
): readonly T[] {
  const synthesisAnchorBonus = (capsule: T): number =>
    capsule.entry.evidence_refs.some((ref) => pathReachedEvidenceRefs.has(ref))
      ? SYNTHESIS_ANCHOR_BONUS
      : 0;
  return [...uncoveredCapsules].sort((left, right) => {
    const leftRank =
      (supplementaryData.synthesisFtsRanks[left.entry.object_id] ?? 0) + synthesisAnchorBonus(left);
    const rightRank =
      (supplementaryData.synthesisFtsRanks[right.entry.object_id] ?? 0) + synthesisAnchorBonus(right);
    return rightRank - leftRank !== 0
      ? rightRank - leftRank
      : compareMemoryEntries(left.entry, right.entry);
  });
}

function spliceReservedDeliveryTail<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  reservedCandidates: readonly T[],
  maxEntries: number,
  reserveCount: number
): readonly T[] {
  const reservedKeys = new Set(
    reservedCandidates.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const rest = deliveryOrdered.filter(
    (candidate) => !reservedKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
  const headCount = Math.max(0, maxEntries - reserveCount);
  return Object.freeze([
    ...rest.slice(0, headCount),
    ...reservedCandidates,
    ...rest.slice(headCount)
  ]);
}

function collectBuriedStructuralCandidates<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  naturalWindowSize: number
): readonly T[] {
  const inWindowKeys = new Set(
    deliveryOrdered
      .slice(0, naturalWindowSize)
      .map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  return deliveryOrdered.filter(
    (candidate) =>
      isStructuralRescueCandidate(candidate, supplementaryData) &&
      !inWindowKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
}

function rankReservedStructuralCandidates<T extends FusedRecallCandidateInput>(
  buriedStructural: readonly T[],
  supplementaryData: RecallSupplementaryData
): readonly T[] {
  return [...buriedStructural].sort((left, right) => {
    const strengthDelta =
      suppressedStructuralFusionContribution(right, supplementaryData) -
      suppressedStructuralFusionContribution(left, supplementaryData);
    return strengthDelta !== 0
      ? strengthDelta
      : compareMemoryEntries(left.entry, right.entry);
  });
}

function spliceReservedStructuralCandidates<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  reservedStructural: readonly T[],
  maxEntries: number,
  naturalWindowSize: number,
  reservedTailCount: number,
  reserveCount: number
): readonly T[] {
  const reservedKeys = new Set(
    reservedStructural.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const synthesisTailBlock = collectSynthesisTailBlock(
    deliveryOrdered,
    naturalWindowSize,
    reservedTailCount
  );
  const synthesisTailKeys = new Set(
    synthesisTailBlock.map((candidate) => buildRecallCandidateDedupeKey(candidate))
  );
  const aboveBlock = deliveryOrdered.filter((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    return !reservedKeys.has(key) && !synthesisTailKeys.has(key);
  });
  const headCount = Math.max(0, maxEntries - Math.max(0, reservedTailCount) - reserveCount);
  return Object.freeze([
    ...aboveBlock.slice(0, headCount),
    ...reservedStructural,
    ...synthesisTailBlock,
    ...aboveBlock.slice(headCount)
  ]);
}

function collectSynthesisTailBlock<T extends FusedRecallCandidateInput>(
  deliveryOrdered: readonly T[],
  naturalWindowSize: number,
  reservedTailCount: number
): readonly T[] {
  const synthesisTailStart = Math.max(0, naturalWindowSize - Math.max(0, reservedTailCount));
  return deliveryOrdered.slice(synthesisTailStart, naturalWindowSize);
}
