import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../../../shared/schema-primitives.js";
import { DriftSeveritySchema, DriftTypeSchema, SurfaceDriftOperationTypeSchema } from "../../../soul/surface-drift.js";

export const SurfaceDriftDetectedPayloadSchema = z
  .object({
    drift_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    drift_type: DriftTypeSchema,
    severity: DriftSeveritySchema,
    affected_subject: NonEmptyStringSchema,
    detected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseAcquiredPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    expires_at: IsoDatetimeStringSchema,
    granted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseReleasedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    released_by: NonEmptyStringSchema,
    released_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseReleaseFailedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    released_by: NonEmptyStringSchema,
    failed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftAlertPayloadSchema = z
  .object({
    alert_id: NonEmptyStringSchema,
    drift_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    severity: z.literal("governance_critical"),
    message: NonEmptyStringSchema,
    alerted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();
