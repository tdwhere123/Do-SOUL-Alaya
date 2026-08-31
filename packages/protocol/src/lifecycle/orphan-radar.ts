import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const orphanRadarSuggestedActionValues = [
  "re_anchor_candidate",
  "archive_candidate",
  "no_action"
] as const;

export const OrphanRadarSuggestedAction = {
  RE_ANCHOR_CANDIDATE: "re_anchor_candidate",
  ARCHIVE_CANDIDATE: "archive_candidate",
  NO_ACTION: "no_action"
} as const;

export const OrphanRadarSuggestedActionSchema = z.enum(orphanRadarSuggestedActionValues);

export const OrphanRadarSchema = z
  .object({
    radar_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    suspected_surface_gaps: z.array(NonEmptyStringSchema).readonly(),
    suggested_action: OrphanRadarSuggestedActionSchema,
    confidence: z.number().min(0).max(1),
    detected_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema,
    requires_review: z.boolean()
  })
  .strict()
  .readonly()
  .refine((data) => data.expires_at > data.detected_at, {
    message: "expires_at must be after detected_at"
  });

export type OrphanRadarSuggestedActionValue = z.infer<typeof OrphanRadarSuggestedActionSchema>;
export type OrphanRadar = z.infer<typeof OrphanRadarSchema>;
