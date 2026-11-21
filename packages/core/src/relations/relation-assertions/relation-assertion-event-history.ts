import {
  RelationAssertionAdmissionSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { stableStringify } from "../../shared/stable-stringify.js";
import { RELATION_ASSERTION_ENTITY_TYPE } from "./relation-assertion-transition-contract.js";
import type { RelationAssertionEventEntry } from "./relation-assertion-service-types.js";

export function sortEvidenceReceipts(
  receipts: RelationAssertion["evidence_receipts"]
): RelationAssertion["evidence_receipts"] {
  return [...receipts].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

export function verifyAdmissionEvent(
  events: readonly RelationAssertionEventEntry[],
  assertion: Readonly<RelationAssertion>
): void {
  const matching = events.filter((event) =>
    event.event_type === RuntimeGovernanceEventType.RELATION_ASSERTION_ADMITTED
  );
  if (matching.length !== 1) {
    throw new CoreError("CONFLICT", `Relation assertion ${assertion.assertion_id} has no unique admission EventLog entry.`);
  }
  const event = matching[0]!;
  const payload = parseAdmissionPayload(event.payload_json, assertion.assertion_id);
  const expected = RelationAssertionAdmissionSchema.parse({
    assertion_id: assertion.assertion_id,
    workspace_id: assertion.workspace_id,
    evidence_receipts: assertion.evidence_receipts,
    formation_receipt: assertion.formation_receipt,
    anchors: assertion.anchors,
    relation_kind: assertion.relation_kind,
    validity: assertion.validity,
    admitted_at: assertion.admitted_at
  });
  if (
    event.event_id !== assertion.admission_event_id ||
    event.entity_type !== RELATION_ASSERTION_ENTITY_TYPE ||
    event.entity_id !== assertion.assertion_id ||
    event.workspace_id !== assertion.workspace_id ||
    stableStringify({ ...payload, evidence_receipts: sortEvidenceReceipts(payload.evidence_receipts) }) !==
      stableStringify({ ...expected, evidence_receipts: sortEvidenceReceipts(expected.evidence_receipts) })
  ) {
    throw new CoreError("CONFLICT", `Relation assertion ${assertion.assertion_id} admission EventLog payload is not canonical.`);
  }
}

export function verifyResolutionEvent(
  events: readonly RelationAssertionEventEntry[],
  resolution: Readonly<RelationAssertionResolution>
): void {
  const matching = events.filter((event) =>
    event.event_type === RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED && event.event_id === resolution.event_id
  );
  if (matching.length !== 1) {
    throw new CoreError("CONFLICT", `Relation assertion ${resolution.assertion_id} has no unique resolution EventLog entry.`);
  }
  const event = matching[0]!;
  const payload = parseResolutionPayload(event.payload_json, resolution.assertion_id);
  const expected = RelationAssertionResolvedPayloadSchema.parse({
    resolution_id: resolution.resolution_id,
    assertion_id: resolution.assertion_id,
    workspace_id: resolution.workspace_id,
    resolution_kind: resolution.resolution_kind,
    resolved_at: resolution.resolved_at,
    reason: resolution.reason
  });
  if (
    event.event_id !== resolution.event_id ||
    event.entity_type !== RELATION_ASSERTION_ENTITY_TYPE ||
    event.entity_id !== resolution.assertion_id ||
    event.workspace_id !== resolution.workspace_id ||
    stableStringify(payload) !== stableStringify(expected)
  ) {
    throw new CoreError("CONFLICT", `Relation assertion ${resolution.assertion_id} resolution EventLog payload is not canonical.`);
  }
}

function parseAdmissionPayload(payload: unknown, assertionId: string) {
  try {
    return RelationAssertionAdmittedPayloadSchema.parse(payload);
  } catch {
    throw new CoreError("CONFLICT", `Relation assertion ${assertionId} admission EventLog payload is not canonical.`);
  }
}

function parseResolutionPayload(payload: unknown, assertionId: string) {
  try {
    return RelationAssertionResolvedPayloadSchema.parse(payload);
  } catch {
    throw new CoreError("CONFLICT", `Relation assertion ${assertionId} resolution EventLog payload is not canonical.`);
  }
}
