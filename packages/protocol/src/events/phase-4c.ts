import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { AcceptedBySchema, ProjectMappingStateSchema } from "../soul/project-mapping.js";

const phase4CEventTypeValues = [
  "soul.project_mapping.suggested",
  "soul.project_mapping.state_changed"
] as const;

export const Phase4CEventType = {
  PROJECT_MAPPING_SUGGESTED: "soul.project_mapping.suggested",
  PROJECT_MAPPING_STATE_CHANGED: "soul.project_mapping.state_changed"
} as const;

export const Phase4CEventTypeSchema = z.enum(phase4CEventTypeValues);

export const SoulProjectMappingSuggestedPayloadSchema = z
  .object({
    mapping_id: NonEmptyStringSchema,
    global_object_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    initial_state: z.literal("suggested"),
    suggested_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulProjectMappingStateChangedPayloadSchema = z
  .object({
    mapping_id: NonEmptyStringSchema,
    global_object_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    from_state: ProjectMappingStateSchema,
    to_state: ProjectMappingStateSchema,
    accepted_by: AcceptedBySchema.nullable().optional(),
    transitioned_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

const phase4CPayloadSchemas = {
  [Phase4CEventType.PROJECT_MAPPING_SUGGESTED]: SoulProjectMappingSuggestedPayloadSchema,
  [Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED]: SoulProjectMappingStateChangedPayloadSchema
} as const;

export function createPhase4CEventObjectSchema<T extends keyof typeof phase4CPayloadSchemas>(
  type: T,
  payloadSchema: (typeof phase4CPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulProjectMappingSuggestedEventObjectSchema = createPhase4CEventObjectSchema(
  Phase4CEventType.PROJECT_MAPPING_SUGGESTED,
  SoulProjectMappingSuggestedPayloadSchema
);
const SoulProjectMappingStateChangedEventObjectSchema = createPhase4CEventObjectSchema(
  Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED,
  SoulProjectMappingStateChangedPayloadSchema
);

export const SoulProjectMappingSuggestedEventSchema = SoulProjectMappingSuggestedEventObjectSchema.readonly();
export const SoulProjectMappingStateChangedEventSchema = SoulProjectMappingStateChangedEventObjectSchema.readonly();

export const Phase4CEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulProjectMappingSuggestedEventObjectSchema,
    SoulProjectMappingStateChangedEventObjectSchema
  ])
  .readonly();

export type Phase4CEventPayloadMap = {
  [K in keyof typeof phase4CPayloadSchemas]: z.infer<(typeof phase4CPayloadSchemas)[K]>;
};

export function parsePhase4CEventPayload<T extends keyof typeof phase4CPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): Phase4CEventPayloadMap[T] {
  const schema = phase4CPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase 4C event type: ${String(type)}`);
  }

  return schema.parse(payload) as Phase4CEventPayloadMap[T];
}

export type SoulProjectMappingSuggestedPayload = z.infer<typeof SoulProjectMappingSuggestedPayloadSchema>;
export type SoulProjectMappingStateChangedPayload = z.infer<typeof SoulProjectMappingStateChangedPayloadSchema>;
export type Phase4CEventTypeValue = z.infer<typeof Phase4CEventTypeSchema>;
export type Phase4CEvent = z.infer<typeof Phase4CEventUnionSchema>;
