import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  buildConflictGateContext,
  resolveFusionContribution,
  selectWouldOutrankSuppressedKeys,
  zeroConflictStreamContributions,
  type ConflictGateContext,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import type {
  KeyedRecallFusionCandidate,
  RecallFusionCandidateInput,
  RecallFusionCandidateStreamSnapshot
} from "./fusion-delivery-scoring-candidate.js";
import { aggregateFamilyContributions } from "./fusion-delivery-families.js";
import { activeFusionStreams } from "./fusion-delivery-streams.js";

export function keyRecallFusionCandidates(
  candidates: readonly RecallFusionCandidateInput[]
): readonly KeyedRecallFusionCandidate[] {
  return candidates.map((candidate) => Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    candidate
  }));
}

export function buildFusionCandidateStreamSnapshots(params: Readonly<{
  readonly candidates: readonly KeyedRecallFusionCandidate[];
  readonly ranksByStream: ReadonlyMap<RecallFusionStream, ReadonlyMap<string, number>>;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly supplementaryData: RecallSupplementaryData;
}>): readonly RecallFusionCandidateStreamSnapshot[] {
  const conflictGate = buildConflictGateContext({
    candidateKeys: params.candidates.map((candidate) => candidate.candidateKey),
    embeddingRanks: params.ranksByStream.get("embedding_similarity"),
    embeddingScores: collectEmbeddingScores(params.candidates, params.supplementaryData)
  });
  const rawSnapshots = params.candidates.map((candidate) =>
    collectRawCandidateContributions(candidate, params, conflictGate)
  );
  const contributionsByKey = new Map(
    rawSnapshots.map((snapshot) => [snapshot.candidateKey, snapshot.rawContributions] as const)
  );
  const suppressedKeys = selectWouldOutrankSuppressedKeys({
    gate: conflictGate,
    contributionsByKey
  });
  return rawSnapshots.map((snapshot) => finalizeCandidateStreamSnapshot(snapshot, suppressedKeys));
}

function collectEmbeddingScores(
  candidates: readonly KeyedRecallFusionCandidate[],
  supplementaryData: RecallSupplementaryData
): Readonly<Record<string, number>> {
  const scores: Record<string, number> = {
    ...(supplementaryData.embeddingSimilarityScores ?? {})
  };
  for (const { candidate } of candidates) {
    const factor = candidate.effectiveFactors.embedding_similarity;
    if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) {
      scores[candidate.entry.object_id] ??= factor;
    }
  }
  return Object.freeze(scores);
}

type RawCandidateContributions = Readonly<{
  readonly candidateKey: string;
  readonly keyed: KeyedRecallFusionCandidate;
  readonly perStreamRank: RecallFusionStreamRanks;
  readonly rawContributions: RecallFusionStreamContributions;
}>;

function collectRawCandidateContributions(
  keyed: KeyedRecallFusionCandidate,
  params: Parameters<typeof buildFusionCandidateStreamSnapshots>[0],
  conflictGate: ConflictGateContext
): RawCandidateContributions {
  const perStreamRank = {} as Record<RecallFusionStream, number | null>;
  const rawContributions = {} as Record<RecallFusionStream, number>;
  for (const stream of activeFusionStreams()) {
    const rank = params.ranksByStream.get(stream)?.get(keyed.candidateKey) ?? null;
    const contribution = rank === null ? 0 : resolveFusionContribution({
      candidate: keyed.candidate,
      supplementaryData: params.supplementaryData,
      resolved: params.resolved,
      stream,
      rank,
      candidateKey: keyed.candidateKey,
      conflictGate
    });
    perStreamRank[stream] = rank;
    rawContributions[stream] = contribution;
  }
  return Object.freeze({
    candidateKey: keyed.candidateKey,
    keyed,
    perStreamRank: Object.freeze(perStreamRank) as RecallFusionStreamRanks,
    rawContributions: Object.freeze(rawContributions) as RecallFusionStreamContributions
  });
}

function finalizeCandidateStreamSnapshot(
  snapshot: RawCandidateContributions,
  suppressedKeys: ReadonlySet<string>
): RecallFusionCandidateStreamSnapshot {
  const contributions = suppressedKeys.has(snapshot.candidateKey)
    ? Object.freeze(zeroConflictStreamContributions({ ...snapshot.rawContributions }))
    : snapshot.rawContributions;
  // Per-stream contributions stay for diagnostics; objectBase is the decorrelated family vote sum.
  // Conflict suppression runs on member lanes before this max-aggregation.
  const objectBase = aggregateFamilyContributions(contributions);
  return Object.freeze({
    ...snapshot.keyed,
    perStreamRank: snapshot.perStreamRank,
    contributions: contributions as RecallFusionStreamContributions,
    objectBase
  });
}
