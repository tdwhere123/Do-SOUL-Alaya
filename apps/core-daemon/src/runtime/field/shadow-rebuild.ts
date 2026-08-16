import {
  FieldGenerationEventType,
  FIELD_CONTRACT_SCHEMA_VERSION,
  FIELD_OPERATOR_MANIFEST,
  SoulFieldGenerationActivatedPayloadSchema,
  SoulFieldGenerationRebuildStartedPayloadSchema,
  type EventLogEntry,
  type FieldContractSha256,
  type FieldProjectionGeneration
} from "@do-soul/alaya-protocol";
import { createProjectionGenerationReceipt, fieldContractSha256 } from "@do-soul/alaya-core";
import type {
  FieldProjectionGenerationRepo,
  FieldProjectionGenerationRow
} from "@do-soul/alaya-storage";

export function rebuildAndActivateProjectionGeneration(input: Readonly<{
  readonly workspaceId: string;
  readonly inputEventFrontier: string;
  readonly governanceFrontier: string;
  readonly recordedAt: string;
  readonly generations: FieldProjectionGenerationRepo;
  readonly eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  };
  readonly sha256?: FieldContractSha256;
}>): FieldProjectionGeneration {
  const sha256 = input.sha256 ?? fieldContractSha256;
  const generation = createProjectionGenerationReceipt({
    workspace_id: input.workspaceId,
    input_event_frontier: input.inputEventFrontier,
    governance_frontier: input.governanceFrontier,
    status: "shadow",
    recorded_at: input.recordedAt
  }, sha256);
  const previous = input.generations.readActive(input.workspaceId);
  if (previous?.generation_id === generation.generation_id) {
    return generation;
  }
  appendRebuildStarted(input.eventLog, generation);
  input.generations.insert(generationToRow(generation));
  input.generations.persistStatus(input.workspaceId, generation.generation_id, "verified");
  input.generations.activatePointer({
    workspace_id: input.workspaceId,
    active_generation_id: generation.generation_id,
    activated_at: input.recordedAt
  });
  appendActivated(input.eventLog, generation, previous?.generation_id ?? null);
  return generation;
}

function generationToRow(generation: FieldProjectionGeneration): FieldProjectionGenerationRow {
  return {
    generation_id: generation.generation_id,
    workspace_id: generation.workspace_id,
    operator_manifest_digest: generation.operator_manifest_digest,
    operator_versions_json: JSON.stringify(
      FIELD_OPERATOR_MANIFEST.map((entry) => [entry.id, entry.version])
    ),
    schema_version: generation.field_schema_version,
    input_event_frontier: generation.input_event_frontier,
    governance_frontier: generation.governance_frontier,
    status: generation.status,
    recorded_at: generation.recorded_at
  };
}

function appendRebuildStarted(
  eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
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
      schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
      input_event_frontier: generation.input_event_frontier,
      governance_frontier: generation.governance_frontier,
      occurred_at: generation.recorded_at
    })
  });
}

function appendActivated(
  eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
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
