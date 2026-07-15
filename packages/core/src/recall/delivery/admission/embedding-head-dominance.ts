import { Buffer } from "node:buffer";
import type {
  RecallFusionStream,
  RecallFusionStreamRanks
} from "../../runtime/recall-service-types.js";
import { hasTemporalQuerySignal } from "../../query/recall-query-plan.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";

const QUERY_EVIDENCE_STREAMS: readonly RecallFusionStream[] = Object.freeze([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "subject_alignment",
  "entity_seed",
  "facet_overlap"
]);

type EmbeddingHeadCandidate = Readonly<{
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

export function selectEmbeddingHeadEvictions<T extends EmbeddingHeadCandidate>(
  params: Readonly<{
    readonly candidates: readonly T[];
    readonly maxEntries: number;
    readonly embeddingScores: Readonly<Record<string, number>>;
    readonly queryProbes?: Readonly<RecallQueryProbes>;
    readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
    readonly selectDelivered: (evictions: ReadonlySet<string>) => readonly T[];
  }>
): ReadonlySet<string> {
  const budget = normalizeBudget(params.maxEntries, params.candidates.length);
  if (budget === 0) return new Set();
  const temporalQueryActive = params.queryProbes !== undefined
    && hasTemporalQuerySignal(params.queryProbes);
  let evictions: ReadonlySet<string> = new Set();
  let delivered = params.selectDelivered(evictions);
  for (const head of orderedEmbeddingHead(params.candidates, budget)) {
    if (containsCandidate(delivered, head)) continue;
    const replacement = findReplacement({
      ...params,
      head,
      budget,
      temporalQueryActive,
      evictions,
      delivered
    });
    if (replacement === null) continue;
    evictions = replacement.evictions;
    delivered = replacement.delivered;
  }
  return evictions;
}

function findReplacement<T extends EmbeddingHeadCandidate>(params: Readonly<{
  readonly head: T;
  readonly budget: number;
  readonly embeddingScores: Readonly<Record<string, number>>;
  readonly temporalQueryActive: boolean;
  readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
  readonly evictions: ReadonlySet<string>;
  readonly delivered: readonly T[];
  readonly selectDelivered: (evictions: ReadonlySet<string>) => readonly T[];
}>): DominanceReplacement<T> | null {
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
  return weakest?.replacement ?? null;
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
    readonly temporalQueryActive: boolean;
    readonly answerRerankedCandidateKeys?: ReadonlySet<string>;
  }>
): boolean {
  return !isEmbeddingHead(candidate, params.budget)
    && !hasIndependentQueryEvidence(
      candidate,
      params.temporalQueryActive,
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
  temporalQueryActive: boolean,
  answerRerankedCandidateKeys: ReadonlySet<string> | undefined
): boolean {
  if (answerRerankedCandidateKeys?.has(candidate.fusion.candidate_key) === true) return true;
  if (temporalQueryActive && candidate.fusion.per_stream_rank.temporal_recency !== null) return true;
  return QUERY_EVIDENCE_STREAMS.some(
    (stream) => candidate.fusion.per_stream_rank[stream] !== null
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
  const score = scores[candidate.entry.object_id]
    ?? candidate.effectiveFactors.embedding_similarity;
  return score !== undefined && Number.isFinite(score) && score > 0 ? score : null;
}

function compareCandidateKeysBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
