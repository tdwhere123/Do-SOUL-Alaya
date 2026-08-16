import {
  FieldGenerationEventType,
  SoulFieldSourceRecordAdmittedPayloadSchema,
  type EventLogEntry,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";

export async function appendSourceRecordAdmitted(
  eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
  record: SourceRecordIdentity
): Promise<void> {
  await eventLogRepo.append({
    event_type: FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED,
    entity_type: "source_record",
    entity_id: record.identity,
    workspace_id: record.workspace_id,
    run_id: null,
    caused_by: "system",
    payload_json: SoulFieldSourceRecordAdmittedPayloadSchema.parse({
      workspace_id: record.workspace_id,
      record_id: record.identity,
      source_id: record.source_id,
      source_version: record.source_version,
      content_digest: record.content_digest,
      evidence_object_id: record.evidence_object_id,
      recorded_at: record.recorded_at,
      event_time: record.event_time,
      valid_from: record.valid_from,
      valid_to: record.valid_to,
      operator_id: record.operator_id
    })
  });
}
