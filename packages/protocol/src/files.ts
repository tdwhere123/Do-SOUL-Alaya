import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

const supportedMimeTypeValues = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
] as const;

export const SupportedMimeTypeSchema = z.enum(supportedMimeTypeValues);

export const FileRecordSchema = z
  .object({
    file_id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    mime_type: SupportedMimeTypeSchema,
    size_bytes: z.number().int().positive().max(20 * 1024 * 1024),
    storage_path: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema.nullable(),
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const FileUploadResponseSchema = z
  .object({
    file_id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    mime_type: SupportedMimeTypeSchema,
    size_bytes: z.number().int().positive().max(20 * 1024 * 1024)
  })
  .strict()
  .readonly();

export type SupportedMimeType = z.infer<typeof SupportedMimeTypeSchema>;
export type FileRecord = z.infer<typeof FileRecordSchema>;
export type FileUploadResponse = z.infer<typeof FileUploadResponseSchema>;
