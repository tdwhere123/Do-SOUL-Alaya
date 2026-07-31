import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { deepFreeze } from "../../../shared/deep-freeze.js";
import { CoreError } from "../../../shared/errors.js";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection.js";
import {
  resolveEmbeddingRankConsensusPlan,
  type EmbeddingRankConsensusPlan,
  type EmbeddingRankConsensusProtection
} from "../packet-plan/embedding-rank-consensus.js";
import type { RecallPacketPlanObservation } from
  "../packet-plan/packet-plan-trace.js";

export type FinalPacketConsensusCandidate = Readonly<{
  readonly candidateKey: string;
  readonly fusedScore: number;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

export type FinalPacketConsensusPlan =
  EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>;

export function resolveFinalPacketConsensusPlan(
  params: Readonly<{
    readonly baseline: readonly Readonly<RecallCandidate>[];
    readonly sourceCandidates: readonly FineAssessmentCandidate[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
    readonly behaviorGuardFullAbort: boolean;
  }>
): FinalPacketConsensusPlan {
  const consensusCandidates = params.sourceCandidates.map(toConsensusCandidate);
  const sourceByKey = new Map(consensusCandidates.map((candidate) => [
    candidate.candidateKey,
    candidate
  ]));
  const baseline = params.baseline.flatMap((candidate) => {
    const source = sourceByKey.get(buildRecallCandidateSelectionKey(candidate));
    return source === undefined ? [] : [source];
  });
  if (baseline.length !== params.baseline.length) {
    throw new CoreError(
      "VALIDATION",
      "Final packet consensus could not resolve every baseline candidate"
    );
  }
  return resolveEmbeddingRankConsensusPlan({
    baseline,
    candidates: consensusCandidates,
    protectedCandidates: params.protectedCandidates,
    behaviorGuardFullAbort: params.behaviorGuardFullAbort
  });
}

export function buildFinalPacketConsensusObservation(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[],
  replayAccepted: boolean
): RecallPacketPlanObservation {
  const headKeys = new Set(
    plan.consensusHead.map((candidate) => candidate.candidateKey)
  );
  const residualProposal = [
    ...plan.consensusHead,
    ...plan.baseline.filter((candidate) => !headKeys.has(candidate.candidateKey))
  ];
  const immutableProposal = [
    ...plan.consensusHead,
    ...plan.immutableTail.filter((candidate) => !headKeys.has(candidate.candidateKey))
  ];
  const proposed = plan.decision.status === "accepted"
    ? plan.candidates
    : residualProposal.length === plan.baseline.length
      ? residualProposal
      : immutableProposal;
  const decision = plan.decision.status === "accepted" && !replayAccepted
    ? { status: "rejected", reason: "admission_infeasible" } as const
    : plan.decision;
  return deepFreeze({
    baseline_candidate_keys: candidateKeys(plan.baseline),
    planned_candidate_keys: candidateKeys(proposed),
    actual_candidate_keys: actual.map(buildRecallCandidateSelectionKey),
    head_width: plan.headWidth,
    baseline_head_candidate_keys: candidateKeys(plan.baselineHead),
    embedding_head: plan.embeddingHead.map((entry) => Object.freeze({
      candidate_key: entry.candidate.candidateKey,
      embedding_rank: entry.embeddingRank
    })),
    consensus_head_candidate_keys: candidateKeys(plan.consensusHead),
    immutable_tail_candidate_keys: candidateKeys(plan.immutableTail),
    protected_candidates: plan.protectedCandidates.map((entry) => Object.freeze({
      candidate_key: entry.candidateKey,
      rank_limit: entry.rankLimit
    })),
    decision
  });
}

export function buildConsensusReplayOrder(
  plan: FinalPacketConsensusPlan,
  sourceCandidates: readonly FineAssessmentCandidate[]
): readonly FineAssessmentCandidate[] {
  const planned = plan.candidates.map((candidate) => candidate.sourceCandidate);
  const plannedKeys = new Set(plan.candidates.map((candidate) => candidate.candidateKey));
  return Object.freeze([
    ...planned,
    ...sourceCandidates.filter(
      (candidate) => !plannedKeys.has(buildRecallCandidateDedupeKey(candidate))
    )
  ]);
}

export function packetMatchesConsensusPlan(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[]
): boolean {
  return plan.candidates.length === actual.length &&
    plan.candidates.every(
      (candidate, index) =>
        candidate.candidateKey === buildRecallCandidateSelectionKey(actual[index]!)
    );
}

function toConsensusCandidate(
  candidate: FineAssessmentCandidate
): FinalPacketConsensusCandidate {
  const rawEmbeddingRank =
    candidate.fusion.per_stream_rank.embedding_similarity;
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    fusedScore: candidate.fusion.fused_score,
    ...(rawEmbeddingRank === null
      ? {}
      : { rawEmbeddingRank }),
    sourceCandidate: candidate
  });
}

function candidateKeys(
  candidates: readonly FinalPacketConsensusCandidate[]
): readonly string[] {
  return Object.freeze(candidates.map((candidate) => candidate.candidateKey));
}
