import { z } from "zod";

export const D0ExecutionReasonSchema = z.enum([
  "psi_cycle_contract_failure",
  "invalid_state",
  "membership_shrink",
  "prefix_violation"
]);

export const D0ExecutionSchema = z.object({
  status: z.enum(["captured", "fail_closed"]),
  reason: D0ExecutionReasonSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.status === "captured") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "D0 execution reason contradicts status" });
  }
}).readonly();

export type D0ExecutionReason = z.infer<typeof D0ExecutionReasonSchema>;
export type D0Execution = z.infer<typeof D0ExecutionSchema>;
