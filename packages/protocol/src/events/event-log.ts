import { z } from "zod";
import { SignalEventTypeSchema } from "./signal.js";
import { ToolWorkerEventTypeSchema } from "./tool-worker.js";
import { WorkerRuntimeEventTypeSchema } from "./worker-runtime.js";
import { ObligationTrustNarrativeEventTypeSchema } from "./obligation-trust-narrative.js";
import { RuntimeGovernanceEventTypeSchema } from "./runtime-governance.js";
import { ComputeRecallGardenEventTypeSchema } from "./compute-recall-garden.js";
import { MemoryGovernanceEventTypeSchema } from "./memory-governance.js";
import { GovernanceResolutionEventTypeSchema } from "./governance-resolution.js";
import { SlotEventTypeSchema } from "./slot.js";
import { SurfaceEventTypeSchema } from "./surface.js";
import { RecallContextEventTypeSchema } from "./recall-context.js";
import { GreenGovernanceEventTypeSchema } from "./green-governance.js";
import { BudgetEventTypeSchema } from "./budget.js";
import { GardenEventTypeSchema } from "./garden.js";
import { GraphAuditorEventTypeSchema } from "./graph-auditor.js";
import { ProjectMappingEventTypeSchema } from "./project-mapping.js";
import { FileApprovalEventTypeSchema } from "./file-approval.js";
import { SoulGardenEventLogOrphanDetectedEventTypeSchema } from "./event-log-orphan.js";
import { StreamingEventTypeSchema } from "./message-delta.js";
import { TrustStateEventTypeSchema } from "../soul/trust-state.js";
import {
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

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
  GovernanceResolutionEventTypeSchema,
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
  event_id: BoundedIdSchema,
  event_type: EventTypeSchema,
  entity_type: BoundedLabelSchema,
  entity_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema.nullable(),
  caused_by: BoundedIdSchema.nullable(),
  revision: NonNegativeIntSchema,
  payload_json: BoundedJsonObjectSchema,
  created_at: IsoDatetimeStringSchema
}).strict().readonly();

export type WorkspaceRunEventType = z.infer<typeof WorkspaceRunEventTypeSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
