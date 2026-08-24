import { deepFreeze } from "../../../shared/deep-freeze.js";

export type EmbeddingRankConsensusCandidate = Readonly<{
  readonly candidateKey: string;
  readonly fusedScore: number;
  readonly rawEmbeddingRank?: number;
}>;

export type EmbeddingRankConsensusProtection = Readonly<{
  readonly candidateKey: string;
  readonly rankLimit: number;
}>;

export type EmbeddingRankConsensusParams<
  T extends EmbeddingRankConsensusCandidate
> = Readonly<{
  readonly baseline: readonly T[];
  readonly candidates: readonly T[];
  readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
}>;

export type EmbeddingRankConsensusDecision =
  | Readonly<{
      readonly status: "no_op";
      readonly reason: "no_finite_embedding_head" | "unchanged_consensus";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason:
        | "cardinality_mismatch"
        | "protected_candidate_constraint";
    }>
  | Readonly<{
      readonly status: "accepted";
      readonly reason: "strict_tail_consensus";
    }>;

export type EmbeddingRankConsensusHeadEntry<T> = Readonly<{
  readonly candidate: T;
  readonly embeddingRank: number;
}>;

export type EmbeddingRankConsensusPlan<
  T extends EmbeddingRankConsensusCandidate
> = Readonly<{
  readonly baseline: readonly T[];
  readonly proposedCandidates: readonly T[];
  readonly candidates: readonly T[];
  readonly headWidth: number;
  readonly baselineHead: readonly T[];
  readonly embeddingHead: readonly EmbeddingRankConsensusHeadEntry<T>[];
  readonly consensusHead: readonly T[];
  readonly immutableTail: readonly T[];
  readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
  readonly decision: EmbeddingRankConsensusDecision;
}>;

type ConsensusEntry<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly reciprocalScore: number;
  readonly embeddingRank?: number;
}>;

type ScheduledProtection<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly deadline: number;
  readonly baselineRank: number;
}>;

export function resolveEmbeddingRankConsensusPlan<
  T extends EmbeddingRankConsensusCandidate
>(params: EmbeddingRankConsensusParams<T>): EmbeddingRankConsensusPlan<T> {
  const headWidth = resolveHeadWidth(params.baseline.length);
  const baselineHead = params.baseline.slice(0, headWidth);
  const baselineTail = params.baseline.slice(headWidth);
  const embeddingHeadByKey = indexEmbeddingHead(
    params.candidates,
    headWidth,
    new Set()
  );
  const embeddingHead = [...embeddingHeadByKey.values()]
    .sort(compareEmbeddingHeadEntries);
  const rankedConsensusHead = rankConsensusHead(baselineHead, embeddingHeadByKey)
    .slice(0, headWidth)
    .map((entry) => entry.candidate);
  const consensusHead = composeProtectedConsensusHead(
    rankedConsensusHead,
    baselineHead,
    baselineTail,
    params.protectedCandidates
  );
  const proposedCandidates = composeConsensusPacket(
    consensusHead, params.baseline
  );
  const protectedCandidates = params.protectedCandidates.map((item) => ({ ...item }));
  const decision = resolveDecision({
    baselineHead,
    embeddingHead,
    consensusHead,
    proposedCandidates,
    protectedCandidates,
    headWidth
  });
  const candidates = decision.status === "accepted"
    ? proposedCandidates
    : params.baseline;
  const immutableTail = proposedCandidates.slice(headWidth);

  return deepFreeze({
    baseline: params.baseline,
    proposedCandidates,
    candidates,
    headWidth,
    baselineHead,
    embeddingHead,
    consensusHead,
    immutableTail,
    protectedCandidates,
    decision
  });
}

function composeConsensusPacket<T extends EmbeddingRankConsensusCandidate>(
  consensusHead: readonly T[],
  baseline: readonly T[]
): readonly T[] {
  const headWidth = consensusHead.length;
  const baselineHead = baseline.slice(0, headWidth);
  const selectedBaselineKeys = new Set(
    consensusHead
      .map((candidate) => candidate.candidateKey)
      .filter((candidateKey) => baseline.some(
        (candidate) => candidate.candidateKey === candidateKey
      ))
  );
  const novelCount = headWidth - selectedBaselineKeys.size;
  const droppedBaselineHead = new Set(
    baselineHead
      .filter((candidate) => !selectedBaselineKeys.has(candidate.candidateKey))
      .slice(0, novelCount)
      .map((candidate) => candidate.candidateKey)
  );
  const droppedKeys = new Set([
    ...selectedBaselineKeys,
    ...droppedBaselineHead
  ]);
  return Object.freeze([
    ...consensusHead,
    ...baseline.filter((candidate) => !droppedKeys.has(candidate.candidateKey))
  ]);
}

export function entersEmbeddingRankConsensusHead<
  T extends EmbeddingRankConsensusCandidate
>(
  baselineHead: readonly T[],
  contender: T
): boolean {
  if (baselineHead.length === 0) return false;
  const embeddingHead = indexEmbeddingHead(
    [...baselineHead, contender],
    baselineHead.length,
    new Set()
  );
  return embeddingHead.has(contender.candidateKey) &&
    rankConsensusHead(baselineHead, embeddingHead)
      .slice(0, baselineHead.length)
      .some((entry) => entry.candidateKey === contender.candidateKey);
}

function composeProtectedConsensusHead<T extends EmbeddingRankConsensusCandidate>(
  consensusHead: readonly T[],
  baselineHead: readonly T[],
  immutableTail: readonly T[],
  protections: readonly EmbeddingRankConsensusProtection[]
): readonly T[] {
  const scheduled = scheduleHeadProtections(
    consensusHead, baselineHead, immutableTail, protections
  );
  if (scheduled === undefined || scheduled.length === 0) return consensusHead;
  const protectedKeys = new Set(scheduled.map((item) => item.candidateKey));
  const unprotected = consensusHead.filter(
    (candidate) => !protectedKeys.has(candidate.candidateKey)
  );
  const byRank = new Map(scheduled.map((item) => [item.deadline, item.candidate]));
  const composed = Array.from({ length: consensusHead.length }, (_, index) =>
    byRank.get(index + 1) ?? unprotected.shift()
  );
  return composed.every((candidate): candidate is T => candidate !== undefined)
    ? composed
    : consensusHead;
}

function scheduleHeadProtections<T extends EmbeddingRankConsensusCandidate>(
  consensusHead: readonly T[],
  baselineHead: readonly T[],
  immutableTail: readonly T[],
  protections: readonly EmbeddingRankConsensusProtection[]
): readonly ScheduledProtection<T>[] | undefined {
  const proposed = [...consensusHead, ...immutableTail];
  const baselineByKey = new Map(
    [...baselineHead, ...immutableTail].map((candidate, index) => [
      candidate.candidateKey,
      { candidate, baselineRank: index + 1 }
    ])
  );
  const scheduled: ScheduledProtection<T>[] = [];
  for (const protection of protections) {
    const proposedRank =
      proposed.findIndex((item) => item.candidateKey === protection.candidateKey) + 1;
    if (proposedRank > consensusHead.length && proposedRank <= protection.rankLimit) {
      continue;
    }
    const source = baselineByKey.get(protection.candidateKey);
    if (
      source === undefined ||
      !Number.isInteger(protection.rankLimit) ||
      protection.rankLimit <= 0
    ) return undefined;
    scheduled.push(Object.freeze({
      ...source,
      candidateKey: protection.candidateKey,
      deadline: proposedRank > 0 && proposedRank <= consensusHead.length
        ? Math.min(protection.rankLimit, proposedRank)
        : Math.min(protection.rankLimit, consensusHead.length)
    }));
  }
  return assignProtectionRanks(scheduled);
}

function assignProtectionRanks<T>(
  protections: readonly ScheduledProtection<T>[]
): readonly ScheduledProtection<T>[] | undefined {
  const ordered = [...protections].sort((left, right) =>
    left.deadline - right.deadline ||
    left.baselineRank - right.baselineRank ||
    compareCandidateKeys(left.candidateKey, right.candidateKey)
  );
  let nextRank = Number.POSITIVE_INFINITY;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const current = ordered[index]!;
    nextRank = Math.min(current.deadline, nextRank - 1);
    if (nextRank <= 0) return undefined;
    ordered[index] = Object.freeze({ ...current, deadline: nextRank });
  }
  return ordered;
}

function resolveHeadWidth(baselineLength: number): number {
  return Math.ceil(baselineLength / 2);
}

function indexEmbeddingHead<T extends EmbeddingRankConsensusCandidate>(
  candidates: readonly T[],
  headWidth: number,
  excludedKeys: ReadonlySet<string>
): ReadonlyMap<string, EmbeddingRankConsensusHeadEntry<T>> {
  const byKey = new Map<string, EmbeddingRankConsensusHeadEntry<T>>();
  for (const candidate of candidates) {
    const rank = candidate.rawEmbeddingRank;
    if (!isEligibleEmbeddingRank(rank, headWidth)) continue;
    if (excludedKeys.has(candidate.candidateKey)) continue;
    const incumbent = byKey.get(candidate.candidateKey);
    if (
      incumbent === undefined ||
      rank < incumbent.embeddingRank ||
      (rank === incumbent.embeddingRank &&
        candidate.fusedScore > incumbent.candidate.fusedScore)
    ) {
      byKey.set(candidate.candidateKey, Object.freeze({
        candidate,
        embeddingRank: rank
      }));
    }
  }
  return byKey;
}

function isEligibleEmbeddingRank(
  rank: number | undefined,
  headWidth: number
): rank is number {
  return rank !== undefined &&
    Number.isFinite(rank) &&
    rank > 0 &&
    rank <= headWidth;
}

function rankConsensusHead<T extends EmbeddingRankConsensusCandidate>(
  baselineHead: readonly T[],
  embeddingHead: ReadonlyMap<string, EmbeddingRankConsensusHeadEntry<T>>
): readonly ConsensusEntry<T>[] {
  const entries = new Map<string, ConsensusEntry<T>>();
  baselineHead.forEach((candidate, index) => {
    if (entries.has(candidate.candidateKey)) return;
    const embedding = embeddingHead.get(candidate.candidateKey);
    entries.set(candidate.candidateKey, Object.freeze({
      candidate,
      candidateKey: candidate.candidateKey,
      reciprocalScore: 1 / (index + 1) +
        (embedding === undefined ? 0 : 1 / embedding.embeddingRank),
      ...(embedding === undefined
        ? {}
        : { embeddingRank: embedding.embeddingRank })
    }));
  });
  for (const [candidateKey, embedding] of embeddingHead) {
    if (entries.has(candidateKey)) continue;
    entries.set(candidateKey, Object.freeze({
      candidate: embedding.candidate,
      candidateKey,
      reciprocalScore: 1 / embedding.embeddingRank,
      embeddingRank: embedding.embeddingRank
    }));
  }
  return [...entries.values()].sort(compareConsensusEntries);
}

function compareEmbeddingHeadEntries<T extends EmbeddingRankConsensusCandidate>(
  left: EmbeddingRankConsensusHeadEntry<T>,
  right: EmbeddingRankConsensusHeadEntry<T>
): number {
  const rankDelta = left.embeddingRank - right.embeddingRank;
  if (rankDelta !== 0) return rankDelta;
  const fusedDelta = right.candidate.fusedScore - left.candidate.fusedScore;
  return fusedDelta !== 0
    ? fusedDelta
    : compareCandidateKeys(
        left.candidate.candidateKey,
        right.candidate.candidateKey
      );
}

function compareConsensusEntries<T extends EmbeddingRankConsensusCandidate>(
  left: ConsensusEntry<T>,
  right: ConsensusEntry<T>
): number {
  const reciprocalDelta = right.reciprocalScore - left.reciprocalScore;
  if (reciprocalDelta !== 0) return reciprocalDelta;
  const embeddingDelta = compareOptionalRanks(
    left.embeddingRank,
    right.embeddingRank
  );
  if (embeddingDelta !== 0) return embeddingDelta;
  const fusedDelta = right.candidate.fusedScore - left.candidate.fusedScore;
  return fusedDelta !== 0
    ? fusedDelta
    : compareCandidateKeys(left.candidateKey, right.candidateKey);
}

function compareOptionalRanks(
  left: number | undefined,
  right: number | undefined
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function resolveDecision<T extends EmbeddingRankConsensusCandidate>(
  params: Readonly<{
    readonly baselineHead: readonly T[];
    readonly embeddingHead: readonly EmbeddingRankConsensusHeadEntry<T>[];
    readonly consensusHead: readonly T[];
    readonly proposedCandidates: readonly T[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
    readonly headWidth: number;
  }>
): EmbeddingRankConsensusDecision {
  if (params.consensusHead.length !== params.headWidth) {
    return { status: "rejected", reason: "cardinality_mismatch" };
  }
  const consensusChanged = !hasSameKeyOrder(
    params.consensusHead,
    params.baselineHead
  );
  if (!consensusChanged) {
    return params.embeddingHead.length === 0
      ? { status: "no_op", reason: "no_finite_embedding_head" }
      : { status: "no_op", reason: "unchanged_consensus" };
  }
  if (!protectionsAreSatisfied(
    params.proposedCandidates,
    params.protectedCandidates
  )) {
    return { status: "rejected", reason: "protected_candidate_constraint" };
  }
  if (params.embeddingHead.length === 0) {
    return { status: "accepted", reason: "strict_tail_consensus" };
  }
  return { status: "accepted", reason: "strict_tail_consensus" };
}

function protectionsAreSatisfied<T extends EmbeddingRankConsensusCandidate>(
  candidates: readonly T[],
  protections: readonly EmbeddingRankConsensusProtection[]
): boolean {
  const rankByKey = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (!rankByKey.has(candidate.candidateKey)) {
      rankByKey.set(candidate.candidateKey, index + 1);
    }
  });
  return protections.every((protection) => {
    const rank = rankByKey.get(protection.candidateKey);
    return rank !== undefined &&
      Number.isFinite(protection.rankLimit) &&
      rank <= protection.rankLimit;
  });
}

function hasSameKeyOrder<T extends EmbeddingRankConsensusCandidate>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return left.length === right.length &&
    left.every((candidate, index) =>
      candidate.candidateKey === right[index]?.candidateKey
    );
}

function compareCandidateKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
