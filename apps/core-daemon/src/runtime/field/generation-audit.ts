import {
  FieldGenerationEventType,
  SoulFieldGenerationActivatedPayloadSchema,
  SoulFieldGenerationRebuildStartedPayloadSchema,
  type EventLogEntry,
  type FieldProjectionGeneration
} from "@do-soul/alaya-protocol";

export type FieldEventLogPort = {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
    EventLogEntry | Promise<EventLogEntry>;
};

export function appendGenerationRebuildStarted(
  eventLog: FieldEventLogPort,
  generation: FieldProjectionGeneration
): void {
  void eventLog.append({
    event_type: FieldGenerationEventType.SOUL_FIELD_GENERATION_REBUILD_STARTED,
    entity_type: "projection_generation",
    entity_id: generation.generation_id,
    workspace_id: generation.workspace_id,
    run_id: null,
    caused_by: "system",
    payload_json: SoulFieldGenerationRebuildStartedPayloadSchema.parse({
      workspace_id: generation.workspace_id,
      generation_id: generation.generation_id,
      operator_manifest_digest: generation.operator_manifest_digest,
      schema_version: generation.field_schema_version,
      input_event_frontier: generation.input_event_frontier,
      governance_frontier: generation.governance_frontier,
      occurred_at: generation.recorded_at
    })
  });
}

export function appendGenerationActivated(
  eventLog: FieldEventLogPort,
  generation: FieldProjectionGeneration,
  previousGenerationId: string | null
): void {
  void eventLog.append({
    event_type: FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED,
    entity_type: "projection_generation",
    entity_id: generation.generation_id,
    workspace_id: generation.workspace_id,
    run_id: null,
    caused_by: "system",
    payload_json: SoulFieldGenerationActivatedPayloadSchema.parse({
      workspace_id: generation.workspace_id,
      generation_id: generation.generation_id,
      previous_generation_id: previousGenerationId,
      activated_at: generation.recorded_at
    })
  });
}
