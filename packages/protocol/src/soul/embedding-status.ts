import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

export const EmbeddingEffectiveModeSchema = z.enum([
  "keyword_only",
  "embedding_supplement",
  "degraded"
]);

export const EmbeddingStatusSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    embedding_enabled: z.boolean(),
    provider_configured: z.boolean(),
    model_id: NonEmptyStringSchema.nullable(),
    storage_available: z.boolean(),
    effective_mode: EmbeddingEffectiveModeSchema,
    degraded_reason: NonEmptyStringSchema.nullable(),
    checked_at: IsoDatetimeStringSchema
  })
  .strict()
  .superRefine((status, context) => {
    if (status.effective_mode === "degraded" && status.degraded_reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degraded_reason"],
        message: "degraded_reason is required when effective_mode is degraded"
      });
    }

    if (status.effective_mode !== "degraded" && status.degraded_reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degraded_reason"],
        message: "degraded_reason is only allowed when effective_mode is degraded"
      });
    }

    if (!status.embedding_enabled && status.effective_mode !== "keyword_only") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effective_mode"],
        message: "disabled embeddings must use keyword_only effective_mode"
      });
    }

    if (!status.embedding_enabled && status.degraded_reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degraded_reason"],
        message: "disabled embeddings must not carry degraded_reason"
      });
    }

    if (status.effective_mode === "embedding_supplement") {
      if (!status.embedding_enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["embedding_enabled"],
          message: "embedding_supplement effective_mode requires embedding_enabled"
        });
      }

      if (!status.provider_configured) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provider_configured"],
          message: "embedding_supplement effective_mode requires provider_configured"
        });
      }

      if (!status.storage_available) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["storage_available"],
          message: "embedding_supplement effective_mode requires storage_available"
        });
      }
    }

    if (status.effective_mode === "degraded" && !status.embedding_enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedding_enabled"],
        message: "degraded effective_mode requires embedding_enabled"
      });
    }
  })
  .readonly();

export type EmbeddingEffectiveMode = z.infer<typeof EmbeddingEffectiveModeSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;
