import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const phaseA3EventTypeValues = [
  "worker.session_started",
  "worker.session_finished",
  "worker.message_delta",
  "worker.tool_call_started",
  "worker.tool_call_finished",
  "worker.permission_requested",
  "worker.patch_emitted",
  "worker.integration_status",
  "worker.runtime_error"
] as const;

export const PhaseA3EventType = {
  WORKER_SESSION_STARTED: "worker.session_started",
  WORKER_SESSION_FINISHED: "worker.session_finished",
  WORKER_MESSAGE_DELTA: "worker.message_delta",
  WORKER_TOOL_CALL_STARTED: "worker.tool_call_started",
  WORKER_TOOL_CALL_FINISHED: "worker.tool_call_finished",
  WORKER_PERMISSION_REQUESTED: "worker.permission_requested",
  WORKER_PATCH_EMITTED: "worker.patch_emitted",
  WORKER_INTEGRATION_STATUS: "worker.integration_status",
  WORKER_RUNTIME_ERROR: "worker.runtime_error"
} as const;

export const PhaseA3EventTypeSchema = z.enum(phaseA3EventTypeValues);
export const WorkerSessionFinishedStatusSchema = z.enum(["completed", "cancelled", "failed"]);
export const WorkerToolCallOutcomeSchema = z.enum(["success", "error", "cancelled"]);
export const WorkerIntegrationStatusLevelSchema = z.enum(["ignore_drift", "soft_stale", "hard_stale"]);

const WorkerEventPayloadBaseSchema = z.object({
  sessionId: NonEmptyStringSchema,
  emittedAt: IsoDatetimeStringSchema
});

export const WorkerSessionStartedPayloadSchema = WorkerEventPayloadBaseSchema.strict().readonly();

export const WorkerSessionFinishedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  status: WorkerSessionFinishedStatusSchema,
  resultSummary: z.string().nullable()
})
  .strict()
  .readonly();

export const WorkerMessageDeltaPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  workerRunId: NonEmptyStringSchema.optional(),
  delta: z.string(),
  sequence: NonNegativeIntSchema
})
  .strict()
  .readonly();

export const WorkerToolCallStartedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  callId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema
})
  .strict()
  .readonly();

export const WorkerToolCallFinishedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  callId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema,
  outcome: WorkerToolCallOutcomeSchema,
  resultSummary: z.string().nullable()
})
  .strict()
  .readonly();

export const WorkerPermissionRequestedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  requestId: NonEmptyStringSchema,
  toolId: NonEmptyStringSchema,
  reason: NonEmptyStringSchema
})
  .strict()
  .readonly();

export const WorkerPatchEmittedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  patchId: NonEmptyStringSchema,
  pathHints: z.array(NonEmptyStringSchema).readonly()
})
  .strict()
  .readonly();

/**
 * Integration status is emitted by the daemon-owned integration gate before a
 * runtime session exists, so it intentionally uses workerRunId/detectedAt
 * instead of WorkerEventPayloadBase(sessionId/emittedAt).
 */
export const WorkerIntegrationStatusPayloadSchema = z
  .object({
    workerRunId: NonEmptyStringSchema,
    level: WorkerIntegrationStatusLevelSchema,
    reason: NonEmptyStringSchema,
    detectedAt: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const WorkerRuntimeErrorPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  errorCode: NonEmptyStringSchema,
  message: NonEmptyStringSchema
})
  .strict()
  .readonly();

const phaseA3PayloadSchemas = {
  [PhaseA3EventType.WORKER_SESSION_STARTED]: WorkerSessionStartedPayloadSchema,
  [PhaseA3EventType.WORKER_SESSION_FINISHED]: WorkerSessionFinishedPayloadSchema,
  [PhaseA3EventType.WORKER_MESSAGE_DELTA]: WorkerMessageDeltaPayloadSchema,
  [PhaseA3EventType.WORKER_TOOL_CALL_STARTED]: WorkerToolCallStartedPayloadSchema,
  [PhaseA3EventType.WORKER_TOOL_CALL_FINISHED]: WorkerToolCallFinishedPayloadSchema,
  [PhaseA3EventType.WORKER_PERMISSION_REQUESTED]: WorkerPermissionRequestedPayloadSchema,
  [PhaseA3EventType.WORKER_PATCH_EMITTED]: WorkerPatchEmittedPayloadSchema,
  [PhaseA3EventType.WORKER_INTEGRATION_STATUS]: WorkerIntegrationStatusPayloadSchema,
  [PhaseA3EventType.WORKER_RUNTIME_ERROR]: WorkerRuntimeErrorPayloadSchema
} as const;

export function createPhaseA3EventObjectSchema<T extends keyof typeof phaseA3PayloadSchemas>(
  type: T,
  payloadSchema: (typeof phaseA3PayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const WorkerSessionStartedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_SESSION_STARTED,
  WorkerSessionStartedPayloadSchema
);
const WorkerSessionFinishedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_SESSION_FINISHED,
  WorkerSessionFinishedPayloadSchema
);
const WorkerMessageDeltaEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_MESSAGE_DELTA,
  WorkerMessageDeltaPayloadSchema
);
const WorkerToolCallStartedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_TOOL_CALL_STARTED,
  WorkerToolCallStartedPayloadSchema
);
const WorkerToolCallFinishedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_TOOL_CALL_FINISHED,
  WorkerToolCallFinishedPayloadSchema
);
const WorkerPermissionRequestedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_PERMISSION_REQUESTED,
  WorkerPermissionRequestedPayloadSchema
);
const WorkerPatchEmittedEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_PATCH_EMITTED,
  WorkerPatchEmittedPayloadSchema
);
const WorkerIntegrationStatusEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_INTEGRATION_STATUS,
  WorkerIntegrationStatusPayloadSchema
);
const WorkerRuntimeErrorEventObjectSchema = createPhaseA3EventObjectSchema(
  PhaseA3EventType.WORKER_RUNTIME_ERROR,
  WorkerRuntimeErrorPayloadSchema
);

export const WorkerSessionStartedEventSchema = WorkerSessionStartedEventObjectSchema.readonly();
export const WorkerSessionFinishedEventSchema = WorkerSessionFinishedEventObjectSchema.readonly();
export const WorkerMessageDeltaEventSchema = WorkerMessageDeltaEventObjectSchema.readonly();
export const WorkerToolCallStartedEventSchema = WorkerToolCallStartedEventObjectSchema.readonly();
export const WorkerToolCallFinishedEventSchema = WorkerToolCallFinishedEventObjectSchema.readonly();
export const WorkerPermissionRequestedEventSchema = WorkerPermissionRequestedEventObjectSchema.readonly();
export const WorkerPatchEmittedEventSchema = WorkerPatchEmittedEventObjectSchema.readonly();
export const WorkerIntegrationStatusEventSchema = WorkerIntegrationStatusEventObjectSchema.readonly();
export const WorkerRuntimeErrorEventSchema = WorkerRuntimeErrorEventObjectSchema.readonly();

export const PhaseA3EventUnionSchema = z
  .discriminatedUnion("type", [
    WorkerSessionStartedEventObjectSchema,
    WorkerSessionFinishedEventObjectSchema,
    WorkerMessageDeltaEventObjectSchema,
    WorkerToolCallStartedEventObjectSchema,
    WorkerToolCallFinishedEventObjectSchema,
    WorkerPermissionRequestedEventObjectSchema,
    WorkerPatchEmittedEventObjectSchema,
    WorkerIntegrationStatusEventObjectSchema,
    WorkerRuntimeErrorEventObjectSchema
  ])
  .readonly();

export type PhaseA3EventPayloadMap = {
  [K in keyof typeof phaseA3PayloadSchemas]: z.infer<(typeof phaseA3PayloadSchemas)[K]>;
};

export function parsePhaseA3EventPayload<T extends keyof typeof phaseA3PayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): PhaseA3EventPayloadMap[T] {
  const schema = phaseA3PayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase A3 event type: ${String(type)}`);
  }

  return schema.parse(payload) as PhaseA3EventPayloadMap[T];
}

export type PhaseA3EventTypeValue = z.infer<typeof PhaseA3EventTypeSchema>;
export type WorkerSessionFinishedStatus = z.infer<typeof WorkerSessionFinishedStatusSchema>;
export type WorkerToolCallOutcome = z.infer<typeof WorkerToolCallOutcomeSchema>;
export type WorkerIntegrationStatusLevel = z.infer<typeof WorkerIntegrationStatusLevelSchema>;
export type WorkerSessionStartedPayload = z.infer<typeof WorkerSessionStartedPayloadSchema>;
export type WorkerSessionFinishedPayload = z.infer<typeof WorkerSessionFinishedPayloadSchema>;
export type WorkerMessageDeltaPayload = z.infer<typeof WorkerMessageDeltaPayloadSchema>;
export type WorkerToolCallStartedPayload = z.infer<typeof WorkerToolCallStartedPayloadSchema>;
export type WorkerToolCallFinishedPayload = z.infer<typeof WorkerToolCallFinishedPayloadSchema>;
export type WorkerPermissionRequestedPayload = z.infer<typeof WorkerPermissionRequestedPayloadSchema>;
export type WorkerPatchEmittedPayload = z.infer<typeof WorkerPatchEmittedPayloadSchema>;
export type WorkerIntegrationStatusPayload = z.infer<typeof WorkerIntegrationStatusPayloadSchema>;
export type WorkerRuntimeErrorPayload = z.infer<typeof WorkerRuntimeErrorPayloadSchema>;
export type PhaseA3Event = z.infer<typeof PhaseA3EventUnionSchema>;
