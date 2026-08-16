import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../../shared/schema-primitives.js";
import {
  FieldContractDigestSchema,
  FieldReceiptContractFieldsSchema
} from "./canonical-identity.js";
import { RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID } from "./operator-manifest.js";

export const FieldStopCertificateStatusSchema = z.enum(["certified", "uncertified"]);
export const FieldStopFrontierSchema = z.enum(["closed", "incomplete"]);
export const FieldStopReasonSchema = z.enum([
  "all_channels_closed",
  "source_unavailable",
  "relevance_bound_unavailable",
  "objective_bound_unavailable",
  "exchange_dominated",
  "exchange_not_dominated",
  "activation_budget_exhausted"
]);

export const FieldStopExchangeBoundSchema = z.object({
  removed_candidate_key: NonEmptyStringSchema.max(256).nullable(),
  incumbent_loss: z.number().finite(),
  unseen_gain_upper_bound: z.number().finite(),
  improvement_upper_bound: z.number().finite()
}).strict().readonly();

export const FieldStopCertificateReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  operator_id: z.literal(RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID),
  status: FieldStopCertificateStatusSchema,
  frontier: FieldStopFrontierSchema,
  reason: FieldStopReasonSchema,
  selected_candidate_keys: z.array(NonEmptyStringSchema.max(256)).readonly(),
  exchange_bounds: z.array(FieldStopExchangeBoundSchema).readonly(),
  improvement_upper_bound: z.number().finite().nullable(),
  generation_id: FieldContractDigestSchema,
  condition_digest: FieldContractDigestSchema,
  candidate_membership_changed: z.literal(false),
  recorded_at: IsoDatetimeStringSchema
}).strict().superRefine((receipt, context) => {
  const certified = receipt.reason === "all_channels_closed" ||
    receipt.reason === "exchange_dominated";
  if ((certified ? "certified" : "uncertified") !== receipt.status) {
    context.addIssue({
      code: "custom",
      message: "stop certificate status is inconsistent"
    });
  }
  if (certified && receipt.frontier !== "closed") {
    context.addIssue({
      code: "custom",
      message: "certified stop requires a closed frontier"
    });
  }
  if (!certified && receipt.frontier !== "incomplete") {
    context.addIssue({
      code: "custom",
      message: "uncertified stop must be an explicit incomplete frontier"
    });
  }
}).readonly();

export type FieldStopCertificateStatus = z.infer<typeof FieldStopCertificateStatusSchema>;
export type FieldStopFrontier = z.infer<typeof FieldStopFrontierSchema>;
export type FieldStopReason = z.infer<typeof FieldStopReasonSchema>;
export type FieldStopExchangeBound = z.infer<typeof FieldStopExchangeBoundSchema>;
export type FieldStopCertificateReceipt = z.infer<typeof FieldStopCertificateReceiptSchema>;
