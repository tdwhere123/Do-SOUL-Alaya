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
import {
  resolveSourceSemanticRanks,
  sourceSemanticConsensusIsActive
} from "../admission/answer-head/source-semantic-answer-head.js";
import type { RecallEvidenceSemanticActivationReceipt } from
  "../../runtime/recall-service-results.js";

export type FinalPacketConsensusCandidate = Readonly<{
  readonly candidateKey: string;
  readonly fusedScore: number;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

export type FinalPacketConsensusPlan =
  EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> & Readonly<{
    readonly tailPolicy?: "head_tail_exchange";
    readonly rankBasis?:
      | "source_semantic_rrf"
      | "source_semantic_rrf_then_packet_relative";
    readonly sourceSemanticIntermediate?: readonly FinalPacketConsensusCandidate[];
    readonly packetRelativeEmbeddingHead?: EmbeddingRankConsensusPlan<
      FinalPacketConsensusCandidate
    >["embeddingHead"];
  }>;

export function resolveFinalPacketConsensusPlan(
  params: Readonly<{
    readonly baseline: readonly FineAssessmentCandidate[];
    readonly sourceCandidates: readonly FineAssessmentCandidate[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
    readonly supportsSingleSemanticLeader?: boolean;
    readonly evidenceSemanticActivationsByCandidateKey?: ReadonlyMap<
      string,
      Readonly<RecallEvidenceSemanticActivationReceipt>
    >;
  }>
): FinalPacketConsensusPlan {
  const sourceSemanticRanks = resolveSourceSemanticRankBasis(params);
  const consensusCandidates = params.sourceCandidates.map((candidate) =>
    toConsensusCandidate(candidate, sourceSemanticRanks));
  const baseline = params.baseline.map((candidate) => toConsensusCandidate(candidate));
  const baselineKeys = new Set(baseline.map((candidate) => candidate.candidateKey));
  const baselineProtections = params.protectedCandidates.filter((protection) =>
    baselineKeys.has(protection.candidateKey)
  );
  const embeddingPlan = resolveEmbeddingRankConsensusPlan({
    baseline,
    candidates: consensusCandidates,
    protectedCandidates: baselineProtections
  });
  const nestedPlan = sourceSemanticRanks === undefined ||
    embeddingPlan.decision.status === "rejected"
    ? undefined : resolvePacketRelativeConsensus(embeddingPlan);
  const finalPlan = nestedPlan === undefined
    ? embeddingPlan : composeSourceSemanticPlan(embeddingPlan, nestedPlan);
  const embeddingTailChanged = !sameCandidateOrder(
    finalPlan.immutableTail,
    finalPlan.baseline.slice(finalPlan.headWidth)
  );
  return deepFreeze({
    ...finalPlan,
    ...(sourceSemanticRanks === undefined ? {} : nestedPlan === undefined ? {
      rankBasis: "source_semantic_rrf" as const
    } : {
      rankBasis: "source_semantic_rrf_then_packet_relative" as const,
      sourceSemanticIntermediate: embeddingPlan.candidates,
      packetRelativeEmbeddingHead: nestedPlan.embeddingHead
    }),
    ...(embeddingTailChanged ? { tailPolicy: "head_tail_exchange" as const } : {})
  });
}

function resolveSourceSemanticRankBasis(params: Readonly<{
  readonly sourceCandidates: readonly FineAssessmentCandidate[];
  readonly supportsSingleSemanticLeader?: boolean;
  readonly evidenceSemanticActivationsByCandidateKey?: ReadonlyMap<
    string,
    Readonly<RecallEvidenceSemanticActivationReceipt>
  >;
}>): ReadonlyMap<string, number> | undefined {
  const activations = params.evidenceSemanticActivationsByCandidateKey ?? new Map();
  if (params.supportsSingleSemanticLeader !== true ||
      !sourceSemanticConsensusIsActive(true, activations)) {
    return undefined;
  }
  return resolveSourceSemanticRanks(
    params.sourceCandidates,
    activations,
    buildRecallCandidateDedupeKey
  );
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
    ...(plan.rankBasis === undefined ? {} : { embedding_rank_basis: plan.rankBasis }),
    ...(plan.sourceSemanticIntermediate === undefined ? {} : {
      source_semantic_intermediate_candidate_keys:
        candidateKeys(plan.sourceSemanticIntermediate)
    }),
    ...(plan.packetRelativeEmbeddingHead === undefined ? {} : {
      packet_relative_embedding_head: plan.packetRelativeEmbeddingHead.map(
        (entry) => Object.freeze({
          candidate_key: entry.candidate.candidateKey,
          embedding_rank: entry.embeddingRank
        })
      )
    }),
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
  candidate: FineAssessmentCandidate,
  sourceSemanticRanks?: ReadonlyMap<string, number>
): FinalPacketConsensusCandidate {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const rawEmbeddingRank = sourceSemanticRanks?.get(candidateKey) ??
    candidate.fusion.per_stream_rank.embedding_similarity ?? undefined;
  return Object.freeze({
    candidateKey,
    fusedScore: candidate.fusion.fused_score,
    ...(rawEmbeddingRank === undefined ? {} : { rawEmbeddingRank }),
    sourceCandidate: candidate
  });
}

function resolvePacketRelativeConsensus(
  initial: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>
): EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> {
  if (initial.decision.status === "rejected") return initial;
  const packet = initial.candidates;
  const relativeRanks = new Map([...packet]
    .filter((candidate) => validScore(
      candidate.sourceCandidate.effectiveFactors.embedding_similarity))
    .sort((left, right) =>
      (right.sourceCandidate.effectiveFactors.embedding_similarity ?? 0) -
        (left.sourceCandidate.effectiveFactors.embedding_similarity ?? 0) ||
      left.candidateKey.localeCompare(right.candidateKey))
    .map((candidate, index) => [candidate.candidateKey, index + 1]));
  const relativePacket = packet.map((candidate) => Object.freeze({
    ...candidate,
    ...(relativeRanks.has(candidate.candidateKey)
      ? { rawEmbeddingRank: relativeRanks.get(candidate.candidateKey) }
      : {})
  }));
  return resolveEmbeddingRankConsensusPlan({
    baseline: relativePacket,
    candidates: relativePacket,
    protectedCandidates: initial.protectedCandidates
  });
}

function composeSourceSemanticPlan(
  initial: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>,
  nested: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>
): EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> {
  // Published heads, not the full packet, own strict_tail_consensus.
  if (nested.decision.status === "rejected") {
    return publishNestedProposal(initial, nested, nested.decision);
  }
  if (sameCandidateOrder(initial.baselineHead, nested.consensusHead)) {
    return publishOriginalBaseline(initial);
  }
  return publishNestedProposal(initial, nested, {
    status: "accepted",
    reason: "strict_tail_consensus"
  });
}

function publishNestedProposal(
  initial: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>,
  nested: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>,
  decision: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>["decision"]
): EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> {
  return Object.freeze({
    ...initial,
    proposedCandidates: nested.proposedCandidates,
    candidates: decision.status === "accepted"
      ? nested.proposedCandidates
      : initial.baseline,
    consensusHead: nested.consensusHead,
    immutableTail: nested.immutableTail,
    decision
  });
}

function publishOriginalBaseline(
  initial: EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>
): EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate> {
  return Object.freeze({
    ...initial,
    proposedCandidates: initial.baseline,
    candidates: initial.baseline,
    consensusHead: initial.baselineHead,
    immutableTail: initial.baseline.slice(initial.headWidth),
    decision: initial.embeddingHead.length === 0
      ? { status: "no_op" as const, reason: "no_finite_embedding_head" as const }
      : { status: "no_op" as const, reason: "unchanged_consensus" as const }
  });
}

function validScore(score: number | undefined): boolean {
  return score !== undefined && Number.isFinite(score) && score > 0;
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
