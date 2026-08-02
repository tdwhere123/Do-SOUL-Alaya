import { deepFreeze } from "../../../../shared/deep-freeze.js";
import { CoreError } from "../../../../shared/errors.js";
import type { RecallPacketMembershipAuthorization } from
  "../../packet-plan/packet-plan-observation.js";
import type { QueryEvidenceMembershipAuthorizationReceipt } from
  "./authorization.js";

export function toMembershipAuthorizationObservation(
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
  if (receipt.kind === "selector_consensus" && "embeddingRank" in witness) {
    return deepFreeze({
      ...common,
      kind: "selector_consensus" as const,
      witness: { embedding_rank: witness.embeddingRank }
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
