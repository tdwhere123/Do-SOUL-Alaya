import { describe, expect, it } from "vitest";
import {
  EventLogEntrySchema,
  SlotEventSchema,
  SlotEventType,
  SoulConflictMatrixEdgeDeletedPayloadSchema,
  parseSlotEventPayload
} from "../../index.js";

const payload = {
  object_id: "edge-1",
  object_kind: "conflict_matrix_edge",
  workspace_id: "workspace-1",
  run_id: null,
  source_claim_id: "claim-1",
  target_claim_id: "claim-2",
  edge_type: "incompatible_with"
} as const;

const envelope = {
  event_id: "event-1",
  event_type: SlotEventType.SOUL_CONFLICT_MATRIX_EDGE_DELETED,
  entity_type: "conflict_matrix_edge",
  entity_id: "edge-1",
  workspace_id: "workspace-1",
  run_id: null,
  caused_by: "system",
  revision: 1,
  created_at: "2026-10-19T00:00:00.000Z"
} as const;

describe("conflict-matrix edge deletion audit", () => {
  it("registers the deletion body, event union, envelope, and public parser", () => {
    expect(envelope.event_type).toBe("soul.conflict_matrix_edge.deleted");
    expect(parseSlotEventPayload(envelope.event_type, payload)).toEqual(payload);
    expect(SlotEventSchema.parse({ ...envelope, payload })).toEqual({ ...envelope, payload });
    expect(EventLogEntrySchema.parse({ ...envelope, payload_json: payload }).payload_json).toEqual(payload);
  });

  it("requires the deleted edge endpoints and rejects unrelated fields", () => {
    const { target_claim_id: _, ...missingEndpoint } = payload;
    expect(SoulConflictMatrixEdgeDeletedPayloadSchema.safeParse(missingEndpoint).success).toBe(false);
    expect(SoulConflictMatrixEdgeDeletedPayloadSchema.safeParse({ ...payload, deleted: true }).success).toBe(false);
  });
});
