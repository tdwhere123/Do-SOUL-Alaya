import { z } from "zod";
import {
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedPathSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

const workerRuntimeEventTypeValues = [
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

export const WorkerRuntimeEventType = {
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

export const WorkerRuntimeEventTypeSchema = z.enum(workerRuntimeEventTypeValues);
export const WorkerSessionFinishedStatusSchema = z.enum(["completed", "cancelled", "failed"]);
export const WorkerToolCallOutcomeSchema = z.enum(["success", "error", "cancelled"]);
export const WorkerIntegrationStatusLevelSchema = z.enum(["ignore_drift", "soft_stale", "hard_stale"]);

const WorkerEventPayloadBaseSchema = z.object({
  sessionId: BoundedIdSchema,
  emittedAt: IsoDatetimeStringSchema
}).strict();

export const WorkerSessionStartedPayloadSchema = WorkerEventPayloadBaseSchema.strict().readonly();

export const WorkerSessionFinishedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  status: WorkerSessionFinishedStatusSchema,
  resultSummary: BoundedReasonSchema.nullable()
})
  .strict()
  .readonly();

export const WorkerMessageDeltaPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  workerRunId: BoundedIdSchema.optional(),
  delta: BoundedContentSchema,
  sequence: NonNegativeIntSchema
})
  .strict()
  .readonly();

export const WorkerToolCallStartedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  callId: BoundedIdSchema,
  toolId: BoundedLabelSchema
})
  .strict()
  .readonly();

export const WorkerToolCallFinishedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  callId: BoundedIdSchema,
  toolId: BoundedLabelSchema,
  outcome: WorkerToolCallOutcomeSchema,
  resultSummary: BoundedReasonSchema.nullable()
})
  .strict()
  .readonly();

export const WorkerPermissionRequestedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  requestId: BoundedIdSchema,
  toolId: BoundedLabelSchema,
  reason: BoundedReasonSchema
})
  .strict()
  .readonly();

export const WorkerPatchEmittedPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  patchId: BoundedIdSchema,
  pathHints: z.array(BoundedPathSchema).readonly()
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
    workerRunId: BoundedIdSchema,
    level: WorkerIntegrationStatusLevelSchema,
    reason: BoundedReasonSchema,
    detectedAt: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const WorkerRuntimeErrorPayloadSchema = WorkerEventPayloadBaseSchema.extend({
  errorCode: BoundedLabelSchema,
  message: BoundedReasonSchema
})
  .strict()
  .readonly();

const workerRuntimePayloadSchemas = {
  [WorkerRuntimeEventType.WORKER_SESSION_STARTED]: WorkerSessionStartedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_SESSION_FINISHED]: WorkerSessionFinishedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_MESSAGE_DELTA]: WorkerMessageDeltaPayloadSchema,
  [WorkerRuntimeEventType.WORKER_TOOL_CALL_STARTED]: WorkerToolCallStartedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_TOOL_CALL_FINISHED]: WorkerToolCallFinishedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED]: WorkerPermissionRequestedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_PATCH_EMITTED]: WorkerPatchEmittedPayloadSchema,
  [WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS]: WorkerIntegrationStatusPayloadSchema,
  [WorkerRuntimeEventType.WORKER_RUNTIME_ERROR]: WorkerRuntimeErrorPayloadSchema
} as const;

export function createWorkerRuntimeEventObjectSchema<T extends keyof typeof workerRuntimePayloadSchemas>(
  type: T,
  payloadSchema: (typeof workerRuntimePayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema }).strict();
}

const WorkerSessionStartedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_SESSION_STARTED,
  WorkerSessionStartedPayloadSchema
);
const WorkerSessionFinishedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_SESSION_FINISHED,
  WorkerSessionFinishedPayloadSchema
);
const WorkerMessageDeltaEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_MESSAGE_DELTA,
  WorkerMessageDeltaPayloadSchema
);
const WorkerToolCallStartedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_TOOL_CALL_STARTED,
  WorkerToolCallStartedPayloadSchema
);
const WorkerToolCallFinishedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_TOOL_CALL_FINISHED,
  WorkerToolCallFinishedPayloadSchema
);
const WorkerPermissionRequestedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED,
  WorkerPermissionRequestedPayloadSchema
);
const WorkerPatchEmittedEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_PATCH_EMITTED,
  WorkerPatchEmittedPayloadSchema
);
const WorkerIntegrationStatusEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_INTEGRATION_STATUS,
  WorkerIntegrationStatusPayloadSchema
);
const WorkerRuntimeErrorEventObjectSchema = createWorkerRuntimeEventObjectSchema(
  WorkerRuntimeEventType.WORKER_RUNTIME_ERROR,
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

export const WorkerRuntimeEventUnionSchema = z
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

export type WorkerRuntimeEventPayloadMap = {
  [K in keyof typeof workerRuntimePayloadSchemas]: z.infer<(typeof workerRuntimePayloadSchemas)[K]>;
};

export function parseWorkerRuntimeEventPayload<T extends keyof typeof workerRuntimePayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): WorkerRuntimeEventPayloadMap[T] {
  const schema = workerRuntimePayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase A3 event type: ${String(type)}`);
  }

  return schema.parse(payload) as WorkerRuntimeEventPayloadMap[T];
}

export type WorkerRuntimeEventTypeValue = z.infer<typeof WorkerRuntimeEventTypeSchema>;
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
export type WorkerRuntimeEvent = z.infer<typeof WorkerRuntimeEventUnionSchema>;
