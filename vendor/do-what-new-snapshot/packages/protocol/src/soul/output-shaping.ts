import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const commandClassValues = [
  "file_read",
  "file_write",
  "search",
  "navigation",
  "verification",
  "governance_query",
  "other"
] as const;

const compressionModeValues = ["count_summary", "last_only", "first_last"] as const;

export const CommandClass = {
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  SEARCH: "search",
  NAVIGATION: "navigation",
  VERIFICATION: "verification",
  GOVERNANCE_QUERY: "governance_query",
  OTHER: "other"
} as const;

export const CompressionMode = {
  COUNT_SUMMARY: "count_summary",
  LAST_ONLY: "last_only",
  FIRST_LAST: "first_last"
} as const;

export const CommandClassSchema = z.enum(commandClassValues);
export const CompressionModeSchema = z.enum(compressionModeValues);

export const OutputShapingRuleSchema = z
  .object({
    command_class: CommandClassSchema,
    min_consecutive: NonNegativeIntSchema,
    compression_mode: CompressionModeSchema
  })
  .strict()
  .readonly();

export const OutputShapingResultSchema = z
  .object({
    shaping_id: NonEmptyStringSchema,
    command_class: CommandClassSchema,
    original_count: NonNegativeIntSchema,
    compressed_to: NonNegativeIntSchema,
    compression_mode: CompressionModeSchema,
    original_event_ids: z.array(NonEmptyStringSchema).min(1).readonly(),
    shaped_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type CommandClass = z.infer<typeof CommandClassSchema>;
export type CompressionMode = z.infer<typeof CompressionModeSchema>;
export type OutputShapingRule = z.infer<typeof OutputShapingRuleSchema>;
export type OutputShapingResult = z.infer<typeof OutputShapingResultSchema>;
