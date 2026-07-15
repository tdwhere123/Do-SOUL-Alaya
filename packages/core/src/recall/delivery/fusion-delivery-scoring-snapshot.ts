import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  resolveFusionContribution,
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
  return params.candidates.map((candidate) =>
    finalizeCandidateStreamSnapshot(collectRawCandidateContributions(candidate, params))
  );
}

type RawCandidateContributions = Readonly<{
  readonly candidateKey: string;
  readonly keyed: KeyedRecallFusionCandidate;
  readonly perStreamRank: RecallFusionStreamRanks;
  readonly rawContributions: RecallFusionStreamContributions;
}>;

function collectRawCandidateContributions(
  keyed: KeyedRecallFusionCandidate,
  params: Parameters<typeof buildFusionCandidateStreamSnapshots>[0]
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
      rank
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
  snapshot: RawCandidateContributions
): RecallFusionCandidateStreamSnapshot {
  const contributions = snapshot.rawContributions;
  const objectBase = aggregateFamilyContributions(contributions);
  return Object.freeze({
    ...snapshot.keyed,
    perStreamRank: snapshot.perStreamRank,
    contributions: contributions as RecallFusionStreamContributions,
    objectBase
  });
}
