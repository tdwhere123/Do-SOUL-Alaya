import { PathGovernanceClass, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { PathRelationProposalPayload, SignalRefSeedSpec } from "./contracts.js";
import type { TimeConcernPayload } from "./inputs.js";

export function buildTimeConcernPathRelationProposal(
  targetObjectId: string,
  timeConcern: TimeConcernPayload
): PathRelationProposalPayload {
  return {
    target_anchor: {
      kind: "time_concern",
      source_object_id: targetObjectId,
      window_digest: timeConcern.window_digest
    },
    constitution: {
      relation_kind: "time_concern",
      why_this_relation_exists: [`matched temporal expression: ${timeConcern.matched_text}`]
    },
    effect_vector: {
      salience: 0.6,
      recall_bias: 0.7,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.4,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["garden:time_concern"],
      governance_class: PathGovernanceClass.RECALL_ALLOWED
    }
  };
}

export function buildFailedSignalRefPathRelationProposal(params: {
  readonly newObjectId: string;
  readonly failedRef: string;
  readonly signal: CandidateMemorySignal;
  readonly spec: SignalRefSeedSpec;
  readonly thrownError: string | null;
}): PathRelationProposalPayload {
  const recallBias = params.spec.recallBiasSign * params.spec.recallBiasMagnitude;
  const why = [
    `${params.spec.signalRefsKey} on candidate signal ${params.signal.signal_id}`,
    `run=${params.signal.run_id}`,
    `path candidate mint failed for target_anchor=${params.failedRef}`
  ];
  if (params.thrownError !== null) {
    why.push(`submitCandidate threw: ${params.thrownError}`);
  }

  return {
    target_anchor: {
      kind: "object",
      object_id: params.failedRef
    },
    constitution: {
      relation_kind: params.spec.relationKind,
      why_this_relation_exists: why
    },
    effect_vector: {
      salience: params.spec.initialStrength,
      recall_bias: recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: params.spec.initialStrength,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "governance_reject_or_low_strength"
    },
    legitimacy: {
      evidence_basis: params.spec.evidenceBasis,
      governance_class: params.spec.governanceClass
    }
  };
}

export function buildFailedSignalRefPathRelationProposalReason(params: {
  readonly newObjectId: string;
  readonly failedRef: string;
  readonly signal: CandidateMemorySignal;
  readonly spec: SignalRefSeedSpec;
  readonly thrownError: string | null;
}): string {
  const base =
    `Persist failed ${params.spec.signalRefsKey} path_relation candidate ` +
    `${params.spec.relationKind} from ${params.newObjectId} to ${params.failedRef}. ` +
    `Source signal: ${params.signal.signal_id}.`;
  if (params.thrownError === null) {
    return base;
  }
  return `${base} submitCandidate error: ${params.thrownError}.`;
}
