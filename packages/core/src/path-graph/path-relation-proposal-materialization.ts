import {
  PathRelationSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type PathAnchorRef,
  type PathGovernanceClass,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../runtime/event-publisher.js";
import type { AnchorValidationFailure } from "./path-relation-proposal-service-shared.js";

export interface SubmitCandidateInput {
  readonly workspaceId: string;
  readonly sourceAnchor: PathAnchorRef;
  readonly targetAnchor: PathAnchorRef;
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClass;
  readonly evidenceBasis: readonly string[];
  readonly recallBiasSign: 1 | 0 | -1;
  readonly recallBiasMagnitude?: number;
  readonly why?: readonly string[];
  readonly runId?: string | null;
}

export interface MaterializePathRelationInput {
  readonly workspaceId: string;
  readonly sourceAnchor: PathAnchorRef;
  readonly targetAnchor: PathAnchorRef;
  readonly relationKind: string;
  readonly initialStrength: number;
  readonly governanceClass: PathGovernanceClass;
  readonly evidenceBasis: readonly string[];
  readonly recallBias: number;
  readonly supportEventsCount: number;
  readonly why: readonly string[];
  readonly runId: string | null;
}

export function buildPathRelation(
  params: MaterializePathRelationInput,
  pathId: string,
  occurredAt: string
): PathRelation {
  return PathRelationSchema.parse({
    path_id: pathId,
    workspace_id: params.workspaceId,
    anchors: {
      source_anchor: params.sourceAnchor,
      target_anchor: params.targetAnchor
    },
    constitution: {
      relation_kind: params.relationKind,
      why_this_relation_exists: params.why
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: params.recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: params.initialStrength,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: params.supportEventsCount,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: params.evidenceBasis,
      governance_class: params.governanceClass
    },
    created_at: occurredAt,
    updated_at: occurredAt
  });
}

export function buildPathRelationCreatedEventInput(
  relation: Readonly<PathRelation>,
  runId: string | null
): EventPublisherInput {
  return {
    event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
    entity_type: "path_relation",
    entity_id: relation.path_id,
    workspace_id: relation.workspace_id,
    run_id: runId,
    caused_by: "system",
    payload_json: parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      {
        path_id: relation.path_id,
        workspace_id: relation.workspace_id,
        relation_kind: relation.constitution.relation_kind,
        source_anchor_kind: relation.anchors.source_anchor.kind,
        target_anchor_kind: relation.anchors.target_anchor.kind,
        initial_strength: relation.plasticity_state.strength,
        governance_class: relation.legitimacy.governance_class,
        created_at: relation.created_at
      }
    )
  };
}

export function buildPathRelationRejectedEventInput(
  workspaceId: string,
  relationKind: string,
  failure: Readonly<AnchorValidationFailure>,
  rejectedAt: string
): EventPublisherInput {
  return {
    event_type: RuntimeGovernanceEventType.PATH_RELATION_REJECTED,
    entity_type: "path_relation",
    entity_id: workspaceId,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "system",
    payload_json: parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_REJECTED,
      {
        workspace_id: workspaceId,
        relation_kind: relationKind,
        anchor_role: failure.anchorRole,
        rejected_object_id: failure.objectId,
        rejection_reason: failure.reason,
        rejected_at: rejectedAt
      }
    )
  };
}
