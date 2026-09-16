import { z } from "zod";

// Write-path neighbor reads and reconciliation share one availability
// vocabulary. A successful empty scan is `ok` with no items; a failed
// read is `unavailable` and must not be treated as "no neighbors".
const queryAvailabilityValues = ["ok", "unavailable"] as const;
const reconciliationDecisionKindValues = ["add", "update", "noop", "deferred"] as const;
const reconciliationDeferralValues = ["prewrite_unavailable", "lease_busy"] as const;

export const QueryAvailability = {
  OK: "ok",
  UNAVAILABLE: "unavailable"
} as const;

export const QueryAvailabilitySchema = z.enum(queryAvailabilityValues);
export type QueryAvailability = z.infer<typeof QueryAvailabilitySchema>;

export const ReconciliationDecisionKind = {
  ADD: "add",
  UPDATE: "update",
  NOOP: "noop",
  DEFERRED: "deferred"
} as const;

export const ReconciliationDecisionKindSchema = z.enum(reconciliationDecisionKindValues);
export type ReconciliationDecisionKind = z.infer<typeof ReconciliationDecisionKindSchema>;

export const ReconciliationDeferral = {
  PREWRITE_UNAVAILABLE: "prewrite_unavailable",
  LEASE_BUSY: "lease_busy"
} as const;

export const ReconciliationDeferralSchema = z.enum(reconciliationDeferralValues);
export type ReconciliationDeferral = z.infer<typeof ReconciliationDeferralSchema>;
