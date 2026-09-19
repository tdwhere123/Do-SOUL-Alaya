import { z } from "zod";

const CaptureExecutionReasonCanonicalSchema = z.enum([
  "cycle_contract_failure",
  "invalid_state",
  "membership_shrink",
  "prefix_violation"
]);

function historicalCaptureReason(value: unknown): unknown {
  return value === "psi_cycle_contract_failure" ? "cycle_contract_failure" : value;
}

export const CaptureExecutionReasonSchema = z.preprocess(
  historicalCaptureReason,
  CaptureExecutionReasonCanonicalSchema
);

export const CaptureExecutionSchema = z.object({
  status: z.enum(["captured", "fail_closed"]),
  // Preprocess onto nullable so MCP JSON Schema keeps reason required.
  reason: z.preprocess(historicalCaptureReason, CaptureExecutionReasonCanonicalSchema.nullable())
}).strict().superRefine((value, context) => {
  if ((value.status === "captured") !== (value.reason === null)) {
    context.addIssue({ code: "custom", message: "capture execution reason contradicts status" });
  }
}).readonly();

export type CaptureExecutionReason = z.infer<typeof CaptureExecutionReasonSchema>;
export type CaptureExecution = z.infer<typeof CaptureExecutionSchema>;
