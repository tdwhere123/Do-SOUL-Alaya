import type { RecallQueryProbes } from
  "../../../query/recall-query-probes.js";
import {
  buildRecallCandidateDedupeKey
} from "../../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown
} from "../../../runtime/recall-service-types.js";
import { scoreQueryEvidenceMatch } from
  "../../../scoring/query-evidence-scoring.js";
import { entersEmbeddingRankConsensusHead } from
  "../../packet-plan/embedding-rank-consensus.js";

export const DIRECT_EVIDENCE_SCORE_FLOOR = 0.2;
export const DIRECT_EVIDENCE_SCORE_MARGIN = 0.15;

export type AnswerHeadSourceCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveFactors: Readonly<{ readonly embedding_similarity?: number }>;
  readonly fusion: RecallFusionBreakdown;
}>;

type AnswerHeadProtection = Readonly<{
  readonly candidateKey: string;
  readonly rankLimit: number;
}>;

export function retainBoundedAnswerHeads<T>(
  candidates: readonly T[],
  protections: readonly AnswerHeadProtection[],
  keyOf: (candidate: T) => string,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly AnswerHeadSourceCandidate[],
  blocksConsensusDisplacement: (candidateKey: string) => boolean
): readonly T[] {
  return [...protections]
    .sort(compareProtections)
    .reduce(
      (ordered, protection) => retainBoundedAnswerHead(
        ordered, protection, keyOf, queryProbes, sourceCandidates,
        blocksConsensusDisplacement
      ),
      candidates
    );
}

export function findAnswerHeadSourceCandidate<T extends AnswerHeadSourceCandidate>(
  candidates: readonly T[],
  candidateKey: string
): T | undefined {
  return candidates.find((candidate) =>
    buildRecallCandidateDedupeKey(candidate) === candidateKey);
}

export function hasRequiredQueryMargin(
  candidateScore: number,
  victimEntry: AnswerHeadSourceCandidate["entry"],
  queryProbes: Readonly<RecallQueryProbes>
): boolean {
  return candidateScore >= DIRECT_EVIDENCE_SCORE_FLOOR &&
    candidateScore - scoreQueryEvidenceMatch(victimEntry, queryProbes) >=
      DIRECT_EVIDENCE_SCORE_MARGIN;
}

function retainBoundedAnswerHead<T>(
  candidates: readonly T[],
  protection: AnswerHeadProtection,
  keyOf: (candidate: T) => string,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly AnswerHeadSourceCandidate[],
  blocksConsensusDisplacement: (candidateKey: string) => boolean
): readonly T[] {
  const index = candidates.findIndex(
    (candidate) => keyOf(candidate) === protection.candidateKey
  );
  if (index < protection.rankLimit) return candidates;
  if (protection.rankLimit === 1) {
    return moveToRank(candidates, index, protection.rankLimit);
  }
  const protectedSource = findAnswerHeadSourceCandidate(
    sourceCandidates, protection.candidateKey
  );
  const victimSource = findAnswerHeadSourceCandidate(
    sourceCandidates, keyOf(candidates[protection.rankLimit - 1]!)
  );
  if (
    protectedSource === undefined ||
    victimSource === undefined ||
    !canDisplaceHead(
      candidates, protection.rankLimit, keyOf,
      protectedSource, victimSource, queryProbes, sourceCandidates,
      blocksConsensusDisplacement(keyOf(candidates[protection.rankLimit - 1]!))
    )
  ) return candidates;
  return moveToRank(candidates, index, protection.rankLimit);
}

function canDisplaceHead<T>(
  candidates: readonly T[],
  headWidth: number,
  keyOf: (candidate: T) => string,
  protectedSource: AnswerHeadSourceCandidate,
  victimSource: AnswerHeadSourceCandidate,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly AnswerHeadSourceCandidate[],
  consensusVictimBlocked: boolean
): boolean {
  if (hasRequiredQueryMargin(
    scoreQueryEvidenceMatch(protectedSource.entry, queryProbes),
    victimSource.entry,
    queryProbes
  )) return true;
  if (consensusVictimBlocked) return false;
  const baselineHead = candidates.slice(0, headWidth).flatMap((candidate) => {
    const source = findAnswerHeadSourceCandidate(sourceCandidates, keyOf(candidate));
    return source === undefined ? [] : [toConsensusCandidate(source)];
  });
  return baselineHead.length === headWidth &&
    entersEmbeddingRankConsensusHead(
      baselineHead,
      toConsensusCandidate(protectedSource)
    );
}

function toConsensusCandidate(candidate: AnswerHeadSourceCandidate) {
  const rawEmbeddingRank =
    candidate.fusion.per_stream_rank.embedding_similarity;
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    fusedScore: candidate.fusion.fused_score,
    ...(rawEmbeddingRank === null ? {} : { rawEmbeddingRank })
  });
}

function moveToRank<T>(
  candidates: readonly T[],
  index: number,
  rankLimit: number
): readonly T[] {
  const reordered = [...candidates];
  const [candidate] = reordered.splice(index, 1);
  reordered.splice(rankLimit - 1, 0, candidate!);
  return Object.freeze(reordered);
}

function compareProtections(
  left: AnswerHeadProtection,
  right: AnswerHeadProtection
): number {
  return left.rankLimit - right.rankLimit ||
    left.candidateKey.localeCompare(right.candidateKey);
}
