import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const engineProviderValues = ["openai", "anthropic", "custom"] as const;
const EngineBaseUrlSchema = z.string().url();
const EngineConfigSchema = z.record(z.string(), z.unknown());

export const EngineProvider = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  CUSTOM: "custom"
} as const;

export const EngineProviderSchema = z.enum(engineProviderValues);

const ApiKeyEngineBindingSchema = z.object({
  binding_id: NonEmptyStringSchema,
  provider: EngineProviderSchema,
  model: NonEmptyStringSchema,
  base_url: EngineBaseUrlSchema.nullable().default(null),
  api_key: NonEmptyStringSchema,
  api_key_ref: NonEmptyStringSchema.nullable().optional(),
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional()
});

const ApiKeyRefEngineBindingSchema = z.object({
  binding_id: NonEmptyStringSchema,
  provider: EngineProviderSchema,
  model: NonEmptyStringSchema,
  base_url: EngineBaseUrlSchema.nullable().default(null),
  api_key: z.string().optional(),
  api_key_ref: NonEmptyStringSchema,
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional()
});

export const EngineBindingSchema = z.union([
  ApiKeyEngineBindingSchema,
  ApiKeyRefEngineBindingSchema
]).readonly();

export const EngineBindingInputSchema = z
  .object({
    provider_type: EngineProviderSchema,
    base_url: EngineBaseUrlSchema.nullable(),
    api_key: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    config: EngineConfigSchema.default({}),
    enable_tools: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (value.provider_type === EngineProvider.CUSTOM && value.base_url === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url"],
        message: "Custom providers require a base_url."
      });
    }
  })
  .readonly();

export const EngineBindingRecordSchema = z.object({
  binding_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  provider_type: EngineProviderSchema,
  base_url: EngineBaseUrlSchema.nullable(),
  api_key: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional(),
  created_at: IsoDatetimeStringSchema,
  updated_at: IsoDatetimeStringSchema
}).readonly();

export const EngineBindingSummarySchema = z.object({
  provider_type: EngineProviderSchema,
  base_url: EngineBaseUrlSchema.nullable(),
  model: NonEmptyStringSchema
}).readonly();

export const EngineConnectionTestResultSchema = z.object({
  success: z.boolean(),
  error: z.string().nullable(),
  normalized_binding: EngineBindingSummarySchema.nullable(),
  available_models: z.array(NonEmptyStringSchema).readonly()
}).readonly();

export type EngineProvider = z.infer<typeof EngineProviderSchema>;
export type EngineBinding = z.infer<typeof EngineBindingSchema>;
export type EngineBindingInput = z.infer<typeof EngineBindingInputSchema>;
export type EngineBindingRecord = z.infer<typeof EngineBindingRecordSchema>;
export type EngineBindingSummary = z.infer<typeof EngineBindingSummarySchema>;
export type EngineConnectionTestResult = z.infer<typeof EngineConnectionTestResultSchema>;
