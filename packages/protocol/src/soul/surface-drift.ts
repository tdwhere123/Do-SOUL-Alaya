import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const driftSeverityValues = ["ordinary", "governance_critical"] as const;
const driftTypeValues = [
  "subject_rename",
  "governance_subject_rename",
  "scope_change",
  "policy_override",
  "display_preference",
  "ui_layout",
  "theme_change"
] as const;
const governanceCriticalDriftTypeValues = [
  "subject_rename",
  "governance_subject_rename",
  "scope_change",
  "policy_override"
] as const;
const surfaceDriftOperationTypeValues = [
  "surface.bind_object",
  "surface.rename_object",
  "surface.transition_binding_state",
  "surface.transition_status"
] as const;

export const DriftSeveritySchema = z.enum(driftSeverityValues);
export const DriftTypeSchema = z.enum(driftTypeValues);
export const SurfaceDriftOperationTypeSchema = z.enum(surfaceDriftOperationTypeValues);

export const DriftClassificationSchema = z
  .object({
    drift_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    drift_type: DriftTypeSchema,
    severity: DriftSeveritySchema,
    affected_subject: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    detected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const GovernanceDriftLeaseSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    drift_id: NonEmptyStringSchema.nullable(),
    expires_at: IsoDatetimeStringSchema,
    granted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const DriftAlertSchema = z
  .object({
    alert_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    drift_id: NonEmptyStringSchema,
    severity: z.literal("governance_critical"),
    message: NonEmptyStringSchema,
    alerted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type DriftSeverity = z.infer<typeof DriftSeveritySchema>;
export type DriftType = z.infer<typeof DriftTypeSchema>;
export type SurfaceDriftOperationType = z.infer<typeof SurfaceDriftOperationTypeSchema>;
export type DriftClassification = z.infer<typeof DriftClassificationSchema>;
export type GovernanceDriftLease = z.infer<typeof GovernanceDriftLeaseSchema>;
export type DriftAlert = z.infer<typeof DriftAlertSchema>;

const governanceCriticalDriftTypes = new Set<DriftType>(governanceCriticalDriftTypeValues);

export function classifyDriftSeverity(driftType: DriftType): DriftSeverity {
  return governanceCriticalDriftTypes.has(driftType) ? "governance_critical" : "ordinary";
}
