export interface BoundedHeadDisplacementParams<T> {
  readonly publicOrder: readonly T[];
  readonly headRankByKey: ReadonlyMap<string, number>;
  readonly keyOf: (candidate: T) => string;
  readonly maxDownwardDisplacement: number;
  readonly protectedRankLimit: number;
}

interface RankedCandidate<T> {
  readonly candidate: T;
  readonly key: string;
  readonly publicIndex: number;
  readonly headRank: number | null;
}

export function orderWithBoundedHeadDisplacement<T>(
  params: BoundedHeadDisplacementParams<T>
): readonly T[] {
  validateBounds(params.maxDownwardDisplacement, params.protectedRankLimit);
  const remaining = buildRankedCandidates(params);
  const ordered: RankedCandidate<T>[] = [];
  for (let position = 1; remaining.length > 0; position += 1) {
    const urgent = remaining
      .filter((item) => isUrgent(item, position, params))
      .sort(compareUrgent);
    const next = urgent[0] ?? remaining[0];
    if (next === undefined) break;
    ordered.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  assertDeadlines(ordered, params);
  return Object.freeze(ordered.map((item) => item.candidate));
}

function buildRankedCandidates<T>(
  params: BoundedHeadDisplacementParams<T>
): RankedCandidate<T>[] {
  const seenKeys = new Set<string>();
  const protectedRanks = new Set<number>();
  return params.publicOrder.map((candidate, publicIndex) => {
    const key = params.keyOf(candidate);
    if (seenKeys.has(key)) throw new Error("bounded final authority requires unique candidate keys");
    seenKeys.add(key);
    const headRank = params.headRankByKey.get(key) ?? null;
    if (headRank !== null && (!Number.isInteger(headRank) || headRank <= 0)) {
      throw new Error("head ranks must be positive integers");
    }
    if (headRank !== null && headRank <= params.protectedRankLimit) {
      if (protectedRanks.has(headRank)) throw new Error("protected head ranks must be unique");
      protectedRanks.add(headRank);
    }
    return { candidate, key, publicIndex, headRank };
  });
}

function isUrgent<T>(
  item: RankedCandidate<T>,
  position: number,
  params: BoundedHeadDisplacementParams<T>
): boolean {
  return item.headRank !== null && item.headRank <= params.protectedRankLimit &&
    item.headRank + params.maxDownwardDisplacement <= position;
}

function compareUrgent<T>(left: RankedCandidate<T>, right: RankedCandidate<T>): number {
  return (left.headRank ?? Number.MAX_SAFE_INTEGER) -
    (right.headRank ?? Number.MAX_SAFE_INTEGER) ||
    left.publicIndex - right.publicIndex || left.key.localeCompare(right.key);
}

function assertDeadlines<T>(
  ordered: readonly RankedCandidate<T>[],
  params: BoundedHeadDisplacementParams<T>
): void {
  for (const [index, item] of ordered.entries()) {
    if (item.headRank !== null && item.headRank <= params.protectedRankLimit &&
        index + 1 > item.headRank + params.maxDownwardDisplacement) {
      throw new Error(`bounded final authority could not satisfy head deadline for ${item.key}`);
    }
  }
}

function validateBounds(maxDownwardDisplacement: number, protectedRankLimit: number): void {
  if (!Number.isInteger(maxDownwardDisplacement) || maxDownwardDisplacement < 0) {
    throw new Error("maxDownwardDisplacement must be a non-negative integer");
  }
  if (!Number.isInteger(protectedRankLimit) || protectedRankLimit <= 0) {
    throw new Error("protectedRankLimit must be a positive integer");
  }
}
