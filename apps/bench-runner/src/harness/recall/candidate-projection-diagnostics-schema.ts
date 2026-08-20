import { z } from "zod";
import { isCanonicalFtsLaneIds } from "@do-soul/alaya-protocol";
import {
  factSlotsHaveRequiredRoles,
  RecallFactKeyProjectionFormSchema,
  RecallFactSlotSchema
} from "./answer-trace/fact-key-provenance-schema.js";

export const RecallAdmissionAttemptDiagnosticSchema = z.object({
  pass: z.literal("final_selector"),
  selection_order: z.number().int().positive(),
  admitted: z.boolean(),
  dropped_reason: z.string().min(1).nullable()
}).strict().readonly();

export const RecallEvidenceProjectionMatchReceiptSchema = z.object({
  evidence_ref: z.string().min(1),
  projection_kind: z.enum(["owner", "assistant_observation", "fact_key"]),
  projection_id: z.number().int().positive().nullable(),
  normalized_rank: z.number().min(0).max(1),
  matched_fts_lanes: z.array(z.enum(["exact", "porter", "trigram"]))
    .min(1).max(3).readonly().optional(),
  fact_key_forms: z.array(RecallFactKeyProjectionFormSchema).readonly(),
  fact_slots: z.array(RecallFactSlotSchema).min(3).max(6).readonly().optional()
}).strict().superRefine((receipt, context) => {
  if (receipt.projection_kind !== "fact_key" && receipt.fact_slots !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["fact_slots"],
      message: "only fact-key projections may carry fact slots"
    });
  }
  if (receipt.matched_fts_lanes !== undefined &&
      !isCanonicalFtsLaneIds(receipt.matched_fts_lanes)) {
    context.addIssue({
      code: "custom",
      path: ["matched_fts_lanes"],
      message: "FTS lanes must be unique and canonically ordered"
    });
  }
  if (receipt.fact_slots !== undefined && !factSlotsHaveRequiredRoles(receipt.fact_slots)) {
    context.addIssue({
      code: "custom",
      path: ["fact_slots"],
      message: "fact slots must contain subject, relation, and value"
    });
  }
}).readonly();
