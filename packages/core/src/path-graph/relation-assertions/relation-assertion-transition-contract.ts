import {
  RelationAssertionAdmissionSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";
import { stableStringify } from "../../shared/stable-stringify.js";
import { sha256RelationAssertionValue as sha256 } from "./relation-projection-builder.js";
import type {
  RelationAssertionAdmissionRequest,
  RelationAssertionAdmissionResult,
  RelationAssertionProjectionResult,
  RelationAssertionResolutionRequest,
  RelationAssertionResolutionResult
} from "./relation-assertion-service-types.js";

export const RELATION_ASSERTION_ENTITY_TYPE = "relation_assertion";

export type PreparedAdmission = Readonly<{
  readonly admission: ReturnType<typeof RelationAssertionAdmissionSchema.parse>;
  readonly identityKey: string;
}>;

export type PreparedResolution = ReturnType<typeof RelationAssertionResolvedPayloadSchema.parse>;

export function prepareAdmission(
  request: RelationAssertionAdmissionRequest,
  admittedAt: string
): PreparedAdmission {
  const identityKey = deriveIdentityKey(request);
  return Object.freeze({
    admission: RelationAssertionAdmissionSchema.parse({
      assertion_id: request.assertionId ?? `relation_assertion_${identityKey.slice(0, 48)}`,
      workspace_id: request.workspaceId,
      evidence_ids: request.evidenceIds,
      anchors: request.anchors,
      relation_kind: request.relationKind,
      validity: request.validity,
      admitted_at: admittedAt
    }),
    identityKey
  });
}

export function deriveResolutionId(request: RelationAssertionResolutionRequest): string {
  return `relation_resolution_${sha256(stableStringify({
    assertion_id: request.assertionId,
    resolution_kind: request.resolutionKind,
    reason: request.reason
  })).slice(0, 48)}`;
}

export function prepareResolution(
  request: RelationAssertionResolutionRequest,
  assertion: Readonly<RelationAssertion>,
  resolutionId: string,
  resolvedAt: string
): PreparedResolution {
  return RelationAssertionResolvedPayloadSchema.parse({
    resolution_id: resolutionId,
    assertion_id: assertion.assertion_id,
    workspace_id: assertion.workspace_id,
    resolution_kind: request.resolutionKind,
    resolved_at: resolvedAt,
    reason: request.reason
  });
}

export function createAdmissionEventInput(
  request: RelationAssertionAdmissionRequest,
  admission: PreparedAdmission["admission"]
): EventPublisherInput {
  return {
    event_type: RuntimeGovernanceEventType.RELATION_ASSERTION_ADMITTED,
    entity_type: RELATION_ASSERTION_ENTITY_TYPE,
    entity_id: admission.assertion_id,
    workspace_id: admission.workspace_id,
    run_id: request.runId,
    caused_by: request.causedBy,
    payload_json: RelationAssertionAdmittedPayloadSchema.parse(admission)
  };
}

export function createResolutionEventInput(
  request: RelationAssertionResolutionRequest,
  resolution: PreparedResolution
): EventPublisherInput {
  return {
    event_type: RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED,
    entity_type: RELATION_ASSERTION_ENTITY_TYPE,
    entity_id: resolution.assertion_id,
    workspace_id: resolution.workspace_id,
    run_id: request.runId,
    caused_by: request.causedBy,
    payload_json: resolution
  };
}

export function projectionAdmissionResult(
  status: RelationAssertionAdmissionResult["status"],
  assertion: Readonly<RelationAssertion>,
  projection: RelationAssertionProjectionResult
): RelationAssertionAdmissionResult {
  return {
    status,
    assertion,
    activeProjectionCount: projection.activeProjectionCount,
    projectionGeneration: projection.generation.generation
  };
}

export function projectionResolutionResult(
  status: RelationAssertionResolutionResult["status"],
  resolution: Readonly<RelationAssertionResolution>,
  projection: RelationAssertionProjectionResult
): RelationAssertionResolutionResult {
  return {
    status,
    resolution,
    activeProjectionCount: projection.activeProjectionCount,
    projectionGeneration: projection.generation.generation
  };
}

function deriveIdentityKey(request: RelationAssertionAdmissionRequest): string {
  return sha256(stableStringify({
    workspace_id: request.workspaceId,
    source_event_anchor: request.sourceEventAnchor,
    evidence_ids: [...request.evidenceIds].sort(),
    anchors: request.anchors,
    relation_kind: request.relationKind,
    validity: request.validity
  }));
}
