import { deepFreeze } from "../../../shared/deep-freeze.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection/types.js";
import type {
  FinalPacketConsensusCandidate,
  FinalPacketConsensusPlan
} from "../final-order/final-packet-consensus.js";

export function applyLexicographicNestedMembership(params: Readonly<{
  readonly plan: FinalPacketConsensusPlan;
  readonly sourceCandidates: readonly FineAssessmentCandidate[];
  readonly headKeys: readonly string[];
  readonly packKeys: readonly string[];
}>): FinalPacketConsensusPlan {
  if (!validNestedKeys(params)) return params.plan;
  const candidates = resolveCandidates(params.packKeys, params.sourceCandidates);
  if (candidates.length !== params.packKeys.length ||
      !protectionsSatisfied(candidates, params.plan)) return params.plan;
  if (sameOrder(candidates, params.plan.candidates)) return params.plan;
  const head = candidates.slice(0, params.headKeys.length);
  if (sameOrder(head, params.plan.baseline.slice(0, head.length))) return params.plan;
  return deepFreeze({
    ...params.plan,
    candidates,
    headWidth: head.length,
    baselineHead: params.plan.baseline.slice(0, head.length),
    consensusHead: head,
    immutableTail: candidates.slice(head.length),
    tailPolicy: "nested_membership_exchange" as const,
    decision: {
      status: "accepted" as const,
      reason: "nested_membership_consensus" as const
    }
  });
}

function validNestedKeys(params: Parameters<
  typeof applyLexicographicNestedMembership
>[0]): boolean {
  return params.packKeys.length === params.plan.candidates.length &&
    params.headKeys.length <= params.packKeys.length &&
    params.headKeys.every((key, index) => params.packKeys[index] === key);
}

function resolveCandidates(
  keys: readonly string[],
  source: readonly FineAssessmentCandidate[]
): readonly FinalPacketConsensusCandidate[] {
  const byKey = new Map(source.map((candidate) => {
    const projected = toConsensusCandidate(candidate);
    return [projected.candidateKey, projected] as const;
  }));
  return keys.flatMap((key) => byKey.get(key) ?? []);
}

function toConsensusCandidate(
  sourceCandidate: FineAssessmentCandidate
): FinalPacketConsensusCandidate {
  const rank = sourceCandidate.fusion.per_stream_rank.embedding_similarity;
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(sourceCandidate),
    fusedScore: sourceCandidate.fusion.fused_score,
    ...(rank === null ? {} : { rawEmbeddingRank: rank }),
    sourceCandidate
  });
}

function protectionsSatisfied(
  candidates: readonly FinalPacketConsensusCandidate[],
  plan: FinalPacketConsensusPlan
): boolean {
  return plan.protectedCandidates.every(({ candidateKey, rankLimit }) => {
    const rank = candidates.findIndex((candidate) =>
      candidate.candidateKey === candidateKey
    ) + 1;
    return rank > 0 && rank <= rankLimit;
  });
}

function sameOrder(
  left: readonly FinalPacketConsensusCandidate[],
  right: readonly FinalPacketConsensusCandidate[]
): boolean {
  return left.length === right.length && left.every(
    (candidate, index) => candidate.candidateKey === right[index]?.candidateKey
  );
}
