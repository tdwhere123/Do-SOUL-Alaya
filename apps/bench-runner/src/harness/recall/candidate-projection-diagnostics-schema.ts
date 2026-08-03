import { z } from "zod";

export const RecallAdmissionAttemptDiagnosticSchema = z.object({
  pass: z.literal("final_selector"),
  selection_order: z.number().int().positive(),
  admitted: z.boolean(),
  dropped_reason: z.string().min(1).nullable()
}).strict().readonly();

const RecallFactKeyProjectionFormSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }).strict().readonly(),
  z.object({
    kind: z.literal("leave_one_slot_out"),
    omitted_slot: z.object({
      slot_index: z.number().int().nonnegative(),
      role: z.enum(["subject", "relation", "value", "qualifier", "time"])
    }).strict().readonly()
  }).strict().readonly()
]);

export const RecallEvidenceProjectionMatchReceiptSchema = z.object({
  evidence_ref: z.string().min(1),
  projection_kind: z.enum(["owner", "assistant_observation", "fact_key"]),
  projection_id: z.number().int().positive().nullable(),
  normalized_rank: z.number().min(0).max(1),
  fact_key_forms: z.array(RecallFactKeyProjectionFormSchema).readonly()
}).strict().readonly();
