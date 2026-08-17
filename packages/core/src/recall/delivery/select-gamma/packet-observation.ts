import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { buildRecallCandidateSelectionKey } from
  "../../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey } from
  "../../runtime/recall-service-helpers.js";
import {
  assertRecallPacketPlanObservation,
  type RecallPacketPlanObservation
} from "../packet-plan/packet-plan-observation.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection/types.js";

export function buildSelectGammaPacketObservation(
  selected: readonly FineAssessmentCandidate[],
  actual: readonly Readonly<RecallCandidate>[]
): RecallPacketPlanObservation {
  const selectedKeys = Object.freeze(selected.map(buildRecallCandidateDedupeKey));
  const actualKeys = Object.freeze(actual.map(buildRecallCandidateSelectionKey));
  const headWidth = Math.ceil(selectedKeys.length / 2);
  const head = Object.freeze(selectedKeys.slice(0, headWidth));
  const tail = Object.freeze(selectedKeys.slice(headWidth));
  const observation: RecallPacketPlanObservation = Object.freeze({
    baseline_candidate_keys: selectedKeys,
    planned_candidate_keys: selectedKeys,
    actual_candidate_keys: actualKeys,
    head_width: headWidth,
    baseline_head_candidate_keys: head,
    embedding_head: Object.freeze([]),
    consensus_head_candidate_keys: head,
    immutable_tail_candidate_keys: tail,
    membership_authorizations: Object.freeze([]),
    protected_candidates: Object.freeze([]),
    decision: Object.freeze({
      status: "no_op" as const,
      reason: "select_gamma_identity" as const
    })
  });
  assertRecallPacketPlanObservation(observation);
  return observation;
}
