import { isWorkspaceMemoryCandidate } from
  "../../../runtime/recall-service-helpers.js";
import {
  addAnswerHeadProtection,
  type AnswerHeadSelection
} from "../semantic-memory-refinement.js";
import type { AnswerHeadSourceCandidate } from "./answer-head-retention.js";

const FUSION_FIELD_HEAD_LIMIT = 5;

export function retainUniqueFusionFieldLeader<
  T extends AnswerHeadSourceCandidate
>(params: Readonly<{
  readonly selection: AnswerHeadSelection<T>;
  readonly maxEntries: number;
  readonly selectDelivered: (candidates: readonly T[]) => readonly T[];
  readonly keyOf: (candidate: T) => string;
}>): AnswerHeadSelection<T> {
  const delivered = params.selectDelivered(params.selection.candidates);
  const rankLimit = Math.min(
    FUSION_FIELD_HEAD_LIMIT, params.maxEntries, delivered.length
  );
  if (rankLimit <= 0) return params.selection;
  const leader = uniqueFusionLexicalLeader(params.selection.candidates);
  if (leader === undefined) return params.selection;
  const deliveredIndex = delivered.findIndex((candidate) =>
    params.keyOf(candidate) === leader.candidateKey);
  if (deliveredIndex >= 0 && deliveredIndex < rankLimit) {
    return addAnswerHeadProtection(params.selection, leader, rankLimit);
  }
  const reordered = params.selection.candidates.filter((candidate) =>
    params.keyOf(candidate) !== leader.candidateKey);
  const victim = delivered[rankLimit - 1];
  if (victim === undefined) return params.selection;
  const targetIndex = reordered.findIndex((candidate) =>
    params.keyOf(candidate) === params.keyOf(victim));
  if (targetIndex < 0) return params.selection;
  reordered.splice(targetIndex, 0, leader.candidate);
  return addAnswerHeadProtection(Object.freeze({
    ...params.selection,
    candidates: Object.freeze(reordered)
  }), leader, rankLimit);
}

function uniqueFusionLexicalLeader<T extends AnswerHeadSourceCandidate>(
  candidates: readonly T[]
): Readonly<{ candidate: T; candidateKey: string; index: number }> | undefined {
  const fusionLeaders = candidates.flatMap((candidate, index) =>
    isWorkspaceMemoryCandidate(candidate) && candidate.fusion.fused_rank === 1
      ? [{ candidate, candidateKey: candidate.fusion.candidate_key, index }]
      : []);
  if (fusionLeaders.length !== 1) return undefined;
  const leader = fusionLeaders[0]!;
  if (leader.candidate.fusion.per_stream_rank.lexical_fts !== 1) {
    return undefined;
  }
  const lexicalLeaders = candidates.filter((candidate) =>
    isWorkspaceMemoryCandidate(candidate) &&
    candidate.fusion.per_stream_rank.lexical_fts === 1);
  return lexicalLeaders.length === 1 ? leader : undefined;
}
