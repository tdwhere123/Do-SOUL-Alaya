import type { RecallPacketPlanObservation } from "./packet-plan-observation.js";

export function isSelectGammaIdentityObservation(
  observation: RecallPacketPlanObservation
): boolean {
  return observation.decision.status === "no_op" &&
    observation.decision.reason === "select_gamma_identity" &&
    observation.embedding_head.length === 0 &&
    observation.membership_authorizations.length === 0 &&
    observation.protected_candidates.length === 0 &&
    observation.embedding_rank_basis === undefined &&
    observation.source_semantic_intermediate_candidate_keys === undefined &&
    observation.packet_relative_embedding_head === undefined &&
    observation.tail_policy === undefined &&
    sameOrder(
      observation.baseline_head_candidate_keys,
      observation.consensus_head_candidate_keys
    );
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((key, index) => key === right[index]);
}
