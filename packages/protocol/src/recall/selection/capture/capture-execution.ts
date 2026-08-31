import { z } from "zod";

export const CaptureExecutionReasonSchema = z.enum([
  "psi_cycle_contract_failure",
  "invalid_state",
  "membership_shrink",
  "prefix_violation"
]);

export const CaptureExecutionSchema = z.object({
  status: z.enum(["captured", "fail_closed"]),
  reason: CaptureExecutionReasonSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.status === "captured") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "capture execution reason contradicts status" });
  }
}).readonly();

export type CaptureExecutionReason = z.infer<typeof CaptureExecutionReasonSchema>;
export type CaptureExecution = z.infer<typeof CaptureExecutionSchema>;
