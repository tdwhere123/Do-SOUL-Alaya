import { z } from "zod";
import { NonEmptyStringSchema } from "./schema-primitives.js";

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

export const SlashCommandDescriptorSchema = z
  .object({
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    available: z.boolean(),
    dispatchable: z.boolean(),
    unavailable_reason: NonEmptyStringSchema.optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if ((!descriptor.available || !descriptor.dispatchable) && descriptor.unavailable_reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unavailable_reason is required when available is false or dispatchable is false",
        path: ["unavailable_reason"]
      });
    }
  })
  .readonly();

export const SlashCommandListResultSchema = z
  .object({
    commands: z.array(SlashCommandDescriptorSchema).readonly()
  })
  .strict()
  .readonly();

export const SlashCommandDispatchRequestSchema = z
  .object({
    run_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const SlashCommandDispatchStatusSchema = z.enum(["dispatched", "unavailable", "failed"]);

export const SlashCommandDispatchResultSchema = z
  .object({
    name: NonEmptyStringSchema,
    status: SlashCommandDispatchStatusSchema,
    message: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export type RunInterruptStatus = z.infer<typeof RunInterruptStatusSchema>;
export type RunInterruptResult = Readonly<z.infer<typeof RunInterruptResultSchema>>;
export type SlashCommandDescriptor = Readonly<z.infer<typeof SlashCommandDescriptorSchema>>;
export type SlashCommandListResult = Readonly<z.infer<typeof SlashCommandListResultSchema>>;
export type SlashCommandDispatchRequest = Readonly<z.infer<typeof SlashCommandDispatchRequestSchema>>;
export type SlashCommandDispatchStatus = z.infer<typeof SlashCommandDispatchStatusSchema>;
export type SlashCommandDispatchResult = Readonly<z.infer<typeof SlashCommandDispatchResultSchema>>;
