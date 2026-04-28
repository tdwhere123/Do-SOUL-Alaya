import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

export const ExecutionVerificationAttentionOrder = Object.freeze([
  "low",
  "standard",
  "elevated",
  "high"
] as const);
export const ExecutionConservatismOrder = Object.freeze([
  "permissive",
  "balanced",
  "conservative",
  "strict"
] as const);

export const ExecutionVerificationAttentionSchema = z.enum(ExecutionVerificationAttentionOrder);
export const ExecutionConservatismSchema = z.enum(ExecutionConservatismOrder);

export const ExecutionStanceModelRefSchema = z
  .object({
    provider: NonEmptyStringSchema,
    model_id: NonEmptyStringSchema,
    adapter: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly();

export const ExecutionStancePolicySchema = z
  .object({
    policy_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    default_verification_attention: ExecutionVerificationAttentionSchema,
    default_conservatism: ExecutionConservatismSchema,
    minimum_verification_attention: ExecutionVerificationAttentionSchema,
    minimum_conservatism: ExecutionConservatismSchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExecutionStanceResolutionSchema = z
  .object({
    resolution_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    verification_attention: ExecutionVerificationAttentionSchema,
    conservatism: ExecutionConservatismSchema,
    contributing_candidate_ids: z.array(NonEmptyStringSchema).readonly(),
    model_ref: ExecutionStanceModelRefSchema.nullable(),
    resolved_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type ExecutionVerificationAttention = z.infer<typeof ExecutionVerificationAttentionSchema>;
export type ExecutionConservatism = z.infer<typeof ExecutionConservatismSchema>;
export type ExecutionStanceModelRef = z.infer<typeof ExecutionStanceModelRefSchema>;
export type ExecutionStancePolicy = z.infer<typeof ExecutionStancePolicySchema>;
export type ExecutionStanceResolution = z.infer<typeof ExecutionStanceResolutionSchema>;
