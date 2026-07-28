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
  readonly behaviorGuardFullAbort: boolean;
}>;

export type EmbeddingRankConsensusDecision =
  | Readonly<{
      readonly status: "no_op";
      readonly reason: "no_finite_embedding_head" | "unchanged_consensus";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason:
        | "behavior_guard_full_abort"
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
}>;

export function resolveEmbeddingRankConsensusPlan<
  T extends EmbeddingRankConsensusCandidate
>(params: EmbeddingRankConsensusParams<T>): EmbeddingRankConsensusPlan<T> {
  const headWidth = resolveHeadWidth(params.baseline.length);
  const baselineHead = params.baseline.slice(0, headWidth);
  const immutableTail = params.baseline.slice(headWidth);
  const embeddingHeadByKey = indexEmbeddingHead(
    params.candidates,
    headWidth,
    candidateKeys(immutableTail)
  );
  const embeddingHead = [...embeddingHeadByKey.values()]
    .sort(compareEmbeddingHeadEntries);
  const consensusHead = rankConsensusHead(baselineHead, embeddingHeadByKey)
    .slice(0, headWidth)
    .map((entry) => entry.candidate);
  const proposedCandidates = [...consensusHead, ...immutableTail];
  const protectedCandidates = params.protectedCandidates.map((item) => ({ ...item }));
  const decision = resolveDecision({
    behaviorGuardFullAbort: params.behaviorGuardFullAbort,
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

  return deepFreeze({
    baseline: params.baseline,
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
        (embedding === undefined ? 0 : 1 / embedding.embeddingRank)
    }));
  });
  for (const [candidateKey, embedding] of embeddingHead) {
    if (entries.has(candidateKey)) continue;
    entries.set(candidateKey, Object.freeze({
      candidate: embedding.candidate,
      candidateKey,
      reciprocalScore: 1 / embedding.embeddingRank
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
  const fusedDelta = right.candidate.fusedScore - left.candidate.fusedScore;
  return fusedDelta !== 0
    ? fusedDelta
    : compareCandidateKeys(left.candidateKey, right.candidateKey);
}

function resolveDecision<T extends EmbeddingRankConsensusCandidate>(
  params: Readonly<{
    readonly behaviorGuardFullAbort: boolean;
    readonly baselineHead: readonly T[];
    readonly embeddingHead: readonly EmbeddingRankConsensusHeadEntry<T>[];
    readonly consensusHead: readonly T[];
    readonly proposedCandidates: readonly T[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
    readonly headWidth: number;
  }>
): EmbeddingRankConsensusDecision {
  if (params.embeddingHead.length === 0) {
    return { status: "no_op", reason: "no_finite_embedding_head" };
  }
  if (params.consensusHead.length !== params.headWidth) {
    return { status: "rejected", reason: "cardinality_mismatch" };
  }
  if (hasSameKeyOrder(params.consensusHead, params.baselineHead)) {
    return { status: "no_op", reason: "unchanged_consensus" };
  }
  if (params.behaviorGuardFullAbort) {
    return { status: "rejected", reason: "behavior_guard_full_abort" };
  }
  if (!protectionsAreSatisfied(
    params.proposedCandidates,
    params.protectedCandidates
  )) {
    return { status: "rejected", reason: "protected_candidate_constraint" };
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

function candidateKeys<T extends EmbeddingRankConsensusCandidate>(
  candidates: readonly T[]
): ReadonlySet<string> {
  return new Set(candidates.map((candidate) => candidate.candidateKey));
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
