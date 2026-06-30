import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  BoundedPathSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";

const engineProviderValues = ["openai", "anthropic", "custom"] as const;
const EngineBaseUrlSchema = BoundedPathSchema.url();
const EngineConfigSchema = BoundedJsonObjectSchema;

export const EngineProvider = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  CUSTOM: "custom"
} as const;

export const EngineProviderSchema = z.enum(engineProviderValues);

const ApiKeyEngineBindingSchema = z.object({
  binding_id: BoundedIdSchema,
  provider: EngineProviderSchema,
  model: BoundedLabelSchema,
  base_url: EngineBaseUrlSchema.nullable().default(null),
  api_key: BoundedReasonSchema,
  api_key_ref: BoundedIdSchema.nullable().optional(),
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional()
}).strict();

const ApiKeyRefEngineBindingSchema = z.object({
  binding_id: BoundedIdSchema,
  provider: EngineProviderSchema,
  model: BoundedLabelSchema,
  base_url: EngineBaseUrlSchema.nullable().default(null),
  api_key: BoundedReasonSchema.optional(),
  api_key_ref: BoundedIdSchema,
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional()
}).strict();

export const EngineBindingSchema = z.union([
  ApiKeyEngineBindingSchema,
  ApiKeyRefEngineBindingSchema
]).readonly();

export const EngineBindingInputSchema = z
  .object({
    provider_type: EngineProviderSchema,
    base_url: EngineBaseUrlSchema.nullable(),
    api_key: BoundedReasonSchema,
    model: BoundedLabelSchema,
    config: EngineConfigSchema.default({}),
    enable_tools: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider_type === EngineProvider.CUSTOM && value.base_url === null) {
      context.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "Custom providers require a base_url."
      });
    }
  })
  .readonly();

export const EngineBindingRecordSchema = z.object({
  binding_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  provider_type: EngineProviderSchema,
  base_url: EngineBaseUrlSchema.nullable(),
  api_key: BoundedReasonSchema,
  model: BoundedLabelSchema,
  config: EngineConfigSchema,
  enable_tools: z.boolean().optional(),
  created_at: IsoDatetimeStringSchema,
  updated_at: IsoDatetimeStringSchema
}).strict().readonly();

export const EngineBindingSummarySchema = z.object({
  provider_type: EngineProviderSchema,
  base_url: EngineBaseUrlSchema.nullable(),
  model: BoundedLabelSchema
}).strict().readonly();

export const EngineConnectionTestResultSchema = z.object({
  success: z.boolean(),
  error: BoundedReasonSchema.nullable(),
  normalized_binding: EngineBindingSummarySchema.nullable(),
  available_models: z.array(BoundedLabelSchema).readonly()
}).strict().readonly();

export type EngineProvider = z.infer<typeof EngineProviderSchema>;
export type EngineBinding = z.infer<typeof EngineBindingSchema>;
export type EngineBindingInput = z.infer<typeof EngineBindingInputSchema>;
export type EngineBindingRecord = z.infer<typeof EngineBindingRecordSchema>;
export type EngineBindingSummary = z.infer<typeof EngineBindingSummarySchema>;
export type EngineConnectionTestResult = z.infer<typeof EngineConnectionTestResultSchema>;
