import type {
  RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import {
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionStreamRanks
} from "../../runtime/recall-service-types.js";
import {
  hasNonEmbeddingQueryEvidenceRank,
  strictlyDominatesNonEmbeddingQueryEvidenceRanks
} from "../../scoring/query-evidence-support.js";

type EmbeddingDominanceCandidate = Readonly<Pick<
  CoarseRecallCandidate,
  "originPlane" | "objectKind"
> & {
  readonly fusion: Readonly<{
    readonly candidate_key: string;
    readonly per_stream_rank: RecallFusionStreamRanks;
  }>;
}>;

export function orderWithEmbeddingEvidenceDominance<T>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly sourceCandidates: readonly EmbeddingDominanceCandidate[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
  readonly keyOf: (candidate: T) => string;
}>): readonly T[] {
  const leader = selectUniqueEmbeddingLeader(params.sourceCandidates);
  if (leader === null) return params.candidates;
  if (!hasNonEmbeddingQueryEvidenceRank(
    leader.fusion.per_stream_rank,
    params.queryProbes
  )) return params.candidates;
  const sourceByKey = new Map(params.sourceCandidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate
  ]));
  const reordered = [...params.candidates];
  const originalLeaderIndex = reordered.findIndex(
    (candidate) => params.keyOf(candidate) === leader.fusion.candidate_key
  );
  let leaderIndex = originalLeaderIndex;
  if (leaderIndex < 0) return params.candidates;
  while (leaderIndex > 0 && mayDisplacePredecessor({
    predecessorKey: params.keyOf(reordered[leaderIndex - 1]!),
    leaderRanks: leader.fusion.per_stream_rank,
    sourceByKey,
    queryProbes: params.queryProbes,
    answerSupportByCandidateKey: params.answerSupportByCandidateKey
  })) {
    [reordered[leaderIndex - 1], reordered[leaderIndex]] = [
      reordered[leaderIndex]!,
      reordered[leaderIndex - 1]!
    ];
    leaderIndex -= 1;
  }
  return leaderIndex === originalLeaderIndex ? params.candidates : Object.freeze(reordered);
}

function selectUniqueEmbeddingLeader(
  candidates: readonly EmbeddingDominanceCandidate[]
): EmbeddingDominanceCandidate | null {
  const leaders = candidates.filter((candidate) =>
    isWorkspaceMemoryCandidate(candidate) &&
    candidate.fusion.per_stream_rank.embedding_similarity === 1
  );
  return leaders.length === 1 ? leaders[0]! : null;
}

function mayDisplacePredecessor(params: Readonly<{
  readonly predecessorKey: string;
  readonly leaderRanks: Readonly<RecallFusionStreamRanks>;
  readonly sourceByKey: ReadonlyMap<string, EmbeddingDominanceCandidate>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
}>): boolean {
  if (
    params.answerSupportByCandidateKey.get(params.predecessorKey)
      ?.authority?.behavior_eligible === true
  ) return false;
  const predecessor = params.sourceByKey.get(params.predecessorKey);
  if (predecessor === undefined || !isWorkspaceMemoryCandidate(predecessor)) {
    return false;
  }
  return strictlyDominatesNonEmbeddingQueryEvidenceRanks(
    params.leaderRanks,
    predecessor.fusion.per_stream_rank,
    params.queryProbes
  );
}
