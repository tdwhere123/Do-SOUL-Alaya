import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { SupportedMimeTypeSchema } from "../workspace/files.js";

const fileApprovalEventTypeValues = [
  "file.uploaded",
  "soul.hint_emitted",
  "soul.correction_issued",
  "soul.explanation_provided",
  "soul.approval_requested",
  "soul.approval_resolved"
] as const;

export const FileApprovalEventType = {
  FILE_UPLOADED: "file.uploaded",
  SOUL_HINT_EMITTED: "soul.hint_emitted",
  SOUL_CORRECTION_ISSUED: "soul.correction_issued",
  SOUL_EXPLANATION_PROVIDED: "soul.explanation_provided",
  SOUL_APPROVAL_REQUESTED: "soul.approval_requested",
  SOUL_APPROVAL_RESOLVED: "soul.approval_resolved"
} as const;

export const FileApprovalEventTypeSchema = z.enum(fileApprovalEventTypeValues);
export const SoulInteractionRiskLevelSchema = z.enum(["low", "medium", "high"]);
export const ApprovalResolutionResultSchema = z.enum(["approved", "rejected"]);

export const FileUploadedPayloadSchema = z
  .object({
    file_id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    mime_type: SupportedMimeTypeSchema,
    size_bytes: z.number().int().positive().max(20 * 1024 * 1024),
    workspace_id: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

const OptionalSourceKindSchema = NonEmptyStringSchema.optional();

export const SoulHintEmittedPayloadSchema = z
  .object({
    message_id: NonEmptyStringSchema,
    hint: NonEmptyStringSchema,
    source_kind: OptionalSourceKindSchema
  })
  .strict()
  .readonly();

export const SoulCorrectionIssuedPayloadSchema = z
  .object({
    message_id: NonEmptyStringSchema,
    original: NonEmptyStringSchema,
    correction: NonEmptyStringSchema,
    source_kind: OptionalSourceKindSchema
  })
  .strict()
  .readonly();

export const SoulExplanationProvidedPayloadSchema = z
  .object({
    message_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    explanation: NonEmptyStringSchema,
    source_kind: OptionalSourceKindSchema
  })
  .strict()
  .readonly();

export const SoulApprovalRequestedPayloadSchema = z
  .object({
    message_id: NonEmptyStringSchema,
    approval_id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    risk_level: SoulInteractionRiskLevelSchema.optional(),
    source_kind: OptionalSourceKindSchema,
    run_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const SoulApprovalResolvedPayloadSchema = z
  .object({
    message_id: NonEmptyStringSchema,
    approval_id: NonEmptyStringSchema,
    result: ApprovalResolutionResultSchema,
    description: NonEmptyStringSchema,
    resolved_at: IsoDatetimeStringSchema,
    risk_level: SoulInteractionRiskLevelSchema.optional(),
    source_kind: OptionalSourceKindSchema,
    run_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

const fileApprovalPayloadSchemas = {
  [FileApprovalEventType.FILE_UPLOADED]: FileUploadedPayloadSchema,
  [FileApprovalEventType.SOUL_HINT_EMITTED]: SoulHintEmittedPayloadSchema,
  [FileApprovalEventType.SOUL_CORRECTION_ISSUED]: SoulCorrectionIssuedPayloadSchema,
  [FileApprovalEventType.SOUL_EXPLANATION_PROVIDED]: SoulExplanationProvidedPayloadSchema,
  [FileApprovalEventType.SOUL_APPROVAL_REQUESTED]: SoulApprovalRequestedPayloadSchema,
  [FileApprovalEventType.SOUL_APPROVAL_RESOLVED]: SoulApprovalResolvedPayloadSchema
} as const;

export function createFileApprovalEventObjectSchema<T extends keyof typeof fileApprovalPayloadSchemas>(
  type: T,
  payloadSchema: (typeof fileApprovalPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const FileUploadedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.FILE_UPLOADED,
  FileUploadedPayloadSchema
);
const SoulHintEmittedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.SOUL_HINT_EMITTED,
  SoulHintEmittedPayloadSchema
);
const SoulCorrectionIssuedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.SOUL_CORRECTION_ISSUED,
  SoulCorrectionIssuedPayloadSchema
);
const SoulExplanationProvidedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.SOUL_EXPLANATION_PROVIDED,
  SoulExplanationProvidedPayloadSchema
);
const SoulApprovalRequestedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
  SoulApprovalRequestedPayloadSchema
);
const SoulApprovalResolvedEventObjectSchema = createFileApprovalEventObjectSchema(
  FileApprovalEventType.SOUL_APPROVAL_RESOLVED,
  SoulApprovalResolvedPayloadSchema
);

export const FileUploadedEventSchema = FileUploadedEventObjectSchema.readonly();
export const SoulHintEmittedEventSchema = SoulHintEmittedEventObjectSchema.readonly();
export const SoulCorrectionIssuedEventSchema = SoulCorrectionIssuedEventObjectSchema.readonly();
export const SoulExplanationProvidedEventSchema = SoulExplanationProvidedEventObjectSchema.readonly();
export const SoulApprovalRequestedEventSchema = SoulApprovalRequestedEventObjectSchema.readonly();
export const SoulApprovalResolvedEventSchema = SoulApprovalResolvedEventObjectSchema.readonly();

export const FileApprovalEventUnionSchema = z
  .discriminatedUnion("type", [
    FileUploadedEventObjectSchema,
    SoulHintEmittedEventObjectSchema,
    SoulCorrectionIssuedEventObjectSchema,
    SoulExplanationProvidedEventObjectSchema,
    SoulApprovalRequestedEventObjectSchema,
    SoulApprovalResolvedEventObjectSchema
  ])
  .readonly();

export type FileApprovalEventPayloadMap = {
  [K in keyof typeof fileApprovalPayloadSchemas]: z.infer<(typeof fileApprovalPayloadSchemas)[K]>;
};

export function parseFileApprovalEventPayload<T extends keyof typeof fileApprovalPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): FileApprovalEventPayloadMap[T] {
  const schema = fileApprovalPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase 5 event type: ${String(type)}`);
  }

  return schema.parse(payload) as FileApprovalEventPayloadMap[T];
}

export type FileUploadedPayload = z.infer<typeof FileUploadedPayloadSchema>;
export type FileUploadedEventPayload = FileUploadedPayload;
export type SoulInteractionRiskLevel = z.infer<typeof SoulInteractionRiskLevelSchema>;
export type ApprovalResolutionResult = z.infer<typeof ApprovalResolutionResultSchema>;
export type SoulHintEmittedPayload = z.infer<typeof SoulHintEmittedPayloadSchema>;
export type SoulCorrectionIssuedPayload = z.infer<typeof SoulCorrectionIssuedPayloadSchema>;
export type SoulExplanationProvidedPayload = z.infer<typeof SoulExplanationProvidedPayloadSchema>;
export type SoulApprovalRequestedPayload = z.infer<typeof SoulApprovalRequestedPayloadSchema>;
export type SoulApprovalResolvedPayload = z.infer<typeof SoulApprovalResolvedPayloadSchema>;
export type FileApprovalEventTypeValue = z.infer<typeof FileApprovalEventTypeSchema>;
export type FileApprovalEvent = z.infer<typeof FileApprovalEventUnionSchema>;
