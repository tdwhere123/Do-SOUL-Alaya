import { z } from "zod";
import { Phase05EventTypeSchema } from "./events/phase-0.5.js";
import { PhaseA1EventTypeSchema } from "./events/phase-a1.js";
import { PhaseA3EventTypeSchema } from "./events/phase-a3.js";
import { PhaseBEventTypeSchema } from "./events/phase-b.js";
import { PhaseCEventTypeSchema } from "./events/phase-c.js";
import { PhaseCExtensionEventTypeSchema } from "./events/phase-c-extension.js";
import { Phase1BEventTypeSchema } from "./events/phase-1b.js";
import { Phase2AEventTypeSchema } from "./events/phase-2a.js";
import { Phase2BEventTypeSchema } from "./events/phase-2b.js";
import { Phase3AEventTypeSchema } from "./events/phase-3a.js";
import { Phase3BEventTypeSchema } from "./events/phase-3b.js";
import { Phase3CEventTypeSchema } from "./events/phase-3c.js";
import { Phase4AEventTypeSchema } from "./events/phase-4a.js";
import { Phase4BEventTypeSchema } from "./events/phase-4b.js";
import { Phase4CEventTypeSchema } from "./events/phase-4c.js";
import { Phase5EventTypeSchema } from "./events/phase-5.js";
import { SoulGardenEventLogOrphanDetectedEventTypeSchema } from "./events/event-log-orphan.js";
import { StreamingEventTypeSchema } from "./events/message-delta.js";
import { TrustStateEventTypeSchema } from "./soul/trust-state.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "./schema-primitives.js";

const phase0EventTypeValues = [
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

export const Phase0EventType = {
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

export const Phase0EventTypeSchema = z.enum(phase0EventTypeValues);
export const EventTypeSchema = z.union([
  Phase0EventTypeSchema,
  Phase05EventTypeSchema,
  PhaseA1EventTypeSchema,
  PhaseA3EventTypeSchema,
  PhaseBEventTypeSchema,
  PhaseCEventTypeSchema,
  PhaseCExtensionEventTypeSchema,
  Phase1BEventTypeSchema,
  Phase2AEventTypeSchema,
  Phase2BEventTypeSchema,
  Phase3AEventTypeSchema,
  Phase3BEventTypeSchema,
  Phase3CEventTypeSchema,
  Phase4AEventTypeSchema,
  Phase4BEventTypeSchema,
  Phase4CEventTypeSchema,
  Phase5EventTypeSchema,
  SoulGardenEventLogOrphanDetectedEventTypeSchema,
  TrustStateEventTypeSchema,
  StreamingEventTypeSchema
]);

/**
 * EventLogEntry validates the envelope shape only — event_type is validated against the full
 * union, but payload_json is stored as an opaque record. Payload structure is intentionally
 * validated by each phase's parse helpers (e.g. parsePhase4BEventPayload) at the consumer
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

export type Phase0EventType = z.infer<typeof Phase0EventTypeSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
