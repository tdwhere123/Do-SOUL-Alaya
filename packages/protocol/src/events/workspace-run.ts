import { z } from "zod";
import { WorkspaceRunEventType } from "./event-log.js";
import { EngineFinishReasonSchema } from "../engine/engine-port.js";
import { RunModeSchema } from "../runtime/run.js";
import { EngineClassSchema } from "../runtime/runtime-run.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { WorkspaceKindSchema } from "../workspace/workspace.js";

const messageRoleValues = ["user", "assistant"] as const;

export const RunMessageRoleSchema = z.enum(messageRoleValues);

export const WorkspaceCreatedPayloadSchema = z.object({
  workspace_id: NonEmptyStringSchema,
  name: z.string(),
  workspace_kind: WorkspaceKindSchema
}).readonly();

export const WorkspaceDeletedPayloadSchema = z.object({
  workspace_id: NonEmptyStringSchema
}).readonly();

export const WorkspaceEngineBindingUpdatedPayloadSchema = z.object({
  workspace_id: NonEmptyStringSchema,
  binding_id: NonEmptyStringSchema,
  provider_type: z.enum(["openai", "anthropic", "custom"]),
  model: z.string(),
  base_url: z.string().url().nullable()
}).readonly();

export const WorkspaceDefaultEngineClassUpdatedPayloadSchema = z.object({
  workspace_id: NonEmptyStringSchema,
  default_engine_class: EngineClassSchema.nullable()
}).readonly();

export const RunCreatedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_mode: RunModeSchema,
  title: z.string()
}).readonly();

export const RunDeletedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema
}).readonly();

export const RunRenamedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  title: z.string(),
  previous_title: z.string()
}).readonly();

export const RunEngineBindingUpdatedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  engine_binding_id: NonEmptyStringSchema,
  previous_engine_binding_id: NonEmptyStringSchema.nullable()
}).readonly();

export const RunMessageAppendedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  role: RunMessageRoleSchema,
  content: z.string(),
  message_id: NonEmptyStringSchema,
  /** IDs of files attached to this message. Only present for user messages with uploads. */
  file_ids: z.array(NonEmptyStringSchema).optional()
}).readonly();

export const EngineResponseReceivedPayloadSchema = z.object({
  run_id: NonEmptyStringSchema,
  message_id: NonEmptyStringSchema,
  content: z.string(),
  finish_reason: EngineFinishReasonSchema
}).readonly();

const workspaceRunPayloadSchemas = {
  [WorkspaceRunEventType.WORKSPACE_CREATED]: WorkspaceCreatedPayloadSchema,
  [WorkspaceRunEventType.WORKSPACE_DELETED]: WorkspaceDeletedPayloadSchema,
  [WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED]: WorkspaceEngineBindingUpdatedPayloadSchema,
  [WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED]:
    WorkspaceDefaultEngineClassUpdatedPayloadSchema,
  [WorkspaceRunEventType.RUN_CREATED]: RunCreatedPayloadSchema,
  [WorkspaceRunEventType.RUN_DELETED]: RunDeletedPayloadSchema,
  [WorkspaceRunEventType.RUN_RENAMED]: RunRenamedPayloadSchema,
  [WorkspaceRunEventType.RUN_ENGINE_BINDING_UPDATED]: RunEngineBindingUpdatedPayloadSchema,
  [WorkspaceRunEventType.RUN_MESSAGE_APPENDED]: RunMessageAppendedPayloadSchema,
  [WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED]: EngineResponseReceivedPayloadSchema
} as const;

const WorkspaceRunEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const WorkspaceRunEventBaseSchema = WorkspaceRunEventBaseObjectSchema.readonly();

const WorkspaceCreatedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.WORKSPACE_CREATED),
  payload: WorkspaceCreatedPayloadSchema
});

const WorkspaceDeletedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.WORKSPACE_DELETED),
  payload: WorkspaceDeletedPayloadSchema
});

const WorkspaceEngineBindingUpdatedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED),
  payload: WorkspaceEngineBindingUpdatedPayloadSchema
});

const WorkspaceDefaultEngineClassUpdatedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED),
  payload: WorkspaceDefaultEngineClassUpdatedPayloadSchema
});

const RunCreatedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.RUN_CREATED),
  payload: RunCreatedPayloadSchema
});

const RunDeletedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.RUN_DELETED),
  payload: RunDeletedPayloadSchema
});

const RunRenamedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.RUN_RENAMED),
  payload: RunRenamedPayloadSchema
});

const RunEngineBindingUpdatedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.RUN_ENGINE_BINDING_UPDATED),
  payload: RunEngineBindingUpdatedPayloadSchema
});

const RunMessageAppendedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.RUN_MESSAGE_APPENDED),
  payload: RunMessageAppendedPayloadSchema
});

const EngineResponseReceivedEventObjectSchema = WorkspaceRunEventBaseObjectSchema.extend({
  event_type: z.literal(WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED),
  payload: EngineResponseReceivedPayloadSchema
});

export const WorkspaceCreatedEventSchema = WorkspaceCreatedEventObjectSchema.readonly();
export const WorkspaceDeletedEventSchema = WorkspaceDeletedEventObjectSchema.readonly();
export const WorkspaceEngineBindingUpdatedEventSchema = WorkspaceEngineBindingUpdatedEventObjectSchema.readonly();
export const WorkspaceDefaultEngineClassUpdatedEventSchema =
  WorkspaceDefaultEngineClassUpdatedEventObjectSchema.readonly();
export const RunCreatedEventSchema = RunCreatedEventObjectSchema.readonly();
export const RunDeletedEventSchema = RunDeletedEventObjectSchema.readonly();
export const RunRenamedEventSchema = RunRenamedEventObjectSchema.readonly();
export const RunEngineBindingUpdatedEventSchema =
  RunEngineBindingUpdatedEventObjectSchema.readonly();
export const RunMessageAppendedEventSchema = RunMessageAppendedEventObjectSchema.readonly();
export const EngineResponseReceivedEventSchema = EngineResponseReceivedEventObjectSchema.readonly();

const WorkspaceRunEventUnionSchema = z.discriminatedUnion("event_type", [
  WorkspaceCreatedEventObjectSchema,
  WorkspaceDeletedEventObjectSchema,
  WorkspaceEngineBindingUpdatedEventObjectSchema,
  WorkspaceDefaultEngineClassUpdatedEventObjectSchema,
  RunCreatedEventObjectSchema,
  RunDeletedEventObjectSchema,
  RunRenamedEventObjectSchema,
  RunEngineBindingUpdatedEventObjectSchema,
  RunMessageAppendedEventObjectSchema,
  EngineResponseReceivedEventObjectSchema
]);

export const WorkspaceRunEventSchema = WorkspaceRunEventUnionSchema.readonly();

export type WorkspaceRunEventPayloadMap = {
  [K in keyof typeof workspaceRunPayloadSchemas]: z.infer<(typeof workspaceRunPayloadSchemas)[K]>;
};

export function parseWorkspaceRunEventPayload<T extends keyof typeof workspaceRunPayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): WorkspaceRunEventPayloadMap[T] {
  const schema = workspaceRunPayloadSchemas[eventType];
  return schema.parse(payload) as WorkspaceRunEventPayloadMap[T];
}

export type WorkspaceRunEvent = z.infer<typeof WorkspaceRunEventSchema>;
