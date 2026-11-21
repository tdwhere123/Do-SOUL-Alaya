import {
  GreenGovernanceEventType,
  MemoryGovernanceEventType,
  RevokeReason,
  RuntimeGovernanceEventType,
  SoulGreenPiercedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  SoulSynthesisCreatedPayloadSchema,
  parseRuntimeGovernanceEventPayload,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type PathRelation,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { ProposalResolutionEventInput } from "../proposal-workflow-types.js";

export function buildAcceptedMemoryEvent(
  memory: Readonly<MemoryEntry>,
  changes: MemoryEntryMutableFields,
  causedBy: string
): ProposalResolutionEventInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
    entity_type: "memory_entry",
    entity_id: memory.object_id,
    workspace_id: memory.workspace_id,
    run_id: memory.run_id,
    caused_by: causedBy,
    payload_json: SoulMemoryUpdatedPayloadSchema.parse({
      object_id: memory.object_id,
      object_kind: memory.object_kind,
      workspace_id: memory.workspace_id,
      run_id: memory.run_id,
      updated_fields: Object.entries(changes).flatMap(([field, value]) => value === undefined ? [] : [field])
    })
  };
}

export function buildAcceptedGreenRevocationEvent(
  memory: Readonly<MemoryEntry>, greenStatusId: string, causedBy: string, reviewedAt: string
): ProposalResolutionEventInput {
  return {
    event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
    entity_type: "green_status",
    entity_id: greenStatusId,
    workspace_id: memory.workspace_id,
    run_id: memory.run_id,
    caused_by: causedBy,
    payload_json: SoulGreenPiercedPayloadSchema.parse({
      object_id: greenStatusId,
      target_object_id: memory.object_id,
      revoke_reason: RevokeReason.MAPPING_REVOKED,
      workspace_id: memory.workspace_id,
      occurred_at: reviewedAt
    })
  };
}

export function buildAcceptedPathRelationEvent(
  relation: Readonly<PathRelation>,
  previous: Readonly<PathRelation> | null,
  runId: string | null,
  causedBy: string
): ProposalResolutionEventInput {
  const envelope = { entity_type: "path_relation", entity_id: relation.path_id,
    workspace_id: relation.workspace_id, run_id: runId, caused_by: causedBy };
  const scope = { path_id: relation.path_id, workspace_id: relation.workspace_id };
  if (previous === null) {
    const eventType = RuntimeGovernanceEventType.PATH_RELATION_CREATED;
    return {
      ...envelope,
      event_type: eventType,
      payload_json: parseRuntimeGovernanceEventPayload(eventType, {
        ...scope,
        relation_kind: relation.constitution.relation_kind,
        source_anchor_kind: relation.anchors.source_anchor.kind,
        target_anchor_kind: relation.anchors.target_anchor.kind,
        initial_strength: relation.plasticity_state.strength,
        governance_class: relation.legitimacy.governance_class,
        created_at: relation.created_at
      })
    };
  }
  const eventType = RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED;
  return {
    ...envelope,
    event_type: eventType,
    payload_json: parseRuntimeGovernanceEventPayload(eventType, {
      ...scope,
      previous_governance_class: previous.legitimacy.governance_class,
      new_governance_class: relation.legitimacy.governance_class,
      previous_evidence_basis: previous.legitimacy.evidence_basis,
      new_evidence_basis: relation.legitimacy.evidence_basis,
      updated_at: relation.updated_at
    })
  };
}

export function buildAcceptedSynthesisEvent(capsule: SynthesisCapsule): ProposalResolutionEventInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
    entity_type: "synthesis_capsule",
    entity_id: capsule.object_id,
    workspace_id: capsule.workspace_id,
    run_id: capsule.run_id,
    caused_by: capsule.created_by,
    payload_json: SoulSynthesisCreatedPayloadSchema.parse({
      object_id: capsule.object_id,
      object_kind: capsule.object_kind,
      workspace_id: capsule.workspace_id,
      run_id: capsule.run_id
    })
  };
}
