import { describe, expect, it } from "vitest";
import {
  EventLogEntrySchema,
  EventTypeSchema,
  FieldGenerationEventType,
  FieldGenerationEventTypeSchema,
  SoulFieldEffectDecidedPayloadSchema,
  SoulFieldEraseBarrierPayloadSchema,
  SoulFieldGenerationActivatedPayloadSchema,
  SoulFieldGenerationRebuildStartedPayloadSchema,
  SoulFieldSourceRecordAdmittedPayloadSchema,
  SoulFieldUsageCausalRecordedPayloadSchema,
  parseFieldGenerationEventPayload
} from "../../index.js";

const occurredAt = "2026-08-16T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

describe("field generation protocol events", () => {
  it("keeps FieldGenerationEventTypeSchema aligned with the exported event constants", () => {
    expect(FieldGenerationEventTypeSchema.options).toEqual([
      FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED,
      FieldGenerationEventType.SOUL_FIELD_GENERATION_REBUILD_STARTED,
      FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED,
      FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER,
      FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED,
      FieldGenerationEventType.SOUL_FIELD_USAGE_CAUSAL_RECORDED
    ]);
  });

  it("registers field generation events on the EventLog type union", () => {
    for (const eventType of FieldGenerationEventTypeSchema.options) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }
  });

  it("parses content-free payloads and rejects source bytes on erase", () => {
    expect(SoulFieldSourceRecordAdmittedPayloadSchema.parse({
      workspace_id: "workspace-1",
      record_id: digest,
      source_id: "src-1",
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: null,
      recorded_at: occurredAt,
      event_time: null,
      valid_from: null,
      valid_to: null,
      operator_id: "source_span_identity_v1"
    })).toMatchObject({ record_id: digest });
    expect(() => SoulFieldSourceRecordAdmittedPayloadSchema.parse({
      workspace_id: "workspace-1",
      record_id: digest,
      source_id: "src-1",
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: null,
      recorded_at: occurredAt,
      event_time: null,
      valid_from: null,
      valid_to: null,
      operator_id: "source_span_identity_v1",
      source_bytes: "plaintext"
    })).toThrow();
    expect(() => SoulFieldEraseBarrierPayloadSchema.parse({
      workspace_id: "workspace-1",
      barrier_id: "barrier-1",
      generation_id: null,
      subject_kind: "source_record",
      subject_id: digest,
      erased_at: occurredAt,
      excerpt: "no"
    })).toThrow();
    expect(SoulFieldGenerationRebuildStartedPayloadSchema.parse({
      workspace_id: "workspace-1",
      generation_id: digest,
      operator_manifest_digest: digest,
      schema_version: "1",
      input_event_frontier: "event-1",
      governance_frontier: "gov-1",
      occurred_at: occurredAt
    }).generation_id).toBe(digest);
    expect(SoulFieldGenerationActivatedPayloadSchema.parse({
      workspace_id: "workspace-1",
      generation_id: digest,
      previous_generation_id: null,
      activated_at: occurredAt
    }).previous_generation_id).toBeNull();
    expect(SoulFieldEffectDecidedPayloadSchema.parse({
      workspace_id: "workspace-1",
      request_digest: digest,
      action: "seal",
      target: "claim-1",
      scope: "workspace-1",
      effective_as_of: occurredAt,
      decision: "deny",
      occurred_at: occurredAt
    }).decision).toBe("deny");
    expect(SoulFieldUsageCausalRecordedPayloadSchema.parse({
      workspace_id: "workspace-1",
      identity: digest,
      causal_key: "use-1",
      occurred_at: occurredAt,
      downstream_ref: "path-1",
      weight: 0,
      scope: "workspace-1",
      usage_kind: "causal",
      operator_id: "causal_usage_v1"
    }).weight).toBe(0);
    expect(() => parseFieldGenerationEventPayload(
      FieldGenerationEventType.SOUL_FIELD_USAGE_CAUSAL_RECORDED,
      {
        workspace_id: "workspace-1",
        identity: digest,
        causal_key: "use-1",
        occurred_at: occurredAt,
        downstream_ref: "path-1",
        weight: 0,
        scope: "workspace-1",
        usage_kind: "delivery",
        operator_id: "causal_usage_v1"
      }
    )).toThrow();
  });

  it("accepts the event log envelope for field generation events", () => {
    const entry = {
      event_id: "event-log-entry-1",
      event_type: FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER,
      entity_type: "projection_erase_barrier",
      entity_id: "barrier-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "governance",
      revision: 0,
      payload_json: {
        workspace_id: "workspace-1",
        barrier_id: "barrier-1",
        generation_id: null,
        subject_kind: "source_record",
        subject_id: digest,
        erased_at: occurredAt
      },
      created_at: occurredAt
    } as const;

    expect(EventLogEntrySchema.parse(entry)).toEqual(entry);
  });
});
