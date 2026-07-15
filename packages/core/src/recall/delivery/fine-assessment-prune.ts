import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { RECALL_TOTAL_CANDIDATE_CAP } from "../../shared/recall-policy.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";

export type FineAssessmentPruneResult = Readonly<{
  readonly survivors: readonly Readonly<CoarseRecallCandidate>[];
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
  const cap = normalizeFineAssessmentCandidateBudget(params.cap);
  if (coarsePoolSize === 0) {
    return emptyPruneResult(cap);
  }
  if (coarsePoolSize <= cap) {
    return Object.freeze({
      survivors: Object.freeze([...params.candidates]),
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
  const priorityCandidateCount = partitioned.winners.length + partitioned.injected.length;
  return Object.freeze({
    survivors,
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
    return normalizeFineAssessmentCandidateBudget(explicit);
  }
  const semantic = policy.coarse_filter.semantic_supplement;
  const semanticBudget = semantic.enabled ? semantic.max_supplement : 0;
  const injectionBudget = semantic.enabled && semantic.embedding_enabled === true
    ? semantic.injection_cap ?? 0
    : 0;
  return normalizeFineAssessmentCandidateBudget(Math.max(
    policy.fine_assessment.budgets.max_entries,
    policy.coarse_filter.precomputed_rank.max_candidates + semanticBudget + injectionBudget
  ));
}

function normalizeFineAssessmentCandidateBudget(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return RECALL_TOTAL_CANDIDATE_CAP;
  return Math.min(
    RECALL_TOTAL_CANDIDATE_CAP,
    Math.max(0, Math.trunc(value))
  );
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
    coarsePoolSize: 0,
    fineEvaluated: 0,
    finePrunedCount: 0,
    hardBudget,
    priorityCandidateCount: 0,
    priorityOverflowCount: 0
  });
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
  if (winnerMemoryIds.has(candidate.entry.object_id)) {
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
  const scoreDelta =
    cheapPruneScore(right, supplementaryData) - cheapPruneScore(left, supplementaryData);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.entry.object_id.localeCompare(right.entry.object_id);
}

function cheapPruneScore(
  candidate: Readonly<CoarseRecallCandidate>,
  supplementaryData: PruneSupplementary
): number {
  const objectId = candidate.entry.object_id;
  const embedding = supplementaryData.embeddingSimilarityScores[objectId] ?? 0;
  const fts = Math.max(
    supplementaryData.ftsRanks[objectId] ?? 0,
    supplementaryData.trigramFtsRanks[objectId] ?? 0,
    supplementaryData.evidenceFtsRanks[objectId] ?? 0
  );
  const structural = Math.max(
    supplementaryData.structuralScores[objectId] ?? 0,
    candidate.structuralScore ?? 0
  );
  return embedding + fts + structural;
}
