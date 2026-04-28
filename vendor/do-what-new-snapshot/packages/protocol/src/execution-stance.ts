import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

export const StanceBiasSchema = z.enum([
  "analyze_first",
  "act_first",
  "verify_first",
  "conservative",
  "aggressive"
]);
export const VerificationAttentionSchema = z.enum(["low", "medium", "high"]);
export const WritePostureSchema = z.enum(["permissive", "guarded", "strict"]);
export const StanceRiskSignalSchema = z.enum([
  "likely_tool_misuse",
  "likely_budget_pressure",
  "likely_native_surface_drift",
  "likely_claim_conflict"
]);

export const StancePolicySchema = z
  .object({
    policy_id: NonEmptyStringSchema,
    task_surface_ref: NonEmptyStringSchema,
    derived_from: z.array(NonEmptyStringSchema).readonly(),
    default_bias: StanceBiasSchema,
    default_verification_attention: VerificationAttentionSchema,
    default_write_posture: WritePostureSchema
  })
  .strict()
  .readonly();

export const StanceResolutionSchema = z
  .object({
    resolution_id: NonEmptyStringSchema,
    policy_ref: NonEmptyStringSchema,
    risk_signals: z.array(StanceRiskSignalSchema).readonly(),
    resolved_bias: StanceBiasSchema,
    resolved_verification_attention: VerificationAttentionSchema,
    resolved_write_posture: WritePostureSchema,
    created_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type StanceBias = z.infer<typeof StanceBiasSchema>;
export type VerificationAttention = z.infer<typeof VerificationAttentionSchema>;
export type WritePosture = z.infer<typeof WritePostureSchema>;
export type StanceRiskSignal = z.infer<typeof StanceRiskSignalSchema>;
export type StancePolicy = Readonly<z.infer<typeof StancePolicySchema>>;
export type StanceResolution = Readonly<z.infer<typeof StanceResolutionSchema>>;
