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
  if (rankLimit < FUSION_FIELD_HEAD_LIMIT) return params.selection;
  const leader = uniqueFusionFieldLeader(params.selection.candidates);
  if (leader === undefined) return params.selection;
  const deliveredIndex = delivered.findIndex((candidate) =>
    params.keyOf(candidate) === leader.candidateKey);
  if (deliveredIndex >= 0 && deliveredIndex < rankLimit) {
    return addAnswerHeadProtection(params.selection, leader, rankLimit);
  }
  const victim = unprotectedHeadVictim(
    delivered, params.selection.protections, params.keyOf, rankLimit
  );
  if (victim === undefined) return params.selection;
  const reordered = params.selection.candidates.filter((candidate) =>
    params.keyOf(candidate) !== leader.candidateKey);
  const targetIndex = reordered.findIndex((candidate) =>
    params.keyOf(candidate) === params.keyOf(victim));
  if (targetIndex < 0) return params.selection;
  reordered.splice(targetIndex, 0, leader.candidate);
  return addAnswerHeadProtection(Object.freeze({
    ...params.selection,
    candidates: Object.freeze(reordered)
  }), leader, rankLimit);
}

function unprotectedHeadVictim<T>(
  delivered: readonly T[],
  protections: AnswerHeadSelection<T>["protections"],
  keyOf: (candidate: T) => string,
  rankLimit: number
): T | undefined {
  const protectedKeys = new Set(protections.map((item) => item.candidateKey));
  for (let index = rankLimit - 1; index >= 0; index -= 1) {
    const candidate = delivered[index];
    if (candidate !== undefined && !protectedKeys.has(keyOf(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

function uniqueFusionFieldLeader<T extends AnswerHeadSourceCandidate>(
  candidates: readonly T[]
): Readonly<{ candidate: T; candidateKey: string; index: number }> | undefined {
  const fusionLeaders = candidates.flatMap((candidate, index) =>
    isWorkspaceMemoryCandidate(candidate) && candidate.fusion.fused_rank === 1
      ? [{ candidate, candidateKey: candidate.fusion.candidate_key, index }]
      : []);
  return fusionLeaders.length === 1 ? fusionLeaders[0] : undefined;
}
