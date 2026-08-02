import { deepFreeze } from "../../../shared/deep-freeze.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection/types.js";
import type {
  FinalPacketConsensusCandidate,
  FinalPacketConsensusMembershipGovernance,
  FinalPacketConsensusPlan
} from "../final-order/final-packet-consensus.js";
import { applyMembershipGovernance } from
  "../final-order/final-packet-consensus.js";

export function applyLexicographicNestedMembership(params: Readonly<{
  readonly plan: FinalPacketConsensusPlan;
  readonly sourceCandidates: readonly FineAssessmentCandidate[];
  readonly headKeys: readonly string[];
  readonly packKeys: readonly string[];
  readonly membershipGovernance?: FinalPacketConsensusMembershipGovernance;
}>): FinalPacketConsensusPlan {
  if (!validNestedKeys(params) || params.membershipGovernance === undefined) {
    return params.plan;
  }
  const sourceCandidates = params.sourceCandidates.map(toConsensusCandidate);
  const sourceByKey = new Map(sourceCandidates.map((candidate) => [
    candidate.candidateKey, candidate
  ]));
  const requested = resolveCandidates(params.packKeys, sourceByKey);
  if (requested.length !== params.packKeys.length) return params.plan;
  const head = stabilizeRetainedHeadOrder(
    requested.slice(0, params.headKeys.length),
    params.plan.baseline.slice(0, params.headKeys.length)
  );
  const candidates = Object.freeze([
    ...head,
    ...requested.slice(params.headKeys.length)
  ]);
  if (!protectionsSatisfied(candidates, params.plan)) return params.plan;
  if (sameOrder(candidates, params.plan.candidates)) return params.plan;
  if (sameOrder(head, params.plan.baseline.slice(0, head.length))) return params.plan;
  const proposal = deepFreeze({
    ...params.plan,
    candidates,
    headWidth: head.length,
    baselineHead: params.plan.baseline.slice(0, head.length),
    consensusHead: head,
    immutableTail: candidates.slice(head.length),
    membershipAuthorizations: [],
    tailPolicy: "nested_membership_exchange" as const,
    decision: {
      status: "accepted" as const,
      reason: "nested_membership_consensus" as const
    }
  });
  return applyMembershipGovernance(
    proposal, params.membershipGovernance, sourceCandidates, sourceByKey
  );
}

function stabilizeRetainedHeadOrder(
  requestedHead: readonly FinalPacketConsensusCandidate[],
  baselineHead: readonly FinalPacketConsensusCandidate[]
): readonly FinalPacketConsensusCandidate[] {
  const requestedKeys = new Set(
    requestedHead.map((candidate) => candidate.candidateKey)
  );
  const retained = baselineHead.filter((candidate) =>
    requestedKeys.has(candidate.candidateKey)
  );
  let retainedIndex = 0;
  return Object.freeze(requestedHead.map((candidate) => {
    const isRetained = baselineHead.some((baseline) =>
      baseline.candidateKey === candidate.candidateKey
    );
    return isRetained ? retained[retainedIndex++]! : candidate;
  }));
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
  byKey: ReadonlyMap<string, FinalPacketConsensusCandidate>
): readonly FinalPacketConsensusCandidate[] {
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
