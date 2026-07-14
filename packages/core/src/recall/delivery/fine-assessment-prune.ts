import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";

/**
 * Coarse→fine waist. Measured scaling: coarse ≈ 105 + 1.04·pool_size ms
 * (mean pool ~584 → ~713 ms). Cap 200 targets coarse ≈ 105 + 208 ≈ 313 ms so
 * fusion (≈102 + 0.26·fine) and a later deep head still fit p95 ≤ 1100 with the
 * documented ~650–750 ms funnel projection. Chosen from that latency budget
 * arithmetic — not from R@5 deltas.
 */
export const FINE_ASSESSMENT_COARSE_PRUNE_CAP = 200;

export type FineAssessmentPruneResult = Readonly<{
  readonly survivors: readonly Readonly<CoarseRecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
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
  readonly cap?: number;
}>): FineAssessmentPruneResult {
  const coarsePoolSize = params.candidates.length;
  const cap = params.cap ?? FINE_ASSESSMENT_COARSE_PRUNE_CAP;
  if (coarsePoolSize === 0) {
    return emptyPruneResult();
  }
  if (coarsePoolSize <= cap) {
    return Object.freeze({
      survivors: Object.freeze([...params.candidates]),
      coarsePoolSize,
      fineEvaluated: coarsePoolSize,
      finePrunedCount: 0
    });
  }

  const partitioned = partitionPruneCandidates(params.candidates, params.winnerMemoryIds);
  const survivors = selectPruneSurvivors(partitioned, cap, params.supplementaryData);
  return Object.freeze({
    survivors,
    coarsePoolSize,
    fineEvaluated: survivors.length,
    finePrunedCount: Math.max(0, coarsePoolSize - survivors.length)
  });
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
  // Winners always survive (may exceed cap). Injected fill remaining under cap
  // first so a misconfigured injection_cap cannot explode the waist unbounded;
  // competitive fill takes whatever slots remain under cap.
  const retainedInjected = partitioned.injected.slice(
    0,
    Math.max(0, cap - partitioned.winners.length)
  );
  const retainedIds = new Set(
    [...partitioned.winners, ...retainedInjected].map((candidate) => candidate.entry.object_id)
  );
  const remainingSlots = Math.max(0, cap - partitioned.winners.length - retainedInjected.length);
  const rankedFill = [...partitioned.competitive]
    .sort((left, right) => compareByCheapPruneSignals(left, right, supplementaryData))
    .filter((candidate) => !retainedIds.has(candidate.entry.object_id))
    .slice(0, remainingSlots);
  return Object.freeze([...partitioned.winners, ...retainedInjected, ...rankedFill]);
}

function emptyPruneResult(): FineAssessmentPruneResult {
  return Object.freeze({
    survivors: Object.freeze([]),
    coarsePoolSize: 0,
    fineEvaluated: 0,
    finePrunedCount: 0
  });
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
