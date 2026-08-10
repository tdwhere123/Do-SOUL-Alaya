import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { deepFreeze } from "../../../shared/deep-freeze.js";
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
  "../packet-plan/packet-plan-observation.js";
import { assertRecallPacketPlanObservation } from
  "../packet-plan/packet-plan-observation.js";

export type FinalPacketConsensusCandidate = Readonly<{
  readonly candidateKey: string;
  readonly fusedScore: number;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

export type FinalPacketConsensusPlan =
  EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> & Readonly<{
    readonly tailPolicy?: "head_tail_exchange";
  }>;

export function resolveFinalPacketConsensusPlan(
  params: Readonly<{
    readonly baseline: readonly FineAssessmentCandidate[];
    readonly sourceCandidates: readonly FineAssessmentCandidate[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
  }>
): FinalPacketConsensusPlan {
  const consensusCandidates = params.sourceCandidates.map(toConsensusCandidate);
  const baseline = params.baseline.map(toConsensusCandidate);
  const baselineKeys = new Set(baseline.map((candidate) => candidate.candidateKey));
  const baselineProtections = params.protectedCandidates.filter((protection) =>
    baselineKeys.has(protection.candidateKey)
  );
  const embeddingPlan = resolveEmbeddingRankConsensusPlan({
    baseline,
    candidates: consensusCandidates,
    protectedCandidates: baselineProtections
  });
  const embeddingTailChanged = !sameCandidateOrder(
    embeddingPlan.immutableTail,
    embeddingPlan.baseline.slice(embeddingPlan.headWidth)
  );
  return deepFreeze({
    ...embeddingPlan,
    ...(embeddingTailChanged ? { tailPolicy: "head_tail_exchange" as const } : {})
  });
}

export function buildFinalPacketConsensusObservation(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[],
  replayAccepted: boolean
): RecallPacketPlanObservation {
  const decision = plan.decision.status === "accepted" && !replayAccepted
    ? { status: "rejected", reason: "admission_infeasible" } as const
    : plan.decision;
  const observation: RecallPacketPlanObservation = deepFreeze({
    baseline_candidate_keys: candidateKeys(plan.baseline),
    planned_candidate_keys: candidateKeys(plan.proposedCandidates),
    actual_candidate_keys: actual.map(buildRecallCandidateSelectionKey),
    head_width: plan.headWidth,
    baseline_head_candidate_keys: candidateKeys(plan.baselineHead),
    embedding_head: plan.embeddingHead.map((entry) => Object.freeze({
      candidate_key: entry.candidate.candidateKey,
      embedding_rank: entry.embeddingRank
    })),
    consensus_head_candidate_keys: candidateKeys(plan.consensusHead),
    immutable_tail_candidate_keys: candidateKeys(plan.immutableTail),
    ...(plan.tailPolicy === undefined ? {} : { tail_policy: plan.tailPolicy }),
    membership_authorizations: [],
    protected_candidates: plan.protectedCandidates.map((entry) => Object.freeze({
      candidate_key: entry.candidateKey,
      rank_limit: entry.rankLimit
    })),
    decision
  });
  assertRecallPacketPlanObservation(observation);
  return observation;
}

export function buildFinalSelectorOrder(
  plan: FinalPacketConsensusPlan,
  sourceCandidates: readonly FineAssessmentCandidate[]
): readonly FineAssessmentCandidate[] {
  if (plan.decision.status !== "accepted") {
    return Object.freeze([...sourceCandidates]);
  }
  const planned = plan.candidates.map((candidate) => candidate.sourceCandidate);
  const plannedKeys = new Set(plan.candidates.map((candidate) => candidate.candidateKey));
  return Object.freeze([
    ...planned,
    ...sourceCandidates.filter(
      (candidate) => !plannedKeys.has(buildRecallCandidateDedupeKey(candidate))
    )
  ]);
}

export function packetMatchesPlannedMembership(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[]
): boolean {
  return packetKeysMatchPlannedMembership(
    plan,
    actual.map(buildRecallCandidateSelectionKey)
  );
}

export function fineAssessmentPacketMatchesPlannedMembership(
  plan: FinalPacketConsensusPlan,
  actual: readonly FineAssessmentCandidate[]
): boolean {
  return packetKeysMatchPlannedMembership(
    plan,
    actual.map(buildRecallCandidateDedupeKey)
  );
}

function packetKeysMatchPlannedMembership(
  plan: FinalPacketConsensusPlan,
  receivedKeys: readonly string[]
): boolean {
  if (plan.candidates.length !== receivedKeys.length) return false;
  const expected = new Set(plan.candidates.map((candidate) => candidate.candidateKey));
  const received = new Set(receivedKeys);
  return expected.size === plan.candidates.length &&
    received.size === receivedKeys.length &&
    [...expected].every((candidateKey) => received.has(candidateKey));
}

function toConsensusCandidate(
  candidate: FineAssessmentCandidate
): FinalPacketConsensusCandidate {
  const rawEmbeddingRank = candidate.fusion.per_stream_rank.embedding_similarity;
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    fusedScore: candidate.fusion.fused_score,
    ...(rawEmbeddingRank === null ? {} : { rawEmbeddingRank }),
    sourceCandidate: candidate
  });
}

function sameCandidateOrder(
  left: readonly FinalPacketConsensusCandidate[],
  right: readonly FinalPacketConsensusCandidate[]
): boolean {
  return left.length === right.length && left.every(
    (candidate, index) => candidate.candidateKey === right[index]?.candidateKey
  );
}

function candidateKeys(
  candidates: readonly FinalPacketConsensusCandidate[]
): readonly string[] {
  return Object.freeze(candidates.map((candidate) => candidate.candidateKey));
}
