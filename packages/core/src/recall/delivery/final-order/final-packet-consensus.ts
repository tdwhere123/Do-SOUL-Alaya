import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { deepFreeze } from "../../../shared/deep-freeze.js";
import { CoreError } from "../../../shared/errors.js";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import type { PathInflowEdge } from "../../runtime/recall-service-types.js";
import {
  resolveEmbeddingRankConsensusPlan,
  type EmbeddingRankConsensusPlan,
  type EmbeddingRankConsensusProtection
} from "../packet-plan/embedding-rank-consensus.js";
import type {
  RecallPacketMembershipAuthorization,
  RecallPacketPlanObservation
} from
  "../packet-plan/packet-plan-observation.js";
import { assertRecallPacketPlanObservation } from
  "../packet-plan/packet-plan-observation.js";
import { governQueryEvidenceMembership } from
  "./query-evidence-membership-governor.js";
import {
  attachAuthorizationEffects,
  type QueryEvidenceMembershipAuthorizationReceipt
} from "./membership/authorization.js";

export type FinalPacketConsensusCandidate = Readonly<{
  readonly candidateKey: string;
  readonly fusedScore: number;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

type FinalPacketConsensusDecision =
  EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>["decision"] |
  Readonly<{
    readonly status: "accepted";
    readonly reason: "nested_membership_consensus";
  }>;

export type FinalPacketConsensusPlan = Omit<
  EmbeddingRankConsensusPlan<FinalPacketConsensusCandidate>,
  "decision"
> & Readonly<{
  readonly decision: FinalPacketConsensusDecision;
  readonly tailPolicy?: "head_tail_exchange" | "nested_membership_exchange";
  readonly membershipAuthorizations: readonly QueryEvidenceMembershipAuthorizationReceipt[];
}>;

export type FinalPacketConsensusMembershipGovernance = Readonly<{
  readonly preProjection: readonly Readonly<RecallCandidate>[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly pathInflowByTarget?: Readonly<Record<string, readonly PathInflowEdge[]>>;
  readonly behaviorAuthorityEvidenceRefByCandidateKey: ReadonlyMap<string, string>;
}>;

export function resolveFinalPacketConsensusPlan(
  params: Readonly<{
    readonly baseline: readonly Readonly<RecallCandidate>[];
    readonly sourceCandidates: readonly FineAssessmentCandidate[];
    readonly protectedCandidates: readonly EmbeddingRankConsensusProtection[];
    readonly membershipGovernance?: FinalPacketConsensusMembershipGovernance;
  }>
): FinalPacketConsensusPlan {
  const consensusCandidates = params.sourceCandidates.map((candidate) =>
    toConsensusCandidate(candidate)
  );
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
  const baselineKeys = new Set(baseline.map((candidate) => candidate.candidateKey));
  const baselineProtections = params.protectedCandidates.filter((protection) =>
    baselineKeys.has(protection.candidateKey)
  );
  const embeddingPlan = resolveEmbeddingRankConsensusPlan({
    baseline,
    candidates: consensusCandidates,
    protectedCandidates: baselineProtections
  });
  const embeddingTailChanged = embeddingPlan.decision.status === "accepted" &&
    !sameCandidateOrder(
      embeddingPlan.immutableTail,
      embeddingPlan.baseline.slice(embeddingPlan.headWidth)
    );
  const plan: FinalPacketConsensusPlan = deepFreeze({
    ...embeddingPlan,
    ...(embeddingTailChanged ? { tailPolicy: "head_tail_exchange" as const } : {}),
    membershipAuthorizations: []
  });
  return applyMembershipGovernance(
    plan, params.membershipGovernance, consensusCandidates, sourceByKey
  );
}

export function buildFinalPacketConsensusObservation(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[],
  replayAccepted: boolean
): RecallPacketPlanObservation {
  const proposed = plan.decision.status === "accepted"
    ? plan.candidates
    : [...plan.consensusHead, ...plan.immutableTail];
  const decision = plan.decision.status === "accepted" && !replayAccepted
    ? { status: "rejected", reason: "admission_infeasible" } as const
    : plan.decision;
  const observation: RecallPacketPlanObservation = deepFreeze({
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
    ...(plan.tailPolicy === undefined ? {} : { tail_policy: plan.tailPolicy }),
    membership_authorizations: plan.membershipAuthorizations.map(
      toMembershipAuthorizationObservation
    ),
    protected_candidates: plan.protectedCandidates.map((entry) => Object.freeze({
      candidate_key: entry.candidateKey,
      rank_limit: entry.rankLimit
    })),
    decision
  });
  assertRecallPacketPlanObservation(observation);
  return observation;
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

export function packetMatchesConsensusMembership(
  plan: FinalPacketConsensusPlan,
  actual: readonly Readonly<RecallCandidate>[]
): boolean {
  if (plan.candidates.length !== actual.length) return false;
  const expected = new Set(plan.candidates.map((candidate) => candidate.candidateKey));
  const received = new Set(actual.map(buildRecallCandidateSelectionKey));
  return expected.size === plan.candidates.length &&
    received.size === actual.length &&
    [...expected].every((candidateKey) => received.has(candidateKey));
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

function applyMembershipGovernance(
  plan: FinalPacketConsensusPlan,
  governance: FinalPacketConsensusMembershipGovernance | undefined,
  sourceCandidates: readonly FinalPacketConsensusCandidate[],
  sourceByKey: ReadonlyMap<string, FinalPacketConsensusCandidate>
): FinalPacketConsensusPlan {
  if (governance === undefined) return plan;
  const membershipWidth = Math.min(5, plan.candidates.length);
  const membership = resolveMembershipGovernance(
    plan, governance, sourceCandidates, sourceByKey, membershipWidth
  );
  if (!membership.feasible) return exactBaselineMembershipPlan(plan);
  if (
    membership.authorizations.length === 0 &&
    sameCandidateOrder(membership.head, plan.baseline.slice(0, membershipWidth))
  ) {
    return plan;
  }
  if (sameCandidateOrder(membership.head, plan.candidates.slice(0, membershipWidth))) {
    return membership.authorizations.length === 0
      ? plan
      : deepFreeze({
          ...plan,
          membershipAuthorizations: attachAuthorizationEffects(
            membership.authorizations,
            plan.baseline.slice(0, membershipWidth),
            membership.head,
            plan.baseline,
            plan.candidates
          )
        });
  }
  const nestedPack = composeNestedMembershipPack(
    plan, membership.head, sourceCandidates, membershipWidth
  );
  if (nestedPack === undefined) return plan;
  const { candidates, immutableTail, nested } = nestedPack;
  if (!protectionsSatisfied(candidates, plan.protectedCandidates)) return plan;
  const membershipAuthorizations = attachAuthorizationEffects(
    membership.authorizations,
    plan.baseline.slice(0, membershipWidth),
    membership.head,
    plan.baseline,
    candidates
  );
  return deepFreeze({
    ...plan,
    candidates,
    headWidth: membershipWidth,
    baselineHead: plan.baseline.slice(0, membershipWidth),
    consensusHead: membership.head,
    immutableTail,
    membershipAuthorizations,
    ...(nested ? { tailPolicy: "nested_membership_exchange" as const } : {}),
    decision: {
      status: "accepted",
      reason: nested
        ? "nested_membership_consensus"
        : "strict_tail_consensus"
    }
  });
}

function exactBaselineMembershipPlan(
  plan: FinalPacketConsensusPlan
): FinalPacketConsensusPlan {
  return deepFreeze({
    baseline: plan.baseline,
    candidates: plan.baseline,
    headWidth: plan.headWidth,
    baselineHead: plan.baselineHead,
    embeddingHead: plan.embeddingHead,
    consensusHead: plan.baselineHead,
    immutableTail: plan.baseline.slice(plan.headWidth),
    protectedCandidates: plan.protectedCandidates,
    membershipAuthorizations: [],
    decision: {
      status: "no_op",
      reason: plan.embeddingHead.length === 0
        ? "no_finite_embedding_head"
        : "unchanged_consensus"
    }
  });
}

function resolveMembershipGovernance(
  plan: FinalPacketConsensusPlan,
  governance: FinalPacketConsensusMembershipGovernance,
  sourceCandidates: readonly FinalPacketConsensusCandidate[],
  sourceByKey: ReadonlyMap<string, FinalPacketConsensusCandidate>,
  membershipWidth: number
) {
  const preProjectionHead = resolvePreProjectionHead(
    governance.preProjection, membershipWidth, sourceByKey
  );
  return governQueryEvidenceMembership({
    preProjectionHead,
    fallbackHead: plan.baseline.slice(0, membershipWidth),
    proposedHead: plan.candidates.slice(0, membershipWidth),
    sourceCandidates,
    opportunityCandidates: plan.candidates.slice(membershipWidth),
    graphOpportunityCandidates: sourceCandidates,
    visibleCandidateKeys: new Set([
      ...preProjectionHead.map((candidate) => candidate.candidateKey),
      ...plan.candidates
        .slice(0, membershipWidth)
        .map((candidate) => candidate.candidateKey)
    ]),
    queryProbes: governance.queryProbes,
    pathInflowByTarget: governance.pathInflowByTarget,
    behaviorAuthorityEvidenceRefByCandidateKey:
      governance.behaviorAuthorityEvidenceRefByCandidateKey,
    fixedCandidateKeys: new Set(
      plan.protectedCandidates
        .map((protection) => protection.candidateKey)
    )
  });
}

function composeNestedMembershipPack(
  plan: FinalPacketConsensusPlan,
  head: readonly FinalPacketConsensusCandidate[],
  sourceCandidates: readonly FinalPacketConsensusCandidate[],
  membershipWidth: number
): Readonly<{
  readonly candidates: readonly FinalPacketConsensusCandidate[];
  readonly immutableTail: readonly FinalPacketConsensusCandidate[];
  readonly nested: boolean;
}> | undefined {
  const capacity = plan.candidates.length;
  const headKeys = new Set(head.map((candidate) => candidate.candidateKey));
  if (headKeys.size !== head.length || head.length > capacity) return undefined;
  const originalTail = plan.baseline.slice(membershipWidth);
  const tail = plan.baseline.filter(
    (candidate) => !headKeys.has(candidate.candidateKey)
  );
  const completeTail = [...tail];
  while (head.length + completeTail.length < capacity) {
    const next = sourceCandidates.find((candidate) =>
      !headKeys.has(candidate.candidateKey) &&
      !completeTail.some((tailCandidate) =>
        tailCandidate.candidateKey === candidate.candidateKey
      )
    );
    if (next === undefined) return undefined;
    completeTail.push(next);
  }
  while (head.length + completeTail.length > capacity) {
    const victimIndex = findEvictableTailIndex(
      completeTail, plan.protectedCandidates
    );
    if (victimIndex < 0) return undefined;
    completeTail.splice(victimIndex, 1);
  }
  if (head.length + completeTail.length !== capacity) return undefined;
  const nested = !sameCandidateOrder(completeTail, originalTail);
  const candidates = [...head, ...completeTail];
  if (new Set(candidates.map((candidate) => candidate.candidateKey)).size !== capacity) {
    return undefined;
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    immutableTail: Object.freeze(completeTail),
    nested
  });
}

function toMembershipAuthorizationObservation(
  receipt: QueryEvidenceMembershipAuthorizationReceipt
): RecallPacketMembershipAuthorization {
  const common = {
    authorized_candidate_key: receipt.authorizedCandidateKey,
    satisfied_by_candidate_key: receipt.satisfiedByCandidateKey,
    satisfied_head_slot: receipt.satisfiedHeadSlot,
    displaced_head_baseline: receipt.displacedHeadBaseline === null
      ? null
      : {
          slot: receipt.displacedHeadBaseline.slot,
          candidate_key: receipt.displacedHeadBaseline.candidateKey
        },
    evicted_packet_baseline: receipt.evictedPacketBaseline === null
      ? null
      : {
          slot: receipt.evictedPacketBaseline.slot,
          candidate_key: receipt.evictedPacketBaseline.candidateKey
        }
  } as const;
  const witness = receipt.witness;
  if (receipt.kind === "direct_query_evidence" &&
      "origin" in witness && "stream" in witness) {
    return deepFreeze({
      ...common,
      kind: "direct_query_evidence" as const,
      witness: {
        origin: witness.origin,
        stream: witness.stream,
        rank: witness.rank,
        source_proximity_rank: witness.sourceProximityRank,
        source_evidence_agreement_rank: witness.sourceEvidenceAgreementRank
      }
    });
  }
  if (receipt.kind === "graph_path_opportunity" && "certificate" in witness) {
    return deepFreeze({
      ...common,
      kind: "graph_path_opportunity" as const,
      witness: {
        graph_expansion_rank: witness.graphRank,
        source_proximity_rank: witness.sourceProximityRank,
        source_candidate_key: witness.certificate.sourceCandidateKey,
        target_candidate_key: witness.certificate.targetCandidateKey,
        path_id: witness.certificate.pathId,
        path_source_version: witness.certificate.pathSourceVersion,
        relation_kind: witness.certificate.relationKind
      }
    });
  }
  if (receipt.kind === "behavior_identity" && "evidenceRef" in witness) {
    if (witness.evidenceRef === null) {
      throw new CoreError("VALIDATION", "Behavior authorization lacks evidence");
    }
    return deepFreeze({
      ...common,
      kind: "behavior_identity" as const,
      witness: { evidence_ref: witness.evidenceRef }
    });
  }
  if (receipt.kind === "same_session_substitution" && "sessionKey" in witness) {
    return deepFreeze({
      ...common,
      kind: "same_session_substitution" as const,
      witness: {
        protected_candidate_key: witness.protectedCandidateKey,
        substitute_candidate_key: witness.substituteCandidateKey,
        source_candidate_key: witness.sourceCandidateKey,
        target_candidate_key: witness.targetCandidateKey,
        path_id: witness.pathId,
        path_source_version: witness.pathSourceVersion,
        relation_kind: witness.relationKind,
        session_key: witness.sessionKey
      }
    });
  }
  throw new CoreError("VALIDATION", "Membership authorization witness is inconsistent");
}

function findEvictableTailIndex(
  tail: readonly FinalPacketConsensusCandidate[],
  protections: readonly EmbeddingRankConsensusProtection[]
): number {
  const protectedKeys = new Set(protections.map((protection) => protection.candidateKey));
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (!protectedKeys.has(tail[index]?.candidateKey ?? "")) return index;
  }
  return -1;
}

function resolvePreProjectionHead(
  preProjection: readonly Readonly<RecallCandidate>[],
  headWidth: number,
  sourceByKey: ReadonlyMap<string, FinalPacketConsensusCandidate>
): readonly FinalPacketConsensusCandidate[] {
  const head = preProjection.slice(0, headWidth).flatMap((candidate) => {
    const source = sourceByKey.get(buildRecallCandidateSelectionKey(candidate));
    return source === undefined ? [] : [source];
  });
  if (head.length !== Math.min(headWidth, preProjection.length)) {
    throw new CoreError(
      "VALIDATION",
      "Final packet consensus could not resolve pre-projection membership"
    );
  }
  return Object.freeze(head);
}

function protectionsSatisfied(
  candidates: readonly FinalPacketConsensusCandidate[],
  protections: readonly EmbeddingRankConsensusProtection[]
): boolean {
  return protections.every((protection) => {
    const rank = candidates.findIndex(
      (candidate) => candidate.candidateKey === protection.candidateKey
    ) + 1;
    return rank > 0 && rank <= protection.rankLimit;
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
