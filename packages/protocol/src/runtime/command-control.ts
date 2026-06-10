import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";

export const RunInterruptStatusSchema = z.enum([
  "cancelled",
  "already_finished",
  "no_active",
  "unsupported",
  "failed"
]);

export const RunInterruptResultSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    status: RunInterruptStatusSchema,
    message: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export type RunInterruptStatus = z.infer<typeof RunInterruptStatusSchema>;
export type RunInterruptResult = Readonly<z.infer<typeof RunInterruptResultSchema>>;
