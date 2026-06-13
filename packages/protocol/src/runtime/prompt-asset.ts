import { z } from "zod";
import { NonEmptyStringSchema } from "../shared/schema-primitives.js";

export const PromptAssetKindSchema = z.enum(["constitutional", "operational"]);

const PromptAssetBaseShape = {
  asset_id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  content: NonEmptyStringSchema,
  priority: z.number().int().min(0).max(100)
} as const;

const ConstitutionalPromptAssetSchema = z
  .object({
    ...PromptAssetBaseShape,
    kind: z.literal("constitutional"),
    immutable: z.literal(true)
  })
  .strict();

const OperationalPromptAssetSchema = z
  .object({
    ...PromptAssetBaseShape,
    kind: z.literal("operational"),
    immutable: z.boolean()
  })
  .strict();

export const PromptAssetSchema = z.discriminatedUnion("kind", [
  ConstitutionalPromptAssetSchema,
  OperationalPromptAssetSchema
]).readonly();

export type PromptAssetKind = z.infer<typeof PromptAssetKindSchema>;
export type PromptAsset = z.infer<typeof PromptAssetSchema>;
