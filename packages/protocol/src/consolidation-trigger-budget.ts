import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "./schema-primitives.js";

export const ConsolidationTriggerSourceSchema = z.enum([
  "verification_failure",
  "repeated_override",
  "arbitration_burst",
  "bankruptcy_burst",
  "native_surface_drift"
]);

const ConsolidationTriggerBudgetBaseSchema = z
  .object({
    trigger_id: NonEmptyStringSchema,
    trigger_source: ConsolidationTriggerSourceSchema,
    governance_subject: NonEmptyStringSchema.optional(),
    source_object_ref: NonEmptyStringSchema.optional(),
    max_attempts_within_window: PositiveIntSchema,
    attempts_used: NonNegativeIntSchema,
    cooldown_until: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ConsolidationTriggerBudgetSchema = ConsolidationTriggerBudgetBaseSchema.refine(
  (value) => value.attempts_used <= value.max_attempts_within_window,
  {
    message: "attempts_used must be <= max_attempts_within_window",
    path: ["attempts_used"]
  }
);

export type ConsolidationTriggerSource = z.infer<typeof ConsolidationTriggerSourceSchema>;
export type ConsolidationTriggerBudget = Readonly<z.infer<typeof ConsolidationTriggerBudgetSchema>>;
