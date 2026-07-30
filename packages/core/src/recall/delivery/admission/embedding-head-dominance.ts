import { Buffer } from "node:buffer";
import type {
  CoarseRecallCandidate,
  RecallFusionStreamRanks
} from "../../runtime/recall-service-types.js";
import { isWorkspaceMemoryCandidate } from "../../runtime/recall-service-helpers.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { hasNonEmbeddingQueryEvidenceRank } from
  "../../scoring/query-evidence-support.js";

type EmbeddingHeadCandidate = Readonly<Pick<
  CoarseRecallCandidate,
  "originPlane" | "objectKind"
> & {
  readonly entry: Readonly<{ readonly object_id: string }>;
  readonly effectiveFactors: Readonly<{ readonly embedding_similarity?: number }>;
  readonly fusion: Readonly<{
    readonly candidate_key: string;
    readonly per_stream_rank: RecallFusionStreamRanks;
  }>;
}>;

type DominanceReplacement<T> = Readonly<{
  readonly evictions: ReadonlySet<string>;
  readonly delivered: readonly T[];
}>;

type EvaluatedDominanceReplacement<T> = Readonly<{
  readonly incumbent: T;
  readonly replacement: DominanceReplacement<T>;
}>;

export function hasRankedEmbeddingHead<T extends EmbeddingHeadCandidate>(
  candidates: readonly T[],
  maxEntries: number
): boolean {
  const budget = normalizeBudget(maxEntries, candidates.length);
  return budget > 0 && candidates.some((candidate) => isEmbeddingHead(candidate, budget));
}

export function selectEmbeddingHeadEvictions<T extends EmbeddingHeadCandidate>(
  params: Readonly<{
    readonly candidates: readonly T[];
    readonly maxEntries: number;
    readonly embeddingScores: Readonly<Record<string, number>>;
    readonly queryProbes?: Readonly<RecallQueryProbes>;
    readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
    readonly selectDelivered: (evictions: ReadonlySet<string>) => readonly T[];
    readonly onEviction?: (input: Readonly<{
      readonly evictedCandidateKey: string;
      readonly dominatingCandidateKey: string;
    }>) => void;
  }>
): ReadonlySet<string> {
  const budget = normalizeBudget(params.maxEntries, params.candidates.length);
  if (budget === 0) return new Set();
  const embeddingHead = orderedEmbeddingHead(params.candidates, budget);
  if (embeddingHead.length === 0) return new Set();
  const selectDelivered = memoizeDeliveredSelection(params.selectDelivered);
  let evictions: ReadonlySet<string> = new Set();
  let delivered = selectDelivered(evictions);
  for (const head of embeddingHead) {
    if (containsCandidate(delivered, head)) continue;
    const replacement = findReplacement({
      ...params,
      selectDelivered,
      head,
      budget,
      evictions,
      delivered
    });
    if (replacement === null) continue;
    params.onEviction?.(Object.freeze({
      evictedCandidateKey: replacement.incumbent.fusion.candidate_key,
      dominatingCandidateKey: head.fusion.candidate_key
    }));
    evictions = replacement.replacement.evictions;
    delivered = replacement.replacement.delivered;
  }
  return evictions;
}

function memoizeDeliveredSelection<T>(
  selectDelivered: (evictions: ReadonlySet<string>) => readonly T[]
): (evictions: ReadonlySet<string>) => readonly T[] {
  const deliveredByEvictionSet = new Map<string, readonly T[]>();
  return (evictions) => {
    const key = evictionSetMemoKey(evictions);
    const cached = deliveredByEvictionSet.get(key);
    if (cached !== undefined) return cached;
    const delivered = selectDelivered(evictions);
    deliveredByEvictionSet.set(key, delivered);
    return delivered;
  };
}

/** Stable Map key for an eviction set — sorted join, same identity as sorted JSON.stringify. */
export function evictionSetMemoKey(evictions: ReadonlySet<string>): string {
  if (evictions.size === 0) return "";
  return [...evictions].sort(compareCandidateKeysBytewise).join("\0");
}

function findReplacement<T extends EmbeddingHeadCandidate>(params: Readonly<{
  readonly head: T;
  readonly budget: number;
  readonly embeddingScores: Readonly<Record<string, number>>;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
  readonly evictions: ReadonlySet<string>;
  readonly delivered: readonly T[];
  readonly selectDelivered: (evictions: ReadonlySet<string>) => readonly T[];
}>): EvaluatedDominanceReplacement<T> | null {
  let weakest: EvaluatedDominanceReplacement<T> | null = null;
  for (const incumbent of params.delivered) {
    if (!isReplaceable(incumbent, params)) continue;
    if (!strictlyDominates(params.head, incumbent, params.embeddingScores)) continue;
    const replacement = buildFeasibleReplacement(params, incumbent);
    if (replacement === null) continue;
    const evaluated = Object.freeze({ incumbent, replacement });
    if (weakest === null || isWeakerReplacement(evaluated, weakest, params.embeddingScores)) {
      weakest = evaluated;
    }
  }
  return weakest;
}

function buildFeasibleReplacement<T extends EmbeddingHeadCandidate>(
  params: Readonly<{
    readonly head: T;
    readonly evictions: ReadonlySet<string>;
    readonly delivered: readonly T[];
    readonly selectDelivered: (evictions: ReadonlySet<string>) => readonly T[];
  }>,
  incumbent: T
): DominanceReplacement<T> | null {
  const evictions = new Set(params.evictions).add(incumbent.fusion.candidate_key);
  const delivered = params.selectDelivered(evictions);
  if (!containsCandidate(delivered, params.head)) return null;
  if (!preservesDeliveredPeers(params.delivered, incumbent, delivered)) return null;
  return Object.freeze({ evictions, delivered });
}

function isWeakerReplacement<T extends EmbeddingHeadCandidate>(
  candidate: EvaluatedDominanceReplacement<T>,
  current: EvaluatedDominanceReplacement<T>,
  scores: Readonly<Record<string, number>>
): boolean {
  const evidenceOrder = compareEmbeddingEvidenceStrength(
    candidate.incumbent,
    current.incumbent,
    scores
  );
  if (evidenceOrder !== 0) return evidenceOrder < 0;
  return compareCandidateKeysBytewise(
    candidate.incumbent.fusion.candidate_key,
    current.incumbent.fusion.candidate_key
  ) > 0;
}

function isReplaceable(
  candidate: EmbeddingHeadCandidate,
  params: Readonly<{
    readonly budget: number;
    readonly queryProbes?: Readonly<RecallQueryProbes>;
    readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
  }>
): boolean {
  return !isEmbeddingHead(candidate, params.budget)
    && !hasIndependentQueryEvidence(
      candidate,
      params.budget,
      params.queryProbes,
      params.answerRerankedCandidateKeys
    );
}

function preservesDeliveredPeers<T extends EmbeddingHeadCandidate>(
  current: readonly T[],
  replaced: T,
  trial: readonly T[]
): boolean {
  const trialKeys = new Set(trial.map((candidate) => candidate.fusion.candidate_key));
  return current.every((candidate) =>
    candidate.fusion.candidate_key === replaced.fusion.candidate_key
      || trialKeys.has(candidate.fusion.candidate_key)
  );
}

function orderedEmbeddingHead<T extends EmbeddingHeadCandidate>(
  candidates: readonly T[],
  budget: number
): readonly T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isEmbeddingHead(candidate, budget))
    .sort((left, right) =>
      embeddingRank(left.candidate) - embeddingRank(right.candidate)
      || left.index - right.index
    )
    .map(({ candidate }) => candidate);
}

function containsCandidate<T extends EmbeddingHeadCandidate>(
  candidates: readonly T[],
  expected: T
): boolean {
  return candidates.some(
    (candidate) => candidate.fusion.candidate_key === expected.fusion.candidate_key
  );
}

function normalizeBudget(value: number, candidateCount: number): number {
  if (!Number.isFinite(value)) return value > 0 ? candidateCount : 0;
  return Math.min(candidateCount, Math.max(0, Math.trunc(value)));
}

function isEmbeddingHead(candidate: EmbeddingHeadCandidate, budget: number): boolean {
  return embeddingRank(candidate) <= budget;
}

function embeddingRank(candidate: EmbeddingHeadCandidate): number {
  return candidate.fusion.per_stream_rank.embedding_similarity ?? Number.POSITIVE_INFINITY;
}

function hasIndependentQueryEvidence(
  candidate: EmbeddingHeadCandidate,
  budget: number,
  queryProbes: Readonly<RecallQueryProbes> | undefined,
  answerRerankedCandidateKeys: ReadonlySet<string> | undefined
): boolean {
  if (answerRerankedCandidateKeys?.has(candidate.fusion.candidate_key) === true) return true;
  return hasNonEmbeddingQueryEvidenceRank(
    candidate.fusion.per_stream_rank,
    queryProbes,
    budget
  );
}

function strictlyDominates(
  displaced: EmbeddingHeadCandidate,
  incumbent: EmbeddingHeadCandidate,
  scores: Readonly<Record<string, number>>
): boolean {
  return compareEmbeddingEvidenceStrength(displaced, incumbent, scores) > 0;
}

export function compareEmbeddingEvidenceStrength(
  left: EmbeddingHeadCandidate,
  right: EmbeddingHeadCandidate,
  scores: Readonly<Record<string, number>>
): number {
  const leftScore = positiveEmbeddingScore(left, scores);
  const rightScore = positiveEmbeddingScore(right, scores);
  if (leftScore !== null && rightScore !== null) {
    if (leftScore !== rightScore) return leftScore > rightScore ? 1 : -1;
  } else if (leftScore !== null) {
    return 1;
  } else if (rightScore !== null) {
    return -1;
  }
  const leftRank = embeddingRank(left);
  const rightRank = embeddingRank(right);
  if (leftRank === rightRank) return 0;
  return leftRank < rightRank ? 1 : -1;
}

function positiveEmbeddingScore(
  candidate: EmbeddingHeadCandidate,
  scores: Readonly<Record<string, number>>
): number | null {
  const score = (isWorkspaceMemoryCandidate(candidate)
    ? scores[candidate.entry.object_id]
    : undefined)
    ?? candidate.effectiveFactors.embedding_similarity;
  return score !== undefined && Number.isFinite(score) && score > 0 ? score : null;
}

function compareCandidateKeysBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
