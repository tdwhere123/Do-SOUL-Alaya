import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { normalizeRecallCandidateLimit } from "../../shared/internal/recall-candidate-limit.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  buildRecallCandidateDedupeKey,
  clamp01,
  isSynthesisChildCandidate,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import { readObservedUnitScore } from "../scoring/signals/observed-unit-score.js";

export type FineAssessmentPruneResult = Readonly<{
  readonly survivors: readonly Readonly<CoarseRecallCandidate>[];
  readonly prunedCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
  readonly hardBudget: number;
  readonly priorityCandidateCount: number;
  readonly priorityOverflowCount: number;
}>;

type PruneSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "embeddingSimilarityScores"
  | "ftsRanks"
  | "trigramFtsRanks"
  | "synthesisFtsRanks"
  | "evidenceFtsRanks"
  | "structuralScores"
>>;

export function pruneCoarseCandidatesForFineAssessment(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly supplementaryData: PruneSupplementary;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly cap: number;
}>): FineAssessmentPruneResult {
  const coarsePoolSize = params.candidates.length;
  const cap = normalizeRecallCandidateLimit(params.cap);
  assertUniqueCoarseCandidateKeys(params.candidates);
  if (coarsePoolSize === 0) {
    return emptyPruneResult(cap);
  }
  if (coarsePoolSize <= cap) {
    return Object.freeze({
      survivors: Object.freeze([...params.candidates]),
      prunedCandidates: Object.freeze([]),
      coarsePoolSize,
      fineEvaluated: coarsePoolSize,
      finePrunedCount: 0,
      hardBudget: cap,
      priorityCandidateCount: countPriorityCandidates(params.candidates, params.winnerMemoryIds),
      priorityOverflowCount: 0
    });
  }

  const partitioned = partitionPruneCandidates(params.candidates, params.winnerMemoryIds);
  const survivors = selectPruneSurvivors(partitioned, cap, params.supplementaryData);
  const prunedCandidates = collectPrunedCandidates(params.candidates, survivors);
  const priorityCandidateCount = partitioned.winners.length + partitioned.injected.length;
  return Object.freeze({
    survivors,
    prunedCandidates,
    coarsePoolSize,
    fineEvaluated: survivors.length,
    finePrunedCount: Math.max(0, coarsePoolSize - survivors.length),
    hardBudget: cap,
    priorityCandidateCount,
    priorityOverflowCount: Math.max(0, priorityCandidateCount - cap)
  });
}

export function resolveFineAssessmentCandidateBudget(
  policy: Readonly<RecallPolicy>
): number {
  const explicit = policy.fine_assessment.max_candidates;
  if (explicit !== undefined) {
    return normalizeRecallCandidateLimit(explicit);
  }
  const semantic = policy.coarse_filter.semantic_supplement;
  const semanticBudget = semantic.enabled ? semantic.max_supplement : 0;
  const injectionBudget = semantic.enabled && semantic.embedding_enabled === true
    ? semantic.injection_cap ?? 0
    : 0;
  return normalizeRecallCandidateLimit(Math.max(
    policy.fine_assessment.budgets.max_entries,
    policy.coarse_filter.precomputed_rank.max_candidates + semanticBudget + injectionBudget
  ));
}

type PrunePartition = Readonly<{
  readonly winners: readonly Readonly<CoarseRecallCandidate>[];
  readonly injected: readonly Readonly<CoarseRecallCandidate>[];
  readonly competitive: readonly Readonly<CoarseRecallCandidate>[];
}>;

function partitionPruneCandidates(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  winnerMemoryIds: ReadonlySet<string>
): PrunePartition {
  const winners: Readonly<CoarseRecallCandidate>[] = [];
  const injected: Readonly<CoarseRecallCandidate>[] = [];
  const competitive: Readonly<CoarseRecallCandidate>[] = [];
  for (const candidate of candidates) {
    if (isProtectedWinner(candidate, winnerMemoryIds)) {
      winners.push(candidate);
    } else if (isSemanticInjected(candidate)) {
      injected.push(candidate);
    } else {
      competitive.push(candidate);
    }
  }
  return Object.freeze({ winners, injected, competitive });
}

function selectPruneSurvivors(
  partitioned: PrunePartition,
  cap: number,
  supplementaryData: PruneSupplementary
): readonly Readonly<CoarseRecallCandidate>[] {
  const rank = (candidates: readonly Readonly<CoarseRecallCandidate>[]) =>
    [...candidates].sort((left, right) =>
      compareByCheapPruneSignals(left, right, supplementaryData)
    );
  return Object.freeze([
    ...rank(partitioned.winners),
    ...rank(partitioned.injected),
    ...rank(partitioned.competitive)
  ].slice(0, cap));
}

function emptyPruneResult(hardBudget: number): FineAssessmentPruneResult {
  return Object.freeze({
    survivors: Object.freeze([]),
    prunedCandidates: Object.freeze([]),
    coarsePoolSize: 0,
    fineEvaluated: 0,
    finePrunedCount: 0,
    hardBudget,
    priorityCandidateCount: 0,
    priorityOverflowCount: 0
  });
}

function assertUniqueCoarseCandidateKeys(
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): void {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (keys.has(key)) {
      throw new Error(`duplicate coarse recall candidate key: ${key}`);
    }
    keys.add(key);
  }
}

function collectPrunedCandidates(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  survivors: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<CoarseRecallCandidate>[] {
  const survivorKeys = new Set(survivors.map(buildRecallCandidateDedupeKey));
  if (survivorKeys.size !== survivors.length) {
    throw new Error("fine-assessment survivors repeat a candidate key");
  }
  const pruned = candidates.filter(
    (candidate) => !survivorKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
  if (survivors.length + pruned.length !== candidates.length) {
    throw new Error("fine-assessment candidate closure is incomplete");
  }
  return Object.freeze(pruned);
}

function countPriorityCandidates(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  winnerMemoryIds: ReadonlySet<string>
): number {
  return candidates.filter((candidate) =>
    isProtectedWinner(candidate, winnerMemoryIds) || isSemanticInjected(candidate)
  ).length;
}

function isProtectedWinner(
  candidate: Readonly<CoarseRecallCandidate>,
  winnerMemoryIds: ReadonlySet<string>
): boolean {
  if (isWorkspaceMemoryCandidate(candidate) && winnerMemoryIds.has(candidate.entry.object_id)) {
    return true;
  }
  return (candidate.admissionPlanes ?? []).includes("protected_winner");
}

function isSemanticInjected(candidate: Readonly<CoarseRecallCandidate>): boolean {
  const planes = candidate.admissionPlanes ?? [];
  if (planes.includes("semantic_supplement")) {
    return true;
  }
  if (candidate.sourceChannel === "semantic_supplement") {
    return true;
  }
  return candidate.sourceChannels?.includes("semantic_supplement") === true;
}

function compareByCheapPruneSignals(
  left: Readonly<CoarseRecallCandidate>,
  right: Readonly<CoarseRecallCandidate>,
  supplementaryData: PruneSupplementary
): number {
  const leftSignals = cheapPruneSignals(left, supplementaryData);
  const rightSignals = cheapPruneSignals(right, supplementaryData);
  const scoreDelta = rightSignals.score - leftSignals.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  if (leftSignals.embeddingScore === rightSignals.embeddingScore) {
    const observationDelta =
      rightSignals.embeddingObservationPriority - leftSignals.embeddingObservationPriority;
    if (observationDelta !== 0) return observationDelta;
  }
  return buildRecallCandidateDedupeKey(left).localeCompare(
    buildRecallCandidateDedupeKey(right)
  );
}

type CheapPruneSignals = Readonly<{
  readonly score: number;
  readonly embeddingScore: number;
  readonly embeddingObservationPriority: number;
}>;

function cheapPruneSignals(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: PruneSupplementary
): CheapPruneSignals {
  const objectId = candidate.entry.object_id;
  const canUseMemorySignals = isWorkspaceMemoryCandidate(candidate);
  const embedding = readEmbeddingPruneSignal(candidate, supplementaryData);
  const fts = readCheapFtsScore(candidate, supplementaryData);
  const structural = clamp01(Math.max(
    canUseMemorySignals ? clamp01(supplementaryData.structuralScores[objectId] ?? 0) : 0,
    clamp01(candidate.structuralScore ?? 0)
  ));
  return Object.freeze({
    score: embedding.score + fts + structural,
    embeddingScore: embedding.score,
    embeddingObservationPriority: embedding.observationPriority
  });
}

function readEmbeddingPruneSignal(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: PruneSupplementary
): Readonly<{ readonly score: number; readonly observationPriority: number }> {
  if (!isWorkspaceMemoryCandidate(candidate)) {
    return { score: 0, observationPriority: 0 };
  }
  const observed = readObservedUnitScore(
    supplementaryData.embeddingSimilarityScores[candidate.entry.object_id]
  );
  if (observed === null) return { score: 0, observationPriority: 1 };
  return { score: observed, observationPriority: observed > 0 ? 1 : 0 };
}

function readCheapFtsScore(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: PruneSupplementary
): number {
  const objectId = candidate.entry.object_id;
  if (candidate.originPlane !== "global" && candidate.objectKind === "synthesis_capsule") {
    return clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0);
  }
  if (!isWorkspaceMemoryCandidate(candidate)) return 0;
  return Math.max(
    clamp01(supplementaryData.ftsRanks[objectId] ?? 0),
    clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0),
    clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0),
    isSynthesisChildCandidate(candidate)
      ? clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0)
      : 0
  );
}
