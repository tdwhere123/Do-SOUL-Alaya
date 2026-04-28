import { z } from "zod";
import { Phase0EventType } from "../event-log.js";
import { EngineFinishReasonSchema } from "../engine-port.js";
import { RunModeSchema } from "../run.js";
import { EngineClassSchema } from "../runtime-run.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { WorkspaceKindSchema } from "../workspace.js";

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

const phase0PayloadSchemas = {
  [Phase0EventType.WORKSPACE_CREATED]: WorkspaceCreatedPayloadSchema,
  [Phase0EventType.WORKSPACE_DELETED]: WorkspaceDeletedPayloadSchema,
  [Phase0EventType.WORKSPACE_ENGINE_BINDING_UPDATED]: WorkspaceEngineBindingUpdatedPayloadSchema,
  [Phase0EventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED]:
    WorkspaceDefaultEngineClassUpdatedPayloadSchema,
  [Phase0EventType.RUN_CREATED]: RunCreatedPayloadSchema,
  [Phase0EventType.RUN_DELETED]: RunDeletedPayloadSchema,
  [Phase0EventType.RUN_RENAMED]: RunRenamedPayloadSchema,
  [Phase0EventType.RUN_ENGINE_BINDING_UPDATED]: RunEngineBindingUpdatedPayloadSchema,
  [Phase0EventType.RUN_MESSAGE_APPENDED]: RunMessageAppendedPayloadSchema,
  [Phase0EventType.ENGINE_RESPONSE_RECEIVED]: EngineResponseReceivedPayloadSchema
} as const;

const Phase0EventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const Phase0EventBaseSchema = Phase0EventBaseObjectSchema.readonly();

const WorkspaceCreatedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.WORKSPACE_CREATED),
  payload: WorkspaceCreatedPayloadSchema
});

const WorkspaceDeletedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.WORKSPACE_DELETED),
  payload: WorkspaceDeletedPayloadSchema
});

const WorkspaceEngineBindingUpdatedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.WORKSPACE_ENGINE_BINDING_UPDATED),
  payload: WorkspaceEngineBindingUpdatedPayloadSchema
});

const WorkspaceDefaultEngineClassUpdatedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED),
  payload: WorkspaceDefaultEngineClassUpdatedPayloadSchema
});

const RunCreatedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.RUN_CREATED),
  payload: RunCreatedPayloadSchema
});

const RunDeletedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.RUN_DELETED),
  payload: RunDeletedPayloadSchema
});

const RunRenamedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.RUN_RENAMED),
  payload: RunRenamedPayloadSchema
});

const RunEngineBindingUpdatedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.RUN_ENGINE_BINDING_UPDATED),
  payload: RunEngineBindingUpdatedPayloadSchema
});

const RunMessageAppendedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.RUN_MESSAGE_APPENDED),
  payload: RunMessageAppendedPayloadSchema
});

const EngineResponseReceivedEventObjectSchema = Phase0EventBaseObjectSchema.extend({
  event_type: z.literal(Phase0EventType.ENGINE_RESPONSE_RECEIVED),
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

const Phase0EventUnionSchema = z.discriminatedUnion("event_type", [
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

export const Phase0EventSchema = Phase0EventUnionSchema.readonly();

export type Phase0EventPayloadMap = {
  [K in keyof typeof phase0PayloadSchemas]: z.infer<(typeof phase0PayloadSchemas)[K]>;
};

export function parsePhase0EventPayload<T extends keyof typeof phase0PayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): Phase0EventPayloadMap[T] {
  const schema = phase0PayloadSchemas[eventType];
  return schema.parse(payload) as Phase0EventPayloadMap[T];
}

export type Phase0Event = z.infer<typeof Phase0EventSchema>;
