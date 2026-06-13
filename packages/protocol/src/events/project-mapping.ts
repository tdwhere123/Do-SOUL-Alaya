import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { AcceptedBySchema, ProjectMappingStateSchema } from "../soul/project-mapping.js";

const projectMappingEventTypeValues = [
  "soul.project_mapping.suggested",
  "soul.project_mapping.state_changed"
] as const;

export const ProjectMappingEventType = {
  PROJECT_MAPPING_SUGGESTED: "soul.project_mapping.suggested",
  PROJECT_MAPPING_STATE_CHANGED: "soul.project_mapping.state_changed"
} as const;

export const ProjectMappingEventTypeSchema = z.enum(projectMappingEventTypeValues);

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

const projectMappingPayloadSchemas = {
  [ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED]: SoulProjectMappingSuggestedPayloadSchema,
  [ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED]: SoulProjectMappingStateChangedPayloadSchema
} as const;

export function createProjectMappingEventObjectSchema<T extends keyof typeof projectMappingPayloadSchemas>(
  type: T,
  payloadSchema: (typeof projectMappingPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulProjectMappingSuggestedEventObjectSchema = createProjectMappingEventObjectSchema(
  ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED,
  SoulProjectMappingSuggestedPayloadSchema
);
const SoulProjectMappingStateChangedEventObjectSchema = createProjectMappingEventObjectSchema(
  ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED,
  SoulProjectMappingStateChangedPayloadSchema
);

export const SoulProjectMappingSuggestedEventSchema = SoulProjectMappingSuggestedEventObjectSchema.readonly();
export const SoulProjectMappingStateChangedEventSchema = SoulProjectMappingStateChangedEventObjectSchema.readonly();

export const ProjectMappingEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulProjectMappingSuggestedEventObjectSchema,
    SoulProjectMappingStateChangedEventObjectSchema
  ])
  .readonly();

export type ProjectMappingEventPayloadMap = {
  [K in keyof typeof projectMappingPayloadSchemas]: z.infer<(typeof projectMappingPayloadSchemas)[K]>;
};

export function parseProjectMappingEventPayload<T extends keyof typeof projectMappingPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): ProjectMappingEventPayloadMap[T] {
  const schema = projectMappingPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase 4C event type: ${String(type)}`);
  }

  return schema.parse(payload) as ProjectMappingEventPayloadMap[T];
}

export type SoulProjectMappingSuggestedPayload = z.infer<typeof SoulProjectMappingSuggestedPayloadSchema>;
export type SoulProjectMappingStateChangedPayload = z.infer<typeof SoulProjectMappingStateChangedPayloadSchema>;
export type ProjectMappingEventTypeValue = z.infer<typeof ProjectMappingEventTypeSchema>;
export type ProjectMappingEvent = z.infer<typeof ProjectMappingEventUnionSchema>;
