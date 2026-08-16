import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteNumberSchema
} from "../../shared/schema-primitives.js";
import { FieldReceiptContractFieldsSchema } from "./canonical-identity.js";

export const CausalUsageKindSchema = z.enum(["causal", "delivery", "inspection"]);

export const CausalUsageReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  causal_key: NonEmptyStringSchema.max(256),
  occurred_at: IsoDatetimeStringSchema,
  downstream_ref: NonEmptyStringSchema.max(256),
  weight: NonNegativeFiniteNumberSchema,
  scope: NonEmptyStringSchema.max(256),
  usage_kind: CausalUsageKindSchema,
  recorded_at: IsoDatetimeStringSchema
}).strict().superRefine((receipt, context) => {
  if (receipt.usage_kind !== "causal" && receipt.weight !== 0) {
    context.addIssue({
      code: "custom",
      message: "delivery and inspection usage must have weight 0"
    });
  }
}).readonly();

export type CausalUsageKind = z.infer<typeof CausalUsageKindSchema>;
export type CausalUsageReceipt = z.infer<typeof CausalUsageReceiptSchema>;
