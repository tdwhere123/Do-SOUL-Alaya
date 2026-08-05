import {
  addAnswerHeadProtection,
  type AnswerHeadSelection
} from "../semantic-memory-refinement.js";

const BEHAVIOR_AUTHORITY_SEARCH_LIMIT = 10;

export function retainBehaviorAuthorityAnswerHead<T>(params: Readonly<{
  readonly selection: AnswerHeadSelection<T>;
  readonly rankLimit: number;
  readonly selectDelivered: (candidates: readonly T[]) => readonly T[];
  readonly keyOf: (candidate: T) => string;
  readonly isBehaviorEligible: (candidate: T) => boolean;
}>): AnswerHeadSelection<T> {
  const delivered = params.selectDelivered(params.selection.candidates);
  if (params.rankLimit <= 0 || delivered.length < params.rankLimit) {
    return params.selection;
  }
  const protectedHead = delivered
    .slice(0, params.rankLimit)
    .filter(params.isBehaviorEligible);
  if (protectedHead.length > 0) {
    return protectAll(params.selection, protectedHead, params);
  }
  const opportunities = delivered
    .slice(params.rankLimit, BEHAVIOR_AUTHORITY_SEARCH_LIMIT)
    .filter(params.isBehaviorEligible);
  if (opportunities.length !== 1) return params.selection;
  const boundary = delivered[params.rankLimit - 1];
  if (boundary === undefined) return params.selection;
  const promoted = moveBefore(
    params.selection.candidates,
    opportunities[0]!,
    boundary,
    params.keyOf
  );
  return protectAll(
    Object.freeze({ ...params.selection, candidates: promoted }),
    opportunities,
    params
  );
}

function protectAll<T>(
  selection: AnswerHeadSelection<T>,
  candidates: readonly T[],
  params: Readonly<{
    readonly rankLimit: number;
    readonly keyOf: (candidate: T) => string;
  }>
): AnswerHeadSelection<T> {
  return candidates.reduce(
    (current, candidate) => addAnswerHeadProtection(
      current,
      { candidateKey: params.keyOf(candidate) },
      params.rankLimit
    ),
    selection
  );
}

function moveBefore<T>(
  candidates: readonly T[],
  promoted: T,
  boundary: T,
  keyOf: (candidate: T) => string
): readonly T[] {
  const promotedKey = keyOf(promoted);
  const boundaryKey = keyOf(boundary);
  const ordered = candidates.filter((candidate) => keyOf(candidate) !== promotedKey);
  const boundaryIndex = ordered.findIndex((candidate) => keyOf(candidate) === boundaryKey);
  if (boundaryIndex < 0) return candidates;
  ordered.splice(boundaryIndex, 0, promoted);
  return Object.freeze(ordered);
}
