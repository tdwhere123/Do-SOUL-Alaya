import { z } from "zod";
import { SignalEventTypeSchema } from "./events/signal.js";
import { ToolWorkerEventTypeSchema } from "./events/tool-worker.js";
import { WorkerRuntimeEventTypeSchema } from "./events/worker-runtime.js";
import { ObligationTrustNarrativeEventTypeSchema } from "./events/obligation-trust-narrative.js";
import { RuntimeGovernanceEventTypeSchema } from "./events/runtime-governance.js";
import { ComputeRecallGardenEventTypeSchema } from "./events/compute-recall-garden.js";
import { MemoryGovernanceEventTypeSchema } from "./events/memory-governance.js";
import { SlotEventTypeSchema } from "./events/slot.js";
import { SurfaceEventTypeSchema } from "./events/surface.js";
import { RecallContextEventTypeSchema } from "./events/recall-context.js";
import { GreenGovernanceEventTypeSchema } from "./events/green-governance.js";
import { BudgetEventTypeSchema } from "./events/budget.js";
import { GardenEventTypeSchema } from "./events/garden.js";
import { GraphAuditorEventTypeSchema } from "./events/graph-auditor.js";
import { ProjectMappingEventTypeSchema } from "./events/project-mapping.js";
import { FileApprovalEventTypeSchema } from "./events/file-approval.js";
import { SoulGardenEventLogOrphanDetectedEventTypeSchema } from "./events/event-log-orphan.js";
import { StreamingEventTypeSchema } from "./events/message-delta.js";
import { TrustStateEventTypeSchema } from "./soul/trust-state.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "./schema-primitives.js";

const workspaceRunEventTypeValues = [
  "workspace.created",
  "workspace.deleted",
  "workspace.engine_binding.updated",
  "workspace.default_engine_class.updated",
  "run.created",
  "run.deleted",
  "run.renamed",
  "run.engine_binding.updated",
  "run.message.appended",
  "engine.response.received"
] as const;

export const WorkspaceRunEventType = {
  WORKSPACE_CREATED: "workspace.created",
  WORKSPACE_DELETED: "workspace.deleted",
  WORKSPACE_ENGINE_BINDING_UPDATED: "workspace.engine_binding.updated",
  WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED: "workspace.default_engine_class.updated",
  RUN_CREATED: "run.created",
  RUN_DELETED: "run.deleted",
  RUN_RENAMED: "run.renamed",
  RUN_ENGINE_BINDING_UPDATED: "run.engine_binding.updated",
  RUN_MESSAGE_APPENDED: "run.message.appended",
  ENGINE_RESPONSE_RECEIVED: "engine.response.received"
} as const;

export const WorkspaceRunEventTypeSchema = z.enum(workspaceRunEventTypeValues);
export const EventTypeSchema = z.union([
  WorkspaceRunEventTypeSchema,
  SignalEventTypeSchema,
  ToolWorkerEventTypeSchema,
  WorkerRuntimeEventTypeSchema,
  ObligationTrustNarrativeEventTypeSchema,
  RuntimeGovernanceEventTypeSchema,
  ComputeRecallGardenEventTypeSchema,
  MemoryGovernanceEventTypeSchema,
  SlotEventTypeSchema,
  SurfaceEventTypeSchema,
  RecallContextEventTypeSchema,
  GreenGovernanceEventTypeSchema,
  BudgetEventTypeSchema,
  GardenEventTypeSchema,
  GraphAuditorEventTypeSchema,
  ProjectMappingEventTypeSchema,
  FileApprovalEventTypeSchema,
  SoulGardenEventLogOrphanDetectedEventTypeSchema,
  TrustStateEventTypeSchema,
  StreamingEventTypeSchema
]);

/**
 * EventLogEntry validates the envelope shape only — event_type is validated against the full
 * union, but payload_json is stored as an opaque record. Payload structure is intentionally
 * validated by each phase's parse helpers (e.g. parseGraphAuditorEventPayload) at the consumer
 * boundary, not here. Adding discriminated union validation here would couple this schema to
 * every event phase and violate the open/closed principle.
 */
export const EventLogEntrySchema = z.object({
  event_id: NonEmptyStringSchema,
  event_type: EventTypeSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  payload_json: z.record(z.unknown()),
  created_at: IsoDatetimeStringSchema
}).readonly();

export type WorkspaceRunEventType = z.infer<typeof WorkspaceRunEventTypeSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
