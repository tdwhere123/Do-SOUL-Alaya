import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { resolveFusionContribution, type ResolvedRecallFusionWeights } from "./fusion-delivery-adaptive-scoring.js";
import type {
  KeyedRecallFusionCandidate,
  RecallFusionCandidateInput,
  RecallFusionCandidateStreamSnapshot
} from "./fusion-delivery-scoring-candidate.js";
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
  return params.candidates.map((candidate) => buildCandidateStreamSnapshot(candidate, params));
}

function buildCandidateStreamSnapshot(
  keyed: KeyedRecallFusionCandidate,
  params: Parameters<typeof buildFusionCandidateStreamSnapshots>[0]
): RecallFusionCandidateStreamSnapshot {
  const perStreamRank = {} as Record<RecallFusionStream, number | null>;
  const contributions = {} as Record<RecallFusionStream, number>;
  let objectBase = 0;
  for (const stream of activeFusionStreams()) {
    const rank = params.ranksByStream.get(stream)?.get(keyed.candidateKey) ?? null;
    const contribution = rank === null ? 0 : resolveFusionContribution({
      candidate: keyed.candidate,
      supplementaryData: params.supplementaryData,
      resolved: params.resolved,
      stream,
      rank
    });
    perStreamRank[stream] = rank;
    contributions[stream] = contribution;
    objectBase += contribution;
  }
  return Object.freeze({
    ...keyed,
    perStreamRank: Object.freeze(perStreamRank) as RecallFusionStreamRanks,
    contributions: Object.freeze(contributions) as RecallFusionStreamContributions,
    objectBase
  });
}
