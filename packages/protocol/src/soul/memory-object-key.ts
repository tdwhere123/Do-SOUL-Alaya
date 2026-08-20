import { z } from "zod";
import { BoundedIdSchema, BoundedString } from "../shared/schema-primitives.js";

export const MEMORY_OBJECT_KEY_SCHEMA_VERSION = 1 as const;

export const MemoryObjectKeyTypeSchema = z.enum([
  "gist_remainder",
  "osf_surface",
  "osf_identity",
  "temporal_alias",
  "numeric_alias"
]);

export const MemoryObjectKeySourceKindSchema = z.enum([
  "evidence_gist",
  "osf_factor",
  "stored_text"
]);

export const MemoryObjectKeyLanguageSchema = z.enum(["en", "zh", "und"]);

export const MemoryObjectKeySchema = z.object({
  schema_version: z.literal(MEMORY_OBJECT_KEY_SCHEMA_VERSION),
  key_id: BoundedIdSchema,
  owner_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  key_type: MemoryObjectKeyTypeSchema,
  surface: BoundedString(512),
  normalized_surface: BoundedString(512),
  language: MemoryObjectKeyLanguageSchema.nullable(),
  source_kind: MemoryObjectKeySourceKindSchema,
  source_ref: BoundedString(1024)
}).strict().readonly().superRefine((key, context) => {
  if (key.normalized_surface !== normalizeMemoryObjectKeySurface(key.surface)) {
    context.addIssue({
      code: "custom",
      message: "normalized_surface must be the canonical form of surface"
    });
  }
});

export type MemoryObjectKeyType = z.infer<typeof MemoryObjectKeyTypeSchema>;
export type MemoryObjectKeySourceKind = z.infer<typeof MemoryObjectKeySourceKindSchema>;
export type MemoryObjectKeyLanguage = z.infer<typeof MemoryObjectKeyLanguageSchema>;
export type MemoryObjectKey = z.infer<typeof MemoryObjectKeySchema>;

export function normalizeMemoryObjectKeySurface(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
